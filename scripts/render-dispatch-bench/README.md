# Render dispatch benchmark: push against pull

This harness answers one question for plan 324 milestone M3, decision D5:
should render workers pull jobs from Work instead of Work pushing jobs to them?
Pull becomes the default only where measurement shows it is faster:

- it matches push at p50 under light load, and
- it beats push on p95 and on throughput under saturation,
- on a fixed corpus, with 1 worker and with 16.

The harness does not change any default. Results are written to the directory
you name with `--out`, which must be outside the repository.

## What is compared

| | Push (default) | Pull (`render.worker.dispatch: "pull"`) |
|---|---|---|
| How a job reaches a worker | Work POSTs the signed job to the worker Service | A worker slot long-polls `/api/internal/render/lease` and receives the same signed job |
| A full worker | answers `503 RENDER_BUSY`; its readiness probe takes the pod out of the Service | asks for no job, so the job waits in Work, in order |
| The durable render row | PostgreSQL claim, heartbeat, fencing, retries: unchanged | the same: only the transport under the pipeline differs |

Both modes use the same Work image, worker image, runner concurrency
(`LW_RENDER_CONCURRENCY`, set to workers times slots), worker timeout and
corpus. `tests/render-dispatch-bench.test.ts` checks that the two deployments
differ only in the dispatch setting.

## The corpus

`corpus.ts` defines two fixed corpora. A seed fixes the job sequence and the
arrival times, so push and pull receive identical work.

- **mixed**: half tier-a, half tier-b. tier-a is `bench-card` (see below), SVG
  and PNG. tier-b is `qr-code` (SVG and PNG), `chart` and `color-palette`, which
  ship hooks, so the worker renders them in the real shell in Chromium.
- **light**: tier-a only, three PNG to one SVG. Work renders the card in its
  jsdom path and the worker's Chromium rasterises the PNG, a short browser job.
  It measures the dispatch layer when the work itself is cheap, and it is the
  corpus that fits 16 workers on one laptop-sized node.

Today's Lolly catalogue has almost no hook-less tool with an SVG template: the
three hook-less tools are HTML (`battlecards` fails in Work's jsdom path with
"SVG export requires an `<svg>` in the template"). So the benchmark adds one,
`bench-card`, to its own shell build: a static SVG card with three inputs. Its
files are in `bench-card/` beside this README.

## Loads

For each worker count the harness deploys push first and runs:

1. **saturation**: `max(80, 6 × slots)` renders submitted at once. Throughput
   is succeeded renders per second from the first submission to the last
   settlement.
2. **medium**: Poisson arrivals at 60% of push's saturation throughput.
3. **light**: Poisson arrivals at 15% of it.

It then deploys pull and runs the same three plans, with the same jobs and the
same arrival times. Each deployment starts with an unrecorded warm-up, and each
run starts from an empty render table. Latency is `finished_at - created_at`
from PostgreSQL's own clock, so the client's polling never rounds it. The
client also samples `/metrics` once a second and records the peak of every
`lw_render_*` series.

## Topology

One k3d node; in namespace `lw-bench`:

- `postgres`: PostgreSQL 17 on scratch storage.
- `work`: one replica (the chart's limit), evaluation mode, PostgreSQL store,
  the signed shell build mounted read-only as both `instance.shellDir` and
  `instance.pack`.
- `render-worker`: N replicas, each with `LW_RENDER_MAX_CONCURRENT` slots,
  HTTPS on the Service with a benchmark CA (push), the chart's probes, the
  reviewed seccomp profile (`deploy/seccomp/chromium.json`) and a read-only
  root.
- a load client Job per run, in Work's image.

Two things are for the benchmark only, and the manifests say so:

- Each worker pod has a loopback forwarder (`127.0.0.1:8080` to the Work
  Service). It gives the browser a secure-context shell origin and the pull
  loop a loopback URL without an ingress. Production uses HTTPS for both.
- The client signs in through the dev provider (`dev.enabled`).

## Running

Prerequisites: Docker (colima on macOS), k3d, kubectl, openssl and Node 24+.
On macOS, give the VM room (the measured runs used 8 CPUs and 14 GiB), and
check free disk first: the images, the shell build and the cluster need about
12 GiB.

1. Build a signed Lolly shell at this checkout's engine pin
   (`engine-pin.json` `generatedFrom`) with a fresh benchmark-only catalogue
   key, as `scripts/qualify-render-worker-image.ts` does, with the bench tool
   added:

   ```bash
   git -C <lolly> worktree add --detach <lolly>/.worktrees/bench-shell <generatedFrom>
   cp -R scripts/render-dispatch-bench/bench-card <lolly>/.worktrees/bench-shell/community/
   cd <lolly>/.worktrees/bench-shell && pnpm install --frozen-lockfile
   rm brands/lolly-start/catalog/tools/index.sig.json   # a new key starts a new lineage
   CI=true LOLLY_PROFILE=lolly-start VITE_REQUIRE_AI_POLICY=true \
     LOLLY_CATALOG_SIGNING_KEY="$(cat key.pem)" VITE_CATALOG_PUBLIC_KEY_JWK="$(cat key.pub.json)" \
     sh -c 'pnpm run build:catalog && pnpm run build:web:release'
   ```

2. Build the two images from this checkout:

   ```bash
   docker build -f deploy/compose/Dockerfile -t lw-bench/work:dev .
   docker build -t lw-bench/worker:dev workers/render
   ```

3. Create the cluster, mounting the shell build and the seccomp profile on the
   node, and import the images:

   ```bash
   k3d cluster create lw-bench --servers 1 --agents 0 --no-lb \
     -v <lolly>/.worktrees/bench-shell/shells/web/dist:/bench/shell@server:0 \
     -v "$PWD/deploy/seccomp:/var/lib/kubelet/seccomp/lolly@server:0" \
     --k3s-arg "--disable=traefik@server:0" --kubeconfig-update-default=false
   k3d kubeconfig write lw-bench --output <out>/kubeconfig
   k3d image import lw-bench/work:dev lw-bench/worker:dev -c lw-bench
   ```

   On an AppArmor host (Ubuntu, Debian, and colima's Ubuntu VM), Chromium's
   sandbox needs to create user namespaces. Load `deploy/apparmor/lolly-chromium`
   on the node and pass `--apparmor=lolly-chromium` where the node exposes
   AppArmor to the kubelet. A k3d node does not mount securityfs, so the kubelet
   refuses a Localhost AppArmor profile there; in a disposable VM the measured
   runs instead set `kernel.apparmor_restrict_unprivileged_userns=0`. Chromium's
   own sandbox and the seccomp profile stay on either way.

4. Run, per corpus:

   ```bash
   node scripts/render-dispatch-bench/bench.ts --kubeconfig=<out>/kubeconfig \
     --catalog-key=key.pem --out=<out> --corpus=mixed --workers=1,4
   node scripts/render-dispatch-bench/bench.ts --kubeconfig=<out>/kubeconfig \
     --catalog-key=key.pem --out=<out> --corpus=light --workers=1,4,16
   node scripts/render-dispatch-bench/report.ts <out>/runs.json
   ```

   A run already recorded in `<out>/runs.json` is skipped, so an interrupted
   matrix resumes. `<out>/raw-*.json` keeps every render's timings and the
   distinct error messages seen while it ran. The benchmark-only credentials
   (`secrets.json`, mode 600, and the test CA) go to `--keys=<dir>`, which
   defaults to `<out>`; keep them out of anything you share.

5. Tear down what you created: `k3d cluster delete lw-bench`, the two images,
   the shell worktree, and the VM if you made one for this.

## Reading the results

`report.ts` prints one table per corpus and the D5 check per worker count.
"Matches" at light load means pull's p50 is at most 10% (or 50 ms, whichever
is larger) above push's; "beats" means strictly better. Look at the failure
column as well as the latency: under push, a worker that is full answers 503
and, with the chart's readiness probe, leaves the Service until the next probe,
so pushes in that window fail to connect. The durable runner retries both with
a back-off, and a render that exhausts `maxAttempts` (3 by default) fails.

The numbers measure dispatch on one node. A laptop VM has far fewer CPUs per
browser slot than a real cluster, so absolute latencies are high and the
16-worker runs are CPU-bound; compare the modes with each other, not with
production.
