#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Bind a frontend-only full-root update to a reviewed runtime adapter.

Preparation renders requests and resources only. Admission consumes actual
adapter custody and returns an exact guarded patch; neither action executes a
cluster command. The adapter owns allocation, native verification, retirement,
fresh target checks and publication. Active model storage is never staged.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('delivery_assembly', Path(__file__).with_name('assemble-public-delivery.py'))
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
need, exact, raw = a.need, a.exact, a.raw
VOLUME = 'public-delivery'
ANNOTATIONS = {'lolly.tools/full-root-source', 'lolly.tools/full-root-manifest', 'lolly.tools/delivery-etags-sha256'}
STAGES = ['create', 'copy', 'retire-writer', 'create-qualifier', 'qualify', 'retire']
CAPABILITIES = {'completeProtectedDeployments', 'globalPodsPVCsPVs', 'uniqueBackingAndMountRelease',
                'sourceRootIdentityDACMCS', 'newRootOnly', 'modelsThroughOwnerOnly', 'nativePhysicalCodingAndSignature',
                'nativeHTTPAndMemory', 'exclusiveNoReplay', 'preflightImmediatelyBeforeEveryMutation'}
REFS = {'deployment', 'baseline', 'assembly', 'previousManifest', 'models', 'configs',
        'qualifiedSource', 'acceptedRelease', 'adapterReview'}
ACCEPTED_KEYS = {'version', 'status', 'deploymentUID', 'deploymentSpecSha256', 'ownerPodUID',
                 'image', 'manifestSha256', 'mapSha256', 'models', 'configs', 'publicPin'}


def digest(value): return hashlib.sha256(raw(value)).hexdigest()
def held(ref): return a.parsed(a.read_ref(ref))
def dns(value): return type(value) is str and bool(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', value))
def sha(value): return type(value) is str and bool(a.overlay.SHA.fullmatch(value))


def serving_binding(bundle, prepared, node):
    """Pure full-owner/process fence for the two actual observation bookends."""
    exact(bundle, {'deployment', 'pod', 'replicaSet'})
    deployment, pod, replica = (bundle[k] for k in ['deployment', 'pod', 'replicaSet'])
    before = held(prepared['refs']['deployment']); selected(deployment)
    need(deployment['metadata']['uid'] == before['metadata']['uid']
         and deployment['spec'] == prepared['desiredSpec'], 'Observed serving Deployment differs from the qualified switch')
    expected = copy.deepcopy(before); expected['spec'] = prepared['desiredSpec']
    if 'generation' in expected['metadata']: expected['metadata']['generation'] += 1
    annotations = expected['metadata'].get('annotations', {})
    if 'deployment.kubernetes.io/revision' in annotations:
        need(annotations['deployment.kubernetes.io/revision'].isdigit(), 'Original numeric controller revision required')
        annotations['deployment.kubernetes.io/revision'] = str(int(annotations['deployment.kubernetes.io/revision']) + 1)
    same_deployments([deployment], [expected])
    status = deployment.get('status', {}); generation = deployment['metadata'].get('generation')
    need(type(generation) is int and generation > 0 and status.get('observedGeneration') == generation
         and all(status.get(k) == 1 for k in ['replicas', 'readyReplicas', 'availableReplicas', 'updatedReplicas'])
         and status.get('unavailableReplicas', 0) == 0, 'Actual serving generation must be fully Ready')
    spec = importlib.util.spec_from_file_location('delivery_baseline_owner', Path(__file__).with_name('stage-public-shell.py'))
    legacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(legacy)
    legacy.Stage.owner_chain(pod, replica, deployment)
    meta = prepared['desiredSpec']['template']['metadata']; labels = copy.deepcopy(meta.get('labels', {}))
    controller_hash = replica['metadata'].get('labels', {}).get('pod-template-hash')
    need(type(controller_hash) is str and re.fullmatch('[a-z0-9]{1,63}', controller_hash), 'Original ReplicaSet template hash required')
    labels['pod-template-hash'] = controller_hash
    for value in [pod, replica]:
        need(value['metadata'].get('namespace') == before['metadata']['namespace']
             and value['metadata'].get('uid') and not value['metadata'].get('deletionTimestamp'), 'Live original owner identities required')
    copied = copy.deepcopy(pod)
    need(copied['metadata'].get('labels') == labels and copied['metadata'].get('annotations', {}) == meta.get('annotations', {})
         and copied['spec'].get('nodeName') == node, 'Observed Pod metadata or scheduling changed')
    if 'nodeName' not in prepared['desiredSpec']['template']['spec']: copied['spec'].pop('nodeName')
    wanted = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod['metadata']['name'],
        'namespace': before['metadata']['namespace'], 'labels': labels}, 'spec': prepared['desiredSpec']['template']['spec']}
    legacy.validate_public_pod(copied, wanted, ready=True)
    template = replica['spec']['template']
    need(template['metadata'].get('labels') == labels and template['metadata'].get('annotations', {}) == meta.get('annotations', {}),
         'ReplicaSet template metadata differs')
    projected = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {**wanted['metadata'], 'uid': replica['metadata']['uid']}, 'spec': template['spec']}
    legacy.validate_public_pod(projected, wanted)
    selector = copy.deepcopy(prepared['desiredSpec']['selector']); selector.setdefault('matchLabels', {})['pod-template-hash'] = controller_hash
    need(replica['spec']['selector'] == selector and replica['spec']['replicas'] == 1, 'ReplicaSet selector or replica ownership differs')
    process = pod['status']['containerStatuses'][0]
    need(type(process.get('containerID')) is str and re.fullmatch('containerd://[a-f0-9]{64}', process['containerID'])
         and set(process.get('state', {})) == {'running'}
         and type(process['state']['running'].get('startedAt')) is str and process['state']['running']['startedAt'],
         'Actual running container identity/start time required')
    return {'deploymentUID': deployment['metadata']['uid'], 'deploymentSpecSha256': digest(deployment['spec']),
        'deploymentMetadata': {k: deployment['metadata'].get(k, {}) for k in ['labels', 'annotations', 'generation']},
        'ownerPodUID': pod['metadata']['uid'], 'podSpec': pod['spec'],
        'podMetadata': {k: pod['metadata'].get(k, {}) for k in ['labels', 'annotations', 'ownerReferences']},
        'replicaSetUID': replica['metadata']['uid'], 'replicaSetSpec': replica['spec'],
        'replicaSetMetadata': {k: replica['metadata'].get(k, {}) for k in ['labels', 'annotations', 'ownerReferences']},
        'process': {k: process.get(k) for k in ['name', 'image', 'imageID', 'containerID', 'state', 'restartCount', 'ready']}}


def publication_baseline(proof):
    """Derive the next baseline only from original successful publication custody.

    This function reads held evidence only. It neither observes a target nor
    converts an unqualified root or a requested tuple into serving acceptance.
    """
    exact(proof, {'version', 'input', 'operator', 'phases'})
    need(proof['version'] == 1, 'Closed original publication proof required')
    a.read_ref(proof['operator']); publication = held(proof['input'])
    exact(publication, {'version', 'status', 'stageInput', 'stageSource', 'retirement', 'outputDirectory'})
    need(publication['version'] == 1 and publication['status'] == 'REVIEWED_ACTUAL_FRONTEND_ROOT_PUBLICATION_NOT_EXECUTED'
         and Path(proof['operator']['path']).name == 'publish-public-delivery.py'
         and Path(publication['stageSource']['path']) == Path(proof['operator']['path']).with_name('stage-public-delivery.py'),
         'Original maintained publication input/source required')
    a.read_ref(publication['stageSource']); runtime = held(publication['stageInput'])
    exact(runtime, {'version', 'status', 'prepared', 'target', 'context', 'programs', 'sources', 'outputDirectory'})
    need(runtime['version'] == 1 and runtime['status'] == 'REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED'
         and publication['stageSource'] in runtime['sources'], 'Original reviewed stage binding required')
    for ref in runtime['sources']: a.read_ref(ref)
    exact(runtime['programs'], {'preflight', 'hostProbe', 'node', 'signatureVerifier'})
    for key, ref in runtime['programs'].items():
        exact(ref, {'path', 'sha256'}); path = Path(ref['path'])
        need(path.is_absolute() and path.resolve(strict=True) == path and sha(ref['sha256']) and a.checksum(path) == ref['sha256']
             and (key == 'node' or ref in runtime['sources']), 'Original registered execution program differs')
    prepared = held(runtime['prepared']); retirement = held(publication['retirement']); admit(prepared, retirement)
    adapter = held(prepared['refs']['adapterReview'])
    need(adapter['source'] == publication['stageSource'] and adapter['sources'] == runtime['sources'], 'Original adapter registry closure differs')
    need(retirement['prepared'] == runtime['prepared'] and retirement['adapter'] == publication['stageSource']
         and publication['retirement']['path'] == str(Path(runtime['outputDirectory']) / 'runtime.qualified-and-retired.actual.json'),
         'Original exact qualified-and-retired stage required')
    output = Path(publication['outputDirectory']); exact(proof['phases'], {'dryrun', 'publish', 'observe'})
    phases, commands = {}, set()
    for name in ['dryrun', 'publish', 'observe']:
        refs = proof['phases'][name]; exact(refs, {'started', 'accepted'})
        for kind, ref in refs.items():
            need(ref['path'] == str(output / (name + '.' + kind + '.json')), 'Original exclusive publication phase path required')
        uncertain = output / (name + '.uncertain.json')
        need(not uncertain.exists() and not uncertain.is_symlink(), 'Failed or uncertain publication cannot seed a baseline')
        start, phase = held(refs['started']), held(refs['accepted'])
        exact(start, {'status', 'inputSha256', 'operatorSha256'})
        common = {'version', 'inputSha256', 'operatorSha256', 'commands', 'status', 'productionMutation'}
        exact(phase, common | ({'before', 'patch', 'response'} if name != 'observe' else
            {'deploymentUID', 'deploymentSpecSha256', 'source', 'manifest', 'mapSha256', 'physical', 'memory', 'evidence',
             'modelsMountedByStaging', 'allProtectedSpecsVerified', 'browserAcceptanceClaimed'}))
        need(start['status'] == 'STARTED_NO_REPLAY' and phase['version'] == 1
             and all(start[k] == phase[k] == proof[v]['sha256'] for k, v in [('inputSha256', 'input'), ('operatorSha256', 'operator')]),
             'Publication phase source/input custody differs')
        need(type(phase.get('commands')) is list and phase['commands'], 'Actual original publication commands required')
        for ref in phase['commands']:
            need(Path(ref['path']).parent == output and ref['path'] not in commands, 'Command belongs to another or repeated publication phase')
            commands.add(ref['path'])
            command = held(ref)
            need(command.get('exitCode') == 0 and command.get('failure') is None and command.get('complete') is True,
                 'Failed or incomplete command cannot seed a baseline')
            for stream in ['stdout', 'stderr']:
                need(Path(command[stream]['path']).parent == output, 'Original command stream belongs to another journal')
                a.read_ref(command[stream])
        phases[name] = phase
    need(phases['dryrun']['status'] == 'ACTUAL_FRONTEND_SERVER_DRYRUN_NOT_PUBLISHED' and phases['dryrun']['productionMutation'] is False
         and phases['publish']['status'] == 'ACTUAL_FRONTEND_PATCHED_ACCEPTANCE_PENDING' and phases['publish']['productionMutation'] is True,
         'Actual dryrun and switch must precede observation')
    observed = phases['observe']
    need(observed['status'] == 'ACTUAL_FRONTEND_ROOT_SERVING_VERIFIED' and observed['productionMutation'] is False
         and observed['allProtectedSpecsVerified'] is True and observed['modelsMountedByStaging'] is False
         and observed['browserAcceptanceClaimed'] is False and observed['source'] == prepared['source']
         and observed['manifest'] == prepared['manifest'] and observed['mapSha256'] == prepared['mapSha256'],
         'Actual complete serving observation required')
    exact(observed['evidence'], {'ownerBefore', 'ownerAfter', 'nativeHTTP', 'staticTLS', 'modelsTLS'})
    evidence = {}
    filenames = {'ownerBefore': 'owner-before.original.json', 'ownerAfter': 'owner.original.json',
        'nativeHTTP': 'owning-native-http.actual.json', 'staticTLS': 'owning-static-tls.actual.json', 'modelsTLS': 'owning-models-tls.actual.json'}
    for key, ref in observed['evidence'].items():
        need(ref['path'] == str(output / filenames[key]), 'Serving evidence belongs to another publication')
        evidence[key] = held(ref)
    held(runtime['context']); target = held(runtime['target'])
    binding = serving_binding(evidence['ownerBefore'], prepared, target['node']['name'])
    need(binding == serving_binding(evidence['ownerAfter'], prepared, target['node']['name'])
         and observed['deploymentUID'] == binding['deploymentUID'] and observed['deploymentSpecSha256'] == binding['deploymentSpecSha256']
         and observed['memory']['podUID'] == binding['ownerPodUID'], 'Serving owner/process changed across observation')
    for name in ['dryrun', 'publish']:
        phase = phases[name]
        for key in ['before', 'patch', 'response']:
            need(phase[key]['path'] == str(output / (name + '.' + key + '.original.json')), 'Original guarded switch evidence path differs')
        before, response, patch = held(phase['before']), held(phase['response']), held(phase['patch'])
        original = held(prepared['refs']['deployment'])
        need(before['metadata']['uid'] == original['metadata']['uid'] and before['spec'] == original['spec']
             and type(before['metadata'].get('resourceVersion')) is str and before['metadata']['resourceVersion'], 'Actual pre-switch owner differs')
        need(patch == [{'op': 'test', 'path': '/metadata/uid', 'value': before['metadata']['uid']},
            {'op': 'test', 'path': '/metadata/resourceVersion', 'value': before['metadata']['resourceVersion']},
            {'op': 'test', 'path': '/spec', 'value': before['spec']}, {'op': 'replace', 'path': '/spec', 'value': prepared['desiredSpec']}],
            'Original UID/RV/full-spec atomic switch required')
        need(response['metadata']['uid'] == binding['deploymentUID'] and response['spec'] == prepared['desiredSpec'], 'Original server response differs')
    manifest, models = held(prepared['manifest']), held(prepared['refs']['models'])['files']
    exact(observed['physical'], {'static', 'models'})
    for key, rows in [('static', manifest['files']), ('models', models)]:
        value = observed['physical'][key]
        need(value['files'] == len(rows) and value['bytes'] == sum(row['size'] for row in rows)
             and value['physicalEpoch'] == 0 and value['uid'] == value['gid'] == 101 and value['allPhysicalHashesVerified'] is True
             and value['modelLinkClosureVerified'] is (key == 'models')
             and (sha(value['modelInodeFingerprint']) if key == 'models' else value['hardLinkedFiles'] == 0),
             'Complete physical serving proof differs')
    memory = observed['memory']; exact(memory, {'version', 'podUID', 'limitBytes', 'currentBytes', 'peakBytes', 'oom', 'oomKill', 'rssBytes'})
    limit = re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)', prepared['desiredSpec']['template']['spec']['containers'][0]['resources']['limits']['memory'])
    need(limit and memory['version'] == 1 and all(type(memory[k]) is int for k in set(memory) - {'version', 'podUID'})
         and memory['limitBytes'] == int(limit[1]) * (1024**2 if limit[2] == 'Mi' else 1024**3)
         and 0 < memory['rssBytes'] <= memory['currentBytes'] <= memory['peakBytes'] < memory['limitBytes']
         and memory['oom'] == memory['oomKill'] == 0, 'Actual serving memory gate required')
    need(evidence['nativeHTTP']['static']['status'] == 'ISOLATED_STATIC_HTTP_RETAINED_FULL_BYTES_AND_SAMPLES_VERIFIED_ONLY'
         and evidence['nativeHTTP']['decoded']['status'] == 'ACTUAL_LOOPBACK_GZIP_WIRE_AND_DECODED_IDENTITY_VERIFIED'
         and evidence['modelsTLS']['status'] == 'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY'
         and evidence['modelsTLS']['inventorySha256'] == hashlib.sha256(json.dumps(models, separators=(',', ':')).encode()).hexdigest()
         and evidence['modelsTLS']['files'] == len(models), 'Actual native and normal TLS model HTTP proof required')
    static = evidence['staticTLS']; need(static['status'] == 'ACTUAL_NORMAL_TLS_MUTABLE_ROOT_IDENTITIES_VERIFIED', 'Actual normal TLS static proof required')
    expected = {row['path']: row for row in manifest['files'] if row['path'] in a.overlay.FIXED}
    need(type(static['rows']) is list and len(static['rows']) == len(expected) == 4
         and {row['path'] for row in static['rows']} == set(expected)
         and all(row['status'] == 200 and row['size'] == expected[row['path']]['size'] and row['sha256'] == expected[row['path']]['sha256']
                 for row in static['rows']), 'Exact complete normal TLS static bodies required')
    previous = held(prepared['refs']['acceptedRelease'])
    return {'version': 2, 'status': 'ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED',
        'deploymentUID': binding['deploymentUID'], 'deploymentSpecSha256': binding['deploymentSpecSha256'], 'ownerPodUID': binding['ownerPodUID'],
        'image': prepared['desiredSpec']['template']['spec']['containers'][0]['image'],
        'manifestSha256': prepared['manifest']['sha256'], 'mapSha256': prepared['mapSha256'],
        'models': prepared['refs']['models'], 'configs': prepared['refs']['configs'], 'publicPin': previous['publicPin'], 'publication': copy.deepcopy(proof)}


def matches(selector, labels):
    """Use Kubernetes selector semantics for additive policy exposure checks."""
    need(type(selector) is dict and set(selector) <= {'matchLabels', 'matchExpressions'}, 'Unknown Pod selector grammar')
    ordinary, expressions = selector.get('matchLabels', {}), selector.get('matchExpressions', [])
    need(type(ordinary) is dict and type(expressions) is list, 'Exact selector types required')
    if any(labels.get(key) != value for key, value in ordinary.items()): return False
    for expression in expressions:
        need(type(expression) is dict and set(expression) <= {'key', 'operator', 'values'}
             and type(expression.get('key')) is str and expression.get('operator') in {'In', 'NotIn', 'Exists', 'DoesNotExist'}, 'Unknown selector expression')
        key, operator, values = expression['key'], expression['operator'], expression.get('values', [])
        need(type(values) is list and all(type(value) is str for value in values), 'Selector values must be strings')
        if operator == 'In' and labels.get(key) not in values or operator == 'NotIn' and key in labels and labels[key] in values: return False
        if operator == 'Exists' and key not in labels or operator == 'DoesNotExist' and key in labels: return False
    return True


def exposure(baseline, labels, namespace):
    for row in baseline['services']['items']:
        if row['metadata'].get('namespace') != namespace: continue
        selector = row.get('spec', {}).get('selector')
        need(not selector or not all(labels.get(key) == value for key, value in selector.items()), 'Existing Service would select temporary Pods')
    for row in baseline['policies']['items']:
        if row['metadata'].get('namespace') != namespace: continue
        if matches(row['spec']['podSelector'], labels):
            need(not row['spec'].get('ingress') and not row['spec'].get('egress'), 'Existing additive policy would expose temporary Pods')


def selected(value):
    """Admit an already accepted credential-free whole-root Deployment."""
    meta = value.get('metadata', {})
    need(value.get('apiVersion') == 'apps/v1' and value.get('kind') == 'Deployment'
         and dns(meta.get('name')) and dns(meta.get('namespace'))
         and all(type(meta.get(key)) is str and meta[key] for key in ['uid', 'resourceVersion'])
         and not meta.get('deletionTimestamp'), 'Actual selected Deployment UID/RV required')
    before = value['spec']; pod = before['template']['spec']
    need(before['replicas'] == 1 and before['strategy']['type'] == 'Recreate'
         and len(pod['containers']) == 1 and not pod.get('initContainers') and not pod.get('ephemeralContainers')
         and not pod.get('serviceAccountName') and not pod.get('hostNetwork'), 'Serial credential-free native web owner required')
    web = pod['containers'][0]
    need(dns(web['name']) and re.fullmatch(r'[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}', web['image'])
         and not set(web) & {'env', 'envFrom', 'lifecycle', 'volumeDevices'}, 'Digest-pinned accepted native image without credentials required')
    security = pod['securityContext']
    need(security['runAsUser'] == security['runAsGroup'] == security['fsGroup'] == 101
         and security['fsGroupChangePolicy'] == 'OnRootMismatch', 'Preserve native UID/GID and SELinux root handoff')
    volumes = {v['name']: v for v in pod['volumes']}
    need(len(volumes) == len(pod['volumes']) and set(volumes) == {'tmp', 'nginx', 'models', VOLUME}
         and set(volumes[VOLUME]) == {'name', 'persistentVolumeClaim'}
         and set(volumes['models']) == {'name', 'persistentVolumeClaim'}
         and set(volumes['nginx']) == {'name', 'configMap'} and set(volumes['tmp']) == {'name', 'emptyDir'},
         'Accepted complete-root, separate model and unchanged configuration placement required')
    need([v for v in web['volumeMounts'] if v['name'] == VOLUME] == a.overlay.overlay_mounts(VOLUME),
         'Legacy five-path or standalone-map placement cannot enter this lane')
    models = [v for v in web['volumeMounts'] if v['name'] == 'models']
    need(len(models) == 2 and models[0] == {'name': 'models', 'mountPath': '/run/lolly-public-models', 'readOnly': True}
         and models[1].get('mountPath') == a.overlay.ROOT + '/models' and models[1].get('readOnly') is True
         and re.fullmatch(r'models-[a-f0-9]{64}', models[1].get('subPath', '')),
         'Accepted read-only model recipe required')
    need(all(v['name'] in volumes for v in web['volumeMounts'])
         and all(sha(before['template']['metadata']['annotations'].get(key)) for key in ANNOTATIONS - {'lolly.tools/full-root-source'})
         and re.fullmatch(r'[a-f0-9]{40}', before['template']['metadata']['annotations'].get('lolly.tools/full-root-source', '')),
         'Complete accepted root provenance required')
    return before


def protected(value):
    """Keep the entire captured Deployment set, including unrelated applications."""
    exact(value, {'version', 'deployments', 'pods', 'pvcs', 'pvs', 'services', 'policies'})
    need(value['version'] == 1 and type(value['deployments']) is list and value['deployments'], 'Complete protected baseline required')
    result = {}
    for row in value['deployments']:
        meta = row.get('metadata', {}); key = (meta.get('namespace'), meta.get('name'))
        need(row.get('apiVersion') == 'apps/v1' and row.get('kind') == 'Deployment' and key not in result
             and dns(key[0]) and dns(key[1]) and meta.get('uid') and meta.get('resourceVersion')
             and not meta.get('deletionTimestamp') and type(row.get('spec')) is dict, 'Complete unique Deployment UID/spec rows required')
        result[key] = row
    for key in ['pods', 'pvcs', 'pvs', 'services', 'policies']:
        need(type(value[key]) is dict and (key not in {'pods', 'pvcs', 'pvs'} or value[key].get('apiVersion') == 'v1'),
             'Original complete collection required')
        need(type(value[key].get('items')) is list and type(value[key].get('metadata')) is dict
             and type(value[key]['metadata'].get('resourceVersion')) is str
             and not value[key]['metadata'].get('continue'), 'Unpaginated original collection required')
    return result


def same_deployments(actual, baseline):
    """Allow controller status/RV updates without losing any ownership fence."""
    need(type(actual) is list and type(baseline) is list, 'Complete actual Deployment inventories required')
    def rows(values):
        out = {}
        for value in values:
            meta = value.get('metadata', {}); key = (meta.get('namespace'), meta.get('name'))
            need(value.get('apiVersion') == 'apps/v1' and value.get('kind') == 'Deployment' and key not in out
                and dns(key[0]) and dns(key[1]) and meta.get('uid') and meta.get('resourceVersion')
                and not meta.get('deletionTimestamp') and type(value.get('spec')) is dict, 'Complete nondeleted unique Deployment rows required')
            out[key] = value
        return out
    observed, expected = rows(actual), rows(baseline); need(set(observed) == set(expected), 'Protected Deployment inventory omitted or added a resource')
    for key, before in expected.items():
        after = observed[key]
        need(after['metadata']['uid'] == before['metadata']['uid'] and after['spec'] == before['spec']
            and all(after['metadata'].get(field, {}) == before['metadata'].get(field, {}) for field in ['labels', 'annotations'])
            and after['metadata'].get('generation') == before['metadata'].get('generation'), 'Deployment UID/full spec/guarded metadata changed')
        old_status, status = before.get('status', {}), after.get('status', {})
        for field in ['readyReplicas', 'availableReplicas', 'updatedReplicas']:
            old, new = old_status.get(field, 0), status.get(field, 0)
            need(type(old) is int and type(new) is int and 0 <= old <= new, 'Protected Deployment readiness degraded')
        old, new = old_status.get('unavailableReplicas', 0), status.get('unavailableReplicas', 0)
        need(type(old) is int and type(new) is int and 0 <= new <= old, 'Protected Deployment unavailability increased')
        def condition_rows(value):
            rows = value.get('conditions', []); need(type(rows) is list, 'Original controller conditions required')
            result = {}
            for row in rows:
                need(type(row) is dict and type(row.get('type')) is str and row['type'] not in result
                    and row.get('status') in {'True', 'False', 'Unknown'}, 'Unique actual controller conditions required')
                result[row['type']] = row['status']
            return result
        old_conditions, conditions = condition_rows(old_status), condition_rows(status)
        need(all(conditions.get(k) == 'True' for k, v in old_conditions.items() if k in {'Available', 'Progressing'} and v == 'True'), 'Protected Deployment availability/progress condition degraded')
    return True


def desired(before, claim, source, manifest_sha, map_sha):
    result = copy.deepcopy(selected(before)); pod = result['template']['spec']
    for volume in pod['volumes']:
        if volume['name'] == VOLUME: volume['persistentVolumeClaim']['claimName'] = claim
    result['template']['metadata']['annotations'].update({'lolly.tools/full-root-source': source,
        'lolly.tools/full-root-manifest': manifest_sha, 'lolly.tools/delivery-etags-sha256': map_sha})
    return result


def resources(before, names, node, storage_class, byte_count):
    """Only the NEW root/map backing is exposed to either temporary Pod."""
    selected(before); ns = before['metadata']['namespace']; pod = before['spec']['template']['spec']; web = pod['containers'][0]
    label = {'lolly.tools/public-delivery-stage': names['policy']}
    metadata = lambda name: {'name': name, 'namespace': ns, 'labels': copy.deepcopy(label)}
    size = ((byte_count + 256 * 1024**2 + 1024**3 - 1) // 1024**3) * 1024**3
    claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': metadata(names['claim']),
        'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': storage_class, 'volumeMode': 'Filesystem',
                 'resources': {'requests': {'storage': str(size)}}}}
    policy = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': metadata(names['policy']),
        'spec': {'podSelector': {'matchLabels': label}, 'policyTypes': ['Ingress', 'Egress']}}
    common = {'nodeSelector': {'kubernetes.io/hostname': node}, 'restartPolicy': 'Never',
        'automountServiceAccountToken': False, 'enableServiceLinks': False,
        'securityContext': copy.deepcopy(pod['securityContext']),
        'volumes': [{'name': VOLUME, 'persistentVolumeClaim': {'claimName': names['claim']}}, {'name': 'tmp', 'emptyDir': {}}]}
    need(not common['securityContext'].get('seLinuxOptions', {}).get('level'), 'Temporary Pods cannot reuse an explicitly selected active MCS level')
    need(not web.get('securityContext', {}).get('seLinuxOptions', {}).get('level'),
        'Temporary container cannot inherit an explicitly selected active MCS level')
    writer = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': metadata(names['writer']), 'spec': copy.deepcopy(common)}
    writer['spec']['containers'] = [{'name': 'writer', 'image': web['image'], 'imagePullPolicy': 'Never',
        'command': ['/bin/sh', '-c', 'sleep 3600'],
        'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
        'resources': {'requests': {'cpu': '10m', 'memory': '32Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
        'volumeMounts': [{'name': VOLUME, 'mountPath': a.overlay.ANCHOR}, {'name': 'tmp', 'mountPath': '/tmp'}]}]
    qualifier = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': metadata(names['qualifier']), 'spec': copy.deepcopy(common)}
    native = copy.deepcopy(web); native['imagePullPolicy'] = 'Never'
    native['volumeMounts'] = [v for v in native['volumeMounts'] if v['name'] != 'models']
    qualifier['spec']['containers'] = [native]
    qualifier['spec']['volumes'].append(copy.deepcopy(next(v for v in pod['volumes'] if v['name'] == 'nginx')))
    need(not any(v['name'] == 'models' for v in qualifier['spec']['volumes'] + native['volumeMounts']), 'Active model backing cannot be staged')
    return {'claim': claim, 'policy': policy, 'writer': writer, 'qualifier': qualifier}


def prepare(value, input_ref):
    """Bind physical assembly and source qualification without target access."""
    exact(value, {'version', 'status', 'refs', 'names', 'node', 'storageClass', 'minimumFreeBytes', 'outputDirectory'})
    need(held(input_ref) == value, 'Original preparation input differs')
    exact(value['refs'], REFS); refs = value['refs']; bound = {key: held(ref) for key, ref in refs.items()}
    need(value['version'] == 1 and value['status'] == 'REVIEWED_PUBLIC_FRONTEND_LIFECYCLE_NOT_EXECUTED', 'Explicit frontend-only lifecycle input required')
    before = bound['deployment']; selected(before); baseline = protected(bound['baseline'])
    key = (before['metadata']['namespace'], before['metadata']['name'])
    need(key in baseline and baseline[key] == before, 'Selected owner must belong to complete baseline')
    names = value['names']; exact(names, {'claim', 'writer', 'qualifier', 'policy'})
    need(all(dns(name) for name in names.values()) and len(set(names.values())) == len(names)
         and dns(value['storageClass']) and type(value['node']) is str and re.fullmatch(r'[A-Za-z0-9.-]{1,253}', value['node']), 'Fresh names and selected scheduling node required')
    volume_claims = [v['persistentVolumeClaim']['claimName'] for v in before['spec']['template']['spec']['volumes'] if 'persistentVolumeClaim' in v]
    need(names['claim'] not in volume_claims, 'New claim cannot select active root or model storage')
    for kind in ['pods', 'pvcs', 'policies']:
        need(all(not (r['metadata'].get('namespace') == key[0] and r['metadata']['name'] in names.values())
                 for r in bound['baseline'][kind]['items']), 'Fresh resources cannot adopt an existing name')
    report = bound['assembly']; need(report['version'] == 2 and report['protocol'] == 'PUBLIC_FULL_ROOT_DELIVERY_OVERLAY'
        and report['status'] == 'LOCAL_PHYSICAL_ASSEMBLY_NOT_RUNTIME_ACCEPTANCE' and report['mode'] == 'frontend'
        and report['runtimeQualified'] is False and report['productionMutation'] is False and report['published'] is False
        and report['originalSignedBytesChanged'] is False and report['physicalEpoch'] == report['hardLinkedFiles'] == 0,
        'Actual frontend-only assembly cannot be relabeled runtime acceptance')
    manifest = held(report['manifest']); rows = a.physical(report['root'], manifest, epoch=True)
    output = Path(value['outputDirectory']); root = Path(report['root'])
    need(output.is_absolute() and output.resolve() == output and output.parent.is_dir()
         and output != root and root not in output.parents and output not in root.parents,
         'Preparation output must not overlap assembled static bytes')
    previous = bound['previousManifest']; old = a.overlay.manifest(previous)
    changes = a.tree({path: row for path, row in rows.items() if old.get(path) != row})
    boundary = a.overlay.plan(previous, manifest, manifest, changes, sorted(set(old) - set(rows)))
    need(report['frontendBoundary'] == boundary and report['map'] == rows[a.overlay.MAP], 'Actual full-root boundary/map differs')
    source = bound['qualifiedSource']
    exact(source, {'version', 'status', 'source', 'profile', 'main', 'run', 'jobs', 'requiredJobs'})
    need(source['version'] == 1 and source['status'] == 'ACTUAL_SOURCE_CI_QUALIFIED' and source['profile'] == 'lolly-start'
        and re.fullmatch(r'[a-f0-9]{40}', source['source']), 'Actual qualified public source required')
    main, run, jobs = [held(source[k]) for k in ['main', 'run', 'jobs']]
    need(main['sha'] == source['source'] and run['head_sha'] == source['source'] and run['status'] == 'completed'
        and run['conclusion'] == 'success' and run['head_branch'] == 'main'
        and type(source['requiredJobs']) is list and source['requiredJobs'] and len(set(source['requiredJobs'])) == len(source['requiredJobs']), 'Main/source/run identity must actually qualify')
    job_rows = jobs['jobs']; need(len({r['name'] for r in job_rows}) == len(job_rows)
        and not jobs.get('total_count', len(job_rows)) > len(job_rows), 'Full unique original job inventory required')
    for name in source['requiredJobs']:
        found = [r for r in job_rows if r['name'] == name]
        need(len(found) == 1 and found[0]['status'] == 'completed' and found[0]['conclusion'] == 'success'
             and found[0]['run_id'] == run['id'], 'Every mandatory job must pass on that actual run')
    build = a.verify_candidate_build(report.get('candidateBuild'), physical_bytes=False)
    descriptor = held(build['originalCustody'])
    need(build['source'] == source['source'] and build['profile'] == source['profile'] and descriptor['ci'] == source['run'],
        'Passing CI does not belong to the original candidate build and run custody')
    candidate = a.physical(build['root'], held(build['manifest']))
    expected, retained = a.union(candidate, old); expected[a.overlay.MAP] = report['map']
    need(a.tree(expected) == manifest and retained == report['retained'], 'Assembled bytes do not derive from the original candidate build and retained baseline')
    accepted = bound['acceptedRelease']
    exact(accepted, ACCEPTED_KEYS | ({'publication'} if accepted.get('version') == 2 else set()))
    if accepted['version'] == 2:
        need(accepted == publication_baseline(accepted['publication']), 'Accepted baseline must rederive from original serving custody')
    annotations = before['spec']['template']['metadata']['annotations']; web = before['spec']['template']['spec']['containers'][0]
    need(accepted['version'] in {1, 2} and accepted['status'] == 'ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED'
        and accepted['deploymentUID'] == before['metadata']['uid'] and accepted['deploymentSpecSha256'] == digest(before['spec'])
        and accepted['image'] == web['image'] and accepted['manifestSha256'] == refs['previousManifest']['sha256']
        and accepted['manifestSha256'] == annotations['lolly.tools/full-root-manifest']
        and accepted['mapSha256'] == annotations['lolly.tools/delivery-etags-sha256']
        and accepted['mapSha256'] == old[a.overlay.MAP]['sha256']
        and accepted['models'] == refs['models'] and accepted['configs'] == refs['configs'], 'Genuinely accepted whole-root baseline required')
    pin = held(accepted['publicPin']); exact(pin, {'kty', 'crv', 'x', 'y'})
    need(pin['kty'] == 'EC' and pin['crv'] == 'P-256'
         and all(type(pin[key]) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', pin[key]) for key in ['x', 'y']), 'Public-only P256 pin required')
    owners = [p for p in bound['baseline']['pods']['items'] if p['metadata'].get('uid') == accepted['ownerPodUID']]
    need(len(owners) == 1 and owners[0]['metadata']['namespace'] == key[0]
        and owners[0]['spec']['containers'] == before['spec']['template']['spec']['containers']
        and owners[0]['spec']['volumes'] == before['spec']['template']['spec']['volumes'], 'Accepted active owner must belong to original complete Pod inventory')
    models = bound['models']; exact(models, {'version', 'files'})
    need(models['version'] == 1 and type(models['files']) is list and models['files'], 'Unchanged complete model recipe required')
    configs = bound['configs']; need(type(configs) is list and configs and all(c.get('immutable') is True and c.get('kind') == 'ConfigMap' and c.get('data') and not c.get('binaryData') for c in configs), 'Unchanged immutable native configs required')
    config_name = next(v['configMap']['name'] for v in before['spec']['template']['spec']['volumes'] if v['name'] == 'nginx')
    need(len(configs) == 1 and configs[0]['metadata']['name'] == config_name and configs[0]['metadata']['namespace'] == key[0], 'Exact selected native configuration is required')
    adapter = bound['adapterReview']; exact(adapter, {'version', 'status', 'source', 'sources', 'capabilities', 'stages', 'review'})
    need(adapter['version'] == 1 and adapter['status'] == 'ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER'
        and adapter['capabilities'] == sorted(CAPABILITIES) and adapter['stages'] == STAGES,
        'Reviewed root-only runtime adapter with complete native/retirement/global guards required')
    a.read_ref(adapter['source'])
    review = held(adapter['review']); exact(review, {'version', 'status', 'source', 'sources', 'capabilities', 'stages', 'productionMutation'})
    need(review['version'] == 1 and review['status'] == 'ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE'
        and review['productionMutation'] is False
        and all(review[key] == adapter[key] for key in ['source', 'sources', 'capabilities', 'stages']),
        'Independent root review must bind that exact adapter source and capability closure')
    need(type(adapter['sources']) is list and adapter['sources'] and adapter['source'] in adapter['sources'], 'Complete adapter source closure required')
    for ref in adapter['sources']: a.read_ref(ref)
    need(type(value['minimumFreeBytes']) is int and value['minimumFreeBytes'] >= 8 * 1024**3, 'Conservative target host reserve required')
    want = desired(before, names['claim'], source['source'], report['manifest']['sha256'], report['map']['sha256'])
    rendered = resources(before, names, value['node'], value['storageClass'], manifest['totalBytes'])
    exposure(bound['baseline'], rendered['writer']['metadata']['labels'], key[0])
    return {'version': 1, 'status': 'PUBLIC_FRONTEND_LIFECYCLE_PREPARED_NOT_STAGED', 'refs': refs, 'preparationInput': input_ref,
        'preparer': {'path': str(Path(__file__).resolve()), 'sha256': a.checksum(Path(__file__))},
        'beforeUID': before['metadata']['uid'], 'beforeSpecSha256': digest(before['spec']), 'source': source['source'],
        'manifest': report['manifest'], 'mapSha256': report['map']['sha256'], 'resources': rendered,
        'resourcesSha256': digest(rendered), 'desiredSpec': want, 'desiredSpecSha256': digest(want),
        'protectedDeploymentCount': len(baseline), 'protectedDeploymentsSha256': digest(bound['baseline']['deployments']),
        'modelsMounted': False, 'minimumFreeBytes': value['minimumFreeBytes'], 'maximumWriteBytes': manifest['totalBytes'],
        'runtimeQualified': False, 'published': False, 'productionMutation': False}


def admit(prepared, receipt):
    """Consume truthful adapter receipts; preserve target/publication ownership."""
    need(prepared['status'] == 'PUBLIC_FRONTEND_LIFECYCLE_PREPARED_NOT_STAGED' and prepared['modelsMounted'] is False, 'Unstaged prepared request required')
    # Preparation provenance belongs to the original registered checkout, not
    # this admission caller. Validate it without executing historical code;
    # every other field must still rederive under the current complete guards.
    preparer = prepared['preparer']; exact(preparer, {'path', 'sha256'}); a.read_ref(preparer)
    adapter = held(prepared['refs']['adapterReview'])
    need(Path(preparer['path']).name == Path(__file__).name and preparer in adapter['sources'],
         'Historical preparer is outside its original reviewed source closure')
    derived = prepare(held(prepared['preparationInput']), prepared['preparationInput'])
    need({k: v for k, v in prepared.items() if k != 'preparer'} == {k: v for k, v in derived.items() if k != 'preparer'},
         'Prepared resources and exact patch must rederive from original qualified bytes')
    exact(receipt, {'version', 'status', 'prepared', 'adapter', 'phases', 'native', 'models', 'retirement', 'globalBefore', 'globalAfter'})
    need(receipt['version'] == 1 and receipt['status'] == 'ACTUAL_FRONTEND_ROOT_QUALIFIED_AND_RETIRED'
        and held(receipt['prepared']) == prepared, 'Exact actual prepared/runtime binding required')
    need(receipt['adapter'] == adapter['source'], 'Actual runtime adapter source differs')
    need(type(receipt['phases']) is list and len(receipt['phases']) == len(STAGES), 'All exclusive real stage phases required')
    for name, ref in zip(STAGES, receipt['phases']):
        phase = held(ref); exact(phase, {'version', 'phase', 'status', 'prepared', 'source', 'commands'})
        need(phase['version'] == 1 and phase['phase'] == name and phase['status'] == 'ACTUAL_PHASE_ACCEPTED'
            and phase['prepared'] == receipt['prepared'] and phase['source'] == receipt['adapter']
            and type(phase['commands']) is list and phase['commands'], 'Literal phase source/input/command custody required')
        for command in phase['commands']:
            actual = held(command); need(actual['exitCode'] == 0 and actual.get('failure') is None, 'Failed command cannot qualify a phase')
            for stream in ['stdout', 'stderr']: a.read_ref(actual[stream])
    native = held(receipt['native']); exact(native, {'version', 'source', 'image', 'resourcesSha256', 'manifest', 'mapSha256', 'modelsMounted', 'physical', 'http', 'memory', 'signature'})
    web = prepared['desiredSpec']['template']['spec']['containers'][0]
    need(native['version'] == 1 and native['source'] == prepared['source'] and native['image'] == web['image']
        and native['resourcesSha256'] == prepared['resourcesSha256'] and native['manifest'] == prepared['manifest']
        and native['mapSha256'] == prepared['mapSha256'] and native['modelsMounted'] is False, 'Actual native new root/config/image/map binding required')
    physical = held(native['physical']); exact(physical, {'version', 'manifest', 'epoch', 'hardLinkedFiles', 'allHashesVerified', 'allCodingsDecoded', 'mapRecompiled'})
    need(physical['version'] == 1 and physical['manifest'] == prepared['manifest'] and physical['epoch'] == physical['hardLinkedFiles'] == 0
        and physical['allHashesVerified'] is True and physical['allCodingsDecoded'] is True and physical['mapRecompiled'] is True, 'Full actual physical/decoded/recompiled-map/root metadata proof required')
    http = held(native['http']); checks = {'external8080', 'identityStrongEtag', 'gzipStrongEtag', 'conditional304', 'ifRange206', 'crossCodingMiss', 'privateErrors', 'serviceWorkerNoStore'}
    exact(http, {'version', 'mapSha256', *checks}); need(http['version'] == 1 and http['mapSha256'] == prepared['mapSha256'] and all(http[k] is True for k in checks), 'Complete actual native validator/coding/error HTTP proof required')
    memory = held(native['memory']); exact(memory, {'version', 'podUID', 'limitBytes', 'currentBytes', 'peakBytes', 'oom', 'oomKill', 'rssBytes'})
    limit = re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)', web['resources']['limits']['memory'])
    need(limit and memory['version'] == 1 and type(memory['podUID']) is str and memory['podUID']
        and all(type(memory[k]) is int for k in ['limitBytes', 'currentBytes', 'peakBytes', 'oom', 'oomKill', 'rssBytes'])
        and memory['limitBytes'] == int(limit[1]) * (1024**2 if limit[2] == 'Mi' else 1024**3)
        and 0 < memory['rssBytes'] <= memory['currentBytes'] <= memory['peakBytes'] < memory['limitBytes']
        and memory['oom'] == memory['oomKill'] == 0, 'Actual owning cgroup current/peak/RSS/zeroOOM under unchanged native limit required')
    signature = held(native['signature']); exact(signature, {'version', 'manifest', 'publicPin', 'sourceSignatureVerified', 'fullSignedFileClosureVerified'})
    accepted = held(prepared['refs']['acceptedRelease'])
    need(signature['version'] == 1 and signature['manifest'] == prepared['manifest'] and signature['publicPin'] == accepted['publicPin']
        and signature['sourceSignatureVerified'] is True and signature['fullSignedFileClosureVerified'] is True, 'Actual P256 complete original byte proof required')
    a.read_ref(signature['publicPin'])
    model = held(receipt['models']); exact(model, {'version', 'recipe', 'modelsMounted', 'before', 'after', 'http'})
    need(model['version'] == 1 and model['recipe'] == prepared['refs']['models'] and model['modelsMounted'] is False, 'Active model owner proof must retain original recipe without staging mounts')
    before_model, after_model = held(model['before']), held(model['after'])
    exact(before_model, {'version', 'ownerUID', 'ownerSpecSha256', 'claimUID', 'pvUID', 'recipe', 'allPhysicalHashesVerified'})
    need(before_model == after_model and before_model['version'] == 1 and before_model['recipe'] == prepared['refs']['models']
        and before_model['allPhysicalHashesVerified'] is True and all(type(before_model[k]) is str and before_model[k] for k in ['ownerUID', 'claimUID', 'pvUID'])
        and sha(before_model['ownerSpecSha256']), 'Exact unchanged active model owner/PVC/PV/full hashes required')
    deployment = held(prepared['refs']['deployment']); baseline = held(prepared['refs']['baseline'])
    model_claim_name = next(v['persistentVolumeClaim']['claimName'] for v in deployment['spec']['template']['spec']['volumes'] if v['name'] == 'models')
    claims = [r for r in baseline['pvcs']['items'] if r['metadata'].get('namespace') == deployment['metadata']['namespace'] and r['metadata']['name'] == model_claim_name]
    need(len(claims) == 1 and claims[0]['metadata']['uid'] == before_model['claimUID'], 'Active model claim identity differs')
    pvs = [r for r in baseline['pvs']['items'] if r['metadata']['name'] == claims[0]['spec']['volumeName']]
    owners = [r for r in baseline['pods']['items'] if r['metadata']['uid'] == accepted['ownerPodUID']]
    need(len(pvs) == len(owners) == 1 and pvs[0]['metadata']['uid'] == before_model['pvUID']
        and before_model['ownerUID'] == accepted['ownerPodUID'] and before_model['ownerSpecSha256'] == digest(owners[0]['spec']), 'Active model owner/backing differs from accepted full baseline')
    model_http = held(model['http']); exact(model_http, {'version', 'recipe', 'normalTLS', 'allModels', 'strongValidators', 'rangeAndIfRange', 'strict416', 'strictCors', 'privateErrors'})
    need(model_http['version'] == 1 and model_http['recipe'] == prepared['refs']['models'] and all(model_http[k] is True for k in set(model_http) - {'version', 'recipe'}), 'Normal owning HTTP complete model boundary proof required')
    old = held(prepared['refs']['baseline'])['deployments']
    for key in ['globalBefore', 'globalAfter']:
        global_proof = held(receipt[key]); exact(global_proof, {'version', 'deployments', 'globalStorageAndPodsVerified', 'sourceRootIdentityDACMCSUnchanged'})
        need(global_proof['version'] == 1 and same_deployments(global_proof['deployments'], old)
             and global_proof['globalStorageAndPodsVerified'] is True and global_proof['sourceRootIdentityDACMCSUnchanged'] is True,
             'Entire protected Deployment set and actual global storage/source roots must stay unchanged')
    retired = held(receipt['retirement']); exact(retired, {'version', 'podUID', 'policyAbsent', 'podAbsent', 'writerAbsent', 'globalClaimConsumersAbsent', 'mountsReleased', 'createdClaimRetained', 'resourcesSha256'})
    need(retired['version'] == 1 and retired['podUID'] == memory['podUID'] and retired['resourcesSha256'] == prepared['resourcesSha256']
         and all(retired[k] is True for k in set(retired) - {'version', 'podUID', 'resourcesSha256'}), 'Exact actual native/writer/policy/global/mount retirement required')
    before = held(prepared['refs']['deployment']); meta = before['metadata']
    return {'version': 1, 'status': 'FRONTEND_ROOT_RETIRED_PATCH_PREPARED_NOT_PUBLISHED', 'runtimeReceipt': receipt,
        'patch': [{'op': 'test', 'path': '/metadata/uid', 'value': meta['uid']},
                  {'op': 'test', 'path': '/metadata/resourceVersion', 'value': meta['resourceVersion']},
                  {'op': 'test', 'path': '/spec', 'value': before['spec']},
                  {'op': 'replace', 'path': '/spec', 'value': prepared['desiredSpec']}],
        'freshGuardAndPreflightRequiredBeforePublication': True, 'productionMutation': False, 'published': False}


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('action', choices=['prepare', 'admit'])
    p.add_argument('--input', required=True); p.add_argument('--input-sha256', required=True); p.add_argument('--operator-sha256', required=True)
    args = p.parse_args()
    need(a.checksum(Path(__file__)) == args.operator_sha256, 'Reviewed lifecycle source changed')
    value = held({'path': args.input, 'sha256': args.input_sha256})
    if args.action == 'prepare':
        result = prepare(value, {'path': args.input, 'sha256': args.input_sha256}); output = Path(value['outputDirectory'])
        need(output.is_absolute() and output.resolve() == output and output.parent.is_dir() and not output.exists(), 'New exclusive preparation directory required')
        output.mkdir(mode=0o700); ref = a.write_new(output / 'lifecycle.prepared.json', raw(result) + b'\n')
    else:
        exact(value, {'version', 'prepared', 'runtimeReceipt', 'outputFile'}); need(value['version'] == 1, 'Closed actual admission input required')
        result = admit(held(value['prepared']), held(value['runtimeReceipt'])); output = Path(value['outputFile'])
        need(output.is_absolute() and output.resolve() == output and output.parent.is_dir() and not output.exists(), 'New exclusive patch file required')
        ref = a.write_new(output, raw(result) + b'\n')
    print(raw({'result': ref, 'productionMutation': False, 'published': False}).decode())


if __name__ == '__main__':
    try: main()
    except Exception as error: print('Public delivery lifecycle refused: ' + str(error), file=sys.stderr); raise SystemExit(1)
