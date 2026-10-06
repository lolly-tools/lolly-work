// SPDX-License-Identifier: MPL-2.0
/** Trusted internal calls reuse project handlers without granting the bearer access to REST. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import type { createRouter } from '../api/router.ts';
import type { ProjectAgentRecord, UserRecord } from '../store/types.ts';

export interface AgentSessionCreation { agentId: string; requestId: string; digest: string; sessionId: string }
export type ProjectRequestRunner = (user: UserRecord, method: 'GET' | 'POST' | 'PUT', path: string,
  body?: Record<string, unknown> | Buffer, creation?: AgentSessionCreation, agent?: ProjectAgentRecord) => Promise<Record<string, unknown>>;

class ResponseCapture extends Writable {
  statusCode = 200;
  headersSent = false;
  readonly chunks: Buffer[] = [];
  private bytes = 0;
  private readonly headers = new Map<string, unknown>();
  writeHead(status: number, headers: Record<string, unknown> = {}) { this.statusCode = status; this.headersSent = true; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); return this; }
  setHeader(key: string, value: unknown) { this.headers.set(key.toLowerCase(), value); return this; }
  getHeader(key: string) { return this.headers.get(key.toLowerCase()); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.bytes += chunk.length;
    if (this.bytes > 4 * 1024 * 1024) { done(new Error('PROJECT_RESPONSE_TOO_LARGE')); return; }
    this.chunks.push(Buffer.from(chunk)); done();
  }
}

export function createProjectRequests(router: ReturnType<typeof createRouter>) {
  const context = new AsyncLocalStorage<ProjectAgentRecord>();
  const principals = new WeakMap<IncomingMessage, { userId: string; creation?: AgentSessionCreation; agent?: ProjectAgentRecord }>();
  const run: ProjectRequestRunner = async (user, method, path, body, creation, agent) => {
    const req = new IncomingMessage(new Socket()); req.method = method; req.url = path;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ? JSON.stringify(body) : '');
    req.headers = { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': String(bytes.length) };
    req.push(bytes); req.push(null);
    principals.set(req, { userId: user.id, ...(creation ? { creation } : {}), ...(agent ? { agent } : {}) });
    const res = new ResponseCapture();
    const completed = new Promise<void>((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
    void completed.catch(() => {});
    try {
      const dispatch = () => router.dispatch(req, res as unknown as ServerResponse);
      const route = await (agent ? context.run(agent, dispatch) : dispatch());
      if (!route) throw new Error('PROJECT_TOOL_UNAVAILABLE');
      await completed;
      const text = Buffer.concat(res.chunks).toString('utf8');
      const value = text ? JSON.parse(text) as Record<string, unknown> : { ok: true };
      if (res.statusCode >= 400) {
        const error = value.error as { code?: string; message?: string } | undefined;
        throw Object.assign(new Error(error?.code ?? 'PROJECT_REQUEST_FAILED'), { detail: error?.message, status: res.statusCode });
      }
      return value;
    } finally { principals.delete(req); req.destroy(); res.destroy(); }
  };
  return { run, attribution: () => context.getStore(), principal: (req: IncomingMessage) => principals.get(req) };
}
