// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkYunohostLint } from '../scripts/check-yunohost-lint.ts';

const report = () => ({ success: [], info: [], warning: [], error: [], critical: [] as string[] });

test('YunoHost lint separates publication metadata from code failures', () => {
  assert.deepEqual(checkYunohostLint({ ...report(), error: ['AppCatalog.state_is_working'], critical: ['AppCatalog.is_in_catalog'] }), {
    errors: [], publication: ['AppCatalog.state_is_working', 'AppCatalog.is_in_catalog'],
  });
});

test('YunoHost manifest, configuration, script and future catalog failures still block', () => {
  const names = ['Manifest.manifest_schema', 'App.config_panel', 'Script.bash_syntax', 'AppCatalog.revision_is_HEAD', 'new-check'];
  assert.deepEqual(checkYunohostLint({ ...report(), error: names }), { errors: names, publication: [] });
});

test('missing or malformed linter output fails closed', () => {
  for (const value of [null, {}, 'failed', { ...report(), critical: 'none' }, { ...report(), error: [1] }]) {
    assert.throws(() => checkYunohostLint(value), /linter report/);
  }
});
