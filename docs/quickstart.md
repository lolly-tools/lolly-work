# Quickstart

Node 24+ is the only prerequisite. The server is zero-build (it runs TypeScript natively)
and has no external assets, so a checkout runs as-is.

## 1. The fastest look: demo mode

```bash
npm run demo          # → http://localhost:8787   (PORT=8788 for another port)
```

`npm run demo` builds its **own** config - it ignores `instance.json` - and seeds a whole
governed deploy: four personas, tool overlays, an approval chain, projects and sessions,
catalog lifecycle rows, messages, telemetry, fleet entries, links and approvals. It serves
the *built* Lolly web shell from the sibling OSS checkout (`../lolly`, or `LOLLY_OSS_DIR`)
same-origin at `/`.

Same-origin is the point: it is what activates the in-shell employee governance UX - the
sign-in gate, locked tool inputs, and the locked profile (identity fields IdP-managed,
feature-flag toggles hidden). Sign-in links print at boot; no passwords.

- Web shell: `/` - sign in as `marketer@suse.example` to see the locked profile.
- Console: `/admin` - sign in as `admin@suse.example`.
- Docs (this set): `/admin#/docs`.

The demo never builds anything. If the OSS `shells/web/dist` predates the `org/` governance
module, the demo falls back to `open` access mode and says so - run `npm run build:web` in
the OSS repo to get the governance UX. See `DEMO.md` for the full script.

## 2. A real (small) deploy

```bash
cp instance.example.json instance.json   # dev provider on, gated access mode
node server/src/main.ts                  # or: npm start  → http://localhost:8787
```

Then set the three things that make it yours:

| Set | To | Why |
|---|---|---|
| `instance.pack` | a real brand pack mount | the catalog, design tokens, console theming and tools all come from here |
| `instance.shellDir` | a built `shells/web/dist` | serves Lolly at `/` on one origin, so session cookies work and governance activates |
| `idp.issuer` + `idp.clientId` | your OIDC issuer | replaces the dev provider with real SSO ([identity](identity.md)) |

Full key reference: [configuration](configuration.md).

```bash
curl -i 'http://localhost:8787/api/auth/dev?email=dev@example.test'   # dev-provider session
curl -s http://localhost:8787/healthz
```

Under a non-`open` access mode the server **refuses to start** if `shellDir` points at a
missing or pre-governance dist, rather than silently serving an un-governed shell.
`LW_ALLOW_STALE_SHELL=1` downgrades that to a loud warning.

## 3. Persistence

```bash
export DATABASE_URL=postgres://…     # migrations auto-apply at boot
npm run migrate:status               # or: npm run migrate
```

Without `DATABASE_URL` the in-memory store runs and everything resets on restart - correct
for evaluation, never for a real deploy. Both drivers pass one shared conformance suite.
For multi-replica rollouts, turn boot DDL off (`LW_AUTO_MIGRATE=false`) and run migrations
as a job - see [operations](operations.md).

## 4. Split development

```bash
npm start                     # control plane + console on :8787
# your own Lolly dev server (e.g. Vite) on :5173
```

Set `instance.appUrl` to `http://localhost:5173` so the console's "Open Lolly" and its
tool/session/project deep links point at your dev shell, and point `instance.pack` at a
real pack so the Design-system tab shows actual brand tokens. Cross-origin means no shared
session cookie, so the in-shell governance UX will not activate - use `npm run demo` for
that.

## 5. Secrets

Secrets are never in the config file. In production these are required:

```bash
LW_SESSION_SECRET=…      # member/guest/state tokens
LW_LINK_SECRET=…         # link signatures
```

In dev, both fall back to ephemeral randoms - sessions die on restart, which is correct.
Everything else is optional until the feature is used (`LW_IDP_CLIENT_SECRET`,
`LW_CREDENTIAL_SECRET`, `LW_METRICS_TOKEN`, `LW_RENDER_WORKER_SECRET`,
`LW_C2PA_SIGNING_KEY`). See [configuration](configuration.md).

## 6. Seed governance in one command

Governance is exportable and re-appliable as a single document, so a fresh deploy can come
up already governed:

```bash
npm run cli -- export --out governance.json     # from a configured deploy
LW_SEED_CONFIG=./governance.json npm start      # into a fresh one (idempotent)
```

See [governance](governance.md) for what the document does and does not carry.

## Checks

```bash
npm test           # node:test over tests/ (Postgres leg runs when LW_TEST_DATABASE_URL is set)
npm run typecheck  # tsc --noEmit
npm run sbom       # regenerate sbom.cdx.json
```
