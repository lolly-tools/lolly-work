/**
 * A grant naming one tool for an export action reaches the app (plans/82 fault C).
 *
 * org-config evaluated `export.download` and `export.request` against `*` only,
 * so the documented "edit but not export" pair (`export.download` denied on
 * `tool:<id>`) left the download in place. Each tool such a grant names now
 * carries its own answer where it differs from the deployment-wide bit.
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

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-tool-export-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'campaign-banner' }, { id: 'qr-code' }, { id: 'secret-tool' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Export Hub', baseUrl: 'http://localhost', pack },
    idp: { roleGroups: { viewer: ['reviewers'] } },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'contractor@test', groups: ['contractors'] },
      { email: 'reviewer@test', groups: ['reviewers'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
  }));
  const store = createMemoryStore({
    overlays: [{ toolId: 'secret-tool', version: 1, visibility: { groups: ['brand-team'] } }],
    grants: [
      { principal: 'group:contractors', action: 'export.download', resource: 'tool:campaign-banner', effect: 'deny' },
      // A hidden tool's id must not reach the caller through this answer.
      { principal: 'group:contractors', action: 'export.download', resource: 'tool:secret-tool', effect: 'deny' },
      // The other direction: a viewer cannot download by role, and an allow names one tool.
      { principal: 'group:reviewers', action: 'export.download', resource: 'tool:qr-code', effect: 'allow' },
    ],
  });
  const app = buildApp({ config, store, secrets: { session: 'se', link: 'le' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

type OrgConfig = { can: Record<string, boolean>; tools: Record<string, { can?: Record<string, boolean> }> };

async function orgConfigOf(email: string): Promise<OrgConfig> {
  const login = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  return await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json() as OrgConfig;
}

test('a deny naming one tool answers for that tool and leaves the rest', async () => {
  const oc = await orgConfigOf('contractor@test');
  assert.equal(oc.can['export.download'], true, 'the deployment-wide bit is unchanged');
  assert.deepEqual(oc.tools['campaign-banner']?.can, { 'export.download': false });
  assert.equal(oc.tools['qr-code'], undefined, 'a tool no grant names gets no entry');
  assert.equal(oc.tools['secret-tool'], undefined, 'a tool the caller cannot see is never named');
});

test('an allow naming one tool answers for that tool where the role gives no download', async () => {
  const oc = await orgConfigOf('reviewer@test');
  assert.equal(oc.can['export.download'], false);
  assert.deepEqual(oc.tools['qr-code']?.can, { 'export.download': true });
});

test('a caller no grant names gets no per-tool answers', async () => {
  const oc = await orgConfigOf('admin@test');
  assert.ok(Object.values(oc.tools).every((t) => t.can === undefined));
});
