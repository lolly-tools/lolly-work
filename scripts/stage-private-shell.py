#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Stage a compatible shell using two NEW PVCs and an unchanged accepted image.

One reviewed input drives exclusive phases. No Deployment, Secret, database,
provider or DNS mutation is implemented. After any uncertain command, reconcile
read-only; never replay that phase. Temporary pack storage stays retained until
planning/publication has consumed its original bound-PV capture.

Every guard pass captures new complete Deployment collections per namespace,
PVC collections per protected namespace and a global PV collection. Original
response bytes stay in command receipts; no inventory survives into another
guard pass or replaces the final production-target check before a mutation.
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
import shlex
import subprocess
import sys
import tempfile
import tarfile
import time
import uuid
sys.dont_write_bytecode = True


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


updater = module('shell_stage_updater', 'app-update.py')
shell = module('shell_stage_preparer', 'prepare-private-shell.py')
resources = module('shell_stage_resources', 'plan-private-cohort.py')
cohort = shell.cohort
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
INPUT_KEYS = {'version', 'target', 'prepared', 'previous', 'baseline', 'previousShell', 'shell', 'rawPack', 'publicKey', 'sourceMap', 'preflight', 'hostProbe',
              'programs', 'names', 'storage', 'minimumFreeBytes', 'maximumWriteBytes', 'ownerSealSha256', 'outputDirectory', 'sourceFiles'}


def sha(path):
    return hashlib.sha256(cohort.read_file(Path(path), 64 * 1024**2)[0]).hexdigest()


def resource_key(value):
    meta = value['metadata']; return value['kind'], meta.get('namespace', ''), meta['name']


def complete_list(value, item_kind, namespace=None):
    """Accept actual kubectl generic collections without inventing typed output."""
    item_api = {'Pod':'v1','PersistentVolumeClaim':'v1','PersistentVolume':'v1','Deployment':'apps/v1'}.get(item_kind)
    require(item_api is not None, 'Unknown stage collection item kind')
    require(isinstance(value,dict) and set(value) == {'apiVersion','kind','metadata','items'}
            and ((value['kind'] == 'List' and value['apiVersion'] == 'v1') or (value['kind'] == item_kind + 'List' and value['apiVersion'] == item_api))
            and isinstance(value['metadata'],dict) and not value['metadata'].get('continue')
            and type(value['metadata'].get('remainingItemCount',0)) is int and value['metadata'].get('remainingItemCount',0) == 0
            and isinstance(value['items'],list) and len(value['items']) <= 100000, 'Complete known Kubernetes collection required')
    names, uids = set(), set()
    for item in value['items']:
        require(isinstance(item,dict) and item.get('apiVersion') == item_api and item.get('kind') == item_kind and isinstance(item.get('metadata'),dict), 'Collection item API or kind differs')
        meta = item['metadata']; name, uid = meta.get('name'), meta.get('uid')
        resources.name(name); resources.text(uid,'collection UID'); resources.text(meta.get('resourceVersion'),'collection item resource version')
        require(meta.get('namespace') == namespace and name not in names and uid not in uids, 'Collection item scope or identity differs')
        names.add(name); uids.add(uid)
    return value


class DeploymentInventory:
    """One guard pass only: reuse the existing identity checks on original items."""
    def __init__(self, namespaces, deployments):
        self.namespaces, self.deployments = namespaces, deployments

    def get(self, kind, name, namespace=None):
        if kind == 'namespace' and namespace is None:
            require(name in self.namespaces, 'Protected namespace missing from fresh captures')
            return self.namespaces[name]
        require(kind == 'deployment' and (namespace,name) in self.deployments, 'Protected Deployment missing from fresh captures')
        return self.deployments[(namespace,name)]


def phase_guard(directory, name, input_sha, operator_sha):
    """Create intent before any API mutation; an existing intent forbids replay."""
    require(name in {'create', 'copy', 'retire-writer', 'create-qualifier', 'qualify', 'retire'}, 'Unknown stage phase')
    path = directory / (name + '.started.json')
    updater.write_json(path, {'version': 1, 'status': 'STARTED_NO_RETRY', 'inputSha256': input_sha, 'operatorSha256': operator_sha})
    return path


def delete_options(value):
    meta = value.get('metadata', {})
    require(meta.get('uid') and meta.get('resourceVersion') and not meta.get('deletionTimestamp'), 'Fresh owned UID/RV delete guards required')
    return {'apiVersion': 'v1', 'kind': 'DeleteOptions', 'propagationPolicy': 'Foreground', 'gracePeriodSeconds': 0,
            'preconditions': {'uid': meta['uid'], 'resourceVersion': meta['resourceVersion']}}


def validate_pod(actual, desired, ready=False, dry_run=False):
    """Permit only ordinary API defaults; admission cannot add privileges."""
    require(actual.get('apiVersion') == 'v1' and actual.get('kind') == 'Pod', 'Actual stage Pod required')
    meta = actual.get('metadata', {}); want_meta = desired['metadata']
    require(meta.get('name') == want_meta['name'] and meta.get('namespace') == want_meta['namespace'] and (dry_run or meta.get('uid'))
            and not meta.get('deletionTimestamp') and all(meta.get('labels', {}).get(k) == v for k, v in want_meta['labels'].items()), 'Stage Pod identity differs')
    spec = actual.get('spec', {}); want = desired['spec']; extra = set(spec) - set(want)
    defaults = {'dnsPolicy':'ClusterFirst', 'schedulerName':'default-scheduler', 'terminationGracePeriodSeconds':30,
                'serviceAccountName':'default', 'serviceAccount':'default', 'priority':0, 'preemptionPolicy':'PreemptLowerPriority'}
    require(extra <= set(defaults) | {'tolerations'} and all(spec[k] == defaults[k] for k in extra if k != 'tolerations'), 'Unexpected Pod defaults or privileges')
    tolerations = spec.get('tolerations', [])
    require(isinstance(tolerations, list) and len(tolerations) <= 2 and all(t == {'key':key,'operator':'Exists','effect':'NoExecute','tolerationSeconds':300}
            for t in tolerations for key in [t.get('key')] if key in {'node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'})
            and all(t.get('key') in {'node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'} for t in tolerations), 'Unexpected stage toleration')
    for field in set(want) - {'containers','volumes'}: require(spec.get(field) == want[field], 'Stage Pod field differs')
    containers = spec.get('containers', []); require(len(containers) == 1, 'Stage cannot inherit sidecars')
    c = containers[0]; wc = want['containers'][0]
    safe = {'terminationMessagePath':'/dev/termination-log','terminationMessagePolicy':'File','stdin':False,'stdinOnce':False,'tty':False}
    require(set(c) - set(wc) <= set(safe) and all(c[k] == safe[k] for k in set(c) - set(wc)), 'Stage inherited credentials, hooks or ports')
    for field in set(wc) - {'volumeMounts'}: require(c.get(field) == wc[field], 'Stage container field differs')
    mounts = c.get('volumeMounts', []); require(len(mounts) == len(wc['volumeMounts']), 'Extra stage mount')
    for mount, expected in zip(mounts, wc['volumeMounts']):
        normalize = lambda mt: {**mt, 'readOnly':mt.get('readOnly', False)}
        require(normalize(mount) == normalize(expected), 'Stage mount is not exact')
    volumes = spec.get('volumes', []); require(len(volumes) == len(want['volumes']), 'Extra stage volume')
    for volume, expected in zip(volumes, want['volumes']):
        permitted = copy.deepcopy(expected)
        if 'configMap' in expected and 'defaultMode' in volume.get('configMap', {}): permitted['configMap']['defaultMode'] = 420
        if 'persistentVolumeClaim' in expected and 'readOnly' in volume.get('persistentVolumeClaim', {}): permitted['persistentVolumeClaim']['readOnly'] = False
        require(volume == permitted, 'Stage volume is not exact')
    if ready:
        statuses = actual.get('status', {}).get('containerStatuses', [])
        require(len(statuses) == 1 and statuses[0].get('name') == wc['name'] and statuses[0].get('ready') is True and statuses[0].get('restartCount') == 0
                and statuses[0].get('imageID', '').removeprefix('docker-pullable://') == wc['image'], 'Actual stage image or health differs')
    return actual


def validate_claim(actual, desired, pending=False):
    require(actual.get('apiVersion') == 'v1' and actual.get('kind') == 'PersistentVolumeClaim', 'Actual new PVC required')
    spec = actual.get('spec', {}); want = desired['spec']
    require(set(spec) <= set(want) | {'volumeName'} and all(spec.get(k) == v for k, v in want.items() if k != 'resources'), 'Unexpected new PVC selector, source or storage fields')
    exact(spec.get('resources'), {'requests'}); exact(spec['resources']['requests'], {'storage'})
    quantity = spec['resources']['requests']['storage']; match = re.fullmatch(r'([0-9]+)([KMGTPE]i|[kMGTPE])?', quantity or '')
    require(match is not None, 'Unsupported actual PVC quantity')
    suffix = match[2]; multiplier = 1 if suffix is None else (1024 ** ('KMGTPE'.index(suffix[0]) + 1) if suffix.endswith('i') else 1000 ** ('kMGTPE'.index(suffix) + 1))
    require(int(match[1]) * multiplier == int(want['resources']['requests']['storage']), 'PVC allocation differs')
    if pending: require(actual.get('status', {}).get('phase', 'Pending') == 'Pending' and not spec.get('volumeName'), 'Claim was not genuinely new/unbound')
    return actual


def validate_create(actual, desired, dry_run=False):
    meta = actual.get('metadata', {}); wanted = desired['metadata']
    require(actual.get('apiVersion') == desired['apiVersion'] and actual.get('kind') == desired['kind'] and meta.get('name') == wanted['name']
            and meta.get('namespace') == wanted['namespace'] and (dry_run or meta.get('uid') and meta.get('resourceVersion')) and not meta.get('deletionTimestamp')
            and not meta.get('ownerReferences') and all(meta.get('labels', {}).get(k) == v for k,v in wanted['labels'].items()), 'Actual create identity differs')
    if actual['kind'] == 'Pod': validate_pod(actual, desired,dry_run=dry_run)
    elif actual['kind'] == 'PersistentVolumeClaim': validate_claim(actual, desired, True)
    else: require(actual['kind'] == 'NetworkPolicy' and actual.get('spec') == desired['spec'], 'Stage isolation policy differs')
    return actual


def make_resources(prepared, previous, target, names, storage):
    exact(names, {'writer', 'qualifier', 'packClaim', 'policy'}); exact(storage, {'storageClassName', 'shellBytes', 'packBytes'})
    for value in [*names.values(), storage['storageClassName'], prepared['selection']['shellClaim']]: resources.name(value)
    require(len(set([*names.values(), prepared['selection']['shellClaim']])) == 5, 'Every temporary/new resource needs a distinct name')
    component = target['components']['work']; namespace = component['namespace']; image = updater.image_ref(prepared['image'])
    require(image == previous['image'] and prepared['sources']['engine'] == previous['engineSource'] and prepared['sources']['work'] == previous['workSource'], 'Accepted image/engine/Work must remain unchanged')
    for size in (storage['shellBytes'], storage['packBytes']): require(type(size) is int and 0 < size <= 16 * 1024**3, 'Bounded stage storage allocation required')
    require(prepared['selection']['shellClaim'] not in {previous['shell']['name'], previous['pack']['name']} and names['packClaim'] not in {previous['shell']['name'], previous['pack']['name']}, 'Stage must not mount an active claim')
    label = {'lolly.tools/private-shell-stage': names['policy']}
    claim = lambda name, size: {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': name, 'namespace': namespace, 'labels': label},
                              'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': storage['storageClassName'], 'volumeMode': 'Filesystem', 'resources': {'requests': {'storage': str(size)}}}}
    policy = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': {'name': names['policy'], 'namespace': namespace, 'labels': label},
              'spec': {'podSelector': {'matchLabels': label}, 'policyTypes': ['Ingress', 'Egress']}}
    security = {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000, 'allowPrivilegeEscalation': False,
                'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}, 'seccompProfile': {'type': 'RuntimeDefault'}}
    def pod(name, readonly):
        volumes = [{'name': 'shell', 'persistentVolumeClaim': {'claimName': prepared['selection']['shellClaim']}},
                   {'name': 'pack', 'persistentVolumeClaim': {'claimName': names['packClaim']}}, {'name': 'tmp', 'emptyDir': {'sizeLimit': '256Mi'}}]
        mounts = [{'name': 'shell', 'mountPath': '/stage/shell', 'readOnly': readonly}, {'name': 'pack', 'mountPath': '/stage/pack', 'readOnly': readonly}, {'name': 'tmp', 'mountPath': '/tmp'}]
        if readonly:
            volumes += [{'name': 'pin', 'configMap': {'name': previous['pin']['name']}}]
            mounts += [{'name': 'pin', 'mountPath': '/stage/engine-pin.json', 'subPath': 'engine-pin.json', 'readOnly': True}]
        return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': namespace, 'labels': label},
                'spec': {'nodeName': target['node']['name'], 'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False,
                         'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000, 'fsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'}},
                         'containers': [{'name': 'stager', 'image': image, 'imagePullPolicy': 'Never', 'command': ['node', '-e', 'setInterval(()=>{},1000000)'],
                                         'securityContext': security, 'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '768Mi'}}, 'volumeMounts': mounts}], 'volumes': volumes}}
    return {'shellClaim': claim(prepared['selection']['shellClaim'], storage['shellBytes']), 'packClaim': claim(names['packClaim'], storage['packBytes']),
            'policy': policy, 'writer': pod(names['writer'], False), 'qualifier': pod(names['qualifier'], True)}


class Stage:
    def __init__(self, input_path, checksum, operator_sha, kube=None):
        self.input_path = cohort.local_path(str(input_path), Path.cwd()); self.input_sha = cohort.sha(checksum); self.operator_sha = cohort.sha(operator_sha)
        require(sha(__file__) == self.operator_sha and sha(self.input_path) == self.input_sha, 'Reviewed source/input custody differs')
        self.inputs = cohort.Inputs(self.input_path.parent); self.value = self.inputs.file({'path': str(self.input_path), 'sha256': self.input_sha})
        value = self.value; exact(value, INPUT_KEYS); require(type(value['version']) is int and value['version'] == 1, 'Unknown stage input')
        self.target = updater.validate_target(self.inputs.file(value['target'])); require('work' in self.target['components'], 'Owned Work target required')
        self.component = self.target['components']['work']; self.namespace = self.component['namespace']
        self.prepared = self.inputs.file(value['prepared']); exact(self.prepared, shell.PREPARED_KEYS | {'reviewedEvidenceSha256'})
        require(self.prepared['status'] == shell.STATUS and self.prepared['qualificationBoundary'] == shell.BOUNDARY and self.prepared['allUnselectedSpecFieldsPreserved'] is True, 'Maintained shell-only preparation required')
        self.previous, self.accepted_deployment = shell.previous_record(value['previous'], self.inputs)
        require(self.prepared['previousCohortSha256'] == value['previous']['sha256'] and self.prepared['beforeSpecSha256'] == self.previous['deploymentSpecSha256'], 'Preparation/previous spec differs')
        self.pin = self.inputs.file(self.previous['enginePin']); self.public_key = self.inputs.file(value['publicKey']); self.source_map = self.inputs.file(value['sourceMap'])
        require(self.public_key.get('kty') == 'EC' and self.public_key.get('crv') == 'P-256' and 'd' not in self.public_key, 'Public-only P-256 key required')
        require(self.pin['generatedFrom'] == self.prepared['sources']['engine'] and self.previous['enginePin']['sha256'] == self.prepared['enginePinSha256'], 'Accepted engine pin differs')
        self.old, self.new, self.pack = [cohort.Tree(value[key], self.inputs) for key in ('previousShell', 'shell', 'rawPack')]
        require(self.old.manifest_sha == self.previous['shell']['manifestSha256'] and self.old.shell_id == self.previous['shell']['releaseId']
                and self.new.manifest_sha == self.prepared['shell']['manifestSha256'] and self.new.shell_id == self.prepared['shell']['releaseId']
                and self.pack.manifest_sha == self.prepared['rawPack']['manifestSha256'] == self.previous['pack']['manifestSha256'], 'Complete accepted/prepared tree differs')
        require(all(self.new.files.get(path) == file for path, file in self.old.files.items() if path.startswith('_app/')), 'Previous lazy closure must be retained')
        require(set(self.old.files) <= set(self.new.files) and 'index.html' in self.new.files, 'A shell overlay cannot remove previous files')
        self.delta = [file for path, file in sorted(self.new.files.items()) if self.old.files.get(path) != file]
        require(self.delta and sum(file['size'] for file in self.delta) <= 32 * 1024**2 and all(file['path'].startswith('_app/') or file['path'] in {'index.html','precache.json','portable/player.js','sw.js'} for file in self.delta), 'Bounded UI-only delta required')
        require(all(self.new.files.get(path) == file for path, file in self.old.files.items() if not (path.startswith('_app/') or path in {'index.html','precache.json','portable/player.js','sw.js'})), 'Protected static bytes differ')
        self.baseline = self.inputs.file(value['baseline']); exact(self.baseline, {'version', 'deployments', 'resources', 'pods', 'claims', 'storageClass'})
        require(self.baseline['version'] == 1 and isinstance(self.baseline['deployments'], list) and len(self.baseline['deployments']) == len(self.target['components']), 'Complete target Deployment baseline required')
        self.baseline_deployments = {resource_key(dep): dep for dep in self.baseline['deployments']}
        require(len(self.baseline_deployments) == len(self.target['components']) and all(('Deployment', c['namespace'], c['deployment']) in self.baseline_deployments for c in self.target['components'].values()), 'Missing or duplicate protected Deployment')
        for key, component in self.target['components'].items():
            dep = self.baseline_deployments[('Deployment', component['namespace'], component['deployment'])]
            require(dep['metadata']['uid'] == component['deploymentUID'], 'Protected Deployment UID differs')
        work = self.baseline_deployments[('Deployment', self.namespace, self.component['deployment'])]
        require(work['spec'] == self.accepted_deployment['spec'] and work['metadata']['uid'] == self.accepted_deployment['metadata']['uid'], 'Accepted Work spec differs from baseline')
        require(isinstance(self.baseline['resources'], list) and 1 <= len(self.baseline['resources']) <= 4096, 'Complete protected storage/pin resources required')
        self.baseline_resources = {}
        for resource in self.baseline['resources']:
            require(resource['kind'] in {'PersistentVolumeClaim','PersistentVolume','ConfigMap'}, 'Secret or unknown baseline resource refused')
            key = resource_key(resource); require(key not in self.baseline_resources, 'Duplicate baseline resource'); self.baseline_resources[key] = resource
        claims = self.baseline['claims']
        complete_list(claims,'PersistentVolumeClaim',self.namespace)
        claim_map = {c['metadata']['name']:c for c in claims['items']}
        require(len(claim_map) == len(claims['items']) and all(c['metadata'].get('namespace') == self.namespace for c in claims['items']), 'Namespace PVC inventory differs')
        protected_claims = {name:r for (kind,ns,name),r in self.baseline_resources.items() if kind == 'PersistentVolumeClaim' and ns == self.namespace}
        require(claim_map == protected_claims, 'Protected resources must include every original namespace PVC')
        pv_map = {name:r for (kind,ns,name),r in self.baseline_resources.items() if kind == 'PersistentVolume'}
        for claim in claims['items']:
            if claim.get('status', {}).get('phase') == 'Bound': resources.bound_claim(claim,pv_map,self.namespace)
            else: require(not claim['spec'].get('volumeName') and claim.get('status', {}).get('phase') == 'Pending', 'Unsupported original claim state')
        for family in ('shell','pack','pin'):
            accepted = self.previous[family]; kind = 'ConfigMap' if family == 'pin' else 'PersistentVolumeClaim'
            protected = self.baseline_resources.get((kind,self.namespace,accepted['name']))
            require(protected and protected['metadata']['uid'] == accepted['uid'], 'Accepted content resource missing from protected baseline')
        for name in (value['names']['packClaim'], self.prepared['selection']['shellClaim']):
            require(('PersistentVolumeClaim',self.namespace,name) not in self.baseline_resources, 'Staging cannot reuse another instance or rollback claim')
        self.preflight_path = self.program(value['preflight']); self.host_probe = self.program(value['hostProbe'])
        exact(value['programs'], {'hash', 'native', 'boot'}); self.programs = {key: self.program(ref) for key, ref in value['programs'].items()}
        require(isinstance(value['sourceFiles'],list), 'Reviewed full operator source closure required')
        source_files = [self.inputs.file(ref,False) for ref in value['sourceFiles']]
        require(len(source_files) == len(set(source_files)) and set(source_files) >= {Path(__file__).resolve(), *[Path(__file__).with_name(name).resolve() for name in
                ('app-update.py','prepare-private-shell.py','prepare-private-cohort.py','prepare-paired-release.py','plan-private-cohort.py')]}, 'Imported operator source closure missing')
        require(type(value['minimumFreeBytes']) is int and value['minimumFreeBytes'] >= 8 * 1024**3 and type(value['maximumWriteBytes']) is int
                and self.new.files and 0 < value['maximumWriteBytes'] <= 8 * 1024**3, 'Bounded host floor/write budget required')
        require(sum(f['size'] for f in self.new.files.values()) + sum(f['size'] for f in self.pack.files.values()) <= value['maximumWriteBytes'], 'Full stage exceeds host write budget')
        require(value['ownerSealSha256'] is None or cohort.SHA.fullmatch(value['ownerSealSha256']), 'Exact owner transport seal required')
        self.desired = make_resources(self.prepared, self.previous, self.target, value['names'], value['storage'])
        sc = self.baseline['storageClass']
        require(sc.get('apiVersion') == 'storage.k8s.io/v1' and sc.get('kind') == 'StorageClass' and sc.get('metadata', {}).get('uid')
                and sc['metadata'].get('name') == value['storage']['storageClassName'] and not sc['metadata'].get('deletionTimestamp'), 'Reviewed original storage class required')
        require(sc.get('volumeBindingMode','Immediate') in {'Immediate','WaitForFirstConsumer'}, 'Unsupported storage binding mode')
        require(int(value['storage']['shellBytes']) >= sum(f['size'] for f in self.new.files.values()) and int(value['storage']['packBytes']) >= sum(f['size'] for f in self.pack.files.values()), 'PVC allocation must fit exact complete files')
        self.out = Path(value['outputDirectory']); require(self.out.is_absolute() and self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent, 'Canonical new output directory required')
        require(not any(self.out == tree.root or tree.root in self.out.parents or self.out in tree.root.parents for tree in (self.old,self.new,self.pack)), 'Output must not overlap inputs')
        self.kube = kube or self; self.events = []; self.policy_retired = False
        acceptance = self.inputs.file(self.previous['acceptance']); original = self.inputs.file(acceptance['originalEvidence'][0])
        self.owner_uid, self.replica_uid = original['podUid'], original['replicaSetUid']
        pods = complete_list(self.baseline['pods'],'Pod',self.namespace)
        owners = [pod for pod in pods['items'] if pod['metadata']['uid'] == self.owner_uid]; require(len(owners) == 1, 'Accepted owner missing')
        self.owner = owners[0]; require(self.owner['spec']['nodeName'] == self.target['node']['name'], 'Accepted owner node differs')
        self.owner_container = self.prepared['selection']['container']
        self.owner_paths = {}
        server = next(c for c in work['spec']['template']['spec']['containers'] if c['name'] == self.owner_container)
        for family in ('shell','pack'):
            matches = [mount for mount in server['volumeMounts'] if mount['name'] == self.prepared['selection'][family + 'Volume']]
            require(len(matches) == 1 and matches[0].get('readOnly') is True and 'subPath' not in matches[0], 'Accepted content mount differs')
            self.owner_paths[family] = matches[0]['mountPath']
        self.inputs.unchanged()

    def program(self, ref):
        path = self.inputs.file(ref, False); require(path.suffix in {'.py','.mjs'} and path.stat().st_size <= 1024**2, 'Bounded reviewed helper required'); return path

    def save(self, name, value):
        require(Path(name).name == name, 'Bounded receipt name required'); path = self.out / name; updater.write_json(path, value)
        return {'path': str(path), 'sha256': sha(path)}

    def transport(self, args):
        t = self.target['transport']; command = [*t['kubectl'], '--kubeconfig', t['kubeconfig'], '--context', t['context'], *args]
        if t['type'] == 'local': return command
        if t.get('sudo'): command = ['sudo','-n',*command]
        ssh = ['ssh','-oBatchMode=yes','-oConnectTimeout=12','-oStrictHostKeyChecking=yes','-oUserKnownHostsFile=' + t['knownHostsFile']]
        if t.get('jump'): ssh += ['-J',t['jump']]
        return [*ssh,t['host'],shlex.join(command)]

    def run(self, command, data=None, timeout=240):
        tag = 'command-' + uuid.uuid4().hex
        try:
            result = subprocess.run(command, input=data, capture_output=True, timeout=timeout, check=False)
            stdout, stderr, code, timed_out = result.stdout, result.stderr, result.returncode, False
        except subprocess.TimeoutExpired as error:
            stdout, stderr, code, timed_out = error.stdout or b'', error.stderr or b'', None, True
        refs = {}
        for name, bytes_ in (('stdout',stdout),('stderr',stderr)):
            path = self.out / (tag + '.' + name); fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            retained = bytes_[:32 * 1024**2]
            with os.fdopen(fd,'wb') as stream: stream.write(retained)
            refs[name] = {'path': str(path), 'sha256': hashlib.sha256(retained).hexdigest(), 'observedBytes':len(bytes_), 'complete':len(retained) == len(bytes_)}
        receipt = self.save(tag + '.json', {'exitCode':code,'timedOut':timed_out,'originals':refs}); self.events.append(receipt)
        require(not timed_out and code == 0 and all(ref['complete'] for ref in refs.values()), 'Command failed, timed out or exceeded bound; retain originals and never replay')
        return stdout

    def remote(self, args, data=None, timeout=240): return self.run(self.transport(args), data, timeout)
    def get(self, kind, name=None, namespace=None):
        args = ['get',kind,*([name] if name else []),'-o','json']
        if namespace: args += ['--namespace',namespace]
        value = cohort.parse_json(self.remote(args))
        if name is None:
            item_kind = {'pods':'Pod','pod':'Pod','pvc':'PersistentVolumeClaim','pv':'PersistentVolume','deployments':'Deployment','deployment':'Deployment'}.get(kind)
            require(item_kind is not None, 'Unknown stage collection selector')
            complete_list(value,item_kind,namespace)
        return value
    def absent(self, kind, name): return not self.remote(['get',kind,name,'-n',self.namespace,'--ignore-not-found','-o','json']).strip()
    def identities(self):
        for name in ('identities.actual.json','claims.bound.actual.json'):
            if (self.out / name).exists(): return updater.load_json(self.out / name)
        return {key:updater.load_json(self.out / ('create-' + key + '.original.json')) for key in ('shellClaim','packClaim','policy','writer')
                if (self.out / ('create-' + key + '.original.json')).exists()}

    def fresh(self, allowed_stage_uid=None):
        updater.check_cluster(self.target, self.kube)
        namespaces, deployments = {}, {}
        for namespace in sorted({component['namespace'] for component in self.target['components'].values()}):
            namespaces[namespace] = self.get('namespace',namespace)
            captured = complete_list(self.get('deployments',namespace=namespace),'Deployment',namespace)
            deployments.update({(namespace,item['metadata']['name']):item for item in captured['items']})
        inventory = DeploymentInventory(namespaces,deployments)
        for component in self.target['components'].values():
            actual = updater.deployment_identity(component, inventory); before = self.baseline_deployments[('Deployment',component['namespace'],component['deployment'])]
            require(actual['spec'] == before['spec'], 'A protected Deployment spec changed')

        claim_namespaces = {self.namespace} | {value['metadata']['namespace'] for value in self.baseline_resources.values() if value['kind'] == 'PersistentVolumeClaim'}
        claim_lists = {namespace:complete_list(self.get('pvc',namespace=namespace),'PersistentVolumeClaim',namespace) for namespace in sorted(claim_namespaces)}
        protected = {resource_key(item):item for collection in claim_lists.values() for item in collection['items']}
        pvs = complete_list(self.get('pv'),'PersistentVolume')
        protected.update({resource_key(item):item for item in pvs['items']})
        for key, before in self.baseline_resources.items():
            if before['kind'] == 'ConfigMap':
                actual = self.get(before['kind'],before['metadata']['name'],before['metadata'].get('namespace'))
            else:
                require(key in protected, 'Protected resource missing from fresh captures')
                actual = protected[key]
            require(actual['metadata']['uid'] == before['metadata']['uid'] and not actual['metadata'].get('deletionTimestamp'), 'Protected resource identity changed')
            for field in ('spec','data','binaryData','immutable'):
                require(actual.get(field) == before.get(field), 'Protected resource payload changed')
        current_claims = claim_lists[self.namespace]
        expected_claims = {c['metadata']['name']:c['metadata']['uid'] for c in self.baseline['claims']['items']}
        ids = self.identities()
        expected_claims.update({ids[key]['metadata']['name']:ids[key]['metadata']['uid'] for key in ('shellClaim','packClaim') if key in ids})
        observed_claims = {c['metadata']['name']:c['metadata']['uid'] for c in current_claims['items']}
        require(len(observed_claims) == len(current_claims['items']) and observed_claims == expected_claims, 'A namespace claim was added, replaced or removed')
        if 'policy' in ids and not self.policy_retired:
            policy = self.get('networkpolicy',ids['policy']['metadata']['name'],self.namespace)
            require(policy['metadata']['uid'] == ids['policy']['metadata']['uid'] and not policy['metadata'].get('deletionTimestamp') and policy['spec'] == self.desired['policy']['spec'], 'Stage deny policy changed or disappeared')
        before_sc = self.baseline['storageClass']; current_sc = self.get('storageclass', before_sc['metadata']['name'])
        require(current_sc['metadata']['uid'] == before_sc['metadata']['uid'] and not current_sc['metadata'].get('deletionTimestamp')
                and {k:v for k,v in current_sc.items() if k != 'metadata'} == {k:v for k,v in before_sc.items() if k != 'metadata'}, 'Storage provisioner or storage class changed')
        pods = self.get('pods', namespace=self.namespace)
        complete_list(pods,'Pod',self.namespace)
        owners = [pod for pod in pods['items'] if pod['metadata']['uid'] == self.owner_uid]; require(len(owners) == 1, 'Actual accepted owner missing')
        owner = owners[0]; refs = owner['metadata'].get('ownerReferences',[])
        require(len(refs) == 1 and refs[0].get('kind') == 'ReplicaSet' and refs[0].get('uid') == self.replica_uid and refs[0].get('controller') is True
                and owner['spec'] == self.owner['spec'] and not owner['metadata'].get('deletionTimestamp'), 'Accepted owner chain/spec changed')
        owner_status = [c for c in owner.get('status', {}).get('containerStatuses', []) if c.get('name') == self.owner_container]
        require(len(owner_status) == 1 and owner_status[0].get('ready') is True and owner_status[0].get('imageID','').removeprefix('docker-pullable://') == self.prepared['image'], 'Accepted source owner is not healthy on exact image')
        rs = self.get('replicaset', refs[0]['name'], self.namespace); parents = rs['metadata'].get('ownerReferences',[])
        require(rs['metadata']['uid'] == self.replica_uid and len(parents) == 1 and parents[0].get('uid') == self.component['deploymentUID'] and parents[0].get('kind') == 'Deployment', 'Actual accepted ReplicaSet chain changed')
        new_claims = {self.prepared['selection']['shellClaim'],self.value['names']['packClaim']}
        for pod in pods['items']:
            for volume in resources.active_volumes(pod.get('spec',{})):
                if 'persistentVolumeClaim' not in volume: continue
                claim = volume['persistentVolumeClaim']['claimName']
                require(claim not in new_claims or pod['metadata']['uid'] == allowed_stage_uid, 'New stage claim has another active owner')
                require(claim not in {self.previous['shell']['name'],self.previous['pack']['name']} or pod['metadata']['uid'] == self.owner_uid, 'Accepted source claim has another owner')
        return pods

    def preflight(self, allowed_stage_uid=None):
        require(sha(self.input_path) == self.input_sha and sha(__file__) == self.operator_sha, 'Source or execution input changed')
        for path, (stamp, checksum) in self.inputs.reads.items(): require(cohort.stamp(path.lstat()) == stamp and sha(path) == checksum, 'Reviewed helper/reference changed')
        self.inputs.unchanged()
        pods = self.fresh(allowed_stage_uid)
        capacity = cohort.parse_json(self.run([sys.executable,'-B',str(self.host_probe),'capacity','--target',str(cohort.local_path(self.value['target']['path'],self.input_path.parent))]))
        require(capacity.get('nodeUID') == self.target['node']['uid'] and capacity.get('nodeName') == self.target['node']['name'] and type(capacity.get('freeBytes')) is int
                and capacity['freeBytes'] >= self.value['minimumFreeBytes'] + self.value['maximumWriteBytes'], 'Host capacity floor/write budget refused')
        self.run([sys.executable,'-B',str(self.preflight_path)], timeout=120)
        return pods

    def owned(self, key):
        ids = self.identities(); expected = ids[key]; actual = self.get(expected['kind'],expected['metadata']['name'],self.namespace)
        require(actual['metadata']['uid'] == expected['metadata']['uid'] and not actual['metadata'].get('deletionTimestamp'), 'Owned temporary resource identity changed')
        if actual['kind'] == 'Pod':
            validate_pod(actual, self.desired[key], True)
        else: require(actual['spec'] == expected['spec'], 'Owned resource spec changed')
        return actual

    def verify_bindings(self):
        ids = self.identities(); pvs = complete_list(self.get('pv'),'PersistentVolume')
        maps = {pv['metadata']['name']:pv for pv in pvs['items']}; require(len(maps) == len(pvs['items']), 'Duplicate PV inventory'); bound = []
        for key in ('shellClaim','packClaim'):
            claim = self.owned(key); pv = resources.bound_claim(claim,maps,self.namespace)
            require(pv['metadata']['uid'] == ids[key + 'PV']['metadata']['uid'] and resources.backing(pv) == resources.backing(ids[key + 'PV']), 'New claim rebound')
            bound.append(pv)
        for selected in bound:
            for other in pvs['items']:
                if other['metadata']['uid'] == selected['metadata']['uid']: continue
                require(not resources.overlaps(resources.backing(selected),resources.backing(other)), 'New backing aliases active or rollback storage')
        return bound

    def allocate_claims(self):
        """Finish allocation and prove backings before creating a mounting Pod."""
        ids = self.identities()
        for key in ('shellClaim','packClaim'):
            before = self.get('pvc',ids[key]['metadata']['name'],self.namespace)
            require(before['metadata']['uid'] == ids[key]['metadata']['uid'] and not before['metadata'].get('deletionTimestamp'), 'Allocation claim identity changed')
            validate_claim(before,self.desired[key])
            if before.get('status',{}).get('phase') != 'Bound' and self.baseline['storageClass'].get('volumeBindingMode') == 'WaitForFirstConsumer':
                annotations = before['metadata'].get('annotations', {})
                require('volume.kubernetes.io/selected-node' not in annotations, 'Unexpected selected-node ownership')
                patch = [{'op':'test','path':'/metadata/uid','value':before['metadata']['uid']}, {'op':'test','path':'/metadata/resourceVersion','value':before['metadata']['resourceVersion']},
                         {'op':'test','path':'/spec','value':before['spec']}]
                if 'annotations' in before['metadata']: patch += [{'op':'test','path':'/metadata/annotations','value':annotations}]
                patch += [{'op':'add','path':'/metadata/annotations','value':{**annotations,'volume.kubernetes.io/selected-node':self.target['node']['name']}}]
                self.preflight()
                allocated = cohort.parse_json(self.remote(['patch','pvc',before['metadata']['name'],'-n',self.namespace,'--type=json','--patch',cohort.canonical(patch).decode(),'-o','json']))
                require(allocated['metadata']['uid'] == before['metadata']['uid'] and allocated['metadata'].get('annotations',{}).get('volume.kubernetes.io/selected-node') == self.target['node']['name'], 'Original allocation patch response differs')
                validate_claim(allocated,self.desired[key]); self.save('allocate-' + key + '.original.json',allocated)
            self.remote(['wait','--for=jsonpath={.status.phase}=Bound','pvc/' + before['metadata']['name'],'-n',self.namespace,'--timeout=120s'],timeout=140)
        pvs = complete_list(self.get('pv'),'PersistentVolume')
        maps = {pv['metadata']['name']:pv for pv in pvs['items']}; require(len(maps) == len(pvs['items']), 'Duplicate PV inventory')
        for key in ('shellClaim','packClaim'):
            claim = self.get('pvc',ids[key]['metadata']['name'],self.namespace); require(claim['metadata']['uid'] == ids[key]['metadata']['uid'], 'Allocated claim replaced')
            validate_claim(claim,self.desired[key]); ids[key] = claim; ids[key + 'PV'] = resources.bound_claim(claim,maps,self.namespace)
        self.save('claims.bound.actual.json',ids); self.verify_bindings(); self.preflight()
        return ids

    def admitted_pod(self, want):
        require(self.absent('Pod',want['metadata']['name']), 'Stage Pod collision; never adopt')
        self.verify_bindings(); self.preflight()
        checked = cohort.parse_json(self.remote(['create','--dry-run=server','-f','-','-o','json'],cohort.canonical(want)))
        # Server dry runs ordinarily omit UIDs. Preserve their original response.
        validate_create(checked,want,True)
        self.save('dry-run-' + want['metadata']['name'] + '.reviewed.json',checked)
        self.verify_bindings(); self.preflight()
        return validate_create(cohort.parse_json(self.remote(['create','-f','-','-o','json'],cohort.canonical(want))),want)

    def node(self, pod, program, payload, timeout=600):
        code = self.program_bytes(program)
        output = self.remote(['exec','-i','-n',self.namespace,pod['metadata']['name'],'-c','stager','--','node','--input-type=module','-e',code.decode()], cohort.canonical(payload), timeout)
        return cohort.parse_json(output)

    def program_bytes(self, key):
        path = self.programs[key]; code, identity = cohort.read_file(path, 1024**2)
        require(self.inputs.reads[path] == (identity,hashlib.sha256(code).hexdigest()), 'Reviewed execution program changed')
        return code

    def tree(self, pod, root, tree, owner=False):
        if owner:
            output = self.remote(['exec','-i','-n',self.namespace,pod['metadata']['name'],'-c',self.owner_container,'--','node','--input-type=module','-e',self.program_bytes('hash').decode()],
                                 cohort.canonical({'root':root,'files':list(tree.files.values()),'allowSeal':True,'sealSha256':self.value['ownerSealSha256']}),600)
            value = cohort.parse_json(output)
        else: value = self.node(pod,'hash',{'root':root,'files':list(tree.files.values()),'allowSeal':False})
        require(value.get('verified') is True and value.get('files') == len(tree.files) and value.get('network') is False and value.get('database') is False, 'Actual complete tree verification failed')
        return value

    def stream(self, writer, source, destination):
        self.verify_bindings(); self.owned('writer'); self.preflight(writer['metadata']['uid'])
        reader = self.transport(['exec','-n',self.namespace,self.owner['metadata']['name'],'-c',self.owner_container,'--','tar','--exclude=./.__lolly_release_seal.json','-C',source,'-cf','-','.'])
        destination_args = ['exec','-i','-n',self.namespace,writer['metadata']['name'],'-c','stager','--','tar','-C',destination,'-xf','-']
        # Host-local piping avoids transferring the large immutable baseline twice.
        t = self.target['transport']
        if t['type'] == 'ssh':
            prefix = reader[:-1]; read_command = reader[-1]; write_command = self.transport(destination_args)[-1]
            self.run([*prefix,'bash -c ' + shlex.quote('set -o pipefail\n' + read_command + ' | ' + write_command)], timeout=900)
        else:
            # Local transport uses an explicit, credential-free argv pipeline.
            tag = 'local-stream-' + uuid.uuid4().hex
            with tempfile.TemporaryFile() as read_errors, tempfile.TemporaryFile() as write_output, tempfile.TemporaryFile() as write_errors:
                producer = subprocess.Popen(reader,stdout=subprocess.PIPE,stderr=read_errors); consumer = None; failure = None
                try:
                    consumer = subprocess.Popen(self.transport(destination_args),stdin=producer.stdout,stdout=write_output,stderr=write_errors)
                    producer.stdout.close(); consumer.wait(timeout=900); producer.wait(timeout=30)
                except BaseException as error: failure = type(error).__name__
                finally:
                    for child in (producer,consumer):
                        if child and child.poll() is None: child.kill(); child.wait()
                    refs = {}
                    for name, stream in (('reader-stderr',read_errors),('writer-stdout',write_output),('writer-stderr',write_errors)):
                        stream.seek(0); bytes_ = stream.read(32 * 1024**2 + 1); path = self.out / (tag + '.' + name)
                        fd = os.open(path,os.O_CREAT | os.O_EXCL | os.O_WRONLY,0o600)
                        with os.fdopen(fd,'wb') as destination_file: destination_file.write(bytes_[:32 * 1024**2])
                        refs[name] = {'path':str(path),'sha256':sha(path),'complete':len(bytes_) <= 32 * 1024**2}
                    self.events.append(self.save(tag + '.json',{'readerExitCode':producer.returncode,'writerExitCode':consumer.returncode if consumer else None,'failureType':failure,'originals':refs}))
                require(not failure and producer.returncode == consumer.returncode == 0 and all(ref['complete'] for ref in refs.values()), 'Owner stream failed or exceeded bound; never replay')

    def wait_absent(self, kind, name):
        deadline = time.monotonic() + 120
        while not self.absent(kind,name):
            require(time.monotonic() < deadline, 'Owned deletion did not finish'); time.sleep(1)

    def mount_release(self, uid):
        """Observe asynchronous kubelet release; never repeat a deletion/mutation."""
        deadline = time.monotonic() + 120
        while True:
            self.inputs.unchanged()
            require(sha(self.host_probe) == self.value['hostProbe']['sha256'], 'Reviewed host mount probe changed')
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'Exact host mount-release proof did not arrive within bound')
            try:
                raw = self.run([sys.executable,'-B',str(self.host_probe),'mounts','--target',str(cohort.local_path(self.value['target']['path'],self.input_path.parent)),'--pod-uid',uid],timeout=min(100,remaining))
            except Refusal:
                # run() has already retained this new read-only observation's
                # original stdout/stderr and failure outcome. Mutations never
                # enter this loop, and their exclusive phase intents persist.
                require(time.monotonic() < deadline, 'Exact host mount-release proof did not arrive within bound')
                time.sleep(min(2,max(0,deadline-time.monotonic())))
                continue
            require(time.monotonic() < deadline, 'Exact host mount-release proof did not arrive within bound')
            output = cohort.parse_json(raw)
            require(output.get('podUid') == uid and output.get('nodeUID') == self.target['node']['uid'] and output.get('unmounted') is True and output.get('mountsReleased') is True, 'Exact host mount-release proof required')
            return output

    def phase(self, name, body):
        phase_guard(self.out,name,self.input_sha,self.operator_sha)
        try: value = body(); self.save(name + '.actual.json',{'version':1,'status':'PHASE_ACCEPTED','inputSha256':self.input_sha,'operatorSha256':self.operator_sha,**value}); return value
        except Exception as error:
            self.save(name + '.uncertain.json',{'version':1,'status':'REFUSED_NO_REPLAY_READ_ONLY_RECONCILIATION_REQUIRED','inputSha256':self.input_sha,'failureType':type(error).__name__}); raise

    def prior(self,name):
        value = updater.load_json(self.out / (name + '.actual.json')); require(value['status'] == 'PHASE_ACCEPTED' and value['inputSha256'] == self.input_sha and value['operatorSha256'] == self.operator_sha,'Genuine accepted prior phase required'); return value

    def create(self):
        require(not self.out.exists(), 'New output directory required; never adopt existing attempts'); self.out.mkdir(mode=0o700)
        self.save('resources.prepared.json',self.desired)
        def body():
            ids = {}
            for key in ('shellClaim','packClaim','policy'):
                want = self.desired[key]; require(self.absent(want['kind'],want['metadata']['name']),'Resource collision; no adoption/replay'); self.preflight()
                original = cohort.parse_json(self.remote(['create','-f','-','-o','json'],cohort.canonical(want)))
                validate_create(original, want)
                ids[key] = original; self.save('create-' + key + '.original.json',original)
            ids = self.allocate_claims()
            ids['writer'] = self.admitted_pod(self.desired['writer']); self.save('create-writer.original.json',ids['writer'])
            self.remote(['wait','--for=condition=Ready','pod/' + self.value['names']['writer'],'-n',self.namespace,'--timeout=120s'],timeout=140)
            writer = self.get('pod',self.value['names']['writer'],self.namespace); require(writer['metadata']['uid'] == ids['writer']['metadata']['uid'],'Created writer replaced'); validate_pod(writer,self.desired['writer'],True); ids['writer'] = writer
            pvs = self.get('pv'); maps = {pv['metadata']['name']:pv for pv in pvs['items']}
            for key in ('shellClaim','packClaim'):
                claim = self.get('pvc',ids[key]['metadata']['name'],self.namespace); require(claim['metadata']['uid'] == ids[key]['metadata']['uid'],'Created claim replaced'); validate_claim(claim,self.desired[key]); ids[key] = claim; ids[key + 'PV'] = resources.bound_claim(claim,maps,self.namespace)
            self.save('identities.actual.json',ids); self.verify_bindings(); self.preflight(writer['metadata']['uid'])
            return {'writerPodUID':writer['metadata']['uid'],'newClaimsVerified':True}
        return self.phase('create',body)

    def copy(self):
        self.prior('create')
        def body():
            writer = self.owned('writer'); before = {'shell':self.tree(self.owner,self.owner_paths['shell'],self.old,True),'pack':self.tree(self.owner,self.owner_paths['pack'],self.pack,True)}
            for family in ('shell','pack'): self.stream(writer,self.owner_paths[family],'/stage/' + family)
            self.tree(writer,'/stage/shell',self.old); self.tree(writer,'/stage/pack',self.pack)
            archive = self.out / 'frontend-delta.tar'
            with tarfile.open(archive,'x',format=tarfile.USTAR_FORMAT) as tar:
                for file in self.delta:
                    path = self.new.root / file['path']; info = tarfile.TarInfo(file['path']); info.size = file['size']; info.mode = 0o644; info.uid = info.gid = 1000; info.mtime = 0
                    with path.open('rb') as stream: tar.addfile(info,stream)
            require(archive.stat().st_size <= 34 * 1024**2,'Delta transport bound'); self.verify_bindings(); self.owned('writer'); self.preflight(writer['metadata']['uid'])
            self.remote(['exec','-i','-n',self.namespace,writer['metadata']['name'],'-c','stager','--','tar','-C','/stage/shell','-xf','-'],archive.read_bytes(),timeout=600)
            shell_check = self.tree(writer,'/stage/shell',self.new); pack_check = self.tree(writer,'/stage/pack',self.pack)
            self.tree(self.owner,self.owner_paths['shell'],self.old,True); self.tree(self.owner,self.owner_paths['pack'],self.pack,True)
            return {'pod':writer,'fullShellHashesVerified':shell_check['verified'],'fullPackHashesVerified':pack_check['verified'],'readOnlyOwnerStream':True,'activePVCMountedInStaging':False,'ownerBefore':before}
        return self.phase('copy',body)

    def retire_writer(self):
        copied = self.prior('copy')
        def body():
            writer = self.owned('writer'); self.verify_bindings(); self.preflight(writer['metadata']['uid'])
            self.remote(['delete','--raw','/api/v1/namespaces/' + self.namespace + '/pods/' + writer['metadata']['name'],'-f','-'],cohort.canonical(delete_options(writer)))
            self.wait_absent('pod',writer['metadata']['name']); released = self.mount_release(writer['metadata']['uid']); self.fresh()
            ids = self.identities()
            proof = {'version':1,'status':'ISOLATED_PRIVATE_SHELL_WRITER_VERIFIED_AND_RETIRED','pod':copied['pod'],'shellClaim':ids['shellClaim']['metadata']['name'],'shellClaimUID':ids['shellClaim']['metadata']['uid'],
                     'packClaim':ids['packClaim']['metadata']['name'],'packClaimUID':ids['packClaim']['metadata']['uid'],'shellManifestSha256':self.new.manifest_sha,'packManifestSha256':self.pack.manifest_sha,
                     'fullShellHashesVerified':True,'fullPackHashesVerified':True,'podAbsent':True,'mountsReleased':True,'mountProof':released}
            ref = self.save('writer.verified-and-retired.actual.json',proof); return {'proof':ref}
        return self.phase('retire-writer',body)

    def create_qualifier(self):
        self.prior('retire-writer')
        def body():
            ids = self.identities(); require(self.absent('pod',self.value['names']['writer']),'Writer reappeared'); self.mount_release(ids['writer']['metadata']['uid'])
            want = self.desired['qualifier']; created = self.admitted_pod(want); self.save('create-qualifier.original.json',created)
            self.remote(['wait','--for=condition=Ready','pod/' + want['metadata']['name'],'-n',self.namespace,'--timeout=120s'],timeout=140)
            actual = self.get('pod',want['metadata']['name'],self.namespace); require(actual['metadata']['uid'] == created['metadata']['uid'] and actual['metadata']['uid'] != ids['writer']['metadata']['uid'],'Qualifier replaced or writer/qualifier identity alias'); validate_pod(actual,want,True)
            self.save('qualifier.identity.actual.json',actual); self.preflight(actual['metadata']['uid']); self.verify_bindings(); return {'pod':actual}
        return self.phase('create-qualifier',body)

    def qualifier(self):
        expected = updater.load_json(self.out / 'qualifier.identity.actual.json'); actual = self.get('pod',expected['metadata']['name'],self.namespace)
        require(actual['metadata']['uid'] == expected['metadata']['uid'] and actual['spec'] == expected['spec'] and not actual['metadata'].get('deletionTimestamp'),'Qualifier identity/spec changed')
        validate_pod(actual,self.desired['qualifier'],True)
        return actual

    def qualify(self):
        self.prior('create-qualifier')
        def body():
            pod = self.qualifier(); self.verify_bindings(); self.preflight(pod['metadata']['uid'])
            shell_check = self.tree(pod,'/stage/shell',self.new); pack_check = self.tree(pod,'/stage/pack',self.pack)
            native = self.node(pod,'native',{'sources':self.prepared['sources'],'sourceFiles':self.source_map,'enginePinSha256':self.prepared['enginePinSha256'],'resolverPinSha256':self.prepared['resolverPinSha256'],'publicKey':self.public_key,'catalog':self.prepared['catalog']})
            require(native.get('qualified') is True and all(native.get(key) is True for key in ('retainedImmutablePinVerified','filteredCatalogSignatureVerified','publicPinMatches')),'Actual native/catalog proof required')
            require(native.get('engineVersion') == self.pin['engine']['version'] and native.get('coreVersion') == self.pin['core']['version'] and native.get('uid') == native.get('gid') == 1000
                    and native.get('sourceFiles') == len(self.source_map) and native.get('signedFiles') == self.prepared['catalog']['signedFiles']
                    and all(native.get(key) is False for key in ('network','database','productionSecrets','physicalGpuClaimed')), 'Native observations differ from reviewed isolated runtime')
            engine_stdout = self.remote(['exec','-n',self.namespace,pod['metadata']['name'],'-c','stager','--','node','scripts/verify-engine-pin.ts'])
            require(b'Content resolver matches its committed source pin.' in engine_stdout,'Maintained pin verifier refused')
            self.verify_bindings(); self.qualifier(); self.preflight(pod['metadata']['uid'])
            index = self.new.files['index.html']['sha256']; boot = self.node(pod,'boot',{'pinSha256':self.prepared['enginePinSha256'],'indexSha256':index,'publicKey':self.public_key},120)
            require(boot.get('storage') == 'memory' and boot.get('gracefulShutdown') is True and boot.get('childExitCode') == 0 and boot.get('databaseAccessed') is False and boot.get('productionSecretsAccessed') is False,'Actual isolated memory boot refused')
            self.qualifier(); self.verify_bindings()
            runtime = {'version':1,'status':'ISOLATED_PRIVATE_SHELL_RUNTIME_VERIFIED','sources':self.prepared['sources'],'image':self.prepared['image'],'actualImageId':self.prepared['image'],
                       'podUID':pod['metadata']['uid'],'enginePinSha256':self.prepared['enginePinSha256'],'engineVersion':native['engineVersion'],'coreVersion':native['coreVersion'],
                       'shellManifestSha256':self.new.manifest_sha,'shellFiles':len(self.new.files),'packManifestSha256':self.pack.manifest_sha,'packFiles':len(self.pack.files),'catalog':self.prepared['catalog'],
                       'fullShellHashesVerified':shell_check['verified'],'fullPackHashesVerified':pack_check['verified'],'retainedImmutablePinVerified':True,'filteredCatalogSignatureVerified':True,'publicPinMatches':True,
                       'uid':native['uid'],'gid':native['gid'],'native':native,'memoryBoot':boot,'originalCommands':self.events}
            ref = self.save('runtime.verified.actual.json',runtime); return {'proof':ref,'pod':pod}
        return self.phase('qualify',body)

    def retire(self):
        qualified = self.prior('qualify')
        def body():
            pod = self.qualifier(); ids = self.identities(); self.verify_bindings(); self.preflight(pod['metadata']['uid'])
            self.remote(['delete','--raw','/api/v1/namespaces/' + self.namespace + '/pods/' + pod['metadata']['name'],'-f','-'],cohort.canonical(delete_options(pod)))
            self.wait_absent('pod',pod['metadata']['name']); self.mount_release(pod['metadata']['uid']); require(self.absent('pod',ids['writer']['metadata']['name']),'Writer reappeared'); self.mount_release(ids['writer']['metadata']['uid'])
            policy = self.get('networkpolicy',ids['policy']['metadata']['name'],self.namespace); require(policy['metadata']['uid'] == ids['policy']['metadata']['uid'] and policy['spec'] == ids['policy']['spec'],'Policy replaced')
            self.verify_bindings(); self.preflight()
            self.remote(['delete','--raw','/apis/networking.k8s.io/v1/namespaces/' + self.namespace + '/networkpolicies/' + policy['metadata']['name'],'-f','-'],cohort.canonical(delete_options(policy)))
            self.wait_absent('networkpolicy',policy['metadata']['name']); self.policy_retired = True; self.fresh(); self.verify_bindings()
            retirement = {'podUID':pod['metadata']['uid'],'policyName':policy['metadata']['name'],'policyUID':policy['metadata']['uid'],'podAbsent':True,'policyAbsent':True,'mountsReleased':True}
            retired = self.save('retirement.actual.json',{'version':1,'status':'ISOLATED_PRIVATE_SHELL_STAGE_RETIRED',**retirement})
            staged = {'version':1,'status':'ISOLATED_SHELL_ACCEPTED_AND_RETIRED','sources':self.prepared['sources'],'image':self.prepared['image'],'enginePinSha256':self.prepared['enginePinSha256'],
                      'engineVersion':self.pin['engine']['version'],'coreVersion':self.pin['core']['version'],'shell':{**self.prepared['shell'],'claim':ids['shellClaim']['metadata']['name'],'claimUID':ids['shellClaim']['metadata']['uid']},
                      'rawPack':{**self.prepared['rawPack'],'storage':'ISOLATED_STAGING_PVC_COPY','volume':'pack','claim':ids['packClaim']['metadata']['name'],'claimUID':ids['packClaim']['metadata']['uid']},
                      'catalog':self.prepared['catalog'],'pod':qualified['pod'],'mounts':{'shellPath':'/stage/shell','packPath':'/stage/pack','pinPath':'/stage/engine-pin.json'},'retirement':retirement,
                      'originalEvidence':[qualified['proof'],self.prior('retire-writer')['proof'],retired]}
            ref = self.save('stage.accepted-and-retired.actual.json',staged)
            return {'stage':ref,'claimsRetained':True,'activeProductionTupleMutated':False}
        return self.phase('retire',body)

    def execute(self, action):
        methods = {'create':self.create,'copy':self.copy,'retire-writer':self.retire_writer,'create-qualifier':self.create_qualifier,'qualify':self.qualify,'retire':self.retire}
        if action == 'check': return {'status':'LOCAL_STAGE_INPUTS_BOUND_NOT_EXECUTED','desired':self.desired,'productionMutation':False}
        if action == 'run':
            for method in methods.values(): value = method()
            return value
        require(self.out.exists() or action == 'create','Prior stage output missing'); return methods[action]()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['check','run','create','copy','retire-writer','create-qualifier','qualify','retire'])
    parser.add_argument('--inputs',required=True); parser.add_argument('--sha256',required=True); parser.add_argument('--operator-sha256',required=True)
    args = parser.parse_args(); value = Stage(args.inputs,args.sha256,args.operator_sha256).execute(args.action)
    print(json.dumps(value,sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Refusal,updater.Refusal,resources.Refusal,OSError,ValueError,KeyError,TypeError,StopIteration,subprocess.SubprocessError):
        print('REFUSED: stage source, custody, identity, capacity or execution checks failed; retain originals and reconcile without replay',file=sys.stderr); raise SystemExit(1)
