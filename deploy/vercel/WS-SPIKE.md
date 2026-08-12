# Vercel WebSocket spike — can the trial host carry collab rooms?

> Research only, 2026-08-09. No deploy, no code changes to `api/` or `vercel.json`.
> Answers the question `deploy/vercel/README.md` used to beg: it asserted flatly
> "no WebSocket/collab" with no expiry, and the OSS design notes
> already flagged that claim as unverified against a platform that has since
> shipped native support. This is that verification.

## Verdict, up front

**The platform claim is real, but it doesn't fit our Function shape or our room
model as they stand today.** Vercel Functions can now hold a live WebSocket —
public beta, real RFC 6455 upgrades, not a hack. That reverses the blanket "Vercel
can't do this" assumption. It does **not** mean `lolly-work`'s trial deploy can pick
up collab rooms by flipping a flag:

- Our Vercel entry point (`api/_index.ts`) exports a plain `(req, res)` handler
  function. Vercel's native WS path wants the entry to export an `http.Server`
  instance instead (`export default server`) so a library like `ws` can attach a
  `WebSocketServer` to it. That's a real restructuring of the entry point, not a
  config toggle — see §2.
- Vercel's own docs for this feature tell you to move room/presence state to an
  **external store** (Redis, Postgres) because a reconnect is not guaranteed to
  land back on the same Function instance. That is a materially bigger ask than
  our current room design, which keeps the Yjs document authority in one
  process's memory between snapshots — the exact
  "one node serves the org" assumption the sticky-rooms note in
  `deploy/helm/values.yaml` already documents as the thing multi-replica breaks.
  Vercel's serverless model breaks that assumption on **every** reconnect, not
  just under a multi-replica Helm install.
- A WebSocket connection is hard-capped at the Function's `maxDuration` — 5
  minutes by default, up to 800s (GA) or 1800s (beta, restricted) on Pro/Enterprise.
  There is no idle-hibernation like Cloudflare Durable Objects: the connection
  either lives inside its duration budget or it's cut, full stop, and the client
  reconnects. A collab room that stays open for a working session (hours) would
  hit this **every 5–30 minutes, forever**, not as an edge case but as the steady
  state.

**Recommendation, matching what the design notes already expected:** the Vercel
trial host **may** carry short-lived rooms — a quick pairing demo, a session under
the default 5-minute window, exercised by the existing reconnect path doing double duty as the *normal* reconnect cadence rather
than a failure path. It should **not** be treated as parity with the sovereign
target. The Helm deployment (`deploy/helm/`, a persistent Node process, the sticky-
room ingress guidance just added there) remains the real collab host, exactly as
the plan already assumed before this spike ran.

---

## 1. What Vercel now claims (public beta, shipped June 22 2026)

Per current docs (`vercel.com/docs/functions/websockets`, last updated 2026-07-24)
and the beta changelog:

- Native WebSocket upgrades are supported directly in Vercel Functions — no
  external gateway service needed. Requires **Fluid Compute**, which has been the
  default for new projects since 2025-04-23 (our `lolly-work` Vercel project, per
  §7's "decided 2026-07-21" note, was created well after that — Fluid Compute
  should already be on by default, but this wasn't explicitly checked and is worth
  confirming in the project's Settings → Functions before relying on any of this).
- Supported "with no additional configuration" for Node.js server frameworks that
  own their own `http.Server` — the docs' own minimal example:

  ```ts
  import http from 'http';
  import { WebSocketServer } from 'ws';

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(data));
  });

  export default server;
  ```

  Express, Hono, h3/Nitro, and the Python ASGI/WSGI stacks (FastAPI, Django
  Channels, Flask-Sock) are also listed as supported without extra Vercel-specific
  glue. Next.js is the one exception — it has no server-owned `http.Server` to
  attach to, so Vercel ships an `experimental_upgradeWebSocket()` helper from
  `@vercel/functions` as a workaround. **We are not Next.js** — our entry is a
  bare Node handler already close to the "just export a server" shape — so we'd
  use the plain `ws` path above, not the experimental helper.
- "A single WebSocket connection is pinned to one Vercel Function instance" for
  its lifetime — messages on that connection keep reaching the same instance —
  **but** "new WebSocket connections are not guaranteed to reach the same
  instance" on reconnect, and after a redeploy, existing connections stay on the
  old deployment until they close while new ones reach the new one. Vercel's
  explicit guidance: keep durable state, presence, counters, and pub/sub
  coordination in an external store (they suggest Marketplace Redis), not
  in-memory.
- The upgrade request goes through the normal request pipeline first (Routing
  Middleware, rewrites, Firewall rules, rate limits) before the 101 Switching
  Protocols response — same auth-before-handshake shape our own gateway already
  uses (`server/src/collab/gateway.ts`'s header comment: "auth happens before the
  handshake").
- Billing: standard Function pricing (active CPU time + provisioned memory time)
  applies for the life of the connection, plus Fast Data/Origin Transfer for
  bytes sent over it. The beta changelog additionally claims Active CPU billing
  only charges for time spent processing messages, not idle connection time —
  plausible given how Active CPU pricing already works elsewhere on the platform,
  but worth confirming against an actual bill before sizing a budget around it;
  the docs page itself doesn't repeat that idle-is-free claim as unambiguously.

## 2. What our (req, res) shape would need to become

`api/_index.ts` today (see its own header comment) is deliberately a **plain
function handler**, not a server:

```ts
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  restoreOriginalPath(req);
  const app = await getApp();
  await app(req, res);
}
```

That's the shape Vercel's Node.js runtime calls per-request; it works because
`buildApp()` (`server/src/api/app.ts`) already returns exactly that `(req, res)`
signature. Native WS support wants the opposite: a **module that exports an
`http.Server`**, so Vercel can hand it raw sockets and let `ws`'s
`WebSocketServer` intercept the `Upgrade` header before the request ever becomes
a "handler call". These are two different execution models under one platform
feature, and bridging them for `/ws/collab/*` specifically — without dragging
the REST surface into the same server object — would mean:

1. A **separate** Vercel Function for the collab path (e.g. `api/_ws.ts`,
   mirroring the existing `_index.ts`/`_lib` split), exporting its own
   `http.createServer()` + attached `WebSocketServer`, routed to `/ws/collab/*`
   via `vercel.json`. This keeps the change scoped and out of `app.ts`'s import
   graph — which is exactly the isolation `server/src/collab/gateway.ts`'s header
   comment already argues for today, for the same reason (today: "the platform's
   WebSocket story is unverified"; after this spike: "the platform's story is
   verified but structurally different, so keep it isolated anyway").
2. `ws` moving from "recommended dependency" (already
   flagged for the sovereign gateway) to something the Vercel bundle
   (`scripts/build-vercel-fn.mjs`) also needs to esbuild in — no new blocker,
   the sovereign target already wants this dependency declared.
3. The room/presence authority question (§3 below) actually decided, since it's
   the harder half of this — the entry-point reshape is mechanical, external
   state is not.

None of this is wired up by this spike. It's scoped out by the task
(`deploy/vercel/README.md` is the only file that changes, and only its stale
claim).

## 3. The room-authority problem gets worse here, not solved

The current design states plainly: "Scale: payloads are
tens of bytes; one node serves the org. Multi-replica needs sticky rooms
(session-id affinity at the ingress) — note it in the Helm chart; no pub/sub bus
until a real deployment needs it." The Helm chart now carries that affinity
guidance (`deploy/helm/values.yaml`, `ingress.annotations` comment block) as a
**stop-gap that works because Helm gives us a stable pod to hash a room onto**.

Vercel's serverless model doesn't offer that lever at all — there is no ingress
annotation to set, because there's no fixed set of instances to hash across in
the first place; Fluid Compute scales instances up and down continuously, and
the platform's own docs tell you not to assume connection stickiness survives a
reconnect. Combined with the 5–30 minute forced-disconnect ceiling (§1), a room
hosted on Vercel would need EVERY reconnect — which, again, is not a rare event
here, it's the normal cadence — to either:

- land back on an instance that happens to still hold that room's in-memory Yjs
  document (unverified, and the docs actively say not to rely on it), or
- rehydrate the room from the Postgres snapshot on every forced reconnect,
  which is exactly what the existing reconnect path already does for a genuine
  network drop ("client sends last clock; diff if cheap,
  else full snapshot + reapply") — just now running every few minutes instead of
  occasionally, and needing that snapshot cadence tuned tighter than the
  20-revision/500-update calibration picked for the general case if a Vercel-hosted room shouldn't visibly hiccup on each forced cycle.

Neither path is free, and the second one is the honest one: treat every Vercel
WS connection as short-lived by construction, lean entirely on the
snapshot-and-replay reconnect machinery that already has to exist anyway, and
never assume in-memory continuity across a reconnect the way the Helm/sticky-pod
design is allowed to.

## 4. Bottom line

- The "no WebSocket on Vercel" claim is out of date and has been corrected in
  `deploy/vercel/README.md` to point here instead of asserting impossibility.
- The platform capability is real; our adoption cost is not "flip it on" — it's
  a separate Function with its own server object, `ws` as a real dependency, and
  either an external state store or a much tighter snapshot cadence to paper
  over the duration ceiling.
- Per plan 100 §11.31's own framing: verify before letting the trial host carry
  rooms. This spike is that verification, and the answer is a qualified yes for
  **short** rooms only — the sovereign Helm target remains the real destination
  for collab, unchanged from what the plan already expected.

### Sources

- <https://vercel.com/docs/functions/websockets> (WebSockets guide, last updated 2026-07-24)
- <https://vercel.com/changelog/websocket-support-is-now-in-public-beta> (public beta changelog, 2026-06-22)
- <https://vercel.com/docs/functions/limitations> (`maxDuration` table, Fluid Compute defaults)
