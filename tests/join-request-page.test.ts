// SPDX-License-Identifier: MPL-2.0
/**
 * The refusal page and the requests filed from it (plans/74 invite spec
 * 3.6, 3.7, R3; plans/75 G13) over real HTTP: "lolly.ing is invite only"
 * with Ask to join, the request sent, waiting and declined states,
 * withdrawing, asking to use another account from the wrong-account page,
 * and the rules that keep these forms from being a way to probe or spam:
 * the address comes from the signed ask token and never from a field, the
 * answer is one page whatever happened, the form token and the Origin
 * check, and no ask form for an address nobody proved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintToken } from '../server/src/iam/tokens.ts';
import {
  SESSION_SECRET, boot, cookieOf, fieldOf, invite, openPage, postForm, project, signIn, startAndReturn, tokenFor, type Env,
} from './invite-harness.ts';

const SAM = 'sam.k@gmail.example';

/** A Google sign-in by someone nobody invited: the refusal page. */
async function refused(env: Env, email = SAM, verified = true) {
  env.script.google = { sub: `g-${email}`, email, email_verified: verified, given_name: 'Sam', family_name: 'Kay' };
  const { done, form } = await signIn(env, 'primary');
  return { res: done, html: await done.text(), form };
}

async function askToJoin(env: Env, fields: Record<string, string> = {}) {
  const page = await refused(env);
  return postForm(env.base, '/api/auth/request', {
    ask: fieldOf(page.html, 'join', 'ask'), csrf: fieldOf(page.html, 'join', 'csrf'), action: 'join', ...fields,
  }, page.form);
}

const openJoins = async (env: Env) =>
  env.store.listAccessRequests({ status: 'open', now: new Date().toISOString(), kinds: ['join'] });

test('not invited: the workspace name first, the account, a next step, and Ask to join; no user row', async () => {
  const env = await boot();
  const { res, html } = await refused(env);
  assert.equal(res.status, 403);
  assert.equal(cookieOf(res, 'lw_session'), undefined);
  assert.ok(html.includes('<h1>lolly.ing is invite only</h1>'));
  assert.ok(html.includes('<title>Sign in - lolly.ing</title>'));
  assert.ok(html.includes(`You signed in as <strong class="tag addr">${SAM}</strong> (Google).`));
  assert.ok(html.includes('This account is not on lolly.ing yet. If your invitation went to another address, sign in with that account.'));
  assert.ok(html.includes('Use a different account'));
  assert.ok(html.includes('<h2>Ask to join</h2>'));
  assert.ok(html.includes(`Ask the admins of lolly.ing to let <span class="addr">${SAM}</span> in.`));
  assert.ok(html.includes('<label class="field" for="ask-note">Add a note (optional)</label>'));
  assert.match(html, /<textarea class="field" id="ask-note" name="note" maxlength="280"/);
  assert.ok(fieldOf(html, 'join', 'ask') && fieldOf(html, 'join', 'csrf'));
  assert.match(res.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin', 'the form post keeps its Origin');
  assert.equal(await env.store.getUserBySub(`g-${SAM}`), null, 'no user row');
});

test('asking: one page whatever happened, one open request, the admins told, the note never audited', async () => {
  const env = await boot();
  const note = 'I run the Weekend A project <b>x</b>';
  const first = await refused(env);
  const fields = { ask: fieldOf(first.html, 'join', 'ask'), csrf: fieldOf(first.html, 'join', 'csrf'), action: 'join' };
  const sent = await postForm(env.base, '/api/auth/request', { ...fields, note }, first.form);
  assert.equal(sent.status, 200);
  const page = await sent.text();
  assert.ok(page.includes('<h1>Request sent</h1>'));
  assert.ok(page.includes(`The admins of lolly.ing will see your request from <span class="addr">${SAM}</span>.`));
  assert.ok(page.includes('lolly.ing does not send email yet. Sign in again later: once an admin approves, you are in.'));
  assert.ok(page.includes('href="/api/auth/login?prompt=select_account"'));

  const [request] = await openJoins(env);
  assert.equal(request?.email, SAM);
  assert.equal(request?.name, 'Sam Kay');
  assert.equal(request?.idp, 'primary');
  assert.equal(request?.note, note);
  const notice = (await env.store.listMessages()).find((m) => m.id === `msg_req_${request!.id}`)!;
  assert.equal(notice.title, 'Sam Kay asks to join lolly.ing');
  const admins = (await env.store.listUsers()).filter((u) => u.role === 'admin' || u.role === 'owner').map((u) => u.id).sort();
  assert.deepEqual([...(notice.audience.users ?? [])].sort(), admins);
  const audit = (await env.store.listAudit()).find((e) => e.action === 'access.request')!;
  assert.equal(audit.actor, 'anonymous');
  assert.equal((audit.payload as { noteChars: number }).noteChars, Array.from(note).length);
  assert.ok(!JSON.stringify(await env.store.listAudit()).includes('Weekend A'), 'the note text is never audited');

  // Signing in again shows the open request, with a way to withdraw it.
  const again = await refused(env);
  assert.ok(again.html.includes('You asked to join just now. An admin of lolly.ing has not answered yet. Sign in again later to check.'));
  assert.ok(fieldOf(again.html, 'withdraw', 'ask'));
  assert.ok(!again.html.includes('name="action" value="join"'), 'no second form while one waits');

  // A duplicate (posted again from the first page) reads the same and stores nothing new.
  const duplicate = await postForm(env.base, '/api/auth/request', fields, first.form);
  assert.equal(duplicate.status, 200);
  assert.equal(await duplicate.text(), page);
  assert.equal((await openJoins(env)).length, 1);
});

test('held by the per-address cap: the same page, nothing stored, audited as held', async () => {
  const env = await boot();
  const at = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    await env.store.createAccessRequest({
      id: `req_old${i}`, kind: 'join', status: 'open', email: SAM, createdAt: at, expiresAt: at, identitySub: `g-${SAM}`, idp: 'primary',
    }, at);
  }
  const sent = await askToJoin(env);
  assert.equal(sent.status, 200);
  assert.ok((await sent.text()).includes('<h1>Request sent</h1>'));
  assert.equal((await openJoins(env)).length, 0);
  const held = (await env.store.listAudit()).find((e) => e.action === 'access.request.held')!;
  assert.deepEqual(held.payload, { kind: 'join', email: SAM, reason: 'per-email' });
});

test('the address is the ask token\'s: an email field is ignored; a forged or expired token gets the expired page', async () => {
  const env = await boot();
  const sent = await askToJoin(env, { email: 'victim@suse.example' });
  assert.equal(sent.status, 200);
  assert.deepEqual((await openJoins(env)).map((r) => r.email), [SAM]);

  const page = await refused(env, 'other@gmail.example');
  const csrf = fieldOf(page.html, 'join', 'csrf');
  const expiredPage = (res: Response) => res.text().then((html) => {
    assert.equal(res.status, 403);
    assert.ok(html.includes('<h1>This page expired</h1>') && html.includes('Sign in again to send your request.'));
  });
  const forged = mintToken('lw/ask', { e: 'victim@suse.example', idp: 'primary', sub: 'x' }, 'not-the-secret', 1800);
  await expiredPage(await postForm(env.base, '/api/auth/request', { ask: forged, csrf, action: 'join' }, page.form));
  const stale = mintToken('lw/ask', { e: 'victim@suse.example', idp: 'primary', sub: 'x' }, SESSION_SECRET, 1800, Date.now() - 3_600_000);
  await expiredPage(await postForm(env.base, '/api/auth/request', { ask: stale, csrf, action: 'join' }, page.form));
  const otherDomain = mintToken('lw/form', { e: 'victim@suse.example', idp: 'primary', sub: 'x' }, SESSION_SECRET, 1800);
  await expiredPage(await postForm(env.base, '/api/auth/request', { ask: otherDomain, csrf, action: 'join' }, page.form));
  assert.ok(!(await openJoins(env)).some((r) => r.email === 'victim@suse.example'));
});

test('an address its provider did not confirm gets no ask form', async () => {
  const env = await boot();
  const { res, html } = await refused(env, SAM, false);
  assert.equal(res.status, 403);
  assert.ok(html.includes('has not confirmed this email address'));
  assert.ok(html.includes('ask an admin to invite you'));
  assert.ok(!html.includes('Ask to join') && !html.includes('name="ask"'));
});

test('a missing or mismatched form token gets the expired page; a cross-site Origin is refused', async () => {
  const env = await boot();
  const page = await refused(env);
  const ask = fieldOf(page.html, 'join', 'ask');
  const csrf = fieldOf(page.html, 'join', 'csrf');
  for (const [label, fields, cookie] of [
    ['no cookie', { ask, csrf, action: 'join' }, ''],
    ['no field', { ask, action: 'join' }, page.form],
    ['wrong field', { ask, csrf: 'nope', action: 'join' }, page.form],
  ] as Array<[string, Record<string, string>, string]>) {
    const res = await postForm(env.base, '/api/auth/request', fields, cookie);
    assert.equal(res.status, 403, label);
    assert.ok((await res.text()).includes('This page expired'), label);
  }
  const cross = await postForm(env.base, '/api/auth/request', { ask, csrf, action: 'join' }, page.form, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal(((await cross.json()) as { error: { code: string } }).error.code, 'CSRF_BLOCKED');
  assert.equal((await openJoins(env)).length, 0);
});

test('withdrawing closes the request and takes it out of the admins\' inboxes', async () => {
  const env = await boot();
  await askToJoin(env);
  const [request] = await openJoins(env);
  const page = await refused(env);
  const res = await postForm(env.base, '/api/auth/request', {
    ask: fieldOf(page.html, 'withdraw', 'ask'), csrf: fieldOf(page.html, 'withdraw', 'csrf'), action: 'withdraw',
  }, page.form);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<h1>Request withdrawn</h1>') && html.includes('Nothing more happens with this request.'));
  assert.equal((await env.store.getAccessRequest(request!.id))?.status, 'withdrawn');
  const notice = (await env.store.listMessages()).find((m) => m.id === `msg_req_${request!.id}`)!;
  assert.ok(Date.parse(notice.endsAt!) <= Date.now(), 'the notice ended');
  const audit = (await env.store.listAudit()).find((e) => e.action === 'access.withdraw')!;
  assert.deepEqual(audit.payload, { kind: 'join' });
  // The form is back.
  assert.ok((await refused(env)).html.includes('name="action" value="join"'));
});

test('declined in the last week: the date, when to ask again, and no form; a post anyway files nothing', async () => {
  const env = await boot();
  const page = await refused(env);
  await askToJoin(env);
  const [request] = await openJoins(env);
  const at = new Date().toISOString();
  await env.store.answerAccessRequest(request!.id, { status: 'declined', at, by: `user:${env.admin.id}` }, at);
  const again = await refused(env);
  assert.match(again.html, /An admin of lolly\.ing did not approve your request on \d{1,2} [A-Z][a-z]{2} \(UTC\)\. You can ask again after \d{1,2} [A-Z][a-z]{2}( \d{4})?\./);
  assert.ok(!again.html.includes('name="action" value="join"'));
  const late = await postForm(env.base, '/api/auth/request', {
    ask: fieldOf(page.html, 'join', 'ask'), csrf: fieldOf(page.html, 'join', 'csrf'), action: 'join',
  }, page.form);
  assert.equal(late.status, 200);
  assert.equal((await openJoins(env)).length, 0);
});

test('join requests switched off: the page says who to ask instead', async () => {
  const env = await boot({ policy: { requests: { join: false, project: true, ttlDays: 14, joinOpenMax: 50 } } });
  const { html } = await refused(env);
  assert.ok(html.includes('Ask the person who invited you to invite this address.'));
  assert.ok(!html.includes('Ask to join') && !html.includes('name="ask"'));
  const config = (await (await fetch(`${env.base}/api/auth/config`)).json()) as Record<string, unknown>;
  assert.deepEqual([config.instanceName, config.inviteOnly, config.joinRequests], ['lolly.ing', true, false]);
});

test('the gate learns the workspace name, that it is invite only, and that people may ask to join', async () => {
  const env = await boot();
  const config = (await (await fetch(`${env.base}/api/auth/config`)).json()) as Record<string, unknown>;
  assert.equal(config.instanceName, 'lolly.ing');
  assert.equal(config.inviteOnly, true);
  assert.equal(config.joinRequests, true);
  const chooser = await (await fetch(`${env.base}/api/auth/login`)).text();
  assert.ok(chooser.includes('Choose how to sign in. Use the account your invitation went to.'));
  const open = await boot({ idp: { admission: undefined } });
  const openConfig = (await (await fetch(`${open.base}/api/auth/config`)).json()) as Record<string, unknown>;
  assert.equal(openConfig.inviteOnly, false);
  assert.equal(openConfig.joinRequests, false, 'an open workspace has nobody to refuse');
  assert.ok((await (await fetch(`${open.base}/api/auth/login`)).text()).includes('<p>Choose how to sign in.</p>'));
});

test('from the wrong-account page: ask to use this account, see it waiting, and the inviter is told', async () => {
  const env = await boot();
  await project(env, 'prj_c', 'Weekend C');
  await invite(env, { id: 'inv_w1', email: 'w1@suse.example', projects: [{ projectId: 'prj_c', role: 'editor' }] });
  const token = tokenFor('inv_w1', 'prj_c');
  env.script.google = { sub: 'g-sam', email: SAM, email_verified: true, given_name: 'Sam' };
  const first = await startAndReturn(env, token, 'primary');
  const html = await first.done.text();
  const res = await postForm(env.base, '/api/auth/request', {
    ask: fieldOf(html, 'switch', 'ask'), csrf: fieldOf(html, 'switch', 'csrf'), action: 'switch', note: 'this is me',
  }, first.form);
  assert.equal(res.status, 200);
  const sent = await res.text();
  assert.ok(sent.includes(`Andy Fitz will see your request. Once Andy Fitz approves, open your invitation link again and sign in as <span class="addr">${SAM}</span>.`));
  const [request] = await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString(), kinds: ['switch'] });
  assert.equal(request?.email, SAM);
  assert.equal(request?.invitationId, 'inv_w1');
  assert.equal(request?.projectId, 'prj_c');
  assert.equal(request?.userId, undefined, 'no account behind it');
  const notice = (await env.store.listMessages()).find((m) => m.id === `msg_req_${request!.id}`)!;
  assert.ok(notice.audience.users?.includes(env.admin.id));
  assert.ok(notice.body?.includes('Someone with the invitation for w•••@suse.example signed in as sam.k@gmail.example.'));

  // Back on the page, the request is waiting.
  const again = await startAndReturn(env, token, 'primary');
  const waiting = await again.done.text();
  assert.ok(waiting.includes('You asked just now. Andy Fitz has not answered yet.'));
  assert.ok(fieldOf(waiting, 'withdraw', 'ask'));
});

test('signed in as another account: the ask carries the account, and only its own session may send it', async () => {
  const env = await boot({ idp: { admission: { emails: ['listed@gmail.example'] } } });
  await project(env, 'prj_c', 'Weekend C');
  await invite(env, { id: 'inv_w1', email: 'w1@suse.example', projects: [{ projectId: 'prj_c', role: 'editor' }] });
  env.script.google = { sub: 'g-listed', email: 'listed@gmail.example', email_verified: true };
  const { done, session, form } = await startAndReturn(env, tokenFor('inv_w1', 'prj_c'), 'primary');
  const html = await done.text();
  const fields = { ask: fieldOf(html, 'switch', 'ask'), csrf: fieldOf(html, 'switch', 'csrf'), action: 'switch' };
  const signedOut = await postForm(env.base, '/api/auth/request', fields, form);
  assert.equal(signedOut.status, 403, 'not without the session the ask was made for');
  const res = await postForm(env.base, '/api/auth/request', fields, `${form}; ${session}`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('gets the access this invitation gives'));
  const listed = (await env.store.getUserBySub('g-listed'))!;
  const [request] = await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString(), kinds: ['switch'] });
  assert.equal(request?.userId, listed.id);
  assert.equal((await env.store.listAudit()).find((e) => e.action === 'access.request')?.actor, `user:${listed.id}`);
});
