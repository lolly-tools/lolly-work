// SPDX-License-Identifier: MPL-2.0
/**
 * Who may sign in here (plans/74 W-ID-1). One pure decision, taken AFTER the
 * id_token is verified and BEFORE any user row is created or updated, so a
 * refused person leaves no trace in the directory beyond an audit row.
 *
 * Order matters and is fixed:
 *   1. a disabled account is refused outright;
 *   2. per-IdP pins (Google `hd`, Entra `tid`) refuse on any mismatch, whatever
 *      the lists say, because a matching email from the wrong tenant is not
 *      the person the operator meant;
 *   3. with no admission policy, every verified sign-in is admitted (the
 *      behaviour before this module existed);
 *   4. otherwise an email the IdP does not vouch for (`emailVerification`) is
 *      refused before the lists are read, so the refusal reason never says
 *      whether an address or domain is listed or invited;
 *   5. then an invitation, a listed email or a listed domain admits.
 *
 * An invitation matches the sign-in's email or one of its
 * `invitationEmails`: the other verified addresses a GitHub account carries
 * (iam/github.ts). Those count for invitations only. The `emails` and
 * `domains` lists read the sign-in's own email and nothing else (plans/75
 * 4.8 rule 7), so a second address on a personal account never borrows a
 * listed company domain.
 *
 * No I/O, no clock unless passed in: the callback, the proxy route and the
 * tests all ask the same question the same way.
 */

export type EmailVerification = 'claim' | 'trusted';

/** What the verified sign-in says about the person. */
export interface AdmissionIdentity {
  email: string;
  /** The IdP's `email_verified` claim, exactly as sent (only boolean true counts). */
  emailVerified?: unknown;
  /** Google Workspace hosted domain (`hd`). */
  hd?: string;
  /** Microsoft Entra tenant id (`tid`). */
  tid?: string;
  /** The existing account is disabled (console "disable" or SCIM deactivation). */
  disabled?: boolean;
  /** Other verified addresses of the same sign-in, lowercased, matched
   *  against the invitation only (GitHub's secondary addresses). */
  invitationEmails?: string[];
}

/** The per-IdP part of the rule. */
export interface AdmissionIdp {
  hostedDomain?: string;
  tenantId?: string;
  /** Default `claim`: email-based admission needs `email_verified === true`. */
  emailVerification?: EmailVerification;
}

/** `idp.admission`. Absent means open (every verified sign-in is admitted). */
export interface AdmissionPolicy {
  emails?: string[];
  domains?: string[];
  /** Default true: an open invitation for the email admits. */
  invitations?: boolean;
}

/** An invitation found for this email, or null. The store lookup lives with
 *  the caller so this function stays pure. */
export interface AdmissionInvitation {
  email: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

/** `linked`: this sign-in is linked to an existing member who is admitted on
 *  their own standing (app.ts `admitSignIn`, plans/74 "One person, many sign-ins"). */
export type AdmissionVia = 'email' | 'domain' | 'invitation' | 'open' | 'linked';
export type AdmissionRefusal = 'disabled' | 'hosted-domain' | 'tenant' | 'email-unverified' | 'not-invited';

export type AdmissionDecision =
  | { ok: true; via: AdmissionVia; emailVerified: boolean }
  | { ok: false; reason: AdmissionRefusal };

const lower = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** The part after the LAST @, lowercased. `a@b@example.com` reads as example.com. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : lower(email.slice(at + 1));
}

/** Whether this IdP vouches for the email address. */
export function emailIsVerified(identity: AdmissionIdentity, idp: AdmissionIdp): boolean {
  return (idp.emailVerification ?? 'claim') === 'trusted' || identity.emailVerified === true;
}

export function decideAdmission(
  identity: AdmissionIdentity,
  idp: AdmissionIdp,
  policy: AdmissionPolicy | undefined,
  invitation: AdmissionInvitation | null,
  now: number = Date.now(),
): AdmissionDecision {
  if (identity.disabled) return { ok: false, reason: 'disabled' };
  if (idp.hostedDomain && lower(identity.hd) !== lower(idp.hostedDomain)) return { ok: false, reason: 'hosted-domain' };
  if (idp.tenantId && lower(identity.tid) !== lower(idp.tenantId)) return { ok: false, reason: 'tenant' };
  const verified = emailIsVerified(identity, idp);
  if (!policy) return { ok: true, via: 'open', emailVerified: verified };
  // Before any list lookup: answering "unverified" only for listed addresses
  // would let anyone who can assert an unverified email probe the lists.
  if (!verified) return { ok: false, reason: 'email-unverified' };

  const email = lower(identity.email);
  const domain = emailDomain(email);
  const addresses = new Set([email, ...(identity.invitationEmails ?? []).map(lower)].filter(Boolean));
  const invited = policy.invitations !== false && !!invitation && addresses.has(lower(invitation.email))
    && !invitation.revokedAt
    && !(invitation.expiresAt && Date.parse(invitation.expiresAt) <= now);
  const listed = !!email && (policy.emails ?? []).some((e) => lower(e) === email);
  const domainListed = !!domain && (policy.domains ?? []).some((d) => lower(d).replace(/^@/, '') === domain);

  if (invited || listed || domainListed) {
    return { ok: true, via: invited ? 'invitation' : listed ? 'email' : 'domain', emailVerified: true };
  }
  return { ok: false, reason: 'not-invited' };
}

/**
 * The group a bootstrap owner gets unioned in at sign-in, or null. Only an
 * admitted person with a verified email who is named in `idp.bootstrapOwners`
 * qualifies. The group is the first name `roleGroups.owner` maps, else the
 * literal `owner` (what `roleFromGroups` reads with no mapping).
 */
export function bootstrapOwnerGroup(
  decision: AdmissionDecision,
  email: string,
  bootstrapOwners: readonly string[] | undefined,
  ownerGroups: readonly string[] | undefined,
): string | null {
  if (!decision.ok || !decision.emailVerified) return null;
  const e = lower(email);
  if (!e || !(bootstrapOwners ?? []).some((o) => lower(o) === e)) return null;
  if (ownerGroups && ownerGroups.length === 0) return null;
  return ownerGroups?.[0] ?? 'owner';
}
