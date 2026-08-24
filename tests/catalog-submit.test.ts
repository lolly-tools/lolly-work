/**
 * Catalog submit (plans/31 §3) over real HTTP - the pipeline that turns
 * "governs a DAM" into "replaces one".
 *
 * What this suite pins down is the order of the pipeline and the defaults of
 * record. Open to authors: anyone holding `catalog.submit` submits and the
 * asset is LIVE immediately, because an org buys review by naming
 * `policy.submit.chain`, not by having it forced on them. The pre-store scan
 * hook vetoes BEFORE any byte is stored, and its absence is a no-hook instance,
 * never a silent pass. A duplicate is reported, not refused. And a submission
 * under review is invisible everywhere a live asset is visible - the feed, the
 * blob route, and link minting - until it is approved.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { sniffBytes, quotaScopes, findByChecksum } from '../server/src/catalog/submit.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';
import type { AuditEvent } from '../server/src/audit/chain.ts';

const servers: Server[] = [];

/** A 1x1 PNG, real enough that the sniffer reads its IHDR. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><title>Mark</title></svg>');

interface Booted {
  base: string;
  store: ReturnType<typeof createMemoryStore>;
}

async function boot(overrides: Record<string, unknown> = {}): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-submit-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Submit Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'author2@test', groups: ['author', 'design'] },
      { email: 'viewer@test', groups: ['viewer'] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
    ...overrides,
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sS', link: 'lS' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

after(() => { for (const s of servers) s.close(); });

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

async function submit(
  base: string, cookie: string, bytes: Buffer, params: Record<string, string> = {}, contentType = 'image/png',
): Promise<Response> {
  const q = new URLSearchParams({ name: 'Campaign Hero', ...params });
  return fetch(`${base}/api/v1/catalog/submit?${q}`, {
    method: 'POST', headers: { cookie, 'content-type': contentType }, body: new Uint8Array(bytes),
  });
}

// ── the migration ───────────────────────────────────────────────────────────

test('migration 0017 is this stage’s only new file, and declares what the driver reads', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // One migration per stage, in the order plans/31 §11.5 claims them: submit
  // took 0017 and added nothing else between it and the instance assets of
  // 0016. Later stages append their own file; none may squeeze in behind this.
  const at = files.indexOf('0017_catalog_submissions.sql');
  assert.equal(files[at - 1], '0016_instance_assets.sql', '0017 follows 0016 with nothing between');
  const sql = await readFile(join(dir, '0017_catalog_submissions.sql'), 'utf8');

  // Both instance-asset columns are GENERATED from the jsonb record, which is
  // what stops the column and the record from ever disagreeing.
  assert.match(sql, /alter table instance_assets/);
  assert.match(sql, /submission_state text\s+generated always as \(record -> 'submission' ->> 'state'\) stored/);
  assert.match(sql, /submitted_by text\s+generated always as \(record -> 'submission' ->> 'by'\) stored/);
  assert.match(sql, /create index instance_assets_submission_state/);
  for (const col of ['scope', 'bytes', 'count', 'updated_at']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `catalog_submit_quota declares ${col}`);
  }
  assert.match(sql, /create table catalog_submit_quota/);
  // The runner wraps each file in its own transaction, so a file must not open
  // or close one itself.
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false);

  // The postgres driver reads exactly those quota columns.
  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into catalog_submit_quota \(scope, bytes, count, updated_at\)/);
});

// ── the sniffer, in isolation ───────────────────────────────────────────────

test('bytes are identified from the bytes, never from what the client claimed', () => {
  const png = sniffBytes(PNG, { contentType: 'text/html', filename: 'hero.html' });
  assert.equal(png.contentType, 'image/png');
  assert.equal(png.format, 'png');
  assert.deepEqual([png.width, png.height], [1, 1]);

  const svg = sniffBytes(SVG, { filename: 'mark.svg' });
  assert.equal(svg.contentType, 'image/svg+xml');
  assert.deepEqual([svg.width, svg.height], [48, 24]);

  const viewBoxOnly = sniffBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"/>'));
  assert.deepEqual([viewBoxOnly.width, viewBoxOnly.height], [200, 100]);

  // An unrecognized container keeps the extension for a readable URL but stays
  // honest about the type instead of echoing the client's word for it.
  const unknown = sniffBytes(Buffer.from('not a picture at all'), { contentType: 'image/png', filename: 'notes.txt' });
  assert.equal(unknown.contentType, 'application/octet-stream');
  assert.equal(unknown.format, 'txt');
});

test('quota scopes: every membership is charged, and a groupless member charges the instance row', () => {
  assert.deepEqual(quotaScopes(['design', 'author', 'design']), ['design', 'author']);
  assert.deepEqual(quotaScopes([]), ['*']);
});

test('duplicate detection sees a materialized asset, not only a previous submission', () => {
  const materialized = {
    id: 'inst/mat', createdAt: 'now', blobs: { png: 'inst/mat/png' },
    entry: { id: 'inst/mat', formats: [{ format: 'png', checksum: 'abc123' }] },
  };
  assert.equal(findByChecksum([materialized], 'abc123', [])?.id, 'inst/mat');
  assert.equal(findByChecksum([materialized], 'nope', []), undefined);

  // ...but only what the submitter could be handed anyway: a scoped asset they
  // are not in the groups for, and one still under review or already returned,
  // are all "not a duplicate" rather than an answer about someone else's file.
  const scoped = { ...materialized, id: 'inst/scoped', groups: ['design'] };
  assert.equal(findByChecksum([scoped], 'abc123', ['sales']), undefined);
  assert.equal(findByChecksum([scoped], 'abc123', ['design'])?.id, 'inst/scoped');
  for (const state of ['submitted', 'returned'] as const) {
    const pending = { ...materialized, id: `inst/${state}`, submission: { state, by: 'user:a', at: 'now', checksum: 'abc123', size: 1 } };
    assert.equal(findByChecksum([pending], 'abc123', []), undefined, `${state} bytes are not in the catalog`);
  }
});

// ── the default: open to authors, live immediately ──────────────────────────

test('an author submits and the asset is live: stored, sniffed, credential-scanned, in the feed, serving', async () => {
  const { base, store } = await boot();
  const author = await login(base, 'author@test');
  const res = await submit(base, author, PNG, { tags: 'campaign, hero', description: 'Q4 hero' });
  assert.equal(res.status, 201);
  const body = await res.json() as {
    assetId: string; state: string; duplicate: boolean; checksum: string; scan: string; credential: string; formats: string[];
  };
  assert.equal(body.state, 'live');
  assert.equal(body.duplicate, false);
  assert.equal(body.scan, 'absent', 'no hook configured is reported as absent, not as a clean scan');
  assert.equal(body.credential, 'none');
  assert.deepEqual(body.formats, ['png']);

  const rec = await store.getInstanceAsset(body.assetId);
  assert.equal(rec?.submission?.state, 'live');
  assert.match(rec?.submission?.by ?? '', /^user:/);
  assert.equal(rec?.submission?.checksum, body.checksum);
  assert.deepEqual([rec?.submission?.width, rec?.submission?.height], [1, 1]);
  assert.deepEqual(rec?.entry.tags, ['campaign', 'hero']);
  assert.equal(rec?.entry.description, 'Q4 hero');

  // Step 5: the detection row exists even though nothing was refused for it.
  assert.equal((await store.getCredential(body.assetId))?.status, 'none');
  // A lifecycle row is minted at go-live so the console's expire/hold controls
  // have something to act on from the first moment.
  assert.equal((await store.getLifecycle(body.assetId))?.onExpiry, 'hide');

  // In the feed, and serving its bytes.
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.some((a) => a.id === body.assetId), true);
  const blob = await fetch(`${base}/catalog/${body.assetId}/png`, { headers: { cookie: author } });
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await blob.arrayBuffer()).equals(PNG), true);

  const events = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.submit');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, `catalog:${body.assetId}`);
  assert.equal((events[0]?.payload as Record<string, unknown>).outcome, 'live');
  assert.equal((events[0]?.payload as Record<string, unknown>).scan, 'absent');
});

test('a submission that carries a Content Credential is detected and badged, and is never refused for it', async () => {
  // Minted end to end through the vendored engine, the same fixture the
  // detection unit test uses. The specifier is a non-literal for the reason
  // credentials.ts gives: a literal one drags the engine's browser-lib .ts
  // source into this project's typecheck program.
  const engineSpec: string = '@lolly/engine';
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Submit Root', organization: 'Submit', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as {
    publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1];
  };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 's@test.invalid', organization: 'Submit', days: 365 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'Submit Lolly');
  const { Resvg } = await import('@resvg/resvg-js');
  const plain = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#30ba78"/></svg>').render().asPng());
  const signed = Buffer.from(await eng.embedC2pa(plain, 'png', {
    signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain }, title: 'x', claimGenerator: 'Submit Lolly',
  }));

  const { base, store } = await boot();
  const author = await login(base, 'author@test');
  const res = await submit(base, author, signed, { name: 'Credentialed Photo' });
  // Detection only: unlike publish-out, no lolly export assertion is demanded
  // and nothing about the credential can refuse the submission.
  assert.equal(res.status, 201);
  const { assetId, credential } = await res.json() as { assetId: string; credential: string };
  assert.equal(credential, 'embedded');
  const row = await store.getCredential(assetId);
  assert.equal(row?.status, 'embedded');
  assert.equal(row?.container, 'png');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.find((a) => a.id === assetId)?.credential, 'embedded', 'badged in the feed');
});

test('a member without catalog.submit is refused, and a signed-out caller before that', async () => {
  const { base } = await boot();
  const viewer = await login(base, 'viewer@test');
  const refused = await submit(base, viewer, PNG);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  assert.equal((await fetch(`${base}/api/v1/catalog/submit?name=x`, { method: 'POST', body: new Uint8Array(PNG) })).status, 401);

  // The enabling half of the dormant OSS arm (plans/31 section 3): org-config
  // carries the bit, so the shell's "Submit to this instance" affordance can
  // light up later with no server change - and it is a real per-caller answer,
  // not a constant. A public build receives no org-config at all, so absence
  // still keeps the affordance dark there.
  const can = async (cookie: string): Promise<Record<string, boolean>> =>
    (await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json() as { can: Record<string, boolean> }).can;
  assert.equal((await can(await login(base, 'author@test')))['catalog.submit'], true);
  assert.equal((await can(viewer))['catalog.submit'], false);
});

test('the size cap is policy, and an empty or nameless submission never reaches the pipeline', async () => {
  const { base } = await boot({ policy: { submit: { maxBytes: 64 } } });
  const author = await login(base, 'author@test');
  const tooBig = await submit(base, author, Buffer.alloc(200, 7));
  assert.equal(tooBig.status, 413);
  assert.equal((await tooBig.json() as { error: { code: string } }).error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await submit(base, author, Buffer.alloc(0))).status, 400);
  const nameless = await fetch(`${base}/api/v1/catalog/submit`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG),
  });
  assert.equal(nameless.status, 400);
});

test('the per-group quota refuses once a group has spent it, and every membership is charged', async () => {
  const { base, store } = await boot({ policy: { submit: { quota: { bytes: 0, count: 1 } } } });
  const author = await login(base, 'author@test');
  assert.equal((await submit(base, author, PNG)).status, 201);
  // Both of the submitter's groups were charged, so either one being full
  // refuses the next submission.
  assert.equal((await store.getSubmitQuota('author'))?.count, 1);
  assert.equal((await store.getSubmitQuota('design'))?.count, 1);
  const second = await submit(base, author, SVG, { name: 'Mark' }, 'image/svg+xml');
  assert.equal(second.status, 409);
  const err = (await second.json() as { error: { code: string; message: string } }).error;
  assert.equal(err.code, 'QUOTA_EXCEEDED');
  assert.match(err.message, /group (author|design)/);
  // A colleague in the same groups is refused too: the budget belongs to the
  // group, not to the person.
  assert.equal((await submit(base, await login(base, 'author2@test'), SVG, { name: 'Mark' }, 'image/svg+xml')).status, 409);
  // The refusal is audited, since nothing was stored to hang the event off.
  const rejected = (await store.listAudit()).filter((e: AuditEvent) => e.subject === 'catalog:rejected');
  assert.equal(rejected.length, 2);
  assert.equal((rejected[0]?.payload as Record<string, unknown>).outcome, 'QUOTA_EXCEEDED');
});

test('a byte quota refuses on size rather than on count', async () => {
  const { base } = await boot({ policy: { submit: { quota: { bytes: PNG.length + 1, count: 0 } } } });
  const author = await login(base, 'author@test');
  assert.equal((await submit(base, author, PNG)).status, 201);
  assert.equal((await submit(base, author, PNG)).status, 409);
});

test('an exact duplicate is reported and short-circuits to the asset that already holds the bytes', async () => {
  const { base, store } = await boot();
  const author = await login(base, 'author@test');
  const first = await (await submit(base, author, PNG)).json() as { assetId: string };
  const again = await submit(base, author, PNG, { name: 'Same Bytes, Other Name' });
  assert.equal(again.status, 200, 'reported, never an error');
  const body = await again.json() as { assetId: string; duplicate: boolean; scan: string };
  assert.equal(body.duplicate, true);
  assert.equal(body.assetId, first.assetId);
  assert.equal(body.scan, 'skipped', 'nothing was stored, so nothing needed scanning');
  assert.equal((await store.listInstanceAssets()).length, 1, 'no second copy of the same bytes');
  // A duplicate stores nothing, so it charges nothing.
  assert.equal((await store.getSubmitQuota('design'))?.count, 1);
});

test('exposure can be narrowed to a group the submitter is in, and never to one they are not', async () => {
  const { base, store } = await boot();
  const author = await login(base, 'author@test');
  const scoped = await submit(base, author, PNG, { groups: 'design' });
  assert.equal(scoped.status, 201);
  const { assetId } = await scoped.json() as { assetId: string };
  assert.deepEqual((await store.getInstanceAsset(assetId))?.groups, ['design']);
  const outsider = await submit(base, author, SVG, { name: 'Mark', groups: 'finance' }, 'image/svg+xml');
  assert.equal(outsider.status, 403);
  // The design-scoped asset is not in an unrelated member's feed.
  const admin = await login(base, 'admin@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as AssetIndex;
  assert.equal(feed.assets?.some((a) => a.id === assetId), false);
});

// ── the pre-store scan hook ─────────────────────────────────────────────────

test('an exec hook that vetoes rejects the submission and stores nothing', async () => {
  const { base, store } = await boot({
    submit: { scanHook: { kind: 'exec', target: '/bin/sh', args: ['-c', 'cat > /dev/null; echo "Eicar-Test-Signature FOUND" >&2; exit 1'], timeoutMs: 5000, onError: 'reject' } },
  });
  const author = await login(base, 'author@test');
  const res = await submit(base, author, PNG);
  assert.equal(res.status, 422);
  const err = (await res.json() as { error: { code: string; message: string } }).error;
  assert.equal(err.code, 'SCAN_REJECTED');
  assert.match(err.message, /Eicar-Test-Signature FOUND/, "the hook's own words are the reason");
  assert.equal((await store.listInstanceAssets()).length, 0, 'a veto is PRE-store: nothing was written');
  assert.equal((await store.listSubmitQuota()).length, 0, 'and nothing was charged');
  const audited = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.submit');
  assert.equal((audited[0]?.payload as Record<string, unknown>).outcome, 'SCAN_REJECTED');
});

test('an exec hook that passes stores the asset and reports a clean scan', async () => {
  const { base } = await boot({
    submit: { scanHook: { kind: 'exec', target: '/bin/sh', args: ['-c', 'cat > /dev/null'], timeoutMs: 5000, onError: 'reject' } },
  });
  const res = await submit(base, await login(base, 'author@test'), PNG);
  assert.equal(res.status, 201);
  assert.equal((await res.json() as { scan: string }).scan, 'clean');
});

test('an http hook posts the bytes and treats any non-2xx as a veto carrying the response body', async () => {
  let seen: { sha: string | null; length: number } | null = null;
  const gateway = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen = { sha: (req.headers['x-lolly-submit-sha256'] as string) ?? null, length: Buffer.concat(chunks).length };
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked by the ICAP policy');
    });
  });
  servers.push(gateway);
  await new Promise<void>((r) => gateway.listen(0, () => r()));
  const port = (gateway.address() as { port: number }).port;

  const { base } = await boot({
    submit: { scanHook: { kind: 'http', target: `http://127.0.0.1:${port}/scan`, timeoutMs: 5000, onError: 'reject' } },
  });
  const res = await submit(base, await login(base, 'author@test'), PNG);
  assert.equal(res.status, 422);
  assert.match((await res.json() as { error: { message: string } }).error.message, /blocked by the ICAP policy/);
  assert.equal(seen!.length, PNG.length, 'the gateway got the bytes themselves');
  assert.equal(seen!.sha?.length, 64, 'and the content hash to key its own cache on');
});

test('a hook that cannot answer fails closed by default, and opens only when the operator says so', async () => {
  const dead = 'http://127.0.0.1:1/scan';
  const closed = await boot({ submit: { scanHook: { kind: 'http', target: dead, timeoutMs: 1000, onError: 'reject' } } });
  const refused = await submit(closed.base, await login(closed.base, 'author@test'), PNG);
  assert.equal(refused.status, 502);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'SCAN_UNAVAILABLE');
  assert.equal((await closed.store.listInstanceAssets()).length, 0);

  const open = await boot({ submit: { scanHook: { kind: 'http', target: dead, timeoutMs: 1000, onError: 'allow' } } });
  const allowed = await submit(open.base, await login(open.base, 'author@test'), PNG);
  assert.equal(allowed.status, 201);
  // Riding out the outage is the operator's call; MISREPORTING it is not. The
  // bytes went in unscanned, so neither the response nor the audit trail may
  // call that a clean scan - `absent` would be wrong too, since a hook IS
  // configured and simply could not answer.
  assert.equal((await allowed.json() as { scan: string }).scan, 'unavailable');
  const event = (await open.store.listAudit()).find((e: AuditEvent) => e.action === 'catalog.submit');
  assert.equal((event?.payload as Record<string, unknown>).scan, 'unavailable');
});

test('an unreachable exec hook is an unanswered scan, not a clean one', async () => {
  const { base } = await boot({
    submit: { scanHook: { kind: 'exec', target: '/nonexistent/clamdscan', timeoutMs: 2000, onError: 'reject' } },
  });
  const res = await submit(base, await login(base, 'author@test'), PNG);
  assert.equal(res.status, 502);

  // The same missing binary under `onError: 'allow'` stores the asset, and
  // still reports that nothing scanned it.
  const open = await boot({
    submit: { scanHook: { kind: 'exec', target: '/nonexistent/clamdscan', timeoutMs: 2000, onError: 'allow' } },
  });
  const allowed = await submit(open.base, await login(open.base, 'author@test'), PNG);
  assert.equal(allowed.status, 201);
  assert.equal((await allowed.json() as { scan: string }).scan, 'unavailable');
});

// ── with a chain: review before the catalog sees it ─────────────────────────

const CHAIN = {
  id: 'brand-review', name: 'Brand review',
  steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' as const }],
  onReject: 'return-to-submitter' as const,
};

async function bootWithChain(): Promise<Booted> {
  const booted = await boot({ policy: { submit: { chain: 'brand-review' } } });
  await booted.store.putChain(CHAIN);
  return booted;
}

test('with a chain configured the asset waits: no feed, no bytes, no link, and a queue row for the reviewer', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const res = await submit(base, author, PNG);
  assert.equal(res.status, 201);
  const { assetId, state, approvalId } = await res.json() as { assetId: string; state: string; approvalId: string };
  assert.equal(state, 'submitted');
  assert.ok(approvalId, 'an approval was opened with subject asset');
  const approval = await store.getApproval(approvalId);
  assert.equal(approval?.subjectType, 'asset');
  assert.equal(approval?.subjectRef, assetId);

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.some((a) => a.id === assetId), false, 'a pending submission is not in anyone’s feed');
  const blob = await fetch(`${base}/catalog/${assetId}/png`, { headers: { cookie: author } });
  assert.equal(blob.status, 403);
  assert.equal((await blob.json() as { error: { code: string } }).error.code, 'SUBMISSION_PENDING');
  const link = await fetch(`${base}/api/v1/links`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'share', target: { assetId } }),
  });
  assert.equal(link.status, 403, 'nothing to hand on until it is published');

  // The reviewer sees it in the queue and can preview the bytes; an unrelated
  // member sees neither.
  const brand = await login(base, 'brand@test');
  const queue = await (await fetch(`${base}/api/v1/catalog/submissions?state=submitted`, { headers: { cookie: brand } })).json() as {
    submissions: Array<{ id: string; relation: string; byName: string; width: number; preview: string }>;
  };
  assert.equal(queue.submissions.length, 1);
  assert.equal(queue.submissions[0]?.id, assetId);
  assert.equal(queue.submissions[0]?.relation, 'inbox');
  assert.equal(queue.submissions[0]?.width, 1);
  const preview = await fetch(`${base}${queue.submissions[0]?.preview}`, { headers: { cookie: brand } });
  assert.equal(preview.status, 200);
  assert.equal(Buffer.from(await preview.arrayBuffer()).equals(PNG), true);

  const admin = await login(base, 'admin@test');
  const other = await (await fetch(`${base}/api/v1/catalog/submissions`, { headers: { cookie: admin } })).json() as { submissions: unknown[] };
  assert.equal(other.submissions.length, 0, 'not their submission and not their step');
  assert.equal((await fetch(`${base}${queue.submissions[0]?.preview}`, { headers: { cookie: admin } })).status, 403);

  // The submitter sees their own row whatever the step says.
  const mine = await (await fetch(`${base}/api/v1/catalog/submissions`, { headers: { cookie: author } })).json() as {
    submissions: Array<{ relation: string }>;
  };
  assert.equal(mine.submissions[0]?.relation, 'mine');
});

test('approving from the review queue publishes the asset and tells the submitter', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG)).json() as { assetId: string };
  const short = assetId.slice('inst/'.length);

  // Separation of duties is the approvals engine's, and it still holds here.
  const bySubmitter = await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(bySubmitter.status, 403);
  assert.equal((await bySubmitter.json() as { error: { code: string } }).error.code, 'SEPARATION_OF_DUTIES');

  const brand = await login(base, 'brand@test');
  const acted = await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', comment: 'on brand' }),
  });
  assert.equal(acted.status, 200);
  assert.equal((await acted.json() as { state: string }).state, 'live');

  assert.equal((await store.getInstanceAsset(assetId))?.submission?.state, 'live');
  assert.equal((await store.getLifecycle(assetId))?.onExpiry, 'hide');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.some((a) => a.id === assetId), true);
  assert.equal((await fetch(`${base}/catalog/${assetId}/png`, { headers: { cookie: author } })).status, 200);

  const audited = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.approve-submission');
  assert.equal(audited.length, 1);
  assert.equal(audited[0]?.subject, `catalog:${assetId}`);
  // One message to the submitter, on an existing system kind.
  const msgs = (await store.listMessages()).filter((m) => m.data?.assetId === assetId);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]?.kind, 'approval');
  assert.match(msgs[0]?.title ?? '', /^Published/);

  // Settled once: a second act is refused rather than re-publishing.
  const again = await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(again.status, 409);
});

test('rejecting returns the submission with the comment, and it never becomes servable', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG)).json() as { assetId: string };
  const brand = await login(base, 'brand@test');
  const acted = await fetch(`${base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', comment: 'wrong logo lockup' }),
  });
  assert.equal(acted.status, 200);
  assert.equal((await acted.json() as { state: string }).state, 'returned');

  const rec = await store.getInstanceAsset(assetId);
  assert.equal(rec?.submission?.state, 'returned');
  assert.equal(rec?.submission?.comment, 'wrong logo lockup');
  assert.equal(await store.getLifecycle(assetId), null, 'no lifecycle row: it never went live');
  assert.equal((await fetch(`${base}/catalog/${assetId}/png`, { headers: { cookie: author } })).status, 403);
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.some((a) => a.id === assetId), false);

  const audited = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.return-submission');
  assert.equal(audited.length, 1);
  assert.equal((audited[0]?.payload as Record<string, unknown>).comment, 'wrong logo lockup');
  const msgs = (await store.listMessages()).filter((m) => m.data?.assetId === assetId);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0]?.body ?? '', /wrong logo lockup/);
});

test('deciding from the plain approvals inbox settles the asset too, and does not double up the message', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId, approvalId } = await (await submit(base, author, PNG)).json() as { assetId: string; approvalId: string };
  const brand = await login(base, 'brand@test');
  const acted = await fetch(`${base}/api/v1/approvals/${approvalId}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(acted.status, 200);
  assert.equal((await store.getInstanceAsset(assetId))?.submission?.state, 'live');
  const msgs = (await store.listMessages()).filter((m) => m.audience.users?.length);
  assert.equal(msgs.length, 1, 'the submission message replaces the generic approval one');
  assert.match(msgs[0]?.title ?? '', /^Published/);
});

test('withdrawing the review returns the asset rather than stranding it', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId, approvalId } = await (await submit(base, author, PNG)).json() as { assetId: string; approvalId: string };
  const withdrawn = await fetch(`${base}/api/v1/approvals/${approvalId}/withdraw`, { method: 'POST', headers: { cookie: author } });
  assert.equal(withdrawn.status, 200);
  assert.equal((await store.getInstanceAsset(assetId))?.submission?.state, 'returned');
});

// ── metadata edit before approval ───────────────────────────────────────────

async function edit(base: string, cookie: string, assetId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('a reviewer fixes the declared metadata before approving, and the published asset carries the fix', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG, { tags: 'campain', description: 'Q4 hero' })).json() as { assetId: string };
  const brand = await login(base, 'brand@test');

  const patched = await edit(base, brand, assetId, { name: 'Campaign Hero 2026', tags: ['campaign', 'hero', 'campaign'], type: 'photo' });
  assert.equal(patched.status, 200);
  const view = (await patched.json() as { submission: { name: string; tags: string[]; type: string; relation: string } }).submission;
  assert.equal(view.name, 'Campaign Hero 2026');
  assert.deepEqual(view.tags, ['campaign', 'hero'], 'duplicates collapse');
  assert.equal(view.relation, 'inbox');

  // The bytes, the submitter and the state are untouched: this is a metadata
  // correction, not a resubmission.
  const rec = await store.getInstanceAsset(assetId);
  assert.equal(rec?.submission?.state, 'submitted');
  assert.match(rec?.submission?.by ?? '', /^user:/);
  assert.equal(rec?.entry.description, 'Q4 hero', 'an untouched field stays put');
  assert.equal(rec?.entry.type, 'photo');

  const audited = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.edit-submission');
  assert.equal(audited.length, 1);
  const payload = audited[0]?.payload as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.equal(payload.before.name, 'Campaign Hero');
  assert.deepEqual(payload.before.tags, ['campain']);
  assert.equal(payload.after.name, 'Campaign Hero 2026');

  // Publishing carries the corrected metadata into the feed.
  await fetch(`${base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  assert.equal(feed.assets?.find((a) => a.id === assetId)?.name, 'Campaign Hero 2026');
});

test('the submitter may correct their own pending submission; a stranger may not, and a description clears', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG, { description: 'typo hear' })).json() as { assetId: string };

  const mine = await edit(base, author, assetId, { description: '' });
  assert.equal(mine.status, 200);
  assert.equal((await store.getInstanceAsset(assetId))?.entry.description, undefined, 'an emptied description is removed, not stored blank');

  // Neither on their step nor their submission: the same rule the queue and the
  // preview use, so the three cannot disagree about who may look.
  const admin = await login(base, 'admin@test');
  assert.equal((await edit(base, admin, assetId, { name: 'Mine now' })).status, 403);
  assert.equal((await store.getInstanceAsset(assetId))?.entry.name, 'Campaign Hero');
});

test('the edit refuses an empty name, an unknown field alone, and anything already settled', async () => {
  const { base } = await bootWithChain();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG)).json() as { assetId: string };

  assert.equal((await edit(base, author, assetId, { name: '   ' })).status, 400);
  assert.equal((await edit(base, author, assetId, { groups: ['brand'] })).status, 400, 'exposure is not editable here');
  assert.equal((await edit(base, author, assetId, { type: 'not a slug' })).status, 400);

  const brand = await login(base, 'brand@test');
  await fetch(`${base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  const settled = await edit(base, brand, assetId, { name: 'Too late' });
  assert.equal(settled.status, 409);
  assert.equal((await settled.json() as { error: { code: string } }).error.code, 'ALREADY_SETTLED');
});

test('a chain id that names nothing REFUSES the submission: review an org bought never silently turns off', async () => {
  const { base, store } = await boot({ policy: { submit: { chain: 'no-such-chain' } } });
  const res = await submit(base, await login(base, 'author@test'), PNG);
  // `policy.submit.chain` lives in instance.json while chains are seeded from
  // the policy document, so the two can drift on a rename or a first boot. The
  // fail-open reading of that drift is open publishing with nothing in the
  // audit trail saying review stopped happening, so it fails closed instead.
  assert.equal(res.status, 503);
  const err = (await res.json() as { error: { code: string; message: string } }).error;
  assert.equal(err.code, 'SUBMIT_CHAIN_MISSING');
  assert.match(err.message, /no-such-chain/, 'the refusal names the chain the operator has to fix');
  // Nothing was taken: no asset, no blob, and no quota charged for the attempt.
  assert.equal((await store.listInstanceAssets()).length, 0);
  assert.equal(await store.getSubmitQuota('design'), null);
  const rejected = (await store.listAudit()).filter((e: AuditEvent) => e.subject === 'catalog:rejected');
  assert.equal((rejected[0]?.payload as Record<string, unknown>).outcome, 'SUBMIT_CHAIN_MISSING');
});

// ── what a submitter's bytes may and may not do ─────────────────────────────

/** An SVG is markup, not a picture: it can carry script, and the sniffer types
 *  it honestly rather than lying about what was stored. */
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
  '<script>fetch("/api/v1/grants")</script></svg>');

test('submitted bytes are served INERT: no script, whoever opens them and however they got the URL', async () => {
  const { base } = await boot();
  const author = await login(base, 'author@test');
  const res = await submit(base, author, HOSTILE_SVG, { name: 'Mark' }, 'image/svg+xml');
  assert.equal(res.status, 201);
  const { assetId } = await res.json() as { assetId: string };

  // The console is on this origin, so a document a member uploaded must never
  // run as the person who opens it. The bytes are stored and typed honestly;
  // what changes is the posture they are handed over in.
  const inert = (r: Response, where: string): void => {
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /sandbox/, `${where} sandboxes the document into an opaque origin`);
    assert.match(csp, /default-src 'none'/, `${where} leaves it no script`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', where);
  };

  const blob = await fetch(`${base}/catalog/${assetId}/svg`, { headers: { cookie: author } });
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get('content-type'), 'image/svg+xml');
  inert(blob, 'the instance blob route');

  const preview = await fetch(`${base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}/bytes`, {
    headers: { cookie: author },
  });
  assert.equal(preview.status, 200);
  inert(preview, "the reviewer's preview");

  // The share link is the surface that matters most: an UNAUTHENTICATED bearer
  // reaches it, and the person the link is sent to is often an admin.
  const minted = await fetch(`${base}/api/v1/links`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'share', target: { assetId, format: 'svg' } }),
  });
  assert.equal(minted.status, 201);
  const { url } = await minted.json() as { url: string };
  const shared = await fetch(url.replace('http://localhost', base));
  assert.equal(shared.status, 200);
  inert(shared, 'the signed link');
});

test('a revoked submission stops serving on the reviewer preview too, not only at /catalog/*', async () => {
  const { base } = await boot();
  const author = await login(base, 'author@test');
  const { assetId } = await (await submit(base, author, PNG)).json() as { assetId: string };
  const short = assetId.slice('inst/'.length);
  assert.equal((await fetch(`${base}/api/v1/catalog/submissions/${short}/bytes`, { headers: { cookie: author } })).status, 200);

  const admin = await login(base, 'admin@test');
  const revoked = await fetch(`${base}/api/v1/catalog/lifecycle/${assetId}`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ revoke: true }),
  });
  assert.equal(revoked.status, 200);

  // Revocation is the product's stop-sharing primitive, so it has to stop every
  // surface that hands the bytes out - including the one the submitter keeps.
  assert.equal((await fetch(`${base}/catalog/${assetId}/png`, { headers: { cookie: author } })).status, 410);
  for (const [who, cookie] of [['the submitter', author], ['another member', admin]] as const) {
    const res = await fetch(`${base}/api/v1/catalog/submissions/${short}/bytes`, { headers: { cookie } });
    assert.equal(res.status, 410, `${who} is refused the revoked bytes`);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'ASSET_EXPIRED');
  }
});

test('the duplicate short-circuit only ever reports an asset the submitter could already see', async () => {
  const { base, store } = await boot();
  const author = await login(base, 'author@test');
  const scoped = await (await submit(base, author, PNG, { groups: 'design' })).json() as { assetId: string };

  // The admin is not in `design`, so this asset is invisible to them - the feed
  // does not carry it and its bytes 403. A checksum hit must not become the one
  // surface that confirms the instance holds this exact file, nor hand back its
  // id: that is a confirmed-file oracle, and free to run, since a duplicate is
  // charged no quota and invokes no scan hook.
  const admin = await login(base, 'admin@test');
  assert.equal((await fetch(`${base}/catalog/${scoped.assetId}/png`, { headers: { cookie: admin } })).status, 403);
  const theirs = await submit(base, admin, PNG, { name: 'Same Bytes' });
  assert.equal(theirs.status, 201, 'a second copy is the honest outcome');
  const body = await theirs.json() as { assetId: string; duplicate: boolean };
  assert.equal(body.duplicate, false);
  assert.notEqual(body.assetId, scoped.assetId);
  assert.equal((await store.listInstanceAssets()).length, 2);

  // A colleague who IS in design gets the real short-circuit.
  const author2 = await login(base, 'author2@test');
  const dupe = await submit(base, author2, PNG, { name: 'Same Bytes Again' });
  assert.equal(dupe.status, 200);
  assert.equal((await dupe.json() as { assetId: string }).assetId, scoped.assetId);
});

test('bytes a reviewer returned do not block anyone resubmitting them', async () => {
  const { base, store } = await bootWithChain();
  const author = await login(base, 'author@test');
  const first = await (await submit(base, author, PNG)).json() as { assetId: string };
  const brand = await login(base, 'brand@test');
  const decided = await fetch(`${base}/api/v1/catalog/submissions/${first.assetId.slice('inst/'.length)}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', comment: 'wrong lockup' }),
  });
  assert.equal(decided.status, 200);
  assert.equal((await store.getInstanceAsset(first.assetId))?.submission?.state, 'returned');

  // A rejected file is not "already in the catalog": short-circuiting onto it
  // would drop the new submission silently and make those exact bytes
  // permanently unpublishable, since a settled approval cannot be re-decided.
  const again = await submit(base, author, PNG);
  assert.equal(again.status, 201);
  const body = await again.json() as { assetId: string; duplicate: boolean; state: string };
  assert.equal(body.duplicate, false);
  assert.notEqual(body.assetId, first.assetId);
  assert.equal(body.state, 'submitted');
});

test('the quota holds under concurrency: the charge is the check, not a read taken earlier', async () => {
  // A hook that answers slowly widens the window this test is about: the
  // scanner, the duplicate lookup and the blob put all sit between a read-first
  // check and the write it was meant to protect, and every concurrent
  // submission passes the same stale read.
  const gateway = createServer((req, res) => {
    req.on('data', () => { /* drain */ });
    req.on('end', () => setTimeout(() => { res.writeHead(200); res.end('clean'); }, 40));
  });
  servers.push(gateway);
  await new Promise<void>((r) => gateway.listen(0, () => r()));
  const port = (gateway.address() as { port: number }).port;

  const { base, store } = await boot({
    policy: { submit: { quota: { bytes: 0, count: 3 } } },
    submit: { scanHook: { kind: 'http', target: `http://127.0.0.1:${port}/scan`, timeoutMs: 5000, onError: 'allow' } },
  });
  const author = await login(base, 'author@test');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    submit(base, author, Buffer.from(`distinct bytes ${i} ${'x'.repeat(i)}`), { name: `file-${i}.bin` }, 'application/octet-stream')));
  const accepted = results.filter((r) => r.status === 201).length;
  assert.ok(accepted >= 1, 'someone got through');
  assert.ok(accepted <= 3, `the cap of 3 held: ${accepted} submissions were accepted`);
  assert.equal(results.filter((r) => r.status === 409).length, 12 - accepted, 'everyone else was told the quota is spent');
  assert.equal((await store.listInstanceAssets()).length, accepted, 'nothing was stored past the cap');
  // A refused submission releases the charge it made, so the counters read what
  // was actually kept rather than what was attempted.
  assert.equal((await store.getSubmitQuota('design'))?.count, accepted);
  assert.equal((await store.getSubmitQuota('author'))?.count, accepted);
});

test('a name the submitter chose can never decide whether the scanner runs', async () => {
  let invocations = 0;
  let sawFilename: string | null = null;
  const gateway = createServer((req, res) => {
    invocations += 1;
    sawFilename = (req.headers['x-lolly-submit-filename'] as string) ?? null;
    req.on('data', () => { /* drain */ });
    req.on('end', () => { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('VIRUS FOUND'); });
  });
  servers.push(gateway);
  await new Promise<void>((r) => gateway.listen(0, () => r()));
  const port = (gateway.address() as { port: number }).port;

  // `onError: 'allow'` is the operator riding out an outage; it must not become
  // an opt-out the submitter can trigger. A header value is a ByteString, so a
  // single character above U+00FF once threw while the request was being built,
  // which read as an unanswered scan and let the bytes straight through.
  const { base, store } = await boot({
    submit: { scanHook: { kind: 'http', target: `http://127.0.0.1:${port}/scan`, timeoutMs: 5000, onError: 'allow' } },
  });
  const author = await login(base, 'author@test');
  const res = await submit(base, author, PNG, { name: 'マルウェア.bin' });
  assert.equal(res.status, 422);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'SCAN_REJECTED');
  assert.equal(invocations, 1, 'the scanner was asked');
  assert.equal(decodeURIComponent(sawFilename as unknown as string), 'マルウェア.bin', 'and told the real name, encoded');
  assert.equal((await store.listInstanceAssets()).length, 0);
});
