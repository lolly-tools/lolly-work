/**
 * Preview watermark compositor (plans/05 §4).
 *
 * Injects a diagonal, tiling "PREVIEW" brick pattern into the root <svg>: a
 * <defs> pattern (the word repeated at 45°, alternating brick rows fill with
 * `#0002` and `#fff2` so it reads on both light and dark art) plus a covering
 * <rect>. Applied to the SVG BEFORE any PNG rasterisation, so both svg and png
 * carry it.
 *
 * Pure string work (no DOM), so it stays import-clean and runs anywhere.
 *
 * TODO(plans/05): the `until-approved` enforcement state needs the approval
 * store to decide per-render whether the mark stays; that linkage is deliberately
 * NOT built here — this compositor only knows "watermark now" vs "don't".
 */

const PATTERN_ID = 'lw-preview-watermark';

/** Escape the little we inject into attributes/markup (defensive; inputs are static). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Return `svg` with the PREVIEW watermark pattern injected into its root <svg>.
 * Idempotent: if the mark is already present the input is returned unchanged.
 * If the string carries no <svg> open tag it is returned unchanged (nothing to
 * mark).
 */
export function applyPreviewWatermark(svg: string): string {
  if (svg.includes(PATTERN_ID)) return svg;
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return svg;
  const at = (open.index ?? 0) + open[0].length;

  // One 220×160 tile carries two PREVIEW words offset by half a tile (the brick),
  // each a different translucent ink. patternTransform tilts the whole grid to 45°.
  const label = esc('PREVIEW');
  const tileW = 220;
  const tileH = 160;
  // SUSE leads the stack (the brand pair everywhere, 2026-08-11): it resolves
  // wherever the face is installed — the worker image's font bake (plans/22
  // §6.2 audit R2, queued) will make that every sovereign render — and the
  // sans fallbacks keep the mark legible where it is not.
  const defs =
    `<defs>` +
    `<pattern id="${PATTERN_ID}" patternUnits="userSpaceOnUse" ` +
    `width="${tileW}" height="${tileH}" patternTransform="rotate(-45)">` +
    `<text x="10" y="46" font-family="SUSE, Helvetica, Arial, sans-serif" font-size="34" ` +
    `font-weight="700" fill="#0002" letter-spacing="6">${label}</text>` +
    `<text x="${tileW / 2}" y="${tileH / 2 + 46}" font-family="SUSE, Helvetica, Arial, sans-serif" ` +
    `font-size="34" font-weight="700" fill="#fff2" letter-spacing="6">${label}</text>` +
    `</pattern>` +
    `</defs>`;
  // Cover the whole canvas; a userSpaceOnUse pattern fills to the rect's box.
  const rect = `<rect x="0" y="0" width="100%" height="100%" fill="url(#${PATTERN_ID})" pointer-events="none"/>`;

  return svg.slice(0, at) + defs + rect + svg.slice(at);
}
