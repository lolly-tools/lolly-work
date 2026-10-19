# Render worker: the Chromium tier

The isolated browser worker the control plane dispatches **hooked / HTML-heavy
tools** to. Those tools ship `hooks.js` that may touch real browser APIs, so they
can't run in the control plane's in-process jsdom fast path - and because they run
the least-trusted content, they run **here**, in a separate, hardened deployment
that is blast-separated from the control plane. It has no database credential;
its only private material is the shared request key and worker TLS key.

## How it renders

It mirrors the proven MCP Tier-B path: drive a headless Chromium against a real
Lolly **web shell** export URL -
`<LOLLY_WEB_BASE>/t/<toolId>?<query>&<locked-overrides>&format=svg&export` - and
capture the SVG the app's own export downloads. The tool's hooks run in a real
browser exactly as a user's Download would. The control plane keeps all policy:
it bakes locked values into the `overrides` before signing the job, and it
watermarks / adds provenance / rasterises the returned SVG itself.

## Protocol (must match `server/src/render/worker-client.ts`)

```
POST /render
  x-lw-render-sig: base64url( HMAC-SHA256(rawBody, LW_RENDER_WORKER_SECRET) )
  { "toolId", "query", "overrides", "format": "svg", "profile", "ts": <epoch ms> }
  -> 200 { "svg": "<svg …>" } | 4xx/5xx { "error": { "code", "message" } }
GET /healthz -> 200 { "ok": true }
```

The signature covers the exact request bytes; `ts` must be within ±5 min
(`LW_RENDER_TS_SKEW_MS`).

## Config (env)

| var | required | meaning |
|---|---|---|
| `LW_RENDER_WORKER_SECRET` | ✅ | shared HMAC key (identical value on the control plane) |
| `LW_RENDER_TLS_CERT_FILE` / `LW_RENDER_TLS_KEY_FILE` | production | read-only certificate chain and matching key files |
| `LW_RENDER_TLS_SERVER_NAME` / `LW_RENDER_TLS_CA_FILE` | TLS healthcheck | Service DNS name and approved private CA bundle |
| `LW_RENDER_DEPLOYMENT_MODE` | | production requires TLS; evaluation HTTP listens only on loopback |
| `LOLLY_WEB_BASE` | ✅ | canonical HTTPS Lolly shell URL with trusted TLS; HTTP only for explicit localhost/127.0.0.1/[::1] development |
| `LW_RENDER_ALLOWED_ORIGINS` | | comma-separated origins a rendered page may reach even on a private address (an internal asset host); plain origins, no paths |
| `PORT` | | listen port (default 8791) |
| `LW_RENDER_NAV_TIMEOUT_MS` / `LW_RENDER_EXPORT_TIMEOUT_MS` | | per-render timeouts |
| `LW_RENDER_BROWSER_STARTUP_TIMEOUT_MS` | | browser startup and recovery budget, default 30000 ms; integer from 1000 to 120000 |
| `LOLLY_BROWSER_PATH` / `LOLLY_BROWSER_CHANNEL` | | pin a specific Chromium instead of the bundled one |

## Run / build

```bash
pnpm install && pnpm run install:browser   # local: fetch Chromium
LW_RENDER_WORKER_SECRET=… LOLLY_WEB_BASE=https://lolly.example npm start

docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
```

On the **control plane**, point it here: set `render.worker.url` in `instance.json`
and `LW_RENDER_WORKER_SECRET` in the environment (same value). With both set,
hooked tools render via this worker; without them, they still return
`501 HOOKED_TOOL_NEEDS_CHROMIUM`.

Use an HTTPS worker URL in production and mount the approved public CA bundle in
the control plane. See [transport configuration](../../deploy/helm/RENDER-TRANSPORT.md)
for certificate provisioning, healthchecks and rotation.

## Hardening

Runs as a non-root user with Chromium's sandbox explicitly enabled through
Playwright's `chromiumSandbox: true`. There is no unsandboxed launch setting or
automatic fallback. Startup begins a bounded browser launch; readiness stays
false until the browser is connected. A disconnect removes readiness immediately
and starts one shared recovery launch with the same settings and budget. Failed
startup or recovery stops the worker with a nonzero exit status.

Keep the existing read-only root filesystem, dropped capabilities,
no-new-privileges, seccomp profile and NetworkPolicy. Qualify the exact Linux
image, host kernel and container runtime before promotion. Chromium's sandbox
needs namespace support, and a runtime's default seccomp profile may refuse the
required operations. A refusal is a deployment qualification failure; do not add
privileges, switch seccomp off or disable the browser sandbox to bypass the check.
[Playwright's launch options](https://playwright.dev/docs/api/class-browsertype)
and [container guidance](https://playwright.dev/docs/docker) describe sandbox
enablement and namespace requirements. A gVisor or Kata runtime class can add
isolation after its own qualification; it does not replace the browser sandbox.
The [reviewed namespace profile](../../deploy/seccomp/README.md) provides an
explicit option for runtimes whose default profile blocks namespace setup.

**Egress rule (plans/58 WP0, `src/egress.ts`).** Every request a rendered page makes,
in both `/render` and `/rasterise`, goes through one rule:
- `blob:`, `data:` and `about:` are allowed; other non-HTTP schemes and model weights are refused.
- `LOLLY_WEB_BASE` and `LW_RENDER_ALLOWED_ORIGINS` are allowed as declared.
- Everything else must be a public address: every DNS answer must be public, and an unresolved name is refused.

WebSockets are refused outright, and Chromium runs with non-proxied WebRTC disabled.
A refusal is logged with its origin and reason, never the full URL.

Chromium resolves a name again when it connects, so a DNS-rebinding host can slip past
the in-process check. The chart's default-on `renderWorker.networkPolicy` closes that at
the network: control-plane ingress only, and egress to cluster DNS, public addresses and
the `extraEgress` rules you add for a private shell or allowed origin.

## Packaged browser and verification

The Dockerfile uses digest-pinned Node 26.12.0 on Debian Bookworm and installs
the Chromium distribution matched to the worker's frozen Playwright lock. The
browser lives at `/opt/lolly-browsers`, readable by the unprivileged runtime user.
It includes the software graphics implementation needed by the shell's required
WebGPU startup check. The launch uses Lolly's software WebGPU pair
(`--enable-unsafe-webgpu`, `--use-webgpu-adapter=swiftshader`) instead of disabling
graphics. A flag cannot compensate for a browser package missing that adapter.
`LOLLY_BROWSER_PATH` and `LOLLY_BROWSER_CHANNEL` remain explicit operator overrides;
remove an obsolete Alpine executable override when adopting this image.

Run as the unprivileged `node` user with a read-only root filesystem, dropped
capabilities, no-new-privileges and writable ephemeral `/tmp`. Chromium's user-data
directory, XDG configuration and cache use that temporary mount. Health is HTTPS
`/healthz`; `/readyz` reports `{ ok, active, capacity }` with HTTP 503 when the
browser is not connected or capacity is full.
`active` includes cancelled requests until their Chromium contexts finish closing.
Supply the approved
`LW_RENDER_WORKER_SECRET` and `LOLLY_WEB_BASE` using deployment configuration and
secret references. The browser sandbox setting and pod isolation are described
in the chart; prefer the approved stronger runtime isolation where available.

Shell renders lock supported AI off and reject model URLs. Finished-SVG
rasterisation disables JavaScript and also rejects model URLs. The raster path
therefore does not execute scripts embedded in uploaded SVGs. It still requires
an authenticated HMAC request, and network restrictions must reflect the approved
service boundary.

Before promotion, exercise a real signed-shell tool export and PNG/PDF rendering
in the built image, verify signature refusal and AI/model containment, scan that
exact image and collect staging results. A passing health probe alone does not
prove Chromium can start under the deployment's filesystem/security settings.

CI runs the built worker's actual browser singleton against a signed shell from
the exact `engine-pin.json` source. It builds the neutral `lolly-start` profile
through Lolly's ordinary release wrapper and gate with a fresh test signing key;
no instance signing key, agent credential or private brand pack is needed. The
key remains in the preparation process and its temporary container environment,
never in the worker image or published artifact. The test checks QR SVG/PNG through
the gated Work API, render-read tickets, real hooks, bad HMAC refusal, context
cancellation and loopback/model/WebSocket refusal. Its original 20-second render
deadline remains unchanged. Existing injected-browser tests are supplementary.

Run the same acceptance with a clean isolated checkout matching the engine pin,
frozen Work and Lolly dependencies installed on Linux amd64 or arm64, Node 26.12.0 and a
local Docker socket:

```sh
docker build -t lolly-render-worker:qualification workers/render
node scripts/qualify-render-worker-image.ts \
  --lolly-root /path/to/isolated-matching-lolly \
  --image lolly-render-worker:qualification --sandbox-profile chromium
```

The command rebuilds only that isolated checkout's signed test shell. It uses
an owned container with a read-only filesystem, temporary storage, dropped
capabilities and no-new-privileges. It changes no Kubernetes resource or instance
data and publishes neither the shell nor an image. Local Docker cleanup refuses
an identity mismatch. CI currently exercises Linux amd64 with 1 GiB and one CPU;
other architectures and production resource limits require their own acceptance.
The image architecture must match the qualification host. The acceptance checks
the actual renderer's user and PID namespaces and additional seccomp filter.
Use `--sandbox-profile runtime-default` to qualify the runtime's own profile.
Repeat acceptance on the actual target runtime. Launch flags and a passing health
probe alone do not establish that evidence. The graphics test
makes no physical GPU, private brand or complete production qualification claim.

This requirement covers the Chromium worker. The control plane's separate
`render.allowHooksInFastPath` setting permits curated hooks to run inside
`node:vm`, which is not an isolation boundary. Keep that setting false for
production packs. The evaluation profile enables the bundled demo path; review
that deliberate evaluation setting separately when preparing a production config.
