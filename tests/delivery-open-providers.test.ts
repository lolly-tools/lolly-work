// SPDX-License-Identifier: MPL-2.0
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../server/src/lib/crypto.ts';
import { createDeliveryProvider } from '../server/src/delivery/registry.ts';
import { createWebdavDeliveryProvider, webdavDeliveryPath } from '../server/src/delivery/webdav.ts';
import { createHttpsDeliveryProvider, httpsDeliveryCanonical } from '../server/src/delivery/https.ts';

const bytes = new TextEncoder().encode('governed poster');
const input = {
  deliveryId: 'del_safe', bytes, sha256: sha256Hex(bytes), name: '../Launch / Poster',
  format: 'png', contentType: 'image/png',
};

test('WebDAV puts a deterministic flat resource, verifies size and can revoke only an owned path', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const provider = createWebdavDeliveryProvider({
    url: 'https://cloud.example/remote.php/dav/files/team/outgoing',
    prefix: 'approved',
    publicBaseUrl: 'https://files.example/outgoing',
  }, 'team:app-password', async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string> });
    return init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
      : init?.method === 'GET'
        ? new Response(bytes, { status: 200 })
      : new Response(null, { status: 204 });
  });
  const receipt = await provider.deliver(input);
  const path = webdavDeliveryPath({ url: 'https://cloud.example/dav', prefix: 'approved' }, input);
  assert.equal(receipt.remoteId, path);
  assert.match(path, /^approved\/del_safe-[a-f0-9]{16}-Poster\.png$/);
  assert.equal(receipt.url, `https://files.example/outgoing/${path}`);
  assert.equal(receipt.deliveredSha256, input.sha256);
  assert.equal(receipt.transformation, 'none');
  assert.deepEqual(calls.map((call) => call.method), ['PUT', 'HEAD', 'GET']);
  assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from('team:app-password').toString('base64')}`);
  assert.equal(calls[0]!.url, `https://cloud.example/remote.php/dav/files/team/outgoing/${path}`);

  await assert.rejects(provider.revoke!('elsewhere/file.png'), /outside the configured prefix/);
  await provider.revoke!(path);
  assert.equal(calls.at(-1)?.method, 'DELETE');
});

test('WebDAV supports bearer credentials and refuses redirects/size ambiguity', async () => {
  let auth = '';
  const provider = createWebdavDeliveryProvider({ url: 'http://dav.internal/output/' }, 'bearer:token', async (_url, init) => {
    auth = (init?.headers as Record<string, string>).authorization ?? '';
    if (init?.method === 'PUT') {
      assert.equal(init.redirect, 'error');
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 200 });
  });
  await assert.rejects(provider.deliver(input), /size mismatch/);
  assert.equal(auth, 'Bearer token');
  assert.throws(() => createWebdavDeliveryProvider({ url: 'https://user:pass@dav.example/out' }, 'a:b'), /without credentials/);
});

test('signed HTTPS binds delivery metadata and bytes to a versioned HMAC', async () => {
  let call: { url: string; init: RequestInit } | null = null;
  const secret = 'receiver-secret-at-least-32-bytes';
  const timestamp = 1_788_534_000_000;
  const provider = createHttpsDeliveryProvider({ url: 'https://publish.example/lolly?channel=press' }, secret, async (url, init) => {
    call = { url: String(url), init: init! };
    return new Response(JSON.stringify({ id: 'remote-42', url: 'https://publish.example/items/42', sha256: input.sha256 }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  }, () => timestamp);
  const receipt = await provider.deliver(input);
  const captured = call as { url: string; init: RequestInit } | null;
  assert.ok(captured);
  assert.equal(captured.url, 'https://publish.example/lolly?channel=press');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'error');
  const headers = captured.init.headers as Record<string, string>;
  const name = Buffer.from(input.name).toString('base64url');
  const expected = createHmac('sha256', secret)
    .update(httpsDeliveryCanonical(input, String(timestamp), name)).digest('hex');
  assert.equal(headers['x-lolly-name'], name);
  assert.equal(headers['x-lolly-signature'], `v1=${expected}`);
  assert.deepEqual(receipt, {
    remoteId: 'remote-42', url: 'https://publish.example/items/42',
    deliveredSha256: input.sha256, transformation: 'none',
  });
});

test('signed HTTPS reports receiver transformations without pretending byte preservation', async () => {
  const changed = 'f'.repeat(64);
  const transformed = createHttpsDeliveryProvider({ url: 'https://publish.example/lolly' }, 'secret', async () =>
    new Response(JSON.stringify({ id: 'remote-2', sha256: changed }), { status: 200 }));
  assert.equal((await transformed.deliver(input)).transformation, 'provider-managed');

  const noReceipt = createHttpsDeliveryProvider({ url: 'https://publish.example/lolly' }, 'secret', async () =>
    new Response(null, { status: 204 }));
  assert.deepEqual(await noReceipt.deliver(input), { remoteId: input.deliveryId, transformation: 'unknown' });
  assert.throws(() => createHttpsDeliveryProvider({ url: 'http://publish.example/lolly' }, 'secret'), /must be an HTTPS URL/);
});

test('delivery registry exposes both open fixed-target adapters', () => {
  const base = {
    id: 'target', label: 'Target', credentialRef: 'LW_TARGET', enabled: true,
    groups: '*' as const, formats: ['png'], maxBytes: 1024,
  };
  assert.equal(createDeliveryProvider({ ...base, kind: 'webdav', options: { url: 'https://dav.example/out' } }, 'a:b').kind, 'webdav');
  assert.equal(createDeliveryProvider({ ...base, kind: 'https', options: { url: 'https://publish.example/out' } }, 'secret').kind, 'https');
});
