// SPDX-License-Identifier: MPL-2.0
/**
 * Intents for partners (plans/82 M7, W-M7-3), over the real app and engine. Pinned here:
 *
 *  - an input the caller's company fills counts as met: the role drops out of the gaps
 *    and the answer leaves the value to the server;
 *  - a published template that declares purposes is a candidate of its own, and a surface
 *    chosen for it names the base tool with `inputs.template`, the way a render starts
 *    from a template;
 *  - a tool used only through its templates is offered only as those templates;
 *  - a template outside the caller's feed is never a candidate;
 *  - a template's purposes are checked against its own rules when they are set, and
 *    again when its rules change;
 *  - the schema route and describe_tool take `template=` and answer with its rules.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { asTemplateRenders, callerToolFacts, checkTemplateIntents, templateDrawable } from '../server/src/automation/intents.ts';
import { servedTemplateEntry } from '../server/src/catalog/templates.ts';
import type { ToolIntentV1 } from '@lolly-tools/core/intent-v1';

const ENGINE: string = '@lolly/engine';
const engine = await import(ENGINE) as Parameters<typeof checkTemplateIntents>[0];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400"><text>{{heading}} {{company}}</text></svg>';
const INPUTS = [
  { id: 'heading', type: 'text', label: 'Heading', default: '' },
  { id: 'date', type: 'text', label: 'Date', default: '' },
  { id: 'company', type: 'text', label: 'Partner name', default: '' },
  { id: 'logo', type: 'asset', label: 'Partner logo', assetType: 'image' },
  { id: 'tagline', type: 'text', label: 'Tagline', default: 'Open source for the enterprise' },
];
const COBRAND: ToolIntentV1[] = [{ purpose: 'promote', needs: ['heading', 'partnerMark', 'company'], roles: { partnerMark: 'logo' } }];

let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const cookies: Record<string, string> = {};
const tokens: Record<string, string> = {};
let template = '';
let source = '';

async function writeTool(id: string, intents?: unknown): Promise<void> {
  const dir = join(pack, 'tools', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'tool.json'), JSON.stringify({ id, name: id, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 1200, height: 400, formats: ['svg', 'png'] }, inputs: INPUTS }));
  await writeFile(join(dir, 'template.html'), SVG);
  if (intents) await writeFile(join(dir, 'intents.json'), JSON.stringify({ version: 1, intents }));
}

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
async function bearer(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
const resolveAs = (who: string, content: Record<string, unknown> = { heading: 'SLES 16: what changes for resellers' }, extra: Record<string, unknown> = {}) =>
  bearer(who, 'POST', '/api/v1/intents/resolve', { version: 1, purpose: 'promote', surfaces: [{ id: 'banner' }], content, ...extra });
let rpc = 0;
async function mcpTool(who: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, any> } }).result;
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-intent-templates-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'cobrand' }, { id: 'webinar' }] }));
  await writeTool('cobrand', COBRAND);
  await writeTool('webinar');
  store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin', 'owner'] }] } }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sIT', link: 'lIT' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = await fetch(`${base}/api/auth/dev?email=bruno@test`, { redirect: 'manual' });
  cookies.bruno = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  assert.equal((await call('bruno', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['cobrand', 'webinar'] })).status, 201);
  assert.equal((await call('bruno', 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors', tools: ['cobrand', 'webinar'] })).status, 201);
  assert.ok((await call('bruno', 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status < 300);
  for (const programme of ['resellers', 'distributors']) await store.putGrant({ principal: `group:programme-${programme}`, action: 'export.server', resource: '*', effect: 'allow' });
  // Northwind's own logo, as its company profile holds it.
  assert.equal(await store.saveCompanyProfile({ companyId: 'northwind', revision: 1, profile: { logoLight: 'inst/northwind-logo' }, updatedBy: 'user:test', updatedAt: new Date().toISOString() }, 0), true);
  // The co-brand tool takes the partner's name and logo from the company.
  await store.putOverlay({ toolId: 'cobrand', version: 1, bindings: { company: 'name', logo: 'logo' } } as never);
  for (const [key, programme, extra] of [['northwind', 'resellers', { company: 'northwind' }], ['resellers', 'resellers', {}], ['outsider', 'distributors', {}]] as const) {
    const made = await call('bruno', 'POST', `/api/v1/programmes/${programme}/tokens`, { label: `${key} agent`, scopes: ['render', 'catalog.read'], ...extra });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokens[key] = made.body.token;
  }
  // A catalog template of the webinar tool, published to Resellers with its own purposes.
  const submitted = await call('bruno', 'POST', '/api/v1/catalog/submit?type=template&toolId=webinar', { toolId: 'webinar', name: 'Webinar banner (partner)', values: { heading: '', tagline: 'Join the SUSE webinar', company: 'OtherCo' } });
  assert.ok(submitted.status === 201 || submitted.status === 200, JSON.stringify(submitted.body));
  source = submitted.body.assetId;
  const published = await call('bruno', 'POST', '/api/v1/programmes/resellers/templates', {
    from: source, groups: ['programme-resellers'], editable: ['heading', 'date'], bindings: { company: 'name', logo: 'logo' },
    intents: [{ purpose: 'promote', needs: ['heading', 'partnerMark', 'company'], roles: { partnerMark: 'logo' } }],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  template = published.body.id;
  assert.deepEqual(published.body.intents.map((e: { purpose: string }) => e.purpose), ['promote']);
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

test('an input the caller\'s company fills is the server\'s, and a role it fills is met', () => {
  const tool = { id: 'cobrand', intents: COBRAND, inputs: INPUTS, render: { formats: ['svg'] } };
  const facts = callerToolFacts(tool, ['svg'], undefined, ['programme-resellers'], { company: 'Northwind IT', logo: 'inst/northwind-logo' });
  assert.deepEqual(facts.intents![0]!.needs, ['heading']);
  assert.equal(facts.inputs!.find((i) => i.id === 'logo')!.type, 'set-by-policy');
  assert.equal(facts.inputs!.find((i) => i.id === 'company')!.default, 'Northwind IT');
  const none = callerToolFacts(tool, ['svg'], undefined, ['programme-resellers'], { logo: '' });
  assert.deepEqual(none.intents![0]!.needs, ['heading', 'partnerMark', 'company'], 'an empty value fills nothing');
});

test('for a token in a company, its name and logo are met and left to the server', async () => {
  const answer = await resolveAs('northwind');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const cobrand = answer.body.surfaces[0].candidates.find((c: { toolId: string }) => c.toolId === 'cobrand');
  assert.deepEqual(cobrand.missing, [], JSON.stringify(cobrand));
  // A programme token with no company has nothing to fill them with.
  const plain = await resolveAs('resellers');
  const theirs = plain.body.surfaces[0].candidates.find((c: { toolId: string }) => c.toolId === 'cobrand');
  assert.deepEqual([...theirs.missing].sort(), ['company', 'partnerMark']);
});

test('a published template with purposes is a candidate, and its surface renders from the template', async () => {
  const answer = await resolveAs('northwind');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const surface = answer.body.surfaces[0];
  assert.ok(surface.candidates.some((c: { toolId: string; missing: string[] }) => c.toolId === template && c.missing.length === 0), JSON.stringify(surface.candidates));
  // Preferred by its id, the template is chosen: the surface names the base tool and starts from the template.
  const preferred = await resolveAs('northwind', undefined, { prefer: { toolId: template } });
  assert.equal(preferred.status, 200, JSON.stringify(preferred.body));
  const chosen = preferred.body.surfaces[0].chosen;
  assert.equal(preferred.body.surfaces[0].status, 'ready', JSON.stringify(preferred.body.surfaces[0]));
  assert.equal(chosen.toolId, 'webinar');
  assert.equal(chosen.inputs.template, template);
  assert.equal(chosen.inputs.heading, 'SLES 16: what changes for resellers');
  assert.equal(chosen.inputs.tagline, undefined, 'a fixed value is the server\'s, never handed back');
  assert.equal(chosen.inputs.logo, undefined, 'the company\'s logo is left to the server');
  assert.equal(chosen.inputs.company, undefined, 'and so is its name');
  assert.equal(preferred.body.closed.chosen[0].toolId, 'webinar', 'the record names the base tool');
  // The answer renders as it stands.
  const made = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { authorization: `Bearer ${tokens.northwind}`, 'content-type': 'application/json' },
    // As SVG, so the drawn words can be read.
    body: JSON.stringify({ toolId: chosen.toolId, format: 'svg', inputs: chosen.inputs }) });
  const svg = await made.text();
  assert.equal(made.status, 200, svg.slice(0, 300));
  assert.match(svg, /Northwind IT/, 'the company\'s name, bound over the template\'s fixed one');
  assert.doesNotMatch(svg, /OtherCo/);
});

test('the answer for a template names the base tool with inputs.template', () => {
  const resolution = {
    closed: { chosen: [{ surface: 'banner', toolId: 'inst/abc', toolVersion: '1.0.0', fit: 'native', status: 'ready' }] },
    surfaces: [{ surface: { id: 'banner' }, status: 'ready', chosen: { toolId: 'inst/abc', inputs: { heading: 'x' } }, candidates: [{ toolId: 'inst/abc' }], refusals: [] }],
  } as never;
  const out = asTemplateRenders(resolution, new Map([['inst/abc', 'webinar']])) as unknown as { closed: { chosen: Array<{ toolId: string }> }; surfaces: Array<{ chosen: { toolId: string; inputs: Record<string, unknown> }; candidates: Array<{ toolId: string }> }> };
  assert.equal(out.closed.chosen[0]!.toolId, 'webinar');
  assert.equal(out.surfaces[0]!.chosen.toolId, 'webinar');
  assert.deepEqual(out.surfaces[0]!.chosen.inputs, { heading: 'x', template: 'inst/abc' });
  assert.equal(out.surfaces[0]!.candidates[0]!.toolId, 'inst/abc', 'a candidate keeps the template\'s id');
});

test('a template outside the caller\'s feed is never a candidate', async () => {
  const answer = await resolveAs('outsider');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.doesNotMatch(JSON.stringify(answer.body), new RegExp(template.replace('/', '\\/')));
});

test('a tool used only through its templates is offered only as those templates', async () => {
  // cobrand gets a template too, then Resellers use cobrand only through templates.
  const submitted = await call('bruno', 'POST', '/api/v1/catalog/submit?type=template&toolId=cobrand', { toolId: 'cobrand', name: 'Co-brand card', values: { tagline: 'Better together' } });
  const pub = await call('bruno', 'POST', '/api/v1/programmes/resellers/templates', { from: submitted.body.assetId, groups: ['programme-resellers'], editable: ['heading'],
    intents: [{ purpose: 'promote', needs: ['heading', 'partnerMark', 'company'], roles: { partnerMark: 'logo' } }] });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.equal((await call('bruno', 'PUT', '/api/v1/programmes/resellers/templates-only/cobrand', { on: true })).status, 200);
  try {
    const answer = await resolveAs('northwind');
    const ids = answer.body.surfaces[0].candidates.map((c: { toolId: string }) => c.toolId);
    assert.ok(!ids.includes('cobrand'), 'the bare tool is not offered');
    assert.ok(ids.includes(pub.body.id), 'its template is');
  } finally {
    await call('bruno', 'PUT', '/api/v1/programmes/resellers/templates-only/cobrand', { on: false });
  }
});

test('a template\'s purposes are checked against its rules, when set and when its rules change', async () => {
  const bare = template.slice('inst/'.length);
  const put = (body: unknown) => call('bruno', 'PUT', `/api/v1/programmes/resellers/templates/${bare}`, body);
  const bad = await put({ intents: [{ purpose: 'promote', needs: ['occasion'] }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /purposes do not hold/);
  // tagline is fixed by the template, so no purpose may need a role that fills it.
  const fixed = await put({ intents: [{ purpose: 'promote', needs: ['heading', 'subheading'], roles: { subheading: 'tagline' } }] });
  assert.equal(fixed.status, 400, JSON.stringify(fixed.body));
  assert.equal((await put({ intents: [{ purpose: 'nonsense' }] })).status, 400);
  // A purpose may not set, or size a surface with, an input the template fixes or the company fills.
  for (const intents of [
    [{ purpose: 'promote', needs: ['heading'], set: { tagline: 'Act now' } }],
    [{ purpose: 'promote', needs: ['heading'], set: { company: 'Someone' } }],
    [{ purpose: 'promote', needs: ['heading'], surfaces: { banner: { tagline: 'Wide' } } }],
  ]) {
    const refused = await put({ intents });
    assert.equal(refused.status, 400, JSON.stringify(intents));
    assert.match(refused.body.error.message, /fixed by the template or filled from the partner's company/);
  }
  // Fixing heading while a purpose still needs it is refused, and nothing changes.
  const narrowed = await put({ editable: ['date'] });
  assert.equal(narrowed.status, 400, JSON.stringify(narrowed.body));
  assert.deepEqual((await store.getInstanceAsset(template))!.publication?.editable, ['heading', 'date']);
  // The served feed carries the purposes; null clears them.
  const entry = servedTemplateEntry((await store.getInstanceAsset(template))!);
  assert.deepEqual((entry.meta as { intents: Array<{ purpose: string }> }).intents.map((e) => e.purpose), ['promote']);
  const cleared = await put({ intents: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.intents, null);
  assert.equal((await resolveAs('northwind')).body.surfaces[0].candidates.some((c: { toolId: string }) => c.toolId === template), false, 'no purposes, no candidate');
  const back = await put({ intents: [{ purpose: 'promote', needs: ['heading', 'partnerMark', 'company'], roles: { partnerMark: 'logo' } }] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
});

test('the schema route and describe_tool take a template and answer with its rules', async () => {
  const schema = await bearer('northwind', 'GET', `/api/v1/schema/webinar?template=${encodeURIComponent(template)}`);
  assert.equal(schema.status, 200, JSON.stringify(schema.body));
  assert.equal(schema.body.template.id, template);
  const props = schema.body.schema.properties as Record<string, { readOnly?: boolean; default?: unknown; const?: unknown }>;
  assert.equal(props.tagline?.readOnly, true, JSON.stringify(props.tagline));
  assert.equal(props.heading?.readOnly, undefined, 'an editable input stays the caller\'s');
  // company is fixed by the template as OtherCo and bound to the company: Northwind's own name wins, as in the render.
  assert.equal(props.company?.readOnly, true);
  assert.equal(props.company?.const ?? props.company?.default, 'Northwind IT', JSON.stringify(props.company));
  assert.equal((await bearer('northwind', 'GET', `/api/v1/schema/cobrand?template=${encodeURIComponent(template)}`)).status, 400, 'another tool\'s template');
  assert.equal((await bearer('outsider', 'GET', `/api/v1/schema/webinar?template=${encodeURIComponent(template)}`)).status, 404, 'not in their feed');
  assert.equal((await bearer('northwind', 'GET', '/api/v1/schema/webinar?template=Webinar')).status, 400);
  const described = await mcpTool('northwind', 'describe_tool', { toolId: 'webinar', template });
  assert.notEqual(described.isError, true, JSON.stringify(described.structuredContent));
  assert.equal(described.structuredContent.template.id, template);
});

test('a template\'s purposes are checked with its own values, and a held file keeps a template off the list', () => {
  const manifest = { id: 'legal-card', render: { formats: ['svg'] }, inputs: [
    { id: 'heading', type: 'text', default: '' }, { id: 'legal', type: 'text', required: true, default: '' },
  ] };
  const intents = [{ purpose: 'promote', needs: ['heading'] }];
  // legal is required and no role fills it: the template's own value is what renders.
  assert.ok('intents' in checkTemplateIntents(engine, manifest, intents, { editable: ['heading', 'legal'], values: { legal: '© SUSE 2026' } }), 'the template supplies it');
  assert.ok('errors' in checkTemplateIntents(engine, manifest, intents, { editable: ['heading', 'legal'], values: {} }), 'nothing supplies it');
  const gate = { allows: (id: string) => id === 'demo/logo/ok', catalogIds: new Set(['demo/logo/ok', 'demo/logo/held']) };
  assert.equal(templateDrawable({ values: { logo: 'demo/logo/ok' } }, gate), true);
  assert.equal(templateDrawable({ values: { logo: 'demo/logo/held' } }, gate), false, 'a fixed file the caller may not draw');
  assert.equal(templateDrawable({ values: { logo: { id: 'demo/logo/held' } } }, gate), false);
  assert.equal(templateDrawable({ values: { logo: 'demo/logo/held' } }, null), true, 'no gate for staff');
});
