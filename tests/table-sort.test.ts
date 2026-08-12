/**
 * The console's pure sort comparator (the DOM-free part of the table QoL work).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareValues, coerceNumber, coerceDate } from '../console/table-sort.js';

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

test('coercers: numbers strip separators; non-numbers and non-dates are NaN', () => {
  assert.equal(coerceNumber('12,345'), 12345);
  assert.equal(coerceNumber('12 345'), 12345);
  assert.ok(Number.isNaN(coerceNumber('12K')));
  assert.ok(Number.isNaN(coerceNumber('')));
  assert.equal(coerceDate('2026-03-05T10:24:00Z'), Date.parse('2026-03-05T10:24:00Z'));
  assert.ok(Number.isNaN(coerceDate('not a date')));
});

test('numeric ordering (incl. natural string-numeric), date ordering', () => {
  assert.equal(sign(compareValues('9', '100')), -1); // numeric, not lexical
  assert.equal(sign(compareValues('file2', 'file10')), -1); // natural order
  assert.equal(sign(compareValues('2026-01-01', '2026-12-31', 'date')), -1);
  assert.equal(compareValues('abc', 'abc'), 0);
});

test('blanks and the em-dash placeholder always sort last (ascending sign)', () => {
  for (const blank of ['', '—']) {
    assert.equal(compareValues(blank, 'x'), 1);  // blank after non-blank
    assert.equal(compareValues('x', blank), -1);
    assert.equal(compareValues(blank, blank), 0);
  }
});
