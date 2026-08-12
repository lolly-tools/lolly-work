/**
 * Feature-flag governance — the control plane's opinion on the per-user shell
 * flags (`profile.featureFlags` in the OSS shell, see its `feature-flags.ts`).
 *
 * Two knobs per flag, both instance-wide policy (not per-group):
 *   - `default`  the state a user gets when they haven't set the flag themselves.
 *                Unset ⇒ inherit the shell's own built-in default.
 *   - `visibility`  whether the user sees a toggle at all. `hide` removes the
 *                control from the profile view; the resolved default still
 *                applies. This is what lets a seasonal surprise (Pride, Apr 1)
 *                ship dark — set default `off` + `hide` now, flip to `on` on the
 *                day and it lights up without ever having shown a switch.
 *
 * The control plane can only govern flags it knows about — GOVERNABLE_FLAGS
 * mirrors the shell's standalone toggles by id; the built-in defaults must match
 * the shell so "inherit" is honest. Category/Pro flags stay purely local.
 */

export interface GovernableFlag {
  id: string;
  label: string;
  /** The shell's built-in default when neither the user nor the control plane
   *  has an opinion. MUST match the OSS `feature-flags.ts` default for this id. */
  builtinDefault: boolean;
  /** Admin-facing explainer, surfaced in the console tab. */
  info?: string;
}

/** The flags this control plane can govern. Ids are the shell's flag ids. */
export const GOVERNABLE_FLAGS: readonly GovernableFlag[] = [
  {
    id: 'neurospicy',
    label: 'Neurospicy Mode',
    builtinDefault: true,
    info: 'A calmer, lower-stimulation interface with an optional background focus-music dock.',
  },
  {
    id: 'jelly-effects',
    label: 'Jelly effects',
    builtinDefault: true,
    info: 'Soft-body “squish” on chrome controls. Follows theme and brand colours, respects reduced-motion, never touches tool output.',
  },
  {
    id: 'strip-upload-metadata',
    label: 'Strip metadata from uploads',
    builtinDefault: false,
    info: 'Removes EXIF, GPS and other embedded metadata from uploaded images. C2PA content credentials are always preserved either way.',
  },
  {
    id: 'export-preflight',
    label: 'Print preflight',
    builtinDefault: false,
    info: 'The export panel’s “Before you export” prepress card: bleed, resolution, ink coverage and plate counts. Personal opt-in since 2026-08-06; default it on for members who print. (Supersedes the legacy can[\'export.preflight\'] capability, which the shell still honours as a default-on signal.)',
  },
  {
    id: 'private-collab',
    label: 'Private collab',
    // ON by default since 2026-08-10, matching the shell's own flip (OSS
    // shells/web/src/feature-flags.ts). It shipped opt-in; the shell's `beta` pill
    // stays, because that pill describes the ceremony's maturity rather than the
    // switch's position. This value exists to make "inherit" honest, so it moves
    // when the shell moves — never on its own.
    builtinDefault: true,
    info: 'The P2P invite/accept ceremony that lets two devices co-edit a tool session directly, no account or server (OSS plans/100 Track A). On by default for everyone since 2026-08-10; the shell still labels it beta. Nothing reaches the network until a user starts or accepts a collab. An instance that wants collaboration to go through the control plane only (Track B, gated by the collab.join/collab.edit org-config bits — see policy/org-config.ts) can force this default off and hide the toggle, which overrides any per-user choice.',
  },
] as const;

const FLAG_BY_ID = new Map(GOVERNABLE_FLAGS.map((f) => [f.id, f]));
export function isGovernableFlag(id: string): boolean {
  return FLAG_BY_ID.has(id);
}

export type FlagDefault = 'on' | 'off';
export type FlagVisibility = 'show' | 'hide';

/** The stored governance record for one flag. Absent fields mean "no opinion":
 *  `default` unset ⇒ inherit the built-in; `visibility` unset ⇒ shown. */
export interface FlagGovernance {
  id: string;
  default?: FlagDefault;
  visibility?: FlagVisibility;
  updatedAt: string;
}

/** What a shell needs per flag: the resolved boolean default and whether the
 *  user-facing toggle is hidden. Emitted for EVERY governable flag so the shell
 *  has one authoritative source, even where the control plane set no override. */
export interface ResolvedFlag {
  default: boolean;
  hidden: boolean;
}

export function resolveFeatureFlags(gov: Map<string, FlagGovernance>): Record<string, ResolvedFlag> {
  const out: Record<string, ResolvedFlag> = {};
  for (const flag of GOVERNABLE_FLAGS) {
    const g = gov.get(flag.id);
    out[flag.id] = {
      default: g?.default ? g.default === 'on' : flag.builtinDefault,
      hidden: g?.visibility === 'hide',
    };
  }
  return out;
}

/** The admin-facing catalogue: each governable flag with its built-in default
 *  and the current override (null when none), for the console tab. */
export function flagGovernanceCatalog(gov: Map<string, FlagGovernance>) {
  return GOVERNABLE_FLAGS.map((f) => {
    const g = gov.get(f.id);
    return {
      id: f.id,
      label: f.label,
      info: f.info ?? null,
      builtinDefault: f.builtinDefault,
      default: g?.default ?? null, // null ⇒ inherit the built-in
      visibility: g?.visibility ?? 'show',
      updatedAt: g?.updatedAt ?? null,
    };
  });
}

/** Validate/normalise a PUT body into a governance record. Returns null on a
 *  bad shape (unknown id, bad enum). `updatedAt` is stamped by the caller. */
export function normalizeFlagGovernance(
  id: string,
  body: unknown,
  updatedAt: string,
): FlagGovernance | null {
  if (!isGovernableFlag(id)) return null;
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const rec: FlagGovernance = { id, updatedAt };
  if (b.default !== undefined && b.default !== null) {
    if (b.default !== 'on' && b.default !== 'off') return null;
    rec.default = b.default;
  }
  if (b.visibility !== undefined && b.visibility !== null) {
    if (b.visibility !== 'show' && b.visibility !== 'hide') return null;
    // 'show' is the absence of an opinion — store it only when it differs, so a
    // reset-to-defaults record collapses to {} and the version stays stable.
    if (b.visibility === 'hide') rec.visibility = 'hide';
  }
  return rec;
}

/** Fold governance into the org-config policyVersion so an admin edit busts the
 *  ETag and connected shells re-poll. Stable ordering ⇒ stable hash. */
export function flagGovernanceForVersion(gov: Map<string, FlagGovernance>) {
  return [...gov.values()]
    .filter((g) => g.default !== undefined || g.visibility !== undefined)
    .map((g) => ({ id: g.id, default: g.default ?? null, visibility: g.visibility ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
