// SPDX-License-Identifier: MPL-2.0
/** Render the portable destination table as native, keyboard-operated choices. */
export function renderDocPathChoices(headers, rows, { el, inline, anchorHref }) {
  const columns = ['Destination', 'How files get there', 'Continue with'];
  if (headers.length !== columns.length || !headers.every((h, i) => h === columns[i])) return null;
  if (!rows.length || rows.some(row => row.length !== columns.length)) return null;
  const targets = rows.map(row => /^\[([^\]]+)\]\(#([a-z0-9-]+)\)$/.exec(row[2]));
  if (targets.some(target => !target)) return null;
  return el('div', { class: 'doc-paths', role: 'group', 'aria-label': 'Choose an offboarding destination' },
    ...rows.map((row, i) => el('details', { class: 'doc-path-choice', name: 'doc-destination', open: i === 0 ? '' : null },
      el('summary', {},
        el('span', { class: 'doc-path-number', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
        el('span', {}, ...inline(row[0]))),
      el('div', { class: 'doc-path-body' },
        el('p', {}, ...inline(row[1])),
        el('p', { class: 'doc-path-next' }, el('a', { href: anchorHref(targets[i][2]) }, ...inline(targets[i][1])))))));
}
