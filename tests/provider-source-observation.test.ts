// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFragment, mapProviderAsset, passesExposure } from '../server/src/catalog/federation.ts';
import { createBrandfolderProvider } from '../server/src/catalog/providers/brandfolder.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const record: ProviderRecord = {
  id: 'fixture', kind: 'brandfolder', label: 'Fixture source', managedBy: 'db', enabled: true,
  options: {}, mapping: {}, exposure: { groups: '*' }, sync: {},
  createdAt: '2026-10-15', updatedAt: '2026-10-15', state: { assetCount: 0 },
};

type FileProjection = { id: string; name: string; url: string; thumbnail: string };
const filesOf = (entry: ReturnType<typeof mapProviderAsset>): FileProjection[] =>
  (entry.meta as { assetFiles: FileProjection[] }).assetFiles;

function source() {
  const state = { bytes: '<svg><path d="M0 0"/></svg>', updatedAt: '2026-10-15T10:00:00Z', reverse: false,
    approved: true as boolean | undefined };
  const attachmentIds = ['wide', 'square'];
  const resource = () => ({
    id: 'artwork', type: 'generic_files',
    attributes: { name: 'Artwork', updated_at: state.updatedAt, approved: state.approved },
    relationships: { attachments: { data: (state.reverse ? [...attachmentIds].reverse() : attachmentIds)
      .map(id => ({ id, type: 'attachments' })) } },
  });
  const driver = createBrandfolderProvider('fixture', { brandfolderId: 'library' }, 'fixture-key', async input => {
    const url = new URL(String(input));
    if (url.hostname === 'bytes.bfldr.com') {
      return new Response(url.pathname.endsWith('/preview') ? 'preview-only' : state.bytes,
        { headers: { 'content-type': url.pathname.endsWith('/preview') ? 'image/png' : 'image/svg+xml' } });
    }
    if (url.pathname.endsWith('/assets/artwork')) return Response.json({ data: resource() });
    if (url.pathname.includes('/attachments/')) {
      const id = url.pathname.split('/').at(-1)!;
      return Response.json({ data: { id, type: 'attachments', attributes: {
        url: `https://bytes.bfldr.com/${id}/original?signature=fixture`,
        thumbnail_url: `https://bytes.bfldr.com/${id}/preview?signature=fixture`, mimetype: 'image/svg+xml',
      } } });
    }
    if (url.pathname.endsWith('/brandfolders/library/assets')) {
      return Response.json({ data: [resource()], included: attachmentIds.map(id => ({
        id, type: 'attachments', attributes: { extension: 'svg', filename: `${id}.svg`, size: state.bytes.length },
      })) });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  return {
    state, driver,
    async entry() { return mapProviderAsset(record, (await driver.listAssets()).assets[0]!); },
    async original(id = 'square') {
      const resolved = await driver.resolveBlob('artwork', id);
      assert.equal(resolved.kind, 'stream');
      if (resolved.kind !== 'stream') throw new Error('Expected a streamed original');
      return new Uint8Array(await new Response(resolved.body).arrayBuffer());
    },
  };
}

test('same-format attachment identity survives reordering and preview resolution stays separate', async () => {
  const fixture = source();
  const before = await fixture.entry();
  const files = filesOf(before);
  assert.equal(files.length, 2);
  assert.notEqual(files[0]!.id, files[1]!.id);
  const selected = files.find(file => file.name === 'square.svg')!;
  assert.match(selected.url, /\/square$/);
  assert.equal(selected.thumbnail, `${selected.url}?preview=1`);
  assert.doesNotMatch(JSON.stringify(before), /signature=|fixture-key/);
  fixture.state.reverse = true;
  const after = await fixture.entry();
  const reordered = filesOf(after);
  assert.equal(reordered.find(file => file.name === 'square.svg')!.id, selected.id);
  const preview = await fixture.driver.resolveFilePreview!('artwork', 'square');
  assert.equal(preview.kind, 'stream');
  if (preview.kind !== 'stream') throw new Error('Expected a streamed preview');
  assert.equal(await new Response(preview.body).text(), 'preview-only');
  assert.equal(new TextDecoder().decode(await fixture.original()), fixture.state.bytes);
});

test('byte observations distinguish an overwrite that the metadata cache token cannot detect', async () => {
  const fixture = source();
  const before = await fixture.entry();
  const original = await fixture.original();
  fixture.state.bytes = '<svg><path d="M1 0"/></svg>';
  const after = await fixture.entry();
  const replacement = await fixture.original();
  assert.equal(original.byteLength, replacement.byteLength);
  assert.equal(before.version, after.version, 'unchanged source metadata has the same cache token');
  assert.notEqual(sha256Hex(original), sha256Hex(replacement), 'the observed bytes changed');
  assert.equal(after.formats![0]!.checksum, undefined, 'the projection has no observed byte digest');
  fixture.state.updatedAt = '2026-10-15T11:00:00Z';
  assert.notEqual((await fixture.entry()).version, after.version, 'a metadata change moves the cache token');
  assert.equal(sha256Hex(await fixture.original()), sha256Hex(replacement), 'the metadata change did not change bytes');
});

test('fresh exposure is independent of the byte digest and mapped cache token', async () => {
  const fixture = source();
  const restricted: ProviderRecord = { ...record, exposure: { groups: '*', requireApproved: true } };
  const before = (await fixture.driver.listAssets()).assets[0]!;
  const digest = sha256Hex(await fixture.original());
  assert.equal(passesExposure(restricted, before), true);
  assert.equal((await buildFragment(restricted, fixture.driver, () => 0)).assets.length, 1);

  for (const approved of [false, undefined]) {
    fixture.state.approved = approved;
    const after = (await fixture.driver.listAssets()).assets[0]!;
    assert.equal(mapProviderAsset(restricted, after).version, mapProviderAsset(restricted, before).version);
    assert.equal(sha256Hex(await fixture.original()), digest);
    assert.equal(passesExposure(restricted, after), false);
    assert.equal((await buildFragment(restricted, fixture.driver, () => 0)).assets.length, 0);
  }
  assert.equal(before.approved, true, 'the earlier observation stays historical');
});
