import type { IncomingMessage } from 'node:http';
import { type createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { UserRecord } from '../store/types.ts';
import { type BrandService, parseBrandChange } from './service.ts';
import type { createBrandRuleService } from './rule-service.ts';

export function registerBrandRoutes(router: ReturnType<typeof createRouter>, deps: {
  brand: BrandService; member(req: IncomingMessage): Promise<UserRecord | null>;
  rules: ReturnType<typeof createBrandRuleService>;
}) {
  const { brand } = deps;
  router.add('GET', '/api/v1/brand/rules', async (req, res) => {
    const actor = await deps.member(req);
    if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in to inspect managed rules.');
    sendJson(res, 200, await deps.rules.inspect(actor), { 'cache-control': 'private, no-store' });
  });
  for (const preview of [true, false]) router.add('POST', preview ? '/api/v1/brand/rules/preview' : '/api/v1/brand/rules', async (req, res) => {
    const actor = await deps.member(req);
    if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in to change managed rules.');
    const body = await readJson(req) as { mappings?: unknown; revision?: number; reviewToken?: string } | null;
    if (preview) return sendJson(res, 200, await deps.rules.preview(actor, body?.mappings));
    if (!Number.isSafeInteger(body?.revision) || typeof body?.reviewToken !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'Review the mappings before applying.');
    sendJson(res, 200, await deps.rules.apply(actor, body?.mappings, body!.revision!, body!.reviewToken!));
  });
  router.add('GET', '/api/v1/brand/profiles', async (req, res) => {
    const actor = await deps.member(req);
    if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in to inspect design-system sources.');
    if (!await brand.allowed(actor, 'catalog.read')) return sendError(res, 403, 'FORBIDDEN', 'catalog.read required');
    await brand.ensureDownload().catch(() => { /* Invalid configured downloads must not block source administration. */ });
    sendJson(res, 200, await brand.inventory(actor), { 'cache-control': 'private, no-store' });
  });
  for (const preview of [true, false]) {
    router.add('POST', preview ? '/api/v1/brand/changes/preview' : '/api/v1/brand/changes', async (req, res) => {
      const actor = await deps.member(req);
      if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in to change the design system.');
      const body = await readJson(req) as { revision?: number; reviewToken?: string } | null;
      const change = parseBrandChange(body);
      if (preview) return sendJson(res, 200, await brand.preview(actor, change), { 'cache-control': 'private, no-store' });
      if (!Number.isSafeInteger(body?.revision) || typeof body?.reviewToken !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'Review the change first, then provide revision and reviewToken.');
      sendJson(res, 200, await brand.apply(actor, change, body!.revision!, body!.reviewToken!));
    });
  }
  // The legacy route applies through the same permission, validation and CAS service.
  router.add('PUT', '/api/v1/brand/profile', async (req, res) => {
    const actor = await deps.member(req);
    if (!actor) return sendError(res, 401, 'UNAUTHORIZED', 'Sign in first.');
    const body = await readJson(req) as { name?: unknown } | null;
    if (typeof body?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(body.name)) return sendError(res, 400, 'INVALID_INPUT', 'name required');
    const change = { action: 'select' as const, sourceId: `profile:${body.name}` };
    const reviewed = await brand.preview(actor, change);
    const result = await brand.apply(actor, change, reviewed.revision, reviewed.reviewToken);
    sendJson(res, 200, { ...result, ...await brand.inventory(actor) });
  });
}
