// SPDX-License-Identifier: MPL-2.0
/**
 * /compat/: the routes someone moving off a hosted render API points their base URL
 * at. A thin layer: vendor shapes in and out, durable renders in the middle, so the
 * tool's policy, grants, validation and audit apply as they do on /api/v1/renders.
 * Off by default, and every route then answers 404.
 *
 * Built from each vendor's public documentation and recorded fixtures. None of it has
 * been run against a live account, and the docs say so.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { INERT_BYTE_HEADERS } from '../api/file-delivery.ts';
import { readJson, sendError, sendJson, setDeliveryClass, type createRouter, type Handler, type RouteCtx } from '../api/router.ts';
import type { CallbackOutboxOptions } from '../automation/callback-outbox.ts';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import type { Secrets } from '../config/instance.ts';
import { canonicalJson, randomId, sha256Hex } from '../lib/crypto.ts';
import { defaultRenderCallbackBody } from '../renders/callback-body.ts';
import { parseRenderSpec } from '../renders/request.ts';
import { RenderResourceError, type RenderRecord, type RenderSpec, type RenderStore } from '../renders/types.ts';
import { mapBannerbearV2, mapBannerbearV5, mapPlacid, mapPlacidUrl, type MappedRequest } from './mappers.ts';
import { mappingIndex, parseRenderApiMappings } from './mapping.ts';
import { fileName, formatOfFile, placidUrlSignatureValid, resultUrlSigner, type ResultUrlSigner } from './signing.ts';
import { RenderApiRefusal, type RenderApiConfig, type RenderApiMapping, type RenderApiRecord, type RenderApiSource, type RenderApiStore } from './types.ts';
import { aggregate, wireFor, type RenderView } from './wire.ts';

/** Bannerbear documents a 10 second limit on its synchronous host. */
const SYNC_LIMIT_MS = 10_000;
/** Placid documents 10 simultaneous `create_now` requests. */
const MAX_WAITERS = 10;
const WAIT_STEP_MS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_URL_QUERY = 8192;
/** A record whose renders never appeared after this long lost its submitter. */
const INCOMPLETE_AFTER_MS = 300_000;
/** The URL API keeps its rows under this prefix, so a token cannot put another image behind a public URL. */
const URL_API_KEY_PREFIX = 'placid-url:';
/** How long a failed URL render stands before a later request tries again. */
const URL_RETRY_WINDOW_MS = 60_000;
/** Renders one request may step past. A pointer row moves with them, so the next request starts further on. */
const MAX_URL_GENERATIONS = 16;
const DOCS = '/info/work-move-from-render-api.html';

type ViewStore = RenderApiStore & Pick<RenderStore, 'getRender' | 'renderCallbackSummary'>;

export interface PreparedRenderApi {
  mappings: RenderApiMapping[];
  signer: ResultUrlSigner | null;
  /** The body of a webhook for a render this API started, in the vendor's shape. */
  callbackBody: NonNullable<CallbackOutboxOptions['renderBody']>;
}

function selfUrl(baseUrl: string, record: RenderApiRecord): string {
  switch (record.source) {
    case 'bannerbear-v5': return `${baseUrl}/compat/bannerbear/v5/images/${record.id}`;
    case 'bannerbear-v2': return `${baseUrl}/compat/bannerbear/v2/images/${record.id}`;
    default: return `${baseUrl}/compat/placid/api/rest/images/${record.seq}`;
  }
}

async function loadView(store: ViewStore, baseUrl: string, signer: ResultUrlSigner | null, record: RenderApiRecord, known?: RenderRecord): Promise<RenderView> {
  const renders: RenderView['renders'] = {};
  for (const format of record.formats) {
    const id = record.renders[format];
    if (known && known.request.format === format) renders[format] = known;
    else renders[format] = id ? await store.getRender(id, record.principal) : null;
  }
  const missing = record.formats.some((format) => !renders[format]);
  const view: RenderView = {
    record, renders, self: selfUrl(baseUrl, record),
    fileUrl: (format, render) => signer
      ? signer.url(baseUrl, record.id, format, render.finishedAt ?? render.updatedAt, record.filename)
      : `${baseUrl}/compat/files/${encodeURIComponent(record.id)}/${encodeURIComponent(fileName(record.filename, format))}`,
  };
  // A submitter that stopped partway leaves a format with no render. Say so rather than poll forever.
  if (missing && Date.now() - Date.parse(record.createdAt) > INCOMPLETE_AFTER_MS) {
    for (const format of record.formats) {
      renders[format] ??= { id: '', state: 'failed', error: { code: 'RENDER_API_INCOMPLETE', message: 'this request was not fully submitted' } } as RenderRecord;
    }
  }
  return view;
}

/** Reads the config, the mapping file and the secrets, and refuses a bad setup at boot. */
export function prepareRenderApi(config: RenderApiConfig, secrets: Pick<Secrets, 'renderApiUrls'>, store: ViewStore, baseUrl: string, env: NodeJS.ProcessEnv = process.env): PreparedRenderApi {
  let mappings = config.templates;
  if (config.enabled && config.mappingsFile) {
    const parsed = JSON.parse(readFileSync(config.mappingsFile, 'utf8')) as unknown;
    const listed = Array.isArray(parsed) ? parsed : (parsed as { templates?: unknown })?.templates;
    mappings = parseRenderApiMappings([...config.templates, ...(Array.isArray(listed) ? listed : [{}])], config.mappingsFile);
  }
  if (config.enabled && config.resultUrls.signedDays > 0 && !secrets.renderApiUrls) {
    throw new Error('renderApi.resultUrls.signedDays needs LW_RENDER_API_URL_SECRET. Set the secret, or set signedDays to 0 for result URLs that need the bearer token');
  }
  if (config.enabled) {
    for (const mapping of mappings) {
      const ref = mapping.url?.credentialRef;
      if (ref && !env[ref]) throw new Error(`renderApi: ${mapping.template} names ${ref} for URL signatures, and that environment variable is not set`);
    }
  }
  const signer = config.resultUrls.signedDays > 0 && secrets.renderApiUrls ? resultUrlSigner(secrets.renderApiUrls, config.resultUrls.signedDays) : null;
  return {
    mappings, signer,
    callbackBody: async (subject, context) => {
      const compat = subject.kind === 'render' ? subject.render.request.compat : undefined;
      if (subject.kind !== 'render' || !compat) return defaultRenderCallbackBody(subject, context);
      const record = await store.getRenderApiRecord(compat.requestId);
      if (!record) return { lolly: { deliveryId: context.deliveryId, deleted: true } };
      const view = await loadView(store, baseUrl, signer, record, subject.render);
      view.deliveryId = context.deliveryId;
      view.webhookResponseCode = (await store.renderCallbackSummary(subject.render.id))?.lastStatus ?? null;
      return wireFor(view);
    },
  };
}

export interface RenderApiDeps {
  prepared: PreparedRenderApi;
  config: RenderApiConfig;
  baseUrl: string;
  store: ViewStore & Pick<RenderStore, 'cancelRender'>;
  blobs: BlobStore;
  /** The principal of a live service token on this request. A person's session is not one. */
  tokenPrincipal(req: IncomingMessage): Promise<string | null>;
  /** A person or token allowed to delete any record, such as after a token is revoked. */
  adminMay(req: IncomingMessage): Promise<boolean>;
  /** The durable render path: authorize, validate, insert, audit, then kick the runner.
   *  `prepaid` says the renders were already counted against the token's budget. */
  submit(principal: string, request: RenderSpec, key?: string, retryOf?: string, options?: { prepaid?: boolean }): Promise<{ record: RenderRecord; reused: boolean }>;
  /** Count a request's renders together against the token's budget (plans/82 M7),
   *  so one in several formats is refused whole. Absent counts each render alone. */
  chargeRenders?(principal: string, n: number): Promise<(() => Promise<void>) | undefined>;
  authorize(principal: string, request: RenderSpec): Promise<void>;
  validate(principal: string, request: RenderSpec): Promise<void>;
  callbackAllowed(url: string): boolean;
  /** Locked, hidden or not-allowed inputs, with the codes the render route uses. */
  policyProblems(principal: string, toolId: string, inputs: Record<string, unknown>, format: string): Promise<Array<{ path: string; message: string; code: string }>>;
  cancel?(id: string): void;
  audit(principal: string, action: string, subject: string, facts: Record<string, unknown>): Promise<void>;
  /** Changes when the brand or catalog changes, so a URL API result is made again. */
  renderEpoch(): Promise<string>;
  env?: NodeJS.ProcessEnv;
  now?(): number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export function registerRenderApi(router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: RenderApiDeps): void {
  const { store, prepared, baseUrl } = deps;
  const lookup = mappingIndex(prepared.mappings);
  const env = deps.env ?? process.env;
  let waiters = 0;

  const add = (method: string, path: string, handler: Handler, options?: Parameters<ReturnType<typeof createRouter>['add']>[3]): void => {
    router.add(method, path, async (req, res, ctx) => {
      if (!deps.config.enabled) return sendError(res, 404, 'NOT_FOUND', 'this route is not available');
      try {
        await handler(req, res, ctx);
      } catch (error) {
        if (error instanceof RenderApiRefusal) return sendError(res, error.status, error.code, error.message, error.detail);
        if (error instanceof RenderResourceError) {
          if (error.retryAfterSec !== undefined) res.setHeader('retry-after', String(error.retryAfterSec));
          return sendError(res, error.status, error.code, error.message, error.detail);
        }
        throw error;
      }
    }, options);
  };
  const needToken = async (req: IncomingMessage): Promise<string> => {
    const principal = await deps.tokenPrincipal(req);
    if (!principal) throw new RenderApiRefusal('UNAUTHORIZED', 401, 'send a service token as Authorization: Bearer lwt_...');
    return principal;
  };
  const view = (record: RenderApiRecord): Promise<RenderView> => loadView(store, baseUrl, prepared.signer, record);

  /** Waits for every render of a record to finish, up to the limit. */
  const settled = async (record: RenderApiRecord, limitMs: number): Promise<RenderView> => {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const current = await view(record);
      if (aggregate(current) !== 'pending' || Date.now() >= deadline) return current;
      await delay(WAIT_STEP_MS);
    }
  };

  const remove = async (record: RenderApiRecord): Promise<void> => {
    for (const id of Object.values(record.renders)) {
      const cancelled = await store.cancelRender(id, record.principal);
      if (cancelled?.state === 'cancelled') deps.cancel?.(id);
    }
    await store.deleteRenderApiRecord(record.id, record.principal);
  };

  /** The checks and renders behind one vendor request. */
  const start = async (principal: string, source: RenderApiSource, mapped: MappedRequest, key: string | undefined): Promise<{ record: RenderApiRecord; reused: boolean }> => {
    const { mapping } = mapped;
    if (mapped.webhookUrl && !deps.callbackAllowed(mapped.webhookUrl)) throw new RenderApiRefusal('CALLBACK_URL_NOT_ALLOWED', 403, 'this instance does not send webhooks to that URL');
    const plans = mapped.formats.map((format) => parseRenderSpec({
      toolId: mapping.toolId, format, inputs: mapped.inputs, priority: mapped.immediate ? 9 : 0,
      ...(mapped.webhookUrl ? { callbackUrl: mapped.webhookUrl } : {}),
    }));
    for (const plan of plans) {
      await deps.authorize(principal, plan);
      const problems = await deps.policyProblems(principal, mapping.toolId, mapped.inputs, plan.format);
      if (problems.length) throw new RenderApiRefusal(problems[0]!.code, 422, problems.map((problem) => `${problem.path.replace(/^\//, '')} ${problem.message}`).join('; '), { problems });
      await deps.validate(principal, plan);
    }
    const inserted = await store.insertRenderApiRecord({
      id: randomId(12), source, template: mapping.template, principal, formats: mapped.formats, renders: {},
      metadata: mapped.metadata ?? null, echo: mapped.echo, createdAt: new Date().toISOString(),
      ...(mapped.webhookUrl ? { webhookUrl: mapped.webhookUrl } : {}), ...(mapped.filename ? { filename: mapped.filename } : {}),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
    if (inserted.reused) return inserted;
    const { record } = inserted;
    let giveBack: (() => Promise<void>) | undefined;
    try {
      giveBack = await deps.chargeRenders?.(principal, plans.length);
      for (const plan of plans) {
        const { record: render } = await deps.submit(principal, { ...plan, compat: { source, requestId: record.id } }, undefined, undefined, { prepaid: !!deps.chargeRenders });
        record.renders[plan.format] = render.id;
        await store.setRenderApiRenders(record.id, record.renders);
      }
    } catch (error) {
      // The request was refused as a whole, so none of its renders count.
      await giveBack?.().catch(() => {});
      await remove(record).catch(() => {});
      throw error;
    }
    await deps.audit(principal, 'render-api.create', `render-api:${record.id}`, { source, template: mapping.template, toolId: mapping.toolId, formats: mapped.formats });
    return { record, reused: false };
  };

  const keyOf = (req: IncomingMessage): string | undefined => {
    const key = req.headers['idempotency-key'];
    if (Array.isArray(key)) throw new RenderApiRefusal('INVALID_INPUT', 400, 'one Idempotency-Key required');
    if (key !== undefined && (!key.trim() || key.length > 200)) throw new RenderApiRefusal('INVALID_INPUT', 400, 'Idempotency-Key must be 1 to 200 characters');
    if (key?.startsWith(URL_API_KEY_PREFIX)) throw new RenderApiRefusal('INVALID_INPUT', 400, `Idempotency-Key must not start with ${URL_API_KEY_PREFIX}`);
    return key;
  };

  /** Runs a request that should wait, within the documented limit on waiting requests. */
  const waiting = async <T>(run: () => Promise<T>): Promise<T> => {
    if (waiters >= MAX_WAITERS) throw new RenderApiRefusal('TOO_MANY_WAITING', 429, `at most ${MAX_WAITERS} requests may wait at once`);
    waiters += 1;
    try { return await run(); } finally { waiters -= 1; }
  };

  const bannerbearCreate = (source: 'bannerbear-v5' | 'bannerbear-v2', sync: boolean): Handler => async (req, res) => {
    const principal = await needToken(req);
    const key = keyOf(req);
    const body = await readJson(req, MAX_BODY_BYTES);
    const mapped = source === 'bannerbear-v5' ? mapBannerbearV5(body, lookup, sync) : mapBannerbearV2(body, lookup, sync);
    if (!sync) {
      const { record } = await start(principal, source, mapped, key);
      return sendJson(res, 202, wireFor(await view(record)));
    }
    await waiting(async () => {
      const { record } = await start(principal, source, mapped, key);
      const current = await settled(record, SYNC_LIMIT_MS);
      // The vendor's sync host answers 408 at its limit. The work carries on, and the record can still be polled.
      if (aggregate(current) === 'pending') return sendJson(res, 408, wireFor(current));
      sendJson(res, 200, wireFor(current));
    });
  };

  const ownedRecord = async (principal: string, id: string, source: RenderApiSource): Promise<RenderApiRecord> => {
    const record = await store.getRenderApiRecord(id);
    if (!record || record.principal !== principal || record.source !== source) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    return record;
  };
  const answerRecord = async (res: ServerResponse, principal: string, record: RenderApiRecord): Promise<void> => {
    const current = await view(record);
    const first = record.formats.map((format) => current.renders[format]).find((render) => render?.request);
    if (first?.request) await deps.authorize(principal, first.request);
    if (record.webhookUrl && first?.id) current.webhookResponseCode = (await store.renderCallbackSummary(first.id))?.lastStatus ?? null;
    sendJson(res, 200, wireFor(current));
  };

  add('POST', '/compat/bannerbear/v5/images', bannerbearCreate('bannerbear-v5', false));
  add('POST', '/compat/bannerbear/sync/v5/images', bannerbearCreate('bannerbear-v5', true));
  add('POST', '/compat/bannerbear/v2/images', bannerbearCreate('bannerbear-v2', false));
  add('POST', '/compat/bannerbear/sync/v2/images', bannerbearCreate('bannerbear-v2', true));
  const TOKEN_ONLY = { delivery: 'person-private' } as const;
  add('GET', '/compat/bannerbear/v5/images', async (req, res, ctx) => {
    const principal = await needToken(req);
    const limit = Number(ctx.url.searchParams.get('limit') ?? 25);
    const page = Number(ctx.url.searchParams.get('page') ?? 1);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(page) || page < 1) throw new RenderApiRefusal('INVALID_INPUT', 400, 'limit must be 1 to 100 and page a positive whole number');
    const records = await store.listRenderApiRecords(principal, 'bannerbear-v5', limit, (page - 1) * limit);
    sendJson(res, 200, await Promise.all(records.map(async (record) => wireFor(await view(record)))));
  }, TOKEN_ONLY);
  add('GET', '/compat/bannerbear/v5/images/:id', async (req, res, ctx) => {
    const principal = await needToken(req);
    await answerRecord(res, principal, await ownedRecord(principal, ctx.params.id!, 'bannerbear-v5'));
  }, TOKEN_ONLY);
  add('GET', '/compat/bannerbear/v2/images/:id', async (req, res, ctx) => {
    const principal = await needToken(req);
    await answerRecord(res, principal, await ownedRecord(principal, ctx.params.id!, 'bannerbear-v2'));
  }, TOKEN_ONLY);
  add('GET', '/compat/bannerbear/v2/auth', async (req, res) => {
    await needToken(req);
    sendJson(res, 200, { message: 'Authorized', project: new URL(baseUrl).host });
  }, TOKEN_ONLY);

  const placidRecord = async (principal: string, id: string): Promise<RenderApiRecord> => {
    const record = /^\d{1,15}$/.test(id) ? await store.getRenderApiRecordBySeq(Number(id)) : null;
    if (!record || record.principal !== principal || record.source !== 'placid' || record.echo.urlApi) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    return record;
  };
  add('POST', '/compat/placid/api/rest/images', async (req, res) => {
    const principal = await needToken(req);
    const key = keyOf(req);
    const mapped = mapPlacid(await readJson(req, MAX_BODY_BYTES), lookup);
    if (!mapped.immediate) {
      const { record } = await start(principal, 'placid', mapped, key);
      return sendJson(res, 200, wireFor(await view(record)));
    }
    await waiting(async () => {
      const { record } = await start(principal, 'placid', mapped, key);
      // Placid documents no time limit here, so a slow render still answers: queued, with a polling URL.
      sendJson(res, 200, wireFor(await settled(record, SYNC_LIMIT_MS)));
    });
  });
  add('GET', '/compat/placid/api/rest/images/:id', async (req, res, ctx) => {
    const principal = await needToken(req);
    await answerRecord(res, principal, await placidRecord(principal, ctx.params.id!));
  }, TOKEN_ONLY);
  add('DELETE', '/compat/placid/api/rest/images/:id', async (req, res, ctx) => {
    const principal = await needToken(req);
    const record = await placidRecord(principal, ctx.params.id!);
    await remove(record);
    await deps.audit(principal, 'render-api.delete', `render-api:${record.id}`, { source: record.source });
    res.writeHead(204).end();
  });

  /** A render's retained bytes, checked against their receipt. */
  const readOutput = async (render: RenderRecord): Promise<Buffer> => {
    if (render.state !== 'succeeded' || !render.output) throw new RenderApiRefusal('RENDER_NOT_SUCCEEDED', 409, 'this image has no finished output');
    if (render.output.expiredAt) throw new RenderApiRefusal('OUTPUT_EXPIRED', 410, 'output retention has removed this image');
    const blob = await deps.blobs.get(render.output.ref);
    if (!blob) throw new RenderApiRefusal('OUTPUT_UNAVAILABLE', 410, 'this image is no longer stored');
    let bytes: Buffer;
    try { bytes = await readBlobBody(blob.body, render.output.size); }
    catch { throw new RenderApiRefusal('OUTPUT_INTEGRITY', 409, 'this image no longer matches its receipt'); }
    if (bytes.byteLength !== render.output.size || sha256Hex(bytes) !== render.output.sha256) throw new RenderApiRefusal('OUTPUT_INTEGRITY', 409, 'this image no longer matches its receipt');
    return bytes;
  };
  const writeOutput = (res: ServerResponse, render: RenderRecord, name: string, bytes: Buffer): void => {
    res.writeHead(200, { ...INERT_BYTE_HEADERS, 'content-type': render.output!.mime, 'content-length': String(bytes.byteLength),
      etag: `"${render.output!.sha256}"`, 'content-disposition': `inline; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"` });
    res.end(bytes);
  };
  const sendOutput = async (res: ServerResponse, render: RenderRecord, name: string): Promise<void> => {
    writeOutput(res, render, name, await readOutput(render));
  };
  const recordOutput = async (res: ServerResponse, record: RenderApiRecord, file: string): Promise<void> => {
    const format = formatOfFile(file);
    const id = format ? record.renders[format] : undefined;
    const render = id ? await store.getRender(id, record.principal) : null;
    if (!render) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    await sendOutput(res, render, file);
  };

  // A capability URL: the signature is the credential, so a revoked token leaves it
  // working until it expires or someone deletes the record. A shared cache may hold it
  // for at most five minutes, which is how long a deletion can take to reach everyone.
  const capabilityFile: Handler = async (_req, res, ctx: RouteCtx) => {
    const format = formatOfFile(ctx.params.file!);
    const outcome = prepared.signer && format ? prepared.signer.verify(ctx.params.id!, format, ctx.params.expires!, ctx.params.signature!, deps.now?.()) : 'invalid';
    if (outcome === 'expired') throw new RenderApiRefusal('URL_EXPIRED', 410, 'this result URL has expired: poll the image again for a new one');
    if (outcome !== 'ok') throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    const record = await store.getRenderApiRecord(ctx.params.id!);
    if (!record) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    setDeliveryClass(res, 'link', { boundedAgeSec: 300 });
    await recordOutput(res, record, ctx.params.file!);
  };
  add('GET', '/compat/files/:id/:expires/:signature/:file', capabilityFile, { delivery: 'link' });
  add('HEAD', '/compat/files/:id/:expires/:signature/:file', capabilityFile, { delivery: 'link' });
  // With `signedDays: 0` the same file needs the token that made it.
  add('GET', '/compat/files/:id/:file', async (req, res, ctx) => {
    const principal = await needToken(req);
    const record = await store.getRenderApiRecord(ctx.params.id!);
    if (!record || record.principal !== principal) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    const current = await view(record);
    const first = record.formats.map((format) => current.renders[format]).find((render) => render?.request);
    if (first?.request) await deps.authorize(principal, first.request);
    await recordOutput(res, record, ctx.params.file!);
  }, TOKEN_ONLY);
  // Bannerbear documents no delete, so this one works for every source. An admin may
  // use it too, because the token that made a record may already be gone.
  add('DELETE', '/compat/requests/:id', async (req, res, ctx) => {
    const principal = await deps.tokenPrincipal(req);
    const record = await store.getRenderApiRecord(ctx.params.id!);
    const admin = await deps.adminMay(req);
    if (!principal && !admin) throw new RenderApiRefusal('UNAUTHORIZED', 401, 'send the token that made this image, or sign in as an admin');
    if (!record || (record.principal !== principal && !admin)) throw new RenderApiRefusal('NOT_FOUND', 404, 'no such image');
    await remove(record);
    await deps.audit(principal ?? 'admin', 'render-api.delete', `render-api:${record.id}`, { source: record.source });
    res.writeHead(204).end();
  });

  add('GET', '/compat/placid/u/:uuid', async (req, res, ctx) => {
    const uuid = ctx.params.uuid!;
    const mapping = lookup('placid', uuid);
    if (!mapping) throw new RenderApiRefusal('TEMPLATE_NOT_MAPPED', 404, `placid template ${uuid} is not mapped on this instance`);
    const raw = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?') + 1) : '';
    if (raw.length > MAX_URL_QUERY) throw new RenderApiRefusal('QUERY_TOO_LONG', 414, 'this URL is too long');
    const signature = ctx.url.searchParams.get('s');
    if (signature !== null) {
      const secret = mapping.url?.credentialRef ? env[mapping.url.credentialRef] : undefined;
      if (!secret || !placidUrlSignatureValid(raw, secret)) throw new RenderApiRefusal('URL_SIGNATURE_INVALID', 403, 'this URL signature does not verify');
    } else if (!mapping.url?.allowUnsigned) {
      throw new RenderApiRefusal('URL_SIGNATURE_REQUIRED', 403, 'this template only renders signed URLs');
    }
    if (!deps.config.urlApi.actAs) throw new RenderApiRefusal('URL_API_NOT_CONFIGURED', 503, 'set renderApi.urlApi.actAs to the service token these renders act as');
    const principal = `service:svc_${deps.config.urlApi.actAs}`;
    const mapped = mapPlacidUrl(uuid, ctx.url.searchParams, lookup);
    // Default priority, because an `allowUnsigned` template lets anyone queue this render.
    // Under load the URL answers 503 with Retry-After, and the render still finishes.
    const plan = parseRenderSpec({ toolId: mapping.toolId, format: mapped.formats[0], inputs: mapped.inputs });
    const problems = await deps.policyProblems(principal, mapping.toolId, mapped.inputs, plan.format);
    if (problems.length) throw new RenderApiRefusal(problems[0]!.code, 422, problems.map((problem) => `${problem.path.replace(/^\//, '')} ${problem.message}`).join('; '), { problems });
    // The same URL is one render until the brand or catalog changes, as "generated on first
    // request" implies. A stored render can only be replayed, so one row points at this URL's
    // current render, and each next render is keyed on the one it replaces. An expired output
    // or a failure therefore costs one step, however many have gone before, and a concurrent
    // request for the same URL reaches the same next render.
    const key = `${URL_API_KEY_PREFIX}${sha256Hex(canonicalJson({ uuid, inputs: mapped.inputs, format: plan.format, epoch: await deps.renderEpoch() }))}`;
    const finish = async (requestKey: string, whenNew?: () => Promise<void>): Promise<RenderRecord> => {
      const submitted = await deps.submit(principal, plan, requestKey);
      if (!submitted.reused) await whenNew?.();
      let { record } = submitted;
      const deadline = Date.now() + SYNC_LIMIT_MS;
      while (record.state === 'queued' || record.state === 'running') {
        if (Date.now() >= deadline) break;
        await delay(WAIT_STEP_MS);
        record = (await store.getRender(record.id, principal)) ?? record;
      }
      return record;
    };
    const stillBusy = (): never => {
      res.setHeader('retry-after', '2');
      throw new RenderApiRefusal('RENDER_BUSY', 503, 'this image is still being made: try again shortly');
    };
    await waiting(async () => {
      const { record: pointer } = await store.insertRenderApiRecord({
        id: randomId(12), source: 'placid', template: uuid, principal, formats: [plan.format], renders: {},
        metadata: null, echo: { urlApi: true }, createdAt: new Date().toISOString(), idempotencyKey: key,
      });
      const pinned = pointer.renders[plan.format];
      let current = pinned ? await store.getRender(pinned, principal) : null;
      current ??= await finish(key);
      for (let step = 0; step < MAX_URL_GENERATIONS; step++) {
        let whenNew: (() => Promise<void>) | undefined;
        if (current.state === 'queued' || current.state === 'running') {
          current = await finish(current.idempotencyKey ?? key);
          if (current.state === 'queued' || current.state === 'running') return stillBusy();
        }
        if (current.id !== pinned) await store.setRenderApiRenders(pointer.id, { [plan.format]: current.id });
        if (current.state !== 'succeeded') {
          // A durable render has already spent its attempts, so a failure stands for a short
          // window: a broken tool is not re-rendered on every request, and a later one tries again.
          const finished = Date.parse(current.finishedAt ?? current.updatedAt);
          if (Date.now() - finished < URL_RETRY_WINDOW_MS) throw new RenderApiRefusal('RENDER_FAILED', 502, current.error?.message ?? 'this image could not be made');
        } else {
          let bytes: Buffer | null = null;
          try { bytes = await readOutput(current); }
          catch (error) {
            if (!(error instanceof RenderApiRefusal)) throw error;
            // Retention removing an output is normal. Bytes that changed or vanished are not, so
            // the request that makes the replacement records why, once per replaced render.
            if (error.code === 'OUTPUT_INTEGRITY' || error.code === 'OUTPUT_UNAVAILABLE') {
              const replaced = current;
              const reason = error.code;
              whenNew = () => deps.audit(principal, 'render-api.url-output-replaced', `render-api:${pointer.id}`,
                { replacedRender: replaced.id, reason, expectedSha256: replaced.output!.sha256 });
            }
          }
          if (bytes) {
            setDeliveryClass(res, 'link', { boundedAgeSec: 300 });
            return writeOutput(res, current, fileName(undefined, plan.format), bytes);
          }
        }
        current = await finish(`${key}:after:${current.id}`, whenNew);
      }
      return stillBusy();
    });
  }, { delivery: 'link' });

  // Everything else on those hosts is named, so a client learns why and where to look.
  const unsupported = (hint: string): Handler => (_req, res) => {
    sendError(res, 501, 'NOT_SUPPORTED_BY_MIGRATION_API', `${hint} See ${DOCS}`);
  };
  const IMAGES_ONLY = 'This migration API covers image creation only.';
  const NO_REGISTERED_WEBHOOKS = 'Registered V5 webhooks are not supported: their payload and signature could not be confirmed from public documentation. Use callbackUrl on /api/v1/renders.';
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    add(method, '/compat/bannerbear/v5/webhooks', unsupported(NO_REGISTERED_WEBHOOKS), TOKEN_ONLY);
    add(method, '/compat/bannerbear/v5/webhooks/*', unsupported(NO_REGISTERED_WEBHOOKS), TOKEN_ONLY);
    add(method, '/compat/bannerbear/v5/*', unsupported(IMAGES_ONLY), TOKEN_ONLY);
    add(method, '/compat/bannerbear/v2/*', unsupported(IMAGES_ONLY), TOKEN_ONLY);
    add(method, '/compat/placid/api/rest/*', unsupported(IMAGES_ONLY), TOKEN_ONLY);
  }
}
