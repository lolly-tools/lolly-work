// SPDX-License-Identifier: MPL-2.0
/** Executed in the built image by scripts/qualify-render-worker-image.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { importCatalogSigningKey } from '../server/src/catalog/signing.ts';
import { mintRenderRead } from '../server/src/render/read-ticket.ts';
import { createRenderResourceHold, requestRenderCancellation } from './collab/render-resource-hold.ts';
import { createRenderCancellationDiagnostics, renderDiagnosticPath } from './collab/render-resource-diagnostics.ts';
import { captureRenderPagePhase, RENDER_PAGE_PHASE_SCRIPT } from './collab/render-page-phase.ts';
import { createRenderManifestBootstrap, waitForRenderManifestBootstrap } from './collab/render-manifest-bootstrap.ts';
import { catalogStartupDiagnostic } from './collab/render-startup-diagnostics.ts';
type WorkerModule = typeof import('../workers/render/src/server.ts');

const skip = process.env.LOLLY_RENDER_IMAGE_TEST !== '1' && 'Run qualify-render-worker-image.ts with the built image and matched signed shell.';
const shell = '/qualification/shell';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Failure metadata names fixed categories only; never prints tickets or tool output. */
function errorCategories(message: string): string[] {
  return ['timeout', 'catalogue revision', 'catalog signature', 'catalog integrity', 'index hash',
    'file digest', 'tool directory', 'content decoding', 'WebGPU'].filter(value => message.toLowerCase().includes(value.toLowerCase()));
}
const listen = async (server: Server): Promise<string> => {
  if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};
const close = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
};
async function until(predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < stop);
  assert.fail('Image lifecycle predicate did not settle');
}

/** Failure-only fixed-route metadata; no headers, credentials or free-form response text. */
async function startupReadinessDiagnostic(base: string) {
  let status = 0;
  try {
    const response = await fetch(`${base}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
    status = response.status;
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!reader) return { status, body: 'unavailable' };
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024) { await reader.cancel(); return { status, body: 'oversized' }; }
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> | null;
    return { status, ok: typeof value?.ok === 'boolean' ? value.ok : 'unknown',
      store: value?.store === 'memory' || value?.store === 'postgres' ? value.store : 'unknown' };
  } catch { return { status, body: 'unavailable' }; }
}

test('built worker uses its actual browser for signed matched-engine QR SVG/PNG, tickets, cancellation and egress', { skip, timeout: 90_000 }, async t => {
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.versions.node, '26.11.1');
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/lolly-browsers');
  assert.ok(!process.env.LOLLY_BROWSER_PATH && !process.env.LOLLY_BROWSER_CHANNEL);
  const sourceRoot = new URL('../workers/render/src/', import.meta.url);
  const sources = (await readdir(sourceRoot)).sort();
  assert.deepEqual((await readdir('/app/src')).sort(), sources, 'Image source inventory must match this checkout');
  for (const file of sources) assert.equal(hash(await readFile(join('/app/src', file))), hash(await readFile(new URL(file, sourceRoot))), file);
  const pin = JSON.parse(await readFile(new URL('../engine-pin.json', import.meta.url), 'utf8'));
  assert.equal(process.env.LOLLY_TEST_SHELL_SOURCE, pin.generatedFrom);
  const material = process.env.LW_CATALOG_SIGNING_KEY;
  const publicMaterial = process.env.LOLLY_TEST_CATALOG_PUBLIC_KEY_JWK;
  assert.ok(material && publicMaterial);
  const signing = await importCatalogSigningKey(material);
  assert.deepEqual(signing.publicJwk, JSON.parse(publicMaterial));
  const engineSpecifier: string = '@lolly/engine';
  const { ENGINE_VERSION, importSpkiOrJwkPublicKey, verifyCatalogEnvelope, verifyToolFile } = await import(engineSpecifier);
  assert.equal(pin.engine.version, ENGINE_VERSION);
  const publicKey = await importSpkiOrJwkPublicKey(publicMaterial);
  const envelope = JSON.parse(await readFile(join(shell, 'catalog/tools/index.sig.json'), 'utf8'));
  const index = await readFile(join(shell, 'catalog/tools/index.json'));
  assert.equal((await verifyCatalogEnvelope(envelope, index, publicKey)).ok, true);
  for (const id of ['qr-code', 'sandbox']) for (const name of ['tool.json', 'template.html', 'hooks.js']) {
    assert.equal((await verifyToolFile(envelope, id, name, await readFile(join(shell, 'tools', id, name)))).ok, true);
  }
  const qr = JSON.parse(await readFile(join(shell, 'tools/qr-code/tool.json'), 'utf8'));
  assert.ok(qr.hooks, 'The acceptance must use the isolated hooked path');
  const secret = randomUUID(), link = randomUUID(), session = randomUUID();
  process.env.LW_RENDER_DEPLOYMENT_MODE = 'evaluation';
  process.env.PORT = '0'; process.env.LW_RENDER_WORKER_SECRET = secret;
  // These are the normal production defaults, not the longer legacy browser-test values.
  delete process.env.LW_RENDER_EXPORT_TIMEOUT_MS; delete process.env.LW_RENDER_NAV_TIMEOUT_MS;
  process.env.LW_RENDER_MAX_CONCURRENT = '1';
  let worker: WorkerModule | undefined, browser: Awaited<ReturnType<WorkerModule['getBrowser']>> | undefined, trap: Server | undefined;
  const cancellationHold = createRenderResourceHold();
  const cancellationBootstrap = createRenderManifestBootstrap();
  const server = createServer(); const base = await listen(server);
  let cleanup: Promise<void> | undefined;
  const finish = () => cleanup ??= (async () => {
    cancellationHold.release();
    try { await browser?.close(); } finally {
      try { if (worker?.server) await close(worker.server); } finally {
        try { await close(server); } finally { if (trap) await close(trap); }
      }
    }
  })();
  t.after(finish);
  process.env.LOLLY_WEB_BASE = base;
  const workerPath: string = '/app/src/server.ts';
  worker = await import(workerPath) as WorkerModule;
  const workerBase = await listen(worker.server);
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ instance: { name: 'Worker image fixture', pack: shell, shellDir: shell, baseUrl: base },
    deployment: { mode: 'evaluation' },
    idp: { additional: [{ id: 'email', kind: 'password' }] }, rateLimit: { enabled: false },
    render: { allowHooksInFastPath: false, worker: { url: workerBase, timeoutMs: 20000 } }, policy: { defaultAccessMode: 'gated' } }));
  const app = buildApp({ config, store, secrets: { session, link, renderWorker: secret, catalogSigningKey: material }, backgroundPollMs: 0 });
  const owner = await store.upsertUserBySub({ sub: 'owned-image-test', email: 'owner@worker.invalid', groups: ['owner'], role: 'owner' });
  const cookie = mintSessionCookie({ sub: owner.sub, email: owner.email, name: 'Image test owner', groups: owner.groups, role: owner.role, epoch: owner.sessionEpoch }, session, false).split(';')[0];
  assert.ok(cookie);
  let ticketReads = 0, hookReads = 0, sandboxHookReads = 0, modelHits = 0, trapHits = 0, websocketHits = 0;
  const catalogReads: Array<{ path: string; startMs: number; elapsedMs?: number; status?: number }> = [];
  const startupAt = performance.now();
  const cancellationDiagnostics = createRenderCancellationDiagnostics(base);
  server.on('request', (req, res) => {
    cancellationDiagnostics.observe(req, res);
    cancellationBootstrap.observe(req, res);
    const path = new URL(req.url ?? '/', base).pathname;
    if (catalogReads.length < 64 && /^\/(?:catalog\/(?:tools|assets)\/index(?:\.slim|\.sig)?(?:\.[0-9a-f]{16})?\.json|tools\/(?:qr-code|sandbox)(?:@[0-9a-f]{16})?\/[A-Za-z0-9_./-]+)$/.test(path)) {
      const read: typeof catalogReads[number] = { path, startMs: performance.now() - startupAt }; catalogReads.push(read);
      res.once('finish', () => { read.elapsedMs = performance.now() - startupAt - read.startMs; read.status = res.statusCode; });
    }
    if (req.headers['x-lw-render-read']) ticketReads++;
    if (/^\/tools\/qr-code(?:@[0-9a-f]{16})?\/hooks\.js(?:\?|$)/.test(req.url ?? '')) hookReads++;
    if (/^\/tools\/sandbox(?:@[0-9a-f]{16})?\/hooks\.js(?:\?|$)/.test(req.url ?? '')) sandboxHookReads++;
    if (req.url?.startsWith('/models/')) modelHits++;
    if (!cancellationHold.intercept(req, res, () => { void app(req, res); })) void app(req, res);
  });
  // Readiness includes the immutable publication proof; startup is not a render job.
  try {
    await until(async () => (await fetch(`${base}/readyz`)).status === 200, 30_000);
  } catch (error) {
    console.log(JSON.stringify({ status: 'WORKER_CONTROL_PLANE_STARTUP_REFUSED', ready: await startupReadinessDiagnostic(base),
      catalog: await catalogStartupDiagnostic(base, cookie) }));
    throw error;
  }
  console.log(JSON.stringify({ status: 'WORKER_CONTROL_PLANE_STARTUP_VERIFIED', elapsedMs: performance.now() - startupAt }));
  trap = createServer((_req, res) => { trapHits++; res.end('refused probe reached a private address'); });
  trap.on('upgrade', (_req, socket) => { websocketHits++; socket.destroy(); });
  const trapBase = await listen(trap);
  try {
    assert.equal((await fetch(`${trapBase}/positive`)).status, 200);
    assert.equal(trapHits, 1, 'The private-address trap must observe an allowed direct control');
    trapHits = 0;
    assert.equal((await fetch(`${base}/catalog/tools/index.json`)).status, 401);
    const refused = await fetch(`${workerBase}/render`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lw-render-sig': 'invalid' },
      body: JSON.stringify({ toolId: 'qr-code', format: 'svg', query: '', overrides: {}, profile: {}, ts: Date.now() }) });
    assert.equal(refused.status, 401);
    const actualBrowser = await worker.getBrowser();
    browser = actualBrowser;
    const evidencePath: string = '/app/src/sandbox-evidence.ts';
    const { linuxSandboxEvidence } = await import(evidencePath);
    assert.deepEqual(await linuxSandboxEvidence(actualBrowser), { rendererNamespace: true, rendererSeccomp: true, noCapabilities: true });
    assert.equal(await worker.getBrowser(), actualBrowser, 'The actual worker singleton is used');
    let sandboxExecuted = 0, aiDisabled = 0, aiEnabled = 0;
    const diagnostics: Record<string, unknown>[] = [];
    const note = (value: Record<string, unknown>) => { if (diagnostics.length < 24) diagnostics.push(value); };
    const requestPath = (raw: string) => renderDiagnosticPath(raw, base);
    actualBrowser.on('context', context => context.on('page', page => {
      cancellationDiagnostics.progress('page-created');
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) cancellationDiagnostics.progress('main-frame-navigation'); });
      page.on('domcontentloaded', () => cancellationDiagnostics.progress('domcontentloaded'));
      page.on('load', () => cancellationDiagnostics.progress('load'));
      page.on('response', response => { if (response.status() >= 400) note({ kind: 'http', path: requestPath(response.url()), status: response.status() }); });
      page.on('requestfailed', request => {
        const error = request.failure()?.errorText ?? '';
        note({ kind: 'request', path: requestPath(request.url()), error: /^net::ERR_[A-Z_]+$/.test(error) ? error : 'other', errorSha256: hash(Buffer.from(error)) });
      });
      page.on('pageerror', error => note({ kind: 'page', messageSha256: hash(Buffer.from(error.message)), categories: errorCategories(error.message) }));
      page.on('console', message => {
      // Never retain arbitrary tool output; only these fixed control markers count.
      const value = message.text();
      if (value === 'LOLLY_WORKER_EGRESS_CONTROL_RAN') sandboxExecuted++;
      if (value === 'LOLLY_WORKER_AI_DISABLED') aiDisabled++;
      if (value === 'LOLLY_WORKER_AI_ENABLED') aiEnabled++;
      const categories = errorCategories(value);
      if (categories.length) note({ kind: 'console', messageSha256: hash(Buffer.from(value)), categories });
      });
    }));
    const gpuContext = await actualBrowser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await gpuContext.newPage(); await page.goto(base);
      const facts = await page.evaluate(`(async()=>{const gpu=navigator.gpu;if(!gpu||!isSecureContext)return {ok:false};const adapter=await gpu.requestAdapter();if(!adapter)return {ok:false};const device=await adapter.requestDevice();try{return {ok:device.limits.maxStorageBuffersPerShaderStage>=3&&device.limits.maxComputeInvocationsPerWorkgroup>=64&&device.limits.maxComputeWorkgroupSizeX>=64&&device.limits.maxStorageBufferBindingSize>=1048576,software:/swiftshader/i.test([adapter.info?.vendor,adapter.info?.architecture,adapter.info?.description].join(' '))};}finally{device.destroy();}})()`);
      assert.deepEqual(facts, { ok: true, software: true });
    } finally { await gpuContext.close(); }
    diagnostics.length = 0;
    const render = async (format: string, inputs: Record<string, string>) => {
      const response = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ toolId: 'qr-code', format, inputs }), signal: AbortSignal.timeout(25000) });
      if (response.status !== 200) {
        const chunks: Uint8Array[] = []; let size = 0, truncated = false;
        const reader = response.body?.getReader();
        if (reader) try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            if (size + value.length > 32768) { truncated = true; break; }
            chunks.push(value); size += value.length;
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = Buffer.concat(chunks);
        let code = 'unknown', categories: string[] = [];
        try {
          const value = JSON.parse(bytes.toString()) as { error?: { code?: unknown; message?: unknown } };
          if (typeof value.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(value.error.code)) code = value.error.code;
          if (typeof value.error?.message === 'string') categories = errorCategories(value.error.message);
        } catch { /* The original HTTP status remains the acceptance failure. */ }
        console.log(JSON.stringify({ status: 'WORKER_RENDER_FAILURE_METADATA', format, httpStatus: response.status,
          code, categories, responseBytes: bytes.length, responseTruncated: truncated, responseSha256: hash(bytes), browser: diagnostics,
          catalogReads: catalogReads.map(read => ({ ...read, ...(read.elapsedMs === undefined ? { pendingMs: performance.now() - startupAt - read.startMs } : {}) })) }));
      }
      assert.equal(response.status, 200, `${format} through the real control plane and worker`);
      assert.equal(response.headers.get('content-type')?.split(';')[0], format === 'svg' ? 'image/svg+xml' : 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 100 && bytes.length < 16 * 1024 * 1024);
      return bytes;
    };
    const svg = await render('svg', { url: `https://worker.invalid/?nonce=${randomUUID()}` });
    assert.match(svg.toString(), /<svg[\s>]/); assert.match(svg.toString(), /<(?:path|rect|polygon)[\s>]/);
    const png = await render('png', { url: `https://worker.invalid/?nonce=${randomUUID()}` });
    assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(png.subarray(12, 16).toString(), 'IHDR');
    assert.equal(png.readUInt32BE(16), qr.render.width); assert.equal(png.readUInt32BE(20), qr.render.height);
    const sharpSpecifier: string = 'sharp';
    const sharp = (await import(sharpSpecifier)).default;
    const pixels: Buffer = await sharp(png, { limitInputPixels: 1_000_000 }).ensureAlpha().raw().toBuffer();
    let dark = 0, light = 0;
    assert.equal(pixels.length % 4, 0);
    for (let i = 0; i < pixels.length; i += 4) if (pixels.readUInt8(i + 3) > 0) {
      if (pixels.readUInt8(i) < 80 && pixels.readUInt8(i + 1) < 80 && pixels.readUInt8(i + 2) < 80) dark++;
      if (pixels.readUInt8(i) > 200 && pixels.readUInt8(i + 1) > 200 && pixels.readUInt8(i + 2) > 200) light++;
    }
    assert.ok(dark > 100 && light > 100, 'The PNG must contain QR ink and background, not just a valid header');
    assert.ok(ticketReads > 0 && hookReads >= 2, 'Gated catalog read tickets and real QR hooks were consumed');
    assert.equal(actualBrowser.contexts().length, 0);
    // Direct HMAC dispatch retains the route guard even for least-trusted hooks.
    const revision = (await fetch(`${base}/api/auth/config`)).headers.get('x-lolly-brand-revision'); assert.ok(revision);
    const readToken = mintRenderRead([], revision, link);
    const raw = JSON.stringify({ toolId: 'sandbox', query: new URLSearchParams({ html: `<h1>probe</h1><img src="${trapBase}/image"><img src="http://169.254.169.254/latest/meta-data/">`,
      js: `console.log('LOLLY_WORKER_EGRESS_CONTROL_RAN');console.log(globalThis.__LOLLY_AI_DISABLED__===true?'LOLLY_WORKER_AI_DISABLED':'LOLLY_WORKER_AI_ENABLED');try{fetch('${trapBase}/fetch').catch(()=>{});}catch{}try{new WebSocket('${trapBase.replace('http:', 'ws:')}/socket');}catch{}try{new Image().src='${base}/models/refused.onnx';}catch{}` }).toString(),
      brandRevision: revision, readToken, format: 'svg', overrides: {}, profile: {}, ts: Date.now() });
    const egress = await fetch(`${workerBase}/render`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-lw-render-sig': createHmac('sha256', secret).update(raw).digest('base64url') }, body: raw, signal: AbortSignal.timeout(25000) });
    assert.equal(egress.status, 200); assert.match(String((await egress.json() as { svg: string }).svg), /<svg[\s>]/);
    assert.ok(sandboxHookReads > 0, 'The egress probe must execute the real signed Sandbox hook');
    assert.ok(sandboxExecuted > 0 && aiDisabled > 0, 'The real Sandbox code must run with supported AI disabled');
    assert.equal(aiEnabled, 0);
    assert.equal(trapHits, 0); assert.equal(websocketHits, 0); assert.equal(modelHits, 0);
    await until(async () => actualBrowser.contexts().length === 0);
    const directory = envelope.toolDirs?.['qr-code'];
    assert.match(directory, /^[a-f0-9]{64}$/);
    const cancellationTarget = { path: `/tools/qr-code@${directory.slice(0, 16)}/hooks.js`, readToken, revision };
    cancellationBootstrap.arm({ ...cancellationTarget, path: cancellationTarget.path.replace(/hooks\.js$/, 'tool.json') });
    diagnostics.length = 0;
    cancellationDiagnostics.arm(cancellationTarget);
    cancellationHold.arm(cancellationTarget);
    const abort = new AbortController();
    const cancelBody = JSON.stringify({ toolId: 'qr-code', format: 'svg', query: new URLSearchParams({ url: `https://worker.invalid/?nonce=${randomUUID()}` }).toString(),
      overrides: {}, profile: {}, readToken, brandRevision: revision, ts: Date.now() });
    let settled = false, responseStatus: number | undefined, responseAtMs: number | undefined;
    const cancellationAt = performance.now();
    let bootstrapAtMs: number | undefined, readyAtMs: number | undefined, abortAtMs: number | undefined;
    const pending = requestRenderCancellation(`${workerBase}/render`, { 'content-type': 'application/json',
      'x-lw-render-sig': createHmac('sha256', secret).update(cancelBody).digest('base64url') }, cancelBody, abort.signal)
      .then(status => { responseStatus = status; responseAtMs = performance.now() - cancellationAt; return status; })
      .finally(() => { settled = true; });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    void rejection.catch(() => {});
    try {
      // A fresh context imports the shell before fetching its signed manifest.
      // Count only the hook phase against the original five-second predicate.
      await waitForRenderManifestBootstrap(cancellationBootstrap, { settled: () => settled, contexts: () => actualBrowser.contexts().length });
      bootstrapAtMs = performance.now() - cancellationAt;
      await until(async () => cancellationHold.reads > 0);
      assert.equal(settled, false, 'The authoritative signed hook is still held before cancellation');
      assert.equal(actualBrowser.contexts().length, 1);
      assert.equal((await (await fetch(`${workerBase}/readyz`)).json() as { active: number }).active, 1);
      readyAtMs = performance.now() - cancellationAt;
      assert.equal(cancellationHold.pending, cancellationHold.reads, 'Every signed hook response is still held');
      assert.equal(settled, false, 'The render has no response immediately before cancellation');
      assert.equal(responseStatus, undefined, 'No worker response headers precede cancellation');
      assert.equal(abort.signal.aborted, false);
      abortAtMs = performance.now() - cancellationAt; abort.abort(); await rejection;
    } catch (error) {
      const failure = { status: 'WORKER_CANCELLATION_FAILURE_METADATA', elapsedMs: performance.now() - cancellationAt,
        responseStatus, responseAtMs, bootstrapAtMs, readyAtMs, abortAtMs, signalAborted: abort.signal.aborted, settled,
        heldReads: cancellationHold.reads, heldPending: cancellationHold.pending, heldClosed: cancellationHold.closed,
        contexts: actualBrowser.contexts().length, requests: cancellationDiagnostics.snapshot(), browser: diagnostics.map(row => ({ ...row })) };
      const page = actualBrowser.contexts()[0]?.pages()[0];
      const pagePhase = await captureRenderPagePhase(page ? () => page.evaluate(RENDER_PAGE_PHASE_SCRIPT) : undefined);
      console.log(JSON.stringify({ ...failure, pagePhase, pagePhaseCompletedAtMs: performance.now() - cancellationAt }));
      throw error;
    }
    await until(async () => (await (await fetch(`${workerBase}/readyz`)).json() as { active: number }).active === 0);
    assert.equal(actualBrowser.contexts().length, 0);
    await until(async () => cancellationHold.closed === cancellationHold.reads);
    cancellationHold.release();
    assert.match((await render('svg', { url: `https://worker.invalid/?nonce=${randomUUID()}` })).toString(), /<svg[\s>]/);
    assert.equal(actualBrowser.contexts().length, 0);
    console.log(JSON.stringify({ source: pin.generatedFrom, engine: pin.engine.version, browser: actualBrowser.version(), defaultSoftwareWebGpu: true,
      svgSha256: hash(svg), pngSha256: hash(png), darkPixels: dark, lightPixels: light,
      ticketReads, hookReads, sandboxHookReads, sandboxExecuted, aiDisabled, modelHits, trapHits, websocketHits,
      cancelledBootstrapMs: bootstrapAtMs,
      cancelledContextsClosed: true, cancelledResourceReads: cancellationHold.reads, cancelledResourceSocketsClosed: cancellationHold.closed,
      resumedRenderVerified: true, browserSandboxQualified: true, productionAcceptance: false }));
  } finally {
    await finish();
  }
});
