/**
 * lolly-work admin console — no-build ES module (served by the server itself,
 * zero external assets). Every API call is auth-enforced server-side; this
 * shell renders honestly whatever the caller is entitled to.
 *
 * Charts follow the dataviz method: validated categorical slots (series-1..3),
 * 2px lines, ≤16px bars with 4px rounded data-ends, hairline grid, text in
 * text tokens (never series colors), hover tooltips, and a table view under
 * every chart (the contrast-relief obligation for light-mode aqua).
 */

import { compareValues } from './table-sort.js';

const $app = document.getElementById('app');
const $tip = document.getElementById('tip');
const $live = document.getElementById('live');

// Push transient status to the single shared polite live region (index.html),
// so state changes (view loaded, a confirm armed, an action's result) are
// announced to assistive tech without a visual-only cue. Clearing first makes a
// repeated identical message re-announce.
function announce(msg) {
  if (!$live) return;
  $live.textContent = '';
  requestAnimationFrame(() => { $live.textContent = msg; });
}

// Visible transient confirmation for a successful mutation (revoke, save, send,
// …) that ALSO announces to assistive tech — so every success reads the same
// way instead of a silent page flash. One toast at a time; auto-dismisses.
// Scroll a just-opened panel into view, honouring reduced-motion.
function scrollIntoViewMotionSafe(node) {
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest' });
}

let _toastTimer = null;
function toast(msg) {
  announce(msg);
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ── api ─────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? res.statusText), { status: res.status, code: data?.error?.code });
  return data;
}

// ── tiny dom helpers ────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = tag.includes(':svg')
    ? document.createElementNS('http://www.w3.org/2000/svg', tag.replace(':svg', ''))
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.setAttribute('class', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
const fmt = (n) => n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
// Seconds → a compact duration ("45s" / "38m" / "6.2h" / "3.1d"); ≤0/NaN → '0m'.
function fmtDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0m';
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = s / 60; if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60; if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  const d = h / 24; return `${d < 10 ? d.toFixed(1) : Math.round(d)}d`;
}
// Bytes → a compact human size, or null for a non-numeric/absent size.
function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ── shared table ──────────────────────────────────────────────────────────
// One accessible, consistent table for every view: a real <thead> with
// scope="col" headers and a <tbody> of rows (so hover never lights the header,
// and numeric headers right-align over their values). A column is a string, or
// { label, num, w } — num right-aligns + adds tabular figures, w hints a width.
function th(col, idx = 0, sortable = false, onSort = null) {
  const c = typeof col === 'string' ? { label: col } : col;
  const attrs = {};
  if (c.num) attrs.class = 'num';
  if (c.w) attrs.style = `width:${c.w}`;
  attrs.scope = 'col';
  // A sortable header renders its label as a button and carries aria-sort. Skip
  // when the column opts out (sort:false — actions/icon columns) or the label is
  // already a DOM node (e.g. People's own server-sort buttons), so it can't
  // double-wire. Everything else is byte-identical to before.
  const canSort = sortable && c.sort !== false && (c.label == null || typeof c.label === 'string');
  if (canSort) {
    attrs['aria-sort'] = 'none';
    return el('th', attrs, el('button', {
      class: 'col-sort', type: 'button', onclick: () => onSort(idx),
      'aria-label': `Sort by ${c.label ?? 'column'}`,
    }, c.label ?? '', el('span', { class: 'sort-caret', 'aria-hidden': 'true' }, '')));
  }
  return el('th', attrs, c.label ?? '');
}

// A tbody cell's sort value: an explicit data-sort (canonical number/date) wins,
// else the rendered text. Blank/em-dash cells sort last (see compareValues).
const cellSortVal = (tr, i) => {
  const td = tr.children[i];
  if (!td) return '';
  return td.dataset && td.dataset.sort !== undefined ? td.dataset.sort : td.textContent.trim();
};
const isBlankCell = (s) => s === '' || s === '—';

// Quality-of-life defaults, tuned for very large orgs (a directory or grant
// list can run to thousands of rows): sorting is ON unless a table opts out
// (opts.sortable === false); a search box + live match count appears from
// FILTER_AT rows; a client-side pager caps the rendered DOM from PAGE_AT rows;
// and any table that grew a bar can export its CURRENT view (filtered + sorted)
// as CSV. Explicit opts always win over the row-count heuristics:
//   { sortable, filter, paginate, pageSize, csv, csvName }
const FILTER_AT = 8;
const PAGE_AT = 26;
const PAGE_SIZES = [25, 50, 100, 250];

function dataTable(cols, rows, opts = {}) {
  const norm = cols.map((c) => (typeof c === 'string' ? { label: c } : c));
  const original = rows.slice();
  const origIx = new Map(original.map((tr, i) => [tr, i])); // stable tie-break
  const sortable = opts.sortable !== false;
  const hasFilter = opts.filter ?? original.length >= FILTER_AT;
  const hasPager = opts.paginate ?? original.length >= PAGE_AT;
  const hasCsv = opts.csv ?? (hasFilter || hasPager);

  const tbody = el('tbody');
  let sIdx = -1;
  let sDir = 0; // 0 none, 1 asc, -1 desc
  let q = '';
  let page = 1;
  let pageSize = hasPager ? (opts.pageSize || PAGE_SIZES[0]) : Infinity;

  // The rows that survive the search, in display order.
  function currentRows() {
    let list = q ? original.filter((tr) => tr.textContent.toLowerCase().includes(q)) : original;
    if (sDir !== 0) {
      const type = norm[sIdx]?.sort === 'date' ? 'date' : norm[sIdx]?.num ? 'number' : 'auto';
      list = list.slice().sort((ta, tb) => {
        const a = cellSortVal(ta, sIdx);
        const b = cellSortVal(tb, sIdx);
        const ea = isBlankCell(a);
        const eb = isBlankCell(b);
        // Blanks are terminal-last in BOTH directions — never multiplied by sDir.
        if (ea && eb) return origIx.get(ta) - origIx.get(tb);
        if (ea) return 1;
        if (eb) return -1;
        const d = compareValues(a, b, type);
        return d !== 0 ? d * sDir : origIx.get(ta) - origIx.get(tb);
      });
    }
    return list;
  }

  function apply() {
    for (let i = 0; i < heads.length; i++) {
      const active = i === sIdx && sDir !== 0;
      heads[i].setAttribute('aria-sort', active ? (sDir === 1 ? 'ascending' : 'descending') : 'none');
      const btn = heads[i].querySelector('.col-sort');
      if (btn) {
        btn.classList.toggle('active', active);
        const caret = btn.querySelector('.sort-caret');
        if (caret) caret.textContent = active ? (sDir === 1 ? '▲' : '▼') : '';
      }
    }
    const list = currentRows();
    const pages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(list.length / pageSize)) : 1;
    if (page > pages) page = pages;
    const start = Number.isFinite(pageSize) ? (page - 1) * pageSize : 0;
    const shown = Number.isFinite(pageSize) ? list.slice(start, start + pageSize) : list;
    tbody.replaceChildren(...shown);
    if (count) {
      const total = list.length === original.length ? fmt(original.length) : `${fmt(list.length)} of ${fmt(original.length)}`;
      count.textContent = shown.length === list.length ? total : `${fmt(start + 1)}–${fmt(start + shown.length)} of ${total}`;
    }
    if (pager) {
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = start + shown.length >= list.length;
      pageNote.textContent = `page ${fmt(page)} of ${fmt(pages)}`;
    }
  }
  function onSort(i) {
    if (norm[i].sort === false) return;
    if (sIdx === i) sDir = sDir === 1 ? -1 : sDir === -1 ? 0 : 1;
    else { sIdx = i; sDir = 1; }
    page = 1;
    apply();
  }

  const heads = norm.map((c, i) => th(c, i, sortable, onSort));
  // Phone card layout (styles.css .tbl-cards): each cell carries its column
  // header as data-label so a stacked row still names its values. 4+ columns
  // is the "too wide to side-scroll" heuristic; narrower tables stay tables.
  // Node labels (e.g. People's server-sort buttons) contribute their text, sans
  // any sort caret — "Name", not "Name▲" — for the card-layout data-labels.
  const labelText = (c) => (typeof c.label === 'string' ? c.label : c.label?.textContent ?? '').replace(/[▲▼]/g, '').trim();
  for (const tr of original) {
    for (let i = 0; i < tr.children.length; i++) {
      const l = labelText(norm[i] ?? {});
      if (l) tr.children[i].dataset.label = l;
    }
  }
  const scroll = el('div', { class: `tbl-scroll${norm.length >= 4 ? ' tbl-cards' : ''}` },
    el('table', {}, el('thead', {}, el('tr', {}, ...heads)), tbody));
  // Sticky headers need overflow-x:clip (no scroll container); only a table
  // that genuinely overflows trades them for horizontal scrolling. Measured
  // after the caller mounts us (rAF fires post-layout).
  requestAnimationFrame(() => {
    if (scroll.isConnected && scroll.scrollWidth > scroll.clientWidth + 1) scroll.classList.add('is-scrollx');
  });

  // Bar: search + match count (left), CSV export of the current view (right).
  const count = hasFilter || hasPager ? el('span', { class: 'tbl-filter-count muted', role: 'status' }) : null;
  const input = hasFilter ? el('input', {
    type: 'search', class: 'tbl-filter', placeholder: 'Search rows…', 'aria-label': 'Search rows',
    oninput: (e) => { q = e.target.value.trim().toLowerCase(); page = 1; apply(); },
  }) : null;
  const csvBtn = hasCsv ? el('button', {
    class: 'tbl-csv', type: 'button', title: 'Download the current view (search + sort applied) as CSV',
    onclick: () => {
      const cellText = (n) => n.textContent.replace(/\s+/g, ' ').trim();
      const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const lines = [heads.map(cellText), ...currentRows().map((tr) => Array.from(tr.children, cellText))]
        .map((cells) => cells.map(esc).join(',')).join('\r\n');
      // Leading BOM so Excel opens the UTF-8 file with accents intact.
      const url = URL.createObjectURL(new Blob(['\ufeff' + lines], { type: 'text/csv' }));
      const a = el('a', { href: url, download: `${opts.csvName || 'export'}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  }, 'CSV') : null;

  // Pager: prev/next + page size, all client-side over the filtered list.
  let prevBtn, nextBtn, pageNote, pager = null;
  if (hasPager) {
    prevBtn = el('button', { type: 'button', onclick: () => { page -= 1; apply(); } }, '‹ Prev');
    nextBtn = el('button', { type: 'button', onclick: () => { page += 1; apply(); } }, 'Next ›');
    pageNote = el('span', { class: 'tbl-page-note' });
    const sizeSel = el('select', { 'aria-label': 'Rows per page' },
      ...PAGE_SIZES.map((n) => el('option', { value: n, selected: n === pageSize ? 'selected' : null }, `${n} / page`)),
      el('option', { value: 'all' }, 'All'));
    sizeSel.onchange = () => { pageSize = sizeSel.value === 'all' ? Infinity : Number(sizeSel.value); page = 1; apply(); };
    pager = el('div', { class: 'tbl-pager' }, prevBtn, nextBtn, sizeSel, pageNote);
  }

  apply();
  if (!input && !csvBtn && !pager) return scroll;
  const bar = (input || csvBtn || count) ? el('div', { class: 'tbl-bar' }, input, count, csvBtn) : null;
  return el('div', { class: 'data-tbl' }, bar, scroll, pager);
}

// A view's inline error/status line — the same markup everywhere a form or
// row-action reports its result (`role="status"` so assistive tech reads it).
const errSpan = () => el('span', { class: 'form-err', role: 'status' });

// Auto-wire a <label for> to its control by generating a stable id, so every
// field is programmatically associated (screen readers announce the label with
// the control). Returns the wrapping div used inside .formrow and forms.
let _fieldSeq = 0;
function field(labelText, control, attrs = {}) {
  if (!control.id) control.id = `fld-${++_fieldSeq}`;
  return el('div', attrs, el('label', { for: control.id }, labelText), control);
}

// Cells that carry a canonical `data-sort` value so a sortable column orders by
// the real number/date, not the formatted text ("12K", "3 days ago").
function numCell(value, formatted) {
  return el('td', { class: 'num', 'data-sort': Number.isFinite(value) ? String(value) : '' }, formatted ?? fmt(value));
}
function whenCell(iso) {
  return el('td', { 'data-sort': iso ?? '' }, when(iso));
}

const CONFIRM_ARM_MS = 4000; // how long a "Really …?" arm stays live before disarming itself

/** Two-click arm/confirm button — no window.confirm. First click arms it
 *  (showing armedLabel) and self-disarms after CONFIRM_ARM_MS so a stray click
 *  days later can't fire a stale action; a second click while armed calls
 *  onConfirm(disarm), which is responsible for its own busy/error handling and
 *  for calling disarm() again on failure. idleLabel may be a string or a
 *  () => string for a count-dependent label. */
function armConfirmButton(attrs, idleLabel, armedLabel, onConfirm) {
  const labelText = () => (typeof idleLabel === 'function' ? idleLabel() : idleLabel);
  let armed = false;
  let armTimer = null;
  const disarm = () => { armed = false; btn.textContent = labelText(); };
  const btn = el('button', { ...attrs, onclick: async () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      announce(`${armedLabel} Activate again to confirm.`);
      armTimer = setTimeout(disarm, CONFIRM_ARM_MS);
      return;
    }
    clearTimeout(armTimer);
    await onConfirm(disarm);
  } }, labelText());
  return btn;
}

// The loading state of the load/empty/error triad: a quiet placeholder shown
// synchronously while a view's api() call is in flight, swapped for real content
// (or an empty/error state) when it resolves. Reduced-motion-safe (no spinner).
function loadingCard(label) {
  // A labelled loading state with a lightweight skeleton so a slow fetch reads as
  // "X is loading", not a blank card. The shimmer is gated on reduced-motion in CSS.
  return el('div', { class: 'card loading-card' },
    el('p', { class: 'sub flush' }, label ? `Loading ${label}…` : 'Loading…'),
    el('div', { class: 'skeleton-rows', 'aria-hidden': 'true' },
      ...Array.from({ length: 4 }, () => el('div', { class: 'sk-row' }))));
}

function showTip(evt, html) {
  $tip.innerHTML = html;
  $tip.hidden = false;
  const pad = 12;
  const x = Math.min(evt.clientX + pad, window.innerWidth - $tip.offsetWidth - pad);
  const y = Math.min(evt.clientY + pad, window.innerHeight - $tip.offsetHeight - pad);
  $tip.style.left = `${x}px`;
  $tip.style.top = `${y}px`;
}
const hideTip = () => { $tip.hidden = true; };

// ── charts ──────────────────────────────────────────────────────────────────
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

/** Two-series day line chart with crosshair + tooltip, end labels, clean y ticks. */
function lineChart(days, series /* [{key,label}] */) {
  const W = 640, H = 200, L = 34, R = 86, T = 10, B = 22;
  const max = Math.max(1, ...days.flatMap((d) => series.map((s) => d[s.key])));
  const step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 100 ? 25 : 10 ** Math.floor(Math.log10(max)) / 2;
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (i / Math.max(1, days.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);

  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.label).join(' and ') + ' per day' });
  for (let v = 0; v <= top; v += step) {
    svg.append(el('line:svg', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--baseline)' : 'var(--grid)', 'stroke-width': 1 }));
    svg.append(el('text:svg', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, fmt(v)));
  }
  days.forEach((d, i) => {
    if (i % Math.ceil(days.length / 7) === 0 || i === days.length - 1) {
      svg.append(el('text:svg', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, d.date.slice(5)));
    }
  });
  // End labels sit at each series' final y — but series that end near the same
  // value (every series 0 in a quiet window) would print on top of each other.
  // Nudge collisions apart top-down at a 12px minimum, then shift the stack up
  // if the bottom label would leave the plot.
  const last = days[days.length - 1];
  const ends = series.map((s, si) => ({ si, y: y(last[s.key]), ly: 0 }));
  ends.sort((a, b) => a.y - b.y);
  let prevLy = -Infinity;
  for (const e of ends) { e.ly = Math.max(e.y, prevLy + 12); prevLy = e.ly; }
  const overflow = Math.max(0, (ends[ends.length - 1]?.ly ?? 0) - (H - B - 4));
  const labelY = new Map(ends.map((e) => [e.si, e.ly - overflow]));
  series.forEach((s, si) => {
    const path = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[s.key]).toFixed(1)}`).join('');
    svg.append(el('path:svg', { d: path, fill: 'none', stroke: SERIES[si], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    // end marker: ≥8px with a 2px surface ring
    svg.append(el('circle:svg', { cx: x(days.length - 1), cy: y(last[s.key]), r: 4, fill: SERIES[si], stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.append(el('text:svg', { x: W - R + 10, y: labelY.get(si) + 3.5, 'font-size': 11, fill: 'var(--ink-2)' },
      `${s.label} ${fmt(last[s.key])}`));
  });
  // crosshair + tooltip layer
  const cross = el('line:svg', { y1: T, y2: H - B, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const hit = el('rect:svg', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
  hit.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - L) / (W - L - R)) * (days.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    const rows = series.map((s, si) =>
      `<div class="t-row"><span class="swatch" style="background:${SERIES[si]}"></span>${s.label}: <b>${fmt(days[i][s.key])}</b></div>`).join('');
    showTip(evt, `<div class="t-title">${days[i].date}</div>${rows}`);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  svg.append(hit);

  const legend = el('div', { class: 'legend' },
    ...series.map((s, si) => el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${SERIES[si]}` }), s.label)));
  const table = el('details', { class: 'tbl' }, el('summary', {}, 'View as table'),
    dataTable(['Date', ...series.map((s) => ({ label: s.label, num: true }))],
      days.map((d) => el('tr', {}, el('td', {}, d.date), ...series.map((s) => el('td', { class: 'num' }, d[s.key]))))));
  return el('div', { class: 'chart' }, legend, svg, table);
}

/** Horizontal bars: 14px thick, 4px rounded data-end, value at the tip, hover tooltip. */
function hbarChart(rows, { color = SERIES[0], colorOf = null, unit = '', empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return el('p', { class: 'empty' }, empty);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const chart = el('div', { class: 'hbar' },
    ...rows.flatMap((r) => {
      const c = colorOf ? colorOf(r) : color;
      const bar = el('div', {
        class: 'bar',
        style: `width:${Math.max(1.2, (r.value / max) * 100)}%;background:${c}`,
        onmousemove: (evt) => showTip(evt, `<div class="t-row"><span class="swatch" style="background:${c}"></span>${r.label}: <b>${fmt(r.value)}${unit}</b></div>`),
        onmouseleave: hideTip,
      });
      return [
        el('div', { class: 'lbl', title: r.label }, r.label),
        el('div', { class: 'track' }, bar, el('span', { class: 'val' }, fmt(r.value))),
      ];
    }));
  const table = el('details', { class: 'tbl' }, el('summary', {}, 'View as table'),
    dataTable(['Item', { label: 'Count', num: true }],
      rows.map((r) => el('tr', {}, el('td', {}, r.label), el('td', { class: 'num' }, r.value)))));
  return el('div', { class: 'chart' }, chart, table);
}

function tile(label, value) {
  return el('div', { class: 'card tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value));
}

// ── per-view activity header ─────────────────────────────────────────────────
// Every topic view opens with the same shape: a 30-day line of ITS slice of
// the audit stream + three computed insight tiles (total, delta vs the prior
// 30 days, busiest day). One fetch (60 days, counts only) serves every view —
// memoized below — and a viewer without telemetry.view simply sees no header
// (fetch-tolerant, like stats on the Overview). Series hues follow SERIES in
// fixed order; deltas stay in ink (an activity swing is not a status).
let seriesMemo = { at: 0, p: null };
function fetchSeries() {
  if (!seriesMemo.p || Date.now() - seriesMemo.at > 30_000) {
    seriesMemo = { at: Date.now(), p: api('/api/v1/stats/series?days=60').catch(() => null) };
  }
  return seriesMemo.p;
}

// A matcher is an exact action name, a 'prefix.' (trailing dot ⇒ startsWith),
// or '*' (every action) — mirrors how audit actions namespace themselves.
function countMatching(counts, matchers) {
  let n = 0;
  for (const [action, c] of Object.entries(counts)) {
    if (matchers.some((m) => m === '*' || (m.endsWith('.') ? action.startsWith(m) : action === m))) n += c;
  }
  return n;
}

async function activityHeader(caption, seriesDef /* [{key,label,match:[…]}] */, extraTiles = []) {
  const data = await fetchSeries();
  if (!data?.days?.length) return null;
  const rows = data.days.map((d) => {
    const r = { date: d.date };
    for (const s of seriesDef) r[s.key] = countMatching(d.counts, s.match);
    return r;
  });
  const win = rows.slice(-30);
  const prior = rows.slice(0, -30);
  const dayTotal = (r) => seriesDef.reduce((a, s) => a + r[s.key], 0);
  const total = win.reduce((a, r) => a + dayTotal(r), 0);
  const prev = prior.reduce((a, r) => a + dayTotal(r), 0);
  const busiest = win.reduce((b, r) => (dayTotal(r) > dayTotal(b) ? r : b), win[0]);
  const delta = prev ? Math.round(((total - prev) / prev) * 100) : null;
  return el('div', { class: 'card' },
    el('p', { class: 'sub flush' }, caption),
    el('div', { class: 'grid tiles' },
      tile('Last 30 days', fmt(total)),
      tile('vs prior 30 days', delta === null ? (total ? 'new activity' : '—') : delta === 0 ? 'level' : `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)}%`),
      tile('Busiest day', total ? `${busiest.date.slice(5)} · ${fmt(dayTotal(busiest))}` : '—'),
      ...extraTiles),
    lineChart(win, seriesDef.map(({ key, label }) => ({ key, label }))));
}

// ── pack-token theming (plans/16 §2.1) ───────────────────────────────────────
// At boot, read the instance's mounted brand pack — the same DTCG tokens the
// tools consume (catalog/assets/<brand>/tokens/*.json, same shape as
// community/brand asset "type": "tokens" entries in catalog/assets/index.json)
// — and map ONLY chrome roles onto CSS custom properties: --accent (nav/
// focus/primary buttons) and, only when the pack clearly names distinct
// light+dark surface colors, a subtle tint on --plane/--surface. Chart series
// (--series-1/2/3) and status colors are NEVER touched — they stay the
// validated dataviz palette regardless of brand (styles.css hardcodes them).
// Every failure mode below — no pack mounted, 401/404, malformed tokens, no
// color that reads as primary/brand/accent, or an accent too low-contrast to
// use — returns early and leaves the neutral tokens exactly as they are; the
// CSS var() fallbacks in styles.css are what makes that silent.

function resolveCssColor(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const probe = document.createElement('span');
  probe.style.color = raw;
  if (!probe.style.color) return null; // rejected outright — not a color string
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const m = computed.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function relativeLuminance({ r, g, b }) {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a, b) {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function toHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Flatten one DTCG token set to {"a.b.c": {raw, type}}, letting $type
 *  inherit down through groups (per the DTCG spec) and skipping $-metadata
 *  keys ($description, $extensions, …). */
function flattenTokenSet(node, path = [], inheritedType = null, out = {}) {
  if (!node || typeof node !== 'object') return out;
  const type = node.$type ?? inheritedType;
  if (Object.prototype.hasOwnProperty.call(node, '$value')) {
    out[path.join('.')] = { raw: node.$value, type };
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith('$')) flattenTokenSet(v, [...path, k], type, out);
  }
  return out;
}

/** Resolve `{a.b.c}` alias values within a flattened set map, in place. */
function resolveAliases(map) {
  const resolve = (key, seen) => {
    const entry = map[key];
    if (!entry) return undefined;
    if (entry.resolved !== undefined) return entry.resolved;
    const m = typeof entry.raw === 'string' && entry.raw.match(/^\{([^}]+)\}$/);
    if (!m || seen.has(key)) return (entry.resolved = entry.raw);
    seen.add(key);
    entry.resolved = resolve(m[1], seen) ?? entry.raw;
    return entry.resolved;
  };
  for (const key of Object.keys(map)) resolve(key, new Set());
}

/** Build {light, dark} flattened+resolved token maps, honouring the file's
 *  $themes/selectedTokenSets when present (so `{color.brand.pine}` aliases
 *  from a shared "base" set resolve inside each theme); a pack with no
 *  $themes gets one merged map used for both — the "pack gives one accent,
 *  use it for both" case. */
function buildThemeMaps(tokens) {
  const setNames = Object.keys(tokens).filter((k) => !k.startsWith('$'));
  const flat = Object.fromEntries(setNames.map((n) => [n, flattenTokenSet(tokens[n])]));
  const maps = {};
  for (const t of Array.isArray(tokens.$themes) ? tokens.$themes : []) {
    const merged = {};
    for (const [setName, state] of Object.entries(t.selectedTokenSets ?? {})) {
      if (state === 'enabled' && flat[setName]) Object.assign(merged, flat[setName]);
    }
    maps[/dark/i.test(t.name ?? '') ? 'dark' : 'light'] = merged;
  }
  if (!maps.light && !maps.dark) {
    maps.light = maps.dark = Object.assign({}, ...setNames.map((n) => flat[n]));
  } else {
    maps.light ??= maps.dark;
    maps.dark ??= maps.light;
  }
  resolveAliases(maps.light);
  if (maps.dark !== maps.light) resolveAliases(maps.dark);
  return maps;
}

const CHROME_ROLE_SCORE = (seg) => {
  if (/^on-|foreground|-text$/i.test(seg)) return -1; // "on-primary" etc — not a chrome fill
  if (seg === 'primary') return 3;
  if (seg === 'accent') return 2.5;
  if (seg === 'brand') return 2;
  if (seg.includes('primary')) return 1.5;
  if (seg.includes('accent')) return 1;
  if (seg.includes('brand')) return 0.5;
  return 0;
};

/** Best chrome-accent candidate: an opaque, resolvable color whose OWN name
 *  reads as primary/accent/brand — never a series/status/secondary token,
 *  never a group container, only a leaf value. */
function pickAccent(map) {
  let best = null;
  for (const [path, entry] of Object.entries(map)) {
    if (entry.type && entry.type !== 'color') continue;
    const score = CHROME_ROLE_SCORE(path.split('.').pop().toLowerCase());
    if (score <= 0 || (best && score <= best.score)) continue;
    const rgb = resolveCssColor(entry.resolved ?? entry.raw);
    if (!rgb || rgb.a < 0.99) continue;
    best = { score, rgb };
  }
  return best?.rgb ?? null;
}

/** A surface candidate only when the map names one explicitly — gates the
 *  optional tint; a surface is never inferred from an arbitrary color. */
function pickSurface(map) {
  for (const [path, entry] of Object.entries(map)) {
    if (entry.type && entry.type !== 'color') continue;
    if (!['surface', 'background', 'plane', 'canvas'].includes(path.split('.').pop().toLowerCase())) continue;
    const rgb = resolveCssColor(entry.resolved ?? entry.raw);
    if (rgb && rgb.a >= 0.99) return rgb;
  }
  return null;
}

const NEUTRAL_PLANE = { light: { r: 0xff, g: 0xff, b: 0xff }, dark: { r: 0x03, g: 0x07, b: 0x11 } };

// ── brand fonts ──────────────────────────────────────────────────────────────
// The pack names its families in tokens (e.g. base.font.brand = "SUSE",
// base.font.mono = "SUSE Mono"); the webfont files live under the served
// /catalog/fonts/webfonts/. We read the family names from the same token maps,
// resolve each to a woff2 by the standard webfont naming convention (a variable
// "<Family>[wght].woff2" first, else "<Family>-Regular.woff2"), load it via the
// FontFace API, and set --font-sans / --font-mono. Every step is best-effort:
// a pack that names no fonts, or whose files aren't there, silently keeps the
// system stack (styles.css var() fallbacks). No @font-face string-building, so
// the bracketed variable-font filenames need no CSS-url escaping — only the
// fetch URL is percent-encoded.
function findFontFamily(maps, leaf) {
  const re = new RegExp(`(^|\\.)font\\.${leaf}$`, 'i');
  for (const map of [maps.light, maps.dark]) {
    for (const [key, entry] of Object.entries(map)) {
      if (!re.test(key)) continue;
      const val = entry.resolved ?? entry.raw;
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  }
  return null;
}

async function loadPackFont(family, cssVar, fontUrlFor) {
  if (!family || typeof document.fonts?.add !== 'function' || typeof FontFace !== 'function') return;
  const base = family.replace(/\s+/g, '');
  const candidates = [
    { file: `${base}[wght].woff2`, weight: '100 900' }, // variable — full weight range
    { file: `${base}-Regular.woff2`, weight: '400' },   // static fallback
  ];
  for (const c of candidates) {
    try {
      const res = await fetch(fontUrlFor(c.file), { credentials: 'same-origin' });
      if (!res.ok) continue;
      const face = new FontFace(family, await res.arrayBuffer(), { weight: c.weight, style: 'normal', display: 'swap' });
      await face.load();
      document.fonts.add(face);
      const fallback = cssVar === '--font-mono' ? 'var(--font-mono-sys)' : 'var(--font-sys)';
      document.documentElement.style.setProperty(cssVar, `"${family}", ${fallback}`);
      return;
    } catch { /* try the next candidate, else keep the system stack */ }
  }
}

async function applyPackFonts(maps, fontUrlFor) {
  await Promise.allSettled([
    loadPackFont(findFontFamily(maps, 'brand') || findFontFamily(maps, 'sans'), '--font-sans', fontUrlFor),
    loadPackFont(findFontFamily(maps, 'mono'), '--font-mono', fontUrlFor),
  ]);
}

// Apply fonts + chrome accent from a resolved DTCG token object. `fontUrlFor`
// builds the fetch URL for a webfont filename — different per source (the
// authenticated catalog path vs the unauthenticated /api/brand path used by the
// sign-in gate), but the parsing, contrast guard, and mapping are identical.
async function themeFromTokens(tokens, fontUrlFor) {
  if (!tokens || typeof tokens !== 'object') return;
  let maps;
  try { maps = buildThemeMaps(tokens); } catch { return; }

  // Fonts are independent of the accent contrast guard below — a pack with a
  // brand font but no chrome-shaped colour still gets its typeface. A font that
  // fails to load must NEVER short-circuit the colour theming that follows.
  await applyPackFonts(maps, fontUrlFor).catch(() => {});

  const accentLight = pickAccent(maps.light);
  const accentDark = pickAccent(maps.dark) ?? accentLight;
  const finalLight = accentLight ?? accentDark;
  const finalDark = accentDark ?? accentLight;
  if (!finalLight && !finalDark) return; // nothing chrome-shaped in this pack

  // Contrast guard: only apply an accent in a mode where it actually reads
  // against that mode's plane; if it fails in both, skip theming entirely
  // rather than ship an illegible accent.
  const okLight = !!finalLight && contrastRatio(finalLight, NEUTRAL_PLANE.light) >= 3;
  const okDark = !!finalDark && contrastRatio(finalDark, NEUTRAL_PLANE.dark) >= 3;
  if (!okLight && !okDark) return;

  // Primary buttons paint white text over --accent (styles.css); a light-
  // toned accent (e.g. a mid-green "jungle") reads better with black text —
  // pick whichever wins, per mode, off the same contrast math as the guard.
  const BLACK = { r: 0, g: 0, b: 0 };
  const WHITE = { r: 255, g: 255, b: 255 };
  const onAccentFor = (rgb) => (contrastRatio(rgb, BLACK) >= contrastRatio(rgb, WHITE) ? '#000' : '#fff');

  const root = document.documentElement.style;
  if (okLight) {
    root.setProperty('--pack-accent-light', toHex(finalLight));
    root.setProperty('--pack-on-accent-light', onAccentFor(finalLight));
  }
  if (okDark) {
    root.setProperty('--pack-accent-dark', toHex(finalDark));
    root.setProperty('--pack-on-accent-dark', onAccentFor(finalDark));
  }

  // Optional subtle surface tint — only when the pack clearly gives BOTH a
  // light and a dark surface color; otherwise --plane/--surface stay neutral.
  const surfaceLight = pickSurface(maps.light);
  const surfaceDark = pickSurface(maps.dark);
  if (surfaceLight && surfaceDark) {
    const tint = (hex, base) => `color-mix(in oklab, ${hex} 6%, ${base})`;
    // Bases mirror styles.css's neutral plane/surface per theme (shell palette).
    root.setProperty('--pack-plane-light', tint(toHex(surfaceLight), '#ffffff'));
    root.setProperty('--pack-surface-light', tint(toHex(surfaceLight), '#fcfcfc'));
    root.setProperty('--pack-plane-dark', tint(toHex(surfaceDark), '#030711'));
    root.setProperty('--pack-surface-dark', tint(toHex(surfaceDark), '#0a101f'));
  }
}

// Theme-paired brand wordmark URLs, resolved from the pack (the gate reads them
// off /api/brand; the signed-in console reads them off the governed catalog
// index). Both variants are rendered and toggled by CSS (prefers-color-scheme +
// [data-theme]), so an OS/theme flip swaps the logo with no re-render. Stays null
// for blank packs (lolly-start) that ship no logo — the generic mark is kept.
let brandLogos = { light: null, dark: null };

// The instance's IdP display name ("Keycloak", "SUSE ID", …) for sign-in and
// "managed by …" copy — set at boot from /api/auth/config; generic until then.
let idpDisplayName = '';
const idpName = () => idpDisplayName || 'your identity provider';

// Pick a horizontal brand wordmark for a theme from a catalog index, returning
// its served /catalog URL. Mirrors pickBrandLogoUrl() on the server: prefer the
// on-theme variant, then the brand-colour face (light) or white mono face (dark).
function pickLogoFromIndex(index, theme) {
  const assets = Array.isArray(index?.assets) ? index.assets : [];
  const has = (a, t) => Array.isArray(a?.tags) && a.tags.includes(t);
  const logos = assets.filter((a) => a?.type === 'vector' && has(a, 'logo'));
  if (!logos.length) return null;
  const horizontal = logos.filter((a) => has(a, 'horizontal'));
  const shaped = horizontal.length ? horizontal : logos;
  const themed = shaped.filter((a) => has(a, theme === 'dark' ? 'on-dark' : 'on-light'));
  const pool = themed.length ? themed : shaped;
  const prefer = theme === 'dark' ? ['white', 'green'] : ['green', 'black'];
  let pick = pool[0];
  for (const p of prefer) {
    const m = pool.find((a) => has(a, p));
    if (m) { pick = m; break; }
  }
  const fmtEntry = pick.formats?.find((f) => f.format === 'svg') ?? pick.formats?.[0];
  if (!fmtEntry?.url) return null;
  return fmtEntry.url.startsWith('/') ? fmtEntry.url : `/catalog/${fmtEntry.url}`;
}

// Authenticated console theming: read the mounted pack's tokens from the served
// (governed) catalog. On a gated instance this needs a session — which the
// signed-in console has — so the whole console is branded.
async function applyPackTheme() {
  let index;
  try {
    const res = await fetch('/catalog/assets/index.json', { credentials: 'same-origin' });
    if (!res.ok) return; // 401/404/no pack mounted — stay neutral
    index = await res.json();
  } catch { return; }
  const asset = Array.isArray(index?.assets) ? index.assets.find((a) => a?.type === 'tokens') : null;
  const fmtEntry = asset?.formats?.find((f) => f.format === 'json') ?? asset?.formats?.[0];
  if (!fmtEntry?.url) return;
  let tokens;
  try {
    const url = fmtEntry.url.startsWith('/') ? fmtEntry.url : `/catalog/${fmtEntry.url}`;
    const tRes = await fetch(url, { credentials: 'same-origin' });
    if (!tRes.ok) return;
    tokens = await tRes.json();
  } catch { return; }
  const light = pickLogoFromIndex(index, 'light');
  const dark = pickLogoFromIndex(index, 'dark');
  if (light || dark) brandLogos = { light: light ?? dark, dark: dark ?? light };
  await themeFromTokens(tokens, (file) => `/catalog/fonts/webfonts/${encodeURIComponent(file)}`);
}

// Load + parse the mounted pack's DTCG tokens into {light,dark} maps for the
// Design-system tab — the SAME catalog source boot theming consumes, so the tab
// shows the instance's real design system (every colour/type token the tools
// resolve), not the console's own chrome. Returns null on any failure mode (no
// pack, 401/404, no tokens asset, malformed) so the tab falls back cleanly.
async function loadBrandTokenMaps() {
  let index;
  try {
    const res = await fetch('/catalog/assets/index.json', { credentials: 'same-origin' });
    if (!res.ok) return null;
    index = await res.json();
  } catch { return null; }
  const asset = Array.isArray(index?.assets) ? index.assets.find((a) => a?.type === 'tokens') : null;
  const fmtEntry = asset?.formats?.find((f) => f.format === 'json') ?? asset?.formats?.[0];
  if (!fmtEntry?.url) return null;
  let tokens;
  try {
    const url = fmtEntry.url.startsWith('/') ? fmtEntry.url : `/catalog/${fmtEntry.url}`;
    const tRes = await fetch(url, { credentials: 'same-origin' });
    if (!tRes.ok) return null;
    tokens = await tRes.json();
  } catch { return null; }
  let maps;
  try { maps = buildThemeMaps(tokens); } catch { return null; }
  const name = (asset?.name || asset?.id || '').replace(/\s+(brand\s+)?(design\s+)?tokens$/i, '').trim() || null;
  return { maps, name };
}

// Design tokens federated LIVE from connected sources (e.g. Penpot — plans/30 §5).
// The pack's own tokens asset carries no `provider`; a federated one does, so this
// is exactly the connected-source slice. Read-only inheritance into /design: parse
// each source's DTCG (the same parser the pack uses) and preview its palette. Only
// `ext/*` provider entries qualify — a materialized inst/* copy has `provider`
// stripped, so it reads as pack-owned, not "still connected".
async function loadSourceTokenSets() {
  let index;
  try {
    const res = await fetch('/catalog/assets/index.json', { credentials: 'same-origin' });
    if (!res.ok) return [];
    index = await res.json();
  } catch { return []; }
  const assets = (Array.isArray(index?.assets) ? index.assets : []).filter((a) => a?.type === 'tokens' && a?.provider);
  const out = [];
  for (const asset of assets.slice(0, 12)) {
    const fmtEntry = asset.formats?.find((f) => f.format === 'json') ?? asset.formats?.[0];
    if (!fmtEntry?.url) continue;
    try {
      const url = fmtEntry.url.startsWith('/') ? fmtEntry.url : `/catalog/${fmtEntry.url}`;
      const tRes = await fetch(url, { credentials: 'same-origin' });
      if (!tRes.ok) continue;
      const rows = tokenColorRows(buildThemeMaps(await tRes.json()).light);
      out.push({ id: asset.id, name: asset.name || asset.id, provider: asset.provider, rows });
    } catch { /* skip an unreadable / oversized set — best-effort, like the pack loader */ }
  }
  return out;
}

// Sign-in gate theming: the catalog is auth-gated, so before a session exists we
// read brand chrome from the dedicated unauthenticated /api/brand endpoint
// (tokens + a fonts base). Absent/404 → the gate stays neutral. This is what
// lets the login screen inherit the instance's brand.
async function applyBrandChrome() {
  let data;
  try {
    const res = await fetch('/api/brand', { credentials: 'same-origin' });
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  const fontsBase = typeof data?.fontsBase === 'string' ? data.fontsBase : '/api/brand/font/';
  const light = typeof data?.logos?.light === 'string' ? data.logos.light : null;
  const dark = typeof data?.logos?.dark === 'string' ? data.logos.dark : null;
  if (light || dark) brandLogos = { light: light ?? dark, dark: dark ?? light };
  await themeFromTokens(data?.tokens, (file) => `${fontsBase}${encodeURIComponent(file)}`);
}

// ── views ───────────────────────────────────────────────────────────────────
const SHELL_COLOR = { web: SERIES[0], tauri: SERIES[1], cli: SERIES[2] };
const shellColorOf = (r) => SHELL_COLOR[r.shell] ?? 'var(--muted)';

// Shared "fleet by client" hbar rows: shell + engine as the label, count as the
// value, shell kept alongside for shellColorOf — used identically on Overview
// and the dedicated Fleet view.
function fleetChartRows(clients) {
  return clients.map((c) => ({
    label: `${c.info.shell}${c.info.engine ? ` · engine ${c.info.engine}` : ''}`, value: c.count, shell: c.info.shell,
  }));
}

// ── activity feed (plans/09/11) ─────────────────────────────────────────────
// A linear, human-readable timeline over the audit log + attributed usage
// telemetry. Every noun is a link: a person → People focused on them; a tool or
// session → deep into that tool in Lolly (with the session's settings); a
// project → its Lolly folder; a governance object → its console view. Clicking a
// date or a type filters the feed. Deep-link targets:
//   app (Lolly, served at /):  tool → /t/<id> · session → /t/<tool>?session=<id>
//                              project → /#/p/<id>
//   console (hash routes):     person → #/users?focus=<id> · link → #/links · etc.
const ACT_CAT_ICON = {
  link: 'links', render: 'tools', session: 'projects', project: 'projects',
  catalog: 'catalog', provider: 'providers', grant: 'grants', group: 'users',
  user: 'users', approval: 'approvals', chain: 'approvals', message: 'messages',
  auth: 'users', telemetry: 'overview', guest: 'users', collab: 'projects',
};
const CONSOLE_VIEW_OF = {
  link: 'links', session: 'projects', project: 'projects', tool: 'tools',
  provider: 'providers', grant: 'grants', group: 'users', user: 'users',
  approval: 'approvals', chain: 'approvals', asset: 'catalog', message: 'messages',
};
function actShort(id) { return id && id.length > 16 ? `${id.slice(0, 13)}…` : (id || ''); }
function actSubjRef(subject) {
  if (!subject) return null;
  const i = subject.indexOf(':');
  return i < 0 ? { type: subject, id: '' } : { type: subject.slice(0, i), id: subject.slice(i + 1) };
}
function actAnchor(href, label, title) { return el('a', { class: 'act-obj', href, title: title || String(label) }, label); }
// Deep links into the Lolly app (real navigation away from the console).
function actToolObj(id) { return actAnchor(lollyHref(`/t/${encodeURIComponent(id)}`), id, `Open ${id} in Lolly`); }
function actSessionObj(id, toolId) {
  const href = toolId ? lollyHref(`/t/${encodeURIComponent(toolId)}?session=${encodeURIComponent(id)}`) : '#/projects';
  return actAnchor(href, actShort(id), toolId ? 'Open this session in Lolly' : 'Open in Projects');
}
function actProjectObj(id) { return actAnchor(lollyHref(`/#/p/${encodeURIComponent(id)}`), actShort(id), 'Open this project in Lolly'); }
// Console deep links (hash → routed in-place).
function actConsoleObj(type, id, label) { return actAnchor(`#/${CONSOLE_VIEW_OF[type] ?? 'overview'}`, label ?? actShort(id), id); }
function actUserObj(id, names) { return actAnchor(`#/users?focus=${encodeURIComponent(id)}`, (names && names[id]) || actShort(id), 'Open in People'); }
function actActorObj(actor, names) {
  const name = (actor.id && names && names[actor.id]) || actor.name;
  return actor.kind === 'user' && actor.id
    ? actAnchor(`#/users?focus=${encodeURIComponent(actor.id)}`, name, 'Open in People')
    : el('span', { class: 'act-actor' }, name);
}
function actPrincipalObj(pr, names) {
  if (!pr || pr === '*') return 'everyone';
  const i = pr.indexOf(':'); const kind = pr.slice(0, i); const id = pr.slice(i + 1);
  if (kind === 'user') return actUserObj(id, names);
  if (kind === 'group') return actConsoleObj('group', id, id);
  return pr;
}
// Build the linear sentence for one item as a flat array of text + link nodes.
function activityLine(item, names) {
  const p = item.payload || {};
  const s = actSubjRef(item.subject);
  const out = [actActorObj(item.actor, names), ' '];
  const push = (...xs) => out.push(...xs);
  switch (item.action) {
    case 'auth.login': push('signed in', p.provider ? ` via ${p.provider}` : ''); break;
    case 'link.create': push('created a ', el('b', {}, `${p.kind || 'share'} link`), p.toolId ? [' for ', actToolObj(p.toolId)] : '', s ? [' — ', actConsoleObj('link', s.id, 'link')] : ''); break;
    case 'link.revoke': push('revoked ', actConsoleObj('link', s?.id, 'a link')); break;
    case 'session.create': push('created a session', p.toolId ? [' of ', actToolObj(p.toolId)] : '', s ? [' — ', actSessionObj(s.id, p.toolId)] : '', p.projectId ? [' in ', actProjectObj(p.projectId)] : ''); break;
    case 'session.update': push('edited ', s ? actSessionObj(s.id, p.toolId) : 'a session', p.toolId ? [' of ', actToolObj(p.toolId)] : ''); break;
    case 'session.delete': push('deleted a session', p.toolId ? [' of ', actToolObj(p.toolId)] : ''); break;
    case 'sessions.bulk': push('bulk-edited sessions'); break;
    case 'project.create': push('created project ', s ? actProjectObj(s.id) : ''); break;
    case 'project.update': push('updated project ', s ? actProjectObj(s.id) : ''); break;
    case 'render.export': push(p.destination === 'download' ? 'downloaded ' : 'exported ', el('b', {}, p.format || 'a file'), p.toolId ? [' from ', actToolObj(p.toolId)] : ''); break;
    case 'tool.open': push('opened ', p.toolId ? actToolObj(p.toolId) : 'a tool'); break;
    case 'catalog.asset-use': push('used asset ', s ? actConsoleObj('asset', s.id, actShort(s.id)) : (p.assetId || '')); break;
    case 'catalog.provider.create': push('connected provider ', s ? actConsoleObj('provider', s.id) : '', p.kind ? ` (${p.kind})` : ''); break;
    case 'catalog.provider.update': push('updated provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.provider.sync': push('synced provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.provider.enable': push('enabled provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.provider.disable': push('disabled provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.provider.delete': push('removed provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.provider.credential': push('set credentials on provider ', s ? actConsoleObj('provider', s.id) : ''); break;
    case 'catalog.expire': push('set expiry on asset ', s ? actConsoleObj('asset', s.id, actShort(s.id)) : ''); break;
    case 'catalog.revoke': push('revoked asset ', s ? actConsoleObj('asset', s.id, actShort(s.id)) : ''); break;
    case 'grant.create': push('granted ', el('b', {}, p.action || 'access'), p.resource && p.resource !== '*' ? [' on ', el('span', { class: 'mono' }, p.resource)] : '', p.principal ? [' to ', actPrincipalObj(p.principal, names)] : ''); break;
    case 'grant.delete': push('removed a grant of ', el('b', {}, p.action || 'access'), p.principal ? [' from ', actPrincipalObj(p.principal, names)] : ''); break;
    case 'group.create': push('created local group ', s ? actConsoleObj('group', s.id, s.id) : ''); break;
    case 'group.delete': push('deleted local group ', s ? s.id : ''); break;
    case 'user.local-groups': push('changed group membership for ', s ? actUserObj(s.id, names) : 'a user'); break;
    case 'user.disable': push('locked out ', s ? actUserObj(s.id, names) : 'a user'); break;
    case 'user.enable': push('restored ', s ? actUserObj(s.id, names) : 'a user'); break;
    case 'approval.submit': push('requested ', actConsoleObj('approval', s?.id, 'an approval')); break;
    case 'approval.approve': push('approved ', actConsoleObj('approval', s?.id, 'a request')); break;
    case 'approval.reject': push('rejected ', actConsoleObj('approval', s?.id, 'a request')); break;
    case 'approval.withdraw': push('withdrew ', actConsoleObj('approval', s?.id, 'an approval')); break;
    case 'message.send': push('sent ', actConsoleObj('message', s?.id, `a ${p.kind || ''} message`.replace(/\s+/g, ' ')), p.severity ? ` (${p.severity})` : ''); break;
    case 'policy.overlay.edit': push('edited tool policy for ', s ? actToolObj(s.id) : 'a tool'); break;
    case 'chain.edit': push('edited approval chain ', s ? actConsoleObj('chain', s.id, s.id) : ''); break;
    case 'telemetry.consent': push('updated their telemetry consent'); break;
    case 'guest.admit': push('joined via ', actConsoleObj('link', s?.id, 'a guest link'), p.name ? ` as ${p.name}` : ''); break;
    case 'render.denied': push('was blocked from ', p.toolId ? actToolObj(p.toolId) : 'a render', p.code ? ` (${p.code})` : ''); break;
    case 'collab.invite': push('invited ', p.invitee ? actUserObj(p.invitee, names) : 'a teammate', ' to co-edit ', s ? actSessionObj(s.id, p.toolId) : 'a session'); break;
    default: push(item.action.replace(/\./g, ' '), s ? [' ', actConsoleObj(s.type, s.id)] : '');
  }
  return out;
}
// A small square marker per row: the pack's tool/asset preview when one exists
// (in-instance /catalog/ path only), else a category-icon badge. Air-gap-safe.
function activityThumb(item) {
  const iconId = ACT_CAT_ICON[item.category] || 'overview';
  const badge = el('span', { class: 'act-thumb act-thumb--badge' }, navIcon(iconId));
  const p = item.payload || {};
  const s = actSubjRef(item.subject);
  const thumbId = p.toolId || (s && s.type === 'tool' && s.id) || (s && s.type === 'asset' && s.id) || p.assetId;
  if (thumbId) {
    const img = el('img', { class: 'act-thumb act-thumb--img', loading: 'lazy', alt: '', src: `/catalog/previews/${encodeURIComponent(thumbId)}.svg` });
    img.addEventListener('error', () => img.replaceWith(badge));
    return img;
  }
  return badge;
}

async function renderActivityFeed(host) {
  const state = { category: '', actor: '', group: '', day: '', q: '', nextBefore: null };
  let names = {};
  const list = el('ul', { class: 'act-list' });
  const moreWrap = el('div', { class: 'act-more' });

  function query(before) {
    const p = new URLSearchParams();
    for (const [k, v] of [['category', state.category], ['actor', state.actor], ['group', state.group], ['day', state.day], ['q', state.q]]) if (v) p.set(k, v);
    if (before) p.set('before', before);
    p.set('limit', '40');
    return p.toString();
  }
  const fetchPage = (reset) => api(`/api/v1/activity?${query(reset ? null : state.nextBefore)}`);

  // Controls need the facets (types, people) + the group list, so fetch the
  // first page and the groups before building the filter bar.
  let first, groups;
  try {
    [first, groups] = await Promise.all([
      fetchPage(true),
      api('/api/v1/groups').then((r) => r.groups ?? []).catch(() => []),
    ]);
  } catch (e) {
    host.replaceChildren(el('p', { class: 'sub' }, e.status === 403
      ? 'The activity feed needs audit access (audit.export).'
      : `Couldn’t load activity: ${e.message}`));
    return;
  }
  names = { ...names, ...(first.names || {}) };
  state.nextBefore = first.nextBefore;

  const search = el('input', { type: 'search', placeholder: 'Search activity…', 'aria-label': 'Search activity' });
  let deb; search.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { state.q = search.value.trim(); reload(); }, 250); };
  const catSel = el('select', { 'aria-label': 'Filter by type' },
    el('option', { value: '' }, 'All types'),
    ...first.categories.map((c) => el('option', { value: c.key }, `${c.key} (${c.count})`)));
  catSel.onchange = () => { state.category = catSel.value; reload(); };
  // People and groups can be long lists → searchable comboboxes.
  const personBox = searchSelect(first.actors.map((a) => ({ value: a.id, label: a.name })),
    { placeholder: 'Anyone', strict: true, onchange: (v) => { state.actor = v; reload(); } });
  const groupBox = searchSelect(groups.map((g) => ({ value: g.name, label: g.name })),
    { placeholder: 'Any group', onchange: (v) => { state.group = v; reload(); } });
  const dayInput = el('input', { type: 'date', 'aria-label': 'Filter by day' });
  dayInput.onchange = () => { state.day = dayInput.value; reload(); };
  const clearBtn = el('button', { class: 'link-btn', onclick: () => {
    state.category = state.actor = state.group = state.day = state.q = '';
    search.value = ''; catSel.value = ''; personBox.set(''); groupBox.set(''); dayInput.value = '';
    reload();
  } }, 'Clear');
  const bar = el('div', { class: 'act-bar' },
    field('Search', search), field('Type', catSel), field('Person', personBox.node),
    field('Group', groupBox.node), field('Day', dayInput),
    el('div', { class: 'act-bar-clear' }, clearBtn));

  function activityRow(item) {
    const time = el('button', { class: 'act-time', title: 'Filter to this day',
      'aria-label': `Filter to ${item.at.slice(0, 10)}`,
      onclick: () => { state.day = item.at.slice(0, 10); dayInput.value = state.day; reload(); } }, when(item.at));
    const tag = el('button', { class: 'act-tag', title: `Filter to ${item.category}`,
      'aria-label': `Filter to ${item.category}`,
      onclick: () => { state.category = item.category; catSel.value = item.category; reload(); } }, item.category);
    return el('li', { class: 'act-row' },
      activityThumb(item),
      el('div', { class: 'act-body' },
        el('div', { class: 'act-line' }, ...activityLine(item, names).flat(Infinity).filter((x) => x !== '' && x != null)),
        el('div', { class: 'act-meta' }, time, tag)));
  }

  function render(data, reset) {
    names = { ...names, ...(data.names || {}) };
    state.nextBefore = data.nextBefore;
    if (reset) list.replaceChildren();
    for (const item of data.items) list.append(activityRow(item));
    if (reset && !list.children.length) list.append(el('li', { class: 'act-empty' }, 'No activity matches these filters.'));
    if (reset) announce(list.children.length && !list.querySelector('.act-empty') ? `${list.children.length} activity items` : 'No activity matches these filters');
    moreWrap.replaceChildren(state.nextBefore ? el('button', { onclick: loadMore }, 'Load more') : null);
  }
  const retry = (fn) => el('p', { class: 'sub flush' }, el('button', { onclick: fn }, 'Try again'));
  async function reload() {
    moreWrap.replaceChildren(el('span', { class: 'sub flush' }, 'Loading…'));
    try { render(await fetchPage(true), true); }
    catch { list.replaceChildren(el('li', { class: 'act-empty' }, 'Couldn’t load activity.')); moreWrap.replaceChildren(retry(reload)); }
  }
  async function loadMore() {
    try { render(await fetchPage(false), false); }
    catch { moreWrap.replaceChildren(retry(loadMore)); }
  }

  host.replaceChildren(bar, list, moreWrap);
  render(first, true);
}

async function viewOverview(main) {
  const [summary, fleet, links, stats, appr, auditHead] = await Promise.all([
    api('/api/v1/telemetry/summary'),
    api('/api/v1/fleet').catch(() => ({ clients: [] })),
    api('/api/v1/links?all=1').catch(() => ({ links: [] })),
    api('/api/v1/stats/overview').catch(() => null),
    api('/api/v1/approvals').catch(() => null),
    api('/api/v1/audit?limit=1').catch(() => null),
  ]);
  const d14 = summary.days;
  const events14 = d14.reduce((a, d) => a + d.events, 0);
  const exports14 = d14.reduce((a, d) => a + d.exports, 0);
  const liveLinks = links.links.filter((l) => l.status === 'live').length;
  const clients = fleet.clients.reduce((a, c) => a + c.count, 0);

  main.append(
    el('h1', {}, 'Overview'),
    el('p', { class: 'sub' }, 'Activity across the last 14 days, from connected shells and server traffic.'),
  );

  // ── what needs me — the role-aware lead. Charts describe the instance; this
  // strip is the task list, so it renders FIRST and only when something is
  // genuinely waiting (a quiet instance stays quiet). Every source above is
  // fetch-tolerant: a viewer without approvals/audit permission just sees fewer
  // rows, never a broken overview.
  // Each row: the destination view's own nav icon + a pill link tinted by
  // severity (critical / review / warning — the validated status palette, so
  // urgency is never brand-themed). Icon and tint travel together on the pill.
  const needs = [];
  if (auditHead?.chain && auditHead.chain.ok === false) {
    needs.push({ level: 'critical', icon: 'audit', href: '#/audit', text: `Audit chain broken at #${auditHead.chain.badSeq} — investigate now` });
  }
  const inboxCount = appr?.approvals ? appr.approvals.filter((a) => a.relation === 'inbox').length : 0;
  if (inboxCount) {
    needs.push({ level: 'review', icon: 'approvals', href: '#/approvals', text: `${fmt(inboxCount)} approval${inboxCount === 1 ? '' : 's'} waiting on you` });
  }
  const soon = Date.now() + 7 * 86400e3;
  const expiring = links.links.filter((l) => l.status === 'live' && l.expiresAt && Date.parse(l.expiresAt) < soon).length;
  if (expiring) {
    needs.push({ level: 'warning', icon: 'links', href: '#/links', text: `${fmt(expiring)} live link${expiring === 1 ? '' : 's'} expire${expiring === 1 ? 's' : ''} within 7 days` });
  }
  if (needs.length) {
    main.append(el('div', { class: 'card needs-card' },
      el('h2', {}, 'Needs attention'),
      el('ul', { class: 'needs-list' }, ...needs.map((n) =>
        el('li', {},
          el('a', { class: `needs-link needs-${n.level}`, href: n.href },
            navIcon(n.icon), n.text))))));
  }
  // First-run zero-state: an empty dashboard on a fresh instance reads as
  // "broken" without this — orient the admin toward the first useful steps.
  if (events14 === 0 && clients === 0 && liveLinks === 0) {
    main.append(el('div', { class: 'card zero-banner' },
      el('h2', { class: 'flush' }, 'Nothing here yet — that’s expected on a new deployment'),
      el('p', { class: 'sub' }, 'Numbers fill in as people sign in and shells connect. To get going:'),
      el('ul', { class: 'zero-steps' },
        el('li', {}, 'Invite people (they appear under ', el('a', { href: '#/users' }, 'People'), ' after first sign-in).'),
        el('li', {}, 'Confirm the mounted brand pack in ', el('a', { href: '#/instance?tab=design' }, 'This Deploy → Design system'), '.'),
        el('li', {}, 'Mint a share or guest link from ', el('a', { href: '#/links' }, 'Links'), ' to see it tracked here.'))));
  }
  main.append(
    el('div', { class: 'grid tiles' },
      tile('Events (14 days)', fmt(events14)),
      tile('Exports (14 days)', fmt(exports14)),
      tile('People attributed', fmt(summary.totals.activeUsers)),
      tile('Live links', fmt(liveLinks)),
      tile('Client requests seen', fmt(clients)),
    ),
    el('div', { class: 'grid two' },
      el('div', { class: 'card' }, el('h2', {}, 'Activity per day'),
        lineChart(d14, [{ key: 'events', label: 'Events' }, { key: 'exports', label: 'Exports' }, { key: 'users', label: 'Users' }])),
      el('div', { class: 'card' }, el('h2', {}, 'Top tools'),
        hbarChart(summary.topTools.map((t) => ({ label: t.toolId, value: t.count })), { empty: 'No tool usage in the last 14 days.' })),
      el('div', { class: 'card' }, el('h2', {}, 'Exports by format'),
        hbarChart(summary.formats.map((f) => ({ label: f.format, value: f.count })), { color: SERIES[1], empty: 'No exports yet — they appear once shells render.' })),
      el('div', { class: 'card' }, el('h2', {}, 'Fleet by client'),
        hbarChart(fleetChartRows(fleet.clients), { colorOf: shellColorOf, empty: 'No shells have connected yet.' })),
    ),
  );

  // ── seat / session utility (internal instance — utilisation shown in full) ──
  // Extended telemetry summary carries per-kind session durations; tolerate an
  // older server that predates it so the whole overview never breaks.
  const emptyUtil = { count: 0, totalSeconds: 0, avgSeconds: 0, perDay: [] };
  const sess = summary.sessions ?? { tool: emptyUtil, shell: emptyUtil };
  const totalSecs = sess.tool.totalSeconds + sess.shell.totalSeconds;
  const totalCount = sess.tool.count + sess.shell.count;
  const activeUsers = summary.totals.activeUsers;
  const avgSecs = totalCount ? totalSecs / totalCount : 0;
  const perUser = activeUsers ? totalCount / activeUsers : 0;

  // Secondary analytics live behind a disclosure so the landing view leads with
  // the headline activity numbers instead of an undifferentiated wall of charts.
  main.append(
    el('details', { class: 'ov-section' },
      el('summary', {}, el('span', { class: 'section-h' }, 'Seat utility')),
      el('p', { class: 'sub' }, 'Editor and web-shell session time across the last 14 days. This is an internal deployment, so utilisation is shown in full.'),
      el('div', { class: 'grid tiles' },
        tile('Total session time', fmtDuration(totalSecs)),
        tile('Avg session length', fmtDuration(avgSecs)),
        tile('Sessions / active user', perUser ? perUser.toFixed(1) : '—'),
        tile('Active users', fmt(activeUsers)),
        tile('Tool sessions', fmt(sess.tool.count)),
        tile('Shell sessions', fmt(sess.shell.count)),
      ),
      el('div', { class: 'grid two' },
        el('div', { class: 'card' }, el('h2', {}, 'Tool session time'),
          sess.tool.perDay.length
            ? lineChart(sess.tool.perDay, [{ key: 'seconds', label: 'Seconds' }])
            : el('p', { class: 'empty' }, 'No tool sessions recorded yet.')),
        el('div', { class: 'card' }, el('h2', {}, 'Web shell session time'),
          sess.shell.perDay.length
            ? lineChart(sess.shell.perDay, [{ key: 'seconds', label: 'Seconds' }])
            : el('p', { class: 'empty' }, 'No web shell sessions recorded yet.')),
      ),
      el('p', { class: 'sub', style: 'margin-top:10px' }, 'CLI sessions are short or instant by design and are intentionally not captured here — these figures cover the tool editor and the web shell only.'),
    ),
  );

  // ── catalog & content (inventory from the store, popularity from telemetry) ─
  const topAssets = summary.topAssets ?? [];
  const topDownloads = summary.topDownloads ?? [];
  const destinations = summary.destinations ?? [];
  const cat = stats?.catalog ?? { total: 0, byState: { live: 0, scheduled: 0, expired: 0, revoked: 0 } };
  const proj = stats?.projects ?? { total: 0, active: 0, top: [] };
  const byState = cat.byState ?? { live: 0, scheduled: 0, expired: 0, revoked: 0 };

  main.append(
    el('details', { class: 'ov-section' },
      el('summary', {}, el('span', { class: 'section-h' }, 'Catalog & content')),
      el('p', { class: 'sub' }, 'What this deployment serves, how it gets used, and where the work lives. Popularity and export figures cover the last 14 days; inventory is current.'),
      el('div', { class: 'grid tiles' },
        tile('Catalog items', fmt(cat.total)),
        tile('Live', fmt(byState.live)),
        tile('Scheduled', fmt(byState.scheduled)),
        tile('Expired', fmt(byState.expired)),
        tile('Revoked', fmt(byState.revoked)),
        tile('Projects', fmt(proj.total)),
        tile('Sessions', fmt(stats?.sessions?.total ?? 0)),
        // Refused CAS writes + bulk skips (plans/23 §3.D) — sustained volume here
        // is the measured demand signal for live co-editing (plans/14 §9).
        tile('Sync conflicts (30 days)', fmt(stats?.sessions?.conflicts30d ?? 0)),
      ),
      el('div', { class: 'grid two' },
        el('div', { class: 'card' }, el('h2', {}, 'Most-used catalog items'),
          topAssets.length
            ? hbarChart(topAssets.map((a) => ({ label: a.assetId, value: a.count })))
            : el('p', { class: 'empty' }, 'No catalog-asset use recorded yet.')),
        el('div', { class: 'card' }, el('h2', {}, 'Most-downloaded catalog items'),
          topDownloads.length
            ? hbarChart(topDownloads.map((a) => ({ label: a.assetId, value: a.count })), { color: SERIES[2] })
            : el('p', { class: 'empty' }, 'No catalog downloads recorded yet — shells emit this when a catalog asset is saved as a file.')),
        el('div', { class: 'card' }, el('h2', {}, 'Projects by item count'),
          (proj.top ?? []).length
            ? hbarChart(proj.top.map((p) => ({ label: p.archived ? `${p.name} (archived)` : p.name, value: p.items })), { color: SERIES[2] })
            : el('p', { class: 'empty' }, 'No projects yet.')),
        el('div', { class: 'card' }, el('h2', {}, 'Exports by destination'),
          destinations.length
            ? hbarChart(destinations.map((d) => ({ label: d.destination, value: d.count })), { color: SERIES[1] })
            : el('p', { class: 'empty' }, 'No exports recorded yet.')),
        el('div', { class: 'card' }, el('h2', {}, 'Catalog by state'),
          cat.total
            ? hbarChart([
                { label: 'live', value: byState.live },
                { label: 'scheduled', value: byState.scheduled },
                { label: 'expired', value: byState.expired },
                { label: 'revoked', value: byState.revoked },
              ], { color: SERIES[2] })
            : el('p', { class: 'empty' }, 'No catalog items in this deployment.')),
      ),
      el('p', { class: 'sub', style: 'margin-top:10px' }, 'Transforms, crops and other edits are counted as tool activity above; per-item download and transform attribution needs the shells to emit those events. Internal deployment — utilisation is shown in full.'),
    ),
  );
}

// ── activity view (its own section, listed under Overview) ──────────────────
async function viewActivity(main) {
  const actHost = el('div', { class: 'act-host' });
  const hdr = await activityHeader('All audited events per day — the feed below is the detail.', [
    { key: 'a', label: 'Events', match: ['*'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Activity'),
    el('p', { class: 'sub' }, 'A linear timeline of what people are doing — sharelinks, sessions, downloads, approvals and more. Click a name to open that person, a tool or session to jump into it in Lolly, or a date to filter to that day.'),
    ...(hdr ? [hdr] : []),
    actHost,
  );
  await renderActivityFeed(actHost).catch(() => { actHost.replaceChildren(el('p', { class: 'sub' }, 'Activity is unavailable right now.')); });
}

// ── This Deploy — a tabbed home combining the per-deployment surfaces. The tabs
//    reuse the existing view renderers (and their sidebar icons) inside one
//    panel; the design-system tab is new. Tab state rides ?tab= for deep links. ─
const INSTANCE_TABS = [
  { key: 'tools', label: 'Tools', icon: 'tools', render: (h) => viewTools(h) },
  { key: 'catalog', label: 'Catalog', icon: 'catalog', render: (h) => viewCatalog(h) },
  { key: 'providers', label: 'Providers', icon: 'providers', render: (h) => viewProviders(h) },
  { key: 'design', label: 'Design system', icon: 'design', render: (h) => viewDesignSystem(h) },
  { key: 'flags', label: 'Feature flags', icon: 'flags', render: (h) => viewFeatureFlags(h) },
  { key: 'injectables', label: 'Injectables', icon: 'injectables', render: (h) => viewInjectables(h) },
];
async function viewInstance(main, params) {
  let active = params?.get?.('tab');
  if (!INSTANCE_TABS.some((t) => t.key === active)) active = 'tools';
  const panel = el('div', { class: 'inst-panel', id: 'inst-panel', role: 'tabpanel', tabindex: '0' });
  const tabbar = el('div', { class: 'tabbar', role: 'tablist', 'aria-label': 'This Deploy sections' });
  const buttons = new Map();
  const tabId = (key) => `inst-tab-${key}`;

  async function select(key) {
    active = key;
    // Complete the WAI-ARIA tabs pattern: selected + roving tabindex, and the
    // panel is labelled by (and only focusably reached from) its active tab.
    for (const [k, b] of buttons) {
      const sel = k === key;
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.setAttribute('tabindex', sel ? '0' : '-1');
    }
    panel.setAttribute('aria-labelledby', tabId(key));
    // Deep-linkable without a full re-route (replaceState fires no hashchange).
    try { history.replaceState(null, '', `#/instance?tab=${key}`); } catch { /* ignore */ }
    const tab = INSTANCE_TABS.find((t) => t.key === key);
    const loading = loadingCard(tab.label);
    panel.replaceChildren(loading);
    try { await tab.render(panel); }
    catch (e) {
      panel.replaceChildren(e.status === 403
        ? el('p', { class: 'sub' }, 'Your role doesn’t include this section.')
        : el('div', {}, el('p', { class: 'sub' }, 'Couldn’t load this section.'),
            el('p', {}, el('button', { class: 'primary', onclick: () => select(key) }, 'Try again')),
            el('p', { class: 'muted mono', style: 'margin-top:8px;font-size:12px' }, e.message || '')));
    }
    loading.remove();
  }

  // Arrow-key roving between tabs (WAI-ARIA tabs keyboard model).
  const keys = INSTANCE_TABS.map((t) => t.key);
  tabbar.addEventListener('keydown', (e) => {
    const i = keys.indexOf(active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = keys.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = keys[next];
    select(key);
    buttons.get(key).focus();
  });

  for (const t of INSTANCE_TABS) {
    const b = el('button', { class: 'tab', role: 'tab', type: 'button', id: tabId(t.key),
      'aria-controls': 'inst-panel',
      'aria-selected': t.key === active ? 'true' : 'false',
      tabindex: t.key === active ? '0' : '-1',
      onclick: () => { if (t.key !== active) select(t.key); } },
      navIcon(t.icon), el('span', {}, t.label));
    buttons.set(t.key, b);
    tabbar.append(b);
  }

  main.replaceChildren(
    el('h1', {}, 'This Deploy'),
    el('p', { class: 'sub' }, 'Everything this deployment serves and governs, in one place — its tools, catalog, connected providers, projects and design system.'),
    tabbar, panel);
  await select(active);
}

// Read the live value of a chrome token (resolves the pack override + theme).
function dsVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function dsSwatch(label, varName) {
  const val = dsVar(varName);
  return el('div', { class: 'ds-swatch' },
    el('span', { class: 'ds-chip', style: `background:${val || 'transparent'}` }),
    el('div', {}, el('div', { class: 'ds-name' }, label), el('div', { class: 'ds-val mono' }, val || '—')));
}
// One palette swatch for a real pack token: the resolved colour, its leaf name,
// dotted token path, and value — so the tab is a faithful reference of the pack.
function tokenSwatch({ path, value }) {
  return el('div', { class: 'ds-swatch' },
    el('span', { class: 'ds-chip', style: `background:${value}` }),
    el('div', {},
      el('div', { class: 'ds-name' }, path.split('.').pop()),
      el('div', { class: 'ds-val mono', title: path }, path),
      el('div', { class: 'ds-val mono' }, value)));
}

// Every leaf in a flattened token map that reads as a CSS colour — explicit
// $type:color, or an untyped value the browser accepts (skips dimensions, font
// names, etc.). This is the pack's ACTUAL design system, not console chrome.
function tokenColorRows(map) {
  const rows = [];
  for (const [path, entry] of Object.entries(map)) {
    if (entry.type && entry.type !== 'color') continue;
    const value = entry.resolved ?? entry.raw;
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!resolveCssColor(value)) continue;
    rows.push({ path, value: value.trim() });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// The design-system tab: a read-only reference of the active brand's tokens,
// read from the mounted pack (the same tokens the tools consume) so it matches
// the Lolly shell's design view. Falls back to the console's own chrome tokens
// only when no pack tokens are mounted. Owner/admin also gets the /start editor.
async function viewDesignSystem(main) {
  const unlocked = ['owner', 'admin'].includes(session?.user?.role);
  const brand = await loadBrandTokenMaps().catch(() => null);
  // Brand profiles (plans/29): a profile-aware pack carries several brands, one
  // active via the catalog symlink. Show which is active; owner/admin can switch
  // the whole deploy — re-theming the console, sign-in and the tools at once.
  const profiles = await api('/api/v1/brand/profiles').catch(() => null);
  // Token sets federated live from connected sources (Penpot). Surfaced read-only so
  // /design inherits from the connected design system (plans/30 §5).
  const sources = await loadSourceTokenSets().catch(() => []);
  const profileCard = profiles?.available && profiles.profiles.length ? (() => {
    const rows = profiles.profiles.map((p) => {
      let action = null;
      if (unlocked && !p.active) {
        const btn = el('button', { class: 'btn' }, 'Switch to this brand');
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await api('/api/v1/brand/profile', { method: 'PUT', body: { name: p.name } });
            toast(`Brand switched to ${p.name}`);
            await applyPackTheme(); // re-theme the console chrome from the new pack
            route();                // re-render — new active badge + new tokens
          } catch (e) { toast(e.message); btn.disabled = false; }
        };
        action = btn;
      }
      return el('div', { class: 'ds-profile-row' },
        el('span', { class: 'ds-profile-name' }, p.name),
        p.active ? el('span', { class: 'badge' }, 'active') : null,
        action);
    });
    return el('div', { class: 'card stack' },
      el('h2', { class: 'flush' }, 'Brand profile'),
      el('p', { class: 'sub' }, unlocked
        ? 'This deployment carries multiple brand profiles. Switching re-themes the console, the sign-in screen and the tools — immediately, for everyone.'
        : `This deployment’s brand is centrally managed. Active profile: ${profiles.active ?? '—'}.`),
      ...rows);
  })() : null;
  const sourceCard = sources.length ? el('div', { class: 'card stack' },
    el('h2', { class: 'flush' }, 'Design tokens from connected sources'),
    el('p', { class: 'sub' }, 'Token sets federated live from your connected design sources (e.g. Penpot). They inherit into this design system read-only — the active brand still comes from the mounted pack. To pin a set as an instance-owned snapshot, use Search & import on the Sources tab.'),
    ...sources.map((s) => el('div', { class: 'ds-group' },
      el('div', { class: 'list-bar' },
        el('div', { class: 'detail-h' }, s.name),
        el('span', { class: 'muted mono' }, `${s.provider} · ${s.rows.length} colour token${s.rows.length === 1 ? '' : 's'}`)),
      s.rows.length
        ? el('div', { class: 'ds-grid' }, ...s.rows.slice(0, 24).map(tokenSwatch))
        : el('p', { class: 'sub flush' }, 'No colour tokens in this set.'))) ) : null;
  const lightRows = brand ? tokenColorRows(brand.maps.light) : [];
  // Dark section shows only tokens whose value actually differs from light —
  // shared base colours aren't repeated, so it reads as "what dark changes".
  const lightByPath = new Map(lightRows.map((r) => [r.path, r.value]));
  const darkRows = brand && brand.maps.dark !== brand.maps.light
    ? tokenColorRows(brand.maps.dark).filter((r) => lightByPath.get(r.path) !== r.value)
    : [];
  const branded = lightRows.length > 0;
  const fontSans = dsVar('--font-sans') || dsVar('--font-sys');
  const fontMono = dsVar('--font-mono') || dsVar('--font-mono-sys');

  const typographyCard = el('div', { class: 'card stack' }, el('h2', {}, 'Typography'),
    el('div', { class: 'ds-type', style: `font-family:${fontSans}` }, 'The quick brown fox jumps over the lazy dog — 0123456789'),
    el('div', { class: 'ds-type mono', style: `font-family:${fontMono}` }, 'const lolly = { render: "on-device" };'),
    el('p', { class: 'sub flush' }, `Sans: ${fontSans.split(',')[0]} · Mono: ${fontMono.split(',')[0]}`));

  const editorCard = unlocked
    ? el('div', { class: 'card stack' },
        el('div', { class: 'list-bar' },
          el('h2', { class: 'flush' }, 'Brand editor'),
          el('a', { class: 'btn', href: lollyHref('/#/start'), target: '_blank', rel: 'noopener' }, 'Open in Lolly ↗')),
        el('p', { class: 'sub flush' }, 'Edit this deployment’s brand in the Lolly /start wizard — palette, type and tokens. Changes apply to the served pack.'))
    : el('div', { class: 'card' },
        el('h2', {}, 'Brand editor'),
        el('p', { class: 'sub flush' }, 'Editing is disabled for this managed brand. An owner can change the deployment brand.'));

  if (!branded) {
    // No pack tokens mounted (blank brand / no pack / unreadable): show the
    // console's own resolved chrome tokens, labelled honestly as chrome.
    const chrome = [
      ['Accent', '--accent'], ['On accent', '--on-accent'], ['Page', '--plane'], ['Surface', '--surface'],
      ['Ink', '--ink'], ['Muted', '--muted'], ['Grid', '--grid'],
      ['Series 1', '--series-1'], ['Series 2', '--series-2'], ['Series 3', '--series-3'],
      ['Good', '--good'], ['Warning', '--warning'], ['Serious', '--serious'], ['Critical', '--critical'],
    ];
    main.replaceChildren(
      el('h1', {}, 'Design system'),
      el('p', { class: 'sub' }, 'No brand design tokens are mounted on this deployment, so these are the console’s own chrome tokens. Mount a brand pack to see the deployment design system here.'),
      ...(profileCard ? [profileCard] : []),
      el('div', { class: 'card' }, el('h2', {}, 'Chrome palette'),
        el('div', { class: 'ds-grid' }, ...chrome.map(([n, v]) => dsSwatch(n, v)))),
      typographyCard,
      el('div', { class: 'card stack' }, el('h2', {}, 'Shape'),
        el('div', { class: 'ds-shape' },
          ...['--radius-sm', '--radius', '--radius-lg', '--radius-pill'].map((r) =>
            el('div', { class: 'ds-shape-box', style: `border-radius:${dsVar(r)}` }, el('span', {}, dsVar(r)))))),
      ...(sourceCard ? [sourceCard] : []),
      editorCard);
    return;
  }

  // Group tokens by family (first two path segments, e.g. color.brand) so a big
  // palette reads as a structured system instead of one flat wall of swatches.
  const groupedSwatches = (rows) => {
    const buckets = new Map();
    for (const r of rows) {
      const key = r.path.split('.').slice(0, 2).join('.') || 'other';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    return [...buckets.entries()].map(([name, group]) =>
      el('div', { class: 'ds-group' },
        el('div', { class: 'detail-h' }, name),
        el('div', { class: 'ds-grid' }, ...group.map(tokenSwatch))));
  };

  const cards = [
    el('div', { class: 'card stack' },
      el('h2', {}, brand.name ? `Palette — ${brand.name}` : 'Palette'),
      el('p', { class: 'sub' }, `${lightRows.length} colour tokens, resolved exactly as the tools read them.`),
      ...groupedSwatches(lightRows)),
  ];
  if (darkRows.length) {
    cards.push(el('div', { class: 'card stack' },
      el('h2', {}, 'Palette — dark theme'),
      el('p', { class: 'sub' }, `${darkRows.length} tokens the dark theme overrides.`),
      ...groupedSwatches(darkRows)));
  }
  cards.push(typographyCard);

  main.replaceChildren(
    el('h1', {}, 'Design system'),
    el('p', { class: 'sub' }, unlocked
      ? 'The active brand’s design tokens, read from the mounted pack — the same tokens the tools consume. Edit them in the Lolly brand editor below.'
      : 'The active brand’s design tokens, read from the mounted pack — the same tokens the tools consume. This deployment’s brand is centrally managed.'),
    ...(profileCard ? [profileCard] : []),
    ...cards,
    ...(sourceCard ? [sourceCard] : []),
    editorCard);
}

// The Feature-flags tab: the control plane's default state + toggle visibility
// for the shell's per-user feature flags (server: /api/v1/policy/flags). Each
// row is two selects; a change PUTs and re-renders from the returned catalogue.
// ── injectables (plans/19) ────────────────────────────────────────────────────
// The governed rail that injects capability into the shell this deploy governs:
// tools, feature flags, typed catalog resources, and declarative UI chrome — all
// as DATA the shell renders, never code. Publish states facts (the kind envelope
// refuses a malformed payload here, not from a member's shell); the shell
// interprets. This panel publishes / lists / revokes; each kind has its own fields.
const INJECTABLE_FIELDS = {
  flag: [
    { name: 'flagId', label: 'Flag id', placeholder: 'a governable shell flag id' },
    { name: 'default', label: 'Default', type: 'select', options: ['on', 'off'] },
    { name: 'visibility', label: 'Toggle', type: 'select', options: ['show', 'hide'] },
  ],
  resource: [
    { name: 'resourceType', label: 'Resource type', placeholder: 'e.g. ratecard' },
    { name: 'assetId', label: 'Catalog asset id', placeholder: 'namespace/id of a served asset' },
  ],
  tool: [
    { name: 'toolId', label: 'Tool id', placeholder: 'lowercase slug' },
    { name: 'source', label: 'Source', type: 'select', options: ['catalog', 'url'] },
    { name: 'ref', label: 'URL (if source=url)', placeholder: 'https://…' },
  ],
  chrome: [
    { name: 'slot', label: 'Slot', type: 'select', options: ['banner', 'nav', 'panel'] },
    { name: 'tone', label: 'Tone', type: 'select', options: ['', 'info', 'warn', 'accent'] },
    { name: 'text', label: 'Text (plain, no markup)', placeholder: 'what the reader sees' },
    { name: 'linkLabel', label: 'Link label (optional)', placeholder: 'Learn more' },
    { name: 'linkHref', label: 'Link href (optional)', placeholder: '/status or https://…' },
  ],
};

async function viewInjectables(main) {
  const { injectables, kinds } = await api('/api/v1/injectables');

  // ── publish form: pick a kind, then its declarative fields ──
  const idInput = el('input', { placeholder: 'permanent slug id' });
  const titleInput = el('input', { placeholder: 'human title' });
  const groupsInput = el('input', { value: '*', placeholder: '* or comma-separated groups' });
  const kindSel = el('select', { 'aria-label': 'Injectable kind' },
    ...kinds.map((k) => el('option', { value: k.kind }, `${k.label}${k.shellSupport === 'needs-seam' ? ' (needs shell seam)' : ''}`)));
  const fieldHost = el('div', { class: 'formrow' });
  const pubErr = errSpan();

  const controls = {}; // name → input element for the active kind
  function renderKindFields() {
    controls.__ = null; for (const k of Object.keys(controls)) delete controls[k];
    const defs = INJECTABLE_FIELDS[kindSel.value] ?? [];
    fieldHost.replaceChildren(...defs.map((d) => {
      const input = d.type === 'select'
        ? el('select', { 'aria-label': d.label }, ...d.options.map((o) => el('option', { value: o }, o || '(none)')))
        : el('input', { placeholder: d.placeholder ?? '' });
      controls[d.name] = input;
      return field(d.label, input);
    }));
  }
  kindSel.addEventListener('change', renderKindFields);
  renderKindFields();

  // Assemble the kind-specific declarative payload from the visible controls.
  function buildPayload() {
    const v = (n) => (controls[n]?.value ?? '').trim();
    switch (kindSel.value) {
      case 'flag': return { flagId: v('flagId'), default: v('default'), visibility: v('visibility') };
      case 'resource': return { resourceType: v('resourceType'), assetId: v('assetId') };
      case 'tool': return { toolId: v('toolId'), source: v('source'), ...(v('ref') ? { ref: v('ref') } : {}) };
      case 'chrome': return {
        slot: v('slot'), ...(v('tone') ? { tone: v('tone') } : {}), text: v('text'),
        ...(v('linkLabel') && v('linkHref') ? { link: { label: v('linkLabel'), href: v('linkHref') } } : {}),
      };
      default: return {};
    }
  }

  const publishBtn = el('button', { class: 'primary', onclick: async () => {
    pubErr.textContent = '';
    publishBtn.disabled = true;
    try {
      const groups = groupsInput.value.split(',').map((g) => g.trim()).filter(Boolean);
      await api('/api/v1/injectables', { method: 'POST', body: {
        id: idInput.value.trim(), kind: kindSel.value, title: titleInput.value.trim(),
        groups, payload: buildPayload(),
      } });
      toast(`Published ${idInput.value.trim()}`);
      route(); // whole-view refresh
    } catch (e) { pubErr.textContent = e.message; publishBtn.disabled = false; }
  } }, 'Publish');

  const publishCard = el('div', { class: 'card stack' },
    el('h2', {}, 'Publish an injectable'),
    el('p', { class: 'muted', style: 'margin-top:-4px' },
      'The control plane distributes declarative data; the shell interprets it. A malformed payload is refused here.'),
    el('div', { class: 'formrow' }, field('Id', idInput), field('Title', titleInput), field('Groups', groupsInput), field('Kind', kindSel)),
    fieldHost,
    el('p', {}, publishBtn), pubErr);

  // ── listing + revoke ──
  const row = (r) => {
    const err = errSpan();
    const revokeBtn = armConfirmButton({ class: 'danger' }, 'Revoke', 'Really revoke?', async (disarm) => {
      revokeBtn.disabled = true;
      try { await api(`/api/v1/injectables/${encodeURIComponent(r.id)}`, { method: 'DELETE' }); toast(`Revoked ${r.id}`); route(); }
      catch (e) { err.textContent = e.message; revokeBtn.disabled = false; disarm(); }
    });
    const facts = Object.entries(r.facts ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
    return el('tr', {},
      el('td', {}, el('div', {}, r.title), el('div', { class: 'muted mono' }, r.id)),
      el('td', {}, r.kind),
      el('td', {}, el('span', { class: 'muted', style: 'font-size:.85rem' }, facts)),
      el('td', {}, (r.groups ?? []).join(', ')),
      el('td', {}, el('span', { class: `status ${r.state === 'revoked' ? 'revoked' : 'live'}` }, r.state)),
      whenCell(r.updatedAt),
      el('td', {}, r.state === 'revoked' ? el('span', { class: 'muted' }, '—') : el('div', { class: 'lc-actions' }, revokeBtn), err));
  };

  const hdr = await activityHeader('Publishes, replacements and revocations per day.', [
    { key: 'a', label: 'Published', match: ['catalog.injectable.publish', 'catalog.injectable.replace'] },
    { key: 'b', label: 'Revoked', match: ['catalog.injectable.revoke'] },
  ]);
  main.append(
    el('h1', {}, 'Injectables'),
    el('p', { class: 'sub' }, 'Publish, list and revoke the capability this deploy injects into the shell it governs — tools, feature flags, typed catalog resources and declarative UI chrome. Group-scoped; connected shells pick up a change on their next poll.'),
    ...(hdr ? [hdr] : []),
    publishCard,
    el('div', { class: 'card stack' },
      el('h2', {}, 'Published'),
      injectables.length
        ? dataTable(
            ['Injectable', 'Kind', { label: 'Facts', sort: false }, 'Groups', { label: 'State', sort: false }, { label: 'Updated', sort: 'date' }, { label: '', w: '1%', sort: false }],
            injectables.map(row), { sortable: true })
        : el('p', { class: 'empty' }, 'Nothing published yet. Use the form above to inject a tool, flag, resource or banner.')),
  );
}

async function viewFeatureFlags(main) {
  const { flags } = await api('/api/v1/policy/flags');
  const list = el('div', { class: 'stack' });

  function row(f) {
    const effectiveOn = f.default != null ? f.default === 'on' : f.builtinDefault;
    const hidden = f.visibility === 'hide';
    const status = el('span', { class: 'muted', role: 'status', style: 'margin-left:auto;font-size:.85rem' });

    const opt = (value, label, on) => el('option', { value, selected: on ? 'selected' : null }, label);
    const defSel = el('select', { 'aria-label': `Default state for ${f.label}` },
      opt('inherit', `Inherit (${f.builtinDefault ? 'On' : 'Off'})`, f.default == null),
      opt('on', 'On', f.default === 'on'),
      opt('off', 'Off', f.default === 'off'));
    const visSel = el('select', { 'aria-label': `Toggle visibility for ${f.label}` },
      opt('show', 'Shown in profile', !hidden),
      opt('hide', 'Hidden (surprise)', hidden));

    async function save() {
      status.className = 'muted';
      status.textContent = 'Saving…';
      try {
        const res = await api(`/api/v1/policy/flags/${encodeURIComponent(f.id)}`,
          { method: 'PUT', body: { default: defSel.value === 'inherit' ? null : defSel.value, visibility: visSel.value } });
        toast(`Saved ${f.label}`);
        render(res.flags); // re-render from the authoritative catalogue
      } catch (e) {
        status.className = 'form-err';
        status.textContent = e.status === 403 ? 'Not allowed' : `Error: ${e.message}`;
      }
    }
    defSel.addEventListener('change', save);
    visSel.addEventListener('change', save);

    const control = (label, sel) => el('label', { class: 'stack', style: 'gap:4px;flex:1 1 12rem' },
      el('span', { class: 'muted', style: 'font-size:.8rem' }, label), sel);

    return el('div', { class: 'card stack' },
      el('div', { class: 'list-bar' }, el('h2', { class: 'flush' }, f.label), status),
      f.info ? el('p', { class: 'sub flush' }, f.info) : null,
      el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap' },
        control('Default state', defSel), control('User toggle', visSel)),
      el('p', { class: 'sub flush' },
        `Members who haven’t chosen get ${effectiveOn ? 'On' : 'Off'}` +
        (hidden
          ? ' — and the toggle is hidden from their profile (a padlock stands in). Flip the default to reveal a surprise on the day without ever showing a switch.'
          : ' — and can change it themselves in their profile.')));
  }

  function render(next) { list.replaceChildren(...next.map(row)); }

  const hdr = await activityHeader('Flag governance edits per day.', [
    { key: 'a', label: 'Edits', match: ['policy.flag.edit'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Feature flags'),
    el('p', { class: 'sub' }, 'Default state and toggle visibility for the shell’s per-user feature flags. A member who hasn’t set one gets the default here; hiding a toggle removes it from their profile while the default still applies — set a flag Off + Hidden to stage a seasonal surprise (Pride, April 1), then flip it On on the day. Changes reach connected shells on their next poll.'),
    ...(hdr ? [hdr] : []),
    list);
  render(flags);
}

async function viewFleet(main) {
  const [{ clients, engineVersion }, { installs }] = await Promise.all([
    api('/api/v1/fleet'), api('/api/v1/fleet/installs'),
  ]);
  const totalReq = clients.reduce((a, c) => a + c.count, 0);
  const shells = new Set(clients.map((c) => c.info.shell)).size;
  const engines = new Set(clients.map((c) => c.info.engine).filter(Boolean)).size;
  const lastSeen = clients.map((c) => c.lastSeenAt).filter(Boolean).sort().at(-1);
  const hdr = await activityHeader('Sign-ins and guest sessions per day — the traffic behind the fleet below.', [
    { key: 'a', label: 'Sign-ins', match: ['auth.login'] },
    { key: 'b', label: 'Guest sessions', match: ['guest.admit'] },
  ]);
  main.append(
    el('h1', {}, 'Fleet'),
    el('p', { class: 'sub' }, 'Which Lolly versions are talking to this deployment. Publish checks and upgrade nudges start here.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'grid tiles' },
      tile('Clients', fmt(clients.length)),
      tile('Distinct shells', fmt(shells)),
      tile('Engine versions', fmt(engines)),
      // What THIS deploy serves (the vendored pin) — the fixed point the field
      // histogram drifts against, visible without leaving the page.
      tile('This deploy serves', engineVersion || '—'),
      tile('Requests seen', fmt(totalReq)),
      tile('Last seen', clients.length ? when(lastSeen) : '—'),
    ),
    el('div', { class: 'card' },
      hbarChart(fleetChartRows(clients), { colorOf: shellColorOf, empty: 'No shells have connected yet.' })),
    el('div', { class: 'card stack' },
      dataTable(
        ['Shell', 'Engine', 'Platform', { label: 'Requests', num: true }, { label: 'Last seen', sort: 'date' }],
        clients.map((c) => el('tr', {},
          el('td', {}, el('span', { class: 'chip-side' },
            el('span', { class: 'chip' }, c.info.shell),
            c.info.shellVersion ? el('span', { class: 'sec' }, `v${c.info.shellVersion}`) : null)),
          el('td', {}, c.info.engine ?? '—'),
          el('td', {}, c.info.platform ?? '—'),
          numCell(c.count),
          whenCell(c.lastSeenAt))), { sortable: true, filter: true })),
    // The install registry (plans/34 wave 3): devices that spoke `install/<id>`
    // while signed in. Everything here is bookkeeping under the enrollment
    // covenant — rename and forget touch the row, never the device, and a
    // forgotten install re-registers on its next signed-in use.
    el('div', { class: 'card stack' },
      el('h2', {}, 'Installs'),
      el('p', { class: 'muted', style: 'margin-top:-4px' },
        'Devices registered while signed in — no heartbeat, rows refresh only when the person uses the instance. Forgetting is bookkeeping; the next signed-in use re-registers.'),
      dataTable(
        ['Name', 'Shell', 'Engine', 'Platform', 'Last used by', { label: 'Last seen', sort: 'date' }, ''],
        installs.map((i) => installRow(i)), { sortable: true, filter: true })),
  );

  function installRow(i) {
    const err = errSpan();
    const nameInput = el('input', { value: i.name ?? '', placeholder: 'unnamed', 'aria-label': `Name for install ${i.installId}` });
    const saveBtn = el('button', { onclick: async () => {
      err.textContent = '';
      saveBtn.disabled = true;
      try {
        await api(`/api/v1/fleet/installs/${encodeURIComponent(i.installId)}`, { method: 'PATCH', body: { name: nameInput.value.trim() || null } });
        toast('Install named');
        route();
      } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
    } }, 'Save');
    const forgetBtn = armConfirmButton({ class: 'danger' }, 'Forget', 'Really forget?', async (disarm) => {
      forgetBtn.disabled = true;
      try { await api(`/api/v1/fleet/installs/${encodeURIComponent(i.installId)}`, { method: 'DELETE' }); toast(`Forgot ${i.installId}`); route(); }
      catch (e) { err.textContent = e.message; forgetBtn.disabled = false; disarm(); }
    });
    return el('tr', {},
      el('td', {}, el('div', { class: 'lc-actions' }, nameInput, saveBtn), el('div', { class: 'muted mono' }, i.installId)),
      el('td', {}, el('span', { class: 'chip-side' },
        el('span', { class: 'chip' }, i.info.shell),
        i.info.shellVersion ? el('span', { class: 'sec' }, `v${i.info.shellVersion}`) : null)),
      el('td', {}, i.info.engine ?? '—'),
      el('td', {}, i.info.platform ?? '—'),
      el('td', {}, i.userName ?? '—'),
      whenCell(i.lastSeenAt),
      el('td', {}, el('div', { class: 'lc-actions' }, forgetBtn), err));
  }
}

// A room's member as name + role, the same chip-side pattern the Fleet table
// uses for "shell + version" — the role is the small set of two values (chip),
// the name is the identifying text beside it (sec). Hover shows when they
// joined; nothing here is a table column of its own (the room roster can run
// to WRITER_CAP + observers, and a per-member row would defeat "one row per
// room").
function memberChip(m) {
  return el('span', { class: 'chip-side', title: `joined ${when(new Date(m.joinedAt).toISOString())}` },
    el('span', { class: 'chip' }, m.role),
    el('span', { class: 'sec' }, m.name));
}

async function viewRooms(main) {
  await renderRooms(main);
}

async function renderRooms(main) {
  const { rooms } = await api('/api/v1/collab/rooms');

  const hdr = await activityHeader('Room joins, invites and write-backs per day.', [
    { key: 'a', label: 'Joins', match: ['collab.join'] },
    { key: 'b', label: 'Invites', match: ['collab.invite'] },
    { key: 'c', label: 'Write-backs', match: ['collab.quiesce'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Rooms'),
    el('p', { class: 'sub' }, 'Live collaborative editing on this deployment, right now — who is in each session and whether they can write. Counters and display names only; no input value, cursor position or keystroke ever reaches this view.'),
    ...(hdr ? [hdr] : []),
    el('p', {}, el('button', { onclick: () => renderRooms(main) }, 'Refresh')),
    el('div', { class: 'card stack' },
      rooms.length
        ? dataTable(
            ['Session', 'Tool', 'Members', { label: 'Ops', num: true }, { label: 'Started', sort: 'date' }],
            rooms.map((r) => el('tr', {},
              el('td', { class: 'mono', title: r.sessionId }, r.sessionLabel || r.sessionId),
              el('td', {}, el('span', { class: 'chip' }, r.toolId)),
              el('td', {}, el('span', { class: 'chips' }, ...r.members.map(memberChip))),
              numCell(r.opsApplied),
              whenCell(new Date(r.startedAt).toISOString()))))
        : el('p', { class: 'empty' }, 'No one is collaborating live right now. A room appears here the moment a second person joins a shared session.')));
}

function linkRow(l) {
  const err = errSpan();
  // Revoking kills live guest sessions immediately — two-click arm/confirm like
  // every other destructive row action (was a single-click revoke).
  const revokeBtn = l.status === 'live'
    ? armConfirmButton({ class: 'danger' }, 'Revoke', 'Really revoke?', async (disarm) => {
        err.textContent = '';
        revokeBtn.disabled = true;
        try { await api(`/api/v1/links/${l.id}/revoke`, { method: 'POST' }); toast('Link revoked'); route(); }
        catch (e) { err.textContent = e.message; revokeBtn.disabled = false; disarm(); }
      })
    : null;
  // The full signed URL travels with every link now — show it (mono, truncated,
  // full value on hover) with a one-click copy that shares the Contractors copy.
  const copy = copyButton(() => l.url, 'Copy');
  return el('tr', {},
    el('td', {}, el('span', { class: 'chip' }, l.kind)),
    el('td', {}, l.target.toolId ?? l.target.assetId ?? (l.target.collectionId ? `collection: ${l.target.collectionId}` : null) ?? l.target.sessionId ?? '—', l.protected ? ' 🔒' : ''),
    el('td', { class: 'mono url-cell', title: l.url }, l.url),
    el('td', {}, el('span', { class: `status ${l.status}` }, l.status)),
    whenCell(l.expiresAt),
    el('td', { class: 'mono', title: l.id }, l.id),
    el('td', {}, el('div', { class: 'lc-actions' }, copy, revokeBtn), err));
}

async function viewLinks(main) {
  const { links } = await api('/api/v1/links?all=1');
  const hdr = await activityHeader('Minted and revoked per day, across every link kind.', [
    { key: 'a', label: 'Minted', match: ['link.create'] },
    { key: 'b', label: 'Revoked', match: ['link.revoke'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Links'),
    el('p', { class: 'sub' }, 'Every share, embed, download and guest link this deployment has minted, with its full signed URL. Copy a link to hand it over; revoking kills it immediately, including live guest sessions.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'card' },
      el('h2', {}, 'Minted links'),
      links.length
        ? dataTable(['Kind', 'Target', { label: 'URL', w: '240px', sort: false }, 'Status', { label: 'Expires', sort: 'date' }, { label: 'Id', w: '150px', sort: false }, { label: 'Actions', w: '1%', sort: false }], links.map(linkRow), { sortable: true, filter: true })
        : el('p', { class: 'empty' }, 'No links yet. Links minted from the shells and the API will appear here.')),
  );
}

// ── catalog lifecycle ───────────────────────────────────────────────────────
/** Reuses the shared .status dot styling: live green, revoked red; scheduled
 *  shares the amber 'expired' dot (both mean "not currently visible, for a
 *  date reason") — the word always disambiguates which one it is. */
function catalogStateChip(state) {
  const cls = state === 'live' ? 'live' : state === 'revoked' ? 'revoked' : 'expired';
  return el('span', { class: `status ${cls}` }, state);
}

// Image-ish formats we can paint straight into an <img>; everything else
// (tokens/json, fonts, octet-stream) falls back to the neutral placeholder.
const CATALOG_IMG_FORMATS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);
// A served /catalog path stays as-is; a bare relative ref is rooted under
// /catalog/ (mirrors pickLogoFromIndex). Air-gap: only ever the instance's own
// gated /catalog/… paths, never a remote/upstream URL.
const catalogUrl = (u) => (typeof u === 'string' && u ? (u.startsWith('/') ? u : `/catalog/${u}`) : null);

/** Best-effort in-instance preview URL for an asset index entry (or the inspect
 *  detail — same shape): a provider thumbnail path, an entry-named preview, else
 *  the first image/svg format's own gated path. null → nothing paintable. */
function catalogPreviewUrl(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const thumb = catalogUrl(entry.thumbnail) ?? catalogUrl(entry.preview);
  if (thumb) return thumb;
  // format may carry a density suffix (e.g. 'png@2x') — match on the base token.
  const baseFmt = (f) => String(f.format ?? '').toLowerCase().split('@')[0];
  const fmts = Array.isArray(entry.formats) ? entry.formats : [];
  const img = fmts.find((f) => f && CATALOG_IMG_FORMATS.has(baseFmt(f)) && f.url);
  return img ? catalogUrl(img.url) : null;
}

/** A square asset preview: a lazy <img> from the asset's own gated path when one
 *  exists, degrading to a neutral placeholder tile on none/onerror (air-gapped —
 *  no remote fetch). `onOpen` makes the tile a keyboard-reachable inspect trigger. */
function catalogThumb(entry, size, onOpen) {
  const ph = () => el('span', { class: 'cat-thumb-ph', 'aria-hidden': 'true' },
    el('span', { class: 'cat-thumb-ext' }, String(entry?.type ?? 'asset').slice(0, 3)));
  const box = el(onOpen ? 'button' : 'div', {
    class: `cat-thumb${onOpen ? ' cat-thumb--btn' : ''}`,
    style: `--cat-thumb:${size}px`,
    ...(onOpen ? { type: 'button', 'aria-label': `Inspect ${entry?.id ?? 'asset'}`, onclick: onOpen } : {}),
  });
  const url = catalogPreviewUrl(entry);
  if (!url) { box.append(ph()); return box; }
  const img = el('img', { class: 'cat-thumb-img', src: url, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => { img.remove(); box.append(ph()); });
  box.append(img);
  return box;
}

/** The Set-expiry / Revoke lifecycle controls for one asset, shared by the
 *  catalog row and the inspect panel so the two surfaces can never drift — both
 *  PUT the same endpoint and re-render the whole view (route()) on success.
 *  Returns { node, err } for the caller to place. */
function lifecycleControls(entry) {
  const err = errSpan();
  const dateInput = el('input', { type: 'date', 'aria-label': `Expiry date for ${entry.id}`, value: entry.validUntil ? entry.validUntil.slice(0, 10) : '' });
  const setBtn = el('button', { onclick: async () => {
    if (!dateInput.value) { err.textContent = 'Pick a date first.'; return; }
    err.textContent = '';
    setBtn.disabled = true;
    try {
      await api(`/api/v1/catalog/lifecycle/${entry.id}`, { method: 'PUT', body: { validUntil: new Date(dateInput.value).toISOString() } });
      route();
    } catch (e) { err.textContent = e.message; setBtn.disabled = false; }
  } }, 'Set expiry');
  const revokeBtn = armConfirmButton({ class: 'danger' }, 'Revoke', 'Really revoke?', async (disarm) => {
    err.textContent = '';
    revokeBtn.disabled = true;
    try {
      await api(`/api/v1/catalog/lifecycle/${entry.id}`, { method: 'PUT', body: { revoke: true } });
      route();
    } catch (e) { err.textContent = e.message; revokeBtn.disabled = false; disarm(); }
  });
  return { node: el('div', { class: 'lc-actions' }, dateInput, setBtn, revokeBtn), err };
}

/**
 * Controls for the org's own metadata fields (plans/31 section 4), built from
 * the DEFINITIONS the instance published: text, select, date and url each get
 * the control that kind deserves, and a required field is marked.
 *
 * One editor, two homes: the served-asset inspect panel and the submit review
 * queue. Its read() returns only what MOVED, because the server merges a sparse
 * patch onto the stored values - so re-sending an untouched field could only
 * ever be a way for two open panels to overwrite each other.
 */
function orgFieldEditor(defs, values) {
  const current = (id) => String(values?.[id] ?? '');
  const inputs = new Map();
  const rows = (defs ?? []).map((def) => {
    let control;
    if (def.kind === 'select') {
      control = el('select', {},
        el('option', { value: '' }, def.required ? 'Choose one' : '(none)'),
        ...(def.options ?? []).map((o) => el('option', { value: o }, o)));
      control.value = current(def.id);
    } else {
      control = el('input', {
        type: def.kind === 'date' ? 'date' : def.kind === 'url' ? 'url' : 'text',
        value: current(def.id),
        ...(def.kind === 'url' ? { placeholder: 'https://…' } : {}),
      });
    }
    inputs.set(def.id, control);
    return field(def.required ? `${def.label} (required)` : def.label, control);
  });
  return {
    node: rows.length ? el('div', { class: 'formrow' }, ...rows) : null,
    read() {
      const patch = {};
      for (const [id, control] of inputs) {
        const next = control.value.trim();
        if (next !== current(id)) patch[id] = next;
      }
      return patch;
    },
  };
}

/** The org's own metadata as read-only chips, for a caller who may look but not
 *  edit. Absent definitions render nothing at all. */
function orgFieldRows(defs, values) {
  const set = (defs ?? []).filter((d) => values?.[d.id]);
  if (!set.length) return el('span', { class: 'muted' }, 'none');
  return el('div', { class: 'chips' }, ...set.map((d) => el('span', { class: 'chip' }, `${d.label}: ${values[d.id]}`)));
}

/**
 * The review panel for one pending submission (plans/31 section 3): the preview
 * a reviewer decides on, the declared metadata as an editable form, and the
 * decision itself with its comment. It sits below the queue table exactly as
 * the asset inspect panel sits below the served-assets table, so the two
 * catalog surfaces read the same way.
 *
 * Approve saves a dirty form FIRST, then decides. A reviewer who fixes a
 * mistyped name and hits Approve means both, and losing the fix on the way to
 * publishing it would be the worst of the three possible behaviours; the edit
 * stays its own audited call either way.
 */
function renderSubmissionReview(s, host, opener, fieldDefs) {
  const short = String(s.id).replace(/^inst\//, '');
  const err = errSpan();
  const mine = s.relation === 'mine';
  // Only a submission still waiting can be edited or decided. A settled one is
  // shown as the record it now is: the server refuses both, and offering a
  // control that always fails would be worse than not offering it.
  const pending = s.state === 'submitted';

  const nameInput = el('input', { type: 'text', value: s.name ?? '' });
  const typeInput = el('input', { type: 'text', value: s.type ?? '' });
  const tagsInput = el('input', { type: 'text', value: (s.tags ?? []).join(', ') });
  const descInput = el('input', { type: 'text', value: s.description ?? '' });
  const comment = el('input', { type: 'text', placeholder: 'Why (required to return)', 'aria-label': `Comment on ${s.name}` });
  const buttons = [];
  const busy = (on) => { for (const b of buttons) b.disabled = on; };

  // The org's own fields ride the SAME editor the served-asset panel uses and
  // the same overlay, so a reviewer files the asset under the org's taxonomy
  // before publishing it rather than in a second pass afterwards.
  const org = orgFieldEditor(fieldDefs, s.fields);

  const edited = () => {
    const body = {};
    if (nameInput.value.trim() !== (s.name ?? '')) body.name = nameInput.value.trim();
    if (typeInput.value.trim() !== (s.type ?? '')) body.type = typeInput.value.trim();
    if (descInput.value.trim() !== (s.description ?? '')) body.description = descInput.value.trim();
    const tags = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.join(',') !== (s.tags ?? []).join(',')) body.tags = tags;
    const fields = org.read();
    if (Object.keys(fields).length) body.fields = fields;
    return body;
  };
  const saveEdits = async () => {
    const body = edited();
    if (!Object.keys(body).length) return false;
    await api(`/api/v1/catalog/submissions/${short}`, { method: 'PATCH', body });
    return true;
  };

  const saveBtn = el('button', { onclick: async () => {
    err.textContent = '';
    busy(true);
    try {
      if (!(await saveEdits())) { err.textContent = 'Nothing changed yet.'; busy(false); return; }
      toast(`Updated ${nameInput.value.trim()}`);
      route();
    } catch (e) { err.textContent = e.message; busy(false); }
  } }, 'Save metadata');
  buttons.push(saveBtn);

  const act = async (action, disarm) => {
    if (action === 'reject' && !comment.value.trim()) { err.textContent = 'Say why before returning it.'; disarm?.(); return; }
    err.textContent = '';
    busy(true);
    try {
      if (action === 'approve') await saveEdits();
      await api(`/api/v1/catalog/submissions/${short}/act`, { method: 'POST', body: { action, comment: comment.value.trim() || undefined } });
      toast(action === 'approve' ? `Published ${nameInput.value.trim()}` : `Returned ${nameInput.value.trim()}`);
      route();
    } catch (e) { err.textContent = e.message; busy(false); disarm?.(); }
  };
  const approve = el('button', { class: 'primary', onclick: () => act('approve') }, 'Approve');
  const rtn = armConfirmButton({ class: 'danger' }, 'Return', 'Really return?', (disarm) => act('reject', disarm));
  buttons.push(approve, rtn);

  const dims = s.width && s.height ? `${s.width} × ${s.height}` : null;
  const cell = (label, value) => value == null ? null
    : el('div', { class: 'idy' }, el('div', { class: 'idy-l' }, label), el('div', { class: 'idy-v' }, value));
  const heading = el('h2', { class: 'flush', tabindex: '-1' }, s.name ?? s.id);
  requestAnimationFrame(() => heading.focus()); // move focus into the opened panel

  return el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' },
      heading,
      el('button', { onclick: () => { host.replaceChildren(); opener?.focus?.(); } }, 'Close')),
    el('div', { class: 'cat-detail' },
      catalogThumb(s, 120, null),
      el('div', { class: 'cat-detail-meta' },
        el('div', { class: 'idy-grid' },
          cell('Id', el('span', { class: 'mono' }, s.id)),
          cell('Submitted by', s.byName),
          cell('Submitted', when(s.at)),
          cell('File', [s.contentType, dims, fmtBytes(s.size)].filter(Boolean).join(' · ')),
          cell('Exposure', s.groups === '*' || !s.groups?.length ? 'every member' : s.groups.join(', ')),
          cell('Checksum', el('span', { class: 'mono trunc', title: s.checksum }, String(s.checksum ?? '').slice(0, 16)))))),
    el('div', { class: 'stack' },
      el('h3', { class: 'detail-h' }, 'Declared metadata'),
      pending
        ? el('div', { class: 'stack' },
            el('p', { class: 'sub', style: 'margin:0 0 8px' },
              'Correct it before it is published - name, type, tags and description only. The bytes and the exposure the submitter chose are not editable here, and every change is audited with its before and after.'),
            el('div', { class: 'formrow' }, field('Name', nameInput), field('Type', typeInput)),
            el('div', { class: 'formrow' }, field('Tags (comma-separated)', tagsInput), field('Description', descInput)),
            org.node ? el('h3', { class: 'detail-h' }, 'Org fields') : null,
            org.node,
            el('p', {}, saveBtn))
        : el('div', { class: 'stack' },
            el('p', { class: 'sub', style: 'margin:0 0 8px' },
              `${s.type ?? 'asset'}${s.description ? ` - ${s.description}` : ''}`),
            (s.tags ?? []).length
              ? el('div', { class: 'chips' }, ...s.tags.map((t) => el('span', { class: 'chip' }, t)))
              : el('span', { class: 'muted' }, 'no tags'),
            (fieldDefs ?? []).length ? orgFieldRows(fieldDefs, s.fields) : null)),
    el('div', { class: 'stack' },
      el('h3', { class: 'detail-h' }, 'Decision'),
      !pending
        ? el('p', { class: 'sub', style: 'margin:0' },
            `${s.state === 'live' ? 'Published' : 'Returned'}${s.decidedAt ? ` ${when(s.decidedAt)}` : ''}${s.decidedBy ? ` by ${s.decidedBy.replace(/^user:/, '')}` : ''}${s.comment ? `: “${s.comment}”` : '.'}`)
        : mine
          ? el('p', { class: 'sub', style: 'margin:0' }, 'This is your own submission, so someone on the review chain decides it. You can still correct its metadata while it waits.')
          : el('div', { class: 'stack' },
              el('p', { class: 'sub', style: 'margin:0 0 8px' },
                'Approving publishes the asset and mints its lifecycle row, so the expire and revoke controls work from that moment. Returning it sends your comment back to the submitter and the bytes never reach the feed.'),
              el('div', { class: 'formrow' }, field('Comment', comment)),
              el('div', { class: 'lc-actions' }, approve, rtn))),
    err);
}

/**
 * The submit review queue (plans/31 section 3). Rows are whatever the server
 * decides this caller may see: their own submissions plus the ones open on a
 * step their groups may act on. Returns null when there is nothing pending, or
 * when the route is not reachable for this caller, so the card simply does not
 * appear rather than showing an error nobody can act on.
 *
 * Approve/return go through the approvals engine server-side, so separation of
 * duties and step eligibility hold here exactly as they do in the Approvals
 * view - this is the ergonomic door, never a second rule set.
 */
async function submissionQueue() {
  const load = async (state) => {
    try {
      return (await api(`/api/v1/catalog/submissions${state ? `?state=${state}` : ''}`)).submissions ?? [];
    } catch { return null; }
  };
  const pending = await load('submitted');
  if (!pending?.length) return null;
  // The org's field DEFINITIONS, fetched once for the whole queue: an instance
  // that defines none gets the panel it had before.
  const fieldDefs = await api('/api/v1/catalog/fields').then((r) => r.fields ?? []).catch(() => []);

  const panelHost = el('div', { class: 'stack' });
  const open = (s, opener) => {
    panelHost.replaceChildren(renderSubmissionReview(s, panelHost, opener, fieldDefs));
    scrollIntoViewMotionSafe(panelHost);
  };

  const rowFor = (s) => {
    const dims = s.width && s.height ? `${s.width} × ${s.height}` : null;
    const waiting = s.state === 'submitted';
    const openBtn = el('button', { ...(waiting && s.relation === 'inbox' ? { class: 'primary' } : {}), onclick: () => open(s, openBtn) },
      waiting && s.relation === 'inbox' ? 'Review' : 'View');
    return el('tr', {},
      el('td', {}, catalogThumb(s, 40, () => open(s, openBtn))),
      el('td', {}, s.name, el('div', { class: 'muted mono' }, s.id)),
      el('td', {}, s.byName, el('div', { class: 'muted' }, s.relation === 'mine' ? 'your submission' : 'on your step')),
      whenCell(s.at),
      el('td', { class: 'muted' }, [s.contentType, dims, fmtBytes(s.size)].filter(Boolean).join(' · ')),
      el('td', {}, el('span', { class: `status ${s.state === 'live' ? 'live' : s.state === 'returned' ? 'revoked' : 'review'}` }, s.state)),
      el('td', {}, openBtn));
  };

  const table = (rows) => rows.length
    ? dataTable(
        [{ label: '', w: '52px', sort: false }, 'Asset', 'Submitted by', { label: 'Submitted', sort: 'date' },
          { label: 'File', sort: false }, 'State', { label: '', w: '1%', sort: false }],
        rows.map(rowFor), { csvName: 'submissions' })
    : el('p', { class: 'empty' }, 'Nothing in this state.');

  // Waiting-on-review is the list someone can act on, so it is what the card
  // opens with; the other states are here so a returned asset's comment and a
  // published one's provenance stay reachable without a trip to the audit log.
  const body = el('div', {}, table(pending));
  const stateSel = el('select', { 'aria-label': 'Which submissions to list' },
    el('option', { value: 'submitted' }, 'Waiting on review'),
    el('option', { value: 'returned' }, 'Returned'),
    el('option', { value: 'live' }, 'Published'),
    el('option', { value: '' }, 'All'));
  stateSel.onchange = async () => {
    stateSel.disabled = true;
    panelHost.replaceChildren();
    body.replaceChildren(table((await load(stateSel.value)) ?? []));
    stateSel.disabled = false;
  };

  return el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' }, el('h2', { class: 'flush' }, `Submitted (${pending.length})`), stateSel),
    el('p', { class: 'sub' }, 'Assets members have submitted to this catalog. Nothing waiting on review is in the feed, servable or linkable yet. Review one to preview its bytes, correct its metadata and publish or return it.'),
    body,
    panelHost);
}

function catalogRow(entry, onInspect) {
  const { node, err } = lifecycleControls(entry);
  const tagText = entry.tags.length ? entry.tags.join(', ') : '—';
  return el('tr', {},
    el('td', {}, catalogThumb(entry.asset, 40, () => onInspect(entry))),
    el('td', { class: 'mono', title: entry.id }, entry.id,
      entry.provider ? el('div', { class: 'muted' }, `via ${entry.provider}`) : null,
      el('div', {}, el('a', { class: 'link-btn', href: '#/catalog', onclick: (e) => { e.preventDefault(); onInspect(entry); } }, 'Inspect'))),
    el('td', {}, entry.type),
    el('td', { class: 'tags' }, el('span', { class: 'trunc', title: tagText }, tagText)),
    el('td', {}, catalogStateChip(entry.state)),
    el('td', {}, when(entry.validUntil)),
    el('td', {}, node, err));
}

// Inspect panel: fetch the full detail (metadata + formats + lifecycle) for one
// asset and render a larger preview, attribution, tags and lifecycle controls.
async function openCatalogInspect(entry, host) {
  const opener = document.activeElement; // restore focus here when the panel closes
  host.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'sub flush' }, `Loading ${entry.id}…`)));
  scrollIntoViewMotionSafe(host);
  let detail;
  try {
    detail = await api(`/api/v1/catalog/assets/${entry.id}`);
  } catch (e) {
    host.replaceChildren(el('div', { class: 'card stack' },
      el('div', { class: 'list-bar' },
        el('h2', { class: 'flush' }, entry.id),
        el('button', { onclick: () => { host.replaceChildren(); opener?.focus?.(); } }, 'Close')),
      el('p', { class: 'sub' }, 'Couldn’t load this asset’s details.'),
      el('p', {}, el('button', { class: 'primary', onclick: () => openCatalogInspect(entry, host) }, 'Try again')),
      el('p', { class: 'muted mono', style: 'margin-top:8px;font-size:12px' }, e.message || '')));
    return;
  }
  // Byte history (plans/31 section 6), for instance-owned assets only - a pack
  // file and a federated asset are versioned where they live. A failure here
  // never costs the panel: the rest of the detail still renders.
  let history = null;
  if (String(detail.id ?? entry.id).startsWith('inst/')) {
    try { history = await api(`/api/v1/catalog/assets/${entry.id}/versions`); } catch { history = null; }
  }
  host.replaceChildren(renderCatalogDetail(detail, entry, host, opener, history));
}

/**
 * The version history of one instance asset (plans/31 section 6): what it has
 * served, what it serves now, and the two moves that change it.
 *
 * Rollback points the head at a version that already exists - nothing is copied
 * and nothing is deleted, so it is itself reversible - and deleting a version
 * is refused for the head (roll back first) and for a held asset (a hold only
 * ever preserves availability). Read-only for a caller without catalog.edit,
 * because the history is worth seeing even where it cannot be moved.
 */
function catalogVersionsPanel(detail, entry, host, history) {
  if (!history || !Array.isArray(history.versions) || history.versions.length < 1) return null;
  const id = detail.id ?? entry.id;
  const err = errSpan();
  const act = async (label, fn) => {
    err.textContent = '';
    try {
      await fn();
      toast(label);
      openCatalogInspect(entry, host);
    } catch (e) { err.textContent = e.message; }
  };

  const rows = history.versions.map((v) => {
    const controls = [];
    if (detail.canEdit && !v.head) {
      controls.push(el('button', { onclick: () => act(`${id} now serves version ${v.version}`,
        () => api(`/api/v1/catalog/assets/${id}/head`, { method: 'PUT', body: { version: v.version } })) }, 'Serve this'));
      controls.push(el('button', { onclick: () => act(`Deleted version ${v.version}`,
        () => api(`/api/v1/catalog/assets/${id}/versions/${v.version}`, { method: 'DELETE' })) }, 'Delete'));
    }
    return el('tr', {},
      el('td', { class: 'mono' }, `v${v.version}`, v.head ? el('span', { class: 'chip', style: 'margin-left:6px' }, 'serving') : null),
      whenCell(v.at),
      el('td', { class: 'muted mono' }, String(v.by ?? '').replace(/^user:/, '')),
      el('td', {}, fmtBytes(v.size) || '—'),
      el('td', {}, v.note ?? el('span', { class: 'muted' }, '—')),
      el('td', {}, ...controls));
  });

  return el('div', { class: 'stack' },
    el('h3', { class: 'detail-h' }, 'Versions'),
    el('p', { class: 'sub', style: 'margin:0 0 8px' },
      `The id and its URL never change; the bytes behind them do. ${history.keep
        ? `This deployment keeps ${history.keep} versions per asset.`
        : 'This deployment keeps every version.'} A hold refuses deletion, and the served version is never deletable.`),
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Version'), el('th', {}, 'When'), el('th', {}, 'By'),
        el('th', {}, 'Size'), el('th', {}, 'Note'), el('th', {}, ''))),
      el('tbody', {}, ...rows)),
    err);
}

/**
 * The metadata editor in the inspect panel (plans/31 section 4). Two halves,
 * one Save, and the halves have different reach on purpose: the org's own
 * fields apply to ANY asset (pack, federated or instance-owned), while name,
 * description and tags are offered only for an `inst/*` asset, because a
 * federated asset keeps its upstream name and a pack asset is a file on disk.
 *
 * Renders read-only for a caller without `catalog.edit`, and renders nothing at
 * all when there is neither a definition to fill in nor an editable record -
 * an instance that has defined no fields sees the panel it had before.
 */
function catalogMetaEditor(detail, entry, host) {
  const id = detail.id ?? entry.id;
  const defs = detail.fieldDefs ?? [];
  const own = String(id).startsWith('inst/');
  const values = detail.fields ?? {};
  if (!defs.length && !own) return null;
  if (!detail.canEdit) {
    return defs.length
      ? el('div', { class: 'stack' }, el('h3', { class: 'detail-h' }, 'Org fields'), orgFieldRows(defs, values))
      : null;
  }

  const err = errSpan();
  const org = orgFieldEditor(defs, values);
  const nameInput = el('input', { type: 'text', value: detail.name ?? '' });
  const descInput = el('input', { type: 'text', value: detail.description ?? '' });
  const tagsInput = el('input', { type: 'text', value: (Array.isArray(detail.tags) ? detail.tags : []).join(', ') });
  // Supersession (plans/31 section 6) is offered for ANY asset, because it
  // names a successor id rather than editing a record this deployment owns.
  const replacedInput = el('input', { type: 'text', value: detail.replacedBy ?? '', placeholder: 'inst/… (leave empty for none)' });

  const saveBtn = el('button', { onclick: async () => {
    err.textContent = '';
    saveBtn.disabled = true;
    const body = {};
    if (own) {
      if (nameInput.value.trim() !== (detail.name ?? '')) body.name = nameInput.value.trim();
      if (descInput.value.trim() !== (detail.description ?? '')) body.description = descInput.value.trim();
      const tags = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.join(',') !== (Array.isArray(detail.tags) ? detail.tags : []).join(',')) body.tags = tags;
    }
    const fields = org.read();
    if (Object.keys(fields).length) body.fields = fields;
    if (replacedInput.value.trim() !== (detail.replacedBy ?? '')) body.replacedBy = replacedInput.value.trim() || null;
    if (!Object.keys(body).length) { err.textContent = 'Nothing changed yet.'; saveBtn.disabled = false; return; }
    try {
      await api(`/api/v1/catalog/assets/${id}/meta`, { method: 'PUT', body });
      toast(`Updated ${detail.name ?? id}`);
      openCatalogInspect(entry, host); // re-read, so the panel shows what was stored
    } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
  } }, 'Save metadata');

  return el('div', { class: 'stack' },
    el('h3', { class: 'detail-h' }, own ? 'Metadata' : 'Org fields'),
    el('p', { class: 'sub', style: 'margin:0 0 8px' },
      own
        ? 'This deployment owns these bytes, so its name, description and tags are editable here alongside the org fields. Every change is audited with its before and after.'
        : 'The org fields apply to any asset. The name and tags come from the source and stay there - this deployment does not own that record.'),
    own ? el('div', { class: 'formrow' }, field('Name', nameInput), field('Tags (comma-separated)', tagsInput)) : null,
    own ? el('div', { class: 'formrow' }, field('Description', descInput)) : null,
    org.node,
    el('div', { class: 'formrow' }, field('Replaced by (asset id)', replacedInput)),
    el('p', { class: 'sub', style: 'margin:0' },
      'Naming a replacement retires this asset in favour of that one for anything that reads the catalog. It is advice, not a takedown - the asset keeps serving until its lifecycle says otherwise.'),
    el('p', {}, saveBtn),
    err);
}

function renderCatalogDetail(detail, entry, host, opener, history) {
  const state = detail.state ?? entry.state;
  const lc = detail.lifecycle;
  const tags = Array.isArray(detail.tags) ? detail.tags : (entry.tags ?? []);
  const fmts = Array.isArray(detail.formats) ? detail.formats : [];
  const cell = (label, value) => value == null ? null
    : el('div', { class: 'idy' }, el('div', { class: 'idy-l' }, label), el('div', { class: 'idy-v' }, value));

  // Size: sum the per-format sizes the provider reported, else a top-level size.
  const summed = fmts.reduce((a, f) => a + (typeof f.size === 'number' ? f.size : 0), 0);
  const sizeText = fmtBytes(summed || (typeof detail.size === 'number' ? detail.size : NaN));
  const fmtList = fmts.length
    ? el('div', { class: 'chips' }, ...fmts.map((f) => {
        const bits = [String(f.format ?? '?')];
        const b = fmtBytes(typeof f.size === 'number' ? f.size : NaN);
        if (b) bits.push(b);
        return el('span', { class: 'chip', title: f.filename ?? f.url ?? '' }, bits.join(' · '));
      }))
    : null;

  const { node: lcNode, err: lcErr } = lifecycleControls(entry);
  const metaSection = catalogMetaEditor(detail, entry, host);
  const versionsSection = catalogVersionsPanel(detail, entry, host, history);

  const heading = el('h2', { class: 'flush', tabindex: '-1' }, detail.name ?? detail.id ?? entry.id);
  requestAnimationFrame(() => heading.focus()); // move focus into the opened panel
  return el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' },
      heading,
      el('button', { onclick: () => { host.replaceChildren(); opener?.focus?.(); } }, 'Close')),
    el('div', { class: 'cat-detail' },
      catalogThumb(detail, 120, null),
      el('div', { class: 'cat-detail-meta' },
        el('div', { class: 'idy-grid' },
          cell('Id', el('span', { class: 'mono' }, detail.id ?? entry.id)),
          cell('Type', detail.type ?? entry.type),
          cell('Provider', detail.provider ?? entry.provider ?? el('span', { class: 'muted' }, 'pack (local)')),
          cell('State', catalogStateChip(state)),
          cell('Expires', when(lc?.validUntil ?? entry.validUntil)),
          cell('Version', detail.version),
          cell('Size', sizeText),
          cell('Updated', detail.updatedAt ? when(detail.updatedAt) : null)))),
    detail.description ? el('p', { class: 'sub flush' }, detail.description) : null,
    el('div', { class: 'stack' },
      el('h3', { class: 'detail-h' }, 'Tags'),
      tags.length ? el('div', { class: 'chips' }, ...tags.map((t) => el('span', { class: 'chip' }, t))) : el('span', { class: 'muted' }, 'none')),
    metaSection,
    detail.replacedBy
      ? el('p', { class: 'sub flush' }, 'Replaced by ', el('span', { class: 'mono' }, detail.replacedBy))
      : null,
    fmtList ? el('div', { class: 'stack' }, el('h3', { class: 'detail-h' }, 'Formats'), fmtList) : null,
    versionsSection,
    el('div', { class: 'stack' },
      el('h3', { class: 'detail-h' }, 'Lifecycle'),
      el('p', { class: 'sub', style: 'margin:0 0 8px' },
        lc
          ? `On expiry: ${lc.onExpiry ?? 'hide'}${lc.validFrom ? ` · valid from ${when(lc.validFrom)}` : ''}${lc.revokedAt ? ` · revoked ${when(lc.revokedAt)}` : ''}`
          : 'No lifecycle rule — live and served by default.'),
      lcNode, lcErr));
}

// Admins get the same filtered feed everyone else does — NOT an unfiltered
// view — merged with the lifecycle rows list (unfiltered by design: it's the
// admin management surface), so revoked/expired-and-hidden assets that the
// feed itself no longer serves still show up here with their state.
/**
 * Collections (plans/31 section 5): named, ORDERED, group-visible sets of
 * catalog assets, and the links that hand one to somebody outside the org.
 *
 * Returns null when this caller does not hold catalog.collection.manage, so the
 * card simply does not appear rather than showing an error nobody can act on -
 * the same shape the submit review queue uses.
 *
 * The editor is deliberately a list with up/down/remove rather than a
 * drag-and-drop canvas: the order IS the collection (a lookbook is a sequence),
 * and a control that works with a keyboard and a screen reader is worth more
 * here than one that looks like a design tool.
 */
async function collectionsCard(assetIndex) {
  let collections;
  try {
    collections = (await api('/api/v1/catalog/collections')).collections ?? [];
  } catch { return null; }

  const known = (assetIndex.assets ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id }));
  const nameOf = new Map(known.map((a) => [a.id, a.name]));
  const panelHost = el('div', { class: 'stack' });

  const groupsText = (c) => (!c.groups || c.groups === '*' ? 'everyone' : c.groups.join(', '));

  const rowFor = (c) => {
    const editBtn = el('button', { onclick: () => open(c, editBtn) }, 'Edit');
    return el('tr', {},
      el('td', {}, c.name, el('div', { class: 'muted mono' }, c.id)),
      numCell(c.members.length),
      el('td', {}, groupsText(c)),
      el('td', { class: 'muted mono' }, (c.curator ?? '').replace(/^user:/, '')),
      whenCell(c.updatedAt),
      el('td', {}, editBtn));
  };

  const open = (c, opener) => {
    panelHost.replaceChildren(renderCollectionEditor(c, known, nameOf, panelHost, opener));
    scrollIntoViewMotionSafe(panelHost);
  };

  const newBtn = el('button', { class: 'primary', onclick: () => open(null, newBtn) }, 'New collection');

  return el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' }, el('h2', { class: 'flush' }, `Collections (${collections.length})`), newBtn),
    el('p', { class: 'sub' },
      'Named, ordered sets of assets, visible to the groups you name. A collection link gives someone outside the org a page listing that set and a download-all, and nothing else: no search, no browsing past the set, no sign-up. Every asset is re-checked against its lifecycle each time the link is opened.'),
    collections.length
      ? dataTable(
          ['Collection', { label: 'Assets', num: true }, 'Visible to', 'Curator', { label: 'Updated', sort: 'date' }, { label: '', w: '1%', sort: false }],
          collections.map(rowFor), { csvName: 'collections' })
      : el('p', { class: 'empty' }, 'No collections yet. Assemble one to share a set of assets as a single link.'),
    panelHost);
}

/** The editor for one collection, or a blank one when `existing` is null. */
function renderCollectionEditor(existing, known, nameOf, host, opener) {
  const err = errSpan();
  const creating = !existing;
  const idInput = el('input', { value: existing?.id ?? '', placeholder: 'launch-kit', ...(creating ? {} : { disabled: 'disabled' }) });
  const nameInput = el('input', { value: existing?.name ?? '', placeholder: 'Launch kit' });
  const descInput = el('input', { value: existing?.description ?? '', placeholder: 'What this set is for' });
  const groupsInput = el('input', {
    value: !existing?.groups || existing.groups === '*' ? '' : existing.groups.join(', '),
    placeholder: 'everyone (or: design, sales)',
  });

  // Working model: the ordered member ids. Mutated in place by the row controls.
  const members = [...(existing?.members ?? [])];
  const membersHost = el('div', { class: 'stack' });
  const picker = el('select', { 'aria-label': 'Asset to add' },
    el('option', { value: '' }, 'Add an asset…'),
    ...known.map((a) => el('option', { value: a.id }, `${a.name} (${a.id})`)));

  const renderMembers = () => {
    membersHost.replaceChildren(
      ...members.map((id, i) => el('div', { class: 'formrow' },
        el('div', {},
          el('label', {}, `${i + 1}.`),
          el('div', {}, nameOf.get(id) ?? id, el('div', { class: 'muted mono' }, id))),
        el('div', {}, el('label', {}, ' '),
          el('div', { class: 'lc-actions' },
            el('button', { disabled: i === 0 ? 'disabled' : null, title: 'Move up',
              onclick: () => { members.splice(i - 1, 0, members.splice(i, 1)[0]); renderMembers(); } }, '↑'),
            el('button', { disabled: i === members.length - 1 ? 'disabled' : null, title: 'Move down',
              onclick: () => { members.splice(i + 1, 0, members.splice(i, 1)[0]); renderMembers(); } }, '↓'),
            el('button', { onclick: () => { members.splice(i, 1); renderMembers(); } }, 'Remove')))))
      ,
      members.length ? null : el('p', { class: 'empty' }, 'No assets in this set yet.'));
  };
  renderMembers();
  picker.onchange = () => {
    const id = picker.value;
    picker.value = '';
    if (!id || members.includes(id)) return; // a repeat keeps its first position
    members.push(id);
    renderMembers();
  };

  const linkHost = el('div', { class: 'stack' });
  const shareBtn = el('button', { onclick: async () => {
    err.textContent = '';
    shareBtn.disabled = true;
    try {
      const link = await api('/api/v1/links', { method: 'POST', body: { kind: 'share', target: { collectionId: existing.id } } });
      linkHost.replaceChildren(
        el('p', { class: 'sub', style: 'margin:0 0 6px' }, `Anyone with this link sees this collection until ${when(link.expiresAt)}.`),
        el('div', { class: 'lc-actions' },
          el('span', { class: 'mono url-cell', title: link.url }, link.url),
          copyButton(() => link.url, 'Copy')));
    } catch (e) { err.textContent = e.message; }
    shareBtn.disabled = false;
  } }, 'Create a share link');
  const zipBtn = el('button', { onclick: async () => {
    err.textContent = '';
    zipBtn.disabled = true;
    try {
      const link = await api('/api/v1/links', { method: 'POST', body: { kind: 'download', target: { collectionId: existing.id } } });
      linkHost.replaceChildren(
        el('p', { class: 'sub', style: 'margin:0 0 6px' }, `This link downloads the whole set as a zip, until ${when(link.expiresAt)}.`),
        el('div', { class: 'lc-actions' },
          el('span', { class: 'mono url-cell', title: link.url }, link.url),
          copyButton(() => link.url, 'Copy')));
    } catch (e) { err.textContent = e.message; }
    zipBtn.disabled = false;
  } }, 'Create a download-all link');

  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    err.textContent = '';
    const id = (idInput.value || '').trim();
    if (!id) { err.textContent = 'An id is required — lowercase letters, digits and dashes.'; return; }
    saveBtn.disabled = true;
    const groups = groupsInput.value.split(',').map((g) => g.trim()).filter(Boolean);
    try {
      await api(`/api/v1/catalog/collections/${encodeURIComponent(id)}`, { method: 'PUT', body: {
        name: nameInput.value.trim(),
        description: descInput.value.trim(),
        members,
        groups: groups.length ? groups : '*',
      } });
      toast(creating ? `Created ${id}` : `Saved ${id}`);
      route();
    } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
  } }, creating ? 'Create collection' : 'Save collection');

  const deleteBtn = creating ? null : armConfirmButton({ class: 'danger' }, 'Delete', 'Really delete?', async (disarm) => {
    err.textContent = '';
    try {
      await api(`/api/v1/catalog/collections/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
      toast(`Deleted ${existing.id}`);
      route();
    } catch (e) { err.textContent = e.message; disarm(); }
  });

  const heading = el('h2', { class: 'flush', tabindex: '-1' }, creating ? 'New collection' : existing.name);
  requestAnimationFrame(() => heading.focus());
  return el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' }, heading,
      el('button', { onclick: () => { host.replaceChildren(); opener?.focus?.(); } }, 'Close')),
    el('div', { class: 'formrow' }, field('Id', idInput), field('Name', nameInput)),
    el('div', { class: 'formrow' }, field('Description', descInput), field('Visible to (groups)', groupsInput)),
    el('div', { class: 'stack' },
      el('h3', { class: 'detail-h' }, 'Assets, in the order they are shown'),
      el('p', { class: 'sub', style: 'margin:0 0 8px' },
        'You can only add assets you can see yourself — a collection link hands its members to a bearer, so it can never reach further than its curator could.'),
      el('p', {}, picker),
      membersHost),
    creating
      ? null
      : el('div', { class: 'stack' },
          el('h3', { class: 'detail-h' }, 'Share it'),
          el('div', { class: 'lc-actions' }, shareBtn, zipBtn),
          linkHost),
    el('p', {}, el('div', { class: 'lc-actions' }, saveBtn, deleteBtn)),
    err);
}

async function viewCatalog(main) {
  const [index, lifecycle, queue] = await Promise.all([
    api('/catalog/assets/index.json'),
    api('/api/v1/catalog/lifecycle'),
    submissionQueue(),
  ]);
  const collections = await collectionsCard(index);
  const byId = new Map((index.assets ?? []).map((a) => [a.id, a]));
  const rowsById = new Map(lifecycle.rows.map((r) => [r.assetId, r]));
  const ids = new Set([...byId.keys(), ...rowsById.keys()]);
  const entries = [...ids].map((id) => {
    const asset = byId.get(id);
    const row = rowsById.get(id);
    return { id, type: asset?.type ?? '—', tags: asset?.tags ?? [], provider: asset?.provider ?? null, state: row?.state ?? 'live', validUntil: row?.validUntil ?? null, asset: asset ?? null };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const detailHost = el('div', { class: 'stack' });
  const onInspect = (entry) => openCatalogInspect(entry, detailHost);

  const hdr = await activityHeader('Catalog changes per day — providers, injectables and lifecycle.', [
    { key: 'a', label: 'Changes', match: ['catalog.'] },
  ]);
  main.append(
    el('h1', {}, 'Catalog'),
    el('p', { class: 'sub' }, 'Every asset this deployment serves, with a thumbnail, its expiry and revocation state. Inspect an asset for its full metadata and a larger preview. Revoking or hiding-on-expiry drops an asset from the feed immediately; it stays listed here — without its catalog metadata — so it can still be managed.'),
    ...(hdr ? [hdr] : []),
    ...(queue ? [queue] : []),
    ...(collections ? [collections] : []),
    el('div', { class: 'card' },
      el('h2', {}, 'Served assets'),
      entries.length
        ? dataTable(
            [{ label: '', w: '52px' }, { label: 'Asset', w: '200px' }, 'Type', 'Tags', 'State', 'Expires', { label: 'Actions', w: '272px' }],
            entries.map((e) => catalogRow(e, onInspect)))
        : el('p', { class: 'empty' }, 'No catalog assets found. Mount a brand pack to populate this table.')),
    detailHost,
  );
}

// ── tool policy (plans/03 §4) ───────────────────────────────────────────────
// Governance for tools and their inputs: visibility, locking, presets, choice
// restriction. Gated on policy.edit — admins by default, brand teams via a
// group grant — so the brand team can steward inputs without the admin role.

/** "green, #0C322C, 42" → typed values (JSON where it parses, string else). */
function parseValueList(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { return JSON.parse(s); } catch { return s; }
  });
}
function parseValue(text) {
  const t = text.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { return t; }
}
const showValue = (v) => v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

/** One tool's governance summary row + expandable editor. */
// The tool's own small SVG tile icon (from its manifest, served in the tools
// index) — the same glyph the gallery shows — falling back to the tools nav
// glyph. Pack-authored, admin-only view; injected inline like the shell does.
function toolTileIcon(svg) {
  const span = el('span', { class: 'tool-tile-icon', 'aria-hidden': 'true' });
  if (typeof svg === 'string' && /^\s*<svg[\s>]/i.test(svg)) {
    span.innerHTML = svg;
    const s = span.querySelector('svg');
    if (s) { s.setAttribute('width', '22'); s.setAttribute('height', '22'); }
    return span;
  }
  span.append(navIcon('tools'));
  return span;
}

function toolPolicyRow(tool, expandHost) {
  const ov = tool.overlay;
  const governed = ov?.inputAccess ? Object.keys(ov.inputAccess).length : 0;
  const visibility = ov?.visibility?.groups?.length ? ov.visibility.groups.join(', ') : 'everyone';
  return el('tr', {},
    el('td', {}, toolTileIcon(tool.icon)),
    el('td', {}, el('div', {}, tool.name), el('div', { class: 'muted mono' }, tool.id)),
    el('td', {}, visibility),
    el('td', { class: 'num' }, governed ? String(governed) : '—'),
    el('td', {}, ov?.enforce?.watermark ?? '—'),
    el('td', { class: 'num' }, ov ? `v${ov.version}` : el('span', { class: 'muted' }, 'ungoverned')),
    el('td', {}, el('button', { onclick: () => renderToolPolicyEditor(tool, expandHost) }, 'Edit')));
}

function renderToolPolicyEditor(tool, host) {
  // Working model: inputId → [{groups: 'a,b', level, value, allow}] — mutated
  // in place by the row controls, serialized on save.
  const model = {};
  for (const [inputId, rules] of Object.entries(tool.overlay?.inputAccess ?? {})) {
    model[inputId] = rules.map((r) => ({
      groups: r.groups.join(', '), level: r.level,
      value: showValue(r.value), allow: (r.allow ?? []).map(showValue).join(', '),
    }));
  }
  const declared = (tool.inputs ?? []).map((i) => i.id);
  const err = errSpan();

  const visibilityInput = el('input', {
    placeholder: 'everyone (or: brand, marketing)',
    value: tool.overlay?.visibility?.groups?.join(', ') ?? '',
  });
  const watermarkSel = el('select', {},
    ...['', 'never', 'until-approved', 'always'].map((w) =>
      el('option', { value: w, selected: (tool.overlay?.enforce?.watermark ?? '') === w ? 'selected' : null }, w || '(no rule)')));

  const rulesHost = el('div', {});
  const renderRules = () => {
    const inputIds = [...new Set([...declared, ...Object.keys(model)])];
    rulesHost.replaceChildren(...inputIds.map((inputId) => {
      const decl = (tool.inputs ?? []).find((i) => i.id === inputId);
      const rows = (model[inputId] ?? []).map((rule, idx) => {
        const groupsIn = el('input', { value: rule.groups, placeholder: '*', oninput: (e) => { rule.groups = e.target.value; } });
        const levelSel = el('select', { onchange: (e) => { rule.level = e.target.value; renderRules(); } },
          ...['editable', 'choice', 'locked', 'hidden'].map((l) =>
            el('option', { value: l, selected: rule.level === l ? 'selected' : null }, l)));
        const detail = rule.level === 'locked'
          ? el('input', { value: rule.value, placeholder: 'preset value', oninput: (e) => { rule.value = e.target.value; } })
          : rule.level === 'choice'
            ? el('input', { value: rule.allow, placeholder: 'allowed: a, b, c', oninput: (e) => { rule.allow = e.target.value; } })
            : el('span', { class: 'muted' }, rule.level === 'hidden' ? 'input absent for these groups' : 'free input');
        return el('div', { class: 'formrow' },
          field('groups', groupsIn),
          field('access', levelSel),
          field('detail', detail),
          el('div', {}, el('label', {}, ' '),
            el('button', { onclick: () => { model[inputId].splice(idx, 1); renderRules(); } }, 'Remove')));
      });
      const hint = decl?.options ? ` · options: ${(decl.options ?? []).map(showValue).join(', ')}` : '';
      return el('div', { style: 'margin-top:10px' },
        el('div', {},
          el('span', { class: 'mono' }, inputId === '*' ? '* (default for all inputs)' : inputId),
          el('span', { class: 'muted' }, `${decl?.type ? ` ${decl.type}` : ''}${hint}`),
          ' ',
          el('button', { onclick: () => {
            (model[inputId] ??= []).push({ groups: '*', level: 'locked', value: showValue(decl?.default), allow: '' });
            renderRules();
          } }, rows.length ? '+ rule' : 'Govern')),
        ...rows);
    }),
    el('p', {}, el('button', { onclick: () => { model['*'] ??= []; model['*'].push({ groups: '*', level: 'editable', value: '', allow: '' }); renderRules(); } },
      '+ default rule for all inputs (*)')));
  };
  renderRules();

  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    err.textContent = '';
    saveBtn.disabled = true;
    const inputAccess = {};
    for (const [inputId, rules] of Object.entries(model)) {
      const clean = rules.map((r) => ({
        groups: r.groups.split(',').map((s) => s.trim()).filter(Boolean),
        level: r.level,
        ...(r.level === 'locked' && r.value.trim() !== '' ? { value: parseValue(r.value) } : {}),
        ...(r.level === 'choice' ? { allow: parseValueList(r.allow) } : {}),
      })).filter((r) => r.groups.length);
      if (clean.length) inputAccess[inputId] = clean;
    }
    const visGroups = visibilityInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      ...(Object.keys(inputAccess).length ? { inputAccess } : {}),
      ...(visGroups.length ? { visibility: { groups: visGroups } } : {}),
      ...(watermarkSel.value ? { enforce: { watermark: watermarkSel.value } } : {}),
    };
    try {
      await api(`/api/v1/policy/overlays/${tool.id}`, { method: 'PUT', body });
      route();
    } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
  } }, 'Save policy');

  host.replaceChildren(el('div', { class: 'card stack' },
    el('h2', {}, `Policy — ${tool.name}`),
    el('p', { class: 'sub' }, 'Rules are ordered per input; the first rule matching a member’s groups wins, and members with no matching rule keep free input. Locked presets are baked at render time — a caller supplying their own value is refused. Hidden inputs disappear from the tool entirely.'),
    el('div', { class: 'formrow' },
      field('Visible to groups (empty = everyone)', visibilityInput),
      field('Watermark', watermarkSel)),
    tool.inputs === null
      ? el('p', { class: 'empty' }, 'tool.json not readable — rules can still be edited by input id.')
      : null,
    rulesHost,
    el('p', {}, saveBtn, ' ', el('button', { onclick: () => host.replaceChildren() }, 'Close')),
    err));
}

async function viewTools(main) {
  const { tools } = await api('/api/v1/policy/tools');
  const expandHost = el('div', {});
  const hdr = await activityHeader('Tool policy (overlay) edits per day.', [
    { key: 'a', label: 'Policy edits', match: ['policy.overlay.edit'] },
  ]);
  main.append(
    el('h1', {}, 'Tools'),
    el('p', { class: 'sub' }, 'Govern who sees each tool and what they may change: lock inputs to brand presets, restrict them to approved choices, or hide them outright. Admins hold this by default; grant policy.edit to a brand group to delegate stewardship.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'card' },
      el('h2', {}, 'Governed tools'),
      tools.length
        ? dataTable(
            [{ label: '', w: '1%' }, 'Tool', 'Visible to', { label: 'Governed inputs', num: true }, 'Watermark', { label: 'Policy', num: true }, { label: 'Actions', w: '1%' }],
            tools.map((t) => toolPolicyRow(t, expandHost)))
        : el('p', { class: 'empty' }, 'No tools found. Mount a brand pack with tools to govern them here.')),
    expandHost,
  );
}

// ── catalog providers (plans/17) ────────────────────────────────────────────
// Federated third-party sources. Credentials are write-only: the console sends
// a secret once and only ever renders the fingerprint that comes back.
function providerStatusChip(p) {
  if (!p.enabled) return el('span', { class: 'status expired' }, 'disabled');
  if (p.state.lastError) return el('span', { class: 'status revoked' }, 'error');
  return el('span', { class: 'status live' }, 'enabled');
}

function providerRow(p, panels) {
  const err = errSpan();
  const busy = (btn, fn, done) => async () => {
    err.textContent = '';
    btn.disabled = true;
    try { await fn(); if (done) toast(done); route(); } catch (e) { err.textContent = e.message; btn.disabled = false; }
  };
  const syncBtn = el('button', {}, 'Sync');
  syncBtn.onclick = busy(syncBtn, () => api(`/api/v1/catalog/providers/${p.id}/sync`, { method: 'POST' }), `Synced ${p.label}`);
  const toggleBtn = el('button', { class: p.enabled ? 'danger' : '' }, p.enabled ? 'Disable' : 'Enable');
  toggleBtn.onclick = busy(toggleBtn, () => api(`/api/v1/catalog/providers/${p.id}/${p.enabled ? 'disable' : 'enable'}`, { method: 'POST' }), p.enabled ? `Disabled ${p.label}` : `Enabled ${p.label}`);
  const keyBtn = el('button', { onclick: () => panels.showCredential(p) }, 'Key…');

  // Two-click arm/confirm delete, disabled-only server-side anyway.
  const delBtn = armConfirmButton({ class: 'danger' }, 'Delete', 'Really delete?', async (disarm) => {
    err.textContent = '';
    delBtn.disabled = true;
    try { await api(`/api/v1/catalog/providers/${p.id}`, { method: 'DELETE' }); toast(`Deleted ${p.label}`); route(); }
    catch (e) { err.textContent = e.message; delBtn.disabled = false; disarm(); }
  });

  const managed = p.managedBy === 'config';
  return el('tr', {},
    el('td', {}, el('div', {}, p.label, managed ? el('span', { class: 'muted' }, ' [config]') : null),
      el('div', { class: 'muted mono' }, p.id)),
    el('td', {}, p.kind),
    el('td', {}, providerStatusChip(p), p.state.lastError ? el('div', { class: 'muted', title: p.state.lastError }, el('span', { class: 'trunc' }, p.state.lastError)) : null),
    el('td', { class: 'num' }, fmt(p.state.assetCount)),
    el('td', {}, when(p.state.lastSyncAt)),
    el('td', { class: 'mono' }, p.credential ? p.credential.fingerprint : '—'),
    el('td', {}, managed
      ? el('span', { class: 'muted' }, 'via instance.json')
      : el('div', { class: 'lc-actions' }, syncBtn, keyBtn, toggleBtn, delBtn), err));
}

// The supported integrations, rendered as connect cards. `kind` is the exact
// provider kind the endpoints already accept; the copy + options hint are UI
// only. Mock is the dev source. (Was a single generic 'kind' dropdown.)
// Ordering + naming are deliberate: open and sovereign options lead, protocol
// names over vendor names (the drivers already speak the open protocol — the
// git driver is any git host, the s3 driver is any SigV4 store). Proprietary
// SaaS sources follow, plainly labelled.
const PROVIDER_INTEGRATIONS = [
  { kind: 'git', name: 'Git repository', blurb: 'Sync brand assets from any git host — Forgejo, Gitea, GitLab, Codeberg, GitHub — via a repository manifest.', options: '{"repo": "org/brand", "ref": "main"}' },
  { kind: 's3', name: 'S3-compatible storage', blurb: 'Federate a bucket from any S3-compatible object store — MinIO, Ceph, Garage, Mulga Spinifex S3, or a public cloud.', options: '{"bucket": "…", "prefix": "brand/", "endpoint": "https://s3.your-host.example", "region": "us-east-1"}' },
  { kind: 'webdav', name: 'WebDAV storage', blurb: 'Any WebDAV server the org runs — Nextcloud, ownCloud, Apache mod_dav — federated read-only over the open protocol.', options: '{"baseUrl": "https://cloud.your-host.example", "flavor": "nextcloud", "root": "Brand"}' },
  { kind: 'penpot', name: 'Penpot', blurb: 'Open, self-hostable design tool — federate your design tokens (DTCG) so /design and brand themes inherit from Penpot, and search-and-import boards as catalog media.', options: '{"baseUrl": "https://design.your-host.example", "teamId": "…"}', mapping: '{"typeMap": {"tokens": "tokens", "board": "image"}, "defaultType": "image"}' },
  { kind: 'gdrive', name: 'Google Drive', blurb: 'Pull a shared Drive folder into the catalog.', options: '{"folderId": "…"}' },
  { kind: 'dropbox', name: 'Dropbox', blurb: 'Mirror a Dropbox folder of approved assets.', options: '{"path": "/Brand"}' },
  { kind: 'o365', name: 'Microsoft 365 / SharePoint', blurb: 'Read a SharePoint library or OneDrive path.', options: '{"driveId": "…", "path": "/Brand"}' },
  { kind: 'brandfolder', name: 'Brandfolder', blurb: 'Connect a Brandfolder DAM as a read-only source.', options: '{"brandfolderId": "…"}' },
  { kind: 'optimizely-cmp', name: 'Optimizely CMP', blurb: 'Optimizely CMP web DAM — federate read-only, and optionally publish lolly-made media back out.', options: '{"publish": true}' },
  { kind: 'imagerelay', name: 'Image Relay', blurb: 'Image Relay DAM — read-only, with the exit path (materialize → cut over) for off-boarding.', options: '{"folderId": "…", "recursive": true}' },
  { kind: 'canto', name: 'Canto', blurb: 'Canto DAM — read-only, with the exit path (materialize → cut over) for off-boarding.', options: '{"tenant": "acme", "approvedStates": ["approved"]}' },
  { kind: 'acquia-dam', name: 'Acquia DAM / Widen', blurb: 'The Widen enterprise DAM — read-only, with native release/expiry dates and approval.', options: '{"query": "…", "approvedStatuses": ["active"]}' },
  { kind: 'intelligencebank', name: 'IntelligenceBank', blurb: 'IntelligenceBank — federate the v3 Graph API read-only, with the exit path for off-boarding.', options: '{"platformUrl": "https://acme.intelligencebank.com", "approvedStates": ["Approved"]}' },
  { kind: 'mock', name: 'Mock (dev)', blurb: 'A synthetic in-memory source for local development.', options: '{}' },
];

async function viewProviders(main) {
  const { providers } = await api('/api/v1/catalog/providers');
  const panelHost = el('div', {});

  // Write-only credential panel: secret in, fingerprint + health out.
  const showCredential = (p) => {
    const secretInput = el('input', { type: 'password', autocomplete: 'off', placeholder: 'API key / token' });
    const status = errSpan();
    const saveBtn = el('button', { class: 'primary', onclick: async () => {
      if (!secretInput.value) { status.textContent = 'Enter the secret first.'; return; }
      status.textContent = '';
      saveBtn.disabled = true;
      try {
        const r = await api(`/api/v1/catalog/providers/${p.id}/credential`, { method: 'PUT', body: { secret: secretInput.value } });
        secretInput.value = '';
        status.textContent = `Stored (${r.fingerprint}) — health ok.`;
        setTimeout(route, 900);
      } catch (e) { status.textContent = e.message; saveBtn.disabled = false; }
    } }, 'Verify & store');
    panelHost.replaceChildren(el('div', { class: 'card stack' },
      el('div', { class: 'list-bar' },
        el('h2', { class: 'flush' }, `Credential — ${p.label}`),
        el('button', { onclick: () => panelHost.replaceChildren() }, 'Close')),
      el('p', { class: 'sub' }, 'The key is verified against the provider, sealed at rest, and never shown again — only its fingerprint. Replacing it re-runs the same check before anything is overwritten.'),
      el('div', { class: 'formrow' },
        field('Secret', secretInput)),
      el('p', {}, saveBtn),
      status));
    secretInput.focus();
    scrollIntoViewMotionSafe(panelHost);
  };
  const panels = { showCredential };

  // Configure → test (dry-run preview, nothing persisted) → create, prefilled
  // for the integration the admin picked. This is exactly the old add-form logic
  // — the only change is the kind is fixed by the card, not chosen in a dropdown.
  const showConnect = (integration) => {
    const idInput = el('input', { placeholder: 'brand-dam (lowercase slug)' });
    const labelInput = el('input', { placeholder: integration.name });
    const optionsInput = el('textarea', { rows: 2, placeholder: integration.options });
    // Mapping is how a source's native types land in the catalog (e.g. Penpot's
    // tokens → the `tokens` type). Prefilled from the card when it ships a default.
    const mappingInput = el('textarea', { rows: 2, placeholder: '{"defaultType": "image", "typeMap": {"Color": "palette"}}' });
    if (integration.mapping) mappingInput.value = integration.mapping;
    const exposureInput = el('textarea', { rows: 2, placeholder: '{"groups": ["design"], "requireApproved": true}' });
    const secretInput = el('input', { type: 'password', autocomplete: 'off', placeholder: integration.kind === 'mock' ? 'not required for mock' : 'secret (used for the test, not stored)' });
    const addErr = errSpan();
    const testResult = el('div', {});
    const parseJson = (input, name) => {
      if (!input.value.trim()) return {};
      try { return JSON.parse(input.value); } catch { throw new Error(`${name} is not valid JSON`); }
    };
    const bodyOf = () => ({
      kind: integration.kind, label: labelInput.value || idInput.value,
      options: parseJson(optionsInput, 'Options'), mapping: parseJson(mappingInput, 'Mapping'), exposure: parseJson(exposureInput, 'Exposure'),
    });
    const testBtn = el('button', { onclick: async () => {
      addErr.textContent = '';
      testResult.replaceChildren();
      testBtn.disabled = true;
      try {
        const r = await api('/api/v1/catalog/providers/preview', { method: 'POST', body: { ...bodyOf(), secret: secretInput.value || undefined } });
        // A tenant that answers the health check but fails the listing is a
        // FAILURE here, not "connection ok with an empty sample": sampleError
        // carries the driver's own live-verify message, and dropping it is the
        // one thing this dry run exists to prevent. skipped/notes ride along
        // for the same reason - a source that maps 0 of 100 must say so.
        const fail = !r.health.ok || r.sampleError;
        const detail = r.health.ok ? r.sampleError : (r.health.detail ?? '');
        const notes = [
          ...(r.excludedByExposure ? [`${r.excludedByExposure} asset(s) excluded by the exposure slice`] : []),
          ...(r.skipped ? [`${r.skipped} record(s) skipped - the driver could not map them`] : []),
          ...(r.notes ?? []),
        ];
        testResult.replaceChildren(fail
          ? el('div', {},
              el('p', {}, el('span', { class: 'status revoked' }, 'failed'), ` ${detail ?? ''}`),
              ...notes.map((n) => el('p', { class: 'muted' }, n)))
          : el('div', {},
              el('p', {}, el('span', { class: 'status live' }, 'connection ok'), ` — sample of ${r.sample.length} mapped asset${r.sample.length === 1 ? '' : 's'}:`),
              el('ul', {}, ...r.sample.map((s) => el('li', {}, `${s.name} `, el('span', { class: 'muted' }, `(${s.type}${s.tags?.length ? ` · ${s.tags.join(', ')}` : ''})`)))),
              ...notes.map((n) => el('p', { class: 'muted' }, n))));
      } catch (e) { addErr.textContent = e.message; }
      testBtn.disabled = false;
    } }, 'Test connection');
    const createBtn = el('button', { class: 'primary', onclick: async () => {
      addErr.textContent = '';
      createBtn.disabled = true;
      try {
        await api('/api/v1/catalog/providers', { method: 'POST', body: { id: idInput.value.trim(), ...bodyOf() } });
        route();
      } catch (e) { addErr.textContent = e.message; createBtn.disabled = false; }
    } }, 'Create source');

    panelHost.replaceChildren(el('div', { class: 'card stack' },
      el('div', { class: 'list-bar' },
        el('h2', { class: 'flush' }, `Connect ${integration.name}`, el('span', { class: 'muted mono' }, `  ${integration.kind}`)),
        el('button', { onclick: () => panelHost.replaceChildren() }, 'Close')),
      el('p', { class: 'sub' }, 'Test the connection first — the dry run verifies the key against the provider and previews how assets will map, without saving anything. New sources are created disabled: set a key on the row below, then enable.'),
      el('div', { class: 'formrow' },
        field('Id', idInput),
        field('Label', labelInput)),
      el('div', { class: 'formrow' },
        field('Options (JSON)', optionsInput),
        field('Mapping (JSON)', mappingInput)),
      el('div', { class: 'formrow' },
        field('Exposure (JSON)', exposureInput),
        field(integration.kind === 'mock' ? 'Secret (optional)' : 'Secret for test', secretInput)),
      el('p', {}, testBtn, ' ', createBtn),
      addErr,
      testResult));
    idInput.focus();
    scrollIntoViewMotionSafe(panelHost);
  };

  const connectGrid = el('div', { class: 'grid connect-grid' },
    ...PROVIDER_INTEGRATIONS.map((intg) => el('div', { class: 'card connect-card' },
      el('div', { class: 'connect-card-body' },
        el('div', { class: 'connect-name' }, intg.name),
        el('div', { class: 'connect-kind mono' }, intg.kind),
        el('p', { class: 'connect-blurb' }, intg.blurb)),
      el('button', { onclick: () => showConnect(intg) }, 'Connect'))));

  // Search-and-import (plans/30 §3.1): live-search the enabled sources and import a
  // single result into the catalog as an instance-owned snapshot. The curation gate —
  // experimentation stays upstream (e.g. in Penpot), only picked assets land here.
  const searchImportPanel = () => {
    const qInput = el('input', { placeholder: 'Search connected sources — e.g. a Penpot board' });
    const out = el('div', {});
    const status = errSpan();
    const run = async () => {
      const q = qInput.value.trim();
      if (!q) return;
      status.textContent = '';
      out.replaceChildren(el('p', { class: 'sub' }, 'Searching…'));
      try {
        const r = await api(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&limit=30`);
        const rows = (r.results ?? []).filter((a) => a.provider);
        if (!rows.length) {
          out.replaceChildren(el('p', { class: 'muted' }, 'No importable source results.'));
        } else {
          out.replaceChildren(el('ul', { class: 'stack flush' }, ...rows.map((a) => {
            const remoteId = a.id.slice(`ext/${a.provider}/`.length);
            const importBtn = el('button', { onclick: async () => {
              importBtn.disabled = true; status.textContent = '';
              try {
                const res = await api(`/api/v1/catalog/providers/${a.provider}/import`, { method: 'POST', body: { remoteId } });
                importBtn.replaceWith(el('span', { class: 'status live' }, `imported → ${res.imported.id}`));
              } catch (e) { importBtn.disabled = false; status.textContent = e.message; }
            } }, 'Import');
            return el('li', { class: 'list-bar' },
              el('span', {}, `${a.name} `, el('span', { class: 'muted mono' }, `${a.type} · ${a.provider}`)),
              importBtn);
          })));
        }
        if (r.providersUnavailable?.length) status.textContent = `Some sources didn’t respond: ${r.providersUnavailable.join(', ')}`;
      } catch (e) { out.replaceChildren(); status.textContent = e.message; }
    };
    qInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') run(); });
    return el('div', { class: 'card stack' },
      el('h2', {}, 'Search & import'),
      el('p', { class: 'sub' }, 'Live-search connected sources and import a result into the catalog as an instance-owned copy — keep experimentation upstream (e.g. in Penpot), land only curated assets here, with full rigor.'),
      el('div', { class: 'formrow' }, field('Query', qInput), el('button', { onclick: run }, 'Search')),
      out, status);
  };

  const enabled = providers.filter((p) => p.enabled).length;
  const errored = providers.filter((p) => p.state?.lastError).length;
  const assets = providers.reduce((a, p) => a + (p.state?.assetCount ?? 0), 0);
  const hdr = await activityHeader('Provider configuration changes and sync runs per day.', [
    { key: 'a', label: 'Config changes', match: ['catalog.provider.create', 'catalog.provider.update', 'catalog.provider.delete', 'catalog.provider.enable', 'catalog.provider.disable', 'catalog.provider.credential'] },
    { key: 'b', label: 'Syncs', match: ['catalog.provider.sync', 'catalog.provider.preview'] },
  ]);
  main.append(
    el('h1', {}, 'Providers'),
    el('p', { class: 'sub' }, 'Federated catalog sources — the external system stays the source of truth; lolly consumes read-only, and exposure rules decide which slice your members see. Pick an integration to connect; new sources start disabled: configure, set a key, then enable.'),
    ...(hdr ? [hdr] : []),
    providers.length
      ? el('div', { class: 'grid tiles' },
          tile('Sources', fmt(providers.length)),
          tile('Enabled', fmt(enabled)),
          tile('Errored', fmt(errored)),
          tile('Assets synced', fmt(assets)))
      : null,
    el('div', { class: 'card stack' },
      el('h2', {}, 'Connect a source'),
      connectGrid),
    searchImportPanel(),
    panelHost,
    el('div', { class: 'card stack' },
      el('h2', {}, 'Configured sources'),
      providers.length
        ? dataTable(
            ['Provider', 'Kind', { label: 'Status', sort: false }, { label: 'Assets', num: true }, { label: 'Last sync', sort: false }, { label: 'Credential', sort: false }, { label: 'Actions', w: '300px', sort: false }],
            providers.map((p) => providerRow(p, panels)), { sortable: true })
        : el('p', { class: 'empty' }, 'No sources connected yet. Pick an integration above to federate an external DAM, bucket, or repo into the catalog.')),
  );
}

// ── approvals ─────────────────────────────────────────────────────────────
/** State token: one visual language for the whole column — every state is a
 *  status-dot + label, never colour alone. approved=good, rejected=critical,
 *  in-progress=accent, withdrawn=muted. */
function stateChip(state) {
  const [cls, label] = state === 'approved' ? ['live', 'approved']
    : state === 'rejected' ? ['revoked', 'rejected']
    : state === 'withdrawn' ? ['', 'withdrawn']
    : state === 'submitted' ? ['review', 'submitted']
    : ['review', 'in review'];
  return el('span', { class: `status ${cls}`.trim() }, label);
}

// Compact relative time ("3h ago"), falling back to an absolute stamp past a
// month so old approvals still read exactly.
function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24; if (d < 30) return `${Math.round(d)}d ago`;
  return when(iso);
}

// A step's clearance rule as a legible badge: any → 'any one',
// {quorum:n} → 'any n', all → 'everyone'.
function ruleLabel(rule) {
  if (rule === 'all') return 'everyone';
  if (rule && typeof rule === 'object' && rule.quorum) return `any ${rule.quorum}`;
  return 'any one';
}

// The full ordered step list, tolerating an older payload that only carried the
// current step (so the console never crashes mid-deploy).
function stepsOf(a) {
  if (Array.isArray(a.steps) && a.steps.length) return a.steps;
  const n = Math.max(1, a.stepCount || 1);
  return Array.from({ length: n }, (_, i) => ({
    name: i === a.stepIndex ? (a.stepName || `Step ${i + 1}`) : `Step ${i + 1}`,
    rule: i === a.stepIndex ? (a.stepRule ?? 'any') : 'any',
    groups: [],
  }));
}

// Per-node state derived from the approval's position + terminal state. Status
// colours (done/rejected) express STATE, never brand; the current-node ring is
// the only accent (wayfinding chrome).
function nodeState(a, i) {
  if (a.state === 'rejected') {
    const rej = [...a.actions].reverse().find((x) => x.action === 'reject');
    const at = rej ? rej.step : a.stepIndex;
    return i === at ? 'rejected' : i < at ? 'done' : 'unreached';
  }
  if (a.state === 'approved') return 'done';
  if (a.state === 'withdrawn') return i < a.stepIndex ? 'done' : i === a.stepIndex ? 'frozen' : 'unreached';
  // in-progress (submitted / in_review)
  return i < a.stepIndex ? 'done' : i === a.stepIndex ? 'current' : 'pending';
}

// A ~26px circular marker: ✓ for done, × for rejected, the ordinal otherwise.
function stepMarker(state, ordinal) {
  const svg = el('svg:svg', { class: `smark smark-${state}`, viewBox: '0 0 26 26', width: 26, height: 26, 'aria-hidden': 'true' });
  svg.append(el('circle:svg', { class: 'smark-ring', cx: 13, cy: 13, r: 11 }));
  if (state === 'done') svg.append(el('path:svg', { class: 'smark-glyph', d: 'M7.5 13.5l3.4 3.4L18.5 9.3', fill: 'none' }));
  else if (state === 'rejected') svg.append(el('path:svg', { class: 'smark-glyph', d: 'M9 9l8 8M17 9l-8 8', fill: 'none' }));
  else svg.append(el('text:svg', { class: 'smark-num', x: 13, y: 17, 'text-anchor': 'middle' }, String(ordinal)));
  return svg;
}

// One quote block per act on a node — rejection reasons are prominent (they
// drive the redo); approve notes are muted.
function actQuote(x) {
  return el('div', { class: `step-act${x.action === 'reject' ? ' reject' : ''}` },
    el('div', { class: 'step-act-who' },
      el('strong', {}, x.action === 'reject' ? 'Rejected' : 'Approved'),
      ' by ', x.actorName ?? x.actor,
      x.at ? el('span', { class: 'muted' }, ' · ', relTime(x.at)) : null),
    x.comment ? el('blockquote', { class: 'step-quote' }, x.comment) : null);
}

// A single stepper node.
function renderStep(a, i, { actionable }) {
  const step = stepsOf(a)[i];
  const st = nodeState(a, i);
  const acts = (a.actions || []).filter((x) => x.step === i);
  const approvedCount = new Set(acts.filter((x) => x.action === 'approve').map((x) => x.actor)).size;
  const quorum = step.rule && typeof step.rule === 'object' ? step.rule.quorum : null;
  const groups = (step.groups || []).join(', ');
  const aria = `Step ${i + 1} of ${stepsOf(a).length}, ${step.name}, ${st}` + (groups ? `, ${groups}` : '');

  const body = el('div', { class: 'step-body' },
    el('div', { class: 'step-name' }, step.name,
      st === 'current' && actionable ? el('span', { class: 'turn-badge' }, 'Your turn') : null),
    el('div', { class: 'step-sub' },
      groups ? el('span', { class: 'muted' }, groups) : null,
      el('span', { class: 'rule-badge' }, ruleLabel(step.rule)),
      quorum ? el('span', { class: 'muted' }, `${approvedCount} of ${quorum} approved`) : null),
    // Who acted, with comments, on this node.
    ...acts.map(actQuote),
    // Current, in-progress node on a request card: who we're waiting on.
    st === 'current' && !actionable && groups ? el('div', { class: 'step-wait muted' }, `Waiting on ${groups}`) : null,
    // Routing targets pinged for the current step (nomination = routing, not exclusivity).
    st === 'current' && a.nomineeNames?.length ? el('div', { class: 'step-routed muted' }, `routed to: ${a.nomineeNames.join(', ')}`) : null,
  );

  return el('li', { class: `step ${st}`, 'aria-label': aria, ...(st === 'current' ? { 'aria-current': 'step' } : {}) },
    el('div', { class: 'step-rail' }, stepMarker(st, i + 1)),
    body);
}

// Shared horizontal stepper used identically in both sections. Approved and
// withdrawn append a terminal cap; a rejected node is itself the terminus.
function renderStepper(a, opts) {
  const steps = stepsOf(a);
  const nodes = steps.map((_, i) => renderStep(a, i, opts));
  if (a.state === 'approved') {
    const final = [...(a.actions || [])].reverse().find((x) => x.action === 'approve');
    nodes.push(el('li', { class: 'step cap-done', 'aria-label': 'Approved' },
      el('div', { class: 'step-rail' }, stepMarker('done', '✓')),
      el('div', { class: 'step-body' },
        el('div', { class: 'step-name' }, 'Approved'),
        final ? el('div', { class: 'step-sub' }, el('span', { class: 'muted' }, `by ${final.actorName ?? final.actor}`)) : null)));
  } else if (a.state === 'withdrawn') {
    nodes.push(el('li', { class: 'step cap-withdrawn', 'aria-label': 'Withdrawn' },
      el('div', { class: 'step-rail' }, stepMarker('frozen', '–')),
      el('div', { class: 'step-body' }, el('div', { class: 'step-name muted' }, 'Withdrawn'))));
  }
  return el('ol', { class: 'stepper' }, ...nodes);
}

// Inbox footer: comment + approve/reject, preserving the reject-needs-reason UX.
function approvalFooter(a) {
  const clearNeed = () => { comment.classList.remove('need'); comment.removeAttribute('aria-invalid'); };
  const comment = el('input', {
    class: 'cmt', placeholder: 'Reason (required to reject)', 'aria-label': `Reason for ${a.title}`,
    oninput: clearNeed,
  });
  const err = errSpan();
  const act = async (action) => {
    const reason = comment.value.trim();
    if (action === 'reject' && !reason) { comment.classList.add('need'); comment.setAttribute('aria-invalid', 'true'); comment.focus(); return; }
    clearNeed();
    err.textContent = '';
    try {
      await api(`/api/v1/approvals/${a.id}/act`, { method: 'POST', body: { action, comment: reason || undefined } });
      route();
    } catch (e) { err.textContent = e.message; }
  };
  return el('div', { class: 'appr-foot' },
    el('div', { class: 'appr-act' },
      comment,
      el('button', { class: 'primary', onclick: () => act('approve') }, 'Approve'),
      el('button', { class: 'danger', onclick: () => act('reject') }, 'Reject')),
    err);
}

// One approval card, identical visual grammar in both sections — only the
// action affordance differs (inbox: act footer; requests: read-only).
function renderApprovalCard(a, { actionable }) {
  return el('div', { class: 'appr-card' },
    el('div', { class: 'appr-head' },
      el('div', { class: 'appr-headmain' },
        el('div', { class: 'appr-title' }, a.title),
        el('div', { class: 'appr-meta' },
          el('span', { class: 'chip' }, a.subjectType),
          a.subjectRef ? el('span', { class: 'mono' }, a.subjectRef) : null,
          el('span', { class: 'muted' }, a.chainName),
          el('span', { class: 'muted' }, 'raised by ', a.createdByName ?? a.createdBy, ' · ', relTime(a.createdAt)))),
      stateChip(a.state)),
    // The actionable inbox stays fully expanded; a request you've only raised
    // collapses its stepper behind a one-line progress summary (it's reference,
    // not something you act on) so "Your requests" scans at a glance.
    actionable
      ? renderStepper(a, { actionable })
      : el('details', { class: 'appr-steps' },
          el('summary', {}, `Step ${Math.min(a.stepIndex + 1, stepsOf(a).length)} of ${stepsOf(a).length}`),
          renderStepper(a, { actionable })),
    actionable ? approvalFooter(a) : null);
}

async function viewApprovals(main) {
  const { approvals } = await api('/api/v1/approvals');
  const inbox = approvals.filter((a) => a.relation === 'inbox');
  const mine = approvals.filter((a) => a.relation === 'mine');
  const hdr = await activityHeader('Submissions, decisions and withdrawals per day.', [
    { key: 'a', label: 'Submitted', match: ['approval.submit'] },
    { key: 'b', label: 'Decided', match: ['approval.approve', 'approval.reject'] },
    { key: 'c', label: 'Withdrawn', match: ['approval.withdraw'] },
  ]);
  main.append(
    el('h1', {}, 'Approvals'),
    el('p', { class: 'sub' }, 'Review requests routed to your groups, and track the ones you have raised. Separation of duties means you never review your own request.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'card' },
      el('h2', {}, 'Waiting on you'),
      inbox.length
        ? el('div', { class: 'appr-list' }, ...inbox.map((a) => renderApprovalCard(a, { actionable: true })))
        : el('p', { class: 'empty' }, 'Nothing needs your review right now.')),
    el('div', { class: 'card stack' },
      el('h2', {}, 'Your requests'),
      mine.length
        ? el('div', { class: 'appr-list' }, ...mine.map((a) => renderApprovalCard(a, { actionable: false })))
        : el('p', { class: 'empty' }, 'You have not raised any approvals yet.')),
  );
}

/** Humanise a message audience object into small chips instead of raw JSON.
 *  {} / no targeting → a single muted 'Everyone'; groups/shells/engine/users
 *  each become a readable chip. */
function humanizeAudience(a) {
  // "Everyone" is a deliberate no-constraint state — render it as a distinct
  // hollow chip so it sits on the same baseline as the constraint chips instead
  // of reading as stray plain text beside them.
  const everyone = () => el('span', { class: 'chips' }, el('span', { class: 'chip chip-all' }, 'Everyone'));
  if (!a || typeof a !== 'object') return everyone();
  const chips = [];
  for (const g of Array.isArray(a.groups) ? a.groups : []) chips.push(g);
  for (const s of Array.isArray(a.shells) ? a.shells : []) chips.push(`${s} shells`);
  if (a.maxEngine) chips.push(`engine ≤ ${a.maxEngine}`);
  const users = Array.isArray(a.users) ? a.users.length : 0;
  if (users) chips.push(`${users} ${users === 1 ? 'person' : 'people'}`);
  if (!chips.length) return everyone();
  return el('span', { class: 'chips' }, ...chips.map((c) => el('span', { class: 'chip' }, c)));
}

/** Severity as a status-dot so it reads at a glance like the Kind chip beside
 *  it — chrome accent for action, warning for blocking, neutral for info. */
function severityChip(sev) {
  const cls = sev === 'blocking' ? 'expired' : sev === 'action' ? 'review' : '';
  return el('span', { class: `status ${cls}`.trim() }, sev);
}

async function viewMessages(main) {
  const { messages } = await api('/api/v1/messages');
  const sendErr = errSpan();
  const sendBtn = el('button', { class: 'primary' }, 'Send message');
  const form = el('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const audience = {};
    if (f.get('groups')) audience.groups = String(f.get('groups')).split(',').map((s) => s.trim()).filter(Boolean);
    if (f.get('shells')) audience.shells = String(f.get('shells')).split(',').map((s) => s.trim()).filter(Boolean);
    if (f.get('maxEngine')) audience.maxEngine = f.get('maxEngine');
    sendErr.textContent = '';
    sendBtn.disabled = true; // guard against double-posting the same broadcast
    try {
      await api('/api/v1/messages', { method: 'POST', body: {
        title: f.get('title'), body: f.get('body') || undefined,
        kind: f.get('kind'), severity: f.get('severity'), audience,
        endsAt: f.get('endsAt') ? new Date(String(f.get('endsAt'))).toISOString() : undefined,
      } });
      toast('Message sent');
      route();
    } catch (err) {
      sendErr.textContent = err.message;
      sendBtn.disabled = false;
    }
  } },
    field('Title', el('input', { name: 'title', required: 'true', maxlength: 200, placeholder: 'e.g. Brand pack v2026.3 is live' })),
    field('Body (optional)', el('textarea', { name: 'body', rows: 2 })),
    el('div', { class: 'formrow' },
      field('Kind', el('select', { name: 'kind' }, ...['announcement', 'upgrade', 'policy'].map((k) => el('option', {}, k)))),
      field('Severity', el('select', { name: 'severity' }, ...['info', 'action', 'blocking'].map((k) => el('option', {}, k)))),
      field('Groups (comma, empty = everyone)', el('input', { name: 'groups', placeholder: 'marketing, brand-team' })),
      field('Shells (comma)', el('input', { name: 'shells', placeholder: 'tauri' })),
      field('Max engine (targets older clients)', el('input', { name: 'maxEngine', placeholder: '1.52.99' })),
      field('Ends', el('input', { name: 'endsAt', type: 'date' })),
    ),
    el('p', {}, sendBtn, sendErr),
  );
  const hdr = await activityHeader('Messages sent per day.', [
    { key: 'a', label: 'Sent', match: ['message.send'] },
  ]);
  main.append(
    el('h1', {}, 'Messages'),
    el('p', { class: 'sub' }, 'Announcements, upgrade reminders and policy notices, delivered to connected shells. Reach shows who has seen each one.'),
    ...(hdr ? [hdr] : []),
    // Lead with the sent-log; composing is a deliberate action one click away.
    el('div', { class: 'card stack' },
      messages.length
        ? dataTable(
            ['Title', 'Kind', 'Severity', 'Audience', { label: 'Seen by', num: true }],
            messages.map((m) => el('tr', {},
              el('td', {}, m.title),
              el('td', {}, el('span', { class: 'chip' }, m.kind)),
              el('td', {}, severityChip(m.severity)),
              el('td', {}, humanizeAudience(m.audience)),
              numCell(m.acks))), { sortable: true, filter: messages.length > 8 })
        : el('p', { class: 'empty' }, 'No messages sent yet — compose one below to reach connected shells.')),
    el('details', { class: 'compose-section', open: messages.length === 0 ? 'true' : null },
      el('summary', {}, el('span', { class: 'section-h' }, 'Send a message')),
      form),
  );
}

async function viewAudit(main) {
  const { chain, total, events } = await api('/api/v1/audit?limit=60');
  const strip = el('div', { class: 'chain', role: 'img', 'aria-label': `audit chain, ${total} events, ${chain.ok ? 'intact' : `broken at ${chain.badSeq}`}` },
    ...events.map((evt) => el('div', {
      class: `seg${chain.ok === false && evt.seq >= (chain.badSeq ?? 0) ? ' bad' : ''}`,
      onmousemove: (e) => showTip(e, `<div class="t-title">#${evt.seq} · ${when(evt.at)}</div><div>${evt.actor}</div><div><b>${evt.action}</b> → ${evt.subject}</div>`),
      onmouseleave: hideTip,
    })));
  const hdr = await activityHeader('Every audited event per day, all actions.', [
    { key: 'a', label: 'Events', match: ['*'] },
  ]);
  main.append(
    el('h1', {}, 'Audit'),
    el('p', { class: 'sub' }, 'A tamper-evident record of every governed action on this deployment — sign-ins, grant and policy edits, approvals, link mints and revocations, catalog changes. It is append-only: entries are never edited or deleted, only added.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'card' },
      el('div', { class: 'chain-badge' },
        chain.ok ? el('span', { class: 'ok' }, '● Chain intact') : el('span', { class: 'broken' }, `● Chain broken at #${chain.badSeq}`),
        el('span', {}, ` · ${fmt(total)} events, latest ${events.length} shown`)),
      strip,
      // Progressive disclosure: the mechanism, for the admin who wants to know
      // exactly what "intact" proves and what it doesn't.
      el('details', { class: 'chain-explain' },
        el('summary', {}, 'What “hash-chained” means'),
        el('p', { class: 'sub flush' }, 'Each entry is stamped with a cryptographic hash (a short fingerprint) computed from its own contents plus the hash of the entry before it. That links every entry to its predecessor, all the way back to a fixed genesis value — a chain.'),
        el('p', { class: 'sub flush' }, 'Because each hash folds in the one before it, changing, deleting, or reordering any past entry changes its hash, which breaks every hash after it. The badge above verifies the whole chain on load: “Chain intact” means no entry has been altered since it was written; “Chain broken at #N” pinpoints the first entry that no longer matches. The strip shows one block per event, oldest on the left — a broken segment turns red from the break onward.'),
        el('p', { class: 'sub flush' }, 'One limit: hash-chaining detects edits within the log, but someone with direct database access could truncate the newest entries and re-chain. Recording the latest hash (the “head”) somewhere outside this deployment — via GET /api/v1/audit/head or `lw audit head` — closes that gap, because a truncated log won’t match the head you saved.')),
      dataTable(
        [{ label: '#', num: true, w: '1%' }, { label: 'When', sort: 'date' }, 'Actor', 'Action', 'Subject', { label: 'Hash', sort: false }],
        events.slice().reverse().map((evt) => el('tr', {},
          numCell(evt.seq),
          whenCell(evt.at),
          el('td', {}, evt.actor),
          el('td', {}, evt.action),
          el('td', {}, evt.subject),
          el('td', { class: 'mono', title: evt.hash }, evt.hash.slice(0, 12)))), { sortable: true, filter: true })),
  );
}

// ── people directory (plans/02) ─────────────────────────────────────────────
// Scales to thousands: every search/filter/sort/page hits the paginated
// /api/v1/users endpoint and re-renders ONLY the results container, so the
// filter controls (which live outside it) keep focus across fetches. A row
// opens an inline detail panel: identity, group membership, per-user tool
// grants, and instant lockout.
const ROLE_CHOICES = ['owner', 'admin', 'approver', 'author', 'member', 'viewer'];

// A search box over a fixed option set (native <datalist> — air-gapped, no
// library). options: [{ value, label }]. Calls onchange(value) with the resolved
// option value ('' = cleared). strict:true only fires on an exact/unique label
// match (for id-valued filters like a person); non-strict passes free text
// through (for name-valued filters like a group). Returns { node, input, set }.
let dlSeq = 0;
function searchSelect(options, { placeholder = 'Search…', value = '', strict = false, onchange }) {
  const id = `dl-${++dlSeq}`;
  const byLabel = new Map(options.map((o) => [o.label.toLowerCase(), o]));
  const cur = options.find((o) => o.value === value);
  const input = el('input', { list: id, placeholder, autocomplete: 'off', value: cur ? cur.label : '' });
  const datalist = el('datalist', { id }, ...options.map((o) => el('option', { value: o.label })));
  input.onchange = () => {
    const t = input.value.trim();
    if (!t) return onchange('');
    const exact = byLabel.get(t.toLowerCase());
    if (exact) return onchange(exact.value);
    const partial = options.filter((o) => o.label.toLowerCase().includes(t.toLowerCase()));
    if (partial.length === 1) { input.value = partial[0].label; return onchange(partial[0].value); }
    if (strict) return;              // unresolved id → keep the previous selection
    onchange(t);                     // free text (value === label, e.g. a group name)
  };
  return { node: el('span', { class: 'search-select' }, input, datalist), input, set: (v) => { input.value = v; } };
}

async function viewUsers(main, params) {
  const state = { q: '', prefix: '', role: '', group: '', status: '', sort: 'name', dir: 'asc', page: 1, pageSize: 50 };
  const buildQuery = () => {
    const p = new URLSearchParams();
    for (const k of ['q', 'prefix', 'role', 'group', 'status', 'sort', 'dir']) if (state[k]) p.set(k, state[k]);
    p.set('page', String(state.page));
    p.set('pageSize', String(state.pageSize));
    return p.toString();
  };

  // First load throws to route() so a non-admin gets the clean 403 view; the
  // group registry is best-effort (it drives the group filter + local editor).
  const [groupsResp, firstData] = await Promise.all([
    api('/api/v1/groups').catch(() => ({ groups: [] })),
    api(`/api/v1/users?${buildQuery()}`),
  ]);
  let allGroups = groupsResp.groups ?? [];
  const localGroups = () => allGroups.filter((g) => g.source === 'local');

  // The tool list (per-user grant picker) is fetched lazily on first detail open.
  let toolsCache = null;
  const loadTools = async () => (toolsCache ??= (await api('/api/v1/policy/tools').catch(() => ({ tools: [] }))).tools ?? []);

  // ── filter controls — OUTSIDE the results container so they keep focus ──────
  const searchInput = el('input', { type: 'search', placeholder: 'Search name or email…', value: state.q, 'aria-label': 'Search people' });
  let debounce = null;
  searchInput.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = searchInput.value.trim(); state.page = 1; refetch(); }, 250);
  };
  const filterSel = (key, ...opts) => {
    const sel = el('select', {}, ...opts);
    sel.value = state[key];
    sel.onchange = () => { state[key] = sel.value; state.page = 1; syncFiltersLabel(); refetch(); };
    return sel;
  };
  const roleSel = filterSel('role', el('option', { value: '' }, 'Any role'), ...ROLE_CHOICES.map((r) => el('option', { value: r }, r)));
  // Groups can be many → a searchable combobox rather than a long <select>.
  const groupBox = searchSelect(allGroups.map((g) => ({ value: g.name, label: g.name })),
    { placeholder: 'Any group', value: state.group, onchange: (v) => { state.group = v; state.page = 1; syncFiltersLabel(); refetch(); } });
  const statusSel = filterSel('status', el('option', { value: '' }, 'Any status'),
    el('option', { value: 'active' }, 'Active'), el('option', { value: 'disabled' }, 'Disabled'));

  // Progressive disclosure: Search is the everyday control and stays visible;
  // the narrower filters fold away, with the summary carrying an active count
  // so hidden state is never invisible state.
  const filtersLabel = el('span', { class: 'detail-h section-h' }, 'Filters');
  const syncFiltersLabel = () => {
    const n = ['role', 'group', 'status'].filter((k) => state[k]).length;
    filtersLabel.textContent = n ? `Filters (${n} active)` : 'Filters';
  };
  syncFiltersLabel();
  const filters = el('div', { class: 'card' },
    el('div', { class: 'formrow' },
      field('Search', searchInput)),
    el('details', { class: 'ov-section filters-more' },
      el('summary', {}, filtersLabel),
      el('div', { class: 'formrow' },
        field('Role', roleSel),
        field('Group', groupBox.node),
        field('Status', statusSel))));

  // '/' focuses search from anywhere in the directory (self-removing once the
  // view is torn down — the input is no longer connected).
  const onSlash = (e) => {
    if (!searchInput.isConnected) { document.removeEventListener('keydown', onSlash); return; }
    if (e.key !== '/' || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  };
  document.addEventListener('keydown', onSlash);
  searchInput.title = 'Press / to focus';

  // ── jump-to-letter — server-side prefix filter, composes with everything
  // above. At thousands of people this is the fast path to a name you can
  // see in your head but can't quite spell for search. '#' catches names
  // that don't start with a–z (digits, CJK, …).
  const alphaBtns = new Map();
  const syncAlpha = () => {
    for (const [val, b] of alphaBtns) {
      const on = state.prefix === val;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('active', on);
    }
  };
  const alphaBtn = (val, text) => {
    const b = el('button', {
      type: 'button', class: 'alpha-btn',
      'aria-label': val === '' ? 'All names' : val === '#' ? 'Names not starting with a letter' : `Names starting with ${text}`,
      onclick: () => { state.prefix = state.prefix === val ? '' : val; state.page = 1; syncAlpha(); refetch(); },
    }, text);
    alphaBtns.set(val, b);
    return b;
  };
  const alphaBar = el('div', { class: 'alpha-bar', role: 'group', 'aria-label': 'Jump to names starting with' },
    alphaBtn('', 'All'),
    ...Array.from({ length: 26 }, (_, i) => alphaBtn(String.fromCharCode(97 + i), String.fromCharCode(65 + i))),
    alphaBtn('#', '#'));
  syncAlpha();

  const results = el('div', { class: 'stack' });
  const detailHost = el('div', { class: 'stack' });

  // Sortable column header — reuses dataTable by passing a button NODE as the
  // header label (th() appends whatever label it's given).
  const sortBtn = (label, key) => {
    const active = state.sort === key;
    return el('button', {
      class: `col-sort${active ? ' active' : ''}`,
      'aria-label': `Sort by ${label}${active ? (state.dir === 'asc' ? ', ascending' : ', descending') : ''}`,
      onclick: () => {
        if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = key; state.dir = 'asc'; }
        state.page = 1;
        refetch();
      },
    }, label, active ? el('span', { class: 'sort-caret', 'aria-hidden': 'true' }, state.dir === 'asc' ? '▲' : '▼') : null);
  };

  function userRow(u) {
    const open = () => openDetail(u);
    // Name is a real link for keyboard access; the whole row is a mouse target.
    const nameLink = el('a', { class: 'link-btn', href: '#/users', onclick: (e) => { e.preventDefault(); e.stopPropagation(); open(); } }, u.name);
    return el('tr', { class: 'row-click', onclick: open },
      el('td', {}, nameLink, u.disabled ? el('span', { class: 'status revoked', style: 'margin-left:8px' }, 'disabled') : null),
      el('td', { title: u.email }, u.email),
      el('td', {}, u.title ?? '—'),
      el('td', {}, el('span', { class: 'chip' }, u.role)),
      el('td', { title: u.groups.join(', ') }, u.groups.length ? u.groups.join(', ') : '—'),
      el('td', {}, when(u.lastSeenAt)));
  }

  function renderResults(data) {
    const { users, total, page, pageSize } = data;
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    announce(`${fmt(total)} ${total === 1 ? 'person' : 'people'} match`);

    const pageSizeSel = el('select', { 'aria-label': 'People per page' },
      ...[25, 50, 100, 200].map((n) => el('option', { value: n, selected: n === pageSize ? 'selected' : null }, `${n} / page`)));
    pageSizeSel.onchange = () => { state.pageSize = Number(pageSizeSel.value); state.page = 1; refetch(); };
    const prevBtn = el('button', { disabled: page <= 1 ? 'true' : null, onclick: () => { state.page = page - 1; refetch(); } }, '‹ Prev');
    const nextBtn = el('button', { disabled: end >= total ? 'true' : null, onclick: () => { state.page = page + 1; refetch(); } }, 'Next ›');

    results.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'list-bar' },
        el('h2', { class: 'flush' }, 'People'),
        el('span', { class: 'muted' }, total ? `${fmt(start)}–${fmt(end)} of ${fmt(total)}` : 'no matches')),
      users.length
        ? dataTable(
            [{ label: sortBtn('Name', 'name') }, { label: sortBtn('Email', 'email') }, 'Title',
              { label: sortBtn('Role', 'role') }, 'Groups', { label: sortBtn('Last seen', 'lastSeen') }],
            users.map(userRow),
            // The directory is server-paged/-sorted/-searched (it can hold
            // thousands of people) — client QoL here would double the controls.
            { sortable: false, filter: false, paginate: false })
        : el('p', { class: 'empty' }, 'No people match these filters.'),
      el('div', { class: 'pager' }, prevBtn, pageSizeSel, nextBtn)));
  }

  // Re-fetch guard: a superseded (stale) response must never overwrite a newer
  // one — each fetch takes a sequence number and only the latest renders.
  let reqSeq = 0;
  async function refetch() {
    const seq = ++reqSeq;
    try {
      const data = await api(`/api/v1/users?${buildQuery()}`);
      if (seq === reqSeq) renderResults(data);
    } catch (e) {
      if (seq === reqSeq) results.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'form-err', role: 'status' }, e.message)));
    }
  }

  // ── user detail panel ───────────────────────────────────────────────────────
  async function openDetail(initialU) {
    let u = initialU;
    let grants = [];
    const opener = document.activeElement; // restore focus here on Close
    detailHost.replaceChildren(el('div', { class: 'card detail-sheet' }, el('p', { class: 'sub flush' }, `Loading ${u.name}…`)));
    scrollIntoViewMotionSafe(detailHost);
    const tools = await loadTools();
    try { grants = (await api('/api/v1/grants')).grants ?? []; } catch { /* grant.edit may be absent */ }
    renderDetail(true);

    function renderDetail(focusIn) {
      const heading = el('h2', { class: 'flush', tabindex: '-1' }, u.name);
      if (focusIn) requestAnimationFrame(() => heading.focus());
      // Progressive disclosure: identity + lockout are the at-a-glance tier;
      // group membership and per-tool access expand on demand (the counts on
      // the summaries say whether there's anything inside worth opening).
      const section = (title, node, open = false) => el('details', { class: 'ov-section', ...(open ? { open: 'true' } : {}) },
        el('summary', {}, el('h3', { class: 'detail-h section-h' }, title)),
        node);
      detailHost.replaceChildren(el('div', { class: 'card stack detail-sheet' },
        el('div', { class: 'list-bar' },
          heading,
          el('button', { onclick: () => { detailHost.replaceChildren(); opener?.focus?.(); } }, 'Close')),
        identityBlock(),
        section(`Groups (${(u.groups ?? []).length})`, groupsBlock()),
        section(`Individual tool access (${grants.filter((g) => g.principal === `user:${u.id}` && g.action === 'tool.use' && g.effect === 'allow').length})`, toolAccessBlock()),
        lockoutBlock()));
    }

    function identityBlock() {
      const cell = (label, value) => el('div', { class: 'idy' }, el('div', { class: 'idy-l' }, label), el('div', { class: 'idy-v' }, value));
      return el('div', { class: 'stack' },
        el('div', { class: 'idy-grid' },
          cell('Name', u.name),
          cell('Email', u.email),
          cell('Title', u.title ?? '—'),
          cell('Role', el('span', { class: 'chip' }, u.role)),
          cell('Last seen', when(u.lastSeenAt))),
        el('p', { class: 'sub', style: 'margin:8px 0 0' }, `Name, email, title and role are managed by ${idpName()} — read-only here. Role is derived from group membership.`));
    }

    function groupsBlock() {
      const err = errSpan();
      const idp = u.idpGroups ?? [];
      const checkedSet = new Set(u.localGroups ?? []);
      const entries = localGroups().map((g) => {
        const cb = el('input', { type: 'checkbox', ...(checkedSet.has(g.name) ? { checked: 'checked' } : {}) });
        return { name: g.name, cb, node: el('label', { class: 'chk' }, cb, el('span', {}, g.name), g.description ? el('span', { class: 'muted' }, ` — ${g.description}`) : null) };
      });

      const saveBtn = el('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        saveBtn.disabled = true;
        const groups = entries.filter((e) => e.cb.checked).map((e) => e.name);
        try {
          u = await api(`/api/v1/users/${u.id}/local-groups`, { method: 'PUT', body: { groups } });
          announce('Local groups saved');
          renderDetail();  // reflect the recomputed effective groups + role
          refetch();       // the list's Groups/Role columns show the effective set
        } catch (e) { err.textContent = e.message; saveBtn.disabled = false; }
      } }, 'Save local groups');

      // 'New local group' affordance (admin) — POST /api/v1/groups, then it
      // becomes an option here and in the group filter without a full reload.
      const newName = el('input', { placeholder: 'brand', 'aria-label': 'New local group name' });
      const newErr = errSpan();
      const addBtn = el('button', { onclick: async () => {
        const name = newName.value.trim();
        if (!name) { newErr.textContent = 'Name the group.'; return; }
        newErr.textContent = '';
        addBtn.disabled = true;
        try {
          const g = await api('/api/v1/groups', { method: 'POST', body: { name } });
          allGroups = [...allGroups, g].sort((a, b) => a.name.localeCompare(b.name));
          groupSel.append(el('option', { value: g.name }, `${g.name} (${g.source})`));
          newName.value = '';
          announce(`Local group ${g.name} created`);
          renderDetail();
        } catch (e) { newErr.textContent = e.message; addBtn.disabled = false; }
      } }, 'Create');

      return el('div', { class: 'stack' },
        el('div', { class: 'gr-split' },
          el('div', {},
            el('div', { class: 'gr-label' }, 'IdP groups ', el('span', { class: 'muted' }, `· Managed by ${idpName()}`)),
            idp.length ? el('div', { class: 'chips' }, ...idp.map((g) => el('span', { class: 'chip' }, g))) : el('span', { class: 'muted' }, 'none')),
          el('div', {},
            el('div', { class: 'gr-label' }, 'Local groups ', el('span', { class: 'muted' }, '· editable')),
            entries.length
              ? el('div', { class: 'chk-list' }, ...entries.map((e) => e.node))
              : el('span', { class: 'muted' }, 'No local groups defined yet.'),
            el('p', {}, saveBtn), err)),
        el('div', { class: 'formrow newgrp' },
          field('New local group', newName),
          el('div', {}, el('label', {}, ' '), addBtn)),
        newErr);
    }

    function toolAccessBlock() {
      const err = errSpan();
      const principal = `user:${u.id}`;
      const toolGrants = grants.filter((g) => g.principal === principal && g.action === 'tool.use' && g.effect === 'allow');
      const grantedIds = new Set(toolGrants.map((g) => g.resource.replace(/^tool:/, '')));

      const grantRows = toolGrants.map((g) => {
        const toolId = g.resource.replace(/^tool:/, '');
        const tool = tools.find((t) => t.id === toolId);
        const rm = armConfirmButton({ class: 'danger' }, 'Remove', 'Really remove?', async (disarm) => {
          err.textContent = '';
          rm.disabled = true;
          try {
            await api('/api/v1/grants', { method: 'DELETE', body: { principal, action: 'tool.use', resource: g.resource, effect: 'allow' } });
            grants = grants.filter((x) => !(x.principal === principal && x.action === 'tool.use' && x.resource === g.resource && x.effect === 'allow'));
            announce('Tool access removed');
            renderDetail();
          } catch (e) { err.textContent = e.message; rm.disabled = false; disarm(); }
        });
        return el('tr', {},
          el('td', {}, tool ? tool.name : toolId, el('div', { class: 'muted mono' }, toolId)),
          el('td', {}, rm));
      });

      const options = tools.filter((t) => !grantedIds.has(t.id));
      const toolSel = el('select', { 'aria-label': 'Tool to grant' }, ...options.map((t) => el('option', { value: t.id }, `${t.name} (${t.id})`)));
      const addBtn = el('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        addBtn.disabled = true;
        const resource = `tool:${toolSel.value}`;
        try {
          const r = await api('/api/v1/grants', { method: 'POST', body: { principal, action: 'tool.use', resource, effect: 'allow' } });
          grants = [...grants, r.grant ?? { principal, action: 'tool.use', resource, effect: 'allow' }];
          announce('Tool access granted');
          renderDetail();
        } catch (e) { err.textContent = e.message; addBtn.disabled = false; }
      } }, 'Grant access');

      return el('div', { class: 'stack' },
        el('p', { class: 'sub' }, 'Grants this person a tool outside their groups’ visibility — a per-user allow for tool.use on that one tool. It changes only this person, not their groups.'),
        toolGrants.length
          ? dataTable(['Tool', { label: 'Actions', w: '1%' }], grantRows)
          : el('p', { class: 'empty' }, 'No individual tool grants — this person sees only their groups’ tools.'),
        options.length
          ? el('div', { class: 'formrow newgrp' }, field('Add tool', toolSel), el('div', {}, el('label', {}, ' '), addBtn))
          : (tools.length ? el('p', { class: 'muted' }, 'Every tool is already granted individually.') : el('p', { class: 'muted' }, 'No tools available to grant.')),
        err);
    }

    function lockoutBlock() {
      const err = errSpan();
      const btn = armConfirmButton(
        { class: u.disabled ? 'primary' : 'danger' },
        u.disabled ? 'Re-enable access' : 'Disable access',
        u.disabled ? 'Really re-enable?' : 'Really disable?',
        async (disarm) => {
          err.textContent = '';
          btn.disabled = true;
          try {
            u = await api(`/api/v1/users/${u.id}/disabled`, { method: 'POST', body: { disabled: !u.disabled } });
            announce(u.disabled ? 'Access disabled' : 'Access re-enabled');
            renderDetail();
            refetch();
          } catch (e) { err.textContent = e.message; btn.disabled = false; disarm(); }
        });
      // "Sign out everywhere" — pre-expiry revocation without the lockout:
      // bumps the session epoch so every live session dies, but they can sign
      // back in immediately. Disabling already revokes on its own.
      const revokeErr = errSpan();
      const revokeBtn = armConfirmButton({ class: 'danger' }, 'Sign out everywhere', 'Really sign out?', async (disarm) => {
        revokeErr.textContent = '';
        revokeBtn.disabled = true;
        try {
          await api(`/api/v1/users/${u.id}/revoke-sessions`, { method: 'POST' });
          announce('Signed out everywhere');
        } catch (e) { revokeErr.textContent = e.message; }
        revokeBtn.disabled = false;
        disarm();
      });
      return el('div', { class: 'stack' },
        el('h3', { class: 'detail-h' }, 'Access'),
        el('p', { style: 'margin:0 0 6px' },
          u.disabled ? el('span', { class: 'status revoked' }, 'disabled') : el('span', { class: 'status live' }, 'active'),
          el('span', { class: 'sub', style: 'margin:0 0 0 10px' }, u.disabled
            ? 'Locked out — their sessions are refused immediately. Re-enabling restores access.'
            : 'Disabling locks the account instantly and kills live sessions. Disabling an owner is owner-only.')),
        el('p', {}, btn, ' ', revokeBtn), err, revokeErr);
    }
  }

  const hdr = await activityHeader('Sign-ins and account changes per day.', [
    { key: 'a', label: 'Sign-ins', match: ['auth.login'] },
    { key: 'b', label: 'Account changes', match: ['user.', 'group.'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'People'),
    el('p', { class: 'sub' }, `Everyone who has signed in — search, filter and sort across the directory. Open a person for their groups, individual tool access and instant lockout. Identity and role follow ${idpName()}; telemetry attribution is each person’s own opt-in choice.`),
    ...(hdr ? [hdr] : []),
    filters,
    alphaBar,
    results,
    detailHost);
  renderResults(firstData);
  // Deep link from the activity feed: #/users?focus=<id> opens that person.
  const focusId = params?.get?.('focus');
  if (focusId) {
    try { await openDetail(await api(`/api/v1/users/${encodeURIComponent(focusId)}`)); }
    catch { /* stale/removed user — the directory still renders */ }
  }
}

// ── copy-to-clipboard affordance ────────────────────────────────────────────
// Air-gapped: the async Clipboard API with an execCommand fallback, no external
// calls. Shared so any link surface can offer the same one-click copy.
function copyButton(getText, label = 'Copy link') {
  const btn = el('button', { onclick: async () => {
    const text = getText();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      try {
        const ta = el('textarea', { style: 'position:fixed;top:-1000px;opacity:0' });
        ta.value = text; document.body.append(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch { ok = false; }
    }
    announce(ok ? 'Link copied to clipboard' : 'Copy failed — select the link manually');
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = label; }, 1600);
  } }, label);
  return btn;
}

// ── contractors (plans/02) ───────────────────────────────────────────────────
// Contractors are NOT accounts — they are expiring, single-tool guest-edit
// links. Mint one (mandatory, server-capped expiry), hand over the URL, and
// revoke live ones on the spot. Minting needs link.create-guest, which admins
// can delegate to a local group via the Grants view.
async function viewContractors(main) {
  const [toolsResp, linksResp] = await Promise.all([
    api('/api/v1/policy/tools').catch(() => ({ tools: [] })),
    api('/api/v1/links?all=1').catch(() => ({ links: [] })),
  ]);
  const tools = toolsResp.tools ?? [];

  const listHost = el('div', { class: 'stack' });
  function guestLinkRow(l) {
    const rowErr = errSpan();
    const copy = copyButton(() => l.url, 'Copy');
    const revoke = l.status === 'live'
      ? armConfirmButton({ class: 'danger' }, 'Revoke', 'Really revoke?', async (disarm) => {
          rowErr.textContent = '';
          revoke.disabled = true;
          try { await api(`/api/v1/links/${l.id}/revoke`, { method: 'POST' }); refreshList(); }
          catch (e) { rowErr.textContent = e.message; revoke.disabled = false; disarm(); }
        })
      : null;
    return el('tr', {},
      el('td', {}, l.target.toolId ?? '—', l.protected ? ' 🔒' : ''),
      el('td', {}, el('span', { class: `status ${l.status}` }, l.status)),
      whenCell(l.expiresAt),
      el('td', { class: 'mono', title: l.id }, l.id),
      el('td', {}, el('div', { class: 'lc-actions' }, copy, revoke), rowErr));
  }
  function renderList(links) {
    listHost.replaceChildren(el('div', { class: 'card' },
      el('h2', {}, 'Guest links'),
      links.length
        ? dataTable(['Tool', 'Status', { label: 'Expires', sort: 'date' }, { label: 'Id', w: '140px', sort: false }, { label: 'Actions', w: '1%', sort: false }], links.map(guestLinkRow), { sortable: true })
        : el('p', { class: 'empty' }, 'No guest links yet. Mint one above to give a contractor time-boxed access to a single tool.')));
  }
  async function refreshList() {
    try {
      const r = await api('/api/v1/links?all=1');
      renderList((r.links ?? []).filter((l) => l.kind === 'guest-edit'));
    } catch { /* keep the current list on a transient error */ }
  }

  // ── mint form ──
  const toolSel = el('select', { 'aria-label': 'Tool' }, ...tools.map((t) => el('option', { value: t.id }, `${t.name} (${t.id})`)));
  const ttlInput = el('input', { type: 'number', min: '1', step: '1', required: 'true', value: '72', 'aria-label': 'Expires in hours' });
  const pwInput = el('input', { type: 'password', autocomplete: 'off', placeholder: 'optional password' });
  const err = errSpan();
  const result = el('div', { class: 'me-result' });

  const mintBtn = el('button', { class: 'primary' }, 'Mint guest link');
  const form = el('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    result.replaceChildren();
    const ttlHours = Number(ttlInput.value);
    if (!Number.isFinite(ttlHours) || ttlHours < 1) { err.textContent = 'Expiry is required — enter at least 1 hour.'; return; }
    if (!tools.length) { err.textContent = 'No tools are available to scope a guest link.'; return; }
    mintBtn.disabled = true;
    try {
      const r = await api('/api/v1/links', { method: 'POST', body: {
        kind: 'guest-edit', target: { toolId: toolSel.value }, ttlHours,
        ...(pwInput.value ? { password: pwInput.value } : {}),
      } });
      pwInput.value = '';
      // The server caps the ttl — the returned expiry is authoritative, so a
      // request beyond the cap is surfaced honestly rather than as-typed.
      const actualHours = Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 3600000);
      const capped = actualHours < ttlHours - 1;
      result.replaceChildren(el('div', { class: 'card mint-out' },
        el('div', { class: 'list-bar' },
          el('span', {}, el('span', { class: 'status live' }, 'guest link ready'),
            capped ? el('span', { class: 'muted' }, ` · capped to the deployment maximum (~${fmt(actualHours)}h)`) : null),
          copyButton(() => r.url)),
        el('p', { class: 'mono url-line' }, r.url),
        el('p', { class: 'sub flush' }, `Expires ${when(r.expiresAt)} · single tool: ${toolSel.value}`)));
      announce('Guest link minted');
      refreshList();
    } catch (e) { err.textContent = e.message; }
    mintBtn.disabled = false;
  } },
    el('h2', {}, 'Mint a guest link'),
    el('p', { class: 'sub' }, 'Contractors get a time-boxed, single-tool guest session — no account. Expiry is mandatory and capped by the deployment; the created link shows its real expiry. Minting requires link.create-guest, which admins can delegate to a local group (e.g. group:brand) via the Grants view.'),
    tools.length
      ? el('div', { class: 'formrow' },
          field('Tool', toolSel),
          field('Expires in (hours, required)', ttlInput),
          field('Password (optional)', pwInput))
      : el('p', { class: 'empty' }, 'No tools found — mount a brand pack with tools to scope guest links.'),
    el('p', {}, mintBtn),
    err,
    result);

  const hdr = await activityHeader('Guest sessions admitted per day.', [
    { key: 'a', label: 'Guest sessions', match: ['guest.admit'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Contractors'),
    el('p', { class: 'sub' }, 'External collaborators work through expiring, tool-scoped guest links instead of accounts. Mint a link, hand it over, and revoke it the moment the engagement ends — revoking kills any live guest session immediately.'),
    ...(hdr ? [hdr] : []),
    form,
    listHost);
  renderList((linksResp.links ?? []).filter((l) => l.kind === 'guest-edit'));
}

// ── projects + sessions (plans/08) ────────────────────────────────────────
/** private → a neutral chip; team → a 'team' chip plus the group list as quiet
 *  secondary text, so chip widths stay uniform down the column. */
function visibilityChip(v) {
  if (v === 'private' || !v) return el('span', { class: 'chip' }, 'private');
  const groups = Array.isArray(v.groups) ? v.groups : [];
  return el('span', { class: 'chip-side' },
    el('span', { class: 'chip' }, 'team'),
    groups.length ? el('span', { class: 'sec', title: groups.join(', ') }, groups.join(', ')) : null);
}

/** Render a value cell for a diff — undefined (unset) reads as a muted dash. */
function fmtVal(v) {
  if (v === undefined) return el('span', { class: 'muted' }, '—');
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Parse a `field=value` per-line block into a set object (values stay strings —
 *  the console edits text inputs; matches the exact-input-id merge rule). */
function parsePairs(text) {
  const set = {};
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (eq > 0) set[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return set;
}

// The Projects view swaps between a list and a per-project detail inside the
// same <main> (the hash router only keys on the first segment), so both render
// helpers take `main` and rebuild it via replaceChildren.
async function viewProjects(main) {
  await renderProjectList(main);
}

async function renderProjectList(main) {
  const { projects } = await api('/api/v1/projects');
  const err = errSpan();
  const form = el('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name') || '').trim();
    if (!name) { err.textContent = 'Name required.'; return; }
    const groupsRaw = String(f.get('groups') || '').trim();
    const visibility = groupsRaw
      ? { groups: groupsRaw.split(',').map((s) => s.trim()).filter(Boolean) }
      : 'private';
    err.textContent = '';
    try {
      await api('/api/v1/projects', { method: 'POST', body: { name, visibility } });
      await renderProjectList(main);
    } catch (ex) { err.textContent = ex.message; }
  } },
    el('h2', {}, 'New project'),
    el('div', { class: 'formrow' },
      field('Name', el('input', { name: 'name', required: 'true', maxlength: 200, placeholder: 'e.g. Summit 2026' })),
      field('Groups (comma, empty = private)', el('input', { name: 'groups', placeholder: 'team-eng, brand-team' }))),
    el('p', {}, el('button', { class: 'primary' }, 'Create project')),
    err);

  const rows = projects.map((p) => el('tr', {},
    el('td', {}, el('a', { class: 'link-btn', href: '#/projects', onclick: (e) => { e.preventDefault(); renderProjectDetail(main, p.id, p.name); } }, p.name)),
    el('td', {}, visibilityChip(p.visibility)),
    el('td', { class: 'num' }, p.sessionCount),
    el('td', {}, when(p.updatedAt)),
    el('td', {}, p.archivedAt ? el('span', { class: 'status expired' }, 'archived') : el('span', { class: 'status live' }, 'active'))));

  const hdr = await activityHeader('Session edits, conflicts and deletions per day.', [
    { key: 'a', label: 'Edits', match: ['session.create', 'session.update', 'sessions.bulk'] },
    { key: 'b', label: 'Conflicts', match: ['session.conflict'] },
    { key: 'c', label: 'Deletions', match: ['session.delete'] },
  ]);
  main.replaceChildren(
    el('h1', {}, 'Projects'),
    el('p', { class: 'sub' }, 'Shared workspaces — folders over saved tool sessions. A team project names the groups that can see it; a private one is yours alone. Open a project to browse its sessions and run a multi-edit.'),
    ...(hdr ? [hdr] : []),
    form,
    el('div', { class: 'card stack' },
      projects.length
        ? dataTable(
            ['Project', 'Visibility', { label: 'Sessions', num: true }, 'Updated', 'State'],
            rows)
        : el('p', { class: 'empty' }, 'No projects yet. Create one above, or they will appear as teams sync sessions from the shells.')));
}

async function renderProjectDetail(main, projectId, projectName) {
  const { sessions } = await api(`/api/v1/projects/${projectId}/sessions`);
  const toolIds = [...new Set(sessions.map((s) => s.toolId))].sort();

  const sessionsCard = el('div', { class: 'card' },
    el('h2', {}, 'Sessions'),
    sessions.length
      ? dataTable(
          ['Tool', 'Label', { label: 'Rev', num: true }, 'Updated by', 'Updated'],
          sessions.map((s) => el('tr', {},
            el('td', {}, el('span', { class: 'chip' }, s.toolId)),
            el('td', {}, s.label ?? '—'),
            el('td', { class: 'num' }, s.rev),
            el('td', { class: 'mono', title: s.updatedBy }, s.updatedBy),
            el('td', {}, when(s.updatedAt)))))
      : el('p', { class: 'empty' }, 'No sessions in this project yet.'));

  main.replaceChildren(
    el('a', { class: 'back-link', href: '#/projects', onclick: (e) => { e.preventDefault(); renderProjectList(main); } }, '← Projects'),
    el('h1', {}, projectName),
    el('p', { class: 'sub' }, 'Every saved session in this project, and a multi-edit to set inputs across a whole tool at once.'),
    sessionsCard,
    toolIds.length
      ? multiEditPanel(main, projectId, projectName, toolIds)
      : el('div', { class: 'card stack' }, el('h2', {}, 'Multi-edit'), el('p', { class: 'empty' }, 'Add sessions to this project to enable multi-edit.')));
}

function multiEditPanel(main, projectId, projectName, toolIds) {
  const toolSel = el('select', { name: 'toolId' }, ...toolIds.map((t) => el('option', {}, t)));
  const pairsInput = el('textarea', { rows: 3, placeholder: 'title=Summit 2026\ndate=2026-12-25' });
  const err = errSpan();
  const result = el('div', { class: 'me-result' });

  const preview = el('button', { onclick: async () => {
    err.textContent = '';
    result.replaceChildren();
    const set = parsePairs(pairsInput.value);
    if (!Object.keys(set).length) { err.textContent = 'Enter at least one field=value.'; return; }
    try {
      const dry = await api('/api/v1/sessions/bulk', { method: 'POST', body: { filter: { projectId, toolId: toolSel.value }, set, dryRun: true } });
      result.replaceChildren(renderDiff(main, projectId, projectName, toolSel.value, set, dry));
    } catch (ex) { err.textContent = ex.message; }
  } }, 'Preview');

  return el('div', { class: 'card stack' },
    el('h2', {}, 'Multi-edit'),
    el('p', { class: 'sub' }, 'Set one or more inputs across every session of a tool in this project. Preview the exact change, then apply — each session keeps a revision.'),
    el('div', { class: 'formrow' },
      field('Tool', toolSel),
      field('Fields (one field=value per line)', pairsInput)),
    el('p', {}, preview),
    err,
    result);
}

function renderDiff(main, projectId, projectName, toolId, set, dry) {
  if (!dry.matched) return el('p', { class: 'empty' }, `No “${toolId}” sessions match.`);
  const keys = Object.keys(set);
  const rows = dry.diffs.flatMap((d) => keys.map((k) => el('tr', {},
    el('td', {}, d.label ?? el('span', { class: 'mono' }, d.sessionId)),
    el('td', {}, k),
    el('td', {}, fmtVal(d.before[k])),
    el('td', { class: 'arrow' }, '→'),
    el('td', {}, fmtVal(d.after[k])))));
  const err = errSpan();

  const count = dry.matched;
  const label = () => `Apply to ${count} session${count === 1 ? '' : 's'}`;
  const applyBtn = armConfirmButton({ class: 'primary' }, label, 'Really apply?', async (disarm) => {
    err.textContent = '';
    applyBtn.disabled = true;
    try {
      const out = await api('/api/v1/sessions/bulk', { method: 'POST', body: { filter: { projectId, toolId }, set } });
      // The apply is per-session CAS server-side: a session edited since the
      // preview is skipped, not stomped — say so, and how to pick it up.
      toast(out.skipped?.length
        ? `Applied ${out.applied}; skipped ${out.skipped.length} with concurrent edits — re-run to retry`
        : `Applied ${out.applied} session${out.applied === 1 ? '' : 's'}`);
      await renderProjectDetail(main, projectId, projectName);
    } catch (ex) { err.textContent = ex.message; applyBtn.disabled = false; disarm(); }
  });

  return el('div', {},
    dataTable(['Session', 'Field', 'Before', { label: '', w: '1.5em' }, 'After'], rows),
    el('p', {}, applyBtn), err);
}

// ── grants (plans/03) ───────────────────────────────────────────────────────
// Fine-grained RBAC under the role defaults: deny-wins, then allow, then role.
// This is how a deny turns marketing into "request approval" members, and how
// policy.edit reaches a brand team without the admin role.

const KNOWN_ACTIONS = [
  'catalog.read', 'catalog.submit', 'catalog.publish', 'catalog.expire',
  'catalog.provider.read', 'catalog.provider.manage', 'catalog.provider.credential',
  'tool.use', 'session.view', 'session.create', 'session.edit', 'session.delete', 'session.share',
  'project.create', 'project.manage', 'project.archive',
  'export.download', 'export.request', 'export.server',
  'link.create', 'link.create-guest', 'link.revoke',
  'approval.act', 'approval.assign', 'message.send',
  'telemetry.view', 'fleet.view', 'audit.export',
  'policy.edit', 'grant.edit', 'instance.config',
];

function grantRow(g) {
  const err = errSpan();
  const delBtn = armConfirmButton({ class: 'danger' }, 'Delete', 'Really delete?', async (disarm) => {
    err.textContent = '';
    delBtn.disabled = true;
    try {
      await api('/api/v1/grants', { method: 'DELETE', body: g });
      route();
    } catch (e) { err.textContent = e.message; delBtn.disabled = false; disarm(); }
  });
  return el('tr', {},
    el('td', { class: 'mono' }, g.principal),
    el('td', { class: 'mono' }, g.action),
    el('td', { class: 'mono' }, g.resource),
    el('td', {}, el('span', { class: `status ${g.effect === 'allow' ? 'live' : 'revoked'}` }, g.effect)),
    el('td', {}, delBtn, err));
}

async function viewGrants(main) {
  const { grants } = await api('/api/v1/grants');
  const sorted = [...grants].sort((a, b) =>
    a.principal.localeCompare(b.principal) || a.action.localeCompare(b.action));

  const kindSel = el('select', {},
    el('option', { value: 'group' }, 'group'),
    el('option', { value: 'user' }, 'user'),
    el('option', { value: '*' }, 'everyone (*)'));
  const nameInput = el('input', { placeholder: 'marketing' });
  kindSel.onchange = () => { nameInput.disabled = kindSel.value === '*'; };
  const actionInput = el('input', { list: 'grant-actions', placeholder: 'export.download' });
  const datalist = el('datalist', { id: 'grant-actions' }, ...KNOWN_ACTIONS.map((a) => el('option', { value: a })));
  const resourceInput = el('input', { value: '*', placeholder: "* or tool:<id> or catalog:tag/<t>" });
  const effectSel = el('select', {}, el('option', { value: 'deny' }, 'deny'), el('option', { value: 'allow' }, 'allow'));
  const err = errSpan();
  const addBtn = el('button', { class: 'primary' }, 'Add grant'); // submits the form
  // Real <form> so Enter-to-submit works and form semantics apply (matches the
  // 'Send a message'/'New project' panels).
  const addForm = el('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const principal = kindSel.value === '*' ? '*' : `${kindSel.value}:${nameInput.value.trim()}`;
    if (principal.endsWith(':')) { err.textContent = 'Name the group or user.'; return; }
    addBtn.disabled = true;
    try {
      await api('/api/v1/grants', { method: 'POST', body: {
        principal, action: actionInput.value.trim(), resource: resourceInput.value.trim() || '*', effect: effectSel.value,
      } });
      route();
    } catch (e) { err.textContent = e.message; addBtn.disabled = false; }
  } },
    el('h2', {}, 'Add grant'),
    datalist,
    el('div', { class: 'formrow' },
      field('Principal', kindSel),
      field('Name', nameInput),
      field('Action', actionInput),
      field('Resource', resourceInput),
      field('Effect', effectSel)),
    el('p', {}, addBtn),
    err);

  // grant.create / grant.delete are template-literal actions in grantMutation —
  // easy to miss when grepping the audit vocabulary, but they are audited.
  const hdr = await activityHeader('Grant edits and wider governance changes per day.', [
    { key: 'a', label: 'Grant edits', match: ['grant.'] },
    { key: 'b', label: 'Other governance', match: ['policy.', 'chain.edit', 'config.apply'] },
  ]);
  main.append(
    el('h1', {}, 'Grants'),
    el('p', { class: 'sub' }, 'Fine-grained permissions under the role defaults: a matching deny always wins, then a matching allow, then the member’s role decides. Deny export.download to a group to route them through approvals; allow policy.edit to your brand group to delegate tool governance. Owner-only actions can only be granted by an owner.'),
    ...(hdr ? [hdr] : []),
    el('div', { class: 'card' },
      el('h2', {}, 'Active grants'),
      sorted.length
        ? dataTable(['Principal', { label: 'Action', w: '180px' }, { label: 'Resource', w: '220px' }, 'Effect', { label: 'Actions', w: '1%', sort: false }], sorted.map(grantRow), { sortable: true, filter: true })
        : el('p', { class: 'empty' }, 'No grants — every member currently has exactly their role defaults.')),
    addForm,
  );
}

// ── preview-as-group (plans/03) ─────────────────────────────────────────────
// Verify governance before members hit it: enter a group set and see the exact
// org-config a member with those groups would receive — role, permission bits,
// tool visibility, locked presets / restricted choices / hidden inputs, and the
// profile policy. Server-computed through the same assembler the real poll uses,
// so the preview cannot drift from reality.

function accessDetail(access) {
  if (!access) return el('span', { class: 'muted' }, 'editable');
  if (access.level === 'locked') return el('span', {}, el('span', { class: 'status expired' }, 'locked'), ' → ', el('span', { class: 'mono' }, showValue(access.value)));
  if (access.level === 'choice') return el('span', {}, el('span', { class: 'status expired' }, 'choice'), ' → ', el('span', { class: 'mono' }, (access.allow ?? []).map(showValue).join(', ')));
  if (access.level === 'hidden') return el('span', { class: 'status revoked' }, 'hidden');
  return el('span', { class: 'muted' }, access.level);
}

function renderPreview(data) {
  const { preview, orgConfig } = data;
  const heading = preview.groups.length ? preview.groups.join(', ') : 'a member with no groups';

  const canRows = Object.entries(orgConfig.can).map(([action, ok]) => el('tr', {},
    el('td', { class: 'mono' }, action),
    el('td', {}, el('span', { class: `status ${ok ? 'live' : 'revoked'}` }, ok ? 'allowed' : 'denied'))));

  const govToolIds = Object.keys(orgConfig.tools);
  const toolBlocks = govToolIds.length
    ? govToolIds.map((id) => {
        const t = orgConfig.tools[id];
        const inputRows = [
          ...(t.inputs ?? []).map((i) => el('tr', {}, el('td', { class: 'mono' }, i.id), el('td', {}, accessDetail(i.access)))),
          ...(t.hidden ?? []).filter((h) => !(t.inputs ?? []).some((i) => i.id === h))
            .map((h) => el('tr', {}, el('td', { class: 'mono' }, h), el('td', {}, el('span', { class: 'status revoked' }, 'hidden')))),
        ];
        return el('div', { style: 'margin-top:10px' },
          el('div', {}, el('span', { class: 'mono' }, id),
            t.approvalChain ? el('span', { class: 'muted' }, ` · approval: ${t.approvalChain}`) : null),
          inputRows.length ? dataTable(['Input', 'Access'], inputRows) : el('p', { class: 'muted' }, 'visible, all inputs editable'));
      })
    : [el('p', { class: 'empty' }, 'No governed tools are visible to this group (ungoverned tools are always visible and fully editable).')];

  const profileRows = Object.entries(orgConfig.profilePolicy).map(([field, p]) => el('tr', {},
    el('td', { class: 'mono' }, field),
    el('td', {}, p.mode),
    el('td', { class: 'mono' }, p.value === undefined ? '—' : showValue(p.value))));

  return el('div', {},
    el('div', { class: 'card stack' },
      el('h2', {}, `As ${heading}`),
      el('p', {}, 'Effective role: ', el('span', { class: 'status review' }, orgConfig.session.role),
        preview.role !== 'member' ? el('span', { class: 'muted' }, `  (these groups escalate role via sign-in)`) : null),
      el('p', { class: 'sub' }, `${orgConfig.inboxUnread} unread inbox message${orgConfig.inboxUnread === 1 ? '' : 's'} would target this group.`)),
    el('div', { class: 'card stack' }, el('h2', {}, 'Permissions'), dataTable(['Action', 'Effective'], canRows)),
    el('div', { class: 'card stack' },
      el('h2', {}, 'Tools'),
      el('p', { class: 'sub' }, 'Governed tools this group can see, with each input’s effective access. Ungoverned tools are omitted — they are always visible and editable.'),
      ...toolBlocks,
      preview.hiddenTools?.length
        ? el('p', { style: 'margin-top:12px' }, el('span', { class: 'status revoked' }, 'hidden from this group'), ' ',
            el('span', { class: 'mono' }, preview.hiddenTools.join(', ')))
        : null),
    el('div', { class: 'card stack' },
      el('h2', {}, 'Profile fields'), dataTable(['Field', 'Mode', 'Locked value'], profileRows)),
  );
}

async function viewPreview(main) {
  const groupsInput = el('input', { placeholder: 'brand, marketing' });
  const resultHost = el('div', {});
  const err = errSpan();

  const run = async (groupsStr) => {
    groupsInput.value = groupsStr;
    err.textContent = '';
    resultHost.replaceChildren();
    try {
      const data = await api(`/api/v1/org-config/preview?groups=${encodeURIComponent(groupsStr)}`);
      resultHost.replaceChildren(renderPreview(data));
    } catch (e) { err.textContent = e.message; }
  };
  const previewBtn = el('button', { class: 'primary', onclick: () => run(groupsInput.value) }, 'Preview');

  // Suggestion chips: the role-escalating groups always, plus any group named
  // in a tool overlay (same policy.edit gate as this view, so always available).
  let suggestions = ['owner', 'admin', 'approver', 'author'];
  try {
    const { tools } = await api('/api/v1/policy/tools');
    const seen = new Set();
    for (const t of tools) {
      for (const g of t.overlay?.visibility?.groups ?? []) if (g !== '*') seen.add(g);
      for (const rules of Object.values(t.overlay?.inputAccess ?? {})) {
        for (const r of rules) for (const g of r.groups) if (g !== '*') seen.add(g);
      }
    }
    suggestions = [...new Set([...suggestions, ...[...seen].sort()])];
  } catch { /* best-effort — the free-text field always works */ }

  main.append(
    el('h1', {}, 'Preview'),
    el('p', { class: 'sub' }, 'See exactly what a member in a given set of groups would receive — role, permissions, tool and input governance, profile policy. Computed through the same assembler the live client polls, so what you see here is what they get. Nothing is signed in or stored.'),
    el('div', { class: 'card' },
      el('div', { class: 'formrow' }, field('Groups (comma-separated)', groupsInput)),
      el('p', {}, previewBtn),
      suggestions.length
        ? el('p', { class: 'chips' }, el('span', { class: 'muted' }, 'Quick pick: '),
            ...suggestions.map((g) => el('button', { class: 'chip', onclick: () => run(g) }, g)))
        : null,
      err),
    resultHost,
  );
}

// ── docs ────────────────────────────────────────────────────────────────────
// The deployment's own documentation (docs/, served by GET /api/v1/docs), read
// in the console so whoever operates a deploy never needs the repository. The
// renderer below is a deliberately small markdown subset — the one the docs
// actually use — built as DOM nodes, never innerHTML: the console's air-gap rule
// forbids a markdown library, and node-building forbids injection by construction.

// Fetch a text (non-JSON) endpoint with the same error shape api() raises.
async function apiText(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw Object.assign(new Error(data?.error?.message ?? res.statusText), { status: res.status, code: data?.error?.code });
  }
  return res.text();
}

// Cross-doc link resolution. A manifest entry may live in a subdirectory of
// docs/ (the per-provider guides are in docs/providers/), so a link is resolved
// as a FILE PATH against the directory of the page being rendered, then looked
// up in the manifest. That is the same answer a file browser gives, so one link
// text ('../catalog.md', 'canto.md') works both here and in the repo.
let docPathToSlug = new Map();
let docCurrentDir = '';

function resolveDocPath(dir, href) {
  const out = [];
  for (const p of (dir ? dir.split('/') : []).concat(href.split('/'))) {
    if (!p || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

// A markdown link → a DOM node. Cross-doc links ('catalog.md', 'audit.md#anchor')
// become console routes; http(s) opens in a new tab; anything else, including a
// .md this deployment does not publish, stays text rather than becoming a dead
// link.
function mdLink(label, href) {
  const kids = mdInline(label);
  if (/^https?:\/\//i.test(href)) return el('a', { href, target: '_blank', rel: 'noopener' }, ...kids);
  const rel = /^([^#\s]+\.md)(#.*)?$/.exec(href);
  const slug = rel ? docPathToSlug.get(resolveDocPath(docCurrentDir, rel[1])) : undefined;
  if (slug) return el('a', { href: `#/docs?doc=${slug}` }, ...kids);
  return el('span', {}, ...kids);
}

// Inline spans: `code`, **strong**, [label](href), *em*. First match wins, so a
// code span containing asterisks stays literal.
function mdInline(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(el('code', {}, m[1]));
    else if (m[2] !== undefined) out.push(el('strong', {}, m[2]));
    else if (m[3] !== undefined) out.push(mdLink(m[3], m[4]));
    else out.push(el('em', {}, m[5]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const mdRow = (cells, tag) => el('tr', {}, ...cells.map((c) => el(tag, tag === 'th' ? { scope: 'col' } : {}, ...mdInline(c))));
const mdCells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

// A documentation screenshot → a figure carrying its own Content Credential.
// Each shot under docs/shots/ is an engine-rendered VECTOR SVG signed with a real
// C2PA credential (scripts/capture-console.ts). The credential line STATES what
// the file's own manifest says — decoded server-side (GET …/cred), since this
// air-gap console cannot decode C2PA itself — and never marks its own homework:
// "Check it yourself" opens #/verify, which fetches these exact bytes and
// verifies them on the reader's machine. A shot whose credential will not decode
// gets the image and no line, rather than a line that implies more than the file
// can back. Built with el() (no innerHTML) like everything else here.
const IMPRINT_GLYPH = () => el('svg:svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', width: 13, height: 13 },
  el('path:svg', { d: 'M12 3l7 4v5c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
  el('path:svg', { d: 'M9 12l2 2 4-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

// Normalise a markdown shot src ('shots/x.svg', '/info/shots/x.svg', a bare
// 'x.svg') to this deployment's served, member-gated shot path.
function shotUrlFor(src) {
  const file = src.replace(/^.*\/(?:info\/)?shots\//, '').replace(/^shots\//, '');
  return { file, url: `/api/v1/docs/shots/${encodeURIComponent(file)}` };
}

let shotCredSeq = 0;
function shotFigure(alt, src) {
  const light = shotUrlFor(src);
  const darkFile = light.file.replace(/\.svg$/i, '.dark.svg');
  const darkUrl = `/api/v1/docs/shots/${encodeURIComponent(darkFile)}`;
  // Both theme variants ship; CSS shows the one matching the reader's theme (a
  // dark shot in dark/brand, a light shot in light) — mirroring the brand-logo
  // dual-image pattern. If a dark twin isn't present the dark img falls back to
  // the light file, so dark mode is never a broken image.
  const imgL = el('img', { class: 'shot-img shot-img--light', src: light.url, alt, loading: 'lazy', decoding: 'async' });
  const imgD = el('img', { class: 'shot-img shot-img--dark', src: darkUrl, alt, loading: 'lazy', decoding: 'async' });
  imgD.addEventListener('error', () => { if (!imgD.dataset.fellBack) { imgD.dataset.fellBack = '1'; imgD.src = light.url; } });
  const fig = el('figure', { class: 'shot shot--dual' }, imgL, imgD);
  // Each variant is separately signed and carries its OWN credential line, gated
  // to its theme. Best-effort: no readable credential ⇒ just the image.
  addShotCred(fig, light.file, light.url, 'shot-cred--light');
  addShotCred(fig, darkFile, darkUrl, 'shot-cred--dark');
  return fig;
}
function addShotCred(fig, file, url, themeClass) {
  fetch(`${url}/cred`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => { if (c) fig.append(shotCredLine(c, file, url, themeClass)); })
    .catch(() => {});
}

// The credential line itself: an almost-invisible imprint that expands on hover,
// focus or tap into what the file's manifest states + two actions on the file.
function shotCredLine(c, file, url, themeClass = '') {
  const id = `shot-cred-${++shotCredSeq}`;
  const pill = (cls, ...kids) => el('span', { class: `prov-pill ${cls}` }, ...kids);
  const row1 = el('span', { class: 'shot-cred-row' });
  if (c.signer) row1.append(pill('prov-sig', IMPRINT_GLYPH(), 'signed by ', el('span', { class: 'prov-pill prov-entity' }, c.signer)));
  if (c.kind) row1.append(pill('prov-detail', c.kind));
  if (c.day) row1.append(el('time', { class: 'prov-pill prov-detail', datetime: c.day }, c.day));
  if (c.ai) row1.append(pill('prov-entity', c.ai === 'generated' ? 'AI generated' : 'AI edited'));
  row1.append(el('a', { class: 'shot-cred-do', href: `#/verify?src=${encodeURIComponent(url)}` }, 'Check it yourself'));
  row1.append(el('a', { class: 'shot-cred-do', href: url, download: file }, 'Get the signed file'));

  const a = c.anatomy;
  const facts = a && a.kind === 'vector'
    ? [`${fmt(a.paths)} ${a.paths === 1 ? 'path' : 'paths'}`, `${fmt(a.groups)} ${a.groups === 1 ? 'group' : 'groups'}`,
       `${fmt(a.elements)} elements`, `${Math.round(a.bytes / 1024)} KB`, c.dimensions].filter(Boolean)
    : a ? ['pixels, not shapes', `${Math.round(a.bytes / 1024)} KB`, c.dimensions].filter(Boolean) : [];
  const row2 = facts.length
    ? el('span', { class: 'shot-cred-row shot-cred-anat' }, ...facts.map((f) => el('span', { class: 'prov-pill prov-detail' }, f)))
    : null;

  const label = ['Content Credentials', c.signer ? `signed by ${c.signer}` : '', c.kind, c.dimensions, c.day, c.generator,
    c.ai ? (c.ai === 'generated' ? 'AI generated' : 'AI edited') : ''].filter(Boolean).join(' — ');
  const line = el('span', { class: 'shot-cred-line', id }, row1, row2);
  const wrap = el('span', { class: `shot-cred${c.ai ? ' shot-cred--ai' : ''}${themeClass ? ` ${themeClass}` : ''}` },
    el('button', {
      type: 'button', class: 'shot-cred-btn', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label,
      onclick: (e) => { const w = e.currentTarget.closest('.shot-cred'); const open = w.toggleAttribute('data-open'); e.currentTarget.setAttribute('aria-expanded', String(open)); e.stopPropagation(); },
    }, IMPRINT_GLYPH()),
    line);
  return wrap;
}

// Markdown → block nodes. Supported (all the docs use): ATX headings, fenced
// code, pipe tables, bullet/ordered lists with indented continuations, block
// quotes, horizontal rules, paragraphs. `skipTitle` drops the doc's own `# `
// heading, because the view already renders the manifest title as its <h1>.
function mdToNodes(text, { skipTitle = true } = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes = [];
  let para = [];
  let titleSeen = false;
  const flushPara = () => {
    if (para.length) nodes.push(el('p', {}, ...mdInline(para.join(' '))));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      nodes.push(el('pre', {}, el('code', {}, body.join('\n'))));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      if (h[1].length === 1) {
        if (skipTitle && !titleSeen) { titleSeen = true; continue; }
        nodes.push(el('h2', {}, ...mdInline(h[2])));
      } else {
        nodes.push(el(`h${Math.min(h[1].length + 1, 4)}`, {}, ...mdInline(h[2])));
      }
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushPara();
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const head = mdCells(rows[0]);
      const body = rows.slice(1).filter((r) => !/^\s*\|[\s|:-]+\|?\s*$/.test(r)).map(mdCells);
      nodes.push(el('div', { class: 'doc-tbl' }, el('table', {},
        el('thead', {}, mdRow(head, 'th')),
        el('tbody', {}, ...body.map((r) => mdRow(r, 'td'))))));
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = !/^[-*]$/.test(li[1]);
      const items = [];
      for (; i < lines.length; i++) {
        const m2 = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m2) { items.push(m2[2]); continue; }
        // An indented, non-empty line continues the previous item.
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += ` ${lines[i].trim()}`; continue; }
        break;
      }
      i--;
      nodes.push(el(ordered ? 'ol' : 'ul', {}, ...items.map((t) => el('li', {}, ...mdInline(t)))));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = [];
      for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      nodes.push(el('blockquote', {}, el('p', {}, ...mdInline(quote.join(' ')))));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); nodes.push(el('hr', {})); continue; }
    // Plain illustrative images (docs/img/ — vendored third-party marks like
    // the Rancher / k3s / Helm logos): a row of small logos, NO credential
    // line — they are not screen captures and sit deliberately outside the
    // signed-shots contract. One or more image refs alone on a line form one
    // row, so `![Rancher](img/…) ![k3s](img/…)` reads as a logo strip.
    if (/^\s*(?:!\[[^\]]*\]\(img\/[^)\s]+\)\s*)+$/.test(line)) {
      flushPara();
      const row = el('div', { class: 'doc-logos' });
      for (const m of line.matchAll(/!\[([^\]]*)\]\(img\/([^)\s]+)\)/g)) {
        row.append(el('img', { src: `/api/v1/docs/img/${encodeURIComponent(m[2])}`, alt: m[1], title: m[1], loading: 'lazy' }));
      }
      nodes.push(row);
      continue;
    }
    // A screenshot on its own line → a figure with a credential line. Block, not
    // inline (mdInline has no image case): the credential needs a positioned
    // parent, which only a block figure gives.
    const shot = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (shot) { flushPara(); nodes.push(shotFigure(shot[1], shot[2])); continue; }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line.trim());
  }
  flushPara();
  return nodes;
}

async function viewDocs(main, params) {
  const index = await api('/api/v1/docs');
  const sections = index.sections ?? [];
  const flat = sections.flatMap((s) => s.docs ?? []);
  if (!flat.length) {
    main.replaceChildren(el('h1', {}, 'Docs'), el('p', { class: 'empty' }, 'This deployment ships no documentation.'));
    return;
  }
  const want = params?.get?.('doc');
  const current = flat.find((d) => d.slug === want) ?? flat[0];
  // Rebuilt per view so a manifest change lands without a reload.
  docPathToSlug = new Map(flat.map((d) => [d.path ?? `${d.slug}.md`, d.slug]));
  docCurrentDir = (current.path ?? '').includes('/') ? current.path.replace(/\/[^/]*$/, '') : '';

  // Left rail: the manifest's own grouping, plus the open-source docs when a
  // Lolly deployment is reachable from here (served shell or instance.appUrl).
  const nav = el('nav', { class: 'docs-nav', 'aria-label': 'Documentation' },
    ...sections.map((s) => el('div', { class: 'docs-group' },
      // Per-topic icon (docs.json `icon`, an id from NAV_ICONS) — the same
      // stroke set the main rail uses, so the docs nav speaks the console's
      // own iconography rather than growing a second dialect.
      el('div', { class: 'docs-group-h' }, ...(s.icon && NAV_ICONS[s.icon] ? [navIcon(s.icon)] : []), s.title ?? ''),
      ...(s.docs ?? []).map((d) => el('a', {
        href: `#/docs?doc=${d.slug}`,
        class: d.slug === current.slug ? 'docs-link is-current' : 'docs-link',
        'aria-current': d.slug === current.slug ? 'page' : null,
      }, d.title ?? d.slug)))),
    index.oss
      ? el('div', { class: 'docs-group' },
          el('div', { class: 'docs-group-h' }, 'Open source'),
          el('a', { class: 'docs-link docs-link--out', href: index.oss.url, target: '_blank', rel: 'noopener' },
            `${index.oss.label} →`),
          index.oss.note ? el('p', { class: 'docs-note' }, index.oss.note) : null)
      : null,
  );

  const prose = el('article', { class: 'doc-prose' }, el('p', { class: 'muted flush' }, 'Loading…'));
  main.replaceChildren(
    el('h1', {}, current.title ?? current.slug),
    current.summary ? el('p', { class: 'sub' }, current.summary) : null,
    el('div', { class: 'docs-layout' }, nav, el('div', { class: 'card' }, prose)),
  );
  try {
    prose.replaceChildren(...mdToNodes(await apiText(`/api/v1/docs/${current.slug}`)));
  } catch (e) {
    prose.replaceChildren(el('p', { class: 'empty' }, `Couldn’t load this page: ${e.message}`));
  }
  // A tapped-open credential line closes on Escape or an outside click — the pointer
  // reveal (hover/focus) needs no JS, but a tap toggle does. Scoped to this view.
  const closeCreds = (ev) => {
    for (const w of main.querySelectorAll('.shot-cred[data-open]')) {
      if (ev.type === 'keydown' || !w.contains(ev.target)) {
        w.removeAttribute('data-open');
        w.querySelector('.shot-cred-btn')?.setAttribute('aria-expanded', 'false');
      }
    }
  };
  document.addEventListener('click', closeCreds);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCreds(ev); });
}

// ── shell & routing ─────────────────────────────────────────────────────────
// Inline lucide-style nav glyphs (24×24, stroke=currentColor) — no external
// assets, per the air-gap rule; each is the `d`/shapes of one lucide icon.
const NAV_ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  instance: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  design: '<rect x="3" y="3" width="8" height="8" rx="1.2"/><rect x="13" y="3" width="8" height="8" rx="1.2"/><rect x="3" y="13" width="8" height="8" rx="1.2"/><circle cx="17" cy="17" r="4"/>',
  fleet: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  rooms: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>',
  links: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  catalog: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  providers: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  tools: '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  projects: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  approvals: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76z"/><path d="m9 12 2 2 4-4"/>',
  messages: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  audit: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  contractors: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  grants: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  preview: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  flags: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  injectables: '<path d="M12 2v20"/><path d="M2 12h20"/><path d="M12 2l3 3-3 3-3-3z"/><circle cx="12" cy="12" r="2.5"/>',
  docs: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8"/><path d="M8 11h6"/>',
};
function navIcon(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'nav-ico');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.75');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = NAV_ICONS[id] ?? '';
  return s;
}

// ── verify (client-side C2PA) ─────────────────────────────────────────────────
// The reader checks a credential HERE, in their own browser, against the exact
// bytes — the deployment never marks its own homework. The verifier is the
// vendored engine's pure-TS C2PA stack, bundled to /admin/verify.js (no WASM, no
// network, no external assets) and loaded on demand so the console's main path
// stays no-build. Reached from a shot's "Check it yourself" (#/verify?src=…) or
// by dropping any signed file.
let verifyLibP = null;
function loadVerifyLib() {
  if (globalThis.__lollyVerify) return Promise.resolve(globalThis.__lollyVerify);
  if (!verifyLibP) {
    verifyLibP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/admin/verify.js';
      s.onload = () => res(globalThis.__lollyVerify);
      s.onerror = () => rej(new Error('could not load the verifier'));
      document.head.appendChild(s);
    });
  }
  return verifyLibP;
}

const CHECK_COPY = {
  'claimSignature.validated': 'Signature verified against the signing key',
  'claimSignature.insideValidity': 'Signed within the certificate’s validity window',
  'assertion.dataHash.match': 'File bytes match the credential — not tampered since signing',
  'assertion.hashedURI.match': 'Every assertion matches its recorded hash',
  'signingCredential.untrusted': 'Signer is self-signed — not in your trust list',
  'signingCredential.trusted': 'Signer chains to a trusted root',
  'signingCredential.expired': 'Signing certificate has expired',
};
const humanCheck = (code) => CHECK_COPY[code] ?? code.replace(/\./g, ' · ');

function verifyCard(report, verdict, name) {
  const tone = verdict?.tone ?? (report.state === 'valid' ? 'good' : report.state === 'invalid' ? 'bad' : 'warn');
  const hero = report.state === 'none' ? 'No Content Credential found'
    : report.state === 'invalid' ? 'Invalid — the file changed after it was signed'
    : report.trusted ? 'Valid and trusted' : 'Valid — integrity intact';
  const signer = report.signer?.organization || report.signer?.commonName;
  const whenIso = report.environment?.date || report.history?.[0]?.when;
  const gi = report.claim?.generatorInfo;
  const gen = gi?.name ? `${gi.name} ${gi.version ?? ''}`.trim() : report.claim?.claimGenerator;
  const rows = [];
  if (signer) rows.push(['Signed by', signer + (report.trusted ? '' : ' — self-signed, not in your trust list')]);
  if (whenIso) rows.push(['Signed', when(whenIso)]);
  if (gen) rows.push(['Made with', gen]);
  if (report.environment?.tool) rows.push(['Captured', `${report.environment.tool}${report.environment.surface ? ` · ${report.environment.surface}` : ''}`]);
  if (report.environment?.dimensions) rows.push(['Dimensions', report.environment.dimensions]);
  // Collapse repeats (e.g. one hashedURI check per assertion) to one line each,
  // keeping the worst outcome so a single failure is never hidden by a passing twin.
  const seen = new Map();
  for (const c of report.checks ?? []) {
    const prev = seen.get(c.code);
    if (!prev || (prev.ok && !c.ok)) seen.set(c.code, c);
  }
  const checks = [...seen.values()].map((c) =>
    el('li', { class: `vchk ${c.ok ? 'ok' : (String(c.code).includes('untrusted') ? 'note' : 'bad')}` },
      el('span', { class: 'vchk-dot', 'aria-hidden': 'true' }), humanCheck(c.code)));
  return el('div', { class: 'card verify-card' },
    el('div', { class: `verify-hero tone-${tone}` }, IMPRINT_GLYPH(), el('strong', {}, hero), name ? el('span', { class: 'muted' }, name) : null),
    rows.length ? el('dl', { class: 'verify-facts' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : null,
    checks.length ? el('div', {}, el('h3', {}, 'What was checked'), el('ul', { class: 'verify-checks' }, ...checks)) : null,
    el('p', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
      'Verified on your device by the vendored engine — no bytes left this browser.'));
}

async function viewVerify(main, params) {
  main.replaceChildren(
    el('h1', {}, 'Verify a Content Credential'),
    el('p', { class: 'sub' }, 'Checked in your browser against the exact bytes — this deployment does not mark its own homework. Drop any signed file, or arrive here from a shot’s “Check it yourself”.'));
  const host = el('div', {});
  const input = el('input', { type: 'file', accept: '.svg,.png,.jpg,.jpeg,.pdf', style: 'display:none',
    onchange: (e) => { const f = e.target.files?.[0]; if (f) verifyFile(f); } });
  const drop = el('label', { class: 'verify-drop', tabindex: '0' }, IMPRINT_GLYPH(),
    el('span', {}, 'Drop a signed file here, or click to choose'), input);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drag'); const f = e.dataTransfer?.files?.[0]; if (f) verifyFile(f); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  main.append(drop, host);

  async function verifyFile(file) { await verifyBytes(new Uint8Array(await file.arrayBuffer()), file.name); }
  async function verifyBytes(bytes, name) {
    host.replaceChildren(el('p', { class: 'muted flush' }, 'Verifying on your device…'));
    try {
      const lib = await loadVerifyLib();
      const report = await lib.verifyC2pa(bytes, { trustAnchors: lib.c2paTrustAnchors() });
      const verdict = lib.resolveVerdict ? lib.resolveVerdict(report) : null;
      host.replaceChildren(verifyCard(report, verdict, name));
    } catch (e) {
      host.replaceChildren(el('p', { class: 'empty' }, `Couldn’t verify: ${e.message}`));
    }
  }
  const src = params?.get?.('src');
  if (src) {
    try {
      const r = await fetch(src, { credentials: 'same-origin' });
      if (r.ok) await verifyBytes(new Uint8Array(await r.arrayBuffer()), src.split('/').pop());
      else host.replaceChildren(el('p', { class: 'empty' }, 'That file could not be fetched to verify.'));
    } catch { /* leave the dropzone */ }
  }
}

const VIEWS = {
  overview: { title: 'Overview', render: viewOverview },
  activity: { title: 'Activity', render: viewActivity },
  instance: { title: 'This Deploy', render: viewInstance },
  fleet: { title: 'Fleet', render: viewFleet },
  rooms: { title: 'Rooms', render: viewRooms },
  links: { title: 'Links', render: viewLinks },
  // Consolidated into the This Deploy tab bar — kept routable (deep links,
  // e.g. the activity feed's #/catalog) but hidden from the sidebar.
  tools: { title: 'Tools', render: viewTools, hidden: true },
  catalog: { title: 'Catalog', render: viewCatalog, hidden: true },
  providers: { title: 'Providers', render: viewProviders, hidden: true },
  injectables: { title: 'Injectables', render: viewInjectables, hidden: true },
  approvals: { title: 'Approvals', render: viewApprovals },
  messages: { title: 'Messages', render: viewMessages },
  audit: { title: 'Audit', render: viewAudit },
  projects: { title: 'Projects', render: viewProjects },
  users: { title: 'People', render: viewUsers },
  contractors: { title: 'Contractors', render: viewContractors },
  grants: { title: 'Grants', render: viewGrants },
  preview: { title: 'Preview', render: viewPreview },
  docs: { title: 'Docs', render: viewDocs },
  verify: { title: 'Verify', render: viewVerify, hidden: true },
};

let session = null;
let instanceName = 'Lolly Work';
// GET /api/auth/config, cached at boot (provider, providerName, publicDocs).
let authConfig = null;
// Anonymous public-docs mode: entered at boot on the public sandbox (dev.enabled,
// advertised as authConfig.publicDocs) when a visitor with no session lands on a
// public route. The admin rail needs a session, so publicShell() gives a light
// docs-site chrome instead; every non-public route still drops to the sign-in gate.
let publicMode = false;
// The only views reachable without a session: the deployment docs and the
// client-side C2PA verifier the docs link into ("Check it yourself").
const PUBLIC_VIEWS = new Set(['docs', 'verify']);

// Where the Lolly app lives. Same-origin ('') when the instance serves the
// shell at / (instance.shellDir); an absolute origin when instance.appUrl is
// set (dev Vite server, split deploy). Read off /healthz at boot.
let lollyAppUrl = '';
function lollyHref(path) { return `${lollyAppUrl}${path}`; }

// The real, theme-paired brand wordmark for the rail/gate, or null when the pack
// ships none (blank packs keep the generic CSS mark). Both variants render and
// CSS shows the on-theme one, so a theme flip needs no re-render. The hidden
// variant is aria-hidden with empty alt so a reader announces the mark once.
function brandLogoEl(cls) {
  if (!brandLogos.light && !brandLogos.dark) return null;
  const named = brandLogos.light ? 'light' : 'dark';
  return el('span', { class: `brand-logo ${cls}` },
    brandLogos.light
      ? el('img', { class: 'brand-logo__img brand-logo__light', src: brandLogos.light, alt: named === 'light' ? instanceName : '', 'aria-hidden': named === 'light' ? null : 'true', decoding: 'async' })
      : null,
    brandLogos.dark
      ? el('img', { class: 'brand-logo__img brand-logo__dark', src: brandLogos.dark, alt: named === 'dark' ? instanceName : '', 'aria-hidden': named === 'dark' ? null : 'true', decoding: 'async' })
      : null,
  );
}

function shell(current, content) {
  const logo = brandLogoEl('brand-logo--rail');
  $app.replaceChildren(
    el('aside', { class: 'rail' },
      logo
        ? el('div', { class: 'brand brand--logo' }, logo, el('small', { class: 'brand-sub' }, instanceName))
        : el('div', { class: 'brand' }, el('span', { class: 'brand-name' }, instanceName), el('small', {}, 'control plane console')),
      el('a', { class: 'back', href: lollyHref('/') }, 'Open Lolly →'),
      railToggleBtn(),
      el('nav', { id: 'rail-nav', 'aria-label': 'Console sections' },
        ...Object.entries(VIEWS).filter(([, v]) => !v.hidden).map(([id, v]) =>
          el('a', { href: `#/${id}`, 'aria-current': id === current ? 'page' : null, title: v.title }, navIcon(id), el('span', {}, v.title)))),
      el('div', { class: 'session' },
        el('div', { class: 'who', title: session?.user?.email ?? '' }, session?.user?.email ?? ''),
        el('div', {}, session?.user?.role ?? ''),
        el('p', {}, el('button', { onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); } }, 'Sign out'))),
    ),
    content,
  );
  applyRailState(); // keep the toggle's aria + html attribute correct after each re-render
}

// Minimal chrome for the anonymous public docs on the sandbox (publicMode): the
// admin rail needs a session, so instead a light top bar — the Lolly mark (its
// C2PA-sealed icon.svg, the same one lolly.tools serves), a Docs link, source, a
// sign-in button and the theme toggle — while the Docs view fills the page from
// its own left-hand nav. Mirrors the public docs pattern on lolly.tools.
function publicShell(current, content) {
  $app.classList.add('public');
  const icon = (paths) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ class: 'nav-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    s.innerHTML = paths;
    return s;
  };
  const themeBtn = el('button', { id: 'theme-toggle', class: 'pub-icon-btn', type: 'button', onclick: cycleTheme }, icon(''));
  syncThemeButton(themeBtn);
  $app.replaceChildren(
    el('header', { class: 'pub-head' },
      el('div', { class: 'pub-head__in' },
        el('a', { class: 'pub-brand', href: '#/docs', 'aria-label': `${instanceName} documentation` },
          el('img', { class: 'pub-logo', src: '/admin/icon.svg', alt: '', width: '26', height: '26', decoding: 'async' }),
          el('span', { class: 'pub-name' }, instanceName),
          el('span', { class: 'pub-kicker' }, 'Docs')),
        el('nav', { class: 'pub-nav', 'aria-label': 'Documentation' },
          el('a', { class: current === 'docs' ? 'pub-link is-current' : 'pub-link', href: '#/docs' }, 'Docs'),
          el('a', { class: 'pub-link', href: 'https://github.com/lolly-tools/lolly-work', target: '_blank', rel: 'noopener' }, 'GitHub ↗'),
          el('button', { class: 'primary pub-signin', type: 'button', onclick: signInGate }, 'Sign in'),
          el('a', { class: 'pub-icon-btn', href: lollyHref('/'), 'aria-label': 'Home', title: 'Home' }, icon('<path d="M3 10.6 12 3l9 7.6"/><path d="M5.5 9.5V21h13V9.5"/>')),
          themeBtn))),
    content,
  );
}

function gate(inner) {
  $app.replaceChildren(
    el('div', { class: 'gate' },
      el('div', { class: 'gate-card' },
        (() => {
          const logo = brandLogoEl('brand-logo--gate');
          return el('div', { class: logo ? 'gate-head gate-head--logo' : 'gate-head' },
            logo ?? el('div', { class: 'gate-mark', 'aria-hidden': 'true' }),
            el('div', {},
              el('div', { class: 'gate-name' }, instanceName),
              el('div', { class: 'gate-kicker' }, 'Control plane console')));
        })(),
        ...inner)));
}

// The current route id (the '#/<view>' segment, minus any '?query'), parsed the
// same way route() does — used by boot() to decide whether a session-less visitor
// landed on a public route.
function currentRouteId() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  return (qi >= 0 ? raw.slice(0, qi) : raw) || 'overview';
}

// The sign-in gate — shown when there is no session and the route isn't public,
// and reachable from the public docs header's "Sign in". Uses the cached auth
// config (re-fetched if boot never got it). A .gate centres itself with flexbox,
// so it renders correctly whether #app is the admin grid or the public block flow.
async function signInGate() {
  const cfg = authConfig ?? await api('/api/auth/config').catch(() => null);
  const returnTo = encodeURIComponent('/admin');
  gate([
    el('p', { class: 'gate-lede' }, 'Sign in to manage your organisation’s tools, approvals, and catalog.'),
    cfg?.provider === 'oidc'
      ? el('a', { class: 'btn gate-go', href: `/api/auth/login?returnTo=${returnTo}` }, `Sign in with ${cfg?.providerName || 'SSO'}`)
      : cfg?.provider === 'dev'
        ? el('form', { class: 'gate-form', onsubmit: (e) => { e.preventDefault(); location.href = `/api/auth/dev?email=${encodeURIComponent(new FormData(e.target).get('email'))}&returnTo=${returnTo}`; } },
            el('label', { for: 'gate-email' }, 'Work email'),
            el('input', { id: 'gate-email', name: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', autofocus: 'true' }),
            el('button', { class: 'primary gate-go' }, 'Continue'),
            el('p', { class: 'gate-hint' }, 'Development sign-in — no password required.'))
        : el('p', { class: 'empty' }, 'No identity provider is configured on this deployment.'),
  ]);
}

async function route() {
  // Hash is '#/<view>' with an optional '?query' (deep links: #/users?focus=<id>,
  // #/overview?day=<date>). Split the two; params reach the view as a 2nd arg.
  const raw = location.hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const id = (qi >= 0 ? raw.slice(0, qi) : raw) || 'overview';
  const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  // Public (anonymous) mode: only the public views are reachable; any other route
  // drops to the sign-in gate — that's how a visitor crosses from docs into admin.
  if (publicMode && !PUBLIC_VIEWS.has(id)) { await signInGate(); return; }
  const view = VIEWS[id] ?? VIEWS.overview;
  // id + tabindex make <main> the skip-link target and focus anchor.
  const main = el('main', { id: 'main', tabindex: '-1' });
  (publicMode ? publicShell : shell)(id, main);
  // Loading state: shown synchronously, swapped when the view resolves (or is
  // replaced by the view's own empty/error state / the catch below).
  const loading = loadingCard(view.title);
  main.append(loading);
  try {
    await view.render(main, params);
  } catch (err) {
    loading.remove();
    if (err.status === 403) {
      main.append(el('h1', {}, view.title), el('p', { class: 'sub' }, 'Your role doesn’t include this section.'));
    } else {
      main.append(
        el('h1', {}, view.title),
        el('p', { class: 'sub' }, 'Something went wrong loading this view.'),
        el('p', {}, el('button', { class: 'primary', onclick: route }, 'Try again')),
        el('p', { class: 'muted mono', style: 'margin-top:8px;font-size:12px' }, err.message || ''));
    }
  }
  loading.remove();
  // Focus the view heading and announce it, so keyboard/SR users re-orient after
  // a navigation (or a mutation-triggered re-render) instead of losing focus.
  const h1 = main.querySelector('h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus(); }
  announce(`${view.title} loaded`);
}

// The tab favicon is the fixed Lolly mark — the green-and-white swirl, matching
// the open-source /info docs — declared in index.html. It is a PRODUCT icon, not
// brand chrome, so (unlike the brand logo/wordmark) it is deliberately NOT
// re-tinted per deployment or per theme: the console tab reads as Lolly wherever
// it runs. This just self-heals the icon link so a browser that cached an older
// data-URI favicon still lands on the served swirl; a no-op on a normal load.
function updateFavicon() {
  try {
    const href = '/admin/icons/icon-192.png';
    let link = document.querySelector('link[rel="icon"][type="image/png"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/png'; document.head.appendChild(link); }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  } catch { /* keep the static favicon */ }
}

// ── theme: light / dark / brand (mirrors the web shell). A single top-right
//    button cycles them; the choice persists. With no stored choice the console
//    follows the OS for light/dark (a pre-boot script in index.html applies any
//    stored pin before first paint); 'brand' is the pack-tinted chrome. ────────
const THEMES = ['light', 'dark', 'brand'];
const THEME_META = {
  light: { label: 'Light', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>' },
  dark: { label: 'Dark', icon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>' },
  brand: { label: 'Brand', icon: '<path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z"/>' },
};
const THEME_KEY = 'lw-theme';

// Collapsible sidebar — persisted, applied as a [data-rail] attribute on <html>
// so CSS (not a re-render) shrinks the rail to icons at any width. A pre-boot
// inline script in index.html sets the attribute before first paint (no flash).
const RAIL_KEY = 'lw-rail-collapsed';
function railCollapsed() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}
function applyRailState() {
  const c = railCollapsed();
  document.documentElement.setAttribute('data-rail', c ? 'collapsed' : '');
  const b = document.getElementById('rail-toggle');
  if (b) {
    b.setAttribute('aria-expanded', String(!c));
    b.setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
    b.setAttribute('title', c ? 'Expand sidebar' : 'Collapse sidebar');
  }
}
function toggleRail() {
  const next = !railCollapsed();
  try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  applyRailState();
  announce(next ? 'Sidebar collapsed' : 'Sidebar expanded');
}
function railToggleBtn() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M15 18l-6-6 6-6"/>';
  return el('button', { id: 'rail-toggle', class: 'rail-toggle', type: 'button', 'aria-controls': 'rail-nav', onclick: toggleRail }, s);
}

function storedTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return THEMES.includes(t) ? t : null; } catch { return null; }
}
/** The theme actually painting now: an explicit pin, else the OS light/dark. */
function activeTheme() {
  const pin = document.documentElement.getAttribute('data-theme');
  if (THEMES.includes(pin)) return pin;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
/** Re-tint the favicon + the (non-media) theme-color meta from the live plane. */
function applyThemeChrome() {
  updateFavicon();
  try {
    const plane = getComputedStyle(document.documentElement).getPropertyValue('--plane').trim();
    let m = document.querySelector('meta[name="theme-color"]:not([media])');
    if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'theme-color'); document.head.appendChild(m); }
    if (plane) m.setAttribute('content', plane);
  } catch { /* meta is a nicety — never block on it */ }
}
function syncThemeButton(btn) {
  const cur = activeTheme();
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  btn.querySelector('svg').innerHTML = THEME_META[cur].icon;
  btn.setAttribute('aria-label', `Theme: ${THEME_META[cur].label}. Switch to ${THEME_META[next].label}.`);
  btn.setAttribute('title', `Theme: ${THEME_META[cur].label} — click for ${THEME_META[next].label}`);
}
function setTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  try { localStorage.setItem(THEME_KEY, name); } catch { /* private mode — session-only */ }
  const btn = document.getElementById('theme-toggle');
  if (btn) syncThemeButton(btn);
  applyThemeChrome();
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(activeTheme()) + 1) % THEMES.length];
  setTheme(next);
  announce(`${THEME_META[next].label} theme`);
}
function mountThemeToggle() {
  if (document.getElementById('theme-toggle')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ class: 'nav-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const btn = el('button', { id: 'theme-toggle', class: 'theme-toggle', type: 'button', onclick: cycleTheme }, svg);
  document.body.appendChild(btn);
  syncThemeButton(btn);
  applyThemeChrome();
  // Keep the icon honest if the OS flips while the console is unpinned.
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!storedTheme()) syncThemeButton(btn); }); } catch { /* older browsers */ }
}

async function boot() {
  try {
    const health = await api('/healthz');
    instanceName = health.name;
    if (typeof health.appUrl === 'string' && /^https?:\/\//.test(health.appUrl)) {
      lollyAppUrl = health.appUrl.replace(/\/+$/, '');
    }
    document.title = `${health.name} · Console`;
  } catch { /* keep default */ }
  // Brand the sign-in gate from the unauthenticated /api/brand endpoint, so the
  // login screen inherits the instance's colours + fonts even on a gated
  // instance (where the catalog itself is auth-only).
  await applyBrandChrome().catch(() => {});
  updateFavicon();
  mountThemeToggle();
  applyRailState();
  // The instance's IdP display name (instance.json idp.displayName) — any OIDC
  // issuer works, open/sovereign providers first-class; unset → generic "SSO".
  try {
    authConfig = await api('/api/auth/config');
    if (authConfig?.providerName) idpDisplayName = authConfig.providerName;
  } catch { /* gate below re-fetches; views fall back to the generic name */ }
  try {
    session = await api('/api/auth/session');
  } catch {
    // Public sandbox: let an anonymous visitor read the docs without signing in,
    // but only on a public route — every other path still gates, so admin
    // sign-in stays reachable at /admin. The server mirrors this via publicDocs.
    if (authConfig?.publicDocs && PUBLIC_VIEWS.has(currentRouteId())) {
      publicMode = true;
      document.getElementById('theme-toggle')?.remove(); // the public header owns the toggle
      window.addEventListener('hashchange', route);
      await route();
      return;
    }
    await signInGate();
    return;
  }
  if (session.kind !== 'member') {
    gate([el('p', { class: 'gate-lede' }, 'You’re here on a guest link. The console is for deployment members — sign in with your work account to manage the deployment.')]);
    return;
  }
  // Signed in: richer theming from the governed catalog (same tokens as the gate
  // saw, plus any surface tint the pack defines). Idempotent over the gate's.
  await applyPackTheme();
  updateFavicon();
  window.addEventListener('hashchange', route);
  await route();
}

boot();
