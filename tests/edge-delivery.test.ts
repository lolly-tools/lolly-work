// SPDX-License-Identifier: MPL-2.0
/**
 * The router's edge rules over real HTTP: purge tags appear only on answers a
 * shared cache may store, only in the configured providers' headers, and never
 * on a credentialed, private or error answer; a public-only hostname strips
 * credentials, never runs a person-private handler and turns any answer that is
 * not public into an empty refusal.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { cachePolicy } from '@lolly-tools/core/delivery-v1';
import { createRouter, guardDelivery, setDeliveryClass, setDeliveryTags, type EdgeDelivery } from '../server/src/api/router.ts';

let server: Server, port: number;
let privateRuns = 0;
const seenCookies: Array<string | undefined> = [];
const EDGE: EdgeDelivery = { tagHeaders: ['cdn-tag', 'cache-tag'], instanceTag: 'o_00000000000000aa', publicOnlyHosts: new Set(['assets.example.eu']) };

function read(path: string, headers: Record<string, string> = {}, method = 'GET', at = port): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: at, path, method, headers }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
}

let plainServer: Server, plainPort: number;
before(async () => {
  const router = createRouter();
  for (const method of ['GET', 'HEAD']) {
    router.add(method, '/brand.css', (req, res) => {
      seenCookies.push(req.headers.cookie);
      setDeliveryTags(res, ['b_0123456789abcdef']);
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': cachePolicy('public-revalidate').cacheControl, 'cache-tag': 'b_handler-wrote-this' });
      res.end('body{}');
    }, { delivery: 'public-revalidate' });
  }
  router.add('GET', '/private', (_req, res) => {
    privateRuns++;
    res.setHeader('surrogate-key', 'p_handler');
    setDeliveryTags(res, ['p_0123456789abcdef']);
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-tag': 'p_0123456789abcdef', 'set-cookie': 'lw_session=x' });
    res.end('private bytes for one person');
  });
  // A route whose class depends on the caller: public for everyone, instance-private otherwise.
  router.add('GET', '/card/:who', (_req, res, ctx) => {
    const everyone = ctx.params.who === 'everyone';
    setDeliveryClass(res, everyone ? 'public-bounded' : 'instance-private', everyone ? { boundedAgeSec: 3600 } : {});
    setDeliveryTags(res, ['t_card']);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': cachePolicy(everyone ? 'public-bounded' : 'instance-private', everyone ? { boundedAgeSec: 3600 } : {}).cacheControl });
    res.write('restricted card ');
    res.end('bytes');
  }, { delivery: 'instance-private' });
  router.add('GET', '/missing', (_req, res) => { setDeliveryTags(res, ['t_gone']); res.writeHead(404, { 'cache-control': 'public, max-age=60' }); res.end(); }, { delivery: 'public-immutable' });
  router.add('GET', '/bad-tag', (_req, res) => { setDeliveryTags(res, ['Not A Tag', 't_kept']); res.writeHead(200, { 'cache-control': cachePolicy('public-immutable').cacheControl }); res.end('x'); }, { delivery: 'public-immutable' });
  server = createServer((req, res) => { guardDelivery(req, res, EDGE); void router.dispatch(req, res); });
  plainServer = createServer((req, res) => void router.dispatch(req, res));
  await Promise.all([server, plainServer].map(s => new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))));
  port = (server.address() as { port: number }).port; plainPort = (plainServer.address() as { port: number }).port;
});
after(async () => { await Promise.all([server, plainServer].map(s => new Promise<void>(resolve => s.close(() => resolve())))); });

const TAG_HEADERS = ['cache-tag', 'cdn-tag', 'surrogate-key', 'edge-cache-tag'];
const tagHeaders = (headers: IncomingHttpHeaders) => Object.fromEntries(TAG_HEADERS.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));

test('an anonymous public answer carries the configured providers\' tag headers, built by the router', async () => {
  const res = await read('/brand.css');
  assert.match(String(res.headers['cache-control']), /^public\b/);
  assert.deepEqual(tagHeaders(res.headers), { 'cache-tag': 'b_0123456789abcdef,x_public-revalidate,o_00000000000000aa', 'cdn-tag': 'b_0123456789abcdef,x_public-revalidate,o_00000000000000aa' });
  const head = await read('/brand.css', {}, 'HEAD');
  assert.equal(head.headers['cdn-tag'], res.headers['cdn-tag']);
  const card = await read('/card/everyone');
  assert.equal(card.headers['cache-tag'], 't_card,x_public-bounded,o_00000000000000aa');
  assert.equal((await read('/bad-tag')).headers['cache-tag'], 't_kept,x_public-immutable,o_00000000000000aa', 'an invalid tag is dropped, never sent');
});

test('no tag header on a credentialed, private, dynamic-private or error answer, or without an edge', async () => {
  const credentials: Array<Record<string, string>> = [{ cookie: 'lw_session=a' }, { authorization: 'Bearer lwa_x' }, { 'x-lw-render-read': 'ticket' }, { 'x-lolly-client': 'web install/abc' }];
  for (const credential of credentials) {
    const res = await read('/brand.css', credential);
    assert.match(String(res.headers['cache-control']), /^private\b/, JSON.stringify(credential));
    assert.deepEqual(tagHeaders(res.headers), {}, `tags leaked with ${Object.keys(credential)[0]}`);
  }
  const personal = await read('/private');
  assert.equal(personal.headers['cache-control'], cachePolicy('person-private').cacheControl);
  assert.deepEqual(tagHeaders(personal.headers), {}, 'a tag a handler wrote itself is removed from a private answer');
  assert.deepEqual(tagHeaders((await read('/card/some-groups')).headers), {});
  assert.deepEqual(tagHeaders((await read('/missing')).headers), {});
  const plain = await read('/brand.css', {}, 'GET', plainPort);
  assert.match(String(plain.headers['cache-control']), /^public\b/);
  assert.deepEqual(tagHeaders(plain.headers), {}, 'without an edge provider no tag header is sent, not even one a handler wrote');
});

test('a public-only hostname serves public answers, strips credentials and refuses the rest', async () => {
  const host = { host: 'assets.example.eu' };
  const css = await read('/brand.css', { ...host, cookie: 'lw_session=stolen; _ga=1', authorization: 'Bearer lwa_x' });
  assert.equal(css.status, 200);
  assert.match(String(css.headers['cache-control']), /^public\b/, 'credentials are removed, so the answer is the anonymous one');
  assert.equal(seenCookies.at(-1), undefined, 'the handler never sees a cookie on a public-only hostname');
  assert.equal((await read('/brand.css', { host: 'assets.example.eu:443' })).status, 200);

  const before = privateRuns;
  const personal = await read('/private', host);
  assert.equal(personal.status, 404);
  assert.match(personal.body, /PUBLIC_HOST_ONLY/);
  assert.equal(privateRuns, before, 'a person-private handler does not run on a public-only hostname');
  assert.equal(personal.headers['set-cookie'], undefined);

  const restricted = await read('/card/some-groups', host);
  assert.equal(restricted.status, 404, 'an answer that is not public becomes a refusal');
  assert.doesNotMatch(restricted.body, /restricted card|bytes/, 'none of its bytes are sent');
  assert.match(restricted.body, /PUBLIC_HOST_ONLY/);
  assert.equal(restricted.headers['cache-control'], cachePolicy('person-private').cacheControl);
  assert.deepEqual(tagHeaders(restricted.headers), {});
  assert.equal((await read('/card/everyone', host)).status, 200);
  assert.equal((await read('/card/some-groups', { host: 'work.example.eu' })).status, 200, 'other hostnames are unaffected');
});

test('an in-process response with only setHeader, getHeader and getHeaders still passes the guard', async () => {
  // agents/project-requests.ts dispatches through the router with a response like this one.
  const { IncomingMessage } = await import('node:http');
  const { Socket } = await import('node:net');
  const headers = new Map<string, unknown>();
  let status = 0, ended = false;
  const res = {
    writeHead(code: number, values: Record<string, unknown> = {}) { status = code; for (const [k, v] of Object.entries(values)) headers.set(k.toLowerCase(), v); return this; },
    setHeader(k: string, v: unknown) { headers.set(k.toLowerCase(), v); return this; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    end() { ended = true; return this; },
  };
  const req = new IncomingMessage(new Socket()); req.method = 'GET'; req.url = '/private'; req.headers = {};
  const router = createRouter();
  router.add('GET', '/private', (_req, out) => { out.setHeader('cache-tag', 'p_handler'); out.writeHead(200, { 'content-type': 'text/plain' }); out.end(); });
  guardDelivery(req, res as never, EDGE);
  await router.dispatch(req, res as never);
  assert.equal(status, 200);
  assert.ok(ended);
  assert.equal(headers.get('cache-control'), cachePolicy('person-private').cacheControl);
  req.destroy();
});
