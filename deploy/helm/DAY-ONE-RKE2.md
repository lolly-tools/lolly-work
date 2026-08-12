# Day one on RKE2 — enabling the render worker

The cluster lands ~2026-08-29 (18 days after the 2026-08-11 decision that SUSE's worker
is an RKE2 Helm pod, never a hyperscaler service). Everything below the "already proven
blind" line was validated without a cluster; day one is the short list after it.

## Already proven blind (do not re-derive)

- `helm lint` clean; all three topologies (`light`, worker, worker+HPA) render and pass
  `kubeconform -strict` — pinned in CI by `tests/helm-chart.test.ts` (skips where helm is
  absent, like the PG test legs).
- Topology invariants hold in the rendered output: worker off by default; liveness
  `/healthz` load-independent vs readiness `/readyz` saturation gate; `LW_RENDER_MAX_CONCURRENT`
  reaches the pod; with `autoscaling.enabled` the Deployment drops static `replicas` and the
  HPA targets the worker.
- The worker itself: real-Chromium `rasterise()` verified (PNG/JPEG/PDF
  bytes), semaphore + 503 `RENDER_BUSY` + `Retry-After` + `/readyz` flip covered by
  `tests/render-worker-*.test.ts`, and the busy answer propagates through the plane to the
  HTTP client (`render.test.ts (l)`).
- Missing required secrets refuse to render (fail-closed), also pinned by the test.
- **Full container rehearsal (2026-08-11, Docker/colima — virtualised macOS, so no
  performance conclusions, correctness only):** the real `workers/render` image builds and
  boots; plane→HMAC→container renders came back with correct magics **and a valid C2PA
  credential in all three containers (png/jpg/pdf — real worker bytes, plane-side sign)**;
  the container's `/render` drove the real lolly.tools shell (hooked path, 18 KB SVG);
  saturation at `LW_RENDER_MAX_CONCURRENT=2` under 6 concurrent rasterises answered
  **2×200 / 4×503 `RENDER_BUSY` + `Retry-After: 2`** with `/readyz` observed 503 mid-burst
  and 200 after. Day one re-proves none of this — only the cluster-specific list below.

## Day one, in order

1. **Secrets** (once, shared by every replica):
   ```bash
   openssl rand -hex 32   # sessionSecret
   openssl rand -hex 32   # linkSecret
   openssl rand -hex 32   # renderWorker secret (LW_RENDER_WORKER_SECRET)
   ```
   Via `secrets.*`/`renderWorker.secret` values or `existingSecret` — never in git.

2. **Values** — the worker block:
   ```yaml
   renderWorker:
     enabled: true
     webBase: https://lolly.tools     # the shell /render drives for hooked tools
     # maxConcurrent: 4               # per-pod cap; scale replicas/HPA, not this
     autoscaling:
       enabled: true                  # CPU-target; drops static replicas
     # runtimeClassName: gvisor       # prefer a sandboxed class if the cluster
                                      # offers one — this tier runs the least-
                                      # trusted content
   config:
     render:
       worker:
         url: http://<release>-render-worker:<port>   # in-cluster Service DNS
   ```

3. **`helm upgrade --install`**, then watch the worker pod reach Ready.

4. **Verify ladder** (each step gates the next):
   - `kubectl exec` a curl inside the cluster: `/healthz` 200, `/readyz` 200.
   - A **hooked tool** renders through the plane (it 501'd before): `GET /render/<hooked>.svg` → 200.
   - **org-config moved**: a shell that held a pre-worker ETag gets a 200 (not 304) and
     `render.hookedTools: true` — the known hooked-tools regression, now live.
   - Saturation: hold `maxConcurrent` renders open → next request 503 `RENDER_BUSY` with
     `Retry-After`, pod drops from Endpoints, recovers when a slot frees.
   - Fidelity side-by-side vs resvg on the demo tools (an open item).

5. **Demo cutover**: expose the worker Service through the ingress (the
   HMAC is the auth), set the Vercel project's `LW_RENDER_WORKER_SECRET` + `render.worker.url`
   to the ingress URL, redeploy, update `deploy/vercel/README.md` + `docs/deployment.md`
   (which still say "Tier-A resvg PNG in-process").

6. **Then** phases 3–4: widen formats, and once fidelity is signed off, remove
   resvg + `LW_RENDER_LEGACY_RESVG` and make `deps.worker` required.

## Images

Published by `release.yml` on the `v0.1.1` tag (2026-08-11 — v0.1.0 existed for minutes
before its own first CI run caught a HIGH advisory in the production tree; 0.1.1 is the
clean build, use nothing older):
`ghcr.io/lolly-tools/lolly-work-server:0.1.1` and
`ghcr.io/lolly-tools/lolly-work-render-worker:0.1.1`. The chart's empty
`image.tag`/`renderWorker.image.tag` default to `appVersion` (= `0.1.1`), so a plain
install pulls exactly these. If the GHCR packages are private in your org, add an
`imagePullSecret` (or mirror into the SUSE registry — preferable air-gap posture anyway).

## What only the cluster can prove

Admission/PSP posture and whether a sandboxed `runtimeClassName` exists on this RKE2;
image pull from ghcr (or the mirrored registry) inside SUSE's network; ingress
reachability + TLS for the demo path; HPA behaviour against real CPU signal.

## Rollback

`renderWorker.enabled=false` + drop `config.render.worker.url` → the plane returns to the
light topology (hooked tools 501, in-process resvg PNG) on the next rollout. For a
raster-path-only escape without disabling the worker: `LW_RENDER_LEGACY_RESVG=1`
(plane-side, temporary — removed with resvg in phase 4).
