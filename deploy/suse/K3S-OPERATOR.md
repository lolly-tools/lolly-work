# K3s candidate installation and qualification

This workflow stages a **new dedicated amd64 or arm64 SLES/openSUSE candidate**,
including a transactional openSUSE Leap 16.1 Immutable host, on either
[UpCloud](../upcloud/README.md) or [Evroc](../evroc/README.md). It never adopts a
running Compose host, creates cloud resources, changes DNS or moves a database.
Keep the existing Compose origin/database available during rehearsal. Source
checks do not qualify actual provider access, host boot or application recovery.

`k3s.lock.json` (amd64) and `k3s.arm64.lock.json` (arm64) pin `v1.34.12+k3s1`,
the official binary checksum for each architecture from the release's
`sha256sum-amd64.txt` and `sha256sum-arm64.txt`, and the same installer at an
immutable commit with a separate SHA-256. The helper picks the lock from
`uname -m` (`x86_64` or `aarch64`) and refuses any other architecture. This
patch matches the current Kubernetes 1.34 chart/schema lane. It is a candidate
selection, not a support claim for every OS image. Review the
[SUSE support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/)
and release maintenance before choosing a host. Other architectures, SLE Micro
and Leap Micro hosts (their `ID` is not on the reviewed list), joining and
upgrades need separate qualification.

## Prepare the candidate and its network

Use the four-vCPU/eight-GiB/eighty-GB starting benchmark in [README.md](README.md).
The helper requires four CPUs, seven usable GiB, cgroup v2, no active swap and
forty GiB free for images, restore and rollback. These are starting gates, not
measured capacity. It refuses existing K3s/RKE2 data, Docker/Caddy units and
occupied HTTP/API ports. Provisioning and cost review remain separate actions.
Do not run it on the existing small production host.

Review/install Bash, Python 3, curl, coreutils (`sha256sum`), iproute2 (`ip`/`ss`),
systemd, RPM and firewalld in the selected OS image. The helper disables no
security controls and installs no OS packages, with one exception: on a
[transactional host](#transactional-hosts) it installs the SUSE `k3s-selinux`
policy into a new snapshot. Enforcing SELinux requires the matching
`k3s-selinux` policy package; the configuration then enables SELinux.
Permissive SELinux is refused. Disabled SELinux is an existing OS posture, not an
action taken by the helper; review AppArmor separately. This is not CIS certification.

An installed RPM alone does not prove its module loaded. Preflight verifies the
RPM, loaded `k3s` module and expected executable/snapshot contexts. It looks each
path up as the file type K3s creates there: `/usr/local/bin/k3s` and the runc
shim `data/current/bin/containerd-shim-runc-v2` as files
(`container_runtime_exec_t`) and the overlayfs snapshot directory as a directory
(`container_file_t`). SUSE's `k3s-selinux` 1.4.stable.1 maps `data/*/bin/runc`
to `k3s_root_t`, because its `bin(/.*)?` rule sorts after the runc rule, so runc
is not a usable probe. K3s labels runc `container_runtime_exec_t` itself when it
unpacks; on Leap 16.1 pods still started, with no AVC denials, after `restorecon`
had relabelled runc `k3s_root_t`. If the signed
SUSE package script did not activate its intact policy, inspect the error and
explicitly load only `/usr/share/selinux/packages/k3s.pp` with `semodule -X 200 -i`
while remaining Enforcing. Do not generate a permissive policy from denied calls.
Staging applies `restorecon` only to the binary, generated service and K3s data
tree, then checks labels and Enforcing again before any first start. The upstream
installer's skipped RPM path also skips its executable labelling, so this
readback is required even when the policy package was installed separately.

The signed SUSE policy RPM may create and label an empty K3s data scaffold before
the binary is installed. The helper permits only its exact directory tree
(`agent/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots` and `data`)
with the policy RPM installed, literal nonsymlink path, root ownership and no
group/world write bits. Its installed vendor must match the reviewed SUSE RPM;
the operator must still install it through the signed OS repository. Every
file, link, unexpected directory or existing
configuration/binary/unit remains refused. This exception preserves the policy
labels; it neither deletes initialized data nor adopts another cluster.

K3s needs an API listener reachable from pods. The helper keeps normal listener
and advertise semantics; **administrative reachability** is firewall-scoped with
SSH-tunnel access. Binding the entire listener to loopback could break the
in-cluster endpoint. Select an assigned RFC1918 node IP outside pod
`10.42.0.0/16` and service `10.43.0.0/16`; check provider/VPN route overlap first.

Review IPv4 and IPv6, or verify the unused family is disabled. The provider edge
may permit narrow administrator SSH and, after ingress qualification, HTTP/HTTPS.
Never expose 6443, 10250, 2379/2380, 8472, 51820/51821 or NodePorts. The resource
modules retain their own network contract and are not altered by this helper.
Actual provider API/console review is required, not an assumed default.

On the **new candidate only**, follow the
[K3s host requirements](https://docs.k3s.io/installation/requirements):

```sh
PUBLIC_IF=ens3 # Use the actual external interface.
sudo firewall-cmd --permanent --zone=public --change-interface="$PUBLIC_IF"
sudo firewall-cmd --permanent --zone=public --add-service=ssh
sudo firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
sudo firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16
sudo firewall-cmd --reload
```

firewalld 2.3.2 on openSUSE Leap 16.1 ships a `docker` zone (target `ACCEPT`)
bound to `docker0`. It is listed as an active zone even when no `docker0`
interface exists, and the helper refuses it as an unreviewed zone. Remove the
binding from the permanent and the runtime configuration; `--reload` keeps
runtime interface bindings because the shipped `FlushAllOnReload=no`:

```sh
sudo firewall-cmd --permanent --zone=docker --remove-interface=docker0
sudo firewall-cmd --reload
sudo firewall-cmd --zone=docker --remove-interface=docker0
sudo firewall-cmd --get-active-zones
```

Keep firewalld active. The helper refuses extra public ports/services, custom
rich/forwarding rules, accepting public zones, unreviewed active zones and
trusted host interfaces. Trusted sources must be exactly the pod/service ranges;
runtime and permanent rules must agree. Broader corporate integrations need a
reviewed adapter; do not disable this guard. Check NetworkManager's persistent
interface zone and repeat preflight after reboot. Inspecting rules is not an
external port scan: independently prove the denied ports stay unreachable after
K3s boots, including NodePort/NAT behavior and both address families.

An edge may optionally expose UDP 443 for HTTP/3. Add only that explicit port to
both reviewed provider rules and the permanent/runtime public host zone. Other
public UDP ports, including overlay and control-plane transports, are refused.

Retain a sanitized provider rule record without account IDs or credentials and a
0600 review receipt. This structure records an operator review, not automatic
proof of cloud state. A review older than 24 hours is refused:

```json
{
  "provider": "upcloud",
  "reviewedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIMESTAMP",
  "reviewedRulesSha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
  "controlPlanePublic": false,
  "nodePortsPublic": false,
  "dualStackReviewed": true,
  "publicTcpPorts": [22, 80, 443],
  "publicUdpPorts": [],
  "sshSourceCidrs": ["203.0.113.9/32"],
  "statelessFirewall": true,
  "hostConnectionTrackingRequired": true,
  "kernelEphemeralPortRange": {"start": 32768, "end": 60999},
  "dnsReturnPortRange": {"start": 1024, "end": 65535},
  "trustedDnsResolverCidrs": ["REPLACE_WITH_MEASURED_RESOLVER_IP/32"],
  "statelessReturnRules": [
    {"family":"IPv4","protocol":"tcp","sourcePort":443,"sourceCidrs":["0.0.0.0/0"],"destinationPortRange":{"start":32768,"end":60999}},
    {"family":"IPv4","protocol":"tcp","sourcePort":53,"sourceCidrs":["REPLACE_WITH_MEASURED_RESOLVER_IP/32"],"destinationPortRange":{"start":1024,"end":65535}},
    {"family":"IPv4","protocol":"udp","sourcePort":53,"sourceCidrs":["REPLACE_WITH_MEASURED_RESOLVER_IP/32"],"destinationPortRange":{"start":1024,"end":65535}}
  ]
}
```

Use `evroc` for that target and actual administrator ranges: IPv4 `/24` or
narrower, IPv6 `/64` or narrower. `reviewedRulesSha256` hashes the retained
sanitized rule record. Unavailable provider access blocks this review; a
fabricated receipt is not acceptance.

The [UpCloud public/utility firewall](https://upcloud.com/docs/products/networking/firewall/)
is stateless. Outbound acceptance plus an inbound drop does not permit replies.
Its receipt must additionally set `statelessFirewall: true`,
`hostConnectionTrackingRequired: true`, record the measured
`kernelEphemeralPortRange` and include the separately reviewed
`statelessReturnRules`. For example, this single return rule describes HTTPS;
the actual complete list must also permit UDP/TCP DNS replies from the exact
measured resolver hosts:

```json
{
  "family": "IPv4",
  "protocol": "tcp",
  "sourcePort": 443,
  "sourceCidrs": ["0.0.0.0/0"],
  "destinationPortRange": {"start": 32768, "end": 60999}
}
```

Read `/proc/sys/net/ipv4/ip_local_port_range` on the actual candidate. The
reviewed generic HTTP/NTP return range must match it, start at 32768 or above and exclude
control-plane, database and standard NodePort destinations. TCP source 80/443
may use global peers; DNS source 53 and optional UDP NTP source 123 require exact
reviewed `/32` or `/128` peers. Do not substitute a guessed resolver/time pool.
All return rules are included in the provider rules hash, separately from
`publicTcpPorts` and optional `publicUdpPorts` for hosted services.

K3s/Flannel masquerading may use `--random-fully` and translate a pod DNS request
to a source port below the host's `ip_local_port_range`. This can produce a slow
cold lookup followed by a fast retry when the provider admits only the host
range. Measure the actual translated ports and exact resolver addresses. The
reviewed DNS exception in the example uses `dnsReturnPortRange` 1024 through
65535 and `trustedDnsResolverCidrs`; only TCP/UDP replies from source port 53 on
those exact `/32` or `/128` hosts can use it. Every trusted resolver requires
both UDP and TCP reply rules. The bootstrap rejects untrusted/broad DNS peers,
privileged or invalid ranges, and HTTP/NTP rules that use the DNS range.
In the [UpCloud module](../upcloud/README.md#network-boundaries), set the matching
`dns_response_port_range` explicitly. Omitting the dedicated fields preserves
the older host-range review; use that only after qualifying the actual pod NAT
path. Do not change the measured kernel range or weaken generic return guards.

Keep the host firewall stateful and do not open either return destination range:
its actual `ESTABLISHED,RELATED` rule must admit replies while unsolicited `NEW`
traffic remains refused. The broader DNS provider rule can overlap application,
API and NodePort numbers because only a trusted resolver's port 53 can reach
that packet gate; host connection tracking must still reject a new connection.
The runtime/permanent firewalld hosted-port guard continues to refuse opening
these ranges. Inspect the actual conntrack rules and retain the independent
unsolicited-packet test results before qualifying the exception.
Measure actual DNS/HTTPS/time functionality and independently test unsolicited
return-range traffic before qualification. For Evroc inspect its actual chosen
network controls; do not assume UpCloud semantics. If those controls are
stateless, use the same explicit return-review fields and host checks.
DNS qualification must include cold pod lookups and bounded UDP/TCP queries
from an unprivileged low source port and a port within the measured host range
to each trusted resolver. A cached cluster lookup alone does not prove that the
randomized external reply path works. Preserve only packet metadata in the
review evidence; DNS payloads, credentials and provider account IDs are unnecessary.

For fixed NTP peers, retain the measured vendor-pool baseline and explicit peer
selection, observe actual local UDP acquisition ports and record Chrony source
health plus `NTPSynchronized=yes`. Fixed peers require ongoing health checks;
pool rotation is not automatically supported by exact-host return rules.
Review replacement peers and refresh the provider rules/receipt before changing
the Chrony configuration. Never broaden time-server sources to restore sync.

## Stage, review and start

Copy this directory through existing SSH access. Use the actual host name/IP:

```sh
sudo bash deploy/suse/k3s-bootstrap.sh preflight \
  --provider upcloud --node-ip 192.168.20.2 --candidate-host rehearsal \
  --interface ens3 --provider-review /private/provider-review.json
sudo bash deploy/suse/k3s-bootstrap.sh install \
  --provider upcloud --node-ip 192.168.20.2 --candidate-host rehearsal \
  --interface ens3 --provider-review /private/provider-review.json
```

Preflight is read-only and downloads nothing. Install verifies both artifacts
before writing a root-only configuration and running the pinned installer with
a cleared environment. Caller `K3S_*` and proxy credentials are not copied into
its service. K3s is staged **disabled and stopped**, with Secret encryption,
0600 kubeconfig, single-node embedded etcd and bounded six-hour snapshots.
Bundled Traefik/ServiceLB are disabled so installation does not acquire ports
80/443 or imply complete edge routing. On an ordinary host no SELinux RPM is
installed automatically; a transactional host follows the two-part install in
[Transactional hosts](#transactional-hosts).

Review config/unit, then explicitly start only the candidate. `kubectl wait`
finds nothing until the node has registered and CoreDNS's deployment exists,
so wait for both objects first:

```sh
sudo systemctl cat k3s
sudo systemctl enable --now k3s
until sudo /usr/local/bin/k3s kubectl get node "$(hostname)" >/dev/null 2>&1; do sleep 2; done
sudo /usr/local/bin/k3s kubectl wait node --all --for=condition=Ready --timeout=180s
until sudo /usr/local/bin/k3s kubectl -n kube-system get deployment coredns >/dev/null 2>&1; do sleep 2; done
sudo /usr/local/bin/k3s kubectl rollout status deployment/coredns -n kube-system --timeout=120s
sudo /usr/local/bin/k3s secrets-encrypt status
```

Confirm pod API/DNS, denied ports, encryption and reboot behavior before release
installation. Transfer the 0600 kubeconfig into existing administrative custody
without printing it or overwriting normal configuration. Keep the loopback URL
and use a dedicated SSH tunnel/context for remote administration. Never give
cluster-admin credentials to application agents. See
[cluster access](https://docs.k3s.io/cluster-access); if using another local tunnel
port, edit only this isolated kubeconfig.

The qualifier uses the checksum-verified `/usr/local/bin/k3s` directly for both
encryption and kubectl. SUSE's default sudo path can omit `/usr/local/bin`; do
not change the global path or use a different kubectl binary to work around it.

## Transactional hosts

openSUSE Leap 16.1 Immutable reports `ID=opensuse-leap` and
`VARIANT_ID=transactional`, boots a read-only btrfs root snapshot and changes
packages only through `transactional-update`. The helper treats a host as
transactional when os-release declares that variant **and** `/` is mounted
read-only, and refuses a host where only one of the two holds. It also requires
`transactional-update`, `findmnt` and `btrfs`, and checks that `/usr/local/bin`,
`/etc` and `/var` are writable directories outside the root snapshot. On Leap
16.1 Immutable `/usr/local` and `/var` are their own subvolumes, and `/etc` is a
writable subvolume of each snapshot that `transactional-update` copies into the
next one. The binary, configuration, unit and cluster data therefore survive
host updates. A rollback to a snapshot older than the installation returns `/etc`
to that snapshot, which removes `/etc/rancher/k3s` and the unit but leaves the
binary and `/var/lib/rancher`; this follows from the subvolume layout and has
not been exercised.

With SELinux enforcing, the same `install` command runs twice, with a reboot
between the runs:

1. **First run.** The running snapshot has no `k3s-selinux`. After the full
   preflight, `install` installs the package from the host's own signed
   repositories into a new snapshot with
   `transactional-update --no-selfupdate --drop-if-no-change run zypper --non-interactive install --no-recommends k3s-selinux`.
   Inside the snapshot the command also requires the installed package's vendor
   to be `SUSE LLC <https://www.suse.com/>`; otherwise transactional-update
   discards the snapshot. No repository or signing key is added, K3s is not
   downloaded, and nothing outside the new snapshot changes. `preflight` reports
   when this step is due.
2. **Reboot** with `sudo systemctl reboot`. Until then `preflight` and `install`
   refuse, because the next boot selects a different snapshot: the helper reads
   `/run/reboot-needed` and compares the running root subvolume with the btrfs
   default. A pending automatic update is refused in the same way.
3. **Second run.** Preflight now verifies the loaded policy as on any enforcing
   host, and install downloads, verifies and stages K3s disabled and stopped.
   The package's `%post` scriptlet ran inside the snapshot, so the empty
   directories it prepares (`/var/lib/cni`, `/var/lib/kubelet/pods` and the K3s
   data scaffold) never reached the persistent `/var`. The helper creates and
   labels those directories, as the scriptlet would have, before it labels the
   K3s tree.

If another `transactional-update` replaces the policy snapshot before the
reboot, the second run finds no policy and stages it again. A third run after
staging refuses the existing configuration and binary, as on any host. With
SELinux disabled no policy is needed and a single run stages K3s.

The upstream installer reaches the same end differently: it detects
`/usr/sbin/transactional-update`, adds the `rpm.rancher.io` repository with
`--gpg-auto-import-keys`, picks the SLE Micro policy build for
`VARIANT_ID=transactional` (get.k3s.io, read 2026-10-26) and leaves K3s
enabled to start at the next boot. The pinned installer commit predates that
variant check, and this helper skips the installer's SELinux step entirely.

Measured on 2026-10-27 (Leap 16.1 Immutable RC Build 3.13, aarch64 on a local
Lima VM): see the qualification record in the pull request that added this
section.

## Install reviewed releases with scoped credentials

Create distinct `lolly-work`/`lolly-public` namespaces. Label both with
`pod-security.kubernetes.io/enforce=restricted` and
`pod-security.kubernetes.io/enforce-version=v1.34`. Apply a namespace-wide ingress
and egress default-deny policy plus TCP/UDP 53 egress to CoreDNS in `kube-system`.
Add only reviewed ingress-controller, database, IdP/DAM HTTPS and worker paths.
Set Work `networkPolicy.enabled: true` and `networkPolicy.allowAllEgress: false`
with accompanying scoped egress rules. Do not grant the application Kubernetes
API access merely to satisfy a test.

Apply the shared baseline only to those candidate namespaces:

```sh
for NS in lolly-work lolly-public; do
  kubectl --kubeconfig /private/candidate-kubeconfig --context candidate \
    create namespace "$NS" --dry-run=client -o yaml | \
    kubectl --kubeconfig /private/candidate-kubeconfig --context candidate apply -f -
  kubectl --kubeconfig /private/candidate-kubeconfig --context candidate \
    label namespace "$NS" pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/enforce-version=v1.34
  kubectl --kubeconfig /private/candidate-kubeconfig --context candidate apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny, namespace: $NS}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: dns-egress, namespace: $NS}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: TCP, port: 53}
        - {protocol: UDP, port: 53}
YAML
done
```

Add reviewed workload-specific ingress/egress before starting pods. Permissions
from different policies are additive; the qualifier refuses wildcard rules that
undo default deny. A reviewed public HTTPS egress rule may use `0.0.0.0/0` only
with private, loopback and link-local exceptions; the equivalent IPv6 rule also
excludes IPv4-mapped ranges. Public services cannot egress to the private
namespace. These guards still need actual CNI connectivity and denial tests.

Keep database, session, link, signing, DAM and render credentials only in the
private namespace. Use `existingSecret` and `database.existingSecret`; never
place token bytes in values, Git, IaC state or command arguments. For example:

```sh
kubectl --kubeconfig /private/candidate-kubeconfig --context candidate \
  -n lolly-work create secret generic lolly-work-secrets \
  --from-env-file=/private/rehearsal-work.env \
  --from-file=LW_C2PA_SIGNING_KEY=/private/rehearsal-signing-key.pem \
  --dry-run=client -o yaml | kubectl --kubeconfig /private/candidate-kubeconfig \
  --context candidate apply -f -
```

Use 0600 files and no shell tracing. Application Collection registry Secrets use
a scoped organization service account with suitable entitlement: create its
namespace pull Secret from a private `.dockerconfigjson` and reference
`imagePullSecrets`. Public services receive no Work credentials. The separately
owned [PostgreSQL candidate](README.md#application-collection-dependencies)
retains its own registry/TLS/backup lifecycle.

Use an independently restored rehearsal database. Do not start another owner or
migration Job against the live database while Compose writes. Preserve existing
production signing/session/link credentials for the eventual cutover.

Render, review and install complete digest-pinned application, pack, shell and
optional worker images with private candidate values:

```sh
umask 077
helm template lolly-work deploy/helm -n lolly-work \
  -f deploy/helm/values-small-suse.yaml -f /private/work-candidate-values.yaml \
  > /private/work-candidate.yaml
helm upgrade --install lolly-work deploy/helm -n lolly-work \
  --kubeconfig /private/candidate-kubeconfig --kube-context candidate \
  -f deploy/helm/values-small-suse.yaml -f /private/work-candidate-values.yaml \
  --wait --timeout 10m
```

Install the public repository's lean chart into its own namespace. Keep one Work
owner, no automatic service-account token mounts, no privileged/hostPath/host
namespace containers and ClusterIP app services. Review/install shared edge
ingress separately. These charts do not supply the complete public relay,
Penpot/model/admission topology; retain the
[cloud parity gates](../../docs/cloud-deployment.md).

### Optional direct-port edge exception

A dedicated third namespace may contain one reviewed host-network edge pod
binding TCP 80/443 and optional UDP 443 directly. Ordinary public/private app
namespaces still enforce restricted Pod Security. The edge namespace must pin
`enforce: privileged`, `audit: restricted` and `warn: restricted` to `v1.34`;
this namespace admission exception is broader than the workload. Restrict who
can create or change workloads there and keep its service account without token
mounts, RoleBindings or explicit cluster role grants. Namespace admission labels
alone do not narrow the exception to one pod; exact workload inspection and
administrative RBAC review remain required.

Use a complete immutable image, explicit non-root UID, runtime-default seccomp,
read-only root filesystem, no privilege escalation, dropped `ALL` capabilities
and only added `NET_BIND_SERVICE`. No init/ephemeral containers, host PID/IPC,
Services/NodePorts or additional declared host ports are allowed. Any host
content directory must already exist without symlinks under `/opt/` or `/srv/`,
match an explicit public-content review and mount read-only without subpaths.
Prefer normal namespace volumes for writable certificate/cache state. Review
the actual mounted content and edge routing configuration before exposing it;
the inspector does not prove that a reviewed directory contains only public
data or that the process opens only its declared ports.

Keep the edge's upstream source bind fixed to the exact node InternalIP, for
example `10.4.27.58`. Measure the socket peer observed by each public API and
private Work service before configuring proxy trust. A ClusterIP connection can
translate that bind to the node's CNI gateway: the candidate's preliminary
host-bound probe observed `10.42.0.1`, with current `cni0` address `10.42.0.1/24`
and node pod CIDR `10.42.0.0/24`. This host probe does not qualify actual Caddy
traffic. Repeat the measurement through the actual edge and complete Work
trusted-proxy checks before acceptance.

The qualifier accepts a separate gateway peer only with a fresh, private receipt
whose SHA-256 is acknowledged in the edge review. Its exact peer must match the
current `cni0` IPv4 gateway and that interface's prefix must match the reviewed
node's current pod CIDR within the configured `10.42.0.0/16` range. Pass
`--edge-peer-measurement /private/edge-peer-measurement.json`; the qualifier reads
current interface/node facts itself. Keep `upstreamSourceAddress` equal to
`nodePrivateIp`, set `workTrustedProxyPeer` to the exact observed gateway and set
`peerMeasurementSha256` to the receipt's actual digest. Address ingress within
the pod range is then limited to that gateway `/32`; use namespace/pod selectors
for other pods. Direct node peers retain the original review contract without
this optional receipt.

Do not trust the entire pod/service CIDR. Host-network traffic is not reliably
governed by Kubernetes NetworkPolicy; provider/host rules, actual denied-port
tests and edge routing/credential isolation remain independent acceptance.

Pass `--edge-namespace` and `--edge-review` together. The 0600 review contains
only names, references and explicit public mounts, never credential values:

```json
{
  "namespace": "lolly-edge",
  "reviewedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIMESTAMP",
  "hostNetworkDirectPorts": true,
  "nodeName": "REPLACE_WITH_ACTUAL_CANDIDATE_NODE",
  "nodePrivateIp": "10.4.27.58",
  "workTrustedProxyPeer": "10.4.27.58",
  "podName": "REPLACE_WITH_ONE_ACTUAL_EDGE_POD",
  "containerName": "edge",
  "serviceAccountName": "lolly-edge",
  "image": "registry.example/team/edge@sha256:REPLACE_WITH_64_HEX",
  "publicContentHostPaths": [],
  "secretRefs": ["edge-registry"]
}
```

The translated-peer receipt is a 0600 regular JSON file, not a symlink. Record
the actual measurement rather than copying these example addresses or digest:

```json
{
  "observedAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIMESTAMP",
  "requestSourceBind": "10.4.27.58",
  "observedPodSocketPeer": "10.42.0.1",
  "serviceClusterIP": "REPLACE_WITH_MEASURED_CLUSTERIP",
  "actualCaddySocketQualified": false,
  "hostNetworkEquivalentHostProbe": true,
  "noSecretsOrTokens": true,
  "probeManifestSha256": "REPLACE_WITH_ACTUAL_64_HEX_PROBE_DIGEST"
}
```

Receipt and review must both be current within 24 hours. Preserve the
`actualCaddySocketQualified: false` distinction for a preliminary host-bound
probe; only a new receipt from the actual Caddy request can mark that field
true. The inspection report records this distinction and still leaves
application trust, routing, denied-port and complete cutover gates outstanding.

If a public content host mount is necessary, each reviewed entry is exactly
`{"path":"/opt/lolly-public/shell","type":"Directory","mountPath":"/srv/shell","readOnly":true}`.
Use actual immutable directories rather than the example or a mutable symlink.
The image must be able to operate with its declared non-root/read-only posture.

Save a 0600 allowlist of complete `repository@sha256:64_lowercase_hex` image
references and permitted Secret **names** for each namespace:

```json
{
  "lolly-work": {
    "images": ["registry.example/team/work@sha256:REPLACE_WITH_64_HEX"],
    "secretRefs": ["lolly-work-secrets", "application-collection"]
  },
  "lolly-public": {
    "images": ["registry.example/team/web@sha256:REPLACE_WITH_64_HEX"],
    "secretRefs": ["public-registry", "public-tls"]
  }
}
```

Run on the candidate with explicit kubeconfig/context and a ready Work pod:

```sh
sudo bash deploy/suse/k3s-qualify.sh \
  --provider upcloud --provider-review /private/provider-review.json --interface ens3 \
  --namespace lolly-work --public-namespace lolly-public --probe-pod WORK_POD_NAME \
  --kubeconfig /private/candidate-kubeconfig --context candidate \
  --image-review /private/reviewed-images.json --output /private/cluster-checks.json
```

For the direct-port edge topology append:

```sh
  --edge-namespace lolly-edge --edge-review /private/reviewed-edge.json
```

The qualifier reads pod/service/account/policy metadata, checks pinned
server/binary and Secret encryption, waits for CoreDNS API readiness and makes
a DNS-only lookup in Work's `server` container. It reads no Kubernetes Secret
values, applies no resources and writes an exclusive 0600 receipt. Failures stop
the check. A pass always records `promotionReady: false`: actual recovery and
application acceptance remain required.
An edge supplied for inspection must pass all separate exception checks and is
recorded in `edgeInspection`. Omitting it records `not-requested`, which cannot
qualify an installed edge or replace its separate acceptance.

## Recovery, upgrades and Compose rollback

Run `sudo /usr/local/bin/k3s etcd-snapshot save --name before-rehearsal` and retain the exact
snapshot **plus server token**, configuration and lock off-node in approved
encrypted custody. Local snapshot retention is not an independent backup.
The server token decrypts bootstrap material; never print it or publish it in a
receipt. Follow [snapshot/restore](https://docs.k3s.io/cli/etcd-snapshot) on a
separate disposable host with the same pinned binary and restore token. Prove
namespace Secrets, encryption, pods and application access afterward; record
recovery time/hashes without secret bytes. K3s snapshots do not back up Work
PostgreSQL, S3 uploads or persistent database volumes.

The helper refuses upgrades/adoption. For future updates review a new lock,
follow [manual upgrades](https://docs.k3s.io/upgrades/manual), retain prior
binary/config/token/snapshot and rehearse fresh-host restore. An in-place
Kubernetes binary downgrade is not a demonstrated database rollback.

Before promotion complete exact signed shell/catalog/source checks, external
TLS/docs/HEAD/MIME, public route/model/WS/relay parity, sign-in, scoped agents,
DAM originals, shared uploads, render/busy recovery, drain/reconnect, reboot,
independent database restore and measured capacity/cost. Retain the Compose
origin, configuration, keys and signed releases. Drain every writer before
changing the database owner. Reconcile target writes before database rollback;
DNS reversal alone can lose them. Revert edge/DNS through the reviewed cutover
procedure. Never run uninstall/killall on the preserved Compose host as rollback.
