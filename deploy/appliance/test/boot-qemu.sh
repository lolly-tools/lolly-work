#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
# Boot a built appliance disk under QEMU/KVM for acceptance, the way a person
# would: a copy of the raw disk grown to --disk, with a Combustion script
# written into the image's own config partition (label "ignition"), as on a
# cloud that does not attach a second launch volume.
#
#   deploy/appliance/test/boot-qemu.sh IMAGE.raw --combustion SCRIPT --dir RUNDIR
#       [--disk 40G] [--memory 4096] [--cpus 2] [--ssh 2222] [--https 8443] [--http 8080] [--cockpit 9090]
#
# Needs qemu-system-<arch> with KVM, UEFI firmware (qemu-uefi-aarch64 or
# qemu-ovmf-x86_64), mtools and sfdisk. Ports are forwarded on 127.0.0.1 only.
# The serial console is logged to RUNDIR/serial.log; stop with
#   kill "$(cat RUNDIR/qemu.pid)"
set -euo pipefail

image=${1:?usage: boot-qemu.sh IMAGE.raw --combustion SCRIPT --dir RUNDIR}; shift
combustion= dir= disk=40G memory=4096 cpus=2 ssh=2222 https=8443 http=8080 cockpit=9090
while [ $# -gt 0 ]; do
  case $1 in
    --combustion) combustion=$2; shift 2 ;;
    --dir) dir=$2; shift 2 ;;
    --disk) disk=$2; shift 2 ;;
    --memory) memory=$2; shift 2 ;;
    --cpus) cpus=$2; shift 2 ;;
    --ssh) ssh=$2; shift 2 ;;
    --https) https=$2; shift 2 ;;
    --http) http=$2; shift 2 ;;
    --cockpit) cockpit=$2; shift 2 ;;
    *) echo "boot-qemu.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$dir" ] || { echo "boot-qemu.sh: --dir is required" >&2; exit 2; }
mkdir -p "$dir"
run=$dir/disk.raw

cp --sparse=always "$image" "$run"
truncate -s "$disk" "$run"

if [ -n "$combustion" ]; then
  # The config partition: find its offset and write combustion/script into it.
  start=$(sfdisk --json "$run" | python3 -c 'import json,sys; t=json.load(sys.stdin)["partitiontable"]; print([p["start"] for p in t["partitions"] if p.get("name")=="p.lxconfig"][0] * t.get("sectorsize", 512))')
  mmd -i "$run@@$start" ::combustion 2>/dev/null || true
  mcopy -o -i "$run@@$start" "$combustion" ::combustion/script
  mdir -i "$run@@$start" ::combustion
fi

arch=$(uname -m)
forward="hostfwd=tcp:127.0.0.1:$ssh-:22,hostfwd=tcp:127.0.0.1:$https-:443,hostfwd=tcp:127.0.0.1:$http-:80,hostfwd=tcp:127.0.0.1:$cockpit-:9090"
case $arch in
  aarch64)
    cp /usr/share/qemu/aavmf-aarch64-vars.bin "$dir/vars.bin"
    qemu=(qemu-system-aarch64 -machine virt,gic-version=host -cpu host
      -drive if=pflash,format=raw,readonly=on,file=/usr/share/qemu/aavmf-aarch64-code.bin
      -drive if=pflash,format=raw,file="$dir/vars.bin") ;;
  x86_64)
    cp /usr/share/qemu/ovmf-x86_64-vars.bin "$dir/vars.bin"
    qemu=(qemu-system-x86_64 -machine q35 -cpu host
      -drive if=pflash,format=raw,readonly=on,file=/usr/share/qemu/ovmf-x86_64-code.bin
      -drive if=pflash,format=raw,file="$dir/vars.bin") ;;
  *) echo "boot-qemu.sh: $arch is not supported" >&2; exit 1 ;;
esac

"${qemu[@]}" -accel kvm -smp "$cpus" -m "$memory" \
  -drive file="$run",if=virtio,format=raw,cache=writeback,discard=unmap \
  -netdev "user,id=n0,$forward" -device virtio-net-pci,netdev=n0 \
  -device virtio-rng-pci \
  -display none -serial "file:$dir/serial.log" \
  -monitor "unix:$dir/monitor.sock,server,nowait" \
  -pidfile "$dir/qemu.pid" -daemonize
date +%s > "$dir/started"
echo "booting $(basename "$image") ($arch, $cpus vCPU, $memory MiB, disk $disk); serial log $dir/serial.log"
