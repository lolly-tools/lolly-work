// SPDX-License-Identifier: MPL-2.0
/**
 * Partner domain routes and the sign-in step (plans/82 M1 part 2b), all under
 * `programme.manage`.
 *
 * An admin adds a domain to a programme, optionally with a company and an end
 * date. Proof is a DNS TXT record by default, or the admin's say-so, which is
 * audited as `programme.domain.assert` with who, when and the reason. Once a
 * domain is proved:
 *   - a sign-in with a verified address there is admitted (iam/admission.ts)
 *     and joins the programme and company (`joinThroughDomain`);
 *   - accounts at that domain that already sign in here join at once, when
 *     their address was verified (`joinExistingAccounts`).
 * A person joins through a domain once: a membership record (via "domain")
 * marks it, so removing someone from the programme in People sticks, and an
 * ended membership never comes back on its own. Admins, owners, disabled
 * accounts and accounts a SCIM connector manages are never joined: SCIM is
 * the authority for the people it manages.
 *
 * Removing a domain stops new people joining through it. People who already
 * joined stay until their access is ended or their end date passes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { programmeGroup } from './types.ts';
import { companyGroup, type MembershipRecord } from './people.ts';
import {
  afterLookup, domainActive, domainOfEmail, domainStatus, dueForLookup, liveRules, lookupTxt, normaliseDomain, refuseDomain,
  txtName, txtValue, type DomainRule, type PartnerDomainRecord, type TxtLookup, type TxtResult,
} from './domains.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface DomainRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  /** This workspace's own domains, each with the reason it counts as one. */
  ownDomains(): Promise<Map<string, string>>;
  resolveTxt: TxtLookup;
}

const iso = (t = Date.now()): string => new Date(t).toISOString();
const nameOf = (u: UserRecord | null | undefined): string | undefined =>
  u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email : undefined;

/** Why an account cannot join through a domain, or null when it can. */
async function cannotJoin(store: Store, u: UserRecord, programmeId: string, memberships: MembershipRecord[], needVerified: boolean): Promise<string | null> {
  if (u.disabledAt) return 'disabled';
  if (u.role === 'admin' || u.role === 'owner') return 'an admin or owner';
  if (u.scimIdp) return 'managed by your SCIM connector';
  if (memberships.some((m) => m.programmeId === programmeId && m.email === u.email.toLowerCase())) return 'already in this programme, or was before';
  if (needVerified) {
    const rows = await store.listIdentities(u.id);
    if (!rows.some((r) => r.emailVerified && r.email?.toLowerCase() === u.email.toLowerCase())) return 'address not verified yet; joins at the next sign-in with a provider that verifies it';
  }
  return null;
}

/** Add one account to one rule's programme and company, and record how. */
async function join(store: Store, audit: Audit, u: UserRecord, rec: PartnerDomainRecord, rule: DomainRule, actor: string, at: string): Promise<UserRecord> {
  const groups = [programmeGroup(rule.programmeId), ...(rule.companyId ? [companyGroup(rule.companyId)] : [])];
  const next = (await store.setLocalGroups(u.id, [...new Set([...u.localGroups, ...groups])])) ?? u;
  const record: MembershipRecord = {
    programmeId: rule.programmeId, email: u.email.toLowerCase(), userId: u.id,
    ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.endsAt ? { endsAt: rule.endsAt } : {}),
    addedBy: rule.addedBy, addedAt: at, via: 'domain', domain: rec.domain,
  };
  await store.putMembership(record);
  await audit(actor, 'programme.member.add', `programme:${rule.programmeId}`, {
    user: u.id, ...(rule.companyId ? { company: rule.companyId } : {}), ...(rule.endsAt ? { endsAt: rule.endsAt } : {}),
    via: 'domain', domain: rec.domain, proof: rec.proof,
  });
  return next;
}

/**
 * At sign-in, after the account row exists: join every live rule of the
 * sign-in's domain the account is not in yet. `email` is the sign-in's own
 * address and `verified` whether the provider vouched for it; nothing
 * happens otherwise. An account admitted only through a partner domain or a
 * partner membership always carries the partner marker, so a second account
 * for the same address can never see what is internal.
 */
export async function joinThroughDomain(
  store: Store, audit: Audit, user: UserRecord, signIn: { email: string; verified: boolean; via: string }, now = Date.now(),
): Promise<UserRecord> {
  if (!signIn.verified) return user;
  let current = user;
  const domain = domainOfEmail(signIn.email);
  const rec = domain ? (await store.listPartnerDomains()).find((d) => d.domain === domain) : undefined;
  if (rec && domainActive(rec) && signIn.email.trim().toLowerCase() === user.email.trim().toLowerCase()) {
    const memberships = await store.listMemberships();
    for (const rule of liveRules(rec, now)) {
      if (await cannotJoin(store, current, rule.programmeId, memberships, false)) continue;
      if (!(await store.getProgramme(rule.programmeId))) continue;
      current = await join(store, audit, current, rec, rule, `user:${user.id}`, iso(now));
    }
  }
  if ((signIn.via === 'partner-domain' || signIn.via === 'partner-member') && current.role !== 'admin' && current.role !== 'owner'
    && !current.localGroups.includes('partner')) {
    current = (await store.setLocalGroups(current.id, [...current.localGroups, 'partner'])) ?? current;
  }
  return current;
}

/**
 * Join the accounts at a proved domain that already sign in here, for the
 * live rules named (every live rule when `programmeIds` is absent). Only an
 * account whose address a provider verified joins now; the rest join at
 * their next such sign-in.
 */
export async function joinExistingAccounts(
  store: Store, audit: Audit, rec: PartnerDomainRecord, actor: string, now = Date.now(), programmeIds?: string[],
): Promise<{ joined: Array<{ id: string; email: string; programme: string }>; waiting: number }> {
  const joined: Array<{ id: string; email: string; programme: string }> = [];
  let waiting = 0;
  if (!domainActive(rec)) return { joined, waiting };
  const rules = liveRules(rec, now).filter((r) => !programmeIds || programmeIds.includes(r.programmeId));
  const accounts = (await store.listUsers()).filter((u) => !u.id.startsWith('svc_') && domainOfEmail(u.email) === rec.domain);
  for (const rule of rules) {
    if (!(await store.getProgramme(rule.programmeId))) continue;
    const memberships = await store.listMemberships();
    for (const listed of accounts) {
      const u = (await store.getUser(listed.id)) ?? listed;
      const why = await cannotJoin(store, u, rule.programmeId, memberships, true);
      if (why?.startsWith('address not verified')) waiting++;
      if (why) continue;
      await join(store, audit, u, rec, rule, actor, iso(now));
      joined.push({ id: u.id, email: u.email, programme: rule.programmeId });
    }
  }
  return { joined, waiting };
}

/**
 * Look up every DNS-proved domain that is due (hourly while pending, daily
 * once found), record the answer, and audit each change of state: found,
 * gone (paused) or back. A domain found for the first time, or back, joins
 * the accounts already at it. Returns how many were looked up.
 */
export async function recheckDomains(store: Store, audit: Audit, resolveTxt: TxtLookup, now = Date.now()): Promise<number> {
  const due = (await store.listPartnerDomains()).filter((d) => dueForLookup(d, now));
  for (const rec of due) await applyLookup(store, audit, rec, await lookupTxt(rec.domain, rec.token, resolveTxt), 'system', now);
  return due.length;
}

async function applyLookup(store: Store, audit: Audit, rec: PartnerDomainRecord, result: TxtResult, actor: string, now: number): Promise<{ rec: PartnerDomainRecord; joined: Array<{ id: string; email: string; programme: string }>; waiting: number }> {
  const before = domainStatus(rec);
  const next = afterLookup(rec, result, iso(now));
  await store.putPartnerDomain(next);
  const after = domainStatus(next);
  if (before !== after) {
    await audit(actor, after === 'paused' ? 'programme.domain.pause' : 'programme.domain.verify', `domain:${rec.domain}`, {
      domain: rec.domain, from: before, to: after,
    });
  }
  const { joined, waiting } = before !== 'verified' && after === 'verified'
    ? await joinExistingAccounts(store, audit, next, actor, now)
    : { joined: [], waiting: 0 };
  return { rec: next, joined, waiting };
}

/** Take rules past their end date off their domains; a domain with no rule
 *  left is removed. Memberships made through a rule carry its end date, so
 *  the membership sweep ends those at the same moment. */
export async function sweepDomainRules(store: Store, audit: Audit, now = Date.now()): Promise<number> {
  let ended = 0;
  for (const rec of await store.listPartnerDomains()) {
    const live = liveRules(rec, now);
    if (live.length === rec.rules.length) continue;
    for (const r of rec.rules.filter((x) => !live.includes(x))) {
      await audit('system', 'programme.domain.rule.end', `domain:${rec.domain}`, { domain: rec.domain, programme: r.programmeId, endsAt: r.endsAt });
      ended++;
    }
    if (live.length) await store.putPartnerDomain({ ...rec, rules: live, updatedAt: iso(now) });
    else await store.deletePartnerDomain(rec.domain);
  }
  return ended;
}

/** Remove the rules a partnership exit ends, and audit each. */
export async function withdrawDomainRules(
  store: Store, audit: Audit, actor: string, pick: { domain?: string; programmeId?: string; companyId?: string }, at: string,
): Promise<Array<{ domain: string; programme: string; company?: string }>> {
  const removed: Array<{ domain: string; programme: string; company?: string }> = [];
  for (const rec of await store.listPartnerDomains()) {
    const gone = rec.rules.filter((r) => rec.domain === pick.domain || r.programmeId === pick.programmeId || (!!pick.companyId && r.companyId === pick.companyId));
    if (!gone.length) continue;
    for (const r of gone) removed.push({ domain: rec.domain, programme: r.programmeId, ...(r.companyId ? { company: r.companyId } : {}) });
    const left = rec.rules.filter((r) => !gone.includes(r));
    if (left.length) await store.putPartnerDomain({ ...rec, rules: left, updatedAt: at });
    else await store.deletePartnerDomain(rec.domain);
    await audit(actor, 'programme.domain.remove', `domain:${rec.domain}`, { domain: rec.domain, programmes: gone.map((r) => r.programmeId), via: 'programme-exit' });
  }
  return removed;
}

/** What the console and the CLI read for one domain. */
export async function domainView(store: Store, rec: PartnerDomainRecord) {
  const [programmes, companies, memberships] = await Promise.all([store.listProgrammes(), store.listCompanies(), store.listMemberships()]);
  const asserter = rec.assertedBy ? await store.getUser(rec.assertedBy) : null;
  const named = async (id: string) => ({ id, name: nameOf(await store.getUser(id)) ?? id });
  return {
    domain: rec.domain,
    proof: rec.proof,
    status: domainStatus(rec),
    txt: { name: txtName(rec.domain), value: txtValue(rec.token) },
    ...(rec.verifiedAt ? { verifiedAt: rec.verifiedAt } : {}),
    ...(rec.checkedAt ? { checkedAt: rec.checkedAt } : {}),
    ...(rec.missingSince ? { missingSince: rec.missingSince } : {}),
    ...(rec.lastError ? { lastError: rec.lastError } : {}),
    ...(rec.proof === 'admin' && rec.assertedBy ? { asserted: { by: { id: rec.assertedBy, name: nameOf(asserter) ?? rec.assertedBy }, at: rec.assertedAt, ...(rec.reason ? { reason: rec.reason } : {}) } } : {}),
    rules: await Promise.all(rec.rules.map(async (r) => ({
      programme: { id: r.programmeId, name: programmes.find((p) => p.id === r.programmeId)?.name ?? r.programmeId },
      ...(r.companyId ? { company: { id: r.companyId, name: companies.find((c) => c.id === r.companyId)?.name ?? r.companyId } } : {}),
      ...(r.endsAt ? { endsAt: r.endsAt } : {}),
      addedAt: r.addedAt, addedBy: await named(r.addedBy),
    }))),
    members: memberships.filter((m) => m.via === 'domain' && m.domain === rec.domain && !m.endedAt).length,
  };
}

/** A date an admin typed: a whole day in UTC, or an instant. Null when absent. */
function readEnd(v: unknown, now: number): string | null | { error: string } {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return { error: 'endsAt must be a date (YYYY-MM-DD)' };
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
  if (!Number.isFinite(t)) return { error: 'endsAt must be a date (YYYY-MM-DD)' };
  if (t <= now) return { error: 'the end date has passed' };
  return iso(t);
}

export function registerDomainRoutes(router: Router, deps: DomainRouteDeps): void {
  const { store, audit } = deps;
  const manager = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'programme.manage');
  const find = async (domain: string) => (await store.listPartnerDomains()).find((d) => d.domain === domain) ?? null;

  router.add('GET', '/api/v1/partner-domains', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const programme = ctx.url.searchParams.get('programme');
    const all = await store.listPartnerDomains();
    const shown = programme ? all.filter((d) => d.rules.some((r) => r.programmeId === programme)) : all;
    sendJson(res, 200, { domains: await Promise.all(shown.map((d) => domainView(store, d))) }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /**
   * Add a domain to a programme, change its proof, or both. Body:
   * `{ programme?, company?, endsAt?, proof?: 'txt' | 'admin', reason?, dryRun? }`.
   * A new domain needs a programme. `proof: 'admin'` is the override: the
   * domain is active on the caller's say-so, recorded in the audit. A dry run
   * writes nothing and lists the accounts already at the domain.
   */
  router.add('PUT', '/api/v1/partner-domains/:domain', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const domain = normaliseDomain(String(ctx.params.domain));
    if (!domain) return sendError(res, 400, 'INVALID_DOMAIN', 'give a domain name, such as partner.example');
    const refusal = refuseDomain(domain, await deps.ownDomains());
    if (refusal) return sendError(res, 400, refusal.code, refusal.message);
    const body = ((await readJson(req)) ?? {}) as { programme?: unknown; company?: unknown; endsAt?: unknown; proof?: unknown; reason?: unknown; dryRun?: unknown };
    const now = Date.now();
    const prior = await find(domain);
    const proof = body.proof === undefined ? undefined : body.proof === 'txt' || body.proof === 'admin' ? body.proof : null;
    if (proof === null) return sendError(res, 400, 'INVALID_INPUT', 'proof is "txt" (a DNS record) or "admin" (your say-so)');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    let rule: DomainRule | undefined;
    if (body.programme !== undefined) {
      const programme = typeof body.programme === 'string' ? await store.getProgramme(body.programme) : null;
      if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
      let companyId: string | undefined;
      if (body.company !== undefined && body.company !== null && body.company !== '') {
        const company = (await store.listCompanies()).find((c) => c.id === body.company && c.programmeId === programme.id);
        if (!company) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
        companyId = company.id;
      }
      const ends = readEnd(body.endsAt, now);
      if (ends && typeof ends === 'object') return sendError(res, 400, 'INVALID_INPUT', ends.error);
      const kept = prior?.rules.find((r) => r.programmeId === programme.id);
      rule = { programmeId: programme.id, ...(companyId ? { companyId } : {}), ...(ends ? { endsAt: ends } : {}),
        addedBy: kept?.addedBy ?? actor.id, addedAt: kept?.addedAt ?? iso(now) };
    }
    if (!prior && !rule) return sendError(res, 400, 'INVALID_INPUT', 'a new domain needs a programme');

    if (body.dryRun === true) {
      const accounts = (await store.listUsers()).filter((u) => !u.id.startsWith('svc_') && domainOfEmail(u.email) === domain);
      const memberships = await store.listMemberships();
      const programmeId = rule?.programmeId;
      return sendJson(res, 200, {
        dryRun: true, domain, exists: !!prior,
        status: prior ? domainStatus(proof === 'admin' ? { ...prior, proof } : prior) : proof === 'admin' ? 'asserted' : 'pending',
        // The token is made when the domain is added, so a new one has no
        // record to show yet.
        ...(prior ? { txt: { name: txtName(domain), value: txtValue(prior.token) } } : {}),
        accounts: await Promise.all(accounts.map(async (u) => {
          const why = programmeId ? await cannotJoin(store, u, programmeId, memberships, true) : null;
          return { id: u.id, email: u.email, name: nameOf(u), joins: !why, ...(why ? { reason: why } : {}) };
        })),
      }, { 'cache-control': 'no-store' });
    }

    const at = iso(now);
    let rec: PartnerDomainRecord = prior ?? {
      domain, proof: 'txt', token: randomBytes(16).toString('base64url'), rules: [], createdBy: actor.id, createdAt: at, updatedAt: at,
    };
    if (rule) rec = { ...rec, rules: [...rec.rules.filter((r) => r.programmeId !== rule.programmeId), rule], updatedAt: at };
    const proofChanged = proof !== undefined && proof !== rec.proof;
    if (proof === 'admin') {
      rec = { ...rec, proof: 'admin', assertedBy: actor.id, assertedAt: at, updatedAt: at };
      if (reason) rec.reason = reason; else delete rec.reason;
    } else if (proof === 'txt' && proofChanged) {
      const { assertedBy: _b, assertedAt: _a, reason: _r, ...rest } = rec;
      rec = { ...rest, proof: 'txt', updatedAt: at };
    }
    await store.putPartnerDomain(rec);
    if (!prior) await audit(`user:${actor.id}`, 'programme.domain.add', `domain:${domain}`, { domain, proof: rec.proof });
    if (rule) {
      await audit(`user:${actor.id}`, 'programme.domain.rule', `domain:${domain}`, {
        domain, programme: rule.programmeId, ...(rule.companyId ? { company: rule.companyId } : {}), ...(rule.endsAt ? { endsAt: rule.endsAt } : {}),
      });
    }
    if (proof === 'admin') await audit(`user:${actor.id}`, 'programme.domain.assert', `domain:${domain}`, { domain, ...(reason ? { reason } : {}) });
    if (proof === 'txt' && proofChanged) await audit(`user:${actor.id}`, 'programme.domain.proof', `domain:${domain}`, { domain, proof: 'txt' });

    // A domain proved by DNS is looked up now when it is new or has just
    // switched to DNS, so a record already published counts straight away.
    let joined: Array<{ id: string; email: string; programme: string }> = [];
    let waiting = 0;
    if (rec.proof === 'txt' && (!prior || proofChanged)) {
      const looked = await applyLookup(store, audit, rec, await lookupTxt(domain, rec.token, deps.resolveTxt), `user:${actor.id}`, now);
      rec = looked.rec; joined = looked.joined; waiting = looked.waiting;
      // Already verified before (a second programme on a found domain), the
      // lookup changes no state, so the new rule's accounts join here.
    }
    if (domainActive(rec) && !joined.length) {
      const r = await joinExistingAccounts(store, audit, rec, `user:${actor.id}`, now, rule && !proofChanged ? [rule.programmeId] : undefined);
      joined = r.joined; waiting = r.waiting;
    }
    sendJson(res, prior ? 200 : 201, { ...(await domainView(store, rec)), joined, waiting }, { 'cache-control': 'no-store' });
  });

  /** Look the TXT record up now. */
  router.add('POST', '/api/v1/partner-domains/:domain/check', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const domain = normaliseDomain(String(ctx.params.domain));
    const rec = domain ? await find(domain) : null;
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such partner domain');
    if (rec.proof !== 'txt') return sendError(res, 400, 'NOT_DNS', 'this domain is active on an admin\'s say-so; switch it to DNS proof first');
    const looked = await applyLookup(store, audit, rec, await lookupTxt(rec.domain, rec.token, deps.resolveTxt), `user:${actor.id}`, Date.now());
    sendJson(res, 200, { ...(await domainView(store, looked.rec)), joined: looked.joined, waiting: looked.waiting }, { 'cache-control': 'no-store' });
  });

  /** Remove a domain, or with `?programme=<id>` only the rule for that programme. */
  router.add('DELETE', '/api/v1/partner-domains/:domain', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const domain = normaliseDomain(String(ctx.params.domain));
    const rec = domain ? await find(domain) : null;
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such partner domain');
    const programme = ctx.url.searchParams.get('programme');
    const left = programme ? rec.rules.filter((r) => r.programmeId !== programme) : [];
    if (programme && left.length === rec.rules.length) return sendError(res, 404, 'NOT_FOUND', 'this domain does not feed that programme');
    if (left.length) await store.putPartnerDomain({ ...rec, rules: left, updatedAt: iso() });
    else await store.deletePartnerDomain(rec.domain);
    await audit(`user:${actor.id}`, 'programme.domain.remove', `domain:${rec.domain}`, {
      domain: rec.domain, programmes: rec.rules.filter((r) => !left.includes(r)).map((r) => r.programmeId),
    });
    sendJson(res, 200, { ok: true, removed: !left.length });
  });
}
