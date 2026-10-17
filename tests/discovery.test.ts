// SPDX-License-Identifier: MPL-2.0
/**
 * Work plan 42: effective schemas and capability discovery over real HTTP.
 *
 * The effective schema is built from the tool, the caller's policy and the
 * deployment's render probe, and compile, validate, batch and render accept
 * exactly what it describes. Discovery is paginated and gives a code and a
 * reason for anything unavailable. No answer names a hidden tool, a hidden
 * input, another group's locked value, a group, a provider id or a person.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';
import { renderCapabilities, toolServerFormats } from '../server/src/render/capabilities.ts';
import { effectiveInputSchema, policyFormats } from '../server/src/automation/effective-contract.ts';

interface Harness { server: Server; base: string; store: ReturnType<typeof createMemoryStore> }
const servers: Server[] = [];
let pack = '';

/** Strings that must never reach a caller who is not entitled to them. */
const HIDDEN_INPUT = 'secretcode';
const HIDDEN_DEFAULT = 'internal-code-42';
const OTHER_GROUP_VALUE = '#abcdef';
const HIDDEN_TOOL = 'covert-card';
const GROUP = 'campaign-ops';
const PROVIDER = 'damprovider';

function manifest(id: string, extra: Record<string, unknown> = {}): object {
  return {
    id, name: `${id} name`, version: '2.1.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 200, height: 100, formats: ['svg', 'png', 'pdf'] },
    inputs: [
      { id: 'title', label: 'Title', type: 'text', default: 'Hello', required: true },
      { id: 'bg', label: 'Background', type: 'color', default: '#204080', required: true },
      { id: HIDDEN_INPUT, label: 'Internal code', type: 'text', default: HIDDEN_DEFAULT },
      { id: 'tone', label: 'Tone', type: 'select', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'bold', label: 'Bold' }, { value: 'wild', label: 'Wild' }] },
    ],
    ...extra,
  };
}
const TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect width="200" height="100" fill="{{bg}}"/><text x="10" y="50">{{title}} {{tone}} {{secretcode}}</text></svg>';

async function writeTool(id: string, extra: Record<string, unknown> = {}, hooks?: string): Promise<void> {
  const dir = join(pack, 'tools', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tool.json'), JSON.stringify(manifest(id, hooks ? { ...extra, hooks: { onInit: true } } : extra)));
  await writeFile(join(dir, 'template.html'), TEMPLATE);
  if (hooks) await writeFile(join(dir, 'hooks.js'), hooks);
}

const GOVERNED: ToolOverlay = {
  toolId: 'governed-card', version: 3, name: 'Brand guardrails',
  inputAccess: {
    bg: [
      { groups: [GROUP], level: 'locked', value: '#123456', reason: 'One background per campaign' },
      { groups: ['admin'], level: 'locked', value: OTHER_GROUP_VALUE },
    ],
    [HIDDEN_INPUT]: [{ groups: [GROUP], level: 'hidden' }],
    tone: [{ groups: ['*'], level: 'choice', allow: ['calm', 'bold', 'loud'], reason: 'Approved tones' }],
  },
  enforce: { formats: ['svg'] },
};
const COVERT: ToolOverlay = { toolId: HIDDEN_TOOL, version: 1, visibility: { groups: ['admin'] } };
const TOOL_IDS = ['alpha-card', 'beta-card', HIDDEN_TOOL, 'gamma-card', 'governed-card', 'hooked-card'];

async function makeServer(overrides: Record<string, unknown> = {}, overlays: ToolOverlay[] = [GOVERNED, COVERT], secrets: Record<string, string> = {}): Promise<Harness> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Discovery Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
      { email: 'ops@test', name: 'Olu Ops', groups: [GROUP] },
    ] },
    ...overrides,
  }));
  const store = createMemoryStore({ overlays });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 's-discovery', link: 'l-discovery', ...secrets } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  return { server, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, store };
}

async function login(base: string, email: string): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = res.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  return { cookie, 'content-type': 'application/json' };
}

const json = async (res: Response): Promise<any> => res.json();
const notDerived = (entry: { code: string }) => entry.code !== 'UNSUPPORTED_FORMAT';
const post = (base: string, path: string, headers: Record<string, string>, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

let main: Harness;
let admin: Record<string, string>;
let ops: Record<string, string>;

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-discovery-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 3, tools: TOOL_IDS.map(id => ({ id })) }));
  for (const id of TOOL_IDS.filter(id => id !== 'hooked-card')) await writeTool(id);
  await writeTool('hooked-card', {}, 'function onInit() { return {}; }\n');
  main = await makeServer();
  admin = await login(main.base, 'admin@test');
  ops = await login(main.base, 'ops@test');
});
after(async () => {
  await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  await rm(pack, { recursive: true, force: true });
});

test('the probe follows the render gates: worker formats, hooked tools, unmet host APIs and SVG templates', () => {
  const tool = { formats: ['svg', 'png', 'jpeg', 'pdf', 'webp'], hooks: false, svgTemplate: true };
  const workerless = toolServerFormats(tool, { caps: renderCapabilities(false), allowHooksInFastPath: false, tokens: false });
  assert.equal(workerless.renderer, 'work-jsdom');
  assert.deepEqual(workerless.formats, ['svg', 'png']);
  assert.deepEqual(workerless.unavailable.map(entry => [entry.format, entry.code]), [['jpg', 'WORKER_NOT_CONFIGURED'], ['pdf', 'WORKER_NOT_CONFIGURED'], ['webp', 'UNSUPPORTED_FORMAT']]);
  const workered = toolServerFormats(tool, { caps: renderCapabilities(true), allowHooksInFastPath: false, tokens: false });
  assert.deepEqual(workered.formats, ['svg', 'png', 'jpg', 'pdf']);

  const hooked = toolServerFormats({ ...tool, hooks: true }, { caps: renderCapabilities(false), allowHooksInFastPath: false, tokens: false });
  assert.equal(hooked.renderer, null);
  assert.ok(hooked.unavailable.every(entry => entry.code === 'HOOKED_TOOL_NEEDS_CHROMIUM' && entry.reason));
  assert.equal(toolServerFormats({ ...tool, hooks: true }, { caps: renderCapabilities(true), allowHooksInFastPath: false, tokens: false }).renderer, 'chromium-worker');
  assert.equal(toolServerFormats({ ...tool, hooks: true }, { caps: renderCapabilities(false), allowHooksInFastPath: true, tokens: false }).renderer, 'work-jsdom');

  const needy = toolServerFormats({ ...tool, requires: ['tokens', 'text'] }, { caps: renderCapabilities(true), allowHooksInFastPath: false, tokens: true });
  assert.deepEqual(new Set(needy.unavailable.map(entry => entry.code)), new Set(['TOOL_REQUIRES_UNMET']));
  assert.match(needy.unavailable[0]!.reason, /text/);
  assert.equal(toolServerFormats({ ...tool, requires: ['tokens'] }, { caps: renderCapabilities(false), allowHooksInFastPath: false, tokens: true }).renderer, 'work-jsdom');
  assert.equal(toolServerFormats({ ...tool, svgTemplate: false }, { caps: renderCapabilities(false), allowHooksInFastPath: false, tokens: false }).unavailable[0]!.code, 'SVG_TEMPLATE_REQUIRED');
});

test('effective schemas drop hidden inputs, lock values, narrow choices and attribute each change', () => {
  const raw = {
    type: 'object', additionalProperties: false, required: ['title', 'bg', HIDDEN_INPUT],
    properties: {
      title: { type: 'string', title: 'Title' }, bg: { title: 'Background', anyOf: [{ type: 'string' }], default: '#204080' },
      [HIDDEN_INPUT]: { type: 'string', default: HIDDEN_DEFAULT }, tone: { type: 'string', enum: ['calm', 'bold', 'wild'] },
    },
  };
  const { schema, effects } = effectiveInputSchema(raw, GOVERNED, [GROUP]);
  const properties = schema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(properties), ['title', 'bg', 'tone']);
  assert.deepEqual(schema.required, ['title']);
  assert.deepEqual(properties.bg, { title: 'Background', const: '#123456', default: '#123456', readOnly: true });
  assert.deepEqual(properties.tone.enum, ['calm', 'bold'], 'an allowed value the tool never declared is not offered');
  assert.deepEqual(effects, [
    { effect: 'locked', input: 'bg', by: 'Brand guardrails', reason: 'One background per campaign' },
    { effect: 'choice', input: 'tone', by: 'Brand guardrails', reason: 'Approved tones' },
  ]);
  const text = JSON.stringify({ schema, effects });
  for (const secret of [HIDDEN_INPUT, HIDDEN_DEFAULT, OTHER_GROUP_VALUE, GROUP]) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.deepEqual(effectiveInputSchema(raw, undefined, [GROUP]).schema, raw, 'an ungoverned tool keeps its raw contract');

  const formats = policyFormats(['svg', 'png'], GOVERNED);
  assert.deepEqual(formats.formats, ['svg']);
  assert.deepEqual(formats.unavailable.map(entry => [entry.format, entry.code]), [['png', 'FORMAT_NOT_ALLOWED']]);
  assert.deepEqual(formats.effects, [{ effect: 'format-excluded', format: 'png', by: 'Brand guardrails' }]);
});

test('the schema route answers the caller effective contract with versions, reasons and a validator', async () => {
  const res = await fetch(`${main.base}/api/v1/schema/governed-card`, { headers: ops });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('cache-control')), /^private, no-store/);
  const body = await json(res);
  assert.equal(body.apiVersion, '1.0.0', 'the existing fields stay');
  assert.equal(body.view, 'effective');
  assert.deepEqual(Object.keys(body.schema.properties), ['title', 'bg', 'tone']);
  assert.equal(body.schema.properties.bg.const, '#123456');
  assert.deepEqual(body.tool, { name: 'governed-card name', version: '2.1.0' });
  assert.equal(body.versions.tool, '2.1.0');
  assert.equal(body.versions.policy, 3);
  assert.ok(body.versions.engine && body.versions.design && body.versions.catalog);
  assert.deepEqual(body.render, { renderer: 'work-jsdom', formats: ['svg'], format: 'svg' });
  // The engine also offers formats derived from SVG (svgz, bmp and others) that only the web app exports.
  assert.deepEqual(body.unavailable.filter(notDerived).map((entry: any) => [entry.format ?? entry.action, entry.code]),
    [['pdf', 'WORKER_NOT_CONFIGURED'], ['png', 'FORMAT_NOT_ALLOWED'], ['render', 'FORBIDDEN']]);
  assert.ok(body.unavailable.filter((entry: any) => !notDerived(entry)).every((entry: any) => !['svg', 'png', 'jpg', 'pdf'].includes(entry.format)));
  assert.ok(body.unavailable.every((entry: any) => typeof entry.reason === 'string' && entry.reason.length > 10));
  assert.equal(res.headers.get('etag'), body.etag);
  const text = JSON.stringify(body);
  for (const secret of [HIDDEN_INPUT, HIDDEN_DEFAULT, OTHER_GROUP_VALUE, GROUP, 'ops@test', 'Olu']) assert.ok(!text.includes(secret), `${secret} leaked`);

  const again = await fetch(`${main.base}/api/v1/schema/governed-card`, { headers: { ...ops, 'if-none-match': body.etag } });
  assert.equal(again.status, 304);

  // The administrator meets a different rule: a different contract, so a different validator.
  const adminBody = await json(await fetch(`${main.base}/api/v1/schema/governed-card`, { headers: admin }));
  assert.equal(adminBody.schema.properties.bg.const, OTHER_GROUP_VALUE);
  assert.ok(adminBody.schema.properties[HIDDEN_INPUT], 'the hide rule names another group');
  assert.notEqual(adminBody.etag, body.etag);
  assert.ok(!adminBody.unavailable.some((entry: any) => entry.action === 'render'));

  // A policy edit moves the validator.
  await main.store.putOverlay({ ...GOVERNED, version: 4, inputAccess: { ...GOVERNED.inputAccess, title: [{ groups: ['*'], level: 'choice', allow: ['Hello', 'Hi'] }] } });
  const edited = await fetch(`${main.base}/api/v1/schema/governed-card`, { headers: { ...ops, 'if-none-match': body.etag } });
  assert.equal(edited.status, 200);
  const editedBody = await json(edited);
  assert.notEqual(editedBody.etag, body.etag);
  assert.deepEqual(editedBody.schema.properties.title.enum, ['Hello', 'Hi']);
  await main.store.putOverlay(GOVERNED);
});

test('the raw schema is for policy authors, and hidden or unknown tools stay hidden', async () => {
  assert.equal((await fetch(`${main.base}/api/v1/schema/governed-card?view=raw`, { headers: ops })).status, 403);
  const raw = await json(await fetch(`${main.base}/api/v1/schema/governed-card?view=raw`, { headers: admin }));
  assert.equal(raw.view, 'raw');
  assert.ok(raw.schema.properties[HIDDEN_INPUT]);
  assert.equal(raw.policy, undefined);
  assert.equal((await fetch(`${main.base}/api/v1/schema/governed-card?view=other`, { headers: ops })).status, 400);
  assert.equal((await fetch(`${main.base}/api/v1/schema/governed-card?format=webp`, { headers: ops })).status, 400);
  assert.equal((await fetch(`${main.base}/api/v1/schema/${HIDDEN_TOOL}`, { headers: ops })).status, 403);
  assert.equal((await fetch(`${main.base}/api/v1/schema/governed-card`)).status, 401);
  const hooked = await json(await fetch(`${main.base}/api/v1/schema/hooked-card`, { headers: admin }));
  assert.equal(hooked.render.renderer, null);
  assert.deepEqual(hooked.render.formats, []);
  assert.ok(hooked.unavailable.filter((entry: any) => entry.format).every((entry: any) => entry.code === 'HOOKED_TOOL_NEEDS_CHROMIUM'));
});

test('compile, validate, batch and render accept exactly what the effective schema describes', async () => {
  const { schema } = await json(await fetch(`${main.base}/api/v1/schema/governed-card`, { headers: ops }));
  // Every writable property compiles with a value the schema allows; every read-only one is refused.
  for (const [id, property] of Object.entries(schema.properties as Record<string, any>)) {
    const value = property.enum?.[0] ?? (id === 'title' ? 'Typed' : '#000000');
    const res = await post(main.base, '/api/v1/compile', ops, { toolId: 'governed-card', inputs: { [id]: value } });
    if (property.readOnly) {
      assert.equal(res.status, 422, `${id} is read-only`);
      const refusal = await json(res);
      assert.deepEqual([refusal.error.code, refusal.error.input, refusal.error.by, refusal.error.reason], ['INPUT_LOCKED', id, 'Brand guardrails', 'One background per campaign']);
    } else assert.equal(res.status, 200, `${id} is writable`);
  }
  const compiled = await json(await post(main.base, '/api/v1/compile', ops, { toolId: 'governed-card', inputs: { title: 'Typed' } }));
  assert.equal(compiled.document.values.bg, '#123456', 'compile bakes the locked value');

  const hidden = await post(main.base, '/api/v1/compile', ops, { toolId: 'governed-card', inputs: { [HIDDEN_INPUT]: 'x' } });
  assert.equal(hidden.status, 422);
  assert.equal((await json(hidden)).error.code, 'INPUT_HIDDEN');
  const outside = await post(main.base, '/api/v1/compile', ops, { toolId: 'governed-card', inputs: { tone: 'wild' } });
  assert.equal((await json(outside)).error.code, 'INPUT_NOT_ALLOWED');

  const validated = await json(await post(main.base, '/api/v1/validate', ops, { toolId: 'governed-card', inputs: { title: 'x', bg: '#ff0000', tone: 'wild' } }));
  assert.equal(validated.ok, false);
  assert.deepEqual(validated.errors.map((error: any) => [error.path, error.code]), [['/bg', 'INPUT_LOCKED'], ['/tone', 'INPUT_NOT_ALLOWED']]);
  const recipe = await json(await post(main.base, '/api/v1/validate', ops, { toolId: 'governed-card', recipe: 'title=x&bg=%23ff0000' }));
  assert.deepEqual(recipe.errors.map((error: any) => error.code), ['INPUT_LOCKED']);
  assert.equal((await json(await post(main.base, '/api/v1/validate', ops, { toolId: 'governed-card', inputs: { title: 'x', tone: 'bold' } }))).ok, true);
  assert.equal((await json(await post(main.base, '/api/v1/validate', admin, { toolId: 'governed-card', inputs: { title: 'x', [HIDDEN_INPUT]: 'x' } }))).ok, true, 'the hide rule names another group');

  const batch = await post(main.base, '/api/v1/batch', admin, { toolId: 'governed-card', format: 'svg', rows: [{ title: 'A' }, { title: 'B', bg: '#ff0000' }] });
  assert.equal(batch.status, 422);
  const refused = await json(batch);
  assert.equal(refused.error.code, 'ROW_VALIDATION_FAILED');
  assert.equal(refused.error.row, 1);
  assert.equal(refused.error.errors[0].code, 'INPUT_LOCKED');

  // The render route refuses the same input with the same code.
  const rendered = await post(main.base, '/api/v1/render', admin, { toolId: 'governed-card', format: 'svg', inputs: { bg: '#ff0000' } });
  assert.equal(rendered.status, 422);
  assert.equal((await json(rendered)).error.code, 'INPUT_LOCKED');
  assert.equal((await post(main.base, '/api/v1/render', admin, { toolId: 'governed-card', format: 'svg', inputs: { title: 'Fine' } })).status, 200);
});

test('public discovery describes this deployment and names no tool, group, provider or person', async () => {
  const srv = await makeServer({ catalogProviders: [{ id: PROVIDER, kind: 'mock', label: 'DAM', enabled: true, exposure: { groups: [GROUP], requireApproved: true }, options: { assets: [] } }] });
  const res = await fetch(`${srv.base}/api/v1/discovery`);
  assert.equal(res.status, 200, 'the deployment record is public on a gated deployment');
  assert.match(String(res.headers.get('cache-control')), /^public\b/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await json(res);
  assert.equal(body.version, 1);
  assert.equal(body.access, 'gated');
  assert.equal(body.api.document, '1.0.0');
  assert.deepEqual(body.render, { formats: ['svg', 'png'], hookedTools: false, contentCredentials: false });
  assert.deepEqual(body.automation.batch, { rows: 200, concurrency: 4, retries: 3 });
  assert.deepEqual(body.unavailable.map((entry: any) => entry.format ?? entry.feature), ['jpg', 'pdf', 'hooked-tools']);
  const text = JSON.stringify(body);
  for (const secret of [...TOOL_IDS, PROVIDER, GROUP, 'admin@test', 'Discovery Hub']) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal((await fetch(`${srv.base}/api/v1/discovery`, { headers: { 'if-none-match': String(res.headers.get('etag')) } })).status, 304);
  assert.match(String((await fetch(`${srv.base}/api/v1/discovery`, { headers: admin })).headers.get('cache-control')), /^private\b/, 'a credentialed read stays out of shared caches');

  assert.equal((await fetch(`${srv.base}/api/v1/discovery/me`)).status, 401);
  const me = await json(await fetch(`${srv.base}/api/v1/discovery/me`, { headers: await login(srv.base, 'ops@test') }));
  assert.equal(me.principal, 'member');
  assert.equal(me.can['tool.use'], true);
  assert.equal(me.can['export.server'], false);
  assert.deepEqual(me.assets.providerRefs, { cms: true, net: false });
  assert.ok(me.unavailable.some((entry: any) => entry.action === 'render' && entry.code === 'FORBIDDEN'));
  const meText = JSON.stringify(me);
  for (const secret of [GROUP, PROVIDER, 'ops@test', 'Olu']) assert.ok(!meText.includes(secret), `${secret} leaked`);
  const adminMe = await json(await fetch(`${srv.base}/api/v1/discovery/me`, { headers: await login(srv.base, 'admin@test') }));
  assert.equal(adminMe.can['export.server'], true);
  assert.deepEqual(adminMe.assets.providerRefs, { cms: false, net: false }, 'the provider is exposed to another group');
});

test('tool discovery pages through usable tools only, with formats and reasons', async () => {
  const walk = async (headers: Record<string, string>) => {
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${main.base}/api/v1/discovery/tools?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { headers });
      assert.equal(res.status, 200);
      const page = await json(res);
      assert.ok(page.tools.length <= 2);
      seen.push(...page.tools);
      cursor = page.next;
      if (!cursor) break;
    }
    return seen;
  };
  const opsTools = await walk(ops);
  assert.deepEqual(opsTools.map(tool => tool.id), TOOL_IDS.filter(id => id !== HIDDEN_TOOL));
  assert.ok(!JSON.stringify(opsTools).includes(HIDDEN_TOOL));
  const governed = opsTools.find(tool => tool.id === 'governed-card');
  assert.deepEqual([governed.name, governed.version, governed.renderer, governed.formats, governed.can.render, governed.schema],
    ['governed-card name', '2.1.0', 'work-jsdom', ['svg'], false, '/api/v1/schema/governed-card']);
  assert.deepEqual(governed.unavailable.filter(notDerived).map((entry: any) => entry.code), ['WORKER_NOT_CONFIGURED', 'FORMAT_NOT_ALLOWED', 'FORBIDDEN']);
  const hooked = opsTools.find(tool => tool.id === 'hooked-card');
  assert.equal(hooked.renderer, null);
  assert.ok(hooked.unavailable.some((entry: any) => entry.code === 'HOOKED_TOOL_NEEDS_CHROMIUM'));

  const adminTools = await walk(admin);
  assert.deepEqual(adminTools.map(tool => tool.id), TOOL_IDS);
  assert.deepEqual(adminTools.find(tool => tool.id === 'alpha-card').formats, ['svg', 'png']);

  // A cursor only says where to resume; one naming a hidden tool reveals nothing.
  const resumed = await json(await fetch(`${main.base}/api/v1/discovery/tools?cursor=${Buffer.from(HIDDEN_TOOL).toString('base64url')}`, { headers: ops }));
  assert.deepEqual(resumed.tools.map((tool: any) => tool.id), ['gamma-card', 'governed-card', 'hooked-card']);
  assert.equal(resumed.next, null);
  assert.equal((await fetch(`${main.base}/api/v1/discovery/tools?limit=0`, { headers: ops })).status, 400);
  assert.equal((await fetch(`${main.base}/api/v1/discovery/tools?limit=101`, { headers: ops })).status, 400);
  assert.equal((await fetch(`${main.base}/api/v1/discovery/tools?cursor=${Buffer.from('../x').toString('base64url')}`, { headers: ops })).status, 400);
  assert.equal((await fetch(`${main.base}/api/v1/discovery/tools`)).status, 401);
});

test('an open deployment answers anonymous callers as guests', async () => {
  const srv = await makeServer({ policy: { defaultAccessMode: 'open' } });
  const me = await json(await fetch(`${srv.base}/api/v1/discovery/me`));
  assert.equal(me.principal, 'guest');
  assert.equal(me.can['tool.use'], true);
  assert.equal(me.can['catalog.read'], false);
  const tools = await json(await fetch(`${srv.base}/api/v1/discovery/tools?limit=100`));
  assert.ok(!tools.tools.some((tool: any) => tool.id === HIDDEN_TOOL), 'a visibility rule hides the tool from anonymous callers');
  assert.equal((await fetch(`${srv.base}/api/v1/schema/governed-card?view=raw`)).status, 403);
});

test('a configured worker widens discovery, and its live readiness reaches the caller view', async () => {
  for (const [status, state] of [[200, 'ready'], [503, 'busy']] as const) {
    let probes = 0;
    const worker = createServer((req, res) => {
      if (req.url === '/readyz') probes++;
      res.writeHead(req.url === '/readyz' ? status : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
    await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
    servers.push(worker);
    const address = worker.address();
    const srv = await makeServer({ render: { worker: { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, timeoutMs: 5000 } } }, [GOVERNED, COVERT], { renderWorker: 'worker-secret' });
    const body = await json(await fetch(`${srv.base}/api/v1/discovery`));
    assert.deepEqual(body.render.formats, ['svg', 'png', 'jpg', 'pdf']);
    assert.deepEqual(body.unavailable, []);
    const headers = await login(srv.base, 'admin@test');
    const me = await json(await fetch(`${srv.base}/api/v1/discovery/me`, { headers }));
    assert.equal(me.render.worker, state);
    assert.equal(me.unavailable.some((entry: any) => entry.code === 'RENDER_BUSY'), state === 'busy');
    await fetch(`${srv.base}/api/v1/discovery/me`, { headers });
    assert.equal(probes, 1, 'readiness is probed at most once per interval');
    const hooked = await json(await fetch(`${srv.base}/api/v1/schema/hooked-card`, { headers }));
    assert.equal(hooked.render.renderer, 'chromium-worker');
    assert.deepEqual(hooked.render.formats, ['svg', 'png', 'pdf']);
  }
});
