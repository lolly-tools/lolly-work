// SPDX-License-Identifier: MPL-2.0
/** Company kit routes (plans/82 M8), beside the profile and logo routes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRaw, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { SubmitInput, SubmitOutcome } from '../catalog/submit.ts';
import { submissionServable } from '../catalog/instance-assets.ts';
import { createApproval, currentStep, isEligible, withdraw, type Approval } from '../approvals/engine.ts';
import { readBlobBody } from '../blobs/types.ts';
import { randomId } from '../lib/crypto.ts';
import type { UserRecord } from '../store/types.ts';
import type { CompanyProfileDeps } from './profile-routes.ts';
import { companyGroup, type CompanyRecord } from './people.ts';
import { KIT_LOLLY_MAX_BYTES, KIT_MAX_BYTES, KIT_TOKENS_MAX_BYTES, kitCompanyLive, prepareCompanyKit, proposeCompanyKit, storedKit } from './kit.ts';

export interface CompanyKitDeps extends Pick<CompanyProfileDeps, 'store' | 'blobs' | 'requireAction' | 'memberOf' | 'audit' | 'notifier' | 'baseUrl'> {
  submitKit(input: SubmitInput): Promise<SubmitOutcome>;
  kitVisible(groups: string[], assetId: string): Promise<boolean>;
}

export interface CompanyKitApproval {
  companyId: string;
  action: 'save' | 'remove';
  blobId?: string;
}

export function registerCompanyKitRoutes(router: ReturnType<typeof createRouter>, d: CompanyKitDeps) {
  const { store, blobs } = d;
  const filing = new Set<string>();
  const failure = (status: number, code: string, detail: string) => ({ error: [status, code, detail] as [number, string, string] });
  const pendingFailure = () => failure(409, 'KIT_CHANGE_PENDING', 'A kit change is waiting for approval. Withdraw the request or wait for the decision.');
  const pendingFor = async (companyId: string) => (await store.listApprovals()).find((a) =>
    a.subjectType === 'partner-kit' && a.partnerKit?.companyId === companyId && (a.state === 'submitted' || a.state === 'in_review'));
  const waiting = async (res: ServerResponse, companyId: string): Promise<boolean> => {
    if (!await pendingFor(companyId)) return false;
    sendError(res, ...pendingFailure().error);
    return true;
  };
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
    const pending = await pendingFor(context.company.id);
    if ((!view && !pending) || (view && own && !await d.kitVisible(context.actor.groups, view.assetId))) return sendError(res, 404, 'NOT_FOUND', 'this company has no kit');
    sendJson(res, 200, { ...(view ?? { kit: null }), ...(pending ? { pending: { approvalId: pending.id, action: pending.partnerKit!.action } } : {}) }, { 'cache-control': 'no-store' });
  };
  /** Direct saves and approved saves use the same validation and submit path. */
  const publish = async (actor: Pick<UserRecord, 'id' | 'groups'>, company: CompanyRecord, bytes: Buffer, via?: { approval: string }) => {
    const pointer = (await store.getCompanyProfile(company.id))?.kit;
    const target = pointer ? await store.getInstanceAsset(pointer.assetId) : null;
    if (pointer && !target) return failure(409, 'KIT_MISSING', 'remove the missing kit before saving a new one');
    const outcome = await d.submitKit({ bytes, name: `${company.name} partner kit`, submitter: { id: actor.id, groups: actor.groups },
      companyKit: { companyId: company.id }, ...(target ? { target } : {}) });
    if (!outcome.ok) return failure(outcome.code === 'QUOTA_EXCEEDED' ? 409 : outcome.code === 'SCAN_UNAVAILABLE' ? 503 : 422, outcome.code, outcome.detail);
    const revision = outcome.version ?? outcome.record.headVersion ?? 1;
    const kit = await storedKit(blobs, outcome.record);
    await d.audit(`user:${actor.id}`, 'programme.company.kit', `company:${company.id}`, {
      revisionBefore: target ? target.headVersion ?? 1 : null, revisionAfter: revision, source: kit?.source ?? null,
      ...(via ? { via } : {}),
    });
    return { view: { kit, assetId: outcome.record.id, revision, source: kit?.source ?? null } };
  };
  const remove = async (actorId: string, company: CompanyRecord, via?: { approval: string }) => {
    const pointer = (await store.getCompanyProfile(company.id))?.kit;
    if (!pointer) return failure(404, 'NOT_FOUND', 'this company has no kit');
    const prior = await read(company);
    const life = await store.getLifecycle(pointer.assetId);
    await store.putLifecycle({ ...(life ?? { assetId: pointer.assetId, onExpiry: 'hide' as const }), revokedAt: life?.revokedAt ?? new Date().toISOString() });
    if (!await store.putCompanyKit(company.id, null, pointer.assetId)) return failure(409, 'KIT_CHANGED', 'the company kit changed; read the current kit and retry');
    await d.audit(`user:${actorId}`, 'programme.company.kit', `company:${company.id}`, {
      revisionBefore: prior?.revision ?? null, revisionAfter: null, source: prior?.source ?? null, ...(via ? { via } : {}),
    });
    return { removed: pointer.assetId };
  };
  const askApproval = async (actor: UserRecord, company: CompanyRecord, chainId: string, action: CompanyKitApproval['action'], bytes?: Buffer) => {
    if (filing.has(company.id)) return pendingFailure();
    filing.add(company.id);
    try {
      if (await pendingFor(company.id)) return pendingFailure();
      const chain = await store.getChain(chainId);
      if (!chain?.steps.length) return failure(409, 'CHAIN_NOT_FOUND', 'The approval chain for kit changes does not exist. Nothing was sent.');
      const id = `apr_${randomId(8)}`;
      const blobId = bytes ? `partner-kit/pending/${id}/kit.json` : undefined;
      const title = `Partner kit: ${company.name}`;
      const approval: Approval = {
        ...createApproval({ id, subjectType: 'partner-kit', subjectRef: company.id, title, chain, nominees: [], createdBy: actor.id, now: new Date().toISOString() }),
        partnerKit: { companyId: company.id, action, ...(blobId ? { blobId } : {}) },
      };
      if (blobId && bytes) await blobs.put(blobId, bytes, 'application/json');
      try { await store.putApproval(approval); }
      catch (error) { if (blobId) await blobs.delete(blobId); throw error; }
      await d.audit(`user:${actor.id}`, 'approval.submit', `approval:${id}`, { chainId: chain.id, subjectType: 'partner-kit', company: company.id, action });
      const step = currentStep(approval);
      if (step) {
        const line = `${actor.email} asked to ${action} the kit for ${company.name} on the "${step.name}" step.`;
        await store.putMessage({
          id: `msg_${randomId(8)}`, kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
          title: `Approval requested: ${title}`, body: line, cta: { label: 'Review', url: '/admin#/approvals' }, dismissible: true,
        });
        const reviewers = (await store.listUsers()).filter((u) => !u.disabledAt && u.id !== actor.id && isEligible(step, u.groups));
        d.notifier.email(reviewers.map((u) => u.email), `Approval requested: ${title}`, `${line}\n\nReview: ${new URL(d.baseUrl).origin}/admin#/approvals`);
      }
      d.notifier.event('approval.requested', { id, title, chainId: chain.id, by: actor.email });
      return { pending: { approvalId: id } };
    } finally {
      filing.delete(company.id);
    }
  };
  const save = async (req: IncomingMessage, res: ServerResponse, context: Context) => {
    if (!live(res, context) || await waiting(res, context.company.id)) return;
    const bytes = await readRaw(req, KIT_MAX_BYTES);
    const profile = await store.getCompanyProfile(context.company.id);
    if (profile?.settings.kitApprovalChain) {
      const target = profile.kit ? await store.getInstanceAsset(profile.kit.assetId) : null;
      if (profile.kit && !target) return sendError(res, 409, 'KIT_MISSING', 'remove the missing kit before saving a new one');
      const checked = await prepareCompanyKit(store, context.company.id, bytes, target ?? undefined);
      if (!checked.ok) return sendError(res, 422, 'INVALID_SUBMISSION', checked.detail);
      const asked = await askApproval(context.actor, context.company, profile.settings.kitApprovalChain, 'save', checked.bytes);
      if ('error' in asked) return sendError(res, ...asked.error);
      return sendJson(res, 202, asked, { 'cache-control': 'no-store' });
    }
    const saved = await publish(context.actor, context.company, bytes);
    if ('error' in saved) return sendError(res, ...saved.error);
    sendJson(res, 200, saved.view, { 'cache-control': 'no-store' });
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
    if (await waiting(res, context.company.id)) return;
    const profile = await store.getCompanyProfile(context.company.id);
    if (!profile?.kit) return sendError(res, 404, 'NOT_FOUND', 'this company has no kit');
    if (profile.settings.kitApprovalChain) {
      const asked = await askApproval(context.actor, context.company, profile.settings.kitApprovalChain, 'remove');
      if ('error' in asked) return sendError(res, ...asked.error);
      return sendJson(res, 202, asked, { 'cache-control': 'no-store' });
    }
    const removed = await remove(context.actor.id, context.company);
    if ('error' in removed) return sendError(res, ...removed.error);
    sendJson(res, 200, removed, { 'cache-control': 'no-store' });
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

  /** Apply the decision only while the company and programme are live. */
  const settleApproval = async (approval: Approval): Promise<boolean> => {
    if (approval.subjectType !== 'partner-kit' || !approval.partnerKit) return false;
    const subject = approval.partnerKit;
    let applied = false;
    try {
      if (approval.state === 'approved' && await kitCompanyLive(store, subject.companyId)) {
        const company = (await store.listCompanies()).find((c) => c.id === subject.companyId)!;
        const via = { approval: approval.id };
        if (subject.action === 'remove') applied = !('error' in await remove(approval.createdBy, company, via));
        else if (subject.blobId) {
          const held = await blobs.get(subject.blobId);
          const actor = await store.getUser(approval.createdBy);
          if (held) applied = !('error' in await publish({ id: approval.createdBy, groups: actor?.groups ?? [] }, company, await readBlobBody(held.body, KIT_MAX_BYTES), via));
        }
      }
    } finally {
      if (subject.blobId) await blobs.delete(subject.blobId);
    }
    await store.putMessage({
      id: `msg_${randomId(8)}`, kind: 'approval', severity: applied ? 'info' : 'action', audience: { users: [approval.createdBy] },
      title: applied ? 'Company kit updated' : 'Company kit not changed',
      body: applied ? 'Your kit change is live.'
        : approval.state === 'approved' ? 'The change was approved but could not be applied, so the kit did not change. Save the kit again.'
          : `The request was ${approval.state}, so the kit did not change.`,
      dismissible: true,
    });
    d.notifier.event('approval.decided', { id: approval.id, title: approval.title, state: approval.state });
    return true;
  };
  const forgetCompany = async (companyId: string): Promise<void> => {
    for (const approval of await store.listApprovals()) {
      if (approval.subjectType !== 'partner-kit' || approval.partnerKit?.companyId !== companyId) continue;
      if (approval.partnerKit.blobId) await blobs.delete(approval.partnerKit.blobId);
      if (approval.state === 'submitted' || approval.state === 'in_review') await store.putApproval(withdraw(approval, approval.createdBy, new Date().toISOString()));
    }
  };
  return { settleApproval, forgetCompany };
}
