// SPDX-License-Identifier: MPL-2.0
/**
 * Gated interoperability canary for the WebDAV delivery adapter against a real
 * server (Nextcloud, ownCloud or plain RFC 4918 DAV). Point it at an existing
 * collection set aside for the canary. It writes one inert object under a
 * random delivery id, repeats the write to prove a retry overwrites the same
 * resource, reads the bytes back independently, and deletes that exact path in
 * finally. It never creates folders, never lists the collection and never
 * prints the credential.
 *
 * Run only with explicit local credentials:
 *   LW_WEBDAV_CANARY=1 \
 *   LW_WEBDAV_CANARY_URL=https://cloud.example/remote.php/dav/files/<user>/<canary-folder> \
 *   LW_WEBDAV_CANARY_CREDENTIAL='<username>:<app-password>' \
 *   node --test tests/webdav-delivery-canary.test.ts
 *
 * LW_WEBDAV_CANARY_CREDENTIAL also accepts 'bearer:<token>'.
 * LW_WEBDAV_CANARY_PREFIX optionally names an existing subdirectory of the collection.
 */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWebdavDeliveryProvider, webdavDeliveryPath, type WebdavDeliveryOptions } from '../server/src/delivery/webdav.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const enabled = process.env.LW_WEBDAV_CANARY === '1';

/** Built here rather than imported, so a path the adapter computes differently fails the read-back. */
function exactUrl(collection: string, remoteId: string): string {
  const url = new URL(collection);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += remoteId.split('/').map(encodeURIComponent).join('/');
  return url.toString();
}

function authorization(credential: string): string {
  return credential.toLowerCase().startsWith('bearer:')
    ? `Bearer ${credential.slice('bearer:'.length).trim()}`
    : `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

test('a live WebDAV server accepts the fixed delivery wire contract', { skip: !enabled && 'set LW_WEBDAV_CANARY=1 explicitly' }, async (t) => {
  const url = process.env.LW_WEBDAV_CANARY_URL;
  const credential = process.env.LW_WEBDAV_CANARY_CREDENTIAL;
  assert.ok(url && credential, 'LW_WEBDAV_CANARY_URL and LW_WEBDAV_CANARY_CREDENTIAL are required');

  const options: WebdavDeliveryOptions = {
    url,
    ...(process.env.LW_WEBDAV_CANARY_PREFIX ? { prefix: process.env.LW_WEBDAV_CANARY_PREFIX } : {}),
  };
  const deliveryId = `canary-${randomUUID()}`;
  const bytes = new TextEncoder().encode('lolly-work webdav delivery canary v1\n');
  const sha256 = sha256Hex(bytes);
  const input = { deliveryId, bytes, sha256, name: 'canary', format: 'txt', contentType: 'text/plain; charset=utf-8' };
  // Computed before any request, so cleanup knows the exact path even when delivery fails part way.
  const remoteId = webdavDeliveryPath(options, input);
  const resource = exactUrl(url, remoteId);
  const auth = authorization(credential);
  const provider = createWebdavDeliveryProvider(options, credential);
  t.diagnostic(`canary path ${remoteId}`);

  try {
    const receipt = await provider.deliver(input);
    assert.equal(receipt.remoteId, remoteId);
    assert.equal(receipt.deliveredSha256, sha256);
    assert.equal(receipt.transformation, 'none');

    // A retry reuses the delivery id, so it must overwrite the same resource.
    const retry = await provider.deliver(input);
    assert.equal(retry.remoteId, remoteId);
    assert.equal(retry.deliveredSha256, sha256);

    const response = await fetch(resource, { headers: { authorization: auth }, redirect: 'error' });
    assert.equal(response.status, 200);
    assert.equal(sha256Hex(new Uint8Array(await response.arrayBuffer())), sha256);
  } finally {
    await provider.revoke!(remoteId);
    const gone = await fetch(resource, { method: 'HEAD', headers: { authorization: auth }, redirect: 'error' });
    assert.equal(gone.status, 404, `canary cleanup failed for exact path ${remoteId}`);
  }
});
