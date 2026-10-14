#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Execute the bounded capture protocol against local synthetic read commands."""
import base64
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/capture-private-shell.py'
spec = importlib.util.spec_from_file_location('capture_shell', SCRIPT)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class Captures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.script = self.root / 'synthetic-read.py'
        self.target = {'transport': {'type': 'local', 'kubectl': [sys.executable, str(self.script)],
                                    'kubeconfig': '/synthetic config;literal', 'context': 'synthetic $(literal)'}}

    def records(self, snapshot):
        return [json.loads(Path(ref['path']).read_bytes()) for ref in snapshot.receipts]

    def test_actual_bundle_preserves_each_literal_stdout_stderr_and_bounds_parallelism(self):
        log = self.root / 'timing.jsonl'
        self.script.write_text("""import json, os, sys, time
args=sys.argv; name=args[args.index('get')+2]
fd=os.open(%r,os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600)
os.write(fd,(json.dumps(['start',name,time.monotonic()])+'\\n').encode())
time.sleep(0.06)
sys.stdout.buffer.write((' { "name": '+json.dumps(name)+' }\\n\\n').encode())
sys.stderr.buffer.write(b'original diagnostic\\x00\\n')
os.write(fd,(json.dumps(['end',name,time.monotonic()])+'\\n').encode()); os.close(fd)
""" % str(log))
        queries = [('namespace', 'test-' + str(i), None) for i in range(18)]
        snapshot = m.capture(self.target, queries, self.root)
        self.assertTrue(snapshot.accepted)
        self.assertEqual(len(snapshot.receipts), 19)
        records = self.records(snapshot)
        self.assertEqual(sum('-transport.' in ref['path'] for ref in snapshot.receipts), 1)
        self.assertEqual(len(snapshot.outputs), 18)
        for record in records[1:]:
            name = record['query'][1]
            self.assertEqual(Path(record['originals']['stdout']['path']).read_bytes(), (' { "name": '+json.dumps(name)+' }\n\n').encode())
            self.assertEqual(Path(record['originals']['stderr']['path']).read_bytes(), b'original diagnostic\x00\n')
            self.assertEqual(snapshot.get('namespace', name), {'name': name})
        active = maximum = 0
        for phase, _, _ in sorted([json.loads(line) for line in log.read_text().splitlines()], key=lambda row: row[2]):
            active += 1 if phase == 'start' else -1
            maximum = max(maximum, active)
        self.assertGreaterEqual(maximum, 2); self.assertLessEqual(maximum, 4); self.assertEqual(active, 0)
        with self.assertRaises(ValueError): snapshot.get('namespace', 'uncaptured')

    def test_failed_command_retains_originals_and_other_completed_results(self):
        self.script.write_text("import sys\nname=sys.argv[sys.argv.index('get')+2]\nprint('literal '+name)\nprint('original error',file=sys.stderr)\nsys.exit(7 if name=='failure' else 0)\n")
        snapshot = m.capture(self.target, [('namespace', 'failure', None), ('namespace', 'success', None)], self.root)
        self.assertFalse(snapshot.accepted)
        records = self.records(snapshot)
        self.assertEqual(len(records), 3)
        failed = next(record for record in records[1:] if record['exitCode'] == 7)
        self.assertEqual(Path(failed['originals']['stdout']['path']).read_bytes(), b'literal failure\n')
        self.assertEqual(Path(failed['originals']['stderr']['path']).read_bytes(), b'original error\n')
        self.assertEqual(snapshot.outputs[('namespace','success',None)], b'literal success\n')

    def test_timeout_overflow_and_closed_pipes_are_bounded_with_partial_originals(self):
        for source, timeout, limit, timed_out, complete in [
            ("import sys,time;print('before',flush=True);print('error',file=sys.stderr,flush=True);time.sleep(20)", .15, 100, True, True),
            ("import os,time;os.close(1);os.close(2);time.sleep(20)", .15, 100, True, True),
            ("import sys;sys.stdout.buffer.write(b'x'*8192)", 3, 100, False, False),
        ]:
            started = time.monotonic()
            result = m.bounded_process([sys.executable, '-c', source], None, timeout, limit)
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(result['timedOut'], timed_out); self.assertEqual(result['complete'], complete)
            if 'before' in source:
                self.assertEqual(result['stdout'], b'before\n'); self.assertEqual(result['stderr'], b'error\n')
            if "b'x'" in source:
                self.assertEqual(result['stdout'], b'x' * 100); self.assertGreater(result['observed']['stdout'], 100)

    def test_partial_transport_keeps_completed_command_and_unparsed_original_suffix(self):
        row = {'index': 0, 'query': ['namespace','one',None], 'stdout': base64.b64encode(b'first original\n').decode(),
               'stderr': base64.b64encode(b'first error\n').decode(), 'observed': {'stdout': 15, 'stderr': 12},
               'exitCode': 0, 'timedOut': False, 'complete': True, 'launchError': None}
        raw = json.dumps(row).encode()+b'\n{"index":1,"stdout":"interrupted'
        argv = [sys.executable, '-c', 'import sys;sys.stdout.buffer.write('+repr(raw)+');sys.stderr.write("connection lost");sys.exit(255)']
        with patch.object(m, 'transport', return_value=(argv, ['/synthetic-kubectl'])):
            snapshot = m.capture(self.target, [('namespace','one',None),('namespace','two',None)], self.root)
        self.assertFalse(snapshot.accepted)
        records = self.records(snapshot)
        self.assertEqual(len(records), 2)
        self.assertEqual(Path(records[0]['originals']['stdout']['path']).read_bytes(), raw)
        self.assertEqual(Path(records[0]['originals']['stderr']['path']).read_bytes(), b'connection lost')
        self.assertEqual(Path(records[1]['originals']['stdout']['path']).read_bytes(), b'first original\n')

    def test_unknown_mutating_secret_scope_and_duplicate_selectors_refuse_before_transport(self):
        bad = [('secret','password','private'), ('delete','pod','private'), ('pods',None,None), ('namespace','--all',None),
               ('namespace','name; touch /tmp/unwanted',None), ('pv',None,'private'), ('pods',None,'*')]
        for query in bad:
            with self.subTest(query=query), patch.object(m, 'bounded_process') as run:
                with self.assertRaises(ValueError): m.capture(self.target, [query], self.root)
                run.assert_not_called()
        with self.assertRaises(ValueError): m.capture(self.target, [('pv',None,None)] * 2, self.root)
        with self.assertRaises(ValueError): m.capture(self.target, [('namespace','n'+str(i),None) for i in range(65)], self.root)

    def test_remote_stdin_unknown_keys_duplicates_and_byte_limit_refuse_without_execution(self):
        marker = self.root / 'never-written'
        request = {'version': 1, 'prefix': [sys.executable,'-c', 'from pathlib import Path;Path('+repr(str(marker))+').touch()'], 'queries': [['pv',None,None]]}
        for raw in [json.dumps({**request,'unknown':True}).encode(), b'{"version":1,"version":1}', b' '*(m.MAX_INPUT+1)]:
            result = subprocess.run([sys.executable,'-B',str(SCRIPT),'--remote'],input=raw,capture_output=True,timeout=3)
            self.assertNotEqual(result.returncode,0); self.assertFalse(marker.exists())

    def test_ssh_keeps_reviewed_target_host_keys_jump_and_literal_arguments(self):
        target = {'transport': {**self.target['transport'], 'type': 'ssh', 'host': 'reviewed-host',
                               'knownHostsFile': '/reviewed/known hosts', 'jump': 'reviewed-jump', 'sudo': True}}
        argv, prefix = m.transport(target)
        self.assertEqual(argv[:5], ['ssh','-oBatchMode=yes','-oConnectTimeout=12','-oStrictHostKeyChecking=yes','-oUserKnownHostsFile=/reviewed/known hosts'])
        self.assertEqual(argv[5:8], ['-J','reviewed-jump','reviewed-host'])
        decoded = shlex.split(argv[-1])
        self.assertEqual(decoded[:3], ['python3','-B','-c']); self.assertEqual(decoded[3], SCRIPT.read_text())
        self.assertEqual(decoded[4:], ['--remote'])
        self.assertEqual(prefix, ['sudo','-n',*target['transport']['kubectl'],'--kubeconfig','/synthetic config;literal','--context','synthetic $(literal)'])


if __name__ == '__main__':
    unittest.main()
