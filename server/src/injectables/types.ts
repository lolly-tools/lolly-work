/**
 * The injectable-resource rail (plans/19). One governed registry through which the
 * control plane injects capability into the OSS deploy it governs - tools, feature
 * flags, typed catalog resources, and declarative UI chrome - all as DATA the shell
 * renders, never code it runs.
 *
 * The invariant, inherited from rate cards (plans/18): the control plane distributes
 * DECLARATIVE descriptors and states facts about them; the OSS engine/shell does all
 * interpretation and rendering. An injectable's `payload` is a per-kind declarative
 * descriptor; a kind handler's `envelope()` sanity-checks its shape and extracts the
 * facts worth showing an admin (never interpreting it), and `project()` turns it into
 * the descriptor the shell consumes over org-config. No kind ever carries executable
 * code - that is the line that keeps the open core honest.
 */

/** The kinds the rail can carry. Each maps to a distinct shell consumption path
 *  (see plans/19 §4 for which are consumable today vs. need an OSS-side seam). */
export const INJECTABLE_KINDS = ['flag', 'resource', 'tool', 'chrome'] as const;
export type InjectableKind = (typeof INJECTABLE_KINDS)[number];

export type InjectableState = 'live' | 'revoked';

/** One published injectable. Persisted verbatim; projected per-caller into org-config. */
export interface InjectableRecord {
  /** Stable slug id - a permanent contract, like a tool/asset id. */
  id: string;
  kind: InjectableKind;
  /** Human label for the console + the shell descriptor. */
  title: string;
  /** The kind-specific DECLARATIVE descriptor (validated by the kind's envelope). */
  payload: Record<string, unknown>;
  /** Which groups' fleets receive it. `['*']` = every caller. */
  groups: string[];
  /** `live` projects; `revoked` stops projecting but stays listed as revoked. */
  state: InjectableState;
  /** Bumped on each replace, so the shell + audit can see the resource move. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

/** A kind handler's verdict on a payload: either the display facts, or a refusal
 *  the admin hears at publish time (never later, from a member's shell). */
export type Envelope =
  | { ok: true; facts: Record<string, string> }
  | { ok: false; reason: string };

/** The per-kind contract. Handlers hold NO state and NEVER interpret the payload
 *  beyond a shape check - interpretation is the shell's job. */
export interface KindHandler {
  kind: InjectableKind;
  /** Console-facing label + one-line summary of what this kind injects. */
  label: string;
  summary: string;
  /** Whether the OSS shell consumes this kind today, or needs a named seam (plans/19). */
  shellSupport: 'today' | 'needs-seam';
  /** Shape-check the declarative payload; extract facts, or refuse with a reason. */
  envelope(payload: unknown): Envelope;
  /** The declarative descriptor the shell receives over org-config. */
  project(rec: InjectableRecord): Record<string, unknown>;
}
