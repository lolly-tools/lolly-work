// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createProviderFetch, providerDestination, providerOrigins, type ProviderNetworkPolicy } from '../server/src/catalog/providers/egress.ts';
import { parseConfig } from '../server/src/config/instance.ts';

const publicPolicy: ProviderNetworkPolicy = { allowedPrivateOrigins: [], redirectOrigins: [], maxBytes: 1024 };
async function receiver(t: { after(fn: () => Promise<void>): void }, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as AddressInfo).port, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('provider policy refuses unreviewed private destinations and validates exact origins', async () => {
  for (const url of ['http://127.0.0.1', 'http://127.1', 'http://2130706433', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]',
    'http://[::ffff:127.0.0.1]', 'https://user:password@public.test']) {
    await assert.rejects(providerDestination(url, publicPolicy, async () => ['93.184.216.34']));
  }
  await assert.rejects(providerDestination('https://public.test', publicPolicy, async () => ['93.184.216.34', '10.0.0.1']), /address/);
  await assert.rejects(providerDestination('https://missing.test', publicPolicy, async () => []), /unresolved/);
  assert.equal((await providerDestination('https://public.test', publicPolicy, async () => ['93.184.216.34'])).address, '93.184.216.34');
  for (const values of [['https://internal.test/path'], ['https://*.internal.test'], ['https://user:password@internal.test'], ['http://internal.test?x'], [false], null]) {
    assert.throws(() => providerOrigins(values));
  }
  assert.deepEqual(providerOrigins(['https://internal.test/', 'https://internal.test']), ['https://internal.test']);
  assert.deepEqual(parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } })).network.providers.allowedPrivateOrigins, []);
});

test('a reviewed internal origin connects to the checked address without a second DNS lookup', async t => {
  let host = '', resolutions = 0;
  const server = await receiver(t, (req, res) => { host = req.headers.host!; res.end('owned-asset'); });
  const origin = `http://owned-provider.test:${server.port}`;
  const fetcher = createProviderFetch({ ...publicPolicy, allowedPrivateOrigins: [origin] }, undefined,
    async () => { resolutions++; return resolutions === 1 ? ['127.0.0.1'] : ['10.0.0.1']; });
  const response = await fetcher(`${origin}/asset`);
  assert.equal(await response.text(), 'owned-asset');
  assert.equal(resolutions, 1); assert.equal(host, `owned-provider.test:${server.port}`);
});

test('redirects require reviewed destinations and strip credential headers before a cross-origin read', async t => {
  let finalHits = 0, authorization: string | undefined, privateHeader: string | undefined;
  const target = await receiver(t, (req, res) => { finalHits++; authorization = req.headers.authorization; privateHeader = req.headers['x-api-key'] as string | undefined; res.end('owned'); });
  const source = await receiver(t, (_req, res) => { res.writeHead(302, { location: `${target.origin}/asset` }); res.end(); });
  const policy = { ...publicPolicy, allowedPrivateOrigins: [source.origin, target.origin] };
  const refused = createProviderFetch(policy);
  await assert.rejects(refused(`${source.origin}/asset`, { headers: { authorization: 'owned-authorization', 'x-api-key': 'owned-api-key' } }), /redirect/);
  assert.equal(finalHits, 0);
  const allowed = createProviderFetch({ ...policy, redirectOrigins: [target.origin] });
  assert.equal(await (await allowed(`${source.origin}/asset`, { headers: { authorization: 'owned-authorization', 'x-api-key': 'owned-api-key' } })).text(), 'owned');
  assert.equal(finalHits, 1); assert.equal(authorization, undefined); assert.equal(privateHeader, undefined);
  await assert.rejects(allowed(`${source.origin}/asset`, { method: 'POST', body: 'owned-body' }), /redirect/);
  assert.equal(finalHits, 1);
  const unreviewedPrivate = createProviderFetch({ ...publicPolicy, allowedPrivateOrigins: [source.origin], redirectOrigins: [target.origin] });
  await assert.rejects(unreviewedPrivate(`${source.origin}/asset`), /address/);
  assert.equal(finalHits, 1);
});

test('same-origin redirects are bounded and explicit error mode never follows one', async t => {
  let hits = 0;
  const server = await receiver(t, (_req, res) => { hits++; res.writeHead(302, { location: '/again' }); res.end(); });
  const fetcher = createProviderFetch({ ...publicPolicy, allowedPrivateOrigins: [server.origin] });
  await assert.rejects(fetcher(`${server.origin}/asset`), /redirect/); assert.equal(hits, 4);
  hits = 0; await assert.rejects(fetcher(`${server.origin}/asset`, { redirect: 'error' }), /redirect/); assert.equal(hits, 1);
});

test('native provider responses obey byte limits after decompression and caller abort bounds DNS', async t => {
  const server = await receiver(t, (_req, res) => { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync('x'.repeat(4096))); });
  const fetcher = createProviderFetch({ ...publicPolicy, allowedPrivateOrigins: [server.origin] });
  const response = await fetcher(`${server.origin}/asset`);
  await assert.rejects(response.text(), /size/);
  const controller = new AbortController();
  const held = createProviderFetch(publicPolicy, undefined, () => new Promise(() => {}));
  const pending = held('https://held-provider.test', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending);
});
