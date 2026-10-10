#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic offline Git/build/CI fixtures; no build or target qualification claim."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

m = load('input_adapter', Path(__file__).parents[1] / 'scripts/assemble-private-shell-input.py')
fixture = load('input_fixture', Path(__file__).with_name('test_prepare_private_shell.py'))
NODE = os.environ.get('LOLLY_TEST_NODE', 'node')


class AdapterTests(fixture.Shell):
    def binary(self, name, data):
        ref = super().binary(name, data)
        return {**ref, 'path': str(self.base / ref['path'])}

    def setUp(self):
        super().setUp()
        self.operator_sha = hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
        self.target = self.file('synthetic-target-never-executed', {'version': 1, 'notProduction': True})
        self.instance = {key: None for key in m.update.PROFILE_KEYS}
        self.instance.update(version=1, status='REVIEWED_PRIVATE_SHELL_UPDATE_PROFILE', name='fixture-private', target=self.target,
                             previous=self.evidence['previous'], previousShell=self.evidence['previousShell'], publicKey=self.evidence['publicPin'])
        self.profile = {'version': 1, 'status': 'REVIEWED_PRIVATE_SHELL_PREPARATION_PROFILE', 'instance': {'name': 'fixture-private', 'targetSha256': self.target['sha256']},
                        'work': self.evidence['work'], 'brand': self.evidence['brand'], 'profile': self.evidence['profile'],
                        'settings': {'catalogTrustMode': 'verified', 'requireAiPolicy': True, 'liveRelay': 'https://private.example/live', 'siteUrl': 'https://private.example'},
                        'rawPack': self.evidence['rawPack'], 'selection': {k: v for k, v in self.evidence['selection'].items() if k != 'shellClaim'},
                        'publicPinSha256': self.public_pin_sha, 'producerSourceSha256': hashlib.sha256(Path(m.__file__).with_name('prepare-shell-update.ts').read_bytes()).hexdigest()}
        self.profile_ref = self.file('synthetic-reviewed-preparation-profile', self.profile)
        self.instance_ref = self.file('synthetic-reviewed-execution-profile', self.instance)
        self.candidate_ref = self.file('synthetic-original-candidate-source-record', self.evidence['lolly'])
        build = json.loads((self.base / self.evidence['build']['path']).read_bytes())
        modules = [{'path': str(self.roots['lolly'] / row['path']), 'sha256': row['sha256'], 'bytes': len((self.roots['lolly'] / row['path']).read_bytes())} for row in build['workspaceModules']]
        self.modules = self.file('synthetic-vite-compiled-modules', {'version': 1, 'source': str(self.roots['lolly']), 'modules': modules, 'guardIncludesWorkerGraph': True, 'normalCIQualified': False, 'productionAuthority': False})
        producer_source = Path(m.__file__).with_name('prepare-shell-update.ts')
        self.runner_ref = self.file('synthetic-vite-input', {'source': str(self.roots['lolly']), 'sourceCommit': self.sources['lolly'], 'output': self.evidence['candidateShell']['root'], 'prerequisites': str(self.base / 'synthetic-prerequisites'), 'moduleReceipt': str(self.base / self.modules['path'])})
        def command(argv, stdout):
            return {'command': [str(Path(NODE).absolute()), *argv], 'exitCode': 0, 'signal': None, 'seconds': 0.001, 'stdout': stdout, 'stderr': '', 'error': None}
        self.original_build = self.file('synthetic-vite-command-not-executed', command([str(producer_source.with_name('shell-update-vite.mjs')), str(self.base / self.runner_ref['path']), self.runner_ref['sha256']], 'Synthetic receipt, no real Vite invocation\n'))
        self.original_gate = self.file('synthetic-web-gate-command-not-executed', command(['scripts/webgpu-release-gate.ts', '--scope', 'web'], 'WebGPU release gate (web): docs/supported-environments.md covers 3 required environments; platform/version limits remain as published.\n'))
        custody = {'version': 1, 'engineSource': self.engine_source, 'workSource': self.sources['work'], 'brandCommit': self.brand, 'enginePinSha256': self.evidence['enginePin']['sha256'], 'profile': self.profile['profile'], 'settings': self.profile['settings'], 'previousManifest': self.evidence['previousShell']['manifest'], 'previousAcceptance': self.original_acceptance, 'ci': self.evidence['lolly']['ciRun'], 'publicKeySha256': self.evidence['publicPin']['sha256']}
        self.produced = {key: None for key in m.PRODUCER_KEYS}
        self.produced.update(version=1, status='LOCAL_PRIVATE_SHELL_UPDATE_PREPARED_UNQUALIFIED', lollySource=self.sources['lolly'], engineSource=self.engine_source, previousShellSource=self.previous['shellSource'], workSource=self.sources['work'], brandCommit=self.brand, profile=self.profile['profile'], enginePinSha256=self.evidence['enginePin']['sha256'], shellManifestSha256=self.evidence['shell']['manifest']['sha256'], settings=self.profile['settings'], workspaceModules={**self.modules, 'size': (self.base / self.modules['path']).stat().st_size}, originalReport=self.original_build, classification=self.evidence['classification'], engineClassification=self.evidence['classification'], custody=self.file('synthetic-producer-custody', custody), previousAcceptance=self.original_acceptance, ci=self.evidence['lolly']['ciRun'], publicKey=self.evidence['publicPin'], webGate=self.original_gate,
                             producer={'path': str(producer_source), 'sha256': self.profile['producerSourceSha256'], 'size': producer_source.stat().st_size}, originAuthenticatedByThisCommand=False, normalCIQualified=False, runtimeQualified=False, promotionAttempted=False)
        for key, field in (('previous', 'previousShell'), ('candidate', 'candidateShell'), ('shell', 'shell')):
            tree = self.evidence[field]; manifest = json.loads((self.base / tree['manifest']['path']).read_bytes())
            self.produced[key] = {**tree, 'shellId': m.manifest_id(manifest), 'files': len(manifest['files'])}
        self.producer_ref = self.file('synthetic-producer-original', self.produced)

    def absolute(self, ref):
        return {**ref, 'path': str(self.base / ref['path'])}

    def adapter(self):
        return m.Adapter(*(self.absolute(ref) for ref in (self.profile_ref, self.instance_ref, self.candidate_ref, self.producer_ref)), 'unused-next-shell', self.operator_sha)

    def change(self, key, change):
        ref = getattr(self, key); value = json.loads((self.base / ref['path']).read_bytes()); change(value)
        setattr(self, key, self.file('changed-' + key, value))

    def refuses(self):
        with self.assertRaises((m.Refusal, OSError, ValueError, TypeError, KeyError)):
            self.adapter()

    def test_actual_cli_handoff_to_unchanged_preparer_and_false_boundaries(self):
        out = self.base / 'assembled'
        args = [sys.executable, *(['-O'] if sys.flags.optimize else []), str(Path(m.__file__)), '--shell-claim', 'unused-next-shell', '--operator-sha256', self.operator_sha, '--out-dir', str(out)]
        for key, ref in zip(('preparation-profile', 'instance-profile', 'candidate', 'producer'), (self.profile_ref, self.instance_ref, self.candidate_ref, self.producer_ref)):
            args += ['--' + key, str(self.base / ref['path']), '--' + key + '-sha256', ref['sha256']]
        result = subprocess.run(args, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads((out / 'assembly.actual.json').read_bytes())
        self.assertEqual(actual['qualificationBoundary'], m.BOUNDARY)
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        evidence = json.loads(Path(actual['evidence']['path']).read_bytes())
        self.assertEqual(evidence['candidateShell']['manifest']['sha256'], self.evidence['candidateShell']['manifest']['sha256'])
        self.assertNotEqual(evidence['candidateShell']['manifest']['sha256'], evidence['shell']['manifest']['sha256'])
        command = [sys.executable, *(['-O'] if sys.flags.optimize else []), str(Path(m.shell.__file__)), '--evidence', actual['evidence']['path'], '--reviewed-evidence-sha256', actual['evidence']['sha256'], '--existing-public-pin-sha256', self.public_pin_sha, '--node', NODE, '--out-dir', str(self.base / 'prepared')]
        prepared = subprocess.run(command, capture_output=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads((self.base / 'prepared/shell.prepared.json').read_bytes())['status'], m.shell.STATUS)
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)

    def test_byte_identical_manifest_copy_keeps_original_accepted_ref(self):
        manifest = json.loads((self.base / self.evidence['previousShell']['manifest']['path']).read_bytes())
        copied = self.file('separate-previous-manifest-copy', manifest)
        self.change('producer_ref', lambda v: v['previous'].update(manifest=copied))
        adapter = self.adapter()
        self.assertEqual(adapter.evidence['previousShell']['manifest'], self.absolute(self.evidence['previousShell']['manifest']))
        wrong = copy.deepcopy(manifest); wrong['files'][0]['sha256'] = '0' * 64
        self.change('producer_ref', lambda v: v['previous'].update(manifest=self.file('wrong-copy', wrong), shellId=m.manifest_id(wrong)))
        self.refuses()

    def test_stale_candidate_and_incomplete_normal_ci_refuse(self):
        self.change('candidate_ref', lambda v: v.update(source=self.engine_source)); self.refuses()

    def test_failed_ci_with_consistent_reference_refuses(self):
        def change(v):
            run = json.loads((self.base / v['ciRun']['path']).read_bytes()); run['conclusion'] = 'failure'; v['ciRun'] = self.file('failed-ci', run)
        self.change('candidate_ref', change); self.refuses()

    def test_profile_target_settings_and_brand_mismatch_refuse(self):
        original = self.profile_ref
        for change in (lambda v: v['instance'].update(targetSha256='0' * 64), lambda v: v['settings'].update(requireAiPolicy=1), lambda v: v['settings'].update(liveRelay='https://other.example/live'), lambda v: v['brand'].update(commit='a' * 40)):
            self.profile_ref = original; self.change('profile_ref', change); self.refuses()

    def test_unknown_profile_and_false_qualification_flags_refuse(self):
        original = self.producer_ref
        for change in (lambda v: v.update(runtimeQualified=True), lambda v: v.update(promotionAttempted=0), lambda v: v.update(unknown=True)):
            self.producer_ref = original; self.change('producer_ref', change); self.refuses()
        self.change('profile_ref', lambda v: v.update(extra='unexpected')); self.refuses()

    def test_consistently_changed_module_bytes_or_outside_root_refuse(self):
        original = self.producer_ref
        for change in (lambda v: v['modules'][0].update(sha256='0' * 64), lambda v: v['modules'][0].update(path='/outside/engine/src/fixture.ts'), lambda v: v['modules'].append(copy.deepcopy(v['modules'][0]))):
            self.producer_ref = original
            def producer(v, change=change):
                modules = json.loads((self.base / self.modules['path']).read_bytes()); change(modules)
                ref = self.file('wrong-modules', modules); v['workspaceModules'] = {**ref, 'size': (self.base / ref['path']).stat().st_size}
            self.change('producer_ref', producer); self.refuses()

    def test_original_gate_scope_or_failed_vite_refuse(self):
        original = self.producer_ref
        for field, edit in (('webGate', lambda v: v['command'].__setitem__(3, 'all')), ('originalReport', lambda v: v.update(exitCode=1)), ('webGate', lambda v: v.update(stdout='PASS\n'))):
            self.producer_ref = original
            def changed(v, field=field, edit=edit):
                value = json.loads((self.base / v[field]['path']).read_bytes()); edit(value); v[field] = self.file('wrong-command', value)
            self.change('producer_ref', changed); self.refuses()

    def test_successful_vite_warnings_are_preserved_as_original_reference(self):
        def change(v):
            command = json.loads((self.base / self.original_build['path']).read_bytes())
            command['stderr'] = 'Synthetic ordinary Vite warning\n'
            v['originalReport'] = self.file('successful-build-with-warning', command)
        self.change('producer_ref', change)
        adapter = self.adapter()
        value = json.loads((self.base / self.producer_ref['path']).read_bytes())
        self.assertEqual(adapter.build['originalReport'], self.absolute(value['originalReport']))

    def test_original_runner_candidate_and_retained_manifest_mismatch_refuse(self):
        self.change('producer_ref', lambda v: v.update(shellManifestSha256=v['candidate']['manifest']['sha256'])); self.refuses()
        self.producer_ref = self.file('restored-producer', self.produced)
        def edit(v):
            runner = json.loads((self.base / self.runner_ref['path']).read_bytes()); runner['sourceCommit'] = self.engine_source
            ref = self.file('wrong-runner', runner); command = json.loads((self.base / self.original_build['path']).read_bytes()); command['command'][2:] = [str(self.base / ref['path']), ref['sha256']]; v['originalReport'] = self.file('consistent-wrong-vite', command)
        self.change('producer_ref', edit); self.refuses()

    def test_advanced_execution_baseline_or_wrong_acceptance_refuses(self):
        self.change('producer_ref', lambda v: v.update(previousShellSource=self.sources['lolly'])); self.refuses()

    def test_operator_hash_unsafe_claim_and_mutated_held_input_refuse(self):
        with self.assertRaises(m.Refusal):
            m.Adapter(*(self.absolute(ref) for ref in (self.profile_ref, self.instance_ref, self.candidate_ref, self.producer_ref)), self.previous['shell']['name'], self.operator_sha)
        with self.assertRaises(m.Refusal):
            m.Adapter(*(self.absolute(ref) for ref in (self.profile_ref, self.instance_ref, self.candidate_ref, self.producer_ref)), 'new-shell', '0' * 64)
        adapter = self.adapter(); (self.base / self.producer_ref['path']).write_bytes(b'{}')
        with self.assertRaises(m.Refusal): adapter.publish(self.base / 'must-not-exist')
        self.assertFalse((self.base / 'must-not-exist').exists())

    def test_output_cannot_write_inside_accepted_or_candidate_source_tree(self):
        adapter = self.adapter()
        for root in (Path(self.evidence['previousShell']['root']), self.roots['lolly']):
            output = root / 'new-assembly'
            with self.assertRaises(m.Refusal): adapter.publish(output)
            self.assertFalse(output.exists())

    def test_manifest_duplicates_total_and_utf16_walk_identity(self):
        manifest = {'version': 1, 'files': [{'path': 'a-file.js', 'size': 0, 'sha256': '1' * 64}, {'path': 'a/nested.js', 'size': 0, 'sha256': '2' * 64}], 'totalBytes': 0}
        expected = 'release-' + hashlib.sha256(json.dumps([['a/nested.js', '2' * 64], ['a-file.js', '1' * 64]], separators=(',', ':')).encode()).hexdigest()[:16]
        self.assertEqual(m.manifest_id(manifest), expected)
        for edit in (lambda v: v['files'].append(v['files'][0]), lambda v: v.update(totalBytes=1), lambda v: v['files'][0].update(size=True)):
            wrong = copy.deepcopy(manifest); edit(wrong)
            with self.assertRaises(m.Refusal): m.manifest_id(wrong)


if __name__ == '__main__':
    suite = unittest.TestSuite(AdapterTests(name) for name in AdapterTests.__dict__ if name.startswith('test_'))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
