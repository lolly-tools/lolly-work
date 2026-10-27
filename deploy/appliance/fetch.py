#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Fetch and verify everything the appliance image carries from outside the
openSUSE repositories, so first boot needs no registry and no download.

  - k3s profile: the K3s binary and K3s's own airgap images, checked against
    appliance.lock.json (the sha256 sums K3s publishes with each release), and
    the k3s-selinux RPM, checked the same way, into a local package
    repository the KIWI build installs it from;
  - each release image in the plan generate.py wrote, by digest, as an OCI
    archive: in K3s's airgap images directory (k3s), or in
    /var/lib/lolly/images for `podman load` at first boot (podman).

An image archive holds the release's multi-architecture index unchanged (so its
digest is the one release.json pins) plus the manifest, config and layers for
this one architecture; every blob is checked against its digest. K3s imports
such partial archives (WithSkipMissing) and tags the image by that digest, so
the pod spec's repository@sha256 reference resolves locally; `podman load`
records the same digest, so the Quadlet units' Image= pins resolve too.

Standard library only. Anonymous registry access; nothing is pushed.

  python3 deploy/appliance/fetch.py --plan OUT/images.json --overlay OUT/root --repo OUT/repo --cache CACHE
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)
MANIFEST_TYPES = (
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)
REGISTRY_HOSTS = {"docker.io": "registry-1.docker.io"}
USER_AGENT = "lolly-appliance-fetch/1"


class FetchError(Exception):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path, sha256: str, headers: dict | None = None, attempts: int = 4) -> Path:
    """Download to target unless a file with the expected sha256 is already there."""
    if target.exists() and sha256_file(target) == sha256:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            for key, value in (headers or {}).items():
                # Never forwarded on a redirect to blob storage.
                request.add_unredirected_header(key, value)
            digest = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as out:
                for chunk in iter(lambda: response.read(1 << 20), b""):
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != sha256:
                raise FetchError(f"{url}: sha256 {digest.hexdigest()} does not match the pin {sha256}")
            partial.replace(target)
            return target
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == attempts:
                raise FetchError(f"{url}: HTTP {error.code}") from error
            time.sleep(2 * attempt)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == attempts:
                raise FetchError(f"{url}: {error}") from error
            time.sleep(2 * attempt)
    raise FetchError(f"{url}: download failed")


class Registry:
    """Anonymous pull from an OCI distribution registry (token auth on 401)."""

    def __init__(self, repository: str):
        host, _, path = repository.partition("/")
        self.host = REGISTRY_HOSTS.get(host, host)
        self.path = path
        self.token: str | None = None

    def _auth_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _login(self, challenge: str) -> None:
        fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
        if not challenge.lower().startswith("bearer") or "realm" not in fields:
            raise FetchError(f"{self.host}: unsupported auth challenge")
        query = f"service={fields.get('service', '')}&scope=repository:{self.path}:pull"
        request = urllib.request.Request(f"{fields['realm']}?{query}", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.load(response)
        self.token = body.get("token") or body.get("access_token")
        if not self.token:
            raise FetchError(f"{self.host}: no token for {self.path}")

    def get(self, kind: str, digest: str, accept: tuple[str, ...] = ()) -> bytes:
        url = f"https://{self.host}/v2/{self.path}/{kind}/{digest}"
        for _ in range(2):
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": ", ".join(accept) or "*/*"})
            for key, value in self._auth_headers().items():
                request.add_unredirected_header(key, value)
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    data = response.read()
            except urllib.error.HTTPError as error:
                if error.code == 401 and not self.token:
                    self._login(error.headers.get("WWW-Authenticate", ""))
                    continue
                raise FetchError(f"{url}: HTTP {error.code}") from error
            if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
                raise FetchError(f"{url}: content does not match its digest")
            return data
        raise FetchError(f"{url}: authorisation failed")

    def blob(self, digest: str, cache: Path) -> Path:
        hexdigest = digest.split(":", 1)[1]
        target = cache / "blobs" / "sha256" / hexdigest
        if target.exists() and sha256_file(target) == hexdigest:
            return target
        for _ in range(2):
            try:
                return download(f"https://{self.host}/v2/{self.path}/blobs/{digest}", target, hexdigest, self._auth_headers())
            except FetchError as error:
                if "HTTP 401" in str(error) and not self.token:
                    challenge = self._challenge(digest)
                    self._login(challenge)
                    continue
                raise
        raise FetchError(f"{digest}: authorisation failed")

    def _challenge(self, digest: str) -> str:
        try:
            urllib.request.urlopen(urllib.request.Request(f"https://{self.host}/v2/{self.path}/blobs/{digest}", method="HEAD", headers={"User-Agent": USER_AGENT}), timeout=60)
        except urllib.error.HTTPError as error:
            return error.headers.get("WWW-Authenticate", "")
        return ""


def platform_manifest(index: dict, goarch: str) -> dict:
    for entry in index.get("manifests", []):
        platform = entry.get("platform", {})
        if entry.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
            continue
        if platform.get("os") == "linux" and platform.get("architecture") == goarch and platform.get("variant") in (None, "v8"):
            return entry
    raise FetchError(f"the index has no linux/{goarch} image")


def image_archive(image: dict, goarch: str, target: Path, cache: Path) -> dict:
    """Write an OCI archive holding the pinned index and one platform's blobs."""
    registry = Registry(image["repository"])
    index_bytes = registry.get("manifests", image["digest"], INDEX_TYPES + MANIFEST_TYPES)
    index = json.loads(index_bytes)
    media_type = index.get("mediaType")
    if media_type not in INDEX_TYPES:
        raise FetchError(f"{image['repository']}@{image['digest']} is not a multi-architecture index ({media_type})")
    entry = platform_manifest(index, goarch)
    manifest_bytes = registry.get("manifests", entry["digest"], MANIFEST_TYPES)
    manifest = json.loads(manifest_bytes)
    blobs: dict[str, Path | bytes] = {image["digest"]: index_bytes, entry["digest"]: manifest_bytes}
    for descriptor in [manifest["config"], *manifest["layers"]]:
        blobs[descriptor["digest"]] = registry.blob(descriptor["digest"], cache)
    name = f"{image['repository']}:{image['tag']}"
    layout_index = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": media_type,
            "digest": image["digest"],
            "size": len(index_bytes),
            "annotations": {"io.containerd.image.name": name, "org.opencontainers.image.ref.name": image["tag"]},
        }],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as tar:
        def add(member: str, data: bytes | None = None, path: Path | None = None) -> None:
            info = tarfile.TarInfo(member)
            info.mode, info.mtime, info.uid, info.gid = 0o644, 0, 0, 0
            if path is not None:
                info.size = path.stat().st_size
                with path.open("rb") as handle:
                    tar.addfile(info, handle)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        add("oci-layout", json.dumps({"imageLayoutVersion": "1.0.0"}).encode())
        add("index.json", json.dumps(layout_index, indent=2).encode())
        for digest in sorted(blobs):
            content = blobs[digest]
            member = "blobs/sha256/" + digest.split(":", 1)[1]
            if isinstance(content, Path):
                add(member, path=content)
            else:
                add(member, data=content)
    partial.replace(target)
    layers = sum(d["size"] for d in manifest["layers"])
    return {"name": name, "digest": image["digest"], "platformDigest": entry["digest"], "layerBytes": layers, "archiveBytes": target.stat().st_size}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", required=True, type=Path, help="images.json from generate.py")
    parser.add_argument("--overlay", required=True, type=Path)
    parser.add_argument("--repo", required=True, type=Path, help="local package repository directory")
    parser.add_argument("--cache", required=True, type=Path, help="download cache (content-addressed)")
    parser.add_argument("--lock", type=Path, default=HERE / "appliance.lock.json")
    args = parser.parse_args(argv)
    plan = json.loads(args.plan.read_text())
    lock = json.loads(args.lock.read_text())
    arch, goarch = plan["arch"], plan["goarch"]
    pins = lock["k3s"]["architectures"][arch]
    try:
        args.repo.mkdir(parents=True, exist_ok=True)
        if plan.get("profile", "k3s") == "k3s":
            binary = download(pins["binary"]["url"], args.cache / f"k3s-{goarch}-{lock['k3s']['version']}", pins["binary"]["sha256"])
            target = args.overlay / "usr/local/bin/k3s"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(binary, target)
            os.chmod(target, 0o755)
            airgap_name = pins["airgapImages"]["url"].rsplit("/", 1)[1]
            airgap = download(pins["airgapImages"]["url"], args.cache / f"{lock['k3s']['version']}-{airgap_name}", pins["airgapImages"]["sha256"])
            images_dir = args.overlay / "var/lib/rancher/k3s/agent/images"
            images_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(airgap, images_dir / airgap_name)
            selinux = lock["k3sSelinux"]
            rpm = download(selinux["url"], args.cache / selinux["url"].rsplit("/", 1)[1], selinux["sha256"])
            shutil.copyfile(rpm, args.repo / rpm.name)
        report = []
        for image in plan["images"]:
            report.append(image_archive(image, goarch, args.overlay / image["archive"], args.cache))
    except (FetchError, KeyError) as error:
        print(f"fetch: {error}", file=sys.stderr)
        return 1
    for entry in report:
        print(f"{entry['name']} {entry['digest']} ({goarch} {entry['platformDigest'][:19]}, {entry['archiveBytes'] // (1 << 20)} MiB)")
    if plan.get("profile", "k3s") == "k3s":
        print(f"K3s {lock['k3s']['version']} {goarch}, airgap images and {lock['k3sSelinux']['url'].rsplit('/', 1)[1]} verified")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
