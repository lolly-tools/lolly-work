import { canonicalJson, randomId, sha256Hex } from '../lib/crypto.ts';
import { RenderResourceError, type RenderRecord, type RenderSpec } from './types.ts';

function invalid(message: string): never {
  throw new RenderResourceError('INVALID_INPUT', 400, message);
}

/** Bounded JSON only; reject keys unsafe for downstream object-based serializers. */
function checkInputs(value: unknown, depth = 0, budget = { left: 10_000 }): void {
  if (--budget.left < 0 || depth > 32) invalid('inputs exceed the structure limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) checkInputs(item, depth + 1, budget); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('inputs contain an unsupported object key');
      checkInputs(item, depth + 1, budget);
    }
    return;
  }
  invalid('inputs must contain only JSON values');
}

export function parseRenderSpec(value: unknown): RenderSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('JSON object required');
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['toolId', 'format', 'inputs', 'priority', 'maxAttempts'].includes(key)) invalid(`unknown render field: ${key}`);
  }
  if (typeof body.toolId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(body.toolId)) invalid('valid toolId required');
  if (typeof body.format !== 'string') invalid('format required');
  const format = body.format.toLowerCase() === 'jpeg' ? 'jpg' : body.format.toLowerCase();
  if (!['svg', 'png', 'jpg', 'pdf'].includes(format)) invalid('unsupported render format');
  const inputs = body.inputs === undefined ? {} : body.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) invalid('inputs must be an object');
  checkInputs(inputs);
  const priority = body.priority ?? 0;
  const maxAttempts = body.maxAttempts ?? 3;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 9) invalid('priority must be an integer from 0 to 9');
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) invalid('maxAttempts must be an integer from 1 to 5');
  const request = { toolId: body.toolId, format, inputs: structuredClone(inputs) as Record<string, unknown>, priority, maxAttempts };
  if (Buffer.byteLength(canonicalJson(request)) > 1_000_000) invalid('render request exceeds 1 MB');
  return request;
}

export function newRender(principal: string, request: RenderSpec, idempotencyKey?: string, retryOf?: string): RenderRecord {
  if (idempotencyKey !== undefined && (!idempotencyKey.trim() || idempotencyKey.length > 200)) invalid('Idempotency-Key must be 1–200 characters');
  const now = new Date().toISOString();
  return {
    id: `rnd_${randomId(16)}`, principal, request,
    requestHash: sha256Hex(canonicalJson({ request, retryOf: retryOf ?? null })),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}), ...(retryOf ? { retryOf } : {}),
    state: 'queued', attempt: 0, createdAt: now, updatedAt: now, availableAt: now,
  };
}

export function renderWire(record: RenderRecord): Record<string, unknown> {
  const { principal: _principal, leaseToken: _token, leaseUntil: _until, output, ...rest } = record;
  return {
    ...rest,
    statusUrl: `/api/v1/renders/${record.id}`,
    ...(output ? { output: { name: output.name, mime: output.mime, size: output.size, sha256: output.sha256, cacheKey: output.cacheKey,
      ...(output.evidence ? { evidence: { id: output.evidence.id, coverage: output.evidence.coverage, url: `/api/v1/renders/${record.id}/evidence` } } : {}),
      url: `/api/v1/renders/${record.id}/output/default` } } : {}),
  };
}
