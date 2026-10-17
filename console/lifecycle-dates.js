// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog availability dates, read as whole days in the admin's own time zone
 * (lolly plan 320 C4).
 *
 * A date input gives "2026-12-31", and `new Date("2026-12-31")` is midnight UTC. An
 * asset set to end on 31 Dec therefore ended at the START of 31 Dec in UTC, which in
 * New York is the evening of 30 Dec. A start is now the first moment of its day where
 * the admin is, and an end is the last.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The ISO instant that opens ('start') or closes ('end') a yyyy-mm-dd day here, or
 *  null for an empty or impossible date. */
export function dayBound(value, edge) {
  const m = DATE.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = edge === 'end' ? new Date(y, mo, d, 23, 59, 59, 999) : new Date(y, mo, d, 0, 0, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) return null;
  return at.toISOString();
}

/** A stored instant as the yyyy-mm-dd a date input shows, in this time zone. */
export function localDateValue(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The time zone the dates are read in, for the line under the inputs:
 *  "America/New York", not the identifier's "America/New_York". */
export function zoneName() {
  try { return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').replaceAll('_', ' '); } catch { return ''; }
}
