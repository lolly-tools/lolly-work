/**
 * Brandfolder driver against recorded v4 API shapes (captured from a live
 * brandfolder, 2026-07 — ids real, values trimmed). Injected fetch, no
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
    },
    relationships: {
      section: { data: { id: 'sec1', type: 'sections' } },
      attachments: { data: [{ id: 'njc8wh9647cjst8h55ff38', type: 'attachments' }] },
    },
  }],
  included: [
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

test('listAssets maps the recorded shape: section names, attachment formats, pagination cursor', async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.includes(`/brandfolders/${BF_ID}/assets`), body: ASSETS_PAGE }]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  const page = await bf.listAssets();
  assert.equal(page.next, '2', 'meta.next_page becomes the cursor');
  const a = page.assets[0];
  assert.equal(a?.remoteId, '255hvp7s4xkbqb9rbncsfqp3');
  assert.equal(a?.name, 'program-logo-positive');
  assert.deepEqual(a?.sections, ['Standard Logos']);
  assert.equal(a?.approved, true);
  assert.equal(a?.hasThumbnail, true);
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'njc8wh9647cjst8h55ff38', size: 16561, filename: 'x.png' }]);

  await bf.listAssets('2');
  const calls = (fetchImpl as unknown as { calls: string[] }).calls;
  assert.ok(calls[1]?.includes('page=2'), 'cursor drives the page param');
});

test('searchAssets URL-encodes the query and bearer auth rides every call', async () => {
  let seenAuth = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seenAuth = (init?.headers as Record<string, string>)?.authorization ?? '';
    assert.ok(String(input).includes('search=summit%20%26%20logo'));
    return new Response(JSON.stringify({ data: [], included: [] }), { status: 200 });
  }) as typeof fetch;
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'sekret', fetchImpl);
  await bf.searchAssets?.('summit & logo', 10);
  assert.equal(seenAuth, 'Bearer sekret');
});

test('resolveBlob re-fetches a fresh signed URL per request and streams from bfldr hosts only', async () => {
  const fetchImpl = fakeFetch([
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
  const fetchImpl = fakeFetch([{ match: (u) => u.includes('/attachments/'), body: evil }]);
  const bf = createBrandfolderProvider('suse-bf', { brandfolderId: BF_ID }, 'key', fetchImpl);
  await assert.rejects(() => bf.resolveBlob('a', 'x'), /outside allowed hosts/);
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
