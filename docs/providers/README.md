# Provider onboarding guides

Per-platform setup for each catalog **provider** kind - written for the owner of the source
platform. Each guide follows the same skeleton: *what you need from the platform* → *the
credential shape* → *a copy-pasteable `instance.json` example* → *verify* → *notes/limits*.

The lolly side of providers (exposure, lifecycle, the exit, publish-out) lives in
[catalog.md](../catalog.md); who may do what is in [permissions.md](../permissions.md);
leaving one of these platforms is [offboarding.md](../offboarding.md).

| Kind | Auth | Guide |
|---|---|---|
| `brandfolder` | bearer API key | [brandfolder.md](brandfolder.md) |
| `s3` | `key:secret` (SigV4) | [s3.md](s3.md) |
| `optimizely-cmp` | OAuth2 (federate-in **and** publish-out) | [optimizely-cmp.md](optimizely-cmp.md) |
| `git` | token (or public) | [git.md](git.md) |
| `dropbox` | OAuth2 (BYOT) | [dropbox.md](dropbox.md) |
| `gdrive` | OAuth2 (BYOT) | [gdrive.md](gdrive.md) |
| `o365` | OAuth2 (BYOT) | [o365.md](o365.md) |
| `penpot` | personal access token (self-hosted); design-system source | [penpot.md](penpot.md) |
| `imagerelay` | OAuth2 (BYOT); off-boarding source | [imagerelay.md](imagerelay.md) |
| `canto` | OAuth2 (BYOT); off-boarding source | [canto.md](canto.md) |
| `acquia-dam` | bearer token (Widen v2); native availability | [acquia-dam.md](acquia-dam.md) |
| `intelligencebank` | login handshake (v3 Graph API); native governance | [intelligencebank.md](intelligencebank.md) |

`mock` is a test/demo driver and has no onboarding guide.

## The live-verify runbooks

Four DAM drivers ship **fixture-verified**: their endpoint paths and field names come from
public vendor documentation and have not been confirmed against a real tenant, because this
repo signs no vendor EULA to obtain one. Each carries a `LIVE-VERIFY` checklist in its source
header and a runbook beside its guide that discharges it in one ordered pass -
`lw providers preview --shape` for the tenant's record structure, an assumption table mapping
each guess to the constant that holds it, and a blob fetch to prove the bytes are the original
rather than a rendition:

| Kind | Runbook |
|---|---|
| `canto` | [canto-live-verify.md](canto-live-verify.md) |
| `imagerelay` | [imagerelay-live-verify.md](imagerelay-live-verify.md) |
| `intelligencebank` | [intelligencebank-live-verify.md](intelligencebank-live-verify.md) |
| `acquia-dam` | [acquia-dam-live-verify.md](acquia-dam-live-verify.md) |

They are written for the platform team running the pass on a customer's tenant, so they name
file paths and constants. A runbook is the checklist for that day, not a record of one.

Universal rules across every kind: credentials are **write-only** (sealed at rest, only a
fingerprint is ever returned), providers are **read-only** federation (deleting one never
touches remote content), fetches are **host-pinned** (never an open proxy), and exposure -
not the platform credential - decides what federates. Bring your own tokens/apps; none ship
in this repo.

## OAuth kinds

Every OAuth kind here is BYOT: you register **your own** app on the platform - no client ids
ship in this repo - and the sealed credential is the same one JSON blob either way:

```json
{ "clientId": "…", "clientSecret": "…", "refreshToken": "…" }
```

What differs is only **how that blob is captured**, and that splits the kinds in two.

### Kinds with a registered consent flow (dropbox, gdrive, o365)

`lw providers auth` runs the whole capture for these three:

```bash
lw providers add acme-x --kind <dropbox|gdrive|o365> --label "…" --options '{…}'
lw providers auth acme-x        # prompts for client id/secret, runs a loopback PKCE consent
lw providers enable acme-x      # owner-only
```

`lw providers auth`:

1. Prompts for **your** app's client id and (unless it's a public/PKCE-only app) client
   secret - never argv, never shell history.
2. Runs a **PKCE loopback** consent: opens the platform's consent screen, receives the code
   on `http://127.0.0.1:<port>`, exchanges it for a **refresh token**.
3. Stores `{clientId, clientSecret?, refreshToken}` through the same write-only credential
   endpoint as any API key. Access tokens are never persisted - they're minted per process
   from the refresh token and cached in memory.

Grant the app **read-only** scopes plus offline access (see each guide). Revoking the grant
on the platform makes the next refresh fail - re-run `lw providers auth` to re-consent.

### Kinds whose consent flow is not registered (canto, imagerelay, optimizely-cmp)

Their authorize endpoint is among the details **not confirmed against a real tenant**, so
`oauthFlowFor` registers no consent flow and `lw providers auth` refuses these kinds, naming
the remedy. The blob goes in through `lw providers credential`, which works for any kind:

```bash
lw providers add acme-canto --kind canto --label "…" --options '{…}'
lw providers credential acme-canto   # prompts for the blob; never argv, never shell history
lw providers enable acme-canto       # owner-only
```

**Where the refresh token comes from.** The vendor's own documented OAuth2
authorization-code flow, run once by hand against the app you registered:

1. Register an app under your own contract in the vendor's console (Canto issues its App ID +
   Secret through support) and allow a redirect URI you control.
2. Run the vendor's documented authorize/consent step for that app, asking for read scopes
   plus offline access, and collect the authorization code it returns.
3. Exchange that code for a **refresh token** at the vendor's documented token endpoint.
4. Paste `clientId` / `clientSecret` / `refreshToken` into `lw providers credential <id>`.

The vendor's own API documentation is the source of record for steps 2 and 3: **this repo
prints no authorize URL for these kinds**, because it has confirmed none. Once the blob is in,
everything downstream is identical to the flow kinds - write-only at rest, and access tokens
minted per process from the refresh token, never persisted. A tenant pass that confirms a
kind's authorize and token endpoints moves it up a section and grows it a consent flow.

## Instance-level config the providers depend on

Two features in the provider layer need instance config beyond the provider entry itself:

- **The exit** (materialize a source into your own store) writes bytes to the
  [BlobStore](../catalog.md#where-instance-bytes-live). `blobs.driver` is `pg` by default
  (zero moving parts); for `s3`, set `blobs.s3.bucket` (and `endpoint` for MinIO/Ceph) and
  the env-only credential `LW_BLOBS_S3_CREDENTIAL=<accessKeyId>:<secretAccessKey>`. See the
  `blobs` block in [`instance.example.json`](../../instance.example.json).
- **Publish-out** signs nothing itself - it *verifies* the export already carries lolly's
  C2PA export assertion, which means an instance **signer** must be configured
  ([c2pa.md](../c2pa.md), `render.c2pa` + `LW_C2PA_SIGNING_KEY`). Without a signer, exports
  are unsigned and the publish route refuses them.

## Keeping these guides honest

`tests/provider-config-contract.test.ts` makes these pages a checked contract, so a driver
change that outruns its guide fails CI. It asserts that:

- every shipped kind has a guide with the required headings, whose `instance.json` example
  parses through `parseConfig` and whose `options` keys match the driver;
- a guide carries a `## Publishing` section only for the one kind whose driver can publish out;
- every DAM kind carries an `## Off-boarding` section and a row in
  [offboarding.md](../offboarding.md);
- every `lw …` command any page under `docs/` instructs - fenced block or sentence - resolves
  against the switches in `cli/lw.ts`, with `lw providers auth <id>` allowed only for a kind
  `oauthFlowFor` registers a consent flow for;
- every driver hardened for tenant day has the live-verify runbook its error messages point at.
