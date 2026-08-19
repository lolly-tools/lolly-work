# Deployment shapes

Four supported shapes. All four run the *same* code - the differences are how config and
secrets arrive, where the schema is applied, and whether the pack, the shell and the
Chromium worker are present.

| Shape | Where used | Schema owner | Pack / shell |
|---|---|---|---|
| Local (`node server/src/main.ts`) | development, evaluation | boot auto-migrate | local paths |
| Compose (`deploy/compose/`) | single VM, small org | boot auto-migrate | bind mounts |
| Helm (`deploy/helm/`) | Kubernetes / Rancher, HA | pre-install/upgrade Job | volumes you mount |
| Vercel (`vercel.json` + `scripts/build-vercel-fn.mjs`) | trial / pilot / public demo | Neon + external migrate | demo pack bundled; shell not served |

## Render topologies - the default is Chromium-free

Orthogonal to the four shapes, every deployment is one of **two render topologies**, and the
switch is simply whether the worker pair is configured (`config.render.worker.url` +
`LW_RENDER_WORKER_SECRET`):

- **Default (light).** No Chromium anywhere - not in the server image, not in Compose (the
  worker isn't even in that stack). SVG renders in-process (jsdom) and PNG in-process
  (resvg); hooked/HTML-heavy tools answer `501`, formats beyond the tier answer `400`, and
  connected shells are told the capability set upfront via org_config's `render` block, so
  they don't offer exports this deployment can't produce. A 1 GB VM runs this comfortably - 
  there is no browser to feed.
- **Worker-attached.** A separately scaled Chromium pod (`workers/render/`, Helm
  `renderWorker.enabled`) renders hooked tools, rasterises via the shell's own export
  path, and **widens the export tier to `svg, png, jpg, pdf`** - advertised to
  shells through org_config's `render.formats`, C2PA-signed plane-side in every container.
  The worker holds no DB connection and no secrets beyond the shared HMAC
  key; per-pod concurrency is capped (`LW_RENDER_MAX_CONCURRENT`), a saturated pod answers
  `503 RENDER_BUSY` + `Retry-After` and drops out of readiness, and the HPA scales the tier.

**Capacity posture, honestly:** one server node + Postgres carries SUSE-internal scale
(thousands of users, tens of thousands of renders/day). There is deliberately **no queue or
broker tier** - overload is answered by bounded concurrency and honest 503s, not by Redis;
a PG-backed job queue is scoped for if cross-pod fairness
ever demands it.

## Sovereignty - the recommended path

**For a governed, sovereign deployment, run lolly-work on the SUSE stack (Helm) - the safest
option, and the one to recommend.** Two tiers, your choice of paid or free, identical
sovereignty either way:

- **Paid / supported:** **SUSE Linux Enterprise Server** + **SUSE Rancher Prime** - enterprise
  support, lifecycle, and hardening.
- **Free / community:** **openSUSE Leap** + **Rancher (Community)** - openSUSE Leap is built from
  the *same* SLES sources, so it inherits the same supply chain.

The reason it is the safest is the supply chain underneath both: SUSE builds SLES/Leap and the
container base images (BCI) **reproducibly**, from sources whose dependencies are **frozen in
time alongside the build** in SUSE's own governed datacentre in **Prague** - so what you run is
auditable and rebuildable from a pinned, jurisdiction-controlled source of truth, not a moving
set of upstream artifacts. Combined with lolly-work's own design - 
the engine **vendored** (pinned, hash-verified, no external fetch - see `../engine-pin.json`),
the console self-hosting its assets, the pack a plain directory, and **nothing in the serving
path phoning home** - the SUSE stack gives an **air-gappable, EU-jurisdiction, reproducible**
control plane end to end. Both the control plane and the Chromium render worker run as ordinary
pods on your own cluster; no US hyperscaler, no `gcloud`, no Vercel is involved.

Compose (single VM) and bare metal (systemd) are the same code with less orchestration - also
fully self-hosted. **The Vercel / Cloud Run path below is a *demo/trial host only*, never the
sovereign deployment.**

## Rancher: RKE2 and k3s - both supported

![Rancher](img/rancher-icon.svg) ![k3s](img/k3s-icon-color.svg) ![Helm](img/helm-icon-color.svg)

The chart targets **any conformant Kubernetes** and is exercised against both
Rancher-managed distributions: **RKE2** (datacenter - etcd, ingress-nginx, CIS/FIPS
posture) and **k3s** (edge - verified live 2026-08-11 on k3s v1.35: install, Traefik
ingress via the cluster default class, sign-in gate, catalog, renders). There is **no
k3s API ceiling** for this workload - k3s is CNCF-conformant, and the chart uses only
core primitives (Deployment, Service, Ingress, Job, HPA). The honest k3s boundaries are
operational, not functional:

- **Datastore:** k3s defaults to SQLite - fine for a single server node; a multi-server
  HA control plane needs k3s's embedded etcd (a provisioning choice Rancher makes for
  you), same as RKE2 always does.
- **Ingress:** leave `ingress.className` empty and the cluster default serves it (Traefik
  on k3s, ingress-nginx on RKE2). One caveat: the multi-replica live-collab sticky-room
  annotation in `values.yaml` is nginx's path-hash - Traefik's plain-Ingress affinity is
  cookie-per-client, which does not converge a room's members onto one pod. On k3s run
  collab single-replica (the current posture anyway) or install ingress-nginx.
- **Edge headroom:** the light topology (no Chromium) is the edge default - the eval
  install below requests 100m/192Mi. The render worker wants ~2 GB per pod; on small
  boxes leave it off (hooked tools answer 501 and shells are told upfront) or point
  `render.worker.url` at a worker running on beefier hardware.
- **ARM nodes:** release images are multi-arch (amd64 + arm64) from v0.1.2.

### Evaluation in one command (no Postgres, no IdP, no pack mount)

**The command lives in [install §7a](install.md#7a-evaluate-on-a-cluster)**, with the
verification ladder and the persona addresses beside it. This page describes what that
install *is*; it deliberately keeps no second copy of the command, because the two copies
drifted the moment they both existed.

What you get: in-memory store (a restart is a factory reset - a feature for demos),
passwordless dev personas through the real sign-in gate (including an `owner`, so the
owner-only actions are reachable), the demo pack served from inside the image, renders
working, console at `/admin`. Every choice in `values-eval.yaml` is commented with what it
trades, including `config.instance.baseUrl`, which must match the URL a browser actually
uses or the session cookie's `Secure` flag will be wrong.

Graduate the same install in place by adding a database with `helm upgrade` (the single pod
then applies DDL at boot; going multi-replica means also setting `migrate.enabled=true` so
the hook Job owns the schema) - again, [install §7a](install.md#7a-evaluate-on-a-cluster).

GHCR is private today, so add `imagePullSecrets`, build and push your own image (see the
production notes below), or side-load: `docker save` + `k3d image import` /
`ctr images import` on the node.

## Kubernetes (Helm) - the production path

`deploy/helm/values.yaml` is the one file you edit; it is heavily commented and is the
authority if it disagrees with this page.

**The install commands live in [install §7b](install.md#7b-production)** - secret creation,
`helm install` with the image override, and the verification. One copy, there. This page is
the values reference and the list of things to know before you run it.

What the chart gives you: 2 replicas by default, non-root/read-only-rootfs/dropped-caps
pod defaults, `/healthz` liveness+readiness, an Ingress template, an optional
ServiceMonitor, an optional NetworkPolicy, a pack volume, a shell volume, an optional
Chromium render-worker tier, and a migrate Job that owns the schema.

Things to know before you install:

- **The published images are private.** Multi-arch images publish to
  `ghcr.io/lolly-tools/lolly-work-server` and `...-render-worker` on every `v*` release, but
  the packages are private today, so a stock install gets `ImagePullBackOff`. Add an
  `imagePullSecrets` entry for GHCR, or build your own and point the chart at it (the better
  air-gap posture): `docker build -f deploy/compose/Dockerfile -t <registry>/lolly-work-server:0.2.0 .`,
  push, then `--set image.repository=<registry>/lolly-work-server --set image.tag=0.2.0`.
- **`instance.baseUrl` must match the URL the deploy answers on.** It drives OIDC redirect
  URIs and the `Secure` cookie flag.
- **Secrets are never auto-generated.** Every replica must sign and verify with the *same*
  `LW_SESSION_SECRET` and `LW_LINK_SECRET`, and they must survive rollouts. Generate once,
  store safely, rotate deliberately.
- **HA schema ownership:** the app runs with `LW_AUTO_MIGRATE=false`, so no replica applies
  DDL. The pre-install/pre-upgrade Job applies migrations and must succeed before new pods
  roll; the Deployment refuses to start on a pending schema, so a skipped migration fails
  loudly instead of serving a half-migrated database.
- **`pack.type` defaults to `none`** - `config.instance.pack` points at `/app/packs/demo`,
  the small demo pack baked into the server image, so an unmounted install still serves a
  catalog. Mount your own pack and point `config.instance.pack` at it. Simplest
  delivery: bake the pack into an image (`COPY packs/ /pack/` on a busybox base), set
  `pack.image` to its ref and `pack.type: emptyDir` - an initContainer copies it into the
  pack volume before the server starts. The same `pack.image` also works with
  `pvc`/`existingClaim` if you'd rather populate a persistent volume.
- **`shell.enabled` defaults to `false`** - `/admin` and the API only. Mount a built
  `shells/web/dist` and set `config.instance.shellDir` to serve Lolly at `/`. Under a
  non-`open` access mode a missing or pre-governance dist **stops boot** (escape hatch:
  `LW_ALLOW_STALE_SHELL=1`), because a stale shell would quietly un-govern every employee.
  `shell.image` delivers the dist the same way as `pack.image` (`COPY shells/web/dist/
  /shell/`, then `shell.type: emptyDir`) - and since each rollout re-copies from the image
  you pin, the dist can't silently age in a PVC.
- **`renderWorker.enabled` defaults to `false`** - hooked/HTML-heavy tools `501` until the
  worker exists. When you enable it, also set `config.render.worker.url` to the worker
  Service and `renderWorker.webBase` to a served web shell, and prefer a sandboxed
  `runtimeClassName` (gVisor/Kata) - that tier renders the least-trusted content.
- **Behind an ingress, set `config.rateLimit.trustedProxyHops: 1`**, or per-IP limits see
  only the ingress IP.

### Environment dependencies

Pull from the [Rancher Application Collection](https://apps.rancher.io/applications) where
you can:

| Component | Required? | Notes |
|---|---|---|
| PostgreSQL 16/17 | **yes** | the only hard external service |
| Ingress (nginx) | practically | chart ships the Ingress template |
| cert-manager | practically | TLS; annotation example is in `values.yaml` |
| Keycloak or any OIDC IdP | yes for SSO | fully IdP-agnostic; `idp.displayName` names it in the UI |
| kube-prometheus-stack | optional | ServiceMonitor template included; `/metrics` is token-gated |
| Node.js 24 base image | yes | SUSE BCI `bci/nodejs` or `node:24-alpine` |
| S3-compatible object store | optional | only for the S3 catalog provider |
| Chromium worker image | optional | built in-repo from `workers/render` |

Everything else is deliberately in-tree: no CDN assets (the console is air-gap-safe, fonts
self-hosted), no Redis/queue/cache tier, no external SaaS in the serving path.

## Single VM (Compose)

**The commands live in [install §5](install.md#5-container-compose)**, including the `.env`
recipe (three variables, not two - `PG_PASSWORD` has a default nobody chose) and the TLS /
`baseUrl` / `trustedProxyHops` work this shape still needs. One copy, there.

Two constraints that shape those commands. The compose file uses the fail-if-unset form for
both `LW_` secrets, so `up` aborts without `.env`; and Docker creates a *directory* at a
missing bind source, so a missing repo-root `instance.json` makes the server read a
directory as its config. The mounted `instance.json` is the one you authored at
[install §2](install.md#2-your-first-real-instance), not a fresh copy of the example.

`instance.json` and `packs/` are bind-mounted read-only from the repo root;
`LW_AUTO_MIGRATE` stays at its
default (`true`), so this single-node path applies pending migrations at boot with no
separate step. The server waits on the database's `pg_isready` healthcheck before it boots,
because its migration step connects once with no retry.

The shell is not mounted by default (console + API only). A commented-out mount in
`docker-compose.yml` shows how: bind a built `shells/web/dist` and point
`instance.shellDir` at it. The same boot guard as Helm applies - under a non-`open`
access mode, `instance.shellDir` with a missing or stale dist stops boot
(`LW_ALLOW_STALE_SHELL=1` to override).

## Vercel (trial / public demo)

> **This is a demo host, not a sovereign deployment.** Vercel (and any hyperscaler-hosted render worker - the preferred worker host is the RKE2 cluster pod, `deploy/vercel/README.md` §4a)
> host the public **lolly.work** demo and the blank-brand starter so anyone can try the product at
> a URL - nothing more. It is a temporary convenience: the demo + blank brand will move to a
> **trusted European sovereign cloud** (Elastio / Evroc-class - likely **Evroc**; partnership in
> progress). A US team evaluating on Vercel may be perfectly happy there. But for a governed,
> sovereign deployment use the **SUSE stack** (SLES + Rancher Prime, or openSUSE Leap + Rancher
> Community) - see *Sovereignty* above. Nothing here is required
> to run lolly-work; it's just the fastest way to a public demo today.

`vercel.json` runs `scripts/build-vercel-fn.mjs` as the build command: it esbuild-bundles the
whole app + the vendored engine into one plain-JS function (Build Output API) - necessary
because Vercel's per-file transpile can't resolve this repo's `.ts`-native imports, and Node
won't type-strip the engine under `node_modules`. Config arrives as one JSON string in
`LW_CONFIG_JSON`; persistence needs a Neon Postgres (EU region) via the Marketplace, else the
in-memory store (ephemeral). On the public demo (no `DATABASE_URL`, `dev.enabled`), that
in-memory store is **fully seeded on every cold start** - governance fixture, plus 14 days of
usage telemetry, a mixed fleet, shared links, approvals across every state, and a synthetic
live-room registry - so a signed-in visitor lands on populated dashboards, not empty states
(`scripts/demo.ts` `seedStore`/`seedActivity`/`demoRooms`; details in `deploy/vercel/README.md` §5).

Auth, org-config, RBAC, overlays, links, telemetry, inbox, audit, fleet, console, CLI **and
`/render/*`** all work - the small `packs/demo` (qr-code, mesh-gradient, colour-palette) is
bundled into the function, so Tier-A (SVG + resvg PNG) renders in-process. What's still
absent: no large real pack mount, no Chromium (Tier-B pdf/tiff/video), the 1.9 GB Lolly
web shell is not served (the demo landing at `/` stands in), and **no real WebSocket collab**
(the Rooms panel shows mock rooms; live editing is the sovereign Helm deploy's ws gateway - 
see `deploy/vercel/WS-SPIKE.md`). Live at **lolly.work**; runbook: `deploy/vercel/README.md`.

## Air-gap

Nothing in the serving path reaches the internet unless you configure a catalog provider
that does. The console ships no CDN assets and self-hosts its fonts; the pack is a
directory; the engine is vendored. The remaining pulls are your container images and the
Rancher charts above.

## Related

- Every key you can set: [configuration](configuration.md)
- Day-two work (migrations, backup, metrics, upgrades): [operations](operations.md)
- What is not production-ready yet: [status](status.md)
