# Google Drive (kind: `gdrive`)

Federate a Google Drive folder as a **read-only** catalog source. OAuth2 (BYOT) - see the
[shared OAuth onboarding](README.md#kinds-with-a-registered-consent-flow-dropbox-gdrive-o365) for the app-registration
and consent flow.

## What you need from Google

- **A Google Cloud OAuth client** you register (APIs & Services → Credentials), with the
  **`https://www.googleapis.com/auth/drive.readonly`** scope and offline access (refresh
  token). Enable the Drive API on the project.
- **The folder id** - the trailing segment of the folder's Drive URL.
- BYOT: the client id/secret are yours; the refresh token is captured by `lw providers auth`.

## Credential shape

The OAuth JSON blob - captured, not typed:

```json
{ "clientId": "…", "clientSecret": "…", "refreshToken": "…" }
```

```bash
lw providers auth acme-gdrive
```

## instance.json / `lw providers add`

```json
{
  "id": "acme-gdrive",
  "kind": "gdrive",
  "label": "Acme Google Drive",
  "options": { "folderId": "1AbCdEfGhIjKlMnOpQrStUvWxYz" },
  "exposure": { "groups": ["design"] }
}
```

- `options.folderId` (required) - the federated folder's id from its Drive URL.

## Verify

```bash
lw providers auth acme-gdrive
lw providers health acme-gdrive
```

## Notes / limits

- Download URLs are short-lived (`expiringUrls`) - fetched per request, streamed,
  host-pinned. Supports server-side search.
- Supports the **exit** (materialize → cutover). Does **not** accept published exports.

See also: [OAuth onboarding](README.md#kinds-with-a-registered-consent-flow-dropbox-gdrive-o365) · [catalog](../catalog.md) · [permissions](../permissions.md).
