# Lolly appliance (k3s profile)

A disk image that boots into a working Lolly Work: openSUSE Leap 16.1
Immutable, K3s, Lolly Work and its PostgreSQL, HTTPS with the machine's own
certificate, and Cockpit as the host console. It is for the Personal and Small
team presets: a mini PC, a VM on a NAS or hypervisor, or a KVM cloud.

This is the first slice of plan 324 milestone M1. It builds on the Leap 16.1
**release candidate**; general availability is planned for 3 November 2026,
and the move to GA is a `transactional-update dup` (not yet tested, see
[Not done yet](#not-done-yet)).

| | |
|---|---|
| Base | Leap 16.1 Immutable RC, the Base flavour's package set: read-only btrfs root snapshots, `transactional-update`, `health-checker`, `rebootmgr`, SELinux enforcing, Combustion and Ignition, Podman |
| Kubernetes | K3s v1.34.12+k3s1 and `k3s-selinux` 1.6, pinned with sha256 in [`appliance.lock.json`](appliance.lock.json) |
| Lolly Work | the release in [`deploy/marketplaces/release.json`](../marketplaces/release.json), installed by K3s's Helm controller from the chart in [`deploy/helm`](../helm) |
| PostgreSQL | the same release's `postgresImage`, one StatefulSet on K3s's local-path volume |
| Images | K3s's own images and the release images preloaded; first boot needs no registry |
| HTTPS | K3s's Traefik on 443 with a self-signed certificate made at first boot; port 80 redirects |
| Secrets | made at first boot, kept as encrypted systemd credentials (TPM2-bound where present) |
| Host console | Cockpit and `cockpit-tukit`, socket-activated, port 9090 from local networks only |
| Formats | one build gives a raw disk and a qcow2 of it, x86_64 and aarch64 |

## How it works

**One release definition.** [`generate.py`](generate.py) reads `release.json`
and the chart and writes the manifests K3s applies from
`/var/lib/rancher/k3s/server/manifests`: a `HelmChart` with the packaged chart
and [`k3s/values-appliance.yaml`](k3s/values-appliance.yaml) (server image by
digest), the PostgreSQL StatefulSet (image by digest), the namespace and the
HTTPS objects. The podman profile will be generated from the same file. Nothing
is copied by hand; `tests/appliance.test.ts` checks that.

**Preloaded images.** [`fetch.py`](fetch.py) downloads the K3s binary, K3s's
airgap image archive and the `k3s-selinux` RPM and checks each against the
lock. For each release image it writes an OCI archive holding the release's
multi-architecture index unchanged plus this architecture's manifest, config
and layers, every blob checked against its digest. K3s imports such partial
archives and tags each image by the pinned digest, so the pods start offline.

**PostgreSQL.** The chart does not bundle a database, so the appliance adds the
simplest one that fits: the release's own `postgres` image as a one-replica
StatefulSet in namespace `lolly`, data on K3s's local-path provisioner under
`/var/lib/rancher/k3s/storage` (outside the root snapshots, so a host rollback
leaves it alone), running as uid 999 with a read-only root filesystem, and a
NetworkPolicy that admits only the Work release's pods. Work reaches it as
`lolly-postgres.lolly.svc.cluster.local`.

**Production mode.** Work runs with `deployment.mode: production`, email and
password sign-in, gated access and `instance.catalogPublicationGeneration: 1`
for the unsigned demo pack inside the server image. There is no render worker
and no web app yet: the console (`/admin`) and API run, and Tier A tools such
as `qr-code` render in the server process (`render.allowHooksInFastPath` is
set for the curated demo pack, as on the hosted demo).

**First boot** (no network service is needed, nothing secret is in the image):

1. Combustion or Ignition, if configured, runs in the initrd (see below).
2. `lolly-appliance-firstboot.service` makes the secrets with `openssl`: the
   session, link and credential-sealing keys, the PostgreSQL password, the
   catalogue signing key (ECDSA P-256) and the HTTPS key. Each is stored with
   `systemd-creds encrypt --with-key=auto` in `/var/lib/lolly/credentials`:
   sealed to the TPM2 chip and the host key when the machine has a TPM, to the
   host key in `/var/lib/systemd` otherwise. `/var` is outside the root
   snapshots, so the secrets always match the database. The self-signed
   certificate names `lolly.local`, the hostname and the current IPv4
   addresses; its SHA-256 fingerprint is what app pairing will pin later.
3. `lolly-appliance-instance.service` (every boot) writes this machine's
   address and owner to `lolly-work-instance.yaml`, a `HelmChartConfig` that
   K3s merges over the release values. It is rewritten only when a value
   changes.
4. K3s starts (`selinux: true`, `secrets-encryption: true`, fixed node name
   `lolly` so a hostname change keeps PostgreSQL's volume).
5. `lolly-appliance-secrets.service` (every boot) has systemd decrypt the
   credentials for it alone and copies them into the three Kubernetes Secrets
   that Work, PostgreSQL and Traefik read, by server-side apply, so no copy sits
   in an annotation.
6. `lolly-appliance-console.service` waits for Work's `/readyz`, then writes the
   console text. Every console (screen and serial) shows the address, the
   certificate fingerprint and Cockpit's address. Only the machine's own screen
   (tty1) shows the one-time owner setup link from Work's
   `scripts/password-link.ts`, because serial consoles are often logged by a
   cloud or hypervisor. Until the owner has set a password, each boot shows a
   fresh link (a new link replaces the unused one; each works once, for 7 days).

**HTTPS.** The certificate becomes Traefik's default certificate (a `TLSStore`
named `default`), so a browser or app that reaches the appliance by IP address
gets it. Work's `instance.baseUrl` is `https://<this machine's IPv4>` unless
`LOLLY_BASE_URL` says otherwise. Pairing the apps by QR code (plan 324 section
8) and a domain with ACME later replace the certificate and the base URL; the
rest stays as it is.

**Firewall.** firewalld allows SSH, HTTP and HTTPS; Cockpit only from
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7 and
fe80::/10; K3s's pod and service networks are trusted. The Kubernetes API
(6443) is not opened.

## Configure the first boot

The appliance boots unattended. Root has no password and there is no
interactive setup on the console (`jeos-firstboot` does not run), so give
yourself a way in with Combustion or Ignition, and set Lolly's few options in
`/etc/lolly/appliance.conf` (every key is optional;
[`appliance.conf.example`](kiwi/root/usr/share/lolly-appliance/appliance.conf.example)):

| Key | Default | |
|---|---|---|
| `LOLLY_OWNER_EMAIL` | `owner@lolly.local` | the first owner's address, the one the setup link is for |
| `LOLLY_BASE_URL` | `https://` + this machine's IPv4 | the HTTPS address people use, no path |
| `LOLLY_INSTANCE_NAME` | `Lolly Work` | the workspace name |
| `LOLLY_COCKPIT` | `on` | `off` turns the Cockpit host console off |

A Combustion script that adds an SSH key and sets the owner:

```sh
#!/bin/bash
mkdir -p /root/.ssh && chmod 0700 /root/.ssh
echo 'ssh-ed25519 AAAA... you@example.com' >> /root/.ssh/authorized_keys
mkdir -p /etc/lolly
echo 'LOLLY_OWNER_EMAIL=ana@example.com' > /etc/lolly/appliance.conf
```

Where to put it:

- **The image's own config partition.** The disk carries a small FAT
  partition labelled `ignition` (`p.lxconfig`, 16 MiB). Write the script to
  `combustion/script` (or an Ignition config to `ignition/config.ign`) before
  the first boot. This is the route for clouds that import the raw disk, since
  a second launch volume was not seen at first boot on MulgaDC Spinifex. With
  mtools, on the raw disk:
  ```sh
  start=$(sfdisk --json disk.raw | python3 -c 'import json,sys; t=json.load(sys.stdin)["partitiontable"]; print([p["start"] for p in t["partitions"] if p.get("name")=="p.lxconfig"][0]*512)')
  mmd -i "disk.raw@@$start" ::combustion
  mcopy -i "disk.raw@@$start" script ::combustion/script
  ```
- **A USB stick or second disk** labelled `combustion` (or `ignition`) with the
  same layout. Use the label `combustion`: Combustion prefers it over the
  built-in partition.
- **QEMU**: `-fw_cfg name=opt/org.opensuse.combustion/script,file=script`.

Ignition's cloud metadata providers (EC2 user-data and others) need a per-cloud
kernel argument (`ignition.platform.id`), which this image does not set yet;
use the config partition there.

## Build

KIWI needs Linux, root and loop devices. On Apple silicon, a Lima VM with
nested virtualisation builds the aarch64 image natively and can boot it under
KVM for acceptance:

```sh
limactl create --name lolly-kiwi --vm-type vz --nested-virt --cpus 4 --memory 8 --disk 60 \
  https://download.opensuse.org/distribution/leap/16.1/appliances/Leap-16.1-Minimal-VM.aarch64-Cloud.qcow2
limactl start lolly-kiwi
limactl shell lolly-kiwi -- sudo zypper -n in --no-recommends python3-kiwi kiwi-systemdeps-disk-images \
  kiwi-systemdeps-filesystems kiwi-systemdeps-bootloaders createrepo_c dosfstools mtools \
  qemu-arm qemu-tools qemu-uefi-aarch64
limactl shell lolly-kiwi -- sudo setenforce 0
limactl shell lolly-kiwi -- sudo /path/to/lolly-work/deploy/appliance/build.sh --out /var/tmp/lolly-out
```

The Leap builder runs SELinux enforcing, and its kernel would refuse the
image's labels for types it does not know (Cockpit's, K3s's), so the build
needs the builder permissive; `build.sh` stops with that message otherwise. A
container on a host without SELinux, as in CI, needs nothing.

On an x86_64 Linux host, the same `build.sh` builds the x86_64 image. CI
(`.github/workflows/appliance.yml`) builds x86_64 in a privileged Leap 16.1
container on every pull request that touches `deploy/appliance`, the chart or
`release.json`, checks the disk layout and package list, and keeps the
compressed raw disk as an artifact for three days.

`build.sh` steps: generate the manifests, fetch and verify the pinned files,
make a local package repository for `k3s-selinux`, assemble the description
and its overlay (`kiwi/root` plus the generated files), and run
`kiwi-ng --profile k3s --type oem system build`. The image carries the
Lolly release number from `release.json`, like everything else a person
installs (`generate.py` sets KIWI's `<version>` from it, and the test and CI
fail if they drift). Outputs: `lolly-appliance-<version>-<arch>.raw`, the
`.qcow2` of the same disk, the package list and `SHA256SUMS`.

## Boot and accept

[`test/boot-qemu.sh`](test/boot-qemu.sh) copies the raw disk, grows it, writes
a Combustion script into its config partition and boots it under QEMU/KVM with
SSH, HTTPS, HTTP and Cockpit forwarded to 127.0.0.1.
[`test/accept.py`](test/accept.py) then checks it from outside and prints PASS
or FAIL per check and the measurements, without printing the owner link or any
secret. Run it again with `--after-reboot` after `systemctl reboot`:

```sh
deploy/appliance/test/boot-qemu.sh out/lolly-appliance-<version>-aarch64.raw --combustion script --dir run
deploy/appliance/test/accept.py --key key --state run/state.json
ssh -p 2222 root@127.0.0.1 systemctl reboot
deploy/appliance/test/accept.py --key key --state run/state.json --after-reboot
kill "$(cat run/qemu.pid)"
```

## Look after it

```sh
lolly-appliance status                  # release, address, certificate, readiness, pods
lolly-appliance owner-link              # a new one-time owner setup link
lolly-appliance owner-link --email ana@example.com   # change the owner first
lolly-appliance cockpit off             # stop Cockpit and close port 9090 (on reverses it)
```

`kubectl` (as root) talks to K3s. Host updates come from
`transactional-update` in `rebootmgr`'s window, as on any Leap 16.1 Immutable
machine.

## Measured

@MEASURED@

## Not done yet

The rest of M1, in order:

- **The podman profile**: Quadlet units generated from the same `release.json`,
  for machines below the k3s threshold.
- **The updater** (`lolly-update`): signed chart and digest updates through the
  `HelmChart` manifest, a `/healthz` check and revert, a stable and a preview
  channel; a `health-checker` plugin so a host update that breaks Lolly rolls
  the host back; the RC to GA `transactional-update dup` as part of
  acceptance.
- **Backups**: a nightly encrypted backup to a USB disk, network share or S3
  bucket, and a scheduled restore test.
- **Pairing**: the QR code with the certificate fingerprint for the apps, the
  customer setup flow (owner, backup target, domain) and ACME DNS-01 for a
  domain.
- **The web app and render worker**: the matching web app served by Work, and
  the Chromium worker for hooked tools.
- **The self-install ISO**, and building on **OBS** (swap the repositories for
  `obsrepositories:/` and provide `k3s-selinux` from a project).
- Ignition cloud providers (`ignition.platform.id`) per cloud image, a
  per-machine host admin for Cockpit when no Combustion config is given, and
  a decision on `kernel-firmware-all` (needed on bare metal, unused in VMs).

## Files

| Path | |
|---|---|
| `appliance.lock.json` | K3s, airgap images and `k3s-selinux`: versions, URLs, sha256 |
| `generate.py` | release.json and the chart to K3s manifests (standard library, no network) |
| `fetch.py` | verified downloads and per-architecture OCI image archives |
| `build.sh` | the whole build |
| `k3s/` | manifest templates and the appliance's chart values |
| `kiwi/lolly-appliance.kiwi`, `kiwi/config.sh`, `kiwi/disk.sh` | the KIWI description, derived from openSUSE's (MIT, see `LICENSE.kiwi`) |
| `kiwi/root/` | files in the image: units, first-boot scripts, `lolly-appliance`, K3s settings |
| `test/` | QEMU boot and acceptance |
