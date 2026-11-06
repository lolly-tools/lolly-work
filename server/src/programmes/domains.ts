// SPDX-License-Identifier: MPL-2.0
/**
 * Partner domains (plans/82 M1 part 2b): anyone who signs in with a verified
 * address at a partner's domain joins a programme, and a company in it,
 * until an optional end date.
 *
 * A domain is proved one of two ways, and the admin chooses (Andy,
 * 2026-11-06):
 *   - a DNS TXT record, `_lolly-work.<domain> TXT "lw-verify=<token>"`, the
 *     default. It is looked up when the domain is added, when an admin asks,
 *     and again every day; when the lookup answers that the record is gone,
 *     the domain pauses: nobody new joins through it until the record is back;
 *   - an admin's say-so, recorded in the audit with who, when and why.
 *
 * Public mail domains and the workspace's own domains are refused either way,
 * and only an address the sign-in provider verified ever matches. The rules
 * live in the record; this file holds the parts that need no I/O.
 */
import { DOMAIN_NAME } from '../config/instance.ts';

/** One programme a domain feeds. */
export interface DomainRule {
  programmeId: string;
  companyId?: string;
  /** Joining through this rule stops at this instant, and memberships made
   *  through it end then too. */
  endsAt?: string;
  addedBy: string;
  addedAt: string;
}

export type DomainProof = 'txt' | 'admin';

export interface PartnerDomainRecord {
  /** Lowercased, without a leading @. The key. */
  domain: string;
  proof: DomainProof;
  /** The value the TXT record carries after `lw-verify=`. Kept when the proof
   *  changes, so switching back to DNS needs no new record. */
  token: string;
  /** The last lookup that found the record. */
  verifiedAt?: string;
  /** The last lookup, whatever it answered. */
  checkedAt?: string;
  /** Set when a lookup answered that the record is not there after it had
   *  been found: the domain is paused from then. */
  missingSince?: string;
  /** The last lookup failed for a reason other than "not there" (a timeout,
   *  a server failure). The domain keeps its state; this says why. */
  lastError?: string;
  /** For `proof: 'admin'`: who said so, when, and the reason they gave. */
  assertedBy?: string;
  assertedAt?: string;
  reason?: string;
  rules: DomainRule[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DomainStatus = 'pending' | 'verified' | 'paused' | 'asserted';

/** The TXT record's name. */
export const txtName = (domain: string): string => `_lolly-work.${domain}`;
/** The TXT record's value. */
export const txtValue = (token: string): string => `lw-verify=${token}`;

/**
 * Domains where anyone can have an address. A rule for one of these would let
 * anybody in, so it is refused; people there are added by list instead. Not
 * every provider in the world, only the ones people actually sign up with.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it',
  'live.com', 'live.co.uk', 'msn.com', 'passport.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'ymail.com',
  'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 'mail.com', 'email.com', 'yandex.com', 'yandex.ru', 'ya.ru', 'mail.ru',
  'inbox.ru', 'list.ru', 'bk.ru', 'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm', 'tutanota.com', 'tutanota.de', 'tuta.io',
  'tuta.com', 'hey.com', 'hushmail.com', 'mailbox.org', 'posteo.de', 'posteo.net', 'disroot.org', 'riseup.net', 'qq.com', 'foxmail.com',
  '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com', 'aliyun.com', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
  'seznam.cz', 'centrum.cz', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sfr.fr',
  't-online.de', 'freenet.de', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'btinternet.com', 'sky.com', 'talktalk.net',
  'virginmedia.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
  'optonline.net', 'bigpond.com', 'optusnet.com.au', 'shaw.ca', 'rogers.com', 'sympatico.ca', 'uol.com.br', 'bol.com.br', 'terra.com.br',
]);

/**
 * Two-label suffixes under which anyone can register a name. A domain must
 * have at least one label of its own above one of these, or above a
 * top-level domain.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz',
  'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'com.hk',
  'com.tw', 'com.sg', 'com.my', 'co.in', 'net.in', 'org.in', 'firm.in', 'co.za', 'org.za', 'com.mx', 'com.ar', 'com.co', 'com.tr',
  'co.il', 'com.pl', 'co.id', 'co.th', 'com.vn', 'com.ph', 'com.ua', 'com.ru', 'com.es', 'com.pt', 'co.at', 'or.at',
]);

/** A domain as a person typed it, normalised, or null when it is not one. */
export function normaliseDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const d = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return DOMAIN_NAME.test(d) ? d : null;
}

/** The part after the last @, lowercased. */
export function domainOfEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/** Whether `domain` is `own` or sits under it. */
export function withinDomain(domain: string, own: string): boolean {
  return domain === own || domain.endsWith(`.${own}`);
}

/**
 * The host a URL names and each parent of it with two labels or more, for
 * the workspace's own domains: `work.example.com` gives `work.example.com`
 * and `example.com`. An address, localhost or a single label gives nothing.
 */
export function hostDomains(url: string | undefined): string[] {
  let host = '';
  try { host = url ? new URL(url).hostname.toLowerCase() : ''; } catch { return []; }
  if (!host || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return [];
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export type DomainRefusal = { code: 'INVALID_DOMAIN' | 'PUBLIC_MAIL_DOMAIN' | 'OWN_DOMAIN'; message: string };

/**
 * Why a domain cannot feed a programme, or null when it can. `own` maps each
 * of the workspace's own domains to the reason it counts as one.
 */
export function refuseDomain(domain: string, own: ReadonlyMap<string, string>): DomainRefusal | null {
  const labels = domain.split('.');
  if (labels.length < 2 || SHARED_SUFFIXES.has(domain)) {
    return { code: 'INVALID_DOMAIN', message: `${domain} is shared by many organisations; give the partner's own domain, such as partner.${domain}` };
  }
  if (PUBLIC_MAIL_DOMAINS.has(domain)) {
    return { code: 'PUBLIC_MAIL_DOMAIN', message: `${domain} is a public mail domain, so anyone can have an address there. Add people from it by list instead.` };
  }
  for (const [d, why] of own) {
    if (withinDomain(domain, d)) {
      return { code: 'OWN_DOMAIN', message: `${domain} is one of this workspace's own domains (${why}). People there are your own people, not partners.` };
    }
  }
  return null;
}

export function domainStatus(rec: PartnerDomainRecord): DomainStatus {
  if (rec.proof === 'admin') return 'asserted';
  if (rec.missingSince) return 'paused';
  return rec.verifiedAt ? 'verified' : 'pending';
}

/** Whether people can join through this domain now: proved, and not paused. */
export function domainActive(rec: PartnerDomainRecord): boolean {
  const s = domainStatus(rec);
  return s === 'verified' || s === 'asserted';
}

/** The rules still running at `now`. */
export function liveRules(rec: PartnerDomainRecord, now: number): DomainRule[] {
  return rec.rules.filter((r) => !r.endsAt || Date.parse(r.endsAt) > now);
}

/** The domains people can join through at `now`: active, with a live rule. */
export function admittingDomains(records: readonly PartnerDomainRecord[], now: number): string[] {
  return records.filter((r) => domainActive(r) && liveRules(r, now).length > 0).map((r) => r.domain);
}

export type TxtLookup = (name: string) => Promise<string[][]>;
export type TxtResult = { found: true } | { found: false; missing: true } | { found: false; missing: false; error: string };

/**
 * Look the record up. "Not there" (no such name, or no TXT at it) is told
 * apart from a failed lookup, because only the first may pause a domain:
 * a resolver timing out says nothing about the partner's DNS.
 */
export async function lookupTxt(domain: string, token: string, resolveTxt: TxtLookup): Promise<TxtResult> {
  try {
    const records = await resolveTxt(txtName(domain));
    const want = txtValue(token);
    return records.some((chunks) => chunks.join('').trim() === want) ? { found: true } : { found: false, missing: true };
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return { found: false, missing: true };
    return { found: false, missing: false, error: code || 'lookup failed' };
  }
}

/** The record after a lookup answered `result` at `at`. */
export function afterLookup(rec: PartnerDomainRecord, result: TxtResult, at: string): PartnerDomainRecord {
  const { lastError: _e, missingSince: _m, ...rest } = rec;
  if (result.found) return { ...rest, verifiedAt: at, checkedAt: at, updatedAt: at };
  if (!result.missing) return { ...rec, checkedAt: at, lastError: result.error, updatedAt: at };
  // Never found yet: still pending. Found before: paused from the first miss.
  return { ...rest, checkedAt: at, updatedAt: at, ...(rec.verifiedAt ? { missingSince: rec.missingSince ?? at } : {}) };
}

/** How often a domain proved by DNS is looked up again. Pending ones are
 *  looked up hourly, so a record published after the domain was added is
 *  picked up without anyone pressing Check. */
export const RECHECK_VERIFIED_MS = 24 * 3600 * 1000;
export const RECHECK_PENDING_MS = 3600 * 1000;

export function dueForLookup(rec: PartnerDomainRecord, now: number): boolean {
  if (rec.proof !== 'txt' || !rec.rules.length) return false;
  const last = rec.checkedAt ? Date.parse(rec.checkedAt) : 0;
  return now - last >= (rec.verifiedAt ? RECHECK_VERIFIED_MS : RECHECK_PENDING_MS);
}
