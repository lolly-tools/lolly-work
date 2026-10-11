// SPDX-License-Identifier: MPL-2.0
/** Failure-only DOM facts locate a blocked boot without reading text or storage. */
export const RENDER_PAGE_PHASE_SCRIPT = String.raw`(() => {
  const index = globalThis.__toolIndex;
  const path = location.pathname;
  return {
    readyState: document.readyState,
    webgpu: document.documentElement.dataset.webgpu || '',
    catalogTrust: document.documentElement.dataset.catalogTrust || '',
    indexPresent: index !== undefined && index !== null,
    qrInIndex: Array.isArray(index?.tools) && index.tools.some(tool => tool?.id === 'qr-code'),
    route: path === '/t/qr-code' ? 'qr-code' : path === '/t/sandbox' ? 'sandbox' : path === '/' ? 'root' : 'other',
    signIn: !!document.querySelector('.org-gate'),
    loading: !!document.querySelector('.view-loading, #view .loading'),
    errorAction: !!document.querySelector('#view .error button'),
    databaseUpdate: !!document.querySelector('[data-database-update-required]'),
    toolView: !!document.querySelector('#view.tool-view'),
    inputsMounted: !!document.querySelector('#tool-inputs')
  };
})()`;

const FLAGS = ['indexPresent', 'qrInIndex', 'signIn', 'loading', 'errorAction', 'databaseUpdate', 'toolView', 'inputsMounted'] as const;
const enumValue = (value: unknown, allowed: readonly string[]): string => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
interface PagePhase {
  status: 'observed' | 'unavailable' | 'refused' | 'deadline'; elapsedMs?: number;
  readyState?: string; webgpu?: string; catalogTrust?: string; route?: string;
  indexPresent?: boolean; qrInIndex?: boolean; signIn?: boolean; loading?: boolean;
  errorAction?: boolean; databaseUpdate?: boolean; toolView?: boolean; inputsMounted?: boolean;
}

/** Never wait beyond 250ms after the original failure; a probe cannot change a gate. */
export async function captureRenderPagePhase(read?: () => Promise<unknown>): Promise<PagePhase> {
  if (!read) return { status: 'unavailable' as const };
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(read).then(value => ({ status: 'observed' as const, value }), () => ({ status: 'refused' as const })),
      new Promise<{ status: 'deadline' }>(resolve => { timer = setTimeout(() => resolve({ status: 'deadline' }), 250); }),
    ]);
    const elapsedMs = performance.now() - started;
    if (outcome.status !== 'observed') return { status: outcome.status, elapsedMs };
    if (!outcome.value || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) return { status: 'refused' as const, elapsedMs };
    const value = outcome.value as Record<string, unknown>;
    if (FLAGS.some(flag => typeof value[flag] !== 'boolean')) return { status: 'refused' as const, elapsedMs };
    return { status: 'observed' as const, elapsedMs,
      readyState: enumValue(value.readyState, ['loading', 'interactive', 'complete']),
      webgpu: enumValue(value.webgpu, ['', 'ready', 'unsupported']),
      catalogTrust: enumValue(value.catalogTrust, ['', 'verified', 'partially-verified', 'verified-offline', 'unchecked', 'unsigned-dev', 'refused']),
      route: enumValue(value.route, ['qr-code', 'sandbox', 'root', 'other']),
      ...Object.fromEntries(FLAGS.map(flag => [flag, value[flag] as boolean])) };
  } catch { return { status: 'refused' as const, elapsedMs: performance.now() - started }; }
  finally { if (timer) clearTimeout(timer); }
}
