// SPDX-License-Identifier: MPL-2.0
import { RenderError } from './pipeline.ts';

export async function withRenderDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, caller?: AbortSignal,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    timer = setTimeout(() => controller.abort(new RenderError('RENDER_TIMEOUT', 504, 'render deadline exceeded')), duration);
    timer.unref();
  });
  try { signal.throwIfAborted(); return await Promise.race([run(signal), deadline]); }
  finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}
