#!/usr/bin/env bash
# Read-only cluster checks. A pass is not a database/DNS/application cutover.
set -euo pipefail

K3S_QUALIFY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$K3S_QUALIFY_DIR/k3s-bootstrap.sh"

validate_cluster_files() {
  python3 -I - "$@" <<'PY'
import ipaddress,json,os,re,sys
stage,private,public,probe,images,version,output=sys.argv[1:]
def need(ok,message):
    if not ok: raise SystemExit('k3s qualification: '+message)
def read(name):
    with open(stage+'/'+name+'.json') as f: return json.load(f)
need(private!=public,'public and private namespaces must differ')
need(all(n!='default' and not n.startswith('kube-') for n in [private,public]),'reserved namespaces refused')
lock=json.load(open(images));need(set(lock)=={private,public},'image/secret allowlist must name exactly both namespaces')
server=read('version')['serverVersion']['gitVersion'];need(server==version,'server differs from pinned version')
namespaces={n['metadata']['name']:n for n in read('namespaces')['items']}
for namespace in [private,public]:
    labels=namespaces[namespace]['metadata'].get('labels',{})
    need(labels.get('pod-security.kubernetes.io/enforce')=='restricted','namespace must enforce restricted Pod Security')
    need(labels.get('pod-security.kubernetes.io/enforce-version')=='v1.34','namespace Pod Security version must be pinned')
    expected=lock[namespace];need(expected['images'] and all(re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}',x) for x in expected['images']),'all allowed images need immutable digests')
    need(isinstance(expected['secretRefs'],list),'secret reference allowlist required')
    accounts={s['metadata']['name']:s for s in read(namespace+'-accounts')['items']}
    policies=read(namespace+'-policies')['items']
    need(any(p['spec'].get('podSelector')=={} and set(p['spec'].get('policyTypes',[]))=={'Ingress','Egress'} and not p['spec'].get('ingress') and not p['spec'].get('egress') for p in policies),'namespace-wide ingress/egress default deny is missing')
    # NetworkPolicies add permissions: another unrestricted rule can undo deny.
    for policy in policies:
        for direction,peer_key in [('ingress','from'),('egress','to')]:
            for rule in policy['spec'].get(direction,[]):
                need(rule.get('ports') and rule.get(peer_key),'unrestricted policy rule refused')
                for peer in rule[peer_key]:
                    need(peer and set(peer).issubset({'podSelector','namespaceSelector','ipBlock'}),'unrestricted policy peer refused')
                    if 'namespaceSelector' in peer:
                        labels=peer['namespaceSelector'].get('matchLabels',{})
                        need(labels and not peer['namespaceSelector'].get('matchExpressions'),'namespace selector must have explicit labels')
                        if namespace==public and direction=='egress':
                            need(labels.get('kubernetes.io/metadata.name') in [public,'kube-system'],'public egress to another namespace refused')
                    if 'ipBlock' in peer:
                        network=ipaddress.ip_network(peer['ipBlock']['cidr'])
                        if network.prefixlen==0:
                            need(direction=='egress','unrestricted address ingress refused')
                            need(all(p.get('port')==443 and p.get('protocol','TCP')=='TCP' for p in rule['ports']),'broad external egress must be HTTPS only')
                            blocks=['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','127.0.0.0/8','169.254.0.0/16'] if network.version==4 else ['::/128','::1/128','fc00::/7','fe80::/10','::ffff:0:0/96']
                            exceptions=[ipaddress.ip_network(c) for c in peer['ipBlock'].get('except',[])]
                            need(all(any(ipaddress.ip_network(b).subnet_of(e) for e in exceptions if e.version==network.version) for b in blocks),'external egress must exclude private/loopback/link-local addresses')
                        elif namespace==public and direction=='egress':
                            need(network.is_global,'public egress to a private address refused')
    dns=False
    for p in policies:
        if p['spec'].get('podSelector')!={}: continue
        for rule in p['spec'].get('egress',[]):
            destinations=rule.get('to',[])
            if not destinations or not all(x.get('namespaceSelector',{}).get('matchLabels',{}).get('kubernetes.io/metadata.name')=='kube-system' for x in destinations): continue
            ports={(x.get('protocol','TCP'),x.get('port')) for x in rule.get('ports',[])}
            dns=dns or {('TCP',53),('UDP',53)}.issubset(ports)
    need(dns,'namespace DNS egress allowance is missing')
    pods=read(namespace+'-pods')['items'];need(pods,'namespace contains no release pods')
    live=[]
    for pod in pods:
        spec=pod['spec'];name=pod['metadata']['name'];phase=pod['status'].get('phase')
        need(not any(spec.get(k) for k in ['hostNetwork','hostPID','hostIPC']),'host namespace access refused')
        sa=accounts.get(spec.get('serviceAccountName','default'),{})
        need(spec.get('automountServiceAccountToken',sa.get('automountServiceAccountToken',True)) is False,'automatic service-account token mount refused')
        refs=set(x['name'] for x in spec.get('imagePullSecrets',[]))
        for volume in spec.get('volumes',[]):
            need('hostPath' not in volume,'hostPath volume refused')
            if 'secret' in volume: refs.add(volume['secret']['secretName'])
            for source in volume.get('projected',{}).get('sources',[]):
                need('serviceAccountToken' not in source,'projected service-account token refused')
                if 'secret' in source: refs.add(source['secret']['name'])
        for c in spec.get('containers',[])+spec.get('initContainers',[]):
            need(c['image'] in expected['images'],'pod image is outside the reviewed digest allowlist')
            security=c.get('securityContext',{})
            need(security.get('runAsNonRoot',spec.get('securityContext',{}).get('runAsNonRoot')) is True,'non-root execution is required')
            need(security.get('allowPrivilegeEscalation') is False and not security.get('privileged'),'privilege escalation refused')
            need('ALL' in security.get('capabilities',{}).get('drop',[]),'capabilities must be dropped')
            for env in c.get('env',[]):
                if 'secretKeyRef' in env.get('valueFrom',{}): refs.add(env['valueFrom']['secretKeyRef']['name'])
                need(not ('value' in env and re.search(r'SECRET|PASSWORD|DATABASE_URL|SIGNING_KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY',env['name'],re.IGNORECASE)),'credentials must use Secret references')
            for env in c.get('envFrom',[]):
                if 'secretRef' in env: refs.add(env['secretRef']['name'])
        need(refs.issubset(set(expected['secretRefs'])),'unreviewed namespace Secret reference')
        need(phase in ['Running','Succeeded'],'pod has not reached Running/Succeeded')
        if phase=='Running':
            need(any(c.get('type')=='Ready' and c.get('status')=='True' for c in pod['status'].get('conditions',[])),'running pod is not ready')
            live.append(name)
    need(live,'namespace has no running ready pods')
    if namespace==private: need(probe in live,'DNS probe must be a running private Work pod')
    for service in read(namespace+'-services')['items']:
        need(service['spec'].get('type','ClusterIP')=='ClusterIP','application services must stay ClusterIP; review edge ingress separately')
        need(not service['spec'].get('externalIPs'),'application externalIPs refused')
report={'status':'automatic-cluster-checks-passed','promotionReady':False,'version':version,
 'namespaces':[private,public],'images':{n:lock[n]['images'] for n in [private,public]},
 'remainingAcceptance':['independent snapshot plus server-token backup and fresh-host restore',
 'exact signed shell/catalog and application source binding','external TLS and complete public route/model/relay parity',
 'authenticated sign-in, collaboration, agents, DAM originals, shared uploads and render load',
 'measured capacity, writer drain, database continuity, DNS and Compose rollback rehearsal']}
with os.fdopen(os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f: json.dump(report,f,indent=2);f.write('\n')
print('Automatic cluster checks passed; promotionReady=false; actual recovery/application/cutover gates remain.')
PY
}

qualify_main() {
  local private= public= probe= images= output= kubeconfig= context= interface= provider= review=
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || fail 'option requires a value'
    case $1 in
      --namespace) private=$2 ;; --public-namespace) public=$2 ;; --probe-pod) probe=$2 ;;
      --image-review) images=$2 ;; --output) output=$2 ;; --kubeconfig) kubeconfig=$2 ;;
      --context) context=$2 ;; --interface) interface=$2 ;; --provider) provider=$2 ;; --provider-review) review=$2 ;;
      *) fail "unknown qualification option: $1" ;;
    esac
    shift 2
  done
  [[ -n $private && -n $public && $private != "$public" && -n $probe && -n $images && -n $output && -n $kubeconfig && -n $context && -n $interface && -n $review ]] || fail 'all qualification inputs are required; public/private namespaces must differ'
  [[ $private =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $public =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $probe =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || fail 'invalid Kubernetes name'
  [[ $private != default && $public != default && $private != kube-* && $public != kube-* ]] || fail 'reserved namespaces refused'
  python3 -I - "$kubeconfig" "$images" <<'PY'
import os,stat,sys
for p in sys.argv[1:]:
    s=os.lstat(p);assert stat.S_ISREG(s.st_mode) and not s.st_mode & 0o077, 'kubeconfig/review must be private regular files'
PY
  validate_provider_review "$review" "$provider"
  validate_network "$interface"
  local version binary_url binary_sha installer_url installer_sha
  read -r version binary_url binary_sha installer_url installer_sha < <(read_release_lock)
  verify_file /usr/local/bin/k3s "$binary_sha"
  local encryption_status
  encryption_status=$(k3s secrets-encrypt status) || fail 'cannot inspect Secret encryption'
  [[ $encryption_status == *'Encryption Status: Enabled'* && $encryption_status == *'All hashes match'* ]] || fail 'Kubernetes Secret encryption is disabled or inconsistent'
  local kube=(kubectl --kubeconfig "$kubeconfig" --context "$context")
  local endpoint
  endpoint=$("${kube[@]}" config view --minify -o 'jsonpath={.clusters[0].cluster.server}')
  [[ $endpoint == https://127.0.0.1:6443 ]] || fail 'qualifier must target this host through an isolated loopback kubeconfig'
  "${kube[@]}" rollout status deployment/coredns -n kube-system --timeout=120s >/dev/null
  umask 077
  K3S_QUALIFY_STAGE=$(mktemp -d)
  trap 'rm -rf -- "$K3S_QUALIFY_STAGE"' EXIT
  "${kube[@]}" version -o json > "$K3S_QUALIFY_STAGE/version.json"
  "${kube[@]}" get namespace "$private" "$public" -o json > "$K3S_QUALIFY_STAGE/namespaces.json"
  local ns resource
  for ns in "$private" "$public"; do
    for resource in pods services; do "${kube[@]}" get "$resource" -n "$ns" -o json > "$K3S_QUALIFY_STAGE/$ns-$resource.json"; done
    "${kube[@]}" get networkpolicies -n "$ns" -o json > "$K3S_QUALIFY_STAGE/$ns-policies.json"
    "${kube[@]}" get serviceaccounts -n "$ns" -o json > "$K3S_QUALIFY_STAGE/$ns-accounts.json"
  done
  # No token is read. CoreDNS readiness proves its API cache is ready; this lookup
  # proves the default-deny Work namespace can still resolve cluster DNS.
  "${kube[@]}" exec -n "$private" "$probe" -c server -- node -e \
    'require("node:dns").promises.lookup("kubernetes.default.svc.cluster.local").then(() => process.exit(0), () => process.exit(1)); setTimeout(() => process.exit(1), 5000).unref()' >/dev/null
  validate_cluster_files "$K3S_QUALIFY_STAGE" "$private" "$public" "$probe" "$images" "$version" "$output"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then qualify_main "$@"; fi
