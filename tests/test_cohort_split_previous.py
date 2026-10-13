#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline original-acceptance dispatch and derived-envelope custody tests."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

HERE = Path(__file__).parent
fixture = load('split_shell_fixture', HERE / 'test_prepare_private_shell.py')
cohort_fixture = load('matched_cohort_fixture', HERE / 'test_prepare_private_cohort.py')
m = load('split_cohort', HERE.parent / 'scripts/prepare-private-cohort.py')
planner = load('split_planner', HERE.parent / 'scripts/plan-private-cohort.py')

class Split(fixture.Shell):
    def read(self, previous=None):
        ref = self.evidence['previous'] if previous is None else self.file('modified-previous', previous)
        inputs = m.Inputs(self.base)
        result = m.previous_record(ref, inputs); inputs.unchanged()
        return result, inputs

    def test_dispatch_preserves_original_bytes_and_full_custody(self):
        ref = self.evidence['previous']; path = self.base / ref['path']; original = path.read_bytes()
        (previous, before), inputs = self.read()
        self.assertEqual(previous, self.previous); self.assertEqual(before, self.before)
        self.assertEqual(path.read_bytes(), original)
        self.assertIn(self.base / self.previous['resolverPin']['path'], inputs.reads)
        self.assertGreater(len(inputs.reads), 8)

    def test_mixed_schema_and_source_identity_tampering_refuse(self):
        for change in (lambda p: p.update(lollySource=p['engineSource']),
                       lambda p: p.update(shellSource='f' * 40),
                       lambda p: p.update(engineSource='e' * 40),
                       lambda p: p.update(image='example.invalid/server@sha256:' + 'f' * 64),
                       lambda p: p['shell'].update(uid='different-claim')):
            wrong = copy.deepcopy(self.previous); change(wrong)
            with self.assertRaises(m.Refusal): self.read(wrong)

    def test_rehashed_false_original_runtime_refuses(self):
        wrong = copy.deepcopy(self.previous)
        acceptance = json.loads((self.base / wrong['acceptance']['path']).read_bytes())
        original = json.loads((self.base / acceptance['originalEvidence'][0]['path']).read_bytes())
        original['runtimeAndCatalog']['filteredCatalogSignatureVerified'] = False
        acceptance['originalEvidence'][0] = self.file('false-original-runtime', original)
        wrong['acceptance'] = self.file('rehashed-runtime-wrapper', acceptance)
        with self.assertRaises(m.Refusal): self.read(wrong)

class Derived(cohort_fixture.Cohort):
    def test_actual_preparer_output_accepts_only_bound_optional_derivation(self):
        # The base fixture executes the complete maintained Git/OCI/catalog
        # preparer; this test isolates its planner-envelope boundary.
        prepared, _ = self.prepare()
        original = copy.deepcopy(self.evidence)
        custody = self.file('derivation-custody', {'version': 1, 'original': 'synthetic'})
        original['rawDerivation'] = {'custody': custody}
        envelope = self.file('derived-cli-envelope', original)
        prepared['reviewedEvidenceSha256'] = envelope['sha256']
        for ref in (envelope, custody):
            prepared['evidence'].append({'path':str(self.base / ref['path']), 'sha256':ref['sha256']})
        prepared['rawPack']['derivation'] = {'custodySha256':custody['sha256']}
        self.assertEqual(planner.cli_evidence(prepared, planner.cohort.Inputs(self.base)), original)
        for change in (lambda p: p['rawPack']['derivation'].update(custodySha256='f' * 64),
                       lambda p: p['rawPack'].pop('derivation'),
                       lambda p: p.update(evidence=[r for r in p['evidence'] if r['sha256'] != custody['sha256']])):
            wrong = copy.deepcopy(prepared); change(wrong)
            with self.assertRaises(planner.Refusal): planner.cli_evidence(wrong, planner.cohort.Inputs(self.base))
        original['rawDerivation']['unexpected'] = True
        bad = self.file('extra-derived-envelope', original)
        wrong = copy.deepcopy(prepared)
        wrong['evidence'] = [r for r in wrong['evidence'] if r['sha256'] != envelope['sha256']]
        wrong['evidence'].append({'path':str(self.base / bad['path']), 'sha256':bad['sha256']})
        wrong['reviewedEvidenceSha256'] = bad['sha256']
        with self.assertRaises(planner.Refusal): planner.cli_evidence(wrong, planner.cohort.Inputs(self.base))
        (self.base / custody['path']).write_text('{}')
        with self.assertRaises(planner.Refusal): planner.cli_evidence(prepared, planner.cohort.Inputs(self.base))

def load_tests(loader, tests, pattern):
    return unittest.TestSuite(cls(name) for cls in (Split, Derived)
                             for name in cls.__dict__ if name.startswith('test_'))

if __name__ == '__main__': unittest.main()
