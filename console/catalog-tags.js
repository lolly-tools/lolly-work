/**
 * Hidden tags (plan 299): the console's Tags panel. Lists every label the
 * catalog carries with how many assets use it and where they come from, and
 * hides or shows them one at a time, a selection at a time, or by prefix.
 * The server applies the rules when it serves the index, so a change shows
 * up for members on their next catalog read, with no provider re-sync.
 *
 * One panel serves two scopes: `*` (every source, the Catalog view) and
 * `provider:<id>` (one provider's tags, opened from its row in Providers).
 */

const KIND_LABEL = { tag: 'tag', section: 'section', collection: 'collection' };
const PAGE = 50;

/** Where a label came from, in words an admin recognises. */
function sourceLabel(source, providers) {
  if (source === 'pack') return 'brand pack';
  if (source === 'instance') return 'uploads';
  return providers.find((p) => p.id === source)?.label ?? source;
}

/**
 * Build the panel. `scope` is '*' or 'provider:<id>'. Returns { element, load },
 * and `load()` (re)fetches the census, so a caller can open the panel before
 * spending a request on it.
 */
export function createTagPanel(scope, { el, field, api, toast, onClose }) {
  const providerId = scope.startsWith('provider:') ? scope.slice('provider:'.length) : null;
  const status = el('p', { class: 'form-err', role: 'status' });
  const search = el('input', { type: 'search', placeholder: 'Find a tag', 'aria-label': 'Find a tag' });
  const show = el('select', { 'aria-label': 'Which tags to list' },
    el('option', { value: '' }, 'All tags'),
    el('option', { value: 'shown' }, 'Shown'),
    el('option', { value: 'hidden' }, 'Hidden'));
  const sourceSel = el('select', { 'aria-label': 'Where the tags come from' }, el('option', { value: '' }, 'Every source'));
  const prefix = el('input', { type: 'text', placeholder: 'internal:', 'aria-label': 'Hide every tag starting with' });
  const patterns = el('div', { class: 'tag-patterns' });
  const list = el('div', { class: 'tag-list' });
  const summary = el('p', { class: 'sub tag-summary' });
  const selected = new Set();
  let census = null;
  let limit = PAGE;

  const heading = el('h2', { class: 'flush', tabindex: '-1' }, 'Tags');
  const hideSel = el('button', { type: 'button', disabled: '' }, 'Hide selected');
  const showSel = el('button', { type: 'button', disabled: '' }, 'Show selected');
  const selCount = el('span', { class: 'muted' });

  const ruleFor = () => census?.rules.find((r) => r.scope === scope)?.hidden ?? [];
  const canEdit = () => !!census && (scope === '*' ? census.canEdit.instance : census.canEdit.providers);
  const ownHide = (row) => row.hiddenBy.find((h) => h.scope === scope && !h.declared);
  const otherHide = (row) => row.hiddenBy.find((h) => h.scope !== scope || h.declared);

  /** Send one change, then reload the census so every count and state is the server's. */
  const change = async (body, done) => {
    status.textContent = '';
    for (const b of [hideSel, showSel]) b.disabled = true;
    try {
      await api('/api/v1/catalog/tags/rules', { method: 'PUT', body: { scope, ...body } });
      selected.clear();
      toast(done);
      await load();
    } catch (e) {
      status.textContent = e.message;
      syncBulk();
    }
  };

  const syncBulk = () => {
    const n = selected.size;
    selCount.textContent = n ? `${n} selected` : '';
    hideSel.disabled = !n || !canEdit();
    showSel.disabled = !n || !canEdit();
  };

  const stateOf = (row) => {
    const own = ownHide(row);
    if (own) return { hidden: true, text: own.pattern.toLowerCase() === row.tag.toLowerCase() ? 'Hidden' : `Hidden by ${own.pattern}` };
    const other = otherHide(row);
    if (other) {
      const where = other.scope === '*' ? 'everywhere' : `for ${sourceLabel(other.scope.slice('provider:'.length), census.providers)}`;
      return { hidden: true, inherited: true, text: other.declared ? `Hidden ${where} (instance.json)` : `Hidden ${where}` };
    }
    return { hidden: false, text: 'Shown' };
  };

  const rowFor = (row) => {
    const state = stateOf(row);
    const own = ownHide(row);
    const exact = own && own.pattern.toLowerCase() === row.tag.toLowerCase();
    const box = el('input', { type: 'checkbox', 'aria-label': `Select ${row.tag}`, ...(selected.has(row.tag) ? { checked: '' } : {}) });
    box.addEventListener('change', () => { if (box.checked) selected.add(row.tag); else selected.delete(row.tag); syncBulk(); });
    let action = null;
    const fromWholeCatalog = !own && row.hiddenBy.some((h) => h.scope === '*') && scope !== '*';
    const declaredOnly = !own && row.hiddenBy.length > 0 && row.hiddenBy.every((h) => h.declared);
    if (canEdit()) {
      if (fromWholeCatalog) {
        action = el('span', { class: 'muted' }, 'Set for the whole catalog');
      } else if (declaredOnly && scope !== '*') {
        action = el('span', { class: 'muted' }, 'Set in instance.json');
      } else if (!state.hidden || (state.inherited && !own)) {
        action = el('button', { type: 'button', onclick: () => change({ hide: [row.tag] }, `Hidden ${row.tag}`) }, 'Hide');
      } else if (exact) {
        action = el('button', { type: 'button', onclick: () => change({ show: [row.tag] }, `Showing ${row.tag}`) }, 'Show');
      } else if (own) {
        action = el('span', { class: 'muted' }, 'Remove the pattern to show');
      }
    }
    const sources = Object.entries(row.sources)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${sourceLabel(s, census.providers)} ${n}`).join(', ');
    return el('tr', {},
      el('td', {}, canEdit() ? box : null),
      el('td', {}, el('span', { class: 'tag-name' }, row.tag)),
      el('td', { class: 'muted' }, row.kinds.map((k) => KIND_LABEL[k] ?? k).join(', ')),
      el('td', { class: 'num', 'data-sort': String(row.count) }, String(row.count)),
      el('td', { class: 'muted' }, el('span', { class: 'trunc', title: sources }, sources)),
      el('td', {}, el('span', { class: `status ${state.hidden ? 'expired' : 'live'}` }, state.text)),
      el('td', {}, action));
  };

  const visibleRows = () => {
    const q = search.value.trim().toLowerCase();
    const want = show.value;
    const src = sourceSel.value;
    return (census?.tags ?? []).filter((row) => {
      if (q && !row.tag.toLowerCase().includes(q)) return false;
      if (src && !row.sources[src]) return false;
      if (want) {
        const hidden = stateOf(row).hidden;
        if (want === 'hidden' ? !hidden : hidden) return false;
      }
      return true;
    });
  };

  const renderList = () => {
    const rows = visibleRows();
    const shown = rows.slice(0, limit);
    const selectShown = el('button', { type: 'button', onclick: () => { for (const r of shown) selected.add(r.tag); renderList(); syncBulk(); } }, 'Select all listed');
    const clear = el('button', { type: 'button', onclick: () => { selected.clear(); renderList(); syncBulk(); } }, 'Clear selection');
    list.replaceChildren(
      rows.length
        ? el('div', { class: 'tbl-scroll tbl-cards' }, el('table', {},
            el('thead', {}, el('tr', {}, ...['', 'Tag', 'Kind', 'Assets', 'Sources', 'State', ''].map((h) => el('th', { scope: 'col' }, h)))),
            el('tbody', {}, ...shown.map(rowFor).map((tr) => {
              const labels = ['', 'Tag', 'Kind', 'Assets', 'Sources', 'State', ''];
              [...tr.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; });
              return tr;
            }))))
        : el('p', { class: 'empty' }, census?.tags.length ? 'No tags match.' : 'No tags yet. Tags appear here once a provider has synced or assets carry them.'),
      el('div', { class: 'list-bar tag-more' },
        el('span', { class: 'muted' }, rows.length > shown.length ? `Showing ${shown.length} of ${rows.length}` : `${rows.length} listed`),
        el('span', { class: 'lc-actions' },
          canEdit() && shown.length ? selectShown : null,
          canEdit() && selected.size ? clear : null,
          rows.length > shown.length ? el('button', { type: 'button', onclick: () => { limit += PAGE; renderList(); } }, 'Show more') : null)));
  };

  const renderPatterns = () => {
    const mine = ruleFor().filter((p) => p.endsWith('*'));
    const declared = providerId ? (census.providers.find((p) => p.id === providerId)?.declared ?? []) : [];
    patterns.replaceChildren(
      ...(mine.length || declared.length
        ? [el('div', { class: 'chips' },
            ...mine.map((p) => el('span', { class: 'chip' }, p,
              canEdit() ? el('button', { type: 'button', class: 'link-btn', 'aria-label': `Stop hiding ${p}`, onclick: () => change({ show: [p] }, `Stopped hiding ${p}`) }, 'Remove') : null)),
            ...declared.map((p) => el('span', { class: 'chip', title: 'Set in instance.json' }, `${p} (instance.json)`)))]
        : []));
  };

  const render = () => {
    summary.textContent = census
      ? `${census.total} tag${census.total === 1 ? '' : 's'} across ${scope === '*' ? 'the catalog' : sourceLabel(providerId, census.providers)}. ${ruleFor().length} hidden in this list.`
      : '';
    if (census && !providerId && sourceSel.options.length === 1) {
      const sources = new Set(census.tags.flatMap((r) => Object.keys(r.sources)));
      for (const s of sources) sourceSel.append(el('option', { value: s }, sourceLabel(s, census.providers)));
    }
    renderPatterns();
    renderList();
    syncBulk();
  };

  async function load() {
    status.textContent = '';
    try {
      census = await api(`/api/v1/catalog/tags${providerId ? `?provider=${encodeURIComponent(providerId)}` : ''}`);
      if (providerId) heading.textContent = `Tags from ${sourceLabel(providerId, census.providers)}`;
      render();
    } catch (e) {
      list.replaceChildren(el('p', { class: 'sub' }, 'Could not load the tags.'));
      status.textContent = e.message;
    }
  }

  search.addEventListener('input', () => { limit = PAGE; renderList(); });
  show.addEventListener('change', () => { limit = PAGE; renderList(); });
  sourceSel.addEventListener('change', () => { limit = PAGE; renderList(); });
  hideSel.addEventListener('click', () => change({ hide: [...selected] }, `Hidden ${selected.size} tag${selected.size === 1 ? '' : 's'}`));
  showSel.addEventListener('click', () => {
    // Only a tag hidden by its own exact entry can be shown from a row; a
    // pattern is removed from the pattern list instead.
    const own = new Set(ruleFor().map((p) => p.toLowerCase()));
    const tags = [...selected].filter((t) => own.has(t.toLowerCase()));
    if (!tags.length) { status.textContent = 'None of the selected tags is hidden in this list.'; return; }
    void change({ show: tags }, `Showing ${tags.length} tag${tags.length === 1 ? '' : 's'}`);
  });
  const hidePrefix = el('button', { type: 'button', onclick: () => {
    const p = prefix.value.trim().replace(/\*+$/, '');
    if (!p) { status.textContent = 'Type the start of the tags to hide.'; return; }
    prefix.value = '';
    void change({ hide: [`${p}*`] }, `Hiding tags starting with ${p}`);
  } }, 'Hide matching');

  const element = el('div', { class: 'card stack tag-panel' },
    el('div', { class: 'list-bar' }, heading, onClose ? el('button', { type: 'button', onclick: onClose }, 'Close') : null),
    el('p', { class: 'sub' }, scope === '*'
      ? 'Hide labels that are noise for your members, such as internal workflow tags from a DAM. A hidden tag leaves the catalog filters, tag chips and search at once. The asset stays in the catalog, and nothing re-syncs.'
      : 'Hide labels this provider sends that are noise for your members. Only this provider’s assets are affected. A hidden tag leaves the catalog filters, tag chips and search at once, and nothing re-syncs.'),
    summary,
    el('div', { class: 'form-inline tag-tools' },
      field('Find', search), field('Show', show), providerId ? null : field('Source', sourceSel)),
    el('div', { class: 'form-inline tag-tools' },
      field('Hide every tag starting with', prefix), hidePrefix),
    patterns,
    el('div', { class: 'list-bar tag-bulk' }, selCount, el('span', { class: 'lc-actions' }, hideSel, showSel)),
    list,
    status);

  return { element, load, focus: () => heading.focus({ preventScroll: true }) };
}
