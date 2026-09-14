// SPDX-License-Identifier: MPL-2.0
/** Reads a verified credential back as the three rights questions Verify asks about a file (plan 253). */
import type {
  CreativeUseV1,
  CreativeWorkRecordV1,
  RightsEvaluationV1,
  RightsReportSourceV1,
  RightsReportV1,
  UseContextV1,
} from '@lolly-tools/core/rights-v1';
import type { C2paIngredientRecord, C2paReport } from './c2pa-verify.ts';
import { evaluateCreativeUses } from './rights-evaluate.ts';
import type { LicenceProfileV1 } from './rights-profiles.ts';
import { licenceDisplayName, normaliseLicence, publicLocator } from './rights-profiles.ts';

/**
 * The credit for one recorded source, in the same words the export panel uses.
 *
 * Three rules it keeps. The licence prints under its readable name, so a credit
 * copied here and a credit copied from the export panel are the same string. A
 * locator prints only when it is an ordinary public address, because this text
 * is read out of a stranger's credential and offered to a person to paste. And
 * each recorded modification is often a whole sentence, so one trailing full
 * stop is trimmed before they are joined and the line ends with one, not two.
 */
function creditFor(source: Omit<RightsReportSourceV1, 'credit'>): string {
  const pieces: string[] = [];
  const head: string[] = [];
  if (source.title) head.push(`"${source.title}"`);
  if (source.creator) head.push(head.length ? `by ${source.creator}` : source.creator);
  if (head.length) pieces.push(head.join(' '));
  if (source.licence) {
    const id = normaliseLicence(source.licence).id;
    const name = id ? licenceDisplayName(id) : source.licence;
    const url = publicLocator(source.licenceUrl);
    pieces.push(url ? `${name} ${url}` : name);
  }
  const sourceUrl = publicLocator(source.sourceUrl);
  if (sourceUrl) pieces.push(`source ${sourceUrl}`);
  const changes = source.modifications.map((text) => text.trim().replace(/\.$/, '')).filter(Boolean);
  pieces.push(changes.length ? `changes: ${changes.join(', ')}` : 'unchanged');
  return `${pieces.join(', ')}.`;
}

function sourceFrom(record: C2paIngredientRecord): RightsReportSourceV1 {
  const rights = record.rights;
  const partial: Omit<RightsReportSourceV1, 'credit'> = {
    title: record.title,
    creator: rights?.creator,
    licence: rights?.license,
    licenceUrl: rights?.licenseUrl,
    sourceUrl: rights?.sourceUrl ?? record.data?.url,
    modifications: rights?.modifications ? [...rights.modifications] : [],
    // A credentialed ingredient carries its own signed manifest, so the source
    // spoke for itself. A source ingredient was described by this exporter, and
    // saying so is the difference between a record and a signature.
    assertedBy: record.credentialed ? 'source' : 'exporter',
    carried: {
      ingredient: true,
      credentialed: record.credentialed,
      // Nothing in a credential says whether a readable credit travels beside
      // the file, so this stays unknown rather than being assumed either way.
      readableCredit: 'unknown',
    },
  };
  return { ...partial, credit: creditFor(partial) };
}

/**
 * What a file records, what it carries, and nothing about reuse unless a
 * caller asked. Opening Verify is not a statement that someone wants to
 * publish or relicense the work, so `reuse` stays null until a context is
 * supplied to {@link evaluateReuse}.
 */
export function rightsReportFromC2pa(report: C2paReport): RightsReportV1 {
  const ingredients = report.ingredients ?? [];
  const recorded = ingredients.map(sourceFrom);
  const credentialed = recorded.filter((source) => source.carried.credentialed).length;
  const limits: string[] = [];
  if (!report.found) limits.push('This file carries no Content Credential, so no source list was read from it.');
  else if (report.state !== 'valid') limits.push('The credential did not verify, so every rights statement in it is an unchecked assertion.');
  if (ingredients.length) {
    limits.push('This list is what the signer declared. It is not a check that every work in the pixels was identified.');
    limits.push('Whether a readable credit travels beside this file was not inspected.');
  }
  const unnamed = recorded.filter((source) => !source.creator || !source.licence).length;
  if (unnamed) limits.push(`${unnamed} of ${recorded.length} recorded sources are missing a creator or a licence.`);

  return {
    summary: summaryFor(report, recorded, credentialed),
    recorded,
    carried: { ingredients: ingredients.length, credentialed, recorded: recorded.length - credentialed, limits },
    reuse: null,
    ownRights: report.rights ?? null,
  };
}

/**
 * One computed sentence per fact, never a name and never a verdict about
 * rights. The credential's own integrity stays a separate field, so a file with
 * complete credits and a broken signature does not read as intact.
 */
function summaryFor(report: C2paReport, recorded: readonly RightsReportSourceV1[], credentialed: number): string {
  const parts: string[] = [];
  if (!report.found) parts.push('No Content Credential was found in this file.');
  else if (report.state === 'valid') parts.push('Credential intact.');
  else parts.push('The credential did not verify.');
  if (!recorded.length) {
    parts.push('It records no creative sources.');
  } else {
    const count = recorded.length;
    const word = count === 1 ? 'source' : 'sources';
    parts.push(`It records ${count} ${word}.`);
    const exporter = count - credentialed;
    if (exporter && credentialed) parts.push(`${credentialed} signed for themselves; the exporter recorded the other ${exporter}.`);
    else if (exporter) parts.push(exporter === 1 ? 'The exporter recorded it; the source did not sign a credential of its own.' : 'The exporter recorded them; the sources did not sign credentials of their own.');
    else parts.push(count === 1 ? 'The source signed its own credential.' : 'The sources signed their own credentials.');
  }
  if (report.rights) parts.push("The composition's own rights statement is separate from its sources'.");
  return parts.join(' ');
}

/**
 * The third question, asked only when someone asks it: what a stated reuse of
 * this file's recorded sources would need. Every source becomes one work and
 * one use, so the same reviewed rules answer here as at export.
 */
export function evaluateReuse(
  report: C2paReport,
  context: UseContextV1,
  options: { operations?: CreativeUseV1['operations']; role?: CreativeUseV1['role']; extraProfiles?: readonly LicenceProfileV1[] } = {},
): RightsEvaluationV1 {
  const works: CreativeWorkRecordV1[] = [];
  const uses: CreativeUseV1[] = [];
  for (const [index, record] of (report.ingredients ?? []).entries()) {
    const rights = record.rights;
    const id = record.instanceId ?? rights?.sourceUrl ?? record.data?.url ?? `ingredient-${index + 1}`;
    const work: CreativeWorkRecordV1 = {
      id,
      creators: rights?.creator ? [{ name: rights.creator, role: 'creator' }] : [],
      rights: rights?.license
        ? [{ declaration: rights.license, url: rights.licenseUrl, assertedBy: record.credentialed ? 'source' : 'exporter', evidence: 'native-metadata', status: 'parsed' }]
        : [{ declaration: '', assertedBy: 'exporter', evidence: 'native-metadata', status: 'missing' }],
    };
    if (record.title) work.title = record.title;
    const sourceUrl = rights?.sourceUrl ?? record.data?.url;
    if (sourceUrl) work.sourceUrl = sourceUrl;
    if (rights?.revision) work.revision = rights.revision;
    if (rights?.sourceHash) work.sourceHash = rights.sourceHash;
    works.push(work);
    uses.push({ work: id, role: options.role ?? 'incorporated', operations: [...(options.operations ?? ['placed'])] });
  }
  return evaluateCreativeUses({ works, uses, context, extraProfiles: options.extraProfiles });
}
