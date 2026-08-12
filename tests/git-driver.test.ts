/**
 * Git repo driver: manifest-as-allowlist (only listed paths ever fetch),
 * raw-base host pinning, auth header variants (Bearer default, forge-specific
 * override), and the text/plain content-type remap raw endpoints need.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitProvider } from '../server/src/catalog/providers/git.ts';

const MANIFEST = {
  assets: [
    { path: 'logos/summit.svg', name: 'Summit Logo', sections: ['Logos'], tags: ['event'] },
    { path: '../../etc/passwd', name: 'nope' }, // traversal — must be filtered
  ],
};

function repoFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/lolly-catalog.json')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
    if (url.endsWith('/logos/summit.svg')) return new Response('<svg/>', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const RAW = 'https://raw.githubusercontent.com/acme/brand/main';

test('listAssets: manifest maps to assets, traversal paths filtered, filename carried for provenance', async () => {
  const { impl } = repoFetch();
  const git = createGitProvider('repo1', { rawBase: RAW }, undefined, impl);
  const { assets } = await git.listAssets();
  assert.equal(assets.length, 1, 'traversal entry filtered out');
  const a = assets[0];
  assert.equal(a?.name, 'Summit Logo');
  assert.deepEqual(a?.sections, ['Logos']);
  assert.deepEqual(a?.formats, [{ format: 'svg', remoteRef: 'file', filename: 'summit.svg' }]);
});

test('resolveBlob: manifest is the allowlist; listed path streams with the ext-mapped content type', async () => {
  const { impl } = repoFetch();
  const git = createGitProvider('repo1', { rawBase: RAW }, undefined, impl);
  const listed = Buffer.from('logos/summit.svg').toString('base64url');
  const blob = await git.resolveBlob(listed, 'file');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/svg+xml', 'text/plain from the raw endpoint remapped by extension');
    assert.equal(await new Response(blob.body).text(), '<svg/>');
  }
  const unlisted = Buffer.from('README.md').toString('base64url');
  await assert.rejects(() => git.resolveBlob(unlisted, 'file'), /not in the repo manifest/);
});

test('auth: Bearer by default, forge-specific header when configured, none when public', async () => {
  const bearer = repoFetch();
  await createGitProvider('r', { rawBase: RAW }, 'tok123', bearer.impl).healthCheck();
  assert.equal(bearer.calls[0]?.headers.authorization, 'Bearer tok123');

  const gitlab = repoFetch();
  await createGitProvider('r', { rawBase: RAW, authHeader: 'PRIVATE-TOKEN' }, 'tok123', gitlab.impl).healthCheck();
  assert.equal(gitlab.calls[0]?.headers['PRIVATE-TOKEN'], 'tok123');
  assert.equal(gitlab.calls[0]?.headers.authorization, undefined);

  const anon = repoFetch();
  await createGitProvider('r', { rawBase: RAW }, undefined, anon.impl).healthCheck();
  assert.equal(anon.calls[0]?.headers.authorization, undefined);
});
