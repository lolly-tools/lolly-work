import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('admission protocol, HTTP boundaries and snapshot safeguards', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, ['--test',
    'services/admission/test/protocol.test.mjs', 'services/admission/test/http.test.mjs',
    'services/admission/test/snapshot.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
