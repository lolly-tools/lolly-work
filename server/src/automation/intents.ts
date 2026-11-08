// SPDX-License-Identifier: MPL-2.0
/**
 * POST /api/v1/intents/resolve: say what a piece has to do, and hear which tool this
 * caller can render it with on each surface, the input values, what is missing and why.
 *
 * The decision is the engine's `resolveIntent`, the one `lolly intent` and the public MCP
 * server run. No model is in this path, a prompt is carried and never read, and the same
 * request and the same tools give the same answer. The engine has no idea of permission:
 * it takes the tools it may consider. So this module's job is the list it is given, built
 * from the same rules discovery and the render routes enforce with:
 *
 *  - a tool this caller cannot render is not in the list, so no part of the answer names it;
 *  - a tool this deployment or policy leaves with no format is not in the list either;
 *  - what is left is narrowed by input policy, so an answer never hands back a value the
 *    render route would refuse;
 *  - an input the caller's company fills (plans/82 M3) is the server's, so a role it fills
 *    is met and the answer leaves the value to the server;
 *  - a published template in the caller's feed that declares purposes (plans/82 M7) is a
 *    candidate of its own, with its fixed inputs set. A surface it is chosen for names the
 *    base tool with `inputs.template`, which is how a render starts from a template; its
 *    candidates and refusals name the template by its id.
 *
 * Nothing is kept. Like `POST /api/v1/validate`, this route writes no audit record because
 * it changes nothing and makes nothing. There is no background mode, because a job record
 * would hold the request. The request's text is never logged: the prompt and the other
 * free text come back in the answer to the caller who sent them and go nowhere else.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { TOOL_INTENTS_FILE, type IntentResolutionV1, type IntentToolFactsV1 } from '@lolly-tools/core/intent-v1';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import { BrandError } from '../brand/service.ts';
import { projectRuleOverlay } from '../brand/rules.ts';
import { checkParams, resolveInputAccess, type ToolOverlay } from '../policy/overlay.ts';
import { templateOverlay, templateSeed, type RenderTemplate } from '../catalog/templates.ts';
import { loadEngine } from '../render/contract.ts';
import { describeTool } from './verbs.ts';
import { mayRenderTool, policyFormats } from './effective-contract.ts';
import type { DiscoveryCaller, DiscoveryDeps } from './discovery.ts';

export const INTENTS_RESOLVE_PATH = '/api/v1/intents/resolve';
const MAX_BODY_BYTES = 512 * 1024;

/** A type no role takes, for an input this caller cannot set. The resolver cannot fill
 *  it or offer its options, and its value still decides which other inputs show. */
export const NOT_THE_CALLERS = 'set-by-policy';

const optionValue = (option: unknown): unknown =>
  option && typeof option === 'object' && 'value' in option ? (option as { value: unknown }).value : option;

const hasValue = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/**
 * One tool's facts as this caller can use them. A locked or hidden input belongs to the
 * server, so a role that needs one is met when the server has a value for it. So does an
 * input the caller's company fills (`serverValues`, plans/82 M3): it is set by the server
 * whether the company's rule locks it or only fills it, and a role it fills is met. A
 * purpose or a declared surface that depends on a value this caller may not set is not
 * offered, because the piece it describes is not one this caller can make.
 */
export function callerToolFacts(tool: IntentToolFactsV1, formats: readonly string[], overlay: ToolOverlay | undefined, groups: string[], serverValues: Record<string, unknown> = {}): IntentToolFactsV1 {
  const may = (values: Record<string, unknown>): boolean => checkParams(values, overlay, groups).length === 0;
  const filled = (inputId: string): boolean => Object.hasOwn(serverValues, inputId) && hasValue(serverValues[inputId]);
  const inputs = (tool.inputs ?? []).map((input) => {
    const access = resolveInputAccess(overlay, input.id, groups);
    if (access.level === 'locked' || access.level === 'hidden' || filled(input.id)) {
      // The company's value wins over a fixed one: a bound input renders with it.
      const value = filled(input.id) ? serverValues[input.id] : 'value' in access && access.value !== undefined ? access.value : input.default;
      return { id: input.id, type: NOT_THE_CALLERS, ...(value !== undefined ? { default: value } : {}), ...(input.showIf !== undefined ? { showIf: input.showIf } : {}) };
    }
    if (access.level !== 'choice' || !access.allow) return input;
    if (input.type === 'select') return { ...input, options: (input.options ?? []).filter(option => access.allow!.some(value => value === optionValue(option))) };
    // Only a select has its choices where the resolver can read them.
    return { ...input, type: NOT_THE_CALLERS };
  });
  const serverMeets = (inputId: string): boolean => {
    if (filled(inputId)) return true;
    const access = resolveInputAccess(overlay, inputId, groups);
    if (access.level !== 'locked' && access.level !== 'hidden') return false;
    return hasValue(inputs.find(input => input.id === inputId)?.default);
  };
  const intents = (tool.intents ?? []).filter(entry => may(entry.set ?? {})).map(entry => ({
    ...entry,
    ...(entry.needs ? { needs: entry.needs.filter(role => !serverMeets(entry.roles && Object.hasOwn(entry.roles, role) ? entry.roles[role]! : role)) } : {}),
    ...(entry.surfaces ? { surfaces: Object.fromEntries(Object.entries(entry.surfaces).filter(([, values]) => may(values))) } : {}),
  }));
  return { ...tool, inputs, intents, render: { ...tool.render, formats } };
}

/** The values a caller's company fills, by input id: only the bound inputs it has a value for. */
function companyFilled(company: { defaults: Record<string, unknown>; bindings?: Record<string, string> } | null): Record<string, unknown> {
  if (!company?.bindings) return {};
  return Object.fromEntries(Object.keys(company.bindings).filter((id) => Object.hasOwn(company.defaults, id) && hasValue(company.defaults[id])).map((id) => [id, company.defaults[id]]));
}

/**
 * One published template as a candidate of its own (plans/82 M7): the base tool's facts
 * with the template's values as where each input starts, its rules over the tool's own,
 * and its declared purposes. Fixed inputs are the server's; so are the ones the caller's
 * company fills. Its id is the template's, so it is never folded into its base tool.
 */
export function templateToolFacts(base: IntentToolFactsV1, template: RenderTemplate, formats: readonly string[], overlay: ToolOverlay | undefined, groups: string[], serverValues: Record<string, unknown> = {}): IntentToolFactsV1 {
  const ids = (base.inputs ?? []).map((input) => input.id);
  const start = templateSeed(template.values, ids);
  const inputs = (base.inputs ?? []).map((input) => Object.hasOwn(start, input.id) ? { ...input, default: start[input.id] } : input);
  return callerToolFacts({ ...base, id: template.id, name: template.name, inputs, intents: template.intents ?? [] }, formats,
    templateOverlay(overlay, template, groups, ids), groups, serverValues);
}

/**
 * The answer as a render takes it: a surface chosen for a template names the base tool
 * and starts from the template (`inputs.template`), and the record of what was chosen
 * names the base tool too. Candidates, refusals and the purpose list name the template
 * by its id, so an agent can tell which template each one was.
 */
export function asTemplateRenders(resolution: IntentResolutionV1, templates: ReadonlyMap<string, string>): IntentResolutionV1 {
  if (!templates.size) return resolution;
  const sorted = (values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    ...resolution,
    closed: { ...resolution.closed, chosen: resolution.closed.chosen.map((c) => (c.toolId && templates.has(c.toolId) ? { ...c, toolId: templates.get(c.toolId)! } : c)) },
    surfaces: resolution.surfaces.map((surface) => {
      const chosen = surface.chosen;
      if (!chosen || !templates.has(chosen.toolId)) return surface;
      return { ...surface, chosen: { ...chosen, toolId: templates.get(chosen.toolId)!, inputs: sorted({ ...chosen.inputs, template: chosen.toolId }) } };
    }),
  };
}

async function readSidecar(pack: string, toolId: string): Promise<string | null> {
  try { return await readFile(join(pack, 'tools', toolId, TOOL_INTENTS_FILE), 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

const warned = new Set<string>();

/** Every tool and published template that serves a purpose and that this caller can
 *  render here, as the resolver reads them, and which ids are templates of which tool. */
async function callerTools(deps: DiscoveryDeps, caller: DiscoveryCaller, ids: readonly string[], overlays: Map<string, ToolOverlay>): Promise<{ tools: IntentToolFactsV1[]; templates: Map<string, string> }> {
  const engine = await loadEngine();
  const role = caller.user?.role;
  const [templatesOnly, templates] = await Promise.all([
    deps.templatesOnly ? deps.templatesOnly(caller.groups, role) : new Set<string>(),
    deps.intentTemplates ? deps.intentTemplates(caller.groups) : [],
  ]);
  const usable = new Set(ids);
  const templated = templates.filter((template) => usable.has(template.toolId) && template.intents?.length && !template.retired);
  // A tool's facts for this caller, before its purposes: its formats here and its policy
  // with the caller's company values and the design-system rules over it.
  const factsOf = async (id: string) => {
    const described = await describeTool({ pack: deps.pack(), profile: {} }, id, { caps: deps.caps, allowHooksInFastPath: deps.allowHooksInFastPath, tokens: deps.tokens() }).catch(() => null);
    if (!described) return null;
    const original = overlays.get(id);
    const { formats } = policyFormats(described.server.formats, original);
    if (!formats.length) return null;
    const company = deps.companyOverlay ? await deps.companyOverlay(id, caller.groups, original) : null;
    const rules = await deps.managedRules(id);
    const bound = company ? company.overlay : original;
    const overlay = rules ? projectRuleOverlay(bound, rules, caller.groups) : bound;
    return { manifest: described.manifest as unknown as IntentToolFactsV1, formats, overlay, filled: companyFilled(company) };
  };
  const facts = new Map<string, Awaited<ReturnType<typeof factsOf>>>();
  for (const id of new Set([...ids, ...templated.map((t) => t.toolId)])) facts.set(id, await factsOf(id));

  const found = await Promise.all(ids.map(async (id): Promise<IntentToolFactsV1 | null> => {
    // A tool used here only through its templates is offered only as those templates.
    if (templatesOnly.has(id)) return null;
    const text = await readSidecar(deps.pack(), id);
    if (text === null) return null;
    const parsed = engine.parseToolIntents(text);
    if (!parsed.ok) {
      if (!warned.has(id)) { warned.add(id); console.warn(`[lolly-work] tool ${id}: ${TOOL_INTENTS_FILE} does not parse, so no intent can choose this tool`); }
      return null;
    }
    // A tool that does not load here cannot render here. Discovery reports why.
    const own = facts.get(id);
    if (!own) return null;
    return callerToolFacts({ ...own.manifest, intents: parsed.intents }, own.formats, own.overlay, caller.groups, own.filled);
  }));
  const map = new Map<string, string>();
  for (const template of templated) {
    const own = facts.get(template.toolId);
    if (!own) continue;
    const filled = deps.templateCompanyValues ? await deps.templateCompanyValues(template, caller.groups) : {};
    found.push(templateToolFacts(own.manifest, template, own.formats, own.overlay, caller.groups, { ...own.filled, ...filled }));
    map.set(template.id, template.toolId);
  }
  return { tools: found.filter(tool => tool !== null), templates: map };
}

async function resolve(res: ServerResponse, deps: DiscoveryDeps, caller: DiscoveryCaller, body: unknown): Promise<void> {
  const engine = await loadEngine();
  try {
    // A request that cannot be read is refused before any tool is loaded for it.
    const parsed = engine.parseVisualIntent(body);
    if (!parsed.ok) throw new engine.IntentInvalidError(parsed.errors);
    const [overlays, grants] = await Promise.all([deps.overlays(), deps.grants()]);
    const all = deps.toolIds();
    const ids = all.filter(id => mayRenderTool(caller.user, id, overlays, grants, deps.accessMode));
    // Otherwise a caller with no rights would hear that no tool serves the purpose.
    if (all.length && !ids.length) return sendError(res, caller.user ? 403 : 401, caller.user ? 'FORBIDDEN' : 'UNAUTHORIZED', 'tool.use and export.server required');
    const { tools, templates } = await callerTools(deps, caller, ids, overlays);
    sendJson(res, 200, asTemplateRenders(await engine.resolveIntent(body, tools), templates));
  } catch (error) {
    if (error instanceof engine.IntentInvalidError) return sendError(res, 400, 'INTENT_INVALID', 'This intent was refused. errors lists each problem.', { errors: error.errors });
    if (error instanceof BrandError) return sendError(res, error.status, error.code, error.message);
    throw error;
  }
}

export function registerIntentRoutes(router: ReturnType<typeof createRouter>, deps: DiscoveryDeps): void {
  router.add('POST', INTENTS_RESOLVE_PATH, async (req, res) => {
    const caller = await deps.caller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    let body: unknown;
    try { body = await readJson(req, MAX_BODY_BYTES); }
    catch (error) {
      if ((error as { status?: number }).status === 413) return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `an intent request is at most ${MAX_BODY_BYTES} bytes`);
      return sendError(res, 400, 'INVALID_INPUT', 'JSON body required');
    }
    await resolve(res, deps, caller, body);
  });
}
