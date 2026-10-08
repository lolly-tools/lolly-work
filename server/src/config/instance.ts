/**
 * Instance configuration (plans/01 §4). One JSON file + secrets from env.
 * (YAML support arrives with the deps decision; JSON keeps the scaffold
 * zero-dependency and air-gap-trivial.)
 *
 * Secrets are NEVER in the config file:
 *   LW_SESSION_SECRET - sessions/guests/state tokens (required in prod)
 *   LW_LINK_SECRET - link signatures (required in prod)
 *   LW_IDP_CLIENT_SECRET - OIDC client secret (when the IdP requires one)
 *   LW_CREDENTIAL_SECRET - master key sealing stored provider credentials
 *                          (required in prod only once a credential is stored)
 *   <credentialRef> - config-managed catalog providers name their own env
 *                          var per entry; resolved at boot, never persisted
 */
import { readFileSync } from 'node:fs';
import { randomId } from '../lib/crypto.ts';
import { validateAiConfig } from '../policy/ai.ts';
import { validateInvitePolicy, type InvitePolicyConfig } from '../policy/invites.ts';
import { PROJECT_FILE_DEFAULTS, PROJECT_FILE_MAX_BYTES, type ProjectFilePolicy } from '../projects/files.ts';
import { PROVIDER_KINDS, type ProviderExposure, type ProviderKind, type ProviderMapping, type ProviderSyncConfig } from '../catalog/providers/types.ts';
import { DELIVERY_DESTINATION_KINDS, type ConfigDeliveryDestination } from '../delivery/types.ts';
import { AUTH_PARAM_ALLOWLIST, type ClaimMap } from '../iam/oidc.ts';
import type { AdmissionPolicy, EmailVerification } from '../iam/admission.ts';
import type { RoleGroups } from '../rbac/evaluate.ts';
import { validateSharingPolicy } from '../policy/sharing.ts';

/** A deploy-time (GitOps/air-gap) provider entry - upserted at boot with
 *  managedBy:'config' and read-only in the control-plane API (plans/17 §4).
 *  Credentials come from the env var named by credentialRef, per the
 *  secrets-never-in-config rule. */
export interface ConfigCatalogProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  credentialRef?: string;
  enabled?: boolean;
  options?: Record<string, unknown>;
  mapping?: ProviderMapping;
  exposure?: ProviderExposure;
  sync?: ProviderSyncConfig;
}

/** Org policy for catalog submit (plans/31 section 3). */
export interface SubmitPolicy {
  /** Per-file cap on submitted bytes. Default 64 MiB, matching publish-out. */
  maxBytes: number;
  /** Approval chain id gating submissions. Absent or empty ⇒ no review: a
   *  submitted asset is live the moment it is stored. */
  chain?: string;
  /** Per-group ceilings, counted cumulatively across every submission a group's
   *  members make. 0 (the default for both) means unlimited: an unconfigured
   *  instance counts without ever refusing. */
  quota: { bytes: number; count: number };
}

/** Org policy for the catalog itself (plans/31 section 6). */
export interface CatalogPolicy {
  /**
   * How many versions of one instance asset are kept, head included. 0 (the
   * default) keeps everything.
   *
   * Keep-all is the only defensible default: an org that has just moved its
   * brand history off a DAM would find a product-chosen ceiling deleting the
   * originals it moved. Blob growth is real and is an operator's call to make
   * deliberately, which is why the number is here and the sizing note is in
   * docs/operations.md. The HEAD is never trimmed whatever its age, so a
   * rollback onto an old version cannot be undone by retention.
   */
  versionKeep: number;
}

/**
 * The operator-pluggable PRE-STORE scan hook (plans/31 section 3 step 3,
 * open question 3). Instance config, never org policy: it is not in the
 * policy-as-code document and not in org-config, so no shell and no policy
 * export ever sees it.
 *
 * lolly-work ships the hook, never a scanner. `http` POSTs the bytes to a
 * gateway and reads the status; `exec` pipes them to a local command's stdin
 * and reads the exit code (the clamdscan pattern). Absent by default, and its
 * absence is the documented stance in docs/operations.md, not a silent no-op.
 */
export interface SubmitScanHook {
  kind: 'http' | 'exec';
  /** URL for `http`; the executable path for `exec`. */
  target: string;
  /** Extra argv for `exec` (ignored by `http`); the bytes always ride stdin. */
  args?: string[];
  /** Wall-clock budget for one scan. Default 10000 ms. */
  timeoutMs: number;
  /** What a hook that fails to ANSWER means (a timeout, a refused connection, a
   *  missing binary) - distinct from a hook that answers "reject". Defaults to
   *  `reject`: an unreachable scanner refuses the submission rather than
   *  quietly turning the whole gate off. */
  onError: 'reject' | 'allow';
}

export interface InstanceConfig {
  deployment: {
    mode: 'auto' | 'evaluation' | 'production';
    application: 'api' | 'web';
    requireServerRendering: boolean;
  };
  instance: {
    name: string;
    baseUrl: string;
    pack: string;
    /** Optional path to a built Lolly web shell (shells/web/dist). When set, the
     *  instance serves the shell at `/` so the whole product is ONE origin - 
     *  session cookies work and the shell's org/ seam activates. Absent → the
     *  console (/admin) and API are served, but not the shell. Boot check: under
     *  a non-open defaultAccessMode the server refuses to start when this dist
     *  is missing or predates the org/ governance module (lib/shell-dist.ts);
     *  LW_ALLOW_STALE_SHELL=1 downgrades the refusal to a loud warning. */
    shellDir?: string;
    /** Optional URL of the Lolly app when it is NOT served same-origin via
     *  shellDir - e.g. a Vite dev server (http://localhost:5173) or a split
     *  deploy. The console routes its "Open Lolly" and tool/session/project
     *  deep links through this. Absent → links stay same-origin (`/`). */
    appUrl?: string;
    /** Optional `.lolly` instance pack to HOST from boot (plans/36 ship work):
     *  a path relative to `pack` (or absolute). Seeded into the blob store on
     *  first read when nothing is hosted yet - so a read-only or ephemeral
     *  deploy (the Vercel demo) offers the connect download without an owner
     *  ever running the PUT, and an owner's own upload always wins. The same
     *  inspection as the upload applies: a file naming a different instance
     *  base is refused, loudly, at seed time. */
    connectPack?: string;
    /** Explicit tokens asset per source id when a catalogue carries multiple token sets. */
    brandTokens?: Record<string, string>;
    /** The view a signed-in member's shell opens on at the bare app address (no
     *  route in it): the tools gallery or their Projects. Absent ⇒ the shell's own
     *  default (tools). Passed to members as org-config `home`; a link to a tool,
     *  project or view still opens where it points. */
    homeView?: 'tools' | 'projects';
    /** Optional destination for Home and arrival at the bare app address. */
    homeUrl?: string;
    /** One plain-text line the invite page and copied invite messages show,
     *  such as which sign-in to use when an organisation blocks one
     *  (plans/74 invite spec 2.5). Trimmed, at most 240 characters, no line
     *  breaks. Absent shows nothing. */
    inviteNote?: string;
  };
  idp: {
    issuer: string;
    clientId: string;
    groupsClaim: string;
    roleGroups: RoleGroups;
    claimMap: ClaimMap;
    /** Human name for the sign-in button and "managed by …" copy - e.g.
     *  "Keycloak", "SUSE ID", "ZITADEL". Any OIDC issuer works (open and
     *  sovereign providers first-class); absent → the console says "SSO". */
    displayName: string;
    /** Further IdPs beside the primary (plans/36 §3) - a migration in flight,
     *  a subsidiary on its own house. The primary stays exactly what it was:
     *  its subs are raw, its SCIM linkage untouched. An additional IdP's subs
     *  are namespaced `<id>:<sub>` so two issuers handing out the same bare
     *  sub can never collide into one row. With several IdPs configured,
     *  /api/auth/login with no ?idp= serves a script-free chooser - the OSS
     *  gate and the console gate grow multiple buttons with zero client work. */
    additional: AdditionalIdp[];
    /** Planned sign-ins shown as disabled choices; never used for authentication. */
    pending?: string[];
    /** Who may sign in (plans/74 W-ID-1), shared by every IdP and the proxy.
     *  Absent = every verified sign-in is admitted (and production setup warns). */
    admission?: AdmissionPolicy;
    /** Emails that get the owner group at sign-in once admitted with a
     *  verified address - how a groupless IdP (Google) gets its first owner. */
    bootstrapOwners: string[];
    /** Days one sign-in's IdP groups, and the account's own sign-in's
     *  standing under the admission lists, carry over to the person's other
     *  linked sign-ins (plans/74). Absent = 30 (iam/identities.ts). */
    linkedStandingDays?: number;
  } & IdpConstraints;
  policy: {
    comments?: {
      enabled: boolean;
      /** Mentions in comments and the people list behind them (plan 76 M4). Absent = on. */
      mentions?: boolean;
      /** Inbox notices for mentions and replies. Absent = on. */
      notices?: boolean;
      /** Name the document in mention mail. Absent = off: a private document's
       *  title is not sent to a mail provider unless the operator says so. */
      emailTitles?: boolean;
    };
    /** Managed AI is off unless both this approval ceiling and the audited
     * operator flag allow it. A personal shell preference cannot enable it. */
    ai: import('../policy/ai.ts').AiConfig;
    defaultAccessMode: 'open' | 'gated' | 'per-tool';
    telemetry: 'off' | 'aggregate' | 'standard';
    telemetryAttribution: 'default' | 'opt-in';
    guestLinks: { enabled: boolean; maxTtlHours: number; defaultTtlHours: number };
    /** Instance-mediated "nearby" for browser members (plans/26 §8, OSS plans/110 §5):
     *  group online members by apparent network so the invite flow can surface likely-
     *  nearby colleagues. A sorting hint, never an identity claim. Governs the
     *  `collab.nearby` capability bit + the two `/api/v1/collab/nearby` routes; only
     *  effective on the long-lived server (the registry is absent on Vercel). Default
     *  on - it discloses nothing a member did not opt into. Force off to keep the whole
     *  surface dark fleet-wide. */
    nearby: { enabled: boolean };
    /** Member session lifetime (hours) - sets both the signed-token exp and the
     *  cookie Max-Age. Bounds token lifetime if a directory change has not
     *  reached Work. Once received, roles/groups are resolved live; disable
     *  and session-epoch bumps revoke tokens on the next member request. */
    sessionTtlHours: number;
    /** Catalog submit (plans/31 section 3) - the ORG policy half, so it belongs
     *  beside the other things an org tunes. Open to authors by default: anyone
     *  holding `catalog.submit` submits and the asset goes live immediately.
     *  Naming a `chain` buys review; defaults set direction, orgs buy limits. */
    submit: SubmitPolicy;
    /** Catalog retention (plans/31 section 6). Version history is kept whole by
     *  default; an org that would rather bound its blob growth sets a ceiling. */
    catalog: CatalogPolicy;
    /** Fleet version floor (plans/34 wave 5). `minEngine` is a statement, not a
     *  gate: engines below it are highlighted in the Fleet view and the console
     *  offers a pre-composed upgrade NUDGE through the ordinary message path.
     *  Nothing is blocked, locked out, or force-upgraded - the covenant again. */
    fleet: { minEngine?: string };
    /** Retention (plans/35 wave 3). 0 = keep forever, the default - an org
     *  states its policy, the product never assumes one. Audit trims keep the
     *  chain verifiable (the anchor) and never pass the SIEM cursor. */
    retention: { telemetryDays: number; auditDays: number };
    /** Invites from inside Lolly (plans/74): who may invite new people by
     *  email, which domains, how long an invitation stays open and which
     *  project roles may be given. Absent means the defaults in
     *  policy/invites.ts (`resolveInvitePolicy`): admins, any domain, 720
     *  hours, every project role. */
    invites?: InvitePolicyConfig;
    /** Shared project files (plans/74, projects/files.ts): on by default where
     *  the store is durable. The per-file cap and the project and instance
     *  budgets are bytes; unfinished uploads expire after `uploadTtlHours`.
     *  The defaults fit a small hosted Postgres that also holds the blobs. */
    projectFiles: ProjectFilePolicy;
    /** Access requests (plans/75 G13): who may ask for what, and for how
     *  long a request stays open. See `RequestPolicy`. */
    requests: RequestPolicy;
    /** Sharing limits (lolly plan 299 M1): the instance-wide audience, its
     *  role ceiling, user-made groups and the longest grant. Absent: every
     *  default (see `policy/sharing.ts`). */
    sharing?: import('../policy/sharing.ts').SharingPolicyConfig;
  };
  render: {
    /**
     * Whether the in-process (jsdom) render fast path may run a tool that ships
     * hooks.js. plans/11 commits server hooks to the Chromium sandbox; until that
     * lands this flag is the curated-pack interim the public MCP endpoint already
     * practices (it runs curated tools' hooks in jsdom). Default false: a hooked
     * tool is refused (501 HOOKED_TOOL_NEEDS_CHROMIUM) rather than run untrusted
     * code in-realm. Flip to true only for a pack you curate end-to-end.
     */
    allowHooksInFastPath: boolean;
    /**
     * The Chromium render worker (plans/07/11). Hooked/HTML-heavy tools can't run
     * in the in-process jsdom fast path; when `worker.url` is set, the render
     * plane dispatches them to this isolated browser worker (least-trusted content,
     * blast-separated from the control plane) instead of refusing with 501. Empty
     * url ⇒ no worker ⇒ hooked tools still 501 (unchanged). The shared HMAC key is
     * env-only: LW_RENDER_WORKER_SECRET.
     */
    worker: { url: string; timeoutMs: number };
    /**
     * Instance C2PA signing identity (plans/17 §16). When `certFile` (a public
     * cert-chain PEM, leaf first) is set AND LW_C2PA_SIGNING_KEY (the PKCS#8
     * private-key PEM) is present, server-side exports carry a real signed C2PA
     * Content Credential. Absent ⇒ unsigned provenance (unchanged). Mint an
     * identity in one command with `lw c2pa init`, or drop in a cert issued by
     * your corporate CA. `claimGenerator` labels the manifest's producer.
     */
    c2pa: { certFile: string; claimGenerator: string };
  };
  audit: {
    /** Periodically emit the audit-chain head hash to stdout so any log pipeline
     *  captures it off-box (truncation defence, plan Rec 5). ON by default:
     *  onBoot plus an hourly interval. Set intervalMinutes to 0 (and onBoot
     *  false) to opt out explicitly. */
    headLog: { onBoot: boolean; intervalMinutes: number };
  };
  dev: {
    enabled: boolean;
    users: Array<{ email: string; name?: string; groups?: string[] }>;
  };
  /** Reverse-proxy sign-in: an authenticating proxy in front of the instance
   *  (YunoHost's SSOwat, Authelia, oauth2-proxy) states who the person is in
   *  request headers, and the instance mints an ordinary member session from
   *  them. Trust rests on two things the proxy owns: it strips any identity
   *  header a client sent, and it injects the shared secret the `secretRef`
   *  env var holds. Optional LDAP lookup fills attributes and groups. */
  proxyAuth: ProxyAuthConfig;
  catalogProviders: ConfigCatalogProvider[];
  /**
   * How the catalog feed and federated bytes behave at DAM scale (tens of
   * thousands of assets). Instance config rather than org policy: these are
   * sizing knobs for this process, and every value has a working default.
   *
   * - `maxProviderAssets`: most assets one provider sync federates, unless the
   *   provider's own `sync.maxAssets` says otherwise. A walk that stops here
   *   marks the fragment truncated and says so in the sources view.
   * - `pagedProviderThreshold`: a provider with more assets than this is left
   *   out of `assets/index.json?paged=1` and listed under `pagedProviders`, so
   *   a client can browse that provider through `GET /api/v1/catalog/assets`
   *   instead of mirroring the whole source. Requests without `paged=1` are unchanged.
   * - `extCache`: an in-memory cache of federated bytes (originals and
   *   thumbnails) keyed by the entry version, so a grid of DAM thumbnails does
   *   not refetch upstream on every view. `maxBytes` 0 turns it off; an item
   *   larger than `maxItemBytes` streams through uncached.
   */
  catalogServing: {
    maxProviderAssets: number;
    pagedProviderThreshold: number;
    extCache: { maxBytes: number; maxItemBytes: number };
  };
  /**
   * Fixed organization-owned outbound targets. Credentials are per-entry env
   * refs, never part of org-config; personal device targets do not enter this
   * block at all.
   */
  delivery: {
    maxBytes: number;
    destinations: ConfigDeliveryDestination[];
  };
  /**
   * Where instance-owned catalog bytes live (plans/26 §2, plans/27 §5): the
   * materialized-out-of-a-DAM assets and, later, collab staging. `pg` (default)
   * keeps the zero-moving-parts single-node deploy - PG works everywhere the
   * plane runs. `s3` points at any S3-compatible store (AWS, MinIO, Ceph RGW)
   * for media-sized estates and the air-gap story; the credential is env-only
   * (LW_BLOBS_S3_CREDENTIAL = "<accessKeyId>:<secretAccessKey>").
   */
  blobs: {
    driver: 'pg' | 's3';
    s3?: { bucket: string; region?: string; endpoint?: string; prefix?: string };
  };
  /** Instance-side catalog submit configuration. Only the scan hook lives here;
   *  everything an ORG tunes about submit lives under `policy.submit`. */
  submit: { scanHook?: SubmitScanHook };
  /** Notification egress (plans/35 wave 1). Absent = dormant, zero egress.
   *  Both channels are the org talking to itself - its relay, its endpoint -
   *  never phone-home. Secrets ride env (LW_SMTP_PASSWORD, LW_WEBHOOK_SECRET),
   *  never this file. */
  notify: {
    smtp?: { host: string; port: number; secure: boolean; from: string; user?: string };
    webhook?: { url: string };
    /** Notices to people (invitations, requests, answers; notify/people.ts).
     *  They always reach the inbox. `email` also mails them once `smtp` is
     *  set and the sender can confirm delivery; off by default. `fromName`
     *  is the sender's display name, at most 60 characters, and defaults to
     *  `instance.name`. */
    people: { email: boolean; fromName?: string };
  };
  /** SIEM forwarding (plans/35 wave 2): audit events pushed to the org's own
   *  receiver in signed batches, loss-free behind the siem_cursor. `url`
   *  absent = off. Long-lived server only; the HMAC key rides LW_SIEM_SECRET. */
  siem: { url?: string; batchSize: number; intervalSeconds: number };
  rateLimit: RateLimitConfig;
}

/**
 * Access requests (plans/75 G13; server/src/access/requests.ts). `project`
 * lets a member ask for a project they cannot open, or ask to edit one they
 * view; on by default. `join` lets a person who signed in but is not
 * admitted ask the admins to let them in; off by default, because it opens
 * a channel to the admins for anyone who can sign in somewhere. A request
 * stays open `ttlDays`; `joinOpenMax` bounds the open join and switch
 * requests across the workspace.
 */
export interface RequestPolicy {
  join: boolean;
  project: boolean;
  ttlDays: number;
  joinOpenMax: number;
}

export interface RateLimitSurfaceConfig { capacity: number; refillPerSec: number }
export interface RateLimitConfig {
  enabled: boolean;
  /** Number of trusted reverse proxies in front of the instance; 0 = read only
   *  the socket peer (never trust X-Forwarded-For). Set to 1 behind a single edge. */
  trustedProxyHops: number;
  maxBuckets: number;
  auth: RateLimitSurfaceConfig;
  telemetry: RateLimitSurfaceConfig;
  link: RateLimitSurfaceConfig;
  /** Automation endpoints can be public on an open instance and are expensive
   * even when authenticated; keep a separate, operator-tunable bucket. */
  automation: RateLimitSurfaceConfig;
}

/** One further IdP beside the primary (plans/36 §3). `id` is the slug the
 *  login URL and the sub namespace carry ('primary' is reserved). The
 *  confidential client secret rides the env var `clientSecretRef` names - the
 *  provider-credentialRef precedent - and is absent for public/PKCE clients. */
export interface AdditionalIdp extends IdpConstraints {
  id: string;
  /** `oidc` (default): any OpenID Connect issuer. `github`: GitHub's OAuth 2.0
   *  sign-in (iam/github.ts), which has no issuer and needs `clientSecretRef`.
   *  `password`: email and password, set from a one-time link an admin issues
   *  (iam/password.ts); no issuer, client or secret, and at most one. */
  kind?: IdpKind;
  /** The OIDC issuer. Empty for `kind: 'github'` and `kind: 'password'`, which have none. */
  issuer: string;
  /** Empty for `kind: 'password'`. */
  clientId: string;
  /** Required: the chooser button must say which house. A password entry
   *  may give it as `label` instead, and defaults to PASSWORD_IDP_LABEL. */
  displayName: string;
  /** `kind: 'password'` only: the same as `displayName`. */
  label?: string;
  groupsClaim: string;
  claimMap: ClaimMap;
  clientSecretRef?: string;
}

export type IdpKind = 'oidc' | 'github' | 'password';
export const IDP_KINDS: readonly IdpKind[] = ['oidc', 'github', 'password'];
/** What the chooser calls a password entry that names nothing itself. */
export const PASSWORD_IDP_LABEL = 'Email and password';

/** The email and password entry in `idp.additional`, or null. There is at most one. */
export function passwordIdpOf(config: { idp: { additional: AdditionalIdp[] } }): AdditionalIdp | null {
  return config.idp.additional.find((a) => a.kind === 'password') ?? null;
}

/** Whether a sign-in from this IdP may join an existing person by a matching
 *  email. Default: yes when the IdP's own verified flag is checked (`claim`),
 *  no when every address is simply trusted (`trusted`), because a trusted
 *  address was never proven by the person. `linkByEmail` overrides either way. */
export function linkByEmailFor(c: Pick<IdpConstraints, 'linkByEmail' | 'emailVerification'>): boolean {
  return c.linkByEmail ?? (c.emailVerification ?? 'claim') === 'claim';
}

/** Per-IdP sign-in constraints (plans/74 W-ID-1), on the primary `idp` block
 *  and on each `idp.additional[]` entry. Never inherited between IdPs. */
export interface IdpConstraints {
  /** Google Workspace: the `hd` claim must equal this; also sent as the `hd` auth param. */
  hostedDomain?: string;
  /** Microsoft Entra: the `tid` claim must equal this tenant id. */
  tenantId?: string;
  /** `claim` (default): email-based admission needs `email_verified === true`.
   *  `trusted`: the IdP vouches for every email it sends (a tenant-pinned IdP that omits the claim). */
  emailVerification?: EmailVerification;
  /** Requested scopes; default `openid profile email`. Must include `openid`. */
  scopes?: string[];
  /** Extra authorization request parameters, from `AUTH_PARAM_ALLOWLIST` only. */
  authParams?: Partial<Record<typeof AUTH_PARAM_ALLOWLIST[number], string>>;
  /** Link a sign-in to an existing person with the same email. Read through
   *  `linkByEmailFor`: absent means true under `claim`, false under `trusted`. */
  linkByEmail?: boolean;
}

/** Request headers the proxy sets (names lowercased for lookup, so `YNH_USER`
 *  and `Ynh-User` both read as `ynh_user`). Only `user` is required; the rest
 *  fall back to the directory lookup, then to blanks. */
export interface ProxyAuthHeaders {
  user: string;
  email: string;
  name: string;
  /** Comma-separated group names from the proxy; empty = the proxy sends none. */
  groups: string;
}

/** One rule turning a directory attribute's values into group names: every
 *  value matching `pattern` contributes its first capture group. */
export interface ProxyAuthGroupRule {
  attribute: string;
  pattern: string;
}

/** The optional LDAP lookup behind proxy sign-in. Read-only, one entry per
 *  sign-in: the user's own object, fetched by DN, never a subtree search. */
export interface ProxyAuthDirectory {
  /** `ldap://host:port` (plain TCP). ldaps is not supported; run the lookup on
   *  the loopback of the host that owns the directory. */
  url: string;
  /** Simple bind identity; both empty = anonymous. The password rides the env
   *  var `bindPasswordRef` names. */
  bindDn: string;
  bindPasswordRef: string;
  /** DN template; `{user}` is replaced with the RFC 4514-escaped user header. */
  userDn: string;
  /** Which attributes fill which member fields when the headers left them blank. */
  attributes: { email: string; firstname: string; lastname: string; name: string };
  groupMap: ProxyAuthGroupRule[];
  timeoutMs: number;
}

export interface ProxyAuthConfig {
  enabled: boolean;
  /** Sign-in button copy ("YunoHost", "Authelia"). Required when enabled. */
  displayName: string;
  /** Env var NAME holding the shared secret; the request header
   *  `x-lw-proxy-auth` must equal its value or the sign-in is refused. */
  secretRef: string;
  headers: ProxyAuthHeaders;
  /** Static grants unioned in at sign-in: `{ "<user>": ["owner"] }`. */
  groups: Record<string, string[]>;
  directory: ProxyAuthDirectory | null;
}

export interface Secrets {
  session: string;
  link: string;
  /** Dual-key rotation (plans/35 wave 4): verification accepts the previous
   *  key beside the current one; minting always uses current. Rotation is two
   *  deploys - add PREVIOUS with the new current, later drop PREVIOUS - with
   *  no forced logout and no dead links inside the window. */
  sessionPrevious?: string;
  linkPrevious?: string;
  idpClientSecret?: string;
  /** Shared secret the reverse proxy injects as `x-lw-proxy-auth`; read from
   *  the env var `proxyAuth.secretRef` names. Required when proxyAuth is on. */
  proxyAuth?: string;
  /** Simple-bind password for the proxyAuth directory lookup, from the env var
   *  `proxyAuth.directory.bindPasswordRef` names. Absent = anonymous bind. */
  proxyAuthBind?: string;
  /** SMTP relay password - required only when notify.smtp names a user. */
  smtpPassword?: string;
  /** HMAC key for outbound webhook signatures - required with notify.webhook
   *  (an unsigned webhook is refused at boot: the receiver could never tell a
   *  forgery from the instance). */
  webhook?: string;
  /** HMAC key for SIEM batch signatures - required with siem.url, enforced
   *  where the forwarder is built. */
  siem?: string;
  /** Master key for sealed provider credentials - absent until the operator sets it. */
  credential?: string;
  /** Bearer token for /metrics. Absent ⇒ metrics are loopback-only (never public). */
  metricsToken?: string;
  /** Shared HMAC key for the Chromium render worker. Absent ⇒ no worker dispatch. */
  renderWorker?: string;
  /** PKCS#8 private-key PEM for the instance C2PA signer. Absent ⇒ unsigned exports. */
  c2paSigningKey?: string;
  /** ECDSA P-256 private key (PKCS#8 PEM or private JWK JSON) that signs the
   *  per-caller tool index (catalog/signing.ts). Absent ⇒ the catalog is served
   *  unsigned, exactly as before. */
  catalogSigningKey?: string;
}

const DEFAULTS: InstanceConfig = {
  deployment: { mode: 'auto', application: 'api', requireServerRendering: false },
  // The default pack is the small demo pack committed at packs/demo, so an
  // unconfigured instance serves a real catalog instead of an empty one.
  instance: { name: 'Lolly Work', baseUrl: 'http://localhost:8787', pack: './packs/demo' },
  idp: {
    issuer: '',
    clientId: '',
    groupsClaim: 'groups',
    roleGroups: {},
    claimMap: { firstname: 'given_name', lastname: 'family_name', email: 'email', title: 'title' },
    displayName: '',
    additional: [],
    bootstrapOwners: [],
  },
  policy: {
    comments: { enabled: true },
    ai: { enabled: false, capabilities: [] },
    defaultAccessMode: 'gated',
    telemetry: 'standard',
    telemetryAttribution: 'opt-in',
    guestLinks: { enabled: true, maxTtlHours: 168, defaultTtlHours: 72 },
    nearby: { enabled: true },
    sessionTtlHours: 12,
    submit: { maxBytes: 64 * 1024 * 1024, quota: { bytes: 0, count: 0 } },
    catalog: { versionKeep: 0 },
    fleet: {},
    retention: { telemetryDays: 0, auditDays: 0 },
    projectFiles: { ...PROJECT_FILE_DEFAULTS },
    requests: { join: false, project: true, ttlDays: 14, joinOpenMax: 50 },
  },
  render: { allowHooksInFastPath: false, worker: { url: '', timeoutMs: 20000 }, c2pa: { certFile: '', claimGenerator: '' } },
  audit: { headLog: { onBoot: true, intervalMinutes: 60 } },
  rateLimit: {
    enabled: true, trustedProxyHops: 0, maxBuckets: 50000,
    auth: { capacity: 10, refillPerSec: 0.2 },
    telemetry: { capacity: 120, refillPerSec: 4 },
    link: { capacity: 30, refillPerSec: 1 },
    automation: { capacity: 120, refillPerSec: 2 },
  },
  dev: { enabled: false, users: [] },
  proxyAuth: {
    enabled: false,
    displayName: '',
    secretRef: 'LW_PROXY_AUTH_SECRET',
    // SSOwat's names. Authelia sends remote-user / remote-email / remote-name /
    // remote-groups; oauth2-proxy sends x-forwarded-user / x-forwarded-email.
    headers: { user: 'ynh_user', email: 'ynh_user_email', name: 'ynh_user_fullname', groups: '' },
    groups: {},
    directory: null,
  },
  catalogProviders: [],
  catalogServing: {
    maxProviderAssets: 100_000,
    pagedProviderThreshold: 2000,
    extCache: { maxBytes: 64 * 1024 * 1024, maxItemBytes: 2 * 1024 * 1024 },
  },
  delivery: { maxBytes: 64 * 1024 * 1024, destinations: [] },
  blobs: { driver: 'pg' },
  notify: { people: { email: false } },
  siem: { batchSize: 200, intervalSeconds: 30 },
  submit: {},
};

/** Validate `policy.requests` in place: two switches and two whole-number bounds. */
function validateRequestPolicy(r: RequestPolicy): void {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('policy.requests must be an object');
  for (const k of Object.keys(r)) {
    if (!['join', 'project', 'ttlDays', 'joinOpenMax'].includes(k)) {
      throw new Error(`policy.requests.${k} is not a known key (join, project, ttlDays, joinOpenMax)`);
    }
  }
  for (const k of ['join', 'project'] as const) {
    if (typeof r[k] !== 'boolean') throw new Error(`policy.requests.${k} must be true or false`);
  }
  if (!Number.isInteger(r.ttlDays) || r.ttlDays < 1 || r.ttlDays > 60) {
    throw new Error(`invalid policy.requests.ttlDays: ${r.ttlDays} (whole days, 1-60)`);
  }
  if (!Number.isInteger(r.joinOpenMax) || r.joinOpenMax < 1 || r.joinOpenMax > 1000) {
    throw new Error(`invalid policy.requests.joinOpenMax: ${r.joinOpenMax} (a whole number, 1-1000)`);
  }
}

function merge<T extends Record<string, unknown>>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = (base as Record<string, unknown>)[k];
    (out as Record<string, unknown>)[k] =
      v && cur && typeof v === 'object' && typeof cur === 'object' && !Array.isArray(v) && !Array.isArray(cur)
        ? merge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

const DIRECTORY_DEFAULTS: ProxyAuthDirectory = {
  url: 'ldap://127.0.0.1:389',
  bindDn: '',
  bindPasswordRef: '',
  userDn: 'uid={user},ou=users,dc=yunohost,dc=org',
  attributes: { email: 'mail', firstname: 'givenName', lastname: 'sn', name: 'cn' },
  groupMap: [],
  timeoutMs: 5000,
};

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Validate (and default) the proxyAuth block in place. A half-described proxy
 *  would refuse every sign-in in front of the person, so refuse the config. */
function validateProxyAuth(pa: ProxyAuthConfig): void {
  if (typeof pa.enabled !== 'boolean') throw new Error('proxyAuth.enabled must be true or false');
  if (!ENV_NAME.test(pa.secretRef)) throw new Error('proxyAuth.secretRef must name an env var (UPPER_SNAKE)');
  if (!pa.headers || typeof pa.headers.user !== 'string' || !pa.headers.user.trim()) {
    throw new Error('proxyAuth.headers.user must name the header carrying the login');
  }
  for (const k of ['user', 'email', 'name', 'groups'] as const) {
    const v = pa.headers[k] ?? '';
    if (typeof v !== 'string') throw new Error(`proxyAuth.headers.${k} must be a string`);
    pa.headers[k] = v.trim().toLowerCase();
  }
  if (!pa.groups || typeof pa.groups !== 'object' || Array.isArray(pa.groups)) throw new Error('proxyAuth.groups must be an object of user -> group list');
  for (const [user, groups] of Object.entries(pa.groups)) {
    if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || !g.trim())) {
      throw new Error(`proxyAuth.groups["${user}"] must be a list of group names`);
    }
  }
  if (pa.enabled && !pa.displayName?.trim()) throw new Error('proxyAuth.displayName is required when proxyAuth is enabled - the sign-in button must say what it signs in with');
  if (pa.directory === null || pa.directory === undefined) { pa.directory = null; return; }
  if (typeof pa.directory !== 'object') throw new Error('proxyAuth.directory must be an object or null');
  const d = merge(DIRECTORY_DEFAULTS as unknown as Record<string, unknown>, pa.directory as unknown as Record<string, unknown>) as unknown as ProxyAuthDirectory;
  let u: URL | null = null;
  try { u = new URL(d.url); } catch { /* refused below */ }
  if (!u || u.protocol !== 'ldap:' || !u.hostname) throw new Error(`proxyAuth.directory.url must be an ldap://host[:port] URL: ${d.url}`);
  if (typeof d.bindDn !== 'string') throw new Error('proxyAuth.directory.bindDn must be a string');
  if (d.bindPasswordRef && !ENV_NAME.test(d.bindPasswordRef)) throw new Error('proxyAuth.directory.bindPasswordRef must name an env var (UPPER_SNAKE)');
  if (typeof d.userDn !== 'string' || !d.userDn.includes('{user}')) throw new Error('proxyAuth.directory.userDn must contain {user}');
  for (const k of ['email', 'firstname', 'lastname', 'name'] as const) {
    if (typeof d.attributes[k] !== 'string') throw new Error(`proxyAuth.directory.attributes.${k} must be an attribute name (empty to skip)`);
  }
  if (!Array.isArray(d.groupMap)) throw new Error('proxyAuth.directory.groupMap must be a list');
  for (const rule of d.groupMap) {
    if (!rule || typeof rule.attribute !== 'string' || !rule.attribute.trim()) throw new Error('proxyAuth.directory.groupMap entries need an attribute');
    let re: RegExp;
    try { re = new RegExp(rule.pattern); } catch { throw new Error(`proxyAuth.directory.groupMap pattern does not compile: ${rule.pattern}`); }
    if (new RegExp(`${re.source}|`).exec('')!.length < 2) throw new Error(`proxyAuth.directory.groupMap pattern needs a capture group for the group name: ${rule.pattern}`);
  }
  if (!Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0) throw new Error(`invalid proxyAuth.directory.timeoutMs: ${d.timeoutMs}`);
  pa.directory = d;
}

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
export const DOMAIN_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ENTRA_TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_ADDR = /^[^\s@]+@[^\s@]+$/;

/** Validate (and normalise) one IdP's sign-in constraints in place. A typo
 *  here would either lock everyone out or let the wrong tenant in, so refuse
 *  the config rather than guess. */
function validateIdpConstraints(label: string, c: IdpConstraints): void {
  if (c.hostedDomain !== undefined) {
    const d = typeof c.hostedDomain === 'string' ? c.hostedDomain.trim().toLowerCase() : '';
    if (!DOMAIN_NAME.test(d)) throw new Error(`${label}.hostedDomain must be a domain name such as example.com`);
    c.hostedDomain = d;
  }
  if (c.tenantId !== undefined) {
    const t = typeof c.tenantId === 'string' ? c.tenantId.trim().toLowerCase() : '';
    if (!ENTRA_TENANT.test(t)) throw new Error(`${label}.tenantId must be a directory (tenant) id GUID`);
    c.tenantId = t;
  }
  if (c.emailVerification !== undefined && c.emailVerification !== 'claim' && c.emailVerification !== 'trusted') {
    throw new Error(`${label}.emailVerification must be "claim" or "trusted"`);
  }
  if (c.linkByEmail !== undefined && typeof c.linkByEmail !== 'boolean') {
    throw new Error(`${label}.linkByEmail must be true or false`);
  }
  // A trusted IdP's addresses are believed without a verified flag. Unless
  // the IdP is pinned to one directory, anyone able to create an account
  // there can set any address, so linking by it would hand them the account
  // that address belongs to (the nOAuth pattern).
  if (c.linkByEmail === true && c.emailVerification === 'trusted' && !c.hostedDomain && !c.tenantId) {
    throw new Error(`${label}.linkByEmail cannot be true for an emailVerification "trusted" IdP that has no hostedDomain or tenantId pin`);
  }
  if (c.scopes !== undefined) {
    const raw: unknown = c.scopes;
    const list = typeof raw === 'string' ? raw.split(/\s+/).filter(Boolean) : raw;
    if (!Array.isArray(list) || list.length > 30 || list.some((t) => typeof t !== 'string' || !SCOPE_TOKEN.test(t))) {
      throw new Error(`${label}.scopes must be a list of scope names`);
    }
    if (!list.includes('openid')) throw new Error(`${label}.scopes must include openid`);
    c.scopes = [...new Set(list as string[])];
  }
  if (c.authParams !== undefined) {
    const p: unknown = c.authParams;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${label}.authParams must be an object`);
    for (const [k, v] of Object.entries(p)) {
      if (!(AUTH_PARAM_ALLOWLIST as readonly string[]).includes(k)) {
        throw new Error(`${label}.authParams.${k} is not allowed (allowed: ${AUTH_PARAM_ALLOWLIST.join(', ')})`);
      }
      if (typeof v !== 'string' || !v.trim() || v.length > 300 || /[\u0000-\u001f]/.test(v)) {
        throw new Error(`${label}.authParams.${k} must be a short single-line string`);
      }
    }
    const hd = (p as Record<string, string>).hd;
    if (hd && c.hostedDomain && hd.toLowerCase() !== c.hostedDomain) {
      throw new Error(`${label}.authParams.hd differs from ${label}.hostedDomain - set one, or make them equal`);
    }
  }
}

/** Validate (and normalise) idp.admission and idp.bootstrapOwners in place. */
function validateAdmission(idp: InstanceConfig['idp']): void {
  const emailList = (key: string, v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 10000 || v.some((e) => typeof e !== 'string' || e.length > 320 || !EMAIL_ADDR.test(e.trim()))) {
      throw new Error(`${key} must be a list of email addresses`);
    }
    return [...new Set((v as string[]).map((e) => e.trim().toLowerCase()))];
  };
  if (idp.admission !== undefined) {
    const a: unknown = idp.admission;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('idp.admission must be an object');
    for (const k of Object.keys(a)) {
      if (!['emails', 'domains', 'invitations'].includes(k)) throw new Error(`idp.admission.${k} is not a known key (emails, domains, invitations)`);
    }
    const adm = a as AdmissionPolicy;
    if (adm.emails !== undefined) adm.emails = emailList('idp.admission.emails', adm.emails);
    if (adm.domains !== undefined) {
      const d: unknown = adm.domains;
      if (!Array.isArray(d) || d.length > 1000) throw new Error('idp.admission.domains must be a list of domain names');
      adm.domains = [...new Set(d.map((x) => {
        const n = typeof x === 'string' ? x.trim().toLowerCase().replace(/^@/, '') : '';
        if (!DOMAIN_NAME.test(n)) throw new Error(`idp.admission.domains entry is not a domain name: ${String(x)}`);
        return n;
      }))];
    }
    if (adm.invitations !== undefined && typeof adm.invitations !== 'boolean') throw new Error('idp.admission.invitations must be true or false');
  }
  idp.bootstrapOwners = emailList('idp.bootstrapOwners', idp.bootstrapOwners ?? []);
  if (idp.bootstrapOwners.length && Array.isArray(idp.roleGroups.owner) && idp.roleGroups.owner.length === 0) {
    throw new Error('idp.bootstrapOwners needs an owner group: idp.roleGroups.owner is an empty list');
  }
  // The first owner must be able to get in, or the instance has nobody to invite anyone.
  const adm = idp.admission;
  if (adm) {
    for (const owner of idp.bootstrapOwners) {
      const domain = owner.slice(owner.lastIndexOf('@') + 1);
      if (!(adm.emails ?? []).includes(owner) && !(adm.domains ?? []).includes(domain)) {
        throw new Error(`idp.bootstrapOwners entry ${owner} is not admitted: add it to idp.admission.emails or its domain to idp.admission.domains`);
      }
    }
  }
}

export function parseConfig(json: string): InstanceConfig {
  const raw = JSON.parse(json) as Partial<InstanceConfig>;
  // Check mapping keys before merging can turn a JSON __proto__ key into inheritance.
  if (raw.idp && Object.hasOwn(raw.idp, 'roleGroups')) {
    const input = raw.idp.roleGroups;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(role => !['owner', 'admin', 'approver', 'author', 'member', 'viewer'].includes(role))) {
      throw new Error('idp.roleGroups must map supported roles to group arrays');
    }
  }
  // A key the schema does not know is almost always a typo that silently
  // leaves a default in force (`render.allowHooksInFastpath`). Say so once.
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!(key in DEFAULTS) && !key.startsWith('_') && !key.startsWith('$')) {
      console.warn(`[lolly-work] WARNING — instance config carries an unknown top-level key "${key}"; it is ignored`);
    }
  }
  const cfg = merge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>) as unknown as InstanceConfig;
  if (!['auto', 'evaluation', 'production'].includes(cfg.deployment?.mode)
    || !['api', 'web'].includes(cfg.deployment?.application)
    || typeof cfg.deployment?.requireServerRendering !== 'boolean') {
    throw new Error('deployment requires mode (auto/evaluation/production), application (api/web) and boolean requireServerRendering');
  }
  if (cfg.instance.brandTokens !== undefined && (cfg.instance.brandTokens === null || Array.isArray(cfg.instance.brandTokens)
    || typeof cfg.instance.brandTokens !== 'object' || Object.entries(cfg.instance.brandTokens).some(([key, value]) =>
      !/^(mounted|profile:[a-z0-9][a-z0-9-]*)$/.test(key) || typeof value !== 'string' || !value.trim()))) {
    throw new Error('instance.brandTokens must map mounted or profile:<name> source ids to tokens asset ids');
  }
  if (cfg.instance.homeView !== undefined && !['tools', 'projects'].includes(cfg.instance.homeView)) {
    throw new Error('instance.homeView must be "tools" or "projects"');
  }
  if (cfg.instance.homeUrl !== undefined) {
    const value = cfg.instance.homeUrl;
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error('instance.homeUrl must be a root-relative URL or an HTTPS URL');
    let url: URL;
    try { url = new URL(value, 'https://instance.invalid'); } catch { throw new Error('instance.homeUrl must be a root-relative URL or an HTTPS URL'); }
    if ((!value.startsWith('/') && !value.startsWith('https://')) || value.startsWith('//') || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('instance.homeUrl must be a root-relative URL or an HTTPS URL');
    }
  }
  if (cfg.instance.inviteNote !== undefined) {
    const note = cfg.instance.inviteNote;
    if (typeof note !== 'string') throw new Error('instance.inviteNote must be a line of text');
    const line = note.trim();
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(line)) throw new Error('instance.inviteNote must be one line, without line breaks');
    if (line.length > 240) throw new Error('instance.inviteNote must be at most 240 characters');
    if (line) cfg.instance.inviteNote = line;
    else delete cfg.instance.inviteNote;
  }
  const mode = cfg.policy.defaultAccessMode;
  const roles = ['owner', 'admin', 'approver', 'author', 'member', 'viewer'];
  const mapping = cfg.idp.roleGroups;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
    || Object.entries(mapping).some(([role, groups]) => !roles.includes(role) || !Array.isArray(groups) || groups.length > 100
      || groups.some(group => typeof group !== 'string' || !group.trim() || group !== group.trim() || group.length > 300 || group === '*' || /[\u0000-\u001f]/.test(group)))) {
    throw new Error('idp.roleGroups must map supported roles to arrays of exact non-empty group names');
  }
  const assignedGroups = (['owner', 'admin', 'approver', 'author', 'member', 'viewer'] as const)
    .flatMap(role => mapping[role] ?? (['owner', 'admin', 'approver', 'author'].includes(role) ? [role] : []));
  if (new Set(assignedGroups).size !== assignedGroups.length) throw new Error('idp.roleGroups cannot assign a group more than once');
  validateAiConfig(cfg.policy.ai);
  validateInvitePolicy(cfg.policy.invites);
  if (!['open', 'gated', 'per-tool'].includes(mode)) throw new Error(`invalid defaultAccessMode: ${mode}`);
  if (!['off', 'aggregate', 'standard'].includes(cfg.policy.telemetry)) {
    throw new Error(`invalid telemetry level: ${cfg.policy.telemetry}`);
  }
  const ttl = cfg.policy.sessionTtlHours;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > 720) {
    throw new Error(`invalid sessionTtlHours: ${ttl} (must be > 0 and <= 720)`);
  }
  const iv = cfg.audit.headLog.intervalMinutes;
  if (!Number.isInteger(iv) || iv < 0) throw new Error(`invalid audit.headLog.intervalMinutes: ${iv}`);
  const floor = cfg.policy.fleet.minEngine;
  if (floor !== undefined && !/^\d+(\.\d+){0,3}$/.test(floor)) {
    throw new Error(`invalid policy.fleet.minEngine: ${floor} (dotted version, e.g. "1.140.0")`);
  }
  for (const k of ['telemetryDays', 'auditDays'] as const) {
    const v = cfg.policy.retention[k];
    if (!Number.isInteger(v) || v < 0) throw new Error(`invalid policy.retention.${k}: ${v} (days, 0 = keep forever)`);
  }
  if (cfg.policy.comments !== undefined && (typeof cfg.policy.comments !== 'object' || cfg.policy.comments === null || typeof cfg.policy.comments.enabled !== 'boolean')) throw new Error('policy.comments.enabled must be true or false');
  for (const key of ['mentions', 'notices', 'emailTitles'] as const) {
    const value = cfg.policy.comments?.[key];
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`policy.comments.${key} must be true or false`);
  }
  const files = cfg.policy.projectFiles;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('policy.projectFiles must be an object');
  if (typeof files.enabled !== 'boolean') throw new Error('policy.projectFiles.enabled must be true or false');
  for (const k of ['maxFileBytes', 'projectBudgetBytes', 'instanceBudgetBytes', 'uploadTtlHours'] as const) {
    if (!Number.isSafeInteger(files[k]) || files[k] <= 0) throw new Error(`invalid policy.projectFiles.${k}: ${files[k]} (a whole number above 0)`);
  }
  if (files.maxFileBytes > PROJECT_FILE_MAX_BYTES) throw new Error(`policy.projectFiles.maxFileBytes cannot exceed ${PROJECT_FILE_MAX_BYTES} (256 MiB)`);
  if (files.maxFileBytes > files.projectBudgetBytes || files.projectBudgetBytes > files.instanceBudgetBytes) {
    throw new Error('policy.projectFiles needs maxFileBytes <= projectBudgetBytes <= instanceBudgetBytes');
  }
  if (files.uploadTtlHours > 720) throw new Error(`invalid policy.projectFiles.uploadTtlHours: ${files.uploadTtlHours} (at most 720)`);
  validateRequestPolicy(cfg.policy.requests);
  validateSharingPolicy(cfg.policy.sharing);
  // Additional IdPs (plans/36 §3): defaults applied, then validated hard - a
  // half-described issuer would fail at sign-in, in front of the person.
  if (cfg.idp.pending !== undefined && (!Array.isArray(cfg.idp.pending) || cfg.idp.pending.length > 8 || cfg.idp.pending.some(name => typeof name !== 'string' || !name.trim() || name.length > 80))) throw new Error('idp.pending must be a list of at most eight short provider names');
  if (!Array.isArray(cfg.idp.additional)) throw new Error('idp.additional must be a list');
  const idpIds = new Set<string>();
  for (const a of cfg.idp.additional) {
    if (!a.id || !/^[a-z0-9][a-z0-9-]*$/.test(a.id)) throw new Error(`invalid idp.additional id: ${a.id} (lowercase slug)`);
    if (a.id === 'primary' || a.id === 'dev') throw new Error(`idp.additional id "${a.id}" is reserved`);
    if (idpIds.has(a.id)) throw new Error(`duplicate idp.additional id: ${a.id}`);
    idpIds.add(a.id);
    if (a.kind !== undefined && !IDP_KINDS.includes(a.kind)) {
      throw new Error(`idp.additional "${a.id}" kind must be one of: ${IDP_KINDS.join(', ')}`);
    }
    // Password subjects are `password:<credential id>` whatever the entry's
    // id, so no other IdP may namespace its subjects the same way.
    if (a.id === 'password' && a.kind !== 'password') throw new Error('idp.additional id "password" is reserved for kind password');
    if (a.kind === 'password') {
      // Email and password needs nothing from outside: no issuer to discover,
      // no client, no secret, no claims to map and no directory to pin.
      if (cfg.idp.additional.filter((x) => x.kind === 'password').length > 1) {
        throw new Error('idp.additional may hold one kind password entry at most');
      }
      for (const k of ['issuer', 'clientId', 'clientSecretRef', 'groupsClaim', 'claimMap', 'hostedDomain', 'tenantId', 'scopes', 'authParams'] as const) {
        if (a[k] !== undefined && a[k] !== '') throw new Error(`idp.additional "${a.id}".${k} does not apply to kind password`);
      }
      // The address is the one an admin issued the sign-in link for: it may
      // join the one account that already proves it, but the password's own
      // row is stored unverified, so it is never a join target itself
      // (api/app.ts completeSignIn). "trusted" would add nothing and would
      // turn off linking by email.
      if (a.emailVerification !== undefined && a.emailVerification !== 'claim') {
        throw new Error(`idp.additional "${a.id}" is kind password, whose emailVerification can only be "claim"`);
      }
      const label = a.label ?? a.displayName;
      if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 80)) {
        throw new Error(`idp.additional "${a.id}".label must be a short name for the sign-in button`);
      }
      if (a.label !== undefined && a.displayName !== undefined && a.label !== a.displayName) {
        throw new Error(`idp.additional "${a.id}" sets label and displayName differently: give one`);
      }
      a.displayName = label?.trim() || PASSWORD_IDP_LABEL;
      delete a.label;
      a.issuer = '';
      a.clientId = '';
      a.groupsClaim = cfg.idp.groupsClaim;
      a.claimMap = { ...cfg.idp.claimMap };
      validateIdpConstraints(`idp.additional "${a.id}"`, a);
      continue;
    }
    if (a.label !== undefined) throw new Error(`idp.additional "${a.id}".label is for kind password; this entry names itself with displayName`);
    if (!cfg.idp.issuer) throw new Error('idp.additional needs the primary idp.issuer configured first');
    if (a.kind === 'github') {
      // GitHub is OAuth 2.0 with fixed endpoints and scopes: nothing to
      // discover, no claims to pin, and a confidential client is mandatory.
      if (a.issuer !== undefined && a.issuer !== '') throw new Error(`idp.additional "${a.id}" is kind github, which takes no issuer`);
      if (!a.clientSecretRef) throw new Error(`idp.additional "${a.id}" is kind github and needs a clientSecretRef (GitHub OAuth Apps always have a client secret)`);
      for (const k of ['hostedDomain', 'tenantId', 'scopes', 'authParams'] as const) {
        if (a[k] !== undefined) throw new Error(`idp.additional "${a.id}".${k} does not apply to kind github`);
      }
      // GitHub reports verification per address and lets anyone add an
      // address without proving it, so only its own flag may count.
      if (a.emailVerification !== undefined && a.emailVerification !== 'claim') {
        throw new Error(`idp.additional "${a.id}" is kind github, whose emailVerification can only be "claim" (GitHub accepts addresses nobody has proven)`);
      }
      a.issuer = '';
    } else if (!a.issuer || typeof a.issuer !== 'string') throw new Error(`idp.additional "${a.id}" needs an issuer`);
    if (!a.clientId) throw new Error(`idp.additional "${a.id}" needs a clientId`);
    if (!a.displayName) throw new Error(`idp.additional "${a.id}" needs a displayName - the chooser button must say which house`);
    if (a.clientSecretRef !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(a.clientSecretRef)) {
      throw new Error(`idp.additional "${a.id}" clientSecretRef must name an env var (UPPER_SNAKE)`);
    }
    a.groupsClaim = a.groupsClaim || cfg.idp.groupsClaim;
    a.claimMap = { ...cfg.idp.claimMap, ...(a.claimMap ?? {}) };
    validateIdpConstraints(`idp.additional "${a.id}"`, a);
  }
  validateIdpConstraints('idp', cfg.idp);
  validateAdmission(cfg.idp);
  const lsd: unknown = cfg.idp.linkedStandingDays;
  if (lsd !== undefined && (typeof lsd !== 'number' || !Number.isInteger(lsd) || lsd < 1 || lsd > 365)) {
    throw new Error(`invalid idp.linkedStandingDays: ${String(lsd)} (whole days, 1-365)`);
  }
  const smtp = cfg.notify.smtp;
  if (smtp) {
    smtp.port = smtp.port ?? 587;
    smtp.secure = smtp.secure ?? false;
    if (!smtp.host || typeof smtp.host !== 'string') throw new Error('notify.smtp needs a host');
    if (!smtp.from || !String(smtp.from).includes('@')) throw new Error('notify.smtp.from must be a mail address');
    if (!Number.isInteger(smtp.port) || smtp.port <= 0 || smtp.port > 65535) throw new Error(`invalid notify.smtp.port: ${smtp.port}`);
  }
  const people = cfg.notify.people;
  if (!people || typeof people !== 'object' || Array.isArray(people)) throw new Error('notify.people must be an object');
  if (typeof people.email !== 'boolean') throw new Error('notify.people.email must be true or false');
  if (people.fromName !== undefined) {
    const name = typeof people.fromName === 'string' ? people.fromName.trim() : '';
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('notify.people.fromName must be a name of 1 to 60 characters on one line');
    }
    people.fromName = name;
  }
  if (cfg.notify.webhook) {
    let u: URL | null = null;
    try { u = new URL(cfg.notify.webhook.url); } catch { /* refused below */ }
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error('notify.webhook.url must be an http(s) URL');
  }
  if (cfg.siem.url !== undefined) {
    let u: URL | null = null;
    try { u = new URL(cfg.siem.url); } catch { /* refused below */ }
    if (!u || !/^https?:$/.test(u.protocol)) throw new Error('siem.url must be an http(s) URL');
  }
  if (!Number.isInteger(cfg.siem.batchSize) || cfg.siem.batchSize < 1 || cfg.siem.batchSize > 1000) {
    throw new Error(`invalid siem.batchSize: ${cfg.siem.batchSize} (1-1000)`);
  }
  if (!Number.isInteger(cfg.siem.intervalSeconds) || cfg.siem.intervalSeconds < 5) {
    throw new Error(`invalid siem.intervalSeconds: ${cfg.siem.intervalSeconds} (>= 5)`);
  }
  const wt = cfg.render.worker.timeoutMs;
  if (cfg.render.worker.url && (!Number.isFinite(wt) || wt <= 0)) throw new Error(`invalid render.worker.timeoutMs: ${wt}`);
  const rl = cfg.rateLimit;
  if (!Number.isFinite(rl.trustedProxyHops) || rl.trustedProxyHops < 0) throw new Error('rateLimit.trustedProxyHops must be >= 0');
  for (const s of ['auth', 'telemetry', 'link', 'automation'] as const) {
    if (rl[s].capacity <= 0 || rl[s].refillPerSec < 0) throw new Error(`rateLimit.${s} needs capacity>0 and refillPerSec>=0`);
  }
  validateProxyAuth(cfg.proxyAuth);
  if (cfg.policy.defaultAccessMode !== 'open' && !cfg.idp.issuer && !cfg.proxyAuth.enabled && !passwordIdpOf(cfg) && !cfg.dev.enabled) {
    throw new Error('gated access needs idp.issuer or proxyAuth.enabled, or a kind password entry in idp.additional (or dev.enabled for local work)');
  }
  const seen = new Set<string>();
  for (const p of cfg.catalogProviders) {
    if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`invalid catalog provider id: ${p.id}`);
    if (seen.has(p.id)) throw new Error(`duplicate catalog provider id: ${p.id}`);
    seen.add(p.id);
    if (!PROVIDER_KINDS.includes(p.kind)) throw new Error(`unknown catalog provider kind: ${p.kind}`);
    if (!p.label) throw new Error(`catalog provider ${p.id} needs a label`);
  }
  const cs = cfg.catalogServing;
  const wholeIn = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (!wholeIn(cs.maxProviderAssets, 1, 10_000_000)) throw new Error(`invalid catalogServing.maxProviderAssets: ${cs.maxProviderAssets} (a whole number, 1-10000000)`);
  if (!wholeIn(cs.pagedProviderThreshold, 1, 10_000_000)) throw new Error(`invalid catalogServing.pagedProviderThreshold: ${cs.pagedProviderThreshold} (a whole number, 1-10000000)`);
  if (!cs.extCache || !wholeIn(cs.extCache.maxBytes, 0, 4 * 1024 ** 3) || !wholeIn(cs.extCache.maxItemBytes, 0, 256 * 1024 ** 2)) {
    throw new Error('catalogServing.extCache needs whole-number maxBytes (0-4 GiB, 0 turns the cache off) and maxItemBytes (0-256 MiB)');
  }
  for (const p of cfg.catalogProviders) {
    const m: unknown = p.sync?.maxAssets;
    if (m !== undefined && !wholeIn(m, 1, 10_000_000)) throw new Error(`catalog provider ${p.id} sync.maxAssets must be a whole number, 1-10000000`);
  }
  if (!Number.isFinite(cfg.delivery.maxBytes) || cfg.delivery.maxBytes <= 0) {
    throw new Error(`invalid delivery.maxBytes: ${cfg.delivery.maxBytes}`);
  }
  const destinationIds = new Set<string>();
  for (const destination of cfg.delivery.destinations) {
    if (!destination.id || !/^[a-z0-9][a-z0-9-]*$/.test(destination.id)) {
      throw new Error(`invalid delivery destination id: ${destination.id}`);
    }
    if (destinationIds.has(destination.id)) throw new Error(`duplicate delivery destination id: ${destination.id}`);
    destinationIds.add(destination.id);
    if (!DELIVERY_DESTINATION_KINDS.includes(destination.kind)) {
      throw new Error(`unknown delivery destination kind: ${destination.kind}`);
    }
    if (!destination.label?.trim()) throw new Error(`delivery destination ${destination.id} needs a label`);
    if (!destination.credentialRef?.trim()) throw new Error(`delivery destination ${destination.id} needs credentialRef`);
    if (!Array.isArray(destination.formats) || !destination.formats.length
      || destination.formats.some((format) => !/^[a-z0-9][a-z0-9-]*$/i.test(format))) {
      throw new Error(`delivery destination ${destination.id} needs a non-empty formats allowlist`);
    }
    destination.formats = [...new Set(destination.formats.map((format) => format.toLowerCase()))];
    if (destination.groups !== undefined && destination.groups !== '*'
      && (!Array.isArray(destination.groups) || destination.groups.some((group) => typeof group !== 'string' || !group.trim()))) {
      throw new Error(`delivery destination ${destination.id} groups must be '*' or non-empty strings`);
    }
    if (destination.maxBytes !== undefined && (!Number.isFinite(destination.maxBytes) || destination.maxBytes <= 0)) {
      throw new Error(`invalid delivery destination ${destination.id} maxBytes: ${destination.maxBytes}`);
    }
    if (destination.approvalChain !== undefined
      && (typeof destination.approvalChain !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(destination.approvalChain))) {
      throw new Error(`invalid delivery destination ${destination.id} approvalChain`);
    }
    if (destination.kind === 's3') {
      const bucket = destination.options?.bucket;
      if (typeof bucket !== 'string' || !bucket.trim()) throw new Error(`s3 delivery destination ${destination.id} needs options.bucket`);
      for (const key of ['endpoint', 'publicBaseUrl'] as const) {
        const raw = destination.options?.[key];
        if (raw === undefined) continue;
        let parsed: URL | null = null;
        try { parsed = new URL(String(raw)); } catch { /* refused below */ }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) {
          throw new Error(`s3 delivery destination ${destination.id} options.${key} must be an http(s) URL`);
        }
      }
    } else if (destination.kind === 'webdav') {
      for (const key of ['url', 'publicBaseUrl'] as const) {
        const raw = destination.options?.[key];
        if (key === 'url' && (typeof raw !== 'string' || !raw.trim())) {
          throw new Error(`webdav delivery destination ${destination.id} needs options.url`);
        }
        if (raw === undefined) continue;
        let parsed: URL | null = null;
        try { parsed = new URL(String(raw)); } catch { /* refused below */ }
        if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
          throw new Error(`webdav delivery destination ${destination.id} options.${key} must be an http(s) collection URL without credentials, query or fragment`);
        }
      }
    } else if (destination.kind === 'https') {
      const raw = destination.options?.url;
      let parsed: URL | null = null;
      try { parsed = new URL(String(raw ?? '')); } catch { /* refused below */ }
      if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error(`https delivery destination ${destination.id} options.url must be an HTTPS URL without embedded credentials or a fragment`);
      }
    }
  }
  if (cfg.blobs.driver !== 'pg' && cfg.blobs.driver !== 's3') throw new Error(`unknown blobs.driver: ${cfg.blobs.driver} (pg | s3)`);
  if (cfg.blobs.driver === 's3' && !cfg.blobs.s3?.bucket) throw new Error('blobs.driver "s3" requires blobs.s3.bucket');
  const sub = cfg.policy.submit;
  if (!Number.isFinite(sub.maxBytes) || sub.maxBytes <= 0) throw new Error(`invalid policy.submit.maxBytes: ${sub.maxBytes}`);
  for (const k of ['bytes', 'count'] as const) {
    if (!Number.isFinite(sub.quota[k]) || sub.quota[k] < 0) throw new Error(`policy.submit.quota.${k} must be >= 0 (0 = unlimited)`);
  }
  const keep = cfg.policy.catalog.versionKeep;
  if (!Number.isFinite(keep) || keep < 0 || !Number.isInteger(keep)) {
    throw new Error(`policy.catalog.versionKeep must be a whole number >= 0 (0 = keep every version): ${keep}`);
  }
  const hook = cfg.submit.scanHook;
  if (hook) {
    if (hook.kind !== 'http' && hook.kind !== 'exec') throw new Error(`unknown submit.scanHook.kind: ${hook.kind} (http | exec)`);
    if (!hook.target) throw new Error('submit.scanHook needs a target (a URL for http, an executable path for exec)');
    if (hook.kind === 'http' && !/^https?:\/\//.test(hook.target)) throw new Error('submit.scanHook.target must be an http(s) URL when kind is "http"');
    hook.timeoutMs = Number.isFinite(hook.timeoutMs) && hook.timeoutMs > 0 ? hook.timeoutMs : 10000;
    if (hook.onError !== 'allow') hook.onError = 'reject'; // fail closed unless the operator says otherwise
    if (hook.args !== undefined && !Array.isArray(hook.args)) throw new Error('submit.scanHook.args must be an array of strings');
  }
  return cfg;
}

export function loadConfig(path = process.env.LW_CONFIG ?? './instance.json'): InstanceConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // The most common first-run failure is running the server before copying
    // the example config. Say what to do instead of surfacing a raw ENOENT.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      throw new Error(`no config at ${path} — copy the example first: cp instance.example.json instance.json (or point LW_CONFIG at your file)`);
    }
    throw err;
  }
  return parseConfig(text);
}

/** Whether the server auto-applies migrations at boot. Env-only (not an
 *  instance.json field) so the flag stays a single source of truth and the
 *  config file remains air-gap-trivial.
 *   - unset ⇒ TRUE: keep the one-command single-node deploy (today's behaviour).
 *   - false/0/off/no/"" ⇒ FALSE: the server runs no DDL and refuses to start on
 *     a pending schema - the invariant that makes multi-replica HA rollouts safe.
 *  Note: set-but-EMPTY (LW_AUTO_MIGRATE=) resolves to false, distinct from unset. */
export function parseAutoMigrate(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LW_AUTO_MIGRATE;
  if (v === undefined) return true;
  return !['0', 'false', 'off', 'no', ''].includes(v.trim().toLowerCase());
}

/** The session VERIFICATION key list: current first, previous (rotation
 *  window) second. Minting never uses this - it always signs current. */
export function sessionKeys(s: Secrets): readonly string[] {
  return s.sessionPrevious ? [s.session, s.sessionPrevious] : [s.session];
}

/** The link verification key list - same contract as sessionKeys. */
export function linkKeys(s: Secrets): readonly string[] {
  return s.linkPrevious ? [s.link, s.linkPrevious] : [s.link];
}

export function loadSecrets(env = process.env, cfg?: Pick<InstanceConfig, 'proxyAuth'> & Partial<Pick<InstanceConfig, 'deployment'>>): Secrets {
  const prod = cfg?.deployment?.mode === 'production' || (cfg?.deployment?.mode !== 'evaluation' && env.NODE_ENV === 'production');
  const need = (name: string): string => {
    const v = env[name];
    if (v) return v;
    if (prod) {
      throw new Error(
        `${name} is required in production. Generate one with \`openssl rand -hex 32\` and set it ` +
          `in the environment (container/compose, the systemd unit, or your secrets manager) - ` +
          `never in instance.json. See docs/install.md and SECURITY.md.`,
      );
    }
    return `dev-only-${randomId(8)}`; // ephemeral: dev sessions die on restart, which is correct
  };
  const secrets: Secrets = { session: need('LW_SESSION_SECRET'), link: need('LW_LINK_SECRET') };
  if (env.LW_SESSION_SECRET_PREVIOUS) secrets.sessionPrevious = env.LW_SESSION_SECRET_PREVIOUS;
  if (env.LW_LINK_SECRET_PREVIOUS) secrets.linkPrevious = env.LW_LINK_SECRET_PREVIOUS;
  if (env.LW_IDP_CLIENT_SECRET) secrets.idpClientSecret = env.LW_IDP_CLIENT_SECRET;
  // The proxy secret's env var is NAMED by config (proxyAuth.secretRef), so it
  // resolves only when the caller passes the config. Required whenever the
  // provider is on: a random fallback would be one the proxy cannot know, so
  // production refuses to boot and development gets a loud warning plus a
  // route that fails closed (every proxy sign-in answers 403).
  if (cfg?.proxyAuth.enabled) {
    const v = env[cfg.proxyAuth.secretRef];
    if (v) secrets.proxyAuth = v;
    else if (prod) {
      throw new Error(`${cfg.proxyAuth.secretRef} is required in production when proxyAuth is enabled - the reverse proxy must inject the same value as x-lw-proxy-auth. See docs/identity.md.`);
    } else {
      console.warn(`[lolly-work] WARNING — proxyAuth is enabled but ${cfg.proxyAuth.secretRef} is not set; every /api/auth/proxy sign-in will be refused.`);
    }
    const bindRef = cfg.proxyAuth.directory?.bindPasswordRef;
    if (bindRef && env[bindRef]) secrets.proxyAuthBind = env[bindRef];
  }
  // Not `need()`: only required once a db-managed provider credential is stored,
  // enforced where sealing happens so credential-free instances need no key.
  if (env.LW_CREDENTIAL_SECRET) secrets.credential = env.LW_CREDENTIAL_SECRET;
  // Not need()-gated: absence means /metrics is loopback-only, the easy-deploy default.
  if (env.LW_METRICS_TOKEN) secrets.metricsToken = env.LW_METRICS_TOKEN;
  // Both notify-channel secrets follow the credential-secret pattern: required
  // only when the matching notify block is configured, enforced at boot.
  if (env.LW_SMTP_PASSWORD) secrets.smtpPassword = env.LW_SMTP_PASSWORD;
  if (env.LW_WEBHOOK_SECRET) secrets.webhook = env.LW_WEBHOOK_SECRET;
  if (env.LW_SIEM_SECRET) secrets.siem = env.LW_SIEM_SECRET;
  if (env.LW_RENDER_WORKER_SECRET) secrets.renderWorker = env.LW_RENDER_WORKER_SECRET;
  if (env.LW_C2PA_SIGNING_KEY) secrets.c2paSigningKey = env.LW_C2PA_SIGNING_KEY;
  if (env.LW_CATALOG_SIGNING_KEY) secrets.catalogSigningKey = env.LW_CATALOG_SIGNING_KEY;
  return secrets;
}
