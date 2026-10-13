# SPDX-License-Identifier: MPL-2.0
"""Exercise actual qualification orchestration with explicit synthetic transports."""
import copy, importlib.util, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reuse_runtime_fixture', Path(__file__).with_name('test_public_delivery_runtime.py'))
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
s = f.s


class StageModelReuse(unittest.TestCase):
    def fixture(self, reuse=True, change=None):
        base = f.ModelCheckpoints(); op, events, saved, _, held = base.stage(change)
        original = {'status': 'SYNTHETIC_PRIOR_REPORT_NOT_ACCEPTANCE'}
        calls = []
        if reuse:
            op.model_reuse = {'modelsTLS': original}
            def begin(stage, bound, physical):
                events.append('reuse-begin'); self.assertIs(stage, op); self.assertIs(bound, op.model_reuse)
                self.assertTrue(physical['allPhysicalHashesVerified']); return {'syntheticStart': True}
            def finish(stage, bound, start, physical, report):
                events.append('reuse-finish'); self.assertEqual(start, {'syntheticStart': True})
                self.assertTrue(physical['allPhysicalHashesVerified']); self.assertEqual(report, 'models-http.original.json')
                return {'status': 'SYNTHETIC_REUSE_PROOF_NOT_ACCEPTANCE'}
            op.model_reuse_helper = SimpleNamespace(stage_begin=begin, stage_finish=finish)
        def verify(origin, models, telemetry=None, **kwargs):
            events.append('tls'); calls.append(kwargs)
            return {'status': 'SYNTHETIC_HTTP_NOT_ACCEPTANCE'}
        helper = SimpleNamespace(verify_models_tls=verify)
        return op, events, saved, held, helper, calls, original

    def run_fixture(self, parts):
        op, events, saved, held, helper, calls, original = parts
        with patch.object(s, 'module', return_value=helper), patch.object(s.l, 'held', side_effect=held):
            result = op.qualify()
        return result

    def test_default_still_requests_all_full_bodies(self):
        parts = self.fixture(False); result = self.run_fixture(parts)
        self.assertTrue(result['actualNativeVerified']); self.assertEqual(parts[5], [{}])
        self.assertNotIn('reuse', parts[2]['models.actual.json']); self.assertNotIn('model-reuse.actual.json', parts[2])
        self.assertEqual(parts[1].count('models'), 3)

    def test_reuse_keeps_three_full_hashes_native_http_freshness_and_explicit_proof(self):
        parts = self.fixture(); self.run_fixture(parts)
        op, events, saved, _, _, calls, original = parts
        self.assertEqual(calls, [{'original': original}])
        self.assertEqual(events, ['fresh', 'static', 'models', 'reuse-begin', 'native-http', 'static', 'models', 'tls', 'models', 'fresh', 'reuse-finish'])
        self.assertEqual(saved['models.actual.json']['reuse'], 'model-reuse.actual.json')
        self.assertEqual(saved['model-reuse.actual.json']['status'], 'SYNTHETIC_REUSE_PROOF_NOT_ACCEPTANCE')
        self.assertFalse(saved['models.actual.json']['modelsMounted'])

    def test_stale_or_replaced_process_before_start_never_falls_back(self):
        parts = self.fixture()
        def fail(*args): raise RuntimeError('stale or replaced native process')
        parts[0].model_reuse_helper.stage_begin = fail
        with self.assertRaisesRegex(RuntimeError, 'stale or replaced'): self.run_fixture(parts)
        self.assertEqual(parts[5], []); self.assertNotIn('models.actual.json', parts[2])

    def test_final_process_or_freshness_failure_never_emits_model_acceptance(self):
        parts = self.fixture()
        def fail(*args): raise RuntimeError('final native process changed')
        parts[0].model_reuse_helper.stage_finish = fail
        with self.assertRaisesRegex(RuntimeError, 'final native process'): self.run_fixture(parts)
        self.assertEqual(len(parts[5]), 1); self.assertNotIn('models.actual.json', parts[2]); self.assertNotIn('model-reuse.actual.json', parts[2])

    def test_changed_physical_model_still_refuses_before_tls(self):
        def change(op, count):
            if count == 2: op.inode_changed = True
        parts = self.fixture(change=change)
        with self.assertRaises(RuntimeError): self.run_fixture(parts)
        self.assertEqual(parts[5], []); self.assertNotIn('models.actual.json', parts[2])

    def test_interrupted_http_never_emits_reuse_proof(self):
        parts = self.fixture()
        def fail(*args, **kwargs): raise OSError('TLS interrupted')
        parts[4].verify_models_tls = fail
        with self.assertRaises(OSError): self.run_fixture(parts)
        self.assertNotIn('models.actual.json', parts[2]); self.assertNotIn('model-reuse.actual.json', parts[2])


if __name__ == '__main__': unittest.main()
