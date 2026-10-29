#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Acceptance for a Lolly appliance's updates (k3s or podman profile).

Run after accept.py's first pass (it signs the owner in with the password that
pass kept in STATE). Drives the machine over SSH and HTTPS and prints one PASS
or FAIL line per check:

  app       an application update between two real releases, verified with
            cosign against the release workflow's identity, and its way back;
            a forced failure that reverts; a refused unsigned or mislabelled
            release; a no-migration update and its plain rollback
  host      a host update through transactional-update that health-checker
            keeps, and a host update that breaks Lolly Work, which
            health-checker rolls back

  deploy/appliance/test/accept-updates.py --key KEY --state STATE --phase app --from 1.1.2 --to 1.1.3 \\
      --postgres-alt docker.io/library/postgres:17@sha256:...
  deploy/appliance/test/accept-updates.py --key KEY --state STATE --phase host

Never prints a password or a link.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from accept import FAILED, Guest, Sampler, Web, ok, render, wait_ready  # noqa: E402

SIGNED_AT_TAG = {
    # Lolly Work release images and the identity their signatures name
    # (from each release's release-source-images.json and its certificate).
    "1.1.2": "ghcr.io/lolly-tools/lolly-work-server:1.1.2@sha256:68ef78a1605c5530f6c2939e584cb8875fdcd5a8bdb0112b35c0515b2ddc0504",
    "1.1.3": "ghcr.io/lolly-tools/lolly-work-server:1.1.3@sha256:9a9b03cc311f343d3e75c1b47e3bc13c72fe269ac69b10d2d56532c20d9eb363",
}
# Releases whose Helm chart is published (release chart-v<version>, signed by
# publish-helm.yml). A k3s appliance verifies such a chart instead of keeping
# the installed one; 1.1.3 is the first.
CHART_PUBLISHED = {"1.1.3"}
SIGNED_ON_MAIN = {
    # 1.1.1's server image was signed by a dispatch from main, not at its tag.
    "1.1.1": "ghcr.io/lolly-tools/lolly-work-server:1.1.1@sha256:5fa8b86328bf453635791fc104f4cf6179fc3d3c02a1516da4dea07bd6ae1e55",
}


def next_patch(version: str) -> str:
    """A release number the image is not signed as, for the mislabelled-release refusal."""
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def sh(guest: Guest, command: str, timeout: int = 3600):
    started = time.time()
    result = guest.run(command, timeout=timeout)
    return result, time.time() - started


def schema_rows(guest: Guest, profile: str) -> int:
    psql = ("podman exec lolly-postgres" if profile == "podman" else "kubectl -n lolly exec lolly-postgres-0 -c postgres --")
    out = guest.run(f"{psql} psql -U lolly -d lollywork -tAc 'select count(*) from schema_migrations'").stdout.strip()
    return int(out) if out.isdigit() else -1


def running_server(guest: Guest, profile: str) -> str:
    if profile == "podman":
        return guest.run("podman inspect --format '{{.ImageName}}' lolly-work").stdout.strip()
    return guest.run("kubectl -n lolly get deploy lolly-work -o jsonpath='{.spec.template.spec.containers[0].image}'").stdout.strip()


def put_json(guest: Guest, path: str, data: dict) -> None:
    guest.run(f"cat > {path} <<'EOF'\n{json.dumps(data, indent=2)}\nEOF")


def sign_in(args, base: str) -> Web:
    state = json.load(open(args.state))
    web = Web(args.https, base)
    web.call("POST", "/api/auth/password/login", {"email": state["owner"], "password": state["password"]})
    return web


def app_phase(args, guest: Guest, profile: str, base: str) -> None:
    pin = lambda ref: re.sub(r":[^:@/]+@", "@", ref)  # noqa: E731
    chart = profile == "k3s" and args.to_version in CHART_PUBLISHED
    keep_chart = " --keep-chart" if profile == "k3s" and not chart else ""
    status = guest.run("lolly-update status").stdout
    ok(f"lolly-update status starts at {args.from_version}", f"Lolly Work:     {args.from_version}" in status, status.splitlines()[1] if status else "")
    rows_before = schema_rows(guest, profile)
    print(f"INFO schema_migrations rows at {args.from_version}: {rows_before}", flush=True)

    # The channel: GHCR's version tags, each release verified against its tag.
    result, _ = sh(guest, "lolly-update check")
    if profile == "podman":
        ok(f"the channel offers {args.to_version}, verified against the release workflow at its tag",
           result.returncode == 0 and f"Lolly Work {args.to_version} is available (verified)" in result.stdout
           and f"release.yml@refs/tags/v{args.to_version}" in result.stdout, (result.stdout + result.stderr).strip().splitlines()[-1])
    elif chart:
        ok(f"the channel offers {args.to_version} with its published chart, both verified (release.yml at the tag, publish-helm.yml on main)",
           result.returncode == 0 and f"Lolly Work {args.to_version} is available (verified)" in result.stdout
           and f"release.yml@refs/tags/v{args.to_version}" in result.stdout
           and f"Verified chart lolly-work-{args.to_version}.tgz" in result.stdout and "publish-helm.yml@refs/heads/main" in result.stdout,
           (result.stdout + result.stderr).strip().splitlines()[-1][:200])
    else:
        ok(f"the channel verifies {args.to_version}, and k3s waits for its signed chart, which is not published",
           f"release.yml@refs/tags/v{args.to_version}" in result.stdout and f"chart-v{args.to_version}" in result.stderr,
           (result.stderr.strip().splitlines() or [""])[-1][:160])

    # Refusals: a digest labelled as another release, and a release signed from main.
    definition = json.loads(guest.run("cat /usr/share/lolly-appliance/release-definition.json").stdout)
    other = next_patch(args.to_version)
    mislabelled = {**definition, "version": other, "serverImage": SIGNED_AT_TAG[args.to_version]}
    put_json(guest, "/root/def-mislabelled.json", mislabelled)
    result, _ = sh(guest, f"lolly-update apply --definition /root/def-mislabelled.json{keep_chart}")
    ok("a release image presented as another version is refused", result.returncode != 0 and f"is not signed as Lolly Work {other}" in result.stderr,
       (result.stderr.strip().splitlines() or [""])[-1][:200])
    main_signed = {**definition, "version": "1.1.1", "serverImage": SIGNED_ON_MAIN["1.1.1"]}
    put_json(guest, "/root/def-main-signed.json", main_signed)
    result, _ = sh(guest, f"lolly-update apply --definition /root/def-main-signed.json{keep_chart}")
    ok("an image signed outside its release tag is refused (1.1.1 was signed from main)",
       result.returncode != 0 and "is not signed as Lolly Work 1.1.1" in result.stderr, (result.stderr.strip().splitlines() or [""])[-1][:200])
    ok("the refusals changed nothing", pin(running_server(guest, profile)) == pin(definition["serverImage"]) and schema_rows(guest, profile) == rows_before)

    # A render before the update, to find again after the restore.
    web = sign_in(args, base)
    passed, line = render(web, "qr-code", "svg", {"url": "https://lolly.work/before"}, f"updates-before-{int(time.time())}")
    ok(f"render on {args.from_version} before the update: " + line, passed)

    # The migrating update, from the channel.
    sampler = Sampler(guest, "lolly-accept-memory")
    result, seconds = sh(guest, f"lolly-update apply --version {args.to_version}{keep_chart}")
    peak = sampler.stop()
    text = result.stdout + result.stderr
    print("\n".join("  | " + line for line in text.strip().splitlines()), flush=True)
    migrations = re.search(r"runs (\d+) database migrations?", text)
    ok(f"the update {args.from_version} -> {args.to_version} says it migrates, and takes a backup first",
       bool(migrations) and "Taking a backup first" in text and "Backup taken:" in text
       and text.index("Backup taken:") < text.index("is ready"), migrations.group(0) if migrations else "")
    ok(f"Lolly Work {args.to_version} is ready after the update", result.returncode == 0 and f"Lolly Work {args.to_version} is ready" in text,
       f"{seconds:.0f} s, peak memory {peak} MiB")
    print(f"MEASURE {json.dumps({'update_seconds': round(seconds), 'update_peak_mib': peak})}", flush=True)
    if result.returncode != 0:
        print("RESULT FAIL (the update did not apply; the rest of this phase depends on it)")
        return
    rows_after = schema_rows(guest, profile)
    if chart:
        installed_chart = json.loads(guest.run("cat /var/lib/lolly/update/state.json").stdout)["installed"].get("chart") or {}
        ok(f"the published chart {args.to_version} is installed", installed_chart.get("version") == args.to_version,
           f"chart {installed_chart.get('version')} sha256 {str(installed_chart.get('sha256'))[:16]}...")
    ok("the new release runs and its migrations are applied", pin(running_server(guest, profile)) == pin(SIGNED_AT_TAG[args.to_version])
       and migrations and rows_after == rows_before + int(migrations.group(1)), f"{rows_before} -> {rows_after} rows")
    web = sign_in(args, base)
    passed, line = render(web, "qr-code", "svg", {"url": "https://lolly.work/after"}, f"updates-after-{int(time.time())}")
    ok(f"the owner signs in and renders on {args.to_version}: " + line, passed)

    # No plain rollback after a migration; the restore instead.
    result, _ = sh(guest, "lolly-update rollback")
    ok("a plain rollback is refused after a migrating update, pointing at the restore",
       result.returncode != 0 and "rollback --restore" in result.stderr and "migrations" in result.stderr)
    result, seconds = sh(guest, "lolly-update rollback --restore")
    print("\n".join("  | " + line for line in (result.stdout + result.stderr).strip().splitlines()), flush=True)
    ok(f"rollback --restore returns to {args.from_version} with the database as it was", result.returncode == 0
       and pin(running_server(guest, profile)) == pin(definition["serverImage"]) and schema_rows(guest, profile) == rows_before,
       f"{seconds:.0f} s, {schema_rows(guest, profile)} rows")
    web = sign_in(args, base)
    status, _, _ = web.call("GET", "/api/auth/session")
    ok(f"the owner signs in again on {args.from_version} after the restore", status == 200)
    passed, line = render(web, "qr-code", "png", {"url": "https://lolly.work/restored"}, f"updates-restored-{int(time.time())}")
    ok(f"render on {args.from_version} after the restore: " + line, passed)

    # A forced failure: a one-second deadline cannot be met, so the update reverts.
    result, seconds = sh(guest, f"lolly-update apply --version {args.to_version}{keep_chart} --timeout 1")
    text = result.stdout + result.stderr
    print("\n".join("  | " + line for line in text.strip().splitlines()), flush=True)
    ok("an update that does not become ready in time reverts, restoring its backup", result.returncode != 0
       and "Restoring the backup taken before the update" in text and f"Reverted: Lolly Work {args.from_version} is ready again" in text
       and pin(running_server(guest, profile)) == pin(definition["serverImage"]) and schema_rows(guest, profile) == rows_before,
       f"{seconds:.0f} s")
    status = guest.run("lolly-update status").stdout
    ok("the failed attempt is recorded and not retried by the timer", "reverted" in status)

    # Back to the newer release, then a no-migration update and its plain rollback.
    result, _ = sh(guest, f"lolly-update apply --version {args.to_version}{keep_chart}")
    ok(f"the update to {args.to_version} applies again", result.returncode == 0)
    installed = json.loads(guest.run("cat /var/lib/lolly/update/state.json").stdout)["installed"]
    nomigration = {**{k: installed[k] for k in ("schemaVersion", "version", "serverImage", "postgresImage", "caddyImage")},
                   "postgresImage": args.postgres_alt}
    put_json(guest, "/root/def-postgres.json", nomigration)
    rows = schema_rows(guest, profile)
    result, seconds = sh(guest, f"lolly-update apply --definition /root/def-postgres.json{keep_chart}")
    text = result.stdout + result.stderr
    print("\n".join("  | " + line for line in text.strip().splitlines()), flush=True)
    ok("an update with no migration (a newer PostgreSQL 17 image) takes no backup and keeps the plain rollback",
       result.returncode == 0 and "runs no database migration" in text and "Taking a backup" not in text and "lolly-update rollback" in text,
       f"{seconds:.0f} s")
    status = guest.run("lolly-update status").stdout
    ok("lolly-update status offers the plain rollback", re.search(r"Rollback:\s+to \S+: lolly-update rollback$", status, re.M) is not None)
    result, seconds = sh(guest, "lolly-update rollback")
    print("\n".join("  | " + line for line in (result.stdout + result.stderr).strip().splitlines()), flush=True)
    pg = guest.run("podman inspect --format '{{.ImageName}}' lolly-postgres" if profile == "podman" else
                   "kubectl -n lolly get statefulset lolly-postgres -o jsonpath='{.spec.template.spec.containers[0].image}'").stdout.strip()
    ok("the plain rollback returns to the previous PostgreSQL image with the data untouched",
       result.returncode == 0 and pin(pg) == pin(installed["postgresImage"]) and schema_rows(guest, profile) == rows, f"{seconds:.0f} s, {pg[-20:]}")
    web = sign_in(args, base)
    passed, line = render(web, "qr-code", "svg", {"url": "https://lolly.work/final"}, f"updates-final-{int(time.time())}")
    ok("render after the plain rollback: " + line, passed)


def host_phase(args, guest: Guest, profile: str, base: str) -> None:
    web = Web(args.https, base)
    default = lambda: guest.run("btrfs subvolume get-default / | awk '{print $2}'").stdout.strip()  # noqa: E731
    boots = lambda: len(guest.run("journalctl --list-boots --no-pager 2>/dev/null").stdout.strip().splitlines()) - 1  # noqa: E731
    start_default, start_boots = default(), boots()
    print(f"INFO default snapshot subvolume {start_default}, {start_boots + 1} boots so far", flush=True)

    # A host update health-checker keeps.
    result, seconds = sh(guest, "transactional-update --non-interactive pkg install jq 2>&1 | tail -3", timeout=1800)
    print("\n".join("  | " + line for line in result.stdout.strip().splitlines()), flush=True)
    after_update = default()
    ok("transactional-update prepares a new host snapshot", after_update != start_default, f"{start_default} -> {after_update}, {seconds:.0f} s")
    guest.run("systemctl reboot")
    time.sleep(20)
    ok("the machine comes back after the reboot", guest.wait(900))
    waited = wait_ready(web, 1200)
    # The plugin polls every 5 s, so health-checker finishes a little after Work is ready.
    log = ""
    for _ in range(60):
        log = guest.run("journalctl -b -u health-checker --no-pager -o cat").stdout
        if "Health check passed" in log or "Health check failed" in log:
            break
        time.sleep(5)
    judged = re.search(r"Lolly Work is ready on the new snapshot after (\d+) s", log)
    ok("health-checker's Lolly plugin judges the new snapshot and passes it", bool(judged) and "Health check passed" in log,
       f"ready {judged.group(1)} s into the plugin's wait" if judged else "not judged")
    ok("the new host snapshot stays the default", default() == after_update and guest.run("rpm -q jq").returncode == 0)

    # A host update that breaks Lolly Work: health-checker rolls the host back.
    unit = "k3s.service" if profile == "k3s" else "lolly-work.service"
    guest.run("touch /etc/lolly/appliance.conf; grep -q '^LOLLY_HEALTH_TIMEOUT=' /etc/lolly/appliance.conf || echo 'LOLLY_HEALTH_TIMEOUT=240' >> /etc/lolly/appliance.conf")
    good = default()
    result, _ = sh(guest, f"transactional-update --non-interactive run systemctl mask {unit} 2>&1 | tail -2", timeout=1800)
    broken = default()
    ok(f"a host snapshot with {unit} masked is prepared (a simulated bad host update)", broken != good, f"{good} -> {broken}")
    before = boots()
    started = time.time()
    guest.run("systemctl reboot")
    time.sleep(30)
    # The machine boots the broken snapshot, health-checker fails it after the
    # timeout, rolls back and reboots again into the last good snapshot.
    deadline = time.time() + 2400
    rolled = False
    while time.time() < deadline:
        if guest.wait(60) and boots() >= before + 2 and default() == good:
            rolled = True
            break
        time.sleep(15)
    ok("health-checker rolled the host back to the last good snapshot and rebooted", rolled, f"{time.time() - started:.0f} s")
    previous = guest.run("journalctl -b -1 -u health-checker --no-pager -o cat").stdout
    ok("the broken boot's log shows the Lolly plugin failing and the rollback", "failing the health check so the host rolls back" in previous
       and "do a rollback" in previous, " / ".join(line for line in previous.splitlines() if "rollback" in line.lower())[:200])
    waited = wait_ready(web, 1200)
    ok(f"Lolly Work is ready again on the restored snapshot, {unit} not masked", waited is not None
       and guest.run(f"systemctl is-enabled {unit} 2>&1").stdout.strip() != "masked", f"{waited:.0f} s" if waited else "")
    guest.run("sed -i '/^LOLLY_HEALTH_TIMEOUT=/d' /etc/lolly/appliance.conf")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ssh-host", default="127.0.0.1")
    parser.add_argument("--ssh-port", type=int, default=2222)
    parser.add_argument("--key", required=True)
    parser.add_argument("--https", default="127.0.0.1:8443")
    parser.add_argument("--state", required=True)
    parser.add_argument("--phase", choices=("app", "host"), required=True)
    parser.add_argument("--from", dest="from_version", default="1.1.2")
    parser.add_argument("--to", dest="to_version", default="1.1.3")
    parser.add_argument("--postgres-alt", default="docker.io/library/postgres:17@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe")
    args = parser.parse_args(argv)
    guest = Guest(args.ssh_port, args.key, args.ssh_host)
    ok("SSH answers", guest.wait(600))
    profile = json.loads(guest.run("cat /usr/share/lolly-appliance/release.json").stdout or "{}").get("profile", "k3s")
    base = re.search(r"Address:\s+(https://\S+?)/?$", guest.run("lolly-appliance status").stdout, re.M).group(1)
    print(f"INFO profile {profile}, {base}", flush=True)
    if args.phase == "app":
        app_phase(args, guest, profile, base)
    else:
        host_phase(args, guest, profile, base)
    print(f"RESULT {'PASS' if not FAILED else 'FAIL'} ({len(FAILED)} failed)")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
