# SPDX-License-Identifier: MPL-2.0
"""Synthetic adapter custody controls; these tests never qualify a cluster."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('lifecycle', SCRIPTS / 'public-delivery-lifecycle.py')
l = importlib.util.module_from_spec(spec); spec.loader.exec_module(l)
spec = importlib.util.spec_from_file_location('placement', SCRIPTS / 'plan-public-delivery-root.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
NODE = Path(os.environ.get('LOLLY_TEST_NODE', shutil.which('node') or '/missing/node')).resolve()


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.base = Path(self.temp.name).resolve(); self.counter = 0
        self.checkout = self.base / 'clean-source'; self.checkout.mkdir()
        module = self.checkout / 'engine/compiled.ts'; module.parent.mkdir(); module.write_bytes(b'export const compiled = 1;\n')
        env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        for args in [['init', '--quiet', '--initial-branch=main'], ['add', 'engine/compiled.ts'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Unit fixture source']]:
            subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=self.checkout, env=env, capture_output=True, check=True)
        self.source = l.a.build_contract.cohort.git_command(['git', 'rev-parse', 'HEAD'], self.checkout)
        self.ci_run = self.put({'id': 42, 'head_sha': self.source, 'head_branch': 'main', 'status': 'completed', 'conclusion': 'success'})
        self.image = 'registry.example/native-web@sha256:' + '7' * 64
        data = {path: b'old shell' for path in l.a.overlay.FIXED}
        data.update({'_app/old.js': b'old immutable', 'catalog/tools/index.sig.json': b'unchanged signed envelope', l.a.overlay.MAP: b'old map'})
        self.previous = self.tree(self.base / 'old', data)
        data['index.html'] = b'new shell'; data['_app/new.js'] = b'new module'
        candidate = self.tree(self.base / 'candidate', data)
        self.models = self.put({'version': 1, 'files': [{'url': '/models/ocr/model.onnx', 'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}]})
        self.candidate_build = self.public_build(self.base / 'candidate', candidate)
        self.assembly = l.a.assemble(str(self.base / 'candidate'), str(self.base / 'old'), candidate, self.previous,
            l.held(self.models)['files'], self.base / 'assembly', SCRIPTS / 'public-delivery-map.mjs',
            {'path': str(NODE), 'sha256': l.a.checksum(NODE)}, mode='frontend', candidate_custody=self.candidate_build)
        previous_ref = self.put(self.previous)
        mounts = [{'name': 'tmp', 'mountPath': '/tmp'}, {'name': 'nginx', 'mountPath': '/etc/nginx/conf.d/default.conf', 'subPath': 'default.conf', 'readOnly': True}]
        mounts += l.a.overlay.overlay_mounts('public-delivery')
        mounts += [{'name': 'models', 'mountPath': '/run/lolly-public-models', 'readOnly': True}, {'name': 'models', 'mountPath': '/usr/share/nginx/html/models', 'subPath': 'models-' + '9' * 64, 'readOnly': True}]
        old_map_sha = l.a.overlay.manifest(self.previous)[l.a.overlay.MAP]['sha256']
        self.before = {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'my-native-site', 'namespace': 'customer-apps', 'uid': 'web-owner', 'resourceVersion': '27'},
            'spec': {'replicas': 1, 'strategy': {'type': 'Recreate'}, 'selector': {'matchLabels': {'app': 'web'}},
                'template': {'metadata': {'labels': {'app': 'web'}, 'annotations': {'checksum/config': 'fixed', 'lolly.tools/catalog-index-sha256': 'original-catalog',
                    'lolly.tools/full-root-source': 'a' * 40, 'lolly.tools/full-root-manifest': previous_ref['sha256'], 'lolly.tools/delivery-etags-sha256': old_map_sha}},
                    'spec': {'automountServiceAccountToken': False, 'securityContext': {'runAsUser': 101, 'runAsGroup': 101, 'fsGroup': 101, 'fsGroupChangePolicy': 'OnRootMismatch'},
                        'volumes': [{'name': 'tmp', 'emptyDir': {}}, {'name': 'nginx', 'configMap': {'name': 'qualified-nginx'}}, {'name': 'models', 'persistentVolumeClaim': {'claimName': 'active-models'}}, {'name': 'public-delivery', 'persistentVolumeClaim': {'claimName': 'active-site'}}],
                        'containers': [{'name': 'native', 'image': self.image, 'resources': {'requests': {'memory': '32Mi'}, 'limits': {'memory': '512Mi'}},
                            'securityContext': {'readOnlyRootFilesystem': True, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}}, 'volumeMounts': mounts}]}}}}
        self.owner = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'current-native', 'namespace': 'customer-apps', 'uid': 'current-owner'}, 'spec': copy.deepcopy(self.before['spec']['template']['spec'])}
        other = copy.deepcopy(self.before); other['metadata'] = {'name': 'unrelated', 'namespace': 'other-team', 'uid': 'unrelated-owner', 'resourceVersion': '29'}
        collection = lambda rows: {'apiVersion': 'v1', 'kind': 'List', 'metadata': {'resourceVersion': '', 'continue': ''}, 'items': rows}
        self.baseline = {'version': 1, 'deployments': [self.before, other], 'pods': collection([self.owner]),
            'pvcs': collection([{'metadata': {'name': 'active-models', 'namespace': 'customer-apps', 'uid': 'model-claim'}, 'spec': {'volumeName': 'model-pv'}}]),
            'pvs': collection([{'metadata': {'name': 'model-pv', 'uid': 'model-pv-uid'}}]), 'services': collection([]), 'policies': collection([])}
        configs = self.put([{'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'qualified-nginx', 'namespace': 'customer-apps', 'uid': 'config'}, 'immutable': True, 'data': {'default.conf': 'native config'}}])
        self.pin = self.put({'kty': 'EC', 'crv': 'P-256', 'x': 'A' * 43, 'y': 'B' * 43})
        accepted = {'version': 1, 'status': 'ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED', 'deploymentUID': 'web-owner', 'deploymentSpecSha256': l.digest(self.before['spec']),
            'ownerPodUID': 'current-owner', 'image': self.image, 'manifestSha256': previous_ref['sha256'], 'mapSha256': old_map_sha, 'models': self.models, 'configs': configs, 'publicPin': self.pin}
        source = {'version': 1, 'status': 'ACTUAL_SOURCE_CI_QUALIFIED', 'source': self.source, 'profile': 'lolly-start', 'main': self.put({'sha': self.source}),
            'run': self.ci_run,
            'jobs': self.put({'jobs': [{'name': 'source', 'run_id': 42, 'status': 'completed', 'conclusion': 'success'}], 'total_count': 1}), 'requiredJobs': ['source']}
        self.adapter_source = self.put({'synthetic': 'unit-test-only adapter fixture'})
        review = {'version': 1, 'status': 'ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE', 'source': self.adapter_source, 'sources': [self.adapter_source],
            'capabilities': sorted(l.CAPABILITIES), 'stages': l.STAGES, 'productionMutation': False}
        adapter = {'version': 1, 'status': 'ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER', 'source': self.adapter_source, 'sources': [self.adapter_source],
            'capabilities': sorted(l.CAPABILITIES), 'stages': l.STAGES, 'review': self.put(review)}
        self.value = {'version': 1, 'status': 'REVIEWED_PUBLIC_FRONTEND_LIFECYCLE_NOT_EXECUTED',
            'refs': {'deployment': self.put(self.before), 'baseline': self.put(self.baseline), 'assembly': self.assembly, 'previousManifest': previous_ref,
                'models': self.models, 'configs': configs, 'qualifiedSource': self.put(source), 'acceptedRelease': self.put(accepted), 'adapterReview': self.put(adapter)},
            'names': {'claim': 'new-site', 'writer': 'new-writer', 'qualifier': 'new-qualifier', 'policy': 'new-deny'}, 'node': 'customer-node',
            'storageClass': 'local-path', 'minimumFreeBytes': 8 * 1024**3, 'outputDirectory': str(self.base / 'prepared')}
        self.input = self.put(self.value); self.prepared = l.prepare(self.value, self.input)

    def tearDown(self): self.temp.cleanup()

    def put(self, value):
        self.counter += 1; return l.a.write_new(self.base / ('evidence-' + str(self.counter) + '.json'), l.raw(value))

    def public_build(self, root, manifest, source=None):
        # Synthetic source/report custody exercises the exact maintained schema;
        # it is not an actual producer, provider or runtime acceptance receipt.
        source = source or self.source
        sources = [{'path': str(SCRIPTS / name), 'sha256': l.a.checksum(SCRIPTS / name)} for name in sorted(l.a.build_contract.PRODUCER_SOURCES)]
        module = self.checkout / 'engine/compiled.ts'; data = module.read_bytes()
        graph = self.put({'version': 1, 'source': str(self.checkout), 'guardIncludesWorkerGraph': True, 'normalCIQualified': False, 'productionAuthority': False,
            'modules': [{'path': str(module), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]})
        runner = self.put({'source': str(self.checkout), 'sourceCommit': source, 'output': str(root), 'prerequisites': str(self.base), 'moduleReceipt': graph['path']})
        report = self.put({'exitCode': 0, 'signal': None, 'error': None, 'command': [str(NODE), str(SCRIPTS / 'shell-update-vite.mjs'), runner['path'], runner['sha256']]})
        original = self.put({'scope': 'synthetic original custody only'}); manifest_ref = self.put(manifest)
        descriptor = {key: None for key in l.a.build_contract.PRODUCER_KEYS}
        descriptor.update({'version': 1, 'status': 'LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED', 'artifactClass': 'public-shell-overlay',
            'lollySource': source, 'profile': 'lolly-start', 'candidate': {'root': str(root), 'manifest': manifest_ref}, 'producerSourceFiles': sources,
            'producer': next(ref for ref in sources if Path(ref['path']).name == 'prepare-public-shell-update.ts'), 'originalReport': report, 'workspaceModules': graph,
            'catalog': {'previous': original, 'candidate': original, 'signatureReused': True, 'newSigning': False},
            **dict.fromkeys(['originAuthenticatedByThisCommand', 'normalCIQualified', 'runtimeQualified', 'promotionAttempted'], False),
            **dict.fromkeys(['classification', 'imageClassification', 'custody', 'previousAcceptance', 'ci', 'publicKey', 'retention', 'webGate'], original)})
        descriptor['ci'] = self.ci_run
        return {'root': str(root), 'manifest': manifest_ref, 'originalCustody': self.put(descriptor)}

    def tree(self, root, data):
        root.mkdir(); rows = {}
        for path, body in data.items():
            target = root / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(body)
            rows[path] = {'path': path, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        return l.a.tree(rows)

    def receipt(self):
        prepared_ref = self.put(self.prepared)
        phases = [self.put({'version': 1, 'phase': phase, 'status': 'ACTUAL_PHASE_ACCEPTED', 'prepared': prepared_ref,
            'source': self.adapter_source, 'commands': [self.put({'exitCode': 0, 'failure': None, 'stdout': self.put({}), 'stderr': self.put({})})]}) for phase in l.STAGES]
        physical = self.put({'version': 1, 'manifest': self.prepared['manifest'], 'epoch': 0, 'hardLinkedFiles': 0, 'allHashesVerified': True, 'allCodingsDecoded': True, 'mapRecompiled': True})
        http = self.put({'version': 1, 'mapSha256': self.prepared['mapSha256'], **dict.fromkeys(['external8080', 'identityStrongEtag', 'gzipStrongEtag', 'conditional304', 'ifRange206', 'crossCodingMiss', 'privateErrors', 'serviceWorkerNoStore'], True)})
        memory = self.put({'version': 1, 'podUID': 'qualifier-uid', 'limitBytes': 512 * 1024**2, 'currentBytes': 80 * 1024**2, 'peakBytes': 90 * 1024**2, 'oom': 0, 'oomKill': 0, 'rssBytes': 60 * 1024**2})
        signature = self.put({'version': 1, 'manifest': self.prepared['manifest'], 'publicPin': self.pin, 'sourceSignatureVerified': True, 'fullSignedFileClosureVerified': True})
        native = self.put({'version': 1, 'source': self.prepared['source'], 'image': self.image, 'resourcesSha256': self.prepared['resourcesSha256'], 'manifest': self.prepared['manifest'], 'mapSha256': self.prepared['mapSha256'], 'modelsMounted': False, 'physical': physical, 'http': http, 'memory': memory, 'signature': signature})
        owner = self.put({'version': 1, 'ownerUID': 'current-owner', 'ownerSpecSha256': l.digest(self.owner['spec']), 'claimUID': 'model-claim', 'pvUID': 'model-pv-uid', 'recipe': self.models, 'allPhysicalHashesVerified': True})
        model_http = self.put({'version': 1, 'recipe': self.models, **dict.fromkeys(['normalTLS', 'allModels', 'strongValidators', 'rangeAndIfRange', 'strict416', 'strictCors', 'privateErrors'], True)})
        model = self.put({'version': 1, 'recipe': self.models, 'modelsMounted': False, 'before': owner, 'after': owner, 'http': model_http})
        global_proof = self.put({'version': 1, 'deployments': self.baseline['deployments'], 'globalStorageAndPodsVerified': True, 'sourceRootIdentityDACMCSUnchanged': True})
        retirement = self.put({'version': 1, 'podUID': 'qualifier-uid', 'resourcesSha256': self.prepared['resourcesSha256'], **dict.fromkeys(['policyAbsent', 'podAbsent', 'writerAbsent', 'globalClaimConsumersAbsent', 'mountsReleased', 'createdClaimRetained'], True)})
        return {'version': 1, 'status': 'ACTUAL_FRONTEND_ROOT_QUALIFIED_AND_RETIRED', 'prepared': prepared_ref, 'adapter': self.adapter_source, 'phases': phases, 'native': native, 'models': model, 'retirement': retirement, 'globalBefore': global_proof, 'globalAfter': global_proof}

    def changed(self, receipt, ref_key, change):
        value = l.held(receipt[ref_key]); change(value); receipt[ref_key] = self.put(value)

    def test_nonproduction_target_root_only_resources_and_scheduled_allocation(self):
        rendered = self.prepared['resources']
        for name in ['writer', 'qualifier']:
            pod = rendered[name]; self.assertEqual(pod['metadata']['namespace'], 'customer-apps')
            self.assertEqual(pod['spec']['nodeSelector'], {'kubernetes.io/hostname': 'customer-node'})
            self.assertNotIn('nodeName', pod['spec'])
            self.assertNotIn('models', [v['name'] for v in pod['spec']['volumes']])
            self.assertFalse(pod['spec']['automountServiceAccountToken'])
        native = rendered['qualifier']['spec']['containers'][0]
        self.assertEqual(native['image'], self.image); self.assertEqual(native['resources'], self.before['spec']['template']['spec']['containers'][0]['resources'])
        self.assertNotIn('models', [v['name'] for v in native['volumeMounts']])
        self.assertEqual(self.prepared['protectedDeploymentCount'], 2)

    def test_exact_patch_keeps_models_configs_image_catalog_and_unrelated_annotations(self):
        admitted = l.admit(self.prepared, self.receipt()); result = admitted['patch'][-1]['value']; old = self.before['spec']
        self.assertEqual(admitted['patch'][:3], [{'op': 'test', 'path': '/metadata/uid', 'value': 'web-owner'}, {'op': 'test', 'path': '/metadata/resourceVersion', 'value': '27'}, {'op': 'test', 'path': '/spec', 'value': old}])
        result['template']['spec']['volumes'] = old['template']['spec']['volumes']
        result['template']['metadata']['annotations'] = old['template']['metadata']['annotations']
        self.assertEqual(result, old); self.assertFalse(admitted['published']); self.assertFalse(admitted['productionMutation'])

    def test_tampered_desired_resources_cannot_pass_with_matching_tampered_receipt(self):
        prepared = copy.deepcopy(self.prepared); prepared['desiredSpec']['template']['spec']['containers'][0]['image'] = 'evil@sha256:' + '8' * 64
        with self.assertRaises(l.a.Refusal): l.admit(prepared, self.receipt())

    def test_active_model_or_old_root_cannot_be_new_claim(self):
        for name in ['active-models', 'active-site']:
            value = copy.deepcopy(self.value); value['names']['claim'] = name
            with self.subTest(name=name), self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))

    def test_current_resource_adoption_and_empty_mandatory_jobs_refused(self):
        value = copy.deepcopy(self.value); baseline = copy.deepcopy(self.baseline)
        baseline['pods']['items'].append({'metadata': {'name': 'new-writer', 'namespace': 'customer-apps', 'uid': 'someone-else'}})
        value['refs']['baseline'] = self.put(baseline)
        with self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))
        value = copy.deepcopy(self.value); source = l.held(value['refs']['qualifiedSource']); source['requiredJobs'] = []
        value['refs']['qualifiedSource'] = self.put(source)
        with self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))

    def test_existing_service_and_additive_policy_cannot_expose_stage(self):
        for kind, row in [('services', {'metadata': {'name': 'public', 'namespace': 'customer-apps'}, 'spec': {'selector': {'lolly.tools/public-delivery-stage': 'new-deny'}}}),
                          ('policies', {'metadata': {'name': 'open', 'namespace': 'customer-apps'}, 'spec': {'podSelector': {}, 'ingress': [{}]}})]:
            value = copy.deepcopy(self.value); baseline = copy.deepcopy(self.baseline); baseline[kind]['items'].append(row)
            value['refs']['baseline'] = self.put(baseline)
            with self.subTest(kind=kind), self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))

    def test_missing_phase_and_original_failed_command_refused(self):
        receipt = self.receipt(); receipt['phases'].pop()
        with self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)
        receipt = self.receipt(); phase = l.held(receipt['phases'][0]); command = l.held(phase['commands'][0]); command['exitCode'] = 1
        phase['commands'][0] = self.put(command); receipt['phases'][0] = self.put(phase)
        with self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_native_model_mount_or_wrong_map_rejected(self):
        for key, wrong in [('modelsMounted', True), ('mapSha256', 'f' * 64)]:
            receipt = self.receipt(); self.changed(receipt, 'native', lambda v: v.update({key: wrong}))
            with self.subTest(key=key), self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_peak_at_limit_oom_and_wrong_public_pin_rejected(self):
        for key, wrong in [('peakBytes', 512 * 1024**2), ('oomKill', 1)]:
            receipt = self.receipt(); native = l.held(receipt['native']); memory = l.held(native['memory']); memory[key] = wrong
            native['memory'] = self.put(memory); receipt['native'] = self.put(native)
            with self.subTest(key=key), self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)
        receipt = self.receipt(); native = l.held(receipt['native']); signature = l.held(native['signature']); signature['publicPin'] = self.put({'unrelated': 'pin'})
        native['signature'] = self.put(signature); receipt['native'] = self.put(native)
        with self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_unrelated_deployment_change_or_omission_rejected(self):
        for change in ['omission', 'mutation']:
            receipt = self.receipt(); global_proof = l.held(receipt['globalAfter'])
            if change == 'omission': global_proof['deployments'].pop()
            else: global_proof['deployments'][1]['spec']['replicas'] = 2
            receipt['globalAfter'] = self.put(global_proof)
            with self.subTest(change=change), self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_controller_status_rv_drift_preserves_full_semantic_fences(self):
        actual = copy.deepcopy(self.baseline['deployments']); actual[0]['metadata']['resourceVersion'] = '31'
        actual[0]['status'] = {'readyReplicas': 1, 'availableReplicas': 1, 'updatedReplicas': 1, 'conditions': [{'type': 'Available', 'status': 'True'}]}
        self.assertTrue(l.same_deployments(actual, self.baseline['deployments']))
        for field, value in [('uid', 'replaced'), ('deletionTimestamp', '2026-10-12T01:00:00Z'), ('labels', {'unreviewed': 'new'}), ('annotations', {'unreviewed': 'new'})]:
            changed = copy.deepcopy(actual); changed[0]['metadata'][field] = value
            with self.subTest(field=field), self.assertRaises(l.a.Refusal): l.same_deployments(changed, self.baseline['deployments'])
        for status in [{'readyReplicas': 0, 'availableReplicas': 0}, {'readyReplicas': 1, 'availableReplicas': 1, 'unavailableReplicas': 1}, {'readyReplicas': 1, 'availableReplicas': 1, 'conditions': [{'type': 'Available', 'status': 'False'}]}]:
            changed = copy.deepcopy(actual); changed[0]['status'] = status
            with self.subTest(status=status), self.assertRaises(l.a.Refusal): l.same_deployments(changed, actual)

    def test_model_backing_owner_or_http_range_drift_rejected(self):
        for key, wrong in [('claimUID', 'other-claim'), ('ownerUID', 'other-owner')]:
            receipt = self.receipt(); model = l.held(receipt['models']); owner = l.held(model['before']); owner[key] = wrong
            model['before'] = model['after'] = self.put(owner); receipt['models'] = self.put(model)
            with self.subTest(key=key), self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)
        receipt = self.receipt(); model = l.held(receipt['models']); http = l.held(model['http']); http['strict416'] = False
        model['http'] = self.put(http); receipt['models'] = self.put(model)
        with self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_mount_release_or_replaced_qualifier_uid_rejected(self):
        for key, wrong in [('mountsReleased', False), ('podUID', 'other-qualifier')]:
            receipt = self.receipt(); self.changed(receipt, 'retirement', lambda v: v.update({key: wrong}))
            with self.subTest(key=key), self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)

    def test_changed_original_stdout_or_symlink_custody_rejected(self):
        receipt = self.receipt(); phase = l.held(receipt['phases'][0]); command = l.held(phase['commands'][0])
        Path(command['stdout']['path']).write_bytes(b'changed original')
        with self.assertRaises(l.a.Refusal): l.admit(self.prepared, receipt)
        alias = self.base / 'alias'; alias.symlink_to(self.input['path'])
        with self.assertRaises(l.a.Refusal): l.held({'path': str(alias), 'sha256': self.input['sha256']})

    def test_exact_cli_constructor_writes_preparation_only_and_refuses_changed_source(self):
        source = SCRIPTS / 'public-delivery-lifecycle.py'
        argv = [sys.executable, '-B', str(source), 'prepare', '--input', self.input['path'], '--input-sha256', self.input['sha256'], '--operator-sha256', l.a.checksum(source)]
        result = subprocess.run(argv, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        report = json.loads(result.stdout); prepared = l.held(report['result'])
        self.assertEqual(prepared, self.prepared); self.assertFalse(report['productionMutation']); self.assertFalse(report['published'])
        wrong = list(argv); wrong[-1] = '0' * 64
        result = subprocess.run(wrong, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1); self.assertIn(b'Reviewed lifecycle source changed', result.stderr)

    def test_active_mcs_and_incomplete_adapter_review_refused(self):
        before = copy.deepcopy(self.before); before['spec']['template']['spec']['securityContext']['seLinuxOptions'] = {'level': 's0:c1,c2'}
        with self.assertRaises(l.a.Refusal): l.resources(before, self.value['names'], 'customer-node', 'local-path', 3000)
        before = copy.deepcopy(self.before)
        before['spec']['template']['spec']['containers'][0]['securityContext']['seLinuxOptions'] = {'level': 's0:c1,c2'}
        with self.assertRaises(l.a.Refusal): l.resources(before, self.value['names'], 'customer-node', 'local-path', 3000)
        value = copy.deepcopy(self.value); adapter = l.held(value['refs']['adapterReview']); review = l.held(adapter['review']); review['sources'] = []
        adapter['review'] = self.put(review); value['refs']['adapterReview'] = self.put(adapter)
        with self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))

    def test_deny_policy_matches_api_empty_omission_and_rejects_access_changes(self):
        spec = importlib.util.spec_from_file_location('policy_stage', SCRIPTS / 'stage-private-shell.py')
        private = importlib.util.module_from_spec(spec); spec.loader.exec_module(private)
        desired = self.prepared['resources']['policy']; actual = copy.deepcopy(desired)
        actual['metadata'].update({'uid': 'owned-deny-policy', 'resourceVersion': '1'})
        self.assertNotIn('ingress', desired['spec']); self.assertNotIn('egress', desired['spec'])
        self.assertEqual(desired['spec']['policyTypes'], ['Ingress', 'Egress'])
        self.assertEqual(private.validate_create(actual, desired), actual)
        changes = [{'policyTypes': ['Ingress']}, {'ingress': [{}]}, {'egress': [{}]}, {'podSelector': {'matchLabels': {'unreviewed': 'all'}}}]
        for change in changes:
            changed = copy.deepcopy(actual); changed['spec'].update(change)
            with self.subTest(change=change), self.assertRaises(RuntimeError): private.validate_create(changed, desired)

    def test_coherent_passing_ci_for_an_unrelated_source_cannot_label_original_build(self):
        value = copy.deepcopy(self.value); source = l.held(value['refs']['qualifiedSource']); source['source'] = 'd' * 40
        main, run = l.held(source['main']), l.held(source['run']); main['sha'] = source['source']; run['head_sha'] = source['source']
        source['main'], source['run'] = self.put(main), self.put(run); value['refs']['qualifiedSource'] = self.put(source)
        with self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))

    def test_candidate_descriptor_and_original_manifest_are_held_and_revalidated(self):
        report = l.held(self.assembly); build = report['candidateBuild']; descriptor = l.held(build['originalCustody'])
        changed = copy.deepcopy(build); changed['source'] = 'd' * 40
        with self.assertRaises(l.a.Refusal): l.a.verify_candidate_build(changed)
        changed = copy.deepcopy(build); changed['manifest'] = self.put(self.previous)
        with self.assertRaises(l.a.Refusal): l.a.verify_candidate_build(changed)
        changed = copy.deepcopy(descriptor); changed['profile'] = 'private-brand'
        binding = {key: build[key] for key in ['root', 'manifest', 'originalCustody']}; binding['originalCustody'] = self.put(changed)
        with self.assertRaises(l.a.Refusal): l.a.candidate_build(binding)
        Path(build['originalCustody']['path']).write_bytes(l.raw({**descriptor, 'lollySource': 'd' * 40}))
        with self.assertRaises(l.a.Refusal): l.a.verify_candidate_build(build)

    def test_compiled_modules_must_match_clean_exact_immutable_checkout(self):
        build = l.held(self.assembly)['candidateBuild']; binding = {key: build[key] for key in ['root', 'manifest', 'originalCustody']}
        descriptor = l.held(binding['originalCustody']); graph = l.held(descriptor['workspaceModules'])
        (self.base / 'outside.ts').write_bytes(b'outside immutable checkout')
        for change in ['wrong-hash', 'escaped-module', 'empty-graph']:
            altered = copy.deepcopy(graph)
            if change == 'wrong-hash': altered['modules'][0]['sha256'] = '0' * 64
            elif change == 'escaped-module': altered['modules'][0]['path'] = str(self.base / 'outside.ts')
            else: altered['modules'] = []
            value = copy.deepcopy(descriptor); value['workspaceModules'] = self.put(altered)
            runner_ref = l.held(descriptor['originalReport'])['command'][2:]; runner = l.held({'path': runner_ref[0], 'sha256': runner_ref[1]})
            runner['moduleReceipt'] = value['workspaceModules']['path']; runner = self.put(runner)
            report = l.held(descriptor['originalReport']); report['command'][2:] = [runner['path'], runner['sha256']]
            value['originalReport'] = self.put(report)
            with self.subTest(change=change), self.assertRaises(l.a.Refusal): l.a.candidate_build({**binding, 'originalCustody': self.put(value)})
        module = self.checkout / 'engine/compiled.ts'; original = module.read_bytes(); module.write_bytes(b'dirty source')
        with self.assertRaises(l.a.Refusal): l.a.verify_candidate_build(build)
        module.write_bytes(original)
        nested = self.checkout / 'engine'; value = copy.deepcopy(descriptor)
        runner_ref = l.held(value['originalReport'])['command'][2:]; runner = l.held({'path': runner_ref[0], 'sha256': runner_ref[1]}); runner['source'] = str(nested)
        altered_graph = copy.deepcopy(graph); altered_graph['source'] = str(nested); value['workspaceModules'] = self.put(altered_graph)
        runner['moduleReceipt'] = value['workspaceModules']['path']; runner = self.put(runner)
        report = l.held(value['originalReport']); report['command'][2:] = [runner['path'], runner['sha256']]; value['originalReport'] = self.put(report)
        with self.assertRaises(l.a.Refusal): l.a.candidate_build({**binding, 'originalCustody': self.put(value)})

    def test_local_git_replacement_cannot_change_compiled_blob_identity(self):
        build = l.held(self.assembly)['candidateBuild']; descriptor = l.held(build['originalCustody'])
        graph = l.held(descriptor['workspaceModules']); module = self.checkout / 'engine/compiled.ts'; alternate = b'export const compiled = 999;\n'
        env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        original = subprocess.check_output(['git', '--no-replace-objects', 'rev-parse', 'HEAD:engine/compiled.ts'], cwd=self.checkout, env=env).decode().strip()
        replacement = subprocess.run(['git', 'hash-object', '-w', '--stdin'], input=alternate, cwd=self.checkout, env=env, capture_output=True, check=True).stdout.decode().strip()
        subprocess.run(['git', 'replace', original, replacement], cwd=self.checkout, env=env, capture_output=True, check=True)
        graph['modules'][0].update({'bytes': len(alternate), 'sha256': hashlib.sha256(alternate).hexdigest()})
        descriptor['workspaceModules'] = self.put(graph)
        report = l.held(descriptor['originalReport']); runner = l.held({'path': report['command'][2], 'sha256': report['command'][3]})
        runner['moduleReceipt'] = descriptor['workspaceModules']['path']; runner = self.put(runner); report['command'][2:] = [runner['path'], runner['sha256']]
        descriptor['originalReport'] = self.put(report)
        binding = {key: build[key] for key in ['root', 'manifest', 'originalCustody']}; binding['originalCustody'] = self.put(descriptor)
        with self.assertRaises(l.a.Refusal): l.a.candidate_build(binding)
        self.assertEqual(module.read_bytes(), b'export const compiled = 1;\n')

    def test_a_different_original_ci_reference_cannot_substitute_for_qualified_run(self):
        value = copy.deepcopy(self.value); source = l.held(value['refs']['qualifiedSource'])
        source['run'] = self.put(l.held(source['run'])); value['refs']['qualifiedSource'] = self.put(source)
        with self.assertRaises(l.a.Refusal): l.prepare(value, self.put(value))


if __name__ == '__main__': unittest.main()
