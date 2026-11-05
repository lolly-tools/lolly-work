// SPDX-License-Identifier: MPL-2.0
/**
 * `lw brand-pages`: publish a brand page folder to this instance, list what is
 * published, read a page's history and take one down.
 *
 * `publish` checks the folder here first, with the same rules the server applies,
 * so a wrong folder fails before anything is sent. Only files brand.json lists are
 * sent. A stray file beside them stays on this machine. Sending goes through the
 * resumable upload, so running the same command again after an interruption sends
 * only the missing parts.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { MAX_MANIFEST_BYTES } from '../server/src/brand-pages/bundle.ts';
import { brandPageDigest, parseBrandPageManifest, type BrandPageManifest } from '../server/src/brand-pages/manifest.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';
import { fileSource, fileStateStore, resumableUpload, type UploadResult } from './upload-client.ts';

export interface BrandPagesCli {
  values: Record<string, unknown>;
  base: string;
  stateDir: string;
  /** Credentials and client identification, as the other commands send them. */
  headers(): Record<string, string>;
  call(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown>;
  fail(message: string): never;
  log(line: string): void;
  out(value: unknown): void;
  progress?(sent: number, total: number): void;
}

/** A fixed stamp, so the same folder makes the same bytes and a retry resumes its upload. */
const ZIP_STAMP = new Date('2026-01-01T00:00:00Z');

interface PageWire { slug: string; name: string; url: string; state: string; current: number | null; pending: number | null; revision?: { n: number; digest: string } }
interface RevisionWire { n: number; state: string; digest: string; size: number; fileCount: number; publishedByName: string | null; publishedBy: string; createdAt: string; liveAt: string | null; bytesRemovedAt: string | null }

/** The folder's manifest and each listed file, proved against it. Throws with the reason. */
export function readFolder(dir: string): { manifest: BrandPageManifest; manifestBytes: Buffer; root: string } {
  const root = realpathSync(dir);
  const manifestPath = join(root, 'brand.json');
  if (!lstatSync(manifestPath).isFile()) throw new Error('brand.json must be a plain file');
  if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error('brand.json is too large');
  const manifestBytes = readFileSync(manifestPath);
  const parsed = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const manifest = parseBrandPageManifest(parsed);
  if (brandPageDigest(parsed) !== manifest.digest) throw new Error('brand.json does not match its own digest. Publish the folder again from Lolly.');
  return { manifest, manifestBytes, root };
}

/** Writes the bundle to `target`, reading each listed file once and checking it. */
export function writeBundle(folder: ReturnType<typeof readFolder>, target: string): void {
  const zip = new ZipBuilder(ZIP_STAMP);
  const fd = openSync(target, 'w', 0o600);
  try {
    for (const file of folder.manifest.files) {
      const path = join(folder.root, file.path);
      // A link could reach outside the folder, so it is refused rather than followed.
      if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(folder.root + sep)) throw new Error(`${file.path} is not a plain file inside the folder`);
      const bytes = readFileSync(path);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`${file.path} does not match brand.json`);
      writeSync(fd, zip.add(file.path, bytes));
    }
    writeSync(fd, zip.add('brand.json', folder.manifestBytes));
    writeSync(fd, zip.end());
  } finally { closeSync(fd); }
}

const pageLine = (page: PageWire): string => {
  const state = page.state === 'live' ? `live, revision ${page.current}`
    : page.state === 'pending' ? `waiting for approval, revision ${page.pending}`
    : page.state === 'unpublished' ? 'unpublished' : 'not published';
  return `${page.slug}  ${state}  ${page.name}  ${page.url}`;
};

async function publish(dir: string, cli: BrandPagesCli): Promise<void> {
  let folder: ReturnType<typeof readFolder>;
  try { folder = readFolder(dir); }
  catch (error) { return cli.fail(`cannot publish ${dir}: ${(error as Error).message}`); }
  const scratch = mkdtempSync(join(tmpdir(), 'lw-brand-page-'));
  const bundle = join(scratch, `${folder.manifest.id}.zip`);
  try {
    try { writeBundle(folder, bundle); }
    catch (error) { return cli.fail(`cannot publish ${dir}: ${(error as Error).message}`); }
    const source = await fileSource(bundle);
    let sent: UploadResult;
    try {
      sent = await resumableUpload({
        base: cli.base, target: { kind: 'upload', scope: 'brand-page' }, source, state: fileStateStore(cli.stateDir),
        name: `${folder.manifest.id}.zip`, contentType: 'application/zip', headers: cli.headers(), onProgress: cli.progress,
      });
    } catch (error) { return cli.fail(`could not send the bundle: ${(error as Error).message}`); }
    finally { await source.close(); }
    const answer = await cli.call('/api/v1/brand-pages', { method: 'POST', body: { uploadId: sent.id, checksum: sent.checksum } }) as { page: PageWire; unchanged?: boolean; approvalId?: string };
    cli.out(answer);
    if (cli.values.json) return;
    if (answer.unchanged) cli.log(`no change: this revision is already live at ${answer.page.url}`);
    else if (answer.approvalId) cli.log(`waiting for approval: ${answer.approvalId}. Nothing is public until a reviewer approves it.`);
    else cli.log(`published: ${answer.page.url}`);
    cli.log(pageLine(answer.page));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function runBrandPages(sub: string | undefined, positional: string | undefined, cli: BrandPagesCli): Promise<void> {
  if (sub === 'publish') return publish(positional ?? cli.fail('usage: lw brand-pages publish <folder>'), cli);
  if (sub === 'list' || sub === undefined) {
    const answer = await cli.call('/api/v1/brand-pages') as { pages: PageWire[]; limits: { usedBytes: number; instanceBudgetBytes: number } };
    cli.out(answer);
    if (cli.values.json) return;
    if (!answer.pages.length) cli.log('no brand pages');
    for (const page of answer.pages) cli.log(pageLine(page));
    return;
  }
  if (sub === 'history') {
    const slug = positional ?? cli.fail('usage: lw brand-pages history <slug>');
    const answer = await cli.call(`/api/v1/brand-pages/${encodeURIComponent(slug)}/revisions`) as { page: PageWire; revisions: RevisionWire[] };
    cli.out(answer);
    if (cli.values.json) return;
    cli.log(pageLine(answer.page));
    for (const row of answer.revisions) {
      cli.log(`  ${row.n}  ${row.state}  ${row.createdAt}  ${row.publishedByName ?? row.publishedBy}  ${row.fileCount} files  ${row.digest.slice(0, 16)}${row.bytesRemovedAt ? '  files removed' : ''}`);
    }
    return;
  }
  if (sub === 'unpublish') {
    const slug = positional ?? cli.fail('usage: lw brand-pages unpublish <slug> [--remove-files]');
    const answer = await cli.call(`/api/v1/brand-pages/${encodeURIComponent(slug)}/unpublish`, { method: 'POST', body: { removeFiles: cli.values['remove-files'] === true } }) as { page: PageWire; changed: boolean; removedRevisions: number };
    cli.out(answer);
    if (cli.values.json) return;
    cli.log(answer.changed ? `unpublished: ${answer.page.url} now answers 410` : `${slug} was not live`);
    if (answer.removedRevisions) cli.log(`removed the files of ${answer.removedRevisions} revisions; the history stays`);
    return;
  }
  cli.fail('usage: lw brand-pages [list] · publish <folder> · history <slug> · unpublish <slug> [--remove-files]');
}
