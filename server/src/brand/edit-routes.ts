// SPDX-License-Identifier: MPL-2.0
/**
 * A manager's path: edit the active design system's colours, colour roles and brand
 * page address in the studio, send the result, and this instance serves it with no
 * pack rebuild.
 *
 * Recording what happened costs nobody anything, so it always happens: an immutable
 * revision with a digest, who sent it and when, audit entries and a rollback. Anything
 * that stops a person is off until an administrator turns it on. With no approval chain
 * an edit goes live when it is sent, and after a new image it stays on top with a quiet
 * note. An administrator can ask for approval first, and can ask someone to look after
 * a new image. The edit stays live while they do.
 *
 * Which revision is live is a pointer in the brand state, so going live and rolling
 * back commit with their audit event. Rolling back drops the pointer and the mounted
 * tokens are served again, exactly as they were.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter, type RouteCtx } from '../api/router.ts';
import { createApproval, currentStep, isEligible, type Approval } from '../approvals/engine.ts';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { canonicalJson, randomId, sha256Hex } from '../lib/crypto.ts';
import type { Notifier } from '../notify/notify.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { applyBrandChanges, BRAND_EDIT_MAX_BYTES, BrandEditRefusal, checkDocumentShape, compareBrandDocument, describeBrandChanges, outOfScopeMessage, TOKEN_EXT, goneMessage, type BrandEditChange } from './edit-document.ts';
import type { BrandEditRevisionSummary } from './edit-store.ts';
import { BrandError, type BrandService, type BrandSnapshot } from './service.ts';
import type { BrandSource } from './sources.ts';
import { brandEditPolicy, type BrandEditPointer, type BrandState } from './state.ts';
import { JSON_BODY_CONTROL_BYTES } from '../api/body-limits.ts';

export const BRAND_EDIT_ACTION = 'brand.edit';
/** Revisions whose documents are kept per source. Older ones stay in the history with their digests. */
export const KEEP_DOCUMENTS = 50;
export const HISTORY_LIMIT = 200;

export interface BrandEditsDeps {
  config: InstanceConfig;
  store: Store;
  blobs: BlobStore;
  brand: BrandService;
  notifier: Pick<Notifier, 'email' | 'event'>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  serviceAccountOf(req: IncomingMessage): Promise<UserRecord | null>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
}

const actorOf = (user: Pick<UserRecord, 'id'>): string => (user.id.startsWith('svc_') ? `service:${user.id}` : `user:${user.id}`);
const subjectOf = (sourceId: string): string => `brand-edit:${sourceId}`;
const documentBlob = (sourceId: string, n: number, digest: string): string => `brand-edit/${sha256Hex(sourceId).slice(0, 32)}/${n}/${digest}`;

/** What a shell needs to offer an edit. Null when this deployment cannot keep one. */
export function brandEditsCapability(snap: BrandSnapshot, mutable: boolean): { approval: boolean } | null {
  if (!mutable || !snap.source.tokensHead || snap.source.diagnostics.length) return null;
  return { approval: !!brandEditPolicy(snap.state).approvalChain };
}

interface SentDocument { doc: Record<string, unknown>; bytes: Buffer; digest: string }

/** The document exactly as sent. Its digest covers these bytes, and these bytes are what gets served. */
function readSent(body: { document?: unknown; digest?: unknown } | null): SentDocument {
  if (!body || typeof body.document !== 'string') throw new BrandEditRefusal('INVALID_INPUT', 'Sending an edit needs the document as text.', 400);
  const bytes = Buffer.from(body.document, 'utf8');
  if (bytes.length > BRAND_EDIT_MAX_BYTES) throw new BrandEditRefusal('BRAND_EDIT_TOO_LARGE', `A design system document can be at most ${BRAND_EDIT_MAX_BYTES} bytes.`, 413);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (body.digest !== digest) throw new BrandEditRefusal('BRAND_EDIT_DIGEST', 'The document does not match its digest, so nothing was saved.', 409);
  let parsed: unknown;
  try { parsed = JSON.parse(body.document); } catch { throw new BrandEditRefusal('BRAND_EDIT_INVALID', 'This document is not valid JSON.'); }
  return { doc: checkDocumentShape(parsed), bytes, digest };
}

export function createBrandEdits(d: BrandEditsDeps) {
  const { store, blobs, brand } = d;
  const refuse = (res: ServerResponse, error: BrandEditRefusal | BrandError): void => sendError(res, error.status, error.code, error.message);
  const engine = async () => {
    const specifier: string = '@lolly/engine/brand-policy';
    return await import(specifier) as { brandSystemOf(doc: unknown): unknown };
  };

  /** The mounted document under an edit: what every comparison is made against. */
  const mountedDocument = async (source: BrandSource): Promise<{ doc: Record<string, unknown>; bytes: Buffer; source: BrandSource }> => {
    const mounted = await brand.mountedOf(source.id);
    if (!mounted || !mounted.tokensHead || mounted.diagnostics.length) throw new BrandError('This source has no tokens file to edit.', 409, 'BRAND_EDIT_NO_TOKENS');
    const bytes = await brand.tokenBytes(mounted);
    return { doc: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, bytes, source: mounted };
  };

  const inspect = async (snap: BrandSnapshot, sent: SentDocument, base: unknown) => {
    if (base !== snap.source.baseTokensChecksum) throw new BrandEditRefusal('BRAND_EDIT_BASE_MOVED', 'The design system on this instance has changed. Open it again and repeat the edit.', 409);
    const mounted = await mountedDocument(snap.source);
    const comparison = compareBrandDocument(mounted.doc, sent.doc);
    const systemOf = (doc: Record<string, unknown>): unknown => {
      const ext = doc.$extensions;
      const vendor = ext && typeof ext === 'object' ? (ext as Record<string, unknown>)[TOKEN_EXT] : null;
      return vendor && typeof vendor === 'object' ? (vendor as Record<string, unknown>).brandSystem : undefined;
    };
    // A record the engine cannot read takes the house rules with it, with no error.
    const raw = systemOf(sent.doc);
    if (raw !== undefined && canonicalJson(raw) !== canonicalJson(systemOf(mounted.doc) ?? null) && !(await engine()).brandSystemOf(sent.doc)) {
      comparison.invalid.push('The list of colour roles cannot be read, and the design system\'s rules would stop applying.');
    }
    return comparison;
  };

  const reviewToken = (snap: BrandSnapshot, digest: string): string => sha256Hex(canonicalJson({
    digest, base: snap.source.baseTokensChecksum, revision: snap.state.revision, live: brand.pointerOf(snap.state, snap.source.id)?.digest ?? null,
  }));

  const nameOf = async (id: string, names: Map<string, string | null>): Promise<string | null> => {
    if (!names.has(id)) {
      const user = id.startsWith('svc_') ? null : await store.getUser(id);
      names.set(id, user ? ([user.firstname, user.lastname].filter(Boolean).join(' ') || user.email) : null);
    }
    return names.get(id) ?? null;
  };
  const revisionWire = async (row: BrandEditRevisionSummary, names: Map<string, string | null>) => ({
    n: row.n, digest: row.digest, state: row.state, changes: row.changeCount, size: row.size, baseChecksum: row.baseChecksum,
    sentBy: row.sentBy, sentByName: await nameOf(row.sentBy, names), approvalId: row.approvalId, restoredFrom: row.restoredFrom,
    createdAt: row.createdAt, liveAt: row.liveAt, endedAt: row.endedAt, endedBy: row.endedBy, endedByName: row.endedBy ? await nameOf(row.endedBy, names) : null,
  });

  /** Whether the connect download carries what is served, in words a console can act on. */
  const connectState = (snap: BrandSnapshot): 'none' | 'kept' | 'derived' | 'withdrawn' | 'stopped' => {
    const download = snap.state.download;
    if (!download.blobId) return 'none';
    if (download.suppressed) return 'stopped';
    const offered = brand.offeredDownload(snap);
    return offered?.derived ? 'derived' : offered ? 'kept' : 'withdrawn';
  };

  const stateWire = async (snap: BrandSnapshot, user: UserRecord) => {
    const pointer = brand.pointerOf(snap.state, snap.source.id);
    const rows = await store.listBrandEditRevisions(snap.source.id, HISTORY_LIMIT), names = new Map<string, string | null>();
    const policy = brandEditPolicy(snap.state);
    const canChangeSettings = brand.mutable && await brand.allowed(user, 'policy.edit');
    const view = snap.source.edit;
    const live = pointer ? rows.find(row => row.n === pointer.revision) : undefined;
    const pending = rows.find(row => row.state === 'pending');
    return {
      available: brand.mutable && !!snap.source.tokensHead && !snap.source.diagnostics.length,
      limitation: brand.mutable ? null : 'This deployment cannot keep an edit. Configure Postgres, or update the mounted source and redeploy.',
      sourceId: snap.source.id, sourceLabel: snap.source.label, revision: snap.state.revision, baseChecksum: snap.source.baseTokensChecksum, maxDocumentBytes: BRAND_EDIT_MAX_BYTES,
      edit: pointer && view ? {
        ...(live ? await revisionWire(live, names) : {}),
        state: view.state, overlaps: view.overlaps, gone: view.gone, goneMessage: goneMessage(view.gone), revision: pointer.revision, digest: pointer.digest, baseChecksum: pointer.baseChecksum,
        // Only with the switch on is a person asked to do anything.
        ask: view.state === 'on-new-image' && policy.lookAfterImage && pointer.lookedAtBase !== snap.source.baseTokensChecksum,
      } : null,
      pending: pending ? await revisionWire(pending, names) : null,
      revisions: await Promise.all(rows.map(row => revisionWire(row, names))),
      settings: policy, canChangeSettings,
      ...(canChangeSettings ? { chains: (await store.listChains()).map(chain => ({ id: chain.id, name: chain.name })) } : {}),
      connect: connectState(snap),
    };
  };

  const removeDocument = async (row: { sourceId: string; n: number; digest: string }): Promise<void> => {
    await blobs.delete(documentBlob(row.sourceId, row.n, row.digest)).catch(error => console.error(`[brand-edits] could not remove a document: ${(error as Error).message}`));
  };

  const trim = async (sourceId: string): Promise<void> => {
    const rows = await store.listBrandEditRevisions(sourceId, HISTORY_LIMIT);
    for (const row of rows.slice(KEEP_DOCUMENTS)) if (row.state !== 'live' && row.state !== 'pending') await removeDocument(row);
  };

  /**
   * Point the source at one revision. The pointer and the audit entry commit together,
   * and a commit that loses to another brand change tries again on the new state: this
   * revision was already sent or approved, so an unrelated change must not lose it.
   */
  const goLive = async (sourceId: string, row: { n: number; digest: string; baseChecksum: string }, actor: string): Promise<BrandState> => {
    const mounted = await brand.mountedOf(sourceId);
    if (!mounted) throw new BrandError('This source is no longer installed.', 409, 'BRAND_EDIT_NO_TOKENS');
    for (let attempt = 0; attempt < 5; attempt++) {
      const prior = await brand.snapshot(), before = prior.state;
      const previous = brand.pointerOf(before, sourceId);
      const pointer: BrandEditPointer = { revision: row.n, digest: row.digest, blobId: documentBlob(sourceId, row.n, row.digest), baseChecksum: row.baseChecksum };
      const draft: BrandState = { ...before, edits: { ...before.edits, [sourceId]: pointer } };
      const source = await brand.withEdit(mounted, draft);
      const pack = await brand.derivePack(source, draft, actor);
      if (pack) pointer.pack = pack;
      const at = new Date().toISOString();
      const { revision: _revision, ...next } = draft;
      const result = await store.casBrandState(before.revision, next, { at, actor, action: 'brand.edit.live', subject: subjectOf(sourceId),
        payload: { revision: row.n, digest: row.digest, baseChecksum: row.baseChecksum, previous: previous?.revision ?? null, connectPack: pack ? 'derived' : 'not-derived' } });
      if (!result) continue;
      if (previous && previous.revision !== row.n) await store.setBrandEditRevisionState(sourceId, previous.revision, ['live'], 'superseded', { endedAt: at });
      await store.setBrandEditRevisionState(sourceId, row.n, ['staged', 'pending'], 'live', { liveAt: at });
      if (previous?.pack && previous.pack.blobId !== pack?.blobId) await blobs.delete(previous.pack.blobId).catch(() => {});
      brand.committed(prior);
      await trim(sourceId).catch(error => console.error(`[brand-edits] could not trim ${sourceId}: ${(error as Error).message}`));
      return result;
    }
    throw new BrandError('The design system kept changing. Try again.', 409, 'STALE_PREVIEW');
  };

  /** Store one document, then send it to its chain or straight live. */
  const commit = async (user: UserRecord, snap: BrandSnapshot, sent: { bytes: Buffer; digest: string; baseChecksum: string; changes: BrandEditChange[]; restoredFrom?: number }): Promise<{ status: number; body: Record<string, unknown> }> => {
    const sourceId = snap.source.id, policy = brandEditPolicy(snap.state), actor = actorOf(user);
    const rows = await store.listBrandEditRevisions(sourceId, HISTORY_LIMIT);
    if (rows.some(row => row.state === 'pending')) throw new BrandError('An edit of this design system is waiting for approval. Withdraw that request first.', 409, 'BRAND_EDIT_PENDING');
    const chain = policy.approvalChain ? await store.getChain(policy.approvalChain) : null;
    if (policy.approvalChain && !chain) throw new BrandError('The approval chain this instance names for edits does not exist. Nothing was sent.', 409, 'CHAIN_NOT_FOUND');
    if (chain && user.id.startsWith('svc_')) throw new BrandError('On this instance an edit goes through an approval chain, and a person has to ask for that.', 403, 'HUMAN_APPROVAL_REQUIRED');
    const at = new Date().toISOString();
    const row = await store.addBrandEditRevision({ sourceId, digest: sent.digest, baseChecksum: sent.baseChecksum, changes: sent.changes, size: sent.bytes.length, sentBy: user.id, ...(sent.restoredFrom ? { restoredFrom: sent.restoredFrom } : {}), at });
    try {
      await blobs.put(documentBlob(sourceId, row.n, sent.digest), sent.bytes, 'application/json', { size: sent.bytes.length, sha256: sent.digest });
    } catch (error) {
      console.error(`[brand-edits] could not store revision ${row.n}: ${(error as Error).message}`);
      await store.setBrandEditRevisionState(sourceId, row.n, ['staged'], 'failed');
      throw new BrandError('The document could not be stored. Nothing changed.', 502, 'BRAND_EDIT_STORE_FAILED');
    }
    const facts = { revision: row.n, digest: sent.digest, baseChecksum: sent.baseChecksum, changes: sent.changes.length, ...(sent.restoredFrom ? { restoredFrom: sent.restoredFrom } : {}) };
    await d.audit(actor, 'brand.edit.send', subjectOf(sourceId), facts);
    if (chain) {
      const approvalId = `apr_${randomId(8)}`;
      const title = `Change the colours of ${snap.source.label}`;
      const approval: Approval = {
        ...createApproval({ id: approvalId, subjectType: 'brand-edit', subjectRef: `brand-edit:${sourceId}:${row.n}:${sent.digest}`, title, chain, nominees: [], createdBy: user.id, now: at }),
        brandEdit: { sourceId, revision: row.n, digest: sent.digest, changes: sent.changes.length },
      };
      await store.putApproval(approval);
      await store.setBrandEditRevisionState(sourceId, row.n, ['staged'], 'pending', { approvalId });
      await d.audit(actor, 'approval.submit', `approval:${approvalId}`, { chainId: chain.id, subjectType: 'brand-edit', sourceId });
      const step = currentStep(approval);
      if (step) {
        const line = `${user.email} asked for review on the “${step.name}” step.`;
        await store.putMessage({
          id: `msg_${randomId(8)}`, kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
          title: `Approval requested: ${title}`, body: line, cta: { label: 'Review', url: '/admin#/approvals' }, dismissible: true,
        });
        const origin = new URL(d.config.instance.baseUrl).origin;
        const reviewers = (await store.listUsers()).filter(candidate => !candidate.disabledAt && candidate.id !== user.id && isEligible(step, candidate.groups));
        d.notifier.email(reviewers.map(candidate => candidate.email), `Approval requested: ${title}`, `${line}\n\nReview it: ${origin}/admin#/approvals`);
      }
      d.notifier.event('approval.requested', { id: approvalId, title, chainId: chain.id, by: user.email });
      return { status: 202, body: { state: 'pending', revision: row.n, digest: sent.digest, approvalId } };
    }
    await goLive(sourceId, row, actor);
    return { status: 201, body: { state: 'live', revision: row.n, digest: sent.digest } };
  };

  /** Settles the one revision an approval names. A refused revision's document goes, as nobody will decide on it again. */
  const settleApproval = async (approval: Approval, actorId: string): Promise<boolean> => {
    if (approval.subjectType !== 'brand-edit' || !approval.brandEdit) return false;
    const { sourceId, revision: n, digest } = approval.brandEdit;
    const row = await store.getBrandEditRevision(sourceId, n);
    if (!row || row.approvalId !== approval.id || row.digest !== digest || row.state !== 'pending') return true;
    const actor = `user:${actorId}`, approved = approval.state === 'approved';
    if (approved) {
      await goLive(sourceId, row, actor);
    } else {
      const state = approval.state === 'withdrawn' ? 'withdrawn' : 'rejected';
      await store.setBrandEditRevisionState(sourceId, n, ['pending'], state, { endedAt: new Date().toISOString(), endedBy: actorId });
      await removeDocument(row);
      await d.audit(actor, `brand.edit.${state}`, subjectOf(sourceId), { revision: n, digest, approvalId: approval.id });
    }
    await store.putMessage({
      id: `msg_${randomId(8)}`, kind: 'approval', severity: approved ? 'info' : 'action', audience: { users: [approval.createdBy] },
      title: approved ? 'Design system edit live' : 'Design system edit not sent', body: approved ? 'People get the change at their next catalogue sync.' : `The request was ${approval.state}, and its document is gone.`,
      cta: { label: 'View', url: '/admin#/instance?tab=design' }, data: { kind: 'brand-edit', revision: String(n), approvalId: approval.id, state: approval.state }, dismissible: true,
    });
    d.notifier.event('approval.decided', { id: approval.id, title: approval.title, state: approval.state });
    return true;
  };

  // Each replica says so at most once per state. The message id comes from the state,
  // so a second replica writes the same message and nobody hears it twice.
  const noted = new Set<string>();
  const noteState = (snap: BrandSnapshot): void => {
    const view = snap.source.edit, pointer = brand.pointerOf(snap.state, snap.source.id);
    if (!view || !pointer) return;
    if (view.state === 'unavailable') { console.error(`[brand-edits] revision ${view.revision} of ${snap.source.id} could not be read; serving the mounted tokens`); return; }
    const asked = view.state === 'on-new-image' && brandEditPolicy(snap.state).lookAfterImage && pointer.lookedAtBase !== snap.source.baseTokensChecksum;
    if (view.state !== 'cannot-apply' && !asked) return;
    const key = `${snap.source.id}\u0000${snap.source.baseTokensChecksum}\u0000${view.digest}\u0000${view.state}`;
    if (noted.has(key)) return;
    noted.add(key);
    void (async () => {
      const grants = await store.listGrants();
      const people = (await store.listUsers()).filter(user => !user.disabledAt && evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, BRAND_EDIT_ACTION, ['*'], grants));
      await store.putMessage({
        id: `msg_brand_edit_${sha256Hex(key).slice(0, 24)}`, kind: 'approval', severity: asked ? 'action' : 'info', audience: { users: people.map(user => user.id) },
        title: asked ? 'A new image arrived: look at this instance\'s edit' : 'An edit no longer applies',
        body: asked
          ? 'The edit stays live. Keep it, or roll it back.'
          : `${goneMessage(view.gone)} This instance is serving the image's own colours. The revision stays in the history.`,
        cta: { label: 'View', url: '/admin#/instance?tab=design' }, data: { kind: 'brand-edit', revision: String(view.revision) }, dismissible: true,
      });
    })().catch(error => { noted.delete(key); console.error(`[brand-edits] could not send a note: ${(error as Error).message}`); });
  };

  const requireEditor = async (req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null> => {
    const user = await d.requireAction(req, res, BRAND_EDIT_ACTION);
    if (!user) return null;
    if (!brand.mutable) { sendError(res, 409, 'READ_ONLY', 'This deployment cannot keep an edit. Configure Postgres, or update the mounted source and redeploy.'); return null; }
    return user;
  };

  const attempt = async (res: ServerResponse, work: () => Promise<void>): Promise<void> => {
    try { await work(); }
    catch (error) {
      if (error instanceof BrandEditRefusal || error instanceof BrandError) return refuse(res, error);
      throw error;
    }
  };

  const register = (router: ReturnType<typeof createRouter>): void => {
    router.add('GET', '/api/v1/brand/edits', async (req, res) => {
      const user = await d.requireAction(req, res, BRAND_EDIT_ACTION);
      if (!user) return;
      sendJson(res, 200, await stateWire(await brand.snapshot(), user), { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    // What the studio starts from and compares with.
    router.add('GET', '/api/v1/brand/edits/document', async (req, res) => {
      if (!(await d.requireAction(req, res, BRAND_EDIT_ACTION))) return;
      await attempt(res, async () => {
        const snap = await brand.snapshot();
        const mounted = await mountedDocument(snap.source);
        const served = (await brand.tokenBytes(snap.source)).toString('utf8');
        sendJson(res, 200, { sourceId: snap.source.id, label: snap.source.label, baseChecksum: snap.source.baseTokensChecksum, base: mounted.bytes.toString('utf8'), served, live: brand.pointerOf(snap.state, snap.source.id)?.revision ?? null }, { 'cache-control': 'no-store' });
      });
    }, { delivery: 'person-private' });

    const previewOf = async (snap: BrandSnapshot, sent: SentDocument, base: unknown) => {
      const comparison = await inspect(snap, sent, base);
      const live = brand.pointerOf(snap.state, snap.source.id);
      return {
        lines: describeBrandChanges(comparison.changes), changes: comparison.changes, outOfScope: comparison.outOfScope, invalid: comparison.invalid,
        unchanged: !comparison.changes.length || (live?.digest === sent.digest && live.baseChecksum === base),
        approval: !!brandEditPolicy(snap.state).approvalChain, digest: sent.digest, revision: snap.state.revision, reviewToken: reviewToken(snap, sent.digest),
        // What happens to the connect download if this goes live.
        connect: await connectAfter(snap, sent),
      };
    };

    /** Whether a connect pack can carry this edit, so nobody learns afterwards that the door closed. */
    const connectAfter = async (snap: BrandSnapshot, sent: SentDocument): Promise<'none' | 'derived' | 'withdrawn' | 'stopped'> => {
      const download = snap.state.download;
      if (!download.blobId || download.sourceId !== snap.source.id) return 'none';
      if (download.suppressed) return 'stopped';
      const mounted = await brand.mountedOf(snap.source.id);
      if (!mounted || download.sourceRevision !== mounted.baseRevision) return 'withdrawn';
      const signer = await brand.packSigner();
      const stored = signer ? await blobs.get(download.blobId) : null;
      if (!signer || !stored) return 'withdrawn';
      const { deriveInstancePack } = await import('../catalog/instance-pack.ts');
      return await deriveInstancePack(await readBlobBody(stored.body), sent.bytes, signer) ? 'derived' : 'withdrawn';
    };

    router.add('POST', '/api/v1/brand/edits/preview', async (req, res) => {
      if (!(await requireEditor(req, res))) return;
      await attempt(res, async () => {
        const body = await readJson(req, BRAND_EDIT_MAX_BYTES * 2 + 4096) as { document?: unknown; digest?: unknown; base?: unknown } | null;
        const preview = await previewOf(await brand.snapshot(), readSent(body), body?.base);
        const { changes: _changes, ...wire } = preview;
        sendJson(res, 200, wire, { 'cache-control': 'no-store' });
      });
    });

    router.add('POST', '/api/v1/brand/edits', async (req, res) => {
      const user = await requireEditor(req, res);
      if (!user) return;
      await attempt(res, async () => {
        const body = await readJson(req, BRAND_EDIT_MAX_BYTES * 2 + 4096) as { document?: unknown; digest?: unknown; base?: unknown; revision?: unknown; reviewToken?: unknown } | null;
        const sent = readSent(body), snap = await brand.snapshot();
        const comparison = await inspect(snap, sent, body?.base);
        if (comparison.outOfScope.length) throw new BrandEditRefusal('BRAND_EDIT_OUT_OF_SCOPE', outOfScopeMessage(comparison.outOfScope));
        if (comparison.invalid.length) throw new BrandEditRefusal('BRAND_EDIT_INVALID', comparison.invalid.slice(0, 8).join(' '));
        if (!Number.isSafeInteger(body?.revision) || typeof body?.reviewToken !== 'string') throw new BrandEditRefusal('INVALID_INPUT', 'Review the edit first, then send it with revision and reviewToken.', 400);
        if (body.revision !== snap.state.revision || body.reviewToken !== reviewToken(snap, sent.digest)) throw new BrandEditRefusal('STALE_PREVIEW', 'The design system changed. Review the edit again.', 409);
        const live = brand.pointerOf(snap.state, snap.source.id);
        if (live?.digest === sent.digest && live.baseChecksum === body.base) return sendJson(res, 200, { state: 'live', unchanged: true, revision: live.revision, digest: sent.digest });
        if (!comparison.changes.length) {
          if (live) throw new BrandEditRefusal('BRAND_EDIT_NOTHING', 'This document is the mounted one. To drop the edit, roll it back.', 409);
          return sendJson(res, 200, { state: 'none', unchanged: true });
        }
        const out = await commit(user, snap, { bytes: sent.bytes, digest: sent.digest, baseChecksum: String(body.base), changes: comparison.changes });
        sendJson(res, out.status, out.body);
      });
    });

    router.add('POST', '/api/v1/brand/edits/rollback', async (req, res) => {
      const user = await requireEditor(req, res);
      if (!user) return;
      await attempt(res, async () => {
        const body = await readJson(req, JSON_BODY_CONTROL_BYTES) as { to?: unknown } | null;
        const snap = await brand.snapshot(), sourceId = snap.source.id, actor = actorOf(user);
        // Back to an earlier revision is a new send of what it changed, on today's base, so a chain still decides.
        if (body?.to !== undefined && body.to !== null) {
          const row = Number.isSafeInteger(body.to) ? await store.getBrandEditRevision(sourceId, body.to as number) : null;
          if (!row || !row.liveAt) throw new BrandError('That revision never went live.', 404, 'NOT_FOUND');
          const mounted = await mountedDocument(snap.source);
          const landed = row.baseChecksum === snap.source.baseTokensChecksum ? null : applyBrandChanges(mounted.doc, row.changes);
          if (landed?.gone.length) throw new BrandError(goneMessage(landed.gone, 'That revision'), 409, 'BRAND_EDIT_CANNOT_APPLY');
          let bytes: Buffer;
          if (landed) bytes = Buffer.from(JSON.stringify(landed.doc));
          else {
            const stored = await blobs.get(documentBlob(sourceId, row.n, row.digest));
            if (!stored) throw new BrandError('That revision no longer holds its document.', 410, 'BRAND_EDIT_DOCUMENT_REMOVED');
            bytes = await readBlobBody(stored.body);
          }
          const digest = createHash('sha256').update(bytes).digest('hex');
          const baseChecksum = snap.source.baseTokensChecksum!;
          const changes = landed ? compareBrandDocument(mounted.doc, landed.doc).changes : row.changes;
          const out = await commit(user, snap, { bytes, digest, baseChecksum, changes, restoredFrom: row.n });
          return sendJson(res, out.status, out.body);
        }
        const pointer = brand.pointerOf(snap.state, sourceId);
        if (!pointer) return sendJson(res, 200, { state: 'none', unchanged: true });
        const at = new Date().toISOString();
        const { [sourceId]: _dropped, ...edits } = snap.state.edits ?? {};
        const { revision: expected, ...state } = snap.state;
        const result = await store.casBrandState(expected, { ...state, edits }, { at, actor, action: 'brand.edit.rollback', subject: subjectOf(sourceId), payload: { revision: pointer.revision, digest: pointer.digest } });
        if (!result) throw new BrandError('The design system changed. Try again.', 409, 'STALE_PREVIEW');
        await store.setBrandEditRevisionState(sourceId, pointer.revision, ['live'], 'rolled-back', { endedAt: at, endedBy: user.id });
        if (pointer.pack) await blobs.delete(pointer.pack.blobId).catch(() => {});
        brand.committed(snap);
        sendJson(res, 200, { state: 'none', revision: pointer.revision });
      });
    });

    // A person has looked at an edit after a new image, and keeps it.
    router.add('POST', '/api/v1/brand/edits/keep', async (req, res) => {
      const user = await requireEditor(req, res);
      if (!user) return;
      await attempt(res, async () => {
        const snap = await brand.snapshot(), sourceId = snap.source.id;
        const pointer = brand.pointerOf(snap.state, sourceId);
        if (!pointer) throw new BrandError('This instance has no edit to keep.', 404, 'NOT_FOUND');
        const { revision: expected, ...state } = snap.state;
        const result = await store.casBrandState(expected, { ...state, edits: { ...state.edits, [sourceId]: { ...pointer, lookedAtBase: snap.source.baseTokensChecksum! } } },
          { at: new Date().toISOString(), actor: actorOf(user), action: 'brand.edit.keep', subject: subjectOf(sourceId), payload: { revision: pointer.revision, digest: pointer.digest, base: snap.source.baseTokensChecksum } });
        if (!result) throw new BrandError('The design system changed. Try again.', 409, 'STALE_PREVIEW');
        sendJson(res, 200, { kept: true });
      });
    });

    // One plain switch per decision, for whoever holds policy.edit. A brand manager cannot turn off their own approval.
    router.add('PUT', '/api/v1/brand/edits/settings', async (req, res) => {
      const user = await d.requireAction(req, res, 'policy.edit');
      if (!user) return;
      if (!brand.mutable) return sendError(res, 409, 'READ_ONLY', 'This deployment cannot keep these settings. Configure Postgres.');
      await attempt(res, async () => {
        const body = await readJson(req, JSON_BODY_CONTROL_BYTES) as { approvalChain?: unknown; lookAfterImage?: unknown } | null;
        if (body?.approvalChain !== null && typeof body?.approvalChain !== 'string') throw new BrandEditRefusal('INVALID_INPUT', 'approvalChain is a chain id, or null for no approval.', 400);
        if (typeof body?.lookAfterImage !== 'boolean') throw new BrandEditRefusal('INVALID_INPUT', 'lookAfterImage is true or false.', 400);
        if (body.approvalChain && !await store.getChain(body.approvalChain)) throw new BrandEditRefusal('CHAIN_NOT_FOUND', 'That approval chain does not exist.', 409);
        const before = await store.getBrandState();
        const after = { approvalChain: body.approvalChain, lookAfterImage: body.lookAfterImage };
        const { revision: expected, ...state } = before;
        const prior = await brand.snapshot();
        const result = await store.casBrandState(expected, { ...state, editPolicy: after }, { at: new Date().toISOString(), actor: actorOf(user), action: 'brand.edit.settings', subject: 'brand-edit', payload: { before: brandEditPolicy(before), after } });
        if (!result) throw new BrandError('The design system changed. Try again.', 409, 'STALE_PREVIEW');
        brand.committed(prior);
        sendJson(res, 200, { settings: after });
      });
    });

    const revisionFor = async (res: ServerResponse, ctx: RouteCtx, sourceId: string) => {
      const n = Number(ctx.params.n);
      const row = Number.isSafeInteger(n) && n > 0 ? await store.getBrandEditRevision(sourceId, n) : null;
      if (!row) sendError(res, 404, 'NOT_FOUND', 'no such revision');
      return row;
    };
    /** Someone who may edit, or a reviewer whose chain holds this revision. Anyone else learns nothing. */
    const mayRead = async (req: IncomingMessage, res: ServerResponse, approvalId: string | null): Promise<boolean> => {
      const user = (await d.memberOf(req)) ?? (await d.serviceAccountOf(req));
      if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return false; }
      const subject = { userId: user.id, groups: user.groups, role: user.role as Role };
      const grants = await store.listGrants();
      if (evaluate(subject, BRAND_EDIT_ACTION, ['*'], grants)) return true;
      const approval = approvalId ? await store.getApproval(approvalId) : null;
      if (approval && evaluate(subject, 'approval.act', [`approval:${approval.id}`, `chain:${approval.chainId}`, approval.subjectRef, '*'], grants)) return true;
      sendError(res, 404, 'NOT_FOUND', 'no such revision');
      return false;
    };
    router.add('GET', '/api/v1/brand/edits/revisions/:n', async (req, res, ctx) => {
      const sourceId = ctx.url.searchParams.get('source') ?? (await brand.snapshot()).source.id;
      if (sourceId.length > 200) return sendError(res, 400, 'INVALID_INPUT', 'source is too long');
      const row = await revisionFor(res, ctx, sourceId);
      if (!row || !(await mayRead(req, res, row.approvalId))) return;
      const { changes, ...summary } = row;
      sendJson(res, 200, { revision: await revisionWire(summary, new Map()), lines: describeBrandChanges(changes) }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });
    router.add('GET', '/api/v1/brand/edits/revisions/:n/document', async (req, res, ctx) => {
      const sourceId = ctx.url.searchParams.get('source') ?? (await brand.snapshot()).source.id;
      if (sourceId.length > 200) return sendError(res, 400, 'INVALID_INPUT', 'source is too long');
      const row = await revisionFor(res, ctx, sourceId);
      if (!row || !(await mayRead(req, res, row.approvalId))) return;
      const stored = await blobs.get(documentBlob(sourceId, row.n, row.digest));
      if (!stored) return sendError(res, 410, 'BRAND_EDIT_DOCUMENT_REMOVED', 'This revision no longer holds its document.');
      const bytes = await readBlobBody(stored.body);
      if (createHash('sha256').update(bytes).digest('hex') !== row.digest) return sendError(res, 503, 'BRAND_EDIT_DOCUMENT_UNAVAILABLE', 'This document could not be read and checked.');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(bytes);
    }, { delivery: 'person-private' });
  };

  return { register, settleApproval, noteState };
}
