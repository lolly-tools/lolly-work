// SPDX-License-Identifier: MPL-2.0
/**
 * Signing in from an invite page (plans/74 invite spec R2, 2.9; plans/75 J4)
 * over real HTTP, through stubbed Google, GitHub and email and password.
 * Pinned here: a start records "opened" once; the IdP gets a login_hint
 * (OIDC only) and never the token; the invited account goes to the project
 * with the invitation accepted and the welcome and accepted notices sent;
 * any other account gets the wrong-account page and no user row, or, when
 * admitted another way, a session and the signed-in wrong-account page; one
 * link sets a password, only while the invitation and its issuer allow it;
 * Join for a signed-in holder; the form token and the Origin check; and no
 * token or note in any audit row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boot, cookieOf, devLogin, fieldOf, invite, jar, openPage, postForm, project, startAndReturn, tokenFor, type Env,
} from './invite-harness.ts';

const INVITED = 'an.fitzsimon@suse.example';
const LAND = '/#/team/project/prj_brand';

async function withInvite(o: { passwordSetup?: boolean; idp?: Record<string, unknown> } = {}): Promise<Env & { token: string }> {
  const env = await boot(o.idp ? { idp: o.idp } : {});
  await project(env, 'prj_brand', 'Brand refresh');
  await invite(env, {
    id: 'inv_an', email: INVITED, projects: [{ projectId: 'prj_brand', role: 'editor', invitedBy: `user:${env.admin.id}` }],
    ...(o.passwordSetup ? { passwordSetup: true } : {}),
  });
  return { ...env, token: tokenFor('inv_an', 'prj_brand') };
}

const auditsOf = async (env: Env, action: string) => (await env.store.listAudit()).filter((e) => e.action === action);

test('a start records "opened" once and audits it once; the GET never does', async () => {
  const env = await withInvite();
  for (let i = 0; i < 2; i++) {
    const page = await openPage(env.base, `/l/invite/${env.token}`);
    const started = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp: 'primary' }, page.form);
    assert.equal(started.status, 302);
  }
  assert.ok((await env.store.getInvitation('inv_an'))?.openedAt, 'opened');
  const opened = await auditsOf(env, 'invite.open');
  assert.equal(opened.length, 1, 'audited once');
  assert.equal(opened[0]!.actor, 'anonymous');
  assert.equal(opened[0]!.subject, 'invitation:inv_an');
  assert.deepEqual(opened[0]!.payload, { provider: 'oidc', idp: 'primary' });
});

test('the authorize URL carries login_hint for OIDC only and never the token; the state is random', async () => {
  const env = await withInvite();
  const start = async (idp: string) => {
    const page = await openPage(env.base, `/l/invite/${env.token}`);
    const res = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp }, page.form);
    return { location: res.headers.get('location') as string, state: cookieOf(res, 'lw_state') as string };
  };
  const google = await start('primary');
  const url = new URL(google.location);
  assert.equal(url.origin, 'https://accounts.google.test');
  assert.equal(url.searchParams.get('login_hint'), INVITED, 'the server adds the hint');
  assert.ok(!google.location.includes(env.token) && !google.location.includes('inv_an'), 'the token never goes to the IdP');
  const again = await start('primary');
  assert.notEqual(new URL(again.location).searchParams.get('state'), url.searchParams.get('state'));
  assert.ok(!google.state.includes(env.token), 'the state cookie is signed and carries no token either');
  const github = new URL((await start('github')).location);
  assert.equal(github.origin, 'https://github.com');
  assert.equal(github.searchParams.get('login_hint'), null, 'GitHub takes no email hint');
});

test('the invited account goes to the project: accepted, shared, welcomed, and the inviter told', async () => {
  const env = await withInvite();
  env.script.google = { sub: 'g-an', email: INVITED, email_verified: true, given_name: 'An', family_name: 'Fitzsimon' };
  const done = await startAndReturn(env, env.token, 'primary');
  assert.equal(done.done.status, 302, await done.done.clone().text());
  assert.equal(done.done.headers.get('location'), LAND);
  const an = (await env.store.getUserBySub('g-an'))!;
  assert.equal((await env.store.getProjectMember('prj_brand', an.id))?.role, 'editor');
  assert.equal((await env.store.getInvitation('inv_an'))?.acceptedUserId, an.id);
  const accept = (await auditsOf(env, 'invite.accept'))[0]!;
  assert.equal((accept.payload as { via?: string }).via, 'sign-in');

  const messages = await env.store.listMessages();
  const welcome = messages.find((m) => m.id === 'msg_welcome_inv_an')!;
  assert.deepEqual(welcome.audience.users, [an.id]);
  assert.equal(welcome.title, 'Welcome to lolly.ing');
  assert.equal(welcome.body, 'Andy Fitz invited you. You can open Brand refresh as an Editor.');
  assert.ok(!messages.some((m) => m.data?.kind === 'project-share'), 'the welcome replaces the share message');
  const accepted = messages.find((m) => m.data?.kind === 'invite-accepted')!;
  assert.deepEqual(accepted.audience.users, [env.admin.id]);
  assert.equal(accepted.title, 'An Fitzsimon accepted your invitation');
  assert.equal(accepted.cta?.url, LAND);
});

test('another account is refused with the wrong-account page, and no user row is written', async () => {
  const env = await withInvite();
  const usersBefore = (await env.store.listUsers()).length;
  env.script.google = { sub: 'g-sam', email: 'sam.k@gmail.example', email_verified: true, given_name: 'Sam' };
  const { done } = await startAndReturn(env, env.token, 'primary');
  assert.equal(done.status, 403);
  assert.equal(cookieOf(done, 'lw_session'), undefined);
  const html = await done.text();
  assert.ok(html.includes('<h1>This is not the invited account</h1>'));
  assert.ok(html.includes('<title>Invitation to lolly.ing</title>'));
  assert.ok(html.includes("You signed in as <span class=\"tag addr\">sam.k@gmail.example</span> with Google. Andy Fitz's invitation was sent to <span class=\"tag addr\" aria-hidden=\"true\">an•••@suse.example</span>"));
  assert.ok(!html.includes(INVITED), 'never the full invited address');
  assert.ok(!html.includes('GitHub shares every verified address'), 'the GitHub line is for GitHub sign-ins');
  // The way back: the same sign-in with the account picker, or the page.
  assert.equal(fieldOf(html, 'start', 'idp'), 'primary');
  assert.equal(fieldOf(html, 'start', 'prompt'), 'select_account');
  assert.ok(html.includes(`href="/l/invite/${env.token}"`) && html.includes('Other ways to sign in'));
  // The ask: Andy decides.
  assert.ok(html.includes('<h2>Or ask to use this account</h2>'));
  assert.ok(html.includes('Andy Fitz decides whether <span class="addr">sam.k@gmail.example</span> can use this invitation.'));
  assert.ok(fieldOf(html, 'switch', 'ask') && html.includes('Ask Andy Fitz'));

  assert.equal((await env.store.listUsers()).length, usersBefore, 'users unchanged');
  assert.equal(await env.store.getUserBySub('g-sam'), null);
  const denied = (await auditsOf(env, 'auth.denied'))[0]!;
  assert.deepEqual(denied.payload, { provider: 'oidc', idp: 'primary', reason: 'not-invited', email: 'sam.k@gmail.example', invitationId: 'inv_an' });
  const wrong = (await auditsOf(env, 'invite.wrong-account'))[0]!;
  assert.equal(wrong.actor, 'anonymous');
  assert.deepEqual(wrong.payload, { email: 'sam.k@gmail.example', provider: 'oidc', idp: 'primary', admitted: false });
  assert.equal((await env.store.getInvitation('inv_an'))?.acceptedAt, undefined);
});

test('GitHub: a second verified address that is the invited one is admitted from the page; otherwise the GitHub line', async () => {
  const env = await withInvite();
  env.script.github = { id: 77, login: 'an-gh', emails: [
    { email: 'an.personal@gmail.example', primary: true, verified: true },
    { email: INVITED, primary: false, verified: true },
  ] };
  const ok = await startAndReturn(env, env.token, 'github');
  assert.equal(ok.done.status, 302);
  assert.equal(ok.done.headers.get('location'), LAND);
  const an = (await env.store.getUserBySub('github:77'))!;
  assert.equal(an.email, 'an.personal@gmail.example', 'the account keeps the GitHub primary');
  assert.equal((await env.store.getInvitation('inv_an'))?.acceptedUserId, an.id);

  const other = await withInvite();
  other.script.github = { id: 78, login: 'sam-gh', emails: [{ email: 'sam.k@gmail.example', primary: true, verified: true }] };
  const refused = await startAndReturn(other, other.token, 'github');
  assert.equal(refused.done.status, 403);
  const html = await refused.done.text();
  assert.ok(html.includes('with GitHub.'));
  assert.ok(html.includes('GitHub shares every verified address on your account with lolly.ing. If <span class="tag addr" aria-hidden="true">an•••@suse.example</span>'));
});

test('an account admitted another way is signed in and told whose invitation it was', async () => {
  const env = await withInvite({ idp: { admission: { emails: ['listed@gmail.example'] } } });
  env.script.google = { sub: 'g-listed', email: 'listed@gmail.example', email_verified: true };
  const { done, session } = await startAndReturn(env, env.token, 'primary');
  assert.equal(done.status, 200);
  assert.ok(session, 'signed in');
  const html = await done.text();
  assert.ok(html.includes('<h1>You are signed in as another account</h1>'));
  assert.ok(html.includes('You are signed in to lolly.ing as <span class="tag addr">listed@gmail.example</span>.'));
  assert.ok(html.includes('<h2>Use this account instead?</h2>'), 'Brand refresh would give this account more');
  assert.ok(html.includes('Ask Andy Fitz to give <span class="addr">listed@gmail.example</span> the access this invitation gives.'));
  assert.ok(html.includes('Continue as listed@gmail.example'));
  const wrong = (await auditsOf(env, 'invite.wrong-account'))[0]!;
  const listed = (await env.store.getUserBySub('g-listed'))!;
  assert.equal(wrong.actor, `user:${listed.id}`);
  assert.equal((wrong.payload as { admitted: boolean }).admitted, true);
  assert.equal((await env.store.getInvitation('inv_an'))?.acceptedAt, undefined, 'the invitation stays for its address');
});

test('one link sets the password: a one-hour link on the invitation, the name kept, landing on the project', async () => {
  const env = await withInvite({ passwordSetup: true });
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  const form = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'password' }, page.form);
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.ok(html.includes('<h1>Set your password</h1>'));
  assert.ok(html.includes(`Choose a password for <span class="addr">${INVITED}</span>. From now on you sign in with this address and this password.`));
  assert.ok(html.includes(`name="returnTo" value="${LAND}"`));
  assert.ok((await env.store.getInvitation('inv_an'))?.openedAt, 'opened');
  assert.deepEqual((await auditsOf(env, 'invite.open'))[0]!.payload, { provider: 'password', idp: 'email' });
  const issued = (await auditsOf(env, 'auth.password.link.issue'))[0]!;
  assert.equal(issued.actor, `user:${env.admin.id}`, 'on the authority of the admin who invited');
  assert.deepEqual(issued.payload, { idp: 'email', email: INVITED, purpose: 'setup', via: 'invitation', invitationId: 'inv_an' });

  const token = /name="token" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const set = await postForm(env.base, '/api/auth/password/set', {
    csrf, token, returnTo: LAND, name: 'An Fitzsimon', password: 'a long enough passphrase', confirm: 'a long enough passphrase',
  }, jar(cookieOf(form, 'lw_form')));
  assert.equal(set.status, 303, await set.clone().text());
  assert.equal(set.headers.get('location'), LAND);
  assert.ok(cookieOf(set, 'lw_session'));
  const an = (await env.store.findUsersByEmail(INVITED))[0]!;
  assert.equal(an.firstname, 'An Fitzsimon', 'named, so people and notices show a name');
  assert.equal((await env.store.getInvitation('inv_an'))?.acceptedUserId, an.id);
  assert.equal((await env.store.getProjectMember('prj_brand', an.id))?.role, 'editor');
  const accepted = (await env.store.listMessages()).find((m) => m.data?.kind === 'invite-accepted')!;
  assert.equal(accepted.title, 'An Fitzsimon accepted your invitation');
  // The link the page made is spent with it.
  const again = await postForm(env.base, '/api/auth/password/set', { csrf, token, password: 'a long enough passphrase', confirm: 'a long enough passphrase' }, jar(cookieOf(form, 'lw_form')));
  assert.equal(again.status, 410);
});

test('the password action is refused: flag off, a password already set, the issuer demoted or turned off, an owner address by an admin', async () => {
  const refusal = 'This invitation can no longer set a password. Sign in another way, or ask Andy Fitz for a sign-in link.';
  const tryPassword = async (env: Env & { token: string }) => {
    const page = await openPage(env.base, `/l/invite/${env.token}`);
    assert.ok(!page.html.includes('Set a password'), 'the page does not offer it');
    const res = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'password' }, page.form);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`<p class="err" role="alert">${refusal}</p>`), html);
    assert.equal((await auditsOf(env, 'auth.password.link.issue')).length, 0, 'no link issued');
  };

  await tryPassword(await withInvite());

  const credential = await withInvite({ passwordSetup: true });
  await credential.store.putPasswordCredential({ id: 'pwc_an', email: INVITED, hash: 'scrypt$x', at: new Date().toISOString(), ownerIssued: false });
  await tryPassword(credential);

  const demoted = await withInvite({ passwordSetup: true });
  await demoted.store.upsertUserBySub({ sub: demoted.admin.sub, email: demoted.admin.email, firstname: 'Andy Fitz', groups: [], role: 'member' });
  await tryPassword(demoted);

  const disabled = await withInvite({ passwordSetup: true });
  await disabled.store.setUserDisabled(disabled.admin.id, new Date().toISOString());
  await tryPassword(disabled);

  const owner = await boot();
  await invite(owner, { id: 'inv_boss', email: 'boss@suse.example', groups: ['owner'], passwordSetup: true });
  await tryPassword({ ...owner, token: tokenFor('inv_boss', null) });
});

test('with a password already set, the page signs in with it and shows which address to use, masked', async () => {
  const env = await withInvite();
  await env.store.putPasswordCredential({ id: 'pwc_an', email: INVITED, hash: 'scrypt$x', at: new Date().toISOString(), ownerIssued: false });
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  assert.ok(page.html.includes('Sign in with email and password'));
  const res = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp: 'email' }, page.form);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Use the address your invitation went to: <span class="tag addr" aria-hidden="true">an•••@suse.example</span><span class="sr-only">an address at suse.example that starts with an</span>'));
  assert.ok(!html.includes(INVITED), 'the email is not filled in for them');
  assert.ok(html.includes(`name="returnTo" value="${LAND}"`));
});

test('Join for a signed-in holder accepts and goes to the project; anyone else gets the other-account page', async () => {
  const env = await boot();
  await project(env, 'prj_brand', 'Brand refresh');
  await invite(env, { id: 'inv_p', email: 'priya@admin.example', projects: [{ projectId: 'prj_brand', role: 'editor' }] });
  const token = tokenFor('inv_p', 'prj_brand');

  const owner = await devLogin(env.base, 'owner@admin.example');
  const ownersPage = await openPage(env.base, `/l/invite/${token}`, owner);
  const notHolder = await postForm(env.base, '/api/auth/invite', { token, csrf: ownersPage.csrf, action: 'join' }, jar(ownersPage.form, owner));
  assert.equal(notHolder.status, 200);
  assert.ok((await notHolder.text()).includes('You are signed in as another account'));
  assert.equal((await env.store.getInvitation('inv_p'))?.acceptedAt, undefined);

  const priya = await devLogin(env.base, 'priya@admin.example');
  const page = await openPage(env.base, `/l/invite/${token}`, priya);
  const joined = await postForm(env.base, '/api/auth/invite', { token, csrf: page.csrf, action: 'join' }, jar(page.form, priya));
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get('location'), '/#/team/project/prj_brand');
  const user = (await env.store.findUsersByEmail('priya@admin.example'))[0]!;
  assert.equal((await env.store.getInvitation('inv_p'))?.acceptedUserId, user.id);
  assert.equal((await env.store.getProjectMember('prj_brand', user.id))?.role, 'editor');
  assert.equal(((await auditsOf(env, 'invite.accept'))[0]!.payload as { via: string }).via, 'join');
  // Now the page says so.
  assert.ok((await openPage(env.base, `/l/invite/${token}`, priya)).html.includes('You are already in'));
});

test('a post without the form cookie starts nothing; a cross-site Origin is refused before any route', async () => {
  const env = await withInvite();
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  const stale = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp: 'primary' }, '');
  assert.equal(stale.status, 403);
  assert.ok((await stale.text()).includes('This page expired. Choose how to sign in again.'));
  assert.equal((await env.store.getInvitation('inv_an'))?.openedAt, undefined, 'nothing started, nothing opened');
  const forged = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp: 'primary' }, page.form,
    { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(forged.status, 403);
  assert.equal(((await forged.json()) as { error: { code: string } }).error.code, 'CSRF_BLOCKED');
  // A dead token on the post is the dead page, like the GET.
  const dead = await postForm(env.base, '/api/auth/invite', { token: 'abc.def', csrf: page.csrf, action: 'start', idp: 'primary' }, page.form);
  assert.equal(dead.status, 410);
});

test('an invitation withdrawn between the start and the callback makes a plain sign-in that goes to the app', async () => {
  const env = await withInvite({ idp: { admission: { emails: ['listed@gmail.example'] } } });
  env.script.google = { sub: 'g-listed', email: 'listed@gmail.example', email_verified: true };
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  const started = await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'start', idp: 'primary' }, page.form);
  const authorize = new URL(started.headers.get('location') as string);
  env.script.nonce = authorize.searchParams.get('nonce') as string;
  await env.store.revokeInvitation('inv_an', new Date().toISOString());
  const done = await fetch(`${env.base}/api/auth/callback?code=c&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: cookieOf(started, 'lw_state') as string }, redirect: 'manual',
  });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/');
  assert.equal((await auditsOf(env, 'invite.wrong-account')).length, 0);
});

test('a project its inviter may no longer add people to is skipped, and the invitee hears so', async () => {
  const env = await boot();
  await devLogin(env.base, 'priya@admin.example');
  const priya = (await env.store.findUsersByEmail('priya@admin.example'))[0]!;
  await project(env, 'prj_a', 'Atlas');
  await project(env, 'prj_b', 'Bravo', priya.id);
  await invite(env, { id: 'inv_two', email: INVITED, projects: [
    { projectId: 'prj_a', role: 'editor', invitedBy: `user:${env.admin.id}` },
    { projectId: 'prj_b', role: 'viewer', invitedBy: `user:${priya.id}` },
  ] });
  await env.store.setUserDisabled(priya.id, new Date().toISOString());
  env.script.google = { sub: 'g-an', email: INVITED, email_verified: true, given_name: 'An' };
  const { done } = await startAndReturn(env, tokenFor('inv_two', 'prj_a'), 'primary');
  assert.equal(done.status, 302);
  const an = (await env.store.getUserBySub('g-an'))!;
  const messages = await env.store.listMessages();
  const skipped = messages.find((m) => m.data?.kind === 'invite-skipped')!;
  assert.deepEqual(skipped.audience.users, [an.id]);
  assert.equal(skipped.title, 'Your invitation to Bravo no longer works');
  assert.equal(messages.find((m) => m.id === 'msg_welcome_inv_two')?.body, 'Andy Fitz invited you. You can open Atlas as an Editor.');
  // Only enabled inviters hear of the acceptance.
  assert.deepEqual(messages.filter((m) => m.data?.kind === 'invite-accepted').map((m) => m.audience.users), [[env.admin.id]]);
});

test('no audit payload holds an invite token, an ask token or a note', async () => {
  const env = await withInvite({ passwordSetup: true });
  env.script.google = { sub: 'g-sam', email: 'sam.k@gmail.example', email_verified: true };
  const { done, form } = await startAndReturn(env, env.token, 'primary');
  const html = await done.text();
  const ask = fieldOf(html, 'switch', 'ask');
  const csrf = fieldOf(html, 'switch', 'csrf');
  const note = 'please let me in, my work address is blocked';
  const sent = await postForm(env.base, '/api/auth/request', { ask, csrf, action: 'switch', note }, form);
  assert.equal(sent.status, 200);
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  await postForm(env.base, '/api/auth/invite', { token: env.token, csrf: page.csrf, action: 'password' }, page.form);
  const chain = JSON.stringify(await env.store.listAudit());
  assert.ok(!chain.includes(env.token) && !chain.includes(ask), 'no token');
  assert.ok(!chain.includes(note), 'no note text');
  assert.ok((await auditsOf(env, 'access.request')).some((e) => (e.payload as { noteChars?: number }).noteChars === note.length));
});
