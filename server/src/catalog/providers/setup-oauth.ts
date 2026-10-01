// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage } from 'node:http';
import type { Store, UserRecord } from '../../store/types.ts';
import { canonicalJson, openSecret, randomId, sealSecret, secretFingerprint, sha256Hex } from '../../lib/crypto.ts';
import { pkcePair } from '../../iam/oidc.ts';
import { SESSION_COOKIE } from '../../iam/sessions.ts';
import { readJson, sendError, sendJson, type createRouter } from '../../api/router.ts';
import { credentialContext } from '../federation.ts';
import { invalidateAccessTokens } from './oauth.ts';
import { previewGuidedProvider } from './setup-preview.ts';
import { validateGuidedProvider } from './setup.ts';
import type { ProviderRecord } from './types.ts';

const CALLBACK = '/api/auth/provider-oauth/callback';
const COOKIE = 'lw_provider_oauth';
const COOKIE_PATH = '/api/auth/provider-oauth';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PROVIDER_OAUTH_LIMITS = { ttlMs: 600000, timeoutMs: 20000, responseBytes: 65536 };

/** Configuration and credential identity, excluding unrelated sync timestamps. */
export function providerSetupRevision(rec: ProviderRecord): string {
  return sha256Hex(canonicalJson({ id: rec.id, kind: rec.kind, label: rec.label, managedBy: rec.managedBy, enabled: rec.enabled,
    options: rec.options, mapping: rec.mapping, exposure: rec.exposure, sync: rec.sync, credential: rec.credentialFingerprint ?? null }));
}

export function providerOAuthInfo(baseUrl: string) {
  try {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash || !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error();
    return { available: true, redirectUri: new URL(CALLBACK, base).href, scope: SCOPE };
  } catch { return { available: false, reason: 'Browser consent requires an HTTPS instance URL (loopback HTTP is accepted for evaluation).' }; }
}

interface ConsentState {
  userId: string; sessionHash: string; providerId: string; revision: string;
  clientId: string; clientSecret: string; redirectUri: string; state: string; verifier: string; expiresAt: number;
}
const sessionHash = (req: IncomingMessage) => {
  const session = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  return session ? sha256Hex(session) : null;
};

/** Fixed-host exchanges with one deadline and bounded JSON, including mocks
 *  whose fetch implementation does not honour AbortSignal. */
async function exchangeAndCheck(state: ConsentState, code: string, rec: ProviderRecord, fetchImpl: typeof fetch) {
  const controller = new AbortController(), { signal } = controller;
  const timeout = setTimeout(() => controller.abort(new Error('OAuth request timed out')), PROVIDER_OAUTH_LIMITS.timeoutMs);
  const work = async () => {
    const json = async (url: string, init: RequestInit) => {
      signal.throwIfAborted();
      const response = await fetchImpl(url, { ...init, signal, redirect: 'error' });
      signal.throwIfAborted();
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('OAuth request refused'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > PROVIDER_OAUTH_LIMITS.responseBytes) throw new Error('OAuth response too large');
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    const token = await json(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: state.redirectUri, client_id: state.clientId,
      client_secret: state.clientSecret, code_verifier: state.verifier,
    }).toString() });
    const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20]/.test(value);
    if (!validToken(token.refresh_token) || !validToken(token.access_token) || typeof token.scope !== 'string' || !token.scope.split(' ').includes(SCOPE)) throw new Error('Offline read-only Drive consent missing');
    signal.throwIfAborted();
    const folder = await json(`https://www.googleapis.com/drive/v3/files/${rec.options.folderId}?fields=id,mimeType&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token.access_token}` } });
    if (folder.id !== rec.options.folderId || folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Folder unavailable');
    return JSON.stringify({ clientId: state.clientId, clientSecret: state.clientSecret, refreshToken: token.refresh_token });
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void work().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  } finally { clearTimeout(timeout); controller.abort(); }
}

export function registerProviderOAuth(router: ReturnType<typeof createRouter>, deps: {
  store: Store; baseUrl: string; credentialSecret?: string; fetchImpl?: typeof fetch;
  owner: (req: IncomingMessage) => Promise<UserRecord | null>;
  manager: (req: IncomingMessage) => Promise<UserRecord | null>;
  ready: Promise<unknown>; invalidate: (id: string) => void;
  audit: (actor: string, action: string, subject: string, facts?: Record<string, unknown>) => Promise<unknown>;
}) {
  const info = providerOAuthInfo(deps.baseUrl), secure = deps.baseUrl.startsWith('https:');
  const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const context = `catalog-provider-oauth-state:v1:${info.available ? new URL(info.redirectUri!).origin : 'unavailable'}`;
  const getGuided = async (id: string) => {
    await deps.ready;
    const rec = await deps.store.getProvider(id);
    return rec?.managedBy === 'db' && rec.kind === 'gdrive' && !validateGuidedProvider(rec) ? rec : null;
  };

  router.add('POST', '/api/v1/catalog/providers/:id/oauth/start', async (req, res, ctx) => {
    const user = await deps.owner(req), binding = sessionHash(req);
    if (!user || !binding) return sendError(res, 403, 'FORBIDDEN', 'An owner browser session is required for provider consent.');
    if (!deps.credentialSecret || !info.available) return sendError(res, 409, 'SETUP_REQUIRED', info.reason ?? 'Set LW_CREDENTIAL_SECRET and restart before connecting.');
    const rec = await getGuided(ctx.params.id!);
    if (!rec || rec.id.length > 100) return sendError(res, 409, 'INVALID_PROVIDER', 'Browser consent requires a DB-managed Google Drive source with guided settings and an id of at most 100 characters.');
    if (rec.enabled) return sendError(res, 409, 'PROVIDER_ENABLED', 'Disable this source before reconnecting.');
    const body = await readJson(req, 4096) as { clientId?: unknown; clientSecret?: unknown } | null;
    if (typeof body?.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,180}\.apps\.googleusercontent\.com$/.test(body.clientId) || typeof body.clientSecret !== 'string' || !body.clientSecret || body.clientSecret.length > 512 || /[\x00-\x20]/.test(body.clientSecret)) return sendError(res, 400, 'INVALID_INPUT', 'Enter the Google web application client id and client secret.');
    const { verifier, challenge } = pkcePair();
    const state: ConsentState = { userId: user.id, sessionHash: binding, providerId: rec.id, revision: providerSetupRevision(rec),
      clientId: body.clientId, clientSecret: body.clientSecret, redirectUri: info.redirectUri!, state: randomId(32), verifier, expiresAt: Date.now() + PROVIDER_OAUTH_LIMITS.ttlMs };
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: state.clientId, redirect_uri: state.redirectUri, response_type: 'code',
      scope: SCOPE, access_type: 'offline', prompt: 'consent', state: state.state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    await deps.audit(`user:${user.id}`, 'catalog.provider.oauth.start', `provider:${rec.id}`);
    sendJson(res, 200, { authorizeUrl: url.href }, { 'cache-control': 'no-store', 'set-cookie': cookie(sealSecret(JSON.stringify(state), deps.credentialSecret, context).toString('base64url'), 600) });
  });

  router.add('GET', CALLBACK, async (req, res, ctx) => {
    let state: ConsentState | undefined;
    const finish = (outcome: string) => {
      const params = new URLSearchParams({ oauth: outcome });
      if (state) params.set('setup', state.providerId);
      res.writeHead(303, { location: `/admin#/providers?${params}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie('', 0) });
      res.end();
    };
    try {
      const raw = /(?:^|;\s*)lw_provider_oauth=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (!raw || raw.length > 4096 || !deps.credentialSecret || !info.available) return finish('failed');
      const parsed = JSON.parse(openSecret(Buffer.from(raw, 'base64url'), deps.credentialSecret, context)) as ConsentState;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed.providerId) || parsed.redirectUri !== info.redirectUri || parsed.state !== ctx.url.searchParams.get('state')) return finish('failed');
      state = parsed;
      if (state.expiresAt <= Date.now()) return finish('expired');
      const user = await deps.owner(req);
      if (!user || user.id !== state.userId || sessionHash(req) !== state.sessionHash) return finish('failed');
      const rec = await getGuided(state.providerId);
      if (!rec || rec.enabled || providerSetupRevision(rec) !== state.revision) return finish('changed');
      if (ctx.url.searchParams.has('error')) return finish('denied');
      const code = ctx.url.searchParams.get('code');
      if (!code || code.length > 8192 || /[\x00-\x20]/.test(code)) return finish('failed');
      const secret = await exchangeAndCheck(state, code, rec, deps.fetchImpl ?? fetch);
      // Consent is an external wait. Re-check current authority and settings
      // before replacing a credential that may have changed in another tab.
      const currentUser = await deps.owner(req), current = await getGuided(rec.id);
      if (!currentUser || currentUser.id !== user.id || !current || providerSetupRevision(current) !== state.revision) return finish('changed');
      const fingerprint = secretFingerprint(secret);
      await deps.store.putProviderCredential(rec.id, { ciphertext: sealSecret(secret, deps.credentialSecret, credentialContext(rec.id)), fingerprint, updatedAt: new Date().toISOString() });
      deps.invalidate(rec.id); invalidateAccessTokens(rec.id);
      await deps.audit(`user:${user.id}`, 'catalog.provider.credential', `provider:${rec.id}`, { fingerprint, rotatedFrom: rec.credentialFingerprint ?? null, via: 'browser-oauth' });
      finish('connected');
    } catch { finish('failed'); } // Never reflect Google's errors, codes or tokens.
  });

  router.add('POST', '/api/v1/catalog/providers/:id/setup-preview', async (req, res, ctx) => {
    const user = await deps.manager(req);
    if (!user) return sendError(res, 403, 'FORBIDDEN', 'catalog.provider.manage required');
    const rec = await getGuided(ctx.params.id!);
    if (!rec || !rec.credentialCiphertext || !deps.credentialSecret) return sendError(res, 409, 'SETUP_REQUIRED', 'Connect a guided Google Drive source before testing.');
    const secret = openSecret(rec.credentialCiphertext, deps.credentialSecret, credentialContext(rec.id));
    invalidateAccessTokens(rec.id);
    const result = await previewGuidedProvider(rec, secret, deps.fetchImpl);
    await deps.audit(`user:${user.id}`, 'catalog.provider.preview', `provider:${rec.id}`, { storedCredential: true });
    sendJson(res, 200, { ...result, revision: providerSetupRevision(rec) }, { 'cache-control': 'no-store' });
  });
}
