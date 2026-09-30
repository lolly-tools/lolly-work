// SPDX-License-Identifier: MPL-2.0
/** Version 1: v1|m,timeMs,endMs,rrggbb,uriLabel|i,timeMs|o,timeMs.
 * Marker kinds are m (marker), c (chapter), r (range), n (note).
 * Times are absolute; marks never contribute to rendered duration. */
export type MarkerKind = 'm' | 'c' | 'r' | 'n';
export interface SequenceMarker { kind: MarkerKind; ms: number; endMs?: number; color: string; label: string }
export interface SequenceMarks { markers: SequenceMarker[]; inMs?: number; outMs?: number }
const MAX_MS = 3_600_000;
const stamp = (s: unknown): number | undefined => {
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 && n <= MAX_MS ? Math.round(n) : undefined;
};
export function parseSequenceMarks(wire: unknown): SequenceMarks {
  const result: SequenceMarks = { markers: [] };
  if (typeof wire !== 'string' || wire.length > 65_536 || !wire.startsWith('v1|')) return result;
  for (const row of wire.split('|').slice(1, 259)) {
    const [kind, time, end, color, text] = row.split(',');
    const ms = stamp(time);
    if (ms === undefined) continue;
    if (kind === 'i') { result.inMs = ms; continue; }
    if (kind === 'o') { result.outMs = ms; continue; }
    if (!['m', 'c', 'r', 'n'].includes(kind ?? '') || result.markers.length >= 256) continue;
    let label: string;
    try { label = decodeURIComponent(text ?? '').slice(0, 160); } catch { continue; }
    const endMs = kind === 'r' ? stamp(end) : undefined;
    result.markers.push({ kind: kind as MarkerKind, ms, label,
      color: /^[a-fA-F0-9]{6}$/.test(color ?? '') ? color!.toLowerCase() : '888888',
      ...(endMs !== undefined && endMs > ms ? { endMs } : {}) });
  }
  result.markers.sort((a, b) => a.ms - b.ms);
  return result;
}
export function serialiseSequenceMarks(marks: SequenceMarks): string {
  const cleanLabel = (label: string): string => label.slice(0, 160).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const parts = marks.markers.slice(0, 256).map(m =>
    `${m.kind},${Math.round(m.ms)},${m.endMs === undefined ? '' : Math.round(m.endMs)},${m.color},${encodeURIComponent(cleanLabel(m.label)).replace(/\|/g, '%7C')}`);
  if (marks.inMs !== undefined) parts.push(`i,${Math.round(marks.inMs)}`);
  if (marks.outMs !== undefined) parts.push(`o,${Math.round(marks.outMs)}`);
  if (parts.join('|').length + 3 <= 65_536) return parts.length ? `v1|${parts.join('|')}` : '';
  let wire = 'v1';
  // Keep the range even when many long translated labels fill the wire budget.
  for (const part of [...parts.filter(p => /^[io],/.test(p)), ...parts.filter(p => !/^[io],/.test(p))]) {
    if (wire.length + part.length + 1 <= 65_536) wire += `|${part}`;
  }
  return wire === 'v1' ? '' : wire;
}
export function sequenceRange(marks: SequenceMarks, durationMs: number): { fromMs: number; toMs: number } {
  const end = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const fromMs = Math.min(end, marks.inMs ?? 0);
  const toMs = Math.min(end, marks.outMs ?? end);
  return toMs > fromMs ? { fromMs, toMs } : { fromMs: 0, toMs: end };
}
export function chaptersVtt(marks: SequenceMarks, durationMs: number): string {
  const chapters = marks.markers.filter(m => m.kind === 'c' && m.ms < durationMs);
  const clock = (ms: number): string => {
    const n = Math.round(ms);
    return `${String(Math.floor(n / 3_600_000)).padStart(2, '0')}:${String(Math.floor(n / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}.${String(n % 1000).padStart(3, '0')}`;
  };
  return 'WEBVTT\n\n' + chapters.map((m, i) => `${clock(m.ms)} --> ${clock(chapters[i + 1]?.ms ?? durationMs)}\n${m.label.replace(/[\r\n]/g, ' ').replace(/-->/g, '→')}\n`).join('\n');
}
