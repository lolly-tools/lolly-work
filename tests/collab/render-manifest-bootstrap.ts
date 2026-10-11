// SPDX-License-Identifier: MPL-2.0
/** Separate cold shell startup from the five-second held-hook cancellation check. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const RENDER_BOOTSTRAP_BUDGET_MS = 15_000;
type Target = { path: string; readToken: string; revision: string };

/** Only the actual authenticated manifest response can open the hook-phase gate. */
export function createRenderManifestBootstrap() {
  let target: Target | undefined;
  let complete = false, refused = false;
  return {
    arm(value: Target) {
      if (target || !/^\/tools\/[a-z0-9-]+@[a-f0-9]{16}\/tool\.json$/.test(value.path)
        || !value.readToken || !value.revision) throw new Error('A fresh signed manifest target is required');
      target = value;
    },
    observe(req: IncomingMessage, res: ServerResponse) {
      if (!target || req.method !== 'GET' || new URL(req.url ?? '/', 'http://fixture.invalid').pathname !== target.path
        || req.headers['x-lw-render-read'] !== target.readToken || req.headers['x-lolly-brand-revision'] !== target.revision) return;
      let finished = false;
      res.once('finish', () => {
        finished = true;
        if (res.statusCode === 200 && res.getHeader('x-lolly-brand-revision') === target!.revision) complete = true;
        else refused = true;
      });
      res.once('close', () => { if (!finished) refused = true; });
    },
    get complete() { return complete && !refused; },
    get refused() { return refused; },
  };
}

/** The normal twenty-second export budget reserves its final five seconds for hooks. */
export async function waitForRenderManifestBootstrap(
  gate: ReturnType<typeof createRenderManifestBootstrap>,
  live: { settled: () => boolean; contexts: () => number },
): Promise<void> {
  const stop = performance.now() + RENDER_BOOTSTRAP_BUDGET_MS;
  let contextOpened = false;
  do {
    if (live.settled()) throw new Error('The render responded before the held-hook cancellation phase');
    const contexts = live.contexts();
    if (contexts > 1 || (contextOpened && contexts !== 1)) throw new Error('The render context closed before manifest bootstrap');
    contextOpened ||= contexts === 1;
    if (gate.refused) throw new Error('The authenticated manifest response was refused or closed');
    if (gate.complete && contextOpened) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < stop);
  throw new Error('The render manifest bootstrap exceeded its reserved budget');
}
