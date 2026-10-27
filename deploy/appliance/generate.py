#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Generate the appliance's runtime definition from one release definition.

Reads deploy/marketplaces/release.json (the digest pins the ready-made package
uses) and deploy/appliance/work-config.json (Lolly Work's settings, the same
for both profiles) and writes an overlay tree that the KIWI build copies into
the image. --profile picks the runtime:

k3s (default): the files K3s applies from its manifests directory
  var/lib/rancher/k3s/server/manifests/00-lolly-namespace.yaml
  var/lib/rancher/k3s/server/manifests/lolly-postgres.yaml
  var/lib/rancher/k3s/server/manifests/lolly-https.yaml
  var/lib/rancher/k3s/server/manifests/lolly-work.yaml   (HelmChart, chart from deploy/helm)

podman: Quadlet units, kept in /var (outside the root snapshots, like K3s's
manifests) and linked from /etc/containers/systemd, so a host rollback never
pairs an older image with a database a newer release has migrated
  var/lib/lolly/quadlet/lolly.network
  var/lib/lolly/quadlet/lolly-postgres.container
  var/lib/lolly/quadlet/lolly-work.container
  var/lib/lolly/quadlet/lolly-caddy.container
  etc/containers/systemd/<each of the above>             (symbolic links)
  usr/share/lolly-appliance/podman/Caddyfile

Both profiles:
  usr/share/lolly-appliance/release.json                 (what this image carries)
  usr/share/lolly-appliance/release-definition.json      (release.json itself, lolly-update's starting point)
  usr/share/lolly-appliance/work-config.json

With --kiwi it also writes the KIWI description with <version> set to the
release's Lolly version: everything a person installs carries the Lolly
project's release number, so the image is lolly-appliance-<version>-<arch>
(k3s) or lolly-appliance-podman-<version>-<arch>.

It also writes an image plan (--plan) that fetch.py turns into preloaded image
archives. Standard library only, no network, deterministic output, so a test
can check that both profiles come from the same release.json and that nothing
was copied by hand.

  python3 deploy/appliance/generate.py --arch aarch64 --profile podman --overlay OUT/root --plan OUT/images.json
"""
from __future__ import annotations

import argparse
import base64
import fnmatch
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
GOARCH = {"x86_64": "amd64", "aarch64": "arm64"}
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
# registry/path[:tag]@sha256:hex, with an explicit registry host.
IMAGE_REF = re.compile(r"^(?P<repository>[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+?)(?::(?P<tag>[A-Za-z0-9_.-]+))?@(?P<digest>sha256:[a-f0-9]{64})$")
MANIFESTS = "var/lib/rancher/k3s/server/manifests"
IMAGES = "var/lib/rancher/k3s/agent/images"
QUADLET = "var/lib/lolly/quadlet"
PODMAN_IMAGES = "var/lib/lolly/images"
PROFILES = ("k3s", "podman")


class GenerateError(Exception):
    pass


def parse_image(ref: str, field: str) -> dict:
    match = IMAGE_REF.match(ref or "")
    if not match:
        raise GenerateError(f"release.json {field} must be registry/name[:tag]@sha256:<64 hex>, got {ref!r}")
    return match.groupdict()


def load_release(path: Path, arch: str) -> dict:
    release = json.loads(path.read_text())
    if release.get("schemaVersion") != 1:
        raise GenerateError("release.json schemaVersion must be 1")
    if not re.match(r"^\d+\.\d+\.\d+$", str(release.get("version", ""))):
        raise GenerateError("release.json version must be MAJOR.MINOR.PATCH")
    if GOARCH[arch] not in release.get("qualifiedArchitectures", []):
        raise GenerateError(f"release {release['version']} is not qualified for {GOARCH[arch]}")
    release["_server"] = parse_image(release.get("serverImage"), "serverImage")
    release["_postgres"] = parse_image(release.get("postgresImage"), "postgresImage")
    release["_caddy"] = parse_image(release.get("caddyImage"), "caddyImage")
    return release


def work_config(path: Path) -> dict:
    """Lolly Work's settings for the appliance, the same for both profiles."""
    config = json.loads(path.read_text())
    if config.get("deployment", {}).get("mode") != "production":
        raise GenerateError("work-config.json must run Lolly Work in production mode")
    text = json.dumps(config)
    if re.search(r"(?i)secret|password\"\s*:|postgres://|BEGIN [A-Z ]*PRIVATE KEY", text):
        raise GenerateError("work-config.json must not hold a secret")
    return config


def chart_name_and_version(chart: Path) -> tuple[str, str]:
    text = (chart / "Chart.yaml").read_text()
    name = re.search(r"^name:\s*([A-Za-z0-9-]+)\s*$", text, re.M)
    version = re.search(r"^version:\s*([0-9][A-Za-z0-9.+-]*)\s*$", text, re.M)
    if not name or not version:
        raise GenerateError("Chart.yaml needs name and version")
    return name.group(1), version.group(1)


def helmignore(chart: Path) -> list[str]:
    path = chart / ".helmignore"
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")]


def ignored(rel: str, patterns: list[str]) -> bool:
    parts = rel.split("/")
    for pattern in patterns:
        if pattern.endswith("/"):
            if pattern.rstrip("/") in parts[:-1] or pattern.rstrip("/") == parts[-1]:
                return True
        elif fnmatch.fnmatch(parts[-1], pattern) or fnmatch.fnmatch(rel, pattern):
            return True
    return False


def package_chart(chart: Path) -> tuple[bytes, str, str]:
    """A reproducible equivalent of `helm package`: <name>/<files> in a gzip tar."""
    name, version = chart_name_and_version(chart)
    patterns = helmignore(chart)
    files = sorted(
        p for p in chart.rglob("*")
        if p.is_file() and not ignored(p.relative_to(chart).as_posix(), patterns)
    )
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for path in files:
            rel = path.relative_to(chart).as_posix()
            data = path.read_bytes()
            info = tarfile.TarInfo(f"{name}/{rel}")
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    packed = io.BytesIO()
    with gzip.GzipFile(fileobj=packed, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return packed.getvalue(), name, version


def fill(template: str, values: dict[str, str]) -> str:
    out = template
    for key, value in values.items():
        out = out.replace(f"@{key}@", value)
    left = re.findall(r"@[A-Z_]+@", out)
    if left:
        raise GenerateError(f"unfilled placeholders: {sorted(set(left))}")
    return out


def write(root: Path, rel: str, text: str | bytes, mode: int = 0o644) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode() if isinstance(text, str) else text)
    os.chmod(path, mode)


def render_kiwi(release_path: Path, target: Path) -> str:
    """The KIWI description with <version> set to the release's Lolly version."""
    version = json.loads(release_path.read_text()).get("version", "")
    if not re.match(r"^\d+\.\d+\.\d+$", str(version)):
        raise GenerateError("release.json version must be MAJOR.MINOR.PATCH")
    source = (HERE / "kiwi/lolly-appliance.kiwi").read_text()
    if source.count("<version>@LOLLY_VERSION@</version>") != 2 or re.search(r"<version>\d", source):
        raise GenerateError("kiwi/lolly-appliance.kiwi must take <version> from release.json (@LOLLY_VERSION@), never a literal")
    target.mkdir(parents=True, exist_ok=True)
    (target / "lolly-appliance.kiwi").write_text(fill(source, {"LOLLY_VERSION": version}))
    return version


def link(root: Path, rel: str, target: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        path.unlink()
    os.symlink(target, path)


def image_name(arch: str, version: str, profile: str) -> str:
    return f"lolly-appliance-{version}-{arch}" if profile == "k3s" else f"lolly-appliance-{profile}-{version}-{arch}"


def k3s_overlay(overlay: Path, release: dict, chart: Path, config: dict) -> tuple[dict, list[dict]]:
    server, postgres = release["_server"], release["_postgres"]
    chart_tgz, chart_name, chart_version = package_chart(chart)
    if chart_name != "lolly-work":
        raise GenerateError("the appliance expects the lolly-work chart")
    chart_sha = hashlib.sha256(chart_tgz).hexdigest()
    values = fill((HERE / "k3s/values-appliance.yaml").read_text(), {
        "SERVER_REPOSITORY": server["repository"],
        "SERVER_DIGEST": server["digest"],
        # JSON is YAML, and one line keeps the embedded values' indentation simple.
        "WORK_CONFIG": json.dumps(config, separators=(", ", ": ")),
    })
    helmchart = fill((HERE / "k3s/lolly-work.yaml.in").read_text(), {
        "WORK_VERSION": release["version"],
        "CHART_VERSION": chart_version,
        "CHART_SHA256": chart_sha,
        "CHART_CONTENT": base64.b64encode(chart_tgz).decode(),
        "VALUES_CONTENT": "\n".join(("    " + line) if line else "" for line in values.splitlines()),
    })
    postgres_manifest = fill((HERE / "k3s/lolly-postgres.yaml.in").read_text(), {
        "POSTGRES_IMAGE": f"{postgres['repository']}@{postgres['digest']}",
        "POSTGRES_IMAGE_REF": release["postgresImage"],
    })
    write(overlay, f"{MANIFESTS}/00-lolly-namespace.yaml", (HERE / "k3s/00-lolly-namespace.yaml").read_text())
    write(overlay, f"{MANIFESTS}/lolly-postgres.yaml", postgres_manifest)
    write(overlay, f"{MANIFESTS}/lolly-https.yaml", (HERE / "k3s/lolly-https.yaml").read_text())
    write(overlay, f"{MANIFESTS}/lolly-work.yaml", helmchart)
    images = [
        {
            "name": "lolly-work-server",
            "repository": server["repository"],
            # The local name K3s tags; the pod spec uses the digest.
            "tag": release["version"],
            "digest": server["digest"],
            "archive": f"{IMAGES}/lolly-work-server-{release['version']}.tar",
        },
        {
            "name": "postgres",
            "repository": postgres["repository"],
            "tag": postgres["tag"] or "latest",
            "digest": postgres["digest"],
            "archive": f"{IMAGES}/lolly-postgres-{postgres['tag'] or 'latest'}.tar",
        },
    ]
    return {"chart": {"name": chart_name, "version": chart_version, "sha256": chart_sha}}, images


def podman_overlay(overlay: Path, release: dict) -> tuple[dict, list[dict]]:
    server, postgres, caddy = release["_server"], release["_postgres"], release["_caddy"]
    pins = {
        "WORK_VERSION": release["version"],
        "SERVER_IMAGE": f"{server['repository']}@{server['digest']}",
        "SERVER_IMAGE_REF": release["serverImage"],
        "POSTGRES_IMAGE": f"{postgres['repository']}@{postgres['digest']}",
        "POSTGRES_IMAGE_REF": release["postgresImage"],
        "CADDY_IMAGE": f"{caddy['repository']}@{caddy['digest']}",
        "CADDY_IMAGE_REF": release["caddyImage"],
    }
    units = {
        "lolly.network": (HERE / "podman/lolly.network").read_text(),
        "lolly-postgres.container": fill((HERE / "podman/lolly-postgres.container.in").read_text(), pins),
        "lolly-work.container": fill((HERE / "podman/lolly-work.container.in").read_text(), pins),
        "lolly-caddy.container": fill((HERE / "podman/lolly-caddy.container.in").read_text(), pins),
    }
    for name, text in units.items():
        write(overlay, f"{QUADLET}/{name}", text)
        link(overlay, f"etc/containers/systemd/{name}", f"/{QUADLET}/{name}")
    write(overlay, "usr/share/lolly-appliance/podman/Caddyfile", (HERE / "podman/Caddyfile").read_text())
    images = []
    for name, image, tag in (("lolly-work-server", server, release["version"]),
                             ("postgres", postgres, postgres["tag"] or "latest"),
                             ("caddy", caddy, caddy["tag"] or "latest")):
        images.append({
            "name": name,
            "repository": image["repository"],
            "tag": tag,
            "digest": image["digest"],
            "archive": f"{PODMAN_IMAGES}/{name}-{tag}.tar",
        })
    return {"podman": {"units": sorted(units), "caddy": {"image": pins["CADDY_IMAGE"], "ref": release["caddyImage"]}}}, images


def generate(arch: str, overlay: Path, plan: Path | None, release_path: Path, chart: Path, lock_path: Path,
             profile: str = "k3s", config_path: Path = HERE / "work-config.json") -> dict:
    if arch not in GOARCH:
        raise GenerateError(f"arch must be one of {sorted(GOARCH)}")
    if profile not in PROFILES:
        raise GenerateError(f"profile must be one of {list(PROFILES)}")
    release = load_release(release_path, arch)
    lock = json.loads(lock_path.read_text())
    config = work_config(config_path)
    server, postgres = release["_server"], release["_postgres"]
    summary = {
        "schemaVersion": 1,
        "version": release["version"],
        "image": image_name(arch, release["version"], profile),
        "profile": profile,
        "architecture": arch,
        "work": {"version": release["version"], "source": release.get("workSource"), "serverImage": f"{server['repository']}@{server['digest']}"},
        "postgres": {"image": f"{postgres['repository']}@{postgres['digest']}", "ref": release["postgresImage"]},
    }
    if profile == "k3s":
        k3s = lock["k3s"]
        if arch not in k3s["architectures"]:
            raise GenerateError(f"appliance.lock.json has no K3s pin for {arch}")
        extra, images = k3s_overlay(overlay, release, chart, config)
        summary.update(extra)
        summary["k3s"] = {"version": k3s["version"], "binarySha256": k3s["architectures"][arch]["binary"]["sha256"]}
        summary["k3sSelinux"] = {"version": lock["k3sSelinux"]["version"], "sha256": lock["k3sSelinux"]["sha256"]}
    else:
        extra, images = podman_overlay(overlay, release)
        summary.update(extra)
    summary["base"] = {"distribution": lock["base"]["distribution"], "stage": lock["base"]["stage"]}
    summary["releaseDefinition"] = "deploy/marketplaces/release.json"
    write(overlay, "usr/share/lolly-appliance/release.json", json.dumps(summary, indent=2) + "\n")
    # lolly-update starts from the definition this image was built from.
    definition = {key: value for key, value in release.items() if not key.startswith("_")}
    write(overlay, "usr/share/lolly-appliance/release-definition.json", json.dumps(definition, indent=2) + "\n")
    write(overlay, "usr/share/lolly-appliance/work-config.json", json.dumps(config, indent=2) + "\n")
    result = {"summary": summary, "images": images}
    if plan:
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(json.dumps({"arch": arch, "goarch": GOARCH[arch], "profile": profile, "images": images}, indent=2) + "\n")
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arch", required=True, choices=sorted(GOARCH))
    parser.add_argument("--profile", default="k3s", choices=PROFILES, help="the runtime: k3s (default) or podman")
    parser.add_argument("--overlay", required=True, type=Path, help="overlay root to write into")
    parser.add_argument("--plan", type=Path, help="where to write the image plan for fetch.py")
    parser.add_argument("--kiwi", type=Path, help="directory to write the versioned KIWI description into")
    parser.add_argument("--release", type=Path, default=REPO / "deploy/marketplaces/release.json")
    parser.add_argument("--chart", type=Path, default=REPO / "deploy/helm")
    parser.add_argument("--lock", type=Path, default=HERE / "appliance.lock.json")
    parser.add_argument("--config", type=Path, default=HERE / "work-config.json")
    args = parser.parse_args(argv)
    try:
        result = generate(args.arch, args.overlay, args.plan, args.release, args.chart, args.lock, args.profile, args.config)
        if args.kiwi:
            render_kiwi(args.release, args.kiwi)
    except (GenerateError, KeyError, json.JSONDecodeError) as error:
        print(f"generate: {error}", file=sys.stderr)
        return 1
    summary = result["summary"]
    if args.profile == "k3s":
        print(f"Lolly Work {summary['work']['version']}, chart {summary['chart']['version']}, K3s {summary['k3s']['version']}, {args.arch}")
    else:
        print(f"Lolly Work {summary['work']['version']}, Podman with Quadlet ({', '.join(summary['podman']['units'])}), {args.arch}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
