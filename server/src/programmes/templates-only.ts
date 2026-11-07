// SPDX-License-Identifier: MPL-2.0
/**
 * Templates only (plans/82 M2 W5, Andy 2026-11-07): a switch per programme and per
 * tool, "Partners use <tool> only through its published templates". Off by default,
 * so a programme that never sets it is unchanged.
 *
 * When a programme turns it on for a tool, for the people in that programme and its
 * companies:
 *   - the served tool index marks the tool unlisted, so it leaves their gallery and
 *     search, and says `templatesOnly`, so the tool's Start chooser offers only the
 *     templates published to them. Its files are still served: the templates need them;
 *   - a server, API or MCP render of the tool that names no template from their feed
 *     answers 422 TEMPLATE_REQUIRED, with the templates they may use.
 * Copies saved before the switch keep opening (decision D2).
 *
 * Across programmes the stricter rule wins (decision 9): one programme turning it on
 * is enough, and Preview says which programme did. Admins and owners are never
 * scoped to a programme, so the switch never reaches them.
 */
import type { CompanyRecord } from './people.ts';
import { COMPANY_GROUP_PREFIX, isProgrammeScoped, programmeGroup, type ProgrammeRecord } from './types.ts';

/** For each templates-only tool, the programmes that set it, by name. */
export type TemplatesOnly = Map<string, Array<{ id: string; name: string }>>;

/** Tool ids are the pack's own slugs. */
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isTemplatesOnlyToolId(id: unknown): id is string {
  return typeof id === 'string' && TOOL_ID.test(id);
}

/**
 * The templates-only tools for someone with these groups: every tool a programme
 * they are in, directly or through one of its companies, turned the switch on for.
 */
export function templatesOnlyFor(
  programmes: readonly ProgrammeRecord[],
  companies: readonly CompanyRecord[],
  groups: readonly string[],
  role?: string,
): TemplatesOnly {
  const out: TemplatesOnly = new Map();
  if (!isProgrammeScoped(groups, role)) return out;
  const mine = new Set(groups);
  for (const programme of programmes) {
    if (!programme.templatesOnly?.length) continue;
    const reaches = mine.has(programmeGroup(programme.id))
      || companies.some((c) => c.programmeId === programme.id && mine.has(`${COMPANY_GROUP_PREFIX}${c.id}`));
    if (!reaches) continue;
    for (const toolId of programme.templatesOnly) {
      const setBy = out.get(toolId) ?? [];
      if (!setBy.some((p) => p.id === programme.id)) setBy.push({ id: programme.id, name: programme.name });
      out.set(toolId, setBy);
    }
  }
  for (const setBy of out.values()) setBy.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** A programme's switch turned on or off for one tool, as its next record. */
export function withTemplatesOnly(programme: ProgrammeRecord, toolId: string, on: boolean): ProgrammeRecord {
  const next = new Set(programme.templatesOnly ?? []);
  if (on) next.add(toolId); else next.delete(toolId);
  const { templatesOnly: _was, ...rest } = programme;
  void _was;
  return { ...rest, ...(next.size ? { templatesOnly: [...next].sort() } : {}) };
}
