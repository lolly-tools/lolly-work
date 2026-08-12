/**
 * The approvals state machine (plans/05 §1–2, plans/03 §5) as pure functions:
 * eligibility, separation of duties, quorum, multi-step advance, reject,
 * withdraw, nomination validation, and the untrusted-input chain parser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction, createApproval, currentStep, eligibleForCurrentStep,
  normalizeChain, validateNominees, withdraw,
  type Chain, type ChainStep,
} from '../server/src/approvals/engine.ts';

const NOW = '2026-07-21T12:00:00Z';

function chain(steps: ChainStep[]): Chain {
  return { id: 'c1', name: 'Test chain', steps, onReject: 'return-to-submitter' };
}
function submit(c: Chain, nominees: string[] = []) {
  return createApproval({
    id: 'apr_1', subjectType: 'asset', subjectRef: 'sess:1', title: 'A deck',
    chain: c, nominees, createdBy: 'submitter', now: NOW,
  });
}

test('eligibility: actor groups must intersect the current step approvers', () => {
  const a = submit(chain([{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }]));
  assert.equal(eligibleForCurrentStep(a, ['brand']), true);
  assert.equal(eligibleForCurrentStep(a, ['legal']), false);
  assert.throws(
    () => applyAction(a, { id: 'x', groups: ['legal'] }, 'approve', undefined, NOW),
    { code: 'NOT_ELIGIBLE' },
  );
});

test('separation of duties: the submitter can never satisfy a step, even when in-group', () => {
  const a = submit(chain([{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }]));
  // submitter IS in 'brand' (eligible) but is still refused, with the specific reason.
  assert.throws(
    () => applyAction(a, { id: 'submitter', groups: ['brand'] }, 'approve', undefined, NOW),
    { code: 'SEPARATION_OF_DUTIES' },
  );
});

test('quorum(2): one distinct approval holds; the same actor cannot count twice; a second clears it', () => {
  const a0 = submit(chain([{ name: 'Legal', approvers: { groups: ['legal'] }, rule: { quorum: 2 } }]));
  const a1 = applyAction(a0, { id: 'l1', groups: ['legal'] }, 'approve', undefined, NOW);
  assert.equal(a1.state, 'in_review');
  assert.equal(a1.stepIndex, 0);
  const a1b = applyAction(a1, { id: 'l1', groups: ['legal'] }, 'approve', undefined, NOW); // duplicate actor
  assert.equal(a1b.state, 'in_review');
  const a2 = applyAction(a1b, { id: 'l2', groups: ['legal'] }, 'approve', undefined, NOW);
  assert.equal(a2.state, 'approved');
});

test('multi-step: clearing step 1 advances to step 2 (fresh eligibility), then to approved', () => {
  const a0 = submit(chain([
    { name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' },
    { name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' },
  ]));
  const a1 = applyAction(a0, { id: 'b1', groups: ['brand'] }, 'approve', undefined, NOW);
  assert.equal(a1.state, 'in_review');
  assert.equal(a1.stepIndex, 1);
  assert.equal(currentStep(a1)?.name, 'Legal');
  assert.deepEqual(a1.nominees, []); // per-step nominations cleared on advance
  // a brand approver is NOT eligible for the legal step
  assert.throws(
    () => applyAction(a1, { id: 'b1', groups: ['brand'] }, 'approve', undefined, NOW),
    { code: 'NOT_ELIGIBLE' },
  );
  const a2 = applyAction(a1, { id: 'g1', groups: ['legal'] }, 'approve', undefined, NOW);
  assert.equal(a2.state, 'approved');
  assert.equal(a2.stepIndex, 2);
});

test("'all' needs each nominee; with no nominees it degrades to quorum(1)", () => {
  const withNoms = createApproval({
    id: 'a', subjectType: 'asset', subjectRef: 's', title: 't',
    chain: chain([{ name: 'Board', approvers: { groups: ['board'] }, rule: 'all' }]),
    nominees: ['n1', 'n2'], createdBy: 'sub', now: NOW,
  });
  const s1 = applyAction(withNoms, { id: 'n1', groups: ['board'] }, 'approve', undefined, NOW);
  assert.equal(s1.state, 'in_review'); // n2 still owed
  const s2 = applyAction(s1, { id: 'n2', groups: ['board'] }, 'approve', undefined, NOW);
  assert.equal(s2.state, 'approved');

  const noNoms = createApproval({
    id: 'b', subjectType: 'asset', subjectRef: 's', title: 't',
    chain: chain([{ name: 'Board', approvers: { groups: ['board'] }, rule: 'all' }]),
    nominees: [], createdBy: 'sub', now: NOW,
  });
  assert.equal(applyAction(noNoms, { id: 'x', groups: ['board'] }, 'approve', undefined, NOW).state, 'approved');
});

test('reject at any step terminates as rejected and records the comment; no further acts', () => {
  const a0 = submit(chain([
    { name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' },
    { name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' },
  ]));
  const a1 = applyAction(a0, { id: 'b1', groups: ['brand'] }, 'reject', 'off brand', NOW);
  assert.equal(a1.state, 'rejected');
  assert.equal(a1.actions.at(-1)?.comment, 'off brand');
  assert.throws(
    () => applyAction(a1, { id: 'b2', groups: ['brand'] }, 'approve', undefined, NOW),
    { code: 'TERMINAL' },
  );
});

test('withdraw: submitter only, and only while not terminal', () => {
  const a0 = submit(chain([{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }]));
  assert.throws(() => withdraw(a0, 'someone-else', NOW), { code: 'NOT_ELIGIBLE' });
  const w = withdraw(a0, 'submitter', NOW);
  assert.equal(w.state, 'withdrawn');
  assert.throws(() => withdraw(w, 'submitter', NOW), { code: 'TERMINAL' });
});

test('validateNominees: only members of the step group are valid nominees', () => {
  const c = chain([{ name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' }]);
  const groups = new Map([['u1', ['legal']], ['u2', ['brand']]]);
  assert.deepEqual(validateNominees(c, 0, ['u1'], groups), { ok: true, ineligible: [] });
  const bad = validateNominees(c, 0, ['u1', 'u2'], groups);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ineligible, ['u2']);
});

test('normalizeChain: parses quorum(n) string form and rejects empty / group-less steps', () => {
  assert.equal(normalizeChain('c', { steps: [] }), null);
  assert.equal(normalizeChain('c', { steps: [{ approvers: { groups: [] }, rule: 'any' }] }), null);
  assert.equal(normalizeChain('c', { steps: [{ approvers: { groups: ['x'] }, rule: 'nope' }] }), null);
  const c = normalizeChain('brand-review', {
    name: 'Brand', steps: [{ name: 'S', approvers: { groups: ['brand'] }, rule: 'quorum(2)' }],
  });
  assert.deepEqual(c?.steps[0]?.rule, { quorum: 2 });
  assert.equal(c?.onReject, 'return-to-submitter');
  assert.equal(c?.name, 'Brand');
});
