// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serviceUrl } from '../server/src/lib/service-url.ts';
import { loadSecrets, parseConfig } from '../server/src/config/instance.ts';
import { renderViaWorker } from '../server/src/render/worker-client.ts';

test('credential service URLs require production HTTPS and allow only explicit loopback evaluation', () => {
  assert.equal(serviceUrl('https://service.example.test:8443/base/', true), 'https://service.example.test:8443/base');
  for (const value of ['http://localhost:8791', 'http://127.0.0.1:8791', 'http://[::1]:8791']) {
    assert.equal(serviceUrl(value, false), value); assert.throws(() => serviceUrl(value, true), /HTTPS/);
  }
  for (const value of ['http://service.internal', 'http://127.1', 'http://2130706433', 'https://owner:password@service.test',
    'https://service.test?credential=value', 'https://service.test#part', 'https://service.test\\other', ' https://service.test', 'ftp://service.test']) {
    assert.throws(() => serviceUrl(value, false), /HTTPS/);
  }
  const config = { deployment: { mode: 'production' }, policy: { defaultAccessMode: 'open' } };
  for (const section of ['siem', 'render']) {
    const entry = section === 'siem' ? { siem: { url: 'http://127.0.0.1:8791' } } : { render: { worker: { url: 'http://127.0.0.1:8791' } } };
    assert.throws(() => parseConfig(JSON.stringify({ ...config, ...entry })), /requires HTTPS/);
  }
  assert.throws(() => loadSecrets({ NODE_ENV: 'production', NODE_TLS_REJECT_UNAUTHORIZED: '0', LW_SESSION_SECRET: 'owned-session', LW_LINK_SECRET: 'owned-link' }), /TLS certificate verification/);
});

test('a worker redirect cannot forward the signed request to another endpoint', async t => {
  let redirected = 0;
  const receiver = createServer((req, res) => {
    if (req.url === '/render') { res.writeHead(307, { location: '/other' }); res.end(); return; }
    redirected++; res.end('{}');
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => receiver.close(() => resolve())));
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const job = { toolId: 'sample', query: '', overrides: {}, profile: {}, format: 'svg' as const };
  await assert.rejects(renderViaWorker({ url, secret: 'owned-transport', timeoutMs: 2000 }, job), /unreachable/);
  assert.equal(redirected, 0);
  await assert.rejects(renderViaWorker({ url, requireHttps: true, secret: 'owned-transport', timeoutMs: 2000 }, job), /verified HTTPS/);
  assert.equal(redirected, 0);
});
