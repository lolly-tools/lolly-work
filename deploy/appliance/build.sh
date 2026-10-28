#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
# Build the Lolly appliance image for this machine's architecture.
#
#   sudo deploy/appliance/build.sh [--profile k3s|podman] [--work DIR] [--out DIR] [--cache DIR]
#
# Needs root, kiwi-ng 10, createrepo_c and network access to the openSUSE
# repositories, GitHub (K3s), rpm.rancher.io and the image registries. Every
# downloaded file is checked against appliance.lock.json or the digests in
# deploy/marketplaces/release.json. The image takes that release's Lolly
# version: output in --out (default deploy/appliance/out/<arch>) is
# lolly-appliance-<version>-<arch>.raw and .qcow2 for the k3s profile (the
# default) and lolly-appliance-podman-<version>-<arch> for podman, with
# SHA256SUMS.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
arch=$(uname -m)
work=/var/tmp/lolly-appliance/$arch
out=$here/out/$arch
cache=/var/cache/lolly-appliance
profile=k3s
while [ $# -gt 0 ]; do
  case $1 in
    --profile) profile=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    -h|--help) sed -n '3,12s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case $arch in x86_64|aarch64) ;; *) echo "build.sh: $arch is not supported" >&2; exit 1 ;; esac
case $profile in k3s|podman) ;; *) echo "build.sh: --profile is k3s or podman" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "build.sh: run as root (kiwi-ng needs loop devices)" >&2; exit 1; }
for tool in kiwi-ng createrepo_c python3; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool is missing" >&2; exit 1; }
done
# KIWI labels the image with the image's own policy, but on an SELinux host the
# kernel checks each label against the host's policy, which does not know types
# such as cockpit's or K3s's.
if command -v getenforce >/dev/null && [ "$(getenforce)" = Enforcing ]; then
  echo "build.sh: SELinux is enforcing on this build host. Build in a container, or run 'setenforce 0' for the build." >&2
  exit 1
fi

started=$SECONDS
rm -rf "$work/desc" "$work/root" "$work/build"
mkdir -p "$work" "$out" "$cache"

echo "== generate the $profile profile's runtime files and the versioned description from release.json"
mkdir -p "$work/desc"
python3 -B "$here/generate.py" --arch "$arch" --profile "$profile" --overlay "$work/root" --plan "$work/images.json" --kiwi "$work/desc"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$work/root/usr/share/lolly-appliance/release.json")
[ -n "$version" ] || { echo "build.sh: no version in the generated release summary" >&2; exit 1; }

echo "== fetch and verify the release images (and K3s with k3s-selinux for the k3s profile)"
rm -rf "$work/local-repo"
python3 -B "$here/fetch.py" --plan "$work/images.json" --overlay "$work/root" --repo "$work/local-repo" --cache "$cache"
createrepo_c --quiet "$work/local-repo"

echo "== assemble the description"
cp "$here/kiwi/config.sh" "$here/kiwi/disk.sh" "$work/desc/"
cp -a "$here/kiwi/root" "$work/desc/root"
cp -a "$here/kiwi/root-$profile/." "$work/desc/root/"
cp -a "$work/root/." "$work/desc/root/"
install -D -m 0644 "$here/README.md" "$work/desc/root/usr/share/doc/lolly-appliance/README.md"
install -D -m 0644 "$here/LICENSE.kiwi" "$work/desc/root/usr/share/doc/lolly-appliance/LICENSE.kiwi"
cp -a "$work/local-repo" "$work/desc/local-repo"
chown -R root:root "$work/desc"

echo "== kiwi-ng system build (profile $profile, $arch)"
kiwi-ng --profile "$profile" --type oem system build --description "$work/desc" --target-dir "$work/build"

# KIWI names its result <name>.<arch>-<version>; the release name is
# lolly-appliance-<version>-<arch> (k3s) or lolly-appliance-podman-<version>-<arch>.
kiwi=lolly-appliance.$arch-$version
base=lolly-appliance-$version-$arch
[ "$profile" = k3s ] || base=lolly-appliance-$profile-$version-$arch
[ -f "$work/build/$kiwi.qcow2" ] || { echo "build.sh: KIWI did not produce $kiwi.qcow2 (version drift?)" >&2; exit 1; }
cp --sparse=always "$work/build/$kiwi.raw" "$out/$base.raw"
cp "$work/build/$kiwi.qcow2" "$out/$base.qcow2"
cp "$work/build/$kiwi.packages" "$out/$base.packages" 2>/dev/null || true
cp "$work/images.json" "$out/$base.images.json"
cp "$work/root/usr/share/lolly-appliance/release.json" "$out/$base.release.json"
(cd "$out" && sha256sum "$base.raw" "$base.qcow2" > SHA256SUMS)
echo "== done in $((SECONDS - started)) s"
ls -la "$out"
du -h --apparent-size "$out/$base.raw" | sed 's/^/raw apparent size: /'
du -h "$out/$base.raw" | sed 's/^/raw allocated:     /'
