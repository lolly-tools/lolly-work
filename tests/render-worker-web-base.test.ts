// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWebBase } from '../workers/render/src/web-base.ts';

test('render browser base accepts trusted HTTPS and explicit loopback development', () => {
  for (const base of ['https://lolly.ing', 'https://shell.internal:8443/lolly',
    'https://[2001:db8::1]:8443', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    assert.equal(renderWebBase(`${base}/`), base);
  }
});

test('render browser base refuses insecure deployments and URL ambiguity without logging values', () => {
  for (const base of ['', 'http://lolly-work.lolly-private.svc.cluster.local',
    'http://10.4.27.58:8787', 'http://lolly.ing', 'http://localhost.evil.test',
    'http://127.1', 'http://2130706433', 'ftp://lolly.ing', '//lolly.ing',
    'https://owner:secret@lolly.ing', 'https://lolly.ing?token=secret',
    'https://lolly.ing#fragment', 'https://lolly.ing\\evil', ' https://lolly.ing',
    'https://', 'https://lolly.ing:bad', 'https://lolly.ing:65536']) {
    assert.throws(() => renderWebBase(base), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /must be a HTTPS shell URL with trusted TLS/);
      assert.ok(!error.message.includes('secret'));
      return true;
    }, base);
  }
});
