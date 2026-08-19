/**
 * Install-surface contract. There is exactly ONE install guide, docs/install.md,
 * because only docs/ reaches the console at /admin#/docs and because a second
 * copy at the repo root drifted the moment it existed (it shipped a different
 * recommended cluster on-ramp and a different Helm command than the docs copy).
 * Root INSTALL.md is a pointer, and this test is what keeps it one:
 *   - INSTALL.md stays short and links docs/install.md;
 *   - INSTALL.md carries no shape-specific install recipe of its own;
 *   - docs/deployment.md keeps no second copy of the install commands either,
 *     which is where the SECOND drift landed (its eval command lacked the image
 *     override that makes the eval install work at all);
 *   - docs.json lists install and nothing it lists is missing from disk;
 *   - every .md under docs/, subdirectories included, has a docs.json entry, so
 *     a page cannot be added without a console home;
 *   - the config file the guide tells a first-timer to copy actually parses and
 *     points its pack at a directory that exists;
 *   - the commands the guide hands a first-timer agree with the artifacts they
 *     drive (the chart's Service port, the eval values' personas and baseUrl,
 *     the compose stack's boot ordering).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(REPO, 'docs');
const ROOT_INSTALL = readFileSync(join(REPO, 'INSTALL.md'), 'utf8');
const CANONICAL = readFileSync(join(DOCS, 'install.md'), 'utf8');
const DEPLOYMENT = readFileSync(join(DOCS, 'deployment.md'), 'utf8');

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
  for (const command of [/^\s*helm (install|upgrade) /m, /^\s*docker compose up/m, /^\s*kubectl create secret/m]) {
    assert.ok(!command.test(DEPLOYMENT), `docs/deployment.md must not carry its own ${command} recipe; link install.md instead`);
    assert.match(CANONICAL, command, `docs/install.md is the one home for ${command}`);
  }
  assert.match(DEPLOYMENT, /install\.md#/, 'deployment.md links into the install guide sections');
});

test('the canonical guide covers the whole first-deploy arc', () => {
  // install -> configure -> run -> sign in -> verify -> connect something real.
  // Each of these was a hole a first-timer fell into; the assertion is that the
  // step is present at all, not how it is worded.
  for (const step of [
    /npm install/,            // deps, before any command that needs them
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
  for (const f of docMarkdown()) {
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
  for (const m of CANONICAL.matchAll(/email=([a-z0-9.@-]+@eval\.example)/g)) {
    const address = m[1] ?? '';
    assert.ok(evalValues.includes(address), `install.md signs in as ${address}, which values-eval.yaml does not ship`);
  }
});

test('the documented port-forward names a port the chart actually creates', () => {
  // kubectl port-forward resolves the remote number against the SERVICE's ports,
  // not the container's, so `8787:8787` errors out on a Service listening on 80.
  const port = /^\s*port:\s*(\d+)/m.exec(
    readFileSync(join(REPO, 'deploy/helm/values.yaml'), 'utf8').split('\nservice:')[1] ?? '',
  )?.[1];
  assert.ok(port, 'deploy/helm/values.yaml declares service.port');
  const forwards = [...CANONICAL.matchAll(/port-forward[^\n]*?\s(\d+):(\d+)/g)];
  assert.ok(forwards.length, 'install.md shows how to reach the cluster install');
  for (const f of forwards) {
    assert.equal(f[2], port, `install.md forwards to service port ${f[2]}, but the chart's Service listens on ${port}`);
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
