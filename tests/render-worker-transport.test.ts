// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:https';
import { workerTransport, readPem } from '../workers/render/src/transport.ts';

test('production worker refuses missing or partial TLS configuration; evaluation HTTP is loopback only', () => {
  const handler = (_req: unknown, res: { end(): void }) => res.end();
  assert.throws(() => workerTransport(handler, { NODE_ENV: 'production' }), /requires TLS/);
  assert.throws(() => workerTransport(handler, { LW_RENDER_DEPLOYMENT_MODE: 'production' }), /requires TLS/);
  assert.throws(() => workerTransport(handler, { LW_RENDER_TLS_CERT_FILE: 'missing' }), /Both/);
  assert.throws(() => workerTransport(handler, { LW_RENDER_DEPLOYMENT_MODE: 'other' }), /mode/);
  const local = workerTransport(handler, { NODE_ENV: 'production', LW_RENDER_DEPLOYMENT_MODE: 'evaluation' });
  assert.equal(local.host, '127.0.0.1'); assert.equal(local.tls, false);
});

test('worker TLS authenticates the service certificate and refuses other authorities and hostnames', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-transport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function certificate(name: string) {
    const cert = join(dir, `${name}.crt`), key = join(dir, `${name}.key`);
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=worker.test', '-addext', 'subjectAltName=DNS:worker.test', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'Disposable certificate generation must succeed');
    return { cert, key };
  }
  const approved = certificate('approved'), other = certificate('other');
  const env = { NODE_ENV: 'production', LW_RENDER_TLS_CERT_FILE: approved.cert, LW_RENDER_TLS_KEY_FILE: approved.key };
  assert.throws(() => workerTransport((_req, res) => res.end(), { ...env, LW_RENDER_TLS_KEY_FILE: other.key }), /do not match/);
  let hits = 0;
  const listener = workerTransport((_req, res) => { hits++; res.end('ready'); }, env);
  assert.equal(listener.tls, true);
  const server = listener.server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = (ca: Buffer, servername: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, servername, ca, path: '/healthz', timeout: 2000 }, res => {
      res.resume(); resolve(res.statusCode!);
    }); req.on('error', reject); req.on('timeout', () => req.destroy()); req.end();
  });
  assert.equal(await get(readFileSync(approved.cert), 'worker.test'), 200);
  await assert.rejects(get(readFileSync(other.cert), 'worker.test'));
  await assert.rejects(get(readFileSync(approved.cert), 'another.test'));
  assert.equal(hits, 1);
  const oversized = join(dir, 'oversized'); writeFileSync(oversized, Buffer.alloc(65537));
  assert.throws(() => readPem(oversized), /Invalid/);
  assert.throws(() => readPem(dir), /Invalid/);
});
