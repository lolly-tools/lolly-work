#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Stage the public five-path overlay with one new PVC and the accepted Nginx image.

check is offline. Other phases require an explicitly reviewed target and a final
preflight before every mutation. A started phase is never replayed. Models and
active overlay claims are never mounted in a staging Pod.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
import zlib
sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


private = module('public_stage_primitives', 'stage-private-shell.py')
public = module('public_stage_contract', 'prepare-public-shell.py')
updater, resources, cohort = private.updater, private.resources, public.cohort
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
SOURCE_NAMES = {'stage-public-shell.py', 'stage-private-shell.py', 'prepare-public-shell.py', 'prepare-private-shell.py',
                'prepare-private-cohort.py', 'prepare-paired-release.py', 'plan-private-cohort.py', 'app-update.py'}
INPUT_KEYS = {'version', 'target', 'prepared', 'planningEvidence', 'baseline', 'publicKey', 'preflight', 'hostProbe',
              'names', 'storage', 'minimumFreeBytes', 'maximumWriteBytes', 'outputDirectory', 'node', 'sourceFiles'}

# This program reads metadata through the already reviewed host transport. It
# never repairs modes, writes a label, mounts storage or reads asset contents.
ROOT_METADATA_SCRIPT = r'''import errno, hashlib, json, os, pathlib, stat, subprocess, sys
def need(value):
    if not value: raise RuntimeError("Read-only local PV root metadata refused")
def canonical(value): return json.dumps(value,sort_keys=True,separators=(",",":")).encode()
x=json.loads(sys.argv[1])
need(type(x) is dict and set(x)=={"version","kubectl","clusterUID","node","claim","pv","storageClass"} and type(x["version"]) is int and x["version"]==1)
def get(kind,name,namespace=None):
    argv=[*x["kubectl"],"get",kind,name,"-o","json"]
    if namespace: argv.extend(["--namespace",namespace])
    result=subprocess.run(argv,capture_output=True,timeout=30)
    need(result.returncode==0 and len(result.stdout)<=2*1024**2 and len(result.stderr)<=16384)
    return json.loads(result.stdout)
def guards():
    need(get("namespace","kube-system")["metadata"]["uid"]==x["clusterUID"])
    node=get("node",x["node"]["name"])
    need(node["metadata"]["uid"]==x["node"]["uid"] and not node["metadata"].get("deletionTimestamp") and any(c.get("type")=="Ready" and c.get("status")=="True" for c in node.get("status",{}).get("conditions",[])))
    for field in ("claim","pv","storageClass"):
        want=x[field]; actual=get(want["kind"],want["metadata"]["name"],want["metadata"].get("namespace"))
        need(actual.get("apiVersion")==want["apiVersion"] and actual.get("kind")==want["kind"] and all(actual.get("metadata",{}).get(k)==want["metadata"].get(k) for k in ("name","namespace","uid")) and not actual["metadata"].get("deletionTimestamp"))
        need({k:v for k,v in actual.items() if k not in {"metadata","status"}}=={k:v for k,v in want.items() if k not in {"metadata","status"}})
        if field!="storageClass": need(actual.get("status",{}).get("phase")=="Bound")
guards()
p=pathlib.Path(x["pv"]["spec"]["local"]["path"])
need(p.is_absolute() and str(p)==x["pv"]["spec"]["local"]["path"] and ".." not in p.parts)
paths=[*reversed(p.parents),p]
def identity(value): return [value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid]
def stamp(value): return [*identity(value),value.st_size,value.st_mtime_ns,value.st_ctime_ns]
before=[q.lstat() for q in paths]
need(all(stat.S_ISDIR(v.st_mode) and not stat.S_ISLNK(v.st_mode) for v in before))
try:
    label=os.getxattr(p,"security.selinux",follow_symlinks=False).decode("ascii").rstrip("\0") if hasattr(os,"getxattr") else None
    if label is None: raise OSError(errno.ENOTSUP,"xattr API unavailable")
    need(len(label)<=256 and "\n" not in label and "\0" not in label)
except OSError as error:
    need(error.errno in {errno.ENODATA,errno.ENOTSUP,getattr(errno,"EOPNOTSUPP",errno.ENOTSUP)})
    label=None
guards()
after=[q.lstat() for q in paths]
# Unrelated entries may change ancestor timestamps without changing this path.
need([identity(v) for v in before[:-1]]==[identity(v) for v in after[:-1]] and stamp(before[-1])==stamp(after[-1]))
def metadata(q,v): return {"path":str(q),"device":v.st_dev,"inode":v.st_ino,"mode":stat.S_IMODE(v.st_mode),"uid":v.st_uid,"gid":v.st_gid}
print(canonical({"version":1,"status":"READ_ONLY_PUBLIC_LOCAL_PV_ROOT_METADATA_OBSERVED","clusterUID":x["clusterUID"],"node":x["node"],"claimUID":x["claim"]["metadata"]["uid"],"pvUID":x["pv"]["metadata"]["uid"],"pvSpecSha256":hashlib.sha256(canonical(x["pv"]["spec"])).hexdigest(),"root":{**metadata(p,before[-1]),"selinuxLabel":label},"ancestors":[metadata(q,v) for q,v in zip(paths[:-1],before[:-1])],"readOnly":True,"productionMutation":False}).decode())
'''


def validate_root_metadata(value, target, claim, pv):
    exact(value, {'version','status','clusterUID','node','claimUID','pvUID','pvSpecSha256','root','ancestors','readOnly','productionMutation'})
    require(type(value['version']) is int and value['version'] == 1 and value['status'] == 'READ_ONLY_PUBLIC_LOCAL_PV_ROOT_METADATA_OBSERVED'
            and value['clusterUID'] == target['clusterUID'] and value['node'] == target['node'] and value['claimUID'] == claim['metadata']['uid']
            and value['pvUID'] == pv['metadata']['uid'] and value['pvSpecSha256'] == cohort.digest(pv['spec'])
            and value['readOnly'] is True and value['productionMutation'] is False, 'Actual read-only root proof identity differs')
    root = value['root']; exact(root, {'path','device','inode','mode','uid','gid','selinuxLabel'})
    require(root['path'] == pv['spec']['local']['path'] and all(type(root[k]) is int and root[k] >= 0 for k in ('device','inode','mode','uid','gid'))
            and root['inode'] > 0 and root['mode'] <= 0o7777 and root['gid'] == 101 and root['mode'] & 0o770 == 0o770 and root['mode'] & 0o2000,
            'Local PV root must already have GID 101, owner/group rwx and setgid; no repair is permitted')
    require(root['selinuxLabel'] is None or isinstance(root['selinuxLabel'],str) and len(root['selinuxLabel']) <= 256
            and '\n' not in root['selinuxLabel'] and '\0' not in root['selinuxLabel'], 'Invalid bounded root label metadata')
    ancestors = value['ancestors']; paths = [str(p) for p in reversed(Path(root['path']).parents)]
    require(isinstance(ancestors,list) and [r.get('path') for r in ancestors] == paths, 'Complete actual non-link ancestry required')
    for row in ancestors:
        exact(row, {'path','device','inode','mode','uid','gid'})
        require(all(type(row[k]) is int and row[k] >= 0 for k in ('device','inode','mode','uid','gid')) and row['inode'] > 0 and row['mode'] <= 0o7777, 'Invalid original ancestor metadata')
    return value


def same_root(before, after):
    # SELinux categories and ctime may change during the normal kubelet handoff;
    # filesystem identity and DAC permissions must not. Never share MCS labels.
    require(all(before.get(k) == after.get(k) for k in ('clusterUID','node','claimUID','pvUID','pvSpecSha256'))
            and before['ancestors'] == after['ancestors']
            and {k:v for k,v in before['root'].items() if k != 'selinuxLabel'} == {k:v for k,v in after['root'].items() if k != 'selinuxLabel'},
            'PV root identity or DAC mode changed during read-only handoff')


def root_command(guard, config):
    encoded = cohort.canonical(config)
    require(len(encoded) <= 64 * 1024, 'Bounded exact metadata configuration required')
    command = ['python3','-c',ROOT_METADATA_SCRIPT,encoded.decode()]
    t = guard.target['transport']
    if t['type'] == 'ssh':
        if t.get('sudo'): command = ['sudo','-n',*command]
        command = [*guard.transport([])[:-1],private.shlex.join(command)]
    return command


def root_proof(ref, guard, claim, pv):
    """Bind metadata to the exact retained read-only program and original bytes."""
    proof = guard.inputs.file(ref); exact(proof, {'metadata','originalCommand'})
    value = validate_root_metadata(proof['metadata'],guard.target,claim,pv)
    command = guard.inputs.file(proof['originalCommand'])
    require(command.get('exitCode') == 0 and command.get('timedOut') is False and command.get('readOnlyMountProbe') is False
            and set(command.get('originals',{})) == {'stdout','stderr'}, 'Genuine original root metadata command required')
    argv = command.get('argv'); require(isinstance(argv,list) and argv, 'Exact root command argv required')
    inner = private.shlex.split(argv[-1]) if guard.target['transport']['type'] == 'ssh' else argv
    if guard.target['transport'].get('sudo'): require(inner[:2] == ['sudo','-n'], 'Root reader privilege prefix differs'); inner = inner[2:]
    require(len(inner) == 4 and inner[:3] == ['python3','-c',ROOT_METADATA_SCRIPT], 'Read-only metadata program changed')
    config = cohort.parse_json(inner[3].encode()); exact(config, {'version','kubectl','clusterUID','node','claim','pv','storageClass'})
    t = guard.target['transport']
    require(type(config['version']) is int and config['version'] == 1 and config['clusterUID'] == guard.target['clusterUID'] and config['node'] == guard.target['node']
            and config['kubectl'] == [*t['kubectl'],'--kubeconfig',t['kubeconfig'],'--context',t['context']] and argv == root_command(guard,config), 'Metadata origin/target/transport changed')
    for role, expected in (('claim',claim),('pv',pv),('storageClass',guard.baseline['storageClass'])):
        actual = config[role]
        require(actual.get('apiVersion') == expected['apiVersion'] and actual.get('kind') == expected['kind']
                and all(actual.get('metadata',{}).get(k) == expected['metadata'].get(k) for k in ('name','namespace','uid'))
                and isinstance(actual['metadata'].get('resourceVersion'),str) and actual['metadata']['resourceVersion'] and not actual['metadata'].get('deletionTimestamp')
                and {k:v for k,v in actual.items() if k not in {'metadata','status'}} == {k:v for k,v in expected.items() if k not in {'metadata','status'}}, 'Metadata resource identity/spec changed')
    for name in ('stdout','stderr'):
        original = command['originals'][name]
        require(original.get('complete') is True and type(original.get('observedBytes')) is int and 0 <= original['observedBytes'] <= 1024**2, 'Metadata command bytes incomplete')
        raw = guard.inputs.file({k:original[k] for k in ('path','sha256')},False).read_bytes()
        require(len(raw) == original['observedBytes'], 'Metadata command original byte size differs')
        require((cohort.parse_json(raw) == value) if name == 'stdout' else raw == b'', 'Metadata proof differs from actual stdout or stderr')
    return value


def checksum(path): return cohort.hash_file(Path(path), cohort.MAX_BYTES)[1]


def complete_list(value, kind, namespace=None):
    api = {'Pod':'v1', 'PersistentVolumeClaim':'v1', 'PersistentVolume':'v1', 'Deployment':'apps/v1',
           'NetworkPolicy':'networking.k8s.io/v1', 'Service':'v1'}[kind]
    require(isinstance(value, dict) and set(value) == {'apiVersion','kind','metadata','items'} and
            ((value['kind'] == 'List' and value['apiVersion'] == 'v1') or (value['kind'] == kind + 'List' and value['apiVersion'] == api))
            and isinstance(value['metadata'], dict) and not value['metadata'].get('continue')
            and type(value['metadata'].get('remainingItemCount', 0)) is int and value['metadata'].get('remainingItemCount', 0) == 0
            and isinstance(value['items'], list) and len(value['items']) <= 100000, 'Complete original Kubernetes collection required')
    names, uids = set(), set()
    for item in value['items']:
        meta = public.resource(item, api, kind, item.get('metadata', {}).get('namespace') if namespace == '*' else namespace)['metadata']
        if namespace == '*': resources.name(meta.get('namespace'))
        key = (meta.get('namespace'), meta['name'])
        require(key not in names and meta['uid'] not in uids and not meta.get('deletionTimestamp'), 'Duplicate or deleting inventory identity')
        names.add(key); uids.add(meta['uid'])
    return value


def overlap(left, right):
    if left[0] != right[0]: return False
    if left[0] == 'csi': return left == right
    if left[1] != right[1]: return False
    return resources.overlaps(left, right)


def isolated_backing(claim, volumes, namespace):
    mapping = {v['metadata']['name']:v for v in complete_list(volumes, 'PersistentVolume')['items']}
    selected = resources.bound_claim(claim, mapping, namespace)
    for other in mapping.values():
        require(other['metadata']['uid'] == selected['metadata']['uid'] or not overlap(resources.backing(selected), resources.backing(other)),
                'New backing aliases another global active, dormant or rollback PV')
    return selected


def bind_prepared(inputs, prepared_ref, evidence_ref, node):
    prepared, evidence = inputs.file(prepared_ref), inputs.file(evidence_ref)
    require(prepared.get('status') == public.STATUS and prepared.get('reviewedEvidenceSha256') == evidence_ref['sha256'], 'Maintained public CLI custody required')
    rebuilt, held = public.prepare(evidence, cohort.local_path(evidence_ref['path'], inputs.base).parent, node)
    rebuilt['reviewedEvidenceSha256'] = evidence_ref['sha256']
    rebuilt['evidence'].append({'path': str(cohort.local_path(evidence_ref['path'], inputs.base)), 'sha256':evidence_ref['sha256']})
    rebuilt['evidence'].sort(key=lambda row:row['path'])
    require(rebuilt == prepared, 'Prepared public plan differs from independently recomputed contract')
    inputs.reads.update(held.reads); inputs.trees.extend(held.trees)
    inputs.source_checks.extend(held.source_checks); inputs.source_roots.extend(held.source_roots)
    return prepared, evidence


# Nginx has no Node. The actual read-only owner emits a complete bounded ASCII
# checksum inventory. Models are deliberately pruned; all other links/special
# files refuse. Raw command stdout is retained before parsing or comparison.
HASH_SCRIPT = r'''set -eu
refuse() { printf "%s\n" "LOLLY_STATIC_HASH_SCAN_REFUSED"; exit 1; }
trap 'rc=$?; if [ "$rc" -ne 0 ]; then printf "%s\n" "LOLLY_STATIC_HASH_SCAN_REFUSED"; fi' 0
root=$1
cd "$root" || refuse
bad=$(find . -path ./models -prune -o \( ! -type d ! -type f \) -print) || refuse
test -z "$bad" || refuse
find . -path ./models -prune -o -type f -exec sh -eu -c '
refuse() { printf "%s\n" "LOLLY_STATIC_HASH_SCAN_REFUSED"; exit 1; }
trap "rc=\$?; if [ \"\$rc\" -ne 0 ]; then printf \"%s\\n\" \"LOLLY_STATIC_HASH_SCAN_REFUSED\"; fi" 0
newline="
"
tab=$(printf "\t")
for p do
  case "$p" in *"$newline"*|*"$tab"*|*\\*) refuse ;; esac
  test -f "$p" && test ! -L "$p" || refuse
done
scan_batch() {
  before=$(stat -c "%s %a %i %Y" "$@") || refuse
  digests=$(sha256sum "$@") || refuse
  after=$(stat -c "%s %a %i %Y" "$@") || refuse
  test "$before" = "$after" || refuse
  for p do
    test -f "$p" && test ! -L "$p" || refuse
    test -n "$before" && test -n "$digests" || refuse
    row=${before%%"$newline"*}
    digest=${digests%%"$newline"*}
    case "$before" in *"$newline"*) before=${before#*"$newline"} ;; *) before= ;; esac
    case "$digests" in *"$newline"*) digests=${digests#*"$newline"} ;; *) digests= ;; esac
    printf "%s\t%s\t%s\n" "$row" "$digest" "$p"
  done
  test -z "$before" && test -z "$digests" || refuse
}
# Validated newline-only splitting preserves spaces; globbing is disabled.
IFS="$newline"
set -f
while [ "$#" -gt 0 ]; do
  batch=
  count=0
  while [ "$#" -gt 0 ] && [ "$count" -lt 64 ]; do
    batch="$batch$1$newline"
    shift
    count=$((count + 1))
  done
  scan_batch $batch
done' public-hashes {} +'''


def inventory(raw, expected):
    require(isinstance(raw, bytes) and len(raw) <= 32 * 1024**2, 'Bounded full original static inventory required')
    files, modes = {}, {}
    for line in raw.decode('utf-8').splitlines():
        match = re.fullmatch(r'(\d+) (644|755) (\d+) (\d+)\t([a-f0-9]{64})  (\./[^\t]+)\t(\./[^\t]+)', line)
        require(match is not None, 'Malformed actual static checksum or mode')
        size, mode, _, _, digest, hashed, listed = match.groups(); require(hashed == listed, 'Hashed/listed path mismatch')
        path = cohort.safe_path(listed[2:]); require('\t' not in path and not path.startswith('models/'), 'Ambiguous or model static path')
        require(path not in files, 'Duplicate actual file')
        files[path] = {'path':path, 'size':int(size), 'sha256':digest}; modes[path] = int(mode, 8)
    require(files == expected, 'Full actual static byte tree differs from independently qualified manifest')
    return {'htmlRoot':public.ROOT[1:], 'files':{p:{'mode':modes[p], 'size':files[p]['size'], 'sha256':files[p]['sha256']} for p in sorted(files)}}


class GzipSnapshotReader:
    """Bounded single-member decoding, including the gzip trailer after tar EOF."""
    def __init__(self, stream, maximum):
        self.stream, self.maximum, self.total = stream, maximum, 0
        self.pending, self.position = b'', 0
        self.chunks = self.decode()

    def decode(self):
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        while chunk := self.stream.read(1024**2):
            while True:
                try: data = decoder.decompress(chunk, min(1024**2, self.maximum - self.total + 1))
                except zlib.error as error: raise Refusal('Owner gzip checksum or stream differs') from error
                self.total += len(data)
                require(self.total <= self.maximum, 'Owner gzip expands beyond accepted archive bound')
                if data: yield data
                if decoder.eof:
                    require(not decoder.unused_data and not self.stream.read(1), 'Extra gzip member or trailing compressed bytes')
                    return
                chunk = decoder.unconsumed_tail
                if not chunk and not data: break
        require(decoder.eof, 'Owner gzip is truncated before its checksum/size trailer')

    def read(self, size):
        parts = []
        while size:
            if self.position == len(self.pending):
                self.pending, self.position = next(self.chunks, b''), 0
                if not self.pending: break
            count = min(size, len(self.pending) - self.position)
            parts.append(self.pending[self.position:self.position + count])
            self.position += count; size -= count
        return b''.join(parts)


def validate_archive(path, expected, maximum=cohort.MAX_BYTES):
    files = {}; directories = set(); seen_directories = set()
    for p in expected:
        parts = p.split('/')
        directories.update('/'.join(parts[:i]) for i in range(1, len(parts)))
    # One ordinary header per file/directory, exact padded bodies and at most
    # one tar record of zero padding. No decompressed copy consumes local disk.
    bound = sum(512 + (row['size'] + 511) // 512 * 512 for row in expected.values()) + 512 * len(directories) + 10240
    require(type(maximum) is int and maximum > 0 and Path(path).stat().st_size <= maximum, 'Compressed owner archive exceeds bound')
    with Path(path).open('rb') as compressed:
        archive = GzipSnapshotReader(compressed, min(maximum, bound))
        while True:
            header = archive.read(512)
            require(len(header) == 512, 'Owner tar is truncated before complete end blocks')
            if not any(header):
                zeros = 1
                while tail := archive.read(512):
                    require(len(tail) == 512 and not any(tail), 'Truncated tar padding or data after end-of-archive')
                    zeros += 1
                    require(zeros <= 20, 'Owner tar padding exceeds one record')
                require(zeros >= 2, 'Owner tar requires two complete zero end blocks')
                break
            try: member = tarfile.TarInfo.frombuf(header, 'utf-8', 'surrogateescape')
            except tarfile.HeaderError as error: raise Refusal('Malformed owner tar header') from error
            name = member.name.removeprefix('./').rstrip('/')
            cohort.safe_path(name)
            require(not member.pax_headers and member.uid >= 0 and member.gid >= 0, 'Unreviewed extended tar record')
            if member.isdir():
                require(name in directories and name not in seen_directories and member.size == 0, 'Unexpected archive directory')
                seen_directories.add(name); continue
            require(member.isfile() and name not in files and name in expected and member.mode in {0o644,0o755}
                    and member.size == expected[name]['size'], 'Archive link, special file, duplicate or outside path')
            digest = hashlib.sha256(); count = 0
            while count < member.size:
                data = archive.read(min(1024**2, member.size - count))
                require(data, 'Truncated owner tar body'); digest.update(data); count += len(data)
            require(count == member.size and digest.hexdigest() == expected[name]['sha256'], 'Actual owner archive bytes differ')
            padding = archive.read(-member.size % 512)
            require(len(padding) == -member.size % 512 and not any(padding), 'Truncated or nonzero owner tar body padding')
            files[name] = expected[name]
    require(files == expected, 'Archive omits accepted overlay bytes')
    return {'format':'single-member-gzip-tar', 'files':len(files), 'uncompressedBytes':archive.total, 'compressedBytes':Path(path).stat().st_size,
            'gzipIntegrityVerified':True, 'tarEndBlocksVerified':True, 'fullFileHashesVerified':True}


def catalog_bytes(index, envelope_bytes, pin, catalog, files, node):
    envelope = cohort.parse_json(envelope_bytes)
    exact(envelope, {'alg','keyId','signedAt','indexHash','files','signature'})
    require(hashlib.sha256(index).hexdigest() == catalog['indexSha256'] and hashlib.sha256(envelope_bytes).hexdigest() == catalog['envelopeSha256']
            and cohort.digest(pin) == catalog['pinCanonicalSha256'] and envelope.get('alg') == 'ECDSA-P256-SHA256'
            and envelope.get('keyId') == catalog['keyId'] and envelope.get('indexHash') == catalog['indexSha256']
            and isinstance(envelope.get('files'), dict) and len(envelope['files']) == catalog['signedFiles'], 'Fresh public catalog/pin bytes differ')
    for path, digest in envelope['files'].items():
        cohort.safe_path(path); cohort.sha(digest)
        require(path.isascii() and '/' in path and files.get('tools/' + path, {}).get('sha256') == digest, 'Actual signed tool map differs')
    require(all(p[6:] in envelope['files'] for p in files if p.startswith('tools/') and p.endswith('/tool.json')), 'Actual tool outside signed closure')
    cohort.verify_signature(pin, envelope, node)
    return catalog


def validate_public_pod(actual, desired, ready=False, dry_run=False):
    """Preserve exact container read-only mounts and managed PVC sources."""
    copied, wanted = copy.deepcopy(actual), copy.deepcopy(desired)
    require(len(copied.get('spec',{}).get('volumes',[])) == len(wanted['spec']['volumes']), 'Exact public owner volume count required')
    for volume, expected in zip(copied['spec']['volumes'],wanted['spec']['volumes']):
        if expected.get('persistentVolumeClaim',{}).get('readOnly') is True:
            require(volume.get('persistentVolumeClaim',{}).get('readOnly') is True, 'Explicit read-only public PVC changed')
            del volume['persistentVolumeClaim']['readOnly']; del expected['persistentVolumeClaim']['readOnly']
    return private.validate_pod(copied,wanted,ready,dry_run)


def validate_public_create(actual, desired, dry_run=False):
    """Check original create identity and the explicit read-only volume bit."""
    checked = validate_public_pod(actual,desired,dry_run=dry_run)
    wanted = copy.deepcopy(desired)
    for volume in wanted['spec']['volumes']:
        if volume.get('persistentVolumeClaim',{}).get('readOnly') is True:
            del volume['persistentVolumeClaim']['readOnly']
    private.validate_create(checked,wanted,dry_run)
    return actual


def make_resources(prepared, before, target, names, storage):
    exact(names, {'writer','qualifier','policy'}); exact(storage, {'storageClassName','bytes'})
    for name in names.values(): resources.name(name)
    require(len(set([*names.values(),prepared['selection']['shellClaim']])) == 4, 'Every public stage resource needs a distinct new name')
    resources.name(storage['storageClassName']); require(type(storage['bytes']) is int and storage['bytes'] > 0, 'Explicit new PVC byte size required')
    namespace = target['components']['public-web']['namespace']; label = {'lolly.tools/public-shell-stage':names['policy']}
    selected = prepared['selection']; server = before['spec']['template']['spec']['containers'][0]
    require(server['name'] == selected['container'] and server['image'] == prepared['image'] and not set(server) & {'env','envFrom','lifecycle','volumeDevices'}, 'Qualifier cannot inherit credentials or hooks')
    podspec = before['spec']['template']['spec']; config_mount = next(m for m in server['volumeMounts'] if m['mountPath'] == '/etc/nginx/conf.d/default.conf')
    config_volume = next(v for v in podspec['volumes'] if v['name'] == config_mount['name'])
    claim = {'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':{'name':selected['shellClaim'],'namespace':namespace,'labels':label},
             'spec':{'storageClassName':storage['storageClassName'],'accessModes':['ReadWriteOnce'],'volumeMode':'Filesystem','resources':{'requests':{'storage':str(storage['bytes'])}}}}
    overlay = {'name':selected['shellVolume'],'persistentVolumeClaim':{'claimName':selected['shellClaim']}}
    def pod(name, readonly):
        container = {'name':'stager','image':prepared['image'],'imagePullPolicy':'IfNotPresent',
                     'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},
                     'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'1','memory':'512Mi'}},
                     'volumeMounts':[{'name':'tmp','mountPath':'/tmp'}]}
        volumes = [copy.deepcopy(overlay),{'name':'tmp','emptyDir':{'sizeLimit':'128Mi'}}]
        if readonly:
            # Source remains managed RW for kubelet SELinux relabeling; every
            # container overlay mount is RO. The first mount covers the root.
            container['volumeMounts'] += public.overlay_mounts(selected['shellVolume'])
            container['volumeMounts'].append(copy.deepcopy(config_mount)); volumes.append(copy.deepcopy(config_volume))
            for key in ('command','args'):
                if key in server: container[key] = copy.deepcopy(server[key])
        else:
            container['command'] = ['sh','-eu','-c','trap "exit 0" TERM INT; while :; do sleep 1; done']
            container['volumeMounts'].append({'name':selected['shellVolume'],'mountPath':'/stage/overlay'})
        return {'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':namespace,'labels':label},
                'spec':{'nodeName':target['node']['name'],'restartPolicy':'Never','automountServiceAccountToken':False,'enableServiceLinks':False,
                        'securityContext':{'runAsNonRoot':True,'runAsUser':101,'runAsGroup':101,'fsGroup':101,**({'fsGroupChangePolicy':'OnRootMismatch'} if readonly else {}),'seccompProfile':{'type':'RuntimeDefault'}},
                        'containers':[container],'volumes':volumes}}
    return {'shellClaim':claim,'policy':{'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':names['policy'],'namespace':namespace,'labels':label},
                                       'spec':{'podSelector':{'matchLabels':label},'policyTypes':['Ingress','Egress']}},
            'writer':pod(names['writer'],False),'qualifier':pod(names['qualifier'],True)}


class Stage(private.Stage):
    def __init__(self, input_path, checksum_, operator_sha, kube=None):
        self.input_path = cohort.local_path(str(input_path), Path.cwd()); self.input_sha = cohort.sha(checksum_); self.operator_sha = cohort.sha(operator_sha)
        require(checksum(__file__) == self.operator_sha and checksum(self.input_path) == self.input_sha, 'Reviewed public source/input changed')
        self.inputs = cohort.Inputs(self.input_path.parent); self.value = self.inputs.file({'path':str(self.input_path),'sha256':self.input_sha})
        x = self.value; exact(x, INPUT_KEYS); require(type(x['version']) is int and x['version'] == 1, 'Unknown public stage input')
        self.target = updater.validate_target(self.inputs.file(x['target'])); require(set(self.target['components']) == updater.COMPONENTS, 'All nine protected application components required')
        self.component = self.target['components']['public-web']; self.namespace = self.component['namespace']
        self.prepared, evidence = bind_prepared(self.inputs, x['prepared'], x['planningEvidence'], x['node'])
        self.previous = self.inputs.file(evidence['previous']); self.accepted_deployment = self.inputs.file(self.previous['deployment'])
        self.producer = self.inputs.file(evidence['producer'])
        self.old, self.new, self.effective = [cohort.Tree(self.producer[k], self.inputs) for k in ('previous','overlay','shell')]
        self.old_overlay = {p:r for p,r in self.old.files.items() if public.overlay_path(p)}
        require(self.new.manifest_sha == self.prepared['overlay']['manifestSha256'] and all(self.new.files.get(p) == r for p,r in self.old_overlay.items() if p.startswith('_app/')), 'Overlay/lazy retention differs')
        self.delta = [r for p,r in self.new.files.items() if self.old_overlay.get(p) != r]
        require(self.delta and sum(r['size'] for r in self.delta) <= 32 * 1024**2, 'Bounded nonempty public delta required')
        self.public_key = self.inputs.file(x['publicKey']); require(x['publicKey']['sha256'] == self.previous['publicKeySha256'], 'Accepted public key bytes differ')
        exact(self.public_key, {'kty','crv','x','y'})
        self.baseline = self.inputs.file(x['baseline']); exact(self.baseline, {'version','deployments','claims','pvs','pods','owner','replicaSet','storageClass'})
        require(self.baseline['version'] == 1 and isinstance(self.baseline['deployments'], list), 'Complete public baseline required')
        self.baseline_deployments = {private.resource_key(d):d for d in self.baseline['deployments']}
        require(len(self.baseline_deployments) == len(self.target['components']), 'All protected Deployment specifications required')
        for component in self.target['components'].values():
            d = self.baseline_deployments.get(('Deployment',component['namespace'],component['deployment']))
            require(d and d['metadata']['uid'] == component['deploymentUID'], 'Protected Deployment identity differs')
        require(self.baseline_deployments[('Deployment',self.namespace,self.component['deployment'])]['spec'] == self.accepted_deployment['spec'], 'Accepted public baseline spec differs')
        complete_list(self.baseline['claims'], 'PersistentVolumeClaim', '*'); complete_list(self.baseline['pvs'], 'PersistentVolume')
        complete_list(self.baseline['pods'], 'Pod', self.namespace)
        require(not any(c['metadata']['name'] == self.prepared['selection']['shellClaim'] and c['metadata']['namespace'] == self.namespace for c in self.baseline['claims']['items']), 'Cannot adopt an existing overlay claim')
        self.owner, self.replica = self.baseline['owner'], self.baseline['replicaSet']
        original = self.inputs.file(self.previous['originalEvidence'][0])['runtime']
        require(self.owner['metadata']['uid'] == original['podUID'] and cohort.digest(self.owner['spec']) == original['podSpecSha256'], 'Original accepted owner spec/identity differs')
        self.owner_uid = self.owner['metadata']['uid']; self.replica_uid = self.replica['metadata']['uid']; self.owner_container = self.prepared['selection']['container']
        self.owner_chain(self.owner, self.replica, self.accepted_deployment)
        self.preflight_path, self.host_probe = self.program(x['preflight']), self.program(x['hostProbe'])
        source_files = {self.inputs.file(ref, False) for ref in x['sourceFiles']}
        require(source_files == {Path(__file__).with_name(n).resolve() for n in SOURCE_NAMES}, 'Exact imported public operator source closure required')
        require(type(x['minimumFreeBytes']) is int and x['minimumFreeBytes'] >= 8 * 1024**3 and type(x['maximumWriteBytes']) is int
                and 0 < x['maximumWriteBytes'] <= 1024**3 and sum(r['size'] for r in self.new.files.values()) <= x['maximumWriteBytes'], 'Bounded remote floor/write budget required')
        self.desired = make_resources(self.prepared, self.accepted_deployment, self.target, x['names'], x['storage'])
        require(x['storage']['bytes'] >= sum(r['size'] for r in self.new.files.values()), 'Overlay PVC does not fit')
        sc = self.baseline['storageClass']; require(sc.get('apiVersion') == 'storage.k8s.io/v1' and sc.get('kind') == 'StorageClass' and sc.get('metadata', {}).get('uid')
                and sc['metadata']['name'] == x['storage']['storageClassName'] and sc.get('volumeBindingMode','Immediate') in {'Immediate','WaitForFirstConsumer'}, 'Exact supported storage class required')
        self.out = Path(x['outputDirectory']); require(self.out.is_absolute() and self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent
                and not any(self.out == t.root or self.out in t.root.parents or t.root in self.out.parents for t in (self.old,self.new,self.effective)), 'Exclusive canonical output outside trees required')
        self.kube = kube or self; self.events = []; self.policy_retired = (self.out / 'retire.actual.json').exists(); self.inputs.unchanged()

    def identities(self):
        result = {}
        for key in ('shellClaim','shellClaimPV','policy','writer','qualifier'):
            path = self.out / ('create-' + key + '.original.json')
            if path.exists(): result[key] = updater.load_json(path)
        bound = self.out / 'claims.bound.actual.json'
        if bound.exists(): result.update(updater.load_json(bound))
        return result

    def owned(self, key):
        ids = self.identities(); expected = ids[key]; actual = self.get(expected['kind'],expected['metadata']['name'],self.namespace)
        require(actual['metadata']['uid'] == expected['metadata']['uid'] and not actual['metadata'].get('deletionTimestamp'), 'Owned temporary resource identity changed')
        if actual['kind'] == 'Pod': validate_public_pod(actual,self.desired[key],True)
        else: require(actual['spec'] == expected['spec'], 'Owned resource spec changed')
        return actual

    def admitted_pod(self, want):
        require(self.absent('Pod',want['metadata']['name']), 'Stage Pod collision; never adopt')
        self.verify_bindings(); self.preflight()
        checked = cohort.parse_json(self.remote(['create','--dry-run=server','-f','-','-o','json'],cohort.canonical(want)))
        validate_public_create(checked,want,True)
        self.save('dry-run-' + want['metadata']['name'] + '.reviewed.json',checked)
        self.verify_bindings(); self.preflight()
        return validate_public_create(cohort.parse_json(self.remote(['create','-f','-','-o','json'],cohort.canonical(want))),want)

    def run(self, command, data=None, timeout=240):
        self.active_command = list(command)
        try: return super().run(command,data,timeout)
        finally: self.active_command = None

    def save(self, name, value):
        if name.startswith('command-') and name.endswith('.json'):
            argv = getattr(self,'active_command',None)
            require(isinstance(argv,list), 'Original command argv custody missing')
            prefix = [sys.executable,'-B',str(self.host_probe),'mounts','--target',str(cohort.local_path(self.value['target']['path'],self.input_path.parent)),'--pod-uid']
            value = {**value,'argv':argv,'readOnlyMountProbe':len(argv) == 8 and argv[:7] == prefix}
        return super().save(name,value)

    def get(self, kind, name=None, namespace=None):
        args = ['get',kind,*([name] if name else []),'-o','json']
        if namespace == '*': args += ['--all-namespaces']
        elif namespace: args += ['--namespace',namespace]
        value = cohort.parse_json(self.remote(args))
        if name is None: complete_list(value, {'pods':'Pod','pvc':'PersistentVolumeClaim','pv':'PersistentVolume','deployments':'Deployment','networkpolicies':'NetworkPolicy','services':'Service'}[kind], namespace)
        return value

    @staticmethod
    def owner_chain(pod, replica, deployment):
        refs = pod['metadata'].get('ownerReferences', []); parents = replica['metadata'].get('ownerReferences', [])
        require(len(refs) == len(parents) == 1 and refs[0].get('kind') == 'ReplicaSet' and refs[0].get('controller') is True
                and refs[0].get('uid') == replica['metadata']['uid'] and refs[0].get('name') == replica['metadata']['name']
                and parents[0].get('kind') == 'Deployment' and parents[0].get('controller') is True and parents[0].get('uid') == deployment['metadata']['uid'], 'Actual public Pod/ReplicaSet/Deployment chain differs')

    def source_check(self):
        require(checksum(self.input_path) == self.input_sha and checksum(__file__) == self.operator_sha, 'Public source/input changed')
        self.inputs.unchanged()

    def fresh(self, allowed_stage_uid=None, after=False):
        self.source_check(); updater.check_cluster(self.target, self.kube)
        namespaces, deployments = {}, {}
        for ns in sorted({c['namespace'] for c in self.target['components'].values()}):
            namespaces[ns] = self.get('namespace', ns)
            for d in self.get('deployments', namespace=ns)['items']: deployments[(ns,d['metadata']['name'])] = d
        captured = private.DeploymentInventory(namespaces, deployments)
        for key, component in self.target['components'].items():
            d = updater.deployment_identity(component, captured); before = self.baseline_deployments[('Deployment',component['namespace'],component['deployment'])]
            require(d['spec'] == (self.prepared['desiredSpec'] if after and key == 'public-web' else before['spec']), 'Protected Deployment spec changed')
        claims, pvs = self.get('pvc', namespace='*'), self.get('pv'); ids = self.identities()
        actual_claims = {private.resource_key(c):c for c in claims['items']}
        expected_claims = {private.resource_key(c):c for c in self.baseline['claims']['items']}
        if 'shellClaim' in ids: expected_claims[private.resource_key(ids['shellClaim'])] = ids['shellClaim']
        require(set(actual_claims) == set(expected_claims), 'A global PVC was added or removed')
        for key, before in expected_claims.items():
            actual = actual_claims[key]; require(actual['metadata']['uid'] == before['metadata']['uid'], 'PVC replaced')
            if key == ('PersistentVolumeClaim',self.namespace,self.prepared['selection']['shellClaim']): private.validate_claim(actual,self.desired['shellClaim'])
            else: require(actual['spec'] == before['spec'], 'Protected PVC spec changed')
        actual_pvs = {private.resource_key(p):p for p in pvs['items']}
        expected_pvs = {private.resource_key(p) for p in self.baseline['pvs']['items']}
        new_claim = actual_claims.get(('PersistentVolumeClaim',self.namespace,self.prepared['selection']['shellClaim']))
        if new_claim and new_claim.get('spec',{}).get('volumeName'):
            allocated = isolated_backing(new_claim,pvs,self.namespace)
            expected_pvs.add(private.resource_key(allocated))
        require(set(actual_pvs) == expected_pvs, 'An unrelated global PV was added or removed')
        for before in self.baseline['pvs']['items']:
            actual = actual_pvs.get(private.resource_key(before)); require(actual and actual['metadata']['uid'] == before['metadata']['uid'] and actual['spec'] == before['spec'], 'Protected global PV changed')
        if 'shellClaimPV' in ids:
            pv = isolated_backing(actual_claims[private.resource_key(ids['shellClaim'])], pvs, self.namespace)
            require(pv['metadata']['uid'] == ids['shellClaimPV']['metadata']['uid'] and pv['spec'] == ids['shellClaimPV']['spec'], 'New backing rebound or changed')
        for field in ('nginxConfig','modelsClaim','modelsPV'):
            before = self.inputs.file(self.previous[field]); actual = self.get(before['kind'],before['metadata']['name'],before['metadata'].get('namespace'))
            require(actual['metadata']['uid'] == before['metadata']['uid'] and not actual['metadata'].get('deletionTimestamp')
                    and all(actual.get(k) == before.get(k) for k in ('spec','data','binaryData','immutable')), 'Accepted config/models resource changed')
        for kind, field in (('networkpolicies','policyInventory'),('services','serviceInventory')):
            expected = self.inputs.file(self.previous[field]); rows = self.get(kind,namespace=self.namespace)['items']
            observed = {r['metadata']['name']:{'uid':r['metadata']['uid'],'spec':r['spec']} for r in rows}
            if kind == 'networkpolicies' and 'policy' in ids and not self.policy_retired:
                p = ids['policy']; expected = {**expected,p['metadata']['name']:{'uid':p['metadata']['uid'],'spec':p['spec']}}
            require(observed == expected, 'Exact public policy/service inventory changed')
        sc = self.get('storageclass',self.baseline['storageClass']['metadata']['name']); before_sc = self.baseline['storageClass']
        require(sc['metadata']['uid'] == before_sc['metadata']['uid'] and not sc['metadata'].get('deletionTimestamp')
                and {k:v for k,v in sc.items() if k != 'metadata'} == {k:v for k,v in before_sc.items() if k != 'metadata'}, 'Storage class/provisioner changed')
        pods = self.get('pods',namespace=self.namespace)
        if not after:
            owner = next((p for p in pods['items'] if p['metadata']['uid'] == self.owner_uid),None)
            require(owner and owner['spec'] == self.owner['spec'], 'Accepted source owner changed')
            self.owner_chain(owner,self.get('replicaset',self.replica['metadata']['name'],self.namespace),self.accepted_deployment)
            self.healthy(owner,self.owner_container)
        old_claims = {self.previous['modelsClaim'] and self.prepared['modelsClaim']}
        if self.previous['overlay']: old_claims.add(self.previous['overlay']['claim'])
        for pod in pods['items']:
            for volume in resources.active_volumes(pod['spec']):
                claim = volume.get('persistentVolumeClaim',{}).get('claimName')
                require(claim != self.prepared['selection']['shellClaim'] or pod['metadata']['uid'] == allowed_stage_uid, 'Another Pod mounts the new overlay')
                require(after or claim not in old_claims or pod['metadata']['uid'] == self.owner_uid, 'Active models/old overlay acquired another owner')
        return pods

    def healthy(self, pod, container):
        require(pod['spec'].get('nodeName') == self.target['node']['name'] and not pod['metadata'].get('deletionTimestamp'), 'Actual public owner node differs')
        statuses = [c for c in pod.get('status',{}).get('containerStatuses',[]) if c.get('name') == container]
        require(len(statuses) == 1 and statuses[0].get('ready') is True and statuses[0].get('restartCount') == 0
                and statuses[0].get('imageID','').removeprefix('docker-pullable://') == self.prepared['image'], 'Actual public immutable image/readiness differs')
        return statuses[0]

    def preflight(self, allowed_stage_uid=None):
        self.source_check(); pods = self.fresh(allowed_stage_uid)
        capacity = cohort.parse_json(self.run([sys.executable,'-B',str(self.host_probe),'capacity','--target',str(cohort.local_path(self.value['target']['path'],self.input_path.parent))]))
        require(capacity.get('nodeUID') == self.target['node']['uid'] and capacity.get('nodeName') == self.target['node']['name']
                and type(capacity.get('freeBytes')) is int and capacity['freeBytes'] >= self.value['minimumFreeBytes'] + self.value['maximumWriteBytes'], 'Remote free-space budget refused')
        self.run([sys.executable,'-B',str(self.preflight_path)],timeout=120); return pods

    def verify_bindings(self):
        ids = self.identities(); claim = self.get('pvc',ids['shellClaim']['metadata']['name'],self.namespace)
        require(claim['metadata']['uid'] == ids['shellClaim']['metadata']['uid'], 'New claim replaced')
        pv = isolated_backing(claim,self.get('pv'),self.namespace)
        backing = resources.backing(pv)
        require(backing[0] != 'node-path' or backing[1] == self.target['node']['name'], 'New local backing belongs to another node')
        require(pv['metadata']['uid'] == ids['shellClaimPV']['metadata']['uid'] and pv['spec'] == ids['shellClaimPV']['spec'], 'New backing changed')
        return pv

    def root_metadata(self, models=False):
        """Read the whole local PV root through its reviewed host, never a Pod."""
        pv = self.inputs.file(self.previous['modelsPV']) if models else self.verify_bindings()
        original_claim = self.inputs.file(self.previous['modelsClaim']) if models else self.identities()['shellClaim']
        claim = self.get('pvc',original_claim['metadata']['name'],original_claim['metadata']['namespace'])
        require(claim['metadata']['uid'] == original_claim['metadata']['uid'], 'Root metadata claim replaced')
        resources.bound_claim(claim,{pv['metadata']['name']:pv},self.namespace)
        require('local' in pv['spec'] and resources.backing(pv) == ('node-path',self.target['node']['name'],pv['spec']['local']['path'])
                and pv['spec']['storageClassName'] == self.baseline['storageClass']['metadata']['name']
                and self.baseline['storageClass'].get('provisioner') == 'rancher.io/local-path',
                'RootMismatch handoff requires the pinned managed local plugin and local-path provisioner; CSI and hostPath refuse')
        sc = self.get('storageclass',self.baseline['storageClass']['metadata']['name'])
        require(sc['metadata']['uid'] == self.baseline['storageClass']['metadata']['uid'] and not sc['metadata'].get('deletionTimestamp')
                and {k:v for k,v in sc.items() if k != 'metadata'} == {k:v for k,v in self.baseline['storageClass'].items() if k != 'metadata'}, 'Root metadata storage class changed')
        t = self.target['transport']
        config = {'version':1,'kubectl':[*t['kubectl'],'--kubeconfig',t['kubeconfig'],'--context',t['context']],
                  'clusterUID':self.target['clusterUID'],'node':self.target['node'],'claim':claim,'pv':pv,'storageClass':sc}
        raw = self.run(root_command(self,config),timeout=240)
        value = validate_root_metadata(cohort.parse_json(raw),self.target,claim,pv)
        require(self.events, 'Original metadata command receipt missing')
        return self.save(('models' if models else 'overlay')+'-root-'+uuid.uuid4().hex+'.original.json',{'metadata':value,'originalCommand':self.events[-1]})

    def allocate_claims(self):
        ids = self.identities(); before = self.get('pvc',ids['shellClaim']['metadata']['name'],self.namespace)
        require(before['metadata']['uid'] == ids['shellClaim']['metadata']['uid'], 'Allocation claim replaced'); private.validate_claim(before,self.desired['shellClaim'])
        if before.get('status',{}).get('phase') != 'Bound' and self.baseline['storageClass'].get('volumeBindingMode') == 'WaitForFirstConsumer':
            annotations = before['metadata'].get('annotations',{}); require('volume.kubernetes.io/selected-node' not in annotations, 'Unexpected allocation owner')
            patch = [{'op':'test','path':'/metadata/uid','value':before['metadata']['uid']},{'op':'test','path':'/metadata/resourceVersion','value':before['metadata']['resourceVersion']},{'op':'test','path':'/spec','value':before['spec']}]
            if 'annotations' in before['metadata']: patch.append({'op':'test','path':'/metadata/annotations','value':annotations})
            patch.append({'op':'add','path':'/metadata/annotations','value':{**annotations,'volume.kubernetes.io/selected-node':self.target['node']['name']}})
            self.preflight()
            response = cohort.parse_json(self.remote(['patch','pvc',before['metadata']['name'],'-n',self.namespace,'--type=json','--patch',cohort.canonical(patch).decode(),'-o','json']))
            self.save('allocation.original.json',response); require(response['metadata']['uid'] == before['metadata']['uid'] and response['metadata'].get('annotations',{}).get('volume.kubernetes.io/selected-node') == self.target['node']['name'], 'Allocation response differs')
            private.validate_claim(response,self.desired['shellClaim'])
        self.remote(['wait','--for=jsonpath={.status.phase}=Bound','pvc/'+before['metadata']['name'],'-n',self.namespace,'--timeout=120s'],timeout=140)
        claim = self.get('pvc',before['metadata']['name'],self.namespace); private.validate_claim(claim,self.desired['shellClaim'])
        require(claim['metadata']['uid'] == before['metadata']['uid'], 'Allocated claim replaced')
        ids['shellClaim'] = claim; ids['shellClaimPV'] = isolated_backing(claim,self.get('pv'),self.namespace)
        self.save('claims.bound.actual.json',ids); self.verify_bindings(); self.preflight(); return ids

    def full_tree(self, pod, expected, root=public.ROOT, container='stager'):
        raw = self.remote(['exec','-n',self.namespace,pod['metadata']['name'],'-c',container,'--','sh','-eu','-c',HASH_SCRIPT,'public-static',root],timeout=600)
        value = inventory(raw,expected); ref = self.save('static-'+uuid.uuid4().hex+'.actual.json',value)
        checksum_bytes = ''.join(r['sha256']+'  '+public.ROOT+'/'+p+'\n' for p,r in value['files'].items()).encode()
        path = self.out / ('runtime-hashes-'+uuid.uuid4().hex+'.derived.txt')
        with path.open('xb') as stream: stream.write(checksum_bytes)
        path.chmod(0o600)
        return ref, {'path':str(path),'sha256':checksum(path)}

    def catalog(self, pod, container='stager'):
        data = []
        for leaf in ('index.json','index.sig.json'):
            data.append(self.remote(['exec','-n',self.namespace,pod['metadata']['name'],'-c',container,'--','cat',public.ROOT+'/catalog/tools/'+leaf]))
        catalog_bytes(*data,self.public_key,self.prepared['catalog'],self.effective.files,self.value['node'])
        return self.save('catalog-'+uuid.uuid4().hex+'.verified.json',{'catalog':self.prepared['catalog'],'verified':True,'actualIndexSha256':hashlib.sha256(data[0]).hexdigest(),'actualEnvelopeSha256':hashlib.sha256(data[1]).hexdigest(),'signedMapBoundToActualFullInventory':True})

    def snapshot(self):
        require(shutil.disk_usage(self.out).free >= 2 * 1024**3 + self.value['maximumWriteBytes'], 'Local 2 GiB floor/overlay transport budget refused')
        path = self.out / 'owning-overlay.original.tar.gz'; errors = self.out / 'owning-overlay.original.stderr'
        args = self.transport(['exec','-n',self.namespace,self.owner['metadata']['name'],'-c',self.owner_container,'--','tar','-C',public.ROOT,'-czf','-',*public.PATHS])
        started = time.monotonic()
        with path.open('xb') as stdout, errors.open('xb') as stderr:
            child = subprocess.Popen(args,stdout=stdout,stderr=stderr); failed = None
            try:
                deadline = time.monotonic() + 600
                while child.poll() is None:
                    require(time.monotonic() < deadline and path.stat().st_size <= self.value['maximumWriteBytes'] + 8 * 1024**2
                            and shutil.disk_usage(self.out).free >= 2 * 1024**3, 'Bounded owner snapshot/floor refused')
                    time.sleep(0.1)
                code = child.returncode
            except BaseException as e: failed = type(e).__name__; child.kill(); code = child.wait()
        path.chmod(0o600); errors.chmod(0o600)
        proof = self.save('snapshot.command.actual.json',{'argv':args,'encoding':'gzip','elapsedSeconds':time.monotonic()-started,'exitCode':code,'failureType':failed,'stdout':{'path':str(path),'sha256':checksum(path)},'stderr':{'path':str(errors),'sha256':checksum(errors)}})
        require(failed is None and code == 0 and path.stat().st_size <= self.value['maximumWriteBytes'] + 8 * 1024**2, 'Owner snapshot command failed or exceeded bound')
        verified = validate_archive(path,self.old_overlay,self.value['maximumWriteBytes'] + 8 * 1024**2)
        self.save('snapshot.archive-verified.actual.json',{'archive':{'path':str(path),'sha256':checksum(path)},**verified})
        return path,proof

    def create(self):
        require(not self.out.exists(), 'New exclusive stage output required'); self.out.mkdir(mode=0o700); self.save('resources.prepared.json',self.desired)
        def body():
            for key in ('shellClaim','policy'):
                want = self.desired[key]; require(self.absent(want['kind'],want['metadata']['name']), 'Stage collision; no adoption')
                self.preflight(); response = cohort.parse_json(self.remote(['create','-f','-','-o','json'],cohort.canonical(want)))
                self.save('create-'+key+'.original.json',response); private.validate_create(response,want)
            self.allocate_claims(); want = self.desired['writer']; created = self.admitted_pod(want); self.save('create-writer.original.json',created)
            self.remote(['wait','--for=condition=Ready','pod/'+want['metadata']['name'],'-n',self.namespace,'--timeout=120s'],timeout=140)
            writer = self.owned('writer'); self.preflight(writer['metadata']['uid']); return {'writerPodUID':writer['metadata']['uid'],'newClaimVerified':True}
        return self.phase('create',body)

    def copy(self):
        self.prior('create')
        def body():
            writer = self.owned('writer'); self.fresh(writer['metadata']['uid']); self.full_tree(self.owner,self.old.files,container=self.owner_container)
            archive,snapshot = self.snapshot(); self.verify_bindings(); self.owned('writer'); self.preflight(writer['metadata']['uid'])
            self.remote(['exec','-i','-n',self.namespace,writer['metadata']['name'],'-c','stager','--','tar','-C','/stage/overlay','-xzf','-'],archive.read_bytes(),timeout=600)
            self.full_tree(writer,self.old_overlay,'/stage/overlay')
            delta = self.out / 'overlay-delta.tar'
            with tarfile.open(delta,'x',format=tarfile.USTAR_FORMAT) as tar:
                for row in self.delta:
                    info = tarfile.TarInfo(row['path']); info.size = row['size']; info.mode = 0o644; info.uid = info.gid = 101; info.mtime = 0
                    with (self.new.root/row['path']).open('rb') as stream: tar.addfile(info,stream)
            require(delta.stat().st_size <= 34 * 1024**2, 'Delta transport exceeds bound')
            self.verify_bindings(); self.owned('writer'); self.preflight(writer['metadata']['uid'])
            self.remote(['exec','-i','-n',self.namespace,writer['metadata']['name'],'-c','stager','--','tar','-C','/stage/overlay','-xf','-'],delta.read_bytes(),timeout=600)
            full,_ = self.full_tree(writer,self.new.files,'/stage/overlay'); self.full_tree(self.owner,self.old.files,container=self.owner_container)
            return {'pod':writer,'overlayManifestSha256':self.new.manifest_sha,'fullOverlayHashesVerified':True,'snapshot':snapshot,'static':full,'activePVCMountedInStaging':False}
        return self.phase('copy',body)

    def retire_writer(self):
        copied = self.prior('copy')
        def body():
            writer = self.owned('writer'); self.verify_bindings(); self.preflight(writer['metadata']['uid'])
            self.remote(['delete','--raw','/api/v1/namespaces/'+self.namespace+'/pods/'+writer['metadata']['name'],'-f','-'],cohort.canonical(private.delete_options(writer)))
            self.wait_absent('pod',writer['metadata']['name']); mount = self.mount_release(writer['metadata']['uid']); self.fresh()
            return {'pod':copied['pod'],'podAbsent':True,'mountsReleased':True,'mountProof':mount,'fullOverlayHashesVerified':copied['fullOverlayHashesVerified']}
        return self.phase('retire-writer',body)

    def create_qualifier(self):
        retired = self.prior('retire-writer')
        def body():
            require(self.absent('pod',retired['pod']['metadata']['name']), 'Writer reappeared'); self.mount_release(retired['pod']['metadata']['uid'])
            # A mismatched root would trigger kubelet's recursive mode changes.
            # Observe after writer retirement and before either admission/create.
            root = self.root_metadata()
            created = self.admitted_pod(self.desired['qualifier']); self.save('create-qualifier.original.json',created)
            self.remote(['wait','--for=condition=Ready','pod/'+created['metadata']['name'],'-n',self.namespace,'--timeout=120s'],timeout=140)
            pod = self.owned('qualifier'); self.preflight(pod['metadata']['uid']); return {'pod':pod,'rootMetadata':root}
        return self.phase('create-qualifier',body)

    def qualify(self):
        created = self.prior('create-qualifier')
        def body():
            pod = self.owned('qualifier'); self.fresh(pod['metadata']['uid']); self.verify_bindings()
            static,hashes = self.full_tree(pod,self.effective.files); catalog = self.catalog(pod)
            identity = self.remote(['exec','-n',self.namespace,pod['metadata']['name'],'-c','stager','--','sh','-eu','-c','id -u; id -g'])
            require(identity == b'101\n101\n', 'Actual isolated Nginx UID/GID differs')
            # Only local loopback reaches the isolated Nginx process. No Service,
            # ingress, provider, model, production Secret or account is present.
            expected = self.effective.files['index.html']; data = self.remote(['exec','-n',self.namespace,pod['metadata']['name'],'-c','stager','--','wget','-q','-O','-','http://127.0.0.1:8080/index.html'])
            require(len(data) == expected['size'] and hashlib.sha256(data).hexdigest() == expected['sha256'], 'Actual isolated Nginx HTTP body differs')
            self.fresh(pod['metadata']['uid']); self.verify_bindings()
            root = self.root_metadata(); ids = self.identities()
            same_root(root_proof(created['rootMetadata'],self,ids['shellClaim'],ids['shellClaimPV']),root_proof(root,self,ids['shellClaim'],ids['shellClaimPV']))
            return {'runtimeStatus':'ISOLATED_PUBLIC_SHELL_RUNTIME_VERIFIED','pod':pod,'image':self.prepared['image'],'sources':self.prepared['sources'],
                    'static':static,'hashes':hashes,'catalog':catalog,'staticManifestSha256':self.producer['shell']['manifest']['sha256'],
                    'overlayManifestSha256':self.new.manifest_sha,'fullStaticHashesVerified':True,'publicCatalogSignatureVerified':True,'nginxLoopbackIndexVerified':True,'modelsMounted':False,
                    'rootMetadata':{'before':created['rootMetadata'],'after':root},'originalCommands':self.events}
        return self.phase('qualify',body)

    def retire(self):
        qualified = self.prior('qualify'); retired_writer = self.prior('retire-writer')
        def body():
            pod = self.owned('qualifier'); ids = self.identities(); self.verify_bindings(); self.preflight(pod['metadata']['uid'])
            self.remote(['delete','--raw','/api/v1/namespaces/'+self.namespace+'/pods/'+pod['metadata']['name'],'-f','-'],cohort.canonical(private.delete_options(pod)))
            self.wait_absent('pod',pod['metadata']['name']); qualifier_mount = self.mount_release(pod['metadata']['uid'])
            require(self.absent('pod',retired_writer['pod']['metadata']['name']), 'Writer reappeared'); writer_mount = self.mount_release(retired_writer['pod']['metadata']['uid'])
            policy = self.get('networkpolicy',ids['policy']['metadata']['name'],self.namespace)
            require(policy['metadata']['uid'] == ids['policy']['metadata']['uid'] and policy['spec'] == ids['policy']['spec'], 'Stage policy replaced')
            self.verify_bindings(); self.preflight()
            self.remote(['delete','--raw','/apis/networking.k8s.io/v1/namespaces/'+self.namespace+'/networkpolicies/'+policy['metadata']['name'],'-f','-'],cohort.canonical(private.delete_options(policy)))
            self.wait_absent('networkpolicy',policy['metadata']['name']); self.policy_retired = True; self.fresh(); pv = self.verify_bindings()
            proof = {'version':1,'status':'ISOLATED_PUBLIC_SHELL_ACCEPTED_AND_RETIRED','preparedSha256':self.value['prepared']['sha256'],'image':self.prepared['image'],'sources':self.prepared['sources'],
                     'overlayManifestSha256':self.new.manifest_sha,'staticManifestSha256':self.producer['shell']['manifest']['sha256'],'claim':self.get('pvc',ids['shellClaim']['metadata']['name'],self.namespace),'pv':pv,
                     'writer':retired_writer['pod'],'qualifier':qualified['pod'],'policy':policy,'writerMountProof':writer_mount,'qualifierMountProof':qualifier_mount,
                     'writerAbsent':True,'qualifierAbsent':True,'policyAbsent':True,'mountsReleased':True,'runtime':qualified,'stageInput':{'path':str(self.input_path),'sha256':self.input_sha}}
            return {'stage':self.save('stage.accepted-and-retired.actual.json',proof),'claimRetained':True,'productionDeploymentMutated':False}
        return self.phase('retire',body)

    def execute(self, action):
        if action == 'check': return {'status':'PUBLIC_STAGE_INPUTS_BOUND_NOT_EXECUTED','desired':self.desired,'productionMutation':False}
        return super().execute(action)


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['check','run','create','copy','retire-writer','create-qualifier','qualify','retire'])
    parser.add_argument('--inputs',required=True); parser.add_argument('--sha256',required=True); parser.add_argument('--operator-sha256',required=True)
    args = parser.parse_args(); print(json.dumps(Stage(args.inputs,args.sha256,args.operator_sha256).execute(args.action),sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Refusal,private.Refusal,updater.Refusal,resources.Refusal,OSError,ValueError,KeyError,TypeError,StopIteration,subprocess.SubprocessError):
        print('REFUSED: public staging custody, storage, target or execution differs; preserve originals and never replay',file=sys.stderr); raise SystemExit(1)
