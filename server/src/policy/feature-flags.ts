/**
 * Feature-flag governance - the control plane's opinion on the per-user shell
 * flags (`profile.featureFlags` in the OSS shell, see its `feature-flags.ts`).
 *
 * Two knobs per flag, set for the whole instance:
 *   - `default`  the state a user gets when they haven't set the flag themselves.
 *                Unset ⇒ inherit the shell's own built-in default.
 *   - `visibility`  whether the user sees a toggle at all. `hide` removes the
 *                control from the profile view; the resolved default still
 *                applies. This is what lets a seasonal surprise (Pride, Apr 1)
 *                ship dark - set default `off` + `hide` now, flip to `on` on the
 *                day and it lights up without ever having shown a switch.
 *
 * Group rules (`groups`) set the same two knobs for members of named groups,
 * so one team can pilot a feature. Precedence, per knob, for one person:
 *   1. a group rule for a group the person is in, over the instance setting;
 *   2. when several of the person's groups have a rule, `off` beats `on` and
 *      `hide` beats `show`, whatever order the rules were added in (the
 *      deny-wins habit of grants, so the outcome never depends on ordering);
 *   3. otherwise the instance setting, then the shell's built-in default.
 * An organisation's own flag service (policy/ofrep.ts) can decide the default
 * above all of these; this module is what it falls back to.
 *
 * The control plane can only govern flags it knows about - GOVERNABLE_FLAGS
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
  /** A service switch only the instance setting decides: no group rules and
   *  no flag service. Managed AI is one (policy/ai.ts): its stop switch is
   *  audited, and nothing outside Work may grant AI execution. */
  instanceOnly?: boolean;
}

/** The flags this control plane can govern. Ids are the shell's flag ids. */
export const GOVERNABLE_FLAGS: readonly GovernableFlag[] = [
  {
    id: 'ai',
    label: 'Managed AI',
    builtinDefault: false,
    instanceOnly: true,
    info: 'Service switch for AI execution. Off or Inherit stops managed AI. On permits only capabilities approved in policy.ai; members cannot override it. Updated shells renew every 30 seconds and stop on renewal failure or after a 60-second lease. The first production profile keeps the configuration ceiling off.',
  },
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
    // when the shell moves - never on its own.
    builtinDefault: true,
    info: 'Lets two devices co-edit one tool session directly, with no account and no server in between. On by default for everyone; the app still labels it beta. Nothing reaches the network until someone starts or accepts a collab. A deployment that wants all collaboration to go through the control plane can force this off and hide the toggle, which overrides any personal choice.',
  },
  {
    id: 'nearby-discovery',
    label: 'Nearby discovery',
    // ON by default, matching the shell's own default (OSS shells/web/src/feature-flags.ts
    // NEARBY_DISCOVERY_FLAG). Mirrors purely to keep "inherit" honest, and moves only
    // when the shell moves. A fleet that must not have devices advertising themselves on
    // a network (or being discoverable to each other) forces this off and hides the
    // toggle. Only Tauri shells can actually discover - a browser build has no provider - 
    // so on a browser-only fleet this flag is inert, but governing it is still correct.
    builtinDefault: true,
    info: 'Lets nearby Lolly devices on the same network find each other (mDNS/DNS-SD), so an invite can be handed over by tapping a name instead of scanning a code (OSS plans/110). Native shells only; a browser cannot discover. A device is never discoverable until the user opts in for a set time, and the ceremony still confirms every pairing with matching plates. Force off + hide to keep devices off the local-network discovery lane fleet-wide.',
  },
] as const;

const FLAG_BY_ID = new Map<string, GovernableFlag>(GOVERNABLE_FLAGS.map((f) => [f.id, f]));
export function isGovernableFlag(id: string): boolean {
  return FLAG_BY_ID.has(id);
}
/** Whether group rules and a flag service may decide this flag. */
export function isGroupScopedFlag(id: string): boolean {
  const flag = FLAG_BY_ID.get(id);
  return !!flag && !flag.instanceOnly;
}

export type FlagDefault = 'on' | 'off';
export type FlagVisibility = 'show' | 'hide';

/** One group's opinion on a flag. An absent field is no opinion, so the
 *  instance setting applies to it. Unlike the instance setting, `show` is
 *  stored here: it is how a pilot group sees a toggle hidden from everyone else. */
export interface FlagGroupRule {
  group: string;
  default?: FlagDefault;
  visibility?: FlagVisibility;
}

/** The most group rules one flag may carry. */
export const MAX_FLAG_GROUP_RULES = 100;
/** A group name as identity providers send them: one line, at most 128
 *  characters, no outer whitespace. `*` is the instance setting, not a group. */
const GROUP_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;

/** The stored governance record for one flag. Absent fields mean "no opinion":
 *  `default` unset ⇒ inherit the built-in; `visibility` unset ⇒ shown;
 *  `groups` absent ⇒ no group rules. Rules are sorted by group name. */
export interface FlagGovernance {
  id: string;
  default?: FlagDefault;
  visibility?: FlagVisibility;
  groups?: FlagGroupRule[];
  updatedAt: string;
}

/** Whether a record says anything at all; a store deletes one that does not. */
export function hasFlagOpinion(rec: FlagGovernance): boolean {
  return rec.default !== undefined || rec.visibility !== undefined || (rec.groups?.length ?? 0) > 0;
}

/** What a shell needs per flag: the resolved boolean default and whether the
 *  user-facing toggle is hidden. Emitted for EVERY governable flag so the shell
 *  has one authoritative source, even where the control plane set no override. */
export interface ResolvedFlag {
  default: boolean;
  hidden: boolean;
}

/**
 * Resolve every governable flag for one person. `groups` are the person's
 * effective groups; without them only the instance settings apply. See the
 * header for the precedence.
 */
export function resolveFeatureFlags(gov: Map<string, FlagGovernance>, groups: readonly string[] = []): Record<string, ResolvedFlag> {
  const member = new Set(groups);
  const out: Record<string, ResolvedFlag> = {};
  for (const flag of GOVERNABLE_FLAGS) {
    const g = gov.get(flag.id);
    let on = g?.default ? g.default === 'on' : flag.builtinDefault;
    let hidden = g?.visibility === 'hide';
    if (!flag.instanceOnly && g?.groups?.length && member.size) {
      const matched = g.groups.filter((r) => member.has(r.group));
      const defaults = matched.flatMap((r) => (r.default ? [r.default] : []));
      if (defaults.length) on = !defaults.includes('off');
      const visibilities = matched.flatMap((r) => (r.visibility ? [r.visibility] : []));
      if (visibilities.length) hidden = visibilities.includes('hide');
    }
    out[flag.id] = { default: on, hidden };
  }
  return out;
}

/** The admin-facing catalogue: each governable flag with its built-in default
 *  and the current override (null when none), for the console tab. */
export function flagGovernanceCatalog(gov: Map<string, FlagGovernance>, opts: { flagService?: readonly string[] } = {}) {
  const decided = new Set(opts.flagService ?? []);
  return GOVERNABLE_FLAGS.map((f) => {
    const g = gov.get(f.id);
    return {
      id: f.id,
      label: f.label,
      info: f.info ?? null,
      builtinDefault: f.builtinDefault,
      default: g?.default ?? null, // null ⇒ inherit the built-in
      visibility: g?.visibility ?? 'show',
      // Group rules apply to every flag but an instance-only switch.
      groupRules: !f.instanceOnly,
      groups: (g?.groups ?? []).map((r) => ({ group: r.group, default: r.default ?? null, visibility: r.visibility ?? null })),
      // Whether the configured flag service decides this flag's default.
      flagService: decided.has(f.id),
      updatedAt: g?.updatedAt ?? null,
    };
  });
}

/** Validate one group rule; null on a bad shape. A rule with no opinion
 *  normalises to `{ group }` and the caller drops it. */
function normalizeGroupRule(raw: unknown): FlagGroupRule | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['group', 'default', 'visibility'].includes(k))) return null;
  if (typeof r.group !== 'string' || r.group !== r.group.trim() || r.group === '*' || !GROUP_NAME.test(r.group)) return null;
  const rule: FlagGroupRule = { group: r.group };
  if (r.default !== undefined && r.default !== null) {
    if (r.default !== 'on' && r.default !== 'off') return null;
    rule.default = r.default;
  }
  if (r.visibility !== undefined && r.visibility !== null) {
    if (r.visibility !== 'show' && r.visibility !== 'hide') return null;
    rule.visibility = r.visibility;
  }
  return rule;
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
    // 'show' is the absence of an opinion - store it only when it differs, so a
    // reset-to-defaults record collapses to {} and the version stays stable.
    if (b.visibility === 'hide') rec.visibility = 'hide';
  }
  if (b.groups !== undefined && b.groups !== null) {
    if (!Array.isArray(b.groups) || b.groups.length > MAX_FLAG_GROUP_RULES) return null;
    const rules: FlagGroupRule[] = [];
    const seen = new Set<string>();
    for (const raw of b.groups) {
      const rule = normalizeGroupRule(raw);
      // Two rules for one group would have no single meaning: refuse, never pick.
      if (!rule || seen.has(rule.group)) return null;
      seen.add(rule.group);
      if (rule.default !== undefined || rule.visibility !== undefined) rules.push(rule);
    }
    // An instance-only switch takes no group rules at all.
    if (rules.length && !isGroupScopedFlag(id)) return null;
    if (rules.length) rec.groups = rules.sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : 0));
  }
  return rec;
}

/** Fold governance into the org-config policyVersion so an admin edit busts the
 *  ETag and connected shells re-poll. Stable ordering ⇒ stable hash. */
export function flagGovernanceForVersion(gov: Map<string, FlagGovernance>) {
  return [...gov.values()]
    .filter(hasFlagOpinion)
    .map((g) => ({
      id: g.id, default: g.default ?? null, visibility: g.visibility ?? null,
      // Present only with rules, so a deployment without any keeps its version.
      ...(g.groups?.length ? { groups: g.groups.map((r) => ({ group: r.group, default: r.default ?? null, visibility: r.visibility ?? null })) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
