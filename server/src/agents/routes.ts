// SPDX-License-Identifier: MPL-2.0
/** One document-scoped credential admits an agent to the workspace MCP endpoint. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import { randomId } from '../lib/crypto.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { mayEditCollab, mayJoinCollab } from '../rbac/evaluate.ts';
import type { DocumentAgentRecord, ProjectRecord, Store, UserRecord } from '../store/types.ts';
import { agentClientInfo } from './client-info.ts';
import { agentActor, agentAttribution } from './attribution.ts';
import { agentSecret, principalOf, resolveAgent } from './access.ts';
import { displayName } from '../iam/member.ts';
import type { AgentRoomBridge } from './types.ts';

interface Dependencies {
  store: Store;
  origin: string;
  rooms?: AgentRoomBridge;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
}
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeRecord = (r: DocumentAgentRecord, rooms?: AgentRoomBridge) => ({ id: r.id, userId: r.userId, sessionId: r.sessionId, label: r.label, role: r.role,
  createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}), connected: rooms?.connected(r.id) ?? false });
const tools = [
  { name: 'read_document', description: 'Join this document as the invited agent. Read the current durable revision, checkpoint, named collections and live editing claims. Read before editing; respect claims held by people.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'apply_document_ops', description: 'Commit a small batch to this document alongside its human collaborators. Use the revision from read_document and a new stable batchId. Retry identical batches with the same batchId. A revision conflict requires a fresh read and a new batchId. Input locks, editing claims, project roles and revocation are enforced.',
    inputSchema: { type: 'object', required: ['expectedRevision', 'batchId', 'ops'], additionalProperties: false, properties: {
      expectedRevision: { type: 'integer', minimum: 0 }, batchId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,48}$' },
      ops: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['k'], properties: {
        k: { type: 'string', enum: ['param', 'geom', 'field', 'add', 'remove', 'order'] }, col: { type: 'string', description: 'Named collection, usually boxes.' },
        key: { type: 'string' }, id: { type: 'string' }, field: { type: 'string' }, value: {}, fields: { type: 'object' }, row: { type: 'object' }, orderKey: { type: 'string' },
      }, description: 'param: key/value; geom: col/id/fields; field: col/id/field/value; add: col/id/row/orderKey; remove: col/id; order: col/id/orderKey. Origins are assigned by the server.' } },
    } }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
];

export function registerAgentRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  const origin = new URL(d.origin).origin;
  async function sessionGate(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = await d.memberOf(req); if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'Sign in first.'); return null; }
    const session = await d.store.getSession(id), project = session ? await d.store.getProject(session.projectId) : null;
    const grants = await d.store.listGrants(), access = project ? await d.projectAccessOf(user, project) : 'none';
    if (!session || session.deletedAt || session.toolId !== 'design' || !project || !accessAtLeast(access, 'viewer') || !mayJoinCollab(principalOf(user), grants)) {
      sendError(res, 404, 'NOT_FOUND', 'This document is not available.'); return null;
    }
    return { user, session, project, access, grants };
  }
  router.add('GET', '/api/v1/sessions/:id/agents', async (req, res, ctx) => {
    const seat = await sessionGate(req, res, ctx.params.id!); if (!seat) return;
    const records = (await d.store.listDocumentAgents(seat.session.id)).slice(-200);
    const agents = await Promise.all(records.map(async r => ({ ...safeRecord(r, d.rooms),
      actingFor: displayName(await d.store.getUser(r.createdBy) ?? seat.user),
      canRevoke: r.createdBy === seat.user.id || accessAtLeast(seat.access, 'manager') })));
    sendJson(res, 200, { enabled: !!d.rooms, canEdit: accessAtLeast(seat.access, 'editor') && mayEditCollab(principalOf(seat.user), seat.grants), agents }, { 'cache-control': 'private, no-store' });
  });
  router.add('POST', '/api/v1/sessions/:id/agents', async (req, res, ctx) => {
    const seat = await sessionGate(req, res, ctx.params.id!); if (!seat) return;
    if (!d.rooms) return sendError(res, 503, 'AGENT_UNAVAILABLE', 'Agent collaboration is not available on this host.');
    const body = await readJson(req, 4096);
    const label = object(body) && typeof body.label === 'string' ? body.label.trim() : '';
    const role = object(body) ? body.role : null, hours = object(body) ? body.hours ?? 24 : 24;
    if (!label || label.length > 80 || /[\u0000-\u001f]/.test(label) || !['viewer', 'editor'].includes(String(role))
      || !Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 168) return sendError(res, 400, 'INVALID_INPUT', 'Choose an agent name, viewer or editor access, and an expiry from 1 to 168 hours.');
    if (seat.project.archivedAt || role === 'editor' && (!accessAtLeast(seat.access, 'editor') || !mayEditCollab(principalOf(seat.user), seat.grants))) {
      return sendError(res, 403, 'READ_ONLY', 'You cannot invite an editor to this document.');
    }
    const { secret, tokenHash } = agentSecret(), now = Date.now();
    const record: DocumentAgentRecord = { id: `agt_${randomId(8)}`, userId: seat.user.id, sessionId: seat.session.id, projectId: seat.project.id,
      createdBy: seat.user.id, label, role: role as 'viewer' | 'editor', tokenHash, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + Number(hours) * 3_600_000).toISOString() };
    if (!await d.store.createDocumentAgent(record)) return sendError(res, 409, 'AGENT_LIMIT', 'Revoke an unused agent invitation before creating another.');
    await d.audit(`user:${seat.user.id}`, 'agent.invite', `session:${seat.session.id}`, { ...agentAttribution(record), role: record.role });
    sendJson(res, 201, { agent: safeRecord(record, d.rooms), secret, endpoint: `${origin}/api/workspace/mcp` }, { 'cache-control': 'no-store' });
  });
  router.add('DELETE', '/api/v1/sessions/:id/agents/:agentId', async (req, res, ctx) => {
    const seat = await sessionGate(req, res, ctx.params.id!); if (!seat) return;
    const agent = await d.store.getDocumentAgent(ctx.params.agentId!);
    if (!agent || agent.sessionId !== seat.session.id) return sendError(res, 404, 'NOT_FOUND', 'This agent invitation is not available.');
    if (agent.createdBy !== seat.user.id && !accessAtLeast(seat.access, 'manager')) return sendError(res, 403, 'FORBIDDEN', 'Only the inviter or a project manager can revoke this invitation.');
    await d.store.revokeDocumentAgent(agent.id, new Date().toISOString()); await d.rooms?.disconnect(agent.id);
    await d.audit(`user:${seat.user.id}`, 'agent.revoke', `session:${seat.session.id}`, agentAttribution(agent));
    res.writeHead(204); res.end();
  });
  const buckets = new Map<string, { at: number; tokens: number }>();
  async function agentGate(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) { sendError(res, 403, 'ORIGIN_REFUSED', 'Use this workspace origin.'); return null; }
    if (!d.rooms) { sendError(res, 503, 'AGENT_UNAVAILABLE', 'Agent collaboration is not available on this host.'); return null; }
    const standing = await resolveAgent(d.store, req.headers.authorization);
    if (!standing) { res.setHeader('www-authenticate', 'Bearer realm="Lolly document agents"'); sendError(res, 401, 'AGENT_REVOKED', 'Use an active invitation for this document.'); return null; }
    const now = Date.now(), b = buckets.get(standing.record.id) ?? { at: now, tokens: 24 };
    b.tokens = Math.min(24, b.tokens + (now - b.at) / 1000 * 4); b.at = now;
    if (b.tokens < 1) { res.setHeader('retry-after', '1'); sendError(res, 429, 'AGENT_RATE_LIMIT', 'Wait a moment before trying again.'); return null; }
    b.tokens--; buckets.delete(standing.record.id); buckets.set(standing.record.id, b);
    if (buckets.size > 1024) buckets.delete(buckets.keys().next().value!);
    return standing;
  }
  router.add('GET', '/api/workspace/mcp', async (req, res) => {
    if (!await agentGate(req, res)) return; res.writeHead(405, { allow: 'POST, DELETE' }); res.end();
  });
  router.add('DELETE', '/api/workspace/mcp', async (req, res) => {
    const standing = await agentGate(req, res); if (!standing) return;
    await d.rooms!.disconnect(standing.record.id);
    await d.audit(agentActor(standing.record), 'agent.disconnect', `session:${standing.record.sessionId}`, agentAttribution(standing.record));
    res.writeHead(204); res.end();
  });
  router.add('POST', '/api/workspace/mcp', async (req, res) => {
    const standing = await agentGate(req, res); if (!standing) return;
    if (req.headers['mcp-protocol-version'] !== undefined && !versions.has(String(req.headers['mcp-protocol-version']))) return sendError(res, 400, 'PROTOCOL_VERSION', 'This protocol version is not supported.');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return sendError(res, 415, 'JSON_REQUIRED', 'Send application/json.');
    const msg = await readJson(req, 256 * 1024);
    if (!object(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request id' } });
    const client = agentClientInfo(msg.params, msg.method === 'initialize');
    const requestAttribution = { ...agentAttribution(standing.record), ...(client ? { client } : {}) };
    const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result }, { 'cache-control': 'no-store' });
    if (msg.method === 'initialize') {
      await d.audit(agentActor(standing.record), 'agent.connect', `session:${standing.record.sessionId}`, { ...requestAttribution, client });
      const asked = object(msg.params) ? msg.params.protocolVersion : null;
      return reply({ protocolVersion: typeof asked === 'string' && versions.has(asked) ? asked : '2025-11-25', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Lolly document collaboration', version: '1.0.0' }, instructions: 'This invitation accesses one document only. Read its current state and claims before making small edits. Use a unique batchId per change; do not overwrite the session over REST.' });
    }
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: standing.mayEdit ? tools : tools.slice(0, 1) });
    if (msg.method !== 'tools/call') return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    const params = object(msg.params) ? msg.params : {}, args = object(params.arguments) ? params.arguments : {};
    try {
      const value = params.name === 'read_document' ? await d.rooms!.read(standing.record)
        : params.name === 'apply_document_ops' ? await d.rooms!.apply(standing.record, args) : null;
      if (!value) {
        await d.audit(agentActor(standing.record), 'agent.tool-call', `session:${standing.record.sessionId}`, { ...requestAttribution, tool: 'unknown', outcome: 'rejected', code: 'UNKNOWN_TOOL' });
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } });
      }
      const rejected = Array.isArray(value.rejectedIds) ? value.rejectedIds.length : 0;
      const accepted = Array.isArray(value.acceptedIds) ? value.acceptedIds.length : 0;
      await d.audit(agentActor(standing.record), 'agent.tool-call', `session:${standing.record.sessionId}`, {
        ...requestAttribution, tool: params.name, outcome: rejected ? accepted ? 'partial' : 'rejected' : 'succeeded',
        ...(Array.isArray(value.acceptedIds) ? { acceptedOps: accepted, rejectedOps: rejected } : {}),
      });
      reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) {
      const code = (error as Error).message;
      const known = ['READ_ONLY', 'AGENT_REVOKED', 'AGENT_UNAVAILABLE', 'AGENT_CAPACITY', 'INVALID_OPS', 'collab-revision-changed', 'collab-receipt-conflict', 'collab-room-busy'];
      await d.audit(agentActor(standing.record), 'agent.tool-call', `session:${standing.record.sessionId}`, { ...requestAttribution, tool: ['read_document', 'apply_document_ops'].includes(String(params.name)) ? params.name : 'unknown', outcome: 'rejected', code: known.includes(code) ? code : 'EDIT_UNAVAILABLE' });
      reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: known.includes(code) ? code : 'EDIT_UNAVAILABLE', message: 'Read the document again before retrying. Your changes were not confirmed.' }) }] });
    }
  });
}
