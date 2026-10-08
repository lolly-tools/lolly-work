// SPDX-License-Identifier: MPL-2.0
/**
 * Worker export canary for project files (plan 76 M4j, spec 2.9 and Runbook W).
 * A real Chromium render worker drives a real built Lolly shell that this
 * instance serves, and exports the Screenshot Frame tool with an image that
 * lives in a project's shared files. The worker must read the file with the
 * render's ticket, so the SVG, PNG and PDF carry the uploaded pixels and match
 * a reference export of the same bytes given inline. The same export for
 * someone who cannot see the project must come out without the image.
 *
 * The first test sends the worker the ticket the render mint site would mint
 * (renderFileScope + mintRenderRead, against the same store), with the image
 * named the way the shell's own URL mode names it. The second goes through
 * POST /api/v1/render end to end and is a todo until the render pipeline hands
 * asset inputs to the worker in URL-mode form (see its reason).
 *
 * Gated: set LW_RENDER_CANARY_SHELL to a built shell (shells/web/dist of a lolly
 * checkout, or a copy of it) whose tools/ and catalog/ also serve as the pack.
 * LOLLY_BROWSER_PATH picks a Chromium when the pinned one is not installed.
 * LW_RENDER_CANARY_EVIDENCE names a JSON file for the hashes and request log.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Store } from '../server/src/store/types.ts';

const shell = process.env.LW_RENDER_CANARY_SHELL;
const skip = !shell && 'Set LW_RENDER_CANARY_SHELL to a built Lolly shell to run the worker file-read canary.';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const evidence: Record<string, unknown> = {};
type Env = Awaited<ReturnType<typeof setup>>;
let env: Promise<Env> | undefined;
const once = () => env ??= setup();

after(async () => {
  if (!env) return;
  const ready = await env.catch(() => null);
  evidence.finishedAt = new Date().toISOString();
  if (process.env.LW_RENDER_CANARY_EVIDENCE) await writeFile(process.env.LW_RENDER_CANARY_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  await ready?.close();
});

/** The instance (listening first: the worker's shell must be its origin), the
 *  worker on a real Chromium, three people and one uploaded picture. */
async function setup() {
  const { default: sharp } = await import('sharp');
  const { parseConfig } = await import('../server/src/config/instance.ts');
  const { buildApp } = await import('../server/src/api/app.ts');
  const { createMemoryStore } = await import('../server/src/store/memory.ts');
  const { createMemoryBlobStore } = await import('../server/src/blobs/memory.ts');
  const { fileChecksum } = await import('../server/src/projects/files.ts');
  const requests: { method: string; path: string; ticket: boolean; status?: number }[] = [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const app = createServer((req, res) => {
    const row: { method: string; path: string; ticket: boolean; status?: number } = { method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, ticket: typeof req.headers['x-lw-render-read'] === 'string' };
    if (/^\/api\/v1\/projects\/[^/]+\/files\//.test(row.path)) { requests.push(row); res.once('finish', () => { row.status = res.statusCode; }); }
    void handler!(req, res);
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  process.env.PORT = '0';
  process.env.LW_RENDER_WORKER_SECRET = 'local-file-canary';
  process.env.LOLLY_WEB_BASE = base;
  process.env.LW_RENDER_EXPORT_TIMEOUT_MS = '90000';
  process.env.LW_RENDER_NAV_TIMEOUT_MS = '60000';
  const playwrightPath: string = '../workers/render/node_modules/playwright-core/index.mjs';
  const { chromium } = await import(playwrightPath) as { chromium: { launch(o: object): Promise<{ close(): Promise<void> }> } };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], ...(process.env.LOLLY_BROWSER_PATH ? { executablePath: process.env.LOLLY_BROWSER_PATH } : {}) });
  const worker = await import('../workers/render/src/server.ts');
  worker.__setBrowserGetterForTests(async () => browser as never);
  if (!worker.server.listening) await new Promise((resolve) => worker.server.once('listening', resolve));
  const workerCfg = { url: `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`, secret: process.env.LW_RENDER_WORKER_SECRET, timeoutMs: 240_000 };

  const store: Store = Object.assign(createMemoryStore(), { storageKind: 'postgres' as const });
  const people = ['alice', 'viewer', 'outsider'];
  const link = 'canary-link';
  const config = parseConfig(JSON.stringify({
    instance: { name: 'File canary', baseUrl: base, pack: shell, shellDir: shell },
    policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, render: { worker: { url: workerCfg.url, timeoutMs: workerCfg.timeoutMs } },
    dev: { enabled: true, users: people.map((name) => ({ email: `${name}@test`, name, groups: ['team'] })) },
  }));
  handler = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'canary-session', link, renderWorker: workerCfg.secret } });

  const cookies = new Map<string, string>();
  for (const name of people) {
    const r = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, r.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
  }
  const call = (who: string, method: string, path: string, body?: unknown) => fetch(base + path, {
    method, headers: { cookie: cookies.get(who)!, ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const user = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!;
  for (const name of ['viewer', 'outsider']) await store.putGrant({ principal: `user:${(await user(name)).id}`, action: 'export.server', resource: '*', effect: 'allow' });
  const project = (await (await call('alice', 'POST', '/api/v1/projects', { name: 'M4 acceptance', visibility: 'private' })).json() as { id: string }).id;
  await store.putProjectMember({ projectId: project, userId: (await user('viewer')).id, role: 'viewer', addedBy: 'alice', addedAt: new Date().toISOString() });

  // A picture no default could produce: four flat quadrants.
  const quadrant = async (r: number, g: number, b: number) => sharp({ create: { width: 160, height: 100, channels: 3, background: { r, g, b } } }).png().toBuffer();
  const bytes = new Uint8Array(await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite([
    { input: await quadrant(228, 0, 43), left: 0, top: 0 }, { input: await quadrant(0, 163, 224), left: 160, top: 0 },
    { input: await quadrant(255, 205, 0), left: 0, top: 100 }, { input: await quadrant(0, 150, 57), left: 160, top: 100 },
  ]).png().toBuffer());
  const checksum = fileChecksum(bytes);
  const begun = await call('alice', 'POST', `/api/v1/projects/${project}/files`, { name: 'quadrants.png', contentType: 'image/png', size: bytes.length, checksum,
    parts: [{ size: bytes.length, checksum }], asset: { type: 'raster', format: 'png', width: 320, height: 200 } });
  assert.equal(begun.status, 201, await begun.clone().text());
  const fileId = ((await begun.json()) as { file: { id: string } }).file.id;
  assert.equal((await call('alice', 'PUT', `/api/v1/projects/${project}/files/${fileId}/parts/0`, bytes)).status, 204);
  assert.equal((await call('alice', 'POST', `/api/v1/projects/${project}/files/${fileId}/finalize`, {})).status, 200);
  Object.assign(evidence, { base, shell, startedAt: new Date().toISOString(), project, fileId, uploadSha256: checksum });
  return {
    base, store, call, user, project, fileId, bytes, link, workerCfg, requests,
    address: `${base}/api/v1/projects/${project}/files/${fileId}`,
    inline: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    pixels: async (data: Uint8Array) => sha(await sharp(data).ensureAlpha().raw().toBuffer()),
    async close() {
      worker.__setBrowserGetterForTests(null);
      await browser.close();
      await new Promise<void>((resolve) => worker.server.close(() => resolve()));
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
}

/** Sha256 of every PNG an SVG embeds as a data: URI. */
const embedded = (svg: string) => [...svg.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map((m) => sha(Buffer.from(m[1]!, 'base64')));

test('the worker reads a project image with the render ticket, and its SVG, PNG and PDF carry the uploaded pixels', { skip, timeout: 300_000 }, async () => {
  const e = await once();
  const { renderFileScope, mintRenderRead } = await import('../server/src/render/read-ticket.ts');
  const { effectiveProjectAccess } = await import('../server/src/rbac/project-access.ts');
  const { renderViaWorker, rasteriseViaWorker } = await import('../server/src/render/worker-client.ts');
  const revision = (await fetch(`${e.base}/api/auth/config`)).headers.get('x-lolly-brand-revision')!;
  // What the mint site in api/app.ts does for this submitter and query.
  const projectAccessOf = async (u: Parameters<typeof effectiveProjectAccess>[0], p: Parameters<typeof effectiveProjectAccess>[1]) =>
    effectiveProjectAccess(u, p, await e.store.getProjectMember(p.id, u.id), await e.store.listGrants());
  const ticketFor = async (who: string, query: string) => {
    const scope = await renderFileScope({ store: e.store, projectAccessOf }, query, await e.user(who));
    return { scope, token: mintRenderRead((await e.user(who)).groups, revision, e.link, scope) };
  };
  const exportFor = async (who: string, image?: string) => {
    const query = new URLSearchParams({ title: 'M4 canary', ...(image ? { image } : {}) }).toString();
    const { scope, token } = await ticketFor(who, query);
    const started = Date.now();
    const svg = await renderViaWorker(e.workerCfg, { toolId: 'frame', query, overrides: {}, format: 'svg', profile: {}, readToken: token, brandRevision: revision });
    const png = await rasteriseViaWorker(e.workerCfg, { svg, format: 'png' });
    const pdf = await rasteriseViaWorker(e.workerCfg, { svg, format: 'pdf' });
    return { scope, svg, png: new Uint8Array(png.bytes), pdf: new Uint8Array(pdf.bytes), ms: Date.now() - started };
  };
  const fromFile = await exportFor('viewer', e.address);
  assert.deepEqual(fromFile.scope, { projectId: e.project, ids: [e.fileId], userId: (await e.user('viewer')).id });
  const reference = await exportFor('viewer', e.inline);
  const outsider = await exportFor('outsider', e.address);
  assert.equal(outsider.scope, undefined, 'no file scope for someone who cannot see the project');
  const blank = await exportFor('viewer');
  const result = (x: typeof fromFile) => ({ svgSha256: sha(x.svg), svgImages: embedded(x.svg), pngSha256: sha(x.png), pngPixels: '', pdfSha256: sha(x.pdf), ms: x.ms });
  const rows = { fromFile: result(fromFile), reference: result(reference), outsider: result(outsider), blank: result(blank) };
  for (const [key, x] of [['fromFile', fromFile], ['reference', reference], ['outsider', outsider], ['blank', blank]] as const) rows[key].pngPixels = await e.pixels(x.png);
  evidence.direct = rows;

  assert.ok(rows.fromFile.svgImages.includes(sha(e.bytes)), 'the SVG embeds the uploaded bytes exactly');
  assert.deepEqual(rows.fromFile.svgImages, rows.reference.svgImages);
  assert.equal(rows.fromFile.pngPixels, rows.reference.pngPixels, 'the PNG has the reference pixels');
  assert.notEqual(rows.fromFile.pngPixels, rows.blank.pngPixels, 'and they are not the frame without a picture');
  assert.equal(rows.fromFile.pdfSha256, rows.reference.pdfSha256, 'the PDF matches the reference byte for byte');
  assert.equal(rows.outsider.pngPixels, rows.blank.pngPixels, 'no access, no picture');
  assert.deepEqual(rows.outsider.svgImages, []);
  const reads = e.requests.filter((r) => r.method === 'GET' && r.path === `/api/v1/projects/${e.project}/files/${e.fileId}`);
  evidence.fileReads = reads;
  assert.ok(reads.length >= 2 && reads.every((r) => r.ticket), 'every worker read carried the ticket');
  assert.deepEqual(reads.map((r) => r.status).sort(), [200, 401], 'the viewer’s read was served and the outsider’s refused');
});

test('POST /api/v1/render exports a document whose image is a project file', {
  skip, timeout: 300_000,
  todo: 'blocked outside W4: render/pipeline.ts queryFromValues hands the worker asset inputs as JSON objects, which the shell reads as an asset id, so no asset input reaches a worker export; and a user/team/<file> id also needs the shell to fetch project files in export mode',
}, async () => {
  const e = await once();
  const render = async (format: string, image: string) => {
    const r = await e.call('viewer', 'POST', '/api/v1/render', { toolId: 'frame', format, inputs: { title: 'M4 canary', image } });
    const out = new Uint8Array(await r.arrayBuffer());
    assert.equal(r.status, 200, Buffer.from(out).toString('utf8').slice(0, 300));
    return out;
  };
  const rows: Record<string, unknown> = {};
  evidence.api = rows;
  for (const [label, image] of [['address', e.address], ['assetId', `user/team/${e.fileId}`]] as const) {
    const svg = Buffer.from(await render('svg', image)).toString('utf8');
    rows[label] = { svgImages: embedded(svg) };
    assert.ok(embedded(svg).includes(sha(e.bytes)), `${label}: the exported SVG embeds the uploaded bytes`);
  }
});
