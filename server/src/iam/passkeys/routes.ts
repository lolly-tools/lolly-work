// SPDX-License-Identifier: MPL-2.0
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { createRouter, readJson, sendError, sendJson } from '../../api/router.ts';
import type { Store, UserRecord } from '../../store/types.ts';
import { randomId, sha256Hex } from '../../lib/crypto.ts';
import { mintToken, verifyToken } from '../tokens.ts';
import { clearCookie, cookieValue, mintSessionCookie, parseCookies, readPrincipal } from '../sessions.ts';
import { displayName } from '../member.ts';
import { esc, serverPage } from '../activate-page.ts';
import { PASSKEY_CLIENT } from './client.ts';
import type { PasskeyChallenge } from './types.ts';

const COOKIE = 'lw_passkey', TTL = 300, RECENT = 10 * 60 * 1000;
export function passkeysEnabled(base: string): boolean {
  const url = new URL(base); return !isIP(url.hostname.replace(/^\[|\]$/g, '')) && (url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'localhost');
}
export const safePasskeyReturn = (value: unknown): string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f]/.test(value) ? value : '/';
interface Dependencies {
  store: Store; baseUrl: string; instanceName: string; secret: string; verifySecrets: readonly string[];
  sessionTtlSec: number; memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
}
export function registerPasskeyRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  if (!passkeysEnabled(d.baseUrl)) return;
  const origin = new URL(d.baseUrl).origin, rpID = new URL(d.baseUrl).hostname, secure = origin.startsWith('https:');
  const recent = async (req: IncomingMessage) => {
    const u = await d.memberOf(req), principal = readPrincipal(req.headers.cookie, d.verifySecrets);
    const at = principal?.kind === 'member' ? principal.user.authenticatedAt : undefined;
    return u && typeof at === 'number' && at <= Date.now() && at > Date.now() - RECENT ? u : null;
  };
  const sameOrigin = (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin === origin && !['cross-site','same-site'].includes(String(req.headers['sec-fetch-site']))) return true;
    sendError(res, 403, 'ORIGIN_REQUIRED', 'Start this request from this workspace.'); return false;
  };
  async function start(res: ServerResponse, record: Omit<PasskeyChallenge, 'id' | 'nonceHash' | 'expiresAt'>, options: unknown) {
    const nonce = randomId(32), id = randomId(24);
    if (!await d.store.putPasskeyChallenge({ ...record, id, nonceHash: sha256Hex(nonce), expiresAt: new Date(Date.now() + TTL * 1000).toISOString() })) return sendError(res, 503, 'TRY_LATER', 'Sign-in is busy. Try again shortly.');
    res.setHeader('set-cookie', cookieValue(COOKIE, mintToken('lw/passkey', { id, nonce }, d.secret, TTL), { secure, maxAgeSec: TTL }).replace('SameSite=Lax','SameSite=Strict'));
    sendJson(res, 200, { options }, { 'cache-control': 'no-store' });
  }
  async function consume(req: IncomingMessage, res: ServerResponse, kind: PasskeyChallenge['kind']) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const box = token ? verifyToken<{ id: string; nonce: string }>('lw/passkey', token, d.verifySecrets) : null;
    res.setHeader('set-cookie', clearCookie(COOKIE, secure));
    const r = box && typeof box.id === 'string' && typeof box.nonce === 'string' ? await d.store.consumePasskeyChallenge(box.id, sha256Hex(box.nonce)) : null;
    if (!r || r.kind !== kind) { sendError(res, 400, 'PASSKEY_EXPIRED', 'This request expired or was used. Try again.'); return null; }
    return r;
  }
  const pageHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'", 'referrer-policy': 'same-origin' };
  function html(res: ServerResponse, body: string, heading: string) {
    res.writeHead(200, pageHeaders);
    res.end(serverPage(d.instanceName, body + '<script src="/api/auth/passkeys/client.js" defer></script>', heading));
  }
  router.add('GET', '/api/auth/passkeys/client.js', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(PASSKEY_CLIENT);
  });
  router.add('GET', '/api/auth/passkeys/login', (_req, res, ctx) => {
    const returnTo = safePasskeyReturn(ctx.url.searchParams.get('returnTo'));
    html(res, `<div class="card" data-passkey-return="${esc(returnTo)}"><p>Use a passkey you added to your account on ${esc(d.instanceName)}.</p>
      <button class="primary" type="button" data-passkey-action="authenticate" hidden>Sign in with a passkey</button>
      <p data-passkey-status role="status" aria-live="polite"></p><p><a href="/api/auth/login?returnTo=${encodeURIComponent(returnTo)}">Other ways to sign in</a></p>
      <noscript><p>Passkeys need JavaScript. You can still use another sign-in method.</p></noscript></div>`, 'Sign in with a passkey');
  });
  router.add('GET', '/api/auth/security', async (req, res) => {
    const u = await d.memberOf(req); if (!u) { res.writeHead(302, { location: '/api/auth/login?returnTo=%2Fapi%2Fauth%2Fsecurity' }); res.end(); return; }
    const fresh = await recent(req), keys = await d.store.listPasskeys(u.id);
    const rows = keys.map(k => `<li style="margin:16px 0;overflow-wrap:anywhere"><strong>${esc(k.label)}</strong><p class="muted">Added ${esc(k.createdAt.slice(0,10))}${k.lastUsedAt ? ' · Last used '+esc(k.lastUsedAt.slice(0,10)) : ''}</p>${fresh ? `<button type="button" data-passkey-action="remove" data-passkey-id="${esc(k.id)}">Remove ${esc(k.label)}</button>` : ''}</li>`).join('');
    html(res, `<div class="card"><p>Passkeys use your device's screen lock, fingerprint, face or security key. Your private key stays with your passkey provider.</p>
      ${fresh ? '<label class="field" for="passkey-label">Passkey name</label><input class="field" id="passkey-label" autocomplete="off" maxlength="80" value="My passkey"><div class="row"><button class="primary" type="button" data-passkey-action="register" hidden>Add a passkey</button></div>' : '<p>Sign in again to add or remove a passkey.</p><p><a href="/api/auth/login?prompt=login&amp;returnTo=%2Fapi%2Fauth%2Fsecurity">Sign in to manage passkeys</a></p>'}
      <p data-passkey-status role="status" aria-live="polite"></p>${rows ? '<ul style="padding-inline-start:20px">'+rows+'</ul>' : '<p>No passkeys added yet.</p>'}<p><a href="/">Back to Lolly</a></p></div>`, 'Account security');
  });
  router.add('POST', '/api/auth/passkeys/register/options', async (req, res) => {
    if (!sameOrigin(req,res)) return;
    const u = await recent(req); if (!u) return sendError(res, 401, 'REAUTH_REQUIRED', 'Sign in again to add a passkey.');
    const keys = await d.store.listPasskeys(u.id); if (keys.length >= 10) return sendError(res, 409, 'PASSKEY_LIMIT', 'Remove a passkey before adding another.');
    const options = await generateRegistrationOptions({ rpName: d.instanceName, rpID, userID: new Uint8Array(Buffer.from(u.id)), userName: u.email, userDisplayName: displayName(u),
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, supportedAlgorithmIDs: [-7,-257], excludeCredentials: keys.map(k => ({ id: k.id, transports: k.transports })) });
    await start(res, { challenge: options.challenge, kind: 'register', userId: u.id, epoch: u.sessionEpoch, returnTo: '/api/auth/security' }, options);
  });
  router.add('POST', '/api/auth/passkeys/register/verify', async (req, res) => {
    if (!sameOrigin(req,res)) return;
    const u = await recent(req), r = await consume(req,res,'register'); if (!r) return;
    if (!u || r.userId !== u.id || r.epoch !== u.sessionEpoch) return sendError(res, 401, 'REAUTH_REQUIRED', 'Sign in again to add a passkey.');
    const body = await readJson(req,64*1024) as { response?: RegistrationResponseJSON; label?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!body?.response || !label || label.length>80 || /[\u0000-\u001f]/.test(label)) return sendError(res,400,'INVALID_INPUT','Enter a passkey name of up to 80 characters.');
    try {
      const result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: r.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7,-257] });
      if (!result.verified || !result.registrationInfo.userVerified || result.registrationInfo.credential.id.length>1024 || result.registrationInfo.credential.publicKey.byteLength>6144) throw new Error('Unverified registration');
      const info = result.registrationInfo, k = info.credential;
      if (!await d.store.registerPasskey({ id:k.id,userId:u.id,publicKey:Buffer.from(k.publicKey).toString('base64url'),counter:k.counter,transports:(k.transports ?? []).filter(t => ['usb','nfc','ble','internal','hybrid'].includes(t)),label,backedUp:info.credentialBackedUp,deviceType:info.credentialDeviceType,createdAt:new Date().toISOString() },u.sessionEpoch)) return sendError(res,409,'PASSKEY_CHANGED','This passkey could not be added. Refresh and try again.');
      await d.audit(`user:${u.id}`,'auth.passkey.add',`user:${u.id}`); sendJson(res,201,{ok:true},{'cache-control':'no-store'});
    } catch { sendError(res,400,'PASSKEY_REFUSED','This passkey could not be verified. Try again or use another sign-in method.'); }
  });
  router.add('POST', '/api/auth/passkeys/authenticate/options', async (req,res) => {
    if (!sameOrigin(req,res)) return;
    const body = await readJson(req,4096) as { returnTo?: unknown } | null;
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    await start(res,{challenge:options.challenge,kind:'authenticate',returnTo:safePasskeyReturn(body?.returnTo)},options);
  });
  router.add('POST', '/api/auth/passkeys/authenticate/verify', async (req,res) => {
    if (!sameOrigin(req,res)) return;
    const r = await consume(req,res,'authenticate'); if (!r) return;
    const body = await readJson(req,64*1024) as { response?: AuthenticationResponseJSON } | null;
    const response = body?.response;
    const refused = () => sendError(res,400,'PASSKEY_REFUSED','This passkey could not sign you in. Try again or use another sign-in method.');
    if (!response || typeof response.id !== 'string' || response.id.length>1024) return refused();
    const k = await d.store.getPasskey(response.id), u = k ? await d.store.getUser(k.userId) : null;
    if (!k || !u || u.disabledAt || response.response?.userHandle !== Buffer.from(u.id).toString('base64url')) return refused();
    try {
      const result = await verifyAuthenticationResponse({ response, expectedChallenge:r.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,
        credential:{id:k.id,publicKey:new Uint8Array(Buffer.from(k.publicKey,'base64url')),counter:k.counter,transports:k.transports as ('usb'|'nfc'|'ble'|'internal'|'hybrid')[]} });
      if (!result.verified || !result.authenticationInfo.userVerified || !await d.store.advancePasskey(k,result.authenticationInfo.newCounter,result.authenticationInfo.credentialBackedUp,u.sessionEpoch)) return refused();
      const fresh = await d.store.getUser(u.id); if (!fresh || fresh.disabledAt || fresh.sessionEpoch !== u.sessionEpoch) return refused();
      const cookie = mintSessionCookie({sub:fresh.sub,email:fresh.email,name:displayName(fresh),groups:fresh.groups,role:fresh.role,epoch:fresh.sessionEpoch,authenticatedAt:Date.now()},d.secret,secure,d.sessionTtlSec);
      res.setHeader('set-cookie',[clearCookie(COOKIE,secure),cookie]); await d.audit(`user:${u.id}`,'auth.login','session',{provider:'passkey'});
      sendJson(res,200,{ok:true,returnTo:r.returnTo},{'cache-control':'no-store'});
    } catch { refused(); }
  });
  router.add('POST','/api/auth/passkeys/:id/remove',async(req,res,ctx) => {
    if (!sameOrigin(req,res)) return;
    const u = await recent(req); if (!u) return sendError(res,401,'REAUTH_REQUIRED','Sign in again to remove a passkey.');
    if (!await d.store.removePasskey(ctx.params.id!,u.id,u.sessionEpoch)) return sendError(res,404,'NOT_FOUND','This passkey is no longer on your account.');
    await d.audit(`user:${u.id}`,'auth.passkey.remove',`user:${u.id}`); sendJson(res,200,{ok:true},{'cache-control':'no-store'});
  });
}
