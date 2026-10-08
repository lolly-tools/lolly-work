// SPDX-License-Identifier: MPL-2.0
/** One console source tree; revision URLs replace manually copied bundles. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONSOLE_DIR = fileURLToPath(new URL('../console/', import.meta.url));

function entryUrls(html: string, revision?: string): string {
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

function verifyLocalAssets(dir: string, html: string, files: string[]): void {
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
    const css = readFileSync(join(dir, rel), 'utf8');
    for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) check(match[1]!, rel);
  }
}

export function consoleAssetPlan(dir = CONSOLE_DIR): { revision: string; html: string; files: string[] } {
  const html = entryUrls(readFileSync(join(dir, 'index.html'), 'utf8'));
  const files = assetFiles(dir);
  verifyLocalAssets(dir, html, files);
  const hash = createHash('sha256');
  // Length framing, sorted relative paths and raw bytes make this independent of
  // directory order, timestamps and checkout location. Normalize our own URLs
  // first so a previous revision never becomes an input to the next revision.
  for (const [name, bytes] of [['index.html', Buffer.from(html)], ...files.map(file => [file, readFileSync(join(dir, file))] as const)] as const) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  }
  const revision = hash.digest('hex');
  return { revision, html: entryUrls(html, revision), files };
}

export function checkConsoleAssets(dir = CONSOLE_DIR): string {
  const plan = consoleAssetPlan(dir);
  if (readFileSync(join(dir, 'index.html'), 'utf8') !== plan.html) throw new Error('Console asset revision is stale; run pnpm console:build and commit console/index.html');
  return plan.revision;
}

export function buildConsoleAssets(dir = CONSOLE_DIR): string {
  const plan = consoleAssetPlan(dir);
  if (readFileSync(join(dir, 'index.html'), 'utf8') !== plan.html) writeFileSync(join(dir, 'index.html'), plan.html);
  return plan.revision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/console-assets.ts [--check]');
  const revision = process.argv.includes('--check') ? checkConsoleAssets() : buildConsoleAssets();
  console.log(`PASS console asset revision ${revision}`);
}
