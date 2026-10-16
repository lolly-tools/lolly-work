// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { deploymentPackages, release, writePackages } from '../scripts/marketplace-packages.ts';
import { prepareInstance } from '../scripts/prepare-marketplace-instance.ts';
import { instanceConfiguration, prepareConfiguration } from '../deploy/marketplaces/server-start.mjs';
import { archivePaths, prepareContent } from '../deploy/marketplaces/content-init.mjs';
import { parseConfig } from '../server/src/config/instance.ts';
import { startupChecks } from '../server/src/setup/checks.ts';
import { mergeIndex } from '../scripts/package-helm-chart.ts';
import { repositoryMetadata } from '../scripts/publish-helm-chart.ts';

const settings = { LOLLY_DOMAIN: 'work.example.test', LOLLY_OIDC_ISSUER: 'https://idp.example.test/tenant', LOLLY_OIDC_CLIENT_ID: 'lolly-client', LOLLY_OWNER_EMAIL: 'owner@example.test' };
const env = { ...settings, LW_SHELL_SHA256: release.shell.sha256, LW_CATALOG_GENERATION: '1',
  LW_SESSION_SECRET: 'session'.repeat(10), LW_LINK_SECRET: 'links'.repeat(10), LW_CREDENTIAL_SECRET: 'credential'.repeat(10), DATABASE_URL: 'postgres://operator:password@db/lollywork' };

test('generated adapters retain exact shared runtime scripts after Compose interpolation', () => {
  writePackages(true);
  const packages = deploymentPackages(), vm = parse(packages.compose), dokploy = parse(packages.dokploy);
  for (const compose of [vm, dokploy]) {
    for (const [service, file] of [['content', 'content-init'], ['server', 'server-start']]) {
      const code = compose.services[service!].command[3].replaceAll('$$', '$');
      assert.equal(code, readFileSync(new URL(`../deploy/marketplaces/${file}.mjs`, import.meta.url), 'utf8'));
      assert.ok(!/(?<!\$)\$(?!\$)/.test(compose.services[service!].command[3]), 'all code dollars survive Compose unchanged');
    }
    assert.equal(compose.services.server.image, release.serverImage);
    assert.equal(compose.services.content.image, release.serverImage);
    assert.equal(compose.services.server.depends_on.content.condition, 'service_completed_successfully');
    assert.equal(compose.services.server.depends_on.db.condition, 'service_healthy');
    assert.equal(compose.services.server.stop_grace_period, '60s');
    for (const name of ['server', 'db', 'content']) assert.equal(compose.services[name].ports, undefined);
    assert.deepEqual(compose.services.server.volumes, ['content:/app/content:ro', 'keys:/app/keys:ro', 'state:/app/state']);
    assert.equal(compose.services.db.environment.LW_SESSION_SECRET, undefined);
    assert.equal(compose.services.server.build, undefined);
    assert.equal(compose.services['render-worker'], undefined);
  }
  assert.equal(dokploy.services.caddy, undefined);
  assert.deepEqual(vm.services.caddy.ports, ['80:80', '443:443', '443:443/udp']);
});

test('neutral production configuration admits the named owner and disables development and inherited roles', () => {
  const config = parseConfig(JSON.stringify(instanceConfiguration(env)));
  assert.equal(config.instance.baseUrl, 'https://work.example.test');
  assert.equal(config.deployment.application, 'web');
  assert.deepEqual(config.idp.bootstrapOwners, ['owner@example.test']);
  assert.deepEqual(config.idp.admission?.emails, ['owner@example.test']);
  assert.deepEqual(config.idp.roleGroups, { owner: ['lolly-owner'], admin: [], approver: [], author: [] });
  assert.equal(config.dev.enabled, false);
  assert.equal(config.proxyAuth.enabled, false);
  assert.equal(config.policy.telemetry, 'off');
  assert.equal(config.render.worker.url, '');
  const checks = startupChecks(config, { session: env.LW_SESSION_SECRET, link: env.LW_LINK_SECRET }, true);
  assert.deepEqual(checks.filter(c => ['fail', 'warning'].includes(c.status) && c.id !== 'web-shell'), []);
  for (const key of ['LOLLY_DOMAIN', 'LOLLY_OIDC_ISSUER', 'LOLLY_OIDC_CLIENT_ID', 'LOLLY_OWNER_EMAIL', 'LW_SESSION_SECRET', 'DATABASE_URL']) {
    assert.throws(() => instanceConfiguration({ ...env, [key]: '' }));
  }
  for (const value of ['https://work.example.test', 'work.example.test/path', 'work.example.test";bad']) assert.throws(() => instanceConfiguration({ ...env, LOLLY_DOMAIN: value }));
  assert.throws(() => instanceConfiguration({ ...env, LOLLY_OIDC_ISSUER: 'http://idp.example.test' }));
  assert.equal(parseConfig(JSON.stringify(instanceConfiguration({ ...env, LOLLY_OIDC_ISSUER: 'https://idp.example.test/' }))).idp.issuer, 'https://idp.example.test/');
});

test('configuration survives operator changes and moves only managed content on upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lolly-config-test-'));
  try {
    const path = join(directory, 'instance.json');
    prepareConfiguration(env, path);
    const configured = JSON.parse(readFileSync(path, 'utf8'));
    configured.policy.guestLinks.enabled = true;
    configured.idp.clientId = 'operator-updated-client';
    writeFileSync(path, JSON.stringify(configured));
    prepareConfiguration({ ...env, LW_SHELL_SHA256: 'a'.repeat(64), LW_CATALOG_GENERATION: '2' }, path);
    const next = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(next.policy.guestLinks.enabled, true);
    assert.equal(next.idp.clientId, 'operator-updated-client');
    assert.equal(next.instance.pack, '/app/content/' + 'a'.repeat(64) + '/pack');
    assert.equal(next.instance.shellDir, '/app/content/' + 'a'.repeat(64) + '/shell');
    assert.equal(next.instance.catalogPublicationGeneration, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('instance preparation generates distinct stable private secrets and refuses an existing installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lolly-instance-test-'));
  try {
    const first = join(directory, 'one'), second = join(directory, 'two');
    prepareInstance(first, settings); prepareInstance(second, settings);
    const before = readFileSync(join(first, '.env'), 'utf8');
    assert.equal(statSync(join(first, '.env')).mode & 0o777, 0o600);
    assert.match(before, /POSTGRES_PASSWORD='[a-f0-9]{64}'/);
    assert.notEqual(before, readFileSync(join(second, '.env'), 'utf8'));
    assert.throws(() => prepareInstance(first, settings), /EEXIST/);
    assert.equal(readFileSync(join(first, '.env'), 'utf8'), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('content preparation verifies bytes before extraction and retains keys and old releases on update', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lolly-content-test-'));
  try {
    const fixture = join(directory, 'fixture');
    mkdirSync(join(fixture, 'catalog/tools'), { recursive: true }); mkdirSync(join(fixture, 'tools'));
    writeFileSync(join(fixture, 'index.html'), '<html>neutral</html>');
    writeFileSync(join(fixture, 'catalog/tools/index.json'), '{}');
    const archive = join(directory, 'shell.tgz');
    execFileSync('tar', ['-czf', archive, '-C', fixture, '.']);
    const body = readFileSync(archive), pin = { url: 'https://release.example.test/shell.tgz', sha256: createHash('sha256').update(body).digest('hex') };
    const content = join(directory, 'content'), keys = join(directory, 'keys');
    const download = (async () => new Response(body)) as typeof fetch;
    await assert.rejects(prepareContent({ ...pin, sha256: '0'.repeat(64) }, content, keys, download), /checksum differs/);
    assert.equal(existsSync(join(content, '0'.repeat(64))), false);
    const target = await prepareContent(pin, content, keys, download);
    assert.equal(readFileSync(join(target, 'shell/index.html'), 'utf8'), '<html>neutral</html>');
    assert.equal(readFileSync(join(target, 'pack/catalog/tools/index.json'), 'utf8'), '{}');
    assert.equal(statSync(target).mode & 0o777, 0o755, 'the non-root server can traverse the release');
    const key = readFileSync(join(keys, 'catalog.jwk'), 'utf8');
    assert.equal(JSON.parse(key).crv, 'P-256');
    assert.equal(await prepareContent(pin, content, keys, (async () => { throw Error('cached release must not download'); }) as typeof fetch), target);
    writeFileSync(join(fixture, 'index.html'), '<html>next</html>');
    execFileSync('tar', ['-czf', archive, '-C', fixture, '.']);
    const next = readFileSync(archive);
    await prepareContent({ ...pin, sha256: createHash('sha256').update(next).digest('hex') }, content, keys, (async () => new Response(next)) as typeof fetch);
    assert.equal(readFileSync(join(keys, 'catalog.jwk'), 'utf8'), key);
    assert.equal(readFileSync(join(target, 'shell/index.html'), 'utf8'), '<html>neutral</html>');
    assert.throws(() => archivePaths('../outside\nindex.html\ncatalog/tools/index.json'), /unsafe/);
    const linkRoot = join(directory, 'link'); symlinkSync(content, linkRoot);
    await assert.rejects(prepareContent(pin, linkRoot, keys, download), /physical/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP repository updates retain older versions and refuse replacement bytes', () => {
  const entry = (version: string, hash: string) => ({ apiVersion: 'v1', entries: { 'lolly-work': [{ version, digest: hash, urls: [`https://github.com/lolly-tools/lolly-work/releases/download/chart-v${version}/lolly-work-${version}.tgz`] }] } });
  const previous = JSON.stringify(entry('0.3.1', 'a'.repeat(64))), fresh = JSON.stringify(entry('0.3.2', 'b'.repeat(64)));
  const merged = mergeIndex(previous, fresh);
  assert.deepEqual(parse(merged).entries['lolly-work'].map((v: { version: string }) => v.version), ['0.3.2', '0.3.1']);
  assert.equal(parse(mergeIndex(merged, fresh)).entries['lolly-work'].length, 2);
  assert.throws(() => mergeIndex(merged, JSON.stringify(entry('0.3.2', 'c'.repeat(64)))), /different bytes/);
  assert.throws(() => mergeIndex('{"entries":{"other":[]}}', fresh), /Unexpected/);
});

test('Artifact Hub ownership metadata contains actual configured identity or remains absent', () => {
  assert.equal(repositoryMetadata({}), undefined);
  assert.throws(() => repositoryMetadata({ ARTIFACTHUB_REPOSITORY_ID: 'replace-me' }), /actual/);
  const metadata = parse(repositoryMetadata({ ARTIFACTHUB_REPOSITORY_ID: '12345678-1234-1234-1234-123456789abc', ARTIFACTHUB_OWNER_EMAIL: 'maintainer@example.test' })!);
  assert.equal(metadata.owners[0].email, 'maintainer@example.test');
  assert.equal(metadata.official, undefined);
});
