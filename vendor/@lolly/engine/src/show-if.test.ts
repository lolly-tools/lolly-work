// SPDX-License-Identifier: MPL-2.0
/**
 * matchesShowIf - the one visibility predicate for inputs and select options.
 *
 * A map is every pair required, a value may be a list of accepted values; a list
 * of maps is any one sufficient. The shell's sidebar and the option renderer both
 * call this, so the semantics are pinned here once.
 *
 * Run directly:  node --test engine/src/show-if.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesShowIf } from './inputs.ts';

const values = { renderMode: 'vector', chartType: 'bar', stackMode: 'grouped', vectorize: true, n: 3 };

test('nothing declared holds; an empty map holds; an empty list does not', () => {
  assert.equal(matchesShowIf(undefined, values), true);
  assert.equal(matchesShowIf({}, values), true);
  assert.equal(matchesShowIf([], values), false);
});

test('a map is every pair required, and a listed value is any of the list', () => {
  assert.equal(matchesShowIf({ vectorize: true }, values), true);
  assert.equal(matchesShowIf({ vectorize: false }, values), false);
  assert.equal(matchesShowIf({ chartType: ['bar', 'line'] }, values), true);
  assert.equal(matchesShowIf({ chartType: ['line', 'area'] }, values), false);
  assert.equal(matchesShowIf({ renderMode: 'vector', chartType: 'bar' }, values), true);
  assert.equal(matchesShowIf({ renderMode: 'vector', chartType: 'line' }, values), false);
  assert.equal(matchesShowIf({ missing: 'x' }, values), false, 'an input the model lacks never matches');
});

test('a list of maps is any one sufficient: the OR an ANDed map cannot say', () => {
  const orShaped = [
    { renderMode: 'vector', chartType: ['bar', 'bar-horizontal'] },
    { renderMode: 'scene', sceneType: 'bar3d' },
  ];
  assert.equal(matchesShowIf(orShaped, values), true);
  assert.equal(matchesShowIf(orShaped, { ...values, chartType: 'line' }), false);
  assert.equal(matchesShowIf(orShaped, { renderMode: 'scene', sceneType: 'bar3d' }), true);
  assert.equal(matchesShowIf(orShaped, { renderMode: 'scene', sceneType: 'surface3d' }), false);
});

test('comparison is strict: a number is not its string, a boolean is not a word', () => {
  assert.equal(matchesShowIf({ n: 3 }, values), true);
  assert.equal(matchesShowIf({ n: '3' }, values), false);
  assert.equal(matchesShowIf({ vectorize: 'true' }, values), false);
});
