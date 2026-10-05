# Document agent invitations

Members can invite a named agent from a shared Design document. An invitation delegates the member's identity, with viewer or editor access to that document for one hour to seven days. It creates no account or project membership. An editor invitation cannot exceed the member's current permissions. Project access removal, account disablement, expiry and revocation stop access.

The server stores only the SHA-256 hash of the random connection key. The plaintext key is returned once. Keep it in the agent's private MCP configuration. The invitation list never returns it. The inviter or a project manager can revoke an invitation. HTTP DELETE on the MCP endpoint disconnects the agent's live room connection; revoking the invitation invalidates the key.

The Streamable HTTP MCP endpoint is `/api/workspace/mcp`. Each request uses `Authorization: Bearer <connection key>`. Cookies alone do not admit an agent. The endpoint validates any supplied Origin header, bounds request size and rate, and accepts MCP protocol versions 2025-03-26, 2025-06-18 and 2025-11-25. It returns JSON and does not offer an SSE stream.

`read_document` joins the same live room as human collaborators and returns its durable revision, document state and editing claims. `apply_document_ops` accepts a small batch of the existing CanvasOp operations. Supply `expectedRevision` from the read and a unique `batchId`. Repeat an identical uncertain batch with the same ID; a changed batch needs a new ID. A revision conflict requires another read. Inspect accepted and rejected IDs before claiming an edit succeeded.

Agents commit through the room's serialized durable queue. The server assigns operation origins and checks current project permissions, input locks, room limits and human editing claims inside that queue. Agent edits are attributed to the inviter. Collaborators see the agent name and inviter in the room. Idle connections leave after two minutes; keys remain usable until expiry or revocation. Connection checks run only while agent connections exist.

An invitation does not expose other projects, administrator tools or arbitrary session replacement. This server implements document collaboration; provider account credentials stay on the server.
