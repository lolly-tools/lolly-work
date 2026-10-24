// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy/preview/restore-rehearsal.py is Python standard library only. Its tests
// drive the real operator against a fake kubectl and never contact a cluster.
test('restore rehearsal operator renders isolated manifests, checks every step and tears down', { timeout: 600_000 }, async () => {
  const { status, output } = await new Promise<{ status: number | null; output: string }>(resolve => {
    const child = spawn('python3', ['-B', '-m', 'unittest', 'test_restore_rehearsal'],
      { cwd: fileURLToPath(new URL('.', import.meta.url)) });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('close', code => resolve({ status: code, output: text }));
    child.on('error', error => resolve({ status: null, output: String(error) }));
  });
  assert.equal(status, 0, output.slice(-6000));
});
