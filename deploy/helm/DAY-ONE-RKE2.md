# Day one on RKE2 — enabling the render worker

Use this reference acceptance checklist after installing Work on your selected
K3s/RKE2 cluster. It does not install RKE2 or qualify its host/version/storage
matrix. Current lolly.ing and lolly.tools run on UpCloud/K3s; their reviewed
instance handoff is separate from these generic commands. A new installation
does not require Vercel. Start with the
[platform-team workflow](../suse/PLATFORM-TEAMS.md) and
[production installation](../../docs/install.md#7b-production).

## Existing source and container checks

The checks below establish their stated source/container scope. Repeat the
cluster-specific acceptance with your selected images, pack, identity and
storage; neither CI nor the earlier macOS rehearsal certifies a new RKE2 release.

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
  and 200 after. Retain this historical evidence and verify the selected cluster's
  end-to-end render and saturation behavior below.

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
     webBase: https://tools.example.org  # your qualified HTTPS shell origin
     # maxConcurrent: 4               # per-pod cap; scale replicas/HPA, not this
     autoscaling:
       enabled: true                  # CPU-target; drops static replicas
     # runtimeClassName: gvisor       # prefer a sandboxed class if the cluster
                                      # offers one — this tier runs the least-
                                      # trusted content
     networkPolicy:
       enabled: true                  # plans/58 WP0: control-plane ingress only;
                                      # egress to DNS + public addresses. A shell on
                                      # a private address needs an extraEgress rule
     # allowedOrigins: []             # private origins a render may reach
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

5. **Choose the worker connection.** For Work on the same cluster, keep the worker
   API on its private Service and use the matching shared render credential and
   in-cluster `render.worker.url`. Its `webBase` is a separately qualified HTTPS
   shell origin. Verify the complete authenticated Work-to-worker export path.
   An intentionally selected external instance, including the optional generic
   Vercel adapter, needs its own reviewed TLS/network/credential route; use that
   instance's runbook. Exposing or redeploying an external worker is not a
   prerequisite for an ordinary K3s/RKE2 Work release or the current production
   domains.

6. **Record the accepted capabilities.** Check org-config's advertised formats
   and qualify each required export with the selected pack. Removing a render
   implementation or making the worker mandatory is a separate application-code
   change, not an installation step.

## Images

Published by `release.yml` on the `v0.2.0` tag (2026-08-14), multi-arch, SBOM- and
provenance-attested and cosign-signed:
`ghcr.io/lolly-tools/lolly-work-server:0.2.0` and
`ghcr.io/lolly-tools/lolly-work-render-worker:0.2.0`. The chart's empty
`image.tag`/`renderWorker.image.tag` default to `appVersion` (= `0.2.0`, kept in step with
`package.json`). This records the historical release, not a current registry pull
or cluster qualification. Select compatible signed application and worker
images, pin `image.digest` and `renderWorker.image.digest`, and retain their
qualification evidence. If the GHCR packages are private in your org, add an
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
