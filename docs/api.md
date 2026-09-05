# API surface

Every route the console and the CLI use - they share one API, so the two surfaces stay in
parity by construction. Errors are `{ error: { code, message } }` with an honest HTTP status.

"Action" is the RBAC action the caller must hold ([permissions](permissions.md)); *member*
means any signed-in member; *public* means no session needed.

## Health and metrics

| Route | Action | Notes |
|---|---|---|
| `GET /healthz` | public | `{ ok, name, accessMode, appUrl? }` |
| `GET /metrics` | token | Prometheus; loopback-only unless `LW_METRICS_TOKEN` is set |

## Instance manifest and the connect surface

| Route | Action | Notes |
|---|---|---|
| `GET /api/v1/instance` | public | the card a fresh shell reads before sign-in |
| `GET /connect/pack.lolly` | open: public · else member | the hosted signed instance pack; `404` when none is hosted; `ETag` + `If-None-Match` → `304` |
| `GET /api/v1/instance-pack` | `fleet.view` | the hosted pack's metadata (name, version, signed, checksum), or null |
| `PUT /api/v1/instance-pack` | `instance.config` (**owner**) | host a pack cut by the OSS builder; refused unless its instance base is this deployment |
| `DELETE /api/v1/instance-pack` | `instance.config` (**owner**) | stop hosting |

The manifest is what a downloaded app learns about this deployment before
anyone signs in: `{ name, accessMode, provider, providerName, loginPath,
engineVersion, capabilities, brand, connect? }`. `engineVersion` is the vendored
engine pin this deploy serves tools against; `capabilities` names the surfaces
the server ships (`catalog`, `collab`, `submit`, `scim`); `connect.packUrl`
appears exactly while a pack is hosted. It carries no secrets and no user
data, and shares the auth rate-limit bucket. Any origin may read it
(`Access-Control-Allow-Origin: *`, with `OPTIONS` answering the preflight),
because a client that adds this deployment's design system by URL fetches this
card from its own page before anyone has signed in. The pack itself is never built
here - the OSS repo's `build-instance-pack.ts` owns the signed format, and
this instance is where the finished pack publishes to. See "Connecting apps to
this instance" in [operations](operations.md) for the connect story.

`brand` is the design system this deployment hosts, for a client that adds one
by URL and keeps it on the device for offline use (OSS `plans/186`):

```json
"brand": {
  "profile": "suse",
  "label": "SUSE tokens",
  "version": "1.2.0",
  "checksum": "sha256-QOn2…",
  "locked": true,
  "packUrl": "https://brand.example/connect/pack.lolly"
}
```

Every field comes from the mounted pack itself, never from a second copy here.
`profile` is the active brand profile on a profile-aware pack (the one
`GET /api/v1/brand/profiles` lists) and `null` on a single-brand one; `label` is the
tokens asset's name; `checksum` is that asset's own integrity checksum, which is
what a client compares to ask "has the brand here changed since I copied it"
without downloading anything; `locked` mirrors the tokens asset's `brandLock`,
so a client knows the brand is authoritative and must not offer to customise it;
`version` is the hosted pack's version when one is hosted; `packUrl` repeats
`connect.packUrl` so one block answers both what is here and where to get it.
The whole block is `null` when the pack ships no tokens asset, and it changes
the moment an admin switches brand profile. It states no colours and no font
files: those stay behind `GET /api/brand`.

The pack download is conditional. `GET /connect/pack.lolly` sends a strong
`ETag` (the hosted pack's checksum, the same one `GET /api/v1/instance-pack`
reports) with `cache-control: private, no-cache`, and answers `304` to an
`If-None-Match` that matches, so a client re-checks a pack it already holds for
the price of one header. The access gate is unchanged and runs first: on a gated
instance an unauthenticated conditional request gets `401` and no tag.

Cross-origin reads of the pack follow that same gate. An **open** instance sends
`Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: ETag` (a
browser hides the tag from script otherwise, and the tag is what the client came
for), and answers the `OPTIONS` preflight a conditional GET triggers with
`Allow-Methods: GET`, `Allow-Headers: If-None-Match` and a day of `Max-Age`. A
**gated** instance sends no CORS header at all, on the download or the
preflight: a page on another origin cannot present the session cookie, and a
wildcard with credentials is refused by browsers, so the answer there is to sign
in on the instance and export the pack, or connect from the desktop app.

## Auth

| Route | Action | Notes |
|---|---|---|
| `GET /api/auth/config` | public | what the sign-in screen needs (mode, IdP display name) |
| `GET /api/auth/login` | public | starts OIDC (PKCE); `404 NO_IDP` without an issuer |
| `GET /api/auth/callback` | public | verifies the `id_token`, mints `lw_session` |
| `GET /api/auth/dev?email=…` | public | dev provider only; `404` when `dev.enabled` is false |
| `GET /api/auth/session` | member/guest | the current principal |
| `POST /api/auth/logout` | any | clears both cookies |
| `POST /api/v1/auth/device` | public | start device sign-in: `{deviceCode, userCode, verificationUri, interval, expiresIn}` |
| `POST /api/v1/auth/device/token` | public | the device's poll: `{status}` of `pending`/`denied`/`expired`, or `approved` + the session cookie (single read) |
| `GET /activate` | member (page) | where a person types and confirms a device code - approval binds the approver's identity, so it lives here and nowhere else |
| `GET /api/v1/auth/device/pending` | `fleet.view` | pending codes, oldest first |
| `POST /api/v1/auth/device/deny` | `fleet.manage` | refuse a pending code from the console |

## The polled document

| Route | Action | Notes |
|---|---|---|
| `GET /api/v1/org-config` | member | the one document a shell polls; ETag'd on policy version |
| `GET /api/v1/org-config/preview?groups=a,b` | `policy.edit` | what a member in those groups would receive |

## Catalog

| Route | Action | Notes |
|---|---|---|
| `GET /catalog/*` | per access mode | pack blobs, lifecycle-gated |
| `GET /api/v1/catalog/assets/*` | per access mode | asset feed / entries |
| `GET /api/v1/catalog/search` | `catalog.read` | live fan-out to search-capable providers |
| `PUT /api/v1/catalog/assets/<id>/meta` | `catalog.edit` | org-defined field values and `replacedBy` on any asset the caller sees; `name`/`description`/`tags` on `inst/*` only |
| `GET /api/v1/catalog/assets/<id>/versions` | `catalog.read` | one instance asset's byte history, newest first, with the served version and the retention ceiling |
| `PUT /api/v1/catalog/assets/<id>/head` | `catalog.edit` | roll back: `{ "version": N }` points the head at a version that already exists |
| `DELETE /api/v1/catalog/assets/<id>/versions/<n>` | `catalog.edit` | `409 VERSION_IS_HEAD` for the served version, `409 ASSET_HELD` while a hold is set |
| `GET /catalog/inst/<id>/<format>?v=N` | per access mode | a prior version's bytes, through every gate the head answers to |
| `GET /api/v1/catalog/fields` | `catalog.read` | the org's field definitions, plus a `canEdit` bit for honest UI |
| `PUT/DELETE /api/v1/catalog/fields/<id>` | `policy.edit` | define or retire one field; the definitions also ride the governance document |
| `GET /api/v1/catalog/collections` | `catalog.collection.manage` | the curator's view: every set as curated |
| `GET/PUT/DELETE /api/v1/catalog/collections/<id>` | `catalog.collection.manage` | create, edit or remove one set; a `PUT` refuses any member the curator cannot see |
| `GET /api/v1/catalog/lifecycle` | `catalog.expire` | all lifecycle rows |
| `PUT /api/v1/catalog/lifecycle/*` | `catalog.expire` | set/merge a row; `revoke: true` revokes |
| `POST /api/v1/catalog/scan/*` | `catalog.scan` | record a C2PA scan result for one asset ([c2pa](c2pa.md)) |
| `GET/POST /api/v1/injectables`, `DELETE …/:id` | `catalog.injectable.manage` | the assets/tools injected into member shells |
| `GET /api/v1/brand/profiles`, `PUT /api/v1/brand/profile` | member / `brand.switch` | list brand profiles; switch the active one |
| `GET /api/brand`, `/api/brand/logo/:variant`, `/api/brand/font/:file` | public | brand chrome only (tokens, wordmark, woff2) so the sign-in screen is on-brand |

## Catalog submit

| Route | Action | Notes |
|---|---|---|
| `POST /api/v1/catalog/submit?name=…` | `catalog.submit` | raw bytes in the body; `201` for a new asset, `200` with `duplicate: true` for identical bytes |
| `POST /api/v1/catalog/submit?assetId=inst/…&note=…` | `catalog.edit` | the same pipeline, landing as the next VERSION of an existing asset; `groups`/`type`/`tags`/`description` are refused here and belong to `…/meta` |
| `GET /api/v1/catalog/submissions` | `catalog.read` | the caller's own submissions plus the ones open on a step their groups may act on |
| `GET /api/v1/catalog/submissions/:id/bytes` | `catalog.read` | preview before publication - submitter and reviewer only |
| `PATCH /api/v1/catalog/submissions/:id` | `catalog.read` | correct a pending submission's `name`/`type`/`tags`/`description` and its org `fields`; `409` once it has settled |
| `POST /api/v1/catalog/submissions/:id/act` | member (the approvals engine gates it) | `approve` publishes, `reject` returns with the comment |

Refusals: `413 PAYLOAD_TOO_LARGE` over `policy.submit.maxBytes`, `409 QUOTA_EXCEEDED`,
`422 SCAN_REJECTED` when the pre-store hook vetoes, `502 SCAN_UNAVAILABLE` when it cannot
answer and `onError` is `reject`, `503 SUBMIT_CHAIN_MISSING` when `policy.submit.chain` names
a chain the instance does not have. The preview route answers `410 ASSET_EXPIRED` once the
published asset's lifecycle stops it, like every other surface that hands out bytes. See
[catalog](catalog.md#submitting-an-asset).

## Catalog providers

| Route | Action |
|---|---|
| `GET /api/v1/catalog/providers`, `GET …/:id`, `GET …/:id/health`, `GET …/:id/drift` | `catalog.provider.read` |
| `POST /api/v1/catalog/providers`, `PUT …/:id`, `DELETE …/:id`, `POST …/preview`, `POST …/:id/sync`, `POST …/:id/materialize`, `POST …/:id/import` (one asset) | `catalog.provider.manage` |
| `PUT/DELETE …/:id/credential`, `POST …/:id/enable`, `POST …/:id/disable`, `POST …/:id/cutover` | `catalog.provider.credential` (**owner**) |
| `POST …/:id/publish` | `catalog.provider.publish` (**owner**) |

Config-managed providers reject mutations with `409 CONFIG_MANAGED`.

## Outbound delivery

| Route | Action | Notes |
|---|---|---|
| `GET /api/v1/destinations` | authenticated; results filtered by `delivery.create` per target | safe fixed-target descriptors visible to this caller; never endpoints, bucket names, prefixes or credential refs |
| `POST /api/v1/destinations/:id/deliveries?name=…&format=…` | `delivery.create` on `destination:<id>` | verified Lolly export as the raw body; `201` after immediate delivery, or `202 awaiting-approval` when the target binds a chain |
| `POST /api/v1/jobs/:id/deliveries` | job owner + `delivery.create` on the body’s `destinationId` | deliver a completed render job’s retained output by reference; JSON `{destinationId,name,format?}` |
| `GET /api/v1/deliveries` | authenticated | caller's own delivery history remains readable after permission loss |
| `GET /api/v1/deliveries/:id` | authenticated | caller's own delivery receipt; another principal receives 404 |
| `POST /api/v1/deliveries/:id/retry` | `delivery.create` on the destination | retry failed/stalled work from its immutable staged bytes; refuses a changed destination |

Both create routes accept `Idempotency-Key`; repeating the same delivery returns its existing
record without another provider write, while reuse for different bytes/metadata returns
`409 IDEMPOTENCY_KEY_REUSED`. The raw body, or the referenced job output, must carry Lolly's
C2PA export assertion. See
[outbound delivery](delivery.md).

## Policy and governance

| Route | Action |
|---|---|
| `GET /api/v1/policy/tools` | `policy.edit` |
| `PUT /api/v1/policy/overlays/:toolId` | `policy.edit` |
| `GET /api/v1/policy/flags`, `PUT /api/v1/policy/flags/:flagId` | `policy.edit` |
| `GET /api/v1/grants` | `grant.edit` |
| `POST /api/v1/grants`, `DELETE /api/v1/grants` | `grant.edit` + owner for owner-only actions |
| `GET /api/v1/config/export` | `policy.edit` |
| `POST /api/v1/config/apply?dryRun=1&prune=1` | `policy.edit` (+ owner for owner-only grants) |
| `GET /api/v1/chains`, `PUT /api/v1/chains/:id` | member / `policy.edit` |

## People and groups

| Route | Action |
|---|---|
| `GET /api/v1/users`, `GET /api/v1/users/:id` | admin/owner role |
| `POST /api/v1/users/:id/revoke-sessions` | `grant.edit` - sign-out-everywhere: bumps the user's session epoch, every prior cookie and token fails its next request |
| `DELETE /api/v1/users/:id` | `instance.config` (**owner**) - erasure: deletes the row + de-attributes telemetry; `409` while they own unarchived projects |
| `POST /api/v1/retention/run` | `instance.config` (**owner**) - apply the stated retention policy now |
| `GET/POST /api/v1/groups`, `DELETE /api/v1/groups/:name` | `grant.edit` |
| `PUT /api/v1/users/:id/local-groups` | `grant.edit` |
| `POST /api/v1/users/:id/disabled` | `grant.edit` |

## Service tokens

| Route | Action | Notes |
|---|---|---|
| `POST /api/v1/tokens` | `token.manage` (**owner**) | mint; the secret (`lwt_…`) appears in this response and never again |
| `GET /api/v1/tokens` | `token.manage` (**owner**) | list with last-used and revocation state - never secrets |
| `DELETE /api/v1/tokens/:id` | `token.manage` (**owner**) | revoke; the very next use gets `401` |

A minted token rides `Authorization: Bearer lwt_…` and resolves to a synthetic
principal carrying the token's role (no groups) - RBAC, grants and audit see it
like any member (`user:svc_<id>` actor). It works on the **action-gated**
surface (fleet, providers, governance export/apply, audit, telemetry summary);
approvals, submit and collab refuse it - those flows mean "a person decided".
See [identity](identity.md#service-tokens).

## SCIM provisioning

Admin (cookie, owner-only) mints the bearer; the protocol half is what the IdP calls with it.
See [identity](identity.md#scim-provisioning).

| Route | Auth |
|---|---|
| `POST/GET /api/v1/scim/tokens`, `DELETE /api/v1/scim/tokens/:id` | `scim.manage` (owner) |
| `GET /scim/v2/ServiceProviderConfig` | SCIM bearer |
| `GET/POST /scim/v2/Users`, `GET/PATCH/DELETE /scim/v2/Users/:id` | SCIM bearer |
| `GET/POST /scim/v2/Groups`, `GET/PATCH/DELETE /scim/v2/Groups/:name` | SCIM bearer |

`GET /scim/v2/Users?filter=userName eq "…"` (and `externalId eq "…"`) is the existence check
an IdP runs before create. `active=false` on a User `PATCH` (or a `DELETE`) deprovisions:
disable + session-epoch bump. Group membership maps to each user's local groups.

## Approvals and inbox

| Route | Action |
|---|---|
| `GET/POST /api/v1/approvals` | member |
| `GET /api/v1/approvals/approvers` | member |
| `POST /api/v1/approvals/:id/act` | `approval.act` |
| `POST /api/v1/approvals/:id/withdraw` | member (submitter) |
| `GET /api/v1/inbox`, `POST /api/v1/inbox/:id/ack` | member |
| `GET/POST /api/v1/messages` | `message.send` |

Message targeting is groups × shell selectors × engine-version range.

## Links and rendering

| Route | Action |
|---|---|
| `POST /api/v1/links` | `link.create` (`link.create-guest` for `guest-edit`) |
| `GET /api/v1/links[?all=1]` | member (own links; `all=1` needs the admin view) |
| `POST /api/v1/links/:id/revoke` | own link, or `link.revoke` |
| `GET /l/:id?s=…[&pw=…][&name=…]` | public (the signature *is* the authorization) |
| `GET /l/:id?s=…&zip=1`, `…&asset=<id>[&dl=1]` | public - a collection link's zip-all, and one member of that set (an id it does not name is `404 NOT_IN_COLLECTION`) |
| `GET /render/<toolId>.<format>` | `export.server`, or a guest scoped to that tool |

## Projects and sessions

| Route | Action |
|---|---|
| `GET /api/v1/projects` | member (own + team by group; admins all) |
| `POST /api/v1/projects` | `project.create` |
| `PATCH /api/v1/projects/:id` | member (own/manage) - name, visibility, archive, and `ownerId` (transfer to an enabled member; audited `project.transfer`) |
| `GET/POST /api/v1/projects/:id/sessions` | member / `session.create` |
| `GET /api/v1/sessions/:id`, `GET …/revisions` | member |
| `PUT /api/v1/sessions/:id` | `session.edit` |
| `DELETE /api/v1/sessions/:id` | `session.delete` |
| `POST /api/v1/sessions/bulk` | member |
| `GET /api/v1/collab/invitees?sessionId=…&q=…` | member with read access to the session |
| `POST /api/v1/collab/invites` | `collab.edit` (= `session.edit`) |
| `GET /api/v1/collab/rooms` | `telemetry.view` - live room census for the console |
| `GET/POST /api/v1/collab/nearby` | `collab.join` - the nearby-discovery handover lane |

**Session writes are compare-and-set, never last-writer-wins.** `PUT` requires the `rev`
you read; a stale `rev` answers `409 CONFLICT` with the **full current server session** in
`current`, so the client keeps its own edit locally and rebases - nothing is silently
overwritten. `bulk` applies per-session CAS over a matched snapshot: a session someone
edited between preview and apply is **skipped, not stomped**, and reported as
`skipped: [{ sessionId, rev }]` in the response (re-run to retry). Every refused write is
audited as `session.conflict` (ids and revs only - never input values) and folded into
`GET /api/v1/stats/overview`'s `sessions.conflicts30d`.

`invitees` autocompletes over **eligible principals only** - project membership
plus `collab.join`, never the directory, and the admin/owner "sees every
project" bypass does not make someone invitable. Prefix match on display name,
capped, self excluded, no email addresses. `invites` enforces the same predicate
server-side and delivers through the inbox (`kind: "collab"`, `data.sessionId`
for the deep link); re-inviting refreshes the pending message instead of adding
a second.

### The collab socket

Live co-editing runs over `GET /ws/collab/:sessionId`, a WebSocket upgrade
carrying the same session cookie an HTTP call would. Authorization happens
**before the handshake completes**, so a refusal is a plain HTTP status on the
socket rather than a mystery disconnect: `401` unauthenticated, `404` no such
session, `403` the project is not visible to you or `collab.join` is denied,
`410` the session is in the bin, `429` too many connections or reconnects, `503`
busy or shutting down. Write access is not a refusal: a member who may read but
not edit is seated as an **observer**.

One optional field rides the upgrade URL, and a client that omits it is
unaffected:

| Param | Meaning |
|---|---|
| `ds` | the brand profile the client is rendering with |
| `dsi` | the instance base that design system came from |

A room hosted here runs under exactly one design system, the one this deployment
governs (OSS `plans/186` section 3.10). When a client names one, `dsi` must be
this instance's `baseUrl` (a trailing slash and letter case are not a
difference, and the comparison is on the origin) and, on a profile-aware pack,
`ds` must be the **active** brand profile that `GET /api/v1/brand/profiles`
reports. A mismatch is refused `403 DESIGN_SYSTEM_MISMATCH`, whose body names
the design system to switch to. On a pack with no brand profiles there is
nothing to compare a name against, so only `dsi` is checked. Sending neither
param joins as before; sending one of the two checks only that one.

## Telemetry, activity, audit, fleet, system

| Route | Action |
|---|---|
| `POST /api/v1/telemetry` | member or guest session; attribution per level/consent |
| `POST /api/v1/telemetry/consent` | member |
| `GET /api/v1/telemetry/summary` | `telemetry.view` |
| `GET /api/v1/stats/overview` | `telemetry.view` |
| `GET /api/v1/stats/series?days=N` | `telemetry.view` - day-bucketed audit-action counts (counts only), the console's per-view activity headers; `days` clamps 7–90 |
| `GET /api/v1/activity` | `audit.export` |
| `GET /api/v1/audit`, `GET /api/v1/audit/head` | `audit.export` |
| `GET /api/v1/fleet` | `fleet.view` - the version histogram, plus `engineVersion` (this deploy's vendored pin) |
| `GET /api/v1/fleet/installs` | `fleet.view` - registered installs, newest activity first |
| `PATCH /api/v1/fleet/installs/:id` | `fleet.manage` - set or clear the operator name |
| `DELETE /api/v1/fleet/installs/:id` | `fleet.manage` - forget the row (bookkeeping; the device is untouched) |
| `GET /api/v1/system/migrations` | `instance.config` (**owner**) |
| `GET /api/v1/docs`, `GET /api/v1/docs/:slug` | member - this documentation set |

## Static

| Route | Notes |
|---|---|
| `GET /admin`, `GET /admin/*` | the admin console (static; every call it makes is auth-enforced) |
| `GET /`, `GET /*` | the Lolly web shell, when `instance.shellDir` is set. Registered last, so API/console/catalog/render/link routes always win; `api`, `catalog`, `render`, `l`, `admin`, `healthz` are reserved prefixes |

## Common error codes

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | no session, or this deployment is sign-in gated |
| `FORBIDDEN` | 403 | the required action is missing |
| `OWNER_ONLY_ACTION` | 403 | an owner-only escalation was attempted |
| `GUEST_LINKS_DISABLED` | 403 | guest links are off on this deployment |
| `BAD_SIGNATURE` | 403 | link signature invalid |
| `CONFIG_MANAGED` | 409 | the target is owned by `instance.json` |
| `CONFLICT` | 409 | stale session `rev` - the body's `current` is the server session to rebase on |
| `LINK_EXPIRED` / `LINK_REVOKED` | 410 | self-explanatory |
| `INPUT_LOCKED` | 422 | a locked input was supplied by the caller |
| `INVALID_INPUT` | 400 | an automation request is missing or has malformed required fields |
| `DOCUMENT_API_ERROR` | 400 | the requested compile/inspect/diff/measure/optimise/package operation could not be performed |
| `DATA_BINDING_ERROR` | 400 | a live JSON/CSV provider binding could not resolve, parse, query or validate |
| `ROW_VALIDATION_FAILED` | 422 | a batch row does not satisfy the selected tool contract |
| `IDEMPOTENCY_KEY_REUSED` | 409 | the principal reused an idempotency key for different request bytes |
| `UNSUPPORTED_FORMAT` | 400 | a format this deployment cannot produce (org_config's `render.formats` names what it can) |
| `FORMAT_NOT_ALLOWED` | 403 | the format exists here but this tool's overlay policy excludes it |
| `RENDER_BUSY` | 503 | the render worker is at capacity - retry after `Retry-After` seconds |
| `HOOKED_TOOL_NEEDS_CHROMIUM` | 501 | hooked tool, no worker configured (org_config's `render.hookedTools` is `false`) |

## Client identification

Shells send `X-Lolly-Client` (shell, shell version, engine, platform). It feeds the fleet
histogram and message targeting; it is never trusted for authorization. The OSS shells add
an `install/<id>` token while - and only while - their person is signed in: on a request
that carries a live member session, it registers the install in the fleet registry.
Anonymous and guest traffic with the same token feeds the histogram and nothing else, and
there is no heartbeat: an install is seen exactly when its person uses the instance, and
leaving the instance client-side deletes the id.
# Automation and document API

The typed automation surface mirrors the open-source engine's document verbs:
`POST /api/v1/compile`, `/validate`, `/inspect`, `/diff`, `/measure`, `/optimize`,
`/package`, and `/render`; `GET /api/v1/schema/:toolId` publishes a tool's input
schema. JSON requests use `{toolId, inputs}` rather than URL-only merge fields.
Schema, compile, package and render all enforce the caller's `tool.use` decision
and tool-visibility overlay; a document verb cannot be used to discover a tool
hidden from that principal. Render additionally requires `export.server`.

Pass `?async=1` or `Prefer: respond-async` to receive `202 {jobId,statusUrl}`.
Poll `GET /api/v1/jobs/:id`, download a completed result from
`GET /api/v1/jobs/:id/result`, or list the caller's jobs at `GET /api/v1/jobs`.
Completed job resources include `resultSha256`, computed from the output bytes rather than blob
provider metadata; it is `null` until a result exists.
`DELETE /api/v1/jobs/:id` removes queued work or retained output, except while a delivery
retains that output (`409 JOB_OUTPUT_IN_USE`). Jobs are isolated to the member or service
principal that created them. A completed render can be delivered without a download/upload
round trip through `POST /api/v1/jobs/:id/deliveries`; the delivery shares the immutable result
blob and records the source job id. Repeating a
request with the same `Idempotency-Key` returns its existing job; reusing that
key for different request bytes returns `409 IDEMPOTENCY_KEY_REUSED`. A
`callbackUrl` is used only when it exactly matches the instance-configured
webhook endpoint; callback requests carry `x-lolly-timestamp` and a signed
`x-lolly-signature` header. Their absolute result URL carries its own 24-hour
signature, so the receiver does not need the caller's session cookie.

`POST /api/v1/batch {toolId,format,rows,keepGoing?,retries?,concurrency?,priority?}`
always creates a job and produces one ZIP. Requested concurrency is capped at
four in this process, priority at 0–9, and retries at three. Progress is exposed
as `{done,total}` and the ZIP's `manifest.json` records every row outcome. In
place of `rows`, `bind:{source,query?,as?}` reads JSON/CSV from a governed
provider; `as` may be the JSON Schema returned by the schema route, and every
row is also checked against the actual tool before enqueue. `query` is a typed,
nested equality selector: it is forwarded to the provider and enforced again
over the returned objects. CSV follows RFC 4180, including quoted commas,
escaped quotes and embedded newlines; its cell values are strings.

Provider refs are resolved during compile and before render cache identity.
Local `image://brand`, `catalog://`, and `library://` refs stay offline-first.
`cms://<provider-id>/<remote-id>` uses that enabled catalog provider's stored
credential, exposure and lifecycle; `net://<operator-allowed-origin>/<path>` is
restricted to origins present in provider configuration. Both are timeout- and
byte-bounded, content-addressed, and use immutable resize, format-conversion and
metadata-strip stages. `/inspect` and `/optimize` also accept `bytesBase64` or a
provider `source`; `/package` accepts either a compiled `document` or
`{toolId,inputs}` and can run asynchronously.

These routes use the configurable `rateLimit.automation` bucket. It is technical
admission control, not printer-rate pricing; durable per-principal quotas and
usage accounting are specified in plan 45.
