/**
 * org-config says when the caller reaches the workspace through a partner
 * programme (plans/82 M6), so the app can keep a programme member's home to what
 * is published to them. The field is `programmeScoped: true`, present only for
 * such a caller: everyone else's payload and policy version are unchanged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleOrgConfig, policyVersionOf } from '../server/src/policy/org-config.ts';
import { parseConfig, type InstanceConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;

function user(groups: string[], role = 'member'): UserRecord {
  const now = new Date().toISOString();
  return {
    id: 'u-1', sub: 'dev:rita@x', email: 'rita@x',
    idpGroups: groups, localGroups: [], groups, role,
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  } as UserRecord;
}

const payloadOf = (groups: string[], role?: string) =>
  assembleOrgConfig({ config: CONFIG, user: user(groups, role), overlays: new Map(), grants: [], inboxUnread: 0 });

test('a programme member is told they reach the workspace through a programme', () => {
  assert.equal(payloadOf(['partner']).programmeScoped, true);
  assert.equal(payloadOf(['programme-resellers']).programmeScoped, true);
});

test('staff, admins and owners carry no programmeScoped field at all', () => {
  for (const [groups, role] of [[['sales'], 'member'], [['partner'], 'admin'], [['programme-resellers'], 'owner']] as const) {
    assert.equal('programmeScoped' in payloadOf([...groups], role), false, `${groups} ${role}`);
  }
});

test('the field rides the policy version, and only for a programme member', () => {
  const member = { groups: ['programme-resellers'], role: 'member', sharingGroups: [] };
  const plain = policyVersionOf(new Map(), {}, undefined, undefined, undefined, true, [], [], undefined, member);
  const scoped = policyVersionOf(new Map(), {}, undefined, undefined, undefined, true, [], [], undefined, { ...member, programmeScoped: true });
  assert.notEqual(plain, scoped);
});

let server: Server;
let base = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programme-scoped-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'qr-code' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'rita@test', groups: ['partner'] },
      { email: 'sam@test', groups: ['sales'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore({}), secrets: { session: 'se', link: 'le' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function orgConfigOf(email: string): Promise<Record<string, unknown>> {
  const login = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  return await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json() as Record<string, unknown>;
}

test('the org-config route carries the field to a programme member and not to staff', async () => {
  assert.equal((await orgConfigOf('rita@test')).programmeScoped, true);
  assert.equal('programmeScoped' in await orgConfigOf('sam@test'), false);
});
