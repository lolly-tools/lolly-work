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

## Auth

| Route | Action | Notes |
|---|---|---|
| `GET /api/auth/config` | public | what the sign-in screen needs (mode, IdP display name) |
| `GET /api/auth/login` | public | starts OIDC (PKCE); `404 NO_IDP` without an issuer |
| `GET /api/auth/callback` | public | verifies the `id_token`, mints `lw_session` |
| `GET /api/auth/dev?email=…` | public | dev provider only; `404` when `dev.enabled` is false |
| `GET /api/auth/session` | member/guest | the current principal |
| `POST /api/auth/logout` | any | clears both cookies |

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
| `GET /api/v1/catalog/lifecycle` | `catalog.expire` | all lifecycle rows |
| `PUT /api/v1/catalog/lifecycle/*` | `catalog.expire` | set/merge a row; `revoke: true` revokes |
| `GET /api/brand`, `/api/brand/logo/:variant`, `/api/brand/font/:file` | public | brand chrome only (tokens, wordmark, woff2) so the sign-in screen is on-brand |

## Catalog providers

| Route | Action |
|---|---|
| `GET /api/v1/catalog/providers`, `GET …/:id`, `GET …/:id/health` | `catalog.provider.read` |
| `POST /api/v1/catalog/providers`, `PUT …/:id`, `DELETE …/:id`, `POST …/preview`, `POST …/:id/sync` | `catalog.provider.manage` |
| `PUT/DELETE …/:id/credential`, `POST …/:id/enable`, `POST …/:id/disable` | `catalog.provider.credential` (**owner**) |

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
| `GET /api/v1/fleet` | `fleet.view` |
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
registry and message targeting; it is never trusted for authorization.
