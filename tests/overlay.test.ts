import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkParams, filterInputs, filterToolIndex, inputIsGoverned, lockedValues, normalizeOverlay, resolveInputAccess,
  toolVisibleTo, type ToolOverlay,
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

// ── explainable locks (C7) ──────────────────────────────────────────────────
// The overlay above is deliberately UNNAMED, and every test before this point
// is the regression proof that an unnamed overlay resolves exactly as it always
// did. These name one and check the attribution rides the same resolution that
// did the locking, so the two can never disagree.

const named: ToolOverlay = {
  toolId: 'event-badge',
  version: 1,
  name: 'Brand guardrails',
  inputAccess: {
    logo: [{ groups: ['*'], level: 'locked', value: 'acme/logo/primary', reason: 'One mark per campaign' }],
    accent: [{ groups: ['*'], level: 'choice', allow: ['#0c322c'] }],
    discount: [{ groups: ['*'], level: 'hidden' }],
  },
};

test('a named overlay attributes every matched rule; an unnamed one attributes nothing', () => {
  const logo = resolveInputAccess(named, 'logo', ['marketing']);
  assert.equal(logo.by, 'Brand guardrails');
  assert.equal(logo.reason, 'One mark per campaign');
  // A rule with no reason of its own still says who: `by` is the overlay's.
  const accent = resolveInputAccess(named, 'accent', ['marketing']);
  assert.equal(accent.by, 'Brand guardrails');
  assert.equal(accent.reason, undefined);
  // No rule matched at all - nothing to attribute, and the editable fallback is
  // untouched.
  assert.deepEqual(resolveInputAccess(named, 'headline', ['marketing']), { level: 'editable' });
  // The unnamed overlay carries neither key, so every existing surface renders
  // exactly as before.
  const before = resolveInputAccess(overlay, 'logo', ['marketing']);
  assert.equal('by' in before, false);
  assert.equal('reason' in before, false);
});

test('filterInputs ships the attribution to the shell alongside the access level', () => {
  const filtered = filterInputs([{ id: 'logo' }, { id: 'discount' }], named, ['marketing']);
  assert.deepEqual(filtered.map((i) => i.id), ['logo'], 'hidden stays absent');
  assert.equal(filtered[0]?.access?.by, 'Brand guardrails');
  assert.equal(filtered[0]?.access?.reason, 'One mark per campaign');
});

test('a violation names the overlay that refused it (the 422 body)', () => {
  const violations = checkParams({ logo: 'evil', accent: '#ff0000', discount: '90' }, named, ['marketing']);
  assert.deepEqual(
    violations.map((v) => `${v.param}:${v.code}:${v.by}`).sort(),
    ['accent:INPUT_NOT_ALLOWED:Brand guardrails', 'discount:INPUT_HIDDEN:Brand guardrails', 'logo:INPUT_LOCKED:Brand guardrails'],
  );
  assert.equal(violations.find((v) => v.param === 'logo')?.reason, 'One mark per campaign');
  // An unnamed overlay produces exactly the violation shape it always did.
  assert.deepEqual(checkParams({ logo: 'evil' }, overlay, ['marketing']), [{ param: 'logo', code: 'INPUT_LOCKED' }]);
});

test('normalizeOverlay trims, caps and drops blank attribution', () => {
  const norm = normalizeOverlay('t', {
    name: '  Brand guardrails  ',
    inputAccess: {
      a: [{ groups: ['*'], level: 'locked', reason: '  Legal signs off copy  ' }],
      b: [{ groups: ['*'], level: 'locked', reason: '   ' }],
      c: [{ groups: ['*'], level: 'locked' }],
    },
  });
  assert.equal(norm?.name, 'Brand guardrails');
  assert.equal(norm?.inputAccess?.a?.[0]?.reason, 'Legal signs off copy');
  assert.equal('reason' in (norm?.inputAccess?.b?.[0] ?? {}), false, 'whitespace-only reason is absent, not empty');
  assert.equal('reason' in (norm?.inputAccess?.c?.[0] ?? {}), false);
  // Blank / non-string names leave the overlay unnamed rather than storing junk.
  assert.equal(normalizeOverlay('t', { name: '   ' })?.name, undefined);
  assert.equal(normalizeOverlay('t', { name: 42 })?.name, undefined);
  // Free text bound for a sidebar is length-capped here, not trusted because the
  // author holds policy.edit.
  assert.equal(normalizeOverlay('t', { name: 'x'.repeat(500) })?.name?.length, 80);
  const long = normalizeOverlay('t', { inputAccess: { a: [{ groups: ['*'], level: 'locked', reason: 'y'.repeat(500) }] } });
  assert.equal(long?.inputAccess?.a?.[0]?.reason?.length, 200);
});
