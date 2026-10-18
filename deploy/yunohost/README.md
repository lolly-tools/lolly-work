# Lolly Work for YunoHost

[YunoHost](https://yunohost.org) package for Lolly Work: a governed Lolly instance for a team, signed in with the host's own accounts. See [`doc/DESCRIPTION.md`](doc/DESCRIPTION.md) for what it is and [`doc/ADMIN.md`](doc/ADMIN.md) for how it is wired.

For a fresh `1.1.1~ynh1` beta installation, use the tagged package:

```bash
sudo yunohost app install https://github.com/lolly-tools/lolly-work_ynh/tree/v1.1.1-ynh1
```

This directory is developed inside the Lolly Work repository at `deploy/yunohost/`, beside the Compose and Helm shapes, and mirrored to `lolly-tools/lolly-work_ynh` at release time. Fix things here, not in the mirror.

The deployment qualification workflow runs a pinned official package linter. It
blocks package/schema/script errors and reports catalog registration and working
status separately, since those belong to publishing the mirror. Repository
contracts also exercise SSO/LDAP role mapping and rendered configuration. A real
Linux `package_check` run establishes installation/upgrade/backup/restore results;
see the [cloud deployment guide](../../docs/cloud-deployment.md#yunohost-qualification).

The `1.1.1~ynh1` package is a beta test candidate. Its server is Work 1.1.1,
archived from `c2036a85c53c76bd8b7917a05aef41268103e2b3` and released as tag
`v1.1.1`, with Lolly `26cf05324f46dc4cacd65d12d6f454ada181fb5e` and engine `1.261`.
The neutral, signed web shell loads models from `https://lolli.li`. Source CI and
archive checks passed, and all seven official runtime checks passed on `amd64`
(see [Runtime results](#runtime-results)). No `arm64` installation has been run.
The package keeps its beta label and there is no catalog promotion. Keep a
verified backup and complete a restore test before upgrading an existing instance.

## Runtime results

### `1.1.1~ynh1` on amd64

[Run 38805424968](https://github.com/lolly-tools/lolly-work/actions/runs/38805424968)
on 2026-10-15 checked mirror commit `399f670e571148498d217560b3f96acbf2e8f7fa`,
which is the `v1.1.1-ynh1` tag. It ran on `amd64` Debian Bookworm with YunoHost
12.1.41.2 (stable), the official `package_check` at
`f7d32cadac3cfced282decede024707fba9e6ec6` and the package linter at
`c1a7491aab2c22d28b220330513e9555a8da3a1d`. All seven checks passed:

| Check | Result |
|---|---|
| Package linter | Passed, with 2 warnings |
| Installation at the domain root | Passed |
| Multiple-instance installation | Passed |
| Backup and restore | Passed |
| Upgrade from the same version | Passed |
| Upgrade from `1.1.0~ynh3` (mirror commit `583cdc4a`) | Passed |
| URL change | Passed |

The two linter warnings are that this README was not made by YunoHost's README
generator and that the app has no category in YunoHost's catalog.

The run is still marked as failed. Its last step also requires `package_check`
levels 1 to 5, and the linter's catalog checks count against two of them. The app
is not in YunoHost's catalog, which the linter reports as critical, so level 1
fails. It is not flagged as working there, which the linter reports as an error,
so level 5 fails. The reported global level is therefore 0. Both findings are
about catalog publication, which has not happened. No installation, upgrade,
recovery or URL-change check failed. The run uploaded its results file and
original logs as an artifact, kept for 14 days.

### arm64

Not yet run. The runtime workflow is fixed to `amd64`, and YunoHost's test image
index, as fetched in that run, lists Bookworm images for `amd64` only, so this
workflow cannot produce an `arm64` result as it stands. The neutral Compose
package passes on a native arm64 runner (see its
[qualification record](https://github.com/lolly-tools/lolly-work/blob/main/deploy/marketplaces/QUALIFICATION.md#native-arm64-in-ci)),
but that job does not install this package, so it is not a YunoHost result.

### Earlier candidate

The previous `1.1.0~ynh3` candidate passed six runtime checks on `amd64` Debian
Bookworm in [run 38284099878](https://github.com/lolly-tools/lolly-work/actions/runs/38284099878).
Its seventh check failed while installing the historical `0.2.0~ynh1` package,
which is why the upgrade baseline moved to `1.1.0~ynh3`.

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

For `1.1.1~ynh1`, generate the pins with the maintained producer on a clean
committed source tree:

```bash
node scripts/yunohost-release.ts --ynh-rev 1 \
  --shell-url https://lolli.li/lolly-web-1.1.1-ynh1.tar.gz \
  --shell-sha256 bc78012aa407983ecc818e63be98ae1b45ed7db1dcad3f4c8d4ffe0c371116c1
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
  --field package_commit="$MIRROR_COMMIT" --field package_version='1.1.1~ynh1'
```

The workflow uses a fresh Ubuntu runner and the official Incus package checker.
It requires successful root and multiple-instance installation, upgrade,
backup/restore and URL-change results for the selected package. `tests.toml`
also upgrades from mirror commit
`583cdc4af5322e683991a548428859b79084db2d` (`1.1.0~ynh3`). Its last step also
requires `package_check` levels 1 to 5. While the package is outside YunoHost's
catalog, the linter's catalog findings keep levels 1 and 5 from passing, so the
run is marked as failed even when every check passes. Its original logs and
checker revisions are uploaded even on failure; preserve those results and give
each check's result when reporting candidate status.

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
