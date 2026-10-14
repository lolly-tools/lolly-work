// SPDX-License-Identifier: MPL-2.0
import { b64u, b64uDecode, deriveKey, hmac, macEquals } from '../lib/crypto.ts';

export const SUBJECT_CATEGORIES = ['identities', 'projects', 'credentials', 'links', 'telemetry', 'fleet', 'audit'] as const;
export type SubjectCategory = typeof SUBJECT_CATEGORIES[number];
export interface SubjectRow { key: string; value: Record<string, unknown> }
export type OffboardResult =
  | { status: 'not-found' | 'self' | 'last-owner' | 'limit' }
  | { status: 'disabled'; sessionEpoch: number; credentialsRevoked: number; linksRevoked: number; passwordLinksRevoked: number };
export interface SubjectStore {
  subjectRows(userId: string, category: SubjectCategory, after: string, limit: number): Promise<SubjectRow[]>;
  offboardUser(userId: string, actorId: string, at: string, limit: number): Promise<OffboardResult>;
}

export class LastOwnerError extends Error {
  readonly status = 409;
  constructor() { super('Keep another active owner before disabling this account.'); }
}

export function subjectLimit(value: unknown, fallback = 100, maximum = 200): number {
  const limit = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new Error(`Limit must be an integer from 1 to ${maximum}.`);
  return limit;
}

export function subjectCursor(userId: string, category: SubjectCategory, after: string, secret: string): string {
  const body = b64u(JSON.stringify({ v: 1, userId, category, after }));
  return `${body}.${hmac(body, deriveKey(secret, 'lw/subject-cursor'))}`;
}

export function readSubjectCursor(raw: string | null, userId: string, category: SubjectCategory, secret: string): string {
  if (!raw) return '';
  if (raw.length > 4096) throw new Error('Invalid continuation cursor.');
  const [body, signature, extra] = raw.split('.');
  if (!body || !signature || extra || !macEquals(signature, hmac(body, deriveKey(secret, 'lw/subject-cursor')))) throw new Error('Invalid continuation cursor.');
  let parsed: { v?: unknown; userId?: unknown; category?: unknown; after?: unknown };
  try { parsed = JSON.parse(b64uDecode(body).toString('utf8')) as typeof parsed; } catch { throw new Error('Invalid continuation cursor.'); }
  if (!parsed || parsed.v !== 1 || parsed.userId !== userId || parsed.category !== category || typeof parsed.after !== 'string'
    || !parsed.after || parsed.after.length > 2048) throw new Error('Invalid continuation cursor.');
  return parsed.after;
}

export const SUBJECT_OMISSIONS = ['shared content and revisions', 'uploads and render or delivery bytes', 'provider and external copies',
  'aggregate or erased attribution', 'indirect, email and free-text audit matches', 'service credential descendants', 'group-derived project access', 'backups and device caches'];

export function subjectRow(key: string, value: Record<string, unknown>): SubjectRow {
  let nodes = 0, omitted = false;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 6) { omitted = true; return '[metadata omitted]'; }
    if (typeof item === 'string') {
      if (item.length <= 2048) return item;
      omitted = true; return '[metadata omitted]';
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) {
      if (item.length > 128) omitted = true;
      return item.slice(0, 128).map(entry => visit(entry, depth + 1));
    }
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      if (entries.length > 128) omitted = true;
      return Object.fromEntries(entries.slice(0, 128).map(([name, entry]) => [name.slice(0, 128), visit(entry, depth + 1)]));
    }
    return null;
  };
  const body = visit(value, 0) as Record<string, unknown>;
  return { key, value: { ...body, ...(omitted ? { metadataValuesOmitted: true } : {}) } };
}
