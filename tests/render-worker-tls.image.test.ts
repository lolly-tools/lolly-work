// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';

test('built worker authenticates TLS and HMAC and renders with the actual Linux sandbox', {
  skip: process.env.LOLLY_RENDER_TLS_IMAGE_TEST !== '1' && 'Run in the built worker image with its reviewed sandbox policy.', timeout: 45000,
}, async t => {
  assert.equal(process.getuid?.(), 1000); assert.equal(process.platform, 'linux');
  assert.equal(process.versions.node, '26.12.0');
  const directory = mkdtempSync(join(tmpdir(), 'worker-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cert = join(directory, 'tls.crt'), key = join(directory, 'tls.key');
  const created = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=worker.invalid', '-addext', 'subjectAltName=DNS:worker.invalid', '-keyout', key, '-out', cert], { encoding: 'utf8' });
  assert.equal(created.status, 0, 'Disposable certificate generation must succeed');
  const secret = randomUUID();
  Object.assign(process.env, { PORT: '0', LW_RENDER_DEPLOYMENT_MODE: 'production', LW_RENDER_WORKER_SECRET: secret,
    LOLLY_WEB_BASE: 'https://example.invalid', LW_RENDER_TLS_CERT_FILE: cert, LW_RENDER_TLS_KEY_FILE: key,
    LW_RENDER_TLS_SERVER_NAME: 'worker.invalid', LW_RENDER_TLS_CA_FILE: cert });
  const source: string = '/app/src/server.ts';
  const worker = await import(source);
  const server = worker.server;
  await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once('listening', resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, body?: string, signature?: string, servername = 'worker.invalid', ca: Buffer | undefined = readFileSync(cert)) => new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, servername, ca, path, method: body ? 'POST' : 'GET', timeout: 15000,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(signature ? { 'x-lw-render-sig': signature } : {}) } : {} }, res => {
      const chunks: Buffer[] = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.on('timeout', () => req.destroy()); req.end(body);
  });
  assert.equal((await call('/healthz')).status, 200);
  await assert.rejects(call('/healthz', undefined, undefined, 'another.invalid'));
  await assert.rejects(call('/healthz', undefined, undefined, 'worker.invalid', Buffer.alloc(0)));
  const denied = JSON.stringify({ svg: '<svg/>', format: 'png', ts: Date.now() });
  assert.equal((await call('/rasterise', denied)).status, 401);
  assert.equal((await call('/readyz')).status, 503);
  const browser = await worker.getBrowser(); t.after(() => browser.close());
  const evidenceSource: string = '/app/src/sandbox-evidence.ts';
  const { linuxSandboxEvidence } = await import(evidenceSource);
  assert.deepEqual(await linuxSandboxEvidence(browser), { rendererNamespace: true, rendererSeccomp: true, noCapabilities: true });
  assert.equal((await call('/readyz')).status, 200);
  for (const format of ['png', 'pdf']) {
    const body = JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#123456"/></svg>', format, ts: Date.now() });
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    const response = await call('/rasterise', body, signature); assert.equal(response.status, 200);
    const result = JSON.parse(response.bytes.toString()) as { bytesB64: string };
    const bytes = Buffer.from(result.bytesB64, 'base64');
    assert.ok(bytes.length > 100);
    assert.equal(format === 'png' ? bytes.subarray(0, 8).toString('hex') : bytes.subarray(0, 5).toString(), format === 'png' ? '89504e470d0a1a0a' : '%PDF-');
  }
  const health = (name: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['/app/src/healthcheck.ts'], { env: { ...process.env, PORT: String(address.port), LW_RENDER_TLS_SERVER_NAME: name }, timeout: 5000, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(await health('worker.invalid'), 0, 'The image healthcheck must verify the actual TLS endpoint');
  assert.equal(await health('another.invalid'), 1);
});
