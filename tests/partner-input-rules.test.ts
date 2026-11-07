// SPDX-License-Identifier: MPL-2.0
/**
 * Input rules for partners (plans/82, Andy's decisions 3 and 9, settled with
 * the coordinator 2026-11-06). No outcome depends on the order rules were
 * written in:
 *   - within one programme, a company's rule overrides its programme's rule;
 *   - across programmes, the stricter result wins;
 *   - someone in two companies in two programmes gets each programme resolved
 *     with its company first, then the stricter of the two;
 *   - for a partner, a partner rule beats a generic one;
 *   - everyone else keeps the overlay's order;
 *   - while the company map is cold, a company's rule is compared stricter-wins,
 *     never more permissive than the right answer.
 * Preview tells the admin which rule decided; org-config never carries it.
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
import { explainInputAccess, resolveInputAccess, type InputRule, type ToolOverlay } from '../server/src/policy/overlay.ts';
import { setCompanyProgrammes } from '../server/src/programmes/types.ts';

const overlay = (rules: InputRule[]): ToolOverlay => ({ toolId: 'price-sheet', version: 1, name: 'Partner pricing', inputAccess: { price: rules } });
const both = (rules: InputRule[]) => [overlay(rules), overlay([...rules].reverse())];
const RESELLER_ACME = ['programme-resellers', 'company-acme', 'partner'];

const programmeLock: InputRule = { groups: ['programme-resellers'], level: 'locked', value: 100 };
const acmeException: InputRule = { groups: ['company-acme'], level: 'editable', reason: 'Acme sets its own price' };

test('within a programme, the company\'s rule overrides the programme\'s rule, in either order', () => {
  setCompanyProgrammes([{ id: 'acme', programmeId: 'resellers' }, { id: 'globex', programmeId: 'isvs' }]);
  for (const o of both([programmeLock, acmeException])) {
    assert.equal(resolveInputAccess(o, 'price', RESELLER_ACME).level, 'editable');
    assert.deepEqual(explainInputAccess(o, 'price', RESELLER_ACME), { scope: 'company', group: 'company-acme', over: 'programme-resellers' });
    // A reseller in no company meets the programme's rule.
    assert.equal(resolveInputAccess(o, 'price', ['programme-resellers', 'partner']).level, 'locked');
    assert.deepEqual(explainInputAccess(o, 'price', ['programme-resellers', 'partner']), { scope: 'programme', group: 'programme-resellers' });
  }
  // A company's rule can be stricter than its programme's, too.
  const acmeHidden: InputRule = { groups: ['company-acme'], level: 'hidden' };
  for (const o of both([{ groups: ['programme-resellers'], level: 'editable' }, acmeHidden])) {
    assert.equal(resolveInputAccess(o, 'price', RESELLER_ACME).level, 'hidden');
  }
});

test('across programmes the stricter result wins, in either order', () => {
  setCompanyProgrammes([{ id: 'acme', programmeId: 'resellers' }, { id: 'globex', programmeId: 'isvs' }]);
  const isvEditable: InputRule = { groups: ['programme-isvs'], level: 'editable' };
  const dual = ['programme-resellers', 'programme-isvs', 'partner'];
  for (const o of both([programmeLock, isvEditable])) {
    const access = resolveInputAccess(o, 'price', dual);
    assert.equal(access.level, 'locked');
    assert.equal(access.value, 100);
    assert.deepEqual(explainInputAccess(o, 'price', dual), { scope: 'programme', group: 'programme-resellers', others: [{ group: 'programme-isvs', level: 'editable' }] });
  }
});

test('two companies in two programmes: each programme with its company first, then the stricter', () => {
  setCompanyProgrammes([{ id: 'acme', programmeId: 'resellers' }, { id: 'globex', programmeId: 'isvs' }]);
  const rules: InputRule[] = [
    programmeLock, // resellers: locked
    acmeException, // acme (resellers): editable, so resellers resolves to editable
    { groups: ['programme-isvs'], level: 'editable' }, // isvs: editable
    { groups: ['company-globex'], level: 'choice', allow: [90, 100] }, // globex (isvs): choice, so isvs resolves to choice
  ];
  const person = ['programme-resellers', 'company-acme', 'programme-isvs', 'company-globex', 'partner'];
  for (const o of [overlay(rules), overlay([...rules].reverse()), overlay([rules[2]!, rules[0]!, rules[3]!, rules[1]!])]) {
    const access = resolveInputAccess(o, 'price', person);
    assert.equal(access.level, 'choice', 'the stricter of editable (resellers with Acme) and a choice (ISVs with Globex)');
    assert.deepEqual(access.allow, [90, 100]);
    const why = explainInputAccess(o, 'price', person)!;
    assert.equal(why.scope, 'company');
    assert.equal(why.group, 'company-globex');
    assert.equal(why.over, 'programme-isvs');
    assert.deepEqual(why.others, [{ group: 'programme-resellers', level: 'editable' }]);
  }
});

test('for a partner a partner rule beats a generic one; everyone else keeps the overlay order', () => {
  setCompanyProgrammes([{ id: 'acme', programmeId: 'resellers' }]);
  const everyoneEditable: InputRule = { groups: ['*'], level: 'editable' };
  for (const o of both([everyoneEditable, programmeLock])) {
    assert.equal(resolveInputAccess(o, 'price', ['programme-resellers', 'partner']).level, 'locked', 'partner');
    assert.equal(resolveInputAccess(o, 'price', ['marketing']).level, 'editable', 'staff');
    assert.equal(explainInputAccess(o, 'price', ['marketing']), null, 'nothing to explain for staff');
  }
  // Staff rules keep first-match order exactly as before.
  const staff = overlay([{ groups: ['marketing'], level: 'locked', value: 1 }, { groups: ['*'], level: 'hidden' }]);
  assert.equal(resolveInputAccess(staff, 'price', ['marketing']).level, 'locked');
  const staffReversed = overlay([{ groups: ['*'], level: 'hidden' }, { groups: ['marketing'], level: 'locked', value: 1 }]);
  assert.equal(resolveInputAccess(staffReversed, 'price', ['marketing']).level, 'hidden');
});

test('while the company map is cold, a company rule is compared stricter-wins and never loosens', () => {
  setCompanyProgrammes([]);
  for (const o of both([programmeLock, acmeException])) {
    assert.equal(resolveInputAccess(o, 'price', RESELLER_ACME).level, 'locked', 'the exception waits for the map');
  }
  setCompanyProgrammes([{ id: 'acme', programmeId: 'resellers' }]);
  assert.equal(resolveInputAccess(overlay([programmeLock, acmeException]), 'price', RESELLER_ACME).level, 'editable');
});

// ── over HTTP: org-config never carries the explanation; Preview does ───────

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-input-rules-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'price-sheet'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'tools', 'price-sheet', 'tool.json'), JSON.stringify({ id: 'price-sheet', inputs: [{ id: 'title' }, { id: 'price' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'rita@acme.test', groups: [] }] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};

test('the app\'s org-config gives the decided access with no explanation; Preview explains it to the admin', async () => {
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-sheet'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme Distribution' })).status, 201);
  // The company's exception is written first, the programme's lock second.
  await store.putOverlay({ toolId: 'price-sheet', version: 1, name: 'Partner pricing', inputAccess: { price: [acmeException, programmeLock] } });
  await login('rita@acme.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test', company: 'acme' }], apply: true })).status, 200);
  setCompanyProgrammes([]); // as on a replica that has not heard of Acme yet: org-config reloads it

  const rita = await login('rita@acme.test');
  const wire = (await call(rita, 'GET', '/api/v1/org-config')).body;
  const price = wire.tools['price-sheet']?.inputs?.find((i: { id: string }) => i.id === 'price');
  assert.equal(price, undefined, 'editable needs no row: Acme\'s exception applies');
  assert.ok(!JSON.stringify(wire).includes('"why"'), 'no explanation on the app wire');
  assert.ok(!JSON.stringify(wire).includes('Acme sets its own price'), 'no rule reason either');

  const preview = (await call(admin, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,company-acme,partner')).body;
  assert.deepEqual(preview.preview.why['price-sheet'].price, { scope: 'company', group: 'company-acme', over: 'programme-resellers' },
    'the exception that leaves price editable is explained too');
  // The overlay's name and the rule's reason are the admin's to read in
  // Preview (they stay off the member's org-config, checked above).
  assert.deepEqual(preview.preview.attribution['price-sheet'].price, { by: 'Partner pricing', reason: 'Acme sets its own price' });
  assert.ok(!JSON.stringify(preview.orgConfig).includes('Acme sets its own price'), 'the org-config inside Preview is still the member\'s');
  const resellerOnly = (await call(admin, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,partner')).body;
  assert.deepEqual(resellerOnly.preview.why['price-sheet'].price, { scope: 'programme', group: 'programme-resellers' });
  assert.equal(resellerOnly.orgConfig.tools['price-sheet'].inputs.find((i: { id: string }) => i.id === 'price').access.level, 'locked');
});
