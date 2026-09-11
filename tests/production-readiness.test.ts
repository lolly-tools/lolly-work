import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, main, probe } from '../scripts/production-readiness.ts';

const config = () => ({
  instance: { baseUrl: 'https://work.example.test' },
  idp: { issuer: 'https://idp.example.test', clientId: 'client' },
  policy: { defaultAccessMode: 'gated', telemetry: 'off', guestLinks: { enabled: false }, nearby: { enabled: false }, retention: { auditDays: 180, telemetryDays: 30 } },
});
const byId = (report: ReturnType<typeof assess>, id: string) => report.checks.find(c => c.id === id);

test('valid configuration remains incomplete without live evidence and approvals', () => {
  const report = assess(JSON.stringify(config()), 'config');
  assert.equal(byId(report, 'config.schema')?.status, 'pass');
  assert.equal(byId(report, 'config.identity')?.status, 'pass');
  assert.equal(byId(report, 'config.audit-retention')?.status, 'pass');
  assert.equal(report.result, 'incomplete');
  for (const id of ['identity', 'release', 'security', 'operations', 'privacy-ai', 'change']) {
    assert.equal(byId(report, `evidence.${id}`)?.status, 'unverified');
  }
});

test('insecure effective settings fail, while missing retention decisions remain unverified', () => {
  const cfg = { ...config(), dev: { enabled: true }, policy: { defaultAccessMode: 'open', telemetry: 'standard', sessionTtlHours: 48 } };
  const report = assess(JSON.stringify(cfg), 'config');
  for (const id of ['gated', 'auth-bypass', 'session', 'telemetry', 'sharing']) assert.equal(byId(report, `config.${id}`)?.status, 'fail');
  assert.equal(byId(report, 'config.audit-retention')?.status, 'unverified');
  assert.equal(report.result, 'failed');
});

test('schema errors and embedded secrets never appear in the evidence', () => {
  const marker = 'PRIVATE-MARKER-should-never-appear';
  for (const cfg of [
    { ...config(), idp: { issuer: `https://user:${marker}@idp.example.test`, clientId: 'client', clientSecret: marker } },
    { ...config(), submit: { scanHook: { kind: marker } } },
    { ...config(), [marker]: { secret: marker } },
    { ...config(), notify: { nested: { apiKey: marker } } },
  ]) {
    const report = assess(JSON.stringify(cfg), 'config');
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.equal(report.result, 'failed');
  }
});

test('a configured scanner must reject errors and use protected transport', () => {
  const report = assess(JSON.stringify({ ...config(), submit: { scanHook: { kind: 'http', target: 'http://scanner.example.test', onError: 'allow' } } }), 'config');
  assert.equal(byId(report, 'config.scanner')?.status, 'fail');
});

test('ambiguous or malformed manifests cannot produce configuration evidence', () => {
  const cm = JSON.stringify({ kind: 'ConfigMap', data: { 'instance.json': JSON.stringify(config()) } });
  for (const text of ['broken: [', '{}', `${cm}\n---\n${cm}`, 'null']) {
    const report = assess(text, 'manifests');
    assert.equal(byId(report, 'input.parse')?.status, 'fail');
  }
});

const helm = spawnSync('helm', ['version', '--short']);
test('real rendered Helm manifests are checked against the effective application and workload configuration', { skip: helm.status !== 0 && 'Helm is required' }, () => {
  const chart = fileURLToPath(new URL('../deploy/helm', import.meta.url));
  const r = spawnSync('helm', ['template', 'evidence', chart, '-f', `${chart}/values-internal.yaml`,
    '--set', 'existingSecret=platform-managed', '--set', 'config.idp.issuer=https://idp.example.test', '--set', 'config.idp.clientId=client',
    '--set', `image.tag=0.2.0@sha256:${'a'.repeat(64)}`,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = assess(r.stdout, 'manifests');
  for (const id of ['images', 'secret-resources', 'inline-env', 'work-server', 'config-mount', 'security', 'probes']) {
    assert.equal(byId(report, `kubernetes.${id}`)?.status, 'pass', id);
  }
  const mutable = assess(r.stdout.replaceAll(`0.2.0@sha256:${'a'.repeat(64)}`, 'latest'), 'manifests');
  assert.equal(byId(mutable, 'kubernetes.images')?.status, 'fail');
  const wrongMount = assess(r.stdout.replace(/name: evidence-lolly-work-config/g, 'name: other-config').replace('name: other-config', 'name: correct-config'), 'manifests');
  assert.equal(byId(wrongMount, 'kubernetes.config-mount')?.status, 'fail');
});

test('manifest secrets are refused without retaining their content', () => {
  const text = `${JSON.stringify({ kind: 'ConfigMap', data: { 'instance.json': JSON.stringify(config()) } })}\n---\nkind: Secret\ndata:\n  credential: NEVER-EMIT-ME\n`;
  const report = assess(text, 'manifests');
  assert.equal(byId(report, 'kubernetes.secret-resources')?.status, 'fail');
  assert.ok(!JSON.stringify(report).includes('NEVER-EMIT-ME'));
});

test('HTTP probes distinguish actual Work JSON and explicit denial from login HTML/redirects', async t => {
  let deceptive = false;
  let forwarded = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/redirect-destination') { forwarded++; res.end(); return; }
    if (deceptive) {
      if (req.url?.startsWith('/api/')) { res.writeHead(302, { location: '/redirect-destination' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>sign in</html>'); }
      return;
    }
    res.writeHead(req.url?.startsWith('/api/') ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accessMode: 'gated', store: 'postgres' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  assert.equal((await probe(base))[0]?.status, 'fail');
  assert.ok((await probe(base, { allowLocalHttp: true })).every(c => c.status === 'pass'));
  deceptive = true;
  const checks = await probe(base, { allowLocalHttp: true });
  assert.ok(checks.filter(c => c.id.startsWith('http.api')).every(c => c.status === 'unverified'));
  assert.ok(checks.filter(c => !c.id.startsWith('http.api')).every(c => c.status === 'fail'));
  assert.equal(forwarded, 0);
});

test('HTTP probes bound response size/time and refuse credential-bearing targets', async t => {
  assert.equal((await probe('https://user:secret@example.test'))[0]?.status, 'fail');
  let hang = false;
  const server = createServer((_req, res) => {
    if (hang) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ body: 'x'.repeat(20_000) }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  assert.ok((await probe(base, { allowLocalHttp: true, timeoutMs: 100 })).every(c => c.status === 'fail'));
  hang = true;
  const started = Date.now();
  assert.ok((await probe(base, { allowLocalHttp: true, timeoutMs: 20 })).every(c => c.status === 'fail'));
  assert.ok(Date.now() - started < 2000, 'unresponsive servers must not hang the evidence run');
});

test('CLI creates private reports, refuses overwrites and keeps missing approvals incomplete', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'instance.json');
  const output = join(dir, 'report.json');
  writeFileSync(input, JSON.stringify(config()));
  assert.equal(await main(['--config', input, '--out', output]), 2);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const original = readFileSync(output, 'utf8');
  assert.equal(await main(['--config', input, '--out', output]), 1);
  assert.equal(readFileSync(output, 'utf8'), original);
  assert.equal(JSON.parse(original).checks.find((c: { id: string }) => c.id === 'http.staging').status, 'unverified');
});
