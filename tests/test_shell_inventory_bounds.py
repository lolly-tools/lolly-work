#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Shell file capacity is independent of raw catalog and walk entry limits."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).parents[1] / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


m = load('prepare-private-cohort')
a = load('assemble-private-shell-input')
o = load('public-delivery-overlay')
p = load('publish-private-shell')


class Bounds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve(); self.root = self.base / 'tree'; self.root.mkdir()
        rows = []
        for name in ('a', 'b', 'nested/c'):
            file = self.root / name; file.parent.mkdir(exist_ok=True); file.write_bytes(b'x')
            rows.append({'path': name, 'size': 1, 'sha256': hashlib.sha256(b'x').hexdigest()})
        self.manifest = {'version': 1, 'files': rows, 'totalBytes': 3}
        data = m.canonical(self.manifest); manifest = self.base / 'manifest.json'; manifest.write_bytes(data)
        self.value = {'root': str(self.root), 'manifest': {'path': str(manifest), 'sha256': hashlib.sha256(data).hexdigest()}}

    def test_shell_file_cap_is_explicit_and_catalog_and_entries_remain_original(self):
        self.assertEqual((m.MAX_FILES, m.MAX_SHELL_FILES, m.MAX_TREE_ENTRIES), (100_000, 120_000, 200_000))
        with patch.object(m, 'MAX_FILES', 2), patch.object(m, 'MAX_SHELL_FILES', 3):
            with self.assertRaises(m.Refusal): m.Tree(self.value, m.Inputs(self.base))
            inputs = m.Inputs(self.base); tree = m.Tree(self.value, inputs, shell=True)
            self.assertEqual(len(tree.files), 3); inputs.unchanged()
        with patch.object(m, 'MAX_SHELL_FILES', 2):
            with self.assertRaises(m.Refusal): m.Tree(self.value, m.Inputs(self.base), shell=True)
        with patch.object(m, 'MAX_TREE_ENTRIES', 3):
            with self.assertRaises(m.Refusal): m.Tree(self.value, m.Inputs(self.base), shell=True)

    def test_adapter_shell_and_raw_manifest_limits_are_separate(self):
        with patch.object(a.cohort, 'MAX_FILES', 2), patch.object(a.cohort, 'MAX_SHELL_FILES', 3):
            with self.assertRaises(a.Refusal): a.manifest_id(self.manifest)
            self.assertTrue(a.manifest_id(self.manifest, shell_tree=True).startswith('release-'))
        with patch.object(a.cohort, 'MAX_SHELL_FILES', 2):
            with self.assertRaises(a.Refusal): a.manifest_id(self.manifest, shell_tree=True)

    def test_delivery_inventory_exact_cap_and_overflow(self):
        self.assertEqual(o.MAX_FILES, 120_000)
        with patch.object(o, 'MAX_FILES', 3): self.assertEqual(len(o.manifest(self.manifest)), 3)
        with patch.object(o, 'MAX_FILES', 2):
            with self.assertRaises(o.Refusal): o.manifest(self.manifest)

    def test_original_remote_owner_hash_enforces_each_tree_limit(self):
        # Run the actual owner readback with proportional limits and tiny files.
        # No public key means this tests physical inventory only, not a signature.
        program = p.OWNER_READBACK.replace('shell,120000', 'shell,3').replace('pack,100000', 'pack,2')
        self.assertNotEqual(program, p.OWNER_READBACK)
        pack = self.base / 'pack'; pack.mkdir(); (pack / 'one').write_bytes(b'a'); (pack / 'two').write_bytes(b'b')
        pin = self.base / 'pin'; pin.write_bytes(b'pin')
        argv = [os.environ.get('LOLLY_TEST_NODE', 'node'), '-e', program, str(self.root), str(pack), str(pin)]
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout); self.assertEqual((len(value['shell']['files']), len(value['pack']['files'])), (3, 2))
        (pack / 'three').write_bytes(b'c')
        self.assertNotEqual(subprocess.run(argv, capture_output=True, timeout=30).returncode, 0)
        (pack / 'three').unlink(); (self.root / 'four').write_bytes(b'd')
        self.assertNotEqual(subprocess.run(argv, capture_output=True, timeout=30).returncode, 0)


if __name__ == '__main__': unittest.main(verbosity=2)
