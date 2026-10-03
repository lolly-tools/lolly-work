/**
 * Vercel Function bootstrap for the lolly-work control plane
 * (plans/01-architecture.md §4, "Vercel trial (interim, decided 2026-07-21)").
 *
 * Builds the SAME `buildApp()` handler server/src/main.ts wires for node:http
 * and deploy/compose's container - once per warm Lambda instance, memoised
 * on a module-scope promise so concurrent requests in the same instance
 * share one app/store rather than racing separate boots.
 *
 * ── Store ──────────────────────────────────────────────────────────────────
 * DATABASE_URL unset  → createMemoryStore(). This is PER-INSTANCE-EPHEMERAL
 *   on serverless: every cold start (scale-to-zero, redeploy, multi-instance
 *   fan-out under load) gets its own empty store, and state never survives a
 *   restart. Fine for smoke tests ("does auth/telemetry/links work at all?"),
 *   NOT fine for anything you want to persist. Do not point real users at a
 *   memory-store deployment.
 * DATABASE_URL set    → runMigrations() once per cold start, then
 *   createPostgresStore(). Neon Postgres (EU region, via the Vercel
 *   Marketplace) is the trial's real store - see deploy/vercel/README.md for
 *   provisioning. This is the path that should be live in practice.
 *   Migrations run over DATABASE_URL_UNPOOLED when the integration sets it:
 *   DATABASE_URL is Neon's pooled URL there, and Neon documents migrations as
 *   a job for the direct connection (store/migrate.ts migrationDatabaseUrl).
 *
 * ── Boot deadline ──────────────────────────────────────────────────────────
 * Every request on a warm instance awaits the one shared boot. A boot that
 * never settles (a database that never answers, a lock that is never granted)
 * used to hold every request on that instance until the platform's 300 s
 * function timeout (lolly.ing, 2026-10-03). getApp() now gives a boot
 * BOOT_DEADLINE_MS (LW_BOOT_TIMEOUT_MS overrides it): past that the waiting
 * requests fail, the shared promise is cleared and the next request starts a
 * fresh boot.
 *
 * ── Config ─────────────────────────────────────────────────────────────────
 * LW_CONFIG_JSON carries the whole instance.json as a JSON string (Vercel env
 * vars are strings, not files - see deploy/vercel/README.md). Unset falls
 * back to FALLBACK_CONFIG_JSON below: dev.enabled=false, defaultAccessMode
 * 'gated', and a deliberately-inert idp.issuer placeholder (parseConfig
 * throws if gated + dev.enabled=false + no issuer - see
 * server/src/config/instance.ts - so a bare fallback needs a non-empty,
 * unresolvable issuer to stay valid). Net effect in evaluation mode: with no
 * LW_CONFIG_JSON set, the deployment answers /healthz and serves static
 * console assets, but nothing that needs a real sign-in works. In production
 * mode ("auto", the fallback's setting, means production whenever
 * NODE_ENV=production in the function environment) the setup checks below refuse the fallback
 * outright. Either way it fails closed, not open, until someone sets real
 * config.
 *
 * ── Production refusals and blobs ──────────────────────────────────────────
 * boot() runs assessSetup and selects the blob store exactly as
 * server/src/main.ts does. A deployment that must boot with a memory store or
 * the development login (the public demo) says so with
 * `"deployment": { "mode": "evaluation" }` in LW_CONFIG_JSON.
 *
 * ── Static/catalog serving TODO ────────────────────────────────────────────
 * The admin console (../../console/) and the Postgres migrations
 * (../../migrations/) are plain data files, not `import`ed, so Vercel's
 * dependency-tracing bundler won't include them unless vercel.json's
 * `functions["api/index.ts"].includeFiles` names them explicitly (it does - 
 * see ../../vercel.json). The instance's brand-pack/catalog mount
 * (`instance.pack`, served from /catalog/*) is NOT bundled the same way:
 * packs/ is gitignored data (never committed - see .gitignore), so there is
 * nothing real to bundle today. TODO: a real pack mount on Vercel needs an
 * LW_PACK env (URL or blob-store key) the wrapper fetches/hydrates from
 * instead of `config.instance.pack` pointing at a local path - not built
 * yet; catalog serving on this deploy target is a known gap until then.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

import { parseConfig, loadSecrets } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { demoGrants, seedStore, seedActivity, demoRooms } from '../../scripts/demo.ts';
import { createPostgresStore } from '../../server/src/store/postgres.ts';
import { migrationDatabaseUrl, runMigrations } from '../../server/src/store/migrate.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { parseBackgroundPollMs } from '../../server/src/renders/runner.ts';
import { assessSetup } from '../../server/src/setup/checks.ts';
import { createMemoryBlobStore } from '../../server/src/blobs/memory.ts';
import { createPostgresBlobStore } from '../../server/src/blobs/postgres.ts';
import { createS3BlobStore } from '../../server/src/blobs/s3.ts';
import { deriveAuditMacKey } from '../../server/src/audit/chain.ts';
import type { Store } from '../../server/src/store/types.ts';

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Minimal, deliberately-inert default - see header comment. Written out in
// full (rather than relying on config/instance.ts's own DEFAULTS merge)
// so the fallback shape is visible here, next to the deploy wrapper that
// uses it.
const FALLBACK_CONFIG_JSON = JSON.stringify({
  instance: {
    name: 'Lolly Work (unconfigured trial)',
    baseUrl: process.env.LW_BASE_URL ?? 'https://lolly.work',
    pack: './packs/demo',
  },
  idp: {
    issuer: 'https://unconfigured.invalid/set-LW_CONFIG_JSON',
    clientId: '',
    groupsClaim: 'groups',
    claimMap: { firstname: 'given_name', lastname: 'family_name', email: 'email', title: 'title' },
  },
  policy: {
    defaultAccessMode: 'gated',
    telemetry: 'standard',
    telemetryAttribution: 'opt-in',
    guestLinks: { enabled: true, maxTtlHours: 168, defaultTtlHours: 72 },
  },
  dev: { enabled: false, users: [] },
});

// Repo-root-relative, resolved from this file's own location (not
// process.cwd(), which is not a safe assumption to make about a Lambda's
// working directory) - same pattern server/src/api/app.ts already uses for
// consoleDir.
// When bundled for Vercel (scripts/build-vercel-fn.mjs), the whole graph collapses
// into one file, so every module's import.meta.url points at the bundle, not its
// original source depth. The bundle's banner sets `globalThis.__LW_FN_ROOT` to the
// function directory and the data dirs (migrations/console/docs/packs) are copied
// in as its siblings - so resolve against that when present, else the source-relative
// path the local `node` run uses.
const FN_ROOT = (globalThis as { __LW_FN_ROOT?: string }).__LW_FN_ROOT;
const dataDir = (rel: string): string =>
  FN_ROOT ? fileURLToPath(new URL(rel, FN_ROOT)) : fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const migrationsDir = dataDir('migrations/');

async function boot(): Promise<NodeHandler> {
  const config = parseConfig(process.env.LW_CONFIG_JSON ?? FALLBACK_CONFIG_JSON);

  // Resolve a repo-relative `instance.pack` (e.g. "packs/demo", a bundled pack
  // named in LW_CONFIG_JSON) to an absolute path from THIS file's own location - 
  // the Lambda's cwd is not a safe base, same reasoning as migrationsDir above.
  // An absolute pack path (a real filesystem mount) is left untouched. This is
  // the bundled-pack answer to the LW_PACK TODO in this file's header: the demo
  // pack ships in the Function via vercel.json's includeFiles, so no fetch is
  // needed - only a location-correct path.
  if (config.instance.pack && !isAbsolute(config.instance.pack)) {
    const rel = config.instance.pack.replace(/^\.?\/*/, '');
    (config.instance as { pack: string }).pack = dataDir(`${rel}/`);
  }

  const secrets = loadSecrets(process.env, config);

  // The same production refusals server/src/main.ts applies before it serves
  // anything: in production mode (deployment.mode "production", or "auto" with
  // NODE_ENV=production in the function environment) a memory store, the development
  // login, an ungoverned access mode, short secrets or an incompatible pack fail
  // the boot. Evaluation mode reports the same findings as warnings. The thrown
  // error makes getApp() reject, so every request answers 500 until the
  // configuration is corrected; the failed checks are in the function log.
  const setup = await assessSetup(config, secrets, !!process.env.DATABASE_URL?.trim());
  // Production warnings, as main.ts logs them: findings that do not stop the
  // boot but need an operator's eye, such as an open admission policy. Written
  // before the refusal check so a refused boot reports them too. Each message
  // names a setting and a remedy, never a secret value.
  if (setup.mode === 'production') {
    for (const check of setup.checks.filter(check => check.status === 'warning')) console.warn(`[lolly-work/vercel] WARNING ${check.id}: ${check.message}`);
  }
  if (!setup.ready) {
    for (const check of setup.checks.filter(check => check.status === 'fail')) console.error(`[lolly-work/vercel] ${check.id}: ${check.message}`);
    for (const tool of setup.pack.tools.filter(tool => !tool.valid)) console.error(`[lolly-work/vercel] tool ${tool.id}: ${tool.diagnostics.join(' ')}`);
    throw new Error('Production setup validation failed. Correct the reported settings before starting.');
  }
  console.log(`[lolly-work/vercel] deployment mode=${setup.mode}; storage=${process.env.DATABASE_URL ? 'postgres' : 'memory'}${setup.mode === 'evaluation' && !process.env.DATABASE_URL ? ' (lost on restart)' : ''}`);

  const databaseUrl = process.env.DATABASE_URL;
  let store: Store;
  // The console's Rooms panel reads live collab rooms through this callback. Only
  // the demo seed provides a (synthetic) one - a real deploy's rooms live in the
  // ws gateway process, which the serverless function never runs.
  let listCollabRooms: (() => ReturnType<typeof demoRooms>) | undefined;
  if (databaseUrl) {
    const applied = await runMigrations(migrationDatabaseUrl() ?? databaseUrl, migrationsDir);
    if (applied.length) console.log(`[lolly-work/vercel] migrations applied: ${applied.join(', ')}`);
    store = await createPostgresStore(databaseUrl);
  } else if (config.dev.enabled) {
    // Demo sandbox: seed the in-memory store with the same rich fixture the local
    // `pnpm run demo` uses, so the console feels like a live deploy - RBAC grants,
    // tool overlays, an approval chain, feature-flag governance, injectables, two
    // projects with sessions, catalog-lifecycle rows and inbox messages. The seeded
    // users share the `dev:<email>` subs the passwordless login upserts, so persona
    // sign-in inherits the seeded ownership. In-memory is per-instance-ephemeral, so
    // this re-seeds on every cold start - which keeps every instance consistently
    // populated.
    //
    // seedActivity() then adds the RUNTIME activity the dashboards a signed-in
    // visitor first lands on are built from - usage telemetry (charts, attributed
    // timeline, leaderboards), the fleet, shared links, and four approvals across
    // every inbox state. Locally that activity comes from demo.ts's seedViaHttp
    // burst, which needs a running server; serverless has none at boot, so it is
    // written straight to the store here instead. demoRooms() likewise stands in
    // for the ws gateway's live-room registry, so the Rooms panel is populated too.
    console.warn('[lolly-work/vercel] DATABASE_URL not set + dev.enabled — in-memory store with the demo seed + activity (ephemeral; resets on redeploy)');
    store = createMemoryStore({ grants: demoGrants() });
    const seeded = await seedStore(store);
    const activity = await seedActivity(store, seeded);
    listCollabRooms = () => demoRooms(seeded);
    console.log(`[lolly-work/vercel] demo activity seeded — ${activity.telemetryEvents} telemetry events, ${activity.fleetClients} fleet buckets, ${activity.links} links, ${activity.approvals} approvals, ${demoRooms(seeded).length} live rooms`);
  } else {
    console.warn('[lolly-work/vercel] DATABASE_URL not set — bare in-memory store (per-instance-ephemeral, smoke tests only)');
    store = createMemoryStore();
  }
  // Keyed audit MAC, as main.ts sets it. Without it every row this function
  // appends carries no MAC, and verification can only count them as unkeyed.
  // (The demo seed above is written first, so its rows stay unkeyed; that is
  // tolerated by verifyChain and matches what the demo always did.)
  store.setAuditMacKey?.(deriveAuditMacKey(secrets.session));

  // Blob store for instance-owned catalog bytes, selected exactly as main.ts
  // does: s3 when configured, else Postgres whenever there is a database (so
  // uploads survive cold starts and redeploys), else memory.
  const blobs = config.blobs.driver === 's3'
    ? createS3BlobStore(
        config.blobs.s3 ?? (() => { throw new Error('blobs.driver is "s3" but blobs.s3 config is missing'); })(),
        process.env.LW_BLOBS_S3_CREDENTIAL,
      )
    : databaseUrl
      ? await createPostgresBlobStore(databaseUrl)
      : createMemoryBlobStore();

  // LW_BACKGROUND_POLL_MS as main.ts reads it: the durable automation runner
  // polls the database every second while a warm instance lives unless this is
  // set (0: on submission only), which keeps a scale-to-zero database awake.
  const backgroundPollMs = parseBackgroundPollMs(process.env.LW_BACKGROUND_POLL_MS);
  // No collab gateway runs in a function, so the shell must not offer live rooms.
  return buildApp({ config, store, secrets, blobs, listCollabRooms, liveCollab: false,
    ...(backgroundPollMs !== undefined ? { backgroundPollMs } : {}) });
}

const BOOT_DEADLINE_MS = 30_000;
/** setTimeout fires at once for a delay above this. */
const MAX_TIMER_MS = 2_147_483_647;

/** The boot deadline in milliseconds: LW_BOOT_TIMEOUT_MS when it is a positive
 *  integer (capped at the longest delay a timer holds, so a huge value means
 *  "practically never", not "at once"), else BOOT_DEADLINE_MS. */
export function bootDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.LW_BOOT_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_TIMER_MS) : BOOT_DEADLINE_MS;
}

/** A memoised boot with a deadline. Concurrent callers share one attempt; a
 *  success is kept; a failure, or an attempt still unsettled after
 *  `deadlineMs`, rejects every waiting caller and clears the memo, so the next
 *  call starts a fresh attempt. An abandoned attempt keeps running in the
 *  background and its result is dropped. */
export function memoisedBoot<T>(start: () => Promise<T>, deadlineMs: () => number): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current) return current;
    const ms = deadlineMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`boot did not finish within ${ms} ms; the next request starts a fresh boot`)), ms);
      timer.unref?.();
    });
    const attempt: Promise<T> = Promise.race([start(), deadline])
      .finally(() => clearTimeout(timer))
      .catch((err: unknown) => {
        // Let the next request retry a fresh boot instead of caching a permanent failure.
        if (current === attempt) current = null;
        throw err;
      });
    current = attempt;
    return attempt;
  };
}

/** Module-scope singleton: build the app once per warm instance. */
export const getApp: () => Promise<NodeHandler> = memoisedBoot(boot, () => bootDeadlineMs());
