/**
 * Brandfolder driver against recorded v4 API shapes (captured from a live
 * brandfolder, 2026-07 - ids real, values trimmed). Injected fetch, no
 * network: mapping (sections → sections, attachments → formats), pagination,
 * search encoding, per-request signed-URL resolution, and the upstream host
 * allowlist that keeps /catalog/ext/* from becoming an open proxy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrandfolderProvider } from '../server/src/catalog/providers/brandfolder.ts';

const BF_ID = 'tc3wvjm7jnpppp62k57qhrp';

const ASSETS_PAGE = {
  data: [{
    id: '255hvp7s4xkbqb9rbncsfqp3',
    type: 'generic_files',
    attributes: {
      name: 'program-logo-positive', description: '', approved: true,
      thumbnail_url: 'https://thumbs.bfldr.com/as/255hvp?expiry=1785337200&sig=x',
      cdn_url: 'https://cdn.bfldr.com/FQEVVFCB/as/255hvp/program-logo-positive',
      updated_at: '2024-09-24T23:14:52.291Z', extension: 'png',
      availability: 'available',
      availability_start: '2024-01-01T00:00:00.000Z', availability_end: '2027-01-01T00:00:00.000Z',
    },
    relationships: {
      section: { data: { id: 'sec1', type: 'sections' } },
      attachments: { data: [{ id: 'njc8wh9647cjst8h55ff38', type: 'attachments' }] },
      tags: { data: [{ id: 'tag1', type: 'tags' }, { id: 'tag1', type: 'tags' }, { id: 'missing', type: 'tags' }, { id: 'tag2', type: 'tags' }] },
      collections: { data: [{ id: 'col1', type: 'collections' }] },
    },
  }],
  included: [
    { id: 'tag1', type: 'tags', attributes: { name: ' SUSE Virtualization ' } },
    { id: 'tag2', type: 'tags', attributes: { name: 42 } },
    { id: 'col1', type: 'collections', attributes: { name: 'Logo Kit' } },
    { id: 'sec1', type: 'sections', attributes: { name: 'Standard Logos', default_asset_type: 'GenericFile', position: 0 } },
    {
      id: 'njc8wh9647cjst8h55ff38', type: 'attachments',
      attributes: { mimetype: 'image/png', extension: 'png', filename: 'x.png', size: 16561, width: 834, height: 626 },
    },
  ],
  meta: { current_page: 1, next_page: 2, prev_page: null, total_pages: 2, total_count: 120 },
};

const ATTACHMENT_DOC = {
  data: {
    id: 'njc8wh9647cjst8h55ff38', type: 'attachments',
    attributes: {
      mimetype: 'image/png', size: 16561,
      url: 'https://storage-us-gcs.bfldr.com/njc8wh/v/123/original/x.png?Expires=1784816608&Signature=sig',
    },
  },
};

function fakeFetch(routes: Array<{ match: (url: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) {
      return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

test('attachment formats discard preview context and fall back to the filename', async () => {
  for (const [extension, filename, expected] of [
    ['mp4 context standalone_preview role work', 'preview.mp4', 'mp4'],
    ['aep context standalone_preview role work', 'project.aep', 'aep'],
    [' invalid suffix ', 'font.OTF', 'otf'],
    [' .3MF ', 'mesh.3mf', '3mf'],
  ]) {
    const doc = structuredClone(ASSETS_PAGE);
    const attachment = doc.included.find(r => r.type === 'attachments')!;
    Object.assign(attachment.attributes, { extension, filename });
    const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fakeFetch([
      { match: u => u.includes(`/brandfolders/${BF_ID}/assets`), body: doc },
    ]));
    assert.equal((await bf.listAssets()).assets[0]?.formats[0]?.format, expected);
  }
});

test('listAssets maps the recorded shape: section names, attachment formats, pagination cursor', async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.includes(`/brandfolders/${BF_ID}/assets`), body: ASSETS_PAGE }]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  const page = await bf.listAssets();
  assert.equal(page.next, '2', 'meta.next_page becomes the cursor');
  const a = page.assets[0];
  assert.equal(a?.remoteId, '255hvp7s4xkbqb9rbncsfqp3');
  assert.equal(a?.name, 'program-logo-positive');
  assert.deepEqual(a?.sections, ['Standard Logos']);
  assert.deepEqual(a?.tags, ['SUSE Virtualization']);
  assert.deepEqual(a?.collections, ['Logo Kit']);
  assert.equal(a?.approved, true);
  assert.equal(a?.hasThumbnail, true);
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'njc8wh9647cjst8h55ff38', size: 16561, filename: 'x.png', width: 834, height: 626 }]);
  // Upstream availability window is imported into the asset ref (plans/27 §2).
  assert.equal(a?.availableFrom, '2024-01-01T00:00:00.000Z');
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z');
  // The v4 availability fields are actually requested.
  const firstCall = (fetchImpl as unknown as { calls: string[] }).calls[0] ?? '';
  assert.ok(firstCall.includes('availability_start') && firstCall.includes('availability_end'), 'availability fields are requested');
  assert.equal(new URL(firstCall).searchParams.get('include'), 'section,attachments,tags,collections');

  await bf.listAssets('2');
  const calls = (fetchImpl as unknown as { calls: string[] }).calls;
  assert.ok(calls[1]?.includes('page=2'), 'cursor drives the page param');
});

test('an asset with no availability attributes carries no window', async () => {
  const bare = { data: [{ id: 'z', type: 'generic_files', attributes: { name: 'bare', extension: 'png' }, relationships: {} }], meta: {} };
  const fetchImpl = fakeFetch([{ match: (u) => u.includes(`/brandfolders/${BF_ID}/assets`), body: bare }]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  const a = (await bf.listAssets()).assets[0];
  assert.equal(a?.availableFrom, undefined);
  assert.equal(a?.availableUntil, undefined);
});

test('searchAssets URL-encodes the query and bearer auth rides every call', async () => {
  let seenAuth = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seenAuth = (init?.headers as Record<string, string>)?.authorization ?? '';
    assert.ok(String(input).includes('search=summit%20%26%20logo'));
    assert.equal(new URL(String(input)).searchParams.get('include'), 'section,attachments,tags,collections');
    return new Response(JSON.stringify({ data: [], included: [] }), { status: 200 });
  }) as typeof fetch;
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'sekret', fetchImpl);
  await bf.searchAssets?.('summit & logo', 10);
  assert.equal(seenAuth, 'Bearer sekret');
});

test('resolveBlob re-fetches a fresh signed URL per request and streams from bfldr hosts only', async () => {
  const fetchImpl = fakeFetch([
    { match: (u) => u.includes('/assets/255hvp7s4xkbqb9rbncsfqp3?'), body: { data: ASSETS_PAGE.data[0] } },
    { match: (u) => u.includes('/attachments/njc8wh9647cjst8h55ff38'), body: ATTACHMENT_DOC },
    { match: (u) => u.startsWith('https://storage-us-gcs.bfldr.com/'), bytes: 'PNGBYTES' },
  ]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  const blob = await bf.resolveBlob('255hvp7s4xkbqb9rbncsfqp3', 'njc8wh9647cjst8h55ff38');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/png');
    assert.equal(blob.size, 16561);
    const text = await new Response(blob.body).text();
    assert.equal(text, 'PNGBYTES');
  }
});

test('an upstream URL outside Brandfolder-owned hosts is refused (no open proxy)', async () => {
  const evil = {
    data: { id: 'x', type: 'attachments', attributes: { url: 'https://bfldr.com.evil.example/steal', mimetype: 'image/png' } },
  };
  const fetchImpl = fakeFetch([
    { match: (u) => u.includes('/assets/a?'), body: { data: { id: 'a', attributes: {}, relationships: { attachments: { data: [{ id: 'x', type: 'attachments' }] } } } } },
    { match: (u) => u.includes('/attachments/'), body: evil },
  ]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  await assert.rejects(() => bf.resolveBlob('a', 'x'), /outside allowed hosts/);
});

test('a guessed attachment cannot bypass the requested asset boundary', async () => {
  const fetchImpl = fakeFetch([{ match: u => u.includes('/assets/allowed?'), body: { data: ASSETS_PAGE.data[0] } }]);
  const bf = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'key', fetchImpl);
  await assert.rejects(bf.resolveBlob('allowed', 'private_attachment'), /does not belong/);
  await assert.rejects(bf.resolveFilePreview!('allowed', 'private_attachment'), /does not belong/);
  assert.equal((fetchImpl as unknown as { calls: string[] }).calls.some(u => u.includes('/attachments/')), false);
});

test('a file preview fetches its thumbnail without downloading the original', async () => {
  const fetchImpl = fakeFetch([
    { match: u => u.includes('/assets/255hvp7s4xkbqb9rbncsfqp3?'), body: { data: ASSETS_PAGE.data[0] } },
    { match: u => u.includes('/attachments/njc8wh9647cjst8h55ff38?fields=thumbnail_url'), body: { data: { attributes: { thumbnail_url: 'https://thumbs.bfldr.com/file-preview' } } } },
    { match: u => u === 'https://thumbs.bfldr.com/file-preview', bytes: 'SMALL_PREVIEW' },
  ]);
  const bf = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'key', fetchImpl);
  const blob = await bf.resolveFilePreview!('255hvp7s4xkbqb9rbncsfqp3', 'njc8wh9647cjst8h55ff38');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'SMALL_PREVIEW');
  assert.equal((fetchImpl as unknown as { calls: string[] }).calls.some(u => u.includes('fields=url')), false);
});

test('healthCheck: ok on 200, detail on 401, and a missing credential fails closed', async () => {
  const ok = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'key',
    fakeFetch([{ match: () => true, body: { data: { id: BF_ID, type: 'brandfolders', attributes: {} } } }]));
  assert.equal((await ok.healthCheck()).ok, true);

  const denied = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'bad',
    fakeFetch([{ match: () => true, body: { errors: [] }, status: 401 }]));
  const h = await denied.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /401/);

  const keyless = createBrandfolderProvider('b', { brandfolderId: BF_ID }, undefined, fakeFetch([]));
  assert.equal((await keyless.healthCheck()).ok, false);
});


test('signed file redirects remain HTTPS on Brandfolder hosts and never forward API credentials', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.includes('/assets/a?')) return Response.json({ data: { attributes: { thumbnail_url: 'https://thumbs.bfldr.com/preview' } } });
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.headers, undefined);
    return new Response(null, { status: 302, headers: { location: 'https://private.example/file' } });
  }) as typeof fetch;
  const bf = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'secret', fetchImpl);
  await assert.rejects(bf.resolveBlob('a', 'thumb'), /outside allowed hosts/);
  assert.equal(calls.some(u => u.startsWith('https://private.example')), false);
  for (const url of ['http://thumbs.bfldr.com/preview', 'https://user:secret@thumbs.bfldr.com/preview']) {
    const bf = createBrandfolderProvider('b', { brandfolderId: BF_ID }, 'key', fakeFetch([{ match: () => true, body: { data: { attributes: { thumbnail_url: url } } } }]));
    await assert.rejects(bf.resolveBlob('a', 'thumb'), /outside allowed hosts/);
  }
});
