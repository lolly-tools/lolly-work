/**
 * The bearer listing page for a collection link (plans/31 section 5, and the
 * decision of record of 2026-08-19 that it ships as written).
 *
 * THE BOUNDARY IS THE FEATURE. A collection link hands somebody outside the org
 * exactly one thing: this collection's own assets, as a list, with a zip-all.
 * There is no search box, no way to page past the set, no self-registration, no
 * link back into the catalog, the console or the shell, and nothing on this
 * page addresses any asset the collection does not name. That is what keeps it
 * on the right side of the brand-portal refusal (plans/25, plans/31 section 9):
 * a portal is a place you browse, and this is a list somebody sent you. If it
 * ever needs more than a list and a zip, that is a new decision, not a change
 * here.
 *
 * The chrome is the sign-in gate's chrome, from the same source: the pack's own
 * brand assets, served same-origin through the narrow unauthenticated
 * `/api/brand/*` routes (logo, fonts) that exist precisely so an
 * un-signed-in visitor sees the instance's brand. No CDN, no external fetch, no
 * script at all - so the page renders under the same strict posture the linked
 * bytes themselves are served under.
 */

/** One row of the list. `previewHref` is set only when a browser can actually
 *  paint the format; everything else shows a format tile instead of a broken
 *  image, because a page of broken images reads as a broken link. */
export interface CollectionPageItem {
  assetId: string;
  name: string;
  format: string;
  sizeText?: string;
  previewHref?: string;
  downloadHref: string;
}

export interface CollectionPageBrand {
  /** Same-origin logo routes, when the pack ships a wordmark. */
  logoLight?: string;
  logoDark?: string;
  /** An accent colour lifted from the pack's design tokens. */
  accent?: string;
  /** A same-origin @font-face family name and its woff2 URL, when the pack
   *  ships webfonts (`/api/brand/font/<file>`). */
  fontFamily?: string;
  fontUrl?: string;
}

export interface CollectionPageView {
  instanceName: string;
  name: string;
  description?: string;
  items: CollectionPageItem[];
  /** Members the lifecycle gate withheld at THIS resolve - counted, never
   *  named: the bearer is owed an honest "some of this is gone", and naming an
   *  asset they cannot have would be a reach past the set. */
  withheld: number;
  zipHref: string;
  expiresAt: string;
  brand: CollectionPageBrand;
}

/** Formats a browser paints inline. Anything else gets a tile. */
const PREVIEWABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);

export function isPreviewableFormat(format: string | undefined): boolean {
  return PREVIEWABLE.has(String(format ?? '').toLowerCase());
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/**
 * Pull an accent colour out of a pack's design tokens.
 *
 * Deliberately forgiving: token documents differ between packs, so this walks
 * whatever shape it is handed and takes the first hex colour whose path reads
 * like a brand colour, falling back to the first hex colour at all. A pack with
 * no tokens simply gets the neutral palette below - the page is chrome, and
 * chrome that refuses to render because a token moved would be worse than
 * chrome that is one colour plainer.
 */
export function accentFromTokens(tokens: unknown): string | undefined {
  const hits: Array<{ path: string; value: string }> = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (hits.length > 400 || depth > 8) return;
    if (typeof node === 'string') {
      if (/^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(node)) hits.push({ path, value: node });
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, `${path}/${key.toLowerCase()}`, depth + 1);
    }
  };
  walk(tokens, '', 0);
  const preferred = hits.find((h) => /primary|accent|brand|jungle/.test(h.path));
  return (preferred ?? hits[0])?.value;
}

export function collectionPageHtml(view: CollectionPageView): string {
  const { brand } = view;
  const accent = brand.accent && /^#[0-9a-f]{3,8}$/i.test(brand.accent) ? brand.accent : '#2b6b57';
  const family = brand.fontFamily && brand.fontUrl ? `'${brand.fontFamily.replace(/'/g, '')}', ` : '';
  const fontFace = brand.fontFamily && brand.fontUrl
    ? `@font-face { font-family:'${esc(brand.fontFamily)}'; src:url('${esc(brand.fontUrl)}') format('woff2'); font-weight:100 900; font-display:swap; }`
    : '';

  const logo = brand.logoLight || brand.logoDark
    ? `<img class="logo logo-light" src="${esc(brand.logoLight ?? brand.logoDark)}" alt="${esc(view.instanceName)}" decoding="async">
       ${brand.logoDark ? `<img class="logo logo-dark" src="${esc(brand.logoDark)}" alt="${esc(view.instanceName)}" decoding="async">` : ''}`
    : `<span class="wordmark">${esc(view.instanceName)}</span>`;

  const tiles = view.items.map((item) => {
    const preview = item.previewHref
      ? `<img class="thumb-img" src="${esc(item.previewHref)}" alt="" loading="lazy" decoding="async">`
      : `<span class="thumb-tile">${esc(item.format.toUpperCase().slice(0, 6))}</span>`;
    const meta = [item.format.toUpperCase(), item.sizeText].filter(Boolean).join(' · ');
    return `<li class="item">
      <div class="thumb">${preview}</div>
      <div class="item-body">
        <span class="item-name" title="${esc(item.name)}">${esc(item.name)}</span>
        <span class="item-meta">${esc(meta)}</span>
      </div>
      <a class="btn btn-quiet" href="${esc(item.downloadHref)}">Download</a>
    </li>`;
  }).join('');

  const count = view.items.length;
  const withheldNote = view.withheld
    ? `<p class="note">${view.withheld} ${view.withheld === 1 ? 'asset is' : 'assets are'} no longer available and ${view.withheld === 1 ? 'has' : 'have'} been left out.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(view.name)} - ${esc(view.instanceName)}</title>
<style>
  ${fontFace}
  :root {
    color-scheme: light dark;
    --accent:${esc(accent)};
    --bg:#f7f8f7; --card:#ffffff; --line:#e2e5e3; --fg:#14201c; --muted:#5d6b65;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e1512; --card:#151d19; --line:#26332d; --fg:#eaf2ee; --muted:#9aaaa3; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.55 ${family}-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
  .wrap { max-width: 980px; margin:0 auto; padding: 32px 20px 64px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding-bottom:18px; border-bottom:1px solid var(--line); margin-bottom:26px; }
  .logo { height:26px; width:auto; display:block; }
  .logo-dark { display:none; }
  @media (prefers-color-scheme: dark) { .logo-light { display:none; } .logo-dark { display:block; } }
  .wordmark { font-weight:800; letter-spacing:-.01em; }
  .shared { color:var(--muted); font-size:12.5px; text-align:right; }
  h1 { font-size:27px; font-weight:800; letter-spacing:-.02em; margin:0 0 6px; }
  .lede { color:var(--muted); margin:0 0 18px; max-width:62ch; }
  .bar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:22px; }
  .count { color:var(--muted); font-size:13px; }
  .btn { display:inline-block; background:var(--accent); color:#fff; font-weight:700;
    text-decoration:none; padding:10px 18px; border-radius:9px; }
  .btn-quiet { background:transparent; color:var(--fg); border:1px solid var(--line);
    font-weight:600; padding:7px 12px; font-size:13px; }
  ul { list-style:none; padding:0; margin:0; display:grid; gap:12px;
    grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); }
  .item { background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:12px; display:flex; flex-direction:column; gap:10px; }
  .thumb { display:flex; align-items:center; justify-content:center; height:150px;
    border-radius:8px; overflow:hidden; background:var(--bg); }
  .thumb-img { max-width:100%; max-height:150px; object-fit:contain; }
  .thumb-tile { font-weight:800; font-size:15px; letter-spacing:.08em; color:var(--muted); }
  .item-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .item-name { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item-meta { color:var(--muted); font-size:12px; }
  .note { color:var(--muted); font-size:13px; margin:16px 0 0; }
  .empty { color:var(--muted); }
  footer { margin-top:38px; padding-top:16px; border-top:1px solid var(--line);
    color:var(--muted); font-size:12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>${logo}</div>
    <div class="shared">Shared from ${esc(view.instanceName)}</div>
  </header>
  <h1>${esc(view.name)}</h1>
  ${view.description ? `<p class="lede">${esc(view.description)}</p>` : ''}
  <div class="bar">
    ${count ? `<a class="btn" href="${esc(view.zipHref)}">Download all (${count})</a>` : ''}
    <span class="count">${count} ${count === 1 ? 'asset' : 'assets'}</span>
  </div>
  ${count ? `<ul>${tiles}</ul>` : '<p class="empty">Nothing in this collection is available right now.</p>'}
  ${withheldNote}
  <footer>This link reaches this collection only, and expires ${esc(view.expiresAt)}.</footer>
</div>
</body>
</html>`;
}
