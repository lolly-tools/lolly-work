// SPDX-License-Identifier: MPL-2.0
/** GET /api/v1/limits: every limit Work enforces, with its value and source, for admins (plans/82 M7). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, type createRouter } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { limitsInventory, type RunnerFigures } from './limits-inventory.ts';

export function registerLimitsRoute(router: ReturnType<typeof createRouter>, deps: {
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<unknown | null>;
  config: InstanceConfig;
  partnerRightsMode(): Promise<string> | string;
  /** The running render runner's figures, when this host runs one. */
  runner?(): RunnerFigures | null;
}): void {
  router.add('GET', '/api/v1/limits', async (req, res) => {
    // The people who govern policy read where each figure comes from; agents read only their own.
    if (!(await deps.requireAction(req, res, 'policy.edit'))) return;
    const partnerRightsMode = await deps.partnerRightsMode();
    sendJson(res, 200, { limits: limitsInventory(deps.config, { partnerRightsMode, runner: deps.runner?.() ?? null }) }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });
}
