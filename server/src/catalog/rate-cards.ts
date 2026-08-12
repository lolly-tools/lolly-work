/**
 * Rate-card awareness in the catalog rail (plans/18) — the control plane's
 * side of the OSS cost feature (lolly engine 1.95's `rate-card.ts` + the
 * shell's cost panel).
 *
 * The division of labour is strict and deliberate:
 *   - The SHELL's pinned engine is the only parser and the only arithmetic.
 *     This module never prices anything, never copies the OSS JSON schema
 *     (two parsers drift; the authoritative one travels with the client), and
 *     never renders a monetary figure — the never-invent-money invariant is
 *     the client's, and the server cannot get ahead of it.
 *   - The CONTROL PLANE distributes bytes and states facts about them: an
 *     envelope sanity check at ingest (so an admin uploading the wrong file
 *     hears it now, not from a member's export panel), and a lifecycle row
 *     derived from the card's own claimed validity window, so the existing
 *     expiry machinery (lifecycle.ts) governs stale rates with no new state.
 *
 * `onExpiry` is always 'warn', never 'hide': an expired card must remain in
 * the feed as an EXPIRED card. The shell's money policy already degrades
 * expired rates to counts with an explicit per-session opt-in
 * (`usedExpiredRates`); silently removing the asset would instead read as
 * "the org has no rates", which is a different and false statement.
 *
 * Pure functions only — no fs, no store, no fetch — matching lifecycle.ts.
 */

import type { LifecycleRow } from './lifecycle.ts';

/** What the envelope check could establish about an alleged rate card. All of
 *  it is the FILE's own claim (reported speech), verified only as far as
 *  "shaped like a card" — never "the rates are right". */
export interface RatecardEnvelope {
  ok: true;
  /** ISO 4217 code the card declares. A card without one prices nothing —
   *  there is no default currency anywhere in the system. */
  currency: string;
  /** The issuer name the file claims, if any. Unverified. */
  issuerName?: string;
  /** The issue / valid-until dates the file claims, if any. Unverified. */
  issued?: string;
  validUntil?: string;
  /** The card marks itself confidential (trade rates). The shell's money
   *  policy makes such a card reveal-only, never link-carried. */
  confidential: boolean;
  /** Declared line count — enough for an admin listing, not for pricing. */
  lineCount: number;
}

export type RatecardEnvelopeFailure = {
  ok: false;
  reason: 'not-json' | 'not-a-rate-card' | 'no-currency' | 'no-lines';
};

/**
 * Envelope sanity check for an uploaded/ingested rate card. Establishes only
 * that the bytes are a JSON object shaped like a card (a `lines` array and a
 * declared currency) and lifts the claims an admin listing or lifecycle
 * derivation needs. Anything deeper — per-line kinds, break modes, the
 * example-card refusal — is the pinned engine's job at point of use.
 */
export function ratecardEnvelope(text: string): RatecardEnvelope | RatecardEnvelopeFailure {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not-a-rate-card' };
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.lines)) return { ok: false, reason: 'not-a-rate-card' };
  if (d.lines.length === 0) return { ok: false, reason: 'no-lines' };
  if (typeof d.currency !== 'string' || !/^[A-Z]{3}$/.test(d.currency)) return { ok: false, reason: 'no-currency' };

  const issuer = (d.issuer !== null && typeof d.issuer === 'object' ? d.issuer : {}) as Record<string, unknown>;
  const claim = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const out: RatecardEnvelope = {
    ok: true,
    currency: d.currency,
    confidential: d.confidential === true,
    lineCount: d.lines.length,
  };
  const issuerName = claim(issuer.name);
  const issued = claim(issuer.issued);
  const validUntil = claim(issuer.validUntil);
  if (issuerName) out.issuerName = issuerName;
  if (issued) out.issued = issued;
  if (validUntil) out.validUntil = validUntil;
  return out;
}

/**
 * Derive the lifecycle row a rate card's own validity window implies, or null
 * when the card claims no window (nothing to govern — it simply stays live).
 * A malformed date is treated as no claim rather than a permanent 'scheduled'
 * or instant 'expired' surprise: lifecycle must never be stricter than what
 * the file actually said.
 */
export function ratecardLifecycleRow(assetId: string, env: RatecardEnvelope): LifecycleRow | null {
  const validUntil = env.validUntil !== undefined && !Number.isNaN(Date.parse(env.validUntil))
    ? env.validUntil
    : undefined;
  const validFrom = env.issued !== undefined && !Number.isNaN(Date.parse(env.issued))
    ? env.issued
    : undefined;
  if (validUntil === undefined && validFrom === undefined) return null;
  return {
    assetId,
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    // 'warn', never 'hide': an expired card must stay in the feed AS expired —
    // the shell degrades money to counts and offers the explicit opt-in;
    // removal would falsely read as "no rates exist".
    onExpiry: 'warn',
  };
}
