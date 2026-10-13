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
        preparer = {'path': str(SCRIPTS / 'public-delivery-lifecycle.py'), 'sha256': l.a.checksum(SCRIPTS / 'public-delivery-lifecycle.py')}
        review = {'version': 1, 'status': 'ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE', 'source': self.adapter_source, 'sources': [self.adapter_source, preparer],
            'capabilities': sorted(l.CAPABILITIES), 'stages': l.STAGES, 'productionMutation': False}
        adapter = {'version': 1, 'status': 'ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER', 'source': self.adapter_source, 'sources': [self.adapter_source, preparer],
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


class PublicationHandoff(unittest.TestCase):
    """Synthetic original receipts exercise admission, never target acceptance."""
    def setUp(self):
        self.f = Lifecycle(); self.f.setUp(); f = self.f
        f.before['metadata']['generation'] = 1
        f.value['refs'].update({'deployment': f.put(f.before), 'baseline': f.put(f.baseline)})
        self.out = f.base / 'publication'; self.out.mkdir()
        stage = {'path': str(SCRIPTS / 'stage-public-delivery.py'), 'sha256': l.a.checksum(SCRIPTS / 'stage-public-delivery.py')}
        self.operator = {'path': str(SCRIPTS / 'publish-public-delivery.py'), 'sha256': l.a.checksum(SCRIPTS / 'publish-public-delivery.py')}
        programs = {k: f.base / (k + '.py') for k in ['preflight', 'hostProbe', 'signatureVerifier']}
        for path in programs.values(): path.write_text('raise RuntimeError("synthetic fixture must never execute target programs")\n')
        program_refs = {k: {'path': str(path), 'sha256': l.a.checksum(path)} for k, path in programs.items()}
        program_refs['node'] = {'path': str(NODE), 'sha256': l.a.checksum(NODE)}
        preparer = {'path': str(SCRIPTS / 'public-delivery-lifecycle.py'), 'sha256': l.a.checksum(SCRIPTS / 'public-delivery-lifecycle.py')}
        sources = [stage, self.operator, preparer, *[ref for k, ref in program_refs.items() if k != 'node']]
        review = {'version': 1, 'status': 'ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE', 'source': stage, 'sources': sources,
            'capabilities': sorted(l.CAPABILITIES), 'stages': l.STAGES, 'productionMutation': False}
        adapter = {**{k: v for k, v in review.items() if k != 'productionMutation'},
            'status': 'ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER', 'review': f.put(review)}
        f.adapter_source = stage; f.value['refs']['adapterReview'] = f.put(adapter)
        f.input = f.put(f.value); f.prepared = l.prepare(f.value, f.input)
        self.prepared = f.prepared; stage_receipt = f.receipt(); prepared_ref = stage_receipt['prepared']
        retired_dir = f.base / 'stage'; retired_dir.mkdir()
        retirement = l.a.write_new(retired_dir / 'runtime.qualified-and-retired.actual.json', l.raw(stage_receipt))
        self.runtime = {'version': 1, 'status': 'REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED', 'prepared': prepared_ref,
            'target': f.put({'node': {'name': 'customer-node'}}), 'context': f.put({'scope': 'synthetic fixture only'}),
            'programs': program_refs, 'sources': sources, 'outputDirectory': str(retired_dir)}
        self.publication = {'version': 1, 'status': 'REVIEWED_ACTUAL_FRONTEND_ROOT_PUBLICATION_NOT_EXECUTED',
            'stageInput': f.put(self.runtime), 'stageSource': stage, 'retirement': retirement, 'outputDirectory': str(self.out)}
        self.input = f.put(self.publication)
        dep = copy.deepcopy(f.before); dep['spec'] = copy.deepcopy(self.prepared['desiredSpec']); dep['metadata']['generation'] = 2
        dep['status'] = {'observedGeneration': 2, **dict.fromkeys(['replicas', 'readyReplicas', 'availableReplicas', 'updatedReplicas'], 1)}
        template = copy.deepcopy(dep['spec']['template']); template['metadata']['labels']['pod-template-hash'] = 'abc123'
        selector = copy.deepcopy(dep['spec']['selector']); selector['matchLabels']['pod-template-hash'] = 'abc123'
        replica = {'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'metadata': {'name': 'new-rs', 'namespace': 'customer-apps', 'uid': 'new-rs-uid',
            'labels': template['metadata']['labels'], 'ownerReferences': [{'kind': 'Deployment', 'uid': 'web-owner', 'controller': True}]},
            'spec': {'replicas': 1, 'selector': selector, 'template': template}}
        pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {**copy.deepcopy(template['metadata']), 'name': 'new-owner', 'namespace': 'customer-apps', 'uid': 'new-owner-uid',
            'ownerReferences': [{'kind': 'ReplicaSet', 'name': 'new-rs', 'uid': 'new-rs-uid', 'controller': True}]},
            'spec': {**copy.deepcopy(template['spec']), 'nodeName': 'customer-node', 'enableServiceLinks': True},
            'status': {'containerStatuses': [{'name': 'native', 'image': f.image, 'imageID': f.image, 'containerID': 'containerd://' + '1' * 64,
                'ready': True, 'restartCount': 0, 'state': {'running': {'startedAt': '2026-10-12T01:00:00Z'}}}]}}
        self.bundle = {'deployment': dep, 'pod': pod, 'replicaSet': replica}
        self.physical = {}
        for key, rows in [('static', l.held(self.prepared['manifest'])['files']), ('models', l.held(f.models)['files'])]:
            self.physical[key] = {'files': len(rows), 'bytes': sum(row['size'] for row in rows), 'physicalEpoch': 0, 'uid': 101, 'gid': 101,
                'allPhysicalHashesVerified': True, 'modelLinkClosureVerified': key == 'models', 'hardLinkedFiles': 0,
                'modelInodeFingerprint': 'a' * 64 if key == 'models' else None}
        self.memory = {'version': 1, 'podUID': 'new-owner-uid', 'limitBytes': 512 * 1024**2, 'currentBytes': 80 * 1024**2,
            'peakBytes': 90 * 1024**2, 'rssBytes': 60 * 1024**2, 'oom': 0, 'oomKill': 0}
        self.native_http = {'static': {'status': 'ISOLATED_STATIC_HTTP_RETAINED_FULL_BYTES_AND_SAMPLES_VERIFIED_ONLY'},
            'decoded': {'status': 'ACTUAL_LOOPBACK_GZIP_WIRE_AND_DECODED_IDENTITY_VERIFIED'}}
        models = l.held(f.models)['files']
        self.models_tls = {'status': 'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY', 'files': len(models),
            'inventorySha256': hashlib.sha256(json.dumps(models, separators=(',', ':')).encode()).hexdigest()}
        self.static_tls = {'status': 'ACTUAL_NORMAL_TLS_MUTABLE_ROOT_IDENTITIES_VERIFIED',
            'rows': [{'path': row['path'], 'status': 200, 'size': row['size'], 'sha256': row['sha256']}
                for row in l.held(self.prepared['manifest'])['files'] if row['path'] in l.a.overlay.FIXED]}
        evidence = {k: self.save(name, value) for k, name, value in [
            ('ownerBefore', 'owner-before.original.json', self.bundle), ('ownerAfter', 'owner.original.json', self.bundle),
            ('nativeHTTP', 'owning-native-http.actual.json', self.native_http), ('modelsTLS', 'owning-models-tls.actual.json', self.models_tls),
            ('staticTLS', 'owning-static-tls.actual.json', self.static_tls)]}
        self.proof = {'version': 1, 'input': self.input, 'operator': self.operator, 'phases': {}}
        for name in ['dryrun', 'publish', 'observe']:
            base = {'version': 1, 'inputSha256': self.input['sha256'], 'operatorSha256': self.operator['sha256'],
                'commands': [self.command(name)], 'productionMutation': name == 'publish'}
            if name == 'observe':
                base.update({'status': 'ACTUAL_FRONTEND_ROOT_SERVING_VERIFIED', 'deploymentUID': 'web-owner',
                    'deploymentSpecSha256': l.digest(dep['spec']), 'source': self.prepared['source'], 'manifest': self.prepared['manifest'],
                    'mapSha256': self.prepared['mapSha256'], 'physical': self.physical, 'memory': self.memory, 'evidence': evidence,
                    'modelsMountedByStaging': False, 'allProtectedSpecsVerified': True, 'browserAcceptanceClaimed': False})
            else:
                patched = [{'op': 'test', 'path': '/metadata/uid', 'value': 'web-owner'},
                    {'op': 'test', 'path': '/metadata/resourceVersion', 'value': '27'}, {'op': 'test', 'path': '/spec', 'value': f.before['spec']},
                    {'op': 'replace', 'path': '/spec', 'value': dep['spec']}]
                base.update({'status': 'ACTUAL_FRONTEND_SERVER_DRYRUN_NOT_PUBLISHED' if name == 'dryrun' else 'ACTUAL_FRONTEND_PATCHED_ACCEPTANCE_PENDING',
                    'before': self.save(name + '.before.original.json', f.before), 'patch': self.save(name + '.patch.original.json', patched),
                    'response': self.save(name + '.response.original.json', dep)})
            self.proof['phases'][name] = {'started': self.save(name + '.started.json', {'status': 'STARTED_NO_REPLAY',
                'inputSha256': self.input['sha256'], 'operatorSha256': self.operator['sha256']}), 'accepted': self.save(name + '.accepted.json', base)}

    def tearDown(self): self.f.tearDown()
    def save(self, name, value): return l.a.write_new(self.out / name, l.raw(value))
    def command(self, name):
        stream = self.save(name + '.unit-stream.json', {'scope': 'synthetic command stdout/stderr, not target execution'})
        return self.save('command-' + name + '.actual.json', {'exitCode': 0, 'failure': None, 'complete': True, 'stdout': stream, 'stderr': stream})
    def replace(self, ref, change):
        value = l.held(ref); change(value); path = Path(ref['path']); path.write_bytes(l.raw(value)); ref['sha256'] = l.a.checksum(path)

    def test_successful_handoff_rederives_exact_baseline_without_model_mount(self):
        accepted = l.publication_baseline(self.proof)
        self.assertEqual(accepted['version'], 2); self.assertEqual(accepted['ownerPodUID'], 'new-owner-uid')
        self.assertEqual(accepted['manifestSha256'], self.prepared['manifest']['sha256'])
        self.assertEqual(accepted['models'], self.f.models); self.assertEqual(accepted['publicPin'], self.f.pin)
        self.assertEqual(accepted['publication'], self.proof)
        for key in ['writer', 'qualifier']:
            self.assertNotIn('models', [v['name'] for v in self.prepared['resources'][key]['spec']['volumes']])

    def test_owner_default_is_exact_and_explicit_template_value_is_preserved(self):
        result=l.serving_binding(self.bundle,self.prepared,'customer-node')
        self.assertTrue(result['podSpec']['enableServiceLinks'])
        for value in (False,None):
            owner=copy.deepcopy(self.bundle)
            if value is None:owner['pod']['spec'].pop('enableServiceLinks')
            else:owner['pod']['spec']['enableServiceLinks']=value
            with self.subTest(value=value),self.assertRaises(l.a.Refusal):
                l.serving_binding(owner,self.prepared,'customer-node')
        prepared=copy.deepcopy(self.prepared); owner=copy.deepcopy(self.bundle)
        prepared['desiredSpec']['template']['spec']['enableServiceLinks']=False
        owner['deployment']['spec']=copy.deepcopy(prepared['desiredSpec'])
        owner['replicaSet']['spec']['template']['spec']['enableServiceLinks']=False
        owner['pod']['spec']['enableServiceLinks']=False
        result=l.serving_binding(owner,prepared,'customer-node')
        self.assertFalse(result['podSpec']['enableServiceLinks'])
        owner['pod']['spec']['enableServiceLinks']=True
        with self.assertRaises(RuntimeError):l.serving_binding(owner,prepared,'customer-node')

    def next_value(self, accepted):
        f = self.f
        previous = l.held(self.prepared['manifest'])
        root = Path(l.held(self.prepared['refs']['assembly'])['root'])
        data = {row['path']: (root / row['path']).read_bytes() for row in previous['files']}
        data['index.html'] = b'next synthetic shell'; data['_app/next.js'] = b'next synthetic module'
        candidate = f.tree(f.base / 'next-candidate', data)
        assembly = l.a.assemble(str(f.base / 'next-candidate'), str(root), candidate, previous,
            l.held(f.models)['files'], f.base / 'next-assembly', SCRIPTS / 'public-delivery-map.mjs',
            {'path': str(NODE), 'sha256': l.a.checksum(NODE)}, mode='frontend', candidate_custody=f.public_build(f.base / 'next-candidate', candidate))
        baseline = copy.deepcopy(f.baseline); baseline['deployments'][0] = self.bundle['deployment']; baseline['pods']['items'] = [self.bundle['pod']]
        value = copy.deepcopy(f.value); value['refs'].update({'deployment': f.put(self.bundle['deployment']), 'baseline': f.put(baseline),
            'assembly': assembly, 'previousManifest': self.prepared['manifest'], 'acceptedRelease': f.put(accepted)})
        value['names'] = {'claim': 'next-site', 'writer': 'next-writer', 'qualifier': 'next-qualifier', 'policy': 'next-deny'}
        value['outputDirectory'] = str(f.base / 'next-prepared')
        return value

    def test_next_prepare_consumes_handoff_and_rejects_rehashed_baseline_projection(self):
        f = self.f; accepted = l.publication_baseline(self.proof); value = self.next_value(accepted)
        result = l.prepare(value, f.put(value)); self.assertFalse(result['modelsMounted'])
        self.assertEqual(result['refs']['models'], f.models)
        accepted['ownerPodUID'] = 'requested-replacement'; value['refs']['acceptedRelease'] = f.put(accepted)
        with self.assertRaisesRegex(l.a.Refusal, 'rederive from original serving custody'): l.prepare(value, f.put(value))

    def test_distinct_real_checkouts_admit_history_then_prepare_next_without_restamping(self):
        # Source-only Git checkouts contain the real helpers/test fixture. No
        # packages, model bodies, target transport or historical code execution.
        checkout_a, checkout_b = self.f.base / 'helper-A', self.f.base / 'helper-B'
        checkout_a.mkdir()
        paths = subprocess.run(['git', 'ls-files', 'scripts'], cwd=SCRIPTS.parent, capture_output=True, text=True, check=True).stdout.splitlines()
        paths.append('tests/test_public_delivery_lifecycle.py')
        for relative in paths:
            target = checkout_a / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SCRIPTS.parent / relative, target)
        env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        for args in [['init', '--quiet', '--initial-branch=main'], ['add', 'scripts', 'tests'],
            ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Real helper checkout fixture']]:
            subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=checkout_a, env=env, capture_output=True, check=True)
        subprocess.run(['git', 'clone', '--shared', '--quiet', str(checkout_a), str(checkout_b)], env=env, capture_output=True, check=True)
        hashes_a = {relative: l.a.checksum(checkout_a / relative) for relative in paths}
        spec = importlib.util.spec_from_file_location('original_checkout_fixture', checkout_a / 'tests/test_public_delivery_lifecycle.py')
        original = importlib.util.module_from_spec(spec); spec.loader.exec_module(original)
        fixture = original.PublicationHandoff(); fixture.setUp()
        try:
            spec = importlib.util.spec_from_file_location('next_checkout_lifecycle', checkout_b / 'scripts/public-delivery-lifecycle.py')
            next_l = importlib.util.module_from_spec(spec); spec.loader.exec_module(next_l)
            prepared = fixture.prepared; runtime = original.l.held(fixture.publication['stageInput'])
            retirement = original.l.held(fixture.publication['retirement'])
            originals = {str(path): path.read_bytes() for path in fixture.f.base.rglob('*') if path.is_file()}
            next_l.admit(prepared, retirement)
            accepted = next_l.publication_baseline(fixture.proof)
            self.assertEqual(accepted, original.l.publication_baseline(fixture.proof))
            value = fixture.next_value(accepted)
            adapter = original.l.held(value['refs']['adapterReview'])
            def relocate(ref):
                path = Path(ref['path'])
                return {**ref, 'path': str(checkout_b / path.relative_to(checkout_a))} if checkout_a in path.parents else ref
            adapter['source'] = relocate(adapter['source']); adapter['sources'] = [relocate(ref) for ref in adapter['sources']]
            review = original.l.held(adapter['review']); review.update({key: adapter[key] for key in ['source', 'sources']})
            adapter['review'] = fixture.f.put(review); value['refs']['adapterReview'] = fixture.f.put(adapter)
            result = next_l.prepare(value, fixture.f.put(value))
            self.assertEqual(result['preparer'], {'path': str(checkout_b / 'scripts/public-delivery-lifecycle.py'),
                'sha256': next_l.a.checksum(checkout_b / 'scripts/public-delivery-lifecycle.py')})
            self.assertNotEqual(prepared['preparer']['path'], result['preparer']['path'])
            self.assertEqual(prepared['preparer']['sha256'], result['preparer']['sha256'])
            for fault in ['source-hash', 'unregistered-path', 'forged-spec', 'forged-field']:
                altered = copy.deepcopy(prepared)
                if fault == 'source-hash': altered['preparer']['sha256'] = '0' * 64
                elif fault == 'unregistered-path': altered['preparer'] = result['preparer']
                elif fault == 'forged-spec': altered['desiredSpec']['template']['spec']['containers'][0]['image'] = 'evil@sha256:' + '0' * 64
                else: altered['runtimeQualified'] = True
                reason = 'size/hash differs' if fault == 'source-hash' else 'original reviewed source closure' if fault == 'unregistered-path' else 'rederive from original qualified bytes'
                with self.subTest(fault=fault), self.assertRaisesRegex(next_l.a.Refusal, reason): next_l.admit(altered, retirement)
            self.assertEqual(originals, {path: Path(path).read_bytes() for path in originals})
            self.assertEqual(hashes_a, {relative: l.a.checksum(checkout_a / relative) for relative in paths})
            self.assertEqual(subprocess.run(['git', 'status', '--porcelain'], cwd=checkout_a, env=env, capture_output=True, check=True).stdout, b'')
        finally: fixture.tearDown()

    def test_failed_missing_or_wrong_publication_custody_refused(self):
        for name in ['dryrun', 'publish', 'observe']:
            proof = copy.deepcopy(self.proof); proof['phases'][name]['accepted']['sha256'] = '0' * 64
            with self.subTest(name=name), self.assertRaises(l.a.Refusal): l.publication_baseline(proof)
        self.save('observe.uncertain.json', {'status': 'REFUSED_NO_REPLAY'})
        with self.assertRaises(l.a.Refusal): l.publication_baseline(self.proof)

    def test_rehashed_wrong_input_command_or_model_refused(self):
        observe = self.proof['phases']['observe']['accepted']
        for key, value in [('inputSha256', '0' * 64), ('source', '0' * 40), ('mapSha256', '0' * 64), ('modelsMountedByStaging', True)]:
            original = Path(observe['path']).read_bytes(); original_sha = observe['sha256']
            self.replace(observe, lambda v: v.update({key: value}))
            with self.subTest(key=key), self.assertRaises(l.a.Refusal): l.publication_baseline(self.proof)
            Path(observe['path']).write_bytes(original); observe['sha256'] = original_sha
        command = l.held(observe)['commands'][0]; self.replace(command, lambda v: v.update({'exitCode': 2}))
        self.replace(observe, lambda v: v.update({'commands': [command]}))
        with self.assertRaises(l.a.Refusal): l.publication_baseline(self.proof)

    def test_missing_retirement_or_changed_original_command_stream_refused(self):
        retirement = Path(self.publication['retirement']['path']); original = retirement.read_bytes(); retirement.unlink()
        with self.assertRaises(FileNotFoundError): l.publication_baseline(self.proof)
        retirement.write_bytes(original)
        phase = l.held(self.proof['phases']['publish']['accepted']); command = l.held(phase['commands'][0])
        Path(command['stdout']['path']).write_bytes(b'changed original command output')
        with self.assertRaisesRegex(l.a.Refusal, 'size/hash differs'): l.publication_baseline(self.proof)

    def test_owner_replacement_process_restart_or_replica_template_drift_refused(self):
        observe = self.proof['phases']['observe']['accepted']; owner = l.held(observe)['evidence']['ownerAfter']
        for fault in ['pod', 'process', 'restart', 'replica', 'network']:
            original = Path(owner['path']).read_bytes(); original_sha = owner['sha256']
            def mutate(value):
                if fault == 'pod': value['pod']['metadata']['uid'] = 'replacement'
                elif fault == 'process': value['pod']['status']['containerStatuses'][0]['containerID'] = 'containerd://replacement'
                elif fault == 'restart': value['pod']['status']['containerStatuses'][0]['restartCount'] = 1
                elif fault == 'replica': value['replicaSet']['spec']['template']['spec']['hostNetwork'] = True
                else: value['pod']['spec']['hostNetwork'] = True
            self.replace(owner, mutate); self.replace(observe, lambda v: v['evidence'].update({'ownerAfter': owner}))
            with self.subTest(fault=fault), self.assertRaises((l.a.Refusal, RuntimeError)): l.publication_baseline(self.proof)
            Path(owner['path']).write_bytes(original); owner['sha256'] = original_sha
            self.replace(observe, lambda v: v['evidence'].update({'ownerAfter': owner}))

    def test_incomplete_physical_memory_and_tls_proof_refused(self):
        observe = self.proof['phases']['observe']['accepted']
        for fault in ['physical', 'oom', 'static', 'models']:
            original = Path(observe['path']).read_bytes(); original_sha = observe['sha256']
            child = None
            def mutate(value):
                nonlocal child
                if fault == 'physical': value['physical']['models']['allPhysicalHashesVerified'] = False
                elif fault == 'oom': value['memory']['oomKill'] = 1
                else:
                    key = 'staticTLS' if fault == 'static' else 'modelsTLS'; ref = value['evidence'][key]
                    child = (Path(ref['path']), Path(ref['path']).read_bytes())
                    self.replace(ref, lambda body: body.update({'status': 'REFUSED'}))
            self.replace(observe, mutate)
            reason = {'physical': 'physical serving', 'oom': 'memory gate', 'static': 'normal TLS static', 'models': 'model HTTP proof'}[fault]
            with self.subTest(fault=fault), self.assertRaisesRegex(l.a.Refusal, reason): l.publication_baseline(self.proof)
            if child: child[0].write_bytes(child[1])
            Path(observe['path']).write_bytes(original); observe['sha256'] = original_sha


if __name__ == '__main__': unittest.main()
