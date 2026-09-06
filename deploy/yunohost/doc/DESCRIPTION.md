Lolly Work is the governed edition of [Lolly](https://lolly.tools), for a team or an organisation: one brand, the same on-device tools, and a control plane that decides who may use which tool with which inputs, who approves what, and what gets recorded.

- **Your people, your accounts.** Members sign in with their YunoHost account. Roles (owner, admin, approver, author) are YunoHost permissions of this app, and your YunoHost groups are the groups Lolly Work targets.
- **Governed, not locked down.** Per-group tool overlays lock, pre-fill or hide inputs; approval chains with Content Credentials (C2PA) assertions; time-limited guest links for an agency or a contractor.
- **Renders by URL.** Every tool is a plain `GET` that returns an on-brand SVG, PNG or PDF, for scripts, agents and the `lw` CLI, and an MCP surface for AI assistants.
- **Everything audited.** Sign-ins, policy changes, renders, approvals and deliveries land in an append-only audit log the console shows and a SIEM can pull.

This package installs a ready-to-use governed instance on a domain of your own: the control plane, its PostgreSQL database, and the Lolly web app served behind it with a neutral starter brand and the full community tool set. Replace the brand with yours from the console.
