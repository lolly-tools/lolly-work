// SPDX-License-Identifier: MPL-2.0
/**
 * The console's revision: one SHA-256 over index.html (with its own entry URLs
 * normalized) and every other console file, by sorted path. scripts/console-assets.ts
 * writes it into index.html as the `?v=` of the two entry URLs, and the server
 * (api/console-delivery.ts) recomputes it before it calls an entry immutable.
 * Both import this module, so the two can never disagree about the algorithm.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Point the two entry URLs at `revision`, or strip any revision when none is given. */
export function entryUrls(html: string, revision?: string): string {
  let scripts = 0, styles = 0;
  const suffix = revision ? `?v=${revision}` : '';
  const normalized = html
    .replace(/(<script\b[^>]*\bsrc=")(\/admin\/app(?:-[a-f0-9]{12,64})?\.js(?:\?[^"\s]*)?)(")/g,
      (_all, before: string, _url: string, after: string) => { scripts++; return `${before}/admin/app.js${suffix}${after}`; })
    .replace(/(<link\b[^>]*\bhref=")(\/admin\/styles(?:-[a-f0-9]{12,64})?\.css(?:\?[^"\s]*)?)(")/g,
      (_all, before: string, _url: string, after: string) => { styles++; return `${before}/admin/styles.css${suffix}${after}`; });
  if (scripts !== 1 || styles !== 1) throw new Error('Console HTML must reference exactly one app.js entry and styles.css stylesheet');
  return normalized;
}

function assetFiles(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix)).sort().flatMap(name => {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, rel));
    if (stat.isSymbolicLink()) throw new Error(`Console asset must be a regular file: ${rel}`);
    if (stat.isDirectory()) return assetFiles(dir, rel);
    if (!stat.isFile()) throw new Error(`Console asset must be a regular file: ${rel}`);
    if (/-[a-f0-9]{12,64}\.(?:js|css)$/.test(name)) throw new Error(`Remove obsolete copied console asset: ${rel}`);
    return rel === 'index.html' ? [] : [rel];
  });
}

function verifyLocalAssets(html: string, files: string[], read: (rel: string) => Buffer): void {
  const available = new Set(files);
  const check = (ref: string, from: string) => {
    const url = new URL(ref, `https://console.invalid/admin/${from}`);
    if (url.origin !== 'https://console.invalid' || ref.startsWith('#')) return;
    if (!url.pathname.startsWith('/admin/')) throw new Error(`Console asset escapes /admin/: ${ref}`);
    const rel = decodeURIComponent(url.pathname.slice('/admin/'.length));
    if (!available.has(rel)) throw new Error(`Missing console asset: ${rel} (from ${from})`);
  };
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)) check(match[1]!, 'index.html');
  for (const rel of files.filter(file => file.endsWith('.css'))) {
    const css = read(rel).toString('utf8');
    for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) check(match[1]!, rel);
  }
}

/** One read of the whole console tree: the revision, the HTML that names it, the
 *  index.html actually on disk, and the bytes every other file had when hashed. */
export interface ConsoleSnapshot {
  revision: string;
  /** index.html as console:build writes it for this revision. */
  html: string;
  /** index.html as it is on disk. */
  source: string;
  files: string[];
  bytes: ReadonlyMap<string, Buffer>;
}

export function consoleSnapshot(dir: string): ConsoleSnapshot {
  const source = readFileSync(join(dir, 'index.html'), 'utf8');
  const html = entryUrls(source);
  const files = assetFiles(dir);
  const bytes = new Map<string, Buffer>();
  const read = (rel: string): Buffer => { let value = bytes.get(rel); if (!value) bytes.set(rel, value = readFileSync(join(dir, rel))); return value; };
  verifyLocalAssets(html, files, read);
  const hash = createHash('sha256');
  // Length framing, sorted relative paths and raw bytes make this independent of
  // directory order, timestamps and checkout location. Normalize our own URLs
  // first so a previous revision never becomes an input to the next revision.
  for (const [name, content] of [['index.html', Buffer.from(html)], ...files.map(file => [file, read(file)] as const)] as const) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`).update(content);
  }
  const revision = hash.digest('hex');
  return { revision, html: entryUrls(html, revision), source, files, bytes };
}

export function consoleAssetPlan(dir: string): { revision: string; html: string; files: string[] } {
  const { revision, html, files } = consoleSnapshot(dir);
  return { revision, html, files };
}
