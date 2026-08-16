/**
 * Preview-as-group over real HTTP (plans/03): the governance-verification tool.
 * The essential property is HONESTY - a preview of group X must equal the
 * org-config a real member of X receives, because both run through the same
 * assembler. Also: policy.edit gate (delegable to a brand group), role
 * escalation via the same roleFromGroups sign-in uses, per-group tool/input
 * projection, hiddenTools feedback, and that personal user: grants never leak
 * into a group projection.
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
    { id: 'title', type: 'text' },
    { id: 'accent', type: 'color', options: ['#0C322C', '#30BA78'] },
    { id: 'internal-note', type: 'text' },
  ],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-preview-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'event-badge'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({
    tools: [{ id: 'event-badge', name: 'Event Badge' }, { id: 'legal-doc', name: 'Legal Doc' }],
  }));
  await writeFile(join(pack, 'tools', 'event-badge', 'tool.json'), JSON.stringify(TOOL_JSON));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Preview Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', groups: ['admin'] },
        { email: 'brand@test', groups: ['brand'] },
        { email: 'marketer@test', groups: ['marketing'] },
      ],
    },
  }));
  store = createMemoryStore({
    grants: [
      { principal: 'group:brand', action: 'policy.edit', resource: '*', effect: 'allow' },
      { principal: 'group:marketing', action: 'export.download', resource: '*', effect: 'deny' },
    ],
  });
  // Governance to project: event-badge locked/choice/hidden + visible to
  // brand & marketing; legal-doc visible only to legal.
  await store.putOverlay({
    toolId: 'event-badge', version: 1,
    inputAccess: {
      title: [{ groups: ['*'], level: 'locked', value: 'SUSE Summit 2026' }],
      accent: [{ groups: ['brand'], level: 'editable' }, { groups: ['*'], level: 'choice', allow: ['#0C322C', '#30BA78'] }],
      'internal-note': [{ groups: ['*'], level: 'hidden' }],
    },
    visibility: { groups: ['brand', 'marketing'] },
    enforce: { escalation: 'brand-review' },
  });
  await store.putOverlay({ toolId: 'legal-doc', version: 1, visibility: { groups: ['legal'] } });

  const app = buildApp({ config, store, secrets: { session: 'sp', link: 'lp' } });
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
const preview = async (cookie: string, groups: string) =>
  (await fetch(`${base}/api/v1/org-config/preview?groups=${encodeURIComponent(groups)}`, { headers: { cookie } })).json();

test('(a) gate: plain member 403; admin (role) and brand (delegated policy.edit grant) both allowed', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await fetch(`${base}/api/v1/org-config/preview?groups=brand`, { headers: { cookie: marketer } })).status, 403);
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/org-config/preview?groups=brand`, { headers: { cookie: admin } })).status, 200);
  const brand = await login('brand@test');
  assert.equal((await fetch(`${base}/api/v1/org-config/preview?groups=legal`, { headers: { cookie: brand } })).status, 200);
});

test('(b) HONESTY: preview-as-marketing equals the org-config a real marketing member receives', async () => {
  const admin = await login('admin@test');
  const { orgConfig: previewed } = await preview(admin, 'marketing') as { orgConfig: { tools: unknown; can: Record<string, boolean>; profilePolicy: Record<string, { mode: string }> } };

  const marketer = await login('marketer@test');
  const real = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as typeof previewed;

  // tools projection is purely group-derived → byte-identical.
  assert.deepEqual(previewed.tools, real.tools, 'tool/input governance identical');
  // can bits are group+role derived → identical (marketing has no personal grants yet).
  assert.deepEqual(previewed.can, real.can, 'permission bits identical');
  assert.equal(previewed.can['export.download'], false, 'group deny is reflected in both');
  // profile policy MODES match (locked values differ by identity, which is correct).
  assert.deepEqual(Object.fromEntries(Object.entries(previewed.profilePolicy).map(([k, v]) => [k, v.mode])),
    Object.fromEntries(Object.entries(real.profilePolicy).map(([k, v]) => [k, v.mode])));
});

test('(c) tool + input projection differs correctly by group; hiddenTools names the invisible ones', async () => {
  const admin = await login('admin@test');
  const { preview: mktMeta, orgConfig: mkt } = await preview(admin, 'marketing') as {
    preview: { role: string; hiddenTools: string[] };
    orgConfig: { tools: Record<string, { inputs?: Array<{ id: string; access?: { level: string; value?: unknown; allow?: unknown[] } }>; hidden?: string[]; approvalChain?: string }> };
  };
  const badge = mkt.tools['event-badge'];
  assert.ok(badge, 'event-badge visible to marketing');
  assert.equal(badge?.approvalChain, 'brand-review');
  assert.equal(badge?.inputs?.find((i) => i.id === 'title')?.access?.level, 'locked');
  assert.equal(badge?.inputs?.find((i) => i.id === 'title')?.access?.value, 'SUSE Summit 2026');
  assert.equal(badge?.inputs?.find((i) => i.id === 'accent')?.access?.level, 'choice', 'marketing hits the * choice rule');
  assert.deepEqual(badge?.hidden, ['internal-note']);
  assert.ok(!mkt.tools['legal-doc'], 'legal-doc not visible to marketing');
  assert.deepEqual(mktMeta.hiddenTools, ['legal-doc'], 'admin sees which tools are hidden from the group');

  // Brand gets accent EDITABLE (its group-specific rule is ordered first).
  const { orgConfig: brand } = await preview(admin, 'brand') as {
    orgConfig: { tools: Record<string, { inputs?: Array<{ id: string; access?: { level: string } }> }> };
  };
  const brandAccent = brand.tools['event-badge']?.inputs?.find((i) => i.id === 'accent');
  assert.equal(brandAccent, undefined, 'accent editable for brand → no annotation shipped');
});

test('(d) role escalation: groups named admin/owner escalate via the same rule sign-in uses', async () => {
  const admin = await login('admin@test');
  const asAdmin = await preview(admin, 'admin') as { preview: { role: string }; orgConfig: { session: { role: string }; can: Record<string, boolean> } };
  assert.equal(asAdmin.preview.role, 'admin');
  assert.equal(asAdmin.orgConfig.session.role, 'admin');
  assert.equal(asAdmin.orgConfig.can['export.server'], true, 'admin-default action reflected');

  const asNobody = await preview(admin, '') as { preview: { role: string }; orgConfig: { tools: Record<string, unknown> } };
  assert.equal(asNobody.preview.role, 'member', 'no groups → member');
  assert.deepEqual(asNobody.orgConfig.tools, {}, 'no governed tools visible to a member of no groups');
});

test('(e) a personal user: grant never leaks into a GROUP preview', async () => {
  // Give the real marketer a personal grant for an admin-default action.
  const marketer = await store.getUserBySub('dev:marketer@test');
  assert.ok(marketer);
  await store.putGrant({ principal: `user:${marketer.id}`, action: 'link.create-guest', resource: '*', effect: 'allow' });

  const real = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: await login('marketer@test') } })).json() as { can: Record<string, boolean> };
  assert.equal(real.can['link.create-guest'], true, 'the real user has the personal grant');

  const admin = await login('admin@test');
  const { orgConfig } = await preview(admin, 'marketing') as { orgConfig: { can: Record<string, boolean> } };
  assert.equal(orgConfig.can['link.create-guest'], false, 'the group projection ignores any individual’s personal grant');
});
