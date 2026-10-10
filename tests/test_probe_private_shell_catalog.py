#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline synthetic custody/transport controls; no fixture qualifies a target."""
import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('probe_fixture', Path(__file__).with_name('test_update_private_shell.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
spec = importlib.util.spec_from_file_location('catalog_probe', HERE / 'scripts/probe-private-shell-catalog.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
NODE = os.environ.get('LOLLY_TEST_NODE', 'node')


class Probe(unittest.TestCase):
    @classmethod
    def setUpClass(cls): fixture.Offline.setUpClass()

    def setUp(self):
        self.f = fixture.Offline(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.base = self.f.base
        node = str(Path(NODE).resolve()) if '/' in NODE else subprocess.run(['which', NODE], capture_output=True, text=True, check=True).stdout.strip()
        version = subprocess.run([node, '--version'], capture_output=True, text=True, check=True).stdout.strip()
        # The shared fixture uses a placeholder Pod-spec digest. This stronger
        # probe fixture binds the synthetic owner to a real full-spec digest,
        # then invokes the maintained preparer again with the new custody chain.
        f = self.f.f
        original = fixture.m.cohort.parse_json(Path(f.original_acceptance['path']).read_bytes())
        original['podSpecSha256'] = m.sha(m.canonical(f.baseline['pods']['items'][0]['spec']))
        f.original_acceptance = f.file('synthetic-real-pod-spec-runtime', original)
        acceptance = m.json_ref(f.previous['acceptance']); acceptance['originalEvidence'][0] = f.original_acceptance
        f.previous['acceptance'] = f.file('synthetic-real-pod-spec-acceptance', acceptance)
        f.prepare_evidence['previous'] = f.file('synthetic-real-pod-spec-previous', f.previous)
        result, _ = fixture.m.stage.shell.prepare(f.prepare_evidence, self.base, f.public_pin_sha, node)
        reviewed = f.file('synthetic-real-pod-spec-preparation', f.prepare_evidence)
        result['reviewedEvidenceSha256'] = reviewed['sha256']; result['evidence'].append(reviewed); result['evidence'].sort(key=lambda ref: ref['path'])
        f.prepared = result; prepared_ref = f.file('synthetic-real-pod-spec-prepared', result)
        f.evidence.update(previous=f.prepare_evidence['previous'], prepared=prepared_ref)
        f.stage_input.update(previous=f.prepare_evidence['previous'], prepared=prepared_ref)
        self.f.prepared_ref = prepared_ref; self.f.profile['previous'] = f.prepare_evidence['previous']
        f.baseline['pods']['items'][0]['status']['containerStatuses'][0]['image'] = f.previous['image']
        self.f.f.target['components']['work']['healthURLs'] = ['https://example.test/health']
        self.f.profile['target'] = self.f.f.file('synthetic-catalog-target', self.f.f.target)
        files = {path: {'sha256': 'a' * 64, 'bytes': 1, 'mode': '0644', 'gitBlob': None} for path in m.ORACLE_FILES}
        self.f.profile['sourceMap'] = self.f.f.file('synthetic-catalog-server-map', files)
        source = fixture.m.file_ref(HERE / 'scripts/probe-private-shell-catalog.py')
        module = fixture.m.file_ref(HERE / 'scripts/private-shell-catalog-probe.mjs')
        ledger = self.f.f.file('synthetic-catalog-ledger', ['001_init.sql'])
        self.f.profile['sourceFiles'] += [source, module, ledger]
        self.f.profile['authenticatedCatalog'] = {'source': source, 'module': module, 'python': sys.executable,
            'node': {'path': node, 'version': version}, 'migrations': ledger,
            'caller': {'project': 'prj_synthetic', 'session': 'ses_synthetic', 'emails': ['synthetic@example.test']}}
        self.f.profile_ref = self.f.f.file('synthetic-catalog-profile', self.f.profile)
        self.f.capture_ref = self.f.capture(False)
        self.operation, checked = self.f.check()
        self.out = fixture.m.private_new_directory(self.base / 'catalog-plan')
        self.plan_ref = self.operation.assemble_plan(checked, self.f.capture(True), self.f.f.evidence['stage'], self.out)
        self.input_ref = fixture.m.file_ref(self.out / 'catalog.probe.input.json')
        self.value = m.json_ref(self.input_ref)
        self.prepared = m.derive(self.value)

    def context(self):
        p = self.prepared; selected = p['prepared']['selection']['container']
        deployment = copy.deepcopy(p['previousOwner']['deployment']); deployment['spec'] = p['desiredSpec']
        deployment['status'] = {'readyReplicas': 1, 'observedGeneration': 1}; deployment['metadata']['generation'] = 1
        labels = {**p['desiredSpec']['template']['metadata']['labels'], 'pod-template-hash': 'fixturehash'}
        previous_rs = p['previousOwner']['replicaSet']
        previous_rs['spec'] = {'replicas': 1, 'selector': {'matchLabels': {'pod-template-hash': 'previoushash'}}, 'template': {}}
        rs = copy.deepcopy(previous_rs); rs['metadata'].update(name='new-rs', uid='new-rs-uid', labels=labels)
        rs['metadata']['ownerReferences'] = [{'apiVersion': 'apps/v1', 'kind': 'Deployment', 'name': deployment['metadata']['name'], 'uid': deployment['metadata']['uid'], 'controller': True}]
        rs['spec']['selector']['matchLabels']['pod-template-hash'] = 'fixturehash'
        rs['spec']['template'] = copy.deepcopy(p['desiredSpec']['template']); rs['spec']['template']['metadata']['labels'] = labels
        pod = copy.deepcopy(p['previousOwner']['pod']); pod['spec'] = p['podSpec']
        pod['metadata'].update(name='new-owner', uid='new-owner-uid', labels=labels, annotations=p['desiredSpec']['template']['metadata'].get('annotations', {}))
        pod['metadata']['ownerReferences'] = [{'apiVersion': 'apps/v1', 'kind': 'ReplicaSet', 'name': 'new-rs', 'uid': 'new-rs-uid', 'controller': True}]
        old_image = m.choose(p['previousOwner']['pod']['status']['containerStatuses'], selected)['image']
        pod['status'] = {'phase': 'Running', 'conditions': [{'type': 'Ready', 'status': 'True'}], 'containerStatuses': [{'name': selected,
            'image': old_image, 'imageID': p['prepared']['image'], 'ready': True, 'restartCount': 0,
            'state': {'running': {'startedAt': datetime.now(timezone.utc).isoformat()}}}]}
        owner = {'deployment': deployment, 'pod': pod, 'replicaSet': rs}
        public = m.json_ref(p['refs']['publicPin'])
        content = {'version': 1, 'shell': m.json_ref(p['refs']['shellManifest']), 'pack': m.json_ref(p['refs']['packManifest']),
                   'pinSha256': p['prepared']['enginePinSha256'], 'catalog': {**p['prepared']['catalog'], 'publicPinSha256': m.sha(m.canonical(public)), 'signatureVerified': True}}
        return {'version': 1, 'status': 'ACTUAL_PRIVATE_SHELL_AUTHENTICATED_CATALOG_CONTEXT', 'publicationInputSha256': 'b' * 64,
            'planSha256': p['input']['plan']['sha256'], 'sources': p['prepared']['sources'], 'image': p['prepared']['image'],
            'owner': owner, 'ownerEvidence': self.f.f.file('synthetic-current-owner', owner), 'contentEvidence': self.f.f.file('synthetic-current-content', content),
            'selection': p['prepared']['selection'], 'mounts': p['mounts'], 'baseURL': p['baseURL'], 'publicPin': public,
            'qualifiedCatalog': p['prepared']['catalog'], **{key: p['refs'][key] for key in ('shellManifest', 'packManifest', 'enginePin', 'resolverPin')}}

    def test_generated_input_replays_real_maintained_plan_without_target_and_is_relocatable(self):
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('Offline target forbidden')):
            derived = m.derive(self.value)
        self.assertEqual(derived['prepared']['sources'], self.f.f.prepared['sources'])
        publication = json.loads((self.out / 'publication.input.json').read_bytes())
        command = publication['authenticatedStaticProbe']
        self.assertEqual(command['input'], self.input_ref); self.assertIn(self.input_ref, publication['sourceFiles'])
        result = subprocess.run([sys.executable, *(['-O'] if sys.flags.optimize else []), '-B', command['source']['path'], '--input', self.input_ref['path'],
                                 '--input-sha256', self.input_ref['sha256'], '--check'], capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)['runtimeQualified'])

    def test_exact_four_prepared_and_six_runtime_catalogue_schemas_do_not_borrow_keys(self):
        context = self.context(); self.assertIsInstance(m.context_valid(context, self.prepared), str)
        cases = [lambda c: c['qualifiedCatalog'].update(signatureVerified=True), lambda c: c['qualifiedCatalog'].update(signedFiles=True),
                 lambda c: c.update(planSha256='c' * 64), lambda c: c.update(baseURL='https://other.test/')]
        for change in cases:
            bad = copy.deepcopy(context); change(bad)
            with self.assertRaises(m.Refusal): m.context_valid(bad, self.prepared)
        original = m.json_ref(context['contentEvidence'])
        for change in (lambda c: c['catalog'].pop('signatureVerified'), lambda c: c['catalog'].update(signatureVerified=False),
                       lambda c: c['catalog'].update(publicPinSha256='d' * 64), lambda c: c.update(pinSha256='e' * 64)):
            bad = copy.deepcopy(context); content = copy.deepcopy(original); change(content)
            bad['contentEvidence'] = self.f.f.file('synthetic-bad-content-' + str(len(list(self.base.iterdir()))), content)
            with self.assertRaises(m.Refusal): m.context_valid(bad, self.prepared)

    def test_complete_commonjs_executor_first_guard_refuses_before_disk_database_network(self):
        code = m.node_program(self.prepared, '2000-01-01T00:00:00Z')
        result = m.syntax_check(code, self.prepared['policy']['node']); self.assertFalse(result['programExecuted'])
        execution = subprocess.run([self.prepared['policy']['node']['path'], '-e', code], capture_output=True, timeout=30,
                                   env={**os.environ, 'LW_AUTO_MIGRATE': 'false'})
        self.assertEqual(execution.returncode, 1); self.assertEqual(execution.stderr, b'')
        self.assertEqual(json.loads(execution.stdout), {'status': 'REFUSED', 'rawErrorsSuppressed': True})
        self.assertNotIn('lolly.ing', code); self.assertNotIn('/Users/andy', code)

    def test_owner_defaults_uid_restart_image_and_fullspec_drift_refuse(self):
        context = self.context(); owner = context['owner']; self.assertIsInstance(m.owner_valid(owner, self.prepared), str)
        cases = [lambda o: o['pod']['spec'].update(enableServiceLinks=not o['pod']['spec'].get('enableServiceLinks', True)),
                 lambda o: o['pod']['status']['containerStatuses'][0].update(restartCount=1),
                 lambda o: o['pod']['status']['containerStatuses'][0].update(imageID='sha256:' + 'e' * 64),
                 lambda o: o['deployment']['metadata'].update(uid='foreign-owner'), lambda o: o['replicaSet']['spec'].update(replicas=3)]
        for change in cases:
            bad = copy.deepcopy(owner); change(bad)
            with self.assertRaises(m.Refusal): m.owner_valid(bad, self.prepared)

    def test_stale_candidate_nested_original_or_source_and_unapproved_caller_refuse(self):
        for field in ('plan', 'prepared', 'instanceProfile'):
            bad = copy.deepcopy(self.value); bad[field]['sha256'] = 'f' * 64
            with self.assertRaises(m.Refusal): m.derive(bad)
        policy = copy.deepcopy(self.f.profile); policy['authenticatedCatalog']['caller']['emails'] = ['Upper@EXAMPLE.test']
        self.f.profile_ref = self.f.f.file('synthetic-unapproved-caller-profile', policy)
        with self.assertRaises(fixture.m.Refusal): self.f.operation()
        Path(self.input_ref['path']).write_bytes(b'{}')
        with self.assertRaises(m.Refusal): m.frozen(self.input_ref)

    def raw(self, context):
        return {'version': 1, 'status': 'AUTHENTICATED_NORMAL_TLS_PER_CALLER_CATALOG_VERIFIED',
            'sessionOrigin': 'MAINTAINED_OWNING_NODE_OWNER_AND_MIGRATION_LOOKUP', 'indexSha256': '1' * 64,
            'envelopeSha256': '2' * 64, 'indexBytes': 100, 'envelopeBytes': 200, 'expectedIndexSha256': '1' * 64,
            'expectedFileMapSha256': '3' * 64, 'signedFiles': 1, 'publicPinSha256': m.sha(m.canonical(context['publicPin'])),
            'keyId': context['qualifiedCatalog']['keyId'], 'signedAt': datetime.now(timezone.utc).isoformat(),
            'signatureVerified': True, 'exactPerCallerIndexBytes': True, 'exactVisibleFileMap': True,
            'sourceBindingSha256': self.prepared['sourceBindingSha256'], 'cookiePrinted': False, 'cookiePersisted': False,
            'cookieTtlSeconds': 300, 'databaseDirectWrites': False, 'redirectsFollowed': False,
            'certificateRequired': True, 'hostnameVerified': True, 'envelopeByteEqualityToPreparedClaimed': False}

    def test_final_preflight_is_last_target_call_before_single_memory_exec_and_owner_recheck(self):
        context = self.context(); events = []; case = self
        class SyntheticKube:
            def get(self, kind, name, namespace=None):
                events.append(('get', kind, name))
                keys = {'deployment': 'deployment', 'pod': 'pod', 'replicaset': 'replicaSet'}
                if kind in keys: return copy.deepcopy(context['owner'][keys[kind]])
                if kind == 'namespace':
                    return {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': name, 'uid': 'cluster-uid' if name == 'kube-system' else 'namespace-uid', 'resourceVersion': '1'}}
                return {'apiVersion': 'v1', 'kind': 'Node', 'metadata': {'name': name, 'uid': 'node-uid', 'resourceVersion': '1'},
                        'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
            def run(self, args, timeout):
                events.append(('exec', args, timeout)); return json.dumps(case.raw(context))
        with patch.object(m, 'final_preflight', side_effect=lambda _: events.append(('guard',))):
            report = m.execute(self.prepared, context, self.input_ref, SyntheticKube())
        where = next(index for index, event in enumerate(events) if event[0] == 'exec')
        self.assertEqual(events[where - 1], ('guard',)); self.assertEqual(sum(event[0] == 'exec' for event in events), 1)
        self.assertEqual(events[where][2], 290); self.assertTrue(any(event[0] == 'get' for event in events[where + 1:]))
        self.assertEqual(report['profile'], m.PROFILE); self.assertFalse(report['scope']['cookiePrinted'])
        self.assertNotIn('synthetic@example.test', json.dumps(report))

    def test_report_tls_lifetime_memory_scope_and_wrong_caller_oracle_refuse(self):
        context = self.context(); raw = self.raw(context)
        self.assertEqual(m.normalize(raw, context, self.prepared, self.input_ref)['oracle']['signedFiles'], 1)
        cases = [lambda r: r.update(cookiePrinted=True), lambda r: r.update(cookiePersisted=True), lambda r: r.update(cookieTtlSeconds=301),
                 lambda r: r.update(cookieTtlSeconds=True), lambda r: r.update(certificateRequired=False), lambda r: r.update(redirectsFollowed=True),
                 lambda r: r.update(expectedIndexSha256='f' * 64), lambda r: r.update(signatureVerified=False),
                 lambda r: r.update(sourceBindingSha256='e' * 64), lambda r: r.update(signedAt='2000-01-01T00:00:00Z'),
                 lambda r: r.update(cookie='never expose a credential')]
        for change in cases:
            bad = copy.deepcopy(raw); change(bad)
            with self.assertRaises(m.Refusal): m.normalize(bad, context, self.prepared, self.input_ref)

    def test_preflight_refusal_retains_original_and_exclusive_attempt_cannot_replay(self):
        from types import SimpleNamespace
        receipt = Path(self.prepared['input']['preflightReceiptPath'])
        result = SimpleNamespace(returncode=1, stdout=b'original guard refusal', stderr=b'original diagnostic')
        with patch.object(m.subprocess, 'run', return_value=result) as runner:
            with self.assertRaises(m.Refusal): m.final_preflight(self.prepared)
            self.assertEqual(runner.call_count, 1)
            with self.assertRaises(m.Refusal): m.final_preflight(self.prepared)
            self.assertEqual(runner.call_count, 1)
        actual = json.loads(receipt.read_bytes()); self.assertEqual(actual['stdout'], 'original guard refusal')
        self.assertEqual(actual['returncode'], 1)

    def test_ambiguous_extra_policy_closure_or_noncanonical_ledger_refuses_before_target(self):
        original = copy.deepcopy(self.f.profile)
        mutations = [lambda p: p.update(authenticatedStaticProbe={}), lambda p: p['authenticatedCatalog'].update(extra='unknown'),
            lambda p: p['authenticatedCatalog']['node'].update(version='v23.0.0'),
            lambda p: p['authenticatedCatalog']['caller'].update(session='prj_wrong'),
            lambda p: p['authenticatedCatalog']['caller'].update(emails=[]),
            lambda p: p['sourceFiles'].remove(p['authenticatedCatalog']['module'])]
        for index, change in enumerate(mutations):
            candidate = copy.deepcopy(original); change(candidate)
            self.f.profile_ref = self.f.f.file('synthetic-bad-policy-' + str(index), candidate)
            with self.assertRaises(fixture.m.Refusal): self.f.operation()
        candidate = copy.deepcopy(original)
        candidate['authenticatedCatalog']['migrations'] = self.f.f.file('synthetic-unsorted-ledger', ['002_next.sql', '001_init.sql'])
        candidate['sourceFiles'].append(candidate['authenticatedCatalog']['migrations'])
        self.f.profile_ref = self.f.f.file('synthetic-bad-ledger-profile', candidate)
        with self.assertRaises(fixture.m.Refusal): self.f.operation()


if __name__ == '__main__': unittest.main()
