#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline frontend facade checks on explicitly synthetic accepted fixtures."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
SCRIPT = HERE / 'scripts/update-private-shell.py'
spec = importlib.util.spec_from_file_location('shell_update', SCRIPT)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location('shell_stage_fixture', Path(__file__).with_name('test_stage_private_shell.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
spec = importlib.util.spec_from_file_location('shell_publication_fixture', Path(__file__).with_name('test_publish_private_shell.py'))
publication_fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(publication_fixture)


class Portable(fixture.Inputs):
    def binary(self, name, value):
        ref = super().binary(name, value)
        ref['path'] = str(self.base / ref['path'])
        return ref

    def file(self, name, value):
        ref = super().file(name, value)
        ref['path'] = str(self.base / ref['path'])
        return ref


class Offline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Portable.setUpClass()

    def setUp(self):
        self.f = Portable(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.base = self.f.base
        self.guard = m.file_ref(self.f.preflight)
        sources = [HERE / 'scripts' / name for name in m.DEPENDENCIES]
        sources += [Path(ref['path']) for ref in self.f.stage_input['programs'].values()]
        sources.append(self.f.preflight)
        command = {'argv': [sys.executable, '-B', str(self.f.preflight)], 'source': self.guard}
        self.profile = {'version': 1, 'status': 'REVIEWED_PRIVATE_SHELL_UPDATE_PROFILE', 'name': 'synthetic-private', 'target': self.f.stage_input['target'],
            'previous': self.f.stage_input['previous'], 'previousShell': self.f.stage_input['previousShell'], 'publicKey': self.f.stage_input['publicKey'], 'sourceMap': self.f.stage_input['sourceMap'],
            'preflight': copy.deepcopy(command), 'hostProbe': self.guard, 'retiredMountProbe': copy.deepcopy(command), 'programs': self.f.stage_input['programs'],
            'names': self.f.stage_input['names'], 'storage': self.f.stage_input['storage'], 'mounts': self.f.evidence['mounts'], 'minimumFreeBytes': 8 * 1024**3,
            'maximumWriteBytes': 3 * 1024**3, 'ownerSealSha256': None, 'sourceFiles': [m.file_ref(path) for path in sources]}
        self.profile_ref = self.f.file('synthetic-profile', self.profile)
        self.prepared_ref = self.f.stage_input['prepared']
        self.capture_ref = self.capture(False)

    def capture(self, after):
        f = self.f
        collection = lambda api, kind, items: {'apiVersion': api, 'kind': kind, 'metadata': {'resourceVersion': ''}, 'items': copy.deepcopy(items)}
        values = f.facts['resources'] if after else f.baseline['resources']
        pods = copy.deepcopy(f.baseline['pods'])
        rs = {'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'metadata': {**f.meta('work-rs', 'accepted-rs-uid', 'private'),
              'ownerReferences': [{'kind': 'Deployment', 'name': 'work', 'uid': 'deployment-uid', 'controller': True}]}, 'spec': {'replicas': 1}}
        meta = lambda name, uid: {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': f.meta(name, uid)}
        node = {'apiVersion': 'v1', 'kind': 'Node', 'metadata': f.meta('fixture-node', 'node-uid'), 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        response = {'version': 1, 'status': 'READ_ONLY_PRIVATE_SHELL_RESOURCES_CAPTURED', 'targetSha256': self.profile['target']['sha256'],
            'systemNamespace': f.file('synthetic-system-original-' + str(after), meta('kube-system', 'cluster-uid')), 'node': f.file('synthetic-node-original-' + str(after), node),
            'namespaces': {'private': f.file('synthetic-namespace-original-' + str(after), f.facts['namespace'])},
            'deployments': {'private': f.file('synthetic-deployments-original-' + str(after), collection('v1', 'List', [f.before]))},
            'pods': f.file('synthetic-pods-original-' + str(after), pods),
            'claims': f.file('synthetic-claims-original-' + str(after), collection('v1', 'List', [v for v in values if v['kind'] == 'PersistentVolumeClaim'])),
            'volumes': f.file('synthetic-volumes-original-' + str(after), collection('v1', 'List', [v for v in values if v['kind'] == 'PersistentVolume'])),
            'pin': f.file('synthetic-pin-original-' + str(after), next(v for v in values if v['kind'] == 'ConfigMap')),
            'storageClass': f.file('synthetic-class-original-' + str(after), f.baseline['storageClass']), 'replicaSet': f.file('synthetic-rs-original-' + str(after), rs)}
        return f.file('synthetic-capture-' + str(after), response)

    def operation(self):
        return m.Update(self.profile_ref['path'], self.profile_ref['sha256'], self.prepared_ref['path'], self.prepared_ref['sha256'], m.file_ref(SCRIPT)['sha256'])

    def check(self):
        operation = self.operation(); out = m.private_new_directory(self.base / 'offline-check')
        return operation, operation.assemble_check(self.capture_ref, out)

    def test_offline_check_preserves_raw_generic_collections_and_never_calls_target(self):
        capture = json.loads(Path(self.capture_ref['path']).read_bytes())
        originals = {ref['path']: Path(ref['path']).read_bytes() for ref in [capture['claims'], capture['volumes'], capture['deployments']['private']]}
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('Offline target calls forbidden')):
            _, ref = self.check()
        value = json.loads(Path(ref['path']).read_bytes())
        baseline = json.loads(Path(value['baseline']['path']).read_bytes())
        self.assertEqual(baseline['claims']['kind'], 'List'); self.assertEqual(baseline['claims']['metadata']['resourceVersion'], '')
        desired = json.loads(Path(value['resources']['path']).read_bytes())
        self.assertEqual(desired['writer']['spec']['volumes'][0]['persistentVolumeClaim']['claimName'], 'new-shell')
        self.assertEqual(desired['qualifier']['spec']['volumes'][1]['persistentVolumeClaim']['claimName'], 'temporary-pack')
        self.assertTrue(all(Path(path).read_bytes() == data for path, data in originals.items()))
        self.assertFalse(value['targetCalls']); self.assertFalse(value['productionMutation'])
        self.assertFalse((Path(ref['path']).parent / 'stage-execution').exists())

    def test_real_cli_check_then_plan_relocated_envelopes_pass_without_target_calls(self):
        out = self.base / 'cli-check'
        args = ['--profile', self.profile_ref['path'], '--profile-sha256', self.profile_ref['sha256'], '--prepared', self.prepared_ref['path'],
                '--prepared-sha256', self.prepared_ref['sha256'], '--operator-sha256', m.file_ref(SCRIPT)['sha256']]
        command = [sys.executable, *(['-O'] if sys.flags.optimize else []), '-B', str(SCRIPT), 'check', *args, '--capture', self.capture_ref['path'], '--capture-sha256', self.capture_ref['sha256'], '--out', str(out)]
        result = subprocess.run(command, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)
        checked = m.file_ref(out / 'check.actual.json')
        after = self.capture(True); stage_ref = self.f.evidence['stage']
        planned = self.base / 'cli-plan'
        command = [sys.executable, *(['-O'] if sys.flags.optimize else []), '-B', str(SCRIPT), 'plan', *args, '--capture', after['path'], '--capture-sha256', after['sha256'],
                   '--check', checked['path'], '--check-sha256', checked['sha256'], '--stage', stage_ref['path'], '--stage-sha256', stage_ref['sha256'], '--out', str(planned)]
        result = subprocess.run(command, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads((planned / 'private-shell.plan.json').read_bytes())
        self.assertEqual(plan['image'], self.f.previous['image']); self.assertEqual(plan['desiredSpec'], self.f.prepared['desiredSpec'])
        self.assertIs(json.loads((planned / 'publication.input.json').read_bytes())['globalPVInventoryGuarded'], True)
        self.assertEqual(list((planned / 'publication-execution').iterdir()), [])
        self.assertEqual(subprocess.run(command, capture_output=True, timeout=90).returncode, 1)

    def test_retired_mount_placeholders_bind_only_actual_originals_and_preserve_literal_arguments(self):
        self.profile['retiredMountProbe']['argv'] += ['--stage', '${stagePodUID}', '--writer', '${writerPodUID}', '--node', '${nodeUID}', '--target', '${targetPath}', '--literal', '$HOME']
        self.profile_ref = self.f.file('placeholder-profile', self.profile)
        operation, checked = self.check()
        out = m.private_new_directory(self.base / 'placeholder-plan')
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('Offline target calls forbidden')):
            ref = operation.assemble_plan(checked, self.capture(True), self.f.evidence['stage'], out)
        value = json.loads(Path(ref['path']).read_bytes())
        publication = json.loads(Path(value['publicationInput']['path']).read_bytes())
        self.assertEqual(publication['retiredMountProbe']['argv'][-10:], ['--stage', 'stage-uid', '--writer', 'writer-uid', '--node', 'node-uid', '--target', self.profile['target']['path'], '--literal', '$HOME'])
        self.assertEqual(publication['retiredMountProbe']['source'], self.profile['retiredMountProbe']['source'])
        self.assertIn('${stagePodUID}', json.loads(Path(self.profile_ref['path']).read_bytes())['retiredMountProbe']['argv'])
        held_paths = {r['path'] for r in publication['sourceFiles']}
        self.assertTrue(all(r['path'] in held_paths for r in self.f.stage['originalEvidence']))

    def test_retired_mount_unknown_partial_duplicate_or_changed_retirement_provenance_refuses(self):
        original = copy.deepcopy(self.profile)
        for index, arguments in enumerate((['${unknownUID}'], ['--uid=${stagePodUID}'], ['${stagePodUID}', '${stagePodUID}'])):
            candidate = copy.deepcopy(original); candidate['retiredMountProbe']['argv'] += arguments
            self.profile_ref = self.f.file('malformed-placeholder-' + str(index), candidate)
            with self.assertRaises(m.Refusal): self.operation()
        self.profile = original; self.profile['retiredMountProbe']['argv'] += ['${stagePodUID}', '${writerPodUID}', '${nodeUID}', '${targetPath}']
        self.profile_ref = self.f.file('bound-placeholder-profile', self.profile)
        operation, checked = self.check(); after = self.capture(True)
        raw_writer = json.loads(Path(self.f.stage['originalEvidence'][1]['path']).read_bytes())
        mutations = [lambda value: value.update(podAbsent=False), lambda value: value['pod']['spec'].update(nodeName='other-node'),
                     lambda value: value['pod']['metadata'].update(uid='stage-uid'), lambda value: value['pod']['metadata'].update(namespace='elsewhere')]
        for index, mutate in enumerate(mutations):
            proof = copy.deepcopy(raw_writer); mutate(proof)
            staged = copy.deepcopy(self.f.stage); staged['originalEvidence'][1] = self.f.file('bad-writer-retirement-' + str(index), proof)
            ref = self.f.file('bad-retired-stage-' + str(index), staged)
            with self.assertRaises((m.Refusal, m.planner.Refusal, m.planner.resources.Refusal, m.stage.resources.Refusal)):
                operation.assemble_plan(checked, after, ref, m.private_new_directory(self.base / ('bad-retirement-plan-' + str(index))))

    def literal_getter(self, captures, active=None, mutate=None):
        """Map actual literal GETs to original synthetic resource bytes only."""
        state = active if active is not None else {'after': False}
        calls = []
        def getter(argv, **kwargs):
            calls.append((argv, kwargs))
            require_args = ['--kubeconfig', '/synthetic/no-network.kubeconfig', '--context', 'synthetic-only', 'get']
            self.assertEqual(argv[1:6], require_args)
            args = argv[6:]; kind = args[0]
            self.assertIn(kind, {'namespace', 'node', 'deployments', 'pods', 'persistentvolumeclaims', 'persistentvolumes', 'configmap', 'storageclass', 'replicaset'})
            self.assertEqual(kwargs, {'stdin': subprocess.DEVNULL, 'capture_output': True, 'timeout': 100, 'check': False})
            raw = captures[state['after']]
            key = {'node': 'node', 'pods': 'pods', 'persistentvolumeclaims': 'claims', 'persistentvolumes': 'volumes',
                   'configmap': 'pin', 'storageclass': 'storageClass', 'replicaset': 'replicaSet'}.get(kind)
            if kind == 'namespace': ref = raw['systemNamespace'] if args[1] == 'kube-system' else raw['namespaces'][args[1]]
            elif kind == 'deployments': ref = raw['deployments'][args[args.index('--namespace') + 1]]
            else: ref = raw[key]
            result = SimpleNamespace(returncode=0, stdout=Path(ref['path']).read_bytes(), stderr=b'')
            if mutate: mutate(kind, result)
            return result
        return getter, calls

    def test_readonly_capture_retains_exact_original_stdout_and_only_literal_gets(self):
        operation = self.operation(); original = json.loads(Path(self.capture_ref['path']).read_bytes())
        getter, calls = self.literal_getter({False: original})
        out = m.private_new_directory(self.base / 'readonly-capture')
        ref = operation.read_capture(out, getter)
        saved = json.loads(Path(ref['path']).read_bytes())
        for key in ('claims', 'volumes', 'pods', 'pin'):
            self.assertEqual(Path(saved[key]['path']).read_bytes(), Path(original[key]['path']).read_bytes())
        self.assertEqual(len(calls), 10)
        self.assertTrue(all('get' in argv and not set(argv) & {'create', 'patch', 'delete', 'exec'} for argv, _ in calls))
        actual = json.loads((out / 'capture.actual.json').read_bytes())
        self.assertEqual(len(actual['commands']), len(calls)); self.assertFalse(actual['productionMutation'])
        with self.assertRaises(m.Refusal): operation.read_capture(out, getter)
        self.assertEqual(len(calls), 10)

    def test_readonly_failed_or_paginated_capture_preserves_original_and_never_retries(self):
        operation = self.operation(); original = json.loads(Path(self.capture_ref['path']).read_bytes())
        def failure(kind, result):
            if kind == 'persistentvolumeclaims':
                result.returncode = 1; result.stderr = b'synthetic refused GET original'
        getter, calls = self.literal_getter({False: original}, mutate=failure)
        out = m.private_new_directory(self.base / 'failed-capture')
        with self.assertRaises(m.Refusal): operation.read_capture(out, getter)
        self.assertEqual(sum('persistentvolumeclaims' in argv for argv, _ in calls), 1)

        self.assertEqual((out / 'claims.stderr.original').read_bytes(), b'synthetic refused GET original')
        self.assertTrue((out / 'capture.uncertain.json').exists()); self.assertFalse((out / 'capture.actual.json').exists())
        with self.assertRaises(m.Refusal): operation.read_capture(out, getter)
        self.assertEqual(sum('persistentvolumeclaims' in argv for argv, _ in calls), 1)


    def test_readonly_timeout_and_source_drift_keep_partial_originals_without_second_get(self):
        operation = self.operation()
        out = m.private_new_directory(self.base / 'timeout-capture'); calls = []
        def timeout(argv, **kwargs):
            calls.append(argv)
            raise subprocess.TimeoutExpired(argv, 100, output=b'{"partial":"synthetic only"', stderr=b'timed out original')
        with self.assertRaises(m.Refusal): operation.read_capture(out, timeout)
        self.assertEqual(len(calls), 1)
        self.assertEqual((out / 'system-namespace.stdout.original').read_bytes(), b'{"partial":"synthetic only"')
        self.assertIs(json.loads((out / 'system-namespace.command.original.json').read_bytes())['timedOut'], True)
        self.assertFalse((out / 'capture.actual.json').exists())
        other = m.private_new_directory(self.base / 'drift-capture')
        raw = json.loads(Path(self.capture_ref['path']).read_bytes())
        getter, reads = self.literal_getter({False: raw})
        def drift(argv, **kwargs):
            result = getter(argv, **kwargs); self.f.preflight.write_text('# synthetic helper drift\n'); return result
        with self.assertRaises(m.Refusal): operation.read_capture(other, drift)
        self.assertEqual(len(reads), 1)
        self.assertTrue((other / 'system-namespace.stdout.original').exists()); self.assertTrue((other / 'capture.uncertain.json').exists())

    def test_run_cli_refuses_cached_phase_arguments_before_any_output_or_command(self):
        out = self.base / 'never-created'
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'run', '--profile', self.profile_ref['path'], '--profile-sha256', self.profile_ref['sha256'],
            '--prepared', self.prepared_ref['path'], '--prepared-sha256', self.prepared_ref['sha256'], '--operator-sha256', m.file_ref(SCRIPT)['sha256'],
            '--capture', self.capture_ref['path'], '--capture-sha256', self.capture_ref['sha256'], '--out', str(out)], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1); self.assertFalse(out.exists())
    def run_transport(self, lost_apply=False, stage_failure=False):
        """Real maintained offline assembly/publication on synthetic transports."""
        self.f.target['components']['work']['healthURLs'] = ['https://example.test/health']
        self.profile['target'] = self.f.file('synthetic-runtime-target', self.f.target)
        self.profile_ref = self.f.file('synthetic-runtime-profile', self.profile)
        self.f.before['status'] = {'readyReplicas': 1, 'observedGeneration': 1}
        self.f.before['metadata']['generation'] = 1
        self.f.baseline['pods']['items'][0]['status']['phase'] = 'Running'
        captures = {after: json.loads(Path(self.capture(after)['path']).read_bytes()) for after in (False, True)}
        state = {'after': False}; getter, reads = self.literal_getter(captures, state)
        stage_calls, publications = [], []
        execute = m.stage.Stage.execute
        def execute_stage(stage, action):
            stage_calls.append(action)
            if action == 'check': return execute(stage, action)
            self.assertEqual(action, 'run')
            if stage_failure: raise m.Refusal('Synthetic retained ambiguous stage; no publication')
            state['after'] = True
            return {'stage': self.f.evidence['stage'], 'claimsRetained': True, 'activeProductionTupleMutated': False}
        fixture_case = self
        real_class = m.publisher.Publication
        class SyntheticPublication(real_class):
            def __init__(self, path, sha, operator, out):
                value = m.publisher.read({'path': path, 'sha256': sha}, Path(path).parent)
                baseline = m.publisher.read(value['refs']['baseline'], Path(path).parent)
                f = SimpleNamespace()
                f.plan = m.publisher.read(value['refs']['plan'], Path(path).parent); f.desired = f.plan['desiredSpec']
                f.deployments = copy.deepcopy(baseline['deployments']); f.resources = copy.deepcopy(fixture_case.f.facts['resources'])
                f.rs = copy.deepcopy(baseline['replicaSet']); f.old_owner = copy.deepcopy(baseline['owner'])
                f.pods = [f.old_owner]; f.policies = []; f.image = f.plan['image']
                f.content = {'version': 1, 'shell': m.publisher.read(value['refs']['shellManifest'], Path(path).parent),
                             'pack': m.publisher.read(value['refs']['packManifest'], Path(path).parent), 'pinSha256': value['refs']['enginePin']['sha256']}
                pin = json.loads(Path(fixture_case.profile['publicKey']['path']).read_bytes())
                f.content['catalog'] = {**fixture_case.f.stage['catalog'], 'publicPinSha256': m.publisher.digest(pin), 'signatureVerified': True}
                f.owner = publication_fixture.Phases.owner; f.publish_owner = lambda: publication_fixture.Phases.publish_owner(f)
                kube = publication_fixture.FakeKube(f); kube.lost_response = lost_apply
                def command(argv, **kwargs):
                    return SimpleNamespace(returncode=0, stdout=json.dumps({'version': 1, 'stagePodUID': 'stage-uid', 'writerPodUID': 'writer-uid', 'nodeUID': 'node-uid', 'mountsReleased': True}), stderr='')
                root = Path(fixture_case.f.prepare_evidence['shell']['root'])
                super().__init__(path, sha, operator, out, kube=kube, command_runner=command, health=lambda _: None,
                                 static_fetcher=lambda url, _: (root / urlsplit(url).path.lstrip('/')).read_bytes())
                self.fixture = f; publications.append(self)
        return getter, reads, execute_stage, SyntheticPublication, stage_calls, publications

    def test_explicit_run_hands_off_exactly_once_and_preserves_image_pack_pin_and_canary_scope(self):
        getter, reads, execute_stage, cls, stages, pubs = self.run_transport()
        operation = self.operation(); out = m.private_new_directory(self.base / 'run-once')
        with patch.object(m.subprocess, 'run', side_effect=getter), patch.object(m.stage.Stage, 'execute', execute_stage), patch.object(m.publisher, 'Publication', cls):
            ref = operation.run(out)
            with self.assertRaises(m.Refusal): operation.run(out)
        value = json.loads(Path(ref['path']).read_bytes())
        self.assertEqual(value['status'], 'PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED'); self.assertFalse(value['imageRebuilt'])
        self.assertEqual(len(reads), 20); self.assertEqual(stages, ['check', 'run'])
        self.assertEqual([dry for _, dry in pubs[-1].kube.patches], [True, False])
        self.assertEqual(pubs[-1].fixture.deployments['work']['spec'], self.f.prepared['desiredSpec'])
        accepted, _ = m.stage.shell.previous_record(value['acceptedPrevious'], m.cohort.Inputs(out))
        self.assertEqual(accepted['image'], self.f.previous['image']); self.assertEqual(accepted['pack'], self.f.previous['pack']); self.assertEqual(accepted['pin'], self.f.previous['pin'])
        self.assertFalse((out / 'run.uncertain.json').exists()); self.assertTrue(value['remainingAcceptance'])
        next_profile = json.loads(Path(value['nextProfile']['path']).read_bytes())
        self.assertEqual(next_profile['previous'], value['acceptedPrevious']); self.assertEqual(next_profile['previousShell'], operation.shell)
        self.assertEqual(next_profile['sourceFiles'], operation.profile['sourceFiles'])
        self.assertEqual(set(value['elapsedSecondsByPhase']), {'capture-before-stage', 'stage-check', 'stage-run', 'capture-after-stage', 'publication-plan', 'dryrun', 'apply', 'observe'})
        self.assertTrue(all(type(seconds) is float and seconds >= 0 for seconds in value['elapsedSecondsByPhase'].values()))
        # Run the complete maintained next preparation with the emitted profile
        # and its real accepted-previous parser, retaining synthetic provenance.
        evidence = copy.deepcopy(self.f.prepare_evidence)
        evidence['previous'], evidence['previousShell'] = next_profile['previous'], next_profile['previousShell']
        root = Path(operation.shell['root'])
        manifest = json.loads(Path(operation.shell['manifest']['path']).read_bytes())
        evidence['shell'] = self.f.tree('synthetic-next-merged', {entry['path']: (root / entry['path']).read_bytes() for entry in manifest['files']})
        evidence['selection']['shellClaim'] = 'second-new-shell'
        node = os.environ.get('LOLLY_TEST_NODE', 'node')
        classified = subprocess.run([node, str(HERE / 'scripts/classify-application-release.ts'), '--repo', str(self.f.roots['lolly']),
            '--base', self.f.sources['lolly'], '--candidate', self.f.sources['lolly']], capture_output=True, check=True)
        evidence['classification'] = self.f.file('synthetic-next-classification', json.loads(classified.stdout))
        result, held = m.stage.shell.prepare(evidence, self.base, self.f.public_pin_sha, node)
        self.assertEqual(result['previousCohortSha256'], value['acceptedPrevious']['sha256']); held.unchanged()

    def test_explicit_run_lost_apply_stops_without_replay_or_acceptance(self):
        getter, reads, execute_stage, cls, stages, pubs = self.run_transport(lost_apply=True)
        operation = self.operation(); out = m.private_new_directory(self.base / 'run-lost-response')
        with patch.object(m.subprocess, 'run', side_effect=getter), patch.object(m.stage.Stage, 'execute', execute_stage), patch.object(m.publisher, 'Publication', cls):
            with self.assertRaises(RuntimeError): operation.run(out)
            with self.assertRaises(m.Refusal): operation.run(out)
        self.assertEqual([dry for _, dry in pubs[-1].kube.patches], [True, False])
        self.assertEqual(stages, ['check', 'run']); self.assertEqual(len(reads), 20)
        self.assertEqual(json.loads((out / 'run.uncertain.json').read_bytes())['phase'], 'apply')
        self.assertTrue((pubs[-1].out / 'apply.uncertain.json').exists())
        self.assertFalse((out / 'instance-profile.next.json').exists())
        self.assertFalse((pubs[-1].out / 'observe.started.json').exists()); self.assertFalse((out / 'run.actual.json').exists())

    def test_explicit_run_ambiguous_stage_stops_before_new_capture_or_publication(self):
        getter, reads, execute_stage, cls, stages, pubs = self.run_transport(stage_failure=True)
        operation = self.operation(); out = m.private_new_directory(self.base / 'run-failed-stage')
        with patch.object(m.subprocess, 'run', side_effect=getter), patch.object(m.stage.Stage, 'execute', execute_stage), patch.object(m.publisher, 'Publication', cls):
            with self.assertRaises(m.Refusal): operation.run(out)
            with self.assertRaises(m.Refusal): operation.run(out)
        self.assertEqual(stages, ['check', 'run']); self.assertEqual(len(reads), 10); self.assertEqual(pubs, [])
        self.assertFalse((out / 'capture-after-stage').exists()); self.assertFalse((out / 'publication-plan').exists())
        self.assertEqual(json.loads((out / 'run.uncertain.json').read_bytes())['phase'], 'stage-run')
        self.assertFalse((out / 'run.actual.json').exists())
        self.assertFalse((out / 'instance-profile.next.json').exists())

    def test_stage_name_prefix_uses_prepared_identity_without_rewriting_selected_claim(self):
        self.profile['stageNamePrefix'] = 'synthetic-private'
        self.profile_ref = self.f.file('synthetic-derived-names-profile', self.profile)
        operation = self.operation()
        prefix = 'synthetic-private-' + self.prepared_ref['sha256'][:16]
        self.assertEqual(operation.profile['names'], {'writer': prefix + '-writer', 'qualifier': prefix + '-check', 'packClaim': prefix + '-pack', 'policy': prefix + '-deny'})
        self.assertEqual(operation.prepared['selection']['shellClaim'], 'new-shell')
        self.assertEqual(json.loads(Path(self.profile_ref['path']).read_bytes())['names'], self.profile['names'])

    def test_unknown_profile_closure_auth_command_or_boolean_budget_refuses(self):
        mutations = [lambda v: v.update(version=True), lambda v: v.update(extra='unknown'), lambda v: v['sourceFiles'].pop(0),
                     lambda v: v['preflight']['argv'].append('--unreviewed'), lambda v: v.update(minimumFreeBytes=True), lambda v: v['names'].update(packClaim='old-pack')]
        for index, change in enumerate(mutations):
            with self.subTest(index=index):
                value = copy.deepcopy(self.profile); change(value); self.profile_ref = self.f.file('wrong-profile-' + str(index), value)
                with self.assertRaises((m.Refusal, m.stage.resources.Refusal, m.updater.Refusal)):
                    operation = self.operation(); operation.assemble_check(self.capture_ref, m.private_new_directory(self.base / ('bad-check-' + str(index))))

    def test_capture_unknown_scope_pagination_duplicate_uid_or_resource_api_refuses(self):
        operation = self.operation()
        original = json.loads(Path(self.capture_ref['path']).read_bytes())
        cases = [lambda c: c['metadata'].update({'continue': 'more'}), lambda c: c['metadata'].update(remainingItemCount=1),
                 lambda c: c['metadata'].update(remainingItemCount=False), lambda c: c['items'].append(copy.deepcopy(c['items'][0])),
                 lambda c: c['items'][0].update(kind='Secret'), lambda c: c['items'][0].update(apiVersion='apps/v1'),
                 lambda c: c['items'][0]['metadata'].update(namespace='elsewhere'), lambda c: c['items'][0]['metadata'].update(resourceVersion='')]
        for index, change in enumerate(cases):
            value = copy.deepcopy(original); claims = json.loads(Path(original['claims']['path']).read_bytes()); change(claims)
            value['claims'] = self.f.file('wrong-claims-' + str(index), claims)
            ref = self.f.file('wrong-capture-' + str(index), value)
            with self.subTest(index=index), self.assertRaises((m.Refusal, m.stage.resources.Refusal)):
                operation.capture(ref)

    def test_changed_source_held_profile_or_prepared_refuses_without_target_calls(self):
        operation = self.operation()
        self.f.preflight.write_text('print("changed")\n')
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('Target calls forbidden')):
            with self.assertRaises(m.Refusal): operation.source_check()
        with self.assertRaises(m.Refusal): self.operation()

    def test_plan_live_stage_other_claim_owner_storage_alias_or_protected_spec_refuses(self):
        operation, checked = self.check(); after = self.capture(True)
        capture = json.loads(Path(after['path']).read_bytes())
        changes = [lambda v: v['pods'].append(copy.deepcopy(self.f.stage['pod'])),
                   lambda v: next(p for p in v['volumes'] if p['metadata']['name'] == 'pv-new-shell')['spec']['local'].update(path='/storage/old-pack-uid'),
                   lambda v: v['deployments'][0]['spec'].update(replicas=2)]
        for index, change in enumerate(changes):
            value = copy.deepcopy(capture)
            fields = {'pods': json.loads(Path(value['pods']['path']).read_bytes())['items'],
                      'volumes': json.loads(Path(value['volumes']['path']).read_bytes())['items'],
                      'deployments': json.loads(Path(value['deployments']['private']['path']).read_bytes())['items']}
            change(fields)
            for key in ('pods', 'volumes'):
                raw = json.loads(Path(value[key]['path']).read_bytes()); raw['items'] = fields[key]; value[key] = self.f.file('plan-bad-' + key + str(index), raw)
            raw = json.loads(Path(value['deployments']['private']['path']).read_bytes()); raw['items'] = fields['deployments']; value['deployments']['private'] = self.f.file('plan-bad-deployments' + str(index), raw)
            ref = self.f.file('plan-bad-capture' + str(index), value)
            with self.subTest(index=index), self.assertRaises((m.Refusal, m.stage.resources.Refusal, m.updater.Refusal, m.planner.Refusal)):
                operation.assemble_plan(checked, ref, self.f.evidence['stage'], m.private_new_directory(self.base / ('bad-plan-' + str(index))))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Offline(name) for name in Offline.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
