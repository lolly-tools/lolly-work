/**
 * The release notice (GET /api/v1/admin/updates): a newer Lolly Work release,
 * what it carries and the upgrade steps for how this deployment was installed.
 * Owners and admins only (fleet.view); the server refuses everyone else and the
 * console never asks for them.
 *
 * On the Overview it is a banner the admin can dismiss for that version; a newer
 * version shows again. On This deployment it is always there, with the last
 * check and a Check now button. The release feed is not signed, so the notice
 * says it is information only, and the steps check the chart's own signature.
 */
const DISMISSED_KEY = 'lw-update-dismissed';
const ROUTE_NAMES = { helm: 'Helm', rancher: 'Rancher', fleet: 'Fleet', argocd: 'Argo CD', other: 'your installer' };
const CHANGE_KINDS = { added: 'Added', changed: 'Changed', deprecated: 'Deprecated', removed: 'Removed', fixed: 'Fixed', security: 'Security' };
const FAILURES = {
  unreachable: 'the release feed did not answer', timeout: 'the release feed took too long', unresolved: 'the release feed’s name did not resolve',
  refused: 'the address is not allowed by this deployment’s network policy', redirect: 'the release feed redirected somewhere not allowed',
  'too-large': 'the release feed was too large', status: 'the release feed answered with an error', invalid: 'the answer was not a chart index',
};

export function dismissedVersion() {
  try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}
function dismiss(version) {
  try { localStorage.setItem(DISMISSED_KEY, version); } catch { /* private window: dismissed until reload */ }
}

/** Whether the Overview should show the banner for this answer. */
export function shouldShowBanner(data) {
  return !!data?.latest && data.latest !== dismissedVersion();
}

function docHref(doc) {
  return `#/docs?doc=${encodeURIComponent(doc.page)}${doc.anchor ? `&anchor=${encodeURIComponent(doc.anchor)}` : ''}`;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

// Flags, paths and value keys in a step's sentence read as code and never break
// mid-word: --reuse-values, -f, ./lolly-work-1.3.1.tgz, lolly-work/lolly-work, image.digest.
const CODE_WORDS = /(--[a-z][a-z-]*|(?<![\w-])-f(?![\w-])|\.\/[\w.-]*\w|\b[a-z]+(?:-[a-z]+)*\/[a-z]+(?:-[a-z]+)*\b|\b[a-z]+(?:\.[a-z][a-zA-Z]*)+\b)/;
function prose(text, el) {
  return String(text).split(CODE_WORDS).map((part, i) => (i % 2 ? el('code', { class: 'update-code' }, part) : part));
}

function migrationLine(data, el) {
  if (data.migrates === false) return null;
  const counted = data.releases.filter((r) => typeof r.migrations === 'number').reduce((sum, r) => sum + r.migrations, 0);
  const lead = data.migrates === true
    ? `This upgrade migrates the database${counted ? ` (${plural(counted, 'migration', 'migrations')})` : ''}, and going back means restoring a backup. `
    : 'This release does not say whether it migrates the database, so treat it as one that does. ';
  return el('p', { class: 'update-migrate', role: 'note' }, lead,
    el('a', { href: docHref({ page: 'operations', anchor: 'backup-and-restore' }) }, 'Take a verified backup first'), '.');
}

function highlights(data, el) {
  const withChanges = data.releases.filter((r) => r.changes?.length).slice(0, 3);
  if (!withChanges.length) return null;
  const list = (release) => el('ul', { class: 'update-changes' }, ...release.changes.slice(0, 8).map((c) =>
    el('li', {}, el('span', { class: `chip update-kind kind-${c.kind}` }, CHANGE_KINDS[c.kind] ?? 'Changed'), ' ', c.description)));
  return el('div', { class: 'update-highlights' },
    ...withChanges.map((release, i) => el('div', {},
      el('h3', { class: 'section-h' }, i === 0 && release.version === data.latest ? 'Highlights' : `Also in ${release.version}`),
      list(release))));
}

function stepList(data, { el, copy }) {
  return el('ol', { class: 'update-step-list' }, ...data.steps.map((step) => el('li', { class: 'update-step', 'data-step': step.id },
    el('div', { class: 'update-step-head' }, el('strong', {}, step.title), step.optional ? el('span', { class: 'chip' }, 'Optional') : null),
    el('p', { class: 'sub flush' }, ...prose(step.detail, el), step.doc ? ' ' : null, step.doc ? el('a', { href: docHref(step.doc) }, 'How to back up and restore') : null),
    step.command ? el('div', { class: 'update-cmd-row' },
      el('pre', { class: 'mono update-cmd', tabindex: '0' }, step.command),
      copy(() => step.command, 'Copy')) : null)));
}

function stepsBlock(data, deps, open) {
  if (!data.steps?.length) return null;
  const name = ROUTE_NAMES[data.install?.route] ?? ROUTE_NAMES.other;
  return deps.el('details', { class: 'update-steps', ...(open ? { open: '' } : {}) },
    deps.el('summary', {}, `Upgrade steps for ${name}`),
    stepList(data, deps));
}

function checkedLine(data, { el, relTime }) {
  const host = (() => { try { return new URL(data.feedUrl).host; } catch { return 'the release feed'; } })();
  const parts = [];
  if (data.status === 'off') parts.push('Release checks are off in this deployment’s configuration (updates.check).');
  else if (data.status === 'never') parts.push('Not checked yet. The first check runs a few minutes after the server starts.');
  else if (data.status === 'failed') parts.push(`The last check failed: ${FAILURES[data.error] ?? 'the release feed could not be read'}.${data.checkedAt ? ` Last read ${relTime(data.checkedAt)}.` : ''}`);
  else parts.push(`Checked ${relTime(data.checkedAt)} from ${host}.`);
  return el('p', { class: 'muted update-checked' }, ...parts, ' The release feed is not signed, so this notice is information only. Lolly Work never upgrades itself.');
}

/**
 * The notice for a newer release. `banner` adds the Dismiss button (Overview);
 * otherwise the steps open by default (This deployment).
 */
export function updateNotice(data, deps, { banner = false, onDismiss } = {}) {
  const { el } = deps;
  if (!data?.latest) return null;
  const target = data.releases.find((r) => r.version === data.latest) ?? data.releases[0];
  const newer = data.releases.length;
  const card = el('section', { class: `card update-notice${data.security ? ' is-security' : ''}`, 'aria-label': `Lolly Work ${data.latest} is available`, 'data-version': data.latest });
  const actions = el('div', { class: 'update-actions' },
    // The server keeps https links only; checked again here before it becomes an href.
    /^https:\/\//.test(target?.notesUrl ?? '') ? el('a', { class: 'btn', href: target.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Release notes') : null,
    banner ? el('button', { type: 'button', onclick: () => { dismiss(data.latest); card.remove(); deps.announce?.(`Notice for ${data.latest} dismissed`); onDismiss?.(); } }, `Dismiss for ${data.latest}`) : null);
  card.append(
    el('div', { class: 'update-head' },
      el('div', { class: 'update-title' },
        el('h2', { class: 'flush' }, `Lolly Work ${data.latest} is available. You run ${data.current.version}.`),
        el('div', { class: 'chips update-flags' },
          data.security ? el('span', { class: 'chip update-security' }, 'Security') : null,
          data.migrates === true ? el('span', { class: 'chip update-migrates' }, 'Migrates the database') : null,
          newer > 1 ? el('span', { class: 'chip' }, plural(newer, 'newer release', 'newer releases')) : null,
          target?.prerelease ? el('span', { class: 'chip' }, 'Preview') : null,
          target?.created ? el('span', { class: 'muted update-date' }, `Published ${new Date(target.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`) : null)),
      actions),
    ...[migrationLine(data, el), highlights(data, el), stepsBlock(data, deps, !banner), checkedLine(data, deps)].filter(Boolean));
  return card;
}

/** This deployment's release card: the notice, or the state of the last check. */
export function releaseCard(data, deps, { refresh } = {}) {
  const { el, api, toast } = deps;
  const host = el('div', { class: 'update-release' });
  const render = (answer) => {
    const check = answer.check ? el('button', { type: 'button', onclick: async () => {
      check.disabled = true; check.setAttribute('aria-busy', 'true');
      try {
        const fresh = await api('/api/v1/admin/updates/check', { method: 'POST' });
        render(fresh);
        toast(fresh.latest ? `Lolly Work ${fresh.latest} is available` : fresh.status === 'ok' ? 'This is the newest release' : 'The release feed could not be read');
        refresh?.(fresh);
      } catch (error) {
        check.disabled = false; check.removeAttribute('aria-busy');
        toast(error.message || 'The check did not run');
      }
    } }, 'Check now') : null;
    const notice = updateNotice(answer, deps);
    if (notice) {
      notice.querySelector('.update-actions')?.append(...(check ? [check] : []));
      host.replaceChildren(notice);
      return;
    }
    const channel = answer.channel === 'preview' ? 'release, previews included' : 'stable release';
    host.replaceChildren(el('section', { class: 'card update-current', 'aria-label': 'Lolly Work release' },
      el('div', { class: 'update-head' },
        el('div', { class: 'update-title' },
          el('h2', { class: 'flush' }, answer.status === 'ok' ? `You run Lolly Work ${answer.current.version}, the newest ${channel}.` : `You run Lolly Work ${answer.current.version}.`)),
        check ? el('div', { class: 'update-actions' }, check) : null),
      checkedLine(answer, deps)));
  };
  render(data);
  return host;
}
