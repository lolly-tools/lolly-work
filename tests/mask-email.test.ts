/**
 * Masked addresses (plans/74 invite spec 2.6, security rule 3): pages and
 * notices name an invited address without spelling it out, and screen
 * readers get the same mask in words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail, maskEmailSpoken } from '../server/src/access/mask.ts';

test('two characters of a local part of four or more, one of a shorter one; the domain whole', () => {
  assert.equal(maskEmail('andy.fitzsimon+t1@suse.com'), 'an•••@suse.com');
  assert.equal(maskEmail('sam.k@work.com'), 'sa•••@work.com');
  assert.equal(maskEmail('sami@work.com'), 'sa•••@work.com');
  assert.equal(maskEmail('sam@work.com'), 's•••@work.com');
  assert.equal(maskEmail('jo@work.com'), 'j•••@work.com');
  assert.equal(maskEmail('j@work.com'), 'j•••@work.com');
});

test('the mask never holds the full local part of a usual address', () => {
  for (const email of ['sam@work.com', 'anna@work.com', 'an.fitzsimon@suse.com']) {
    assert.ok(!maskEmail(email).includes(email.split('@')[0]!), email);
  }
});

test('case and spaces are normalised; an address with "@" in the local part masks on the last one', () => {
  assert.equal(maskEmail('  Sam.K@Work.COM '), 'sa•••@work.com');
  assert.equal(maskEmail('"a@b"@work.com'), '"a•••@work.com');
});

test('a character outside the BMP is kept whole', () => {
  assert.equal(maskEmail('\u{1F600}\u{1F600}zz@work.com'), '\u{1F600}\u{1F600}•••@work.com');
});

test('something that is not an address is masked completely', () => {
  for (const v of ['', 'nobody', '@work.com', 'sam@']) assert.equal(maskEmail(v), '•••', JSON.stringify(v));
  assert.equal(maskEmailSpoken('nobody'), 'a hidden address');
});

test('the spoken form says the same thing in words', () => {
  assert.equal(maskEmailSpoken('andy.fitzsimon+t1@suse.com'), 'an address at suse.com that starts with an');
  assert.equal(maskEmailSpoken('sam@work.com'), 'an address at work.com that starts with s');
});
