/**
 * OAuth provider kinds (plans/17 §11 phase 4) against recorded API shapes,
 * injected fetch: the shared refresh-token exchange + process-level access
 * token cache (one refresh serves many calls; rotation invalidates), then
 * Dropbox / Google Drive / O365-Graph mapping, streaming, and the host/id
 * guards that keep resolveBlob un-forgeable. Canto joins on the same seam
 * (plans/32 §3): its regional token endpoint derives from the tenant domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAccessToken, invalidateAccessTokens, parseOAuthCredential } from '../server/src/catalog/providers/oauth.ts';
import { createDropboxProvider } from '../server/src/catalog/providers/dropbox.ts';
import { createGdriveProvider } from '../server/src/catalog/providers/gdrive.ts';
import { createO365Provider } from '../server/src/catalog/providers/o365.ts';
import { createCantoProvider } from '../server/src/catalog/providers/canto.ts';

const CRED = JSON.stringify({ clientId: 'app-1', clientSecret: 'cs', refreshToken: 'rt-abc' });

/** fetch stub: token endpoint + API routes, counting token exchanges. */
function oauthFetch(routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let refreshes = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (/oauth2|googleapis\.com\/token|microsoftonline/.test(url) && String(init?.body ?? '').includes('grant_type=refresh_token')) {
      refreshes++;
      return new Response(JSON.stringify({ access_token: `at-${refreshes}`, expires_in: 3600 }), { status: 200 });
    }
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls, refreshes: () => refreshes };
}

test('parseOAuthCredential: JSON contract enforced with a pointer to the auth flow', () => {
  assert.deepEqual(parseOAuthCredential(CRED), { clientId: 'app-1', clientSecret: 'cs', refreshToken: 'rt-abc' });
  assert.throws(() => parseOAuthCredential('just-a-token'), /lw providers auth/);
  assert.throws(() => parseOAuthCredential(JSON.stringify({ clientId: 'x' })), /refreshToken/);
  assert.throws(() => parseOAuthCredential(undefined), /no credential/);
});

test('access tokens cache per provider+grant, expire early, and die on invalidate', async () => {
  const { impl, refreshes } = oauthFetch([]);
  const cred = parseOAuthCredential(JSON.stringify({ clientId: 'a', refreshToken: 'rt-cache-test' }));
  let clock = 1_000_000;
  const now = () => clock;
  const opts = { providerId: 'p-cache', cred, tokenUrl: 'https://api.dropboxapi.com/oauth2/token', fetchImpl: impl, now };
  assert.equal(await getAccessToken(opts), 'at-1');
  assert.equal(await getAccessToken(opts), 'at-1', 'second call hits the cache');
  assert.equal(refreshes(), 1);
  clock += 3600_000; // past expiry
  assert.equal(await getAccessToken(opts), 'at-2', 'expired token re-exchanges');
  invalidateAccessTokens('p-cache');
  await getAccessToken(opts);
  assert.equal(refreshes(), 3, 'invalidate forces a fresh exchange');
});

test('dropbox: list_folder maps files (id remoteId, sections from path), continue cursor, download streams', async () => {
  const entries = [
    { '.tag': 'file', id: 'id:AAA111', name: 'summit.svg', path_display: '/Brand/Logos/summit.svg', size: 900, server_modified: '2026-06-01T00:00:00Z' },
    { '.tag': 'folder', id: 'id:F1', name: 'Logos', path_display: '/Brand/Logos' },
  ];
  const { impl, calls } = oauthFetch([
    { match: (u) => u.endsWith('/files/list_folder'), body: { entries, cursor: 'cur1', has_more: true } },
    { match: (u) => u.endsWith('/files/list_folder/continue'), body: { entries: [], cursor: 'cur2', has_more: false } },
  ]);
  const dbx = createDropboxProvider('dbx1', { path: '/Brand' }, CRED, impl);
  const page = await dbx.listAssets();
  assert.equal(page.next, 'cur1');
  assert.equal(page.assets.length, 1, 'folders dropped');
  const a = page.assets[0];
  assert.equal(a?.remoteId, 'id:AAA111', 'Dropbox file id — rename-stable, slash-free');
  assert.deepEqual(a?.sections, ['Logos']);
  assert.deepEqual(a?.formats, [{ format: 'svg', remoteRef: 'file', filename: 'summit.svg', size: 900 }]);
  const page2 = await dbx.listAssets('cur1');
  assert.equal(page2.next, undefined);
  const apiCall = calls.find((c) => c.url.endsWith('/files/list_folder'));
  assert.equal((apiCall?.init?.headers as Record<string, string>).authorization, 'Bearer at-1');
});

test('dropbox: download streams via content endpoint with the api-arg header', async () => {
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth2/token')) return new Response(JSON.stringify({ access_token: 'at-x', expires_in: 3600 }), { status: 200 });
    assert.equal(url, 'https://content.dropboxapi.com/2/files/download');
    assert.equal((init?.headers as Record<string, string>)['dropbox-api-arg'], JSON.stringify({ path: 'id:AAA111' }));
    return new Response('BYTES', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  }) as typeof fetch;
  const dbx = createDropboxProvider('dbx2', {}, JSON.stringify({ clientId: 'a', refreshToken: 'rt-dbx2' }), impl);
  const blob = await dbx.resolveBlob('id:AAA111', 'file');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'BYTES');
});

test('gdrive: folder-scoped query, native Google Docs filtered, id guard on downloads', async () => {
  const files = [
    { id: 'F123', name: 'badge.png', mimeType: 'image/png', size: '2048', modifiedTime: '2026-05-01T00:00:00Z', fileExtension: 'png' },
    { id: 'D1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
    { id: 'SUB', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
  ];
  const { impl, calls } = oauthFetch([{ match: (u) => u.includes('/drive/v3/files?'), body: { files } }]);
  const gd = createGdriveProvider('gd1', { folderId: 'FOLDER9' }, CRED, impl);
  const page = await gd.listAssets();
  assert.equal(page.assets.length, 1, 'native docs + folders filtered');
  assert.deepEqual(page.assets[0]?.formats, [{ format: 'png', remoteRef: 'media', filename: 'badge.png', size: 2048 }]);
  const listUrl = calls.find((c) => c.url.includes('/drive/v3/files?'))?.url ?? '';
  assert.ok(decodeURIComponent(listUrl.replace(/\+/g, ' ')).includes("'FOLDER9' in parents and trashed=false"), listUrl);
  await assert.rejects(() => gd.resolveBlob('../../etc', 'media'), /bad drive file id/);
});

test('o365: children mapping with parent-path sections, nextLink cursor host-pinned', async () => {
  const value = [
    {
      id: 'ITEM1!abc', name: 'deck-cover.png', size: 512, lastModifiedDateTime: '2026-04-01T00:00:00Z',
      file: { mimeType: 'image/png' }, parentReference: { path: '/drives/d1/root:/Brand/Approved' },
    },
    { id: 'FOLDER1', name: 'Approved', folder: {} },
  ];
  const { impl } = oauthFetch([
    { match: (u) => u.includes('/drives/d1/root/children'), body: { value, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/d1/root/children?$skiptoken=x' } },
  ]);
  const gr = createO365Provider('ms1', { driveId: 'd1', tenant: 'contoso.example' }, CRED, impl);
  const page = await gr.listAssets();
  assert.equal(page.assets.length, 1);
  assert.deepEqual(page.assets[0]?.sections, ['Approved']);
  assert.equal(page.assets[0]?.remoteId, 'ITEM1!abc');
  assert.ok(page.next?.includes('graph.microsoft.com'));

  // A poisoned cursor pointing off-Graph is refused before any fetch.
  await assert.rejects(() => gr.listAssets('https://evil.example/steal'), /outside graph.microsoft.com/);
  await assert.rejects(() => gr.resolveBlob('bad/../id', 'content'), /bad graph item id/);
});

test('canto: the token endpoint follows the regional domain, and the sealed credential is the shared shape', async () => {
  const { impl, calls } = oauthFetch([{ match: (u) => u.includes('/api/v1/image?'), body: { results: [] } }]);
  const de = createCantoProvider('canto-de', { tenant: 'acme', domain: 'de', minGapMs: 0 }, CRED, impl);
  await de.listAssets();
  assert.equal(calls[0]?.url, 'https://oauth.canto.de/oauth/api/oauth2/token', 'regional OAuth server, not the tenant host');
  assert.ok(String(calls[0]?.init?.body ?? '').includes('grant_type=refresh_token'));
  assert.equal((calls[1]?.init?.headers as Record<string, string>).authorization, 'Bearer at-1');

  // tokenUrl overrides the derivation for a tenant Canto support points elsewhere.
  const { impl: impl2, calls: calls2 } = oauthFetch([{ match: (u) => u.includes('/api/v1/image?'), body: { results: [] } }]);
  const pinned = createCantoProvider('canto-pin', { tenant: 'acme', tokenUrl: 'https://oauth.canto.global/oauth/api/oauth2/token', minGapMs: 0 }, CRED, impl2);
  await pinned.listAssets();
  assert.equal(calls2[0]?.url, 'https://oauth.canto.global/oauth/api/oauth2/token');

  // BYOT: no credential means no token exchange and an unhealthy provider, never
  // an anonymous call to the tenant.
  const { impl: impl3, calls: calls3 } = oauthFetch([]);
  const keyless = createCantoProvider('canto-keyless', { tenant: 'acme', minGapMs: 0 }, undefined, impl3);
  const h = await keyless.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /no credential/);
  assert.equal(calls3.length, 0);
});

test('a revoked grant surfaces as an unhealthy provider, not a crash', async () => {
  const impl = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch;
  const dbx = createDropboxProvider('dbx3', {}, JSON.stringify({ clientId: 'a', refreshToken: 'rt-revoked' }), impl);
  const h = await dbx.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /providers auth/);
});
