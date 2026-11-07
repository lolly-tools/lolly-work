// SPDX-License-Identifier: MPL-2.0
/**
 * Partner programme routes (plans/82 M1), under `programme.manage`.
 *
 * A programme's tools are `tool.use` allow grants for its group, and its assets
 * are collections whose groups name its group. These routes write those
 * through the same store calls the Grants and Catalog views use, so every
 * inclusion stays visible where it always was (the Grants table, the
 * collection's groups, the governance document) and each change is audited as
 * that kind of change, plus one `programme.edit` with the before and after.
 */
import type { IncomingMessage } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Grant } from '../rbac/evaluate.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { ExitRightsChoices } from './exit.ts';
import type { CollectionRecord } from '../catalog/collections.ts';
import {
  PARTNER_GROUP, PROGRAMME_ID, programmeGroup, readProgrammeBody, type ProgrammeRecord,
} from './types.ts';
import { withdrawDomainRules } from './domain-routes.ts';
import { withdrawFolderRules } from './folder-routes.ts';
import { dropTokenGroups } from './people-routes.ts';
import { companyGroup } from './people.ts';
import { TOKEN_LIMIT_KEYS, parseLimitOverrides, type TokenLimitOverrides, type TokenLimits, type TokenLimitSource, type TokenLimitKey } from '../iam/token-limits.ts';

type Router = ReturnType<typeof createRouter>;

export interface ProgrammeRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: import('node:http').ServerResponse, action: string): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** The pack's tool ids, so a programme cannot name a tool that is not here. */
  toolIds(): Promise<string[]>;
  /** `automation.tokenLimits`, the figures a programme's tokens take unless it states its own. */
  instanceTokenLimits?: Readonly<TokenLimits>;
  /** Share anyway choices (plans/82 M4): deleting a programme withdraws its own and its companies'. */
  rightsChoices?: ExitRightsChoices;
}

/** What the console and the CLI read for one programme. */
export interface ProgrammeView extends ProgrammeRecord {
  group: string;
  tools: string[];
  collections: Array<{ id: string; name: string; members: number }>;
  members: Array<{ id: string; name: string; email: string }>;
  /** What every token placed here takes (plans/82 M7): each figure and whether the
   *  programme states it or the instance default applies. A token may state its own. */
  tokenLimitDefaults?: { limits: TokenLimits; sources: Record<TokenLimitKey, Extract<TokenLimitSource, 'programme' | 'instance'>> };
}

/** The figures a programme's tokens take, and where each comes from. */
export function programmeTokenLimits(rec: Pick<ProgrammeRecord, 'tokenLimits'>, instance: Readonly<TokenLimits>): NonNullable<ProgrammeView['tokenLimitDefaults']> {
  const limits = {} as TokenLimits;
  const sources = {} as Record<TokenLimitKey, 'programme' | 'instance'>;
  for (const key of TOKEN_LIMIT_KEYS) {
    const stated = !!rec.tokenLimits && Object.hasOwn(rec.tokenLimits, key);
    limits[key] = stated ? rec.tokenLimits![key] ?? null : instance[key];
    sources[key] = stated ? 'programme' : 'instance';
  }
  return { limits, sources };
}

const toolGrant = (group: string, toolId: string): Grant => ({ principal: `group:${group}`, action: 'tool.use', resource: `tool:${toolId}`, effect: 'allow' });

function namesGroup(rec: CollectionRecord, group: string): boolean {
  return Array.isArray(rec.groups) && rec.groups.includes(group);
}

export async function programmeView(store: Store, rec: ProgrammeRecord, instanceTokenLimits?: Readonly<TokenLimits>): Promise<ProgrammeView> {
  const group = programmeGroup(rec.id);
  const [grants, collections, users] = await Promise.all([store.listGrants(), store.listCollections(), store.listUsers()]);
  return {
    ...rec,
    group,
    tools: grants.filter((g) => g.principal === `group:${group}` && g.action === 'tool.use' && g.effect === 'allow' && g.resource.startsWith('tool:'))
      .map((g) => g.resource.slice('tool:'.length)).sort(),
    collections: collections.filter((c) => namesGroup(c, group)).map((c) => ({ id: c.id, name: c.name, members: c.members.length })),
    members: users.filter((u) => u.groups.includes(group))
      .map((u) => ({ id: u.id, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...(instanceTokenLimits ? { tokenLimitDefaults: programmeTokenLimits(rec, instanceTokenLimits) } : {}),
  };
}

export function registerProgrammeRoutes(router: Router, deps: ProgrammeRouteDeps): void {
  const { store } = deps;
  const view = (rec: ProgrammeRecord) => programmeView(store, rec, deps.instanceTokenLimits);

  router.add('GET', '/api/v1/programmes', async (req, res) => {
    if (!(await deps.requireAction(req, res, 'programme.manage'))) return;
    const list = await store.listProgrammes();
    sendJson(res, 200, { programmes: await Promise.all(list.map(view)) }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/programmes/:id', async (req, res, ctx) => {
    if (!(await deps.requireAction(req, res, 'programme.manage'))) return;
    const rec = await store.getProgramme(String(ctx.params.id));
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    sendJson(res, 200, await view(rec), { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Create or replace. The id is permanent; the body carries the name, the
   *  description and, optionally, the full tool and collection lists. */
  router.add('PUT', '/api/v1/programmes/:id', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage');
    if (!actor) return;
    const id = String(ctx.params.id);
    if (!PROGRAMME_ID.test(id)) return sendError(res, 400, 'INVALID_INPUT', 'id must be lowercase letters, digits and hyphens, at most 48');
    const raw = await readJson(req);
    const body = readProgrammeBody(raw);
    if ('error' in body) return sendError(res, 400, 'INVALID_INPUT', body.error);
    const extra = (raw ?? {}) as { tools?: unknown; collections?: unknown; tokenLimits?: unknown; approvalChains?: unknown };
    // The limits its tokens take (plans/82 M7): absent keeps what is stored, null
    // returns every figure to the instance default.
    let tokenLimits: TokenLimitOverrides | undefined;
    if (extra.tokenLimits !== undefined && extra.tokenLimits !== null) {
      const parsed = parseLimitOverrides(extra.tokenLimits, 'tokenLimits');
      if ('error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);
      tokenLimits = parsed;
    }
    const ids = (v: unknown, field: string): string[] | { error: string } => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return { error: `${field} must be a list of ids` };
      return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
    };
    const tools = ids(extra.tools, 'tools');
    if ('error' in tools) return sendError(res, 400, 'INVALID_INPUT', tools.error);
    const collectionIds = ids(extra.collections, 'collections');
    if ('error' in collectionIds) return sendError(res, 400, 'INVALID_INPUT', collectionIds.error);
    const known = new Set((await deps.toolIds()).map((t) => t.toLowerCase()));
    const unknownTools = tools.filter((t) => !known.has(t.toLowerCase()));
    if (unknownTools.length) return sendError(res, 400, 'UNKNOWN_TOOL', `not tools in this deployment: ${unknownTools.slice(0, 5).join(', ')}`);
    const allCollections = await store.listCollections();
    const unknownCollections = collectionIds.filter((c) => !allCollections.some((x) => x.id === c));
    if (unknownCollections.length) return sendError(res, 400, 'UNKNOWN_COLLECTION', `not collections: ${unknownCollections.slice(0, 5).join(', ')}`);

    const prior = await store.getProgramme(id);
    const before = prior ? await programmeView(store, prior) : null;
    const now = new Date().toISOString();
    const team = body.team === undefined ? prior?.team : body.team ?? undefined;
    if (team && !(await store.listLocalGroups()).some((g) => g.name === team) && !(await store.listUsers()).some((u) => u.idpGroups.includes(team))) {
      return sendError(res, 400, 'UNKNOWN_GROUP', `no group called ${team}`);
    }
    // An edit keeps what other routes own on the record: the templates-only
    // switch (M2) and the ended state (M5). Token limits (M7) change only when
    // the body names them.
    const limits = extra.tokenLimits === undefined ? prior?.tokenLimits : tokenLimits;
    // The chains its tokens may ask through (plans/82 M7): absent keeps them, null or [] clears.
    let chains = prior?.approvalChains;
    if (extra.approvalChains !== undefined) {
      if (extra.approvalChains === null) chains = undefined;
      else {
        const listed = ids(extra.approvalChains, 'approvalChains');
        if ('error' in listed) return sendError(res, 400, 'INVALID_INPUT', listed.error);
        const unknownChains = [];
        for (const chainId of listed) if (!(await store.getChain(chainId))) unknownChains.push(chainId);
        if (unknownChains.length) return sendError(res, 400, 'UNKNOWN_CHAIN', `not approval chains: ${unknownChains.slice(0, 5).join(', ')}`);
        chains = listed.length ? listed.sort() : undefined;
      }
    }
    const rec: ProgrammeRecord = {
      id, name: body.name, ...(body.description ? { description: body.description } : {}), ...(team ? { team } : {}),
      createdBy: prior?.createdBy ?? actor.id, createdAt: prior?.createdAt ?? now, updatedAt: now, version: (prior?.version ?? 0) + 1,
      ...(prior?.templatesOnly?.length ? { templatesOnly: prior.templatesOnly } : {}),
      ...(prior?.endedAt ? { endedAt: prior.endedAt, ...(prior.endedBy ? { endedBy: prior.endedBy } : {}), ...(prior.endedExit ? { endedExit: prior.endedExit } : {}) } : {}),
      ...(limits && Object.keys(limits).length ? { tokenLimits: limits } : {}),
      ...(chains?.length ? { approvalChains: chains } : {}),
    };
    const group = programmeGroup(id);
    const localGroups = await store.listLocalGroups();
    const registry = new Set(localGroups.map((g) => g.name));
    // The group's description carries the programme's name, so People, Grants
    // and Preview can show the name rather than the group id; a rename follows.
    const existingGroup = localGroups.find((g) => g.name === group);
    if (!existingGroup || existingGroup.description !== `Partner programme: ${rec.name}`) {
      await store.putLocalGroup({ name: group, description: `Partner programme: ${rec.name}`, createdAt: existingGroup?.createdAt ?? now });
    }
    if (!registry.has(PARTNER_GROUP)) await store.putLocalGroup({ name: PARTNER_GROUP, description: 'Has been in a partner programme', createdAt: now });
    await store.putProgramme(rec);

    // Tools, only when the body names them: the allow grants for this group.
    if (extra.tools !== undefined) {
      const wanted = new Set(tools.map((t) => t.toLowerCase()));
      const current = (await store.listGrants()).filter((g) => g.principal === `group:${group}` && g.action === 'tool.use' && g.effect === 'allow' && g.resource.startsWith('tool:'));
      for (const g of current) {
        if (wanted.has(g.resource.slice('tool:'.length))) continue;
        await store.deleteGrant(g);
        await deps.audit(`user:${actor.id}`, 'grant.delete', `grant:${g.principal}`, { ...g, via: `programme:${id}` });
      }
      const have = new Set(current.map((g) => g.resource.slice('tool:'.length)));
      for (const toolId of wanted) {
        if (have.has(toolId)) continue;
        const g = toolGrant(group, toolId);
        await store.putGrant(g);
        await deps.audit(`user:${actor.id}`, 'grant.create', `grant:${g.principal}`, { ...g, via: `programme:${id}` });
      }
    }
    // Collections, only when the body names them: this group in each one's groups.
    if (extra.collections !== undefined) {
      const wanted = new Set(collectionIds);
      for (const c of allCollections) {
        const has = namesGroup(c, group);
        if (has === wanted.has(c.id)) continue;
        const listed = Array.isArray(c.groups) ? c.groups : c.groups === '*' || !c.groups ? ['*'] : [];
        const groups = has ? listed.filter((g) => g !== group) : [...listed, group];
        const next: CollectionRecord = { ...c, groups: groups.length ? groups : '*', updatedAt: now };
        await store.putCollection(next);
        await deps.audit(`user:${actor.id}`, 'catalog.collection.edit', `collection:${c.id}`, { before: c, after: next, via: `programme:${id}` });
      }
    }
    const after = await view(rec);
    await deps.audit(`user:${actor.id}`, prior ? 'programme.edit' : 'programme.create', `programme:${id}`, {
      before: before ? summary(before) : null, after: summary(after),
    });
    const limitsBefore = prior?.tokenLimits ?? {}, limitsAfter = rec.tokenLimits ?? {};
    if (JSON.stringify(limitsBefore) !== JSON.stringify(limitsAfter)) {
      await deps.audit(`user:${actor.id}`, 'programme.limits', `programme:${id}`, { before: limitsBefore, after: limitsAfter });
    }
    sendJson(res, prior ? 200 : 201, after);
  });

  router.add('DELETE', '/api/v1/programmes/:id', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage');
    if (!actor) return;
    const id = String(ctx.params.id);
    const rec = await store.getProgramme(id);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const before = await programmeView(store, rec);
    const group = programmeGroup(id);
    for (const g of (await store.listGrants()).filter((x) => x.principal === `group:${group}`)) {
      await store.deleteGrant(g);
      await deps.audit(`user:${actor.id}`, 'grant.delete', `grant:${g.principal}`, { ...g, via: `programme:${id}` });
    }
    const now = new Date().toISOString();
    for (const c of (await store.listCollections()).filter((x) => namesGroup(x, group))) {
      const groups = (c.groups as string[]).filter((g) => g !== group);
      const next: CollectionRecord = { ...c, groups: groups.length ? groups : '*', updatedAt: now };
      await store.putCollection(next);
      await deps.audit(`user:${actor.id}`, 'catalog.collection.edit', `collection:${c.id}`, { before: c, after: next, via: `programme:${id}` });
    }
    // Its partner domains stop admitting anyone (plans/82 M1 part 2b).
    await withdrawDomainRules(store, deps.audit, `user:${actor.id}`, { programmeId: id }, now, 'programme-delete');
    await withdrawFolderRules(store, deps.audit, `user:${actor.id}`, { programmeId: id }, 'programme-delete');
    // Tokens placed in it keep the partner marker, like its people (plans/82 M3).
    const companyGroups = (await store.listCompanies()).filter((c) => c.programmeId === id).map((c) => companyGroup(c.id));
    await dropTokenGroups(store, deps.audit, `user:${actor.id}`, new Set([group, ...companyGroups]), 'programme-delete');
    // Its exit receipts go with it, and its companies' (plans/82 M5).
    await store.deleteProgrammeExits({ programmeId: id });
    // Members keep the partner marker, so they see only the essentials until an
    // admin adds them to another programme or makes them internal on purpose.
    await store.deleteLocalGroup(group);
    await store.deleteProgramme(id);
    // Its share anyway choices, its companies' included, go after the record:
    // a choice racing this delete is either written first and withdrawn here, or finds
    // no programme and is refused. A programme made later with this id starts
    // with none.
    await deps.rightsChoices?.withdraw(`user:${actor.id}`, { programmeId: id }, 'programme-delete');
    await deps.audit(`user:${actor.id}`, 'programme.delete', `programme:${id}`, { before: summary(before) });
    sendJson(res, 200, { ok: true });
  });
}

/** The audit payload for a programme: what it includes, never who is in it. */
function summary(v: ProgrammeView): Record<string, unknown> {
  return { name: v.name, ...(v.description ? { description: v.description } : {}), ...(v.team ? { team: v.team } : {}), tools: v.tools, collections: v.collections.map((c) => c.id), members: v.members.length,
    ...(v.approvalChains?.length ? { approvalChains: v.approvalChains } : {}) };
}
