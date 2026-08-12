// Pure, DOM-free sort comparator for the console's sortable tables. Kept in its
// own module so it's importable under node:test without a document. Browser +
// node ES module (served at /admin/table-sort.js by the console static handler).

/** A cell string as a number, or NaN when it isn't one. Strips thousands
 *  separators/whitespace so "12,345" and "12 345" compare numerically. */
export function coerceNumber(s) {
  if (s === '') return NaN;
  const n = Number(String(s).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** A cell string as an epoch, or NaN when it isn't a date. */
export function coerceDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

const isBlank = (s) => s === '' || s === '—';

/**
 * Ascending comparator. Blanks ('' or the em-dash placeholder) always sort LAST
 * — the caller must apply this result WITHOUT multiplying by the sort direction
 * for blank cells, so blanks stay at the bottom in both directions. `type` may be
 * 'number' | 'date' | 'text' | 'auto' (auto-detects number then date).
 */
export function compareValues(a, b, type = 'auto') {
  const ea = isBlank(a);
  const eb = isBlank(b);
  if (ea && eb) return 0;
  if (ea) return 1;
  if (eb) return -1;
  if (type === 'number' || (type === 'auto' && !Number.isNaN(coerceNumber(a)) && !Number.isNaN(coerceNumber(b)))) {
    const d = coerceNumber(a) - coerceNumber(b);
    if (!Number.isNaN(d)) return d;
  }
  if (type === 'date' || (type === 'auto' && !Number.isNaN(coerceDate(a)) && !Number.isNaN(coerceDate(b)))) {
    const d = coerceDate(a) - coerceDate(b);
    if (!Number.isNaN(d)) return d;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
