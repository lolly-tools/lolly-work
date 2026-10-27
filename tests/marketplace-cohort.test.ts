// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyId, nextCohort, pinnedKeys, shellFacts, type PublicKey } from '../scripts/marketplace-cohort.ts';

const previous = JSON.parse(readFileSync(new URL('../deploy/marketplaces/release.json', import.meta.url), 'utf8'));
const key: PublicKey = previous.sourceCatalogPublicKey;
const literal = (k: PublicKey) => `{"kty":"EC","crv":"P-256","x":"${k.x}","y":"${k.y}"}`;
const work = 'a'.repeat(40), lolly = 'b'.repeat(40);
const platform = (architecture: string) => ({ os: 'linux', architecture, sourceLabel: work });
const evidence = (version: string) => ({
  releaseTag: `v${version}`, packageVersion: version, source: work, lollySource: lolly,
  images: [
    { image: `ghcr.io/lolly-tools/lolly-work-server@sha256:${'1'.repeat(64)}`, signatureVerified: true, platforms: [platform('amd64'), platform('arm64')] },
    { image: `ghcr.io/lolly-tools/lolly-work-render-worker@sha256:${'2'.repeat(64)}`, signatureVerified: true, platforms: [platform('amd64'), platform('arm64')] },
  ],
});
const shell = (overrides = {}) => ({ url: 'https://lolli.li/lolly-web-9.9.9-ynh1.tar.gz', sha256: 'c'.repeat(64), archiveBytes: 10, expandedBytes: 20,
  pinnedKeys: [key, key], envelope: { keyId: keyId(key), seq: 2 }, ...overrides });

test('the catalogue keyId is the RFC 7638 thumbprint of the key the web app pins', () => {
  assert.equal(keyId(key), '5zVngG6s-652_L8Zdok5PTfQ6vxdPAYfcpBWxMtzs5c');
  const source = `const a=\`${literal(key)}\`;const env={VITE_CATALOG_PUBLIC_KEY_JWK:\`${literal(key)}\`}`;
  assert.deepEqual(pinnedKeys(source), [key, key]);
  assert.deepEqual(pinnedKeys('const pinned = "";'), []);
});

test('a cohort is derived from the release evidence and the archive, never typed by hand', () => {
  const evidenceUrl = 'https://github.com/lolly-tools/lolly-work/releases/download/v9.9.9/release-source-images.json';
  const next = nextCohort(previous, '9.9.9', evidence('9.9.9'), shell(), evidenceUrl);
  assert.deepEqual(next, {
    schemaVersion: 1, version: '9.9.9', workSource: work, lollySource: lolly, releaseEvidence: evidenceUrl,
    serverImage: `ghcr.io/lolly-tools/lolly-work-server@sha256:${'1'.repeat(64)}`,
    workerImage: `ghcr.io/lolly-tools/lolly-work-render-worker@sha256:${'2'.repeat(64)}`,
    postgresImage: previous.postgresImage, caddyImage: previous.caddyImage,
    shell: { url: 'https://lolli.li/lolly-web-9.9.9-ynh1.tar.gz', sha256: 'c'.repeat(64), archiveBytes: 10, expandedBytes: 20 },
    catalogGeneration: previous.catalogGeneration + 1, sourceCatalogPublicKey: key,
    qualifiedArchitectures: previous.qualifiedArchitectures, modelOrigin: previous.modelOrigin,
  });
  // An installation refuses a publication at a generation it has recorded, so a new archive
  // always moves up; a higher signed sequence wins, and the same archive keeps its pin.
  assert.equal(nextCohort(previous, '9.9.9', evidence('9.9.9'), shell({ envelope: { keyId: keyId(key), seq: 40 } }), evidenceUrl).catalogGeneration, 40);
  assert.equal(nextCohort(previous, '9.9.9', evidence('9.9.9'), shell({ sha256: previous.shell.sha256 }), evidenceUrl).catalogGeneration, previous.catalogGeneration);
});

test('a cohort is refused when the evidence or the archive does not match', () => {
  const url = 'https://example.test/evidence.json';
  const refuse = (pattern: RegExp, version: string, proof: Record<string, any>, facts = shell()) => assert.throws(() => nextCohort(previous, version, proof, facts, url), pattern);
  refuse(/describes v9\.9\.8/, '9.9.9', evidence('9.9.8'));
  const oneArchitecture = evidence('9.9.9'); oneArchitecture.images[0]!.platforms.pop();
  refuse(/no single verified amd64 and arm64/, '9.9.9', oneArchitecture);
  const otherSource = evidence('9.9.9'); otherSource.images[1]!.platforms[0]!.sourceLabel = 'd'.repeat(40);
  refuse(/built from/, '9.9.9', otherSource);
  const unsigned = evidence('9.9.9'); unsigned.images[0]!.signatureVerified = false;
  refuse(/verified/, '9.9.9', unsigned);
  refuse(/https URL/, '9.9.9', evidence('9.9.9'), shell({ url: 'http://lolli.li/lolly-web-9.9.9-ynh1.tar.gz' }));
  const other: PublicKey = { ...key, x: 'A'.repeat(43) };
  refuse(/exactly one catalogue key; found 2/, '9.9.9', evidence('9.9.9'), shell({ pinnedKeys: [key, other] }));
  refuse(/exactly one catalogue key; found 0/, '9.9.9', evidence('9.9.9'), shell({ pinnedKeys: [] }));
  refuse(/not signed by the key the web app pins/, '9.9.9', evidence('9.9.9'), shell({ envelope: { keyId: keyId(other), seq: 2 } }));
  refuse(/positive sequence/, '9.9.9', evidence('9.9.9'), shell({ envelope: { keyId: keyId(key) } }));
});

test('archive facts come from the bytes: checksum, sizes, pinned key and signed sequence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lolly-cohort-test-'));
  try {
    const dist = join(directory, 'dist');
    mkdirSync(join(dist, '_app'), { recursive: true }); mkdirSync(join(dist, 'catalog/tools'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    writeFileSync(join(dist, '_app/web-boot-test.js'), `const pinned=\`${literal(key)}\`;`);
    writeFileSync(join(dist, '_app/view-test.js'), 'export {};');
    writeFileSync(join(dist, 'catalog/tools/index.sig.json'), JSON.stringify({ keyId: keyId(key), seq: 7 }));
    const archive = join(directory, 'shell.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dist, '.']);
    const facts = await shellFacts(archive, 'https://lolli.li/x.tar.gz');
    assert.equal(facts.sha256, createHash('sha256').update(readFileSync(archive)).digest('hex'));
    assert.equal(facts.archiveBytes, readFileSync(archive).length);
    const expected = ['index.html', '_app/web-boot-test.js', '_app/view-test.js', 'catalog/tools/index.sig.json'].reduce((sum, file) => sum + readFileSync(join(dist, file)).length, 0);
    assert.equal(facts.expandedBytes, expected);
    assert.deepEqual(facts.pinnedKeys, [key]);
    assert.deepEqual(facts.envelope, { keyId: keyId(key), seq: 7 });
    rmSync(join(dist, '_app/web-boot-test.js'));
    execFileSync('tar', ['-czf', archive, '-C', dist, '.']);
    await assert.rejects(shellFacts(archive, 'https://lolli.li/x.tar.gz'), /not a built Lolly web app/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
