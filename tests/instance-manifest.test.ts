/**
 * Instance manifest (plans/34 wave 1a) - the unauthenticated card a fresh
 * app-store shell reads before anyone signs in. Two properties matter and both
 * are pinned here: the manifest answers without a session, and it carries
 * EXACTLY the declared keys - the shape assertion is also the no-secrets
 * assertion, so a field added carelessly fails the suite before it leaks.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-manifest-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Manifest Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sM', link: 'lM' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

test('the manifest answers without a session and carries exactly the declared keys', async () => {
  const base = await boot();
  const res = await fetch(`${base}/api/v1/instance`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['accessMode', 'capabilities', 'engineVersion', 'loginPath', 'name', 'provider', 'providerName'].sort());
  assert.equal(body.name, 'Manifest Hub');
  assert.equal(body.accessMode, 'gated'); // the config default - the test config sets no override
  assert.equal(body.provider, 'dev');
  assert.equal(body.providerName, null);
  assert.equal(body.loginPath, '/api/auth/dev');
  assert.deepEqual(body.capabilities, { catalog: true, collab: true, submit: true, scim: true });
});

test('engineVersion is the vendored pin, read off engine-pin.json itself', async () => {
  const base = await boot();
  const pin = JSON.parse(await readFile(join(REPO, 'engine-pin.json'), 'utf8')) as { engine: { version: string } };
  const body = (await (await fetch(`${base}/api/v1/instance`)).json()) as { engineVersion: string | null };
  assert.equal(body.engineVersion, pin.engine.version);
  assert.match(String(body.engineVersion), /^\d+\.\d+\.\d+$/);
});
