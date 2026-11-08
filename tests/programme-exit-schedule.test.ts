// SPDX-License-Identifier: MPL-2.0
/**
 * Scheduled ends and the notice (plans/82 M5, W-M5-2): an end set for a date
 * waits as a scheduled receipt, the people it ends and its scheduler are told
 * 14 days and 1 day before, org-config carries `partner.accessEndsAt`, and the
 * minute sweep runs it at the end of that day in UTC.
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
import { noticeContext } from '../server/src/access/messages.ts';
import type { PeopleNotifier } from '../server/src/notify/people.ts';
import {
  accessEndsNotice, endOfDay, NOTICE_DAYS_BEFORE, noticeDue, PROGRAMME_SWEEP_MS, sweepScheduledExits,
} from '../server/src/programmes/exit-schedule.ts';

const DAY = 86_400_000;
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let config: ReturnType<typeof parseConfig>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-exit-schedule-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  config = parseConfig(JSON.stringify({
    instance: { name: 'Lolly Content Automation', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@acme.test', groups: ['admin'] },
      { email: 'staff@acme.test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'pat@northwind.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sps', link: 'lps' } });
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
const json = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
};
const user = async (email: string) => (await store.getUserBySub(`dev:${email}`))!;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const told: Array<{ id: string; users: string[]; title: string; body: string; mail?: string }> = [];
const notifier: PeopleNotifier = {
  emailOn: true,
  async tell(n) { told.push({ id: n.message.id, users: n.message.audience.users ?? [], title: n.message.title, body: n.message.body ?? '', ...(n.mail ? { mail: n.mail.text } : {}) }); await store.putMessage(n.message); },
  async mail() { return 'sent'; },
  async mailUser() { return 'sent'; },
};
const sweep = (at: number) => sweepScheduledExits({ store, audit: (actor, action, subject, payload) => store.appendAudit({ at: new Date(at).toISOString(), actor, action, subject, ...(payload ? { payload } : {}) }).then(() => undefined), people: notifier, context: (now) => noticeContext(config, now) }, at);

let bruno = '';
let scheduled = '';

test('the timings and the date rule are the constants the code enforces', () => {
  assert.deepEqual([...NOTICE_DAYS_BEFORE], [14, 1]);
  assert.equal(PROGRAMME_SWEEP_MS, 60_000);
  assert.equal(endOfDay('2031-11-30', Date.parse('2031-11-01T00:00:00Z')), '2031-11-30T23:59:59.999Z', 'a day ends at the end of that day in UTC');
  assert.deepEqual(endOfDay('2020-01-01'), { error: 'the end date has passed; end it now instead' });
  const ends = '2031-11-30T23:59:59.999Z';
  assert.equal(noticeDue(ends, {}, Date.parse('2031-11-15T23:59:00Z')), null, 'more than 14 days ahead');
  assert.equal(noticeDue(ends, {}, Date.parse('2031-11-16T00:00:00Z')), 'd14', 'from the day 14 days before, in UTC');
  assert.equal(noticeDue(ends, { d14: 'x' }, Date.parse('2031-11-28T23:00:00Z')), null);
  assert.equal(noticeDue(ends, { d14: 'x' }, Date.parse('2031-11-29T00:00:00Z')), 'd1', 'and again from the day before');
  assert.equal(noticeDue(ends, {}, Date.parse('2031-11-30T12:00:00Z')), 'd1', 'nearer than the day before: the day-before notice at once');
  assert.equal(noticeDue(ends, { d1: 'x' }, Date.parse('2031-11-30T12:00:00Z')), null);
  assert.equal(noticeDue(ends, {}, Date.parse('2031-12-01T00:00:00Z')), null, 'after the end, nothing');
});

test('the wording names only what Lolly Work does', () => {
  const ctx = noticeContext(config, Date.parse('2031-11-16T00:00:00Z'));
  const n = accessEndsNotice({ id: 'm', users: ['u'], programme: 'Resellers, EMEA', endsAt: '2031-11-30T23:59:59.999Z', accountEnds: true, projects: 'team-readonly' }, ctx);
  assert.equal(n.message.title, 'Your access through Resellers, EMEA ends on 30 November 2031');
  assert.equal(n.message.body, 'Pieces you saved to team projects stay with Lolly Content Automation, read-only. Download anything you want to keep before then.');
  assert.equal(n.message.cta?.label, 'Open Projects');
  assert.match(n.message.cta!.url, /#\/projects$/);
  const stays = accessEndsNotice({ id: 'm', users: ['u'], programme: 'Resellers, EMEA', endsAt: '2031-11-30T23:59:59.999Z', accountEnds: false }, ctx);
  assert.doesNotMatch(stays.message.body!, /Download/);
});

test('scheduling the end of one company stores a scheduled receipt and changes nobody yet', async () => {
  bruno = await login('bruno@acme.test');
  await login('staff@acme.test');
  for (const email of ['rita@northwind.test', 'pat@northwind.test', 'gus@globex.test']) await login(email);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', team: 'marketing' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/isv', { name: 'ISV partners' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status, 201);
  await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { apply: true, rows: [
    { email: 'rita@northwind.test', company: 'northwind' }, { email: 'pat@northwind.test', company: 'northwind' }, { email: 'gus@globex.test' },
  ] });
  await json(bruno, 'POST', '/api/v1/programmes/isv/people', { apply: true, rows: [{ email: 'pat@northwind.test' }] });

  const at = day(20);
  const dry = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', at });
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.endsAt, `${at}T23:59:59.999Z`);
  assert.deepEqual(dry.body.limits, { rowBound: 1000, reopenDays: 30, noticeDaysBefore: [14, 1], email: false, sweepSeconds: 60 },
    'the limits the End card shows, each the constant the code enforces; email is off until notify.people.email is set up');
  const made = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', at, apply: true });
  assert.equal(made.status, 201);
  assert.equal(made.body.scheduled, true);
  assert.equal(made.body.notice, true, 'telling them is on unless unticked');
  scheduled = made.body.exit;
  const rec = (await store.getProgrammeExit(scheduled))!;
  assert.equal(rec.state, 'scheduled');
  assert.equal(rec.endsAt, `${at}T23:59:59.999Z`);
  assert.equal((await user('rita@northwind.test')).disabledAt, undefined);
  assert.ok((await store.listAudit()).some((a) => a.action === 'programme.exit.schedule' && a.payload?.exit === scheduled));
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', at: day(30), apply: true })).status, 409, 'one scheduled end per company: change it instead');
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/exit', { domain: 'northwind.test', at, apply: true })).status, 400, 'a date is for a programme or a company');
});

test('org-config tells Rita, Pat and nobody else when their access through Resellers, EMEA ends', async () => {
  const rec = (await store.getProgrammeExit(scheduled))!;
  const configOf = async (email: string) => (await json(await login(email), 'GET', '/api/v1/org-config')).body;
  const rita = (await configOf('rita@northwind.test')).partner;
  assert.equal(rita.accessEndsAt, rec.endsAt);
  assert.deepEqual(rita.accessEndsThrough, { id: 'resellers', name: 'Resellers, EMEA' });
  assert.equal((await configOf('pat@northwind.test')).partner.accessEndsAt, rec.endsAt);
  assert.equal((await configOf('gus@globex.test')).partner?.accessEndsAt, undefined, 'Gus is not at Northwind IT');
});

test('the notice goes out 14 days and 1 day before, once each, to the people it ends and to the scheduler', async () => {
  const rec = (await store.getProgrammeExit(scheduled))!;
  const endsAt = Date.parse(rec.endsAt!);
  await sweep(endsAt - 20 * DAY);
  assert.equal(told.length, 0, 'not yet');
  await sweep(endsAt - 13 * DAY);
  const rita = await user('rita@northwind.test');
  const pat = await user('pat@northwind.test');
  const bru = await user('bruno@acme.test');
  assert.deepEqual(told.map((t) => t.users), [[rita.id], [pat.id], [bru.id]]);
  assert.match(told[0]!.body, /Download anything you want to keep before then\./);
  assert.match(told[1]!.body, /other programmes stays/);
  assert.match(told[2]!.title, /^Northwind IT ends on /);
  assert.match(told[2]!.body, /Change the date, or end now\./);
  await sweep(endsAt - 12 * DAY);
  assert.equal(told.length, 3, 'once per reminder');
  await sweep(endsAt - DAY / 2);
  assert.equal(told.length, 6, 'the day-before reminder');
  const notices = (await store.listAudit()).filter((a) => a.action === 'programme.exit.notice');
  assert.deepEqual(notices.map((a) => [a.payload?.stage, a.payload?.people]), [['d14', 2], ['d1', 2]]);
  assert.ok(notices.every((a) => !JSON.stringify(a.payload).includes('@')), 'counts, never addresses');
});

test('Change moves the date and the reminders follow it; Cancel calls it off', async () => {
  const changed = await json(bruno, 'PUT', `/api/v1/programmes/exits/${scheduled}`, { at: day(25) });
  assert.equal(changed.status, 200);
  const rec = (await store.getProgrammeExit(scheduled))!;
  assert.equal(rec.endsAt, `${day(25)}T23:59:59.999Z`);
  assert.equal(rec.notices, undefined, 'a new date gets its own reminders');
  assert.ok((await store.listAudit()).some((a) => a.action === 'programme.exit.change' && a.payload?.exit === scheduled));
  const live = async () => (await store.listMessages()).filter((m) => m.id.startsWith(`msg_exit_${scheduled}_`) && !(m.endsAt && Date.parse(m.endsAt) <= Date.now()));
  assert.equal((await live()).length, 0, 'the notices that named the old date are taken out of the inbox');
  const cancelled = await json(bruno, 'DELETE', `/api/v1/programmes/exits/${scheduled}`);
  assert.equal(cancelled.status, 200);
  assert.equal((await store.getProgrammeExit(scheduled))!.state, 'cancelled');
  assert.equal((await json(await login('rita@northwind.test'), 'GET', '/api/v1/org-config')).body.partner.accessEndsAt, undefined);
  assert.equal((await json(bruno, 'PUT', `/api/v1/programmes/exits/${scheduled}`, { at: day(9) })).status, 409, 'a cancelled end stays cancelled');
});

test('an end with the notice unticked tells nobody, and its date is not on their home', async () => {
  const made = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', at: day(5), notice: false, apply: true });
  assert.equal(made.status, 201);
  const before = told.length;
  await sweep(Date.now());
  assert.equal(told.length, before);
  assert.equal((await json(await login('rita@northwind.test'), 'GET', '/api/v1/org-config')).body.partner.accessEndsAt, undefined);
  await json(bruno, 'DELETE', `/api/v1/programmes/exits/${made.body.exit}`);
});

test('on the day the sweep runs the exit with the recorded choices, as the system, credited to the scheduler', async () => {
  const made = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', at: day(3), apply: true });
  const id = made.body.exit;
  const rec = (await store.getProgrammeExit(id))!;
  await sweep(Date.parse(rec.endsAt!) + 1000);
  const done = (await store.getProgrammeExit(id))!;
  assert.equal(done.state, 'done');
  assert.equal(done.via, 'scheduled');
  assert.equal(done.doneBy, 'system');
  assert.equal(done.endsAt, rec.endsAt, 'the receipt keeps when it was scheduled for');
  assert.ok((await user('rita@northwind.test')).disabledAt);
  assert.equal((await user('pat@northwind.test')).disabledAt, undefined, 'Pat stays through ISV partners');
  const company = (await store.listCompanies()).find((c) => c.id === 'northwind')!;
  assert.equal(company.endedBy, (await user('bruno@acme.test')).id, 'ended by the person who scheduled the end');
  const audit = (await store.listAudit()).filter((a) => a.action === 'programme.exit').at(-1)!;
  assert.equal(audit.actor, 'system');
  assert.equal(audit.payload?.via, 'scheduled');
});

test('a membership end date gets the same notice, to the person only', async () => {
  const added = await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { apply: true, rows: [{ email: 'gus@globex.test', endsAt: day(10) }] });
  assert.equal(added.status, 200);
  const before = told.length;
  await sweep(Date.now());
  const gus = await user('gus@globex.test');
  const mine = told.slice(before);
  assert.deepEqual(mine.map((t) => t.users), [[gus.id]]);
  assert.match(mine[0]!.title, /^Your access through Resellers, EMEA ends on /);
  await sweep(Date.now() + 1000);
  assert.equal(told.length, before + 1, 'once');
  assert.ok((await store.listMemberships()).find((m) => m.email === 'gus@globex.test')!.notices?.d14);
});

test('end now runs a scheduled end at once with its choices', async () => {
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/isv/companies/initech', { name: 'Initech' })).status, 201);
  const made = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'initech', at: day(12), apply: true });
  const now = await json(bruno, 'PUT', `/api/v1/programmes/exits/${made.body.exit}`, { at: 'now' });
  assert.equal(now.status, 200);
  assert.equal((await store.getProgrammeExit(made.body.exit))!.state, 'done');
  assert.ok((await store.listCompanies()).find((c) => c.id === 'initech')!.endedAt);
});

test('two replicas sweeping in the same minute run one scheduled end once', async () => {
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/isv/companies/umbrella', { name: 'Umbrella' })).status, 201);
  const made = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'umbrella', at: day(2), apply: true });
  const rec = (await store.getProgrammeExit(made.body.exit))!;
  const at = Date.parse(rec.endsAt!) + 1000;
  const [a, b] = await Promise.all([sweep(at), sweep(at)]);
  assert.equal(a + b, 1, 'the claim lets one replica run the end');
  const done = (await store.getProgrammeExit(made.body.exit))!;
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result?.ended.companies, ['umbrella']);
  assert.equal((await json(bruno, 'DELETE', `/api/v1/programmes/exits/${made.body.exit}`)).status, 409, 'a done end is not cancelled');
});
