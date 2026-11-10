// SPDX-License-Identifier: MPL-2.0
/**
 * The release feed: the published Helm chart repository's `index.yaml`.
 *
 * Every Lolly release publishes the chart with the release number as its
 * version, so the index lists every release. A release's facts ride the
 * chart's annotations (deploy/helm/Chart.yaml):
 *
 *   artifacthub.io/containsSecurityUpdates  "true" when the release fixes a vulnerability
 *   artifacthub.io/changes                  the highlights, as Artifact Hub and Rancher show them
 *   artifacthub.io/prerelease               "true" for a preview release
 *   lolly.tools/migrations                  how many database migrations the release adds
 *   lolly.tools/migration-classes           additive=<n>,maintenance=<n>, from `pnpm run migrate:classify`
 *   lolly.tools/release-notes               the release notes, an https URL
 *
 * The index is not signed, so what it says is information for an administrator,
 * never an instruction to change anything. The upgrade steps verify the chart's
 * own Sigstore bundle. Every string kept here is bounded and plain; a URL is kept
 * only when it is https; a version only when it is strict semver, because it is
 * written into the upgrade commands the console offers to copy.
 */
import { parse } from 'yaml';
import type { UpdateChannel } from './settings.ts';

export const CHART_NAME = 'lolly-work';
/** Bounds on what one index may make us keep. */
const MAX_ENTRIES = 500;
const MAX_CHANGES = 25;
const MAX_CHANGE_CHARS = 400;
const MAX_URL_CHARS = 2048;
/** The longest artifacthub.io/changes text read; a release's highlights are a few lines. */
const MAX_CHANGES_TEXT = 16 * 1024;

/** YAML options for the feed: no aliases, which a chart index never needs and which
 *  are how a small file grows huge, and no check that mapping keys are unique, which
 *  costs time quadratic in a mapping's size. A later duplicate key simply wins. */
export const FEED_YAML = { maxAliasCount: 0, prettyErrors: false, uniqueKeys: false } as const;

export type ChangeKind = 'added' | 'changed' | 'deprecated' | 'removed' | 'fixed' | 'security';
const CHANGE_KINDS: readonly ChangeKind[] = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];

export interface FeedChange { kind: ChangeKind; description: string }
export interface MigrationClasses { additive: number; maintenance: number }
export interface FeedRelease {
  version: string;
  appVersion: string | null;
  created: string | null;
  prerelease: boolean;
  security: boolean;
  /** Migrations the release adds; null when the release does not say. */
  migrations: number | null;
  migrationClasses: MigrationClasses | null;
  notesUrl: string | null;
  changes: FeedChange[];
}

export class FeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'FeedError'; this.code = code; }
}

// ── semver 2.0 ──────────────────────────────────────────────────────────────
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface Semver { major: number; minor: number; patch: number; pre: string[] }

/** A strict semver version, at most 64 characters, or null. No leading `v`. */
export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const m = SEMVER.exec(value);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some(n => !Number.isSafeInteger(n))) return null;
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre: m[4] ? m[4].split('.') : [] };
}

/** Numeric identifiers carry no leading zeros (the pattern refuses them), so a longer
 *  one is larger and equal lengths compare as text: exact at any size, where a
 *  conversion to Number would make two large identifiers equal. */
function compareIdentifier(x: string, y: string): number {
  const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
  if (xn && yn) return x.length !== y.length ? (x.length < y.length ? -1 : 1) : x === y ? 0 : x < y ? -1 : 1;
  if (xn !== yn) return xn ? -1 : 1;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Semver precedence: -1, 0 or 1. Build metadata is ignored, as the spec says. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifier(x, y);
    if (order) return order;
  }
  return 0;
}

// ── annotation readers ──────────────────────────────────────────────────────
/** One line of plain text: whitespace collapsed, control characters dropped, bounded. */
function plain(value: string, max: number): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An https URL without credentials, or null. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS || /[\s"'<>\\`]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return url.href;
}

function flag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** `lolly.tools/migrations`: a whole number written as a string. */
export function readMigrations(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,5}$/.test(text.trim())) return null;
  return Number(text.trim());
}

/** `lolly.tools/migration-classes`: `additive=<n>,maintenance=<n>`. */
export function readMigrationClasses(value: unknown): MigrationClasses | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*additive=(\d{1,5})\s*,\s*maintenance=(\d{1,5})\s*$/.exec(value);
  return m ? { additive: Number(m[1]), maintenance: Number(m[2]) } : null;
}

/** `artifacthub.io/changes`: YAML, either a list of strings or of { kind, description }. */
export function readChanges(value: unknown): FeedChange[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_CHANGES_TEXT) return [];
    try { list = parse(value, FEED_YAML); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: FeedChange[] = [];
  for (const item of list) {
    if (out.length >= MAX_CHANGES) break;
    const raw = typeof item === 'string' ? { description: item } : item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!raw || typeof raw.description !== 'string') continue;
    const description = plain(raw.description, MAX_CHANGE_CHARS);
    if (!description) continue;
    const kind = typeof raw.kind === 'string' && (CHANGE_KINDS as readonly string[]).includes(raw.kind.toLowerCase())
      ? raw.kind.toLowerCase() as ChangeKind : 'changed';
    out.push({ kind, description });
  }
  return out;
}

function created(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' && value.length <= 64 ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function chartEntries(doc: unknown, chart: string): unknown[] | null {
  const index = doc && typeof doc === 'object' ? doc as Record<string, unknown> : null;
  const entries = index?.entries && typeof index.entries === 'object' && !Array.isArray(index.entries)
    ? (index.entries as Record<string, unknown>)[chart] : undefined;
  return index?.apiVersion === 'v1' && Array.isArray(entries) ? entries : null;
}

/** Every YAML parse the feed needs: the index, then each kept entry's highlights,
 *  which are YAML inside a string. Plain data out, so a worker thread can run it
 *  (feed-worker.ts) and hand the result back. */
export function parseFeedYaml(text: string, chart = CHART_NAME): unknown {
  let doc: unknown;
  try { doc = parse(text, FEED_YAML); }
  catch { throw new FeedError('invalid', 'The release feed is not valid YAML.'); }
  for (const entry of chartEntries(doc, chart)?.slice(0, MAX_ENTRIES) ?? []) {
    const a = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).annotations as Record<string, unknown> | undefined : undefined;
    if (a && typeof a === 'object' && typeof a['artifacthub.io/changes'] === 'string') a['artifacthub.io/changes'] = readChanges(a['artifacthub.io/changes']);
  }
  return doc;
}

/** Parse a Helm repository index into this chart's releases, newest first. */
export function parseChartIndex(text: string, chart = CHART_NAME): FeedRelease[] {
  return releasesFromIndex(parseFeedYaml(text, chart), chart);
}

/** The releases a parsed index lists for this chart, newest first. */
export function releasesFromIndex(doc: unknown, chart = CHART_NAME): FeedRelease[] {
  const index = doc && typeof doc === 'object' ? doc as Record<string, unknown> : null;
  const entries = index?.entries && typeof index.entries === 'object' && !Array.isArray(index.entries)
    ? (index.entries as Record<string, unknown>)[chart] : undefined;
  if (index?.apiVersion !== 'v1' || !Array.isArray(entries)) throw new FeedError('invalid', `The release feed is not a Helm repository index listing ${chart}.`);
  const seen = new Set<string>();
  const releases: Array<FeedRelease & { semver: Semver }> = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.name !== chart || e.deprecated === true) continue;
    const semver = parseSemver(e.version);
    if (!semver || seen.has(e.version as string)) continue;
    seen.add(e.version as string);
    const a = e.annotations && typeof e.annotations === 'object' && !Array.isArray(e.annotations) ? e.annotations as Record<string, unknown> : {};
    const migrations = readMigrations(a['lolly.tools/migrations']);
    releases.push({
      semver,
      version: e.version as string,
      appVersion: typeof e.appVersion === 'string' && e.appVersion.length <= 64 ? plain(e.appVersion, 64) || null : null,
      created: created(e.created),
      prerelease: semver.pre.length > 0 || flag(a['artifacthub.io/prerelease']),
      security: flag(a['artifacthub.io/containsSecurityUpdates']),
      migrations,
      migrationClasses: migrations === null ? null : readMigrationClasses(a['lolly.tools/migration-classes']),
      notesUrl: httpsUrl(a['lolly.tools/release-notes']),
      changes: readChanges(a['artifacthub.io/changes']),
    });
  }
  return releases.sort((x, y) => compareSemver(y.semver, x.semver)).map(({ semver: _semver, ...release }) => release);
}

/** Releases newer than `current` on this channel, newest first, all of them: an
 *  upgrade runs every one's migrations, so what they say is read across the whole
 *  span and only the list shown is shortened. `stable` skips pre-releases; `preview`
 *  includes them. An unreadable current version has nothing to compare with, so
 *  nothing is newer. */
export function newerReleases(releases: FeedRelease[], current: string, channel: UpdateChannel): FeedRelease[] {
  const base = parseSemver(current);
  if (!base) return [];
  return releases
    .filter(r => (channel === 'preview' || !r.prerelease))
    .map(r => ({ r, v: parseSemver(r.version)! }))
    .filter(({ v }) => compareSemver(v, base) > 0)
    .sort((x, y) => compareSemver(y.v, x.v))
    .map(({ r }) => r);
}
