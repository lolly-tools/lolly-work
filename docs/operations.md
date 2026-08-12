# Operations runbook

Day-two work: schema, replicas, backup, limits, monitoring, upgrades.

![Broadcast messages — announcements and notices targeted by group, shell and engine version](shots/broadcast-messages.svg)

## Store and schema

Two drivers behind one seam, both passing a single shared conformance suite:

| Driver | When | Notes |
|---|---|---|
| memory | no `DATABASE_URL` | evaluation only — state dies with the process and replicas do not share it |
| Postgres 16/17 | `DATABASE_URL` set | the production driver |

```bash
npm run migrate            # apply pending migrations
npm run migrate:status     # exit 1 if anything is pending
lw migrate [--check]       # same, run where the database is reachable (not via LW_BASE)
GET /api/v1/system/migrations      # pending list — owner-gated (instance.config)
```

Migrations are `migrations/*.sql`, applied in filename order, tracked in
`schema_migrations`, each file in its own transaction.

### Single node vs HA

- **Single node** (local, Compose): leave `LW_AUTO_MIGRATE` unset. The server applies pending
  migrations at boot — one command, no separate step.
- **HA / multiple replicas**: set `LW_AUTO_MIGRATE=false`. No replica runs DDL (concurrent
  auto-migrate races), and the server **refuses to start on a pending schema**. A single
  migrate Job owns the schema — the Helm chart wires this as a pre-install/pre-upgrade hook
  that must succeed before new pods roll, so a skipped migration fails loudly instead of
  serving a half-migrated database.

### Replicas

The app holds no local state: sessions, guests and state tokens are HMAC-signed and all
durable data is in Postgres, so replicas are interchangeable **provided every replica shares
the same `LW_SESSION_SECRET` and `LW_LINK_SECRET`**. That is why the chart refuses to
generate them: a per-replica secret would fail signature checks and log everyone out on
every rollout.

The render cache is per-process (an in-process LRU). Replicas simply warm independently.

## Secret rotation

| Secret | Rotation cost |
|---|---|
| `LW_SESSION_SECRET` | forced global logout — there is no dual-key window today |
| `LW_LINK_SECRET` | every outstanding signed link stops verifying |
| `LW_CREDENTIAL_SECRET` | stored provider credentials can no longer be unsealed; re-enter them |
| `LW_METRICS_TOKEN` | update the scraper |
| `LW_RENDER_WORKER_SECRET` | rotate app and worker together |
| `LW_C2PA_SIGNING_KEY` | new signatures use the new identity; old exports stay verifiable against the old chain |

Generate once (`openssl rand -hex 32`), store in your platform's secret manager, rotate
deliberately.

## Backup and restore

Postgres is the entire durable state. Back it up with your normal Postgres practice
(point-in-time recovery if you have it) and keep two things beside it:

- the current `instance.json` (config, safe to keep in git — it holds no secrets), and
- an exported governance document (`lw export`), which is the reproducible half of the
  deploy.

The pack and the shell dist are build artefacts you can rebuild; recording *which* versions
were in service matters more than backing up the bytes. The audit head is already anchored
off-box by default — the server prints it to stdout at boot and hourly, so your log pipeline
holds it; keep a snapshot beside the backup too ([audit](audit.md)).

Restore drill: fresh database → run migrations → `LW_SEED_CONFIG=./governance.json` →
mount the same pack → point at the same IdP. Provider credentials must be re-entered (they
are sealed under `LW_CREDENTIAL_SECRET`, so keeping that key is what makes a restore
credential-complete).

## Rate limiting

Per-IP token buckets on three surfaces: auth, telemetry, link. Behind a reverse proxy set
`rateLimit.trustedProxyHops` to the number of proxies you actually terminate — `0` means
never trust `X-Forwarded-For`, and getting this wrong either rate-limits the whole world as
one client or lets a header spoof the limiter. Authenticated console and API paths are not
throttled.

## Monitoring

```
GET /healthz     unauthenticated, cheap — liveness and readiness both use it
GET /metrics     Prometheus; loopback-only unless LW_METRICS_TOKEN is set
```

Gauges worth alerting on:

| Gauge | Alert when |
|---|---|
| `lw_audit_chain_intact` | `0` — investigate immediately |
| `lw_provider_last_error` | `1` for a provider you depend on |
| `lw_provider_assets` | drops sharply (an exposure or upstream change) |
| `lw_rate_limit_buckets` | approaching `rateLimit.maxBuckets` |
| `lw_process_resident_memory_bytes` | trending up across a render-heavy day |

The Helm chart's ServiceMonitor needs `metricsToken`, because `/metrics` is loopback-only
without one.

## Upgrades

1. Read the migration list in the release and run `npm run migrate:status` against production.
2. Roll the image. On the HA path the migrate Job runs first and must succeed.
3. Watch `/healthz` readiness — a pod refusing to start on a pending schema is the guard
   working, not a flake.
4. Check `lw audit head` and the chain gauge afterwards.

### The engine pin

The open-source engine is vendored, pinned and unmodified; `engine-pin.json` records the pin
and `npm run verify:engine-pin` (which runs automatically before `npm test`) fails if the
vendored tree and the pin disagree. Re-pinning is a deliberate act: bump the pin, run the
suite, check the bridge-contract version label, commit. Letting the pin drift far behind is a
known maintenance risk — see [status](status.md).

#### Re-pin cadence

`npm run repin-engine` reports drift against the sibling OSS checkout (`LOLLY_OSS_DIR`, or
`../lolly` next to this repo): commits behind OSS HEAD and pinned vs current engine/core
versions. It is read-only and cheap — run it in CI or before a release to see how stale the
pin is.

`npm run repin-engine -- --apply` performs the re-pin: it backs up `vendor/` and the pin to
a temp dir, runs the OSS repo's `scripts/pack-engine.ts`, extracts the fresh tarballs into
`vendor/`, adopts the new manifest as `engine-pin.json`, syncs the lockfile, then proves
coherence with `npm run verify:engine-pin` and `npm test`. Any failure restores the previous
vendor tree and pin, so the working copy is never left half-vendored. After a successful
apply, review the diff (including the bridge-contract version label) and commit.

### The shell dist

If you serve the web shell (`instance.shellDir`), its freshness is part of the upgrade. Under
a non-`open` access mode the server refuses to boot on a missing or pre-governance dist,
because a stale shell would serve employees without the session gate and locked-input UX
while the deploy looks governed. `LW_ALLOW_STALE_SHELL=1` downgrades it to a loud warning —
use it knowingly, briefly.

## Checks and artefacts

```bash
npm test                     # node:test over tests/
LW_TEST_DATABASE_URL=… npm test   # adds the Postgres conformance leg
npm run typecheck
npm run sbom                 # regenerate sbom.cdx.json (CycloneDX)
```

CI workflows live in `.github/workflows/`. The Postgres leg only runs when
`LW_TEST_DATABASE_URL` is set — if your pipeline does not set it, that driver is effectively
untested.

## Related

- Install-time choices: [deployment](deployment.md)
- Every key and variable: [configuration](configuration.md)
- Chain anchoring: [audit](audit.md)
- Known gaps: [status](status.md)
