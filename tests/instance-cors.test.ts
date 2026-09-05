/**
 * Cross-origin reads of the two connect routes (OSS plans/186 section 3.6).
 *
 * A person on the open source client - lolly.tools, or a desktop shell, or any
 * other origin - adds a hosted design system by pasting this instance's URL.
 * Their browser fetches `GET /api/v1/instance` and then, when the instance is
 * open, `GET /connect/pack.lolly` with an `If-None-Match` for the copy it
 * already keeps. Both of those are cross-origin reads, so the headers are the
 * feature: without them the client sees a network error and cannot say why.
 *
 * Three properties are pinned. The manifest is readable from anywhere, because
 * it is already unauthenticated and secret-free. The pack follows its own
 * access gate: wildcard plus an exposed `ETag` on an open instance, and NOT ONE
 * CORS header on a gated one, since a page on another origin cannot present the
 * session cookie and a wildcard with credentials is refused by browsers. And
 * the preflight answers on both paths, because a conditional GET carries
 * `If-None-Match`, which is not a header a browser will send unasked.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const BASE_URL = 'http://cors.example';
/** Some other origin entirely - deliberately not localhost, which the dev-only
 *  CORS layer answers for its own reasons (a Vite shell on another port). */
const ELSEWHERE = { origin: 'https://lolly.tools' };

async function boot(accessMode: 'open' | 'gated'): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), `lw-cors-${accessMode}-`));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'CORS Hub', baseUrl: BASE_URL, pack },
    rateLimit: { enabled: false },
    policy: { defaultAccessMode: accessMode },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'member@test', groups: ['marketing'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sCO', link: 'lCO' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** A minimal pack for THIS deployment, in the shape `inspectInstancePack` takes. */
function packBytes(): Buffer {
  const zb = new ZipBuilder(new Date('2026-09-04T00:00:00Z'));
  const entries: Record<string, string> = {
    'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
    'instance.json': JSON.stringify({ kind: 'instance', name: 'CORS Hub', publisher: 'Acme', version: '1.0.0', instance: BASE_URL }),
    'tokens.json': '{}',
    'pack.sig': 'sig-bytes',
  };
  const parts = Object.entries(entries).map(([name, body]) => zb.add(name, Buffer.from(body)));
  parts.push(zb.end());
  return Buffer.concat(parts);
}

async function hostPack(base: string): Promise<void> {
  const owner = await login(base, 'owner@test');
  const res = await fetch(`${base}/api/v1/instance-pack`, {
    method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(packBytes()),
  });
  assert.equal(res.status, 200);
}

/** Every CORS header on one response, so a "carries none" assertion can name
 *  what it found instead of listing the four it checked. */
const corsOf = (res: Response): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const [name, value] of res.headers) if (name.startsWith('access-control-')) found[name] = value;
  return found;
};

// ── the manifest ─────────────────────────────────────────────────────────────

test('the manifest is readable from any origin', async () => {
  for (const mode of ['open', 'gated'] as const) {
    const base = await boot(mode);
    const res = await fetch(`${base}/api/v1/instance`, { headers: ELSEWHERE });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', `${mode}: the card is unauthenticated whatever the access mode`);
    assert.equal(res.headers.get('access-control-allow-credentials'), null, 'no cookie is read here, so none is asked for');
    assert.equal(res.headers.get('vary'), null, 'one answer for every origin - nothing to vary on');
    const body = (await res.json()) as { name: string };
    assert.equal(body.name, 'CORS Hub', 'the header rides the real manifest, not a stub');
  }
});

test('the manifest preflight allows a conditional GET', async () => {
  const base = await boot('gated');
  const res = await fetch(`${base}/api/v1/instance`, {
    method: 'OPTIONS',
    headers: { ...ELSEWHERE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
  });
  assert.equal(res.status, 204);
  assert.deepEqual(corsOf(res), {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET',
    'access-control-allow-headers': 'If-None-Match',
    'access-control-max-age': '86400',
  });
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

// ── the pack download, open instance ─────────────────────────────────────────

test('an open instance serves the pack cross-origin and exposes the tag', async () => {
  const base = await boot('open');
  await hostPack(base);

  const res = await fetch(`${base}/connect/pack.lolly`, { headers: ELSEWHERE });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-expose-headers'), 'ETag',
    'ETag is not CORS-safelisted, so without this the client cannot read the tag it came for');
  const etag = res.headers.get('etag') as string;
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  await res.arrayBuffer();

  // The revalidation is the request the whole exercise is for: it has to carry
  // the headers too, or a client that already holds the pack sees an error.
  const again = await fetch(`${base}/connect/pack.lolly`, { headers: { ...ELSEWHERE, 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('access-control-allow-origin'), '*');
  assert.equal(again.headers.get('access-control-expose-headers'), 'ETag');
});

test('an open instance with nothing hosted still lets the client read the 404', async () => {
  const base = await boot('open');
  const res = await fetch(`${base}/connect/pack.lolly`, { headers: ELSEWHERE });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), '*',
    'a readable "no pack here" beats an unexplained network error');
});

test('the pack preflight answers on an open instance', async () => {
  const base = await boot('open');
  await hostPack(base);
  const res = await fetch(`${base}/connect/pack.lolly`, {
    method: 'OPTIONS',
    headers: { ...ELSEWHERE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
  });
  assert.equal(res.status, 204);
  assert.deepEqual(corsOf(res), {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET',
    'access-control-allow-headers': 'If-None-Match',
    'access-control-max-age': '86400',
  });
});

// ── the pack download, gated instance ────────────────────────────────────────

test('a gated instance sends no CORS header on the pack, session or not', async () => {
  const base = await boot('gated');
  await hostPack(base);

  const anon = await fetch(`${base}/connect/pack.lolly`, { headers: ELSEWHERE });
  assert.equal(anon.status, 401);
  assert.deepEqual(corsOf(anon), {}, 'no session, no pack, and nothing that says otherwise');

  // A member's own browser on this origin is served as before. The cookie is
  // what a cross-origin page cannot send, which is why the wildcard would be a
  // false promise here rather than a wider door.
  const member = await login(base, 'member@test');
  const ok = await fetch(`${base}/connect/pack.lolly`, { headers: { ...ELSEWHERE, cookie: member } });
  assert.equal(ok.status, 200);
  assert.deepEqual(corsOf(ok), {});
  await ok.arrayBuffer();
});

test('the pack preflight on a gated instance allows nothing', async () => {
  const base = await boot('gated');
  await hostPack(base);
  const res = await fetch(`${base}/connect/pack.lolly`, {
    method: 'OPTIONS',
    headers: { ...ELSEWHERE, 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
  });
  assert.equal(res.status, 204, 'the route answers - it just permits nothing');
  assert.deepEqual(corsOf(res), {}, 'the preflight fails, which is how the browser learns this door is shut');
  // The manifest next door is unaffected, so a client can still read the card
  // and tell the person to sign in on the instance instead of guessing.
  const card = await fetch(`${base}/api/v1/instance`, { headers: ELSEWHERE });
  assert.equal(card.headers.get('access-control-allow-origin'), '*');
});
