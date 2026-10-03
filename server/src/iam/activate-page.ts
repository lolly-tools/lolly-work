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
  label.field { display: block; margin-top: 14px; font-size: .9rem; }
  input.field { font: inherit; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 9px 12px; border-radius: 8px;
         border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: Field; color: FieldText; }
  input.field[readonly] { background: transparent; }
  .err { border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 8px; padding: 8px 12px; }
`;

/** An action link drawn as a button, 44px tall for a finger. */
const LINK_STYLE = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 18px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 30%, transparent);text-decoration:none';

function page(instanceName: string, body: string, heading = 'Connect a device'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(heading)} - ${esc(instanceName)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<main>
<h1>${esc(heading)}</h1>
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

/** The IdP chooser (plans/36 §3): served by /api/auth/login when several
 *  houses are configured and none was named. Script-free like everything on
 *  this page; the buttons are ordinary links carrying ?idp= + returnTo, so
 *  the OSS shell's gate and the console gate get multi-IdP with zero client
 *  changes - their one sign-in link simply arrives here first. */
export function idpChooserHtml(instanceName: string, entries: Array<{ href: string; label: string }>): string {
  // Full width of the card up to 20rem, padding included, so a 360px phone
  // never scrolls sideways; 44px tall like every other action here.
  const buttons = entries.map((e) =>
    `<p style="margin:.5rem 0"><a href="${esc(e.href)}" style="${LINK_STYLE};box-sizing:border-box;width:100%;max-width:20rem;text-align:center">${esc(e.label)}</a></p>`).join('\n');
  return page(instanceName, `
<div class="card">
<p>Choose where you sign in.</p>
${buttons}
</div>`, 'Sign in');
}

export function activateDoneHtml(instanceName: string, outcome: 'approved' | 'denied' | 'unknown'): string {
  const copy = {
    approved: 'Approved. The device signs in as you on its next check - you can close this page.',
    denied: 'Denied. The device gets a refusal on its next check and the code is dead.',
    unknown: 'That code is unknown, expired, or already settled. Codes live ten minutes - ask the device for a fresh one.',
  }[outcome];
  return page(instanceName, `<div class="card"><p>${copy}</p></div>`);
}

/** The sign-in refusal (plans/74 W-ID-1): served with a 403 when a verified
 *  sign-in is not admitted. Names the account so a person who picked the wrong
 *  one in a browser full of accounts can see it, says what to do, and offers a
 *  way to pick another account (empty `switchHref`: no link, as behind a
 *  sign-in proxy only the proxy can switch accounts). Never says which emails or domains are listed. */
export function admissionRefusedHtml(
  instanceName: string,
  opts: { email: string; reason: 'disabled' | 'hosted-domain' | 'tenant' | 'email-unverified' | 'not-invited'; switchHref: string },
): string {
  const why = {
    'not-invited': 'This account has not been invited to this workspace. Ask an owner to invite you, then sign in again.',
    'email-unverified': 'Your identity provider has not confirmed this email address, so it cannot be used to sign in here. Confirm the address with your provider, or ask an owner to invite you.',
    'hosted-domain': 'This account does not belong to the organisation this workspace accepts. Sign in with your work account instead.',
    tenant: 'This account does not belong to the organisation this workspace accepts. Sign in with your work account instead.',
    disabled: 'This account has been disabled here. Ask an owner if you think this is a mistake.',
  }[opts.reason];
  return page(instanceName, `
<div class="card">
<p>You signed in as <strong class="tag" style="overflow-wrap:anywhere">${esc(opts.email)}</strong>.</p>
<p>${esc(why)}</p>
${opts.switchHref ? `<p style="margin-top:16px"><a href="${esc(opts.switchHref)}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 18px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 30%, transparent);text-decoration:none">Use a different account</a></p>` : ''}
</div>`, 'You cannot sign in here yet');
}

/** A sign-in that could not finish for a reason other than admission: the
 *  provider refused the code, could not be reached, sent no usable email, or
 *  the sign-in state expired. Same phone-friendly card as the refusal page,
 *  with one way to start again. The message is ours, never the provider's. */
export function signInErrorHtml(
  instanceName: string,
  opts: { message: string; retryHref: string; heading?: string; retryLabel?: string },
): string {
  return page(instanceName, `
<div class="card">
<p>${esc(opts.message)}</p>
${opts.retryHref ? `<p style="margin-top:16px"><a href="${esc(opts.retryHref)}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 18px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 30%, transparent);text-decoration:none">${esc(opts.retryLabel ?? 'Try again')}</a></p>` : ''}
</div>`, opts.heading ?? 'Sign-in did not finish');
}

/** The email and password form (plans/74), served by /api/auth/login for a
 *  `kind: "password"` entry. Script-free like the rest of this file. `csrf`
 *  is the value the signed form cookie carries; `otherHref` leads back to
 *  the chooser when other sign-ins exist. The password is never echoed. */
export function passwordLoginHtml(
  instanceName: string,
  opts: { returnTo: string; csrf: string; email?: string; error?: string; otherHref?: string },
): string {
  // A role=alert that arrives with the page is not reliably read out, so the
  // field that gets focus points at the error and says it is invalid.
  const invalid = opts.error ? ' aria-invalid="true" aria-describedby="pw-err"' : '';
  return page(instanceName, `
<div class="card">
${opts.error ? `<p class="err" role="alert" id="pw-err">${esc(opts.error)}</p>` : ''}
<form method="post" action="/api/auth/password/login">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="returnTo" value="${esc(opts.returnTo)}">
<label class="field" for="pw-email">Email</label>
<input class="field" id="pw-email" type="email" name="email" value="${esc(opts.email ?? '')}" autocomplete="username" required${opts.email ? '' : ` autofocus${invalid}`}>
<label class="field" for="pw-password">Password</label>
<input class="field" id="pw-password" type="password" name="password" autocomplete="current-password" required${opts.email ? ` autofocus${invalid}` : ''}>
<div class="row"><button class="primary" type="submit">Sign in</button></div>
</form>
<p class="muted" style="margin-top:16px">No password yet, or forgot it? Ask the person who invited you for a sign-in link.</p>
${opts.otherHref ? `<p style="margin-top:16px"><a href="${esc(opts.otherHref)}" style="${LINK_STYLE}">Other ways to sign in</a></p>` : ''}
</div>`, 'Sign in');
}

/** The page a one-time sign-in link opens (plans/74): the address the link
 *  was issued for, read-only, and a new password twice. */
export function passwordSetHtml(
  instanceName: string,
  opts: { token: string; csrf: string; email: string; purpose: 'setup' | 'reset'; minLength: number; error?: string },
): string {
  const heading = opts.purpose === 'reset' ? 'Choose a new password' : 'Set your password';
  const err = !!opts.error;
  return page(instanceName, `
<div class="card">
<p>${opts.purpose === 'reset' ? 'Choose a new password for this address. It replaces the old one.' : 'Choose a password. From now on you sign in with this email address and this password.'}</p>
${err ? `<p class="err" role="alert" id="pw-err">${esc(opts.error!)}</p>` : ''}
<form method="post" action="/api/auth/password/set">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="token" value="${esc(opts.token)}">
<label class="field" for="pw-email">Email</label>
<input class="field" id="pw-email" type="email" name="email" value="${esc(opts.email)}" autocomplete="username" readonly>
<label class="field" for="pw-new">New password</label>
<input class="field" id="pw-new" type="password" name="password" autocomplete="new-password" minlength="${opts.minLength}" required autofocus${err ? ' aria-invalid="true" aria-describedby="pw-err pw-hint"' : ' aria-describedby="pw-hint"'}>
<p class="muted" id="pw-hint">At least ${opts.minLength} characters. A few words you can remember work well.</p>
<label class="field" for="pw-confirm">New password again</label>
<input class="field" id="pw-confirm" type="password" name="confirm" autocomplete="new-password" minlength="${opts.minLength}" required${err ? ' aria-describedby="pw-err"' : ''}>
<div class="row"><button class="primary" type="submit">Save password and sign in</button></div>
</form>
</div>`, heading);
}

/** A sign-in link that is unknown, used or expired. Says nothing about which. */
export function passwordLinkDeadHtml(instanceName: string, loginHref: string): string {
  return page(instanceName, `
<div class="card">
<p>A sign-in link works once, for seven days. Ask the person who sent it for a new one.</p>
<p>If you have already set your password, sign in with it.</p>
<p style="margin-top:16px"><a href="${esc(loginHref)}" style="${LINK_STYLE}">Sign in</a></p>
</div>`, 'This link no longer works');
}
