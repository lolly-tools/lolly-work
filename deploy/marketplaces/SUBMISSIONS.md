# Prepared upstream submissions

These are review materials. Submit only after the named channel's actual
installation/update evidence is available. Record the real account/organization,
two recovery maintainers and returned listing IDs in the maintainer handoff.
No payment, referral, commission, credit-earnings or payout configuration is part
of these submissions. Use the legal publisher identity actually authorized by the
project; the display name below does not establish a legal entity.

## Shared listing copy

Name: **Lolly Work**. Publisher display name: **Lolly project**.

Lolly Work is the open-source control plane for an organisation's Lolly tools,
assets and collaboration. It provides organisation sign-in, governed access and
audit, with data stored in the operator's PostgreSQL database. The neutral package
includes a matched Lolly web shell and redistributable community content.

Lolly Work is free software under MPL-2.0. Operators provide hosting, identity,
domains and backups. Support is best-effort community support through the upstream
repository; no service-level agreement is included. The default installation uses
one writable collaboration owner and has no Chromium worker. Initial setup needs
a real domain and named owner; built-in password sign-in uses a private,
host-issued setup link. Organisation OIDC is optional. The neutral package downloads its
shell and on-demand models from `lolli.li`; see the installation directory for
architecture, network and acceptance limits.

- Source and issues: `https://github.com/lolly-tools/lolly-work`
- Project: `https://lolly.work`
- Installation/status: `https://github.com/lolly-tools/lolly-work/blob/main/docs/official-installations.md`
- Licence: `https://github.com/lolly-tools/lolly-work/blob/main/LICENSE`
- Icon: `deploy/helm/icon.svg` or the identical Dokploy blueprint icon
- Screenshots: capture a qualified neutral test instance; exclude production
  branding, accounts and data. These still need actual target captures.

## Helm and Artifact Hub

Publish the chart with the maintained workflow after merge and exact-source CI.
Verify anonymous index/archive downloads and Sigstore verification. Then use a
project-controlled Artifact Hub organization, proposed name `lolly-tools`, and
repository name `lolly-work`; name availability has not been claimed.

Repository kind: Helm. URL:
`https://github.com/lolly-tools/lolly-work/releases/download/helm-index`.
Copy the actual returned repository UUID and verified maintainer email into the
repository variables described in README.md. Publish a new chart version after
adding ownership metadata so the indexer observes a material chart change. Check
the actual Verified publisher result before the Official request.

Official-status request title: **[OFFICIAL] Lolly Work Helm repository**.
Prepared body:

> The Lolly project publishes and maintains Lolly Work and this Helm chart in
> `https://github.com/lolly-tools/lolly-work`. The repository contains only our
> upstream Lolly Work package, with its README and MPL-2.0 licence. The chart links
> to our application source and official installation documentation. We request
> Official status for the Lolly Work repository after Verified publisher is
> confirmed. Add the actual Artifact Hub repository URL and verification evidence
> before submitting.

Online request:
[Artifact Hub Official status form](https://github.com/artifacthub/hub/issues/new?template=official-status-request.md).

## Dokploy

Proposed PR title: **Add upstream Lolly Work neutral deployment template**.

Copy `deploy/dokploy/lolly-work/` to `blueprints/lolly-work/` in the current
Dokploy templates repository. The files include its metadata, neutral icon,
generated Compose stack and template environment/domain configuration. Preserve
the upstream source/docs links. Complete their metadata validation and import the
preview on an isolated Dokploy installation before submitting.

Prepared PR description:

> Adds the upstream Lolly Work template using the official digest-pinned server,
> checksum-pinned matched neutral shell and durable PostgreSQL. Dokploy supplies
> HTTPS; application and database ports are not published. Operators configure
> their domain and named owner before deployment, then issue a private first-owner
> password setup link from the server. Organisation OIDC is optional. Session/link/
> credential keys, configuration and database persist through restarts/upgrades.
> The software is MPL-2.0 and has no project billing or commission integration.
> Add the exact blueprint source, Dokploy version, preview/import result, real
> identity, initial/second-version upgrade and independent restore receipts here
> after those checks pass.

## Channel handoff at this slice

| Channel | Project-controlled route | Outstanding external/target evidence |
|---|---|---|
| GHCR | Existing public `lolly-tools` image packages; signed 1.1.1 release record | Confirm administrator/recovery custody; native arm64 runtime remains open |
| Helm | New upstream publication workflow and immutable chart assets/index layout | First merged-source publication, anonymous download/signature result and Rancher install/upgrade |
| Artifact Hub | Prepared organization/repository identity and ownership metadata support | Account/name availability, real UUID/email, Verified publisher, then Official review |
| UpCloud | Existing infrastructure module plus new neutral package recipe | Dedicated fresh target, real identity/output, reboot, cross-version upgrade and independent restore |
| YunoHost | Existing project package/mirror/tag | Catalogue registration and remaining platform acceptance; preserve beta status |
| Dokploy | Generated upstream blueprint with PR/update route | Isolated Dokploy acceptance, second-version installed upgrade, maintainer submission and catalogue review |

Container rehearsal evidence must retain its limits: local-CA HTTPS, anonymous
private-access refusal, native first-owner sign-in, restart/persistence and database
round trip do not prove real customer OIDC, cross-version upgrade, a cloud image's boot or Dokploy UI
integration. Keep those steps pending until measured on their actual targets.
