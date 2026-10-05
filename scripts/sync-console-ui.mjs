// SPDX-License-Identifier: MPL-2.0
// Share the web shell's no-build CSS primitives without importing its router or
// styling tool-authored documents. Run with --source <lolly checkout> to update.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw new Error('Use --source <lolly checkout>');
const root = resolve(process.argv[sourceIndex + 1], 'shells/web/src/styles');
const read = file => readFileSync(resolve(root, file), 'utf8');
const slice = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing web-shell boundary: ${start}`);
  return text.slice(a, b);
};
// The admin's theme adapter resolves pack colors to CSS colors, whereas the web
// shell uses HSL triples. Only the color notation changes; the components and
// semantic names remain shared, including instance brand overrides.
const colors = {
  foreground: '--ink', 'muted-foreground': '--muted', background: '--plane',
  card: '--surface', popover: '--surface', muted: '--grid', primary: '--accent',
  'primary-foreground': '--on-accent', border: '--baseline', input: '--baseline',
  ring: '--accent', destructive: '--critical', accent: '--grid',
};
const adapt = text => text.replace(/hsl\(var\(--([\w-]+)\)(?:\s*\/\s*([.\d]+))?\)/g, (all, name, alpha) => {
  if (!colors[name]) throw new Error(`Unmapped web-shell color: ${name}`);
  return alpha ? `color-mix(in srgb, var(${colors[name]}) ${Number(alpha) * 100}%, transparent)` : `var(${colors[name]})`;
});
const tokens = read('tokens.css'), fields = read('parts/fields.css'), buttons = read('parts/buttons.css');
const foundation = slice(tokens, '/* @generated-chrome-tokens start */', '/* @generated-chrome-tokens end */')
  .replace(/  --font-(?:brand|mono):[^\n]*\n/g, '');
const semantics = slice(tokens, '/* @generated-ui-semantics start */', '/* @generated-ui-semantics end */');
const fieldParts = slice(fields, ':root {', '/* ─── Numeric field') + slice(fields, '/* ─── Checkbox + radio', '/* ─── Range');
const buttonParts = slice(buttons, '.btn,', '/* Primary -').replace('.btn,', '.btn,\n:where(button),');
const hash = createHash('sha256').update(tokens + fields + buttons).digest('hex');
const output = `/* SPDX-License-Identifier: MPL-2.0
 * Generated from the Lolly web shell. Do not edit component recipes here.
 * Source CSS SHA-256: ${hash}
 * Update: node scripts/sync-console-ui.mjs --source <lolly checkout>
 */\n:root { --space: 8px; --a11y-fs: 1; --font-brand: var(--font-sans, var(--font-sys)); --font-mono: var(--font-mono-sys); }\n`
  + adapt(foundation + semantics + fieldParts + buttonParts)
  + '\n.btn--primary { background: var(--ui-color-action-primary); color: var(--ui-color-action-on-primary); }\n';
const target = new URL('../console/shell-controls.css', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Console primitives differ from the selected web shell; regenerate them.');
} else writeFileSync(target, output);
console.log('Console primitives match the web shell.');
