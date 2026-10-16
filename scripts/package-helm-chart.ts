// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

export const REPOSITORY = 'lolly-tools/lolly-work';
export const INDEX_URL = `https://github.com/${REPOSITORY}/releases/download/helm-index`;
export const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export interface ChartRelease { schemaVersion: number; source: string; chart: string; version: string; appVersion: string; archive: string; sha256: string }

export function mergeIndex(previous: string | undefined, next: string): string {
  const fresh = parse(next), old = previous ? parse(previous) : { apiVersion: 'v1', entries: {} };
  if (old?.apiVersion !== 'v1' || !old.entries || Object.keys(old.entries).some(name => name !== 'lolly-work')) throw new Error('Unexpected previous repository index');
  const entry = fresh.entries?.['lolly-work']?.[0];
  if (!entry || fresh.apiVersion !== 'v1') throw new Error('Invalid generated chart index');
  const versions = old.entries['lolly-work'] ?? [];
  const collision = versions.find((item: { version: string }) => item.version === entry.version);
  if (collision && (collision.digest !== entry.digest || JSON.stringify(collision.urls) !== JSON.stringify(entry.urls))) {
    throw new Error('An existing chart version has different bytes or URLs; bump the chart version');
  }
  fresh.entries['lolly-work'] = collision ? versions : [entry, ...versions];
  return stringify(fresh, { lineWidth: 0 });
}

export function packageChart(output: string, source: string): ChartRelease {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Use the full reviewed source SHA');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (actual !== source) throw new Error('Checked-out chart source differs');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'deploy/helm'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit the exact chart before packaging a source-bound release');
  if (existsSync(output)) throw new Error('Use a new package output directory');
  const chart = parse(readFileSync(join(root, 'deploy/helm/Chart.yaml'), 'utf8'));
  if (chart.name !== 'lolly-work' || !/^\d+\.\d+\.\d+$/.test(chart.version)) throw new Error('Invalid chart identity/version');
  mkdirSync(output, { recursive: true });
  execFileSync('helm', ['lint', join(root, 'deploy/helm'), '--strict'], { stdio: 'pipe' });
  execFileSync('helm', ['package', join(root, 'deploy/helm'), '--destination', output], { stdio: 'pipe' });
  const archive = `lolly-work-${chart.version}.tgz`, path = join(output, archive);
  // Helm writes time-dependent gzip/tar metadata. Canonicalise that metadata so
  // retrying the same source cannot change an already published package digest.
  execFileSync('python3', ['-c', `import gzip,io,sys,tarfile
p=sys.argv[1]
with tarfile.open(p,'r:gz') as src:
    members=[(m,src.extractfile(m).read() if m.isfile() else None) for m in src.getmembers()]
out=io.BytesIO()
with gzip.GzipFile(fileobj=out,mode='wb',filename='',mtime=0) as gz:
    with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as dst:
        for m,data in sorted(members,key=lambda pair:pair[0].name):
            if not (m.isfile() or m.isdir()): raise SystemExit('Chart contains a special file')
            m.mtime=0; m.uid=0; m.gid=0; m.uname=''; m.gname=''; m.pax_headers={}
            m.mode=0o755 if m.isdir() else 0o644
            dst.addfile(m,io.BytesIO(data) if data is not None else None)
open(p,'wb').write(out.getvalue())`, path], { stdio: 'pipe' });
  execFileSync('helm', ['repo', 'index', output, '--url', `https://github.com/${REPOSITORY}/releases/download/chart-v${chart.version}`], { stdio: 'pipe' });
  const release: ChartRelease = { schemaVersion: 1, source, chart: chart.name, version: chart.version, appVersion: chart.appVersion, archive, sha256: digest(path) };
  writeFileSync(join(output, 'chart-release.json'), JSON.stringify(release, null, 2) + '\n');
  writeFileSync(join(output, 'SHA256SUMS'), `${release.sha256}  ${archive}\n${digest(join(output, 'chart-release.json'))}  chart-release.json\n`);
  return release;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/package-helm-chart.ts NEW_OUTPUT_DIRECTORY REVIEWED_SOURCE_SHA');
  console.log(JSON.stringify(packageChart(resolve(process.argv[2]!), process.argv[3]!)));
}
