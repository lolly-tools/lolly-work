#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
# Cut the ready-made package's web app archive from a Lolly release's signed web image.
#
#   scripts/cut-shell-archive.sh <version> <image digest> <empty work directory> [ynh revision]
#
# The input is the published image ghcr.io/lolly-tools/lolly-web:<version>, named by its
# digest. Verify that digest's signature first; this script does not:
#
#   cosign verify ghcr.io/lolly-tools/lolly-web@<image digest> \
#     --certificate-identity https://github.com/lolly-tools/lolly/.github/workflows/release-images.yml@refs/heads/main \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com
#
# The archive is the image's frontend layer, unchanged, with the YunoHost cut of Lolly's
# scripts/yunohost-release.ts: no ./models and English /info only. It is packed by name,
# at the image source commit's time, with numeric root ownership, then gzip -n. Every input
# is content-addressed, so GNU tar 1.35 and gzip 1.13 (Debian 13) give the same bytes on
# any machine; run it in a debian:13 container elsewhere. Output: <work dir>/lolly-web-
# <version>-ynh<revision>.tar.gz, which deploy/marketplaces/release.json then pins through
# scripts/marketplace-cohort.ts.
set -euo pipefail

VERSION=${1:?version, for example 1.1.3}
DIGEST=${2:?image digest, sha256:...}
W=${3:?empty work directory}
REV=${4:-1}
REPOSITORY=lolly-tools/lolly-web
NAME="lolly-web-$VERSION-ynh$REV.tar.gz"

[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be x.y.z"; exit 1; }
[[ $DIGEST =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "image digest must be sha256:<64 hex>"; exit 1; }
[[ $REV =~ ^[1-9][0-9]*$ ]] || { echo "ynh revision must be a positive integer"; exit 1; }
tar --version | head -1 | grep -q 'GNU tar' || { echo "GNU tar is required; run this in a debian:13 container"; exit 1; }
mkdir -p "$W"
[ -z "$(ls -A "$W")" ] || { echo "refusing: $W is not empty"; exit 1; }

token=$(curl -fsS "https://ghcr.io/token?scope=repository:$REPOSITORY:pull" | jq -r .token)
registry() { curl -fsSL -H "Authorization: Bearer $token" "$@"; }
registry -o "$W/manifest.json" -H 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
  "https://ghcr.io/v2/$REPOSITORY/manifests/$DIGEST"
[ "sha256:$(sha256sum "$W/manifest.json" | cut -d' ' -f1)" = "$DIGEST" ] || { echo "manifest digest differs (a multi-platform index is not supported)"; exit 1; }
config=$(jq -r .config.digest "$W/manifest.json")
layer=$(jq -r '.layers[-1].digest' "$W/manifest.json")
registry -o "$W/config.json" "https://ghcr.io/v2/$REPOSITORY/blobs/$config"
[ "sha256:$(sha256sum "$W/config.json" | cut -d' ' -f1)" = "$config" ] || { echo "config digest differs"; exit 1; }
[ "$(jq -r '.config.Labels["org.opencontainers.image.version"]' "$W/config.json")" = "$VERSION" ] || { echo "the image is not version $VERSION"; exit 1; }
jq -e '.history | map(select(.empty_layer != true)) | last | .created_by | test("COPY .*release-frontend /usr/share/nginx/html")' "$W/config.json" >/dev/null \
  || { echo "the last layer is not the release frontend"; exit 1; }
source=$(jq -r '.config.Labels["org.opencontainers.image.revision"]' "$W/config.json")
[[ $source =~ ^[a-f0-9]{40}$ ]] || { echo "the image names no source commit"; exit 1; }

# The commit time and the translated locales come from the image's own Lolly source.
epoch=$(date -d "$(curl -fsS "https://api.github.com/repos/lolly-tools/lolly/commits/$source" | jq -r .commit.committer.date)" +%s)
locales=$(curl -fsS "https://api.github.com/repos/lolly-tools/lolly/contents/shells/web/src/locales?ref=$source" \
  | jq -r '.[] | select(.type == "file") | .name | select(endswith(".json")) | rtrimstr(".json") | select(. != "en")')
[ "$(echo "$locales" | wc -w)" -gt 0 ] || { echo "no locales found at $source"; exit 1; }

registry -o "$W/layer.tar.gz" "https://ghcr.io/v2/$REPOSITORY/blobs/$layer"
[ "sha256:$(sha256sum "$W/layer.tar.gz" | cut -d' ' -f1)" = "$layer" ] || { echo "layer digest differs"; exit 1; }
mkdir "$W/root"
tar -xzf "$W/layer.tar.gz" -C "$W/root" usr/share/nginx/html
dist="$W/root/usr/share/nginx/html"
for file in index.html catalog/tools/index.json catalog/tools/index.sig.json; do
  [ -f "$dist/$file" ] || { echo "the frontend has no $file"; exit 1; }
done
[ -z "$(find "$dist" ! -type f ! -type d)" ] || { echo "the frontend holds a link or special file"; exit 1; }

excludes=(--exclude ./models)
for code in $locales; do excludes+=(--exclude "./info/$code"); done
tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  "${excludes[@]}" -C "$dist" -cf - . | gzip -n > "$W/$NAME"
rm -rf "$W/root" "$W/layer.tar.gz"
tar -tzvf "$W/$NAME" | awk '$1 !~ /^[-d]/ { bad = 1 } END { exit bad }' || { echo "archive holds a link"; exit 1; }

echo "image   ghcr.io/$REPOSITORY@$DIGEST (lolly $source)"
echo "archive $W/$NAME"
echo "sha256  $(sha256sum "$W/$NAME" | cut -d' ' -f1)"
echo "bytes   $(stat -c %s "$W/$NAME")"
