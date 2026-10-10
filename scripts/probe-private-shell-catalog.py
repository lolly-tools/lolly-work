#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Maintained read-only caller-catalogue probe; imports and --check stay offline.

The publisher owns phase serialization and target preflight. This adapter only
reads the exact current owner and borrows the accepted 300-second memory session
inside that owner. It never writes a database, document, invitation, or cookie.
"""
from __future__ import annotations

import argparse
import base64
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PROFILE = 'NORMAL_TLS_PER_CALLER_INDEX_ORACLE_AND_PINNED_P256_ENVELOPE'
ORACLE_FILES = (
    'server/src/catalog/signing.ts', 'server/src/policy/overlay.ts',
    'server/src/store/postgres.ts', 'server/src/iam/sessions.ts',
    'server/src/iam/tokens.ts', 'server/src/lib/crypto.ts',
)
LIMIT = 32 * 1024**2
INPUT_KEYS = {'version', 'status', 'profile', 'source', 'instanceProfile', 'prepared',
              'plan', 'planningEvidence', 'baseline', 'sourceFiles', 'preflightReceiptPath'}
CONTEXT_KEYS = {'version', 'status', 'publicationInputSha256', 'planSha256', 'sources', 'image',
                'owner', 'ownerEvidence', 'contentEvidence', 'selection', 'mounts', 'baseURL',
                'publicPin', 'qualifiedCatalog', 'shellManifest', 'packManifest', 'enginePin', 'resolverPin'}

class Refusal(RuntimeError):
    """Never include raw runtime errors, headers or credentials in a refusal."""


def need(value):
    if not value:
        raise Refusal('Reviewed catalogue input, owner or cryptographic proof refused')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys))


def parse(data):
    def pairs(rows):
        out = {}
        for key, value in rows:
            need(key not in out)
            out[key] = value
        return out
    need(type(data) is bytes and len(data) <= LIMIT)
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: need(False))


def stamp(value):
    return value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def frozen(ref):
    exact(ref, {'path', 'sha256'})
    need(type(ref['path']) is str and type(ref['sha256']) is str
         and re.fullmatch('[a-f0-9]{64}', ref['sha256']))
    path = Path(ref['path'])
    need(path.is_absolute() and path.resolve(strict=True) == path)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o022 and before.st_size <= LIMIT)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        need(stamp(os.fstat(fd)) == stamp(before))
        data = bytearray()
        while True:
            block = os.read(fd, 1024**2)
            if not block:
                break
            data.extend(block)
            need(len(data) <= before.st_size)
        need(len(data) == before.st_size and stamp(os.fstat(fd)) == stamp(before)
             == stamp(path.lstat()) and sha(data) == ref['sha256'])
        return bytes(data)
    finally:
        os.close(fd)


def referenced(path):
    path = Path(path).absolute()
    need(path.resolve(strict=True) == path)
    return {'path': str(path), 'sha256': sha(path.read_bytes())}


def json_ref(ref):
    return parse(frozen(ref))


def choose(rows, name):
    need(type(rows) is list and all(type(row) is dict and type(row.get('name')) is str for row in rows)
         and len({row['name'] for row in rows}) == len(rows))
    found = [row for row in rows if row['name'] == name]
    need(len(found) == 1)
    return found[0]


def load_helper(ref, name):
    frozen(ref)
    spec = importlib.util.spec_from_file_location(name, ref['path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



def source_bindings(source_map):
    need(type(source_map) is dict and 1 <= len(source_map) <= 10000)
    for path, row in source_map.items():
        exact(row, {'sha256', 'bytes', 'mode', 'gitBlob'} | ({'linkTarget'} if row.get('mode') == 'symlink' else set()))
        need(type(path) is str and path and not path.startswith('/') and '..' not in path.split('/')
             and not any(part in ('', '.') for part in path.split('/')) and '\0' not in path
             and re.fullmatch('[a-f0-9]{64}', row['sha256']) and type(row['bytes']) is int and 0 <= row['bytes'] <= 16 * 1024**2
             and row['mode'] in {'0644', '0755', 'symlink'}
             and (row['gitBlob'] is None or re.fullmatch('[a-f0-9]{40}', row['gitBlob'])))
        if row['mode'] == 'symlink':
            need(type(row['linkTarget']) is str and row['bytes'] == len(row['linkTarget'].encode())
                 and sha(row['linkTarget'].encode()) == row['sha256'])
    need(all(path in source_map and source_map[path]['mode'] in {'0644', '0755'} for path in ORACLE_FILES))
    # The native stage guards the whole image source map. Borrowing a session
    # rechecks every owned server module, including the oracle's dependencies.
    return {path: row for path, row in source_map.items() if path.startswith('server/src/')}


def derive(value):
    """Reconstruct held preparation and plan; importing this module is inert."""
    exact(value, INPUT_KEYS)
    need(type(value['version']) is int and value['version'] == 1
         and value['status'] == 'REVIEWED_MAINTAINED_PRIVATE_CATALOG_PROBE_INPUT' and value['profile'] == PROFILE
         and value['source'] == referenced(__file__))
    refs = value['sourceFiles']
    need(type(refs) is list and 1 <= len(refs) <= 150 and len({r['path'] for r in refs}) == len(refs))
    need(all(value[key] in refs for key in ('source', 'instanceProfile', 'prepared', 'plan', 'planningEvidence', 'baseline')))
    identities = {}
    for ref in refs:
        identity_stamp = stamp(Path(ref['path']).lstat()); frozen(ref)
        need(stamp(Path(ref['path']).lstat()) == identity_stamp)
        identities[ref['path']] = identity_stamp
    facade_ref = choose_refs(refs, HERE / 'update-private-shell.py')
    facade = load_helper(facade_ref, 'catalog_update_facade')
    operation = facade.Update(value['instanceProfile']['path'], value['instanceProfile']['sha256'],
                              value['prepared']['path'], value['prepared']['sha256'], facade_ref['sha256'])
    policy = operation.profile.get('authenticatedCatalog')
    need(policy is not None and policy['source'] == value['source'])
    for ref in operation.sources:
        need(ref in refs)
    evidence = json_ref(value['planningEvidence'])
    need(evidence['prepared'] == value['prepared'] and evidence['previous'] == operation.profile['previous']
         and evidence['mounts'] == operation.profile['mounts'])
    expected_plan, held = facade.planner.plan(evidence, Path(value['planningEvidence']['path']).parent)
    expected_plan['evidence'].append(value['planningEvidence']); expected_plan['evidence'].sort(key=lambda r: r['path'])
    plan = json_ref(value['plan']); need(plan == expected_plan)
    held.unchanged()
    baseline = json_ref(value['baseline']); exact(baseline, {'version', 'deployments', 'owner', 'replicaSet'})
    need(type(baseline['version']) is int and baseline['version'] == 1 and type(baseline['deployments']) is dict
         and set(baseline['deployments']) == set(operation.target['components']))
    previous_owner = {'deployment': baseline['deployments']['work'], 'pod': baseline['owner'], 'replicaSet': baseline['replicaSet']}
    original = operation.inputs.file(operation.inputs.file(operation.previous['acceptance'])['originalEvidence'][0])
    need(previous_owner['deployment']['spec'] == operation.before['spec']
         and previous_owner['deployment']['metadata']['uid'] == operation.before['metadata']['uid']
         and previous_owner['pod']['metadata']['uid'] == original['podUid']
         and sha(canonical(previous_owner['pod']['spec'])) == original['podSpecSha256']
         and previous_owner['replicaSet']['metadata']['uid'] == original['replicaSetUid'])
    facade.publisher.Publication.chain(previous_owner['pod'], previous_owner['replicaSet'], previous_owner['deployment'])
    pod_spec = copy.deepcopy(previous_owner['pod']['spec'])
    selection = operation.prepared['selection']
    choose(pod_spec['volumes'], selection['shellVolume'])['persistentVolumeClaim']['claimName'] = selection['shellClaim']
    source_map = source_bindings(operation.inputs.file(operation.profile['sourceMap']))
    pin = operation.inputs.file(operation.previous['enginePin'])
    need(pin['generatedFrom'] == operation.prepared['sources']['engine'])
    urls = operation.target['components']['work'].get('healthURLs'); need(type(urls) is list and urls)
    url = urlsplit(urls[0]); need(url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.fragment)
    receipt = Path(value['preflightReceiptPath'])
    need(receipt.is_absolute() and receipt.parent == Path(value['plan']['path']).parent
         and receipt.name == 'catalog.preflight.original.json' and receipt.parent.resolve(strict=True) == receipt.parent)
    operation.source_check()
    return {'input': value, 'operation': operation, 'prepared': operation.prepared, 'previous': operation.previous,
            'previousOwner': previous_owner, 'desiredSpec': plan['desiredSpec'], 'podSpec': pod_spec,
            'target': operation.target, 'updater': facade.updater, 'publisher': facade.publisher, 'policy': policy, 'files': source_map,
            'heldPlanInputs': held, 'identities': identities,
            'migrations': operation.inputs.file(policy['migrations']), 'pin': pin,
            'sourceBindingSha256': sha(canonical(source_map)), 'mounts': operation.profile['mounts'],
            'baseURL': url.scheme + '://' + url.netloc + '/', 'refs': {'shellManifest': operation.shell['manifest'],
                'packManifest': operation.pack['manifest'], 'enginePin': operation.previous['enginePin'],
                'resolverPin': operation.previous['resolverPin'], 'publicPin': operation.profile['publicKey']}}


def choose_refs(refs, path):
    found = [ref for ref in refs if ref['path'] == str(path)]
    need(len(found) == 1)
    return found[0]


def identity(resource, api, kind, namespace=None):
    need(type(resource) is dict and resource.get('apiVersion') == api and resource.get('kind') == kind)
    meta = resource.get('metadata', {})
    need(type(meta) is dict and all(type(meta.get(k)) is str and 0 < len(meta[k]) <= 253
                                  for k in ('name', 'uid', 'resourceVersion'))
         and not meta.get('deletionTimestamp') and meta.get('namespace') == namespace)
    return meta


def owner_valid(owner, prepared):
    exact(owner, {'deployment', 'pod', 'replicaSet'})
    target, expected = prepared['target'], prepared['desiredSpec']
    component = target['components']['work']
    ns = component['namespace']
    deployment, pod, rs = [owner[k] for k in ('deployment', 'pod', 'replicaSet')]
    d = identity(deployment, 'apps/v1', 'Deployment', ns)
    p = identity(pod, 'v1', 'Pod', ns)
    r = identity(rs, 'apps/v1', 'ReplicaSet', ns)
    need(d['uid'] == component['deploymentUID'] and d['name'] == component['deployment']
         and deployment['spec'] == expected and pod['spec'] == prepared['podSpec']
         and pod['spec']['nodeName'] == target['node']['name']
         and p.get('annotations', {}) == expected['template']['metadata'].get('annotations', {}))
    need(deployment.get('status', {}).get('readyReplicas') == 1
         and deployment['status'].get('observedGeneration', 0) >= d.get('generation', 1))
    for child, parent, kind in ((pod, rs, 'ReplicaSet'), (rs, deployment, 'Deployment')):
        refs = [row for row in child['metadata'].get('ownerReferences', []) if row.get('controller') is True]
        need(len(refs) == 1 and refs[0].get('apiVersion') == 'apps/v1' and refs[0].get('kind') == kind
             and refs[0].get('uid') == parent['metadata']['uid'] and refs[0].get('name') == parent['metadata']['name'])
    pod_hash = p.get('labels', {}).get('pod-template-hash')
    need(type(pod_hash) is str and re.fullmatch('[a-z0-9]{1,32}', pod_hash))
    labels = copy.deepcopy(expected['template']['metadata'].get('labels', {}))
    labels['pod-template-hash'] = pod_hash
    need(p.get('labels') == labels and r.get('labels') == labels)
    rs_spec = copy.deepcopy(prepared['previousOwner']['replicaSet']['spec'])
    rs_spec['selector']['matchLabels']['pod-template-hash'] = pod_hash
    rs_spec['template'] = copy.deepcopy(expected['template'])
    rs_spec['template']['metadata']['labels'] = labels
    need(rs['spec'] == rs_spec)
    selected = prepared['prepared']['selection']['container']
    state = choose(pod.get('status', {}).get('containerStatuses', []), selected)
    need(len(pod['status']['containerStatuses']) == 1 and state.get('ready') is True
         and type(state.get('restartCount')) is int and state['restartCount'] == 0
         and state.get('imageID', '').endswith(prepared['prepared']['image'].split('@')[1])
         and state.get('image') == choose(prepared['previousOwner']['pod']['status']['containerStatuses'], selected)['image']
         and type(state.get('state', {}).get('running', {}).get('startedAt')) is str
         and pod['status'].get('phase') == 'Running'
         and any(row.get('type') == 'Ready' and row.get('status') == 'True' for row in pod['status'].get('conditions', [])))
    started = datetime.fromisoformat(state['state']['running']['startedAt'].replace('Z', '+00:00'))
    need(started.tzinfo is not None and started <= datetime.now(timezone.utc))
    return state['state']['running']['startedAt']


def context_valid(context, prepared):
    exact(context, CONTEXT_KEYS)
    value = prepared['input']
    need(type(context['version']) is int and context['version'] == 1
         and context['status'] == 'ACTUAL_PRIVATE_SHELL_AUTHENTICATED_CATALOG_CONTEXT'
         and context['baseURL'] == prepared['baseURL']
         and context['sources'] == prepared['prepared']['sources'] and context['image'] == prepared['prepared']['image']
         and context['selection'] == prepared['prepared']['selection'] and context['mounts'] == prepared['mounts']
         and context['publicPin'] == json_ref(prepared['refs']['publicPin']))
    need(context['planSha256'] == value['plan']['sha256'])
    for key in ('planSha256', 'publicationInputSha256'):
        need(type(context[key]) is str and re.fullmatch('[a-f0-9]{64}', context[key]))
    for key in ('shellManifest', 'packManifest', 'enginePin', 'resolverPin'):
        need(context[key] == prepared['refs'][key])
    owner = json_ref(context['ownerEvidence'])
    need(owner == context['owner'])
    started = owner_valid(owner, prepared)
    content = json_ref(context['contentEvidence'])
    exact(content, {'version', 'shell', 'pack', 'pinSha256', 'catalog'})
    need(type(content['version']) is int and content['version'] == 1
         and content['pinSha256'] == prepared['prepared']['enginePinSha256']
         and content['shell'] == json_ref(prepared['refs']['shellManifest'])
         and content['pack'] == json_ref(prepared['refs']['packManifest']))
    # The context supplies the prepared identity tuple. Mounted content adds
    # independently verified pin/signature results; neither schema may borrow
    # keys from the other, and every identity/proof field remains exact.
    exact(context['qualifiedCatalog'], {'indexSha256', 'envelopeSha256', 'keyId', 'signedFiles'})
    need(context['qualifiedCatalog'] == prepared['prepared']['catalog']
         and type(context['qualifiedCatalog']['signedFiles']) is int and context['qualifiedCatalog']['signedFiles'] > 0
         and all(type(context['qualifiedCatalog'][key]) is str and re.fullmatch('[a-f0-9]{64}', context['qualifiedCatalog'][key]) for key in ('indexSha256', 'envelopeSha256')))
    exact(content['catalog'], {'indexSha256', 'envelopeSha256', 'keyId', 'signedFiles',
                               'publicPinSha256', 'signatureVerified'})
    catalog = content['catalog']
    need(catalog['signatureVerified'] is True and catalog['keyId'] == prepared['prepared']['catalog']['keyId']
         and catalog['publicPinSha256'] == sha(canonical(context['publicPin']))
         and type(catalog['signedFiles']) is int and catalog['signedFiles'] == prepared['prepared']['catalog']['signedFiles']
         and catalog['indexSha256'] == prepared['prepared']['catalog']['indexSha256']
         and catalog['envelopeSha256'] == prepared['prepared']['catalog']['envelopeSha256'])
    return started



def normalize(raw, context, prepared, input_ref):
    oracle_keys = {'indexSha256', 'envelopeSha256', 'indexBytes', 'envelopeBytes', 'expectedIndexSha256',
                   'expectedFileMapSha256', 'signedFiles', 'publicPinSha256', 'keyId', 'signedAt',
                   'signatureVerified', 'exactPerCallerIndexBytes', 'exactVisibleFileMap', 'sourceBindingSha256'}
    flags = {'cookiePrinted': False, 'cookiePersisted': False, 'cookieTtlSeconds': 300,
             'databaseDirectWrites': False, 'redirectsFollowed': False, 'certificateRequired': True,
             'hostnameVerified': True, 'envelopeByteEqualityToPreparedClaimed': False}
    exact(raw, {'version', 'status', 'sessionOrigin', *oracle_keys, *flags})
    need(type(raw['version']) is int and raw['version'] == 1
         and raw['status'] == 'AUTHENTICATED_NORMAL_TLS_PER_CALLER_CATALOG_VERIFIED'
         and raw['sessionOrigin'] == 'MAINTAINED_OWNING_NODE_OWNER_AND_MIGRATION_LOOKUP'
         and all(type(raw[k]) is type(v) and raw[k] == v for k, v in flags.items())
         and raw['sourceBindingSha256'] == prepared['sourceBindingSha256'])
    oracle = {k: raw[k] for k in oracle_keys}
    for key in oracle_keys & {'indexSha256', 'envelopeSha256', 'expectedIndexSha256', 'expectedFileMapSha256', 'sourceBindingSha256'}:
        need(type(oracle[key]) is str and re.fullmatch('[a-f0-9]{64}', oracle[key]))
    need(oracle['indexSha256'] == oracle['expectedIndexSha256']
         and oracle['publicPinSha256'] == sha(canonical(context['publicPin']))
         and oracle['keyId'] == context['qualifiedCatalog']['keyId']
         and all(oracle[k] is True for k in ('signatureVerified', 'exactPerCallerIndexBytes', 'exactVisibleFileMap')))
    for key in ('indexBytes', 'envelopeBytes', 'signedFiles'):
        need(type(oracle[key]) is int and 0 < oracle[key] <= 2 * 1024**2)
    need(oracle['signedFiles'] <= context['qualifiedCatalog']['signedFiles'])
    signed = datetime.fromisoformat(oracle['signedAt'].replace('Z', '+00:00'))
    started = datetime.fromisoformat(owner_valid(context['owner'], prepared).replace('Z', '+00:00'))
    need(signed.tzinfo is not None and started.timestamp() - 60 <= signed.timestamp()
         <= datetime.now(timezone.utc).timestamp() + 60)
    return {'version': 1, 'status': 'AUTHENTICATED_PRIVATE_SHELL_CATALOG_PROBE_ACCEPTED',
            'contextSha256': sha(canonical(context)), 'inputSha256': input_ref['sha256'],
            'sourceSha256': prepared['input']['source']['sha256'], 'profile': PROFILE,
            'probes': [{'path': path, 'url': context['baseURL'] + path, 'status': 200,
                        'verifiedTlsAndHostname': True, 'authentication': 'TEMPORARY_MEMORY_SESSION',
                        'bytes': oracle[prefix + 'Bytes'], 'sha256': oracle[prefix + 'Sha256'], 'oracle': PROFILE}
                       for path, prefix in [('catalog/tools/index.json', 'index'), ('catalog/tools/index.sig.json', 'envelope')]],
            'oracle': oracle, 'tls': {'certificateRequired': True, 'hostnameVerified': True, 'redirectsFollowed': False},
            'scope': {'databaseDirectWrites': False, 'documentWrites': False, 'invitationWrites': False,
                      'cookiePrinted': False, 'cookiePersisted': False, 'maximumSessionSeconds': 300}}


def live_owner(prepared, context, kube):
    target = prepared['target']
    kube_system = kube.get('namespace', 'kube-system')
    need(identity(kube_system, 'v1', 'Namespace')['uid'] == target['clusterUID'])
    node = kube.get('node', target['node']['name'])
    need(identity(node, 'v1', 'Node')['uid'] == target['node']['uid']
         and any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in node.get('status', {}).get('conditions', [])))
    component = target['components']['work']
    ns = kube.get('namespace', component['namespace'])
    need(identity(ns, 'v1', 'Namespace')['uid'] == component['namespaceUID'])
    wanted = context['owner']
    current = {'deployment': kube.get('deployment', wanted['deployment']['metadata']['name'], component['namespace']),
               'pod': kube.get('pod', wanted['pod']['metadata']['name'], component['namespace']),
               'replicaSet': kube.get('replicaset', wanted['replicaSet']['metadata']['name'], component['namespace'])}
    owner_valid(current, prepared)
    for key in current:
        need(current[key]['spec'] == wanted[key]['spec']
             and all(current[key]['metadata'].get(field, {}) == wanted[key]['metadata'].get(field, {})
                     for field in ('uid', 'name', 'namespace', 'annotations', 'labels', 'ownerReferences')))
    a = choose(current['pod']['status']['containerStatuses'], prepared['prepared']['selection']['container'])
    b = choose(wanted['pod']['status']['containerStatuses'], prepared['prepared']['selection']['container'])
    need(a['state']['running']['startedAt'] == b['state']['running']['startedAt'])


def node_program(prepared, started):
    """The exact CommonJS executor contains only non-secret held inputs."""
    mounts = prepared['mounts']
    data = {'pinSha256': prepared['prepared']['enginePinSha256'], 'pin': prepared['pin'],
            'pinPath': mounts['pinPath'], 'files': prepared['files'], 'migrations': prepared['migrations'],
            'caller': prepared['policy']['caller'], 'shellPath': mounts['shellPath'], 'packPath': mounts['packPath'],
            'publicJwk': json_ref(prepared['refs']['publicPin']), 'notBefore': started,
            'baseURL': prepared['baseURL'], 'sourceBindingSha256': prepared['sourceBindingSha256']}
    url = 'data:text/javascript;base64,' + base64.b64encode(frozen(prepared['policy']['module'])).decode()
    return ('(async()=>{const input=' + canonical(data).decode() + ';const auth=await import(' + json.dumps(url) + ');'
            'await auth.bootstrap({input,borrow:()=>auth.borrow(input)});})().catch(()=>{'
            'console.log(JSON.stringify({status:"REFUSED",rawErrorsSuppressed:true}));process.exitCode=1;});\n')


def syntax_check(code, node):
    need(type(code) is str and 0 < len(code.encode()) < 120000)
    version = subprocess.run([node['path'], '--version'], capture_output=True, timeout=30, check=False)
    need(version.returncode == 0 and version.stdout == (node['version'] + '\n').encode() and version.stderr == b'')
    result = subprocess.run([node['path'], '--input-type=commonjs', '--check'], input=code.encode(), capture_output=True, timeout=30, check=False)
    need(result.returncode == 0 and result.stdout == b'' and result.stderr == b'')
    return {'version': 1, 'status': 'COMPLETE_COMMONJS_NODE24_PROGRAM_SYNTAX_CHECKED_NOT_EXECUTED',
            'nodeVersion': node['version'], 'programSha256': sha(code.encode()), 'programExecuted': False, 'productionCalls': False}


def final_preflight(prepared):
    """Keep the original guard; execute no further target read before Node exec."""
    guard = prepared['operation'].profile['preflight']
    frozen(guard['source']); path = Path(prepared['input']['preflightReceiptPath'])
    need(not path.exists() and not path.parent.stat().st_mode & 0o077)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        result = subprocess.run(guard['argv'], stdin=subprocess.DEVNULL, capture_output=True, timeout=120, check=False)
        need(type(result.stdout) is bytes and type(result.stderr) is bytes)
        record = {'version': 1, 'source': guard['source'], 'argv': guard['argv'], 'returncode': result.returncode,
                  'stdout': result.stdout[:LIMIT].decode(errors='replace'), 'stderr': result.stderr[:LIMIT].decode(errors='replace'),
                  'complete': len(result.stdout) <= LIMIT and len(result.stderr) <= LIMIT}
        with os.fdopen(fd, 'wb') as stream:
            fd = None; stream.write(canonical(record) + b'\n'); stream.flush(); os.fsync(stream.fileno())
        need(record['complete'] and result.returncode == 0 and result.stderr == b'')
    finally:
        if fd is not None: os.close(fd)


def source_check(prepared, input_ref):
    for path, identity_stamp in prepared['identities'].items():
        file = Path(path)
        need(file.resolve(strict=True) == file and stamp(file.lstat()) == identity_stamp)
    frozen(input_ref); prepared['operation'].source_check(); prepared['heldPlanInputs'].unchanged()


def execute(prepared, context, input_ref, kube):
    started = context_valid(context, prepared)
    code = node_program(prepared, started); syntax_check(code, prepared['policy']['node'])
    live_owner(prepared, context, kube); source_check(prepared, input_ref)
    component = prepared['target']['components']['work']
    final_preflight(prepared)
    source_check(prepared, input_ref)
    result = kube.run(['exec', context['owner']['pod']['metadata']['name'], '--namespace', component['namespace'],
                       '--container', prepared['prepared']['selection']['container'], '--', 'node', '-e', code], timeout=290)
    need(type(result) is str and 0 < len(result.encode()) <= 32768)
    report = normalize(parse(result.encode()), context, prepared, input_ref)
    live_owner(prepared, context, kube); source_check(prepared, input_ref)
    prepared['publisher'].authenticated_catalog_report(report, context,
        {'source': prepared['input']['source'], 'input': input_ref, 'profile': PROFILE},
        context['qualifiedCatalog'], context['publicPin'])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True); parser.add_argument('--input-sha256', required=True)
    parser.add_argument('--check', action='store_true', help='Offline custody and complete CommonJS syntax only')
    args = parser.parse_args(); input_ref = {'path': args.input, 'sha256': args.input_sha256}
    prepared = derive(json_ref(input_ref))
    if args.check:
        report = syntax_check(node_program(prepared, '2000-01-01T00:00:00Z'), prepared['policy']['node'])
        report.update({'input': input_ref, 'source': prepared['input']['source'], 'runtimeQualified': False})
    else:
        context = parse(sys.stdin.buffer.read(LIMIT + 1))
        report = execute(prepared, context, input_ref, prepared['updater'].Kubectl(prepared['target']['transport']))
    print(canonical(report).decode())


if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"status":"REFUSED","rawErrorsSuppressed":true}'); sys.exit(1)
