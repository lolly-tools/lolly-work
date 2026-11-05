// SPDX-License-Identifier: MPL-2.0
/**
 * Durable render state to each vendor's response, field for field. Every response
 * also carries a `lolly` member with the record id, the render ids and any error,
 * so someone moving can read the native records without guessing. Vendor fields
 * Lolly has no value for are null, as the vendor's docs show them while pending.
 */
import type { RenderRecord } from '../renders/types.ts';
import type { RenderApiRecord } from './types.ts';

export interface RenderView {
  record: RenderApiRecord;
  /** Format to its render. A format with no render yet is null. */
  renders: Record<string, RenderRecord | null>;
  /** The result URL for a format. */
  fileUrl(format: string, render: RenderRecord): string | null;
  /** This record's poll URL in the vendor's shape. */
  self: string;
  /** The last status a webhook receiver answered, when there is one. */
  webhookResponseCode?: number | null;
  deliveryId?: string;
}

type Aggregate = 'pending' | 'done' | 'failed';

export function aggregate(view: Pick<RenderView, 'record' | 'renders'>): Aggregate {
  const renders = view.record.formats.map((format) => view.renders[format] ?? null);
  if (renders.some((render) => render?.state === 'failed' || render?.state === 'cancelled')) return 'failed';
  return renders.every((render) => render?.state === 'succeeded') ? 'done' : 'pending';
}

const firstFailure = (view: RenderView): { code: string; message: string } | null => {
  for (const format of view.record.formats) {
    const render = view.renders[format];
    if (render?.state === 'cancelled') return { code: 'CANCELLED', message: 'the render was cancelled' };
    if (render?.state === 'failed') return render.error ? { code: render.error.code, message: render.error.message } : { code: 'RENDER_FAILED', message: 'the render failed' };
  }
  return null;
};

const fileOf = (view: RenderView, format: string): string | null => {
  const render = view.renders[format];
  return render?.state === 'succeeded' && render.output && !render.output.expiredAt ? view.fileUrl(format, render) : null;
};

const lollyMember = (view: RenderView): Record<string, unknown> => {
  const failure = firstFailure(view);
  return {
    lolly: {
      id: view.record.id,
      renders: Object.fromEntries(Object.entries(view.record.renders)),
      ...(failure ? { error: failure } : {}),
      ...(view.deliveryId ? { deliveryId: view.deliveryId } : {}),
    },
  };
};

const VENDOR_STATE: Record<Aggregate, string> = { pending: 'pending', done: 'completed', failed: 'failed' };

/** The image object of Bannerbear's V5 docs. `files` values are null while pending. */
export function bannerbearV5Wire(view: RenderView): Record<string, unknown> {
  const state = aggregate(view);
  const finished = view.record.formats.map((format) => view.renders[format]?.finishedAt).filter((at): at is string => !!at).sort();
  return {
    uid: view.record.id,
    status: VENDOR_STATE[state],
    template: view.record.template,
    files: Object.fromEntries(view.record.formats.map((format) => [format, fileOf(view, format)])),
    metadata: view.record.metadata ?? null,
    ...(state === 'failed' ? { error: firstFailure(view)?.message ?? 'the render failed' } : {}),
    self: view.self,
    created_at: view.record.createdAt,
    completed_at: state === 'done' ? finished[finished.length - 1] ?? null : null,
    ...lollyMember(view),
  };
}

/** The image object of Bannerbear's V2 docs. */
export function bannerbearV2Wire(view: RenderView): Record<string, unknown> {
  const [primary] = view.record.formats;
  const evidence = primary ? view.renders[primary]?.output?.evidence : undefined;
  return {
    uid: view.record.id,
    status: VENDOR_STATE[aggregate(view)],
    self: view.self,
    image_url: primary ? fileOf(view, primary) : null,
    pdf_url: view.record.formats.includes('pdf') && primary !== 'pdf' ? fileOf(view, 'pdf') : null,
    template: view.record.template,
    modifications: view.record.echo.modifications ?? [],
    webhook_url: view.record.webhookUrl ?? null,
    webhook_response_code: view.webhookResponseCode ?? null,
    transparent: view.record.echo.transparent === true,
    metadata: view.record.metadata ?? null,
    render_pdf: view.record.echo.render_pdf === true,
    width: evidence?.inspection?.measured.widthPx ?? evidence?.context?.widthPx ?? null,
    height: evidence?.inspection?.measured.heightPx ?? evidence?.context?.heightPx ?? null,
    created_at: view.record.createdAt,
    ...lollyMember(view),
  };
}

/** Lolly's failure codes in Placid's documented vocabulary. Placid says to treat an
 *  unknown code as INTERNAL, so anything else becomes that, with its real name in `lolly`. */
export function placidErrorCode(code: string): string {
  if (code === 'CANCELLED') return 'CANCELLED';
  if (['INVALID_INPUT', 'INPUT_VALIDATION_FAILED', 'INPUT_LOCKED', 'INPUT_HIDDEN', 'INPUT_NOT_ALLOWED', 'BRAND_RULE_VIOLATION', 'FORMAT_UNSUPPORTED', 'FORMAT_NOT_ALLOWED'].includes(code)) return 'INVALID_INPUT';
  if (code === 'RENDER_TIMEOUT' || code === 'RENDER_DEADLINE_EXCEEDED') return 'RENDER_TIMEOUT';
  if (code === 'OUTPUT_UNAVAILABLE') return 'STORAGE_FAILED';
  return 'INTERNAL';
}

/** The image object of Placid's docs. */
export function placidWire(view: RenderView): Record<string, unknown> {
  const state = aggregate(view);
  const [format] = view.record.formats;
  const failure = state === 'failed' ? firstFailure(view) : null;
  return {
    id: view.record.seq,
    status: state === 'done' ? 'finished' : state === 'failed' ? 'error' : 'queued',
    image_url: format ? fileOf(view, format) : null,
    polling_url: view.self,
    ...(view.record.metadata !== null && view.record.metadata !== undefined ? { passthrough: view.record.metadata } : {}),
    ...(failure ? { error_code: placidErrorCode(failure.code), error_message: failure.message, error_details: [] } : {}),
    ...lollyMember(view),
  };
}

export function wireFor(view: RenderView): Record<string, unknown> {
  switch (view.record.source) {
    case 'bannerbear-v5': return bannerbearV5Wire(view);
    case 'bannerbear-v2': return bannerbearV2Wire(view);
    default: return placidWire(view);
  }
}
