// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { actionLink, esc, postForm, serverPage } from '../iam/activate-page.ts';
import { checkLink, linkPath, type LinkRecord } from '../links/sign.ts';
import { randomId } from '../lib/crypto.ts';
import { mayInviteNewPeople, resolveInvitePolicy } from '../policy/invites.ts';
import { createWindowQuota, nameWithoutEmail } from '../projects/sharing.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import type { Grant } from '../rbac/evaluate.ts';
import type { ProjectRecord, Store, UserRecord } from '../store/types.ts';
import { INVITE_PAGE_HEADERS } from './invite-routes.ts';
import { invitePageUrl, mintInviteToken } from './invite-token.ts';
import type { IssueInvitationInput, IssueInvitationResult, ShareActor } from './routes.ts';

interface InviteLinksKit {
  store: Store;
  config: InstanceConfig;
  linkSecret: string;
  linkVerify: readonly string[];
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  projectGate(req: IncomingMessage, res: ServerResponse, id: string, min: ProjectAccess): Promise<{ user: UserRecord; project: ProjectRecord; grants: Grant[] } | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord, grants?: Grant[]): Promise<ProjectAccess>;
  shareProjectWith(project: ProjectRecord, user: UserRecord, role: 'viewer' | 'editor', actor: ShareActor, via: 'invite'): Promise<'added' | 'already'>;
  issueInvitation(actor: UserRecord, input: IssueInvitationInput): Promise<IssueInvitationResult>;
  formToken(req: IncomingMessage): { nonce: string; cookie: string };
  formTokenOk(req: IncomingMessage, token: string | null): boolean;
  readForm(req: IncomingMessage): Promise<{ get(key: string): string } | null>;
  audit(principal: string, action: string, resource: string, detail: Record<string, unknown>): Promise<unknown>;
}

/** Reusable project capabilities require fresh issuer authority on every use. GET never joins anyone. */
export function registerProjectInviteLinks(router: ReturnType<typeof createRouter>, kit: InviteLinksKit): void {
  const { store, config } = kit;
  const mintQuota = createWindowQuota(50, 86_400_000), emailQuota = createWindowQuota(50, 3_600_000);
  const policy = () => resolveInvitePolicy(config.policy.invites);
  const canAdmit = (user: UserRecord, grants: Grant[]) => config.idp.admission?.invitations !== false && mayInviteNewPeople(user, grants, policy());
  const wire = (link: LinkRecord) => ({ id: link.id, role: link.target.projectInvite!.role, allowNewPeople: link.target.projectInvite!.allowNewPeople,
    url: `${config.instance.baseUrl.replace(/\/+$/, '')}${linkPath(link, kit.linkSecret)}`, expiresAt: new Date(link.exp * 1000).toISOString() });
  async function load(id: string, sig: string) {
    const link = await store.getLink(id), target = link?.target.projectInvite;
    if (!link || link.kind !== 'project-invite' || !target || checkLink(link, sig, kit.linkVerify) !== 'ok') return null;
    const project = await store.getProject(target.projectId), issuer = await store.getUser(link.createdBy), grants = await store.listGrants();
    if (!project || project.archivedAt || !issuer || issuer.disabledAt || !policy().projectRoles.includes(target.role)
      || !accessAtLeast(await kit.projectAccessOf(issuer, project, grants), 'manager')) return null;
    if (link.target.sessionId) {
      const session = await store.getSession(link.target.sessionId);
      if (!session || session.deletedAt || session.projectId !== project.id) return null;
    }
    return { link, target, project, issuer, allowNew: target.allowNewPeople && canAdmit(issuer, grants) };
  }
  router.add('POST', '/api/v1/projects/:id/invite-links', async (req, res, ctx) => {
    const gate = await kit.projectGate(req, res, ctx.params.id!, 'manager'); if (!gate) return;
    if (gate.project.archivedAt) return sendError(res, 409, 'PROJECT_ARCHIVED', 'restore the project first');
    const body = await readJson(req) as { role?: unknown; sessionId?: unknown } | null;
    if (body?.role !== 'editor' && body?.role !== 'viewer') return sendError(res, 400, 'INVALID_INPUT', 'choose editor or viewer');
    const role = body.role;
    if (!policy().projectRoles.includes(role)) return sendError(res, 403, 'ROLE_NOT_ALLOWED', 'this role is unavailable');
    if (body.sessionId !== undefined && typeof body.sessionId !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'sessionId must be a document id');
    const sessionId = body.sessionId;
    if (sessionId) {
      const session = await store.getSession(sessionId);
      if (!session || session.deletedAt || session.projectId !== gate.project.id) return sendError(res, 404, 'NOT_FOUND', 'no document on this project');
    }
    const allowNewPeople = canAdmit(gate.user, gate.grants);
    const old = (await store.listLinksBy(gate.user.id)).find(link => link.kind === 'project-invite' && !link.revokedAt
      && link.exp * 1000 > Date.now() && link.target.sessionId === sessionId && link.target.projectInvite?.projectId === gate.project.id
      && link.target.projectInvite.role === role && link.target.projectInvite.allowNewPeople === allowNewPeople);
    if (old) return sendJson(res, 200, wire(old));
    if (!mintQuota.take(gate.user.id)) return sendError(res, 429, 'RATE_LIMITED', 'try again tomorrow');
    const now = Date.now(), link: LinkRecord = { id: `lnk_${randomId(10)}`, kind: 'project-invite', createdBy: gate.user.id, createdAt: new Date(now).toISOString(),
      exp: Math.floor(now / 1000 + Math.min(7 * 24, policy().maxTtlHours) * 3600),
      target: { projectInvite: { projectId: gate.project.id, role, allowNewPeople }, ...(sessionId ? { sessionId } : {}) } };
    await store.putLink(link); await kit.audit(`user:${gate.user.id}`, 'project.invite-link.create', `project:${gate.project.id}`, { linkId: link.id, role, allowNewPeople, ...(sessionId ? { sessionId } : {}) });
    sendJson(res, 201, wire(link));
  });
  router.add('GET', '/api/v1/projects/:id/invite-links', async (req, res, ctx) => {
    const gate = await kit.projectGate(req, res, ctx.params.id!, 'manager'); if (!gate) return;
    const links = (await store.listAllLinks()).filter(link => link.kind === 'project-invite' && link.target.projectInvite?.projectId === gate.project.id);
    const active = await Promise.all(links.map(link => load(link.id, new URL(wire(link).url).searchParams.get('s')!)));
    sendJson(res, 200, { links: active.filter(value => value !== null).map(value => wire(value.link)) });
  });
  router.add('DELETE', '/api/v1/projects/:id/invite-links/:link', async (req, res, ctx) => {
    const gate = await kit.projectGate(req, res, ctx.params.id!, 'manager'); if (!gate) return;
    const link = await store.getLink(ctx.params.link!);
    if (!link || link.kind !== 'project-invite' || link.target.projectInvite?.projectId !== gate.project.id) return sendError(res, 404, 'NOT_FOUND', 'no invitation link on this project');
    await store.revokeLink(link.id, new Date().toISOString());
    await kit.audit(`user:${gate.user.id}`, 'project.invite-link.revoke', `project:${gate.project.id}`, { linkId: link.id });
    res.writeHead(204); res.end();
  });
  const send = (res: ServerResponse, status: number, heading: string, body: string, cookies: string[] = []) => {
    res.writeHead(status, { ...INVITE_PAGE_HEADERS, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end(serverPage(config.instance.name, `<div class="card">${body}</div>`, heading, { title: `Invitation to ${config.instance.name}` }));
  };
  const dead = (res: ServerResponse) => send(res, 410, 'This invitation link no longer works', '<p>Ask the project team for a new invitation link.</p>');
  const destination = (value: NonNullable<Awaited<ReturnType<typeof load>>>) =>
    `${config.instance.appUrl?.replace(/\/+$/, '') ?? ''}/#/team/${value.link.target.sessionId ? encodeURIComponent(value.link.target.sessionId) : `project/${encodeURIComponent(value.project.id)}`}`;
  router.add('GET', '/l/join/:id', async (req, res, ctx) => {
    const sig = ctx.url.searchParams.get('s') ?? '', value = await load(ctx.params.id!, sig); if (!value) return dead(res);
    const user = await kit.memberOf(req), { nonce, cookie } = kit.formToken(req);
    const fields = { id: value.link.id, sig, csrf: nonce };
    const intro = `<p>${esc(nameWithoutEmail(value.issuer))} invited you to ${esc(value.project.name)} as ${value.target.role === 'editor' ? 'an editor' : 'a viewer'}.</p>`;
    if (user) {
      const already = accessAtLeast(await kit.projectAccessOf(user, value.project), value.target.role);
      return send(res, 200, `Join ${value.project.name}`, intro + (already ? actionLink(destination(value), 'Open project')
        : postForm({ action: '/api/auth/project-link', fields: { ...fields, action: 'join' }, label: 'Join project', primary: true })), [cookie]);
    }
    const back = linkPath(value.link, kit.linkSecret);
    let body = intro + actionLink(`/api/auth/login?returnTo=${encodeURIComponent(back)}`, 'Sign in to join');
    if (value.allowNew) body += '<p>New to this workspace? Enter your email to continue to your invitation.</p>' + postForm({ action: '/api/auth/project-link', fields: { ...fields, action: 'new' }, label: 'Continue',
      extra: '<label class="field" for="join-email">Email address</label><input class="field" id="join-email" name="email" type="email" maxlength="254" autocomplete="email" required>' });
    else body += '<p>This link is for people who already have a workspace account.</p>';
    send(res, 200, `Join ${value.project.name}`, body, [cookie]);
  });
  router.add('POST', '/api/auth/project-link', async (req, res) => {
    const form = await kit.readForm(req); if (!form) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the form');
    if (!kit.formTokenOk(req, form.get('csrf'))) return sendError(res, 403, 'FORM_EXPIRED', 'open the invitation link again');
    const value = await load(form.get('id'), form.get('sig')); if (!value) return dead(res);
    const user = await kit.memberOf(req);
    if (form.get('action') === 'join' && user) {
      await kit.shareProjectWith(value.project, user, value.target.role, { principal: `user:${value.issuer.id}`, userId: value.issuer.id, name: nameWithoutEmail(value.issuer) }, 'invite');
      await kit.audit(`user:${user.id}`, 'project.invite-link.accept', `project:${value.project.id}`, { linkId: value.link.id, role: value.target.role });
      res.writeHead(303, { location: destination(value), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
    }
    if (form.get('action') !== 'new' || user || !value.allowNew) return sendError(res, 403, 'FORBIDDEN', 'sign in to join this project');
    const email = form.get('email').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'INVALID_INPUT', 'enter an email address');
    if (!emailQuota.take(value.link.id)) return sendError(res, 429, 'RATE_LIMITED', 'try again later');
    const issued = await kit.issueInvitation(value.issuer, { email, groups: [], projects: [{ projectId: value.project.id, role: value.target.role, invitedBy: `user:${value.issuer.id}` }],
      createdVia: 'project', expiresAt: new Date(value.link.exp * 1000).toISOString() });
    if (issued.status === 'refused') return send(res, 403, 'This account cannot join through this link', '<p>Ask the project team for a personal invitation.</p>');
    if (issued.status === 'already-member' || issued.invitation.acceptedAt || issued.invitation.revokedAt) return send(res, 200, 'Sign in to join', actionLink(`/api/auth/login?returnTo=${encodeURIComponent(linkPath(value.link, kit.linkSecret))}`, 'Sign in'));
    const token = mintInviteToken({ invitationId: issued.invitation.id, projectId: value.project.id, version: issued.invitation.linkVersion,
      ...(value.link.target.sessionId ? { sessionId: value.link.target.sessionId } : {}) }, kit.linkSecret);
    res.writeHead(303, { location: invitePageUrl(config.instance.baseUrl, token), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
  });
}
