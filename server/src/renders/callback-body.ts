// SPDX-License-Identifier: MPL-2.0
/**
 * What a signed callback says about a finished render or render batch. The
 * outbox owns sending: signature, delivery id, retries and outcomes. These two
 * functions own the words, so a receiver contract in another shape can replace
 * them through the outbox's `renderBody` option without a second sender.
 *
 * Absolute URLs and a 24-hour token that reads this one subject's output, so a
 * receiver needs no credentials of its own. The token reads under the owner's
 * current grants. Failure inspection and production reports stay on the record.
 */
import { batchProgress } from './batch.ts';
import type { RenderBatchRecord, RenderRecord } from './types.ts';

export interface RenderCallbackContext {
  /** The idempotency key every attempt of this callback carries. */
  deliveryId: string;
  /** The instance's base URL; empty keeps the URLs relative. */
  baseUrl: string;
  /** Sent back as `x-lw-render-token` on this subject's output routes. */
  outputToken: string | null;
}

export type RenderCallbackSubject =
  | { kind: 'render'; render: RenderRecord }
  | { kind: 'render-batch'; batch: RenderBatchRecord };

export function renderCallbackBody(render: RenderRecord, ctx: RenderCallbackContext): Record<string, unknown> {
  const succeeded = render.state === 'succeeded' && !!render.output;
  return {
    renderId: render.id,
    state: render.state,
    statusUrl: `${ctx.baseUrl}/api/v1/renders/${render.id}`,
    outputUrl: succeeded ? `${ctx.baseUrl}/api/v1/renders/${render.id}/output/default` : null,
    outputSha256: succeeded ? render.output!.sha256 : null,
    outputToken: succeeded ? ctx.outputToken : null,
    error: render.error ? { code: render.error.code, message: render.error.message } : null,
    deliveryId: ctx.deliveryId,
  };
}

export function batchCallbackBody(batch: RenderBatchRecord, ctx: RenderCallbackContext): Record<string, unknown> {
  const { state, progress } = batchProgress(batch);
  return {
    batchId: batch.id,
    state,
    progress,
    statusUrl: `${ctx.baseUrl}/api/v1/render-batches/${batch.id}`,
    manifestUrl: `${ctx.baseUrl}/api/v1/render-batches/${batch.id}/manifest`,
    outputToken: ctx.outputToken,
    deliveryId: ctx.deliveryId,
  };
}

export function defaultRenderCallbackBody(subject: RenderCallbackSubject, ctx: RenderCallbackContext): Record<string, unknown> {
  return subject.kind === 'render' ? renderCallbackBody(subject.render, ctx) : batchCallbackBody(subject.batch, ctx);
}
