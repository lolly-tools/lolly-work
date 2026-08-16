# lolly-work

The Lolly **control plane** - identity and provisioning, governance, online services,
telemetry analytics. Open source under the **Mozilla Public License 2.0** ([MPL-2.0](LICENSE));
designed to be hosted by an organisation (SUSE first), brand-agnostic so any deployment is
just config + a pack mount.

> **The compass:** OSS = individual freedom · OSS + control plane = organizational freedom.
> Lolly renders on-device by design; everything hosted lives here (the public MCP server is
> the one exception).

## Getting started

A running web UI + CLI, dead easy - pick your path in **[INSTALL.md](INSTALL.md)**:

- **See it now, install nothing** - the hosted sandbox at <https://lolly.work> (passwordless
  personas, governed console, live GET renders).
- **Evaluate locally** - `npm install && npm run demo` (Node 24+) → a fully-seeded governed
  deployment at <http://localhost:8787>.
- **Deploy for real** - self-hosted: single host ([systemd](INSTALL.md#3-bare-metal-systemd) /
  [Compose](INSTALL.md#4-container-compose)) or [Kubernetes/Helm](INSTALL.md#5-kubernetes-helm).
  **The safest, most sovereign path is the SUSE stack** - **SLES + SUSE Rancher Prime** (paid) or
  **openSUSE Leap + Rancher Community** (free): SUSE's reproducible builds + governed EU (Prague)
  supply chain, air-gappable, no US hyperscaler (`docs/deployment.md` → *Sovereignty*).

The hosted demo runs on Vercel today for convenience only (moving to a European sovereign cloud);
it is never the deployment model. Prerequisites and per-OS steps (SLES / openSUSE Leap / macOS)
are in [INSTALL.md](INSTALL.md); the full operator set is in `docs/` (below).

## Documentation

Two sets, different jobs:

- **`docs/`** - operator and administrator documentation for a *deploy*: quickstart,
  deployment shapes, the full config reference, identity, roles/grants, governance,
  catalog, approvals, rendering/sharing, telemetry, audit, operations runbook, API and
  CLI references, and an honest status page. Start at [`docs/README.md`](docs/README.md).
  **Every page is served in the console at `/admin#/docs`**, so whoever runs a deploy
  doesn't need this repository - `docs/docs.json` is the manifest that surface reads.

The open-source half of Lolly documents itself at **`/info/`** on any Lolly deployment;
the console links there when this deploy serves or points at one (`instance.appUrl` /
`instance.shellDir`).

## Layout

```
docs/           operator documentation (also served at /admin#/docs)
server/src/     the app - zero-dependency Node (node:http, node:crypto, native TS)
  config/       instance.json loader (+ env secrets)
  iam/          OIDC (generic, Keycloak-first), HMAC tokens, member/guest sessions
  rbac/         roles + fine-grained grants evaluator
  policy/       tool overlays (input locking), org-config payload assembly
  links/        signed expiring revocable links (share/embed/download/guest-edit)
  audit/        hash-chained append-only log
  telemetry/    ingest (attr allowlist, attribution policy at the door), rollups
  inbox/        message bridge audience targeting
  fleet/        X-Lolly-Client parsing + version registry
  store/        storage seam: memory driver now, Postgres next (migrations/ has the schema)
  render/       cache-key contract (render pipeline itself lands next)
  api/          router + the HTTP app
migrations/     Postgres schema v0
deploy/compose/ single-VM shape (Dockerfile + docker-compose)
packs/          deployment pack mount (data, never committed)
```

## Run it

```bash
cp instance.example.json instance.json   # dev provider enabled, gated mode
node server/src/main.ts                  # → http://localhost:8787

# sign in (dev provider), then poke around:
curl -i 'http://localhost:8787/api/auth/dev?email=dev@example.test'   # → session cookie
curl -s http://localhost:8787/healthz
```

```bash
npm test             # node:test over tests/ (Postgres conformance runs when LW_TEST_DATABASE_URL is set)
npm run typecheck    # tsc --noEmit (needs devDependencies installed)
```

**Admin console:** `http://localhost:8787/admin` - dashboards (activity, top tools,
formats, fleet), links, messages, audit (hash-chain view), people, and **Docs** (this
repo's `docs/`, rendered in-console). Light/dark, no build step, no external assets.

**Admin CLI** (same API as the console, parity by construction):

```bash
npm run cli -- login --email dev@example.test
npm run cli -- summary          # or: whoami · fleet · audit verify
npm run cli -- links --all
npm run cli -- msg send --title "Update by Aug 15" --severity action --shells tauri --max-engine 1.52.99
```

**Postgres:** set `DATABASE_URL` and migrations auto-apply on boot; without it the
memory store runs (evaluation semantics - state resets on restart).

Secrets come from env (`LW_SESSION_SECRET`, `LW_LINK_SECRET`, `LW_IDP_CLIENT_SECRET`);
in dev they fall back to ephemeral randoms - sessions die on restart, which is correct.

## Demo lolly-work

There are two entrypoints, and they don't share state - pick the one that matches what
you're showing. The store is in-memory either way (unless `DATABASE_URL` is set), so
seeded/created data evaporates on restart.

**`npm run demo` - the full self-contained demo** (see `DEMO.md` for detail). Builds its
own config (it ignores `instance.json`), seeds everything - 4 personas, tool overlays,
an approval chain, projects/sessions, catalog lifecycle, messages, telemetry, fleet,
links, approvals - and serves the *built* web shell from the sibling OSS repo
(`../lolly`, or `LOLLY_OSS_DIR`) same-origin at `/`. Same-origin is what activates the
in-shell employee governance UX: the sign-in gate, locked tool inputs, and the
**locked user profile** (identity fields IdP-locked, feature-flag toggles hidden).

```bash
npm run demo    # → http://localhost:8787 (PORT=8788 for another port)
```

Sign-in links are printed at boot (dev provider, no passwords). To demo the locked
profile: sign in as `marketer@suse.example`, open the profile view in the shell - 
firstname/lastname/email/title render padlocked (`mode: locked, source: idp` in
`GET /api/v1/org-config`). The admin console is at `/admin` - sign in as
`admin@suse.example`. A shell dist built before the org governance module makes the
demo fall back to `open` mode (data + console still demo; the in-shell governance UX
needs a fresh `npm run build:web` in the OSS repo - the demo never builds anything).

**`npm start` - split development.** Boots from `instance.json` with an *empty* store:
control plane + console on :8787, your own Lolly dev server (e.g. Vite on :5173)
separately. Set `instance.appUrl` (e.g. `"http://localhost:5173"`) so the console's
"Open Lolly" and deep links point at your dev shell, and `instance.pack` at a real pack
mount (e.g. the OSS repo) so the Design-system tab and console theming show the actual
brand tokens instead of the neutral fallback. Cross-origin means no shared session
cookie - the in-shell governance UX won't activate here; use `npm run demo` for that.

## What's implemented vs pending

| Done (tested) | Pending (planned, in order) |
|---|---|
| Deployment config + secrets, OIDC login (discovery/PKCE/JWKS-verified), dev provider, member+guest sessions with domain-separated tokens | Chromium worker tier (hooked/HTML-heavy tools; fast path refuses them by default - `render.allowHooksInFastPath` is the curated-pack interim) |
| **Render plane v1** - fourth HostV1 shell: real engine via file:-linked `@lolly/engine` (interim until the publish pipeline), jsdom fast path, svg+png (resvg), policy-checked (`INPUT_LOCKED`, locked values baked), LRU + ETag, share/embed/download links serve bytes, brick-pattern PREVIEW watermark | Engine publish pipeline in the OSS repo (replaces the file: links) |
| RBAC evaluator (roles + grants, deny-wins), tool overlays (editable/choice/locked/hidden, hidden = absent), org-config payload with ETag + SUSE profile-lock defaults | Catalog channels/expiry sweeps |
| Links: mint/verify/expire/revoke, passwords (scrypt), guest-edit admission flow with TTL caps | Sessions/projects sync |
| Catalog serving from the pack mount, per-caller visibility filtering | Vercel trial: **scaffolded** (`api/` + `vercel.json` + `deploy/vercel/README.md`) - project creation + deploy pending |
| **Approvals engine** - chains (any/quorum/all), approver nomination from the eligible team, separation of duties, per-user inbox notifications, console Approvals view (`migrations/0002`) | |
| Telemetry ingest (closed attr allowlist, opt-in attribution enforced at ingest), rollups + dashboard summary | SCIM, SAML, collab gateway |
| Inbox targeting (groups × shell × engine-version), fleet registry from `X-Lolly-Client` | CLI device-code login against OIDC (dev-provider + pasted-cookie today) |
| **Postgres store driver** + migrations runner (shared conformance suite; PG run gated on `LW_TEST_DATABASE_URL`) | |
| **Org-config + preview-as-group** - the one polled document (`GET /api/v1/org-config`), plus `GET /api/v1/org-config/preview?groups=…`, console `#/preview`, and `lw preview`: an admin/brand author sees the exact role, permissions, tool/input governance, and profile policy a member in any group set would receive - computed through the same assembler the live client polls, so it can't drift | |
| **Grants editor** - console `#/grants` + `lw grants` + `GET/POST/DELETE /api/v1/grants` under `grant.edit` (admin), with the owner-only escalation guard (grants touching `instance.config`/`catalog.provider.credential` need the owner role); deny-wins effects live on the next request; audited | |
| **Tool policy control plane** - console `#/tools` view + `GET /api/v1/policy/tools` / `PUT /api/v1/policy/overlays/:toolId`: visibility groups, per-input rules (lock to preset / restrict to choices / hide), watermark enforcement; `policy.edit` grantable to brand groups; audited with before/after, render cache busted on save | |
| **Admin console** at `/admin` - overview dashboards, fleet, links (revoke), messages (compose + reach), audit chain view, people | |
| **Admin CLI** `lw` - login/whoami/summary/fleet/links/msg/audit-verify over the same API | |
| **Catalog providers** - federate Brandfolder/S3/git/… read-only into the catalog: DB-backed control plane (console `#/providers` + `lw providers`), sealed write-only credentials (`LW_CREDENTIAL_SECRET`), exposure governance (groups/sections/approved), lifecycle overlays on `ext/*` ids, `/api/v1/catalog/search` with live fan-out. Drivers: Brandfolder, S3 (hand-rolled SigV4), git (raw-HTTP manifest), Dropbox, Google Drive, O365/Graph (refresh-token OAuth via `lw providers auth` PKCE loopback flow), mock. **Export provenance**: C2PA-shaped ingredients embedded in SVG (`<metadata>`) and PNG (iTXt) exports + `x-lolly-provenance` header - "«filename» from «provider»" travels even when the upstream has no C2PA | Real C2PA signing; provider fragment hashes → render cache keys |

### Third-party provider terms

Catalog providers are **integrations, not replacements**: the external system stays the
source of truth and lolly consumes read-only inside its own workflow. Every deployment
brings its own API tokens/OAuth apps (none ship in this repo), drivers use only publicly
documented endpoints, and provider names appear descriptively only - this project
*includes an integration for* Brandfolder etc., and is not affiliated with those services.

House rules carried from the OSS repo: zero-dep server style (the `services/ca`/`services/mcp`
pattern), engine consumed pinned and unmodified when it arrives, no SUSE strings in code - 
the deployment name lives in `instance.json`.

## License

lolly-work is licensed under the **Mozilla Public License 2.0** - see [`LICENSE`](LICENSE).
The vendored Lolly engine (`vendor/@lolly/engine`, `vendor/@lolly-tools/core`) is also
MPL-2.0, consumed as a pinned, unmodified snapshot. Bundled third-party code keeps its own
permissive licenses (MIT / BSD / Apache-2.0) and fonts are OFL-1.1; every required notice is
reproduced in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) with the machine-readable
graph in `sbom.cdx.json`.
