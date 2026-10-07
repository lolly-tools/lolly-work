#!/usr/bin/env bash
# Read-only cluster checks. A pass is not a database/DNS/application cutover.
set -euo pipefail

K3S_QUALIFY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$K3S_QUALIFY_DIR/k3s-bootstrap.sh"

validate_edge_files() {
  python3 -I - "$@" <<'PY'
import datetime,ipaddress,json,os,re,sys
stage,private,public,edge,review=sys.argv[1:]
def need(ok,message):
    if not ok: raise SystemExit('k3s edge qualification: '+message)
def read(name):
    with open(stage+'/'+name+'.json') as f: return json.load(f)
expected=json.load(open(review))
need(edge not in [private,public,'default'] and not edge.startswith('kube-'),'edge namespace must be distinct and nonreserved')
need(expected['namespace']==edge and expected['hostNetworkDirectPorts'] is True,'explicit edge exception acknowledgement required')
reviewed=datetime.datetime.fromisoformat(expected['reviewedAt'].replace('Z','+00:00'))
need(reviewed.tzinfo and 0 <= (datetime.datetime.now(datetime.timezone.utc)-reviewed).total_seconds() <= 86400,'edge review must be current within 24 hours')
peer=ipaddress.IPv4Address(expected['nodePrivateIp'])
need(any(peer in ipaddress.ip_network(c) for c in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']),'edge peer must be private IPv4')
need(not any(peer in ipaddress.ip_network(c) for c in ['10.42.0.0/16','10.43.0.0/16']),'edge peer may not use the pod/service ranges')
need(expected['workTrustedProxyPeer']==str(peer),'Work trust must name the exact stable edge peer, not a CIDR')
need(re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}',expected['image']),'edge image needs an immutable digest')
namespace=read(edge+'-namespace');labels=namespace['metadata'].get('labels',{})
for kind,value in [('enforce','privileged'),('audit','restricted'),('warn','restricted')]:
    need(labels.get('pod-security.kubernetes.io/'+kind)==value,'edge PSA exception must retain restricted audit/warn')
    need(labels.get('pod-security.kubernetes.io/'+kind+'-version')=='v1.34','edge PSA versions must be pinned')
node=read('edge-node');need(node['metadata']['name']==expected['nodeName'],'edge node identity differs')
need(any(a.get('type')=='InternalIP' and a.get('address')==str(peer) for a in node['status'].get('addresses',[])),'edge private peer is not the node InternalIP')
pods=read(edge+'-pods')['items'];need(len(pods)==1,'edge namespace must contain exactly one release pod')
pod=pods[0];spec=pod['spec'];status=pod['status']
need(pod['metadata']['name']==expected['podName'] and spec.get('nodeName')==expected['nodeName'],'edge pod/node differs from review')
need(spec.get('hostNetwork') is True and spec.get('dnsPolicy')=='ClusterFirstWithHostNet','only the acknowledged host network exception is allowed')
need(not spec.get('hostPID') and not spec.get('hostIPC'),'host process/IPC access refused')
need(not spec.get('shareProcessNamespace') and not spec.get('securityContext',{}).get('sysctls'),'edge process sharing and sysctl overrides refused')
need(not spec.get('initContainers') and not spec.get('ephemeralContainers'),'edge extra containers refused')
need(status.get('phase')=='Running' and any(c.get('type')=='Ready' and c.get('status')=='True' for c in status.get('conditions',[])),'edge pod must be running and ready')
need(spec.get('serviceAccountName')==expected['serviceAccountName'],'edge service account differs')
accounts={s['metadata']['name']:s for s in read(edge+'-accounts')['items']}
account=accounts.get(expected['serviceAccountName']);need(account is not None,'edge account is missing')
need(spec.get('automountServiceAccountToken',account.get('automountServiceAccountToken',True)) is False,'edge service-account token mount refused')
need(not read(edge+'-rolebindings')['items'],'edge namespace RoleBindings are refused')
for binding in read('edge-clusterrolebindings')['items']:
    for subject in binding.get('subjects',[]):
        matches=subject.get('kind')=='ServiceAccount' and subject.get('namespace')==edge
        matches=matches or (subject.get('kind')=='Group' and subject.get('name') in ['system:serviceaccounts','system:serviceaccounts:'+edge])
        need(not matches,'edge service-account cluster role binding refused')
need(not read(edge+'-services')['items'],'host network edge must not add Services or NodePorts')
containers=spec.get('containers',[]);need(len(containers)==1,'edge needs exactly one container')
container=containers[0];need(container['name']==expected['containerName'] and container['image']==expected['image'],'edge container/image differs')
security=container.get('securityContext',{});podsecurity=spec.get('securityContext',{})
need(security.get('runAsNonRoot',podsecurity.get('runAsNonRoot')) is True,'edge must run as non-root')
uid=security.get('runAsUser',podsecurity.get('runAsUser'));need(isinstance(uid,int) and uid>0,'edge must declare a non-root UID')
need(security.get('allowPrivilegeEscalation') is False and not security.get('privileged'),'edge privilege escalation refused')
need(security.get('readOnlyRootFilesystem') is True,'edge root filesystem must be read-only')
need(security.get('procMount','Default')=='Default' and not security.get('windowsOptions',{}).get('hostProcess'),'edge process security overrides refused')
caps=security.get('capabilities',{});need(set(caps.get('drop',[]))=={'ALL'} and set(caps.get('add',[]))=={'NET_BIND_SERVICE'},'edge may add only NET_BIND_SERVICE after dropping ALL')
need(security.get('seccompProfile',podsecurity.get('seccompProfile',{})).get('type')=='RuntimeDefault','edge needs runtime-default seccomp')
ports={(p.get('protocol','TCP'),p['containerPort']) for p in container.get('ports',[])}
need({('TCP',80),('TCP',443)}.issubset(ports) and ports.issubset({('TCP',80),('TCP',443),('UDP',443)}),'edge ports must be only HTTP/HTTPS and optional HTTP/3')
need(all(p.get('hostPort',p['containerPort'])==p['containerPort'] for p in container.get('ports',[])),'edge remapped host ports refused')
refs=set(x['name'] for x in spec.get('imagePullSecrets',[]))
allowed=expected['publicContentHostPaths'];need(isinstance(allowed,list),'public-content host path review required')
actual=[];mounts=container.get('volumeMounts',[])
for volume in spec.get('volumes',[]):
    if 'hostPath' in volume:
        hp=volume['hostPath'];path=hp['path']
        need(path.startswith(('/opt/','/srv/')) and os.path.normpath(path)==path,'edge host path must be an explicit public content directory')
        used=[m for m in mounts if m['name']==volume['name']]
        need(len(used)==1 and used[0].get('readOnly') is True and not used[0].get('subPath') and not used[0].get('subPathExpr') and used[0].get('mountPropagation','None')=='None','edge public host mount must be read-only without subpaths/propagation')
        actual.append({'path':path,'type':hp.get('type'),'mountPath':used[0]['mountPath'],'readOnly':True})
        need(hp.get('type')=='Directory' and os.path.isdir(path) and os.path.realpath(path)==path,'edge host directory must already exist without symlinks')
    if 'secret' in volume: refs.add(volume['secret']['secretName'])
    for source in volume.get('projected',{}).get('sources',[]):
        need('serviceAccountToken' not in source,'edge projected service-account token refused')
        if 'secret' in source: refs.add(source['secret']['name'])
need(sorted(actual,key=lambda x:x['path'])==sorted(allowed,key=lambda x:x['path']),'edge public host path differs from review')
for env in container.get('env',[]):
    if 'secretKeyRef' in env.get('valueFrom',{}): refs.add(env['valueFrom']['secretKeyRef']['name'])
    need(not ('value' in env and re.search(r'SECRET|PASSWORD|DATABASE_URL|SIGNING_KEY|TOKEN|PRIVATE_KEY|ACCESS_KEY',env['name'],re.IGNORECASE)),'edge credentials must use its own Secret references')
for env in container.get('envFrom',[]):
    if 'secretRef' in env: refs.add(env['secretRef']['name'])
need(refs.issubset(set(expected['secretRefs'])),'edge Secret reference is outside its review')
summary={'status':'explicit-edge-exception-inspected','namespace':edge,'image':expected['image'],'nodePrivateIp':str(peer),
 'workTrustedProxyPeer':expected['workTrustedProxyPeer'],'networkPolicyApplies':False,
 'remainingAcceptance':['actual Work socket peer/trust verification','reviewed public edge routing and credential isolation','external dual-stack denied-port and host listener verification']}
with open(stage+'/edge-summary.json','w') as f: json.dump(summary,f)
print('Explicit edge exception inspected; actual peer/routing/external firewall acceptance remains.')
PY
}

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
 'edgeInspection':read('edge-summary') if os.path.exists(stage+'/edge-summary.json') else {'status':'not-requested'},
 'remainingAcceptance':['independent snapshot plus server-token backup and fresh-host restore',
 'exact signed shell/catalog and application source binding','external TLS and complete public route/model/relay parity',
 'authenticated sign-in, collaboration, agents, DAM originals, shared uploads and render load',
 'measured capacity, writer drain, database continuity, DNS and Compose rollback rehearsal']}
with os.fdopen(os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f: json.dump(report,f,indent=2);f.write('\n')
print('Automatic cluster checks passed; promotionReady=false; actual recovery/application/cutover gates remain.')
PY
}

qualify_main() {
  local private= public= probe= images= output= kubeconfig= context= interface= provider= review= edge= edge_review=
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || fail 'option requires a value'
    case $1 in
      --namespace) private=$2 ;; --public-namespace) public=$2 ;; --probe-pod) probe=$2 ;;
      --image-review) images=$2 ;; --output) output=$2 ;; --kubeconfig) kubeconfig=$2 ;;
      --context) context=$2 ;; --interface) interface=$2 ;; --provider) provider=$2 ;; --provider-review) review=$2 ;;
      --edge-namespace) edge=$2 ;; --edge-review) edge_review=$2 ;;
      *) fail "unknown qualification option: $1" ;;
    esac
    shift 2
  done
  [[ -n $private && -n $public && $private != "$public" && -n $probe && -n $images && -n $output && -n $kubeconfig && -n $context && -n $interface && -n $review ]] || fail 'all qualification inputs are required; public/private namespaces must differ'
  [[ $private =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $public =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $probe =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || fail 'invalid Kubernetes name'
  [[ $private != default && $public != default && $private != kube-* && $public != kube-* ]] || fail 'reserved namespaces refused'
  [[ -z $edge && -z $edge_review || -n $edge && -n $edge_review ]] || fail 'edge namespace and review must be provided together'
  if [[ -n $edge ]]; then
    [[ $edge =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $edge != "$private" && $edge != "$public" && $edge != default && $edge != kube-* ]] || fail 'edge namespace must be distinct and nonreserved'
  fi
  python3 -I - "$kubeconfig" "$images" "$edge_review" <<'PY'
import os,stat,sys
for p in sys.argv[1:]:
    if not p: continue
    s=os.lstat(p);assert stat.S_ISREG(s.st_mode) and not s.st_mode & 0o077, 'kubeconfig/review must be private regular files'
PY
  validate_provider_review "$review" "$provider"
  validate_ephemeral_range "$review" "$(cat /proc/sys/net/ipv4/ip_local_port_range)"
  validate_network "$interface"
  local version binary_url binary_sha installer_url installer_sha
  read -r version binary_url binary_sha installer_url installer_sha < <(read_release_lock)
  verify_file /usr/local/bin/k3s "$binary_sha"
  local encryption_status
  encryption_status=$(/usr/local/bin/k3s secrets-encrypt status) || fail 'cannot inspect Secret encryption'
  [[ $encryption_status == *'Encryption Status: Enabled'* && $encryption_status == *'All hashes match'* ]] || fail 'Kubernetes Secret encryption is disabled or inconsistent'
  local kube=(/usr/local/bin/k3s kubectl --kubeconfig "$kubeconfig" --context "$context")
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
  if [[ -n $edge ]]; then
    "${kube[@]}" get namespace "$edge" -o json > "$K3S_QUALIFY_STAGE/$edge-namespace.json"
    for resource in pods services serviceaccounts rolebindings; do
      local suffix=$resource
      if [[ $resource == serviceaccounts ]]; then suffix=accounts; fi
      "${kube[@]}" get "$resource" -n "$edge" -o json > "$K3S_QUALIFY_STAGE/$edge-$suffix.json"
    done
    "${kube[@]}" get clusterrolebindings -o json > "$K3S_QUALIFY_STAGE/edge-clusterrolebindings.json"
    local edge_node
    edge_node=$(python3 -I - "$edge_review" <<'PY'
import json,re,sys
name=json.load(open(sys.argv[1]))['nodeName'];assert re.fullmatch(r'[a-z0-9]([-a-z0-9.]*[a-z0-9])?',name);print(name)
PY
)
    "${kube[@]}" get node "$edge_node" -o json > "$K3S_QUALIFY_STAGE/edge-node.json"
    validate_edge_files "$K3S_QUALIFY_STAGE" "$private" "$public" "$edge" "$edge_review"
  fi
  # No token is read. CoreDNS readiness proves its API cache is ready; this lookup
  # proves the default-deny Work namespace can still resolve cluster DNS.
  "${kube[@]}" exec -n "$private" "$probe" -c server -- node -e \
    'require("node:dns").promises.lookup("kubernetes.default.svc.cluster.local").then(() => process.exit(0), () => process.exit(1)); setTimeout(() => process.exit(1), 5000).unref()' >/dev/null
  validate_cluster_files "$K3S_QUALIFY_STAGE" "$private" "$public" "$probe" "$images" "$version" "$output"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then qualify_main "$@"; fi
