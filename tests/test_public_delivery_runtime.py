# SPDX-License-Identifier: MPL-2.0
"""Actual local native parsing and guarded adapter sequencing; no target calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import os
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


s = load('runtime_stage', 'stage-public-delivery.py')
p = load('runtime_publication', 'publish-public-delivery.py')
n = load('runtime_native', 'public-delivery-native.py')
h = load('runtime_http', 'public-delivery-http.py')


class Native(unittest.TestCase):
    def row(self, path, body=b'abc', inode=20, links=1, uid=101):
        return 'F\t' + path + '\t' + f'{len(body)} 81a4 {uid} 101 0 {inode} 8 {links}' + '\t' + hashlib.sha256(body).hexdigest()

    def scan(self, rows, models=False):
        directories = {'.'} | {'/'.join(row.split('\t')[1].split('/')[:i]) for row in rows for i in range(1, len(row.split('\t')[1].split('/')))}
        before = [f'D\t{path}\t41ed 101 101 0 {index + 1} 8' for index, path in enumerate(sorted(directories))] if models else []
        return ('\n'.join(before + rows) + '\nEND\tFULL_PHYSICAL_COMPLETE\n').encode()
    def model(self, path): return {'url': '/models/' + path, 'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}

    def test_exact_owned_deduplicated_model_group_and_changed_inode_fingerprint(self):
        expected = [self.model('ocr/model.onnx'), self.model('ocr@1234567890123456/model.onnx')]
        rows = [self.row('ocr/model.onnx', inode=20, links=2), self.row('ocr@1234567890123456/model.onnx', inode=20, links=2)]
        result = n.physical(self.scan(rows, True), expected, True)
        self.assertEqual(result['hardLinkedFiles'], 2); self.assertTrue(result['modelLinkClosureVerified']); self.assertEqual(result['uid'], 101)
        other = n.physical(self.scan([r.replace(' 20 8 2', ' 21 8 2') for r in rows], True), expected, True)
        self.assertNotEqual(result['modelInodeFingerprint'], other['modelInodeFingerprint'])

    def test_foreign_links_duplicate_body_inodes_wrong_uid_and_extra_body_refused(self):
        expected = [self.model('ocr/model.onnx'), self.model('ocr@1234567890123456/model.onnx')]
        cases = [
            [self.row('ocr/model.onnx', links=3), self.row('ocr@1234567890123456/model.onnx', links=3)],
            [self.row('ocr/model.onnx', inode=20), self.row('ocr@1234567890123456/model.onnx', inode=21)],
            [self.row('ocr/model.onnx', links=2, uid=1000), self.row('ocr@1234567890123456/model.onnx', links=2, uid=1000)],
            [self.row('ocr/model.onnx', links=2), self.row('ocr@1234567890123456/model.onnx', links=2), self.row('z/foreign.onnx', inode=30)]]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(RuntimeError): n.physical(self.scan(rows, True), expected, True)

    def test_model_directory_owner_epoch_and_complete_closure_required(self):
        rows = [self.row('ocr/model.onnx')]; expected = [self.model('ocr/model.onnx')]
        actual = self.scan(rows, True)
        for changed in [actual.replace(b'41ed 101 101 0', b'41ed 1000 101 0', 1), actual.replace(b'41ed 101 101 0', b'41ed 101 101 1', 1),
                        actual.replace(b'D\t.\t', b'D\tunreviewed\t', 1)]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError): n.physical(changed, expected, True)

    def test_static_shared_link_incomplete_marker_and_hash_mismatch_refused(self):
        expected = [{'path': 'index.html', 'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}]
        for data in [self.scan([self.row('index.html', links=2)]), self.scan([self.row('index.html', body=b'bad')]), self.row('index.html').encode()]:
            with self.subTest(data=data), self.assertRaises(RuntimeError): n.physical(data, expected)

    def memory(self, peak=200, oom=0):
        return f'M\tcurrent\t100\nM\tpeak\t{peak}\nM\tmax\t512\nE\toom\t{oom}\nE\toom_kill\t0\nP\t123\t101 101 101 101\t0 kB\nEND\tCGROUP_AND_NGINX_PROCESS_MEMORY_OBSERVED\n'.encode()

    def test_zero_oom_and_real_rss_required_no_limit_or_peak_waiver(self):
        data = self.memory().replace(b'M\tcurrent\t100', b'M\tcurrent\t2048').replace(b'M\tpeak\t200', b'M\tpeak\t3072').replace(b'M\tmax\t512', b'M\tmax\t4096').replace(b'0 kB', b'1 kB')
        self.assertEqual(n.memory(data, 4096, 'owner')['rssBytes'], 1024)
        for wrong in [data.replace(b'peak\t3072', b'peak\t4096'), data.replace(b'E\toom\t0', b'E\toom\t1'), data.replace(b'101 101 101 101', b'0 0 0 0')]:
            with self.subTest(wrong=wrong), self.assertRaises(RuntimeError): n.memory(wrong, 4096, 'owner')


class Sequencing(unittest.TestCase):
    def stage(self):
        op = object.__new__(s.Stage); op.events = []; op.target = {'node': {'name': 'node', 'uid': 'node-uid'}}
        op.value = {'programs': {'hostProbe': {'path': '/reviewed/host-probe.py'}, 'preflight': {'path': '/reviewed/preflight.py'}}, 'target': {'path': '/reviewed/target.json'}}
        op.prepared = {'minimumFreeBytes': 8 * 1024**3, 'maximumWriteBytes': 1000}
        op.names = {'qualifier': 'qualifier', 'writer': 'writer', 'claim': 'claim', 'policy': 'deny'}
        op.namespace = 'customer'; op.resources = {'qualifier': {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'qualifier', 'namespace': 'customer', 'labels': {'scope': 'stage'}}, 'spec': {'containers': []}}}
        return op

    def test_preflight_is_last_operation_before_actual_create_and_uid_delete(self):
        op = self.stage(); events = []
        op.absent = lambda *args: True
        op.preflight = lambda *args: events.append('preflight')
        op.validate_pod = lambda actual, *args, **kwargs: actual
        op.save = lambda *args: None
        op.owned = lambda *args: {'metadata': {'name': 'qualifier', 'uid': 'exact-uid', 'resourceVersion': '3'}}
        op.fresh = lambda *args: None
        op.mount_release = lambda uid: {'uid': uid, 'released': True}
        def remote(argv, data=None, timeout=240):
            if argv[0] in {'create', 'delete'}:
                self.assertEqual(events[-1], 'preflight'); events.append(argv[0])
            if argv[0] == 'delete':
                options = json.loads(data); self.assertEqual(options['preconditions'], {'uid': 'exact-uid', 'resourceVersion': '3'}); return b''
            return json.dumps({'metadata': {'uid': 'exact-uid'}}).encode()
        op.remote = remote; op.create_pod('qualifier'); op.delete_pod('qualifier')
        self.assertEqual([v for v in events if v == 'create'], ['create', 'create']); self.assertEqual(events[-1], 'delete')

    def test_failed_target_preflight_never_reaches_create(self):
        op = self.stage(); op.absent = lambda *args: True
        op.preflight = lambda *args: (_ for _ in ()).throw(RuntimeError('failed target'))
        calls = []; op.remote = lambda *args: calls.append(args)
        with self.assertRaises(RuntimeError): op.create_pod('qualifier')
        self.assertEqual(calls, [])

    def test_preflight_capacity_and_image_checks_precede_final_target_command(self):
        op = self.stage(); events = []
        op.fresh = lambda *args: events.append('fresh')
        op.image_available = lambda: events.append('image')
        def run(argv, data=None, timeout=240):
            events.append(argv[2]); return json.dumps({'nodeUID': 'node-uid', 'nodeName': 'node', 'freeBytes': 10 * 1024**3}).encode()
        op.run = run; op.preflight()
        self.assertEqual(events, ['fresh', 'image', '/reviewed/host-probe.py', '/reviewed/preflight.py'])

    def test_phase_intent_failure_original_preserved_and_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            op = self.stage(); op.out = Path(directory); op.input_sha = 'a' * 64; op.operator_sha = 'b' * 64
            op.value['prepared'] = {'path': '/reviewed/prepared.json', 'sha256': 'c' * 64}; op.unchanged = lambda: None
            calls = []
            def failure(): calls.append('called'); raise RuntimeError('uncertain mutation')
            with self.assertRaises(RuntimeError): op.phase('copy', failure)
            self.assertTrue((op.out / 'copy.started.json').exists()); self.assertTrue((op.out / 'copy.uncertain.json').exists())
            with self.assertRaises(FileExistsError): op.phase('copy', failure)
            self.assertEqual(calls, ['called'])

    def test_mutating_patch_preserves_exact_uid_rv_and_full_spec(self):
        before = {'metadata': {'uid': 'owner', 'resourceVersion': '38'}, 'spec': {'template': {'spec': {'models': 'unchanged'}}}}
        desired = {'template': {'spec': {'models': 'unchanged', 'root': 'new'}}}
        patch = p.patch(before, desired)
        self.assertEqual(patch[:3], [{'op': 'test', 'path': '/metadata/uid', 'value': 'owner'}, {'op': 'test', 'path': '/metadata/resourceVersion', 'value': '38'}, {'op': 'test', 'path': '/spec', 'value': before['spec']}])
        self.assertEqual(patch[-1]['value'], desired)

    def test_actual_gzip_tar_stream_preserves_complete_bytes_without_local_tar(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); root = base / 'source'; root.mkdir(); (root / 'index.html').write_bytes(b'actual frontend')
            target = base / 'target'; target.mkdir(); op = self.stage(); op.root = root; op.out = base / 'journal'; op.out.mkdir()
            op.rows = [{'path': 'index.html', 'size': 15, 'sha256': hashlib.sha256(b'actual frontend').hexdigest()}]; op.manifest = {'totalBytes': 15}
            op.stream_upload(['/usr/bin/tar', '-C', str(target), '-xzf', '-'])
            self.assertEqual((target / 'index.html').read_bytes(), b'actual frontend')
            self.assertEqual((target / 'index.html').stat().st_mtime_ns, 0)
            receipt = json.loads((op.out / 'upload.command.actual.json').read_bytes())
            self.assertFalse(receipt['localTarCreated']); self.assertEqual(receipt['exitCode'], 0); self.assertGreater(receipt['wireBytes'], 0)
            self.assertFalse(list(op.out.glob('*.tar*')))

    def test_actual_stream_receiver_failure_keeps_originals_and_no_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); root = base / 'source'; root.mkdir(); (root / 'index.html').write_bytes(b'body')
            op = self.stage(); op.root = root; op.out = base / 'journal'; op.out.mkdir(); op.rows = [{'path': 'index.html', 'size': 4, 'sha256': hashlib.sha256(b'body').hexdigest()}]; op.manifest = {'totalBytes': 4}
            with self.assertRaises(RuntimeError): op.stream_upload(['/bin/sh', '-c', 'echo receiver-refused >&2; exit 1'])
            receipt = json.loads((op.out / 'upload.command.actual.json').read_bytes())
            self.assertEqual(receipt['exitCode'], 1); self.assertTrue(Path(receipt['stderr']['path']).read_bytes().startswith(b'receiver-refused'))

    def test_selinux_model_relabel_only_matches_the_actual_verified_owner_level(self):
        op = self.stage(); op.container = 'web'
        expected = {'root': {'selinuxLabel': 'system_u:object_r:container_file_t:s0:c1,c2'}}
        observed = {'root': {'selinuxLabel': 'system_u:object_r:container_file_t:s0:c3,c4'}}
        owner = {'metadata': {'name': 'actual-owner'}}
        op.remote = lambda *args: b'system_u:system_r:container_t:s0:c3,c4\n'
        op.owner_model_label(observed, expected, owner); self.assertEqual(expected, observed)
        expected = {'root': {'selinuxLabel': 'system_u:object_r:container_file_t:s0:c1,c2'}}
        op.remote = lambda *args: b'system_u:system_r:container_t:s0:c5,c6\n'
        with self.assertRaises(RuntimeError): op.owner_model_label(observed, expected, owner)
        with self.assertRaises(RuntimeError): op.owner_model_label({'root': {'selinuxLabel': 'system_u:object_r:wrong_t:s0:c3,c4'}}, expected, owner)

    def test_global_consumer_foreign_claim_and_hostpath_alias_refused(self):
        claim = {'metadata': {'name': 'models', 'namespace': 'customer', 'uid': 'claim'}}
        pv = {'metadata': {'name': 'pv', 'uid': 'pv'}, 'spec': {'local': {'path': '/models-pv'}, 'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': ['node']}]}]}}}}
        def pods(volume): return {'apiVersion': 'v1', 'kind': 'List', 'metadata': {}, 'items': [{'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'foreign', 'namespace': 'customer', 'uid': 'other', 'resourceVersion': '3'}, 'spec': {'nodeName': 'node', 'volumes': [volume]}}]}
        for volume in [{'name': 'p', 'persistentVolumeClaim': {'claimName': 'models'}}, *[{'name': 'h', 'hostPath': {'path': path}} for path in ['/models-pv', '/', '/models-pv/']]]:
            with self.subTest(volume=volume), self.assertRaises(RuntimeError): s.consumers(pods(volume), [{'claim': claim, 'pv': pv}], 'node', {'claim': {'accepted-owner'}})
        pv['spec']['local']['path'] = '/var/lib/k3s/models'
        for path in ['/', '/var/lib/', '/var/lib/k3s/', '/var/lib/k3s/models/']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                s.consumers(pods({'name': 'h', 'hostPath': {'path': path}}), [{'claim': claim, 'pv': pv}], 'node', {'claim': {'accepted-owner'}})

    def test_real_disjoint_symlink_alias_and_unscheduled_hostpath_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); selected = root / 'actual-backing'; selected.mkdir()
            alias = root / 'apparently-disjoint'; alias.symlink_to(selected, target_is_directory=True)
            self.assertEqual(alias.resolve(), selected)
            claim = {'metadata': {'name': 'models', 'namespace': 'customer', 'uid': 'claim'}}
            pv = {'metadata': {'name': 'pv', 'uid': 'pv'}, 'spec': {'local': {'path': str(selected)}, 'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': ['node']}]}]}}}}
            pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'foreign', 'namespace': 'customer', 'uid': 'other', 'resourceVersion': '3'},
                'spec': {'volumes': [{'name': 'h', 'hostPath': {'path': str(alias)}}]}}
            for placement in ['node', None]:
                value = copy.deepcopy(pod)
                if placement: value['spec']['nodeName'] = placement
                collection = {'apiVersion': 'v1', 'kind': 'List', 'metadata': {}, 'items': [value]}
                with self.subTest(placement=placement), self.assertRaises(RuntimeError): s.consumers(collection, [{'claim': claim, 'pv': pv}], 'node', {'claim': set()})
            self.assertTrue(s.node_overlap('/', '/var/lib/k3s/models'))
            self.assertTrue(s.node_overlap('/var/lib/', '/var/lib/k3s/models'))
            self.assertFalse(s.node_overlap('/var/lib-other', '/var/lib/k3s/models'))

    def test_actual_pv_directory_identities_reject_symlink_equal_and_bind_ancestry_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); first = base / 'one'; second = base / 'two'; first.mkdir(); second.mkdir()
            wanted = {'one': str(first), 'two': str(second)}
            request = {'version': 1, 'roots': [{'pvUID': uid, 'path': path} for uid, path in wanted.items()]}
            program = {'__name__': 'unit_fixture'}; exec(s.PV_IDENTITIES, program)
            device = str(os.major(first.stat().st_dev)) + ':' + str(os.minor(first.stat().st_dev))
            # Real directory identities use fixture mountinfo on this Mac. The
            # production entry point always reads the owning host's kernel file.
            mounts = '1 0 ' + device + ' / / rw - fixture fixture rw\n'
            observed = program['observe'](request['roots'], lambda: mounts)
            self.assertTrue(s.distinct_pv_identities(observed, wanted, ['one'])['readOnly'])
            for fault in ['same-root', 'ancestor', 'child']:
                mutated = copy.deepcopy(observed); one, two = mutated['roots']
                if fault == 'same-root': two['root'].update({k: one['root'][k] for k in ['device', 'inode']})
                elif fault == 'ancestor': two['root'].update({k: one['ancestors'][-1][k] for k in ['device', 'inode']})
                else: two['ancestors'][-1].update({k: one['root'][k] for k in ['device', 'inode']})
                with self.subTest(fault=fault), self.assertRaises(RuntimeError): s.distinct_pv_identities(mutated, wanted, ['one'])
            bind = mounts + '2 1 ' + device + ' ' + str(first / 'private-subdir') + ' ' + str(second) + ' rw - fixture fixture rw\n'
            bound = program['observe'](request['roots'], lambda: bind)
            self.assertNotEqual(bound['roots'][0]['root']['inode'], bound['roots'][1]['root']['inode'])
            with self.assertRaises(RuntimeError): s.distinct_pv_identities(bound, wanted, ['one'])
            # Linux dev_t 2049 denotes 8:1; a Darwin operator must preserve the
            # host's pair rather than apply its own dev_t decoding rules.
            linux = copy.deepcopy(observed)
            for row in linux['roots']:
                for actual in [*row['ancestors'], row['root']]: actual.update({'device': 2049, 'deviceMajorMinor': '8:1'})
                row['mapping']['device'] = '8:1'
            self.assertTrue(s.distinct_pv_identities(linux, wanted, ['one'])['readOnly'])
            changed = iter([mounts, bind])
            with self.assertRaises(RuntimeError): program['observe'](request['roots'], lambda: next(changed))
            with self.assertRaises(RuntimeError): program['observe'](request['roots'], lambda: mounts + mounts)
            alias = base / 'symlink'; alias.symlink_to(first, target_is_directory=True)
            request['roots'][1]['path'] = str(alias)
            with self.assertRaises(RuntimeError): program['observe'](request['roots'], lambda: mounts)

    def test_unresolved_foreign_pv_backend_refuses_before_host_probe(self):
        op = self.stage(); calls = []; op.host_python = lambda *args, **kwargs: calls.append(args)
        pv = {'metadata': {'uid': 'foreign'}, 'spec': {'csi': {'driver': 'unreviewed', 'volumeHandle': 'unknown'}}}
        with self.assertRaises(RuntimeError): op.physical_backings([pv], ['selected'])
        self.assertEqual(calls, [])

    def test_read_only_inspections_keep_original_stage_and_use_distinct_command_journals(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); op = self.stage(); op.out = base / 'original-stage'; op.out.mkdir(); op.root = base / 'physical-root'; op.root.mkdir()
            original = op.out / 'copy.uncertain.json'; original.write_bytes(b'original failed attempt')
            before = original.read_bytes(); op.path = base / 'input'; op.input_sha = 'a' * 64
            op.absent = lambda *args: True
            op.fresh = lambda *args: op.run([sys.executable, '-c', 'print("read-only fixture response")'])
            for name in ['observation-one', 'observation-two']:
                output = base / name; ref = op.inspect(output)
                value = json.loads(Path(ref['path']).read_bytes())
                self.assertFalse(value['phaseAdopted']); self.assertFalse(value['productionMutation'])
                self.assertTrue(list(output.glob('command-*.stdout.original')))
            self.assertEqual(original.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in op.out.iterdir()), ['copy.uncertain.json'])
            with self.assertRaises(RuntimeError): op.inspect(base / 'observation-one')
            with self.assertRaises(RuntimeError): op.inspect(op.root / 'bad-observation')
            self.assertFalse((op.root / 'bad-observation').exists())

    def test_publication_command_originals_never_rewrite_retired_stage_and_restore_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); op = self.stage(); op.out = base / 'retired'; op.out.mkdir()
            marker = op.out / 'retire.accepted.json'; marker.write_bytes(b'original retired stage')
            pub = object.__new__(p.Publication); pub.stage = op; pub.out = base / 'publication'; pub.out.mkdir()
            original_run, original_save = op.run, op.save
            pub.with_journal(lambda: op.run([sys.executable, '-c', 'print("fresh observation")']))
            with self.assertRaises(RuntimeError): pub.with_journal(lambda: op.run([sys.executable, '-c', 'raise SystemExit(1)']))
            self.assertEqual(op.run, original_run); self.assertEqual(op.save, original_save); self.assertEqual(op.out, base / 'retired')
            self.assertEqual(marker.read_bytes(), b'original retired stage'); self.assertEqual(list(op.out.iterdir()), [marker])
            self.assertEqual(len(list(pub.out.glob('command-*.actual.json'))), 2)

    def test_phase_cannot_record_acceptance_if_actual_details_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            op = self.stage(); op.out = Path(directory); op.input_sha = 'a' * 64; op.operator_sha = 'b' * 64
            op.value['prepared'] = {'path': '/reviewed/prepared.json', 'sha256': 'c' * 64}; op.unchanged = lambda: None
            save = op.save
            def fail_details(name, value):
                if name.endswith('.details.actual.json'): raise OSError('actual disk write failed')
                return save(name, value)
            op.save = fail_details
            def fn(): op.events.append({'path': '/unit/actual-command', 'sha256': 'd' * 64}); return {'unit': True}
            with self.assertRaises(OSError): op.phase('copy', fn)
            self.assertFalse((op.out / 'copy.accepted.json').exists()); self.assertTrue((op.out / 'copy.uncertain.json').exists())


class TlsTransport(unittest.TestCase):
    def test_normal_tls_exact_origin_fixed_control_paths_and_stream_bound(self):
        import ssl
        calls = []
        class Response:
            status = 404
            def __init__(self): self.body = b'xx'
            def getheaders(self): return [('Cache-Control', 'private, no-store, max-age=0, no-transform')]
            def read(self, count): body, self.body = self.body[:count], self.body[count:]; return body
        class Connection:
            def __init__(self, host, port, timeout, context):
                self.asserted = (host, port, timeout); self.context = context
                if context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname: raise AssertionError('TLS trust relaxed')
            def request(self, method, path, headers): calls.append((method, path, headers))
            def getresponse(self): return Response()
            def close(self): pass
        verifier = type('Verifier', (), {})()
        def verify(value):
            for path in ['/.delivery-etags.conf', '/healthz', '/models/unit/weights.onnx']:
                response = verifier.request(value['origin'], 'GET', path, {}, 2)
                self.assertEqual(response['size'], 2)
            with self.assertRaises(RuntimeError): verifier.request(value['origin'], 'GET', '/models/unit/weights.onnx', {}, 1)
            with self.assertRaises(RuntimeError): verifier.request('https://other.example', 'GET', '/models/unit/weights.onnx', {}, 2)
            with self.assertRaises(RuntimeError): verifier.request(value['origin'], 'GET', '/api/', {}, 2)
            return {'scope': 'unit fake transport only'}
        verifier.verify = verify
        with patch.object(h, 'module', return_value=verifier), patch.object(h.http.client, 'HTTPSConnection', Connection):
            h.verify_models_tls('https://example.net', [{'url': '/models/unit/weights.onnx', 'size': 2, 'sha256': 'a' * 64}])
        self.assertEqual(len(calls), 4); self.assertTrue(all('Cookie' not in headers and 'Authorization' not in headers for _, _, headers in calls))


class OwningPod(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('owned_binder_fixture', Path(__file__).with_name('test_public_delivery_lifecycle.py'))
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        self.fixture = fixtures.Lifecycle(); self.fixture.setUp(); self.before = self.fixture.before
        self.op = object.__new__(s.Stage); self.op.target = {'node': {'name': 'node'}}; self.op.namespace = 'customer-apps'
        self.op.before = self.before
        self.replica = {'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'metadata': {'name': 'actual-rs', 'uid': 'actual-rs-uid', 'namespace': 'customer-apps',
            'labels': {'pod-template-hash': 'abc123'}, 'ownerReferences': [{'kind': 'Deployment', 'uid': self.before['metadata']['uid'], 'controller': True}]}}
        self.pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'actual-native', 'namespace': 'customer-apps', 'uid': 'actual-native-uid',
            'labels': {**self.before['spec']['template']['metadata']['labels'], 'pod-template-hash': 'abc123'},
            'annotations': copy.deepcopy(self.before['spec']['template']['metadata']['annotations']),
            'ownerReferences': [{'kind': 'ReplicaSet', 'name': 'actual-rs', 'uid': 'actual-rs-uid', 'controller': True}]},
            'spec': {**copy.deepcopy(self.before['spec']['template']['spec']), 'nodeName': 'node', 'dnsPolicy': 'ClusterFirst', 'schedulerName': 'default-scheduler',
                'terminationGracePeriodSeconds': 30, 'serviceAccountName': 'default', 'priority': 0, 'preemptionPolicy': 'PreemptLowerPriority'},
            'status': {'containerStatuses': [{'name': 'native', 'ready': True, 'restartCount': 0, 'imageID': self.fixture.image}]}}
        self.op.get = lambda *args: self.replica

    def tearDown(self): self.fixture.tearDown()

    def owner(self, pod): return self.op.public_owner([self.before], {'items': [pod]}, self.before['spec'])

    def test_full_template_with_explicit_ordinary_api_defaults_and_node_placement(self):
        self.assertEqual(self.owner(self.pod), self.pod)
        for field, value in [('hostNetwork', True), ('hostPID', True), ('hostIPC', True), ('shareProcessNamespace', True),
                             ('automountServiceAccountToken', True), ('nodeName', 'unreviewed-node'), ('schedulerName', 'unreviewed-scheduler')]:
            changed = copy.deepcopy(self.pod); changed['spec'][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError): self.owner(changed)
        changed = copy.deepcopy(self.pod); changed['spec']['initContainers'] = [{'name': 'injected', 'image': 'unreviewed'}]
        with self.assertRaises(RuntimeError): self.owner(changed)

    def test_metadata_replacement_exposure_and_security_drift_refused(self):
        for kind in ['label', 'annotation', 'owner', 'security']:
            changed = copy.deepcopy(self.pod)
            if kind == 'label': changed['metadata']['labels']['exposure'] = 'unreviewed'
            elif kind == 'annotation': changed['metadata']['annotations']['container.apparmor.security.beta.kubernetes.io/native'] = 'unconfined'
            elif kind == 'owner': changed['metadata']['ownerReferences'][0]['uid'] = 'replacement'
            else: changed['spec']['securityContext']['runAsUser'] = 0
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): self.owner(changed)

    def test_observe_and_rollback_reach_the_same_full_owner_fence(self):
        self.pod['spec']['hostNetwork'] = True
        self.op.fresh = lambda allowed=None, after=None: self.op.public_owner([self.before], {'items': [self.pod]}, after or self.before['spec'])
        self.op.remote = lambda *args, **kwargs: b''
        pub = object.__new__(p.Publication); pub.stage = self.op; pub.desired = self.before['spec']
        pub.prior = lambda *args: None; pub.with_journal = lambda fn: fn(); pub.phase = lambda name, fn: fn()
        for method in [pub.observe, pub.rollback]:
            with self.subTest(method=method.__name__), self.assertRaises(RuntimeError): method()


class Constructor(unittest.TestCase):
    def test_full_local_constructor_real_p256_and_source_closure_without_target(self):
        # The adapter registry, CI and Kubernetes captures here are synthetic
        # unit fixtures. Crypto, bytes, coding/map compilation and constructor
        # execution are real; no target/runtime acceptance is claimed.
        spec = importlib.util.spec_from_file_location('runtime_binder_fixture', Path(__file__).with_name('test_public_delivery_lifecycle.py'))
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        f = fixtures.Lifecycle(); f.setUp()
        try:
            node = str(fixtures.NODE); roots = [f.base / 'old', f.base / 'candidate']
            maker = r'''const{generateKeyPairSync,createHash,sign}=require('node:crypto');const{writeFileSync,mkdirSync}=require('node:fs');const{join}=require('node:path');
const roots=JSON.parse(process.argv[1]);const keys=generateKeyPairSync('ec',{namedCurve:'P-256'});const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;const raw=v=>JSON.stringify(stable(v));const hash=v=>createHash('sha256').update(v).digest('hex');
const tool=Buffer.from('{"id":"fixture"}'),index=Buffer.from('{"tools":[{"id":"fixture"}]}');const files={'fixture/tool.json':hash(tool)};const dir=hash(raw({'tool.json':hash(tool)}));const unsigned={alg:'ECDSA-P256-SHA256',keyId:'unit-public-key',signedAt:'2026-10-12T00:00:00Z',seq:1,indexHash:hash(index),files,toolDirs:{fixture:dir}};
const envelope={...unsigned,signature:sign('sha256',Buffer.from(raw(unsigned)),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
for(const root of roots){for(const path of ['tools/fixture','tools/fixture@'+dir.slice(0,16),'catalog/tools','info'])mkdirSync(join(root,path),{recursive:true});writeFileSync(join(root,'tools/fixture/tool.json'),tool);writeFileSync(join(root,'tools/fixture@'+dir.slice(0,16)+'/tool.json'),tool);writeFileSync(join(root,'catalog/tools/index.json'),index);writeFileSync(join(root,'catalog/tools/index.'+hash(index).slice(0,16)+'.json'),index);writeFileSync(join(root,'catalog/tools/index.sig.json'),JSON.stringify(envelope));writeFileSync(join(root,'info/index.html'),'public docs');}
process.stdout.write(JSON.stringify(keys.publicKey.export({format:'jwk'})));'''
            made = subprocess.run([node, '-e', maker, json.dumps([str(r) for r in roots])], capture_output=True, check=True)
            pin = f.put(json.loads(made.stdout))
            def manifest(root): return s.l.a.tree({path.relative_to(root).as_posix(): {'path': path.relative_to(root).as_posix(), 'size': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in root.rglob('*') if path.is_file()})
            previous = manifest(roots[0]); previous_ref = f.put(previous)
            candidate_manifest = manifest(roots[1])
            assembly = s.l.a.assemble(str(roots[1]), str(roots[0]), candidate_manifest, previous, s.l.held(f.models)['files'], f.base / 'real-assembly', SCRIPTS / 'public-delivery-map.mjs',
                {'path': node, 'sha256': s.l.a.checksum(Path(node))}, mode='frontend', candidate_custody=f.public_build(roots[1], candidate_manifest))
            before = copy.deepcopy(f.before); before['metadata']['generation'] = 1
            before['spec']['template']['metadata']['annotations'].update({'lolly.tools/full-root-manifest': previous_ref['sha256'], 'lolly.tools/delivery-etags-sha256': s.l.a.overlay.manifest(previous)[s.l.a.overlay.MAP]['sha256']})
            owner = copy.deepcopy(f.owner); owner['metadata']['ownerReferences'] = [{'kind': 'ReplicaSet', 'name': 'actual-rs', 'uid': 'rs', 'controller': True}]
            replica = {'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'metadata': {'name': 'actual-rs', 'namespace': 'customer-apps', 'uid': 'rs', 'resourceVersion': '3', 'ownerReferences': [{'kind': 'Deployment', 'uid': before['metadata']['uid'], 'controller': True}]}}
            baseline = copy.deepcopy(f.baseline); baseline['deployments'][0] = before
            def pair(name):
                claim = {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': name, 'namespace': 'customer-apps', 'uid': name + '-uid', 'resourceVersion': '3'}, 'spec': {'volumeName': name + '-pv', 'storageClassName': 'local-path', 'accessModes': ['ReadWriteOnce'], 'volumeMode': 'Filesystem', 'resources': {'requests': {'storage': '1Gi'}}}, 'status': {'phase': 'Bound'}}
                pv = {'apiVersion': 'v1', 'kind': 'PersistentVolume', 'metadata': {'name': name + '-pv', 'uid': name + '-pv-uid', 'resourceVersion': '3'}, 'spec': {'local': {'path': '/var/lib/lolly/' + name}, 'storageClassName': 'local-path', 'capacity': {'storage': '1Gi'}, 'volumeMode': 'Filesystem', 'accessModes': ['ReadWriteOnce'], 'claimRef': {'namespace': 'customer-apps', 'name': name, 'uid': claim['metadata']['uid']}, 'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': ['customer-node']}]}]}}}, 'status': {'phase': 'Bound'}}
                return {'claim': claim, 'pv': pv}
            pairs = [pair('active-site'), pair('active-models')]
            baseline['pods']['items'] = [owner]; baseline['pvcs']['items'] = [v['claim'] for v in pairs]; baseline['pvs']['items'] = [v['pv'] for v in pairs]
            target = {'version': 1, 'clusterUID': 'cluster', 'node': {'name': 'customer-node', 'uid': 'node'}, 'transport': {'type': 'local', 'kubectl': ['/usr/local/bin/k3s', 'kubectl'], 'kubeconfig': '/unit/kubeconfig', 'context': 'unit-context'},
                'components': {'public-web': {'namespace': 'customer-apps', 'namespaceUID': 'namespace', 'deployment': 'my-native-site', 'deploymentUID': 'web-owner', 'container': 'native'}}}
            def metadata(pair):
                path = Path(pair['pv']['spec']['local']['path'])
                row = lambda p: {'path': str(p), 'device': 17, 'inode': int(hashlib.sha256(str(p).encode()).hexdigest()[:8], 16) + 1, 'mode': 0o2770, 'uid': 0, 'gid': 101}
                return {'version': 1, 'status': 'READ_ONLY_PUBLIC_LOCAL_PV_ROOT_METADATA_OBSERVED', 'clusterUID': 'cluster', 'node': target['node'], 'claimUID': pair['claim']['metadata']['uid'], 'pvUID': pair['pv']['metadata']['uid'], 'pvSpecSha256': s.cohort.digest(pair['pv']['spec']), 'root': {**row(path), 'selinuxLabel': 'system_u:object_r:container_file_t:s0:c1,c2'}, 'ancestors': [row(p) for p in reversed(path.parents)], 'readOnly': True, 'productionMutation': False}
            context = {'version': 1, 'owner': owner, 'replicaSet': replica, 'storageClass': {'apiVersion': 'storage.k8s.io/v1', 'kind': 'StorageClass', 'metadata': {'name': 'local-path', 'uid': 'storage', 'resourceVersion': '3'}, 'provisioner': 'rancher.io/local-path', 'volumeBindingMode': 'WaitForFirstConsumer'},
                'namespaces': [{'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': ns, 'uid': 'namespace' if ns == 'customer-apps' else 'other', 'resourceVersion': '3'}} for ns in ['customer-apps', 'other-team']],
                'sourceRoots': [{**v, 'metadata': metadata(v)} for v in pairs], 'configPaths': {'default.conf': '/etc/nginx/conf.d/default.conf'}, 'origin': 'https://example.net'}
            verifier = f.base / 'fixture-verifier.mjs'
            verifier.write_text(r'''import{readFileSync}from'node:fs';import{join}from'node:path';import{createPublicKey,verify,createHash}from'node:crypto';const args=process.argv.slice(2),root=args[args.indexOf('--root')+1],pin=JSON.parse(readFileSync(args[args.indexOf('--public-key')+1]));const e=JSON.parse(readFileSync(join(root,'catalog/tools/index.sig.json')));const{signature,...unsigned}=e;const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;const hash=v=>createHash('sha256').update(v).digest('hex');if(pin.d||!verify('sha256',Buffer.from(JSON.stringify(stable(unsigned))),{key:createPublicKey({key:pin,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64'))||hash(readFileSync(join(root,'catalog/tools/index.json')))!==e.indexHash)throw Error('real signature/index refused');for(const[path,want]of Object.entries(e.files)){if(hash(readFileSync(join(root,'tools',path)))!==want)throw Error('full signed file refused');const[id,...parts]=path.split('/');if(hash(readFileSync(join(root,'tools',id+'@'+e.toolDirs[id].slice(0,16),...parts)))!==want)throw Error('hashed alias refused');}process.stdout.write(JSON.stringify({verified:true,files:Object.keys(e.files).length,tools:Object.keys(e.toolDirs).length}));''')
            ref = lambda p: {'path': str(p), 'sha256': s.l.a.checksum(p)}
            preflight = f.base / 'preflight.py'; preflight.write_text('raise RuntimeError("unit target must never execute")\n')
            host = f.base / 'host.py'; host.write_text('raise RuntimeError("unit host must never execute")\n')
            sources = [ref(SCRIPTS / name) for name in sorted(s.SOURCE_NAMES)] + [ref(verifier), ref(preflight), ref(host)]
            review = {'version': 1, 'status': 'ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE', 'source': ref(SCRIPTS / 'stage-public-delivery.py'), 'sources': sources, 'capabilities': sorted(s.l.CAPABILITIES), 'stages': s.l.STAGES, 'productionMutation': False}
            adapter = {**{k: v for k, v in review.items() if k != 'productionMutation'}, 'status': 'ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER', 'review': f.put(review)}
            accepted = s.l.held(f.value['refs']['acceptedRelease']); accepted.update({'deploymentSpecSha256': s.l.digest(before['spec']), 'manifestSha256': previous_ref['sha256'], 'mapSha256': s.l.a.overlay.manifest(previous)[s.l.a.overlay.MAP]['sha256'], 'publicPin': pin})
            value = copy.deepcopy(f.value); value['refs'].update({'deployment': f.put(before), 'baseline': f.put(baseline), 'assembly': assembly, 'previousManifest': previous_ref, 'acceptedRelease': f.put(accepted), 'adapterReview': f.put(adapter)})
            value['outputDirectory'] = str(f.base / 'new-preparation'); preparation_input = f.put(value); prepared = s.l.prepare(value, preparation_input); prepared_ref = f.put(prepared)
            runtime = {'version': 1, 'status': 'REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED', 'prepared': prepared_ref, 'target': f.put(target), 'context': f.put(context), 'programs': {'preflight': ref(preflight), 'hostProbe': ref(host), 'node': ref(Path(node)), 'signatureVerifier': ref(verifier)}, 'sources': sources, 'outputDirectory': str(f.base / 'new-stage')}
            runtime_ref = f.put(runtime)
            op = s.Stage(runtime_ref['path'], runtime_ref['sha256'], ref(SCRIPTS / 'stage-public-delivery.py')['sha256'])
            self.assertTrue(op.local_signature['verified']); self.assertEqual(op.local_map['mapSha256'], prepared['mapSha256']); self.assertFalse(op.out.exists())
            # A rehashed changed signed file and an otherwise coherent physical
            # manifest still fail the independent P256/full-file boundary.
            path = op.root / 'tools/fixture/tool.json'; path.write_bytes(b'{"id":"tampered"}'); path.chmod(0o644); os.utime(path, ns=(0, 0))
            op.manifest = manifest(op.root)
            with self.assertRaises(RuntimeError): op.verify_local()
        finally: f.tearDown()


class PublicationHandoff(unittest.TestCase):
    """Exercise the real observe/phase/handoff path with target DATA fixtures."""
    def setUp(self):
        spec = importlib.util.spec_from_file_location('publication_receipt_fixture', Path(__file__).with_name('test_public_delivery_lifecycle.py'))
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        self.f = fixtures.PublicationHandoff(); self.f.setUp(); f = self.f
        # These are synthetic receipts owned by this temporary fixture only.
        # The real publisher must create its own observe intent/evidence/receipt.
        observe = s.l.held(f.proof['phases']['observe']['accepted'])
        for ref in [*observe['evidence'].values(), *f.proof['phases']['observe'].values()]: Path(ref['path']).unlink()
        self.stage = object.__new__(s.Stage); stage = self.stage
        stage.events = []; stage.prepared = f.prepared; stage.target = {'node': {'name': 'customer-node'}}
        stage.before = f.f.before; stage.namespace = 'customer-apps'
        stage.owner = copy.deepcopy(f.bundle['pod']); stage.replica = copy.deepcopy(f.bundle['replicaSet'])
        stage.context = {'origin': 'https://unit.invalid'}; stage.rows = s.l.held(f.prepared['manifest'])['files']
        stage.models = s.l.held(f.f.models)['files']
        stage.remote = lambda *args, **kwargs: stage.events.append(f.command('observe-actual')) or b''
        stage.physical = lambda key, models=False, owner=False: copy.deepcopy(f.physical['models' if models else 'static'])
        stage.measure = lambda owner=False: copy.deepcopy(f.memory)
        stage.native_http = lambda owner: copy.deepcopy(f.native_http)
        self.pub = object.__new__(p.Publication); pub = self.pub
        pub.stage = stage; pub.out = f.out; pub.path = Path(f.input['path']); pub.input_sha = f.input['sha256']; pub.operator_sha = f.operator['sha256']
        pub.with_journal = lambda fn: fn()  # target transport is forbidden in this fixture
        pub.fresh = lambda after=False: copy.deepcopy(f.bundle['deployment'])
        self.http = type('HTTPDataFixture', (), {'verify_models_tls': lambda *_args: copy.deepcopy(f.models_tls),
            'verify_static_tls': lambda *_args: copy.deepcopy(f.static_tls)})

    def tearDown(self): self.f.tearDown()

    def test_real_observe_records_handoff_after_original_acceptance_and_refuses_replay(self):
        with patch.object(p.s, 'module', return_value=self.http): ref = self.pub.observe()
        self.assertEqual(Path(ref['path']).name, 'observe.accepted.json')
        accepted = json.loads((self.f.out / 'accepted-release.actual.json').read_bytes())
        self.assertEqual(accepted, s.l.publication_baseline(accepted['publication']))
        handoff = json.loads((self.f.out / 'handoff.accepted.json').read_bytes())
        self.assertEqual(handoff['observation'], ref); self.assertFalse(handoff['productionMutation']); self.assertFalse(handoff['browserAcceptanceClaimed'])
        with patch.object(p.s, 'module', return_value=self.http), self.assertRaises(FileExistsError): self.pub.observe()

    def test_owner_change_never_emits_observe_or_baseline_acceptance(self):
        calls = []
        def changed(after=False):
            calls.append(after)
            if len(calls) == 2: self.stage.owner['status']['containerStatuses'][0]['containerID'] = 'containerd://replacement'
            return copy.deepcopy(self.f.bundle['deployment'])
        self.pub.fresh = changed
        with patch.object(p.s, 'module', return_value=self.http), self.assertRaises(RuntimeError): self.pub.observe()
        self.assertFalse((self.f.out / 'observe.accepted.json').exists()); self.assertFalse((self.f.out / 'accepted-release.actual.json').exists())
        self.assertTrue((self.f.out / 'observe.uncertain.json').exists())

    def test_http_failure_never_emits_observe_or_baseline_acceptance(self):
        def failed(*args): raise RuntimeError('actual TLS oracle refused')
        self.http.verify_models_tls = failed
        with patch.object(p.s, 'module', return_value=self.http), self.assertRaisesRegex(RuntimeError, 'TLS oracle refused'): self.pub.observe()
        self.assertFalse((self.f.out / 'observe.accepted.json').exists()); self.assertFalse((self.f.out / 'accepted-release.actual.json').exists())
        self.assertTrue((self.f.out / 'observe.uncertain.json').exists())

    def test_local_handoff_failure_preserves_verified_observation_without_baseline(self):
        with patch.object(p.s, 'module', return_value=self.http), patch.object(p.s.l, 'publication_baseline', side_effect=RuntimeError('held evidence refused')):
            with self.assertRaises(RuntimeError): self.pub.observe()
        self.assertTrue((self.f.out / 'observe.accepted.json').exists()); self.assertTrue((self.f.out / 'handoff.uncertain.json').exists())
        self.assertFalse((self.f.out / 'accepted-release.actual.json').exists()); self.assertFalse((self.f.out / 'handoff.accepted.json').exists())


if __name__ == '__main__': unittest.main()
