/**
 * The lolly-work HTTP app — auth, org-config, telemetry, inbox, links,
 * catalog serving, fleet. Plain (req, res) handler (see router.ts) so it
 * runs under node:http, a container, or a Vercel function unchanged.
 *
 * Render routes are stubbed 501 until the fourth-shell render plane lands —
 * the cache-key/link contracts they'll honour are already fixed
 * (render/cache-key.ts, links/sign.ts).
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { InstanceConfig, Secrets } from '../config/instance.ts';
import type { ProjectRecord, SessionRecord, Store, UserRecord } from '../store/types.ts';
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
import { evaluate, grantDecision, denialCode, mayEditCollab, ownerOnlyAction, roleFromGroups, type Grant, type Role, ROLES } from '../rbac/evaluate.ts';
import { canSeeProject } from '../rbac/project-access.ts';
import {
  buildInviteMessage, eligibleInvitees, mayJoinSession, normalizeQuery, sessionLabel,
  INVITEE_LIMIT, MAX_LABEL_CHARS,
} from '../collab/invites.ts';
import { filterToolIndex, normalizeOverlay, toolVisibleTo } from '../policy/overlay.ts';
import {
  applyLifecycleToIndex, assetState, buildPathMap, combinedState, entryWindow, type AssetIndex, type AssetIndexEntry, type LifecycleRow,
} from '../catalog/lifecycle.ts';
import { callerSeesProvider, createFederation, credentialContext, mapProviderAsset, passesExposure } from '../catalog/federation.ts';
import { applyCredentialsToIndex, detectCredential, type CredentialRow } from '../catalog/credentials.ts';
import { composeInstanceAssets, instanceAssetVisible, materializedIdFor, INST_PREFIX } from '../catalog/instance-assets.ts';
import { materializeProvider, materializeAsset, cutoverProvider, pinAsset } from '../catalog/materialize.ts';
import { verifyLollyExport, extractProvenance } from '../catalog/publish.ts';
import { listBrandProfiles, switchBrandProfile } from '../brand/profiles.ts';
import { createMemoryBlobStore } from '../blobs/memory.ts';
import type { BlobStore } from '../blobs/types.ts';
import { EXT_PREFIX, extAssetId, PROVIDER_KINDS, type ProviderKind, type ProviderRecord } from '../catalog/providers/types.ts';
import { createProvider } from '../catalog/providers/registry.ts';
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
import { renderTool, RenderError, invalidateRenderByTool } from '../render/pipeline.ts';
import { resolveC2paSigner } from '../render/c2pa-signer.ts';
import type { ProvenanceDoc, ProvenanceIngredient } from '../render/provenance.ts';
import type { Profile } from '../render/contract.ts';
import { hashPassword, randomId, sealSecret, secretFingerprint, verifyPassword } from '../lib/crypto.ts';
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
  applyAction, createApproval, currentStep, isEligible, isTerminal, normalizeChain, stepOf, validateNominees, withdraw,
  type Approval, type SubjectType,
} from '../approvals/engine.ts';

const STATE_COOKIE = 'lw_state';
const LINK_KINDS: LinkKind[] = ['share', 'embed', 'download', 'guest-edit'];
const SUBJECT_TYPES: SubjectType[] = ['asset', 'tool-change', 'config', 'guest-link'];

export interface AppDeps {
  config: InstanceConfig;
  store: Store;
  secrets: Secrets;
  fetchImpl?: typeof fetch;
  /** Injectable metrics registry (tests pass a fresh one to assert counter deltas). */
  metrics?: Metrics;
  /** Live collab-room snapshot for the admin console's Rooms panel
   *  (`GET /api/v1/collab/rooms`, OSS plans/100 §7, lolly-work plans/14 §6).
   *  A plain function, not a `CollabGateway` import — this module is also
   *  bundled into a Vercel function, and `collab/gateway.ts` pulls in `ws`
   *  (see its own header on why that import stays out of this graph). main.ts
   *  builds the collab gateway BEFORE this app so it can inject
   *  `() => collab.snapshot()`; the Vercel path never wires the gateway at
   *  all, so this stays undefined there and the route just answers `[]`. */
  listCollabRooms?: () => RoomSnapshot[];
  /** Instance-mediated "nearby" registry (plans/26 §8). Like `listCollabRooms`,
   *  this is injected only by the long-lived server (main.ts) and left undefined on
   *  Vercel, where an in-memory presence registry cannot work across function
   *  instances — the routes answer 501 there rather than a misleading partial list. */
  nearby?: NearbyRegistry;
  /** Byte storage for instance-owned catalog assets (plans/26 §2, plans/27 §5).
   *  main.ts builds the configured driver (pg default / s3); tests and the
   *  Vercel path fall back to an in-memory store. */
  blobs?: BlobStore;
}

export function buildApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, store, secrets, listCollabRooms, nearby } = deps;
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
  // Advertised to shells via org_config (plans/23 §3.A) — computed HERE, beside
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
  // authenticate an `upgrade` request with byte-identical semantics — including
  // the disabled-account and pre-epoch-token refusals.
  const memberOf = (req: IncomingMessage): Promise<UserRecord | null> =>
    resolveMember(store, req.headers.cookie, secrets.session);

  const audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) =>
    store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });

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
      // The public sandbox (dev.enabled) serves the deployment docs to anyone —
      // the console reads this so an anonymous visitor can land straight on the
      // Docs view (see console/app.js publicMode) instead of the sign-in gate.
      // Mirrors the server-side `docsReadable` gate below, so the two never drift.
      publicDocs: config.dev.enabled,
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

  // Dev provider — secret-free local sign-in, gated hard on config.dev.enabled.
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

  // ── org-config: the one polled document ───────────────────────────────────
  // Assembled once, here, for BOTH the caller's own poll and the admin
  // preview-as-group tool — so a preview can never drift from what a member
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
    metrics.orgConfigPoll(); // the fleet heartbeat — counts 200 and 304
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
  // A read-only projection — no session minted, nothing stored — gated on
  // policy.edit so the brand/admin team authoring governance can verify it.
  // Role is derived by the SAME roleFromGroups sign-in uses, so previewing
  // `groups=admin` honestly shows admin escalation. The synthetic id can't
  // collide with a real user id, so only group:/`*` grants apply — never some
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
    // Governed tools this group would NOT see — omitted from the member
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
    if (!body?.target || (!body.target.toolId && !body.target.sessionId)) {
      return sendError(res, 400, 'INVALID_INPUT', 'target.toolId or target.sessionId required');
    }
    const action = kind === 'guest-edit' ? 'link.create-guest' : 'link.create';
    const grants = await store.listGrants();
    // The SAME selectors the gateway's per-gesture re-check asks with
    // (`mayCreateGuestLinks`, `links/sign.ts`'s own doc on why this is one
    // function) — a tool-scoped grant must authorize the identical resource
    // shape at mint time and on every later gesture, or the two silently disagree.
    const selectors = linkResourceSelectors(body.target);
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, selectors, grants)) {
      return sendError(res, 403, denialCode(action), `not allowed: ${action}`);
    }
    if (kind === 'guest-edit' && !config.policy.guestLinks.enabled) {
      return sendError(res, 403, 'GUEST_LINKS_DISABLED', 'guest links are disabled on this deployment');
    }
    // A link's target.sessionId is a destination the MINTER must already be
    // able to reach — plans/02 §8's "destination project/session so the
    // guest's work saves server-side" presumes the inviter picked one of
    // their OWN sessions, not any id in the instance. Without this, holding
    // `link.create-guest` (a per-group grant, not "trust every project") is
    // enough to mint a writer seat on a session whose project the minter
    // cannot themselves see — bypassing `canSeeProject`, `collab.join` and
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
    await audit(`user:${user.id}`, 'link.create', `link:${link.id}`, { kind, toolId: body.target.toolId ?? null });
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
    // share / embed / download — render the BAKED stored target to bytes. The
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
      const result = await renderTool({ config, resolveProvenance, worker: renderWorker, signer: await getC2paSigner() }, {
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
    sendJson(res, 200, { clients: await store.fleetSummary() });
  });

  // Schema readiness — pending migrations on the live store. Owner-gated
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

  // Live collab rooms — the admin console's Rooms panel (OSS plans/100 §7,
  // lolly-work plans/14 §6). Gated the same as `/api/v1/stats/overview` below:
  // `telemetry.view` is this instance's "console dashboard read" tier, reused
  // there for non-telemetry stats for the same reason — this is another
  // Overview-style read, not a distinct capability worth its own grant.
  // `listCollabRooms` is the room registry's OWN copy (rooms.ts
  // `RoomRegistry.list`/`Room.snapshotForAdmin`) — counters, roles and display
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

  // The chain head alone (seq + hash + intact flag) — small enough to record
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

  // Wire shape for one user — the People-view row. Splits effective `groups`
  // into its idp/local sources so the console can render the (read-only) mirror
  // distinctly from the editable local set.
  // Telemetry consent is deliberately ABSENT here (plans/09 §2a): opting out
  // must not be conspicuous, so a person's consent state is visible to that
  // person alone (org-config `telemetry.consented`) — never a directory
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

  // One user by id — backs the activity feed's "focus this person" deep link
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
  // Same guard as disable — an owner's sessions are owner-only to revoke.
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

  // Nominatable approvers for a chain step — what the shell's "Request approval"
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
        if (a.createdBy === user.id) continue; // separation of duties — never review your own
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
    if (isTerminal(next.state)) {
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
    sendJson(res, 200, serializeApproval(next, user.id, undefined, await actorsMap()));
  });

  // Blob → assetId, mirroring render/pipeline.ts's mtime-checked catalog
  // version cache: assets/index.json is read + parsed once per pack per
  // change, not on every blob request. Lifecycle rows themselves are NOT
  // cached here — they live in the store and are fetched fresh per request.
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
    // consumed asset — the export can then distinguish "source said nothing"
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

  /** Compact header summary — full doc is embedded in the bytes themselves. */
  const provenanceHeader = (doc: ProvenanceDoc | undefined): Record<string, string> =>
    doc
      ? { 'x-lolly-provenance': JSON.stringify(doc.ingredients.map((i) => ({
          assetId: i.assetId,
          source: i.source.kind === 'provider' ? i.source.provider : 'pack',
          ...(i.source.kind === 'provider' && i.source.filename ? { filename: i.source.filename } : {}),
        }))) }
      : {};

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
    // inst/* path — nothing that referenced the federated identity breaks (plans/27 §5).
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
      // A pin's identity stays ext/* until cutover, so gate it EXACTLY like the
      // ext blob route would — the local lifecycle row AND the upstream
      // availability window — never a phantom inst-keyed row (plans/27 §3, §5).
      // An exited or submit asset gates on its own inst row (no window).
      const isPin = !rec.exited && !!rec.origin;
      const govId = isPin ? extAssetId(rec.origin!.provider, rec.origin!.remoteId) : id;
      const row = await store.getLifecycle(govId);
      const window = isPin ? await federation.availabilityWindow(govId) : undefined;
      const { state, upstreamExpired } = combinedState(row ?? undefined, window, Date.now());
      const blocked = state === 'revoked' || state === 'scheduled' || (state === 'expired' && (upstreamExpired || row?.onExpiry !== 'warn'));
      if (blocked) return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
      const blobId = rec.blobs[formatRef];
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
        'x-content-type-options': 'nosniff',
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
      const row = await store.getLifecycle(assetId);
      // Combine the local row with any upstream availability window imported
      // from the DAM (plans/27 §2), read off the in-process fragment beside the
      // lifecycle row we already load. Upstream expiry blocks bytes even under
      // onExpiry:'warn' — that only ever softens a purely-local expiry.
      const window = await federation.availabilityWindow(assetId);
      const { state, upstreamExpired } = combinedState(row ?? undefined, window, Date.now());
      const blocked = state === 'revoked' || state === 'scheduled' || (state === 'expired' && (upstreamExpired || row?.onExpiry !== 'warn'));
      if (blocked) return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
      // hold-implies-pin (plans/27 §3, §5): when this asset's bytes have been
      // materialized into the instance's own store, prefer the local copy — the
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
              'content-type': local.stat.contentType, 'x-content-type-options': 'nosniff',
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
          'x-content-type-options': 'nosniff',
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
        const [rows, creds, instAssets] = await Promise.all([store.listLifecycle(), store.listCredentials(), store.listInstanceAssets()]);
        const composed = composeInstanceAssets(federated, instAssets, user?.groups ?? []);
        const gated = applyLifecycleToIndex(composed, rows, Date.now());
        return sendJson(res, 200, applyCredentialsToIndex(gated, creds), { 'cache-control': 'private, max-age=60' });
      } catch {
        /* not the expected shape — serve raw below */
      }
    } else {
      // Any other catalog file: if it's a format entry owned by an asset
      // whose lifecycle blocks it (revoked, scheduled, or expired-and-hidden),
      // the blob dies too — a guessed/cached URL doesn't bypass the feed.
      const assetId = (await loadAssetPathMap(config.instance.pack)).get(rel);
      if (assetId) {
        const row = await store.getLifecycle(assetId);
        const state = assetState(row ?? undefined, Date.now());
        const blocked = state === 'revoked' || state === 'scheduled' || (state === 'expired' && row?.onExpiry !== 'warn');
        if (blocked) {
          const message = state === 'revoked' ? 'this asset has been revoked' : state === 'scheduled' ? 'this asset is not yet published' : 'this asset has expired';
          return sendError(res, 410, 'ASSET_EXPIRED', message);
        }
      }
    }
    res.writeHead(200, { 'content-type': contentType(rel), 'cache-control': 'private, max-age=300' });
    res.end(bytes);
  });

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
  // Metadata only — never bytes; the console links to the existing gated
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
    const id = (ctx.params['*'] ?? '').trim();
    if (!id || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) {
      return sendError(res, 400, 'INVALID_INPUT', 'bad asset id');
    }
    const instAsset = id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
    const entry = instAsset?.entry ?? (await loadAssetIndexById(config.instance.pack)).get(id);
    const row = await store.getLifecycle(id);
    // For a federated id the effective state can be constrained by an upstream
    // window as well as the local row; surface both so the console can show
    // where each constraint came from (plans/27 §2). Pack ids have no window.
    await providersReady;
    const [window, credential] = await Promise.all([federation.availabilityWindow(id), store.getCredential(id)]);
    if (!entry && !row && !window && !credential && !instAsset) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
    const { state } = combinedState(row ?? undefined, window, Date.now());
    sendJson(res, 200, {
      id,
      ...(entry ?? {}),
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
      // Detection, never a verdict: {present, container, when} — validation is
      // the reader's, in the console's verify view (plans/27 §4).
      credentials: credential
        ? { status: credential.status, ...(credential.container ? { container: credential.container } : {}), sniffedAt: credential.sniffedAt, ...(credential.sourceUpdatedAt ? { sourceUpdatedAt: credential.sourceUpdatedAt } : {}) }
        : null,
    }, { 'cache-control': 'private, max-age=30' });
  });

  // On-demand content-credential scan (plans/27 §4): fetch the asset's primary
  // format once and sniff whether its BYTES embed a C2PA manifest the DAM's API
  // never surfaced. It costs an upstream fetch, so it is permissioned
  // (catalog.scan) and audited; it records only {present, container} — detection,
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
  // ride the telemetry summary instead — see summarize().
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
    // folded from the audit log — the demand instrument behind plans/14 §9's
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
  // only — no actors, subjects, or values — so it sits at the same disclosure
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
  // 'suse/tokens/brand') — same trailing-wildcard support the catalog/admin
  // static routes use. Body merges onto any existing row; `revoke: true`
  // stamps revokedAt=now and is audited under its own action so "stop
  // sharing" reads distinctly from an ordinary expiry-date edit.
  //
  // A `hold` arm (`hold: {note?} | null`) rides the same PUT but is its own
  // operation (plans/27 §3): it needs `catalog.hold` rather than
  // `catalog.expire`, only ever touches the hold field (dates/revoke are left
  // as they are), and audits as catalog.hold / catalog.hold.release. A hold, in
  // turn, is deliberate friction: while it is set, revocation and any edit that
  // would make the asset unavailable now are refused 409 ASSET_HELD — release
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
    // materializes its bytes so they survive upstream deletion. Best-effort —
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

  // ── grants control plane (plans/03) ───────────────────────────────────────
  // The fine-grained RBAC layer under everything else. `grant.edit` is admin,
  // with one escalation guard: grants touching an owner-only action can be
  // created or deleted ONLY by an owner — otherwise an admin could mint
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
   *  type/label/options verbatim). Direct read — this is the ADMIN surface,
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

  // Every tool in the pack (unfiltered — governing a tool you've hidden from
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
    // hit old bytes — same reasoning as the bulk-edit bust).
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
  // connected shells' ETag on their next poll — the surprise lights up on flip.
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

  // ── injectables (plans/19) — the governed rail that injects tools / flags /
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
  // Wire shape: never the ciphertext, never the fragment body — config, a
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
    try {
      const provider = createProvider(rec, secret, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
      const health = await provider.healthCheck();
      if (!health.ok) return sendJson(res, 200, { health, sample: [] });
      const page = await provider.listAssets();
      const sample = page.assets.slice(0, 10).map((a) => mapProviderAsset(rec, a));
      return sendJson(res, 200, { health, sample, sampleTotal: page.assets.length }, { 'cache-control': 'no-store' });
    } catch (err) {
      return sendJson(res, 200, { health: { ok: false, detail: (err as Error).message }, sample: [] }, { 'cache-control': 'no-store' });
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
  // The plaintext is never stored, logged, audited, or returned — the response
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
    // A credential-less provider can't serve — force the kill switch off too.
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
      sendJson(res, 200, { ok: true, assetCount: fragment.assets.length, syncedAt: fragment.syncedAt, hash: fragment.hash });
    } catch (err) {
      sendError(res, 502, 'PROVIDER_UNAVAILABLE', `sync failed: ${(err as Error).message}`);
    }
  });

  // The exit (plans/27 §5): materialize a provider's bytes into the instance's
  // own BlobStore. Admin governance (catalog.provider.manage); the provider stays
  // enabled — this only mints instance-owned copies. Body: {remoteId?} for one
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
      const embedded = results.filter((r) => r.credential === 'embedded').length;
      // Always audit what succeeded, even on a partial run — the copies persist
      // (idempotent, a re-run resumes), so they must leave a trail.
      await audit(`user:${user.id}`, 'catalog.provider.materialize', `provider:${rec.id}`, { count: results.length, skipped, credentialsFound: embedded, failed: errors.length });
      sendJson(res, 200, { ok: errors.length === 0, materialized: results.length, skipped, credentialsFound: embedded, assets: results, ...(errors.length ? { errors } : {}) }, { 'cache-control': 'no-store' });
    } catch (err) {
      sendError(res, 502, 'MATERIALIZE_FAILED', (err as Error).message);
    }
  });

  // Search-and-import (plans/30 §3.1): snapshot ONE provider asset into inst/* — the
  // curation gate for sources like Penpot whose media lives only in search, never in
  // the auto-federated feed. Uses the driver's getAsset seam (single-asset fetch by
  // remoteId) and falls back to a listAssets scan for providers that don't implement
  // it. Admin-gated like materialize; the result is a pin — the owner-gated cutover
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
    // A db-managed provider is disabled here (its job is done). A config-managed
    // one can only be turned off in instance.json, but that's fine: its ext
    // entries are shadowed by the instance copies and old URLs alias — so it
    // does no harm enabled, and the operator removes the config entry when ready.
    if (rec.managedBy !== 'config') {
      await store.putProvider({ ...rec, enabled: false, updatedAt: new Date().toISOString() });
    }
    federation.invalidate(rec.id);
    const enabled = rec.managedBy === 'config' ? rec.enabled : false;
    await audit(`user:${user.id}`, 'catalog.provider.cutover', `provider:${rec.id}`, { migrated, disabled: !enabled });
    sendJson(res, 200, { ok: true, migrated, enabled, configManaged: rec.managedBy === 'config' });
  });

  // Publish out (plans/27 §10): push a lolly-generated export INTO a destination
  // provider (Optimizely CMP). Owner-grantable (catalog.provider.publish), narrow
  // by construction — the export must carry lolly's C2PA export assertion, so a
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
      // `bytes` is already a Buffer (a Uint8Array) — pass it through, don't re-copy.
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
    const withInstance = composeInstanceAssets(
      await federation.composeIndex(index, user.groups), await store.listInstanceAssets(), user.groups,
    );
    const composed = applyCredentialsToIndex(
      applyLifecycleToIndex(withInstance, lifecycleRows, Date.now()),
      await store.listCredentials(),
    );
    const matches = (e: { id: string; name?: unknown; description?: unknown; tags?: unknown }): boolean =>
      [e.id, e.name, e.description, ...(Array.isArray(e.tags) ? e.tags : [])]
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
  // Member-only throughout (guests never reach these — memberOf yields null →
  // 401). A project is a folder over sessions; visibility gates WHICH projects a
  // caller sees, RBAC grants gate WHAT they may do.
  // `canSeeProject` now lives in ../rbac/project-access.ts — the collab ws
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

  // GET /projects — projects visible to the caller (own + team by group; admins all).
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

  // GET a project's sessions — list without inputs (cheap); requires visibility.
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

  // PUT a session — optimistic CAS on rev. A stale rev ⇒ 409 with the current
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
      // Ids and revs only — an audit event never carries input values.
      await audit(`user:${user.id}`, 'session.conflict', `session:${session.id}`, { rev: session.rev, sentRev: body.rev, toolId: session.toolId });
      return sendJson(res, 409, { error: { code: 'CONFLICT', message: `session is at rev ${session.rev}, you sent ${body.rev}` }, current: sessionFull(session) });
    }
    const now = new Date().toISOString();
    const inputs = body.inputs !== undefined ? asObject(body.inputs) : session.inputs;
    const meta = body.meta !== undefined ? asObject(body.meta) : session.meta;
    const next: SessionRecord = { ...session, inputs, meta, rev: session.rev + 1, updatedBy: user.id, updatedAt: now };
    // The rev check above is a courtesy (cheap, and its 409 carries `current`) —
    // the WRITE must still be a CAS: `readJson` was awaited between check and
    // here, so two writers can both pass the check at the same rev and the
    // second `putSession` would silently discard the first while
    // `session_revisions` (PK `(session_id, rev)`) kept only one of them — the
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

  // DELETE a session — tombstone (never hard-delete) so a stale client can't
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

  // POST /sessions/bulk — multi-edit: merge `set` by EXACT input id into every
  // matched session (the client /pro batch rule). Needs BOTH session.edit and
  // project.manage. dryRun previews a per-field diff; apply writes each session
  // via per-session CAS (`matched` is a snapshot, so a session someone edited
  // in between is exactly the one a sweep must not stomp — plans/23 §3.B),
  // reporting losers in `skipped` rather than retrying; appends a revision per
  // applied session, busts affected render keys, and audits ONE event (keys
  // only — never input VALUES).
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
   *  order — so a caller sees the same status for the same session whether they
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

  // Invite autocomplete. Read-access only — an OBSERVER may look up who else
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

  // Invite someone into the room. Requires the WRITE right — `mayEditCollab`,
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
    // which it was — the autocomplete is the only sanctioned way to learn who
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
    // not "one ever" — a colleague asking to be re-invited after clearing their
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
  // it approximate — the copy says "likely nearby", never "on your network").
  // Members only: both routes gate on `collab.join`, which members hold and guests
  // (whose member session is absent → requireAction 401s) do not, so guests never
  // appear and never read the list. The registry is in-memory and injected only by
  // the long-lived server, so both routes answer 501 on Vercel — where a POST and a
  // GET can hit different function instances — rather than a misleading partial list.
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
  // GET /render/<toolId>.<format> — server-side render of a tool via the real
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
      const result = await renderTool({ config, resolveProvenance, worker: renderWorker, signer: await getC2paSigner() }, {
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
  // Bundle-aware data-dir base — see api/_lib/bootstrap.ts's FN_ROOT note. When the
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
  // unlisted markdown file is not reachable here — that IS the allowlist (slugs
  // are additionally shape-checked, and the join is never caller-controlled).
  //
  // Readership: on a governed (IdP-backed) deploy these are member-only — every
  // page is operator prose, and the ONE polled document a shell reads is already
  // member-visible. On the PUBLIC sandbox (dev.enabled — lolly.work) the same
  // pages are open to anyone: they are the identical public-repo content in every
  // deploy, and the landing page (lib/demo-landing.ts) links straight to them so
  // a visitor can read the docs without a passwordless sign-in dance. `docsReadable`
  // is that one rule, shared by the five docs read routes below; it mirrors the
  // `publicDocs` flag advertised at GET /api/auth/config so the console agrees.
  const docsDir = dataDir('docs/');
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  interface DocsManifest {
    title?: string;
    oss?: { label?: string; path?: string; note?: string };
    sections?: Array<{ id?: string; title?: string; docs?: Array<{ slug?: string; title?: string; summary?: string }> }>;
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
        // A NAV_ICONS id the console renders beside the group header — id-shaped
        // only; the console ignores ids it doesn't know, so this can never
        // inject markup.
        ...(typeof (s as { icon?: unknown }).icon === 'string' && /^[a-z-]+$/.test((s as { icon: string }).icon)
          ? { icon: (s as { icon: string }).icon } : {}),
        docs: (s.docs ?? []).filter((d) => typeof d.slug === 'string' && SLUG_RE.test(d.slug)),
      })).filter((s) => s.docs.length);
      docsManifest = { ...raw, sections };
    } catch {
      docsManifest = null;
    }
    return docsManifest;
  };
  const docSlugs = async (): Promise<Set<string>> => {
    const m = await loadDocsManifest();
    return new Set((m?.sections ?? []).flatMap((s) => (s.docs ?? []).map((d) => d.slug as string)));
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
    if (!SLUG_RE.test(slug) || !(await docSlugs()).has(slug)) return sendError(res, 404, 'NOT_FOUND', 'no such doc');
    try {
      const text = await readFile(join(docsDir, `${slug}.md`), 'utf8');
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
  //                 date, kind, geometry) — decoded server-side because the
  //                 air-gap console cannot decode C2PA itself. Descriptive only:
  //                 the pass/fail verdict is the reader's to reach in #/verify.
  // The shape check IS the allowlist against traversal (no slashes, no '..'); the
  // SVGs load only via <img>, which never executes embedded script.
  const SHOT_RE = /^[a-z0-9][a-z0-9.-]*\.(svg|png)$/i;
  const shotsDir = join(docsDir, 'shots');
  // Plain illustrative images for the docs (docs/img/ — vendored third-party
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

  // ── brand chrome, UNAUTHENTICATED — so the sign-in screen inherits the
  // instance's brand (colours + fonts) before a session exists. Deliberately
  // narrow: it returns ONLY the pack's design tokens and serves ONLY its font
  // files — non-sensitive brand chrome (the same colours/typefaces on a public
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
    // The pack pointer moved — drop every cache derived from it so the new brand
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

  // ── the Lolly web shell, served same-origin at / (plans/16: one origin, so
  // session cookies work and the shell's org/ seam activates). Registered LAST,
  // so every API/console/catalog/render/link route wins; only unmatched GETs
  // reach the SPA fallback. Absent shellDir → these routes aren't added at all.
  const shellDir = config.instance.shellDir;
  const RESERVED_PREFIX = /^(api|catalog|render|l|admin|healthz)(\/|$)/;
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
  // localhost origins — never a production surface. Same-origin serving (above)
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
 *  only — the caller serves it through the narrow /api/brand/logo passthrough. */
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
    // Full ordered step list — the console derives every node's name/group/rule
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
