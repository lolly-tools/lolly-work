# Data inventory and account erasure

This inventory describes the local source reviewed on 2026-09-11. The actual SUSE
database, storage regions, receivers, backup service and retention schedule need
confirmation from the deployed environment and service owner. It is an input to
the processing record and rights workflow, not a completed privacy assessment.

| Store / source | Data and purpose | Lifecycle route and limits |
|---|---|---|
| `users`, directory/SCIM and local group membership | Subject/email/name/title, groups, roles, consent and access state | IdP/SCIM is authoritative for managed identity; disable/revoke first. Account erasure removes the local identity row only when references permit. Directory access must also be removed to prevent re-provisioning. |
| `grants`, API/SCIM tokens, device sign-in codes | Authorization principals, credential digests, short-lived sign-in payloads | Revoke/rotate through the identity/token procedures. Review principal references and directory copies separately. Never include live tokens in an access report. |
| `projects`, `sessions`, `session_revisions`, `collab_room_snapshots` | Shared work, arbitrary inputs and metadata, authorship and collaboration history | Transfer business ownership where appropriate. Archiving or session tombstoning retains records and references; it is not erasure. Review shared rights, history and holds before deletion. |
| `project_files` and their parts (`project-file/<id>/<n>` in the blob store) | Files members upload into a team project (often images, possibly personal content and embedded metadata), their names, declared digests, the shell's asset description (kind, format, size in pixels and name) and the uploader | A finished file stays until its uploader or a project manager deletes it; deleting removes the parts, then the row. An unfinished upload expires 15 minutes after its last accepted part, and at the latest after `policy.projectFiles.uploadTtlHours` (24 by default). Once it is an hour past expiry it is removed, parts first, at the next upload or retention run, and by the long-lived server's sweep at boot and daily. A finished file blocks account erasure of its uploader; unfinished uploads are removed by the erasure. Copies already downloaded to members' devices stay there. |
| `canvas_comment_reads`, `canvas_comment_read_floors` (plan 76 milestone 4) | Per person: when they last read each comment thread, and when they first listed a session's comments (older messages count as read). Shown to nobody else | Deleted with the account, the thread or the session row. Never blocks account erasure. |
| `comment_notices` | One inbox notice per person per thread: the ids of the person, thread, session, project, the person who caused the newest event and that message, a kind (mention or reply), a count and the time of the newest event. No comment text and no names: the inbox builds those when it is read | Deleted when the person dismisses it or reads the thread, and when the inbox finds the session deleted or the project out of the person's reach. One hidden by a grant or a policy is kept until it is 30 days old. Notices older than 30 days are removed the next time the person's inbox is read (Lolly checks it once a minute while it is open) or a notice is written for them, and every notice written also removes all but the person's newest 200. Deleted with the account, the thread, the session or the project row. Erasing an account also deletes the notices it caused in other people's inboxes. Never blocks erasure. |
| `comment_mention_sends` | Who was told about a mention in which message (thread, message, person, time), so an edit never notifies anyone twice | Removed again at once when the notice it stood for was not written (over a limit, or a failure), so a later edit can still tell the person. Deleted with the thread and with the person's account. The mention itself is part of the shared thread: a message stores each mentioned person's id and name, as it stores its author's, and erasing an account does not change shared threads. |
| Instance assets, versions, metadata, collections, providers and lifecycle records | Uploaded media, possibly personal content and embedded metadata; publication/approval state | Catalog lifecycle and version retention apply. A hold protects retained assets from version pruning. Neither account removal nor version trimming is a complete content-erasure workflow. |
| `instance_blobs` or configured S3-compatible storage | Asset, render and other stored bytes | Confirm the active blob driver, region, versioning and provider retention. A database-only recovery is insufficient for S3 deployments. Review old object versions and orphaned data. |
| `links`, `approvals`, messages and acknowledgements | Shared targets, review titles/state, communications and identity references | Revoke access and resolve retained records under their approved lifecycle. These can prevent identity-row deletion. External recipients may retain copies. |
| Renders, batches, automation jobs and deliveries | Queries, inputs, outputs, manifests, idempotency/execution records and destination receipts | Review job/output retention, business purpose, blobs and external destinations. Account erasure does not sweep these records. |
| `telemetry_events`, rollups | Optional usage events, whitelisted attributes and optional attribution | First internal profile is off. Disabling collection does not delete old data. Configured telemetry retention trims events; account erasure removes their user-id attribution, not their event payload. |
| Audit log/anchor, SIEM receiver and infrastructure logs | Security/admin activity, actors, subjects, metadata, times, chain evidence and possibly network identifiers | Preserve chain integrity and approved retention/holds. Opaque actor IDs can remain linkable through other records. Off-box copies follow the receiver's approved lifecycle. |
| Fleet clients/installs | Versions/platform, install identifiers, operator labels and last-seen account reference | Inspect and forget installs where appropriate; optional analytics being off does not mean this registry or security logging is off. |
| Browser IndexedDB, Cache Storage, local preferences | Profile/state, uploads and versions, previews, derived media, model files, exports, packs, queued file operations and local identity | Device profile has export and storage-removal controls. Device data, sync history and downloads require their own scope review; server erasure and AI disablement cannot remotely erase every copy. |
| Native shells, local exports, downloads, external delivery recipients | Independent local work and copies outside the service | Confirm whether these clients/flows are allowed in the initial service. Handle through approved endpoint and recipient procedures. |
| Optional CA and MCP services | Enrollment/identity claims, certificates, OAuth state and MCP private file handles | Confirm which services are in scope and their configured stores. MCP file handles use a one-hour access TTL with cleanup on subsequent operations or shutdown; that is not a guarantee of physical deletion at the exact expiry time. Review temporary files, credentials, issued certificates, logs and receivers separately from Work. |
| Backups, snapshots, restore destinations and exported evidence | Recoverable copies of the preceding stores | Agree access, location, retention, holds and restoration restrictions. Record completed erasures outside the restored dataset and reapply them before a recovered service accepts traffic. |

Source anchors: `migrations/0001_init.sql` through
`migrations/0034_audit_mac_and_append_guard.sql`, `migrations/0041_project_files.sql`,
`migrations/0051_canvas_comment_reads.sql`, `migrations/0052_comment_notices.sql`,
`server/src/comments/notices.ts`, `server/src/inbox/comment-notices.ts`,
`server/src/projects/files.ts`, `server/src/store/types.ts`,
`server/src/store/postgres.ts`, the blob/render/delivery modules, and the matching
Lolly shell's `src/bridge/db.ts` and `src/lib/offline-manager.ts`.

## Read-only preview

An owner, or an explicitly authorized `instance.config` principal, can run:

```sh
lw users erase-preview USER_ID --json
```

This calls `GET /api/v1/users/:id/erasure-preview`. It returns counts for projects
(including archived ones), sessions (including tombstones), links (including
expired/revoked ones), approvals, message acknowledgements and finished project files
(`projectFiles`), plus attributed telemetry. It contains no session inputs, messages, prompts, media or credentials.
Comment read state, comment notices and mention sends are not counted: they never block
the removal.
It does not change the account or approve erasure. The response identifies its
scope as `account-identity-and-telemetry-attribution` and explicitly marks
`completePersonalDataErasure=false`.

The preview reflects one read; a concurrent reference may still block a later
deletion. The database enforces that block when deletion is attempted.

## Account removal and rights requests

`lw users erase USER_ID` removes the identity row and de-attributes telemetry in
one database transaction. A reference or a failed telemetry update rolls back the
whole operation. Shared content is never cascaded away to make removal succeed.
The account's unfinished project-file uploads are removed (parts, then rows)
before the identity row goes; its finished project files block the removal like
its sessions do. Its comment read state, the comment notices it received and its
mention sends go with the identity row, and the notices it caused in other people's
inboxes are deleted in the same transaction. The memory store enforces the same reference rules as PostgreSQL. An archived
project still references its owner: transfer the owner or resolve the record's
approved lifecycle; archiving alone does not unblock erasure.

A rights request needs a case record before changing data: verify the requester
and scope, identify sources/recipients, distinguish personal content from shared
business records, assess applicable holds and retention, and obtain the necessary
Privacy decision. Retrieve only the in-scope records for review/redaction and
secure delivery. Use the existing correction, ownership-transfer, access-revocation
and account operations only where they fulfil the approved request.

The current product does not automate a complete subject export, content-wide
erasure, subject-wide legal hold or restore suppression. Define and approve the
manual procedure for the initial data scope, or implement the required additional
controls before permitting that scope. Do not treat a successful account-removal
response as completion of the case. Record remaining exceptions, external recipient
actions and backup handling, then test recovery without resurrecting erased data
before closing the request.

Apart from removing expired unfinished project-file uploads, no new retention
durations or automatic content deletion were introduced. The
service owner and Privacy must approve the schedule, processing record, assessment
outcomes and the treatment of employee data.
