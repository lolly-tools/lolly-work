// SPDX-License-Identifier: MPL-2.0
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable, Transform } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { readBlobBody } from '../../blobs/types.ts';

export interface ProviderNetworkPolicy {
  allowedPrivateOrigins: string[];
  redirectOrigins: string[];
  maxBytes: number;
}
export type ProviderResolver = (hostname: string) => Promise<string[]>;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const publicAddress = (address: string) => !!isIP(address) && !blocked.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
const resolver: ProviderResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);

export class ProviderEgressError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Provider request refused (${code})`); this.name = 'ProviderEgressError'; this.code = code; }
}

export function providerOrigins(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 100) throw new Error('Provider origins must be a list of at most 100 HTTP(S) origins');
  return [...new Set(values.map(value => {
    if (typeof value !== 'string') throw new Error('Provider origins must be HTTP(S) origins');
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Provider origins must be HTTP(S) origins'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[*%]/.test(url.hostname) || url.port === '0'
      || /[\s\\]/.test(value) || value !== url.origin && value !== `${url.origin}/`) throw new Error('Provider origins must be exact HTTP(S) origins');
    return url.origin;
  }))];
}

function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderEgressError('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function providerDestination(raw: string, policy: ProviderNetworkPolicy, resolve: ProviderResolver = resolver, signal?: AbortSignal): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderEgressError('url'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.port === '0' || /[*%]/.test(url.hostname) || /[\s\\\u0000-\u001f\u007f]/.test(raw)) throw new ProviderEgressError('url');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try { addresses = isIP(hostname) ? [hostname] : await withAbort(resolve(hostname), signal); }
  catch { throw new ProviderEgressError('unresolved'); }
  if (!addresses.length || addresses.some(address => !isIP(address))) throw new ProviderEgressError('unresolved');
  if (!policy.allowedPrivateOrigins.includes(url.origin) && addresses.some(address => !publicAddress(address))) throw new ProviderEgressError('address');
  return { url, address: addresses.find(address => isIP(address) === 4) ?? addresses[0]! };
}

function pinnedRequest(url: URL, address: string, request: Request, body: Buffer | undefined, maxBytes: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host; delete headers['transfer-encoding']; delete headers.connection;
    headers['accept-encoding'] = 'identity';
    if (body) headers['content-length'] = String(body.length); else delete headers['content-length'];
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(url, { method: request.method, headers, agent: false, signal: request.signal, rejectUnauthorized: true,
      lookup: (_host, options, callback) => {
        const value = { address, family: isIP(address) };
        if (typeof options === 'object' && options.all) callback(null, [value]);
        else callback(null, address, value.family);
      },
    }, response => {
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) { response.destroy(); reject(new ProviderEgressError('size')); return; }
      const resultHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) {
        if (Array.isArray(value)) for (const entry of value) resultHeaders.append(name, entry);
        else resultHeaders.set(name, value);
      }
      const status = response.statusCode ?? 502;
      if (request.method === 'HEAD' || [204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers: resultHeaders })); return; }
      let stream: Readable = response;
      const encoding = resultHeaders.get('content-encoding');
      if (encoding && encoding !== 'identity') {
        const decompress = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
        if (!decompress) { response.destroy(); reject(new ProviderEgressError('encoding')); return; }
        response.on('error', error => decompress.destroy(error));
        stream = response.pipe(decompress); resultHeaders.delete('content-encoding'); resultHeaders.delete('content-length');
      }
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length; done(bytes > maxBytes ? new ProviderEgressError('size') : null, chunk);
      } });
      stream.on('error', error => limit.destroy(error)); limit.on('close', () => { response.destroy(); if (stream !== response) stream.destroy(); });
      resolve(new Response(Readable.toWeb(stream.pipe(limit)) as ConstructorParameters<typeof Response>[0], { status, headers: resultHeaders }));
    });
    outgoing.once('error', () => reject(new ProviderEgressError(request.signal.aborted ? 'aborted' : 'transport')));
    outgoing.end(body);
  });
}

/** Validate every hop and pin native connections to the approved DNS answer. */
export function createProviderFetch(policy: ProviderNetworkPolicy, fetchImpl?: typeof fetch, resolve: ProviderResolver = resolver): typeof fetch {
  return async (input, init) => {
    let original: Request;
    try { original = new Request(input, init); }
    catch { throw new ProviderEgressError('request'); }
    const signal = AbortSignal.any([original.signal, AbortSignal.timeout(30000)]);
    const body = original.body ? await withAbort(readBlobBody(original.body, policy.maxBytes), signal) : undefined;
    let current = original.url;
    let headers = new Headers(original.headers);
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      const destination = await providerDestination(current, policy, resolve, signal);
      signal.throwIfAborted();
      const request = new Request(destination.url, { method: original.method, headers, ...(body ? { body } : {}), signal, redirect: 'manual' });
      const response = fetchImpl ? await fetchImpl(request.url, { method: request.method, headers: request.headers,
        ...(body ? { body } : {}), signal, redirect: original.redirect === 'error' ? 'error' : 'manual' }) : await pinnedRequest(destination.url, destination.address, request, body, policy.maxBytes);
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has('location')) return response;
      if (original.redirect === 'manual') return response;
      await response.body?.cancel();
      if (original.redirect === 'error' || hop === 3 || !['GET', 'HEAD'].includes(original.method)) throw new ProviderEgressError('redirect');
      let next: URL;
      try { next = new URL(response.headers.get('location')!, destination.url); } catch { throw new ProviderEgressError('redirect'); }
      if (next.origin !== destination.url.origin) {
        if (!policy.redirectOrigins.includes(next.origin) || !['GET', 'HEAD'].includes(original.method)) throw new ProviderEgressError('redirect');
        headers = new Headers();
        for (const name of ['accept', 'accept-language', 'range']) {
          const value = original.headers.get(name); if (value) headers.set(name, value);
        }
      }
      current = next.href;
    }
    throw new ProviderEgressError('redirect');
  };
}
