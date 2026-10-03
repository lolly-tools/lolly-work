/**
 * The /activate page (plans/34 wave 4) - where a person confirms a device
 * code. Server-rendered, script-free, same posture as links/collection-page.ts:
 * our own markup, inline style only, nothing loadable from anywhere else. The
 * form is the whole interface - approval is a personal act performed by the
 * signed-in person typing the code, which is why this page exists instead of a
 * console button.
 */

/** Text for HTML: every server page puts names, notes and addresses
 *  through this, never into markup as they are. */
export const esc = (s: string): string =>
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
  h2 { font-size: 1.05rem; margin: 20px 0 4px; }
  button { min-height: 44px; }
  textarea.field { font: inherit; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 9px 12px; border-radius: 8px;
         border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); background: Field; color: FieldText;
         min-height: 5rem; resize: vertical; }
  a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0);
         white-space: nowrap; border: 0; }
  form.stack { margin: 10px 0; }
  form.stack button { width: 100%; max-width: 20rem; }
  .addr { overflow-wrap: anywhere; }
`;

/** An action link drawn as a button, 44px tall for a finger. */
export const LINK_STYLE = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 18px;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 30%, transparent);text-decoration:none';

/**
 * Every server page: English (plans/75 C20), one h1, the workspace name
 * under it, inline style only and no script. `title` replaces the default
 * "<heading> - <workspace>" where the heading would say too much, as on the
 * invite pages, whose title never names a project or a person.
 */
export function serverPage(instanceName: string, body: string, heading: string, opts: { title?: string } = {}): string {
  return page(instanceName, body, heading, opts.title);
}

/** A link drawn as a button. */
export function actionLink(href: string, label: string): string {
  return `<p style="margin-top:16px"><a href="${esc(href)}" style="${LINK_STYLE}">${esc(label)}</a></p>`;
}

/** One form that posts `fields` (hidden) with a single button, full width
 *  on a phone. `extra` is markup placed above the button, built by the
 *  caller from escaped parts. */
export function postForm(o: {
  action: string; fields: Record<string, string>; label: string; primary?: boolean; extra?: string;
}): string {
  const hidden = Object.entries(o.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<form class="stack" method="post" action="${esc(o.action)}">${hidden}${o.extra ?? ''}`
    + `<button${o.primary ? ' class="primary"' : ''} type="submit">${esc(o.label)}</button></form>`;
}

/** The note field of a request form: optional, at most 280 characters. */
export function noteField(id: string): string {
  return `<label class="field" for="${esc(id)}">Add a note (optional)</label>`
    + `<textarea class="field" id="${esc(id)}" name="note" maxlength="280" rows="3"></textarea>`;
}

/** A masked address as it is seen, beside the words a screen reader says
 *  instead ("an address at suse.com that starts with an"). */
export function maskedAddress(masked: string, spoken: string): string {
  return `<span class="tag addr" aria-hidden="true">${esc(masked)}</span><span class="sr-only">${esc(spoken)}</span>`;
}

function page(instanceName: string, body: string, heading = 'Connect a device', title?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title ?? `${heading} - ${instanceName}`)}</title>
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
export function idpChooserHtml(
  instanceName: string, entries: Array<{ href: string; label: string }>, opts: { inviteOnly?: boolean } = {},
): string {
  // Full width of the card up to 20rem, padding included, so a 360px phone
  // never scrolls sideways; 44px tall like every other action here.
  const buttons = entries.map((e) =>
    `<p style="margin:.5rem 0"><a href="${esc(e.href)}" style="${LINK_STYLE};box-sizing:border-box;width:100%;max-width:20rem;text-align:center">${esc(e.label)}</a></p>`).join('\n');
  // On an invite-only workspace most refusals are a person who picked the
  // wrong account, so the chooser says which one to pick (plans/75 5.10).
  return page(instanceName, `
<div class="card">
<p>Choose where you sign in.${opts.inviteOnly ? ' Use the account your invitation went to.' : ''}</p>
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

/** Why a verified sign-in was refused (iam/admission.ts). */
export type RefusalReason = 'disabled' | 'hosted-domain' | 'tenant' | 'email-unverified' | 'not-invited';

/**
 * The "Ask to join" part of the refusal page, worked out by the caller
 * (plans/74 invite spec 3.6). `off`: join requests are switched off, so the
 * page says who to ask instead. `form`: the note and the button. `open`: a
 * request is waiting, with a way to withdraw it. `declined`: an admin said
 * no in the last week, and the form stays hidden until `againAfter`. `ask`
 * is the signed `lw/ask` token and `csrf` the form nonce.
 */
export type JoinAsk =
  | { state: 'off' }
  | { state: 'form'; ask: string; csrf: string }
  | { state: 'open'; ask: string; csrf: string; askedAgo: string }
  | { state: 'declined'; on: string; againAfter: string };

/** The sign-in refusal (plans/74 W-ID-1, invite spec 3.6): served with a 403
 *  when a verified sign-in is not admitted. The workspace name comes first.
 *  Names the account, and the sign-in it came through, so a person who
 *  picked the wrong one in a browser full of accounts can see it, says what
 *  to do next, and offers a way to pick another account (empty `switchHref`:
 *  no link, as behind a sign-in proxy only the proxy can switch accounts).
 *  For a person who is simply not invited, `join` adds "Ask to join". Never
 *  says which emails or domains are listed. */
export function admissionRefusedHtml(
  instanceName: string,
  opts: { email: string; reason: RefusalReason; switchHref: string; provider?: string | null; github?: boolean; join?: JoinAsk },
): string {
  const name = instanceName;
  const why = {
    'not-invited': `This account is not on ${name} yet. If your invitation went to another address, sign in with that account.`,
    'email-unverified': 'Your identity provider has not confirmed this email address, so it cannot be used to sign in here. Confirm the address with your provider, or ask an admin to invite you.',
    'hosted-domain': 'This account does not belong to the organisation this workspace accepts. Sign in with your work account instead.',
    tenant: 'This account does not belong to the organisation this workspace accepts. Sign in with your work account instead.',
    disabled: `This account is turned off on ${name}. Ask an admin if you think this is a mistake.`,
  }[opts.reason];
  const notInvited = opts.reason === 'not-invited';
  const join = notInvited ? opts.join : undefined;
  return page(name, `
<div class="card">
<p>You signed in as <strong class="tag addr">${esc(opts.email)}</strong>${opts.provider ? ` (${esc(opts.provider)})` : ''}.</p>
<p>${esc(why)}</p>
${notInvited && opts.github ? `<p class="muted">GitHub shares every verified address on your account with ${esc(name)}, so add and verify the invited address there if it is missing.</p>` : ''}
${opts.switchHref ? actionLink(opts.switchHref, 'Use a different account') : ''}
${join?.state === 'off' ? '<p class="muted" style="margin-top:16px">Ask the person who invited you to invite this address.</p>' : ''}
</div>
${join && join.state !== 'off' ? joinCard(name, opts.email, join) : ''}`, notInvited ? `${name} is invite only` : `You cannot sign in to ${name}`, `Sign in - ${name}`);
}

function joinCard(name: string, email: string, join: Exclude<JoinAsk, { state: 'off' }>): string {
  const body = join.state === 'form'
    ? `<p>Ask the admins of ${esc(name)} to let <span class="addr">${esc(email)}</span> in.</p>`
      + postForm({ action: '/api/auth/request', fields: { ask: join.ask, csrf: join.csrf, action: 'join' }, label: 'Ask to join', primary: true, extra: noteField('ask-note') })
    : join.state === 'open'
      ? `<p>You asked to join ${esc(join.askedAgo)}. An admin of ${esc(name)} has not answered yet. Sign in again later to check.</p>`
        + postForm({ action: '/api/auth/request', fields: { ask: join.ask, csrf: join.csrf, action: 'withdraw' }, label: 'Withdraw request' })
      : `<p>An admin of ${esc(name)} did not approve your request on ${esc(join.on)} (UTC). You can ask again after ${esc(join.againAfter)}.</p>`;
  return `<div class="card"><h2>Ask to join</h2>${body}</div>`;
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
  opts: {
    returnTo: string; csrf: string; email?: string; error?: string; otherHref?: string;
    /** From an invite page: the invited address, masked, which the person
     *  types here themselves (plans/74 invite spec 2.9). */
    invitedAddress?: { masked: string; spoken: string };
  },
): string {
  // A role=alert that arrives with the page is not reliably read out, so the
  // field that gets focus points at the error and says it is invalid.
  const invalid = opts.error ? ' aria-invalid="true" aria-describedby="pw-err"' : '';
  return page(instanceName, `
<div class="card">
${opts.invitedAddress ? `<p>Use the address your invitation went to: ${maskedAddress(opts.invitedAddress.masked, opts.invitedAddress.spoken)}</p>` : ''}
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

/** Longest name the set-password page keeps (plans/74 invite spec, g1). */
export const ACCOUNT_NAME_MAX = 80;

/** The page a one-time sign-in link opens (plans/74): the address the link
 *  was issued for, read-only, the person's name (optional; it is how
 *  people, presence and notices name them, instead of an address), and a
 *  new password twice. `returnTo` is where the person goes once signed in:
 *  the project an invite link was for, else the app. `name` refills the
 *  field after an error; `nameError` marks the name as what was wrong. */
export function passwordSetHtml(
  instanceName: string,
  opts: {
    token: string; csrf: string; email: string; purpose: 'setup' | 'reset'; minLength: number; error?: string;
    returnTo?: string; name?: string; nameError?: boolean;
  },
): string {
  const heading = opts.purpose === 'reset' ? 'Choose a new password' : 'Set your password';
  const err = !!opts.error;
  const pwErr = err && !opts.nameError;
  // The first field to fill: the name on a new account, unless the
  // password is what needs fixing.
  const focusName = !!opts.nameError || (!err && opts.purpose === 'setup');
  return page(instanceName, `
<div class="card">
<p>${opts.purpose === 'reset'
    ? 'Choose a new password for this address. It replaces the old one.'
    : `Choose a password for <span class="addr">${esc(opts.email)}</span>. From now on you sign in with this address and this password.`}</p>
${err ? `<p class="err" role="alert" id="pw-err">${esc(opts.error!)}</p>` : ''}
<form method="post" action="/api/auth/password/set">
<input type="hidden" name="csrf" value="${esc(opts.csrf)}">
<input type="hidden" name="token" value="${esc(opts.token)}">
${opts.returnTo ? `<input type="hidden" name="returnTo" value="${esc(opts.returnTo)}">` : ''}
<label class="field" for="pw-email">Email</label>
<input class="field" id="pw-email" type="email" name="email" value="${esc(opts.email)}" autocomplete="username" readonly>
<label class="field" for="pw-name">Your name (optional)</label>
<input class="field" id="pw-name" type="text" name="name" value="${esc(opts.name ?? '')}" autocomplete="name" maxlength="${ACCOUNT_NAME_MAX}"${focusName ? ' autofocus' : ''}${opts.nameError ? ' aria-invalid="true" aria-describedby="pw-err pw-name-hint"' : ' aria-describedby="pw-name-hint"'}>
<p class="muted" id="pw-name-hint">How people on ${esc(instanceName)} see you, for example on a project's people list.${opts.purpose === 'reset' ? ' Leave it empty to keep the name you have.' : ''}</p>
<label class="field" for="pw-new">New password</label>
<input class="field" id="pw-new" type="password" name="password" autocomplete="new-password" minlength="${opts.minLength}" required${focusName ? '' : ' autofocus'}${pwErr ? ' aria-invalid="true" aria-describedby="pw-err pw-hint"' : ' aria-describedby="pw-hint"'}>
<p class="muted" id="pw-hint">At least ${opts.minLength} characters. A few words you can remember work well.</p>
<label class="field" for="pw-confirm">New password again</label>
<input class="field" id="pw-confirm" type="password" name="confirm" autocomplete="new-password" minlength="${opts.minLength}" required${pwErr ? ' aria-describedby="pw-err"' : ''}>
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
