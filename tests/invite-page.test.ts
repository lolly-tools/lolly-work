// SPDX-License-Identifier: MPL-2.0
/**
 * The invite page, GET /l/invite/:token (plans/74 invite spec R1, section 3;
 * plans/75 5.9), over real HTTP. Pinned here: every state and its status,
 * that the GET writes nothing, that no state shows the full invited
 * address, an Open Graph tag or a title naming more than the workspace,
 * that a link shows only its own project, that every kind of dead link
 * reads byte for byte the same, the headers, and that names and notes are
 * text. Starting a sign-in from the page is invite-sign-in.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMetrics } from '../server/src/observability/metrics.ts';
import { boot, devLogin, invite, openPage, project, snapshot, tokenFor, type Env } from './invite-harness.ts';

const INVITED = 'an.fitzsimon@suse.example';

async function withProject(): Promise<Env & { token: string }> {
  const env = await boot();
  await project(env, 'prj_brand', 'Brand refresh');
  await invite(env, { id: 'inv_an', email: INVITED, projects: [{ projectId: 'prj_brand', role: 'editor', invitedBy: `user:${env.admin.id}` }] });
  return { ...env, token: tokenFor('inv_an', 'prj_brand') };
}

/** What no invite page may hold, whatever its state (spec 6 rule 3). */
function assertDiscreet(html: string, label: string): void {
  assert.ok(!html.includes(INVITED), `${label}: the full invited address`);
  assert.ok(!/\b(og|twitter):/i.test(html), `${label}: an og: or twitter: tag`);
  assert.match(html, /<title>Invitation to lolly\.ing<\/title>/, `${label}: the generic title`);
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<h1>/g) ?? []).length, 1, `${label}: one h1`);
  assert.ok(!html.includes('<script'), `${label}: no script`);
}

test('signed out, pending: who invited, to what, as which role, until when, and one form per sign-in', async () => {
  const env = await withProject();
  const page = await openPage(env.base, `/l/invite/${env.token}`);
  assert.equal(page.res.status, 200);
  const { html } = page;
  assertDiscreet(html, 'pending');
  assert.ok(html.includes('<h1>Andy Fitz invited you to Brand refresh</h1>'));
  assert.ok(html.includes('On lolly.ing, as an Editor. Editors can open and save work in Brand refresh.'));
  // The mask is hidden from screen readers, which read the words beside it.
  assert.ok(html.includes('Sign in with the address this invitation was sent to: <span class="tag addr" aria-hidden="true">an•••@suse.example</span><span class="sr-only">an address at suse.example that starts with an</span>'));
  assert.match(html, /Ends in 30 days \(\d{1,2} [A-Z][a-z]{2}( \d{4})?, UTC\)\./);
  // One form per sign-in, posting the token and the form nonce; no password
  // buttons, since the flag is off and the address has no password.
  assert.ok(html.includes('Continue with Google') && html.includes('Continue with GitHub'));
  assert.ok(!html.includes('Set a password') && !html.includes('Sign in with email and password'));
  assert.equal((html.match(/name="action" value="start"/g) ?? []).length, 2);
  assert.ok(html.includes(`name="token" value="${env.token}"`));
  assert.ok(page.csrf && page.form, 'a form nonce and its cookie');
  assert.ok(html.includes('Using GitHub? lolly.ing checks every verified address on your GitHub account.'));
  assert.ok(html.includes('If your organisation blocks Google sign-in (for example @suse.com), use GitHub or email and password.'));
  assert.ok(html.includes('Not expecting this? You can ignore this page.'));
  assert.ok(!html.includes('Link to open'), 'no in-app browser card in a real browser');

  // Headers (spec 3.1): no cache, no index, strict-origin, no script.
  const h = page.res.headers;
  assert.equal(h.get('cache-control'), 'no-store');
  assert.equal(h.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(h.get('referrer-policy'), 'strict-origin');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  assert.match(page.res.headers.getSetCookie().join('\n'), /lw_form=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Strict/);
});

test('roles and a workspace link read as the spec says; the password buttons follow the flag and the address', async () => {
  const env = await boot();
  await project(env, 'prj_v', 'Viewers Club');
  await project(env, 'prj_m', 'Managers Club');
  await invite(env, { id: 'inv_v', email: 'v@suse.example', projects: [{ projectId: 'prj_v', role: 'viewer' }] });
  await invite(env, { id: 'inv_m', email: 'm@suse.example', projects: [{ projectId: 'prj_m', role: 'manager' }], passwordSetup: true });
  await invite(env, { id: 'inv_w', email: 'w@suse.example', passwordSetup: true });

  const viewer = (await openPage(env.base, `/l/invite/${tokenFor('inv_v', 'prj_v')}`)).html;
  assert.ok(viewer.includes('On lolly.ing, as a Viewer. Viewers can open work in Viewers Club and make their own copy.'));
  const manager = (await openPage(env.base, `/l/invite/${tokenFor('inv_m', 'prj_m')}`)).html;
  assert.ok(manager.includes('On lolly.ing, as a Manager. Managers can also add people to Managers Club.'));
  // The flag is on and the admin who invited still stands: Set a password
  // comes first, as the primary button, before the other sign-ins.
  const setAt = manager.indexOf('Set a password');
  assert.ok(setAt > 0 && setAt < manager.indexOf('Continue with Google'));
  assert.match(manager, /<button class="primary" type="submit">Set a password<\/button>/);
  assert.ok(manager.includes('You then sign in with <span class="tag addr" aria-hidden="true">m•••@suse.example</span>'));

  const workspace = (await openPage(env.base, `/l/invite/${tokenFor('inv_w', null)}`)).html;
  assert.ok(workspace.includes('<h1>Andy Fitz invited you to lolly.ing</h1>'));
  assert.ok(workspace.includes('lolly.ing is a private Lolly workspace. Once you are in, projects people share with you appear in Projects.'));

  // With a password already set for the address: sign in with it instead.
  await env.store.putPasswordCredential({ id: 'pwc_w', email: 'w@suse.example', hash: 'scrypt$x', at: new Date().toISOString(), ownerIssued: false });
  const withPassword = (await openPage(env.base, `/l/invite/${tokenFor('inv_w', null)}`)).html;
  assert.ok(!withPassword.includes('Set a password'));
  assert.ok(withPassword.includes('Sign in with email and password'));
});

test('GET writes nothing, signed out or in, whatever the state (spec 6 rule 2)', async () => {
  const env = await withProject();
  await invite(env, { id: 'inv_old', email: 'old@suse.example', expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const before = await snapshot(env.store);
  const member = await devLogin(env.base, 'priya@admin.example');
  const afterLogin = await snapshot(env.store);
  for (const cookie of [undefined, member]) {
    for (const path of [`/l/invite/${env.token}`, `/l/invite/${tokenFor('inv_old', null)}`, '/l/invite/abc.def']) {
      await openPage(env.base, path, cookie);
    }
  }
  assert.equal(await snapshot(env.store), afterLogin, 'opening the pages changed nothing');
  assert.notEqual(before, afterLogin, 'the snapshot sees writes (the dev sign-in made one)');
  assert.equal((await env.store.getInvitation('inv_an'))?.openedAt, undefined, 'a GET never counts as opened');
});

test('no state shows the full address, an og tag or a revealing title (spec 6 rule 3)', async () => {
  const env = await withProject();
  // Signed out, pending.
  assertDiscreet((await openPage(env.base, `/l/invite/${env.token}`)).html, 'signed out');
  // Signed in as someone else.
  const priya = await devLogin(env.base, 'priya@admin.example');
  const other = await openPage(env.base, `/l/invite/${env.token}`, priya);
  assertDiscreet(other.html, 'other account');
  assert.ok(other.html.includes('<h1>You are signed in as another account</h1>'));
  // Ended.
  await invite(env, { id: 'inv_end', email: INVITED.replace('an.', 'ended.'), expiresAt: new Date(Date.now() - 1000).toISOString() });
  assertDiscreet((await openPage(env.base, `/l/invite/${tokenFor('inv_end', null)}`)).html, 'ended');
  // Dead.
  assertDiscreet((await openPage(env.base, '/l/invite/abc.def')).html, 'dead');
  // Used, then already in.
  const user = await env.store.upsertUserBySub({ sub: 'g-an', email: INVITED, groups: [], role: 'member' });
  await env.store.acceptInvitation('inv_an', user.id, new Date().toISOString());
  assertDiscreet((await openPage(env.base, `/l/invite/${env.token}`)).html, 'used');
});

test('two inviters, two projects on one invitation: each link shows only its own (spec 6 rule 4)', async () => {
  const env = await boot();
  await devLogin(env.base, 'priya@admin.example');
  const priya = (await env.store.findUsersByEmail('priya@admin.example'))[0]!;
  await project(env, 'prj_a', 'Atlas launch');
  await project(env, 'prj_b', 'Secret merger', priya.id);
  await invite(env, {
    id: 'inv_two', email: 'sam@suse.example', projects: [
      { projectId: 'prj_a', role: 'editor', invitedBy: `user:${env.admin.id}` },
      { projectId: 'prj_b', role: 'viewer', invitedBy: `user:${priya.id}` },
    ],
  });
  const a = (await openPage(env.base, `/l/invite/${tokenFor('inv_two', 'prj_a')}`)).html;
  const b = (await openPage(env.base, `/l/invite/${tokenFor('inv_two', 'prj_b')}`)).html;
  assert.ok(a.includes('Andy Fitz invited you to Atlas launch') && !a.includes('Secret merger') && !a.includes('Priya'));
  assert.ok(b.includes('Priya Rao invited you to Secret merger') && !b.includes('Atlas launch') && !b.includes('Andy'));
  // The workspace link names neither project.
  const w = (await openPage(env.base, `/l/invite/${tokenFor('inv_two', null)}`)).html;
  assert.ok(!w.includes('Atlas launch') && !w.includes('Secret merger'));
});

test('dead links: unknown, malformed, revoked and replaced give the same 410, byte for byte (spec 6 rules 5 and 6)', async () => {
  const env = await withProject();
  await invite(env, { id: 'inv_rev', email: 'rev@suse.example' });
  await invite(env, { id: 'inv_new', email: 'new@suse.example' });
  const replaced = tokenFor('inv_new', null);
  await env.store.rotateInvitationLink('inv_new');
  await env.store.revokeInvitation('inv_rev', new Date().toISOString());
  const causes = {
    unknown: tokenFor('inv_nobody', null),
    malformed: 'abc.def',
    tampered: `${env.token.slice(0, -2)}xx`,
    'wrong key': env.token.replace(/\.[^.]+$/, '.AAAA'),
    revoked: tokenFor('inv_rev', null),
    replaced,
  };
  const bodies = new Set<string>();
  for (const [cause, token] of Object.entries(causes)) {
    const page = await openPage(env.base, `/l/invite/${token}`);
    assert.equal(page.res.status, 410, cause);
    assert.equal(page.res.headers.get('x-robots-tag'), 'noindex, nofollow', cause);
    assert.equal(page.res.headers.get('set-cookie'), null, `${cause}: no form, no form cookie`);
    bodies.add(page.html);
  }
  assert.equal(bodies.size, 1, 'one page for every cause');
  const [body] = [...bodies];
  assert.ok(body!.includes('<h1>This link no longer works</h1>'));
  assert.ok(body!.includes('The invitation was withdrawn or replaced by a newer link. If you were sent a newer link, open that one.'));
  assert.ok(body!.includes('href="/api/auth/login"'));
  // The new link after the rotation still works.
  assert.equal((await openPage(env.base, `/l/invite/${tokenFor('inv_new', null, 2)}`)).res.status, 200);
});

test('ended: a 410 that names the inviter and the project and says what to do', async () => {
  const env = await boot();
  await project(env, 'prj_brand', 'Brand refresh');
  await invite(env, { id: 'inv_end', email: 'e@suse.example', projects: [{ projectId: 'prj_brand', role: 'editor' }], expiresAt: '2026-10-03T09:00:00Z' });
  const page = await openPage(env.base, `/l/invite/${tokenFor('inv_end', 'prj_brand')}`);
  assert.equal(page.res.status, 410);
  assert.ok(page.html.includes('<h1>This invitation has ended</h1>'));
  assert.match(page.html, /Andy Fitz's invitation to Brand refresh ended on 3 Oct( 2026)? \(UTC\)\. Ask Andy Fitz for a new link\./);
});

test('accepted: "already in" for the account that accepted, "already used" for anyone else', async () => {
  const env = await withProject();
  await devLogin(env.base, 'owner@admin.example');
  const holder = (await env.store.findUsersByEmail('owner@admin.example'))[0]!;
  await env.store.acceptInvitation('inv_an', holder.id, new Date().toISOString());
  const theirs = await openPage(env.base, `/l/invite/${env.token}`, await devLogin(env.base, 'owner@admin.example'));
  assert.equal(theirs.res.status, 200);
  assert.ok(theirs.html.includes('<h1>You are already in</h1>'));
  assert.ok(theirs.html.includes('href="/#/team/project/prj_brand"') && theirs.html.includes('Open Brand refresh'));
  const strangers = await openPage(env.base, `/l/invite/${env.token}`);
  assert.ok(strangers.html.includes('<h1>This invitation was already used</h1>'));
  assert.ok(strangers.html.includes('Sign in with the account that accepted the invitation.'));
  assert.ok(strangers.html.includes(`href="/api/auth/login?returnTo=${encodeURIComponent('/#/team/project/prj_brand')}"`));
});

test('signed in: the holder of the address gets one Join button; anyone else gets the other-account page', async () => {
  const env = await boot();
  await project(env, 'prj_brand', 'Brand refresh');
  // The holder: a dev account carrying the invited address.
  await invite(env, { id: 'inv_p', email: 'priya@admin.example', projects: [{ projectId: 'prj_brand', role: 'editor' }] });
  const priya = await devLogin(env.base, 'priya@admin.example');
  const join = await openPage(env.base, `/l/invite/${tokenFor('inv_p', 'prj_brand')}`, priya);
  assert.equal(join.res.status, 200);
  assert.ok(join.html.includes('<h1>Andy Fitz invited you to Brand refresh</h1>'));
  assert.ok(join.html.includes('You are signed in as <span class="tag addr">priya@admin.example</span>.'), "the reader's own address");
  assert.ok(join.html.includes('name="action" value="join"') && join.html.includes('Join Brand refresh'));

  // Someone else, with less than the invitation gives: the ask is offered.
  const owner = await devLogin(env.base, 'owner@admin.example');
  await env.store.putProject({ id: 'prj_x', name: 'Elsewhere', visibility: 'private', ownerId: env.admin.id, createdAt: new Date().toISOString() });
  await invite(env, { id: 'inv_x', email: 'x@suse.example', projects: [{ projectId: 'prj_x', role: 'editor' }] });
  const other = await openPage(env.base, `/l/invite/${tokenFor('inv_x', 'prj_x')}`, owner);
  assert.ok(other.html.includes('You are signed in to lolly.ing as <span class="tag addr">owner@admin.example</span>. This invitation is for <span class="tag addr" aria-hidden="true">x•••@suse.example</span>'));
  assert.ok(other.html.includes('<h2>Use a different account</h2>'));
  assert.equal((other.html.match(/name="prompt" value="select_account"/g) ?? []).length, 3, 'each sign-in asks for the account picker');
  // An owner manages every project already, so there is nothing to ask for.
  assert.ok(!other.html.includes('Use this account instead?'));
  assert.ok(other.html.includes('href="/"') && other.html.includes('Continue as owner@admin.example'));

  // The inviter never asks to use their own invitation.
  const inviterView = await openPage(env.base, `/l/invite/${tokenFor('inv_x', 'prj_x')}`, env.adminSession);
  assert.ok(!inviterView.html.includes('Use this account instead?'));
});

test('a link for a project taken off the invitation, or archived, reads as a workspace link', async () => {
  const env = await boot();
  await project(env, 'prj_gone', 'Gone project');
  await project(env, 'prj_arch', 'Archived project');
  await invite(env, { id: 'inv_g', email: 'g@suse.example', projects: [{ projectId: 'prj_arch', role: 'editor' }] });
  const stale = (await openPage(env.base, `/l/invite/${tokenFor('inv_g', 'prj_gone')}`)).html;
  assert.ok(stale.includes('<h1>Andy Fitz invited you to lolly.ing</h1>') && !stale.includes('Gone project'));
  await env.store.putProject({ id: 'prj_arch', name: 'Archived project', visibility: 'private', ownerId: env.admin.id, createdAt: new Date().toISOString(), archivedAt: new Date().toISOString() });
  const archived = (await openPage(env.base, `/l/invite/${tokenFor('inv_g', 'prj_arch')}`)).html;
  assert.ok(archived.includes('<h1>Andy Fitz invited you to lolly.ing</h1>') && !archived.includes('Archived project'));
});

test('an in-app browser gets the link to open elsewhere', async () => {
  const env = await withProject();
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
  ]) {
    const html = (await openPage(env.base, `/l/invite/${env.token}`, undefined, { 'user-agent': ua })).html;
    assert.ok(html.includes('This page is open inside another app, where Google sign-in can fail. Open the link in Safari or Chrome.'), ua);
    assert.ok(html.includes('<label class="field" for="invite-url">Link to open</label>'));
    assert.ok(html.includes(`value="http://team.example/l/invite/${env.token}" readonly`));
  }
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.ok(!(await openPage(env.base, `/l/invite/${env.token}`, undefined, { 'user-agent': safari })).html.includes('Link to open'));
});

test('names and project names are text on the page (spec 6 rule 19)', async () => {
  const env = await boot();
  const evil = await env.store.upsertUserBySub({ sub: 'dev:evil@admin.example', email: 'evil@admin.example', firstname: '<img src=x onerror=alert(1)>', groups: ['admin'], role: 'admin' });
  await project(env, 'prj_evil', '<script>alert(1)</script>', evil.id);
  await invite(env, { id: 'inv_evil', email: 'e@suse.example', projects: [{ projectId: 'prj_evil', role: 'editor', invitedBy: `user:${evil.id}` }], invitedBy: `user:${evil.id}` });
  const html = (await openPage(env.base, `/l/invite/${tokenFor('inv_evil', 'prj_evil')}`)).html;
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the request metric names the route, never the token (spec 6 rule 21)', async () => {
  const metrics = createMetrics();
  const env = await boot({ metrics });
  await invite(env, { id: 'inv_m', email: 'm@suse.example' });
  const token = tokenFor('inv_m', null);
  await openPage(env.base, `/l/invite/${token}`);
  await openPage(env.base, '/l/invite/abc.def');
  const text = metrics.renderText([]);
  assert.match(text, /lw_http_requests_total\{route="\/l\/invite\/:token",status="2xx"\} 1/);
  assert.match(text, /lw_http_requests_total\{route="\/l\/invite\/:token",status="4xx"\} 1/);
  assert.ok(!text.includes(token) && !text.includes('abc.def'));
});
