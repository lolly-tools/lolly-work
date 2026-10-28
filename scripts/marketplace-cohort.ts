// SPDX-License-Identifier: MPL-2.0
// Pin deploy/marketplaces/release.json to a published Work release and its web app archive,
// then regenerate every file derived from it. Nothing in release.json is typed by hand:
//
//   node scripts/marketplace-cohort.ts --version 1.1.3 \
//     --shell-url https://lolli.li/lolly-web-1.1.3-ynh1.tar.gz [--shell-file ./lolly-web-1.1.3-ynh1.tar.gz]
//
// The server and worker digests and sources come from the Work release's
// release-source-images.json (--evidence takes a local copy instead). The archive is read
// from --shell-file, or downloaded from --shell-url; its checksum, sizes, the catalogue key
// its web app pins and its signed catalogue sequence are read from the bytes. The archive
// must already be at --shell-url before the package is published, because installations
// download it from there.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_FILE = join(root, 'deploy/marketplaces/release.json');
const SERVER = 'ghcr.io/lolly-tools/lolly-work-server';
const WORKER = 'ghcr.io/lolly-tools/lolly-work-render-worker';
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, COORDINATE = '[A-Za-z0-9_-]{43}';

export interface PublicKey { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export interface ShellFacts { url: string; sha256: string; archiveBytes: number; expandedBytes: number; pinnedKeys: PublicKey[]; envelope: { keyId?: unknown; seq?: unknown } }

/** RFC 7638 thumbprint, the form the catalogue envelope's keyId takes. */
export function keyId(key: PublicKey): string {
  return createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('base64url');
}

/** Every catalogue key a built web app script pins. */
export function pinnedKeys(source: string): PublicKey[] {
  const pattern = new RegExp(`\\{"kty":"EC","crv":"P-256","x":"(${COORDINATE})","y":"(${COORDINATE})"\\}`, 'g');
  return [...source.matchAll(pattern)].map(([, x, y]) => ({ kty: 'EC', crv: 'P-256', x: x!, y: y! }));
}

/** The next release.json, from the previous one, the Work release evidence and the archive's facts. */
export function nextCohort(previous: Record<string, unknown>, version: string, evidence: Record<string, any>, shell: ShellFacts, evidenceUrl: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use --version x.y.z');
  if (evidence.releaseTag !== `v${version}` || evidence.packageVersion !== version) throw new Error(`The evidence describes ${evidence.releaseTag}, not v${version}`);
  if (!COMMIT.test(evidence.source) || !COMMIT.test(evidence.lollySource)) throw new Error('The evidence names no Work and Lolly sources');
  const image = (repository: string) => {
    const rows = (evidence.images ?? []).filter((row: { image?: string }) => row.image?.startsWith(repository + '@sha256:'));
    const platforms: Array<{ architecture?: string; sourceLabel?: string }> = rows[0]?.platforms ?? [];
    // Every platform image must be built from the release source; arm64 and amd64 both ship.
    if (rows.length !== 1 || rows[0].signatureVerified !== true || !/^(ghcr\.io\/\S+)@sha256:[a-f0-9]{64}$/.test(rows[0].image)
      || platforms.map(p => p.architecture).sort().join() !== 'amd64,arm64' || platforms.some(p => p.sourceLabel !== evidence.source)) {
      throw new Error(`The evidence has no single verified amd64 and arm64 ${repository} image built from ${evidence.source}`);
    }
    return rows[0].image as string;
  };
  if (!/^https:\/\/[^?#]+\.tar\.gz$/.test(shell.url) || !HASH.test(shell.sha256)) throw new Error('Pin the archive by an https URL and its SHA-256');
  const keys = new Set(shell.pinnedKeys.map(key => JSON.stringify(key)));
  if (keys.size !== 1) throw new Error(`The web app must pin exactly one catalogue key; found ${keys.size}`);
  const sourceCatalogPublicKey = shell.pinnedKeys[0]!;
  if (shell.envelope.keyId !== keyId(sourceCatalogPublicKey)) throw new Error('The signed catalogue was not signed by the key the web app pins');
  const seq = shell.envelope.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error('The signed catalogue carries no positive sequence');
  // The server keeps the higher of this pin and the envelope's sequence, and refuses a new
  // publication at a generation it has recorded, so an updated installation needs a higher one.
  const before = previous.shell as { sha256?: string } | undefined, generation = Number(previous.catalogGeneration ?? 0);
  const catalogGeneration = before?.sha256 === shell.sha256 ? generation : Math.max(generation + 1, seq as number);
  return {
    schemaVersion: 1, version, workSource: evidence.source, lollySource: evidence.lollySource, releaseEvidence: evidenceUrl,
    serverImage: image(SERVER), workerImage: image(WORKER),
    postgresImage: previous.postgresImage, caddyImage: previous.caddyImage,
    shell: { url: shell.url, sha256: shell.sha256, archiveBytes: shell.archiveBytes, expandedBytes: shell.expandedBytes },
    catalogGeneration, sourceCatalogPublicKey,
    qualifiedArchitectures: previous.qualifiedArchitectures, modelOrigin: previous.modelOrigin,
  };
}

/** Checksum, sizes, pinned keys and catalogue envelope of a web app archive on disk. */
export async function shellFacts(file: string, url: string): Promise<ShellFacts> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  // GNU tar prints the size in the third column of a verbose listing, bsdtar in the fifth.
  const sizeColumn = /GNU tar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' })) ? 2 : 4;
  const tar = (flags: string) => execFileSync('tar', [flags, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
  const names = tar('-tzf');
  let expandedBytes = 0;
  for (const line of tar('-tzvf')) {
    const fields = line.trim().split(/\s+/);
    if (!/^[-d]/.test(fields[0] ?? '')) throw new Error('The archive holds a link or special file');
    if (fields[0]!.startsWith('-')) expandedBytes += Number(fields[sizeColumn]);
  }
  const boot = names.filter(name => /^(\.\/)?_app\/[^/]+\.js$/.test(name));
  const envelopeName = names.find(name => /^(\.\/)?catalog\/tools\/index\.sig\.json$/.test(name));
  if (!envelopeName || !boot.some(name => /\/web-boot-[^/]+\.js$/.test(name))) throw new Error('The archive is not a built Lolly web app');
  const directory = mkdtempSync(join(tmpdir(), 'lolly-cohort-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', directory, envelopeName, ...boot]);
    const pinned = boot.flatMap(name => pinnedKeys(readFileSync(join(directory, name), 'utf8')));
    return { url, sha256, archiveBytes: statSync(file).size, expandedBytes, pinnedKeys: pinned, envelope: JSON.parse(readFileSync(join(directory, envelopeName), 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function download(url: string, file: string) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file, { flags: 'wx' }));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, 'shell-url': { type: 'string' }, 'shell-file': { type: 'string' }, evidence: { type: 'string' } } });
  if (!values.version || !values['shell-url']) throw new Error('Usage: node scripts/marketplace-cohort.ts --version x.y.z --shell-url URL [--shell-file FILE] [--evidence FILE]');
  const evidenceUrl = `https://github.com/lolly-tools/lolly-work/releases/download/v${values.version}/release-source-images.json`;
  const evidence = values.evidence ? JSON.parse(readFileSync(values.evidence, 'utf8'))
    : await (async () => { const r = await fetch(evidenceUrl); if (!r.ok) throw new Error(`${evidenceUrl} answered ${r.status}`); return r.json(); })();
  const scratch = mkdtempSync(join(tmpdir(), 'lolly-shell-'));
  try {
    const file = values['shell-file'] ?? join(scratch, 'shell.tar.gz');
    if (!values['shell-file']) await download(values['shell-url'], file);
    const previous = JSON.parse(readFileSync(RELEASE_FILE, 'utf8'));
    const next = nextCohort(previous, values.version, evidence, await shellFacts(file, values['shell-url']), evidenceUrl);
    writeFileSync(RELEASE_FILE, JSON.stringify(next, null, 2).replace(/\[\n\s+"amd64",\n\s+"arm64"\n\s+\]/, '["amd64", "arm64"]') + '\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // marketplace-packages.ts reads release.json when it loads, so regenerate in fresh processes.
  for (const script of ['scripts/marketplace-packages.ts', 'scripts/marketplace-channels.ts']) execFileSync(process.execPath, [join(root, script)], { stdio: 'inherit' });
  console.log(`Pinned Work ${values.version}. Review the diff, then run the package tests and qualify the cohort (deploy/marketplaces/README.md).`);
}
