// SPDX-License-Identifier: MPL-2.0
/**
 * The pages a browser gets from a shared link (plan 320 J1, the landing of plan
 * 75 J8): a guest link's landing, and the page for a link that cannot open.
 *
 * Before these, a guest link answered a browser with JSON and set the guest
 * cookie on the GET itself, so a chat preview or a mail scanner that fetched
 * the link counted as a guest, and an ended or turned-off link showed an error
 * object. Now the GET only shows the landing; joining is the form's POST.
 *
 * Pure HTML builders over a view the route works out, in the style of the
 * invite pages (access/pages.ts): English (plan 75 C20), one h1, labelled
 * fields, 44px buttons, no script, inline style only. The title never names a
 * person or a tool, and the page carries no `og:` tag, because a link can be
 * unfurled by a chat preview. Every name goes through `esc()`.
 */
import { esc, serverPage } from '../iam/activate-page.ts';
import { relativeTime } from '../access/pages.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "5 Oct, 14:00 UTC", with the year when it is not this year's. A guest link
 *  lasts hours or days, so the time of day matters, and a page with no script
 *  cannot show the reader's own time zone. */
export function utcMoment(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const year = d.getUTCFullYear() !== new Date(nowMs).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}, ${hh}:${mm} UTC`;
}

/** What a guest link's landing knows. */
export interface GuestLandingView {
  /** `instance.name`. */
  workspace: string;
  /** The member who made the link, by name only; null when nobody can be named. */
  inviter: string | null;
  /** The tool's name; null when the pack no longer has it. */
  tool: string | null;
  expiresAt: string;
  now: number;
  /** Where the form posts: the link's own address with its signature. */
  action: string;
  /** Ask for the link's password as well as a name. */
  password: boolean;
  /** Where a member signs in instead; null when the workspace has no sign-in. */
  signInHref: string | null;
  /** Why the last try did not join, said above the form. */
  error?: string;
  /** The name typed on the last try, kept after a refusal. */
  name?: string;
}

/** Generic on purpose: a title is what an unfurled link shows. */
const title = (workspace: string): string => `Link to ${workspace}`;

export function guestLandingHtml(v: GuestLandingView): string {
  const what = v.tool ?? v.workspace;
  const heading = v.inviter ? `${v.inviter} invited you to ${what}` : `You are invited to ${what}`;
  // A role=alert that arrives with the page is not reliably read out, so the
  // field that gets focus points at the error and says it is invalid.
  const invalid = v.error ? ' aria-invalid="true" aria-describedby="guest-err"' : '';
  const body = `
<div class="card">
<p>You can use ${esc(what)} as a guest until the link ends. No account needed, and your changes stay with you.</p>
<p class="muted">Ends ${esc(relativeTime(v.expiresAt, v.now))} (${esc(utcMoment(v.expiresAt, v.now))}).</p>
${v.error ? `<p class="err" role="alert" id="guest-err">${esc(v.error)}</p>` : ''}
<form class="stack" method="post" action="${esc(v.action)}">
<label class="field" for="guest-name">Your name</label>
<input class="field" id="guest-name" name="name" maxlength="60" autocomplete="name" aria-describedby="guest-name-hint" value="${esc(v.name ?? '')}"${v.password ? '' : ' autofocus'}>
<p class="muted" id="guest-name-hint">People you work with see this name.</p>
${v.password ? `<label class="field" for="guest-pw">Password</label>
<input class="field" id="guest-pw" type="password" name="password" autocomplete="off" required autofocus${invalid}>` : ''}
<div class="row"><button class="primary" type="submit">Join as a guest</button></div>
</form>
${v.signInHref ? `<p>Have an account on ${esc(v.workspace)}? <a href="${esc(v.signInHref)}">Sign in instead</a>.</p>` : ''}
</div>`;
  return serverPage(v.workspace, body, heading, { title: title(v.workspace) });
}

/** Why a link cannot open, as a browser is told it. */
export type LinkEnd = 'not-found' | 'ended' | 'turned-off' | 'locked' | 'guests-off' | 'inviter';

const ENDS: Record<LinkEnd, { heading: string; body: (v: { workspace: string; inviter: string | null }) => string }> = {
  'not-found': {
    heading: 'This link does not work',
    body: () => 'Check that you have the whole link, or ask the person who sent it for a new one.',
  },
  ended: {
    heading: 'This link has ended',
    body: (v) => (v.inviter ? `Ask ${esc(v.inviter)} for a new one.` : 'Ask the person who sent it for a new one.'),
  },
  'turned-off': {
    heading: 'This link was turned off',
    body: (v) => (v.inviter ? `${esc(v.inviter)} turned this link off. Ask them for a new one if you still need it.` : 'The person who shared it turned it off. Ask them for a new one if you still need it.'),
  },
  locked: {
    heading: 'Too many tries',
    body: () => 'Too many wrong passwords were tried from your network. Wait 15 minutes, then try again.',
  },
  'guests-off': {
    heading: 'Guest links are turned off',
    body: (v) => `${esc(v.workspace)} does not let guests in at the moment. Ask the person who sent the link.`,
  },
  inviter: {
    heading: 'This guest link stopped working',
    body: () => 'The person who made it can no longer share it. Ask them, or someone else on the team, for a new one.',
  },
};

export function linkEndHtml(end: LinkEnd, v: { workspace: string; inviter: string | null }): string {
  const page = ENDS[end];
  return serverPage(v.workspace, `<div class="card"><p>${page.body(v)}</p></div>`, page.heading, { title: title(v.workspace) });
}
