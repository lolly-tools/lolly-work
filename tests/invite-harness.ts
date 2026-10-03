// SPDX-License-Identifier: MPL-2.0
/**
 * Shared set-up for the invite link and sign-in request tests
 * (invite-page, invite-sign-in, join-request-page): one instance named
 * "lolly.ing" over real HTTP on the memory store, with a Google-style OIDC
 * issuer (RS256 id_tokens against a stub JWKS), GitHub (OAuth 2.0) and
 * email and password, all stubbed in one fetchImpl scripted per sign-in.
 * Admins come from the dev provider, which skips admission. Not a test file
 * itself: the suite runs `*.test.ts` only.
 */
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { mintInviteToken } from '../server/src/access/invite-token.ts';
import type { Metrics } from '../server/src/observability/metrics.ts';
import type { InvitationProject, Store, UserRecord } from '../server/src/store/types.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

export const GOOGLE = 'https://accounts.google.test';
export const SESSION_SECRET = 'sInvite';
export const LINK_SECRET = 'lInvite';
const SECRET_ENV = 'LW_TEST_INVITE_GITHUB_SECRET';
process.env[SECRET_ENV] = 'gh-invite-secret-not-real';
const GH_TOKEN = 'gho_invite_test_token';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createSign('sha256').update(`${head}.${body}`).sign(privateKey))}`;
}

/** What the next sign-in at each IdP returns. Tests rewrite it between flows. */
export interface Script {
  google: { sub: string; email: string; email_verified?: boolean; given_name?: string; family_name?: string };
  github: { id: number; login: string; emails: Array<{ email: string; primary: boolean; verified: boolean }> };
  nonce: string;
}

function idpFetch(script: Script): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${GOOGLE}/.well-known/openid-configuration`) {
      return Response.json({ issuer: GOOGLE, authorization_endpoint: `${GOOGLE}/authorize`, token_endpoint: `${GOOGLE}/token`, jwks_uri: `${GOOGLE}/jwks` });
    }
    if (url === `${GOOGLE}/jwks`) return Response.json({ keys: [JWK] });
    if (url === `${GOOGLE}/token`) {
      return Response.json({
        id_token: signIdToken({ iss: GOOGLE, aud: 'g-client', nonce: script.nonce, exp: Math.floor(Date.now() / 1000) + 300, ...script.google }),
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: GH_TOKEN, token_type: 'bearer' });
    if (url === 'https://api.github.com/user' || url === 'https://api.github.com/user/emails') {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${GH_TOKEN}`) return new Response('{}', { status: 401 });
      return url.endsWith('/emails')
        ? Response.json(script.github.emails)
        : Response.json({ id: script.github.id, login: script.github.login, name: null, email: null });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

export interface Env {
  base: string;
  store: Store;
  script: Script;
  /** The admin who owns the project and invites (dev sign-in, role admin). */
  admin: UserRecord;
  adminSession: string;
}

/**
 * Boot an instance. `idp` and `policy` merge over the defaults: admission on
 * with invitations only (lolly.ing's shape), join requests on, Google,
 * GitHub and email and password.
 */
export async function boot(opts: {
  idp?: Record<string, unknown>; policy?: Record<string, unknown>; instance?: Record<string, unknown>; metrics?: Metrics;
} = {}): Promise<Env> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-invite-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: {
      name: 'lolly.ing', baseUrl: 'http://team.example', pack,
      inviteNote: 'If your organisation blocks Google sign-in (for example @suse.com), use GitHub or email and password.',
      ...opts.instance,
    },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'andy@admin.example', name: 'Andy Fitz', groups: ['admin'] },
      { email: 'priya@admin.example', name: 'Priya Rao', groups: ['admin'] },
      { email: 'owner@admin.example', name: 'Olive Owner', groups: ['owner'] },
    ] },
    policy: { requests: { join: true, project: true, ttlDays: 14, joinOpenMax: 50 }, ...opts.policy },
    idp: {
      issuer: GOOGLE, clientId: 'g-client', displayName: 'Google',
      admission: {},
      additional: [
        { id: 'github', kind: 'github', clientId: 'gh-client', displayName: 'GitHub', clientSecretRef: SECRET_ENV },
        { id: 'email', kind: 'password' },
      ],
      ...opts.idp,
    },
  }));
  const store = createMemoryStore();
  const script: Script = {
    google: { sub: 'g-sam', email: 'sam@work.example', email_verified: true, given_name: 'Sam', family_name: 'Kay' },
    github: { id: 101, login: 'sam-gh', emails: [{ email: 'sam.k@gmail.com', primary: true, verified: true }] },
    nonce: '',
  };
  const app = buildApp({
    config, store, blobs: createMemoryBlobStore(), secrets: { session: SESSION_SECRET, link: LINK_SECRET }, fetchImpl: idpFetch(script),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
  });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const adminSession = await devLogin(base, 'andy@admin.example');
  const admin = (await store.findUsersByEmail('andy@admin.example'))[0]!;
  return { base, store, script, admin, adminSession };
}

export const cookieOf = (res: Response, name: string): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

export async function devLogin(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return cookieOf(res, 'lw_session') as string;
}

/** A project the admin owns. */
export async function project(env: Env, id: string, name: string, ownerId = env.admin.id): Promise<void> {
  await env.store.putProject({ id, name, visibility: 'private', ownerId, createdAt: new Date().toISOString() });
}

/** Write an invitation straight into the store, as the invite routes would. */
export async function invite(env: Env, o: {
  id: string; email: string; projects?: InvitationProject[]; invitedBy?: string; passwordSetup?: boolean;
  expiresAt?: string; groups?: string[]; createdVia?: 'console' | 'project' | 'request';
}) {
  const { invitation } = await env.store.createInvitation({
    id: o.id, email: o.email, groups: o.groups ?? [], invitedBy: o.invitedBy ?? `user:${env.admin.id}`,
    createdAt: new Date().toISOString(), expiresAt: o.expiresAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...(o.projects ? { projects: o.projects } : {}), ...(o.passwordSetup ? { passwordSetup: true } : {}),
    createdVia: o.createdVia ?? (o.projects?.length ? 'project' : 'console'),
  });
  return invitation;
}

/** The token of one entry's link, as app.ts mints it. */
export const tokenFor = (invitationId: string, projectId: string | null, version = 1): string =>
  mintInviteToken({ invitationId, projectId, version }, LINK_SECRET);

/** Open a page: its HTML, the csrf field, the form cookie. */
export async function openPage(base: string, path: string, cookie?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { res, html, csrf, form: cookieOf(res, 'lw_form') ?? '' };
}

/** A form post shaped like a browser's from one of these pages. */
export function postForm(base: string, path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}), ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The value of a hidden field in the first form whose `action` field is `action`. */
export function fieldOf(html: string, action: string, name: string): string {
  const forms = html.split('<form').slice(1);
  const form = forms.find((f) => f.includes(`name="action" value="${action}"`)) ?? '';
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(form)?.[1] ?? '';
}

export const jar = (...cookies: Array<string | undefined>): string => cookies.filter(Boolean).join('; ');

/**
 * Press a sign-in button on an invite page (R2 start) and come back to the
 * callback as the IdP would. `session` rides along when the person is
 * signed in already.
 */
export async function startAndReturn(env: Env, token: string, idp: string, o: { session?: string; prompt?: boolean } = {}) {
  const page = await openPage(env.base, `/l/invite/${token}`, o.session);
  const started = await postForm(env.base, '/api/auth/invite', {
    token, csrf: page.csrf, action: 'start', idp, ...(o.prompt ? { prompt: 'select_account' } : {}),
  }, jar(page.form, o.session));
  assert.equal(started.status, 302, await started.clone().text());
  const authorize = new URL(started.headers.get('location') as string);
  if (authorize.origin === GOOGLE) env.script.nonce = authorize.searchParams.get('nonce') as string;
  const state = cookieOf(started, 'lw_state') as string;
  const done = await fetch(`${env.base}/api/auth/callback?code=c&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: jar(state, page.form, o.session) }, redirect: 'manual',
  });
  return { started, authorize, done, session: cookieOf(done, 'lw_session'), form: cookieOf(done, 'lw_form') ?? page.form };
}

/** A plain sign-in (no invite page), back through the callback. */
export async function signIn(env: Env, idp: string) {
  const started = await fetch(`${env.base}/api/auth/login?idp=${idp}&returnTo=%2F`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location') as string);
  if (authorize.origin === GOOGLE) env.script.nonce = authorize.searchParams.get('nonce') as string;
  const state = cookieOf(started, 'lw_state') as string;
  const done = await fetch(`${env.base}/api/auth/callback?code=c&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: state }, redirect: 'manual',
  });
  return { done, session: cookieOf(done, 'lw_session'), form: cookieOf(done, 'lw_form') ?? '' };
}

/** Everything a GET could change, for "GET writes nothing". */
export async function snapshot(store: Store): Promise<string> {
  return JSON.stringify([
    await store.listInvitations(), await store.listAudit(), await store.listUsers(), await store.listMessages(),
  ]);
}
