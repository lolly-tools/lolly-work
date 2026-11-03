// SPDX-License-Identifier: MPL-2.0
/**
 * `lw edge probe` against a mocked edge: a well-behaved edge passes; one that
 * caches private answers or errors, rewrites security headers, leaks purge
 * tags, answers /cdn-cgi/image/ or serves private routes on a public-only
 * hostname fails. The probe sends no credential of any kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeProbe, servedFromCache } from '../server/src/edge/probe.ts';

const SECURITY = { 'content-security-policy': "default-src 'self'", 'cross-origin-opener-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

function edge(behaviour: { cachePrivate?: boolean; rewriteCsp?: boolean; leakTags?: boolean; transforms?: boolean; publicOnlyRefusal?: boolean }) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url: url.href, headers: init?.headers as Record<string, string> });
    const origin = url.hostname === 'origin.example.eu';
    if (url.pathname === '/api/auth/session') {
      if (behaviour.publicOnlyRefusal) return new Response('{"error":{"code":"PUBLIC_HOST_ONLY"}}', { status: 404, headers: { 'cache-control': 'private, no-store, max-age=0, no-transform', 'cdn-cache-control': 'no-store' } });
      return new Response('{}', { status: 401, headers: { 'cache-control': 'private, no-store, max-age=0, no-transform', 'cdn-cache-control': 'no-store', ...(behaviour.cachePrivate ? { age: '12', 'cf-cache-status': 'HIT' } : {}) } });
    }
    if (url.pathname.startsWith('/api/v1/edge-probe-missing-')) return new Response('', { status: 404, headers: { 'cache-control': 'private, no-store', ...(behaviour.cachePrivate ? { 'cdn-cache': 'HIT' } : {}) } });
    if (url.pathname === '/') return new Response('<!doctype html>', { status: 200, headers: { ...SECURITY, ...(behaviour.rewriteCsp && !origin ? { 'content-security-policy': "default-src 'self' 'unsafe-inline'" } : {}) } });
    if (url.pathname === '/api/brand') return new Response('{}', { status: 200, headers: { 'cache-control': 'public, max-age=0', ...(behaviour.leakTags ? { 'cdn-tag': 'b_0123456789abcdef' } : {}) } });
    if (url.pathname.startsWith('/cdn-cgi/image/')) return new Response(behaviour.transforms ? 'png' : 'no', { status: behaviour.transforms ? 200 : 404 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const statuses = (findings: Array<{ id: string; status: string }>) => Object.fromEntries(findings.map(f => [f.id, f.status]));

test('a well-behaved edge passes, and the probe sends no credential', async () => {
  const { fetchImpl, sent } = edge({});
  const findings = await runEdgeProbe({ base: 'https://work.example.eu', origin: 'https://origin.example.eu', fetchImpl });
  assert.deepEqual(statuses(findings), { 'probe.private': 'pass', 'probe.errors': 'pass', 'probe.security-headers': 'pass', 'probe.tag-header': 'pass', 'probe.transform': 'pass' });
  for (const request of sent) {
    const names = Object.keys(request.headers ?? {}).map(name => name.toLowerCase());
    assert.ok(!names.some(name => name === 'authorization' || name === 'x-lolly-client' || name.startsWith('x-lw-')), request.url);
    const cookie = request.headers?.cookie;
    assert.ok(cookie === undefined || /^lw_edge_probe=[0-9a-f]+[ab]$/.test(cookie), 'only made-up probe cookies');
  }
});

test('an edge that caches private answers, rewrites headers, leaks tags or transforms fails', async () => {
  const { fetchImpl } = edge({ cachePrivate: true, rewriteCsp: true, leakTags: true, transforms: true });
  const found = statuses(await runEdgeProbe({ base: 'https://work.example.eu', origin: 'https://origin.example.eu', fetchImpl }));
  assert.deepEqual(found, { 'probe.private': 'fail', 'probe.errors': 'fail', 'probe.security-headers': 'fail', 'probe.tag-header': 'warn', 'probe.transform': 'fail' });
});

test('a public-only hostname must refuse private routes', async () => {
  assert.equal(statuses(await runEdgeProbe({ base: 'https://assets.example.eu', publicOnly: true, fetchImpl: edge({ publicOnlyRefusal: true }).fetchImpl }))['probe.public-only'], 'pass');
  assert.equal(statuses(await runEdgeProbe({ base: 'https://assets.example.eu', publicOnly: true, fetchImpl: edge({}).fetchImpl }))['probe.public-only'], 'fail');
  const unreachable = (async () => { throw new Error('ENOTFOUND'); }) as typeof fetch;
  assert.ok((await runEdgeProbe({ base: 'https://nowhere.example.eu', fetchImpl: unreachable })).every(f => f.status === 'fail'));
});

test('cache-hit headers from each provider are recognised', () => {
  const hits: Array<[string, string]> = [['age', '3'], ['cf-cache-status', 'HIT'], ['cf-cache-status', 'REVALIDATED'], ['cdn-cache', 'HIT'], ['x-cache', 'HIT from edge'], ['cache-status', 'edge; hit']];
  for (const [name, value] of hits) {
    assert.ok(servedFromCache(new Headers({ [name]: value })), `${name}: ${value}`);
  }
  const misses: Array<[string, string]> = [['age', '0'], ['cf-cache-status', 'MISS'], ['cf-cache-status', 'DYNAMIC'], ['cf-cache-status', 'BYPASS'], ['cdn-cache', 'MISS'], ['cache-status', 'edge; fwd=uri-miss']];
  for (const [name, value] of misses) {
    assert.equal(servedFromCache(new Headers({ [name]: value })), null, `${name}: ${value}`);
  }
});
