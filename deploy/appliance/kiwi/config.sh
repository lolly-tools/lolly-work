#!/bin/bash
# Image configuration for the Lolly appliance (k3s profile).
#
# Derived from config.sh in openSUSE's Leap 16.1 Immutable image description
# (https://src.opensuse.org/pool/Leap_immutable, branch leap-16.1-images):
#   Copyright (c) 2023 SUSE LLC, MIT licence (reproduced in ../LICENSE.kiwi).
# Changes: no jeos-firstboot, cloud-init or ModemManager; K3s, Lolly's
# first-boot services, Cockpit and the firewall are configured below.
# Lolly-specific parts: SPDX-License-Identifier: MPL-2.0

test -f /.kconfig && . /.kconfig
test -f /.profile && . /.profile

set -euxo pipefail

mkdir -p /var/lib/misc/reconfig_system

echo "Configure image: [$kiwi_iname]-[$kiwi_profiles]..."

CONSOLE_FONT="eurlatgr.psfu"

# Machine settings are made on the machine.
sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow
rm -f /etc/machine-id
rm -f /var/lib/zypp/AnonymousUniqueId

suseSetupProduct
baseSetRunlevel 3
suseImportBuildKey

# SELinux enforcing, as transactional-update setup-selinux configures it.
if [[ -e /etc/selinux/config ]]; then
	grep ^GRUB_CMDLINE_LINUX_DEFAULT /etc/default/grub | grep -q security=selinux || \
	    sed -i -e 's|\(^GRUB_CMDLINE_LINUX_DEFAULT=.*\)"|\1 security=selinux selinux=1"|g' "/etc/default/grub"
	sed -i -e 's|^SELINUX=.*|SELINUX=enforcing|g' \
	    -e 's|^SELINUXTYPE=.*|SELINUXTYPE=targeted|g' \
	    "/etc/selinux/config"
	test -f /.autorelabel && mv /.autorelabel /etc/selinux/.autorelabel
fi

systemctl enable NetworkManager
suseInsertService chronyd

echo FONT="$CONSOLE_FONT" >> /etc/vconsole.conf

chkstat --set --system

update-ca-certificates

for i in /usr/lib/rpm/gnupg/keys/gpg-pubkey*asc; do
    rpm --import "$i" || true
done

# snapper, as upstream
if [ "${kiwi_btrfs_root_is_snapshot-false}" = 'true' ]; then
	cp /usr/share/snapper/config-templates/default /etc/snapper/configs/root
	baseUpdateSysConfig /etc/sysconfig/snapper SNAPPER_CONFIGS root
	sed -i'' 's/^TIMELINE_CREATE=.*$/TIMELINE_CREATE="no"/g' /etc/snapper/configs/root
	sed -i'' 's/^NUMBER_LIMIT=.*$/NUMBER_LIMIT="2-10"/g' /etc/snapper/configs/root
	sed -i'' 's/^NUMBER_LIMIT_IMPORTANT=.*$/NUMBER_LIMIT_IMPORTANT="4-10"/g' /etc/snapper/configs/root
fi

# The %post script can't edit /etc/fstab sys due to https://github.com/OSInside/kiwi/issues/945
cat >/etc/fstab.script <<"EOF"
#!/bin/sh
set -eux
# Convert ro to ro=vfs (boo#1202000)
gawk -i inplace '$2 == "/" { sub(/ro/, "ro=vfs", $4); } { print $0 }' /etc/fstab
if [ "$(findmnt -snT / -o SOURCE)" != "$(findmnt -snT /var -o SOURCE)" ]; then
	gawk -i inplace '$2 == "/var" { $4 = $4",x-growpart.grow,x-systemd.growfs" } { print $0 }' /etc/fstab
fi
EOF
chmod a+x /etc/fstab.script

cat >/etc/dracut.conf.d/50-microos-growfs.conf <<"EOF"
install_items+=" /usr/lib/systemd/systemd-growfs "
EOF

#======================================
# Lolly appliance (k3s profile)
#--------------------------------------
# K3s: the binary in /usr/local/bin (outside the root snapshots, replaced by
# the appliance updater later) and the usual client links.
for tool in kubectl crictl ctr; do
	ln -sf k3s "/usr/local/bin/$tool"
done
chmod 0700 /var/lib/rancher/k3s/server
chmod 0755 /var/lib/rancher/k3s/agent /var/lib/rancher/k3s/agent/images
install -d -m 0700 /var/lib/lolly
install -d -m 0755 /etc/lolly

systemctl enable k3s.service
systemctl enable lolly-appliance-firstboot.service lolly-appliance-instance.service
systemctl enable lolly-appliance-secrets.service lolly-appliance-console.service
systemctl enable sshd.service
# Socket-activated: Cockpit uses no memory until someone opens it.
systemctl enable cockpit.socket

# Firewall: HTTP and HTTPS for Lolly Work, Cockpit from local networks only,
# K3s's pod and service networks trusted. The Kubernetes API (6443) stays closed.
systemctl enable firewalld.service
firewall-offline-cmd --zone=public --add-service=http --add-service=https
firewall-offline-cmd --zone=public --remove-service=cockpit || true
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
	firewall-offline-cmd --zone=public --add-rich-rule="rule family=\"ipv4\" source address=\"$net\" service name=\"cockpit\" accept"
done
for net in fc00::/7 fe80::/10; do
	firewall-offline-cmd --zone=public --add-rich-rule="rule family=\"ipv6\" source address=\"$net\" service name=\"cockpit\" accept"
done
firewall-offline-cmd --zone=trusted --add-source=10.42.0.0/16 --add-source=10.43.0.0/16

exit 0
