// SPDX-License-Identifier: MPL-2.0
/** Company kit routes (plans/82 M8), beside the profile and logo routes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRaw, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { SubmitInput, SubmitOutcome } from '../catalog/submit.ts';
import { submissionServable } from '../catalog/instance-assets.ts';
import type { CompanyProfileDeps } from './profile-routes.ts';
import { companyGroup, type CompanyRecord } from './people.ts';
import { KIT_LOLLY_MAX_BYTES, KIT_MAX_BYTES, KIT_TOKENS_MAX_BYTES, proposeCompanyKit, storedKit } from './kit.ts';

export interface CompanyKitDeps extends Pick<CompanyProfileDeps, 'store' | 'blobs' | 'requireAction' | 'memberOf' | 'audit'> {
  submitKit(input: SubmitInput): Promise<SubmitOutcome>;
  kitVisible(groups: string[], assetId: string): Promise<boolean>;
}

export function registerCompanyKitRoutes(router: ReturnType<typeof createRouter>, d: CompanyKitDeps): void {
  const { store, blobs } = d;
  const managed = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string | undefined>) => {
    const actor = await d.requireAction(req, res, 'programme.manage'); if (!actor) return null;
    const programme = await store.getProgramme(String(params.id));
    if (!programme) { sendError(res, 404, 'NOT_FOUND', 'no such programme'); return null; }
    const company = (await store.listCompanies()).find((c) => c.id === params.company && c.programmeId === programme.id);
    if (!company) { sendError(res, 404, 'NOT_FOUND', 'no such company in this programme'); return null; }
    return { actor, company, programme };
  };
  const ownCompany = async (req: IncomingMessage, res: ServerResponse, editing: boolean) => {
    const actor = await d.memberOf(req);
    if (!actor) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const companies = (await store.listCompanies()).filter((c) => actor.groups.includes(companyGroup(c.id)));
    if (!companies.length) { sendError(res, 404, 'NO_COMPANY', 'you are not in a partner company'); return null; }
    if (companies.length > 1) { sendError(res, 409, 'TWO_COMPANIES', 'you are in more than one partner company, so there is no single kit to show'); return null; }
    const company = companies[0]!;
    const programme = await store.getProgramme(company.programmeId);
    if (!programme) { sendError(res, 404, 'NO_COMPANY', 'you are not in a partner company'); return null; }
    if (editing) {
      const profile = await store.getCompanyProfile(company.id);
      if (!profile?.settings.editors?.includes(actor.id)) { sendError(res, 403, 'FORBIDDEN', 'only a contact chosen by the brand team may edit the company kit'); return null; }
      // Profile approvals carry profile changes only. Kit contacts may save
      // directly only while the existing approval switch is off.
      if (profile.settings.approvalChain) { sendError(res, 403, 'FORBIDDEN', 'the brand team must edit the kit while contact changes require approval'); return null; }
    }
    return { actor, company, programme };
  };
  type Context = NonNullable<Awaited<ReturnType<typeof managed>>>;
  const live = (res: ServerResponse, context: Context): boolean => {
    if (!context.company.endedAt && !context.programme.endedAt) return true;
    sendError(res, 409, 'PROGRAMME_ENDED', 'reopen the partnership before changing its kit');
    return false;
  };
  const read = async (company: CompanyRecord) => {
    const pointer = (await store.getCompanyProfile(company.id))?.kit;
    const rec = pointer ? await store.getInstanceAsset(pointer.assetId) : null;
    if (!rec || rec.entry.type !== 'partner-kit' || (rec.entry.meta as { company?: unknown })?.company !== company.id || !submissionServable(rec) || (await store.getLifecycle(rec.id))?.revokedAt) return null;
    const kit = await storedKit(blobs, rec);
    return kit ? { kit, assetId: rec.id, revision: rec.headVersion ?? 1, source: kit.source ?? null } : null;
  };
  const show = async (res: ServerResponse, context: Context, own = false) => {
    const view = await read(context.company);
    if (!view || (own && !await d.kitVisible(context.actor.groups, view.assetId))) return sendError(res, 404, 'NOT_FOUND', 'this company has no kit');
    sendJson(res, 200, view, { 'cache-control': 'no-store' });
  };
  const save = async (req: IncomingMessage, res: ServerResponse, context: Context) => {
    if (!live(res, context)) return;
    const bytes = await readRaw(req, KIT_MAX_BYTES);
    const pointer = (await store.getCompanyProfile(context.company.id))?.kit;
    const target = pointer ? await store.getInstanceAsset(pointer.assetId) : null;
    if (pointer && !target) return sendError(res, 409, 'KIT_MISSING', 'remove the missing kit before saving a new one');
    const outcome = await d.submitKit({ bytes, name: `${context.company.name} partner kit`, submitter: { id: context.actor.id, groups: context.actor.groups },
      companyKit: { companyId: context.company.id }, ...(target ? { target } : {}) });
    if (!outcome.ok) return sendError(res, outcome.code === 'QUOTA_EXCEEDED' ? 409 : outcome.code === 'SCAN_UNAVAILABLE' ? 503 : 422, outcome.code, outcome.detail);
    const revision = outcome.version ?? outcome.record.headVersion ?? 1;
    const kit = await storedKit(blobs, outcome.record);
    await d.audit(`user:${context.actor.id}`, 'programme.company.kit', `company:${context.company.id}`, {
      revisionBefore: target ? target.headVersion ?? 1 : null, revisionAfter: revision, source: kit?.source ?? null,
    });
    sendJson(res, 200, { kit, assetId: outcome.record.id, revision, source: kit?.source ?? null }, { 'cache-control': 'no-store' });
  };
  const propose = async (req: IncomingMessage, res: ServerResponse, url: URL, context: Context) => {
    if (!live(res, context)) return;
    const from = url.searchParams.get('from');
    if (from !== 'tokens' && from !== 'lolly' && from !== 'logos') return sendError(res, 400, 'INVALID_INPUT', 'from must be tokens, lolly or logos');
    const bytes = from === 'logos' ? Buffer.alloc(0) : await readRaw(req, from === 'tokens' ? KIT_TOKENS_MAX_BYTES : KIT_LOLLY_MAX_BYTES);
    const reference = from === 'logos' ? 'Company logos' : url.searchParams.get('name') ?? (from === 'lolly' ? 'share.lolly' : 'tokens.json');
    try {
      sendJson(res, 200, await proposeCompanyKit(store, blobs, context.company, from, bytes, reference), { 'cache-control': 'no-store' });
    } catch (error) {
      sendError(res, 422, 'INVALID_IMPORT', error instanceof SyntaxError ? 'the import must contain valid JSON' : error instanceof Error ? error.message : 'the import could not be read');
    }
  };
  const base = '/api/v1/programmes/:id/companies/:company/kit';
  router.add('GET', base, async (req, res, ctx) => {
    const context = await managed(req, res, ctx.params); if (context) await show(res, context);
  }, { delivery: 'person-private' });
  router.add('PUT', base, async (req, res, ctx) => {
    const context = await managed(req, res, ctx.params); if (context) await save(req, res, context);
  });
  router.add('DELETE', base, async (req, res, ctx) => {
    const context = await managed(req, res, ctx.params); if (!context || !live(res, context)) return;
    const pointer = (await store.getCompanyProfile(context.company.id))?.kit;
    if (!pointer) return sendError(res, 404, 'NOT_FOUND', 'this company has no kit');
    const prior = await read(context.company);
    const life = await store.getLifecycle(pointer.assetId);
    await store.putLifecycle({ ...(life ?? { assetId: pointer.assetId, onExpiry: 'hide' as const }), revokedAt: life?.revokedAt ?? new Date().toISOString() });
    if (!await store.putCompanyKit(context.company.id, null, pointer.assetId)) return sendError(res, 409, 'KIT_CHANGED', 'the company kit changed; read the current kit and retry');
    await d.audit(`user:${context.actor.id}`, 'programme.company.kit', `company:${context.company.id}`, { revisionBefore: prior?.revision ?? null, revisionAfter: null, source: prior?.source ?? null });
    sendJson(res, 200, { removed: pointer.assetId }, { 'cache-control': 'no-store' });
  });
  router.add('POST', `${base}/import`, async (req, res, ctx) => {
    const context = await managed(req, res, ctx.params); if (context) await propose(req, res, ctx.url, context);
  });
  router.add('GET', '/api/v1/me/company/kit', async (req, res) => {
    const context = await ownCompany(req, res, false); if (context) await show(res, context, true);
  }, { delivery: 'person-private' });
  router.add('PUT', '/api/v1/me/company/kit', async (req, res) => {
    const context = await ownCompany(req, res, true); if (context) await save(req, res, context);
  });
  router.add('POST', '/api/v1/me/company/kit/import', async (req, res, ctx) => {
    const context = await ownCompany(req, res, true); if (context) await propose(req, res, ctx.url, context);
  });
}
