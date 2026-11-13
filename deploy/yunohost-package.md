# Maintaining the Lolly Work YunoHost package

`deploy/yunohost/` is the YunoHost package for Lolly Work. It is developed here,
beside the Compose and Helm shapes, and mirrored to
[`lolly-tools/lolly-work_ynh`](https://github.com/lolly-tools/lolly-work_ynh) at release
time. Fix things here, not in the mirror. From Lolly 1.2.0 it is the only YunoHost
package the project publishes; the static `lolly_ynh` package is discontinued.

The package's `README.md` is the output of YunoHost's
[README generator](https://github.com/YunoHost/apps_tools/tree/main/readme_generator).
Do not edit it by hand: change `manifest.toml` or `doc/`, then regenerate it (see
[Regenerate the README](#regenerate-the-readme)). These notes are kept out of the package
because everything in `deploy/yunohost/` is mirrored.

## Shape

- **One service, one database.** Node 24 (YunoHost's `nodejs` resource) runs `server/src/main.ts` behind the domain's nginx; PostgreSQL from the `database` resource; migrations at boot.
- **Two sources.** `main` is this repository at the release tag (no `node_modules`; the install runs `pnpm install --frozen-lockfile --prod`). `shell` is the neutral Lolly web app build, served at `/` and seeded as the instance pack.
- **YunoHost SSO, no passwords.** `proxyAuth` in the server (docs/identity.md, "Reverse-proxy sign-in"): SSOwat's `YNH_USER` / `YNH_USER_EMAIL` / `YNH_USER_FULLNAME` headers plus a shared secret nginx injects, and an anonymous read of the host's LDAP for groups and this app's role permissions.
- **Nextcloud, optional.** Install and upgrade detect a Nextcloud app and prefill its address; the config panel's Nextcloud section then writes a config-managed WebDAV catalog source and delivery destination into `instance.json` (`_common.sh`, `lollywork_nextcloud_vars`).
- **No edge cache.** Everything cacheable by URL sits behind SSOwat and carries the portal cookie, and the routes visitors reach are signed or private. A public-class cache needs the content-addressed `/e/` route (CDN delivery plan, E3), which does not exist yet.
- **Whole domain**, `multi_instance`; declared architectures `amd64` + `arm64`, with runtime checks completed on `amd64` only.

## Layout

```
manifest.toml            package metadata, install questions, resources (packaging format 2)
config_panel.toml        access mode, guest links, telemetry, hook rendering, instance name, Nextcloud
scripts/                 install, upgrade, remove, backup, restore, change_url, config, _common.sh
conf/instance.json       the server configuration template (settings -> placeholders)
conf/.env                the service environment: secrets, database URL, port
conf/systemd.service     the hardened unit
conf/nginx.conf          the domain location file; proxy.inc and shell-headers.inc are its includes
doc/                     DESCRIPTION, PRE_INSTALL, POST_INSTALL and ADMIN pages, and screenshots/
tests.toml               package_check configuration
README.md                generated; do not edit
```

`scripts/install` and `scripts/upgrade` call `ynh_config_add_nginx` at the top level.
YunoHost's `package_check` decides that an app is a web app with
`grep '^ynh_config_add_nginx' scripts/install`; without that line it skips the URL checks
and the change-URL test. `tests/yunohost-package.test.ts` keeps it that way.

## The catalogue publishes `main`

Once the app is in YunoHost's catalogue, every commit on the package repository's
`main` branch is published to every YunoHost server within hours. Push a candidate to
the mirror's `testing` branch, qualify that exact commit, then fast-forward `main` to
it and tag it. Never push an unqualified tree to `main`.

## Cutting a revision

The release-pinned fields (`version`, both sources' `url` + `sha256`) are written by
`scripts/yunohost-release.ts`, never by hand, when a new Work version is archived:

```bash
git status --porcelain            # must be empty: the tarball is HEAD
node scripts/yunohost-release.ts --ynh-rev 1 \
  --shell-url https://lolli.li/lolly-web-<ver>-ynh1.tar.gz --shell-sha256 <web archive sha256>
# -> ~/.cache/lolly-release/artifacts/lolly-work-<ver>-ynh1.tar.gz
../lolly/shells/tauri-desktop/release/lolli.py put ~/.cache/lolly-release/artifacts/lolly-work-<ver>-ynh1.tar.gz
```

The archive leaves out `packs/` (the instance seeds its pack from the web shell),
`tests/`, `plans/`, `deploy/` and `.github/`. Both archives must be live on lolli.li
first: the manifest's checksums are verified at install.

A packaging-only revision (`~ynh2`, `~ynh3`, ...) keeps the server bytes: upload the
same Work archive under the new revision's name, change `version` and the `main`
source's `url` to that name, and keep its `sha256`. Do not recut the archive from a
later `main`; its server would no longer be the released one.

Every revision also needs the README regenerated, because it shows the version.

## Regenerate the README

```bash
git clone https://github.com/YunoHost/apps_tools /tmp/apps_tools
python3 -m venv /tmp/readme-venv && /tmp/readme-venv/bin/pip install jinja2 toml
/tmp/readme-venv/bin/python /tmp/apps_tools/readme_generator/make_readme.py deploy/yunohost
```

Once the package repository is in the YunoHost-Apps organisation, `yunohost-bot` also
regenerates it on every push there; a tree regenerated here makes that a no-op.

## Mirror and tag

```bash
git clone git@github.com:lolly-tools/lolly-work_ynh.git /tmp/lolly-work_ynh
cd /tmp/lolly-work_ynh && git switch -c testing origin/main
rsync -a --delete --exclude .git <lolly-work>/deploy/yunohost/ ./
git add -A && git commit -m "Lolly Work <ver>~ynh<n>" && git push origin testing
```

Before the `rsync`, check the package repository for commits that are not in
`lolly-work` (for example YunoHost's own bots and packagers, once it is in the
YunoHost-Apps organisation) and bring them here first; `--delete` would drop them.

## Qualify

Run the hosted workflow on the exact pushed commit:

```bash
MIRROR_COMMIT='<full 40-character commit on the testing branch>'
[[ "$MIRROR_COMMIT" =~ ^[0-9a-f]{40}$ ]]
gh workflow run yunohost-runtime.yml --repo lolly-tools/lolly-work --ref main \
  --field package_commit="$MIRROR_COMMIT" --field package_version='<ver>~ynh<n>' \
  --field package_repository='lolly-tools/lolly-work_ynh'
```

It runs YunoHost's unmodified `package_check` (Incus, amd64, Debian Bookworm, YunoHost
stable) on a fresh Ubuntu runner: the linter, installation at the domain root and as a
second instance, backup and restore, upgrade from the same version and from every
commit `tests.toml` names, and the URL change. It requires every test to pass and
levels 2 to 4. Levels 1 and 5 may fail only because the app is not yet in YunoHost's
catalogue (the linter's `AppCatalog.is_in_catalog` and `AppCatalog.state_is_working`);
any other linter error fails the run. The results, the original logs and
`qualification.actual.json` are uploaded as an artifact for 14 days. Copy them into
the release record.

YunoHost 13 (Debian Trixie) and arm64 are not covered by this workflow. Use a
disposable amd64 VM for YunoHost 13 (`lolly-releases/<ver>/ynh-catalogue-runbook.md`).

When it passes, fast-forward `main` to the qualified commit and tag it `v<ver>-ynh<n>`.

## Runtime results

| Package | Run | Result |
|---|---|---|
| `1.1.1~ynh1` (mirror `399f670e`) | [38805424968](https://github.com/lolly-tools/lolly-work/actions/runs/38805424968), YunoHost 12.1.41.2 | All seven checks passed; marked failed only by the catalogue findings in levels 1 and 5 |
| `1.1.0~ynh3` | [38284099878](https://github.com/lolly-tools/lolly-work/actions/runs/38284099878) | Six checks passed; the upgrade from `0.2.0~ynh1` failed, so the baseline moved to `1.1.0~ynh3` |
| `1.1.3~ynh2` | Disposable amd64 VM, YunoHost 12.1.41.2 and 13.0.7.1 | All planned tests passed. The checker planned an install without URL checks and no URL change, because the scripts then called `ynh_config_add_nginx` through a wrapper |
