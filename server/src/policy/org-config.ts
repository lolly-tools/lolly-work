/**
 * The org-config payload - the ONE polled document a connected shell applies
 * (plans/01 §6). Everything a client needs to know about who it is and what
 * policy applies, pre-filtered for the caller's groups; ETag'd via
 * policyVersion so quiet polls are 304s.
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { renderCapabilities, type RenderCapabilities } from '../render/capabilities.ts';
import { filterInputs, resolveInputAccess, toolVisibleTo, type ToolOverlay, type ResolvedAccess } from './overlay.ts';
import { evaluate, grantDecision, mayEditCollab, type Grant, type Role } from '../rbac/evaluate.ts';
import { resolveFeatureFlags, flagGovernanceForVersion, type FlagGovernance, type ResolvedFlag } from './feature-flags.ts';
import { projectInjectables, flagInjectableGovernance, injectablesForVersion } from '../injectables/registry.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { UserRecord } from '../store/types.ts';

/** Actions whose yes/no the shell needs to render honest controls (e.g. the
 *  export button becoming "Save / Request approval"). Evaluated server-side;
 *  the server remains the boundary - these bits are UI truth, not security.
 *
 *  `collab.join`/`collab.edit` (OSS plans/100 §7 item 7) are what makes the
 *  shell's collab affordances honest instead of trial-and-error: `collab.join`
 *  mirrors `session.view` (rbac/evaluate.ts ROLE_ACTIONS - a room's read gate
 *  is project visibility, same as any other session read); `collab.edit` is
 *  computed below via `mayEditCollab`, NOT the generic per-action evaluate()
 *  every other entry here uses - it is `session.edit` itself, by construction,
 *  so it can never disagree with the gateway's writer decision (see
 *  `mayEditCollab`'s own doc comment and `server/src/collab/gateway.ts`). */
const CLIENT_ACTIONS = [
  'export.download', 'export.request', 'export.server',
  'link.create', 'link.create-guest',
  'session.create', 'session.share',
  'collab.join', 'collab.edit',
] as const;

export interface ProfileFieldPolicy {
  mode: 'editable' | 'locked' | 'hidden';
  source?: 'idp';
  value?: unknown;
}

export interface OrgConfigPayload {
  instance: { name: string };
  session: {
    sub: string;
    email: string;
    name: string;
    groups: string[];
    role: string;
  };
  profilePolicy: Record<string, ProfileFieldPolicy>;
  /** Per-tool policy for THIS caller: hidden tools absent; locked/choice inputs
   *  annotated; `hidden` names the input ids the shell must not render. */
  tools: Record<string, {
    inputs?: Array<{ id: string; access?: ResolvedAccess }>;
    hidden?: string[];
    /** The approval chain bound to this tool's outputs (overlay enforce.escalation),
     *  when one applies - the shell offers "Request approval" and submits against it. */
    approvalChain?: string;
    /** Server-export formats policy allows for THIS tool (overlay enforce.formats
     *  ∩ what the deployment can produce - plans/23 §3.A). Absent ⇒ no per-tool
     *  restriction; everything in `render.formats` is offered. */
    formats?: string[];
  }>;
  /** Permission bits for this caller (CLIENT_ACTIONS), for honest UI. */
  can: Record<string, boolean>;
  /** What this deployment can render server-side (plans/23 §3.A) - shells gray
   *  out or hide exports not offered here instead of discovering the limit by
   *  501/400. Deployment-scoped, same for every caller; the render route stays
   *  the boundary. Folded into policyVersion so enabling a worker moves the
   *  ETag and connected shells re-fetch instead of sitting on a stale 304. */
  render: RenderCapabilities;
  /** Control-plane governance for the shell's per-user feature flags, by flag id:
   *  the resolved default (applied when the user hasn't set the flag) and whether
   *  the toggle is hidden. Instance-wide - the same for every caller. Flag-kind
   *  injectables (plans/19) merge in here, so the shell needs no new path for them. */
  featureFlags: Record<string, ResolvedFlag>;
  /** The injectables visible to THIS caller (plans/19) - declarative descriptors
   *  the shell consumes: tools, typed catalog resources, and UI chrome (flag-kind
   *  ones ride `featureFlags` above). Group-scoped; genuinely-hidden ones absent. */
  injectables: Array<Record<string, unknown>>;
  telemetry: { level: string; attribution: string; consented: boolean };
  inboxUnread: number;
  policyVersion: string;
}

/** SUSE-decided default profile policy: identity fields lock to the IdP (plans/04 §2). */
export function defaultProfilePolicy(user: UserRecord): Record<string, ProfileFieldPolicy> {
  const lock = (value: unknown): ProfileFieldPolicy => ({ mode: 'locked', source: 'idp', value });
  const policy: Record<string, ProfileFieldPolicy> = {
    firstname: lock(user.firstname ?? ''),
    lastname: lock(user.lastname ?? ''),
    email: lock(user.email),
    useDetails: { mode: 'hidden', value: true },
    featureFlags: { mode: 'hidden' },
  };
  if (user.title !== undefined) policy.title = lock(user.title);
  return policy;
}

export function policyVersionOf(
  overlays: Map<string, ToolOverlay>,
  profilePolicy: Record<string, ProfileFieldPolicy>,
  flagGovernance?: Map<string, FlagGovernance>,
  injectables?: Map<string, InjectableRecord>,
  render?: RenderCapabilities,
  nearbyEnabled: boolean = true,
): string {
  const doc = {
    overlays: [...overlays.values()].sort((a, b) => a.toolId.localeCompare(b.toolId)),
    profilePolicy,
    featureFlags: flagGovernance ? flagGovernanceForVersion(flagGovernance) : [],
    // Any authored change to the injected set (publish/replace/revoke/re-scope)
    // moves the hash, so connected shells re-fetch on their next poll.
    injectables: injectables ? injectablesForVersion(injectables.values()) : [],
    // The render-capability block is part of the payload, so it must be part of
    // the version: without this term, enabling/disabling the Chromium worker
    // would leave every connected shell on a 304 with a stale capability set
    // until an unrelated policy edit happened to move the hash (plans/23 §3.A).
    render: render ?? renderCapabilities(false),
    // Same reasoning as render: `can['collab.nearby']` rides in the payload, so an
    // admin toggling policy.nearby.enabled must move the hash or connected shells
    // sit on a stale 304 with the wrong capability (plans/26 §8).
    nearby: nearbyEnabled,
  };
  return sha256Hex(canonicalJson(doc)).slice(0, 16);
}

export function assembleOrgConfig(opts: {
  config: InstanceConfig;
  user: UserRecord;
  overlays: Map<string, ToolOverlay>;
  grants?: Grant[];
  /** Declared inputs per tool id, from the pack's tool manifests (id is enough here). */
  toolInputs?: Map<string, Array<{ id: string }> | null>;
  /** Control-plane feature-flag governance (defaults + visibility). */
  flagGovernance?: Map<string, FlagGovernance>;
  /** The published injectables (plans/19), projected per-caller below. */
  injectables?: Map<string, InjectableRecord>;
  /** What the deployment can render (renderCapabilities(workerConfigured) - 
   *  app.ts computes it beside its worker resolution). Absent ⇒ the light
   *  default (no worker), which is truthful for unit fixtures; the one
   *  production caller always passes the resolved value. */
  render?: RenderCapabilities;
  inboxUnread: number;
}): OrgConfigPayload {
  const { config, user, overlays, inboxUnread } = opts;
  const render = opts.render ?? renderCapabilities(false);
  const flagGovernance = opts.flagGovernance ?? new Map<string, FlagGovernance>();
  const injectables = opts.injectables ?? new Map<string, InjectableRecord>();
  const grants = opts.grants ?? [];
  const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
  const profilePolicy = defaultProfilePolicy(user);
  const tools: OrgConfigPayload['tools'] = {};
  for (const [toolId, overlay] of overlays) {
    // Visibility is overlay OR an explicit per-user/group tool.use ALLOW grant
    // (so a grant surfaces a tool outside the caller's groups); a matching DENY
    // wins over both (and over the role default, hence grantDecision not
    // evaluate). Genuinely-hidden tools stay ABSENT - the caller never learns.
    const decision = grantDecision(principal, 'tool.use', [`tool:${toolId}`, '*'], grants);
    if (decision === 'deny') continue;
    if (!(toolVisibleTo(overlay, user.groups) || decision === 'allow')) continue;
    const declared = opts.toolInputs?.get(toolId);
    const entry: OrgConfigPayload['tools'][string] = {};
    if (declared) {
      const filtered = filterInputs(declared, overlay, user.groups);
      // Only ship annotations - plain editable inputs need no policy row.
      const annotated = filtered.filter((i) => i.access);
      if (annotated.length) entry.inputs = annotated;
      const hidden = declared
        .filter((i) => resolveInputAccess(overlay, i.id, user.groups).level === 'hidden')
        .map((i) => i.id);
      if (hidden.length) entry.hidden = hidden;
    }
    if (overlay.enforce?.escalation) entry.approvalChain = overlay.enforce.escalation;
    // Intersected with the deployment's formats for honesty: an overlay may name
    // a format this deploy lacks, and offering it would put the 400 back in the
    // user's path. An empty intersection ships as [] - "no server export for
    // this tool" is itself the honest answer. 'jpeg' folds to 'jpg', matching
    // the render gate's normalisation.
    if (overlay.enforce?.formats) {
      entry.formats = overlay.enforce.formats
        .map((f) => (f === 'jpeg' ? 'jpg' : f))
        .filter((f) => render.formats.includes(f));
    }
    tools[toolId] = entry;
  }
  const can: Record<string, boolean> = {};
  for (const action of CLIENT_ACTIONS) {
    // collab.edit is the one bit in this table that is NOT its own action:
    // routing it through mayEditCollab (rather than evaluate(principal,
    // 'collab.edit', …), which would consult grants keyed to a DIFFERENT
    // action string) is what keeps this bit and the gateway's writer
    // decision structurally unable to drift apart.
    can[action] = action === 'collab.edit' ? mayEditCollab(principal, grants) : evaluate(principal, action, ['*'], grants);
  }
  // collab.nearby is a DERIVED bit, not an RBAC action: the instance offers the
  // "likely nearby" grouping (plans/26 §8) only when policy enables it AND the
  // caller could join a collab at all. Never its own action string, so it cannot
  // drift from collab.join - the same discipline the collab.edit note above keeps.
  // `?? true` mirrors the loaded-config default (parseConfig deep-merges nearby in);
  // hand-built test configs that omit `policy.nearby` get the enabled default.
  can['collab.nearby'] = (config.policy.nearby?.enabled ?? true) && can['collab.join'] === true;
  return {
    instance: { name: config.instance.name },
    session: {
      sub: user.sub,
      email: user.email,
      name: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.email,
      groups: user.groups,
      role: user.role,
    },
    profilePolicy,
    tools,
    can,
    render,
    // Flag-kind injectables merge into the flag map, but only where the dedicated
    // feature-flag governance has NO explicit opinion - so the two rails never
    // fight and the more-specific governance always wins (plans/19 §3).
    featureFlags: (() => {
      const base = resolveFeatureFlags(flagGovernance);
      for (const [flagId, g] of flagInjectableGovernance(injectables.values(), user.groups)) {
        if (!flagGovernance.has(flagId) && flagId in base) base[flagId] = { default: g.default === 'on', hidden: g.hidden };
      }
      return base;
    })(),
    injectables: projectInjectables(injectables.values(), user.groups),
    telemetry: {
      level: config.policy.telemetry,
      attribution: config.policy.telemetryAttribution,
      consented: user.telemetryConsent === true,
    },
    inboxUnread,
    policyVersion: policyVersionOf(overlays, profilePolicy, flagGovernance, injectables, render, config.policy.nearby?.enabled ?? true),
  };
}
