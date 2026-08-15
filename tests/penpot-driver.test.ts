/**
 * Penpot driver (plans/30 P1) against a modelled RPC shape. Injected fetch, no
 * network: token discovery (get-teams → get-projects → get-project-files), the
 * tokens-only federation (nativeType 'tokens', one json format), the get-file →
 * DTCG conversion (sets → group trees, $metadata order, $themes passthrough), the
 * `Authorization: Token …` header, and health via get-profile. Command/field names
 * carry a LIVE-VERIFY caveat in the driver; these fixtures pin the SHAPE it maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPenpotProvider, tokensLibToDtcg } from '../server/src/catalog/providers/penpot.ts';

const BASE = 'https://design.example';

const TEAMS = [{ id: 't1', name: 'Brand' }];
const PROJECTS = [{ id: 'p1', name: 'Website' }];
const FILES = [{ id: 'f-aaa', name: 'Foundations', modifiedAt: '2026-07-01T00:00:00.000Z' }];
const FILE_TOKENS = {
  id: 'f-aaa',
  name: 'Foundations',
  data: {
    tokensLib: {
      sets: {
        Global: {
          tokens: {
            'color.brand.500': { type: 'color', value: '#c72f2f', description: 'brand red' },
            'spacing.md': { type: 'spacing', value: '16' },
          },
        },
      },
      themes: [{ name: 'Light', group: 'mode', selectedTokenSets: { Global: 'enabled' } }],
    },
  },
};

interface Call { url: string; method: string; auth: string; body: string }
function fakeFetch(routes: Array<{ match: (url: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method: init?.method ?? 'GET', auth: h.authorization ?? '', body: String(init?.body ?? '') });
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}

const cmd = (name: string) => (u: string) => u.endsWith(`/api/rpc/command/${name}`);

test('listAssets discovers teams → projects → files and maps each file to a tokens asset', async () => {
  const fetchImpl = fakeFetch([
    { match: cmd('get-teams'), body: TEAMS },
    { match: cmd('get-projects'), body: PROJECTS },
    { match: cmd('get-project-files'), body: FILES },
  ]);
  const pp = createPenpotProvider('pp1', { baseUrl: BASE }, 'tok-secret', fetchImpl);
  const page = await pp.listAssets();

  assert.equal(page.assets.length, 1);
  const a = page.assets[0];
  assert.equal(a?.remoteId, 'f-aaa');
  assert.equal(a?.name, 'Foundations');
  assert.equal(a?.nativeType, 'tokens', 'stamped tokens so mapping.defaultType lands it as a tokens asset');
  assert.deepEqual(a?.sections, ['Website'], 'project name → section');
  assert.equal(a?.updatedAt, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(a?.formats, [{ format: 'json', remoteRef: 'tokens', filename: 'Foundations.tokens.json' }]);

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.equal(calls[0]?.auth, 'Token tok-secret', 'Token header rides every call');
  assert.ok(calls.every((c) => c.method === 'POST'), 'RPC calls are POST');
});

test('fileIds skips discovery and federates exactly those files', async () => {
  const fetchImpl = fakeFetch([{ match: cmd('get-teams'), body: TEAMS }]);
  const pp = createPenpotProvider('pp2', { baseUrl: BASE, fileIds: ['f-xyz'] }, 'tok', fetchImpl);
  const page = await pp.listAssets();
  assert.deepEqual(page.assets.map((a) => a.remoteId), ['f-xyz']);
  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.equal(calls.length, 0, 'no discovery calls when fileIds is given');
});

test('resolveBlob renders the file tokensLib to DTCG JSON and streams it', async () => {
  const fetchImpl = fakeFetch([{ match: cmd('get-file'), body: FILE_TOKENS }]);
  const pp = createPenpotProvider('pp3', { baseUrl: BASE }, 'tok', fetchImpl);
  const blob = await pp.resolveBlob('f-aaa', 'tokens');
  assert.equal(blob.kind, 'stream');
  if (blob.kind !== 'stream') return;
  assert.equal(blob.contentType, 'application/json');
  const dtcg = JSON.parse(await new Response(blob.body).text());
  assert.equal(dtcg.Global.color.brand['500'].$value, '#c72f2f', 'dot-notation names nest into DTCG groups');
  assert.equal(dtcg.Global.color.brand['500'].$type, 'color');
  assert.equal(dtcg.Global.color.brand['500'].$description, 'brand red');
  assert.equal(dtcg.Global.spacing.md.$value, '16');
  assert.deepEqual(dtcg.$metadata.tokenSetOrder, ['Global'], 'set order in $metadata');
  assert.ok(Array.isArray(dtcg.$themes), '$themes passes through for brand/mode/touchpoint');

  const getFileCall = (fetchImpl as unknown as { calls: Call[] }).calls.find((c) => c.url.endsWith('get-file'));
  assert.match(getFileCall?.body ?? '', /f-aaa/, 'the file id rides the get-file body');
});

test('resolveBlob refuses an unknown format, a bad file id, and a bad board id', async () => {
  const pp = createPenpotProvider('pp4', { baseUrl: BASE }, 'tok', fakeFetch([]));
  await assert.rejects(() => pp.resolveBlob('f-aaa', 'download'), /unsupported format/);
  await assert.rejects(() => pp.resolveBlob('bad id!', 'tokens'), /bad penpot file id/);
  await assert.rejects(() => pp.resolveBlob('not-a-composite', 'render'), /bad penpot board id/);
});

// A file whose pages carry a real board (a frame), the synthetic root frame, and a
// non-frame — only the real board should surface.
const FILE_BOARDS = {
  id: 'f-aaa', name: 'Foundations',
  data: {
    tokensLib: FILE_TOKENS.data.tokensLib,
    pagesIndex: {
      'page-1': { id: 'page-1', name: 'Page 1', objects: {
        '00000000-0000-0000-0000-000000000000': { id: '00000000-0000-0000-0000-000000000000', type: 'frame', name: 'Root Frame' },
        'brd-1': { id: 'brd-1', type: 'frame', name: 'Hero' },
        'txt-1': { id: 'txt-1', type: 'text', name: 'Label' },
      } },
    },
  },
};

test('searchAssets matches files by name and surfaces their boards as media (never auto-federated)', async () => {
  const fetchImpl = fakeFetch([
    { match: cmd('get-teams'), body: TEAMS },
    { match: cmd('get-projects'), body: PROJECTS },
    { match: cmd('get-project-files'), body: FILES },
    { match: cmd('get-file'), body: FILE_BOARDS },
  ]);
  const pp = createPenpotProvider('pp7', { baseUrl: BASE, format: 'png', scale: 2 }, 'tok', fetchImpl);
  assert.equal(pp.capabilities.search, true);

  const found = await pp.searchAssets!('found', 20); // matches "Foundations"
  assert.equal(found.length, 1, 'root frame + non-frame are excluded; one real board');
  const board = found[0];
  assert.equal(board?.name, 'Hero');
  assert.equal(board?.nativeType, 'board');
  assert.equal(board?.remoteId, 'f-aaa_page-1_brd-1', 'composite <file>_<page>_<object> id');
  assert.deepEqual(board?.formats, [{ format: 'png', remoteRef: 'render', filename: 'Hero.png' }]);
  assert.equal(board?.hasThumbnail, true);

  // Auto-federation stays tokens-only: listAssets never returns a board.
  const listed = await pp.listAssets();
  assert.ok(listed.assets.every((a) => a.nativeType === 'tokens'), 'boards are search-only, not federated');
});

test('getAsset resolves a composite id to a board and a plain id to a token ref', async () => {
  const fetchImpl = fakeFetch([{ match: cmd('get-file'), body: FILE_BOARDS }]);
  const pp = createPenpotProvider('pp8', { baseUrl: BASE }, 'tok', fetchImpl);
  const board = await pp.getAsset!('f-aaa_page-1_brd-1');
  assert.equal(board?.nativeType, 'board');
  assert.equal(board?.name, 'Hero');
  const tokens = await pp.getAsset!('f-aaa');
  assert.equal(tokens?.nativeType, 'tokens');
  assert.equal(tokens?.name, 'Foundations');
  assert.equal(await pp.getAsset!('f-aaa_page-1_nope'), null, 'unknown board id → null');
});

test('resolveBlob renders a board via the exporter (POST descriptor → download)', async () => {
  const fetchImpl = fakeFetch([
    { match: (u) => u.endsWith('/api/export'), body: { id: 'render-1' } },
    { match: (u) => u.includes('/api/export?id=render-1'), bytes: 'PNGBYTES' },
  ]);
  const pp = createPenpotProvider('pp9', { baseUrl: BASE }, 'tok', fetchImpl);
  const blob = await pp.resolveBlob('f-aaa_page-1_brd-1', 'render');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'PNGBYTES');

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  const post = calls.find((c) => c.url.endsWith('/api/export'));
  assert.equal(post?.auth, 'Token tok', 'Token header rides the export call');
  assert.match(post?.body ?? '', /export-shapes/);
  assert.match(post?.body ?? '', /"file-id":"f-aaa"/);
  assert.match(post?.body ?? '', /"object-id":"brd-1"/);
});

test('resolveBlob streams exporter bytes directly when it returns an image (no descriptor)', async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.endsWith('/api/export'), bytes: 'DIRECTPNG' }]);
  const pp = createPenpotProvider('pp10', { baseUrl: BASE }, 'tok', fetchImpl);
  const blob = await pp.resolveBlob('f-aaa_page-1_brd-1', 'render');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'DIRECTPNG');
});

test('tokensLibToDtcg tolerates array-shaped sets and a missing lib', () => {
  assert.equal(tokensLibToDtcg(undefined), '{}');
  const arr = tokensLibToDtcg({ sets: [{ name: 'Core', tokens: [{ name: 'radius.sm', type: 'borderRadius', value: '4' }] }] });
  const parsed = JSON.parse(arr);
  assert.equal(parsed.Core.radius.sm.$value, '4');
  assert.deepEqual(parsed.$metadata.tokenSetOrder, ['Core']);
});

test('healthCheck: ok on get-profile 200; a missing credential fails closed', async () => {
  const ok = createPenpotProvider('pp5', { baseUrl: BASE }, 'tok', fakeFetch([{ match: cmd('get-profile'), body: { id: 'u1' } }]));
  assert.equal((await ok.healthCheck()).ok, true);
  const keyless = createPenpotProvider('pp6', { baseUrl: BASE }, undefined, fakeFetch([]));
  assert.equal((await keyless.healthCheck()).ok, false);
});
