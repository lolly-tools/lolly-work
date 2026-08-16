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
| [install](install.md) | Nothing → running UI + CLI: hosted demo, 2-minute local run, systemd, Compose, Helm on RKE2/k3s |
| [quickstart](quickstart.md) | Demo mode, a real small deploy, split development, seeding governance |
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
| [approvals](approvals.md) | Chains, rules, separation of duties |
| [sharing](sharing.md) | Server renders, signed links, watermarks, provenance |
| [c2pa](c2pa.md) | Giving this deploy a signing identity for verifiable exports |

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
