# Configuration reference

One JSON file (`instance.json`, or `LW_CONFIG` / `LW_CONFIG_JSON`) plus environment
secrets. Unset keys take the defaults below - `instance.example.json` is a working starting
point, and `server/src/config/instance.ts` is the authority.

![Feature-flag governance - default state and toggle visibility, per user](shots/feature-flags.svg)

**Secrets are never in the config file.** Config is safe to keep in git; secrets come from
the environment.

## `instance`

| Key | Default | What it does |
|---|---|---|
| `name` | `Lolly Work` | the deploy's display name (console rail, sign-in card, `/healthz`) |
| `baseUrl` | `http://localhost:8787` | the URL this deploy answers on. Drives OIDC redirect URIs and the `Secure` cookie flag - **must** match reality |
| `pack` | `./packs/example` | the brand pack mount: catalog, tools, design tokens, fonts, logos |
| `shellDir` | *unset* | path to a built Lolly `shells/web/dist`. Set ⇒ the shell is served at `/` on one origin (session cookies work, the shell's `org/` governance seam activates) |
| `appUrl` | *unset* | where the Lolly app lives when it is *not* same-origin (a Vite dev server, a split deploy). The console routes "Open Lolly" and deep links through it |

Under a non-`open` access mode, a `shellDir` that is missing or predates the `org/`
governance module **stops boot**. `LW_ALLOW_STALE_SHELL=1` downgrades it to a warning.

## `idp`

| Key | Default | What it does |
|---|---|---|
| `issuer` | `""` | OIDC issuer URL; discovery does the rest. Any compliant issuer works |
| `clientId` | `""` | the client this deploy authenticates as |
| `displayName` | `""` | human name on the sign-in button ("Keycloak", "SUSE ID", "ZITADEL"). Empty ⇒ "SSO" |
| `groupsClaim` | `groups` | the claim carrying group membership |
| `claimMap` | `given_name` / `family_name` / `email` / `title` | which claims fill firstname, lastname, email, title |

Gated access needs `idp.issuer` - or `dev.enabled` for local work. The server refuses to
start otherwise. See [identity](identity.md).

## `policy`

| Key | Default | What it does |
|---|---|---|
| `defaultAccessMode` | `gated` | `open` (anonymous catalog), `gated` (sign-in required), `per-tool` |
| `telemetry` | `standard` | `off`, `aggregate`, `standard` |
| `telemetryAttribution` | `opt-in` | `opt-in` strips the user id until the user consents; `default` attributes at `standard` |
| `guestLinks.enabled` | `true` | whether guest-edit links may be minted at all |
| `guestLinks.maxTtlHours` | `168` | hard cap on any guest link's lifetime |
| `guestLinks.defaultTtlHours` | `72` | the default offered when minting |
| `sessionTtlHours` | `12` | member session lifetime (token `exp` and cookie `Max-Age`); must be > 0 and ≤ 720 |

Shorter `sessionTtlHours` is safer: it bounds how long an uncaught revocation (group change,
offboarding) can ride. Account *disable* is instant regardless - it is checked per request.

## `render`

| Key | Default | What it does |
|---|---|---|
| `allowHooksInFastPath` | `false` | whether the in-process jsdom path may run a tool's `hooks.js`. Default refuses hooked tools with `501 HOOKED_TOOL_NEEDS_CHROMIUM` instead of running untrusted code in-realm. Turn on only for a pack you curate end to end |
| `worker.url` | `""` | the Chromium render worker. Set (with `LW_RENDER_WORKER_SECRET`) ⇒ hooked/HTML-heavy tools dispatch there instead of `501`. **This pair is the render-topology switch** - the deployment's capability set is advertised to shells via org_config's `render` block either way ([deployment](deployment.md)) |
| `worker.timeoutMs` | `20000` | per-job timeout |

The worker itself takes `LW_RENDER_MAX_CONCURRENT` (default `4`, Helm
`renderWorker.maxConcurrent`): its per-pod render/rasterise cap. At capacity it answers
`503 RENDER_BUSY` + `Retry-After` immediately - no internal queueing, so saturation stays
visible to the HPA - and drops out of readiness (`/readyz`) until a slot frees.
| `c2pa.certFile` | `""` | signing-cert chain PEM (leaf first), public |
| `c2pa.claimGenerator` | `""` | producer label in the signed manifest |

Worker HMAC key and C2PA private key are secrets - see below and [c2pa](c2pa.md).

## `audit`

| Key | Default | What it does |
|---|---|---|
| `headLog.onBoot` | `true` | print the audit-chain head hash at boot |
| `headLog.intervalMinutes` | `60` | print it periodically (0 = off). The timer is unref'd, so it never holds the process open |

Anchoring the head off-box is the truncation defence, and the defaults do it for you: any
log pipeline that keeps stdout is an external anchor - see [audit](audit.md).

## `dev`

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | enables `/api/auth/dev?email=…`, a passwordless local provider |
| `users` | `[]` | `{ email, name?, groups? }` entries the dev provider will admit |

**Keep this off in production.** It bypasses OIDC entirely.

## `rateLimit`

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | per-IP token buckets on the auth, telemetry and link surfaces |
| `trustedProxyHops` | `0` | how many reverse proxies to trust in `X-Forwarded-For`. `0` reads only the socket peer. Behind one ingress, set `1` |
| `maxBuckets` | `50000` | bucket table cap |
| `auth` | `capacity 10, refillPerSec 0.2` | sign-in attempts |
| `telemetry` | `capacity 120, refillPerSec 4` | event ingest |
| `link` | `capacity 30, refillPerSec 1` | signed-link resolution |

## `catalogProviders`

Deploy-time (GitOps / air-gap) provider entries, upserted at boot as `managedBy: 'config'`
and read-only in the API. Each entry: `id` (lowercase, dash-separated), `kind`, `label`,
optional `credentialRef` (the *name* of the env var holding the secret), `enabled`,
`options`, `mapping`, `exposure`, `sync`. Duplicate ids, unknown kinds and missing labels
are startup errors. See [catalog](catalog.md).

## Environment variables

### Secrets

| Var | When | What |
|---|---|---|
| `LW_SESSION_SECRET` | required in prod | member/guest/state token HMAC key |
| `LW_LINK_SECRET` | required in prod | link signature key |
| `LW_IDP_CLIENT_SECRET` | if your IdP issues one | OIDC confidential client secret |
| `LW_CREDENTIAL_SECRET` | once a provider credential is stored | master key sealing credentials at rest (AES-256-GCM) |
| `LW_METRICS_TOKEN` | to scrape remotely | bearer token for `/metrics`. Unset ⇒ loopback-only |
| `LW_RENDER_WORKER_SECRET` | with a render worker | shared HMAC key; must match the worker |
| `LW_C2PA_SIGNING_KEY` | to sign exports | PKCS#8 private-key PEM |
| `<credentialRef>` | per config-managed provider | resolved at boot, never persisted |

In development, `LW_SESSION_SECRET` and `LW_LINK_SECRET` fall back to ephemeral randoms, so
sessions die on restart. In production (`NODE_ENV=production`) their absence throws.

### Everything else

| Var | Default | What |
|---|---|---|
| `LW_CONFIG` | `./instance.json` | config file path |
| `LW_CONFIG_JSON` | - | whole config as a string (Vercel path) |
| `DATABASE_URL` | - | Postgres. Unset ⇒ in-memory store (evaluation only) |
| `LW_AUTO_MIGRATE` | `true` when unset | boot-time DDL. `false`/`0`/`off`/`no`/empty ⇒ no DDL and refuse to start on a pending schema (the HA invariant) |
| `LW_SEED_CONFIG` | - | path to a governance document applied at boot; trusted and idempotent ([governance](governance.md)) |
| `LW_ALLOW_STALE_SHELL` | - | `1` downgrades the stale-shell boot refusal to a warning |
| `PORT` | `8787` | listen port |
| `NODE_ENV` | - | `production` makes secret checks fail-closed |
| `LW_TEST_DATABASE_URL` | - | enables the Postgres conformance leg in `npm test` |
| `LOLLY_OSS_DIR` | `../lolly` | where `npm run demo` finds the built OSS web shell |

## Changing configuration

Config is read at boot: edit and restart (Helm: update the ConfigMap and roll). Anything
you want to change *without* a restart belongs in governance - grants, overlays, chains,
feature flags, provider exposure - which is live-editable in the console and exportable as
code. See [governance](governance.md).
