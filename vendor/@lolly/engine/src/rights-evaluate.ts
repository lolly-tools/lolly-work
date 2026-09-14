// SPDX-License-Identifier: MPL-2.0
/** Applies the reviewed licence profiles to recorded works, uses and one delivery context (plan 253). */
import type {
  AttributionChannelV1,
  AttributionNoticeV1,
  AttributionPlanV1,
  CreativeClassificationV1,
  CreativeOperationV1,
  CreativePartyV1,
  CreativeUseResultV1,
  CreativeUseRoleV1,
  CreativeUseV1,
  CreativeWorkRecordV1,
  RightsDecisionV1,
  RightsEvaluationV1,
  RightsEvidenceV1,
  RightsIssueCodeV1,
  RightsIssueV1,
  RightsStatusV1,
  UseContextV1,
} from '@lolly-tools/core/rights-v1';
import type { SourceDetailV1 } from './rights-attribution.ts';
import type { LicenceProfileV1, NormalisedLicenceV1 } from './rights-profiles.ts';
import { RIGHTS_RULES_VERSION, licenceDisplayName, licenceProfile, publicLocator, readLicenceExpression, roleObligation } from './rights-profiles.ts';

export interface RightsEvaluationInputV1 {
  works: readonly CreativeWorkRecordV1[];
  uses: readonly CreativeUseV1[];
  context: UseContextV1;
  decisions?: readonly RightsDecisionV1[];
  /**
   * Per-work facts a portable work record has no field for: the attribution
   * sentence the licensor asked for verbatim, and the changes in the words the
   * producer of the census recorded. Both shape the credit, so both go into the
   * fingerprint. A producer that supplies none still gets a usable plan.
   */
  details?: Readonly<Record<string, SourceDetailV1>>;
  /**
   * Further reviewed profiles, for a versioned profile pack or a test's
   * synthetic licence. An extra shadows a built-in profile of the same id, and
   * every extra id and profile version goes into the fingerprint, so an
   * evaluation made under a swapped rule set is never mistaken for one made
   * under the shipped rules.
   */
  extraProfiles?: readonly LicenceProfileV1[];
}

/**
 * Operations that change the work itself. Facts from the renderer, not a legal
 * classification.
 *
 * `synchronised` is here on the licence's own words rather than on a judgement
 * about how much changed: CC BY 4.0 section 1(a) says that where the licensed
 * material is a musical work, performance or sound recording, "Adapted Material
 * is always produced where the Licensed Material is synched in timed relation
 * with a moving image". So an audiogram, a slide over music and a video tool
 * must not read an unedited track under a moving picture as plain inclusion.
 */
const ADAPTING: ReadonlySet<CreativeOperationV1> = new Set<CreativeOperationV1>([
  'cropped',
  'recoloured',
  'outlined',
  'retouched',
  'mixed',
  'synchronised',
]);

/** Operations that place or convert a work without changing it. */
const PLACING: ReadonlySet<CreativeOperationV1> = new Set<CreativeOperationV1>(['placed', 'resized', 'moved', 'converted']);

/** Placing a work is not a change to it; every other operation is reported in the credit. */
const NOT_A_CHANGE: ReadonlySet<CreativeOperationV1> = new Set<CreativeOperationV1>(['placed']);

/** How cautious a classification is. A caller may raise one, never lower it. */
const CAUTION: Record<CreativeClassificationV1, number> = {
  unchanged: 0,
  'technical-conversion': 1,
  'collection-component': 2,
  undetermined: 3,
  adaptation: 4,
};

const ISSUE_NEEDS_PERSON: ReadonlySet<RightsIssueCodeV1> = new Set<RightsIssueCodeV1>([
  'licence.adaptation-choice',
  'attribution.delivery-missing',
  'licence.grant-conflict',
  'source.redistribution-unknown',
]);

const ISSUE_IS_A_GAP: ReadonlySet<RightsIssueCodeV1> = new Set<RightsIssueCodeV1>([
  'licence.unknown',
  'attribution.source-missing',
]);

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface ClassifiedUse {
  classification: CreativeClassificationV1;
  rule: string;
}

/**
 * The classification rules, in the order they are tried. Each names itself in
 * the result so a person can see which rule produced it, and a caller's own
 * classification is kept when it is more cautious than the rule's.
 */
function classify(use: CreativeUseV1): ClassifiedUse {
  const operations = [...use.operations].sort(byString);
  const computed = classifyOperations(use.role, operations);
  const supplied = use.classification;
  if (supplied && CAUTION[supplied] > CAUTION[computed.classification]) {
    return { classification: supplied, rule: 'caller-classification-kept-v1' };
  }
  return computed;
}

function classifyOperations(role: CreativeUseRoleV1, operations: readonly CreativeOperationV1[]): ClassifiedUse {
  // A transformation input, a LUT for example, shapes the output without being
  // changed itself, so the transformation work is not adapted by its own use.
  if (role === 'transformation') return { classification: 'unchanged', rule: 'transformation-input-v1' };
  if (operations.some((op) => ADAPTING.has(op))) return { classification: 'adaptation', rule: 'adaptation-operations-v1' };
  if (operations.length === 1 && operations[0] === 'converted') {
    return { classification: 'technical-conversion', rule: 'technical-conversion-v1' };
  }
  if (role === 'incorporated' && operations.length > 0 && operations.every((op) => PLACING.has(op))) {
    // An unchanged work placed in a larger composition, which the CC FAQ on
    // collections treats as a collection rather than adapted material.
    //
    // The limit of this rule, stated because it is the direction that clears a
    // ShareAlike duty: it holds for a work reproduced whole, unchanged and still
    // separable inside the composition. A caller that composites a work INTO a
    // new single work knows something these operations do not say, and should
    // pass `classification: 'undetermined'` or `'adaptation'` on the use, which
    // the caution ordering keeps (a caller may raise a classification, never
    // lower one). tests/fixtures/rights/README.md records the same limit beside
    // the citation it rests on.
    return { classification: 'collection-component', rule: 'collection-component-v1' };
  }
  if (role !== 'incorporated' && operations.every((op) => PLACING.has(op))) {
    // A font rendering text, a referenced work, a redistributed source file:
    // used as supplied, with nothing changed.
    return { classification: 'unchanged', rule: 'unchanged-use-v1' };
  }
  return { classification: 'undetermined', rule: 'unclassified-v1' };
}

/** The changes a credit should declare, from the operations the renderer recorded. */
function changeWords(use: CreativeUseV1): string[] {
  return [...new Set(use.operations.filter((op) => !NOT_A_CHANGE.has(op)))].sort(byString);
}

/**
 * The changes one credit declares. A producer that recorded what it actually did
 * to the bytes (the emoji pass records its SVG normalisation and its recolouring)
 * wins over the operation words, because the credential records that same list:
 * a file whose credit says `unchanged` while its own credential names two
 * modifications is two answers to one question (plan 253 section 8.3).
 */
function changesFor(use: CreativeUseV1, detail: SourceDetailV1 | undefined): string[] {
  const recorded = (detail?.modifications ?? []).map((text) => text.trim()).filter(Boolean);
  return recorded.length ? [...new Set(recorded)] : changeWords(use);
}

interface WorkLicence {
  normalised: NormalisedLicenceV1 | null;
  profile: LicenceProfileV1 | null;
  evidence: RightsEvidenceV1 | null;
  /** One entry per evidence record, so two records that agree are not a conflict. */
  declarations: string[];
  /** An `OR` expression offered a choice and nothing selected one. */
  unselectedChoice: boolean;
  /** An `AND` expression states cumulative terms, which these rules do not read together. */
  cumulative: string[];
  /** True when a recorded grant or a selected grant actually picked one of the declarations. */
  resolved: boolean;
}

/**
 * The licence governing one use. A selected grant wins wherever it is recorded;
 * with nothing selected the first evidence record's first identifier is read,
 * and a second record that names a different identifier is reported as a
 * conflict rather than silently resolved.
 *
 * Two records are deliberately NOT read as a declaration. A record whose status
 * is `not-applicable` was ruled out, and a record whose status is `missing` says
 * only that the field was looked for and nothing was there (see
 * `RightsEvidenceStatusV1`). Reading an inspected-and-empty record as a grant
 * would drop the real one beside it and invent a disagreement out of a blank.
 *
 * An `AND` expression is recorded and not interpreted. The terms are cumulative
 * (plan 253 section 3.2), so reading only the first would silently drop the
 * other's conditions, and merging two profiles into one synthetic licence is
 * what the same section tells us not to build. The caller reports it as an
 * unknown licence with its own named rule.
 */
function workLicence(work: CreativeWorkRecordV1, use: CreativeUseV1, extra: readonly LicenceProfileV1[]): WorkLicence {
  const records = work.rights.filter((ev) => ev.status !== 'not-applicable' && ev.status !== 'missing'
    && Boolean((ev.expression ?? ev.declaration).trim()));
  const selected = use.selectedGrant ?? work.grants?.find((grant) => grant.kind === 'public-licence')?.licence ?? null;
  const declarations = new Set<string>();
  const cumulative = new Set<string>();
  let unselectedChoice = false;
  let first: { normalised: NormalisedLicenceV1; evidence: RightsEvidenceV1 } | null = null;
  let chosen: { normalised: NormalisedLicenceV1; evidence: RightsEvidenceV1 } | null = null;
  for (const evidence of records) {
    const expression = readLicenceExpression(evidence.expression ?? evidence.declaration, extra);
    const terms = expression.terms;
    const written = terms.map((term) => term.id ?? term.original).join(` ${expression.operator} `);
    declarations.add(written);
    if (expression.operator === 'and' && terms.length > 1) {
      cumulative.add(written);
      continue;
    }
    const match = selected ? terms.find((term) => term.id === selected) : undefined;
    if (match && !chosen) chosen = { normalised: match, evidence };
    if (expression.operator === 'or' && !match) unselectedChoice = true;
    if (!first && terms[0]) first = { normalised: terms[0], evidence };
  }
  const picked = cumulative.size ? null : chosen ?? first;
  return {
    normalised: picked?.normalised ?? null,
    profile: licenceProfile(picked?.normalised.id ?? null, extra),
    evidence: picked?.evidence ?? null,
    declarations: [...declarations].sort(byString),
    unselectedChoice: unselectedChoice && !chosen,
    cumulative: [...cumulative].sort(byString),
    resolved: Boolean(chosen),
  };
}

const partyNames = (parties: readonly CreativePartyV1[], role?: string): string =>
  parties.filter((party) => (role ? party.role === role : party.role !== 'publisher')).map((party) => party.name).join(', ');

/** The credit parts a courtesy line carries when the licence asks for nothing. */
const COURTESY_PARTS = { creator: true, title: true, copyrightNotice: false, licenceNameAndLink: true, sourceLink: true, modificationIndication: false };

interface CreditInput {
  work: CreativeWorkRecordV1;
  licence: WorkLicence;
  changes: string[];
  /** The attribution sentence the licensor asked for, when the source supplied one. */
  requested?: string;
  parts: { creator: boolean; title: boolean; copyrightNotice: boolean; licenceNameAndLink: boolean; sourceLink: boolean; modificationIndication: boolean };
}

/**
 * A change the credit states. The words come from the producer of the census,
 * which often writes whole sentences, so one trailing full stop is trimmed off
 * each before they are joined: the line adds its own and a reader should not be
 * handed `styles., ids..`.
 */
const changeText = (change: string): string => change.trim().replace(/\.$/, '');

/**
 * One credit line: the work, who made it, the publisher or set it came from,
 * the licence and its link, where the exact bytes came from, and what changed.
 * A part the source did not supply is left out rather than guessed at, and a
 * locator that is not an ordinary public address is left out rather than
 * printed (see {@link publicLocator}).
 *
 * When the source supplied an attribution sentence of its own, that sentence
 * identifies the creator instead of a name this code assembled. CC BY 4.0 and
 * CC BY-SA 4.0 section 3(a)(1)(A)(i) ask for the creator identification, and
 * section 3(a)(1) qualifies the whole condition as "in any reasonable manner
 * requested by the Licensor", so a pack that asks to be credited in particular
 * words gets those words. The title stays in front of it either way, because a
 * title the source supplied is provenance worth keeping even where the licence
 * treats it as optional. When the requested sentence already names the licence,
 * the licence part adds the link rather than the name a second time.
 */
function creditLine({ work, licence, changes, requested, parts }: CreditInput): string {
  const pieces: string[] = [];
  const creators = partyNames(work.creators);
  const publisher = partyNames(work.creators, 'publisher');
  const asked = parts.creator ? (requested ?? '').trim().replace(/\.$/, '') : '';
  const titled = Boolean(parts.title && work.title);
  if (asked) {
    if (titled) pieces.push(`"${work.title}"`);
    pieces.push(asked);
  } else {
    const head: string[] = [];
    if (titled) head.push(`"${work.title}"`);
    if (parts.creator && creators) head.push(titled ? `by ${creators}` : creators);
    if (publisher) head.push(`(${publisher})`);
    if (head.length) pieces.push(head.join(' '));
  }
  if (parts.copyrightNotice && licence.evidence?.copyright) pieces.push(licence.evidence.copyright);
  if (parts.licenceNameAndLink && licence.normalised) {
    const name = licence.profile?.name ?? (licence.normalised.id ? licenceDisplayName(licence.normalised.id) : licence.normalised.original);
    const url = publicLocator(licence.normalised.url ?? licence.evidence?.url);
    const named = Boolean(asked) && asked.toLowerCase().includes(name.toLowerCase());
    if (!named || !url) pieces.push(url ? `${name} ${url}` : name);
    else pieces.push(url);
  }
  const source = publicLocator(work.sourceUrl);
  if (parts.sourceLink && source) pieces.push(`source ${source}`);
  if (parts.modificationIndication) pieces.push(changes.length ? `changes: ${changes.map(changeText).join(', ')}` : 'unchanged');
  return pieces.length ? `${pieces.join(', ')}.` : '';
}

function noticeFor(work: CreativeWorkRecordV1, licence: WorkLicence, changes: string[], required: boolean, parts: CreditInput['parts'], detail?: SourceDetailV1): AttributionNoticeV1 {
  const notice: AttributionNoticeV1 = {
    work: work.id,
    required,
    credit: creditLine({ work, licence, changes, parts, ...(detail?.attribution ? { requested: detail.attribution } : {}) }),
  };
  if (licence.normalised?.id) notice.licence = licence.normalised.id;
  const url = publicLocator(licence.normalised?.url ?? licence.evidence?.url);
  if (url) notice.licenceUrl = url;
  const source = publicLocator(work.sourceUrl);
  if (source) notice.sourceUrl = source;
  // Exactly the words that were recorded, so this field and the credential's own
  // `modifications` list are the same facts. Only the prose credit trims the
  // sentence stops, because it joins them into a line.
  notice.changes = changes.length ? changes.join(', ') : 'unchanged';
  const notices = licence.evidence?.notices?.filter((text) => text.trim().length > 0) ?? [];
  // A licence that asks for a notice, and one that asks only that a notice the
  // licensor supplied be retained (the CC BY warranty-disclaimer notice), both
  // carry what was recorded. The difference is what happens when nothing was
  // recorded, and that is decided by the caller, not here.
  if (notices.length && (licence.profile?.noticeRequired || licence.profile?.retainSuppliedNotices)) notice.noticeText = notices.join('\n\n');
  return notice;
}

function deliveryChannels(context: UseContextV1): AttributionChannelV1[] {
  const channels: AttributionChannelV1[] = [];
  const { route, canCarryCredential, canCarryReadableCredit } = context.delivery;
  if (canCarryCredential && (route === 'file-with-c2pa' || route === 'package')) channels.push('c2pa-ingredients');
  if (canCarryReadableCredit) {
    if (route === 'package') channels.push('readable-companion');
    else if (route === 'clipboard' || route === 'connector') channels.push('caption');
    else channels.push('readable-details');
  }
  return channels;
}

function limitMatches(limit: LicenceProfileV1['limits'][number], context: UseContextV1, use: CreativeUseV1, classification: CreativeClassificationV1): boolean {
  if (limit.commercial && context.commercial !== true) return false;
  if (limit.audiences && !limit.audiences.includes(context.audience)) return false;
  if (limit.classifications && !limit.classifications.includes(classification)) return false;
  if (limit.roles && !limit.roles.includes(use.role)) return false;
  return true;
}

/**
 * A decision applies only to the situation it was made about. Every decision
 * carries the fingerprint of the facts in front of the person at the time, so a
 * choice restored from a session record, a backup or a shared document is
 * checked against the facts NOW: a changed set, treatment, format or audience
 * moves the situation and the old choice stops answering for it. A decision with
 * no fingerprint at all is accepted, because that is a caller stating a choice
 * directly rather than replaying a stored one.
 */
function decisionFor(decisions: readonly RightsDecisionV1[], work: string, kind: RightsDecisionV1['kind'], situation: string): RightsDecisionV1 | undefined {
  return decisions.find((decision) => decision.work === work && decision.kind === kind
    && (!decision.fingerprint || decision.fingerprint === situation));
}

/**
 * Evaluate what a set of recorded works, their uses and one delivery context
 * ask of the person delivering the output. Deterministic: works are sorted by
 * id and uses by work, role and operations, no clock is read (the context
 * carries the date when a caller wants one recorded) and the same inputs in a
 * different order produce the same fingerprint.
 */
export function evaluateCreativeUses(input: RightsEvaluationInputV1): RightsEvaluationV1 {
  const extra = input.extraProfiles ?? [];
  // Every sort key below ends in the canonical JSON of the record itself, so two
  // entries that agree on the named fields still have one total order and the
  // same facts in a different order cannot produce a different answer.
  const decisions = [...(input.decisions ?? [])].sort((a, b) =>
    byString(a.work, b.work) || byString(a.kind, b.kind) || byString(canonicalJson(a), canonicalJson(b)));
  const works = [...input.works].sort((a, b) => byString(a.id, b.id) || byString(canonicalJson(a), canonicalJson(b)));
  const details = input.details ?? {};
  const detailFor = (id: string): SourceDetailV1 | undefined => (Object.hasOwn(details, id) ? details[id] : undefined);
  const byId = new Map<string, CreativeWorkRecordV1>();
  const duplicated = new Set<string>();
  for (const work of works) {
    if (byId.has(work.id)) duplicated.add(work.id);
    else byId.set(work.id, work);
  }
  const uses = [...input.uses].sort((a, b) =>
    byString(a.work, b.work) || byString(a.role, b.role) || byString([...a.operations].sort(byString).join(','), [...b.operations].sort(byString).join(',')) || byString(canonicalJson(a), canonicalJson(b)));

  const results: CreativeUseResultV1[] = [];
  const issues: RightsIssueV1[] = [];
  const required: AttributionNoticeV1[] = [];
  const optional: AttributionNoticeV1[] = [];
  const unresolved: string[] = [];
  const profileVersions: Record<string, string> = {};
  const allChanges = new Set<string>();
  const situation = situationOf(works, uses, input.context, details, extra);
  for (const id of [...duplicated].sort(byString)) {
    // Identical bytes do not imply identical grants (plan 253 section 5.2), so
    // two records under one id are never merged. The first in the sorted order
    // is the one read, and the collision is named rather than settled here.
    issues.push({
      code: 'licence.grant-conflict',
      work: id,
      summary: 'Two records share one work id, so it is not clear which one describes this work.',
      remedies: [{ kind: 'add-information', label: 'Give each work its own id and record which grant applies' }],
      rule: 'duplicate-work-id-v1',
    });
    unresolved.push(`${id}: two records share this work id`);
  }
  for (const decision of decisions) {
    if (decision.fingerprint && decision.fingerprint !== situation) {
      unresolved.push(`${decision.work}: an earlier ${decision.kind} choice was made about different facts`);
    }
  }

  uses.forEach((use, index) => {
    const work = byId.get(use.work);
    const codes: RightsIssueCodeV1[] = [];
    const add = (issue: RightsIssueV1): void => {
      issues.push(issue);
      codes.push(issue.code);
    };
    if (!work) {
      add({
        code: 'licence.unknown',
        work: use.work,
        summary: 'This use names a work with no record, so nothing about it is known.',
        remedies: [{ kind: 'add-information', label: 'Add the work and its licence' }],
        rule: 'work-record-missing-v1',
      });
      unresolved.push(`${use.work}: no work record`);
      results.push({ work: use.work, use: index, classification: 'undetermined', rule: 'unclassified-v1', licence: null, reviewed: false, issues: codes });
      return;
    }

    const { classification, rule } = classify(use);
    const licence = workLicence(work, use, extra);
    const detail = detailFor(work.id);
    const profile = licence.profile;
    if (profile) profileVersions[profile.id] = profile.profileVersion;
    const changes = changesFor(use, detail);
    for (const change of changes) allChanges.add(change);

    // A grant that actually picked one of the declarations settles the question,
    // whether it was named on the use or recorded on the work itself. Reading
    // only the use here would give the same facts two answers.
    if (licence.declarations.length > 1 && !licence.resolved) {
      add({
        code: 'licence.grant-conflict',
        work: work.id,
        summary: `Two licence declarations disagree: ${licence.declarations.join(' and ')}.`,
        remedies: [{ kind: 'add-information', label: 'Choose which grant applies and record why' }],
        rule: 'grant-conflict-v1',
      });
    }

    // Four honest ways for a licence to be unknown: nothing was recorded, the
    // terms are cumulative and these rules do not read them together, the
    // identifier is recognised and its conditions are not yet interpreted, or
    // the identifier points at a definition these rules do not carry. None of
    // them is an automatic pass and none is an automatic ban.
    const recognised = licence.normalised?.id ?? null;
    if (licence.cumulative.length) {
      add({
        code: 'licence.unknown',
        work: work.id,
        summary: `This source states cumulative terms, which are recorded and not yet interpreted together: ${licence.cumulative.join('; ')}.`,
        remedies: [{ kind: 'add-information', label: 'Record which grant you are using and why' }],
        rule: 'licence-expression-cumulative-v1',
      });
      unresolved.push(`${work.id}: cumulative terms recorded, not yet interpreted`);
    } else if (!profile?.reviewed) {
      const conditions = profile?.conditions ?? [];
      add({
        code: 'licence.unknown',
        work: work.id,
        summary: !recognised
          ? 'Source licence not recorded.'
          : conditions.length
            ? `Conditions recorded, not yet interpreted: ${conditions.join(', ')}.`
            : `This licence is recorded and not yet interpreted: ${recognised}.`,
        remedies: [{ kind: 'add-information', label: 'Record the licence for this source' }],
        rule: !recognised ? 'licence-unparsed-v1' : conditions.length ? 'licence-recognised-not-reviewed-v1' : 'licence-not-in-rules-v1',
      });
      unresolved.push(!recognised
        ? `${work.id}: licence not recorded`
        : conditions.length
          ? `${work.id}: ${recognised} conditions recorded, not yet interpreted`
          : `${work.id}: ${recognised} recorded, not yet interpreted`);
    } else if (licence.unselectedChoice) {
      add({
        code: 'licence.unknown',
        work: work.id,
        summary: 'This source offers a choice of licence and none is selected.',
        remedies: [{ kind: 'add-information', label: 'Select which grant you are using' }],
        rule: 'licence-choice-unselected-v1',
      });
      unresolved.push(`${work.id}: a choice of grant is unselected`);
    }

    let obligation: 'none' | 'attribution' | 'notice' = 'none';
    if (profile?.reviewed) {
      obligation = roleObligation(profile, use.role);
      for (const limit of profile.limits) {
        if (!limitMatches(limit, input.context, use, classification)) continue;
        add({
          code: 'licence.use-not-covered',
          work: work.id,
          summary: limit.summary,
          remedies: [
            { kind: 'replace-work', label: 'Use a different work' },
            { kind: 'separate-permission', label: 'Record separate permission' },
          ],
          rule: `limit:${profile.id}`,
        });
      }
    }

    // Outside the reviewed guard on purpose. Passing on the source bytes is
    // exactly the case where an unrecorded or not-yet-interpreted licence needs
    // saying out loud, and a profile that was never reviewed records
    // `redistributeSource: 'unknown'`, which is not permission.
    if (use.role === 'source-distribution' && profile?.redistributeSource !== 'permitted-with-notices') {
      add({
        code: 'source.redistribution-unknown',
        work: work.id,
        summary: 'Permission to pass on the source file itself is not recorded.',
        remedies: [
          { kind: 'separate-permission', label: 'Record separate permission' },
          { kind: 'replace-work', label: 'Leave this source out' },
        ],
        rule: 'redistribute-source-v1',
      });
    }

    if (obligation !== 'none' && profile) {
      const creators = partyNames(work.creators);
      const licenceUrl = publicLocator(licence.normalised?.url ?? licence.evidence?.url);
      if (!creators || !licenceUrl) {
        add({
          code: 'attribution.source-missing',
          work: work.id,
          summary: 'This work needs a credit and part of it is not recorded.',
          remedies: [{ kind: 'add-information', label: 'Add the creator and the licence link' }],
          rule: 'credit-fields-missing-v1',
        });
        unresolved.push(`${work.id}: ${creators ? 'licence link' : 'creator'} not recorded`);
      }
      const notice = noticeFor(work, licence, changes, true, profile.attribution, detail);
      // A licence that asks for a notice text and a work that carries none is a
      // gap, not a delivery. Apache 2.0 section 4(4) asks for the NOTICE file's
      // attribution text to travel with the distributed derivative work, and the
      // MIT condition asks for the copyright line AND the permission notice; with
      // neither recorded there is nothing to put in the file, so nothing may read
      // as ready.
      if (profile.noticeRequired && !notice.noticeText) {
        add({
          code: 'attribution.source-missing',
          work: work.id,
          summary: 'This licence asks for a notice text to travel with the work and none is recorded.',
          remedies: [{ kind: 'add-information', label: 'Add the notice text this licence asks to keep' }],
          rule: 'notice-text-missing-v1',
        });
        unresolved.push(`${work.id}: notice text not recorded`);
      }
      required.push(notice);
    } else if (profile?.courtesyCredit) {
      optional.push(noticeFor(work, licence, changes, false, COURTESY_PARTS, detail));
    }

    if (profile?.reviewed && profile.shareAlike && classification === 'adaptation' && input.context.audience !== 'private') {
      const decision = decisionFor(decisions, work.id, 'output-licence', situation);
      const permission = decisionFor(decisions, work.id, 'separate-permission', situation);
      const compatible = decision?.licence && profile.compatibleOutputLicences.some((entry) => entry.id === decision.licence);
      if (!compatible && !permission) {
        add({
          code: 'licence.adaptation-choice',
          work: work.id,
          summary: 'If you share this adaptation, it needs a compatible licence.',
          remedies: [
            ...profile.compatibleOutputLicences.map((entry) => ({ kind: 'output-licence' as const, label: `Share the adaptation under ${entry.name}`, licence: entry.id })),
            { kind: 'keep-original', label: 'Keep the original, unchanged' },
            { kind: 'replace-work', label: 'Use a different work' },
            { kind: 'separate-permission', label: 'Record separate permission' },
          ],
          rule: 'sharealike-adaptation-v1',
        });
      }
    }

    if (classification === 'undetermined') unresolved.push(`${work.id}: the rules do not classify this use`);

    results.push({
      work: work.id,
      use: index,
      classification,
      rule,
      licence: licence.normalised?.id ?? null,
      reviewed: Boolean(profile?.reviewed),
      issues: codes,
    });
  });

  const channels = deliveryChannels(input.context);
  if (required.length && !input.context.delivery.canCarryCredential && !input.context.delivery.canCarryReadableCredit) {
    issues.push({
      code: 'attribution.delivery-missing',
      summary: 'Add this credit where the work is posted; this route carries no credit of its own.',
      remedies: [
        { kind: 'copy-credit', label: 'Copy the credit' },
        { kind: 'package-delivery', label: 'Deliver a package with the credits beside the file' },
      ],
      rule: 'delivery-route-v1',
    });
  }

  const humanActions = issues.filter((issue) => ISSUE_NEEDS_PERSON.has(issue.code));
  const plan: AttributionPlanV1 = {
    required,
    optional,
    changes: [...allChanges].sort(byString),
    channels,
    humanActions,
    unresolved: [...new Set(unresolved)].sort(byString),
    rulesVersion: RIGHTS_RULES_VERSION,
    profileVersions,
  };

  return {
    status: statusFor(issues),
    uses: results,
    plan,
    issues,
    fingerprint: fingerprintOf(situation, decisions),
    situation,
    rulesVersion: RIGHTS_RULES_VERSION,
  };
}

/**
 * `delivery-failed` never comes from here: it describes a promise a delivery
 * did not keep, which only the receipt can measure after the bytes are written.
 */
function statusFor(issues: readonly RightsIssueV1[]): RightsStatusV1 {
  if (issues.some((issue) => issue.code === 'licence.use-not-covered')) return 'use-not-covered';
  if (issues.some((issue) => ISSUE_NEEDS_PERSON.has(issue.code))) return 'actions-required';
  if (issues.some((issue) => ISSUE_IS_A_GAP.has(issue.code))) return 'unknown';
  return 'ready';
}

/** JSON with object keys in sorted order, so the same facts always serialise the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => byString(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The FACTS an evaluation is about, with the decisions left out: the works and
 * their recorded rights, the uses, the per-work details, the context, any extra
 * profiles and the rules version. `evaluatedAt` is left out on purpose, because
 * a date the caller supplied is not part of what the rules read.
 *
 * This is the value a recorded decision is stamped with and checked against
 * (plan 253 section 4.2). It has to leave the decisions out for the check to be
 * possible at all: a hash that included them could never equal the one a person
 * held before making the choice.
 */
function situationOf(
  works: readonly CreativeWorkRecordV1[],
  uses: readonly CreativeUseV1[],
  context: UseContextV1,
  details: Readonly<Record<string, SourceDetailV1>>,
  extra: readonly LicenceProfileV1[],
): string {
  const payload = canonicalJson({
    context: {
      operation: context.operation,
      delivery: context.delivery,
      audience: context.audience,
      commercial: context.commercial ?? null,
      outputLicence: context.outputLicence ?? null,
    },
    details: Object.keys(details).sort(byString).map((id) => ({
      id,
      attribution: details[id]?.attribution ?? null,
      modifications: details[id]?.modifications ?? null,
    })),
    profiles: extra.map((profile) => ({ id: profile.id, version: profile.profileVersion })).sort((a, b) => byString(a.id, b.id)),
    rules: RIGHTS_RULES_VERSION,
    uses: uses.map((use) => ({
      work: use.work,
      role: use.role,
      operations: [...use.operations].sort(byString),
      pin: use.pin ?? null,
      scope: use.scope?.count ?? null,
      selectedGrant: use.selectedGrant ?? null,
      classification: use.classification ?? null,
    })),
    works: works.map((work) => ({
      id: work.id,
      sourceHash: work.sourceHash ?? null,
      sourceUrl: work.sourceUrl ?? null,
      revision: work.revision ?? null,
      rights: work.rights.map((ev) => ({ declaration: ev.declaration, expression: ev.expression ?? null, url: ev.url ?? null, assertedBy: ev.assertedBy, status: ev.status })),
      grants: (work.grants ?? []).map((grant) => ({ kind: grant.kind, licence: grant.licence ?? null, scope: grant.scope })),
    })),
  });
  return `sha256:${sha256Hex(new TextEncoder().encode(payload))}`;
}

/**
 * The whole evaluation, facts and decisions together. This is the receipt key:
 * a different output, source revision, operation, route, audience or recorded
 * decision is a different fingerprint, so a receipt measured for one export
 * never speaks for another.
 */
function fingerprintOf(situation: string, decisions: readonly RightsDecisionV1[]): string {
  const payload = canonicalJson({
    decisions: decisions.map((decision) => ({ work: decision.work, kind: decision.kind, licence: decision.licence ?? null, note: decision.note ?? null, fingerprint: decision.fingerprint ?? null })),
    situation,
  });
  return `sha256:${sha256Hex(new TextEncoder().encode(payload))}`;
}

// A synchronous SHA-256, because the evaluator answers a shell paint and the
// only digest the platform offers, crypto.subtle, is asynchronous. FIPS 180-4,
// the same constants and message schedule as any other implementation. It is
// private on purpose: engine code that can await uses `sha256Hex` in bytes.ts.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  // The message, one 0x80 byte and the 8-byte bit count, rounded up to whole
  // 64-byte blocks. Rounding up one block too many changes the digest, so this
  // is a ceiling and not a shift.
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (value) => value.toString(16).padStart(8, '0')).join('');
}
