import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, loadSecrets, parseAutoMigrate } from '../server/src/config/instance.ts';

test('defaults merge under a partial config', () => {
  const cfg = parseConfig(JSON.stringify({ instance: { name: 'Test Hub' }, dev: { enabled: true, users: [] } }));
  assert.equal(cfg.instance.name, 'Test Hub');
  assert.equal(cfg.policy.defaultAccessMode, 'gated');
  assert.equal(cfg.policy.telemetryAttribution, 'opt-in');
  assert.equal(cfg.idp.claimMap.firstname, 'given_name');
  assert.equal(cfg.delivery.maxBytes, 64 * 1024 * 1024);
  assert.deepEqual(cfg.delivery.destinations, []);
});

test('gated without an IdP or dev provider is rejected', () => {
  assert.throws(() => parseConfig(JSON.stringify({})), /gated access needs idp.issuer/);
  assert.throws(() => parseConfig(JSON.stringify({ policy: { telemetry: 'loud' }, dev: { enabled: true } })), /invalid telemetry/);
  // open mode needs neither
  const open = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } }));
  assert.equal(open.policy.defaultAccessMode, 'open');
});

test('sessionTtlHours: defaults to 12, overridable per-policy, bounds enforced', () => {
  assert.equal(parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } })).policy.sessionTtlHours, 12);
  // A partial policy override keeps the other policy defaults (deep merge).
  const over = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', sessionTtlHours: 8 } }));
  assert.equal(over.policy.sessionTtlHours, 8);
  assert.equal(over.policy.telemetryAttribution, 'opt-in');
  assert.equal(over.policy.guestLinks.defaultTtlHours, 72);
  // Footgun configs are rejected at boot rather than minting broken cookies.
  for (const bad of [0, -1, 1000]) {
    assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', sessionTtlHours: bad } })), /invalid sessionTtlHours/);
  }
});

test('parseAutoMigrate: unset defaults on; explicit off values turn it off', () => {
  assert.equal(parseAutoMigrate({} as NodeJS.ProcessEnv), true); // unset ⇒ single-node default
  for (const v of ['false', '0', 'off', 'no', '', '  Off ']) {
    assert.equal(parseAutoMigrate({ LW_AUTO_MIGRATE: v } as NodeJS.ProcessEnv), false, `"${v}" ⇒ off`);
  }
  for (const v of ['true', '1', 'yes', 'on']) {
    assert.equal(parseAutoMigrate({ LW_AUTO_MIGRATE: v } as NodeJS.ProcessEnv), true, `"${v}" ⇒ on`);
  }
});

test('rateLimit: deep-merges defaults; a partial override keeps the rest', () => {
  const d = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } })).rateLimit;
  assert.equal(d.enabled, true);
  assert.equal(d.auth.capacity, 10);
  const over = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' }, rateLimit: { auth: { capacity: 3, refillPerSec: 0.5 } } })).rateLimit;
  assert.equal(over.auth.capacity, 3);
  assert.equal(over.telemetry.capacity, 120); // untouched default survives
  assert.equal(over.automation.capacity, 120);
  assert.equal(over.enabled, true);
  assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' }, rateLimit: { auth: { capacity: 0, refillPerSec: 1 } } })), /rateLimit\.auth/);
});

test('secrets: required in production, ephemeral in dev', () => {
  assert.throws(() => loadSecrets({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /LW_SESSION_SECRET/);
  const dev = loadSecrets({} as NodeJS.ProcessEnv);
  assert.ok(dev.session.startsWith('dev-only-'));
  const prod = loadSecrets({ NODE_ENV: 'production', LW_SESSION_SECRET: 'a', LW_LINK_SECRET: 'b' } as NodeJS.ProcessEnv);
  assert.deepEqual([prod.session, prod.link], ['a', 'b']);
});

test('delivery destinations are explicit, normalized, and fail closed at config parse', () => {
  const base = { policy: { defaultAccessMode: 'open' } };
  const valid = {
    id: 'campaign-archive', kind: 's3', label: 'Campaign archive', credentialRef: 'LW_DESTINATION_ARCHIVE',
    enabled: true, groups: ['brand'], formats: ['PNG', 'png', 'PDF-CMYK'],
    options: { bucket: 'output', endpoint: 'https://objects.example', prefix: 'approved' },
  };
  const parsed = parseConfig(JSON.stringify({ ...base, delivery: { destinations: [valid] } }));
  assert.deepEqual(parsed.delivery.destinations[0]?.formats, ['png', 'pdf-cmyk']);
  assert.equal(parseConfig(JSON.stringify({ ...base, delivery: { destinations: [{
    ...valid, approvalChain: 'brand-review',
  }] } })).delivery.destinations[0]?.approvalChain, 'brand-review');
  for (const [destination, message] of [
    [{ ...valid, id: '../escape' }, /invalid delivery destination id/],
    [{ ...valid, kind: 'ftp' }, /unknown delivery destination kind/],
    [{ ...valid, credentialRef: '' }, /needs credentialRef/],
    [{ ...valid, formats: [] }, /formats allowlist/],
    [{ ...valid, options: {} }, /needs options\.bucket/],
    [{ ...valid, approvalChain: '../review' }, /invalid delivery destination .* approvalChain/],
    [{ ...valid, options: { bucket: 'x', endpoint: 'file:\/\/\/tmp' } }, /must be an http\(s\) URL/],
  ] as const) {
    assert.throws(() => parseConfig(JSON.stringify({ ...base, delivery: { destinations: [destination] } })), message);
  }
  assert.throws(() => parseConfig(JSON.stringify({ ...base, delivery: { maxBytes: 0 } })), /invalid delivery\.maxBytes/);

  const webdav = parseConfig(JSON.stringify({ ...base, delivery: { destinations: [{
    ...valid, id: 'team-dav', kind: 'webdav',
    options: { url: 'https://cloud.example/remote.php/dav/files/team/outgoing', prefix: 'approved' },
  }] } }));
  assert.equal(webdav.delivery.destinations[0]?.kind, 'webdav');
  const https = parseConfig(JSON.stringify({ ...base, delivery: { destinations: [{
    ...valid, id: 'publisher', kind: 'https', options: { url: 'https://publisher.example/lolly' },
  }] } }));
  assert.equal(https.delivery.destinations[0]?.kind, 'https');
  for (const [destination, message] of [
    [{ ...valid, id: 'bad-dav', kind: 'webdav', options: {} }, /needs options\.url/],
    [{ ...valid, id: 'dav-query', kind: 'webdav', options: { url: 'https:\/\/cloud.example\/dav?token=secret' } }, /without credentials, query or fragment/],
    [{ ...valid, id: 'plain-http', kind: 'https', options: { url: 'http:\/\/publisher.example\/lolly' } }, /must be an HTTPS URL/],
  ] as const) {
    assert.throws(() => parseConfig(JSON.stringify({ ...base, delivery: { destinations: [destination] } })), message);
  }
});

test('instance.homeView: absent by default, tools or projects when set, anything else refused', () => {
  const open = { policy: { defaultAccessMode: 'open' } };
  assert.equal(parseConfig(JSON.stringify(open)).instance.homeView, undefined);
  for (const view of ['tools', 'projects'] as const) {
    assert.equal(parseConfig(JSON.stringify({ ...open, instance: { homeView: view } })).instance.homeView, view);
  }
  for (const bad of ['gallery', 'Projects', '', null, 1, ['projects']]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...open, instance: { homeView: bad } })), /instance\.homeView must be "tools" or "projects"/);
  }
});

// ── invitations and access requests (plans/74 invite spec 2.5) ─────────────
const openCfg = (over: Record<string, unknown>) => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' }, ...over }));

test("lolly.ing's invite and request settings parse as written (decisions D1 to D3)", () => {
  const cfg = parseConfig(JSON.stringify({
    instance: { name: 'lolly.ing', inviteNote: 'If your organisation blocks Google sign-in (for example @suse.com), use GitHub or email and password.' },
    policy: {
      defaultAccessMode: 'open',
      invites: { passwordDomains: ['suse.com'] },
      requests: { join: true, project: true, ttlDays: 14, joinOpenMax: 50 },
    },
  }));
  assert.equal(cfg.instance.name, 'lolly.ing');
  assert.match(cfg.instance.inviteNote ?? '', /^If your organisation blocks Google sign-in/);
  assert.deepEqual(cfg.policy.invites?.passwordDomains, ['suse.com']);
  assert.deepEqual(cfg.policy.requests, { join: true, project: true, ttlDays: 14, joinOpenMax: 50 });
});

test('policy.requests: project requests on and join requests off by default, partial overrides merge, bounds enforced', () => {
  assert.deepEqual(openCfg({}).policy.requests, { join: false, project: true, ttlDays: 14, joinOpenMax: 50 });
  assert.deepEqual(openCfg({ policy: { defaultAccessMode: 'open', requests: { join: true } } }).policy.requests,
    { join: true, project: true, ttlDays: 14, joinOpenMax: 50 });
  const bad = (requests: unknown) => () => openCfg({ policy: { defaultAccessMode: 'open', requests } });
  assert.throws(bad({ join: 'yes' }), /policy\.requests\.join/);
  assert.throws(bad({ project: 1 }), /policy\.requests\.project/);
  for (const ttlDays of [0, 61, 1.5, '14']) assert.throws(bad({ ttlDays }), /policy\.requests\.ttlDays/, String(ttlDays));
  for (const joinOpenMax of [0, 1001, 2.5]) assert.throws(bad({ joinOpenMax }), /policy\.requests\.joinOpenMax/, String(joinOpenMax));
  assert.throws(bad({ ttl: 3 }), /policy\.requests\.ttl is not a known key/);
  assert.throws(bad([]), /policy\.requests must be an object/);
  assert.equal(openCfg({ policy: { defaultAccessMode: 'open', requests: { ttlDays: 60, joinOpenMax: 1000 } } }).policy.requests.ttlDays, 60);
});

test('instance.inviteNote: one trimmed line of at most 240 characters; blank means none', () => {
  assert.equal(openCfg({}).instance.inviteNote, undefined);
  assert.equal(openCfg({ instance: { inviteNote: '  Use GitHub.  ' } }).instance.inviteNote, 'Use GitHub.');
  assert.equal('inviteNote' in openCfg({ instance: { inviteNote: '   ' } }).instance, false);
  assert.equal(openCfg({ instance: { inviteNote: 'x'.repeat(240) } }).instance.inviteNote?.length, 240);
  assert.throws(() => openCfg({ instance: { inviteNote: 'x'.repeat(241) } }), /instance\.inviteNote/);
  for (const note of ['two\nlines', 'a\r\nb', 'tab\there', 'sep arator']) {
    assert.throws(() => openCfg({ instance: { inviteNote: note } }), /instance\.inviteNote/, JSON.stringify(note));
  }
  assert.throws(() => openCfg({ instance: { inviteNote: 42 } }), /instance\.inviteNote/);
});

test('policy.invites.passwordDomains follows the domains rule and defaults to none', async () => {
  const { resolveInvitePolicy } = await import('../server/src/policy/invites.ts');
  assert.deepEqual(resolveInvitePolicy(undefined).passwordDomains, []);
  const cfg = openCfg({ policy: { defaultAccessMode: 'open', invites: { passwordDomains: [' @SUSE.com ', 'suse.com', 'partner.example'] } } });
  assert.deepEqual(cfg.policy.invites?.passwordDomains, ['suse.com', 'partner.example'], 'lowercased, "@" dropped, de-duplicated');
  assert.deepEqual(resolveInvitePolicy(cfg.policy.invites).passwordDomains, ['suse.com', 'partner.example']);
  assert.deepEqual(resolveInvitePolicy(cfg.policy.invites).domains, [], 'the admission domains are a separate list');
  assert.throws(() => openCfg({ policy: { defaultAccessMode: 'open', invites: { passwordDomains: ['not a domain'] } } }), /policy\.invites\.passwordDomains/);
  assert.throws(() => openCfg({ policy: { defaultAccessMode: 'open', invites: { passwordDomains: 'suse.com' } } }), /policy\.invites\.passwordDomains/);
});
