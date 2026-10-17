// SPDX-License-Identifier: MPL-2.0
/**
 * The effective contract for one caller and one tool (Work plan 42): the raw
 * input schema narrowed by the caller's tool policy, the formats the policy
 * allows, and the tool permission checks. Schema, compile, validate, batch and
 * render read policy through the same overlay functions (policy/overlay.ts), so
 * what discovery describes is what execution accepts.
 *
 * Nothing here returns a value the caller could not already learn by using the
 * tool: a hidden input is absent with no trace, a locked value is the one this
 * caller renders with, and attribution names the overlay and the rule's own
 * reason, never the groups a rule matched.
 */
import { evaluate, grantDecision, type Grant, type Role } from '../rbac/evaluate.ts';
import { checkParams, lockedValues, resolveInputAccess, toolVisibleTo, type ParamViolation, type ToolOverlay } from '../policy/overlay.ts';
import type { UnavailableFormat } from '../render/capabilities.ts';

/** One change policy made to the raw contract, with who made it and why. */
export interface PolicyEffect {
  effect: 'locked' | 'choice' | 'format-excluded';
  input?: string;
  format?: string;
  /** The overlay's display name, when it has one. */
  by?: string;
  /** The rule author's reason, when one was written. */
  reason?: string;
}

/** The account an automation request runs as: a member or service account, or
 *  null for an anonymous caller on an open deployment. */
export interface ToolCaller { id: string; groups: string[]; role: string }

type AccessMode = 'open' | 'gated' | 'per-tool';

/** `tool.use` for automation: an explicit deny wins, a hidden tool needs an
 *  explicit allow, and the role default decides the rest. An anonymous caller
 *  may use a tool only on an open deployment and only when no visibility rule
 *  hides it from everyone. */
export function mayUseTool(user: ToolCaller | null, toolId: string, overlays: Map<string, ToolOverlay>, grants: Grant[], mode: AccessMode): boolean {
  if (!user) return mode === 'open' && toolVisibleTo(overlays.get(toolId), []);
  const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
  const resources = [`tool:${toolId}`, '*'];
  const decision = grantDecision(principal, 'tool.use', resources, grants);
  if (decision === 'deny') return false;
  if (!toolVisibleTo(overlays.get(toolId), user.groups) && decision !== 'allow') return false;
  return evaluate(principal, 'tool.use', resources, grants);
}

/** Server rendering needs `tool.use` and `export.server`. */
export function mayRenderTool(user: ToolCaller | null, toolId: string, overlays: Map<string, ToolOverlay>, grants: Grant[], mode: AccessMode): boolean {
  if (!mayUseTool(user, toolId, overlays, grants, mode)) return false;
  if (!user) return mode === 'open';
  return evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'export.server', [`tool:${toolId}`, '*'], grants);
}

const attribution = (access: { by?: string; reason?: string }) => ({ ...(access.by ? { by: access.by } : {}), ...(access.reason ? { reason: access.reason } : {}) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Narrow a raw tool input schema (the engine's documentSchema) for one caller.
 * Hidden inputs leave `properties` and `required` with no trace. A locked input
 * becomes `readOnly` with its locked value as `const` and `default`: the server
 * applies it, and a request that sends it is refused with INPUT_LOCKED. A choice
 * input gains an `enum` of the allowed values, intersected with any enum the
 * tool declares. Every locked or choice input gets one attribution entry.
 */
export function effectiveInputSchema(raw: Record<string, unknown>, overlay: ToolOverlay | undefined, groups: string[]): { schema: Record<string, unknown>; effects: PolicyEffect[] } {
  const rawProperties = (raw.properties && typeof raw.properties === 'object' ? raw.properties : {}) as Record<string, Record<string, unknown>>;
  const rawRequired = Array.isArray(raw.required) ? raw.required as string[] : [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const effects: PolicyEffect[] = [];
  for (const [id, property] of Object.entries(rawProperties)) {
    const access = resolveInputAccess(overlay, id, groups);
    if (access.level === 'hidden') continue;
    if (access.level === 'locked') {
      const { title, description } = property;
      properties[id] = {
        ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}),
        ...('value' in access ? { const: access.value, default: access.value } : property.default !== undefined ? { default: property.default } : {}),
        readOnly: true,
      };
      effects.push({ effect: 'locked', input: id, ...attribution(access) });
      continue;
    }
    if (access.level === 'choice' && access.allow) {
      const declared = Array.isArray(property.enum) ? property.enum as unknown[] : null;
      const allowed = declared ? access.allow.filter(value => declared.some(option => same(option, value))) : access.allow;
      properties[id] = { ...property, enum: allowed };
      effects.push({ effect: 'choice', input: id, ...attribution(access) });
    } else properties[id] = property;
    if (rawRequired.includes(id)) required.push(id);
  }
  const { required: _required, properties: _properties, ...rest } = raw;
  return { schema: { ...rest, properties, ...(required.length ? { required } : {}) }, effects };
}

/** Apply the overlay's format policy to the formats this deployment can render
 *  for the tool. A format the policy excludes becomes FORMAT_NOT_ALLOWED, the
 *  same code and status split the render route uses. */
export function policyFormats(formats: string[], overlay: ToolOverlay | undefined): { formats: string[]; unavailable: UnavailableFormat[]; effects: PolicyEffect[] } {
  const allowed = overlay?.enforce?.formats?.map(format => format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase());
  if (!allowed) return { formats, unavailable: [], effects: [] };
  const by = overlay?.name ? { by: overlay.name } : {};
  const excluded = formats.filter(format => !allowed.includes(format));
  return {
    formats: formats.filter(format => allowed.includes(format)),
    unavailable: excluded.map(format => ({ format, code: 'FORMAT_NOT_ALLOWED', reason: 'Tool policy does not allow this format for server rendering.' })),
    effects: excluded.map(format => ({ effect: 'format-excluded', format, ...by })),
  };
}

/** A request named inputs the caller's policy forbids. Routes answer 422 with
 *  the first violation's code, input and attribution, like the render route. */
export class PolicyRefusal extends Error {
  readonly code: ParamViolation['code'];
  readonly status = 422;
  readonly violations: ParamViolation[];
  constructor(violations: ParamViolation[]) {
    super(`Policy forbids these params for your access: ${violations.map(v => v.param).join(', ')}`);
    this.name = 'PolicyRefusal';
    this.code = violations[0]!.code;
    this.violations = violations;
  }
}

/** The inputs a compile runs with: refused when they name a locked, hidden or
 *  not-allowed input, otherwise the caller's values with locked values over
 *  them, the same order the render pipeline uses. */
export function applyInputPolicy(inputs: Record<string, unknown>, overlay: ToolOverlay | undefined, groups: string[]): Record<string, unknown> {
  const violations = checkParams(inputs, overlay, groups);
  if (violations.length) throw new PolicyRefusal(violations);
  return { ...inputs, ...lockedValues(overlay, groups) };
}

/** Policy violations as validation errors, so validate and batch row checks
 *  report the codes compile and render refuse with. */
export function policyErrors(inputs: Record<string, unknown>, overlay: ToolOverlay | undefined, groups: string[]): Array<{ path: string; message: string; code: string; by?: string; reason?: string }> {
  const message = { INPUT_LOCKED: 'is locked by policy', INPUT_HIDDEN: 'is not available to you', INPUT_NOT_ALLOWED: 'is not one of the values policy allows' } as const;
  return checkParams(inputs, overlay, groups).map(v => ({ path: `/${v.param}`, message: message[v.code], code: v.code, ...attribution(v) }));
}

/**
 * Turn the engine's raw validation result into the effective one. The server
 * supplies locked and hidden inputs, and the effective schema leaves them out of
 * `required`, so an error about one the caller did not send is dropped. Policy
 * violations in what the caller did send are added with their codes.
 */
export function effectiveValidation<T extends { ok: boolean; errors: unknown[] }>(result: T, supplied: Record<string, unknown>, overlay: ToolOverlay | undefined, groups: string[]): T {
  const serverOwned = (error: unknown) => {
    const path = (error as { path?: unknown })?.path;
    if (typeof path !== 'string' || !/^\/[^/]+$/.test(path)) return false;
    const id = path.slice(1);
    return !Object.hasOwn(supplied, id) && ['locked', 'hidden'].includes(resolveInputAccess(overlay, id, groups).level);
  };
  const errors = [...result.errors.filter(error => !serverOwned(error)), ...policyErrors(supplied, overlay, groups)];
  return { ...result, ok: errors.length === 0, errors };
}
