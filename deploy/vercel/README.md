# Vercel trial deploy (lolly.work)

The "Vercel trial (interim, decided 2026-07-21)" shape. A deploy *target* for the same code the Helm chart and `deploy/compose/` run — not
a second product. Trial-grade: EU data region, opt-in telemetry attribution.

> **Demo host, not a sovereign deployment.** Vercel (+ the Cloud Run render worker in §4a)
> host the public **lolly.work** demo and the blank-brand starter — a convenience to get a
> public URL up fast. They are **temporary**: the demo + blank brand move to a trusted
> **European sovereign cloud** (likely **Evroc**; partnership in progress). For a governed
> sovereign deployment, use the **SUSE stack** — **SLES + SUSE Rancher Prime** (paid) or
> **openSUSE Leap + Rancher Community** (free) — via `deploy/helm` (`docs/deployment.md` →
> *Sovereignty*): no US hyperscaler, no `gcloud`, no Vercel. A US team may be happy on Vercel;
> a sovereignty customer never touches it.

**How it builds:** `vercel.json` sets one `buildCommand` → `scripts/build-vercel-fn.mjs`,
which esbuild-bundles the app into a plain-JS function, packages the pinned engine's public
exports (including brand policy and production checks), and
emits it via Vercel's **Build Output API** (`.vercel/output/`). This is required, not
cosmetic: the repo runs `.ts` natively (every import carries a `.ts` extension) and Vercel's
zero-config transpile leaves those specifiers dangling, and Node refuses to type-strip the
engine under `node_modules` — so the whole graph must be bundled to JS. The build runs on
Vercel (Linux) so native modules (`@resvg/resvg-js` and `sharp`) get the right binaries; it can't
be prebuilt from macOS. The entry is `api/_index.ts` (underscore-prefixed so Vercel's
zero-config function detector ignores it and only the Build Output API applies);
`api/_lib/bootstrap.ts` builds the app. This file is the operational runbook.

The function runtime is pinned to Node 24, matching the server's requirement. CI runs
`pnpm run build:vercel` then `pnpm run check:vercel` on Linux before deployment. The check
disables `require(ESM)` to match the hosted runtime, loads every engine export from the
generated package, exercises jsdom parsing/selectors/styles, boots the bundled function,
checks console modules and setup/organization configuration, and renders an SVG through
the real engine. The build converts jsdom's ESM-only dependencies to compatible CommonJS
entries in the output package; jsdom's worker/data files and dependency license files
remain included. The installed packages and vendored engine remain untouched.
The check uses an isolated evaluation fixture with no inherited database or instance
credentials. A local macOS build can run this check locally; only the Linux build is
suitable for uploading to Vercel.

**Deploy:** `vercel deploy --prod` from a linked checkout — it uploads the working tree and
runs the buildCommand on Vercel. (Git-connected auto-deploy works too, but only once the
build files are committed to the branch.)

## 1. Create the project

Create a **new, separate** Vercel project for this — **never** the OSS `bt` project
(parent plan §7.5). From this repo:

```bash
vercel link            # when prompted, choose "Create a new project"
```

Name it something like `lolly-work` (distinct from any OSS project). Root Directory
stays the repo root (`.`) — the wrapper lives at `/vercel.json` + `/api`, not a subdir.

## 2. Environment variables

Set these on the Vercel project (Project Settings → Environment Variables, or
`vercel env add <name>`):

| Var | Required | Notes |
|---|---|---|
| `LW_SESSION_SECRET` | yes (prod) | session/guest/state token HMAC key |
| `LW_LINK_SECRET` | yes (prod) | share/embed/download/guest-edit link signatures |
| `LW_CONFIG_JSON` | yes | the whole `instance.json` as one JSON string. Unset, the function uses a gated, dev-disabled placeholder (`api/_lib/bootstrap.ts`) whose `deployment.mode` is `auto`, which counts as production whenever the function sees `NODE_ENV=production` (expect that on Vercel). In production the placeholder fails the storage and identity checks, the function refuses to boot, every request (`/healthz` included) answers 500, and the function log names each failed check by id. Only a config that sets `"deployment": { "mode": "evaluation" }` boots without a database and answers `/healthz`. **For the public demo sandbox, use `deploy/vercel/lolly-work.config.json` verbatim** (see section 5): it wires the bundled demo pack, `open` render access, the four passwordless demo personas and evaluation mode |
| `DATABASE_URL` | yes for real data | Neon Postgres, **EU region**, via the Vercel Marketplace integration (`vercel:marketplace` skill, or Storage tab → Marketplace Database Providers → Neon). Unset **+ `dev.enabled`** → in-memory store **seeded with the full demo fixture** (governance + activity + mock live rooms — §5), so a signed-in visitor lands on populated dashboards; per-instance-ephemeral, so it re-seeds on every cold start and resets on redeploy. Unset **+ no `dev.enabled`** → bare in-memory store (smoke tests only) |
| `LW_IDP_CLIENT_SECRET` | if the IdP needs one | OIDC confidential client secret |
| `LW_BASE_URL` | no | only used by the built-in fallback config's placeholder `instance.baseUrl` |

Without `LW_SESSION_SECRET`/`LW_LINK_SECRET` in production, `loadSecrets` throws rather
than minting ephemeral dev secrets — by design.

## 3. Domain

Point **lolly.work** at this project (Project Settings → Domains). Make sure
`LW_CONFIG_JSON`'s `instance.baseUrl` matches whatever domain a given deployment answers
on (production vs. preview URLs differ) — it drives OIDC redirect URIs and the
session/guest cookie `Secure` flag.

## 4. What works / what doesn't

Works: auth (OIDC + dev provider), org-config, RBAC/overlays, links, telemetry ingest +
rollups, inbox, audit chain, fleet registry, the admin console/CLI, catalog serving, and
**`/render/*`** — the fourth-shell render plane renders Tier-A (SVG/PNG via the in-process
engine + resvg) straight from the bundled pack. In `open` access mode a plain
`GET /render/<tool>.<format>` is public (the agent / `<img>` path).

The **pack gap is closed for the demo** by bundling: `packs/demo/` is a small, committed,
Tier-A pack that `vercel.json`'s `includeFiles` ships into the Function, and
`api/_lib/bootstrap.ts` resolves a repo-relative `instance.pack` to an absolute path from
the function's own location. A *large real* pack (brand assets) still wants the `LW_PACK`
URL/blob mount — unbuilt, and not needed for the sandbox. A materialised pack can instead be bundled the same way as the demo with `LW_PACK_DIR` (section 6).

Doesn't (yet): no **real** WebSocket/collab in this Function — the platform now claims native
WebSocket support (Fluid Compute, public beta), but it needs a different entry-point shape
than our `(req, res)` handler and a room-authority story ours doesn't have; see
`deploy/vercel/WS-SPIKE.md` for the verified verdict (short rooms only, sovereign Helm
remains the real collab host). The demo seed does inject a **synthetic** live-room registry
(`demoRooms()` → `listCollabRooms`), so the console's **Rooms** panel is populated with a few
illustrative rooms — display-only snapshots (rosters, roles, op counters), never a real
editing session. **No Chromium rendering in
this Function** — pdf/tiff/video/HTML-layout renders (Tier B) stay on the render worker
(§4a — an RKE2 cluster pod by preference), so the demo pack is deliberately Tier-A only; the full 1.9 GB governed web shell is not
served here (that is a separate static/CDN deploy — `instance.shellDir`/`appUrl`), though section 6 proxies a public shell onto the same origin.

## 4a. Render worker (Tier-B) — optional, for raster consolidation

The Vercel function can't run Chromium, so today `/render/*.png` uses the in-process resvg
fallback. To move rasterisation onto the single Chromium worker (one renderer,
one provenance path, and it lets resvg be dropped), point the function at a running worker.

1. **Run the worker — the preferred host is your RKE2/Kubernetes cluster** (decided
   2026-08-11: SUSE runs no hyperscaler worker; the demo shares the production fleet):
   enable it in the Helm chart —

   ```yaml
   # deploy/helm values
   renderWorker:
     enabled: true
     webBase: https://lolly.tools        # /render (hooked tools) drives this shell
     maxConcurrent: 4                    # per-pod cap → 503 RENDER_BUSY + /readyz flip
   ```

   set `LW_RENDER_WORKER_SECRET` in the chart's secrets, and expose the worker Service
   through the cluster ingress (HMAC on every request — the secret *is* the auth) so this
   Vercel function can reach it.

   **No cluster?** (community/trial deployers) — the worker is a self-contained Node 24 +
   Playwright container (`workers/render/`); any container host works, e.g. Cloud Run as a
   single warm instance:

   ```bash
   SECRET=$(openssl rand -hex 32)
   gcloud run deploy lolly-render-worker \
     --source workers/render --region europe-west1 --allow-unauthenticated \
     --set-env-vars "LW_RENDER_WORKER_SECRET=$SECRET,LOLLY_WEB_BASE=https://lolly.tools" \
     --cpu 2 --memory 2Gi --min-instances 1        # min-1 avoids a cold browser launch
   ```

   `LOLLY_WEB_BASE` is only used by `/render` (hooked tools); `/rasterise` needs only the
   browser.

2. **Wire the function to it** — set the **same** secret on the Vercel project and add
   `render.worker.url` to `LW_CONFIG_JSON`:

   ```bash
   vercel env add LW_RENDER_WORKER_SECRET production      # paste $SECRET
   # then in lolly-work.config.json add, under "render":
   #   "worker": { "url": "https://lolly-render-worker-….run.app", "timeoutMs": 20000 }
   ```

   Redeploy. The plane now delegates rasterisation to the worker (watermark/provenance/C2PA
   stay plane-side). To force the resvg fallback for a deploy, set `LW_RENDER_LEGACY_RESVG=1`.

## 5. The demo sandbox (main page + demo logins)

With **no `shellDir`** and **`dev.enabled`**, `/` serves a self-contained demo landing
(`server/src/lib/demo-landing.ts`): a "public testing sandbox" banner, one-click
passwordless sign-in for each `dev.users` persona (→ `/api/auth/dev`), a link into the
governed admin console (`/admin`), and live `GET /render/*` examples. `deploy/vercel/lolly-work.config.json`
is the ready-to-paste `LW_CONFIG_JSON` for it:

- `instance.pack: "packs/demo"` — the bundled Tier-A pack (qr-code, mesh-gradient, colour-palette).
- `policy.defaultAccessMode: "open"` — `/render` + `/catalog` are public (the MCP GET surface); `/admin` + governance APIs still enforce RBAC.
- `render.allowHooksInFastPath: true` — the demo tools carry hooks; the pack is curated + self-contained, so running them in-process is acceptable for a sandbox.
- `dev.enabled: true` with four personas (admin / brand-lead / marketer / contractor).

**What a signed-in visitor sees.** With `dev.enabled` and no `DATABASE_URL`, `api/_lib/bootstrap.ts`
seeds the in-memory store with the same rich fixture the local `pnpm run demo` uses (`scripts/demo.ts`):
`seedStore()` lays down the governance state (RBAC grants, tool overlays, the brand-review approval
chain, feature-flag governance, injectables, two projects with sessions, catalog-lifecycle rows,
inbox messages), then `seedActivity()` adds the **runtime activity** the dashboards are built from —
14 days of usage telemetry (Overview charts, the attributed activity timeline, tool/asset/format
leaderboards), a mixed web/tauri/cli fleet, four shared links (one revoked, one password-gated), and
four approvals spanning every inbox state. `demoRooms()` supplies a synthetic live-room registry so
the **Rooms** panel is populated too. Net: the console is fully populated the moment you sign in — no
empty states. It all re-seeds on every cold start (in-memory, ephemeral), so every instance is
consistently populated and nothing persists.

**Security:** this is passwordless sign-in on a public origin — anyone can enter as any
persona, including admin, and the in-memory store resets on redeploy. It only appears when
`dev.enabled` is true (a real IdP deploy never sets it). Keep nothing real or sensitive on
this instance. To set it: `vercel env add LW_CONFIG_JSON` and paste the file's contents
(or `vercel env add LW_CONFIG_JSON < deploy/vercel/lolly-work.config.json`).

The demo config sets `"deployment": { "mode": "evaluation" }`. It has to: `api/_lib/bootstrap.ts`
runs the same production setup checks as `server/src/main.ts`, and with `mode` left at
`auto` a function that sees `NODE_ENV=production` treats the passwordless personas, the
memory store and `open` access as production failures and refuses to boot. Update the
`LW_CONFIG_JSON` value on the demo project before deploying a build that carries these checks.

## 6. Private instance with the Lolly app

> **lolly.ing moved to a VM** (`deploy/vm/README.md`): Caddy and the long-lived server, which
> runs the live co-editing gateway, against the same Neon database. The Vercel project
> `lolly-ing` stays deployed as the rollback: point the `A @` and `A www` records back at
> 76.76.21.21 and it serves again, provided its production deployment was built from this
> code or later (the VM runbook's step 8; `/api/v1/instance` then reports an `engineVersion`,
> an older build `null`). An older build takes its migration lock over the pooled
> `DATABASE_URL`, so cold starts hang until the function timeout, and it tells the Lolly app
> to open live rooms. Keep its `LW_SESSION_SECRET` and `LW_LINK_SECRET` equal
> to the VM's, since the session secret also keys the audit log's MACs. Vercel cannot take the
> gateway's place behind a rewrite: a rewrite to another origin carries no WebSocket and is cut
> at 120 s.

One Vercel project can serve a private, sign-in gated Lolly on its own domain: the Lolly app
(the web shell) is proxied from a public shell origin such as `https://lolly.tools`, and every
control-plane path (`/api/*`, `/catalog/*`, tool files, `/admin`, sign-in) is answered by this
function, all on one origin so the session cookie reaches both. The code is the same as the
demo; three build-time variables and a production `LW_CONFIG_JSON` make the difference.

### Routes

With `LW_SHELL_ORIGIN` set, `scripts/build-vercel-fn.mjs` writes this table (generated by
`scripts/vercel-routes.ts`; `pnpm run check:vercel` and `tests/vercel-routes.test.ts` assert it):

| Order | Paths | Goes to |
|---|---|---|
| 1 | `/api/ca/*`, `/api/penpot/*`, `/api/mcp`, `/api/mcp/*`, `/api/fetch-image` | the shell origin, with the `Cookie` header removed. These are the OSS project's own functions, which the shell calls on its own origin; lolly-work registers nothing under them. `Authorization` is kept, because the Penpot proxy forwards it as the user's own Penpot token |
| 2 | everything that is not a function path, including `/`, the bare `/tools` gallery, `/t/*`, `/info/*`, `/_app/*` and `sw.js` | the shell origin, proxied, with the `Cookie` and `Authorization` headers removed. Function paths are `/api`, `/catalog`, `/render`, `/l`, `/admin`, `/scim`, `/healthz`, `/readyz`, `/metrics`, `/activate`, `/connect` and everything under them, plus `/tools/<anything>` |
| 3 | everything else, which is exactly the function paths | this function, with the caller's path restored into `req.url` |

The function row is last on purpose. Vercel ends routing at a proxy to another origin, but
after a rewrite to the function it keeps matching the later routes against the rewritten
path. The first lolly.ing deploy (2026-10-03) had the function rows before a shell catch-all:
every function path was proxied on to the shell origin as `/api/index` and answered
`NOT_FOUND`. `tests/vercel-routes.test.ts` and `pnpm run check:vercel` now require the function
row to be the only one and the last.

The function paths in row 2 are derived at build time by scanning `server/src` for router
registrations and unioned with a fixed baseline, so a new top-level route reaches the function without a
hand-edited list. Matching follows Vercel's default and ignores case.

Credentials stay on this origin. The session cookie is `Path=/`, so the browser sends it with
every request to the domain, the app's own scripts included. Rows 1 and 2 delete it (a
`request.headers` delete transform, the Build Output API shape checked on 2026-10-02) before
the request leaves for the shell origin, so the session never reaches that project's
functions, logs or the hosts it proxies onward, such as the model host behind `/models/*`.

The shell's service worker must leave this function's pages alone. It stores any successful
navigation whose last path segment has no dot as its offline app shell, and answers a 5xx
navigation with that shell, unless the path is in its `BYPASS_PATTERNS`. Lolly's
`shells/web/public/sw.js` bypasses `/api/`, `/catalog/` and, since 2026-10-02, `/activate`,
`/admin`, `/connect`, `/healthz`, `/l`, `/metrics`, `/readyz`, `/render` and `/scim`. Use a
shell origin whose `sw.js` has that line; an older one stores the console or a share page as
the app. `SHELL_SW_BYPASS_PREFIXES` in `scripts/vercel-routes.ts` is the list, and
`tests/vercel-routes.test.ts` checks it against the router and, with a Lolly checkout beside
this repository (or `LOLLY_DIR`), against that `sw.js`. A new navigable top-level route needs
adding to both.

The OSS deployment at lolly.tools redirects requests whose `Host` is one of its parked
`lolly.*` domains. After the first deploy, check that a proxied page answers `200` rather than a
redirect: `curl -sI https://<your domain>/ | head -1`. Check also that a query string reaches
both sides, for example `curl -s 'https://<your domain>/healthz?probe=1'` and a shell URL with
`?` parameters.

### Build-time variables

Set these for the Production environment so the build on Vercel sees them.

| Var | Example | What |
|---|---|---|
| `LW_SHELL_ORIGIN` | `https://lolly.tools` | the shell origin to proxy. Must be `https` with no path, query or fragment; the build stops otherwise. Unset: the demo catch-all |
| `LW_PACK_DIR` | `packs/my-instance` | a pack inside this repository, bundled into the function as real files (symbolic links are copied as their targets and the build fails if any remain). A brand-profile pack (with `brands/`) has its active catalog materialised the way `packs/demo` is. Point `instance.pack` at the same path |
| `LW_FUNCTION_REGION` | `fra1` | one or more Vercel region ids, comma separated, written to the function's `.vc-config.json` as `regions` (the Build Output API field, checked against Vercel's docs on 2026-10-02). Hobby runs one region. Setting the project's Function Region in the dashboard instead works too |

With none of the three set, the build output is byte for byte the demo build. With
`LW_SHELL_ORIGIN` or `LW_PACK_DIR` set, the function also streams its responses
(`supportsResponseStreaming` in `.vc-config.json`): Vercel answers 413
`FUNCTION_PAYLOAD_TOO_LARGE` for a buffered function response over 4.5 MB, a pack built from
Lolly holds files above that (each shared emoji set is 8 to 38 MB, and Darkroom's heavy LUT is
4.9 MB under both `tools/` and `catalog/`), and Vercel documents no such limit for a streamed
response. `pnpm run check:vercel` fails a build that bundles a file over 4.5 MB without
streaming. Not yet verified on a live deploy: after the first one, fetch a large file through
the function, for example
`curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -b 'lw_session=<yours>' https://<your domain>/catalog/packs/emoji-packs/noto-color.json`.

### The pack

Packs are data and are not committed (`packs/*` is ignored, except `packs/demo`). Build one
from a clean Lolly checkout at the commit the shell origin runs:

```bash
git -C ../lolly checkout <commit>      # the revision lolly.tools is serving
node scripts/build-instance-pack.ts --lolly ../lolly --profile lolly-start \
  --out packs/my-instance --exclude og
```

The script runs the checkout's own resolver (`materializeInto` in
`packages/node-shell/src/content-roots.ts`) as a child process inside that checkout, writes
`.lolly-pack-source.json` with the commit and profile, refuses a checkout with uncommitted
changes unless `--allow-dirty`, and finishes with `scripts/inspect-pack.ts`. While it runs, the
record says `"incomplete": true`; the full record replaces it only when the copy has
succeeded, and the function build refuses a pack whose record still says incomplete. The
script leaves out the pack's build-time `catalog/tools/index.sig.json`: it can never match the
index this server serves per caller, and its file list names every tool (with
`LW_CATALOG_SIGNING_KEY` the server signs per caller instead; without it, that path answers
404).

`--exclude <path>` removes a path under `catalog/` and every asset index format that points
into it; an asset left with no format leaves the index. Both are listed in the record as
`prunedAssets`. That keeps the pack bootable (the production boot check reads every local file
the index names), but it also takes those assets away from the instance. `og` is safe to
exclude: the asset index does not reference it, and only link previews read it. Excluding
`packs` removes the shared emoji sets from the instance.

Two things to check before deploying:

- **Engine version.** A pack from a newer Lolly can need a newer engine than
  `vendor/@lolly/engine`. `inspect-pack` names each tool that will not load, and a production
  boot refuses such a pack. Repin the engine from the same Lolly commit first
  (`npm run repin-engine`).
- **Size.** A whole profile is large: `lolly-start` measured about 300 MB with `og` excluded,
  most of it the shared emoji sets under `catalog/packs/` (about 157 MB) and one large tool.
  Vercel's standard limit is 250 MB uncompressed per function. Its large functions (beta,
  up to 5 GB, with fluid compute and Active CPU) are on by default for new projects and are
  used only when a function is over the standard limit; an existing project opts in with
  `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` (vercel.com/docs/functions/limitations, checked
  2026-10-02). If you need a smaller bundle instead, exclude only what you can do without,
  as above, and check the size of `.vercel/output/functions/api/index.func` after a local
  build.

The pack directory must be part of the upload. It is not listed in `.vercelignore`; keep it
that way.

### Runtime variables

| Var | What |
|---|---|
| `LW_CONFIG_JSON` | the instance config, below |
| `DATABASE_URL` | Neon Postgres in an EU region, from the Vercel Marketplace (Storage tab, Neon). Holds the store **and** the blobs: with a database the function selects the Postgres blob store, as `main.ts` does, so uploads survive cold starts and redeploys |
| `DATABASE_URL_UNPOOLED` | set by the Neon integration beside the pooled `DATABASE_URL`. Migrations run over it: they take a lock that a transaction pooler would keep after the function disconnects, and every later cold start waited on that lock until the 300 s function timeout (2026-10-03). The store keeps the pooled URL |
| `LW_BACKGROUND_POLL_MS` | optional. `0` stops the durable automation runner from polling the database every second while a warm instance lives; jobs then run when submitted. Unset keeps the 1 s poll. Set it when the database scales to zero (Neon Free) |
| `LW_BOOT_TIMEOUT_MS` | optional, default 30000. How long requests wait for a cold start; past it they fail and the next request starts a fresh boot, so one stuck boot cannot hold every request on a warm instance |
| `LW_SESSION_SECRET`, `LW_LINK_SECRET` | fresh random values of at least 32 bytes (`openssl rand -hex 48`), never the demo's |
| `LW_IDP_CLIENT_SECRET` | the primary identity provider's client secret; each additional provider names its own variable with `clientSecretRef` |
| `LW_CATALOG_SIGNING_KEY` | the ECDSA P-256 private key whose public half the shell origin pins (PKCS#8 PEM or private JWK JSON, the forms lolly's `scripts/sign-catalog.ts` reads). With it, `/catalog/tools/index.json` and `/catalog/tools/index.sig.json` are produced per caller from one function, so each signed caller gets an envelope over the exact bytes it received; without it, a shell that pins a key refuses every tool. Logged only as its key id |

### `LW_CONFIG_JSON`

```json
{
  "deployment": { "mode": "production" },
  "instance": { "name": "Lolly", "baseUrl": "https://lolly.example", "pack": "packs/my-instance" },
  "idp": {
    "issuer": "https://accounts.google.com", "clientId": "<client id>", "displayName": "Google",
    "admission": { "emails": ["you@example.com"], "domains": [], "invitations": true },
    "bootstrapOwners": ["you@example.com"]
  },
  "policy": { "defaultAccessMode": "gated", "guestLinks": { "enabled": false },
              "nearby": { "enabled": false } },
  "rateLimit": { "enabled": true, "trustedProxyHops": 1 },
  "dev": { "enabled": false },
  "blobs": { "driver": "pg" }
}
```

- `deployment.mode: "production"` turns on the boot refusals: no database, the development
  login, open access, short secrets or an incompatible pack stop the function from booting, and
  each failed check is written to the function log (never a secret value).
- `instance.baseUrl` is the public domain; the identity provider's callback is
  `<baseUrl>/api/auth/callback`. Admission and owner bootstrap are described in
  `docs/identity.md`.
- `rateLimit.trustedProxyHops: 1`. Vercel overwrites `X-Forwarded-For` with the client
  address and does not forward one sent by the client, so the limiter's one-hop read (the
  rightmost entry, `server/src/observability/rate-limit.ts`) is the real client. Left at `0`,
  every caller shares the platform's socket address and one busy user throttles everyone.
- Live co-editing is off on this host without any grant: the function runs no ws gateway, so
  `api/_lib/bootstrap.ts` builds the app with `liveCollab: false` and org-config answers
  `collab.join`, `collab.edit` and `collab.nearby` as false for everyone.

### Deploy

```bash
vercel link                                   # a new project, never the OSS one
vercel env add LW_SHELL_ORIGIN production     # and the other variables above
vercel deploy --prod --archive=tgz
```

`--archive=tgz` uploads the tree as one archive; with a pack in it, a file-by-file upload is
slow and tends to abort. Then add the domain in Project Settings, Domains, and create the DNS
records Vercel shows at your DNS host. Keep `instance.baseUrl` equal to that domain.

### What works and what does not

Works: sign-in through your identity provider, the Lolly app on your domain, the governed
catalog and tool files per caller with a signature the pinned shell accepts (the slim index,
preview art, social cards and their manifests follow the same per-caller visibility, so a
hidden tool is absent from all of them), team projects and sessions in Postgres, uploads in
the Postgres blob store, the admin console, `/render/*` for Tier-A tools. Pack files over
4.5 MB are served by a streamed response; see "Build-time variables" for the check to run after
the first deploy.

Does not: live co-editing (no WebSocket gateway in a function; the collab bits are off), nearby
presence (answers 501), Chromium renders for hooked tools and PDF/video formats unless a render
worker is configured (section 4a), boot-time `LW_SEED_CONFIG` (apply a config document from the
console or `lw apply <file>` instead), and the long-running loops `main.ts` owns (retention,
credential expiry nudges, SIEM forwarding; drive retention with a service token instead).
