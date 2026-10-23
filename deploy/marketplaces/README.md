# Official distribution maintenance

`release.json` selects an already published Work/Lolly cohort. Its server digest
and source come from the linked release's `release-source-images.json`; the shell
URL/checksum come from the maintained YunoHost release manifest. The neutral icon
is copied from that checksum-verified web archive. Do not substitute an arbitrary
shell build, a private brand pack or a mutable image tag.

The source catalogue public key and sequence are pinned from the checksum-verified
shell (its web-boot public JWK and signed catalogue envelope). They verify the
mounted release. The separate per-installation private key signs caller-specific
catalogue projections; it cannot verify the publisher's original envelope. Keep
both identities when updating a cohort and test admitted catalogue access/export.

Run `node scripts/marketplace-packages.ts` after reviewing a cohort or adapter
change. This generates the VM Compose package and Dokploy blueprint from the same
runtime scripts. `--check` refuses drift in CI. These files consume public images;
they do not create another server build or registry namespace. After a cohort
change, also run `node scripts/marketplace-channels.ts` so the
[channel table](CHANNELS.md) shows which channels are now behind.

The neutral archive is 724,143,600 bytes and expands to 1,480,550,877 bytes before
the separate pack copy. Initialisation streams the archive to disk, verifies its
full checksum, refuses unsafe archive paths/links and installs a new content
directory. Allow at least 6 GB free for extraction, content copies and container
layers, plus PostgreSQL growth, backups and retained previous releases. Downloads
also include container layers. Models are fetched separately from `lolli.li`.

The server runs as the image's unprivileged user with read-only mounts. A bounded
initialisation service writes the content volume and creates one P-256 catalogue
key per installation. That service runs as root with only `CHOWN` added to an
otherwise empty capability set; it needs no host mounts or Docker socket. The
catalogue key survives content upgrades. Session, link and credential keys live
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
The [reference qualification](QUALIFICATION.md) records the tested UpCloud target,
package hashes, reboot/restore outcomes and remaining acceptance limits.
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

Each chart/template change requires a new chart version. Publication retries
compare existing immutable assets, preserve old chart versions in the index and
refuse different bytes under an existing version. If publication fails after the
immutable release but before the index update, rerun the same reviewed source;
do not delete the release or replace its chart archive. An incomplete already
published release requires inspection before repair. A later source needs a new
chart version even if its application version stays the same.

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
