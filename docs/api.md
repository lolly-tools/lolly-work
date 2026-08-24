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
| `GET /connect/pack.lolly` | open: public · else member | the hosted signed instance pack; `404` when none is hosted |
| `GET /api/v1/instance-pack` | `fleet.view` | the hosted pack's metadata (name, version, signed, checksum), or null |
| `PUT /api/v1/instance-pack` | `instance.config` (**owner**) | host a pack cut by the OSS builder; refused unless its instance base is this deployment |
| `DELETE /api/v1/instance-pack` | `instance.config` (**owner**) | stop hosting |

The manifest is what a downloaded app learns about this deployment before
anyone signs in: `{ name, accessMode, provider, providerName, loginPath,
engineVersion, capabilities, connect? }`. `engineVersion` is the vendored
engine pin this deploy serves tools against; `capabilities` names the surfaces
the server ships (`catalog`, `collab`, `submit`, `scim`); `connect.packUrl`
appears exactly while a pack is hosted. It carries no secrets and no user
data, and shares the auth rate-limit bucket. The pack itself is never built
here - the OSS repo's `build-instance-pack.ts` owns the signed format, and
this instance is where the finished pack publishes to. See "Connecting apps to
this instance" in [operations](operations.md) for the connect story.

## Auth

| Route | Action | Notes |
|---|---|---|
| `GET /api/auth/config` | public | what the sign-in screen needs (mode, IdP display name) |
| `GET /api/auth/login` | public | starts OIDC (PKCE); `404 NO_IDP` without an issuer |
| `GET /api/auth/callback` | public | verifies the `id_token`, mints `lw_session` |
| `GET /api/auth/dev?email=…` | public | dev provider only; `404` when `dev.enabled` is false |
| `GET /api/auth/session` | member/guest | the current principal |
| `POST /api/auth/logout` | any | clears both cookies |
| `POST /api/v1/auth/device` | public | start device sign-in: `{deviceCode, userCode, verificationUri, interval, expiresIn}`; `501` on serverless |
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
| `POST /api/v1/catalog/providers`, `PUT …/:id`, `DELETE …/:id`, `POST …/preview`, `POST …/:id/sync`, `POST …/:id/materialize` | `catalog.provider.manage` |
| `PUT/DELETE …/:id/credential`, `POST …/:id/enable`, `POST …/:id/disable`, `POST …/:id/cutover` | `catalog.provider.credential` (**owner**) |
| `POST …/:id/publish` | `catalog.provider.publish` (**owner**) |

Config-managed providers reject mutations with `409 CONFIG_MANAGED`.

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
| `GET /api/v1/users`, `GET /api/v1/users/:id` | member (filtered by role) |
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
the member-workflow routes (approvals, submit, collab) refuse it - those flows
mean "a person decided", and a token deciding would launder authorship. See
[identity](identity.md#service-tokens).

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
| `PATCH /api/v1/projects/:id` | member (own/manage) |
| `GET/POST /api/v1/projects/:id/sessions` | member / `session.create` |
| `GET /api/v1/sessions/:id`, `GET …/revisions` | member |
| `PUT /api/v1/sessions/:id` | `session.edit` |
| `DELETE /api/v1/sessions/:id` | `session.delete` |
| `POST /api/v1/sessions/bulk` | member |
| `GET /api/v1/collab/invitees?sessionId=…&q=…` | member with read access to the session |
| `POST /api/v1/collab/invites` | `collab.edit` (= `session.edit`) |

**Session writes are compare-and-set, never last-writer-wins.** `PUT` requires the `rev`
you read; a stale `rev` answers `409 CONFLICT` with the **full current server session** in
`current`, so the client keeps its own edit locally and rebases - nothing is silently
overwritten. `bulk` applies per-session CAS over a matched snapshot: a session someone
edited between preview and apply is **skipped, not stomped**, and reported as
`skipped: [{ sessionId, rev }]` in the response (re-run to retry). Every refused write is
audited as `session.conflict` (ids and revs only - never input values) and folded into
`GET /api/v1/stats/overview`'s `sessions.conflicts30d`.

`invitees` is an autocomplete over **eligible principals only** - the people a
live room would already admit for that session, never the directory. Eligibility
is project **membership** (the project's owner, or a member of one of its
visibility groups) plus `collab.join`: the admin/owner "sees every project"
bypass deliberately does *not* make someone invitable, or any member could mint
a project and read back a list of the instance's admins. An admin who is in the
project's group is offered like anyone else. Prefix match on display name,
capped, self excluded, no email addresses. `invites` validates the **same**
predicate server-side - so a 201-vs-400 answer can never reveal what the search
hides - and delivers through the inbox (`kind: "collab"`, targeted at the one
invitee, `data.sessionId` for the client's deep link). Re-inviting the same
person to the same session refreshes the pending message instead of adding a
second, and re-raises it if they had already dismissed it.

## Telemetry, activity, audit, fleet, system

| Route | Action |
|---|---|
| `POST /api/v1/telemetry` | member or anonymous per level |
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
