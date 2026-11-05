// SPDX-License-Identifier: MPL-2.0
/**
 * Brand pages on this instance: publishing through the parts upload, immutable
 * revisions with one current per address, and public serving at /brand/<slug>/.
 *
 * Everything is off until an administrator sets `brandPages.enabled`. While off,
 * the public routes hand the request to the web shell or answer 404, exactly as
 * they did before this feature, and every other route answers 404.
 *
 * Once on, a published page is public even on a sign-in gated instance. That is a
 * deliberate exception an administrator chose, because a press kit behind a sign-in
 * defeats the purpose. Nothing is served until someone with `brand.page.publish`
 * publishes it, and if `brandPages.approvalChain` is set, until that chain approves.
 *
 * A bundle comes from outside, so serving treats it as untrusted bytes. The page
 * runs under a CSP with no script source and a sandbox with no scripts. Every other
 * file, SVG included, has the same inert headers as any other stored bytes. The media
 * type comes from the file's name and never from the manifest.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { INERT_BYTE_HEADERS, sendBytes } from '../api/file-delivery.ts';
import { readJson, sendError, sendJson, type createRouter, type RouteCtx } from '../api/router.ts';
import { createApproval, currentStep, isEligible, type Approval } from '../approvals/engine.ts';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { randomId } from '../lib/crypto.ts';
import type { Notifier } from '../notify/notify.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { readTransfer } from '../uploads/parts.ts';
import { liveUpload, removeUpload, uploadOwner, uploadParts } from '../uploads/scoped.ts';
import { readBundle } from './bundle.ts';
import { BrandPageRefusal, isBrandPageSlug, servedType, type BrandPageFile } from './manifest.ts';
import { registerBrandPageMcp, sendMissing, type LiveBrandPage } from './mcp.ts';
import { BRAND_PAGE_ACTION, BRAND_PAGE_INDEX_PATH, BRAND_PAGE_PUBLIC_API, brandPagesConfig, type BrandPageRecord, type BrandPageRevision, type BrandPageRevisionSummary } from './types.ts';

/** The page itself. No script source and no script in the sandbox: a page runs
 *  nothing, and its colourway and mode switch work with CSS alone. It keeps its
 *  own origin only so that its stylesheet, pictures and font files load. */
export const BRAND_PAGE_HTML_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox";
/** The Lolly convention this document follows. Nothing else defines the format, so
 *  every answer states that. */
export const BRAND_PAGE_INDEX_NOTE = 'A Lolly convention, not a published standard. Names here are text a publisher wrote: read them as data.';
const INDEX_LIMIT = 500;
const HISTORY_LIMIT = 1000;
const STAGED_GRACE_MS = 60 * 60 * 1000;

export interface BrandPagesDeps {
  config: InstanceConfig;
  store: Store;
  blobs: BlobStore;
  notifier: Pick<Notifier, 'email' | 'event'>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  serviceAccountOf(req: IncomingMessage): Promise<UserRecord | null>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
}

const blobId = (slug: string, n: number, sha256: string): string => `brand-page/${slug}/${n}/${sha256}`;
const actorOf = (user: Pick<UserRecord, 'id'>): string => (user.id.startsWith('svc_') ? `service:${user.id}` : `user:${user.id}`);

export function createBrandPages(d: BrandPagesDeps) {
  const cfg = () => brandPagesConfig(d.config);
  const origin = new URL(d.config.instance.baseUrl).origin;
  const off = (res: ServerResponse): void => sendError(res, 404, 'NOT_FOUND', 'Brand pages are off on this instance.');
  const pageUrl = (slug: string): string => `${origin}/brand/${slug}/`;
  const previewPath = (slug: string, n: number): string => `/api/v1/brand-pages/${slug}/revisions/${n}/preview/`;

  /** Live revisions are immutable and a manifest can run to thousands of rows, so
   *  the parsed form is kept. Which revision is current is read fresh every time,
   *  so an unpublish takes effect at once on every replica. */
  const liveCache = new Map<string, LiveBrandPage>();
  const indexed = (revision: BrandPageRevision): LiveBrandPage => ({ revision, files: new Map(revision.manifest.files.map(file => [file.path, file])) });
  const loadLive = async (slug: string, n: number): Promise<LiveBrandPage | null> => {
    const key = `${slug}:${n}`;
    const hit = liveCache.get(key);
    if (hit) { liveCache.delete(key); liveCache.set(key, hit); return hit; }
    const revision = await d.store.getBrandPageRevision(slug, n);
    if (!revision) return null;
    const loaded = indexed(revision);
    liveCache.set(key, loaded);
    if (liveCache.size > 16) liveCache.delete(liveCache.keys().next().value as string);
    return loaded;
  };

  /** A file's bytes, proved against the digest the manifest lists. */
  const readFile = async (revision: BrandPageRevisionSummary, file: BrandPageFile): Promise<Buffer | null> => {
    const stored = await d.blobs.get(blobId(revision.slug, revision.n, file.sha256));
    if (!stored) return null;
    const bytes = await readBlobBody(stored.body, Math.max(file.size, 1));
    return createHash('sha256').update(bytes).digest('hex') === file.sha256 ? bytes : null;
  };

  /** Removes a revision's files. Its history row and digests stay. */
  const removeBytes = async (slug: string, n: number): Promise<void> => {
    const revision = await d.store.getBrandPageRevision(slug, n);
    if (!revision || revision.bytesRemovedAt) return;
    for (const sha256 of new Set(revision.manifest.files.map(file => file.sha256))) await d.blobs.delete(blobId(slug, n, sha256));
    await d.store.markBrandPageBytesRemoved(slug, n, new Date().toISOString());
  };

  /** Keep `keepRevisions` revisions' bytes for a page, and clear up after a publish that died part way. */
  const trim = async (slug: string): Promise<void> => {
    const rows = await d.store.listBrandPageRevisions(slug, HISTORY_LIMIT);
    const now = Date.now();
    for (const row of rows) {
      if (row.state === 'staged' && !row.bytesRemovedAt && now - Date.parse(row.createdAt) > STAGED_GRACE_MS) {
        await d.store.setBrandPageRevisionState(slug, row.n, ['staged'], 'failed');
        await removeBytes(slug, row.n);
      }
    }
    const kept = rows.filter(row => row.state === 'live' || row.state === 'pending').length;
    const older = rows.filter(row => !row.bytesRemovedAt && ['superseded', 'unpublished', 'rejected', 'withdrawn', 'failed'].includes(row.state));
    for (const row of older.slice(Math.max(0, cfg().keepRevisions - kept))) await removeBytes(slug, row.n);
  };

  const nameOf = async (id: string, names: Map<string, string | null>): Promise<string | null> => {
    if (!names.has(id)) {
      const user = id.startsWith('svc_') ? null : await d.store.getUser(id);
      names.set(id, user ? ([user.firstname, user.lastname].filter(Boolean).join(' ') || user.email) : null);
    }
    return names.get(id) ?? null;
  };
  const revisionWire = async (row: BrandPageRevisionSummary, names: Map<string, string | null>) => ({
    n: row.n, name: row.name, digest: row.digest, state: row.state, size: row.size, fileCount: row.fileCount,
    publishedBy: row.publishedBy, publishedByName: await nameOf(row.publishedBy, names),
    approvalId: row.approvalId, createdAt: row.createdAt, liveAt: row.liveAt, bytesRemovedAt: row.bytesRemovedAt,
    ...(!row.bytesRemovedAt && !['staged', 'failed'].includes(row.state) ? { preview: previewPath(row.slug, row.n) } : {}),
  });
  const pageWire = async (record: BrandPageRecord, rows: BrandPageRevisionSummary[], names: Map<string, string | null>) => {
    const latest = rows[0];
    const pending = rows.find(row => row.state === 'pending');
    const live = rows.find(row => row.n === record.current);
    let logo: string | null = null;
    const shown = live ?? pending;
    if (shown && !shown.bytesRemovedAt) {
      const manifest = (await d.store.getBrandPageRevision(record.slug, shown.n))?.manifest;
      const logos = manifest?.files.filter(file => file.role === 'logo' && /\.(?:svg|png|jpe?g|webp)$/.test(file.path)) ?? [];
      const picked = logos.find(file => file.path === 'logos/primary.svg') ?? logos[0];
      if (picked) logo = `${previewPath(record.slug, shown.n)}${picked.path}`;
    }
    return {
      slug: record.slug, name: record.name, url: pageUrl(record.slug),
      state: record.current !== null ? 'live' : record.unpublishedAt ? 'unpublished' : pending ? 'pending' : 'none',
      current: record.current, pending: pending?.n ?? null, unpublishedAt: record.unpublishedAt, unpublishedBy: record.unpublishedBy,
      unpublishedByName: record.unpublishedBy ? await nameOf(record.unpublishedBy, names) : null,
      createdAt: record.createdAt, updatedAt: record.updatedAt, logo,
      ...(live ?? latest ? { revision: await revisionWire((live ?? latest)!, names) } : {}),
    };
  };
  const answerPage = async (res: ServerResponse, status: number, slug: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const record = await d.store.getBrandPage(slug);
    if (!record) return sendError(res, 404, 'NOT_FOUND', 'no such brand page');
    const rows = await d.store.listBrandPageRevisions(slug, HISTORY_LIMIT);
    sendJson(res, status, { page: await pageWire(record, rows, new Map()), ...extra }, { 'cache-control': 'no-store', ...headers });
  };

  const publish = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const policy = cfg();
    if (!policy.enabled) return off(res);
    const user = await d.requireAction(req, res, BRAND_PAGE_ACTION);
    if (!user) return;
    const body = await readJson(req, 4096) as { uploadId?: unknown; checksum?: unknown } | null;
    if (!body || typeof body.uploadId !== 'string' || typeof body.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(body.checksum)) {
      return sendError(res, 400, 'INVALID_INPUT', 'Publishing needs uploadId and checksum, from one finished upload in the brand-page scope.');
    }
    const upload = await d.store.getUpload(body.uploadId);
    if (!upload || upload.scope !== 'brand-page' || upload.owner !== uploadOwner(user)) return sendError(res, 404, 'NOT_FOUND', 'no such upload');
    if (!upload.ready || !liveUpload(upload)) return sendError(res, 409, 'UPLOAD_NOT_READY', 'Finish sending the bundle first.');
    if (upload.checksum !== body.checksum) return sendError(res, 409, 'UPLOAD_CHANGED', 'That upload holds a different bundle.');
    if (upload.size > policy.maxBundleBytes) return sendError(res, 413, 'BUNDLE_TOO_LARGE', `A bundle can be at most ${policy.maxBundleBytes} bytes.`);

    let bundle: Awaited<ReturnType<typeof readBundle>>;
    try {
      const bytes = await readTransfer(uploadParts(d.blobs, upload), policy.maxBundleBytes);
      bundle = await readBundle(bytes, policy);
    } catch (error) {
      if (error instanceof BrandPageRefusal) return sendError(res, error.status, error.code, error.message);
      return sendError(res, 422, 'SOURCE_UNAVAILABLE', 'The upload could not be read; nothing was published.');
    }
    const { manifest, files, size } = bundle;
    const slug = manifest.id;
    const rows = await d.store.listBrandPageRevisions(slug, HISTORY_LIMIT);
    const record = await d.store.getBrandPage(slug);
    const live = rows.find(row => row.n === record?.current);
    if (live?.digest === manifest.digest) {
      await removeUpload(d.store, d.blobs, upload).catch(() => false);
      return answerPage(res, 200, slug, { unchanged: true });
    }
    if (rows.some(row => row.state === 'pending')) return sendError(res, 409, 'BRAND_PAGE_PENDING', 'A revision of this page is waiting for approval. Withdraw that request first.');
    const chain = policy.approvalChain ? await d.store.getChain(policy.approvalChain) : null;
    if (policy.approvalChain && !chain) return sendError(res, 409, 'CHAIN_NOT_FOUND', 'The approval chain this instance names for brand pages does not exist. Nothing was published.');
    if (chain && user.id.startsWith('svc_')) return sendError(res, 403, 'HUMAN_APPROVAL_REQUIRED', 'On this instance a brand page goes through an approval chain, and a person has to ask for that.');
    if (await d.store.brandPageBytesHeld() + size > policy.instanceBudgetBytes) return sendError(res, 413, 'BRAND_PAGE_BUDGET', 'This instance has no room for this page. Remove older revisions first.');

    const at = new Date().toISOString();
    const revision = await d.store.stageBrandPageRevision({ slug, name: manifest.name, digest: manifest.digest, manifest, size, fileCount: manifest.files.length, publishedBy: user.id, at });
    try {
      const stored = new Set<string>();
      for (const file of manifest.files) {
        if (stored.has(file.sha256)) continue;
        stored.add(file.sha256);
        await d.blobs.put(blobId(slug, revision.n, file.sha256), files.get(file.path)!, 'application/octet-stream', { size: file.size, sha256: file.sha256 });
      }
    } catch (error) {
      console.error(`[brand-pages] could not store ${slug} revision ${revision.n}: ${(error as Error).message}`);
      await d.store.setBrandPageRevisionState(slug, revision.n, ['staged'], 'failed');
      await removeBytes(slug, revision.n).catch(() => {});
      return sendError(res, 502, 'BRAND_PAGE_STORE_FAILED', 'The files could not be stored; nothing was published.');
    }
    const facts = { revision: revision.n, digest: manifest.digest, files: manifest.files.length, size };
    if (chain) {
      const approvalId = `apr_${randomId(8)}`;
      const title = `Publish the brand page ${manifest.name}`;
      const approval: Approval = {
        ...createApproval({ id: approvalId, subjectType: 'brand-page', subjectRef: `brand-page:${slug}:${revision.n}:${manifest.digest}`, title, chain, nominees: [], createdBy: user.id, now: at }),
        brandPage: { slug, revision: revision.n, digest: manifest.digest, name: manifest.name, files: manifest.files.length, size, held: manifest.held.length },
      };
      await d.store.putApproval(approval);
      await d.store.setBrandPageRevisionState(slug, revision.n, ['staged'], 'pending', { approvalId });
      await d.audit(actorOf(user), 'brand.page.submit', `brand-page:${slug}`, { ...facts, approvalId });
      await d.audit(actorOf(user), 'approval.submit', `approval:${approvalId}`, { chainId: chain.id, subjectType: 'brand-page', slug });
      const step = currentStep(approval);
      if (step) {
        const line = `${user.email} asked for review on the “${step.name}” step.`;
        await d.store.putMessage({
          id: `msg_${randomId(8)}`, kind: 'approval', severity: 'action', audience: { groups: step.approvers.groups },
          title: `Approval requested: ${title}`, body: line, cta: { label: 'Review', url: '/admin#/approvals' }, dismissible: true,
        });
        const reviewers = (await d.store.listUsers()).filter(candidate => !candidate.disabledAt && candidate.id !== user.id && isEligible(step, candidate.groups));
        d.notifier.email(reviewers.map(candidate => candidate.email), `Approval requested: ${title}`, `${line}\n\nReview it: ${origin}/admin#/approvals`);
      }
      d.notifier.event('approval.requested', { id: approvalId, title, chainId: chain.id, by: user.email });
      await removeUpload(d.store, d.blobs, upload).catch(() => false);
      return answerPage(res, 202, slug, { approvalId });
    }
    await d.store.promoteBrandPageRevision(slug, revision.n, ['staged'], at);
    await d.audit(actorOf(user), 'brand.page.publish', `brand-page:${slug}`, facts);
    await removeUpload(d.store, d.blobs, upload).catch(() => false);
    await trim(slug).catch(error => console.error(`[brand-pages] could not trim ${slug}: ${(error as Error).message}`));
    return answerPage(res, 201, slug, {}, { location: `/api/v1/brand-pages/${slug}/revisions` });
  };

  /** Settles the one revision an approval names. Rejecting or withdrawing removes
   *  its files, because nobody will decide on them again. */
  const settleApproval = async (approval: Approval, actorId: string): Promise<boolean> => {
    if (approval.subjectType !== 'brand-page' || !approval.brandPage) return false;
    const { slug, revision: n, digest, name } = approval.brandPage;
    const row = await d.store.getBrandPageRevision(slug, n);
    if (!row || row.approvalId !== approval.id || row.digest !== digest || row.state !== 'pending') return true;
    const actor = `user:${actorId}`, facts = { revision: n, digest, approvalId: approval.id };
    const approved = approval.state === 'approved';
    if (approved) {
      await d.store.promoteBrandPageRevision(slug, n, ['pending'], new Date().toISOString());
      await d.audit(actor, 'brand.page.publish', `brand-page:${slug}`, facts);
      await trim(slug).catch(error => console.error(`[brand-pages] could not trim ${slug}: ${(error as Error).message}`));
    } else {
      const state = approval.state === 'withdrawn' ? 'withdrawn' : 'rejected';
      await d.store.setBrandPageRevisionState(slug, n, ['pending'], state);
      await removeBytes(slug, n).catch(error => console.error(`[brand-pages] could not remove ${slug} revision ${n}: ${(error as Error).message}`));
      await d.audit(actor, `brand.page.${state}`, `brand-page:${slug}`, facts);
    }
    await d.store.putMessage({
      id: `msg_${randomId(8)}`, kind: 'approval', severity: approved ? 'info' : 'action', audience: { users: [approval.createdBy] },
      title: approved ? `Brand page published: ${name}` : `Brand page not published: ${name}`,
      body: approved ? 'The page is live at its public address.' : `The request was ${approval.state}, and its files are gone.`,
      cta: { label: 'View', url: '/admin#/instance?tab=brand-pages' }, data: { kind: 'brand-page', slug, revision: String(n), approvalId: approval.id, state: approval.state }, dismissible: true,
    });
    d.notifier.event('approval.decided', { id: approval.id, title: approval.title, state: approval.state });
    return true;
  };

  const headersFor = (path: string, visibility: 'public' | 'preview'): Record<string, string> => ({
    ...(path === 'index.html'
      ? { 'content-security-policy': BRAND_PAGE_HTML_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
      : { ...INERT_BYTE_HEADERS }),
    ...(path.endsWith('.pdf') ? { 'content-disposition': 'attachment' } : {}),
    // Anyone may use a published page's files, and the answer carries no credential.
    // The page itself needs neither of these, so it does not get them.
    ...(visibility === 'public' && path !== 'index.html' ? { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } : {}),
  });

  const sendFile = async (req: IncomingMessage, res: ServerResponse, page: LiveBrandPage, rel: string, visibility: 'public' | 'preview'): Promise<void> => {
    const { revision, files } = page;
    const path = rel || 'index.html';
    if (path === 'brand.json') {
      const manifest = { ...revision.manifest, ...(revision.liveAt ? { publishedAt: revision.liveAt } : {}) };
      return sendBytes(req, res, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), { contentType: 'application/json', headers: headersFor(path, visibility) });
    }
    const file = files.get(path);
    if (!file) return sendError(res, 404, 'NOT_FOUND', 'This brand page has no such file.');
    const bytes = await readFile(revision, file);
    if (!bytes) return sendError(res, 503, 'BRAND_PAGE_FILE_UNAVAILABLE', 'This file could not be read and checked.');
    sendBytes(req, res, bytes, { contentType: servedType(path), sha256: file.sha256, headers: headersFor(path, visibility) });
  };
  /** Relative links in a page only work from a folder address. */
  const redirectToFolder = (res: ServerResponse, ctx: RouteCtx): void => {
    res.writeHead(308, { location: `${ctx.url.pathname}/` });
    res.end();
  };

  const liveIndex = async () => {
    const live = await d.store.listLiveBrandPageRevisions(INDEX_LIMIT + 1);
    return {
      convention: 'lolly-brand-pages', version: 1, note: BRAND_PAGE_INDEX_NOTE,
      pages: live.slice(0, INDEX_LIMIT).map(row => ({
        id: row.slug, name: row.name, url: pageUrl(row.slug), manifest: `${pageUrl(row.slug)}brand.json`, llms: `${pageUrl(row.slug)}llms.txt`, mcp: `${pageUrl(row.slug)}mcp`,
        revision: row.n, digest: row.digest, publishedAt: row.liveAt,
      })),
      truncated: live.length > INDEX_LIMIT,
    };
  };
  const sendIndex = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!cfg().enabled) return off(res);
    res.setHeader('access-control-allow-origin', '*');
    sendBytes(req, res, Buffer.from(JSON.stringify(await liveIndex())), { contentType: 'application/json; charset=utf-8', headers: { 'x-content-type-options': 'nosniff' } });
  };

  /** Registered after the routes it would otherwise shadow and before the shell's
   *  fallback. `shell` is that fallback's file answer, when a shell is mounted. */
  const register = (router: ReturnType<typeof createRouter>, opts: { shell?: ((req: IncomingMessage, res: ServerResponse, rel: string) => Promise<void>) | null } = {}): void => {
    const notOurs = async (req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> => {
      // The same path the shell's own fallback route hands over.
      if (opts.shell) return opts.shell(req, res, ctx.url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/'));
      sendError(res, 404, 'NOT_FOUND', `no route for ${req.method} ${ctx.url.pathname}`);
    };
    const liveOf = async (slug: string): Promise<LiveBrandPage | { missing: 404 | 410 }> => {
      const record = isBrandPageSlug(slug) ? await d.store.getBrandPage(slug) : null;
      if (record?.current === null && record.unpublishedAt) return { missing: 410 };
      return (record && record.current !== null ? await loadLive(slug, record.current) : null) ?? { missing: 404 };
    };
    const serve = async (req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> => {
      const slug = ctx.params.slug;
      if (!cfg().enabled || !isBrandPageSlug(slug)) return notOurs(req, res, ctx);
      const page = await liveOf(slug);
      if ('missing' in page) return sendMissing(res, page.missing);
      const rel = ctx.params['*'] ?? '';
      if (!rel && !ctx.url.pathname.endsWith('/')) return redirectToFolder(res, ctx);
      await sendFile(req, res, page, rel, 'public');
    };

    // The MCP routes first, because `*` would also match their path.
    registerBrandPageMcp(router, {
      origin, enabled: () => cfg().enabled, live: liveOf, readFile, pageUrl, notOurs,
    });
    for (const method of ['GET', 'HEAD']) {
      router.add(method, '/brand/:slug/*', serve, { delivery: 'public-revalidate' });
      router.add(method, BRAND_PAGE_INDEX_PATH, sendIndex, { delivery: 'public-revalidate' });
      router.add(method, BRAND_PAGE_PUBLIC_API, sendIndex, { delivery: 'public-revalidate' });
    }

    router.add('POST', '/api/v1/brand-pages', publish);
    router.add('GET', '/api/v1/brand-pages', async (req, res) => {
      if (!cfg().enabled) return off(res);
      if (!(await d.requireAction(req, res, BRAND_PAGE_ACTION))) return;
      const policy = cfg(), names = new Map<string, string | null>();
      const pages = await d.store.listBrandPages(INDEX_LIMIT);
      const rows = await Promise.all(pages.map(async record => pageWire(record, await d.store.listBrandPageRevisions(record.slug, HISTORY_LIMIT), names)));
      sendJson(res, 200, {
        pages: rows, publicIndex: BRAND_PAGE_PUBLIC_API,
        limits: { maxBundleBytes: policy.maxBundleBytes, maxFileBytes: policy.maxFileBytes, instanceBudgetBytes: policy.instanceBudgetBytes, usedBytes: await d.store.brandPageBytesHeld(), keepRevisions: policy.keepRevisions },
        approvalChain: policy.approvalChain ?? null,
      }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });
    router.add('GET', '/api/v1/brand-pages/:slug/revisions', async (req, res, ctx) => {
      if (!cfg().enabled) return off(res);
      if (!(await d.requireAction(req, res, BRAND_PAGE_ACTION))) return;
      const slug = ctx.params.slug!;
      const record = isBrandPageSlug(slug) ? await d.store.getBrandPage(slug) : null;
      if (!record) return sendError(res, 404, 'NOT_FOUND', 'no such brand page');
      const rows = await d.store.listBrandPageRevisions(slug, HISTORY_LIMIT), names = new Map<string, string | null>();
      sendJson(res, 200, { page: await pageWire(record, rows, names), revisions: await Promise.all(rows.map(row => revisionWire(row, names))) }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    const revisionFor = async (res: ServerResponse, ctx: RouteCtx): Promise<BrandPageRevision | null> => {
      const n = Number(ctx.params.n), slug = ctx.params.slug;
      const revision = isBrandPageSlug(slug) && Number.isSafeInteger(n) && n > 0 ? await d.store.getBrandPageRevision(slug, n) : null;
      if (!revision) sendError(res, 404, 'NOT_FOUND', 'no such revision');
      return revision;
    };
    /** Someone who may publish, or a reviewer whose chain holds this revision. Anyone
     *  else learns nothing about a revision that may not be public. */
    const mayReview = async (req: IncomingMessage, res: ServerResponse, revision: BrandPageRevision): Promise<boolean> => {
      const user = (await d.memberOf(req)) ?? (await d.serviceAccountOf(req));
      if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return false; }
      const subject = { userId: user.id, groups: user.groups, role: user.role as Role };
      const grants = await d.store.listGrants();
      if (evaluate(subject, BRAND_PAGE_ACTION, ['*'], grants)) return true;
      const approval = revision.approvalId ? await d.store.getApproval(revision.approvalId) : null;
      if (approval && evaluate(subject, 'approval.act', [`approval:${approval.id}`, `chain:${approval.chainId}`, approval.subjectRef, '*'], grants)) return true;
      sendError(res, 404, 'NOT_FOUND', 'no such revision');
      return false;
    };
    router.add('GET', '/api/v1/brand-pages/:slug/revisions/:n', async (req, res, ctx) => {
      if (!cfg().enabled) return off(res);
      const revision = await revisionFor(res, ctx);
      if (!revision || !(await mayReview(req, res, revision))) return;
      const { manifest, ...summary } = revision;
      sendJson(res, 200, { revision: await revisionWire(summary, new Map()), held: manifest.held, checks: manifest.checks, usage: manifest.usage ?? null, colourways: manifest.colourways, files: manifest.files }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });
    router.add('GET', '/api/v1/brand-pages/:slug/revisions/:n/preview/*', async (req, res, ctx) => {
      if (!cfg().enabled) return off(res);
      const revision = await revisionFor(res, ctx);
      if (!revision || !(await mayReview(req, res, revision))) return;
      if (revision.bytesRemovedAt || revision.state === 'failed' || revision.state === 'staged') return sendError(res, 410, 'BRAND_PAGE_FILES_REMOVED', 'This revision no longer holds its files.');
      const rel = ctx.params['*'] ?? '';
      if (!rel && !ctx.url.pathname.endsWith('/')) return redirectToFolder(res, ctx);
      await sendFile(req, res, indexed(revision), rel, 'preview');
    }, { delivery: 'person-private' });

    router.add('POST', '/api/v1/brand-pages/:slug/unpublish', async (req, res, ctx) => {
      if (!cfg().enabled) return off(res);
      const user = await d.requireAction(req, res, BRAND_PAGE_ACTION);
      if (!user) return;
      const slug = ctx.params.slug!;
      const record = isBrandPageSlug(slug) ? await d.store.getBrandPage(slug) : null;
      if (!record) return sendError(res, 404, 'NOT_FOUND', 'no such brand page');
      const body = await readJson(req, 4096) as { removeFiles?: unknown } | null;
      if (body?.removeFiles !== undefined && typeof body.removeFiles !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'removeFiles must be true or false.');
      const at = new Date().toISOString();
      const was = record.current;
      await d.store.unpublishBrandPage(slug, user.id, at);
      let removed = 0;
      if (body?.removeFiles === true) {
        for (const row of await d.store.listBrandPageRevisions(slug, HISTORY_LIMIT)) {
          if (row.bytesRemovedAt || row.state === 'pending') continue;
          await removeBytes(slug, row.n);
          removed++;
        }
      }
      await d.audit(actorOf(user), 'brand.page.unpublish', `brand-page:${slug}`, { revision: was, removedRevisions: removed });
      return answerPage(res, 200, slug, { changed: was !== null, removedRevisions: removed });
    });
  };

  return { register, settleApproval };
}
