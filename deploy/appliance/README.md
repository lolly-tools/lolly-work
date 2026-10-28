# Lolly appliance

A disk image that boots into a working Lolly Work: openSUSE Leap 16.1
Immutable, Lolly Work and its PostgreSQL, HTTPS with the machine's own
certificate, an updater, and Cockpit as the host console. It is for the
Personal and Small team presets: a mini PC, a VM on a NAS or hypervisor, or a
KVM cloud. One image definition builds two runtime profiles:

- **k3s** (the default, `lolly-appliance-<version>-<arch>`): K3s, with Lolly
  Work installed by K3s's Helm controller. The recommended runtime on any
  machine with room for Kubernetes.
- **podman** (`lolly-appliance-podman-<version>-<arch>`): Podman containers
  defined by Quadlet units, for small machines. It idles in about half the
  memory and two thirds of the disk ([Measured](#measured)).

This is plan 324 milestone M1. It builds on the Leap 16.1 **release
candidate**; general availability is planned for 3 November 2026, and the move
to GA is a `transactional-update dup` (not yet tested, see
[Not done yet](#not-done-yet)).

| | k3s profile | podman profile |
|---|---|---|
| Base | Leap 16.1 Immutable RC, the Base flavour's package set: read-only btrfs root snapshots, `transactional-update`, `health-checker`, `rebootmgr`, SELinux enforcing, Combustion and Ignition, Podman | the same |
| Runtime | K3s v1.34.12+k3s1 and `k3s-selinux` 1.6, pinned with sha256 in [`appliance.lock.json`](appliance.lock.json) | Podman 5.8 with Quadlet units, from the Leap repository |
| Lolly Work | the release in [`deploy/marketplaces/release.json`](../marketplaces/release.json), installed by K3s's Helm controller from the chart in [`deploy/helm`](../helm) | the same release's server image as `lolly-work.service` |
| PostgreSQL | the release's `postgresImage`, one StatefulSet on K3s's local-path volume | the same image as `lolly-postgres.service`, data in `/var/lib/lolly/postgres` |
| HTTPS | K3s's Traefik on 443 with a self-signed certificate made at first boot; port 80 redirects | the release's `caddyImage` as `lolly-caddy.service`, the same certificate and redirect |
| Images | preloaded with K3s's own; first boot needs no registry | preloaded; first boot needs no registry |
| Secrets | made at first boot, kept as encrypted systemd credentials (TPM2-bound where present) | the same |
| Updates | `lolly-update` rewrites the `HelmChart` manifest | `lolly-update` writes new digests into the units |
| Host updates | `transactional-update` in `rebootmgr`'s window; a `health-checker` plugin rolls the host back if Lolly Work does not come up | the same |
| Host console | Cockpit and `cockpit-tukit`, socket-activated, port 9090 from local networks only | the same, plus `cockpit-podman` |
| Formats | one build gives a raw disk and a qcow2 of it, x86_64 and aarch64 | the same |

## How it works

**One release definition.** [`generate.py`](generate.py) reads `release.json`
and writes each profile's runtime files from its digest pins. For k3s, the
manifests K3s applies from `/var/lib/rancher/k3s/server/manifests`: a
`HelmChart` with the packaged chart and
[`k3s/values-appliance.yaml`](k3s/values-appliance.yaml) (server image by
digest), the PostgreSQL StatefulSet (image by digest), the namespace and the
HTTPS objects. For podman, the Quadlet units in [`podman/`](podman) with the
same server and PostgreSQL digests and the release's Caddy digest. Lolly
Work's settings are [`work-config.json`](work-config.json) on both profiles: it
lists every key of the chart's default `config`, so Helm's merge adds nothing
on k3s and both run the same configuration. Nothing is copied by hand;
`tests/appliance.test.ts` checks that. The image also carries `release.json`
itself, which is where `lolly-update` starts.

**Preloaded images.** [`fetch.py`](fetch.py) downloads the K3s binary, K3s's
airgap image archive and the `k3s-selinux` RPM and checks each against the
lock. For each release image it writes an OCI archive holding the release's
multi-architecture index unchanged plus this architecture's manifest, config
and layers, every blob checked against its digest. K3s imports such partial
archives and tags each image by the pinned digest, so the pods start offline.
On the podman profile, `lolly-appliance-images.service` loads the same
archives with `podman load` at first boot, which records the same digests,
and removes each archive once its image is in storage.

**PostgreSQL on k3s.** The chart does not bundle a database, so the appliance
adds the simplest one that fits: the release's own `postgres` image as a
one-replica StatefulSet in namespace `lolly`, data on K3s's local-path
provisioner under `/var/lib/rancher/k3s/storage` (outside the root snapshots,
so a host rollback leaves it alone; the image creates that directory so it
carries `k3s-selinux`'s `container_file_t` label), running as uid 999 with a
read-only root filesystem, and a NetworkPolicy that admits only the Work
release's pods. Work reaches it as `lolly-postgres.lolly.svc.cluster.local`.
K3s's network policy controller admits a new pod a moment after it starts,
so the chart's migration Job first waits for the database port
(`migrate.command` in the appliance's values).

**The podman profile.** Three Quadlet containers on one bridge network,
`lolly`:

- `lolly-postgres`: uid 999, data in `/var/lib/lolly/postgres`;
- `lolly-work`: the server image's own user, Work's settings in
  `/var/lib/lolly/work/instance.json`, migrations applied as it starts;
- `lolly-caddy`: Caddy as `nobody`, 443 and 80 published to 8443 and 8080, no
  admin endpoint.

Every container has a read-only root filesystem, no new privileges, every
capability dropped (Caddy keeps `NET_BIND_SERVICE`, because its binary
carries that file capability and the kernel will not start it otherwise),
images by digest with `Pull=never`, and a fixed SELinux category pair of its
own. The units are kept in `/var/lib/lolly/quadlet`, outside the root
snapshots like K3s's manifests, and linked from `/etc/containers/systemd`:
`/etc` is snapshotted, and a host rollback must never pair an older Work
image with a database a newer release has already migrated.

**Container network MTU (podman).** At each boot
`lolly-appliance-network.service` reads the MTU of the interface the machine
reaches the outside world through, and `lolly.network` creates the bridge
with it (`Options=mtu=${LOLLY_MTU}`, recreated at each boot). A bridge left at
1500 on MulgaDC Spinifex's 1442 link stalled large transfers in the Mulga
run; K3s's flannel sizes itself, the podman bridge did not.

**Secrets on podman.** Each unit has systemd decrypt only the credentials its
container needs (`LoadCredentialEncrypted=`), and
`/usr/libexec/lolly-appliance/container-files` writes them to
`/run/lolly/containers/<name>`: a tmpfs, owned by the container's user,
labelled `container_file_t` with that container's categories, and
bind-mounted read-only. Work reads its secrets into its environment as it
starts. Podman's own secrets are not used, because podman writes their values
into container storage under `/var`. The acceptance checks that the database
password appears nowhere on disk outside its encrypted credential.

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
   address and owner: on k3s to `lolly-work-instance.yaml`, a `HelmChartConfig`
   that K3s merges over the release values; on podman into
   `/var/lib/lolly/work/instance.json`. It is rewritten only when a value
   changes.
4. k3s: K3s starts (`selinux: true`, `secrets-encryption: true`, fixed node
   name `lolly` so a hostname change keeps PostgreSQL's volume), and
   `lolly-appliance-secrets.service` (every boot) has systemd decrypt the
   credentials for it alone and copies them into the three Kubernetes Secrets
   that Work, PostgreSQL and Traefik read, by server-side apply, so no copy sits
   in an annotation. podman: the images load, the network takes the host's
   MTU, and the three containers start, each with its own credentials on a
   tmpfs.
5. `lolly-appliance-console.service` waits for Work's `/readyz`, then writes the
   console text. Every console (screen and serial) shows the address, the
   certificate fingerprint and Cockpit's address. Only the machine's own screen
   (tty1) shows the one-time owner setup link from Work's
   `scripts/password-link.ts`, because serial consoles are often logged by a
   cloud or hypervisor. Until the owner has set a password, each boot shows a
   fresh link (a new link replaces the unused one; each works once, for 7 days).

**HTTPS.** On k3s the certificate becomes Traefik's default certificate (a
`TLSStore` named `default`); on podman Caddy serves it for any name, with
`default_sni`; so a browser or app that reaches the appliance by IP address
gets it. Work's `instance.baseUrl` is `https://<this machine's IPv4>` unless
`LOLLY_BASE_URL` says otherwise. Pairing the apps by QR code (plan 324 section
8) and a domain with ACME later replace the certificate and the base URL; the
rest stays as it is.

**Firewall.** firewalld allows SSH, HTTP and HTTPS; Cockpit only from
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7 and
fe80::/10; K3s's pod and service networks (k3s) or the `lolly` container
network (podman) are trusted. The Kubernetes API (6443) is not opened.

## Updates

**Lolly Work: `lolly-update`.** A timer runs `lolly-update run` daily at
02:30. It reads the channel, verifies the release, applies it through the
profile's runtime, waits for it to be ready and reverts on failure.

- **Channel.** The version tags of `ghcr.io/lolly-tools/lolly-work-server`:
  `stable` takes the highest `MAJOR.MINOR.PATCH`, `preview` includes
  pre-releases. Versions are Lolly's release numbers, the same as
  `release.json` and the image name.
- **Verification**, with `cosign` from the Leap repository, keyless, never
  relaxed. The release image must carry a signature whose certificate names
  `https://github.com/lolly-tools/lolly-work/.github/workflows/release.yml@refs/tags/v<version>`
  (issuer `https://token.actions.githubusercontent.com`), which binds the
  digest to that one version. On k3s the chart must be the one published for
  the version (release `chart-v<version>`), its Sigstore bundle naming
  `.../publish-helm.yml@refs/heads/main` and its `Chart.yaml` carrying that
  version. Every download uses the system's TLS trust store; the health checks
  connect to 127.0.0.1 and pin this machine's certificate by fingerprint.
- **Migrations.** Before anything changes, the new server image checks the
  database (`scripts/migrate.ts --check`). If it would migrate, `lolly-update`
  says so, stops Lolly Work (podman) and takes a `pg_dump` backup to
  `/var/lib/lolly/backups` first (the last three are kept). After a
  migrating update no plain rollback is offered: going back is
  `lolly-update rollback --restore`, which restores that backup and loses
  changes made since. After an update that ran no migration,
  `lolly-update rollback` puts the previous release back.
- **Apply and revert.** k3s: the `HelmChart` manifest gets the new image digest
  (and the new chart), and K3s's Helm controller upgrades the release with the
  chart's migration Job. podman: the units in `/var/lib/lolly/quadlet` get the
  new digests and restart. Then `/healthz` and `/readyz` must answer 200 and the
  new image must actually run within `LOLLY_UPDATE_TIMEOUT` (900 s). If not,
  the exact previous files go back, with the backup restored when the update
  migrated, and the timer does not try that release again by itself.
- **Commands.** `lolly-update status`, `check` (what the channel offers,
  verified), `apply [--version V]`, `apply --definition FILE` (a release
  definition in `release.json`'s form, from an administrator: its Lolly Work
  image must still verify as its version, while PostgreSQL and Caddy are taken
  as given), and `rollback [--restore]`. Settings: `LOLLY_UPDATE`
  (`auto`, `check` or `off`), `LOLLY_UPDATE_CHANNEL`, `LOLLY_UPDATE_TIMEOUT`.
- **Not yet in the channel.** PostgreSQL and Caddy pins move only with an
  administrator's definition: the release workflow does not yet publish a
  signed appliance definition. No chart has been published yet (the first is
  1.1.3), so until then a k3s appliance waits, and an administrator may apply a
  verified release with `--keep-chart`.

**The host: `transactional-update`, `rebootmgr` and `health-checker`.** The
host updates itself through `transactional-update` at 01:00 into a new root
snapshot, and `rebootmgr` reboots into it only between 04:00 and 05:30. On the
first boot of a new snapshot, the Lolly plugin for `health-checker`
(`/usr/libexec/health-checker/lolly-appliance.sh`) waits up to
`LOLLY_HEALTH_TIMEOUT` (900 s) for Lolly Work's `/healthz` and `/readyz` (and,
on k3s, K3s's API readiness). If they do not answer, the check fails and
`health-checker` makes the last good snapshot the default again and reboots
into it. On any other boot the plugin reports and passes, so a problem that
is Lolly Work's own never sends the machine into `health-checker`'s emergency
mode. `/var` (data, credentials, units, manifests, backups) is outside the
snapshots, so a host rollback leaves Lolly Work's state as it is.

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
| `LOLLY_UPDATE` | `auto` | `check` reports a verified release without applying it; `off` stops looking |
| `LOLLY_UPDATE_CHANNEL` | `stable` | `preview` includes pre-releases |
| `LOLLY_UPDATE_TIMEOUT` | `900` | seconds an update may take to become ready before it is reverted |
| `LOLLY_HEALTH_TIMEOUT` | `900` | seconds a new host snapshot may take to bring Lolly Work up before it is rolled back |

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
limactl shell lolly-kiwi -- sudo /path/to/lolly-work/deploy/appliance/build.sh --profile podman --out /var/tmp/lolly-out-podman
```

The Leap builder runs SELinux enforcing, and its kernel would refuse the
image's labels for types it does not know (Cockpit's, K3s's), so the build
needs the builder permissive; `build.sh` stops with that message otherwise. A
container on a host without SELinux, as in CI, needs nothing.

On an x86_64 Linux host, the same `build.sh` builds the x86_64 image. CI
(`.github/workflows/appliance.yml`) builds x86_64 in a privileged Leap 16.1
container, both profiles side by side, on every pull request that touches
`deploy/appliance`, the chart or `release.json`, checks the disk layout and
each profile's package list, and keeps the compressed raw disks as artifacts
for three days.

`build.sh [--profile k3s|podman]` steps: generate the profile's runtime files,
fetch and verify the pinned files, make a local package repository (with
`k3s-selinux` for k3s), assemble the description and its overlay (`kiwi/root`,
then `kiwi/root-<profile>`, then the generated files), and run
`kiwi-ng --profile <profile> --type oem system build`. The image carries the
Lolly release number from `release.json`, like everything else a person
installs (`generate.py` sets KIWI's `<version>` from it, and the test and CI
fail if they drift). Outputs: `lolly-appliance-<version>-<arch>.raw` (k3s) or
`lolly-appliance-podman-<version>-<arch>.raw`, the `.qcow2` of the same disk,
the package list and `SHA256SUMS`.

## Boot and accept

[`test/boot-qemu.sh`](test/boot-qemu.sh) copies the raw disk, grows it, writes
a Combustion script into its config partition and boots it under QEMU/KVM with
SSH, HTTPS, HTTP and Cockpit forwarded to 127.0.0.1. On a Mac it boots the
aarch64 image under Apple's hypervisor (HVF) instead, from a qcow2 overlay on
the image, with the script given through QEMU's `fw_cfg`. `--mtu 1442` gives
the guest a smaller network MTU, as on Spinifex.
[`test/accept.py`](test/accept.py) then checks it from outside and prints PASS
or FAIL per check and the measurements, without printing the owner link or any
secret. Run it again with `--after-reboot` after `systemctl reboot`:

```sh
deploy/appliance/test/boot-qemu.sh out/lolly-appliance-<version>-aarch64.qcow2 --combustion script --dir run --mtu 1442
deploy/appliance/test/accept.py --key key --state run/state.json
ssh -p 2222 root@127.0.0.1 systemctl reboot
deploy/appliance/test/accept.py --key key --state run/state.json --after-reboot
deploy/appliance/test/accept-updates.py --key key --state run/state.json --phase app --from 1.1.1 --to 1.1.2
deploy/appliance/test/accept-updates.py --key key --state run/state.json --phase host
kill "$(cat run/qemu.pid)"
```

`accept.py` reads the profile from the machine. [`test/accept-updates.py`](test/accept-updates.py)
covers updates. `--phase app` runs the channel check, two refusals (a release
image presented as another version, and one signed outside its release tag),
the migrating update with its backup, the refused plain rollback, the
restore, a forced failure that reverts, and an update without a migration with
its plain rollback. `--phase host` runs a host update that `health-checker`
keeps and a host snapshot with Lolly Work's runtime masked, which
`health-checker` rolls back. Both print one PASS or FAIL per check and the
measurements. `--ssh-host` reaches a machine by its address instead, for a
cloud test.

## Look after it

```sh
lolly-appliance status                  # release, address, certificate, readiness, pods
lolly-appliance owner-link              # a new one-time owner setup link
lolly-appliance owner-link --email ana@example.com   # change the owner first
lolly-appliance cockpit off             # stop Cockpit and close port 9090 (on reverses it)
```

```sh
lolly-update status                     # what runs, the channel, and what a rollback would do
lolly-update check                      # what the channel offers, verified
lolly-update apply                      # apply it now
lolly-update rollback [--restore]       # back to the previous release
```

On k3s, `kubectl` (as root) talks to K3s; on podman, `podman ps` and
`systemctl status lolly-work` show the containers, and Cockpit has a Podman
page. Host updates come from `transactional-update` in `rebootmgr`'s window, as
on any Leap 16.1 Immutable machine.

## Measured

Lolly Work 1.1.1 (chart 1.1.2), 27 October 2026, both aarch64 images built
from this directory and run one at a time, each with 2 vCPU and 4 GiB memory
under QEMU 11.1 with HVF on an Apple M4, the 20 GiB image on a 40 GiB disk, no
TPM, the network card at a 1442 MTU (Spinifex's), Combustion through
`fw_cfg`. Times are from QEMU's start (power-on) and from the machine's
journal; memory is `free`'s used and available.

| | k3s | podman |
|---|---|---|
| First boot: kernel, SSH, Work `/readyz` 200 | 12 s, 37 s, 117 s | 11 s, 31 s, 57 s |
| Memory at first readiness, and the peak until then | 1426 MiB used, peak 1425 MiB | 753 MiB used, peak 753 MiB |
| Reboot to Work `/readyz` 200, shutdown included | 82 s | 30 s |
| Memory idle, 9 min after the reboot | 1295 MiB used, 2613 MiB available | 597 MiB used, 3311 MiB available |
| Biggest processes, idle | K3s 677, Work 214, containerd 190, Traefik 100, CoreDNS 61 MiB | Work 219, Caddy 46, firewalld 46, PostgreSQL 27 MiB |
| Disk used (btrfs: root snapshots and `/var`) | 4.57 GiB (`/var/lib/rancher` 2.6 GiB) | 2.97 GiB (`/var/lib/containers` 1.8 GiB) |
| Update 1.1.1 -> 1.1.2 (6 migrations, backup first), its restore, and peak memory | 49 s, restore 29 s, peak 1403 MiB | 21 s, restore 7 s, peak 777 MiB |
| Forced host rollback (`LOLLY_HEALTH_TIMEOUT=240`): from the reboot into the bad snapshot to the restored one answering | 300 s | 286 s |
| qcow2 | 1.91 GB | 1.70 GB |
| Image build in the Lima VM (cold download cache, then warm) | 1119 s, 177 s | 821 s, 224 s |
| CI build, x86_64 (side by side) | 10 min | 9 min |

The podman profile idles in 46% of the k3s profile's memory and 65% of its
disk, and is ready in half the time. The package lists differ only by
`k3s-selinux` against `cockpit-podman`. These are the numbers plan 324 sets
the k3s threshold from: with 4 GiB, the k3s profile leaves 2.5 GiB free at
idle, and the podman profile 3.2 GiB.

Acceptance passed on both, first boot and after a reboot, with the checks of
the k3s slice below plus, for podman: each container as `container_t` with its
own category pair, the container network at the host's 1442 MTU (bridge and
container), the pinned digests loaded from the image with nothing pulled, and
the units linked from `/etc/containers/systemd` into `/var/lib/lolly/quadlet`.
On both, the decrypted database password appears nowhere on disk outside its
credential, except on k3s inside containerd's metadata (see
[Not done yet](#not-done-yet)). The renders were byte-identical across the two
profiles (SVG sha256 `28358ad6a32f5995...`, PNG `da253330e924b789...`).

Updates, with real releases: 1.1.1 and 1.1.2 are Lolly Work's published
images. 1.1.2's signature names `release.yml@refs/tags/v1.1.2`; 1.1.1's names
`release.yml@refs/heads/main` (it was signed by a dispatch from main), so the
updater refuses it as a target, which is right. Every Work release so far
migrates (1.1.0 to 1.1.1 has four migrations, 1.1.1 to 1.1.2 six), so the update
without a migration swaps the PostgreSQL 17 image for a newer published one
through `--definition`. On both profiles: the channel offered 1.1.2 verified
(on k3s it waits for the unpublished chart, so the update used
`--keep-chart`); a 1.1.2 image presented as 1.1.3 and the main-signed 1.1.1
were refused and changed nothing; the update said it migrates, took a backup
first and applied the six migrations (60 to 66 rows in `schema_migrations`);
the owner signed in and rendered on 1.1.2; a plain rollback was refused;
`rollback --restore` returned to 1.1.1 with 60 rows and the owner signing in;
the same update with a 1 s deadline reverted and restored its backup, and the
timer would not retry it; the update without a migration kept the plain
rollback, which returned to the previous PostgreSQL image with the data as it
was.

Host updates: the RC had no newer packages, so the host update was a real
`transactional-update pkg install jq` into a new snapshot, which the plugin
judged ready and `health-checker` kept. The forced rollback was a snapshot
made with `transactional-update run systemctl mask` of Lolly's runtime
(`k3s.service`, `lolly-work.service`): the plugin failed it after the 240 s
timeout, `health-checker` set the last good snapshot as default and rebooted,
and Lolly Work came back on the restored snapshot.

### The k3s slice

Work 1.1.1 (chart 0.3.3), 27 October 2026, both images built from this
directory. Two machines, each 2 vCPU and 4 GiB memory, the 20 GiB image on a
40 GiB disk, no TPM, Combustion from the config partition:

- **aarch64** on QEMU 11.1 with HVF on an Apple M4.
- **x86_64** (the CI build) on the MulgaDC Spinifex sandbox, a `c6a.large`
  instance from a custom image registered through volume, snapshot and
  `RegisterImage --boot-mode uefi`. Guest MTU 1442; K3s set flannel to 1392 by
  itself, so the container MTU stall seen with Docker does not arise.

These are the first numbers for the k3s threshold.

| | aarch64, HVF | x86_64, Spinifex |
|---|---|---|
| First boot to root SSH (Combustion applied) | 37 s to the login prompt | 51 s after launch |
| First boot to Work `/readyz` 200 | about 92 s (85 s after the kernel started) | about 96 s after launch (92 s after the kernel started) |
| Reboot to Work `/readyz` 200 | about 60 s (52 s after the kernel started) | 84 s including the shutdown (46 s after the kernel started) |
| Memory at first readiness | 1.37 GiB used of 3.8 GiB | 1.53 GiB used of 3.8 GiB |
| Memory idle after a reboot | 1.26 GiB used, 2.55 GiB available (13 min) | 1.28 GiB used, 2.54 GiB available (10 min) |
| Disk used | 4.5 GiB of the btrfs filesystem (root snapshots and `/var`) | 4.6 GiB |
| Renders, `qr-code` SVG and PNG | 1.7 s and 1.1 s; 1.0 s each after the reboot | 3.2 s and 0.9 s; 5.1 s and 2.7 s after the reboot |

On the aarch64 machine, idle: K3s 679 MiB, Work 218 MiB, containerd 203 MiB,
Traefik 104 MiB, CoreDNS 64 MiB, firewalld 49 MiB; `/var/lib/rancher` 2.6
GiB, of which the preloaded archives are 450 MiB and PostgreSQL 66 MiB. Image
files: raw 20 GiB apparent and 2.5 GiB allocated; qcow2 1.75 GiB (aarch64) and
1.84 GiB (x86_64). A build takes 9 to 11 min for aarch64 in the Lima VM with a
warm download cache and 5.5 min of KIWI for x86_64 in CI.

The renders were byte-identical across the two architectures and across each
reboot (SVG sha256 `28358ad6a32f5995...`, PNG `da253330e924b789...`).

Acceptance passed on both machines, first boot and after a reboot: Combustion
from the config partition, `/readyz` 200 on PostgreSQL in production mode,
HTTPS with the machine's own certificate, HTTP redirected, SELinux enforcing
with K3s's policy loaded and `container_runtime_t`/`container_t` labels, six
encrypted credentials and no Lolly secret in plain text, the console text
without the link and the link on tty1 only, the owner link working once, the
owner signing in by password, `qr-code` SVG and PNG renders, and Cockpit on
9090 (from the internet, port 9090 did not answer on Spinifex). On aarch64,
`lolly-appliance cockpit off` and `on` worked. Every pod image was "already
present on machine": nothing was pulled. A further first boot with a software
TPM (swtpm, under KVM) sealed the credentials to the host key and the TPM
(`systemd-creds` type host+TPM2-HMAC); without a TPM they are sealed to the
host key.

KVM nested inside the Lima VM booted and configured the machine correctly but
was too slow to measure: two starved vCPUs took six minutes to import one
image archive and the API timed out.

## Not done yet

The rest of M1, in order:

- **A signed release definition in the channel.** The release workflow signs
  the images and the chart, but not an appliance definition, so PostgreSQL and
  Caddy pins move only with an administrator's `--definition`. The fix is an
  attestation on the server image (`cosign attest`, same identity) that
  `lolly-update` reads.
- **The first published chart** (1.1.3): until then the k3s channel waits, and
  the positive chart verification has not run against a real bundle.
- **Secrets in containerd's metadata (k3s).** Kubernetes hands Work its
  environment with the Secret values resolved, and containerd keeps each
  container's spec, `DATABASE_URL` included, in its metadata database under
  `/var/lib/rancher`. The podman profile does not have this. The fix is to
  mount the chart's secrets as files from a memory-backed volume.
- **The RC to GA `transactional-update dup`**, as part of acceptance once GA
  ships; the RC had no newer packages, so the host update was a package
  installation.
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
- K3s itself is updated only with a new image; `lolly-update` updates Lolly
  Work, not the K3s binary.

## Files

| Path | |
|---|---|
| `appliance.lock.json` | K3s, airgap images and `k3s-selinux`: versions, URLs, sha256 |
| `generate.py` | release.json to either profile's runtime files (standard library, no network) |
| `work-config.json` | Lolly Work's settings, the same on both profiles |
| `fetch.py` | verified downloads and per-architecture OCI image archives |
| `build.sh` | the whole build, `--profile k3s` or `podman` |
| `k3s/` | manifest templates and the appliance's chart values |
| `podman/` | the Quadlet unit templates and the Caddyfile |
| `kiwi/lolly-appliance.kiwi`, `kiwi/config.sh`, `kiwi/disk.sh` | the KIWI description, derived from openSUSE's (MIT, see `LICENSE.kiwi`) |
| `kiwi/root/` | files in both images: first-boot scripts, `lolly-appliance`, `lolly-update` and its timer, the `health-checker` plugin, the maintenance windows |
| `kiwi/root-k3s/`, `kiwi/root-podman/` | each profile's own files: K3s and its secrets service; the image, network and container-files services |
| `test/` | QEMU boot (KVM or HVF) and acceptance, first boot and updates |
