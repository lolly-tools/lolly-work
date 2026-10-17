// SPDX-License-Identifier: MPL-2.0
/**
 * The page a password link shows a browser until its password is known (plan
 * 80 E0b). The form posts the password to the link's own address, and the
 * answer is a cookie scoped to that address, so the password never sits in a
 * URL, a history entry or a log. Script-free, like the other server pages.
 */
import { esc, serverPage } from '../iam/activate-page.ts';

export function linkPasswordHtml(instanceName: string, opts: { action: string; error?: string }): string {
  // A role=alert that arrives with the page is not reliably read out, so the
  // field that gets focus points at the error and says it is invalid.
  const invalid = opts.error ? ' aria-invalid="true" aria-describedby="link-pw-err"' : '';
  return serverPage(instanceName, `
<div class="card">
<p>The person who shared this link protected it with a password. Enter the password to open it.</p>
${opts.error ? `<p class="err" role="alert" id="link-pw-err">${esc(opts.error)}</p>` : ''}
<form method="post" action="${esc(opts.action)}">
<label class="field" for="link-pw">Password</label>
<input class="field" id="link-pw" type="password" name="password" autocomplete="off" required autofocus${invalid}>
<div class="row"><button class="primary" type="submit">Open link</button></div>
</form>
</div>`, 'This link needs a password');
}
