/**
 * The render worker's egress rule (plans/58 WP0, workers/render/src/egress.ts): a
 * rendered page reaches the shell it was sent to, the operator's declared origins,
 * and public addresses, and nothing inside the cluster or the cloud's metadata
 * service. DNS is a stub throughout, so no test depends on the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRequest, declaredOrigins, egressChecker, isPublicAddress } from '../workers/render/src/egress.ts';

const declared = declaredOrigins('http://lolly-web.lolly.svc:8080', 'https://assets.internal.example,http://10.0.4.20:9000');
const dns = (answers: Record<string, string[]>) => async (host: string) => answers[host] ?? [];
const verdict = (url: string, answers: Record<string, string[]> = {}) => checkRequest(url, declared, dns(answers));

test('cloud metadata, loopback, private ranges and their disguises are refused', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8787/api/v1/admin',
    'http://2130706433/', // 127.0.0.1 written as one integer; the URL parser normalises it
    'http://0x7f.1/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://0.0.0.0/',
  ]) assert.equal((await verdict(url)).allow, false, url);
});

test('a name is allowed only when every answer is public, and never when unresolved', async () => {
  assert.equal((await verdict('https://fonts.example/a.css', { 'fonts.example': ['93.184.216.34'] })).allow, true);
  assert.equal((await verdict('https://rebind.example/', { 'rebind.example': ['93.184.216.34', '10.0.0.5'] })).allow, false, 'one private answer refuses');
  assert.equal((await verdict('https://kubernetes.default.svc/', { 'kubernetes.default.svc': ['10.43.0.1'] })).allow, false);
  const unresolved = await verdict('https://nowhere.invalid/');
  assert.deepEqual(unresolved, { allow: false, reason: 'unresolved name' });
});

test('the shell base and the operator\'s declared origins are allowed as declared, private or not', async () => {
  assert.equal((await verdict('http://lolly-web.lolly.svc:8080/t/qr-code?format=svg')).allow, true);
  assert.equal((await verdict('https://assets.internal.example/logo.svg')).allow, true);
  assert.equal((await verdict('http://10.0.4.20:9000/x.png')).allow, true);
  assert.equal((await verdict('http://10.0.4.20:9001/x.png')).allow, false, 'another port is another origin');
});

test('page-internal schemes pass, other schemes and model weights are refused', async () => {
  assert.equal((await verdict('data:image/png;base64,AAAA')).allow, true);
  assert.equal((await verdict('blob:http://lolly-web.lolly.svc:8080/1234')).allow, true);
  assert.equal((await verdict('about:blank')).allow, true);
  assert.equal((await verdict('file:///etc/passwd')).allow, false);
  assert.equal((await verdict('ftp://93.184.216.34/x')).allow, false);
  assert.equal((await verdict('http://lolly-web.lolly.svc:8080/models/ocr/model.onnx')).allow, false, 'even from the shell');
  assert.equal((await verdict('https://cdn.example/w.gguf', { 'cdn.example': ['93.184.216.34'] })).allow, false);
});

test('declared origins must be plain origins; a bad entry fails at start-up', () => {
  assert.throws(() => declaredOrigins('http://shell.test', 'https://x.example/path'), /credential-free origins/);
  assert.throws(() => declaredOrigins('http://shell.test', 'https://user:pw@x.example'), /credential-free origins/);
  assert.throws(() => declaredOrigins('http://shell.test', 'ftp://x.example'), /http\(s\)/);
  assert.throws(() => declaredOrigins('not a url'), /absolute URLs/);
  assert.deepEqual([...declaredOrigins('https://lolly.tools/', ' , ')], ['https://lolly.tools']);
});

test('the checker resolves each host once per context', async () => {
  let lookups = 0;
  const check = egressChecker(declared, async () => { lookups++; return ['93.184.216.34']; });
  await Promise.all([check('https://a.example/1'), check('https://a.example/2'), check('https://a.example/3')]);
  assert.equal(lookups, 1);
});

test('isPublicAddress agrees with the documented ranges', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('198.18.0.1'), false);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('both /render and /rasterise send every request through the egress rule', () => {
  const src = readFileSync(new URL('../workers/render/src/server.ts', import.meta.url), 'utf8');
  const handlers = src.match(/await ctx\.route\('\*\*\/\*'/g) ?? [];
  const checks = src.match(/const verdict = await egress\(raw\);\s*if \(!verdict\.allow\)/g) ?? [];
  assert.equal(handlers.length, 2, 'two request routers');
  assert.equal(checks.length, 2, 'each consults the egress rule first');
  assert.match(src, /routeWebSocket\?\.\('\*\*'/, 'WebSockets are refused');
  assert.match(src, /--force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
});
