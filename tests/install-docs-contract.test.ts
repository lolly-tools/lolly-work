/**
 * Install-surface contract. Every install command has exactly ONE home in docs/:
 * docs/install.md for the source and single-server paths, and
 * docs/platform-deployment.md for Kubernetes. Only docs/ reaches the console at
 * /admin#/docs, and a second copy at the repo root drifted the moment it existed
 * (it shipped a different recommended cluster on-ramp and a different Helm
 * command than the docs copy). Root INSTALL.md is a pointer, and this test is
 * what keeps it one:
 *   - INSTALL.md stays short and links docs/install.md;
 *   - INSTALL.md carries no shape-specific install recipe of its own;
 *   - docs/deployment.md keeps no second copy of the install commands either,
 *     which is where the SECOND drift landed (its eval command lacked the image
 *     override that makes the eval install work at all), and the two install
 *     pages do not copy each other's commands;
 *   - docs.json lists install and nothing it lists is missing from disk;
 *   - every .md under docs/, subdirectories included, has a docs.json entry, so
 *     a page cannot be added without a console home. The one exception is the
 *     generated copy of a live-verify runbook, which the bundle carries until
 *     the canonical source drops it; the maintained runbook sits beside its
 *     driver in server/src/catalog/providers/live-verify/;
 *   - the config file the guide tells a first-timer to copy actually parses and
 *     points its pack at a directory that exists;
 *   - the commands the guide hands a first-timer agree with the artifacts they
 *     drive (the chart's Service port, the eval values' personas and baseUrl,
 *     the compose stack's boot ordering);
 *   - the mirror steps in docs/official-installations.md name the registries,
 *     archive hosts, Compose services and proxy target the official packages
 *     actually use, so a renamed service or a moved registry fails here rather
 *     than in an operator's disconnected network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { parseConfig } from '../server/src/config/instance.ts';
import { release } from '../scripts/marketplace-packages.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(REPO, 'docs');
const ROOT_INSTALL = readFileSync(join(REPO, 'INSTALL.md'), 'utf8');
const CANONICAL = readFileSync(join(DOCS, 'install.md'), 'utf8');
const KUBERNETES = readFileSync(join(DOCS, 'platform-deployment.md'), 'utf8');
const DEPLOYMENT = readFileSync(join(DOCS, 'deployment.md'), 'utf8');
const RUNBOOKS = join(REPO, 'server/src/catalog/providers/live-verify');

interface Manifest {
  sections: Array<{ id: string; docs: Array<{ slug: string; title: string; path?: string }> }>;
}
const manifest = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')) as Manifest;
const entries = manifest.sections.flatMap((s) => s.docs);
const slugs = entries.map((d) => d.slug);
/** Manifest entry -> the file it serves, relative to docs/. */
const docPath = (d: { slug: string; path?: string }): string => d.path ?? `${d.slug}.md`;

/** Every .md under docs/, relative to docs/, README index and logo attribution aside. */
function docMarkdown(dir = DOCS, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'img' || e.name === 'shots') continue; // assets, not pages
      out.push(...docMarkdown(join(dir, e.name), rel));
    } else if (e.name.endsWith('.md') && rel !== 'README.md') {
      out.push(rel);
    }
  }
  return out;
}

test('root INSTALL.md is a pointer at the canonical guide, not a second copy', () => {
  assert.match(ROOT_INSTALL, /docs\/install\.md/, 'INSTALL.md links the canonical guide');
  const lines = ROOT_INSTALL.split('\n').length;
  assert.ok(lines < 60, `INSTALL.md is a pointer (${lines} lines); install content belongs in docs/install.md`);
  // The recipes that drifted last time. None of them may reappear here.
  for (const recipe of [/systemd/i, /docker compose/i, /helm install/i, /EnvironmentFile/i]) {
    assert.ok(!recipe.test(ROOT_INSTALL), `INSTALL.md must not carry its own ${recipe} recipe`);
  }
});

test('deployment.md describes the shapes and keeps no second copy of the commands', () => {
  // The drift that actually shipped: deployment.md's eval command omitted the
  // image override, so following it got ImagePullBackOff from a private GHCR
  // package. One home per command; deployment.md links into it.
  // Anchored at line start: that is how a runnable command appears in a fence,
  // and it leaves prose free to NAME the command it is linking to.
  const homes: Array<{ command: RegExp; home: string; text: string; other: string; otherText: string }> = [
    { command: /^\s*helm (install|upgrade) /m, home: 'platform-deployment.md', text: KUBERNETES, other: 'install.md', otherText: CANONICAL },
    { command: /^\s*kubectl create secret/m, home: 'platform-deployment.md', text: KUBERNETES, other: 'install.md', otherText: CANONICAL },
    { command: /^\s*docker compose up/m, home: 'install.md', text: CANONICAL, other: 'platform-deployment.md', otherText: KUBERNETES },
  ];
  for (const { command, home, text, other, otherText } of homes) {
    assert.ok(!command.test(DEPLOYMENT), `docs/deployment.md must not carry its own ${command} recipe; link ${home} instead`);
    assert.match(text, command, `docs/${home} is the one home for ${command}`);
    assert.ok(!command.test(otherText), `docs/${other} must not carry its own ${command} recipe; link ${home} instead`);
  }
  assert.match(DEPLOYMENT, /\binstall\.md#/, 'deployment.md links into the install guide sections');
  assert.match(DEPLOYMENT, /platform-deployment\.md#/, 'deployment.md links into the Kubernetes guide sections');
});

test('the canonical guide covers the whole first-deploy arc', () => {
  // install -> configure -> run -> sign in -> verify -> connect something real.
  // Each of these was a hole a first-timer fell into; the assertion is that the
  // step is present at all, not how it is worded.
  for (const step of [
    /pnpm install/,            // deps, before any command that needs them
    /cp instance\.example\.json instance\.json/,
    /\/api\/auth\/dev/,       // how the first human signs in
    /healthz/,                // the verification ladder
    /first owner/i,           // who can connect a DAM
    /createdb/,               // the Postgres nobody said to create
    /psql /,                  // and the check that it actually answers
    /NODE_ENV=production/,    // what makes the secret check fail closed
    /openssl rand -hex 32/,   // the secrets themselves
    /LW_SEED_CONFIG/,
    /lw providers add/,       // connect something real, with commands
    /lw providers credential/,
    /catalog\/search/,        // and the verify that proves it federated
  ]) {
    assert.match(CANONICAL, step, `docs/install.md covers ${step}`);
  }
});

test('docs.json and docs/ agree in both directions', () => {
  assert.ok(slugs.includes('install'), 'install has a console page');
  assert.equal(new Set(slugs).size, slugs.length, 'docs.json slugs are unique');
  for (const d of entries) {
    assert.match(d.slug, /^[a-z0-9][a-z0-9-]*$/, `slug ${d.slug} must be slug-shaped (the API route shape-checks it)`);
    assert.ok(existsSync(join(DOCS, docPath(d))), `docs.json lists ${d.slug} but docs/${docPath(d)} is missing`);
  }
  const served = new Set(entries.map(docPath));
  // A generated runbook copy is retired, not a page: its maintained runbook must
  // exist beside the driver, and the console must not list the copy.
  const retired = (f: string): boolean => {
    const m = /^providers\/([a-z0-9-]+)-live-verify\.md$/.exec(f);
    return Boolean(m && existsSync(join(RUNBOOKS, `${m[1]}.md`)));
  };
  for (const f of docMarkdown()) {
    if (retired(f)) {
      assert.ok(!served.has(f), `docs/${f} is a retired runbook copy, so docs.json must not list it`);
      continue;
    }
    assert.ok(served.has(f), `docs/${f} has no docs.json entry, so it gets no console page`);
  }
});

test('instance.example.json is a working first config', () => {
  const cfg = parseConfig(readFileSync(join(REPO, 'instance.example.json'), 'utf8'));
  assert.ok(existsSync(resolve(REPO, cfg.instance.pack)), `instance.pack (${cfg.instance.pack}) must exist in the repo`);
  // The guide's §2 ladder ends at an owner-only action; a first deploy that can
  // never produce an owner cannot connect a catalog provider.
  const groups = cfg.dev.users.flatMap((u) => u.groups ?? []);
  assert.ok(groups.includes('owner'), 'the example ships an owner persona');
});

test('the Helm eval install can complete the guide it is pointed at', () => {
  const evalValues = readFileSync(join(REPO, 'deploy/helm/values-eval.yaml'), 'utf8');
  // Role comes only from a group literally named `owner` (rbac/evaluate.ts), and
  // there is no bootstrap owner, so an eval without one cannot reach
  // instance.config or any provider credential - the last leg of the guide.
  assert.match(evalValues, /groups:\s*\[owner\]/, 'values-eval.yaml ships a persona in group owner');
  // baseUrl drives the session cookie's Secure flag (api/app.ts). The eval
  // ingress terminates no TLS, so an https: value here loses every browser
  // sign-in while curl still passes.
  const baseUrl = /baseUrl:\s*"([^"]+)"/.exec(evalValues)?.[1];
  assert.ok(baseUrl?.startsWith('http://'), `values-eval.yaml baseUrl must be http: for the TLS-free eval, got ${baseUrl}`);
  // Every dev address the eval verification ladder uses must exist in the file.
  const addresses = [...KUBERNETES.matchAll(/email=([a-z0-9.@-]+@eval\.example)/g)].map((m) => m[1] ?? '');
  assert.ok(addresses.length, 'platform-deployment.md signs in to the evaluation install');
  for (const address of addresses) {
    assert.ok(evalValues.includes(address), `platform-deployment.md signs in as ${address}, which values-eval.yaml does not ship`);
  }
});

test('the documented port-forward names a port the chart actually creates', () => {
  // kubectl port-forward resolves the remote number against the SERVICE's ports,
  // not the container's, so `8787:8787` errors out on a Service listening on 80.
  const port = /^\s*port:\s*(\d+)/m.exec(
    readFileSync(join(REPO, 'deploy/helm/values.yaml'), 'utf8').split('\nservice:')[1] ?? '',
  )?.[1];
  assert.ok(port, 'deploy/helm/values.yaml declares service.port');
  const forwards = [...KUBERNETES.matchAll(/port-forward[^\n]*?\s(\d+):(\d+)/g)];
  assert.ok(forwards.length, 'platform-deployment.md shows how to reach the cluster install');
  for (const f of forwards) {
    assert.equal(f[2], port, `platform-deployment.md forwards to service port ${f[2]}, but the chart's Service listens on ${port}`);
  }
});

test('the Compose stack waits for its database instead of racing it', () => {
  // main.ts awaits runMigrations() at the top level and store/migrate.ts
  // connects once with no retry, so a plain depends_on lets the server exit
  // during Postgres initdb - and with no restart policy it stays exited.
  const compose = readFileSync(join(REPO, 'deploy/compose/docker-compose.yml'), 'utf8');
  assert.match(compose, /condition:\s*service_healthy/, 'server waits on the db healthcheck');
  assert.match(compose, /pg_isready/, 'db declares a healthcheck');
  assert.match(compose, /restart:\s*unless-stopped/, 'server recovers if the db goes away later');
});

// The external services section of the official installations page. Its mirror
// steps restate service names, environment keys and image sources from the
// generated packages, so each of those is read back from the package files.
const OFFICIAL = readFileSync(join(DOCS, 'official-installations.md'), 'utf8');
const MIRRORS = (() => {
  const start = OFFICIAL.indexOf('\n## External services and mirrors\n');
  if (start < 0) return '';
  const end = OFFICIAL.indexOf('\n## ', start + 1);
  return OFFICIAL.slice(start, end < 0 ? undefined : end);
})();
/** The body of the first fenced block of `lang` in the section, list indentation removed. */
function fence(lang: string): string {
  const m = new RegExp('^( *)```' + lang + '\\n([\\s\\S]*?)^\\1```', 'm').exec(MIRRORS);
  assert.ok(m, `the mirror section has a ${lang} example`);
  const indent = m[1]?.length ?? 0;
  return (m[2] ?? '').split('\n').map((line) => line.slice(Math.min(indent, line.search(/\S|$/)))).join('\n');
}
/** Registry and namespace of an image reference: everything before its last path segment. */
const registryPrefix = (image: string): string => {
  const name = image.split('@')[0] ?? '';
  return name.slice(0, name.lastIndexOf('/'));
};
/** Repository name of an image reference, without registry, tag or digest. */
const repositoryName = (image: string): string => (image.split('@')[0] ?? '').split('/').pop()?.split(':')[0] ?? '';

type ComposeService = { image?: string; environment?: Record<string, unknown> };
const readCompose = (path: string) =>
  parseYaml(readFileSync(join(REPO, path), 'utf8')) as { services: Record<string, ComposeService> };
const VM_COMPOSE = readCompose('deploy/marketplaces/compose.yaml');
const DOKPLOY_COMPOSE = readCompose('deploy/dokploy/lolly-work/docker-compose.yml');

test('the external services inventory names every registry and archive host the packages use', () => {
  assert.ok(MIRRORS, 'official-installations.md has an External services and mirrors section');
  const images = [
    ...Object.entries(release).filter(([key]) => key.endsWith('Image')).map(([, value]) => String(value)),
    ...[VM_COMPOSE, DOKPLOY_COMPOSE].flatMap((c) => Object.values(c.services).flatMap((s) => (s.image ? [s.image] : []))),
  ];
  assert.ok(images.length >= 4, 'release.json pins the server, worker, PostgreSQL and Caddy images');
  for (const prefix of new Set(images.map(registryPrefix))) {
    assert.ok(prefix && MIRRORS.includes(prefix), `the inventory must list ${prefix}, which an official package pulls from`);
  }
  // YunoHost downloads both archives itself; the neutral packages download the shell.
  const ynh = readFileSync(join(REPO, 'deploy/yunohost/manifest.toml'), 'utf8');
  const archives = [release.shell.url as string, ...[...ynh.matchAll(/^\s*url\s*=\s*"(https:\/\/[^"]+)"/gm)].map((m) => m[1] ?? '')];
  assert.ok(archives.length >= 3, 'the shell archive and both YunoHost sources are found');
  for (const host of new Set(archives.map((url) => new URL(url).host))) {
    assert.ok(MIRRORS.includes(host), `the inventory must list ${host}, which serves a release archive`);
  }
});

test('the documented compose override replaces exactly the images the neutral package pulls', () => {
  const block = fence('yaml');
  const override = parseYaml(block) as { services: Record<string, ComposeService> };
  const pulled = Object.entries(VM_COMPOSE.services).filter(([, s]) => s.image).map(([name]) => name);
  assert.deepEqual(Object.keys(override.services).sort(), [...pulled].sort(),
    'the override names every compose.yaml service that pulls an image, and no other');
  for (const [name, service] of Object.entries(override.services)) {
    assert.equal(repositoryName(service.image ?? ''), repositoryName(VM_COMPOSE.services[name]?.image ?? ''),
      `the override gives ${name} a mirror of the image compose.yaml gives it`);
  }
  // The shell download belongs to whichever service initialises content, and
  // that service checks the download against the release checksum. Overriding
  // the URL elsewhere does nothing; overriding the checksum removes the check.
  const holders = (c: { services: Record<string, ComposeService> }, key: string) =>
    Object.entries(c.services).filter(([, s]) => s.environment?.[key] !== undefined).map(([name]) => name);
  assert.deepEqual(holders(override, 'LW_SHELL_URL'), holders(VM_COMPOSE, 'LW_SHELL_URL'),
    'the override sets LW_SHELL_URL on the service that downloads the shell');
  for (const name of holders(VM_COMPOSE, 'LW_SHELL_URL')) {
    assert.ok(VM_COMPOSE.services[name]?.environment?.LW_SHELL_SHA256, `${name} still checks the shell against LW_SHELL_SHA256`);
  }
  assert.ok(!block.includes('LW_SHELL_SHA256'), 'the override must not replace the pinned shell checksum');
  assert.match(MIRRORS, /Keep `LW_SHELL_SHA256` unchanged/, 'the steps tell the operator to keep the checksum');
});

test('the documented Caddyfile keeps the shipped site address and proxy target', () => {
  const shipped = readFileSync(join(REPO, 'deploy/marketplaces/Caddyfile'), 'utf8');
  const example = fence('text');
  const site = (file: string) => file.trim().split('\n')[0]?.trim();
  const upstream = (file: string) => /^\s*reverse_proxy\s+(\S+)/m.exec(file)?.[1];
  assert.ok(upstream(shipped), 'the shipped Caddyfile proxies to the server');
  assert.equal(site(example), site(shipped), 'the example serves the same site address');
  assert.equal(upstream(example), upstream(shipped), 'the example proxies to the same upstream');
});

test('the model files note stays while the shell fetches models from an external origin', () => {
  // Mirroring the archive cannot move a model origin built into the shell. While
  // the release still names one, the page must say so and must not imply that a
  // disconnected bundle exists.
  if (!/^https:\/\//.test(String(release.modelOrigin ?? ''))) return;
  const text = MIRRORS.replace(/\s+/g, ' ');
  assert.ok(text.includes(release.modelOrigin), `the model files note names ${release.modelOrigin}`);
  assert.ok(text.includes('does not publish or qualify such a bundle'), 'the page states that no disconnected bundle is published');
});
