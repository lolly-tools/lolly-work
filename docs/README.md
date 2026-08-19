# Documentation - Lolly control plane

Operator and administrator documentation for a **deploy** of the Lolly control plane. These
pages describe what is *built*.

**Read them in the console:** every page here is served at `/admin#/docs` on a running
deploy, so whoever is operating it does not need the repository. `docs.json` is the source of
truth for that surface - a page added here without an entry there gets no console page.

The open-source half of Lolly (engine, catalog, shells) documents itself at **`/info/`** on
any Lolly deployment. The console links there when this deploy serves or points at one.

## Start here

| Doc | What it covers |
|---|---|
| [overview](overview.md) | The control plane in one page: what it serves, the two-repo shape, the trust model |
| [install](install.md) | The whole first deploy: local demo, first config, sign-in and the first owner, Postgres, secrets, Compose / systemd / Helm |
| [deployment](deployment.md) | Helm/Rancher, Compose, Vercel, air-gap - what each path carries |

## Configure

| Doc | What it covers |
|---|---|
| [configuration](configuration.md) | Every `instance.json` key and `LW_*` variable, with defaults |
| [identity](identity.md) | OIDC SSO, group→role mapping, member and guest sessions, offboarding |

## Govern

| Doc | What it covers |
|---|---|
| [permissions](permissions.md) | Seven roles, every action, deny-wins grants, the owner guard |
| [governance](governance.md) | Tool overlays, input locking, profile policy, feature flags, policy-as-code |
| [catalog](catalog.md) | Brand packs, providers, exposure slices, expiry and stop-sharing |
| [offboarding](offboarding.md) | Leaving a DAM: pin early, the Canto/Image Relay fork, exit readiness per vendor |
| [approvals](approvals.md) | Chains, rules, separation of duties |
| [sharing](sharing.md) | Server renders, signed links, watermarks, provenance |
| [c2pa](c2pa.md) | Giving this deploy a signing identity for verifiable exports |

## Connect a source

One guide per catalog provider kind, written for the owner of the source platform: what you
need from the platform, the `--options` that kind takes, where its credential comes from, and
how to verify. All of them are served in the console too.

| Doc | What it covers |
|---|---|
| [provider guides](providers/README.md) | The shared skeleton, OAuth onboarding, which drivers are fixture-verified only |
| [s3](providers/s3.md) · [git](providers/git.md) | A private bucket (AWS / MinIO / Ceph), and a manifest under version control |
| [brandfolder](providers/brandfolder.md) · [optimizely-cmp](providers/optimizely-cmp.md) | Brandfolder read-only; Optimizely CMP in, and optionally exports back out |
| [imagerelay](providers/imagerelay.md) · [canto](providers/canto.md) | The two halves of the Canto/Image Relay fork |
| [acquia-dam](providers/acquia-dam.md) · [intelligencebank](providers/intelligencebank.md) | The governance-rich enterprise DAMs |
| [penpot](providers/penpot.md) | An open, self-hostable design-system source |
| [dropbox](providers/dropbox.md) · [gdrive](providers/gdrive.md) · [o365](providers/o365.md) | The three kinds with a registered PKCE consent flow |
| live-verify runbooks | [canto](providers/canto-live-verify.md) · [imagerelay](providers/imagerelay-live-verify.md) · [intelligencebank](providers/intelligencebank-live-verify.md) · [acquia-dam](providers/acquia-dam-live-verify.md) |

Connecting your first one end to end, with commands:
[install §9](install.md#9-connect-a-source).

## Operate

| Doc | What it covers |
|---|---|
| [operations](operations.md) | Migrations, HA, secret rotation, backup, limits, monitoring, upgrades |
| [telemetry](telemetry.md) | What is recorded, what never is, attribution consent, dashboards |
| [audit](audit.md) | The hash-chained record, verification, anchoring the head off-box |

## Reference

| Doc | What it covers |
|---|---|
| [api](api.md) | Every route with the action it requires, and the common error codes |
| [cli](cli.md) | `lw` command reference |
| [status](status.md) | What is built, the open gaps in priority order, roadmap shape |

## Conventions

- **"This deploy" / "deployment"** is the unit of installation - one organization's control
  plane, its config, its pack, its governance.
- Code paths are cited where they are the authority; where a doc and the code disagree, the
  code wins and the doc is a bug.
- Nothing here contains a secret, and nothing here is organization-specific: the deploy's name,
  brand and IdP all live in `instance.json`.
