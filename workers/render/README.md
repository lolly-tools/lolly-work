# Render worker — the Chromium tier

The isolated browser worker the control plane dispatches **hooked / HTML-heavy
tools** to. Those tools ship `hooks.js` that may touch real browser APIs, so they
can't run in the control plane's in-process jsdom fast path — and because they run
the least-trusted content, they run **here**, in a separate, hardened deployment
that is blast-separated from the control plane (no database, no secrets beyond the
shared HMAC key).

## How it renders

It mirrors the proven MCP Tier-B path: drive a headless Chromium against a real
Lolly **web shell** export URL —
`<LOLLY_WEB_BASE>/t/<toolId>?<query>&<locked-overrides>&format=svg&export` — and
capture the SVG the app's own export downloads. The tool's hooks run in a real
browser exactly as a user's Download would. The control plane keeps all policy:
it bakes locked values into the `overrides` before signing the job, and it
watermarks / adds provenance / rasterises the returned SVG itself.

## Protocol (must match `server/src/render/worker-client.ts`)

```
POST /render
  x-lw-render-sig: base64url( HMAC-SHA256(rawBody, LW_RENDER_WORKER_SECRET) )
  { "toolId", "query", "overrides", "format": "svg", "profile", "ts": <epoch ms> }
  → 200 { "svg": "<svg …>" } | 4xx/5xx { "error": { "code", "message" } }
GET /healthz → 200 { "ok": true }
```

The signature covers the exact request bytes; `ts` must be within ±5 min
(`LW_RENDER_TS_SKEW_MS`).

## Config (env)

| var | required | meaning |
|---|---|---|
| `LW_RENDER_WORKER_SECRET` | ✅ | shared HMAC key (identical value on the control plane) |
| `LOLLY_WEB_BASE` | ✅ | a served Lolly web shell the worker drives (e.g. the OSS web deployment) |
| `PORT` | | listen port (default 8791) |
| `LW_RENDER_NAV_TIMEOUT_MS` / `LW_RENDER_EXPORT_TIMEOUT_MS` | | per-render timeouts |
| `LOLLY_BROWSER_PATH` / `LOLLY_BROWSER_CHANNEL` | | pin a specific Chromium instead of the bundled one |

## Run / build

```bash
npm install && npm run install:browser   # local: fetch Chromium
LW_RENDER_WORKER_SECRET=… LOLLY_WEB_BASE=https://lolly.example npm start

docker build -t <registry>/lolly-render-worker:0.1.0 workers/render
```

On the **control plane**, point it here: set `render.worker.url` in `instance.json`
and `LW_RENDER_WORKER_SECRET` in the environment (same value). With both set,
hooked tools render via this worker; without them, they still return
`501 HOOKED_TOOL_NEEDS_CHROMIUM`.

## Hardening

Runs as a non-root user with Chromium's `--no-sandbox` (pod-level isolation
substitutes for Chromium's own sandbox, which needs privileges we don't grant).
In production run it under a sandboxed runtimeClass (gVisor / Kata) and a strict
NetworkPolicy — it only needs to reach `LOLLY_WEB_BASE`, and only the control
plane needs to reach it.
