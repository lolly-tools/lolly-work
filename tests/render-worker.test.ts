/**
 * The Chromium render-worker CLIENT protocol (plans/07/11) - HMAC signing, the
 * request shape, and error-status mapping. No engine, no browser: a mock fetch
 * stands in for the worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signBody, verifyBody, renderViaWorker, rasteriseViaWorker, WorkerError, WORKER_TS_SKEW_MS, WORKER_CONNECT_RETRY_MS, WORKER_UNREACHABLE_RETRY_AFTER_S, isWorkerConnectFailure, tcpConnectProbe, type ConnectProbe } from '../server/src/render/worker-client.ts';

const SECRET = 'shared-key';
const CFG = { url: 'https://worker.local', secret: SECRET, timeoutMs: 5000 };
const JOB = { toolId: 'hooky', query: 'title=Hi', overrides: { logo: 'brand/logo' }, format: 'svg' as const, profile: {} };
const RASTER_JOB = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>', format: 'png' };
const okSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>';
const res = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('worker cancellation and timeout cover the response body after headers arrive', async () => {
  for (const kind of ['cancel', 'timeout'] as const) {
    const controller = new AbortController();
    let headers!: () => void;
    const received = new Promise<void>(resolve => { headers = resolve; });
    const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        init!.signal!.addEventListener('abort', () => stream.error(init!.signal!.reason), { once: true });
        headers();
      },
    }));
    const request = renderViaWorker({ ...CFG, timeoutMs: kind === 'timeout' ? 20 : 5000 }, JOB, { signal: controller.signal, fetchImpl });
    const rejected = assert.rejects(request, kind === 'cancel' ? { name: 'AbortError' } : WorkerError);
    await received;
    if (kind === 'cancel') controller.abort();
    await rejected;
  }
});

test('signBody/verifyBody round-trip; a tampered body is rejected', () => {
  const sig = signBody('{"a":1}', SECRET);
  assert.ok(verifyBody('{"a":1}', SECRET, sig));
  assert.equal(verifyBody('{"a":2}', SECRET, sig), false);
  assert.equal(verifyBody('{"a":1}', 'other', sig), false);
});

test('renderViaWorker signs the exact body, stamps ts, and returns the SVG', async () => {
  let seen: { sig: string | null; body: string } = { sig: null, body: '' };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen = { sig: (init.headers as Record<string, string>)['x-lw-render-sig'] ?? null, body: String(init.body) };
    return res(200, { svg: okSvg });
  }) as unknown as typeof fetch;

  const now = 1_700_000_000_000;
  const svg = await renderViaWorker(CFG, JOB, { now, fetchImpl });
  assert.equal(svg, okSvg);
  // The signature verifies over the exact bytes sent, and the body carries ts.
  assert.ok(seen.sig && verifyBody(seen.body, SECRET, seen.sig));
  const parsed = JSON.parse(seen.body) as { ts: number; toolId: string };
  assert.equal(parsed.ts, now);
  assert.equal(parsed.toolId, 'hooky');
});

test('renderViaWorker maps worker errors to statuses', async () => {
  const withStatus = (status: number, body: unknown = { error: { message: 'nope' } }) =>
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => res(status, body)) as unknown as typeof fetch });

  // 422/400 pass through (a real policy/param rejection); other 5xx become 502.
  await assert.rejects(withStatus(422), (e: WorkerError) => e instanceof WorkerError && e.status === 422);
  await assert.rejects(withStatus(400), (e: WorkerError) => e.status === 400);
  await assert.rejects(withStatus(500), (e: WorkerError) => e.status === 502);
  // A 200 with no SVG is a protocol failure.
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => res(200, { svg: 'not-svg' })) as unknown as typeof fetch }),
    (e: WorkerError) => e instanceof WorkerError && /no SVG/.test(e.message),
  );
});

test('a transport failure that is not a refused connection stays 502 after one attempt', async () => {
  let calls = 0;
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => { calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); }) as unknown as typeof fetch }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 502 && e.code === undefined,
  );
  assert.equal(calls, 1, 'a request that may have reached the worker is not sent again');
});

test('isWorkerConnectFailure reads the cause fetch wraps, and every address of an AggregateError', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(isWorkerConnectFailure(new TypeError('fetch failed', { cause: refused })), true);
  assert.equal(isWorkerConnectFailure(new TypeError('fetch failed', { cause: new AggregateError([refused, Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })]) })), true);
  assert.equal(isWorkerConnectFailure(new TypeError('fetch failed', { cause: new AggregateError([refused, Object.assign(new Error('x'), { code: 'ECONNRESET' })]) })), false);
  assert.equal(isWorkerConnectFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })), false);
  assert.equal(isWorkerConnectFailure(new Error('ECONNREFUSED')), false, 'a message alone is not a code');
  assert.equal(isWorkerConnectFailure(undefined), false);
});

/** A port with nothing listening on it, so connecting is refused, and a stand-in
 *  worker that starts listening there when `open()` is called. */
async function refusingWorker(handler: (path: string, raw: string) => { status: number; body: unknown }): Promise<{ base: string; open(): Promise<void>; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const out = handler((req.url ?? '').split('?')[0] ?? '', Buffer.concat(chunks).toString('utf8'));
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return {
    base: `http://127.0.0.1:${port}`,
    open: () => new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)),
    close: async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a worker that refuses connections is tried again until it listens, with real sockets', async () => {
  let served = 0;
  const worker = await refusingWorker(() => { served++; return { status: 200, body: { svg: okSvg } }; });
  const started = Date.now();
  const opening = setTimeout(() => void worker.open(), 600);
  try {
    const svg = await renderViaWorker({ ...CFG, url: worker.base, connectRetryMs: 10_000 }, JOB);
    assert.equal(svg, okSvg);
    assert.equal(served, 1, 'one request reached the worker');
    assert.ok(Date.now() - started >= 550, 'it waited for the worker to listen');
  } finally { clearTimeout(opening); await worker.close(); }
});

test('each attempt is signed afresh, so the signature and ts match the body that arrived', async () => {
  let arrived = { sig: '', body: '' };
  const worker = await refusingWorker(() => ({ status: 200, body: { svg: okSvg } }));
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    arrived = { sig: (init!.headers as Record<string, string>)['x-lw-render-sig'] ?? '', body: String(init!.body) };
    return response;
  };
  const opening = setTimeout(() => void worker.open(), 300);
  try {
    await renderViaWorker({ ...CFG, url: worker.base, connectRetryMs: 10_000 }, JOB, { fetchImpl });
    assert.ok(verifyBody(arrived.body, SECRET, arrived.sig));
  } finally { clearTimeout(opening); await worker.close(); }
});

test('a worker that never listens fails as 503 RENDER_BUSY with Retry-After once connectRetryMs has passed', async () => {
  const worker = await refusingWorker(() => ({ status: 200, body: {} }));
  const started = Date.now();
  await assert.rejects(
    rasteriseViaWorker({ ...CFG, url: worker.base, connectRetryMs: 600 }, RASTER_JOB),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY'
      && e.retryAfter === WORKER_UNREACHABLE_RETRY_AFTER_S && /ECONNREFUSED\) after [2-9] attempts/.test(e.message),
  );
  const took = Date.now() - started;
  assert.ok(took <= 700, `no attempt starts after connectRetryMs (took ${took} ms)`);
});

test('retrying stops before the caller\'s render deadline, so RENDER_BUSY answers rather than RENDER_TIMEOUT', async () => {
  const worker = await refusingWorker(() => ({ status: 200, body: {} }));
  const started = Date.now();
  await assert.rejects(
    renderViaWorker({ ...CFG, url: worker.base, connectRetryMs: 30_000 }, JOB, { deadlineAt: started + 1500 }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY',
  );
  const took = Date.now() - started;
  assert.ok(took < 1500, `answered before the deadline (took ${took} ms)`);
});

test('a retry whose connect hangs is cut off at the time left, so the deadline is not reached', async () => {
  // Attempt 1 hangs in connect for 600 ms and then times out. Every check after
  // that hangs for as long as it is allowed: the retrying must still answer
  // before the deadline.
  const timedOut = () => new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  const fetchImpl: typeof fetch = async () => { await new Promise(resolve => setTimeout(resolve, 600)); throw timedOut(); };
  const allowed: number[] = [];
  const probe: ConnectProbe = async (_endpoint, timeoutMs) => { allowed.push(timeoutMs); await new Promise(resolve => setTimeout(resolve, Math.max(0, timeoutMs))); return 'UND_ERR_CONNECT_TIMEOUT'; };
  const started = Date.now();
  await assert.rejects(
    renderViaWorker({ ...CFG, connectRetryMs: 30_000 }, JOB, { fetchImpl, probe, deadlineAt: started + 2000 }),
    (e: WorkerError) => e.status === 503 && e.code === 'RENDER_BUSY' && /UND_ERR_CONNECT_TIMEOUT/.test(e.message),
  );
  assert.ok(Date.now() - started < 2000, `answered before the deadline (took ${Date.now() - started} ms)`);
  assert.ok(allowed.length >= 1 && allowed.every(ms => ms <= 2000 - 500 - 600), `each check is bounded by the time left: ${allowed.join(', ')}`);
});

test('connectRetryMs 0 answers RENDER_BUSY after the first refused connect', async () => {
  const worker = await refusingWorker(() => ({ status: 200, body: {} }));
  await assert.rejects(renderViaWorker({ ...CFG, url: worker.base, connectRetryMs: 0 }, JOB),
    (e: WorkerError) => e.status === 503 && e.code === 'RENDER_BUSY' && /after 1 attempt /.test(e.message));
});

test('cancelling while the client waits to retry stops at once with the caller\'s abort', async () => {
  const worker = await refusingWorker(() => ({ status: 200, body: {} }));
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  try {
    await assert.rejects(renderViaWorker({ ...CFG, url: worker.base, connectRetryMs: 30_000 }, JOB, { signal: controller.signal }), { name: 'AbortError' });
    assert.ok(Date.now() - started < 2000, 'the wait ends with the abort, not the retry budget');
  } finally { clearTimeout(cancel); }
});

test('the TCP check reports a refused port and an open one', async () => {
  const worker = await refusingWorker(() => ({ status: 200, body: {} }));
  assert.equal(await tcpConnectProbe(`${worker.base}/render`, 1000), 'ECONNREFUSED');
  await worker.open();
  try { assert.equal(await tcpConnectProbe(`${worker.base}/render`, 1000), null); } finally { await worker.close(); }
  assert.equal(await tcpConnectProbe(`${worker.base}/render`, 0), 'UND_ERR_CONNECT_TIMEOUT', 'no time left is a timeout, with no connect tried');
});

test('the default connect retry budget is 30 s', () => {
  assert.equal(WORKER_CONNECT_RETRY_MS, 30_000);
});

test('renderViaWorker maps a worker 503 to RENDER_BUSY (plans/23 §3.C), distinct from a generic 502, and passes Retry-After through untouched — no retry loop here', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return res(503, { error: { message: 'at capacity' } }, { 'retry-after': '2' });
  }) as unknown as typeof fetch;

  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === 2,
  );
  assert.equal(calls, 1, 'the client makes exactly one attempt — retrying, if any, is the caller\'s call');
});

test('renderViaWorker: a 503 with no Retry-After header still maps to RENDER_BUSY, just without a retryAfter hint', async () => {
  const fetchImpl = (async () => res(503, { error: { message: 'busy' } })) as unknown as typeof fetch;
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === undefined,
  );
});

test('rasteriseViaWorker maps a worker 503 to RENDER_BUSY the same way renderViaWorker does', async () => {
  const fetchImpl = (async () => res(503, { error: { message: 'busy' } }, { 'retry-after': '2' })) as unknown as typeof fetch;
  await assert.rejects(
    rasteriseViaWorker(CFG, RASTER_JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === 2,
  );
});

test('the accepted timestamp skew is bounded', () => {
  assert.equal(WORKER_TS_SKEW_MS, 5 * 60 * 1000);
});


test('a revision-bound render requires acknowledgement from a compatible worker', async () => {
  const job = { ...JOB, brandRevision: '5:abc' };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ svg: '<svg></svg>' }));
  await assert.rejects(renderViaWorker(CFG, job, { fetchImpl }), /did not confirm/);
  const confirmed: typeof fetch = async () => new Response(JSON.stringify({ svg: '<svg></svg>', brandRevision: job.brandRevision }));
  assert.equal(await renderViaWorker(CFG, job, { fetchImpl: confirmed }), '<svg></svg>');
});

test('worker observations require a signed response bound to both request and SVG', async () => {
  const { sha256Hex } = await import('../server/src/lib/crypto.ts');
  let observed = false;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = { svg: okSvg, evidence: { version: 1, requestSha256: sha256Hex(String(init!.body)), outputSha256: sha256Hex(okSvg), resources: [{ url: 'https://web.test/tools/card/template.html', sha256: '1'.repeat(64), size: 123 }], limitations: [] } };
    const raw = JSON.stringify(body); return new Response(raw, { headers: { 'x-lw-output-sig': signBody(raw, SECRET) } });
  };
  assert.equal(await renderViaWorker(CFG, { ...JOB, evidence: true }, { fetchImpl, onEvidence: e => { observed = e.resources.length === 1; } }), okSvg);
  assert.ok(observed);
  await assert.rejects(renderViaWorker(CFG, { ...JOB, evidence: true }, { fetchImpl: async () => res(200, { svg: okSvg }) }), /signature/);
  await assert.rejects(renderViaWorker(CFG, { ...JOB, evidence: true }, { fetchImpl: async () => {
    const raw = JSON.stringify({ svg: okSvg, evidence: { version: 1, requestSha256: '0'.repeat(64), outputSha256: sha256Hex(okSvg), resources: [], limitations: [] } });
    return new Response(raw, { headers: { 'x-lw-output-sig': signBody(raw, SECRET) } });
  } }), /does not bind/);
});

test('signed worker input hashes must be bounded and requested by this job', async () => {
  const { sha256Hex } = await import('../server/src/lib/crypto.ts');
  const job = { ...JOB, evidence: true, inputIds: ['data'] };
  const response = (inputs: unknown): typeof fetch => async (_url, init) => {
    const raw = JSON.stringify({ svg: okSvg, evidence: { version: 1, requestSha256: sha256Hex(String(init!.body)), outputSha256: sha256Hex(okSvg), resources: [], limitations: [], inputs } });
    return new Response(raw, { headers: { 'x-lw-output-sig': signBody(raw, SECRET) } });
  };
  let observed: unknown;
  await renderViaWorker(CFG, job, { fetchImpl: response({ data: 'a'.repeat(64) }), onEvidence: e => { observed = e.inputs; } });
  assert.deepEqual(observed, { data: 'a'.repeat(64) });
  for (const inputs of [{ data: 'invalid' }, { title: 'a'.repeat(64) }, [], null]) {
    await assert.rejects(renderViaWorker(CFG, job, { fetchImpl: response(inputs) }), /input observations are invalid/);
  }
});
