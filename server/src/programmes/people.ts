// SPDX-License-Identifier: MPL-2.0
/**
 * People in partner programmes (plans/82 M1 part 2): companies, adding many
 * people at once, end dates, and ending a partnership in one audited step.
 *
 * A company is a partner organisation inside a programme. It wraps one more
 * reserved group, `company-<id>`, so input rules, collections and grants can
 * name one company the same way they name a programme. Membership stays the
 * groups: a membership record only adds what a group cannot hold, the end
 * date and who added the person.
 */
import { PROGRAMME_ID } from './types.ts';

export interface CompanyRecord {
  /** A permanent slug, unique across the instance. */
  id: string;
  programmeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One person's place in a programme: what the groups cannot hold. */
export interface MembershipRecord {
  programmeId: string;
  /** Lowercased address; the key for someone who has not signed in yet. */
  email: string;
  userId?: string;
  companyId?: string;
  /** Access through this programme ends at this instant (a sweep removes the groups). */
  endsAt?: string;
  addedBy: string;
  addedAt: string;
  /** Set when the sweep or an exit ended it; the record stays for the audit trail. */
  endedAt?: string;
}

export const COMPANY_GROUP_PREFIX = 'company-';
export const companyGroup = (id: string): string => `${COMPANY_GROUP_PREFIX}${id}`;
export const isCompanyGroup = (g: string): boolean => g.startsWith(COMPANY_GROUP_PREFIX) && g.length > COMPANY_GROUP_PREFIX.length;
export const COMPANY_ID = PROGRAMME_ID;

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>".][^\s@,;<>"]*$/;

/** One row an admin pasted or uploaded, before anything happens. */
export interface PersonRow {
  line: number;
  email: string;
  name?: string;
  company?: string;
  endsAt?: string;
}

/**
 * Read a pasted list or a CSV. Each line is an address, optionally followed by
 * a name, a company and an end date (YYYY-MM-DD), separated by commas or tabs.
 * A header line naming `email` is skipped. Blank lines are ignored.
 */
export function parsePeopleList(text: string): PersonRow[] {
  const rows: PersonRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(/\t|,/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (i === 0 && cells[0]?.toLowerCase() === 'email') return;
    const [email = '', name, company, ends] = cells;
    rows.push({ line: i + 1, email: email.toLowerCase(), ...(name ? { name } : {}), ...(company ? { company } : {}), ...(ends ? { endsAt: ends } : {}) });
  });
  return rows;
}

export type RowStatus = 'new' | 'existing' | 'already' | 'invalid' | 'duplicate';

export interface RowPlan extends PersonRow {
  status: RowStatus;
  reason?: string;
  /** The id of the company the row joins, when the row gives one. */
  companyId?: string;
  /** ISO end instant, when the row carries a date. */
  endsAtIso?: string;
}

/**
 * Decide what each row would do, without doing it. `accountFor` says whether
 * an address already belongs to an account, and `memberOf` whether that
 * account (or a pending invitation) already sits in the programme.
 */
export function planRows(
  rows: PersonRow[],
  ctx: {
    companies: CompanyRecord[];
    accountFor(email: string): { id: string } | null;
    /** Whether the address already sits in the programme with this company and end date. */
    memberAlready(email: string, companyId: string | undefined, endsAtIso: string | undefined): boolean;
    now: number;
    maxRows?: number;
  },
): RowPlan[] {
  const seen = new Set<string>();
  const max = ctx.maxRows ?? 1000;
  return rows.slice(0, max).map((row): RowPlan => {
    if (!EMAIL.test(row.email) || row.email.length > 254) return { ...row, status: 'invalid', reason: 'not an email address' };
    if (seen.has(row.email)) return { ...row, status: 'duplicate', reason: 'already earlier in this list' };
    seen.add(row.email);
    let companyId: string | undefined;
    if (row.company) {
      const match = ctx.companies.find((c) => c.id === row.company || c.name.toLowerCase() === row.company!.toLowerCase());
      if (!match) return { ...row, status: 'invalid', reason: `no company "${row.company}" in this programme` };
      companyId = match.id;
    }
    let endsAtIso: string | undefined;
    if (row.endsAt) {
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(row.endsAt) ? `${row.endsAt}T23:59:59.999Z` : row.endsAt);
      if (!Number.isFinite(t)) return { ...row, status: 'invalid', reason: 'the end date is not a date (use YYYY-MM-DD)' };
      if (t <= ctx.now) return { ...row, status: 'invalid', reason: 'the end date has passed' };
      endsAtIso = new Date(t).toISOString();
    }
    const plan = { ...row, ...(companyId ? { companyId } : {}), ...(endsAtIso ? { endsAtIso } : {}) };
    if (ctx.memberAlready(row.email, companyId, endsAtIso)) return { ...plan, status: 'already' };
    return { ...plan, status: ctx.accountFor(row.email) ? 'existing' : 'new' };
  });
}

/** Whether a membership has ended by `now`. */
export function membershipEnded(m: MembershipRecord, now: number): boolean {
  return !m.endedAt && !!m.endsAt && Date.parse(m.endsAt) <= now;
}
