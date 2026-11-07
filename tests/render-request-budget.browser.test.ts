// SPDX-License-Identifier: MPL-2.0
/**
 * Browser canary for the render worker's request budget (plans/82 M3,
 * W-M3-6): with a real built Lolly shell, a hooked pack tool (qr-code) and
 * a Design rules tool both render through the worker, each within the budget
 * the worker derives from that shell. countdown-timer is not here: its
 * template draws an SVG, so it renders in process and never meets the
 * worker. Set LW_RENDER_CANARY_SHELL to a built shell (its dist, which also
 * carries tools/ and catalog/) to run it.
 *
 * A release shell pins a catalog public key and refuses a catalog the
 * instance does not sign. For one, also set LW_RENDER_CANARY_PUBLIC_KEY to
 * the public JWK it was built with and LW_RENDER_CANARY_SIGNING_KEY to that
 * disposable fixture's private key, as the project-files canary takes them.
 * The third render is the preview deploy smoke's own request: a member
 * service token whose only grant is export.server on tool:qr-code.
 *
 * Why the budget matters (plan 353, 2026-11-07): a lolly.ing release shell
 * built with SUSE and Lolly Demo side by side takes 516 requests for a
 * qr-code render, 7 more than with SUSE alone (509), so the flat 512 refused
 * it and the smoke got a 502.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Browser } from '../workers/render/node_modules/playwright-core/types/types.d.ts';

const shell = process.env.LW_RENDER_CANARY_SHELL;
const skip = !shell && 'Set LW_RENDER_CANARY_SHELL to a built Lolly shell to run the request budget canary.';
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
type Env = Awaited<ReturnType<typeof setup>>;
let env: Promise<Env> | undefined;
const once = () => env ??= setup();

after(async () => { await (await env?.catch(() => null))?.close(); });

/** A Share with rules file as Design makes one: the font travels inside, so the export's layout check can measure the text. */
async function rulesFile(): Promise<Buffer> {
  const ENGINE: string = '@lolly/engine';
  const { compileDesignTool } = await import(ENGINE) as {
    compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
  };
  const { ZipBuilder } = await import('../server/src/links/zip.ts');
  const renderer = await readFile(join(shell!, 'tools', 'design', 'assets', 'rules-renderer.js'), 'utf8');
  const font = new Uint8Array(await readFile(join(shell!, 'fonts', 'SUSE[wght].ttf')));
  const fontPath = `assets/${sha256(font)}.ttf`;
  const family = `LollyFont${sha256('budget-sheet/1.0.0/SUSE').slice(0, 16)}`;
  const face = `@font-face{font-family:'${family}';src:url('data:font/ttf;base64,${Buffer.from(font).toString('base64')}');font-weight:400;font-style:normal;}\n`;
  const definition = {
    schemaVersion: 1, id: 'budget-sheet', name: 'Budget sheet', description: 'A price on a sheet.', version: '1.0.0', presentation: 'sidebar', formats: ['svg'],
    inputs: [{ input: { id: 'price', label: 'Your price', type: 'text', default: '€ 1,240', maxLength: 40 }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] }],
    variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [
      { id: 'price', kind: 'text', x: 48, y: 260, w: 500, h: 50, text: '€ 1,240', fontSize: 36, fg: '#0c322c', name: 'Price', font: family, weight: '400' },
    ] }],
    defaultVariant: 'a4', choices: [], recipes: [], compilerVersion: 1, rendererDigest: sha256(renderer), css: face,
    dependencies: [{ path: fontPath, digest: sha256(font), credit: 'SUSE: embedded font for editable artwork.' }],
  };
  const compiled = compileDesignTool(definition, { source: renderer, styles: '' }, { [fontPath]: font });
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
  const manifest = { format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: definition.id, version: definition.version },
    bundledTool: { id: definition.id, version: definition.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) }, integrity };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}

async function setup() {
  const { parseConfig } = await import('../server/src/config/instance.ts');
  const { buildApp } = await import('../server/src/api/app.ts');
  const { createMemoryStore } = await import('../server/src/store/memory.ts');
  const { createMemoryBlobStore } = await import('../server/src/blobs/memory.ts');
  const { requestBudgetFor, shellAppFiles } = await import('../workers/render/src/request-budget.ts');
  let counting = false;
  let served = 0;
  // What a failed render leaves behind: refused requests and the page's own errors.
  const failed: string[] = [];
  const diagnostics: string[] = [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const app = createServer((req, res) => {
    // The renders' own API calls come from this test with a session cookie or a
    // service token; the page's carry neither.
    if (counting && !req.headers.cookie?.includes('lw_session=') && !req.headers.authorization) served++;
    const path = (req.url ?? '').split('?')[0]!;
    res.once('finish', () => { if (counting && res.statusCode >= 400 && failed.length < 20) failed.push(`${res.statusCode} ${path}`); });
    void handler!(req, res);
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  process.env.PORT = '0';
  process.env.LW_RENDER_WORKER_SECRET = 'request-budget-canary';
  process.env.LOLLY_WEB_BASE = base;
  process.env.LW_RENDER_EXPORT_TIMEOUT_MS ??= '90000';
  process.env.LW_RENDER_NAV_TIMEOUT_MS = '60000';
  const playwrightPath: string = '../workers/render/node_modules/playwright-core/index.mjs';
  const { chromium } = await import(playwrightPath) as { chromium: { launch(o: object): Promise<Browser> } };
  const { workerBrowserOptions } = await import('../workers/render/src/browser-launch.ts');
  const browser = await chromium.launch(workerBrowserOptions());
  const createContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await createContext(options);
    context.on('page', (page) => {
      page.on('pageerror', (error) => { if (diagnostics.length < 20) diagnostics.push(error.message.slice(0, 500)); });
      page.on('console', (message) => { if (message.type() === 'error' && diagnostics.length < 20) diagnostics.push(message.text().slice(0, 500)); });
    });
    return context;
  };
  const worker = await import('../workers/render/src/server.ts');
  worker.__setBrowserGetterForTests(async () => browser as never);
  if (!worker.server.listening) await new Promise((resolve) => worker.server.once('listening', resolve));
  const catalogPublicKey = process.env.LW_RENDER_CANARY_PUBLIC_KEY ? JSON.parse(process.env.LW_RENDER_CANARY_PUBLIC_KEY) as Record<string, unknown> : undefined;
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Budget canary', baseUrl: base, pack: shell, shellDir: shell, ...(catalogPublicKey ? { catalogPublicKey } : {}) },
    rateLimit: { enabled: false },
    render: { worker: { url: `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`, timeoutMs: 240_000 } },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'rita@northwind.test', groups: [] }] },
  }));
  const store = createMemoryStore();
  handler = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'budget-session', link: 'budget-link', renderWorker: 'request-budget-canary',
    ...(process.env.LW_RENDER_CANARY_SIGNING_KEY ? { catalogSigningKey: process.env.LW_RENDER_CANARY_SIGNING_KEY } : {}) } });
  // The preview deploy smoke's account (deploy/preview/lib/preview_ing_node.py):
  // a member service token whose only grant is export.server on tool:qr-code.
  const { mintServiceSecret } = await import('../server/src/iam/service-tokens.ts');
  const smoke = mintServiceSecret();
  await store.putApiToken({ id: 'tok_budgetsmoke', label: 'smoke', role: 'member', tokenHash: smoke.tokenHash,
    createdBy: 'user:canary', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  await store.putGrant({ principal: 'user:svc_tok_budgetsmoke', action: 'export.server', resource: 'tool:qr-code', effect: 'allow' });
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' }))
    .headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const admin = await login('admin@test');
  const call = async (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method,
    headers: { cookie, 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) });
  // A partner programme with a Design rules tool, and Rita in it with server exports.
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  const rita = await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  const ritaId = (await store.listUsers()).find((u) => u.email === 'rita@northwind.test')!.id;
  await store.putGrant({ principal: `user:${ritaId}`, action: 'export.server', resource: '*', effect: 'allow' });
  const upload = await call(admin, 'POST', '/api/v1/programmes/resellers/templates/rules-file?groups=programme-resellers', new Uint8Array(await rulesFile()));
  assert.equal(upload.status, 201, await upload.text());
  const budget = requestBudgetFor(shellAppFiles(JSON.parse(await readFile(join(shell!, 'precache.json'), 'utf8'))));
  return {
    budget,
    /** One server render, counting the requests the worker's page made to the instance. */
    async render(who: 'admin' | 'rita' | 'smoke', toolId: string, inputs: Record<string, unknown>) {
      served = 0; counting = true; failed.length = 0; diagnostics.length = 0;
      try {
        const res = who === 'smoke'
          ? await fetch(`${base}/api/v1/render`, { method: 'POST', body: JSON.stringify({ toolId, format: 'svg', inputs }),
            headers: { authorization: `Bearer ${smoke.secret}`, 'content-type': 'application/json', accept: 'image/svg+xml' } })
          : await call(who === 'admin' ? admin : await login('rita@northwind.test'), 'POST', '/api/v1/render', { toolId, format: 'svg', inputs });
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()).toString('utf8'), requests: served,
          failed: [...failed], diagnostics: [...diagnostics] };
      } finally { counting = false; void rita; }
    },
    async close() {
      worker.__setBrowserGetterForTests(null);
      await browser.close();
      await new Promise<void>((resolve) => worker.server.close(() => resolve()));
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
}

test('qr-code, a Design rules tool and the deploy smoke\'s own request render through the worker within the budget it derives from the shell', { skip, timeout: 600_000 }, async () => {
  const e = await once();
  assert.ok(e.budget > 512, `the derived budget (${e.budget}) is above the old flat 512`);
  for (const [who, toolId, inputs] of [['admin', 'qr-code', { url: 'https://example.com' }], ['rita', 'budget-sheet', { price: '€ 990' }],
    ['smoke', 'qr-code', { url: 'https://lolly.example/?preview-smoke=1' }]] as const) {
    const out = await e.render(who, toolId, inputs);
    assert.equal(out.status, 200, `${who} ${toolId}: ${out.body.slice(0, 300)}\nrefused: ${out.failed.join(', ')}\npage: ${out.diagnostics.join(' | ')}`);
    assert.match(out.body, /<svg[\s>]/, `${toolId} is an SVG`);
    assert.ok(out.requests > 0 && out.requests <= e.budget, `${who} ${toolId}: ${out.requests} requests within ${e.budget}`);
    console.log(`${who} ${toolId}: ${out.requests} requests, budget ${e.budget}`);
  }
});
