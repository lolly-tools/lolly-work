#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Pure full-root placement and exact rollback; no qualification or mutation.

Matched image/config/model admission stays with the maintained full-cohort
preparer and publisher. This leaf derives only the additional complete static
root and paired-map mount. A later application-only update changes that claim
and its source/manifest annotations; every other field remains byte-equivalent.
"""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location('full_root_overlay', Path(__file__).with_name('public-delivery-overlay.py'))
overlay = importlib.util.module_from_spec(spec); spec.loader.exec_module(overlay)
need = overlay.need
VOLUME = 'public-delivery'
KEYS = {'lolly.tools/full-root-source', 'lolly.tools/full-root-manifest', 'lolly.tools/delivery-etags-sha256'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def deployment(value):
    meta = value.get('metadata', {})
    need(value.get('apiVersion') == 'apps/v1' and value.get('kind') == 'Deployment'
         and meta.get('namespace') == 'lolly-public' and meta.get('name') == 'sovereign-web'
         and type(meta.get('uid')) is str and meta['uid'] and type(meta.get('resourceVersion')) is str
         and meta['resourceVersion'] and not meta.get('deletionTimestamp'), 'Actual public owner UID/RV required')
    selected = value['spec']; pod = selected['template']['spec']
    need(selected['replicas'] == 1 and selected['strategy']['type'] == 'Recreate'
         and len(pod['containers']) == 1 and pod['containers'][0]['name'] == 'web'
         and not set(pod['containers'][0]) & {'env', 'envFrom', 'lifecycle', 'volumeDevices'}
         and not pod.get('initContainers') and not pod.get('ephemeralContainers'), 'One credential-free public owner required')
    security = pod['securityContext']
    need(security['runAsUser'] == security['runAsGroup'] == security['fsGroup'] == 101
         and security['fsGroupChangePolicy'] == 'OnRootMismatch', 'Preserve serial UID/GID101 root handoff')
    return selected


def full_root_spec(selected, claim, source, manifest_sha, map_sha):
    """Place a previously reviewed full matched spec on one new static claim."""
    need(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', claim or '')
         and re.fullmatch('[a-f0-9]{40}', source or '')
         and all(re.fullmatch('[a-f0-9]{64}', value or '') for value in [manifest_sha, map_sha]),
         'Exact fresh claim/source/content identifiers required')
    desired = copy.deepcopy(selected); pod = desired['template']['spec']; web = pod['containers'][0]
    need(web['name'] == 'web' and len(pod['containers']) == 1, 'Selected public web container required')
    volumes = {value['name']: value for value in pod['volumes']}
    need(len(volumes) == len(pod['volumes']), 'Duplicate selected volume')
    models = [value for value in web['volumeMounts'] if value['name'] == 'models']
    need(len(models) == 2 and models[0] == {'name': 'models', 'mountPath': '/run/lolly-public-models', 'readOnly': True}
         and models[1].get('mountPath') == '/usr/share/nginx/html/models'
         and models[1].get('readOnly') is True and re.fullmatch('models-[a-f0-9]{64}', models[1].get('subPath', '')),
         'Reviewed model whole-volume anchor and exact RO child required')
    removed_names = {'validator-map', 'retained-static', VOLUME}
    allowed = {'tmp', 'nginx', 'models', *removed_names}
    need(set(volumes) <= allowed and {'tmp', 'nginx', 'models'} <= set(volumes)
         and all(value['name'] in allowed for value in web['volumeMounts']), 'Unexpected selected public mount')
    need(not any(value['mountPath'] == overlay.ROOT for value in web['volumeMounts'] if value['name'] != VOLUME),
         'Unreviewed existing root mask')
    ordinary = [value for value in web['volumeMounts'] if value['name'] not in removed_names and value['name'] != 'models']
    web['volumeMounts'] = ordinary + overlay.overlay_mounts(VOLUME) + models
    pod['volumes'] = [value for value in pod['volumes'] if value['name'] not in removed_names]
    pod['volumes'].append({'name': VOLUME, 'persistentVolumeClaim': {'claimName': claim}})
    annotations = desired['template']['metadata'].setdefault('annotations', {})
    annotations.update({'lolly.tools/full-root-source': source, 'lolly.tools/full-root-manifest': manifest_sha,
                        'lolly.tools/delivery-etags-sha256': map_sha})
    annotations.pop('lolly.tools/retained-static-inventory-sha256', None)
    return desired


def frontend_spec(before, claim, source, manifest_sha, map_sha):
    """Change only the selected full-root claim and three owning annotations."""
    selected = deployment(before); pod = selected['template']['spec']; web = pod['containers'][0]
    need([value for value in web['volumeMounts'] if value['name'] == VOLUME] == overlay.overlay_mounts(VOLUME),
         'Full-root baseline must be genuinely bootstrapped before a fast update')
    need(not any(value['name'] in {'public-shell', 'validator-map', 'retained-static'} for value in pod['volumes']),
         'Five-path, standalone-map or fallback baseline cannot enter fast lane')
    desired = full_root_spec(selected, claim, source, manifest_sha, map_sha)
    reverted = copy.deepcopy(desired)
    reverted['template']['spec']['volumes'] = copy.deepcopy(selected['template']['spec']['volumes'])
    reverted['template']['spec']['containers'][0]['volumeMounts'] = copy.deepcopy(web['volumeMounts'])
    reverted['template']['metadata'] = copy.deepcopy(selected['template']['metadata'])
    need(reverted == selected, 'Application update changes an unselected Deployment field')
    need(desired['template']['spec']['containers'][0]['volumeMounts'] == web['volumeMounts'], 'Application mount ordering changed')
    changed = [index for index, value in enumerate(pod['volumes']) if value['name'] == VOLUME]
    need(len(changed) == 1, 'One owning full-root volume required')
    index = changed[0]
    # Preserve the original volume order too: a claim update never reorders resources.
    desired['template']['spec']['volumes'] = copy.deepcopy(pod['volumes'])
    desired['template']['spec']['volumes'][index]['persistentVolumeClaim']['claimName'] = claim
    need(set(desired['template']['metadata']['annotations']) == set(selected['template']['metadata']['annotations'])
         and all(desired['template']['metadata']['annotations'][key] == value
                 for key, value in selected['template']['metadata']['annotations'].items() if key not in KEYS),
         'Application update altered unrelated source/config/catalog/generation provenance')
    return desired


def guarded_patch(before, desired):
    selected = deployment(before); meta = before['metadata']
    return [{'op': 'test', 'path': '/metadata/uid', 'value': meta['uid']},
            {'op': 'test', 'path': '/metadata/resourceVersion', 'value': meta['resourceVersion']},
            {'op': 'test', 'path': '/spec', 'value': selected}, {'op': 'replace', 'path': '/spec', 'value': desired}]


def rollback(after, before, desired):
    need(deployment(after) == desired and after['metadata']['uid'] == before['metadata']['uid'],
         'Rollback requires exact actual owning after-spec and original UID')
    return guarded_patch(after, deployment(before))


def proposal(before, desired):
    deployment(before)
    return {'version': 2, 'protocol': 'PUBLIC_FULL_ROOT_DELIVERY_OVERLAY',
            'beforeSpecSha256': digest(before['spec']), 'desiredSpecSha256': digest(desired),
            'deploymentUID': before['metadata']['uid'], 'patch': guarded_patch(before, desired),
            'rollbackRequiresActualAfterUIDRVAndExactSpec': True,
            'runtimeQualified': False, 'productionMutation': False, 'published': False}


def qualified_patch(before, desired, qualification, expected):
    """Require the actual retired new-root oracle before returning a publish patch.

    The maintained publisher must bind this record to its original executable,
    input, command originals and retired UID/claim proof; this structural gate
    is not a replacement for that custody or the fresh all13/target guards.
    """
    need(type(qualification) is dict and set(qualification) == {'version', 'status', 'source', 'image',
         'manifestSha256', 'mapSha256', 'memory', 'http', 'retirement'}, 'Closed new-root qualification required')
    need(type(expected) is dict and set(expected) == {'source', 'image', 'manifestSha256', 'mapSha256'}
         and qualification['version'] == 2
         and qualification['status'] == 'ACTUAL_PUBLIC_FULL_ROOT_NATIVE_QUALIFIED_AND_RETIRED'
         and all(qualification[key] == value for key, value in expected.items()), 'Exact new public root qualification required')
    pod = desired['template']['spec']; web = pod['containers'][0]
    memory = qualification['memory']
    need(type(memory) is dict and set(memory) == {'limitBytes', 'currentBytes', 'peakBytes', 'zeroOom', 'ownerBound'}
         and all(type(memory[key]) is int and memory[key] > 0 for key in ['limitBytes', 'currentBytes', 'peakBytes'])
         and memory['currentBytes'] <= memory['peakBytes'] < memory['limitBytes']
         and memory['zeroOom'] is True and memory['ownerBound'] is True, 'Actual new-map peak below its exact limit and zero OOM required')
    configured = web['resources']['limits']['memory']
    match = re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)', configured)
    need(match and int(match[1]) * (1024**2 if match[2] == 'Mi' else 1024**3) == memory['limitBytes'], 'Actual measured and selected memory limits differ')
    need(web['image'] == expected['image'] and desired['template']['metadata']['annotations']['lolly.tools/full-root-source'] == expected['source']
         and desired['template']['metadata']['annotations']['lolly.tools/full-root-manifest'] == expected['manifestSha256']
         and desired['template']['metadata']['annotations']['lolly.tools/delivery-etags-sha256'] == expected['mapSha256'], 'Selected root/map tuple differs from native oracle')
    http = qualification['http']
    checks = {'external8080', 'allPhysicalHashes', 'allCodingDecodes', 'identityStrongEtag', 'gzipStrongEtag',
              'conditional304', 'ifRange206', 'crossCodingMiss', 'privateErrors', 'strictModelsCors', 'strictRange416', 'models177'}
    need(type(http) is dict and set(http) == checks and all(http[key] is True for key in checks), 'Complete new-map/model native HTTP oracle required')
    retirement = qualification['retirement']
    need(type(retirement) is dict and set(retirement) == {'podUID', 'podAbsent', 'policyAbsent', 'mountsReleased', 'globalClaimConsumersAbsent'}
         and type(retirement['podUID']) is str and bool(retirement['podUID'])
         and all(retirement[key] is True for key in retirement if key != 'podUID'), 'Actual native qualifier retirement required')
    return guarded_patch(before, desired)


def stage_resources(names, node, writer_image, content_bytes):
    """Render one NEW claim and a credential-free writer; never adopt resources.

    The maintained staging guard still requires literal preflight last before
    allocation/write/delete, all13 owners, complete global claim/PV/Pod/host
    mount inventories, unique empty backing and actual UID/RV bindings. These
    resource declarations supply none of those proofs by themselves.
    """
    need(type(names) is dict and set(names) == {'claim', 'writer', 'policy'}
         and len(set(names.values())) == 3
         and all(type(value) is str and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', value) for value in names.values())
         and type(node) is str and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', node)
         and type(writer_image) is str and re.fullmatch(r'[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}', writer_image)
         and type(content_bytes) is int and 0 < content_bytes <= overlay.MAX_BYTES,
         'Exact exclusive resource names, node, imported image and byte bound required')
    label = {'lolly.tools/public-delivery-stage': names['policy']}
    metadata = lambda name: {'name': name, 'namespace': 'lolly-public', 'labels': copy.deepcopy(label)}
    capacity = ((content_bytes + 256 * 1024**2 + 1024**3 - 1) // 1024**3) * 1024**3
    claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': metadata(names['claim']),
        'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': 'local-path', 'volumeMode': 'Filesystem',
                 'resources': {'requests': {'storage': str(capacity)}}}}
    policy = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': metadata(names['policy']),
        'spec': {'podSelector': {'matchLabels': copy.deepcopy(label)}, 'policyTypes': ['Ingress', 'Egress'], 'ingress': [], 'egress': []}}
    pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': metadata(names['writer']),
        'spec': {'nodeName': node, 'restartPolicy': 'Never', 'automountServiceAccountToken': False,
            'securityContext': {'runAsUser': 101, 'runAsGroup': 101, 'runAsNonRoot': True, 'fsGroup': 101,
                'fsGroupChangePolicy': 'OnRootMismatch', 'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{'name': 'writer', 'image': writer_image, 'imagePullPolicy': 'Never',
                'command': ['/bin/sh', '-c', 'sleep 3600'],
                'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                    'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '10m', 'memory': '32Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi'}},
                'volumeMounts': [{'name': VOLUME, 'mountPath': overlay.ANCHOR}, {'name': 'tmp', 'mountPath': '/tmp'}]}],
            'volumes': [{'name': VOLUME, 'persistentVolumeClaim': {'claimName': names['claim']}}, {'name': 'tmp', 'emptyDir': {}}]}}
    return {'claim': claim, 'policy': policy, 'writer': pod}
