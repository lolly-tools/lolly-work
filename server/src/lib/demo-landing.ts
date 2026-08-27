// SPDX-License-Identifier: MPL-2.0
/**
 * The public demo landing page, served at `/` when a deployment has NO web shell
 * mounted (`instance.shellDir` unset) but the passwordless dev provider is on
 * (`dev.enabled`). That combination is exactly the hosted testing sandbox
 * (deploy/vercel - lolly.work): there is no 1.9 GB governed web shell to serve,
 * so `/` is instead the front door - persona sign-in, the docs, a short pitch,
 * and the live render endpoint.
 *
 * Its chrome is near self-contained (inline CSS; the SUSE mark inlined below) -
 * the only fetched asset is the Lolly icon, served same-origin from
 * /admin/icon.svg with its C2PA seal intact, so the page stays CDN-free and
 * CSP-clean. It renders only the personas actually configured in `dev.users` -
 * so what you can click is exactly what the instance will accept at `/api/auth/dev`.
 *
 * RENDER EXAMPLES MUST PASS ANONYMOUS POLICY. The demo overlays
 * (scripts/demo.ts) lock qr-code's `color` and hide its `background` for every
 * group but brand-team, so an example naming either dies as a 422 for the
 * anonymous visitor this page exists for. tests/demo-landing.test.ts checks
 * every example against those overlays and each tool's manifest - keep it green.
 *
 * The `origin` argument is the request's own scheme://host (derived and
 * validated by the route in api/app.ts), so the printed example URLs carry the
 * hostname the visitor is actually on; `instance.baseUrl` is the fallback.
 *
 * SECURITY: this page exposes passwordless sign-in on a public origin. It only
 * ever appears when `dev.enabled` is true, which a real IdP-backed deployment
 * never sets. The banner says so plainly - it is a sandbox, not a product page.
 */
import type { InstanceConfig } from '../config/instance.ts';

// Repo + upstream links surfaced on the public landing.
const REPO_URL = 'https://github.com/lolly-tools/lolly-work';
const SUSE_URL = 'https://www.suse.com';

// The "Founded by SUSE" mark, identical to the one on lolly.tools/info. Inlined
// (not <img src>) to keep this page self-contained - no static-serving path, no
// external fetch, CSP-clean. The pill carries its own pine background so it reads
// on any surface. Same asset is vendored at console/founded-by.svg for the docs
// header, which is not under this page's self-contained constraint.
const FOUNDED_BY_SUSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 142.907 20.451" role="img" aria-label="Founded by SUSE"><path fill="#0c322c" d="M10.226 0H132.68c5.665 0 10.226 4.56 10.226 10.226 0 5.665-4.56 10.225-10.226 10.225H10.226A10.203 10.203 0 0 1 0 10.226C0 4.56 4.56 0 10.226 0"/><path fill="#fff" d="M7.94 7.014v7.174h.8v-3.635h3.999v-.74h-4V7.196a.74.74 0 0 1 .752-.751h3.502v-.74H9.249c-.764 0-1.309.558-1.309 1.31m8.7 7.295c1.636 0 2.824-1.236 2.824-2.993v-.133c0-1.697-1.188-2.909-2.824-2.909s-2.835 1.212-2.835 2.933v.109c0 1.757 1.2 2.993 2.835 2.993m0-.69c-1.211 0-2.072-.946-2.072-2.303v-.11c0-1.308.86-2.24 2.072-2.24s2.048.908 2.048 2.217v.133c0 1.357-.836 2.302-2.048 2.302m6.495.69c.643 0 1.479-.267 1.951-1.078v.957h.703V8.396h-.751v3.296c0 1.272-.824 1.902-1.77 1.902-.92 0-1.61-.448-1.61-1.818v-3.38h-.764v3.502c0 1.708.945 2.411 2.241 2.411m4.569-.121h.775v-3.272c0-1.272.812-1.927 1.782-1.927.933 0 1.623.558 1.623 1.915v3.284h.776v-3.381c0-1.709-.921-2.533-2.218-2.533-.654 0-1.539.291-1.999 1.152v-1.03h-.74zm9.1.121c.957 0 1.757-.497 2.206-1.309v1.188h.702V5.342h-.775v4.156a2.41 2.41 0 0 0-2.133-1.224c-1.563 0-2.714 1.212-2.714 2.933v.109c0 1.781 1.115 2.993 2.714 2.993m.097-.69c-1.187 0-2.036-.922-2.036-2.303v-.11c0-1.332.849-2.24 2.036-2.24 1.2 0 2.084.944 2.084 2.326 0 1.393-.884 2.326-2.084 2.326m7.21.69c.812 0 1.551-.279 1.963-.69l-.436-.498c-.376.328-.885.473-1.503.473-1.26 0-2.084-.885-2.145-2.096h4.326c.219-1.951-.787-3.224-2.41-3.224-1.6 0-2.679 1.236-2.679 2.92v.122c0 1.77 1.175 2.993 2.884 2.993m-2.108-3.454c.12-1.15.824-1.902 1.902-1.902 1.006 0 1.709.715 1.684 1.902zm8.106 3.454c.958 0 1.757-.497 2.206-1.309v1.188h.702V5.342h-.775v4.156a2.41 2.41 0 0 0-2.133-1.224c-1.563 0-2.714 1.212-2.714 2.933v.109c0 1.781 1.115 2.993 2.714 2.993m.097-.69c-1.187 0-2.036-.922-2.036-2.303v-.11c0-1.332.849-2.24 2.036-2.24 1.2 0 2.084.944 2.084 2.326 0 1.393-.884 2.326-2.084 2.326m10.53.69c1.588 0 2.715-1.212 2.715-2.993v-.11c0-1.72-1.14-2.932-2.715-2.932a2.41 2.41 0 0 0-2.132 1.224V5.342h-.776v8.846h.715V13a2.46 2.46 0 0 0 2.193 1.309m-.097-.69c-1.2 0-2.084-.934-2.084-2.327 0-1.382.885-2.327 2.084-2.327 1.188 0 2.036.909 2.036 2.242v.109c0 1.381-.848 2.302-2.036 2.302m3.515 2.992h1.066c.945 0 1.32-.69 1.587-1.345l2.824-6.87h-.848l-1.89 4.895-1.976-4.895h-.848l2.411 5.84-.46 1.006c-.158.376-.364.703-.764.703h-1.102z" aria-label="Founded by" font-family="SUSE" font-size="12.118" font-weight="300" letter-spacing="0" style="line-height:.8"/><path fill="#fff" d="M131.387 14.015c-.954 0-1.73-.776-1.73-1.73V7.157c0-.954.776-1.73 1.73-1.73h3.936a.56.56 0 0 1 0 1.117h-3.936a.613.613 0 0 0-.612.613v2.018h3.86a.53.53 0 0 1 0 1.06h-3.86v2.05c0 .337.274.612.612.612h3.936a.56.56 0 0 1 0 1.118zm-17.65.112c-1.136 0-2.01-.288-2.6-.856-.589-.568-.887-1.421-.887-2.538v-4.77a.648.648 0 0 1 1.296 0v4.6c0 .835.18 1.46.535 1.86.357.402.913.605 1.655.605s1.299-.203 1.656-.605c.355-.4.534-1.025.534-1.86v-4.6a.649.649 0 0 1 1.297 0v4.77c0 1.116-.3 1.97-.888 2.538-.59.568-1.464.856-2.599.856m9.736 0c-1.462 0-2.575-.415-3.309-1.234a.606.606 0 0 1 .03-.832l.003-.003.002-.002a.6.6 0 0 1 .435-.178c.174 0 .338.074.45.204q.308.356.696.57c.45.25 1.014.376 1.68.376.63 0 1.134-.11 1.496-.33q.56-.341.562-.967 0-.506-.51-.814c-.328-.198-.882-.368-1.695-.52-.79-.148-1.425-.332-1.891-.548-.46-.213-.8-.48-1.006-.793-.207-.311-.312-.698-.312-1.149a2.3 2.3 0 0 1 .397-1.306c.264-.391.651-.707 1.15-.937.503-.232 1.098-.35 1.769-.35.784 0 1.462.144 2.015.427q.56.287 1.001.779a.614.614 0 0 1-.456 1.02.61.61 0 0 1-.485-.239 2.2 2.2 0 0 0-.557-.523c-.376-.242-.882-.364-1.505-.364-.614 0-1.1.125-1.442.373-.348.252-.525.58-.525.976 0 .371.173.67.515.886.332.211.906.389 1.756.541.772.139 1.392.317 1.844.528.447.208.778.47.98.78.203.308.306.696.306 1.154 0 .493-.142.932-.421 1.305-.282.375-.682.666-1.189.866-.511.202-1.112.304-1.785.304m-19.406.002c-1.462 0-2.575-.415-3.31-1.234a.606.606 0 0 1 .032-.832l.003-.003a.62.62 0 0 1 .436-.18c.175 0 .339.074.45.204q.308.355.696.571c.45.25 1.014.376 1.68.376.63 0 1.133-.111 1.496-.33q.56-.341.562-.967-.001-.507-.51-.814c-.328-.199-.883-.369-1.695-.521-.79-.147-1.426-.332-1.892-.547-.46-.213-.799-.48-1.006-.793-.206-.312-.311-.698-.311-1.149 0-.476.133-.915.396-1.306.264-.392.652-.707 1.152-.938.501-.231 1.096-.349 1.767-.349.784 0 1.463.144 2.016.427.372.19.709.452 1 .778a.613.613 0 1 1-.94.782 2.2 2.2 0 0 0-.557-.523c-.377-.242-.883-.365-1.505-.365-.615 0-1.1.126-1.443.373q-.523.381-.524.977c0 .37.173.67.514.886.332.211.907.388 1.757.541.77.138 1.391.315 1.845.527q.672.316.98.78c.202.308.305.696.305 1.155 0 .493-.142.932-.422 1.304-.281.375-.681.667-1.189.867-.511.202-1.111.304-1.784.304"/><path fill="#30ba78" d="M95.563 8.347a.35.35 0 0 0-.505 0 .358.358 0 0 0 .448.55.36.36 0 0 0 .056-.55m-.461-1.214a1.32 1.32 0 1 0-.602 2.571 1.32 1.32 0 0 0 .602-2.57m-6.296 5.368c-.621-.23-.861-.184-1.656-.173-.55.007-.57-.012-1.199-.012-.194 0-.266.93.437 1.124.307.085.64.138.871.375.103.104.16.262-.077.262h-1.744c-.305 0-.593.007-.826-.19-.352-.298-.517-.707-.693-1.114-.183-.422-.38-.838-.612-1.236-.46-.792-1.07-1.508-1.886-1.946-1.02-.547-2.751-.818-4.122.235-1.444 1.109-1.135 3.186.129 4.202.499.402 1.15.57 1.788.532 1.25-.072 2.171-.993 1.943-2.126-.077-.38-.298-.739-.631-.935-.237-.138-.518-.187-.793-.188-.295 0-.609.06-.821.265a.766.766 0 0 0-.091.959c.11.158.292.292.261.499a.34.34 0 0 1-.274.274c-.234.053-.449-.081-.607-.244a1.54 1.54 0 0 1-.31-1.623c.293-.705 1.105-1.093 1.868-1.068.983.033 1.91.682 2.314 1.58.403.898.282 2-.274 2.812-1.235 1.805-4.284 1.592-5.702.07-.888-.955-1.371-1.882-1.304-3.607.048-1.22.752-2.421 1.649-3.266 1.461-1.377 3.386-2.32 5.344-2.725a12 12 0 0 1 3.625-.183c1.065.106 2.124.3 3.147.618.508.158 1.008.346 1.491.568.426.196.985.41 1.317.747 0-.612-.024-1.285-.024-1.753 0-.179.188-.3.349-.223.692.321 2.333 1.097 3.427 1.597 1.466.67 1.57 2.25 1.621 3.652.001.031.003.063-.011.091-.046.096-.293.07-.384.071-.175.002-.44 0-.615.01-.35.014-.691.008-1.041-.01a2.97 2.97 0 0 1-1.692-.67c-.042-.036-.178-.074-.241-.008a.166.166 0 0 0-.008.212c.24.242.5.399.804.555.385.198.805.248 1.23.273q.687.042 1.37-.026c.38-.04.479-.065.104.213a4 4 0 0 1-1.099.55 5.9 5.9 0 0 1-1.728.3q-.533.014-1.062-.055c-.183-.023-.364-.056-.547-.074-.148-.015-.302-.043-.45-.01a.6.6 0 0 0-.343.21c-.116.152-.156.567-.089.747.13.349.414.552.714.73.325.194.753.26.837.63.017.077-.675.079-.753.078h-.92s-.5.012-.695-.06q-.009-.002-.018-.007c-.106-.057-.152-.199-.188-.306a2 2 0 0 0-.25-.46c-.208-.296-.528-.62-.86-.744m6.968-4.083a.976.976 0 1 1-1.951 0 .976.976 0 0 1 1.951 0"/></svg>';

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** Presentation-only persona chrome derived from a persona's groups: a chip
 *  label and one line saying what governance that persona demonstrates. The
 *  blurbs describe the demo seed (scripts/demo.ts overlays + grants); an
 *  instance configured with other groups gets the neutral fallbacks. */
function personaMeta(groups: string[]): { label: string; blurb: string } {
  if (groups.includes('admin')) {
    return { label: 'Admin', blurb: 'Runs the deploy: policy overlays, grants, approval chains, telemetry.' };
  }
  if (groups.includes('brand-team')) {
    return { label: 'Brand team', blurb: 'Edits the inputs policy locks for everyone else, and clears brand approvals.' };
  }
  if (groups.includes('marketing')) {
    return { label: 'Marketing', blurb: 'A governed member: locked brand inputs, approval requests on gated output.' };
  }
  if (groups.includes('contractors')) {
    return { label: 'Contractor', blurb: 'The narrowest view. Tools hidden by policy never even appear.' };
  }
  if (groups.includes('approver')) return { label: 'Approver', blurb: 'Reviews and clears output waiting on sign-off.' };
  return { label: 'Member', blurb: 'A standard governed member of the org.' };
}

/** Live-render examples, grouped by tool, each with tryable params so a visitor
 *  can see how the same GET reshapes the output. Params are real inputs from each
 *  tool's manifest (packs/demo) AND allowed for the anonymous caller under the
 *  demo overlays - qr-code's color/background are deliberately absent (locked /
 *  hidden: that policy is part of the demo). These are Tier-A (SVG + resvg PNG,
 *  no Chromium). Enforced by tests/demo-landing.test.ts. */
export interface Example { label: string; href: string; note: string }
export const RENDER_GROUPS: Array<{ tool: string; blurb: string; examples: Example[] }> = [
  {
    tool: 'qr-code',
    blurb: 'A real QR to any URL, with governance you can watch working: policy locks the module colour to SUSE green for visitors and hides the background input entirely. Sign in as the Brand team persona and the same endpoint hands both back.',
    examples: [
      { label: 'Scan me', href: '/render/qr-code.svg?url=https://lolly.work', note: 'url' },
      { label: 'High error-correction, wide quiet zone', href: '/render/qr-code.svg?url=https://www.suse.com&ecl=H&padding=6', note: 'ecl=H, padding' },
      { label: 'Separate modules', href: '/render/qr-code.svg?url=https://lolly.tools/info&join=false&ecl=Q', note: 'join=false, ecl' },
      { label: 'PNG', href: '/render/qr-code.png?url=https://lolly.work', note: '.png' },
    ],
  },
  {
    tool: 'mesh-gradient',
    blurb: 'A vector mesh of real <radialGradient> stops.',
    examples: [
      { label: 'Default (5 stops)', href: '/render/mesh-gradient.svg', note: '—' },
      { label: 'SUSE spectrum, 7 stops, screen', href: '/render/mesh-gradient.svg?count=7&blend=screen&color1=%2330ba78&color2=%232453ff&color3=%2390ebcd', note: 'count, blend, color1..3' },
      { label: 'Persimmon → midnight', href: '/render/mesh-gradient.svg?count=4&color1=%23fe7c3f&color2=%23192072&blend=hard-light', note: 'colours, blend' },
      { label: 'PNG @ 800', href: '/render/mesh-gradient.png?width=800&count=6&color1=%2330ba78&color2=%2300bda7', note: '.png, width' },
    ],
  },
  {
    tool: 'color-palette',
    blurb: 'A brand palette generated from a seed colour.',
    examples: [
      { label: 'Default', href: '/render/color-palette.svg', note: '—' },
      { label: 'Jungle seed, triad, 9 steps', href: '/render/color-palette.svg?seed=%2330ba78&harmony=triad-3&steps=9', note: 'seed, harmony, steps' },
      { label: 'Persimmon, complementary, OKLab', href: '/render/color-palette.svg?seed=%23fe7c3f&harmony=complement&steps=7&mode=oklab', note: 'seed, harmony, mode' },
      { label: 'Waterhole, analogous', href: '/render/color-palette.svg?seed=%232453ff&harmony=analogous&steps=8&neutrals=false', note: 'seed, harmony, neutrals' },
    ],
  },
];

/** What the control plane adds for an organization - the pitch, kept honest:
 *  every card names a feature this deploy actually demonstrates. */
const FEATURES: Array<{ title: string; body: string }> = [
  { title: 'One governed catalog', body: 'Every team renders from the same vetted tools and templates. Visibility is per group: a tool hidden from contractors does not exist for them.' },
  { title: 'Policy enforced at render time', body: 'Inputs can be locked to brand values, limited to a choice, or hidden per group, and the API refuses what the console never offered. The QR tool below is live proof.' },
  { title: 'Approvals and watermarks', body: 'Output can escalate through brand and legal chains, and previews carry a watermark until sign-off clears.' },
  { title: 'Provenance and audit', body: 'Server renders are C2PA-signed, the audit log is hash-chained and append-only, and telemetry rolls up for dashboards and your SIEM.' },
  { title: 'Your identity, your infrastructure', body: 'OIDC against the IdP you already run, roles plus fine-grained grants. Deploy with Compose, systemd, or Kubernetes/Helm; the sovereign SUSE stack is the reference path.' },
  { title: 'Open and exit-friendly', body: 'MPL-2.0 open source. Rendering happens on-device, existing DAM libraries federate in, and moving off a platform is a documented path, not a fight.' },
];

export function demoLandingHtml(config: InstanceConfig, origin?: string): string {
  const name = esc(config.instance.name || 'Lolly Work');
  // The origin printed in front of every example path. The route derives it from
  // the request's validated Host header; baseUrl covers direct calls and tests.
  const base = (origin || config.instance.baseUrl || '').replace(/\/+$/, '');
  const personas = (config.dev.users ?? []).map((u) => {
    const groups = u.groups ?? [];
    return {
      email: u.email,
      name: u.name,
      groups: groups.join(', ') || '—',
      ...personaMeta(groups),
    };
  });

  const personaCards = personas
    .map(
      (p) => `
      <a class="persona" href="/api/auth/dev?email=${encodeURIComponent(p.email)}&returnTo=/admin">
        <span class="persona-role">${esc(p.label)}</span>
        ${p.name ? `<span class="persona-name">${esc(p.name)}</span>` : ''}
        <span class="persona-email">${esc(p.email)}</span>
        <span class="persona-blurb">${esc(p.blurb)}</span>
        <span class="persona-groups">groups: ${esc(p.groups)}</span>
      </a>`,
    )
    .join('');

  const featureCards = FEATURES.map((f) => `
    <div class="feature"><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></div>`).join('');

  const renderGroups = RENDER_GROUPS.map((g) => `
    <div class="tool">
      <div class="tool-head"><code class="tool-id">${esc(g.tool)}</code><span class="tool-blurb">${esc(g.blurb)}</span></div>
      <ul class="links">
        ${g.examples.map((e) => `<li>
          <a href="${esc(e.href)}">${esc(e.label)}</a>
          <span class="params">${esc(e.note)}</span>
          <code>${esc(base + e.href)}</code>
        </li>`).join('')}
      </ul>
    </div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/svg+xml" href="/admin/icon.svg">
<title>${name} · demo sandbox</title>
<style>
  /* SUSE brand fonts, served from the pack (same-origin) via /api/brand/font. */
  @font-face { font-family:'SUSE'; src:url('/api/brand/font/SUSE-Variable.woff2') format('woff2'); font-weight:100 800; font-display:swap; }
  @font-face { font-family:'SUSE Mono'; src:url('/api/brand/font/SUSEMono-Variable.woff2') format('woff2'); font-weight:100 800; font-display:swap; }
  /* SUSE palette (brand.json): pine / jungle / mint / persimmon / waterhole / fog. */
  :root {
    color-scheme: dark;
    --pine:#0c322c; --jungle:#30ba78; --mint:#90ebcd; --persimmon:#fe7c3f; --waterhole:#2453ff;
    --bg:#071f1a; --card:#0c322c; --line:#134b40; --fg:#eafaf4; --muted:#83e1be;
    --accent:#30ba78; --accent-fg:#04140c; --warn:#fcb244;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:
      radial-gradient(1200px 500px at 80% -10%, rgba(48,186,120,.14), transparent 60%),
      radial-gradient(900px 500px at -10% 10%, rgba(36,83,255,.10), transparent 55%),
      var(--bg);
    color:var(--fg); font:15px/1.55 'SUSE',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 44px 20px 72px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.01em; font-size:15px; color:var(--fg); }
  .brand-icon { width:24px; height:24px; display:block; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
  .founded { display:inline-flex; opacity:.92; transition:opacity .15s; }
  .founded:hover { opacity:1; }
  .founded svg { height:20px; width:auto; display:block; }
  .sandbox { display:flex; gap:10px; align-items:flex-start; background:rgba(252,178,68,.1); border:1px solid rgba(252,178,68,.35); color:#ffdca0; border-radius:12px; padding:12px 14px; font-size:13.5px; margin-bottom:28px; }
  .sandbox strong { color:var(--warn); }
  h1 { font-size:30px; font-weight:800; margin:0 0 6px; letter-spacing:-.02em; }
  .lede { color:var(--muted); margin:0 0 28px; max-width:64ch; }
  .lede.tight { margin-bottom:10px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--mint); margin:34px 0 12px; font-weight:700; }
  .personas { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .persona { display:flex; flex-direction:column; gap:2px; text-decoration:none; color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:12px; padding:15px; transition:border-color .15s, transform .05s, background .15s; }
  .persona:hover { border-color:var(--jungle); background:#0e3a32; }
  .persona:active { transform:translateY(1px); }
  .persona-role { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--jungle); font-weight:800; }
  .persona-name { font-weight:700; margin-top:2px; }
  .persona-email { color:var(--fg); font-size:12.5px; font-weight:600; font-family:'SUSE Mono',ui-monospace,monospace; margin-top:2px; }
  .persona-blurb { color:var(--muted); font-size:12px; margin-top:6px; line-height:1.45; }
  .persona-groups { color:var(--muted); font-size:11px; margin-top:6px; opacity:.7; font-family:'SUSE Mono',ui-monospace,monospace; }
  .features { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:12px; }
  .feature { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:15px; }
  .feature h3 { margin:0 0 4px; font-size:14px; font-weight:700; color:var(--fg); }
  .feature p { margin:0; color:var(--muted); font-size:13px; line-height:1.5; }
  .tool { margin:14px 0 8px; }
  .tool-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:2px; }
  .tool-id { background:transparent; border:0; color:var(--jungle); font-weight:700; font-size:14px; padding:0; }
  .tool-blurb { color:var(--muted); font-size:13px; max-width:72ch; }
  ul { list-style:none; padding:0; margin:0; }
  .links li { display:grid; grid-template-columns:minmax(180px,auto) 1fr; align-items:center; gap:8px 12px; padding:8px 0; border-bottom:1px solid var(--line); }
  .links a { color:var(--fg); text-decoration:none; font-weight:600; }
  .links a:hover { color:var(--jungle); text-decoration:underline; }
  .params { color:var(--persimmon); font-size:11.5px; font-family:'SUSE Mono',ui-monospace,monospace; }
  code { background:#06231d; border:1px solid var(--line); border-radius:6px; padding:2px 7px; font-size:11.5px; color:var(--mint); font-family:'SUSE Mono',ui-monospace,monospace; grid-column:1 / -1; overflow-x:auto; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; }
  .btn { display:inline-block; background:var(--jungle); color:var(--accent-fg); font-weight:700; text-decoration:none; padding:10px 18px; border-radius:9px; }
  .btn:hover { background:#42d29f; }
  .btn.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
  footer { margin-top:44px; color:var(--muted); font-size:12.5px; display:flex; flex-direction:column; gap:14px; align-items:flex-start; }
  .founded--footer svg { height:22px; }
  .footer-links { margin:0; opacity:.8; }
  a { color:var(--jungle); }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="brand"><img class="brand-icon" src="/admin/icon.svg" alt="" width="24" height="24" decoding="async"> Lolly · SUSE control plane</div>
    <a class="founded" href="${SUSE_URL}" target="_blank" rel="noopener">${FOUNDED_BY_SUSE_SVG}</a>
  </div>
  <div class="sandbox">
    <span>⚠️</span>
    <div><strong>Public testing sandbox.</strong> Sign-in is passwordless: anyone can enter as any persona, including admin. State is in-memory and resets on redeploy. Do not put anything real or sensitive here.</div>
  </div>

  <h1>${name}</h1>
  <p class="lede">The open-source control plane for Lolly, SUSE's on-brand content tooling: the layer an organization hosts so thousands of people can use creative tools without a brand, legal, or compliance incident. Everything on this page is the real product running with demo data.</p>

  <h2>Start here</h2>
  <div class="row">
    <a class="btn" href="/admin#/docs">Read the docs →</a>
    <a class="btn secondary" href="/admin">Open the admin console</a>
    <a class="btn secondary" href="${REPO_URL}" target="_blank" rel="noopener">View on GitHub ↗</a>
  </div>
  <p class="lede tight" style="margin-top:10px">The full operator docs (install, config, governance, API and CLI references) are readable right here, no sign-in needed.</p>

  <h2>Sign in as a demo persona</h2>
  <p class="lede tight">One click, no password. Each persona opens the same console with different governance applied, so pick two and compare what they can see and change.</p>
  <div class="personas">${personaCards || '<p class="lede">No dev personas configured.</p>'}</div>

  <h2>What the control plane does</h2>
  <p class="lede tight">Lolly's tools are free and render on-device for anyone. The control plane is what makes them safe to hand to an entire enterprise:</p>
  <div class="features">${featureCards}</div>

  <h2>Live renders, over a plain GET</h2>
  <p class="lede tight">Every catalog tool renders from a URL an agent, a pipeline, or an <code style="grid-column:auto">&lt;img&gt;</code> tag can hit: <code style="grid-column:auto">GET ${esc(base)}/render/&lt;tool&gt;.&lt;format&gt;?params</code> - governed by the same policy as the console. Click an example, then change the params:</p>
  ${renderGroups}

  <footer>
    <a class="founded founded--footer" href="${SUSE_URL}" target="_blank" rel="noopener">${FOUNDED_BY_SUSE_SVG}</a>
    <p class="footer-links">Powered by the Lolly engine · <a href="/admin#/docs">docs</a> · <a href="${REPO_URL}" target="_blank" rel="noopener">source</a> · <a href="/admin">console</a></p>
  </footer>
</div>
</body>
</html>`;
}
