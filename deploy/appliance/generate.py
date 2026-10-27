#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Generate the appliance's K3s manifests from one release definition.

Reads deploy/marketplaces/release.json (the digest pins the ready-made package
uses), packages deploy/helm, and writes the files K3s applies at first boot
into an overlay tree that the KIWI build copies into the image:

  var/lib/rancher/k3s/server/manifests/00-lolly-namespace.yaml
  var/lib/rancher/k3s/server/manifests/lolly-postgres.yaml
  var/lib/rancher/k3s/server/manifests/lolly-https.yaml
  var/lib/rancher/k3s/server/manifests/lolly-work.yaml   (HelmChart)
  usr/share/lolly-appliance/release.json                 (what this image carries)

It also writes an image plan (--plan) that fetch.py turns into preloaded image
archives. Standard library only, no network, deterministic output, so the
podman profile can later be generated from the same release.json and a test
can check that nothing was copied by hand.

  python3 deploy/appliance/generate.py --arch aarch64 --overlay OUT/root --plan OUT/images.json
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
    return release


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


def generate(arch: str, overlay: Path, plan: Path | None, release_path: Path, chart: Path, lock_path: Path) -> dict:
    if arch not in GOARCH:
        raise GenerateError(f"arch must be one of {sorted(GOARCH)}")
    release = load_release(release_path, arch)
    lock = json.loads(lock_path.read_text())
    k3s = lock["k3s"]
    if arch not in k3s["architectures"]:
        raise GenerateError(f"appliance.lock.json has no K3s pin for {arch}")
    server, postgres = release["_server"], release["_postgres"]
    chart_tgz, chart_name, chart_version = package_chart(chart)
    if chart_name != "lolly-work":
        raise GenerateError("the appliance expects the lolly-work chart")
    chart_sha = hashlib.sha256(chart_tgz).hexdigest()

    values = fill((HERE / "k3s/values-appliance.yaml").read_text(), {
        "SERVER_REPOSITORY": server["repository"],
        "SERVER_DIGEST": server["digest"],
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
    summary = {
        "schemaVersion": 1,
        "profile": "k3s",
        "architecture": arch,
        "work": {"version": release["version"], "source": release.get("workSource"), "serverImage": f"{server['repository']}@{server['digest']}"},
        "postgres": {"image": f"{postgres['repository']}@{postgres['digest']}", "ref": release["postgresImage"]},
        "chart": {"name": chart_name, "version": chart_version, "sha256": chart_sha},
        "k3s": {"version": k3s["version"], "binarySha256": k3s["architectures"][arch]["binary"]["sha256"]},
        "k3sSelinux": {"version": lock["k3sSelinux"]["version"], "sha256": lock["k3sSelinux"]["sha256"]},
        "base": {"distribution": lock["base"]["distribution"], "stage": lock["base"]["stage"]},
        "releaseDefinition": "deploy/marketplaces/release.json",
    }
    write(overlay, "usr/share/lolly-appliance/release.json", json.dumps(summary, indent=2) + "\n")
    result = {"summary": summary, "images": images}
    if plan:
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(json.dumps({"arch": arch, "goarch": GOARCH[arch], "images": images}, indent=2) + "\n")
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arch", required=True, choices=sorted(GOARCH))
    parser.add_argument("--overlay", required=True, type=Path, help="overlay root to write into")
    parser.add_argument("--plan", type=Path, help="where to write the image plan for fetch.py")
    parser.add_argument("--release", type=Path, default=REPO / "deploy/marketplaces/release.json")
    parser.add_argument("--chart", type=Path, default=REPO / "deploy/helm")
    parser.add_argument("--lock", type=Path, default=HERE / "appliance.lock.json")
    args = parser.parse_args(argv)
    try:
        result = generate(args.arch, args.overlay, args.plan, args.release, args.chart, args.lock)
    except (GenerateError, KeyError, json.JSONDecodeError) as error:
        print(f"generate: {error}", file=sys.stderr)
        return 1
    summary = result["summary"]
    print(f"Lolly Work {summary['work']['version']}, chart {summary['chart']['version']}, K3s {summary['k3s']['version']}, {args.arch}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
