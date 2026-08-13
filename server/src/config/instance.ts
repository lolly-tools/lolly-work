/**
 * Instance configuration (plans/01 §4). One JSON file + secrets from env.
 * (YAML support arrives with the deps decision; JSON keeps the scaffold
 * zero-dependency and air-gap-trivial.)
 *
 * Secrets are NEVER in the config file:
 *   LW_SESSION_SECRET  — sessions/guests/state tokens (required in prod)
 *   LW_LINK_SECRET     — link signatures (required in prod)
 *   LW_IDP_CLIENT_SECRET — OIDC client secret (when the IdP requires one)
 *   LW_CREDENTIAL_SECRET — master key sealing stored provider credentials
 *                          (required in prod only once a credential is stored)
 *   <credentialRef>      — config-managed catalog providers name their own env
 *                          var per entry; resolved at boot, never persisted
 */
import { readFileSync } from 'node:fs';
import { randomId } from '../lib/crypto.ts';
import { PROVIDER_KINDS, type ProviderExposure, type ProviderKind, type ProviderMapping, type ProviderSyncConfig } from '../catalog/providers/types.ts';
import type { ClaimMap } from '../iam/oidc.ts';

/** A deploy-time (GitOps/air-gap) provider entry — upserted at boot with
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

export interface InstanceConfig {
  instance: {
    name: string;
    baseUrl: string;
    pack: string;
    /** Optional path to a built Lolly web shell (shells/web/dist). When set, the
     *  instance serves the shell at `/` so the whole product is ONE origin —
     *  session cookies work and the shell's org/ seam activates. Absent → the
     *  console (/admin) and API are served, but not the shell. Boot check: under
     *  a non-open defaultAccessMode the server refuses to start when this dist
     *  is missing or predates the org/ governance module (lib/shell-dist.ts);
     *  LW_ALLOW_STALE_SHELL=1 downgrades the refusal to a loud warning. */
    shellDir?: string;
    /** Optional URL of the Lolly app when it is NOT served same-origin via
     *  shellDir — e.g. a Vite dev server (http://localhost:5173) or a split
     *  deploy. The console routes its "Open Lolly" and tool/session/project
     *  deep links through this. Absent → links stay same-origin (`/`). */
    appUrl?: string;
  };
  idp: {
    issuer: string;
    clientId: string;
    groupsClaim: string;
    claimMap: ClaimMap;
    /** Human name for the sign-in button and "managed by …" copy — e.g.
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
     *  on — it discloses nothing a member did not opt into. Force off to keep the whole
     *  surface dark fleet-wide. */
    nearby: { enabled: boolean };
    /** Member session lifetime (hours) — sets both the signed-token exp and the
     *  cookie Max-Age. Shorter is safer: it bounds how long an uncaught revocation
     *  (group/role change, offboarding) can ride before it self-expires. Account
     *  disable is instant regardless (per-request check in memberOf). */
    sessionTtlHours: number;
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
   * keeps the zero-moving-parts single-node deploy — PG works everywhere the
   * plane runs. `s3` points at any S3-compatible store (AWS, MinIO, Ceph RGW)
   * for media-sized estates and the air-gap story; the credential is env-only
   * (LW_BLOBS_S3_CREDENTIAL = "<accessKeyId>:<secretAccessKey>").
   */
  blobs: {
    driver: 'pg' | 's3';
    s3?: { bucket: string; region?: string; endpoint?: string; prefix?: string };
  };
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
  /** Master key for sealed provider credentials — absent until the operator sets it. */
  credential?: string;
  /** Bearer token for /metrics. Absent ⇒ metrics are loopback-only (never public). */
  metricsToken?: string;
  /** Shared HMAC key for the Chromium render worker. Absent ⇒ no worker dispatch. */
  renderWorker?: string;
  /** PKCS#8 private-key PEM for the instance C2PA signer. Absent ⇒ unsigned exports. */
  c2paSigningKey?: string;
}

const DEFAULTS: InstanceConfig = {
  instance: { name: 'Lolly Work', baseUrl: 'http://localhost:8787', pack: './packs/example' },
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
  return cfg;
}

export function loadConfig(path = process.env.LW_CONFIG ?? './instance.json'): InstanceConfig {
  return parseConfig(readFileSync(path, 'utf8'));
}

/** Whether the server auto-applies migrations at boot. Env-only (not an
 *  instance.json field) so the flag stays a single source of truth and the
 *  config file remains air-gap-trivial.
 *   - unset ⇒ TRUE: keep the one-command single-node deploy (today's behaviour).
 *   - false/0/off/no/"" ⇒ FALSE: the server runs no DDL and refuses to start on
 *     a pending schema — the invariant that makes multi-replica HA rollouts safe.
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
  if (env.LW_RENDER_WORKER_SECRET) secrets.renderWorker = env.LW_RENDER_WORKER_SECRET;
  if (env.LW_C2PA_SIGNING_KEY) secrets.c2paSigningKey = env.LW_C2PA_SIGNING_KEY;
  return secrets;
}
