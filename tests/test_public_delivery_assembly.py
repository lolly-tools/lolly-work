# SPDX-License-Identifier: MPL-2.0
"""Real file/coding controls for the local public root and exact placement."""
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


a = load('delivery_assembly', 'assemble-public-delivery.py')
p = load('delivery_placement', 'plan-public-delivery-root.py')
NODE = Path(os.environ.get('LOLLY_TEST_NODE', shutil.which('node') or '/missing/node')).resolve()


def row(path, data):
    return {'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def roots(root, values):
    rows = {}
    root.mkdir()
    for path, contents in values.items():
        target = root / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(contents)
        rows[path] = row(path, contents)
    return a.tree(rows)


def owner():
    return {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'sovereign-web', 'namespace': 'lolly-public', 'uid': 'actual-owner', 'resourceVersion': '27'},
        'spec': {'replicas': 1, 'strategy': {'type': 'Recreate'}, 'selector': {'matchLabels': {'app': 'web'}},
            'template': {'metadata': {'labels': {'app': 'web'}, 'annotations': {'checksum/nginx': 'unchanged-config', 'lolly.tools/catalog-index-sha256': 'unchanged-catalog'}},
                'spec': {'securityContext': {'runAsUser': 101, 'runAsGroup': 101, 'fsGroup': 101, 'fsGroupChangePolicy': 'OnRootMismatch'},
                    'volumes': [{'name': 'tmp', 'emptyDir': {}}, {'name': 'nginx', 'configMap': {'name': 'new-qualified-config'}},
                        {'name': 'models', 'persistentVolumeClaim': {'claimName': 'retired-models'}}, {'name': 'validator-map', 'persistentVolumeClaim': {'claimName': 'retired-map'}}],
                    'containers': [{'name': 'web', 'image': 'nginx@sha256:' + '7' * 64, 'resources': {'requests': {'memory': '32Mi'}, 'limits': {'memory': '256Mi'}},
                        'securityContext': {'readOnlyRootFilesystem': True, 'allowPrivilegeEscalation': False},
                        'volumeMounts': [{'name': 'tmp', 'mountPath': '/tmp'}, {'name': 'nginx', 'mountPath': '/etc/nginx/conf.d/default.conf', 'subPath': 'default.conf', 'readOnly': True},
                            {'name': 'models', 'mountPath': '/run/lolly-public-models', 'readOnly': True},
                            {'name': 'models', 'mountPath': '/usr/share/nginx/html/models', 'subPath': 'models-' + '9' * 64, 'readOnly': True},
                            {'name': 'validator-map', 'mountPath': '/run/lolly-validator-map', 'readOnly': True},
                            {'name': 'validator-map', 'mountPath': '/etc/nginx/delivery-etags.conf', 'subPath': 'delivery-etags.conf', 'readOnly': True}]}]}}}}


class Assembly(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.base = Path(self.temp.name).resolve()
        self.new = self.base / 'candidate'; self.old = self.base / 'previous'
        self.identity = b'new shell contents ' * 400
        self.candidate = roots(self.new, {**{path: self.identity for path in a.overlay.FIXED},
            '_app/new.js': self.identity, 'index.html.gz': gzip.compress(self.identity, mtime=0),
            'catalog/tools/index.sig.json': b'original signed bytes', a.overlay.MAP: b'old candidate map'})
        self.previous = roots(self.old, {'_app/old.js': b'old immutable body' * 500,
            '_app/old.js.gz': gzip.compress(b'old immutable body' * 500, mtime=0), 'index.html': b'old mutable',
            'index.html.gz': gzip.compress(b'old mutable', mtime=0), a.overlay.MAP: b'old map'})
        self.node = {'path': str(NODE), 'sha256': a.checksum(NODE)}

    def tearDown(self): self.temp.cleanup()

    def invoke(self):
        return a.assemble(str(self.new), str(self.old), self.candidate, self.previous, [], self.base / 'assembled', SCRIPTS / 'public-delivery-map.mjs', self.node)

    def test_complete_actual_assembly_keeps_signed_and_old_immutable_wire_bytes(self):
        result = self.invoke(); report = json.loads(Path(result['path']).read_bytes())
        self.assertEqual(report['retained'], ['_app/old.js', '_app/old.js.gz'])
        self.assertEqual(report['decodedCodings'], 2)
        site = Path(report['root'])
        self.assertEqual((site / 'catalog/tools/index.sig.json').read_bytes(), b'original signed bytes')
        self.assertEqual((site / '_app/old.js.gz').read_bytes(), (self.old / '_app/old.js.gz').read_bytes())
        self.assertEqual((site / 'index.html').read_bytes(), self.identity)
        self.assertEqual((site / 'index.html.gz').read_bytes(), (self.new / 'index.html.gz').read_bytes())
        self.assertNotEqual((site / a.overlay.MAP).read_bytes(), b'old candidate map')
        self.assertFalse(report['runtimeQualified']); self.assertFalse(report['published'])
        self.assertTrue(all(path.stat().st_mtime_ns == 0 and path.stat().st_nlink == 1 for path in site.rglob('*') if path.is_file()))
        self.assertNotEqual((site / '_app/new.js').stat().st_ino, (self.new / '_app/new.js').stat().st_ino)

    def test_real_brotli_decoder_proves_original_and_refuses_corrupt_wire(self):
        result = subprocess.run([str(NODE), '--input-type=module', '-e', "import{brotliCompressSync}from'node:zlib';process.stdout.write(brotliCompressSync(Buffer.from('new shell contents '.repeat(400))))"], capture_output=True, check=True)
        target = self.new / 'index.html.br'; target.write_bytes(result.stdout)
        rows = a.overlay.manifest(self.candidate); rows['index.html.br'] = row('index.html.br', result.stdout); self.candidate = a.tree(rows)
        self.assertEqual(json.loads(Path(self.invoke()['path']).read_bytes())['decodedCodings'], 3)

    def test_valid_wire_with_wrong_identity_fails_closed(self):
        wire = gzip.compress(b'wrong same-hashed-manifest data', mtime=0)
        (self.new / 'index.html.gz').write_bytes(wire)
        rows = a.overlay.manifest(self.candidate); rows['index.html.gz'] = row('index.html.gz', wire); self.candidate = a.tree(rows)
        with self.assertRaises(a.Refusal): self.invoke()

    def test_physical_extra_missing_and_changed_original_refused(self):
        for mode in ['extra', 'missing', 'changed']:
            with self.subTest(mode=mode):
                path = self.new / ('extra.js' if mode == 'extra' else '_app/new.js'); original = path.read_bytes() if path.exists() else None
                if mode == 'missing': path.unlink()
                else: path.write_bytes(b'foreign')
                with self.assertRaises(a.Refusal): a.physical(self.new, self.candidate)
                if original is None: path.unlink()
                else: path.write_bytes(original)

    def test_symlink_directory_and_leaf_refused(self):
        (self.new / 'alias').symlink_to(self.old, target_is_directory=True)
        with self.assertRaises(a.Refusal): a.physical(self.new, self.candidate)
        (self.new / 'alias').unlink(); target = self.new / '_app/new.js'; target.unlink(); target.symlink_to(self.old / '_app/old.js')
        with self.assertRaises(a.Refusal): a.physical(self.new, self.candidate)

    def test_immutable_identity_and_wire_collisions_refused(self):
        for path in ['_app/old.js', '_app/old.js.gz']:
            rows = a.overlay.manifest(self.candidate); rows[path] = row(path, b'collision')
            with self.subTest(path=path), self.assertRaises(a.Refusal): a.union(rows, a.overlay.manifest(self.previous))

    def test_output_existing_nested_and_ancestor_refused(self):
        for output in [self.new, self.new / 'nested', self.base]:
            with self.subTest(output=output), self.assertRaises(a.Refusal):
                a.assemble(str(self.new), str(self.old), self.candidate, self.previous, [], output, SCRIPTS / 'public-delivery-map.mjs', self.node)

    def test_model_static_and_encoded_path_rows_refused(self):
        for path in ['models/x.onnx', 'a/%2e%2e/file', 'a\\b', '.private']:
            with self.subTest(path=path), self.assertRaises(a.Refusal): a.overlay.safe_path(path)

    def test_node_hash_and_duplicate_json_refused(self):
        altered = {**self.node, 'sha256': '0' * 64}
        with self.assertRaises(a.Refusal): a.node_command(altered, SCRIPTS / 'public-delivery-map.mjs', {})
        with self.assertRaises(a.Refusal): a.parsed(b'{"version":1,"version":2}')

    def test_frontend_assembly_cannot_change_protected_catalog(self):
        shutil.rmtree(self.old)
        values = {path: (self.new / path).read_bytes() for path in a.overlay.manifest(self.candidate)}
        values['index.html'] = b'old mutable'; values.pop('index.html.gz')
        values['catalog/tools/index.sig.json'] = b'other old signed bytes'
        self.previous = roots(self.old, values)
        with self.assertRaises(a.Refusal):
            a.assemble(str(self.new), str(self.old), self.candidate, self.previous, [], self.base / 'assembled',
                       SCRIPTS / 'public-delivery-map.mjs', self.node, mode='frontend')


class Placement(unittest.TestCase):
    def bootstrap(self):
        before = owner(); desired = p.full_root_spec(before['spec'], 'new-full-root', 'a' * 40, 'b' * 64, 'c' * 64)
        return before, desired

    def test_root_anchor_then_root_then_map_precedes_models_child(self):
        before, desired = self.bootstrap(); mounts = desired['template']['spec']['containers'][0]['volumeMounts']
        self.assertEqual([value for value in mounts if value['name'] == p.VOLUME], a.overlay.overlay_mounts(p.VOLUME))
        self.assertLess(next(i for i, value in enumerate(mounts) if value['mountPath'] == a.overlay.ROOT), next(i for i, value in enumerate(mounts) if value['mountPath'] == a.overlay.ROOT + '/models'))
        self.assertEqual(desired['template']['spec']['containers'][0]['image'], before['spec']['template']['spec']['containers'][0]['image'])

    def test_fast_update_changes_only_claim_and_three_annotations(self):
        before, bootstrapped = self.bootstrap(); before['spec'] = bootstrapped
        desired = p.frontend_spec(before, 'next-full-root', 'd' * 40, 'e' * 64, 'f' * 64)
        old_pod = before['spec']['template']['spec']; new_pod = desired['template']['spec']
        self.assertEqual(old_pod['containers'], new_pod['containers'])
        self.assertEqual([v for v in old_pod['volumes'] if v['name'] != p.VOLUME], [v for v in new_pod['volumes'] if v['name'] != p.VOLUME])
        self.assertEqual(desired['template']['metadata']['annotations']['checksum/nginx'], 'unchanged-config')

    def test_legacy_five_path_or_standalone_map_cannot_enter_fastlane(self):
        with self.assertRaises(p.overlay.Refusal): p.frontend_spec(owner(), 'next', 'd' * 40, 'e' * 64, 'f' * 64)
        before, bootstrapped = self.bootstrap(); before['spec'] = bootstrapped
        before['spec']['template']['spec']['volumes'].append({'name': 'validator-map', 'persistentVolumeClaim': {'claimName': 'old'}})
        with self.assertRaises(p.overlay.Refusal): p.frontend_spec(before, 'next', 'd' * 40, 'e' * 64, 'f' * 64)

    def test_model_order_claim_security_and_credentials_preserved_or_refused(self):
        for transform in [lambda v: v['spec']['template']['spec']['containers'][0].update(env=[]),
                          lambda v: v['spec']['template']['spec']['securityContext'].update(fsGroup=1000),
                          lambda v: v['spec'].update(replicas=2)]:
            value = owner(); transform(value)
            with self.assertRaises(p.overlay.Refusal): p.deployment(value)
        value = owner()['spec']; value['template']['spec']['containers'][0]['volumeMounts'].reverse()
        with self.assertRaises(p.overlay.Refusal): p.full_root_spec(value, 'new', 'd' * 40, 'e' * 64, 'f' * 64)

    def test_patch_and_exact_inverse_use_actual_UID_RV_fullspec(self):
        before, desired = self.bootstrap(); patch = p.guarded_patch(before, desired)
        self.assertEqual([value['path'] for value in patch[:3]], ['/metadata/uid', '/metadata/resourceVersion', '/spec'])
        after = copy.deepcopy(before); after['spec'] = desired; after['metadata']['resourceVersion'] = '28'
        self.assertEqual(p.rollback(after, before, desired)[1]['value'], '28')
        self.assertEqual(p.rollback(after, before, desired)[-1]['value'], before['spec'])
        for transform in [lambda v: v['metadata'].update(uid='wrong'), lambda v: v['spec'].update(replicas=0)]:
            changed = copy.deepcopy(after); transform(changed)
            with self.assertRaises(p.overlay.Refusal): p.rollback(changed, before, desired)

    def test_publish_requires_actual_new_root_oracle_and_exact_memory_limit(self):
        before, desired = self.bootstrap()
        expected = {'source': 'a' * 40, 'image': desired['template']['spec']['containers'][0]['image'], 'manifestSha256': 'b' * 64, 'mapSha256': 'c' * 64}
        good = {'version': 2, 'status': 'ACTUAL_PUBLIC_FULL_ROOT_NATIVE_QUALIFIED_AND_RETIRED', **expected,
            'memory': {'limitBytes': 256 * 1024**2, 'currentBytes': 110 * 1024**2, 'peakBytes': 120 * 1024**2, 'zeroOom': True, 'ownerBound': True},
            'http': {key: True for key in ['external8080', 'allPhysicalHashes', 'allCodingDecodes', 'identityStrongEtag', 'gzipStrongEtag',
                'conditional304', 'ifRange206', 'crossCodingMiss', 'privateErrors', 'strictModelsCors', 'strictRange416', 'models177']},
            'retirement': {'podUID': 'actual-qualifier', 'podAbsent': True, 'policyAbsent': True, 'mountsReleased': True, 'globalClaimConsumersAbsent': True}}
        self.assertEqual(p.qualified_patch(before, desired, good, expected), p.guarded_patch(before, desired))
        for transform in [lambda v: v['memory'].update(peakBytes=256 * 1024**2), lambda v: v['memory'].update(zeroOom=False),
                          lambda v: v['memory'].update(ownerBound=False), lambda v: v['memory'].update(limitBytes=512 * 1024**2),
                          lambda v: v['http'].update(strictRange416=False), lambda v: v['http'].update(external8080=False),
                          lambda v: v['retirement'].update(mountsReleased=False), lambda v: v.update(source='0' * 40),
                          lambda v: v.update(status='old q05'), lambda v: v.update(extra=True)]:
            changed = copy.deepcopy(good); transform(changed)
            with self.subTest(changed=changed), self.assertRaises(p.overlay.Refusal): p.qualified_patch(before, desired, changed, expected)

    def test_stager_declares_only_new_claim_and_credential_free_deny_all_writer(self):
        names = {'claim': 'new-site', 'writer': 'new-writer', 'policy': 'new-deny'}
        resources = p.stage_resources(names, 'reviewed-node', 'docker.io/library/lolly-server@sha256:' + 'a' * 64, 2000)
        pod = resources['writer']['spec']; web = pod['containers'][0]
        self.assertFalse(pod['automountServiceAccountToken'])
        self.assertEqual(pod['securityContext']['fsGroupChangePolicy'], 'OnRootMismatch')
        self.assertEqual([v['persistentVolumeClaim']['claimName'] for v in pod['volumes'] if 'persistentVolumeClaim' in v], ['new-site'])
        self.assertEqual(web['command'], ['/bin/sh', '-c', 'sleep 3600'])
        self.assertEqual(web['imagePullPolicy'], 'Never'); self.assertNotIn('env', web); self.assertNotIn('envFrom', web)
        self.assertEqual(resources['policy']['spec']['ingress'], []); self.assertEqual(resources['policy']['spec']['egress'], [])
        for changed in [{**names, 'writer': 'new-site'}, {**names, 'claim': '../x'}]:
            with self.assertRaises(p.overlay.Refusal): p.stage_resources(changed, 'reviewed-node', 'repo@sha256:' + 'a' * 64, 20)
        with self.assertRaises(p.overlay.Refusal): p.stage_resources(names, 'reviewed-node', 'repo:mutable', 20)
        with self.assertRaises(p.overlay.Refusal): p.stage_resources(names, 'reviewed-node', 'repo@sha256:' + 'a' * 64, True)


if __name__ == '__main__': unittest.main()
