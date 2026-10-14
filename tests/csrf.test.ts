/**
 * Cross-site request forgery guard (server/src/iam/csrf.ts), as a pure verdict
 * and over HTTP through the app: a cookie-authenticated mutation from another
 * site is refused before any route runs; bearer callers, cookie-less callers
 * and first-party pages are untouched.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { csrfVerdict } from '../server/src/iam/csrf.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

test('verdict: safe methods, bearer callers and cookie-less requests always pass', () => {
  assert.equal(csrfVerdict('GET', { cookie: 'lw_session=x', origin: 'https://evil.example' }), null);
  assert.equal(csrfVerdict('POST', { authorization: 'Bearer t', cookie: 'lw_session=x', origin: 'https://evil.example' }), null);
  assert.equal(csrfVerdict('POST', { origin: 'https://evil.example', host: 'work.example.org' }), null);
});

test('verdict: the browser saying cross-site is enough on its own', () => {
  assert.match(csrfVerdict('POST', { cookie: 'lw_session=x', 'sec-fetch-site': 'cross-site', host: 'work.example.org' }) ?? '', /cross-site/);
  assert.equal(csrfVerdict('POST', { cookie: 'lw_session=x', 'sec-fetch-site': 'same-origin', host: 'work.example.org' }), null);
});

test('verdict: only exact configured origins pass', () => {
  const urls = ['https://work.example.org', 'https://app.example.org'];
  const headers = { cookie: 'c', host: 'work.example.org' };
  assert.equal(csrfVerdict('PUT', { ...headers, origin: urls[0] }, urls), null);
  assert.equal(csrfVerdict('PUT', { ...headers, origin: urls[1] }, urls), null);
  for (const origin of ['https://other.example.org', 'http://work.example.org', 'https://work.example.org:8443']) {
    assert.match(csrfVerdict('PUT', { ...headers, origin }, urls) ?? '', /not this deployment/);
  }
  assert.match(csrfVerdict('DELETE', { ...headers, origin: 'null' }, urls) ?? '', /opaque/);
  assert.match(csrfVerdict('POST', { ...headers, origin: 'not a url' }, urls) ?? '', /malformed/);
  assert.match(csrfVerdict('POST', { ...headers, 'sec-fetch-site': 'same-site' }, urls) ?? '', /configured/);
});

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-csrf-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'CSRF Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 's', link: 'l' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

test('over HTTP: a cross-site POST with the session cookie is refused, a first-party one runs', async () => {
  const base = await boot();
  const login = await fetch(`${base}/api/auth/dev?email=admin@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
  assert.ok(cookie, 'dev sign-in mints a session');
  const body = JSON.stringify({ title: 'x', severity: 'info', body: 'y' });
  const headers = { cookie, 'content-type': 'application/json' };

  const crossSite = await fetch(`${base}/api/v1/messages`, { method: 'POST', body, headers: { ...headers, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.equal(((await crossSite.json()) as { error: { code: string } }).error.code, 'CSRF_BLOCKED');

  const foreignOrigin = await fetch(`${base}/api/v1/messages`, { method: 'POST', body, headers: { ...headers, origin: 'https://evil.example' } });
  assert.equal(foreignOrigin.status, 403);

  const firstParty = await fetch(`${base}/api/v1/messages`, { method: 'POST', body, headers: { ...headers, 'sec-fetch-site': 'same-origin', origin: 'http://localhost' } });
  assert.notEqual(firstParty.status, 403, `first-party mutation reached its route (${firstParty.status})`);

  const noCookie = await fetch(`${base}/api/v1/messages`, { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(noCookie.status, 401, 'nothing ambient to forge: the route itself answers');
});
