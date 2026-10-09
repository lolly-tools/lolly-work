// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageArguments, matchedShell, ownsContainer } from '../scripts/qualify-render-worker-image.ts';

test('image preparation refuses wrong source and engine without any build or browser', () => {
  const source = 'a'.repeat(40), pin = { generatedFrom: source, engine: { version: '1.248.0' } };
  assert.equal(matchedShell(pin, source, '1.248.0'), source);
  for (const args of [[pin, 'b'.repeat(40), '1.248.0'], [pin, source, '1.245.0'], [{ ...pin, generatedFrom: 'main' }, 'main', '1.248.0'], [null, source, '1.248.0']]) {
    assert.throws(() => matchedShell(...args as [unknown, string, string]));
  }
  for (const args of [[], ['--image', 'x'], ['--image', '--privileged', '--lolly-root', '.'], ['--image', 'x', '--image', 'y', '--lolly-root', '.'], ['--image', 'x;echo', '--lolly-root', '.'], ['--unsafe', 'x']]) {
    assert.throws(() => imageArguments(args));
  }
});

test('cleanup authorizes only the exact created container identity/image/label', () => {
  const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`, label = 'owned';
  const inspect = { Id: id, Image: image, Config: { Labels: { 'org.lolly.qualification': label } } };
  assert.equal(ownsContainer(inspect, id, image, label), true);
  for (const value of [null, { ...inspect, Id: 'c'.repeat(64) }, { ...inspect, Image: `sha256:${'c'.repeat(64)}` }, { ...inspect, Config: { Labels: {} } }]) {
    assert.equal(ownsContainer(value, id, image, label), false);
  }
});

test('real image qualification is mandatory before its OCI transport is accepted', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const run = workflow.indexOf('node scripts/qualify-render-worker-image.ts');
  assert.ok(run > 0 && run < workflow.indexOf('- name: Bind the booted image to its offline transport'));
  assert.match(workflow, /repository: lolly-tools\/lolly/);
  assert.match(workflow, /ref: \$\{\{ steps\.matched-shell\.outputs\.source \}\}/);
  const runner = readFileSync(new URL('../scripts/qualify-render-worker-image.ts', import.meta.url), 'utf8');
  assert.match(runner, /\['run', 'build:web:release'\]/);
  assert.doesNotMatch(runner, /LOLLY_WEBGPU_QUALIFICATION|LOLLY_SKIP|--privileged|--ipc.?host|SYS_ADMIN/);
  assert.match(runner, /'--network', 'none'/);
  assert.match(runner, /'--env', 'LOLLY_RENDER_IMAGE_TEST=1'/);
  const imageTest = readFileSync(new URL('./render-worker-image.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(imageTest, /__setBrowserGetterForTests|chromium\.launch/);
  assert.match(imageTest, /worker\.getBrowser\(\)/);
});
