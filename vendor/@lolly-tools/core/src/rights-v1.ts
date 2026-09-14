// SPDX-License-Identifier: MPL-2.0
/**
 * Portable creative-rights records (plan 253): what a source declared, who
 * said so, how a work was used, what a delivery needs, what was done about it
 * and what a file carries. Evidence, obligations and completed delivery stay
 * three separate facts. Nothing here is a legal determination: an evaluator
 * applies reviewed, versioned rules to these records and names the rule.
 */

/** Stable machine codes for anything that needs a person or is not covered. */
export const RIGHTS_ISSUE_CODES = [
  'attribution.source-missing',
  'attribution.delivery-missing',
  'licence.adaptation-choice',
  'licence.use-not-covered',
  'licence.grant-conflict',
  'licence.unknown',
  'source.redistribution-unknown',
  'credential.ingredient-missing',
] as const;
export type RightsIssueCodeV1 = (typeof RIGHTS_ISSUE_CODES)[number];

export const RIGHTS_STATUSES = ['ready', 'actions-required', 'use-not-covered', 'unknown', 'delivery-failed'] as const;
export type RightsStatusV1 = (typeof RIGHTS_STATUSES)[number];

/** Who made a rights statement. `exporter` is Lolly recording what it observed. */
export type RightsAssertingPartyV1 = 'source' | 'catalog' | 'user' | 'credential' | 'exporter';
/** Where a rights statement was read from. */
export type RightsEvidenceSourceV1 = 'manifest' | 'catalog-entry' | 'native-metadata' | 'sidecar' | 'notice-file' | 'user-declaration';
/** `unparsed` keeps a declaration nobody could interpret; `missing` says the field was looked for. */
export type RightsEvidenceStatusV1 = 'parsed' | 'unparsed' | 'missing' | 'not-applicable';

/** One rights statement as it was found. A later import never overwrites an earlier one. */
export interface RightsEvidenceV1 {
  /** The declaration exactly as supplied, e.g. `cc-by-4.0` or `CC BY 4.0`. */
  declaration: string;
  /** The normalised identifier or SPDX-style expression when it parsed, e.g. `CC-BY-SA-4.0`. */
  expression?: string;
  version?: string;
  /** The licence or dedication text's public URL. */
  url?: string;
  /** `sha256:<hex>` of the licence text when the text itself is held. */
  textHash?: string;
  copyright?: string;
  /** Notice texts the licence asks to be retained (an Apache NOTICE, a font's reserved name). */
  notices?: string[];
  assertedBy: RightsAssertingPartyV1;
  evidence: RightsEvidenceSourceV1;
  capturedAt?: string;
  status: RightsEvidenceStatusV1;
}

export interface CreativePartyV1 {
  name: string;
  /** e.g. `creator`, `publisher`, `contributor`. */
  role?: string;
  url?: string;
}

/**
 * A grant: a public licence, a dedication, a specific permission or the user's
 * own-work declaration. A private grant document is referenced, never carried
 * into public export metadata.
 */
export interface PermissionGrantV1 {
  kind: 'public-licence' | 'dedication' | 'specific-permission' | 'own-work';
  /** Canonical identifier for a public licence or dedication. */
  licence?: string;
  /** What the grant covers, in plain words. */
  scope: string;
  purposes?: string[];
  recipients?: string[];
  territory?: string;
  expires?: string;
  /** A local pointer to the evidence document. Never exported. */
  evidenceRef?: string;
  /** True when a party asserted it; false when it was independently checked. */
  asserted: boolean;
}

/** A creative work: stable identity, credited parties, source and every rights statement about it. */
export interface CreativeWorkRecordV1 {
  id: string;
  title?: string;
  creators: CreativePartyV1[];
  /** A stable public locator for the work; no tokens, no private paths. */
  sourceUrl?: string;
  revision?: string;
  /** `sha256:<hex>` of the source bytes as obtained. */
  sourceHash?: string;
  rights: RightsEvidenceV1[];
  grants?: PermissionGrantV1[];
}

/** How a work takes part in an output. */
export type CreativeUseRoleV1 = 'incorporated' | 'transformation' | 'runtime' | 'reference' | 'source-distribution';

/** Factual operations a renderer knows it performed. Facts, not legal classifications. */
export const CREATIVE_OPERATIONS = ['placed', 'resized', 'moved', 'converted', 'cropped', 'recoloured', 'outlined', 'retouched', 'mixed', 'synchronised'] as const;
export type CreativeOperationV1 = (typeof CREATIVE_OPERATIONS)[number];

/** The assessed classification, with the rule that produced it kept beside it. */
export type CreativeClassificationV1 = 'unchanged' | 'technical-conversion' | 'collection-component' | 'adaptation' | 'undetermined';

export interface CreativeUseV1 {
  /** `CreativeWorkRecordV1.id`. */
  work: string;
  pin?: { id: string; version: string; checksum: string };
  role: CreativeUseRoleV1;
  operations: CreativeOperationV1[];
  scope?: { count: number; placements?: string[] };
  /** Filled by the evaluator when absent; a caller may not upgrade it by hand. */
  classification?: CreativeClassificationV1;
  classificationRule?: string;
  /** The grant chosen for this use when a work carries several. */
  selectedGrant?: string;
}

export type DeliveryRouteV1 = 'file-with-c2pa' | 'file-without-c2pa' | 'package' | 'clipboard' | 'connector';

/** The intended operation and delivery. Unknowns stay unknown; nothing is inferred from a price or an account. */
export interface UseContextV1 {
  operation: 'render' | 'download-original' | 'copy' | 'package' | 'send';
  delivery: {
    format: string;
    route: DeliveryRouteV1;
    canCarryCredential: boolean;
    canCarryReadableCredit: boolean;
  };
  audience: 'private' | 'shared' | 'public' | 'unknown';
  commercial?: boolean | 'unknown';
  /** A licence the user chose for the output's own contribution, or null for no declaration. */
  outputLicence?: string | null;
  /** Supplied by the caller; the evaluator never reads a clock. */
  evaluatedAt?: string;
}

export interface RightsRemedyV1 {
  kind: 'output-licence' | 'keep-original' | 'replace-work' | 'separate-permission' | 'add-information' | 'copy-credit' | 'package-delivery';
  label: string;
  licence?: string;
}

export interface RightsIssueV1 {
  code: RightsIssueCodeV1;
  work?: string;
  summary: string;
  remedies: RightsRemedyV1[];
  /** The named rule that raised it. */
  rule?: string;
}

/** One credit line the plan will deliver, required or offered as a courtesy. */
export interface AttributionNoticeV1 {
  work: string;
  required: boolean;
  credit: string;
  licence?: string;
  licenceUrl?: string;
  sourceUrl?: string;
  changes?: string;
  /** A notice text that must travel verbatim (Apache NOTICE, OFL reserved names). */
  noticeText?: string;
}

export type AttributionChannelV1 = 'c2pa-ingredients' | 'readable-details' | 'readable-companion' | 'caption' | 'native-metadata';

export interface AttributionPlanV1 {
  required: AttributionNoticeV1[];
  optional: AttributionNoticeV1[];
  changes: string[];
  channels: AttributionChannelV1[];
  humanActions: RightsIssueV1[];
  unresolved: string[];
  rulesVersion: string;
  /** Profile id to its reviewed version. */
  profileVersions: Record<string, string>;
}

export interface CreativeUseResultV1 {
  work: string;
  /** Index into the evaluated uses list. */
  use: number;
  classification: CreativeClassificationV1;
  rule: string;
  licence: string | null;
  reviewed: boolean;
  issues: RightsIssueCodeV1[];
}

/**
 * A choice a person made. `acknowledged` records that a warning was seen and
 * resolves nothing; only an output licence or a recorded permission does.
 */
export interface RightsDecisionV1 {
  /**
   * `RightsEvaluationV1.situation` as it stood when the choice was made. The
   * evaluator applies the choice only while the facts still hash to this, so a
   * changed source, treatment, format or audience retires it instead of letting
   * it answer for something it was never about. Absent means a caller stated the
   * choice directly rather than replaying a stored one.
   */
  fingerprint?: string;
  work: string;
  kind: 'output-licence' | 'separate-permission' | 'acknowledged';
  licence?: string;
  note?: string;
  recordedAt?: string;
}

export interface RightsEvaluationV1 {
  status: RightsStatusV1;
  uses: CreativeUseResultV1[];
  plan: AttributionPlanV1;
  issues: RightsIssueV1[];
  /** sha256 over the canonical inputs and the rules version; a changed input is a new fingerprint. */
  fingerprint: string;
  /**
   * sha256 over the same inputs with the decisions left out: the facts a person
   * was looking at. A decision is stamped with this and applies only while it
   * still matches, which is what retires a choice made about something else.
   */
  situation: string;
  rulesVersion: string;
}

export type ReceiptStateV1 = 'prepared' | 'written' | 'readback-confirmed' | 'delivered' | 'destination-confirmed' | 'user-recorded-external-action';

/** What was done for one output, measured after writing, never assumed. */
export interface AttributionReceiptV1 {
  fingerprint: string;
  /** `sha256:<hex>` of the delivered bytes. */
  outputHash?: string;
  state: ReceiptStateV1;
  /** Work ids the plan required. */
  expected: string[];
  /** Work ids found in the delivered bytes. */
  observed: string[];
  checks: { name: string; ok: boolean; detail?: string }[];
  remaining: RightsIssueV1[];
  /** The readable credits as delivered or to be delivered. */
  credits: string;
}

export interface RightsReportSourceV1 {
  title?: string;
  creator?: string;
  licence?: string;
  licenceUrl?: string;
  sourceUrl?: string;
  modifications: string[];
  /** `source` when the source signed for itself; `exporter` when Lolly recorded it. */
  assertedBy: 'source' | 'exporter';
  carried: { ingredient: boolean; credentialed: boolean; readableCredit: boolean | 'unknown' };
  credit: string;
}

/** The three questions Verify answers: what is recorded, what the file carries, what a reuse would need. */
export interface RightsReportV1 {
  summary: string;
  recorded: RightsReportSourceV1[];
  carried: { ingredients: number; credentialed: number; recorded: number; limits: string[] };
  /** Filled only when a caller supplied a context; opening Verify never implies a reuse. */
  reuse: RightsEvaluationV1 | null;
  /** The composition's own `dc:rights`, kept apart from its sources' rights. */
  ownRights: string | null;
}
