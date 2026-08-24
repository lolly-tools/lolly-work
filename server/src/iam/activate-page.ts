/**
 * The /activate page (plans/34 wave 4) - where a person confirms a device
 * code. Server-rendered, script-free, same posture as links/collection-page.ts:
 * our own markup, inline style only, nothing loadable from anywhere else. The
 * form is the whole interface - approval is a personal act performed by the
 * signed-in person typing the code, which is why this page exists instead of a
 * console button.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SHELL_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 16px; display: grid; justify-items: center;
         background: Canvas; color: CanvasText; }
  main { max-width: 26rem; width: 100%; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .muted { opacity: .7; font-size: .9rem; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 20px 22px; margin-top: 16px; }
  .tag { font-family: ui-monospace, monospace; font-size: .85rem; opacity: .8; }
  input[type=text] { font: 1.4rem ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase;
         width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
         border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: Field; color: FieldText; }
  .row { display: flex; gap: 10px; margin-top: 14px; }
  button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
         background: ButtonFace; color: ButtonText; cursor: pointer; }
  button.primary { background: color-mix(in srgb, CanvasText 85%, Canvas); color: Canvas; border-color: transparent; }
  a { color: inherit; }
`;

function page(instanceName: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect a device - ${esc(instanceName)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<main>
<h1>Connect a device</h1>
<p class="muted">${esc(instanceName)}</p>
${body}
</main>
</body>
</html>`;
}

export function activateSignedOutHtml(instanceName: string, loginHref: string): string {
  return page(instanceName, `
<div class="card">
<p>A device is asking to sign in as you. Sign in here first, then confirm its code.</p>
<p><a href="${esc(loginHref)}">Sign in to continue</a></p>
</div>`);
}

export function activateFormHtml(
  instanceName: string,
  opts: { code?: string; clientTag?: string; requestedAt?: string; error?: string },
): string {
  const known = opts.clientTag || opts.requestedAt;
  return page(instanceName, `
<div class="card">
<p>Approving signs the device in <strong>as you</strong>. Only confirm a code you are reading off your own screen.</p>
${opts.error ? `<p><strong>${esc(opts.error)}</strong></p>` : ''}
${known ? `<p class="muted">Asking: <span class="tag">${esc(opts.clientTag ?? 'unidentified client')}</span>${opts.requestedAt ? ` · requested ${esc(opts.requestedAt.slice(11, 16))} UTC` : ''}</p>` : ''}
<form method="post" action="/activate">
<input type="text" name="code" value="${esc(opts.code ?? '')}" placeholder="XXXX-XXXX" autocomplete="off" autofocus
  aria-label="Device code" required>
<div class="row">
<button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
</div>`);
}

export function activateDoneHtml(instanceName: string, outcome: 'approved' | 'denied' | 'unknown'): string {
  const copy = {
    approved: 'Approved. The device signs in as you on its next check - you can close this page.',
    denied: 'Denied. The device gets a refusal on its next check and the code is dead.',
    unknown: 'That code is unknown, expired, or already settled. Codes live ten minutes - ask the device for a fresh one.',
  }[outcome];
  return page(instanceName, `<div class="card"><p>${copy}</p></div>`);
}
