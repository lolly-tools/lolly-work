// SPDX-License-Identifier: MPL-2.0
/**
 * decideAdmission (plans/74 W-ID-1), every branch, plus the bootstrap-owner
 * group and the config validation that feeds both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapOwnerGroup, decideAdmission, emailDomain, emailIsVerified, type AdmissionDecision } from '../server/src/iam/admission.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mapClaims } from '../server/src/iam/oidc.ts';

const verified = { email: 'Ana@Example.com', emailVerified: true };
const unverified = { email: 'ana@example.com', emailVerified: false };
const NOW = Date.parse('2026-10-02T12:00:00Z');

test('no policy: every verified sign-in is admitted, verified email or not', () => {
  assert.deepEqual(decideAdmission(verified, {}, undefined, null), { ok: true, via: 'open', emailVerified: true });
  assert.deepEqual(decideAdmission(unverified, {}, undefined, null), { ok: true, via: 'open', emailVerified: false });
});

test('a disabled account is refused before anything else', () => {
  assert.deepEqual(decideAdmission({ ...verified, disabled: true }, {}, undefined, null), { ok: false, reason: 'disabled' });
  assert.deepEqual(decideAdmission({ ...verified, disabled: true }, {}, { emails: ['ana@example.com'] }, null), { ok: false, reason: 'disabled' });
});

test('hostedDomain: a mismatch or missing hd always refuses, even for a listed email', () => {
  const idp = { hostedDomain: 'example.com' };
  assert.deepEqual(decideAdmission({ ...verified, hd: 'other.com' }, idp, { emails: ['ana@example.com'] }, null), { ok: false, reason: 'hosted-domain' });
  assert.deepEqual(decideAdmission(verified, idp, undefined, null), { ok: false, reason: 'hosted-domain' }, 'a personal account carries no hd');
  assert.deepEqual(decideAdmission({ ...verified, hd: 'Example.COM' }, idp, undefined, null), { ok: true, via: 'open', emailVerified: true }, 'case-insensitive');
});

test('tenantId: a mismatch or missing tid always refuses', () => {
  const tenant = '0f5d2a1e-1111-2222-3333-444455556666';
  const idp = { tenantId: tenant };
  assert.deepEqual(decideAdmission({ ...verified, tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }, idp, { domains: ['example.com'] }, null), { ok: false, reason: 'tenant' });
  assert.deepEqual(decideAdmission(verified, idp, undefined, null), { ok: false, reason: 'tenant' });
  assert.equal(decideAdmission({ ...verified, tid: tenant.toUpperCase() }, idp, undefined, null).ok, true);
});

test('listed email: case-insensitive, needs a verified email under claim', () => {
  const policy = { emails: ['ANA@example.com'] };
  assert.deepEqual(decideAdmission(verified, {}, policy, null), { ok: true, via: 'email', emailVerified: true });
  assert.deepEqual(decideAdmission(unverified, {}, policy, null), { ok: false, reason: 'email-unverified' });
  assert.deepEqual(decideAdmission({ email: 'ana@example.com', emailVerified: 'true' }, {}, policy, null), { ok: false, reason: 'email-unverified' }, 'only boolean true counts');
  assert.deepEqual(decideAdmission({ email: 'ana@example.com' }, {}, policy, null), { ok: false, reason: 'email-unverified' }, 'a missing claim is not verified');
  assert.deepEqual(decideAdmission({ email: 'ana@example.com' }, { emailVerification: 'trusted' }, policy, null), { ok: true, via: 'email', emailVerified: true });
});

test('listed domain: the part after the LAST @, verified only', () => {
  const policy = { domains: ['example.com'] };
  assert.deepEqual(decideAdmission({ email: 'bo@EXAMPLE.com', emailVerified: true }, {}, policy, null), { ok: true, via: 'domain', emailVerified: true });
  assert.deepEqual(decideAdmission({ email: 'bo@example.com', emailVerified: false }, {}, policy, null), { ok: false, reason: 'email-unverified' });
  assert.deepEqual(decideAdmission({ email: 'x@example.com@evil.test', emailVerified: true }, {}, policy, null), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission({ email: 'bo@sub.example.com', emailVerified: true }, {}, policy, null), { ok: false, reason: 'not-invited' }, 'no subdomain matching');
  assert.deepEqual(decideAdmission({ email: 'bo@example.com', emailVerified: true }, {}, { domains: ['@example.com'] }, null).ok, true);
});

test('not listed: refused, and an empty policy admits nobody without an invitation', () => {
  assert.deepEqual(decideAdmission(verified, {}, { emails: ['someone@example.com'], domains: ['other.org'] }, null), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(verified, {}, {}, null), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission({ email: '', emailVerified: true }, {}, { emails: [''], domains: [''] }, null), { ok: false, reason: 'not-invited' });
});

test('invitations: an open one admits a verified email; expired, revoked, other-email or disabled ones do not', () => {
  const inv = { email: 'ana@example.com' };
  assert.deepEqual(decideAdmission(verified, {}, {}, inv, NOW), { ok: true, via: 'invitation', emailVerified: true });
  assert.deepEqual(decideAdmission(verified, {}, { invitations: true }, { ...inv, expiresAt: '2026-10-03T00:00:00Z' }, NOW).ok, true);
  assert.deepEqual(decideAdmission(verified, {}, {}, { ...inv, expiresAt: '2026-10-01T00:00:00Z' }, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(verified, {}, {}, { ...inv, revokedAt: '2026-10-01T00:00:00Z' }, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(verified, {}, {}, { email: 'bo@example.com' }, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(verified, {}, { invitations: false }, inv, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(unverified, {}, {}, inv, NOW), { ok: false, reason: 'email-unverified' });
  assert.deepEqual(decideAdmission(verified, {}, { emails: ['ana@example.com'] }, inv, NOW), { ok: true, via: 'invitation', emailVerified: true }, 'an invitation is reported first so its groups can apply');
});

test('invitationEmails: another verified address matches an invitation, never the lists or the domains (invite spec M5)', () => {
  const personal = { email: 'sam.k@gmail.com', emailVerified: true, invitationEmails: ['sam@work.example'] };
  // The invitation went to the work address the GitHub account also verified.
  assert.deepEqual(decideAdmission(personal, {}, {}, { email: 'Sam@Work.example' }, NOW), { ok: true, via: 'invitation', emailVerified: true });
  // Its end and its revocation still count.
  assert.deepEqual(decideAdmission(personal, {}, {}, { email: 'sam@work.example', expiresAt: '2026-10-01T00:00:00Z' }, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(personal, {}, {}, { email: 'sam@work.example', revokedAt: '2026-10-01T00:00:00Z' }, NOW), { ok: false, reason: 'not-invited' });
  // A listed domain or email reads the sign-in's own address only.
  assert.deepEqual(decideAdmission(personal, {}, { domains: ['work.example'] }, null, NOW), { ok: false, reason: 'not-invited' });
  assert.deepEqual(decideAdmission(personal, {}, { emails: ['sam@work.example'] }, null, NOW), { ok: false, reason: 'not-invited' });
  // Invitations switched off: nothing matches through any address.
  assert.deepEqual(decideAdmission(personal, {}, { invitations: false }, { email: 'sam@work.example' }, NOW), { ok: false, reason: 'not-invited' });
  // An unverified primary is still refused before any list or invitation is read.
  assert.deepEqual(decideAdmission({ ...personal, emailVerified: false }, {}, {}, { email: 'sam@work.example' }, NOW), { ok: false, reason: 'email-unverified' });
});

test('an unverified email gets the same refusal whether or not it is listed, so the lists cannot be probed', () => {
  const policy = { emails: ['ceo@corp.example'], domains: ['corp.example'] };
  const listed = decideAdmission({ email: 'ceo@corp.example', emailVerified: false }, {}, policy, null);
  const unlisted = decideAdmission({ email: 'nobody@elsewhere.example', emailVerified: false }, {}, policy, null);
  const invited = decideAdmission({ email: 'guest@elsewhere.example' }, {}, {}, { email: 'guest@elsewhere.example' }, NOW);
  assert.deepEqual(listed, { ok: false, reason: 'email-unverified' });
  assert.deepEqual(unlisted, listed, 'an unlisted unverified email reads exactly like a listed one');
  assert.deepEqual(invited, listed);
});

test('mapClaims: email_verified vouches only for the email claim, not a remapped one', () => {
  const claims = { sub: 's1', email: 'attacker@gmail.test', email_verified: true, preferred_username: 'owner@corp.example' };
  const remapped = mapClaims(claims, { email: 'preferred_username' }, 'groups');
  assert.equal(remapped.email, 'owner@corp.example');
  assert.equal(remapped.emailVerified, undefined, 'a user-chosen username is not the verified address');
  assert.deepEqual(decideAdmission(remapped, {}, { emails: ['owner@corp.example'] }, null), { ok: false, reason: 'email-unverified' });
  assert.equal(decideAdmission(remapped, { emailVerification: 'trusted' }, { emails: ['owner@corp.example'] }, null).ok, true, 'trusted is the operator choosing on purpose');
  assert.equal(mapClaims({ ...claims, preferred_username: 'Attacker@Gmail.test' }, { email: 'preferred_username' }, 'groups').emailVerified, true, 'the same address under another claim keeps the flag');
  assert.equal(mapClaims(claims, {}, 'groups').emailVerified, true, 'the default email claim keeps the flag');
  assert.equal(mapClaims({ ...claims, email_verified: false }, {}, 'groups').emailVerified, false);
});

test('emailDomain and emailIsVerified', () => {
  assert.equal(emailDomain('a@b@Example.ORG'), 'example.org');
  assert.equal(emailDomain('nobody'), '');
  assert.equal(emailIsVerified({ email: 'a@b.c' }, { emailVerification: 'trusted' }), true);
  assert.equal(emailIsVerified({ email: 'a@b.c', emailVerified: true }, {}), true);
  assert.equal(emailIsVerified({ email: 'a@b.c' }, {}), false);
});

test('bootstrapOwnerGroup: only an admitted, verified, listed email; owner group from roleGroups', () => {
  const ok: AdmissionDecision = { ok: true, via: 'email', emailVerified: true };
  assert.equal(bootstrapOwnerGroup(ok, 'Ana@Example.com', ['ana@example.com'], undefined), 'owner');
  assert.equal(bootstrapOwnerGroup(ok, 'ana@example.com', ['ana@example.com'], ['lolly-owners', 'x']), 'lolly-owners');
  assert.equal(bootstrapOwnerGroup(ok, 'bo@example.com', ['ana@example.com'], undefined), null);
  assert.equal(bootstrapOwnerGroup({ ok: true, via: 'open', emailVerified: false }, 'ana@example.com', ['ana@example.com'], undefined), null);
  assert.equal(bootstrapOwnerGroup({ ok: false, reason: 'not-invited' }, 'ana@example.com', ['ana@example.com'], undefined), null);
  assert.equal(bootstrapOwnerGroup(ok, 'ana@example.com', ['ana@example.com'], []), null);
  assert.equal(bootstrapOwnerGroup(ok, 'ana@example.com', undefined, undefined), null);
});

test('config: admission, bootstrap owners and per-IdP constraints are validated and normalised', () => {
  const base = { instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' } };
  const cfg = (idp: Record<string, unknown>) => parseConfig(JSON.stringify({ ...base, idp: { issuer: 'https://a.example', clientId: 'c', ...idp } }));

  const ok = cfg({
    admission: { emails: [' Ana@Example.com '], domains: ['@Example.org'] }, bootstrapOwners: ['ANA@example.com'],
    hostedDomain: 'Example.com', emailVerification: 'claim', scopes: 'openid email', authParams: { prompt: 'select_account' },
    additional: [{ id: 'ms', issuer: 'https://b.example', clientId: 'c', displayName: 'MS', tenantId: '0F5D2A1E-1111-2222-3333-444455556666', emailVerification: 'trusted' }],
  });
  assert.deepEqual(ok.idp.admission, { emails: ['ana@example.com'], domains: ['example.org'] });
  assert.deepEqual(ok.idp.bootstrapOwners, ['ana@example.com']);
  assert.equal(ok.idp.hostedDomain, 'example.com');
  assert.deepEqual(ok.idp.scopes, ['openid', 'email']);
  assert.equal(ok.idp.additional[0]?.tenantId, '0f5d2a1e-1111-2222-3333-444455556666');
  assert.equal(ok.idp.additional[0]?.hostedDomain, undefined, 'constraints are never inherited');
  assert.deepEqual(cfg({}).idp.bootstrapOwners, []);
  assert.equal(cfg({}).idp.admission, undefined);

  assert.throws(() => cfg({ admission: { emails: ['not-an-email'] } }), /admission.emails/);
  assert.throws(() => cfg({ admission: { domains: ['not a domain'] } }), /admission.domains/);
  assert.throws(() => cfg({ admission: { invitations: 'yes' } }), /invitations/);
  assert.throws(() => cfg({ admission: { allow: [] } }), /not a known key/);
  assert.throws(() => cfg({ admission: [] }), /must be an object/);
  assert.throws(() => cfg({ bootstrapOwners: ['ana@example.com'], admission: { emails: ['bo@example.com'] } }), /not admitted/);
  assert.doesNotThrow(() => cfg({ bootstrapOwners: ['ana@example.com'], admission: { domains: ['example.com'] } }));
  assert.throws(() => cfg({ bootstrapOwners: ['ana@example.com'], roleGroups: { owner: [] } }), /owner group/);
  assert.throws(() => cfg({ hostedDomain: 'not a domain' }), /hostedDomain/);
  assert.throws(() => cfg({ tenantId: 'contoso' }), /tenantId/);
  assert.throws(() => cfg({ emailVerification: 'always' }), /emailVerification/);
  assert.throws(() => cfg({ scopes: ['profile', 'email'] }), /openid/);
  assert.throws(() => cfg({ scopes: ['openid', 'bad"scope'] }), /scopes/);
  assert.throws(() => cfg({ authParams: { redirect_uri: 'https://evil.test' } }), /not allowed/);
  assert.throws(() => cfg({ authParams: { prompt: 'a\nb' } }), /single-line/);
  assert.throws(() => cfg({ hostedDomain: 'example.com', authParams: { hd: 'other.com' } }), /differs/);
  assert.throws(() => parseConfig('{"instance":{"name":"X","baseUrl":"http://localhost","pack":"/tmp"},"idp":{"issuer":"https://a.example","clientId":"c","authParams":{"__proto__":{"prompt":"x"}}}}'), /not allowed/);
});

test('setup: production with an OIDC IdP and no admission policy warns (never fails); the generator carries the lists', async () => {
  const { startupChecks } = await import('../server/src/setup/checks.ts');
  const { generateSetup, setupDraft } = await import('../server/src/setup/configuration.ts');
  const secrets = { session: 'a'.repeat(32), link: 'b'.repeat(32) };
  const prod = (idp: Record<string, unknown>) => parseConfig(JSON.stringify({ deployment: { mode: 'production' },
    instance: { pack: '/tmp', baseUrl: 'https://work.test' }, idp: { issuer: 'https://idp.test', clientId: 'c', ...idp } }));
  const open = startupChecks(prod({}), secrets, true).find((c) => c.id === 'admission');
  assert.equal(open?.status, 'warning');
  assert.equal(startupChecks(prod({ admission: { domains: ['example.com'] } }), secrets, true).find((c) => c.id === 'admission')?.status, 'pass');
  assert.equal(startupChecks(prod({}), secrets, true, {}).some((c) => c.status === 'fail' && c.id === 'admission'), false);

  const current = parseConfig(JSON.stringify({ instance: { pack: '/tmp', baseUrl: 'http://localhost' }, dev: { enabled: true, users: [{ email: 'o@x.test', groups: ['owner'] }] } }));
  const draft = { ...setupDraft(current, ['owner']), authentication: 'oidc', issuer: 'https://idp.test', clientId: 'c',
    admissionEmails: ['Ana@Example.com'], admissionDomains: ['@team.example'], bootstrapOwners: ['ana@example.com'] };
  const proposal = generateSetup(draft, current);
  assert.deepEqual((proposal.patch.idp as Record<string, unknown>).admission, { emails: ['ana@example.com'], domains: ['team.example'] });
  assert.deepEqual((proposal.patch.idp as Record<string, unknown>).bootstrapOwners, ['ana@example.com']);
  assert.throws(() => generateSetup({ ...draft, bootstrapOwners: ['bo@else.test'] }, current), /not admitted/);
  assert.throws(() => generateSetup({ ...draft, admissionEmails: ['nope'] }, current), /email address/);
  const none = generateSetup({ ...draft, admissionEmails: [], admissionDomains: [], bootstrapOwners: [] }, current);
  assert.equal((none.patch.idp as Record<string, unknown>).admission, undefined, 'empty lists leave an open instance open');
});

test('setup: emptying both lists on an instance with a policy leaves invitations only, and the wizard says so', async () => {
  const { readFile } = await import('node:fs/promises');
  const { generateSetup, setupDraft } = await import('../server/src/setup/configuration.ts');
  const gated = parseConfig(JSON.stringify({ instance: { pack: '/tmp', baseUrl: 'http://localhost' }, idp: { admission: { domains: ['example.com'] } },
    dev: { enabled: true, users: [{ email: 'o@x.test', groups: ['owner'] }] } }));
  const cleared = generateSetup({ ...setupDraft(gated, ['owner']), admissionEmails: [], admissionDomains: [] }, gated);
  assert.deepEqual((cleared.patch.idp as Record<string, unknown>).admission, { emails: [], domains: [] }, 'not open: invitations only');
  const wizard = await readFile(new URL('../console/setup-wizard.js', import.meta.url), 'utf8');
  assert.ok(!wizard.includes('Leave both lists empty to admit everyone'), 'the wizard must not promise an open instance');
  assert.ok(wizard.includes('empty lists admit invited people only'));
});

test('setup: the admission fields keep old hashes and old setup files working, and report their own errors', async () => {
  const { createHash } = await import('node:crypto');
  const { generateSetup, setupDraft, setupSettingsHash, SetupInputError } = await import('../server/src/setup/configuration.ts');
  const current = parseConfig(JSON.stringify({ instance: { pack: '/tmp', baseUrl: 'http://localhost' }, dev: { enabled: true, users: [{ email: 'o@x.test', groups: ['owner'] }] } }));
  const fresh = setupDraft(current, ['owner']);

  // With no admission configured, the hash is the one computed before these fields existed.
  const { ownerTestGroups: _g, admissionEmails: _e, admissionDomains: _d, bootstrapOwners: _b, ...legacy } = fresh;
  assert.equal(setupSettingsHash(fresh), createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  assert.notEqual(setupSettingsHash({ ...fresh, admissionDomains: ['example.com'] }), setupSettingsHash(fresh), 'a set list does count');

  // A setup file downloaded before the upgrade carries none of the three keys.
  const legacyFile = { ...legacy, ownerTestGroups: ['owner'] };
  const proposal = generateSetup(legacyFile, current);
  assert.deepEqual(proposal.settings.admissionEmails, []);
  assert.equal(proposal.expectedSettingsHash, generateSetup({ ...fresh, ownerTestGroups: ['owner'] }, current).expectedSettingsHash);

  const fieldOf = (draft: Record<string, unknown>, cfg = current): string => {
    try { generateSetup(draft, cfg); } catch (error) { assert.ok(error instanceof SetupInputError); return (error as InstanceType<typeof SetupInputError>).field; }
    return 'none';
  };
  assert.equal(fieldOf({ ...fresh, admissionDomains: ['a..com'] }), 'admissionDomains', 'the config parser\'s domain rule, not a looser one');
  assert.equal(fieldOf({ ...fresh, admissionDomains: ['-corp.example'] }), 'admissionDomains');
  assert.equal(fieldOf({ ...fresh, admissionDomains: ['corp.example'] }), 'none');
  const ownerless = parseConfig(JSON.stringify({ instance: { pack: '/tmp', baseUrl: 'http://localhost' }, idp: { roleGroups: { owner: [] } },
    dev: { enabled: true, users: [{ email: 'o@x.test', groups: ['owner'] }] } }));
  assert.equal(fieldOf({ ...setupDraft(ownerless, []), admissionEmails: ['ana@example.com'], bootstrapOwners: ['ana@example.com'] }, ownerless), 'bootstrapOwners');
});
