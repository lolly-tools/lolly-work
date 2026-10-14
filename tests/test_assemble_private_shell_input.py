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
    def commit(self, root):
        if root.name == 'lolly' and not (root / 'scripts/build-delivery.ts').exists():
            self.put(root, 'scripts/build-delivery.ts', b'// Synthetic committed compressor; never executed.\n')
        return super().commit(root)

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
        candidate = self.produced['candidate']
        old = {row['path']: row for row in json.loads(Path(self.produced['previous']['manifest']['path']).read_bytes())['files']}
        rows = json.loads(Path(candidate['manifest']['path']).read_bytes())['files']
        changed = [row['path'] for row in rows if not row['path'].endswith(('.gz', '.br')) and (row['path'].startswith('_app/') or row['path'] in {'index.html', 'precache.json', 'sw.js', 'portable/player.js'}) and old.get(row['path']) != row]
        self.coding_request = {'version': 1, 'source': str(self.roots['lolly']), 'candidate': candidate['root'], 'previous': self.produced['previous']['manifest'], 'scratch': str(self.base / 'coding-scratch'), 'receipt': str(self.base / 'coding-rewrite.json')}
        compressor = self.roots['lolly'] / 'scripts/build-delivery.ts'
        self.coding_receipt = {'version': 1, 'status': 'PRIVATE_FRONTEND_CODINGS_PREPARED_NOT_QUALIFIED', 'candidate': candidate['root'], 'previous': self.coding_request['previous'], 'compressor': {'path': str(compressor), 'sha256': hashlib.sha256(compressor.read_bytes()).hexdigest()}, 'changed': changed, 'written': [row['path'] for row in rows if row['path'] in {path + suffix for path in changed for suffix in ('.gz', '.br')}], 'removed': [], 'retainedImmutableWireVerified': True, 'allCodingsDecoded': True, 'runtimeQualified': False, 'productionMutation': False}
        Path(self.coding_request['receipt']).write_bytes(m.cohort.canonical(self.coding_receipt))
        self.coding_input = self.file('synthetic-coding-input', self.coding_request)
        self.produced['codingReport'] = self.file('synthetic-coding-command-not-executed', command([str(producer_source.with_name('private-shell-codings.mjs')), self.coding_input['path'], self.coding_input['sha256']], ''))
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
        self.assertNotIn('rawDerivation', evidence)
        self.assertEqual(evidence['candidateShell']['manifest']['sha256'], self.evidence['candidateShell']['manifest']['sha256'])
        self.assertNotEqual(evidence['candidateShell']['manifest']['sha256'], evidence['shell']['manifest']['sha256'])
        command = [sys.executable, *(['-O'] if sys.flags.optimize else []), str(Path(m.shell.__file__)), '--evidence', actual['evidence']['path'], '--reviewed-evidence-sha256', actual['evidence']['sha256'], '--existing-public-pin-sha256', self.public_pin_sha, '--node', NODE, '--out-dir', str(self.base / 'prepared')]
        prepared = subprocess.run(command, capture_output=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads((self.base / 'prepared/shell.prepared.json').read_bytes())['status'], m.shell.STATUS)
        self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)

    def build_snapshot(self, edit):
        value = json.loads(Path(self.evidence['lolly']['ciRun']['path']).read_bytes()); value.update(status='in_progress', conclusion=None); edit(value)
        snapshot = self.file('synthetic-original-pending-main-run', value)
        def producer(v):
            v['ci'] = snapshot
            custody = json.loads(Path(v['custody']['path']).read_bytes()); custody['ci'] = snapshot
            v['custody'] = self.file('synthetic-pending-build-custody', custody)
        self.change('producer_ref', producer)
        return snapshot

    def test_pending_build_snapshot_binds_same_completed_successful_main_ci(self):
        for status in ('pending', 'queued', 'in_progress'):
            self.producer_ref = self.file('restored-completed-producer', self.produced)
            snapshot = self.build_snapshot(lambda v: v.update(status=status))
            adapter = self.adapter()
            self.assertNotEqual(snapshot, adapter.candidate['ciRun'])
            self.assertIn(Path(snapshot['path']), adapter.inputs.reads)
            self.assertIn(Path(adapter.candidate['ciRun']['path']), adapter.inputs.reads)

    def test_pending_build_snapshot_rejects_other_run_attempt_source_repository_workflow_or_event(self):
        for edit in (lambda v: v.update(id=v['id'] + 1), lambda v: v.update(run_attempt=v['run_attempt'] + 1),
                     lambda v: v.update(head_sha=self.engine_source), lambda v: v.update(head_branch='feature'),
                     lambda v: v.update(path='.github/workflows/other.yml'), lambda v: v.update(event='pull_request'),
                     lambda v: v['repository'].update(id=999), lambda v: v['head_repository'].update(full_name='other/repo'),
                     lambda v: v.update(workflow_id=123), lambda v: v.update(status='completed', conclusion='failure'),
                     lambda v: v.update(status='in_progress', conclusion='success')):
            self.producer_ref = self.file('restored-completed-producer', self.produced)
            def pending(v):
                v.update(status='pending'); edit(v)
            self.build_snapshot(pending); self.refuses()

    def test_pending_provider_build_state_requires_null_conclusion(self):
        for conclusion in ('success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required'):
            with self.subTest(conclusion=conclusion):
                self.producer_ref = self.file('restored-completed-producer', self.produced)
                self.build_snapshot(lambda v: v.update(status='pending', conclusion=conclusion))
                self.refuses()

    def test_pending_build_never_substitutes_for_final_complete_successful_ci(self):
        self.build_snapshot(lambda v: v.update(status='pending'))
        def pending(v):
            run = json.loads(Path(v['ciRun']['path']).read_bytes()); run.update(status='in_progress', conclusion=None)
            v['ciRun'] = self.file('synthetic-still-running-final', run)
        self.change('candidate_ref', pending); self.refuses()

    def test_public_ready_adapter_keeps_pending_build_and_explicit_fast_scope(self):
        self.build_snapshot(lambda v: v.update(status='pending'))
        def ready(v):
            v['qualificationTier'] = 'public-ready'
            run = json.loads(Path(v['ciRun']['path']).read_bytes()); run.update(status='in_progress', conclusion=None)
            v['ciRun'] = self.file('public-ready-original-main-run', run)
            jobs = json.loads(Path(v['ciJobs']['path']).read_bytes())
            for job in jobs['jobs']:
                if job['name'] not in m.shell.PUBLIC_READY_JOBS: job.update(status='in_progress', conclusion=None)
            v['ciJobs'] = self.file('public-ready-original-main-jobs', jobs)
        self.change('candidate_ref', ready)
        adapter = self.adapter()
        prepared, held = m.shell.prepare(adapter.evidence | {'build': self.file('public-ready-build', adapter.build), 'webGate': self.file('public-ready-gate', adapter.gate)}, self.base, self.public_pin_sha, NODE)
        held.unchanged()
        self.assertEqual(prepared['status'], m.shell.PUBLIC_READY_STATUS)
        self.assertEqual(set(prepared['normalCI']), {'work'})
        self.assertFalse(prepared['publicReadyCI']['lolly']['fullSuiteQualified'])

    def derivation_profile(self):
        custody = self.file('synthetic-original-release-custody-not-qualified', {'synthetic': True})
        release = copy.deepcopy(self.evidence['previousShell'])
        original = {'custody': custody, 'release': release}
        relative = copy.deepcopy(original)
        relative['custody']['path'] = os.path.relpath(custody['path'], self.base)
        relative['release']['root'] = os.path.relpath(release['root'], self.base)
        relative['release']['manifest']['path'] = os.path.relpath(release['manifest']['path'], self.base)
        self.change('profile_ref', lambda v: v.update(rawDerivation=relative))
        return original

    def test_optional_original_derivation_is_normalized_held_and_preserved_without_qualification(self):
        original = self.derivation_profile(); adapter = self.adapter()
        self.assertEqual(adapter.evidence['rawDerivation'], original)
        self.assertIn(Path(original['custody']['path']), adapter.inputs.reads)
        self.assertIn(Path(original['release']['manifest']['path']), adapter.inputs.reads)
        self.assertIn(Path(original['release']['root']), adapter.tree_roots)
        output = self.base / 'derived-custody-assembly'
        adapter.publish(output)
        actual = json.loads((output / 'shell-input.reviewed.json').read_bytes())
        self.assertEqual(actual['rawDerivation'], original)
        with self.assertRaisesRegex(m.shell.Refusal, 'Legacy pack must not acquire derived release custody'):
            m.shell.prepare(actual, output, self.public_pin_sha, NODE)

    def test_optional_derivation_rejects_unknown_shape_or_changed_bound_refs(self):
        self.derivation_profile(); original = self.profile_ref
        for edit in (lambda v: v.update(extra=True), lambda v: v.pop('custody'),
                     lambda v: v['release'].update(extra=True), lambda v: v['release'].pop('manifest'),
                     lambda v: v['custody'].update(sha256='0' * 64),
                     lambda v: v['release']['manifest'].update(sha256='0' * 64)):
            self.profile_ref = original
            self.change('profile_ref', lambda v: edit(v['rawDerivation']))
            self.refuses()

    def test_original_derivation_custody_drift_refuses_before_assembly(self):
        original = self.derivation_profile(); adapter = self.adapter()
        Path(original['custody']['path']).write_text('{}')
        output = self.base / 'drifted-derivation-refused'
        with self.assertRaises(m.Refusal): adapter.publish(output)
        self.assertFalse(output.exists())

    def test_coding_original_input_receipt_and_compressor_are_held(self):
        adapter = self.adapter()
        for path in (self.coding_input['path'], self.coding_request['receipt'], self.coding_receipt['compressor']['path']):
            self.assertIn(Path(path), adapter.inputs.reads)
        Path(self.coding_request['receipt']).write_text('{}')
        with self.assertRaises(m.Refusal): adapter.publish(self.base / 'coding-drift-refused')

    def test_coding_command_failed_wrong_program_or_missing_receipt_refuses(self):
        original = self.producer_ref
        for edit in (lambda v: v.update(exitCode=1), lambda v: v['command'].__setitem__(1, '/wrong/private-shell-codings.mjs')):
            self.producer_ref = original
            def change(v):
                report = json.loads(Path(v['codingReport']['path']).read_bytes()); edit(report)
                v['codingReport'] = self.file('wrong-coding-command', report)
            self.change('producer_ref', change); self.refuses()
        self.producer_ref = original
        Path(self.coding_request['receipt']).unlink(); self.refuses()

    def test_coding_consistent_wrong_candidate_source_previous_or_output_refuses(self):
        original = self.producer_ref
        for edit in (lambda v: v.update(candidate=self.evidence['shell']['root']), lambda v: v.update(source='/wrong/source'),
                     lambda v: v.update(previous=self.evidence['candidateShell']['manifest']), lambda v: v.update(receipt='/wrong/receipt.json')):
            self.producer_ref = original
            def change(v):
                request = copy.deepcopy(self.coding_request); edit(request)
                ref = self.file('wrong-coding-input', request)
                report = json.loads(Path(v['codingReport']['path']).read_bytes()); report['command'][2:] = [ref['path'], ref['sha256']]
                v['codingReport'] = self.file('wrong-coding-command', report)
            self.change('producer_ref', change); self.refuses()

    def test_coding_receipt_cannot_claim_other_compressor_delta_or_qualification(self):
        for edit in (lambda v: v['compressor'].update(sha256='0' * 64), lambda v: v.update(changed=[]),
                     lambda v: v.update(written=['catalog/private.json.gz']), lambda v: v.update(removed=['catalog/private.json.gz']),
                     lambda v: v.update(runtimeQualified=True), lambda v: v.update(allCodingsDecoded=1), lambda v: v.update(extra=True)):
            receipt = copy.deepcopy(self.coding_receipt); edit(receipt); Path(self.coding_request['receipt']).write_bytes(m.cohort.canonical(receipt)); self.refuses()

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

    def test_original_resource_limits_are_optional_for_legacy_and_exact_when_recorded(self):
        operation = m.Adapter.__new__(m.Adapter); operation.inputs = m.cohort.Inputs(self.base)
        value = json.loads(Path(self.original_build['path']).read_bytes())
        operation.command(self.original_build)
        value['resourceEnvironment'] = {'RAYON_NUM_THREADS': '2', 'NODE_OPTIONS': '--max-old-space-size=2048'}
        ref = self.file('bounded-original-child-command', value)
        self.assertEqual(operation.command(ref)['resourceEnvironment'], value['resourceEnvironment'])
        operation.inputs.unchanged()

    def test_wrong_or_open_resource_environment_refuses(self):
        operation = m.Adapter.__new__(m.Adapter); operation.inputs = m.cohort.Inputs(self.base)
        original = json.loads(Path(self.original_build['path']).read_bytes())
        for environment in ({'RAYON_NUM_THREADS': '8', 'NODE_OPTIONS': '--max-old-space-size=2048'},
                            {'RAYON_NUM_THREADS': '2', 'NODE_OPTIONS': '--max-old-space-size=4096'},
                            {'RAYON_NUM_THREADS': 2, 'NODE_OPTIONS': '--max-old-space-size=2048'},
                            {'RAYON_NUM_THREADS': '2'},
                            {'RAYON_NUM_THREADS': '2', 'NODE_OPTIONS': '--max-old-space-size=2048', 'OTHER': 'value'}, None):
            with self.assertRaises(m.Refusal):
                operation.command(self.file('wrong-child-resource-environment', {**original, 'resourceEnvironment': environment}))


if __name__ == '__main__':
    suite = unittest.TestSuite(AdapterTests(name) for name in AdapterTests.__dict__ if name.startswith('test_'))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
