#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Real local POSIX shell execution with explicitly compatible utility shims.

The shims perform real filesystem stats/hashes and inject bounded failures.
They do not qualify the accepted Nginx image or its BusyBox implementation.
The existing strict inventory parser, complete manifests and stdout are used.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('public_hash_batch_test', HERE / 'scripts/stage-public-shell.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
MARKER = b'LOLLY_STATIC_HASH_SCAN_REFUSED'

# The exact pre-experiment literal provides a byte-equality/process baseline.
ORIGINAL = r'''set -eu
root=$1
cd "$root"
bad=$(find . -path ./models -prune -o \( ! -type d ! -type f \) -print)
test -z "$bad"
find . -path ./models -prune -o -type f -exec sh -eu -c 'for p do
  before=$(stat -c "%s %a %i %Y" "$p")
  digest=$(sha256sum "$p")
  after=$(stat -c "%s %a %i %Y" "$p")
  test "$before" = "$after"
  printf "%s\t%s\t%s\n" "$before" "$digest" "$p"
done' public-hashes {} +'''

# Only stat/SHA portability is emulated; normal traversal uses the platform's
# actual find. The optional find shim specifically models ignored child errors.
UTILITY = r'''import hashlib,json,os,pathlib,stat,subprocess,sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
log=pathlib.Path(os.environ['HASH_TEST_LOG'])
prior=[json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
call=1+sum(row['utility']==name for row in prior)
with log.open('a') as stream: stream.write(json.dumps({'utility':name,'call':call,'args':args})+'\n')
fault=os.environ.get('HASH_TEST_FAULT','')
if name=='find':
    if fault=='find-before': sys.exit(1)
    if '-exec' not in args:
        value=subprocess.run(['/usr/bin/find',*args],capture_output=True)
        sys.stdout.buffer.write(value.stdout);sys.stderr.buffer.write(value.stderr);sys.exit(value.returncode)
    if fault=='find-child':
        sys.stdout.write('LOLLY_STATIC_HASH_SCAN_REFUSED\n');sys.exit(0)
    files=[]
    for root,dirs,names in os.walk('.',followlinks=False):
        if root=='.' and 'models' in dirs: dirs.remove('models')
        files.extend(str(pathlib.Path(root)/p) for p in names if (pathlib.Path(root)/p).is_file())
    files=['./'+p for p in sorted(files)]
    index=args.index('-exec')
    value=subprocess.run([*args[index+1:-2],*files],capture_output=True) if files else None
    if value:
        sys.stdout.buffer.write(value.stdout);sys.stderr.buffer.write(value.stderr)
    # BusyBox find can lose an earlier exec-plus child failure. Deliberately
    # discard that status, so the stdout refusal record must prevent admission.
    sys.exit(0)
if name=='stat':
    if args[:2]!=['-c','%s %a %i %Y']: sys.exit(2)
    paths=args[2:]
    if fault=='stat-before' and call==1: sys.exit(1)
    if fault=='stat-later-batch' and call==3: sys.exit(1)
    if fault=='stat-after' and call==2: sys.exit(1)
    rows=[]
    try:
        for p in paths:
            v=os.lstat(p)
            rows.append(f'{v.st_size} {stat.S_IMODE(v.st_mode):o} {v.st_ino} {int(v.st_mtime)}')
    except OSError: sys.exit(1)
    if fault=='stat-short' and call==1: rows=rows[:-1]
    if fault=='stat-extra' and call==1: rows.append('0 644 1 1')
    if fault=='stat-instability' and call==2: rows[0]='1 644 1 1'
    print('\n'.join(rows))
    if fault=='link-after-stat' and call==2:
        p=pathlib.Path(paths[0]);p.unlink();p.symlink_to('models/held')
elif name=='sha256sum':
    if fault=='sha': sys.exit(1)
    rows=[]
    try:
        for p in args:
            # Deterministic unreadability control under a privileged test user.
            if os.stat(p).st_mode & 0o444==0: raise PermissionError(p)
            rows.append(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()+'  '+p)
    except OSError: sys.exit(1)
    if fault=='sha-short': rows=rows[:-1]
    if fault=='sha-extra': rows.append(hashlib.sha256(b'').hexdigest()+'  ./foreign')
    if fault=='sha-reverse': rows.reverse()
    print('\n'.join(rows))
    p=pathlib.Path(args[0])
    if fault=='content-change': p.write_bytes(p.read_bytes()+b'changed')
    if fault=='same-stat-content-change':
        v=p.stat();p.write_bytes(b'x'*v.st_size);os.utime(p,ns=(v.st_atime_ns,v.st_mtime_ns))
    if fault=='remove-after-sha': p.unlink()
else: sys.exit(2)
'''


class HashInventory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'static'
        self.root.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'utilities.jsonl'
        for name in ('stat', 'sha256sum'):
            self.shim(name)

    def shim(self, name):
        path = self.bin / name
        path.write_text(f'#!{sys.executable}\n{UTILITY}')
        path.chmod(0o755)

    def files(self, count, long=False):
        for i in range(count):
            name = f'file-{i:05d}' + ('-' + 'a' * 180 if long else '')
            self.file(name, f'content-{i}'.encode())

    def file(self, name, body=b'content', mode=0o644):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(mode)
        return path

    def manifest(self):
        result = {}
        for path in self.root.rglob('*'):
            relative = path.relative_to(self.root).as_posix()
            if path.is_file() and not relative.startswith('models/'):
                data = path.read_bytes()
                result[relative] = {'path': relative, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        return result

    def run_scan(self, script=None, fault='', ignore_child=False):
        if ignore_child:
            self.shim('find')
        self.log.unlink(missing_ok=True)
        env = {**os.environ, 'PATH': f'{self.bin}:/usr/bin:/bin:/sbin',
               'HASH_TEST_LOG': str(self.log), 'HASH_TEST_FAULT': fault}
        value = subprocess.run(['/bin/sh', '-eu', '-c', m.HASH_SCRIPT if script is None else script,
                                'public-static-hashes', str(self.root)], capture_output=True, env=env, timeout=90)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return value, calls

    def admit(self, value, expected):
        self.assertEqual(value.returncode, 0, value.stderr.decode())
        return m.inventory(value.stdout, expected)

    def refused(self, value, expected, marker=True):
        if marker:
            self.assertIn(MARKER, value.stdout)
        with self.assertRaises(m.Refusal):
            m.inventory(value.stdout, expected)

    def test_exact_baseline_literal_and_shell_syntax(self):
        self.assertEqual(hashlib.sha256(ORIGINAL.encode()).hexdigest(),
                         '2766fade056630fa5107b2991d1039ff7d53c1e97546a9970a0000fea2f36c05')
        value = subprocess.run(['/bin/sh', '-n', '-c', m.HASH_SCRIPT], capture_output=True)
        self.assertEqual(value.returncode, 0, value.stderr.decode())

    def test_zero_one_and_batch_boundaries_preserve_every_byte_and_hash_count(self):
        for count in (0, 1, 64, 65, 129):
            with self.subTest(files=count):
                self.files(count)
                expected = self.manifest()
                baseline, old_calls = self.run_scan(ORIGINAL, ignore_child=True)
                actual, calls = self.run_scan(ignore_child=True)
                self.assertEqual(actual.stdout, baseline.stdout)
                self.assertEqual(self.admit(actual, expected), self.admit(baseline, expected))
                tools = [r for r in calls if r['utility'] in ('stat', 'sha256sum')]
                previous = [r for r in old_calls if r['utility'] in ('stat', 'sha256sum')]
                self.assertEqual(len(tools), 3 * ((count + 63) // 64))
                self.assertEqual(len(previous), 3 * count)
                sha = [r for r in tools if r['utility'] == 'sha256sum']
                self.assertEqual(sum(len(r['args']) for r in sha), count)
                self.assertTrue(all(1 <= len(r['args']) <= 64 for r in sha))
                for index in range(0, len(tools), 3):
                    before, hashes, after = tools[index:index + 3]
                    self.assertEqual([before['utility'], hashes['utility'], after['utility']],
                                     ['stat', 'sha256sum', 'stat'])
                    self.assertEqual(before['args'][2:], hashes['args'])
                    self.assertEqual(after['args'][2:], hashes['args'])

    def test_huge_exec_argv_is_split_into_64_file_utility_calls(self):
        self.files(2049, long=True)
        actual, calls = self.run_scan(ignore_child=True)
        self.admit(actual, self.manifest())
        sha = [r for r in calls if r['utility'] == 'sha256sum']
        self.assertEqual([len(r['args']) for r in sha], [64] * 32 + [1])
        self.assertGreater(sum(len(p) + 1 for r in sha for p in r['args']), 128 * 1024)
        self.assertEqual(sum(r['utility'] == 'stat' for r in calls), 66)

    def test_actual_platform_find_and_special_accepted_paths(self):
        for name, mode in (('-leading', 0o644), ('space in path', 0o755), ('a/[glob]*?', 0o644),
                           ('a/quote\"single\'', 0o644)):
            self.file(name, mode=mode)
        self.file('models/held', b'pruned model')
        expected = self.manifest()
        old, _ = self.run_scan(ORIGINAL)
        actual, _ = self.run_scan()
        self.assertEqual(actual.stdout, old.stdout)
        self.admit(actual, expected)
        self.assertNotIn(b'pruned model', actual.stdout)
        self.assertNotIn(b'./models/', actual.stdout)

    def test_ambiguous_tab_newline_and_backslash_paths_emit_refusal(self):
        for name in ('tab\tpath', 'new\nline', 'back\\slash'):
            with self.subTest(path=repr(name)):
                path = self.file(name)
                expected = self.manifest()
                actual, calls = self.run_scan(ignore_child=True)
                self.assertEqual(actual.returncode, 0)  # Deliberately masked child error.
                self.refused(actual, expected)
                self.assertFalse(any(r['utility'] == 'sha256sum' for r in calls))
                path.unlink()

    def test_each_before_hash_after_failure_survives_ignored_child_exit(self):
        self.files(2)
        expected = self.manifest()
        for fault in ('stat-before', 'sha', 'stat-after', 'stat-instability'):
            with self.subTest(fault=fault):
                actual, _ = self.run_scan(fault=fault, ignore_child=True)
                self.assertEqual(actual.returncode, 0)
                self.refused(actual, expected)

    def test_later_batch_failure_marks_preceding_valid_output_unusable(self):
        self.files(129)
        actual, _ = self.run_scan(fault='stat-later-batch', ignore_child=True)
        self.assertEqual(actual.returncode, 0)
        self.assertEqual(sum(b'\t./file-' in line for line in actual.stdout.splitlines()), 64)
        self.refused(actual, self.manifest())

    def test_missing_extra_or_reordered_rows_never_admit(self):
        self.files(2)
        expected = self.manifest()
        for fault in ('stat-short', 'stat-extra', 'sha-short', 'sha-extra', 'sha-reverse'):
            with self.subTest(fault=fault):
                actual, _ = self.run_scan(fault=fault, ignore_child=True)
                self.refused(actual, expected, marker=fault != 'sha-reverse')

    def test_changed_removed_or_link_replacement_after_hash_refuse(self):
        for fault in ('content-change', 'same-stat-content-change', 'remove-after-sha', 'link-after-stat'):
            with self.subTest(fault=fault):
                self.file('file-00000', b'original')
                self.file('models/held', b'model')
                expected = self.manifest()
                actual, _ = self.run_scan(fault=fault, ignore_child=True)
                # Even a preserved original stat stamp must meet the independent
                # manifest; an unchanged old hash can describe the earlier read.
                if fault == 'same-stat-content-change':
                    with self.assertRaises(m.Refusal):
                        m.inventory(actual.stdout, self.manifest())
                else:
                    self.refused(actual, expected)
                (self.root / 'file-00000').unlink(missing_ok=True)

    def test_unreadable_file_and_unaccepted_modes_refuse(self):
        for mode in (0o000, 0o664, 0o775):
            with self.subTest(mode=oct(mode)):
                path = self.file('file')
                expected = self.manifest()
                path.chmod(mode)
                actual, _ = self.run_scan(ignore_child=True)
                self.refused(actual, expected, marker=mode == 0)
                path.unlink()

    def test_nonregular_files_and_model_pruning_preserve_original_boundary(self):
        self.file('normal')
        self.file('models/held')
        (self.root / 'models' / 'ignored-link').symlink_to('../normal')
        actual, _ = self.run_scan()
        self.admit(actual, self.manifest())
        for kind in ('symlink', 'fifo'):
            with self.subTest(kind=kind):
                path = self.root / 'unexpected'
                if kind == 'symlink':
                    path.symlink_to('normal')
                else:
                    os.mkfifo(path)
                actual, _ = self.run_scan()
                self.refused(actual, self.manifest())
                path.unlink()

    def test_find_failures_and_missing_root_always_emit_refusal(self):
        self.files(1)
        for fault in ('find-before', 'find-child'):
            with self.subTest(fault=fault):
                actual, _ = self.run_scan(fault=fault, ignore_child=True)
                self.refused(actual, self.manifest())
        self.root.rename(self.base / 'moved')
        actual, _ = self.run_scan()
        self.refused(actual, {})


if __name__ == '__main__':
    unittest.main()
