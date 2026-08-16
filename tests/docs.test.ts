/**
 * The deployment docs surface: GET /api/v1/docs (manifest index) and
 * GET /api/v1/docs/:slug (markdown). Manifest-allowlisted, with the open-source
 * /info/ link present exactly when a Lolly deployment is reachable from this
 * deploy (appUrl set, or a served shellDir). Readable without a session on the
 * public sandbox (dev.enabled — the landing links straight here); member-only on
 * a governed deploy.
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

interface DocsIndex {
  title: string;
  sections: Array<{ id: string; title: string; docs: Array<{ slug: string; title: string; summary?: string }> }>;
  oss?: { label: string; url: string; note: string };
}

const servers: Server[] = [];

/** A live app on an ephemeral port, with whatever instance overrides a test needs. */
async function boot(instance: Record<string, unknown> = {}): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Docs Hub', baseUrl: 'http://localhost', pack, ...instance },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'member@test', name: 'Mo Member', groups: ['staff'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's3', link: 'l3' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

/** Sign in against a given app — memberOf resolves the user in THAT app's store,
 *  so a cookie is not portable between the boots above. */
async function login(b: string): Promise<string> {
  const res = await fetch(`${b}/api/auth/dev?email=member@test`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!).split(';')[0] as string;
}

let base = '';
let cookie = '';

before(async () => {
  base = await boot();
  cookie = await login(base);
});

after(() => { for (const s of servers) s.close(); });

test('the index lists sections of slug-shaped docs, public on the sandbox', async () => {
  // dev.enabled ⇒ the docs are readable without a session, and the deploy
  // advertises that so the console can open the Docs view for anonymous visitors.
  assert.equal((await fetch(`${base}/api/v1/docs`)).status, 200);
  const cfg = await (await fetch(`${base}/api/auth/config`)).json() as { publicDocs?: boolean };
  assert.equal(cfg.publicDocs, true);
  const res = await fetch(`${base}/api/v1/docs`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as DocsIndex;
  assert.ok(body.sections.length >= 3, 'several sections');
  const slugs = body.sections.flatMap((s) => s.docs.map((d) => d.slug));
  for (const expected of ['overview', 'configuration', 'permissions', 'api', 'status']) {
    assert.ok(slugs.includes(expected), `${expected} is listed`);
  }
  for (const s of slugs) assert.match(s, /^[a-z0-9][a-z0-9-]*$/);
  for (const section of body.sections) {
    for (const d of section.docs) assert.ok(d.title, `${d.slug} has a title`);
  }
});

test('every listed doc actually resolves to markdown', async () => {
  const { sections } = await (await fetch(`${base}/api/v1/docs`, { headers: { cookie } })).json() as DocsIndex;
  for (const section of sections) {
    for (const doc of section.docs) {
      const res = await fetch(`${base}/api/v1/docs/${doc.slug}`, { headers: { cookie } });
      assert.equal(res.status, 200, `${doc.slug} resolves`);
      assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
      const text = await res.text();
      assert.match(text, /^# .+/, `${doc.slug} opens with a title heading`);
    }
  }
});

test('a listed slug is public on the sandbox; unlisted or traversing slugs 404', async () => {
  assert.equal((await fetch(`${base}/api/v1/docs/overview`)).status, 200);
  for (const slug of ['no-such-doc', 'README', '..%2Finstance', '%2Fetc%2Fpasswd']) {
    const res = await fetch(`${base}/api/v1/docs/${slug}`, { headers: { cookie } });
    assert.equal(res.status, 404, `${slug} is not served`);
  }
});

test('a governed (non-dev) deploy keeps the docs member-only', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Gov Hub', baseUrl: 'http://localhost', pack },
    idp: { issuer: 'https://idp.invalid', clientId: '', groupsClaim: 'groups', claimMap: { email: 'email' } },
    policy: { defaultAccessMode: 'gated' },
    rateLimit: { enabled: false },
    dev: { enabled: false, users: [] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's3', link: 'l3' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const gov = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // No dev sandbox ⇒ both docs routes require a session, and publicDocs is false
  // so the console never opens the Docs view to an anonymous visitor.
  assert.equal((await fetch(`${gov}/api/v1/docs`)).status, 401);
  assert.equal((await fetch(`${gov}/api/v1/docs/overview`)).status, 401);
  const cfg = await (await fetch(`${gov}/api/auth/config`)).json() as { publicDocs?: boolean };
  assert.equal(cfg.publicDocs, false);
});

test('the open-source /info/ link tracks whether a Lolly deployment is reachable', async () => {
  const index = async (b: string) => {
    const res = await fetch(`${b}/api/v1/docs`, { headers: { cookie: await login(b) } });
    return await res.json() as DocsIndex;
  };
  // No shell served and no appUrl ⇒ nothing to link to.
  assert.equal((await index(base)).oss, undefined);

  const split = await boot({ appUrl: 'https://lolly.example.com' });
  assert.equal((await index(split)).oss?.url, 'https://lolly.example.com/info/');

  // Same-origin shell ⇒ a relative /info/ on this deploy. (buildApp only needs
  // the path to be configured; dist freshness is a boot check in main.ts.)
  const sameOrigin = await boot({ shellDir: '/nonexistent-dist' });
  assert.equal((await index(sameOrigin)).oss?.url, '/info/');
});
