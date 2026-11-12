// SPDX-License-Identifier: MPL-2.0
/**
 * Submitted media over real HTTP: an MP4 or MP3 is stored and served as what it
 * is, typed with the open schema's word, and a reviewer's queue row says which
 * player it gets. A record written before the table, with its bytes kept as
 * application/octet-stream and its type the `image` fallback, is served exactly
 * as it was.
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
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
/** A few dozen bytes an MP4 reader would accept the start of: brands, then one video track. */
const MP4 = Buffer.concat([
  box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1')),
  box('moov', box('trak', box('mdia', box('hdlr', u32(0), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(13))))),
  box('mdat', Buffer.alloc(32)),
]);
/** An ID3 tag, then one MPEG-1 Layer III frame. */
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x14, 0x00]), Buffer.alloc(92)]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea7c1cd0e0000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"/>');

async function boot(overrides: Record<string, unknown> = {}, packAssets: unknown[] = []) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-submit-media-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: packAssets }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Media Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
    ] },
    ...overrides,
  }));
  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const app = buildApp({ config, store, blobs, secrets: { session: 'sS', link: 'lS' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store, blobs };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

async function submit(base: string, cookie: string, bytes: Buffer, name: string, params: Record<string, string> = {}, contentType = 'application/octet-stream') {
  const q = new URLSearchParams({ name, ...params });
  const res = await fetch(`${base}/api/v1/catalog/submit?${q}`, { method: 'POST', headers: { cookie, 'content-type': contentType }, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json() as { assetId: string; state: string; type: string; formats: string[] } };
}

const feedEntry = async (base: string, cookie: string, id: string) =>
  ((await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json()) as AssetIndex).assets?.find((a) => a.id === id);

test('an MP4 is stored and served as video/mp4 and typed video; an MP3 as audio/mpeg and audio', async () => {
  const { base, store } = await boot();
  const author = await login(base, 'author@test');

  // The client's word (a wrong content type and an extensionless name) changes nothing.
  const video = await submit(base, author, MP4, 'Launch film', {}, 'audio/mpeg');
  assert.equal(video.status, 201);
  assert.equal(video.body.state, 'live');
  assert.equal(video.body.type, 'video');
  assert.deepEqual(video.body.formats, ['mp4']);
  const rec = await store.getInstanceAsset(video.body.assetId);
  assert.equal(rec?.entry.type, 'video');
  assert.equal(rec?.submission?.contentType, 'video/mp4');
  const served = await fetch(`${base}/catalog/${video.body.assetId}/mp4`, { headers: { cookie: author } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'video/mp4');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff', 'served inert like every submitted file');
  assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(Buffer.from(await served.arrayBuffer()).equals(MP4), true);
  assert.equal((await feedEntry(base, author, video.body.assetId))?.type, 'video');

  const sound = await submit(base, author, MP3, 'Sting.mp3');
  assert.equal(sound.status, 201);
  assert.equal(sound.body.type, 'audio');
  assert.deepEqual(sound.body.formats, ['mp3']);
  const mp3 = await fetch(`${base}/catalog/${sound.body.assetId}/mp3`, { headers: { cookie: author } });
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await feedEntry(base, author, sound.body.assetId))?.type, 'audio');
});

test('pictures take the schema word, a declared type is kept, and an unknown file stays opaque as before', async () => {
  const { base } = await boot();
  const author = await login(base, 'author@test');
  assert.equal((await submit(base, author, PNG, 'Hero', {}, 'image/png')).body.type, 'raster');
  assert.equal((await submit(base, author, SVG, 'Mark', {}, 'image/svg+xml')).body.type, 'vector');
  assert.equal((await submit(base, author, Buffer.concat([SVG, Buffer.from(' ')]), 'Icon', { type: 'icon' })).body.type, 'icon');
  const unknown = await submit(base, author, Buffer.from('8BPS layered artwork'), 'Poster.psd');
  assert.equal(unknown.body.type, 'data');
  assert.deepEqual(unknown.body.formats, ['psd']);
  const psd = await fetch(`${base}/catalog/${unknown.body.assetId}/psd`, { headers: { cookie: author } });
  assert.equal(psd.headers.get('content-type'), 'application/octet-stream');
});

test('a record kept as application/octet-stream and typed image before the table is served as it was', async () => {
  const { base, store, blobs } = await boot();
  const author = await login(base, 'author@test');
  const made = await submit(base, author, MP4, 'Old film');
  // Put the record and its blob back as the older submit wrote them: the bytes
  // under the filename's extension as application/octet-stream, typed `image`.
  const rec = (await store.getInstanceAsset(made.body.assetId))!;
  await blobs.put(rec.blobs.mp4!, MP4, 'application/octet-stream');
  await store.putInstanceAsset({
    ...rec,
    entry: { ...rec.entry, type: 'image' },
    submission: { ...rec.submission!, contentType: 'application/octet-stream' },
  });

  const served = await fetch(`${base}/catalog/${made.body.assetId}/mp4`, { headers: { cookie: author } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'application/octet-stream');
  assert.equal(Buffer.from(await served.arrayBuffer()).equals(MP4), true);
  assert.equal((await feedEntry(base, author, made.body.assetId))?.type, 'image', 'the served type is the word it was written with');

  const rows = await (await fetch(`${base}/api/v1/catalog/submissions?state=live`, { headers: { cookie: author } })).json() as {
    submissions: Array<{ id: string; type: string; contentType: string; previewKind: string }>;
  };
  const row = rows.submissions.find((s) => s.id === made.body.assetId);
  assert.equal(row?.type, 'image');
  assert.equal(row?.contentType, 'application/octet-stream');
  assert.equal(row?.previewKind, 'none', 'no player is offered for bytes stored without their type');
});

test('a reviewer\'s queue row names the player a pending MP4 or MP3 gets, and the preview route serves its type', async () => {
  const { base, store } = await boot({ policy: { submit: { chain: 'brand-review' } } });
  await store.putChain({
    id: 'brand-review', name: 'Brand review',
    steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter',
  });
  const author = await login(base, 'author@test');
  const film = await submit(base, author, MP4, 'Launch film');
  const sting = await submit(base, author, MP3, 'Sting');
  const hero = await submit(base, author, PNG, 'Hero', {}, 'image/png');
  for (const s of [film, sting, hero]) assert.equal(s.body.state, 'submitted');

  const brand = await login(base, 'brand@test');
  const queue = await (await fetch(`${base}/api/v1/catalog/submissions?state=submitted`, { headers: { cookie: brand } })).json() as {
    submissions: Array<{ id: string; previewKind: string; contentType: string; type: string; preview: string }>;
  };
  const row = (id: string) => queue.submissions.find((s) => s.id === id)!;
  assert.deepEqual([row(film.body.assetId).previewKind, row(film.body.assetId).contentType, row(film.body.assetId).type], ['video', 'video/mp4', 'video']);
  assert.deepEqual([row(sting.body.assetId).previewKind, row(sting.body.assetId).contentType], ['audio', 'audio/mpeg']);
  assert.equal(row(hero.body.assetId).previewKind, 'image');

  const bytes = await fetch(`${base}${row(film.body.assetId).preview}`, { headers: { cookie: brand } });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await bytes.arrayBuffer()).equals(MP4), true);
});

test('a type filter on the older or the newer name finds submitted records of both ages, and counts agree', async () => {
  const packLogo = { id: 'acme/logo', name: 'Acme Logo', type: 'vector', version: '1', tier: 'core', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg' }] };
  const { base, store } = await boot({}, [packLogo]);
  const author = await login(base, 'author@test');
  const newSvg = (await submit(base, author, SVG, 'New mark', {}, 'image/svg+xml')).body.assetId;
  const newPng = (await submit(base, author, PNG, 'New hero', {}, 'image/png')).body.assetId;
  const oldSvg = (await submit(base, author, Buffer.concat([SVG, Buffer.from('\n')]), 'Old mark', {}, 'image/svg+xml')).body.assetId;
  const oldPng = (await submit(base, author, Buffer.concat([PNG, Buffer.from([0])]), 'Old hero', {}, 'image/png')).body.assetId;
  const film = (await submit(base, author, MP4, 'Launch film')).body.assetId;
  // Two records as the older submit wrote them.
  for (const [id, type] of [[oldSvg, 'icon'], [oldPng, 'image']] as const) {
    const rec = (await store.getInstanceAsset(id))!;
    await store.putInstanceAsset({ ...rec, entry: { ...rec.entry, type } });
  }
  const browse = async (q: string) => await (await fetch(`${base}/api/v1/catalog/assets?${q}`, { headers: { cookie: author } })).json() as {
    assets: Array<{ id: string }>; total: number; facets: { types: Array<{ name: string; count: number }> };
  };
  const ids = async (q: string) => (await browse(q)).assets.map((a) => a.id).sort();

  // The older names find the newer records ...
  assert.deepEqual(await ids('type=icon'), [newSvg, oldSvg].sort());
  assert.deepEqual(await ids('type=image'), [film, newPng, oldPng].sort(), 'image was also the older word for a video');
  // ... and the newer names find the older records. The pack's own vector is
  // only ever a vector: the older names were never written for it.
  assert.deepEqual(await ids('type=vector'), ['acme/logo', newSvg, oldSvg].sort());
  assert.deepEqual(await ids('type=raster'), [newPng, oldPng].sort());
  assert.deepEqual(await ids('types=icon,video'), [film, newSvg, oldSvg].sort());

  // A type's count is what a filter on that type returns.
  const all = await browse('');
  const counts = Object.fromEntries(all.facets.types.map((t) => [t.name, t.count]));
  for (const [name, n] of Object.entries(counts)) assert.equal((await browse(`type=${name}`)).total, n, name);
  assert.deepEqual(counts, { vector: 3, image: 3, raster: 2, icon: 2, video: 1 });
});
