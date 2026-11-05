// SPDX-License-Identifier: MPL-2.0
/**
 * The brand page manifest, `brand.json` (BrandPageV1 in Lolly's @lolly-tools/core,
 * schemas/brand-page-v1.schema.json). This server stores and serves a folder that a
 * shell or the CLI made. It never generates one, so it needs no engine re-pin and
 * keeps this small parser, which follows the schema key by key.
 *
 * A bundle comes from outside. So beyond the schema this file holds what the folder
 * layout allows: which paths each role may use, which file types they may be, and
 * the media type each is served as. The manifest's own media type is never trusted.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../lib/crypto.ts';

export const BRAND_PAGE_ROLES = [
  'page', 'page-markdown', 'page-style', 'design-md', 'design-md-variant', 'agents', 'llms', 'checks', 'tokens', 'tokens-resolved', 'logo', 'font', 'skill', 'example',
] as const;
export type BrandPageRole = typeof BRAND_PAGE_ROLES[number];

export interface BrandPageFile { path: string; role: BrandPageRole; mediaType: string; sha256: string; size: number }
export interface BrandPageHeld { item: string; reason: string; kind: 'policy' | 'licence' | 'unknown' | 'content' | 'limit' }
export interface BrandPageManifest {
  version: 1;
  id: string;
  name: string;
  revision: string;
  publishedVersion?: string;
  origin?: string;
  generator: { name: 'lolly'; engine: string; designMd: 'alpha' };
  usage?: { statement?: string; contact?: string; url?: string };
  colourways: { id: string; name: string; modes: string[] }[];
  files: BrandPageFile[];
  held: BrandPageHeld[];
  checks: { file: 'checks.json'; variants: number; pairs: number; pairsBelow3: number; rules: number; rulesWithFindings: number };
  publishedAt?: string;
  digest: string;
}

/** A bundle this server will not take, with a stable code a client can act on. */
export class BrandPageRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const refuse = (message: string): never => { throw new BrandPageRefusal('MANIFEST_INVALID', message); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-z0-9][a-z0-9-]*$/;
const HEX = /^[0-9a-f]{64}$/;
/** JSON Schema counts characters, not UTF-16 units. */
const length = (value: string): number => [...value].length;

export const isBrandPageSlug = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && value.length <= 48;

function keys(value: Record<string, unknown>, where: string, allowed: readonly string[], required: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`${where} has an unknown key: ${key.slice(0, 60)}`);
  for (const key of required) if (value[key] === undefined) refuse(`${where} needs ${key}`);
}
function text(value: unknown, where: string, max: number, min = 0): string {
  if (typeof value !== 'string' || length(value) > max || length(value) < min) refuse(`${where} must be text of ${min === 0 ? 'at most' : `${min} to`} ${max} characters`);
  return value as string;
}
function pattern(value: unknown, where: string, rule: RegExp, max: number): string {
  const checked = text(value, where, max);
  if (!rule.test(checked)) refuse(`${where} is not in the expected form`);
  return checked;
}
function count(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) refuse(`${where} must be a whole number`);
  return value as number;
}

/** Strict, as the schema is: an unknown key anywhere is refused, so the digest
 *  covers everything the manifest says. */
export function parseBrandPageManifest(value: unknown): BrandPageManifest {
  if (!isObject(value)) return refuse('brand.json must be an object');
  keys(value, 'brand.json', ['version', 'id', 'name', 'revision', 'publishedVersion', 'origin', 'generator', 'usage', 'colourways', 'files', 'held', 'checks', 'publishedAt', 'digest'],
    ['version', 'id', 'name', 'revision', 'generator', 'colourways', 'files', 'held', 'checks', 'digest']);
  if (value.version !== 1) refuse('this server reads brand.json version 1');
  const generator = value.generator;
  if (!isObject(generator)) return refuse('generator must be an object');
  keys(generator, 'generator', ['name', 'engine', 'designMd'], ['name', 'engine', 'designMd']);
  if (generator.name !== 'lolly' || generator.designMd !== 'alpha') refuse('generator is not one this server reads');
  text(generator.engine, 'generator.engine', 40);
  const usage = value.usage;
  if (usage !== undefined) {
    if (!isObject(usage)) return refuse('usage must be an object');
    keys(usage, 'usage', ['statement', 'contact', 'url']);
    if (usage.statement !== undefined) text(usage.statement, 'usage.statement', 8000);
    if (usage.contact !== undefined) text(usage.contact, 'usage.contact', 400);
    if (usage.url !== undefined) pattern(usage.url, 'usage.url', /^https?:\/\//, 2000);
  }
  const colourways = value.colourways;
  if (!Array.isArray(colourways) || colourways.length < 1 || colourways.length > 64) return refuse('colourways must list 1 to 64 entries');
  for (const way of colourways) {
    if (!isObject(way)) return refuse('a colourway must be an object');
    keys(way, 'a colourway', ['id', 'name', 'modes'], ['id', 'name', 'modes']);
    pattern(way.id, 'a colourway id', ID, 64);
    text(way.name, 'a colourway name', 200);
    if (!Array.isArray(way.modes) || way.modes.length < 1 || way.modes.length > 8) return refuse('a colourway must list 1 to 8 modes');
    for (const mode of way.modes) pattern(mode, 'a colourway mode', ID, 64);
  }
  const files = value.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 4096) return refuse('files must list 1 to 4096 entries');
  for (const file of files) {
    if (!isObject(file)) return refuse('a file entry must be an object');
    keys(file, 'a file entry', ['path', 'role', 'mediaType', 'sha256', 'size'], ['path', 'role', 'mediaType', 'sha256', 'size']);
    if (typeof file.path !== 'string') return refuse('a file path must be text');
    text(file.mediaType, 'a file media type', 120);
    pattern(file.sha256, 'a file sha256', HEX, 64);
    count(file.size, 'a file size');
  }
  const held = value.held;
  if (!Array.isArray(held) || held.length > 4096) return refuse('held must list at most 4096 entries');
  for (const row of held) {
    if (!isObject(row)) return refuse('a held entry must be an object');
    keys(row, 'a held entry', ['item', 'reason', 'kind'], ['item', 'reason', 'kind']);
    text(row.item, 'a held item', 300);
    text(row.reason, 'a held reason', 600);
    if (!['policy', 'licence', 'unknown', 'content', 'limit'].includes(row.kind as string)) refuse('a held kind is not one this server reads');
  }
  const checks = value.checks;
  if (!isObject(checks)) return refuse('checks must be an object');
  keys(checks, 'checks', ['file', 'variants', 'pairs', 'pairsBelow3', 'rules', 'rulesWithFindings'], ['file', 'variants', 'pairs', 'pairsBelow3', 'rules', 'rulesWithFindings']);
  if (checks.file !== 'checks.json') refuse('checks.file must be checks.json');
  for (const name of ['variants', 'pairs', 'pairsBelow3', 'rules', 'rulesWithFindings']) count(checks[name], `checks.${name}`);
  pattern(value.id, 'id', ID, 48);
  text(value.name, 'name', 200, 1);
  pattern(value.revision, 'revision', /^sha256:[0-9a-f]{64}$/, 71);
  if (value.publishedVersion !== undefined) text(value.publishedVersion, 'publishedVersion', 200);
  if (value.origin !== undefined) pattern(value.origin, 'origin', /^https?:\/\//, 2000);
  if (value.publishedAt !== undefined) text(value.publishedAt, 'publishedAt', 40);
  pattern(value.digest, 'digest', HEX, 64);
  checkFolder(files as BrandPageFile[]);
  return value as unknown as BrandPageManifest;
}

/** The digest of the canonical manifest, without `digest` and `publishedAt`. */
export function brandPageDigest(manifest: Record<string, unknown>): string {
  const { digest: _digest, publishedAt: _publishedAt, ...body } = manifest;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*';
const DIRECTORIES = `(?:${SEGMENT}/)*`;
/** The folder layout: what each role may be called. Nothing else is accepted, and
 *  only the page itself may be HTML. */
const LAYOUT: Record<BrandPageRole, RegExp> = {
  page: /^index\.html$/,
  'page-markdown': /^index\.md$/,
  'page-style': /^assets\/page\.css$/,
  'design-md': /^DESIGN\.md$/,
  'design-md-variant': new RegExp(`^design/${SEGMENT}\\.DESIGN\\.md$`),
  agents: /^AGENTS\.md$/,
  llms: /^llms\.txt$/,
  checks: /^checks\.json$/,
  tokens: /^tokens\/tokens\.json$/,
  'tokens-resolved': new RegExp(`^tokens/${SEGMENT}\\.tokens\\.json$`),
  logo: new RegExp(`^logos/${DIRECTORIES}${SEGMENT}\\.(?:svg|png|jpe?g|webp|pdf)$`),
  font: new RegExp(`^fonts/${DIRECTORIES}${SEGMENT}\\.(?:woff2?|ttf|otf)$`),
  skill: new RegExp(`^skills/${SEGMENT}/${DIRECTORIES}${SEGMENT}\\.(?:md|json|txt)$`),
  example: new RegExp(`^examples/${DIRECTORIES}${SEGMENT}\\.(?:svg|png)$`),
};
/** What each file is served as, chosen here from its name. */
const SERVED_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
};
export const servedType = (path: string): string => SERVED_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
const bareType = (value: string): string => value.split(';')[0]!.trim().toLowerCase();

/** Every listed file fits the layout, with no path listed twice (in any case) and
 *  the two files a page cannot do without present. Generators list a file with no
 *  known type as application/octet-stream, which says nothing and is allowed. */
function checkFolder(files: BrandPageFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.path;
    if (path.length > 300 || path.split('/').some(part => part === '..' || part === '.' || part === '') || path.startsWith('/') || path.includes('\\')) {
      throw new BrandPageRefusal('BUNDLE_PATH_REFUSED', `a path leaves the folder: ${path.slice(0, 120)}`);
    }
    if (!BRAND_PAGE_ROLES.includes(file.role)) throw new BrandPageRefusal('BUNDLE_ROLE_REFUSED', `unknown file role for ${path.slice(0, 120)}`);
    if (!LAYOUT[file.role].test(path)) throw new BrandPageRefusal('BUNDLE_PATH_REFUSED', `${path.slice(0, 120)} is outside the folder layout for the role ${file.role}`);
    const fold = path.toLowerCase();
    if (seen.has(fold)) throw new BrandPageRefusal('BUNDLE_PATH_REFUSED', `${path.slice(0, 120)} is listed twice`);
    seen.add(fold);
    const stated = bareType(file.mediaType);
    if (stated !== 'application/octet-stream' && stated !== bareType(servedType(path))) {
      throw new BrandPageRefusal('BUNDLE_MEDIA_TYPE_REFUSED', `${path.slice(0, 120)} says it is ${stated.slice(0, 60)}`);
    }
  }
  for (const needed of ['index.html', 'checks.json']) {
    if (!seen.has(needed.toLowerCase())) throw new BrandPageRefusal('BUNDLE_FILE_MISSING', `a brand page needs ${needed}`);
  }
}
