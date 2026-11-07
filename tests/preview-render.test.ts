// SPDX-License-Identifier: MPL-2.0
/**
 * Preview's drawing of one template, as a set of groups gets it (plans/82 M3,
 * W-M3-4). An admin with policy.edit may draw for any groups. Someone who
 * manages programmes may draw only for partner groups, which is what the
 * partner company page links to. A template those groups do not get is not
 * found, so the route never draws something the groups cannot see.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

const ENGINE: string = '@lolly/engine';
const { compileDesignTool } = await import(ENGINE) as {
  compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
};
const RENDERER = 'var LollyDesignRules = {};';
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const definition = {
  schemaVersion: 1, id: 'partner-data-sheet', name: 'Partner data sheet', description: 'Add your price.', version: '1.1.0',
  presentation: 'sidebar', formats: ['png', 'svg', 'pdf'],
  inputs: [{ input: { id: 'price', label: 'Your price', type: 'text', default: '€ 1,240' }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] }],
  variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [{ id: 'price', kind: 'text', text: '€ 1,240' }] }],
  defaultVariant: 'a4', choices: [], recipes: [], compilerVersion: 1, rendererDigest: sha256(RENDERER), css: '', dependencies: [],
};

function lollyFile(def: Record<string, unknown>): Buffer {
  const compiled = compileDesignTool(def, { source: RENDERER, styles: '' }, {});
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
  const manifest = { format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: def.id, version: def.version },
    bundledTool: { id: def.id, version: def.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) }, integrity };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}

let server: Server;
let base = '';
let rulesId = '';
const store = createMemoryStore({ grants: [{ principal: 'group:partner-managers', action: 'programme.manage', resource: '*', effect: 'allow' }] });

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-preview-render-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'design', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), RENDERER);
  await writeFile(join(pack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'bruno@test', groups: ['partner-managers'] },
      { email: 'mia@test', groups: [] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'spv', link: 'lpv' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  assert.equal((await call(admin, '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] }, 'PUT')).status, 201);
  assert.equal((await call(admin, '/api/v1/programmes/resellers/companies/northwind-it', { name: 'Northwind IT' }, 'PUT')).status, 201);
  const res = await fetch(`${base}/api/v1/programmes/resellers/templates/rules-file?groups=programme-resellers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/octet-stream' }, body: new Uint8Array(lollyFile(definition)) });
  const out = await res.json() as { id: string };
  assert.equal(res.status, 201, JSON.stringify(out));
  rulesId = out.id;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string, path: string, body: unknown, method = 'POST') {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as { error?: { code?: string } } | null };
}
const draw = (cookie: string, groups: string[], template = rulesId) => call(cookie, '/api/v1/org-config/preview/render', { groups, template });

test('someone without policy.edit or programme.manage cannot draw a preview', async () => {
  assert.equal((await draw(await login('mia@test'), ['programme-resellers', 'company-northwind-it'])).status, 403);
});

test('a programme manager draws for partner groups only', async () => {
  const bruno = await login('bruno@test');
  const partner = await draw(bruno, ['programme-resellers', 'company-northwind-it']);
  assert.equal(partner.body?.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM', 'past the access check and the lookup; this deployment has no browser to draw with');
  assert.equal((await draw(bruno, ['marketing'])).status, 403, 'not for groups outside the programmes');
  assert.equal((await draw(bruno, ['programme-resellers', 'marketing'])).status, 403, 'not for a mix either');
});

test('a template the groups do not get is not found, even for an admin', async () => {
  const admin = await login('admin@test');
  assert.equal((await draw(admin, ['marketing'])).status, 404);
  assert.equal((await draw(admin, ['programme-resellers'], 'inst/nothing-here')).status, 404);
  assert.equal((await draw(admin, ['programme-resellers'])).body?.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM');
});
