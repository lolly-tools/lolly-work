// SPDX-License-Identifier: MPL-2.0
/**
 * The server pages of invite links and sign-in requests (plans/74 invite
 * spec section 3, plans/75 5.9): the invite page in each of its states, the
 * wrong-account pages, and the pages a request form answers with. Pure HTML
 * builders over a view the routes work out (access/invite-routes.ts and the
 * callback in api/app.ts), in the style of iam/activate-page.ts: English
 * (plans/75 C20), one h1, labelled fields, 44px buttons, no script, inline
 * style only.
 *
 * What an invite page never shows: the full invited address (only the mask,
 * with words for a screen reader), an inviter's address, any `og:` or
 * `twitter:` tag, or a project name in the title, which is always
 * "Invitation to <workspace>". A link can be forwarded or unfurled by a chat
 * preview, so the page says no more than the person needs to sign in.
 * Every name, project and note goes through `esc()`.
 */
import { actionLink, esc, maskedAddress, noteField, postForm, serverPage } from '../iam/activate-page.ts';
import { providerIcon } from '../iam/provider-icons.ts';
import type { ProjectMemberRole } from '../store/types.ts';
import { maskEmail, maskEmailSpoken } from './mask.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "2 Nov" in UTC, with the year when it is not this year's. */
export function utcDay(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const year = d.getUTCFullYear() !== new Date(nowMs).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

/** "in 30 days", "3 hours ago" or "just now". Days are rounded, so an
 *  invitation made a moment ago for 30 days still ends "in 30 days". */
export function relativeTime(iso: string, nowMs: number): string {
  const diff = (Date.parse(iso) - nowMs) / 1000;
  const s = Math.abs(diff);
  if (s < MINUTE) return 'just now';
  const [n, unit] = s < HOUR ? [Math.floor(s / MINUTE), 'minute']
    : s < DAY ? [Math.floor(s / HOUR), 'hour']
      : [Math.round(s / DAY), 'day'];
  const span = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** A sign-in the page offers: the idp id it posts and the name on the button. */
export interface SignInChoice { idp: string; label: string; provider?: string; pending?: boolean }

/** What every invite page knows about the invitation it was opened for. */
export interface InviteView {
  /** `instance.name`, first wherever it appears (plans/75 C6). */
  workspace: string;
  /** The token the page was opened with, posted back by its forms. */
  token: string;
  /** The person who invited, by name only; null names nobody. */
  inviter: string | null;
  /** The project this link is for; null for a workspace link (or a project
   *  since archived, shown as a workspace invitation). */
  project: { name: string; role: ProjectMemberRole } | null;
  /** The invited address. Pages show it masked only. */
  email: string;
  expiresAt?: string;
  now: number;
}

const title = (v: { workspace: string }): string => `Invitation to ${v.workspace}`;
const target = (v: InviteView): string => v.project?.name ?? v.workspace;
const mask = (email: string): string => maskedAddress(maskEmail(email), maskEmailSpoken(email));
/** "Andy" or, when nobody can be named, "an admin of lolly.ing". */
const asker = (v: InviteView): string => v.inviter ?? `an admin of ${v.workspace}`;
const capital = (s: string): string => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);
const card = (inner: string): string => `<div class="card">${inner}</div>`;

/** The heading of a pending invitation. */
function invitedHeading(v: InviteView): string {
  return v.inviter ? `${v.inviter} invited you to ${target(v)}` : `You are invited to ${target(v)}`;
}

/** What the role lets the person do, or what the workspace is (3.2). */
function roleLine(v: InviteView): string {
  const w = esc(v.workspace);
  if (!v.project) return `${w} is a private Lolly workspace. Once you are in, projects people share with you appear in Projects.`;
  const p = esc(v.project.name);
  switch (v.project.role) {
    case 'editor': return `On ${w}, as an Editor. Editors can open and save work in ${p}.`;
    case 'manager': return `On ${w}, as a Manager. Managers can also add people to ${p}.`;
    default: return `On ${w}, as a Viewer. Viewers can open work in ${p} and make their own copy.`;
  }
}

function endLine(v: InviteView): string {
  return v.expiresAt
    ? `<p class="muted">Ends ${esc(relativeTime(v.expiresAt, v.now))} (${esc(utcDay(v.expiresAt, v.now))}, UTC).</p>`
    : '';
}

const startForm = (v: InviteView, csrf: string, choice: SignInChoice, opts: { prompt?: boolean; primary?: boolean } = {}): string =>
  choice.pending ? `<p class="stack"><button class="auth-provider" type="button" disabled>${providerIcon(choice.provider ?? choice.label)}<span>${esc(choice.label)}</span><span class="auth-pending">(pending)</span></button></p>` : postForm({
    provider: choice.provider,
    action: '/api/auth/invite',
    fields: { token: v.token, csrf, action: 'start', idp: choice.idp, ...(opts.prompt ? { prompt: 'select_account' } : {}) },
    label: choice.label, ...(opts.primary ? { primary: true } : {}),
  });

/**
 * The invite page for someone not signed in (3.2). `passwordSetup`: the
 * link may set a password for the address now, which comes first.
 * `passwordSignIn`: the address already has a password, so it signs in
 * with it. `inAppUrl`: the page is open inside another app's browser,
 * where Google sign-in can fail, so the link is offered to copy.
 */
export function invitePageHtml(v: InviteView, o: {
  csrf: string;
  choices: SignInChoice[];
  passwordSetup: boolean;
  passwordSignIn: SignInChoice | null;
  github: boolean;
  inviteNote?: string;
  inAppUrl?: string;
  error?: 'password' | 'expired';
}): string {
  const err = o.error === 'password'
    ? `This invitation can no longer set a password. Sign in another way, or ask ${asker(v)} for a sign-in link.`
    : o.error === 'expired' ? 'This page expired. Choose how to sign in again.' : '';
  const masked = mask(v.email);
  const buttons = [
    o.passwordSetup
      ? postForm({ action: '/api/auth/invite', fields: { token: v.token, csrf: o.csrf, action: 'password' }, label: 'Set a password', primary: true })
        + `<p class="muted">You then sign in with ${masked} and that password.</p>`
      : '',
    ...o.choices.map((c) => startForm(v, o.csrf, c, { primary: !o.passwordSetup && c === o.choices[0] })),
    o.passwordSignIn ? startForm(v, o.csrf, o.passwordSignIn) : '',
  ].join('');
  return serverPage(v.workspace, `
${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
${card(`<p>${roleLine(v)}</p>
<p>Sign in with the address this invitation was sent to: ${masked}</p>
${endLine(v)}
${buttons}
${o.github ? `<p class="muted">Using GitHub? ${esc(v.workspace)} checks every verified address on your GitHub account. If GitHub signs you in as someone else, sign out at github.com first.</p>` : ''}
${o.inviteNote ? `<p class="muted">${esc(o.inviteNote)}</p>` : ''}`)}
${o.inAppUrl ? card(`<p>This page is open inside another app, where Google sign-in can fail. Open the link in Safari or Chrome.</p>
<label class="field" for="invite-url">Link to open</label>
<input class="field" id="invite-url" type="text" value="${esc(o.inAppUrl)}" readonly>`) : ''}
<p class="muted">Not expecting this? You can ignore this page.</p>`, invitedHeading(v), { title: title(v) });
}

/** Signed in with an account that holds the invited address (3.3): one button. */
export function inviteJoinHtml(v: InviteView, o: { csrf: string; signedInAs: string }): string {
  return serverPage(v.workspace, card(`<p>${roleLine(v)}</p>
<p>You are signed in as <span class="tag addr">${esc(o.signedInAs)}</span>.</p>
${endLine(v)}
${postForm({ action: '/api/auth/invite', fields: { token: v.token, csrf: o.csrf, action: 'join' }, label: v.project ? `Join ${v.project.name}` : 'Accept invitation', primary: true })}`),
  invitedHeading(v), { title: title(v) });
}

/** What an ask form needs, and what was asked before (`requestStateFor`). */
export interface SwitchAsk {
  ask: string;
  csrf: string;
  /** When an open request was filed, as "2 hours ago". */
  askedAgo?: string;
  /** An answer of no in the last week. */
  declined?: boolean;
}

/** The "ask to use this account" part, in each state (3.3 and 3.5). */
function switchAskBody(v: InviteView, a: SwitchAsk, lead: string): string {
  const who = asker(v);
  if (a.askedAgo) {
    return `<p>You asked ${esc(a.askedAgo)}. ${esc(capital(who))} has not answered yet.</p>`
      + postForm({ action: '/api/auth/request', fields: { ask: a.ask, csrf: a.csrf, action: 'withdraw' }, label: 'Withdraw request' });
  }
  if (a.declined) return `<p>${esc(capital(who))} did not approve your last request.</p>`;
  return `<p>${lead}</p>`
    + postForm({
      action: '/api/auth/request', fields: { ask: a.ask, csrf: a.csrf, action: 'switch' },
      label: v.inviter ? `Ask ${v.inviter}` : 'Ask an admin', primary: true, extra: noteField('ask-note'),
    });
}

/**
 * Signed in, but as an account that does not hold the invited address
 * (3.3), whether the person arrived signed in or signed in from the page
 * with another account that this workspace admits anyway. The sign-ins
 * again, each asking for the account picker; the ask to use this account,
 * when it would give the person something; and the way on as they are.
 */
export function inviteOtherAccountHtml(v: InviteView, o: {
  csrf: string; signedInAs: string; choices: SignInChoice[]; ask: SwitchAsk | null;
}): string {
  const who = esc(asker(v));
  return serverPage(v.workspace, `${card(`<p>You are signed in to ${esc(v.workspace)} as <span class="tag addr">${esc(o.signedInAs)}</span>. This invitation is for ${mask(v.email)}.</p>
<h2>Use a different account</h2>
${o.choices.map((c) => startForm(v, o.csrf, c, { prompt: true })).join('')}`)}
${o.ask ? card(`<h2>Use this account instead?</h2>${switchAskBody(v, o.ask,
    `Ask ${who} to give <span class="addr">${esc(o.signedInAs)}</span> the access this invitation gives.`)}`) : ''}
${actionLink('/', `Continue as ${o.signedInAs}`)}`, 'You are signed in as another account', { title: title(v) });
}

/**
 * The sign-in just made is not the invited account, and this workspace
 * does not admit it (3.5, a 403 from the callback). No account was written.
 * The way back is the same sign-in with the account picker, or the invite
 * page; the ask is a request the inviter or an admin answers (plans/75 C1).
 */
export function wrongAccountHtml(v: InviteView, o: {
  csrf: string; signedInAs: string; provider: string; idp: string; github: boolean; ask: SwitchAsk;
}): string {
  const whose = v.inviter ? `${esc(v.inviter)}'s invitation` : 'The invitation';
  const masked = mask(v.email);
  return serverPage(v.workspace, `${card(`<p>You signed in as <span class="tag addr">${esc(o.signedInAs)}</span> with ${esc(o.provider)}. ${whose} was sent to ${masked}.</p>
${o.github ? `<p class="muted">GitHub shares every verified address on your account with ${esc(v.workspace)}. If ${masked} is your address, add and verify it in your GitHub email settings, then try again.</p>` : ''}
${startForm(v, o.csrf, { idp: o.idp, label: 'Use a different account' }, { prompt: true, primary: true })}
${actionLink(`/l/invite/${v.token}`, 'Other ways to sign in')}`)}
${card(`<h2>Or ask to use this account</h2>${switchAskBody(v, o.ask,
    `${esc(capital(asker(v)))} decides whether <span class="addr">${esc(o.signedInAs)}</span> can use this invitation.`)}`)}`,
  'This is not the invited account', { title: title(v) });
}

/** The invitation was accepted by the account reading the page (3.3). */
export function inviteAlreadyInHtml(v: InviteView, o: { openHref: string }): string {
  return serverPage(v.workspace, card(actionLink(o.openHref, `Open ${target(v)}`)), 'You are already in', { title: title(v) });
}

/** The invitation was accepted, by someone else or by an account not signed in here (3.3). */
export function inviteUsedHtml(v: InviteView, o: { signInHref: string }): string {
  return serverPage(v.workspace, card(`<p>Sign in with the account that accepted the invitation.</p>${actionLink(o.signInHref, 'Sign in')}`),
    'This invitation was already used', { title: title(v) });
}

/** A pending invitation past its end (3.4, a 410). The signature proves the
 *  token is ours, so naming the inviter tells a stranger nothing. */
export function inviteEndedHtml(v: InviteView & { expiresAt: string }): string {
  const whose = v.inviter ? `${v.inviter}'s invitation` : 'The invitation';
  const ask = v.inviter ? `Ask ${v.inviter} for a new link.` : 'Ask the person who invited you for a new link.';
  return serverPage(v.workspace, card(`<p>${esc(whose)} to ${esc(target(v))} ended on ${esc(utcDay(v.expiresAt, v.now))} (UTC). ${esc(ask)}</p>`),
    'This invitation has ended', { title: title(v) });
}

/** One page, byte for byte, for an unknown, malformed, revoked or replaced
 *  token (3.4, a 410), so the page says nothing about which. */
export function inviteDeadHtml(workspace: string): string {
  return serverPage(workspace, card(`<p>The invitation was withdrawn or replaced by a newer link. If you were sent a newer link, open that one.</p>
${actionLink('/api/auth/login', 'Sign in')}`), 'This link no longer works', { title: title({ workspace }) });
}

const BACK_TO_SIGN_IN = '/api/auth/login?prompt=select_account';

/**
 * What a request form answers (3.7), the same page whether the request was
 * filed, was already open, or was held by a cap. `emailOn`: the workspace
 * emails people, so the page can say it will.
 */
export function requestSentHtml(workspace: string, o:
  | { kind: 'join'; email: string; emailOn: boolean }
  | { kind: 'switch'; email: string; inviter: string | null; signedIn: boolean },
): string {
  const w = esc(workspace);
  const email = `<span class="addr">${esc(o.email)}</span>`;
  if (o.kind === 'join') {
    return serverPage(workspace, card(`<p>The admins of ${w} will see your request from ${email}.</p>
<p>${o.emailOn ? `We will email ${email} when an admin answers.` : `${w} does not send email yet. Sign in again later: once an admin approves, you are in.`}</p>
${actionLink(BACK_TO_SIGN_IN, 'Back to sign in')}`), 'Request sent', { title: `Sign in - ${workspace}` });
  }
  const who = esc(o.inviter ?? `An admin of ${workspace}`);
  const when = o.inviter ? `Once ${esc(o.inviter)} approves` : 'Once an admin approves';
  return serverPage(workspace, card(o.signedIn
    ? `<p>${who} will see your request. ${when}, ${email} gets the access this invitation gives.</p>${actionLink('/', `Continue to ${workspace}`)}`
    : `<p>${who} will see your request. ${when}, open your invitation link again and sign in as ${email}.</p>${actionLink(BACK_TO_SIGN_IN, 'Back to sign in')}`),
  'Request sent', { title: `Sign in - ${workspace}` });
}

export function requestWithdrawnHtml(workspace: string): string {
  return serverPage(workspace, card(`<p>Nothing more happens with this request.</p>${actionLink(BACK_TO_SIGN_IN, 'Back to sign in')}`),
    'Request withdrawn', { title: `Sign in - ${workspace}` });
}

/** An ask token or a form that is no longer good (3.7, a 403). */
export function requestExpiredHtml(workspace: string): string {
  return serverPage(workspace, card(`<p>Sign in again to send your request.</p>${actionLink('/api/auth/login', 'Sign in')}`),
    'This page expired', { title: `Sign in - ${workspace}` });
}
