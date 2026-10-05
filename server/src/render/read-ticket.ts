// SPDX-License-Identifier: MPL-2.0
/** A render may read its instance's catalog for five minutes, without a person's cookie. */
import type { IncomingMessage } from 'node:http';
import { mintToken, verifyToken } from '../iam/tokens.ts';
import type { UserRecord } from '../store/types.ts';

interface RenderRead { groups: string[]; revision: string }
export const mintRenderRead = (groups: string[], revision: string, secret: string) =>
  mintToken('lw/render-read', { groups, revision }, secret, 300);

export function renderReader(req: IncomingMessage, revision: string, secret: string | readonly string[]): UserRecord | null {
  const path = new URL(req.url ?? '/', 'http://local').pathname;
  if (!['GET', 'HEAD'].includes(req.method ?? '') || !/^(\/catalog\/|\/tools\/|\/api\/auth\/config$)/.test(path)) return null;
  const raw = req.headers['x-lw-render-read'];
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const ticket = verifyToken<RenderRead>('lw/render-read', raw, secret);
  if (!ticket || ticket.revision !== revision || !Array.isArray(ticket.groups)
    || ticket.groups.some(g => typeof g !== 'string')) return null;
  return { id: 'render-read', sub: 'render-read', email: '', groups: ticket.groups, idpGroups: ticket.groups,
    localGroups: [], role: 'member', sessionEpoch: 0, createdAt: '', lastSeenAt: '' };
}
