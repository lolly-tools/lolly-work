// SPDX-License-Identifier: MPL-2.0
/**
 * The release notice for owners and admins.
 *
 *   GET  /api/v1/admin/updates         the last check: newer releases and the upgrade steps
 *   POST /api/v1/admin/updates/check   read the release feed now (409 when checks are off)
 *
 * Both need `fleet.view`, the admin-tier permission for which versions this
 * deployment and its apps run. Members never hold it unless a grant gives it.
 * GET reads memory only and never reaches the network.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, type createRouter } from '../api/router.ts';
import type { UserRecord } from '../store/types.ts';
import type { UpdateChecker, UpdateSnapshot } from './checker.ts';
import { repositoryUrl, upgradeSteps } from './steps.ts';

type Router = ReturnType<typeof createRouter>;
export const UPDATES_ACTION = 'fleet.view';
/** How many newer releases the answer lists. What they say is read across all of them. */
export const RELEASES_SHOWN = 20;

export interface UpdateRouteDeps {
  checker: UpdateChecker;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
}

/** What a newer release up to and including the target says about migrations:
 *  true when one migrates, null when one does not say, false otherwise. */
function migratesUpTo(snapshot: UpdateSnapshot): boolean | null {
  if (!snapshot.newer.length) return false;
  if (snapshot.newer.some(r => (r.migrations ?? 0) > 0)) return true;
  return snapshot.newer.some(r => r.migrations === null) ? null : false;
}

export function updatesView(checker: UpdateChecker): Record<string, unknown> {
  const snapshot = checker.snapshot();
  const { settings } = checker;
  const latest = snapshot.newer[0] ?? null;
  const migrates = migratesUpTo(snapshot);
  const repoUrl = repositoryUrl(settings.feedUrl);
  return {
    check: settings.check,
    channel: settings.channel,
    // The origin only: a mirror's address may carry a credential in its query.
    feed: new URL(settings.feedUrl).origin,
    status: snapshot.status,
    checkedAt: snapshot.checkedAt,
    attemptedAt: snapshot.attemptedAt,
    error: snapshot.error,
    current: { version: snapshot.current, chartVersion: settings.release.chartVersion },
    latest: latest?.version ?? null,
    newer: snapshot.newer.length,
    releases: snapshot.newer.slice(0, RELEASES_SHOWN).map(r => ({
      version: r.version,
      appVersion: r.appVersion,
      created: r.created,
      prerelease: r.prerelease,
      security: r.security,
      migrations: r.migrations,
      migrationClasses: r.migrationClasses,
      notesUrl: r.notesUrl,
      changes: r.changes,
    })),
    // Across every newer release, because an upgrade runs each one's migrations.
    security: snapshot.newer.some(r => r.security),
    migrates,
    // Migrations the newer releases state, across every one of them.
    migrationCount: snapshot.newer.reduce((sum, r) => sum + (r.migrations ?? 0), 0),
    install: {
      route: settings.route,
      release: settings.release.name,
      namespace: settings.release.namespace,
      deployment: settings.release.fullname,
      repository: repoUrl,
    },
    steps: latest ? upgradeSteps(settings.route, { version: latest.version, release: settings.release, repoUrl, migrates }) : [],
  };
}

export function registerUpdateRoutes(router: Router, deps: UpdateRouteDeps): void {
  router.add('GET', '/api/v1/admin/updates', async (req, res) => {
    if (!(await deps.requireAction(req, res, UPDATES_ACTION))) return;
    sendJson(res, 200, updatesView(deps.checker), { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('POST', '/api/v1/admin/updates/check', async (req, res) => {
    if (!(await deps.requireAction(req, res, UPDATES_ACTION))) return;
    if (!deps.checker.settings.check) {
      return sendError(res, 409, 'UPDATES_OFF', 'Release checks are off in this deployment’s configuration (updates.check).');
    }
    await deps.checker.checkNow();
    sendJson(res, 200, updatesView(deps.checker), { 'cache-control': 'no-store' });
  });
}
