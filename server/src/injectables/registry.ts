/**
 * The injectable registry (plans/19): validate a publish, project the live set into
 * org-config for a caller, and fold the whole set into the policy version so a
 * publish busts every connected shell's org-config ETag on its next poll.
 *
 * Projection is per-caller and group-filtered — a caller sees only injectables
 * whose groups intersect theirs (or that target `*`), and only ones that are `live`.
 * Genuinely-scoped injectables are ABSENT from a non-member's payload, never merely
 * flagged, exactly as tool visibility works (plans/03).
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { KIND_HANDLERS } from './kinds.ts';
import { INJECTABLE_KINDS, type InjectableKind, type InjectableRecord } from './types.ts';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A validated publish, ready to become a record (minus server-stamped fields). */
export interface PublishFields {
  id: string;
  kind: InjectableKind;
  title: string;
  payload: Record<string, unknown>;
  groups: string[];
}

/**
 * Validate a publish request body end to end: id shape, known kind, groups, and the
 * kind's own envelope over the payload. Returns the clean fields, or the first
 * human-readable reason it refused — surfaced verbatim to the admin.
 */
export function validatePublish(body: unknown): { ok: true; fields: PublishFields } | { ok: false; reason: string } {
  const id = str((body as Record<string, unknown>)?.id);
  if (!id || !SLUG.test(id)) return { ok: false, reason: 'id must be a lowercase slug' };
  const kind = str((body as Record<string, unknown>)?.kind) as InjectableKind | null;
  if (!kind || !INJECTABLE_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${INJECTABLE_KINDS.join(', ')}` };
  const title = str((body as Record<string, unknown>)?.title);
  if (!title) return { ok: false, reason: 'title is required' };
  // title ships in every kind's descriptor, so it is plain text like the rest — a
  // markup guard here covers the one field no kind envelope sees (data, not code).
  if (/[<>]/.test(title)) return { ok: false, reason: 'title must be plain text — markup is not allowed' };
  const rawGroups = (body as Record<string, unknown>)?.groups;
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim()) : [];
  if (!groups.length) return { ok: false, reason: 'groups is required (use ["*"] for everyone)' };
  const payload = (body as Record<string, unknown>)?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'payload must be an object' };
  const env = KIND_HANDLERS[kind].envelope(payload);
  if (!env.ok) return { ok: false, reason: env.reason };
  return { ok: true, fields: { id, kind, title, payload: payload as Record<string, unknown>, groups } };
}

/** The display facts a kind extracts from a live record — for the console listing. */
export function factsFor(rec: InjectableRecord): Record<string, string> {
  const env = KIND_HANDLERS[rec.kind].envelope(rec.payload);
  return env.ok ? env.facts : {};
}

/** Is this injectable visible to a caller in these groups? Live + group intersection. */
export function visibleTo(rec: InjectableRecord, groups: string[]): boolean {
  if (rec.state !== 'live') return false;
  if (rec.groups.includes('*')) return true;
  const set = new Set(groups);
  return rec.groups.some((g) => set.has(g));
}

/**
 * Project the live, caller-visible injectables into org-config descriptors. Each is
 * the kind's declarative descriptor — never the raw record, never code.
 *
 * Flag-kind injectables are OMITTED here: they ride the org-config `featureFlags`
 * map instead (the one kind consumable by today's shell with no new path), so a
 * shell must never see a flag twice.
 */
export function projectInjectables(recs: Iterable<InjectableRecord>, groups: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rec of recs) {
    if (rec.kind === 'flag' || !visibleTo(rec, groups)) continue;
    out.push(KIND_HANDLERS[rec.kind].project(rec));
  }
  // Stable order so the payload (and its ETag) is deterministic across polls.
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * The flag-kind injectables as feature-flag governance, so the assembler can merge
 * them into the existing org-config `featureFlags` map — the one kind consumable by
 * today's shell with no OSS change. Keyed by flagId; a caller's group scope applies.
 */
export function flagInjectableGovernance(
  recs: Iterable<InjectableRecord>,
  groups: string[],
): Map<string, { default: 'on' | 'off'; hidden: boolean }> {
  const out = new Map<string, { default: 'on' | 'off'; hidden: boolean }>();
  for (const rec of recs) {
    if (rec.kind !== 'flag' || !visibleTo(rec, groups)) continue;
    const flagId = str(rec.payload.flagId);
    const def = str(rec.payload.default);
    if (!flagId || (def !== 'on' && def !== 'off')) continue;
    out.set(flagId, { default: def, hidden: (str(rec.payload.visibility) ?? 'show') === 'hide' });
  }
  return out;
}

/**
 * A canonical, group-independent projection of the live set for the policy-version
 * hash: any authored change (publish, replace, revoke, re-scope) moves the digest,
 * so connected shells re-fetch. Revoked entries drop out — a revoke is a change.
 */
export function injectablesForVersion(recs: Iterable<InjectableRecord>): Array<Record<string, unknown>> {
  return [...recs]
    .filter((r) => r.state === 'live')
    .map((r) => ({ id: r.id, kind: r.kind, version: r.version, groups: [...r.groups].sort(), payload: r.payload }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Short digest of the live set — handy for tests and cache keys. */
export function injectablesDigest(recs: Iterable<InjectableRecord>): string {
  return sha256Hex(canonicalJson(injectablesForVersion(recs))).slice(0, 16);
}
