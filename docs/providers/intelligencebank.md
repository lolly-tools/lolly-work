# IntelligenceBank (kind: `intelligencebank`)

Federate an IntelligenceBank DAM **read-only**, with the exit motion (federate → materialize
→ cutover). Targets the current **v3 Graph API** only. IntelligenceBank is governance-rich —
native expiry/review dates and workflow states — so it brings availability and approval
without custom-field mapping.

## What you need from IntelligenceBank

- **Your platform URL** — your tenant's IntelligenceBank instance, e.g.
  `https://acme.intelligencebank.com` (the `platformUrl` option).
- **An API credential** for that tenant (an API key with read access to the resources you want
  to federate). The driver performs IntelligenceBank's documented login handshake with it and
  discovers the per-tenant v3 API URL automatically — you never configure that URL.
- Note which **workflow states** count as "approved/released" in your tenant (they're
  tenant-specific), so you can set `approvedStates`.

## Credential shape

A single sealed string — the tenant API key used for the login handshake:

```bash
lw providers credential acme-ib     # prompts; never argv, never shell history
```

## instance.json / `lw providers add`

```json
{
  "id": "acme-ib",
  "kind": "intelligencebank",
  "label": "Acme IntelligenceBank",
  "options": { "platformUrl": "https://acme.intelligencebank.com", "approvedStates": ["Approved", "Published"] },
  "exposure": { "groups": ["brand"], "requireApproved": true, "tier": "reference" }
}
```

- `options.platformUrl` (required) — your tenant URL (the login endpoint). The v3 API base is
  discovered at login, not configured.
- `options.approvedStates` — the workflow states that map to **approved** (§9 approval is a
  workflow state, not a boolean); omit it and approval is unfiltered.
- `options.folderId` scopes federation to one folder.
- Native **expiry/review dates** import as an
  [availability window](../catalog.md#imported-availability-windows) — no
  `mapping.availabilityFields` needed.

## Verify

```bash
lw providers preview --kind intelligencebank --options '{"platformUrl":"https://acme.intelligencebank.com"}'
lw providers health acme-ib
```

`login <status>` errors mean the platform URL or API key is wrong. The exact v3 field/endpoint
names are confirmed against your live tenant on first sync (the driver carries live-verify
notes until then).

## Notes / limits

- **v3 Graph API only** — no work against the deprecated v2 resource endpoints; the one
  v2-named call used is the login handshake, which IntelligenceBank defines as the auth
  mechanism *for* v3.
- The discovered per-tenant `apiV3url` and all downloads are host-pinned to the
  `intelligencebank.com` family (no open proxy); a custom-domain tenant needs that host added
  at ship time.
- Supports the **exit** (materialize → cutover) — the off-boarding path.
- Does **not** accept published exports.

See also: [catalog](../catalog.md) · [permissions](../permissions.md).
