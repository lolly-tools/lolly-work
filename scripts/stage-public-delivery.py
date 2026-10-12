#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Guarded complete-root frontend staging; active models never enter staging.

check is local-only. Other commands are exclusive reviewed phases; failures
retain originals and cannot replay. The final target preflight precedes each
resource allocation, write or deletion. Nothing selects a serving Deployment.
"""
from __future__ import annotations
import argparse
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


l = module('delivery_lifecycle', 'public-delivery-lifecycle.py')
legacy = module('delivery_maintained_stage', 'stage-public-shell.py')
native = module('delivery_native', 'public-delivery-native.py')
private, cohort, updater, r = legacy.private, legacy.cohort, legacy.updater, legacy.resources
need, exact, raw = l.need, l.exact, l.raw
SOURCE_NAMES = {*legacy.SOURCE_NAMES, 'plan-private-cohort.py', 'public-delivery-lifecycle.py', 'assemble-public-delivery.py',
    'public-delivery-overlay.py', 'public-delivery-map.mjs', 'stage-public-delivery.py', 'publish-public-delivery.py',
    'public-delivery-native.py', 'public-delivery-http.py', 'public-delivery-model-http.py',
    'public-delivery-static-http.py', 'public-delivery-decoded-http.py'}


def same(actual, before):
    need(actual.get('apiVersion') == before['apiVersion'] and actual.get('kind') == before['kind']
         and all(actual.get('metadata', {}).get(k) == before['metadata'].get(k) for k in ['name', 'namespace', 'uid'])
         and not actual['metadata'].get('deletionTimestamp')
         and {k: v for k, v in actual.items() if k not in {'metadata', 'status'}} == {k: v for k, v in before.items() if k not in {'metadata', 'status'}}, 'Resource UID/full payload differs')


def collection(value, kind, namespace=None):
    return legacy.complete_list(value, kind, namespace)['items']


def node_path(path):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and '\x00' not in path
        and not any(part in {'.', '..'} for part in path.split('/')), 'Canonical absolute host backing required')
    return str(PurePosixPath(path))


def node_overlap(left, right):
    a, b = node_path(left), node_path(right)
    return a == '/' or b == '/' or a == b or a.startswith(b + '/') or b.startswith(a + '/')


PV_IDENTITIES = r'''import hashlib,json,os,pathlib,re,stat,sys
def mounts(text):
 if not 0<len(text.encode())<=4*1024**2:raise RuntimeError('BOUNDED_COMPLETE_MOUNTINFO_REQUIRED')
 rows=[]
 def path(value):
  value=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),value)
  p=pathlib.PurePosixPath(value)
  if not value.startswith('/') or value.startswith('//') or str(p)!=value or '..'in p.parts or '\x00'in value:raise RuntimeError('CANONICAL_KERNEL_MOUNT_PATH_REQUIRED')
  return value
 for line in text.splitlines():
  fields=line.split();separator=fields.index('-')
  if separator<6 or len(fields)<separator+4 or not re.fullmatch(r'[0-9]+:[0-9]+',fields[2]):raise RuntimeError('COMPLETE_MOUNTINFO_ROW_REQUIRED')
  rows.append({'id':fields[0],'device':fields[2],'root':path(fields[3]),'mountpoint':path(fields[4])})
 return rows
def mapping(path,device,rows):
 choices=[row for row in rows if row['mountpoint']=='/' or path==row['mountpoint']or path.startswith(row['mountpoint']+'/')]
 if not choices:raise RuntimeError('PV_MOUNT_MAPPING_ABSENT')
 size=max(len(row['mountpoint'])for row in choices);choices=[row for row in choices if len(row['mountpoint'])==size]
 if len(choices)!=1 or choices[0]['device']!=str(os.major(device))+':'+str(os.minor(device)):raise RuntimeError('AMBIGUOUS_PHYSICAL_PV_MOUNT_MAPPING')
 row=choices[0];suffix=path[len(row['mountpoint']):]if row['mountpoint']!='/'else path
 return {'device':row['device'],'root':row['root'],'mountpoint':row['mountpoint'],'effectivePath':str(pathlib.PurePosixPath(row['root'])/suffix.lstrip('/'))}
def identity(p):
 s=p.lstat()
 if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):raise RuntimeError('NONLINK_DIRECTORY_REQUIRED')
 return {'path':str(p),'device':s.st_dev,'deviceMajorMinor':str(os.major(s.st_dev))+':'+str(os.minor(s.st_dev)),'inode':s.st_ino,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid}
def observe(roots,mount_reader):
 before_text=mount_reader();mounted=mounts(before_text);rows=[];seen=set()
 for row in roots:
  if set(row)!={'pvUID','path'} or row['pvUID']in seen:raise RuntimeError('UNIQUE_PV_IDENTITY_REQUIRED')
  seen.add(row['pvUID']);p=pathlib.Path(row['path'])
  if not p.is_absolute() or str(p)!=row['path'] or p.resolve(strict=True)!=p:raise RuntimeError('CANONICAL_PHYSICAL_PV_PATH_REQUIRED')
  paths=[*reversed(p.parents),p];before=[identity(q)for q in paths]
  if p.resolve(strict=True)!=p or before!=[identity(q)for q in paths]:raise RuntimeError('PV_DIRECTORY_IDENTITY_CHANGED')
  rows.append({'pvUID':row['pvUID'],'path':str(p),'ancestors':before[:-1],'root':before[-1],'mapping':mapping(str(p),before[-1]['device'],mounted)})
 after_text=mount_reader();after=mounts(after_text)
 for row in rows:
  if mapping(row['path'],row['root']['device'],after)!=row['mapping']:raise RuntimeError('PV_MOUNT_MAPPING_CHANGED')
 return {'version':1,'roots':rows,'mountinfo':{'beforeSha256':hashlib.sha256(before_text.encode()).hexdigest(),'afterSha256':hashlib.sha256(after_text.encode()).hexdigest()},'readOnly':True,'productionMutation':False}
if __name__=='__main__':
 x=json.load(sys.stdin)
 if set(x)!={'version','roots'} or x['version']!=1 or not 0<len(x['roots'])<=4096:raise RuntimeError('BOUNDED_ACTUAL_PV_ROOTS_REQUIRED')
 print(json.dumps(observe(x['roots'],lambda:pathlib.Path('/proc/self/mountinfo').read_text()),separators=(',',':')))
'''


def distinct_pv_identities(value, wanted, selected):
    exact(value, {'version', 'roots', 'mountinfo', 'readOnly', 'productionMutation'})
    need(value['version'] == 1 and value['readOnly'] is True and value['productionMutation'] is False
        and type(value['roots']) is list and len(value['roots']) == len(wanted), 'Complete physical PV identity pass required')
    exact(value['mountinfo'], {'beforeSha256', 'afterSha256'})
    need(all(l.sha(value['mountinfo'][key]) for key in value['mountinfo']), 'Actual kernel mountinfo snapshots required')
    rows = {}
    for row in value['roots']:
        exact(row, {'pvUID', 'path', 'ancestors', 'root', 'mapping'})
        need(row['pvUID'] not in rows and wanted.get(row['pvUID']) == row['path'], 'PV identity differs from actual complete inventory')
        paths = [*reversed(Path(row['path']).parents), Path(row['path'])]
        need(type(row['ancestors']) is list and len(row['ancestors']) + 1 == len(paths), 'Complete PV ancestry required')
        for path, actual in zip(paths, [*row['ancestors'], row['root']]):
            exact(actual, {'path', 'device', 'deviceMajorMinor', 'inode', 'mode', 'uid', 'gid'})
            need(actual['path'] == str(path) and all(type(actual[k]) is int and actual[k] >= 0 for k in ['device', 'inode', 'mode', 'uid', 'gid'])
                and actual['inode'] > 0 and actual['mode'] & 0o170000 == 0o040000
                and type(actual['deviceMajorMinor']) is str and re.fullmatch(r'[0-9]+:[0-9]+', actual['deviceMajorMinor']), 'Actual nonlink directory ancestry differs')
        mapped = row['mapping']; exact(mapped, {'device', 'root', 'mountpoint', 'effectivePath'})
        # dev_t encoding is platform-specific. Retain the host-native kernel
        # device pair rather than decoding Linux st_dev on the operator's OS.
        need(mapped['device'] == row['root']['deviceMajorMinor']
            and node_path(mapped['root']) == mapped['root'] and node_path(mapped['mountpoint']) == mapped['mountpoint']
            and node_path(mapped['effectivePath']) == mapped['effectivePath'], 'Canonical actual filesystem mapping required')
        mountpoint = mapped['mountpoint']; path = row['path']
        need(mountpoint == '/' or path == mountpoint or path.startswith(mountpoint + '/'), 'Physical mount does not contain PV path')
        suffix = path[len(mountpoint):] if mountpoint != '/' else path
        need(str(PurePosixPath(mapped['root']) / suffix.lstrip('/')) == mapped['effectivePath'], 'Underlying filesystem-relative PV path differs')
        rows[row['pvUID']] = row
    identity = lambda row: (row['device'], row['inode'])
    need(set(selected) <= set(rows), 'Selected PV physical identity absent')
    for uid in selected:
        root = rows[uid]; root_id = identity(root['root']); ancestors = {identity(row) for row in root['ancestors']}
        for other_uid, other in rows.items():
            if other_uid == uid: continue
            other_id = identity(other['root'])
            need(root_id != other_id and root_id not in {identity(row) for row in other['ancestors']} and other_id not in ancestors,
                'Selected PV has an equal or ancestor physical backing alias')
            need(root['mapping']['device'] != other['mapping']['device'] or not node_overlap(root['mapping']['effectivePath'], other['mapping']['effectivePath']),
                'Selected PV has a bind-mounted underlying filesystem alias')
    return value


def consumers(pods, pairs, node, allowed):
    """Check global consumers including direct backing aliases, not names alone."""
    for pod in collection(pods, 'Pod', '*'):
        for volume in pod['spec'].get('volumes', []):
            for pair in pairs:
                claim, pv = pair['claim'], pair['pv']; backing = r.backing(pv)
                match = volume.get('persistentVolumeClaim', {}).get('claimName') == claim['metadata']['name'] and pod['metadata'].get('namespace') == claim['metadata']['namespace']
                if volume.get('hostPath') and backing[0] == 'node-path':
                    path = node_path(volume['hostPath']['path']); scheduled = pod['spec'].get('nodeName')
                    if scheduled in {None, node}:
                        need(not node_overlap(backing[2], path), 'Direct hostPath contains or aliases selected backing')
                        # Disjoint path text does not disprove a symlink or bind
                        # alias. This protocol has no foreign path identity proof.
                        need(False, 'Unresolved direct hostPath physical alias requires separately reviewed identity proof')
                if volume.get('nfs') and backing[0] == 'nfs':
                    nfs = volume['nfs']; match |= r.overlaps(backing, ('nfs', nfs['server'], nfs['path']))
                need(not set(volume) & {'csi', 'persistentVolumeClaimTemplate'}, 'Unreviewed inline storage cannot bypass global backing guards')
                if match: need(pod['metadata']['uid'] in allowed.get(claim['metadata']['uid'], set()), 'Foreign global Pod consumes selected storage or a direct backing alias')


class Stage:
    transport = private.Stage.transport

    def __init__(self, path, input_sha, operator_sha):
        self.path = Path(path); self.input_sha = input_sha; self.operator_sha = operator_sha
        need(l.a.checksum(self.path) == input_sha and l.a.checksum(Path(__file__)) == operator_sha, 'Exact reviewed runtime input/source required')
        self.value = l.held({'path': str(self.path), 'sha256': input_sha})
        exact(self.value, {'version', 'status', 'prepared', 'target', 'context', 'programs', 'sources', 'outputDirectory'})
        need(self.value['version'] == 1 and self.value['status'] == 'REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED', 'Closed runtime adapter input required')
        self.prepared = l.held(self.value['prepared'])
        need(self.prepared == l.prepare(l.held(self.prepared['preparationInput']), self.prepared['preparationInput']), 'Independently rebuilt preparation differs')
        self.before = l.held(self.prepared['refs']['deployment']); self.baseline = l.held(self.prepared['refs']['baseline'])
        self.target = updater.validate_target(l.held(self.value['target'])); self.component = self.target['components']['public-web']
        need(self.component['namespace'] == self.before['metadata']['namespace'] and self.component['deployment'] == self.before['metadata']['name']
             and self.component['deploymentUID'] == self.before['metadata']['uid'], 'Selected current target differs')
        self.namespace = self.component['namespace']; self.image = self.before['spec']['template']['spec']['containers'][0]['image']
        self.container = self.before['spec']['template']['spec']['containers'][0]['name']
        self.context = l.held(self.value['context']); exact(self.context, {'version', 'owner', 'replicaSet', 'storageClass', 'namespaces', 'sourceRoots', 'configPaths', 'origin'})
        need(self.context['version'] == 1, 'Closed owning context required')
        self.owner, self.replica = self.context['owner'], self.context['replicaSet']; legacy.Stage.owner_chain(self.owner, self.replica, self.before)
        accepted = l.held(self.prepared['refs']['acceptedRelease'])
        need(self.owner['metadata']['uid'] == accepted['ownerPodUID'] and self.owner in self.baseline['pods']['items'], 'Exact accepted owning Pod required')
        self.original_owner = self.owner
        exact(self.value['programs'], {'preflight', 'hostProbe', 'node', 'signatureVerifier'})
        expected = {str(Path(__file__).with_name(name).resolve()) for name in SOURCE_NAMES}
        paths = {ref['path'] for ref in self.value['sources']}; need(len(paths) == len(self.value['sources']) and expected <= paths, 'Complete maintained imported source closure required')
        for ref in self.value['sources']: l.a.read_ref(ref)
        adapter = l.held(self.prepared['refs']['adapterReview'])
        need(adapter['source'] == {'path': str(Path(__file__).resolve()), 'sha256': operator_sha}
             and adapter['sources'] == self.value['sources'], 'Runtime executes exactly the independently reviewed adapter source closure')
        for key, ref in self.value['programs'].items():
            p = Path(ref['path']); need(p.is_absolute() and p.resolve(strict=True) == p and l.a.checksum(p) == ref['sha256'], 'Exact registered execution program required')
            if key != 'node': need(ref in self.value['sources'], 'All nonbinary execution programs must be in source closure')
        sc = self.context['storageClass']; need(sc['kind'] == 'StorageClass' and sc['metadata']['name'] == self.prepared['resources']['claim']['spec']['storageClassName']
            and sc.get('provisioner') == 'rancher.io/local-path' and sc.get('volumeBindingMode') in {'Immediate', 'WaitForFirstConsumer'}, 'Managed local-path handoff only; CSI needs its own qualified adapter')
        namespace_names = {d['metadata']['namespace'] for d in self.baseline['deployments']}
        need({n['metadata']['name'] for n in self.context['namespaces']} == namespace_names, 'Every protected namespace must have actual UID custody')
        for component in self.target['components'].values():
            namespace = next(n for n in self.context['namespaces'] if n['metadata']['name'] == component['namespace'])
            deployment = next(d for d in self.baseline['deployments'] if d['metadata']['namespace'] == component['namespace'] and d['metadata']['name'] == component['deployment'])
            need(namespace['metadata']['uid'] == component['namespaceUID'] and deployment['metadata']['uid'] == component['deploymentUID']
                 and all(deployment['metadata'].get('labels', {}).get(k) == v for k, v in component.get('requiredLabels', {}).items()), 'Declared target component scope differs from complete baseline')
        self.resources = self.prepared['resources']; self.names = {k: self.resources[k]['metadata']['name'] for k in self.resources}
        self.report = l.held(self.prepared['refs']['assembly']); self.root = Path(self.report['root'])
        self.manifest = l.held(self.prepared['manifest']); self.rows = self.manifest['files']; self.models = l.held(self.prepared['refs']['models'])['files']
        self.model_pair = self.source_pair('models'); self.root_pair = self.source_pair(l.VOLUME)
        need({v['claim']['metadata']['uid'] for v in self.context['sourceRoots']} >= {self.model_pair['claim']['metadata']['uid'], self.root_pair['claim']['metadata']['uid']}, 'Active site/model root metadata required')
        for pair in self.context['sourceRoots']:
            need(pair['claim'] in self.baseline['pvcs']['items'] and pair['pv'] in self.baseline['pvs']['items'], 'Source root outside complete storage baseline')
            legacy.validate_root_metadata(pair['metadata'], self.target, pair['claim'], pair['pv'])
        from urllib.parse import urlsplit
        origin = urlsplit(self.context['origin']); need(origin.scheme == 'https' and origin.hostname and not origin.username and not origin.password
            and not origin.query and not origin.fragment and origin.path in {'', '/'}, 'Credential-free normal TLS origin required')
        configs = l.held(self.prepared['refs']['configs']); need(set(self.context['configPaths']) == set(configs[0]['data']), 'Every mounted native configuration leaf needs an exact path')
        mounts = self.before['spec']['template']['spec']['containers'][0]['volumeMounts']
        for key, mount_path in self.context['configPaths'].items():
            need(any(m.get('name') == 'nginx' and m.get('subPath') == key and m.get('mountPath') == mount_path and m.get('readOnly') is True for m in mounts), 'Configuration path differs from selected RO mount')
        self.out = Path(self.value['outputDirectory']); need(self.out.is_absolute() and self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent
             and self.out != self.root and self.root not in self.out.parents and self.out not in self.root.parents, 'Distinct canonical output outside physical assembly required')
        self.events = []; self.policy_retired = (self.out / 'retire.accepted.json').exists()
        self.local_signature, self.local_map = self.verify_local()

    def source_pair(self, name):
        selected = next(v for v in self.before['spec']['template']['spec']['volumes'] if v['name'] == name)['persistentVolumeClaim']['claimName']
        claim = next(v for v in self.baseline['pvcs']['items'] if v['metadata']['namespace'] == self.namespace and v['metadata']['name'] == selected)
        pv = r.bound_claim(claim, {p['metadata']['name']: p for p in self.baseline['pvs']['items']}, self.namespace)
        return {'claim': claim, 'pv': pv}

    def verify_local(self):
        l.a.physical(self.root, self.manifest, epoch=True)
        node = self.value['programs']['node']['path']; verifier = self.value['programs']['signatureVerifier']['path']
        pin = l.held(self.prepared['refs']['acceptedRelease'])['publicPin']
        env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin'}
        actual = subprocess.run([node, verifier, '--root', str(self.root), '--public-key', pin['path']], capture_output=True, timeout=300, env=env)
        need(actual.returncode == 0 and len(actual.stdout) <= 1024**2 and len(actual.stderr) <= 65536, 'Actual full P256 release verifier refused')
        signature = l.a.parsed(actual.stdout); need(signature.get('verified') is True and signature.get('files', 0) > 0 and signature.get('tools', 0) > 0, 'Genuine complete signed file closure required')
        program = "import{pathToFileURL}from'node:url';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const x=JSON.parse(readFileSync(0));const m=await import(pathToFileURL(x.module));const n=await m.verifyCodings(x.root,x.files);const map=m.compileMap(x.files,x.models);process.stdout.write(JSON.stringify({decodedCodings:n,mapSha256:createHash('sha256').update(map).digest('hex')}));"
        value = {'module': str(Path(__file__).with_name('public-delivery-map.mjs').resolve()), 'root': str(self.root), 'files': self.rows, 'models': self.models}
        result = subprocess.run([node, '--input-type=module', '-e', program], input=raw(value), capture_output=True, timeout=300, env=env)
        need(result.returncode == 0 and len(result.stdout) <= 65 * 1024**2 and len(result.stderr) <= 65536, 'Complete physical coding/map verification refused')
        mapped = l.a.parsed(result.stdout)
        need(mapped['mapSha256'] == self.prepared['mapSha256']
             and mapped['decodedCodings'] == len(l.a.overlay.coding_pairs(l.a.overlay.manifest(self.manifest))), 'Actual semantic map/decoded coding closure differs')
        return signature, {'decodedCodings': mapped['decodedCodings'], 'mapSha256': self.prepared['mapSha256']}

    def unchanged(self):
        need(l.a.checksum(self.path) == self.input_sha and l.a.checksum(Path(__file__)) == self.operator_sha, 'Reviewed runtime input/source changed')
        for ref in self.value['sources']: l.a.read_ref(ref)
        for ref in self.value['programs'].values(): need(l.a.checksum(Path(ref['path'])) == ref['sha256'], 'Execution program changed')
        for key in ['prepared', 'target', 'context']: l.held(self.value[key])
        l.a.verify_candidate_build(self.report['candidateBuild'], physical_bytes=False)
        l.a.physical(self.root, self.manifest, epoch=True)

    def save(self, name, value):
        # Only HTTP receipts use the explicit capture/parse/file envelope.
        data = module('delivery_http_receipt', 'public-delivery-http.py').report_bytes(value) if name in {'native-http.original.json', 'models-http.original.json'} else raw(value) + b'\n'
        return l.a.write_new(self.out / name, data)
    def load(self, name): return l.a.parsed((self.out / name).read_bytes())

    def run(self, argv, data=None, timeout=240):
        tag = 'command-' + uuid.uuid4().hex; start = time.monotonic(); failure = None
        try:
            actual = subprocess.run(argv, input=data, capture_output=True, timeout=timeout); stdout, stderr, code = actual.stdout, actual.stderr, actual.returncode
        except subprocess.TimeoutExpired as error:
            stdout, stderr, code = error.stdout or b'', error.stderr or b'', None; failure = 'TIMEOUT_NO_REPLAY'
        streams = {}; complete = len(stdout) <= 64 * 1024**2 and len(stderr) <= 65536
        for name, data in [('stdout', stdout), ('stderr', stderr)]:
            retained = data[:64 * 1024**2 if name == 'stdout' else 65536]; encoded = gzip.compress(retained, mtime=0) if len(retained) > 1024**2 else retained
            suffix = '.gz' if len(retained) > 1024**2 else ''
            streams[name] = l.a.write_new(self.out / (tag + '.' + name + '.original' + suffix), encoded)
        receipt = self.save(tag + '.actual.json', {'argv': argv, 'exitCode': code, 'failure': failure, 'complete': complete,
            'elapsedSeconds': time.monotonic() - start, **streams,
            'decoded': {k: {'size': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in [('stdout', stdout), ('stderr', stderr)]}})
        self.events.append(receipt); need(code == 0 and failure is None and complete, 'Actual command failed or exceeded bound; never replay'); return stdout

    def remote(self, args, data=None, timeout=240): return self.run(self.transport(args), data, timeout)
    def get(self, kind, name=None, namespace=None):
        args = ['get', kind, *([name] if name else []), '-o', 'json']
        if namespace == '*': args += ['--all-namespaces']
        elif namespace: args += ['-n', namespace]
        return cohort.parse_json(self.remote(args))
    def absent(self, kind, name): return not self.remote(['get', kind, name, '-n', self.namespace, '--ignore-not-found', '-o', 'json']).strip()
    def held(self): return {key: self.load('create-' + key + '.original.json') for key in self.resources if (self.out / ('create-' + key + '.original.json')).exists()}

    def pair(self):
        old = self.held()['claim']; claim = self.get('pvc', old['metadata']['name'], self.namespace)
        need(claim['metadata']['uid'] == old['metadata']['uid'], 'Created claim replaced'); private.validate_claim(claim, self.resources['claim'])
        pv = legacy.isolated_backing(claim, self.get('pv'), self.namespace); need(r.backing(pv)[0:2] == ('node-path', self.target['node']['name']), 'New local backing belongs to another node')
        result = {'claim': claim, 'pv': pv}
        if (self.out / 'bound.original.json').exists():
            before = self.load('bound.original.json'); same(claim, before['claim']); same(pv, before['pv'])
        return result

    def root_metadata(self, pair):
        t = self.target['transport']; config = {'version': 1, 'kubectl': [*t['kubectl'], '--kubeconfig', t['kubeconfig'], '--context', t['context']],
            'clusterUID': self.target['clusterUID'], 'node': self.target['node'], **pair, 'storageClass': self.context['storageClass']}
        value = cohort.parse_json(self.run(legacy.root_command(self, config)))
        return legacy.validate_root_metadata(value, self.target, pair['claim'], pair['pv'])

    def validate_pod(self, actual, key, ready=False, dry=False):
        wanted = copy.deepcopy(self.resources[key]); value = copy.deepcopy(actual)
        need(value['metadata'].get('labels') == wanted['metadata']['labels'] and not value['metadata'].get('ownerReferences'), 'Admission changed temporary exposure labels/ownership')
        if value['spec'].get('nodeName'):
            need(value['spec']['nodeName'] == self.target['node']['name'], 'Scheduled native Pod belongs to another node')
            value['spec'].pop('nodeName')
        elif ready: need(False, 'Ready native Pod needs actual selected node')
        legacy.validate_public_pod(value, wanted, ready, dry)
        return actual

    def owned(self, key):
        original = self.held()[key]; actual = self.get('pod', original['metadata']['name'], self.namespace)
        need(actual['metadata']['uid'] == original['metadata']['uid'], 'Temporary Pod replaced'); return self.validate_pod(actual, key, True)

    def fresh(self, allowed=None, after=None):
        self.unchanged(); updater.check_cluster(self.target, self)
        deployments = []
        for original in self.context['namespaces']:
            observed_namespace = self.get('namespace', original['metadata']['name']); same(observed_namespace, original)
            need(observed_namespace['metadata'].get('labels', {}) == original['metadata'].get('labels', {}), 'Protected namespace admission/exposure labels changed')
            deployments += collection(self.get('deployments', namespace=original['metadata']['name']), 'Deployment', original['metadata']['name'])
        before = {(d['metadata']['namespace'], d['metadata']['name']): d for d in self.baseline['deployments']}
        actual = {(d['metadata']['namespace'], d['metadata']['name']): d for d in deployments}; need(set(actual) == set(before), 'Complete protected Deployment set changed')
        selected_key = (self.namespace, self.before['metadata']['name'])
        wanted = copy.deepcopy(self.baseline['deployments'])
        if after is not None:
            row = next(d for d in wanted if (d['metadata']['namespace'], d['metadata']['name']) == selected_key); row['spec'] = after
            if 'generation' in row['metadata']: row['metadata']['generation'] += 1
            annotations = row['metadata'].get('annotations', {})
            if 'deployment.kubernetes.io/revision' in annotations:
                need(annotations['deployment.kubernetes.io/revision'].isdigit(), 'Numeric controller revision required')
                annotations['deployment.kubernetes.io/revision'] = str(int(annotations['deployment.kubernetes.io/revision']) + 1)
        l.same_deployments(deployments, wanted)
        pvcs = collection(self.get('pvc', namespace='*'), 'PersistentVolumeClaim', '*'); pvs = collection(self.get('pv'), 'PersistentVolume')
        old_claims = {private.resource_key(v): v for v in self.baseline['pvcs']['items']}; old_pvs = {private.resource_key(v): v for v in self.baseline['pvs']['items']}
        held = self.held(); new_pair = None
        if 'claim' in held:
            created = next(v for v in pvcs if v['metadata']['uid'] == held['claim']['metadata']['uid']); old_claims[private.resource_key(created)] = created
            if created.get('status', {}).get('phase') == 'Bound': new_pair = self.pair(); old_pvs[private.resource_key(new_pair['pv'])] = new_pair['pv']
        need({private.resource_key(v) for v in pvcs} == set(old_claims) and {private.resource_key(v) for v in pvs} == set(old_pvs), 'Global PVC/PV set changed')
        for rows, old in [(pvcs, old_claims), (pvs, old_pvs)]:
            for value in rows: same(value, old[private.resource_key(value)])
        pods = self.get('pods', namespace='*'); collection(pods, 'Pod', '*')
        current = self.owner if after is None else self.public_owner(deployments, pods, after)
        owner = next(v for v in pods['items'] if v['metadata']['uid'] == current['metadata']['uid'])
        need(owner['spec'] == current['spec'], 'Current owner full spec changed')
        self.validate_public_owner(owner, self.get('replicaset', self.replica['metadata']['name'], self.namespace), actual[selected_key],
            self.before['spec'] if after is None else after)
        statuses = owner['status']['containerStatuses']; need(len(statuses) == 1 and statuses[0]['ready'] is True and statuses[0]['restartCount'] == 0
             and statuses[0]['imageID'].removeprefix('docker-pullable://') == self.image, 'Current native exact image not Ready/zero-restart')
        all_pairs = [{'claim': v['claim'], 'pv': v['pv']} for v in self.context['sourceRoots']]
        allowances = {v['claim']['metadata']['uid']: {owner['metadata']['uid']} if v['claim']['metadata']['uid'] in {self.root_pair['claim']['metadata']['uid'], self.model_pair['claim']['metadata']['uid']} and after is None else set() for v in all_pairs}
        if after is not None: allowances[self.model_pair['claim']['metadata']['uid']] = {owner['metadata']['uid']}
        if new_pair: all_pairs.append(new_pair); allowances[new_pair['claim']['metadata']['uid']] = {allowed} if allowed else {owner['metadata']['uid']} if after is not None else set()
        consumers(pods, all_pairs, self.target['node']['name'], allowances)
        for key in ['writer', 'qualifier']:
            matches = [p for p in pods['items'] if p['metadata'].get('namespace') == self.namespace and p['metadata']['name'] == self.names[key]]
            need(not matches or len(matches) == 1 and matches[0]['metadata']['uid'] == allowed, 'Temporary name acquired another owner')
        for original in l.held(self.prepared['refs']['configs']): same(self.get('configmap', original['metadata']['name'], self.namespace), original)
        same(self.get('storageclass', self.context['storageClass']['metadata']['name']), self.context['storageClass'])
        exposure = {}
        for key, kind, plural in [('services', 'Service', 'services'), ('policies', 'NetworkPolicy', 'networkpolicies')]:
            values = collection(self.get(plural, namespace=self.namespace), kind, self.namespace)
            wanted = {v['metadata']['name']: v for v in self.baseline[key]['items'] if v['metadata']['namespace'] == self.namespace}
            if key == 'policies' and 'policy' in held and not self.policy_retired: wanted[self.names['policy']] = held['policy']
            need({v['metadata']['name'] for v in values} == set(wanted), 'Service/policy exposure set changed')
            for value in values: same(value, wanted[value['metadata']['name']])
            exposure[key] = {'items': values}
        l.exposure(exposure, self.resources['writer']['metadata']['labels'], self.namespace)
        for selected in all_pairs:
            for pv in pvs: need(pv['metadata']['uid'] == selected['pv']['metadata']['uid'] or not r.overlaps(r.backing(pv), r.backing(selected['pv'])), 'Selected backing aliases another active/rollback PV')
        self.physical_backings(pvs, [pair['pv']['metadata']['uid'] for pair in all_pairs])
        for original in self.context['sourceRoots']:
            observed = self.root_metadata({'claim': original['claim'], 'pv': original['pv']}); expected = copy.deepcopy(original['metadata'])
            if after is not None and original['claim']['metadata']['uid'] == self.model_pair['claim']['metadata']['uid']:
                self.owner_model_label(observed, expected, owner)
            need(observed == expected, 'Active/rollback source filesystem identity/DAC/MCS changed')
        return {'version': 1, 'deployments': deployments, 'globalStorageAndPodsVerified': True, 'sourceRootIdentityDACMCSUnchanged': True}

    def physical_backings(self, pvs, selected):
        roots = {}
        for pv in pvs:
            backing = r.backing(pv)
            need(backing[:2] == ('node-path', self.target['node']['name']), 'Unresolved foreign PV backing needs a separately qualified identity adapter')
            roots[pv['metadata']['uid']] = node_path(backing[2])
        value = {'version': 1, 'roots': [{'pvUID': uid, 'path': path} for uid, path in sorted(roots.items())]}
        need(len(raw(value)) <= 1024**2, 'Bounded complete host metadata request required')
        return distinct_pv_identities(cohort.parse_json(self.host_python(PV_IDENTITIES, raw(value))), roots, selected)

    def owner_model_label(self, observed, expected, owner):
        old, actual = expected['root']['selinuxLabel'], observed['root']['selinuxLabel']
        if actual != old:
            need(old is not None and actual is not None and actual.split(':', 3)[:3] == old.split(':', 3)[:3], 'Model filesystem label type/identity changed')
            current = self.remote(['exec', '-n', self.namespace, owner['metadata']['name'], '-c', self.container, '--', 'cat', '/proc/1/attr/current']).decode().strip()
            need(len(current) <= 256 and len(current.split(':', 3)) == 4 and current.split(':', 3)[3] == actual.split(':', 3)[3], 'New model MCS label does not belong to the verified native owner')
            expected['root']['selinuxLabel'] = actual

    def public_owner(self, deployments, pods, desired):
        deployment = next(d for d in deployments if d['metadata']['namespace'] == self.namespace and d['metadata']['name'] == self.before['metadata']['name'])
        matches = []
        for pod in pods['items']:
            if pod['metadata'].get('namespace') != self.namespace: continue
            references = [v for v in pod['metadata'].get('ownerReferences', []) if v.get('controller') is True and v.get('kind') == 'ReplicaSet']
            if len(references) != 1: continue
            replica = self.get('replicaset', references[0]['name'], self.namespace)
            if any(v.get('uid') == deployment['metadata']['uid'] for v in replica['metadata'].get('ownerReferences', [])):
                legacy.Stage.owner_chain(pod, replica, deployment); matches.append((pod, replica))
        need(len(matches) == 1 and deployment['spec'] == desired, 'One exact new native owner required')
        self.owner, self.replica = matches[0]
        self.validate_public_owner(self.owner, self.replica, deployment, desired)
        return self.owner

    def validate_public_owner(self, pod, replica, deployment, desired):
        """Fence the complete reviewed template; only ordinary API defaults vary."""
        legacy.Stage.owner_chain(pod, replica, deployment)
        copied = copy.deepcopy(pod); placement = copied['spec'].get('nodeName')
        need(placement == self.target['node']['name'], 'Native owner is not on the reviewed scheduling node')
        if 'nodeName' not in desired['template']['spec']: copied['spec'].pop('nodeName')
        metadata = desired['template']['metadata']; labels = copy.deepcopy(metadata.get('labels', {}))
        controller_hash = replica.get('metadata', {}).get('labels', {}).get('pod-template-hash')
        need(type(controller_hash) is str and re.fullmatch('[a-z0-9]{1,63}', controller_hash), 'Actual ReplicaSet template hash required')
        labels['pod-template-hash'] = controller_hash
        need(copied['metadata'].get('labels') == labels
            and copied['metadata'].get('annotations', {}) == metadata.get('annotations', {}),
            'Owning template labels or reviewed annotations changed')
        wanted = {'apiVersion': 'v1', 'kind': 'Pod',
            'metadata': {'name': pod['metadata']['name'], 'namespace': self.namespace, 'labels': labels},
            'spec': copy.deepcopy(desired['template']['spec'])}
        legacy.validate_public_pod(copied, wanted, ready=True)
        return pod

    def preflight(self, allowed=None):
        self.fresh(allowed)
        self.image_available()
        capacity = cohort.parse_json(self.run([sys.executable, '-B', self.value['programs']['hostProbe']['path'], 'capacity', '--target', self.value['target']['path']]))
        need(capacity['nodeUID'] == self.target['node']['uid'] and capacity['nodeName'] == self.target['node']['name']
             and capacity['freeBytes'] >= self.prepared['minimumFreeBytes'] + self.prepared['maximumWriteBytes'], 'Actual host reserve/write capacity refused')
        # This is the last operation before every caller's target mutation.
        self.run([sys.executable, '-B', self.value['programs']['preflight']['path']], timeout=180)

    def image_available(self):
        code = 'import json,subprocess,sys;x=json.load(sys.stdin);p=subprocess.run(["/usr/local/bin/k3s","crictl","--runtime-endpoint","unix:///run/k3s/containerd/containerd.sock","inspecti",x],capture_output=True,timeout=30);\nif p.returncode or len(p.stdout)>1048576 or len(p.stderr)>65536:raise RuntimeError("EXACT_NATIVE_IMAGE_ABSENT")\nv=json.loads(p.stdout)["status"];\nif x not in v.get("repoDigests",[]):raise RuntimeError("EXACT_NATIVE_IMAGE_IDENTITY_REFUSED")\nprint(json.dumps({"image":x,"id":v.get("id"),"repoDigests":v["repoDigests"]}))'
        value = cohort.parse_json(self.host_python(code, raw(self.image))); need(value['image'] == self.image and self.image in value['repoDigests'], 'Native imported image no longer available'); return value

    def phase(self, name, fn):
        self.unchanged(); start = len(self.events)
        self.save(name + '.started.json', {'status': 'STARTED_NO_REPLAY', 'inputSha256': self.input_sha, 'operatorSha256': self.operator_sha})
        try:
            details = fn(); result = {'version': 1, 'phase': name, 'status': 'ACTUAL_PHASE_ACCEPTED', 'prepared': self.value['prepared'],
                'source': {'path': str(Path(__file__).resolve()), 'sha256': self.operator_sha}, 'commands': self.events[start:]}
            need(result['commands'], 'Original phase command custody required')
            self.save(name + '.details.actual.json', details)
            return self.save(name + '.accepted.json', result)
        except BaseException as error:
            self.save(name + '.uncertain.json', {'status': 'REFUSED_NO_REPLAY', 'failureType': type(error).__name__, 'inputSha256': self.input_sha}); raise

    def prior(self, name):
        result = self.load(name + '.accepted.json'); need(result['prepared'] == self.value['prepared'] and result['source']['sha256'] == self.operator_sha, 'Prior phase belongs to different runtime source/input')
        return self.load(name + '.details.actual.json')

    def create(self):
        need(not self.out.exists(), 'Started output cannot replay'); self.out.mkdir(mode=0o700)
        def fn():
            self.save('global-before.actual.json', self.fresh())
            for key in ['policy', 'claim']:
                want = self.resources[key]; need(self.absent(want['kind'], want['metadata']['name']), 'Resource already exists; no adoption')
                self.preflight(); response = cohort.parse_json(self.remote(['create', '-f', '-', '-o', 'json'], raw(want)))
                private.validate_create(response, want); self.save('create-' + key + '.original.json', response)
            claim = self.get('pvc', self.names['claim'], self.namespace)
            if claim.get('status', {}).get('phase') != 'Bound' and self.context['storageClass']['volumeBindingMode'] == 'WaitForFirstConsumer':
                annotations = claim['metadata'].get('annotations', {}); need('volume.kubernetes.io/selected-node' not in annotations, 'Allocation owner already exists')
                patch = [{'op': 'test', 'path': '/metadata/uid', 'value': claim['metadata']['uid']}, {'op': 'test', 'path': '/metadata/resourceVersion', 'value': claim['metadata']['resourceVersion']}, {'op': 'test', 'path': '/spec', 'value': claim['spec']}]
                if 'annotations' in claim['metadata']: patch.append({'op': 'test', 'path': '/metadata/annotations', 'value': annotations})
                patch.append({'op': 'add', 'path': '/metadata/annotations', 'value': {**annotations, 'volume.kubernetes.io/selected-node': self.target['node']['name']}})
                self.preflight(); response = cohort.parse_json(self.remote(['patch', 'pvc', self.names['claim'], '-n', self.namespace, '--type=json', '--patch-file=/dev/stdin', '-o', 'json'], raw(patch)))
                need(response['metadata']['uid'] == claim['metadata']['uid'], 'Allocation replaced claim'); self.save('allocation.original.json', response)
            self.remote(['wait', '--for=jsonpath={.status.phase}=Bound', 'pvc/' + self.names['claim'], '-n', self.namespace, '--timeout=120s'], timeout=140)
            pair = self.pair(); self.save('bound.original.json', pair); self.empty_root(pair)
            self.create_pod('writer'); return {'status': 'NEW_ROOT_WRITER_CREATED_NOT_QUALIFIED', 'modelsMounted': False}
        return self.phase('create', fn)

    def empty_root(self, pair):
        need(pair['pv']['spec'].get('local'), 'Pinned managed local backing required')
        code = 'import pathlib,os,stat,json;p=pathlib.Path(' + repr(pair['pv']['spec']['local']['path']) + ');s=p.lstat();ok=stat.S_ISDIR(s.st_mode) and not p.is_symlink() and str(p.resolve())==str(p) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o777 and not list(p.iterdir());\nif not ok:raise RuntimeError("NEW_EMPTY_ROOT_REQUIRED")\nprint(json.dumps({"empty":True}))'
        value = cohort.parse_json(self.host_python(code)); need(value == {'empty': True}, 'New empty root required')

    def host_python(self, code, data=None, timeout=240):
        args = ['python3', '-c', code]; t = self.target['transport']
        if t['type'] == 'ssh':
            if t.get('sudo'): args = ['sudo', '-n', *args]
            args = [*self.transport([])[:-1], shlex.join(args)]
        return self.run(args, data, timeout)

    def create_pod(self, key):
        want = self.resources[key]; need(self.absent('pod', self.names[key]), 'Temporary Pod preexists')
        self.preflight(); checked = cohort.parse_json(self.remote(['create', '--dry-run=server', '-f', '-', '-o', 'json'], raw(want)))
        self.validate_pod(checked, key, dry=True); self.save('dryrun-' + key + '.original.json', checked)
        self.preflight(); response = cohort.parse_json(self.remote(['create', '-f', '-', '-o', 'json'], raw(want)))
        self.validate_pod(response, key); self.save('create-' + key + '.original.json', response)
        self.remote(['wait', '--for=condition=Ready', 'pod/' + self.names[key], '-n', self.namespace, '--timeout=180s'], timeout=200)
        self.owned(key); self.fresh(response['metadata']['uid']); return response

    def copy(self):
        self.prior('create')
        def fn():
            writer = self.owned('writer'); uid = writer['metadata']['uid']; self.verify_local()
            command = self.transport(['exec', '-i', '-n', self.namespace, self.names['writer'], '-c', 'writer', '--', '/bin/sh', '-c', 'set -eu; test "$(id -u)" = 101; test ! -e /run/lolly-public-overlay/site; mkdir /run/lolly-public-overlay/site; tar -C /run/lolly-public-overlay/site -xzkf -; find /run/lolly-public-overlay/site -type d -exec chmod 755 {} +'])
            self.preflight(uid); self.stream_upload(command)
            self.verify_local(); proof = self.physical('writer'); self.save('physical-writer.actual.json', proof)
            self.save('root-after-writer.original.json', self.root_metadata(self.pair())); self.fresh(uid)
            return {'modelsMounted': False, 'completePhysicalHashesVerified': True}
        return self.phase('copy', fn)

    def stream_upload(self, argv):
        # Stream transport bytes directly; never allocate a second complete TAR.
        start = time.monotonic(); failure = None; size = 0; wire = hashlib.sha256(); code = None
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=output, stderr=errors)
            watchdog = threading.Timer(1200, child.kill); watchdog.daemon = True; watchdog.start()
            class Sink:
                def write(_self, block):
                    nonlocal size
                    size += len(block); need(size <= self.manifest['totalBytes'] + len(self.rows) * 4096 + 1024**2 and time.monotonic() - start <= 1200, 'Bounded complete gzip upload required')
                    wire.update(block); need(child.stdin.write(block) == len(block), 'Upload short write'); return len(block)
            try:
                with tarfile.open(fileobj=Sink(), mode='w|gz') as tar:
                    for row in self.rows:
                        path = self.root / row['path']; before = l.a.fingerprint(path); info = tar.gettarinfo(str(path), arcname=row['path'])
                        need(info.isfile() and not info.issym() and not info.islnk(), 'Independent regular upload members required')
                        info.uid = info.gid = 101; info.uname = info.gname = ''; info.mode = 0o644; info.mtime = 0
                        with path.open('rb') as stream: tar.addfile(info, stream)
                        need(l.a.fingerprint(path) == before, 'Upload source changed while streaming')
                child.stdin.close(); code = child.wait(timeout=30)
            except BaseException as error:
                failure = type(error).__name__
                if child.poll() is None: child.kill()
                code = child.wait()
            finally:
                watchdog.cancel()
                if not child.stdin.closed:
                    try: child.stdin.close()
                    except OSError as error:
                        if failure is None: failure = type(error).__name__
            output.seek(0); errors.seek(0); out, err = output.read(65537), errors.read(65537)
        stdout = l.a.write_new(self.out / 'upload.stdout.original', out[:65536]); stderr = l.a.write_new(self.out / 'upload.stderr.original', err[:65536])
        ref = self.save('upload.command.actual.json', {'argv': argv, 'exitCode': code, 'failure': failure, 'complete': len(out) <= 65536 and len(err) <= 65536,
            'elapsedSeconds': time.monotonic() - start, 'wireBytes': size, 'wireSha256': wire.hexdigest(), 'localTarCreated': False, 'activeRootMounted': False, 'stdout': stdout, 'stderr': stderr})
        self.events.append(ref); need(code == 0 and failure is None and not out and len(err) <= 65536, 'Actual upload failed or exceeded bound; never replay')

    def physical(self, key, models=False, owner=False):
        pod = self.owner if owner else self.owned(key); container = self.container if owner or key == 'qualifier' else 'writer'
        root = '/usr/share/nginx/html/models' if models else '/usr/share/nginx/html' if owner or key == 'qualifier' else '/run/lolly-public-overlay/site'
        value = self.remote(['exec', '-i', '-n', self.namespace, pod['metadata']['name'], '-c', container, '--', '/bin/sh', '-s'], native.physical_program(root, not models and (owner or key == 'qualifier')), timeout=1200)
        return native.physical(value, self.models if models else self.rows, models)

    def mount_release(self, uid):
        deadline = time.monotonic() + 240
        while True:
            result = cohort.parse_json(self.run([sys.executable, '-B', self.value['programs']['hostProbe']['path'], 'mounts', '--target', self.value['target']['path'], '--pod-uid', uid]))
            if result.get('podUid') == uid and result.get('nodeUID') == self.target['node']['uid'] and result.get('unmounted') is True and result.get('mountsReleased') is True: return result
            need(time.monotonic() < deadline, 'Original UID mount/CRI release did not complete'); time.sleep(2)

    def delete_pod(self, key):
        pod = self.owned(key); self.preflight(pod['metadata']['uid'])
        self.remote(['delete', '--raw', '/api/v1/namespaces/' + self.namespace + '/pods/' + self.names[key], '-f', '-'], raw(private.delete_options(pod)))
        deadline = time.monotonic() + 240
        while not self.absent('pod', self.names[key]): need(time.monotonic() < deadline, 'Original Pod deletion uncertain'); time.sleep(1)
        release = self.mount_release(pod['metadata']['uid']); return pod, release

    def retire_writer(self):
        self.prior('copy')
        def fn():
            self.physical('writer'); pod, release = self.delete_pod('writer'); self.fresh()
            return {'podUID': pod['metadata']['uid'], 'podAbsent': True, 'mountsReleased': True, 'release': release}
        return self.phase('retire-writer', fn)

    def create_qualifier(self):
        previous = self.prior('retire-writer')
        def fn():
            need(self.absent('pod', self.names['writer']), 'Retired writer returned'); self.mount_release(previous['podUID'])
            before = self.load('root-after-writer.original.json'); self.create_pod('qualifier'); after = self.root_metadata(self.pair())
            for value in [before, after]: value['root'].pop('selinuxLabel', None)
            need(before == after, 'Whole-volume handoff changed filesystem/DAC identity')
            self.save('startup-memory.actual.json', self.measure()); return {'modelsMounted': False}
        return self.phase('create-qualifier', fn)

    def measure(self, owner=False):
        pod = self.owner if owner else self.owned('qualifier'); configured = self.resources['qualifier']['spec']['containers'][0]['resources']['limits']['memory']
        match = re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)', configured); need(match, 'Explicit native memory limit required')
        value = self.remote(['exec', '-i', '-n', self.namespace, pod['metadata']['name'], '-c', self.container, '--', '/bin/sh', '-s'], native.MEMORY.encode())
        return native.memory(value, int(match[1]) * (1024**2 if match[2] == 'Mi' else 1024**3), pod['metadata']['uid'])

    def qualify(self):
        self.prior('create-qualifier')
        def fn():
            pod = self.owned('qualifier'); uid = pod['metadata']['uid']; self.fresh(uid); self.verify_local()
            before = self.physical('qualifier'); model_before = self.model_owner(); model_physical_before = self.physical('qualifier', models=True, owner=True)
            configs = l.held(self.prepared['refs']['configs'])[0]['data']
            for key, path in self.context['configPaths'].items():
                value = self.remote(['exec', '-n', self.namespace, self.names['qualifier'], '-c', self.container, '--', 'sha256sum', path])
                need(value.decode().split()[0] == hashlib.sha256(configs[key].encode()).hexdigest(), 'Mounted native configuration bytes differ')
            self.remote(['exec', '-n', self.namespace, self.names['qualifier'], '-c', self.container, '--', 'nginx', '-t'])
            http = self.native_http(pod); self.save('native-http.original.json', http)
            need(before == self.physical('qualifier'), 'Native physical bytes changed during HTTP')
            model_after = self.model_owner(); need(model_before == model_after, 'Active model owner/backing changed during stage')
            need(self.physical('qualifier', models=True, owner=True) == model_physical_before, 'Active model inode/link membership changed during native HTTP')
            model_http = module('delivery_http', 'public-delivery-http.py').verify_models_tls(self.context['origin'], self.models)
            self.save('models-http.original.json', model_http)
            need(self.model_owner() == model_before and self.physical('qualifier', models=True, owner=True) == model_physical_before,
                'Active model owner/inode/link membership changed during normal TLS')
            self.fresh(uid)
            physical = self.save('physical.actual.json', {'version': 1, 'manifest': self.prepared['manifest'], 'epoch': 0, 'hardLinkedFiles': 0, 'allHashesVerified': True, 'allCodingsDecoded': True, 'mapRecompiled': True})
            http_ref = self.save('http.actual.json', {'version': 1, 'mapSha256': self.prepared['mapSha256'], **dict.fromkeys(['external8080', 'identityStrongEtag', 'gzipStrongEtag', 'conditional304', 'ifRange206', 'crossCodingMiss', 'privateErrors', 'serviceWorkerNoStore'], True)})
            pin = l.held(self.prepared['refs']['acceptedRelease'])['publicPin']
            signature = self.save('signature.actual.json', {'version': 1, 'manifest': self.prepared['manifest'], 'publicPin': pin, 'sourceSignatureVerified': True, 'fullSignedFileClosureVerified': True})
            memory = self.save('memory.actual.json', self.measure())
            before_ref = self.save('model-owner-before.actual.json', model_before); after_ref = self.save('model-owner-after.actual.json', model_after)
            model_http_ref = self.save('model-http.actual.json', {'version': 1, 'recipe': self.prepared['refs']['models'], **dict.fromkeys(['normalTLS', 'allModels', 'strongValidators', 'rangeAndIfRange', 'strict416', 'strictCors', 'privateErrors'], True)})
            self.save('models.actual.json', {'version': 1, 'recipe': self.prepared['refs']['models'], 'modelsMounted': False, 'before': before_ref, 'after': after_ref, 'http': model_http_ref})
            self.save('native.actual.json', {'version': 1, 'source': self.prepared['source'], 'image': self.image, 'resourcesSha256': self.prepared['resourcesSha256'], 'manifest': self.prepared['manifest'],
                'mapSha256': self.prepared['mapSha256'], 'modelsMounted': False, 'physical': physical, 'http': http_ref, 'memory': memory, 'signature': signature})
            return {'podUID': uid, 'modelsMounted': False, 'actualNativeVerified': True}
        return self.phase('qualify', fn)

    def model_owner(self):
        self.physical('qualifier', models=True, owner=True)
        return {'version': 1, 'ownerUID': self.owner['metadata']['uid'], 'ownerSpecSha256': l.digest(self.owner['spec']),
            'claimUID': self.model_pair['claim']['metadata']['uid'], 'pvUID': self.model_pair['pv']['metadata']['uid'],
            'recipe': self.prepared['refs']['models'], 'allPhysicalHashesVerified': True}

    def native_http(self, pod):
        current = pod['status']['containerStatuses'][0]['containerID']; need(re.fullmatch('containerd://[a-f0-9]{64}', current), 'Actual container identity required')
        helper = module('delivery_http', 'public-delivery-http.py'); payload = helper.payload(self.rows, self.report['retained'])
        source = {name: Path(__file__).with_name(name).read_text() for name in ['public-delivery-http.py', 'public-delivery-model-http.py', 'public-delivery-static-http.py', 'public-delivery-decoded-http.py']}
        code = helper.NAMESPACE_HTTP
        result = cohort.parse_json(self.host_python(code, raw({'container': current[13:], 'payload': payload, 'sources': source}), timeout=2500))
        helper.report_bytes(result)
        return result

    def retire(self):
        self.prior('qualify')
        def fn():
            pod, release = self.delete_pod('qualifier'); need(self.absent('pod', self.names['writer']), 'Retired writer returned')
            self.mount_release(self.prior('retire-writer')['podUID']); self.fresh()
            policy = self.get('networkpolicy', self.names['policy'], self.namespace); same(policy, self.held()['policy'])
            self.preflight(); self.remote(['delete', '--raw', '/apis/networking.k8s.io/v1/namespaces/' + self.namespace + '/networkpolicies/' + self.names['policy'], '-f', '-'], raw(private.delete_options(policy)))
            need(self.absent('networkpolicy', self.names['policy']), 'Policy deletion uncertain'); self.policy_retired = True
            after = self.save('global-after.actual.json', self.fresh())
            retirement = self.save('retirement.actual.json', {'version': 1, 'podUID': pod['metadata']['uid'], 'resourcesSha256': self.prepared['resourcesSha256'],
                **dict.fromkeys(['policyAbsent', 'podAbsent', 'writerAbsent', 'globalClaimConsumersAbsent', 'mountsReleased', 'createdClaimRetained'], True)})
            return {'podUID': pod['metadata']['uid'], 'retirement': retirement, 'globalAfter': after, 'release': release}
        accepted = self.phase('retire', fn)
        detail = self.prior('retire')
        ref = lambda name: {'path': str(self.out / name), 'sha256': l.a.checksum(self.out / name)}
        receipt = {'version': 1, 'status': 'ACTUAL_FRONTEND_ROOT_QUALIFIED_AND_RETIRED', 'prepared': self.value['prepared'],
            'adapter': {'path': str(Path(__file__).resolve()), 'sha256': self.operator_sha}, 'phases': [ref(name + '.accepted.json') for name in l.STAGES],
            'native': ref('native.actual.json'), 'models': ref('models.actual.json'), 'retirement': detail['retirement'], 'globalBefore': ref('global-before.actual.json'), 'globalAfter': detail['globalAfter']}
        l.admit(self.prepared, receipt); return self.save('runtime.qualified-and-retired.actual.json', receipt)

    def inspect(self, output):
        """Repeatable GET-only observation into a new journal, never adoption."""
        directory = Path(output); need(directory.is_absolute() and directory.resolve() == directory and directory.parent.resolve(strict=True) == directory.parent
            and not directory.exists() and directory != self.out and self.out not in directory.parents and directory not in self.out.parents
            and directory != self.root and self.root not in directory.parents and directory not in self.root.parents,
            'Fresh separate read-only observation output required')
        directory.mkdir(mode=0o700); old_run, old_save = self.run, self.save
        self.save = lambda name, value: l.a.write_new(directory / name, raw(value) + b'\n')
        def run(argv, data=None, timeout=240):
            original = self.out; self.out = directory
            try: return old_run(argv, data, timeout)
            finally: self.out = original
        self.run = run
        try:
            found = []
            for key in ['writer', 'qualifier']:
                if self.absent('pod', self.names[key]): continue
                original = self.held().get(key); need(original, 'A temporary name without genuine creation custody cannot be adopted')
                actual = self.get('pod', self.names[key], self.namespace); need(actual['metadata']['uid'] == original['metadata']['uid'], 'Observed temporary Pod replaced')
                self.validate_pod(actual, key); found.append(actual)
            need(len(found) <= 1, 'Writer and qualifier cannot own the new claim concurrently')
            self.fresh(found[0]['metadata']['uid'] if found else None)
            return self.save('inspect.actual.json', {'version': 1, 'status': 'ACTUAL_READ_ONLY_STAGE_OBSERVATION_NOT_QUALIFICATION',
                'pods': found, 'originalStageInput': {'path': str(self.path), 'sha256': self.input_sha}, 'phaseAdopted': False, 'productionMutation': False})
        finally: self.run, self.save = old_run, old_save


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action', choices=['check', 'run', 'inspect', *l.STAGES])
    parser.add_argument('--observation-directory')
    parser.add_argument('--input', required=True); parser.add_argument('--reviewed-input-sha256', required=True); parser.add_argument('--reviewed-operator-sha256', required=True)
    args = parser.parse_args(); op = Stage(args.input, args.reviewed_input_sha256, args.reviewed_operator_sha256)
    if args.action == 'check': result = {'status': 'RUNTIME_SOURCE_INPUT_BOUND_NOT_EXECUTED', 'resources': op.resources, 'modelsMounted': False}
    elif args.action == 'inspect': need(args.observation_directory, 'A distinct read-only observation directory is required'); result = op.inspect(args.observation_directory)
    elif args.action == 'run':
        need(not op.out.exists(), 'run starts one fresh lifecycle; existing attempts never replay')
        for phase in l.STAGES: result = getattr(op, phase.replace('-', '_'))()
    else: result = getattr(op, args.action.replace('-', '_'))()
    print(raw(result).decode())


if __name__ == '__main__':
    try: main()
    except Exception as error: print('Public delivery runtime refused: ' + str(error), file=sys.stderr); raise SystemExit(1)
