# `lw` CLI

A thin wrapper over the same API the console uses, so the two grow in parity by
construction. Run it as `npm run cli -- <args>` from the repo, or `node cli/lw.ts`. To get
the plain `lw` the examples below use, run `npm link` once in the checkout - that is the
only thing that puts it on `PATH` (it is not in the container image or the Helm pod, so
`lw` drives a deploy from a checkout, not from inside it).

```bash
export LW_BASE=https://lolly.example.com    # or pass --base <url>
npm run cli -- summary
npm run cli -- --json audit head            # machine output
```

## Signing in

```bash
lw login --email admin@example.test         # dev provider (dev.enabled only)
lw login --cookie 'lw_session=…'            # paste a browser session (OIDC deploys)
```

The session cookie is stored at `~/.config/lolly-work/session` (mode 0600). A device-code
flow against OIDC is the planned replacement for the paste.

## Reading

```bash
lw whoami
lw summary            # telemetry rollups
lw fleet              # which shells/engines are connected
lw links [--all]
lw audit verify       # exits 2 if the chain is broken
lw audit head         # seq · hash · count · intact  (exits 2 if broken)
lw preview --groups marketing,contractors   # what such a member receives
```

## Governance

```bash
lw grants list
lw grants add <principal> <action> [<resource>] --effect allow|deny
lw grants rm  <principal> <action> [<resource>] --effect allow|deny

lw export [--out governance.json]           # canonical governance document
lw apply governance.json [--dry-run] [--prune]
```

`apply` prints a per-category diff (`+create ~update -delete (=unchanged)`) and the document
hash. `--dry-run` changes nothing; `--prune` also deletes store-only entries. See
[governance](governance.md).

## Catalog providers

```bash
lw providers list
lw providers preview --kind <kind> [--options '{…}'] [--mapping '{…}'] [--exposure '{…}'] [--json]
lw providers preview --kind <kind> --shape [--remote-id <id>] [--json]
lw providers add <id> --kind <kind> --label "…" \
    [--options '{…}'] [--mapping '{…}'] [--exposure '{…}']
lw providers credential <id>      # prompts, hidden - never argv, never shell history
lw providers auth <id>            # the OAuth kinds with a registered consent flow
lw providers enable|disable <id>  # owner-only
lw providers sync|health <id>
lw providers drift <id>
lw providers materialize <id> [--remote-id <id> | --section <name>]
lw providers cutover <id>         # owner-only
lw providers rm <id>
```

Kinds: `brandfolder`, `s3`, `git`, `dropbox`, `gdrive`, `o365`, `optimizely-cmp`,
`imagerelay`, `canto`, `acquia-dam`, `intelligencebank`, `penpot`, `mock`. See
[catalog](catalog.md), the first-connection walkthrough in
[install §9](install.md#9-connect-a-source), and the per-kind
[provider guides](providers/README.md).

### `preview` - the dry run

The safe first contact with a tenant, and the command every provider guide's `## Verify`
section starts with. It builds an **ephemeral** record from the flags, health-checks it, and
maps up to ten of its assets - then throws the record away. Nothing is stored, nothing is
enabled, and no provider id is needed (or created), so a wrong option costs you a retry
rather than an audited record to delete.

```bash
lw providers preview --kind canto --options '{"tenant":"acme","domain":"com"}'
credential for the canto preview (empty if this kind needs none): ▒▒▒▒▒▒
health ok - canto
mapped sample: 10 of 100 on the first page
  id                                name                        type      tags                              formats
  ext/preview/image:AB12C           Summit Keynote Background   image     provider:preview Backgrounds la…  png
```

The credential is prompted hidden, exactly like `lw providers credential` - it is a real
tenant secret even in a dry run, so it never reaches argv or shell history. Press enter on
the prompt for a source that needs none (a public `git` manifest, an open `s3` bucket).

Read the table as a mapping check: the `id` is the federated id this kind would mint, `type`
is what `mapping.typeMap`/`defaultType` resolved to, and sections arrive **as tags** unless
you set `mapping.sectionTags: false`. The sample passes the **same exposure slice a real sync
applies**, so what you see is what would federate - and what the slice removed is counted on
the same line (`, N EXCLUDED by the exposure slice`), so an empty sample says whether it was
the slice or the options scope. `--json` prints the raw response for scripting. Exit code `2`
means the health check failed.

`--shape` answers the other question, and returns **no sample**: the call the driver made, and
the key names and value **types** the tenant returned, diffed against the key names the driver
reads. Never a value, so the output redirects straight to a file you can send. Only the drivers
whose field names are still taken from vendor documentation implement it - every other kind
answers that it carries no live-verify debt. It is the first command in each live-verify
runbook ([canto](providers/canto-live-verify.md), [imagerelay](providers/imagerelay-live-verify.md),
[intelligencebank](providers/intelligencebank-live-verify.md),
[acquia-dam](providers/acquia-dam-live-verify.md)), which explains the report's three diff
groups.

`--remote-id <id>` alongside `--shape` adds a second report, on the per-asset **detail** call
the byte path makes (the one that carries the download link). Only the kinds whose bytes need
that call implement it - `imagerelay`, `intelligencebank`, `acquia-dam`; a kind that builds its
binary path out of the list record, like `canto`, answers that there is no other response to
describe. It fetches JSON about one asset, never its bytes.

### `drift` - what has changed upstream since you materialized

The cadence check during a staged exit ([off-boarding](offboarding.md)). It compares the
`sourceUpdatedAt` stamped on each materialized copy against the `updatedAt` the source
carries **now**, and lists what has moved:

```bash
lw providers drift acme-canto
acme-canto: 2 drifted of 118 compared (118 materialized asset(s) in all)
  image:AB12C                  was 2026-06-01T00:00:00.000Z  now 2026-08-01T12:00:00.000Z  inst/9f2c…
  image:DE34F                  was 2026-05-04T09:11:00.000Z  now 2026-08-14T16:02:00.000Z  inst/1ab7…
never materialized (3): image:GH56I, image:JK78L, video:MN90P
remedy: lw providers materialize acme-canto --remote-id <remoteId> - idempotent per (provider, remoteId), so a re-run resumes rather than duplicates.
```

It is read-only: it stores nothing and re-materializes nothing, so it is safe on a schedule.
A copy taken when the source carried no timestamp is compared against its `materializedAt`
instead.

**"Cannot tell" is never dressed up as "unchanged".** `compared` counts only the copies that
got a real answer; every other copy is counted, and printed, under its own reason:

```
not compared: 4 copy(ies) whose upstream record carries no change stamp the driver can read - check this kind's UPDATED_AT_KEYS against its live-verify runbook.
not compared: 2 copy(ies) whose change stamp would not parse as a date (shape NNNNNNNNNN) - drift detection is inoperative for those until the driver reads that format.
not compared: 1 copy(ies) whose remote id is no longer in the listing at all.
read with care: 3 comparison(s) used a stamp that names no timezone (shape NN/NN/NNNN NN:NN) - it was read in THIS server's timezone, so those answers can be off by its UTC offset.
```

The stamp **shapes** are printed, never the stamps: digits collapse to `N` and letters to `A`,
so `NNNNNNNNNN` is an epoch integer and `NN/NN/NNNN NN:NN` a zoneless local datetime. That
names the format for a driver fix without carrying an upstream value. A source stamping either
one therefore reports as "cannot tell" or as a timezone caveat, never as a clean bill of
health, which is the failure mode these lines exist to catch.

## Catalog submit

Put a local file into this instance's catalog, and work the review queue
([catalog](catalog.md#submitting-an-asset)):

```bash
lw catalog submit ./hero.png --name "Campaign Hero" [--tags campaign,hero] [--type icon] \
                             [--groups design] [--label "Q4 hero"]
lw catalog queue [--all]
lw catalog edit    inst/ab12cd34 --name "Campaign Hero 2026" --tags campaign,hero
lw catalog approve inst/ab12cd34
lw catalog return  inst/ab12cd34 --body "wrong logo lockup"
```

`submit` needs the `catalog.submit` action (the author role carries it). With no
`policy.submit.chain` configured the asset is live on return; with one, it prints the state as
`submitted` and waits for `approve` or `return`. Identical bytes are reported as a duplicate
and nothing is stored a second time:

```
already in the catalog as inst/ab12cd34 (identical bytes; nothing stored)
```

`queue` lists what is waiting, tagged `mine` or `inbox` depending on whether it is your own
submission or one your groups may act on; `--all` includes what has already been published or
returned. `edit` corrects a pending submission's declared metadata before it goes out - name,
type, tags and description, never the bytes or the exposure - and is audited with its before
and after. `approve` and `return` go through the approvals engine, so you cannot decide your
own submission.

## Messaging

```bash
lw msg send --title "Update by Aug 15" \
    [--body "…"] [--kind …] [--severity action] \
    [--groups marketing,legal] [--shells tauri] [--max-engine 1.52.99]
```

## Local infrastructure commands

These two talk to something other than the API base:

```bash
lw migrate [--check]          # needs a local DATABASE_URL; --check exits 1 if pending
lw c2pa init [--org "Acme"] [--out ./c2pa] [--days 365]
```

`lw c2pa init` mints a self-contained signing identity (root + leaf) so exports can be signed
with zero corporate PKI, and prints exactly what to wire where. If you have a corporate CA,
skip it and use your own chain. See [c2pa](c2pa.md).

## Global flags

| Flag | Meaning |
|---|---|
| `--base <url>` / `LW_BASE` | which deploy to talk to (default `http://localhost:8787`) |
| `--json` | machine-readable output |

Exit codes: `1` on any API error or usage mistake, `2` specifically for a broken audit chain
or a pending schema - so both are usable as monitoring checks.
