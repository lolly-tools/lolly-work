// SPDX-License-Identifier: MPL-2.0
/**
 * Edge administration API, behind `instance.config` (owners by default):
 *
 *   GET    /api/v1/edge                            providers, recent purges
 *   GET    /api/v1/edge/providers/:id/verify       read-only zone checks
 *   POST   /api/v1/edge/purge                      queue a purge {tags?, urls?, paths?}
 *   PUT    /api/v1/edge/providers/:id/credential   seal and store a credential {secret}
 *   DELETE /api/v1/edge/providers/:id/credential
 *
 * No answer carries a credential or the name of the variable that holds one;
 * a stored credential is shown by its fingerprint only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import { sealSecret, secretFingerprint } from '../lib/crypto.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { edgeProviderDescriptor, edgeTagHeaders, type EdgeConfig, type EdgeProviderConfig } from './config.ts';
import type { EdgePurgeOutbox } from './outbox.ts';
import { createEdgeAdapter, edgeCredentialContext } from './registry.ts';
import type { EdgeAdapter } from './types.ts';
import { JSON_BODY_MEDIUM_BYTES, JSON_BODY_SMALL_BYTES } from '../api/body-limits.ts';

export interface EdgeRouteDeps {
  config: EdgeConfig;
  instanceTag: string | undefined;
  outbox: EdgePurgeOutbox;
  store: Pick<Store, 'listEdgePurges' | 'putEdgeCredential' | 'getEdgeCredential'>;
  adapterFor: (provider: EdgeProviderConfig) => Promise<EdgeAdapter | null>;
  /** Provider ids whose credentialRef variable is set in this process. */
  envCredentials: ReadonlySet<string>;
  requireOwner: (req: IncomingMessage, res: ServerResponse) => Promise<UserRecord | null>;
  audit: (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;
  credentialSecret?: string;
  fetchImpl?: typeof fetch;
}

export const MAX_ITEMS = 100;

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(item => typeof item !== 'string' || item.length > 2048)) return null;
  return value as string[];
}

export function registerEdgeRoutes(router: ReturnType<typeof createRouter>, deps: EdgeRouteDeps): void {
  const provider = (res: ServerResponse, id: string): EdgeProviderConfig | null => {
    const found = deps.config.providers.find(p => p.id === id);
    if (!found) sendError(res, 404, 'NOT_FOUND', 'No edge provider has that id in instance.json.');
    return found ?? null;
  };

  router.add('GET', '/api/v1/edge', async (req, res) => {
    if (!(await deps.requireOwner(req, res))) return;
    const providers = await Promise.all(deps.config.providers.map(async p => {
      const stored = p.credentialRef ? null : await deps.store.getEdgeCredential(p.id);
      return { ...edgeProviderDescriptor(p),
        credential: p.credentialRef ? { source: 'environment', present: deps.envCredentials.has(p.id) }
          : { source: 'sealed', present: !!stored, ...(stored ? { fingerprint: stored.fingerprint, updatedAt: stored.updatedAt } : {}) } };
    }));
    const purges = (await deps.store.listEdgePurges(25)).map(row => ({
      id: row.id, provider: row.providerId, kind: row.kind, items: row.items.length, reason: row.reason, state: row.state,
      attempts: row.attempt, createdAt: row.createdAt, ...(row.state === 'pending' ? { nextAttemptAt: row.nextAttemptAt } : {}),
      ...(row.settledAt ? { settledAt: row.settledAt } : {}), ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.receipt ? { receipt: row.receipt } : {}),
    }));
    sendJson(res, 200, { jurisdiction: deps.config.jurisdiction, instanceTag: deps.instanceTag ?? null, tagHeaders: edgeTagHeaders(deps.config), providers, purges });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/edge/providers/:id/verify', async (req, res, ctx) => {
    if (!(await deps.requireOwner(req, res))) return;
    const p = provider(res, ctx.params.id ?? '');
    if (!p) return;
    const adapter = await deps.adapterFor(p);
    if (!adapter) return sendError(res, 409, 'EDGE_CREDENTIAL_MISSING', `No credential is available for ${p.id}. Set its credentialRef variable, or store one with lw edge credential ${p.id}.`);
    const findings = await adapter.verifyZone();
    sendJson(res, 200, { provider: p.id, kind: p.kind, checkedOn: adapter.capabilities.checkedOn, unverified: adapter.capabilities.unverified,
      ok: !findings.some(f => f.status === 'fail'), findings });
  }, { delivery: 'person-private' });

  router.add('POST', '/api/v1/edge/purge', async (req, res) => {
    const user = await deps.requireOwner(req, res);
    if (!user) return;
    if (!deps.outbox.configured) return sendError(res, 409, 'EDGE_NOT_CONFIGURED', 'No edge provider is configured in instance.json.');
    const body = await readJson(req, JSON_BODY_MEDIUM_BYTES) as { tags?: unknown; urls?: unknown; paths?: unknown } | null;
    const tags = stringList(body?.tags), urls = stringList(body?.urls), paths = stringList(body?.paths);
    if (!tags || !urls || !paths) return sendError(res, 400, 'INVALID_INPUT', `tags, urls and paths must each be a list of at most ${MAX_ITEMS} strings`);
    if (!tags.length && !urls.length && !paths.length) return sendError(res, 400, 'INVALID_INPUT', 'Give at least one tag, URL or path to purge.');
    const { records, refused } = await deps.outbox.enqueue({ tags, urls, paths, reason: 'operator' });
    if (!records.length) return sendError(res, 400, 'INVALID_INPUT', `Nothing to purge: refused ${refused.join(', ')}`);
    await deps.audit(`user:${user.id}`, 'edge.purge.requested', 'edge', {
      purges: records.map(r => r.id), tags: tags.length, urls: urls.length, paths: paths.length, refused: refused.length,
    });
    void deps.outbox.poll().catch(() => {});
    sendJson(res, 202, { queued: records.map(r => ({ id: r.id, provider: r.providerId, kind: r.kind, items: r.items.length, nextAttemptAt: r.nextAttemptAt })), refused });
  });

  router.add('PUT', '/api/v1/edge/providers/:id/credential', async (req, res, ctx) => {
    const user = await deps.requireOwner(req, res);
    if (!user) return;
    const p = provider(res, ctx.params.id ?? '');
    if (!p) return;
    if (p.credentialRef) return sendError(res, 409, 'CONFIG_MANAGED', `${p.id} reads its credential from the environment (credentialRef); change it there.`);
    if (!deps.credentialSecret) return sendError(res, 409, 'CREDENTIAL_SECRET_MISSING', 'Set LW_CREDENTIAL_SECRET before storing edge credentials.');
    const body = await readJson(req, JSON_BODY_SMALL_BYTES) as { secret?: unknown } | null;
    const secret = typeof body?.secret === 'string' ? body.secret.trim() : '';
    if (secret.length < 8 || secret.length > 4096 || /\s/.test(secret)) return sendError(res, 400, 'INVALID_INPUT', 'secret required: the provider API key or token, without spaces');
    // Read the zone with the candidate before keeping it, so a wrong key is refused now.
    const findings = await createEdgeAdapter(p, secret, deps.fetchImpl).verifyZone();
    const zone = findings[0];
    if (zone?.status === 'fail') return sendError(res, 409, 'EDGE_CREDENTIAL_REJECTED', zone.message);
    const fingerprint = secretFingerprint(secret);
    const previous = await deps.store.getEdgeCredential(p.id);
    await deps.store.putEdgeCredential(p.id, { ciphertext: sealSecret(secret, deps.credentialSecret, edgeCredentialContext(p.id)), fingerprint, updatedAt: new Date().toISOString() });
    await deps.audit(`user:${user.id}`, 'edge.provider.credential', `edge-provider:${p.id}`, { fingerprint, rotatedFrom: previous?.fingerprint ?? null });
    sendJson(res, 200, { provider: p.id, fingerprint, ok: !findings.some(f => f.status === 'fail'), findings });
  });

  router.add('DELETE', '/api/v1/edge/providers/:id/credential', async (req, res, ctx) => {
    const user = await deps.requireOwner(req, res);
    if (!user) return;
    const p = provider(res, ctx.params.id ?? '');
    if (!p) return;
    const previous = await deps.store.getEdgeCredential(p.id);
    await deps.store.putEdgeCredential(p.id, null);
    await deps.audit(`user:${user.id}`, 'edge.provider.credential', `edge-provider:${p.id}`, { fingerprint: null, rotatedFrom: previous?.fingerprint ?? null });
    sendJson(res, 200, { provider: p.id, removed: !!previous });
  });
}
