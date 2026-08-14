/**
 * Brand profiles over real HTTP (plans/29): a profile-aware pack (brands/<name>/,
 * a .lolly-profile marker, a catalog symlink) lists its profiles + the active
 * one (member-readable), and an owner/admin switch re-points the symlink, rewrites
 * the marker, invalidates the brand-chrome cache so /api/brand serves the new
 * brand immediately, and is audited. A pack with no brands/ reports unavailable.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let pack = '';

async function writeProfile(root: string, name: string, markerValue: string): Promise<void> {
  const assets = join(root, 'brands', name, 'catalog', 'assets');
  const tokensDir = join(root, 'brands', name, 'catalog', name, 'tokens');
  await mkdir(assets, { recursive: true });
  await mkdir(tokensDir, { recursive: true });
  await writeFile(join(assets, 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: `${name}/tokens/brand`, type: 'tokens', name: `${name} tokens`, formats: [{ format: 'json', url: `/catalog/${name}/tokens/brand.json` }] }],
  }));
  await writeFile(join(tokensDir, 'brand.json'), JSON.stringify({ marker: markerValue, color: { brand: { primary: { $value: markerValue, $type: 'color' } } } }));
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-profiles-'));
  await writeProfile(pack, 'suse', '#30ba78');
  await writeProfile(pack, 'lolly-start', '#7c3aed');
  await writeFile(join(pack, '.lolly-profile'), 'suse\n');
  await symlink(join('brands', 'suse', 'catalog'), join(pack, 'catalog')); // relative symlink

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Brand Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'member@test', groups: ['marketing'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sB', link: 'lB' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const brandMarker = async (cookie: string): Promise<string> =>
  ((await (await fetch(`${base}/api/brand`, { headers: { cookie } })).json()) as { tokens: { marker: string } }).tokens.marker;

test('(a) profiles list is member-readable and names the active profile', async () => {
  const member = await login('member@test');
  const r = await (await fetch(`${base}/api/v1/brand/profiles`, { headers: { cookie: member } })).json() as {
    available: boolean; active: string; profiles: Array<{ name: string; active: boolean }>;
  };
  assert.equal(r.available, true);
  assert.equal(r.active, 'suse');
  assert.deepEqual(r.profiles.map((p) => p.name).sort(), ['lolly-start', 'suse']);
  assert.equal(r.profiles.find((p) => p.name === 'suse')?.active, true);
  // /api/brand serves the ACTIVE (suse) brand.
  assert.equal(await brandMarker(member), '#30ba78');
});

test('(b) switching is owner/admin only — a member is refused', async () => {
  const member = await login('member@test');
  const res = await fetch(`${base}/api/v1/brand/profile`, {
    method: 'PUT', headers: { cookie: member, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lolly-start' }),
  });
  assert.equal(res.status, 403);
});

test('(c) an admin switch re-points the pack, invalidates brand chrome, and is audited', async () => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/brand/profile`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lolly-start' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { active: string }).active, 'lolly-start');

  // The marker file moved, and /api/brand now serves the NEW brand (cache cleared).
  assert.equal((await readFile(join(pack, '.lolly-profile'), 'utf8')).trim(), 'lolly-start');
  assert.equal(await brandMarker(admin), '#7c3aed', 'brand chrome reflects the switch immediately');
  const profiles = await (await fetch(`${base}/api/v1/brand/profiles`, { headers: { cookie: admin } })).json() as { active: string };
  assert.equal(profiles.active, 'lolly-start');

  assert.ok((await store.listAudit()).some((e) => e.action === 'brand.profile.switch' && e.subject === 'brand:lolly-start'));
});

test('(d) unknown profile 404s; switching to the already-active one is a no-op', async () => {
  const owner = await login('owner@test');
  const bad = await fetch(`${base}/api/v1/brand/profile`, { method: 'PUT', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope' }) });
  assert.equal(bad.status, 404);
  const same = await fetch(`${base}/api/v1/brand/profile`, { method: 'PUT', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lolly-start' }) });
  assert.equal(same.status, 200);
  assert.equal((await same.json() as { unchanged?: boolean }).unchanged, true);
});
