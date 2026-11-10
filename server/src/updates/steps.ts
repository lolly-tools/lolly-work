// SPDX-License-Identifier: MPL-2.0
/**
 * The ordered upgrade steps for one install route, for the release notice.
 *
 * Every command is built from values checked here: the target version is strict
 * semver, and the release name, namespace and Deployment name are Kubernetes
 * names (settings.ts). Nothing from the release feed other than the version
 * reaches a command, and the chart downloads name the official release assets,
 * so a feed that says something odd cannot put an instruction in front of an
 * administrator. A value that is not known shows as a placeholder.
 *
 * Lolly Work never upgrades its own release. Its ServiceAccount would need write
 * access to every object the chart owns, Secrets and Helm's release record
 * included, in each namespace they go to: close to cluster-admin, held by the
 * process people reach over the network. The administrator runs these steps.
 */
import { parseSemver } from './feed.ts';
import type { InstallRoute, ReleaseIdentity } from './settings.ts';

export const CHART_RELEASES = 'https://github.com/lolly-tools/lolly-work/releases/download';
export const CHART_SIGNER = 'https://github.com/lolly-tools/lolly-work/.github/workflows/publish-helm.yml@refs/heads/main';
export const SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';

export interface UpgradeStep {
  id: string;
  title: string;
  detail: string;
  /** Text to copy: a command, a URL or a snippet for a Git repository. */
  command?: string;
  /** A page of this deployment's documentation, opened in the console. */
  doc?: { page: string; anchor?: string };
  optional?: boolean;
}

export interface StepContext {
  version: string;
  release: ReleaseIdentity;
  /** The chart repository address (the feed without index.yaml), or null. */
  repoUrl: string | null;
  /** True when a release up to the target migrates; null when one does not say. */
  migrates: boolean | null;
}

/** The repository address an index URL serves, when it is plain enough to show. */
export function repositoryUrl(feedUrl: string): string | null {
  let url: URL;
  try { url = new URL(feedUrl); } catch { return null; }
  if (url.search || !url.pathname.endsWith('/index.yaml')) return null;
  const base = `${url.origin}${url.pathname.slice(0, -'/index.yaml'.length)}`;
  return /^https?:\/\/[A-Za-z0-9.:[\]-]+(?:\/[A-Za-z0-9._~%/-]*)?$/.test(base) ? base : null;
}

export function upgradeSteps(route: InstallRoute, ctx: StepContext): UpgradeStep[] {
  if (!parseSemver(ctx.version) || !/^[0-9A-Za-z.+-]+$/.test(ctx.version)) return [];
  const v = ctx.version;
  const release = ctx.release.name ?? '<release>';
  const ns = ctx.release.namespace ?? '<namespace>';
  const workload = ctx.release.fullname ?? '<deployment>';
  const repo = ctx.repoUrl ?? '<chart repository URL>';
  const archive = `lolly-work-${v}.tgz`;

  const backup: UpgradeStep = {
    id: 'backup',
    title: 'Take a verified backup',
    detail: ctx.migrates === true
      ? 'This upgrade migrates the database. Back up PostgreSQL and the asset store, then restore the backup into a separate target before you continue: going back after a migration means restoring it.'
      : ctx.migrates === null
        ? 'This release does not say whether it migrates the database, so treat it as one that does. Back up PostgreSQL and the asset store, then restore the backup into a separate target before you continue.'
        : 'This release adds no database migrations. Back up PostgreSQL and the asset store and restore the backup into a separate target before every upgrade all the same.',
    doc: { page: 'operations', anchor: 'backup-and-restore' },
  };
  const verify: UpgradeStep = {
    id: 'verify',
    title: 'Check the chart’s signature',
    optional: true,
    detail: `The release feed is not signed, so this notice is information only, but the chart is. Download it and its Sigstore bundle from the chart release, check the signature and confirm the chart is ${v}. To install exactly the file you checked, use ./${archive} in place of lolly-work/lolly-work --version ${v}.`,
    command: [
      `curl -fsSLO ${CHART_RELEASES}/chart-v${v}/${archive}`,
      `curl -fsSLO ${CHART_RELEASES}/chart-v${v}/${archive}.sigstore.json`,
      `cosign verify-blob --bundle ${archive}.sigstore.json \\`,
      `  --certificate-oidc-issuer ${SIGNER_ISSUER} \\`,
      `  --certificate-identity ${CHART_SIGNER} \\`,
      `  ${archive}`,
      `tar -xOzf ${archive} lolly-work/Chart.yaml | grep -x 'version: ${v}'`,
    ].join('\n'),
  };
  const helmUpgrade = `helm upgrade ${release} lolly-work/lolly-work -n ${ns} --version ${v} -f <your-values.yaml>`;
  const pinNote = 'If your values pin image.tag or image.digest, set the new release’s qualified digest first, or the chart upgrades and the server keeps its old image.';
  const migrationJob: UpgradeStep = {
    id: 'migration-job',
    title: 'Check the migration Job',
    detail: 'The chart runs its migration Job before the new pod starts, and keeps the Job and its log until the next upgrade. The log must end with the migrations applied. With migrate.enabled set to false there is no Job.',
    command: `kubectl -n ${ns} logs job/${workload}-migrate`,
  };
  const rollout: UpgradeStep = {
    id: 'rollout',
    title: 'Wait for the new pod',
    detail: 'The chart replaces the pod rather than running two side by side, so people in a live session reconnect once.',
    command: `kubectl -n ${ns} rollout status deploy/${workload}`,
  };
  const accept: UpgradeStep = {
    id: 'accept',
    title: 'Check what people use',
    detail: `Sign in, reopen a live session and try the exports you have turned on. This notice then shows that you run ${v}.`,
  };

  switch (route) {
    case 'helm':
      return [backup,
        { id: 'repo-update', title: 'Update the chart repository', detail: 'Fetch the current index of the repository you added as lolly-work.', command: 'helm repo update lolly-work' },
        verify,
        { id: 'upgrade', title: `Upgrade to ${v}`,
          detail: `Give the reviewed values file you installed with, and every --set or --set-file you used then; anything left out returns to the new chart’s default. Prefer -f over --reuse-values: --reuse-values replaces the new chart’s defaults with the old chart’s, so a setting the new release adds or changes never arrives. ${pinNote}`,
          command: helmUpgrade },
        migrationJob, rollout, accept];
    case 'rancher':
      return [backup,
        { id: 'repository', title: 'Add the chart repository once',
          detail: 'In Rancher, open Apps > Repositories and create a repository with this address. Skip this when it is already listed.', command: repo },
        verify,
        { id: 'upgrade', title: `Upgrade to ${v} in Rancher`,
          detail: `Open Apps > Installed Apps > ${release} in namespace ${ns}, choose Upgrade, then version ${v}. Review the YAML before you confirm. ${pinNote}` },
        migrationJob, rollout, accept];
    case 'fleet':
      return [backup, verify,
        { id: 'git', title: `Set chart version ${v} in Git`,
          detail: 'In the fleet.yaml that deploys Lolly Work, set helm.version and merge the change through your usual review. Fleet upgrades the release, migration Job first.',
          command: ['helm:', '  chart: lolly-work', `  repo: ${repo}`, `  version: ${v}`].join('\n') },
        migrationJob, rollout, accept];
    case 'argocd':
      return [backup, verify,
        { id: 'git', title: `Set chart version ${v} in Git`,
          detail: 'In the Application that deploys Lolly Work, set spec.source.targetRevision and merge the change through your usual review. Argo CD runs the chart’s migration Job as a PreSync hook, then the new pod.',
          command: ['spec:', '  source:', `    repoURL: ${repo}`, '    chart: lolly-work', `    targetRevision: ${v}`].join('\n') },
        migrationJob, rollout, accept];
    default:
      return [backup, verify,
        { id: 'upgrade', title: `Upgrade to ${v}`,
          detail: `Move to release ${v} with the tool that installed Lolly Work. With the Helm command line, give the values file you installed with. ${pinNote}`,
          command: helmUpgrade },
        accept];
  }
}
