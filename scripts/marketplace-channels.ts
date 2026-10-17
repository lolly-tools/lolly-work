// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { release } from './marketplace-packages.ts';
import { INDEX_URL, REPOSITORY } from './package-helm-chart.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const RECORD_FILE = join(root, 'deploy/marketplaces/channels.json');
export const TABLE_FILE = join(root, 'deploy/marketplaces/CHANNELS.md');
const BEGIN = '<!-- channel-table:begin (generated from channels.json by node scripts/marketplace-channels.ts) -->';
const END = '<!-- channel-table:end -->';

export type Route = 'registry' | 'feed' | 'direct' | 'catalogue';
export type Outcome = 'submitted' | 'published' | 'failed' | 'rejected' | 'withdrawn';
export type Lifecycle = 'maintained' | 'paused' | 'retiring' | 'retired';
export type State = 'prepared' | 'in review' | 'current' | 'behind' | 'failed' | 'paused' | 'retiring' | 'retired';
export interface Attempt { release: string; package: string; outcome: Outcome; date: string; evidence?: string; note?: string; minutes?: number; reviewDays?: number }
export interface Channel {
  id: string; name: string; route: Route; update: string; open?: string; lifecycle: Lifecycle;
  pause?: { since: string; reason: string };
  notice?: { url: string; published: string; newInstallsEnd: string; migration: string };
  retired?: string;
  attempts: Attempt[];
}
export interface ChannelRecord { schemaVersion: 1; channels: Channel[] }

const ROUTES: Record<Route, string> = { registry: 'Image registry', feed: 'Project repository', direct: 'Direct recipe', catalogue: 'Public catalogue' };
const OUTCOMES: Outcome[] = ['submitted', 'published', 'failed', 'rejected', 'withdrawn'];
const LIFECYCLES: Lifecycle[] = ['maintained', 'paused', 'retiring', 'retired'];
// Anything outside these fields belongs in the private maintainer record.
const FIELDS: Record<string, string[]> = {
  record: ['schemaVersion', 'channels'],
  channel: ['id', 'name', 'route', 'update', 'open', 'lifecycle', 'pause', 'notice', 'retired', 'attempts'],
  attempt: ['release', 'package', 'outcome', 'date', 'evidence', 'note', 'minutes', 'reviewDays'],
  pause: ['since', 'reason'],
  notice: ['url', 'published', 'newInstallsEnd', 'migration'],
};
const PRIVATE: [RegExp, string][] = [
  [/[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/i, 'an email address'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'a UUID'],
  [/lolly-private|(?:^|[\s/])plans\//i, 'a private record path'],
  [/(?:^|\s)(?:~\/|\/Users\/|\/home\/|\/root\/)|\bfile:\/\//i, 'a local path'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_\w+|-----BEGIN|\bAKIA[0-9A-Z]{16}\b/, 'a credential'],
];

const isText = (value: unknown, max = 300): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[|\n\r]/.test(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function compareReleases(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'is not a URL';
  let url: URL;
  try { url = new URL(value); } catch { return 'is not a URL'; }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.username || url.password || url.search) return 'must not carry credentials or a query string';
  if (/^(?:localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$|\.(?:local|internal|lan|home)$/i.test(url.hostname)) return 'must be a public host';
  return undefined;
}

function scanPublic(value: unknown, path: string, problems: string[]) {
  if (typeof value === 'string') {
    for (const [pattern, what] of PRIVATE) if (pattern.test(value)) problems.push(`${path} contains ${what}; keep it in the private maintainer record`);
    // Run IDs inside public URLs are fine; a bare 12-digit number reads as a cloud account.
    if (!/^https:/.test(value) && /(?<![\w./-])\d{12}(?![\w./-])/.test(value)) problems.push(`${path} contains a 12-digit account number; keep it in the private maintainer record`);
  } else if (Array.isArray(value)) value.forEach((item, i) => scanPublic(item, `${path}[${i}]`, problems));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) scanPublic(item, `${path}.${key}`, problems);
}

function onlyFields(value: unknown, kind: string, path: string, problems: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${path} must be an object`); return false; }
  for (const key of Object.keys(value)) if (!FIELDS[kind]!.includes(key)) problems.push(`${path}.${key} is not a public channel field; account IDs, owners and receipts belong in the private maintainer record`);
  return true;
}

/** Every reason the record is invalid or not safe to publish. */
export function recordProblems(record: unknown): string[] {
  const problems: string[] = [];
  scanPublic(record, 'record', problems);
  if (!onlyFields(record, 'record', 'record', problems)) return problems;
  if (record.schemaVersion !== 1) problems.push('record.schemaVersion must be 1');
  if (!Array.isArray(record.channels)) return [...problems, 'record.channels must be a list'];
  const ids = new Set<string>();
  for (const [index, channel] of (record.channels as unknown[]).entries()) {
    const at = `channels[${index}]`;
    if (!onlyFields(channel, 'channel', at, problems)) continue;
    const name = `${at} (${String(channel.id)})`;
    if (typeof channel.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(channel.id)) problems.push(`${at}.id must be lower-case words joined by hyphens`);
    else if (ids.has(channel.id)) problems.push(`${name} is listed twice`);
    else ids.add(channel.id);
    for (const key of ['name', 'update']) if (!isText(channel[key])) problems.push(`${name}.${key} must be one line of plain text without "|"`);
    if (channel.open !== undefined && !isText(channel.open)) problems.push(`${name}.open must be one line of plain text without "|"`);
    if (!Object.hasOwn(ROUTES, channel.route as string)) problems.push(`${name}.route must be one of ${Object.keys(ROUTES).join(', ')}`);
    if (!LIFECYCLES.includes(channel.lifecycle as Lifecycle)) problems.push(`${name}.lifecycle must be one of ${LIFECYCLES.join(', ')}`);
    if ((channel.lifecycle === 'paused') !== (channel.pause !== undefined)) problems.push(`${name}.pause is required for a paused channel and only for one`);
    if (channel.pause !== undefined && onlyFields(channel.pause, 'pause', `${name}.pause`, problems)) {
      if (!isDate(channel.pause.since) || !isText(channel.pause.reason)) problems.push(`${name}.pause needs a since date and a one-line reason`);
    }
    const retiring = channel.lifecycle === 'retiring' || channel.lifecycle === 'retired';
    if (retiring !== (channel.notice !== undefined)) problems.push(`${name}.notice is required once retirement starts and only then`);
    if (channel.notice !== undefined && onlyFields(channel.notice, 'notice', `${name}.notice`, problems)) {
      const notice = channel.notice;
      for (const key of ['url', 'migration']) { const bad = publicUrl(notice[key]); if (bad) problems.push(`${name}.notice.${key} ${bad}`); }
      if (!isDate(notice.published) || !isDate(notice.newInstallsEnd)) problems.push(`${name}.notice needs published and newInstallsEnd dates`);
      else if (notice.newInstallsEnd < notice.published) problems.push(`${name}.notice ends new installations before the notice is published`);
    }
    if ((channel.lifecycle === 'retired') !== (channel.retired !== undefined)) problems.push(`${name}.retired is required for a retired channel and only for one`);
    const end = (channel.notice as { newInstallsEnd?: unknown } | undefined)?.newInstallsEnd;
    if (channel.retired !== undefined && !isDate(channel.retired)) problems.push(`${name}.retired must be a date`);
    else if (channel.retired !== undefined && isDate(end) && channel.retired < end) problems.push(`${name} retired before the date its notice gave for new installations to end`);
    if (!Array.isArray(channel.attempts)) { problems.push(`${name}.attempts must be a list`); continue; }
    let previous = '';
    const live: string[] = [];
    for (const [step, attempt] of (channel.attempts as unknown[]).entries()) {
      const where = `${name}.attempts[${step}]`;
      if (!onlyFields(attempt, 'attempt', where, problems)) continue;
      const outcome = attempt.outcome as Outcome;
      if (!OUTCOMES.includes(outcome)) problems.push(`${where}.outcome must be one of ${OUTCOMES.join(', ')}`);
      if (typeof attempt.release !== 'string' || !/^\d+\.\d+\.\d+$/.test(attempt.release)) problems.push(`${where}.release must be a Work release such as 1.1.1`);
      if (typeof attempt.package !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.~+-]{0,63}$/.test(attempt.package)) problems.push(`${where}.package must be the channel's own version`);
      if (!isDate(attempt.date)) problems.push(`${where}.date must be a date such as 2026-10-17`);
      else if (attempt.date < previous) problems.push(`${where} is dated before the attempt above it; append attempts in order`);
      else previous = attempt.date;
      if (attempt.evidence !== undefined) { const bad = publicUrl(attempt.evidence); if (bad) problems.push(`${where}.evidence ${bad}`); }
      if (attempt.note !== undefined && !isText(attempt.note)) problems.push(`${where}.note must be one line of plain text without "|"`);
      for (const key of ['minutes', 'reviewDays']) if (attempt[key] !== undefined && !isCount(attempt[key])) problems.push(`${where}.${key} must be a whole number`);
      if (outcome === 'published' && attempt.evidence === undefined) problems.push(`${where} is published without public evidence`);
      if (['failed', 'rejected', 'withdrawn'].includes(outcome) && attempt.note === undefined) problems.push(`${where} needs a note saying what happened`);
      const key = `${String(attempt.release)} ${String(attempt.package)}`;
      if (outcome === 'published') live.push(key);
      if (outcome === 'withdrawn') {
        if (!live.includes(key)) problems.push(`${where} withdraws a version this channel does not carry`);
        else live.splice(0, live.length, ...live.filter(item => item !== key));
      }
    }
    if (channel.lifecycle === 'retired' && channel.attempts.length && (channel.attempts.at(-1) as { date?: string }).date! > (channel.retired as string)) problems.push(`${name} has attempts after its retirement`);
  }
  return problems;
}

export function validateRecord(record: unknown): ChannelRecord {
  const problems = recordProblems(record);
  if (problems.length) throw new Error(`Invalid channel record:\n- ${problems.join('\n- ')}`);
  return record as ChannelRecord;
}

/** The version a channel carries: its last publication that was not withdrawn later. */
export function carried(channel: Channel): Attempt | undefined {
  const live: Attempt[] = [];
  for (const attempt of channel.attempts) {
    if (attempt.outcome === 'published') live.push(attempt);
    if (attempt.outcome === 'withdrawn') live.splice(0, live.length, ...live.filter(item => item.release !== attempt.release || item.package !== attempt.package));
  }
  return live.at(-1);
}

/** A failed or rejected latest attempt always shows as failed, even when the carried version is current. */
export function channelState(channel: Channel, cohort = release.version as string): State {
  if (channel.lifecycle !== 'maintained') return channel.lifecycle;
  const latest = channel.attempts.at(-1), carries = carried(channel);
  if (latest?.outcome === 'failed' || latest?.outcome === 'rejected') return 'failed';
  if (latest?.outcome === 'submitted') return 'in review';
  if (!carries) return 'prepared';
  return compareReleases(carries.release, cohort) >= 0 ? 'current' : 'behind';
}

const version = (attempt: Attempt) => attempt.package === attempt.release ? attempt.release : `${attempt.release} (${attempt.package})`;
const linked = (text: string, url?: string) => url ? `[${text}](${url})` : text;

export function renderTable(record: ChannelRecord, cohort = release.version as string) {
  const rows = record.channels.map(channel => {
    const carries = carried(channel), latest = channel.attempts.at(-1), state = channelState(channel, cohort);
    const named = latest === carries ? '' : ` ${linked(version(latest!), latest?.evidence)}`;
    const last = latest ? `${latest.outcome}${named} on ${latest.date}${latest.note ? `: ${latest.note}` : ''}` : 'None';
    const shown = state === 'failed' ? '**failed**'
      : state === 'paused' ? `paused since ${channel.pause!.since}: ${channel.pause!.reason}`
        : state === 'retiring' ? `retiring: ${linked('new installations end', channel.notice!.url)} on ${channel.notice!.newInstallsEnd}`
          : state === 'retired' ? `retired on ${channel.retired} (${linked('notice', channel.notice!.url)})` : state;
    return `| ${channel.name} | ${ROUTES[channel.route]} | ${carries ? linked(version(carries), carries.evidence) : 'Nothing yet'} | ${last} | ${shown} | ${channel.open ?? ''} |`;
  });
  return [
    `Qualified release cohort: Work ${cohort}, from [\`release.json\`](release.json).`, '',
    '| Channel | Route | Carries | Latest attempt | State | Still open |', '|---|---|---|---|---|---|', ...rows,
  ].join('\n');
}

const canonical = (record: ChannelRecord) => JSON.stringify(record, null, 2) + '\n';
export function readRecord(file = RECORD_FILE) { return validateRecord(JSON.parse(readFileSync(file, 'utf8'))); }

export function withTable(markdown: string, table: string) {
  const start = markdown.indexOf(BEGIN), end = markdown.indexOf(END);
  if (start < 0 || end < start || markdown.indexOf(BEGIN, start + 1) >= 0) throw new Error('CHANNELS.md needs exactly one generated table block');
  return `${markdown.slice(0, start + BEGIN.length)}\n${table}\n${markdown.slice(end)}`;
}

/** Validates the record and refreshes the table; `check` refuses drift instead of writing. */
export function writeChannels(check = false, record = readRecord()) {
  const markdown = readFileSync(TABLE_FILE, 'utf8'), next = withTable(markdown, renderTable(record));
  if (check) {
    if (readFileSync(RECORD_FILE, 'utf8') !== canonical(record)) throw new Error('Reformat channels.json: node scripts/marketplace-channels.ts');
    if (markdown !== next) throw new Error('Regenerate CHANNELS.md: node scripts/marketplace-channels.ts');
    return;
  }
  writeFileSync(RECORD_FILE, canonical(record));
  writeFileSync(TABLE_FILE, next);
}

const MANIFEST_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');
type Target = Pick<Attempt, 'release' | 'package'>;

/** Anonymous check that the public index lists the chart and serves the bytes it names. */
export async function verifyHelmRepository(target: Target, fetchImpl: typeof fetch = fetch) {
  const index = await fetchImpl(`${INDEX_URL}/index.yaml`, { redirect: 'follow' });
  if (!index.ok) throw new Error(`The public chart index answered HTTP ${index.status}`);
  const entries: { version?: string; appVersion?: string; digest?: string; urls?: string[] }[] = parse(await index.text())?.entries?.['lolly-work'] ?? [];
  const entry = entries.find(item => item.version === target.package);
  if (!entry) throw new Error(`The public chart index does not list chart ${target.package}`);
  if (entry.appVersion !== target.release) throw new Error(`Chart ${target.package} names application ${entry.appVersion}, not ${target.release}`);
  const url = `https://github.com/${REPOSITORY}/releases/download/chart-v${target.package}/lolly-work-${target.package}.tgz`;
  if (entry.urls?.[0] !== url) throw new Error(`Chart ${target.package} points at ${entry.urls?.[0]}, not its immutable release`);
  const archive = await fetchImpl(url, { redirect: 'follow' });
  if (!archive.ok) throw new Error(`The chart archive answered HTTP ${archive.status}`);
  const sha256 = createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex');
  if (sha256 !== entry.digest) throw new Error(`The chart archive is ${sha256}; the index names ${entry.digest}`);
  return `Chart ${target.package} for application ${target.release} is listed and its archive matches ${sha256}.`;
}

/** Anonymous check that each image digest in release.json resolves on GHCR. */
export async function verifyImages(target: Target, fetchImpl: typeof fetch = fetch) {
  if (target.release !== release.version) throw new Error(`Only release ${release.version} in release.json has recorded image digests`);
  for (const image of [release.serverImage, release.workerImage] as string[]) {
    const pin = /^ghcr\.io\/([a-z0-9._/-]+)@(sha256:[a-f0-9]{64})$/.exec(image);
    if (!pin) throw new Error(`${image} is not a GHCR digest pin`);
    const [, name, digest] = pin;
    const grant = await fetchImpl(`https://ghcr.io/token?scope=repository:${name}:pull`);
    if (!grant.ok) throw new Error(`GHCR refused an anonymous pull token for ${name}`);
    const { token } = await grant.json() as { token?: string };
    const manifest = await fetchImpl(`https://ghcr.io/v2/${name}/manifests/${digest}`, { method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES } });
    if (!manifest.ok || manifest.headers.get('docker-content-digest') !== digest) throw new Error(`${name}@${digest} does not resolve anonymously`);
  }
  return `Both release ${target.release} image digests resolve anonymously.`;
}

export const VERIFIERS: Record<string, (target: Target, fetchImpl?: typeof fetch) => Promise<string>> = {
  'helm-repository': verifyHelmRepository,
  'ghcr-images': verifyImages,
};

/** Appends an attempt. A publication through a checked channel is written only after its anonymous check passes. */
export async function recordAttempt(record: ChannelRecord, id: string, attempt: Attempt, fetchImpl: typeof fetch = fetch) {
  const channel = record.channels.find(item => item.id === id);
  if (!channel) throw new Error(`No channel ${id}; add it to channels.json after a maintenance review`);
  if (channel.lifecycle === 'retired') throw new Error(`${id} is retired and takes no further attempts`);
  const entry = Object.fromEntries(Object.entries(attempt).filter(([, value]) => value !== undefined)) as unknown as Attempt;
  const next = structuredClone(record);
  next.channels.find(item => item.id === id)!.attempts.push(entry);
  validateRecord(next);
  let checked: string | undefined;
  if (entry.outcome === 'published' && VERIFIERS[id]) {
    try { checked = await VERIFIERS[id](entry, fetchImpl); }
    catch (error) { throw new Error(`${(error as Error).message}. Nothing was recorded as published; record the attempt as failed instead.`); }
  }
  return { record: next, checked };
}

/** The maintainer review: measured effort per channel, and why expansion must pause. */
export function review(record: ChannelRecord, cohort = release.version as string) {
  const lines: string[] = [], pause: string[] = [], unmeasured: string[] = [];
  for (const channel of record.channels) {
    const state = channelState(channel, cohort), published = channel.attempts.filter(a => a.outcome === 'published');
    const failures = channel.attempts.filter(a => a.outcome === 'failed' || a.outcome === 'rejected').length;
    const measured = published.filter(a => a.minutes !== undefined), waits = channel.attempts.flatMap(a => a.reviewDays ?? []);
    const effort = measured.length ? `${Math.round(measured.reduce((sum, a) => sum + a.minutes!, 0) / measured.length)} minutes per publication over ${measured.length}` : 'effort not measured';
    lines.push(`- ${channel.id}: ${state}; ${published.length} published, ${failures} failed or rejected; ${effort}${waits.length ? `; longest review ${Math.max(...waits)} days` : ''}`);
    if (published.length > measured.length) unmeasured.push(channel.id);
    if (['failed', 'behind', 'in review', 'paused'].includes(state)) pause.push(`${channel.id} is ${state}. Update route: ${channel.update}`);
  }
  if (unmeasured.length) lines.push('', `Publications recorded without minutes: ${unmeasured.join(', ')}. Measure the next one.`);
  lines.push('', pause.length ? `Pause expansion:\n- ${pause.join('\n- ')}` : 'No channel is failing, behind, in review or paused.');
  return { lines, pause };
}

/** The run summary for the Helm publication workflow. A failed run is never offered as a publication. */
export function helmSummary(status: string, runUrl: string, chart = parse(readFileSync(join(root, 'deploy/helm/Chart.yaml'), 'utf8'))) {
  const base = `node scripts/marketplace-channels.ts record helm-repository --release ${chart.appVersion} --package ${chart.version}`;
  if (status === 'success') {
    return ['### Channel record', '', 'A successful run is not yet a published attempt. Record it with this command; it checks the public index and archive without signing in and refuses to record `published` if they do not match:',
      '', '```sh', `${base} --outcome published --evidence https://github.com/${REPOSITORY}/releases/tag/chart-v${chart.version}`, '```', '',
      'If the check fails, record the attempt as failed with what the check reported.', ''].join('\n');
  }
  return ['### Channel record', '', `This run ended as ${status}. Record the failed attempt so the channel keeps showing its last published version:`,
    '', '```sh', `${base} --outcome failed --evidence ${runUrl} --note "Publication run ended as ${status}"`, '```', ''].join('\n');
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--check') return writeChannels(command === '--check');
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    release: { type: 'string' }, package: { type: 'string' }, outcome: { type: 'string' }, evidence: { type: 'string' },
    note: { type: 'string' }, date: { type: 'string' }, minutes: { type: 'string' }, 'review-days': { type: 'string' },
  } });
  const count = (value?: string) => value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : NaN;
  if (command === 'record' && positionals.length === 1) {
    const attempt = { release: values.release, package: values.package ?? values.release, outcome: values.outcome, date: values.date ?? new Date().toISOString().slice(0, 10),
      evidence: values.evidence, note: values.note, minutes: count(values.minutes), reviewDays: count(values['review-days']) } as Attempt;
    const { record, checked } = await recordAttempt(readRecord(), positionals[0]!, attempt);
    if (checked) console.log(checked);
    writeChannels(false, record);
    console.log(`Recorded ${attempt.outcome} for ${positionals[0]}; commit channels.json and CHANNELS.md in a pull request.`);
  } else if (command === 'verify' && positionals.length === 1 && VERIFIERS[positionals[0]!] && values.release) {
    console.log(await VERIFIERS[positionals[0]!]!({ release: values.release, package: values.package ?? values.release }));
  } else if (command === 'review' && !positionals.length) {
    const result = review(readRecord());
    console.log(result.lines.join('\n'));
    if (result.pause.length) process.exitCode = 1;
  } else if (command === 'helm-summary' && positionals.length === 2) {
    process.stdout.write(helmSummary(positionals[0]!, positionals[1]!));
  } else {
    throw new Error([
      'Usage: node scripts/marketplace-channels.ts [--check]',
      '       node scripts/marketplace-channels.ts record CHANNEL --release VERSION [--package VERSION] --outcome OUTCOME [--evidence URL] [--note TEXT] [--date YYYY-MM-DD] [--minutes N] [--review-days N]',
      `       node scripts/marketplace-channels.ts verify ${Object.keys(VERIFIERS).join('|')} --release VERSION [--package VERSION]`,
      '       node scripts/marketplace-channels.ts review',
      '       node scripts/marketplace-channels.ts helm-summary STATUS RUN_URL',
    ].join('\n'));
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
