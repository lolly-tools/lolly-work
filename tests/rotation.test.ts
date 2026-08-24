/**
 * Dual-key secret rotation (plans/35 wave 4). The cliff this removes:
 * rotating LW_SESSION_SECRET used to log out the whole org, and rotating
 * LW_LINK_SECRET killed every outstanding link. Now rotation is two deploys -
 * add PREVIOUS beside the new current, later drop PREVIOUS - and inside the
 * window old sessions and old links keep verifying while every NEW mint
 * signs with current only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, loadSecrets, sessionKeys, linkKeys, type Secrets } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { checkLink, signLink } from '../server/src/links/sign.ts';
import { mintToken, verifyToken } from '../server/src/iam/tokens.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('key lists and env plumbing: current first, previous second, minting stays current', () => {
  const s: Secrets = { session: 'new-s', link: 'new-l', sessionPrevious: 'old-s', linkPrevious: 'old-l' };
  assert.deepEqual(sessionKeys(s), ['new-s', 'old-s']);
  assert.deepEqual(linkKeys(s), ['new-l', 'old-l']);
  assert.deepEqual(sessionKeys({ session: 'x', link: 'y' }), ['x']);

  const env = {
    NODE_ENV: 'production',
    LW_SESSION_SECRET: 'new-s', LW_SESSION_SECRET_PREVIOUS: 'old-s',
    LW_LINK_SECRET: 'new-l', LW_LINK_SECRET_PREVIOUS: 'old-l',
  };
  const loaded = loadSecrets(env as unknown as NodeJS.ProcessEnv);
  assert.equal(loaded.sessionPrevious, 'old-s');
  assert.equal(loaded.linkPrevious, 'old-l');

  const tok = mintToken('lw/session', { hello: 1 }, 'old-s', 60);
  assert.deepEqual(verifyToken('lw/session', tok, ['new-s', 'old-s']), { hello: 1 }, 'a previous-key token verifies');
  assert.equal(verifyToken('lw/session', tok, ['new-s']), null, 'dropping PREVIOUS ends the window');

  const link = { id: 'L1', kind: 'share' as const, exp: Math.floor(Date.now() / 1000) + 3600, target: { toolId: 't1' } };
  const rec = { ...link, createdBy: 'u1', createdAt: new Date().toISOString() };
  const oldSig = signLink(link, 'old-l');
  assert.equal(checkLink(rec, oldSig, ['new-l', 'old-l']), 'ok', 'an old-key link resolves through the window');
  assert.equal(checkLink(rec, oldSig, ['new-l']), 'bad-signature', 'and dies when PREVIOUS is dropped');
});

async function boot(store: ReturnType<typeof createMemoryStore>, secrets: Secrets): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rotate-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Rotate Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'a@test', groups: ['admin'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

test('a session from before the rotation survives the window and dies after it', async () => {
  const store = createMemoryStore();
  const before = await boot(store, { session: 'old-s', link: 'old-l' });
  const res = await fetch(`${before}/api/auth/dev?email=a%40test`, { redirect: 'manual' });
  const oldCookie = (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;

  // Deploy 1 of the rotation: new current + previous. The old session works.
  const during = await boot(store, { session: 'new-s', sessionPrevious: 'old-s', link: 'new-l', linkPrevious: 'old-l' });
  const who = await (await fetch(`${during}/api/auth/session`, { headers: { cookie: oldCookie } })).json() as { kind: string };
  assert.equal(who.kind, 'member', 'no forced logout inside the window');

  // A session minted DURING the window signs with current - it survives deploy 2.
  const res2 = await fetch(`${during}/api/auth/dev?email=a%40test`, { redirect: 'manual' });
  const newCookie = (res2.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;

  // Deploy 2: PREVIOUS dropped. The pre-rotation session is dead, the new one lives.
  const afterDrop = await boot(store, { session: 'new-s', link: 'new-l' });
  assert.equal((await fetch(`${afterDrop}/api/auth/session`, { headers: { cookie: oldCookie } })).status, 401, 'the window closed');
  const who2 = await (await fetch(`${afterDrop}/api/auth/session`, { headers: { cookie: newCookie } })).json() as { kind: string };
  assert.equal(who2.kind, 'member', 'mints inside the window used the new key');
});
