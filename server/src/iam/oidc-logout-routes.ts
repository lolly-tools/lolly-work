// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage } from 'node:http';
import { readRaw, sendError, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { esc } from './activate-page.ts';
import { discover, fetchJwks, kidOf, type OidcPolicy } from './oidc.ts';
import { verifyLogoutToken } from './oidc-logout.ts';
import { clearCookie, SESSION_COOKIE, GUEST_COOKIE, parseCookies, readMemberSession } from './sessions.ts';
import { mintToken, verifyToken } from './tokens.ts';
import { randomId, sha256Hex } from '../lib/crypto.ts';

interface Provider { kind: string; id: string; issuer: string; clientId: string; displayName: string; oidc: OidcPolicy }
export function registerOidcLogout(d: {
  router: ReturnType<typeof createRouter>; store: Store; fetchImpl: typeof fetch;
  resolveIdp(id: string): Provider | null; memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  secret: string; keys: readonly string[]; secure: boolean; baseUrl: string;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
}): void {
  const path = '/api/auth/logout-provider';
  const cookieName = 'lw_logout';
  const clear = (): string[] => [clearCookie(SESSION_COOKIE, d.secure), clearCookie(GUEST_COOKIE, d.secure),
    `${cookieName}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0${d.secure ? '; Secure' : ''}`];
  const current = (req: IncomingMessage) => {
    const s = readMemberSession(req.headers.cookie, d.keys)?.user.oidc;
    const p = s ? d.resolveIdp(s.idp) : null;
    return s && p?.kind === 'oidc' && p.issuer === s.issuer && p.clientId === s.clientId ? { s, p } : null;
  };
  d.router.add('GET', path, async (req, res) => {
    const me = await d.memberOf(req), held = current(req);
    if (!me || !held) return sendError(res, 401, 'NO_OIDC_SESSION', 'Sign in with your identity provider first.');
    const doc = await discover(held.p.issuer, d.fetchImpl);
    if (!doc.end_session_endpoint) return sendError(res, 409, 'NO_PROVIDER_LOGOUT', 'This identity provider does not offer sign-out here. You can still sign out of Lolly.');
    const nonce = randomId(24);
    const binding = sha256Hex(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '');
    const token = mintToken('lw/logout', { nonce, binding }, d.secret, 300);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'strict-origin',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'set-cookie': `${cookieName}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=300${d.secure ? '; Secure' : ''}` });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign out of your identity provider</title>
      <style>body{font:1rem/1.5 system-ui;margin:3rem auto;padding:0 1rem;max-width:32rem;color-scheme:light dark}button,a{font:inherit;display:inline-block;padding:.75rem}</style>
      <main><h1>Sign out of ${esc(held.p.displayName || 'your identity provider')}?</h1><p>This also signs you out of Lolly and may affect other apps using this identity provider.</p>
      <form method="post" action="${path}"><input type="hidden" name="nonce" value="${esc(nonce)}"><button>Sign out of identity provider</button><a href="/">Cancel</a></form></main></html>`);
  });
  d.router.add('POST', path, async (req, res) => {
    const me = await d.memberOf(req), held = current(req);
    if (!me || !held) return sendError(res, 401, 'NO_OIDC_SESSION', 'Sign in with your identity provider first.');
    const cookies = parseCookies(req.headers.cookie);
    const form = new URLSearchParams((await readRaw(req, 4096)).toString('utf8'));
    const box = verifyToken<{ nonce: string; binding: string }>('lw/logout', cookies[cookieName] ?? '', d.keys);
    if (!box || form.get('nonce') !== box.nonce || box.binding !== sha256Hex(cookies[SESSION_COOKIE] ?? '')) return sendError(res, 403, 'BAD_STATE', 'Open the sign-out page again.');
    const doc = await discover(held.p.issuer, d.fetchImpl);
    if (!doc.end_session_endpoint) return sendError(res, 409, 'NO_PROVIDER_LOGOUT', 'This identity provider does not offer sign-out here.');
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('client_id', held.p.clientId);
    url.searchParams.set('logout_hint', held.s.subject);
    url.searchParams.set('post_logout_redirect_uri', new URL('/', d.baseUrl).href);
    await d.audit(`user:${me.id}`, 'auth.logout-provider', 'session', { idp: held.p.id });
    res.writeHead(303, { location: url.href, 'set-cookie': clear(), 'cache-control': 'no-store' });
    res.end();
  });
  d.router.add('POST', '/api/auth/backchannel-logout/:idp', async (req, res, ctx) => {
    const idp = d.resolveIdp(ctx.params.idp!);
    if (!idp || idp.kind !== 'oidc') return sendError(res, 404, 'NO_IDP', 'Unknown identity provider.');
    let token: string;
    try {
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new Error('expected form');
      const form = new URLSearchParams((await readRaw(req, 32 * 1024)).toString('utf8'));
      const value = form.get('logout_token');
      if (!value || form.getAll('logout_token').length !== 1) throw new Error('expected logout token');
      token = value;
    } catch {
      return sendError(res, 400, 'INVALID_LOGOUT_TOKEN', 'The logout token was refused.');
    }
    let jwks;
    try {
      const doc = await discover(idp.issuer, d.fetchImpl);
      jwks = await fetchJwks(doc.jwks_uri, d.fetchImpl, kidOf(token));
    } catch {
      return sendError(res, 503, 'IDP_UNAVAILABLE', 'Identity provider verification is unavailable. Retry later.');
    }
    let event;
    try {
      event = await verifyLogoutToken(token, jwks, { ...idp.oidc, issuer: idp.issuer, clientId: idp.clientId });
    } catch {
      return sendError(res, 400, 'INVALID_LOGOUT_TOKEN', 'The logout token was refused.');
    }
    // The database commits replay protection and revocation together. A store failure
    // remains a server error so the provider can retry; it is not an invalid token.
    if (await d.store.recordOidcLogout(event)) await d.audit('identity-provider', 'auth.backchannel-logout', 'session', { idp: idp.id });
    res.writeHead(200, { 'cache-control': 'no-store' }); res.end();
  });
}
