// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseConfig, type InstanceConfig, type Secrets } from '../config/instance.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { createHash } from 'node:crypto';
import { readJson, sendJson, sendError, type createRouter } from '../api/router.ts';
import { generateSetup, identitySettingsHash, mergeSetupPatch, setupDraft, setupSettingsHash, SetupInputError } from './configuration.ts';
import { testIdentityDiscovery } from './identity.ts';

export function registerSetupRoutes(router: ReturnType<typeof createRouter>, deps: {
  config: InstanceConfig; store: Store; secrets: Secrets; fetchImpl: typeof fetch;
  owner(req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, facts: Record<string, unknown>): Promise<unknown>;
}) {
  const { config, store, secrets } = deps;
  const fingerprint = () => identitySettingsHash(config);
  const proofFor = async (user: UserRecord) => {
    const [logins, provision] = await Promise.all([
      store.listAuditBefore(Number.MAX_SAFE_INTEGER, 100, { actor: `user:${user.id}`, action: 'auth.login' }),
      store.listAuditBefore(Number.MAX_SAFE_INTEGER, 1, { subject: `user:${user.id}`, action: 'scim.user.create' }),
    ]);
    const login = logins.findLast(event => ['oidc', 'proxy'].includes(String(event.payload?.provider)) && event.payload?.setupFingerprint === fingerprint());
    return { id: user.id, sub: user.sub, email: user.email, role: user.role, groups: user.groups,
      idpGroups: user.idpGroups, localGroups: user.localGroups, active: !user.disabledAt,
      signIn: login ? { at: login.at, provider: login.payload?.provider, idp: login.payload?.idp ?? null } : null,
      provisioned: provision[0] ? { at: provision[0].at } : null };
  };
  router.add('GET', '/api/v1/system/setup/configuration', async (req, res) => {
    const user = await deps.owner(req, res); if (!user) return;
    const settings = setupDraft(config, user.groups);
    const receipt = (await store.listAuditBefore(Number.MAX_SAFE_INTEGER, 1, { action: 'setup.identity.test', subject: 'setup:identity' }))[0];
    sendJson(res, 200, { version: 1, settings, currentSettingsHash: setupSettingsHash(settings),
      sampleAccountHash: createHash('sha256').update(JSON.stringify([user.id, user.groups, user.role, user.email, user.firstname, user.lastname, user.title])).digest('hex'),
      redirectUri: config.idp.issuer ? `${config.instance.baseUrl}/api/auth/callback` : null,
      scimUrl: `${config.instance.baseUrl}/scim/v2`, account: await proofFor(user),
      identityTest: receipt?.payload?.fingerprint === fingerprint() ? { ok: receipt.payload.ok, checkedAt: receipt.at } : null,
      environment: [
        { name: 'LW_SESSION_SECRET', present: Buffer.byteLength(secrets.session) >= 32 },
        { name: 'LW_LINK_SECRET', present: Buffer.byteLength(secrets.link) >= 32 },
        { name: 'DATABASE_URL', present: store.storageKind === 'postgres' },
        { name: 'LW_IDP_CLIENT_SECRET', present: !!secrets.idpClientSecret },
        { name: 'LW_RENDER_WORKER_SECRET', present: !!secrets.renderWorker },
      ] }, { 'cache-control': 'no-store' });
  });
  router.add('POST', '/api/v1/system/setup/configuration', async (req, res) => {
    const user = await deps.owner(req, res); if (!user) return;
    try {
      const proposal = generateSetup(await readJson(req, 64 * 1024), config);
      if (config.dev.enabled && !proposal.patch.dev.enabled) {
        const target = parseConfig(JSON.stringify(mergeSetupPatch(config as unknown as Record<string, unknown>, proposal.patch)));
        if (identitySettingsHash(target) !== fingerprint() || user.role !== 'owner' || !(await proofFor(user)).signIn) {
          throw new SetupInputError('keepDevelopmentLogin', 'Apply identity and group mappings in restricted evaluation with development login retained. Sign in as a real owner using those settings, then generate the cutover from that session.');
        }
      }
      await deps.audit(`user:${user.id}`, 'setup.configuration.preview', 'setup:configuration', { settingsHash: proposal.expectedSettingsHash });
      sendJson(res, 200, proposal, { 'cache-control': 'no-store' });
    } catch (error) {
      if (!(error instanceof SetupInputError)) throw error;
      sendError(res, 400, 'INVALID_SETUP', error.message, { field: error.field });
    }
  });
  let discoveryPending = false;
  router.add('POST', '/api/v1/system/setup/identity-test', async (req, res) => {
    const user = await deps.owner(req, res); if (!user) return;
    if (discoveryPending) return sendError(res, 409, 'TEST_RUNNING', 'An identity test is already running. Refresh its result shortly.');
    discoveryPending = true;
    try {
      const result = await testIdentityDiscovery(config, deps.fetchImpl);
      await deps.audit(`user:${user.id}`, 'setup.identity.test', 'setup:identity', { ok: result.ok, fingerprint: fingerprint() });
      sendJson(res, 200, result, { 'cache-control': 'no-store' });
    } finally { discoveryPending = false; }
  });
  router.add('POST', '/api/v1/system/setup/account-test', async (req, res) => {
    if (!(await deps.owner(req, res))) return;
    const body = await readJson(req, 4096) as { sub?: unknown } | null;
    if (!body || typeof body.sub !== 'string' || !body.sub || body.sub.length > 1000 || /[\u0000-\u001f]/.test(body.sub)) return sendError(res, 400, 'INVALID_INPUT', 'Enter the exact durable subject, not an email address to merge.');
    const user = await store.getUserBySub(body.sub);
    sendJson(res, 200, { account: user ? await proofFor(user) : null,
      note: 'A match requires the same durable subject and account ID. Sign-in and provisioning evidence comes from retained audit events; an absent event is not proof it never happened.' }, { 'cache-control': 'no-store' });
  });
}
