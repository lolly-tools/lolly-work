# Demo: the lolly-work control plane, one command

`npm run demo` boots a fully-seeded local deployment of the control plane — identity,
governance, the governed catalog, the render plane, telemetry, and the admin
console — on a single port, from an in-memory store. Nothing is written to disk;
stop the server and it's gone.

Everything runs same-origin, so session cookies work and the whole product — the
Lolly web shell at `/`, the admin console at `/admin`, the API, the catalog, and
renders — is one URL to click around.

## 1. Prerequisites

- **Node 24+** (the repo runs `.ts` directly via native type-stripping).
- The pack + shell are read from the sibling OSS repo at `../lolly` (the demo
  points `pack` and `shellDir` there). No build step is required to start.
- **For the full employee governance UX**, build the web shell once, in `../lolly`:

  ```bash
  cd ../lolly && npm run build:web
  ```

  Why: the shipped `../lolly/shells/web/dist` may predate the shell's `org/`
  governance module (the sign-in gate, locked-input controls, "Request approval"
  button, team projects). The demo **detects** this by scanning the built bundle
  for the org-config marker and picks its access mode accordingly:

  | Shell dist | Access mode | What you see in the shell |
  |---|---|---|
  | **Fresh** (has org module) | `gated` | Sign-in gate, then locked inputs + Request-approval + team projects |
  | **Stale / absent** | `open` | The shipped shell loads the catalog + renders (no governance UX) |

  Either way, the **console** (`/admin`), the **governed catalog**, and the
  **render plane** are fully demoable. Only the in-shell employee governance UX
  needs the fresh build. The demo prints its verdict at boot. Building the shell
  is yours to run — the demo never builds anything.

## 2. Run it

```bash
npm run demo            # boots on :8787
PORT=8788 npm run demo  # any other port
```

Open the **OPEN** URL from the banner. The banner also prints one dev sign-in
link per persona and the dist-freshness verdict.

Sign-in is the **dev provider** — no passwords. Click a link, or hit
`/api/auth/dev?email=<persona>&returnTo=/` (or `…&returnTo=/admin`).

## 3. Personas

| Persona | Email | Groups | Role |
|---|---|---|---|
| Admin | `admin@suse.example` | admin | admin |
| Brand lead | `brand@suse.example` | brand-team, approver | approver |
| Marketer | `marketer@suse.example` | marketing | member |
| Contractor | `contractor@suse.example` | contractors | member |

## 4. The tour

### Marketer — `marketer@suse.example` (open the shell at `/`)
- The **export button reads "Request approval"**, not Download — marketing is
  denied `export.download`, so exports route into the brand-review chain.
- On **event-name-badge**, the **logo input is locked** to the brand logo (baked,
  not editable) and the tool is bound to the **brand-review** approval chain.
- On **qr-code**, the **module colour is locked** to SUSE green and the
  **background input is hidden** entirely. Open the seeded qr-code link and the
  locked colour is what renders — a param that tries to override it is refused.
- In the console Approvals view (or the shell's requests list), the marketer's
  **"your requests"** shows all states: one pending, one approved, one
  rejected-with-comment, one waiting at legal.

### Brand lead — `brand@suse.example`
- On qr-code and event-name-badge, brand-team **can edit** the very inputs the
  marketer sees locked (colour, background, logo) — same overlay, different group.
- Has an **approvals inbox**: the "Brand sign-off" step of the brand-review chain
  is routed to brand-team/approver. Approve to advance it to legal; reject (with a
  required reason) to send it back to the submitter.

### Admin — `admin@suse.example` (open the console at `/admin`)
- **Overview** — 14 days of activity (events + exports per day), top tools,
  exports by format, and fleet-by-client, all from the seeded telemetry + fleet.
- **Projects** — the team project *Summit 2026* (visible to marketing + brand-team)
  and a private one. Open a project to browse its sessions and run a **multi-edit**:
  pick a tool, set `field=value` lines, **Preview** the exact before→after diff
  across every matching session, then **Apply** (each session keeps a revision).
- **Catalog** — every served asset with its lifecycle **state**: an upcoming
  expiry (warn), an expired-but-warned asset (still served), an expired-and-hidden
  one, and a scheduled one. Set an expiry date or arm-and-confirm a **revoke**; a
  hidden/revoked/scheduled asset's blob **410s** immediately.
- **Approvals** — admin's inbox holds the **"Legal sign-off"** step of a request
  that already cleared brand. Separation of duties means you never review your own.
- **Links** — every share / embed / download / guest link, live and revoked;
  **Revoke** kills one instantly.
- **People** — the four signed-in users, their roles, groups, and telemetry
  consent (opt-in).
- **This Deploy → Feature flags** — govern the shell's per-user flags: seeded
  here, *Strip metadata from uploads* is forced **On** org-wide, and *Jelly
  effects* is **hidden** (its default still applies, but members get no toggle —
  the way a seasonal surprise ships dark, then lights up when you flip it On).
- **Fleet** — which shells + engine versions are talking to the deployment.
- **Rooms** — live collaborative sessions on the deployment *right now*: who is in
  each shared session and whether they can write (writer/observer), with a per-room
  op counter and start time. Seeded with a few illustrative rooms — the panel shows
  only counters and display names, never a cursor, keystroke, or input value.
- **Messages** — compose an announcement / upgrade / policy notice with an
  audience (groups, shells, max-engine) and see reach; two are pre-seeded.
- **Audit** — the append-only, hash-chained event log with an intact-chain badge.
- **Docs** — this repo's operator documentation (`docs/`), rendered in the console, so
  the deploy explains itself: configuration, roles and grants, governance, runbook.
  When a Lolly deployment is linked, it also links out to the open-source docs at
  `/info/`.

## 5. What's real vs. stub

- **Governance, catalog, telemetry, approvals, links, projects, sessions,
  messages, fleet, audit** — all real, end-to-end over the same code paths the
  production server uses.
- **Render plane** — the server renders **hook-less** tools in-process (jsdom +
  the real engine), e.g. `countdown-timer` (seeded with an always-on preview
  watermark). A tool that ships `hooks.js` returns **501 HOOKED_TOOL_NEEDS_CHROMIUM**
  — the Chromium sandbox is a later milestone.
- **Sync** — server + console are the source of truth; the shell reads org-config
  and opens catalog assets/sessions.
- **Live collab (Rooms)** — the console **Rooms** panel is populated with a few
  **mock** live rooms, so you can see the shape of live collaboration (rosters,
  roles, op counters). The real thing — actual WebSocket collaborative editing —
  runs in the collab gateway (`server/src/main.ts`, the sovereign Helm deploy); this
  in-process demo boots the HTTP app only, so its rooms are illustrative snapshots.
- **Store** — in-memory. Boot, click around, gone on restart. (The same code runs
  against Postgres via `DATABASE_URL`.)
- **Identity** — the dev provider stands in for the OIDC IdP; real sign-in is the
  same flow behind `idp.issuer`.
