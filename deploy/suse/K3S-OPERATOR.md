# K3s candidate installation and qualification

This workflow stages a **new dedicated amd64 SLES/openSUSE candidate** on either
[UpCloud](../upcloud/README.md) or [Evroc](../evroc/README.md). It never adopts a
running Compose host, creates cloud resources, changes DNS or moves a database.
Keep the existing Compose origin/database available during rehearsal. Source
checks do not qualify actual provider access, host boot or application recovery.

`k3s.lock.json` pins `v1.34.12+k3s1`, its official amd64 binary checksum and an
installer at an immutable commit with a separate SHA-256. This patch matches the
current Kubernetes 1.34 chart/schema lane. It is a candidate selection, not a
support claim for every OS image. Review the
[SUSE support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/)
and release maintenance before choosing a host. Other architectures,
transactional Linux Micro hosts, joining and upgrades need separate qualification.

## Prepare the candidate and its network

Use the four-vCPU/eight-GiB/eighty-GB starting benchmark in [README.md](README.md).
The helper requires four CPUs, seven usable GiB, cgroup v2, no active swap and
forty GiB free for images, restore and rollback. These are starting gates, not
measured capacity. It refuses existing K3s/RKE2 data, Docker/Caddy units and
occupied HTTP/API ports. Provisioning and cost review remain separate actions.
Do not run it on the existing small production host.

Review/install Bash, Python 3, curl, coreutils (`sha256sum`), iproute2 (`ip`/`ss`),
systemd, RPM and firewalld in the selected OS image. The helper installs no OS
packages and disables no security controls. Enforcing SELinux requires the
matching `k3s-selinux` policy package; the configuration then enables SELinux.
Permissive SELinux is refused. Disabled SELinux is an existing OS posture, not an
action taken by the helper; review AppArmor separately. This is not CIS certification.

An installed RPM alone does not prove its module loaded. Preflight verifies the
RPM, loaded `k3s` module and expected executable/snapshot contexts. If the signed
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
  "statelessReturnRules": [
    {"family":"IPv4","protocol":"tcp","sourcePort":443,"sourceCidrs":["0.0.0.0/0"],"destinationPortRange":{"start":32768,"end":60999}},
    {"family":"IPv4","protocol":"tcp","sourcePort":53,"sourceCidrs":["REPLACE_WITH_MEASURED_RESOLVER_IP/32"],"destinationPortRange":{"start":32768,"end":60999}},
    {"family":"IPv4","protocol":"udp","sourcePort":53,"sourceCidrs":["REPLACE_WITH_MEASURED_RESOLVER_IP/32"],"destinationPortRange":{"start":32768,"end":60999}}
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
reviewed return range must match it, start at 32768 or above and exclude
control-plane, database and standard NodePort destinations. TCP source 80/443
may use global peers; DNS source 53 and optional UDP NTP source 123 require exact
reviewed `/32` or `/128` peers. Do not substitute a guessed resolver/time pool.
All return rules are included in the provider rules hash, separately from
`publicTcpPorts` and optional `publicUdpPorts` for hosted services.

Keep the host firewall stateful and do not open its ephemeral destination range:
it must accept established replies while refusing unsolicited connections.
Measure actual DNS/HTTPS/time functionality and independently test unsolicited
return-range traffic before qualification. For Evroc inspect its actual chosen
network controls; do not assume UpCloud semantics. If those controls are
stateless, use the same explicit return-review fields and host checks.

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
80/443 or imply complete edge routing. No SELinux RPM is installed automatically.

Review config/unit, then explicitly start only the candidate:

```sh
sudo systemctl cat k3s
sudo systemctl enable --now k3s
sudo /usr/local/bin/k3s kubectl wait node --all --for=condition=Ready --timeout=180s
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

Record the exact node InternalIP as Work's reviewed proxy peer, for example
`10.4.27.58`, and prove the actual upstream socket peer before configuring trust.
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
