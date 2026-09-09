# Lolly Work for YunoHost

[YunoHost](https://yunohost.org) package for Lolly Work: a governed Lolly instance for a team, signed in with the host's own accounts. See [`doc/DESCRIPTION.md`](doc/DESCRIPTION.md) for what it is and [`doc/ADMIN.md`](doc/ADMIN.md) for how it is wired.

```bash
sudo yunohost app install https://github.com/lolly-tools/lolly-work_ynh
```

This directory is developed inside the Lolly Work repository at `deploy/yunohost/`, beside the Compose and Helm shapes, and mirrored to `lolly-tools/lolly-work_ynh` at release time. Fix things here, not in the mirror.

## Shape

- **One service, one database.** Node 24 (YunoHost's `nodejs` resource) runs `server/src/main.ts` behind the domain's nginx; PostgreSQL from the `database` resource; migrations at boot.
- **Two sources.** `main` is this repository at the release tag (no `node_modules`; the install runs `pnpm install --frozen-lockfile --prod`). `shell` is the Lolly web app build the open-source `lolly` YunoHost package installs, served at `/` and seeded as the instance pack.
- **YunoHost SSO, no passwords.** `proxyAuth` in the server (docs/identity.md, "Reverse-proxy sign-in"): SSOwat's `YNH_USER` / `YNH_USER_EMAIL` / `YNH_USER_FULLNAME` headers plus a shared secret nginx injects, and an anonymous read of the host's LDAP for groups and this app's role permissions.
- **Whole domain**, `multi_instance`, `amd64` + `arm64`.

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
