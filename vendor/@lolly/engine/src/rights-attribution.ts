// SPDX-License-Identifier: MPL-2.0
/** Turns an attribution plan into readable credits, companion files, source ingredients and a measured receipt (plan 253). */
import type { RightsRecord, SourceIngredient } from '@lolly-tools/core/host-v1';
import type {
  AttributionNoticeV1,
  AttributionPlanV1,
  AttributionReceiptV1,
  CreativeUseRoleV1,
  CreativeUseV1,
  CreativeWorkRecordV1,
  RightsIssueV1,
} from '@lolly-tools/core/rights-v1';
import type { C2paIngredientRecord, C2paReport } from './c2pa-verify.ts';
import { canonicalJson } from './rights-evaluate.ts';
import { publicLocator } from './rights-profiles.ts';

const CHECKSUM = /^sha256:([0-9a-f]{64})$/;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Readable credits for recipients who do not inspect credentials: one line per
 * required notice, then any notice texts the licences ask to travel verbatim,
 * then the credits a source welcomes without asking for them.
 */
export function attributionCredits(plan: AttributionPlanV1): string {
  const blocks: string[] = [];
  const required = plan.required.map((notice) => notice.credit).filter(Boolean);
  if (required.length) blocks.push(required.join('\n'));
  const notices = plan.required.map((notice) => notice.noticeText).filter((text): text is string => Boolean(text));
  if (notices.length) blocks.push(`Notices that travel with this work\n${notices.join('\n\n')}`);
  const optional = plan.optional.map((notice) => notice.credit).filter(Boolean);
  if (optional.length) blocks.push(`Credits offered as a courtesy\n${optional.join('\n')}`);
  return blocks.join('\n\n');
}

export interface AttributionCompanionV1 {
  /** The files to place beside the delivered artifact, in a stable order. */
  files: { name: string; text: string }[];
}

/**
 * The companion a package route carries: the same readable credits as a text
 * file, and the notices as data so another tool can read them back without
 * parsing prose.
 */
export function attributionCompanion(plan: AttributionPlanV1): AttributionCompanionV1 {
  const credits = attributionCredits(plan);
  const data = {
    rulesVersion: plan.rulesVersion,
    profileVersions: plan.profileVersions,
    changes: plan.changes,
    channels: plan.channels,
    required: plan.required.map(noticeData),
    optional: plan.optional.map(noticeData),
    unresolved: plan.unresolved,
  };
  return {
    files: [
      { name: 'CREDITS.txt', text: credits ? `${credits}\n` : '' },
      { name: 'credits.json', text: `${canonicalJson(data)}\n` },
    ],
  };
}

function noticeData(notice: AttributionNoticeV1): Record<string, unknown> {
  return {
    work: notice.work,
    required: notice.required,
    credit: notice.credit,
    licence: notice.licence ?? null,
    licenceUrl: notice.licenceUrl ?? null,
    sourceUrl: notice.sourceUrl ?? null,
    changes: notice.changes ?? null,
    noticeText: notice.noticeText ?? null,
  };
}

/**
 * Details a portable work record has no field for, keyed by work id: the media
 * type of the source bytes, the attribution sentence the source asks for
 * verbatim, and the changes in the words the producer of the census recorded.
 * A producer that supplies none of these still gets a usable ingredient.
 */
export interface SourceDetailV1 {
  format?: string;
  attribution?: string;
  modifications?: string[];
}

/** A Map, not an object: the key comes out of a source url, so it must not reach a prototype. */
const EXTENSION_FORMATS = new Map<string, string>(Object.entries({
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}));

function formatFromUrl(url: string | undefined): string | undefined {
  const extension = /\.([a-z0-9]{2,4})(?:[?#].*)?$/i.exec(url ?? '')?.[1]?.toLowerCase();
  return extension ? EXTENSION_FORMATS.get(extension) : undefined;
}

/**
 * How a role is recorded in a credential. C2PA 2.4 section 18.16.3 pairs the
 * relationship with the action, and this writer emits the two the specification
 * calls `componentOf` (the output is composed of the work) and `parentOf` (the
 * output derives from it). A transformation input such as a LUT is neither: it
 * is a computational input, which the specification records as `inputTo` and
 * this writer does not emit, and a redistributed source file is carried beside
 * the output rather than being part of it. Both are therefore left out of the
 * credential rather than being recorded as constituent art (plan 253 section
 * 8.3); the plan still carries their required notices, so the credits name them.
 */
const ROLE_RELATIONSHIP = new Map<CreativeUseRoleV1, 'componentOf' | 'parentOf'>([['incorporated', 'componentOf']]);

function checksumBytes(checksum: string): Uint8Array | undefined {
  const hex = CHECKSUM.exec(checksum)?.[1];
  if (!hex) return undefined;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * One Content Credentials source ingredient per used work, carrying the rights
 * Lolly read. Nothing here signs for the upstream author: the ingredient binds
 * the ORIGINAL source bytes at their public locator, and the rights record
 * names the form actually used through the use's pin. A work used more than
 * once yields one ingredient, in the order the works were given.
 */
export function sourceIngredientsFor(
  works: readonly CreativeWorkRecordV1[],
  uses: readonly CreativeUseV1[],
  details: Readonly<Record<string, SourceDetailV1>> = Object.create(null) as Record<string, SourceDetailV1>,
): SourceIngredient[] {
  const out: SourceIngredient[] = [];
  const seen = new Set<string>();
  for (const work of works) {
    const use = uses.find((entry) => entry.work === work.id);
    if (!use || seen.has(work.id)) continue;
    // A font rendering text, a work only pointed at, a LUT and a source file
    // passed on beside the output are not parts of the output, so none becomes
    // an ingredient of it. See ROLE_RELATIONSHIP.
    const relationship = ROLE_RELATIONSHIP.get(use.role);
    if (!relationship) continue;
    seen.add(work.id);
    const detail = (Object.hasOwn(details, work.id) ? details[work.id] : undefined) ?? {};
    const evidence = work.rights.find((ev) => ev.status !== 'not-applicable' && ev.status !== 'missing') ?? work.rights[0];
    const modifications = detail.modifications ?? use.operations.filter((op) => op !== 'placed');
    const licence = evidence?.expression ?? evidence?.declaration ?? '';
    const attribution = detail.attribution ?? '';
    const changed = modifications.length ? ` Changes: ${modifications.join(' ')}` : '';
    const sourceUrl = publicLocator(work.sourceUrl);
    const licenceUrl = publicLocator(evidence?.url);
    // The writer binds a source's bytes with a url and a hash TOGETHER or with
    // neither, and it refuses an empty rights field. An incomplete record must
    // therefore not be turned into an ingredient the writer will reject: a
    // rejected stamp takes the whole credential down, every other source with
    // it. The record is left off instead, and the plan's notice for this work
    // stays, so the receipt reports one missing ingredient rather than an
    // export that quietly lost its Content Credentials.
    const hash = work.sourceHash ? checksumBytes(work.sourceHash) : undefined;
    const bound = Boolean(sourceUrl) && hash !== undefined;
    const rights: RightsRecord | undefined = bound && attribution && licence && licenceUrl
      ? {
        creator: work.creators.map((party) => party.name).join(', '),
        license: licence,
        licenseUrl: licenceUrl,
        attribution,
        sourceUrl,
        revision: work.revision,
        modifications: [...modifications],
        sourceHash: work.sourceHash ?? '',
        usedHash: use.pin?.checksum,
      }
      : undefined;
    const ingredient: SourceIngredient = {
      credential: 'none',
      title: work.title ?? work.id,
      format: detail.format ?? formatFromUrl(work.sourceUrl),
      relationship,
      url: bound ? sourceUrl : undefined,
      hash: bound ? hash : undefined,
      instanceId: use.pin ? `${use.pin.id}@${use.pin.version}` : undefined,
      description: attribution || licence ? `${attribution} Licence: ${licence} <${licenceUrl}>.${changed}`.trim() : undefined,
      informationalUri: licenceUrl || undefined,
      rights: rights ? withoutUndefined(rights) : undefined,
    };
    out.push(withoutUndefined(ingredient));
  }
  return out;
}

/** Drop the keys whose value is absent, keeping the order the object was written in. */
function withoutUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  }
  return value;
}

const ingredientSourceUrl = (record: C2paIngredientRecord): string | undefined => record.rights?.sourceUrl || record.data?.url;

/**
 * Measure what the written bytes actually carry. The plan says which sources a
 * credit was promised for; this compares that against the credential read back
 * out of the delivered file. `readback-confirmed` is reached only when the
 * credential itself VERIFIED and every required source is present with its
 * licence; anything else stays `written` and names what is absent, so nothing
 * claims credits are included before a reader found them in a file whose
 * binding holds.
 *
 * Two things this refuses to accept as a credit delivered by this export.
 *
 * A credential that did not verify is not evidence: plan 253 section 9.1 says an
 * invalid credential's rights text is an untrusted assertion, so a tampered file
 * reads as `written` with the unverified credential named, never as confirmed.
 *
 * An ingredient recorded by some OTHER manifest in the store is not this
 * export's promise kept. `report.ingredients` is every ingredient any manifest
 * in the chain recorded, a preserved upstream manifest included, so the match is
 * restricted to the active manifest's own records. With no active label to
 * compare against there is nothing to attribute the credit to, and the receipt
 * stays `written`.
 *
 * A required notice is matched to an ingredient by the public source locator,
 * the one field both sides carry. A notice with no locator falls back to its
 * work id against the ingredient's instance id, which is how the emoji census
 * pins a pack asset.
 */
export function checkAttributionReadback(
  expected: AttributionPlanV1,
  report: C2paReport,
  outputHash?: string,
  fingerprint?: string,
): AttributionReceiptV1 {
  const valid = report.found && report.state === 'valid';
  const activeLabel = report.claim?.manifestLabel ?? '';
  const ingredients = (report.ingredients ?? []).filter((record) => Boolean(activeLabel) && record.manifest === activeLabel);
  const observed: string[] = [];
  const missing: AttributionNoticeV1[] = [];
  const licenceGaps: string[] = [];
  for (const notice of expected.required) {
    const found = valid ? ingredients.find((record) => matches(notice, record)) : undefined;
    if (!found) {
      missing.push(notice);
      continue;
    }
    observed.push(notice.work);
    const recorded = found.rights?.license ?? '';
    if (notice.licence && recorded !== notice.licence) licenceGaps.push(`${notice.work}: recorded as ${recorded || 'nothing'}`);
  }

  const remaining: RightsIssueV1[] = missing.map((notice) => ({
    code: 'credential.ingredient-missing' as const,
    work: notice.work,
    summary: 'This source is not recorded in the delivered file.',
    remedies: [
      { kind: 'copy-credit' as const, label: 'Copy the credit and add it where the file is shared' },
      { kind: 'package-delivery' as const, label: 'Deliver a package with the credits beside the file' },
    ],
    rule: 'readback-v1',
  }));
  for (const gap of licenceGaps) {
    remaining.push({
      code: 'credential.ingredient-missing',
      summary: `A source licence read back differently from the plan (${gap}).`,
      remedies: [{ kind: 'copy-credit', label: 'Copy the credit and add it where the file is shared' }],
      rule: 'readback-licence-v1',
    });
  }
  if (report.found && !valid && expected.required.length) {
    remaining.push({
      code: 'credential.ingredient-missing',
      summary: 'This file carries a Content Credential that did not verify, so nothing in it counts as a credit delivered.',
      remedies: [
        { kind: 'copy-credit', label: 'Copy the credit and add it where the file is shared' },
        { kind: 'package-delivery', label: 'Deliver a package with the credits beside the file' },
      ],
      rule: 'readback-integrity-v1',
    });
  }

  const checks: AttributionReceiptV1['checks'] = [
    { name: 'credential.found', ok: report.found, detail: report.state },
    { name: 'credential.valid', ok: valid, detail: report.found ? report.state : 'no credential' },
    { name: 'ingredients.present', ok: expected.required.length === 0 || ingredients.length > 0, detail: `${ingredients.length} recorded by this export` },
    { name: 'sources.expected', ok: missing.length === 0, detail: missing.length ? missing.map((notice) => notice.work).sort(byString).join(', ') : 'all found' },
    { name: 'licences.match', ok: licenceGaps.length === 0, detail: licenceGaps.sort(byString).join('; ') || 'as planned' },
  ];

  const receipt: AttributionReceiptV1 = {
    // The evaluation's own fingerprint when the caller kept it; the rules
    // version otherwise, so a receipt always says which rules produced it.
    fingerprint: fingerprint ?? expected.rulesVersion,
    state: remaining.length === 0 ? 'readback-confirmed' : 'written',
    expected: expected.required.map((notice) => notice.work).sort(byString),
    observed: [...new Set(observed)].sort(byString),
    checks,
    remaining,
    credits: attributionCredits(expected),
  };
  if (outputHash) receipt.outputHash = outputHash;
  return receipt;
}

function matches(notice: AttributionNoticeV1, record: C2paIngredientRecord): boolean {
  const url = ingredientSourceUrl(record);
  if (notice.sourceUrl && url) return notice.sourceUrl === url;
  const instance = record.instanceId?.split('@')[0];
  return Boolean(instance && instance === notice.work);
}
