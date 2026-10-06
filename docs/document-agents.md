# Document agent invitations

Members can invite a named agent from a shared Design document. An invitation delegates the member's identity, with viewer or editor access to that document for one hour to seven days. It creates no account or project membership. An editor invitation cannot exceed the member's current permissions. Project access removal, account disablement, expiry and revocation stop access.

The server stores only the SHA-256 hash of the random connection key. The plaintext key is returned once. Keep it in the agent's private MCP configuration. The invitation list never returns it. The inviter or a project manager can revoke an invitation. HTTP DELETE on the MCP endpoint disconnects the agent's live room connection; revoking the invitation invalidates the key.

The Streamable HTTP MCP endpoint is `/api/workspace/mcp`. Each request uses `Authorization: Bearer <connection key>`. Cookies alone do not admit an agent. The endpoint validates any supplied Origin header, bounds request size and rate, and accepts MCP protocol versions 2025-03-26, 2025-06-18 and 2025-11-25. It returns JSON and does not offer an SSE stream.

`read_document` joins the same live room as human collaborators and returns its durable revision, document state and editing claims. `apply_document_ops` accepts a small batch of the existing CanvasOp operations. Supply `expectedRevision` from the read and a unique `batchId`. Repeat an identical uncertain batch with the same ID; a changed batch needs a new ID. A revision conflict requires another read. Inspect accepted and rejected IDs before claiming an edit succeeded.

Agents commit through the room's serialized durable queue. The server assigns operation origins and checks current project permissions, input locks, room limits and human editing claims inside that queue. Agent edits are attributed to the inviter. Collaborators see the agent name and inviter in the room. Idle connections leave after two minutes; keys remain usable until expiry or revocation. Connection checks run only while agent connections exist.

An invitation does not expose other projects, administrator tools or arbitrary session replacement. This server implements document collaboration; provider account credentials stay on the server.


## Admin visibility

Admins and owners with `audit.export` can open **Agents** in the control plane
(`/admin#/agents`). The Overview also shows a 14-day agent summary. Agents offers
7-, 30- and 90-day windows, the inviter, project or document scope, delegated role,
invitation expiry/status, last use and per-agent tool calls. Recent activity
separates succeeded, rejected and partially accepted calls, including durable
operation counts. Document room presence is a snapshot of the current host;
project-only MCP requests do not occupy a document room. Hosts without a room
bridge report presence as unavailable.

`GET /api/v1/agents/activity?days=30` uses the audit permission, returns private
uncacheable metadata and excludes credentials, tool arguments and document
contents. It reads at most 10,001 agent audit events for the requested 1–90 days;
reports use the newest 10,000, inspect at most 500 agents and show 100 recent
events. Both coverage limits are explicit in the response and UI. Shorten the
period or use the audit log when either limit is reached. The view refreshes
while visible every 15 seconds, preserves a table being searched or focused,
and stops refreshing after navigation or permission loss.

Agents remain distinct from human users in the Activity timeline. Each delegated
action names the agent and its inviter; filtering a person or group also includes
work delegated by that person. An invitation or revocation remains attributed to
the human who performed it. Legacy agent room events are recognised without
rewriting the audit chain.

## Reported agent client and model

The Agents inventory shows the last client report in the selected period, with
recognizable marks for Claude, Codex, Gemini, Qwen, GLM and DeepSeek. Unknown
clients keep their supplied application name; older or unnamed connections show
**Not reported**. Search and CSV export include the client, version and any
explicitly reported model. Activity badges belong only to requests carrying that
report; older tool calls are not retrospectively labelled.

Lolly reads the standard MCP `initialize.params.clientInfo` fields `name`, `title`
and `version`. A client can also send request-local implementation metadata in
`params._meta["io.modelcontextprotocol/clientInfo"]`. To explicitly report the
model it is currently using, send the optional Lolly extension:

```json
{
  "_meta": {
    "tools.lolly/agent": { "model": "your-exact-model-id", "provider": "provider-name" }
  }
}
```

This is display-only, **client-reported** information, not verified identity or
an access control signal. The [MCP initialization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
identifies the client application, not necessarily its underlying model.
For example, Cursor can report a Claude model while remaining a Cursor client.
A plain Claude Code or Codex client name does not imply any exact model.

Only bounded scalar display fields enter the agent audit metadata. Arbitrary
client icons, website URLs and other implementation fields are discarded. A
reconnect without client information clears the prior inventory report. There
is no shared “last client” cache attached to a reusable invitation key, so tool
calls from another client do not inherit an earlier client's identity.
