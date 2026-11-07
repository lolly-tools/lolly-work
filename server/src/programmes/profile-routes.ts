// SPDX-License-Identifier: MPL-2.0
/**
 * Company profile routes (plans/82 M3).
 *
 * The brand team, anyone with `programme.manage`, sets each partner company up
 * once from the company's page, without joining the company:
 *
 *   GET    /api/v1/programmes/:id/companies/:company/profile[?revision=N]
 *   PUT    /api/v1/programmes/:id/companies/:company/profile
 *   GET    /api/v1/programmes/:id/companies/:company/profile/history
 *   PUT    /api/v1/programmes/:id/companies/:company/profile/settings
 *   POST   /api/v1/programmes/:id/companies/:company/profile/logo?surface=light|dark|mark[&dryRun=1]
 *   GET    /api/v1/programmes/:id/companies/:company/profile/logo?surface=…
 *   DELETE /api/v1/programmes/:id/companies/:company/profile/logo?surface=…
 *
 * A company can name contacts who may edit (off by default). A contact uses
 * the same fields and the same checks through
 *
 *   GET/PUT /api/v1/me/company/profile
 *   POST/DELETE /api/v1/me/company/profile/logo?surface=…
 *
 * and their change applies at once, unless the company's approval switch names
 * an approval chain (also off by default): then it waits for that chain, and
 * applies on approval. A manager's own change never waits.
 *
 * Logos go through the submit pipeline as instance assets only that company's
 * people and tokens see; a replaced logo is a new version of the same asset.
 * The logo checks (logo-checks.ts) answer as data, so the console and the
 * contact's sheet say the same thing. Audit: `programme.company.profile.edit`
 * (the fields before and after), `programme.company.logo` (surface, asset id
 * and the warnings shown, never bytes) and `programme.company.profile.settings`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, readRaw, sendError, sendJson, type createRouter } from '../api/router.ts';
import { sendBytes, INERT_BYTE_HEADERS } from '../api/file-delivery.ts';
import type { BlobStore } from '../blobs/types.ts';
import type { Notifier } from '../notify/notify.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import type { SubmitOutcome } from '../catalog/submit.ts';
import { createApproval, currentStep, isEligible, type Approval } from '../approvals/engine.ts';
import { randomId, sha256Hex } from '../lib/crypto.ts';
import { companyGroup, type CompanyRecord } from './people.ts';
import { checkLogo, LOGO_SURFACES, PNG_MAX_BYTES, type LogoSurface, type LogoSurfaces, type LogoWarning } from './logo-checks.ts';
import {
  applyPatch, changedFields, emptyProfileRecord, LOGO_FIELD, readProfileBody, sameProfile,
  type CompanyProfile, type CompanyProfileRecord, type CompanyProfileSettings,
} from './profile.ts';

type Router = ReturnType<typeof createRouter>;

export interface CompanyProfileDeps {
  store: Store;
  blobs: BlobStore;
  notifier: Pick<Notifier, 'email' | 'event'>;
  baseUrl: string;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** The lead brand's light and dark surfaces, for the contrast check and the previews. */
  surfaces(): Promise<LogoSurfaces>;
  /** Store checked logo bytes through the catalog submit pipeline. */
  submitLogo(submitter: { id: string; groups: string[] }, input: { bytes: Buffer; name: string; companyLogo: { companyId: string; surface: LogoSurface }; target?: InstanceAssetRecord }): Promise<SubmitOutcome>;
}

/** What an approval for a contact's change carries (approvals/engine.ts). */
export interface CompanyProfileApproval {
  companyId: string;
  programmeId: string;
  /** The profile revision the contact was looking at. */
  baseRevision: number;
  /** The detail fields the contact changed, applied over whatever is current on approval. */
  patch?: Record<string, unknown>;
  /** A checked logo waiting in the blob store, or a logo the contact removed. */
  logo?: { surface: LogoSurface; blobId?: string; format?: 'svg' | 'png'; remove?: boolean; warnings: string[] };
}

const SURFACE_LABEL: Record<LogoSurface, string> = { light: 'for light surfaces', dark: 'for dark surfaces', mark: 'mark' };
const pendingBlob = (approvalId: string, surface: LogoSurface, format: string): string => `company-profile/pending/${approvalId}/${surface}.${format}`;
const OPEN = new Set(['submitted', 'in_review']);

async function blobBytes(blobs: BlobStore, id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const got = await blobs.get(id);
  if (!got) return null;
  return { bytes: Buffer.from(await new Response(got.body).arrayBuffer()), contentType: got.stat.contentType ?? 'application/octet-stream' };
}

export function createCompanyProfiles(d: CompanyProfileDeps) {
  const { store } = d;

  const recordOf = async (companyId: string): Promise<CompanyProfileRecord> => (await store.getCompanyProfile(companyId)) ?? emptyProfileRecord(companyId);

  /** The logo assets a profile names, as facts a client can draw from. */
  const logoFacts = async (profile: CompanyProfile) => {
    const out: Partial<Record<LogoSurface, { id: string; format: string; url: string; width?: number; height?: number; version: number }>> = {};
    for (const surface of LOGO_SURFACES) {
      const id = profile[LOGO_FIELD[surface]];
      const rec = id ? await store.getInstanceAsset(id) : null;
      const format = rec?.entry.formats?.[0];
      if (!rec || !format) continue;
      out[surface] = { id: rec.id, format: String(format.format), url: String(format.url), version: rec.headVersion ?? 1,
        ...(typeof rec.entry.width === 'number' ? { width: rec.entry.width } : {}), ...(typeof rec.entry.height === 'number' ? { height: rec.entry.height } : {}) };
    }
    return out;
  };

  const pendingFor = async (companyId: string): Promise<Approval | undefined> =>
    (await store.listApprovals()).find((a) => a.subjectType === 'company-profile' && a.companyProfile?.companyId === companyId && OPEN.has(a.state));

  const editorsOf = async (settings: CompanyProfileSettings) => {
    const out: Array<{ id: string; name: string; email: string }> = [];
    for (const id of settings.editors ?? []) {
      const u = await store.getUser(id);
      if (u) out.push({ id: u.id, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email, email: u.email });
    }
    return out;
  };

  /** The answer for a company: its record, the logo facts and the surfaces.
   *  `forManager` adds who edits, the approval switch and who saved. */
  const view = async (company: CompanyRecord, programme: { id: string; name: string }, rec: CompanyProfileRecord, opts: { forManager: boolean; mayEdit?: boolean }) => {
    const pending = await pendingFor(company.id);
    const { name: _savedName, logoVersions: _versions, ...profile } = rec.profile;
    return {
      company: { id: company.id, name: company.name },
      programme: { id: programme.id, name: programme.name },
      revision: rec.revision,
      profile,
      logos: await logoFacts(rec.profile),
      surfaces: await d.surfaces(),
      ...(rec.revision ? { updatedAt: rec.updatedAt } : {}),
      ...(opts.forManager ? {
        ...(rec.revision ? { updatedBy: rec.updatedBy } : {}),
        settings: { editors: await editorsOf(rec.settings), approvalChain: rec.settings.approvalChain ?? null },
      } : { mayEdit: !!opts.mayEdit, changesWait: !!opts.mayEdit && !!rec.settings.approvalChain }),
      ...(pending ? { pending: { approvalId: pending.id, ...(pending.companyProfile?.logo ? { logo: pending.companyProfile.logo.surface } : {}),
        ...(pending.companyProfile?.patch ? { fields: Object.keys(pending.companyProfile.patch) } : {}) } } : {}),
    };
  };

  /** Save one change as the next revision. Answers the new record, or null when
   *  someone else saved first. A change that changes nothing keeps the revision. */
  const save = async (actor: string, companyId: string, prior: CompanyProfileRecord, next: CompanyProfile, via?: Record<string, unknown>): Promise<CompanyProfileRecord | null> => {
    if (prior.revision && sameProfile(prior.profile, next)) return prior;
    const rec = { companyId, revision: prior.revision + 1, profile: next, updatedBy: actor, updatedAt: new Date().toISOString() };
    if (!(await store.saveCompanyProfile(rec, prior.revision))) return null;
    const fields = changedFields(prior.profile, next);
    const pick = (p: CompanyProfile) => Object.fromEntries(fields.map((f) => [f, (p as Record<string, unknown>)[f] ?? null]));
    await d.audit(actor, 'programme.company.profile.edit', `company:${companyId}`, { revision: rec.revision, fields, before: pick(prior.profile), after: pick(next), ...via });
    return { ...rec, settings: prior.settings };
  };

  /** Store a checked logo and point the profile at it, as one revision. */
  const storeLogo = async (actor: UserRecord, actorRef: string, company: CompanyRecord, surface: LogoSurface, bytes: Buffer, warnings: LogoWarning[] | string[], via?: Record<string, unknown>):
    Promise<{ ok: true; record: CompanyProfileRecord; assetId: string; version: number } | { ok: false; status: number; code: string; detail: string }> => {
    const prior = await recordOf(company.id);
    const field = LOGO_FIELD[surface];
    const currentId = prior.profile[field];
    const current = currentId ? await store.getInstanceAsset(currentId) : null;
    // A replaced logo is the next version of the same asset, when that asset is
    // still this company's logo for this surface.
    const meta = current?.entry.meta as { company?: unknown; surface?: unknown } | undefined;
    const target = current && meta?.company === company.id && meta.surface === surface ? current : undefined;
    const outcome = await d.submitLogo({ id: actor.id, groups: actor.groups }, {
      bytes, name: `${company.name} logo ${SURFACE_LABEL[surface]}`.slice(0, 200), companyLogo: { companyId: company.id, surface }, ...(target ? { target } : {}),
    });
    if (!outcome.ok) {
      const status = outcome.code === 'QUOTA_EXCEEDED' ? 409 : outcome.code === 'SCAN_UNAVAILABLE' ? 503 : 422;
      return { ok: false, status, code: outcome.code, detail: outcome.detail };
    }
    const assetId = outcome.record.id;
    const version = outcome.version ?? outcome.record.headVersion ?? 1;
    // A replaced logo keeps its asset id and moves its version, so the revision
    // records the version too and moves whenever the bytes do.
    const next: CompanyProfile = { ...prior.profile, [field]: assetId, logoVersions: { ...prior.profile.logoVersions, [surface]: version }, name: company.name };
    const saved = await save(actorRef, company.id, prior, next, via);
    if (!saved) return { ok: false, status: 409, code: 'PROFILE_CHANGED', detail: 'Someone else saved this profile at the same time. Open it again and retry.' };
    await d.audit(actorRef, 'programme.company.logo', `company:${company.id}`, {
      surface, asset: assetId, version, revision: saved.revision, duplicate: outcome.duplicate,
      warnings: warnings.map((w) => typeof w === 'string' ? w : w.code), ...via,
    });
    return { ok: true, record: saved, assetId, version };
  };

  const removeLogo = async (actorRef: string, company: CompanyRecord, surface: LogoSurface, via?: Record<string, unknown>): Promise<CompanyProfileRecord | null | 'none'> => {
    const prior = await recordOf(company.id);
    const field = LOGO_FIELD[surface];
    const assetId = prior.profile[field];
    if (!assetId) return 'none';
    const { [field]: _gone, ...rest } = prior.profile;
    const versions = { ...rest.logoVersions };
    delete versions[surface];
    const next: CompanyProfile = { ...rest, name: company.name };
    if (Object.keys(versions).length) next.logoVersions = versions; else delete next.logoVersions;
    const saved = await save(actorRef, company.id, prior, next, via);
    if (!saved) return null;
    // The removed logo stops being offered and served to the company.
    const life = await store.getLifecycle(assetId);
    await store.putLifecycle({ ...(life ?? { assetId, onExpiry: 'hide' as const }), revokedAt: new Date().toISOString() });
    await d.audit(actorRef, 'programme.company.logo', `company:${company.id}`, { surface, removed: assetId, revision: saved.revision, ...via });
    return saved;
  };

  // ── request plumbing ─────────────────────────────────────────────────────
  const surfaceOf = (url: URL, res: ServerResponse): LogoSurface | null => {
    const s = url.searchParams.get('surface') ?? '';
    if ((LOGO_SURFACES as readonly string[]).includes(s)) return s as LogoSurface;
    sendError(res, 400, 'INVALID_INPUT', 'surface must be light, dark or mark');
    return null;
  };
  const readLogoBytes = async (req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> => {
    let bytes: Buffer;
    try { bytes = await readRaw(req, PNG_MAX_BYTES); } catch {
      sendError(res, 413, 'LOGO_TOO_LARGE', 'A logo can be up to 512 KB as an SVG or 2048 KB as a PNG.');
      return null;
    }
    if (!bytes.length) { sendError(res, 400, 'INVALID_INPUT', 'send the logo file as the request body'); return null; }
    return bytes;
  };

  /** The manager's company, or null having answered. */
  const managed = async (req: IncomingMessage, res: ServerResponse, params: Record<string, string | undefined>) => {
    const actor = await d.requireAction(req, res, 'programme.manage'); if (!actor) return null;
    const programme = await store.getProgramme(String(params.id));
    if (!programme) { sendError(res, 404, 'NOT_FOUND', 'no such programme'); return null; }
    const company = (await store.listCompanies()).find((c) => c.id === params.company && c.programmeId === programme.id);
    if (!company) { sendError(res, 404, 'NOT_FOUND', 'no such company in this programme'); return null; }
    return { actor, programme, company };
  };

  /** The signed-in person's own company, or null having answered. One only:
   *  a person in two companies has no single company to speak for. */
  const ownCompany = async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await d.memberOf(req);
    if (!actor) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const companies = (await store.listCompanies()).filter((c) => actor.groups.includes(companyGroup(c.id)));
    if (!companies.length) { sendError(res, 404, 'NO_COMPANY', 'you are not in a partner company'); return null; }
    if (companies.length > 1) { sendError(res, 409, 'TWO_COMPANIES', 'you are in more than one partner company, so there is no single profile to show'); return null; }
    const company = companies[0]!;
    const programme = await store.getProgramme(company.programmeId);
    if (!programme) { sendError(res, 404, 'NO_COMPANY', 'you are not in a partner company'); return null; }
    const rec = await recordOf(company.id);
    return { actor, company, programme, rec, mayEdit: (rec.settings.editors ?? []).includes(actor.id) };
  };

  /** Open an approval for a contact's change. */
  const askApproval = async (actor: UserRecord, company: CompanyRecord, rec: CompanyProfileRecord, change: Omit<CompanyProfileApproval, 'companyId' | 'programmeId' | 'baseRevision'>, approvalId: string): Promise<{ status: number; body: Record<string, unknown> } | { error: [number, string, string] }> => {
    const chain = await store.getChain(rec.settings.approvalChain!);
    if (!chain?.steps.length) return { error: [409, 'CHAIN_NOT_FOUND', 'The approval chain this company names does not exist. Nothing was sent.'] };
    const at = new Date().toISOString();
    const subject: CompanyProfileApproval = { companyId: company.id, programmeId: company.programmeId, baseRevision: rec.revision, ...change };
    const digest = sha256Hex(JSON.stringify(subject)).slice(0, 16);
    const title = `Partner details: ${company.name}`;
    const approval: Approval = {
      ...createApproval({ id: approvalId, subjectType: 'company-profile', subjectRef: `company-profile:${company.id}:${rec.revision}:${digest}`, title, chain, nominees: [], createdBy: actor.id, now: at }),
      companyProfile: subject,
    };
    await store.putApproval(approval);
    await d.audit(`user:${actor.id}`, 'approval.submit', `approval:${approvalId}`, { chainId: chain.id, subjectType: 'company-profile', company: company.id });
    const step = currentStep(approval);
    if (step) {
      const line = `${actor.email} changed the details of ${company.name} and asked for review on the "${step.name}" step.`;
      await store.putMessage({
        id: `msg_${randomId(8)}`, kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
        title: `Approval requested: ${title}`, body: line, cta: { label: 'Review', url: '/admin#/approvals' }, dismissible: true,
      });
      const reviewers = (await store.listUsers()).filter((u) => !u.disabledAt && u.id !== actor.id && isEligible(step, u.groups));
      d.notifier.email(reviewers.map((u) => u.email), `Approval requested: ${title}`, `${line}\n\nReview it: ${new URL(d.baseUrl).origin}/admin#/approvals`);
    }
    d.notifier.event('approval.requested', { id: approvalId, title, chainId: chain.id, by: actor.email });
    return { status: 202, body: { state: 'pending', approvalId, revision: rec.revision } };
  };

  /**
   * Apply or drop a contact's change once its approval ends. Approved: the
   * patch goes over whatever is current (so a manager's change made meanwhile
   * stays), or the waiting logo is stored as the company's. Otherwise the
   * waiting logo bytes are deleted. Answers false for any other approval.
   */
  const settleApproval = async (approval: Approval, actorId: string): Promise<boolean> => {
    if (approval.subjectType !== 'company-profile' || !approval.companyProfile) return false;
    const subject = approval.companyProfile;
    const logoBlob = subject.logo?.blobId;
    const company = (await store.listCompanies()).find((c) => c.id === subject.companyId);
    const contact = await store.getUser(approval.createdBy);
    const via = { via: 'contact', contact: approval.createdBy, approval: approval.id, approvedBy: actorId };
    let applied = false;
    if (approval.state === 'approved' && company && contact) {
      const actorRef = `user:${approval.createdBy}`;
      if (subject.patch) {
        const prior = await recordOf(company.id);
        const patch = readProfileBody(subject.patch, { allowName: false });
        if (!('error' in patch)) applied = !!(await save(actorRef, company.id, prior, { ...applyPatch(prior.profile, patch), name: company.name }, via));
      } else if (subject.logo?.remove) {
        applied = (await removeLogo(actorRef, company, subject.logo.surface, via)) !== null;
      } else if (subject.logo && logoBlob) {
        const held = await blobBytes(d.blobs, logoBlob);
        if (held) applied = (await storeLogo(contact, actorRef, company, subject.logo.surface, held.bytes, subject.logo.warnings, via)).ok;
      }
    }
    if (logoBlob) await d.blobs.delete(logoBlob).catch(() => undefined);
    await store.putMessage({
      id: `msg_${randomId(8)}`, kind: 'approval', severity: applied ? 'info' : 'action', audience: { users: [approval.createdBy] },
      title: applied ? 'Company details updated' : 'Company details not changed',
      body: applied ? 'Your change is on every piece from now on.' : `The request was ${approval.state}, so nothing changed.`,
      dismissible: true,
    });
    d.notifier.event('approval.decided', { id: approval.id, title: approval.title, state: approval.state });
    return true;
  };

  function register(router: Router): void {
    const base = '/api/v1/programmes/:id/companies/:company/profile';

    router.add('GET', base, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const asked = ctx.url.searchParams.get('revision');
      if (asked !== null) {
        const n = Number(asked);
        const row = Number.isInteger(n) && n > 0 ? await store.getCompanyProfileRevision(m.company.id, n) : null;
        if (!row) return sendError(res, 404, 'NOT_FOUND', 'no such revision');
        // A revision read back keeps logoVersions: it names the exact logo bytes.
        const { name, ...profile } = row.profile;
        return sendJson(res, 200, { company: { id: m.company.id, name: name ?? m.company.name }, revision: row.revision, profile, updatedBy: row.updatedBy, updatedAt: row.updatedAt }, { 'cache-control': 'no-store' });
      }
      sendJson(res, 200, await view(m.company, m.programme, await recordOf(m.company.id), { forManager: true }), { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    router.add('GET', `${base}/history`, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const rows = await store.listCompanyProfileHistory(m.company.id);
      const revisions = rows.map((row, i) => ({ revision: row.revision, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
        fields: changedFields(rows[i - 1]?.profile ?? {}, row.profile).filter((f) => f !== 'name' || i > 0) }));
      sendJson(res, 200, { company: m.company.id, revisions: revisions.reverse() }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    /** The details, and optionally the company's name. A field absent keeps
     *  its value; null or "" clears it. `revision`, when sent, must be the
     *  current one, so two managers cannot overwrite each other unseen. */
    router.add('PUT', base, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const raw = await readJson(req);
      const patch = readProfileBody(raw, { allowName: true });
      if ('error' in patch) return sendError(res, 400, 'INVALID_INPUT', patch.error);
      const prior = await recordOf(m.company.id);
      const expected = (raw as { revision?: unknown } | null)?.revision;
      if (expected !== undefined && expected !== prior.revision) return sendError(res, 409, 'PROFILE_CHANGED', `This profile is at revision ${prior.revision} now. Open it again and retry.`);
      let company = m.company;
      if (patch.name && patch.name !== company.name) {
        company = { ...company, name: patch.name, updatedAt: new Date().toISOString() };
        await store.putCompany(company);
        await store.putLocalGroup({ name: companyGroup(company.id), description: `Partner company: ${company.name} (${m.programme.name})`, createdAt: m.company.createdAt });
        await d.audit(`user:${m.actor.id}`, 'programme.company.edit', `programme:${m.programme.id}`, { company: company.id, name: company.name, before: m.company.name });
      }
      const saved = await save(`user:${m.actor.id}`, company.id, prior, { ...applyPatch(prior.profile, patch), name: company.name });
      if (!saved) return sendError(res, 409, 'PROFILE_CHANGED', 'Someone else saved this profile at the same time. Open it again and retry.');
      sendJson(res, 200, await view(company, m.programme, saved, { forManager: true }), { 'cache-control': 'no-store' });
    });

    /** Who besides the managers may edit (people in the company, by id or
     *  address; an empty list turns contacts off) and the approval chain their
     *  changes wait for (null turns approval off). Both off by default. */
    router.add('PUT', `${base}/settings`, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const body = (await readJson(req)) as { editors?: unknown; approvalChain?: unknown } | null;
      const prior = await recordOf(m.company.id);
      const next: CompanyProfileSettings = { ...prior.settings };
      if (body?.editors !== undefined) {
        if (!Array.isArray(body.editors) || !body.editors.every((e) => typeof e === 'string') || body.editors.length > 50) return sendError(res, 400, 'INVALID_INPUT', 'editors is a list of up to 50 people in the company, by id or email');
        const group = companyGroup(m.company.id);
        const users = await store.listUsers();
        const ids: string[] = [];
        for (const who of body.editors as string[]) {
          const key = who.trim().toLowerCase();
          const u = users.find((x) => x.id === who.trim() || x.email.toLowerCase() === key);
          if (!u || !u.groups.includes(group) || u.disabledAt) return sendError(res, 400, 'NOT_IN_COMPANY', `${who.slice(0, 80)} is not a person in ${m.company.name}`);
          ids.push(u.id);
        }
        if (ids.length) next.editors = [...new Set(ids)]; else delete next.editors;
      }
      if (body?.approvalChain !== undefined) {
        if (body.approvalChain === null || body.approvalChain === '') delete next.approvalChain;
        else if (typeof body.approvalChain !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'approvalChain is a chain id, or null for no approval');
        else if (!(await store.getChain(body.approvalChain))?.steps.length) return sendError(res, 409, 'CHAIN_NOT_FOUND', 'That approval chain does not exist.');
        else next.approvalChain = body.approvalChain;
      }
      await store.putCompanyProfileSettings(m.company.id, next);
      await d.audit(`user:${m.actor.id}`, 'programme.company.profile.settings', `company:${m.company.id}`, {
        before: { editors: prior.settings.editors ?? [], approvalChain: prior.settings.approvalChain ?? null },
        after: { editors: next.editors ?? [], approvalChain: next.approvalChain ?? null },
      });
      sendJson(res, 200, await view(m.company, m.programme, { ...prior, settings: next }, { forManager: true }), { 'cache-control': 'no-store' });
    });

    /** Check, and unless `dryRun=1` store, one logo. The warnings come back as
     *  data with the surfaces to draw both previews on; a warning never refuses. */
    router.add('POST', `${base}/logo`, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const surface = surfaceOf(ctx.url, res); if (!surface) return;
      const bytes = await readLogoBytes(req, res); if (!bytes) return;
      const surfaces = await d.surfaces();
      const checked = await checkLogo(bytes, surface, surfaces);
      if (!checked.ok) return sendError(res, checked.status, checked.code, checked.detail);
      const facts = { surface, format: checked.format, ...(checked.width ? { width: checked.width } : {}), ...(checked.height ? { height: checked.height } : {}), inks: checked.inks, warnings: checked.warnings, surfaces };
      if (ctx.url.searchParams.get('dryRun') === '1') return sendJson(res, 200, { dryRun: true, ...facts }, { 'cache-control': 'no-store' });
      const stored = await storeLogo(m.actor, `user:${m.actor.id}`, m.company, surface, checked.bytes, checked.warnings);
      if (!stored.ok) return sendError(res, stored.status, stored.code, stored.detail);
      sendJson(res, 200, { dryRun: false, ...facts, asset: { id: stored.assetId, version: stored.version },
        profile: await view(m.company, m.programme, stored.record, { forManager: true }) }, { 'cache-control': 'no-store' });
    });

    /** The stored logo's bytes, for the console's previews: a manager is not in
     *  the company, so the company-scoped catalog feed does not serve it to them. */
    router.add('GET', `${base}/logo`, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const surface = surfaceOf(ctx.url, res); if (!surface) return;
      const id = (await recordOf(m.company.id)).profile[LOGO_FIELD[surface]];
      const rec = id ? await store.getInstanceAsset(id) : null;
      const [format, blobId] = rec ? Object.entries(rec.blobs)[0] ?? [] : [];
      const held = blobId ? await blobBytes(d.blobs, blobId) : null;
      if (!held) return sendError(res, 404, 'NOT_FOUND', 'no logo for that surface');
      sendBytes(req, res, held.bytes, { contentType: format === 'svg' ? 'image/svg+xml' : 'image/png', headers: { ...INERT_BYTE_HEADERS, 'cache-control': 'private, no-store' } });
    }, { delivery: 'person-private' });

    router.add('DELETE', `${base}/logo`, async (req, res, ctx) => {
      const m = await managed(req, res, ctx.params); if (!m) return;
      const surface = surfaceOf(ctx.url, res); if (!surface) return;
      const saved = await removeLogo(`user:${m.actor.id}`, m.company, surface);
      if (saved === 'none') return sendError(res, 404, 'NOT_FOUND', 'no logo for that surface');
      if (!saved) return sendError(res, 409, 'PROFILE_CHANGED', 'Someone else saved this profile at the same time. Open it again and retry.');
      sendJson(res, 200, await view(m.company, m.programme, saved, { forManager: true }), { 'cache-control': 'no-store' });
    });

    // ── a contact who may edit ─────────────────────────────────────────────
    router.add('GET', '/api/v1/me/company/profile', async (req, res) => {
      const own = await ownCompany(req, res); if (!own) return;
      sendJson(res, 200, await view(own.company, own.programme, own.rec, { forManager: false, mayEdit: own.mayEdit }), { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    const contactOnly = (res: ServerResponse, own: NonNullable<Awaited<ReturnType<typeof ownCompany>>>): boolean => {
      if (own.mayEdit) return true;
      sendError(res, 403, 'FORBIDDEN', 'the brand team keeps these details; ask them to change something');
      return false;
    };
    const waiting = async (res: ServerResponse, companyId: string): Promise<boolean> => {
      if (!(await pendingFor(companyId))) return false;
      sendError(res, 409, 'PROFILE_CHANGE_PENDING', 'A change to these details is waiting for approval. Withdraw it first, or wait for the decision.');
      return true;
    };

    router.add('PUT', '/api/v1/me/company/profile', async (req, res) => {
      const own = await ownCompany(req, res); if (!own || !contactOnly(res, own)) return;
      const raw = await readJson(req);
      const patch = readProfileBody(raw, { allowName: false });
      if ('error' in patch) return sendError(res, 400, 'INVALID_INPUT', patch.error);
      if (own.rec.settings.approvalChain) {
        if (await waiting(res, own.company.id)) return;
        if (!Object.keys(patch).length) return sendError(res, 400, 'INVALID_INPUT', 'nothing to change');
        const asked = await askApproval(own.actor, own.company, own.rec, { patch: patch as Record<string, unknown> }, `apr_${randomId(8)}`);
        if ('error' in asked) return sendError(res, ...asked.error);
        return sendJson(res, asked.status, asked.body, { 'cache-control': 'no-store' });
      }
      const saved = await save(`user:${own.actor.id}`, own.company.id, own.rec, { ...applyPatch(own.rec.profile, patch), name: own.company.name }, { via: 'contact' });
      if (!saved) return sendError(res, 409, 'PROFILE_CHANGED', 'Someone else saved these details at the same time. Open them again and retry.');
      sendJson(res, 200, await view(own.company, own.programme, saved, { forManager: false, mayEdit: true }), { 'cache-control': 'no-store' });
    });

    router.add('POST', '/api/v1/me/company/profile/logo', async (req, res, ctx) => {
      const own = await ownCompany(req, res); if (!own || !contactOnly(res, own)) return;
      const surface = surfaceOf(ctx.url, res); if (!surface) return;
      const bytes = await readLogoBytes(req, res); if (!bytes) return;
      const surfaces = await d.surfaces();
      const checked = await checkLogo(bytes, surface, surfaces);
      if (!checked.ok) return sendError(res, checked.status, checked.code, checked.detail);
      const facts = { surface, format: checked.format, ...(checked.width ? { width: checked.width } : {}), ...(checked.height ? { height: checked.height } : {}), inks: checked.inks, warnings: checked.warnings, surfaces };
      if (ctx.url.searchParams.get('dryRun') === '1') return sendJson(res, 200, { dryRun: true, ...facts }, { 'cache-control': 'no-store' });
      if (own.rec.settings.approvalChain) {
        if (await waiting(res, own.company.id)) return;
        // The checked bytes wait in the blob store until the decision.
        const approvalId = `apr_${randomId(8)}`;
        const blobId = pendingBlob(approvalId, surface, checked.format);
        await d.blobs.put(blobId, checked.bytes, checked.contentType);
        const asked = await askApproval(own.actor, own.company, own.rec, { logo: { surface, blobId, format: checked.format, warnings: checked.warnings.map((w) => w.code) } }, approvalId);
        if ('error' in asked) { await d.blobs.delete(blobId).catch(() => undefined); return sendError(res, ...asked.error); }
        return sendJson(res, asked.status, { ...asked.body, ...facts }, { 'cache-control': 'no-store' });
      }
      const stored = await storeLogo(own.actor, `user:${own.actor.id}`, own.company, surface, checked.bytes, checked.warnings, { via: 'contact' });
      if (!stored.ok) return sendError(res, stored.status, stored.code, stored.detail);
      sendJson(res, 200, { dryRun: false, ...facts, asset: { id: stored.assetId, version: stored.version },
        profile: await view(own.company, own.programme, stored.record, { forManager: false, mayEdit: true }) }, { 'cache-control': 'no-store' });
    });

    router.add('DELETE', '/api/v1/me/company/profile/logo', async (req, res, ctx) => {
      const own = await ownCompany(req, res); if (!own || !contactOnly(res, own)) return;
      const surface = surfaceOf(ctx.url, res); if (!surface) return;
      if (!own.rec.profile[LOGO_FIELD[surface]]) return sendError(res, 404, 'NOT_FOUND', 'no logo for that surface');
      if (own.rec.settings.approvalChain) {
        if (await waiting(res, own.company.id)) return;
        const asked = await askApproval(own.actor, own.company, own.rec, { logo: { surface, remove: true, warnings: [] } }, `apr_${randomId(8)}`);
        if ('error' in asked) return sendError(res, ...asked.error);
        return sendJson(res, asked.status, asked.body, { 'cache-control': 'no-store' });
      }
      const saved = await removeLogo(`user:${own.actor.id}`, own.company, surface, { via: 'contact' });
      if (saved === 'none') return sendError(res, 404, 'NOT_FOUND', 'no logo for that surface');
      if (!saved) return sendError(res, 409, 'PROFILE_CHANGED', 'Someone else saved these details at the same time. Open them again and retry.');
      sendJson(res, 200, await view(own.company, own.programme, saved, { forManager: false, mayEdit: true }), { 'cache-control': 'no-store' });
    });
  }

  /** What deleting a company does to its profile: the profile and its history
   *  go, its logos stop being served, and a waiting contact change is dropped. */
  const forgetCompany = async (companyId: string): Promise<void> => {
    const rec = await store.getCompanyProfile(companyId);
    const at = new Date().toISOString();
    for (const surface of LOGO_SURFACES) {
      const assetId = rec?.profile[LOGO_FIELD[surface]];
      if (!assetId) continue;
      const life = await store.getLifecycle(assetId);
      await store.putLifecycle({ ...(life ?? { assetId, onExpiry: 'hide' as const }), revokedAt: at });
    }
    for (const a of (await store.listApprovals()).filter((x) => x.subjectType === 'company-profile' && x.companyProfile?.companyId === companyId)) {
      if (a.companyProfile?.logo?.blobId) await d.blobs.delete(a.companyProfile.logo.blobId).catch(() => undefined);
    }
    await store.deleteCompanyProfile(companyId);
  };

  return { register, settleApproval, forgetCompany, recordOf };
}

export type CompanyProfiles = ReturnType<typeof createCompanyProfiles>;
