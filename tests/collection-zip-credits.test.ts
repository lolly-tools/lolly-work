// SPDX-License-Identifier: MPL-2.0
/**
 * Credits in every collection ZIP a link serves (plans/82 M4, W-M4-5), as Andy
 * approved them in the plan's section 5: `CREDITS.txt` in the `.lolly` text
 * form and `credits.json` as data, written first, nothing embedded in any
 * file, and the server records the companion as written, never as included.
 *
 * The archive is read back here over the bytes the server streamed, with the
 * engine's own ZIP reader, and the text is compared byte for byte with the
 * engine's `packCreditsText` over the same entries.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { loadRightsEngine } from '../server/src/catalog/rights.ts';
import { collectionCredits } from '../server/src/links/credits.ts';

// The engine's ZIP reader, loaded the way the server loads the engine.
const ENGINE_SPEC: string = '@lolly/engine';
const readZip = async (bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> =>
  ((await import(ENGINE_SPEC)) as { readZip: (b: Uint8Array) => Array<{ name: string; bytes: Uint8Array }> }).readZip(bytes);

const TERMS = 'Published by Acme for the people and partner programmes of this workspace to use in their work. Not an open licence.';
const FILES: Record<string, string> = { 'open.jpg': 'open-bytes', 'nc.jpg': 'nc-bytes', 'mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'stock.jpg': 'stock-bytes', 'CREDITS.txt': 'a partner\'s own credits file', 'credits.json': '{"theirs":true}' };
const PACK = [
  { id: 'acme/photo/open', name: 'Open photo', type: 'raster', file: 'open.jpg', license: 'CC-BY-4.0', attribution: 'Photo by B. Person, CC BY 4.0' },
  { id: 'acme/photo/nc', name: 'Sponsored photo', type: 'raster', file: 'nc.jpg', license: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person' },
  {
    id: 'acme/logo/mark', name: 'Acme mark', type: 'vector', file: 'mark.svg',
    rights: { works: [{ id: 'acme/logo/mark', creators: [{ name: 'Acme', role: 'owner' }],
      rights: [{ declaration: 'LicenseRef-Owner-Published', assertedBy: 'catalog', evidence: 'catalog-entry', status: 'unparsed' }],
      grants: [{ kind: 'own-work', scope: TERMS, asserted: true }] }] },
  },
  { id: 'acme/photo/stock', name: 'Stock photo', type: 'raster', file: 'stock.jpg' },
  { id: 'acme/doc/credits', name: 'Old credits', type: 'document', file: 'CREDITS.txt' },
  { id: 'acme/doc/credits-json', name: 'Old credits data', type: 'data', file: 'credits.json' },
];

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-zip-credits-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const [name, body] of Object.entries(FILES)) await writeFile(join(pack, 'catalog', 'assets', 'acme', name), body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: PACK.map(({ file, ...a }) => ({ ...a, formats: [{ format: file.split('.').pop(), url: `/catalog/assets/acme/${file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'staff@test', groups: ['marketing'] }] },
  }));
  store = createMemoryStore();
  await store.putCollection({
    id: 'launch-kit', name: 'Launch kit', members: PACK.map((a) => a.id), groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x',
  });
  await store.putCollection({ id: 'empty', name: 'Empty', members: [], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putCollection({ id: 'plain', name: 'Plain', members: ['acme/photo/open', 'acme/photo/stock'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sz', link: 'lz', credential: 'a-32-byte-or-longer-master-secret!' } });
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
async function mint(body: Record<string, unknown>): Promise<{ id: string; path: string }> {
  const res = await fetch(`${base}/api/v1/links`, { method: 'POST', headers: { cookie: await login('staff@test'), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  const { id, url } = await res.json() as { id: string; url: string };
  return { id, path: url.replace('http://localhost', base) };
}
const sha = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

test('a collection ZIP carries CREDITS.txt and credits.json first, read back from the streamed bytes', async () => {
  const link = await mint({ kind: 'download', target: { collectionId: 'launch-kit' } });
  const res = await fetch(link.path);
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const entries = await readZip(bytes);
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.slice(0, 2), ['CREDITS (2).txt', 'credits (2).json'], 'written first; on a clash the companion takes the next free names');
  assert.equal(names.length, 2 + PACK.length);
  assert.equal(new Set(names).size, names.length, 'nothing is shadowed');
  assert.equal(text(entries.find((e) => e.name === 'CREDITS.txt')?.bytes), FILES['CREDITS.txt'], 'a member called CREDITS.txt keeps its name and its bytes');
  assert.equal(text(entries.find((e) => e.name === 'credits.json')?.bytes), FILES['credits.json'], 'and so does a member called credits.json');

  const credits = text(entries[0]!.bytes);
  const json = JSON.parse(text(entries[1]!.bytes)) as { travelled: Array<Record<string, unknown>> };
  const engine = await loadRightsEngine();
  assert.equal(credits, engine.packCreditsText(json.travelled as never, []), 'the .lolly text, byte for byte, over the same entries');
  assert.deepEqual(json.travelled.map((e) => e.path), names.slice(2), 'each file named by its place in the ZIP');

  const byId = Object.fromEntries(json.travelled.map((e) => [e.id, e]));
  assert.deepEqual(byId['acme/photo/open'], { label: 'Open photo', id: 'acme/photo/open', path: 'open.jpg', licence: 'CC BY 4.0', credit: 'Photo by B. Person, CC BY 4.0' });
  assert.deepEqual(byId['acme/photo/nc'], { label: 'Sponsored photo', id: 'acme/photo/nc', path: 'nc.jpg', licence: 'CC BY-NC 4.0', credit: 'Photo by A. Person' });
  assert.deepEqual(byId['acme/logo/mark'], { label: 'Acme mark', id: 'acme/logo/mark', path: 'mark.svg', licence: 'Owner-published, not an open licence', notices: [TERMS] });
  assert.deepEqual(byId['acme/photo/stock'], { label: 'Stock photo', id: 'acme/photo/stock', path: 'stock.jpg' });

  assert.match(credits, /^Credits for the catalog works in this file\./);
  assert.match(credits, /licence: CC BY 4\.0\n {2}credit: {2}Photo by B\. Person, CC BY 4\.0/);
  assert.match(credits, /licence: Owner-published, not an open licence/);
  assert.ok(credits.includes(`notice:  ${TERMS}`));
  assert.match(credits, /- Stock photo \(acme\/photo\/stock\)\n {2}file: {4}stock\.jpg\n {2}licence: not recorded/);
  assert.ok(!credits.includes('Held back'), 'a Work ZIP never names a file it left out');
  assert.doesNotMatch(credits, /cleared|verified|legally safe|royalty-free/i);

  // Nothing is embedded in any file: every member is the file as stored.
  const member = (name: string) => text(entries.find((e) => e.name === name)?.bytes);
  assert.equal(member('open.jpg'), FILES['open.jpg']);
  assert.equal(member('mark.svg'), FILES['mark.svg']);

  // The record says written, with the hashes of the two entries as read back.
  const row = (await store.listAudit()).filter((e) => e.action === 'catalog.collection.download').at(-1)!;
  assert.deepEqual(row.payload, {
    linkId: link.id, entries: PACK.length, withheld: 0,
    credits: { state: 'written', files: { 'CREDITS (2).txt': sha(entries[0]!.bytes), 'credits (2).json': sha(entries[1]!.bytes) } },
  });
  assert.ok(!JSON.stringify(row.payload).includes('included'), 'never recorded as included');
});

test('with no clash, the companion is CREDITS.txt and credits.json, and member names are as they always were', async () => {
  const link = await mint({ kind: 'download', target: { collectionId: 'plain' } });
  const entries = await readZip(new Uint8Array(await (await fetch(link.path)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['CREDITS.txt', 'credits.json', 'open.jpg', 'stock.jpg']);
});

test('a single file through a link is unchanged, and the page says nothing about credits', async () => {
  const share = await mint({ kind: 'share', target: { collectionId: 'launch-kit' } });
  const page = await (await fetch(share.path)).text();
  assert.doesNotMatch(page, /included/i, 'the page never says the credits are included');
  const one = await fetch(`${share.path}&asset=${encodeURIComponent('acme/photo/open')}&dl=1`);
  assert.equal(one.status, 200);
  assert.equal(await one.text(), FILES['open.jpg']);
  const asset = await mint({ kind: 'download', target: { assetId: 'acme/photo/nc' } });
  assert.equal(await (await fetch(asset.path)).text(), FILES['nc.jpg']);
});

test('a ZIP with no files carries no credits', async () => {
  const link = await mint({ kind: 'download', target: { collectionId: 'empty' } });
  const entries = await readZip(new Uint8Array(await (await fetch(link.path)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), []);
  const row = (await store.listAudit()).filter((e) => e.action === 'catalog.collection.download').at(-1)!;
  assert.equal((row.payload as { credits?: unknown }).credits, undefined);
});

test('the credits entries are pure data from the entries and the engine', async () => {
  const engine = await loadRightsEngine();
  const out = collectionCredits(engine, [
    { id: 'x/a', path: 'a.png', fallbackLabel: 'a.png', entry: { id: 'x/a', name: 'A', license: 'MIT', attribution: 'A by Someone' } },
    { id: 'x/b', path: 'b.png', fallbackLabel: 'b.png' },
    { id: 'x/c', path: 'c.png', fallbackLabel: 'c.png', entry: { id: 'x/c', name: 'C', license: 'CC-BY-NC-4.0' }, includedByChoice: true },
  ]);
  assert.deepEqual(out.entries, [
    { label: 'A', id: 'x/a', path: 'a.png', licence: 'MIT License', credit: 'A by Someone' },
    { label: 'b.png', id: 'x/b', path: 'b.png' },
    { label: 'C', id: 'x/c', path: 'c.png', licence: 'CC BY-NC 4.0', includedByChoice: true },
  ]);
  const txt = text(out.files[0]!.bytes);
  assert.ok(txt.includes('included by the sender, who chose to carry bytes held back by default'), 'the .lolly sentence, verbatim');
  assert.deepEqual(JSON.parse(text(out.files[1]!.bytes)).travelled[2].includedByChoice, true);
  assert.deepEqual(collectionCredits(engine, []).files, [], 'no files, no credits');
});
