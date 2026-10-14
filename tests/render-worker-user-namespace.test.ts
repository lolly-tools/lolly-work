/**
 * The render worker's user-namespace startup check (workers/render/src/user-namespace.ts):
 * when the chart grants CAP_SYS_ADMIN and CAP_SYS_CHROOT for Chromium's sandbox it also sets
 * LW_RENDER_REQUIRE_USER_NAMESPACE=1, and the worker must refuse to start if its uid_map
 * reaches host UID 0 - the case where an API server silently dropped hostUsers: false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUserNamespace } from '../workers/render/src/user-namespace.ts';

const map = (text: string) => () => text;

test('an unset or empty requirement never reads the map', () => {
  const unreadable = () => { throw new Error('should not be read'); };
  assert.doesNotThrow(() => assertUserNamespace(undefined, unreadable));
  assert.doesNotThrow(() => assertUserNamespace('', unreadable));
});

test('a pod in its own user namespace passes', () => {
  // Measured on RKE2 1.35 / containerd 2.2 with hostUsers: false.
  assert.doesNotThrow(() => assertUserNamespace('1', map('         0  672268288      65536\n')));
  assert.doesNotThrow(() => assertUserNamespace('1', map('0 3923640320 65536\n65536 4000000000 1000\n')));
});

test('a pod sharing the node\'s user namespace is refused', () => {
  assert.throws(() => assertUserNamespace('1', map('         0          0 4294967295\n')), /shares the node's user namespace/);
  assert.throws(() => assertUserNamespace('1', map('0 100000 65536\n65536 0 1\n')), /shares the node's user namespace/);
});

test('malformed, unreadable and unknown settings are refused', () => {
  for (const text of ['', 'garbage', '0 0', '0 -1 10', '0 1.5 10']) {
    assert.throws(() => assertUserNamespace('1', map(text)), /malformed/, JSON.stringify(text));
  }
  assert.throws(() => assertUserNamespace('1', () => { throw new Error('ENOENT'); }), /unreadable/);
  for (const value of ['0', 'true', 'yes']) assert.throws(() => assertUserNamespace(value, map('0 0 4294967295')), /must be 1 or unset/);
});
