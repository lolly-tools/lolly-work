# Acquia DAM / Widen (kind: `acquia-dam`)

Federate an Acquia DAM (Widen) collective **read-only**, with the exit motion (federate →
materialize → cutover) for off-boarding. Widen is the governance-rich enterprise DAM, so it
brings **native** availability and approval - no custom-field mapping needed.

## What you need from Widen

- **A Widen API token** (personal access token) with read access to the assets/categories you
  want to federate. In Widen: *Account → API* (or your admin issues one). It is a bearer token
 - treat it as a secret.
- Optionally, a **search query** to scope what federates (else the whole collective).
- No app registration or OAuth flow - the token is all-or-nothing, so scope what federates with
  lolly-side **exposure**, not the token.

## Credential shape

A single bearer token string - the Widen API token. Store it write-only:

```bash
lw providers credential acme-widen     # prompts; never argv, never shell history
```

## instance.json / `lw providers add`

```json
{
  "id": "acme-widen",
  "kind": "acquia-dam",
  "label": "Acme Widen",
  "options": { "query": "ft:(png OR svg)", "approvedStatuses": ["active"] },
  "exposure": { "groups": ["brand"], "requireApproved": true, "tier": "reference" }
}
```

- `options.query` scopes federation with a Widen search query; `options.approvedStatuses`
  (default `["active"]`) is the set of asset statuses that count as **approved**
  (§9 approval-is-not-a-boolean).
- Widen's **`release_date`** and **`expiration_date`** import natively as an
  [availability window](../catalog.md#imported-availability-windows) - no
  `mapping.availabilityFields` needed (unlike Image Relay).
- `exposure.requireApproved: true` federates only assets whose status is in
  `approvedStatuses`. Categories fold into sections for `includeSections` scoping.

## Verify

```bash
lw providers preview --kind acquia-dam --options '{}'
lw providers health acme-widen
```

`401`/`403` → the token is wrong or lacks access; an empty sample under `requireApproved`
means nothing matches `approvedStatuses`.

## Notes / limits

- Download/embed URLs are signed + short-lived (`expiringUrls`) - fetched per request,
  streamed; host-pinned to `widencollective.com` / `widencdn.net` (no open proxy).
- Supports the **exit** (materialize → cutover) - the off-boarding path.
- Does **not** accept published exports.

See also: [catalog](../catalog.md) · [permissions](../permissions.md).
