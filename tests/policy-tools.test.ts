/**
 * Tool policy control plane over real HTTP (plans/03 §4): the admin/brand
 * governance surface. Listing joins pack tools + declared inputs + overlays
 * (unfiltered - you can govern a tool you've hidden from yourself); PUT
 * validates via normalizeOverlay, bumps the version, audits before/after, and
 * the result bites immediately in the member-facing feed and render policy.
 * `policy.edit` reaches a brand group through a grant, not the admin role.
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

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const TOOL_JSON = {
  id: 'event-badge', name: 'Event Badge', version: '1.0.0',
  inputs: [
    { id: 'title', type: 'text', label: 'Title', default: 'Hello' },
    { id: 'accent', type: 'color', label: 'Accent', options: ['#0C322C', '#30BA78'] },
    { id: 'internal-note', type: 'text' },
  ],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-policy-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'event-badge'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({
    tools: [{ id: 'event-badge', name: 'Event Badge' }, { id: 'poster', name: 'Poster' }],
  }));
  await writeFile(join(pack, 'tools', 'event-badge', 'tool.json'), JSON.stringify(TOOL_JSON));
  // 'poster' has no tool.json - inputs must come back null, not crash.

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Policy Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', groups: ['admin'] },
        { email: 'brand@test', groups: ['brand'] },       // policy.edit via grant
        { email: 'marketer@test', groups: ['marketing'] },
      ],
    },
  }));
  store = createMemoryStore({
    grants: [{ principal: 'group:brand', action: 'policy.edit', resource: '*', effect: 'allow' }],
  });
  const app = buildApp({ config, store, secrets: { session: 's9', link: 'l9' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const jsonHeaders = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

test('(a) listing: pack tools joined with declared inputs; missing tool.json → inputs null; plain member 403', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await fetch(`${base}/api/v1/policy/tools`, { headers: { cookie: marketer } })).status, 403);

  const admin = await login('admin@test');
  const { tools } = await (await fetch(`${base}/api/v1/policy/tools`, { headers: { cookie: admin } })).json() as {
    tools: Array<{ id: string; name: string; inputs: Array<{ id: string; options?: unknown[] }> | null; overlay: unknown }>;
  };
  assert.deepEqual(tools.map((t) => t.id).sort(), ['event-badge', 'poster']);
  const badge = tools.find((t) => t.id === 'event-badge');
  assert.equal(badge?.name, 'Event Badge');
  assert.deepEqual(badge?.inputs?.map((i) => i.id), ['title', 'accent', 'internal-note']);
  assert.deepEqual(badge?.inputs?.[1]?.options, ['#0C322C', '#30BA78'], 'manifest options surface for the choice editor');
  assert.equal(badge?.overlay, null);
  assert.equal(tools.find((t) => t.id === 'poster')?.inputs, null, 'unreadable tool.json is null, not a crash');
});

test('(b) brand-team member (grant, not role) locks a preset, restricts a choice, hides an input — version bumps, audit carries before/after', async () => {
  const brand = await login('brand@test');
  const body = {
    inputAccess: {
      title: [{ groups: ['*'], level: 'locked', value: 'SUSE Summit 2026' }],
      accent: [
        { groups: ['brand'], level: 'editable' },
        { groups: ['*'], level: 'choice', allow: ['#0C322C', '#30BA78'] },
      ],
      'internal-note': [{ groups: ['*'], level: 'hidden' }],
    },
    visibility: { groups: ['marketing', 'brand'] },
    enforce: { watermark: 'until-approved' },
  };
  const put = await fetch(`${base}/api/v1/policy/overlays/event-badge`, {
    method: 'PUT', headers: jsonHeaders(brand), body: JSON.stringify(body),
  });
  assert.equal(put.status, 200);
  const saved = await put.json() as { version: number; inputAccess: Record<string, unknown> };
  assert.equal(saved.version, 1);

  // Second save bumps again (policyVersion moves → org-config ETag + render keys move).
  const put2 = await fetch(`${base}/api/v1/policy/overlays/event-badge`, {
    method: 'PUT', headers: jsonHeaders(brand), body: JSON.stringify(body),
  });
  assert.equal((await put2.json() as { version: number }).version, 2);

  const audit = await store.listAudit();
  const evt = audit.filter((e) => e.action === 'policy.overlay.edit').pop();
  assert.equal(evt?.subject, 'tool:event-badge');
  assert.equal((evt?.payload?.before as { version: number } | null)?.version, 1);
  assert.equal((evt?.payload?.after as { version: number }).version, 2);

  const marketer = await login('marketer@test');
  assert.equal((await fetch(`${base}/api/v1/policy/overlays/event-badge`, {
    method: 'PUT', headers: jsonHeaders(marketer), body: JSON.stringify(body),
  })).status, 403, 'no grant, no role — refused');
});

test('(c) the saved policy bites: tools feed filtered by visibility, org-config annotates locked/choice, hidden absent', async () => {
  const marketer = await login('marketer@test');
  const feed = await (await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie: marketer } })).json() as {
    tools: Array<{ id: string }>;
  };
  assert.deepEqual(feed.tools.map((t) => t.id), ['event-badge', 'poster'],
    'marketing is in the visibility set — tool present (poster ungoverned, always visible)');

  const org = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as {
    tools: Record<string, { inputs?: Array<{ id: string; access?: { level: string; value?: unknown; allow?: unknown[] } }> }>;
  };
  const inputs = org.tools['event-badge']?.inputs ?? [];
  assert.deepEqual(inputs.map((i) => i.id).sort(), ['accent', 'title'], 'hidden input is ABSENT');
  assert.equal(inputs.find((i) => i.id === 'title')?.access?.level, 'locked');
  assert.equal(inputs.find((i) => i.id === 'title')?.access?.value, 'SUSE Summit 2026');
  assert.deepEqual(inputs.find((i) => i.id === 'accent')?.access?.allow, ['#0C322C', '#30BA78'],
    'first-match-wins: marketing hits the * choice rule, brand would stay editable');
});

test('(d) invalid overlays are refused whole: bad level, empty groups, choice without allow', async () => {
  const admin = await login('admin@test');
  for (const bad of [
    { inputAccess: { title: [{ groups: ['*'], level: 'frozen' }] } },
    { inputAccess: { title: [{ groups: [], level: 'locked' }] } },
    { inputAccess: { accent: [{ groups: ['*'], level: 'choice' }] } },
    { visibility: { groups: [] } },
    { enforce: { watermark: 'sometimes' } },
    'not an object',
  ]) {
    const res = await fetch(`${base}/api/v1/policy/overlays/event-badge`, {
      method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, `refused: ${JSON.stringify(bad)}`);
  }
  const { tools } = await (await fetch(`${base}/api/v1/policy/tools`, { headers: { cookie: admin } })).json() as {
    tools: Array<{ id: string; overlay: { version: number } | null }>;
  };
  assert.equal(tools.find((t) => t.id === 'event-badge')?.overlay?.version, 2, 'nothing half-written');
});

test('(e) reset to ungoverned: an empty body stores an overlay with no rules — tool fully open again', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/policy/overlays/event-badge`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({}),
  });
  assert.equal(put.status, 200);
  const saved = await put.json() as { version: number; inputAccess?: unknown; visibility?: unknown };
  assert.equal(saved.version, 3);
  assert.equal(saved.inputAccess, undefined);
  assert.equal(saved.visibility, undefined);

  // org-config ships policy rows only where policy exists - an ungoverned tool
  // has NO inputs entry at all, which IS the fully-open state.
  const marketer = await login('marketer@test');
  const org = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as {
    tools: Record<string, { inputs?: Array<{ id: string; access?: unknown }>; hidden?: string[] }>;
  };
  assert.equal(org.tools['event-badge']?.inputs, undefined, 'no annotations — nothing locked/choice anymore');
  assert.ok(!org.tools['event-badge']?.hidden?.length, 'nothing hidden anymore');
});
