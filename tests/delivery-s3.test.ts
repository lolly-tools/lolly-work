// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createS3DeliveryProvider } from '../server/src/delivery/s3.ts';
import { deliveryContentType } from '../server/src/delivery/destinations.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

test('delivery MIME follows the verified format rather than a caller header', () => {
  assert.equal(deliveryContentType('pdf-cmyk'), 'application/pdf');
  assert.equal(deliveryContentType('m4a'), 'audio/mp4');
  assert.equal(deliveryContentType('html-fragment'), 'text/html; charset=utf-8');
  assert.equal(deliveryContentType('future-format'), 'application/octet-stream');
});

const OPTIONS = {
  bucket: 'creative',
  endpoint: 'https://objects.example',
  region: 'eu-test-1',
  prefix: 'approved/output',
  publicBaseUrl: 'https://files.example',
};

test('S3 delivery uses an immutable scoped key, verifies size, and returns a byte-preserving receipt', async () => {
  const calls: Array<{ url: string; method: string; body?: Uint8Array }> = [];
  let storedSize = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : undefined;
    calls.push({ url: String(input), method, ...(body ? { body } : {}) });
    if (method === 'PUT') {
      storedSize = body?.byteLength ?? 0;
      assert.equal(init?.redirect, 'error');
      assert.match(String((init?.headers as Record<string, string>).authorization), /^AWS4-HMAC-SHA256 /);
      return new Response(null, { status: 200 });
    }
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(storedSize) } });
    return new Response(null, { status: 500 });
  };
  const bytes = new TextEncoder().encode('poster bytes');
  const sha256 = sha256Hex(bytes);
  const provider = createS3DeliveryProvider(OPTIONS, 'access:secret', fakeFetch);
  const receipt = await provider.deliver({
    deliveryId: 'del_safe', bytes, sha256, name: '../Launch / Poster', format: 'PNG', contentType: 'image/png',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, 'PUT');
  assert.match(calls[0]?.url ?? '', /\/creative\/approved\/output\/del_safe\/[a-f0-9]{16}-Poster\.png$/);
  assert.equal(calls[1]?.method, 'HEAD');
  assert.equal(receipt.remoteId, `approved/output/del_safe/${sha256.slice(0, 16)}-Poster.png`);
  assert.equal(receipt.url, `https://files.example/approved/output/del_safe/${sha256.slice(0, 16)}-Poster.png`);
  assert.equal(receipt.deliveredSha256, sha256);
  assert.equal(receipt.transformation, 'none');

  const hyphenated = await provider.deliver({
    deliveryId: 'del_print', bytes, sha256, name: '..', format: 'pdf-cmyk', contentType: 'application/pdf',
  });
  assert.match(hyphenated.remoteId, /-export\.pdf$/);
});

test('S3 delivery refuses a missing credential and a remote-size mismatch', async () => {
  assert.throws(() => createS3DeliveryProvider(OPTIONS, undefined), /credential/);
  const bytes = new Uint8Array([1, 2, 3]);
  const provider = createS3DeliveryProvider(OPTIONS, 'a:b', async (_input, init) =>
    init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-length': '2' } })
      : new Response(null, { status: 200 }));
  await assert.rejects(provider.deliver({
    deliveryId: 'del_mismatch', bytes, sha256: sha256Hex(bytes), name: 'x', format: 'png', contentType: 'image/png',
  }), /size mismatch/);
});

test('S3 revoke is exact and cannot escape a configured prefix', async () => {
  const methods: string[] = [];
  const provider = createS3DeliveryProvider(OPTIONS, 'a:b', async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    return new Response(null, { status: 204 });
  });
  await assert.rejects(provider.revoke!('release/latest.rpm'), /outside the configured prefix/);
  await provider.revoke!('approved/output/del_1/x.png');
  assert.deepEqual(methods, ['DELETE']);
});
