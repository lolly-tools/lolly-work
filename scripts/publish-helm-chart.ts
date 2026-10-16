// SPDX-License-Identifier: MPL-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { REPOSITORY, digest, mergeIndex, type ChartRelease } from './package-helm-chart.ts';

const api = `repos/${REPOSITORY}`;
function gh(args: string[], input?: unknown) {
  return execFileSync('gh', args, { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] });
}
function request(path: string, body?: unknown) {
  return JSON.parse(gh(['api', `${api}/${path}`, ...(body === undefined ? [] : ['--method', 'POST', '--input', '-'])], body));
}
function findRelease(tag: string) {
  try { return request(`releases/tags/${tag}`); }
  catch (error) {
    if (String((error as { stderr?: string }).stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
}
function download(tag: string, name: string, directory: string) {
  const output = join(directory, name);
  gh(['release', 'download', tag, '--repo', REPOSITORY, '--pattern', name, '--output', output]);
  return output;
}

export function repositoryMetadata(env: Record<string, string | undefined>): string | undefined {
  const id = env.ARTIFACTHUB_REPOSITORY_ID?.trim(), email = env.ARTIFACTHUB_OWNER_EMAIL?.trim();
  if (!id && !email) return undefined;
  if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set the actual Artifact Hub repository UUID and verified account email together');
  }
  return stringify({ repositoryID: id, owners: [{ name: 'Lolly project maintainers', email }] });
}

export function publishChart(directory: string) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Chart publication runs only from upstream main');
  const release: ChartRelease = JSON.parse(readFileSync(join(directory, 'chart-release.json'), 'utf8'));
  if (release.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(release.source) || !/^\d+\.\d+\.\d+$/.test(release.version)
      || release.archive !== `lolly-work-${release.version}.tgz` || release.chart !== 'lolly-work'
      || digest(join(directory, release.archive)) !== release.sha256) throw new Error('Invalid packaged chart release');
  if (request('git/ref/heads/main').object.sha !== release.source) throw new Error('Reviewed source is no longer current main');
  for (const workflow of ['ci.yml', 'helm-qualification.yml', 'deployment-qualification.yml']) {
    const runs = request(`actions/workflows/${workflow}/runs?head_sha=${release.source}&event=push&branch=main&per_page=10`).workflow_runs;
    if (runs[0]?.head_sha !== release.source || runs[0]?.status !== 'completed' || runs[0]?.conclusion !== 'success') throw new Error(`Exact main source still needs successful ${workflow}`);
  }
  const metadata = repositoryMetadata(process.env);
  const tag = `chart-v${release.version}`, temporary = mkdtempSync(join(tmpdir(), 'lolly-chart-publish-'));
  let remote = findRelease(tag);
  if (remote && (remote.target_commitish !== release.source || request(`git/ref/tags/${tag}`).object.sha !== release.source)) throw new Error('Chart tag is already owned by a different source');
  if (remote?.assets.some((asset: { name: string }) => asset.name === 'chart-release.json')) {
    const previous = download(tag, 'chart-release.json', temporary);
    if (readFileSync(previous, 'utf8') !== readFileSync(join(directory, 'chart-release.json'), 'utf8')) throw new Error('Published release record differs; use a new chart version');
  }
  if (!remote) remote = request('releases', { tag_name: tag, target_commitish: release.source, name: `Lolly Work chart ${release.version}`, draft: true, make_latest: 'false',
    body: `Official upstream Helm chart ${release.version}, application ${release.appVersion}. Source: ${release.source}. Verify the archive with its SHA256SUMS and Sigstore bundle. This chart does not provision a database or identity provider.` });
  for (const name of [release.archive, 'chart-release.json', 'SHA256SUMS', `${release.archive}.sigstore.json`]) {
    const local = join(directory, name);
    if (!existsSync(local)) throw new Error('Signed chart publication input is missing');
    if (remote.assets.some((asset: { name: string }) => asset.name === name)) {
      const held = download(tag, name, mkdtempSync(join(temporary, 'asset-')));
      if (name.endsWith('.sigstore.json')) {
        execFileSync('cosign', ['verify-blob', '--bundle', held, '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
          '--certificate-identity', `https://github.com/${REPOSITORY}/.github/workflows/publish-helm.yml@refs/heads/main`, join(directory, release.archive)], { stdio: 'pipe' });
      } else if (digest(held) !== digest(local)) throw new Error('An immutable release asset differs; nothing overwritten');
    } else {
      if (!remote.draft) throw new Error('Published chart release is incomplete; inspect before repairing');
      gh(['release', 'upload', tag, '--repo', REPOSITORY, local]);
    }
  }
  if (remote.draft) gh(['api', `${api}/releases/${remote.id}`, '--method', 'PATCH', '--input', '-'], { draft: false, make_latest: 'false' });
  let indexRelease = findRelease('helm-index');
  const prior = indexRelease?.assets.some((asset: { name: string }) => asset.name === 'index.yaml')
    ? readFileSync(download('helm-index', 'index.yaml', temporary), 'utf8') : undefined;
  if (indexRelease && !prior && !indexRelease.draft) throw new Error('Published repository index is missing; inspect before replacing');
  const index = join(temporary, 'index.yaml');
  writeFileSync(index, mergeIndex(prior, readFileSync(join(directory, 'index.yaml'), 'utf8')));
  if (!indexRelease) indexRelease = request('releases', { tag_name: 'helm-index', target_commitish: release.source, name: 'Official Helm repository index', draft: true, make_latest: 'false',
    body: 'Mutable discovery index for immutable chart-v* releases. The index and Artifact Hub ownership metadata are updated here; versioned chart packages are never replaced.' });
  if (metadata) {
    const path = join(temporary, 'artifacthub-repo.yml');
    writeFileSync(path, metadata);
    gh(['release', 'upload', 'helm-index', '--repo', REPOSITORY, '--clobber', path]);
  }
  gh(['release', 'upload', 'helm-index', '--repo', REPOSITORY, '--clobber', index]);
  if (indexRelease.draft) gh(['api', `${api}/releases/${indexRelease.id}`, '--method', 'PATCH', '--input', '-'], { draft: false, make_latest: 'false' });
  console.log(`Published chart ${release.version}; HTTP repository index updated. Artifact Hub admission/status is separate.`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/publish-helm-chart.ts PACKAGE_DIRECTORY');
  publishChart(resolve(process.argv[2]!));
}
