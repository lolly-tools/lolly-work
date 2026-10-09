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
type WorkerModule = typeof import('../workers/render/src/server.ts');

const skip = process.env.LOLLY_RENDER_IMAGE_TEST !== '1' && 'Run qualify-render-worker-image.ts with the built image and matched signed shell.';
const shell = '/qualification/shell';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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

test('built worker uses its actual browser for signed 1.248 QR SVG/PNG, tickets, cancellation and egress', { skip, timeout: 90_000 }, async t => {
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/lolly-browsers');
  assert.ok(!process.env.LOLLY_BROWSER_PATH && !process.env.LOLLY_BROWSER_CHANNEL);
  const sourceRoot = new URL('../workers/render/src/', import.meta.url);
  const sources = (await readdir(sourceRoot)).sort();
  assert.deepEqual((await readdir('/app/src')).sort(), sources, 'Image source inventory must match this checkout');
  for (const file of sources) assert.equal(hash(await readFile(join('/app/src', file))), hash(await readFile(new URL(file, sourceRoot))), file);
  const pin = JSON.parse(await readFile(new URL('../engine-pin.json', import.meta.url), 'utf8'));
  assert.equal(process.env.LOLLY_TEST_SHELL_SOURCE, pin.generatedFrom);
  assert.equal(pin.engine.version, '1.248.0');
  const material = process.env.LW_CATALOG_SIGNING_KEY;
  const publicMaterial = process.env.LOLLY_TEST_CATALOG_PUBLIC_KEY_JWK;
  assert.ok(material && publicMaterial);
  const signing = await importCatalogSigningKey(material);
  assert.deepEqual(signing.publicJwk, JSON.parse(publicMaterial));
  const engineSpecifier: string = '@lolly/engine';
  const { importSpkiOrJwkPublicKey, verifyCatalogEnvelope, verifyToolFile } = await import(engineSpecifier);
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
  process.env.PORT = '0'; process.env.LW_RENDER_WORKER_SECRET = secret;
  // These are the normal production defaults, not the longer legacy browser-test values.
  delete process.env.LW_RENDER_EXPORT_TIMEOUT_MS; delete process.env.LW_RENDER_NAV_TIMEOUT_MS;
  process.env.LW_RENDER_MAX_CONCURRENT = '1';
  let worker: WorkerModule | undefined, browser: Awaited<ReturnType<WorkerModule['getBrowser']>> | undefined, trap: Server | undefined;
  let hold = false, releaseHold: (() => void) | undefined, held = false;
  const server = createServer(); const base = await listen(server);
  let cleanup: Promise<void> | undefined;
  const finish = () => cleanup ??= (async () => {
    hold = false; releaseHold?.();
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
    idp: { additional: [{ id: 'email', kind: 'password' }] }, rateLimit: { enabled: false },
    render: { allowHooksInFastPath: false, worker: { url: workerBase, timeoutMs: 20000 } }, policy: { defaultAccessMode: 'gated' } }));
  const app = buildApp({ config, store, secrets: { session, link, renderWorker: secret, catalogSigningKey: material }, backgroundPollMs: 0 });
  const owner = await store.upsertUserBySub({ sub: 'owned-image-test', email: 'owner@worker.invalid', groups: ['owner'], role: 'owner' });
  const cookie = mintSessionCookie({ sub: owner.sub, email: owner.email, name: 'Image test owner', groups: owner.groups, role: owner.role, epoch: owner.sessionEpoch }, session, false).split(';')[0];
  assert.ok(cookie);
  let ticketReads = 0, hookReads = 0, sandboxHookReads = 0, modelHits = 0, trapHits = 0, websocketHits = 0;
  server.on('request', (req, res) => {
    if (req.headers['x-lw-render-read']) ticketReads++;
    if (req.url?.startsWith('/tools/qr-code/hooks.js')) hookReads++;
    if (req.url?.startsWith('/tools/sandbox/hooks.js')) sandboxHookReads++;
    if (req.url?.startsWith('/models/')) modelHits++;
    if (hold && req.url?.startsWith('/catalog/tools/index.json')) {
      held = true; const gate = new Promise<void>(resolve => { releaseHold = resolve; });
      void gate.then(() => { if (!res.destroyed) void app(req, res); });
    } else void app(req, res);
  });
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
    assert.equal(await worker.getBrowser(), actualBrowser, 'The actual worker singleton is used');
    let sandboxExecuted = 0, aiDisabled = 0, aiEnabled = 0;
    actualBrowser.on('context', context => context.on('page', page => page.on('console', message => {
      // Never retain arbitrary tool output; only these fixed control markers count.
      const value = message.text();
      if (value === 'LOLLY_WORKER_EGRESS_CONTROL_RAN') sandboxExecuted++;
      if (value === 'LOLLY_WORKER_AI_DISABLED') aiDisabled++;
      if (value === 'LOLLY_WORKER_AI_ENABLED') aiEnabled++;
    })));
    const gpuContext = await actualBrowser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await gpuContext.newPage(); await page.goto(base);
      const facts = await page.evaluate(`(async()=>{const gpu=navigator.gpu;if(!gpu||!isSecureContext)return {ok:false};const adapter=await gpu.requestAdapter();if(!adapter)return {ok:false};const device=await adapter.requestDevice();try{return {ok:device.limits.maxStorageBuffersPerShaderStage>=3&&device.limits.maxComputeInvocationsPerWorkgroup>=64&&device.limits.maxComputeWorkgroupSizeX>=64&&device.limits.maxStorageBufferBindingSize>=1048576,software:/swiftshader/i.test([adapter.info?.vendor,adapter.info?.architecture,adapter.info?.description].join(' '))};}finally{device.destroy();}})()`);
      assert.deepEqual(facts, { ok: true, software: true });
    } finally { await gpuContext.close(); }
    const render = async (format: string, inputs: Record<string, string>) => {
      const response = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ toolId: 'qr-code', format, inputs }), signal: AbortSignal.timeout(25000) });
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
    hold = true;
    const abort = new AbortController();
    const cancelBody = JSON.stringify({ toolId: 'qr-code', format: 'svg', query: new URLSearchParams({ url: `https://worker.invalid/?nonce=${randomUUID()}` }).toString(),
      overrides: {}, profile: {}, readToken, brandRevision: revision, ts: Date.now() });
    const pending = fetch(`${workerBase}/render`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-lw-render-sig': createHmac('sha256', secret).update(cancelBody).digest('base64url') }, body: cancelBody, signal: abort.signal });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    await until(async () => held);
    abort.abort(); await rejection;
    await until(async () => (await (await fetch(`${workerBase}/readyz`)).json() as { active: number }).active === 0);
    assert.equal(actualBrowser.contexts().length, 0);
    hold = false; releaseHold?.();
    console.log(JSON.stringify({ source: pin.generatedFrom, engine: pin.engine.version, browser: actualBrowser.version(), defaultSoftwareWebGpu: true,
      svgSha256: hash(svg), pngSha256: hash(png), darkPixels: dark, lightPixels: light,
      ticketReads, hookReads, sandboxHookReads, sandboxExecuted, aiDisabled, modelHits, trapHits, websocketHits,
      cancelledContextsClosed: true, browserSandboxQualified: false, productionAcceptance: false }));
  } finally {
    await finish();
  }
});
