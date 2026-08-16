/**
 * The render plane (fourth HostV1 shell) end-to-end over real HTTP: a temp pack
 * with real hook-less tools rendered by the real engine to SVG + PNG, policy
 * enforcement (locked inputs → 422 + baked value), the hooked-tool refusal + its
 * curated-pack override, signed-link serving, and the preview watermark.
 *
 * Kept in its own file (own server + pack) so it doesn't couple to app.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';

interface Harness { server: Server; base: string; store: ReturnType<typeof createMemoryStore> }

let pack = '';
const harnesses: Harness[] = [];

/** A minimal, valid, hook-less card manifest - text `title` + color `bg`, svg+png. */
function cardManifest(id: string): object {
  return {
    id, name: id, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 400, height: 200, formats: ['svg', 'png'] },
    inputs: [
      { id: 'title', label: 'Title', type: 'text', default: 'Hello' },
      { id: 'bg', label: 'Background', type: 'color', default: '#204080' },
    ],
  };
}
const CARD_TEMPLATE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect x="0" y="0" width="400" height="200" fill="{{bg}}"/>' +
  '<text x="20" y="110" font-size="28" fill="#ffffff">{{title}}</text></svg>';

async function writeCard(id: string): Promise<void> {
  const dir = join(pack, 'tools', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tool.json'), JSON.stringify(cardManifest(id), null, 2));
  await writeFile(join(dir, 'template.html'), CARD_TEMPLATE);
}

async function makeServer(overrides: Record<string, unknown>, overlays: ToolOverlay[] = [], secretsExt: Record<string, string> = {}): Promise<Harness> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Render Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'marketer@test', name: 'Mia Marketer', groups: ['marketing'] },
      ],
    },
    ...overrides,
  }));
  const store = createMemoryStore({ overlays });
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3', ...secretsExt } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const h: Harness = { server, base, store };
  harnesses.push(h);
  return h;
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0] as string;
}

let main: Harness;
let hooksAllowed: Harness;

// Overlays on the MAIN server: `locked-card` locks `bg`; `wm-card` forces the mark.
const LOCK_OVERLAY: ToolOverlay = {
  toolId: 'locked-card', version: 1,
  inputAccess: { bg: [{ groups: ['*'], level: 'locked', value: '#123456' }] },
};
const WM_OVERLAY: ToolOverlay = {
  toolId: 'wm-card', version: 1,
  enforce: { watermark: 'always' },
};
// `fmt-card` may only export SVG server-side; 'pdf' is deliberately a format
// this deployment cannot produce, so the org_config intersection must drop it.
const FMT_OVERLAY: ToolOverlay = {
  toolId: 'fmt-card', version: 1,
  enforce: { formats: ['svg', 'pdf'] },
};

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-render-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({
    version: 3, tools: [{ id: 'test-card' }, { id: 'locked-card' }, { id: 'wm-card' }, { id: 'fmt-card' }, { id: 'hooky' }],
  }));
  await writeCard('test-card');
  await writeCard('locked-card');
  await writeCard('wm-card');
  await writeCard('fmt-card');
  // A hooked tool - its presence of hooks.js is what the fast path refuses.
  const hookyDir = join(pack, 'tools', 'hooky');
  await mkdir(hookyDir, { recursive: true });
  await writeFile(join(hookyDir, 'tool.json'), JSON.stringify({
    id: 'hooky', name: 'Hooky', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 400, height: 200, formats: ['svg', 'png'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hooked' }],
    hooks: { onInit: true },
  }, null, 2));
  await writeFile(join(hookyDir, 'template.html'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
    '<rect width="400" height="200" fill="#0b7285"/>' +
    '<text x="20" y="110" font-size="28" fill="#fff">{{title}}</text></svg>');
  await writeFile(join(hookyDir, 'hooks.js'), 'function onInit(ctx) { return {}; }\n');

  main = await makeServer({}, [LOCK_OVERLAY, WM_OVERLAY, FMT_OVERLAY]);
  hooksAllowed = await makeServer({ render: { allowHooksInFastPath: true } });
});

after(() => { for (const h of harnesses) h.server.close(); });

test('(a) SVG render: 200 with the title in the bytes, ETag, then 304 on If-None-Match', async () => {
  const cookie = await login(main.base, 'admin@test');
  const res = await fetch(`${main.base}/render/test-card.svg?title=HELLOWORLD`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  const etag = res.headers.get('etag');
  assert.ok(etag && etag.startsWith('"r-'), 'ETag present');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=60');
  const svg = await res.text();
  assert.match(svg, /<svg/);
  assert.ok(svg.includes('HELLOWORLD'), 'title baked into the SVG');

  const again = await fetch(`${main.base}/render/test-card.svg?title=HELLOWORLD`, {
    headers: { cookie, 'if-none-match': etag as string },
  });
  assert.equal(again.status, 304);
});

test('(a2) render is gated: no session → 401; a member without export.server → 403', async () => {
  assert.equal((await fetch(`${main.base}/render/test-card.svg?title=x`)).status, 401);
  const marketer = await login(main.base, 'marketer@test');
  const denied = await fetch(`${main.base}/render/test-card.svg?title=x`, { headers: { cookie: marketer } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
});

test('(b) PNG render returns PNG magic bytes', async () => {
  const cookie = await login(main.base, 'admin@test');
  const res = await fetch(`${main.base}/render/test-card.png?title=Pixels`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
});

test('(c) locked input: supplying it → 422 INPUT_LOCKED; omitting it bakes the policy value', async () => {
  const cookie = await login(main.base, 'admin@test');
  // Supplying the locked `bg` is refused.
  const refused = await fetch(`${main.base}/render/locked-card.svg?title=Hi&bg=%23ff0000`, { headers: { cookie } });
  assert.equal(refused.status, 422);
  const body = await refused.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'INPUT_LOCKED');
  assert.match(body.error.message, /bg/);
  // Probing a locked param is audited as render.denied.
  const audit = await main.store.listAudit();
  assert.ok(audit.some((e) => e.action === 'render.denied'), 'render.denied audited');

  // Omitting it renders, with the LOCKED value baked over the tool default.
  const ok = await fetch(`${main.base}/render/locked-card.svg?title=Hi`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  const svg = await ok.text();
  assert.ok(svg.includes('#123456'), 'locked bg value baked into the SVG');
  assert.ok(!svg.includes('#204080'), 'the tool default was overridden by the lock');
});

test('(d) hooked tool: refused 501 by default; renders when the pack allows fast-path hooks', async () => {
  const cookie = await login(main.base, 'admin@test');
  const refused = await fetch(`${main.base}/render/hooky.svg?title=Nope`, { headers: { cookie } });
  assert.equal(refused.status, 501);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'HOOKED_TOOL_NEEDS_CHROMIUM');

  const allowCookie = await login(hooksAllowed.base, 'admin@test');
  const rendered = await fetch(`${hooksAllowed.base}/render/hooky.svg?title=HOOKRUN`, { headers: { cookie: allowCookie } });
  assert.equal(rendered.status, 200);
  const svg = await rendered.text();
  assert.ok(svg.includes('HOOKRUN'), 'the hooked tool rendered (trivial onInit returning {})');
});

test('(e) share link serves rendered bytes with a public cache header; revoked → 410', async () => {
  const cookie = await login(main.base, 'admin@test');
  const mint = await fetch(`${main.base}/api/v1/links`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'share', target: { toolId: 'test-card', params: { title: 'LINKED' }, format: 'svg' } }),
  });
  assert.equal(mint.status, 201);
  const { id, url } = await mint.json() as { id: string; url: string };
  const path = url.replace('http://localhost', main.base);

  const served = await fetch(path);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/svg+xml');
  assert.equal(served.headers.get('cache-control'), 'public, max-age=300');
  assert.ok((await served.text()).includes('LINKED'), 'the link renders its baked params');

  const revoke = await fetch(`${main.base}/api/v1/links/${id}/revoke`, { method: 'POST', headers: { cookie } });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(path)).status, 410);
});

test('(e2) download link serves an attachment', async () => {
  const cookie = await login(main.base, 'admin@test');
  const mint = await fetch(`${main.base}/api/v1/links`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'download', target: { toolId: 'test-card', params: { title: 'DL' }, format: 'png' } }),
  });
  const { url } = await mint.json() as { url: string };
  const res = await fetch(url.replace('http://localhost', main.base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="test-card\.png"/);
});

test('(f) watermark: enforce.watermark "always" injects the PREVIEW pattern; a clean tool does not', async () => {
  const cookie = await login(main.base, 'admin@test');
  const marked = await (await fetch(`${main.base}/render/wm-card.svg?title=Draft`, { headers: { cookie } })).text();
  assert.ok(marked.includes('lw-preview-watermark'), 'watermark pattern injected');
  assert.ok(marked.includes('PREVIEW'), 'PREVIEW text present');

  const clean = await (await fetch(`${main.base}/render/test-card.svg?title=Final`, { headers: { cookie } })).text();
  assert.ok(!clean.includes('lw-preview-watermark'), 'unmarked tool carries no watermark');
});

// ── (f) Chromium worker dispatch (plans/07/11) ────────────────────────────────
// A hooked tool renders via an isolated worker when one is configured. We stand
// up a MOCK worker that verifies the HMAC and returns a canned SVG - proving the
// control plane signs correctly, dispatches hooked tools, and post-processes the
// worker's SVG (here: passes it through for .svg) exactly like an in-process one.
test('(f) hooked tool dispatches to a configured Chromium worker; HMAC-signed', async () => {
  const { createHmac } = await import('node:crypto');
  const SECRET = 'worker-shared-key';
  let sawSig = false;
  let sawToolId = '';
  const worker = createServer((req, res) => {
    void (async () => {
      if (req.url === '/healthz') { res.writeHead(200); res.end('{}'); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const expect = createHmac('sha256', SECRET).update(raw).digest('base64url');
      sawSig = req.headers['x-lw-render-sig'] === expect;
      const job = JSON.parse(raw) as { toolId: string; overrides: Record<string, unknown> };
      sawToolId = job.toolId;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><text>WORKER_RENDER</text></svg>' }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((r) => worker.listen(0, () => r()));
  const waddr = worker.address();
  const workerBase = `http://127.0.0.1:${typeof waddr === 'object' && waddr ? waddr.port : 0}`;

  const srv = await makeServer(
    { render: { allowHooksInFastPath: false, worker: { url: workerBase, timeoutMs: 5000 } } },
    [],
    { renderWorker: SECRET },
  );
  const cookie = await login(srv.base, 'admin@test');
  const res = await fetch(`${srv.base}/render/hooky.svg?title=VIAWORKER`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const svg = await res.text();
  assert.ok(svg.includes('WORKER_RENDER'), 'served the SVG the worker returned');
  assert.ok(sawSig, 'worker received a valid HMAC signature');
  assert.equal(sawToolId, 'hooky');
  worker.close();
});

test('(g) hooked tool still 501s when no worker is configured', async () => {
  // The main harness has no worker → the existing refusal is preserved.
  const cookie = await login(main.base, 'admin@test');
  const refused = await fetch(`${main.base}/render/hooky.svg?title=x`, { headers: { cookie } });
  assert.equal(refused.status, 501);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'HOOKED_TOOL_NEEDS_CHROMIUM');
});

test('(i) raster delegates to the worker /rasterise when configured (single-rasteriser path)', async () => {
  const { createHmac } = await import('node:crypto');
  const SECRET = 'raster-shared-key';
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let sawSig = false, sawSvg = false, sawFormat = '', sawPath = '';
  const worker = createServer((req, res) => {
    void (async () => {
      if (req.url === '/healthz') { res.writeHead(200); res.end('{}'); return; }
      sawPath = (req.url ?? '').split('?')[0] ?? '';
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      sawSig = req.headers['x-lw-render-sig'] === createHmac('sha256', SECRET).update(raw).digest('base64url');
      const job = JSON.parse(raw) as { svg?: string; format?: string };
      sawSvg = typeof job.svg === 'string' && /<svg/i.test(job.svg);
      sawFormat = job.format ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bytesB64: PNG_B64, mime: 'image/png' }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((r) => worker.listen(0, () => r()));
  const waddr = worker.address();
  const workerBase = `http://127.0.0.1:${typeof waddr === 'object' && waddr ? waddr.port : 0}`;

  const srv = await makeServer(
    { render: { allowHooksInFastPath: false, worker: { url: workerBase, timeoutMs: 5000 } } },
    [],
    { renderWorker: SECRET },
  );
  const cookie = await login(srv.base, 'admin@test');
  // A hook-LESS tool: SVG comes from the in-process fast path, then the RASTER step
  // is delegated to the worker (proving raster goes to Chromium, not resvg).
  const res = await fetch(`${srv.base}/render/test-card.png?title=RASTER`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.toString('base64'), PNG_B64, 'served the worker raster bytes, not a resvg render');
  assert.equal(sawPath, '/rasterise', 'used the /rasterise endpoint');
  assert.ok(sawSig, 'raster job carried a valid HMAC signature');
  assert.ok(sawSvg, 'worker received the finished SVG to rasterise');
  assert.equal(sawFormat, 'png');
  worker.close();
});

// ── (h) C2PA signing (plans/17 §16) ───────────────────────────────────────────
// With an instance signer configured, a server-side export carries a signed,
// verifiable Content Credential. Mint an identity (as `lw c2pa init` does), write
// the cert to a temp file, wire the key via secrets, and verify the rendered PNG.
test('(h) exports carry a signed C2PA credential when a signer is configured', async () => {
  const engineSpec = '@lolly/engine';
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (d: Uint8Array, l: string) => string;
    verifyC2pa: (b: Uint8Array, f: string) => Promise<{ found: boolean; state: string }>;
  };
  const { webcrypto } = await import('node:crypto');
  const root = await eng.generateCaRoot({ commonName: 'Render Root', organization: 'Render', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyPem = eng.derToPem(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)), 'PRIVATE KEY');
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'lolly@render.invalid', organization: 'Render', days: 365 });
  const certFile = join(pack, 'c2pa-cert.pem');
  await writeFile(certFile, eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'));

  const srv = await makeServer(
    { render: { c2pa: { certFile, claimGenerator: 'Render Lolly' } } },
    [],
    { c2paSigningKey: keyPem },
  );
  const cookie = await login(srv.base, 'admin@test');
  const res = await fetch(`${srv.base}/render/test-card.png?title=Signed`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'still a PNG');
  const report = await eng.verifyC2pa(bytes, 'png');
  assert.equal(report.found, true, 'the export carries a C2PA manifest');
  assert.equal(report.state, 'valid', 'the signature verifies');
});

// ── capability honesty (plans/23 §3.A) ──────────────────────────────────────────

test('(j) enforce.formats: a policy-excluded format is 403 FORMAT_NOT_ALLOWED; an absent format stays 400; the allowed one renders', async () => {
  const cookie = await login(main.base, 'admin@test');

  const svg = await fetch(`${main.base}/render/fmt-card.svg?title=Allowed`, { headers: { cookie } });
  assert.equal(svg.status, 200, 'the overlay-allowed format renders');

  // png IS a deployment capability, but this tool's overlay excludes it → policy 403.
  const png = await fetch(`${main.base}/render/fmt-card.png?title=Blocked`, { headers: { cookie } });
  assert.equal(png.status, 403);
  assert.equal((await png.json() as { error: { code: string } }).error.code, 'FORMAT_NOT_ALLOWED');

  // pdf is in the overlay's list but NOT a deployment capability - the capability
  // 400 comes first, so policy can never appear to promise what the deploy lacks.
  const pdf = await fetch(`${main.base}/render/fmt-card.pdf?title=Absent`, { headers: { cookie } });
  assert.equal(pdf.status, 400);
  assert.equal((await pdf.json() as { error: { code: string } }).error.code, 'UNSUPPORTED_FORMAT');
});

test('(k) org_config advertises render capability truthfully, intersects per-tool formats, and the version moves with the worker', async () => {
  const cookie = await login(main.base, 'admin@test');
  const oc = await (await fetch(`${main.base}/api/v1/org-config`, { headers: { cookie } })).json() as {
    render: { formats: string[]; hookedTools: boolean };
    tools: Record<string, { formats?: string[] }>;
    policyVersion: string;
  };
  assert.deepEqual(oc.render, { formats: ['svg', 'png'], hookedTools: false }, 'no worker ⇒ light capability, told upfront');
  assert.deepEqual(oc.tools['fmt-card']?.formats, ['svg'],
    "the per-tool list is overlay ∩ deployment — 'pdf' must not be offered by a deploy that would 400 it");
  assert.equal(oc.tools['test-card']?.formats, undefined, 'no overlay restriction ⇒ no per-tool list');

  // The 304 regression: two identical servers differing ONLY in worker config
  // must publish different policyVersions, or a flipped worker leaves every
  // connected shell on a stale 304 (plans/23 §3.A).
  const light = await makeServer({}, []);
  const workered = await makeServer({ render: { worker: { url: 'http://127.0.0.1:9' } } }, [], { renderWorker: 'wsec' });
  const lightCookie = await login(light.base, 'admin@test');
  const workeredCookie = await login(workered.base, 'admin@test');
  const lightOc = await (await fetch(`${light.base}/api/v1/org-config`, { headers: { cookie: lightCookie } })).json() as { render: { formats: string[]; hookedTools: boolean }; policyVersion: string };
  const workeredOc = await (await fetch(`${workered.base}/api/v1/org-config`, { headers: { cookie: workeredCookie } })).json() as { render: { formats: string[]; hookedTools: boolean }; policyVersion: string };
  assert.equal(lightOc.render.hookedTools, false);
  assert.equal(workeredOc.render.hookedTools, true, 'a configured worker is advertised');
  assert.deepEqual(workeredOc.render.formats, ['svg', 'png', 'jpg', 'pdf'],
    'a worker widens the advertised tier (plans/22 §6.3) with no extra wiring');
  assert.notEqual(lightOc.policyVersion, workeredOc.policyVersion, 'the capability block is a policyVersion term');
});

test('(l) a saturated worker propagates: 503 RENDER_BUSY reaches the client with Retry-After intact', async () => {
  // The worker's capacity answer (plans/23 §3.C) must survive BOTH wraps - 
  // WorkerError → RenderError → HTTP - code and back-off included, so a client
  // can distinguish "come back in 2s" from a worker fault.
  const busy = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: 'RENDER_BUSY' }));
  });
  await new Promise<void>((r) => busy.listen(0, () => r()));
  const baddr = busy.address();
  const busyBase = `http://127.0.0.1:${typeof baddr === 'object' && baddr ? baddr.port : 0}`;

  const srv = await makeServer(
    { render: { allowHooksInFastPath: false, worker: { url: busyBase, timeoutMs: 5000 } } },
    [],
    { renderWorker: 'busy-key' },
  );
  const cookie = await login(srv.base, 'admin@test');
  const res = await fetch(`${srv.base}/render/hooky.svg?title=x`, { headers: { cookie } });
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'RENDER_BUSY');
  assert.equal(res.headers.get('retry-after'), '2', 'the back-off reaches the client');
  busy.close();
});

test('(m) a worker widens the format tier: jpg + pdf render via /rasterise, jpeg aliases jpg, and a workerless deploy still 400s', async () => {
  const { createHmac } = await import('node:crypto');
  const SECRET = 'widen-key';
  const JPG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]).toString('base64');
  const PDF_B64 = Buffer.from('%PDF-1.4 stub').toString('base64');
  const served: string[] = [];
  const worker = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      assert.equal(req.headers['x-lw-render-sig'], createHmac('sha256', SECRET).update(raw).digest('base64url'));
      const job = JSON.parse(raw) as { format?: string };
      served.push(job.format ?? '');
      const pdf = job.format === 'pdf';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pdf ? { bytesB64: PDF_B64, mime: 'application/pdf' } : { bytesB64: JPG_B64, mime: 'image/jpeg' }));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((r) => worker.listen(0, () => r()));
  const waddr = worker.address();
  const workerBase = `http://127.0.0.1:${typeof waddr === 'object' && waddr ? waddr.port : 0}`;

  const srv = await makeServer(
    { render: { allowHooksInFastPath: false, worker: { url: workerBase, timeoutMs: 5000 } } },
    [],
    { renderWorker: SECRET },
  );
  const cookie = await login(srv.base, 'admin@test');

  const jpg = await fetch(`${srv.base}/render/test-card.jpg?title=W`, { headers: { cookie } });
  assert.equal(jpg.status, 200);
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await jpg.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic from the worker');

  // 'jpeg' is the same format - normalised before the gate AND the cache key,
  // so this is a cache hit of the .jpg render, not a second worker call.
  const jpeg = await fetch(`${srv.base}/render/test-card.jpeg?title=W`, { headers: { cookie } });
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');

  const pdf = await fetch(`${srv.base}/render/test-card.pdf?title=W`, { headers: { cookie } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString('latin1'), /^%PDF-/, 'PDF bytes from the worker');

  assert.deepEqual(served, ['jpg', 'pdf'], 'one raster per format — the jpeg alias reused the jpg cache entry');

  // The same request against the workerless main harness stays an honest 400 - 
  // the widened tier exists only where a worker does (and org_config says so).
  const refused = await fetch(`${main.base}/render/test-card.jpg?title=W`, { headers: { cookie: await login(main.base, 'admin@test') } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'UNSUPPORTED_FORMAT');
  worker.close();
});
