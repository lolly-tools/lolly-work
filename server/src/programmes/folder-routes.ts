// SPDX-License-Identifier: MPL-2.0
/**
 * Provider folder routes (plans/82 M1 part 2c), under `programme.manage`.
 *
 * GET lists a programme's folder rules and, for choosing a new one, the
 * folders each connected provider's last sync saw, with how many assets each
 * holds (counting everything below it). PUT adds or changes one rule, DELETE
 * removes one. Each change is audited as `programme.folder.add`, `.edit` or
 * `.remove`; the minute sweep removes rules past their end date as
 * `programme.folder.end`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { FragmentView } from '../catalog/federation.ts';
import { entryInFolders, liveFolderRules, normaliseFolderPath, type PartnerFolderRecord } from './folders.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface FolderRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  /** Each provider's last synced fragment. */
  fragments(): Promise<FragmentView[]>;
}

const folderOf = (entry: object): string | undefined => {
  const f = ((entry as { meta?: unknown }).meta as { providerFolder?: unknown } | undefined)?.providerFolder;
  return typeof f === 'string' ? f : undefined;
};

/** Every folder a fragment's assets sit in, and each one's ancestors, with the
 *  number of assets at or below it. '' is the whole provider. */
export function folderCounts(assets: ReadonlyArray<object>): Array<{ path: string; assets: number }> {
  const counts = new Map<string, number>();
  for (const a of assets) {
    const folder = folderOf(a);
    if (folder === undefined) continue;
    const segments = folder.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      const path = segments.slice(0, i).join('/');
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [{ path: '', assets: assets.length }, ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([path, n]) => ({ path, assets: n }))];
}

/** Remove rules past their end date, auditing each. Returns how many ended. */
export async function sweepFolderRules(store: Store, audit: Audit, now = Date.now()): Promise<number> {
  const all = await store.listPartnerFolders();
  const live = new Set(liveFolderRules(all, now));
  let ended = 0;
  for (const r of all.filter((x) => !live.has(x))) {
    await store.deletePartnerFolder(r);
    await audit('system', 'programme.folder.end', `programme:${r.programmeId}`, {
      provider: r.provider, path: r.path, ...(r.companyId ? { company: r.companyId } : {}), endsAt: r.endsAt,
    });
    ended++;
  }
  return ended;
}

/** Remove a deleted programme's rules, or a deleted company's. */
export async function withdrawFolderRules(store: Store, audit: Audit, actor: string, pick: { programmeId?: string; companyId?: string }, via: string): Promise<number> {
  const gone = (await store.listPartnerFolders()).filter((r) => (pick.companyId ? r.companyId === pick.companyId : r.programmeId === pick.programmeId));
  for (const r of gone) {
    await store.deletePartnerFolder(r);
    await audit(actor, 'programme.folder.remove', `programme:${r.programmeId}`, {
      provider: r.provider, path: r.path, ...(r.companyId ? { company: r.companyId } : {}), via,
    });
  }
  return gone.length;
}

export function registerFolderRoutes(router: Router, deps: FolderRouteDeps): void {
  const { store, audit } = deps;
  const manager = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'programme.manage');

  router.add('GET', '/api/v1/programmes/:id/folders', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const [rules, companies, frags, users, recs] = await Promise.all([
      store.listPartnerFolders(), store.listCompanies(), deps.fragments(), store.listUsers(), store.listProviders({ includeFragment: false }),
    ]);
    const byId = new Map(frags.map((f) => [f.rec.id, f]));
    const nameOf = (id: string) => { const u = users.find((x) => x.id === id); return u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email : id; };
    const mine = rules.filter((r) => r.programmeId === programme.id);
    sendJson(res, 200, {
      programme: programme.id,
      folders: mine.map((r) => {
        const f = byId.get(r.provider);
        return {
          provider: { id: r.provider, label: f?.rec.label ?? r.provider }, path: r.path,
          ...(r.companyId ? { company: { id: r.companyId, name: companies.find((c) => c.id === r.companyId)?.name ?? r.companyId } } : {}),
          ...(r.endsAt ? { endsAt: r.endsAt } : {}),
          assets: f ? f.fragment.assets.filter((a) => entryInFolders(folderOf(a), [r.path])).length : 0,
          addedBy: { id: r.addedBy, name: nameOf(r.addedBy) }, addedAt: r.addedAt,
        };
      }),
      // Every enabled provider, synced or not: one enabled a moment ago is
      // listed at once, with its folders once its first sync has finished.
      providers: recs.filter((r) => r.enabled).map((r) => {
        const f = byId.get(r.id);
        return { id: r.id, label: r.label, synced: !!f, folders: f ? folderCounts(f.fragment.assets) : [] };
      }),
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Add or change one rule. Body: `{ provider, path, company?, endsAt? }`.
   *  `path` is required: nothing defaults to the whole source. The whole
   *  source is `path: ""` together with `whole: true`, said on purpose. */
  router.add('PUT', '/api/v1/programmes/:id/folders', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const body = ((await readJson(req)) ?? {}) as { provider?: unknown; path?: unknown; whole?: unknown; company?: unknown; endsAt?: unknown };
    const provider = typeof body.provider === 'string' ? await store.getProvider(body.provider, { includeFragment: false }) : null;
    if (!provider) return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    if (body.path === undefined || body.path === null) return sendError(res, 400, 'CHOOSE_FOLDER', 'choose a folder, such as Partners/EMEA; to give the whole source, send path "" with whole: true');
    const path = normaliseFolderPath(body.path);
    if (path === null) return sendError(res, 400, 'INVALID_INPUT', 'path is a folder below the provider root, such as Partners/EMEA');
    if (path === '' && body.whole !== true) return sendError(res, 400, 'CHOOSE_FOLDER', 'an empty path gives the whole source; send whole: true to mean that');
    let companyId: string | undefined;
    if (body.company !== undefined && body.company !== null && body.company !== '') {
      const company = (await store.listCompanies()).find((c) => c.id === body.company && c.programmeId === programme.id);
      if (!company) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
      companyId = company.id;
    }
    let endsAt: string | undefined;
    if (body.endsAt !== undefined && body.endsAt !== null && body.endsAt !== '') {
      const raw = String(body.endsAt);
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw);
      if (!Number.isFinite(t)) return sendError(res, 400, 'INVALID_INPUT', 'endsAt must be a date (YYYY-MM-DD)');
      if (t <= Date.now()) return sendError(res, 400, 'INVALID_INPUT', 'the end date has passed');
      endsAt = new Date(t).toISOString();
    }
    const prior = (await store.listPartnerFolders()).find((r) => r.provider === provider.id && r.path === path && r.programmeId === programme.id && (r.companyId ?? '') === (companyId ?? ''));
    const rec: PartnerFolderRecord = {
      provider: provider.id, path, programmeId: programme.id, ...(companyId ? { companyId } : {}), ...(endsAt ? { endsAt } : {}),
      addedBy: prior?.addedBy ?? actor.id, addedAt: prior?.addedAt ?? new Date().toISOString(),
    };
    await store.putPartnerFolder(rec);
    await audit(`user:${actor.id}`, prior ? 'programme.folder.edit' : 'programme.folder.add', `programme:${programme.id}`, {
      provider: provider.id, path, ...(companyId ? { company: companyId } : {}), ...(endsAt ? { endsAt } : {}),
      ...(prior ? { before: { ...(prior.endsAt ? { endsAt: prior.endsAt } : {}) } } : {}),
    });
    sendJson(res, prior ? 200 : 201, rec);
  });

  /** Remove one rule: `?provider=&path=&company=`. */
  router.add('DELETE', '/api/v1/programmes/:id/folders', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const providerId = ctx.url.searchParams.get('provider') ?? '';
    const path = normaliseFolderPath(ctx.url.searchParams.get('path') ?? '');
    const companyId = ctx.url.searchParams.get('company') || undefined;
    const rec = (await store.listPartnerFolders()).find((r) => r.provider === providerId && r.path === path && r.programmeId === programme.id && (r.companyId ?? '') === (companyId ?? ''));
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such folder rule in this programme');
    await store.deletePartnerFolder(rec);
    await audit(`user:${actor.id}`, 'programme.folder.remove', `programme:${programme.id}`, {
      provider: rec.provider, path: rec.path, ...(rec.companyId ? { company: rec.companyId } : {}),
    });
    sendJson(res, 200, { ok: true });
  });
}
