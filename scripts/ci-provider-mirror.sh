#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Fill a local provider mirror with the exact packages a lock file pins.
#
#   scripts/ci-provider-mirror.sh LOCK_FILE MIRROR_DIR
#
# Deployment qualification runs `init -lockfile=readonly` against the registry
# first. The registry hands out download and SHA256SUMS URLs on GitHub releases,
# and on 2026-11-08 every one of those returned HTTP 504 while the REST API
# served the same files. When that init fails, this script asks the registry
# where each locked provider package lives for this platform, downloads it with
# scripts/ci-fetch-release-asset.sh (release URL first, then the REST API, which
# needs GH_TOKEN), and writes it in the packed mirror layout that
# `init -plugin-dir=MIRROR_DIR` reads.
#
# The lock file stays the integrity rule. Each package's SHA-256 must be one of
# the "zh:" hashes the lock records for that provider before it goes into the
# mirror, and tofu or terraform then check it against the lock again as they
# install it.
set -euo pipefail

fail() { printf 'ci-provider-mirror: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 2 ]] || fail 'usage: ci-provider-mirror.sh LOCK_FILE MIRROR_DIR'
lock="$1" mirror="$2"
[[ -f "$lock" ]] || fail "no lock file at $lock"
command -v jq > /dev/null || fail 'jq is required'
fetch="$(dirname -- "${BASH_SOURCE[0]}")/ci-fetch-release-asset.sh"

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "unsupported system $(uname -s)" ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) fail "unsupported machine $(uname -m)" ;; esac

# One line per locked provider: address, version, then every zh: hash.
entries="$(awk '
  /^provider "/ { split($0, part, "\""); address = part[2]; version = ""; hashes = "" }
  address != "" && /^[ \t]*version[ \t]*=/ { split($0, part, "\""); version = part[2] }
  address != "" && /"zh:[0-9a-f]+"/ { match($0, /zh:[0-9a-f]+/); hashes = hashes " " substr($0, RSTART + 3, RLENGTH - 3) }
  address != "" && /^}/ { print address, version hashes; address = "" }
' "$lock")"
[[ -n "$entries" ]] || fail "no providers in $lock"

mkdir -p -- "$mirror"
count=0
while read -r address version hashes; do
  [[ "$address" =~ ^(registry\.terraform\.io|registry\.opentofu\.org)/([a-z0-9_-]+)/([a-z0-9_-]+)$ ]] || fail "unsupported provider address $address"
  host="${BASH_REMATCH[1]}" namespace="${BASH_REMATCH[2]}" type="${BASH_REMATCH[3]}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "$address: unexpected version $version"
  [[ -n "$hashes" ]] || fail "$address: the lock records no zh: hashes to check against"

  metadata="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --connect-timeout 15 --max-time 60 \
    "https://$host/v1/providers/$namespace/$type/$version/download/$os/$arch")"
  url="$(jq -r '.download_url // empty' <<< "$metadata")"
  filename="$(jq -r '.filename // empty' <<< "$metadata")"
  [[ "$url" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/download/([^/]+)/([^/]+)$ ]] ||
    fail "$address $version: the registry download is not a GitHub release asset: $url"
  repo="${BASH_REMATCH[1]}" tag="${BASH_REMATCH[2]}" asset="${BASH_REMATCH[3]}"
  [[ "$asset" = "$filename" && "$asset" = "terraform-provider-${type}_${version}_${os}_${arch}.zip" ]] ||
    fail "$address $version: unexpected package name $asset"
  tag="${tag//%2F//}"
  tag="${tag//%2B/+}"

  target="$mirror/$host/$namespace/$type/$asset"
  mkdir -p -- "$(dirname -- "$target")"
  bash "$fetch" "$repo" "$tag" "$asset" "$target"
  digest="$(sha256sum "$target" | cut -d ' ' -f 1)"
  if [[ " $hashes " != *" $digest "* ]]; then
    rm -f -- "$target"
    fail "$address $version: $asset has SHA-256 $digest, which the lock file does not record"
  fi
  printf 'ci-provider-mirror: %s %s %s_%s matches the lock file\n' "$address" "$version" "$os" "$arch"
  count=$((count + 1))
done <<< "$entries"
printf 'ci-provider-mirror: %s locked provider package(s) in %s\n' "$count" "$mirror"
