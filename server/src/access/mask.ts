// SPDX-License-Identifier: MPL-2.0
/**
 * Masked addresses (plans/74 invite spec 2.6, plans/75 5.13). The invite
 * page, the wrong-account page and a switch request name the invited
 * address without spelling it out: "an•••@suse.com". A link can be
 * forwarded, so the page never holds the full address.
 *
 * The local part keeps its first two characters, or only its first when it
 * is shorter than four characters, so a short name is not most of the way
 * revealed. The domain is shown whole. Screen readers would read the mask as
 * "a n bullet bullet bullet", so pages show `maskEmail` with
 * `aria-hidden="true"` beside a visually hidden `maskEmailSpoken`. The shell
 * keeps its own copy of these two functions. Pure.
 */

const BULLETS = '•••';

/** The visible start of the local part and the domain, or null for a string
 *  that is not an address. Counted in code points, so an emoji stays whole. */
function parts(email: string): { start: string; domain: string } | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return null;
  const local = Array.from(e.slice(0, at));
  return { start: local.slice(0, local.length < 4 ? 1 : 2).join(''), domain: e.slice(at + 1) };
}

/** "sam.k@work.com" gives "sa•••@work.com"; "sam@work.com" gives "s•••@work.com". */
export function maskEmail(email: string): string {
  const p = parts(email);
  return p ? `${p.start}${BULLETS}@${p.domain}` : BULLETS;
}

/** The same mask in words, for a visually hidden span: "an address at
 *  work.com that starts with sa". */
export function maskEmailSpoken(email: string): string {
  const p = parts(email);
  return p ? `an address at ${p.domain} that starts with ${p.start}` : 'a hidden address';
}
