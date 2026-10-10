#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Assemble and run an explicitly reviewed shell update without building images.

`check` and `plan` consume local, hash-bound originals and never contact a
target. `run` is a separate explicit execution scope: one exclusive intent,
fresh read-only captures, and the maintained stage/publisher exactly once.
Unknown, changed or uncertain evidence refuses; there is no replay or rollback.
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
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


stage = module('shell_update_stage', 'stage-private-shell.py')
planner = module('shell_update_planner', 'plan-private-shell.py')
publisher = module('shell_update_publisher', 'publish-private-shell.py')
cohort, updater = stage.cohort, stage.updater
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
PROFILE_KEYS = {'version', 'status', 'name', 'target', 'previous', 'previousShell', 'publicKey', 'sourceMap', 'preflight', 'hostProbe',
                'retiredMountProbe', 'programs', 'names', 'storage', 'mounts', 'minimumFreeBytes', 'maximumWriteBytes', 'ownerSealSha256', 'sourceFiles'}
CAPTURE_KEYS = {'version', 'status', 'targetSha256', 'systemNamespace', 'node', 'namespaces', 'deployments', 'pods', 'claims', 'volumes', 'pin', 'storageClass', 'replicaSet'}
AUTH_PROFILE = 'NORMAL_TLS_PER_CALLER_INDEX_ORACLE_AND_PINNED_P256_ENVELOPE'
MOUNT_PLACEHOLDERS = {'${stagePodUID}', '${writerPodUID}', '${nodeUID}', '${targetPath}'}
DEPENDENCIES = ('update-private-shell.py', 'stage-private-shell.py', 'publish-private-shell.py', 'plan-private-shell.py', 'prepare-private-shell.py',
                'app-update.py', 'prepare-private-cohort.py', 'prepare-paired-release.py', 'plan-private-cohort.py')


def file_ref(path):
    path = Path(os.path.abspath(path))
    return {'path': str(path), 'sha256': hashlib.sha256(cohort.read_file(path)[0]).hexdigest()}


def private_new_directory(path):
    path = Path(os.path.abspath(path))
    require(path.resolve() == path and path.parent.resolve(strict=True) == path.parent and path.parent.is_dir(), 'Canonical output parent required')
    require(not path.exists(), 'An existing update directory is never replayed')
    path.mkdir(mode=0o700)
    return path


def save(directory, name, value):
    require(Path(name).name == name, 'Owned output name required')
    return save_raw(directory, name, cohort.canonical(value) + b'\n')


def save_raw(directory, name, data):
    require(Path(name).name == name and type(data) is bytes and len(data) <= 32 * 1024**2, 'Bounded original output required')
    path = directory / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    return {'path': str(path), 'sha256': hashlib.sha256(data).hexdigest()}


def named(value, kind, api, namespace=None):
    require(type(value) is dict and value.get('apiVersion') == api and value.get('kind') == kind and type(value.get('metadata')) is dict, 'Original resource API/kind required')
    metadata = value['metadata']; stage.resources.name(metadata.get('name'))
    for key in ('uid', 'resourceVersion'):
        stage.resources.text(metadata.get(key), key)
    require(metadata.get('namespace') == namespace and not metadata.get('deletionTimestamp'), 'Original resource scope/deletion differs')
    return value


class Update:
    """No constructor or offline assembly operation executes a reviewed command."""
    def __init__(self, profile_path, profile_sha, prepared_path, prepared_sha, operator_sha):
        require(file_ref(__file__)['sha256'] == cohort.sha(operator_sha), 'Reviewed frontend update operator changed')
        self.operator_sha = operator_sha
        self.profile_path = cohort.local_path(str(profile_path), Path.cwd())
        self.inputs = cohort.Inputs(self.profile_path.parent)
        self.profile_ref = {'path': str(self.profile_path), 'sha256': cohort.sha(profile_sha)}
        raw = self.inputs.file(self.profile_ref)
        exact(raw, PROFILE_KEYS, {'authenticatedStaticProbe'})
        require(type(raw['version']) is int and raw['version'] == 1 and raw['status'] == 'REVIEWED_PRIVATE_SHELL_UPDATE_PROFILE', 'Reviewed shell profile required')
        stage.resources.name(raw['name'])
        self.profile = copy.deepcopy(raw)
        for key in ('target', 'previous', 'publicKey', 'sourceMap', 'hostProbe'):
            self.profile[key] = self.ref(raw[key], self.profile_path.parent, json_file=key != 'hostProbe')
        self.profile['previousShell'] = self.tree(raw['previousShell'], self.profile_path.parent)
        self.profile['programs'] = {key: self.ref(ref, self.profile_path.parent, False) for key, ref in raw['programs'].items()}
        exact(self.profile['programs'], {'hash', 'native', 'boot'})
        self.profile['preflight'] = self.command(raw['preflight'], self.profile_path.parent, guard=True)
        self.profile['retiredMountProbe'] = self.command(raw['retiredMountProbe'], self.profile_path.parent)
        self.mount_placeholders(self.profile['retiredMountProbe']['argv'])
        require(type(raw['sourceFiles']) is list and 1 <= len(raw['sourceFiles']) <= 500, 'Complete reviewed executable closure required')
        self.sources = [self.ref(ref, self.profile_path.parent, False) for ref in raw['sourceFiles']]
        require(len({ref['path'] for ref in self.sources}) == len(self.sources), 'Duplicate source closure path')
        required = {str(HERE / filename) for filename in DEPENDENCIES} | {ref['path'] for ref in self.profile['programs'].values()}
        required |= {self.profile[key]['source']['path'] for key in ('preflight', 'retiredMountProbe')} | {self.profile['hostProbe']['path']}
        require({ref['path'] for ref in self.sources} >= required, 'Maintained helper/command dependency closure missing')
        if 'authenticatedStaticProbe' in raw:
            self.profile['authenticatedStaticProbe'] = self.command(raw['authenticatedStaticProbe'], self.profile_path.parent, authenticated=True)
            require(hasattr(publisher, 'authenticated_catalog_report'), 'This helper set cannot verify gated private catalogues')
            require(all(self.profile['authenticatedStaticProbe'][key] in self.sources for key in ('source', 'input')), 'Authenticated source/input closure missing')
        self.target = updater.validate_target(self.inputs.file(self.profile['target']))
        require('work' in self.target['components'], 'Private Work component required')
        self.namespace = self.target['components']['work']['namespace']
        self.previous, self.before = stage.shell.previous_record(self.profile['previous'], self.inputs)
        prepared_path = cohort.local_path(str(prepared_path), Path.cwd())
        self.prepared_ref = {'path': str(prepared_path), 'sha256': cohort.sha(prepared_sha)}
        self.prepared = self.inputs.file(self.prepared_ref)
        exact(self.prepared, stage.shell.PREPARED_KEYS | {'reviewedEvidenceSha256'})
        require(type(self.prepared['version']) is int and self.prepared['version'] == 1 and self.prepared['status'] == stage.shell.STATUS and self.prepared['qualificationBoundary'] == stage.shell.BOUNDARY
                and self.prepared['allUnselectedSpecFieldsPreserved'] is True and self.prepared['previousCohortSha256'] == self.profile['previous']['sha256'], 'Maintained compatible shell preparation required')
        original = planner.cli_evidence(self.prepared, self.inputs)
        original_ref = next(ref for ref in self.prepared['evidence'] if ref['sha256'] == self.prepared['reviewedEvidenceSha256'])
        original_base = cohort.local_path(original_ref['path'], self.inputs.base).parent
        require(self.inputs.file(self.profile['publicKey']) == self.inputs.file(self.ref(original['publicPin'], original_base)),
                'Instance public pin differs from qualified preparation')
        self.shell = self.tree(original['shell'], original_base)
        self.pack = self.tree(original['rawPack'], original_base)
        require(self.shell['manifest']['sha256'] == self.prepared['shell']['manifestSha256'] and self.pack['manifest']['sha256'] == self.prepared['rawPack']['manifestSha256'], 'Qualified artifact manifest differs')
        self.source_check()

    def ref(self, value, base, json_file=True):
        exact(value, {'path', 'sha256'})
        path = cohort.local_path(value['path'], base)
        normalized = {'path': str(path), 'sha256': cohort.sha(value['sha256'])}
        self.inputs.file(normalized, json_file)
        return normalized

    def tree(self, value, base):
        exact(value, {'root', 'manifest'})
        return {'root': str(cohort.local_path(value['root'], base)), 'manifest': self.ref(value['manifest'], base)}

    def command(self, value, base, authenticated=False, guard=False):
        exact(value, {'argv', 'source'} | ({'input', 'profile'} if authenticated else set()))
        result = copy.deepcopy(value); result['source'] = self.ref(value['source'], base, False)
        argv = value['argv']; source_path = result['source']['path']
        require(type(argv) is list and argv and all(type(arg) is str and arg and '\0' not in arg for arg in argv)
                and Path(argv[0]).is_absolute() and re.fullmatch(r'python3(?:\.[0-9]+)?', Path(argv[0]).name), 'Explicit reviewed Python invocation required')
        if authenticated:
            result['input'] = self.ref(value['input'], base)
            require(value['profile'] == AUTH_PROFILE and argv[1:] in ([source_path, '--input', result['input']['path'], '--input-sha256', result['input']['sha256']],
                    ['-B', source_path, '--input', result['input']['path'], '--input-sha256', result['input']['sha256']]), 'Exact authenticated probe invocation required')
        elif guard:
            require(argv[1:] in ([source_path], ['-B', source_path]), 'Stage preflight interface takes no unreviewed arguments')
        else:
            require(argv[1:2] == [source_path] or argv[1:3] == ['-B', source_path], 'Exact reviewed guard source required')
        return result

    def source_check(self):
        require(file_ref(__file__)['sha256'] == self.operator_sha, 'Update facade source drifted')
        self.inputs.unchanged()

    @staticmethod
    def mount_placeholders(argv):
        seen = set()
        for arg in argv:
            if '${' in arg:
                require(arg in MOUNT_PLACEHOLDERS and arg not in seen, 'Unknown, partial or duplicate retired-mount placeholder')
                seen.add(arg)
        return seen

    def retired_mount_command(self, staged, stage_ref):
        """Replace whole literal argv values using held actual retirement proof."""
        command = copy.deepcopy(self.profile['retiredMountProbe'])
        if not self.mount_placeholders(command['argv']):
            return command
        base = cohort.local_path(stage_ref['path'], self.inputs.base).parent
        retirement = self.inputs.file(self.ref(staged['originalEvidence'][2], base))
        writer = self.inputs.file(self.ref(staged['originalEvidence'][1], base))
        require(staged['status'] == 'ISOLATED_SHELL_ACCEPTED_AND_RETIRED' and retirement.get('status') == 'ISOLATED_PRIVATE_SHELL_STAGE_RETIRED'
                and all(retirement.get(key) == staged['retirement'].get(key) for key in ('podUID', 'policyName', 'policyUID'))
                and all(retirement.get(key) is True and staged['retirement'].get(key) is True for key in ('podAbsent', 'policyAbsent', 'mountsReleased'))
                and retirement['podUID'] == staged['pod']['metadata']['uid'], 'Exact actual qualifier retirement original required')
        require(type(writer.get('version')) is int and writer['version'] == 1 and writer.get('status') == 'ISOLATED_PRIVATE_SHELL_WRITER_VERIFIED_AND_RETIRED'
                and writer.get('podAbsent') is True and writer.get('mountsReleased') is True
                and writer['pod']['metadata']['namespace'] == staged['pod']['metadata']['namespace'] == self.namespace
                and writer['pod']['spec']['nodeName'] == staged['pod']['spec']['nodeName'] == self.target['node']['name'],
                'Exact actual writer retirement and node original required')
        bindings = {'${stagePodUID}': stage.resources.text(staged['pod']['metadata']['uid'], 'retired qualifier UID'),
                    '${writerPodUID}': stage.resources.text(writer['pod']['metadata']['uid'], 'retired writer UID'),
                    '${nodeUID}': stage.resources.text(self.target['node']['uid'], 'reviewed node UID'),
                    '${targetPath}': self.profile['target']['path']}
        require(bindings['${stagePodUID}'] != bindings['${writerPodUID}'], 'Retired Pod identities alias')
        command['argv'] = [bindings.get(arg, arg) for arg in command['argv']]
        require(not any('${' in arg for arg in command['argv']), 'Unresolved retired-mount argument')
        self.source_check()
        return command

    def capture(self, ref):
        value = self.inputs.file(ref); exact(value, CAPTURE_KEYS)
        require(type(value['version']) is int and value['version'] == 1 and value['status'] == 'READ_ONLY_PRIVATE_SHELL_RESOURCES_CAPTURED'
                and value['targetSha256'] == self.profile['target']['sha256'], 'Capture belongs to another reviewed target')
        base = cohort.local_path(ref['path'], self.inputs.base).parent
        load = lambda raw: self.inputs.file(self.ref(raw, base))
        namespaces = {name: named(load(raw), 'Namespace', 'v1') for name, raw in value['namespaces'].items()}
        wanted = {component['namespace'] for component in self.target['components'].values()}
        require(set(namespaces) == set(value['deployments']) == wanted, 'Every protected target namespace needs complete captures')
        system = named(load(value['systemNamespace']), 'Namespace', 'v1'); node = named(load(value['node']), 'Node', 'v1')
        require(system['metadata']['name'] == 'kube-system' and system['metadata']['uid'] == self.target['clusterUID'] and node['metadata']['name'] == self.target['node']['name']
                and node['metadata']['uid'] == self.target['node']['uid'] and any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in node.get('status', {}).get('conditions', [])), 'Captured cluster/node identity or health differs')
        all_deployments = {}
        for namespace, raw in value['deployments'].items():
            collection = stage.complete_list(load(raw), 'Deployment', namespace)
            all_deployments.update({(namespace, item['metadata']['name']): item for item in collection['items']})
        inventory = stage.DeploymentInventory(namespaces, all_deployments)
        deployments = {role: updater.deployment_identity(component, inventory) for role, component in self.target['components'].items()}
        pods, claims, volumes = [stage.complete_list(load(value[key]), kind, scope) for key, kind, scope in
                                (('pods', 'Pod', self.namespace), ('claims', 'PersistentVolumeClaim', self.namespace), ('volumes', 'PersistentVolume', None))]
        pin = named(load(value['pin']), 'ConfigMap', 'v1', self.namespace)
        storage = named(load(value['storageClass']), 'StorageClass', 'storage.k8s.io/v1')
        rs = named(load(value['replicaSet']), 'ReplicaSet', 'apps/v1', self.namespace)
        acceptance = self.inputs.file(self.previous['acceptance']); original = self.inputs.file(acceptance['originalEvidence'][0])
        owners = [pod for pod in pods['items'] if pod['metadata']['uid'] == original['podUid']]
        require(len(owners) == 1 and rs['metadata']['uid'] == original['replicaSetUid'], 'Captured actual previous owner/ReplicaSet absent')
        publisher.Publication.chain(owners[0], rs, deployments['work'])
        require(deployments['work']['spec'] == self.before['spec'] and pin['metadata']['name'] == self.previous['pin']['name'] and pin['metadata']['uid'] == self.previous['pin']['uid'], 'Captured accepted Work/pin differs')
        require(storage['metadata']['name'] == self.profile['storage']['storageClassName'], 'Captured storage class differs from reviewed profile')
        self.source_check()
        return {'raw': value, 'namespaces': namespaces, 'deployments': deployments, 'pods': pods, 'claims': claims, 'volumes': volumes, 'pin': pin, 'storageClass': storage, 'owner': owners[0], 'replicaSet': rs}

    def closure(self, extra=()):
        by_path = {ref['path']: ref for ref in self.sources}
        for ref in (self.profile_ref, self.prepared_ref, *extra):
            normalized = self.ref(ref, self.inputs.base, False)
            require(normalized['path'] not in by_path or by_path[normalized['path']] == normalized, 'Conflicting custody reference')
            by_path[normalized['path']] = normalized
        return [by_path[path] for path in sorted(by_path)]

    def assemble_check(self, capture_ref, out):
        capture_ref = self.ref(capture_ref, self.inputs.base)
        current = self.capture(capture_ref)
        baseline = {'version': 1, 'deployments': [current['deployments'][role] for role in sorted(current['deployments'])],
                    'resources': [*current['claims']['items'], *current['volumes']['items'], current['pin']], 'claims': current['claims'], 'pods': current['pods'], 'storageClass': current['storageClass']}
        baseline_ref = save(out, 'stage.baseline.json', baseline)
        sources = self.closure((capture_ref, *self.capture_refs(current['raw'], capture_ref)))
        value = {'version': 1, 'target': self.profile['target'], 'prepared': self.prepared_ref, 'previous': self.profile['previous'], 'baseline': baseline_ref,
                 'previousShell': self.profile['previousShell'], 'shell': self.shell, 'rawPack': self.pack, 'publicKey': self.profile['publicKey'], 'sourceMap': self.profile['sourceMap'],
                 'preflight': self.profile['preflight']['source'], 'hostProbe': self.profile['hostProbe'], 'programs': self.profile['programs'], 'names': self.profile['names'], 'storage': self.profile['storage'],
                 'minimumFreeBytes': self.profile['minimumFreeBytes'], 'maximumWriteBytes': self.profile['maximumWriteBytes'], 'ownerSealSha256': self.profile['ownerSealSha256'],
                 'outputDirectory': str(out / 'stage-execution'), 'sourceFiles': sources}
        stage_ref = save(out, 'stage.input.json', value)
        operator = next(ref for ref in self.sources if ref['path'] == str(HERE / 'stage-private-shell.py'))
        checked = stage.Stage(stage_ref['path'], stage_ref['sha256'], operator['sha256']).execute('check')
        require(checked['status'] == 'LOCAL_STAGE_INPUTS_BOUND_NOT_EXECUTED' and checked['productionMutation'] is False, 'Offline stage check boundary differs')
        resources_ref = save(out, 'stage.resources.proposed.json', checked['desired'])
        self.source_check()
        return save(out, 'check.actual.json', {'version': 1, 'status': 'OFFLINE_PRIVATE_SHELL_UPDATE_CHECKED_NOT_EXECUTED', 'profile': self.profile_ref, 'prepared': self.prepared_ref,
                    'capture': capture_ref, 'stageInput': stage_ref, 'stageOperator': operator, 'baseline': baseline_ref, 'resources': resources_ref,
                    'targetCalls': False, 'productionMutation': False, 'originAuthenticatedByThisCommand': False})

    def capture_refs(self, value, ref):
        base = cohort.local_path(ref['path'], self.inputs.base).parent
        refs = [value[key] for key in ('systemNamespace', 'node', 'pods', 'claims', 'volumes', 'pin', 'storageClass', 'replicaSet')]
        refs += [*value['namespaces'].values(), *value['deployments'].values()]
        return [self.ref(raw, base, False) for raw in refs]

    def assemble_plan(self, checked_ref, capture_ref, stage_ref, out):
        checked_ref, capture_ref, stage_ref = [self.ref(ref, self.inputs.base) for ref in (checked_ref, capture_ref, stage_ref)]
        checked = self.inputs.file(checked_ref)
        exact(checked, {'version', 'status', 'profile', 'prepared', 'capture', 'stageInput', 'stageOperator', 'baseline', 'resources', 'targetCalls', 'productionMutation', 'originAuthenticatedByThisCommand'})
        require(type(checked['version']) is int and checked['version'] == 1 and checked['status'] == 'OFFLINE_PRIVATE_SHELL_UPDATE_CHECKED_NOT_EXECUTED'
                and checked['profile'] == self.profile_ref and checked['prepared'] == self.prepared_ref and checked['targetCalls'] is False and checked['productionMutation'] is False
                and checked['originAuthenticatedByThisCommand'] is False, 'Original offline check input differs')
        before, after = self.capture(checked['capture']), self.capture(capture_ref)
        require(all(after['deployments'][role]['spec'] == value['spec'] and after['deployments'][role]['metadata']['uid'] == value['metadata']['uid'] for role, value in before['deployments'].items()), 'Protected deployment tuple changed during staging')
        staged = self.inputs.file(stage_ref)
        require(staged.get('status') == 'ISOLATED_SHELL_ACCEPTED_AND_RETIRED' and staged.get('rawPack', {}).get('claim') == self.profile['names']['packClaim'], 'Actual isolated retired-stage input differs')
        old_claims = {claim['metadata']['name']: claim['metadata']['uid'] for claim in before['claims']['items']}
        old_claims.update({staged['shell']['claim']: staged['shell']['claimUID'], staged['rawPack']['claim']: staged['rawPack']['claimUID']})
        require(old_claims == {claim['metadata']['name']: claim['metadata']['uid'] for claim in after['claims']['items']}, 'Complete namespace claim set changed outside the two new stage claims')
        old_resources = {stage.resource_key(value): value for value in [*before['claims']['items'], *before['volumes']['items'], before['pin']]}
        new_resources = {stage.resource_key(value): value for value in [*after['claims']['items'], *after['volumes']['items'], after['pin']]}
        for key, value in old_resources.items():
            require(key in new_resources and publisher.resource_guard(new_resources[key]) == publisher.resource_guard(value), 'A protected storage/pin identity or payload changed during staging')
        require(before['storageClass'] == after['storageClass'] and before['owner']['spec'] == after['owner']['spec']
                and before['replicaSet']['spec'] == after['replicaSet']['spec'] and before['replicaSet']['metadata']['uid'] == after['replicaSet']['metadata']['uid'], 'Accepted owner or storage class changed during staging')
        facts = {'version': 1, 'namespace': after['namespaces'][self.namespace], 'resources': [*after['claims']['items'], *after['volumes']['items'], after['pin']], 'pods': after['pods']}
        facts_ref = save(out, 'planning.resources.json', facts)
        deployment_ref = save(out, 'planning.deployment.json', after['deployments']['work'])
        evidence = {'version': 1, 'prepared': self.prepared_ref, 'previous': self.profile['previous'], 'deployment': deployment_ref, 'resources': facts_ref,
                    'stage': stage_ref, 'enginePin': self.previous['enginePin'], 'mounts': self.profile['mounts']}
        evidence_ref = save(out, 'planning.input.json', evidence)
        plan, inputs = planner.plan(evidence, out)
        plan['evidence'].append(evidence_ref); plan['evidence'].sort(key=lambda ref: ref['path'])
        inputs.unchanged(); plan_ref = save(out, 'private-shell.plan.json', plan)
        baseline_ref = save(out, 'publication.baseline.json', {'version': 1, 'deployments': after['deployments'], 'owner': after['owner'], 'replicaSet': after['replicaSet']})
        extra = [checked_ref, capture_ref, stage_ref, *self.capture_refs(after['raw'], capture_ref), *staged['originalEvidence']]
        publication = {'version': 1, 'status': 'REVIEWED_PRIVATE_SHELL_PUBLICATION_INPUT', 'refs': {'plan': plan_ref, 'planningEvidence': evidence_ref, 'target': self.profile['target'],
                       'baseline': baseline_ref, 'shellManifest': self.shell['manifest'], 'packManifest': self.pack['manifest'], 'enginePin': self.previous['enginePin']},
                       'sourceFiles': self.closure(extra), 'preflight': self.profile['preflight'], 'retiredMountProbe': self.retired_mount_command(staged, stage_ref),
                       'globalPVInventoryGuarded': True}
        if 'authenticatedStaticProbe' in self.profile:
            publication['authenticatedStaticProbe'] = self.profile['authenticatedStaticProbe']
        publication_ref = save(out, 'publication.input.json', publication)
        execution = out / 'publication-execution'; execution.mkdir(mode=0o700)
        operator = next(ref for ref in self.sources if ref['path'] == str(HERE / 'publish-private-shell.py'))
        publisher.Publication(publication_ref['path'], publication_ref['sha256'], operator['sha256'], execution)
        self.source_check()
        return save(out, 'plan.actual.json', {'version': 1, 'status': 'OFFLINE_PRIVATE_SHELL_PUBLICATION_ASSEMBLED_NOT_APPLIED', 'profile': self.profile_ref, 'prepared': self.prepared_ref,
                    'check': checked_ref, 'capture': capture_ref, 'stage': stage_ref, 'plan': plan_ref, 'publicationInput': publication_ref, 'publicationOperator': operator,
                    'executionDirectory': str(execution), 'targetCalls': False, 'productionMutation': False, 'originAuthenticatedByThisCommand': False})

    def read_capture(self, out, runner=None):
        """Literal Kubernetes GETs only; keep each unmodified command response."""
        require(out.is_dir() and out.resolve(strict=True) == out and not out.stat().st_mode & 0o077,
                'Private capture directory required')
        require(not any(out.iterdir()), 'A resource capture is single-use')
        runner = runner or subprocess.run
        events = []
        save(out, 'capture.started.json', {'version': 1, 'status': 'READ_ONLY_CAPTURE_STARTED_NO_REPLAY', 'profile': self.profile_ref,
                                         'prepared': self.prepared_ref, 'target': self.profile['target'], 'operatorSha256': self.operator_sha})

        def get(label, kind, name=None, namespace=None):
            self.source_check()
            allowed = {'namespace', 'node', 'deployments', 'pods', 'persistentvolumeclaims', 'persistentvolumes', 'configmap', 'storageclass', 'replicaset'}
            require(kind in allowed, 'Only the exact reviewed resource selectors are readable')
            if name is not None: stage.resources.name(name)
            if namespace is not None: stage.resources.name(namespace)
            args = ['get', kind, *([name] if name else []), '-o', 'json']
            if namespace: args += ['--namespace', namespace]
            command = stage.Stage.transport(self, args)
            intent = save(out, label + '.started.json', {'version': 1, 'status': 'READ_ONLY_GET_STARTED_NO_REPLAY',
                          'argv': command, 'targetSha256': self.profile['target']['sha256']})
            timed_out, error_type = False, None
            try:
                completed = runner(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=100, check=False)
                stdout, stderr, code = completed.stdout, completed.stderr, completed.returncode
            except subprocess.TimeoutExpired as error:
                stdout, stderr, code, timed_out = error.stdout or b'', error.stderr or b'', None, True
            except OSError as error:
                stdout, stderr, code, error_type = b'', b'', None, type(error).__name__
            require(type(stdout) is bytes and type(stderr) is bytes, 'Original transport bytes required')
            refs = {}
            for key, raw in (('stdout', stdout), ('stderr', stderr)):
                refs[key] = {**save_raw(out, label + '.' + key + '.original', raw[:32 * 1024**2]),
                             'observedBytes': len(raw), 'complete': len(raw) <= 32 * 1024**2}
            receipt = save(out, label + '.command.original.json', {'version': 1, 'intent': intent, 'returncode': code,
                           'timedOut': timed_out, 'failureType': error_type, 'originals': refs})
            events.append(receipt)
            require(not timed_out and error_type is None and type(code) is int and code == 0 and all(ref['complete'] for ref in refs.values()),
                    'Read-only capture failed; preserve originals without replay')
            original = {'path': refs['stdout']['path'], 'sha256': refs['stdout']['sha256']}
            self.inputs.file(original)
            return original

        try:
            namespaces = sorted({component['namespace'] for component in self.target['components'].values()})
            value = {'version': 1, 'status': 'READ_ONLY_PRIVATE_SHELL_RESOURCES_CAPTURED', 'targetSha256': self.profile['target']['sha256'],
                     'systemNamespace': get('system-namespace', 'namespace', 'kube-system'), 'node': get('node', 'node', self.target['node']['name']),
                     'namespaces': {scope: get('namespace-' + scope, 'namespace', scope) for scope in namespaces},
                     'deployments': {scope: get('deployments-' + scope, 'deployments', namespace=scope) for scope in namespaces},
                     'pods': get('pods', 'pods', namespace=self.namespace), 'claims': get('claims', 'persistentvolumeclaims', namespace=self.namespace),
                     'volumes': get('volumes', 'persistentvolumes'), 'pin': get('pin', 'configmap', self.previous['pin']['name'], self.namespace),
                     'storageClass': get('storage-class', 'storageclass', self.profile['storage']['storageClassName'])}
            pods = stage.complete_list(self.inputs.file(value['pods']), 'Pod', self.namespace)
            accepted = self.inputs.file(self.inputs.file(self.previous['acceptance'])['originalEvidence'][0])
            owners = [pod for pod in pods['items'] if pod['metadata']['uid'] == accepted['podUid']]
            require(len(owners) == 1, 'Accepted owner absent from fresh original capture')
            controllers = [ref for ref in owners[0]['metadata'].get('ownerReferences', []) if ref.get('controller') is True]
            require(len(controllers) == 1 and controllers[0].get('kind') == 'ReplicaSet' and controllers[0].get('uid') == accepted['replicaSetUid'],
                    'Accepted exact ReplicaSet controller changed')
            value['replicaSet'] = get('replica-set', 'replicaset', controllers[0]['name'], self.namespace)
            ref = save(out, 'capture.original.json', value)
            self.capture(ref)
            self.source_check()
            save(out, 'capture.actual.json', {'version': 1, 'status': 'READ_ONLY_CAPTURE_VALIDATED', 'capture': ref, 'commands': events,
                                            'productionMutation': False, 'originAuthenticatedByThisCommand': False})
            return ref
        except Exception as error:
            save(out, 'capture.uncertain.json', {'version': 1, 'status': 'READ_ONLY_CAPTURE_REFUSED_NO_REPLAY', 'failureType': type(error).__name__,
                                               'commands': events, 'productionMutation': False, 'originAuthenticatedByThisCommand': False})
            raise

    def run(self, out):
        """One explicit attempt; maintained operators own every mutation guard."""
        self.source_check()
        require(out.is_dir() and out.resolve(strict=True) == out and not out.stat().st_mode & 0o077 and not any(out.iterdir()),
                'Execution requires a new empty private directory')
        require(self.prepared['sources']['lolly'] != self.previous['shellSource'] and self.prepared['shell']['releaseId'] != self.previous['shell']['releaseId'],
                'Publication requires a genuine new qualified shell source/release')
        require(self.target['components']['work'].get('healthURLs'), 'Work target needs configured normal HTTPS acceptance routes')
        save(out, 'run.started.json', {'version': 1, 'status': 'PRIVATE_SHELL_UPDATE_STARTED_NO_REPLAY', 'profile': self.profile_ref,
                                      'prepared': self.prepared_ref, 'operatorSha256': self.operator_sha, 'originAuthenticatedByThisCommand': False})
        phase = 'capture-before-stage'
        publication = None
        try:
            captured = self.read_capture(private_new_directory(out / phase))
            phase = 'stage-check'
            check = self.assemble_check(captured, private_new_directory(out / phase))
            value = self.inputs.file(check)
            phase = 'stage-run'
            self.source_check()
            staged = stage.Stage(value['stageInput']['path'], value['stageInput']['sha256'], value['stageOperator']['sha256']).execute('run')
            exact(staged, {'stage', 'claimsRetained', 'activeProductionTupleMutated'})
            require(staged['claimsRetained'] is True and staged['activeProductionTupleMutated'] is False,
                    'Maintained isolated stage returned an unexpected boundary')
            stage_ref = self.ref(staged['stage'], self.inputs.base)
            save(out, 'stage-run.actual.json', {'version': 1, 'status': 'MAINTAINED_ISOLATED_STAGE_RETIRED', 'check': check, 'result': staged})
            phase = 'capture-after-stage'
            captured = self.read_capture(private_new_directory(out / phase))
            phase = 'publication-plan'
            planned_ref = self.assemble_plan(check, captured, stage_ref, private_new_directory(out / phase))
            planned = self.inputs.file(planned_ref)
            self.source_check()
            publication = publisher.Publication(planned['publicationInput']['path'], planned['publicationInput']['sha256'],
                                              planned['publicationOperator']['sha256'], planned['executionDirectory'])
            for phase in ('dryrun', 'apply', 'observe'):
                self.source_check()
                getattr(publication, phase)()
                save(out, phase + '.handoff.actual.json', {'version': 1, 'status': 'MAINTAINED_PHASE_RETURNED', 'phase': phase,
                                                         'publicationInput': planned['publicationInput'], 'plan': planned_ref})
            self.source_check()
            observed = publication.prior('observe', 'ACTUAL_PRIVATE_SHELL_OWNER_CONTENT_AND_TLS_VERIFIED_ACCEPTANCE_PENDING')
            accepted = self.ref(observed['acceptedPrevious'], self.inputs.base)
            return save(out, 'run.actual.json', {'version': 1, 'status': 'PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED', 'profile': self.profile_ref,
                        'prepared': self.prepared_ref, 'check': check, 'stage': stage_ref, 'plan': planned_ref, 'acceptedPrevious': accepted,
                        'publicationInput': planned['publicationInput'], 'operatorSha256': self.operator_sha, 'productionMutation': True,
                        'infrastructureProvisioned': False, 'imageRebuilt': False, 'originAuthenticatedByThisCommand': False,
                        'remainingAcceptance': ['Authenticated export and document-agent canaries', 'Signed-in reconnect and visual checks']})
        except Exception as error:
            # Keep the same explicit failure custody as the maintained CLI;
            # neither this facade nor its operators retry a failed mutation.
            if publication is not None and phase in {'dryrun', 'apply', 'observe'} and (publication.out / (phase + '.started.json')).exists() and not (publication.out / (phase + '.uncertain.json')).exists():
                publication.save(phase + '.uncertain.json', {**publication.header('REFUSED_NO_REPLAY_RECONCILE_ORIGINAL_STATE'), 'failureType': type(error).__name__})
            save(out, 'run.uncertain.json', {'version': 1, 'status': 'REFUSED_NO_REPLAY_RECONCILE_ORIGINAL_STATE', 'phase': phase,
                                          'failureType': type(error).__name__, 'profile': self.profile_ref, 'prepared': self.prepared_ref,
                                          'operatorSha256': self.operator_sha, 'runtimeAcceptanceClaimed': False})
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'plan', 'run'])
    for key in ('profile', 'profile-sha256', 'prepared', 'prepared-sha256', 'operator-sha256', 'out'):
        parser.add_argument('--' + key, required=True)
    for key in ('capture', 'capture-sha256', 'check', 'check-sha256', 'stage', 'stage-sha256'):
        parser.add_argument('--' + key)
    args = parser.parse_args()
    if args.action == 'run':
        require(not any((args.capture, args.capture_sha256, args.check, args.check_sha256, args.stage, args.stage_sha256)), 'Run captures fresh originals; it cannot reuse an offline attempt')
        operation = Update(args.profile, args.profile_sha256, args.prepared, args.prepared_sha256, args.operator_sha256)
        result = operation.run(private_new_directory(args.out))
        print(json.dumps({'status': 'RUNTIME_ACCEPTED_CANARIES_PENDING', 'receipt': result}, sort_keys=True))
        return
    require(args.capture and args.capture_sha256, 'Original local capture required for offline assembly')
    require((args.action == 'plan') == bool(args.check and args.check_sha256 and args.stage and args.stage_sha256), 'Plan requires original check and actual retired stage; check accepts neither')
    require(args.action == 'plan' or not any((args.check, args.check_sha256, args.stage, args.stage_sha256)), 'Unknown offline check extras')
    operation = Update(args.profile, args.profile_sha256, args.prepared, args.prepared_sha256, args.operator_sha256)
    out = private_new_directory(args.out)
    capture = {'path': str(cohort.local_path(args.capture, Path.cwd())), 'sha256': cohort.sha(args.capture_sha256)}
    if args.action == 'check':
        result = operation.assemble_check(capture, out)
    else:
        result = operation.assemble_plan({'path': str(cohort.local_path(args.check, Path.cwd())), 'sha256': cohort.sha(args.check_sha256)}, capture,
                                         {'path': str(cohort.local_path(args.stage, Path.cwd())), 'sha256': cohort.sha(args.stage_sha256)}, out)
    print(json.dumps({'status': args.action.upper() + '_PASS_NO_TARGET_CALLS', 'receipt': result}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('REFUSED: private shell update custody differs; preserve originals and do not replay', file=sys.stderr)
        raise SystemExit(1)
