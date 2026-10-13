# SPDX-License-Identifier: MPL-2.0
"""Offline producer custody regressions; no deployment or qualification."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
registry = load('public-build-source-registry')
matched = load('public-matched-baseline')

class SourceClosure(unittest.TestCase):
    def setUp(self):
        self.refs = [{'path': str(SCRIPTS / name), 'sha256': hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest()}
                     for name in sorted(registry.source_names())]
    def test_complete_current_closure(self):
        result = registry.verify_sources(self.refs, matched.a.read_ref)
        self.assertTrue({'public-delivery-native.py', 'stage-public-shell.py', 'generation-acceptance.py',
                         'publish-private-shell.py', 'public-build-source-registry.py', 'public-serving-continuation.py'} <= result.keys())
    def test_missing_native_or_owner_helper(self):
        for name in ['public-delivery-native.py', 'stage-public-shell.py', 'public-serving-continuation.py']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'Complete original'):
                registry.verify_sources([r for r in self.refs if Path(r['path']).name != name], matched.a.read_ref)
    def test_consistently_rehashed_changed_native_or_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ['public-delivery-native.py', 'stage-public-shell.py', 'public-serving-continuation.py']:
                path = Path(directory) / name; path.write_bytes((SCRIPTS / name).read_bytes() + b'\n# changed\n')
                refs = copy.deepcopy(self.refs)
                for ref in refs:
                    if Path(ref['path']).name == name:
                        ref.update(path=str(path.resolve()), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'maintained helper'):
                    registry.verify_sources(refs, matched.a.read_ref)

class ProducerArguments(unittest.TestCase):
    def setUp(self):
        self.c = {'archiveProof': {'path': '/proof.json', 'sha256': 'a' * 64},
                  'nativeMetadata': {'path': '/metadata.json'}, 'signatureProducer': {'path': '/verify-public-metadata.mjs'}}
        self.native = {'metadataSource': {'path': '/public-image-metadata.py'}}
        self.pin_ref = {'path': '/pin.json'}; self.pin = {'kty': 'EC', 'crv': 'P-256', 'x': 'x', 'y': 'y'}
        self.signature = {'publicPinSha256': hashlib.sha256(json.dumps(self.pin, separators=(',', ':')).encode()).hexdigest()}
        self.metadata = {'argv': ['/python', '-B', '/public-image-metadata.py', '--archive-proof', '/proof.json',
                                 '--archive-proof-sha256', 'a' * 64, '--output', '/metadata.json']}
        self.command = {'argv': ['/node', '/verify-public-metadata.mjs', '/metadata.json', '/pin.json']}
    def run_check(self):
        matched.producer_arguments(self.c, self.native, self.signature, self.metadata, self.command, self.pin_ref, self.pin)
    def test_exact_original_arguments(self): self.run_check()
    def test_unrelated_proof_or_metadata(self):
        for argv, index in [(self.metadata['argv'], 4), (self.metadata['argv'], 6), (self.command['argv'], 2)]:
            old = argv[index]; argv[index] = '/different'
            with self.assertRaisesRegex(RuntimeError, 'Exact original'): self.run_check()
            argv[index] = old
    def test_other_pin_argument_or_signature(self):
        self.command['argv'][-1] = '/other-pin.json'
        with self.assertRaisesRegex(RuntimeError, 'Exact original'): self.run_check()
        self.command['argv'][-1] = '/pin.json'; self.signature['publicPinSha256'] = 'b' * 64
        with self.assertRaisesRegex(RuntimeError, 'another pin'): self.run_check()
    def test_wrapped_producer_is_not_original_command(self):
        self.metadata['argv'].insert(1, '/wrapper.py')
        with self.assertRaisesRegex(RuntimeError, 'Exact original'): self.run_check()

if __name__ == '__main__': unittest.main()
