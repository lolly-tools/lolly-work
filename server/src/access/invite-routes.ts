// SPDX-License-Identifier: MPL-2.0
/**
 * Invite links and the sign-in requests (plans/74 invite spec 2.7 R1 to R3,
 * 2.9 and section 3; plans/75 J4):
 *
 *   GET  /l/invite/:token   the invite page, in the state the invitation is in
 *   POST /api/auth/invite   start a sign-in from it, set a password from it,
 *                           or join as the signed-in holder of the address
 *   POST /api/auth/request  ask to join, ask to use this account instead, or
 *                           withdraw either, from a page a sign-in rendered
 *
 * An invite token names an invitation and never admits anyone: the sign-in
 * that follows still has to prove the invited address (plans/75 4.8 rule
 * 1). The GET writes nothing, so a chat preview or a mail scanner that opens
 * the link changes nothing; the first POST start records that the link was
 * opened. Every POST here is a form from one of these pages, so it needs the
 * `lw_form` double submit, and the dispatch-wide Origin check runs on top.
 * A request's address always comes from an `lw/ask` token minted on the page
 * a verified sign-in rendered, never from a field.
 *
 * The sign-in steps themselves (the IdP redirect, the password forms, who
 * may stand behind a password link, accepting an invitation) stays in
 * api/app.ts and arrives here as closures in `InviteRoutesKit`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InstanceConfig } from '../config/instance.ts';
import { sendError, type createRouter } from '../api/router.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { MAX_PROJECT_NAME_CHARS, nameWithoutEmail } from '../projects/sharing.ts';
import type { InvitationProject, InvitationRecord, ProjectRecord, Store, UserRecord } from '../store/types.ts';
import { mintInviteToken, readInviteToken } from './invite-token.ts';
import {
  inviteAlreadyInHtml, inviteDeadHtml, inviteEndedHtml, inviteJoinHtml, inviteOtherAccountHtml, invitePageHtml, inviteUsedHtml,
  relativeTime, requestExpiredHtml, requestSentHtml, requestWithdrawnHtml, wrongAccountHtml,
  type InviteView, type SignInChoice, type SwitchAsk,
} from './pages.ts';
import { fileRequest, invitationLive, requestStateFor, retireRequestNotice } from './requests.ts';
import type { AskIdentity, AskTokenPayload, RequestDeps } from './types.ts';

/** The invitation a sign-in started from an invite page carries through the
 *  IdP, inside the signed `lw/state` box: invitation, project, link version. */
export interface InviteRef { i: string; p: string | null; v: number }

/** A sign-in the workspace offers (`idpProviders()` in api/app.ts). */
export interface ProviderEntry { id: string; name: string; kind: 'oidc' | 'github' | 'password' }

/** Who stands behind a password link: the operator, or an account. */
export type LinkIssuer = 'operator' | UserRecord;

/** What the routes need from api/app.ts. */
export interface InviteRoutesKit {
  store: Store;
  config: InstanceConfig;
  accessDeps: RequestDeps;
  audit: RequestDeps['audit'];
  /** Keys an invite token may be signed with (current, then previous), and
   *  the current one, which mints. */
  linkVerify: readonly string[];
  linkSecret: string;
  mintAsk(payload: AskTokenPayload): string;
  readAsk(token: string): AskTokenPayload | null;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  formToken(req: IncomingMessage): { nonce: string; cookie: string };
  formTokenOk(req: IncomingMessage, submitted: string | null): boolean;
  /** A form body (a missing field reads as ''), or null for anything that is not a form. */
  readForm(req: IncomingMessage): Promise<{ get(key: string): string } | null>;
  returnToSafe(raw: string | null): string;
  providers(): ProviderEntry[];
  /** An IdP's display name for an idp id. */
  idpLabel(idp: string): string;
  /** Start a sign-in through `idpId` that carries `invite` (R2 start): the
   *  IdP redirect, or the password form with the invited address masked. */
  startSignIn(req: IncomingMessage, res: ServerResponse, o: {
    idpId: string; returnTo: string; prompt: 'select_account' | null; invite: InviteRef; email: string;
  }): Promise<void>;
  /** Who stands behind the invite page's one-link password now, or null
   *  when it may not set one (invite spec 2.9 "One-link password"). */
  passwordSetupIssuer(inv: InvitationRecord, projectId: string | null): Promise<LinkIssuer | null>;
  /** Mint the one-time password link and answer with the set-password form. */
  renderInvitePasswordSet(req: IncomingMessage, res: ServerResponse, o: { invitation: InvitationRecord; issuer: LinkIssuer; returnTo: string }): Promise<void>;
  hasPassword(email: string): Promise<boolean>;
  acceptInvitationFor(user: UserRecord, inv: InvitationRecord, meta: { via: 'join' }): Promise<UserRecord>;
  accountsHoldingEmail(email: string): Promise<{ holders: UserRecord[] }>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
  now(): number;
}

/** What the sign-in callback renders through (the 403 and 200 wrong-account pages). */
export interface InvitePages {
  /** Reload the invitation a sign-in carried; null when it is gone,
   *  revoked, accepted, ended or on another link version. */
  liveInvitation(ref: InviteRef): Promise<InvitationRecord | null>;
  /** 403: the sign-in is not the invited account and is not admitted. */
  sendWrongAccount(req: IncomingMessage, res: ServerResponse, o: {
    ref: InviteRef; invitation: InvitationRecord; identity: AskIdentity; provider: string; github: boolean; extraCookies?: string[];
  }): Promise<void>;
  /** 200: signed in (now, or already) as an account that does not hold the address. */
  sendOtherAccount(req: IncomingMessage, res: ServerResponse, o: {
    ref: InviteRef; invitation: InvitationRecord; user: UserRecord; extraCookies?: string[];
  }): Promise<void>;
}

/**
 * The headers of every invite and request page (invite spec 3.1): no cache,
 * no index, `strict-origin` so a form keeps its Origin while the token in
 * the path never reaches a Referer, and a CSP with no script at all.
 */
export const INVITE_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

/** In-app browsers, where Google refuses to sign in (invite spec 3.2). */
const IN_APP_UA = /(FBAN|FBAV|Instagram|LinkedInApp|Line\/|Twitter|Snapchat|MicroMessenger|GSA\/|; wv\))/;
const IOS_UA = /\b(iPhone|iPad|iPod)\b/;
const inAppBrowser = (ua: string): boolean => IN_APP_UA.test(ua) || (IOS_UA.test(ua) && !ua.includes('Safari/'));
/** A label as it reads mid-sentence: "Email and password" becomes "email
 *  and password", while a name such as "SUSE ID" is left alone. */
const inSentence = (label: string): string => (/^[A-Z][a-z]/.test(label) ? `${label[0]!.toLowerCase()}${label.slice(1)}` : label);

/** One invitation entry as the pages see it. A link for a project the
 *  invitation no longer carries, or one since archived, reads as a
 *  workspace link (invite spec 2.9). */
interface InviteFacts {
  inv: InvitationRecord;
  entry: InvitationProject | null;
  project: ProjectRecord | null;
  inviterPrincipal: string;
  inviter: string | null;
}

export function registerInviteRoutes(router: ReturnType<typeof createRouter>, kit: InviteRoutesKit): InvitePages {
  const { store, config } = kit;
  const workspace = config.instance.name;

  const send = (res: ServerResponse, status: number, html: string, cookies: string[] = []): void => {
    res.writeHead(status, { ...INVITE_PAGE_HEADERS, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end(html);
  };
  const sendDead = (res: ServerResponse): void => send(res, 410, inviteDeadHtml(workspace));
  const sendExpired = (res: ServerResponse): void => send(res, 403, requestExpiredHtml(workspace));

  /** The invitation behind a token, or null for every kind of dead link. */
  const load = async (token: string): Promise<{ inv: InvitationRecord; projectId: string | null } | null> => {
    const ref = readInviteToken(token, kit.linkVerify);
    if (!ref) return null;
    const inv = await store.getInvitation(ref.invitationId);
    if (!inv || inv.revokedAt || inv.linkVersion !== ref.version) return null;
    return { inv, projectId: ref.projectId };
  };

  /** A person's name, never their address; null for a principal that is not an account. */
  const nameOf = async (principal: string): Promise<string | null> => {
    const user = principal.startsWith('user:') ? await store.getUser(principal.slice(5)) : null;
    return user ? nameWithoutEmail(user) : null;
  };

  const factsFor = async (inv: InvitationRecord, projectId: string | null): Promise<InviteFacts> => {
    const entry = projectId ? (inv.projects ?? []).find((p) => p.projectId === projectId) ?? null : null;
    const found = entry ? await store.getProject(entry.projectId) : null;
    const project = found && !found.archivedAt ? found : null;
    const inviterPrincipal = (project && entry?.invitedBy) || inv.invitedBy;
    return { inv, entry: project ? entry : null, project, inviterPrincipal, inviter: await nameOf(inviterPrincipal) };
  };

  const viewOf = (f: InviteFacts, token: string): InviteView => ({
    workspace, token, inviter: f.inviter,
    project: f.project && f.entry
      ? { name: Array.from(f.project.name).slice(0, MAX_PROJECT_NAME_CHARS).join(''), role: f.entry.role }
      : null,
    email: f.inv.email,
    ...(f.inv.expiresAt ? { expiresAt: f.inv.expiresAt } : {}),
    now: kit.now(),
  });

  /** Where the person goes once in: the project the link was for, or the
   *  app. A split deploy (`instance.appUrl`) serves the app elsewhere, so
   *  it goes to this instance's root there. */
  const landOf = (f: InviteFacts): string =>
    kit.returnToSafe(f.project && !config.instance.appUrl ? `/#/team/project/${encodeURIComponent(f.project.id)}` : '/');

  /** The token of the link a sign-in started from, minted again from what
   *  the state box carried, so "Other ways to sign in" opens the same page. */
  const tokenFor = (ref: InviteRef): string =>
    mintInviteToken({ invitationId: ref.i, projectId: ref.p, version: ref.v }, kit.linkSecret);

  /** The button for one sign-in: "Continue with Google", or "Sign in with
   *  email and password" for the password one. */
  const choiceOf = (p: ProviderEntry): SignInChoice => ({
    idp: p.id, label: p.kind === 'password' ? `Sign in with ${inSentence(p.name)}` : `Continue with ${p.name}`,
  });

  /** What an account has that this invitation would give: less access to
   *  the link's project, or (for a workspace link) a project or group it
   *  lacks. Only then is "use this account instead" worth asking. */
  const wouldGainFrom = async (user: UserRecord, f: InviteFacts): Promise<boolean> => {
    if (f.project && f.entry) return !accessAtLeast(await kit.projectAccessOf(user, f.project), f.entry.role);
    if (f.inv.groups.some((g) => !user.groups.includes(g))) return true;
    for (const e of f.inv.projects ?? []) {
      const project = await store.getProject(e.projectId);
      if (project && !project.archivedAt && !accessAtLeast(await kit.projectAccessOf(user, project), e.role)) return true;
    }
    return false;
  };

  /** The ask form's token and state for a switch request from `identity`. */
  const switchAsk = async (f: InviteFacts, identity: AskIdentity, csrf: string, userId?: string): Promise<SwitchAsk> => {
    const ask = kit.mintAsk({
      e: identity.email, idp: identity.idp, sub: identity.sub, ...(identity.name ? { n: identity.name } : {}),
      inv: f.inv.id, ...(f.project ? { p: f.project.id } : {}), ...(userId ? { u: userId } : {}),
    });
    const state = await requestStateFor(kit.accessDeps, { kind: 'switch', email: identity.email, invitationId: f.inv.id });
    return {
      ask, csrf,
      ...(state.open ? { askedAgo: relativeTime(state.open.createdAt, kit.now()) } : {}),
      ...(state.lastDeclined ? { declined: true } : {}),
    };
  };

  /** The identity a signed-in account asks with: its own address and the sign-in it was made with. */
  const accountIdentity = async (user: UserRecord): Promise<AskIdentity> => {
    const own = (await store.listIdentities(user.id)).find((i) => i.identitySub === user.sub);
    const name = [user.firstname, user.lastname].filter(Boolean).join(' ');
    return { email: user.email.trim().toLowerCase(), idp: own?.idp ?? 'primary', sub: user.sub, ...(name ? { name } : {}) };
  };

  const otherAccountPage = async (req: IncomingMessage, f: InviteFacts, token: string, user: UserRecord): Promise<{ html: string; cookie: string }> => {
    const { nonce, cookie } = kit.formToken(req);
    const mayAsk = f.inviterPrincipal !== `user:${user.id}` && await wouldGainFrom(user, f);
    const ask = mayAsk ? await switchAsk(f, await accountIdentity(user), nonce, user.id) : null;
    const html = inviteOtherAccountHtml(viewOf(f, token), {
      csrf: nonce, signedInAs: user.email, ask,
      choices: kit.providers().map(choiceOf),
    });
    return { html, cookie };
  };

  /**
   * The page for an invitation in whatever state it is now (invite spec 2.9,
   * "The invite page decides its state in this order"). Reads only: the
   * form cookie it may set is the one write, and it is not stored.
   */
  const renderState = async (
    req: IncomingMessage, res: ServerResponse, inv: InvitationRecord, projectId: string | null, token: string,
    opts: { status?: number; error?: 'password' | 'expired' } = {},
  ): Promise<void> => {
    const now = kit.now();
    const f = await factsFor(inv, projectId);
    const v = viewOf(f, token);
    const user = await kit.memberOf(req);
    const land = landOf(f);
    if (inv.acceptedAt) {
      if (user && user.id === inv.acceptedUserId) return send(res, 200, inviteAlreadyInHtml(v, { openHref: land }));
      return send(res, 200, inviteUsedHtml(v, { signInHref: `/api/auth/login?returnTo=${encodeURIComponent(land)}` }));
    }
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= now) return send(res, 410, inviteEndedHtml({ ...v, expiresAt: inv.expiresAt }));
    if (user) {
      const { holders } = await kit.accountsHoldingEmail(inv.email);
      if (holders.some((h) => h.id === user.id)) {
        const { nonce, cookie } = kit.formToken(req);
        return send(res, opts.status ?? 200, inviteJoinHtml(v, { csrf: nonce, signedInAs: user.email }), [cookie]);
      }
      const page = await otherAccountPage(req, f, token, user);
      return send(res, opts.status ?? 200, page.html, [page.cookie]);
    }
    const { nonce, cookie } = kit.formToken(req);
    const providers = kit.providers();
    const password = providers.find((p) => p.kind === 'password');
    const hasPassword = !!password && await kit.hasPassword(inv.email);
    const passwordSetup = !!password && !hasPassword && !!(await kit.passwordSetupIssuer(inv, f.project?.id ?? null));
    const ua = String(req.headers['user-agent'] ?? '');
    send(res, opts.status ?? 200, invitePageHtml(v, {
      csrf: nonce,
      choices: providers.filter((p) => p.kind !== 'password').map(choiceOf),
      passwordSetup,
      passwordSignIn: password && hasPassword ? choiceOf(password) : null,
      github: providers.some((p) => p.kind === 'github'),
      ...(config.instance.inviteNote ? { inviteNote: config.instance.inviteNote } : {}),
      ...(inAppBrowser(ua) ? { inAppUrl: `${config.instance.baseUrl.replace(/\/+$/, '')}/l/invite/${token}` } : {}),
      ...(opts.error ? { error: opts.error } : {}),
    }), [cookie]);
  };

  /** The first start from the page records that the link was opened, once. */
  const markOpened = async (inv: InvitationRecord, meta: { provider: string; idp?: string }): Promise<void> => {
    if (await store.markInvitationOpened(inv.id, new Date(kit.now()).toISOString())) {
      await kit.audit('anonymous', 'invite.open', `invitation:${inv.id}`, { provider: meta.provider, ...(meta.idp ? { idp: meta.idp } : {}) });
    }
  };

  // R1. Never writes: a link preview or a mail scanner opens this too.
  router.add('GET', '/l/invite/:token', async (req, res, ctx) => {
    const token = ctx.params.token ?? '';
    const loaded = await load(token);
    if (!loaded) return sendDead(res);
    await renderState(req, res, loaded.inv, loaded.projectId, token);
  });

  // R2.
  router.add('POST', '/api/auth/invite', async (req, res) => {
    const form = await kit.readForm(req);
    if (!form) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the form');
    const token = form.get('token');
    const loaded = await load(token);
    if (!loaded) return sendDead(res);
    const { inv, projectId } = loaded;
    if (!kit.formTokenOk(req, form.get('csrf'))) return renderState(req, res, inv, projectId, token, { status: 403, error: 'expired' });
    // Accepted or ended since the page was drawn: the page for that state.
    if (!invitationLive(inv, kit.now())) return renderState(req, res, inv, projectId, token);
    const f = await factsFor(inv, projectId);
    const land = landOf(f);
    const action = form.get('action');

    if (action === 'start') {
      const choice = kit.providers().find((p) => p.id === form.get('idp'));
      if (!choice) return renderState(req, res, inv, projectId, token);
      await markOpened(inv, { provider: choice.kind, idp: choice.id });
      return kit.startSignIn(req, res, {
        idpId: choice.id, returnTo: land, prompt: form.get('prompt') === 'select_account' ? 'select_account' : null,
        invite: { i: inv.id, p: f.project?.id ?? null, v: inv.linkVersion }, email: inv.email,
      });
    }
    if (action === 'password') {
      const issuer = await kit.passwordSetupIssuer(inv, f.project?.id ?? null);
      if (!issuer) return renderState(req, res, inv, projectId, token, { error: 'password' });
      const password = kit.providers().find((p) => p.kind === 'password');
      await markOpened(inv, { provider: 'password', ...(password ? { idp: password.id } : {}) });
      return kit.renderInvitePasswordSet(req, res, { invitation: inv, issuer, returnTo: land });
    }
    if (action === 'join') {
      const user = await kit.memberOf(req);
      const { holders } = user ? await kit.accountsHoldingEmail(inv.email) : { holders: [] };
      // Signed out, or not the holder: the page for who the person is now.
      if (!user || !holders.some((h) => h.id === user.id)) return renderState(req, res, inv, projectId, token);
      await markOpened(inv, { provider: 'session' });
      await kit.acceptInvitationFor(user, inv, { via: 'join' });
      res.writeHead(303, { location: land, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return;
    }
    return renderState(req, res, inv, projectId, token);
  });

  // R3. The address is the ask token's, never a field: an `email` in the
  // form is not read.
  router.add('POST', '/api/auth/request', async (req, res) => {
    const form = await kit.readForm(req);
    if (!form) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the form');
    const ask = kit.readAsk(form.get('ask'));
    if (!ask || !kit.formTokenOk(req, form.get('csrf'))) return sendExpired(res);
    // A token minted for a signed-in account is good only in that account's session.
    if (ask.u && (await kit.memberOf(req))?.id !== ask.u) return sendExpired(res);
    const identity: AskIdentity = { email: ask.e, idp: ask.idp, sub: ask.sub, ...(ask.n ? { name: ask.n } : {}) };
    const action = form.get('action');
    const note = form.get('note');
    const d = kit.accessDeps;

    if (action === 'withdraw') {
      const kind = ask.inv ? 'switch' : 'join';
      const { open } = await requestStateFor(d, { kind, email: ask.e, ...(ask.inv ? { invitationId: ask.inv } : {}) });
      if (open) {
        const at = new Date(kit.now()).toISOString();
        const actor = ask.u ? `user:${ask.u}` : 'anonymous';
        const done = await store.answerAccessRequest(open.id, { status: 'withdrawn', at, by: actor }, at);
        if (done) {
          await retireRequestNotice(d, done);
          await kit.audit(actor, 'access.withdraw', `request:${done.id}`, { kind: done.kind });
        }
      }
      return send(res, 200, requestWithdrawnHtml(workspace));
    }
    if (action === 'join' && !ask.inv) {
      // The page hides the form for a week after a decline
      // (`requestStateFor` reports one that recent); a post that comes
      // anyway files nothing and reads the same.
      const state = await requestStateFor(d, { kind: 'join', email: ask.e });
      if (!state.lastDeclined) await fileRequest(d, { kind: 'join', identity, ...(note ? { note } : {}) });
      return send(res, 200, requestSentHtml(workspace, { kind: 'join', email: ask.e, emailOn: d.people.emailOn }));
    }
    if (action === 'switch' && ask.inv) {
      const state = await requestStateFor(d, { kind: 'switch', email: ask.e, invitationId: ask.inv });
      if (!state.lastDeclined) {
        await fileRequest(d, {
          kind: 'switch', identity, invitationId: ask.inv,
          ...(ask.p ? { projectId: ask.p } : {}), ...(ask.u ? { userId: ask.u } : {}), ...(note ? { note } : {}),
        });
      }
      const inv = await store.getInvitation(ask.inv);
      const f = inv ? await factsFor(inv, ask.p ?? null) : null;
      return send(res, 200, requestSentHtml(workspace, { kind: 'switch', email: ask.e, inviter: f?.inviter ?? null, signedIn: !!ask.u }));
    }
    return sendExpired(res);
  });

  return {
    async liveInvitation(ref) {
      const inv = await store.getInvitation(ref.i);
      return inv && !inv.revokedAt && inv.linkVersion === ref.v && invitationLive(inv, kit.now()) ? inv : null;
    },
    async sendWrongAccount(req, res, o) {
      const f = await factsFor(o.invitation, o.ref.p);
      const { nonce, cookie } = kit.formToken(req);
      const token = tokenFor(o.ref);
      send(res, 403, wrongAccountHtml(viewOf(f, token), {
        csrf: nonce, signedInAs: o.identity.email, provider: o.provider, idp: o.identity.idp, github: o.github,
        ask: await switchAsk(f, o.identity, nonce),
      }), [...(o.extraCookies ?? []), cookie]);
    },
    async sendOtherAccount(req, res, o) {
      const f = await factsFor(o.invitation, o.ref.p);
      const page = await otherAccountPage(req, f, tokenFor(o.ref), o.user);
      send(res, 200, page.html, [...(o.extraCookies ?? []), page.cookie]);
    },
  };
}
