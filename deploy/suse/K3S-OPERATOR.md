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
  "sshSourceCidrs": ["203.0.113.9/32"]
}
```

Use `evroc` for that target and actual administrator ranges: IPv4 `/24` or
narrower, IPv6 `/64` or narrower. `reviewedRulesSha256` hashes the retained
sanitized rule record. Unavailable provider access blocks this review; a
fabricated receipt is not acceptance.

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
sudo k3s kubectl wait node --all --for=condition=Ready --timeout=180s
sudo k3s kubectl rollout status deployment/coredns -n kube-system --timeout=120s
sudo k3s secrets-encrypt status
```

Confirm pod API/DNS, denied ports, encryption and reboot behavior before release
installation. Transfer the 0600 kubeconfig into existing administrative custody
without printing it or overwriting normal configuration. Keep the loopback URL
and use a dedicated SSH tunnel/context for remote administration. Never give
cluster-admin credentials to application agents. See
[cluster access](https://docs.k3s.io/cluster-access); if using another local tunnel
port, edit only this isolated kubeconfig.

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

The qualifier reads pod/service/account/policy metadata, checks pinned
server/binary and Secret encryption, waits for CoreDNS API readiness and makes
a DNS-only lookup in Work's `server` container. It reads no Kubernetes Secret
values, applies no resources and writes an exclusive 0600 receipt. Failures stop
the check. A pass always records `promotionReady: false`: actual recovery and
application acceptance remain required.

## Recovery, upgrades and Compose rollback

Run `sudo k3s etcd-snapshot save --name before-rehearsal` and retain the exact
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
