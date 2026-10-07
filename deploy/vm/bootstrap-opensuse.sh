#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Put openSUSE Leap 16.0 on the lolly.ing server's second disk
# (deploy/vm/README.md, runbook step 2). UpCloud has no openSUSE template and
# imports raw images only, while openSUSE ships the Minimal-VM Cloud image as
# qcow2. So the server is deployed from UpCloud's Debian 12 template with a
# small system disk plus an empty 50 GB disk, and this script, run as root ON
# THAT DEBIAN SERVER, converts the image onto the empty disk and powers the
# server off. Detach the Debian disk in the hub and start the server: it boots
# openSUSE, and cloud-init puts your ssh key on the user sles.
#
#   ssh root@<ip> 'bash -s' < deploy/vm/bootstrap-opensuse.sh              # the plan; writes nothing
#   ssh root@<ip> 'bash -s -- /dev/vdb' < deploy/vm/bootstrap-opensuse.sh  # write the disk the plan named
#
#   --sha256 <hash>  also require the exact image checksum reviewed before creating the host
#   --tumbleweed  openSUSE Tumbleweed instead of Leap 16.0 (its user is opensuse, not sles)
#   --yes         write the one empty disk found, without naming it
#   <device>      write this disk, which must be the one empty disk found
#   --overwrite   the disk holds an earlier write (a run cut short, or an image
#                 that did not come up): erase it all the same. With the disk
#                 named only, never with --yes; every other check still applies
#
# Without --yes or a device it prints the plan and stops. It refuses unless
# exactly one disk besides the system disk exists, and that disk is at least
# 20 GiB, writable, and neither it nor anything on it is mounted, swap, or held
# by LVM, RAID or device-mapper; and, without --overwrite, it has no partitions
# and no filesystem or partition table signature. It checks the download's
# SHA-256, that the image is qcow2 and that it fits, and looks at the disk
# again just before writing.
set -euo pipefail

# One group, so `bash -s` reads the whole script before running any of it: a
# command below that reads standard input cannot swallow the rest.
{
die() { echo "bootstrap-opensuse.sh: $*" >&2; exit 1; }
usage='usage: bootstrap-opensuse.sh [--tumbleweed] [--sha256 <reviewed-hash>] [--overwrite] [--yes | /dev/<disk>]'

flavour=leap confirm=0 device='' overwrite=0 reviewed_checksum=''
while [ $# -gt 0 ]; do
  case "$1" in
    --sha256)
      [ $# -ge 2 ] || die "--sha256 requires the reviewed lowercase SHA-256; $usage"
      reviewed_checksum=$2
      [[ "$reviewed_checksum" =~ ^[0-9a-f]{64}$ ]] || die "--sha256 requires the reviewed lowercase SHA-256; $usage"
      shift
      ;;
    --tumbleweed) flavour=tumbleweed ;;
    --leap) flavour=leap ;;
    --yes) confirm=1 ;;
    --overwrite) overwrite=1 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    /dev/*) [ -z "$device" ] || die "name one device only; $usage"; device=$1 ;;
    *) die "unknown argument $1; $usage" ;;
  esac
  shift
done
if [ "$overwrite" = 1 ] && [ "$confirm" = 1 ]; then
  die "--overwrite erases what the disk holds: name the disk (/dev/...) instead of --yes. Nothing written"
fi

case "$flavour" in
  leap)
    base=https://download.opensuse.org/distribution/leap/16.0/appliances
    image=Leap-16.0-Minimal-VM.x86_64-Cloud.qcow2
    label='openSUSE Leap 16.0 Minimal-VM (Cloud)'
    user=sles
    ;;
  tumbleweed)
    base=https://download.opensuse.org/tumbleweed/appliances
    image=openSUSE-Tumbleweed-Minimal-VM.x86_64-Cloud.qcow2
    label='openSUSE Tumbleweed Minimal-VM (Cloud)'
    user=opensuse
    ;;
esac

# ── Where this runs ──────────────────────────────────────────────────────────
os_release=${LOLLY_OS_RELEASE:-/etc/os-release}
[ -r "$os_release" ] || die "cannot read $os_release"
# shellcheck source=/dev/null
. "$os_release"
if [ "${ID:-}" != debian ]; then
  die "run this on the Debian 12 server UpCloud deployed for the bootstrap, never elsewhere: it erases a disk. This is ${PRETTY_NAME:-unknown}"
fi
[ "$(id -u)" -eq 0 ] || die "run as root (ssh root@<ip> 'bash -s' < deploy/vm/bootstrap-opensuse.sh)"
arch=$(uname -m)
[ "$arch" = x86_64 ] || die "the openSUSE Cloud image used here is x86_64; this machine is $arch"

# ── The target disk ──────────────────────────────────────────────────────────
MIN_BYTES=$((20 * 1024 * 1024 * 1024))
gib() { awk -v b="$1" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }

root_source=$(findmnt -n -o SOURCE /) || die "cannot find the device mounted at /"
root_source=${root_source%%\[*}
# Every disk under / (through partitions, LVM or RAID) is the system disk.
system_disks=$(lsblk -nrsp -o NAME,TYPE "$root_source" | awk '$2 == "disk" { print $1 }' | sort -u) \
  || die "cannot list the devices under / ($root_source)"
[ -n "$system_disks" ] || die "cannot find the disk under / ($root_source)"

# Every other whole disk: name, size in bytes, read-only flag.
others=$(lsblk -dnrbp -o NAME,TYPE,SIZE,RO | awk -v sys="$system_disks" '
  BEGIN { n = split(sys, s, "\n"); for (i = 1; i <= n; i++) skip[s[i]] = 1 }
  $2 == "disk" && !($1 in skip) && $1 !~ /^\/dev\/(zram|ram|loop)/ { print $1, $3, $4 }') \
  || die "cannot list the disks"
count=$(printf '%s\n' "$others" | grep -c . || true)

echo "System disk, left alone: $(for d in $system_disks; do printf '%s (%s) ' "$d" "$(gib "$(lsblk -dnbr -o SIZE "$d")")"; done)"
if [ "$count" -ne 1 ]; then
  if [ "$count" -gt 0 ]; then
    echo "Other disks:"
    printf '%s\n' "$others" | while read -r name size _; do echo "  $name ($(gib "$size"))"; done
  fi
  die "need exactly one disk besides the system disk, found $count. Deploy the server with one empty 50 GB disk added beside the Debian one (deploy/vm/README.md). Nothing written"
fi
read -r target size ro <<EOF
$others
EOF

# target_problems: one line per reason the target is not an empty, unused disk
# (with --overwrite: not an unused one).
target_problems() {
  local listing children dev sig holders
  [ "$size" -ge "$MIN_BYTES" ] || echo "it has $(gib "$size"); at least 20 GiB is needed"
  [ "$ro" = 0 ] || echo "it is read-only"
  if ! listing=$(lsblk -nrp -o NAME "$target" 2>/dev/null); then
    echo "lsblk cannot list it"
    return 0
  fi
  children=$(printf '%s\n' "$listing" | tail -n +2 | tr '\n' ' ')
  # In use, the disk or anything on it: refused, --overwrite or not.
  # shellcheck disable=SC2086 # device names, split on purpose
  for dev in "$target" $children; do
    if findmnt -rn -S "$dev" >/dev/null 2>&1; then echo "$dev is mounted"; fi
    if grep -qs "^${dev}[[:space:]]" /proc/swaps; then echo "$dev is in use as swap"; fi
    holders=$(find "/sys/class/block/${dev#/dev/}/holders" -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null || true)
    [ -z "$holders" ] || echo "$dev is held by $holders(LVM, RAID or device-mapper)"
  done
  # Anything on it at all: only --overwrite accepts that.
  if [ "$overwrite" != 1 ]; then
    [ -z "$children" ] || echo "it has partitions or devices on it: $children"
    if sig=$(blkid -p -o export "$target" 2>/dev/null) && [ -n "$sig" ]; then
      echo "it carries a signature: $(printf '%s' "$sig" | grep -v '^DEVNAME=' | tr '\n' ' ')"
    fi
  fi
  return 0
}
problems=$(target_problems)
if [ -n "$problems" ]; then
  if [ "$overwrite" = 1 ]; then
    printf '%s cannot be overwritten:\n' "$target" >&2
  else
    printf '%s is not an empty disk:\n' "$target" >&2
  fi
  printf '%s\n' "$problems" | sed 's/^/  - /' >&2
  if [ "$overwrite" != 1 ]; then
    echo "  If it holds an earlier write of this script (cut short, or an image that did not come up), see --overwrite." >&2
  fi
  die "refusing to write $target. Nothing written"
fi
if [ -n "$device" ]; then
  named=$(readlink -f -- "$device" 2>/dev/null || printf '%s' "$device")
  [ "$named" = "$target" ] || die "$device is not the one empty disk found ($target). Nothing written"
fi

work=${LOLLY_BOOTSTRAP_DIR:-/var/tmp/opensuse-image}
if [ "$overwrite" = 1 ]; then
  echo "Target disk: $target ($(gib "$size")), not mounted, not in use. It holds, all to be erased:"
  lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL "$target" 2>/dev/null | sed 's/^/    /' || true
  erase="ERASE $target: wipe its signatures (wipefs -a), then write $label to it, raw"
else
  echo "Target disk: $target ($(gib "$size")), no partitions, no signature, not mounted."
  erase="ERASE $target and write $label to it, raw"
fi
cat <<EOF
Plan:
  Reviewed SHA-256: ${reviewed_checksum:-not supplied; official checksum still required}
  1. apt-get install qemu-utils curl
  2. download $base/$image
     into $work
  3. check it against $base/$image.sha256
  4. $erase
  5. power the server off. Then, in the UpCloud hub: detach the Debian disk
     (Storage tab), start the server, and log in as $user@<ip>
EOF
if [ "$confirm" != 1 ] && [ -z "$device" ]; then
  extra=''
  [ "$flavour" = tumbleweed ] && extra='--tumbleweed '
  [ "$overwrite" = 1 ] && extra="$extra--overwrite "
  echo
  echo "Nothing written. To go ahead, name the disk:"
  echo "  ssh root@<ip> 'bash -s -- $extra$target' < deploy/vm/bootstrap-opensuse.sh"
  exit 0
fi

# ── Download and check ───────────────────────────────────────────────────────
echo "==> qemu-utils"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q </dev/null
apt-get install -y -q qemu-utils curl ca-certificates </dev/null

mkdir -p "$work"
free_kb=$(df -Pk "$work" | awk 'NR == 2 { print $4 }')
[ "$free_kb" -ge 3000000 ] || die "$work has under 3 GB free for the image"
echo "==> downloading $label"
curl -fsSL --retry 3 -o "$work/$image.sha256" "$base/$image.sha256" </dev/null
curl -fL --retry 3 --retry-delay 5 -o "$work/$image" "$base/$image" </dev/null
# The checksum file may name a versioned file the unversioned link points at,
# so compare the hash itself rather than run sha256sum -c on the file.
expected=$(awk 'length($1) == 64 && $1 ~ /^[0-9a-f]+$/ { print $1; exit }' "$work/$image.sha256")
[ -n "$expected" ] || die "no SHA-256 in $base/$image.sha256. Nothing written"
if [ -n "$reviewed_checksum" ] && [ "$expected" != "$reviewed_checksum" ]; then
  die "the published image checksum changed since review. Nothing written"
fi
echo "$expected  $work/$image" | sha256sum -c - || die "the download does not match $base/$image.sha256. Nothing written"

info=$(qemu-img info "$work/$image") || die "qemu-img cannot read the download. Nothing written"
format=$(printf '%s\n' "$info" | sed -n 's/^file format: //p')
needed=$(printf '%s\n' "$info" | sed -n 's/^virtual size: .*(\([0-9]*\) bytes)$/\1/p')
[ "$format" = qcow2 ] || die "the download is ${format:-not an image}, not qcow2. Nothing written"
[ -n "$needed" ] || die "cannot read the image's virtual size. Nothing written"
[ "$needed" -le "$size" ] || die "the image needs $(gib "$needed"), $target has $(gib "$size"). Nothing written"

# ── Write ────────────────────────────────────────────────────────────────────
# Look again: minutes have passed since the first look.
[ -b "$target" ] || die "$target is not a block device. Nothing written"
problems=$(target_problems)
[ -z "$problems" ] || die "$target changed since the plan: $problems. Nothing written"
if [ "$overwrite" = 1 ]; then
  # Without -f, wipefs itself refuses a device in use. It drops the old
  # partition table (the kernel forgets the partitions) and any backup GPT
  # header an earlier write left at the end of the disk.
  echo "==> erasing what $target holds"
  wipefs -a "$target" </dev/null
  udevadm settle 2>/dev/null || true
fi
echo "==> writing $image ($(gib "$needed")) to $target"
qemu-img convert -p -f qcow2 -O raw "$work/$image" "$target" </dev/null
sync
blockdev --rereadpt "$target" 2>/dev/null || true
udevadm settle 2>/dev/null || true
pttype=$(blkid -p -o export "$target" 2>/dev/null | sed -n 's/^PTTYPE=//p' || true)
[ -n "$pttype" ] || die "no partition table on $target after writing; not powering off. Look with: lsblk $target"
if [ "$pttype" = gpt ]; then
  # The image's backup GPT header sits at its own end, mid-disk here; move it
  # to the end of the disk so the first boot can grow the root partition.
  sfdisk --relocate gpt-bak-std "$target" >/dev/null 2>&1 \
    || echo "note: could not move the GPT backup header to the end of $target; growing the root partition at first boot does it" >&2
fi
sync
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL "$target"

cat <<EOF

Done: $label is on $target. The server powers off now; ssh reports the
connection closed. Next (deploy/vm/README.md, step 2): in the UpCloud hub,
Storage tab, detach the Debian disk, start the server, then on your machine
  ssh-keygen -R <ip>
  ssh $user@<ip>
EOF
systemctl poweroff
exit 0
}
