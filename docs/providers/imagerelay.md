# Image Relay (kind: `imagerelay`)

Federate an Image Relay DAM **read-only**. In this deployment Image Relay's role is
**off-boarding** - federate → materialize → cutover into your own store (plans/27 §10) - 
not long-term residence. OAuth2 (BYOT) - see the
[shared OAuth onboarding](README.md#oauth-kinds-dropbox-gdrive-o365).

## What you need from Image Relay

- **An OAuth2 app** you register in Image Relay, granting **read** access to the files/folders
  you want to federate. BYOT: the client id/secret are yours; the refresh token is captured
  by `lw providers auth`.
- Optionally, **a folder id** to scope federation to one folder (with `recursive` for its
  descendants).
- If you model asset expiry in Image Relay, note **which custom-metadata field** holds the
  date - Image Relay has no native availability field, so you map it (below).

## Credential shape

The OAuth JSON blob - captured, not typed:

```json
{ "clientId": "…", "clientSecret": "…", "refreshToken": "…" }
```

```bash
lw providers auth acme-imagerelay
```

## instance.json / `lw providers add`

```json
{
  "id": "acme-imagerelay",
  "kind": "imagerelay",
  "label": "Acme Image Relay",
  "options": { "folderId": "1234", "recursive": true },
  "mapping": { "availabilityFields": { "until": "Expiry Date" } },
  "exposure": { "groups": ["marketing"] }
}
```

- `options.folderId` / `options.recursive` scope federation; `options.baseUrl`/`tokenUrl`
  override the defaults.
- **`mapping.availabilityFields`** is how expiry gets imported: name the custom-metadata field
  that holds the date (here `"Expiry Date"` → an
  [availability window](../catalog.md#imported-availability-windows) `availableUntil`). Omit
  it and the manual `catalog.expire` arm is the whole story.

## Verify

```bash
lw providers auth acme-imagerelay
lw providers health acme-imagerelay
```

## Notes / limits

- **Off-boarding is the point**: federate → `materialize` → `cutover`
  ([the exit](../catalog.md#the-exit--materialize-a-source-into-your-own-store)).
- Download links are signed + short-lived (`expiringUrls`) - fetched per request, streamed,
  host-pinned to `imagerelay.com`. The driver sends a mandatory `User-Agent` and self-caps at
  **5 requests/second** (Image Relay etiquette).
- A file Image Relay reports as **deleted** is dropped from federation (a positive signal, not
  an inference).
- Does **not** accept published exports.

See also: [OAuth onboarding](README.md#oauth-kinds-dropbox-gdrive-o365) · [catalog](../catalog.md) · [permissions](../permissions.md).
