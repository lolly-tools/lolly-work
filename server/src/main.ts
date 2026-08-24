/**
 * Standalone entry - node:http around the app handler. The same handler
 * wraps into a Vercel function (deploy/vercel, when the trial project lands)
 * and the container image unchanged.
 *
 *   LW_CONFIG=./instance.json PORT=8787 node server/src/main.ts
 */
import { createServer } from 'node:http';
import { loadConfig, loadSecrets, parseAutoMigrate } from './config/instance.ts';
import { createMemoryStore } from './store/memory.ts';
import { createPostgresStore } from './store/postgres.ts';
import { createMemoryBlobStore } from './blobs/memory.ts';
import { createPostgresBlobStore } from './blobs/postgres.ts';
import { createS3BlobStore } from './blobs/s3.ts';
import { runMigrations, pendingMigrations } from './store/migrate.ts';
import { buildApp } from './api/app.ts';
import { createCollabGateway } from './collab/gateway.ts';
import { createNearbyRegistry } from './collab/nearby.ts';
import { createSiemForwarder } from './observability/siem.ts';
import { runRetention } from './audit/retention.ts';
import { createNotifier } from './notify/notify.ts';
import { expiringCredentials } from './catalog/credential-expiry.ts';
import { auditHead } from './audit/head.ts';
import { checkShellDist } from './lib/shell-dist.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConfigDocument, buildConfigDocument, diffConfigDocument, commitConfigApply, canonicalHash, diffSummary } from './policy/config-doc.ts';

const config = loadConfig();
const secrets = loadSecrets();

// The pack is read lazily per request, so a wrong path used to boot cleanly and
// then serve an empty catalog with no signal anywhere. Say it once at boot.
if (!existsSync(resolve(config.instance.pack))) {
  console.warn(`[lolly-work] WARNING — no pack at ${resolve(config.instance.pack)} (instance.pack = "${config.instance.pack}"). The catalog will be empty until this path exists; packs/demo ships in this repo.`);
}

// The dev provider is a passwordless bypass of OIDC. An instance that has a real
// issuer AND leaves it on is almost always a half-finished cutover, and nothing
// else in the system would ever mention it.
if (config.dev.enabled && config.idp.issuer) {
  console.warn(`[lolly-work] WARNING — dev.enabled is true while idp.issuer is set (${config.idp.issuer}). /api/auth/dev is a passwordless admin bypass and is still live. Set "dev": { "enabled": false } before exposing this instance.`);
}

// Governance UX must not silently vanish: under a non-open access mode, a shell
// dist that is missing or predates the org/ governance module would serve
// employees WITHOUT the session gate + locked-input UX - the instance looks
// governed while the shell enforces nothing. Refuse to start instead (same
// posture as the pending-schema guard below); LW_ALLOW_STALE_SHELL=1 downgrades
// the refusal to a loud warning for dev/dogfooding.
if (config.instance.shellDir && config.policy.defaultAccessMode !== 'open') {
  const shell = checkShellDist(config.instance.shellDir);
  if (!shell.present || !shell.hasOrgConfig) {
    const why = shell.present
      ? `shell dist at ${config.instance.shellDir} predates the org governance module (no org-config marker in assets/*.js)`
      : `no shell dist at ${config.instance.shellDir} (index.html missing)`;
    if (process.env.LW_ALLOW_STALE_SHELL === '1') {
      console.warn(`[lolly-work] WARNING — ${why}; serving it anyway (LW_ALLOW_STALE_SHELL=1). This shell enforces NO session gate or locked-input UX.`);
    } else {
      console.error(`[lolly-work] REFUSING TO START — ${why}. Access mode is '${config.policy.defaultAccessMode}' but this shell cannot enforce it: employees would get no session gate or locked-input UX.`);
      console.error('[lolly-work] Rebuild the shell (npm run build:web in the OSS repo) and redeploy it, or set LW_ALLOW_STALE_SHELL=1 to serve the stale dist with a loud warning.');
      process.exit(1);
    }
  }
}
// DATABASE_URL → Postgres; unset → memory store (evaluation semantics: boot,
// click around, gone on restart). With Postgres, LW_AUTO_MIGRATE (default true)
// keeps the single-node one-command deploy by auto-applying at boot; set it false
// for HA rollouts, where the server runs no DDL and refuses to start on a pending
// schema (migrate explicitly with `npm run migrate` / `lw migrate` first).
const databaseUrl = process.env.DATABASE_URL;
const store = databaseUrl
  ? await (async () => {
      if (parseAutoMigrate()) {
        const applied = await runMigrations(databaseUrl);
        if (applied.length) console.log(`[lolly-work] migrations applied: ${applied.join(', ')}`);
      } else {
        const pending = await pendingMigrations(databaseUrl);
        if (pending.length) {
          console.error(`[lolly-work] REFUSING TO START — ${pending.length} pending migration(s): ${pending.join(', ')}`);
          console.error('[lolly-work] LW_AUTO_MIGRATE is off. Run `npm run migrate` (or `lw migrate`) against this database, then restart.');
          process.exit(1);
        }
        console.log('[lolly-work] schema current (auto-migrate off)');
      }
      return createPostgresStore(databaseUrl);
    })()
  : createMemoryStore();

// Optional one-command governance seed (plan Rec 2): apply a policy-as-code
// document at boot. Trusted (filesystem access), so it bypasses the owner-only
// HTTP guard and may seed owner-only grants; it never enables providers or stores
// credentials (those aren't in the document). Idempotent - safe to leave set.
if (process.env.LW_SEED_CONFIG) {
  const parsed = validateConfigDocument(JSON.parse(readFileSync(process.env.LW_SEED_CONFIG, 'utf8')));
  if ('errors' in parsed) throw new Error(`LW_SEED_CONFIG invalid: ${parsed.errors.join('; ')}`);
  const current = await buildConfigDocument(store);
  const configIds = new Set((await store.listProviders()).filter((p) => p.managedBy === 'config').map((p) => p.id));
  const diff = diffConfigDocument(current, parsed.doc, { prune: false }, configIds);
  if (diff.conflicts.length) throw new Error(`LW_SEED_CONFIG touches config-managed providers: ${diff.conflicts.join(', ')}`);
  await commitConfigApply(store, diff, 'system');
  await store.appendAudit({ at: new Date().toISOString(), actor: 'system', action: 'config.apply', subject: `config:${canonicalHash(parsed.doc).slice(0, 16)}`, payload: { seed: true, ...diffSummary(diff) } });
  console.log('[lolly-work] applied LW_SEED_CONFIG');
}

// Live collaboration rides the SAME server as the router - nothing in the HTTP
// app handles `upgrade`, so the collab gateway hooks it here and path-matches
// like a route (plans/14 §6, OSS plans/100 §7). Any upgrade that is not a collab
// socket is destroyed rather than left hanging. Built BEFORE `buildApp` so its
// room registry can be injected into the HTTP app as `listCollabRooms` - the
// admin console's `GET /api/v1/collab/rooms` (see app.ts's `AppDeps`).
const collab = createCollabGateway({ config, store, secrets });

// Instance-mediated "nearby" (plans/26 §8): an in-memory presence registry, wired
// ONLY here in the long-lived process. The Vercel function never constructs it, so
// the two `/api/v1/collab/nearby` routes answer 501 there - an in-memory registry
// cannot span function instances (app.ts's `AppDeps.nearby`).
const nearby = createNearbyRegistry();

// BlobStore for instance-owned catalog bytes (plans/26 §2, plans/27 §5): the
// configured driver - s3 (any S3-compatible store) when chosen, else the PG
// default (zero moving parts), else memory when there is no database at all.
const blobs = config.blobs.driver === 's3'
  ? createS3BlobStore(
      config.blobs.s3 ?? (() => { throw new Error('blobs.driver is "s3" but blobs.s3 config is missing'); })(),
      process.env.LW_BLOBS_S3_CREDENTIAL,
    )
  : databaseUrl
    ? await createPostgresBlobStore(databaseUrl)
    : createMemoryBlobStore();

const app = buildApp({ config, store, secrets, blobs, listCollabRooms: () => collab.snapshot(), nearby });

// External anchoring of the audit chain (plan Rec 5): emit the head hash so any
// log pipeline captures it off-box. On by default (boot + hourly); intervalMinutes
// 0 disables the timer. Unref'd so it never keeps the process alive on shutdown.
const logAuditHead = async () => {
  const h = await auditHead(store);
  console.log(`[lolly-work] audit head seq=${h.seq} hash=${h.hash} count=${h.count} intact=${h.chainIntact}`);
};
if (config.audit.headLog.onBoot) await logAuditHead();
if (config.audit.headLog.intervalMinutes > 0) {
  setInterval(() => void logAuditHead(), config.audit.headLog.intervalMinutes * 60_000).unref();
}

// Retention (plans/35 wave 3): boot + daily, only when a policy is stated.
// The same runRetention the POST /api/v1/retention/run route calls, so a
// serverless deploy crons the route with a service token and gets identical
// behaviour.
if (config.policy.retention.telemetryDays > 0 || config.policy.retention.auditDays > 0) {
  const runIt = async (): Promise<void> => {
    const r = await runRetention({ config, store });
    if (r.telemetryTrimmed || r.auditTrimmed) {
      console.log(`[lolly-work] retention: trimmed ${r.telemetryTrimmed} telemetry, ${r.auditTrimmed} audit`);
    }
  };
  await runIt();
  setInterval(() => void runIt().catch((e: Error) => console.error(`[lolly-work] retention failed: ${e.message}`)), 24 * 60 * 60 * 1000).unref();
}

// Credential expiry (plans/36 §2): the daily nudge beside the always-on
// surfaces (provider rows, console chip, the expiry-days gauge). Threshold-
// crossing only, so each stated expiry is mentioned a handful of times, never
// nagged daily; silent without notify egress, like everything notify-shaped.
{
  const expiryNotifier = createNotifier({ config, secrets });
  const checkExpiry = async (): Promise<void> => {
    const expiring = expiringCredentials(await store.listProviders());
    if (!expiring.length) return;
    const owners = (await store.listUsers()).filter((u) => u.role === 'owner' && !u.disabledAt);
    for (const e of expiring) {
      const when = e.daysLeft <= 0 ? 'has reached its stated expiry' : `expires in ${e.daysLeft} day(s)`;
      console.warn(`[lolly-work] provider credential ${when}: ${e.id} (${e.kind})`);
      expiryNotifier.email(owners.map((u) => u.email),
        `Provider credential ${e.daysLeft <= 0 ? 'expired' : 'expiring'}: ${e.label}`,
        `The credential for provider "${e.label}" (${e.id}, ${e.kind}) ${when} (${e.expiresAt.slice(0, 10)}).\n\nRotate it: ${config.instance.baseUrl}/admin#/providers`);
      expiryNotifier.event('provider.credential.expiring', { id: e.id, kind: e.kind, daysLeft: e.daysLeft, expiresAt: e.expiresAt });
    }
  };
  await checkExpiry();
  setInterval(() => void checkExpiry().catch((e: Error) => console.error(`[lolly-work] credential expiry check failed: ${e.message}`)), 24 * 60 * 60 * 1000).unref();
}

// SIEM forwarding (plans/35 wave 2): audit events pushed to the org's receiver
// in signed batches, replayed from the durable cursor on any failure. Long-
// lived server only, same reasoning as nearby - a function instance has no
// place to keep the loop (the growing lw_siem_lag gauge says so out loud, and
// a service token polling GET /api/v1/audit is the supported path there).
if (config.siem.url) {
  const siem = createSiemForwarder({ config, secrets, store });
  await siem.tick();
  siem.start();
  console.log(`[lolly-work] siem forwarding to ${config.siem.url} every ${config.siem.intervalSeconds}s`);
}

const port = Number(process.env.PORT ?? 8787);

const server = createServer((req, res) => void app(req, res));
server.on('upgrade', (req, socket, head) => {
  if (!collab.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(port, () => {
  console.log(`[lolly-work] ${config.instance.name} on :${port} (${config.policy.defaultAccessMode}, telemetry=${config.policy.telemetry}/${config.policy.telemetryAttribution})`);
});

// ORDERLY SHUTDOWN. `drain()` quiesces every live room into a session revision,
// and the gateway's own doc comment says "a host that wants the writes to LAND
// awaits this before exiting" - this is the host doing that. Without it every
// SIGTERM (a rolling deploy, a pod eviction, Ctrl-C) kills live rooms
// un-quiesced, and the crash-recovery fallback is bounded at SNAPSHOT_EVERY_OPS
// and is discarded outright if any ordinary PUT bumps the rev after the restart - 
// so up to 500 ops of collaborative work would go, silently, on a routine deploy.
//
// Deployments must give this time to run: set `terminationGracePeriodSeconds`
// above the worst-case drain (one revision write per live room).
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lolly-work] ${signal} — draining ${collab.rooms()} live collab room(s)`);
  server.close(); // stop accepting; in-flight requests finish
  try {
    await collab.drain();
  } catch (err) {
    console.error('[lolly-work] collab drain failed:', (err as Error)?.message ?? err);
  }
  collab.close(); // sockets + sweeper; the rooms are already gone
  console.log('[lolly-work] drained');
  process.exit(0);
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
