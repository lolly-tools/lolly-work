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
import { PROVIDER_KINDS, type ProviderExposure, type ProviderKind, type ProviderMapping, type ProviderSyncConfig } from '../catalog/providers/types.ts';
import type { ClaimMap } from '../iam/oidc.ts';

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
  };
  idp: {
    issuer: string;
    clientId: string;
    groupsClaim: string;
    claimMap: ClaimMap;
    /** Human name for the sign-in button and "managed by …" copy - e.g.
     *  "Keycloak", "SUSE ID", "ZITADEL". Any OIDC issuer works (open and
     *  sovereign providers first-class); absent → the console says "SSO". */
    displayName: string;
  };
  policy: {
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
     *  cookie Max-Age. Shorter is safer: it bounds how long an uncaught revocation
     *  (group/role change, offboarding) can ride before it self-expires. Account
     *  disable is instant regardless (per-request check in memberOf). */
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
  catalogProviders: ConfigCatalogProvider[];
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
  };
  /** SIEM forwarding (plans/35 wave 2): audit events pushed to the org's own
   *  receiver in signed batches, loss-free behind the siem_cursor. `url`
   *  absent = off. Long-lived server only; the HMAC key rides LW_SIEM_SECRET. */
  siem: { url?: string; batchSize: number; intervalSeconds: number };
  rateLimit: RateLimitConfig;
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
}

export interface Secrets {
  session: string;
  link: string;
  idpClientSecret?: string;
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
}

const DEFAULTS: InstanceConfig = {
  // The default pack is the small demo pack committed at packs/demo, so an
  // unconfigured instance serves a real catalog instead of an empty one.
  instance: { name: 'Lolly Work', baseUrl: 'http://localhost:8787', pack: './packs/demo' },
  idp: {
    issuer: '',
    clientId: '',
    groupsClaim: 'groups',
    claimMap: { firstname: 'given_name', lastname: 'family_name', email: 'email', title: 'title' },
    displayName: '',
  },
  policy: {
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
  },
  render: { allowHooksInFastPath: false, worker: { url: '', timeoutMs: 20000 }, c2pa: { certFile: '', claimGenerator: '' } },
  audit: { headLog: { onBoot: true, intervalMinutes: 60 } },
  rateLimit: {
    enabled: true, trustedProxyHops: 0, maxBuckets: 50000,
    auth: { capacity: 10, refillPerSec: 0.2 },
    telemetry: { capacity: 120, refillPerSec: 4 },
    link: { capacity: 30, refillPerSec: 1 },
  },
  dev: { enabled: false, users: [] },
  catalogProviders: [],
  blobs: { driver: 'pg' },
  notify: {},
  siem: { batchSize: 200, intervalSeconds: 30 },
  submit: {},
};

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

export function parseConfig(json: string): InstanceConfig {
  const raw = JSON.parse(json) as Partial<InstanceConfig>;
  const cfg = merge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>) as unknown as InstanceConfig;
  const mode = cfg.policy.defaultAccessMode;
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
  const smtp = cfg.notify.smtp;
  if (smtp) {
    smtp.port = smtp.port ?? 587;
    smtp.secure = smtp.secure ?? false;
    if (!smtp.host || typeof smtp.host !== 'string') throw new Error('notify.smtp needs a host');
    if (!smtp.from || !String(smtp.from).includes('@')) throw new Error('notify.smtp.from must be a mail address');
    if (!Number.isInteger(smtp.port) || smtp.port <= 0 || smtp.port > 65535) throw new Error(`invalid notify.smtp.port: ${smtp.port}`);
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
  for (const s of ['auth', 'telemetry', 'link'] as const) {
    if (rl[s].capacity <= 0 || rl[s].refillPerSec < 0) throw new Error(`rateLimit.${s} needs capacity>0 and refillPerSec>=0`);
  }
  if (cfg.policy.defaultAccessMode !== 'open' && !cfg.idp.issuer && !cfg.dev.enabled) {
    throw new Error('gated access needs idp.issuer (or dev.enabled for local work)');
  }
  const seen = new Set<string>();
  for (const p of cfg.catalogProviders) {
    if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`invalid catalog provider id: ${p.id}`);
    if (seen.has(p.id)) throw new Error(`duplicate catalog provider id: ${p.id}`);
    seen.add(p.id);
    if (!PROVIDER_KINDS.includes(p.kind)) throw new Error(`unknown catalog provider kind: ${p.kind}`);
    if (!p.label) throw new Error(`catalog provider ${p.id} needs a label`);
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

export function loadSecrets(env = process.env): Secrets {
  const prod = env.NODE_ENV === 'production';
  const need = (name: string): string => {
    const v = env[name];
    if (v) return v;
    if (prod) throw new Error(`${name} is required in production`);
    return `dev-only-${randomId(8)}`; // ephemeral: dev sessions die on restart, which is correct
  };
  const secrets: Secrets = { session: need('LW_SESSION_SECRET'), link: need('LW_LINK_SECRET') };
  if (env.LW_IDP_CLIENT_SECRET) secrets.idpClientSecret = env.LW_IDP_CLIENT_SECRET;
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
  return secrets;
}
