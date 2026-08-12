// SPDX-License-Identifier: UNLICENSED
/**
 * The public demo landing page, served at `/` when a deployment has NO web shell
 * mounted (`instance.shellDir` unset) but the passwordless dev provider is on
 * (`dev.enabled`). That combination is exactly the hosted testing sandbox
 * (deploy/vercel — lolly.work): there is no 1.9 GB governed web shell to serve,
 * so `/` is instead a one-click way into the governed admin console + the live
 * render endpoint.
 *
 * It is deliberately self-contained (inline CSS, zero external assets) so it
 * needs no static-serving path and satisfies a strict CSP, and it renders only
 * the personas actually configured in `dev.users` — so what you can click is
 * exactly what the instance will accept at `/api/auth/dev`.
 *
 * SECURITY: this page exposes passwordless sign-in on a public origin. It only
 * ever appears when `dev.enabled` is true, which a real IdP-backed deployment
 * never sets. The banner says so plainly — it is a sandbox, not a product page.
 */
import type { InstanceConfig } from '../config/instance.ts';

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** A friendly role label from a persona's groups (mirrors roleFromGroups' intent
 *  without importing it — this is presentation only). */
function roleLabel(groups: string[]): string {
  if (groups.includes('admin')) return 'Admin';
  if (groups.includes('approver')) return 'Approver';
  return 'Member';
}

/** Live-render examples, grouped by tool, each with tryable params so a visitor can
 *  see how the same GET reshapes the output. Params are real inputs from each tool's
 *  manifest (packs/demo). These are Tier-A (SVG + resvg PNG, no Chromium). */
interface Example { label: string; href: string; note: string }
const RENDER_GROUPS: Array<{ tool: string; blurb: string; examples: Example[] }> = [
  {
    tool: 'qr-code',
    blurb: 'A real QR to any URL — the canonical “render a tool over a GET”.',
    examples: [
      { label: 'Black on white', href: '/render/qr-code.svg?url=https://lolly.tools/info&background=white&color=black', note: 'url, background, color' },
      { label: 'SUSE jungle, high error-correction', href: '/render/qr-code.svg?url=https://lolly.work&color=%2330ba78&ecl=H&padding=2', note: 'color, ecl=H, padding' },
      { label: 'On pine, tight quiet-zone', href: '/render/qr-code.svg?url=https://www.suse.com&color=%23eafaf4&background=%230c322c&padding=1', note: 'color, background' },
      { label: 'PNG @ 512', href: '/render/qr-code.png?url=https://lolly.work&width=512&color=%23192072', note: '.png, width' },
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

export function demoLandingHtml(config: InstanceConfig): string {
  const name = esc(config.instance.name || 'Lolly Work');
  const personas = (config.dev.users ?? []).map((u) => {
    const groups = u.groups ?? [];
    return {
      email: u.email,
      name: u.name || u.email,
      role: roleLabel(groups),
      groups: groups.join(', ') || '—',
    };
  });

  const personaCards = personas
    .map(
      (p) => `
      <a class="persona" href="/api/auth/dev?email=${encodeURIComponent(p.email)}&returnTo=/admin">
        <span class="persona-role">${esc(p.role)}</span>
        <span class="persona-name">${esc(p.name)}</span>
        <span class="persona-email">${esc(p.email)}</span>
        <span class="persona-groups">${esc(p.groups)}</span>
      </a>`,
    )
    .join('');

  const renderGroups = RENDER_GROUPS.map((g) => `
    <div class="tool">
      <div class="tool-head"><code class="tool-id">${esc(g.tool)}</code><span class="tool-blurb">${esc(g.blurb)}</span></div>
      <ul class="links">
        ${g.examples.map((e) => `<li>
          <a href="${esc(e.href)}">${esc(e.label)}</a>
          <span class="params">${esc(e.note)}</span>
          <code>${esc(e.href)}</code>
        </li>`).join('')}
      </ul>
    </div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name} — demo sandbox</title>
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
  .brand { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.01em; font-size:15px; color:var(--fg); margin-bottom:24px; }
  .brand .dot { width:12px; height:12px; border-radius:50%; background:var(--jungle); box-shadow:0 0 0 4px rgba(48,186,120,.2); }
  .sandbox { display:flex; gap:10px; align-items:flex-start; background:rgba(252,178,68,.1); border:1px solid rgba(252,178,68,.35); color:#ffdca0; border-radius:12px; padding:12px 14px; font-size:13.5px; margin-bottom:28px; }
  .sandbox strong { color:var(--warn); }
  h1 { font-size:30px; font-weight:800; margin:0 0 6px; letter-spacing:-.02em; }
  .lede { color:var(--muted); margin:0 0 28px; max-width:60ch; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--mint); margin:34px 0 12px; font-weight:700; }
  .personas { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; }
  .persona { display:flex; flex-direction:column; gap:2px; text-decoration:none; color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:12px; padding:15px; transition:border-color .15s, transform .05s, background .15s; }
  .persona:hover { border-color:var(--jungle); background:#0e3a32; }
  .persona:active { transform:translateY(1px); }
  .persona-role { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--jungle); font-weight:800; }
  .persona-name { font-weight:700; margin-top:2px; }
  .persona-email { color:var(--muted); font-size:12.5px; font-family:'SUSE Mono',ui-monospace,monospace; }
  .persona-groups { color:var(--muted); font-size:11.5px; margin-top:6px; opacity:.8; }
  .tool { margin:14px 0 8px; }
  .tool-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:2px; }
  .tool-id { background:transparent; border:0; color:var(--jungle); font-weight:700; font-size:14px; padding:0; }
  .tool-blurb { color:var(--muted); font-size:13px; }
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
  footer { margin-top:44px; color:var(--muted); font-size:12.5px; opacity:.8; }
  a { color:var(--jungle); }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="dot"></span> Lolly · SUSE control plane</div>
  <div class="sandbox">
    <span>⚠️</span>
    <div><strong>Public testing sandbox.</strong> Sign-in is passwordless — anyone can enter as any persona, including admin. State is in-memory and resets on redeploy. Do not put anything real or sensitive here.</div>
  </div>

  <h1>${name}</h1>
  <p class="lede">The Lolly control plane — governed catalog, policy, approvals, telemetry, and an on-device render path — running as a hosted demo. Pick a persona to sign in.</p>

  <h2>Sign in as a demo persona</h2>
  <div class="personas">${personaCards || '<p class="lede">No dev personas configured.</p>'}</div>

  <h2>Or jump straight in</h2>
  <div class="row">
    <a class="btn" href="/admin">Open the admin console</a>
    <a class="btn secondary" href="/healthz">Health check</a>
  </div>

  <h2>Live renders (the MCP GET endpoint)</h2>
  <p class="lede" style="margin-bottom:10px">Every catalog tool renders over a plain <code>GET /render/&lt;tool&gt;.&lt;format&gt;?params</code> — the same URL an agent or an <code>&lt;img&gt;</code> tag hits. Change the params to reshape the output; click any to open it:</p>
  ${renderGroups}

  <footer>Powered by the Lolly engine · governed deployment · <a href="/admin">console</a></footer>
</div>
</body>
</html>`;
}
