// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrate, templateCacheStats } from './template.ts';

test('raw and escaped templates cannot alias through a source prefix', () => {
  for (let i = 0; i < 2; i++) {
    assert.equal(hydrate('{{v}}', { v: '<b>' }, { raw: true }), '<b>');
    assert.equal(hydrate(' raw {{v}}', { v: '<b>' }), ' raw &lt;b&gt;');
    assert.equal(hydrate('{{v}}', { v: '<b>' }), '&lt;b&gt;');
  }
});

test('large template churn stays bounded and oversized templates still render correctly', () => {
  for (let i = 0; i < 30; i++) {
    const source = `${i}:` + 'x'.repeat(100_000) + '{{v}}';
    assert.equal(hydrate(source, { v: 'ok' }), source.replace('{{v}}', 'ok'));
    assert.ok(templateCacheStats().sourceBytes <= templateCacheStats().maxSourceBytes);
  }
  assert.ok(templateCacheStats().entries < 30, 'byte limit must evict before the count limit');
  const before = templateCacheStats();
  const oversized = 'x'.repeat(before.maxSourceBytes) + '{{v}}';
  assert.equal(hydrate(oversized, { v: 'ok' }), oversized.replace('{{v}}', 'ok'));
  assert.deepEqual(templateCacheStats(), before, 'an oversized template must not displace reusable entries');
  assert.throws(() => hydrate('{{#if}}', {}));
  assert.deepEqual(templateCacheStats(), before);
  assert.equal(hydrate('{{v}}', { v: '<b>' }), '&lt;b&gt;', 'evicted templates recompile without output changes');
});
