// SPDX-License-Identifier: MPL-2.0
/**
 * Guest links open properly in a browser (plan 320 J1, the landing of plan 75 J8).
 *
 * Pinned:
 *  - a browser opening a guest link gets a script-free landing: who invited them, to
 *    which tool, when the link ends, a name field and (only when the link has one) a
 *    password field. The GET sets no guest cookie and audits no admission, so a chat
 *    preview or a mail scanner that fetches the link admits nobody;
 *  - the landing's POST is the join: the guest cookie, one guest.admit entry, and a
 *    303 into the app at the link's tool with the inputs it was made with;
 *  - a wrong password says so on the landing and keeps the typed name;
 *  - an unknown, ended or turned-off link, and a workspace with guest links off, get
 *    a page that says so to a browser, while an API client keeps the JSON it had;
 *  - the page never shows the inviter's address, and its title names neither a
 *    person nor a tool.
 *
 * Run directly:  node --test tests/guest-landing.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { utcMoment } from '../server/src/links/guest-page.ts';
import { linkPath } from '../server/src/links/sign.ts';

let pack: string;
const servers: Server[] = [];
const store = createMemoryStore();
const offStore = createMemoryStore();

interface Rig { base: string; owner: string }
let rig: Rig;
let guestsOff: Rig;

async function boot(guestLinks: boolean, owned = store): Promise<Rig> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Crumb & Co', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy: { guestLinks: { enabled: guestLinks } },
    dev: { enabled: true, users: [{ email: 'mia.lund@crumb.test', name: 'Mia Lund', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store: owned, blobs: createMemoryBlobStore(), secrets: { session: 'guest-session', link: 'guest-link' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=mia.lund@crumb.test`, { redirect: 'manual' });
  const owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  return { base, owner };
}

async function mint(r: Rig, body: Record<string, unknown>): Promise<{ id: string; path: string; url: string }> {
  const res = await fetch(`${r.base}/api/v1/links`, { method: 'POST', headers: { cookie: r.owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  const { id, url } = await res.json() as { id: string; url: string };
  const parsed = new URL(url);
  return { id, url, path: `${parsed.pathname}${parsed.search}` };
}

const browser = { accept: 'text/html,application/xhtml+xml' };
const open = (r: Rig, path: string, headers: Record<string, string> = browser): Promise<Response> => fetch(`${r.base}${path}`, { headers, redirect: 'manual' });
const join_ = (r: Rig, path: string, fields: Record<string, string>): Promise<Response> => fetch(`${r.base}${path}`, {
  method: 'POST', redirect: 'manual', headers: { ...browser, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});
const formAction = (html: string): string => /<form class="stack" method="post" action="([^"]+)">/.exec(html)![1]!.replace(/&amp;/g, '&');
const guestCookie = (res: Response): string | undefined => res.headers.getSetCookie().find(value => value.startsWith('lw_guest='))?.split(';')[0];
const admissions = async (): Promise<number> => (await store.listAudit()).filter(e => e.action === 'guest.admit').length;

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-guest-landing-'));
  const tool = { id: 'event-badge', name: 'Event badge', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', render: { width: 10, height: 10, formats: ['svg'] }, inputs: [{ id: 'name', type: 'text', default: '' }] };
  await mkdir(join(pack, 'tools', 'event-badge'), { recursive: true });
  await writeFile(join(pack, 'tools', 'event-badge', 'tool.json'), JSON.stringify(tool));
  await writeFile(join(pack, 'tools', 'event-badge', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  for (const dir of ['assets', 'tools']) await mkdir(join(pack, 'catalog', dir), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  rig = await boot(true);
  guestsOff = await boot(false, offStore);
});

after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(pack, { recursive: true, force: true });
});

test('a browser opening a guest link gets the landing, and the GET admits nobody', async () => {
  const link = await mint(rig, { kind: 'guest-edit', target: { toolId: 'event-badge', params: { name: 'Summit 2026' } }, ttlHours: 24 });
  const before = await admissions();
  const page = await open(rig, link.path);
  assert.equal(page.status, 200);
  assert.match(String(page.headers.get('content-type')), /^text\/html/);
  assert.match(String(page.headers.get('content-security-policy')), /default-src 'none'/);
  assert.doesNotMatch(String(page.headers.get('content-security-policy')), /script-src/);
  assert.match(String(page.headers.get('cache-control')), /no-store/);
  assert.equal(guestCookie(page), undefined, 'no guest cookie on the GET');
  assert.equal(await admissions(), before, 'no admission on the GET');
  const html = await page.text();
  assert.match(html, /<h1>Mia Lund invited you to Event badge<\/h1>/);
  assert.match(html, /<title>Link to Crumb &amp; Co<\/title>/, 'the title names neither a person nor a tool');
  assert.doesNotMatch(html, /mia\.lund@crumb\.test|<script|og:/);
  assert.match(html, /Ends in 2[34] hours \(\d+ [A-Z][a-z]{2}, \d\d:\d\d UTC\)/);
  assert.match(html, /<label class="field" for="guest-name">Your name<\/label>/);
  assert.doesNotMatch(html, /name="password"/, 'no password field on a link without one');
  assert.match(html, /Sign in instead/);

  const joined = await join_(rig, formAction(html), { name: 'Jordan' });
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get('location'), '/#/tool/event-badge?name=Summit+2026', 'into the app, at the tool, with its inputs');
  const cookie = guestCookie(joined);
  assert.ok(cookie);
  assert.equal(await admissions(), before + 1, 'one admission, on the join');
  const who = await (await fetch(`${rig.base}/api/auth/session`, { headers: { cookie } })).json() as { kind: string; guest: { name: string; toolId: string } };
  assert.deepEqual([who.kind, who.guest.name, who.guest.toolId], ['guest', 'Jordan', 'event-badge']);
});

test('an API client keeps the JSON admission it had', async () => {
  const link = await mint(rig, { kind: 'guest-edit', target: { toolId: 'event-badge' }, ttlHours: 1 });
  const res = await open(rig, `${link.path}&name=Bot`, { accept: 'application/json' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { kind: 'guest-edit', toolId: 'event-badge', sessionRef: null, guest: 'Bot' });
  assert.ok(guestCookie(res));
});

test('a password link asks for it on the landing; a wrong one says so and keeps the name', async () => {
  const link = await mint(rig, { kind: 'guest-edit', target: { toolId: 'event-badge' }, password: 'crumbs', ttlHours: 2 });
  const html = await (await open(rig, link.path)).text();
  assert.match(html, /<label class="field" for="guest-pw">Password<\/label>/);
  const wrong = await join_(rig, formAction(html), { name: 'Jordan', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(guestCookie(wrong), undefined);
  const again = await wrong.text();
  assert.match(again, /role="alert"[^>]*>That password does not open this link\./);
  assert.match(again, /id="guest-name"[^>]*value="Jordan"/);
  const empty = await join_(rig, formAction(html), { name: 'Jordan' });
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /Enter the password\./);
  const right = await join_(rig, formAction(html), { name: 'Jordan', password: 'crumbs' });
  assert.equal(right.status, 303);
  assert.ok(guestCookie(right));
});

test('a link that cannot open says why to a browser, and keeps its JSON for an API client', async () => {
  const unknown = await open(rig, '/l/nosuchlink00?s=x');
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /<h1>This link does not work<\/h1>/);
  const unknownJson = await open(rig, '/l/nosuchlink00?s=x', { accept: 'application/json' });
  assert.equal(unknownJson.status, 404);
  assert.equal((await unknownJson.json() as { error: { code: string } }).error.code, 'NOT_FOUND');

  const link = await mint(rig, { kind: 'guest-edit', target: { toolId: 'event-badge' }, ttlHours: 1 });
  const forged = await open(rig, link.path.replace(/s=[^&]+/, 's=forged'));
  assert.equal(forged.status, 403);
  assert.match(await forged.text(), /This link does not work/);

  assert.equal((await fetch(`${rig.base}/api/v1/links/${link.id}/revoke`, { method: 'POST', headers: { cookie: rig.owner } })).status, 200);
  const off = await open(rig, link.path);
  assert.equal(off.status, 410);
  const offHtml = await off.text();
  assert.match(offHtml, /<h1>This link was turned off<\/h1>/);
  assert.match(offHtml, /Mia Lund turned this link off/);
  const offJson = await open(rig, link.path, { accept: 'application/json' });
  assert.equal((await offJson.json() as { error: { code: string } }).error.code, 'LINK_REVOKED');
  // The join refuses it too, with the same page.
  const late = await join_(rig, link.path, { name: 'Jordan' });
  assert.equal(late.status, 410);
  assert.equal(guestCookie(late), undefined);
});

test('a workspace with guest links off says so instead of a landing', async () => {
  // A link made before the switch went off: it exists, but admits nobody now.
  const maker = (await offStore.listUsers())[0]!;
  const link = { id: 'guestsoffprobe', kind: 'guest-edit' as const, target: { toolId: 'event-badge' }, exp: Math.floor(Date.now() / 1000) + 3600, createdBy: maker.id, createdAt: new Date().toISOString() };
  await offStore.putLink(link);
  const page = await open(guestsOff, linkPath(link, 'guest-link'));
  assert.equal(page.status, 403);
  assert.match(await page.text(), /<h1>Guest links are turned off<\/h1>/);
  const joined = await join_(guestsOff, linkPath(link, 'guest-link'), { name: 'Jordan' });
  assert.equal(joined.status, 403);
  assert.equal(guestCookie(joined), undefined);
});

test('the end of a link reads in UTC with the time of day, because the page has no script', () => {
  const now = Date.parse('2026-10-19T09:00:00Z');
  assert.equal(utcMoment('2026-10-21T14:05:00Z', now), '21 Oct, 14:05 UTC');
  assert.equal(utcMoment('2027-01-02T00:00:00Z', now), '2 Jan 2027, 00:00 UTC');
});
