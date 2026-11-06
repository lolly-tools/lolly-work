// SPDX-License-Identifier: MPL-2.0
/**
 * Partner domains (plans/82 M1 part 2b), over real HTTP and real OIDC
 * sign-ins on the invite harness (admission on, invitations only).
 *
 * Pinned here: public mail, shared suffixes and the workspace's own domains
 * are refused; DNS TXT proof is the default and an admin's say-so is the
 * audited override; only a verified address is admitted and joins; a person
 * joins through a domain once, so a removal sticks; accounts already here
 * join when the domain is proved, unless they are admins, disabled, SCIM's or
 * unverified; a domain whose record disappears pauses; rule end dates and the
 * membership sweep end access together; and ending a partnership withdraws
 * the domain first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boot, devLogin, invite, signIn, type Env } from './invite-harness.ts';
import { decideAdmission } from '../server/src/iam/admission.ts';
import {
  admittingDomains, afterLookup, hostDomains, lookupTxt, refuseDomain, type PartnerDomainRecord,
} from '../server/src/programmes/domains.ts';
import { recheckDomains, sweepDomainRules } from '../server/src/programmes/domain-routes.ts';
import { sweepProgrammeEnds } from '../server/src/programmes/people-routes.ts';

const DAY = 86_400_000;

type Dns = Map<string, string[]>;
function dnsStub(dns: Dns) {
  return async (name: string): Promise<string[][]> => {
    const values = dns.get(name);
    if (!values) throw Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: 'ENODATA' });
    return values.map((v) => [v]);
  };
}

async function setup(): Promise<Env & { dns: Dns; call: (method: string, path: string, body?: unknown, cookie?: string) => Promise<{ status: number; body: Record<string, any> }> }> {
  const dns: Dns = new Map();
  const env = await boot({ resolveTxt: dnsStub(dns) });
  const call = async (method: string, path: string, body?: unknown, cookie = env.adminSession) => {
    const res = await fetch(`${env.base}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  assert.equal((await call('PUT', '/api/v1/programmes/resellers', { name: 'Resellers' })).status, 201);
  assert.equal((await call('PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme Distribution' })).status, 201);
  return { ...env, dns, call };
}

/** Sign in at the stub Google as this address; the result and the account. */
async function googleSignIn(env: Env, sub: string, email: string, verified = true) {
  env.script.google = { sub, email, email_verified: verified, given_name: email.split('@')[0] };
  const { done, session } = await signIn(env, 'primary');
  return { status: done.status, session, user: await env.store.getUserBySub(sub) };
}

const auditsOf = async (env: Env, action: string) => (await env.store.listAudit()).filter((e) => e.action === action);

const record = (over: Partial<PartnerDomainRecord> = {}): PartnerDomainRecord => ({
  domain: 'acme.example', proof: 'txt', token: 'tok', rules: [{ programmeId: 'resellers', addedBy: 'u', addedAt: 'x' }],
  createdBy: 'u', createdAt: 'x', updatedAt: 'x', ...over,
});

test('public mail, shared suffixes and the workspace\'s own domains are refused, subdomains too', () => {
  const own = new Map([['team.example', "this workspace's address"], ['admin.example', "an admin's or owner's address"]]);
  assert.equal(refuseDomain('gmail.com', own)?.code, 'PUBLIC_MAIL_DOMAIN');
  assert.equal(refuseDomain('proton.me', own)?.code, 'PUBLIC_MAIL_DOMAIN');
  assert.equal(refuseDomain('co.uk', own)?.code, 'INVALID_DOMAIN');
  assert.equal(refuseDomain('admin.example', own)?.code, 'OWN_DOMAIN');
  assert.equal(refuseDomain('eu.admin.example', own)?.code, 'OWN_DOMAIN', 'a subdomain of your own is your own');
  assert.match(refuseDomain('team.example', own)!.message, /workspace's address/);
  assert.equal(refuseDomain('acme.example', own), null);
  assert.equal(refuseDomain('acme.co.uk', own), null, 'a name under a shared suffix is fine');
  assert.deepEqual(hostDomains('https://work.brand.example/x'), ['work.brand.example', 'brand.example']);
  assert.deepEqual(hostDomains('http://localhost:8787'), []);
  assert.deepEqual(hostDomains('http://127.0.0.1:8787'), []);
});

test('a TXT lookup tells "not there" from a failed lookup, and only "not there" pauses', async () => {
  const found = await lookupTxt('acme.example', 'tok', async () => [['lw-verify=', 'tok'], ['v=spf1 -all']]);
  assert.deepEqual(found, { found: true }, 'a record split in chunks is joined');
  const wrong = await lookupTxt('acme.example', 'tok', async () => [['lw-verify=other']]);
  assert.deepEqual(wrong, { found: false, missing: true });
  const nxdomain = await lookupTxt('acme.example', 'tok', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); });
  assert.deepEqual(nxdomain, { found: false, missing: true });
  const timeout = await lookupTxt('acme.example', 'tok', async () => { throw Object.assign(new Error('x'), { code: 'ETIMEOUT' }); });
  assert.deepEqual(timeout, { found: false, missing: false, error: 'ETIMEOUT' });

  const pending = record();
  assert.equal(afterLookup(pending, wrong, 't1').verifiedAt, undefined, 'never found: still pending');
  assert.equal(afterLookup(pending, wrong, 't1').missingSince, undefined);
  const verified = afterLookup(pending, found, 't1');
  assert.equal(verified.verifiedAt, 't1');
  assert.equal(afterLookup(verified, timeout, 't2').missingSince, undefined, 'a failed lookup keeps the state');
  assert.equal(afterLookup(verified, timeout, 't2').lastError, 'ETIMEOUT');
  const paused = afterLookup(verified, wrong, 't3');
  assert.equal(paused.missingSince, 't3');
  assert.equal(afterLookup(paused, wrong, 't4').missingSince, 't3', 'paused from the first miss');
  assert.equal(afterLookup(paused, found, 't5').missingSince, undefined, 'back when the record is back');

  const now = Date.now();
  assert.deepEqual(admittingDomains([verified], now), ['acme.example']);
  assert.deepEqual(admittingDomains([pending, paused], now), [], 'pending and paused admit nobody');
  assert.deepEqual(admittingDomains([record({ proof: 'admin', assertedBy: 'u' })], now), ['acme.example']);
  assert.deepEqual(admittingDomains([{ ...verified, rules: [{ programmeId: 'resellers', endsAt: new Date(now - 1).toISOString(), addedBy: 'u', addedAt: 'x' }] }], now), [],
    'a domain whose rules have all ended admits nobody');
});

test('admission: a partner domain admits a verified address only, and a domain membership admits its address', () => {
  const partner = { domains: ['acme.example'], member: false };
  const at = Date.now();
  assert.deepEqual(decideAdmission({ email: 'ana@acme.example', emailVerified: true }, {}, {}, null, at, partner), { ok: true, via: 'partner-domain', emailVerified: true });
  assert.deepEqual(decideAdmission({ email: 'ana@acme.example', emailVerified: false }, {}, {}, null, at, partner), { ok: false, reason: 'email-unverified' });
  assert.deepEqual(decideAdmission({ email: 'ana@sub.acme.example', emailVerified: true }, {}, {}, null, at, partner), { ok: false, reason: 'not-invited' },
    'the exact domain only');
  assert.deepEqual(decideAdmission({ email: 'ana@other.example', emailVerified: true }, {}, {}, null, at, { domains: [], member: true }), { ok: true, via: 'partner-member', emailVerified: true });
  assert.deepEqual(decideAdmission({ email: 'ana@acme.example', emailVerified: true, disabled: true }, {}, {}, null, at, partner), { ok: false, reason: 'disabled' });
});

test('the console API refuses public mail and your own domains, and needs programme.manage', async () => {
  const env = await setup();
  for (const [domain, code] of [['gmail.com', 'PUBLIC_MAIL_DOMAIN'], ['co.uk', 'INVALID_DOMAIN'], ['admin.example', 'OWN_DOMAIN'], ['eu.admin.example', 'OWN_DOMAIN'], ['team.example', 'OWN_DOMAIN'], ['not a domain', 'INVALID_DOMAIN']] as const) {
    const r = await env.call('PUT', `/api/v1/partner-domains/${encodeURIComponent(domain)}`, { programme: 'resellers' });
    assert.equal(r.status, 400, domain);
    assert.equal(r.body.error?.code ?? r.body.code, code, domain);
  }
  assert.equal((await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'nope' })).status, 404);
  assert.equal((await env.call('PUT', '/api/v1/partner-domains/acme.example', {})).status, 400, 'a new domain needs a programme');
  assert.equal((await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', company: 'nope' })).status, 404);
  assert.equal((await env.store.listPartnerDomains()).length, 0, 'nothing was written');

  // Someone without programme.manage gets nothing.
  await invite(env, { id: 'inv_ana', email: 'ana@acme.example' });
  const ana = await googleSignIn(env, 'g-ana', 'ana@acme.example');
  assert.equal(ana.status, 302);
  assert.equal((await env.call('GET', '/api/v1/partner-domains', undefined, ana.session)).status, 403);
  assert.equal((await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers' }, ana.session)).status, 403);
});

test('DNS proof: pending until the record is found, then a verified sign-in there joins the programme and company', async () => {
  const env = await setup();
  const added = await env.call('PUT', '/api/v1/partner-domains/ACME.example', { programme: 'resellers', company: 'acme' });
  assert.equal(added.status, 201);
  assert.equal(added.body.domain, 'acme.example', 'lowercased');
  assert.equal(added.body.status, 'pending');
  assert.equal(added.body.txt.name, '_lolly-work.acme.example');
  assert.match(added.body.txt.value, /^lw-verify=[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(added.body.rules.map((r: any) => [r.programme.name, r.company.name]), [['Resellers', 'Acme Distribution']]);

  assert.equal((await googleSignIn(env, 'g-ana', 'ana@acme.example')).status, 403, 'pending admits nobody');

  env.dns.set('_lolly-work.acme.example', [added.body.txt.value]);
  const checked = await env.call('POST', '/api/v1/partner-domains/acme.example/check');
  assert.equal(checked.status, 200);
  assert.equal(checked.body.status, 'verified');
  const verify = (await auditsOf(env, 'programme.domain.verify'))[0]!;
  assert.equal(verify.actor, `user:${env.admin.id}`);
  assert.deepEqual(verify.payload, { domain: 'acme.example', from: 'pending', to: 'verified' });

  const unverified = await googleSignIn(env, 'g-bo', 'bo@acme.example', false);
  assert.equal(unverified.status, 403, 'an address the provider does not vouch for never matches');
  assert.equal(unverified.user, null);

  const ana = await googleSignIn(env, 'g-ana', 'ana@acme.example');
  assert.equal(ana.status, 302);
  assert.ok(ana.user!.groups.includes('programme-resellers'));
  assert.ok(ana.user!.groups.includes('company-acme'));
  assert.ok(ana.user!.groups.includes('partner'));
  const membership = (await env.store.listMemberships()).find((m) => m.email === 'ana@acme.example')!;
  assert.equal(membership.via, 'domain');
  assert.equal(membership.domain, 'acme.example');
  assert.equal(membership.companyId, 'acme');
  const joined = (await auditsOf(env, 'programme.member.add'))[0]!;
  assert.deepEqual(joined.payload, { user: ana.user!.id, company: 'acme', via: 'domain', domain: 'acme.example', proof: 'txt' });

  const people = await env.call('GET', '/api/v1/programmes/resellers/people');
  assert.equal(people.body.people[0].joinedThrough, 'acme.example', 'People says how she joined');

  const listed = await env.call('GET', '/api/v1/partner-domains?programme=resellers');
  assert.equal(listed.body.domains.length, 1);
  assert.equal(listed.body.domains[0].members, 1);
  assert.equal((await env.call('GET', '/api/v1/partner-domains?programme=other')).body.domains.length, 0);
});

test('an admin\'s say-so activates a domain at once, recorded in the audit with who and why', async () => {
  const env = await setup();
  const r = await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', proof: 'admin', reason: 'Signed partner agreement, ticket 4411' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'asserted');
  assert.equal(r.body.asserted.by.name, 'Andy Fitz');
  assert.equal(r.body.asserted.reason, 'Signed partner agreement, ticket 4411');
  const assert1 = (await auditsOf(env, 'programme.domain.assert'))[0]!;
  assert.equal(assert1.actor, `user:${env.admin.id}`);
  assert.equal(assert1.subject, 'domain:acme.example');
  assert.deepEqual(assert1.payload, { domain: 'acme.example', reason: 'Signed partner agreement, ticket 4411' });
  assert.equal((await env.call('POST', '/api/v1/partner-domains/acme.example/check')).status, 400, 'nothing to look up on a say-so');
  assert.equal((await googleSignIn(env, 'g-ana', 'ana@acme.example')).status, 302);

  // Back to DNS: the assertion is cleared and the domain waits for its record.
  const back = await env.call('PUT', '/api/v1/partner-domains/acme.example', { proof: 'txt' });
  assert.equal(back.body.status, 'pending');
  assert.equal(back.body.asserted, undefined);
  assert.equal((await auditsOf(env, 'programme.domain.proof')).length, 1);
});

test('accounts already here join when the domain is proved; disabled, SCIM and unverified accounts do not', async () => {
  const env = await setup();
  for (const [id, email] of [['inv_ana', 'ana@acme.example'], ['inv_cy', 'cy@acme.example'], ['inv_di', 'di@acme.example']] as const) await invite(env, { id, email });
  const ana = (await googleSignIn(env, 'g-ana', 'ana@acme.example')).user!;
  const cy = (await googleSignIn(env, 'g-cy', 'cy@acme.example')).user!;
  const di = (await googleSignIn(env, 'g-di', 'di@acme.example')).user!;
  assert.ok(!ana.groups.includes('programme-resellers'));
  await env.store.setUserDisabled(cy.id, new Date().toISOString());
  await env.store.setUserScimIdp(di.id, 'okta');
  // An account whose address no provider has verified (a password set from a link).
  const eve = await env.store.upsertUserBySub({ sub: 'password:eve', email: 'eve@acme.example', groups: [], role: 'member' });
  await env.store.linkIdentity({ identitySub: eve.sub, userId: eve.id, idp: 'email', email: eve.email, emailVerified: false, linkedAt: new Date().toISOString() });

  const dry = await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', proof: 'admin', dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.exists, false);
  assert.equal(dry.body.txt, undefined, 'a new domain has no record yet');
  const byEmail = Object.fromEntries(dry.body.accounts.map((a: any) => [a.email, a]));
  assert.equal(byEmail['ana@acme.example'].joins, true);
  assert.equal(byEmail['cy@acme.example'].reason, 'disabled');
  assert.equal(byEmail['di@acme.example'].reason, 'managed by your SCIM connector');
  assert.match(byEmail['eve@acme.example'].reason, /^address not verified/);
  assert.equal((await env.store.listPartnerDomains()).length, 0, 'a dry run writes nothing');

  const done = await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', proof: 'admin' });
  assert.deepEqual(done.body.joined.map((j: any) => j.email), ['ana@acme.example']);
  assert.equal(done.body.waiting, 1, 'Eve joins at her next verified sign-in');
  assert.ok((await env.store.getUser(ana.id))!.groups.includes('programme-resellers'), 'joined now, not at the next sign-in');
  assert.ok(!(await env.store.getUser(di.id))!.groups.includes('programme-resellers'));
});

test('a person joins through a domain once: removing them from the programme sticks, and they keep only the essentials', async () => {
  const env = await setup();
  await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', proof: 'admin' });
  const ana = (await googleSignIn(env, 'g-ana', 'ana@acme.example')).user!;
  assert.ok(ana.groups.includes('programme-resellers'));
  await env.store.setLocalGroups(ana.id, ana.localGroups.filter((g) => g !== 'programme-resellers' && g !== 'company-acme'));
  const again = await googleSignIn(env, 'g-ana', 'ana@acme.example');
  assert.equal(again.status, 302);
  assert.ok(!again.user!.groups.includes('programme-resellers'), 'not added back');
  assert.ok(again.user!.groups.includes('partner'), 'still a partner account');
});

test('a domain whose record disappears pauses: nobody new joins, people already in keep signing in', async () => {
  const env = await setup();
  const added = await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers' });
  env.dns.set('_lolly-work.acme.example', [added.body.txt.value]);
  await env.call('POST', '/api/v1/partner-domains/acme.example/check');
  assert.equal((await googleSignIn(env, 'g-ana', 'ana@acme.example')).status, 302);

  env.dns.delete('_lolly-work.acme.example');
  assert.equal(await recheckDomains(env.store, async () => undefined, dnsStub(env.dns), Date.now() + DAY / 2), 0, 'a found domain is looked up daily, not sooner');
  const audit = async (actor: string, action: string, subject: string, payload?: Record<string, unknown>) =>
    env.store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });
  assert.equal(await recheckDomains(env.store, audit, dnsStub(env.dns), Date.now() + DAY + 60_000), 1);
  const listed = await env.call('GET', '/api/v1/partner-domains');
  assert.equal(listed.body.domains[0].status, 'paused');
  assert.ok(listed.body.domains[0].missingSince);
  assert.deepEqual((await auditsOf(env, 'programme.domain.pause'))[0]!.payload, { domain: 'acme.example', from: 'verified', to: 'paused' });

  assert.equal((await googleSignIn(env, 'g-cy', 'cy@acme.example')).status, 403, 'nobody new');
  assert.equal((await googleSignIn(env, 'g-ana', 'ana@acme.example')).status, 302, 'Ana is in through her membership');
});

test('a rule\'s end date ends the rule and the memberships made through it together', async () => {
  const env = await setup();
  const ends = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', company: 'acme', proof: 'admin', endsAt: ends });
  const ana = (await googleSignIn(env, 'g-ana', 'ana@acme.example')).user!;
  const membership = (await env.store.listMemberships()).find((m) => m.email === 'ana@acme.example')!;
  assert.equal(membership.endsAt, `${ends}T23:59:59.999Z`, 'the membership carries the rule\'s end');

  const audit = async (actor: string, action: string, subject: string, payload?: Record<string, unknown>) =>
    env.store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });
  const later = Date.now() + 3 * DAY;
  assert.equal(await sweepDomainRules(env.store, audit, later), 1);
  assert.equal(await sweepProgrammeEnds(env.store, audit, later), 1);
  assert.equal((await env.store.listPartnerDomains()).length, 0, 'a domain with no rule left is removed');
  const after = (await env.store.getUser(ana.id))!;
  assert.ok(!after.groups.includes('programme-resellers') && !after.groups.includes('company-acme'));
  assert.ok(after.groups.includes('partner'));
});

test('ending a partnership by domain withdraws the domain first, then ends access for everyone there', async () => {
  const env = await setup();
  await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', company: 'acme', proof: 'admin' });
  const ana = (await googleSignIn(env, 'g-ana', 'ana@acme.example')).user!;

  const dry = await env.call('POST', '/api/v1/programmes/exit', { domain: 'acme.example' });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.accounts.map((a: any) => a.email), ['ana@acme.example']);
  assert.deepEqual(dry.body.domainRules, [{ domain: 'acme.example', programme: { id: 'resellers', name: 'Resellers' }, company: { id: 'acme', name: 'Acme Distribution' } }]);
  assert.equal((await env.store.listPartnerDomains()).length, 1, 'a dry run writes nothing');

  const done = await env.call('POST', '/api/v1/programmes/exit', { domain: 'acme.example', apply: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.domainRules.length, 1);
  assert.equal((await env.store.listPartnerDomains()).length, 0);
  assert.ok((await env.store.getUser(ana.id))!.disabledAt);
  assert.equal((await auditsOf(env, 'programme.domain.remove'))[0]!.payload!.via, 'programme-exit');
  assert.equal((await googleSignIn(env, 'g-cy', 'cy@acme.example')).status, 403, 'nobody new from the domain');
  assert.equal((await googleSignIn(env, 'g-ana', 'ana@acme.example')).status, 403, 'and Ana is disabled');
});

test('ending one programme withdraws only its rules; the domain keeps feeding the other', async () => {
  const env = await setup();
  assert.equal((await env.call('PUT', '/api/v1/programmes/isvs', { name: 'Software partners' })).status, 201);
  await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'resellers', proof: 'admin' });
  await env.call('PUT', '/api/v1/partner-domains/acme.example', { programme: 'isvs' });
  const view = (await env.call('GET', '/api/v1/partner-domains')).body.domains[0];
  assert.deepEqual(view.rules.map((r: any) => r.programme.id).sort(), ['isvs', 'resellers']);
  assert.equal(view.status, 'asserted', 'a second programme keeps the domain\'s proof');

  const done = await env.call('POST', '/api/v1/programmes/exit', { programme: 'isvs', apply: true });
  assert.deepEqual(done.body.domainRules, [{ domain: 'acme.example', programme: { id: 'isvs', name: 'Software partners' } }]);
  assert.deepEqual((await env.store.listPartnerDomains())[0]!.rules.map((r) => r.programmeId), ['resellers']);

  const removed = await env.call('DELETE', '/api/v1/partner-domains/acme.example?programme=resellers');
  assert.deepEqual(removed.body, { ok: true, removed: true });
  assert.equal((await env.store.listPartnerDomains()).length, 0);
});

test('the CLI does the same: lw domains add, ls and check, lw people import and exit, each previewing first', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const env = await setup();
  // Service tokens are an owner's to mint.
  const owner = await devLogin(env.base, 'owner@admin.example');
  const token = await env.call('POST', '/api/v1/tokens', { label: 'Partner admin', role: 'admin' }, owner);
  assert.equal(token.status, 201);
  const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['cli/lw.ts', ...args, '--json'], {
    env: { ...process.env, LW_BASE: env.base, LW_TOKEN: token.body.token },
  })).stdout);

  const dry = await run(['domains', 'add', 'acme.example', '--programme', 'resellers', '--assert', '--dry-run']);
  assert.equal(dry.dryRun, true);
  assert.equal((await env.store.listPartnerDomains()).length, 0);
  const added = await run(['domains', 'add', 'acme.example', '--programme', 'resellers', '--company', 'acme', '--assert', '--reason', 'Agreement 4411']);
  assert.equal(added.status, 'asserted');
  assert.equal(added.asserted.reason, 'Agreement 4411');
  assert.deepEqual((await run(['domains'])).domains.map((d: any) => d.domain), ['acme.example']);

  const dir = await mkdtemp(join(tmpdir(), 'lw-people-'));
  await writeFile(join(dir, 'list.csv'), 'email,name,company\nrui@reseller.example,Rui,Acme Distribution\n');
  const imported = await run(['people', 'import', 'resellers', join(dir, 'list.csv')]);
  assert.equal(imported.dryRun, true);
  assert.equal(imported.summary.new, 1);

  const exit = await run(['people', 'exit', '--domain', 'acme.example']);
  assert.equal(exit.dryRun, true);
  assert.deepEqual(exit.domainRules.map((r: any) => r.domain), ['acme.example']);
  assert.equal((await env.store.listPartnerDomains()).length, 1, 'previews change nothing');
});
