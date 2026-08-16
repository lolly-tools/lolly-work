/**
 * The injectables rail over real HTTP (plans/19): admin-or-owner publish/list/revoke,
 * a malformed payload refused at the door, and a published injectable appearing - 
 * group-scoped - in the target caller's org-config while a publish moves the ETag.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let base: string;
let server: Server;

before(async () => {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Inject Hub', baseUrl: 'http://localhost' },
    policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
    rateLimit: { enabled: false },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'marketer@test', name: 'Mia Marketer', groups: ['marketing'] },
        { email: 'designer@test', name: 'Dee Design', groups: ['design'] },
      ],
    },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie');
  return cookie.split(';')[0] as string;
}
const publish = (cookie: string, body: unknown) =>
  fetch(`${base}/api/v1/injectables`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('publish is gated: 401 unauthenticated, 403 for a non-admin member', async () => {
  assert.equal((await fetch(`${base}/api/v1/injectables`)).status, 401);
  const marketer = await login('marketer@test');
  const denied = await publish(marketer, { id: 'x', kind: 'chrome', title: 't', groups: ['*'], payload: { slot: 'banner', text: 'hi' } });
  assert.equal(denied.status, 403);
});

test('a malformed payload is refused at publish with the envelope reason', async () => {
  const admin = await login('admin@test');
  const res = await publish(admin, { id: 'bad-chrome', kind: 'chrome', title: 't', groups: ['*'], payload: { slot: 'banner', text: '<script>x</script>' } });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'INVALID_INPUT');
  assert.match(body.error.message, /markup is not allowed/);
});

test('publish → group-scoped org-config projection + ETag bump; revoke removes it', async () => {
  const admin = await login('admin@test');
  const designer = await login('designer@test');
  const marketer = await login('marketer@test');

  // Baseline ETag before any publish, for the target (designer) caller.
  const before = await fetch(`${base}/api/v1/org-config`, { headers: { cookie: designer } });
  const etag0 = before.headers.get('etag');
  const base0 = await before.json() as { injectables: Array<{ id: string }> };
  assert.equal(base0.injectables.length, 0);

  // Publish a design-scoped chrome banner.
  const pub = await publish(admin, { id: 'design-note', kind: 'chrome', title: 'Design note', groups: ['design'], payload: { slot: 'banner', tone: 'info', text: 'New brand kit is live' } });
  assert.equal(pub.status, 201);

  // Designer sees it; the ETag moved (policyVersion folds injectables).
  const dRes = await fetch(`${base}/api/v1/org-config`, { headers: { cookie: designer } });
  assert.notEqual(dRes.headers.get('etag'), etag0, 'a publish busts the ETag');
  const dCfg = await dRes.json() as { injectables: Array<{ id: string; kind: string; slot: string; text: string }> };
  assert.equal(dCfg.injectables.length, 1);
  assert.equal(dCfg.injectables[0]!.id, 'design-note');
  assert.equal(dCfg.injectables[0]!.kind, 'chrome');
  assert.equal(dCfg.injectables[0]!.text, 'New brand kit is live');

  // Marketer (not in 'design') does NOT see it - genuinely absent, not flagged.
  const mCfg = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as { injectables: unknown[] };
  assert.equal(mCfg.injectables.length, 0);

  // Listing shows it live with its facts.
  const list = await (await fetch(`${base}/api/v1/injectables`, { headers: { cookie: admin } })).json() as { injectables: Array<{ id: string; state: string; facts: Record<string, string> }>; kinds: unknown[] };
  const row = list.injectables.find((r) => r.id === 'design-note');
  assert.equal(row?.state, 'live');
  assert.equal(row?.facts.slot, 'banner');
  assert.ok(Array.isArray(list.kinds) && list.kinds.length === 4);

  // Revoke → designer no longer sees it; the row remains listed as revoked.
  const del = await fetch(`${base}/api/v1/injectables/design-note`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(del.status, 200);
  const dCfg2 = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: designer } })).json() as { injectables: unknown[] };
  assert.equal(dCfg2.injectables.length, 0);
  const list2 = await (await fetch(`${base}/api/v1/injectables`, { headers: { cookie: admin } })).json() as { injectables: Array<{ id: string; state: string }> };
  assert.equal(list2.injectables.find((r) => r.id === 'design-note')?.state, 'revoked');
});
