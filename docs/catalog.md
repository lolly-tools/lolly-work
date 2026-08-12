# Catalog and content

The catalog is what members can actually use: tools, brand assets, tokens, fonts, logos. It
comes from two sources — the **pack** on disk, and **providers** that federate external
systems read-only — and both are filtered by the same governance.

![The governed catalog — served assets with lifecycle, expiry and one-click revocation](shots/catalog-assets.svg)

![Federated catalog providers — external sources consumed read-only, credentials sealed](shots/catalog-providers.svg)

## The pack

`instance.pack` points at a directory (a "brand pack"). Everything brand-shaped lives there:

```
catalog/tools/index.json      the tools this deploy offers
catalog/assets/index.json     assets, with a formats list per asset
catalog/fonts/webfonts/       self-hosted woff2
tools/<id>/tool.json          per-tool input definitions
```

Served at `/catalog/*` (blobs) and `/api/v1/catalog/assets/*`, filtered per caller. The
pack's design tokens double as the console's own theme: **This Deploy → Design system**
shows the live tokens the tools consume, and the sign-in screen inherits the pack's colours,
fonts and logo through a deliberately narrow unauthenticated `/api/brand` route — brand
chrome only, never the governed catalog.

A pack is immutable for a process: publish a new pack and restart (or roll) to pick it up.

## Access modes

`policy.defaultAccessMode` decides who may read the catalog at all:

| Mode | Behaviour |
|---|---|
| `open` | anonymous reads allowed |
| `gated` | sign-in required (`401 UNAUTHORIZED`, "this deployment is sign-in gated") |
| `per-tool` | per-resource decision through grants |

On top of that, overlay `visibility` removes individual tools from the feed for groups that
should not see them ([governance](governance.md)).

## Content lifecycle

Every asset can carry a lifecycle row — the "stop sharing" primitive, as one action:

```
GET /api/v1/catalog/lifecycle
PUT /api/v1/catalog/lifecycle/<assetId>     # catalog.expire / catalog.publish
```

| Field | Meaning |
|---|---|
| `validFrom` | not live before this instant |
| `validUntil` | expired at or after this instant |
| `revokedAt` | revoked forever, regardless of the dates |
| `onExpiry` | `hide` (default) or `warn` |

Resolved state is one of `live`, `scheduled`, `expired`, `revoked`; revoked always wins, and
an asset that was never live reads `scheduled` even if its end date has also passed. The
feed drops revoked, scheduled and expired-`hide` entries, and keeps expired-`warn` entries
annotated `expired: true` so a client can nag without a second fetch. The blob route applies
the same state to individual files, so hiding an asset from the feed also stops serving its
bytes.

The console's Catalog view lists every asset the deploy serves with a thumbnail, expiry and
revocation state; a revoked or hidden-on-expiry asset stays listed there — without its
catalog metadata — so it can still be managed.

## Catalog providers

A provider is an admin-configured, **read-only** connector to a system that stays the source
of truth. Assets federate into the feed namespaced `ext/<providerId>/<remoteId>`, so
lifecycle rows, grants and render-cache invalidation work on them unchanged. Lolly stores
references plus its own governance overlays — deleting a provider never touches remote
content.

Kinds: `brandfolder`, `s3` (hand-rolled SigV4), `git` (raw-HTTP manifest), `dropbox`,
`gdrive`, `o365`/Graph, `mock`. No SDKs, publicly documented endpoints only.

```bash
lw providers list
lw providers add acme-bf --kind brandfolder --label "Acme Brandfolder" \
  --options '{"brandfolderId":"…"}' \
  --exposure '{"groups":["marketing"],"requireApproved":true,"tier":"reference"}'
lw providers credential acme-bf     # prompts; never argv, never shell history
lw providers auth acme-bf           # OAuth kinds: PKCE loopback consent flow
lw providers sync acme-bf
lw providers health acme-bf
lw providers enable acme-bf         # owner-only
```

Console equivalent: **This Deploy → Providers**.

### Exposure governance

| Field | Effect |
|---|---|
| `groups` | which member groups see these assets (`*`/absent = all members) |
| `requireApproved` | only assets the upstream marks approved |
| `includeSections` | provider-native folder/section scoping |
| `excludeTags` | drop assets carrying these tags |
| `tier` | catalog tier stamped on the entries |

Slice filters (`requireApproved`, `includeSections`, `excludeTags`) apply at
fragment-build time — excluded assets never enter the feed *or* the store. Group visibility
applies per caller at compose time.

### Credentials

Credentials are **write-only**. A stored credential is sealed with AES-256-GCM under
`LW_CREDENTIAL_SECRET`; APIs only ever return a display fingerprint (hash prefix +
last four). Storing one requires the owner-only `catalog.provider.credential`, and so does
the `enable` kill switch — an admin can shape a provider, but only an owner arms it.

Config-managed providers (declared in `instance.json`) are upserted at boot as
`managedBy: 'config'`, name their secret via `credentialRef` (an env var name), and are
read-only in the API: editing one returns `409 CONFIG_MANAGED` — change the file and
redeploy. That is the GitOps/air-gap path.

### Sync and resilience

Request-driven, not a cron: each provider keeps an in-process fragment with a TTL
(`sync.ttlSeconds`, default 300). An expired fragment is served as-is while a background
refresh runs, and the last successful fragment is persisted, so a cold boot or a provider
outage serves something marked stale rather than a 500. Fragment hashes fold into the
catalog version, so a refresh ripples through render-cache invalidation.

`GET /api/v1/catalog/search` fans out live to providers that support server-side search,
through the same exposure gates.

### Third-party terms

Providers are integrations, not replacements. Every deploy brings its own API tokens and
OAuth apps — none ship in this repo — and provider names appear descriptively only. This
project *includes an integration for* those services and is not affiliated with them.

## Related

- Restricting tools and inputs: [governance](governance.md)
- Serving and sharing what the catalog holds: [sharing](sharing.md)
- Where provenance for federated assets comes from: [sharing](sharing.md#provenance) and
  [c2pa](c2pa.md)
