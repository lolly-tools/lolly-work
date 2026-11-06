/**
 * A link stops while the account that made it is disabled (plans/82 fault D).
 *
 * Disabling a person (the console's Disable access, or SCIM active=false) ended
 * their sessions but left every share, download and collection link they made
 * serving, so a departed partner could keep fetching assets through links
 * they still held. The link now answers 410 LINK_MAKER_DISABLED while the
 * maker is disabled, and serves again if the account is re-enabled.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-link-maker-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>Acme</title></svg>');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: 'acme/logo', name: 'Acme Logo', type: 'icon', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg' }] }],
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Link Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'partner@test', groups: ['distributors'] }] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sm', link: 'lm' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}

test('a disabled maker\'s link stops serving, and serves again when they are re-enabled', async () => {
  const partner = await login('partner@test');
  const minted = await fetch(`${base}/api/v1/links`, { method: 'POST', headers: { cookie: partner, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'download', target: { assetId: 'acme/logo' } }) });
  assert.equal(minted.status, 201);
  const path = ((await minted.json()) as { url: string }).url.replace('http://localhost', base);
  assert.equal((await fetch(path)).status, 200);

  const admin = await login('admin@test');
  const partnerId = (await store.getUserBySub('dev:partner@test'))!.id;
  const setDisabled = (disabled: boolean) => fetch(`${base}/api/v1/users/${partnerId}/disabled`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ disabled }) });

  assert.equal((await setDisabled(true)).status, 200);
  const stopped = await fetch(path);
  assert.equal(stopped.status, 410);
  assert.equal(((await stopped.json()) as { error: { code: string } }).error.code, 'LINK_MAKER_DISABLED');
  const page = await fetch(path, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 410);
  assert.match(await page.text(), /This link stopped working/);
  // The password form route answers the same way.
  assert.equal((await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 410);

  assert.equal((await setDisabled(false)).status, 200);
  assert.equal((await fetch(path)).status, 200, 're-enabling the account restores the link');
});
