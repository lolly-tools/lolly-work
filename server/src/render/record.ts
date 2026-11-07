// SPDX-License-Identifier: MPL-2.0
/**
 * The Lolly record a server render writes into its Content Credential (Lolly
 * Work plans/82 M3, section 6, approved by Andy on 2026-11-07): the design
 * system and its theme choices, as the app writes them, and the partner a
 * piece was made for. Flat scalar keys in the credential's `environment`,
 * because Verify reads only scalars there.
 *
 * The partner keys are exactly the five approved ones and nothing more:
 * `partnerCompany`, `partnerCompanyLabel`, `partnerProfileRevision`,
 * `partnerProgramme` and `partnerProgrammeLabel`. Never recorded: the person,
 * a token's id or label, an agent's name or model, the contact's email or
 * phone, the address and the currency. Those may be drawn into the artwork as
 * values; they are never written as metadata.
 *
 * XMP on server files follows later, once the server reuses the engine's
 * image-meta writer.
 */
/** The partner a render was made for. */
export interface RenderPartner {
  company?: { id: string; name: string; revision: number };
  programme?: { id: string; name: string };
}

/** One theme group's choice, as the app records it (ExportThemeChoice). */
export interface RecordThemeChoice { group: string; kind?: string; id: string; name: string }

type TokenEngine = {
  readTokenAxes(doc: unknown): { axes: Array<{ group: string; kind?: string; options: Array<{ id: string; name: string }> }> };
  modeAxis(axes: unknown[]): unknown;
  resolveTokenSelection(doc: unknown, opts?: { selection?: Record<string, string> }): { choices: Record<string, string> };
};

const clip = (v: string, n: number): string => v.slice(0, n);

/**
 * The theme choices that drew a render, the way the engine's designRecordOf
 * records them for the app: every group with more than one option except the
 * light and dark group (the pixels show that), each with the option the
 * selection resolved to, so a canonical colourway nobody picked is recorded too.
 */
export function recordedThemes(engine: TokenEngine, doc: unknown, selection: Record<string, string> | null | undefined): RecordThemeChoice[] {
  if (!doc || typeof doc !== 'object') return [];
  let axes: ReturnType<TokenEngine['readTokenAxes']>['axes'];
  try { axes = engine.readTokenAxes(doc).axes; } catch { return []; }
  if (!axes.length) return [];
  const mode = engine.modeAxis(axes);
  let choices: Record<string, string>;
  try { choices = engine.resolveTokenSelection(doc, selection && Object.keys(selection).length ? { selection } : {}).choices; } catch { return []; }
  const out: RecordThemeChoice[] = [];
  for (const axis of axes) {
    if (out.length >= 16) break;
    if (axis === mode || axis.options.length < 2) continue;
    const option = axis.options.find((o) => o.id === choices[axis.group]);
    if (!option) continue;
    out.push({ group: clip(axis.group, 120), ...(axis.kind ? { kind: axis.kind } : {}), id: clip(option.id, 120), name: clip(option.name, 120) || clip(option.id, 120) });
  }
  return out;
}

/** The credential's environment keys for one render. Empty when there is nothing to record. */
export function recordEnvironment(opts: {
  designSystem?: { id: string; label: string } | null;
  themes?: readonly RecordThemeChoice[];
  partner?: RenderPartner | null;
  /** The engine's own writer for the design system half, so the keys match the app's. */
  designRecordEnvironment(meta: { designSystem?: { id: string; label: string }; themes?: RecordThemeChoice[] }): Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {
    ...opts.designRecordEnvironment({
      ...(opts.designSystem ? { designSystem: opts.designSystem } : {}),
      ...(opts.themes?.length ? { themes: [...opts.themes] } : {}),
    }),
  };
  const company = opts.partner?.company;
  const programme = opts.partner?.programme;
  if (company) {
    out.partnerCompany = company.id;
    out.partnerCompanyLabel = company.name;
    out.partnerProfileRevision = String(company.revision);
  }
  if (programme) {
    out.partnerProgramme = programme.id;
    out.partnerProgrammeLabel = programme.name;
  }
  return out;
}

/** "Partner: Northwind IT", the line a render record and the MCP's answer carry,
 *  so an agent can read back what the file says. */
export function partnerLine(partner: RenderPartner | null | undefined): string | null {
  return partner?.company ? `Partner: ${partner.company.name}` : null;
}
