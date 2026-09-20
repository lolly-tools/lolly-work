// SPDX-License-Identifier: MPL-2.0
// Shared DTCG theme and font mapping for the console and public landing page.
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
  // Each theme owns its alias cache. Shared entries would retain the light
  // theme's resolved value when an alias points at a dark override.
  const copyEntries = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, { ...value }]));
  const maps = {};
  for (const t of Array.isArray(tokens.$themes) ? tokens.$themes : []) {
    const merged = {};
    for (const [setName, state] of Object.entries(t.selectedTokenSets ?? {})) {
      if ((state === 'enabled' || state === 'source') && flat[setName]) Object.assign(merged, flat[setName]);
    }
    maps[/dark/i.test(t.name ?? '') ? 'dark' : 'light'] = copyEntries(merged);
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
    { file: `${base}-Variable.woff2`, weight: '100 900' },
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


export { buildThemeMaps, themeFromTokens, resolveCssColor };
