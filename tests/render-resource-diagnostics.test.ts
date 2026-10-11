// SPDX-License-Identifier: MPL-2.0
/** Actual requests prove safe diagnostics still distinguish a missed signed hold. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { createRenderCancellationDiagnostics, renderDiagnosticPath } from './collab/render-resource-diagnostics.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function get(base: string, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(base + path, { method, headers, agent: false }, res => { res.resume(); res.once('end', resolve); });
    req.once('error', reject); req.end();
  });
}

test('request diagnostics distinguish signed route/header mismatches without leaking private URLs or bytes', async () => {
  const server = createServer(), base = await listen(server);
  const diagnostics = createRenderCancellationDiagnostics(base);
  const target = { path: '/tools/qr-code@0123456789abcdef/hooks.js', readToken: 'private-ticket-never-log', revision: 'private-revision-never-log' };
  const forbidden = ['private-query-never-log', 'private-cookie-never-log', 'private-authorization-never-log',
    'private-user-output-never-log', 'wrong-ticket-never-log', 'wrong-revision-never-log', target.readToken, target.revision];
  server.on('request', (req, res) => { diagnostics.observe(req, res); res.end('private-user-output-never-log'); });
  const headers = { 'x-lw-render-read': target.readToken, 'x-lolly-brand-revision': target.revision,
    cookie: forbidden[1]!, authorization: forbidden[2]! };
  try {
    await get(base, target.path, headers);
    diagnostics.progress('page-created');
    assert.equal(diagnostics.snapshot().hookReads, 0, 'Pre-phase traffic is omitted');
    assert.deepEqual(diagnostics.snapshot().lifecycle, {}, 'Pre-phase browser events are omitted');
    diagnostics.arm(target);
    diagnostics.progress('page-created'); diagnostics.progress('main-frame-navigation'); diagnostics.progress('load');
    diagnostics.progress('private-user-output-never-log' as Parameters<typeof diagnostics.progress>[0]);
    diagnostics.progress('__proto__' as Parameters<typeof diagnostics.progress>[0]);
    await get(base, target.path + '?private-query-never-log', headers);
    await get(base, '/tools/qr-code/hooks.js', { ...headers, 'x-lw-render-read': 'wrong-ticket-never-log' });
    await get(base, target.path, { ...headers, 'x-lolly-brand-revision': 'wrong-revision-never-log' }, 'POST');
    await get(base, '/catalog/tools/index.sig.json?private-query-never-log');
    for (const path of ['/api/auth/private-query-never-log', '/tools/another-user/private-query-never-log',
      '/tools/qr-code%2fprivate-query-never-log/hooks.js', '/_app/private-query-never-log.js']) await get(base, path, headers);
    const report = diagnostics.snapshot();
    assert.equal(report.hookReads, 3); assert.equal(report.catalogReads, 1);
    assert.equal(report.bootstrapReads, 1); assert.equal(report.bootstrap[0]?.path, 'app-script');
    assert.deepEqual(Object.keys(report.lifecycle).sort(), ['load', 'main-frame-navigation', 'page-created']);
    assert.equal(report.lifecycle['page-created']?.count, 1);
    assert.equal(report.hooks[0]?.pathMatches, true); assert.equal(report.hooks[0]?.tokenMatches, true); assert.equal(report.hooks[0]?.revisionMatches, true);
    assert.equal(report.hooks[1]?.pathMatches, false); assert.equal(report.hooks[1]?.tokenMatches, false); assert.equal(report.hooks[1]?.tokenPresent, true);
    assert.equal(report.hooks[2]?.methodMatches, false); assert.equal(report.hooks[2]?.revisionMatches, false);
    assert.equal(report.catalog[0]?.tokenPresent, false); assert.equal(report.catalog[0]?.revisionPresent, false);
    for (const row of [...report.hooks, ...report.catalog]) {
      assert.equal(row.status, 200); assert.ok(row.responseAtMs! >= row.atMs && row.atMs >= 0); assert.ok(!('pendingMs' in row));
    }
    for (const secret of forbidden) assert.ok(!JSON.stringify(report).includes(secret), 'Private request values never enter the report');
    assert.equal(renderDiagnosticPath('https://private.invalid/private-query-never-log?secret', base), 'external-or-unsupported');
    assert.equal(renderDiagnosticPath(base + '/api/auth/private-query-never-log', base), 'internal-other');
    assert.equal(renderDiagnosticPath(base + '/_app/private-query-never-log.js?secret', base), 'app-script');
    assert.equal(renderDiagnosticPath('http://[invalid', base), 'unparseable');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('diagnostics bound request volume and expose a genuinely pending hook independently of finished catalog reads', async () => {
  const server = createServer(), base = await listen(server), diagnostics = createRenderCancellationDiagnostics(base);
  const target = { path: '/tools/qr-code@0123456789abcdef/hooks.js', readToken: 'held-private-ticket', revision: 'held-private-revision' };
  let held: import('node:http').ServerResponse | undefined;
  let entered!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  server.on('request', (req, res) => { diagnostics.observe(req, res); if (req.url === target.path + '?held') { held = res; entered(); } else res.end(); });
  diagnostics.arm(target);
  const pending = get(base, target.path + '?held', { 'x-lw-render-read': target.readToken, 'x-lolly-brand-revision': target.revision });
  try {
    await arrival;
    await get(base, '/catalog/tools/index.sig.json');
    assert.ok(held, 'The real hook socket stays open');
    for (let i = 0; i < 30; i++) await get(base, target.path);
    for (let i = 0; i < 36; i++) await get(base, '/catalog/tools/index.json');
    const report = diagnostics.snapshot();
    assert.equal(report.hookReads, 31); assert.equal(report.hooks.length, 24);
    assert.equal(report.catalogReads, 37); assert.equal(report.catalog.length, 32);
    assert.equal(report.hooks[0]?.status, undefined); assert.ok(report.hooks[0]!.pendingMs! >= 0);
    assert.equal(report.catalog[0]?.status, 200);
    assert.ok(!JSON.stringify(report).includes(target.readToken)); assert.ok(!JSON.stringify(report).includes(target.revision));
    held.end(); await pending;
    assert.equal(diagnostics.snapshot().hooks[0]?.status, 200);
    assert.ok('pendingMs' in report.hooks[0]!, 'A prior snapshot preserves the actual pending observation');
    assert.throws(() => diagnostics.arm(target));
  } finally { held?.end(); server.closeAllConnections(); await pending; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
