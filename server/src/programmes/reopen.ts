// SPDX-License-Identifier: MPL-2.0
/**
 * Reopen (plans/82 M5): undo an ended partnership from its receipt, within
 * `REOPEN_DAYS` of the end, fixed and with no setting.
 *
 * Reopen puts back what the exit took and the receipt recorded:
 * - the accounts the exit disabled, and only those: one disabled before the
 *   exit stays disabled, one disabled again since stays so, and one erased
 *   since is listed as gone;
 * - their programme and company groups and the memberships the exit ended;
 * - the templates it retired, and the audiences it took off the others;
 * - the folder rules it ended, with their own end dates, where still ahead;
 * - the domain rules it withdrew, where the domain's proof is still live: a
 *   domain the exit removed comes back on an admin's recorded say-so, or after
 *   a DNS lookup finds its record again;
 * - the projects it moved, back to their owners and out of the archive,
 *   unless the admin unticks "Give their projects back", and only while they
 *   are still where the exit put them;
 * - the ended mark on the programme and companies this exit ended.
 *
 * Never put back: sessions (people sign in again), links and agent tokens
 * (revoked rows stay revoked; make new ones) and share-anyway choices (each
 * was remembered against its facts, so the receipt lists them to choose
 * again). After `REOPEN_DAYS` the receipt stays as the record and Reopen is
 * not offered; the admin adds people again by list.
 */
import type { Store } from '../store/types.ts';
import { programmeGroup, isEnded } from './types.ts';
import { companyGroup, type MembershipRecord } from './people.ts';
import { afterLookup, domainActive, lookupTxt, type DomainRule, type PartnerDomainRecord, type TxtLookup } from './domains.ts';
import type { ProgrammeExitRecord } from './exit.ts';

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Days after an end during which Reopen is offered. */
export const REOPEN_DAYS = 30;
const DAY_MS = 86_400_000;

/** When Reopen stops being offered for a receipt, or null when it never is. */
export function reopenUntil(rec: Pick<ProgrammeExitRecord, 'state' | 'doneAt'>): string | null {
  if (rec.state !== 'done' || !rec.doneAt) return null;
  return new Date(Date.parse(rec.doneAt) + REOPEN_DAYS * DAY_MS).toISOString();
}

export function reopenOffered(rec: Pick<ProgrammeExitRecord, 'state' | 'doneAt'>, now = Date.now()): boolean {
  const until = reopenUntil(rec);
  return !!until && Date.parse(until) > now;
}

export interface ReopenResult {
  accounts: Array<{ id: string; email: string; result: 'enabled' | 'rejoined' | 'left-disabled' | 'gone'; groups: string[]; memberships: string[]; reason?: string }>;
  projects: Array<{ id: string; name: string; result: 'returned' | 'kept' | 'gone'; reason?: string }>;
  templates: Array<{ id: string; name: string; result: 'restored' | 'widened' | 'kept'; reason?: string }>;
  folders: Array<{ provider: string; path: string; companyId?: string; result: 'restored' | 'past-end' | 'exists' }>;
  domainRules: Array<{ domain: string; programmeId: string; companyId?: string; result: 'restored' | 'proof-not-live' | 'needs-lookup' | 'past-end' | 'exists' }>;
  /** What this reopen took the ended mark off. */
  reopened: { programme?: string; companies: string[] };
  /** What stays ended, from the receipt: revoked tokens and links, sessions
   *  and share-anyway choices. */
  stayEnded: { tokens: number; links: number; rightsChoices: Array<{ assetId: string; group: string; licence?: string }> };
}

/**
 * What a reopen would do, or does with `apply`. `projects` false keeps moved
 * projects where the exit put them. `resolveTxt` looks up a DNS-proved domain
 * the exit removed; it is used only when applying.
 */
export async function reopenExit(
  store: Store, audit: Audit, rec: ProgrammeExitRecord,
  opts: { apply: boolean; projects: boolean; actorRef: string; actorId: string; resolveTxt: TxtLookup; now?: number },
): Promise<ReopenResult> {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const r = rec.result!;
  const doneAt = rec.doneAt!;
  const out: ReopenResult = {
    accounts: [], projects: [], templates: [], folders: [], domainRules: [], reopened: { companies: [] },
    stayEnded: {
      tokens: r.tokens.length,
      links: r.accounts.reduce((n, a) => n + (a.revoked?.links ?? 0), 0),
      rightsChoices: r.rightsChoices,
    },
  };
  const memberships: MembershipRecord[] = await store.listMemberships();
  const groupStillThere = new Set([
    ...(await store.listProgrammes()).map((p) => programmeGroup(p.id)),
    ...(await store.listCompanies()).map((c) => companyGroup(c.id)),
  ]);

  // People first, so the domain rules that follow never join someone twice.
  for (const a of r.accounts) {
    const u = await store.getUser(a.id);
    if (!u) { out.accounts.push({ id: a.id, email: a.email, result: 'gone', groups: [], memberships: [], reason: 'erased since the end' }); continue; }
    const groups = a.groupsRemoved.filter((g) => groupStillThere.has(g) && !u.localGroups.includes(g));
    const back = memberships.filter((m) => a.memberships.includes(m.programmeId) && m.email === a.email.toLowerCase() && m.endedAt === doneAt);
    let result: ReopenResult['accounts'][number]['result'] = 'rejoined';
    let reason: string | undefined;
    if (a.outcome === 'ended') {
      if (a.disabledBefore) { result = 'left-disabled'; reason = 'disabled before the end'; }
      else if (u.disabledAt && u.disabledAt !== doneAt) { result = 'left-disabled'; reason = 'disabled again since the end'; }
      else if (u.disabledAt) result = 'enabled';
    }
    if (opts.apply) {
      if (result === 'enabled') await store.setUserDisabled(u.id, null);
      if (groups.length) await store.setLocalGroups(u.id, [...u.localGroups, ...groups]);
      for (const m of back) {
        const { endedAt: _e, ...rest } = m;
        await store.putMembership(rest);
      }
      await audit(opts.actorRef, 'programme.member.reopen', `user:${u.id}`, {
        exit: rec.id, result, groups, memberships: back.map((m) => m.programmeId), ...(reason ? { reason } : {}),
      });
    }
    out.accounts.push({ id: u.id, email: u.email, result, groups, memberships: back.map((m) => m.programmeId), ...(reason ? { reason } : {}) });
    if (!opts.projects) continue;
    for (const p of a.projects) {
      const current = await store.getProject(p.id);
      if (!current) { out.projects.push({ id: p.id, name: p.name, result: 'gone' }); continue; }
      if (current.ownerId !== rec.transferTo) { out.projects.push({ id: p.id, name: p.name, result: 'kept', reason: 'moved again since the end' }); continue; }
      if (opts.apply) {
        const { archivedAt: _a, sharing: _s, ...rest } = current;
        const next = {
          ...rest, ownerId: p.before.ownerId, visibility: p.before.visibility,
          ...(p.before.sharing ? { sharing: p.before.sharing } : {}), ...(p.before.archivedAt ? { archivedAt: p.before.archivedAt } : {}),
          updatedAt: at, updatedBy: opts.actorId,
        };
        await store.putProject(next);
        await audit(opts.actorRef, 'project.transfer', `project:${p.id}`, { from: current.ownerId, to: p.before.ownerId, via: 'programme-exit-reopen', exit: rec.id });
      }
      out.projects.push({ id: p.id, name: p.name, result: 'returned' });
    }
  }

  for (const t of r.templates) {
    const current = await store.getInstanceAsset(t.id);
    if (!current) { out.templates.push({ id: t.id, name: t.name, result: 'kept', reason: 'deleted since the end' }); continue; }
    const groups = Array.isArray(current.groups) ? current.groups : [];
    if (t.action === 'retire') {
      if (current.publication?.retiredAt !== doneAt) {
        out.templates.push({ id: t.id, name: t.name, result: 'kept', reason: current.publication?.retiredAt ? 'retired again since the end' : 'restored since the end' });
        continue;
      }
      const missing = t.groupsBefore.filter((g) => groupStillThere.has(g) && !groups.includes(g));
      if (opts.apply) {
        const { retiredAt: _a, retiredBy: _b, replacedBy: _c, ...pub } = current.publication ?? {};
        await store.putInstanceAsset({ ...current, groups: [...groups, ...missing], publication: Object.keys(pub).length ? pub : undefined });
        await audit(opts.actorRef, 'programme.template.restore', `programme:${rec.programmeId ?? ''}`, { template: t.id, via: 'programme-exit-reopen', exit: rec.id });
      }
      out.templates.push({ id: t.id, name: t.name, result: 'restored' });
    } else {
      const missing = t.groupsBefore.filter((g) => groupStillThere.has(g) && !groups.includes(g));
      if (!missing.length) { out.templates.push({ id: t.id, name: t.name, result: 'kept', reason: 'already reaches them' }); continue; }
      if (opts.apply) {
        await store.putInstanceAsset({ ...current, groups: [...groups, ...missing] });
        await audit(opts.actorRef, 'programme.template.update', `programme:${rec.programmeId ?? ''}`, {
          template: t.id, before: { groups }, after: { groups: [...groups, ...missing] }, via: 'programme-exit-reopen', exit: rec.id,
        });
      }
      out.templates.push({ id: t.id, name: t.name, result: 'widened' });
    }
  }

  const folders = await store.listPartnerFolders();
  for (const f of r.folders) {
    const key = { provider: f.provider, path: f.path, ...(f.companyId ? { companyId: f.companyId } : {}) };
    if (f.endsAt && Date.parse(f.endsAt) <= now) { out.folders.push({ ...key, result: 'past-end' }); continue; }
    if (folders.some((x) => x.provider === f.provider && x.path === f.path && x.programmeId === f.programmeId && (x.companyId ?? '') === (f.companyId ?? ''))) {
      out.folders.push({ ...key, result: 'exists' });
      continue;
    }
    if (opts.apply) {
      await store.putPartnerFolder(f);
      await audit(opts.actorRef, 'programme.folder.add', `programme:${f.programmeId}`, {
        provider: f.provider, path: f.path, ...(f.companyId ? { company: f.companyId } : {}), ...(f.endsAt ? { endsAt: f.endsAt } : {}), via: 'programme-exit-reopen', exit: rec.id,
      });
    }
    out.folders.push({ ...key, result: 'restored' });
  }

  // Domain rules, by domain: back onto a record still here and active, or the
  // removed record back when its proof is still live.
  const byDomain = new Map<string, DomainRule[]>();
  for (const d of r.domainRules) byDomain.set(d.domain, [...(byDomain.get(d.domain) ?? []), d.rule]);
  for (const [domain, rules] of byDomain) {
    const current = (await store.listPartnerDomains()).find((d) => d.domain === domain);
    let base: PartnerDomainRecord | null = current ?? null;
    let live = !!current && domainActive(current);
    // A preview cannot look a removed DNS-proved domain up; the apply step does.
    let lookup = false;
    if (!current) {
      const removed = r.domainsRemoved.find((d) => d.domain === domain);
      if (removed?.proof === 'admin') { base = { ...removed, rules: [] }; live = true; }
      else if (removed && opts.apply) {
        const looked = afterLookup({ ...removed, rules: [] }, await lookupTxt(domain, removed.token, opts.resolveTxt), at);
        base = looked;
        live = domainActive(looked);
      } else if (removed) { base = { ...removed, rules: [] }; lookup = true; }
    }
    const restore: DomainRule[] = [];
    for (const rule of rules) {
      const row = { domain, programmeId: rule.programmeId, ...(rule.companyId ? { companyId: rule.companyId } : {}) };
      if (rule.endsAt && Date.parse(rule.endsAt) <= now) { out.domainRules.push({ ...row, result: 'past-end' }); continue; }
      if (lookup) { out.domainRules.push({ ...row, result: 'needs-lookup' }); continue; }
      if (!base || !live) { out.domainRules.push({ ...row, result: 'proof-not-live' }); continue; }
      if (base.rules.some((x) => x.programmeId === rule.programmeId)) { out.domainRules.push({ ...row, result: 'exists' }); continue; }
      restore.push(rule);
      out.domainRules.push({ ...row, result: 'restored' });
    }
    if (opts.apply && base && restore.length) {
      await store.putPartnerDomain({ ...base, rules: [...base.rules, ...restore], updatedAt: at });
      await audit(opts.actorRef, 'programme.domain.rule', `domain:${domain}`, {
        domain, programmes: restore.map((x) => x.programmeId), via: 'programme-exit-reopen', exit: rec.id,
      });
    }
  }

  // The ended mark comes off only the records this exit marked.
  if (r.ended.programme) {
    const p = await store.getProgramme(r.ended.programme);
    if (p && isEnded(p) && p.endedExit === rec.id) {
      if (opts.apply) {
        const { endedAt: _a, endedBy: _b, endedExit: _c, ...rest } = p;
        await store.putProgramme({ ...rest, updatedAt: at, version: p.version + 1 });
      }
      out.reopened.programme = p.id;
    }
  }
  for (const c of await store.listCompanies()) {
    if (!r.ended.companies.includes(c.id) || c.endedExit !== rec.id) continue;
    if (opts.apply) {
      const { endedAt: _a, endedBy: _b, endedExit: _c, ...rest } = c;
      await store.putCompany({ ...rest, updatedAt: at });
    }
    out.reopened.companies.push(c.id);
  }
  return out;
}
