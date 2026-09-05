/**
 * The manifest's `brand` block and the pack download's ETag - the two cheap
 * answers a client needs to keep a hosted design system on the device and
 * notice when the host's brand moves (OSS plans/186 section 7).
 *
 * Three properties are pinned here. The block is read from the pack's OWN
 * assets index, so `label`, `checksum` and `locked` are the pack's words and
 * not this server's guess. It follows a brand-profile switch, because a cached
 * brand card after a rebrand is worse than none. And the pack route's ETag sits
 * behind the access gate: a gated instance answers 401 to a conditional request
 * exactly as it answers an unconditional one, so the tag never says "the brand
 * here is X" to someone who may not download it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface BrandCard {
  profile: string | null;
  label: string | null;
  version: string | null;
  checksum: string | null;
  locked: boolean;
  packUrl: string | null;
}

const BASE_URL = 'http://brand.example';

/** One catalog with one tokens asset, in the shape the OSS catalog build writes:
 *  the checksum sits on the format FILE, `brandLock` on the asset. */
async function writeTokensCatalog(
  catalogRoot: string,
  opts: { id: string; label: string; checksum: string; locked: boolean; marker: string },
): Promise<void> {
  await mkdir(join(catalogRoot, 'assets', 'tokens'), { recursive: true });
  await writeFile(join(catalogRoot, 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{
      id: opts.id,
      name: opts.label,
      type: 'tokens',
      tier: 'core',
      ...(opts.locked ? { brandLock: true } : {}),
      formats: [{ format: 'json', url: '/catalog/assets/tokens/brand.json', checksum: opts.checksum }],
    }],
  }));
  await writeFile(join(catalogRoot, 'assets', 'tokens', 'brand.json'), JSON.stringify({ marker: opts.marker }));
}

async function boot(pack: string, accessMode: 'open' | 'gated' = 'gated'): Promise<string> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Brand Card Hub', baseUrl: BASE_URL, pack },
    rateLimit: { enabled: false },
    policy: { defaultAccessMode: accessMode },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'member@test', groups: ['marketing'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sBC', link: 'lBC' } });
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

const brandOf = async (base: string): Promise<BrandCard | null> =>
  ((await (await fetch(`${base}/api/v1/instance`)).json()) as { brand: BrandCard | null }).brand;

/** A minimal signed-looking instance pack for THIS deployment (the shape
 *  `inspectInstancePack` accepts - the OSS builder owns the real format). */
function packBytes(version: string): Buffer {
  const zb = new ZipBuilder(new Date('2026-09-04T00:00:00Z'));
  const entries: Record<string, string> = {
    'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
    'instance.json': JSON.stringify({ kind: 'instance', name: 'Brand Card Hub', publisher: 'Acme', version, instance: BASE_URL }),
    'tokens.json': '{}',
    'pack.sig': 'sig-bytes',
  };
  const parts = Object.entries(entries).map(([name, body]) => zb.add(name, Buffer.from(body)));
  parts.push(zb.end());
  return Buffer.concat(parts);
}

// ── the manifest's brand block ───────────────────────────────────────────────

test('brand carries the label, checksum and lock the pack index states', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-'));
  await writeTokensCatalog(join(pack, 'catalog'), {
    id: 'acme/tokens/brand', label: 'Acme Tokens', checksum: 'sha256-AAAA', locked: true, marker: '#123456',
  });
  const base = await boot(pack);

  const res = await fetch(`${base}/api/v1/instance`);
  assert.equal(res.status, 200, 'the manifest stays unauthenticated');
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body.brand, {
    profile: null, // a single-brand pack has no brands/ dir to name
    label: 'Acme Tokens',
    version: null, // nothing hosted at /connect/pack.lolly yet
    checksum: 'sha256-AAAA',
    locked: true,
    packUrl: null,
  });
});

test('brand is null when the pack ships no tokens asset', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-none-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const base = await boot(pack);

  const body = (await (await fetch(`${base}/api/v1/instance`)).json()) as Record<string, unknown>;
  assert.equal(body.brand, null, 'no tokens asset, no brand to describe');
  assert.ok('brand' in body, 'the key is always present, so an old deploy and a new one read differently');
});

test('brand.profile names the active profile, and the card refreshes on a switch', async () => {
  // The plans/29 fixture: brands/<name>/catalog, a marker, a catalog symlink.
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-profiles-'));
  await writeTokensCatalog(join(pack, 'brands', 'suse', 'catalog'), {
    id: 'suse/tokens/brand', label: 'SUSE tokens', checksum: 'sha256-SUSE', locked: true, marker: '#30ba78',
  });
  await writeTokensCatalog(join(pack, 'brands', 'lolly-start', 'catalog'), {
    id: 'lolly/tokens/brand', label: 'Lolly Starter Tokens', checksum: 'sha256-START', locked: false, marker: '#7c3aed',
  });
  await writeFile(join(pack, '.lolly-profile'), 'suse\n');
  await symlink(join('brands', 'suse', 'catalog'), join(pack, 'catalog'));
  const base = await boot(pack);

  const before = await brandOf(base);
  assert.equal(before?.profile, 'suse');
  assert.equal(before?.label, 'SUSE tokens');
  assert.equal(before?.checksum, 'sha256-SUSE');
  assert.equal(before?.locked, true);

  const admin = await login(base, 'admin@test');
  const put = await fetch(`${base}/api/v1/brand/profile`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lolly-start' }),
  });
  assert.equal(put.status, 200);

  const now = await brandOf(base);
  assert.equal(now?.profile, 'lolly-start');
  assert.equal(now?.label, 'Lolly Starter Tokens', 'the memoised card is dropped with the brand chrome');
  assert.equal(now?.checksum, 'sha256-START', 'a client polling the checksum sees the rebrand');
  assert.equal(now?.locked, false);
});

test('a hosted pack fills brand.version and brand.packUrl', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-hosted-'));
  await writeTokensCatalog(join(pack, 'catalog'), {
    id: 'acme/tokens/brand', label: 'Acme Tokens', checksum: 'sha256-AAAA', locked: false, marker: '#123456',
  });
  const base = await boot(pack);
  const owner = await login(base, 'owner@test');
  assert.equal((await fetch(`${base}/api/v1/instance-pack`, {
    method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(packBytes('1.2.0')),
  })).status, 200);

  const body = (await (await fetch(`${base}/api/v1/instance`)).json()) as { brand: BrandCard; connect: { packUrl: string } };
  assert.equal(body.brand.version, '1.2.0', "the hosted pack's own version");
  assert.equal(body.brand.packUrl, `${BASE_URL}/connect/pack.lolly`);
  assert.equal(body.brand.packUrl, body.connect.packUrl, 'one block answers what is here and where to get it');
});

// ── the pack download's ETag ─────────────────────────────────────────────────

test('the pack download tags its bytes and honours If-None-Match', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-etag-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const base = await boot(pack, 'open');
  const owner = await login(base, 'owner@test');
  const bytes = packBytes('1.2.0');
  assert.equal((await fetch(`${base}/api/v1/instance-pack`, {
    method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(bytes),
  })).status, 200);

  const first = await fetch(`${base}/connect/pack.lolly`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'the download carries an entity tag');
  assert.match(etag, /^"[0-9a-f]{64}"$/, 'the stored checksum, quoted and strong');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache', 'keepable, but only after asking');
  assert.equal((await first.arrayBuffer()).byteLength, bytes.length);

  // The tag IS the meta checksum the owner-facing route reports.
  const meta = (await (await fetch(`${base}/api/v1/instance-pack`, { headers: { cookie: owner } })).json()) as { pack: { checksum: string } };
  assert.equal(etag, `"${meta.pack.checksum}"`);

  const same = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': etag } });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('etag'), etag);
  assert.equal((await same.arrayBuffer()).byteLength, 0, 'a match sends no body');

  const list = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': `"other", W/${etag}` } });
  assert.equal(list.status, 304, 'any member of the list matches, weakly compared');

  const star = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': '*' } });
  assert.equal(star.status, 304, '* matches any hosted representation');

  const stale = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': '"sha256-nope"' } });
  assert.equal(stale.status, 200);
  assert.equal((await stale.arrayBuffer()).byteLength, bytes.length, 'a miss sends the pack');

  // Re-hosting different bytes changes the tag, which is the whole point.
  assert.equal((await fetch(`${base}/api/v1/instance-pack`, {
    method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(packBytes('1.3.0')),
  })).status, 200);
  const after2 = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': etag } });
  assert.equal(after2.status, 200);
  assert.notEqual(after2.headers.get('etag'), etag);
});

test('a gated instance answers 401 to a conditional request, tag and all', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brandcard-gated-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const base = await boot(pack, 'gated');
  const owner = await login(base, 'owner@test');
  assert.equal((await fetch(`${base}/api/v1/instance-pack`, {
    method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(packBytes('1.2.0')),
  })).status, 200);

  for (const inm of ['*', '"sha256-guess"']) {
    const res = await fetch(`${base}/connect/pack.lolly`, { headers: { 'if-none-match': inm } });
    assert.equal(res.status, 401, `no session, no pack (If-None-Match: ${inm})`);
    assert.equal(res.headers.get('etag'), null, 'the tag never reaches an unauthenticated caller');
  }

  const member = await login(base, 'member@test');
  const ok = await fetch(`${base}/connect/pack.lolly`, { headers: { cookie: member } });
  assert.equal(ok.status, 200);
  const etag = ok.headers.get('etag') as string;
  const again = await fetch(`${base}/connect/pack.lolly`, { headers: { cookie: member, 'if-none-match': etag } });
  assert.equal(again.status, 304, 'a signed-in member gets the cheap revalidation');
});
