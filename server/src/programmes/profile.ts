// SPDX-License-Identifier: MPL-2.0
/**
 * A partner company's profile (plans/82 M3): the guest brand a partner's
 * pieces carry, set up once by the brand team.
 *
 * It holds the company's logos (instance asset ids, one for light surfaces,
 * one for dark surfaces and an optional square mark) and the details a piece
 * prints: website, a contact line, an address, a currency code and a tax
 * note. The company's name stays on its CompanyRecord. Every save that changes
 * something bumps `revision` and keeps a copy in the history, so a revision an
 * exported file cites can be read back.
 *
 * Nothing here describes how a logo may be used: clear space, minimum size,
 * treatments and partner colours belong to partner kits (plan 334 P2), which
 * can adopt these logos later with nothing re-uploaded.
 *
 * Who edits: anyone with `programme.manage`, from the company's page, without
 * joining the company. A company can also name contacts who may edit (off by
 * default); their changes apply at once unless the company's approval switch
 * names an approval chain (also off by default). A manager's own change never
 * waits.
 */
import type { LogoSurface } from './logo-checks.ts';

export interface CompanyContact {
  name?: string;
  email?: string;
  phone?: string;
}

/** The fields a piece can take from the company. All optional. */
export interface CompanyProfile {
  /** The company's name when this revision was saved; the live name is on CompanyRecord. */
  name?: string;
  logoLight?: string;
  logoDark?: string;
  mark?: string;
  /** The version of each logo asset this revision draws, so a revision read
   *  back names the exact bytes even when a logo was replaced in place. */
  logoVersions?: Partial<Record<LogoSurface, number>>;
  website?: string;
  contact?: CompanyContact;
  address?: string;
  /** ISO 4217 code, such as EUR. The price itself stays a free text input. */
  currency?: string;
  taxNote?: string;
}

/** Who may edit besides the managers, and whether their changes wait. Not part
 *  of a revision: changing who edits changes no artwork. */
export interface CompanyProfileSettings {
  /** User ids of the company's people who may edit its profile. Empty is off. */
  editors?: string[];
  /** An approval chain a contact's change goes through. Absent is off. */
  approvalChain?: string;
}

export interface CompanyProfileRecord {
  companyId: string;
  /** 0 until the first save; then bumped on every save that changes something. */
  revision: number;
  profile: CompanyProfile;
  settings: CompanyProfileSettings;
  /** 'user:<id>' who made the revision. */
  updatedBy: string;
  updatedAt: string;
}

/** One revision as the history keeps it. */
export interface CompanyProfileRevision {
  companyId: string;
  revision: number;
  profile: CompanyProfile;
  updatedBy: string;
  updatedAt: string;
}

export const LOGO_FIELD: Record<LogoSurface, 'logoLight' | 'logoDark' | 'mark'> = { light: 'logoLight', dark: 'logoDark', mark: 'mark' };

/** The detail fields a PUT may set; logos change only through the logo route. */
export const DETAIL_FIELDS = ['website', 'contact', 'address', 'currency', 'taxNote'] as const;
type DetailField = (typeof DETAIL_FIELDS)[number];

/** A currency is an ISO 4217 code: three letters. */
export const CURRENCY_CODE_LENGTH = 3;
export const LIMITS = { name: 120, website: 500, contactName: 120, email: 254, phone: 40, address: 600, addressLines: 6, taxNote: 200 } as const;
/** Contacts a company may name as editors. */
export const MAX_EDITORS = 50;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>".][^\s@,;<>"]*\.[^\s@,;<>"]+$/;
const PHONE = /^[+0-9 ()./-]+(?:\s*(?:x|ext\.?)\s*[0-9]+)?$/i;

let currencies: Set<string> | null = null;
function knownCurrency(code: string): boolean {
  if (!currencies) {
    try { currencies = new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('currency')); }
    catch { currencies = new Set(); }
  }
  return currencies.size ? currencies.has(code) : /^[A-Z]{3}$/.test(code);
}

type Patch = Partial<Record<DetailField, CompanyProfile[DetailField] | null>> & { name?: string };

/**
 * Read a PUT body into a patch. A field that is absent keeps its value; null
 * or an empty string clears it. Logo fields are ignored here (the logo route
 * sets them), so a console that sends the whole profile back changes nothing
 * it did not mean to. `name` renames the company and cannot be cleared.
 */
export function readProfileBody(raw: unknown, opts: { allowName: boolean }): Patch | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  const out: Patch = {};
  const text = (field: string, value: unknown, max: number, multiline = false): string | null | { error: string } => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return { error: `${field} must be text` };
    const v = multiline ? value.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim() : value.trim();
    if (!v) return null;
    if (CONTROL.test(v) || (!multiline && v.includes('\n'))) return { error: `${field} holds characters that cannot print` };
    if (v.length > max) return { error: `${field} can be at most ${max} characters` };
    return v;
  };
  if (b.name !== undefined) {
    if (!opts.allowName) return { error: 'the company name is set by the brand team' };
    const v = text('name', b.name, LIMITS.name);
    if (v === null) return { error: 'name cannot be empty' };
    if (typeof v === 'object') return v;
    out.name = v;
  }
  if (b.website !== undefined) {
    const v = text('website', b.website, LIMITS.website);
    if (v && typeof v === 'object') return v;
    if (v) {
      let url: URL;
      try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`); } catch { return { error: 'website must be a web address, such as https://northwind.example' }; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'website must be an http or https address' };
      if (url.username || url.password) return { error: 'website must not carry a user name or password' };
      out.website = url.href;
    } else out.website = null;
  }
  if (b.contact !== undefined) {
    if (b.contact === null) out.contact = null;
    else if (typeof b.contact !== 'object' || Array.isArray(b.contact)) return { error: 'contact must be an object with name, email and phone' };
    else {
      const c = b.contact as Record<string, unknown>;
      const contact: CompanyContact = {};
      const name = text('contact name', c.name, LIMITS.contactName);
      if (name && typeof name === 'object') return name;
      if (name) contact.name = name;
      const email = text('contact email', c.email, LIMITS.email);
      if (email && typeof email === 'object') return email;
      if (email) {
        if (!EMAIL.test(email)) return { error: 'contact email must be an email address' };
        contact.email = email.toLowerCase();
      }
      const phone = text('contact phone', c.phone, LIMITS.phone);
      if (phone && typeof phone === 'object') return phone;
      if (phone) {
        if (!PHONE.test(phone)) return { error: 'contact phone holds characters a phone number does not use' };
        contact.phone = phone;
      }
      out.contact = Object.keys(contact).length ? contact : null;
    }
  }
  if (b.address !== undefined) {
    const v = text('address', b.address, LIMITS.address, true);
    if (v && typeof v === 'object') return v;
    if (v && v.split('\n').length > LIMITS.addressLines) return { error: `address can be at most ${LIMITS.addressLines} lines` };
    out.address = v;
  }
  if (b.currency !== undefined) {
    const v = text('currency', b.currency, CURRENCY_CODE_LENGTH);
    if (v && typeof v === 'object') return { error: 'currency must be a three-letter ISO 4217 code, such as EUR' };
    if (v && !knownCurrency(v.toUpperCase())) return { error: 'currency must be a three-letter ISO 4217 code, such as EUR' };
    out.currency = v ? v.toUpperCase() : null;
  }
  if (b.taxNote !== undefined) {
    const v = text('taxNote', b.taxNote, LIMITS.taxNote);
    if (v && typeof v === 'object') return v;
    out.taxNote = v;
  }
  return out;
}

/** The profile a patch makes from `prior`. */
export function applyPatch(prior: CompanyProfile, patch: Patch): CompanyProfile {
  const next: CompanyProfile = { ...prior };
  if (patch.name !== undefined) next.name = patch.name;
  for (const field of DETAIL_FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v === null || v === undefined) delete next[field];
    else (next as Record<string, unknown>)[field] = v;
  }
  return next;
}

/** Whether two profiles hold the same values. Key order never matters. */
export function sameProfile(a: CompanyProfile, b: CompanyProfile): boolean {
  const norm = (p: CompanyProfile) => JSON.stringify(Object.keys(p).sort().map((k) => [k, (p as Record<string, unknown>)[k]]), (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
  return norm(a) === norm(b);
}

/** The fields that differ, for the audit: names only, never logo bytes. */
export function changedFields(a: CompanyProfile, b: CompanyProfile): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])).sort();
}

/** The one line a piece prints for the contact ("Rita Ortiz, rita@northwind.example, +49 30 1234"). */
export function contactLine(contact: CompanyContact | undefined): string | undefined {
  if (!contact) return undefined;
  const line = [contact.name, contact.email, contact.phone].filter(Boolean).join(', ');
  return line || undefined;
}

/** An empty record for a company that has none yet. */
export function emptyProfileRecord(companyId: string): CompanyProfileRecord {
  return { companyId, revision: 0, profile: {}, settings: {}, updatedBy: '', updatedAt: '' };
}
