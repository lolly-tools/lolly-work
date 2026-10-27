# Distribution channels

Which channel carries which Lolly Work release, and how a channel is updated,
reviewed, paused and retired. [`channels.json`](channels.json) is the record. The
table below is generated from it and from [`release.json`](release.json); do not
edit the table by hand.

## Versions by channel

<!-- channel-table:begin (generated from channels.json by node scripts/marketplace-channels.ts) -->
Qualified release cohort: Work 1.1.1, from [`release.json`](release.json).

| Channel | Route | Carries | Latest attempt | State | Still open |
|---|---|---|---|---|---|
| Container images (GHCR) | Image registry | [1.1.1](https://github.com/lolly-tools/lolly-work/releases/tag/v1.1.1) | published on 2026-10-15: Signed amd64 and arm64 images; both digests in release.json resolve without signing in. | current | Runtime qualification of the render worker's arm64 image; the server's arm64 image passes only the CI container qualification. |
| Helm chart repository | Project repository | Nothing yet | None | prepared | First publication of the chart, as 1.1.3 with the Lolly 1.1.3 release, anonymous download and signature checks, then a live Rancher installation and upgrade. |
| Artifact Hub | Public catalogue | Nothing yet | None | prepared | A project organisation and repository, then Verified publisher, then Official status. |
| Neutral Compose package (VM or private server) | Direct recipe | [1.1.1](https://github.com/lolly-tools/lolly-work/tree/265ea5d31d4da010d535fd27092f6deb150bf1d9/deploy/marketplaces) | published on 2026-10-16: CI boots the pinned package, signs in, exports, restarts and restores its database. | current | An installed cross-version upgrade and recovery on a second host. |
| UpCloud quick start | Direct recipe | [1.1.1](https://github.com/lolly-tools/lolly-work/blob/265ea5d31d4da010d535fd27092f6deb150bf1d9/deploy/marketplaces/QUALIFICATION.md) | published on 2026-10-16: Reference installation on Ubuntu 24.04 amd64 in Frankfurt, created through the provider API. | current | An installed cross-version upgrade, recovery on a second host, organisation OIDC and a boot through the infrastructure module. |
| Evroc quick start | Direct recipe | Nothing yet | None | prepared | Boot and application acceptance on an Evroc account. |
| YunoHost package (beta) | Direct recipe | [1.1.1 (1.1.1~ynh1)](https://github.com/lolly-tools/lolly-work_ynh/tree/v1.1.1-ynh1) | published on 2026-10-15: Beta tag; its pinned archives download. All seven package tests passed on amd64 Bookworm. | current | Runtime acceptance (the 1.1.1 run fails its level check), arm64 installation; the beta label stays. |
| YunoHost app catalogue | Public catalogue | Nothing yet | None | prepared | Catalogue registration, which waits for a maintainer's authorisation. |
| Dokploy templates | Public catalogue | Nothing yet | None | prepared | Isolated Dokploy import and acceptance, a second-version installed upgrade, then the catalogue pull request. |
<!-- channel-table:end -->

A channel carries the version from its last published attempt that was not later
withdrawn. A submitted, failed or rejected attempt never changes that version. When
the latest attempt failed or was rejected, the channel shows **failed** until a later
attempt succeeds, even if it still carries the qualified release. A paused or
retiring channel keeps that state and adds "latest attempt **failed**" until a later
attempt succeeds. Publication, qualification and catalogue admission are separate
claims: the **Still open** column lists the acceptance that a published version
still lacks.

| State | Meaning |
|---|---|
| prepared | Materials are in this repository; nothing has been published through the channel |
| in review | The latest attempt was submitted and waits for the channel's review |
| current | The channel carries the release named in `release.json`, or a later one |
| behind | The channel carries an older release than `release.json` names |
| failed | The latest attempt failed or was rejected; the channel keeps its earlier version |
| withdrawn | Every version published through the channel was withdrawn, so it carries nothing until the next publication |
| paused | A maintainer review stopped updates through the channel for now |
| retiring | A retirement notice is out and new installations end on the stated date |
| retired | New installations are withdrawn; existing installations are left alone |

## What the public record holds

Only what an operator can already see: the route, release and package versions,
dates, outcomes, public evidence links, the acceptance still open, and the measured
effort of each attempt in minutes and review days. Account names and IDs, publisher,
offer and repository IDs, owner emails, recovery owners, credentials and test
receipts stay in the private maintainer record.

`node scripts/marketplace-channels.ts --check` runs in the tests. It refuses unknown
fields, email addresses, UUIDs, 12-digit account numbers, credentials, local or
private paths, evidence that is not a public `https` URL or carries a query string,
attempts appended out of date order, and a table that no longer matches the record.

## Record every attempt

Record failures as well as publications, in the same pull request as any change
they cause:

```sh
node scripts/marketplace-channels.ts record helm-repository --release 1.1.3 --package 1.1.3 \
  --outcome published --evidence https://github.com/lolly-tools/lolly-work/releases/tag/chart-v1.1.3 --minutes 20
```

`--package` is the channel's own version, such as a chart version or `1.1.1~ynh1`; it
defaults to the release. `--date` defaults to today in UTC. `--minutes` is the
maintainer time the attempt took and `--review-days` the time spent waiting for the
channel's review. The command validates the whole record and regenerates the table.

| Outcome | Use it when | Needs |
|---|---|---|
| `submitted` | A pull request or portal submission waits for the channel's review | The public pull request or listing URL when one exists |
| `published` | The version can be installed through the channel without signing in, and a maintainer checked it | Public evidence |
| `failed` | A publication or our own verification failed | A note saying what failed |
| `rejected` | The channel's review refused the submission | A note with the reason |
| `withdrawn` | A published version was taken out of new installations, for example after a security problem | A note; the channel falls back to its previous publication |

For `helm-repository` and `ghcr-images`, `record ... --outcome published` first
checks the channel without signing in: the public index must list the chart version
with its application version and serve an archive that matches the index digest,
and both image digests in `release.json` must resolve on GHCR. If a check fails,
nothing is written; record the attempt as `failed` instead. `verify` runs the same
check alone. Signature verification with `cosign` stays the manual step described in
[official installations](../../docs/official-installations.md#release-verification).

The **Publish official Helm chart** workflow writes the matching command into its run
summary, with `--outcome failed` and the run URL when the run does not succeed. A
successful run is still not a published attempt until the anonymous check passes.

Never rewrite or delete an attempt. Append a correction as a new attempt.

## Maintenance review

Review the channels after a pilot channel's second publication and installed-instance
upgrade, whenever `release.json` moves to a new release cohort, and before adding a
channel. Start with:

```sh
node scripts/marketplace-channels.ts review
```

It prints each channel's state, its published and failed attempts, the maintainer
minutes recorded on all its attempts and how many of them went to failed or rejected
attempts, the minutes per publication (all recorded minutes divided by the number of
publications) and the longest review wait, and names publications recorded without
minutes. It exits non-zero while any channel is failed, withdrawn, behind, in review
or paused, or while a paused or retiring channel's latest attempt failed, and prints
each one's update route. A non-zero exit means pause expansion:
update, fix, pause or retire those channels before adding another one. Add new
adapters one at a time, and choose the next only after the previous one has completed
a second publication and an installed-instance upgrade.

For each channel, decide to keep, pause or retire it. Keep a channel only while it
has a maintainer and a backup maintainer (named in the private record), a working
update and recovery route, current qualification, and a reason to remain, such as
known installations or support requests. A second publication that needed substantial
hand-editing of application configuration fails the pilot until that duplication is
removed or a maintenance exception is recorded.

To pause, set `"lifecycle": "paused"` and `"pause": { "since": "YYYY-MM-DD", "reason": "..." }`.
Resume by setting the lifecycle back to `maintained` and removing `pause`.

## Retirement and notice

When a channel can no longer be maintained:

1. Decide in a maintainer review. Record the reason in the private record along with
   the account details needed to withdraw the listing.
2. Publish a notice as a public issue in this repository and link it from
   [official installations](../../docs/official-installations.md) and, where the
   platform allows, from the listing description or package README. The notice names
   the channel, the last version it will carry, the date new installations end and
   the route existing operators should move to. It states that existing installations
   keep running and are never changed remotely, and links the recovery documentation.
3. Set `"lifecycle": "retiring"` and
   `"notice": { "url": "...", "published": "YYYY-MM-DD", "newInstallsEnd": "YYYY-MM-DD", "migration": "..." }`,
   where `migration` is the public URL of the migration route. Regenerate the table.
4. Until new installations end, keep publishing security fixes through the channel,
   or pause it and say so in the notice.
5. On the end date, withdraw new installations through the channel's own route:
   - **Public catalogue:** deprecate or remove the listing through the catalogue's
     update route. Keep the notice in the listing text while the listing is visible.
   - **Project repository:** publish a final chart version with `deprecated: true` and
     stop adding versions. Keep every published chart release and index entry, because
     existing installations and restores depend on them.
   - **Direct recipe:** remove it from official installations and the installation
     guide, and keep the recipe at its tag.
   - **Image registry:** stop publishing new tags. Never delete a published digest.
6. Set `"lifecycle": "retired"` and `"retired": "YYYY-MM-DD"`. The record then refuses
   further attempts for that channel.

Never delete artifacts that installations pin, push a change that alters or removes
an existing installation, or point a feed at a different product. Keep backup, restore
and upgrade documentation for the retired channel at a stable tag.

An unsafe published version is handled separately from retirement: record
`withdrawn` for that version as soon as new installations can no longer receive it,
and report it through the repository's `SECURITY.md` route.
