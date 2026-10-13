// SPDX-License-Identifier: MPL-2.0
import { deriveKey, hmac } from '../lib/crypto.ts';
import type { AuditEventBody } from './chain.ts';

export const AUDIT_EMAIL_OMITTED = '[email omitted]';
const TOKENS = /[^\s<>"'(),;:=\[\]{}]+/g;
const EMAIL_FIELD = /email(?:s|_?hash|_?digest)?$/i;
const MAX_DEPTH = 10;
const MAX_NODES = 4096;
const MAX_STRING = 8192;
const MAX_ENTRIES = 256;

export function auditEmailToken(value: string, macKey?: string): string {
  if (value === AUDIT_EMAIL_OMITTED || /^email:[A-Za-z0-9_-]{43}$/.test(value)) return value;
  if (!macKey) return AUDIT_EMAIL_OMITTED;
  return `email:${hmac(value.trim().toLowerCase(), deriveKey(macKey, 'lw/audit-email'))}`;
}

/** Sanitize new bodies before their chain hash and MAC are computed. */
export function privateAuditBody(body: AuditEventBody, macKey?: string): AuditEventBody {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const text = (value: string, emailField = false): string => {
    if (value.length > MAX_STRING) return '[value omitted]';
    if (emailField) return auditEmailToken(value, macKey);
    const decoded = !value.includes('@') ? value.replace(/%40/ig, '@') : value;
    return decoded.replace(TOKENS, token => token.includes('@') ? auditEmailToken(token, macKey) : token);
  };
  const visit = (value: unknown, depth: number, emailField = false): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return '[value omitted]';
    if (typeof value === 'string') return text(value, emailField);
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
    if (typeof value !== 'object' || seen.has(value)) return '[value omitted]';
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.slice(0, MAX_ENTRIES).map(item => visit(item, depth + 1, emailField));
    else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      result = Object.fromEntries(Object.entries(value).slice(0, MAX_ENTRIES).map(([key, item]) => [text(key), visit(item, depth + 1, EMAIL_FIELD.test(key))]));
    } else result = '[value omitted]';
    seen.delete(value);
    return result;
  };
  return { at: text(body.at), actor: text(body.actor), action: text(body.action), subject: text(body.subject),
    ...(body.payload ? { payload: visit(body.payload, 0) as Record<string, unknown> } : {}) };
}
