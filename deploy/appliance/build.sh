#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
# Build the Lolly appliance image (k3s profile) for this machine's architecture.
#
#   sudo deploy/appliance/build.sh [--work DIR] [--out DIR] [--cache DIR]
#
# Needs root, kiwi-ng 10, createrepo_c and network access to the openSUSE
# repositories, GitHub (K3s), rpm.rancher.io and the image registries. Every
# downloaded file is checked against appliance.lock.json or the digests in
# deploy/marketplaces/release.json. Output in --out (default
# deploy/appliance/out/<arch>): <name>.raw, <name>.qcow2 and SHA256SUMS.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
arch=$(uname -m)
work=/var/tmp/lolly-appliance/$arch
out=$here/out/$arch
cache=/var/cache/lolly-appliance
while [ $# -gt 0 ]; do
  case $1 in
    --work) work=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    -h|--help) sed -n '3,11s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case $arch in x86_64|aarch64) ;; *) echo "build.sh: $arch is not supported" >&2; exit 1 ;; esac
[ "$(id -u)" = 0 ] || { echo "build.sh: run as root (kiwi-ng needs loop devices)" >&2; exit 1; }
for tool in kiwi-ng createrepo_c python3; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool is missing" >&2; exit 1; }
done

started=$SECONDS
rm -rf "$work/desc" "$work/root" "$work/build"
mkdir -p "$work" "$out" "$cache"

echo "== generate the K3s manifests from release.json"
python3 -B "$here/generate.py" --arch "$arch" --overlay "$work/root" --plan "$work/images.json"

echo "== fetch and verify K3s, k3s-selinux and the release images"
rm -rf "$work/local-repo"
python3 -B "$here/fetch.py" --plan "$work/images.json" --overlay "$work/root" --repo "$work/local-repo" --cache "$cache"
createrepo_c --quiet "$work/local-repo"

echo "== assemble the description"
mkdir -p "$work/desc"
cp "$here/kiwi/lolly-appliance.kiwi" "$here/kiwi/config.sh" "$here/kiwi/disk.sh" "$work/desc/"
cp -a "$here/kiwi/root" "$work/desc/root"
cp -a "$work/root/." "$work/desc/root/"
install -D -m 0644 "$here/README.md" "$work/desc/root/usr/share/doc/lolly-appliance/README.md"
install -D -m 0644 "$here/LICENSE.kiwi" "$work/desc/root/usr/share/doc/lolly-appliance/LICENSE.kiwi"
cp -a "$work/local-repo" "$work/desc/local-repo"
chown -R root:root "$work/desc"

echo "== kiwi-ng system build (profile k3s, $arch)"
kiwi-ng --profile k3s --type oem system build --description "$work/desc" --target-dir "$work/build"

name=$(cd "$work/build" && ls Lolly-Appliance*.qcow2 | head -n 1)
base=${name%.qcow2}
cp --sparse=always "$work/build/$base.raw" "$out/$base.raw"
cp "$work/build/$base.qcow2" "$out/$base.qcow2"
cp "$work/build/$base.packages" "$out/$base.packages" 2>/dev/null || true
cp "$work/images.json" "$out/$base.images.json"
cp "$work/root/usr/share/lolly-appliance/release.json" "$out/$base.release.json"
(cd "$out" && sha256sum "$base.raw" "$base.qcow2" > SHA256SUMS)
echo "== done in $((SECONDS - started)) s"
ls -la "$out"
du -h --apparent-size "$out/$base.raw" | sed 's/^/raw apparent size: /'
du -h "$out/$base.raw" | sed 's/^/raw allocated:     /'
