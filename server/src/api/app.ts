/**
 * The lolly-work HTTP app - auth, org-config, telemetry, inbox, links,
 * catalog serving, fleet. Plain (req, res) handler (see router.ts) so it
 * runs under node:http, a container, or a Vercel function unchanged.
 *
 * Render routes are stubbed 501 until the fourth-shell render plane lands - 
 * the cache-key/link contracts they'll honour are already fixed
 * (render/cache-key.ts, links/sign.ts).
 */
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { InstanceConfig, Secrets } from '../config/instance.ts';
import type { ProjectRecord, ScimTokenRecord, SessionRecord, Store, UserRecord } from '../store/types.ts';
import type { RoomSnapshot } from '../collab/rooms.ts';
import type { NearbyRegistry } from '../collab/nearby.ts';
import { createRouter, readJson, readRaw, sendError, sendJson, type RouteCtx } from './router.ts';
import { readShotCred } from './shot-provenance.ts';
import { mintToken, verifyToken } from '../iam/tokens.ts';
import {
  GUEST_COOKIE, SESSION_COOKIE, clearCookie, guestActor, mintGuestCookie, mintSessionCookie, readPrincipal,
  type Principal, type SessionUser,
} from '../iam/sessions.ts';
import { buildAuthorizeUrl, discover, exchangeCode, mapClaims, pkcePair, verifyIdToken } from '../iam/oidc.ts';
import { displayName, resolveMember } from '../iam/member.ts';
import { normalizeUserCode, type DeviceAuthRegistry } from '../iam/device-auth.ts';
import { activateDoneHtml, activateFormHtml, activateSignedOutHtml } from '../iam/activate-page.ts';
import { bearerFromHeader, hashScimSecret, mintScimSecret } from '../scim/tokens.ts';
import {
  applyMemberOps, groupToScim, parseGroupPatch, parseScimFilter, parseUserCreate, parseUserPatch,
  scimErrorBody, scimList, userToScim,
} from '../scim/resources.ts';
import { evaluate, grantDecision, denialCode, mayEditCollab, ownerOnlyAction, roleFromGroups, type Grant, type Role, ROLES } from '../rbac/evaluate.ts';
import { canSeeProject } from '../rbac/project-access.ts';
import {
  buildInviteMessage, eligibleInvitees, mayJoinSession, normalizeQuery, sessionLabel,
  INVITEE_LIMIT, MAX_LABEL_CHARS,
} from '../collab/invites.ts';
import { filterToolIndex, normalizeOverlay, toolVisibleTo } from '../policy/overlay.ts';
import {
  applyLifecycleToIndex, assetState, buildPathMap, combinedState, entryWindow,
  type AssetFormatEntry, type AssetIndex, type AssetIndexEntry, type AssetState, type LifecycleRow,
} from '../catalog/lifecycle.ts';
import { buildFragment, callerSeesProvider, createFederation, credentialContext, mapProviderAsset, passesExposure } from '../catalog/federation.ts';
import { providerDrift } from '../catalog/drift.ts';
import { applyCredentialsToIndex, detectCredential, type CredentialRow } from '../catalog/credentials.ts';
import {
  composeInstanceAssets, instanceAssetsFingerprint, instanceAssetVisible, materializedIdFor,
  submissionServable, INST_PREFIX,
  type AssetSubmission, type InstanceAssetRecord,
} from '../catalog/instance-assets.ts';
import {
  applyVersionToRecord, backfillVersionOne, headVersionOf, orphanBlobIds, parseReplacedBy,
  versionsToTrim, versionView, type AssetVersionRecord,
} from '../catalog/versions.ts';
import { listSubmissions, settleSubmission, submitAsset } from '../catalog/submit.ts';
import {
  applyDescriptivePatch, applyFieldPatch, composeAssetMeta, descriptiveTouched, extractedHaystack,
  fieldHaystack, normalizeCatalogField, normalizeExtractedText, parseDescriptivePatch, servedFields,
  type AssetMetaRecord, type DescriptiveKey,
} from '../catalog/asset-meta.ts';
import {
  collectionVisible, composeCollections, normalizeCollection, sortCollections,
  type CollectionRecord,
} from '../catalog/collections.ts';
import { materializeProvider, materializeAsset, cutoverProvider, pinAsset } from '../catalog/materialize.ts';
import { verifyLollyExport, extractProvenance } from '../catalog/publish.ts';
import { listBrandProfiles, switchBrandProfile } from '../brand/profiles.ts';
import { createMemoryBlobStore } from '../blobs/memory.ts';
import type { BlobStore } from '../blobs/types.ts';
import { EXT_PREFIX, extAssetId, PROVIDER_KINDS, type ProviderKind, type ProviderRecord } from '../catalog/providers/types.ts';
import { createProvider } from '../catalog/providers/registry.ts';
import { noDetailShapeLine, noShapeLine, renderShapeReport, type ProviderShapeReport } from '../catalog/providers/shape.ts';
import { invalidateAccessTokens } from '../catalog/providers/oauth.ts';
import { assembleOrgConfig } from '../policy/org-config.ts';
import { renderCapabilities } from '../render/capabilities.ts';
import { flagGovernanceCatalog, normalizeFlagGovernance } from '../policy/feature-flags.ts';
import { validatePublish, factsFor } from '../injectables/registry.ts';
import { KIND_HANDLERS } from '../injectables/kinds.ts';
import { INJECTABLE_KINDS, type InjectableRecord } from '../injectables/types.ts';
import { buildConfigDocument, validateConfigDocument, diffConfigDocument, requiredActions, commitConfigApply, canonicalHash, diffSummary } from '../policy/config-doc.ts';
import { readToolInputs } from '../policy/tool-inputs.ts';
import { checkLink, linkPath, linkResourceSelectors, DEFAULT_TTL_SEC, type LinkKind, type LinkRecord } from '../links/sign.ts';
import { accentFromTokens, collectionPageHtml, isPreviewableFormat, type CollectionPageItem } from '../links/collection-page.ts';
import { safeEntryName, ZipBuilder } from '../links/zip.ts';
import { renderTool, RenderError, invalidateRenderByTool } from '../render/pipeline.ts';
import { resolveC2paSigner } from '../render/c2pa-signer.ts';
import type { ProvenanceDoc, ProvenanceIngredient } from '../render/provenance.ts';
import type { Profile } from '../render/contract.ts';
import { hashPassword, randomId, sealSecret, secretFingerprint, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { demoLandingHtml } from '../lib/demo-landing.ts';
import { sanitizeEvent, summarize, type RawEvent } from '../telemetry/ingest.ts';
import { targetedMessages, type Message } from '../inbox/target.ts';
import { parseClientHeader } from '../fleet/client-header.ts';
import { verifyChain } from '../audit/chain.ts';
import { auditHead } from '../audit/head.ts';
import { createMetrics, statusClass, metricsGate, type Metrics, type GaugeLine } from '../observability/metrics.ts';
import { createRateLimiter, clientIp, rateLimitSurface } from '../observability/rate-limit.ts';
import { buildActivity } from '../activity/feed.ts';
import {
  applyAction, createApproval, currentStep, eligibleForCurrentStep, isEligible, isTerminal, normalizeChain,
  stepOf, validateNominees, withdraw,
  type Approval, type SubjectType,
} from '../approvals/engine.ts';

const STATE_COOKIE = 'lw_state';
const LINK_KINDS: LinkKind[] = ['share', 'embed', 'download', 'guest-edit'];
const SUBJECT_TYPES: SubjectType[] = ['asset', 'tool-change', 'config', 'guest-link'];

/** The vendored engine version, read off engine-pin.json (the manifest the
 *  re-pin cadence maintains). Read once and cached; null when the file is not
 *  beside the process (a bundle that did not copy it) rather than failing a
 *  health-adjacent route. Serves the instance manifest and the fleet drift
 *  line (plans/34 waves 1a + 1d). */
let cachedPinnedEngine: string | null | undefined;
function pinnedEngineVersion(): string | null {
  if (cachedPinnedEngine !== undefined) return cachedPinnedEngine;
  try {
    const fnRoot = (globalThis as { __LW_FN_ROOT?: string }).__LW_FN_ROOT;
    const path = fnRoot
      ? fileURLToPath(new URL('engine-pin.json', fnRoot))
      : fileURLToPath(new URL('../../../engine-pin.json', import.meta.url));
    const pin = JSON.parse(readFileSync(path, 'utf8')) as { engine?: { version?: string } };
    cachedPinnedEngine = pin.engine?.version ?? null;
  } catch {
    cachedPinnedEngine = null;
  }
  return cachedPinnedEngine;
}

export interface AppDeps {
  config: InstanceConfig;
  store: Store;
  secrets: Secrets;
  fetchImpl?: typeof fetch;
  /** Injectable metrics registry (tests pass a fresh one to assert counter deltas). */
  metrics?: Metrics;
  /** Live collab-room snapshot for the admin console's Rooms panel
   *  (`GET /api/v1/collab/rooms`, OSS plans/100 §7, lolly-work plans/14 §6).
   *  A plain function, not a `CollabGateway` import - this module is also
   *  bundled into a Vercel function, and `collab/gateway.ts` pulls in `ws`
   *  (see its own header on why that import stays out of this graph). main.ts
   *  builds the collab gateway BEFORE this app so it can inject
   *  `() => collab.snapshot()`; the Vercel path never wires the gateway at
   *  all, so this stays undefined there and the route just answers `[]`. */
  listCollabRooms?: () => RoomSnapshot[];
  /** Instance-mediated "nearby" registry (plans/26 §8). Like `listCollabRooms`,
   *  this is injected only by the long-lived server (main.ts) and left undefined on
   *  Vercel, where an in-memory presence registry cannot work across function
   *  instances - the routes answer 501 there rather than a misleading partial list. */
  nearby?: NearbyRegistry;
  /** Byte storage for instance-owned catalog assets (plans/26 §2, plans/27 §5).
   *  main.ts builds the configured driver (pg default / s3); tests and the
   *  Vercel path fall back to an in-memory store. */
  blobs?: BlobStore;
  /** Device-code sign-in (plans/34 wave 4). Like `nearby`: an in-memory
   *  registry injected only by the long-lived server - pending codes cannot
   *  span function instances, so the Vercel path leaves this undefined and the
   *  device routes answer 501 rather than a flow that intermittently works. */
  deviceAuth?: DeviceAuthRegistry;
}

export function buildApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, store, secrets, listCollabRooms, nearby, deviceAuth } = deps;
  const blobs = deps.blobs ?? createMemoryBlobStore();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secure = config.instance.baseUrl.startsWith('https:');
  const sessionTtlSec = config.policy.sessionTtlHours * 3600;
  const router = createRouter();
  const metrics = deps.metrics ?? createMetrics();
  const limiter = createRateLimiter(config.rateLimit);
  // The Chromium render worker is active only when both the URL and the shared
  // HMAC key are present; otherwise hooked tools keep 501-ing (unchanged).
  const renderWorker = config.render.worker.url && secrets.renderWorker
    ? { url: config.render.worker.url, secret: secrets.renderWorker, timeoutMs: config.render.worker.timeoutMs }
    : undefined;
  // Advertised to shells via org_config (plans/23 §3.A) - computed HERE, beside
  // the worker resolution, so the advertisement can only ever reflect the same
  // condition that activates the worker.
  const renderCaps = renderCapabilities(!!renderWorker);
  // Resolve the C2PA signer once, lazily (import + key import is async); a
  // misconfiguration surfaces on the first render as a clear error.
  let c2paSignerCache: Awaited<ReturnType<typeof resolveC2paSigner>> | undefined;
  const getC2paSigner = async () => {
    if (c2paSignerCache === undefined) c2paSignerCache = await resolveC2paSigner(config, secrets);
    return c2paSignerCache;
  };
  // Memoize the audit-chain gauge so /metrics never runs verifyChain more than
  // ~once/10s regardless of scrape frequency.
  let auditGauge: { at: number; intact: boolean } | null = null;
  const auditIntact = async (): Promise<boolean> => {
    const now = Date.now();
    if (auditGauge && now - auditGauge.at < 10_000) return auditGauge.intact;
    const intact = verifyChain(await store.listAudit()).ok;
    auditGauge = { at: now, intact };
    return intact;
  };

  const principalOf = (req: IncomingMessage): Principal | null =>
    readPrincipal(req.headers.cookie, secrets.session);

  // Shared with the collab ws gateway (server/src/iam/member.ts), which must
  // authenticate an `upgrade` request with byte-identical semantics - including
  // the disabled-account and pre-epoch-token refusals.
  const memberOf = (req: IncomingMessage): Promise<UserRecord | null> =>
    resolveMember(store, req.headers.cookie, secrets.session);

  const audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) =>
    store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });

  /**
   * The instance-owned half of the render cache key's `catalogVersion`
   * (plans/31 §6). A pack change is seen through the index file's mtime;
   * instance assets are store rows whose BYTES move under a stable id when a
   * version lands or a rollback points the head at an older one, and a render
   * that consumed one would otherwise keep serving from a cache key that never
   * changed.
   *
   * Memoized because renders are frequent and the fingerprint costs a store
   * scan; invalidated by `bustInstanceCatalog` at every write that can move an
   * instance asset's bytes. The value is CONTENT-derived, so a second plane
   * node that recomputes it lands on the same string rather than on a counter
   * of its own.
   */
  let instanceCatalogVersionMemo: string | null = null;
  const instanceCatalogVersion = async (): Promise<string> => {
    if (instanceCatalogVersionMemo === null) {
      instanceCatalogVersionMemo = sha256Hex(instanceAssetsFingerprint(await store.listInstanceAssets())).slice(0, 16);
    }
    return instanceCatalogVersionMemo;
  };
  const bustInstanceCatalog = (): void => {
    instanceCatalogVersionMemo = null;
  };

  // ── catalog providers: federation + config-managed boot upsert (plans/17) ──
  // Config-managed entries name their credential env var; the value lives in
  // this map (process memory) only. Boot upsert is lazy-awaited by every
  // provider-touching path so buildApp itself stays synchronous.
  const configSecrets = new Map<string, string>();
  for (const p of config.catalogProviders) {
    const v = p.credentialRef ? process.env[p.credentialRef] : undefined;
    if (v) configSecrets.set(p.id, v);
  }
  const federation = createFederation({
    store,
    ...(secrets.credential ? { credentialSecret: secrets.credential } : {}),
    configSecrets,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const providersReady: Promise<void> = (async () => {
    const now = new Date().toISOString();
    for (const p of config.catalogProviders) {
      const existing = await store.getProvider(p.id);
      await store.putProvider({
        id: p.id, kind: p.kind, label: p.label, managedBy: 'config',
        enabled: p.enabled ?? false,
        options: p.options ?? {}, mapping: p.mapping ?? {}, exposure: p.exposure ?? {}, sync: p.sync ?? {},
        createdAt: existing?.createdAt ?? now, updatedAt: now,
        state: existing?.state ?? { assetCount: 0 },
      });
    }
  })().catch((err) => {
    console.error('catalog provider config upsert failed:', (err as Error).message);
  });

  const returnToSafe = (raw: string | null): string => {
    if (!raw) return '/';
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    if (raw.startsWith(config.instance.baseUrl)) return raw;
    return '/';
  };

  // ── health + metrics ──────────────────────────────────────────────────────
  router.add('GET', '/healthz', (_req, res) => {
    sendJson(res, 200, {
      ok: true, name: config.instance.name, accessMode: config.policy.defaultAccessMode,
      ...(config.instance.appUrl ? { appUrl: config.instance.appUrl } : {}),
    });
  });

  // Prometheus scrape endpoint (registered before auth so it can't be shadowed).
  // Loopback-only unless LW_METRICS_TOKEN is set. Gauges are collected at scrape.
  router.add('GET', '/metrics', async (req, res) => {
    const gate = metricsGate(req, secrets.metricsToken);
    if (gate === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'no route for GET /metrics');
    if (gate === 'unauthorized') return sendError(res, 401, 'UNAUTHORIZED', 'metrics require a bearer token');
    const gauges: GaugeLine[] = [
      { name: 'lw_audit_chain_intact', help: 'Audit hash-chain verifies end to end (1) or is broken (0).', type: 'gauge', value: (await auditIntact()) ? 1 : 0 },
      { name: 'lw_process_uptime_seconds', help: 'Process uptime in seconds.', type: 'gauge', value: process.uptime() },
      { name: 'lw_process_resident_memory_bytes', help: 'Resident set size in bytes.', type: 'gauge', value: process.memoryUsage().rss },
      { name: 'lw_rate_limit_buckets', help: 'Live per-IP rate-limit buckets in memory.', type: 'gauge', value: limiter.size() },
    ];
    for (const p of await store.listProviders()) {
      gauges.push({ name: 'lw_provider_enabled', help: 'Catalog provider enabled (1) or disabled (0).', type: 'gauge', labels: { provider: p.id, kind: p.kind }, value: p.enabled ? 1 : 0 });
      gauges.push({ name: 'lw_provider_assets', help: 'Assets last synced from a catalog provider.', type: 'gauge', labels: { provider: p.id }, value: p.state?.assetCount ?? 0 });
      gauges.push({ name: 'lw_provider_last_error', help: 'Provider last sync recorded an error (1) or not (0).', type: 'gauge', labels: { provider: p.id }, value: p.state?.lastError ? 1 : 0 });
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(metrics.renderText(gauges));
  });

  // ── auth ──────────────────────────────────────────────────────────────────
  router.add('GET', '/api/auth/config', (_req, res) => {
    sendJson(res, 200, {
      mode: config.policy.defaultAccessMode,
      provider: config.idp.issuer ? 'oidc' : config.dev.enabled ? 'dev' : null,
      providerName: config.idp.displayName || null,
      loginPath: config.idp.issuer ? '/api/auth/login' : config.dev.enabled ? '/api/auth/dev' : null,
      // The public sandbox (dev.enabled) serves the deployment docs to anyone - 
      // the console reads this so an anonymous visitor can land straight on the
      // Docs view (see console/app.js publicMode) instead of the sign-in gate.
      // Mirrors the server-side `docsReadable` gate below, so the two never drift.
      publicDocs: config.dev.enabled,
    });
  });

  // ── instance manifest (plans/34 wave 1a) ──────────────────────────────────
  // The card a fresh app-store shell reads before anyone signs in: what this
  // deployment is, how sign-in works, and what surfaces it serves. A downloaded
  // client owns nothing org-shaped until it connects, so this is deliberately
  // unauthenticated - and deliberately narrow: no secrets, no user data, no
  // policy beyond the access mode that /api/auth/config already states. Rate
  // limited with the auth bucket (see observability/rate-limit.ts).
  router.add('GET', '/api/v1/instance', (_req, res) => {
    sendJson(res, 200, {
      name: config.instance.name,
      accessMode: config.policy.defaultAccessMode,
      provider: config.idp.issuer ? 'oidc' : config.dev.enabled ? 'dev' : null,
      providerName: config.idp.displayName || null,
      loginPath: config.idp.issuer ? '/api/auth/login' : config.dev.enabled ? '/api/auth/dev' : null,
      // The vendored contract version this deploy serves tools against - what a
      // client compares its own engine to, and the fixed point fleet drift is
      // measured from.
      engineVersion: pinnedEngineVersion(),
      // Statically true today; stated so an older deploy (whose manifest lacks
      // a key) and a newer one read differently to the same probe.
      capabilities: { catalog: true, collab: true, submit: true, scim: true },
    });
  });

  router.add('GET', '/api/auth/login', async (_req, res, ctx) => {
    if (!config.idp.issuer) return sendError(res, 404, 'NO_IDP', 'no OIDC issuer configured');
    const disco = await discover(config.idp.issuer, fetchImpl);
    const { verifier, challenge } = pkcePair();
    const nonce = randomId(12);
    const state = randomId(12);
    const stateToken = mintToken('lw/state', { returnTo: returnToSafe(ctx.url.searchParams.get('returnTo')), verifier, nonce, state }, secrets.session, 600);
    const authorize = buildAuthorizeUrl({
      authorizationEndpoint: disco.authorization_endpoint,
      clientId: config.idp.clientId,
      redirectUri: `${config.instance.baseUrl}/api/auth/callback`,
      state, nonce, codeChallenge: challenge,
    });
    res.writeHead(302, {
      location: authorize,
      'set-cookie': `${STATE_COOKIE}=${stateToken}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    });
    res.end();
  });

  router.add('GET', '/api/auth/callback', async (req, res, ctx) => {
    if (!config.idp.issuer) return sendError(res, 404, 'NO_IDP', 'no OIDC issuer configured');
    const cookies = req.headers.cookie ?? '';
    const stateCookie = /(?:^|;\s*)lw_state=([^;]+)/.exec(cookies)?.[1];
    const box = stateCookie
      ? verifyToken<{ returnTo: string; verifier: string; nonce: string; state: string }>('lw/state', stateCookie, secrets.session)
      : null;
    if (!box || box.state !== ctx.url.searchParams.get('state')) {
      return sendError(res, 400, 'BAD_STATE', 'login state missing or mismatched — restart sign-in');
    }
    const code = ctx.url.searchParams.get('code');
    if (!code) return sendError(res, 400, 'NO_CODE', 'IdP returned no authorization code');
    const disco = await discover(config.idp.issuer, fetchImpl);
    const tokens = await exchangeCode({
      tokenEndpoint: disco.token_endpoint,
      code, verifier: box.verifier,
      clientId: config.idp.clientId,
      ...(secrets.idpClientSecret ? { clientSecret: secrets.idpClientSecret } : {}),
      redirectUri: `${config.instance.baseUrl}/api/auth/callback`,
      fetchImpl,
    });
    if (!tokens.id_token) return sendError(res, 502, 'NO_ID_TOKEN', 'IdP returned no id_token');
    const jwks = (await (await fetchImpl(disco.jwks_uri)).json()) as { keys: [] };
    const claims = await verifyIdToken(tokens.id_token, jwks, {
      issuer: disco.issuer, clientId: config.idp.clientId, nonce: box.nonce,
    });
    const identity = mapClaims(claims, config.idp.claimMap, config.idp.groupsClaim);
    const user = await store.upsertUserBySub({ ...identity, role: roleFromGroups(identity.groups) });
    const sessionUser: SessionUser = {
      sub: user.sub, email: user.email, groups: user.groups, role: user.role,
      name: displayName(user), epoch: user.sessionEpoch,
    };
    await audit(`user:${user.id}`, 'auth.login', 'session', { provider: 'oidc' });
    res.writeHead(302, {
      location: box.returnTo,
      'set-cookie': [
        mintSessionCookie(sessionUser, secrets.session, secure, sessionTtlSec),
        `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Max-Age=0`,
      ],
    });
    res.end();
  });

  // Dev provider - secret-free local sign-in, gated hard on config.dev.enabled.
  router.add('GET', '/api/auth/dev', async (_req, res, ctx) => {
    if (!config.dev.enabled) return sendError(res, 404, 'NOT_FOUND', 'dev provider disabled');
    const email = ctx.url.searchParams.get('email') ?? config.dev.users[0]?.email;
    const devUser = config.dev.users.find((u) => u.email === email);
    if (!devUser) return sendError(res, 403, 'UNKNOWN_DEV_USER', 'email not in dev.users');
    const groups = devUser.groups ?? [];
    const user = await store.upsertUserBySub({
      sub: `dev:${devUser.email}`, email: devUser.email, groups,
      role: roleFromGroups(groups),
      ...(devUser.name ? { firstname: devUser.name } : {}),
    });
    const sessionUser: SessionUser = {
      sub: user.sub, email: user.email, groups: user.groups, role: user.role, name: devUser.name ?? user.email,
      epoch: user.sessionEpoch,
    };
    await audit(`user:${user.id}`, 'auth.login', 'session', { provider: 'dev' });
    res.writeHead(302, {
      location: returnToSafe(ctx.url.searchParams.get('returnTo')),
      'set-cookie': mintSessionCookie(sessionUser, secrets.session, secure, sessionTtlSec),
    });
    res.end();
  });

  router.add('GET', '/api/auth/session', async (req, res) => {
    const p = principalOf(req);
    if (!p) return sendError(res, 401, 'UNAUTHORIZED', 'no session');
    if (p.kind === 'guest') {
      return sendJson(res, 200, { kind: 'guest', guest: { name: p.guest.name, inviter: p.guest.inviter, toolId: p.guest.toolId } });
    }
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'session user unknown or disabled');
    return sendJson(res, 200, { kind: 'member', user: { sub: user.sub, email: user.email, groups: user.groups, role: user.role } });
  });

  router.add('POST', '/api/auth/logout', (_req, res) => {
    res.writeHead(204, { 'set-cookie': [clearCookie(SESSION_COOKIE, secure), clearCookie(GUEST_COOKIE, secure)] });
    res.end();
  });

  // ── device-code sign-in (plans/34 wave 4) ─────────────────────────────────
  // RFC 8628's shape with this instance's session as the artifact: a device
  // asks for a code pair, a person already signed in in a browser confirms the
  // short code at /activate, and the device's next poll collects an ordinary
  // session cookie minted for that person. The approving browser session is
  // the whole authority - the flow never touches IdP credentials. Both device
  // routes share the auth rate-limit bucket (poll interval = its refill rate).
  const activateHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Script-free page, same posture as the bearer collection page - except
    // form-action 'self', so the confirm form can submit.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  };
  const loginPathFor = (returnTo: string): string | null =>
    config.idp.issuer ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
      : config.dev.enabled ? `/api/auth/dev?returnTo=${encodeURIComponent(returnTo)}` : null;

  router.add('POST', '/api/v1/auth/device', async (req, res) => {
    if (!deviceAuth) return sendError(res, 501, 'DEVICE_FLOW_UNAVAILABLE', 'device sign-in needs the long-lived server');
    const started = deviceAuth.request(req.headers['x-lolly-client'] as string | undefined);
    if (!started) return sendError(res, 429, 'TOO_MANY_REQUESTS', 'too many pending device codes - try again shortly');
    await audit(`device:${started.userCode}`, 'auth.device.requested', 'session');
    sendJson(res, 200, {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: `${config.instance.baseUrl}/activate`,
      interval: started.interval,
      expiresIn: started.expiresIn,
    });
  });

  router.add('POST', '/api/v1/auth/device/token', async (req, res) => {
    if (!deviceAuth) return sendError(res, 501, 'DEVICE_FLOW_UNAVAILABLE', 'device sign-in needs the long-lived server');
    const body = (await readJson(req)) as { deviceCode?: unknown } | null;
    if (typeof body?.deviceCode !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'deviceCode required');
    const claim = deviceAuth.claim(body.deviceCode);
    if (claim.status !== 'approved') return sendJson(res, 200, { status: claim.status });
    // The approval is minutes old at most, but a disable or session-revoke in
    // between must still win - re-read the person before minting anything.
    const user = await store.getUserBySub(claim.user.sub);
    if (!user || user.disabledAt || user.sessionEpoch > (claim.user.epoch ?? 0)) {
      return sendJson(res, 200, { status: 'denied' });
    }
    await audit(`user:${user.id}`, 'auth.login', 'session', { provider: 'device' });
    const setCookie = mintSessionCookie(claim.user, secrets.session, secure, sessionTtlSec);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookie });
    res.end(JSON.stringify({ status: 'approved', cookie: setCookie.split(';')[0] }));
  });

  // The console's refuse-a-surprise surface: pending codes are listable and
  // deniable by an admin, but NEVER approvable there - approval binds the
  // approver's own identity, so it lives only on /activate with the code typed.
  router.add('GET', '/api/v1/auth/device/pending', async (req, res) => {
    if (!(await requireAction(req, res, 'fleet.view'))) return;
    sendJson(res, 200, { pending: deviceAuth ? deviceAuth.pending() : [] });
  });

  router.add('POST', '/api/v1/auth/device/deny', async (req, res) => {
    const actor = await requireAction(req, res, 'fleet.manage');
    if (!actor) return;
    if (!deviceAuth) return sendError(res, 501, 'DEVICE_FLOW_UNAVAILABLE', 'device sign-in needs the long-lived server');
    const body = (await readJson(req)) as { userCode?: unknown } | null;
    if (typeof body?.userCode !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'userCode required');
    if (!deviceAuth.deny(body.userCode)) return sendError(res, 404, 'NOT_FOUND', 'no such pending code');
    await audit(`user:${actor.id}`, 'auth.device.deny', 'session', { code: normalizeUserCode(body.userCode) });
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/activate', async (req, res, ctx) => {
    const html = await (async () => {
      if (!deviceAuth) return activateDoneHtml(config.instance.name, 'unknown');
      const me = await resolveMember(store, req.headers.cookie, secrets.session);
      if (!me) return activateSignedOutHtml(config.instance.name, loginPathFor('/activate') ?? '/');
      const code = ctx.url.searchParams.get('code') ?? '';
      const pend = code ? deviceAuth.describe(code) : null;
      return activateFormHtml(config.instance.name, {
        ...(code ? { code: normalizeUserCode(code) } : {}),
        ...(pend?.clientTag ? { clientTag: pend.clientTag } : {}),
        ...(pend ? { requestedAt: pend.createdAt } : {}),
      });
    })();
    res.writeHead(200, activateHeaders);
    res.end(html);
  });

  router.add('POST', '/activate', async (req, res) => {
    const render = (html: string): void => { res.writeHead(200, activateHeaders); res.end(html); };
    if (!deviceAuth) return render(activateDoneHtml(config.instance.name, 'unknown'));
    const me = await resolveMember(store, req.headers.cookie, secrets.session);
    if (!me) return render(activateSignedOutHtml(config.instance.name, loginPathFor('/activate') ?? '/'));
    const form = new URLSearchParams(await readRaw(req, 4096).then((b) => b.toString('utf8')).catch(() => ''));
    const code = form.get('code') ?? '';
    const decision = form.get('decision');
    if (!code || (decision !== 'approve' && decision !== 'deny')) {
      return render(activateFormHtml(config.instance.name, { error: 'Enter the code the device shows.' }));
    }
    if (decision === 'deny') {
      const ok = deviceAuth.deny(code);
      if (ok) await audit(`user:${me.id}`, 'auth.device.deny', 'session', { code: normalizeUserCode(code) });
      return render(activateDoneHtml(config.instance.name, ok ? 'denied' : 'unknown'));
    }
    const approved = deviceAuth.approve(code, {
      sub: me.sub, email: me.email, groups: me.groups, role: me.role,
      name: displayName(me), epoch: me.sessionEpoch,
    });
    if (approved) await audit(`user:${me.id}`, 'auth.device.approve', 'session', { code: normalizeUserCode(code) });
    render(activateDoneHtml(config.instance.name, approved ? 'approved' : 'unknown'));
  });

  // ── org-config: the one polled document ───────────────────────────────────
  // Assembled once, here, for BOTH the caller's own poll and the admin
  // preview-as-group tool - so a preview can never drift from what a member
  // actually receives (the projection is the same function, same store reads).
  const buildOrgConfigFor = async (subject: UserRecord) => {
    const overlays = await store.listOverlays();
    const acked = await store.acksFor(subject.id);
    const unread = targetedMessages(await store.listMessages(), { groups: subject.groups, userId: subject.id }, acked).length;
    const grants = await store.listGrants();
    const flagGovernance = await store.listFlagGovernance();
    const injectables = new Map((await store.listInjectables()).map((r) => [r.id, r]));
    const toolInputs = new Map<string, Array<{ id: string }> | null>();
    for (const toolId of overlays.keys()) {
      toolInputs.set(toolId, await readToolInputs(config.instance.pack, toolId));
    }
    return assembleOrgConfig({ config, user: subject, overlays, grants, toolInputs, flagGovernance, injectables, render: renderCaps, inboxUnread: unread });
  };

  router.add('GET', '/api/v1/org-config', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    metrics.orgConfigPoll(); // the fleet heartbeat - counts 200 and 304
    let payload;
    try {
      payload = await buildOrgConfigFor(user);
    } catch (err) {
      metrics.orgConfigError();
      throw err;
    }
    const etag = `"oc-${payload.policyVersion}-${payload.inboxUnread}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    sendJson(res, 200, payload, { etag, 'cache-control': 'private, max-age=60' });
  });

  // Preview-as-group (plans/03): what would a member in these groups receive?
  // A read-only projection - no session minted, nothing stored - gated on
  // policy.edit so the brand/admin team authoring governance can verify it.
  // Role is derived by the SAME roleFromGroups sign-in uses, so previewing
  // `groups=admin` honestly shows admin escalation. The synthetic id can't
  // collide with a real user id, so only group:/`*` grants apply - never some
  // specific person's user: grants (correct for a group projection).
  router.add('GET', '/api/v1/org-config/preview', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'policy.edit'))) return;
    const groups = (ctx.url.searchParams.get('groups') ?? '')
      .split(',').map((g) => g.trim()).filter(Boolean);
    const now = new Date().toISOString();
    const subject: UserRecord = {
      id: '(preview)',
      sub: '(preview)',
      email: 'preview@example',
      firstname: 'Preview',
      lastname: groups.length ? `member of ${groups.join(', ')}` : 'member (no groups)',
      idpGroups: groups,
      localGroups: [],
      groups,
      role: roleFromGroups(groups),
      sessionEpoch: 0,
      createdAt: now,
      lastSeenAt: now,
    };
    const orgConfig = await buildOrgConfigFor(subject);
    // Governed tools this group would NOT see - omitted from the member
    // projection (absent = hidden) but exactly what an admin needs to verify.
    // Grant-aware, matching assembleOrgConfig: a group-level allow surfaces a
    // tool outside the visibility clause; a matching deny hides it outright.
    const overlays = await store.listOverlays();
    const grants = await store.listGrants();
    const previewPrincipal = { userId: subject.id, groups, role: subject.role as Role };
    const hiddenTools = [...overlays.keys()].filter((id) => {
      const decision = grantDecision(previewPrincipal, 'tool.use', [`tool:${id}`, '*'], grants);
      if (decision === 'deny') return true;
      return !(toolVisibleTo(overlays.get(id), groups) || decision === 'allow');
    }).sort();
    sendJson(res, 200, { preview: { groups, role: subject.role, hiddenTools }, orgConfig }, { 'cache-control': 'no-store' });
  });

  // ── telemetry ─────────────────────────────────────────────────────────────
  router.add('POST', '/api/v1/telemetry', async (req, res) => {
    if (config.policy.telemetry === 'off') return sendJson(res, 202, { accepted: 0 });
    const user = await memberOf(req);
    const p = principalOf(req);
    if (!user && p?.kind !== 'guest') return sendError(res, 401, 'UNAUTHORIZED', 'telemetry is session-scoped');
    const body = (await readJson(req)) as { events?: RawEvent[] } | null;
    const raw = Array.isArray(body?.events) ? body.events.slice(0, 500) : [];
    const policy = { level: config.policy.telemetry, attribution: config.policy.telemetryAttribution };
    const userCtx = user ? { id: user.id, ...(user.telemetryConsent !== undefined ? { telemetryConsent: user.telemetryConsent } : {}) } : null;
    const events = raw
      .map((e) => sanitizeEvent(e, policy, userCtx))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    await store.putEvents(events);
    sendJson(res, 202, { accepted: events.length });
  });

  router.add('POST', '/api/v1/telemetry/consent', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req)) as { consent?: boolean } | null;
    await store.setTelemetryConsent(user.id, body?.consent === true);
    await audit(`user:${user.id}`, 'telemetry.consent', 'profile', { consent: body?.consent === true });
    sendJson(res, 200, { consent: body?.consent === true });
  });

  // ── inbox ─────────────────────────────────────────────────────────────────
  router.add('GET', '/api/v1/inbox', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const client = parseClientHeader(req.headers['x-lolly-client'] as string | undefined);
    const acked = await store.acksFor(user.id);
    const msgs = targetedMessages(await store.listMessages(), {
      groups: user.groups,
      userId: user.id,
      ...(client?.shell ? { shell: client.shell } : {}),
      ...(client?.engine ? { engineVersion: client.engine } : {}),
    }, acked);
    sendJson(res, 200, { messages: msgs });
  });

  router.add('POST', '/api/v1/inbox/:id/ack', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    await store.ackMessage(ctx.params.id as string, user.id);
    sendJson(res, 200, { ok: true });
  });

  // ── links ─────────────────────────────────────────────────────────────────
  router.add('POST', '/api/v1/links', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req)) as {
      kind?: LinkKind; target?: LinkRecord['target']; ttlHours?: number; password?: string; projectId?: string;
    } | null;
    const kind = body?.kind;
    if (!kind || !LINK_KINDS.includes(kind)) return sendError(res, 400, 'INVALID_INPUT', 'kind must be share|embed|download|guest-edit');
    if (!body?.target || (!body.target.toolId && !body.target.sessionId && !body.target.assetId && !body.target.collectionId)) {
      return sendError(res, 400, 'INVALID_INPUT', 'target.toolId, target.sessionId, target.assetId or target.collectionId required');
    }
    // An asset target has no tool to open, so it cannot admit a guest seat
    // (plans/31 §2 1b names share/embed/download only). Refuse rather than
    // mint a guest link whose target the collab gateway could never resolve.
    if (kind === 'guest-edit' && (body.target.assetId || body.target.collectionId)) {
      return sendError(res, 400, 'INVALID_INPUT', 'guest-edit links target a tool, not a catalog asset');
    }
    // A collection is a LIST, so it has no single byte stream an `<img src>`
    // could point at. `share` serves its listing page and `download` serves the
    // zip; `embed` would have to invent a third meaning, and the one it would
    // invent - this org's curated set in an iframe on any site - is the brand
    // portal plans/25 refuses. Refused at mint, where it is legible.
    if (kind === 'embed' && body.target.collectionId) {
      return sendError(res, 400, 'INVALID_INPUT', 'a collection link is share (its listing page) or download (its zip), never embed');
    }
    if (body.target.collectionId && body.target.assetId) {
      return sendError(res, 400, 'INVALID_INPUT', 'a link targets one collection or one asset, not both');
    }
    const action = kind === 'guest-edit' ? 'link.create-guest' : 'link.create';
    const grants = await store.listGrants();
    // The SAME selectors the gateway's per-gesture re-check asks with
    // (`mayCreateGuestLinks`, `links/sign.ts`'s own doc on why this is one
    // function) - a tool-scoped grant must authorize the identical resource
    // shape at mint time and on every later gesture, or the two silently disagree.
    const selectors = linkResourceSelectors(body.target);
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, selectors, grants)) {
      return sendError(res, 403, denialCode(action), `not allowed: ${action}`);
    }
    if (kind === 'guest-edit' && !config.policy.guestLinks.enabled) {
      return sendError(res, 403, 'GUEST_LINKS_DISABLED', 'guest links are disabled on this deployment');
    }
    // A link's target.sessionId is a destination the MINTER must already be
    // able to reach - plans/02 §8's "destination project/session so the
    // guest's work saves server-side" presumes the inviter picked one of
    // their OWN sessions, not any id in the instance. Without this, holding
    // `link.create-guest` (a per-group grant, not "trust every project") is
    // enough to mint a writer seat on a session whose project the minter
    // cannot themselves see - bypassing `canSeeProject`, `collab.join` and
    // `session.edit` in one HTTP call. Checked with the exact gate
    // `GET /api/v1/sessions/:id` uses, so a mint can never reach further than
    // a plain read of the same session would.
    if (body.target.sessionId) {
      const targetSession = await store.getSession(body.target.sessionId);
      if (!targetSession) return sendError(res, 404, 'NOT_FOUND', 'no such session');
      const targetProject = await store.getProject(targetSession.projectId);
      if (!targetProject || !canSeeProject(user, targetProject)) {
        return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
      }
    }
    // Exposure is checked HERE, once, at mint (plans/31 §2 1b): a link is a
    // bearer credential for the bytes the minter could already fetch, never a
    // way to reach past their own group visibility. Lifecycle is deliberately
    // NOT checked here - it is re-read on every resolve, so a link minted today
    // stops serving the moment the asset expires or is revoked.
    if (body.target.assetId) {
      const assetId = body.target.assetId.trim();
      if (!assetId || assetId.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(assetId)) {
        return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
      }
      if (!(await callerSeesAsset(user, assetId))) {
        return sendError(res, 403, 'FORBIDDEN', 'you cannot see this asset');
      }
    }
    // A collection target is the same rule one level up (plans/31 §5), and it
    // takes BOTH halves: the minter must be able to see the collection, and
    // every member it names.
    //
    // The curation-time check on `PUT /catalog/collections/:id` is not enough on
    // its own, because it binds the CURATOR. `link.create` is a plain member
    // default while `catalog.collection.manage` is admin, so a widely visible
    // collection (`groups: '*'`) curated by someone who can see every member is
    // otherwise a laundry: a member who is individually denied `inst/hero`
    // mints a link on the set and the bearer surface hands them the bytes, the
    // feed's narrowing (`composeCollections`) having no say once a link exists.
    // Asked per member here, where the caller still has an identity, so the
    // invariant a link rests on - it can only hand on access its minter already
    // had - holds for the minter and not merely for the curator.
    //
    // Refused as a COUNT rather than a list of ids: the minter did not choose
    // this membership (the curator did), so naming the assets they are denied
    // would itself be a reach past their exposure. The curator's own PUT does
    // name them, because there the person supplied the ids.
    if (body.target.collectionId) {
      const collection = await store.getCollection(String(body.target.collectionId).trim());
      if (!collection || !collectionVisible(collection, user.groups)) {
        return sendError(res, 403, 'FORBIDDEN', 'you cannot see this collection');
      }
      let unseen = 0;
      for (const memberId of collection.members) {
        if (!(await callerSeesAsset(user, memberId))) unseen++;
      }
      if (unseen) {
        return sendError(res, 403, 'MEMBER_NOT_VISIBLE',
          `this collection holds ${unseen} asset${unseen === 1 ? '' : 's'} you cannot see - ask its curator to share it`);
      }
      body.target = { ...body.target, collectionId: collection.id };
    }
    const maxTtl = kind === 'guest-edit' ? config.policy.guestLinks.maxTtlHours : 24 * 365;
    const defTtl = kind === 'guest-edit' ? config.policy.guestLinks.defaultTtlHours : DEFAULT_TTL_SEC[kind] / 3600;
    const ttlHours = Math.min(body.ttlHours ?? defTtl, maxTtl);
    const link: LinkRecord = {
      id: randomId(10),
      kind,
      target: body.target,
      exp: Math.floor(Date.now() / 1000) + Math.floor(ttlHours * 3600),
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      ...(body.password ? { pwHash: hashPassword(body.password) } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
    };
    await store.putLink(link);
    await audit(`user:${user.id}`, 'link.create', `link:${link.id}`, {
      kind, toolId: body.target.toolId ?? null, assetId: body.target.assetId ?? null,
      collectionId: body.target.collectionId ?? null,
    });
    sendJson(res, 201, { id: link.id, kind, url: `${config.instance.baseUrl}${linkPath(link, secrets.link)}`, expiresAt: new Date(link.exp * 1000).toISOString() });
  });

  router.add('POST', '/api/v1/links/:id/revoke', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const link = await store.getLink(ctx.params.id as string);
    if (!link) return sendError(res, 404, 'NOT_FOUND', 'no such link');
    const grants = await store.listGrants();
    const mayRevoke = link.createdBy === user.id ||
      evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'link.revoke', ['*'], grants);
    if (!mayRevoke) return sendError(res, 403, 'FORBIDDEN', 'not your link');
    await store.revokeLink(link.id, new Date().toISOString());
    await audit(`user:${user.id}`, 'link.revoke', `link:${link.id}`);
    sendJson(res, 200, { ok: true });
  });

  // Link resolver. Guest-edit admits a guest principal; other kinds return
  // target info (the render plane will stream bytes here once it lands).
  router.add('GET', '/l/:id', async (req, res, ctx) => {
    const link = await store.getLink(ctx.params.id as string);
    if (!link) return sendError(res, 404, 'NOT_FOUND', 'no such link');
    const sig = ctx.url.searchParams.get('s') ?? '';
    const pw = ctx.url.searchParams.get('pw');
    const passwordOk = link.pwHash ? (pw !== null && verifyPassword(pw, link.pwHash)) : true;
    const status = checkLink(link, sig, secrets.link, { passwordOk });
    if (status === 'bad-signature') return sendError(res, 403, 'BAD_SIGNATURE', 'link signature invalid');
    if (status === 'expired') return sendError(res, 410, 'LINK_EXPIRED', 'this link has expired');
    if (status === 'revoked') return sendError(res, 410, 'LINK_REVOKED', 'this link was revoked');
    if (status === 'password-required') return sendError(res, 401, 'PASSWORD_REQUIRED', 'this link needs its password');
    if (link.kind === 'guest-edit') {
      const name = (ctx.url.searchParams.get('name') ?? 'Guest').slice(0, 60);
      const ttlSec = Math.max(60, link.exp - Math.floor(Date.now() / 1000));
      const cookie = mintGuestCookie(
        {
          linkId: link.id, toolId: link.target.toolId ?? '', inviter: link.createdBy, name,
          ...(link.target.sessionId ? { sessionRef: link.target.sessionId } : {}),
        },
        secrets.session, secure, ttlSec,
      );
      await audit(guestActor(link.id), 'guest.admit', `link:${link.id}`, { name });
      res.writeHead(200, { 'set-cookie': cookie, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ kind: 'guest-edit', toolId: link.target.toolId, sessionRef: link.target.sessionId ?? null, guest: name }));
      return;
    }
    // A collection target is a LIST of assets (plans/31 §5) - its own listing
    // page, one member's bytes, or the zip-all, all through this one signature.
    if (link.target.collectionId) return serveLinkedCollection(req, res, link, ctx.url);
    // A catalog asset target streams the asset's own bytes instead of a render
    // (plans/31 §2 1b). Lifecycle is re-resolved in there, on the same gate the
    // feed and the /catalog/* blob routes ask.
    if (link.target.assetId) return serveLinkedAsset(req, res, link);
    // share / embed / download - render the BAKED stored target to bytes. The
    // signature IS the authorization (no session needed), so params are trusted
    // exactly as minted and the caller's query is ignored (bar the password gate
    // above). Public-cacheable: the URL fully determines the asset.
    const toolId = link.target.toolId;
    if (!toolId) return sendError(res, 400, 'UNRENDERABLE_TARGET', 'this link has no tool to render');
    const fmt = (link.target.format || 'svg').toLowerCase();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(link.target.params ?? {})) {
      if (v == null) continue;
      q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    try {
      const result = await renderTool({ config, resolveProvenance, instanceCatalogVersion, worker: renderWorker, signer: await getC2paSigner() }, {
        toolId, format: fmt, query: q.toString(),
        principal: null, profile: {}, overlays: await store.listOverlays(),
      });
      const etag = `"r-${result.cacheKey.slice(0, 16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        'content-type': result.mime, etag, 'cache-control': 'public, max-age=300',
        ...provenanceHeader(result.provenance),
      };
      if (link.kind === 'download') headers['content-disposition'] = `attachment; filename="${toolId}.${fmt}"`;
      res.writeHead(200, headers);
      res.end(Buffer.from(result.bytes));
    } catch (err) {
      if (err instanceof RenderError) {
        if (err.retryAfter !== undefined) res.setHeader('retry-after', String(err.retryAfter));
        return sendError(res, err.status, err.code, err.message);
      }
      throw err;
    }
  });

  // ── admin API (the console and the CLI share these routes) ───────────────
  const requireAction = async (req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null> => {
    const user = await memberOf(req);
    if (!user) {
      sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      return null;
    }
    const grants = await store.listGrants();
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, ['*'], grants)) {
      sendError(res, 403, 'FORBIDDEN', `${action} required`);
      return null;
    }
    return user;
  };

  router.add('GET', '/api/v1/fleet', async (req, res) => {
    if (!(await requireAction(req, res, 'fleet.view'))) return;
    // engineVersion is what THIS deploy serves (the vendored pin) - beside the
    // field histogram it makes drift readable in one place (plans/34 wave 1d).
    // minEngine is the operator's stated version floor (wave 5) - a statement
    // the console highlights and nudges from, never a gate.
    sendJson(res, 200, {
      clients: await store.fleetSummary(),
      engineVersion: pinnedEngineVersion(),
      minEngine: config.policy.fleet.minEngine ?? null,
    });
  });

  // ── fleet install registry (plans/34 wave 3) ──────────────────────────────
  // Rows exist only because an install spoke `install/<id>` on an authenticated
  // request (see the request wrapper). Everything here is bookkeeping under the
  // enrollment covenant: rename and forget touch the row, never the device.
  router.add('GET', '/api/v1/fleet/installs', async (req, res) => {
    if (!(await requireAction(req, res, 'fleet.view'))) return;
    const [installs, users] = await Promise.all([store.listInstalls(), store.listUsers()]);
    const nameOf = new Map(users.map((u) => [u.id, displayName(u)]));
    sendJson(res, 200, {
      installs: installs.map((i) => ({
        ...i,
        ...(i.userIdLastSeen && nameOf.has(i.userIdLastSeen) ? { userName: nameOf.get(i.userIdLastSeen) } : {}),
      })),
    });
  });

  router.add('PATCH', '/api/v1/fleet/installs/:id', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'fleet.manage');
    if (!actor) return;
    const body = (await readJson(req)) as { name?: unknown } | null;
    if (body?.name !== null && typeof body?.name !== 'string') {
      return sendError(res, 400, 'INVALID_INPUT', 'name must be a string, or null to clear it');
    }
    const trimmed = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const updated = await store.renameInstall(ctx.params.id!, trimmed || null);
    if (!updated) return sendError(res, 404, 'NOT_FOUND', 'no such install');
    await audit(`user:${actor.id}`, 'fleet.install.rename', `install:${ctx.params.id}`);
    sendJson(res, 200, updated);
  });

  router.add('DELETE', '/api/v1/fleet/installs/:id', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'fleet.manage');
    if (!actor) return;
    // A row delete and an audit line - the covenant's whole vocabulary. The
    // next signed-in request from the device re-registers it, by design.
    await store.forgetInstall(ctx.params.id!);
    await audit(`user:${actor.id}`, 'fleet.install.forget', `install:${ctx.params.id}`);
    sendJson(res, 200, { ok: true });
  });

  // Schema readiness - pending migrations on the live store. Owner-gated
  // (instance.config) since it's an infra/operations signal for `lw migrate
  // --check` and monitoring. Memory store always reports current.
  router.add('GET', '/api/v1/system/migrations', async (req, res) => {
    if (!(await requireAction(req, res, 'instance.config'))) return;
    const pending = await store.pendingMigrations();
    sendJson(res, 200, { pending, current: pending.length === 0 });
  });

  router.add('GET', '/api/v1/telemetry/summary', async (req, res) => {
    if (!(await requireAction(req, res, 'telemetry.view'))) return;
    sendJson(res, 200, summarize(await store.listEvents()));
  });

  // Live collab rooms - the admin console's Rooms panel (OSS plans/100 §7,
  // lolly-work plans/14 §6). Gated the same as `/api/v1/stats/overview` below:
  // `telemetry.view` is this instance's "console dashboard read" tier, reused
  // there for non-telemetry stats for the same reason - this is another
  // Overview-style read, not a distinct capability worth its own grant.
  // `listCollabRooms` is the room registry's OWN copy (rooms.ts
  // `RoomRegistry.list`/`Room.snapshotForAdmin`) - counters, roles and display
  // names, never a presence payload or an input value. The session label is
  // the one thing the room registry cannot answer (it holds no session meta),
  // so it is looked up fresh per room here, the same "re-read, don't cache"
  // posture `authorizeOps` uses for a live room's policy.
  router.add('GET', '/api/v1/collab/rooms', async (req, res) => {
    if (!(await requireAction(req, res, 'telemetry.view'))) return;
    const live = listCollabRooms ? listCollabRooms() : [];
    const rooms = await Promise.all(live.map(async (r) => {
      const session = await store.getSession(r.sessionId);
      // Bounded for the same reason the invite copy is (collab/invites.ts):
      // `meta` is member-authored and `PUT /api/v1/sessions/:id` caps nothing
      // inside it, so an unbounded label is a megabyte in an admin's room table.
      const sessionLabel = typeof session?.meta?.label === 'string'
        ? session.meta.label.slice(0, MAX_LABEL_CHARS)
        : null;
      return {
        sessionId: r.sessionId,
        sessionLabel,
        toolId: r.toolId,
        memberCount: r.memberCount,
        writerCount: r.writerCount,
        observerCount: r.observerCount,
        members: r.members,
        opsApplied: r.opsApplied,
        startedAt: r.startedAt,
      };
    }));
    sendJson(res, 200, { rooms });
  });

  router.add('GET', '/api/v1/audit', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    const events = await store.listAudit();
    const chain = verifyChain(events);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 200), 1000);
    sendJson(res, 200, { chain, total: events.length, events: events.slice(-limit) });
  });

  // The chain head alone (seq + hash + intact flag) - small enough to record
  // externally on a schedule, so DB-level truncation becomes detectable.
  router.add('GET', '/api/v1/audit/head', async (req, res) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    sendJson(res, 200, await auditHead(store));
  });

  router.add('GET', '/api/v1/links', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const wantAll = ctx.url.searchParams.get('all') === '1';
    if (wantAll && !(await requireAction(req, res, 'link.revoke'))) return;
    const links = wantAll ? await store.listAllLinks() : await store.listLinksBy(user.id);
    const now = Math.floor(Date.now() / 1000);
    sendJson(res, 200, {
      links: links.map((l) => ({
        id: l.id, kind: l.kind, target: l.target, createdBy: l.createdBy, createdAt: l.createdAt,
        url: `${config.instance.baseUrl}${linkPath(l, secrets.link)}`,
        expiresAt: new Date(l.exp * 1000).toISOString(), protected: Boolean(l.pwHash),
        status: l.revokedAt ? 'revoked' : l.exp <= now ? 'expired' : 'live',
      })),
    });
  });

  // Wire shape for one user - the People-view row. Splits effective `groups`
  // into its idp/local sources so the console can render the (read-only) mirror
  // distinctly from the editable local set.
  // Telemetry consent is deliberately ABSENT here (plans/09 §2a): opting out
  // must not be conspicuous, so a person's consent state is visible to that
  // person alone (org-config `telemetry.consented`) - never a directory
  // column, a filter, or anything an admin can enumerate.
  const userWire = (u: UserRecord) => ({
    id: u.id, email: u.email, name: displayName(u),
    title: u.title ?? null, groups: u.groups, idpGroups: u.idpGroups, localGroups: u.localGroups, role: u.role,
    lastSeenAt: u.lastSeenAt, disabled: Boolean(u.disabledAt),
  });

  const USER_SORTS = ['name', 'email', 'role', 'lastSeen'] as const;
  const STATUS_FILTERS = ['active', 'disabled'] as const;

  router.add('GET', '/api/v1/users', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!['admin', 'owner'].includes(user.role)) return sendError(res, 403, 'FORBIDDEN', 'admin role required');
    const qp = ctx.url.searchParams;
    const page = Math.max(1, Math.floor(Number(qp.get('page') ?? 1)) || 1);
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(qp.get('pageSize') ?? 50)) || 50));
    const sortRaw = qp.get('sort');
    const dirRaw = qp.get('dir');
    const statusRaw = qp.get('status');
    const prefixRaw = qp.get('prefix')?.trim().toLowerCase() ?? '';
    const opts: import('../store/types.ts').ListUsersPageOpts = {
      ...(qp.get('q')?.trim() ? { q: qp.get('q')!.trim() } : {}),
      ...(/^[a-z#]$/.test(prefixRaw) ? { prefix: prefixRaw } : {}),
      ...(qp.get('role')?.trim() ? { role: qp.get('role')!.trim() } : {}),
      ...(qp.get('group')?.trim() ? { group: qp.get('group')!.trim() } : {}),
      ...(STATUS_FILTERS.includes(statusRaw as never) ? { status: statusRaw as 'active' | 'disabled' } : {}),
      ...(USER_SORTS.includes(sortRaw as never) ? { sort: sortRaw as typeof USER_SORTS[number] } : {}),
      ...(dirRaw === 'asc' || dirRaw === 'desc' ? { dir: dirRaw } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };
    const { rows, total } = await store.listUsersPage(opts);
    sendJson(res, 200, { users: rows.map(userWire), total, page, pageSize });
  });

  // One user by id - backs the activity feed's "focus this person" deep link
  // (#/users?focus=<id>) so a row can open straight into a user's detail.
  router.add('GET', '/api/v1/users/:id', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!['admin', 'owner'].includes(user.role)) return sendError(res, 403, 'FORBIDDEN', 'admin role required');
    const target = (await store.listUsers()).find((u) => u.id === ctx.params.id);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    sendJson(res, 200, userWire(target));
  });

  // ── groups: IdP mirror (read-only) + local registry (console-editable) ─────
  // Same admin surface as grants (grant.edit). IdP groups are discovered from
  // users' idpGroups; local groups come from the registry. memberCount is
  // effective membership (idp ∪ local), i.e. how many users the group reaches.
  const LOCAL_GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  router.add('GET', '/api/v1/groups', async (req, res) => {
    if (!(await requireAction(req, res, 'grant.edit'))) return;
    const [users, localDefs] = [await store.listUsers(), await store.listLocalGroups()];
    const memberCount = (name: string): number => users.filter((u) => u.groups.includes(name)).length;
    const localNames = new Set(localDefs.map((g) => g.name));
    const idpNames = new Set<string>();
    for (const u of users) for (const g of u.idpGroups) idpNames.add(g);
    const groups: Array<{ name: string; source: 'idp' | 'local'; description?: string; memberCount: number }> = [];
    for (const g of localDefs) {
      groups.push({ name: g.name, source: 'local', ...(g.description ? { description: g.description } : {}), memberCount: memberCount(g.name) });
    }
    for (const name of [...idpNames].sort()) {
      if (!localNames.has(name)) groups.push({ name, source: 'idp', memberCount: memberCount(name) });
    }
    sendJson(res, 200, { groups });
  });

  router.add('POST', '/api/v1/groups', async (req, res) => {
    const user = await requireAction(req, res, 'grant.edit');
    if (!user) return;
    const body = (await readJson(req)) as { name?: string; description?: string } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!LOCAL_GROUP_NAME.test(name)) return sendError(res, 400, 'INVALID_INPUT', 'name must be a slug (letters, digits, . _ -), ≤64 chars');
    if ((await store.listLocalGroups()).some((g) => g.name === name)) {
      return sendError(res, 409, 'CONFLICT', 'a local group with this name already exists');
    }
    // A local group must not shadow an IdP group name (the mirror is authoritative).
    if ((await store.listUsers()).some((u) => u.idpGroups.includes(name))) {
      return sendError(res, 409, 'IDP_GROUP_COLLISION', 'an IdP group already carries this name');
    }
    const group = {
      name,
      ...(typeof body?.description === 'string' && body.description.trim() ? { description: body.description.slice(0, 300) } : {}),
      createdAt: new Date().toISOString(),
    };
    await store.putLocalGroup(group);
    await audit(`user:${user.id}`, 'group.create', `group:${name}`, { source: 'local' });
    sendJson(res, 201, { ...group, source: 'local', memberCount: 0 });
  });

  router.add('DELETE', '/api/v1/groups/:name', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'grant.edit');
    if (!user) return;
    const name = ctx.params.name as string;
    if (!(await store.listLocalGroups()).some((g) => g.name === name)) {
      return sendError(res, 404, 'NOT_FOUND', 'no such local group');
    }
    await store.deleteLocalGroup(name); // also strips it from every user's localGroups
    await audit(`user:${user.id}`, 'group.delete', `group:${name}`, { source: 'local' });
    sendJson(res, 200, { ok: true });
  });

  // Set a user's LOCAL groups (never idpGroups). Each must exist in the registry;
  // the store recomputes the effective union + role.
  router.add('PUT', '/api/v1/users/:id/local-groups', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'grant.edit');
    if (!actor) return;
    const body = (await readJson(req)) as { groups?: unknown } | null;
    if (!Array.isArray(body?.groups) || !body.groups.every((g): g is string => typeof g === 'string')) {
      return sendError(res, 400, 'INVALID_INPUT', 'groups must be an array of strings');
    }
    const wanted = [...new Set(body.groups.map((g) => g.trim()).filter(Boolean))];
    const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
    const unknown = wanted.filter((g) => !registry.has(g));
    if (unknown.length) return sendError(res, 400, 'UNKNOWN_GROUP', `not local groups: ${unknown.join(', ')}`);
    const updated = await store.setLocalGroups(ctx.params.id as string, wanted);
    if (!updated) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    await audit(`user:${actor.id}`, 'user.local-groups', `user:${updated.id}`, { localGroups: updated.localGroups });
    sendJson(res, 200, userWire(updated));
  });

  // Instant lockout (plans/02 §5): set/clear disabledAt. An owner can only be
  // disabled by another owner.
  router.add('POST', '/api/v1/users/:id/disabled', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'grant.edit');
    if (!actor) return;
    const body = (await readJson(req)) as { disabled?: unknown } | null;
    if (typeof body?.disabled !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'disabled must be a boolean');
    const target = (await store.listUsers()).find((u) => u.id === ctx.params.id);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    if (target.role === 'owner' && actor.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY', 'only an owner can disable an owner');
    }
    const updated = await store.setUserDisabled(target.id, body.disabled ? new Date().toISOString() : null);
    if (!updated) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    await audit(`user:${actor.id}`, body.disabled ? 'user.disable' : 'user.enable', `user:${updated.id}`);
    sendJson(res, 200, userWire(updated));
  });

  // Pre-expiry revocation ("sign out everywhere"): bump the user's session
  // epoch so every token minted before now is refused on its next request.
  // Same guard as disable - an owner's sessions are owner-only to revoke.
  router.add('POST', '/api/v1/users/:id/revoke-sessions', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'grant.edit');
    if (!actor) return;
    const target = (await store.listUsers()).find((u) => u.id === ctx.params.id);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    if (target.role === 'owner' && actor.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY', "only an owner can revoke an owner's sessions");
    }
    const updated = await store.bumpSessionEpoch(target.id);
    if (!updated) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    await audit(`user:${actor.id}`, 'user.sessions.revoked', `user:${updated.id}`);
    sendJson(res, 200, userWire(updated));
  });

  router.add('GET', '/api/v1/messages', async (req, res) => {
    if (!(await requireAction(req, res, 'message.send'))) return;
    const [messages, counts] = [await store.listMessages(), await store.ackCounts()];
    sendJson(res, 200, { messages: messages.map((m) => ({ ...m, acks: counts.get(m.id) ?? 0 })) });
  });

  router.add('POST', '/api/v1/messages', async (req, res) => {
    const user = await requireAction(req, res, 'message.send');
    if (!user) return;
    const body = (await readJson(req)) as Partial<Message> | null;
    if (!body?.title || typeof body.title !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'title required');
    const msg: Message = {
      id: `msg_${randomId(8)}`,
      kind: (['announcement', 'upgrade', 'policy', 'approval', 'expiry'] as const).includes(body.kind as never) ? body.kind as Message['kind'] : 'announcement',
      severity: (['info', 'action', 'blocking'] as const).includes(body.severity as never) ? body.severity as Message['severity'] : 'info',
      audience: body.audience ?? {},
      title: body.title.slice(0, 200),
      ...(body.body ? { body: String(body.body).slice(0, 4000) } : {}),
      ...(body.cta ? { cta: body.cta } : {}),
      ...(body.startsAt ? { startsAt: body.startsAt } : {}),
      ...(body.endsAt ? { endsAt: body.endsAt } : {}),
      dismissible: body.dismissible !== false,
    };
    await store.putMessage(msg);
    await audit(`user:${user.id}`, 'message.send', `message:${msg.id}`, { kind: msg.kind, severity: msg.severity });
    sendJson(res, 201, msg);
  });

  // ── approvals (plans/05) ──────────────────────────────────────────────────
  const userGroupsMap = async (): Promise<Map<string, string[]>> => {
    const map = new Map<string, string[]>();
    for (const u of await store.listUsers()) map.set(u.id, u.groups);
    return map;
  };

  // id → {name,email} so serializeApproval can resolve opaque actor ids to
  // display names for the console's stepper.
  const actorsMap = async (): Promise<Map<string, ActorInfo>> => {
    const map = new Map<string, ActorInfo>();
    for (const u of await store.listUsers()) {
      map.set(u.id, { name: displayName(u), email: u.email });
    }
    return map;
  };

  // Chains: any member may read the catalogue of chains; editing one is policy.edit.
  router.add('GET', '/api/v1/chains', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    sendJson(res, 200, { chains: await store.listChains() });
  });

  router.add('PUT', '/api/v1/chains/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'policy.edit');
    if (!user) return;
    const chain = normalizeChain(ctx.params.id as string, await readJson(req));
    if (!chain) return sendError(res, 400, 'INVALID_INPUT', 'a chain needs at least one step, each with approver groups and a valid rule');
    await store.putChain(chain);
    await audit(`user:${user.id}`, 'chain.edit', `chain:${chain.id}`, { steps: chain.steps.length });
    sendJson(res, 200, chain);
  });

  // Nominatable approvers for a chain step - what the shell's "Request approval"
  // dialog searches. Member-accessible: it reveals ONLY people already designated
  // as approvers for that step (id + display name), never the wider directory, so
  // a requester can nominate without `catalog`/admin visibility into everyone.
  router.add('GET', '/api/v1/approvals/approvers', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const chainId = ctx.url.searchParams.get('chainId');
    if (!chainId) return sendError(res, 400, 'INVALID_INPUT', 'chainId required');
    const chain = await store.getChain(chainId);
    if (!chain) return sendError(res, 404, 'NOT_FOUND', 'no such chain');
    const stepIndex = Math.max(0, Number(ctx.url.searchParams.get('step') ?? 0) || 0);
    const step = stepOf(chain, stepIndex);
    if (!step) return sendError(res, 404, 'NOT_FOUND', 'no such step');
    const approvers = (await store.listUsers())
      .filter((u) => !u.disabledAt && u.id !== user.id && isEligible(step, u.groups)) // exclude self: separation of duties
      .map((u) => ({ id: u.id, name: displayName(u) }));
    sendJson(res, 200, { chainId, step: stepIndex, stepName: step.name, groups: step.approvers.groups, approvers });
  });

  // Submit: validate the chain exists and every nominee is eligible for step 0,
  // then open the approval in review and notify the nominees.
  router.add('POST', '/api/v1/approvals', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req)) as {
      subjectType?: string; subjectRef?: string; title?: string; chainId?: string; nominees?: unknown;
    } | null;
    if (!SUBJECT_TYPES.includes(body?.subjectType as never)) {
      return sendError(res, 400, 'INVALID_INPUT', 'subjectType must be asset|tool-change|config|guest-link');
    }
    if (!body?.title || typeof body.title !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'title required');
    if (!body?.chainId || typeof body.chainId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'chainId required');
    const chain = await store.getChain(body.chainId);
    if (!chain) return sendError(res, 404, 'NOT_FOUND', 'no such chain');
    const nominees = Array.isArray(body.nominees) ? body.nominees.filter((n): n is string => typeof n === 'string') : [];
    const check = validateNominees(chain, 0, nominees, await userGroupsMap());
    if (!check.ok) return sendError(res, 400, 'NOMINEE_NOT_ELIGIBLE', `not eligible for the first step: ${check.ineligible.join(', ')}`);
    const approval = createApproval({
      id: `apr_${randomId(8)}`,
      subjectType: body.subjectType as SubjectType,
      subjectRef: typeof body.subjectRef === 'string' ? body.subjectRef.slice(0, 300) : '',
      title: body.title.slice(0, 200),
      chain, nominees, createdBy: user.id, now: new Date().toISOString(),
    });
    await store.putApproval(approval);
    await audit(`user:${user.id}`, 'approval.submit', `approval:${approval.id}`, { chainId: chain.id, subjectType: approval.subjectType });
    if (nominees.length) {
      await store.putMessage({
        id: `msg_${randomId(8)}`,
        kind: 'approval', severity: 'action',
        audience: { users: nominees },
        title: `Approval requested: ${approval.title}`,
        body: `${user.email} asked for your review on the “${currentStep(approval)?.name ?? 'first'}” step.`,
        cta: { label: 'Review', url: '/admin#/approvals' },
        dismissible: true,
      });
    }
    sendJson(res, 201, serializeApproval(approval, user.id, undefined, await actorsMap()));
  });

  // List: ?mine=1 (raised by me) | ?inbox=1 (open on a step my groups may act on) |
  // default merges both, tagging each row with a `relation`.
  router.add('GET', '/api/v1/approvals', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const wantMine = ctx.url.searchParams.get('mine') === '1';
    const wantInbox = ctx.url.searchParams.get('inbox') === '1';
    const both = !wantMine && !wantInbox;
    const actors = await actorsMap();
    const out = new Map<string, ReturnType<typeof serializeApproval>>();
    if (wantMine || both) {
      for (const a of await store.listApprovals({ createdBy: user.id })) out.set(a.id, serializeApproval(a, user.id, 'mine', actors));
    }
    if (wantInbox || both) {
      for (const a of await store.listApprovals({ eligibleGroups: user.groups })) {
        if (a.createdBy === user.id) continue; // separation of duties - never review your own
        out.set(a.id, serializeApproval(a, user.id, 'inbox', actors));
      }
    }
    const approvals = [...out.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    sendJson(res, 200, { approvals });
  });

  // Act: approve/reject the current step. On a terminal transition, notify the submitter.
  router.add('POST', '/api/v1/approvals/:id/act', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const approval = await store.getApproval(ctx.params.id as string);
    if (!approval) return sendError(res, 404, 'NOT_FOUND', 'no such approval');
    const body = (await readJson(req)) as { action?: string; comment?: string } | null;
    if (body?.action !== 'approve' && body?.action !== 'reject') return sendError(res, 400, 'INVALID_INPUT', 'action must be approve or reject');
    const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.slice(0, 2000) : undefined;
    let next: Approval;
    try {
      next = applyAction(approval, { id: user.id, groups: user.groups }, body.action, comment, new Date().toISOString());
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'INVALID_INPUT';
      return sendError(res, approvalStatus(code), code, (err as Error).message);
    }
    await store.putApproval(next);
    await audit(`user:${user.id}`, body.action === 'approve' ? 'approval.approve' : 'approval.reject',
      `approval:${next.id}`, { state: next.state, step: approval.stepIndex });
    // A catalog submission's approval carries the asset with it: approved means
    // live, rejected means returned (plans/31 §3). Settled HERE as well as in
    // the catalog review queue, so an approver who works from the approvals
    // inbox does not leave the asset stuck behind a closed approval. It sends
    // the submitter its own, more specific message, so the generic one below is
    // skipped rather than doubled up.
    const wasSubmission = isTerminal(next.state) ? await settleAssetSubmission(next, user.id) : false;
    if (isTerminal(next.state) && !wasSubmission) {
      await store.putMessage({
        id: `msg_${randomId(8)}`,
        kind: 'approval', severity: next.state === 'approved' ? 'info' : 'action',
        audience: { users: [next.createdBy] },
        title: `Approval ${next.state}: ${next.title}`,
        body: `${user.email} ${next.state} your request${comment ? ` — “${comment}”` : ''}.`,
        cta: { label: 'View', url: '/admin#/approvals' },
        dismissible: true,
      });
    }
    sendJson(res, 200, serializeApproval(next, user.id, undefined, await actorsMap()));
  });

  // Withdraw: submitter only, while not terminal.
  router.add('POST', '/api/v1/approvals/:id/withdraw', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const approval = await store.getApproval(ctx.params.id as string);
    if (!approval) return sendError(res, 404, 'NOT_FOUND', 'no such approval');
    if (approval.createdBy !== user.id) return sendError(res, 403, 'FORBIDDEN', 'only the submitter can withdraw this request');
    let next: Approval;
    try {
      next = withdraw(approval, user.id, new Date().toISOString());
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'INVALID_INPUT';
      return sendError(res, approvalStatus(code), code, (err as Error).message);
    }
    await store.putApproval(next);
    await audit(`user:${user.id}`, 'approval.withdraw', `approval:${next.id}`, { state: next.state });
    // Withdrawing the review of a catalog submission returns the asset too:
    // leaving it `submitted` behind a closed approval would strand it.
    await settleAssetSubmission(next, user.id);
    sendJson(res, 200, serializeApproval(next, user.id, undefined, await actorsMap()));
  });

  // Blob → assetId, mirroring render/pipeline.ts's mtime-checked catalog
  // version cache: assets/index.json is read + parsed once per pack per
  // change, not on every blob request. Lifecycle rows themselves are NOT
  // cached here - they live in the store and are fetched fresh per request.
  const assetPathMapCache = new Map<string, { mtimeMs: number; map: Map<string, string> }>();
  const loadAssetPathMap = async (pack: string): Promise<Map<string, string>> => {
    const file = join(pack, 'catalog', 'assets', 'index.json');
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      return new Map();
    }
    const hit = assetPathMapCache.get(pack);
    if (hit && hit.mtimeMs === mtimeMs) return hit.map;
    let map = new Map<string, string>();
    try {
      map = buildPathMap(JSON.parse(await readFile(file, 'utf8')) as AssetIndex);
    } catch {
      /* unreadable/malformed index — empty map, nothing gated */
    }
    assetPathMapCache.set(pack, { mtimeMs, map });
    return map;
  };

  // id → full index entry, mtime-cached the same way (the inspect route wants
  // the whole entry, not just the path). Built from the same assets/index.json.
  const assetByIdCache = new Map<string, { mtimeMs: number; byId: Map<string, AssetIndexEntry> }>();
  const loadAssetIndexById = async (pack: string): Promise<Map<string, AssetIndexEntry>> => {
    const file = join(pack, 'catalog', 'assets', 'index.json');
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      return new Map();
    }
    const hit = assetByIdCache.get(pack);
    if (hit && hit.mtimeMs === mtimeMs) return hit.byId;
    const byId = new Map<string, AssetIndexEntry>();
    try {
      const index = JSON.parse(await readFile(file, 'utf8')) as AssetIndex;
      for (const entry of index.assets ?? []) {
        if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
      }
    } catch {
      /* unreadable/malformed index — empty map */
    }
    assetByIdCache.set(pack, { mtimeMs, byId });
    return byId;
  };

  // Export provenance resolver (plans/17): catalog refs a render consumed →
  // C2PA-shaped ingredients. Federated assets attribute their provider +
  // upstream filename; `c2pa: null` states honestly that the source shipped no
  // manifest of its own (none of the current providers do) while the
  // attribution still travels with the export.
  const resolveProvenance = async (refs: string[]): Promise<ProvenanceIngredient[]> => {
    await providersReady;
    const out: ProvenanceIngredient[] = [];
    const seen = new Set<string>();
    let fragments: Awaited<ReturnType<typeof federation.fragments>> | undefined;
    const pathMap = await loadAssetPathMap(config.instance.pack);
    // A detection upgrades `c2pa: null` → `{ kind: 'embedded' }` for the
    // consumed asset - the export can then distinguish "source said nothing"
    // from "source carries a credential" (plans/27 §4). Detection, never a verdict.
    const embeddedCredential = async (assetId: string): Promise<{ kind: 'embedded' } | null> =>
      (await store.getCredential(assetId))?.status === 'embedded' ? { kind: 'embedded' } : null;
    for (const rel of refs) {
      if (rel.startsWith('ext/')) {
        const [, pid, rid, fmtRef] = rel.split('/');
        if (!pid || !rid) continue;
        const assetId = extAssetId(pid, rid);
        if (seen.has(assetId)) continue;
        seen.add(assetId);
        const rec = await store.getProvider(pid);
        fragments ??= await federation.fragments();
        const entry = fragments.find((f) => f.rec.id === pid)?.fragment.assets.find((a) => a.id === assetId);
        const formats = (entry?.formats ?? []) as Array<{ url?: string; filename?: string }>;
        const fmt = formats.find((f) => fmtRef && f.url?.endsWith(`/${fmtRef}`)) ?? formats[0];
        out.push({
          title: typeof entry?.name === 'string' ? entry.name : rid,
          assetId,
          relationship: 'componentOf',
          source: {
            kind: 'provider', provider: pid, providerKind: rec?.kind ?? 'unknown',
            label: rec?.label ?? pid, remoteId: rid,
            ...(fmt?.filename ? { filename: fmt.filename } : {}),
          },
          c2pa: await embeddedCredential(assetId),
        });
      } else {
        const assetId = pathMap.get(rel);
        if (!assetId || seen.has(assetId)) continue;
        seen.add(assetId);
        out.push({
          title: assetId.split('/').pop() ?? assetId, assetId, relationship: 'componentOf',
          source: { kind: 'pack', label: config.instance.name }, c2pa: await embeddedCredential(assetId),
        });
      }
    }
    return out;
  };

  /** Compact header summary - full doc is embedded in the bytes themselves. */
  const provenanceHeader = (doc: ProvenanceDoc | undefined): Record<string, string> =>
    doc
      ? { 'x-lolly-provenance': JSON.stringify(doc.ingredients.map((i) => ({
          assetId: i.assetId,
          source: i.source.kind === 'provider' ? i.source.provider : 'pack',
          ...(i.source.kind === 'provider' && i.source.filename ? { filename: i.source.filename } : {}),
        }))) }
      : {};

  /**
   * The ONE lifecycle gate on catalog bytes. Every surface that hands an
   * asset's bytes to a caller asks this and nothing else: the three /catalog/*
   * branches below (inst, federated, pack) and the signed-link resolver's asset
   * target (plans/31 §2 1b). Revoked and scheduled always block; expired blocks
   * unless the local row asked only to warn - and an UPSTREAM expiry ignores
   * that softening, because the DAM is the source of truth for its own asset's
   * availability (plans/27 §2).
   *
   * `govId` is the id that GOVERNS the bytes, which is not always the id in the
   * URL: a pinned asset's bytes are local while its identity - and its
   * lifecycle row - stay ext/* (plans/27 §5). `useWindow` is off for ids that
   * can have no upstream window (pack, exited inst) so the fold stays cheap.
   *
   * A hold is deliberately not a block: it only ever *preserves* availability
   * (lifecycle.ts, plans/27 §3), so a held asset keeps serving here.
   */
  const catalogBytesGate = async (govId: string, useWindow: boolean): Promise<{ state: AssetState; blocked: boolean }> => {
    const row = await store.getLifecycle(govId);
    const window = useWindow ? await federation.availabilityWindow(govId) : undefined;
    const { state, upstreamExpired } = combinedState(row ?? undefined, window, Date.now());
    const blocked = state === 'revoked' || state === 'scheduled' || (state === 'expired' && (upstreamExpired || row?.onExpiry !== 'warn'));
    return { state, blocked };
  };

  /**
   * The posture stored bytes are handed to a browser under. Since plans/31 §3 a
   * member holding `catalog.submit` can put arbitrary bytes into this instance's
   * store, and some bytes are DOCUMENTS: an SVG is markup, it can carry
   * `<script>`, and the sniffer types it honestly as image/svg+xml because
   * lying about what we stored would be worse. The console lives on this same
   * origin, so a navigation to such a file - by a share link, say - would
   * otherwise run the submitter's script as whoever opened it.
   *
   * `sandbox` drops the document into an opaque origin (no session cookie, no
   * same-origin fetch) and `default-src 'none'` leaves it no script at all,
   * while inline style and data: images keep a legitimate icon rendering the
   * way its author drew it. Both are inert for bytes loaded as an <img>, which
   * is how the shells consume them, so this costs the normal path nothing.
   */
  const INERT_BYTES: Record<string, string> = {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
    'x-content-type-options': 'nosniff',
  };

  // ── asset versions (plans/31 §6) ──────────────────────────────────────────

  /**
   * One asset's version history, oldest first. An asset that has never been
   * versioned answers with a SYNTHESIZED version 1 built from the record
   * itself, so every surface can speak in version numbers from the first day
   * without migration 0020 having to backfill a row for every asset that
   * predates it. The row is written for real the moment a second version
   * arrives (submit.ts), which is the only point at which it starts to matter.
   */
  const assetVersionRows = async (rec: InstanceAssetRecord): Promise<AssetVersionRecord[]> => {
    const rows = await store.listAssetVersions(rec.id);
    return rows.length ? rows : [backfillVersionOne(rec)];
  };

  /**
   * Apply `policy.catalog.versionKeep` to one asset, returning how many
   * versions it dropped. Two things are never trimmed: the HEAD (a rollback
   * deliberately makes an old version current, and retention must not delete
   * the bytes the asset is serving) and anything on a HELD asset, because in
   * this codebase a hold only ever preserves availability - the same reason it
   * refuses revocation and an explicit version delete.
   */
  const trimVersionHistory = async (rec: InstanceAssetRecord): Promise<number> => {
    const keep = config.policy.catalog.versionKeep;
    if (keep <= 0) return 0;
    if ((await store.getLifecycle(rec.id))?.hold) return 0;
    const rows = await store.listAssetVersions(rec.id);
    const drop = versionsToTrim(rows, headVersionOf(rec), keep);
    if (!drop.length) return 0;
    const dropped = new Set(drop.map((r) => r.version));
    const surviving = rows.filter((r) => !dropped.has(r.version));
    for (const row of drop) await store.deleteAssetVersion(rec.id, row.version);
    // Blobs go only after the rows that named them, and only when no surviving
    // version still points at the same bytes.
    for (const blobId of orphanBlobIds(drop, surviving)) await blobs.delete(blobId);
    return drop.length;
  };

  // ── catalog serving (pack mount, per-caller filtered, lifecycle-enforced) ──
  router.add('GET', '/catalog/*', async (req, res, ctx) => {
    const user = await memberOf(req);
    const p = principalOf(req);
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    let rel = normalize(ctx.params['*'] ?? '').replace(/^(\.\.[/\\])+/, '');
    if (rel.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    // After the exit's cutover, an old ext/* blob URL (baked into already-rendered
    // SVGs and live sessions) resolves through a persistent alias to the new
    // inst/* path - nothing that referenced the federated identity breaks (plans/27 §5).
    if (rel.startsWith('ext/')) {
      const aliased = await store.getAlias(rel);
      if (aliased) rel = aliased;
    }
    // Instance-owned blobs stream from the BlobStore: /catalog/inst/<id>/<format>.
    if (rel.startsWith(INST_PREFIX)) {
      const parts = rel.split('/');
      if (parts.length !== 3) return sendError(res, 404, 'NOT_FOUND', 'bad instance asset path');
      const [, sid, formatRef] = parts as [string, string, string];
      const id = `${INST_PREFIX}${sid}`;
      const rec = await store.getInstanceAsset(id);
      if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such instance asset');
      if (!instanceAssetVisible(rec, user?.groups ?? [])) return sendError(res, 403, 'FORBIDDEN', 'not visible to your groups');
      // A submission under review (or returned) has no public bytes: the feed
      // does not carry it and this route does not serve it. Reviewers preview
      // it through /api/v1/catalog/submissions/:id/bytes instead (plans/31 §3).
      if (!submissionServable(rec)) {
        return sendError(res, 403, 'SUBMISSION_PENDING', 'this submission is not published');
      }
      // A pin's identity stays ext/* until cutover, so gate it EXACTLY like the
      // ext blob route would - the local lifecycle row AND the upstream
      // availability window - never a phantom inst-keyed row (plans/27 §3, §5).
      // An exited or submit asset gates on its own inst row (no window).
      const isPin = !rec.exited && !!rec.origin;
      const govId = isPin ? extAssetId(rec.origin!.provider, rec.origin!.remoteId) : id;
      if ((await catalogBytesGate(govId, isPin)).blocked) {
        return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
      }
      // `?v=N` serves a PRIOR version's bytes (plans/31 §6), through every gate
      // the head goes through - exposure, submission state, lifecycle - because
      // an old version of a revoked asset is still that asset. It exists for
      // the session that pinned a specific render: the id keeps resolving to
      // the head for everyone else, and a pinned copy does not have to break
      // for a brand refresh to land.
      let blobId = rec.blobs[formatRef];
      const wantedVersion = ctx.url.searchParams.get('v');
      if (wantedVersion !== null) {
        const n = Number(wantedVersion);
        if (!Number.isInteger(n) || n < 1) return sendError(res, 400, 'INVALID_INPUT', 'v must be a version number');
        const row = (await assetVersionRows(rec)).find((r) => r.version === n);
        const fmt = row?.formats.find((f) => f.format === formatRef);
        if (!fmt) return sendError(res, 404, 'NOT_FOUND', `no version ${n} of this asset in ${formatRef}`);
        blobId = fmt.blobId;
      }
      const stat = blobId ? await blobs.head(blobId) : null;
      if (!stat) return sendError(res, 404, 'NOT_FOUND', 'no such format');
      const etag = `"${stat.checksum}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, max-age=300' });
        res.end();
        return;
      }
      const blob = await blobs.get(blobId as string);
      if (!blob) return sendError(res, 404, 'NOT_FOUND', 'no such format');
      res.writeHead(200, {
        'content-type': blob.stat.contentType,
        ...INERT_BYTES,
        'cache-control': 'private, max-age=300',
        etag,
        'content-length': String(blob.stat.size),
      });
      Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
      return;
    }
    // Federated blobs never touch the filesystem: /catalog/ext/<provider>/<remoteId>/<formatRef>
    // resolves through the provider driver per request (plans/17 §8).
    if (rel.startsWith('ext/')) {
      const parts = rel.split('/');
      if (parts.length !== 4) return sendError(res, 404, 'NOT_FOUND', 'bad federated asset path');
      const [, providerId, remoteId, formatRef] = parts as [string, string, string, string];
      await providersReady;
      const rec = await store.getProvider(providerId);
      if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
      if (!rec.enabled) return sendError(res, 410, 'PROVIDER_DISABLED', 'this provider is disabled');
      if (!callerSeesProvider(rec, user?.groups ?? [])) return sendError(res, 403, 'FORBIDDEN', 'not visible to your groups');
      const assetId = extAssetId(providerId, remoteId);
      // The local row combined with any upstream availability window imported
      // from the DAM (plans/27 §2), read off the in-process fragment beside the
      // lifecycle row. Upstream expiry blocks bytes even under onExpiry:'warn' -
      // that only ever softens a purely-local expiry.
      if ((await catalogBytesGate(assetId, true)).blocked) {
        return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
      }
      // hold-implies-pin (plans/27 §3, §5): when this asset's bytes have been
      // materialized into the instance's own store, prefer the local copy - the
      // federated identity stays, but the bytes survive upstream deletion.
      const pinned = await store.getInstanceAsset(materializedIdFor(providerId, remoteId));
      if (pinned) {
        const fmtName = pinned.refMap?.[formatRef] ?? formatRef;
        const localId = pinned.blobs[fmtName];
        const localStat = localId ? await blobs.head(localId) : null;
        if (localStat) {
          const etag = `"${localStat.checksum}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'private, max-age=300' });
            res.end();
            return;
          }
          const local = await blobs.get(localId as string);
          if (local) {
            res.writeHead(200, {
              'content-type': local.stat.contentType, ...INERT_BYTES,
              'cache-control': 'private, max-age=300', etag, 'content-length': String(local.stat.size),
            });
            Readable.fromWeb(local.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
            return;
          }
        }
      }
      try {
        const blob = await federation.instantiate(rec).resolveBlob(remoteId, formatRef);
        if (blob.kind === 'redirect') {
          res.writeHead(302, { location: blob.url, 'cache-control': 'private, no-store' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': blob.contentType,
          ...INERT_BYTES,
          'cache-control': 'private, max-age=300',
          ...(blob.size !== undefined ? { 'content-length': String(blob.size) } : {}),
        });
        Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
      } catch {
        return sendError(res, 502, 'PROVIDER_UNAVAILABLE', 'the upstream provider did not return this asset');
      }
      return;
    }
    const filePath = join(config.instance.pack, 'catalog', rel);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
    }
    if (rel === 'tools/index.json') {
      const overlays = await store.listOverlays();
      const groups = user?.groups ?? [];
      try {
        const index = JSON.parse(bytes.toString('utf8')) as { tools?: Array<{ id: string }> };
        if (Array.isArray(index.tools)) index.tools = filterToolIndex(index.tools, overlays, groups);
        return sendJson(res, 200, index, { 'cache-control': 'private, max-age=60' });
      } catch {
        /* not the expected shape — serve raw below */
      }
    } else if (rel === 'assets/index.json') {
      try {
        const index = JSON.parse(bytes.toString('utf8')) as AssetIndex;
        await providersReady;
        // Federate before lifecycle so expire/revoke rows on ext/* ids gate
        // federated entries exactly like pack entries.
        const federated = await federation.composeIndex(index, user?.groups ?? []);
        const [rows, creds, instAssets, metas, fieldDefs] = await Promise.all([
          store.listLifecycle(), store.listCredentials(), store.listInstanceAssets(),
          store.listAssetMeta(), store.listCatalogFields(),
        ]);
        // Org-defined values ride the feed as an additive `fields` bag on the
        // entries that carry any (plans/31 section 4). It folds over pack,
        // federated and instance entries alike, because the overlay is keyed by
        // catalog id rather than by which of the three produced the entry.
        const composed = composeAssetMeta(
          composeInstanceAssets(federated, instAssets, user?.groups ?? []), metas, fieldDefs,
        );
        const gated = applyLifecycleToIndex(composed, rows, Date.now());
        // Collections ride the SAME feed as an additive `collections` key
        // (plans/31 §5), folded last so a member that lifecycle just dropped is
        // already absent from the ids it can reference. A deployment with no
        // collections serves a byte-identical index, which is what lets the OSS
        // catalog view light up its Collections section later with no server
        // change and a public build render unchanged.
        const withCollections = composeCollections(
          applyCredentialsToIndex(gated, creds), await store.listCollections(), user?.groups ?? [],
        );
        return sendJson(res, 200, withCollections, { 'cache-control': 'private, max-age=60' });
      } catch {
        /* not the expected shape — serve raw below */
      }
    } else {
      // Any other catalog file: if it's a format entry owned by an asset
      // whose lifecycle blocks it (revoked, scheduled, or expired-and-hidden),
      // the blob dies too - a guessed/cached URL doesn't bypass the feed.
      const assetId = (await loadAssetPathMap(config.instance.pack)).get(rel);
      if (assetId) {
        const { state, blocked } = await catalogBytesGate(assetId, false);
        if (blocked) {
          const message = state === 'revoked' ? 'this asset has been revoked' : state === 'scheduled' ? 'this asset is not yet published' : 'this asset has expired';
          return sendError(res, 410, 'ASSET_EXPIRED', message);
        }
      }
    }
    res.writeHead(200, { 'content-type': contentType(rel), 'cache-control': 'private, max-age=300' });
    res.end(bytes);
  });

  // ── signed links onto catalog assets (plans/31 §2 1b) ────────────────────
  // A share/embed/download link may target a catalog asset id instead of a tool
  // render. Two halves, deliberately split: EXPOSURE is settled once at mint
  // (`callerSeesAsset`), and LIFECYCLE is re-resolved on every visit through the
  // one gate the feed and the blob routes already ask (`catalogBytesGate`), so a
  // link that is still live serves nothing once its asset expires or is revoked.

  /** After the exit's cutover an ext/* id aliases to its inst/* successor, so a
   *  link minted before the exit keeps resolving - the same alias table the
   *  /catalog/* route follows for blob paths (plans/27 §5). */
  const resolveAssetAlias = async (assetId: string): Promise<string> =>
    assetId.startsWith(EXT_PREFIX) ? (await store.getAlias(assetId)) ?? assetId : assetId;

  /** The federated feed entry for an ext/* id, or undefined when the provider's
   *  exposure slice does not federate it. */
  const federatedEntry = async (providerId: string, assetId: string): Promise<AssetIndexEntry | undefined> => {
    const frags = await federation.fragments();
    return frags.find((f) => f.rec.id === providerId)?.fragment.assets.find((a) => a.id === assetId);
  };

  /**
   * Whether this member can see an asset at all - the mint-time half of an asset
   * link. It asks exactly what the serving surfaces ask (instance-asset groups,
   * provider group visibility plus the exposure slice, pack membership), so a
   * link can only ever hand on access its minter already had. Lifecycle is not
   * consulted here on purpose: a scheduled asset is a legitimate thing to mint a
   * link for, and an expired one is refused at resolve rather than at mint.
   */
  const callerSeesAsset = async (user: UserRecord, rawId: string): Promise<boolean> => {
    const assetId = await resolveAssetAlias(rawId);
    if (assetId.startsWith(INST_PREFIX)) {
      const rec = await store.getInstanceAsset(assetId);
      // A submission that is not live yet is not linkable: it is not in the
      // feed and its bytes do not serve, so a link to it could only ever 403.
      return Boolean(rec && submissionServable(rec) && instanceAssetVisible(rec, user.groups));
    }
    if (assetId.startsWith(EXT_PREFIX)) {
      const [, providerId] = assetId.split('/');
      if (!providerId) return false;
      await providersReady;
      const rec = await store.getProvider(providerId);
      if (!rec || !rec.enabled || !callerSeesProvider(rec, user.groups)) return false;
      return Boolean(await federatedEntry(providerId, assetId));
    }
    return (await loadAssetIndexById(config.instance.pack)).has(assetId);
  };

  /** A filename safe to put in a Content-Disposition header: the minter chose
   *  the target, so nothing from it reaches the header unsanitized. */
  const safeFilename = (raw: string): string =>
    raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120) || 'asset';

  /** Response headers for linked asset bytes: private, inert, sniff-proof, and
   *  never CDN-cacheable (plans/26 §6) - the same posture as /catalog/*, and
   *  the same INERT_BYTES, which matter most here because this is the one
   *  surface an UNAUTHENTICATED bearer reaches. `attach` is the download
   *  decision: a `download` link attaches, `share` and `embed` serve inline,
   *  and a collection page's per-item button attaches on its own say-so. */
  const linkedAssetHeaders = (
    attach: boolean, mime: string, filename: string, extra: Record<string, string> = {},
  ): Record<string, string> => ({
    'content-type': mime,
    ...INERT_BYTES,
    'cache-control': 'private, max-age=300',
    ...(attach ? { 'content-disposition': `attachment; filename="${safeFilename(filename)}"` } : {}),
    ...extra,
  });

  /**
   * Where one linked asset's bytes come from, and whether they may be served at
   * all - decided ONCE, in one function, for every bearer-facing surface.
   *
   * This is the shared gate plans/31 §5 asks a collection to reuse rather than
   * re-implement. A single asset link, a collection page's preview, a per-item
   * download and a member of the zip all resolve through here, so the lifecycle
   * question ("is this asset still available?") is asked in exactly one place
   * and its answer cannot differ between the page a bearer reads and the
   * archive they download. Exposure is NOT asked here: that was settled at mint
   * (`callerSeesAsset` / the collection's own groups), which is what makes a
   * link a bearer credential rather than a session.
   *
   * A `refused` result carries the response the caller should send for a single
   * asset; a collection counts it as withheld and moves on.
   */
  type LinkedSource =
    | { kind: 'blob'; blobId: string; filename: string; format: string }
    | { kind: 'remote'; provider: ProviderRecord; remoteId: string; remoteRef: string; filename: string; format: string; size?: number }
    | { kind: 'file'; absPath: string; filename: string; format: string; size?: number }
    | { kind: 'refused'; status: number; code: string; message: string };

  const refuse = (status: number, code: string, message: string): LinkedSource =>
    ({ kind: 'refused', status, code, message });
  const goneSource = (): LinkedSource => refuse(410, 'ASSET_EXPIRED', 'this asset is no longer available');

  const resolveLinkedSource = async (rawId: string, wanted?: string): Promise<LinkedSource> => {
    const assetId = await resolveAssetAlias(rawId.trim());

    // Instance-owned bytes: straight out of the BlobStore, gated on whichever id
    // governs them (a pin is still governed by its ext/* row).
    if (assetId.startsWith(INST_PREFIX)) {
      const rec = await store.getInstanceAsset(assetId);
      if (!rec) return refuse(404, 'NOT_FOUND', 'no such instance asset');
      // A submission returned after the link was minted stops serving on it,
      // for the same reason a revoked asset does (plans/31 §3).
      if (!submissionServable(rec)) return goneSource();
      const isPin = !rec.exited && !!rec.origin;
      const govId = isPin ? extAssetId(rec.origin!.provider, rec.origin!.remoteId) : assetId;
      if ((await catalogBytesGate(govId, isPin)).blocked) return goneSource();
      const fmt = wanted ?? (rec.entry.formats?.[0]?.format as string | undefined) ?? Object.keys(rec.blobs)[0];
      const blobId = fmt ? rec.blobs[fmt] : undefined;
      if (!blobId || !fmt) return refuse(404, 'NOT_FOUND', 'no such format');
      const name = typeof rec.entry.name === 'string' ? rec.entry.name : assetId.split('/').pop() ?? assetId;
      return { kind: 'blob', blobId, filename: `${name}.${fmt}`, format: fmt };
    }

    // Federated bytes: pin-prefers-local, then the driver - identical to the
    // ext blob route, so a link survives upstream deletion exactly as a member's
    // own fetch does.
    if (assetId.startsWith(EXT_PREFIX)) {
      const [, providerId, remoteId] = assetId.split('/');
      if (!providerId || !remoteId) return refuse(404, 'NOT_FOUND', 'bad federated asset id');
      await providersReady;
      const rec = await store.getProvider(providerId);
      if (!rec) return refuse(404, 'NOT_FOUND', 'no such provider');
      if (!rec.enabled) return refuse(410, 'PROVIDER_DISABLED', 'this provider is disabled');
      if ((await catalogBytesGate(assetId, true)).blocked) return goneSource();
      const entry = await federatedEntry(providerId, assetId);
      const formats = (entry?.formats ?? []) as AssetFormatEntry[];
      const chosen = wanted ? formats.find((f) => f.format === wanted || f.url?.endsWith(`/${wanted}`)) : formats[0];
      const remoteRef = (chosen?.url ?? '').split('/').pop();
      if (!remoteRef) return refuse(404, 'NOT_FOUND', 'no such format');
      const format = String(chosen?.format ?? remoteRef);
      const filename = typeof chosen?.filename === 'string'
        ? chosen.filename
        : `${typeof entry?.name === 'string' ? entry.name : remoteId}.${format}`;
      const size = typeof chosen?.size === 'number' ? chosen.size : undefined;
      const pinned = await store.getInstanceAsset(materializedIdFor(providerId, remoteId));
      const localId = pinned ? pinned.blobs[pinned.refMap?.[remoteRef] ?? remoteRef] : undefined;
      if (localId && await blobs.head(localId)) return { kind: 'blob', blobId: localId, filename, format };
      return { kind: 'remote', provider: rec, remoteId, remoteRef, filename, format, ...(size !== undefined ? { size } : {}) };
    }

    // A pack asset: the file the index points at, read off the pack mount.
    const entry = (await loadAssetIndexById(config.instance.pack)).get(assetId);
    if (!entry) return refuse(404, 'NOT_FOUND', 'no such asset');
    if ((await catalogBytesGate(assetId, false)).blocked) return goneSource();
    const formats = entry.formats ?? [];
    const chosen = wanted ? formats.find((f) => f.format === wanted) : formats[0];
    const relPath = (chosen?.url ?? '').replace(/^\/+/, '').replace(/^catalog\//, '');
    if (!relPath || relPath.includes('..')) return refuse(404, 'NOT_FOUND', 'no such format');
    return {
      kind: 'file',
      absPath: join(config.instance.pack, 'catalog', relPath),
      filename: relPath.split('/').pop() ?? assetId,
      format: String(chosen?.format ?? relPath.split('.').pop() ?? ''),
      ...(typeof chosen?.size === 'number' ? { size: chosen.size } : {}),
    };
  };

  /** Read a resolved source into one Buffer, for the surfaces that cannot
   *  stream (the zip needs each member's CRC and length before its header goes
   *  out). `null` means the bytes could not be had - a driver that answers a
   *  redirect instead of a stream is the one real case, and the archive leaves
   *  that member out rather than the server chasing an upstream URL to
   *  manufacture bytes it was told to redirect for. */
  const readLinkedSource = async (source: LinkedSource): Promise<Buffer | null> => {
    if (source.kind === 'blob') {
      const blob = await blobs.get(source.blobId);
      if (!blob) return null;
      return Buffer.from(await new Response(blob.body as unknown as ReadableStream<Uint8Array>).arrayBuffer());
    }
    if (source.kind === 'file') {
      try {
        return await readFile(source.absPath);
      } catch {
        return null;
      }
    }
    if (source.kind === 'remote') {
      try {
        const blob = await federation.instantiate(source.provider).resolveBlob(source.remoteId, source.remoteRef);
        if (blob.kind === 'redirect') return null;
        return Buffer.from(await new Response(blob.body as unknown as ReadableStream<Uint8Array>).arrayBuffer());
      } catch {
        return null;
      }
    }
    return null;
  };

  /** Stream a resolved source to a bearer. One writer for every bearer-facing
   *  byte route, so the inert headers, the ETag and the attach decision cannot
   *  drift between a single asset link and a collection's per-item download. */
  const streamLinkedSource = async (
    req: IncomingMessage, res: ServerResponse, source: LinkedSource, attach: boolean,
  ): Promise<void> => {
    if (source.kind === 'refused') return sendError(res, source.status, source.code, source.message);
    if (source.kind === 'blob') {
      const stat = await blobs.head(source.blobId);
      if (!stat) return sendError(res, 404, 'NOT_FOUND', 'no such format');
      const etag = `"${stat.checksum}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, max-age=300' });
        res.end();
        return;
      }
      const blob = await blobs.get(source.blobId);
      if (!blob) return sendError(res, 404, 'NOT_FOUND', 'no such format');
      res.writeHead(200, linkedAssetHeaders(attach, blob.stat.contentType, source.filename, {
        etag, 'content-length': String(blob.stat.size),
      }));
      Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
      return;
    }
    if (source.kind === 'file') {
      let bytes: Buffer;
      try {
        bytes = await readFile(source.absPath);
      } catch {
        return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
      }
      res.writeHead(200, linkedAssetHeaders(attach, contentType(source.absPath), source.filename, {
        'content-length': String(bytes.length),
      }));
      res.end(bytes);
      return;
    }
    try {
      const blob = await federation.instantiate(source.provider).resolveBlob(source.remoteId, source.remoteRef);
      // A redirect hands the bearer the provider's own URL, exactly as the
      // member-facing blob route does - the driver, not us, decides whether a
      // format can be streamed.
      if (blob.kind === 'redirect') {
        res.writeHead(302, { location: blob.url, 'cache-control': 'private, no-store' });
        res.end();
        return;
      }
      res.writeHead(200, linkedAssetHeaders(attach, blob.contentType, source.filename,
        blob.size !== undefined ? { 'content-length': String(blob.size) } : {}));
      Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
    } catch {
      sendError(res, 502, 'PROVIDER_UNAVAILABLE', 'the upstream provider did not return this asset');
    }
  };

  const serveLinkedAsset = async (req: IncomingMessage, res: ServerResponse, link: LinkRecord): Promise<void> => {
    const source = await resolveLinkedSource(link.target.assetId ?? '', link.target.format);
    await streamLinkedSource(req, res, source, link.kind === 'download');
  };

  // ── collection links: a listing page and a zip (plans/31 §5) ──────────────
  // The boundary, restated where it is enforced rather than only where it is
  // described: everything below addresses `rec.members` and nothing else. There
  // is no search, no paging past the set, no self-registration, and no route
  // out of this collection into the rest of the catalog. A bearer holding this
  // signature reaches exactly the assets the curator listed, each one re-gated
  // on lifecycle at the moment it is served.

  /** How much a single zip-all may weigh. Classic ZIP (no ZIP64) tops out at
   *  4 GiB; this sits well under it, and a curated set that genuinely exceeds
   *  2 GiB is a bulk export, which is a different conversation from a link you
   *  send someone. Refused BEFORE any byte of the archive is written, so a
   *  bearer never receives a silently short zip. */
  const COLLECTION_ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

  type ServableSource = Exclude<LinkedSource, { kind: 'refused' }>;
  interface ResolvedMember { assetId: string; source: ServableSource; size?: number }

  /** Resolve every member of a collection through the shared gate, once, and
   *  keep what is servable. `withheld` is the count of members lifecycle (or a
   *  vanished record) refused - reported to the bearer as a number and never as
   *  a list, because naming an asset they may not have would be a reach past
   *  the set. */
  const resolveCollectionMembers = async (
    rec: CollectionRecord,
  ): Promise<{ members: ResolvedMember[]; withheld: number }> => {
    const members: ResolvedMember[] = [];
    let withheld = 0;
    for (const assetId of rec.members) {
      const source = await resolveLinkedSource(assetId);
      if (source.kind === 'refused') {
        withheld++;
        continue;
      }
      let size = source.kind === 'blob' ? (await blobs.head(source.blobId))?.size : source.size;
      if (size === undefined && source.kind === 'file') {
        size = await stat(source.absPath).then((s) => s.size).catch(() => undefined);
      }
      members.push({ assetId, source, ...(size !== undefined ? { size } : {}) });
    }
    return { members, withheld };
  };

  /** Human byte size for the listing page - the console's own rounding, in one
   *  line, because the page ships no script and no shared bundle. */
  const sizeText = (bytes: number | undefined): string | undefined => {
    if (bytes === undefined || !Number.isFinite(bytes)) return undefined;
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
  };

  /** The pack's brand chrome for the bearer page: the same unauthenticated
   *  logo/font/token sources the sign-in gate inherits, resolved server-side so
   *  the page needs no script and makes no request off this origin. */
  const bearerBrand = async (): Promise<Parameters<typeof collectionPageHtml>[0]['brand']> => {
    const chrome = await loadBrandChrome();
    const accent = chrome ? accentFromTokens(chrome.tokens) : undefined;
    const font = await brandFontFile();
    return {
      ...(chrome?.logos.light ? { logoLight: chrome.logos.light } : {}),
      ...(chrome?.logos.dark ? { logoDark: chrome.logos.dark } : {}),
      ...(accent ? { accent } : {}),
      ...(font ? { fontFamily: font.family, fontUrl: `/api/brand/font/${font.file}` } : {}),
    };
  };

  const serveLinkedCollection = async (
    req: IncomingMessage, res: ServerResponse, link: LinkRecord, url: URL,
  ): Promise<void> => {
    const rec = await store.getCollection(link.target.collectionId ?? '');
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such collection');

    // One member's bytes, addressed from the page. The membership check is the
    // boundary: an id the collection does not name is a 404 here even though
    // the signature is perfectly valid, so the link can never be walked into a
    // general-purpose asset fetcher.
    const wantAsset = url.searchParams.get('asset');
    if (wantAsset !== null) {
      if (!rec.members.includes(wantAsset)) {
        return sendError(res, 404, 'NOT_IN_COLLECTION', 'this link reaches this collection only');
      }
      const source = await resolveLinkedSource(wantAsset);
      return streamLinkedSource(req, res, source, url.searchParams.get('dl') === '1' || link.kind === 'download');
    }

    const { members, withheld } = await resolveCollectionMembers(rec);

    // A `download` link IS the zip; a `share` link offers it from its page.
    if (link.kind === 'download' || url.searchParams.get('zip') === '1') {
      const known = members.reduce((sum, m) => sum + (m.size ?? 0), 0);
      if (known > COLLECTION_ZIP_MAX_BYTES) {
        return sendError(res, 413, 'COLLECTION_TOO_LARGE',
          'this collection is too large to zip; download the assets individually');
      }
      const zip = new ZipBuilder();
      const used = new Set<string>();
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${safeFilename(rec.name)}.zip"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      for (const member of members) {
        const bytes = await readLinkedSource(member.source);
        if (!bytes) continue;
        res.write(zip.add(safeEntryName(member.source.filename, used), bytes));
      }
      res.end(zip.end());
      await audit(guestActor(link.id), 'catalog.collection.download', `collection:${rec.id}`, {
        linkId: link.id, entries: zip.count, withheld,
      });
      return;
    }

    const items: CollectionPageItem[] = members.map((m) => {
      const source = m.source;
      const base = `/l/${link.id}?s=${encodeURIComponent(url.searchParams.get('s') ?? '')}`;
      const pw = url.searchParams.get('pw');
      const carry = pw === null ? '' : `&pw=${encodeURIComponent(pw)}`;
      const asset = `&asset=${encodeURIComponent(m.assetId)}`;
      return {
        assetId: m.assetId,
        name: source.filename,
        format: source.format,
        ...(sizeText(m.size) ? { sizeText: sizeText(m.size) as string } : {}),
        ...(isPreviewableFormat(source.format) ? { previewHref: `${base}${carry}${asset}` } : {}),
        downloadHref: `${base}${carry}${asset}&dl=1`,
      };
    });
    const s = encodeURIComponent(url.searchParams.get('s') ?? '');
    const pw = url.searchParams.get('pw');
    const html = collectionPageHtml({
      instanceName: config.instance.name,
      name: rec.name,
      ...(rec.description ? { description: rec.description } : {}),
      items,
      withheld,
      zipHref: `/l/${link.id}?s=${s}${pw === null ? '' : `&pw=${encodeURIComponent(pw)}`}&zip=1`,
      expiresAt: new Date(link.exp * 1000).toISOString().slice(0, 10),
      brand: await bearerBrand(),
    });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The page is our own markup and ships no script. Locking it down to
      // same-origin images and inline style is what keeps a bearer surface from
      // becoming a place anything else can be loaded from.
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; font-src 'self'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  };

  // Whether an asset's bytes are durable locally. Pack + inst assets are already
  // local; a federated ext/* asset is pinned only once its bytes have been
  // materialized into the instance's own store (hold-implies-pin, plans/27 §3, §5).
  const isPinned = async (assetId: string): Promise<boolean> => {
    if (!assetId.startsWith(EXT_PREFIX)) return true;
    const parts = assetId.split('/'); // ext/<provider>/<remoteId>
    if (parts.length < 3) return false;
    return Boolean(await store.getInstanceAsset(materializedIdFor(parts[1] as string, parts[2] as string)));
  };
  const lifecycleView = async (r: LifecycleRow, now: number): Promise<Record<string, unknown>> => ({
    ...r,
    state: assetState(r, now),
    ...(r.hold ? { pinned: await isPinned(r.assetId) } : {}),
  });

  // ── catalog inspect: full metadata for one asset (member-readable) ────────
  // Metadata only - never bytes; the console links to the existing gated
  // /catalog/ preview path for the thumbnail. Merges the pack index entry with
  // the asset's lifecycle row + resolved state. 404 when the id is in neither.
  // The id carries slashes (e.g. 'suse/tokens/brand'), so it rides the trailing
  // wildcard, same as the lifecycle admin route.
  router.add('GET', '/api/v1/catalog/assets/*', async (req, res, ctx) => {
    const user = await memberOf(req);
    const p = principalOf(req);
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    // `<id>/versions` is the history of one asset's bytes (plans/31 §6). It
    // rides the same wildcard as inspect, the way `<id>/meta` rides the PUT.
    const raw = (ctx.params['*'] ?? '').trim();
    const wantsVersions = raw.endsWith('/versions');
    const id = wantsVersions ? raw.slice(0, -'/versions'.length) : raw;
    if (!id || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
    }
    const instAsset = id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
    if (wantsVersions) {
      // Versions belong to instance-owned bytes: a pack file and a federated
      // asset are versioned where they live, and claiming otherwise here would
      // invent a history this instance does not have.
      if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      if (!instAsset) return sendError(res, 404, 'NOT_FOUND', 'no such instance asset');
      if (!(await callerSeesAsset(user, id))) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
      const head = headVersionOf(instAsset);
      const rows = await assetVersionRows(instAsset);
      return sendJson(res, 200, {
        id, head,
        keep: config.policy.catalog.versionKeep,
        versions: [...rows].sort((a, b) => b.version - a.version).map((r) => versionView(r, head)),
      }, { 'cache-control': 'private, no-store' });
    }
    const entry = instAsset?.entry ?? (await loadAssetIndexById(config.instance.pack)).get(id);
    const row = await store.getLifecycle(id);
    // For a federated id the effective state can be constrained by an upstream
    // window as well as the local row; surface both so the console can show
    // where each constraint came from (plans/27 §2). Pack ids have no window.
    await providersReady;
    const [window, credential, meta, fieldDefs] = await Promise.all([
      federation.availabilityWindow(id), store.getCredential(id), store.getAssetMeta(id), store.listCatalogFields(),
    ]);
    // An overlay counts as existence too (plans/31 section 4): once an org has
    // filed an asset under its own taxonomy, this instance holds something to
    // say about that id even when the record itself lives upstream.
    if (!entry && !row && !window && !credential && !instAsset && !meta) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
    const { state } = combinedState(row ?? undefined, window, Date.now());
    const fields = servedFields(fieldDefs, meta);
    sendJson(res, 200, {
      id,
      ...(entry ?? {}),
      // The org's own metadata, the same bag the feed carries, plus the
      // definitions so the console can label and validate a row without a
      // second call. Absent definitions mean an org that has not defined any.
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(fieldDefs.length ? { fieldDefs } : {}),
      ...(meta ? { fieldsUpdatedBy: meta.updatedBy, fieldsUpdatedAt: meta.updatedAt } : {}),
      // ID-level supersession and the served version (plans/31 §6), so the
      // console can show "replaced by X" and "version N" without a second call.
      ...(meta?.replacedBy ? { replacedBy: meta.replacedBy } : {}),
      ...(instAsset ? { version: headVersionOf(instAsset) } : {}),
      // Whether THIS caller may edit any of it, so the console offers an editor
      // only where the PUT would actually be allowed rather than teaching
      // people that Save means 403. Descriptive fields are instance-owned
      // assets only, which the id already says.
      canEdit: user
        ? evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'catalog.edit', ['*'], await store.listGrants())
        : false,
      ...(window ?? {}),
      ...(instAsset?.origin ? { origin: instAsset.origin } : {}),
      ...(credential?.status === 'embedded' ? { credential: 'embedded' } : {}),
      state,
      lifecycle: row || window
        ? {
            state,
            validFrom: row?.validFrom ?? null,
            validUntil: row?.validUntil ?? null,
            revokedAt: row?.revokedAt ?? null,
            onExpiry: row?.onExpiry ?? 'hide',
            ...(row?.hold ? { hold: row.hold, pinned: await isPinned(id) } : {}),
            ...(window ? { upstream: { availableFrom: window.availableFrom ?? null, availableUntil: window.availableUntil ?? null } } : {}),
          }
        : null,
      // Detection, never a verdict: {present, container, when} - validation is
      // the reader's, in the console's verify view (plans/27 §4).
      credentials: credential
        ? { status: credential.status, ...(credential.container ? { container: credential.container } : {}), sniffedAt: credential.sniffedAt, ...(credential.sourceUpdatedAt ? { sourceUpdatedAt: credential.sourceUpdatedAt } : {}) }
        : null,
    }, { 'cache-control': 'private, max-age=30' });
  });

  // ── org-defined metadata (plans/31 §4) ────────────────────────────────────
  // Flat tags were the only taxonomy an org had, and the OSS asset schema is
  // closed, so the taxonomy lands beside it rather than inside it: DEFINITIONS
  // are policy (the policy-as-code document carries them), VALUES are a local
  // overlay keyed by catalog asset id - which is what lets `inst/*`, `ext/*`
  // and pack ids all take them, since only the first of those three owns a
  // record this instance could have added a column to.

  // The definitions, readable by any member: the editor needs them to render a
  // control, and a client that renders `fields` needs them to label a row.
  router.add('GET', '/api/v1/catalog/fields', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const grants = await store.listGrants();
    const canEdit = evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'catalog.edit', ['*'], grants);
    sendJson(res, 200, { fields: await store.listCatalogFields(), canEdit }, { 'cache-control': 'private, no-store' });
  });

  // Defining the taxonomy is `policy.edit`, the same gate as chains and flag
  // governance and for the same reason: it is governance, not content. The
  // route and the policy document share ONE normalizer, so a definition the
  // document accepts is exactly a definition this accepts.
  router.add('PUT', '/api/v1/catalog/fields/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'policy.edit');
    if (!user) return;
    const def = normalizeCatalogField(ctx.params.id as string, await readJson(req));
    if (!def) {
      return sendError(res, 400, 'INVALID_INPUT',
        'a field needs a slug id, a label, and kind text|select|date|url; a select needs options and nothing else may carry them');
    }
    const before = (await store.listCatalogFields()).find((f) => f.id === def.id) ?? null;
    await store.putCatalogField(def);
    await audit(`user:${user.id}`, 'catalog.field.edit', `catalog-field:${def.id}`, { before, after: def });
    sendJson(res, 200, def);
  });

  // Retiring a definition removes the DEFINITION only. Values filed under it
  // survive in the overlay, hidden from every served surface until the
  // definition comes back: a taxonomy change must not destroy the data filed
  // under it, and an org that renames a field by mistake has to be able to undo
  // it. The policy document's prune takes the same path.
  router.add('DELETE', '/api/v1/catalog/fields/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'policy.edit');
    if (!user) return;
    const id = ctx.params.id as string;
    const before = (await store.listCatalogFields()).find((f) => f.id === id);
    if (!before) return sendError(res, 404, 'NOT_FOUND', 'no such field');
    await store.deleteCatalogField(id);
    await audit(`user:${user.id}`, 'catalog.field.delete', `catalog-field:${id}`, { before });
    sendJson(res, 200, { ok: true, id });
  });

  /**
   * Edit one asset's metadata: `PUT /api/v1/catalog/assets/<id>/meta`.
   *
   * The id carries slashes ('suse/tokens/brand'), so it rides the trailing
   * wildcard with '/meta' as its last segment, the same shape the inspect and
   * lifecycle routes use.
   *
   * Two halves with different reach, and the asymmetry is the design:
   *   - `fields` (the org's own taxonomy) applies to ANY asset this caller can
   *     see, because the overlay is keyed by id and needs nothing from the
   *     record;
   *   - `name` / `description` / `tags` apply to `inst/*` only, and write
   *     through to the instance-asset record where the submit pipeline already
   *     keeps them. A federated asset keeps the upstream name: this instance
   *     does not own that record, and quietly shadowing a DAM's own title would
   *     make the two disagree with no way to tell which was authored here.
   *   - `replacedBy` (plans/31 §6) applies to any asset too, for the same
   *     reason `fields` does: it names a SUCCESSOR id, and a pack or federated
   *     asset can be retired in favour of a newer one just as an instance asset
   *     can.
   *
   * Exposure is `callerSeesAsset` - the same question link minting asks - so
   * nobody edits an asset they cannot see, and a submission still under review
   * is not editable here at all (it is not visible yet; its own PATCH is the
   * door, plans/31 section 3). Every change is audited with before and after.
   */
  router.add('PUT', '/api/v1/catalog/assets/*', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.edit');
    if (!user) return;
    const rest = (ctx.params['*'] ?? '').trim();
    const isHeadOp = rest.endsWith('/head');
    if (!rest.endsWith('/meta') && !isHeadOp) return sendError(res, 404, 'NOT_FOUND', 'no such route');
    const id = rest.slice(0, -(isHeadOp ? '/head' : '/meta').length);
    if (!id || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
    }
    await providersReady;
    // ROLLBACK (plans/31 §6): point the head at a version that already exists.
    // Nothing is copied and nothing is deleted - the version that was head
    // stays in the history, so a rollback is itself reversible. It is a
    // curation act on bytes that are already in the catalog, which is why it
    // rides `catalog.edit` beside the metadata editor rather than the
    // contribution right.
    if (isHeadOp) {
      if (!(await callerSeesAsset(user, id))) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
      const rec = id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
      if (!rec) return sendError(res, 400, 'INVALID_INPUT', 'only an instance-owned asset has versions');
      const body = (await readJson(req)) as { version?: unknown } | null;
      const wanted = Number((body ?? {}).version);
      if (!Number.isInteger(wanted) || wanted < 1) return sendError(res, 400, 'INVALID_INPUT', 'version must be a version number');
      const rows = await assetVersionRows(rec);
      const row = rows.find((r) => r.version === wanted);
      if (!row) return sendError(res, 404, 'NOT_FOUND', `no version ${wanted} of this asset`);
      const from = headVersionOf(rec);
      if (from === wanted) {
        return sendJson(res, 200, { ok: true, id, version: wanted, changed: false }, { 'cache-control': 'no-store' });
      }
      await store.putInstanceAsset(applyVersionToRecord(rec, row));
      // The bytes behind a stable id just changed, so every cached render that
      // could have consumed them has to miss (plans/31 §6).
      bustInstanceCatalog();
      await audit(`user:${user.id}`, 'catalog.rollback', `catalog:${id}`, { before: { version: from }, after: { version: wanted } });
      return sendJson(res, 200, { ok: true, id, version: wanted, changed: true, previous: from }, { 'cache-control': 'no-store' });
    }
    if (!(await callerSeesAsset(user, id))) return sendError(res, 404, 'NOT_FOUND', 'no such asset');

    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'INVALID_INPUT', 'body required');

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const defs = await store.listCatalogFields();

    // BOTH halves are parsed and validated before EITHER is written: an edit
    // that touches the name and a bad field value must refuse whole, or a
    // refusal would still have moved half of what it refused.

    // The descriptive half, bound for the instance-asset record.
    const instAsset = id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
    const wantsDescriptive = (['name', 'description', 'tags'] as const).some((k) => body[k] !== undefined);
    if (wantsDescriptive && !instAsset) {
      return sendError(res, 400, 'INVALID_INPUT',
        'only an instance-owned asset carries an editable name, description and tags; a federated or pack asset takes org-defined fields only');
    }
    const allowed: DescriptiveKey[] = ['name', 'description', 'tags'];
    const parsed = instAsset && wantsDescriptive ? parseDescriptivePatch(body, instAsset.entry, allowed) : null;
    if (parsed && 'error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);

    // The org-defined half, bound for the overlay.
    const stored = await store.getAssetMeta(id);
    let meta: AssetMetaRecord | null = stored;
    if (body.fields !== undefined) {
      if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
        return sendError(res, 400, 'INVALID_INPUT', 'fields must be an object of fieldId to value');
      }
      const applied = applyFieldPatch(defs, stored?.fields ?? {}, body.fields as Record<string, unknown>);
      if ('errors' in applied) return sendError(res, 400, 'INVALID_FIELDS', applied.errors.join('; '));
      meta = {
        assetId: id, fields: applied.values,
        ...(stored?.replacedBy ? { replacedBy: stored.replacedBy } : {}),
        ...(stored?.extractedText ? { extractedText: stored.extractedText } : {}),
        updatedBy: `user:${user.id}`, updatedAt: new Date().toISOString(),
      };
      before.fields = servedFields(defs, stored);
      after.fields = servedFields(defs, meta);
    }

    // Supersession (plans/31 §6): retire this asset in favour of another id.
    // The successor must be one this caller can SEE, for the reason a
    // collection may only hold visible members - a pointer at an id they were
    // never shown is a way to have the catalog name it for them. A cleared
    // value ('' or null) removes the pointer; the asset itself is untouched
    // either way, because supersession is advice to consumers and never a
    // takedown (that is what lifecycle is for, and the two compose).
    if (body.replacedBy !== undefined) {
      const parsedReplacement = parseReplacedBy(body.replacedBy, id);
      if ('error' in parsedReplacement) return sendError(res, 400, 'INVALID_INPUT', parsedReplacement.error);
      const successor = parsedReplacement.value;
      if (successor && !(await callerSeesAsset(user, successor))) {
        return sendError(res, 400, 'INVALID_INPUT', `you cannot see ${successor} - an asset can only be replaced by one you can see`);
      }
      const base = meta ?? stored;
      before.replacedBy = stored?.replacedBy ?? null;
      after.replacedBy = successor;
      meta = {
        assetId: id,
        fields: base?.fields ?? {},
        ...(successor ? { replacedBy: successor } : {}),
        ...(base?.extractedText ? { extractedText: base.extractedText } : {}),
        updatedBy: `user:${user.id}`,
        updatedAt: new Date().toISOString(),
      };
    }

    // On-device OCR text (plans/31 §7): the submitting or curating client posts
    // the words on the asset so search can find it by them; the server never
    // runs a model. It rides the same overlay as fields and supersession, so a
    // pack or federated asset (which owns no record here) gets it too. The audit
    // records the LENGTH that moved, never the text - the words are search
    // input, not something the audit trail needs to carry. A cleared value ('',
    // null, or whitespace that collapses to nothing) removes it.
    if (body.extractedText !== undefined) {
      const text = normalizeExtractedText(body.extractedText);
      const base = meta ?? stored;
      before.extractedText = stored?.extractedText?.length ?? 0;
      after.extractedText = text?.length ?? 0;
      meta = {
        assetId: id,
        fields: base?.fields ?? {},
        ...(base?.replacedBy ? { replacedBy: base.replacedBy } : {}),
        ...(text ? { extractedText: text } : {}),
        updatedBy: `user:${user.id}`,
        updatedAt: new Date().toISOString(),
      };
    }
    if (parsed && !('error' in parsed) && descriptiveTouched(parsed)) {
      Object.assign(before, parsed.before);
      Object.assign(after, parsed.after);
    }
    if (!Object.keys(after).length) return sendError(res, 400, 'INVALID_INPUT', 'nothing to change');

    let name = instAsset?.entry.name;
    if (instAsset && parsed && !('error' in parsed) && descriptiveTouched(parsed)) {
      const entry = applyDescriptivePatch(instAsset.entry, parsed);
      await store.putInstanceAsset({ ...instAsset, entry });
      name = entry.name;
    }
    if (meta && meta !== stored) await store.putAssetMeta(meta);
    await audit(`user:${user.id}`, 'catalog.edit', `catalog:${id}`, { before, after });
    sendJson(res, 200, {
      ok: true,
      id,
      ...(instAsset ? { name } : {}),
      fields: servedFields(defs, meta),
      ...(meta?.replacedBy ? { replacedBy: meta.replacedBy } : {}),
      // The char count, never the text: the client learns what it stored
      // without the response echoing back a page of OCR it just sent.
      ...(meta?.extractedText ? { extractedTextChars: meta.extractedText.length } : {}),
    }, { 'cache-control': 'no-store' });
  });

  /**
   * Delete one stored version: `DELETE /api/v1/catalog/assets/<id>/versions/<n>`.
   *
   * Two refusals do the work. The HEAD cannot be deleted - those are the bytes
   * the asset is serving, and rolling back first is the honest way to retire
   * them - and a HELD asset refuses entirely with `409 ASSET_HELD`, the same
   * answer a hold gives revocation, because a hold in this codebase only ever
   * preserves availability (plans/27 §3, plans/31 §6). Version numbers are
   * never reused afterwards.
   */
  router.add('DELETE', '/api/v1/catalog/assets/*', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.edit');
    if (!user) return;
    const match = /^(.+)\/versions\/(\d+)$/.exec((ctx.params['*'] ?? '').trim());
    if (!match) return sendError(res, 404, 'NOT_FOUND', 'no such route');
    const [, id, num] = match as unknown as [string, string, string];
    if (id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
    }
    await providersReady;
    if (!(await callerSeesAsset(user, id))) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
    const rec = id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
    if (!rec) return sendError(res, 400, 'INVALID_INPUT', 'only an instance-owned asset has versions');
    const version = Number(num);
    if (version === headVersionOf(rec)) {
      return sendError(res, 409, 'VERSION_IS_HEAD', 'this is the version the asset serves; roll back to another one first');
    }
    const hold = (await store.getLifecycle(id))?.hold;
    if (hold) {
      return sendError(res, 409, 'ASSET_HELD',
        hold.note ? `this asset is on hold: ${hold.note}` : 'this asset is on hold; release the hold before deleting any of its versions');
    }
    const rows = await store.listAssetVersions(id);
    const row = rows.find((r) => r.version === version);
    if (!row) return sendError(res, 404, 'NOT_FOUND', `no version ${version} of this asset`);
    await store.deleteAssetVersion(id, version);
    for (const blobId of orphanBlobIds([row], rows.filter((r) => r.version !== version))) await blobs.delete(blobId);
    await audit(`user:${user.id}`, 'catalog.version.delete', `catalog:${id}`, { version, at: row.at, by: row.by });
    sendJson(res, 200, { ok: true, id, version }, { 'cache-control': 'no-store' });
  });

  // ── collections (plans/31 §5) ─────────────────────────────────────────────
  // A named, ORDERED set of catalog assets with group visibility. Two surfaces,
  // deliberately different: THIS one is the curator's, gated on
  // `catalog.collection.manage` and showing the set as curated; the per-caller
  // FEED (`/catalog/assets/index.json`) is every member's, showing the
  // collections their groups admit with members narrowed to what they are
  // already being served. Neither is derived from the other.

  router.add('GET', '/api/v1/catalog/collections', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.collection.manage');
    if (!user) return;
    sendJson(res, 200, { collections: sortCollections(await store.listCollections()) }, { 'cache-control': 'private, no-store' });
  });

  router.add('GET', '/api/v1/catalog/collections/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.collection.manage');
    if (!user) return;
    const rec = await store.getCollection(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such collection');
    sendJson(res, 200, rec, { 'cache-control': 'private, no-store' });
  });

  /**
   * Create or update a collection.
   *
   * Everything rests on the membership check, which is why this route asks
   * `callerSeesAsset` for EVERY member: a collection LINK is
   * minted on the collection's own visibility alone, and its bearer then
   * receives every member. Without this check a curator whose
   * `catalog.collection.manage` grant is narrowed to one group could name
   * assets they cannot themselves see, mint a link, and read bytes their groups
   * were never exposed to - exposure laundered through a list. Asked at
   * curation time rather than at mint because that is where a person can be
   * told which id was refused.
   */
  router.add('PUT', '/api/v1/catalog/collections/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.collection.manage');
    if (!user) return;
    const id = ctx.params.id as string;
    const prior = await store.getCollection(id);
    const parsed = normalizeCollection(id, await readJson(req), {
      curator: `user:${user.id}`, now: new Date().toISOString(), prior,
    });
    if ('error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);
    await providersReady;
    const unseen: string[] = [];
    for (const memberId of parsed.members) {
      if (!(await callerSeesAsset(user, memberId))) unseen.push(memberId);
    }
    if (unseen.length) {
      return sendError(res, 403, 'MEMBER_NOT_VISIBLE',
        `you cannot see ${unseen.slice(0, 5).join(', ')} - a collection may only hold assets its curator can see`);
    }
    await store.putCollection(parsed);
    await audit(`user:${user.id}`, 'catalog.collection.edit', `collection:${id}`, { before: prior, after: parsed });
    sendJson(res, prior ? 200 : 201, parsed, { 'cache-control': 'no-store' });
  });

  // Deleting a collection deletes the LIST and nothing else: its members were
  // ordinary catalog assets that it never owned, and any live link to it simply
  // stops resolving (the resolver 404s on a collection that is gone).
  router.add('DELETE', '/api/v1/catalog/collections/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.collection.manage');
    if (!user) return;
    const id = ctx.params.id as string;
    const before = await store.getCollection(id);
    if (!before) return sendError(res, 404, 'NOT_FOUND', 'no such collection');
    await store.deleteCollection(id);
    await audit(`user:${user.id}`, 'catalog.collection.delete', `collection:${id}`, { before });
    sendJson(res, 200, { ok: true, id });
  });

  // On-demand content-credential scan (plans/27 §4): fetch the asset's primary
  // format once and sniff whether its BYTES embed a C2PA manifest the DAM's API
  // never surfaced. It costs an upstream fetch, so it is permissioned
  // (catalog.scan) and audited; it records only {present, container} - detection,
  // never a verdict. The id carries slashes, so it rides the trailing wildcard as
  // `scan/<id>` (the router matches only a trailing '*', not an '<id>/scan' tail).
  router.add('POST', '/api/v1/catalog/scan/*', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.scan');
    if (!user) return;
    const id = (ctx.params['*'] ?? '').trim();
    if (!id || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
    }
    await providersReady;
    let bytes: Uint8Array;
    let sourceUpdatedAt: string | undefined;
    try {
      if (id.startsWith(EXT_PREFIX)) {
        const [, pid, rid] = id.split('/');
        if (!pid || !rid) return sendError(res, 400, 'INVALID_INPUT', 'bad federated asset id');
        const rec = await store.getProvider(pid);
        if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
        if (!rec.enabled) return sendError(res, 410, 'PROVIDER_DISABLED', 'this provider is disabled');
        const frags = await federation.fragments();
        const entry = frags.find((f) => f.rec.id === pid)?.fragment.assets.find((a) => a.id === id);
        if (!entry) return sendError(res, 404, 'NOT_FOUND', 'asset is not federated');
        const remoteRef = (entry.formats?.[0]?.url ?? '').split('/').pop();
        if (!remoteRef) return sendError(res, 422, 'NO_FORMAT', 'asset has no fetchable format');
        const blob = await federation.instantiate(rec).resolveBlob(rid, remoteRef);
        if (blob.kind !== 'stream') return sendError(res, 422, 'SCAN_UNSUPPORTED', 'provider serves this format by redirect; cannot scan its bytes');
        bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
        if (typeof entry.updatedAt === 'string') sourceUpdatedAt = entry.updatedAt;
      } else {
        const entry = (await loadAssetIndexById(config.instance.pack)).get(id);
        if (!entry) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
        const url = entry.formats?.[0]?.url;
        const relPath = url ? url.replace(/^\/+/, '').replace(/^catalog\//, '') : '';
        if (!relPath || relPath.includes('..')) return sendError(res, 422, 'NO_FORMAT', 'asset has no fetchable format');
        bytes = await readFile(join(config.instance.pack, 'catalog', relPath));
        if (typeof entry.updatedAt === 'string') sourceUpdatedAt = entry.updatedAt;
      }
    } catch {
      return sendError(res, 502, 'SCAN_FAILED', 'could not fetch the asset bytes to scan');
    }
    const detection = await detectCredential(bytes);
    const credRow: CredentialRow = {
      assetId: id,
      status: detection.status,
      ...(detection.container ? { container: detection.container } : {}),
      sniffedAt: new Date().toISOString(),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    };
    await store.putCredential(credRow);
    await audit(`user:${user.id}`, 'catalog.scan', `asset:${id}`, { status: detection.status, container: detection.container ?? null });
    sendJson(res, 200, credRow);
  });

  // Store-derived dashboard stats the telemetry fold can't answer: catalog
  // inventory (count + lifecycle state breakdown) and project size (sessions
  // per project). Popularity/usage counts (top assets, export destinations)
  // ride the telemetry summary instead - see summarize().
  router.add('GET', '/api/v1/stats/overview', async (req, res) => {
    if (!(await requireAction(req, res, 'telemetry.view'))) return;
    const now = Date.now();
    const [index, lifecycle, projects, sessions, audits] = await Promise.all([
      loadAssetIndexById(config.instance.pack),
      store.listLifecycle(),
      store.listProjects(),
      store.listSessionsFiltered({}),
      store.listAudit(),
    ]);
    const rowById = new Map(lifecycle.map((r) => [r.assetId, r]));
    const byState = { live: 0, scheduled: 0, expired: 0, revoked: 0 };
    for (const id of index.keys()) byState[assetState(rowById.get(id), now)]++;
    // Sessions (tombstones already excluded by the store) counted per project.
    const itemsByProject = new Map<string, number>();
    for (const s of sessions) itemsByProject.set(s.projectId, (itemsByProject.get(s.projectId) ?? 0) + 1);
    const top = projects
      .map((p) => ({ id: p.id, name: p.name, items: itemsByProject.get(p.id) ?? 0, archived: Boolean(p.archivedAt) }))
      .sort((a, b) => b.items - a.items)
      .slice(0, 8);
    // Sync-conflict pressure (plans/23 §3.D): refused CAS writes + bulk skips,
    // folded from the audit log - the demand instrument behind plans/14 §9's
    // collab gate ("fighting over the conflict nudge is the signal").
    const conflictCutoff = now - 30 * 86400_000;
    let conflicts30d = 0;
    for (const e of audits) {
      if (Date.parse(e.at) < conflictCutoff) continue;
      if (e.action === 'session.conflict') conflicts30d += 1;
      else if (e.action === 'sessions.bulk') conflicts30d += Number(e.payload?.skipped ?? 0);
    }
    sendJson(res, 200, {
      catalog: { total: index.size, byState },
      projects: { total: projects.length, active: projects.filter((p) => !p.archivedAt).length, top },
      sessions: { total: sessions.length, conflicts30d },
    }, { 'cache-control': 'private, max-age=30' });
  });

  // Day-bucketed audit-action counts feeding the console's per-view activity
  // headers: every topic view charts its own slice of this one payload. Counts
  // only - no actors, subjects, or values - so it sits at the same disclosure
  // tier as /stats/overview (`telemetry.view`), and one fetch serves every
  // view (the console memoizes it). Zero-filled so a quiet day is a real 0 on
  // the chart, not a gap.
  router.add('GET', '/api/v1/stats/series', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'telemetry.view'))) return;
    const q = Number(ctx.url.searchParams.get('days') ?? '30');
    const span = Number.isFinite(q) ? Math.min(90, Math.max(7, Math.trunc(q))) : 30;
    const dayMs = 86400_000;
    const today = Date.now();
    const byDay = new Map<string, Record<string, number>>();
    const dates: string[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const date = new Date(today - i * dayMs).toISOString().slice(0, 10);
      dates.push(date);
      byDay.set(date, {});
    }
    for (const e of await store.listAudit()) {
      const bucket = byDay.get(e.at.slice(0, 10));
      if (!bucket) continue; // outside the window
      bucket[e.action] = (bucket[e.action] ?? 0) + 1;
    }
    sendJson(res, 200, { days: dates.map((date) => ({ date, counts: byDay.get(date)! })) },
      { 'cache-control': 'private, max-age=30' });
  });

  // Humane, merged activity timeline (audit log + attributed usage telemetry).
  // Behind audit.export since it surfaces audit content; the console renders it
  // under the Overview with filters, thumbnails, and deep links.
  router.add('GET', '/api/v1/activity', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    const p = ctx.url.searchParams;
    const [auditEvents, telemetry, users] = await Promise.all([
      store.listAudit(),
      store.listEvents(),
      store.listUsers(),
    ]);
    const nameById = new Map(users.map((u) => [u.id, displayName(u)]));
    const groupsByUser = new Map(users.map((u) => [u.id, u.groups]));
    const page = buildActivity(auditEvents, telemetry, nameById, {
      category: p.get('category'),
      actor: p.get('actor'),
      group: p.get('group'),
      day: p.get('day'),
      q: p.get('q'),
      before: p.get('before'),
      limit: Number(p.get('limit') ?? 50),
    }, groupsByUser);
    sendJson(res, 200, page, { 'cache-control': 'no-store' });
  });

  // ── catalog lifecycle admin (plans/06 §3: "stop sharing" as one action) ───
  router.add('GET', '/api/v1/catalog/lifecycle', async (req, res) => {
    if (!(await requireAction(req, res, 'catalog.expire'))) return;
    const now = Date.now();
    const rows = await store.listLifecycle();
    sendJson(res, 200, { rows: await Promise.all(rows.map((r) => lifecycleView(r, now))) });
  });

  // The wildcard is the assetId, which itself contains slashes (e.g.
  // 'suse/tokens/brand') - same trailing-wildcard support the catalog/admin
  // static routes use. Body merges onto any existing row; `revoke: true`
  // stamps revokedAt=now and is audited under its own action so "stop
  // sharing" reads distinctly from an ordinary expiry-date edit.
  //
  // A `hold` arm (`hold: {note?} | null`) rides the same PUT but is its own
  // operation (plans/27 §3): it needs `catalog.hold` rather than
  // `catalog.expire`, only ever touches the hold field (dates/revoke are left
  // as they are), and audits as catalog.hold / catalog.hold.release. A hold, in
  // turn, is deliberate friction: while it is set, revocation and any edit that
  // would make the asset unavailable now are refused 409 ASSET_HELD - release
  // the hold first.
  router.add('PUT', '/api/v1/catalog/lifecycle/*', async (req, res, ctx) => {
    const assetId = ctx.params['*'] as string;
    const body = (await readJson(req)) as
      | { validFrom?: string; validUntil?: string; onExpiry?: string; revoke?: boolean; hold?: { note?: string } | null }
      | null;
    const isHoldOp = body ? Object.prototype.hasOwnProperty.call(body, 'hold') : false;
    // Gate on the operation: holding/releasing is its own action.
    const user = await requireAction(req, res, isHoldOp ? 'catalog.hold' : 'catalog.expire');
    if (!user) return;
    if (!assetId) return sendError(res, 400, 'INVALID_INPUT', 'assetId required');
    if (body?.onExpiry && body.onExpiry !== 'hide' && body.onExpiry !== 'warn') {
      return sendError(res, 400, 'INVALID_INPUT', 'onExpiry must be hide or warn');
    }
    if (isHoldOp && body?.hold !== null && (typeof body?.hold !== 'object' || Array.isArray(body?.hold))) {
      return sendError(res, 400, 'INVALID_INPUT', 'hold must be an object or null');
    }
    const existing = await store.getLifecycle(assetId);
    const now = Date.now();

    // Held-asset friction: a non-hold edit that would make the asset go away
    // (revoke, or a date change that resolves to expired/scheduled now) is
    // refused while a hold is set. Non-removing edits (extending a window,
    // clearing an expiry) still go through, and a hold op is never blocked.
    if (!isHoldOp && existing?.hold) {
      const removes =
        body?.revoke === true ||
        (typeof body?.validUntil === 'string' && Date.parse(body.validUntil) <= now) ||
        (typeof body?.validFrom === 'string' && Date.parse(body.validFrom) > now);
      if (removes) {
        return sendError(res, 409, 'ASSET_HELD',
          existing.hold.note ? `this asset is on hold: ${existing.hold.note}` : 'this asset is on hold; release the hold before removing it');
      }
    }

    let row: LifecycleRow;
    let action: string;
    if (isHoldOp) {
      // Only the hold changes; every other field is preserved verbatim.
      row = {
        assetId,
        onExpiry: existing?.onExpiry ?? 'hide',
        ...(existing?.validFrom ? { validFrom: existing.validFrom } : {}),
        ...(existing?.validUntil ? { validUntil: existing.validUntil } : {}),
        ...(existing?.revokedAt ? { revokedAt: existing.revokedAt } : {}),
        ...(body?.hold ? { hold: { by: `user:${user.id}`, at: new Date().toISOString(), ...(body.hold.note ? { note: body.hold.note } : {}) } } : {}),
      };
      action = body?.hold ? 'catalog.hold' : 'catalog.hold.release';
    } else {
      row = {
        assetId,
        onExpiry: (body?.onExpiry as LifecycleRow['onExpiry']) ?? existing?.onExpiry ?? 'hide',
        ...(body?.validFrom !== undefined ? { validFrom: body.validFrom } : existing?.validFrom ? { validFrom: existing.validFrom } : {}),
        ...(body?.validUntil !== undefined ? { validUntil: body.validUntil } : existing?.validUntil ? { validUntil: existing.validUntil } : {}),
        ...(existing?.revokedAt ? { revokedAt: existing.revokedAt } : {}),
        ...(existing?.hold ? { hold: existing.hold } : {}),
      };
      if (body?.revoke === true) row.revokedAt = new Date().toISOString();
      action = body?.revoke === true ? 'catalog.revoke' : 'catalog.expire';
    }
    await store.putLifecycle(row);
    await audit(`user:${user.id}`, action, `asset:${assetId}`, {
      validFrom: row.validFrom ?? null, validUntil: row.validUntil ?? null, onExpiry: row.onExpiry,
      revoked: Boolean(row.revokedAt), held: Boolean(row.hold), ...(row.hold?.note ? { note: row.hold.note } : {}),
    });
    // Hold implies pin (plans/27 §3): setting a hold on a federated asset
    // materializes its bytes so they survive upstream deletion. Best-effort - 
    // the hold itself (feed + action protection) already succeeded; a pin
    // failure (provider down/disabled) is logged, not fatal, and the row honestly
    // reads pinned:false until a later materialize succeeds.
    if (row.hold && assetId.startsWith(EXT_PREFIX)) {
      const parts = assetId.split('/');
      const pid = parts[1];
      if (pid && parts[2] && !(await isPinned(assetId))) {
        try {
          await providersReady;
          const prov = await store.getProvider(pid);
          if (prov?.enabled) await pinAsset({ store, blobs, federation }, prov, parts[2] as string);
        } catch (err) {
          console.error(`hold-implies-pin failed for ${assetId}:`, (err as Error).message);
        }
      }
    }
    sendJson(res, 200, await lifecycleView(row, Date.now()));
  });

  // ── catalog submit (plans/31 §3) ─────────────────────────────────────────
  // The inbound-bytes route for members: `catalog.submit` finally has something
  // behind it, so an org can ADD to its catalog rather than only govern what a
  // DAM already holds. Bytes ride the raw body and the declared metadata rides
  // query params, exactly like publish-out one surface over.

  const submitDeps = () => ({
    store, blobs, policy: config.policy.submit,
    ...(config.submit.scanHook ? { scanHook: config.submit.scanHook } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  /** The console/CLI view of one submission: the record's own descriptive entry
   *  plus the submission block, with the submitter resolved to a display name. */
  const submissionView = (
    rec: InstanceAssetRecord, actors: Map<string, ActorInfo>, fields: Record<string, string> = {},
  ): Record<string, unknown> => {
    const s = rec.submission as AssetSubmission;
    const who = actors.get(s.by.replace(/^user:/, ''));
    return {
      id: rec.id,
      name: rec.entry.name ?? rec.id,
      type: rec.entry.type ?? 'image',
      ...(rec.entry.description ? { description: rec.entry.description } : {}),
      tags: rec.entry.tags ?? [],
      formats: (rec.entry.formats ?? []).map((f) => f.format),
      groups: rec.groups ?? '*',
      state: s.state,
      by: s.by,
      byName: who?.name ?? s.by,
      at: s.at,
      size: s.size,
      checksum: s.checksum,
      ...(s.contentType ? { contentType: s.contentType } : {}),
      ...(s.width && s.height ? { width: s.width, height: s.height } : {}),
      ...(s.approvalId ? { approvalId: s.approvalId } : {}),
      ...(s.decidedBy ? { decidedBy: s.decidedBy } : {}),
      ...(s.decidedAt ? { decidedAt: s.decidedAt } : {}),
      ...(s.comment ? { comment: s.comment } : {}),
      // The org's own metadata (plans/31 section 4), so the review queue shows
      // and edits the same taxonomy the published asset will carry.
      ...(Object.keys(fields).length ? { fields } : {}),
      preview: `/api/v1/catalog/submissions/${rec.id.slice(INST_PREFIX.length)}/bytes`,
    };
  };

  /**
   * What this caller is to one submission: `mine` when they submitted it,
   * `inbox` when the approval's current step lets their groups act, and null
   * when it is neither. The queue rows, the pre-publication preview and the
   * metadata edit all ask this one question, so the three surfaces cannot
   * disagree about who is looking at a pending asset.
   */
  const submissionRelation = async (
    rec: InstanceAssetRecord, user: { id: string; groups: string[] },
  ): Promise<'mine' | 'inbox' | null> => {
    const s = rec.submission as AssetSubmission;
    if (s.by === `user:${user.id}`) return 'mine';
    if (!s.approvalId) return null;
    const approval = await store.getApproval(s.approvalId);
    return approval && eligibleForCurrentStep(approval, user.groups) ? 'inbox' : null;
  };

  /**
   * Settle one terminal approval against the submission it gates, then audit
   * and tell the submitter. Called from BOTH decision paths - the catalog
   * review queue and the plain approvals inbox - so an asset can never be left
   * in `submitted` behind a closed approval.
   */
  const settleAssetSubmission = async (approval: Approval, actorId: string): Promise<boolean> => {
    const settled = await settleSubmission(store, approval, new Date().toISOString());
    if (!settled) return false;
    const action = settled.state === 'live' ? 'catalog.approve-submission' : 'catalog.return-submission';
    await audit(`user:${actorId}`, action, `catalog:${settled.record.id}`, {
      approvalId: approval.id, ...(settled.comment ? { comment: settled.comment } : {}),
    });
    const submitterId = (settled.record.submission?.by ?? '').replace(/^user:/, '');
    if (!submitterId) return true;
    await store.putMessage({
      id: `msg_${randomId(8)}`,
      kind: 'approval', severity: settled.state === 'live' ? 'info' : 'action',
      audience: { users: [submitterId] },
      title: settled.state === 'live'
        ? `Published: ${settled.record.entry.name ?? settled.record.id}`
        : `Returned: ${settled.record.entry.name ?? settled.record.id}`,
      body: settled.state === 'live'
        ? 'Your catalog submission was approved and is live.'
        : `Your catalog submission was returned${settled.comment ? `: “${settled.comment}”` : '.'}`,
      cta: { label: 'View', url: '/admin#/catalog' },
      data: { assetId: settled.record.id, state: settled.state },
      dismissible: true,
    });
    return true;
  };

  router.add('POST', '/api/v1/catalog/submit', async (req, res, ctx) => {
    // `?assetId=inst/<id>` makes this a NEW VERSION of an asset that is already
    // in the catalog (plans/31 §6) rather than a new asset. Same route, same
    // pipeline, different gate: contributing an asset is `catalog.submit`, and
    // replacing the bytes of a published one is `catalog.edit`, the curation
    // right that already governs editing what a served asset says. That split
    // is also why a submit chain does not gate a version: an approver already
    // decided this asset belongs here.
    const targetId = (ctx.url.searchParams.get('assetId') ?? '').trim();
    const user = await requireAction(req, res, targetId ? 'catalog.edit' : 'catalog.submit');
    if (!user) return;
    let target: InstanceAssetRecord | null = null;
    if (targetId) {
      if (!targetId.startsWith(INST_PREFIX)) {
        return sendError(res, 400, 'INVALID_INPUT', 'only an instance-owned asset takes new versions; a federated or pack asset is versioned where it lives');
      }
      target = await store.getInstanceAsset(targetId);
      if (!target || !(await callerSeesAsset(user, targetId))) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
      // A PIN is a local copy of a federated asset whose IDENTITY is still the
      // provider's (plans/27 §5): the feed serves the ext/* entry and the ext
      // blob route maps its formats through `refMap`. Versioning one would fork
      // it from the upstream record it still claims to be, so it is refused
      // until the exit's cutover makes the identity this instance's own.
      if (target.origin && !target.exited) {
        return sendError(res, 409, 'ASSET_IS_PINNED',
          `these bytes are a local copy of ${target.origin.provider}'s asset and still carry its identity; cut the provider over before versioning them here`);
      }
      // Descriptive metadata and exposure have their own doors, and quietly
      // ignoring them here would let a caller believe they had moved.
      for (const key of ['groups', 'type', 'description', 'tags'] as const) {
        if (ctx.url.searchParams.get(key) !== null) {
          return sendError(res, 400, 'INVALID_INPUT', `${key} is not part of a new version - edit it with PUT /api/v1/catalog/assets/${targetId}/meta`);
        }
      }
    }
    const name = (ctx.url.searchParams.get('name') ?? '').trim();
    if (!name && !target) return sendError(res, 400, 'INVALID_INPUT', 'name query param required');
    const maxBytes = config.policy.submit.maxBytes;
    let bytes: Buffer;
    try {
      bytes = await readRaw(req, maxBytes);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `submission exceeds the ${maxBytes} byte cap (policy.submit.maxBytes)`);
    }
    if (!bytes.length) return sendError(res, 400, 'INVALID_INPUT', 'empty submission body');
    const list = (key: string): string[] =>
      (ctx.url.searchParams.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // Exposure can only ever be narrowed to groups the submitter is in: nobody
    // publishes into a group they are not a member of.
    const declaredGroups = list('groups');
    const outsider = declaredGroups.filter((g) => !user.groups.includes(g));
    if (outsider.length) return sendError(res, 403, 'FORBIDDEN', `you are not in ${outsider.join(', ')}, so you cannot submit into it`);
    const type = (ctx.url.searchParams.get('type') ?? '').trim();
    if (type && !/^[a-z0-9-]{1,32}$/i.test(type)) return sendError(res, 400, 'INVALID_INPUT', 'type must be a short slug');

    const outcome = await submitAsset(submitDeps(), {
      bytes,
      ...(target ? { target } : {}),
      ...(ctx.url.searchParams.get('note') ? { note: (ctx.url.searchParams.get('note') as string).slice(0, 500) } : {}),
      name: (name || String(target?.entry.name ?? targetId)).slice(0, 200),
      ...(ctx.url.searchParams.get('description') ? { description: (ctx.url.searchParams.get('description') as string).slice(0, 500) } : {}),
      tags: list('tags').slice(0, 32),
      ...(type ? { type } : {}),
      ...(declaredGroups.length ? { groups: declaredGroups } : {}),
      ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
      submitter: { id: user.id, groups: user.groups },
    });

    if (!outcome.ok) {
      // The verdict is audited either way: a refusal is exactly the event an
      // operator needs to see, and nothing was stored to hang it off otherwise.
      await audit(`user:${user.id}`, 'catalog.submit', `catalog:rejected`, {
        outcome: outcome.code, detail: outcome.detail, name, size: bytes.length,
      });
      // A misconfigured review chain is the instance's fault, not the
      // submitter's, so it reads as unavailable rather than as a bad request.
      const status = outcome.code === 'QUOTA_EXCEEDED' ? 409
        : outcome.code === 'SCAN_REJECTED' ? 422
          : outcome.code === 'SUBMIT_CHAIN_MISSING' ? 503 : 502;
      return sendError(res, status, outcome.code, outcome.detail);
    }

    // Whatever the ending, the bytes an instance asset serves have changed, so
    // the render cache key's instance half has to move with them (plans/31 §6).
    if (!outcome.duplicate) bustInstanceCatalog();
    // Retention runs AFTER the version landed, never before: a trim that made
    // room first would delete history for a submission that then failed.
    const trimmed = target && !outcome.duplicate ? await trimVersionHistory(outcome.record) : 0;

    const state = outcome.record.submission?.state ?? 'live';
    await audit(`user:${user.id}`, target ? 'catalog.version' : 'catalog.submit', `catalog:${outcome.record.id}`, {
      outcome: outcome.duplicate ? 'duplicate' : state,
      checksum: outcome.checksum, size: bytes.length, scan: outcome.scan,
      credential: outcome.credential,
      ...(outcome.version ? { version: outcome.version } : {}),
      ...(trimmed ? { trimmed } : {}),
      ...(outcome.approval ? { approvalId: outcome.approval.id } : {}),
    });
    sendJson(res, outcome.duplicate ? 200 : 201, {
      ok: true,
      assetId: outcome.record.id,
      duplicate: outcome.duplicate,
      state,
      checksum: outcome.checksum,
      size: bytes.length,
      scan: outcome.scan,
      credential: outcome.credential,
      formats: (outcome.record.entry.formats ?? []).map((f) => f.format),
      ...(outcome.version ? { version: outcome.version } : {}),
      ...(trimmed ? { trimmed } : {}),
      ...(outcome.approval ? { approvalId: outcome.approval.id } : {}),
    }, { 'cache-control': 'no-store' });
  });

  // The review queue. `catalog.read` gates it, and the ROWS are the gate: a
  // caller sees their own submissions plus the ones open on a step their groups
  // may act on, the same two-sided rule the approvals list uses.
  router.add('GET', '/api/v1/catalog/submissions', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const wanted = ctx.url.searchParams.get('state');
    const state = wanted === 'submitted' || wanted === 'live' || wanted === 'returned' ? wanted : undefined;
    const actors = await actorsMap();
    const [defs, metas] = await Promise.all([store.listCatalogFields(), store.listAssetMeta()]);
    const metaById = new Map(metas.map((m) => [m.assetId, m]));
    const rows: Array<Record<string, unknown>> = [];
    for (const rec of listSubmissions(await store.listInstanceAssets(), state)) {
      const relation = await submissionRelation(rec, user);
      if (relation) rows.push({ ...submissionView(rec, actors, servedFields(defs, metaById.get(rec.id))), relation });
    }
    sendJson(res, 200, { submissions: rows }, { 'cache-control': 'no-store' });
  });

  // Preview bytes for a submission still under review. The public blob route
  // refuses a non-live submission on purpose, so the reviewer's preview needs
  // its own door - open to the submitter and to whoever may act on the step.
  router.add('GET', '/api/v1/catalog/submissions/:id/bytes', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const rec = await store.getInstanceAsset(`${INST_PREFIX}${ctx.params.id as string}`);
    if (!rec?.submission) return sendError(res, 404, 'NOT_FOUND', 'no such submission');
    // Only the submitter and whoever may act on the step see a PENDING
    // submission's bytes. Once it is live the ordinary exposure rule takes
    // over, so this route keeps working for an already-published asset.
    if (!(await submissionRelation(rec, user)) && !(submissionServable(rec) && instanceAssetVisible(rec, user.groups))) {
      return sendError(res, 403, 'FORBIDDEN', 'not yours to review');
    }
    // Once it is published this row is an ordinary catalog asset, so it answers
    // to the ordinary lifecycle gate: a revoked, expired or scheduled asset
    // stops serving HERE too, or a takedown would leave the bytes one URL away
    // for its submitter and for every member who can see it. Only a submission
    // still awaiting its decision skips the gate, and only because it has no
    // lifecycle row yet - it gets one when it goes live.
    if (submissionServable(rec) && (await catalogBytesGate(rec.id, false)).blocked) {
      return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
    }
    const blobId = Object.values(rec.blobs)[0];
    const blob = blobId ? await blobs.get(blobId) : null;
    if (!blob) return sendError(res, 404, 'NOT_FOUND', 'no stored bytes');
    res.writeHead(200, {
      'content-type': blob.stat.contentType,
      ...INERT_BYTES,
      'cache-control': 'private, no-store',
      'content-length': String(blob.stat.size),
    });
    Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
  });

  // Metadata edit BEFORE approval (plans/31 section 3), the middle affordance
  // of the review queue. A reviewer who would otherwise return a submission
  // over a mistyped name can correct it and publish instead, and a submitter
  // can fix their own while it waits. Two limits keep it from quietly becoming
  // a second asset editor: it touches DESCRIPTIVE metadata only - never the
  // bytes, never exposure, which stays where the submitter set it - and it
  // refuses once the submission has settled, because after that the row is an
  // ordinary catalog asset and belongs to the asset editor plans/31 section 4
  // builds. Every field that moves is audited with its before and after.
  router.add('PATCH', '/api/v1/catalog/submissions/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const rec = await store.getInstanceAsset(`${INST_PREFIX}${ctx.params.id as string}`);
    if (!rec?.submission) return sendError(res, 404, 'NOT_FOUND', 'no such submission');
    if (rec.submission.state !== 'submitted') {
      return sendError(res, 409, 'ALREADY_SETTLED', `this submission is already ${rec.submission.state}`);
    }
    const relation = await submissionRelation(rec, user);
    if (!relation) return sendError(res, 403, 'FORBIDDEN', 'not yours to edit');
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'INVALID_INPUT', 'body required');
    // The descriptive rules live in ONE place (catalog/asset-meta.ts) because
    // two surfaces edit exactly these four fields - here, before publication,
    // and the asset editor afterwards (plans/31 section 4). They differ in when
    // they apply and in which keys they allow, never in what a name may be.
    const parsed = parseDescriptivePatch(body, rec.entry, ['name', 'type', 'description', 'tags']);
    if ('error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);
    const before: Record<string, unknown> = { ...parsed.before };
    const after: Record<string, unknown> = { ...parsed.after };

    // Org-defined fields ride the same overlay a published asset uses, so a
    // reviewer fills the taxonomy in BEFORE publishing and the values are
    // already there the moment the asset reaches the feed - no second edit on
    // the other side of the decision, and no second store to reconcile.
    let meta = await store.getAssetMeta(rec.id);
    if (body.fields !== undefined) {
      if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
        return sendError(res, 400, 'INVALID_INPUT', 'fields must be an object of fieldId to value');
      }
      const defs = await store.listCatalogFields();
      const applied = applyFieldPatch(defs, meta?.fields ?? {}, body.fields as Record<string, unknown>);
      if ('errors' in applied) return sendError(res, 400, 'INVALID_FIELDS', applied.errors.join('; '));
      before.fields = servedFields(defs, meta);
      meta = {
        assetId: rec.id, fields: applied.values,
        ...(meta?.extractedText ? { extractedText: meta.extractedText } : {}),
        updatedBy: `user:${user.id}`, updatedAt: new Date().toISOString(),
      };
      after.fields = servedFields(defs, meta);
    }

    // The submitting client attaches the on-device OCR text here, before
    // publication (plans/31 §7): it is the submitter's own reading of their own
    // file, so it rides the review queue's door rather than needing the
    // curation right the live asset editor asks for. Same overlay, whitespace
    // collapsed and capped, folded into search and kept off the feed - and the
    // fields it shares the row with survive an OCR-only edit.
    if (body.extractedText !== undefined) {
      const text = normalizeExtractedText(body.extractedText);
      before.extractedText = meta?.extractedText?.length ?? 0;
      after.extractedText = text?.length ?? 0;
      meta = {
        assetId: rec.id,
        fields: meta?.fields ?? {},
        ...(text ? { extractedText: text } : {}),
        updatedBy: `user:${user.id}`, updatedAt: new Date().toISOString(),
      };
    }
    if (!Object.keys(after).length) return sendError(res, 400, 'INVALID_INPUT', 'nothing to change');
    const next: InstanceAssetRecord = { ...rec, entry: applyDescriptivePatch(rec.entry, parsed) };
    await store.putInstanceAsset(next);
    if ((after.fields !== undefined || after.extractedText !== undefined) && meta) await store.putAssetMeta(meta);
    await audit(`user:${user.id}`, 'catalog.edit-submission', `catalog:${rec.id}`, { before, after, relation });
    sendJson(res, 200, {
      ok: true,
      submission: {
        ...submissionView(next, await actorsMap(), servedFields(await store.listCatalogFields(), meta)),
        relation,
      },
    }, { 'cache-control': 'no-store' });
  });

  // Approve or return one submission. Delegates to the approvals engine, so
  // separation of duties and step eligibility are decided in exactly one place;
  // this route only exists so the catalog review queue does not have to send
  // its reviewers to a different screen.
  router.add('POST', '/api/v1/catalog/submissions/:id/act', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const rec = await store.getInstanceAsset(`${INST_PREFIX}${ctx.params.id as string}`);
    if (!rec?.submission) return sendError(res, 404, 'NOT_FOUND', 'no such submission');
    if (rec.submission.state !== 'submitted') return sendError(res, 409, 'ALREADY_SETTLED', `this submission is already ${rec.submission.state}`);
    const approvalId = rec.submission.approvalId;
    if (!approvalId) return sendError(res, 409, 'NO_CHAIN', 'this submission is not under review');
    const approval = await store.getApproval(approvalId);
    if (!approval) return sendError(res, 404, 'NOT_FOUND', 'the approval for this submission is gone');
    const body = (await readJson(req)) as { action?: string; comment?: string } | null;
    if (body?.action !== 'approve' && body?.action !== 'reject') return sendError(res, 400, 'INVALID_INPUT', 'action must be approve or reject');
    const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.slice(0, 2000) : undefined;
    let next: Approval;
    try {
      next = applyAction(approval, { id: user.id, groups: user.groups }, body.action, comment, new Date().toISOString());
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'INVALID_INPUT';
      return sendError(res, approvalStatus(code), code, (err as Error).message);
    }
    await store.putApproval(next);
    await audit(`user:${user.id}`, body.action === 'approve' ? 'approval.approve' : 'approval.reject',
      `approval:${next.id}`, { state: next.state, step: approval.stepIndex });
    if (isTerminal(next.state)) await settleAssetSubmission(next, user.id);
    const settled = await store.getInstanceAsset(rec.id);
    sendJson(res, 200, {
      ok: true, assetId: rec.id, state: settled?.submission?.state ?? rec.submission.state,
      approval: serializeApproval(next, user.id, undefined, await actorsMap()),
    }, { 'cache-control': 'no-store' });
  });

  // ── grants control plane (plans/03) ───────────────────────────────────────
  // The fine-grained RBAC layer under everything else. `grant.edit` is admin,
  // with one escalation guard: grants touching an owner-only action can be
  // created or deleted ONLY by an owner - otherwise an admin could mint
  // themselves instance.config or the provider credential powers.
  const readGrantBody = (raw: unknown): Grant | { error: string } => {
    const b = raw as Partial<Grant> | null;
    if (!b || typeof b !== 'object') return { error: 'body required' };
    if (typeof b.principal !== 'string' || !/^(\*|group:.+|user:.+)$/.test(b.principal)) {
      return { error: "principal must be '*', 'group:<name>', or 'user:<id>'" };
    }
    if (typeof b.action !== 'string' || !b.action.trim()) return { error: 'action required' };
    if (typeof b.resource !== 'string' || !b.resource.trim()) return { error: "resource required ('*' for all)" };
    if (b.effect !== 'allow' && b.effect !== 'deny') return { error: 'effect must be allow or deny' };
    return { principal: b.principal, action: b.action.trim(), resource: b.resource.trim(), effect: b.effect };
  };

  const grantMutation = async (req: IncomingMessage, res: ServerResponse, op: 'create' | 'delete'): Promise<void> => {
    const user = await requireAction(req, res, 'grant.edit');
    if (!user) return;
    const grant = readGrantBody(await readJson(req));
    if ('error' in grant) return sendError(res, 400, 'INVALID_INPUT', grant.error);
    if (ownerOnlyAction(grant.action) && user.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY_ACTION',
        `grants for "${grant.action}" can only be edited by an owner`);
    }
    if (op === 'create') await store.putGrant(grant);
    else await store.deleteGrant(grant);
    await audit(`user:${user.id}`, `grant.${op}`, `grant:${grant.principal}`, { ...grant });
    sendJson(res, op === 'create' ? 201 : 200, { ok: true, grant });
  };

  router.add('GET', '/api/v1/grants', async (req, res) => {
    if (!(await requireAction(req, res, 'grant.edit'))) return;
    sendJson(res, 200, { grants: await store.listGrants() });
  });
  router.add('POST', '/api/v1/grants', (req, res) => grantMutation(req, res, 'create'));
  router.add('DELETE', '/api/v1/grants', (req, res) => grantMutation(req, res, 'delete'));

  // ── tool policy overlays control plane (plans/03 §4) ─────────────────────
  // The governance surface admins AND brand teams use: `policy.edit` is admin
  // by default and grantable to a group (e.g. group:brand → policy.edit → *),
  // so a brand team can govern tool inputs without holding the admin role.

  /** Declared inputs with enough manifest shape to drive the editor (id +
   *  type/label/options verbatim). Direct read - this is the ADMIN surface,
   *  never filtered by the caller's own overlay access. */
  const readToolManifestInputs = async (toolId: string): Promise<Array<Record<string, unknown>> | null> => {
    if (!/^[a-z0-9-]+$/i.test(toolId)) return null;
    try {
      const manifest = JSON.parse(
        await readFile(join(config.instance.pack, 'tools', toolId, 'tool.json'), 'utf8'),
      ) as { inputs?: Array<Record<string, unknown>> };
      return Array.isArray(manifest.inputs)
        ? manifest.inputs.filter((i) => typeof i?.id === 'string')
            .map(({ id, type, label, options, default: def, min, max }) => ({
              id, ...(type !== undefined ? { type } : {}), ...(label !== undefined ? { label } : {}),
              ...(options !== undefined ? { options } : {}), ...(def !== undefined ? { default: def } : {}),
              ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
            }))
        : [];
    } catch {
      return null;
    }
  };

  // Every tool in the pack (unfiltered - governing a tool you've hidden from
  // yourself must stay possible), joined with its overlay + declared inputs.
  router.add('GET', '/api/v1/policy/tools', async (req, res) => {
    if (!(await requireAction(req, res, 'policy.edit'))) return;
    let ids: string[] = [];
    let names = new Map<string, string>();
    const icons = new Map<string, string>(); // tool id → inline SVG tile icon
    try {
      const idx = JSON.parse(await readFile(join(config.instance.pack, 'catalog', 'tools', 'index.json'), 'utf8')) as {
        tools?: Array<{ id?: string; name?: string; icon?: string }>;
      };
      ids = (idx.tools ?? []).map((t) => t.id).filter((id): id is string => typeof id === 'string');
      names = new Map((idx.tools ?? [])
        .filter((t): t is { id: string; name: string } => typeof t.id === 'string' && typeof t.name === 'string')
        .map((t) => [t.id, t.name]));
      for (const t of idx.tools ?? []) {
        if (typeof t.id === 'string' && typeof t.icon === 'string') icons.set(t.id, t.icon);
      }
    } catch {
      /* no tools index — an overlay-only listing still serves below */
    }
    const overlays = await store.listOverlays();
    for (const toolId of overlays.keys()) if (!ids.includes(toolId)) ids.push(toolId);
    const tools = await Promise.all(ids.map(async (id) => ({
      id,
      name: names.get(id) ?? id,
      icon: icons.get(id) ?? null,
      inputs: await readToolManifestInputs(id),
      overlay: overlays.get(id) ?? null,
    })));
    sendJson(res, 200, { tools });
  });

  router.add('PUT', '/api/v1/policy/overlays/:toolId', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'policy.edit');
    if (!user) return;
    const toolId = ctx.params.toolId as string;
    const existing = (await store.listOverlays()).get(toolId);
    const overlay = normalizeOverlay(toolId, await readJson(req), existing?.version ?? 0);
    if (!overlay) {
      return sendError(res, 400, 'INVALID_INPUT',
        'overlay must be {inputAccess?: {input: [{groups[], level, value?, allow?}]}, visibility?: {groups[]}, enforce?, defaults?}');
    }
    await store.putOverlay(overlay);
    // Policy moved: cached renders of this tool are stale (the cache key folds
    // policyVersion, but a value set BACK to a previously-rendered one would
    // hit old bytes - same reasoning as the bulk-edit bust).
    invalidateRenderByTool(toolId);
    await audit(`user:${user.id}`, 'policy.overlay.edit', `tool:${toolId}`, {
      version: overlay.version,
      before: existing ?? null,
      after: overlay,
    });
    sendJson(res, 200, overlay);
  });

  // ── feature-flag governance (plans/04) ────────────────────────────────────
  // The control plane's default state + toggle visibility for the shell's
  // per-user feature flags. Same policy.edit gate as tool overlays: admin by
  // default, delegable to a brand group. Read the whole governable catalogue…
  router.add('GET', '/api/v1/policy/flags', async (req, res) => {
    if (!(await requireAction(req, res, 'policy.edit'))) return;
    const gov = await store.listFlagGovernance();
    sendJson(res, 200, { flags: flagGovernanceCatalog(gov) });
  });

  // …and set one flag's governance. Body: {default?: 'on'|'off'|null,
  // visibility?: 'show'|'hide'}. A no-opinion record clears the row (inherit +
  // shown). Governance folds into org-config's policyVersion, so a save busts
  // connected shells' ETag on their next poll - the surprise lights up on flip.
  router.add('PUT', '/api/v1/policy/flags/:flagId', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'policy.edit');
    if (!user) return;
    const flagId = ctx.params.flagId as string;
    const rec = normalizeFlagGovernance(flagId, await readJson(req), new Date().toISOString());
    if (!rec) {
      return sendError(res, 400, 'INVALID_INPUT',
        'unknown flag, or body not {default?: "on"|"off"|null, visibility?: "show"|"hide"}');
    }
    const before = (await store.listFlagGovernance()).get(flagId) ?? null;
    await store.putFlagGovernance(rec);
    await audit(`user:${user.id}`, 'policy.flag.edit', `flag:${flagId}`, {
      before,
      after: rec.default === undefined && rec.visibility === undefined ? null : rec,
    });
    sendJson(res, 200, { flags: flagGovernanceCatalog(await store.listFlagGovernance()) });
  });

  // ── injectables (plans/19) - the governed rail that injects tools / flags /
  // typed resources / declarative chrome into the shell. Publish states facts and
  // distributes DATA; the shell interprets. All three routes gate on one capability
  // (catalog.injectable.manage, admin-or-owner); publish vs. replace vs. revoke are
  // distinguished only in the audit line. Kind is the taxonomy; the kind envelope
  // is the door check (a malformed payload is refused HERE, not from a member's shell).
  router.add('GET', '/api/v1/injectables', async (req, res) => {
    if (!(await requireAction(req, res, 'catalog.injectable.manage'))) return;
    const recs = await store.listInjectables();
    // Attach the kind's display facts + registry (kinds) so the console renders
    // the listing and the publish form without re-deriving the taxonomy.
    sendJson(res, 200, {
      injectables: recs.map((r) => ({ ...r, facts: factsFor(r) })),
      kinds: INJECTABLE_KINDS.map((k) => ({ kind: k, label: KIND_HANDLERS[k].label, summary: KIND_HANDLERS[k].summary, shellSupport: KIND_HANDLERS[k].shellSupport })),
    });
  });
  router.add('POST', '/api/v1/injectables', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.injectable.manage');
    if (!user) return;
    const v = validatePublish(await readJson(req));
    if (!v.ok) return sendError(res, 400, 'INVALID_INPUT', v.reason);
    const now = new Date().toISOString();
    const existing = await store.getInjectable(v.fields.id);
    // A replace overwrites the live descriptor and bumps the version; a first
    // publish starts at version 1. Both keep the original createdAt/createdBy.
    const rec: InjectableRecord = existing
      ? { ...existing, ...v.fields, state: 'live', version: existing.version + 1, updatedAt: now, revokedAt: undefined }
      : { ...v.fields, state: 'live', version: 1, createdBy: user.id, createdAt: now, updatedAt: now };
    await store.putInjectable(rec);
    await audit(`user:${user.id}`, existing ? 'catalog.injectable.replace' : 'catalog.injectable.publish', `injectable:${rec.id}`, {
      version: rec.version, kind: rec.kind, groups: rec.groups,
      ...(existing ? { before: { version: existing.version, state: existing.state } } : {}),
    });
    sendJson(res, existing ? 200 : 201, { injectable: { ...rec, facts: factsFor(rec) } });
  });
  router.add('DELETE', '/api/v1/injectables/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.injectable.manage');
    if (!user) return;
    const id = ctx.params.id as string;
    const existing = await store.getInjectable(id);
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'no such injectable');
    // Soft-revoke: stop projecting to shells but keep the record (and its history)
    // listed as revoked, mirroring catalog lifecycle revoke.
    const now = new Date().toISOString();
    const rec: InjectableRecord = { ...existing, state: 'revoked', revokedAt: now, updatedAt: now, version: existing.version + 1 };
    await store.putInjectable(rec);
    await audit(`user:${user.id}`, 'catalog.injectable.revoke', `injectable:${id}`, { before: { version: existing.version, state: existing.state }, revoked: true });
    sendJson(res, 200, { injectable: { ...rec, facts: factsFor(rec) } });
  });

  // ── policy-as-code: export / apply (plan Rec 2) ───────────────────────────
  // The whole governance state as one canonical document, so an instance is
  // reproducible from git and promotable staging→prod through review. Never
  // carries credentials, provider runtime state, or the enable kill-switch.
  router.add('GET', '/api/v1/config/export', async (req, res) => {
    if (!(await requireAction(req, res, 'policy.edit'))) return;
    await providersReady;
    const doc = await buildConfigDocument(store);
    const etag = `"cfg-${canonicalHash(doc).slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    sendJson(res, 200, doc, { etag, 'cache-control': 'private, max-age=0, must-revalidate' });
  });

  // Apply a document: validate → plan diff → reject config-managed collisions →
  // authorize EACH change from the diff (owner-only grants need the owner role,
  // so import can't escalate) → dryRun returns the diff, else commit + one audit.
  router.add('POST', '/api/v1/config/apply', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const dryRun = ctx.url.searchParams.get('dryRun') === '1';
    const prune = ctx.url.searchParams.get('prune') === '1';
    const parsed = validateConfigDocument(await readJson(req));
    if ('errors' in parsed) return sendError(res, 400, 'INVALID_DOCUMENT', parsed.errors.join('; '));
    await providersReady;
    const current = await buildConfigDocument(store);
    const configIds = new Set((await store.listProviders()).filter((p) => p.managedBy === 'config').map((p) => p.id));
    const diff = diffConfigDocument(current, parsed.doc, { prune }, configIds);
    if (diff.conflicts.length) return sendError(res, 409, 'CONFIG_MANAGED', `config-managed, edit instance.json: ${diff.conflicts.join(', ')}`);
    const need = requiredActions(diff);
    const grants = await store.listGrants();
    const pctx = { userId: user.id, groups: user.groups, role: user.role as Role };
    const missing = need.actions.filter((a) => !evaluate(pctx, a, ['*'], grants));
    if (missing.length) return sendError(res, 403, 'FORBIDDEN', `apply needs: ${missing.join(', ')}`);
    if (need.ownerOnly && user.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY_ACTION', 'this document creates or removes an owner-only grant (instance.config / catalog.provider.credential) — only an owner may apply it');
    }
    const hash = canonicalHash(parsed.doc);
    const summary = diffSummary(diff);
    if (dryRun) return sendJson(res, 200, { dryRun: true, prune, hash, diff: summary }, { 'cache-control': 'no-store' });
    await commitConfigApply(store, diff, user.id);
    await audit(`user:${user.id}`, 'config.apply', `config:${hash.slice(0, 16)}`, { prune, hash, ...summary });
    sendJson(res, 200, { dryRun: false, prune, hash, applied: summary });
  });

  // ── catalog providers control plane (plans/17 §10) ────────────────────────
  // Wire shape: never the ciphertext, never the fragment body - config, a
  // credential fingerprint, and slim runtime state.
  const providerWire = (rec: ProviderRecord) => ({
    id: rec.id, kind: rec.kind, label: rec.label, managedBy: rec.managedBy, enabled: rec.enabled,
    options: rec.options, mapping: rec.mapping, exposure: rec.exposure, sync: rec.sync,
    credential: rec.credentialFingerprint
      ? { fingerprint: rec.credentialFingerprint, updatedAt: rec.credentialUpdatedAt ?? null }
      : null,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    state: {
      lastSyncAt: rec.state.lastSyncAt ?? null,
      lastError: rec.state.lastError ?? null,
      assetCount: rec.state.assetCount,
    },
  });

  const readProviderConfigBody = (body: Record<string, unknown> | null): Partial<ProviderRecord> | { error: string } => {
    if (!body) return { error: 'body required' };
    const out: Partial<ProviderRecord> = {};
    if (body.kind !== undefined) {
      if (!PROVIDER_KINDS.includes(body.kind as ProviderKind)) return { error: `kind must be one of ${PROVIDER_KINDS.join('|')}` };
      out.kind = body.kind as ProviderKind;
    }
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || !body.label.trim()) return { error: 'label must be a non-empty string' };
      out.label = body.label.slice(0, 200);
    }
    for (const key of ['options', 'mapping', 'exposure', 'sync'] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `${key} must be an object` };
      (out as Record<string, unknown>)[key] = v;
    }
    return out;
  };

  const dbManagedProvider = async (res: ServerResponse, id: string): Promise<ProviderRecord | null> => {
    await providersReady;
    const rec = await store.getProvider(id);
    if (!rec) {
      sendError(res, 404, 'NOT_FOUND', 'no such provider');
      return null;
    }
    if (rec.managedBy === 'config') {
      sendError(res, 409, 'CONFIG_MANAGED', 'this provider is managed by instance.json — edit the file and redeploy');
      return null;
    }
    return rec;
  };

  router.add('GET', '/api/v1/catalog/providers', async (req, res) => {
    if (!(await requireAction(req, res, 'catalog.provider.read'))) return;
    await providersReady;
    sendJson(res, 200, { providers: (await store.listProviders()).map(providerWire) });
  });

  router.add('POST', '/api/v1/catalog/providers', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const id = body?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'id must be a lowercase slug');
    }
    const cfg = readProviderConfigBody(body);
    if ('error' in cfg) return sendError(res, 400, 'INVALID_INPUT', cfg.error);
    if (!cfg.kind || !cfg.label) return sendError(res, 400, 'INVALID_INPUT', 'kind and label required');
    await providersReady;
    if (await store.getProvider(id)) return sendError(res, 409, 'CONFLICT', 'a provider with this id already exists');
    const now = new Date().toISOString();
    const rec: ProviderRecord = {
      id, kind: cfg.kind, label: cfg.label, managedBy: 'db',
      enabled: false, // always born disabled; enabling is its own audited action
      options: cfg.options ?? {}, mapping: cfg.mapping ?? {}, exposure: cfg.exposure ?? {}, sync: cfg.sync ?? {},
      createdBy: user.id, createdAt: now, updatedAt: now,
      state: { assetCount: 0 },
    };
    await store.putProvider(rec);
    await audit(`user:${user.id}`, 'catalog.provider.create', `provider:${id}`, { kind: rec.kind, label: rec.label });
    sendJson(res, 201, providerWire(rec));
  });

  // Dry-run for the console's add wizard: health + a mapped sample, nothing
  // persisted. Registered before the :id routes so 'preview' never binds as an id.
  router.add('POST', '/api/v1/catalog/providers/preview', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const cfg = readProviderConfigBody(body);
    if ('error' in cfg) return sendError(res, 400, 'INVALID_INPUT', cfg.error);
    if (!cfg.kind) return sendError(res, 400, 'INVALID_INPUT', 'kind required');
    const secret = typeof body?.secret === 'string' ? body.secret : undefined;
    const now = new Date().toISOString();
    const rec: ProviderRecord = {
      id: 'preview', kind: cfg.kind, label: 'preview', managedBy: 'db', enabled: false,
      options: cfg.options ?? {}, mapping: cfg.mapping ?? {}, exposure: cfg.exposure ?? {}, sync: {},
      createdAt: now, updatedAt: now, state: { assetCount: 0 },
    };
    await audit(`user:${user.id}`, 'catalog.provider.preview', `provider-kind:${cfg.kind}`);
    // --shape (plans/33 §3): the live-verify multiplier. Structure only - key
    // names and value types, never a value - so it answers "what is this field
    // actually called upstream" in one call. Rendered here rather than in the
    // CLI so every surface prints the same text.
    //
    // Shape mode is exclusive: no sample is listed and none is returned, so the
    // whole response is sendable to a driver author by construction. The two
    // modes answer different questions - without it, what would federate; with
    // it, what the tenant's records look like.
    const wantShape = body?.shape === true;
    // With a remoteId, the report on the OTHER call as well: the per-asset
    // detail response the byte path reads, whose wrapper and download-link keys
    // no list page can answer - and those decide whether the exit works.
    const detailId = typeof body?.remoteId === 'string' && body.remoteId ? body.remoteId : undefined;
    try {
      const provider = createProvider(rec, secret, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
      const health = await provider.healthCheck();
      let shape: ProviderShapeReport | null = null;
      let shapeText: string[] | undefined;
      let detailShape: ProviderShapeReport | null = null;
      let detailShapeText: string[] | undefined;
      if (wantShape && health.ok) {
        if (provider.sampleShape) {
          try {
            shape = await provider.sampleShape();
            shapeText = renderShapeReport(shape);
          } catch (err) {
            shapeText = [`shape report failed: ${(err as Error).message}`];
          }
        } else {
          shapeText = [noShapeLine(cfg.kind)];
        }
        if (detailId) {
          if (provider.detailShape) {
            try {
              detailShape = await provider.detailShape(detailId);
              detailShapeText = renderShapeReport(detailShape);
            } catch (err) {
              detailShapeText = [`detail shape report failed: ${(err as Error).message}`];
            }
          } else {
            detailShapeText = [provider.sampleShape ? noDetailShapeLine(cfg.kind) : noShapeLine(cfg.kind)];
          }
        }
      }
      if (wantShape) {
        return sendJson(res, 200, {
          health, shape, ...(shapeText ? { shapeText } : {}),
          ...(detailId ? { detailShape, ...(detailShapeText ? { detailShapeText } : {}) } : {}),
        }, { 'cache-control': 'no-store' });
      }
      if (!health.ok) return sendJson(res, 200, { health, sample: [] });
      try {
        const page = await provider.listAssets();
        // The sample passes the SAME exposure gate a real sync applies
        // (buildFragment): a dry run that showed assets federation would refuse
        // is worse than no dry run, because the operator enables on the
        // strength of it. What the slice removed is counted, so an empty sample
        // names its own cause instead of reading as an empty tenant.
        const kept = page.assets.filter((a) => passesExposure(rec, a));
        const excludedByExposure = page.assets.length - kept.length;
        const sample = kept.slice(0, 10).map((a) => mapProviderAsset(rec, a));
        return sendJson(res, 200, {
          health, sample, sampleTotal: kept.length,
          ...(excludedByExposure ? { excludedByExposure } : {}),
          ...(page.skipped ? { skipped: page.skipped } : {}),
          ...(page.notes?.length ? { notes: page.notes } : {}),
        }, { 'cache-control': 'no-store' });
      } catch (err) {
        // A listing that breaks on a live-verify guess is a failure, not an
        // empty tenant: the message names the constant, and `--shape` reports
        // the structure that answers it.
        return sendJson(res, 200, { health, sample: [], sampleError: (err as Error).message }, { 'cache-control': 'no-store' });
      }
    } catch (err) {
      const health = { ok: false, detail: (err as Error).message };
      return sendJson(res, 200, wantShape ? { health, shape: null } : { health, sample: [] }, { 'cache-control': 'no-store' });
    }
  });

  router.add('GET', '/api/v1/catalog/providers/:id', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'catalog.provider.read'))) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    sendJson(res, 200, providerWire(rec));
  });

  router.add('PUT', '/api/v1/catalog/providers/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    const rec = await dbManagedProvider(res, ctx.params.id as string);
    if (!rec) return;
    const cfg = readProviderConfigBody((await readJson(req)) as Record<string, unknown> | null);
    if ('error' in cfg) return sendError(res, 400, 'INVALID_INPUT', cfg.error);
    const next: ProviderRecord = {
      ...rec,
      ...(cfg.label ? { label: cfg.label } : {}),
      ...(cfg.options ? { options: cfg.options } : {}),
      ...(cfg.mapping ? { mapping: cfg.mapping } : {}),
      ...(cfg.exposure ? { exposure: cfg.exposure } : {}),
      ...(cfg.sync ? { sync: cfg.sync } : {}),
      updatedAt: new Date().toISOString(),
    };
    await store.putProvider(next);
    federation.invalidate(rec.id); // mapping/exposure changes re-map on next compose
    await audit(`user:${user.id}`, 'catalog.provider.update', `provider:${rec.id}`, {
      before: { label: rec.label, options: rec.options, mapping: rec.mapping, exposure: rec.exposure, sync: rec.sync },
      after: { label: next.label, options: next.options, mapping: next.mapping, exposure: next.exposure, sync: next.sync },
    });
    sendJson(res, 200, providerWire(next));
  });

  router.add('DELETE', '/api/v1/catalog/providers/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    const rec = await dbManagedProvider(res, ctx.params.id as string);
    if (!rec) return;
    if (rec.enabled) return sendError(res, 409, 'PROVIDER_ENABLED', 'disable the provider before deleting it');
    await store.deleteProvider(rec.id);
    federation.invalidate(rec.id);
    await audit(`user:${user.id}`, 'catalog.provider.delete', `provider:${rec.id}`, { kind: rec.kind });
    sendJson(res, 200, { ok: true });
  });

  // Write-only credential path (plans/17 §5): seal → verify health → swap.
  // The plaintext is never stored, logged, audited, or returned - the response
  // carries only the fingerprint and the health result.
  router.add('PUT', '/api/v1/catalog/providers/:id/credential', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.credential');
    if (!user) return;
    const rec = await dbManagedProvider(res, ctx.params.id as string);
    if (!rec) return;
    const body = (await readJson(req)) as { secret?: string } | null;
    if (typeof body?.secret !== 'string' || body.secret.length < 8) {
      return sendError(res, 400, 'INVALID_INPUT', 'secret required (min 8 chars)');
    }
    if (!secrets.credential) {
      return sendError(res, 409, 'CREDENTIAL_SECRET_MISSING', 'set LW_CREDENTIAL_SECRET before storing provider credentials');
    }
    let health: { ok: boolean; detail?: string };
    try {
      health = await createProvider(rec, body.secret, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}).healthCheck();
    } catch (err) {
      health = { ok: false, detail: (err as Error).message };
    }
    if (!health.ok) {
      return sendError(res, 409, 'PROVIDER_UNHEALTHY', `credential rejected by health check: ${health.detail ?? 'unknown'}`);
    }
    const fingerprint = secretFingerprint(body.secret);
    await store.putProviderCredential(rec.id, {
      ciphertext: sealSecret(body.secret, secrets.credential, credentialContext(rec.id)),
      fingerprint,
      updatedAt: new Date().toISOString(),
    });
    federation.invalidate(rec.id);
    invalidateAccessTokens(rec.id); // OAuth kinds: cached access tokens die with the rotated grant
    await audit(`user:${user.id}`, 'catalog.provider.credential', `provider:${rec.id}`, {
      fingerprint, rotatedFrom: rec.credentialFingerprint ?? null,
    });
    sendJson(res, 200, { fingerprint, health }, { 'cache-control': 'no-store' });
  });

  router.add('DELETE', '/api/v1/catalog/providers/:id/credential', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.credential');
    if (!user) return;
    const rec = await dbManagedProvider(res, ctx.params.id as string);
    if (!rec) return;
    await store.putProviderCredential(rec.id, null);
    // A credential-less provider can't serve - force the kill switch off too.
    if (rec.enabled) await store.putProvider({ ...rec, enabled: false, updatedAt: new Date().toISOString() });
    federation.invalidate(rec.id);
    invalidateAccessTokens(rec.id);
    await audit(`user:${user.id}`, 'catalog.provider.credential', `provider:${rec.id}`, {
      cleared: true, rotatedFrom: rec.credentialFingerprint ?? null, forcedDisable: rec.enabled,
    });
    sendJson(res, 200, { ok: true, disabled: true });
  });

  router.add('POST', '/api/v1/catalog/providers/:id/enable', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.credential');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    if (rec.managedBy === 'config') return sendError(res, 409, 'CONFIG_MANAGED', 'set enabled in instance.json for config-managed providers');
    let health: { ok: boolean; detail?: string };
    try {
      health = await federation.instantiate(rec).healthCheck();
    } catch (err) {
      health = { ok: false, detail: (err as Error).message };
    }
    if (!health.ok) return sendError(res, 409, 'PROVIDER_UNHEALTHY', `cannot enable: ${health.detail ?? 'health check failed'}`);
    await store.putProvider({ ...rec, enabled: true, updatedAt: new Date().toISOString() });
    await audit(`user:${user.id}`, 'catalog.provider.enable', `provider:${rec.id}`);
    sendJson(res, 200, { ok: true, enabled: true });
  });

  router.add('POST', '/api/v1/catalog/providers/:id/disable', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.credential');
    if (!user) return;
    const rec = await dbManagedProvider(res, ctx.params.id as string);
    if (!rec) return;
    await store.putProvider({ ...rec, enabled: false, updatedAt: new Date().toISOString() });
    federation.invalidate(rec.id); // fragment drops from the feed immediately
    await audit(`user:${user.id}`, 'catalog.provider.disable', `provider:${rec.id}`);
    sendJson(res, 200, { ok: true, enabled: false });
  });

  router.add('POST', '/api/v1/catalog/providers/:id/sync', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    await audit(`user:${user.id}`, 'catalog.provider.sync', `provider:${rec.id}`);
    try {
      const fragment = await federation.sync(rec);
      // skipped/notes ride the result rather than the log (plans/33 §5): a sync
      // that mapped none of what it read must say so where the operator looks.
      sendJson(res, 200, {
        ok: true, assetCount: fragment.assets.length, syncedAt: fragment.syncedAt, hash: fragment.hash,
        ...(fragment.skipped ? { skipped: fragment.skipped } : {}),
        ...(fragment.notes?.length ? { notes: fragment.notes } : {}),
      });
    } catch (err) {
      sendError(res, 502, 'PROVIDER_UNAVAILABLE', `sync failed: ${(err as Error).message}`);
    }
  });

  // The exit (plans/27 §5): materialize a provider's bytes into the instance's
  // own BlobStore. Admin governance (catalog.provider.manage); the provider stays
  // enabled - this only mints instance-owned copies. Body: {remoteId?} for one
  // asset, {section?} for a folder, else the whole provider.
  router.add('POST', '/api/v1/catalog/providers/:id/materialize', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    const body = (await readJson(req)) as { remoteId?: string; section?: string } | null;
    const filter = { ...(body?.remoteId ? { remoteId: body.remoteId } : {}), ...(body?.section ? { section: body.section } : {}) };
    try {
      const { results, skipped, errors } = await materializeProvider({ store, blobs, federation }, rec, filter);
      // New instance-owned bytes exist, so the render cache key's instance half
      // moves with them (plans/31 §6) - the same ripple a new version causes.
      if (results.length) bustInstanceCatalog();
      const embedded = results.filter((r) => r.credential === 'embedded').length;
      // Always audit what succeeded, even on a partial run - the copies persist
      // (idempotent, a re-run resumes), so they must leave a trail.
      await audit(`user:${user.id}`, 'catalog.provider.materialize', `provider:${rec.id}`, { count: results.length, skipped, credentialsFound: embedded, failed: errors.length });
      sendJson(res, 200, { ok: errors.length === 0, materialized: results.length, skipped, credentialsFound: embedded, assets: results, ...(errors.length ? { errors } : {}) }, { 'cache-control': 'no-store' });
    } catch (err) {
      sendError(res, 502, 'MATERIALIZE_FAILED', (err as Error).message);
    }
  });

  // Search-and-import (plans/30 §3.1): snapshot ONE provider asset into inst/* - the
  // curation gate for sources like Penpot whose media lives only in search, never in
  // the auto-federated feed. Uses the driver's getAsset seam (single-asset fetch by
  // remoteId) and falls back to a listAssets scan for providers that don't implement
  // it. Admin-gated like materialize; the result is a pin - the owner-gated cutover
  // still owns it fully later.
  router.add('POST', '/api/v1/catalog/providers/:id/import', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.manage');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    const body = (await readJson(req)) as { remoteId?: string } | null;
    const remoteId = body?.remoteId;
    if (typeof remoteId !== 'string' || !remoteId) return sendError(res, 400, 'INVALID_INPUT', 'remoteId required');
    const deps = { store, blobs, federation };
    try {
      const provider = federation.instantiate(rec);
      let result: Awaited<ReturnType<typeof materializeAsset>>;
      if (provider.getAsset) {
        const asset = await provider.getAsset(remoteId);
        if (!asset) return sendError(res, 404, 'NOT_FOUND', 'no such asset on the provider');
        result = await materializeAsset(deps, rec, asset);
      } else {
        const { results } = await materializeProvider(deps, rec, { remoteId });
        if (!results.length) return sendError(res, 404, 'NOT_FOUND', 'asset not found in the provider feed');
        result = results[0]!;
      }
      bustInstanceCatalog(); // one more instance-owned asset (plans/31 §6)
      await audit(`user:${user.id}`, 'catalog.provider.import', `provider:${rec.id}`, { remoteId, inst: result.id, credential: result.credential });
      sendJson(res, 200, { ok: true, imported: result }, { 'cache-control': 'no-store' });
    } catch (err) {
      sendError(res, 502, 'IMPORT_FAILED', (err as Error).message);
    }
  });

  // Cutover: move identities ext/* → inst/*, migrate lifecycle/holds/credentials/
  // grants, alias old URLs, then disable the provider. Owner-gated because it
  // flips the kill switch (catalog.provider.credential, like enable/disable).
  router.add('POST', '/api/v1/catalog/providers/:id/cutover', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.credential');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    const { migrated } = await cutoverProvider({ store, blobs, federation }, rec);
    if (migrated) bustInstanceCatalog(); // identities moved into inst/* (plans/31 §6)
    // A db-managed provider is disabled here (its job is done). A config-managed
    // one can only be turned off in instance.json, but that's fine: its ext
    // entries are shadowed by the instance copies and old URLs alias - so it
    // does no harm enabled, and the operator removes the config entry when ready.
    if (rec.managedBy !== 'config') {
      await store.putProvider({ ...rec, enabled: false, updatedAt: new Date().toISOString() });
    }
    federation.invalidate(rec.id);
    const enabled = rec.managedBy === 'config' ? rec.enabled : false;
    await audit(`user:${user.id}`, 'catalog.provider.cutover', `provider:${rec.id}`, { migrated, disabled: !enabled });
    sendJson(res, 200, { ok: true, migrated, enabled, configManaged: rec.managedBy === 'config' });
  });

  // The drift report (plans/33 §2b): which materialized copies have fallen
  // behind their source - the cadence check during a staged exit. Read-only and
  // gated like the other provider reads: it stores nothing, materializes
  // nothing, and names the remedy rather than running it. The comparison needs
  // TODAY's upstream state, so it builds a fragment live instead of reading the
  // cached one (which can be a TTL stale, and is absent entirely for a provider
  // that cutover already disabled).
  router.add('GET', '/api/v1/catalog/providers/:id/drift', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'catalog.provider.read'))) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    try {
      const fragment = await buildFragment(rec, federation.instantiate(rec), Date.now);
      const report = providerDrift(rec.id, fragment.assets, await store.listInstanceAssets());
      sendJson(res, 200, report, { 'cache-control': 'no-store' });
    } catch (err) {
      sendError(res, 502, 'PROVIDER_UNAVAILABLE', `drift check failed: ${(err as Error).message}`);
    }
  });

  // Publish out (plans/27 §10): push a lolly-generated export INTO a destination
  // provider (Optimizely CMP). Owner-grantable (catalog.provider.publish), narrow
  // by construction - the export must carry lolly's C2PA export assertion, so a
  // federated or pack asset can never be pushed out. The bytes ride the raw body;
  // name/format are query params. Audited per publish with the export's
  // provenance chain, so lolly-made media stays attributable downstream.
  router.add('POST', '/api/v1/catalog/providers/:id/publish', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.provider.publish');
    if (!user) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    if (!rec.enabled) return sendError(res, 410, 'PROVIDER_DISABLED', 'this provider is disabled');
    const provider = federation.instantiate(rec);
    if (!provider.capabilities.publish || !provider.publishAsset) {
      return sendError(res, 409, 'PUBLISH_UNSUPPORTED', 'this provider does not accept published exports');
    }
    const name = ctx.url.searchParams.get('name');
    const format = ctx.url.searchParams.get('format');
    if (!name || !format || !/^[a-z0-9]+$/i.test(format)) return sendError(res, 400, 'INVALID_INPUT', 'name and format query params required');
    let bytes: Buffer;
    try {
      bytes = await readRaw(req, 64 * 1024 * 1024);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'export exceeds the 64 MiB publish cap');
    }
    if (!bytes.length) return sendError(res, 400, 'INVALID_INPUT', 'empty export body');
    const gate = await verifyLollyExport(bytes, format);
    if (!gate.ok) return sendError(res, 422, 'NOT_LOLLY_EXPORT', gate.detail ?? 'only lolly exports may be published');
    const provenance = extractProvenance(bytes, format);
    try {
      const contentType = req.headers['content-type'] ?? 'application/octet-stream';
      // `bytes` is already a Buffer (a Uint8Array) - pass it through, don't re-copy.
      const result = await provider.publishAsset({ bytes, name, format, contentType });
      await audit(`user:${user.id}`, 'catalog.provider.publish', `provider:${rec.id}`, {
        remoteId: result.remoteId, name, format, size: bytes.length,
        provenance: provenance?.ingredients.map((i) => i.assetId) ?? [],
      });
      sendJson(res, 200, { ok: true, remoteId: result.remoteId, ...(result.url ? { url: result.url } : {}) }, { 'cache-control': 'no-store' });
    } catch (err) {
      sendError(res, 502, 'PUBLISH_FAILED', (err as Error).message);
    }
  });

  router.add('GET', '/api/v1/catalog/providers/:id/health', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'catalog.provider.read'))) return;
    await providersReady;
    const rec = await store.getProvider(ctx.params.id as string);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    try {
      sendJson(res, 200, await federation.instantiate(rec).healthCheck());
    } catch (err) {
      sendJson(res, 200, { ok: false, detail: (err as Error).message });
    }
  });

  // ── catalog search (plans/17 §9): composed index + live provider fan-out ──
  router.add('GET', '/api/v1/catalog/search', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q) return sendError(res, 400, 'INVALID_INPUT', 'q required');
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    await providersReady;

    // Local pass: pack index + synced fragments, lifecycle-applied.
    let index: AssetIndex = {};
    try {
      index = JSON.parse(await readFile(join(config.instance.pack, 'catalog', 'assets', 'index.json'), 'utf8')) as AssetIndex;
    } catch {
      /* no pack index — federated-only instances still search */
    }
    const lifecycleRows = await store.listLifecycle();
    const lifecycleById = new Map(lifecycleRows.map((r) => [r.assetId, r]));
    // The overlay is loaded once and kept: `composeAssetMeta` folds its fields
    // and supersession onto the feed entries, and the haystack below folds its
    // OCR text (which is kept OFF the feed) in beside them (plans/31 §7).
    const metas = await store.listAssetMeta();
    const metaById = new Map(metas.map((m) => [m.assetId, m]));
    const withInstance = composeAssetMeta(
      composeInstanceAssets(
        await federation.composeIndex(index, user.groups), await store.listInstanceAssets(), user.groups,
      ),
      metas, await store.listCatalogFields(),
    );
    const composed = applyCredentialsToIndex(
      applyLifecycleToIndex(withInstance, lifecycleRows, Date.now()),
      await store.listCredentials(),
    );
    // The haystack folds the org's own field values (plans/31 section 4) and
    // the asset's on-device OCR text (section 7) alongside id, name, description
    // and tags: a value an org files an asset under, or a word printed on the
    // asset itself, is a value they will look it up by. The OCR text comes off
    // the overlay by id rather than off the entry, because it is deliberately
    // not carried on the feed.
    const matches = (e: { id: string; name?: unknown; description?: unknown; tags?: unknown; fields?: unknown }): boolean =>
      [e.id, e.name, e.description, ...(Array.isArray(e.tags) ? e.tags : []), ...fieldHaystack(e), ...extractedHaystack(metaById.get(e.id))]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    const results = new Map<string, unknown>();
    for (const e of composed.assets ?? []) {
      if (matches(e)) results.set(e.id, e);
      if (results.size >= limit) break;
    }

    // Live pass: providers that search server-side may know assets the synced
    // fragment hasn't picked up yet. Bounded per provider; failures reported,
    // never fatal.
    const missed: string[] = [];
    const live = (await store.listProviders()).filter((rec) =>
      rec.enabled && callerSeesProvider(rec, user.groups));
    await Promise.all(live.map(async (rec) => {
      try {
        const provider = federation.instantiate(rec);
        if (!provider.capabilities.search || !provider.searchAssets) return;
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
        const found = await Promise.race([provider.searchAssets(q, limit), timeout]);
        for (const a of found) {
          // Live results pass the SAME gates as synced fragments: the admin's
          // exposure slice, then this instance's lifecycle overlays.
          if (!passesExposure(rec, a)) continue;
          const entry = mapProviderAsset(rec, a);
          const row = lifecycleById.get(entry.id);
          const { state, upstreamExpired } = combinedState(row, entryWindow(entry), Date.now());
          if (state === 'revoked' || state === 'scheduled' || (state === 'expired' && (upstreamExpired || row?.onExpiry !== 'warn'))) continue;
          if (!results.has(entry.id) && results.size < limit) results.set(entry.id, entry);
        }
      } catch {
        missed.push(rec.id);
      }
    }));
    sendJson(res, 200, {
      q, results: [...results.values()], ...(missed.length ? { providersUnavailable: missed } : {}),
    }, { 'cache-control': 'private, max-age=30' });
  });

  // ── projects + sessions (plans/08: shared workspaces) ─────────────────────
  // Member-only throughout (guests never reach these - memberOf yields null →
  // 401). A project is a folder over sessions; visibility gates WHICH projects a
  // caller sees, RBAC grants gate WHAT they may do.
  // `canSeeProject` now lives in ../rbac/project-access.ts - the collab ws
  // gateway gates a room join on the same function this route gates a read on.

  const normalizeVisibility = (v: unknown): ProjectRecord['visibility'] => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { groups?: unknown }).groups)) {
      const groups = ((v as { groups: unknown[] }).groups)
        .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        .map((g) => g.trim());
      if (groups.length) return { groups: [...new Set(groups)] };
    }
    return 'private';
  };

  const labelOf = (s: SessionRecord): string | null =>
    typeof s.meta?.label === 'string' ? s.meta.label : null;
  const asObject = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

  const projectRow = (p: ProjectRecord, live: SessionRecord[]) => {
    const mine = live.filter((s) => s.projectId === p.id);
    const updatedAt = mine.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), p.createdAt);
    return {
      id: p.id, name: p.name, visibility: p.visibility, ownerId: p.ownerId,
      sessionCount: mine.length, createdAt: p.createdAt, updatedAt,
      ...(p.archivedAt ? { archivedAt: p.archivedAt } : {}),
    };
  };
  const sessionListRow = (s: SessionRecord) => ({
    id: s.id, toolId: s.toolId, toolVersion: s.toolVersion, label: labelOf(s),
    meta: s.meta, rev: s.rev, updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  });
  const sessionFull = (s: SessionRecord) => ({
    id: s.id, projectId: s.projectId, toolId: s.toolId, toolVersion: s.toolVersion,
    inputs: s.inputs, meta: s.meta, label: labelOf(s), rev: s.rev,
    createdBy: s.createdBy, updatedBy: s.updatedBy, updatedAt: s.updatedAt,
    ...(s.deletedAt ? { deletedAt: s.deletedAt } : {}),
  });

  // GET /projects - projects visible to the caller (own + team by group; admins all).
  router.add('GET', '/api/v1/projects', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const [all, live] = await Promise.all([store.listProjects(), store.listSessionsFiltered({})]);
    const visible = all.filter((p) => canSeeProject(user, p));
    sendJson(res, 200, { projects: visible.map((p) => projectRow(p, live)) });
  });

  router.add('POST', '/api/v1/projects', async (req, res) => {
    const user = await requireAction(req, res, 'project.create');
    if (!user) return;
    const body = (await readJson(req)) as { name?: string; visibility?: unknown } | null;
    if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) {
      return sendError(res, 400, 'INVALID_INPUT', 'name required');
    }
    const project: ProjectRecord = {
      id: `prj_${randomId(8)}`,
      name: body.name.slice(0, 200),
      visibility: normalizeVisibility(body.visibility),
      ownerId: user.id,
      createdAt: new Date().toISOString(),
    };
    await store.putProject(project);
    await audit(`user:${user.id}`, 'project.create', `project:${project.id}`, { visibility: project.visibility });
    sendJson(res, 201, projectRow(project, []));
  });

  router.add('PATCH', '/api/v1/projects/:id', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    const grants = await store.listGrants();
    const mayManage = project.ownerId === user.id ||
      evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'project.manage', ['*'], grants);
    if (!mayManage) return sendError(res, 403, 'FORBIDDEN', 'owner or project.manage required');
    const body = (await readJson(req)) as { name?: string; visibility?: unknown; archived?: boolean } | null;
    const next: ProjectRecord = { ...project };
    if (typeof body?.name === 'string' && body.name.trim()) next.name = body.name.slice(0, 200);
    if (body?.visibility !== undefined) next.visibility = normalizeVisibility(body.visibility);
    if (body?.archived === true) next.archivedAt = new Date().toISOString();
    else if (body?.archived === false) delete next.archivedAt;
    await store.putProject(next);
    await audit(`user:${user.id}`, 'project.update', `project:${next.id}`, {
      visibility: next.visibility, archived: Boolean(next.archivedAt),
    });
    sendJson(res, 200, projectRow(next, await store.listSessions(next.id)));
  });

  // GET a project's sessions - list without inputs (cheap); requires visibility.
  router.add('GET', '/api/v1/projects/:id/sessions', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    if (!canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this project');
    const sessions = await store.listSessions(project.id);
    sendJson(res, 200, { sessions: sessions.map(sessionListRow) });
  });

  router.add('POST', '/api/v1/projects/:id/sessions', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.create');
    if (!user) return;
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    if (!canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this project');
    const body = (await readJson(req)) as {
      toolId?: string; toolVersion?: string; inputs?: unknown; meta?: unknown;
    } | null;
    if (!body?.toolId || typeof body.toolId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'toolId required');
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `ses_${randomId(8)}`,
      projectId: project.id,
      toolId: body.toolId,
      toolVersion: typeof body.toolVersion === 'string' ? body.toolVersion : '',
      inputs: asObject(body.inputs),
      meta: asObject(body.meta),
      createdBy: user.id,
      updatedBy: user.id,
      rev: 1,
      updatedAt: now,
    };
    await store.putSession(session);
    await audit(`user:${user.id}`, 'session.create', `session:${session.id}`, { projectId: project.id, toolId: session.toolId });
    sendJson(res, 201, { id: session.id, rev: session.rev });
  });

  // GET a full session (with inputs). 410 if tombstoned; 403 if the project is
  // not visible to the caller.
  router.add('GET', '/api/v1/sessions/:id', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    if (session.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
    sendJson(res, 200, sessionFull(session));
  });

  // PUT a session - optimistic CAS on rev. A stale rev ⇒ 409 with the current
  // server session so the client keeps its loser as a local revision (plans §3).
  router.add('PUT', '/api/v1/sessions/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.edit');
    if (!user) return;
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    if (session.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
    const body = (await readJson(req)) as { inputs?: unknown; meta?: unknown; rev?: number } | null;
    if (typeof body?.rev !== 'number') return sendError(res, 400, 'INVALID_INPUT', 'rev required for optimistic concurrency');
    if (body.rev !== session.rev) {
      // Conflicts are counted, not just refused (plans/23 §3.D): their volume on
      // shared projects is the demand instrument for plans/14 §9's collab gate.
      // Ids and revs only - an audit event never carries input values.
      await audit(`user:${user.id}`, 'session.conflict', `session:${session.id}`, { rev: session.rev, sentRev: body.rev, toolId: session.toolId });
      return sendJson(res, 409, { error: { code: 'CONFLICT', message: `session is at rev ${session.rev}, you sent ${body.rev}` }, current: sessionFull(session) });
    }
    const now = new Date().toISOString();
    const inputs = body.inputs !== undefined ? asObject(body.inputs) : session.inputs;
    const meta = body.meta !== undefined ? asObject(body.meta) : session.meta;
    const next: SessionRecord = { ...session, inputs, meta, rev: session.rev + 1, updatedBy: user.id, updatedAt: now };
    // The rev check above is a courtesy (cheap, and its 409 carries `current`) - 
    // the WRITE must still be a CAS: `readJson` was awaited between check and
    // here, so two writers can both pass the check at the same rev and the
    // second `putSession` would silently discard the first while
    // `session_revisions` (PK `(session_id, rev)`) kept only one of them - the
    // exact hazard `Store.casSession`'s contract names (plans/23 §3.B).
    if (!(await store.casSession(next, body.rev))) {
      const fresh = await store.getSession(next.id);
      if (!fresh) return sendError(res, 404, 'NOT_FOUND', 'no such session');
      if (fresh.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
      await audit(`user:${user.id}`, 'session.conflict', `session:${fresh.id}`, { rev: fresh.rev, sentRev: body.rev, toolId: fresh.toolId });
      return sendJson(res, 409, { error: { code: 'CONFLICT', message: `session is at rev ${fresh.rev}, you sent ${body.rev}` }, current: sessionFull(fresh) });
    }
    await store.appendSessionRevision({ sessionId: next.id, rev: next.rev, inputs, meta, actor: user.id, at: now });
    await audit(`user:${user.id}`, 'session.update', `session:${next.id}`, { rev: next.rev, projectId: next.projectId, toolId: next.toolId });
    sendJson(res, 200, sessionFull(next));
  });

  // DELETE a session - tombstone (never hard-delete) so a stale client can't
  // resurrect it. Idempotent: deleting an already-tombstoned session is a no-op 200.
  router.add('DELETE', '/api/v1/sessions/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.delete');
    if (!user) return;
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    if (session.deletedAt) return sendJson(res, 200, { ok: true, alreadyDeleted: true });
    const now = new Date().toISOString();
    await store.putSession({ ...session, deletedAt: now, updatedBy: user.id, updatedAt: now });
    await audit(`user:${user.id}`, 'session.delete', `session:${session.id}`, { projectId: session.projectId, toolId: session.toolId });
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/api/v1/sessions/:id/revisions', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    sendJson(res, 200, { revisions: await store.listSessionRevisions(session.id) });
  });

  // POST /sessions/bulk - multi-edit: merge `set` by EXACT input id into every
  // matched session (the client /pro batch rule). Needs BOTH session.edit and
  // project.manage. dryRun previews a per-field diff; apply writes each session
  // via per-session CAS (`matched` is a snapshot, so a session someone edited
  // in between is exactly the one a sweep must not stomp - plans/23 §3.B),
  // reporting losers in `skipped` rather than retrying; appends a revision per
  // applied session, busts affected render keys, and audits ONE event (keys
  // only - never input VALUES).
  router.add('POST', '/api/v1/sessions/bulk', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const grants = await store.listGrants();
    const pctx = { userId: user.id, groups: user.groups, role: user.role as Role };
    if (!evaluate(pctx, 'session.edit', ['*'], grants) || !evaluate(pctx, 'project.manage', ['*'], grants)) {
      return sendError(res, 403, 'FORBIDDEN', 'session.edit and project.manage required for bulk edits');
    }
    const body = (await readJson(req)) as {
      filter?: { projectId?: string; toolId?: string }; set?: Record<string, unknown>; dryRun?: boolean;
    } | null;
    const set = body?.set && typeof body.set === 'object' && !Array.isArray(body.set) ? body.set : null;
    if (!set || Object.keys(set).length === 0) return sendError(res, 400, 'INVALID_INPUT', 'set with at least one input id required');
    const filter: { projectId?: string; toolId?: string } = {};
    if (typeof body?.filter?.projectId === 'string') filter.projectId = body.filter.projectId;
    if (typeof body?.filter?.toolId === 'string') filter.toolId = body.filter.toolId;
    const keys = Object.keys(set);

    // Only sessions in projects the caller can see (admins see all).
    const candidates = await store.listSessionsFiltered(filter);
    const projectCache = new Map<string, ProjectRecord | null>();
    const matched: SessionRecord[] = [];
    for (const s of candidates) {
      if (!projectCache.has(s.projectId)) projectCache.set(s.projectId, await store.getProject(s.projectId));
      const p = projectCache.get(s.projectId);
      if (p && canSeeProject(user, p)) matched.push(s);
    }

    if (body?.dryRun) {
      const diffs = matched.map((s) => {
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const k of keys) { before[k] = s.inputs[k]; after[k] = set[k]; }
        return { sessionId: s.id, label: labelOf(s), before, after };
      });
      return sendJson(res, 200, { matched: matched.length, diffs });
    }

    const now = new Date().toISOString();
    const applied: SessionRecord[] = [];
    const skipped: Array<{ sessionId: string; rev: number }> = [];
    for (const s of matched) {
      const inputs = { ...s.inputs, ...set }; // merge by EXACT input id
      const next: SessionRecord = { ...s, inputs, rev: s.rev + 1, updatedBy: user.id, updatedAt: now };
      if (!(await store.casSession(next, s.rev))) { skipped.push({ sessionId: s.id, rev: s.rev }); continue; }
      applied.push(next);
      await store.appendSessionRevision({ sessionId: next.id, rev: next.rev, inputs, meta: next.meta, actor: user.id, at: now });
    }
    // Bust affected render caches (reachable invalidation entry point, plans §6b).
    // The per-session rev bump also changes any future render key that folds in
    // session state; this by-tool bust drops the render plane's own cached bytes.
    for (const toolId of new Set(applied.map((s) => s.toolId))) invalidateRenderByTool(toolId);
    await audit(`user:${user.id}`, 'sessions.bulk',
      filter.projectId ? `project:${filter.projectId}` : filter.toolId ? `tool:${filter.toolId}` : 'sessions:all',
      { matched: matched.length, applied: applied.length, ...(skipped.length ? { skipped: skipped.length } : {}),
        ...(filter.toolId ? { toolId: filter.toolId } : {}), ...(filter.projectId ? { projectId: filter.projectId } : {}), keys });
    sendJson(res, 200, { applied: applied.length, skipped });
  });

  // ── live collab invites (plans/14 §6, OSS plans/100 §7 item 9) ────────────
  // Two routes, one rule: an invite may only name someone the ws gateway would
  // already admit to that session's room (collab/invites.ts `mayJoinSession`,
  // over the same `canSeeProject` the gateway and `GET /sessions/:id` use). The
  // autocomplete and the POST validate against the SAME function, so a client
  // that skips the search cannot invite anyone the search would have hidden.

  /** The session read gate both routes open with, in the gateway `admit`'s own
   *  order - so a caller sees the same status for the same session whether they
   *  ask over HTTP or open a socket. Takes an ALREADY-RESOLVED member, so the
   *  POST can authenticate before it reads a body. Returns null having answered. */
  const collabSessionFor = async (
    res: ServerResponse, user: UserRecord, sessionId: string | null,
  ): Promise<{ session: SessionRecord; project: ProjectRecord } | null> => {
    if (!sessionId) {
      sendError(res, 400, 'INVALID_INPUT', 'sessionId required');
      return null;
    }
    const session = await store.getSession(sessionId);
    if (!session) {
      sendError(res, 404, 'NOT_FOUND', 'no such session');
      return null;
    }
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) {
      sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
      return null;
    }
    if (session.deletedAt) {
      sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
      return null;
    }
    return { session, project };
  };

  // Invite autocomplete. Read-access only - an OBSERVER may look up who else
  // could watch, which is the same disclosure they already get from the room's
  // presence roster on join. Never the directory: only principals eligible for
  // THIS session's project, prefix-matched, capped, self excluded, no emails
  // (the `GET /api/v1/approvals/approvers` disclosure, one surface over).
  router.add('GET', '/api/v1/collab/invitees', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const gate = await collabSessionFor(res, user, ctx.url.searchParams.get('sessionId'));
    if (!gate) return;
    const q = normalizeQuery(ctx.url.searchParams.get('q'));
    const [users, grants] = await Promise.all([store.listUsers(), store.listGrants()]);
    const { invitees, truncated } = eligibleInvitees({
      users, grants, project: gate.project, callerId: user.id, q,
    });
    sendJson(res, 200, { sessionId: gate.session.id, q, limit: INVITEE_LIMIT, invitees, truncated });
  });

  // Invite someone into the room. Requires the WRITE right - `mayEditCollab`,
  // the one function the gateway's writer/observer split and the org-config
  // `can['collab.edit']` bit also call, so an observer cannot recruit writers
  // into a room they may only watch, and the three surfaces cannot drift.
  router.add('POST', '/api/v1/collab/invites', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req)) as { sessionId?: string; userId?: string } | null;
    const gate = await collabSessionFor(res, user, typeof body?.sessionId === 'string' ? body.sessionId : null);
    if (!gate) return;
    const grants = await store.listGrants();
    if (!mayEditCollab({ userId: user.id, groups: user.groups, role: user.role as Role }, grants)) {
      return sendError(res, 403, 'FORBIDDEN', 'collab.edit required to invite');
    }
    if (!body?.userId || typeof body.userId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'userId required');
    const invitee = (await store.listUsers()).find((u) => u.id === body.userId);
    // One code for "no such user", "cannot see this project", "not a member of
    // it" and "that's you": an ineligible id must not be a probe that tells you
    // which it was - the autocomplete is the only sanctioned way to learn who
    // exists, and it and this route resolve the SAME `mayJoinSession`, so a
    // 201-vs-400 difference can never answer a question the search hides.
    if (!invitee || invitee.id === user.id || !mayJoinSession(invitee, gate.project, grants)) {
      return sendError(res, 400, 'INVITEE_NOT_ELIGIBLE', 'that person cannot open this session');
    }
    const msg = buildInviteMessage({
      sessionId: gate.session.id,
      projectId: gate.session.projectId,
      toolId: gate.session.toolId,
      toolVersion: gate.session.toolVersion,
      inviteeId: invitee.id,
      inviterName: displayName(user),
      label: sessionLabel(gate.session),
      appBase: config.instance.appUrl ?? '',
    });
    // Idempotent by construction: the id is derived from (session, invitee) and
    // putMessage upserts, so a re-invite refreshes the pending row.
    await store.putMessage(msg);
    // …and CLEARS the invitee's dismissal of the previous one. Acks are
    // permanent per (messageId, userId) and delivery filters acked ids
    // unconditionally (inbox/target.ts), so without this a derived id turns
    // "dismissed once" into "never invitable to this session again": the POST
    // answers 201, the audit records an invite, and the invitee's inbox stays
    // empty forever. The invariant is "one live invite per (session, person)",
    // not "one ever" - a colleague asking to be re-invited after clearing their
    // inbox is the ordinary case, not an abuse of the idempotence.
    await store.clearAck(msg.id, invitee.id);
    await audit(`user:${user.id}`, 'collab.invite', `session:${gate.session.id}`, {
      projectId: gate.session.projectId, toolId: gate.session.toolId, invitee: invitee.id, messageId: msg.id,
    });
    sendJson(res, 201, { messageId: msg.id, sessionId: gate.session.id, userId: invitee.id });
  });

  // ── instance-mediated "nearby" (plans/26 §8, OSS plans/110 §5) ────────────
  // A browser cannot discover other devices on a network; the instance groups its
  // online members by apparent address so the invite flow can surface "likely
  // nearby" colleagues. A SORTING HINT, never an identity claim (CGNAT / VPN make
  // it approximate - the copy says "likely nearby", never "on your network").
  // Members only: both routes gate on `collab.join`, which members hold and guests
  // (whose member session is absent → requireAction 401s) do not, so guests never
  // appear and never read the list. The registry is in-memory and injected only by
  // the long-lived server, so both routes answer 501 on Vercel - where a POST and a
  // GET can hit different function instances - rather than a misleading partial list.
  // No audit: this is presence, and presence is deliberately unaudited and unstored
  // across the collab subsystem (the room's own presence map never reaches the store).
  const nearbyReady = (res: ServerResponse): NearbyRegistry | null => {
    if (!config.policy.nearby.enabled) {
      sendError(res, 404, 'NOT_FOUND', 'nearby is off for this instance');
      return null;
    }
    if (!nearby) {
      sendError(res, 501, 'NOT_IMPLEMENTED', 'nearby needs the persistent server');
      return null;
    }
    return nearby;
  };

  router.add('POST', '/api/v1/collab/nearby', async (req, res) => {
    const user = await requireAction(req, res, 'collab.join');
    if (!user) return;
    const reg = nearbyReady(res);
    if (!reg) return;
    const body = (await readJson(req)) as { visible?: boolean } | null;
    const ip = clientIp(req, config.rateLimit.trustedProxyHops);
    if (body?.visible === true) reg.setVisible(user.id, displayName(user), ip);
    else reg.clear(user.id);
    sendJson(res, 200, { visible: body?.visible === true });
  });

  router.add('GET', '/api/v1/collab/nearby', async (req, res) => {
    const user = await requireAction(req, res, 'collab.join');
    if (!user) return;
    const reg = nearbyReady(res);
    if (!reg) return;
    const ip = clientIp(req, config.rateLimit.trustedProxyHops);
    sendJson(res, 200, { members: reg.list(user.id, ip) });
  });

  // ── render plane (the fourth HostV1 shell) ────────────────────────────────
  // GET /render/<toolId>.<format> - server-side render of a tool via the real
  // engine. `spec` is the toolId + format joined by the LAST dot (toolId has no
  // slashes in v1). Auth: a gated instance requires a member (or a guest on their
  // OWN tool); a member additionally needs the `export.server` action. The query
  // is the shared URL-mode param contract (tool inputs + render controls).
  const renderProfileOf = (user: UserRecord | null): Profile => {
    if (!user) return {};
    const p: Profile = { email: user.email };
    if (user.firstname) p.firstname = user.firstname;
    if (user.lastname) p.lastname = user.lastname;
    if (user.title) p.title = user.title;
    return p;
  };

  router.add('GET', '/render/:spec', async (req, res, ctx) => {
    const spec = ctx.params.spec as string;
    const dot = spec.lastIndexOf('.');
    if (dot <= 0 || dot === spec.length - 1) {
      return sendError(res, 400, 'INVALID_INPUT', 'render path must be <toolId>.<format>');
    }
    const toolId = spec.slice(0, dot);
    const format = spec.slice(dot + 1);

    const user = await memberOf(req);
    const p = principalOf(req);
    const gated = config.policy.defaultAccessMode === 'gated';
    if (!user) {
      const guestOk = p?.kind === 'guest' && p.guest.toolId === toolId;
      if (gated && !guestOk) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    } else {
      // Server-side rendering is a privileged action (admin default; grantable).
      const grants = await store.listGrants();
      const selectors = [`tool:${toolId}`, '*'];
      if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'export.server', selectors, grants)) {
        return sendError(res, 403, 'FORBIDDEN', 'export.server required');
      }
    }

    const overlays = await store.listOverlays();
    const query = ctx.url.search.replace(/^\?/, '');
    try {
      const result = await renderTool({ config, resolveProvenance, instanceCatalogVersion, worker: renderWorker, signer: await getC2paSigner() }, {
        toolId, format, query,
        principal: user ? { groups: user.groups } : { groups: [] },
        profile: renderProfileOf(user),
        overlays,
      });
      const etag = `"r-${result.cacheKey.slice(0, 16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': result.mime, etag, 'cache-control': 'private, max-age=60',
        ...provenanceHeader(result.provenance),
      });
      res.end(Buffer.from(result.bytes));
    } catch (err) {
      if (err instanceof RenderError) {
        // Audit sparingly: only a policy-violation refusal (probing) is worth a row.
        if (err.violations?.length) {
          const actor = user ? `user:${user.id}` : p?.kind === 'guest' ? `guest:${toolId}` : 'anon';
          await audit(actor, 'render.denied', `tool:${toolId}`, { code: err.code, params: err.violations.map((v) => v.param) });
        }
        if (err.retryAfter !== undefined) res.setHeader('retry-after', String(err.retryAfter));
        return sendError(res, err.status, err.code, err.message);
      }
      throw err;
    }
  });

  // ── admin console (static shell; every API call it makes is auth-enforced) ─
  // Bundle-aware data-dir base - see api/_lib/bootstrap.ts's FN_ROOT note. When the
  // function is esbuild-bundled for Vercel, import.meta.url is the bundle; the
  // banner sets __LW_FN_ROOT and console/ + docs/ are copied in beside it.
  const fnRoot = (globalThis as { __LW_FN_ROOT?: string }).__LW_FN_ROOT;
  const dataDir = (rel: string): string =>
    fnRoot ? fileURLToPath(new URL(rel, fnRoot)) : fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
  const consoleDir = dataDir('console/');
  const serveConsole = async (res: ServerResponse, rel: string) => {
    const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    if (clean.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    try {
      const bytes = await readFile(join(consoleDir, clean));
      res.writeHead(200, { 'content-type': contentType(clean), 'cache-control': 'no-cache' });
      res.end(bytes);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such console file');
    }
  };
  router.add('GET', '/admin', (_req, res) => void serveConsole(res, 'index.html'));
  router.add('GET', '/admin/*', (_req, res, ctx) => void serveConsole(res, ctx.params['*'] || 'index.html'));

  // ── deployment docs (docs/), rendered by the console's Docs view. Whoever
  // operates a deploy should not need the repo to read its documentation.
  // docs/docs.json is the manifest: it decides which files exist as pages, so an
  // unlisted markdown file is not reachable here - that IS the allowlist (slugs
  // are additionally shape-checked, and the join is never caller-controlled).
  //
  // Readership: on a governed (IdP-backed) deploy these are member-only - every
  // page is operator prose, and the ONE polled document a shell reads is already
  // member-visible. On the PUBLIC sandbox (dev.enabled - lolly.work) the same
  // pages are open to anyone: they are the identical public-repo content in every
  // deploy, and the landing page (lib/demo-landing.ts) links straight to them so
  // a visitor can read the docs without a passwordless sign-in dance. `docsReadable`
  // is that one rule, shared by the five docs read routes below; it mirrors the
  // `publicDocs` flag advertised at GET /api/auth/config so the console agrees.
  const docsDir = dataDir('docs/');
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  // A manifest entry may name a file in ONE subdirectory of docs/ (the
  // per-provider guides live in docs/providers/). The slug stays flat and
  // slug-shaped, so the route, the console's nav and its relative-link
  // resolution all keep working on a single identifier; `path` is only how the
  // slug finds its bytes. Shape-checked here, and the read below additionally
  // proves the resolved file is still inside docs/.
  // The optional directory segment is lowercase and dot-free, so it can never be
  // '..'; the filename starts alphanumeric (docs/providers/README.md), so it
  // cannot be '..md' either.
  const DOC_PATH_RE = /^(?:[a-z0-9][a-z0-9-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
  interface DocsManifest {
    title?: string;
    oss?: { label?: string; path?: string; note?: string };
    sections?: Array<{ id?: string; title?: string; docs?: Array<{ slug?: string; title?: string; summary?: string; path?: string }> }>;
  }
  let docsManifest: DocsManifest | null | undefined;
  const loadDocsManifest = async (): Promise<DocsManifest | null> => {
    if (docsManifest !== undefined) return docsManifest;
    try {
      const raw = JSON.parse(await readFile(join(docsDir, 'docs.json'), 'utf8')) as DocsManifest;
      // Keep only well-formed, slug-shaped entries: the served index and the
      // per-doc allowlist are then the same list by construction.
      const sections = (raw.sections ?? []).map((s) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? ''),
        // A NAV_ICONS id the console renders beside the group header - id-shaped
        // only; the console ignores ids it doesn't know, so this can never
        // inject markup.
        ...(typeof (s as { icon?: unknown }).icon === 'string' && /^[a-z-]+$/.test((s as { icon: string }).icon)
          ? { icon: (s as { icon: string }).icon } : {}),
        docs: (s.docs ?? [])
          .filter((d) => typeof d.slug === 'string' && SLUG_RE.test(d.slug))
          // A malformed `path` drops the entry rather than silently falling back
          // to `<slug>.md`, which would serve the wrong page under a right name.
          .filter((d) => d.path === undefined || (typeof d.path === 'string' && DOC_PATH_RE.test(d.path))),
      })).filter((s) => s.docs.length);
      docsManifest = { ...raw, sections };
    } catch {
      docsManifest = null;
    }
    return docsManifest;
  };
  /** slug -> file path relative to docs/. The manifest IS the allowlist. */
  const docSlugs = async (): Promise<Map<string, string>> => {
    const m = await loadDocsManifest();
    return new Map((m?.sections ?? []).flatMap((s) =>
      (s.docs ?? []).map((d) => [d.slug as string, d.path ?? `${d.slug as string}.md`] as const)));
  };
  // True when this request may read the docs: always on the public sandbox
  // (dev.enabled), otherwise only for a signed-in member. See the section header.
  const docsReadable = async (req: IncomingMessage): Promise<boolean> =>
    config.dev.enabled || Boolean(await memberOf(req));
  router.add('GET', '/api/v1/docs', async (req, res) => {
    if (!(await docsReadable(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const m = await loadDocsManifest();
    if (!m) return sendError(res, 404, 'NO_DOCS', 'this deployment ships no docs directory');
    // `appUrl` (split deploy) or a served shellDir means a Lolly deployment is
    // reachable from here, so its open-source /info/ docs are linkable.
    const lolly = config.instance.appUrl ?? (config.instance.shellDir ? '' : null);
    sendJson(res, 200, {
      title: m.title ?? 'Documentation',
      sections: m.sections ?? [],
      ...(m.oss && lolly !== null
        ? { oss: { label: m.oss.label ?? 'Open-source docs', url: `${lolly}${m.oss.path ?? '/info/'}`, note: m.oss.note ?? '' } }
        : {}),
    }, { 'cache-control': 'no-cache' });
  });
  router.add('GET', '/api/v1/docs/:slug', async (req, res, ctx) => {
    if (!(await docsReadable(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const slug = ctx.params.slug ?? '';
    const rel = SLUG_RE.test(slug) ? (await docSlugs()).get(slug) : undefined;
    if (!rel) return sendError(res, 404, 'NOT_FOUND', 'no such doc');
    // Belt to the manifest's braces: the resolved file must still sit inside
    // docs/, so a hand-edited manifest cannot read outside the docs tree.
    const abs = resolvePath(docsDir, rel);
    if (!abs.startsWith(resolvePath(docsDir) + sep)) return sendError(res, 404, 'NOT_FOUND', 'no such doc');
    try {
      const text = await readFile(abs, 'utf8');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(text);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such doc');
    }
  });

  // ── documentation screenshots (docs/shots/), each an engine-rendered VECTOR
  // SVG carrying its OWN signed C2PA Content Credential (built by
  // scripts/capture-console.ts). Two member-gated routes:
  //   :file       → the signed bytes verbatim, so "download the signed file" and
  //                 the reader's own #/verify both act on the genuine file;
  //   :file/cred  → the descriptive claims the credential line states (signer,
  //                 date, kind, geometry) - decoded server-side because the
  //                 air-gap console cannot decode C2PA itself. Descriptive only:
  //                 the pass/fail verdict is the reader's to reach in #/verify.
  // The shape check IS the allowlist against traversal (no slashes, no '..'); the
  // SVGs load only via <img>, which never executes embedded script.
  const SHOT_RE = /^[a-z0-9][a-z0-9.-]*\.(svg|png)$/i;
  const shotsDir = join(docsDir, 'shots');
  // Plain illustrative images for the docs (docs/img/ - vendored third-party
  // marks like the Rancher/k3s/Helm logos). Same gate and shape as shots, but
  // a separate directory on purpose: everything under shots/ must carry a C2PA
  // credential (tests/docs-shots.test.ts), and a trademark is not ours to sign.
  const imgDir = join(docsDir, 'img');
  router.add('GET', '/api/v1/docs/img/:file', async (req, res, ctx) => {
    if (!(await docsReadable(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const file = ctx.params.file ?? '';
    if (!SHOT_RE.test(file)) return sendError(res, 404, 'NOT_FOUND', 'no such image');
    try {
      const bytes = await readFile(join(imgDir, file));
      res.writeHead(200, {
        'content-type': file.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        'cache-control': 'private, max-age=3600',
      });
      res.end(bytes);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such image');
    }
  });
  router.add('GET', '/api/v1/docs/shots/:file', async (req, res, ctx) => {
    if (!(await docsReadable(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const file = ctx.params.file ?? '';
    if (!SHOT_RE.test(file)) return sendError(res, 404, 'NOT_FOUND', 'no such shot');
    try {
      const bytes = await readFile(join(shotsDir, file));
      res.writeHead(200, {
        'content-type': file.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        'cache-control': 'no-cache',
      });
      res.end(bytes);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such shot');
    }
  });
  router.add('GET', '/api/v1/docs/shots/:file/cred', async (req, res, ctx) => {
    if (!(await docsReadable(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const file = ctx.params.file ?? '';
    if (!SHOT_RE.test(file)) return sendError(res, 404, 'NOT_FOUND', 'no such shot');
    const cred = await readShotCred(join(shotsDir, file), file);
    if (!cred) return sendError(res, 404, 'NO_CRED', 'no readable credential');
    sendJson(res, 200, cred, { 'cache-control': 'no-cache' });
  });

  // ── brand chrome, UNAUTHENTICATED - so the sign-in screen inherits the
  // instance's brand (colours + fonts) before a session exists. Deliberately
  // narrow: it returns ONLY the pack's design tokens and serves ONLY its font
  // files - non-sensitive brand chrome (the same colours/typefaces on a public
  // site), never the governed catalog. Absent pack/tokens → 404, gate stays
  // neutral. Memoised (the pack is immutable for a process).
  // A theme-paired brand logo is chrome too: resolved from the SAME immutable
  // pack index the tokens come from, served through the narrow passthrough below
  // (the governed catalog is auth-gated, but a horizontal wordmark is the same
  // non-sensitive identity a public site shows). Abs file paths are kept here,
  // keyed by theme, and only reachable via the validated /api/brand/logo route.
  const brandLogoFiles: { light?: string; dark?: string } = {};
  let brandChrome:
    | { name: string; tokens: unknown; fontsBase: string; logos: { light: string | null; dark: string | null } }
    | null
    | undefined;
  const loadBrandChrome = async (): Promise<typeof brandChrome> => {
    if (brandChrome !== undefined) return brandChrome;
    try {
      const idx = JSON.parse(await readFile(join(config.instance.pack, 'catalog', 'assets', 'index.json'), 'utf8')) as {
        assets?: Array<{ type?: string; tags?: string[]; formats?: Array<{ format?: string; url?: string }> }>;
      };
      const assets = idx.assets ?? [];
      const tok = assets.find((a) => a?.type === 'tokens');
      const fmt = tok?.formats?.find((f) => f.format === 'json') ?? tok?.formats?.[0];
      if (!fmt?.url) return (brandChrome = null);
      const abs = (url: string) => join(config.instance.pack, 'catalog', normalize(url.replace(/^\/?catalog\//, '')));
      const tokens = JSON.parse(await readFile(abs(fmt.url), 'utf8'));
      const lightUrl = pickBrandLogoUrl(assets, 'light');
      const darkUrl = pickBrandLogoUrl(assets, 'dark');
      if (lightUrl) brandLogoFiles.light = abs(lightUrl);
      if (darkUrl) brandLogoFiles.dark = abs(darkUrl);
      brandChrome = {
        name: config.instance.name,
        tokens,
        fontsBase: '/api/brand/font/',
        logos: {
          light: brandLogoFiles.light ? '/api/brand/logo/light' : null,
          dark: brandLogoFiles.dark ? '/api/brand/logo/dark' : null,
        },
      };
    } catch {
      brandChrome = null;
    }
    return brandChrome;
  };
  /**
   * The pack's own webfont, for a page the server renders itself (the
   * collection bearer page, plans/31 §5) rather than for the shell.
   *
   * The shell reads `/api/brand` and picks a family from the tokens; a
   * server-rendered page has no such machinery and no script, so it needs one
   * concrete `@font-face`. Variable faces are preferred - one file covers every
   * weight, which is the whole point of shipping one - and a pack with no
   * webfonts simply gets the system stack. Memoised: the pack is immutable for
   * a process.
   */
  let brandFont: { family: string; file: string } | null | undefined;
  const brandFontFile = async (): Promise<typeof brandFont> => {
    if (brandFont !== undefined) return brandFont;
    try {
      const names = (await readdir(join(config.instance.pack, 'catalog', 'fonts', 'webfonts')))
        .filter((n) => n.toLowerCase().endsWith('.woff2') && !/mono/i.test(n))
        .sort();
      const file = names.find((n) => /variable/i.test(n)) ?? names[0];
      brandFont = file ? { family: (file.split(/[-.]/)[0] as string) || 'Brand', file } : null;
    } catch {
      brandFont = null;
    }
    return brandFont;
  };

  router.add('GET', '/api/brand', async (_req, res) => {
    const c = await loadBrandChrome();
    if (!c) return sendError(res, 404, 'NO_BRAND', 'this pack ships no design tokens');
    sendJson(res, 200, c, { 'cache-control': 'public, max-age=300' });
  });
  router.add('GET', '/api/brand/logo/:variant', async (_req, res, ctx) => {
    await loadBrandChrome();
    const variant = ctx.params.variant === 'dark' ? 'dark' : ctx.params.variant === 'light' ? 'light' : null;
    const file = variant ? brandLogoFiles[variant] : undefined;
    if (!file) return sendError(res, 404, 'NOT_FOUND', 'this pack ships no brand logo');
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      res.end(bytes);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such logo');
    }
  });
  router.add('GET', '/api/brand/font/:file', async (_req, res, ctx) => {
    const file = ctx.params.file ?? '';
    if (!/^[A-Za-z0-9._[\]-]+\.woff2$/.test(file)) return sendError(res, 400, 'INVALID_INPUT', 'bad font name');
    try {
      const bytes = await readFile(join(config.instance.pack, 'catalog', 'fonts', 'webfonts', file));
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' });
      res.end(bytes);
    } catch {
      sendError(res, 404, 'NOT_FOUND', 'no such font');
    }
  });

  // ── brand profiles (plans/29): a profile-aware pack carries multiple brands
  // under <pack>/brands/<name>/, one active via the catalog symlink + the
  // .lolly-profile marker. Reading which is active is member-visible (the
  // console's Design system tab); switching is owner/admin, audited, and
  // re-points the pack so the new brand themes the console, sign-in and tools.
  router.add('GET', '/api/v1/brand/profiles', async (req, res) => {
    const user = await memberOf(req);
    const p = principalOf(req);
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    sendJson(res, 200, await listBrandProfiles(config.instance.pack), { 'cache-control': 'no-store' });
  });

  router.add('PUT', '/api/v1/brand/profile', async (req, res) => {
    const user = await requireAction(req, res, 'brand.switch');
    if (!user) return;
    const body = (await readJson(req)) as { name?: string } | null;
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name) return sendError(res, 400, 'INVALID_INPUT', 'name required');
    const before = await listBrandProfiles(config.instance.pack);
    if (!before.available) return sendError(res, 409, 'NOT_PROFILE_AWARE', 'this deployment’s pack has no brand profiles');
    if (!before.profiles.some((pr) => pr.name === name)) return sendError(res, 404, 'NOT_FOUND', `no such brand profile: ${name}`);
    if (before.active === name) return sendJson(res, 200, { ok: true, unchanged: true, ...before });
    try {
      await switchBrandProfile(config.instance.pack, name);
    } catch (err) {
      return sendError(res, 409, 'PROFILE_SWITCH_FAILED', (err as Error).message);
    }
    // The pack pointer moved - drop every cache derived from it so the new brand
    // serves immediately. brandChrome is memoized forever; the asset caches are
    // mtime-gated, but a symlink swap can share an mtime, so clear them too.
    brandChrome = undefined;
    delete brandLogoFiles.light;
    delete brandLogoFiles.dark;
    assetByIdCache.delete(config.instance.pack);
    assetPathMapCache.delete(config.instance.pack);
    await audit(`user:${user.id}`, 'brand.profile.switch', `brand:${name}`, { profile: name, from: before.active ?? null });
    sendJson(res, 200, { ok: true, ...(await listBrandProfiles(config.instance.pack)) });
  });

  // ── SCIM provisioning (plans/31 §8) ───────────────────────────────────────
  // Two surfaces. The ADMIN half (/api/v1/scim/tokens) mints and revokes the
  // bearer an IdP holds - owner-only, cookie-authed like the rest of the console
  // API. The PROTOCOL half (/scim/v2/*) is what the IdP calls, authed by that
  // bearer and speaking SCIM 2.0. The users it manages are the SAME rows OIDC
  // upserts (sub is the externalId, so provisioning and sign-in resolve to one
  // row), and Group membership is the SAME localGroups the console edits - SCIM
  // is another writer of the one identity model, never a second one.
  const SCIM_PAGE_MAX = 200;
  const scimBase = config.instance.baseUrl.replace(/\/+$/, '');
  const scimJson = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const scimErr = (res: ServerResponse, status: number, detail: string, scimType?: string): void => {
    scimJson(res, status, scimErrorBody(status, detail, scimType), status === 401 ? { 'www-authenticate': 'Bearer' } : undefined);
  };
  /** Resolve the SCIM bearer to the connector it authorizes, or answer 401. */
  const scimAuth = async (req: IncomingMessage, res: ServerResponse): Promise<{ idp: string; tokenId: string } | null> => {
    const secret = bearerFromHeader(req.headers.authorization as string | undefined);
    if (!secret) { scimErr(res, 401, 'a Bearer provisioning token is required'); return null; }
    const rec = await store.findScimTokenByHash(hashScimSecret(secret));
    if (!rec || rec.revokedAt) { scimErr(res, 401, 'invalid or revoked provisioning token'); return null; }
    void store.touchScimToken(rec.id, new Date().toISOString());
    return { idp: rec.idp, tokenId: rec.id };
  };

  // Admin: mint / list / revoke provisioning tokens (owner-only).
  router.add('POST', '/api/v1/scim/tokens', async (req, res) => {
    const user = await requireAction(req, res, 'scim.manage');
    if (!user) return;
    const body = (await readJson(req)) as { idp?: unknown } | null;
    const idp = typeof body?.idp === 'string' ? body.idp.trim().slice(0, 80) : '';
    if (!idp) return sendError(res, 400, 'INVALID_INPUT', 'idp (a label for the IdP connector) is required');
    const { secret, tokenHash } = mintScimSecret();
    const rec: ScimTokenRecord = {
      id: `sct_${randomId(8)}`, idp, tokenHash, createdBy: `user:${user.id}`, createdAt: new Date().toISOString(),
    };
    await store.putScimToken(rec);
    await audit(`user:${user.id}`, 'scim.token.create', `scim:${rec.id}`, { idp });
    // The secret is returned ONCE, here, and never again: it is not recoverable
    // from the stored hash.
    sendJson(res, 201, { id: rec.id, idp, token: secret, createdAt: rec.createdAt }, { 'cache-control': 'no-store' });
  });
  router.add('GET', '/api/v1/scim/tokens', async (req, res) => {
    const user = await requireAction(req, res, 'scim.manage');
    if (!user) return;
    // Metadata only - never the hash, never the secret.
    const tokens = (await store.listScimTokens()).map((t) => ({
      id: t.id, idp: t.idp, createdBy: t.createdBy, createdAt: t.createdAt,
      ...(t.lastUsedAt ? { lastUsedAt: t.lastUsedAt } : {}),
      ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}),
    }));
    sendJson(res, 200, { tokens }, { 'cache-control': 'no-store' });
  });
  router.add('DELETE', '/api/v1/scim/tokens/*', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'scim.manage');
    if (!user) return;
    const id = (ctx.params['*'] ?? '').trim();
    if (!(await store.revokeScimToken(id, new Date().toISOString()))) {
      return sendError(res, 404, 'NOT_FOUND', 'no such live token');
    }
    await audit(`user:${user.id}`, 'scim.token.revoke', `scim:${id}`);
    sendJson(res, 200, { ok: true, id }, { 'cache-control': 'no-store' });
  });

  // Protocol: ServiceProviderConfig - the capability discovery many IdPs probe.
  router.add('GET', '/scim/v2/ServiceProviderConfig', async (req, res) => {
    if (!(await scimAuth(req, res))) return;
    scimJson(res, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: SCIM_PAGE_MAX },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{
        type: 'oauthbearertoken', name: 'OAuth Bearer Token',
        description: 'A provisioning token minted by an instance owner.',
      }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${scimBase}/scim/v2/ServiceProviderConfig` },
    });
  });

  // Users --------------------------------------------------------------------
  router.add('GET', '/scim/v2/Users', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const filter = parseScimFilter(ctx.url.searchParams.get('filter'));
    const all = await store.listUsers();
    const rows = filter
      ? all.filter((u) => (filter.attr === 'userName' ? u.email : u.sub) === filter.value)
      : all;
    // Bounded page: the IdP reconciles against this, it does not mirror it.
    scimJson(res, 200, scimList(rows.slice(0, SCIM_PAGE_MAX).map((u) => userToScim(u, scimBase)), rows.length));
  });
  router.add('POST', '/scim/v2/Users', async (req, res) => {
    if (!(await scimAuth(req, res))) return;
    const parsed = parseUserCreate(await readJson(req));
    if ('error' in parsed) return scimErr(res, 400, parsed.error, 'invalidValue');
    if (await store.getUserBySub(parsed.sub)) {
      return scimErr(res, 409, `a user with this ${parsed.sub === parsed.email ? 'userName' : 'externalId'} already exists`, 'uniqueness');
    }
    const created = await store.upsertUserBySub({
      sub: parsed.sub, email: parsed.email,
      ...(parsed.firstname ? { firstname: parsed.firstname } : {}),
      ...(parsed.lastname ? { lastname: parsed.lastname } : {}),
      groups: [], role: 'member',
    });
    // active:false at creation is a provisioned-but-suspended account: disable it
    // at once (which also sets the epoch, so no session ever mints for it live).
    const final = parsed.active ? created : (await store.setUserDisabled(created.id, new Date().toISOString())) ?? created;
    await audit('scim', 'scim.user.create', `user:${created.id}`, { sub: parsed.sub, active: parsed.active });
    scimJson(res, 201, userToScim(final, scimBase), { location: `${scimBase}/scim/v2/Users/${encodeURIComponent(created.id)}` });
  });
  router.add('GET', '/scim/v2/Users/:id', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const u = await store.getUser(ctx.params.id as string);
    if (!u) return scimErr(res, 404, 'no such user');
    scimJson(res, 200, userToScim(u, scimBase));
  });
  router.add('PATCH', '/scim/v2/Users/:id', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const u = await store.getUser(ctx.params.id as string);
    if (!u) return scimErr(res, 404, 'no such user');
    const patch = parseUserPatch(await readJson(req));
    if ('error' in patch) return scimErr(res, 400, patch.error, 'invalidValue');
    let next = u;
    // Attribute changes ride the same upsert OIDC login uses, passing the
    // EXISTING idpGroups so membership is untouched (that is Groups' job) and
    // omitting disabledAt so it is preserved (that is `active`'s job, below).
    if (patch.firstname !== undefined || patch.lastname !== undefined || patch.email !== undefined) {
      const firstname = patch.firstname ?? u.firstname;
      const lastname = patch.lastname ?? u.lastname;
      next = await store.upsertUserBySub({
        sub: u.sub, email: patch.email ?? u.email,
        ...(firstname !== undefined ? { firstname } : {}),
        ...(lastname !== undefined ? { lastname } : {}),
        ...(u.title ? { title: u.title } : {}),
        groups: u.idpGroups, role: u.role,
      });
    }
    if (patch.active !== undefined) {
      next = (await store.setUserDisabled(u.id, patch.active ? null : new Date().toISOString())) ?? next;
      await audit('scim', patch.active ? 'scim.user.enable' : 'scim.user.disable', `user:${u.id}`);
    }
    scimJson(res, 200, userToScim(next, scimBase));
  });
  router.add('DELETE', '/scim/v2/Users/:id', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const u = await store.getUser(ctx.params.id as string);
    if (!u) return scimErr(res, 404, 'no such user');
    // A SCIM delete is a DEPROVISION, not a hard erase: the row and its audit
    // trail stay, disabled with the epoch bumped, so off-boarding never rewrites
    // history. The same soft-delete enterprise IdPs expect.
    await store.setUserDisabled(u.id, new Date().toISOString());
    await audit('scim', 'scim.user.disable', `user:${u.id}`, { via: 'delete' });
    res.writeHead(204); res.end();
  });

  // Groups -------------------------------------------------------------------
  // A SCIM Group IS a local group; membership is stored per-USER (localGroups),
  // so the members of G are the users carrying G, and a membership PATCH becomes
  // a set of per-user localGroups edits. idpGroups (the OIDC-authoritative set,
  // re-synced on login) are never touched here - localGroups are the durable,
  // admin-and-SCIM-managed lane the model already draws.
  const groupMembers = (users: UserRecord[], name: string): UserRecord[] =>
    users.filter((u) => u.localGroups.includes(name));
  const memberViews = (users: UserRecord[]): Array<{ id: string; display: string }> =>
    users.map((u) => ({ id: u.id, display: displayName(u) }));
  router.add('GET', '/scim/v2/Groups', async (req, res) => {
    if (!(await scimAuth(req, res))) return;
    const [defs, users] = await Promise.all([store.listLocalGroups(), store.listUsers()]);
    scimJson(res, 200, scimList(defs.map((g) => groupToScim(g.name, memberViews(groupMembers(users, g.name)), scimBase))));
  });
  router.add('POST', '/scim/v2/Groups', async (req, res) => {
    if (!(await scimAuth(req, res))) return;
    const body = (await readJson(req)) as { displayName?: unknown; members?: unknown } | null;
    const name = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    if (!name) return scimErr(res, 400, 'displayName is required', 'invalidValue');
    if ((await store.listLocalGroups()).some((g) => g.name === name)) {
      return scimErr(res, 409, 'a group with this displayName already exists', 'uniqueness');
    }
    await store.putLocalGroup({ name, createdAt: new Date().toISOString() });
    const memberIds = Array.isArray(body?.members)
      ? body.members.map((m) => (m && typeof m === 'object' ? String((m as { value?: unknown }).value ?? '') : '')).filter(Boolean)
      : [];
    for (const id of memberIds) {
      const u = await store.getUser(id);
      if (u && !u.localGroups.includes(name)) await store.setLocalGroups(u.id, [...u.localGroups, name]);
    }
    await audit('scim', 'scim.group.create', `group:${name}`, { members: memberIds.length });
    scimJson(res, 201, groupToScim(name, memberViews(groupMembers(await store.listUsers(), name)), scimBase),
      { location: `${scimBase}/scim/v2/Groups/${encodeURIComponent(name)}` });
  });
  router.add('GET', '/scim/v2/Groups/:name', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const name = decodeURIComponent(ctx.params.name as string);
    if (!(await store.listLocalGroups()).some((g) => g.name === name)) return scimErr(res, 404, 'no such group');
    scimJson(res, 200, groupToScim(name, memberViews(groupMembers(await store.listUsers(), name)), scimBase));
  });
  router.add('PATCH', '/scim/v2/Groups/:name', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const name = decodeURIComponent(ctx.params.name as string);
    if (!(await store.listLocalGroups()).some((g) => g.name === name)) return scimErr(res, 404, 'no such group');
    const parsed = parseGroupPatch(await readJson(req));
    if ('error' in parsed) return scimErr(res, 400, parsed.error, 'invalidValue');
    const users = await store.listUsers();
    const current = groupMembers(users, name).map((u) => u.id);
    const target = new Set(applyMemberOps(current, parsed.ops));
    const currentSet = new Set(current);
    // Write only the users whose membership actually moved; a member id naming
    // no user is ignored, never invented.
    for (const u of users) {
      const want = target.has(u.id);
      if (currentSet.has(u.id) === want) continue;
      await store.setLocalGroups(u.id, want ? [...u.localGroups, name] : u.localGroups.filter((g) => g !== name));
    }
    await audit('scim', 'scim.group.patch', `group:${name}`, { before: current.length, after: target.size });
    scimJson(res, 200, groupToScim(name, memberViews(groupMembers(await store.listUsers(), name)), scimBase));
  });
  router.add('DELETE', '/scim/v2/Groups/:name', async (req, res, ctx) => {
    if (!(await scimAuth(req, res))) return;
    const name = decodeURIComponent(ctx.params.name as string);
    if (!(await store.listLocalGroups()).some((g) => g.name === name)) return scimErr(res, 404, 'no such group');
    await store.deleteLocalGroup(name); // strips it from every member's localGroups
    await audit('scim', 'scim.group.delete', `group:${name}`);
    res.writeHead(204); res.end();
  });

  // ── the Lolly web shell, served same-origin at / (plans/16: one origin, so
  // session cookies work and the shell's org/ seam activates). Registered LAST,
  // so every API/console/catalog/render/link route wins; only unmatched GETs
  // reach the SPA fallback. Absent shellDir → these routes aren't added at all.
  const shellDir = config.instance.shellDir;
  const RESERVED_PREFIX = /^(api|catalog|render|l|admin|scim|healthz|activate)(\/|$)/;
  if (shellDir) {
    const serveShell = async (res: ServerResponse, rel: string): Promise<void> => {
      const clean = normalize(rel.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
      if (clean.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
      // A path ending in a file extension is a real asset; anything else is an
      // SPA route → index.html (the shell hash-routes from there).
      const asset = /\.[a-z0-9]+$/i.test(clean);
      const target = asset && clean ? clean : 'index.html';
      try {
        const bytes = await readFile(join(shellDir, target));
        res.writeHead(200, {
          'content-type': contentType(target),
          'cache-control': target === 'index.html' ? 'no-cache' : 'public, max-age=300',
        });
        res.end(bytes);
      } catch {
        // Missing real asset → 404; a missing index means the shellDir is wrong.
        sendError(res, 404, 'NOT_FOUND', asset ? 'no such file' : 'shell index not found — check instance.shellDir');
      }
    };
    router.add('GET', '/', (_req, res) => void serveShell(res, 'index.html'));
    router.add('GET', '/*', (_req, res, ctx) => {
      const p = ctx.params['*'] || '';
      if (RESERVED_PREFIX.test(p)) return sendError(res, 404, 'NOT_FOUND', `no route for GET /${p}`);
      void serveShell(res, p);
    });
  } else if (config.dev.enabled) {
    // No web shell mounted but the passwordless dev provider is on → this is the
    // hosted testing sandbox (deploy/vercel, lolly.work). Serve a demo landing at
    // `/` that fronts the governed console + the render endpoint with one-click
    // persona sign-in. Never appears on a real IdP-backed deploy (dev.enabled is
    // false there). Registered LAST, so every real route still wins.
    const landing = demoLandingHtml(config);
    router.add('GET', '/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(landing);
    });
  }

  // Dev-only CORS: lets a Vite dev-server shell (npm run dev:web on another port)
  // talk to this instance with credentials. Gated hard on dev.enabled and to
  // localhost origins - never a production surface. Same-origin serving (above)
  // is the primary path and needs none of this.
  const devCors = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!config.dev.enabled) return false;
    const origin = req.headers.origin;
    if (!origin || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-lolly-client, if-none-match');
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  };

  return async (req, res) => {
    if (devCors(req, res)) return;
    // Fleet: every tagged request feeds the version histogram (plans/10 §1).
    const client = parseClientHeader(req.headers['x-lolly-client'] as string | undefined);
    if (client) void store.recordClient(client);
    // Install identity (plans/34 wave 3): a shell may add `install/<id>` to its
    // tag. The registry row is written ONLY when the request carries a live
    // member session - anonymous and guest traffic can never mint one - and it
    // rides requests the person's own use already makes: there is no heartbeat
    // and no phone-home anywhere. Fire-and-forget like the histogram.
    const installId = client?.extra?.install;
    if (client && installId && installId.length <= 64) {
      void resolveMember(store, req.headers.cookie, secrets.session)
        .then((u) => (u ? store.upsertInstall(installId, client, u.id) : undefined))
        .catch(() => {});
    }
    let routeClass = 'unmatched';
    res.on('finish', () => metrics.httpRequest(routeClass, statusClass(res.statusCode)));
    // Rate-limit the unauthenticated surface only (auth, telemetry ingest, /l/:id);
    // authenticated console/API paths never map to a surface, so are never throttled.
    const surface = rateLimitSurface(req.method ?? 'GET', new URL(req.url ?? '/', 'http://local').pathname);
    if (surface) {
      const verdict = limiter.take(surface, clientIp(req, config.rateLimit.trustedProxyHops));
      if (!verdict.ok) {
        routeClass = `ratelimited:${surface}`;
        metrics.rateLimited(surface);
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(verdict.retryAfterSec) });
        res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'too many requests — slow down' } }));
        return;
      }
    }
    try {
      const matched = await router.dispatch(req, res);
      if (matched) routeClass = matched;
      else sendError(res, 404, 'NOT_FOUND', `no route for ${req.method} ${req.url}`);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (!res.headersSent) sendError(res, status, status === 500 ? 'INTERNAL' : 'BAD_REQUEST', (err as Error).message);
    }
  };
}

/** Pick a horizontal brand wordmark for a theme from a pack's catalog index and
 *  return its catalog-relative URL. Prefers the on-theme variant (on-light for
 *  light, on-dark for dark) and, within that, the brand-colour face for light and
 *  the white mono face for dark; degrades gracefully to any 'logo' vector. Chrome
 *  only - the caller serves it through the narrow /api/brand/logo passthrough. */
function pickBrandLogoUrl(
  assets: Array<{ type?: string; tags?: string[]; formats?: Array<{ format?: string; url?: string }> }>,
  theme: 'light' | 'dark',
): string | undefined {
  const has = (a: { tags?: string[] }, t: string) => Array.isArray(a.tags) && a.tags.includes(t);
  const logos = assets.filter((a) => a?.type === 'vector' && has(a, 'logo'));
  if (!logos.length) return undefined;
  const horizontal = logos.filter((a) => has(a, 'horizontal'));
  const shaped = horizontal.length ? horizontal : logos;
  const themed = shaped.filter((a) => has(a, theme === 'dark' ? 'on-dark' : 'on-light'));
  const pool = themed.length ? themed : shaped;
  let pick = pool[0];
  if (!pick) return undefined;
  const prefer = theme === 'dark' ? ['white', 'green'] : ['green', 'black'];
  for (const p of prefer) {
    const m = pool.find((a) => has(a, p));
    if (m) {
      pick = m;
      break;
    }
  }
  const fmt = pick.formats?.find((f) => f.format === 'svg') ?? pick.formats?.[0];
  return fmt?.url;
}

type ActorInfo = { name: string; email: string };

/** id → display name, falling back to the id itself so an unknown/opaque actor
 *  still renders something readable. */
function actorName(actors: Map<string, ActorInfo> | undefined, id: string): string {
  return actors?.get(id)?.name ?? id;
}

/** Shape an Approval for the wire: the caller's viewer id resolves `mine`, and
 *  the current step name/rule is surfaced so clients render step context without
 *  re-deriving it. `relation` is set by the list route. */
function serializeApproval(
  a: Approval,
  viewerId: string,
  relation?: 'mine' | 'inbox',
  actors?: Map<string, ActorInfo>,
) {
  const step = currentStep(a);
  return {
    id: a.id,
    subjectType: a.subjectType,
    subjectRef: a.subjectRef,
    title: a.title,
    chainId: a.chainId,
    chainName: a.chain.name,
    state: a.state,
    stepIndex: a.stepIndex,
    stepCount: a.chain.steps.length,
    stepName: step?.name ?? null,
    stepRule: step?.rule ?? null,
    // Full ordered step list - the console derives every node's name/group/rule
    // from here (stepName goes null at the approved terminal, so it can't).
    steps: a.chain.steps.map((s) => ({ name: s.name, rule: s.rule, groups: s.approvers.groups })),
    nominees: a.nominees,
    nomineeNames: a.nominees.map((id) => actorName(actors, id)),
    // Resolve opaque actor ids to display names so "who acted" is readable.
    actions: a.actions.map((x) => ({
      ...x,
      actorName: actorName(actors, x.actor),
      actorEmail: actors?.get(x.actor)?.email ?? null,
    })),
    createdBy: a.createdBy,
    createdByName: actorName(actors, a.createdBy),
    createdAt: a.createdAt,
    mine: a.createdBy === viewerId,
    ...(relation ? { relation } : {}),
  };
}

/** Map an ApprovalError code to an HTTP status for the act/withdraw routes. */
function approvalStatus(code: string): number {
  if (code === 'SEPARATION_OF_DUTIES' || code === 'NOT_ELIGIBLE') return 403;
  if (code === 'TERMINAL' || code === 'NO_STEP') return 409;
  return 400;
}

function contentType(path: string): string {
  if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.webmanifest')) return 'application/manifest+json';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

export { ROLES, roleFromGroups };
