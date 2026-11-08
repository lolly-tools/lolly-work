// SPDX-License-Identifier: MPL-2.0
/**
 * Templates published to a partner programme (plans/82 M2), under
 * `programme.manage`, so whoever runs a programme publishes into it without
 * joining it (decision 3).
 *
 * A published template is an instance asset whose groups name programme or
 * company groups (catalog/templates.ts). Two kinds reach a programme:
 *   - a template of one of the pack's tools, published here from one already
 *     in the catalog, with the inputs partners may change;
 *   - a rules tool, a Share with rules file uploaded through the catalog submit
 *     route (catalog/rules-tools.ts), which brings its own rules.
 *
 * GET lists what a programme and its companies were given, and the catalog's
 * templates to publish from. POST publishes one. PUT changes who gets it and
 * what they may change. A new version, a retirement and a restore each have
 * their own route. Every change is audited as `programme.template.*`.
 *
 * Nothing here decides access: the served feed already gives a published
 * template to exactly the groups it names, and renders enforce its rules.
 *
 * Publishing also records the workspace's owner-published mark on what it
 * publishes (plans/82 M6, decision 5): scope `asset:<id>`, the workspace as
 * holder, the default terms and the publisher as the person who stated it,
 * audited `catalog.rights.mark` (catalog/rights.ts composes it into the served
 * entry, as for any mark). `ownerMark: false` leaves it off at publish, and the
 * update route turns it on or off later. Only staff who may edit the catalog
 * (`catalog.edit`) state or withdraw it, and only they may change the head of a
 * marked template. It holds only while the head is the workspace's own work
 * (programmes/owner-mark.ts), which every head change checks again.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, readRaw, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import { INST_PREFIX, instanceAssetEntry, submissionServable, type InstanceAssetRecord } from '../catalog/instance-assets.ts';
import { normalizeEditable, templateRetired } from '../catalog/templates.ts';
import { MAX_DATA_SUBMISSION_BYTES } from '../catalog/submit-data.ts';
import { MAX_RULES_FILE_BYTES, RULES_TOOL_TYPE } from '../catalog/rules-tools.ts';
import { randomId } from '../lib/crypto.ts';
import { COMPANY_GROUP_PREFIX, isPartnerGroup, programmeGroup, type ProgrammeRecord } from './types.ts';
import { isTemplatesOnlyToolId, withTemplatesOnly } from './templates-only.ts';
import { COMPANY_FIELDS, FIELD_LABELS, LOGO_FIELDS, normalizeBindings } from './company-values.ts';
import { markScopeKey, type AssetRightsMarkRecord } from '../catalog/rights.ts';
import { recordedScope, type OwnerMarks } from './owner-mark.ts';
import { headVersionOf, type CopiedFrom } from '../catalog/versions.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface ToolFacts { name: string; inputs: Array<{ id: string; label: string; type?: string }> }

export interface TemplateRouteDeps {
  store: Store;
  blobs: BlobStore;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  /** A pack tool's name and inputs, or null when the pack has no such tool. */
  toolFacts(toolId: string): Promise<ToolFacts | null>;
  /** Whether people in this programme group can open the tool on its own,
   *  outside any template's rules. */
  toolOpenTo(group: string, toolId: string): Promise<boolean>;
  /** New bytes for a published template, through the submit pipeline's
   *  version path, so the same checks run as for any version. */
  submitVersion(actor: UserRecord, target: InstanceAssetRecord, bytes: Buffer, from?: CopiedFrom): Promise<{ ok: true; version?: number } | { ok: false; status: number; code: string; detail: string }>;
  /** A Share with rules file, through the submit pipeline (catalog/rules-tools.ts),
   *  published to these groups by someone who manages programmes. */
  submitRulesFile(actor: UserRecord, bytes: Buffer, groups: string[]): Promise<{ ok: true; id: string; state: string; duplicate?: boolean } | { ok: false; status: number; code: string; detail: string }>;
  /** The workspace's own mark on what it publishes (programmes/owner-mark.ts). */
  ownerMarks: OwnerMarks;
  /** Whether this person may state or withdraw the workspace's mark: staff with `catalog.edit`. */
  mayStateMark(actor: UserRecord): Promise<boolean>;
  now?: () => Date;
}

/** The mark on a published template, as the Templates card shows it. */
export interface OwnerMarkView { holder: string; terms: string; statedBy: string; statedAt: string }

export const PUBLISHED_TYPES: ReadonlySet<string> = new Set(['template', RULES_TOOL_TYPE]);

/**
 * Retire a published template: new starts stop, saved copies keep working,
 * and renders that name it answer 410 with the replacement, when there is one.
 * Audited as `programme.template.retire`; `via` says when something other
 * than the Retire button did it (an ended partnership, plans/82 M5).
 */
export async function retireTemplate(
  store: Store, audit: Audit, actor: string, programmeId: string, rec: InstanceAssetRecord,
  opts: { at: string; replacedBy?: string; via?: string },
): Promise<void> {
  await store.putInstanceAsset({ ...rec, publication: { ...rec.publication, retiredAt: opts.at, retiredBy: actor, ...(opts.replacedBy ? { replacedBy: opts.replacedBy } : {}) } });
  await audit(actor, 'programme.template.retire', `programme:${programmeId}`, {
    template: rec.id, ...(opts.replacedBy ? { replacedBy: opts.replacedBy } : {}), ...(opts.via ? { via: opts.via } : {}),
  });
}

/** The groups a programme reaches: its own, and each of its companies'. */
async function programmeGroups(store: Store, programme: ProgrammeRecord): Promise<Map<string, string>> {
  const out = new Map<string, string>([[programmeGroup(programme.id), `Everyone in ${programme.name}`]]);
  for (const c of await store.listCompanies()) if (c.programmeId === programme.id) out.set(`${COMPANY_GROUP_PREFIX}${c.id}`, c.name);
  return out;
}

/** Plain-text label for any partner group, for the audience column. */
async function groupLabels(store: Store): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const p of await store.listProgrammes()) labels.set(programmeGroup(p.id), `Everyone in ${p.name}`);
  for (const c of await store.listCompanies()) labels.set(`${COMPANY_GROUP_PREFIX}${c.id}`, c.name);
  return labels;
}

const groupsOf = (rec: InstanceAssetRecord): string[] => (Array.isArray(rec.groups) ? rec.groups : []);

export function registerTemplateRoutes(router: Router, deps: TemplateRouteDeps): void {
  const { store, audit } = deps;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const manager = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'programme.manage');
  const programmeOr404 = async (res: ServerResponse, id: string): Promise<ProgrammeRecord | null> => {
    const programme = await store.getProgramme(id);
    if (!programme) sendError(res, 404, 'NOT_FOUND', 'no such programme');
    return programme;
  };
  /** A template published to this programme or one of its companies. */
  const publishedHere = async (res: ServerResponse, programme: ProgrammeRecord, assetId: string): Promise<InstanceAssetRecord | null> => {
    const rec = assetId.startsWith(INST_PREFIX) ? await store.getInstanceAsset(assetId) : null;
    const reach = await programmeGroups(store, programme);
    if (!rec || !PUBLISHED_TYPES.has(String(rec.entry.type)) || !groupsOf(rec).some((g) => reach.has(g))) {
      sendError(res, 404, 'NOT_FOUND', 'no such template in this programme');
      return null;
    }
    return rec;
  };
  /** A live template in the catalog itself, one not given to partners: what a
   *  programme's template is published from, or takes a new version from. */
  const catalogTemplate = async (id: unknown): Promise<InstanceAssetRecord | null> => {
    const rec = typeof id === 'string' && id.startsWith(INST_PREFIX) ? await store.getInstanceAsset(id) : null;
    return rec && rec.entry.type === 'template' && submissionServable(rec) && !groupsOf(rec).some(isPartnerGroup) ? rec : null;
  };
  const readTemplate = async (rec: InstanceAssetRecord): Promise<Buffer | null> => {
    const blob = rec.blobs.json ? await deps.blobs.get(rec.blobs.json) : null;
    return blob ? readBlobBody(blob.body, MAX_DATA_SUBMISSION_BYTES) : null;
  };
  const markScope = (assetId: string): string => markScopeKey({ kind: 'asset', id: assetId });
  const marks = deps.ownerMarks;
  const markView = async (mark: AssetRightsMarkRecord | undefined): Promise<OwnerMarkView | null> =>
    mark ? { holder: mark.holder, terms: mark.terms, statedBy: await nameOf(mark.statedBy) ?? mark.statedBy, statedAt: mark.statedAt } : null;
  /** A marked template's head changes only for someone who may state the mark: a
   *  change that is not the workspace's own work withdraws it, and that is theirs to do. */
  const mayChangeHead = async (actor: UserRecord, rec: InstanceAssetRecord): Promise<boolean> =>
    !(await marks.markOn(rec.id)) || deps.mayStateMark(actor);
  const ownerMarkFlag = (raw: unknown): boolean | { error: string } =>
    raw === undefined ? true : typeof raw === 'boolean' ? raw : { error: 'ownerMark must be true or false' };

  /** Validate a requested audience: partner groups only, at least one. */
  const audienceOf = (raw: unknown): string[] | { error: string } => {
    if (!Array.isArray(raw) || !raw.length) return { error: 'choose who gets it: a programme or a company' };
    const groups = [...new Set(raw.filter((g): g is string => typeof g === 'string').map((g) => g.trim()))];
    if (groups.length !== raw.length || groups.some((g) => !isPartnerGroup(g))) return { error: 'a template is published to partner programmes and companies only' };
    return groups;
  };
  const nameOf = async (id: string | undefined): Promise<string | undefined> => {
    if (!id) return undefined;
    const u = (await store.listUsers()).find((x) => x.id === id.replace(/^user:/, ''));
    return u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email : undefined;
  };

  router.add('GET', '/api/v1/programmes/:id/templates', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const reach = await programmeGroups(store, programme);
    const labels = await groupLabels(store);
    const companies = await store.listCompanies();
    const programmesByGroup = new Map((await store.listProgrammes()).map((p) => [programmeGroup(p.id), p]));
    const all = await store.listInstanceAssets();
    const marked = new Map((await store.listAssetRightsMarks()).map((m) => [m.scope, m]));
    const rows = [];
    for (const rec of all) {
      const type = String(rec.entry.type);
      if (!PUBLISHED_TYPES.has(type) || !groupsOf(rec).some((g) => reach.has(g)) || rec.submission?.state === 'returned') continue;
      const meta = (rec.entry.meta ?? {}) as { toolId?: string; toolVersion?: string; rebuilt?: boolean; inputs?: Array<{ id: string; label: string }> };
      const toolId = String(meta.toolId ?? '');
      const facts = type === 'template' ? await deps.toolFacts(toolId) : null;
      const replacedBy = rec.publication?.replacedBy;
      const replacement = replacedBy ? await store.getInstanceAsset(replacedBy) : null;
      // Programmes in the audience, directly or through one of their companies,
      // whose people can also open the base tool on its own.
      const openTo: string[] = [];
      if (type === 'template') {
        const audienceProgrammes = new Set(groupsOf(rec).flatMap((g) => g.startsWith('programme-') ? [g]
          : g.startsWith(COMPANY_GROUP_PREFIX) ? companies.filter((c) => `${COMPANY_GROUP_PREFIX}${c.id}` === g).map((c) => programmeGroup(c.programmeId)) : []));
        for (const g of audienceProgrammes) {
          // A programme set to templates only for this tool cannot open it on its own.
          if (programmesByGroup.get(g)?.templatesOnly?.includes(toolId)) continue;
          if (await deps.toolOpenTo(g, toolId)) openTo.push(labels.get(g)?.replace(/^Everyone in /, '') ?? g);
        }
      }
      rows.push({
        id: rec.id, name: String(rec.entry.name ?? rec.id), kind: type, toolId,
        toolName: type === 'template' ? facts?.name ?? toolId : 'Design',
        ...(typeof rec.entry.description === 'string' ? { description: rec.entry.description } : {}),
        groups: groupsOf(rec),
        audience: groupsOf(rec).map((g) => ({ group: g, label: labels.get(g) ?? g })),
        editable: type === 'template' ? rec.publication?.editable ?? null : (Array.isArray((meta as { editable?: unknown }).editable) ? (meta as { editable: string[] }).editable : []),
        inputs: type === 'template' ? facts?.inputs ?? [] : meta.inputs ?? [],
        // Colourway and mode: a tool template keeps them when its rules say so; a
        // Share with rules file leaves them open, as Design's own rules do.
        fixedTheme: type === 'template' && !!rec.publication?.fixedTheme,
        // Inputs that take the partner company's values (plans/82 M3).
        bindings: rec.publication?.bindings ?? null,
        // The workspace's mark, for the card's line and tick (plans/82 M6).
        ownerMark: await markView(marked.get(markScopeKey({ kind: 'asset', id: rec.id }))),
        version: rec.headVersion ?? 1,
        ...(meta.toolVersion ? { toolVersion: meta.toolVersion } : {}),
        ...(meta.rebuilt ? { rebuilt: true } : {}),
        state: rec.submission?.state ?? 'live',
        publishedAt: rec.createdAt,
        ...(rec.publication?.retiredAt ? { retired: {
          at: rec.publication.retiredAt, by: await nameOf(rec.publication.retiredBy) ?? rec.publication.retiredBy,
          ...(replacedBy ? { replacedBy, replacedByName: String(replacement?.entry.name ?? replacedBy) } : {}),
        } } : {}),
        ...(openTo.length ? { toolOpenTo: openTo } : {}),
      });
    }
    rows.sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || a.name.localeCompare(b.name));
    // The catalog's own templates, to publish from: live ones not given to
    // partners already, so publishing makes a programme's own copy.
    const candidates = [];
    for (const rec of all) {
      if (rec.entry.type !== 'template' || !submissionServable(rec) || groupsOf(rec).some(isPartnerGroup)) continue;
      const toolId = String((rec.entry.meta as { toolId?: unknown } | undefined)?.toolId ?? '');
      const facts = await deps.toolFacts(toolId);
      if (!facts) continue;
      candidates.push({ id: rec.id, name: String(rec.entry.name ?? rec.id), toolId, toolName: facts.name, inputs: facts.inputs });
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, {
      programme: programme.id,
      reach: [...reach].map(([group, label]) => ({ group, label })),
      templatesOnly: programme.templatesOnly ?? [],
      // Their names, for a switch shown with no live template of the tool to name it.
      templatesOnlyTools: await Promise.all((programme.templatesOnly ?? []).map(async (id) => ({ id, name: (await deps.toolFacts(id))?.name ?? id }))),
      templates: rows, candidates,
      // What a binding may name, for the "Takes from the company" picker.
      companyFields: COMPANY_FIELDS.map((id) => ({ id, label: FIELD_LABELS[id], kind: LOGO_FIELDS.has(id) ? 'logo' : 'text' })),
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Templates only (programmes/templates-only.ts): `{ on }` for one tool. Off by
   *  default; turning it on keeps this programme's people inside the templates
   *  published to them, and copies they saved before keep opening. */
  router.add('PUT', '/api/v1/programmes/:id/templates-only/:tool', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const toolId = String(ctx.params.tool);
    const body = ((await readJson(req)) ?? {}) as { on?: unknown };
    if (typeof body.on !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'on must be true or false');
    if (!isTemplatesOnlyToolId(toolId) || !(await deps.toolFacts(toolId))) return sendError(res, 404, 'NOT_FOUND', 'no such tool');
    const was = !!programme.templatesOnly?.includes(toolId);
    if (was !== body.on) {
      const next = withTemplatesOnly(programme, toolId, body.on);
      await store.putProgramme({ ...next, updatedAt: now(), version: programme.version + 1 });
      await audit(`user:${actor.id}`, 'programme.template.only', `programme:${programme.id}`, { toolId, on: body.on });
    }
    sendJson(res, 200, { programme: programme.id, toolId, on: body.on });
  });

  /** Publish one of the catalog's templates: `{ from, groups, editable?, fixedTheme?, bindings? }`. The
   *  programme gets its own copy, with its own versions, rules and retirement. */
  router.add('POST', '/api/v1/programmes/:id/templates', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const body = ((await readJson(req)) ?? {}) as { from?: unknown; groups?: unknown; editable?: unknown; fixedTheme?: unknown; bindings?: unknown; ownerMark?: unknown };
    if (body.fixedTheme !== undefined && typeof body.fixedTheme !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'fixedTheme must be true or false');
    const ownerMark = ownerMarkFlag(body.ownerMark);
    if (typeof ownerMark !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', ownerMark.error);
    const mayMark = await deps.mayStateMark(actor);
    if (body.ownerMark === true && !mayMark) return sendError(res, 403, 'FORBIDDEN', 'stating the workspace\'s own mark needs catalog.edit');
    const source = await catalogTemplate(body.from);
    if (!source) return sendError(res, 404, 'NOT_FOUND', 'no such template in the catalog');
    const groups = audienceOf(body.groups ?? [programmeGroup(programme.id)]);
    if (!Array.isArray(groups)) return sendError(res, 400, 'INVALID_INPUT', groups.error);
    const reach = await programmeGroups(store, programme);
    if (!groups.some((g) => reach.has(g))) return sendError(res, 400, 'INVALID_INPUT', `publish it to ${programme.name} or one of its companies from here`);
    const toolId = String((source.entry.meta as { toolId?: unknown } | undefined)?.toolId ?? '');
    const facts = await deps.toolFacts(toolId);
    if (!facts) return sendError(res, 409, 'TOOL_UNAVAILABLE', `this workspace no longer has the tool "${toolId}"`);
    const editable = normalizeEditable(body.editable, facts.inputs.map((i) => i.id));
    if ('error' in editable) return sendError(res, 400, 'INVALID_INPUT', editable.error);
    const bindings = normalizeBindings(body.bindings, facts.inputs.map((i) => i.id));
    if ('error' in bindings) return sendError(res, 400, 'INVALID_INPUT', bindings.error);
    const bytes = await readTemplate(source);
    if (!bytes) return sendError(res, 409, 'TEMPLATE_UNREADABLE', 'the template\'s bytes could not be read');
    const id = `${INST_PREFIX}${randomId(8)}`;
    const at = now();
    const stat = await deps.blobs.put(`${id}/json`, bytes, 'application/json');
    const record: InstanceAssetRecord = {
      id,
      entry: instanceAssetEntry(id, {
        name: source.entry.name, ...(source.entry.description ? { description: source.entry.description } : {}),
        type: 'template', tags: Array.isArray(source.entry.tags) ? source.entry.tags : [], ...(source.entry.meta ? { meta: source.entry.meta } : {}),
      }, [{ format: 'json', size: stat.size, checksum: stat.checksum }]),
      blobs: { json: `${id}/json` },
      groups,
      // Already live in the catalog, so publishing it is curation, not a new
      // contribution: no review runs again, as for a new version.
      submission: {
        state: 'live', by: `user:${actor.id}`, byScoped: recordedScope(actor), at, checksum: stat.checksum, size: stat.size, contentType: 'application/json',
        ...(source.submission?.data ? { data: source.submission.data } : {}), note: `Published from ${source.id}`,
      },
      publication: {
        ...(editable.editable ? { editable: editable.editable } : {}), ...(body.fixedTheme ? { fixedTheme: true } : {}),
        ...(bindings.bindings ? { bindings: bindings.bindings } : {}), from: { id: source.id, version: headVersionOf(source) },
      },
      createdAt: at,
    };
    await store.putInstanceAsset(record);
    await store.putLifecycle({ assetId: id, onExpiry: 'hide' });
    await store.putCredential({ assetId: id, status: 'none', sniffedAt: at });
    await audit(`user:${actor.id}`, 'programme.template.publish', `programme:${programme.id}`, {
      template: id, from: source.id, toolId, groups, editable: editable.editable ?? null, fixedTheme: body.fixedTheme === true, bindings: bindings.bindings ?? null, ownerMark,
    });
    // The copy carries no licence of its own: the file it came from decides (publication.from).
    const mark = ownerMark && mayMark ? await marks.state(actor, id) : undefined;
    sendJson(res, 201, { id, groups, editable: editable.editable ?? null, fixedTheme: body.fixedTheme === true, bindings: bindings.bindings ?? null, ownerMark: await markView(mark) });
  });

  /** Publish a Share with rules file: the `.lolly` as the body, `?groups=` for who
   *  gets it. Work keeps only its data and builds the tool itself. */
  router.add('POST', '/api/v1/programmes/:id/templates/rules-file', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const groups = audienceOf((ctx.url.searchParams.get('groups') ?? programmeGroup(programme.id)).split(',').map((g) => g.trim()).filter(Boolean));
    if (!Array.isArray(groups)) return sendError(res, 400, 'INVALID_INPUT', groups.error);
    const reach = await programmeGroups(store, programme);
    if (!groups.some((g) => reach.has(g))) return sendError(res, 400, 'INVALID_INPUT', `publish it to ${programme.name} or one of its companies from here`);
    const markParam = ctx.url.searchParams.get('ownerMark');
    if (markParam !== null && markParam !== 'true' && markParam !== 'false') return sendError(res, 400, 'INVALID_INPUT', 'ownerMark must be true or false');
    const ownerMark = markParam !== 'false';
    const mayMark = await deps.mayStateMark(actor);
    if (markParam === 'true' && !mayMark) return sendError(res, 403, 'FORBIDDEN', 'stating the workspace\'s own mark needs catalog.edit');
    let bytes: Buffer;
    try { bytes = await readRaw(req, MAX_RULES_FILE_BYTES); }
    catch { return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `a Share with rules file is at most ${MAX_RULES_FILE_BYTES} bytes`); }
    if (!bytes.length) return sendError(res, 400, 'INVALID_INPUT', 'send the .lolly file as the request body');
    const out = await deps.submitRulesFile(actor, bytes, groups);
    if (!out.ok) return sendError(res, out.status, out.code, out.detail);
    await audit(`user:${actor.id}`, 'programme.template.publish', `programme:${programme.id}`, { template: out.id, kind: RULES_TOOL_TYPE, groups, ownerMark });
    // The same bytes held already come back as that asset: it is marked only when it
    // is a rules tool for exactly this audience, this publisher's own, and own work.
    const published = await store.getInstanceAsset(out.id);
    const thisOne = !!published && published.entry.type === RULES_TOOL_TYPE && published.submission?.by === `user:${actor.id}`
      && [...groupsOf(published)].sort().join('\n') === [...groups].sort().join('\n');
    const mark = ownerMark && mayMark && thisOne ? await marks.state(actor, out.id) : undefined;
    sendJson(res, 201, { id: out.id, state: out.state, groups, ownerMark: await markView(mark) });
  });

  /** Change who gets it or what they may change: `{ groups?, editable?, fixedTheme?, bindings? }`.
   *  `bindings` (input id to company field, null to clear) works on a Share with
   *  rules file too: there it names the file's own inputs, and each one it binds
   *  is locked to the company's value. */
  router.add('PUT', '/api/v1/programmes/:id/templates/:asset', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const found = await publishedHere(res, programme, `${INST_PREFIX}${String(ctx.params.asset)}`); if (!found) return;
    const body = ((await readJson(req)) ?? {}) as { groups?: unknown; editable?: unknown; fixedTheme?: unknown; bindings?: unknown; ownerMark?: unknown };
    if (body.fixedTheme !== undefined && typeof body.fixedTheme !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'fixedTheme must be true or false');
    if (body.ownerMark !== undefined && typeof body.ownerMark !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'ownerMark must be true or false');
    if (body.ownerMark !== undefined && !(await deps.mayStateMark(actor))) return sendError(res, 403, 'FORBIDDEN', 'stating or withdrawing the workspace\'s own mark needs catalog.edit');
    // Read, change and write under the asset's lock, so neither a version committing
    // meanwhile nor a mark being stated is lost or misjudged (programmes/owner-mark.ts).
    return store.withAssetLock(found.id, async () => {
    const rec = (await store.getInstanceAsset(found.id)) ?? found;
    if (body.ownerMark === true && !(await marks.ownWork(rec))) {
      return sendError(res, 409, 'NOT_OWN_WORK', 'the file this template came from records a licence, came from a provider or a partner, so the workspace does not state it as its own');
    }
    if ((body.editable !== undefined || body.fixedTheme !== undefined) && rec.entry.type !== 'template') {
      return sendError(res, 400, 'INVALID_INPUT', 'a Share with rules file brings its own rules; change them in Lolly and publish a new version');
    }
    let next = rec;
    if (body.groups !== undefined) {
      const groups = audienceOf(body.groups);
      if (!Array.isArray(groups)) return sendError(res, 400, 'INVALID_INPUT', groups.error);
      next = { ...next, groups };
    }
    if (body.editable !== undefined) {
      const facts = await deps.toolFacts(String((rec.entry.meta as { toolId?: unknown } | undefined)?.toolId ?? ''));
      const editable = normalizeEditable(body.editable, facts?.inputs.map((i) => i.id) ?? []);
      if ('error' in editable) return sendError(res, 400, 'INVALID_INPUT', editable.error);
      const { editable: _drop, ...rest } = next.publication ?? {};
      void _drop;
      const publication = { ...rest, ...(editable.editable ? { editable: editable.editable } : {}) };
      next = { ...next, publication: Object.keys(publication).length ? publication : undefined };
    }
    if (body.fixedTheme !== undefined) {
      const { fixedTheme: _was, ...rest } = next.publication ?? {};
      void _was;
      const publication = { ...rest, ...(body.fixedTheme ? { fixedTheme: true } : {}) };
      next = { ...next, publication: Object.keys(publication).length ? publication : undefined };
    }
    if (body.bindings !== undefined) {
      const meta = (rec.entry.meta ?? {}) as { toolId?: unknown; inputs?: Array<{ id: string }> };
      const inputIds = rec.entry.type === RULES_TOOL_TYPE ? (meta.inputs ?? []).map((i) => i.id)
        : (await deps.toolFacts(String(meta.toolId ?? '')))?.inputs.map((i) => i.id) ?? [];
      const bindings = normalizeBindings(body.bindings, inputIds);
      if ('error' in bindings) return sendError(res, 400, 'INVALID_INPUT', bindings.error);
      const { bindings: _old, ...rest } = next.publication ?? {};
      void _old;
      const publication = { ...rest, ...(bindings.bindings ? { bindings: bindings.bindings } : {}) };
      next = { ...next, publication: Object.keys(publication).length ? publication : undefined };
    }
    await store.putInstanceAsset(next);
    await audit(`user:${actor.id}`, 'programme.template.update', `programme:${programme.id}`, {
      template: rec.id,
      before: { groups: groupsOf(rec), editable: rec.publication?.editable ?? null, fixedTheme: !!rec.publication?.fixedTheme, bindings: rec.publication?.bindings ?? null },
      after: { groups: groupsOf(next), editable: next.publication?.editable ?? null, fixedTheme: !!next.publication?.fixedTheme, bindings: next.publication?.bindings ?? null },
    });
    // The card's tick: on records the mark (stated by whoever ticks it), off withdraws it.
    if (body.ownerMark === true) await marks.stateLocked(actor, rec.id);
    if (body.ownerMark === false) await marks.withdrawLocked(actor, rec.id, rec.id, 'untick');
    sendJson(res, 200, { id: rec.id, groups: groupsOf(next), editable: next.publication?.editable ?? null, fixedTheme: !!next.publication?.fixedTheme, bindings: next.publication?.bindings ?? null,
      ownerMark: await markView(await marks.markOn(rec.id)) });
    });
  });

  /** A new version of a tool template from another catalog template of the
   *  same tool: `{ from }`. A rules tool's new version is a new file, through
   *  the catalog submit route with `assetId`. */
  router.add('POST', '/api/v1/programmes/:id/templates/:asset/versions', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const rec = await publishedHere(res, programme, `${INST_PREFIX}${String(ctx.params.asset)}`); if (!rec) return;
    if (templateRetired(rec)) return sendError(res, 409, 'TEMPLATE_RETIRED', 'publish it again before adding a version');
    if (!(await mayChangeHead(actor, rec))) return sendError(res, 403, 'FORBIDDEN', 'this template carries the workspace\'s own mark: a new version needs catalog.edit');
    // A rules tool's new version is its new Share with rules file, as the body.
    if (rec.entry.type === RULES_TOOL_TYPE) {
      let file: Buffer;
      try { file = await readRaw(req, MAX_RULES_FILE_BYTES); }
      catch { return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `a Share with rules file is at most ${MAX_RULES_FILE_BYTES} bytes`); }
      if (!file.length) return sendError(res, 400, 'INVALID_INPUT', 'send the new .lolly file as the request body');
      const out = await deps.submitVersion(actor, rec, file);
      if (!out.ok) return sendError(res, out.status, out.code, out.detail);
      await audit(`user:${actor.id}`, 'programme.template.version', `programme:${programme.id}`, { template: rec.id, version: out.version ?? null });
      return sendJson(res, 201, { id: rec.id, version: out.version ?? rec.headVersion ?? 1 });
    }
    const body = ((await readJson(req)) ?? {}) as { from?: unknown };
    const source = await catalogTemplate(body.from);
    if (!source) return sendError(res, 404, 'NOT_FOUND', 'no such template in the catalog');
    const toolOf = (r: InstanceAssetRecord) => (r.entry.meta as { toolId?: unknown } | undefined)?.toolId;
    if (toolOf(source) !== toolOf(rec)) return sendError(res, 400, 'INVALID_INPUT', 'a new version starts the same tool');
    const bytes = await readTemplate(source);
    if (!bytes) return sendError(res, 409, 'TEMPLATE_UNREADABLE', 'the template\'s bytes could not be read');
    // The version row records `source`, and the commit checks the mark against it.
    const out = await deps.submitVersion(actor, rec, bytes, { id: source.id, version: headVersionOf(source) });
    if (!out.ok) return sendError(res, out.status, out.code, out.detail);
    await audit(`user:${actor.id}`, 'programme.template.version', `programme:${programme.id}`, { template: rec.id, from: source.id, version: out.version ?? null });
    sendJson(res, 201, { id: rec.id, version: out.version ?? rec.headVersion ?? 1 });
  });

  /** Retire it: `{ replacedBy? }`. New starts stop, saved copies keep working,
   *  and renders that name it answer 410 with the replacement (decision D2). */
  router.add('POST', '/api/v1/programmes/:id/templates/:asset/retire', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const rec = await publishedHere(res, programme, `${INST_PREFIX}${String(ctx.params.asset)}`); if (!rec) return;
    const body = ((await readJson(req)) ?? {}) as { replacedBy?: unknown };
    let replacedBy: string | undefined;
    if (body.replacedBy !== undefined && body.replacedBy !== null && body.replacedBy !== '') {
      const other = typeof body.replacedBy === 'string' ? await store.getInstanceAsset(body.replacedBy) : null;
      if (!other || other.id === rec.id || !PUBLISHED_TYPES.has(String(other.entry.type)) || templateRetired(other)) {
        return sendError(res, 400, 'INVALID_INPUT', 'the replacement is another published template that is not retired');
      }
      replacedBy = other.id;
    }
    const at = now();
    await retireTemplate(store, audit, `user:${actor.id}`, programme.id, rec, { at, ...(replacedBy ? { replacedBy } : {}) });
    sendJson(res, 200, { id: rec.id, retiredAt: at, ...(replacedBy ? { replacedBy } : {}) });
  });

  /** Undo a retirement. */
  router.add('POST', '/api/v1/programmes/:id/templates/:asset/restore', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const rec = await publishedHere(res, programme, `${INST_PREFIX}${String(ctx.params.asset)}`); if (!rec) return;
    const { retiredAt: _a, retiredBy: _b, replacedBy: _c, ...rest } = rec.publication ?? {};
    void _a; void _b; void _c;
    await store.putInstanceAsset({ ...rec, publication: Object.keys(rest).length ? rest : undefined });
    await audit(`user:${actor.id}`, 'programme.template.restore', `programme:${programme.id}`, { template: rec.id });
    sendJson(res, 200, { id: rec.id });
  });
}
