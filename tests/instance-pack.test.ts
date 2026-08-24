/**
 * Instance-pack hosting (plans/34 wave 2). The control plane never BUILDS a
 * pack - the OSS builder owns the signed format - so what this suite pins is
 * the hosting contract: the inspection refuses anything that is not a .lolly
 * instance pack for THIS deployment, hosting is owner-only, the download gate
 * follows defaultAccessMode, and the public manifest advertises the pack
 * exactly while one is hosted. Fixtures are cut with our own links/zip.ts
 * writer - reader and writer prove each other.
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
import { inspectInstancePack } from '../server/src/catalog/instance-pack.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

function packBytes(entries: Record<string, string>): Buffer {
  const zb = new ZipBuilder(new Date('2026-08-24T00:00:00Z'));
  const parts = Object.entries(entries).map(([name, body]) => zb.add(name, Buffer.from(body)));
  parts.push(zb.end());
  return Buffer.concat(parts);
}

const GOOD = (instance: string) => ({
  'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
  'instance.json': JSON.stringify({ kind: 'instance', name: 'Acme Brand', publisher: 'Acme', version: '1.2.0', instance }),
  'tokens.json': '{}',
  'pack.sig': 'sig-bytes',
});

async function boot(accessMode: 'open' | 'gated'): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Pack Hub', baseUrl: 'http://packs.example', pack },
    rateLimit: { enabled: false },
    policy: { defaultAccessMode: accessMode },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sP', link: 'lP' } });
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

const upload = (base: string, cookie: string, bytes: Buffer) =>
  fetch(`${base}/api/v1/instance-pack`, { method: 'PUT', headers: { cookie }, body: new Uint8Array(bytes) });

// ── the inspection ───────────────────────────────────────────────────────────

test('inspection accepts a pack for this instance and refuses every wrong shape by name', () => {
  const good = inspectInstancePack(packBytes(GOOD('http://packs.example')), 'http://packs.example');
  assert.deepEqual(good, {
    name: 'Acme Brand', publisher: 'Acme', version: '1.2.0',
    packInstance: 'http://packs.example', signed: true, entryCount: 4,
  });

  // A trailing slash on either side is not a different instance.
  assert.equal(inspectInstancePack(packBytes(GOOD('http://packs.example/')), 'http://packs.example').packInstance, 'http://packs.example');

  assert.throws(() => inspectInstancePack(Buffer.from('not a zip at all'), 'http://packs.example'), /not a zip/);
  const { 'instance.json': _drop, ...brandOnly } = GOOD('http://packs.example');
  assert.throws(() => inspectInstancePack(packBytes(brandOnly), 'http://packs.example'), /INSTANCE pack/);
  assert.throws(() => inspectInstancePack(packBytes({ 'instance.json': '{}' }), 'http://packs.example'), /manifest\.json/);
  assert.throws(
    () => inspectInstancePack(packBytes(GOOD('http://other.example')), 'http://packs.example'),
    /enroll devices somewhere else/,
  );
  const unsigned = { ...GOOD('http://packs.example') };
  delete (unsigned as Record<string, string>)['pack.sig'];
  assert.equal(inspectInstancePack(packBytes(unsigned), 'http://packs.example').signed, false);
});

// ── hosting over HTTP ────────────────────────────────────────────────────────

test('owner hosts the pack; the manifest advertises it; gated download needs a session', async () => {
  const base = await boot('gated');
  const owner = await login(base, 'owner@test');
  const admin = await login(base, 'admin@test');
  const bytes = packBytes(GOOD('http://packs.example'));

  assert.equal((await upload(base, admin, bytes)).status, 403, 'hosting is owner-only (instance.config)');
  assert.equal((await fetch(`${base}/api/v1/instance`).then((r) => r.json()) as { connect?: unknown }).connect, undefined, 'no pack, no connect block');

  const put = await upload(base, owner, bytes);
  assert.equal(put.status, 200);
  const { pack } = (await put.json()) as { pack: { name: string; signed: boolean; size: number; uploadedBy: string } };
  assert.equal(pack.name, 'Acme Brand');
  assert.equal(pack.signed, true);
  assert.equal(pack.size, bytes.length);

  const manifest = (await (await fetch(`${base}/api/v1/instance`)).json()) as { connect?: { packUrl: string } };
  assert.equal(manifest.connect?.packUrl, 'http://packs.example/connect/pack.lolly');

  assert.equal((await fetch(`${base}/connect/pack.lolly`)).status, 401, 'gated instance asks for a session');
  const dl = await fetch(`${base}/connect/pack.lolly`, { headers: { cookie: admin } });
  assert.equal(dl.status, 200);
  assert.ok(dl.headers.get('content-disposition')?.includes('.lolly'));
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, 'the bytes round-trip exactly');

  const wrong = await upload(base, owner, packBytes(GOOD('http://other.example')));
  assert.equal(wrong.status, 400, 'a pack for another instance is refused at the door');

  assert.equal((await fetch(`${base}/api/v1/instance-pack`, { method: 'DELETE', headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(`${base}/connect/pack.lolly`, { headers: { cookie: admin } })).status, 404);
  const after1 = (await (await fetch(`${base}/api/v1/instance`)).json()) as { connect?: unknown };
  assert.equal(after1.connect, undefined, 'the manifest stops advertising a removed pack');
});

test('an open instance serves the pack to anyone - the zero-friction arm', async () => {
  const base = await boot('open');
  const owner = await login(base, 'owner@test');
  const bytes = packBytes(GOOD('http://packs.example'));
  assert.equal((await upload(base, owner, bytes)).status, 200);
  const anon = await fetch(`${base}/connect/pack.lolly`);
  assert.equal(anon.status, 200);
  assert.equal((await anon.arrayBuffer()).byteLength, bytes.length);
});
