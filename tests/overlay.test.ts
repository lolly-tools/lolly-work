import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkParams, filterInputs, filterToolIndex, inputIsGoverned, lockedValues, resolveInputAccess, toolVisibleTo,
  type ToolOverlay,
} from '../server/src/policy/overlay.ts';

// The event-badge overlay from the parent plan §4.C, abbreviated.
const overlay: ToolOverlay = {
  toolId: 'event-badge',
  version: 4,
  inputAccess: {
    '*': [{ groups: ['*'], level: 'editable' }],
    logo: [
      { groups: ['brand-team'], level: 'editable' },
      { groups: ['*'], level: 'locked', value: 'acme/logo/primary' },
    ],
    accent: [
      { groups: ['brand-team'], level: 'editable' },
      { groups: ['*'], level: 'choice', allow: ['#0c322c', '#30ba78'] },
    ],
    discount: [
      { groups: ['sales-managers'], level: 'editable' },
      { groups: ['*'], level: 'hidden' },
    ],
  },
  visibility: { groups: ['marketing', 'brand-team', 'sales-managers'] },
};

test('first matching rule wins per group', () => {
  assert.equal(resolveInputAccess(overlay, 'logo', ['brand-team']).level, 'editable');
  assert.equal(resolveInputAccess(overlay, 'logo', ['marketing']).level, 'locked');
  assert.equal(resolveInputAccess(overlay, 'accent', ['marketing']).level, 'choice');
  assert.equal(resolveInputAccess(overlay, 'headline', ['marketing']).level, 'editable');
  assert.equal(resolveInputAccess(undefined, 'anything', []).level, 'editable');
});

test('an inherited Object.prototype name is not a rule table entry', () => {
  // `inputId` arrives from untrusted input - a collab op's key, a render param
  // name - and `inputAccess` is a plain object parsed from jsonb. A bare member
  // access resolves inherited names: `inputAccess['toString']` is a truthy
  // FUNCTION, which then throws `rules is not iterable` in the rule loop. A
  // three-entry deny-list of __proto__/constructor/prototype does not cover these.
  for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'constructor', '__proto__']) {
    assert.equal(
      resolveInputAccess(overlay, key, ['marketing']).level, 'editable',
      `'${key}' falls through to the '*' default instead of throwing`,
    );
  }
  // A table with no '*' default answers editable for an inherited name too,
  // rather than reading Object.prototype and throwing.
  const noDefault: ToolOverlay = { toolId: 't', version: 1, inputAccess: { logo: [{ groups: ['*'], level: 'locked' }] } };
  assert.equal(resolveInputAccess(noDefault, 'toString', ['marketing']).level, 'editable');
  // …and a table whose value is not a rule LIST at all is ignored, not iterated.
  const junk = { toolId: 't', version: 1, inputAccess: { logo: 'not a list' } } as unknown as ToolOverlay;
  assert.equal(resolveInputAccess(junk, 'logo', ['marketing']).level, 'editable');
});

test('hidden inputs are ABSENT from a filtered schema, locked ones annotated', () => {
  const inputs = [{ id: 'headline' }, { id: 'logo' }, { id: 'discount' }];
  const forMarketing = filterInputs(inputs, overlay, ['marketing']);
  assert.deepEqual(forMarketing.map((i) => i.id), ['headline', 'logo']);
  const logo = forMarketing.find((i) => i.id === 'logo');
  assert.equal(logo?.access?.level, 'locked');
  assert.equal(logo?.access?.value, 'acme/logo/primary');
  const forSales = filterInputs(inputs, overlay, ['sales-managers']);
  assert.deepEqual(forSales.map((i) => i.id), ['headline', 'logo', 'discount']);
});

test('checkParams: locked, hidden (probing), and out-of-choice violations', () => {
  const violations = checkParams(
    { headline: 'Hi', logo: 'evil', discount: '90', accent: '#ff0000' },
    overlay,
    ['marketing'],
  );
  assert.deepEqual(
    violations.map((v) => `${v.param}:${v.code}`).sort(),
    ['accent:INPUT_NOT_ALLOWED', 'discount:INPUT_HIDDEN', 'logo:INPUT_LOCKED'],
  );
  assert.deepEqual(checkParams({ accent: '#30ba78' }, overlay, ['marketing']), []);
  assert.deepEqual(checkParams({ logo: 'x', discount: '5' }, overlay, ['brand-team', 'sales-managers']), []);
});

test('lockedValues bakes policy values for the render', () => {
  assert.deepEqual(lockedValues(overlay, ['marketing']), { logo: 'acme/logo/primary' });
  assert.deepEqual(lockedValues(overlay, ['brand-team']), {});
});

test('inputIsGoverned: true for any rule set (own or `*` default), regardless of whether the groups asking match it', () => {
  // Governed by its own entry (whatever the rule's groups say).
  assert.equal(inputIsGoverned(overlay, 'logo'), true);
  assert.equal(inputIsGoverned(overlay, 'discount'), true);
  // Governed only by the `'*'` input-default entry.
  assert.equal(inputIsGoverned(overlay, 'headline'), true);
  // Genuinely ungoverned: no overlay at all, or an overlay with no
  // `inputAccess` table.
  assert.equal(inputIsGoverned(undefined, 'anything'), false);
  assert.equal(inputIsGoverned({ toolId: 'x', version: 1 }, 'anything'), false);
  // Own-property discipline matches `resolveInputAccess`'s: an inherited
  // `Object.prototype` name must not read as a governed input.
  const proto: ToolOverlay = { toolId: 'x', version: 1, inputAccess: {} };
  assert.equal(inputIsGoverned(proto, 'toString'), false);
});

test('visibility filters the catalog feed; no overlay = visible', () => {
  assert.equal(toolVisibleTo(overlay, ['marketing']), true);
  assert.equal(toolVisibleTo(overlay, ['engineering']), false);
  assert.equal(toolVisibleTo(undefined, []), true);
  const overlays = new Map([[overlay.toolId, overlay]]);
  const tools = [{ id: 'event-badge' }, { id: 'qr-code' }];
  assert.deepEqual(filterToolIndex(tools, overlays, ['engineering']).map((t) => t.id), ['qr-code']);
  assert.deepEqual(filterToolIndex(tools, overlays, ['marketing']).map((t) => t.id), ['event-badge', 'qr-code']);
});
