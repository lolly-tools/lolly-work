// SPDX-License-Identifier: MPL-2.0
/**
 * Shared types for access requests and invite links (plans/74 invite spec
 * 2.6 to 2.9). The requests core (requests.ts), the server pages, the
 * request routes and the invitation routes all speak these, so each lives
 * here once. Types only.
 */
import type { InstanceConfig } from '../config/instance.ts';
import type { PeopleNotifier } from '../notify/people.ts';
import type { ProjectAccess } from '../rbac/project-access.ts';
import type {
  AccessRequestKind, AccessRequestRecord, AccessRequestStatus, ProjectMemberRole, Store, UserRecord,
} from '../store/types.ts';

/** What every function in requests.ts takes. `app.ts` builds one, `accessDeps`. */
export interface RequestDeps {
  store: Store;
  config: InstanceConfig;
  /** The app's audit writer: actor, action, subject, payload. */
  audit: (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;
  people: PeopleNotifier;
  /** Milliseconds since the epoch; tests pass a fixed clock. */
  now: () => number;
}

/** A sign-in the server just verified, for someone with no account here yet. */
export interface AskIdentity {
  /** Verified; lowercased on the way in. */
  email: string;
  /** The idp id ('primary', 'github', 'email', ...). */
  idp: string;
  /** The namespaced subject that proved the address. */
  sub: string;
  /** Display name from the sign-in. */
  name?: string;
}

/**
 * The payload of an `lw/ask` token: the identity a sign-in just verified,
 * minted only on the page rendered right after that sign-in (the refusal page
 * and the wrong-account page) and carried in a hidden form field, never in a
 * URL or a cookie. `mintToken('lw/ask', payload, secrets.session, 1800)`.
 */
export interface AskTokenPayload {
  /** Verified email, lowercased. */
  e: string;
  idp: string;
  sub: string;
  /** Display name. */
  n?: string;
  /** switch: the invitation whose link was used. */
  inv?: string;
  /** switch: the project the link was made for. */
  p?: string;
  /** switch: the account already signed in, when there is one. */
  u?: string;
}

/** What `fileRequest` takes, per kind. */
export type FileInput =
  | {
    kind: 'project'; user: UserRecord; projectId: string; viaSessionId?: string;
    role: 'viewer' | 'commenter' | 'editor'; note?: string; currentRole: ProjectAccess;
  }
  | { kind: 'join'; identity: AskIdentity; note?: string }
  | { kind: 'switch'; identity: AskIdentity; invitationId: string; projectId?: string; userId?: string; note?: string };

/**
 * What filing came to. `created`: a new open request. `exists`: one was
 * already open for the same key. `held`: a cap stopped it (audited, nothing
 * stored). `skipped`: nothing to ask for (requests off, an unknown or
 * archived project, access already at that level, an invitation that ended).
 * Every outcome looks the same to the person filing.
 */
export type FileOutcome = { outcome: 'created' | 'exists' | 'held' | 'skipped'; request?: AccessRequestRecord };

/** A request as an approver sees it (R10 to R12). */
export interface RequestView {
  id: string;
  kind: AccessRequestKind;
  status: AccessRequestStatus;
  email: string;
  name: string | null;
  /** The IdP's display name. */
  provider: string | null;
  note: string | null;
  role: ProjectMemberRole | null;
  currentRole: ProjectAccess | null;
  project: { id: string; name: string } | null;
  session: { id: string; name: string | null } | null;
  /** switch only. */
  invitation: { id: string; maskedEmail: string; inviter: string | null } | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  answeredBy: { name: string } | null;
  answerRole: ProjectMemberRole | null;
}

/** A request as the person who filed it sees it (R8, R9). */
export interface MyRequest {
  id: string;
  status: AccessRequestStatus;
  role: ProjectMemberRole | null;
  createdAt: string;
  answeredAt: string | null;
  answerRole: ProjectMemberRole | null;
}

/** An open project request on the project's people panel (R17, managers only). */
export interface ProjectRequestWire {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'viewer' | 'editor';
  currentRole: ProjectAccess;
  note?: string;
  createdAt: string;
  viaSession?: { id: string; name: string | null };
}
