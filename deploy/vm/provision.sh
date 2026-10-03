#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Prepare the lolly.ing server: openSUSE Leap 16.0 from the Minimal-VM Cloud
# image (deploy/vm/README.md; bootstrap-opensuse.sh puts it on UpCloud), or
# Tumbleweed. Runs as root through sudo, as the cloud user cloud-init gave your
# ssh key (sles on Leap, opensuse on Tumbleweed). From your machine:
#
#   ssh sles@<vm-ip> 'sudo bash -s' < deploy/vm/provision.sh
#
# Idempotent: safe to run again. Before changing anything it refuses a root
# filesystem that did not grow to the disk at first boot. It installs updates,
# Docker with the compose and buildx plugins, rsync and openssl; lets ssh,
# http and https (and HTTP/3)
# through firewalld, then starts Docker, which adds its own zone; adds a 2 GB
# swap file with its SELinux label; turns on os-update's daily security
# updates, which reboot when an update needs it; sets the host name; turns off
# password and root logins over ssh, after checking the user keeps key logins;
# and creates /opt/lolly-ing (0700) owned by that user, who joins the docker
# group. SELinux stays enforcing: docker-compose.yml labels its bind mounts.
#
# Settings, given through sudo (ssh sles@<ip> 'sudo LOLLY_VM_HOSTNAME=x bash -s' < ...):
#   LOLLY_VM_USER      the account that deploys (default: the one that ran sudo)
#   LOLLY_VM_HOSTNAME  the host name (default lolly-ing)
set -euo pipefail

# One group, so `bash -s` reads the whole script before running any of it: a
# command below that reads standard input (a zypper prompt, say) cannot swallow
# the rest and leave the machine half provisioned with exit status 0.
{
die() { echo "provision.sh: $*" >&2; exit 1; }

os_release=${LOLLY_OS_RELEASE:-/etc/os-release}
[ -r "$os_release" ] || die "cannot read $os_release"
# shellcheck source=/dev/null
. "$os_release"
case "${ID:-}" in
  opensuse-leap)
    version=${VERSION_ID:-0}
    if ! [ "${version%%.*}" -ge 16 ] 2>/dev/null; then
      die "written for openSUSE Leap 16; this is ${PRETTY_NAME:-openSUSE Leap $version}"
    fi
    flavour=leap
    ;;
  opensuse-tumbleweed) flavour=tumbleweed ;;
  *)
    die "written for openSUSE Leap 16 (or Tumbleweed) from the Minimal-VM Cloud image; this is ${PRETTY_NAME:-unknown}. deploy/vm/README.md puts Leap on an UpCloud server with bootstrap-opensuse.sh"
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  die "run as root through sudo: ssh sles@<vm-ip> 'sudo bash -s' < deploy/vm/provision.sh"
fi
user=${LOLLY_VM_USER:-${SUDO_USER:-}}
if [ -z "$user" ] || [ "$user" = root ]; then
  die "cannot tell which account deploys: run through sudo as the cloud user (sles on Leap, opensuse on Tumbleweed), or set LOLLY_VM_USER"
fi
id "$user" >/dev/null 2>&1 || die "no account $user on this machine"
group=$(id -gn "$user")
home=$(getent passwd "$user" | cut -d: -f6)
# The ssh settings below allow keys only: without a key for this user, nobody
# could log in again.
if [ ! -s "$home/.ssh/authorized_keys" ]; then
  die "$user has no key in $home/.ssh/authorized_keys, and ssh is about to allow keys only. Was the server deployed with the metadata service on and your ssh key?"
fi
# The Cloud image is 1.4 GiB. Its root partition and filesystem are meant to
# grow to the whole disk at first boot (kiwi's repart in the initrd,
# cloud-init's growpart); if they did not, the updates, Docker and the swap
# file below run out of space half way through. bootstrap-opensuse.sh writes a
# disk of 20 GiB or more, so a / under 15 GiB was not grown.
root_src=$(findmnt -n -o SOURCE /) || die "cannot find the device mounted at /"
root_src=${root_src%%\[*}
root_kib=$(df -Pk / | awk 'NR == 2 { print $2 }')
if [ "${root_kib:-0}" -lt $((15 * 1024 * 1024)) ]; then
  root_fs=$(findmnt -n -o FSTYPE /)
  root_disk=$(lsblk -no PKNAME "$root_src" 2>/dev/null | sed -n 1p)
  root_part=$(cat "/sys/class/block/${root_src#/dev/}/partition" 2>/dev/null || true)
  case "$root_fs" in
    xfs) grow_fs='xfs_growfs /' ;;
    btrfs) grow_fs='btrfs filesystem resize max /' ;;
    ext4) grow_fs="resize2fs $root_src" ;;
    *) grow_fs="(grow the $root_fs filesystem on /)" ;;
  esac
  die "/ is only $(df -Ph / | awk 'NR == 2 { print $2 }') ($root_src, $root_fs): it was not grown to the disk at first boot. Nothing changed. Grow it, check with 'df -h /', then run this again: sudo growpart /dev/${root_disk:-<disk>} ${root_part:-<partition number>} && sudo $grow_fs"
fi
host=${LOLLY_VM_HOSTNAME:-lolly-ing}
reboot_needed=0
export ZYPP_LOCK_TIMEOUT=300

# zyp: zypper without prompts. Exit codes from 100 up are information, not
# failure, except 104 (a package name that does not exist).
zyp() {
  local rc=0
  zypper --non-interactive "$@" </dev/null || rc=$?
  case "$rc" in
    0) ;;
    102) reboot_needed=1 ;;            # an update needs a reboot
    103) zyp "$@" ;;                   # zypper updated itself: run again
    106|107) echo "provision.sh: zypper $1 finished with warnings (exit $rc)" >&2 ;;
    *) die "zypper $* failed (exit $rc)" ;;
  esac
}

echo "==> system updates (${PRETTY_NAME:-$ID})"
zyp refresh
if [ "$flavour" = leap ]; then zyp update; else zyp dist-upgrade; fi

echo "==> Docker, compose and buildx, firewalld, os-update, SELinux tools, rsync"
zyp install docker docker-compose docker-buildx firewalld os-update \
  policycoreutils-python-utils rsync openssl curl

echo "==> firewall (firewalld): ssh, http, https and HTTP/3"
systemctl enable --now firewalld
changed=0
for service in ssh http https; do
  if ! firewall-cmd --permanent --query-service="$service" >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service="$service" >/dev/null
    changed=1
  fi
done
if ! firewall-cmd --permanent --query-port=443/udp >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=443/udp >/dev/null
  changed=1
fi
if [ "$changed" = 1 ]; then firewall-cmd --reload >/dev/null; fi
echo "zone $(firewall-cmd --get-default-zone): $(firewall-cmd --list-services) $(firewall-cmd --list-ports)"

echo "==> Docker"
# After firewalld: Docker adds its interfaces to a docker zone of its own when
# it starts. Ports it publishes bypass the rules above, so docker-compose.yml
# publishes only Caddy's 80 and 443, and the server on 127.0.0.1.
systemctl enable --now docker
usermod -aG docker "$user"

echo "==> swap: 2 GB /swapfile"
# grep without -q reads all of swapon's output, so pipefail never sees a SIGPIPE.
if ! swapon --show=NAME --noheadings | grep -x /swapfile >/dev/null; then
  if [ ! -f /swapfile ]; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  # SELinux refuses swapon on a file without the swapfile_t type.
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
    semanage fcontext -a -t swapfile_t /swapfile 2>/dev/null || semanage fcontext -m -t swapfile_t /swapfile
    restorecon /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab

echo "==> automatic updates (os-update.timer, daily)"
# Leap: security patches only. Tumbleweed keeps os-update's default, a full
# distribution upgrade. Either reboots when an update needs it; the containers
# come back with Docker (restart: unless-stopped).
if [ "$flavour" = leap ]; then
  printf 'UPDATE_CMD="security"\nREBOOT_CMD="reboot"\n' > /etc/os-update.conf
else
  printf 'REBOOT_CMD="reboot"\n' > /etc/os-update.conf
fi
systemctl enable --now os-update.timer

echo "==> host name: $host"
hostnamectl set-hostname "$host"
if [ -d /etc/cloud/cloud.cfg.d ]; then
  echo 'preserve_hostname: true' > /etc/cloud/cloud.cfg.d/99-host.cfg
fi

echo "==> ssh: keys only, no root login"
# sshd keeps the first value it reads; this file sorts before cloud-init's
# 50-cloud-init.conf. It goes in place, sshd -t checks the whole
# configuration, and only then does sshd reload; a rejected file is taken out.
install -d -m 0755 /etc/ssh/sshd_config.d
conf=/etc/ssh/sshd_config.d/00-hardening.conf
backup=''
# The copy stays beside it, under a name sshd does not include, so it keeps
# the directory's SELinux label when it goes back.
if [ -f "$conf" ]; then backup=$conf.previous; cp -p "$conf" "$backup"; fi
cat > "$conf.new" <<'EOF'
# deploy/vm/provision.sh: keys only, no root login. Sorts before 50-cloud-init.conf.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthenticationMethods publickey
EOF
chmod 0644 "$conf.new"
mv "$conf.new" "$conf"
restorecon "$conf" 2>/dev/null || true
restore_sshd() {
  if [ -n "$backup" ]; then mv "$backup" "$conf"; else rm -f "$conf"; fi
}
if ! sshd -t; then
  restore_sshd
  die "sshd -t rejects the ssh settings; they were taken back and sshd was not reloaded"
fi
# The settings a login by $user would get, Match blocks applied.
effective=$(sshd -T -C "user=$user,host=operator.invalid,addr=192.0.2.1" 2>/dev/null || sshd -T 2>/dev/null || true)
if ! grep -qx 'pubkeyauthentication yes' <<<"$effective"; then
  restore_sshd
  die "cannot confirm that key logins stay on for $user (sshd -T), and keys-only would then lock everyone out; the settings were taken back and sshd was not reloaded"
fi
for want in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'permitrootlogin no' 'authenticationmethods publickey'; do
  grep -qx "$want" <<<"$effective" || echo "WARNING: sshd does not end up with '$want'; another file in /etc/ssh/sshd_config.d sets it first" >&2
done
[ -z "$backup" ] || rm -f "$backup"
systemctl reload sshd

echo "==> deploy directory /opt/lolly-ing (0700, $user)"
# The deploy user owns it: push.sh copies with rsync as that user, secrets.sh
# writes .env (0600) as that user, and docker compose runs through sudo.
for dir in /opt/lolly-ing /opt/lolly-ing/caddy /opt/lolly-ing/packs /opt/lolly-ing/src; do
  install -d -m 0700 -o "$user" -g "$group" "$dir"
  chown "$user:$group" "$dir"
done
chmod 0700 /opt/lolly-ing
if [ -f /opt/lolly-ing/.env ]; then
  chown "$user:$group" /opt/lolly-ing/.env
  chmod 0600 /opt/lolly-ing/.env
fi

docker --version
docker compose version
docker buildx version
echo "SELinux: $(getenforce 2>/dev/null || echo unknown); Docker security options: $(docker info --format '{{join .SecurityOptions " "}}' 2>/dev/null || echo unknown)"
rc=0
zypper --non-interactive needs-rebooting >/dev/null 2>&1 </dev/null || rc=$?
if [ "$reboot_needed" = 1 ] || [ "$rc" = 102 ]; then
  echo "NOTE: the updates ask for a reboot. Run 'ssh $user@<vm-ip> sudo reboot' now, before the first deploy."
fi
echo "provisioned. $user joins the docker group at the next login. Next, from your machine: deploy/vm/secrets.sh and deploy/vm/push.sh"
}
