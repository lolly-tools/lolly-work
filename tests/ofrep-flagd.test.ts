/**
 * The OFREP resolver against a real flagd, loaded with
 * tests/fixtures/ofrep/flagd-flags.json. Skipped unless LW_TEST_OFREP_URL names
 * a running flagd's OFREP port, for example:
 *
 *   docker run --rm -d --name lw-flagd -p 127.0.0.1:8016:8016 \
 *     -v "$PWD/tests/fixtures/ofrep:/etc/flagd:ro" ghcr.io/open-feature/flagd:v0.18.1 \
 *     start --uri file:/etc/flagd/flagd-flags.json
 *   LW_TEST_OFREP_URL=http://127.0.0.1:8016 node --test tests/ofrep-flagd.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfrepResolver, validateOfrepConfig, type OfrepConfig, type OfrepErrorReason } from '../server/src/policy/ofrep.ts';

const url = process.env.LW_TEST_OFREP_URL;

test('flagd decides by groups and role; a disabled, missing or non-boolean flag keeps Work\'s value', { skip: !url && 'set LW_TEST_OFREP_URL to a flagd OFREP port to run' }, async () => {
  const config: Record<string, unknown> = {
    url, keyPrefix: 'lolly.', timeoutMs: 2000,
    flags: ['export-preflight', 'private-collab', 'jelly-effects', 'neurospicy', 'nearby-discovery'],
  };
  validateOfrepConfig(config, false);
  const errors: Array<[string, OfrepErrorReason]> = [];
  const resolver = createOfrepResolver({ config: config as unknown as OfrepConfig, metrics: { request: () => {}, error: (f, r) => errors.push([f, r]) } });

  const pilot = await resolver.evaluate({ groups: ['pilot', 'design'], role: 'author' });
  assert.equal(pilot.get('export-preflight'), true, 'targeted on the pilot group');
  assert.equal(pilot.get('private-collab'), true);
  const viewer = await resolver.evaluate({ groups: ['design'], role: 'viewer' });
  assert.equal(viewer.get('export-preflight'), false);
  assert.equal(viewer.get('private-collab'), false, 'targeted on the role');

  // DISABLED in flagd, a string variant, and a key flagd does not have.
  for (const answers of [pilot, viewer]) {
    assert.equal(answers.has('jelly-effects'), false);
    assert.equal(answers.has('neurospicy'), false);
    assert.equal(answers.has('nearby-discovery'), false);
  }
  const reasons = new Map(errors.map(([f, r]) => [f, r]));
  assert.equal(reasons.get('neurospicy'), 'type_mismatch');
  assert.equal(reasons.get('nearby-discovery'), 'not_found');
  // flagd 0.18 answers a disabled flag with reason DISABLED and no value: Work's
  // value, and not an error.
  assert.equal(reasons.has('jelly-effects'), false);
  assert.ok(!reasons.has('export-preflight') && !reasons.has('private-collab'));
});
