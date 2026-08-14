# Provider onboarding guides

Per-platform setup for each catalog **provider** kind — written for the owner of the source
platform. Each guide follows the same skeleton: *what you need from the platform* → *the
credential shape* → *a copy-pasteable `instance.json` example* → *verify* → *notes/limits*.

The lolly side of providers (exposure, lifecycle, the exit, publish-out) lives in
[catalog.md](../catalog.md); who may do what is in [permissions.md](../permissions.md).

| Kind | Auth | Guide |
|---|---|---|
| `brandfolder` | bearer API key | [brandfolder.md](brandfolder.md) |
| `s3` | `key:secret` (SigV4) | [s3.md](s3.md) |
| `optimizely-cmp` | OAuth2 (federate-in **and** publish-out) | [optimizely-cmp.md](optimizely-cmp.md) |
| `git` | token (or public) | [git.md](git.md) |
| `dropbox` | OAuth2 (BYOT) | [dropbox.md](dropbox.md) |
| `gdrive` | OAuth2 (BYOT) | [gdrive.md](gdrive.md) |
| `o365` | OAuth2 (BYOT) | [o365.md](o365.md) |
| `imagerelay` | OAuth2 (BYOT); off-boarding source | [imagerelay.md](imagerelay.md) |
| `acquia-dam` | bearer token (Widen v2); native availability | [acquia-dam.md](acquia-dam.md) |

`mock` is a test/demo driver and has no onboarding guide.

Universal rules across every kind: credentials are **write-only** (sealed at rest, only a
fingerprint is ever returned), providers are **read-only** federation (deleting one never
touches remote content), fetches are **host-pinned** (never an open proxy), and exposure —
not the platform credential — decides what federates. Bring your own tokens/apps; none ship
in this repo.

## OAuth kinds (dropbox, gdrive, o365)

The OAuth kinds share one BYOT onboarding. You register **your own** app on the platform —
no client ids ship here — then capture a refresh token once:

```bash
lw providers add acme-x --kind <dropbox|gdrive|o365> --label "…" --options '{…}'
lw providers auth acme-x        # prompts for client id/secret, runs a loopback PKCE consent
lw providers enable acme-x      # owner-only
```

`lw providers auth`:

1. Prompts for **your** app's client id and (unless it's a public/PKCE-only app) client
   secret — never argv, never shell history.
2. Runs a **PKCE loopback** consent: opens the platform's consent screen, receives the code
   on `http://127.0.0.1:<port>`, exchanges it for a **refresh token**.
3. Stores `{clientId, clientSecret?, refreshToken}` through the same write-only credential
   endpoint as any API key. Access tokens are never persisted — they're minted per process
   from the refresh token and cached in memory.

Grant the app **read-only** scopes plus offline access (see each guide). Revoking the grant
on the platform makes the next refresh fail — re-run `lw providers auth` to re-consent.

## Instance-level config the providers depend on

Two features in the provider layer need instance config beyond the provider entry itself:

- **The exit** (materialize a source into your own store) writes bytes to the
  [BlobStore](../catalog.md#where-instance-bytes-live). `blobs.driver` is `pg` by default
  (zero moving parts); for `s3`, set `blobs.s3.bucket` (and `endpoint` for MinIO/Ceph) and
  the env-only credential `LW_BLOBS_S3_CREDENTIAL=<accessKeyId>:<secretAccessKey>`. See the
  `blobs` block in [`instance.example.json`](../../instance.example.json).
- **Publish-out** signs nothing itself — it *verifies* the export already carries lolly's
  C2PA export assertion, which means an instance **signer** must be configured
  ([c2pa.md](../c2pa.md), `render.c2pa` + `LW_C2PA_SIGNING_KEY`). Without a signer, exports
  are unsigned and the publish route refuses them.

## Keeping these guides honest

`tests/provider-config-contract.test.ts` asserts that every kind we ship has a guide with
the required headings, that each guide's `instance.json` example parses through
`parseConfig`, that its `options` keys match the driver, and that a guide only claims the
exit/publish for a kind whose driver supports it. A driver change that outruns its guide
fails CI.
