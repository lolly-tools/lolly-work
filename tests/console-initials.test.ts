// Avatar initials in the console's People views. The fault this pins: a name with a
// qualifier in brackets, "Ada (Admin) Ops", drew "A(" in the avatar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initialsOf } from '../console/initials.js';

test('a qualifier in brackets is not part of the name', () => {
  assert.equal(initialsOf('Ada (Admin) Ops', 'admin@suse.example'), 'AO');
  assert.equal(initialsOf('Bruno (Brand lead) Marques'), 'BM');
  assert.equal(initialsOf('Cveta [Contractor] Vidal'), 'CV');
  assert.equal(initialsOf('Mira {Marketer} Fields'), 'MF');
});

test('a word is read from its first letter or digit', () => {
  assert.equal(initialsOf('"Ada" O\'Neil'), 'AO');
  assert.equal(initialsOf('Ada (Admin'), 'AA');
  assert.equal(initialsOf('- Ada'), 'A');
  assert.equal(initialsOf('Éva Öz'), 'ÉÖ');
  assert.equal(initialsOf('李 小龍'), '李小');
});

test('a plain name keeps the letters it had before', () => {
  assert.equal(initialsOf('Ada Ops'), 'AO');
  assert.equal(initialsOf('Ada Maria Ops'), 'AM');
  assert.equal(initialsOf('Ada'), 'A');
  assert.equal(initialsOf('ada.ops'), 'AO');
});

test('an account with no name uses the part of its email before the @', () => {
  assert.equal(initialsOf('', 'admin@suse.example'), 'AD');
  assert.equal(initialsOf(null, 'first.last@suse.example'), 'FL');
  assert.equal(initialsOf(undefined, 'first_last+tag@suse.example'), 'FL');
  assert.equal(initialsOf('(Admin)', 'ops@suse.example'), 'OP');
});

test('nothing to read gives a question mark', () => {
  assert.equal(initialsOf('', ''), '?');
  assert.equal(initialsOf(null, null), '?');
  assert.equal(initialsOf('()', '@suse.example'), '?');
});

test('every avatar in the console goes through the one helper', () => {
  const app = readFileSync(fileURLToPath(new URL('../console/app.js', import.meta.url)), 'utf8');
  const avatars = app.split('\n').filter((line) => line.includes("'invite-avatar"));
  assert.ok(avatars.length >= 3, 'the invitation, directory and account avatars are still in app.js');
  // The letters are built on the avatar's own line or the line after it.
  const lines = app.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.includes("'invite-avatar")) continue;
    assert.match(`${line}\n${lines[i + 1] ?? ''}`, /initialsOf\(/, `line ${i + 1} builds its own initials`);
  }
});
