# `lw` CLI

A thin wrapper over the same API the console uses, so the two grow in parity by
construction. Run it as `npm run cli -- <args>` from the repo, or `node cli/lw.ts`.

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
lw providers add <id> --kind <kind> --label "…" \
    [--options '{…}'] [--mapping '{…}'] [--exposure '{…}']
lw providers credential <id>      # prompts, hidden - never argv, never shell history
lw providers auth <id>            # OAuth kinds: PKCE consent via a loopback redirect
lw providers enable|disable <id>  # owner-only
lw providers sync|health <id>
lw providers rm <id>
```

Kinds: `brandfolder`, `s3`, `git`, `dropbox`, `gdrive`, `o365`, `mock`. See
[catalog](catalog.md).

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
