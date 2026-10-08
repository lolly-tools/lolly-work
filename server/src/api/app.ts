import { WorkerError } from '../render/worker-client.ts';
import { createFilePreview, readPreviewInput, PREVIEW_INPUT_LIMIT } from '../catalog/file-preview.ts';
import { visibleSourceStatuses } from '../catalog/source-status.ts';
import { registerCommentRoutes } from '../comments/routes.ts';
import { registerShareRoutes } from '../access/share-routes.ts';
import { resolveSharingPolicy } from '../policy/sharing.ts';
/**
 * The lolly-work HTTP app - auth, org-config, telemetry, inbox, links,
 * catalog serving, fleet. Plain (req, res) handler (see router.ts) so it
 * runs under node:http, a container, or a Vercel function unchanged.
 *
 * Render routes are stubbed 501 until the fourth-shell render plane lands - 
 * the cache-key/link contracts they'll honour are already fixed
 * (render/cache-key.ts, links/sign.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { linkByEmailFor, linkKeys, passwordIdpOf, sessionKeys, type InstanceConfig, type Secrets } from '../config/instance.ts';
import type { InvitationRecord, PasswordLinkRecord, ProjectMemberRole, ProjectRecord, ProjectSessionStats, ScimTokenRecord, SessionRecord, SessionSummary, Store, UserRecord } from '../store/types.ts';
import type { RoomSnapshot } from '../collab/rooms.ts';
import type { NearbyRegistry } from '../collab/nearby.ts';
import { createRouter, readJson, readRaw, sendError, sendJson, type Handler, type RouteCtx } from './router.ts';
import { readShotCred } from './shot-provenance.ts';
import { CONSOLE_ASSET_HEADERS, consoleDocumentHeaders } from './console-headers.ts';
import { mintToken, verifyToken } from '../iam/tokens.ts';
import {
  GUEST_COOKIE, SESSION_COOKIE, clearCookie, guestActor, mintGuestCookie, mintSessionCookie, parseCookies, readPrincipal,
  type Principal, type SessionUser,
} from '../iam/sessions.ts';
import { buildAuthorizeUrl, discover, exchangeCode, mapClaims, pkcePair, verifyIdToken, fetchJwks, kidOf, type MappedIdentity } from '../iam/oidc.ts';
import { displayName, resolveMember } from '../iam/member.ts';
import { resolveProxyIdentity } from '../iam/proxy-auth.ts';
import { createDeviceAuth, normalizeUserCode } from '../iam/device-auth.ts';
import {
  ACCOUNT_NAME_MAX, activateDoneHtml, activateFormHtml, activateSignedOutHtml, admissionRefusedHtml, idpChooserHtml, passwordLinkDeadHtml,
  passwordLoginHtml, passwordSetHtml, signInErrorHtml, type JoinAsk,
} from '../iam/activate-page.ts';
import {
  OPERATOR_LINK_ISSUER, PASSWORD_LINK_TTL_MS, PASSWORD_MIN_LENGTH, checkPasswordRules, hashPassword as hashSignInPassword, normaliseEmail,
  passwordRuleMessage, passwordSetUrl, verifyPassword as verifySignInPassword,
} from '../iam/password.ts';
import { buildGitHubAuthorizeUrl, exchangeGitHubCode, fetchGitHubIdentity, GitHubSignInError } from '../iam/github.ts';
import { bootstrapOwnerGroup, decideAdmission, emailIsVerified, type AdmissionDecision, type AdmissionIdentity, type AdmissionIdp } from '../iam/admission.ts';
import {
  accountSignInSeen, identityWire, idpPin, isAccountSignIn, LINKED_STANDING_DAYS, resolveSignIn, signInUpsert, standingGroups,
  subjectHash, unlinkBlock, type SignInResolution,
} from '../iam/identities.ts';
import { PACK_MAX_BYTES, type InstancePackMeta } from '../catalog/instance-pack.ts';
import { readBlobBody } from '../blobs/types.ts';
import { createNotifier } from '../notify/notify.ts';
import { createPeopleNotifier } from '../notify/people.ts';
import { invitePageUrl, mintInviteToken } from '../access/invite-token.ts';
import type { RequestDeps } from '../access/types.ts';
import type { AskIdentity, AskTokenPayload } from '../access/types.ts';
import { registerInviteRoutes, type InviteRef } from '../access/invite-routes.ts';
import { registerProjectInviteLinks } from '../access/project-invite-links.ts';
import { relativeTime, utcDay } from '../access/pages.ts';
import { DECLINE_SHOWN_DAYS, closeRequestsForEmail, requestStateFor } from '../access/requests.ts';
import { acceptedNotice, noticeContext, skippedNotice, welcomeNotice } from '../access/messages.ts';
import { maskEmail, maskEmailSpoken } from '../access/mask.ts';
import { registerAccessRoutes } from '../access/routes.ts';
import { SERVICE_TOKEN_PREFIX, TOKEN_ROLES, hashServiceSecret, mintServiceSecret, serviceAccountFor } from '../iam/service-tokens.ts';
import { runRetention } from '../audit/retention.ts';
import { bearerFromHeader, hashScimSecret, mintScimSecret } from '../scim/tokens.ts';
import {
  applyMemberOps, groupToScim, parseGroupPatch, parseScimFilter, parseUserCreate, parseUserPatch,
  scimErrorBody, scimList, userToScim,
} from '../scim/resources.ts';
import { evaluate, grantDecision, denialCode, mayEditCollab, ownerOnlyAction, roleFromGroups, type Grant, type Role, ROLES } from '../rbac/evaluate.ts';
import { accessAtLeast, canSeeProject, configureSharingLimits, effectiveProjectAccess, type ProjectAccess } from '../rbac/project-access.ts';
import { projectListing } from '../access/share-routes.ts';
import { registerProjectFileRoutes } from '../projects/file-routes.ts';
import { registerProjectFolderRoutes } from '../projects/folder-routes.ts';
import { agentActor, agentAttribution } from '../agents/attribution.ts';
import { registerAgentRoutes } from '../agents/routes.ts';
import { createProjectRequests } from '../agents/project-requests.ts';
import type { AgentRoomBridge } from '../agents/types.ts';
import { mintRenderRead, renderReader } from '../render/read-ticket.ts';
import { projectFilesEnabled, removeUploadsBy } from '../projects/files.ts';
import { buildShareMessage, createWindowQuota, mergeInvitationProject, nameWithoutEmail, roleAbove } from '../projects/sharing.ts';
import { approversFor, closeRequestsOnAccess } from '../access/requests.ts';
import type { ProjectRequestWire } from '../access/types.ts';
import { inviteDomainAllowed, mayInviteNewPeople, resolveInvitePolicy } from '../policy/invites.ts';
import { PROJECT_MEMBER_ROLES, type InvitationProject } from '../store/types.ts';
import {
  buildInviteMessage, eligibleInvitees, mayJoinSession, normalizeQuery, sessionLabel,
  INVITEE_LIMIT, MAX_LABEL_CHARS,
} from '../collab/invites.ts';
import { normalizeOverlay, toolVisibleTo, resolveInputAccess } from '../policy/overlay.ts';
import {
  applyLifecycleToIndex, assetState, buildPathMap, combinedState, entryWindow,
  type AssetFormatEntry, type AssetIndex, type AssetIndexEntry, type AssetState, type LifecycleRow,
} from '../catalog/lifecycle.ts';
import { buildFragment, callerSeesProvider, createFederation, credentialContext, mapProviderAsset, passesExposure } from '../catalog/federation.ts';
import { createServedIndex } from '../catalog/served-index.ts';
import { createExtCache, extCacheKey } from '../catalog/ext-cache.ts';
import { browseAssets, normalisedQuery, parseBrowseQuery } from '../catalog/asset-browse.ts';
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
import { isDataSubmissionType } from '../catalog/submit-data.ts';
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
import {
  applyTagRules, hideEntryTags, loadTagRules, normalizeHiddenTags, tagCensus, validTagScope,
  INSTANCE_SCOPE, type CatalogTagRule, type CensusInput,
} from '../catalog/tag-rules.ts';
import { verifyLollyExport, extractProvenance } from '../catalog/publish.ts';
import { createBrandService, BrandError } from '../brand/service.ts';
import { createBrandRuleService } from '../brand/rule-service.ts';
import { managedRuleContext, projectRuleOverlay, sourceRules, hash as brandPolicyHash } from '../brand/rules.ts';
import { registerBrandRoutes } from '../brand/routes.ts';
import { createBrandChrome } from '../brand/chrome.ts';
import { createMemoryBlobStore } from '../blobs/memory.ts';
import type { BlobStore } from '../blobs/types.ts';
import { createDeliveryProvider } from '../delivery/registry.ts';
import { deliveryContentType, destinationAvailableTo, destinationDescriptor, destinationVersion } from '../delivery/destinations.ts';
import type { ConfigDeliveryDestination, DeliveryRecord } from '../delivery/types.ts';
import { EXT_PREFIX, extAssetId, PROVIDER_KINDS, type CatalogProvider, type ProviderAssetRef, type ProviderKind, type ProviderRecord } from '../catalog/providers/types.ts';
import { createProvider } from '../catalog/providers/registry.ts';
import { PROVIDER_SETUPS, validateGuidedProvider } from '../catalog/providers/setup.ts';
import { previewGuidedProvider } from '../catalog/providers/setup-preview.ts';
import { providerOAuthInfo, providerSetupRevision, registerProviderOAuth } from '../catalog/providers/setup-oauth.ts';
import { noDetailShapeLine, noShapeLine, renderShapeReport, type ProviderShapeReport } from '../catalog/providers/shape.ts';
import { invalidateAccessTokens } from '../catalog/providers/oauth.ts';
import { assembleOrgConfig, maySetPasswordFromLink } from '../policy/org-config.ts';
import { resolveAiPolicy } from '../policy/ai.ts';
import { renderCapabilities } from '../render/capabilities.ts';
import { assessSetup, productionMode, type SetupReport } from '../setup/checks.ts';
import { inspectPack } from '../setup/pack.ts';
import { consoleAccess } from '../setup/console-access.ts';
import { registerSetupRoutes } from '../setup/routes.ts';
import { identitySettingsHash } from '../setup/configuration.ts';
import { loadEngine } from '../render/contract.ts';
import type { AuditFilter } from '../audit/filter.ts';
import { flagGovernanceCatalog, normalizeFlagGovernance } from '../policy/feature-flags.ts';
import { validatePublish, factsFor } from '../injectables/registry.ts';
import { KIND_HANDLERS } from '../injectables/kinds.ts';
import { INJECTABLE_KINDS, type InjectableRecord } from '../injectables/types.ts';
import { buildConfigDocument, validateConfigDocument, diffConfigDocument, requiredActions, commitConfigApply, canonicalHash, diffSummary } from '../policy/config-doc.ts';
import { readToolInputs } from '../policy/tool-inputs.ts';
import { checkLink, linkPath, linkResourceSelectors, DEFAULT_TTL_SEC, type LinkKind, type LinkRecord } from '../links/sign.ts';
import { accentFromTokens, collectionPageHtml, isPreviewableFormat, type CollectionPageItem } from '../links/collection-page.ts';
import { safeEntryName, ZipBuilder } from '../links/zip.ts';
import { renderTool as renderToolUnscoped, RenderError, invalidateRenderByTool } from '../render/pipeline.ts';
import { compileVerb, diffVerb, documentVerb, packageVerb, queryFromInputs, schemaVerb, validateVerb } from '../automation/verbs.ts';
import { AutomationQueue, jobWire, type AutomationJob } from '../automation/jobs.ts';
import { RenderRunner } from '../renders/runner.ts';
import { registerRenderRoutes } from '../renders/routes.ts';
import { RenderResourceError, type RenderSpec } from '../renders/types.ts';
import { createHostedAssetResolver, optimizeHostedAsset, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';
import { resolveBindingRows, type DataBinding } from '../automation/bindings.ts';
import { resolveC2paSigner } from '../render/c2pa-signer.ts';
import { CATALOG_INDEX_REL, CATALOG_SIG_REL, callerCanSeeTool, createCatalogSigning, servedToolIndexBytes } from '../catalog/signing.ts';
import { publicCard, shellStubFor } from '../shell/share-cards.ts';
import { isToolKeyedCatalogPath, servedToolSidecar } from '../catalog/tool-sidecars.ts';
import type { ProvenanceDoc, ProvenanceIngredient } from '../render/provenance.ts';
import type { Profile } from '../render/contract.ts';
import { ScryptBusyError, hashPassword, randomId, sameString, scryptQueueFull, sealSecret, secretFingerprint, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { demoLandingHtml } from '../lib/demo-landing.ts';
import { sanitizeEvent, summarize, type RawEvent } from '../telemetry/ingest.ts';
import { targetedMessages, type Message } from '../inbox/target.ts';
import { accessibleNotices, listAccessibleNotices } from '../inbox/comment-notices.ts';
import { parseClientHeader } from '../fleet/client-header.ts';
import { verifyChain, deriveAuditMacKey } from '../audit/chain.ts';
import { createLogger, requestId } from '../observability/log.ts';
import { safeReturnTo } from '../iam/return-to.ts';
import { registerPasskeyRoutes, passkeysEnabled } from '../iam/passkeys/routes.ts';
import { csrfVerdict } from '../iam/csrf.ts';
import { auditHead } from '../audit/head.ts';
import { createMetrics, statusClass, metricsGate, type Metrics, type GaugeLine } from '../observability/metrics.ts';
import { createRateLimiter, clientIp, rateLimitSurface } from '../observability/rate-limit.ts';
import { agentDashboard } from '../agents/dashboard.ts';
import { buildActivity } from '../activity/feed.ts';
import {
  applyAction, createApproval, currentStep, eligibleForCurrentStep, isEligible, isTerminal, normalizeChain,
  stepOf, validateNominees, withdraw,
  type Approval, type SubjectType,
} from '../approvals/engine.ts';
import { shellSecurityHeaders } from './shell-headers.ts';
import { shellDocsPath } from './shell-docs.ts';

const STATE_COOKIE = 'lw_state';
/** The signed half of the password forms' double-submit token (`lw/form`). */
const FORM_COOKIE = 'lw_form';
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
  agentRooms?: AgentRoomBridge;
  /** Live comment events (plan 76 M4): main.ts wires `(id, f) => collab.notifyComment(id, f)`
   *  so peers in the session's room fetch only the changed thread. A plain function,
   *  like `agentRooms`, so this module never imports the gateway; undefined on Vercel,
   *  where GET comments then reports `features.events: false`. */
  roomEvents?: (sessionId: string, frame: { t: 'comment'; threadId: string; revision: number }) => void;
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
  projectPresence?: (projectId: string) => import('../collab/rooms.ts').SessionPresenceSnapshot[];
  /** Instance-mediated "nearby" registry (plans/26 §8). Like `listCollabRooms`,
   *  this is injected only by the long-lived server (main.ts) and left undefined on
   *  Vercel, where an in-memory presence registry cannot work across function
   *  instances - the routes answer 501 there rather than a misleading partial list. */
  nearby?: NearbyRegistry;
  /** False when this process runs no collab gateway (the Vercel function): the
   *  org-config collab bits then say no, so the shell offers no room that cannot
   *  connect. main.ts runs the gateway and leaves this unset. */
  liveCollab?: boolean;
  /** Byte storage for instance-owned catalog assets (plans/26 §2, plans/27 §5).
   *  main.ts builds the configured driver (pg default / s3); tests and the
   *  Vercel path fall back to an in-memory store. */
  blobs?: BlobStore;
  /** Test/deployment injection for config-managed destination credentials.
   *  Production defaults to each destination's credentialRef environment var. */
  destinationSecrets?: ReadonlyMap<string, string>;
  /** Explicit host ownership: main.ts starts/stops this runner; function hosts
   * omit the callback and cannot accept work they cannot reliably execute. */
  onRenderRunner?: (runner: RenderRunner) => void;
  /** How often the durable render and automation runners look for queued work
   *  (main.ts reads LW_BACKGROUND_POLL_MS). Unset keeps their 1 s default; 0
   *  sets no timer, so work is picked up at boot, on submission and after each
   *  finished item only. A long-lived host on a database that scales to zero
   *  needs that: a query every second keeps the database awake all month. */
  backgroundPollMs?: number;
}

export function buildApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config: deploymentConfig, store, secrets, listCollabRooms, nearby } = deps;
  store.configureRoleGroups(deploymentConfig.idp.roleGroups);
  configureSharingLimits(resolveSharingPolicy(deploymentConfig.policy.sharing));
  const blobs = deps.blobs ?? createMemoryBlobStore();
  const brand = createBrandService(deploymentConfig, store, blobs, {
    ...(productionMode(deploymentConfig) ? { inspectSource: async (source: string) => {
      const report = await inspectPack(deploymentConfig.instance.pack, { source,
        workerConfigured: !!deploymentConfig.render.worker.url && !!secrets.renderWorker,
        requireServerRendering: deploymentConfig.deployment.requireServerRendering });
      return report.compatible ? [] : ['The replacement pack is incompatible with this deployment. Run inspect:pack for tool diagnostics.'];
    } } : {}),
  });
  const brandRules = createBrandRuleService(brand, store, deploymentConfig.dev.enabled);
  const config = { ...deploymentConfig, instance: { ...deploymentConfig.instance, get pack() { return brand.root(); } } };
  const renderTool = (...args: Parameters<typeof renderToolUnscoped>) => {
    const run = async () => {
      const snap = brand.current()!;
      const policyHash = brandPolicyHash([...args[1].overlays]);
      const managedRules = await managedRuleContext(snap, args[1].toolId, args[1].format === 'jpeg' ? 'jpg' : args[1].format);
      const out = await renderToolUnscoped({ ...args[0], brandRevision: snap.revision, managedRules,
        workerReadToken: mintRenderRead(args[1].principal?.groups ?? [], snap.revision, secrets.link) }, args[1]);
      if ((await brand.snapshot()).revision !== snap.revision || brandPolicyHash([...await store.listOverlays()]) !== policyHash) throw new BrandError('Brand or organisation policy changed during rendering. Retry with the current revision.', 409, 'BRAND_REVISION_CHANGED');
      if (managedRules) await sourceRules(snap);
      return out;
    };
    return brand.current() ? run() : brand.run(run);
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secure = config.instance.baseUrl.startsWith('https:');
  const sessionTtlSec = config.policy.sessionTtlHours * 3600;
  const router = createRouter();
  const agentRequests = createProjectRequests(router);
  const metrics = deps.metrics ?? createMetrics();
  const limiter = createRateLimiter(config.rateLimit);
  const automationResultUrl = (job: AutomationJob): string => {
    const token = mintToken('lw/job', { jobId: job.id, principal: job.principal }, secrets.link, 24 * 3600);
    return `${config.instance.baseUrl}/api/v1/jobs/${job.id}/result?token=${encodeURIComponent(token)}`;
  };
  const automationJobs = new AutomationQueue({
    store,
    blobs,
    fetchImpl,
    callbackSecret: secrets.webhook,
    // Callback egress is an instance decision, never an arbitrary request-time
    // URL. Reuse the configured webhook endpoint as the initial allowlist.
    callbackAllowed: (url) => url === config.notify.webhook?.url,
    resultUrl: automationResultUrl,
    ...(deps.backgroundPollMs !== undefined ? { pollMs: deps.backgroundPollMs } : {}),
  });
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
  // Per-caller catalog signing (catalog/signing.ts): only with LW_CATALOG_SIGNING_KEY.
  // The key is imported now so a malformed one is reported once at boot, by
  // variable name only; the signature route then answers 503 instead of
  // serving an envelope a key-pinned shell would reject.
  const catalogSigning = secrets.catalogSigningKey ? createCatalogSigning(secrets.catalogSigningKey) : null;
  catalogSigning?.ready.then(
    ({ keyId }) => console.log(`[lolly-work] catalog signing on (keyId ${keyId})`),
    (err: Error) => console.error(`[lolly-work] catalog signing unavailable: ${err.message}`),
  );
  // Memoize the audit-chain gauge so /metrics never runs verifyChain more than
  // ~once/10s regardless of scrape frequency.
  let auditGauge: { at: number; verdict: ReturnType<typeof verifyChain> } | null = null;
  // One full-chain verification at most every 10 s, shared by /metrics, the
  // audit page and the head: a paged audit read never re-walks the whole log.
  const auditVerdict = async (): Promise<ReturnType<typeof verifyChain>> => {
    const now = Date.now();
    if (auditGauge && now - auditGauge.at < 10_000) return auditGauge.verdict;
    const verdict = verifyChain(await store.listAudit(), await store.getAuditAnchor(), auditMacKey);
    auditGauge = { at: now, verdict };
    return verdict;
  };
  const auditIntact = async (): Promise<boolean> => (await auditVerdict()).ok;

  // Dual-key rotation (plans/35 wave 4): every VERIFY path takes the key
  // list (current, then previous); every mint keeps the plain current secret.
  const sessionVerify = sessionKeys(secrets);
  const linkVerify = linkKeys(secrets);

  const principalOf = (req: IncomingMessage): Principal | null =>
    readPrincipal(req.headers.cookie, sessionVerify);

  // Shared with the collab ws gateway (server/src/iam/member.ts), which must
  // authenticate an `upgrade` request with byte-identical semantics - including
  // the disabled-account and pre-epoch-token refusals.
  const memberOf = async (req: IncomingMessage): Promise<UserRecord | null> => {
    const delegated = agentRequests.principal(req);
    if (!delegated) return resolveMember(store, req.headers.cookie, sessionVerify);
    const user = await store.getUser(delegated.userId);
    return user && !user.disabledAt ? user : null;
  };

  const audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => {
    const agent = agentRequests.attribution();
    const delegated = agent && actor === `user:${agent.createdBy}`;
    return store.appendAudit({ at: new Date().toISOString(), actor: delegated ? agentActor(agent) : actor, action, subject,
      ...(payload || delegated ? { payload: { ...payload, ...(delegated ? agentAttribution(agent) : {}) } } : {}) });
  };

  const revisionActor = (req: IncomingMessage, user: UserRecord): string => {
    const agent = agentRequests.principal(req)?.agent;
    return agent ? agentActor(agent) : user.id;
  };
  registerPasskeyRoutes(router, { store, baseUrl: config.instance.baseUrl, instanceName: config.instance.name, secret: secrets.session, verifySecrets: sessionVerify, sessionTtlSec, memberOf, audit });

  // Notification egress (plans/35 wave 1). Refused at boot, not discovered at
  // runtime: a webhook without its signing secret would emit forgeable events,
  // and an authenticated relay without its password can never send.
  if (config.notify.webhook && !secrets.webhook) {
    throw new Error('notify.webhook is configured but LW_WEBHOOK_SECRET is not set');
  }
  if (config.notify.smtp?.user && !secrets.smtpPassword) {
    throw new Error('notify.smtp names a user but LW_SMTP_PASSWORD is not set');
  }
  // Device-code sign-in, store-backed (plans/35 wave 5): rows instead of the
  // former in-memory registry, so any replica answers the poll and serverless
  // has the flow too - the 501 path is gone.
  const deviceAuth = createDeviceAuth(store);

  const notifier = createNotifier({
    config, secrets, fetchImpl,
    onResult: (channel, ok) => metrics.notify(channel, ok ? 'sent' : 'failed'),
  });

  // People notices (invitations and access requests, plans/74 invite spec
  // 2.9 and 2.10). Every one goes through `people`: the inbox today, email
  // once it is switched on. `accessDeps` is what the requests core
  // (access/requests.ts) takes. `inviteLink` mints the personal invite link
  // for one entry of an invitation (projectId null for the workspace link);
  // it is derived each time, never stored, and verified with `linkVerify`.
  const people = createPeopleNotifier({ store, config, notifier });
  const accessDeps: RequestDeps = { store, config, audit, people, now: Date.now };
  const inviteLink = (inv: Pick<InvitationRecord, 'id' | 'linkVersion'>, projectId: string | null): string =>
    invitePageUrl(config.instance.baseUrl, mintInviteToken({ invitationId: inv.id, projectId, version: inv.linkVersion }, secrets.link));

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
    return `${instanceCatalogVersionMemo}/${(brand.current() ?? await brand.snapshot()).revision}`;
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
  // Sizing for DAM-scale catalogs (config/instance.ts `catalogServing`).
  const serving = config.catalogServing ?? {
    maxProviderAssets: 100_000, pagedProviderThreshold: 2000, extCache: { maxBytes: 64 * 1024 * 1024, maxItemBytes: 2 * 1024 * 1024 },
  };
  const federation = createFederation({
    store,
    ...(secrets.credential ? { credentialSecret: secrets.credential } : {}),
    configSecrets,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    maxProviderAssets: serving.maxProviderAssets,
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
  // The composed asset feed, memoised per caller visibility (catalog/served-index.ts),
  // and the bounded cache of federated bytes (catalog/ext-cache.ts).
  const servedIndex = createServedIndex({
    pack: () => config.instance.pack, store, federation, ready: providersReady, pagedThreshold: serving.pagedProviderThreshold,
  });
  const extCache = createExtCache(serving.extCache);
  /** Whether a conditional request already holds `etag` (a list, `*`, or weak forms). */
  const etagMatches = (req: IncomingMessage, etag: string): boolean => {
    const header = req.headers['if-none-match'];
    if (!header) return false;
    return header.split(',').some((t) => {
      const tag = t.trim();
      return tag === '*' || tag.replace(/^W\//, '') === etag;
    });
  };

  // ── outbound delivery destinations ──────────────────────────────────────
  // Fixed, config-managed targets only in v1. This is intentionally a second
  // registry rather than a writable arm on catalog providers: catalog is
  // inbound federation; these credentials authorize outbound bytes.
  const deliveryDestinations = new Map<string, ConfigDeliveryDestination>(
    config.delivery.destinations.map((destination) => [destination.id, destination]),
  );
  const deliverySecrets = deps.destinationSecrets ?? new Map(
    config.delivery.destinations.flatMap((destination) => {
      const value = process.env[destination.credentialRef];
      return value ? [[destination.id, value] as const] : [];
    }),
  );

  // ── hosted asset-provider rung (plans/39 §6) ─────────────────────────────
  // cms://<provider-id>/<remote-id> is resolved by the SAME driver and stored
  // credential as catalog federation. The caller's groups are part of the
  // resolver instance, so a direct provider ref cannot bypass provider exposure.
  const hostedAssetMaxBytes = 64 * 1024 * 1024;
  const configuredAssetOrigins = config.catalogProviders.flatMap((provider) =>
    Object.values(provider.options ?? {}).filter((value): value is string => typeof value === 'string' && /^https:\/\//i.test(value)));
  const findProviderAsset = async (provider: CatalogProvider, remoteId: string): Promise<ProviderAssetRef | null> => {
    if (provider.getAsset) return provider.getAsset(remoteId);
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const batch = await provider.listAssets(cursor);
      const found = batch.assets.find((asset) => asset.remoteId === remoteId);
      if (found) return found;
      if (!batch.next) break;
      cursor = batch.next;
    }
    return null;
  };
  const cmsBytes = (groups: string[]) => async (ref: HostedProviderRef): Promise<{ bytes: Uint8Array; mime: string; id?: string } | null> => {
    await providersReady;
    const rec = await store.getProvider(ref.scope, { includeFragment: false });
    if (!rec || !rec.enabled || !callerSeesProvider(rec, groups)) return null;
    if (!ref.path) throw new Error('cms provider refs require a remote asset id');
    const provider = federation.instantiate(rec);
    const asset = await findProviderAsset(provider, ref.path);
    if (!asset || !passesExposure(rec, asset)) return null;
    const local = await store.getLifecycle(extAssetId(rec.id, asset.remoteId));
    const { state, upstreamExpired } = combinedState(local ?? undefined, entryWindow(mapProviderAsset(rec, asset)), Date.now());
    if (state === 'revoked' || state === 'scheduled' || (state === 'expired' && (upstreamExpired || local?.onExpiry !== 'warn'))) {
      throw new Error(`cms asset is ${state}`);
    }
    const requestedSource = ref.query.sourceFormat ?? ref.query.format;
    const format = asset.formats.find((candidate) => candidate.format === requestedSource) ?? asset.formats[0];
    if (!format) throw new Error('cms asset has no resolvable format');
    const resolved = await provider.resolveBlob(asset.remoteId, format.remoteRef);
    if (resolved.kind === 'stream') {
      if (resolved.size !== undefined && resolved.size > hostedAssetMaxBytes) throw new Error('cms asset exceeds the byte limit');
      return { bytes: new Uint8Array(await readBlobBody(resolved.body, hostedAssetMaxBytes)), mime: resolved.contentType, id: extAssetId(rec.id, asset.remoteId) };
    }
    const response = await fetchImpl(resolved.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) throw new Error(`cms asset fetch failed (${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > hostedAssetMaxBytes) throw new Error('cms asset exceeds the byte limit');
    return {
      bytes: new Uint8Array(await readBlobBody(response.body, hostedAssetMaxBytes)),
      mime: response.headers.get('content-type')?.split(';')[0] ?? `image/${format.format.replace('jpg', 'jpeg')}`,
      id: extAssetId(rec.id, asset.remoteId),
    };
  };
  const hostedResolvers = new Map<string, (ref: HostedProviderRef) => Promise<HostedAssetResult | null>>();
  const hostedAssetResolverFor = (groups: string[]): ((ref: HostedProviderRef) => Promise<HostedAssetResult | null>) => {
    const key = [...new Set(groups)].sort().join('\u0000');
    let resolver = hostedResolvers.get(key);
    if (!resolver) {
      resolver = createHostedAssetResolver({
        // Provider configuration is the net:// egress allowlist. Arbitrary
        // caller origins never enter it; each URL was installed by an operator.
        allowedOrigins: configuredAssetOrigins,
        fetchImpl,
        maxBytes: hostedAssetMaxBytes,
        cms: cmsBytes(groups),
        optimize: optimizeHostedAsset,
      });
      hostedResolvers.set(key, resolver);
    }
    return resolver;
  };

  const returnToSafe = (raw: string | null): string => safeReturnTo(raw, config.instance.baseUrl);
  // Keyed audit MAC (audit/chain.ts): the store signs rows with it, every
  // verification here checks with it. Derived, never stored.
  const auditMacKey = deriveAuditMacKey(secrets.session);
  const log = createLogger();
  // Password guessing against one public link: ten misses lock the link for a
  // quarter hour, on top of the per-IP link bucket. In-memory per process.
  const linkPasswordMisses = new Map<string, { n: number; until: number }>();
  const LINK_PASSWORD_MISSES = 10;
  const LINK_PASSWORD_LOCK_MS = 15 * 60 * 1000;

  let setupMemo: { revision: string; expires: number; report: Promise<SetupReport> } | undefined;
  const setupReport = async () => {
    const snapshot = await brand.snapshot();
    const revision = `${productionMode(config) ? 'production' : 'evaluation'}:${snapshot.revision}`;
    if (!setupMemo || setupMemo.revision !== revision || setupMemo.expires <= Date.now()) {
      setupMemo = { revision, expires: Date.now() + 60_000,
        report: assessSetup(config, secrets, store.storageKind === 'postgres') };
      const current = setupMemo;
      void current.report.catch(() => { if (setupMemo === current) setupMemo = undefined; });
    }
    return setupMemo.report;
  };

  // Readiness, distinct from liveness: a pod whose store cannot answer must
  // leave the Service until it can. Unauthenticated and cheap (`select 1`).
  router.add('GET', '/readyz', async (_req, res) => {
    const storeOk = await store.ping().catch(() => false);
    const configured = !productionMode(config) || (storeOk
      && await store.pendingMigrations().then(pending => pending.length === 0).catch(() => false)
      && await setupReport().then(report => report.ready).catch(() => false));
    const ok = storeOk && configured;
    sendJson(res, ok ? 200 : 503, { ok, store: store.storageKind });
  });
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
    // SIEM delivery lag (plans/35 wave 2): head seq minus confirmed cursor.
    // Emitted only when forwarding is configured, so an alert on it means
    // something and the gauge's very existence documents the wiring.
    if (config.siem.url) {
      const [head, cursor] = await Promise.all([auditHead(store, auditMacKey), store.getSiemCursor()]);
      gauges.push({ name: 'lw_siem_lag', help: 'Audit events not yet confirmed by the SIEM receiver.', type: 'gauge', value: Math.max(0, head.seq - cursor) });
    }
    for (const p of await store.listProviders({ includeFragment: false })) {
      gauges.push({ name: 'lw_provider_enabled', help: 'Catalog provider enabled (1) or disabled (0).', type: 'gauge', labels: { provider: p.id, kind: p.kind }, value: p.enabled ? 1 : 0 });
      gauges.push({ name: 'lw_provider_assets', help: 'Assets last synced from a catalog provider.', type: 'gauge', labels: { provider: p.id }, value: p.state?.assetCount ?? 0 });
      gauges.push({ name: 'lw_provider_last_error', help: 'Provider last sync recorded an error (1) or not (0).', type: 'gauge', labels: { provider: p.id }, value: p.state?.lastError ? 1 : 0 });
      if (p.credentialExpiresAt) {
        gauges.push({ name: 'lw_provider_credential_expiry_days', help: 'Days until the operator-stated credential expiry (negative = past it).', type: 'gauge', labels: { provider: p.id }, value: Math.floor((new Date(p.credentialExpiresAt).getTime() - Date.now()) / 86_400_000) });
      }
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(metrics.renderText(gauges));
  });

  // ── auth ──────────────────────────────────────────────────────────────────
  // The ONE place that says how a person signs in here. Every surface that
  // advertises a provider (the auth config, the instance card, the gate's
  // login link) reads this, so a new provider can never reach one and miss
  // another. Precedence: a real IdP, then the reverse proxy, then the dev
  // provider - the most accountable path wins when several are on. Email and
  // password alone (no issuer) comes after the proxy, and after the dev
  // provider too: passwords are set from links an admin issues, so on an
  // instance still in restricted evaluation (dev on) the dev sign-in is the
  // way to the first admin, and the console gate offers the password form
  // beside it.
  const passwordIdp = passwordIdpOf(config);
  const authProvider = (): { provider: 'oidc' | 'proxy' | 'password' | 'dev' | null; providerName: string | null; loginPath: string | null } => {
    if (config.idp.issuer) return { provider: 'oidc', providerName: config.idp.displayName || null, loginPath: '/api/auth/login' };
    if (config.proxyAuth.enabled) return { provider: 'proxy', providerName: config.proxyAuth.displayName, loginPath: '/api/auth/proxy' };
    if (config.dev.enabled) return { provider: 'dev', providerName: null, loginPath: '/api/auth/dev' };
    if (passwordIdp) return { provider: 'password', providerName: passwordIdp.displayName, loginPath: '/api/auth/login' };
    return { provider: null, providerName: null, loginPath: null };
  };

  router.add('GET', '/api/auth/config', (req, res) => {
    sendJson(res, 200, {
      mode: renderReader(req, brand.current()!.revision, linkVerify) ? 'open' : config.policy.defaultAccessMode,
      ...authProvider(),
      ...(passkeysEnabled(config.instance.baseUrl) ? { passkeyManagementPath: '/api/auth/security' } : {}),
      ...(deps.agentRooms ? { documentAgentPath: '/api/workspace/mcp' } : {}),
      // The public sandbox (dev.enabled) serves the deployment docs to anyone - 
      // the console reads this so an anonymous visitor can land straight on the
      // Docs view (see console/app.js publicMode) instead of the sign-in gate.
      // Mirrors the server-side `docsReadable` gate below, so the two never drift.
      publicDocs: config.dev.enabled,
      // One entry per configured house (plans/36 §3) - a client that wants its
      // own buttons renders these; one that follows loginPath arrives at the
      // chooser when several exist, which needs no client change at all.
      providers: idpProviders(),
      // The sign-in gate's words (plans/74 invite spec M18): the workspace
      // name, whether only invited people get in, and whether someone who
      // is not can ask to join from the refusal page.
      instanceName: config.instance.name,
      inviteOnly: !!config.idp.admission,
      joinRequests: !!config.idp.admission && config.policy.requests.join,
    });
  });

  // ── IdP resolution (plans/36 §3) ──────────────────────────────────────────
  // 'primary' (or absent) is the idp block itself, untouched semantics and raw
  // subs; an additional IdP namespaces its subs `<id>:<sub>` so two issuers
  // handing out the same bare sub can never collide into one row. Confidential
  // secrets ride the env var the ref names - the provider-credentialRef
  // precedent (see the config-managed provider credential resolution below).
  interface ResolvedIdp {
    /** `oidc` for the primary and any issuer; `github` for the OAuth 2.0
     *  adapter (iam/github.ts); `password` for email and password (iam/password.ts). */
    kind: 'oidc' | 'github' | 'password';
    id: string; issuer: string; clientId: string; displayName: string;
    groupsClaim: string; claimMap: typeof config.idp.claimMap; clientSecret?: string; subPrefix: string;
    /** Per-IdP sign-in constraints (plans/74 W-ID-1); never inherited between IdPs. */
    constraints: AdmissionIdp; scope: string; authParams: Record<string, string>;
    /** Whether a verified email may link this IdP's sign-in to an existing user (`linkByEmailFor`). */
    linkByEmail: boolean;
  }
  /** The authorize-request extras and admission pins one IdP block declares. */
  const idpExtras = (c: typeof config.idp | (typeof config.idp.additional)[number]) => ({
    constraints: {
      ...(c.hostedDomain ? { hostedDomain: c.hostedDomain } : {}),
      ...(c.tenantId ? { tenantId: c.tenantId } : {}),
      emailVerification: c.emailVerification ?? 'claim',
    } satisfies AdmissionIdp,
    linkByEmail: linkByEmailFor(c),
    scope: (c.scopes ?? ['openid', 'profile', 'email']).join(' '),
    // A pinned Google domain is also sent as `hd`, so the account picker
    // offers the right account first. Configured authParams.hd must agree.
    authParams: { ...(c.hostedDomain ? { hd: c.hostedDomain } : {}), ...(c.authParams ?? {}) } as Record<string, string>,
  });
  const resolveIdp = (raw: string | null): ResolvedIdp | null => {
    if (!raw || raw === 'primary') {
      if (!config.idp.issuer) return null;
      return {
        kind: 'oidc', id: 'primary', issuer: config.idp.issuer, clientId: config.idp.clientId,
        displayName: config.idp.displayName, groupsClaim: config.idp.groupsClaim,
        claimMap: config.idp.claimMap,
        ...(secrets.idpClientSecret ? { clientSecret: secrets.idpClientSecret } : {}),
        subPrefix: '',
        ...idpExtras(config.idp),
      };
    }
    const extra = config.idp.additional.find((a) => a.id === raw);
    if (!extra) return null;
    const secret = extra.clientSecretRef ? process.env[extra.clientSecretRef] : undefined;
    return {
      kind: extra.kind ?? 'oidc', id: extra.id, issuer: extra.issuer, clientId: extra.clientId,
      displayName: extra.displayName, groupsClaim: extra.groupsClaim, claimMap: extra.claimMap,
      ...(secret ? { clientSecret: secret } : {}),
      // A password subject names the credential, not the entry, so renaming
      // the entry's id never strands the accounts made through it.
      subPrefix: extra.kind === 'password' ? 'password:' : `${extra.id}:`,
      ...idpExtras(extra),
    };
  };

  // ── admission (plans/74 W-ID-1) ───────────────────────────────────────────
  // Asked after the identity is verified and BEFORE any user row is written,
  // on every sign-in, so removing someone from the list blocks their next
  // sign-in. The active invitation for the email (plans/74 W-ID-2) rides
  // along so the caller can accept it once the user row exists. An accepted
  // invitation keeps admitting until it is revoked, so its old expiry no
  // longer applies; a pending one admits only before its expiry.
  //
  // "Disabled" is read across every row with the same email, not only this
  // sub: subs are namespaced per IdP and email is not unique, so a person
  // disabled under one IdP must not walk back in through another (or as a
  // fresh row that the lists or their accepted invitation would admit).
  type SignInAdmission = AdmissionDecision & { invitation: InvitationRecord | null };
  /** How long one sign-in's groups and standing carry over to the person's
   *  other sign-ins (iam/identities.ts `LINKED_STANDING_DAYS`). */
  const linkedStandingMs = (config.idp.linkedStandingDays ?? LINKED_STANDING_DAYS) * 86_400_000;
  /**
   * The invitation a sign-in's other verified addresses carry (GitHub's
   * secondary ones, plans/74 invite spec M5), for when its own address has
   * none that still admits. Only a pending one, or one this same account
   * already accepted, and never one whose address belongs to a disabled
   * account: a second address must not walk a turned-off person back in.
   */
  const invitationForOtherAddress = async (
    addresses: readonly string[], email: string, accountIds: Array<string | undefined>,
  ): Promise<InvitationRecord | null> => {
    const own = email.trim().toLowerCase();
    for (const address of addresses) {
      if (address === own) continue;
      const inv = await store.findActiveInvitation(address);
      if (!inv || (inv.acceptedAt && !accountIds.includes(inv.acceptedUserId))) continue;
      if ((await store.findUsersByEmail(address)).some((u) => !!u.disabledAt)) continue;
      return inv;
    }
    return null;
  };
  const admissionInputs = async (sub: string, email: string, linkedUser?: UserRecord | null, invitationEmails: readonly string[] = []) => {
    const existing = await store.getUserBySub(sub);
    const sameEmail = email.trim() ? await store.findUsersByEmail(email) : [];
    // A sign-in linked to a disabled person is refused like that person's own.
    const disabled = !!existing?.disabledAt || !!linkedUser?.disabledAt || sameEmail.some((u) => !!u.disabledAt);
    const own = config.idp.admission?.invitations === false || !email.trim()
      ? null
      : await store.findActiveInvitation(email);
    // The sign-in's own address first; another verified address only when
    // that one has no invitation that admits (none, or one past its end).
    const ownAdmits = !!own && (!!own.acceptedAt || !own.expiresAt || Date.parse(own.expiresAt) > Date.now());
    const invitation = ownAdmits || config.idp.admission?.invitations === false || !invitationEmails.length
      ? own
      : (await invitationForOtherAddress(invitationEmails, email, [existing?.id, linkedUser?.id])) ?? own;
    const invitationView = invitation
      ? { email: invitation.email, expiresAt: invitation.acceptedAt ? null : invitation.expiresAt ?? null, revokedAt: invitation.revokedAt ?? null }
      : null;
    return { disabled, invitation, invitationView };
  };
  const admitSignIn = async (
    identity: AdmissionIdentity & { sub: string }, idp: AdmissionIdp, resolution?: SignInResolution,
  ): Promise<SignInAdmission> => {
    const linkedUser = resolution && resolution.via !== 'new' ? resolution.user : null;
    const { disabled, invitation, invitationView } = await admissionInputs(identity.sub, identity.email, linkedUser, identity.invitationEmails);
    const decision = decideAdmission({ ...identity, disabled }, idp, config.idp.admission, invitationView);
    // A sign-in already linked to a member (a link row, or a verified-email
    // match) is admitted on that member's standing when only the lists refuse
    // it: a personal GitHub address need not be listed for a person the
    // instance already admits. The per-IdP pins and the disabled state are
    // never bypassed, and the member's own email must still pass the lists.
    // That standing is only as fresh as the account's own sign-in, which
    // passes the work IdP's pins and the lists by itself: once it has not
    // been seen for the window (the work IdP deleted the person, say), a
    // linked sign-in no longer carries them in.
    if (!decision.ok && (decision.reason === 'not-invited' || decision.reason === 'email-unverified')
      && linkedUser && resolution && resolution.via !== 'legacy' && linkedUser.sub !== identity.sub
      && accountSignInSeen(linkedUser, await store.listIdentities(linkedUser.id), Date.now(), linkedStandingMs)
      && await stillAdmitted(linkedUser)) {
      return { ok: true, via: 'linked', emailVerified: emailIsVerified(identity, idp), invitation };
    }
    return { ...decision, invitation };
  };
  /**
   * Whether a stored member would still be admitted, for a session minted
   * without the IdP (the device-code flow). The email was verified at the
   * original sign-in and the per-IdP pins were checked then, so only the
   * lists, the invitation and the disabled state are asked again. A dev
   * sign-in never passed admission, so its rows are not judged by it.
   * When the lists refuse, an invitation this account accepted still admits
   * it until revoked: that covers a person who got in through an invitation
   * sent to another of their addresses (invite spec M5).
   */
  const stillAdmitted = async (user: UserRecord): Promise<boolean> => {
    if (user.sub.startsWith('dev:')) return !user.disabledAt;
    const { disabled, invitationView } = await admissionInputs(user.sub, user.email);
    if (decideAdmission({ email: user.email, emailVerified: true, disabled }, { emailVerification: 'trusted' },
      config.idp.admission, invitationView).ok) return true;
    if (disabled || !config.idp.admission || config.idp.admission.invitations === false) return false;
    return !!(await store.findInvitationAcceptedBy(user.id));
  };
  /**
   * Accept a pending invitation for an account that holds its address, once
   * (plans/74 W-ID-2; invite spec 2.9). Three ways get here: a sign-in that
   * proves the address (`acceptInvitationAtSignIn`), Join on the invite page
   * for a signed-in holder, and a linked sign-in that proves it
   * (`finishLink`); `meta.via` says which. The caller has made sure the
   * account holds the address. The invitation's groups join the person's
   * local groups (any not yet in the local registry are created), its
   * projects are shared, and then the notices go out: a welcome to the
   * invitee, "accepted" to each person who invited them, and one notice
   * per project that could not be applied. The invitee's open join request,
   * and every switch request on this invitation, are moot now and close.
   * Returns the user as it stands.
   */
  const acceptInvitationFor = async (
    user: UserRecord, pending: InvitationRecord,
    meta: { via: 'sign-in' | 'join' | 'link'; provider?: 'oidc' | 'github' | 'password' | 'proxy'; idp?: string },
  ): Promise<UserRecord> => {
    if (pending.acceptedAt || pending.revokedAt) return user;
    const at = new Date().toISOString();
    const accepted = await store.acceptInvitation(pending.id, user.id, at);
    if (!accepted) return user; // expired, revoked or accepted by a racing sign-in
    // Groups go to an account the invitation preceded. The route gives groups
    // straight to an account that holds the address (`accountsHoldingEmail`)
    // and writes an invitation for one that merely claims it, which keeps
    // its groups here: the invitation was not written for that account. An
    // older account takes groups only by signing in with a NEW address,
    // through a sign-in linked to it (plans/74, "One person, many sign-ins"):
    // the invitation was written for whoever holds that mailbox, and that
    // person is this account, so its groups apply. The inviter's own account
    // never takes groups from its own invitation.
    const regroupable = accepted.invitedBy !== `user:${user.id}`
      && (Date.parse(user.createdAt) >= Date.parse(accepted.createdAt) || accepted.email !== user.email.trim().toLowerCase());
    const applied = regroupable ? accepted.groups : [];
    const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
    const createdGroups = applied.filter((g) => !registry.has(g));
    for (const name of createdGroups) await store.putLocalGroup({ name, createdAt: at });
    const joined = applied.filter((g) => !user.localGroups.includes(g));
    const next = joined.length ? (await store.setLocalGroups(user.id, [...user.localGroups, ...joined])) ?? user : user;
    await audit(`user:${user.id}`, 'invite.accept', `invitation:${accepted.id}`, {
      via: meta.via, ...(meta.provider ? { provider: meta.provider } : {}), ...(meta.idp ? { idp: meta.idp } : {}), email: accepted.email,
      groups: accepted.groups, ...(createdGroups.length ? { createdGroups } : {}),
      ...(!regroupable && accepted.groups.length ? { groupsNotApplied: 'existing-account' } : {}),
      ...(accepted.projects?.length ? { projects: accepted.projects } : {}),
    });
    // Projects (plans/74) apply to any account, new or not, and a role is
    // only ever raised. Each entry is applied on the standing of the person
    // who put it there, asked again now rather than trusted from when they
    // wrote it: they must still be an enabled account that manages the
    // project and may still invite people, and the role must still be one
    // the policy gives. Otherwise a pending invitation would keep a removed
    // or offboarded manager's access alive until it expired. A project
    // archived or gone since is skipped too; every skip is audited.
    const shared: Array<{ project: ProjectRecord; role: ProjectMemberRole; inviterId: string }> = [];
    const skippedProjects: ProjectRecord[] = [];
    if (accepted.projects?.length) {
      const grants = await store.listGrants();
      const policy = resolveInvitePolicy(config.policy.invites);
      const inviters = new Map<string, UserRecord | null>();
      const skipped: Array<{ projectId: string; reason: string }> = [];
      for (const entry of accepted.projects) {
        const by = entry.invitedBy ?? accepted.invitedBy;
        const inviterId = by.startsWith('user:') ? by.slice(5) : null;
        if (inviterId && !inviters.has(inviterId)) inviters.set(inviterId, await store.getUser(inviterId));
        const inviter = inviterId ? inviters.get(inviterId) ?? null : null;
        const project = await store.getProject(entry.projectId);
        const reason = !project || project.archivedAt ? 'project-unavailable'
          : !inviter || inviter.disabledAt ? 'inviter-unavailable'
            : !policy.projectRoles.includes(entry.role) ? 'role-not-allowed'
              : !mayInviteNewPeople(inviter, grants, policy) ? 'inviter-may-not-invite'
                : !accessAtLeast(await projectAccessOf(inviter, project, grants), 'manager') ? 'inviter-not-manager'
                  : null;
        if (reason || !project || !inviter) {
          skipped.push({ projectId: entry.projectId, reason: reason ?? 'inviter-unavailable' });
          if (project) skippedProjects.push(project);
          continue;
        }
        const actor = { principal: `user:${inviter.id}`, name: displayName(inviter), userId: inviter.id };
        // The welcome notice names the project, so the share sends no message
        // of its own (invite spec 2.9).
        await shareProjectWith(project, next, entry.role, actor, 'invitation', { message: false });
        shared.push({ project, role: entry.role, inviterId: inviter.id });
      }
      if (skipped.length) {
        await audit(`user:${user.id}`, 'invite.project.skip', `invitation:${accepted.id}`, { email: accepted.email, skipped });
      }
    }
    await tellAccepted(next, accepted, shared, skippedProjects);
    const by = `user:${user.id}`;
    await closeRequestsForEmail(accessDeps, { email: accepted.email, invitationId: accepted.id }, by);
    if (next.email.trim().toLowerCase() !== accepted.email) await closeRequestsForEmail(accessDeps, { email: next.email }, by);
    return next;
  };
  /** The notices an acceptance sends (invite spec 2.10): the welcome to the
   *  invitee, naming the first project shared; "accepted" to each distinct
   *  person who invited them (accounts only, never the invitee, at most 5),
   *  with the project they added or, for a console invitation, the console;
   *  and a notice for each project that could not be applied. */
  const ACCEPTED_NOTICES_MAX = 5;
  const tellAccepted = async (
    invitee: UserRecord, inv: InvitationRecord,
    shared: Array<{ project: ProjectRecord; role: ProjectMemberRole; inviterId: string }>, skipped: ProjectRecord[],
  ): Promise<void> => {
    const ctx = noticeContext(config, Date.now());
    const accountOf = async (principal: string): Promise<UserRecord | null> =>
      principal.startsWith('user:') ? store.getUser(principal.slice(5)) : null;
    const first = shared[0];
    const welcomer = first ? await store.getUser(first.inviterId) : await accountOf(inv.invitedBy);
    await people.tell({
      message: welcomeNotice({
        invitationId: inv.id, inviteeId: invitee.id, inviter: welcomer,
        ...(first ? { project: { id: first.project.id, name: first.project.name, role: first.role } } : {}),
      }, ctx),
      kind: 'accepted',
    });
    const principals = [inv.invitedBy, ...(inv.projects ?? []).map((e) => e.invitedBy ?? inv.invitedBy)];
    const inviterIds = [...new Set(principals.filter((p) => p.startsWith('user:')).map((p) => p.slice(5)))]
      .filter((id) => id !== invitee.id).slice(0, ACCEPTED_NOTICES_MAX);
    for (const inviterId of inviterIds) {
      const inviter = await store.getUser(inviterId);
      if (!inviter || inviter.disabledAt) continue;
      const theirs = shared.find((s) => s.inviterId === inviterId);
      await people.tell({
        message: acceptedNotice({
          invitationId: inv.id, inviterId, invitee,
          ...(theirs ? { project: { id: theirs.project.id, name: theirs.project.name } } : { console: inv.createdVia !== 'project' }),
        }, ctx),
        kind: 'accepted',
      });
    }
    for (const project of skipped) {
      await people.tell({ message: skippedNotice({ invitationId: inv.id, inviteeId: invitee.id, project }, ctx), kind: 'accepted' });
    }
  };
  /**
   * After the user row exists: a pending invitation for this verified email
   * (or another verified address of the sign-in) is accepted. This also runs
   * on an open instance (no admission block), where the invitation did not
   * decide entry but still carries its groups and projects.
   */
  const acceptInvitationAtSignIn = async (
    user: UserRecord, admitted: SignInAdmission, meta: { provider: 'oidc' | 'github' | 'password' | 'proxy'; idp?: string },
  ): Promise<UserRecord> => {
    const pending = admitted.invitation;
    if (!admitted.ok || !admitted.emailVerified || !pending || pending.acceptedAt || pending.revokedAt) return user;
    return acceptInvitationFor(user, pending, { ...meta, via: 'sign-in' });
  };
  /** How long the ask forms on a refusal page stay good (`lw/ask`). */
  const ASK_TTL_SEC = 1800;
  const mintAsk = (payload: AskTokenPayload): string => mintToken('lw/ask', payload, secrets.session, ASK_TTL_SEC);
  /** An `lw/ask` token's payload, or null for one that is forged, expired or malformed. */
  const readAsk = (token: string): AskTokenPayload | null => {
    const p = token ? verifyToken<AskTokenPayload>('lw/ask', token, sessionVerify) : null;
    return p && typeof p.e === 'string' && typeof p.idp === 'string' && typeof p.sub === 'string' ? p : null;
  };
  /** The "Ask to join" part of a refusal for someone not invited (invite
   *  spec 3.6), and the form cookie it needs. */
  const joinAskFor = async (req: IncomingMessage, identity: AskIdentity): Promise<{ join: JoinAsk; cookie?: string }> => {
    if (!config.policy.requests.join) return { join: { state: 'off' } };
    const now = Date.now();
    const state = await requestStateFor(accessDeps, { kind: 'join', email: identity.email });
    if (!state.open && state.lastDeclined) {
      const on = Date.parse(state.lastDeclined.answeredAt ?? state.lastDeclined.createdAt);
      return { join: { state: 'declined', on: utcDay(new Date(on).toISOString(), now), againAfter: utcDay(new Date(on + DECLINE_SHOWN_DAYS * 86_400_000).toISOString(), now) } };
    }
    const { nonce, cookie } = formToken(req);
    const ask = mintAsk({ e: identity.email, idp: identity.idp, sub: identity.sub, ...(identity.name ? { n: identity.name } : {}) });
    return {
      join: state.open ? { state: 'open', ask, csrf: nonce, askedAgo: relativeTime(state.open.createdAt, now) } : { state: 'form', ask, csrf: nonce },
      cookie,
    };
  };
  /** A sign-in started from an invite page, carried to the refusal: the
   *  invitation it was for and the link it came from. */
  type InviteCarried = { ref: InviteRef; invitation: InvitationRecord };
  /**
   * The phone-friendly 403 page, plus the `auth.denied` audit row. The
   * account is named on the page (the person needs to see which one they
   * used) and in the audit row (an admin needs it to send an invitation).
   * `json` answers an API caller (the password route) with the error
   * instead. A person who is simply not invited may ask to join from the
   * page; one who came from an invite link with another account gets the
   * wrong-account page instead, where they may ask to use this account.
   * Either way no user row is written.
   */
  const refuseSignIn = async (
    req: IncomingMessage, res: ServerResponse, who: AskIdentity, reason: Extract<AdmissionDecision, { ok: false }>['reason'],
    meta: { provider: 'oidc' | 'github' | 'password' | 'proxy'; idp?: string; switchHref: string; json?: boolean; invite?: InviteCarried },
  ): Promise<void> => {
    const email = who.email.trim().toLowerCase();
    await audit('anonymous', 'auth.denied', 'session', {
      provider: meta.provider, ...(meta.idp ? { idp: meta.idp } : {}), reason, email,
      ...(meta.invite ? { invitationId: meta.invite.invitation.id } : {}),
    });
    if (meta.json) return sendError(res, 403, 'NOT_ADMITTED', 'this account may not sign in here', { reason });
    const clearState = meta.provider !== 'proxy' ? [`${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Max-Age=0`] : [];
    const provider = meta.idp ? idpLabel(meta.idp) : meta.provider === 'proxy' ? idpLabel('proxy') : null;
    if (meta.invite && reason === 'not-invited') {
      await audit('anonymous', 'invite.wrong-account', `invitation:${meta.invite.invitation.id}`, {
        email, provider: meta.provider, ...(meta.idp ? { idp: meta.idp } : {}), admitted: false,
      });
      return invitePages.sendWrongAccount(req, res, {
        ref: meta.invite.ref, invitation: meta.invite.invitation, identity: { ...who, email },
        provider: provider ?? 'another sign-in', github: meta.provider === 'github', extraCookies: clearState,
      });
    }
    // Only a sign-in whose address was proven gets here as not-invited
    // (iam/admission.ts refuses an unverified one first), so the ask
    // carries an address someone controls.
    const ask = reason === 'not-invited' && config.idp.admission ? await joinAskFor(req, { ...who, email }) : null;
    res.writeHead(403, {
      ...passwordPageHeaders, 'cache-control': 'private, no-store',
      ...(clearState.length || ask?.cookie ? { 'set-cookie': [...clearState, ...(ask?.cookie ? [ask.cookie] : [])] } : {}),
    });
    res.end(admissionRefusedHtml(config.instance.name, {
      email: who.email, reason, switchHref: meta.switchHref, provider, github: meta.provider === 'github',
      ...(ask ? { join: ask.join } : {}),
    }));
  };
  /** What /api/auth/config and the manifest advertise - one entry per house.
   *  Config validation lets an additional entry stand without the primary
   *  issuer only when it is the password one. */
  const idpProviders = (): Array<{ id: string; name: string; kind: 'oidc' | 'github' | 'password'; loginPath: string }> => [
    ...(config.idp.issuer ? [{ id: 'primary', name: config.idp.displayName || 'SSO', kind: 'oidc' as const, loginPath: '/api/auth/login?idp=primary' }] : []),
    ...config.idp.additional.map((a) => ({ id: a.id, name: a.displayName, kind: a.kind ?? 'oidc', loginPath: `/api/auth/login?idp=${a.id}` })),
  ];

  // ── instance manifest (plans/34 wave 1a) ──────────────────────────────────
  // The card a fresh app-store shell reads before anyone signs in: what this
  // deployment is, how sign-in works, and what surfaces it serves. A downloaded
  // client owns nothing org-shaped until it connects, so this is deliberately
  // unauthenticated - and deliberately narrow: no secrets, no user data, no
  // policy beyond the access mode that /api/auth/config already states. Rate
  // limited with the auth bucket (see observability/rate-limit.ts).
  //
  // Readable from any origin (OSS plans/186 section 3.6): a person on the open
  // source client, on lolly.tools or in a desktop shell, adds this deployment's
  // design system by pasting its URL, and their browser reads this card first.
  // Nothing here is per-user or secret, so the wildcard states what the route
  // already is rather than opening anything new.
  router.add('GET', '/api/v1/instance', async (_req, res) => {
    allowCrossOriginRead(res);
    await ensureConnectPack();
    const packHosted = await offeredPack();
    const packUrl = packHosted ? `${config.instance.baseUrl}/connect/pack.lolly` : null;
    sendJson(res, 200, {
      name: config.instance.name,
      accessMode: config.policy.defaultAccessMode,
      ...authProvider(),
      // The vendored contract version this deploy serves tools against - what a
      // client compares its own engine to, and the fixed point fleet drift is
      // measured from.
      engineVersion: pinnedEngineVersion(),
      // Serverless deployments have no live gateway.
      capabilities: { catalog: true, collab: deps.liveCollab !== false, submit: true, scim: true },
      providers: idpProviders(),
      // Which brand this deployment hosts, and whether it has moved since a
      // client last looked (OSS plans/186 section 7). Always present, null when
      // the pack ships no tokens asset.
      brand: await brandCard(packUrl),
      branding: { revision: brand.current()!.revision, sourceId: brand.current()!.source.id },
      // Present only while a pack is hosted (plans/34 wave 2). The URL itself
      // may still ask for a session on a gated instance.
      ...(packUrl ? { connect: { packUrl } } : {}),
    });
  });

  // The preflight for the read above. A plain cross-origin GET needs none, but
  // a client that sends `If-None-Match` (the pack revalidation next door) does,
  // and one answer for both paths is simpler than two rules.
  router.add('OPTIONS', '/api/v1/instance', (_req, res) => sendReadPreflight(res));

  // ── email and password forms (plans/74) ───────────────────────────────────
  /** A label as it reads after "Sign in with": "Email and password" becomes
   *  "email and password", while a name such as "SUSE ID" is left alone. */
  const inSentence = (label: string): string => (/^[A-Z][a-z]/.test(label) ? `${label[0]!.toLowerCase()}${label.slice(1)}` : label);
  const FORM_TTL_SEC = 3600;
  /**
   * Login CSRF for the password forms, which run before anyone has a
   * session: a signed double submit. The page sets `lw_form`, a token signed
   * with the session key in its own `lw/form` domain that carries a random
   * nonce, and puts the same nonce in a hidden field. A POST must bring both
   * and they must match. A page on another site can neither read the nonce
   * nor mint a cookie this server would accept, and the cookie is
   * SameSite=Strict on top. The dispatch-wide Origin check (iam/csrf.ts) also
   * runs, because the POST carries this cookie. An open form keeps its nonce
   * when the page is loaded again, so two tabs do not invalidate each other.
   */
  const formToken = (req: IncomingMessage): { nonce: string; cookie: string } => {
    const raw = parseCookies(req.headers.cookie)[FORM_COOKIE];
    const box = raw ? verifyToken<{ n?: unknown }>('lw/form', raw, sessionVerify) : null;
    const nonce = box && typeof box.n === 'string' ? box.n : randomId(24);
    const token = mintToken('lw/form', { n: nonce }, secrets.session, FORM_TTL_SEC);
    return { nonce, cookie: `${FORM_COOKIE}=${token}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${FORM_TTL_SEC}${secure ? '; Secure' : ''}` };
  };
  const formTokenOk = (req: IncomingMessage, submitted: string | null): boolean => {
    const raw = parseCookies(req.headers.cookie)[FORM_COOKIE];
    const box = raw ? verifyToken<{ n?: unknown }>('lw/form', raw, sessionVerify) : null;
    return !!box && typeof box.n === 'string' && !!submitted && sameString(box.n, submitted);
  };
  const clearFormCookie = `${FORM_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0`;
  /**
   * Script-free like the chooser, but posts a form: form-action 'self'. The
   * set-password page carries a token in its URL, so nothing is cached.
   *
   * Referrer-Policy is `strict-origin`, not `no-referrer`: a browser sends
   * `Origin: null` on a form post from a no-referrer page (Fetch, "append a
   * request Origin header"), and the dispatch-wide CSRF check (iam/csrf.ts)
   * refuses an opaque origin on any post that carries a cookie, as these do.
   * strict-origin keeps the real Origin on the https post and still never
   * puts the page's path, and so a link's token, in a Referer. The answers
   * that carry no form (the dead-link page, the 303) keep no-referrer.
   */
  const passwordPageHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin',
    'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'",
  };
  const passwordLoginHref = (returnTo: string): string =>
    `/api/auth/login?${passwordIdp && idpProviders().length > 1 ? `idp=${encodeURIComponent(passwordIdp.id)}&` : ''}returnTo=${encodeURIComponent(returnTo)}`;
  const renderPasswordLogin = (
    req: IncomingMessage, res: ServerResponse, status: number,
    opts: { returnTo: string; email?: string; error?: string; invitedEmail?: string },
    extraHeaders: Record<string, string> = {},
  ): void => {
    const { nonce, cookie } = formToken(req);
    res.writeHead(status, { ...passwordPageHeaders, ...extraHeaders, 'set-cookie': cookie });
    res.end(passwordLoginHtml(config.instance.name, {
      returnTo: opts.returnTo, csrf: nonce,
      ...(opts.email ? { email: opts.email } : {}), ...(opts.error ? { error: opts.error } : {}),
      ...(opts.invitedEmail ? { invitedAddress: { masked: maskEmail(opts.invitedEmail), spoken: maskEmailSpoken(opts.invitedEmail) } } : {}),
      ...(idpProviders().length > 1 ? { otherHref: `/api/auth/login?returnTo=${encodeURIComponent(opts.returnTo)}` } : {}),
    }));
  };

  /** The 302 to an IdP's authorize endpoint, with PKCE and the signed state
   *  cookie. `linkTo` (a user id) marks a self-service link (GET
   *  /api/auth/link): the callback then links the identity instead of
   *  signing in. `carry.invite` is the invitation a sign-in started from an
   *  invite page is for (it rides the signed state, never the IdP), and
   *  `carry.loginHint` the invited address, which an OIDC provider uses to
   *  offer the right account first; GitHub takes no hint. */
  const redirectToIdp = async (
    res: ServerResponse, idp: ResolvedIdp, returnTo: string, askedPrompt: 'select_account' | 'login' | null, linkTo?: string,
    carry: { invite?: InviteRef; loginHint?: string } = {},
  ): Promise<void> => {
    // GitHub (iam/github.ts) has fixed endpoints and nothing to discover.
    const disco = idp.kind === 'github' ? null : await discover(idp.issuer, fetchImpl);
    const { verifier, challenge } = pkcePair();
    const nonce = randomId(12);
    const state = randomId(12);
    const stateToken = mintToken('lw/state', {
      returnTo, verifier, nonce, state, idp: idp.id, ...(linkTo ? { linkTo } : {}), ...(carry.invite ? { invite: carry.invite } : {}),
    }, secrets.session, 600);
    const authorize = !disco
      ? buildGitHubAuthorizeUrl({
        clientId: idp.clientId,
        redirectUri: `${config.instance.baseUrl}/api/auth/callback`,
        state, codeChallenge: challenge, prompt: askedPrompt,
      })
      : buildAuthorizeUrl({
        authorizationEndpoint: disco.authorization_endpoint,
        clientId: idp.clientId,
        redirectUri: `${config.instance.baseUrl}/api/auth/callback`,
        state, nonce, codeChallenge: challenge,
        scope: idp.scope,
        params: {
          ...idp.authParams, ...(askedPrompt ? { prompt: askedPrompt } : {}),
          ...(carry.loginHint && idp.kind === 'oidc' ? { login_hint: carry.loginHint } : {}),
        },
      });
    res.writeHead(302, {
      location: authorize,
      'set-cookie': `${STATE_COOKIE}=${stateToken}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
    });
    res.end();
  };
  /** The prompt values a sign-in link may ask for; anything else is ignored. */
  const loginPrompt = (raw: string | null): 'select_account' | 'login' | null =>
    raw === 'select_account' || raw === 'login' ? raw : null;
  router.add('GET', '/api/auth/login', async (req, res, ctx) => {
    const providers = idpProviders();
    if (!providers.length) return sendError(res, 404, 'NO_IDP', 'no OIDC issuer configured');
    const wanted = ctx.url.searchParams.get('idp');
    // Several houses, none named: the script-free chooser (plans/36 §3). The
    // returnTo rides each button, so the choice costs nothing downstream.
    if (!wanted && providers.length > 1) {
      const returnTo = ctx.url.searchParams.get('returnTo');
      const askedPrompt = loginPrompt(ctx.url.searchParams.get('prompt'));
      const carry = `${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ''}${askedPrompt ? `&prompt=${askedPrompt}` : ''}`;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'",
      });
      res.end(idpChooserHtml(config.instance.name,
        providers.map((p) => ({ href: `${p.loginPath}${carry}`, provider: p.name, label: `Sign in with ${p.kind === 'password' ? inSentence(p.name) : p.name}` })),
        { inviteOnly: !!config.idp.admission, pending: config.idp.pending, ...(passkeysEnabled(config.instance.baseUrl) ? { passkeyHref: `/api/auth/passkeys/login?returnTo=${encodeURIComponent(returnToSafe(returnTo))}` } : {}) }));
      return;
    }
    // One house: the primary when there is one, else the only entry (email
    // and password standing alone).
    const idp = resolveIdp(wanted ?? (config.idp.issuer ? null : providers[0]!.id));
    if (!idp) return sendError(res, 404, 'NO_IDP', `no IdP named "${wanted}" is configured`);
    if (idp.kind === 'password') {
      return renderPasswordLogin(req, res, 200, { returnTo: returnToSafe(ctx.url.searchParams.get('returnTo')) });
    }
    // A person may ask for the account picker or a fresh login (the refusal
    // page's "use a different account" link does); nothing else from the
    // query string reaches the IdP.
    await redirectToIdp(res, idp, returnToSafe(ctx.url.searchParams.get('returnTo')), loginPrompt(ctx.url.searchParams.get('prompt')));
  });

  // Self-service link (plans/74, "One person, many sign-ins"): a signed-in
  // member runs another IdP and the identity it returns joins their account,
  // whatever its email. Session cookie only: a service token has no person
  // to link to. The account picker is asked for by default, since the
  // browser is often still signed in to the account already linked.
  router.add('GET', '/api/auth/link', async (req, res, ctx) => {
    const wanted = ctx.url.searchParams.get('idp');
    // A password sign-in starts from a link an admin issues, never from here.
    // A profile that draws a "Link" button for every provider in
    // /api/auth/config (the OSS shell does) sends people here, so the answer
    // is a page a person can read, with the way back, not JSON.
    if (passwordIdp && wanted === passwordIdp.id) {
      return signInFailed(req, res, 400, 'NOT_LINKABLE',
        `${passwordIdp.displayName} is not added from here. An admin or owner of this workspace issues a one-time sign-in link that sets a password for your address. Ask one of them for a sign-in link.`,
        { retryHref: returnToSafe(ctx.url.searchParams.get('returnTo')), html: true, heading: 'Sign-in not added', retryLabel: 'Back' });
    }
    if (!config.idp.issuer) return sendError(res, 404, 'NO_IDP', 'no OIDC issuer configured');
    const me = await memberOf(req);
    if (!me) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!wanted) return sendError(res, 400, 'INVALID_INPUT', 'idp is required: name the sign-in to add', { field: 'idp' });
    const idp = resolveIdp(wanted);
    if (!idp || idp.kind === 'password') return sendError(res, 404, 'NO_IDP', `no IdP named "${wanted}" is configured`);
    await redirectToIdp(res, idp, returnToSafe(ctx.url.searchParams.get('returnTo')),
      loginPrompt(ctx.url.searchParams.get('prompt')) ?? 'select_account', me.id);
  });

  /** A callback that cannot finish. A browser (Accept: text/html) gets the
   *  phone-friendly page with a way to start again; an API caller keeps the
   *  JSON error. `html: true` forces the page (every GitHub failure). The
   *  state cookie is cleared either way, so a retry starts clean. */
  const signInFailed = (
    req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string,
    opts: { retryHref: string; html?: boolean; heading?: string; retryLabel?: string },
  ): void => {
    const clear = `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Max-Age=0`;
    if (!opts.html && !/\btext\/html\b/.test(String(req.headers.accept ?? ''))) {
      return sendError(res, status, code, message, undefined);
    }
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'",
      'set-cookie': clear,
    });
    res.end(signInErrorHtml(config.instance.name, {
      message, retryHref: opts.retryHref,
      ...(opts.heading ? { heading: opts.heading } : {}), ...(opts.retryLabel ? { retryLabel: opts.retryLabel } : {}),
    }));
  };

  // ── linked sign-ins (plans/74, "One person, many sign-ins") ───────────────
  /** An IdP's display name for a stored identity's `idp` id. */
  const idpLabel = (idp: string): string => {
    if (idp === 'primary') return config.idp.displayName || 'SSO';
    if (idp === 'proxy') return config.proxyAuth.displayName || 'Single sign-on';
    if (idp === 'dev') return 'Developer sign-in';
    return config.idp.additional.find((a) => a.id === idp)?.displayName ?? idp;
  };
  /** Whether this sign-in's email counts as verified for linking: the IdP
   *  vouches for it AND takes part in linking by email. A `trusted` IdP that
   *  has not opted in is never a link target, so an address it merely
   *  asserts can never pull someone else's sign-in into its account. */
  const linkableEmail = (identity: AdmissionIdentity, idp: ResolvedIdp): boolean =>
    idp.linkByEmail && emailIsVerified(identity, idp.constraints);
  /** The directory pin of a stored identity's IdP (iam/identities.ts
   *  `idpPin`); undefined when that IdP is no longer configured. */
  const pinOfIdp = (idpId: string): string | null | undefined => {
    const r = resolveIdp(idpId);
    return r ? idpPin(r.constraints) : undefined;
  };
  /** The audit `provider` for a sign-in through this IdP: GitHub is OAuth 2.0, not OIDC. */
  const providerOf = (idp: ResolvedIdp): 'oidc' | 'github' | 'password' => idp.kind;
  /**
   * The writes an admitted sign-in makes: the user row (iam/identities.ts
   * `signInUpsert`), its identity row, and the audit rows for a link made by
   * email or held back as ambiguous. Returns the user the session is minted
   * for, under the row's own `users.sub` whichever sign-in was used.
   */
  const recordSignIn = async (args: {
    resolution: SignInResolution; sub: string; idp: string; email: string; emailVerified: boolean;
    /** `profile.groups` is what this sign-in asserts: the IdP's groups plus
     *  any bootstrap owner group it earned. */
    profile: import('../store/types.ts').UserUpsert; provider: string;
  }): Promise<UserRecord> => {
    const { resolution, sub } = args;
    const now = Date.now();
    const at = new Date(now).toISOString();
    // Each sign-in speaks for its own groups; the account carries what its
    // sign-ins seen within the window asserted (iam/identities.ts).
    const asserted = [...new Set(args.profile.groups.filter(Boolean))];
    const prior = resolution.via === 'new' ? [] : await store.listIdentities(resolution.user.id);
    const groups = standingGroups(asserted, prior, sub, now, linkedStandingMs);
    const user = await store.upsertUserBySub(signInUpsert(resolution, sub, args.profile, groups));
    const email = args.email.trim().toLowerCase();
    const linked = await store.linkIdentity({
      identitySub: sub, userId: user.id, idp: args.idp, ...(email ? { email } : {}),
      emailVerified: args.emailVerified, groups: asserted, linkedAt: at, lastLoginAt: at,
    });
    if (resolution.via === 'email' && linked?.created) {
      await audit(`user:${user.id}`, 'identity.link', `user:${user.id}`, { via: 'email', provider: args.provider, idp: args.idp, email });
    } else if (resolution.via === 'new' && resolution.pinned) {
      // The one account holding this address was proven only through IdPs
      // pinned to a directory this sign-in's IdP does not share: it gets an
      // account of its own, and the person can link by hand from the other.
      await audit(`user:${user.id}`, 'identity.link-held', `user:${user.id}`, {
        provider: args.provider, idp: args.idp, email, reason: 'pinned',
      });
    } else if (resolution.via === 'new' && resolution.candidates > 1) {
      // Two accounts already prove this address: guessing would hand one
      // person's work to the other, so this sign-in gets its own account and
      // an owner can merge by hand.
      await audit(`user:${user.id}`, 'identity.link-ambiguous', `user:${user.id}`, {
        provider: args.provider, idp: args.idp, email, candidates: resolution.candidates,
      });
    }
    return user;
  };
  /**
   * The end of a self-service link (GET /api/auth/link): the verified identity
   * joins the CURRENT user, with no email match needed, because the person
   * proved both sides in one browser. The session that started the link must
   * still be the one finishing it. The IdP's own pins (hosted domain, tenant)
   * still apply, since a sign-in through it would be refused anyway; the
   * admission lists do not, because the member is already admitted.
   */
  const finishLink = async (
    req: IncomingMessage, res: ServerResponse, box: { returnTo: string; linkTo?: string },
    idp: ResolvedIdp, identity: MappedIdentity,
  ): Promise<void> => {
    const clearState = `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Max-Age=0`;
    const again = `/api/auth/link?idp=${encodeURIComponent(idp.id)}&returnTo=${encodeURIComponent(box.returnTo)}`;
    const me = await memberOf(req);
    if (!me || me.id !== box.linkTo) {
      return signInFailed(req, res, 401, 'LINK_SESSION', 'You were signed out while adding this sign-in. Sign in again, then add it from your profile.',
        { retryHref: `/api/auth/login?returnTo=${encodeURIComponent(box.returnTo)}`, html: true, heading: 'Sign-in not added', retryLabel: 'Sign in' });
    }
    const pins = decideAdmission({ ...identity, disabled: false }, idp.constraints, undefined, null);
    if (!pins.ok) {
      return refuseSignIn(req, res, { email: identity.email, idp: idp.id, sub: identity.sub }, pins.reason,
        { provider: providerOf(idp), idp: idp.id, switchHref: `${again}&prompt=select_account` });
    }
    const owner = (await store.getUserByIdentity(identity.sub)) ?? (await store.getUserBySub(identity.sub));
    const at = new Date().toISOString();
    const email = identity.email.trim().toLowerCase();
    // A link proves control of the account, not standing in its directory:
    // the groups its IdP asserts count from its first real sign-in, which
    // runs admission. Until then the row asserts none.
    const linked = owner && owner.id !== me.id ? null : await store.linkIdentity({
      identitySub: identity.sub, userId: me.id, idp: idp.id, ...(email ? { email } : {}),
      emailVerified: linkableEmail(identity, idp), linkedAt: at, lastLoginAt: at,
    });
    if (!linked) {
      await audit(`user:${me.id}`, 'identity.link-refused', `user:${me.id}`, { idp: idp.id, reason: 'other-user' });
      return signInFailed(req, res, 409, 'IDENTITY_IN_USE',
        `That ${idpLabel(idp.id)} account already signs in as someone else here. Sign out of it at ${idpLabel(idp.id)} and try again with another account, or ask an owner to remove it from the other person.`,
        { retryHref: box.returnTo, html: true, heading: 'This sign-in belongs to someone else', retryLabel: 'Back' });
    }
    if (linked.created) {
      await audit(`user:${me.id}`, 'identity.link', `user:${me.id}`, { via: 'self', idp: idp.id, ...(email ? { email } : {}) });
      // The sign-in just added proves its address: a pending invitation for
      // it is accepted now (plans/75 A11), unless this account wrote it.
      const inv = linkableEmail(identity, idp) && email ? await store.findActiveInvitation(email) : null;
      if (inv && !inv.acceptedAt && !(inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()) && inv.invitedBy !== `user:${me.id}`) {
        await acceptInvitationFor(me, inv, { via: 'link', provider: providerOf(idp), idp: idp.id });
      }
    }
    res.writeHead(302, { location: box.returnTo, 'set-cookie': clearState });
    res.end();
  };

  /**
   * The end of every interactive sign-in once the person is proven: the
   * OIDC and GitHub callback and the email and password routes all finish
   * here, so a check added here reaches every way in. In order: which user
   * the identity belongs to (iam/identities.ts, read before admission so a
   * sign-in linked to a disabled person is refused), admission BEFORE any
   * write (a refused person gets no user row), the bootstrap owner group,
   * the user and identity rows, the invitation, the audit rows, and a newly
   * minted session for the account. On a refusal the refusal is sent and
   * the answer is null; otherwise the caller sends `cookie` with its own
   * response (a redirect, or JSON for an API caller).
   *
   * A password sign-in may join the one account that already proves its
   * address, like any sign-in, but its own identity row is stored as
   * unverified: the address is one an admin typed, not one a mailbox
   * proved, so a later sign-in through another provider never joins an
   * account by it. `ownerAllowed: false` (a password not set from an owner's
   * link) refuses the session when the account it reaches is an owner's.
   * `invite`: the sign-in started from an invite page with an account that
   * is not the invited one, so a refusal is the wrong-account page.
   *
   * A password asserts no name, so a password sign-in keeps the name the
   * account has, unless the identity brings one: the name typed on the
   * set-password page, which then replaces the whole name. That reaches the
   * account the password belongs to; an account that signs in another way
   * keeps the name that sign-in gives it.
   */
  const completeSignIn = async (
    req: IncomingMessage, res: ServerResponse, idp: ResolvedIdp, identity: MappedIdentity,
    opts: { switchHref: string; json?: boolean; ownerAllowed?: boolean; invite?: InviteCarried },
  ): Promise<{ user: UserRecord; cookie: string } | null> => {
    const provider = providerOf(idp);
    const verifiedForLinking = linkableEmail(identity, idp);
    const resolution = await resolveSignIn(store, {
      sub: identity.sub, email: identity.email, emailVerified: verifiedForLinking, linkByEmail: idp.linkByEmail,
      pin: idpPin(idp.constraints), pinOf: pinOfIdp,
    });
    const admitted = await admitSignIn(identity, idp.constraints, resolution);
    if (!admitted.ok) {
      const name = [identity.firstname, identity.lastname].filter(Boolean).join(' ');
      await refuseSignIn(req, res, { email: identity.email, idp: idp.id, sub: identity.sub, ...(name ? { name } : {}) }, admitted.reason, {
        provider, idp: idp.id, switchHref: opts.switchHref, ...(opts.json ? { json: true } : {}), ...(opts.invite ? { invite: opts.invite } : {}),
      });
      return null;
    }
    // The other addresses matched an invitation; they are never stored.
    const { emailVerified: _verified, hd: _hd, tid: _tid, invitationEmails: _others, ...profile } = identity;
    if (idp.kind === 'password' && resolution.via !== 'new') {
      const held = resolution.user;
      if (profile.firstname) profile.lastname = undefined;
      else {
        if (held.firstname) profile.firstname = held.firstname;
        if (held.lastname) profile.lastname = held.lastname;
      }
      if (!profile.title && held.title) profile.title = held.title;
    }
    const ownerGroup = bootstrapOwnerGroup(admitted, identity.email, config.idp.bootstrapOwners, config.idp.roleGroups.owner);
    if (ownerGroup && !profile.groups.includes(ownerGroup)) profile.groups = [...profile.groups, ownerGroup];
    /** The refusal for a password that may not open an owner's account. */
    const refuseOwnerSession = async (): Promise<null> => {
      await audit('anonymous', 'auth.denied', 'session', {
        provider, idp: idp.id, reason: 'owner-link-required', email: identity.email.trim().toLowerCase(),
      });
      const message = 'This account is an owner of this workspace. An owner signs in with a password only when another owner issued the link that set it. Ask an owner for a new sign-in link.';
      if (opts.json) {
        sendError(res, 403, 'OWNER_LINK_REQUIRED', message);
      } else {
        res.writeHead(403, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'",
        });
        res.end(signInErrorHtml(config.instance.name, { message, retryHref: '', heading: 'Ask an owner for a new sign-in link' }));
      }
      return null;
    };
    // Before any write when it is already plain (an owner's account, a
    // bootstrap owner); again below on the account as it then stands.
    if (opts.ownerAllowed === false && ((resolution.via !== 'new' && resolution.user.role === 'owner') || ownerGroup)) {
      return refuseOwnerSession();
    }
    const upserted = await recordSignIn({
      resolution, sub: identity.sub, idp: idp.id, email: identity.email,
      emailVerified: idp.kind === 'password' ? false : verifiedForLinking,
      profile: { ...profile, role: roleFromGroups(profile.groups, config.idp.roleGroups) },
      provider,
    });
    // The row exists now, so an invitation's groups can be joined to it.
    const user = await acceptInvitationAtSignIn(upserted, admitted, { provider, idp: idp.id });
    // Whatever else made the account an owner meanwhile (an invitation's
    // groups) is caught here, before a session exists.
    if (opts.ownerAllowed === false && user.role === 'owner') return refuseOwnerSession();
    const sessionUser: SessionUser = {
      sub: user.sub, email: user.email, groups: user.groups, role: user.role,
      name: displayName(user), epoch: user.sessionEpoch, authenticatedAt: Date.now(),
    };
    if (ownerGroup) await audit(`user:${user.id}`, 'auth.bootstrap-owner', `user:${user.id}`, { provider, idp: idp.id, group: ownerGroup });
    await audit(`user:${user.id}`, 'auth.login', 'session', { provider, idp: idp.id, ...(admitted.via !== 'open' ? { admittedVia: admitted.via } : {}), setupFingerprint: identitySettingsHash(config) });
    return { user, cookie: mintSessionCookie(sessionUser, secrets.session, secure, sessionTtlSec) };
  };

  router.add('GET', '/api/auth/callback', async (req, res, ctx) => {
    if (!config.idp.issuer) return sendError(res, 404, 'NO_IDP', 'no OIDC issuer configured');
    const cookies = req.headers.cookie ?? '';
    const stateCookie = /(?:^|;\s*)lw_state=([^;]+)/.exec(cookies)?.[1];
    const box = stateCookie
      ? verifyToken<{ returnTo: string; verifier: string; nonce: string; state: string; idp?: string; linkTo?: string; invite?: InviteRef }>('lw/state', stateCookie, sessionVerify)
      : null;
    if (!box || box.state !== ctx.url.searchParams.get('state')) {
      return signInFailed(req, res, 400, 'BAD_STATE', 'This sign-in expired or was started in another browser. Start again from here.', { retryHref: '/api/auth/login' });
    }
    // The SAME house that started the flow finishes it - the id rides the
    // signed state token, so a crafted callback cannot cross issuers. A token
    // from before multi-IdP carries no id and reads as primary.
    const idp = resolveIdp(box.idp ?? 'primary');
    if (!idp || idp.kind === 'password') return sendError(res, 400, 'BAD_STATE', 'the IdP that started this sign-in is no longer configured');
    const code = ctx.url.searchParams.get('code');
    // "Try again" restarts what was started: during a link, the link. A
    // fresh sign-in there would replace the person's session, and could
    // create a second, empty account for the identity they meant to add.
    const retryHref = box.linkTo
      ? `/api/auth/link?idp=${encodeURIComponent(idp.id)}&returnTo=${encodeURIComponent(box.returnTo)}`
      : `/api/auth/login?idp=${encodeURIComponent(idp.id)}&returnTo=${encodeURIComponent(box.returnTo)}`;
    const failHeading = box.linkTo ? { heading: 'Sign-in not added' } : {};
    if (!code) {
      return signInFailed(req, res, 400, 'NO_CODE', `${idp.displayName || 'The identity provider'} did not complete the sign-in. If you cancelled, you can start again.`,
        { retryHref, html: idp.kind === 'github', ...failHeading });
    }
    let identity: MappedIdentity;
    if (idp.kind === 'github') {
      // GitHub is OAuth 2.0 (iam/github.ts): the access token is used for two
      // API reads and then dropped; it is never stored or logged. Every
      // failure becomes the HTML page plus an `auth.failed` audit row.
      try {
        if (!idp.clientSecret) throw new GitHubSignInError('token', 'the GitHub client secret is not set on this instance');
        const accessToken = await exchangeGitHubCode({
          code, verifier: box.verifier, clientId: idp.clientId, clientSecret: idp.clientSecret,
          redirectUri: `${config.instance.baseUrl}/api/auth/callback`, fetchImpl,
        });
        identity = await fetchGitHubIdentity(accessToken, fetchImpl);
      } catch (err) {
        const reason = err instanceof GitHubSignInError ? err.reason : 'profile';
        await audit('anonymous', 'auth.failed', 'session', { provider: 'github', idp: idp.id, reason });
        const message = reason === 'no-email'
          ? 'GitHub did not share a verified email address for this account. Add an email address in your GitHub settings, confirm it from the message GitHub sends, then try again.'
          : 'GitHub did not finish the sign-in. Wait a moment and try again; if it keeps happening, tell an owner of this workspace.';
        return signInFailed(req, res, reason === 'no-email' ? 403 : 502, reason === 'no-email' ? 'NO_EMAIL' : 'IDP_FAILED', message, { retryHref, html: true, ...failHeading });
      }
    } else {
      // Every step below talks to the IdP or judges what it sent. A failure in
      // any of them is the HTML page plus an `auth.failed` row naming the step
      // (a fixed word, never the IdP's own error text), as for GitHub above,
      // instead of an unhandled 500 carrying raw JSON.
      let step: 'discovery' | 'issuer-mismatch' | 'token' | 'no-id-token' | 'jwks' | 'id-token' | 'claims' = 'discovery';
      try {
        const disco = await discover(idp.issuer, fetchImpl);
        // OIDC Discovery 4.3: the document's issuer must be the one it was fetched
        // for. Checking it against the CONFIGURED issuer, not against itself, is
        // what stops a discovery answer from naming a different authority.
        if (disco.issuer.replace(/\/+$/, '') !== idp.issuer.replace(/\/+$/, '')) {
          step = 'issuer-mismatch';
          throw new Error('IdP discovery names a different issuer than configured');
        }
        step = 'token';
        const tokens = await exchangeCode({
          tokenEndpoint: disco.token_endpoint,
          code, verifier: box.verifier,
          clientId: idp.clientId,
          ...(idp.clientSecret ? { clientSecret: idp.clientSecret } : {}),
          redirectUri: `${config.instance.baseUrl}/api/auth/callback`,
          fetchImpl,
        });
        if (!tokens.id_token) {
          step = 'no-id-token';
          throw new Error('IdP returned no id_token');
        }
        step = 'jwks';
        const jwks = await fetchJwks(disco.jwks_uri, fetchImpl, kidOf(tokens.id_token));
        step = 'id-token';
        const claims = await verifyIdToken(tokens.id_token, jwks, {
          issuer: disco.issuer, clientId: idp.clientId, nonce: box.nonce,
        });
        step = 'claims';
        identity = mapClaims(claims, idp.claimMap, idp.groupsClaim);
      } catch (err) {
        // The library messages name a step and an HTTP status, never a token or secret.
        console.warn(`[lolly-work] sign-in through ${idp.id} failed at ${step}: ${(err as Error)?.message ?? err}`);
        await audit('anonymous', 'auth.failed', 'session', { provider: providerOf(idp), idp: idp.id, reason: step });
        const name = idp.displayName || 'The identity provider';
        const message = step === 'claims'
          ? `${name} did not share an email address for this account. This workspace needs one to know who you are. Try again with another account, or tell an owner of this workspace.`
          : `${name} did not finish the sign-in. Wait a moment and try again; if it keeps happening, tell an owner of this workspace.`;
        return signInFailed(req, res, step === 'claims' ? 403 : 502, step === 'claims' ? 'NO_EMAIL' : 'IDP_FAILED', message, { retryHref, html: true, ...failHeading });
      }
    }
    // The namespace prefix (empty for primary) keeps two issuers' subs apart.
    identity.sub = `${idp.subPrefix}${identity.sub}`;
    // A self-service link (GET /api/auth/link) ends here: no new session.
    if (box.linkTo) return finishLink(req, res, box, idp, identity);
    // Started from an invite page (invite spec 2.9): the invitation as it
    // stands now. One withdrawn, accepted, ended or replaced meanwhile makes
    // this a plain sign-in that goes to the app, not to its project.
    const invitation = box.invite ? await invitePages.liveInvitation(box.invite) : null;
    const returnTo = box.invite && !invitation ? '/' : box.returnTo;
    // The invited account proves the invited address: its own, when the IdP
    // vouches for it, or another verified address of a GitHub account.
    let carried: InviteCarried | undefined;
    if (box.invite && invitation) {
      const proven = [
        ...(emailIsVerified(identity, idp.constraints) ? [identity.email.trim().toLowerCase()] : []),
        ...(idp.kind === 'github' ? identity.invitationEmails ?? [] : []),
      ];
      if (!proven.includes(invitation.email)) carried = { ref: box.invite, invitation };
    }
    const again = `/api/auth/login?${config.idp.additional.length ? '' : `idp=${encodeURIComponent(idp.id)}&`}prompt=select_account&returnTo=${encodeURIComponent(returnTo)}`;
    const done = await completeSignIn(req, res, idp, identity, { switchHref: again, ...(carried ? { invite: carried } : {}) });
    if (!done) return;
    const clearState = `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Max-Age=0`;
    if (carried) {
      // Not the invited account, but one this workspace admits anyway: the
      // person is signed in, and the page says whose invitation it was.
      await audit(`user:${done.user.id}`, 'invite.wrong-account', `invitation:${carried.invitation.id}`, {
        email: identity.email.trim().toLowerCase(), provider: providerOf(idp), idp: idp.id, admitted: true,
      });
      return invitePages.sendOtherAccount(req, res, { ref: carried.ref, invitation: carried.invitation, user: done.user, extraCookies: [done.cookie, clearState] });
    }
    res.writeHead(302, { location: returnTo, 'set-cookie': [done.cookie, clearState] });
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
      role: roleFromGroups(groups, config.idp.roleGroups),
      ...(devUser.name ? { firstname: devUser.name } : {}),
    });
    // Recorded so the profile lists it; a dev address is never verified, so
    // it never links anything by email.
    const devAt = new Date().toISOString();
    await store.linkIdentity({ identitySub: user.sub, userId: user.id, idp: 'dev', email: user.email, emailVerified: false, linkedAt: devAt, lastLoginAt: devAt });
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

  // Reverse-proxy provider (iam/proxy-auth.ts): the authenticating proxy in
  // front of this instance already knows who the person is and says so in
  // request headers; this route turns that into an ordinary member session.
  // The proxy's shared secret gates it, so a request that reached the port
  // without passing the proxy gets a 403 and an audit row, never a session.
  router.add('GET', '/api/auth/proxy', async (req, res, ctx) => {
    if (!config.proxyAuth.enabled) return sendError(res, 404, 'NOT_FOUND', 'proxy sign-in disabled');
    const resolved = await resolveProxyIdentity(req.headers, config.proxyAuth, secrets);
    if (!resolved.ok) {
      // The presented secret is never written anywhere; only that one was wrong.
      await audit('anonymous', 'auth.proxy.rejected', 'session', { code: resolved.code, ...(resolved.cause ? { cause: resolved.cause } : {}) });
      return sendError(res, resolved.status, resolved.code, resolved.message);
    }
    const id = resolved.identity;
    // The same admission rule as OIDC. The proxy is the authority for the
    // address it sends, so its email counts as verified; only the proxy can
    // switch accounts, so the refusal page offers no link.
    // The proxy never links by email (it is `trusted`, and linkByEmail is off
    // for trusted IdPs), so its sign-ins resolve by identity row, by the
    // legacy users.sub, or as a new user.
    const proxySub = `proxy:${id.user}`;
    const resolution = await resolveSignIn(store, { sub: proxySub, email: id.email, emailVerified: false, linkByEmail: false });
    const admitted = await admitSignIn({ sub: proxySub, email: id.email }, { emailVerification: 'trusted' }, resolution);
    if (!admitted.ok) {
      const name = [id.firstname, id.lastname].filter(Boolean).join(' ');
      return refuseSignIn(req, res, { email: id.email, idp: 'proxy', sub: proxySub, ...(name ? { name } : {}) }, admitted.reason, { provider: 'proxy', switchHref: '' });
    }
    const ownerGroup = bootstrapOwnerGroup(admitted, id.email, config.idp.bootstrapOwners, config.idp.roleGroups.owner);
    const proxyGroups = ownerGroup && !id.groups.includes(ownerGroup) ? [...id.groups, ownerGroup] : id.groups;
    const upserted = await recordSignIn({
      resolution, sub: proxySub, idp: 'proxy', email: id.email, emailVerified: false, provider: 'proxy',
      profile: {
        sub: proxySub, email: id.email, groups: proxyGroups,
        role: roleFromGroups(proxyGroups, config.idp.roleGroups),
        ...(id.firstname ? { firstname: id.firstname } : {}),
        ...(id.lastname ? { lastname: id.lastname } : {}),
      },
    });
    const user = await acceptInvitationAtSignIn(upserted, admitted, { provider: 'proxy' });
    const sessionUser: SessionUser = {
      sub: user.sub, email: user.email, groups: user.groups, role: user.role,
      name: displayName(user), epoch: user.sessionEpoch, authenticatedAt: Date.now(),
    };
    if (ownerGroup) await audit(`user:${user.id}`, 'auth.bootstrap-owner', `user:${user.id}`, { provider: 'proxy', group: ownerGroup });
    await audit(`user:${user.id}`, 'auth.login', 'session', { provider: 'proxy', directory: id.sources.directory, ...(admitted.via !== 'open' ? { admittedVia: admitted.via } : {}), setupFingerprint: identitySettingsHash(config) });
    res.writeHead(302, {
      location: returnToSafe(ctx.url.searchParams.get('returnTo')),
      'set-cookie': mintSessionCookie(sessionUser, secrets.session, secure, sessionTtlSec),
    });
    res.end();
  });

  // ── email and password sign-in (plans/74) ─────────────────────────────────
  // For people whose organisation blocks the instance's other sign-ins. There
  // is no sign-up: a password is set only from a one-time link an admin issues
  // (POST /api/v1/admin/password-links) and passes on by hand, since nothing
  // is emailed from here. A sign-in then finishes through `completeSignIn`
  // like every other, so admission, linking by email, invitations and
  // "Disable access" apply unchanged. Every route rides the auth rate-limit
  // bucket; on top of it a credential locks for PASSWORD_LOCK_MS after
  // PASSWORD_MAX_FAILURES attempts in a row without a success, each counted
  // before its password is checked. A password, its hash and a link token
  // are never logged or audited.
  const PASSWORD_MAX_FAILURES = 10;
  const PASSWORD_LOCK_MS = 15 * 60 * 1000;
  const PASSWORD_BODY_MAX = 8 * 1024;
  /** The one answer for an unknown email, a wrong password and a locked
   *  credential, so the form says nothing about which accounts exist. */
  const PASSWORD_MISMATCH = 'That email and password do not match.';
  const passwordSignIn = (): ResolvedIdp | null => (passwordIdp ? resolveIdp(passwordIdp.id) : null);
  /** A form post or, for an API caller, a JSON body; null for anything else. */
  const readSignInBody = async (req: IncomingMessage): Promise<{ json: boolean; get: (k: string) => string } | null> => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams((await readRaw(req, PASSWORD_BODY_MAX)).toString('utf8'));
      return { json: false, get: (k) => form.get(k) ?? '' };
    }
    if (type === 'application/json') {
      const body = (await readJson(req, PASSWORD_BODY_MAX)) as Record<string, unknown> | null;
      return { json: true, get: (k) => (body && typeof body === 'object' && typeof body[k] === 'string' ? body[k] as string : '') };
    }
    return null;
  };
  /** The signed-in answer: a 303 for the form, JSON for an API caller. */
  const sendSignedIn = (res: ServerResponse, json: boolean, cookie: string, returnTo: string): void => {
    if (json) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookie });
      res.end(JSON.stringify({ ok: true, returnTo }));
      return;
    }
    res.writeHead(303, { location: returnTo, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [cookie, clearFormCookie] });
    res.end();
  };

  /** The busy answer while too many password checks are waiting (lib/crypto.ts). */
  const BUSY_MESSAGE = 'Too many people are signing in right now. Wait a moment, then try again.';

  router.add('POST', '/api/auth/password/login', async (req, res) => {
    const idp = passwordSignIn();
    if (!idp) return sendError(res, 404, 'NO_IDP', 'email and password sign-in is not configured');
    const body = await readSignInBody(req);
    if (!body) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the form, or application/json for an API call');
    const { json } = body;
    const email = normaliseEmail(body.get('email'));
    const password = body.get('password');
    const returnTo = returnToSafe(body.get('returnTo') || null);
    const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): void => {
      if (!json) return renderPasswordLogin(req, res, status, { returnTo, ...(email ? { email } : {}), error: message }, headers);
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      sendError(res, status, code, message);
    };
    // A JSON body needs a preflight from another origin, which this server
    // never grants, so only the form needs the double-submit token.
    if (!json && !formTokenOk(req, body.get('csrf'))) {
      return fail(403, 'FORM_EXPIRED', 'This form expired. Enter your email and password again.');
    }
    if (!email || !password) return fail(400, 'INVALID_INPUT', 'Enter your email and password.');
    // Turned away before anything is counted, so a flood of guesses cannot
    // spend a real person's attempts while they wait.
    if (scryptQueueFull()) return fail(503, 'BUSY', BUSY_MESSAGE, { 'retry-after': '2' });
    // The attempt is counted BEFORE the password is checked, in one atomic
    // step: a burst of parallel guesses then gets at most PASSWORD_MAX_FAILURES
    // real checks before the lock, however many arrive at once.
    const attempt = await store.reservePasswordAttempt(email, new Date().toISOString(), { maxFailures: PASSWORD_MAX_FAILURES, lockMs: PASSWORD_LOCK_MS });
    const cred = attempt.status === 'reserved' ? attempt.credential : null;
    // Always one derivation, against a stand-in when there is no credential
    // or it is locked, so the time taken says neither.
    let check: { ok: boolean; needsRehash: boolean };
    try {
      check = await verifySignInPassword(password, cred?.hash ?? null);
    } catch (err) {
      if (err instanceof ScryptBusyError) return fail(503, 'BUSY', BUSY_MESSAGE, { 'retry-after': '2' });
      throw err;
    }
    if (!cred || !check.ok) {
      if (attempt.status === 'reserved' && attempt.locks) {
        await audit('anonymous', 'auth.password.locked', 'session', {
          provider: 'password', idp: idp.id, email: attempt.credential.email, until: attempt.credential.lockedUntil,
        });
      }
      // An address with no credential is recorded by hash only: anyone can
      // type anything here, and the audit chain is no place for it.
      await audit('anonymous', 'auth.password.fail', 'session', {
        provider: 'password', idp: idp.id,
        reason: attempt.status === 'none' ? 'unknown-email' : attempt.status === 'locked' ? 'locked' : 'wrong-password',
        ...(attempt.status !== 'none' ? { email: attempt.credential.email } : { emailHash: sha256Hex(email).slice(0, 16) }),
      });
      return fail(400, 'INVALID_CREDENTIALS', PASSWORD_MISMATCH);
    }
    // Cleared as it stands now, not from the row read above: a lock another
    // attempt set meanwhile goes too, since this one had the password.
    await store.clearPasswordFailures(cred.email);
    if (check.needsRehash) {
      try {
        await store.rehashPasswordCredential(cred.email, cred.hash, await hashSignInPassword(password), new Date().toISOString());
      } catch (err) {
        if (!(err instanceof ScryptBusyError)) throw err; // the next sign-in rehashes instead
      }
    }
    const identity: MappedIdentity = { sub: `${idp.subPrefix}${cred.id}`, email: cred.email, emailVerified: true, groups: [] };
    const done = await completeSignIn(req, res, idp, identity, { switchHref: passwordLoginHref(returnTo), json, ownerAllowed: cred.ownerIssued });
    if (done) sendSignedIn(res, json, done.cookie, returnTo);
  });

  /**
   * Who stands behind a password link: the operator (scripts/password-link.ts,
   * owner-level), or the person who issued it, asked again now rather than
   * trusted from when they issued it. They must still be an enabled admin or
   * owner who may invite people; otherwise null, and their links stop
   * working, as an invitation's projects stop applying for an inviter who
   * may no longer give them.
   */
  const passwordLinkIssuer = async (createdBy: string | undefined): Promise<'operator' | UserRecord | null> => {
    if (createdBy === OPERATOR_LINK_ISSUER) return 'operator';
    const id = createdBy?.startsWith('user:') ? createdBy.slice(5) : null;
    const user = id ? await store.getUser(id) : null;
    if (!user || user.disabledAt || !['admin', 'owner'].includes(user.role)) return null;
    const ctx = { userId: user.id, groups: user.groups, role: user.role as Role };
    return evaluate(ctx, 'user.invite', ['*'], await store.listGrants()) ? user : null;
  };
  /**
   * Why a password link for `email` may not be issued, or used, on
   * `issuer`'s authority; null when it may. Asked when the link is issued
   * and again when it is opened and used, so what changed in the seven days
   * between (a promotion, a disabled account, a sign-in made meanwhile)
   * counts. Whoever holds the link can sign in as the address, so:
   *  - never for a disabled account;
   *  - an address that leads to an owner (an owner's account, a bootstrap
   *    owner, a pending invitation into an owner group) is owner-only;
   *  - adding a password to an account that signs in some other way hands
   *    the link holder that account, so it is owner-only too, unless the
   *    account is the issuer's own;
   *  - the sign-in must be one admission lets in now.
   */
  const passwordLinkRefusal = async (
    email: string, issuer: 'operator' | UserRecord,
  ): Promise<{ status: number; code: string; message: string } | null> => {
    const asOwner = issuer === 'operator' || issuer.role === 'owner';
    const [claimed, verified, invitation, cred] = await Promise.all([
      store.findUsersByEmail(email), store.findUsersByVerifiedEmail(email), store.findActiveInvitation(email), store.getPasswordCredential(email),
    ]);
    // The account the address's password already reaches, whatever its own email.
    const reached = cred ? await store.getUserByIdentity(`password:${cred.id}`) : null;
    const accounts = [...new Map([...claimed, ...verified, ...(reached ? [reached] : [])].map((u) => [u.id, u])).values()];
    if (accounts.some((u) => u.disabledAt)) {
      return { status: 409, code: 'ACCOUNT_DISABLED', message: 'this address belongs to a disabled account; re-enable it first' };
    }
    const pendingInvitation = invitation && !invitation.acceptedAt && !invitation.revokedAt ? invitation : null;
    const leadsToOwner = accounts.some((u) => u.role === 'owner')
      || config.idp.bootstrapOwners.some((o) => o.trim().toLowerCase() === email)
      || (!!pendingInvitation && roleFromGroups(pendingInvitation.groups, config.idp.roleGroups) === 'owner');
    if (leadsToOwner && !asOwner) {
      return { status: 403, code: 'OWNER_ONLY', message: 'only an owner can issue a sign-in link for an owner' };
    }
    if (!asOwner) {
      for (const u of accounts) {
        if (u.id === issuer.id) continue; // a password for the issuer's own account
        const rows = await store.listIdentities(u.id);
        if (!rows.some((r) => r.identitySub.startsWith('password:') && r.email === email)) {
          return { status: 403, code: 'OWNER_ONLY', message: 'this address belongs to someone who already signs in another way; only an owner can add a password to their account' };
        }
      }
    }
    const { disabled, invitationView } = await admissionInputs('', email);
    const decision = decideAdmission({ email, emailVerified: true, disabled }, { emailVerification: 'claim' }, config.idp.admission, invitationView);
    if (!decision.ok) {
      return { status: 409, code: 'NOT_ADMITTED', message: 'this address may not sign in here: invite it first, or add it or its domain to the sign-in rule' };
    }
    return null;
  };

  /** A link token as the URL carries it: 32 random bytes, base64url. */
  const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
  const sendLinkDead = (res: ServerResponse): void => {
    res.writeHead(410, { ...passwordPageHeaders, 'referrer-policy': 'no-referrer' });
    res.end(passwordLinkDeadHtml(config.instance.name, passwordLoginHref('/')));
  };
  const renderPasswordSet = (
    req: IncomingMessage, res: ServerResponse, status: number,
    opts: { token: string; email: string; purpose: 'setup' | 'reset'; error?: string; returnTo?: string; name?: string; nameError?: boolean },
    extraHeaders: Record<string, string> = {},
  ): void => {
    const { nonce, cookie } = formToken(req);
    res.writeHead(status, { ...passwordPageHeaders, ...extraHeaders, 'set-cookie': cookie });
    res.end(passwordSetHtml(config.instance.name, { ...opts, csrf: nonce, minLength: PASSWORD_MIN_LENGTH }));
  };
  /** The live link a token names (null when there is none) and whether it
   *  still stands on its issuer's authority (`refusal` says why not). */
  const usablePasswordLink = async (tokenHash: string): Promise<
    | { link: PasswordLinkRecord; refusal: string }
    | { link: PasswordLinkRecord; refusal: null; issuer: 'operator' | UserRecord }
    | null
  > => {
    const link = tokenHash ? await store.findLivePasswordLink(tokenHash, new Date().toISOString()) : null;
    if (!link) return null;
    const issuer = await passwordLinkIssuer(link.createdBy);
    if (!issuer) return { link, refusal: 'issuer-unavailable' };
    const refused = await passwordLinkRefusal(link.email, issuer);
    return refused ? { link, refusal: refused.code } : { link, refusal: null, issuer };
  };

  // Opening a link only reads it; the POST below spends it.
  router.add('GET', '/api/auth/password/set', async (req, res, ctx) => {
    if (!passwordSignIn()) return sendError(res, 404, 'NO_IDP', 'email and password sign-in is not configured');
    const token = ctx.url.searchParams.get('token') ?? '';
    const usable = await usablePasswordLink(LINK_TOKEN.test(token) ? sha256Hex(token) : '');
    if (!usable || usable.refusal) return sendLinkDead(res);
    renderPasswordSet(req, res, 200, { token, email: usable.link.email, purpose: usable.link.purpose });
  });

  router.add('POST', '/api/auth/password/set', async (req, res) => {
    const idp = passwordSignIn();
    if (!idp) return sendError(res, 404, 'NO_IDP', 'email and password sign-in is not configured');
    const body = await readSignInBody(req);
    if (!body || body.json) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the form');
    const token = body.get('token');
    const tokenHash = LINK_TOKEN.test(token) ? sha256Hex(token) : '';
    const usable = await usablePasswordLink(tokenHash);
    if (!usable) return sendLinkDead(res);
    if (usable.refusal !== null) {
      // Recorded so an owner can see why a link they expected to work did not.
      await audit('anonymous', 'auth.password.link.refused', 'session', { provider: 'password', idp: idp.id, email: usable.link.email, reason: usable.refusal });
      return sendLinkDead(res);
    }
    const { link, issuer } = usable;
    // Where the person goes once signed in: the project an invite link was
    // for (invite spec 2.9), held to this instance; a link an admin issued
    // from the console carries none and goes to the app.
    const returnTo = returnToSafe(body.get('returnTo') || null);
    const typedName = body.get('name').replace(/\s+/g, ' ').trim();
    const again = (status: number, error: string, headers: Record<string, string> = {}, nameError = false): void =>
      renderPasswordSet(req, res, status, {
        token, email: link.email, purpose: link.purpose, error, returnTo, ...(typedName ? { name: typedName } : {}), ...(nameError ? { nameError } : {}),
      }, headers);
    if (!formTokenOk(req, body.get('csrf'))) return again(403, 'This form expired. Enter your new password again.');
    // The rules are checked before the link is spent, so a typo does not cost
    // the person their link. The name is optional and plain text, one line.
    if (Array.from(typedName).length > ACCOUNT_NAME_MAX) return again(400, `Your name can be at most ${ACCOUNT_NAME_MAX} characters.`, {}, true);
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(typedName)) return again(400, 'Use only ordinary characters in your name.', {}, true);
    const password = body.get('password');
    if (password !== body.get('confirm')) return again(400, 'The two passwords do not match.');
    const rule = checkPasswordRules(password, link.email);
    if (rule) return again(400, passwordRuleMessage(rule));
    let hash: string;
    try {
      hash = await hashSignInPassword(password);
    } catch (err) {
      if (err instanceof ScryptBusyError) return again(503, BUSY_MESSAGE, { 'retry-after': '2' });
      throw err;
    }
    const at = new Date().toISOString();
    // Spent exactly once: of two racing posts, one gets the row back.
    const spent = await store.consumePasswordLink(tokenHash, at);
    if (!spent) return sendLinkDead(res);
    const existing = await store.getPasswordCredential(spent.email);
    // A new password ends what the old one opened: a reset usually means the
    // old one got out. The account's sessions end before the new one is
    // minted, so only this browser stays signed in.
    const holder = existing ? await store.getUserByIdentity(`password:${existing.id}`) : null;
    if (holder) await store.bumpSessionEpoch(holder.id);
    const ownerIssued = issuer === 'operator' || issuer.role === 'owner';
    const cred = await store.putPasswordCredential({ id: existing?.id ?? `pwc_${randomId(12)}`, email: spent.email, hash, at, ownerIssued });
    await audit('anonymous', 'auth.password.set', 'session', {
      provider: 'password', idp: idp.id, email: cred.email, purpose: spent.purpose, ...(spent.createdBy ? { issuedBy: spent.createdBy } : {}),
      ...(holder ? { sessionsRevoked: true } : {}),
    });
    const identity: MappedIdentity = {
      sub: `${idp.subPrefix}${cred.id}`, email: cred.email, emailVerified: true, groups: [], ...(typedName ? { firstname: typedName } : {}),
    };
    const done = await completeSignIn(req, res, idp, identity, { switchHref: passwordLoginHref(returnTo), ownerAllowed: cred.ownerIssued });
    if (done) sendSignedIn(res, false, done.cookie, returnTo);
  });

  // ── invite links and sign-in requests (plans/74 invite spec R1 to R3) ──
  // The routes live in access/invite-routes.ts; what they need from the
  // sign-in code above is handed over here.
  /**
   * Who stands behind the invite page's one-link password now (invite spec
   * 2.9), or null when it may not set one: password sign-in on, the
   * invitation pending and live with the flag set, no password for the
   * address yet, and the person who invited (for this project, else the
   * invitation) still an admin or owner who may issue sign-in links for it.
   */
  const passwordSetupIssuer = async (inv: InvitationRecord, projectId: string | null): Promise<'operator' | UserRecord | null> => {
    if (!passwordIdp || !inv.passwordSetup || inv.acceptedAt || inv.revokedAt) return null;
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()) return null;
    if (await store.getPasswordCredential(inv.email)) return null;
    const entry = projectId ? (inv.projects ?? []).find((p) => p.projectId === projectId) : undefined;
    const issuer = await passwordLinkIssuer(entry?.invitedBy ?? inv.invitedBy);
    if (!issuer) return null;
    return (await passwordLinkRefusal(inv.email, issuer)) ? null : issuer;
  };
  /** How long the one-time link the invite page makes lasts: only as long
   *  as the person needs to fill in the form it opens. */
  const INVITE_PASSWORD_LINK_TTL_MS = 3_600_000;
  const invitePages = registerInviteRoutes(router, {
    store, config, accessDeps, audit, linkVerify, linkSecret: secrets.link, mintAsk, readAsk, memberOf, formToken, formTokenOk,
    readForm: async (req) => {
      const body = await readSignInBody(req);
      return body && !body.json ? body : null;
    },
    returnToSafe, providers: idpProviders, idpLabel,
    startSignIn: async (req, res, o) => {
      const idp = resolveIdp(o.idpId);
      if (!idp) return sendError(res, 404, 'NO_IDP', `no IdP named "${o.idpId}" is configured`);
      if (idp.kind === 'password') return renderPasswordLogin(req, res, 200, { returnTo: o.returnTo, invitedEmail: o.email });
      await redirectToIdp(res, idp, o.returnTo, o.prompt, undefined, { invite: o.invite, loginHint: o.email });
    },
    passwordSetupIssuer,
    renderInvitePasswordSet: async (req, res, o) => {
      const token = randomId(32);
      const now = Date.now();
      const issuedBy = o.issuer === 'operator' ? OPERATOR_LINK_ISSUER : `user:${o.issuer.id}`;
      await store.createPasswordLink({
        tokenHash: sha256Hex(token), email: o.invitation.email, purpose: 'setup', createdBy: issuedBy,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_PASSWORD_LINK_TTL_MS).toISOString(),
      });
      await audit(issuedBy, 'auth.password.link.issue', 'session', {
        idp: passwordIdp?.id, email: o.invitation.email, purpose: 'setup', via: 'invitation', invitationId: o.invitation.id,
      });
      renderPasswordSet(req, res, 200, { token, email: o.invitation.email, purpose: 'setup', returnTo: o.returnTo });
    },
    hasPassword: async (email) => !!(await store.getPasswordCredential(email)),
    acceptInvitationFor: (user, inv, meta) => acceptInvitationFor(user, inv, meta),
    accountsHoldingEmail: (email) => accountsHoldingEmail(email),
    projectAccessOf: (user, project) => projectAccessOf(user, project),
    now: Date.now,
  });

  router.add('GET', '/api/auth/session', async (req, res) => {
    const p = principalOf(req);
    if (!p) return sendError(res, 401, 'UNAUTHORIZED', 'no session');
    if (p.kind === 'guest') {
      return sendJson(res, 200, { kind: 'guest', guest: { name: p.guest.name, inviter: p.guest.inviter, toolId: p.guest.toolId } });
    }
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'session user unknown or disabled');
    const access = consoleAccess({ userId: user.id, groups: user.groups, role: user.role as Role }, await store.listGrants());
    return sendJson(res, 200, { kind: 'member', user: { sub: user.sub, email: user.email, groups: user.groups, role: user.role }, console: access }, { 'cache-control': 'no-store' });
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
    // strict-origin, not no-referrer: the confirm form posts with the session
    // cookie, and a form post from a no-referrer page carries `Origin: null`,
    // which the dispatch-wide CSRF check refuses (see passwordPageHeaders).
    'referrer-policy': 'strict-origin',
    // Script-free page, same posture as the bearer collection page - except
    // form-action 'self', so the confirm form can submit.
    'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'",
  };
  const loginPathFor = (returnTo: string): string | null => {
    const { loginPath } = authProvider();
    return loginPath ? `${loginPath}?returnTo=${encodeURIComponent(returnTo)}` : null;
  };

  router.add('POST', '/api/v1/auth/device', async (req, res) => {
    const started = await deviceAuth.request(req.headers['x-lolly-client'] as string | undefined, clientIp(req, config.rateLimit.trustedProxyHops));
    if (!started) return sendError(res, 429, 'TOO_MANY_REQUESTS', 'too many pending device codes - try again shortly');
    // No audit row here: an unauthenticated request must not be able to grow
    // the audit log; the approval and denial are the recorded events.
    sendJson(res, 200, {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: `${config.instance.baseUrl}/activate`,
      interval: started.interval,
      expiresIn: started.expiresIn,
    });
  });

  router.add('POST', '/api/v1/auth/device/token', async (req, res) => {
    const body = (await readJson(req)) as { deviceCode?: unknown } | null;
    if (typeof body?.deviceCode !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'deviceCode required');
    const claim = await deviceAuth.claim(body.deviceCode);
    if (claim.status !== 'approved') return sendJson(res, 200, { status: claim.status });
    // The approval is minutes old at most, but a disable or session-revoke in
    // between must still win - re-read the person before minting anything.
    const user = await store.getUserBySub(claim.user.sub);
    if (!user || user.disabledAt || user.sessionEpoch > (claim.user.epoch ?? 0)) {
      return sendJson(res, 200, { status: 'denied' });
    }
    // A device session is a sign-in that skips the IdP, so it asks admission
    // again: someone taken off the lists, or whose invitation was revoked,
    // must not renew access by approving codes from a still-live session.
    if (!(await stillAdmitted(user))) {
      await audit('anonymous', 'auth.denied', 'session', { provider: 'device', reason: 'not-admitted', email: user.email.trim().toLowerCase() });
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
    sendJson(res, 200, { pending: await deviceAuth.pending() });
  });

  router.add('POST', '/api/v1/auth/device/deny', async (req, res) => {
    const actor = await requireAction(req, res, 'fleet.manage');
    if (!actor) return;
    const body = (await readJson(req)) as { userCode?: unknown } | null;
    if (typeof body?.userCode !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'userCode required');
    if (!(await deviceAuth.deny(body.userCode))) return sendError(res, 404, 'NOT_FOUND', 'no such pending code');
    await audit(`user:${actor.id}`, 'auth.device.deny', 'session', { code: normalizeUserCode(body.userCode) });
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/activate', async (req, res, ctx) => {
    const html = await (async () => {
      const me = await resolveMember(store, req.headers.cookie, sessionVerify);
      if (!me) return activateSignedOutHtml(config.instance.name, loginPathFor('/activate') ?? '/');
      const code = ctx.url.searchParams.get('code') ?? '';
      const pend = code ? await deviceAuth.describe(code) : null;
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
    const me = await resolveMember(store, req.headers.cookie, sessionVerify);
    if (!me) return render(activateSignedOutHtml(config.instance.name, loginPathFor('/activate') ?? '/'));
    const form = new URLSearchParams(await readRaw(req, 4096).then((b) => b.toString('utf8')).catch(() => ''));
    const code = form.get('code') ?? '';
    const decision = form.get('decision');
    if (!code || (decision !== 'approve' && decision !== 'deny')) {
      return render(activateFormHtml(config.instance.name, { error: 'Enter the code the device shows.' }));
    }
    if (decision === 'deny') {
      const ok = await deviceAuth.deny(code);
      if (ok) await audit(`user:${me.id}`, 'auth.device.deny', 'session', { code: normalizeUserCode(code) });
      return render(activateDoneHtml(config.instance.name, ok ? 'denied' : 'unknown'));
    }
    const approved = await deviceAuth.approve(code, {
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
  const buildOrgConfigFor = async (subject: UserRecord, client: { shell?: string; engine?: string } = {}) => {
    const overlays = await brandRules.project(brand.current() ?? await brand.snapshot(), subject.groups);
    const grants = await store.listGrants();
    // The inbox's own count for the same client (its shell and engine
    // selectors): the messages it shows and the comment notices that pass
    // `mayReceiveNotices` now (plan 76 M4).
    const unread = (await inboxMessages(subject, grants, client)).length + (await accessibleNotices({ store, config }, subject, { grants })).length;
    const flagGovernance = await store.listFlagGovernance();
    const injectables = new Map((await store.listInjectables()).map((r) => [r.id, r]));
    const toolInputs = new Map<string, Array<{ id: string }> | null>();
    for (const toolId of overlays.keys()) {
      toolInputs.set(toolId, await readToolInputs(config.instance.pack, toolId));
    }
    return assembleOrgConfig({ config, user: subject, overlays, grants, toolInputs, flagGovernance, injectables, render: renderCaps, inboxUnread: unread, ...(deps.liveCollab === false ? { liveCollab: false } : {}), projectFiles: projectFilesEnabled(config, store) });
  };

  // A small, uncached lease renewal. Resolve membership on every request so a
  // disabled account or revoked session cannot renew AI permission.
  router.add('GET', '/api/v1/policy/ai', async (req, res) => {
    if (!(await memberOf(req))) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, resolveAiPolicy(config.policy.ai, await store.listFlagGovernance()));
  });

  router.add('GET', '/api/v1/org-config', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    metrics.orgConfigPoll(); // the fleet heartbeat - counts 200 and 304
    const client = parseClientHeader(req.headers['x-lolly-client'] as string | undefined);
    let payload;
    try {
      payload = { ...await buildOrgConfigFor(user, { ...(client?.shell ? { shell: client.shell } : {}), ...(client?.engine ? { engine: client.engine } : {}) }),
        branding: { revision: brand.current()!.revision, sourceId: brand.current()!.source.id } };
    } catch (err) {
      metrics.orgConfigError();
      throw err;
    }
    const etag = `"oc-${payload.policyVersion}-${payload.inboxUnread}-${payload.branding.revision}"`;
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
      role: roleFromGroups(groups, config.idp.roleGroups),
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
  /**
   * The messages this person is shown: targeted at them, not acknowledged,
   * and still about something they can reach (plan 76 M4). A project share or
   * a live-collab invite is hidden once they can no longer see its project, an
   * invite also once its session is deleted, and a project access request once
   * they no longer manage that project. Hidden, not deleted: a message comes
   * back if the access does. Other kinds, and messages without the ids to
   * check, are shown as before.
   */
  const inboxMessages = async (user: UserRecord, grants: Grant[], client: { shell?: string; engine?: string } = {}): Promise<Message[]> => {
    const acked = await store.acksFor(user.id);
    const targeted = targetedMessages(await store.listMessages(), {
      groups: user.groups,
      userId: user.id,
      ...(client.shell ? { shell: client.shell } : {}),
      ...(client.engine ? { engineVersion: client.engine } : {}),
    }, acked);
    const projectOf = (m: Message): string | undefined =>
      m.kind === 'share' || m.kind === 'collab' || (m.kind === 'request' && m.data?.['requestKind'] === 'project') ? m.data?.['projectId'] : undefined;
    const sessionOf = (m: Message): string | undefined => (m.kind === 'collab' ? m.data?.['sessionId'] : undefined);
    const projectIds = [...new Set(targeted.flatMap((m) => projectOf(m) ?? []))];
    const sessionIds = [...new Set(targeted.flatMap((m) => sessionOf(m) ?? []))];
    if (!projectIds.length && !sessionIds.length) return targeted;
    const [projects, sessions, memberships] = await Promise.all([
      Promise.all(projectIds.map((id) => store.getProject(id))),
      Promise.all(sessionIds.map((id) => store.getSession(id))),
      store.listUserProjectMemberships(user.id),
    ]);
    const projectById = new Map(projects.flatMap((p) => (p ? [[p.id, p] as const] : [])));
    const liveSessions = new Set(sessions.flatMap((s) => (s && !s.deletedAt ? [s.id] : [])));
    const memberOfProject = new Map(memberships.map((m) => [m.projectId, m]));
    return targeted.filter((m) => {
      const sessionId = sessionOf(m);
      if (sessionId && !liveSessions.has(sessionId)) return false;
      const projectId = projectOf(m);
      if (!projectId) return true;
      const project = projectById.get(projectId);
      const membership = memberOfProject.get(projectId) ?? null;
      if (!project) return false;
      return m.kind === 'request'
        ? accessAtLeast(effectiveProjectAccess(user, project, membership, grants), 'manager')
        : canSeeProject(user, project, membership);
    });
  };

  // The shell asks again when its tab regains focus and once a minute while
  // it is visible (plans/74 invite spec R5), so a quiet read is a 304. The
  // ETag is a hash of exactly what this caller is shown: a new message, an
  // acknowledgement, an edit or a message reaching its end all move it, and so
  // does a comment notice arriving, changing or being acknowledged. `unread`
  // counts the messages and notices shown, the same count org-config carries
  // as `inboxUnread`.
  router.add('GET', '/api/v1/inbox', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const client = parseClientHeader(req.headers['x-lolly-client'] as string | undefined);
    const grants = await store.listGrants();
    const [shown, notices] = await Promise.all([
      inboxMessages(user, grants, { ...(client?.shell ? { shell: client.shell } : {}), ...(client?.engine ? { engine: client.engine } : {}) }),
      listAccessibleNotices({ store, config }, user, { grants }),
    ]);
    const msgs = [...shown, ...notices];
    const etag = `"ib-${sha256Hex(JSON.stringify(msgs)).slice(0, 16)}"`;
    const headers = { etag, 'cache-control': 'private, no-cache' };
    const asked = String(req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (asked.includes(etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    sendJson(res, 200, { messages: msgs, unread: msgs.length }, headers);
  });

  // A comment notice (`cn_…`) is a row of its own: acknowledging it deletes
  // the caller's row and nobody else's, and never writes the message-ack
  // table, so the next reply in that thread shows a notice again.
  router.add('POST', '/api/v1/inbox/:id/ack', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const id = ctx.params.id as string;
    if (id.startsWith('cn_')) await store.deleteCommentNotices(user.id, { ids: [id] });
    else await store.ackMessage(id, user.id);
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
    // a plain read of the same session would. A guest-edit link hands out a
    // writer seat, so it needs what a save needs: editor on the project
    // (plans/74), never a viewer membership.
    if (body.target.sessionId) {
      const targetSession = await store.getSession(body.target.sessionId);
      if (!targetSession) return sendError(res, 404, 'NOT_FOUND', 'no such session');
      const targetProject = await store.getProject(targetSession.projectId);
      if (!targetProject) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
      const access = await projectAccessOf(user, targetProject, grants);
      if (!projectAllows(res, access, kind === 'guest-edit' ? 'editor' : 'viewer', 'session')) return;
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
      ...(body.password ? { pwHash: await hashPassword(body.password) } : {}),
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
    if (link.kind === 'project-invite') return sendError(res, 404, 'NOT_FOUND', 'open the project invitation address');
    const sig = ctx.url.searchParams.get('s') ?? '';
    const pw = ctx.url.searchParams.get('pw');
    let passwordOk = true;
    if (link.pwHash) {
      const miss = linkPasswordMisses.get(link.id);
      if (miss && miss.n >= LINK_PASSWORD_MISSES && Date.now() < miss.until) {
        res.setHeader('retry-after', String(Math.ceil((miss.until - Date.now()) / 1000)));
        return sendError(res, 429, 'PASSWORD_LOCKED', 'too many wrong passwords for this link - try again later');
      }
      passwordOk = pw !== null && (await verifyPassword(pw, link.pwHash));
      if (pw !== null && !passwordOk) {
        const fresh = !miss || Date.now() >= miss.until;
        linkPasswordMisses.set(link.id, { n: fresh ? 1 : miss.n + 1, until: Date.now() + LINK_PASSWORD_LOCK_MS });
        if (linkPasswordMisses.size > 10_000) linkPasswordMisses.clear();
      } else if (passwordOk) {
        linkPasswordMisses.delete(link.id);
      }
    }
    const status = checkLink(link, sig, linkVerify, { passwordOk });
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
      if (!result.evidence?.brandRules && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        'content-type': result.mime, etag, 'cache-control': result.evidence?.brandRules ? 'private, no-store' : 'public, max-age=300',
        'x-lolly-brand-check': result.evidence?.brandRules?.disposition ?? 'not-requested',
        ...provenanceHeader(result.provenance),
      };
      if (link.kind === 'download') headers['content-disposition'] = `attachment; filename="${toolId}${result.evidence?.brandRules?.disposition === 'draft' ? '-DRAFT' : ''}.${fmt}"`;
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
  // Service-token resolution (plans/35 wave 2): a Bearer lwt_* on the
  // Authorization header resolves to the token's synthetic principal. Only the
  // ACTION-GATED surface accepts one - the member workflow routes (approvals,
  // submit, collab, telemetry consent) stay human, because those flows mean "a
  // person decided", and a token impersonating that would launder authorship.
  const serviceAccountOf = async (req: IncomingMessage): Promise<UserRecord | null> => {
    const bearer = bearerFromHeader(req.headers.authorization);
    if (!bearer || !bearer.startsWith(SERVICE_TOKEN_PREFIX)) return null;
    const rec = await store.findApiTokenByHash(hashServiceSecret(bearer));
    if (!rec || rec.revokedAt) return null;
    void store.touchApiToken(rec.id, new Date().toISOString());
    return serviceAccountFor(rec);
  };

  const requireAction = async (
    req: IncomingMessage,
    res: ServerResponse,
    action: string,
    resources: string[] = ['*'],
  ): Promise<UserRecord | null> => {
    const user = (await memberOf(req)) ?? (await serviceAccountOf(req));
    if (!user) {
      sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      return null;
    }
    const grants = await store.listGrants();
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, resources, grants)) {
      sendError(res, 403, 'FORBIDDEN', `${action} required`);
      return null;
    }
    return user;
  };

  const requireDeliveryActor = async (req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null> => {
    const user = (await memberOf(req)) ?? (await serviceAccountOf(req));
    if (!user) sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    return user;
  };

  const deliveryWire = (delivery: DeliveryRecord): Record<string, unknown> => ({
    id: delivery.id,
    destinationId: delivery.destinationId,
    destinationVersion: delivery.destinationVersion,
    name: delivery.name,
    format: delivery.format,
    contentType: delivery.contentType,
    size: delivery.size,
    sha256: delivery.sha256,
    sourceJobId: delivery.sourceJobId ?? null,
    state: delivery.state,
    attempt: delivery.attempt,
    approvalId: delivery.approvalId ?? null,
    remoteId: delivery.remoteId ?? null,
    url: delivery.url ?? null,
    deliveredSha256: delivery.deliveredSha256 ?? null,
    transformation: delivery.transformation ?? null,
    error: delivery.error ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    deliveredAt: delivery.deliveredAt ?? null,
  });

  const runDelivery = async (delivery: DeliveryRecord, supplied?: Uint8Array): Promise<DeliveryRecord> => {
    const started: DeliveryRecord = {
      ...delivery,
      state: 'delivering',
      attempt: delivery.attempt + 1,
      updatedAt: new Date().toISOString(),
    };
    delete started.error;
    await store.putDelivery(started);
    try {
      const destination = deliveryDestinations.get(delivery.destinationId);
      if (!destination || destination.enabled !== true) throw new Error('delivery destination is disabled or gone');
      if (destinationVersion(destination) !== delivery.destinationVersion) {
        throw new Error('delivery destination changed; create a new delivery against the current target');
      }
      let bytes = supplied;
      if (!bytes) {
        const stored = await blobs.get(delivery.sourceRef);
        if (!stored) throw new Error('delivery source bytes are unavailable');
        bytes = new Uint8Array(await readBlobBody(stored.body, delivery.size + 1));
      }
      if (bytes.byteLength !== delivery.size || sha256Hex(bytes) !== delivery.sha256) {
        throw new Error('delivery source bytes no longer match the immutable digest');
      }
      const provider = createDeliveryProvider(destination, deliverySecrets.get(destination.id), fetchImpl);
      const receipt = await provider.deliver({
        deliveryId: delivery.id,
        bytes,
        name: delivery.name,
        format: delivery.format,
        contentType: delivery.contentType,
        sha256: delivery.sha256,
      });
      const now = new Date().toISOString();
      const delivered: DeliveryRecord = {
        ...started,
        state: 'delivered',
        remoteId: receipt.remoteId,
        ...(receipt.url ? { url: receipt.url } : {}),
        ...(receipt.deliveredSha256 ? { deliveredSha256: receipt.deliveredSha256 } : {}),
        transformation: receipt.transformation,
        updatedAt: now,
        deliveredAt: now,
      };
      await store.putDelivery(delivered);
      await audit(delivery.principal, 'delivery.delivered', `delivery:${delivery.id}`, {
        destinationId: delivery.destinationId,
        remoteId: receipt.remoteId,
        name: delivery.name,
        format: delivery.format,
        size: delivery.size,
        sha256: delivery.sha256,
        transformation: receipt.transformation,
      });
      return delivered;
    } catch (error) {
      const failed: DeliveryRecord = {
        ...started,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
      await store.putDelivery(failed);
      await audit(delivery.principal, 'delivery.failed', `delivery:${delivery.id}`, {
        destinationId: delivery.destinationId,
        name: delivery.name,
        format: delivery.format,
        size: delivery.size,
        sha256: delivery.sha256,
        attempt: failed.attempt,
      });
      return failed;
    }
  };

  /** Settle the one delivery an approval names. The immutable record is the
   *  approval subject, so the decision cannot be replayed over different bytes
   *  or a changed destination. */
  const settleDeliveryApproval = async (approval: Approval, actorId: string): Promise<boolean> => {
    if (approval.subjectType !== 'delivery') return false;
    const principal = `user:${approval.createdBy}`;
    const delivery = await store.getDelivery(approval.subjectRef, principal);
    if (!delivery || delivery.approvalId !== approval.id) return true;
    if (delivery.state !== 'awaiting-approval') return true;
    let settled: DeliveryRecord;
    if (approval.state === 'approved') {
      settled = await runDelivery({ ...delivery, state: 'queued', updatedAt: new Date().toISOString() });
    } else {
      const state = approval.state === 'withdrawn' ? 'cancelled' : 'rejected';
      settled = {
        ...delivery,
        state,
        error: state === 'cancelled' ? 'delivery approval was withdrawn' : 'delivery approval was rejected',
        updatedAt: new Date().toISOString(),
      };
      await store.putDelivery(settled);
      await audit(`user:${actorId}`, `delivery.${state}`, `delivery:${delivery.id}`, {
        approvalId: approval.id, destinationId: delivery.destinationId, sha256: delivery.sha256,
      });
    }
    await store.putMessage({
      id: `msg_${randomId(8)}`,
      kind: 'approval', severity: settled.state === 'delivered' ? 'info' : 'action',
      audience: { users: [approval.createdBy] },
      title: settled.state === 'delivered'
        ? `Delivered: ${delivery.name}`
        : `Delivery ${settled.state}: ${delivery.name}`,
      body: settled.state === 'delivered'
        ? 'Your approved export was delivered to its organization destination.'
        : (settled.error ?? `The delivery is ${settled.state}.`),
      cta: { label: 'View', url: '/admin#/approvals' },
      data: { deliveryId: delivery.id, approvalId: approval.id, state: settled.state },
      dismissible: true,
    });
    notifier.event('delivery.decided', {
      id: delivery.id, approvalId: approval.id, state: settled.state, destinationId: delivery.destinationId,
    });
    return true;
  };

  // Safe descriptors only: the caller never sees endpoint, bucket, prefix or
  // credentialRef. Per-target deny grants and group exposure both remove the
  // target entirely rather than disclosing an unusable destination.
  router.add('GET', '/api/v1/destinations', async (req, res) => {
    const user = await requireDeliveryActor(req, res);
    if (!user) return;
    const grants = await store.listGrants();
    const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
    const destinations = config.delivery.destinations
      .filter((destination) => destinationAvailableTo(destination, principal, grants))
      .map((destination) => destinationDescriptor(destination, config.delivery.maxBytes));
    sendJson(res, 200, { destinations }, { 'cache-control': 'private, no-store' });
  });

  router.add('POST', '/api/v1/destinations/:id/deliveries', async (req, res, ctx) => {
    const destinationId = ctx.params.id as string;
    const user = await requireAction(req, res, 'delivery.create', [`destination:${destinationId}`, '*']);
    if (!user) return;
    const destination = deliveryDestinations.get(destinationId);
    const grants = await store.listGrants();
    if (!destination || !destinationAvailableTo(
      destination,
      { userId: user.id, groups: user.groups, role: user.role as Role },
      grants,
    )) {
      return sendError(res, 404, 'NOT_FOUND', 'no such delivery destination');
    }
    if (!deliverySecrets.has(destination.id)) {
      return sendError(res, 503, 'DESTINATION_UNAVAILABLE', 'delivery destination credential is not configured');
    }
    const approvalChain = destination.approvalChain
      ? await store.getChain(destination.approvalChain)
      : null;
    if (destination.approvalChain && !approvalChain) {
      return sendError(res, 503, 'APPROVAL_CHAIN_UNAVAILABLE', 'the destination approval chain is not configured');
    }
    if (approvalChain && user.id.startsWith('svc_')) {
      return sendError(res, 403, 'HUMAN_APPROVAL_REQUIRED', 'this destination requires a member to request human approval');
    }
    const name = (ctx.url.searchParams.get('name') ?? '').trim();
    const format = (ctx.url.searchParams.get('format') ?? '').trim().toLowerCase();
    if (!name || name.length > 200 || !/^[a-z0-9][a-z0-9-]*$/i.test(format)) {
      return sendError(res, 400, 'INVALID_INPUT', 'name (1-200 characters) and format are required');
    }
    if (!destination.formats.includes(format)) {
      return sendError(res, 415, 'FORMAT_NOT_ALLOWED', `${format} is not allowed for this destination`);
    }
    const maxBytes = Math.min(config.delivery.maxBytes, destination.maxBytes ?? config.delivery.maxBytes);
    let bytes: Buffer;
    try {
      bytes = await readRaw(req, maxBytes);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `delivery exceeds the ${maxBytes} byte cap`);
    }
    if (!bytes.length) return sendError(res, 400, 'INVALID_INPUT', 'empty delivery body');
    const gate = await verifyLollyExport(bytes, format);
    if (!gate.ok) return sendError(res, 422, 'NOT_LOLLY_EXPORT', gate.detail ?? 'only Lolly exports may be delivered');

    const sha256 = sha256Hex(bytes);
    const version = destinationVersion(destination);
    // The verified format, not a caller-controlled header, owns the object MIME.
    const mime = deliveryContentType(format);
    const requestHash = sha256Hex(JSON.stringify({ destinationId, version, name, format, contentType: mime, size: bytes.length, sha256 }));
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey.length > 200) return sendError(res, 400, 'INVALID_INPUT', 'Idempotency-Key is at most 200 characters');
    const principal = `user:${user.id}`;
    if (idempotencyKey) {
      const existing = await store.findDeliveryByIdempotency(principal, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different delivery');
        }
        return sendJson(res, 200, deliveryWire(existing), { 'cache-control': 'private, no-store' });
      }
    }

    const id = `del_${randomId(16)}`;
    const approvalId = approvalChain ? `apr_${randomId(8)}` : undefined;
    const sourceRef = `delivery/${id}/source`;
    const now = new Date().toISOString();
    const delivery: DeliveryRecord = {
      id,
      principal,
      destinationId,
      destinationVersion: version,
      name,
      format,
      contentType: mime,
      size: bytes.length,
      sha256,
      requestHash,
      sourceRef,
      state: approvalChain ? 'awaiting-approval' : 'queued',
      attempt: 0,
      ...(approvalId ? { approvalId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await blobs.put(sourceRef, bytes, mime);
      await store.putDelivery(delivery);
      if (approvalChain && approvalId) {
        await store.putApproval(createApproval({
          id: approvalId,
          subjectType: 'delivery',
          subjectRef: id,
          title: `Deliver ${name} to ${destination.label}`,
          chain: approvalChain,
          nominees: [],
          createdBy: user.id,
          now,
        }));
      }
    } catch (error) {
      try { await blobs.delete(sourceRef); } catch { /* best-effort orphan cleanup */ }
      // Postgres' (principal,idempotency_key) unique index closes the race
      // between two replicas that both observed no record above. If this loser
      // can now see the winner, return normal idempotency semantics rather than
      // surfacing the constraint as a staging failure.
      const raced = idempotencyKey
        ? await store.findDeliveryByIdempotency(principal, idempotencyKey).catch(() => null)
        : null;
      if (raced) {
        if (raced.requestHash !== requestHash) {
          return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different delivery');
        }
        return sendJson(res, 200, deliveryWire(raced), { 'cache-control': 'private, no-store' });
      }
      return sendError(res, 502, 'DELIVERY_STAGE_FAILED', (error as Error).message);
    }
    await audit(principal, 'delivery.created', `delivery:${id}`, {
      destinationId, name, format, size: bytes.length, sha256,
      ...(approvalId ? { approvalId } : {}),
    });
    if (approvalChain && approvalId) {
      const approval = await store.getApproval(approvalId);
      const step = approval ? currentStep(approval) : null;
      await audit(principal, 'approval.submit', `approval:${approvalId}`, {
        chainId: approvalChain.id, subjectType: 'delivery', deliveryId: id,
      });
      if (step) {
        await store.putMessage({
          id: `msg_${randomId(8)}`,
          kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
          title: `Approval requested: Deliver ${name} to ${destination.label}`,
          body: `${user.email} asked for review on the “${step.name}” step.`,
          cta: { label: 'Review', url: '/admin#/approvals' },
          dismissible: true,
        });
        const reviewers = (await store.listUsers()).filter((candidate) =>
          !candidate.disabledAt && candidate.id !== user.id && isEligible(step, candidate.groups));
        notifier.email(reviewers.map((candidate) => candidate.email),
          `Approval requested: Deliver ${name} to ${destination.label}`,
          `${user.email} asked for review on the “${step.name}” step.\n\nReview it: ${config.instance.baseUrl}/admin#/approvals`);
      }
      notifier.event('approval.requested', {
        id: approvalId, title: `Deliver ${name} to ${destination.label}`,
        chainId: approvalChain.id, by: user.email,
      });
      return sendJson(res, 202, deliveryWire(delivery), {
        location: `/api/v1/deliveries/${id}`, 'cache-control': 'private, no-store',
      });
    }
    const completed = await runDelivery(delivery, bytes);
    if (completed.state === 'failed') {
      return sendError(res, 502, 'DELIVERY_FAILED', completed.error ?? 'delivery failed', { delivery: deliveryWire(completed) });
    }
    sendJson(res, 201, deliveryWire(completed), { location: `/api/v1/deliveries/${id}`, 'cache-control': 'private, no-store' });
  });

  // Publish one completed automation render by REFERENCE. The result blob is
  // already the immutable output owned by the job, so this path never asks the
  // caller to download and upload it again and never creates a second blob.
  router.add('POST', '/api/v1/jobs/:id/deliveries', async (req, res, ctx) => {
    const body = (await readJson(req, 32 * 1024)) as {
      destinationId?: unknown;
      name?: unknown;
      format?: unknown;
    } | null;
    const destinationId = typeof body?.destinationId === 'string' ? body.destinationId.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!destinationId || !name || name.length > 200) {
      return sendError(res, 400, 'INVALID_INPUT', 'destinationId and name (1-200 characters) are required');
    }
    const user = await requireAction(req, res, 'delivery.create', [`destination:${destinationId}`, '*']);
    if (!user) return;
    const destination = deliveryDestinations.get(destinationId);
    const grants = await store.listGrants();
    if (!destination || !destinationAvailableTo(
      destination,
      { userId: user.id, groups: user.groups, role: user.role as Role },
      grants,
    )) {
      return sendError(res, 404, 'NOT_FOUND', 'no such delivery destination');
    }
    if (!deliverySecrets.has(destination.id)) {
      return sendError(res, 503, 'DESTINATION_UNAVAILABLE', 'delivery destination credential is not configured');
    }
    const approvalChain = destination.approvalChain
      ? await store.getChain(destination.approvalChain)
      : null;
    if (destination.approvalChain && !approvalChain) {
      return sendError(res, 503, 'APPROVAL_CHAIN_UNAVAILABLE', 'the destination approval chain is not configured');
    }
    if (approvalChain && user.id.startsWith('svc_')) {
      return sendError(res, 403, 'HUMAN_APPROVAL_REQUIRED', 'this destination requires a member to request human approval');
    }

    const jobPrincipal = user.id.startsWith('svc_') ? `service:${user.id}` : `user:${user.id}`;
    const job = await store.getAutomationJob(ctx.params.id as string, jobPrincipal);
    if (!job) return sendError(res, 404, 'NOT_FOUND', 'no such automation job');
    if (job.state !== 'done') return sendError(res, 409, 'JOB_NOT_DONE', 'the automation job has not completed');
    const format = job.verb === 'render' && typeof job.request.format === 'string'
      ? job.request.format.trim().toLowerCase()
      : '';
    if (!format || !job.resultRef || !job.resultSha256) {
      return sendError(res, 409, 'JOB_OUTPUT_NOT_DELIVERABLE', 'only a completed render output can be delivered');
    }
    if (body?.format !== undefined && (typeof body.format !== 'string' || body.format.trim().toLowerCase() !== format)) {
      return sendError(res, 409, 'OUTPUT_FORMAT_MISMATCH', 'format must match the immutable render output');
    }
    if (!destination.formats.includes(format)) {
      return sendError(res, 415, 'FORMAT_NOT_ALLOWED', `${format} is not allowed for this destination`);
    }
    const mime = deliveryContentType(format);
    if (job.resultMime && job.resultMime.split(';', 1)[0] !== mime.split(';', 1)[0]) {
      return sendError(res, 409, 'JOB_OUTPUT_NOT_DELIVERABLE', 'the render output MIME does not match its format');
    }
    const maxBytes = Math.min(config.delivery.maxBytes, destination.maxBytes ?? config.delivery.maxBytes);
    const source = await blobs.get(job.resultRef);
    if (!source) return sendError(res, 410, 'JOB_OUTPUT_GONE', 'the retained render output is no longer available');
    if (!source.stat.size) return sendError(res, 409, 'JOB_OUTPUT_NOT_DELIVERABLE', 'the render output is empty');
    if (source.stat.size > maxBytes) {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `delivery exceeds the ${maxBytes} byte cap`);
    }
    let bytes: Buffer;
    try {
      bytes = await readBlobBody(source.body, maxBytes);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `delivery exceeds the ${maxBytes} byte cap`);
    }
    const sha256 = sha256Hex(bytes);
    if (bytes.length !== source.stat.size || sha256 !== job.resultSha256) {
      return sendError(res, 409, 'JOB_OUTPUT_CORRUPT', 'the retained render output failed its integrity check');
    }
    const gate = await verifyLollyExport(bytes, format);
    if (!gate.ok) return sendError(res, 422, 'NOT_LOLLY_EXPORT', gate.detail ?? 'only Lolly exports may be delivered');

    const version = destinationVersion(destination);
    const requestHash = sha256Hex(JSON.stringify({
      destinationId, version, name, format, contentType: mime, size: bytes.length, sha256,
      sourceJobId: job.id,
    }));
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim();
    if (idempotencyKey.length > 200) return sendError(res, 400, 'INVALID_INPUT', 'Idempotency-Key is at most 200 characters');
    const principal = `user:${user.id}`;
    if (idempotencyKey) {
      const existing = await store.findDeliveryByIdempotency(principal, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different delivery');
        }
        return sendJson(res, 200, deliveryWire(existing), { 'cache-control': 'private, no-store' });
      }
    }

    const id = `del_${randomId(16)}`;
    const approvalId = approvalChain ? `apr_${randomId(8)}` : undefined;
    const now = new Date().toISOString();
    const delivery: DeliveryRecord = {
      id,
      principal,
      destinationId,
      destinationVersion: version,
      name,
      format,
      contentType: mime,
      size: bytes.length,
      sha256,
      requestHash,
      sourceRef: job.resultRef,
      sourceJobId: job.id,
      state: approvalChain ? 'awaiting-approval' : 'queued',
      attempt: 0,
      ...(approvalId ? { approvalId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await store.putDelivery(delivery);
      if (approvalChain && approvalId) {
        await store.putApproval(createApproval({
          id: approvalId,
          subjectType: 'delivery',
          subjectRef: id,
          title: `Deliver ${name} to ${destination.label}`,
          chain: approvalChain,
          nominees: [],
          createdBy: user.id,
          now,
        }));
      }
    } catch (error) {
      const raced = idempotencyKey
        ? await store.findDeliveryByIdempotency(principal, idempotencyKey).catch(() => null)
        : null;
      if (raced) {
        if (raced.requestHash !== requestHash) {
          return sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different delivery');
        }
        return sendJson(res, 200, deliveryWire(raced), { 'cache-control': 'private, no-store' });
      }
      return sendError(res, 502, 'DELIVERY_STAGE_FAILED', (error as Error).message);
    }
    await audit(principal, 'delivery.created', `delivery:${id}`, {
      destinationId, name, format, size: bytes.length, sha256, sourceJobId: job.id,
      ...(approvalId ? { approvalId } : {}),
    });
    if (approvalChain && approvalId) {
      const approval = await store.getApproval(approvalId);
      const step = approval ? currentStep(approval) : null;
      await audit(principal, 'approval.submit', `approval:${approvalId}`, {
        chainId: approvalChain.id, subjectType: 'delivery', deliveryId: id, sourceJobId: job.id,
      });
      if (step) {
        await store.putMessage({
          id: `msg_${randomId(8)}`,
          kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
          title: `Approval requested: Deliver ${name} to ${destination.label}`,
          body: `${user.email} asked for review on the “${step.name}” step.`,
          cta: { label: 'Review', url: '/admin#/approvals' },
          dismissible: true,
        });
        const reviewers = (await store.listUsers()).filter((candidate) =>
          !candidate.disabledAt && candidate.id !== user.id && isEligible(step, candidate.groups));
        notifier.email(reviewers.map((candidate) => candidate.email),
          `Approval requested: Deliver ${name} to ${destination.label}`,
          `${user.email} asked for review on the “${step.name}” step.\n\nReview it: ${config.instance.baseUrl}/admin#/approvals`);
      }
      notifier.event('approval.requested', {
        id: approvalId, title: `Deliver ${name} to ${destination.label}`,
        chainId: approvalChain.id, by: user.email,
      });
      return sendJson(res, 202, deliveryWire(delivery), {
        location: `/api/v1/deliveries/${id}`, 'cache-control': 'private, no-store',
      });
    }
    const completed = await runDelivery(delivery, bytes);
    if (completed.state === 'failed') {
      return sendError(res, 502, 'DELIVERY_FAILED', completed.error ?? 'delivery failed', { delivery: deliveryWire(completed) });
    }
    sendJson(res, 201, deliveryWire(completed), {
      location: `/api/v1/deliveries/${id}`, 'cache-control': 'private, no-store',
    });
  });

  router.add('GET', '/api/v1/deliveries', async (req, res) => {
    const user = await requireDeliveryActor(req, res);
    if (!user) return;
    sendJson(res, 200, {
      deliveries: (await store.listDeliveries(`user:${user.id}`)).map(deliveryWire),
    }, { 'cache-control': 'private, no-store' });
  });

  router.add('GET', '/api/v1/deliveries/:id', async (req, res, ctx) => {
    const user = await requireDeliveryActor(req, res);
    if (!user) return;
    const delivery = await store.getDelivery(ctx.params.id as string, `user:${user.id}`);
    if (!delivery) return sendError(res, 404, 'NOT_FOUND', 'no such delivery');
    sendJson(res, 200, deliveryWire(delivery), { 'cache-control': 'private, no-store' });
  });

  router.add('POST', '/api/v1/deliveries/:id/retry', async (req, res, ctx) => {
    const user = await requireDeliveryActor(req, res);
    if (!user) return;
    const principal = `user:${user.id}`;
    const delivery = await store.getDelivery(ctx.params.id as string, principal);
    if (!delivery) return sendError(res, 404, 'NOT_FOUND', 'no such delivery');
    if (delivery.state === 'delivered') return sendError(res, 409, 'ALREADY_DELIVERED', 'this delivery already completed');
    if (delivery.state !== 'failed') {
      return sendError(res, 409, 'DELIVERY_NOT_RETRYABLE', `a ${delivery.state} delivery cannot be retried`);
    }
    const destination = deliveryDestinations.get(delivery.destinationId);
    if (!destination || destination.enabled !== true) {
      return sendError(res, 410, 'DESTINATION_GONE', 'the delivery destination is no longer available');
    }
    const grants = await store.listGrants();
    if (!destinationAvailableTo(
      destination,
      { userId: user.id, groups: user.groups, role: user.role as Role },
      grants,
    )) {
      return sendError(res, 403, 'FORBIDDEN', 'delivery.create required for this destination');
    }
    if (destinationVersion(destination) !== delivery.destinationVersion) {
      return sendError(res, 409, 'DESTINATION_CHANGED', 'the destination changed; create a new delivery against its current configuration');
    }
    const completed = await runDelivery(delivery);
    if (completed.state === 'failed') {
      return sendError(res, 502, 'DELIVERY_FAILED', completed.error ?? 'delivery failed', { delivery: deliveryWire(completed) });
    }
    sendJson(res, 200, deliveryWire(completed), { 'cache-control': 'private, no-store' });
  });

  // ── service tokens (plans/35 wave 2) ──────────────────────────────────────
  const tokenWire = (t: { id: string; label: string; role: string; createdBy: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }) =>
    ({ id: t.id, label: t.label, role: t.role, createdBy: t.createdBy, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null, revokedAt: t.revokedAt ?? null });

  router.add('POST', '/api/v1/tokens', async (req, res) => {
    const actor = await requireAction(req, res, 'token.manage');
    if (!actor) return;
    const body = (await readJson(req)) as { label?: unknown; role?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 80) : '';
    if (!label) return sendError(res, 400, 'INVALID_INPUT', 'label required - name the automation, not a person');
    if (typeof body?.role !== 'string' || !TOKEN_ROLES.includes(body.role)) {
      return sendError(res, 400, 'INVALID_INPUT', `role must be one of: ${TOKEN_ROLES.join(', ')}`);
    }
    const { secret, tokenHash } = mintServiceSecret();
    const rec = {
      id: `tok_${randomId(8)}`, label, role: body.role, tokenHash,
      createdBy: `user:${actor.id}`, createdAt: new Date().toISOString(),
    };
    await store.putApiToken(rec);
    await audit(`user:${actor.id}`, 'token.create', `token:${rec.id}`, { label, role: body.role });
    // The one and only time the secret exists in a response.
    sendJson(res, 201, { ...tokenWire(rec), token: secret }, { 'cache-control': 'no-store' });
  });

  router.add('GET', '/api/v1/tokens', async (req, res) => {
    if (!(await requireAction(req, res, 'token.manage'))) return;
    sendJson(res, 200, { tokens: (await store.listApiTokens()).map(tokenWire) });
  });

  router.add('DELETE', '/api/v1/tokens/:id', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'token.manage');
    if (!actor) return;
    if (!(await store.revokeApiToken(ctx.params.id!, new Date().toISOString()))) {
      return sendError(res, 404, 'NOT_FOUND', 'no such live token');
    }
    await audit(`user:${actor.id}`, 'token.revoke', `token:${ctx.params.id}`);
    sendJson(res, 200, { ok: true });
  });

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

  // ── instance-pack hosting (plans/34 wave 2) ───────────────────────────────
  // The control plane SERVES the signed `.lolly` pack; it never builds one -
  // the format belongs to the OSS builder (see catalog/instance-pack.ts). The
  // upload gate holds one line: a hosted pack must point at THIS deployment.
  // Boot-seeded connect pack (plans/36 ship work): a config-named `.lolly`
  // hosted lazily on first read, so a read-only or ephemeral deploy (the
  // Vercel demo) offers the download without an owner ever running the PUT.
  // An uploaded pack always wins (the seed only fills an empty store), and a
  // file naming a different instance base is refused loudly, exactly as the
  // upload would refuse it.
  const ensureConnectPack = async (): Promise<void> => {
    await brand.ensureDownload().catch(error => console.error('Connect download unavailable:', (error as Error).message));
  };
  const offeredPack = async () => {
    await ensureConnectPack();
    const snap = await brand.snapshot();
    const request = brand.current();
    return (!request || request.source.id === snap.source.id && request.source.revision === snap.source.revision)
      && brand.downloadVisible(snap) ? snap.state.download : null;
  };
  const readPackMeta = async (): Promise<InstancePackMeta | null> => (await offeredPack())?.meta ?? null;

  router.add('GET', '/api/v1/instance-pack', async (req, res) => {
    if (!(await requireAction(req, res, 'fleet.view'))) return;
    sendJson(res, 200, { pack: await readPackMeta() });
  });

  router.add('PUT', '/api/v1/instance-pack', async (req, res) => {
    const actor = await requireAction(req, res, 'instance.config');
    if (!actor) return;
    let bytes: Buffer;
    try {
      bytes = await readRaw(req, PACK_MAX_BYTES);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `a pack is at most ${PACK_MAX_BYTES} bytes (the OSS builder's own budget)`);
    }
    if (store.brandPersistence !== 'durable' && !config.dev.enabled) return sendError(res, 409, 'READ_ONLY', 'Durable storage is required to change the connect download.');
    try {
      const meta = await brand.publishDownload(bytes, `user:${actor.id}`, await brand.snapshot());
      sendJson(res, 200, { pack: meta });
    } catch (error) {
      if (error instanceof BrandError) throw error;
      sendError(res, 400, 'INVALID_PACK', (error as Error).message);
    }
  });

  router.add('DELETE', '/api/v1/instance-pack', async (req, res) => {
    const actor = await requireAction(req, res, 'instance.config');
    if (!actor) return;
    const change = { action: 'stop-download' as const, sourceId: 'download' };
    const review = await brand.preview(actor, change);
    sendJson(res, 200, await brand.apply(actor, change, review.revision, review.reviewToken));
  });

  router.add('GET', '/connect/pack.lolly', async (req, res) => {
    // Gating follows defaultAccessMode (plans/34 §7b, resolved): an open
    // instance serves the pack publicly; anything else asks for a member
    // session. The pack holds no secrets, but it does hold the brand.
    //
    // Cross-origin reads follow that same gate (OSS plans/186 section 3.6). An
    // open instance is readable from anywhere and exposes the ETag, since the
    // client compares tags to decide whether to download again. A gated one
    // sends no CORS headers at all: a page on another origin cannot present the
    // session cookie, and a wildcard with credentials is refused by browsers
    // anyway, so the honest answer there is to sign in on the instance and
    // export the pack, or use the desktop app.
    if (config.policy.defaultAccessMode === 'open') allowCrossOriginRead(res, 'ETag');
    if (config.policy.defaultAccessMode !== 'open') {
      const me = await resolveMember(store, req.headers.cookie, sessionVerify);
      if (!me) return sendError(res, 401, 'UNAUTHORIZED', 'sign in to download the instance pack');
    }
    await ensureConnectPack();
    // The stored checksum IS the pack's cache identity - the same value the
    // meta route reports, since both come from the write's own stat. A client
    // that already holds these bytes revalidates for the price of one header
    // instead of pulling megabytes again, and re-hosting a pack changes the
    // tag by itself. `no-cache` rather than `no-store`: a browser may keep the
    // copy, it just may not serve it without asking us first. The tag is read
    // AFTER the access gate above, so a gated instance never leaks it.
    const offer = await offeredPack();
    const head = offer?.blobId ? await blobs.head(offer.blobId) : null;
    if (!head) return sendError(res, 404, 'NOT_FOUND', 'no instance pack is hosted here');
    const etag = `"${head.checksum}"`;
    if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
      res.end();
      return;
    }
    const blob = offer?.blobId ? await blobs.get(offer.blobId) : null;
    if (!blob) return sendError(res, 404, 'NOT_FOUND', 'no instance pack is hosted here');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${config.instance.name.replace(/[^A-Za-z0-9._ -]/g, '').replace(/\s+/g, ' ').trim() || 'instance'}.lolly"`,
      'content-length': String(blob.stat.size),
      etag,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
    });
    Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
  });

  // The preflight a browser sends before a cross-origin `If-None-Match` GET of
  // the pack. Open instances only, matching the gate on the download itself: a
  // gated instance answers with no CORS headers, which is how the browser
  // learns the cross-origin path is closed here.
  router.add('OPTIONS', '/connect/pack.lolly', (_req, res) => {
    if (config.policy.defaultAccessMode !== 'open') {
      res.writeHead(204);
      res.end();
      return;
    }
    sendReadPreflight(res);
  });

  // Schema readiness - pending migrations on the live store. Owner-gated
  // (instance.config) since it's an infra/operations signal for `lw migrate
  // --check` and monitoring. Memory store always reports current.
  router.add('GET', '/api/v1/system/migrations', async (req, res) => {
    if (!(await requireAction(req, res, 'instance.config'))) return;
    const pending = await store.pendingMigrations();
    sendJson(res, 200, { pending, current: pending.length === 0 });
  });

  router.add('GET', '/api/v1/system/setup', async (req, res) => {
    if (!(await requireAction(req, res, 'instance.config'))) return;
    const report = await setupReport();
    const [reachable, pending] = await Promise.all([store.ping().catch(() => false), store.pendingMigrations().catch(() => null)]);
    const checks = [...report.checks,
      { id: 'database-live', status: reachable ? 'pass' : 'fail', message: reachable ? 'The store answered this check.' : 'The store cannot answer. Check database availability.' },
      { id: 'schema', status: pending === null || pending.length ? 'fail' : 'pass', message: pending === null
        ? 'The schema check is unavailable. Check database availability.' : pending.length ? 'Apply pending migrations before acceptance.' : 'No pending migrations.' },
    ];
    sendJson(res, 200, { ...report, checkedAt: new Date().toISOString(), ready: !checks.some(check => check.status === 'fail'), checks }, { 'cache-control': 'no-store' });
  });

  registerSetupRoutes(router, { config: deploymentConfig, store, secrets, fetchImpl, audit,
    owner: (req, res) => requireAction(req, res, 'instance.config') });

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

  // Paged: `limit` newest events, or the `limit` events older than `before`
  // (a seq). `nextBefore` is the oldest seq on the page while older rows
  // exist. The chain verdict is the shared memo, not a per-request walk.
  router.add('GET', '/api/v1/audit', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 200) || 200), 1000);
    const before = Math.max(0, Number(ctx.url.searchParams.get('before') ?? 0) || 0);
    const filter: AuditFilter = {};
    for (const key of ['actor', 'action', 'subject', 'since', 'until'] as const) {
      const value = ctx.url.searchParams.get(key);
      if (!value) continue;
      if (value.length > 300 || (['since', 'until'].includes(key) && !Number.isFinite(Date.parse(value)))) return sendError(res, 400, 'INVALID_INPUT', 'Audit filters need bounded values and valid dates.');
      filter[key] = key === 'since' || key === 'until' ? new Date(value).toISOString() : value;
    }
    if (filter.since && filter.until && filter.since > filter.until) return sendError(res, 400, 'INVALID_INPUT', 'The audit start date must precede the end date.');
    const [page, total, matched, chain] = await Promise.all([
      store.listAuditBefore(before, limit + 1, filter), store.countAudit(), store.countAudit(filter), auditVerdict(),
    ]);
    const events = page.slice(Math.max(0, page.length - limit));
    const nextBefore = page.length > limit ? events[0]!.seq : null;
    sendJson(res, 200, { chain, total, matched, events, nextBefore });
  });

  // The chain head alone (seq + hash + intact flag) - small enough to record
  // externally on a schedule, so DB-level truncation becomes detectable.
  router.add('GET', '/api/v1/audit/head', async (req, res) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    sendJson(res, 200, await auditHead(store, auditMacKey));
  });

  // ── retention + erasure (plans/35 wave 3) ─────────────────────────────────
  // The run is a route rather than a CLI-to-database path so a serverless
  // deploy can cron it with a service token - the same reasoning as SIEM's
  // poll-with-a-token fallback. On the long-lived server main.ts also runs it
  // daily; the route stays idempotent either way.
  router.add('POST', '/api/v1/retention/run', async (req, res) => {
    const actor = await requireAction(req, res, 'instance.config');
    if (!actor) return;
    const result = await runRetention({ config, store, blobs });
    if (result.telemetryTrimmed || result.auditTrimmed || result.projectFilesSwept) {
      await audit(`user:${actor.id}`, 'retention.run', 'instance', { ...result });
    }
    sendJson(res, 200, result);
  });

  router.add('GET', '/api/v1/users/:id/erasure-preview', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'instance.config');
    if (!actor) return;
    const target = await store.getUser(ctx.params.id!);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    const preview = await store.previewUserErasure(target.id);
    sendJson(res, 200, {
      scope: 'account-identity-and-telemetry-attribution',
      userId: target.id,
      accountDisabled: !!target.disabledAt,
      blocked: target.id === actor.id || Object.values(preview.references).some((count) => count > 0),
      self: target.id === actor.id,
      ...preview,
      completePersonalDataErasure: false,
      reviewRequired: ['shared content and revisions', 'uploads and asset versions', 'render and delivery records',
        'audit, fleet and integration records', 'directory, recipients, device caches and exports', 'holds, retention and backup restoration'],
    }, { 'cache-control': 'no-store' });
  });

  router.add('DELETE', '/api/v1/users/:id', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'instance.config');
    if (!actor) return;
    const target = await store.getUser(ctx.params.id!);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    if (target.id === actor.id) return sendError(res, 409, 'ERASE_SELF', 'erase is for the departed - another owner erases you');
    // Erasure meets tamper evidence the classic way: the audit chain keeps
    // its opaque `user:<id>` actors (rewriting them would break the chain and
    // the point of having one), and erasure deletes the id-to-identity
    // MAPPING - the user row - plus the attribution on stored telemetry.
    const owned = (await store.listProjects()).filter((p) => p.ownerId === target.id && !p.archivedAt);
    if (owned.length) {
      return sendError(res, 409, 'ERASE_HAS_PROJECTS',
        `transfer their ${owned.length} active project(s) and inspect erasure-preview for retained references - erasure never silently destroys shared work`);
    }
    const refused = () => sendError(res, 409, 'ERASE_REFERENCED',
      'retained records still reference this account; inspect erasure-preview and resolve their approved lifecycle first. Archiving does not remove references. No identity or telemetry was changed.');
    if (Object.values((await store.previewUserErasure(target.id)).references).some((count) => count > 0)) return refused();
    // Unfinished uploads are nobody's shared work: they go (parts, then rows)
    // so their users FK does not block the erasure. Ready files block above.
    await removeUploadsBy(store, blobs, target.id);
    const result = await store.eraseUserAccount(target.id);
    if (result.status === 'referenced') return refused();
    if (result.status === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'no such user');
    const { scrubbed } = result;
    await audit(`user:${actor.id}`, 'user.erase', `user:${target.id}`, { scrubbed });
    sendJson(res, 200, { ok: true, scrubbed, scope: 'account-identity-and-telemetry-attribution', completePersonalDataErasure: false });
  });

  router.add('GET', '/api/v1/links', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const wantAll = ctx.url.searchParams.get('all') === '1';
    if (wantAll && !(await requireAction(req, res, 'link.revoke'))) return;
    const links = wantAll ? await store.listAllLinks() : await store.listLinksBy(user.id);
    const now = Math.floor(Date.now() / 1000);
    sendJson(res, 200, {
      links: links.filter(l => l.kind !== 'project-invite').map((l) => ({
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
    // Outstanding password links for the person go too, so re-enabling them
    // later does not bring an old link back to life.
    let linksRevoked = 0;
    if (body.disabled && passwordIdp) {
      for (const email of await passwordEmailsOf(updated)) linksRevoked += await store.revokePasswordLinks(email);
    }
    await audit(`user:${actor.id}`, body.disabled ? 'user.disable' : 'user.enable', `user:${updated.id}`, linksRevoked ? { passwordLinksRevoked: linksRevoked } : undefined);
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

  // ── linked sign-ins (plans/74, "One person, many sign-ins") ───────────────
  // A person lists and removes their own; an admin or owner does the same for
  // anyone from the console. A sign-in is addressed by idp plus subjectHash
  // (iam/identities.ts), so a raw IdP subject never leaves the server. The
  // sign-in an account was created with, and the last one, stay.
  /** The addresses a person's password could be under: the account's own,
   *  and those of its password sign-ins. */
  const passwordEmailsOf = async (user: UserRecord, rows?: Array<{ idp: string; email?: string }>): Promise<string[]> => {
    const all = rows ?? await store.listIdentities(user.id);
    return [...new Set([user.email, ...all.filter((r) => r.idp === passwordIdp?.id).map((r) => r.email ?? '')]
      .map((e) => normaliseEmail(e)).filter(Boolean))];
  };
  /** The password this person signs in with (the first address that holds
   *  one), or null. */
  const heldPassword = async (user: UserRecord, rows: Array<{ idp: string; email?: string }>) => {
    for (const e of await passwordEmailsOf(user, rows)) {
      const cred = await store.getPasswordCredential(e);
      if (cred) return cred;
    }
    return null;
  };
  const identitiesOf = async (user: UserRecord) => {
    const all = await store.listIdentities(user.id);
    return { all, wire: all.map((r) => identityWire(r, user, all, idpLabel(r.idp))) };
  };
  /** A fresh session cookie for a person whose own action just ended every
   *  session of theirs, so the device they acted from stays signed in. */
  const stayingSignedIn = (user: UserRecord): string => mintSessionCookie({
    sub: user.sub, email: user.email, groups: user.groups, role: user.role,
    name: displayName(user), epoch: user.sessionEpoch, authenticatedAt: Date.now(),
  }, secrets.session, secure, sessionTtlSec);
  /** Removes one sign-in, or answers why not. Returns the account as it
   *  stands after the removal, or null when an error was sent; the caller
   *  sends the 204.
   *
   *  Every session carries the account's own sub, so one minted through the
   *  removed sign-in looks like any other. Removing a sign-in is how a wrong
   *  or compromised one is put out, so the account's session epoch moves
   *  and every session it holds ends; the self route then hands the person
   *  a fresh one. */
  const unlinkFor = async (
    res: ServerResponse, actor: UserRecord, target: UserRecord, idp: string, hash: string, by: 'self' | 'admin',
  ): Promise<UserRecord | null> => {
    const all = await store.listIdentities(target.id);
    const row = all.find((r) => r.idp === idp && subjectHash(r.identitySub) === hash);
    if (!row) { sendError(res, 404, 'NOT_FOUND', 'no such sign-in on this account'); return null; }
    const block = unlinkBlock(row, target, all);
    if (block === 'account') {
      sendError(res, 409, 'ACCOUNT_SIGN_IN', 'this is the sign-in the account was created with, so it stays'); return null;
    }
    if (block === 'last') { sendError(res, 409, 'LAST_SIGN_IN', 'an account keeps at least one sign-in'); return null; }
    if (!(await store.unlinkIdentity(target.id, row.identitySub))) {
      sendError(res, 404, 'NOT_FOUND', 'no such sign-in on this account'); return null;
    }
    const after = (await store.bumpSessionEpoch(target.id)) ?? target;
    await audit(`user:${actor.id}`, 'identity.unlink', `user:${target.id}`, {
      by, idp: row.idp, ...(row.email ? { email: row.email } : {}), sessionsRevoked: true,
    });
    // A password sign-in is its credential: removing the row alone would let
    // the same password link straight back in by email on its next use.
    if (row.identitySub.startsWith('password:')) {
      const removed = await store.deletePasswordCredential(row.identitySub.slice('password:'.length));
      if (removed) await audit(`user:${actor.id}`, 'auth.password.remove', `user:${target.id}`, { by, email: removed.email });
    }
    return after;
  };

  router.add('GET', '/api/v1/me/identities', async (req, res) => {
    const me = await memberOf(req);
    if (!me) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    sendJson(res, 200, {
      identities: (await identitiesOf(me)).wire,
      // The sign-ins this instance offers, so a profile can say "Add GitHub".
      // A password sign-in comes from a link an admin issues, so it is not offered.
      available: idpProviders().filter((p) => p.kind !== 'password')
        .map((p) => ({ id: p.id, name: p.name, kind: p.kind, linkPath: `/api/auth/link?idp=${encodeURIComponent(p.id)}` })),
    }, { 'cache-control': 'no-store' });
  });

  router.add('DELETE', '/api/v1/me/identities/:idp/:subjectHash', async (req, res, ctx) => {
    const me = await memberOf(req);
    if (!me) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const after = await unlinkFor(res, me, me, ctx.params.idp as string, ctx.params.subjectHash as string, 'self');
    if (!after) return;
    res.writeHead(204, { 'set-cookie': stayingSignedIn(after) });
    res.end();
  });

  router.add('GET', '/api/v1/users/:id/identities', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!['admin', 'owner'].includes(user.role)) return sendError(res, 403, 'FORBIDDEN', 'admin role required');
    const target = await store.getUser(ctx.params.id as string);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    const { all, wire } = await identitiesOf(target);
    // With email and password sign-in on: whether this person has a password,
    // and the address a new sign-in link would be for (the one holding the
    // password, else the account's own).
    let password: { set: boolean; email: string; lockedUntil?: string } | undefined;
    if (passwordIdp) {
      const held = await heldPassword(target, all);
      const lockedUntil = held?.lockedUntil && Date.parse(held.lockedUntil) > Date.now() ? held.lockedUntil : undefined;
      password = { set: !!held, email: held?.email ?? normaliseEmail(target.email), ...(lockedUntil ? { lockedUntil } : {}) };
    }
    sendJson(res, 200, { identities: wire, ...(password ? { password } : {}) }, { 'cache-control': 'no-store' });
  });

  // Unlock a password that too many wrong guesses locked (plans/74). The
  // same guard as disable: an owner's is owner-only. Anyone can lock an
  // address by guessing at it, so this hands the person their way back
  // without making them choose a new password.
  router.add('POST', '/api/v1/users/:id/password/unlock', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'grant.edit');
    if (!actor) return;
    if (!passwordIdp) return sendError(res, 404, 'NO_PASSWORD_SIGN_IN', 'email and password sign-in is not configured on this instance');
    const target = await store.getUser(ctx.params.id as string);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    if (target.role === 'owner' && actor.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY', "only an owner can unlock an owner's password");
    }
    const held = await heldPassword(target, await store.listIdentities(target.id));
    if (!held) return sendError(res, 404, 'NO_PASSWORD', 'this person has no password');
    await store.clearPasswordFailures(held.email);
    await audit(`user:${actor.id}`, 'auth.password.unlock', `user:${target.id}`, { email: held.email });
    res.writeHead(204); res.end();
  });

  // The same guard as disable: an owner's sign-ins are owner-only to change.
  router.add('DELETE', '/api/v1/users/:id/identities/:idp/:subjectHash', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'grant.edit');
    if (!actor) return;
    const target = await store.getUser(ctx.params.id as string);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user');
    if (target.role === 'owner' && actor.role !== 'owner') {
      return sendError(res, 403, 'OWNER_ONLY', "only an owner can remove an owner's sign-ins");
    }
    const after = await unlinkFor(res, actor, target, ctx.params.idp as string, ctx.params.subjectHash as string, 'admin');
    if (!after) return;
    res.writeHead(204, after.id === actor.id ? { 'set-cookie': stayingSignedIn(after) } : {}); res.end();
  });

  // ── invitations (plans/74 W-ID-2) ─────────────────────────────────────────
  // Who may sign in, one email address at a time, and the local groups that
  // person joins on their first admitted sign-in. Nothing is emailed: the
  // console and the CLI show the sign-in address to share. One active
  // invitation per email, so inviting an address again is a no-op that
  // returns the invitation already there. Each pending invitation also has
  // a personal invite link (`inviteLink`, plans/74 invite spec 2.6), which
  // the wires carry; "New link" ends every link copied before it, and
  // "Invite again" writes a fresh invitation for an address whose
  // invitation ended.
  const INVITE_EMAIL = /^[^\s@]+@[^\s@]+$/;
  const INVITE_BATCH_MAX = 200;
  const INVITE_GROUPS_MAX = 50;
  const INVITE_MAX_DAYS = 366;
  /** New links one invitation may get in a day, from the console and the
   *  project people panel together. */
  const INVITE_LINKS_PER_DAY = 10;
  const inviteLinkQuota = createWindowQuota(INVITE_LINKS_PER_DAY, 86_400_000);
  /** Lowest to highest, for "does this group's role outrank the inviter". */
  const ROLE_RANK: readonly Role[] = ['guest', 'viewer', 'member', 'author', 'approver', 'admin', 'owner'];
  const invitationStatus = (r: InvitationRecord, now = Date.now()): 'pending' | 'accepted' | 'revoked' | 'expired' =>
    r.revokedAt ? 'revoked'
      : r.acceptedAt ? 'accepted'
        : r.expiresAt && Date.parse(r.expiresAt) <= now ? 'expired' : 'pending';
  /** An invitation as the console and the CLI see it (invite spec 2.8). */
  type InvitationWire = {
    id: string; email: string; groups: string[]; invitedBy: string; inviter: { name: string } | null;
    createdAt: string; expiresAt: string | null; acceptedAt: string | null; acceptedUserId: string | null;
    acceptedUser: { name: string; email: string } | null; revokedAt: string | null;
    status: 'pending' | 'accepted' | 'revoked' | 'expired';
    projects: Array<{ projectId: string; name: string | null; role: ProjectMemberRole; invitedBy: { name: string } | null }>;
    createdVia: 'console' | 'project' | 'request';
    link: string | null; linkVersion: number; openedAt: string | null;
    passwordSetup: boolean; password: 'none' | 'set';
  };
  /**
   * Invitations as wires, with each person and project read once for the
   * whole list. People are named without their address (`nameWithoutEmail`),
   * as the invite page names them; the console shows addresses in columns
   * of their own. `link` is the workspace link (no project) and is there
   * only while the invitation is pending. `password` is 'set' once the
   * address has a password, after which `passwordSetup` offers nothing.
   */
  const invitationViews = async (rows: readonly InvitationRecord[]): Promise<InvitationWire[]> => {
    const userIdOf = (principal: string | undefined): string | null => (principal?.startsWith('user:') ? principal.slice(5) : null);
    const userIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const r of rows) {
      for (const principal of [r.invitedBy, ...(r.projects ?? []).map((p) => p.invitedBy)]) {
        const id = userIdOf(principal);
        if (id) userIds.add(id);
      }
      if (r.acceptedUserId) userIds.add(r.acceptedUserId);
      for (const p of r.projects ?? []) projectIds.add(p.projectId);
    }
    const users = new Map((await store.getUsersByIds([...userIds])).map((u) => [u.id, u]));
    const projects = new Map<string, ProjectRecord>();
    for (const id of projectIds) {
      const project = await store.getProject(id);
      if (project) projects.set(id, project);
    }
    const withPassword = new Set<string>();
    if (passwordIdp) {
      for (const email of new Set(rows.map((r) => r.email))) if (await store.getPasswordCredential(email)) withPassword.add(email);
    }
    const named = (principal: string | undefined): { name: string } | null => {
      const u = users.get(userIdOf(principal) ?? '');
      return u ? { name: nameWithoutEmail(u) } : null;
    };
    const now = Date.now();
    return rows.map((r) => {
      const status = invitationStatus(r, now);
      const accepted = r.acceptedUserId ? users.get(r.acceptedUserId) : undefined;
      return {
        id: r.id, email: r.email, groups: r.groups, invitedBy: r.invitedBy, inviter: named(r.invitedBy), createdAt: r.createdAt,
        expiresAt: r.expiresAt ?? null, acceptedAt: r.acceptedAt ?? null, acceptedUserId: r.acceptedUserId ?? null,
        acceptedUser: accepted ? { name: nameWithoutEmail(accepted), email: accepted.email } : null,
        revokedAt: r.revokedAt ?? null, status,
        projects: (r.projects ?? []).map((p) => ({
          projectId: p.projectId, name: projects.get(p.projectId)?.name ?? null, role: p.role, invitedBy: named(p.invitedBy ?? r.invitedBy),
        })),
        createdVia: r.createdVia ?? 'console',
        link: status === 'pending' ? inviteLink(r, null) : null,
        linkVersion: r.linkVersion, openedAt: r.openedAt ?? null,
        passwordSetup: r.passwordSetup === true, password: withPassword.has(r.email) ? 'set' : 'none',
      };
    });
  };
  /** One invitation as a wire. The approve route of access requests answers with it. */
  const invitationView = async (r: InvitationRecord): Promise<InvitationWire> => (await invitationViews([r]))[0]!;
  /**
   * The sign-ins an invite message names ("Sign in as sam@work.com with
   * Google or GitHub"): every OIDC and GitHub sign-in, or the password one
   * when it is the only way in. A password is set from a link, so someone
   * who has none yet cannot use it to answer an invitation.
   */
  const inviteProviders = (): string[] => {
    const all = idpProviders();
    const named = all.filter((p) => p.kind !== 'password');
    return (named.length ? named : all).map((p) => p.name);
  };
  /** What the console needs to describe invitations honestly: the address to
   *  share, whether this deployment's admission rule reads invitations, and
   *  what an invite message says (the sign-ins, the password option, the
   *  domains whose invitations start with it ticked, and `instance.inviteNote`). */
  const invitationContext = () => ({
    signInUrl: config.instance.baseUrl,
    admission: {
      policy: !!config.idp.admission,
      invitations: config.idp.admission?.invitations !== false,
    },
    providers: inviteProviders(),
    passwordSignIn: !!passwordIdp,
    passwordDomains: resolveInvitePolicy(config.policy.invites).passwordDomains,
    inviteNote: config.instance.inviteNote ?? null,
  });

  /**
   * The accounts that have shown they hold this address, as opposed to every
   * account whose stored `users.email` merely says so. `users.email` is the
   * claim from the latest sign-in, verified or not, so an address an attacker
   * typed into a self-registration IdP would otherwise collect whatever was
   * shared with the real person. An account holds the address when one of its
   * sign-ins carries it and either the IdP verified it (the linking flag from
   * migration 0039) or the source is one the operator vouches for (the
   * reverse proxy, the dev provider, an IdP set to `emailVerification:
   * "trusted"`), or when it accepted the address's invitation, which needs a
   * verified sign-in, or when it has no sign-in yet (provisioned by the
   * operator). This is the bar an invitation's acceptance sets, so
   * sharing directly never reaches further than an invitation would.
   * `claimed` is every account naming the address, for the disabled check.
   */
  const trustedEmailSource = (idpId: string): boolean =>
    idpId === 'proxy' ? config.proxyAuth.enabled
      : idpId === 'dev' ? config.dev.enabled
        : resolveIdp(idpId)?.constraints.emailVerification === 'trusted';
  const accountsHoldingEmail = async (email: string): Promise<{ holders: UserRecord[]; claimed: UserRecord[] }> => {
    const e = email.trim().toLowerCase();
    const [claimed, verified, invitation] = await Promise.all([
      store.findUsersByEmail(e), store.findUsersByVerifiedEmail(e), store.findActiveInvitation(e),
    ]);
    const holders = new Map(verified.map((u) => [u.id, u]));
    if (invitation?.acceptedUserId && !holders.has(invitation.acceptedUserId)) {
      const accepted = await store.getUser(invitation.acceptedUserId);
      if (accepted) holders.set(accepted.id, accepted);
    }
    for (const u of claimed) {
      if (holders.has(u.id)) continue;
      // An account with no sign-in at all was provisioned by the operator
      // (SCIM, a seed): every sign-in writes an identity row, and migration
      // 0039 wrote one for every account before it.
      const signIns = await store.listIdentities(u.id);
      if (!signIns.length || signIns.some((i) => i.email === e && (i.emailVerified || trustedEmailSource(i.idp)))) holders.set(u.id, u);
    }
    return { holders: [...holders.values()], claimed };
  };

  /**
   * Why `actor` may not attach these local groups to an invitation, or null.
   * Attaching groups to an invitation assigns groups, so it carries every
   * control PUT /api/v1/users/:id/local-groups and the grant guard carry:
   *   - grant.edit, the action that edits a person's local groups;
   *   - no group whose mapped role outranks the inviter's own role (an
   *     owner group is owner-only, the grant guard's rule);
   *   - no group holding a grant for an owner-only action, unless an owner
   *     is inviting;
   *   - each group exists in the local registry. An owner may also name an
   *     IdP group or a role-mapped name: with a groupless IdP the owner group
   *     exists only as the bootstrap owner's IdP group, and an invitation is
   *     the console's one way to add a second owner.
   * Asked when an invitation is written and again when it is invited again.
   */
  const inviteGroupsRefusal = async (
    actor: UserRecord, groups: readonly string[],
  ): Promise<{ status: number; code: string; message: string; field?: string } | null> => {
    if (!groups.length) return null;
    const grants = await store.listGrants();
    const actorCtx = { userId: actor.id, groups: actor.groups, role: actor.role as Role };
    if (!evaluate(actorCtx, 'grant.edit', ['*'], grants)) {
      return { status: 403, code: 'FORBIDDEN', message: 'grant.edit required to invite people into groups', field: 'groups' };
    }
    const isOwner = actor.role === 'owner';
    const ownerGroups = groups.filter((g) => roleFromGroups([g], config.idp.roleGroups) === 'owner');
    if (ownerGroups.length && !isOwner) {
      return { status: 403, code: 'OWNER_ONLY', message: `only an owner can invite into an owner group: ${ownerGroups.join(', ')}` };
    }
    const actorRank = ROLE_RANK.indexOf(actor.role as Role);
    const above = groups.filter((g) => ROLE_RANK.indexOf(roleFromGroups([g], config.idp.roleGroups)) > actorRank);
    if (above.length) {
      return { status: 403, code: 'ROLE_ESCALATION', message: `these groups carry a role above yours: ${above.join(', ')}`, field: 'groups' };
    }
    if (!isOwner) {
      const powered = groups.filter((g) => grants.some((gr) => gr.principal === `group:${g}` && gr.effect === 'allow' && ownerOnlyAction(gr.action)));
      if (powered.length) {
        return { status: 403, code: 'OWNER_ONLY_ACTION', message: `only an owner can invite into a group holding owner-only grants: ${powered.join(', ')}`, field: 'groups' };
      }
    }
    const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
    const ownerNamable = new Set<string>();
    if (isOwner) {
      for (const u of await store.listUsers()) for (const g of u.idpGroups) ownerNamable.add(g);
      for (const role of ['owner', 'admin', 'approver', 'author', 'member', 'viewer'] as const) {
        const names = config.idp.roleGroups[role] ?? (['owner', 'admin', 'approver', 'author'].includes(role) ? [role] : []);
        for (const n of names) ownerNamable.add(n);
      }
    }
    const unknown = groups.filter((g) => !registry.has(g) && !ownerNamable.has(g));
    if (unknown.length) return { status: 400, code: 'UNKNOWN_GROUP', message: `not local groups: ${unknown.join(', ')}`, field: 'groups' };
    return null;
  };

  /** An `expiresAt` from a request body: absent, or an ISO time in the
   *  future and at most `INVITE_MAX_DAYS` away. */
  const parseInviteExpiry = (raw: unknown): { at?: string } | { error: string } => {
    if (raw === undefined || raw === null || raw === '') return {};
    const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    const now = Date.now();
    if (!Number.isFinite(t)) return { error: 'expiresAt must be an ISO 8601 date-time' };
    if (t <= now) return { error: 'expiresAt must be in the future' };
    if (t > now + INVITE_MAX_DAYS * 86_400_000) return { error: `expiresAt must be within ${INVITE_MAX_DAYS} days` };
    return { at: new Date(t).toISOString() };
  };

  /** Why `issueInvitation` wrote nothing. 'invitation-changed': the
   *  invitation there was accepted or revoked while it was being extended. */
  type IssueRefusal = 'invites-not-allowed' | 'domain-not-allowed' | 'invitations-off' | 'account-disabled' | 'invitation-changed';
  type IssueResult =
    | { status: 'created' | 'existing'; invitation: InvitationRecord; extended?: boolean }
    | { status: 'already-member'; userIds: string[] }
    | { status: 'refused'; reason: IssueRefusal };
  /**
   * Write, or extend, the invitation that lets a new person in (invite spec
   * 2.9). Every route that invites an address comes through here: the
   * console (R15), Invite again (R14, R20), a project invite (R18) and an
   * approved join or switch request (access/routes.ts). In order:
   *   - an address an account has shown it holds needs no invitation
   *     ('already-member'), and one that a disabled account names would
   *     never be let in ('account-disabled'). A caller that has already
   *     shared with, or refused, those accounts passes `accountsChecked`;
   *   - `policy.invites`: the allow tier, then the domain list;
   *   - `idp.admission.invitations: false`, under which sign-in reads no
   *     invitation, so one written now would never be accepted;
   *   - one active invitation per address: a new one is written, or the
   *     projects are merged into the one there (a role is only raised and
   *     its end date never moves). An accepted one comes back unchanged.
   * `passwordSetup` is kept only when `maySetPasswordFromLink` allows it for
   * the actor, and this only ever turns it on. A new invitation supersedes
   * the address's open join request. Audited `invite.create` (`via` the
   * route, or 'reinvite' with `from` for Invite again) or `invite.extend`.
   */
  const issueInvitation = async (actor: UserRecord, input: {
    email: string; groups: string[]; projects: InvitationProject[]; expiresAt?: string;
    createdVia: 'console' | 'project' | 'request'; passwordSetup?: boolean;
    /** The caller already shared with, or refused, every account that holds the address. */
    accountsChecked?: boolean;
    /** Invite again: the ended invitation this one replaces. */
    reinviteOf?: string;
  }): Promise<IssueResult> => {
    const email = input.email.trim().toLowerCase();
    if (!input.accountsChecked) {
      const { holders, claimed } = await accountsHoldingEmail(email);
      if ([...holders, ...claimed].some((u) => u.disabledAt)) return { status: 'refused', reason: 'account-disabled' };
      if (holders.length) return { status: 'already-member', userIds: holders.map((u) => u.id) };
    }
    const grants = await store.listGrants();
    const policy = resolveInvitePolicy(config.policy.invites);
    if (!mayInviteNewPeople(actor, grants, policy)) return { status: 'refused', reason: 'invites-not-allowed' };
    if (!inviteDomainAllowed(email, policy)) return { status: 'refused', reason: 'domain-not-allowed' };
    if (config.idp.admission?.invitations === false) return { status: 'refused', reason: 'invitations-off' };
    const passwordSetup = input.passwordSetup === true && maySetPasswordFromLink(config, actor, grants);
    const principal = `user:${actor.id}`;
    const { invitation, created } = await store.createInvitation({
      id: `inv_${randomId(10)}`, email, groups: input.groups, invitedBy: principal, createdAt: new Date().toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.projects.length ? { projects: input.projects } : {}),
      createdVia: input.createdVia, ...(passwordSetup ? { passwordSetup: true } : {}),
    });
    if (created) {
      await audit(principal, 'invite.create', `invitation:${invitation.id}`, {
        email, groups: invitation.groups, ...(input.projects.length ? { projects: input.projects } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        via: input.reinviteOf ? 'reinvite' : input.createdVia, ...(input.reinviteOf ? { from: input.reinviteOf } : {}),
        passwordSetup,
      });
      await closeRequestsForEmail(accessDeps, { email }, principal);
      return { status: 'created', invitation };
    }
    if (invitation.acceptedAt) return { status: 'existing', invitation };
    let current = invitation;
    let extended = false;
    for (const entry of input.projects) {
      const merged = mergeInvitationProject(current.projects ?? [], entry);
      if (!merged.changed) continue;
      const updated = await store.setInvitationProjects(current.id, merged.projects);
      if (!updated) return { status: 'refused', reason: 'invitation-changed' };
      await audit(principal, 'invite.extend', `invitation:${current.id}`, { email, project: entry });
      current = updated;
      extended = true;
    }
    if (passwordSetup && !current.passwordSetup) {
      const updated = await store.setInvitationPasswordSetup(current.id, true);
      if (!updated) return { status: 'refused', reason: 'invitation-changed' };
      await audit(principal, 'invite.extend', `invitation:${current.id}`, { email, passwordSetup: true });
      current = updated;
      extended = true;
    }
    return { status: 'existing', invitation: current, extended };
  };

  /** Raise a pending invitation's link version, within its daily allowance,
   *  and audit it. Answers 429 or 404 itself and returns null then. */
  const rotateInviteLink = async (res: ServerResponse, actor: UserRecord, inv: InvitationRecord): Promise<InvitationRecord | null> => {
    if (!inviteLinkQuota.take(inv.id)) {
      sendError(res, 429, 'RATE_LIMITED', `at most ${INVITE_LINKS_PER_DAY} new links a day for one invitation; try again tomorrow`);
      return null;
    }
    const rotated = await store.rotateInvitationLink(inv.id);
    if (!rotated) { sendError(res, 404, 'NOT_FOUND', 'no such pending invitation'); return null; }
    await audit(`user:${actor.id}`, 'invite.link', `invitation:${rotated.id}`, { email: rotated.email, version: rotated.linkVersion });
    return rotated;
  };

  router.add('GET', '/api/v1/invitations', async (req, res) => {
    if (!(await requireAction(req, res, 'user.invite'))) return;
    sendJson(res, 200, { invitations: await invitationViews(await store.listInvitations()), ...invitationContext() },
      { 'cache-control': 'no-store' });
  });

  router.add('POST', '/api/v1/invitations', async (req, res) => {
    const actor = await requireAction(req, res, 'user.invite');
    if (!actor) return;
    const body = (await readJson(req)) as { emails?: unknown; groups?: unknown; expiresAt?: unknown; passwordSetup?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');

    if (!Array.isArray(body.emails) || body.emails.length === 0 || !body.emails.every((e): e is string => typeof e === 'string')) {
      return sendError(res, 400, 'INVALID_INPUT', 'emails must be a non-empty array of email addresses', { field: 'emails' });
    }
    const emails = [...new Set(body.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length === 0) return sendError(res, 400, 'INVALID_INPUT', 'emails must name at least one address', { field: 'emails' });
    if (emails.length > INVITE_BATCH_MAX) {
      return sendError(res, 400, 'INVALID_INPUT', `at most ${INVITE_BATCH_MAX} addresses per request`, { field: 'emails' });
    }
    const badEmails = emails.filter((e) => e.length > 254 || !INVITE_EMAIL.test(e));
    if (badEmails.length) {
      return sendError(res, 400, 'INVALID_INPUT', `not email addresses: ${badEmails.slice(0, 5).join(', ')}`, { field: 'emails' });
    }
    if (body.passwordSetup !== undefined && typeof body.passwordSetup !== 'boolean') {
      return sendError(res, 400, 'INVALID_INPUT', 'passwordSetup must be true or false', { field: 'passwordSetup' });
    }

    let groups: string[] = [];
    if (body.groups !== undefined && body.groups !== null) {
      if (!Array.isArray(body.groups) || !body.groups.every((g): g is string => typeof g === 'string')) {
        return sendError(res, 400, 'INVALID_INPUT', 'groups must be an array of local group names', { field: 'groups' });
      }
      groups = [...new Set(body.groups.map((g) => g.trim()).filter(Boolean))];
      if (groups.length > INVITE_GROUPS_MAX) {
        return sendError(res, 400, 'INVALID_INPUT', `at most ${INVITE_GROUPS_MAX} groups per invitation`, { field: 'groups' });
      }
      const badGroups = groups.filter((g) => !LOCAL_GROUP_NAME.test(g));
      if (badGroups.length) {
        return sendError(res, 400, 'INVALID_INPUT', `group names must be slugs (letters, digits, . _ -), 64 characters at most: ${badGroups.join(', ')}`, { field: 'groups' });
      }
    }
    const refusal = await inviteGroupsRefusal(actor, groups);
    if (refusal) return sendError(res, refusal.status, refusal.code, refusal.message, refusal.field ? { field: refusal.field } : undefined);

    const expiry = parseInviteExpiry(body.expiresAt);
    if ('error' in expiry) return sendError(res, 400, 'INVALID_INPUT', expiry.error, { field: 'expiresAt' });
    const expiresAt = expiry.at;

    const createdAt = new Date().toISOString();
    type Applied = { email: string; status: 'applied' | 'already' | 'refused'; reason?: string; userIds: string[]; groups: string[]; created: false };
    const out: Array<(InvitationWire & { created: boolean }) | Applied> = [];
    // policy.invites governs every invitation that lets a new person sign in,
    // this route's included: `issueInvitation` applies the `allow` tier and
    // the domain list to each address that gets an invitation. Giving groups
    // to an account that already exists is not inviting, so they do not
    // apply to that branch, and an account that holds an address asked
    // without groups needs nothing at all ('already', plans/75 A5).
    for (const email of emails) {
      const refuse = (reason: string): Applied => ({ email, status: 'refused', reason, userIds: [], groups, created: false });
      // An address that already has an account gets the groups now instead of
      // an invitation (plans/74), under every check above. Not your own
      // account, not a disabled one, and an owner's only by an owner, the
      // same lines the People view's disable and revoke routes hold. Only an
      // account that has shown it holds the address takes them
      // (`accountsHoldingEmail`); one that merely claims it gets an
      // invitation, which a verified sign-in has to accept.
      const { holders, claimed } = groups.length ? await accountsHoldingEmail(email) : { holders: [], claimed: [] };
      const named = [...holders, ...claimed];
      if (holders.length) {
        if (named.some((a) => a.id === actor.id)) { out.push(refuse('self')); continue; }
        if (named.some((a) => a.disabledAt)) { out.push(refuse('account-disabled')); continue; }
        if (actor.role !== 'owner' && named.some((a) => a.role === 'owner')) { out.push(refuse('owner-only')); continue; }
        const accounts = holders;
        const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
        for (const name of groups.filter((g) => !registry.has(g))) await store.putLocalGroup({ name, createdAt });
        for (const account of accounts) {
          const joined = groups.filter((g) => !account.localGroups.includes(g));
          if (!joined.length) continue;
          const updated = await store.setLocalGroups(account.id, [...account.localGroups, ...joined]);
          if (updated) {
            await audit(`user:${actor.id}`, 'user.local-groups', `user:${updated.id}`, { localGroups: updated.localGroups, via: 'invitation' });
          }
        }
        out.push({ email, status: 'applied', userIds: accounts.map((a) => a.id), groups, created: false });
        continue;
      }
      const issued = await issueInvitation(actor, {
        email, groups, projects: [], ...(expiresAt ? { expiresAt } : {}), createdVia: 'console', passwordSetup: body.passwordSetup === true,
      });
      if (issued.status === 'refused') { out.push(refuse(issued.reason)); continue; }
      if (issued.status === 'already-member') { out.push({ email, status: 'already', userIds: issued.userIds, groups, created: false }); continue; }
      out.push({ ...(await invitationView(issued.invitation)), created: issued.status === 'created' });
    }
    sendJson(res, out.some((r) => r.created) ? 201 : 200, { invitations: out, ...invitationContext() });
  });

  // New link (invite spec R13): every link copied for this invitation before,
  // the console's and each project's alike, stops working. Only while it is
  // pending; an invitation that ended is invited again instead.
  router.add('POST', '/api/v1/invitations/:id/link', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'user.invite');
    if (!actor) return;
    const inv = await store.getInvitation(ctx.params.id as string);
    if (!inv || inv.revokedAt) return sendError(res, 404, 'NOT_FOUND', 'no such active invitation');
    if (invitationStatus(inv) !== 'pending') {
      return sendError(res, 409, 'NOT_PENDING', 'only a pending invitation gets a new link; invite the address again instead');
    }
    const rotated = await rotateInviteLink(res, actor, inv);
    if (!rotated) return;
    sendJson(res, 200, { invitation: await invitationView(rotated) });
  });

  // Invite again (invite spec R14): a fresh invitation, with a new link, for
  // the address of one that expired or was revoked. Its groups pass the
  // checks of a new invitation, asked again now; its projects keep the
  // people who put them there, whose standing acceptance asks again. An
  // expired invitation ends in the same step, so its links stop working.
  // Without `expiresAt` the new one ends after `policy.invites.maxTtlHours`,
  // or never when the old one never did.
  router.add('POST', '/api/v1/invitations/:id/reinvite', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'user.invite');
    if (!actor) return;
    const old = await store.getInvitation(ctx.params.id as string);
    if (!old) return sendError(res, 404, 'NOT_FOUND', 'no such invitation');
    const was = invitationStatus(old);
    if (was !== 'expired' && was !== 'revoked') {
      return sendError(res, 409, 'NOT_ENDED', 'only an invitation that expired or was revoked can be invited again');
    }
    const body = (await readJson(req)) as { expiresAt?: unknown } | null;
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    const expiry = parseInviteExpiry(body?.expiresAt);
    if ('error' in expiry) return sendError(res, 400, 'INVALID_INPUT', expiry.error, { field: 'expiresAt' });
    const active = await store.findActiveInvitation(old.email);
    if (active && invitationStatus(active) !== 'expired') {
      return sendError(res, 409, 'ACTIVE_INVITATION', 'this address already has an invitation', { invitation: await invitationView(active) });
    }
    const refusal = await inviteGroupsRefusal(actor, old.groups);
    if (refusal) return sendError(res, refusal.status, refusal.code, refusal.message, refusal.field ? { field: refusal.field } : undefined);
    const ttlHours = resolveInvitePolicy(config.policy.invites).maxTtlHours;
    const expiresAt = expiry.at ?? (old.expiresAt ? new Date(Date.now() + ttlHours * 3_600_000).toISOString() : undefined);
    // An entry with no inviter of its own was the old invitation's inviter's;
    // naming them keeps acceptance asking about the same person.
    const projects = (old.projects ?? []).map((p) => ({ ...p, invitedBy: p.invitedBy ?? old.invitedBy }));
    const issued = await issueInvitation(actor, {
      email: old.email, groups: old.groups, projects, ...(expiresAt ? { expiresAt } : {}),
      createdVia: old.createdVia ?? 'console', passwordSetup: old.passwordSetup === true, reinviteOf: old.id,
    });
    if (issued.status === 'existing') {
      return sendError(res, 409, 'ACTIVE_INVITATION', 'this address already has an invitation', { invitation: await invitationView(issued.invitation) });
    }
    if (issued.status === 'already-member') {
      return sendError(res, 409, 'ALREADY_MEMBER', 'an account already holds this address, so it needs no invitation', { userIds: issued.userIds });
    }
    if (issued.status === 'refused') {
      const refused: Record<IssueRefusal, [number, string, string]> = {
        'invites-not-allowed': [403, 'FORBIDDEN', 'your role cannot invite new people here'],
        'domain-not-allowed': [403, 'DOMAIN_NOT_ALLOWED', 'this instance does not invite addresses at this domain'],
        'invitations-off': [409, 'INVITATIONS_OFF', 'sign-in reads no invitations on this instance (idp.admission.invitations is false)'],
        'account-disabled': [409, 'ACCOUNT_DISABLED', 'this address belongs to a disabled account; re-enable it first'],
        'invitation-changed': [409, 'INVITATION_CHANGED', 'the invitation changed meanwhile; try again'],
      };
      const [status, code, message] = refused[issued.reason];
      return sendError(res, status, code, message);
    }
    sendJson(res, 201, { invitation: await invitationView(issued.invitation) });
  });

  router.add('DELETE', '/api/v1/invitations/:id', async (req, res, ctx) => {
    const actor = await requireAction(req, res, 'user.invite');
    if (!actor) return;
    const existing = await store.getInvitation(ctx.params.id as string);
    if (!existing || existing.revokedAt) return sendError(res, 404, 'NOT_FOUND', 'no such active invitation');
    // Revoking an accepted invitation can block that person's next sign-in, so
    // an owner's stays owner-only, like disabling an owner.
    if (existing.acceptedUserId && actor.role !== 'owner') {
      const invitee = await store.getUser(existing.acceptedUserId);
      if (invitee?.role === 'owner') return sendError(res, 403, 'OWNER_ONLY', "only an owner can revoke an owner's invitation");
    }
    const revoked = await store.revokeInvitation(existing.id, new Date().toISOString());
    if (!revoked) return sendError(res, 404, 'NOT_FOUND', 'no such active invitation');
    await audit(`user:${actor.id}`, 'invite.revoke', `invitation:${revoked.id}`, {
      email: revoked.email, was: invitationStatus(existing),
    });
    sendJson(res, 200, await invitationView(revoked));
  });

  // ── password sign-in links (plans/74) ──────────────────────────────────────
  // How a person gets an email and password sign-in: an admin or owner issues
  // a one-time link here and passes it on by hand (nothing is emailed). The
  // link opens GET /api/auth/password/set. Whoever holds it can set the
  // password for the address and so sign in as that address, which is why
  // this takes a person's session (never a service token), the admin role
  // and `user.invite`, and why `passwordLinkRefusal` keeps an address that
  // leads to an owner, or to an account that signs in some other way,
  // owner-only. The same rules are asked again when the link is used.
  router.add('POST', '/api/v1/admin/password-links', async (req, res) => {
    const actor = await memberOf(req);
    if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const actorCtx = { userId: actor.id, groups: actor.groups, role: actor.role as Role };
    if (!['admin', 'owner'].includes(actor.role) || !evaluate(actorCtx, 'user.invite', ['*'], await store.listGrants())) {
      return sendError(res, 403, 'FORBIDDEN', 'an admin or owner with user.invite issues sign-in links');
    }
    if (!passwordIdp) return sendError(res, 404, 'NO_PASSWORD_SIGN_IN', 'email and password sign-in is not configured on this instance');
    const body = (await readJson(req, 4096)) as { email?: unknown; purpose?: unknown } | null;
    const email = typeof body?.email === 'string' ? normaliseEmail(body.email) : '';
    if (!email || email.length > 254 || !INVITE_EMAIL.test(email)) {
      return sendError(res, 400, 'INVALID_INPUT', 'email must be an email address', { field: 'email' });
    }
    const purpose = body?.purpose;
    if (purpose !== 'setup' && purpose !== 'reset') {
      return sendError(res, 400, 'INVALID_INPUT', 'purpose must be "setup" or "reset"', { field: 'purpose' });
    }
    const refused = await passwordLinkRefusal(email, actor);
    if (refused) return sendError(res, refused.status, refused.code, refused.message, refused.code === 'NOT_ADMITTED' ? { field: 'email' } : undefined);
    const token = randomId(32);
    const now = Date.now();
    const expiresAt = new Date(now + PASSWORD_LINK_TTL_MS).toISOString();
    await store.createPasswordLink({
      tokenHash: sha256Hex(token), email, purpose, createdBy: `user:${actor.id}`, createdAt: new Date(now).toISOString(), expiresAt,
    });
    await audit(`user:${actor.id}`, 'auth.password.link.issue', 'session', { idp: passwordIdp.id, email, purpose });
    sendJson(res, 201, { url: passwordSetUrl(config.instance.baseUrl, token), expiresAt }, { 'cache-control': 'no-store' });
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
    // Webhook only (plans/35 wave 1): a broadcast forwarded to the org's own
    // endpoint (a chat channel, usually). Mailing every member would double
    // the inbox this message IS.
    notifier.event('message.sent', { id: msg.id, kind: msg.kind, severity: msg.severity, title: msg.title });
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
    chain.version = ((await store.getChain(chain.id))?.version ?? 0) + 1;
    await store.putChain(chain);
    await audit(`user:${user.id}`, 'chain.edit', `chain:${chain.id}`, { steps: chain.steps.length });
    sendJson(res, 200, chain);
  });

  router.add('POST', '/api/v1/chains/preview', async (req, res) => {
    const actor = await requireAction(req, res, 'policy.edit');
    if (!actor) return;
    const body = await readJson(req) as { id?: string } | null;
    const chain = normalizeChain(typeof body?.id === 'string' ? body.id : 'preview', body);
    if (!chain) return sendError(res, 400, 'INVALID_INPUT', 'Enter a valid chain before previewing.');
    const [users, grants] = await Promise.all([store.listUsers(), store.listGrants()]);
    const steps = chain.steps.map(step => {
      const eligible = users.filter(user => !user.disabledAt && isEligible(step, user.groups)
        && evaluate({ userId: user.id, role: user.role as Role, groups: user.groups }, 'approval.act', [`chain:${chain.id}`, '*'], grants));
      const required = typeof step.rule === 'object' ? step.rule.quorum : 1;
      const otherEligibleCount = eligible.filter(user => user.id !== actor.id).length;
      return { name: step.name, eligibleCount: eligible.length, otherEligibleCount,
        required, viable: otherEligibleCount >= required };
    });
    sendJson(res, 200, { steps, viable: steps.every(step => step.viable) }, { 'cache-control': 'no-store' });
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
    const grants = await store.listGrants();
    const subjectRef = ctx.url.searchParams.get('subjectRef') ?? '';
    const approvers = (await store.listUsers())
      .filter((u) => !u.disabledAt && u.id !== user.id && isEligible(step, u.groups)
        && evaluate({ userId: u.id, role: u.role as Role, groups: u.groups }, 'approval.act', [`chain:${chain.id}`, subjectRef, '*'], grants))
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
    if (body.nominees !== undefined && (!Array.isArray(body.nominees) || body.nominees.some(id => typeof id !== 'string' || !id))) {
      return sendError(res, 400, 'INVALID_INPUT', 'nominees must be an array of user IDs');
    }
    const nominees = Array.isArray(body.nominees) ? body.nominees.filter((n): n is string => typeof n === 'string') : [];
    const check = validateNominees(chain, 0, nominees, await userGroupsMap());
    if (!check.ok) return sendError(res, 400, 'NOMINEE_NOT_ELIGIBLE', `not eligible for the first step: ${check.ineligible.join(', ')}`);
    const [users, grants] = await Promise.all([store.listUsers(), store.listGrants()]);
    const subjectRef = typeof body.subjectRef === 'string' ? body.subjectRef.slice(0, 300) : '';
    const canReview = (candidate: typeof user) => !candidate.disabledAt && candidate.id !== user.id
      && evaluate({ userId: candidate.id, groups: candidate.groups, role: candidate.role as Role }, 'approval.act', [`chain:${chain.id}`, subjectRef, '*'], grants);
    if (nominees.some(id => !users.some(candidate => candidate.id === id && canReview(candidate)))) {
      return sendError(res, 400, 'NOMINEE_NOT_ELIGIBLE', 'Nominees must be active reviewers with approval.act permission and cannot include the requester.');
    }
    const approval = createApproval({
      id: `apr_${randomId(8)}`,
      subjectType: body.subjectType as SubjectType,
      subjectRef,
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
    // Egress (plans/35 wave 1): the step's eligible approvers plus the
    // nominees, minus the requester - the same audience the inbox targets,
    // reached where they actually are.
    const step0 = currentStep(approval);
    const reviewers = users.filter((u) => canReview(u) && (nominees.includes(u.id) || (step0 ? isEligible(step0, u.groups) : false)));
    notifier.email(reviewers.map((u) => u.email), `Approval requested: ${approval.title}`,
      `${user.email} asked for review on the “${step0?.name ?? 'first'}” step.\n\nReview it: ${config.instance.baseUrl}/admin#/approvals`);
    notifier.event('approval.requested', { id: approval.id, title: approval.title, chainId: chain.id, by: user.email });
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
      const grants = await store.listGrants();
      for (const a of await store.listApprovals({ eligibleGroups: user.groups })) {
        if (a.createdBy === user.id) continue; // separation of duties - never review your own
        if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'approval.act', [`approval:${a.id}`, `chain:${a.chainId}`, a.subjectRef, '*'], grants)) continue;
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
    if (approval.createdBy === user.id) return sendError(res, 403, 'SEPARATION_OF_DUTIES', 'A requester cannot act on their own approval.');
    if (!(await requireAction(req, res, 'approval.act', [`approval:${approval.id}`, `chain:${approval.chainId}`, approval.subjectRef, '*']))) return;
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
    const wasDomainSubject = isTerminal(next.state)
      ? (await settleAssetSubmission(next, user.id) || await settleDeliveryApproval(next, user.id))
      : false;
    if (isTerminal(next.state) && !wasDomainSubject) {
      await store.putMessage({
        id: `msg_${randomId(8)}`,
        kind: 'approval', severity: next.state === 'approved' ? 'info' : 'action',
        audience: { users: [next.createdBy] },
        title: `Approval ${next.state}: ${next.title}`,
        body: `${displayName(user)} ${next.state} your request${comment ? `: “${comment}”` : '.'}`,
        cta: { label: 'View', url: '/admin#/approvals' },
        dismissible: true,
      });
      const creator = await store.getUser(next.createdBy);
      notifier.email([creator?.email], `Approval ${next.state}: ${next.title}`,
        `${user.email} ${next.state} your request${comment ? ` — “${comment}”` : ''}.\n\nView it: ${config.instance.baseUrl}/admin#/approvals`);
      notifier.event('approval.decided', { id: next.id, title: next.title, state: next.state, by: user.email });
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
    await settleDeliveryApproval(next, user.id);
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
        const rec = await store.getProvider(pid, { includeFragment: false });
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

  // ── the Lolly web shell's files (instance.shellDir) ─────────────────────
  // Defined ahead of the routes because two of them hand over to it: the bare
  // `/tools` gallery route (the `/tools/*` file route below also matches it) and
  // the SPA fallback registered last. Absent shellDir → null, and neither does.
  const shellDir = config.instance.shellDir;
  const serveShell = shellDir ? async (res: ServerResponse, rel: string): Promise<void> => {
    const clean = normalize(rel.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
    if (clean.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    // A path ending in a file extension is a real asset. Anything else is an SPA
    // route: a tool or a view answers the shell build's landing stub, whose head
    // carries that page's share card (shell/share-cards.ts); every other route
    // answers index.html, and the shell routes from there. Docs paths never get
    // here: serveShellDocs answers them first, from the same info/ pages.
    const asset = /\.[a-z0-9]+$/i.test(clean);
    const target = clean === '.well-known/lolly.json' ? 'info/well-known-lolly.json'
      : asset && clean ? clean : (shellStubFor(clean, (r) => existsSync(join(shellDir, r))) ?? 'index.html');
    try {
      const bytes = await readFile(join(shellDir, target));
      res.writeHead(200, {
        ...shellSecurityHeaders(rel),
        'content-type': contentType(target),
        'cache-control': asset ? 'public, max-age=300' : 'no-cache',
      });
      res.end(bytes);
    } catch {
      // Missing real asset → 404; a missing index means the shellDir is wrong.
      sendError(res, 404, 'NOT_FOUND', asset ? 'no such file' : 'shell index not found: check instance.shellDir');
    }
  } : null;

  // ── tool files (pack mount, the tool index's own per-caller visibility) ────
  // The shell fetches `/tools/<id>/<file>` from its own origin. Served from the
  // pack so the files agree with the tool index (the pack's, filtered per caller)
  // rather than with whatever profile the shell dist was built on, and so a tool
  // the caller's groups cannot see is not fetchable by URL: it answers 404, the
  // same absence the index shows. A guest may fetch the tool its link opens.
  // `tools` is a reserved prefix below, so the dist's copy is never consulted.
  router.add('GET', '/tools/*', async (req, res, ctx) => {
    // The bare `/tools` is the app's gallery route, not a tool file.
    if (!ctx.params['*'] && serveShell) return serveShell(res, 'tools');
    const user = await memberOf(req) ?? renderReader(req, brand.current()!.revision, linkVerify);
    const p = principalOf(req);
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    const rel = normalize(ctx.params['*'] ?? '').replace(/^(\.\.[/\\])+/, '');
    if (!rel || rel.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    const toolId = rel.split(/[/\\]/, 1)[0] ?? '';
    if (!/^[a-z0-9-]+$/i.test(toolId)) return sendError(res, 400, 'INVALID_INPUT', 'bad tool id');
    const guestTool = p?.kind === 'guest' && p.guest.toolId === toolId;
    if (!guestTool && !toolVisibleTo((await store.listOverlays()).get(toolId), user?.groups ?? [])) {
      return sendError(res, 404, 'NOT_FOUND', 'no such tool file');
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(config.instance.pack, 'tools', rel));
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'no such tool file');
    }
    res.writeHead(200, { 'content-type': contentType(rel), 'cache-control': 'private, no-cache' });
    res.end(bytes);
  });

  // ── catalog serving (pack mount, per-caller filtered, lifecycle-enforced) ──
  const serveCatalog: Handler = async (req, res, ctx) => {
    const user = await memberOf(req) ?? renderReader(req, brand.current()!.revision, linkVerify);
    const p = principalOf(req);
    // Share cards answer before the sign-in gate: a link unfurler never signs in.
    // A tool's card follows the tool's own visibility for this caller, so a card
    // for a tool hidden from some groups is never public; only a card every caller
    // may see is marked cacheable by shared caches. The pack's copy wins; instance
    // packs usually exclude catalog/og, so the shell build's copy serves otherwise.
    const card = publicCard(normalize(ctx.params['*'] ?? ''));
    if (card) {
      let everyone = true;
      if (card.kind === 'tool') {
        const overlays = await store.listOverlays();
        const caller = { overlays, groups: user?.groups ?? [], ...(p?.kind === 'guest' ? { guestToolId: p.guest.toolId } : {}) };
        if (!callerCanSeeTool(caller, card.toolId)) return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
        everyone = toolVisibleTo(overlays.get(card.toolId), []);
      }
      for (const root of [config.instance.pack, ...(shellDir ? [shellDir] : [])]) {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(root, 'catalog', card.rel));
        } catch {
          continue;
        }
        res.writeHead(200, {
          'content-type': contentType(card.rel),
          'cache-control': everyone ? 'public, max-age=3600' : 'private, no-cache',
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
        return;
      }
      return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
    }
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    let rel = normalize(ctx.params['*'] ?? '').replace(/^(\.\.[/\\])+/, '');
    if (rel.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    // After the exit's cutover, an old ext/* blob URL (baked into already-rendered
    // SVGs and live sessions) resolves through a persistent alias to the new
    // inst/* path - nothing that referenced the federated identity breaks (plans/27 §5).
    // An aliased request may carry the `?v=<entry version>` an ext/* tile URL
    // adds for caching; that is not an instance version number, so the inst
    // branch below ignores a `v` it cannot read on an aliased request.
    let aliasedFromExt = false;
    if (rel.startsWith('ext/')) {
      const aliased = await store.getAlias(rel);
      if (aliased) {
        rel = aliased;
        aliasedFromExt = true;
      }
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
      const askedVersion = ctx.url.searchParams.get('v');
      const wantedVersion = aliasedFromExt && askedVersion !== null && !/^[1-9]\d*$/.test(askedVersion) ? null : askedVersion;
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
      const rec = await store.getProvider(providerId, { includeFragment: false });
      if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
      if (!rec.enabled) return sendError(res, 410, 'PROVIDER_DISABLED', 'this provider is disabled');
      if (!callerSeesProvider(rec, user?.groups ?? [])) return sendError(res, 403, 'FORBIDDEN', 'not visible to your groups');
      const assetId = extAssetId(providerId, remoteId);
      const filePreview = ctx.url.searchParams.get('preview') === '1';
      const convertedPreview = ctx.url.searchParams.get('view') === '1';
      if (convertedPreview && filePreview) return sendError(res, 400, 'INVALID_INPUT', 'choose one preview representation');

      // The local row combined with any upstream availability window imported
      // from the DAM (plans/27 §2), read off the in-process fragment beside the
      // lifecycle row. Upstream expiry blocks bytes even under onExpiry:'warn' -
      // that only ever softens a purely-local expiry.
      if ((await catalogBytesGate(assetId, true)).blocked) {
        return sendError(res, 410, 'ASSET_EXPIRED', 'this asset is no longer available');
      }
      if (convertedPreview && !renderWorker) return sendError(res, 501, 'PREVIEW_UNAVAILABLE', 'This instance has no preview service.');
      // hold-implies-pin (plans/27 §3, §5): when this asset's bytes have been
      // materialized into the instance's own store, prefer the local copy - the
      // federated identity stays, but the bytes survive upstream deletion.
      const pinned = await store.getInstanceAsset(materializedIdFor(providerId, remoteId));
      if (pinned && !filePreview && !convertedPreview) {
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
      // The fragment entry names this file's format and the entry version.
      // The version keys the byte cache and the ETag, so a change in the DAM
      // is a miss. The browser keeps the bytes for five minutes and then asks
      // again, which the ETag answers with a 304: provider bytes sit behind
      // access checks, so a person who loses access must not keep a cached copy
      // that stays valid for longer (plan 80 D6).
      const fragEntry = await federation.entry(assetId);
      const entryVersion = typeof fragEntry?.version === 'string' && fragEntry.version ? fragEntry.version : '';
      const fileEntry = fragEntry?.formats?.find((f) => f.url === `/catalog/${assetId}/${formatRef}`);
      const declaredSvg = !filePreview && (fileEntry?.format === 'svg' || /\.svg$/i.test(typeof fileEntry?.filename === 'string' ? fileEntry.filename : ''));
      const cacheKey = entryVersion && !convertedPreview
        ? extCacheKey({ provider: providerId, remoteId, formatRef, preview: filePreview, version: entryVersion })
        : '';
      const etag = cacheKey ? `"x${sha256Hex(cacheKey).slice(0, 32)}"` : '';
      const bytesCache = 'private, max-age=300';
      if (etag && etagMatches(req, etag)) {
        res.writeHead(304, { etag, 'cache-control': bytesCache });
        res.end();
        return;
      }
      const cached = cacheKey ? extCache.get(cacheKey) : undefined;
      if (cached) {
        res.writeHead(200, {
          'content-type': cached.contentType, ...INERT_BYTES,
          'cache-control': bytesCache, etag, 'content-length': String(cached.bytes.length),
        });
        res.end(cached.bytes);
        return;
      }
      try {
        const driver = federation.instantiate(rec);
        if (filePreview && !driver.resolveFilePreview) return sendError(res, 404, 'NOT_FOUND', 'this provider has no file preview');
        const blob = filePreview ? await driver.resolveFilePreview!(remoteId, formatRef) : await driver.resolveBlob(remoteId, formatRef);
        if (convertedPreview) {
          if (blob.kind !== 'stream') return sendError(res, 422, 'PREVIEW_UNAVAILABLE', 'This source does not support conversion previews.');
          const controller = new AbortController(); const disconnected = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', disconnected);
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
            const bytes = await readPreviewInput(blob.body, signal);
            const output = await createFilePreview(renderWorker!, bytes, signal);
            const currentUser = await requireAction(req, res, 'catalog.read'); if (!currentUser) return;
            const currentProvider = await store.getProvider(providerId, { includeFragment: false });
            if (!currentProvider?.enabled || !callerSeesProvider(currentProvider, currentUser.groups) || (await catalogBytesGate(assetId, true)).blocked) return sendError(res, 410, 'ASSET_EXPIRED', 'This asset is no longer available.');
            res.writeHead(200, { 'content-type': 'application/pdf', ...INERT_BYTES, 'cache-control': 'private, no-store', 'content-length': String(output.length) }); res.end(output); return;
          } finally { res.removeListener('close', disconnected); }
        }
        if (blob.kind === 'redirect') {
          res.writeHead(302, { location: blob.url, 'cache-control': 'private, no-store' });
          res.end();
          return;
        }
        // A DAM often labels an SVG as a generic download. Naming the file for
        // what the fragment says lets an <img> draw the SVG; INERT_BYTES keeps
        // the bytes script-free and sandboxed when opened directly.
        const servedType = declaredSvg ? 'image/svg+xml' : blob.contentType;
        res.writeHead(200, {
          'content-type': servedType,
          ...INERT_BYTES,
          'cache-control': bytesCache,
          ...(etag ? { etag } : {}),
          ...(blob.size !== undefined ? { 'content-length': String(blob.size) } : {}),
        });
        const body = Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream<Uint8Array>);
        if (cacheKey) body.pipe(extCache.tee(cacheKey, servedType)).pipe(res);
        else body.pipe(res);
      } catch {
        return sendError(res, 502, 'PROVIDER_UNAVAILABLE', 'the upstream provider did not return this asset');
      }
      return;
    }
    // The tool index and, when a signing key is configured, its signature come
    // from ONE producer per caller (catalog/signing.ts), so the envelope's
    // indexHash is always the hash of the bytes this same caller receives.
    // Without a key the pack's build-time signature is never served (see below).
    if (rel === CATALOG_INDEX_REL || (catalogSigning && rel === CATALOG_SIG_REL)) {
      const served = await servedToolIndexBytes(config.instance.pack, {
        overlays: await store.listOverlays(), groups: user?.groups ?? [],
        ...(p?.kind === 'guest' ? { guestToolId: p.guest.toolId } : {}),
      });
      if (!served) return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
      if (rel === CATALOG_SIG_REL && catalogSigning) {
        let envelope: Buffer;
        try {
          envelope = await catalogSigning.envelopeFor(config.instance.pack, served);
        } catch {
          return sendError(res, 503, 'CATALOG_SIGNING_UNAVAILABLE', 'the catalog signature could not be produced; see the server log');
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache' });
        res.end(envelope);
        return;
      }
      res.writeHead(200, {
        'content-type': served.json ? 'application/json; charset=utf-8' : contentType(rel),
        'cache-control': 'private, no-cache',
      });
      res.end(served.bytes);
      return;
    }
    // Other files that name tools (the slim index, the pack's build-time
    // signature, preview art, social cards and their manifests) follow the same
    // per-caller visibility, so a hidden tool's id never reaches a caller through
    // them either (catalog/tool-sidecars.ts).
    if (isToolKeyedCatalogPath(rel)) {
      const decided = await servedToolSidecar(config.instance.pack, rel, {
        overlays: await store.listOverlays(), groups: user?.groups ?? [],
        ...(p?.kind === 'guest' ? { guestToolId: p.guest.toolId } : {}),
      });
      if (decided.kind === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
      if (decided.kind === 'json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache' });
        res.end(decided.bytes);
        return;
      }
    }
    // The asset feed: composed per caller from the pack, federated sources,
    // instance assets and every governance overlay, memoised until an input
    // changes (catalog/served-index.ts). The ETag lets an unchanged feed cost
    // a 304; `no-cache` keeps every client revalidating. `?paged=1` leaves
    // large providers out for the paged browse route to serve instead.
    if (rel === 'assets/index.json') {
      await providersReady;
      const served = await servedIndex.forCaller({ groups: user?.groups ?? [], paged: ctx.url.searchParams.get('paged') === '1' });
      if (served.status === 'missing') return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
      if (etagMatches(req, served.etag)) {
        res.writeHead(304, { etag: served.etag, 'cache-control': 'private, no-cache' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': served.status === 'composed' ? 'application/json; charset=utf-8' : contentType(rel),
        'cache-control': 'private, no-cache', etag: served.etag,
      });
      res.end(served.bytes);
      return;
    }
    const filePath = join(config.instance.pack, 'catalog', rel);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      return sendError(res, 404, 'NOT_FOUND', 'no such catalog file');
    }
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
    res.writeHead(200, {
      'content-type': contentType(rel), 'cache-control': 'private, no-cache',
      ...(req.method === 'HEAD' ? { 'content-length': String(bytes.length) } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  router.add('GET', '/catalog/*', serveCatalog);
  // Font availability probes follow the same admission and lifecycle gates as GET.
  router.add('HEAD', '/catalog/fonts/*', async (req, res, ctx) => {
    const rel = ctx.params['*'] ?? '';
    if (rel.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
    await serveCatalog(req, res, { ...ctx, params: { '*': `fonts/${rel}` } });
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
      const rec = await store.getProvider(providerId, { includeFragment: false });
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
      const rec = await store.getProvider(providerId, { includeFragment: false });
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
    const chrome = await brandChrome.public();
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
  // ── paged asset browse (catalog/asset-browse.ts) ──────────────────────────
  // One page of the caller's feed at a time, filtered and faceted, for a
  // client that should not mirror a DAM-sized catalog. Registered before the
  // inspect wildcard below, which would otherwise match the bare path.
  router.add('GET', '/api/v1/catalog/assets', async (req, res, ctx) => {
    const user = await memberOf(req) ?? renderReader(req, brand.current()!.revision, linkVerify);
    const p = principalOf(req);
    if (config.policy.defaultAccessMode === 'gated' && !user && p?.kind !== 'guest') {
      return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    }
    const query = parseBrowseQuery(ctx.url.searchParams);
    if ('error' in query) return sendError(res, 400, 'INVALID_INPUT', query.error);
    await providersReady;
    const served = await servedIndex.forCaller({ groups: user?.groups ?? [] });
    const etag = `"b${sha256Hex(`${served.version}\n${normalisedQuery(query)}`).slice(0, 32)}"`;
    if (etagMatches(req, etag)) {
      res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
      res.end();
      return;
    }
    const metaById = query.q ? new Map((await store.listAssetMeta()).map((m) => [m.assetId, m])) : new Map();
    sendJson(res, 200, browseAssets(served, query, metaById), { 'cache-control': 'private, no-cache', etag });
  });

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

  // ── hidden tags (plan 299, catalog/tag-rules.ts) ──────────────────────────
  // Hiding the instance-wide list is `policy.edit`, the gate the field
  // definitions use, because it is how the org's taxonomy reads. One
  // provider's list is `catalog.provider.manage`, the gate the rest of that
  // provider's mapping already has. Either right opens the census.
  const tagRightsOf = async (user: UserRecord): Promise<{ instance: boolean; providers: boolean }> => {
    const grants = await store.listGrants();
    const pctx = { userId: user.id, groups: user.groups, role: user.role as Role };
    return {
      instance: evaluate(pctx, 'policy.edit', ['*'], grants),
      providers: evaluate(pctx, 'catalog.provider.manage', ['*'], grants),
    };
  };

  /**
   * Every label the catalog carries, counted per source and UNHIDDEN, with the
   * rules that hide each one right now. `?provider=<id>` narrows the census to
   * one provider's entries. Counts come from what is already held - the pack
   * index, live instance assets and each provider's last synced fragment - so
   * reading the census never calls a provider.
   */
  router.add('GET', '/api/v1/catalog/tags', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const rights = await tagRightsOf(user);
    if (!rights.instance && !rights.providers) return sendError(res, 403, 'FORBIDDEN', 'hiding tags needs policy.edit or catalog.provider.manage');
    await providersReady;
    const only = (ctx.url.searchParams.get('provider') ?? '').trim();
    const providers = await store.listProviders({ includeFragment: false });
    if (only && !providers.some((p) => p.id === only)) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    const inputs: CensusInput[] = [];
    if (!only) {
      try {
        const pack = JSON.parse(await readFile(join(config.instance.pack, 'catalog', 'assets', 'index.json'), 'utf8')) as AssetIndex;
        inputs.push({ source: 'pack', entries: pack.assets ?? [] });
      } catch { /* a federated-only instance has no pack index */ }
      const records = (await store.listInstanceAssets()).filter((r) => (r.exited || !r.origin) && submissionServable(r));
      inputs.push({ source: 'instance', entries: records.map((r) => r.entry) });
    }
    for (const { rec, fragment } of await federation.fragments()) {
      if (!only || rec.id === only) inputs.push({ source: rec.id, entries: fragment.assets });
    }
    const rules = await store.listCatalogTagRules();
    const rows = tagCensus(inputs, rules, providers);
    const LIMIT = 5000;
    sendJson(res, 200, {
      rules,
      providers: providers.map((p) => ({
        id: p.id, label: p.label, managedBy: p.managedBy, enabled: p.enabled,
        assetCount: p.state.assetCount,
        declared: Array.isArray(p.mapping.hiddenTags) ? p.mapping.hiddenTags : [],
      })),
      canEdit: rights,
      total: rows.length,
      tags: rows.slice(0, LIMIT),
      ...(rows.length > LIMIT ? { truncated: true } : {}),
    }, { 'cache-control': 'private, no-store' });
  });

  /**
   * Change one scope's hidden list. `hidden` replaces it; `hide` and `show`
   * edit it, which is what the console's per-row toggles and bulk buttons
   * send so two admins working the same list do not overwrite each other.
   * `show` removes a pattern spelled the same way, without regard to case.
   * Takes effect on the next index read: the rules are applied when the
   * index is served, so nothing re-syncs.
   */
  router.add('PUT', '/api/v1/catalog/tags/rules', async (req, res) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const scope = typeof body?.scope === 'string' ? body.scope.trim() : '';
    if (!validTagScope(scope)) return sendError(res, 400, 'INVALID_INPUT', 'scope must be * or provider:<id>');
    const rights = await tagRightsOf(user);
    if (scope === INSTANCE_SCOPE ? !rights.instance : !rights.providers) {
      return sendError(res, 403, 'FORBIDDEN', scope === INSTANCE_SCOPE ? 'needs policy.edit' : 'needs catalog.provider.manage');
    }
    await providersReady;
    if (scope !== INSTANCE_SCOPE && !(await store.getProvider(scope.slice('provider:'.length)))) {
      return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    }
    const before = (await store.listCatalogTagRules()).find((r) => r.scope === scope) ?? null;
    let wanted: unknown;
    if (body?.hidden !== undefined) {
      if (body.hide !== undefined || body.show !== undefined) return sendError(res, 400, 'INVALID_INPUT', 'send hidden, or hide and show, not both');
      wanted = body.hidden;
    } else {
      const hide = body?.hide ?? [];
      const show = body?.show ?? [];
      if (!Array.isArray(hide) || !Array.isArray(show)) return sendError(res, 400, 'INVALID_INPUT', 'hide and show must be lists of tags');
      if (!hide.length && !show.length) return sendError(res, 400, 'INVALID_INPUT', 'nothing to change');
      const drop = new Set(show.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()));
      wanted = [...(before?.hidden ?? []).filter((t) => !drop.has(t.toLowerCase())), ...hide];
    }
    const hidden = normalizeHiddenTags(wanted);
    if ('error' in hidden) return sendError(res, 400, 'INVALID_INPUT', hidden.error);
    const next: CatalogTagRule = { scope, hidden, updatedBy: `user:${user.id}`, updatedAt: new Date().toISOString() };
    if (hidden.length) await store.putCatalogTagRule(next);
    else await store.deleteCatalogTagRule(scope);
    await audit(`user:${user.id}`, 'catalog.tags.update', `catalog-tags:${scope}`, {
      before: before?.hidden ?? [], after: hidden,
    });
    sendJson(res, 200, { ok: true, rule: hidden.length ? next : { scope, hidden: [] } }, { 'cache-control': 'no-store' });
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
        const rec = await store.getProvider(pid, { includeFragment: false });
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

  // Audited agent usage uses the same disclosure permission as the audit timeline.
  router.add('GET', '/api/v1/agents/activity', async (req, res, ctx) => {
    if (!(await requireAction(req, res, 'audit.export'))) return;
    const asked = Number(ctx.url.searchParams.get('days') ?? 30);
    if (!Number.isInteger(asked) || asked < 1 || asked > 90) return sendError(res, 400, 'INVALID_INPUT', 'Choose a window from 1 to 90 days.');
    sendJson(res, 200, await agentDashboard(store, deps.agentRooms, asked), { 'cache-control': 'private, no-store' });
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
    // A template or user tool must seed a tool this pack has (plan 299). The
    // same manifest reader the policy editor uses answers it, plus the name
    // the review queue shows.
    toolLookup: async (toolId: string) => {
      const inputs = await readToolManifestInputs(toolId);
      if (!inputs) return null;
      let name: string | undefined;
      try {
        const manifest = JSON.parse(await readFile(join(config.instance.pack, 'tools', toolId, 'tool.json'), 'utf8')) as { name?: unknown };
        if (typeof manifest.name === 'string') name = manifest.name;
      } catch { /* the inputs read already proved the file is there */ }
      return { inputs: inputs.map((i) => String(i.id)), ...(name ? { name } : {}) };
    },
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
      // A template or user tool (plan 299): what it seeds, for the reviewer.
      ...(s.data ? { data: s.data } : {}),
      ...(s.collectionId ? { collectionId: s.collectionId } : {}),
      ...(s.joinedCollection ? { joinedCollection: s.joinedCollection } : {}),
      ...(s.clientRef ? { clientRef: s.clientRef } : {}),
      ...(s.note ? { note: s.note } : {}),
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
      ...(settled.collection ? { collection: settled.collection } : {}),
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
    const submitter = await store.getUser(submitterId);
    notifier.email([submitter?.email],
      settled.state === 'live'
        ? `Published: ${settled.record.entry.name ?? settled.record.id}`
        : `Returned: ${settled.record.entry.name ?? settled.record.id}`,
      (settled.state === 'live'
        ? 'Your catalog submission was approved and is live.'
        : `Your catalog submission was returned${settled.comment ? `: “${settled.comment}”` : '.'}`)
      + `\n\nView it: ${config.instance.baseUrl}/admin#/catalog`);
    notifier.event('submission.decided', { assetId: settled.record.id, state: settled.state });
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
    // A template or user tool names itself in its JSON (plan 299), so only a
    // file has to be named by the caller.
    const declaredType = (ctx.url.searchParams.get('type') ?? '').trim();
    if (!name && !target && !isDataSubmissionType(declaredType)) return sendError(res, 400, 'INVALID_INPUT', 'name query param required');
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
    const type = declaredType;
    if (type && !/^[a-z0-9-]{1,32}$/i.test(type)) return sendError(res, 400, 'INVALID_INPUT', 'type must be a short slug');
    const toolIdParam = (ctx.url.searchParams.get('toolId') ?? '').trim();
    const clientRef = (ctx.url.searchParams.get('clientRef') ?? '').trim();

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
      ...(toolIdParam ? { toolId: toolIdParam } : {}),
      ...(clientRef ? { clientRef } : {}),
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
        : outcome.code === 'SCAN_REJECTED' || outcome.code === 'INVALID_SUBMISSION' ? 422
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
    // Egress (plans/35 wave 1): a submission entering review reaches the
    // review step's approvers - the queue is only useful to people who know
    // something is in it.
    if (outcome.approval) {
      const reviewStep = currentStep(outcome.approval);
      const queueReviewers = (await store.listUsers()).filter((u) =>
        !u.disabledAt && u.id !== user.id && (reviewStep ? isEligible(reviewStep, u.groups) : false));
      const assetName = String(outcome.record.entry.name ?? outcome.record.id);
      notifier.email(queueReviewers.map((u) => u.email), `Submission to review: ${assetName}`,
        `${user.email} submitted “${assetName}” to the catalog.\n\nReview it: ${config.instance.baseUrl}/admin#/catalog`);
      notifier.event('submission.queued', { assetId: outcome.record.id, name: assetName, by: user.email });
    }
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
      type: outcome.record.entry.type ?? null,
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
    // A template or user tool keeps its kind: retyping one would serve JSON
    // to shells that expect a picture (plan 299).
    const parsed = parseDescriptivePatch(body, rec.entry, rec.submission.data ? ['name', 'description', 'tags'] : ['name', 'type', 'description', 'tags']);
    if (rec.submission.data && body.type !== undefined && body.type !== rec.entry.type) {
      return sendError(res, 400, 'INVALID_INPUT', `a ${rec.submission.data.kind} keeps its type`);
    }
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
    // The collection this asset joins once it is approved (plan 299). Choosing
    // one is curation of a named set, so it asks the collection right rather
    // than the review right, and only a collection the caller can see is a
    // choice. `null` clears an earlier choice.
    let collectionId = rec.submission.collectionId;
    if (body.collectionId !== undefined) {
      if (!(await requireAction(req, res, 'catalog.collection.manage'))) return;
      if (body.collectionId === null || body.collectionId === '') collectionId = undefined;
      else {
        const wanted = typeof body.collectionId === 'string' ? body.collectionId.trim() : '';
        const collection = wanted ? await store.getCollection(wanted) : null;
        if (!collection || !collectionVisible(collection, user.groups)) return sendError(res, 404, 'NOT_FOUND', 'no such collection');
        collectionId = collection.id;
      }
      before.collectionId = rec.submission.collectionId ?? null;
      after.collectionId = collectionId ?? null;
    }
    if (!Object.keys(after).length) return sendError(res, 400, 'INVALID_INPUT', 'nothing to change');
    const { collectionId: _prior, ...submissionRest } = rec.submission;
    const next: InstanceAssetRecord = {
      ...rec, entry: applyDescriptivePatch(rec.entry, parsed),
      submission: { ...submissionRest, ...(collectionId ? { collectionId } : {}) },
    };
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
    if (approval.createdBy === user.id) return sendError(res, 403, 'SEPARATION_OF_DUTIES', 'A requester cannot act on their own approval.');
    if (!(await requireAction(req, res, 'approval.act', [`approval:${approval.id}`, `chain:${approval.chainId}`, approval.subjectRef, '*']))) return;
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
        'overlay must be {name?, inputAccess?: {input: [{groups[], level, value?, allow?, reason?}]}, visibility?: {groups[]}, enforce?, defaults?}');
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
    // Accepts a service token (plans/35 wave 2): apply is THE CI verb, it is
    // not a personal workflow, and it action-checks every mutation below via
    // the same evaluator a session goes through.
    const user = (await memberOf(req)) ?? (await serviceAccountOf(req));
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
    guidedSetupAvailable: rec.managedBy === 'db' && !validateGuidedProvider(rec),
    credential: rec.credentialFingerprint
      ? {
          fingerprint: rec.credentialFingerprint,
          updatedAt: rec.credentialUpdatedAt ?? null,
          expiresAt: rec.credentialExpiresAt ?? null,
          // Days until the operator-stated expiry (negative = past it); null
          // when no date was stated - unknown is unknown, never zero.
          expiresInDays: rec.credentialExpiresAt
            ? Math.floor((new Date(rec.credentialExpiresAt).getTime() - Date.now()) / 86_400_000)
            : null,
        }
      : null,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    state: {
      lastSyncAt: rec.state.lastSyncAt ?? null,
      lastError: rec.state.lastError ?? null,
      assetCount: rec.state.assetCount,
      // A sync that stopped at a cap says so wherever the operator looks.
      ...(rec.state.fragment?.truncated ? { truncated: true } : {}),
      ...(rec.state.fragment?.notes?.length ? { notes: rec.state.fragment.notes } : {}),
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
    const maxAssets = (out.sync as Record<string, unknown> | undefined)?.maxAssets;
    if (maxAssets !== undefined && (typeof maxAssets !== 'number' || !Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 10_000_000)) {
      return { error: 'sync.maxAssets must be a whole number, 1-10000000' };
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

  router.add('GET', '/api/v1/catalog/providers/setup', async (req, res) => {
    if (!(await requireAction(req, res, 'catalog.provider.read'))) return;
    sendJson(res, 200, { version: 1, providers: PROVIDER_SETUPS, credentialStorageAvailable: Boolean(secrets.credential), oauth: providerOAuthInfo(config.instance.baseUrl) }, { 'cache-control': 'no-store' });
  });

  const providerSetupActor = async (req: IncomingMessage, action: string) => {
    const user = await memberOf(req);
    return user && evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, ['*'], await store.listGrants()) ? user : null;
  };
  registerProviderOAuth(router, { store, baseUrl: config.instance.baseUrl, credentialSecret: secrets.credential,
    fetchImpl: deps.fetchImpl, ready: providersReady, invalidate: id => federation.invalidate(id), audit,
    owner: req => providerSetupActor(req, 'catalog.provider.credential'), manager: req => providerSetupActor(req, 'catalog.provider.manage'),
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
    if (body?.setupVersion !== undefined) {
      const problem = body.setupVersion !== 1 ? 'unsupported setup version' : validateGuidedProvider(cfg);
      if (problem) return sendError(res, 400, 'INVALID_INPUT', problem);
    }
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
    if (body?.setupVersion !== undefined) {
      const problem = body.setupVersion !== 1 ? 'unsupported setup version' : validateGuidedProvider(cfg);
      if (problem) return sendError(res, 400, 'INVALID_INPUT', problem);
    }
    const secret = typeof body?.secret === 'string' ? body.secret : undefined;
    const now = new Date().toISOString();
    const rec: ProviderRecord = {
      id: 'preview', kind: cfg.kind, label: 'preview', managedBy: 'db', enabled: false,
      options: cfg.options ?? {}, mapping: cfg.mapping ?? {}, exposure: cfg.exposure ?? {}, sync: {},
      createdAt: now, updatedAt: now, state: { assetCount: 0 },
    };
    await audit(`user:${user.id}`, 'catalog.provider.preview', `provider-kind:${cfg.kind}`);
    if (body?.setupVersion === 1 && body.shape !== true) {
      return sendJson(res, 200, await previewGuidedProvider(rec, secret, deps.fetchImpl), { 'cache-control': 'no-store' });
    }
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
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const cfg = readProviderConfigBody(body);
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
    if (body?.setupVersion !== undefined) {
      if (rec.enabled) return sendError(res, 409, 'PROVIDER_ENABLED', 'Disable the source before changing guided settings.');
      const problem = body.setupVersion !== 1 ? 'unsupported setup version' : validateGuidedProvider(next);
      if (problem) return sendError(res, 400, 'INVALID_INPUT', problem);
    }
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
    const body = (await readJson(req)) as { secret?: string; expiresAt?: unknown } | null;
    if (typeof body?.secret !== 'string' || body.secret.length < 8) {
      return sendError(res, 400, 'INVALID_INPUT', 'secret required (min 8 chars)');
    }
    // Operator-stated expiry (plans/36 §2): the vendor's schedule, optional.
    let expiresAt: string | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
      const t = Date.parse(String(body.expiresAt));
      if (!Number.isFinite(t)) return sendError(res, 400, 'INVALID_INPUT', 'expiresAt must be a date (e.g. 2026-12-01)');
      expiresAt = new Date(t).toISOString();
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
      ...(expiresAt ? { expiresAt } : {}),
    });
    federation.invalidate(rec.id);
    invalidateAccessTokens(rec.id); // OAuth kinds: cached access tokens die with the rotated grant
    await audit(`user:${user.id}`, 'catalog.provider.credential', `provider:${rec.id}`, {
      fingerprint, rotatedFrom: rec.credentialFingerprint ?? null, ...(expiresAt ? { expiresAt } : {}),
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
    const body = (await readJson(req)) as { setupRevision?: unknown } | null;
    if (body?.setupRevision !== undefined && (typeof body.setupRevision !== 'string' || body.setupRevision !== providerSetupRevision(rec))) return sendError(res, 409, 'SETUP_CHANGED', 'Source settings or credential changed. Test the saved source again before enabling.');
    let health: { ok: boolean; detail?: string };
    try {
      health = await federation.instantiate(rec).healthCheck();
    } catch (err) {
      health = { ok: false, detail: (err as Error).message };
    }
    if (!health.ok) return sendError(res, 409, 'PROVIDER_UNHEALTHY', `cannot enable: ${health.detail ?? 'health check failed'}`);
    let toEnable = rec;
    if (body?.setupRevision !== undefined) {
      const current = await store.getProvider(rec.id);
      if (!current || providerSetupRevision(current) !== body.setupRevision) return sendError(res, 409, 'SETUP_CHANGED', 'Source changed during the health check. Test it again.');
      if (!(await providerSetupActor(req, 'catalog.provider.credential'))) return sendError(res, 403, 'FORBIDDEN', 'Your permission changed during activation.');
      toEnable = current;
    }
    await store.putProvider({ ...toEnable, enabled: true, updatedAt: new Date().toISOString() });
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
        ...(fragment.truncated ? { truncated: true } : {}),
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
      const fragment = await buildFragment(rec, federation.instantiate(rec), Date.now, { maxAssets: serving.maxProviderAssets });
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
  router.add('GET', '/api/v1/catalog/sources', async (req, res) => {
    const user = await requireAction(req, res, 'catalog.read'); if (!user) return;
    await providersReady;
    const fragments = await federation.fragments();
    // The memoised feed already holds what this caller is served, lifecycle
    // applied; the provider rows are read without their large fragments.
    const visible = (await servedIndex.forCaller({ groups: user.groups })).index;
    const sources = visibleSourceStatuses(await store.listProviders({ includeFragment: false }), fragments, user.groups, new Set((visible.assets ?? []).map(a => a.id)));
    const canManage = evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'catalog.provider.manage', ['*'], await store.listGrants());
    sendJson(res, 200, { sources, canManage, scope: user.id }, { 'cache-control': 'private, no-store' });
  });
  router.add('POST', '/api/v1/catalog/file-preview', async (req, res) => {
    if (!(await requireAction(req, res, 'catalog.read'))) return;
    if (!renderWorker) return sendError(res, 501, 'PREVIEW_UNAVAILABLE', 'This instance has no preview service.');
    const controller = new AbortController(); const disconnected = () => { if (!res.writableFinished) controller.abort(); }; res.once('close', disconnected);
    try {
      const bytes = await readRaw(req, PREVIEW_INPUT_LIMIT);
      const output = await createFilePreview(renderWorker, bytes, controller.signal);
      if (!(await requireAction(req, res, 'catalog.read'))) return;
      res.writeHead(200, { 'content-type': 'application/pdf', ...INERT_BYTES, 'cache-control': 'private, no-store', 'content-length': String(output.length) }); res.end(output);
    } catch (error) { const status = error instanceof WorkerError ? error.status : 422; sendError(res, status, 'PREVIEW_FAILED', 'This file could not be converted within the preview limits.'); }
    finally { res.removeListener('close', disconnected); }
  });

  router.add('GET', '/api/v1/catalog/search', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'catalog.read');
    if (!user) return;
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q) return sendError(res, 400, 'INVALID_INPUT', 'q required');
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    await providersReady;

    // Local pass: the caller's memoised feed (pack index + synced fragments +
    // instance assets, lifecycle-applied; catalog/served-index.ts). A pack with
    // no index still composes, so federated-only instances still search.
    const lifecycleRows = await store.listLifecycle();
    const lifecycleById = new Map(lifecycleRows.map((r) => [r.assetId, r]));
    // The overlay is loaded here too: the feed carries its fields and
    // supersession, and the haystack below folds its OCR text (which is kept
    // OFF the feed) in beside them (plans/31 section 7).
    const metas = await store.listAssetMeta();
    const metaById = new Map(metas.map((m) => [m.assetId, m]));
    const composed = (await servedIndex.forCaller({ groups: user.groups })).index;
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
    const live = (await store.listProviders({ includeFragment: false })).filter((rec) =>
      rec.enabled && callerSeesProvider(rec, user.groups));
    // Live results lose hidden tags the same way the feed's entries do.
    const tagRules = await loadTagRules(store);
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
          const entry = hideEntryTags(mapProviderAsset(rec, a), tagRules);
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

  const labelOf = (s: Pick<SessionRecord, 'meta'>): string | null =>
    typeof s.meta?.label === 'string' ? s.meta.label : null;
  const asObject = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  // A session body carries a whole tool document (a large Design document runs
  // past the router's 512 KiB default), so the two routes that write one read
  // up to 4 MiB. That stays under the 4.5 MB request limit Vercel functions
  // enforce, so the 413 comes from here with a JSON body rather than from the
  // platform. Every other route keeps the default.
  const SESSION_BODY_MAX_BYTES = 4 * 1024 * 1024;

  // Counts come from `projectSessionStats`, which never reads a session's
  // inputs: with documents up to 4 MiB each, loading every live session in the
  // instance to count them made each listing as heavy as all stored work.
  //
  // Activity (plans/74 "Collaborate tonight"): a row's `updatedAt` is the
  // newest of the project's own last change (rename, visibility, archive) and
  // its newest session save, and `updatedByName` names whoever made it. Names
  // come from one `getUsersByIds` read per listing (`namesFor`), never one
  // read per row.
  const projectActivity = (p: ProjectRecord, stats: ProjectSessionStats[]) => {
    const mine = stats.find((s) => s.projectId === p.id);
    const changed = !!p.updatedAt && p.updatedAt > p.createdAt;
    let updatedAt = changed ? p.updatedAt as string : p.createdAt;
    let updatedBy: string | null = changed ? p.updatedBy ?? null : null;
    if (mine && mine.updatedAt > updatedAt) { updatedAt = mine.updatedAt; updatedBy = mine.updatedBy ?? null; }
    return { mine, updatedAt, updatedBy };
  };
  const namesFor = async (ids: Iterable<string | null | undefined>): Promise<Map<string, string>> => {
    const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (!wanted.length) return new Map();
    // Any viewer of the project reads these, so never a name that falls back to an email.
    return new Map((await store.getUsersByIds(wanted)).map((u) => [u.id, nameWithoutEmail(u)]));
  };
  const projectRow = (p: ProjectRecord, stats: ProjectSessionStats[], myRole?: ProjectAccess, names = new Map<string, string>()) => {
    const { mine, updatedAt, updatedBy } = projectActivity(p, stats);
    return {
      id: p.id, name: p.name, visibility: p.visibility, ownerId: p.ownerId,
      sessionCount: mine?.count ?? 0, createdAt: p.createdAt, updatedAt,
      updatedByName: updatedBy ? names.get(updatedBy) ?? null : null,
      ...(myRole && myRole !== 'none' ? { myRole } : {}),
      ...(p.archivedAt ? { archivedAt: p.archivedAt } : {}),
    };
  };
  const sessionListRow = (s: SessionSummary, names = new Map<string, string>()) => ({
    id: s.id, toolId: s.toolId, toolVersion: s.toolVersion, label: labelOf(s),
    meta: s.meta, rev: s.rev, updatedBy: s.updatedBy, updatedAt: s.updatedAt,
    updatedByName: names.get(s.updatedBy) ?? null,
  });
  /** The caller's level on a project (rbac/project-access.ts): their
   *  membership row, group visibility, role and the `project.manage` lift.
   *  Every project and session route asks this one function. */
  const projectAccessOf = async (user: UserRecord, project: ProjectRecord, grants?: Grant[]): Promise<ProjectAccess> =>
    effectiveProjectAccess(user, project, await store.getProjectMember(project.id, user.id), grants ?? await store.listGrants());
  /** 403 for a caller below `min`: one message for "cannot see" (no level at
   *  all) and a READ_ONLY code for a viewer asked to write, so the shell can
   *  say which. Returns false having answered. */
  const projectAllows = (res: ServerResponse, access: ProjectAccess, min: ProjectAccess, what: string): boolean => {
    if (accessAtLeast(access, min)) return true;
    if (access === 'none') sendError(res, 403, 'FORBIDDEN', `you cannot see this ${what}`);
    else if (min === 'editor') sendError(res, 403, 'READ_ONLY', `you can view this ${what} but not change it`);
    else sendError(res, 403, 'FORBIDDEN', `you need to manage this project to do that`);
    return false;
  };
  const sessionFull = (s: SessionRecord) => ({
    id: s.id, projectId: s.projectId, toolId: s.toolId, toolVersion: s.toolVersion,
    inputs: s.inputs, meta: s.meta, label: labelOf(s), rev: s.rev,
    createdBy: s.createdBy, updatedBy: s.updatedBy, updatedAt: s.updatedAt,
    ...(s.deletedAt ? { deletedAt: s.deletedAt } : {}),
  });

  registerProjectFileRoutes(router, { config, store, blobs, memberOf, requireAction, projectAccessOf, audit });
  registerProjectFolderRoutes(router, { store, memberOf, requireAction, projectAccessOf, audit });
  registerShareRoutes(router, { config, store, memberOf, requireAction, projectAccessOf, audit });
  registerAgentRoutes(router, { store, config, blobs, memberOf, projectAccessOf, audit, origin: config.instance.baseUrl, rooms: deps.agentRooms, projectRequest: agentRequests.run });

  router.add('GET', '/api/v1/projects/:id/presence', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'viewer');
    if (!gate) return;
    const live = deps.projectPresence?.(gate.project.id) ?? [];
    const sessions: import('../collab/rooms.ts').SessionPresenceSnapshot[] = [];
    const principal = { userId: gate.user.id, groups: gate.user.groups, role: gate.user.role as Role };
    for (let i = 0; i < Math.min(live.length, 500); i += 8) {
      const rows = await Promise.all(live.slice(i, Math.min(i + 8, 500)).map(async row => {
        const session = await store.getSession(row.sessionId);
        if (!session || session.deletedAt || session.projectId !== gate.project.id || !evaluate(principal, 'session.view', [`session:${session.id}`, `project:${gate.project.id}`, '*'], gate.grants)) return null;
        return row;
      }));
      sessions.push(...rows.filter((row): row is NonNullable<typeof row> => row !== null));
    }
    sendJson(res, 200, { available: !!deps.projectPresence, updatedAt: new Date().toISOString(), sessions, truncated: live.length > 500 }, { 'cache-control': 'private, no-store' });
  });

  // GET /projects - projects visible to the caller (own + team by group; admins all).
  // Archived projects are left out unless `?archived=1`: the shell's team
  // projects list and save picker want live work only, while the console's
  // Projects view asks for everything so an archived project can be found and
  // restored.
  router.add('GET', '/api/v1/projects', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const includeArchived = ctx.url.searchParams.get('archived') === '1';
    const [all, stats, memberships, grants, states] = await Promise.all([
      store.listProjects(), store.projectSessionStats(), store.listUserProjectMemberships(user.id), store.listGrants(),
      store.listProjectUserState(user.id),
    ]);
    const mine = new Map(memberships.map((m) => [m.projectId, m]));
    const own = new Map(states.map((s) => [s.projectId, s]));
    const visible = all
      .map((p) => ({ p, role: effectiveProjectAccess(user, p, mine.get(p.id) ?? null, grants) }))
      .filter(({ p, role }) => role !== 'none' && (includeArchived || !p.archivedAt));
    const names = await namesFor(visible.map(({ p }) => projectActivity(p, stats).updatedBy));
    // `via`, `listed` and `lastOpenedAt` let the shell keep a project shared with
    // everyone out of a person's list until they choose it (lolly plan 299).
    sendJson(res, 200, { projects: visible.map(({ p, role }) => ({
      ...projectRow(p, stats, role, names), ...projectListing(user, p, mine.get(p.id) ?? null, own.get(p.id)),
    })) });
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
    sendJson(res, 201, projectRow(project, [], 'owner'));
  });

  router.add('PATCH', '/api/v1/projects/:id', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    const grants = await store.listGrants();
    // A project manager (membership), the owner, or a holder of project.manage.
    // project.manage keeps working on a project its holder cannot see, as it
    // always did here; `effectiveProjectAccess` only lifts visible ones.
    const holdsManage = evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'project.manage', ['*'], grants);
    const mayManage = holdsManage || accessAtLeast(await projectAccessOf(user, project, grants), 'manager');
    if (!mayManage) return sendError(res, 403, 'FORBIDDEN', 'owner, project manager or project.manage required');
    const body = (await readJson(req)) as { name?: string; visibility?: unknown; archived?: boolean; ownerId?: unknown } | null;
    const next: ProjectRecord = { ...project, updatedAt: new Date().toISOString(), updatedBy: user.id };
    if (typeof body?.name === 'string' && body.name.trim()) next.name = body.name.slice(0, 200);
    if (body?.visibility !== undefined) next.visibility = normalizeVisibility(body.visibility);
    if (body?.archived === true) next.archivedAt = new Date().toISOString();
    else if (body?.archived === false) delete next.archivedAt;
    // Ownership transfer (plans/36 §1) - the offboarding answer erasure was
    // missing. The new owner must be a real, enabled member: a disabled
    // account cannot receive work, and a service principal owning a project
    // would put shared work behind an automation credential.
    if (body?.ownerId !== undefined) {
      // Handing the project to someone else is the owner's call (or an
      // operator's, through project.manage), not a member manager's.
      if (project.ownerId !== user.id && !holdsManage) {
        return sendError(res, 403, 'FORBIDDEN', 'only the owner or a holder of project.manage can transfer a project');
      }
      if (typeof body.ownerId !== 'string' || !body.ownerId) return sendError(res, 400, 'INVALID_INPUT', 'ownerId must be a user id');
      const target = await store.getUser(body.ownerId);
      if (!target) return sendError(res, 404, 'NOT_FOUND', 'no such user to transfer to');
      if (target.disabledAt) return sendError(res, 409, 'OWNER_DISABLED', 'transfer to an enabled member - this account is disabled');
      if (target.id !== project.ownerId) {
        next.ownerId = target.id;
        await audit(`user:${user.id}`, 'project.transfer', `project:${next.id}`, { from: project.ownerId, to: target.id });
      }
    }
    await store.putProject(next);
    // The new owner is on the project now, so an invitation to it is done.
    if (next.ownerId !== project.ownerId) {
      const owner = await store.getUser(next.ownerId);
      if (owner) await closeMemberInvitations(next, owner, `user:${user.id}`);
    }
    await audit(`user:${user.id}`, 'project.update', `project:${next.id}`, {
      visibility: next.visibility, archived: Boolean(next.archivedAt),
    });
    const stats = await store.projectSessionStats(next.id);
    sendJson(res, 200, projectRow(next, stats, await projectAccessOf(user, next, grants),
      await namesFor([projectActivity(next, stats).updatedBy])));
  });

  // GET a project's sessions - list without inputs (cheap); requires visibility.
  router.add('GET', '/api/v1/projects/:id/sessions', async (req, res, ctx) => {
    const user = await memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    if (!projectAllows(res, await projectAccessOf(user, project), 'viewer', 'project')) return;
    const sessions = await store.listSessionSummaries(project.id);
    const names = await namesFor(sessions.map((s) => s.updatedBy));
    sendJson(res, 200, { sessions: sessions.map((s) => sessionListRow(s, names)) });
  });

  router.add('POST', '/api/v1/projects/:id/sessions', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.create');
    if (!user) return;
    const project = await store.getProject(ctx.params.id as string);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    if (!projectAllows(res, await projectAccessOf(user, project), 'editor', 'project')) return;
    const body = (await readJson(req, SESSION_BODY_MAX_BYTES)) as {
      toolId?: string; toolVersion?: string; inputs?: unknown; meta?: unknown;
    } | null;
    if (!body?.toolId || typeof body.toolId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'toolId required');
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: agentRequests.principal(req)?.creation?.sessionId ?? `ses_${randomId(8)}`,
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
    const creation = agentRequests.principal(req)?.creation;
    if (creation) {
      const result = await store.createAgentSession(session, creation.agentId, creation.requestId, creation.digest);
      if (result === 'conflict') return sendError(res, 409, 'REQUEST_CONFLICT', 'Use a new requestId when changing creation arguments.');
      if (result === 'refused') return sendError(res, 403, 'AGENT_REVOKED', 'This invitation can no longer create sessions.');
      if (result === 'replayed') return sendJson(res, 200, { id: session.id, rev: 1, replayed: true });
    } else await store.putSession(session);
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
    if (!project) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    const myRole = await projectAccessOf(user, project);
    if (!projectAllows(res, myRole, 'viewer', 'session')) return;
    if (session.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
    sendJson(res, 200, { ...sessionFull(session), myRole });
  });

  /** The newer version a 409 hands back, with the name of whoever saved it, so the
   *  shell can say "Bea saved a newer version" instead of "Someone". Never an email.
   *  `updatedByYou` says the newer save is the caller's own (another window or
   *  device): the shell only knows its sign-in subject, not this user id, so it
   *  cannot make that comparison itself. */
  const conflictCurrent = async (s: SessionRecord, callerId: string) => ({
    ...sessionFull(s),
    updatedByName: s.updatedBy ? (await namesFor([s.updatedBy])).get(s.updatedBy) ?? null : null,
    updatedByYou: !!s.updatedBy && s.updatedBy === callerId,
  });
  // PUT a session - optimistic CAS on rev. A stale rev ⇒ 409 with the current
  // server session so the client keeps its loser as a local revision (plans §3).
  // While a live room holds the session no rev can be written, so a refusal then
  // is 409 COLLAB_ACTIVE, not a revision conflict, and is not audited as one.
  router.add('PUT', '/api/v1/sessions/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.edit');
    if (!user) return;
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    if (!projectAllows(res, await projectAccessOf(user, project), 'editor', 'session')) return;
    if (session.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
    const body = (await readJson(req, SESSION_BODY_MAX_BYTES)) as { inputs?: unknown; meta?: unknown; rev?: number } | null;
    if (typeof body?.rev !== 'number') return sendError(res, 400, 'INVALID_INPUT', 'rev required for optimistic concurrency');
    if (body.rev !== session.rev) {
      if (await store.collabLeaseActive(session.id)) return sendCollabActive(res);
      // Conflicts are counted, not just refused (plans/23 §3.D): their volume on
      // shared projects is the demand instrument for plans/14 §9's collab gate.
      // Ids and revs only - an audit event never carries input values.
      await audit(`user:${user.id}`, 'session.conflict', `session:${session.id}`, { rev: session.rev, sentRev: body.rev, toolId: session.toolId });
      return sendJson(res, 409, { error: { code: 'CONFLICT', message: `session is at rev ${session.rev}, you sent ${body.rev}` }, current: await conflictCurrent(session, user.id) });
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
    //
    // A refused CAS on a session that still exists, undeleted, at the rev the
    // caller sent was refused by a room's lease, never by a revision conflict.
    // If the room let go between the CAS and the re-read, the caller's base is
    // still current, so the save is tried once more. Without that, the answer
    // would be "session is at rev 5, you sent 5".
    for (let attempt = 1; !(await store.casSession(next, body.rev)); attempt++) {
      const fresh = await store.getSession(next.id);
      if (!fresh) return sendError(res, 404, 'NOT_FOUND', 'no such session');
      if (fresh.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
      const live = await store.collabLeaseActive(fresh.id);
      if (fresh.rev === body.rev && !live && attempt === 1) continue;
      if (live || fresh.rev === body.rev) return sendCollabActive(res);
      await audit(`user:${user.id}`, 'session.conflict', `session:${fresh.id}`, { rev: fresh.rev, sentRev: body.rev, toolId: fresh.toolId });
      return sendJson(res, 409, { error: { code: 'CONFLICT', message: `session is at rev ${fresh.rev}, you sent ${body.rev}` }, current: await conflictCurrent(fresh, user.id) });
    }
    await store.appendSessionRevision({ sessionId: next.id, rev: next.rev, inputs, meta, actor: revisionActor(req, user), at: now });
    await audit(`user:${user.id}`, 'session.update', `session:${next.id}`, { rev: next.rev, projectId: next.projectId, toolId: next.toolId });
    sendJson(res, 200, sessionFull(next));
  });

  // DELETE a session - tombstone (never hard-delete) so a stale client can't
  // resurrect it. Idempotent: deleting an already-tombstoned session is a no-op 200.
  // Seeing a team project lets a member edit its sessions, but removing one is
  // narrower: the person who created it, the project's owner, or a holder of
  // project.manage. Without this, anyone in the group could delete a
  // colleague's work. Admins and owners pass through project.manage, which
  // their role grants by default, so a deny grant on it holds here exactly as
  // it does on PATCH project. Checked before the idempotent branch so a
  // refused caller gets the same 403 whether or not the session is gone.
  router.add('DELETE', '/api/v1/sessions/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'session.delete');
    if (!user) return;
    const session = await store.getSession(ctx.params.id as string);
    if (!session) return sendError(res, 404, 'NOT_FOUND', 'no such session');
    const project = await store.getProject(session.projectId);
    if (!project) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    const access = await projectAccessOf(user, project);
    if (!projectAllows(res, access, 'editor', 'session')) return;
    // Manager covers the project's owner, a manager member and a holder of
    // project.manage (`effectiveProjectAccess`).
    const mayDelete = session.createdBy === user.id || accessAtLeast(access, 'manager');
    if (!mayDelete) {
      return sendError(res, 403, 'FORBIDDEN', 'only the session creator, the project owner or a holder of project.manage can delete this session');
    }
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
    if (!project) return sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
    if (!projectAllows(res, await projectAccessOf(user, project), 'viewer', 'session')) return;
    const revisions = await store.listSessionRevisions(session.id);
    const names = await namesFor(revisions.map(revision => revision.actor));
    sendJson(res, 200, { revisions: revisions.map(revision => ({ ...revision,
      ...(names.has(revision.actor) ? { actorLabel: names.get(revision.actor) } : {}) })) });
  });

  // ── people on a project (plans/74 "Invite from inside Lolly") ─────────────
  // A project's owner, its explicit members (project_members) and the open
  // invitations that carry it. Anyone who can see the project may list the
  // people; emails, invitations and access requests are shown only to
  // managers. Adding, changing and removing people needs manager (owner,
  // manager member, or project.manage on a project they can see). Someone
  // who already has an account becomes a member at once and gets an inbox
  // message; an unknown address gets an invitation (created or extended)
  // carrying the project, within `policy.invites` (policy/invites.ts), with
  // a personal invite link for this project's entry (invite spec R17 to R20).
  const PROJECT_INVITE_BATCH_MAX = 50;
  /** How long an expired invitation stays on the people panel, so a manager
   *  can invite the address again. */
  const PROJECT_INVITE_EXPIRED_SHOWN_DAYS = 30;
  /** Addresses an hour for a caller without `user.invite` (see the route). */
  const PROJECT_INVITE_ADDRESSES_PER_HOUR = 100;
  const projectInviteQuota = createWindowQuota(PROJECT_INVITE_ADDRESSES_PER_HOUR, 3_600_000);
  const isMemberRole = (v: unknown): v is ProjectMemberRole =>
    typeof v === 'string' && (PROJECT_MEMBER_ROLES as readonly string[]).includes(v);
  // Where Lolly itself lives: `appUrl` on a split deploy, else this instance,
  // which serves the shell same-origin. The share inbox message (cta.url)
  // follows the same rule, so the link to send and the message never differ.
  const projectLink = (projectId: string): string =>
    `${(config.instance.appUrl ?? config.instance.baseUrl).replace(/\/+$/, '')}/#/team/project/${encodeURIComponent(projectId)}`;

  /** Resolve the caller, the project and their level on it, answering
   *  401/404/403 itself (returns null having answered). */
  const projectGate = async (req: IncomingMessage, res: ServerResponse, projectId: string, min: ProjectAccess) => {
    const user = await memberOf(req);
    if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const project = await store.getProject(projectId);
    if (!project) { sendError(res, 404, 'NOT_FOUND', 'no such project'); return null; }
    const grants = await store.listGrants();
    const access = await projectAccessOf(user, project, grants);
    if (!projectAllows(res, access, min, 'project')) return null;
    return { user, project, access, grants };
  };

  /**
   * Give an existing account a role on the project, or raise the one it has.
   * Never lowers a role: asking for less than someone already has is
   * 'already', and lowering is an explicit PATCH.
   *
   * The inbox message goes out only when the person was not on the project
   * (a raise is not news worth a message), and a dismissal is never cleared:
   * the message id is per (project, person), so removing and re-adding
   * someone rewrites the one row and leaves it dismissed. Sending inbox
   * messages is otherwise the admin `message.send` action, so each inviter
   * also has a daily allowance (`SHARE_MESSAGES_PER_DAY`); past it the
   * membership is still added and the audit row says the message was held.
   * `opts.message: false` sends none: an accepted invitation sends its
   * welcome instead, and an approved request its answer.
   *
   * `via` says what put the person on: a share or project invite
   * ('invite'), an accepted invitation ('invitation') or an approved access
   * request ('request'). Either way the person's open requests for this
   * project that ask for no more than they now have are superseded
   * (`closeRequestsOnAccess`), so their approvers stop seeing them.
   */
  const SHARE_MESSAGES_PER_DAY = 200;
  const shareMessageQuota = createWindowQuota(SHARE_MESSAGES_PER_DAY, 86_400_000);
  const shareProjectWith = async (
    project: ProjectRecord, target: UserRecord, role: ProjectMemberRole,
    actor: { principal: string; name: string; userId: string | null }, via: 'invite' | 'invitation' | 'request',
    opts: { message?: boolean } = {},
  ): Promise<'added' | 'already'> => {
    // 'already' closes invitations too, which tidies a row left open before
    // this rule existed the next time someone shares with the person.
    if (project.ownerId === target.id) { await closeMemberInvitations(project, target, actor.principal); return 'already'; }
    const existing = await store.getProjectMember(project.id, target.id);
    if (existing && !roleAbove(role, existing.role)) {
      await closeMemberInvitations(project, target, actor.principal);
      await closeRequestsOnAccess(accessDeps, { projectId: project.id, userId: target.id, role: existing.role }, actor.principal);
      return 'already';
    }
    const addedAt = new Date().toISOString();
    await store.putProjectMember({ projectId: project.id, userId: target.id, role, addedBy: actor.principal, addedAt });
    let messageHeld = false;
    if (!existing && target.id !== actor.userId && opts.message !== false) {
      if (shareMessageQuota.take(actor.principal)) {
        await store.putMessage(buildShareMessage({
          projectId: project.id, projectName: project.name, role, inviteeId: target.id,
          inviterName: actor.name, appBase: config.instance.appUrl ?? '', at: addedAt,
        }));
      } else {
        messageHeld = true;
      }
    }
    await audit(actor.principal, 'project.member.add', `project:${project.id}`, {
      userId: target.id, role, via, ...(existing ? { from: existing.role } : {}), ...(messageHeld ? { message: 'held' } : {}),
    });
    await closeMemberInvitations(project, target, actor.principal);
    await closeRequestsOnAccess(accessDeps, { projectId: project.id, userId: target.id, role }, actor.principal);
    return 'added';
  };

  /**
   * Someone on the project (its owner or a member) needs no invitation to
   * it, so this takes the project off any pending invitation for an address
   * the person holds (`accountsHoldingEmail`, the bar sharing itself uses).
   * A project-made invitation left with no projects and no groups is revoked
   * in the same step. Two kinds stay open with nothing left on them instead:
   * a console invitation, because whether it admits the person is an
   * admin's call (`DELETE /api/v1/invitations/:id`), and one for an account
   * with no sign-in yet (provisioned by the operator), which may be how that
   * person gets in the first time. Each change is audited under `principal`,
   * whoever put the person on the project.
   */
  const closeMemberInvitations = async (project: ProjectRecord, member: UserRecord, principal: string): Promise<void> => {
    const signIns = await store.listIdentities(member.id);
    const emails = new Set([member.email, ...signIns.map((i) => i.email ?? '')]
      .map((e) => e.trim().toLowerCase()).filter(Boolean));
    for (const email of emails) {
      const inv = await store.findActiveInvitation(email);
      if (!inv || inv.acceptedAt || !(inv.projects ?? []).some((p) => p.projectId === project.id)) continue;
      // An address the person only claims stays invited: the invitation is
      // for whoever holds the mailbox, who may be someone else.
      if (!(await accountsHoldingEmail(email)).holders.some((h) => h.id === member.id)) continue;
      const closed = await store.dropInvitationProject(inv.id, project.id, new Date().toISOString(), {
        revokeWhenEmpty: inv.createdVia === 'project' && signIns.length > 0,
      });
      if (!closed) continue; // accepted, revoked or changed in between
      const detail = { email: inv.email, projectId: project.id, userId: member.id, via: 'membership' };
      if (closed.revokedAt) await audit(principal, 'invite.revoke', `invitation:${inv.id}`, { ...detail, was: 'pending' });
      else await audit(principal, 'invite.project.remove', `invitation:${inv.id}`, detail);
    }
  };

  /**
   * The open requests for a project, as its people panel lists them (invite
   * spec R17): only those the caller may answer now (`approversFor`, asked
   * again on every read), oldest first, each with the session link it came
   * from when that session is still on the project. The approvers of a
   * project request are the same people whoever asked (a requester has
   * less than manager on the project, so is never one of them), so they are
   * worked out once.
   */
  const projectRequestsFor = async (caller: UserRecord, project: ProjectRecord): Promise<ProjectRequestWire[]> => {
    const open = (await store.listAccessRequests({ status: 'open', now: new Date().toISOString(), kinds: ['project'], projectIds: [project.id] }))
      .filter((r) => r.userId && r.projectId === project.id);
    if (!open.length || !(await approversFor(accessDeps, open[0]!)).some((u) => u.id === caller.id)) return [];
    const people = new Map((await store.getUsersByIds([...new Set(open.map((r) => r.userId!))])).map((u) => [u.id, u]));
    const out: ProjectRequestWire[] = [];
    for (const r of open) {
      const who = people.get(r.userId!);
      if (!who || who.disabledAt) continue;
      const session = r.viaSessionId ? await store.getSession(r.viaSessionId) : null;
      out.push({
        id: r.id, userId: who.id, name: nameWithoutEmail(who), email: r.email,
        role: r.role === 'editor' ? 'editor' : 'viewer', currentRole: r.currentRole ?? 'none',
        ...(r.note ? { note: r.note } : {}), createdAt: r.createdAt,
        ...(session && session.projectId === project.id && !session.deletedAt ? { viaSession: { id: session.id, name: labelOf(session) } } : {}),
      });
    }
    return out;
  };

  router.add('GET', '/api/v1/projects/:id/members', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'viewer');
    if (!gate) return;
    const { user, project, access } = gate;
    const manager = accessAtLeast(access, 'manager');
    const rows = (await store.listProjectMembers(project.id)).filter((m) => m.userId !== project.ownerId);
    const people = new Map((await store.getUsersByIds([project.ownerId, ...rows.map((m) => m.userId)])).map((u) => [u.id, u]));
    // Emails are for managers only, and so is a name that would fall back to
    // one: `displayName` returns the address for an account with no name.
    // `isMe` marks the caller's own row, so Lolly can word leaving the
    // project, or lowering your own role, as what it is.
    const person = (userId: string, role: ProjectAccess, addedAt: string) => {
      const u = people.get(userId);
      const name = u ? (manager ? displayName(u) : nameWithoutEmail(u)) : userId;
      return { userId, name, ...(manager && u ? { email: u.email } : {}), role, addedAt, ...(userId === user.id ? { isMe: true } : {}) };
    };
    const members = [person(project.ownerId, 'owner', project.createdAt), ...rows.map((m) => person(m.userId, m.role, m.addedAt))];
    // An invitation for an address someone on the project already holds is
    // not listed when accepting it would change nothing: that person is in,
    // and is shown once, as a member. Adding a member closes such
    // invitations (`closeMemberInvitations`); this covers a row left open
    // before that rule existed, and an address a member came to hold
    // without an acceptance (a linked sign-in). An invitation that would
    // still raise a holder's role stays listed, so a manager can see that
    // grant and withdraw it: acceptance at sign-in applies it.
    // Expired invitations stay listed for `PROJECT_INVITE_EXPIRED_SHOWN_DAYS`,
    // marked so, for Invite again. A pending one carries this project's
    // invite link, when it was first opened, and who put the project on it.
    const standing = new Map<string, ProjectAccess>([
      ...rows.map((m) => [m.userId, m.role] as [string, ProjectAccess]), [project.ownerId, 'owner'],
    ]);
    const nowMs = Date.now();
    const open = manager
      ? await store.listProjectInvitations(project.id, {
        now: new Date(nowMs).toISOString(), expiredSince: new Date(nowMs - PROJECT_INVITE_EXPIRED_SHOWN_DAYS * 86_400_000).toISOString(),
      })
      : [];
    const entryOf = (inv: (typeof open)[number]) => (inv.projects ?? []).find((p) => p.projectId === project.id)!;
    const roleOn = (inv: (typeof open)[number]) => entryOf(inv).role;
    const inert = await Promise.all(open.map(async (inv) => {
      const { holders } = await accountsHoldingEmail(inv.email);
      return holders.length > 0 && holders.every((h) => accessAtLeast(standing.get(h.id) ?? 'none', roleOn(inv)));
    }));
    const listed = open.filter((_, i) => !inert[i]);
    const inviterIdOf = (inv: (typeof open)[number]): string | null => {
      const by = entryOf(inv).invitedBy ?? inv.invitedBy;
      return by.startsWith('user:') ? by.slice(5) : null;
    };
    const inviters = new Map((await store.getUsersByIds([...new Set(listed.map(inviterIdOf).filter((id): id is string => !!id))])).map((u) => [u.id, u]));
    const invitations = manager
      ? listed.map((inv) => {
        const pending = invitationStatus(inv, nowMs) === 'pending';
        const inviter = inviters.get(inviterIdOf(inv) ?? '');
        return {
          id: inv.id, email: inv.email, role: roleOn(inv),
          createdAt: inv.createdAt, ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}),
          status: pending ? 'pending' as const : 'expired' as const,
          ...(inv.openedAt ? { openedAt: inv.openedAt } : {}),
          ...(inviter ? { invitedByName: nameWithoutEmail(inviter) } : {}),
          passwordSetup: inv.passwordSetup === true,
          ...(pending ? { link: inviteLink(inv, project.id) } : {}),
        };
      })
      : null;
    const requests = manager ? await projectRequestsFor(user, project) : null;
    sendJson(res, 200, {
      myRole: access, members, ...(invitations ? { invitations } : {}), ...(requests ? { requests } : {}),
    }, { 'cache-control': 'no-store' });
  });

  /** One address's answer to a project invite (R18) or an Invite again (R20).
   *  A row backed by a pending invitation carries its id, this project's
   *  invite link and its end date, so Lolly can copy an invite message. */
  type ProjectInviteResult = {
    email: string; status: 'added' | 'invited' | 'already' | 'refused'; reason?: string;
    invitationId?: string; link?: string; expiresAt?: string;
  };
  /**
   * Invite one address to a project. Only an account that has shown it holds
   * the address is shared with directly (`accountsHoldingEmail`); one that
   * merely claims it in `users.email` is treated as unknown and gets an
   * invitation, which a verified sign-in has to accept. Admission refuses
   * every row of an address when one is disabled, so sharing with it would
   * add a member who cannot sign in: a caller who sees the directory is told,
   * and anyone else gets what an unknown address gets. Everything else goes
   * through `issueInvitation`.
   */
  const inviteToProject = async (o: {
    user: UserRecord; project: ProjectRecord; email: string; role: ProjectMemberRole;
    seesDirectory: boolean; expiresAt: string; passwordSetup: boolean; reinviteOf?: string;
  }): Promise<ProjectInviteResult> => {
    const { user, project, email, role } = o;
    if (email.length > 254 || !INVITE_EMAIL.test(email)) return { email, status: 'refused', reason: 'invalid-email' };
    const { holders, claimed } = await accountsHoldingEmail(email);
    const disabled = [...holders, ...claimed].some((a) => a.disabledAt);
    if (disabled && o.seesDirectory) return { email, status: 'refused', reason: 'account-disabled' };
    if (holders.length && !disabled) {
      const actor = { principal: `user:${user.id}`, name: displayName(user), userId: user.id };
      let added = false;
      for (const account of holders) if ((await shareProjectWith(project, account, role, actor, 'invite')) === 'added') added = true;
      return { email, status: added ? 'added' : 'already' };
    }
    const entry = { projectId: project.id, role, invitedBy: `user:${user.id}` };
    const issued = await issueInvitation(user, {
      email, groups: [], projects: [entry], expiresAt: o.expiresAt, createdVia: 'project',
      passwordSetup: o.passwordSetup, accountsChecked: true, ...(o.reinviteOf ? { reinviteOf: o.reinviteOf } : {}),
    });
    if (issued.status === 'refused') return { email, status: 'refused', reason: issued.reason };
    if (issued.status === 'already-member') return { email, status: 'already' };
    const inv = issued.invitation;
    // An open invitation for the address already exists: `issueInvitation`
    // added this project to it (a higher role replaces a lower one, never the
    // other way). Its end date stays as it was, so a project invite cannot
    // prolong an invitation somebody else wrote. An accepted one has done its
    // work; the person signs in under another address, so there is nobody to
    // add. That answer says an account exists, so a caller without
    // `user.invite` gets the plain 'unavailable' instead.
    if (inv.acceptedAt) return { email, status: 'refused', reason: o.seesDirectory ? 'invitation-accepted' : 'unavailable' };
    const linked = invitationStatus(inv) === 'pending'
      ? { invitationId: inv.id, link: inviteLink(inv, project.id), ...(inv.expiresAt ? { expiresAt: inv.expiresAt } : {}) }
      : {};
    return { email, status: issued.status === 'created' || issued.extended ? 'invited' : 'already', ...linked };
  };
  /** What Lolly needs to write an invite message from this inviter (R18). */
  const inviteMessageContext = (inviter: UserRecord) => ({
    workspace: config.instance.name, inviter: nameWithoutEmail(inviter), providers: inviteProviders(),
    ...(config.instance.inviteNote ? { note: config.instance.inviteNote } : {}),
  });

  router.add('POST', '/api/v1/projects/:id/invite', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'manager');
    if (!gate) return;
    const { user, project, grants } = gate;
    if (project.archivedAt) return sendError(res, 409, 'PROJECT_ARCHIVED', 'restore the project before inviting people to it');
    const body = (await readJson(req)) as { emails?: unknown; role?: unknown; passwordSetup?: unknown } | null;
    if (!isMemberRole(body?.role)) {
      return sendError(res, 400, 'INVALID_INPUT', 'role must be viewer, editor or manager', { field: 'role' });
    }
    const role = body.role;
    const policy = resolveInvitePolicy(config.policy.invites);
    if (!policy.projectRoles.includes(role)) {
      return sendError(res, 403, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${role} role by invitation`, { field: 'role' });
    }
    if (!Array.isArray(body.emails) || body.emails.length === 0 || !body.emails.every((e): e is string => typeof e === 'string')) {
      return sendError(res, 400, 'INVALID_INPUT', 'emails must be a non-empty array of email addresses', { field: 'emails' });
    }
    if (body.passwordSetup !== undefined && typeof body.passwordSetup !== 'boolean') {
      return sendError(res, 400, 'INVALID_INPUT', 'passwordSetup must be true or false', { field: 'passwordSetup' });
    }
    const emails = [...new Set(body.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length === 0) return sendError(res, 400, 'INVALID_INPUT', 'emails must name at least one address', { field: 'emails' });
    if (emails.length > PROJECT_INVITE_BATCH_MAX) {
      return sendError(res, 400, 'INVALID_INPUT', `at most ${PROJECT_INVITE_BATCH_MAX} addresses per request`, { field: 'emails' });
    }
    // Who already has an account here is directory knowledge: GET
    // /api/v1/users is for admins, and the collab invite route answers one
    // code so it cannot be probed. A caller without `user.invite` therefore
    // never learns from this route that an account is disabled (it is
    // handled like an unknown address), and spends an hourly allowance of
    // addresses, so the existing-account answer cannot be run over a list.
    // What sharing itself shows them (the person appears on the project) is
    // the residual, described in docs/sharing.md.
    const seesDirectory = evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'user.invite', ['*'], grants);
    if (!seesDirectory && !projectInviteQuota.take(user.id, emails.length)) {
      return sendError(res, 429, 'RATE_LIMITED', `at most ${PROJECT_INVITE_ADDRESSES_PER_HOUR} addresses an hour; try again later`);
    }
    // A link that can set a password is a credential, so the tick counts
    // only for an admin or owner with `user.invite` (`maySetPasswordFromLink`);
    // anyone else's is ignored, not refused, like a hidden form field.
    const passwordSetup = body.passwordSetup === true && maySetPasswordFromLink(config, user, grants);
    const expiresAt = new Date(Date.now() + policy.maxTtlHours * 3_600_000).toISOString();
    const results: ProjectInviteResult[] = [];
    for (const email of emails) {
      results.push(await inviteToProject({ user, project, email, role, seesDirectory, expiresAt, passwordSetup }));
    }
    sendJson(res, 200, { results, link: projectLink(project.id), message: inviteMessageContext(user) });
  });

  // New link for this project's entry on an invitation (invite spec R19).
  // The link version belongs to the invitation, so every link copied for it
  // before stops working, this project's and any other's; whoever needs one
  // copies it again. Shares the console's daily allowance per invitation.
  router.add('POST', '/api/v1/projects/:id/invitations/:invitationId/link', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'manager');
    if (!gate) return;
    const { user, project } = gate;
    const inv = await store.getInvitation(ctx.params.invitationId as string);
    if (!inv || inv.revokedAt || inv.acceptedAt || !(inv.projects ?? []).some((p) => p.projectId === project.id)) {
      return sendError(res, 404, 'NOT_FOUND', 'no such open invitation on this project');
    }
    if (invitationStatus(inv) !== 'pending') {
      return sendError(res, 409, 'NOT_PENDING', 'this invitation has expired; invite the address again instead');
    }
    const rotated = await rotateInviteLink(res, user, inv);
    if (!rotated) return;
    sendJson(res, 200, { link: inviteLink(rotated, project.id), expiresAt: rotated.expiresAt ?? null });
  });

  // Invite again from the people panel (invite spec R20): a fresh
  // invitation to this project, at the role the expired one gave, for its
  // address. Only for a manager who may invite new people (plans/75 C12),
  // within the same hourly allowance as a project invite. The expired
  // invitation ends in the same step, so its links stop working; whatever
  // else it carried (another project, groups) is not carried over, since
  // those were someone else's to give. It answers as a project invite
  // does, with one row.
  router.add('POST', '/api/v1/projects/:id/invitations/:invitationId/reinvite', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'manager');
    if (!gate) return;
    const { user, project, grants } = gate;
    if (project.archivedAt) return sendError(res, 409, 'PROJECT_ARCHIVED', 'restore the project before inviting people to it');
    const policy = resolveInvitePolicy(config.policy.invites);
    if (!mayInviteNewPeople(user, grants, policy)) {
      return sendError(res, 403, 'FORBIDDEN', 'your role cannot invite new people here; ask an admin');
    }
    const old = await store.getInvitation(ctx.params.invitationId as string);
    const entry = old && !old.revokedAt && !old.acceptedAt ? (old.projects ?? []).find((p) => p.projectId === project.id) : undefined;
    if (!old || !entry) return sendError(res, 404, 'NOT_FOUND', 'no such invitation on this project');
    if (invitationStatus(old) !== 'expired') {
      return sendError(res, 409, 'NOT_ENDED', 'only an expired invitation can be invited again');
    }
    if (!policy.projectRoles.includes(entry.role)) {
      return sendError(res, 403, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${entry.role} role by invitation`);
    }
    const seesDirectory = evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'user.invite', ['*'], grants);
    if (!seesDirectory && !projectInviteQuota.take(user.id, 1)) {
      return sendError(res, 429, 'RATE_LIMITED', `at most ${PROJECT_INVITE_ADDRESSES_PER_HOUR} addresses an hour; try again later`);
    }
    const result = await inviteToProject({
      user, project, email: old.email, role: entry.role, seesDirectory,
      expiresAt: new Date(Date.now() + policy.maxTtlHours * 3_600_000).toISOString(),
      passwordSetup: old.passwordSetup === true && maySetPasswordFromLink(config, user, grants), reinviteOf: old.id,
    });
    sendJson(res, 200, { results: [result], link: projectLink(project.id), message: inviteMessageContext(user) });
  });

  router.add('PATCH', '/api/v1/projects/:id/members/:userId', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'manager');
    if (!gate) return;
    const { user, project } = gate;
    const body = (await readJson(req)) as { role?: unknown } | null;
    if (!isMemberRole(body?.role)) return sendError(res, 400, 'INVALID_INPUT', 'role must be viewer, editor or manager', { field: 'role' });
    const role = body.role;
    if (!resolveInvitePolicy(config.policy.invites).projectRoles.includes(role)) {
      return sendError(res, 403, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${role} role`, { field: 'role' });
    }
    const targetId = ctx.params.userId as string;
    if (targetId === project.ownerId) {
      return sendError(res, 409, 'PROJECT_OWNER', 'the owner has no member role; transfer the project to change its owner');
    }
    const existing = await store.getProjectMember(project.id, targetId);
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'no such member on this project');
    if (existing.role !== role) {
      // Update only: a removal that happens between the read and this write
      // leaves no row, and the change answers 404 instead of re-adding them.
      if (!(await store.updateProjectMemberRole(project.id, targetId, role))) {
        return sendError(res, 404, 'NOT_FOUND', 'no such member on this project');
      }
      await audit(`user:${user.id}`, 'project.member.role', `project:${project.id}`, { userId: targetId, from: existing.role, to: role });
      // The person's open requests for no more than the new role are moot.
      await closeRequestsOnAccess(accessDeps, { projectId: project.id, userId: targetId, role }, `user:${user.id}`);
    }
    const target = await store.getUser(targetId);
    sendJson(res, 200, {
      userId: targetId, name: target ? displayName(target) : targetId,
      ...(target ? { email: target.email } : {}), role, addedAt: existing.addedAt,
    });
  });

  // Managers remove anyone but the owner; anyone may remove themselves (leave).
  router.add('DELETE', '/api/v1/projects/:id/members/:userId', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'viewer');
    if (!gate) return;
    const { user, project, access } = gate;
    const targetId = ctx.params.userId as string;
    if (targetId !== user.id && !projectAllows(res, access, 'manager', 'project')) return;
    if (targetId === project.ownerId) {
      return sendError(res, 409, 'PROJECT_OWNER', 'the owner cannot be removed; transfer the project first');
    }
    if (!(await store.deleteProjectMember(project.id, targetId))) return sendError(res, 404, 'NOT_FOUND', 'no such member on this project');
    await audit(`user:${user.id}`, 'project.member.remove', `project:${project.id}`, { userId: targetId, ...(targetId === user.id ? { self: true } : {}) });
    res.writeHead(204); res.end();
  });

  // Take this project off an open invitation. When the invitation was made by
  // a project invite and this project was all it still carried, it is
  // revoked too, so the address can no longer sign in through it. A console
  // invitation (`createdVia: 'console'`) only loses the project: whether it
  // admits the person is an admin's call (`DELETE /api/v1/invitations/:id`,
  // `user.invite`), never a project manager's. The revoke only takes a row
  // that is still pending, so an acceptance that comes first is kept.
  router.add('DELETE', '/api/v1/projects/:id/invitations/:invitationId', async (req, res, ctx) => {
    const gate = await projectGate(req, res, ctx.params.id as string, 'manager');
    if (!gate) return;
    const { user, project } = gate;
    const inv = await store.getInvitation(ctx.params.invitationId as string);
    if (!inv || inv.revokedAt || inv.acceptedAt || !(inv.projects ?? []).some((p) => p.projectId === project.id)) {
      return sendError(res, 404, 'NOT_FOUND', 'no such open invitation on this project');
    }
    const remaining = (inv.projects ?? []).filter((p) => p.projectId !== project.id);
    if (!remaining.length && !inv.groups.length && inv.createdVia === 'project') {
      const revoked = await store.revokeInvitation(inv.id, new Date().toISOString(), { pendingOnly: true });
      if (!revoked) return sendError(res, 404, 'NOT_FOUND', 'no such open invitation on this project');
      await audit(`user:${user.id}`, 'invite.revoke', `invitation:${inv.id}`, { email: inv.email, was: 'pending', via: 'project', projectId: project.id });
    } else {
      if (!(await store.setInvitationProjects(inv.id, remaining))) return sendError(res, 404, 'NOT_FOUND', 'no such open invitation on this project');
      await audit(`user:${user.id}`, 'invite.project.remove', `invitation:${inv.id}`, { email: inv.email, projectId: project.id });
    }
    res.writeHead(204); res.end();
  });

  // Access requests (plans/74 invite spec R6 to R12, access/routes.ts): ask
  // for a project or to edit it, your own asks, and the list, approve and
  // decline for whoever may answer. After the invitation and project regions,
  // so the closures it takes already exist.
  registerAccessRoutes(router, {
    ...accessDeps, memberOf, projectAccessOf, shareProjectWith, issueInvitation, invitationView, inviteLink,
  });
  registerProjectInviteLinks(router, {
    store, config, memberOf, projectGate, projectAccessOf, shareProjectWith, issueInvitation, audit,
    linkSecret: secrets.link, linkVerify, formToken, formTokenOk,
    readForm: async req => { const form = await readSignInBody(req); return form && !form.json ? form : null; },
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

    // Only sessions in projects the caller may edit (admins: every project).
    const candidates = await store.listSessionsFiltered(filter);
    const memberships = new Map((await store.listUserProjectMemberships(user.id)).map((m) => [m.projectId, m]));
    const projectCache = new Map<string, ProjectRecord | null>();
    const matched: SessionRecord[] = [];
    for (const s of candidates) {
      if (!projectCache.has(s.projectId)) projectCache.set(s.projectId, await store.getProject(s.projectId));
      const p = projectCache.get(s.projectId);
      if (p && accessAtLeast(effectiveProjectAccess(user, p, memberships.get(p.id) ?? null, grants), 'editor')) matched.push(s);
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
    const skipped: Array<{ sessionId: string; rev: number; reason?: 'collab-active' }> = [];
    for (const s of matched) {
      const inputs = { ...s.inputs, ...set }; // merge by EXACT input id
      const next: SessionRecord = { ...s, inputs, rev: s.rev + 1, updatedBy: user.id, updatedAt: now };
      if (!(await store.casSession(next, s.rev))) {
        // A session in a live room is skipped too, but it is not a conflict.
        // A refusal at the snapshot's own rev on a live session was the room's
        // lease even if the room has let go since (the PUT route's rule).
        const fresh = await store.getSession(s.id);
        const live = await store.collabLeaseActive(s.id) || (!!fresh && !fresh.deletedAt && fresh.rev === s.rev);
        skipped.push({ sessionId: s.id, rev: s.rev, ...(live ? { reason: 'collab-active' as const } : {}) });
        continue;
      }
      applied.push(next);
      await store.appendSessionRevision({ sessionId: next.id, rev: next.rev, inputs, meta: next.meta, actor: revisionActor(req, user), at: now });
    }
    // Bust affected render caches (reachable invalidation entry point, plans §6b).
    // The per-session rev bump also changes any future render key that folds in
    // session state; this by-tool bust drops the render plane's own cached bytes.
    for (const toolId of new Set(applied.map((s) => s.toolId))) invalidateRenderByTool(toolId);
    // `skipped` in the audit counts revision conflicts only: stats/overview folds
    // it into conflicts30d.
    const conflicts = skipped.filter((k) => !k.reason).length;
    await audit(`user:${user.id}`, 'sessions.bulk',
      filter.projectId ? `project:${filter.projectId}` : filter.toolId ? `tool:${filter.toolId}` : 'sessions:all',
      { matched: matched.length, applied: applied.length, ...(conflicts ? { skipped: conflicts } : {}),
        ...(conflicts < skipped.length ? { collabActive: skipped.length - conflicts } : {}),
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
  ): Promise<{ session: SessionRecord; project: ProjectRecord; access: ProjectAccess } | null> => {
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
    const access = project ? await projectAccessOf(user, project) : 'none';
    if (!project || access === 'none') {
      sendError(res, 403, 'FORBIDDEN', 'you cannot see this session');
      return null;
    }
    if (session.deletedAt) {
      sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
      return null;
    }
    return { session, project, access };
  };

  registerCommentRoutes(router, { config, store, memberOf, audit, sessionFor: collabSessionFor, people, roomEvents: deps.roomEvents });

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
    const [users, grants, memberships] = await Promise.all([
      store.listUsers(), store.listGrants(), store.listProjectMembers(gate.project.id),
    ]);
    const { invitees, truncated } = eligibleInvitees({
      users, grants, project: gate.project, memberships, callerId: user.id, q,
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
    // A viewer on the project watches a room; only an editor may invite, as
    // only an editor may write (plans/74).
    if (!mayEditCollab({ userId: user.id, groups: user.groups, role: user.role as Role }, grants)
      || !accessAtLeast(gate.access, 'editor')) {
      return sendError(res, 403, 'FORBIDDEN', 'collab.edit required to invite');
    }
    if (!body?.userId || typeof body.userId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'userId required');
    const invitee = (await store.listUsers()).find((u) => u.id === body.userId);
    const inviteeMembership = invitee ? await store.getProjectMember(gate.project.id, invitee.id) : null;
    // One code for "no such user", "cannot see this project", "not a member of
    // it" and "that's you": an ineligible id must not be a probe that tells you
    // which it was - the autocomplete is the only sanctioned way to learn who
    // exists, and it and this route resolve the SAME `mayJoinSession`, so a
    // 201-vs-400 difference can never answer a question the search hides.
    if (!invitee || invitee.id === user.id || !mayJoinSession(invitee, gate.project, grants, inviteeMembership)) {
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

  const automationCaller = async (req: IncomingMessage): Promise<{ user: UserRecord | null; profile: Profile; principal: string; groups: string[] } | null> => {
    const member = await memberOf(req);
    const service = member ? null : await serviceAccountOf(req);
    const user = member ?? service;
    if (!user && config.policy.defaultAccessMode === 'gated') return null;
    return {
      user,
      profile: member ? renderProfileOf(member) : {},
      principal: member ? `user:${member.id}` : service ? `service:${service.id}` : `guest:${clientIp(req, config.rateLimit.trustedProxyHops)}`,
      groups: user?.groups ?? [],
    };
  };
  const automationBody = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendError(res, 400, 'INVALID_INPUT', 'JSON object body required'); return null; }
    return body as Record<string, unknown>;
  };
  const automationMayRender = async (caller: NonNullable<Awaited<ReturnType<typeof automationCaller>>>, toolId: string): Promise<boolean> => {
    if (!caller.user) return config.policy.defaultAccessMode === 'open';
    if (!(await automationMayUse(caller, toolId))) return false;
    return evaluate({ userId: caller.user.id, groups: caller.user.groups, role: caller.user.role as Role }, 'export.server', [`tool:${toolId}`, '*'], await store.listGrants());
  };
  const automationMayUse = async (caller: NonNullable<Awaited<ReturnType<typeof automationCaller>>>, toolId: string): Promise<boolean> => {
    if (!caller.user) return config.policy.defaultAccessMode === 'open';
    const principal = { userId: caller.user.id, groups: caller.user.groups, role: caller.user.role as Role };
    const grants = await store.listGrants();
    const decision = grantDecision(principal, 'tool.use', [`tool:${toolId}`, '*'], grants);
    if (decision === 'deny') return false;
    const overlay = (await store.listOverlays()).get(toolId);
    if (!toolVisibleTo(overlay, caller.groups) && decision !== 'allow') return false;
    return evaluate(principal, 'tool.use', [`tool:${toolId}`, '*'], grants);
  };
  router.add('GET', '/api/v1/system/setup/tools/:id', async (req, res, ctx) => {
    const user = await requireAction(req, res, 'instance.config'); if (!user) return;
    const toolId = ctx.params.id!;
    const report = await setupReport();
    if (!report.pack.tools.some(tool => tool.id === toolId && tool.valid)) return sendError(res, 404, 'TOOL_UNAVAILABLE', 'Choose a compatible tool from the installed pack.');
    const caller = { user, principal: `user:${user.id}`, groups: user.groups, profile: renderProfileOf(user) };
    if (!(await automationMayRender(caller, toolId))) return sendError(res, 403, 'FORBIDDEN', 'tool.use and export.server are required for this sample.');
    const engine = await loadEngine();
    const tool = await engine.loadTool(toolId, file => readFile(join(config.instance.pack, 'tools', file), 'utf8'));
    const original = (await store.listOverlays()).get(toolId);
    const formats = report.pack.tools.find(tool => tool.id === toolId)!.serverFormats.filter(format =>
      ['svg', 'png', 'jpg'].includes(format) && (!original?.enforce?.formats || original.enforce.formats.some(value => (value === 'jpeg' ? 'jpg' : value) === format)));
    const format = ctx.url.searchParams.get('format') ?? formats[0] ?? 'svg';
    if (ctx.url.searchParams.has('format') && !formats.includes(format)) return sendError(res, 422, 'FORMAT_UNAVAILABLE', 'Choose a governed checked format for this tool.');
    const rules = await managedRuleContext(brand.current()!, toolId, format);
    const overlay = rules ? projectRuleOverlay(original, rules, user.groups) : original;
    const values = engine.buildInputModel(tool.manifest, { profile: caller.profile, initial: {} });
    const inputs = (await readToolManifestInputs(toolId) ?? []).flatMap(input => {
      const access = resolveInputAccess(overlay, String(input.id), user.groups);
      if (access.level === 'hidden') return [];
      return [{ ...input, value: access.level === 'locked' ? access.value : values.find(value => value.id === input.id)?.value,
        access: access.level, ...(access.allow ? { allow: access.allow } : {}), ...(access.reason ? { reason: access.reason } : {}) }];
    });
    const declared = tool.manifest.render as { width?: number; height?: number; unit?: string };
    const expectedDimensions = !declared.unit || declared.unit === 'px' ? {
      widthPx: declared.width ?? null, heightPx: declared.height ?? null,
    } : { widthPx: null, heightPx: null };
    sendJson(res, 200, { toolId, inputs, formats, format, expectedDimensions }, { 'cache-control': 'no-store' });
  });
  // Durable resources store identity references, never a session/token or a
  // captured permission decision. Each attempt resolves the current account.
  const currentRenderCaller = async (principal: string, request: RenderSpec) => {
    let user: UserRecord | null = null;
    let member = false;
    if (principal.startsWith('user:')) {
      user = await store.getUser(principal.slice(5));
      member = true;
    } else if (principal.startsWith('service:svc_')) {
      const id = principal.slice('service:svc_'.length);
      const token = (await store.listApiTokens()).find((t) => t.id === id && !t.revokedAt);
      if (token) user = serviceAccountFor(token);
    }
    if (!user || user.disabledAt) throw new RenderResourceError('PRINCIPAL_UNAVAILABLE', 403, 'render owner is no longer active');
    const caller = { user, principal, groups: user.groups, profile: member ? renderProfileOf(user) : {} };
    if (!(await automationMayRender(caller, request.toolId))) throw new RenderResourceError('FORBIDDEN', 403, 'tool.use and export.server are required');
    return caller;
  };
  const validateRenderRequest = async (principal: string, request: RenderSpec): Promise<void> => {
    const caller = await currentRenderCaller(principal, request);
    if (!renderCaps.formats.includes(request.format)) throw new RenderResourceError('FORMAT_UNSUPPORTED', 422, 'this deployment cannot render the requested format');
    try {
      const result = await validateVerb({ pack: config.instance.pack, profile: caller.profile }, { toolId: request.toolId, inputs: request.inputs }) as { ok: boolean };
      if (!result.ok) throw new RenderResourceError('INPUT_VALIDATION_FAILED', 422, 'inputs do not satisfy the tool schema');
    } catch (e) {
      if (e instanceof RenderResourceError) throw e;
      throw new RenderResourceError('TOOL_UNAVAILABLE', 422, 'tool could not be loaded for validation');
    }
  };
  const durableRenders = new RenderRunner({
    store, blobs,
    ...(deps.backgroundPollMs !== undefined ? { pollMs: deps.backgroundPollMs } : {}),
    execute: async (record, signal) => brand.run(async () => {
      const caller = await currentRenderCaller(record.principal, record.request);
      await validateRenderRequest(record.principal, record.request);
      signal.throwIfAborted();
      const result = await renderTool({ config, captureEvidence: true, resolveProvenance, instanceCatalogVersion, worker: renderWorker,
        signer: await getC2paSigner(), hostedResolver: hostedAssetResolverFor(caller.groups) }, {
        signal, toolId: record.request.toolId, format: record.request.format, query: queryFromInputs(record.request.inputs),
        verification: record.request.verification,
        production: record.request.production,
        principal: { groups: caller.groups }, profile: caller.profile, overlays: await store.listOverlays(),
      });
      signal.throwIfAborted();
      await currentRenderCaller(record.principal, record.request);
      return result;
    }),
  });
  registerRenderRoutes(router, {
    store, blobs,
    authenticate: async (req) => {
      const caller = await automationCaller(req);
      return caller?.user ? caller.principal : null;
    },
    authorize: async (principal, request) => { await currentRenderCaller(principal, request); },
    validate: validateRenderRequest,
    ...(deps.onRenderRunner ? { kick: () => durableRenders.kick(), cancel: (id: string) => durableRenders.cancel(id) } : {}),
    audit: async (principal, action, id, facts) => { await audit(principal, action, `${id.startsWith('rbt_') ? 'render-batch' : 'render'}:${id}`, facts); },
  });
  deps.onRenderRunner?.(durableRenders);

  const requireAutomationTools = async (
    res: ServerResponse,
    caller: NonNullable<Awaited<ReturnType<typeof automationCaller>>>,
    ...values: unknown[]
  ): Promise<boolean> => {
    const ids = new Set<string>();
    for (const value of values) {
      if (value && typeof value === 'object' && typeof (value as { toolId?: unknown }).toolId === 'string') ids.add((value as { toolId: string }).toolId);
    }
    for (const id of ids) {
      if (!(await automationMayUse(caller, id))) {
        sendError(res, 403, 'FORBIDDEN', 'tool.use required');
        return false;
      }
    }
    return true;
  };
  // Reconstruct execution from stored requests after a restart, and re-check the
  // live identity/grants. An old group's permissions are never a durable credential.
  const executeDurableAutomation = async (job: AutomationJob, signal: AbortSignal) => {
    signal.throwIfAborted();
    let user: UserRecord | null = null;
    if (job.principal.startsWith('user:')) user = await store.getUser(job.principal.slice(5));
    else if (job.principal.startsWith('service:svc_')) {
      const token = (await store.listApiTokens()).find(token => token.id === job.principal.slice(12) && !token.revokedAt);
      if (token) user = serviceAccountFor(token);
    }
    const guest = job.principal.startsWith('guest:') && config.policy.defaultAccessMode === 'open';
    if ((!user && !guest) || user?.disabledAt) throw new Error('The job principal is no longer authorized.');
    const caller = { user, profile: job.principal.startsWith('user:') && user ? renderProfileOf(user) : {}, principal: job.principal, groups: user?.groups ?? [] };
    const body = job.request;
    for (const value of [body, body.document, body.a, body.b]) {
      const id = value && typeof value === 'object' ? (value as { toolId?: unknown }).toolId : undefined;
      if (typeof id === 'string' && !await automationMayUse(caller, id)) throw new Error('tool.use is no longer granted.');
    }
    const context = { pack: config.instance.pack, profile: caller.profile, hostedResolver: hostedAssetResolverFor(caller.groups) };
    if (job.verb === 'batch') {
      if (typeof body.toolId !== 'string' || !await automationMayRender(caller, body.toolId)) throw new Error('export.server required.');
      const record = job;
      const rows = body.rows as Array<Record<string, unknown>>;
      if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new Error('Durable batches need 1–200 snapshotted rows.');
      const zip = new ZipBuilder(); const used = new Set<string>(); const chunks: Buffer[] = [];
      const manifest: { toolId: string; format: string; total: number; succeeded: number; failed: number; rows: Array<{ index: number; name?: string; error?: string }> } = { toolId: body.toolId as string, format: body.format as string, total: rows.length, succeeded: 0, failed: 0, rows: [] };
      const retries = Math.max(0, Math.min(3, Number(body.retries ?? 0) || 0));
      const concurrency = Math.max(1, Math.min(4, Math.trunc(Number(body.concurrency ?? 1) || 1)));
      const overlays = await store.listOverlays();
      const outcomes: Array<{ result?: Awaited<ReturnType<typeof renderTool>>; error?: unknown }> = new Array(rows.length);
      let retainedBytes = 0;
      let next = 0; let done = 0; let stop = false;
      record.progress = { done: 0, total: rows.length };
      const renderRows = async (): Promise<void> => {
        while (!stop) {
          signal.throwIfAborted();
          const index = next++;
          if (index >= rows.length) return;
          let result: Awaited<ReturnType<typeof renderTool>> | null = null; let error: unknown;
          for (let attempt = 0; attempt <= retries && !result; attempt++) {
            try { result = await renderTool({ config, resolveProvenance, instanceCatalogVersion, worker: renderWorker, signer: await getC2paSigner(), hostedResolver: hostedAssetResolverFor(caller.groups) }, { toolId: body.toolId as string, format: body.format as string, query: queryFromInputs(rows[index]!), principal: { groups: caller.groups }, profile: caller.profile, overlays }); }
            catch (caught) { error = caught; }
          }
          if (result) { retainedBytes += result.bytes.byteLength; if (retainedBytes > 128 * 1024 * 1024) throw new Error('Batch output exceeds 128 MB. Split the batch.'); }
          signal.throwIfAborted();
          outcomes[index] = result ? { result } : { error };
          done++;
          record.progress = { done, total: rows.length };
          await automationJobs.save(record);
          if (!result && body.keepGoing !== true) stop = true;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => renderRows()));
      if (stop) throw outcomes.find((outcome) => outcome?.error)?.error ?? new Error('batch row failed');
      for (let index = 0; index < outcomes.length; index++) {
        const { result, error } = outcomes[index] ?? {};
        if (result) {
          const name = safeEntryName(`${String(body.name ?? body.toolId)}-${index + 1}.${body.format}`, used);
          chunks.push(zip.add(name, Buffer.from(result.bytes))); manifest.succeeded++; manifest.rows.push({ index, name });
        } else {
          const message = error instanceof Error ? error.message : String(error); manifest.failed++; manifest.rows.push({ index, error: message });
        }
      }
      chunks.push(zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))));
      chunks.push(zip.end());
      return { mime: 'application/zip', bytes: Buffer.concat(chunks) };
    }
    if (job.verb === 'render') {
      if (typeof body.toolId !== 'string' || typeof body.format !== 'string' || !await automationMayRender(caller, body.toolId)) throw new Error('export.server required.');
      const rendered = await renderTool({ config, resolveProvenance, instanceCatalogVersion, worker: renderWorker, signer: await getC2paSigner(), hostedResolver: context.hostedResolver }, {
        toolId: body.toolId, format: body.format, query: queryFromInputs((body.inputs ?? {}) as Record<string, unknown>), principal: { groups: caller.groups }, profile: caller.profile, overlays: await store.listOverlays(),
      });
      signal.throwIfAborted(); return { mime: rendered.mime, bytes: rendered.bytes };
    }
    if (job.verb === 'package') {
      const document = body.document ?? (await compileVerb(context, body as unknown as Parameters<typeof compileVerb>[1]) as { document: unknown }).document;
      const packed = await packageVerb(document); signal.throwIfAborted();
      return { mime: 'application/vnd.lolly+zip', bytes: packed.bytes };
    }
    const value = job.verb === 'compile' ? await compileVerb(context, body as unknown as Parameters<typeof compileVerb>[1])
      : job.verb === 'validate' ? await validateVerb(context, body)
      : job.verb === 'diff' ? await diffVerb(body.a, body.b)
      : await documentVerb(context, job.verb as 'inspect' | 'measure' | 'optimize', body as unknown as Parameters<typeof documentVerb>[2]);
    signal.throwIfAborted(); return { mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) };
  };
  automationJobs.enableDurable(Object.fromEntries(['compile', 'validate', 'inspect', 'diff', 'measure', 'optimize', 'package', 'render', 'batch'].map(verb => [verb, executeDurableAutomation])));

  const enqueueAutomation = async (
    res: ServerResponse,
    caller: NonNullable<Awaited<ReturnType<typeof automationCaller>>>,
    verb: string,
    body: Record<string, unknown>,
    run: Parameters<AutomationQueue['create']>[3],
    idempotencyKey?: string,
  ): Promise<Awaited<ReturnType<AutomationQueue['create']>> | null> => {
    try { return await automationJobs.create(caller.principal, verb, body, run, idempotencyKey); }
    catch (e) {
      if ((e as Error).message === 'IDEMPOTENCY_KEY_REUSED') {
        sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was already used for a different request');
        return null;
      }
      throw e;
    }
  };

  router.add('GET', '/api/v1/schema/:toolId', async (req, res, ctx) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    if (!(await requireAutomationTools(res, caller, { toolId: ctx.params.toolId! }))) return;
    try { return sendJson(res, 200, await schemaVerb({ pack: config.instance.pack, profile: caller.profile }, ctx.params.toolId!)); }
    catch (e) { return sendError(res, 400, 'DOCUMENT_API_ERROR', (e as Error).message); }
  });

  for (const verb of ['compile', 'validate', 'inspect', 'diff', 'measure', 'optimize'] as const) {
    router.add('POST', `/api/v1/${verb}`, async (req, res, ctx) => {
      const caller = await automationCaller(req);
      if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
      const body = await automationBody(req, res); if (!body) return;
      if (!(await requireAutomationTools(res, caller, body, body.document, body.a, body.b))) return;
      const hostedResolver = hostedAssetResolverFor(caller.groups);
      const automationContext = { pack: config.instance.pack, profile: caller.profile, hostedResolver };
      const execute = async (): Promise<unknown> => {
        let result: unknown;
        if (verb === 'compile') result = await compileVerb(automationContext, body as unknown as Parameters<typeof compileVerb>[1]);
        else if (verb === 'validate') result = await validateVerb(automationContext, body);
        else if (verb === 'diff') result = await diffVerb(body.a, body.b);
        else result = await documentVerb(automationContext, verb, body as unknown as Parameters<typeof documentVerb>[2]);
        return result;
      };
      const wantsAsync = ctx.url.searchParams.get('async') === '1' || /respond-async/i.test(String(req.headers.prefer ?? ''));
      if (wantsAsync) {
        const queued = await enqueueAutomation(res, caller, verb, body, async () => {
          const value = await execute();
          return { mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)), value };
        }, String(req.headers['idempotency-key'] ?? '') || undefined);
        if (!queued) return;
        const { job, reused } = queued;
        return sendJson(res, reused && job.state === 'done' ? 200 : 202, jobWire(job, automationResultUrl(job)), { location: `/api/v1/jobs/${job.id}` });
      }
      try { return sendJson(res, 200, await execute()); }
      catch (e) { return sendError(res, 400, 'DOCUMENT_API_ERROR', (e as Error).message); }
    });
  }

  router.add('POST', '/api/v1/package', async (req, res, ctx) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const body = await automationBody(req, res); if (!body) return;
    if (body.document === undefined && typeof body.toolId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'document or toolId is required');
    if (!(await requireAutomationTools(res, caller, body, body.document))) return;
    const execute = async () => {
      const document = body.document ?? (await compileVerb(
        { pack: config.instance.pack, profile: caller.profile, hostedResolver: hostedAssetResolverFor(caller.groups) },
        body as unknown as Parameters<typeof compileVerb>[1],
      ) as { document: unknown }).document;
      return packageVerb(document);
    };
    const wantsAsync = ctx.url.searchParams.get('async') === '1' || /respond-async/i.test(String(req.headers.prefer ?? ''));
    if (wantsAsync) {
      const queued = await enqueueAutomation(res, caller, 'package', body, async () => {
        const packed = await execute();
        return { mime: 'application/vnd.lolly+zip', bytes: packed.bytes };
      }, String(req.headers['idempotency-key'] ?? '') || undefined);
      if (!queued) return;
      const { job, reused } = queued;
      return sendJson(res, reused && job.state === 'done' ? 200 : 202, jobWire(job, automationResultUrl(job)), { location: `/api/v1/jobs/${job.id}` });
    }
    try {
      const packed = await execute();
      res.writeHead(200, { 'content-type': 'application/vnd.lolly+zip', 'content-length': String(packed.bytes.byteLength), 'content-disposition': 'attachment; filename="document.lolly"' });
      res.end(Buffer.from(packed.bytes));
    } catch (e) { return sendError(res, 400, 'DOCUMENT_API_ERROR', (e as Error).message); }
  });

  router.add('POST', '/api/v1/render', async (req, res, ctx) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const body = await automationBody(req, res); if (!body) return;
    if (typeof body.toolId !== 'string' || typeof body.format !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'toolId and format are required');
    const toolId = body.toolId; const format = body.format;
    if (!(await automationMayRender(caller, toolId))) return sendError(res, 403, 'FORBIDDEN', 'export.server required');
    const execute = async () => {
      const result = await renderTool({ config, resolveProvenance, instanceCatalogVersion, worker: renderWorker, signer: await getC2paSigner(), hostedResolver: hostedAssetResolverFor(caller.groups) }, {
        toolId, format, query: queryFromInputs((body.inputs ?? {}) as Record<string, unknown>),
        principal: caller.user ? { groups: caller.user.groups } : { groups: [] }, profile: caller.profile,
        overlays: await store.listOverlays(),
      });
      return result;
    };
    const wantsAsync = ctx.url.searchParams.get('async') === '1' || /respond-async/i.test(String(req.headers.prefer ?? ''));
    if (wantsAsync) {
      const queued = await enqueueAutomation(res, caller, 'render', body, async () => {
        const result = await execute();
        return { mime: result.mime, bytes: result.bytes };
      }, String(req.headers['idempotency-key'] ?? '') || undefined);
      if (!queued) return;
      const { job, reused } = queued;
      return sendJson(res, reused && job.state === 'done' ? 200 : 202, jobWire(job, automationResultUrl(job)), { location: `/api/v1/jobs/${job.id}` });
    }
    try {
      const result = await execute();
      res.writeHead(200, { 'content-type': result.mime, 'x-lolly-cache-key': result.cacheKey, 'x-lolly-brand-check': result.evidence?.brandRules?.disposition ?? 'not-requested' });
      res.end(Buffer.from(result.bytes));
    } catch (e) { if (e instanceof RenderError) return sendError(res, e.status, e.code, e.message); throw e; }
  });

  router.add('POST', '/api/v1/batch', async (req, res) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const body = await automationBody(req, res); if (!body) return;
    if (typeof body.toolId !== 'string' || typeof body.format !== 'string' || (!Array.isArray(body.rows) && !body.bind)) return sendError(res, 400, 'INVALID_INPUT', 'toolId, format and rows or bind are required');
    if (!(await automationMayRender(caller, body.toolId))) return sendError(res, 403, 'FORBIDDEN', 'export.server required');
    let rows: Array<Record<string, unknown>>;
    try {
      rows = Array.isArray(body.rows)
        ? body.rows as Array<Record<string, unknown>>
        : await resolveBindingRows(body.bind as DataBinding, hostedAssetResolverFor(caller.groups));
    } catch (e) {
      return sendError(res, 400, 'DATA_BINDING_ERROR', (e as Error).message);
    }
    if (!rows.length || rows.length > 200 || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return sendError(res, 400, 'INVALID_INPUT', 'batch rows must be a non-empty array of objects');
    for (let index = 0; index < rows.length; index++) {
      const check = await validateVerb(
        { pack: config.instance.pack, profile: caller.profile, hostedResolver: hostedAssetResolverFor(caller.groups) },
        { toolId: body.toolId, inputs: rows[index] },
      ) as { ok: boolean; errors?: unknown[] };
      if (!check.ok) return sendError(res, 422, 'ROW_VALIDATION_FAILED', `batch row ${index} does not satisfy the tool input schema`, { row: index, errors: check.errors ?? [] });
    }
    const queued = await enqueueAutomation(res, caller, 'batch', { ...body, rows }, async record => {
      return executeDurableAutomation(record, new AbortController().signal);
    }, String(req.headers['idempotency-key'] ?? '') || undefined);
    if (!queued) return;
    const { job, reused } = queued;
    return sendJson(res, reused && job.state === 'done' ? 200 : 202, jobWire(job, automationResultUrl(job)), { location: `/api/v1/jobs/${job.id}` });
  });

  router.add('GET', '/api/v1/jobs', async (req, res) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    return sendJson(res, 200, { jobs: (await automationJobs.list(caller.principal)).map((job) => jobWire(job, automationResultUrl(job))) });
  });
  router.add('GET', '/api/v1/jobs/:id', async (req, res, ctx) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const job = await automationJobs.get(ctx.params.id!, caller.principal);
    return job ? sendJson(res, 200, jobWire(job, automationResultUrl(job))) : sendError(res, 404, 'NOT_FOUND', 'job not found');
  });
  router.add('GET', '/api/v1/jobs/:id/result', async (req, res, ctx) => {
    const token = ctx.url.searchParams.get('token');
    const signed = token ? verifyToken<{ jobId: string; principal: string }>('lw/job', token, linkVerify) : null;
    const caller = signed ? null : await automationCaller(req);
    if (!signed && !caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    if (signed && signed.jobId !== ctx.params.id) return sendError(res, 403, 'FORBIDDEN', 'result token does not match this job');
    const principal = signed?.principal ?? caller!.principal;
    const job = await automationJobs.get(ctx.params.id!, principal);
    if (!job) return sendError(res, 404, 'NOT_FOUND', 'job not found');
    const output = await automationJobs.result(job.id, principal);
    if (!output) return sendError(res, 409, 'JOB_NOT_DONE', 'job has not completed');
    res.writeHead(200, { 'content-type': output.mime, 'content-length': String(output.bytes.byteLength), 'cache-control': 'private, no-store' });
    res.end(Buffer.from(output.bytes));
  });

  router.add('DELETE', '/api/v1/jobs/:id', async (req, res, ctx) => {
    const caller = await automationCaller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const job = await automationJobs.get(ctx.params.id!, caller.principal);
    if (!job) return sendError(res, 404, 'NOT_FOUND', 'job not found');
    const deliveryPrincipal = caller.user ? `user:${caller.user.id}` : caller.principal;
    if (await store.findDeliveryBySourceJob(deliveryPrincipal, job.id)) {
      return sendError(res, 409, 'JOB_OUTPUT_IN_USE', 'a delivery retains this immutable job output');
    }
    if (await automationJobs.remove(job.id, caller.principal)) return sendJson(res, 200, { ok: true });
    // A delivery may have won the race after the preflight. The store-level
    // reference guard keeps the blob intact; report the real conflict.
    if (await automationJobs.get(job.id, caller.principal)) {
      return sendError(res, 409, 'JOB_OUTPUT_IN_USE', 'a delivery retains this immutable job output');
    }
    return sendError(res, 404, 'NOT_FOUND', 'job not found');
  });

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
      if (!result.evidence?.brandRules && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': result.mime, etag, 'cache-control': result.evidence?.brandRules ? 'private, no-store' : 'private, max-age=60',
        'x-lolly-brand-check': result.evidence?.brandRules?.disposition ?? 'not-requested',
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
        // A policy refusal names the input and the overlay that refused it, so an
        // agent driving the render reads the same explanation the shell puts
        // beside the control instead of asking a human what changed.
        const v = err.violations?.[0];
        return sendError(res, err.status, err.code, err.message, v
          ? { input: v.param, ...(v.by ? { by: v.by } : {}), ...(v.reason ? { reason: v.reason } : {}) }
          : undefined);
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
      const mime = contentType(clean);
      const headers = mime.startsWith('text/html') ? consoleDocumentHeaders(bytes.toString('utf8')) : CONSOLE_ASSET_HEADERS;
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache', ...headers });
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
  const brandChrome = createBrandChrome(config.instance.name, brand);
  const brandFontFile = () => brandChrome.font();
  const brandCard = async (packUrl: string | null) => brandChrome.card(packUrl, await readPackMeta());
  brandChrome.register(router);
  registerBrandRoutes(router, { brand, rules: brandRules, member: async req => (await memberOf(req)) ?? (await serviceAccountOf(req)) });

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
    let rows = filter
      ? all.filter((u) => (filter.attr === 'userName' ? u.email : u.sub) === filter.value)
      : all;
    // The IdP's subject may reach an account through a linked sign-in
    // (plans/74, "One person, many sign-ins") rather than users.sub, when the
    // account was created by another IdP. That account is the person.
    if (filter && filter.attr !== 'userName' && rows.length === 0) {
      const linked = await store.getUserByIdentity(filter.value);
      if (linked) rows = [linked];
    }
    // Bounded page: the IdP reconciles against this, it does not mirror it.
    scimJson(res, 200, scimList(rows.slice(0, SCIM_PAGE_MAX).map((u) => userToScim(u, scimBase)), rows.length));
  });
  router.add('POST', '/scim/v2/Users', async (req, res) => {
    if (!(await scimAuth(req, res))) return;
    const parsed = parseUserCreate(await readJson(req));
    if ('error' in parsed) return scimErr(res, 400, parsed.error, 'invalidValue');
    // A subject linked to an existing account is that person already: a
    // second row would take the IdP's group pushes while they sign in as
    // the first.
    if (await store.getUserBySub(parsed.sub) || await store.getUserByIdentity(parsed.sub)) {
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
  // reach public docs or the SPA fallback. Absent shellDir means these routes
  // are not added. HEAD handles only public docs, never private GET handlers.
  // serveShell is defined above the tool file routes, which also use it.
  const RESERVED_PREFIX = /^(api|catalog|tools|render|l|admin|scim|healthz|activate|connect)(\/|$)/;
  if (shellDir && serveShell) {
    const serveShellDocs = async (req: IncomingMessage, res: ServerResponse, rel: string): Promise<boolean> => {
      const doc = shellDocsPath(rel);
      if (!doc) return false;
      if (doc.kind === 'invalid') {
        sendError(res, 400, 'INVALID_INPUT', 'bad documentation path');
        return true;
      }
      try {
        const root = await realpath(shellDir);
        for (const candidate of doc.candidates) {
          let target: string;
          let metadata: Awaited<ReturnType<typeof stat>>;
          try {
            target = await realpath(resolvePath(root, candidate));
            // The signed shell may be mounted through a release symlink, but a
            // document symlink must not expose files outside that release.
            if (!target.startsWith(root + sep)) break;
            metadata = await stat(target);
          } catch { continue; }
          if (!metadata.isFile()) continue;
          if (doc.kind === 'redirect') {
            res.writeHead(308, { ...shellSecurityHeaders(rel), location: doc.location, 'cache-control': 'public, max-age=300' });
            res.end();
          } else {
            const bytes = req.method === 'HEAD' ? undefined : await readFile(target);
            res.writeHead(200, {
              ...shellSecurityHeaders(rel),
              'content-type': contentType(candidate),
              'content-length': bytes?.length ?? metadata.size,
              'cache-control': 'public, max-age=300',
            });
            res.end(bytes);
          }
          return true;
        }
      } catch { /* A missing shell mount is a missing public document. */ }
      sendError(res, 404, 'NOT_FOUND', 'no such public document');
      return true;
    };
    router.add('GET', '/info/media/agent-collaboration-review.mp4', (_req, res) => {
      res.writeHead(307, { location: '/review/agent-collaboration-review.mp4', 'cache-control': 'public, max-age=300' });
      res.end();
    });
    router.add('GET', '/', (_req, res) => void serveShell(res, 'index.html'));
    router.add('GET', '/*', async (req, res, ctx) => {
      const p = ctx.params['*'] || '';
      if (RESERVED_PREFIX.test(p)) return sendError(res, 404, 'NOT_FOUND', `no route for GET /${p}`);
      if (!(await serveShellDocs(req, res, p))) await serveShell(res, p);
    });
    router.add('HEAD', '/*', async (req, res, ctx) => {
      const p = ctx.params['*'] || '';
      if (RESERVED_PREFIX.test(p) || !(await serveShellDocs(req, res, p))) {
        sendError(res, 404, 'NOT_FOUND', `no route for HEAD /${p}`);
      }
    });
  } else if (config.dev.enabled) {
    // The passwordless testing sandbox serves persona sign-in, docs and the
    // architecture overview when no web shell is mounted. Register this last
    // so every other route still wins.
    router.add('GET', '/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(demoLandingHtml(config));
    });
  }

  // Dev-only CORS: lets a Vite dev-server shell (pnpm run dev:web on another port)
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
      res.setHeader('access-control-allow-headers', 'content-type, x-lolly-client, if-none-match, idempotency-key');
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
    // Histogram writes must not terminate the server when the store is unavailable.
    if (client) void store.recordClient(client).catch(() => log('warn', 'fleet observation failed'));
    // Install identity (plans/34 wave 3): a shell may add `install/<id>` to its
    // tag. The registry row is written ONLY when the request carries a live
    // member session - anonymous and guest traffic can never mint one - and it
    // rides requests the person's own use already makes: there is no heartbeat
    // and no phone-home anywhere. Fire-and-forget like the histogram.
    const installId = client?.extra?.install;
    if (client && installId && installId.length <= 64) {
      void resolveMember(store, req.headers.cookie, sessionVerify)
        .then((u) => (u ? store.upsertInstall(installId, client, u.id) : undefined))
        .catch(() => {});
    }
    let routeClass = 'unmatched';
    // Request id: echoed on the response and on the access line, so a 5xx in
    // the logs joins to the request a person reports.
    const reqId = requestId(req.headers['x-request-id']);
    res.setHeader('x-request-id', reqId);
    const startedAt = Date.now();
    res.on('finish', () => {
      metrics.httpRequest(routeClass, statusClass(res.statusCode));
      if (log.accessLog) log('info', 'http', { reqId, method: req.method, route: routeClass, status: res.statusCode, ms: Date.now() - startedAt });
    });
    // Cookie-authenticated mutations from another site are refused before any
    // route runs (iam/csrf.ts). Bearer callers and cookie-less requests pass.
    const csrf = csrfVerdict(req.method, req.headers);
    if (csrf) {
      routeClass = 'csrf-blocked';
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'CSRF_BLOCKED', message: csrf } }));
      return;
    }
    // Rate-limit exposed request surfaces (auth, telemetry, links, automation).
    // Automation remains bounded even for authenticated callers; the console's
    // ordinary CRUD/API paths still never map to a bucket.
    const reqUrl = new URL(req.url ?? '/', 'http://local');
    const pathname = reqUrl.pathname;
    const surface = rateLimitSurface(req.method ?? 'GET', pathname);
    if (surface) {
      const verdict = limiter.take(surface, clientIp(req, config.rateLimit.trustedProxyHops));
      if (!verdict.ok) {
        routeClass = `ratelimited:${surface}`;
        metrics.rateLimited(surface);
        // The sign-in pages a person opens in a browser get a page, not JSON:
        // testers behind one office address share the bucket.
        if (surface === 'auth' && /^\/api\/auth\/(login|password\/)/.test(pathname) && /\btext\/html\b/.test(String(req.headers.accept ?? ''))) {
          res.writeHead(429, {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'",
            'retry-after': String(verdict.retryAfterSec),
          });
          const isGet = (req.method ?? 'GET') === 'GET';
          res.end(signInErrorHtml(config.instance.name, {
            message: isGet
              ? 'Too many sign-in attempts from your network. Wait a minute, then try again.'
              : 'Too many sign-in attempts from your network. Wait a minute, then go back and send the form again.',
            // A GET is safe to repeat as it was (a sign-in link keeps its token);
            // a form post is not, so the way back is the browser's own.
            retryHref: isGet ? `${pathname}${reqUrl.search}` : '',
            heading: 'Too many sign-in attempts',
          }));
          return;
        }
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(verdict.retryAfterSec) });
        res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'too many requests — slow down' } }));
        return;
      }
    }
    try {
      const matched = await brand.run(async () => {
        res.setHeader('x-lolly-brand-revision', brand.current()!.revision);
        const expected = req.headers['x-lolly-brand-revision'];
        if (expected && expected !== brand.current()!.revision) throw new BrandError('The design system changed during rendering. Retry with the current revision.', 409, 'BRAND_REVISION_CHANGED');
        return router.dispatch(req, res);
      });
      if (matched) routeClass = matched;
      else sendError(res, 404, 'NOT_FOUND', `no route for ${req.method} ${req.url}`);
    } catch (err) {
      if ((err as Error).message === 'collab-active') {
        if (!res.headersSent) sendCollabActive(res);
        return;
      }
      // Too many password checks waiting (lib/crypto.ts): try again shortly.
      if (err instanceof ScryptBusyError) {
        if (!res.headersSent) { res.setHeader('retry-after', '2'); sendError(res, 503, err.code, err.message); }
        return;
      }
      const status = (err as { status?: number }).status ?? 500;
      if (!res.headersSent) sendError(res, status, err instanceof BrandError ? err.code : status === 500 ? 'INTERNAL' : 'BAD_REQUEST', (err as Error).message);
    }
  };
}

/** A live collaboration room holds the session's lease (`Store.collabLeaseActive`,
 *  or `putSession` throwing `collab-active`), so REST may not write it yet. */
function sendCollabActive(res: ServerResponse): void {
  sendError(res, 409, 'COLLAB_ACTIVE', 'This session has a live collaboration room. Close it before saving through this API.');
}

/** Let a browser on any origin read this response. Used by the two routes a
 *  client fetches cross-origin when someone adds a hosted design system by URL
 *  (OSS plans/186 section 3.6) - the unauthenticated manifest, and the pack
 *  download on an open instance. A wildcard is the right shape for both: they
 *  carry nothing per-user, no cookie is sent with them, and a wildcard plus
 *  credentials is refused by browsers, so there is no credentialed variant to
 *  vary on. `expose` names a response header script may read on top of the
 *  handful CORS allows by default (the pack's `ETag`, which is the whole point
 *  of the conditional request). No `Vary: Origin` - the answer is the same
 *  whoever asks. */
function allowCrossOriginRead(res: ServerResponse, expose?: string): void {
  res.setHeader('access-control-allow-origin', '*');
  if (expose) res.setHeader('access-control-expose-headers', expose);
}

/** Answer the preflight for one of those reads. Browsers preflight a GET that
 *  carries `If-None-Match`, which is exactly what a client holding a copy of
 *  the pack sends. A day of caching, so the check costs one extra request per
 *  client per day rather than one per poll. */
function sendReadPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET',
    'access-control-allow-headers': 'If-None-Match',
    'access-control-max-age': '86400',
  });
  res.end();
}

/** Does an `If-None-Match` header cover this entity tag (RFC 9110 section 13.1.2)?
 *  `*` matches any stored representation; otherwise any member of the comma list
 *  that equals the tag counts. The comparison is weak, so a `W/` prefix on either
 *  side is ignored - a byte-identical pack is a match however it was tagged. */
function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return false;
  const bare = (tag: string): string => tag.trim().replace(/^W\//, '');
  const want = bare(etag);
  return raw.split(',').some((tag) => {
    const candidate = bare(tag);
    return candidate === '*' || candidate === want;
  });
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
  if (path.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.md')) return 'text/markdown; charset=utf-8';
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
