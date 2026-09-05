// SPDX-License-Identifier: MPL-2.0
/**
 * Gated interoperability canary for the project's UpCloud S3-compatible file
 * host. This is NOT a user-upload destination: it writes one inert random
 * object beneath the checksum-excluded models/ technical prefix, verifies the
 * origin bytes, and deletes that exact object in finally.
 *
 * Run only with explicit local credentials:
 *   LW_S3_CANARY=1 \
 *   LW_S3_CANARY_ACCESS_KEY=... LW_S3_CANARY_SECRET_KEY=... \
 *   LW_S3_CANARY_ENDPOINT=... LW_S3_CANARY_REGION=... \
 *   LW_S3_CANARY_BUCKET=... node --test tests/s3-upcloud-canary.test.ts
 */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signS3Request } from '../server/src/catalog/providers/s3.ts';
import { createS3DeliveryProvider, s3DeliveryKey, type S3DeliveryOptions } from '../server/src/delivery/s3.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const enabled = process.env.LW_S3_CANARY === '1';

test('UpCloud accepts the generic S3 delivery wire contract', { skip: !enabled && 'set LW_S3_CANARY=1 explicitly' }, async () => {
  const accessKeyId = process.env.LW_S3_CANARY_ACCESS_KEY;
  const secretAccessKey = process.env.LW_S3_CANARY_SECRET_KEY;
  const endpoint = process.env.LW_S3_CANARY_ENDPOINT;
  const region = process.env.LW_S3_CANARY_REGION;
  const bucket = process.env.LW_S3_CANARY_BUCKET;
  assert.ok(accessKeyId && secretAccessKey && endpoint && region && bucket, 'all LW_S3_CANARY_* settings are required');

  const options: S3DeliveryOptions = {
    endpoint, region, bucket,
    prefix: 'models/.canary/lolly-work-delivery',
  };
  const deliveryId = `canary-${randomUUID()}`;
  const bytes = new TextEncoder().encode('lolly-work s3 delivery canary v1\n');
  const sha256 = sha256Hex(bytes);
  const input = { deliveryId, bytes, sha256, name: 'canary', format: 'txt', contentType: 'text/plain; charset=utf-8' };
  const remoteId = s3DeliveryKey(options, input);
  const provider = createS3DeliveryProvider(options, `${accessKeyId}:${secretAccessKey}`);

  try {
    const receipt = await provider.deliver(input);
    assert.equal(receipt.remoteId, remoteId);
    const signed = signS3Request({ options, accessKeyId, secretAccessKey, key: remoteId });
    const response = await fetch(signed.url, { headers: signed.headers, redirect: 'error' });
    assert.equal(response.status, 200);
    assert.equal(sha256Hex(new Uint8Array(await response.arrayBuffer())), sha256);
  } finally {
    await provider.revoke!(remoteId);
    const signed = signS3Request({ options, accessKeyId, secretAccessKey, key: remoteId, method: 'HEAD' });
    const gone = await fetch(signed.url, { method: 'HEAD', headers: signed.headers, redirect: 'error' });
    assert.equal(gone.status, 404, `canary cleanup failed for exact key ${remoteId}`);
  }
});
