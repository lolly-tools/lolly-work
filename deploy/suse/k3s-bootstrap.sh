#!/usr/bin/env bash
# First installation on a dedicated candidate. Never adopts or upgrades a host.
set -euo pipefail

K3S_OPERATOR_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

fail() { printf '%s\n' "k3s operator: $*" >&2; exit 1; }

read_release_lock() {
  python3 -I - "$K3S_OPERATOR_DIR/k3s.lock.json" <<'PY'
import json,re,sys
d=json.load(open(sys.argv[1]))
assert re.fullmatch(r'v1\.34\.\d+\+k3s\d+',d['version'])
assert d['architecture']=='amd64' and d['kubernetesMinor']=='1.34'
assert re.fullmatch(r'[a-f0-9]{40}',d['releaseCommit'])
assert d['binary']['url']==f"https://github.com/k3s-io/k3s/releases/download/{d['version'].replace('+','%2B')}/k3s"
assert d['installer']['url']==f"https://raw.githubusercontent.com/k3s-io/k3s/{d['releaseCommit']}/install.sh"
for key in ['binary','installer']:
    assert re.fullmatch(r'[a-f0-9]{64}',d[key]['sha256'])
print(d['version'],d['binary']['url'],d['binary']['sha256'],d['installer']['url'],d['installer']['sha256'])
PY
}

emit_config() {
  python3 -I - "$1" "$2" "${3:-false}" <<'PY'
import ipaddress,json,re,sys
address=ipaddress.IPv4Address(sys.argv[1])
assert any(address in ipaddress.ip_network(c) for c in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']), 'node-ip must be private IPv4'
assert not any(address in ipaddress.ip_network(c) for c in ['10.42.0.0/16','10.43.0.0/16']), 'node-ip overlaps pod/service CIDR'
assert re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?',sys.argv[2]), 'invalid node name'
assert sys.argv[3] in ['true','false']
print(json.dumps({
 'node-name':sys.argv[2], 'node-ip':str(address), 'advertise-address':str(address),
 'bind-address':'0.0.0.0', 'cluster-init':True, 'secrets-encryption':True,
 'write-kubeconfig-mode':'0600', 'selinux':sys.argv[3]=='true',
 'cluster-cidr':'10.42.0.0/16', 'service-cidr':'10.43.0.0/16',
 'disable':['traefik','servicelb'],
 'etcd-snapshot-schedule-cron':'0 */6 * * *', 'etcd-snapshot-retention':8,
 'etcd-snapshot-compress':True, 'kube-apiserver-arg':['profiling=false'],
 'kubelet-arg':['image-gc-high-threshold=75','image-gc-low-threshold=65']
},indent=2))
PY
}

verify_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail 'verified artifact must be a regular file'
  [[ $(sha256sum -- "$1" | cut -d ' ' -f 1) == "$2" ]] || fail 'artifact checksum mismatch'
}

validate_provider_review() {
  python3 -I - "$1" "$2" <<'PY'
import datetime,ipaddress,json,os,stat,sys
p=sys.argv[1];s=os.lstat(p)
assert stat.S_ISREG(s.st_mode) and not s.st_mode & 0o077, 'review must be a private regular file'
d=json.load(open(p));assert d['provider']==sys.argv[2] and d['provider'] in ['upcloud','evroc']
assert d['controlPlanePublic'] is False and d['nodePortsPublic'] is False
assert d['dualStackReviewed'] is True, 'review both address families or verify the unused family is disabled'
assert set(d['publicUdpPorts']).issubset({443}), 'only optional HTTP/3 UDP 443 is public'
assert set(d['publicTcpPorts']).issubset({22,80,443}) and 22 in d['publicTcpPorts']
if d['provider']=='upcloud':
    assert d['statelessFirewall'] is True, 'UpCloud public/utility firewall is stateless'
if d.get('statelessFirewall'):
    assert d['hostConnectionTrackingRequired'] is True, 'stateless return traffic requires host connection tracking'
    ports=d['kernelEphemeralPortRange'];assert isinstance(ports['start'],int) and isinstance(ports['end'],int) and 32768 <= ports['start'] <= ports['end'] <= 65535, 'return range must exclude control-plane and NodePorts'
    returns=d['statelessReturnRules'];assert returns, 'review actual stateless return rules'
    protocols=set()
    for rule in returns:
        assert rule['family'] in ['IPv4','IPv6'] and rule['protocol'] in ['tcp','udp']
        assert rule['destinationPortRange']==ports and rule['sourceCidrs']
        assert (rule['protocol'],rule['sourcePort']) in [('tcp',80),('tcp',443),('tcp',53),('udp',53),('udp',123)], 'unreviewed return protocol/port'
        for cidr in rule['sourceCidrs']:
            network=ipaddress.ip_network(cidr)
            assert network.version==(4 if rule['family']=='IPv4' else 6)
            if rule['sourcePort'] in [53,123]:
                assert network.prefixlen==network.max_prefixlen, 'resolver/time peers must be exact hosts'
        protocols.add((rule['protocol'],rule['sourcePort']))
    assert {('tcp',443),('tcp',53),('udp',53)}.issubset(protocols), 'HTTPS and UDP/TCP resolver return paths must be reviewed'
assert d['sshSourceCidrs']
for c in d['sshSourceCidrs']:
    n=ipaddress.ip_network(c)
    assert n.prefixlen >= (24 if n.version==4 else 64), 'SSH sources must be narrow administrator ranges'
assert isinstance(d['reviewedAt'],str) and isinstance(d['reviewedRulesSha256'],str)
reviewed=datetime.datetime.fromisoformat(d['reviewedAt'].replace('Z','+00:00'))
assert reviewed.tzinfo and 0 <= (datetime.datetime.now(datetime.timezone.utc)-reviewed).total_seconds() <= 86400, 'provider review must be current within 24 hours'
assert len(d['reviewedRulesSha256'])==64 and all(c in '0123456789abcdef' for c in d['reviewedRulesSha256'])
PY
}

validate_ephemeral_range() {
  python3 -I - "$1" "$2" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get('statelessFirewall'):
    observed=[int(x) for x in sys.argv[2].split()]
    assert observed==[d['kernelEphemeralPortRange']['start'],d['kernelEphemeralPortRange']['end']], 'host kernel ephemeral range differs from reviewed provider return rules'
PY
}

validate_network() {
  local interface=$1 zone service port state target runtime_zone permanent_target rich forwards trusted_interfaces trusted_sources permanent_trusted_sources active_zones services ports permanent_services permanent_ports permanent_rich permanent_forwards permanent_trusted_interfaces permanent_zone
  [[ $interface =~ ^[a-zA-Z0-9_.:-]+$ ]] || fail 'invalid public interface'
  state=$(firewall-cmd --state) || fail 'cannot inspect firewall state'
  [[ $state == running ]] || fail 'firewalld must remain active'
  zone=$(firewall-cmd --get-zone-of-interface="$interface") || fail 'cannot inspect interface zone'
  [[ -n $zone && $zone != 'no zone' && $zone != trusted ]] || fail 'public interface needs a restricted zone'
  runtime_zone=$(firewall-cmd --zone="$zone" --list-all) || fail 'cannot inspect runtime public zone'
  target=$(printf '%s\n' "$runtime_zone" | awk '$1 == "target:" {count++; if (NF == 2) target=$2} END {if (count != 1 || target == "") exit 1; print target}') || fail 'cannot inspect runtime public target'
  permanent_target=$(firewall-cmd --permanent --zone="$zone" --get-target) || fail 'cannot inspect permanent target'
  [[ $target == "$permanent_target" ]] || fail 'runtime/permanent public targets differ'
  case $target in default|DROP|REJECT) ;; *) fail 'public zone target must refuse unsolicited traffic' ;; esac
  rich=$(firewall-cmd --zone="$zone" --list-rich-rules) || fail 'cannot inspect public rules'
  forwards=$(firewall-cmd --zone="$zone" --list-forward-ports) || fail 'cannot inspect public forwarding'
  services=$(firewall-cmd --zone="$zone" --list-services) || fail 'cannot inspect public services'
  ports=$(firewall-cmd --zone="$zone" --list-ports) || fail 'cannot inspect public ports'
  trusted_interfaces=$(firewall-cmd --zone=trusted --list-interfaces) || fail 'cannot inspect trusted interfaces'
  trusted_sources=$(firewall-cmd --zone=trusted --list-sources) || fail 'cannot inspect trusted sources'
  permanent_trusted_sources=$(firewall-cmd --permanent --zone=trusted --list-sources) || fail 'cannot inspect permanent sources'
  active_zones=$(firewall-cmd --get-active-zones) || fail 'cannot inspect active zones'
  permanent_services=$(firewall-cmd --permanent --zone="$zone" --list-services) || fail 'cannot inspect permanent services'
  permanent_ports=$(firewall-cmd --permanent --zone="$zone" --list-ports) || fail 'cannot inspect permanent ports'
  permanent_rich=$(firewall-cmd --permanent --zone="$zone" --list-rich-rules) || fail 'cannot inspect permanent rules'
  permanent_forwards=$(firewall-cmd --permanent --zone="$zone" --list-forward-ports) || fail 'cannot inspect permanent forwarding'
  permanent_trusted_interfaces=$(firewall-cmd --permanent --zone=trusted --list-interfaces) || fail 'cannot inspect permanent trusted interfaces'
  permanent_zone=$(firewall-cmd --permanent --get-zone-of-interface="$interface") || fail 'cannot inspect permanent interface'
  [[ -z $rich ]] || fail 'review custom rich rules separately; this kit refuses them'
  [[ -z $forwards ]] || fail 'public port forwarding is refused'
  for service in $services; do
    case $service in ssh|http|https|dhcpv6-client) ;; *) fail "unexpected public service: $service" ;; esac
  done
  for port in $ports; do
    case $port in 22/tcp|80/tcp|443/tcp|443/udp) ;; *) fail "unexpected public port: $port" ;; esac
  done
  [[ -z $trusted_interfaces ]] || fail 'trusted zone may contain no host interfaces'
  python3 -I - "$trusted_sources" "$permanent_trusted_sources" <<'PY'
import sys
assert all(set(s.split())=={'10.42.0.0/16','10.43.0.0/16'} for s in sys.argv[1:]), 'trusted sources must be only the pod/service ranges'
PY
  local active_zone
  for active_zone in $(printf '%s\n' "$active_zones" | grep -E '^[^[:space:]]' | cut -d ' ' -f 1); do
    [[ $active_zone == "$zone" || $active_zone == trusted || $active_zone == drop ]] || fail 'unreviewed active firewall zone'
  done
  for port in 10.42.0.0/16 10.43.0.0/16; do
    firewall-cmd --zone=trusted --query-source="$port" >/dev/null || fail 'pod/service firewall paths are missing'
  done
  # Also inspect permanent rules: reboot must not expose the API or close pod DNS.
  for port in 6443/tcp 10250/tcp 2379/tcp 2380/tcp 8472/udp 51820/udp 51821/udp; do
    local mode status
    for mode in runtime permanent; do
      local query=(firewall-cmd --zone="$zone" --query-port="$port")
      if [[ $mode == permanent ]]; then query+=(--permanent); fi
      if "${query[@]}" >/dev/null; then fail "control-plane port is public: $port"; else status=$?; fi
      [[ $status -eq 1 ]] || fail 'control-plane firewall query failed'
    done
  done
  [[ $permanent_services == "$services" ]] || fail 'runtime/permanent public services differ'
  [[ $permanent_zone == "$zone" ]] || fail 'permanent public interface differs'
  [[ $permanent_ports == "$ports" ]] || fail 'runtime/permanent public ports differ'
  [[ -z $permanent_rich && -z $permanent_forwards ]] || fail 'permanent public override refused'
  [[ -z $permanent_trusted_interfaces ]] || fail 'permanent trusted interface refused'
  for port in 10.42.0.0/16 10.43.0.0/16; do
    firewall-cmd --permanent --zone=trusted --query-source="$port" >/dev/null || fail 'permanent pod/service paths are missing'
  done
}

validate_existing_units() {
  if printf '%s\n' "$1" | grep -Eq '^(k3s|rke2|docker|caddy)'; then fail 'existing application/cluster units are refused'; fi
}

validate_policy_scaffold_entries() {
  python3 -I - "$1" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
assert d['path']==d['canonical']=='/var/lib/rancher/k3s', 'policy scaffold must be the literal K3s data path'
allowed={'','agent','agent/containerd','agent/containerd/io.containerd.snapshotter.v1.overlayfs','agent/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots','data'}
entries=d['entries'];assert entries and entries[0]['relative']=='', 'scaffold root metadata required'
assert len({e['relative'] for e in entries})==len(entries), 'duplicate scaffold metadata refused'
for e in entries:
    assert e['relative'] in allowed and e['type']=='directory', 'initialized or unexpected cluster state refused'
    assert e['uid']==0 and not e['mode'] & 0o022, 'policy scaffold must be root-owned and not writable by others'
PY
}

validate_policy_scaffold() {
  [[ $1 == /var/lib/rancher/k3s ]] || fail 'only the SUSE K3s policy scaffold can be inspected'
  rpm -q k3s-selinux >/dev/null || fail 'existing data path needs the installed SUSE k3s-selinux policy'
  local metadata vendor
  vendor=$(rpm -q --qf '%{VENDOR}' k3s-selinux) || fail 'cannot inspect policy RPM vendor'
  [[ $vendor == 'SUSE LLC <https://www.suse.com/>' ]] || fail 'scaffold exception requires the reviewed SUSE policy RPM'
  metadata=$(python3 -I - "$1" <<'PY'
import json,os,stat,sys
root=sys.argv[1];entries=[];pending=[root]
while pending:
    path=pending.pop();s=os.lstat(path)
    directory=stat.S_ISDIR(s.st_mode)
    entries.append({'relative':os.path.relpath(path,root) if path!=root else '', 'type':'directory' if directory else 'other', 'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode)})
    if directory:
        pending.extend(sorted((e.path for e in os.scandir(path)),reverse=True))
print(json.dumps({'path':root,'canonical':os.path.realpath(root),'entries':entries}))
PY
) || fail 'cannot inspect policy scaffold metadata'
  validate_policy_scaffold_entries "$metadata"
}

host_preflight() {
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'only the amd64 Linux candidate is supported'
  [[ $EUID -eq 0 ]] || fail 'host preflight/install requires root'
  [[ $(hostname) == "$CANDIDATE_HOST" ]] || fail 'candidate-host must equal this dedicated host name'
  for tool in python3 curl sha256sum systemctl ip ss firewall-cmd rpm; do
    command -v "$tool" >/dev/null || fail "missing host prerequisite: $tool"
  done
  local osid
  osid=$(. /etc/os-release; printf '%s' "$ID")
  case $osid in sles|opensuse-leap|opensuse-tumbleweed) ;; *) fail 'reviewed SLES/openSUSE host required; transactional hosts need their own installer' ;; esac
  for path in /etc/rancher/k3s /var/lib/rancher/k3s /var/lib/rancher/rke2 /usr/local/bin/k3s; do
    if [[ -e $path || -L $path ]]; then
      if [[ $path == /var/lib/rancher/k3s ]]; then validate_policy_scaffold "$path";
      else fail 'existing cluster state is refused'; fi
    fi
  done
  if command -v k3s >/dev/null; then fail 'existing K3s binary is refused'; fi
  local units listeners
  units=$(systemctl list-unit-files --no-legend) || fail 'cannot inspect existing units'
  validate_existing_units "$units"
  listeners=$(ss -H -ltn 'sport = :80 or sport = :443 or sport = :6443') || fail 'cannot inspect host listeners'
  [[ -z $listeners ]] || fail 'candidate HTTP/control-plane ports are occupied'
  python3 -I - "$NODE_IP" <<'PY'
import json,os,subprocess,sys
assert os.cpu_count()>=4, 'candidate needs the reviewed four-CPU budget'
mem=int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemTotal:')))
assert mem>=7*1024*1024, 'candidate needs at least seven usable GiB'
s=os.statvfs('/var');assert s.f_bavail*s.f_frsize>=40*1024**3, 'candidate needs 40 GiB free for rehearsal/rollback'
assert len(open('/proc/swaps').read().splitlines())==1, 'active swap needs separate qualification'
controllers=open('/sys/fs/cgroup/cgroup.controllers').read().split()
assert all(x in controllers for x in ['cpu','memory','pids']), 'cgroup v2 controllers required'
interfaces=json.loads(subprocess.check_output(['ip','-j','-4','address','show'],text=True))
assert any(a.get('local')==sys.argv[1] for i in interfaces for a in i.get('addr_info',[])), 'node-ip is not assigned to this host'
PY
  SELINUX=false
  if command -v getenforce >/dev/null; then
    case $(getenforce) in
      Enforcing) rpm -q k3s-selinux >/dev/null || fail 'install/review the matching SELinux policy first'; SELINUX=true ;;
      Disabled) ;;
      *) fail 'permissive/unknown SELinux posture is refused' ;;
    esac
  fi
  validate_provider_review "$PROVIDER_REVIEW" "$PROVIDER"
  validate_ephemeral_range "$PROVIDER_REVIEW" "$(cat /proc/sys/net/ipv4/ip_local_port_range)"
  validate_network "$PUBLIC_INTERFACE"
}

run_verified_installer() {
  # The upstream installer otherwise copies caller K3S_* and proxy credentials.
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    INSTALL_K3S_VERSION="$1" INSTALL_K3S_EXEC=server \
    INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_SKIP_SELINUX_RPM=true \
    INSTALL_K3S_SKIP_START=true INSTALL_K3S_SKIP_ENABLE=true sh "$2"
}

main() {
  local command=${1:-preflight}
  if [[ $# -gt 0 ]]; then shift; fi
  case $command in preflight|install|config) ;; *) fail 'usage: k3s-bootstrap.sh {preflight|install|config} --provider {upcloud|evroc} --node-ip PRIVATE_IP --candidate-host NAME --interface PUBLIC_IF --provider-review PRIVATE_JSON'; return 1 ;; esac
  PROVIDER= NODE_IP= CANDIDATE_HOST= PUBLIC_INTERFACE= PROVIDER_REVIEW=
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || fail 'option requires a value'
    case $1 in
      --provider) PROVIDER=$2 ;; --node-ip) NODE_IP=$2 ;; --candidate-host) CANDIDATE_HOST=$2 ;;
      --interface) PUBLIC_INTERFACE=$2 ;; --provider-review) PROVIDER_REVIEW=$2 ;;
      *) fail "unknown option: $1" ;;
    esac
    shift 2
  done
  [[ $PROVIDER == upcloud || $PROVIDER == evroc ]] || fail 'provider must be upcloud or evroc'
  emit_config "$NODE_IP" "$CANDIDATE_HOST" >/dev/null
  if [[ $command == config ]]; then emit_config "$NODE_IP" "$CANDIDATE_HOST"; return; fi
  [[ -n $PUBLIC_INTERFACE && -n $PROVIDER_REVIEW ]] || fail 'interface and provider review are required'
  read_release_lock >/dev/null
  host_preflight
  if [[ $command == preflight ]]; then printf '%s\n' 'Candidate preflight passed; no downloads or host changes.'; return; fi
  local stage version binary_url binary_sha installer_url installer_sha
  read -r version binary_url binary_sha installer_url installer_sha < <(read_release_lock)
  umask 077
  stage=$(mktemp -d)
  K3S_OPERATOR_STAGE=$stage
  trap 'rm -rf -- "$K3S_OPERATOR_STAGE"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 300 "$binary_url" -o "$stage/k3s"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 60 "$installer_url" -o "$stage/install.sh"
  verify_file "$stage/k3s" "$binary_sha"
  verify_file "$stage/install.sh" "$installer_sha"
  emit_config "$NODE_IP" "$CANDIDATE_HOST" "$SELINUX" > "$stage/config.yaml"
  install -d -m 0700 /etc/rancher/k3s
  install -m 0600 "$stage/config.yaml" /etc/rancher/k3s/config.yaml
  install -m 0755 "$stage/k3s" /usr/local/bin/k3s
  run_verified_installer "$version" "$stage/install.sh"
  printf '%s\n' 'Pinned K3s staged disabled and stopped. Review config/unit, then follow K3S-OPERATOR.md to start and qualify only this candidate.'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
