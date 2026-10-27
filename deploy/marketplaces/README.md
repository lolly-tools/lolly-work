# Official distribution maintenance

`release.json` selects an already published Work/Lolly cohort. Nobody edits it by
hand: [`scripts/marketplace-cohort.ts`](../../scripts/marketplace-cohort.ts) writes it
from the Work release's `release-source-images.json` (server and worker digests,
built from the release source for amd64 and arm64) and from the bytes of the web app
archive (checksum, sizes, the catalogue key the web app pins and the signed catalogue
sequence), then regenerates the Compose package, the Dokploy blueprint, the Helm
release values and the [channel table](CHANNELS.md). The neutral icon is copied from
that archive. Do not substitute an arbitrary shell build, a private brand pack or a
mutable image tag.

The source catalogue public key is the one the archive's web app pins, and the script
refuses an archive whose signed catalogue another key signed. The server verifies the
mounted pack's signed envelope with that key. `catalogGeneration` is at least the
envelope's `seq` and one above the previous pin: the server keeps the higher of the
two and refuses a new publication at a generation it has already recorded, so an
installation updated from the previous cohort accepts the new one.

The separate per-installation private key signs caller-specific catalogue
projections; it cannot verify the publisher's original envelope. The release web app
has the publisher's key built in and refuses any catalogue that key did not sign. On
first start, the content service therefore rewrites the publisher key's coordinates
in the web app's `_app` scripts to the installation's public key, rebuilds their `.br`
and `.gz` copies and records the change in `catalogue-key.json` beside the content.
The pack copy keeps the publisher's signature. Before this step a signed-in browser
showed no tools. Content installed without the step is refused rather than reused.
Keep both identities when updating a cohort, and test admitted catalogue access, an
export and the tool gallery in a real browser.

## Moving to a new release

For Lolly and Work release `X.Y.Z`:

1. **The web app archive.** The Lolly release builds and uploads
   `lolly-web-X.Y.Z-ynh1.tar.gz` to `lolli.li` with Lolly's
   `node scripts/yunohost-release.ts --build` (it needs the catalogue signing key, so
   the release owner runs it). When a release publishes only the signed web image,
   cut the archive from that image instead, with
   [`scripts/cut-shell-archive.sh`](../../scripts/cut-shell-archive.sh)
   `X.Y.Z <image digest> <empty directory>`, after verifying the image signature with
   the `cosign verify` line in the script. The cut is deterministic: on Debian 13 tools
   it reproduces the same bytes on any machine, so a second person can check the
   upload. Every consumer of the archive (this package, Dokploy, both YunoHost
   packages) then pins the same file.
2. **The pin.** After the Work release has published its images and
   `release-source-images.json`, and the archive is on `lolli.li`, run
   `node scripts/marketplace-cohort.ts --version X.Y.Z --shell-url https://lolli.li/lolly-web-X.Y.Z-ynh1.tar.gz`
   (add `--shell-file` to read a local copy instead of downloading it again). Review
   the diff.
3. **The checks.** Run `node --test tests/marketplace-*.test.ts`, let the Compose CI
   legs boot the package on amd64 and arm64, then dispatch **Helm qualification** with
   `screenshots=true` and replace the captures in [`assets/`](assets/README.md).
4. **The receipt.** Install the package on a provider VM, run the acceptance with a
   browser check as in [the reference qualification](QUALIFICATION.md), record it
   there, and record the publication in the channel table.

## The web app archive

`release.json` records the archive's size (`shell.archiveBytes`) and its expanded
size before the separate pack copy (`shell.expandedBytes`); the 1.1.1 archive is
724 MB and expands to 1.5 GB. Initialisation streams the archive to disk, verifies its
full checksum, refuses unsafe archive paths/links and installs a new content
directory. Allow at least 6 GB free for extraction, content copies and container
layers, plus PostgreSQL growth, backups and retained previous releases. Downloads
also include container layers. Models are fetched separately from `lolli.li`.

## Runtime and sign-in

The server runs as the image's unprivileged user with read-only mounts. A bounded
initialisation service writes the content volume and creates one P-256 catalogue
key per installation. That service runs as root with only `CHOWN` added to an
otherwise empty capability set; it needs no host mounts or Docker socket. To read
the catalogue key's public half for the web app, it takes ownership of the key file
and then returns the file to the server's user. The catalogue key survives content
upgrades. Session, link and credential keys live
in the operator's private environment, not in generated public package files.
The first boot writes configuration to the private `state` volume. Console and
operator changes survive restarts; subsequent starts move only installer-managed
content paths and preserve the other settings. Domain/identity environment values
are initial defaults, so change the stored configuration for an existing instance.
Back up `state`, `keys` and `.env` together with PostgreSQL.

Built-in email/password sign-in is the quick-start default. The host operator
issues a single-use setup link for the configured owner with
`node scripts/password-link.ts --email OWNER_EMAIL` in the running server.
No external IdP or mail service is needed. Keep that link private; it grants an
operator-authorized account and does not verify mailbox ownership. Organisation
OIDC remains available through `LOLLY_AUTH_MODE=oidc` and its issuer/client values.

Operator recipes live in [the ready-made package guide](../../docs/ready-made-package.md).
The [reference qualification](QUALIFICATION.md) records the tested targets, package
hashes, browser, reboot, upgrade and restore outcomes and remaining acceptance limits.
The [installation directory](../../docs/official-installations.md) records what
is published and qualified. A prepared blueprint is not an accepted marketplace
listing. Native arm64 has passed the CI container qualification only. Provider
targets on arm64, other cloud/edge targets, organisation identity and
installed-version upgrades still need their own acceptance.

## Chart publication

The HTTP repository URL is
`https://github.com/lolly-tools/lolly-work/releases/download/helm-index`.
It becomes usable after the first successful **Publish official Helm chart** run.
The workflow runs only from upstream `main` and requires its full reviewed source
SHA plus successful ordinary CI, Helm qualification and deployment qualification
on that exact main source. It packages the committed chart deterministically,
signs it through GitHub OIDC/Sigstore, and publishes immutable `chart-v*` assets.
The separate `helm-index` release contains the mutable discovery index. Neither
kind replaces the application's latest release. No GitHub Pages site or paid
marketplace account is needed.

The chart's version is the release version: `Chart.yaml` `version`, its
`appVersion` and Work's `package.json` version are one number, the Lolly release,
so people install one version of everything (`tests/helm-chart.test.ts` fails on
drift). A chart or template change therefore ships with the next release, and the
chart is published as part of each release, from that release's `main` commit.
Publication retries compare existing immutable assets, preserve old chart
versions in the index and refuse different bytes under an existing version. If
publication fails after the immutable release but before the index update, rerun
the same reviewed source; do not delete the release or replace its chart
archive. An incomplete already published release requires inspection before
repair.

After a project maintainer creates the real Artifact Hub organization/repository,
set the repository variables `ARTIFACTHUB_REPOSITORY_ID` and
`ARTIFACTHUB_OWNER_EMAIL` to the returned UUID and a maintainer account's verified
email. This email becomes public ownership metadata. The next chart publication
serves `artifacthub-repo.yml` beside `index.yaml`. A chart version update triggers
reindexing; changing only the index's `generated` time does not. Seek Verified
publisher first, then request Official status using Artifact Hub's online issue
form. No verification ID or badge is invented in this repository.

[Artifact Hub publication and ownership rules](https://artifacthub.io/docs/topics/repositories/)
and [Helm repository support](https://artifacthub.io/docs/topics/repositories/helm-charts/).

## Channel records

[`CHANNELS.md`](CHANNELS.md) shows which channel carries which release. It is
generated from the public [`channels.json`](channels.json) record. Record every
publication attempt there, failures included, with
`node scripts/marketplace-channels.ts record`. A channel's version changes only
through a published attempt, and a failed latest attempt shows the channel as
failed. The same page describes the maintenance review and the retirement and
notice procedure.

The private maintainer record holds what must stay out of this public repository:
for each channel, the project account, two maintainers with recovery access, the
actual publisher, offer and listing IDs, test receipts and review notes. Keep
credentials and recovery codes outside Git. The existing `lolly-tools` source and
image namespaces establish upstream provenance; access by two maintainers and
ownership in other catalogues must still be checked.

Listings describe free MPL-2.0 software, best-effort community support and the
operator's own hosting/identity costs. Do not enable charges, referrals, earned
credits, commissions or payout onboarding. Keep support, privacy and release
limits aligned with the official installation page. Use the neutral icon and the
[neutral fixture captures](assets/README.md) for screenshots; never use production
member data.
