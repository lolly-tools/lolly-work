#!/usr/bin/env node
/**
 * Software Bill of Materials (SBOM) generator for the control plane.
 *
 *   node scripts/build-sbom.ts           # (re)write sbom.cdx.json
 *   node scripts/build-sbom.ts --check   # regenerate in memory, exit 1 on drift
 *
 * Emits a CycloneDX 1.5 SBOM at `sbom.cdx.json` describing the third-party npm
 * packages the control plane actually ships. Same self-contained philosophy as
 * the OSS repo's scripts/build-sbom.ts: read the npm lockfile (the install's
 * own source of truth), no network, no new dependency.
 *
 * Two deliberate departures from the OSS generator:
 *   - Dev-only packages are OMITTED entirely, not tagged with a custom
 *     `cdx:npm:package:development` property. The OSS tagging approach meant a
 *     consumer had to know our property convention to filter to "what runs in
 *     production"; the CycloneDX-standard answer is the component `scope`
 *     field, and for a deployed service the simplest correct scope story is to
 *     ship only `required` components and leave dev tooling out of the BOM.
 *   - No `metadata.timestamp` at all. The OSS generator carried the previous
 *     timestamp forward while components were unchanged, which still churned on
 *     the first regeneration after any change and made `--check` need diff
 *     exceptions. Omitting the (optional) field makes the output a pure
 *     function of the lockfile + node_modules licenses, so `--check` is a
 *     byte-for-byte compare. `serialNumber` is a content hash for the same
 *     reason.
 *
 * License resolution: the lockfile's per-package `license` field when present,
 * else the installed package's own node_modules/<name>/package.json (covers the
 * packages npm didn't copy the field through for). Unresolvable licenses are
 * warned about, never fatal — a gap should be visible, not block the build.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── CycloneDX component shapes (partial — only the fields this tool emits) ───
interface Hash {
  alg: string;
  content: string;
}
interface LicenseChoice {
  license?: { id?: string; name?: string };
  expression?: string;
}
interface ExternalReference {
  type: string;
  url: string;
}
interface Component {
  type: string;
  'bom-ref': string;
  name: string;
  version?: string;
  purl: string;
  scope?: string;
  licenses?: LicenseChoice[];
  hashes?: Hash[];
  externalReferences?: ExternalReference[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'sbom.cdx.json');
const CHECK = process.argv.includes('--check');

const rootPkg = readJson('package.json');
const lock = readJson('package-lock.json');

// ─── SRI integrity → CycloneDX hashes ───────────────────────────────────────
// Lockfile integrity is base64 SRI ("sha512-<base64>"); CycloneDX wants the
// digest hex-encoded with a canonical algorithm name.
const ALG_NAMES: Record<string, string> = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

function hashesFromIntegrity(integrity: unknown): Hash[] | undefined {
  if (!integrity || typeof integrity !== 'string') return undefined;
  const hashes: Hash[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf('-');
    if (dash === -1) continue;
    const alg = ALG_NAMES[token.slice(0, dash)];
    if (!alg) continue;
    const content = Buffer.from(token.slice(dash + 1), 'base64').toString('hex');
    if (content) hashes.push({ alg, content });
  }
  return hashes.length ? hashes : undefined;
}

// ─── License string → CycloneDX licenses[] entry ────────────────────────────
// A bare token ("MIT") is an SPDX id; anything with boolean operators or parens
// is an expression and must go in `expression`, not wrapped in `license`.
function licensesFromString(license: unknown): LicenseChoice[] | undefined {
  if (!license || typeof license !== 'string') return undefined;
  const looksLikeExpression = /\bOR\b|\bAND\b|\bWITH\b|[()]/.test(license);
  if (looksLikeExpression) return [{ expression: license }];
  // npm's proprietary marker is not an SPDX id — record it as a plain name.
  if (license === 'UNLICENSED') return [{ license: { name: license } }];
  // SPDX ids are a constrained charset; fall back to `name` for anything odd.
  const isIdLike = /^[A-Za-z0-9.+-]+$/.test(license);
  return [{ license: isIdLike ? { id: license } : { name: license } }];
}

// purl for an npm package; scope's leading '@' is percent-encoded per the spec.
function purlFor(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

// ─── Collect runtime components from the lockfile ────────────────────────────
const byPurl = new Map<string, Component>(); // purl → component (dedupes hoisted/nested duplicates)

for (const [path, entry] of Object.entries(lock.packages ?? {}) as [string, any][]) {
  if (!path.includes('node_modules/')) continue; // root + vendor package dirs
  if (entry.link) continue;                      // vendor/ symlink, covered by THIRD-PARTY-NOTICES.md
  if (!entry.version) continue;                  // nothing installable to describe
  if (entry.dev) continue;                       // dev tooling — deliberately not in the BOM (see header)

  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const purl = purlFor(name, entry.version);
  if (byPurl.has(purl)) continue;

  const component: Component = {
    type: 'library',
    'bom-ref': purl,
    name,
    version: entry.version,
    purl,
    scope: 'required',
  };
  // Lockfile license first (what npm recorded at install), the installed
  // package's own manifest as fallback.
  const licenses =
    licensesFromString(entry.license) ??
    licensesFromString(readJsonOptional(join(path, 'package.json'))?.license);
  if (licenses) component.licenses = licenses;
  const hashes = hashesFromIntegrity(entry.integrity);
  if (hashes) component.hashes = hashes;
  if (entry.resolved) {
    component.externalReferences = [{ type: 'distribution', url: entry.resolved }];
  }
  byPurl.set(purl, component);
}

const components = [...byPurl.values()].sort((a, b) => a.purl.localeCompare(b.purl));

// ─── Describe the thing the SBOM is *for* (the control plane itself) ─────────
const subjectVersion = rootPkg.version ?? '0.0.0';
const subjectPurl = purlFor(rootPkg.name ?? 'lolly-work', subjectVersion);
const subject: Component = {
  type: 'application',
  'bom-ref': subjectPurl,
  name: rootPkg.name ?? 'lolly-work',
  version: subjectVersion,
  purl: subjectPurl,
  ...(licensesFromString(rootPkg.license) ? { licenses: licensesFromString(rootPkg.license) } : {}),
};

// ─── Deterministic identity ──────────────────────────────────────────────────
// serialNumber is a content hash shaped as a UUID; there is no timestamp field
// (see header), so the whole document is reproducible from the inputs.
const fingerprint = createHash('sha256')
  .update(JSON.stringify(components.map((c) => [c.purl, c.hashes])))
  .digest('hex');
const serialNumber = `urn:uuid:${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-8${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber,
  version: 1,
  metadata: {
    tools: [{ vendor: 'lolly', name: 'build-sbom', version: subjectVersion }],
    component: subject,
  },
  components,
};

const output = JSON.stringify(bom, null, 2) + '\n';

if (CHECK) {
  const committed = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null;
  if (committed !== output) {
    console.error('✗ sbom.cdx.json is stale — run `npm run sbom` and commit the result.');
    process.exit(1);
  }
  console.log(`✓ sbom.cdx.json is up to date (${components.length} runtime components)`);
} else {
  writeFileSync(OUT_PATH, output);
  console.log(`✓ Wrote sbom.cdx.json — ${components.length} runtime components (dev deps omitted)`);
}

// ─── Surface license gaps without failing the build ──────────────────────────
const unlicensed = [subject, ...components].filter(
  (c) => !Array.isArray(c.licenses) || c.licenses.length === 0,
);
if (unlicensed.length) {
  console.warn(`⚠ ${unlicensed.length} component(s) without license metadata:`);
  for (const c of unlicensed) console.warn(`    ${c.purl}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}
function readJsonOptional(rel: string): any {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
