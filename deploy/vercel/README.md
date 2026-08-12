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
which esbuild-bundles the app + the vendored engine into a single plain-JS function and
emits it via Vercel's **Build Output API** (`.vercel/output/`). This is required, not
cosmetic: the repo runs `.ts` natively (every import carries a `.ts` extension) and Vercel's
zero-config transpile leaves those specifiers dangling, and Node refuses to type-strip the
engine under `node_modules` — so the whole graph must be bundled to JS. The build runs on
Vercel (Linux) so the one native module, `@resvg/resvg-js`, gets the right binary; it can't
be prebuilt from macOS. The entry is `api/_index.ts` (underscore-prefixed so Vercel's
zero-config function detector ignores it and only the Build Output API applies);
`api/_lib/bootstrap.ts` builds the app. This file is the operational runbook.

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
| `LW_CONFIG_JSON` | yes | the whole `instance.json` as one JSON string — unset falls back to a gated, dev-disabled, fail-closed placeholder (`api/_lib/bootstrap.ts`) that only answers `/healthz`. **For the public demo sandbox, use `deploy/vercel/lolly-work.config.json` verbatim** (see §5) — it wires the bundled demo pack, `open` render access, and the four passwordless demo personas |
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
URL/blob mount — unbuilt, and not needed for the sandbox.

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
served here (that is a separate static/CDN deploy — `instance.shellDir`/`appUrl`).

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
seeds the in-memory store with the same rich fixture the local `npm run demo` uses (`scripts/demo.ts`):
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
