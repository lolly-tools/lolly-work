// SPDX-License-Identifier: MPL-2.0
/**
 * Credentials out of URLs (plan 80 E0b, additive half). A job result token
 * rides the x-lw-job-token header, and `?token=` still works for one more
 * release with a Deprecation header; the completion callback carries the
 * token as a field. A link password arrives once in POST /l/:id and comes back
 * as an HttpOnly cookie scoped to that link's path; `?pw=` still opens the
 * link, with a Deprecation header and one server warning per link.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';

const HOOK = 'https://hooks.test/lolly';
const HOOK_SECRET = 'hook-secret';
const DEPRECATION = '@1792195200';

let pack: string;
let server: Server;
let base: string;
let owner: string;
const store = createMemoryStore();
const callbacks: Array<{ body: string; timestamp: string; signature: string }> = [];

interface Minted { id: string; path: string }

async function mint(body: Record<string, unknown>): Promise<Minted> {
  const res = await fetch(`${base}/api/v1/links`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  const { id, url } = await res.json() as { id: string; url: string };
  const parsed = new URL(url);
  return { id, path: `${base}${parsed.pathname}${parsed.search}` };
}

/** The `name=value` half of the link cookie a response set, and the whole header. */
function linkCookie(res: Response, id: string): { pair: string; header: string } | null {
  const header = res.headers.getSetCookie().find(value => value.startsWith(`lw_link_${id}=`));
  return header ? { pair: header.split(';')[0]!, header } : null;
}

function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-credentials-pack-'));
  const tool = { id: 'swatch', name: 'Swatch', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', render: { width: 10, height: 10, formats: ['svg'] }, inputs: [] };
  await mkdir(join(pack, 'tools', 'swatch'), { recursive: true });
  await writeFile(join(pack, 'tools', 'swatch', 'tool.json'), JSON.stringify(tool));
  await writeFile(join(pack, 'tools', 'swatch', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123456"/></svg>');
  for (const dir of ['assets', 'tools']) await mkdir(join(pack, 'catalog', dir), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Credentials', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false }, notify: { webhook: { url: HOOK } },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== HOOK) throw new Error(`unexpected outbound request to ${url}`);
    const headers = new Headers(init?.headers);
    callbacks.push({ body: String(init?.body ?? ''), timestamp: headers.get('x-lolly-timestamp') ?? '', signature: headers.get('x-lolly-signature') ?? '' });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'credentials-session', link: 'credentials-link', webhook: HOOK_SECRET }, fetchImpl });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(pack, { recursive: true, force: true });
});

test('a job result opens with the x-lw-job-token header, and the callback carries the token as a field', async () => {
  const started = await fetch(`${base}/api/v1/render?async=1`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'swatch', format: 'svg', inputs: {}, callbackUrl: HOOK }) });
  assert.equal(started.status, 202, await started.clone().text());
  const queued = await started.json() as { jobId: string; resultToken: string | null };
  assert.equal(queued.resultToken, null, 'no token before there is a result');
  let job: { state: string; resultUrl: string | null; resultToken: string | null } = { state: '', resultUrl: null, resultToken: null };
  for (let i = 0; i < 200 && (job.state !== 'done' || !callbacks.length); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    job = await (await fetch(`${base}/api/v1/jobs/${queued.jobId}`, { headers: { cookie: owner } })).json() as typeof job;
  }
  assert.equal(job.state, 'done');
  assert.equal(typeof job.resultToken, 'string', 'the job resource names its result token');

  // The callback is signed over a body that now carries the token.
  assert.equal(callbacks.length, 1);
  const [callback] = callbacks;
  assert.equal(callback!.signature, `sha256=${createHmac('sha256', HOOK_SECRET).update(`${callback!.timestamp}.${callback!.body}`).digest('hex')}`);
  const sent = JSON.parse(callback!.body) as { jobId: string; state: string; resultUrl: string; resultToken: string };
  assert.equal(sent.jobId, queued.jobId);
  assert.equal(sent.state, 'done');
  assert.equal(typeof sent.resultToken, 'string');
  const deprecatedUrl = new URL(sent.resultUrl);
  assert.equal(deprecatedUrl.pathname, `/api/v1/jobs/${queued.jobId}/result`);
  assert.ok(deprecatedUrl.searchParams.get('token'), 'the query form stays in resultUrl for one more release');

  // The header opens the result without the caller's session, and is not deprecated.
  const viaHeader = await fetch(`${base}/api/v1/jobs/${queued.jobId}/result`, { headers: { 'x-lw-job-token': sent.resultToken } });
  assert.equal(viaHeader.status, 200);
  assert.match(await viaHeader.text(), /<svg/);
  assert.equal(viaHeader.headers.get('deprecation'), null);
  assert.match(String(viaHeader.headers.get('cache-control')), /^private, no-store/);
  assert.equal(viaHeader.headers.get('cdn-cache-control'), 'no-store');

  // The query form still works for one more release, and says it is deprecated.
  const viaQuery = await fetch(`${base}${deprecatedUrl.pathname}${deprecatedUrl.search}`);
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.headers.get('deprecation'), DEPRECATION);
  assert.match(await viaQuery.text(), /<svg/);

  // A token is bound to its job, and a forged one opens nothing.
  const other = await fetch(`${base}/api/v1/render?async=1`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'swatch', format: 'svg', inputs: {} }) });
  const otherId = (await other.json() as { jobId: string }).jobId;
  assert.equal((await fetch(`${base}/api/v1/jobs/${otherId}/result`, { headers: { 'x-lw-job-token': sent.resultToken } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/jobs/${queued.jobId}/result`, { headers: { 'x-lw-job-token': 'forged.token' } })).status, 401);
  const refusedQuery = await fetch(`${base}/api/v1/jobs/${queued.jobId}/result?token=forged.token`);
  assert.equal(refusedQuery.status, 401);
  assert.equal(refusedQuery.headers.get('deprecation'), DEPRECATION, 'a refused query token is told the form is deprecated too');
});

test('POST /l/:id takes the password once and answers with an HttpOnly cookie scoped to that link', async () => {
  const link = await mint({ kind: 'share', target: { toolId: 'swatch', format: 'svg' }, password: 'hunter2' });
  const bare = await fetch(link.path);
  assert.equal(bare.status, 401);
  assert.equal((await bare.json() as { error: { code: string } }).error.code, 'PASSWORD_REQUIRED');

  // A browser gets a script-free form that posts to the link's own address.
  const page = await fetch(link.path, { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 401);
  assert.match(String(page.headers.get('content-type')), /^text\/html/);
  assert.match(String(page.headers.get('content-security-policy')), /form-action 'self'/);
  const html = await page.text();
  const action = /<form method="post" action="([^"]+)">/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  assert.equal(action, new URL(link.path).pathname + new URL(link.path).search);
  assert.match(html, /type="password" name="password"/);
  assert.doesNotMatch(html, /<script/);

  // A wrong password answers the form with the page again, or JSON with its own code.
  const wrongForm = await postForm(link.path, { password: 'nope' });
  assert.equal(wrongForm.status, 401);
  assert.match(await wrongForm.text(), /That password does not open this link\./);
  assert.equal(linkCookie(wrongForm, link.id), null);
  const wrongJson = await postJson(link.path, { password: 'nope' });
  assert.equal(wrongJson.status, 401);
  assert.equal((await wrongJson.json() as { error: { code: string } }).error.code, 'PASSWORD_INCORRECT');
  assert.equal((await postJson(link.path, {})).status, 400);

  // The right password: a 303 back to the link, with the link's cookie.
  const opened = await postForm(link.path, { password: 'hunter2' });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), action);
  const cookie = linkCookie(opened, link.id);
  assert.ok(cookie, 'the answer sets the link cookie');
  const attributes = cookie.header.split(';').map(part => part.trim());
  assert.ok(attributes.includes(`Path=/l/${link.id}`), cookie.header);
  assert.ok(attributes.includes('HttpOnly'), cookie.header);
  assert.ok(attributes.includes('SameSite=Lax'), cookie.header);
  const maxAge = Number(attributes.find(part => part.startsWith('Max-Age='))?.slice(8));
  assert.ok(maxAge > 0 && maxAge <= 12 * 3600, cookie.header);
  assert.doesNotMatch(cookie.header, /hunter2/);

  // The cookie opens the link; the answer is private because the URL alone no longer decides.
  const viaCookie = await fetch(link.path, { headers: { cookie: cookie.pair } });
  assert.equal(viaCookie.status, 200);
  assert.match(await viaCookie.text(), /<svg/);
  assert.match(String(viaCookie.headers.get('cache-control')), /^private, no-store/);
  assert.equal(viaCookie.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(viaCookie.headers.get('deprecation'), null);

  // An API caller gets JSON and the same cookie.
  const api = await postJson(link.path, { password: 'hunter2' });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { ok: true });
  assert.ok(linkCookie(api, link.id));

  // The cookie stands in for the password only: a wrong signature, another
  // link and a revoked link are each still refused.
  assert.equal((await fetch(`${base}/l/${link.id}?s=wrong`, { headers: { cookie: cookie.pair } })).status, 403);
  const other = await mint({ kind: 'share', target: { toolId: 'swatch', format: 'svg' }, password: 'hunter2' });
  const borrowed = cookie.pair.replace(`lw_link_${link.id}=`, `lw_link_${other.id}=`);
  assert.equal((await fetch(other.path, { headers: { cookie: borrowed } })).status, 401, 'one link\'s cookie never opens another');
  assert.equal((await postForm(`${base}/l/${link.id}?s=wrong`, { password: 'hunter2' })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/links/${link.id}/revoke`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(link.path, { headers: { cookie: cookie.pair } })).status, 410);
  assert.equal((await postForm(link.path, { password: 'hunter2' })).status, 410);
});

test('POST /l/:id shares the per-link lockout with ?pw=', async () => {
  const link = await mint({ kind: 'share', target: { toolId: 'swatch', format: 'svg' }, password: 'hunter2' });
  for (let i = 0; i < 10; i++) assert.equal((await postJson(link.path, { password: `wrong-${i}` })).status, 401);
  const locked = await postJson(link.path, { password: 'hunter2' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await locked.json() as { error: { code: string } }).error.code, 'PASSWORD_LOCKED');
  const lockedPage = await postForm(link.path, { password: 'hunter2' });
  assert.equal(lockedPage.status, 429);
  assert.match(await lockedPage.text(), /Too many wrong passwords/);
  assert.equal((await fetch(`${link.path}&pw=hunter2`)).status, 429, 'the old query form is locked out too');
});

test('?pw= still opens a link for one more release, with a Deprecation header, one warning and the link cookie', async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const link = await mint({ kind: 'share', target: { toolId: 'swatch', format: 'svg' }, password: 'hunter2' });
    const opened = await fetch(`${link.path}&pw=hunter2`);
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /<svg/);
    assert.equal(opened.headers.get('deprecation'), DEPRECATION);
    assert.match(String(opened.headers.get('cache-control')), /^private, no-store/);
    const cookie = linkCookie(opened, link.id);
    assert.ok(cookie, 'the query form swaps itself for the link cookie');
    assert.equal((await fetch(link.path, { headers: { cookie: cookie.pair } })).status, 200);

    const again = await fetch(`${link.path}&pw=hunter2`);
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('deprecation'), DEPRECATION);
    const wrong = await fetch(`${link.path}&pw=nope`);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('deprecation'), DEPRECATION);

    const reported = warnings.filter(line => line.includes(link.id));
    assert.equal(reported.length, 1, 'one warning per link, however often it is opened');
    assert.match(reported[0]!, /\?pw=/);
    assert.doesNotMatch(reported.join('\n'), /hunter2|nope/, 'the warning never repeats the password');
  } finally {
    console.warn = warn;
  }
});

test('a guest-edit password link keeps the chosen name through the form', async () => {
  await store.putGrant({ principal: 'group:owner', action: 'tool.use', resource: 'tool:swatch', effect: 'allow' });
  const link = await mint({ kind: 'guest-edit', target: { toolId: 'swatch' }, password: 'hunter2', ttlHours: 1 });
  const page = await fetch(`${link.path}&name=Sam`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 401);
  const action = /<form method="post" action="([^"]+)">/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
  assert.match(String(action), /&name=Sam$/);
  const opened = await postForm(`${base}${action}`, { password: 'hunter2' });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), action);
  const cookie = linkCookie(opened, link.id);
  assert.ok(cookie);
  const admitted = await fetch(`${base}${action}`, { headers: { cookie: cookie.pair } });
  assert.equal(admitted.status, 200);
  assert.equal((await admitted.json() as { guest: string }).guest, 'Sam');
  assert.ok(admitted.headers.getSetCookie().some(value => value.startsWith('lw_guest=')));
});
