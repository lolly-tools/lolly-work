#!/bin/bash
# Image configuration for the Lolly appliance (k3s and podman profiles).
#
# Derived from config.sh in openSUSE's Leap 16.1 Immutable image description
# (https://src.opensuse.org/pool/Leap_immutable, branch leap-16.1-images):
#   Copyright (c) 2023 SUSE LLC, MIT licence (reproduced in ../LICENSE.kiwi).
# Changes: no jeos-firstboot, cloud-init or ModemManager; K3s or the Lolly
# containers, Lolly's first-boot services, the updater, Cockpit and the
# firewall are configured below.
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
# The Combustion/Ignition config partition is read by label at first boot only.
gawk -i inplace '$2 == "/var/lib/lolly/config-partition" { $4 = $4",noauto,nofail" } { print $0 }' /etc/fstab
EOF
chmod a+x /etc/fstab.script

cat >/etc/dracut.conf.d/50-microos-growfs.conf <<"EOF"
install_items+=" /usr/lib/systemd/systemd-growfs "
EOF

#======================================
# Lolly appliance, both profiles
#--------------------------------------
case ",${kiwi_profiles}," in
	*,podman,*) profile=podman ;;
	*) profile=k3s ;;
esac
echo "Lolly appliance profile: $profile"

# container-selinux adds its modules in %posttrans, after the %post of
# passt-selinux and k3s-selinux has already tried to add theirs, which build on
# the container module and so fail. Add the missing ones now, in one
# transaction, and stop if a policy the profile needs is still not there.
missing=()
for pp in /usr/share/selinux/packages/targeted/passt.pp /usr/share/selinux/packages/targeted/pasta.pp \
          /usr/share/selinux/packages/targeted/passt-repair.pp /usr/share/selinux/packages/targeted/pesto.pp \
          /usr/share/selinux/packages/k3s.pp; do
	name=$(basename "$pp" .pp)
	if [ -f "$pp" ] && ! semodule -l | grep -qx "$name"; then
		missing+=("$pp")
	fi
done
if [ ${#missing[@]} -gt 0 ]; then
	semodule -n -s targeted -X 200 -i "${missing[@]}"
fi
semodule -l | grep -qx container
if [ "$profile" = k3s ]; then
	semodule -l | grep -qx k3s
fi

install -d -m 0700 /var/lib/lolly
install -d -m 0700 /var/lib/lolly/config-partition
install -d -m 0755 /etc/lolly

systemctl enable lolly-appliance-firstboot.service lolly-appliance-instance.service
systemctl enable lolly-appliance-console.service
systemctl enable lolly-update.timer
# Host updates: a daily transactional-update, rebooting in rebootmgr's window;
# health-checker (with Lolly's plugin) rolls a host update back if it breaks
# Lolly Work.
systemctl enable transactional-update.timer rebootmgr.service health-checker.service
systemctl enable sshd.service
# Socket-activated: Cockpit uses no memory until someone opens it.
systemctl enable cockpit.socket

# Firewall: HTTP and HTTPS for Lolly Work, Cockpit from local networks only.
systemctl enable firewalld.service
firewall-offline-cmd --zone=public --add-service=http --add-service=https
firewall-offline-cmd --zone=public --remove-service=cockpit || true
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
	firewall-offline-cmd --zone=public --add-rich-rule="rule family=\"ipv4\" source address=\"$net\" service name=\"cockpit\" accept"
done
for net in fc00::/7 fe80::/10; do
	firewall-offline-cmd --zone=public --add-rich-rule="rule family=\"ipv6\" source address=\"$net\" service name=\"cockpit\" accept"
done

if [ "$profile" = k3s ]; then
	# K3s: the binary in /usr/local/bin (outside the root snapshots) and the
	# usual client links.
	for tool in kubectl crictl ctr; do
		ln -sf k3s "/usr/local/bin/$tool"
	done
	chmod 0700 /var/lib/rancher/k3s/server
	chmod 0755 /var/lib/rancher/k3s/agent /var/lib/rancher/k3s/agent/images
	# The local-path volumes' parent, made here so the build labels it from
	# k3s-selinux's file contexts (container_file_t). Made at run time by K3s
	# (spc_t), it would take its parent's container_var_lib_t, which the
	# provisioner's helper pod may not write to.
	install -d -m 0711 /var/lib/rancher/k3s/storage
	systemctl enable k3s.service lolly-appliance-secrets.service
	# K3s's pod and service networks are trusted. The Kubernetes API (6443)
	# stays closed.
	firewall-offline-cmd --zone=trusted --add-source=10.42.0.0/16 --add-source=10.43.0.0/16
else
	# Podman: Quadlet generates lolly-postgres, lolly-work and lolly-caddy from
	# the units linked in /etc/containers/systemd (their [Install] sections
	# enable them). The release images load from /var/lib/lolly/images at first
	# boot.
	chmod 0700 /var/lib/lolly/quadlet
	chmod 0700 /var/lib/lolly/images
	systemctl enable lolly-appliance-images.service
	# The Lolly container network is trusted, as K3s's pod network is.
	firewall-offline-cmd --zone=trusted --add-source=10.89.0.0/24
	if [ -f /usr/lib/systemd/system/netavark-firewalld-reload.service ]; then
		systemctl enable netavark-firewalld-reload.service
	fi
fi

exit 0
