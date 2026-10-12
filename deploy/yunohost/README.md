# Lolly Work for YunoHost

[YunoHost](https://yunohost.org) package for Lolly Work: a governed Lolly instance for a team, signed in with the host's own accounts. See [`doc/DESCRIPTION.md`](doc/DESCRIPTION.md) for what it is and [`doc/ADMIN.md`](doc/ADMIN.md) for how it is wired.

For a fresh `1.1.0~ynh3` beta installation, use the exact reviewed package:

```bash
sudo yunohost app install https://github.com/lolly-tools/lolly-work_ynh/tree/583cdc4af5322e683991a548428859b79084db2d
```

This directory is developed inside the Lolly Work repository at `deploy/yunohost/`, beside the Compose and Helm shapes, and mirrored to `lolly-tools/lolly-work_ynh` at release time. Fix things here, not in the mirror.

The deployment qualification workflow runs a pinned official package linter. It
blocks package/schema/script errors and reports catalog registration and working
status separately, since those belong to publishing the mirror. Repository
contracts also exercise SSO/LDAP role mapping and rendered configuration. A real
Linux `package_check` run establishes installation/upgrade/backup/restore results;
see the [cloud deployment guide](../../docs/cloud-deployment.md#yunohost-qualification).

The `1.1.0~ynh3` package is a beta test candidate. Its server is the matched Work
`464ac88d4498b00985dfbcdb47dd96655425f426` source, with Lolly
`0359d8106bccbd1da56b5552605199f0bf705472` and engine `1.259`. The neutral,
signed web shell loads models from `https://lolli.li`. Source CI and archive
checks passed. The actual [runtime run](https://github.com/lolly-tools/lolly-work/actions/runs/38284099878)
passed six checks on `amd64` Debian Bookworm with YunoHost 12.1.41.2: root
installation and reinstall, multiple instances, backup/restore, same-version
upgrade, URL change and package lint.

The seventh check failed while setting up the historical `0.2.0~ynh1` package,
before the application upgrade began. Upgrade from 0.2 and `arm64` installation
remain unqualified. This is a fresh-install beta, with no stable YunoHost tag or
catalog promotion. Keep a verified backup and complete a restore test before
upgrading an existing instance.

## Shape

- **One service, one database.** Node 24 (YunoHost's `nodejs` resource) runs `server/src/main.ts` behind the domain's nginx; PostgreSQL from the `database` resource; migrations at boot.
- **Two sources.** `main` is this repository at the release tag (no `node_modules`; the install runs `pnpm install --frozen-lockfile --prod`). `shell` is the Lolly web app build the open-source `lolly` YunoHost package installs, served at `/` and seeded as the instance pack.
- **YunoHost SSO, no passwords.** `proxyAuth` in the server (docs/identity.md, "Reverse-proxy sign-in"): SSOwat's `YNH_USER` / `YNH_USER_EMAIL` / `YNH_USER_FULLNAME` headers plus a shared secret nginx injects, and an anonymous read of the host's LDAP for groups and this app's role permissions.
- **Whole domain**, `multi_instance`; declared architectures `amd64` + `arm64`, with beta runtime checks completed on `amd64` only.

## Cutting a release

The release-pinned fields (`version`, both sources' `url` + `sha256`) are written by a script, never by hand. The web shell's pin is read from the open-source repository's package, so release Lolly first:

```bash
# in ../lolly: pnpm run release:yunohost --build   (pins lolly-web-<ver>.tar.gz)
git status --porcelain            # must be empty: the tarball is HEAD
pnpm run release:yunohost          # git archive HEAD, pin the manifest (main + shell)
# → ~/.cache/lolly-release/artifacts/lolly-work-<ver>.tar.gz
../lolly/shells/tauri-desktop/release/lolli.py put ~/.cache/lolly-release/artifacts/lolly-work-<ver>.tar.gz
```

`--publish` runs that upload when the `LOLLI_S3_*` keys are in the environment; `--oss <dir>` names the Lolly checkout, or `--shell-url` + `--shell-sha256` state the shell pin directly. The archive leaves out `packs/` (the demo pack carries proprietary SUSE brand assets), `tests/`, `plans/`, `deploy/` and `.github/`.

Then mirror this directory and tag it:

```bash
git clone git@github.com:lolly-tools/lolly-work_ynh.git /tmp/lolly-work_ynh
rsync -a --delete --exclude .git deploy/yunohost/ /tmp/lolly-work_ynh/
cd /tmp/lolly-work_ynh && git add -A && git commit -m "Lolly Work <ver>~ynh1" && git tag v<ver>-ynh1 && git push --follow-tags
```

Both tarballs must be live on lolli.li first: the manifest's checksums are verified at install.

For `1.1.0~ynh3`, generate the pins with the maintained producer on a clean
committed source tree:

```bash
node scripts/yunohost-release.ts --ynh-rev 3 \
  --shell-url https://lolli.li/lolly-web-1.1.0-ynh3.tar.gz \
  --shell-sha256 8bc8121a68e6fee6dda3902ed48d5e2669353bcfd101ca3822990235a2099376
```

Commit the generated manifest, recut the archive, and require the same archive
checksum before publishing. Deployment metadata and the manual workflow are
excluded from the installed archive; its server, engine and lockfile remain the
matched source above.

After publishing both archives and mirroring the generated package, select the
reviewed **full 40-character mirror commit**, rather than a moving branch. Run
the manual workflow in `lolly-tools/lolly-work` with that exact commit and version:

```bash
MIRROR_COMMIT='<reviewed full commit in lolly-tools/lolly-work_ynh>'
[[ "$MIRROR_COMMIT" =~ ^[0-9a-f]{40}$ ]]
gh workflow run yunohost-runtime.yml --repo lolly-tools/lolly-work --ref main \
  --field package_commit="$MIRROR_COMMIT" --field package_version='1.1.0~ynh3'
```

The workflow uses a fresh Ubuntu runner and the official Incus package checker.
It requires successful root and multiple-instance installation, upgrade,
backup/restore and URL-change results for the selected package. `tests.toml`
also attempts upgrading from mirror commit
`db60f651fbeb561e4b330a1dd44bd4aaf463e635` (`0.2.0~ynh1`). Its original logs and
checker revisions are uploaded even on failure; preserve those results when
reporting candidate status.

## Layout

```
manifest.toml            package metadata, install questions, resources (packaging format 2)
config_panel.toml        access mode, guest links, telemetry, hook rendering, instance name
scripts/                 install, upgrade, remove, backup, restore, change_url, config, _common.sh
conf/instance.json       the server configuration template (settings → placeholders)
conf/.env                the service environment: secrets, database URL, port
conf/systemd.service     the hardened unit
conf/nginx.conf          the domain location file; proxy.inc and shell-headers.inc are its includes
doc/                     DESCRIPTION, PRE_INSTALL, POST_INSTALL and ADMIN pages shown in the YunoHost admin
tests.toml               package_check configuration
```
