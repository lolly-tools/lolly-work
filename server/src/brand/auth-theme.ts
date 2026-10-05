// SPDX-License-Identifier: MPL-2.0
/** Resolve the brand UI family; never choose an arbitrary display or black face. */
export function pickAuthFont(tokens: unknown, files: readonly string[]): { family: string; file: string } | null {
  const values = new Map<string, string>();
  const flatten = (node: unknown, prefix = '', depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 16 || values.size > 4096) return;
    const record = node as Record<string, unknown>;
    if (typeof record.$value === 'string') { values.set(prefix, record.$value); return; }
    for (const [key, child] of Object.entries(record)) if (!key.startsWith('$')) flatten(child, prefix ? `${prefix}.${key}` : key, depth + 1);
  };
  if (tokens && typeof tokens === 'object') for (const [key, set] of Object.entries(tokens)) if (!key.startsWith('$')) flatten(set);
  const resolve = (key: string, seen = new Set<string>()): string | null => {
    if (seen.has(key)) return null; seen.add(key);
    const value = values.get(key), alias = value?.match(/^\{([^}]+)\}$/);
    return alias ? resolve(alias[1]!, seen) : value?.trim() || null;
  };
  const family = resolve('font.brand') ?? resolve('font.sans');
  if (!family || !/^[A-Za-z0-9 _-]{1,80}$/.test(family)) return null;
  const base = family.replace(/\s+/g, '');
  const file = [`${base}-Variable.woff2`, `${base}[wght].woff2`, `${base}-Regular.woff2`].find(file => files.includes(file));
  return file ? { family, file } : null;
}

/** Script-free sign-in pages inherit the active source's DTCG colours and fonts. */
export function authThemeCss(tokens: unknown, font: { family: string; file: string } | null): string {
  const sets = tokens && typeof tokens === 'object' ? tokens as Record<string, unknown> : {};
  const flatten = (node: unknown, prefix: string, out: Map<string, string>, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 16 || out.size > 4096) return;
    const record = node as Record<string, unknown>;
    if (typeof record.$value === 'string') { out.set(prefix, record.$value); return; }
    for (const [key, child] of Object.entries(record)) if (!key.startsWith('$')) flatten(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  };
  const maps: Record<string, Map<string, string>> = {};
  for (const mode of ['light', 'dark']) {
    const out = new Map<string, string>();
    const themes = Array.isArray(sets.$themes) ? sets.$themes : [];
    const theme = themes.find(t => t && typeof t === 'object' && typeof t.name === 'string' && new RegExp(mode, 'i').test(t.name));
    const selected = theme?.selectedTokenSets && typeof theme.selectedTokenSets === 'object' ? theme.selectedTokenSets : null;
    for (const [name, set] of Object.entries(sets)) if (!name.startsWith('$') && (selected ? ['enabled', 'source'].includes(selected[name]) : name !== (mode === 'light' ? 'dark' : 'light'))) flatten(set, '', out);
    maps[mode] = out;
  }
  const read = (map: Map<string, string>, key: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(key)) return undefined; seen.add(key);
    const value = map.get(key), alias = value?.match(/^\{([^}]+)\}$/);
    return alias ? read(map, alias[1]!, seen) : value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
  };
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const properties: string[] = [];
  for (const mode of ['light', 'dark']) {
    const map = maps[mode]!, accent = read(map, 'color.semantic.primary'), surface = read(map, 'color.semantic.surface');
    if (!accent) continue;
    const l = luminance(accent), plane = mode === 'light' ? 1 : luminance('#030711');
    if ((Math.max(l, plane) + .05) / (Math.min(l, plane) + .05) < 3) continue;
    properties.push(`--pack-accent-${mode}:${accent}`, `--pack-on-accent-${mode}:${(l + .05) / .05 >= 1.05 / (l + .05) ? '#000' : '#fff'}`);
    if (surface) {
      properties.push(`--pack-plane-${mode}:color-mix(in oklab,${surface} 6%,${mode === 'light' ? '#fff' : '#030711'})`, `--pack-surface-${mode}:color-mix(in oklab,${surface} 6%,${mode === 'light' ? '#fcfcfc' : '#0a101f'})`);
    }
  }
  let face = '';
  if (font && /^[A-Za-z0-9 _-]{1,80}$/.test(font.family) && /^[A-Za-z0-9._[\]-]+\.woff2$/.test(font.file)) {
    face = `@font-face{font-family:'AuthBrand';src:url('/api/brand/font/${encodeURIComponent(font.file)}') format('woff2');font-weight:${/variable|\[wght\]/i.test(font.file) ? '100 900' : '400'};font-style:normal;font-display:swap}`;
    properties.push("--font-sans:'AuthBrand',system-ui,sans-serif");
  }
  return `${face}:root{${properties.join(';')}}`;
}
