# Document agent invitations

Members can invite a named agent from a shared Design document. An invitation delegates the member's identity, with viewer or editor access to that document for one hour to seven days. It creates no account or project membership. An editor invitation cannot exceed the member's current permissions. Project access removal, account disablement, expiry and revocation stop access.

The server stores only the SHA-256 hash of the random connection key. The plaintext key is returned once. Keep it in the agent's private MCP configuration. The invitation list never returns it. The inviter or a project manager can revoke an invitation. HTTP DELETE on the MCP endpoint disconnects the agent's live room connection; revoking the invitation invalidates the key.

The Streamable HTTP MCP endpoint is `/api/workspace/mcp`. Each request uses `Authorization: Bearer <connection key>`. Cookies alone do not admit an agent. The endpoint validates any supplied Origin header, bounds request size and rate, and accepts MCP protocol versions 2025-03-26, 2025-06-18 and 2025-11-25. It returns JSON and does not offer an SSE stream.

`read_document` joins the same live room as human collaborators and returns its durable revision, document state and editing claims. `apply_document_ops` accepts a small batch of the existing CanvasOp operations. Supply `expectedRevision` from the read and a unique `batchId`. Repeat an identical uncertain batch with the same ID; a changed batch needs a new ID. A revision conflict requires another read. Inspect accepted and rejected IDs before claiming an edit succeeded.

Agents commit through the room's serialized durable queue. The server assigns operation origins and checks current project permissions, input locks, room limits and human editing claims inside that queue. Agent edits have their own `agent:<id>` revision actor, while the inviter remains the accountable user for permissions and session ownership. Collaborators see the agent name and inviter in the room. Idle connections leave after two minutes; keys remain usable until expiry or revocation. Connection checks run only while agent connections exist.

An invitation does not expose other projects, administrator tools or arbitrary session replacement. Provider account credentials stay on the server.


## Project agent invitations

Open a shared project in Lolly and choose Agents to invite a named agent across that project and all its subfolders. Viewer invitations browse sessions and verified asset bytes. Editor invitations can also create sessions, edit shared Design documents, upload files and organize outputs in folders. Each invitation acts under its inviter's current account, project access and action permissions. It cannot change membership or reach another project.

The connection key uses the same MCP endpoint and one-time display as document invitations. Lists show the inviter, expiry and whether any document connection is live. The inviter or a project manager can revoke the key and close all its document connections. Expiry, account disablement and lost project access stop subsequent requests. An archived project permits reads only. A person can hold at most 16 active document and project invitations combined.

Start with `read_project`. Sessions and ready assets are paged with `offset` and `limit` (default 50, maximum 100). Folders include their item references. `unfinishedUploads` includes only the inviter's active uploads within this project, so an agent can recover a reservation after an uncertain response. `fileLimits` reports the existing workspace upload allowance. Asset list entries include `assetId` and `partCount`.

Use `create_session` with a name, tool ID, initial inputs and a unique `requestId`. Keep the same arguments when retrying. Creation and its receipt commit together; a retry returns the original session ID without replacing later edits. Changing arguments with that ID is refused. Each invitation can create at most 1000 sessions. `read_session` returns the saved state. For Design, supply `sessionId` to `read_document` and `apply_document_ops`; the same live room, locks, claims and durable receipts apply.

Use `create_folder` and `move_project_item` to organize sessions and finished files. A null `folderId` returns an item to the project root. These tools cannot rename, delete or move another project's contents. Folder creation has no retry receipt: read the project before repeating an uncertain creation.

Files use the existing project-file service and require durable storage with project files enabled. `begin_asset_upload` declares the file metadata, total checksum and each part's size and SHA-256 checksum. Upload each part with `upload_asset_part` using standard base64, at most 1 MiB decoded. `finish_asset_upload` verifies all bytes and returns the asset ID. The uploader alone can complete an upload. Preserve the reservation's file ID; do not repeat an uncertain reservation before reading `unfinishedUploads`. `read_asset_part` returns verified bytes for a ready file and applies a bounded daily allowance per inviter. Upload quotas, pending limits, expiry and folder rules are the same as for people.

Project creation and file tools work on hosts without a live collaboration gateway. Shared Design editing requires the gateway. Existing document invitations keep their original scope and do not gain project tools. Apply migration `0050_project_agents.sql` before serving the new project routes.

## Activity attribution

The audit trail records invitation and revocation by the member, agent connections and disconnections, and every authenticated tool call, including reads, refused calls and partially accepted edit batches. Agent events carry `agentId`, `agentLabel`, `invitedBy` (`user:<id>`), `actingFor`, and the project or document scope from the server’s invitation record. Tool-call events add the tool name, outcome and operation counts when available; credentials and document arguments are not copied into those events. Project operations routed through REST preserve the same agent attribution.

The console activity timeline names the agent and links its inviter to People. Agents can be filtered individually; filtering by a person or group also includes their invited agents. Older agent join, leave and project-write events that already identify the inviter are displayed as agent activity. Where the inviter is unknown, the timeline leaves that attribution absent.

This records the user who created the workspace invitation. It cannot identify which local process launched an agent or who later used a forwarded connection key.
