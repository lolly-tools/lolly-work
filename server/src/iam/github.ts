// SPDX-License-Identifier: MPL-2.0
/**
 * GitHub sign-in (plans/74, social sign-on). GitHub speaks OAuth 2.0, not
 * OpenID Connect: there is no discovery document, no id_token and no JWKS.
 * The person is whoever the access token says through the REST API, so this
 * adapter does three things and nothing else:
 *
 *   1. builds the authorize URL (PKCE S256, the two scopes we need);
 *   2. trades the code for an access token;
 *   3. reads `/user` and `/user/emails` and maps them onto the same
 *      `MappedIdentity` the OIDC path produces, so state, admission,
 *      bootstrap owners and audit stay one shared path in the callback.
 *
 * The subject is the numeric GitHub user id. The login name is never the
 * identity: people rename their accounts, and a freed login can be claimed
 * by someone else. The email is the primary address if GitHub has verified
 * it, else the first verified address (a noreply address only as a last
 * resort). An account with no verified address is refused (`no-email`), so
 * `emailVerified` is always true here. Every other verified address, except
 * GitHub's noreply ones, rides along as `invitationEmails`: an invitation
 * sent to a work address the person added to their GitHub account then
 * matches (plans/74 invite spec M5), while the admission lists, linking by
 * email and the stored email keep using the one address above. GitHub has
 * no groups, so an identity from here carries none.
 *
 * Every failure is a `GitHubSignInError` with a short public reason. The
 * caller turns it into the phone-friendly HTML page; GitHub's own error text
 * and the token never reach the page or a log line.
 */
import type { MappedIdentity } from './oidc.ts';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';
/** `read:user` for the profile, `user:email` for private and verified addresses. */
export const GITHUB_SCOPE = 'read:user user:email';
const USER_AGENT = 'lolly-work-sign-in';
/** Most secondary addresses an identity carries for invitation matching. */
export const INVITATION_EMAILS_MAX = 10;

export type GitHubFailure = 'token' | 'profile' | 'no-email';

export class GitHubSignInError extends Error {
  readonly reason: GitHubFailure;
  constructor(reason: GitHubFailure, message: string) {
    super(message);
    this.name = 'GitHubSignInError';
    this.reason = reason;
  }
}

export function buildGitHubAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Only `select_account` is passed on: GitHub's account picker. */
  prompt?: string | null;
}): string {
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', GITHUB_SCOPE);
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge', opts.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('allow_signup', 'true');
  if (opts.prompt === 'select_account') u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/** Trade the authorization code for an access token. GitHub answers some
 *  failures (a stale or reused code) with HTTP 200 and an `error` field, so
 *  both the status and the body are checked. */
export async function exchangeGitHubCode(opts: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: body.toString(),
    });
  } catch {
    throw new GitHubSignInError('token', 'GitHub could not be reached to finish sign-in');
  }
  if (!res.ok) throw new GitHubSignInError('token', `GitHub token exchange failed: ${res.status}`);
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
  if (!json || typeof json.error === 'string') {
    // The error code is a fixed vocabulary (bad_verification_code and so on),
    // safe to keep in the message for the operator; the description is not kept.
    const code = json && typeof json.error === 'string' && /^[a-z_]{1,64}$/.test(json.error) ? json.error : 'invalid_response';
    throw new GitHubSignInError('token', `GitHub token exchange refused: ${code}`);
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new GitHubSignInError('token', 'GitHub returned no access token');
  }
  return json.access_token;
}

interface GitHubUser {
  id?: unknown;
  login?: unknown;
  name?: unknown;
  email?: unknown;
}

interface GitHubEmail {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

async function apiGet(path: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${GITHUB_API_URL}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
      },
    });
  } catch {
    throw new GitHubSignInError('profile', `GitHub could not be reached for ${path}`);
  }
  if (!res.ok) throw new GitHubSignInError('profile', `GitHub ${path} failed: ${res.status}`);
  return res.json().catch(() => {
    throw new GitHubSignInError('profile', `GitHub ${path} returned a body that is not JSON`);
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Map the two API answers onto an identity. Pure, so the tests can pin the
 *  email rule without a server. */
export function mapGitHubUser(user: unknown, emails: unknown): MappedIdentity {
  const u = (user && typeof user === 'object' ? user : {}) as GitHubUser;
  const id = typeof u.id === 'number' && Number.isSafeInteger(u.id) && u.id > 0
    ? String(u.id)
    : typeof u.id === 'string' && /^[1-9]\d{0,19}$/.test(u.id) ? u.id : undefined;
  if (!id) throw new GitHubSignInError('profile', 'GitHub returned no numeric user id');

  const list = (Array.isArray(emails) ? emails : []).filter((e): e is GitHubEmail => !!e && typeof e === 'object')
    .map((e) => ({ email: str(e.email), primary: e.primary === true, verified: e.verified === true }))
    .filter((e): e is { email: string; primary: boolean; verified: boolean } => !!e.email && e.email.includes('@'));
  const primary = list.find((e) => e.primary);
  // GitHub's commit address (`<id>+<login>@users.noreply.github.com`) is
  // listed as verified but reaches no mailbox, so it is the last choice.
  const noreply = (e: { email: string }) => /@users\.noreply\.github\.com$/i.test(e.email);
  const verified = primary?.verified ? primary
    : list.find((e) => e.verified && !noreply(e)) ?? list.find((e) => e.verified);
  // No verified address: refuse. GitHub lets anyone add any address to an
  // account without proving it, and the rest of the server treats a user's
  // stored email as a mailbox its holder controls (project invites, the
  // disabled sweep, admission re-checks), so an unproven address must never
  // become one, not even on an open instance.
  if (!verified) throw new GitHubSignInError('no-email', 'GitHub returned no verified email address for this account');

  const identity: MappedIdentity = { sub: id, email: verified.email, groups: [], emailVerified: true };
  const own = verified.email.toLowerCase();
  const others = [...new Set(list.filter((e) => e.verified && !noreply(e)).map((e) => e.email.toLowerCase()))]
    .filter((e) => e !== own).slice(0, INVITATION_EMAILS_MAX);
  if (others.length) identity.invitationEmails = others;
  const full = str(u.name) ?? str(u.login);
  if (full) {
    const space = full.indexOf(' ');
    if (space > 0) {
      identity.firstname = full.slice(0, space);
      const rest = full.slice(space + 1).trim();
      if (rest) identity.lastname = rest;
    } else {
      identity.firstname = full;
    }
  }
  return identity;
}

/** Read the signed-in person from the API with a fresh access token. */
export async function fetchGitHubIdentity(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<MappedIdentity> {
  const user = await apiGet('/user', accessToken, fetchImpl);
  const emails = await apiGet('/user/emails', accessToken, fetchImpl);
  return mapGitHubUser(user, emails);
}
