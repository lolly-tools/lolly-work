// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog availability dates are whole days in the admin's time zone (lolly plan 320
 * C4). Run under a fixed zone so the arithmetic is checked, not the machine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const SCRIPT = `
  const { dayBound, localDateValue } = await import('./console/lifecycle-dates.js');
  console.log(JSON.stringify({
    end: dayBound('2026-12-31', 'end'),
    start: dayBound('2026-12-01', 'start'),
    bad: [dayBound('2026-02-30', 'end'), dayBound('', 'start'), dayBound('31/12/2026', 'end')],
    back: localDateValue(dayBound('2026-12-31', 'end')),
    stored: localDateValue('2026-12-31T00:00:00.000Z'),
  }));
`;

function inZone(tz: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('an end date closes at the last moment of that day where the admin is', () => {
  const ny = inZone('America/New_York');
  assert.equal(ny.end, '2027-01-01T04:59:59.999Z', 'ends 31 Dec 23:59:59.999 in New York, not 30 Dec in the evening');
  assert.equal(ny.start, '2026-12-01T05:00:00.000Z');
  assert.equal(ny.back, '2026-12-31', 'the input shows the day that was chosen');
  assert.equal(ny.stored, '2026-12-30', 'a value stored by the old console reads as the day it really ended');
  const tokyo = inZone('Asia/Tokyo');
  assert.equal(tokyo.end, '2026-12-31T14:59:59.999Z');
});

test('an empty or impossible date is no date', () => {
  assert.deepEqual(inZone('UTC').bad, [null, null, null]);
});
