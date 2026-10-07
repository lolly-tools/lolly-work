/**
 * Share cards for an instance that serves its own Lolly shell
 * (server/src/shell/share-cards.ts, the shell fallback and the catalog route in
 * server/src/api/app.ts).
 *
 * A link unfurler reads Open Graph tags and never signs in or runs scripts, so:
 * `/t/<id>`, the views and `/docs/<slug>` must answer the shell build's landing
 * stub (each with its own card) rather than the bare index.html; card images must
 * answer without a session; and a card for a tool hidden from some groups must not
 * become public on the way. The alias table is also checked against a Lolly
 * checkout's vercel.json when one is beside this repository.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { SHELL_STUB_ALIASES, publicCard, shellStubFor } from '../server/src/shell/share-cards.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('stub lookup: tools, views and docs map to the files a Lolly build emits', () => {
  const all = () => true;
  assert.equal(shellStubFor('t/susecon-background', all), 't/susecon-background.html');
  assert.equal(shellStubFor('assets', all), 'view/a.html');
  assert.equal(shellStubFor('tools/', all), 'view/tools.html');
  assert.equal(shellStubFor('verify', all), 'view/v.html');
  assert.equal(shellStubFor('docs', all), 'info/index.html');
  assert.equal(shellStubFor('docs/quickstart', all), 'info/quickstart.html');
  assert.equal(shellStubFor('docs/start/quickstart', all), 'info/start/quickstart.html');
  assert.equal(shellStubFor('docs/de/start/quickstart', all), 'info/de/start/quickstart.html');
  assert.equal(shellStubFor('docs/zh-hant/faq', all), 'info/zh-hant/faq.html');
  // Not a stub route, or a stub the build did not emit: the plain index.html.
  assert.equal(shellStubFor('', all), null);
  assert.equal(shellStubFor('tool/sandbox', all), null);
  assert.equal(shellStubFor('t/Bad_Id', all), null);
  assert.equal(shellStubFor('t/new-tool', () => false), null);
  assert.equal(shellStubFor('constructor', all), null);
  assert.equal(shellStubFor('__proto__', all), null);
});

test('card paths: tool and view rasters only, lower-cased; manifests are not cards', () => {
  assert.deepEqual(publicCard('og/susecon-background.png'), { kind: 'tool', toolId: 'susecon-background', rel: 'og/susecon-background.png' });
  assert.deepEqual(publicCard('OG/QR-Code.JPG'), { kind: 'tool', toolId: 'qr-code', rel: 'og/qr-code.jpg' });
  assert.deepEqual(publicCard('og/views/a.png'), { kind: 'view', rel: 'og/views/a.png' });
  for (const rel of ['og/.og-sigs.json', 'og/views/a.svg', 'og/x.svg', 'og/a/b.png', 'previews/x.png', 'og/../tools/index.json', 'og/views/../x.png']) {
    assert.equal(publicCard(rel), null, rel);
  }
});

const LOLLY = resolve(process.env.LOLLY_DIR ?? join(import.meta.dirname, '..', '..', 'lolly'));
const VERCEL_JSON = join(LOLLY, 'vercel.json');
test('the alias table matches every stub rewrite in a Lolly checkout\'s vercel.json', { skip: !existsSync(VERCEL_JSON) && 'no Lolly checkout beside this repository (set LOLLY_DIR)' }, () => {
  const { rewrites } = JSON.parse(readFileSync(VERCEL_JSON, 'utf8')) as { rewrites: Array<{ source: string; destination: string }> };
  const stubs = rewrites.filter((r) => /^\/(t|view|info)\/.*\.html$/.test(r.destination));
  assert.ok(stubs.length > 10, 'found the stub rewrites');
  for (const { source, destination } of stubs) {
    const dest = destination.slice(1);
    if (!source.includes(':')) {
      assert.equal(SHELL_STUB_ALIASES[source.slice(1)], dest, source);
      continue;
    }
    // A parameterised rewrite: fill it with sample values and compare.
    const sample = (s: string) => s
      .replace(/:lang(\([^)]*\))?/, 'de').replace(/:door(\([^)]*\))?/, 'start')
      .replace(/:slug(\([^)]*\))?/, 'faq').replace(/:id\b/, 'qr-code');
    assert.equal(shellStubFor(sample(source).slice(1), () => true), sample(dest), source);
  }
});

async function instance() {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'open-tool' }, { id: 'staff-tool' }] }));
  await mkdir(join(pack, 'catalog', 'og'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'og', 'open-tool.png'), 'pack-card');
  const shellDir = await mkdtemp(join(tmpdir(), 'lw-shell-'));
  await writeFile(join(shellDir, 'index.html'), '<!doctype html><title>index</title>');
  for (const [rel, body] of [
    ['t/open-tool.html', '<meta property="og:title" content="Open tool">'],
    ['view/a.html', '<meta property="og:title" content="Assets">'],
    ['view/tools.html', '<meta property="og:title" content="Tools">'],
    ['info/quickstart.html', '<meta property="og:title" content="Quickstart">'],
    ['catalog/og/open-tool.png', 'shell-card'],
    ['catalog/og/staff-tool.png', 'staff-card'],
    ['catalog/og/views/a.png', 'view-card'],
  ] as const) {
    await mkdir(join(shellDir, rel, '..'), { recursive: true });
    await writeFile(join(shellDir, rel), body);
  }
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Cards', baseUrl: 'http://localhost', pack, shellDir },
    policy: { defaultAccessMode: 'gated' },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'member@test', name: 'Mo Member', groups: ['staff'] }] },
  }));
  const store = createMemoryStore();
  await store.putOverlay({ toolId: 'staff-tool', version: 1, visibility: { groups: ['staff'] } });
  const app = buildApp({ config, store, secrets: { session: 's4', link: 'l4' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

test('signed out on a gated instance: stubs, the Tools view and public cards answer; the rest stays gated', async () => {
  const base = await instance();
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.text(), cache: res.headers.get('cache-control'), type: res.headers.get('content-type') };
  };
  assert.match((await get('/t/open-tool')).body, /Open tool/);
  assert.match((await get('/assets')).body, /Assets/);
  assert.match((await get('/tools')).body, /Tools/);
  assert.match((await get('/docs/quickstart')).body, /Quickstart/);
  // A tool the shell build has no stub for still opens the app.
  assert.match((await get('/t/brand-new')).body, /<title>index<\/title>/);

  const toolCard = await get('/catalog/og/open-tool.png');
  assert.equal(toolCard.status, 200);
  assert.equal(toolCard.body, 'pack-card', 'the pack copy wins over the shell build');
  assert.equal(toolCard.cache, 'public, max-age=3600');
  assert.match(String(toolCard.type), /^image\/png/);
  const viewCard = await get('/catalog/og/views/a.png');
  assert.equal(viewCard.status, 200);
  assert.equal(viewCard.body, 'view-card', 'falls back to the shell build when the pack has none');

  // A tool hidden from callers without the staff group: no public card.
  assert.equal((await get('/catalog/og/staff-tool.png')).status, 404);
  // Everything else under /catalog keeps the sign-in gate.
  assert.equal((await get('/catalog/tools/index.json')).status, 401);
  assert.equal((await get('/catalog/og/.og-sigs.json')).status, 401);
});
