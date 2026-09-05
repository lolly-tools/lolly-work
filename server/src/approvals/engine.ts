/**
 * Approvals - the pure state machine (plans/05 §1–2, plans/03 §5).
 *
 * One engine, three-plus subject types (asset / tool-change / config /
 * guest-link). A chain is an ordered list of steps; each step names an eligible
 * team (by group) and a completion rule. No BPM, no DAGs - chains, not graphs.
 *
 * This module knows NOTHING about storage, HTTP, or users beyond the two facts
 * an act needs: the actor's id (for separation of duties) and their groups (for
 * eligibility). Everything here is a pure function over plain data, so the
 * property tests in tests/approvals.test.ts are the whole contract.
 *
 * Invariants enforced here (not merely documented):
 *  - Separation of duties: the submitter can NEVER satisfy a step. Checked
 *    before eligibility so the submitter always gets the specific reason.
 *  - Eligibility: an actor's groups must intersect the current step's
 *    approvers.groups. Nomination is routing + notification, not exclusivity - 
 *    any eligible team member may act; nominees just get pinged.
 *  - No path skips a step: a step completes per its rule, then stepIndex
 *    advances; only past the last step is the whole approval `approved`.
 *  - A reject at any step is terminal (`rejected`). onReject
 *    'return-to-submitter' means the submitter opens a NEW approval - there is
 *    no resume in v1.
 */

export type SubjectType = 'asset' | 'tool-change' | 'config' | 'guest-link' | 'delivery';

export type ApprovalState = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';

/** `any` = one approval; `{ quorum: n }` = n distinct approvers; `all` = see stepClears(). */
export type StepRule = 'any' | { quorum: number } | 'all';

export interface ChainStep {
  name: string;
  approvers: { groups: string[] };
  rule: StepRule;
}

/** A named, versioned chain object (plans/05 §2). Bound to tools/tags by overlay elsewhere. */
export interface Chain {
  id: string;
  name: string;
  version?: number;
  steps: ChainStep[];
  onReject: 'return-to-submitter';
}

export interface ApprovalAction {
  actor: string;
  step: number;
  action: 'approve' | 'reject';
  comment?: string;
  at: string;
}

export interface Approval {
  id: string;
  subjectType: SubjectType;
  subjectRef: string;
  title: string;
  chainId: string;
  /** Snapshot of the chain taken at submit - the approval is judged by the rules it was raised under. */
  chain: Chain;
  state: ApprovalState;
  /** Index of the step under review; equals chain.steps.length once approved. */
  stepIndex: number;
  /** User ids nominated for the CURRENT step (routing + notification only). */
  nominees: string[];
  actions: ApprovalAction[];
  createdBy: string;
  createdAt: string;
}

export type ApprovalErrorCode =
  | 'SEPARATION_OF_DUTIES'
  | 'NOT_ELIGIBLE'
  | 'TERMINAL'
  | 'NO_STEP'
  | 'INVALID_ACTION';

export interface ApprovalError extends Error {
  code: ApprovalErrorCode;
}

/** Throw a typed error the routes can map to an HTTP status. Matches the house
 *  `Object.assign(new Error(), { ... })` pattern (see router.ts readJson). */
function fail(code: ApprovalErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function isTerminal(state: ApprovalState): boolean {
  return state === 'approved' || state === 'rejected' || state === 'withdrawn';
}

export function stepOf(chain: Chain, stepIndex: number): ChainStep | null {
  return chain.steps[stepIndex] ?? null;
}

export function currentStep(approval: Approval): ChainStep | null {
  return stepOf(approval.chain, approval.stepIndex);
}

/** An actor is eligible for a step when their groups intersect the step's approver groups. */
export function isEligible(step: ChainStep, groups: string[]): boolean {
  return step.approvers.groups.some((g) => groups.includes(g));
}

/** True when this approval is open at a step these groups may act on - the inbox predicate. */
export function eligibleForCurrentStep(approval: Approval, groups: string[]): boolean {
  if (approval.state !== 'in_review' && approval.state !== 'submitted') return false;
  const step = currentStep(approval);
  return step ? isEligible(step, groups) : false;
}

/**
 * Does the current step clear given the set of distinct approvers so far?
 *  - `any`         → at least one approval.
 *  - `{ quorum:n }`→ at least n distinct approvers.
 *  - `all`         → DESIGN CHOICE: with nominees named at submit, one approval
 *    from EACH nominee; with no nominees there is no finite roster to complete,
 *    so it degrades to quorum(1). (v1 nomination is per-first-step; deeper steps
 *    carry no nominees and therefore behave as quorum(1) under `all`.)
 */
function stepClears(step: ChainStep, nominees: string[], approvers: Set<string>): boolean {
  const rule = step.rule;
  if (rule === 'any') return approvers.size >= 1;
  if (rule === 'all') {
    if (nominees.length === 0) return approvers.size >= 1;
    return nominees.every((id) => approvers.has(id));
  }
  return approvers.size >= Math.max(1, rule.quorum);
}

/** Validate that every nominee is eligible for `stepIndex`. Returns the ineligible ids (empty = ok). */
export function validateNominees(
  chain: Chain,
  stepIndex: number,
  nominees: string[],
  userGroupsById: Map<string, string[]>,
): { ok: boolean; ineligible: string[] } {
  const step = stepOf(chain, stepIndex);
  if (!step) return { ok: nominees.length === 0, ineligible: [...nominees] };
  const ineligible = nominees.filter((id) => !isEligible(step, userGroupsById.get(id) ?? []));
  return { ok: ineligible.length === 0, ineligible };
}

/** Build a fresh approval at step 0. A stepless chain is vacuously approved (defensive; routes require steps). */
export function createApproval(params: {
  id: string;
  subjectType: SubjectType;
  subjectRef: string;
  title: string;
  chain: Chain;
  nominees: string[];
  createdBy: string;
  now: string;
}): Approval {
  return {
    id: params.id,
    subjectType: params.subjectType,
    subjectRef: params.subjectRef,
    title: params.title,
    chainId: params.chain.id,
    chain: params.chain,
    state: params.chain.steps.length === 0 ? 'approved' : 'in_review',
    stepIndex: 0,
    nominees: [...params.nominees],
    actions: [],
    createdBy: params.createdBy,
    createdAt: params.now,
  };
}

/**
 * Apply an approve/reject and return the NEXT approval state (never mutates the
 * input). Throws a typed ApprovalError on any refusal.
 */
export function applyAction(
  approval: Approval,
  actor: { id: string; groups: string[] },
  action: 'approve' | 'reject',
  comment: string | undefined,
  now: string,
): Approval {
  if (isTerminal(approval.state)) fail('TERMINAL', `this approval is already ${approval.state}`);
  // Separation of duties first, so the submitter never gets a generic "not eligible".
  if (actor.id === approval.createdBy) {
    fail('SEPARATION_OF_DUTIES', 'the submitter cannot approve or reject their own request');
  }
  const step = currentStep(approval);
  if (!step) fail('NO_STEP', 'this approval has no open step to act on');
  if (!isEligible(step, actor.groups)) {
    fail('NOT_ELIGIBLE', 'your groups are not among this step’s approvers');
  }
  if (action !== 'approve' && action !== 'reject') fail('INVALID_ACTION', 'action must be approve or reject');

  const entry: ApprovalAction = {
    actor: actor.id,
    step: approval.stepIndex,
    action,
    ...(comment ? { comment } : {}),
    at: now,
  };
  const actions = [...approval.actions, entry];

  if (action === 'reject') {
    // onReject 'return-to-submitter': v1 has no resume - the submitter raises a new approval.
    return { ...approval, state: 'rejected', actions };
  }

  const approvers = new Set(
    actions.filter((a) => a.step === approval.stepIndex && a.action === 'approve').map((a) => a.actor),
  );
  if (stepClears(step, approval.nominees, approvers)) {
    const nextIndex = approval.stepIndex + 1;
    const done = nextIndex >= approval.chain.steps.length;
    return {
      ...approval,
      state: done ? 'approved' : 'in_review',
      stepIndex: nextIndex,
      // Nominations are per-step and made at submit (step 0); later steps start clean.
      nominees: done ? approval.nominees : [],
      actions,
    };
  }
  // Recorded, step not yet cleared - remains under review at the same step.
  return { ...approval, state: 'in_review', actions };
}

/** Withdraw - submitter only, only while not terminal. */
export function withdraw(approval: Approval, actorId: string, _now: string): Approval {
  if (actorId !== approval.createdBy) fail('NOT_ELIGIBLE', 'only the submitter can withdraw this request');
  if (isTerminal(approval.state)) fail('TERMINAL', `this approval is already ${approval.state}`);
  return { ...approval, state: 'withdrawn' };
}

/** Parse a step rule from loose input (`"any"`, `"all"`, `"quorum(2)"`, or `{ quorum: 2 }`). */
export function parseRule(rule: unknown): StepRule | null {
  if (rule === 'any' || rule === 'all') return rule;
  if (typeof rule === 'string') {
    const m = /^quorum\((\d+)\)$/.exec(rule);
    if (m) return { quorum: Math.max(1, Number(m[1])) };
  }
  if (rule && typeof rule === 'object' && 'quorum' in rule) {
    const q = Number((rule as { quorum: unknown }).quorum);
    if (Number.isFinite(q) && q >= 1) return { quorum: Math.floor(q) };
  }
  return null;
}

/** Coerce untrusted JSON into a valid Chain, or null. The id comes from the route, never the body. */
export function normalizeChain(id: string, spec: unknown): Chain | null {
  if (!spec || typeof spec !== 'object') return null;
  const s = spec as { name?: unknown; version?: unknown; steps?: unknown };
  if (!Array.isArray(s.steps) || s.steps.length === 0) return null;
  const steps: ChainStep[] = [];
  for (const raw of s.steps) {
    if (!raw || typeof raw !== 'object') return null;
    const st = raw as { name?: unknown; approvers?: unknown; rule?: unknown };
    const ap = st.approvers && typeof st.approvers === 'object' ? (st.approvers as { groups?: unknown }) : null;
    const groups = Array.isArray(ap?.groups) ? ap.groups.filter((g): g is string => typeof g === 'string') : [];
    if (groups.length === 0) return null;
    const rule = parseRule(st.rule);
    if (!rule) return null;
    const name = typeof st.name === 'string' && st.name.trim() ? st.name.slice(0, 100) : `Step ${steps.length + 1}`;
    steps.push({ name, approvers: { groups }, rule });
  }
  return {
    id,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 100) : id,
    ...(typeof s.version === 'number' ? { version: s.version } : {}),
    steps,
    onReject: 'return-to-submitter',
  };
}
