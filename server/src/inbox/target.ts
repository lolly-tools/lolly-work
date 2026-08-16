/**
 * Message bridge audience targeting (plans/10 §2): groups × engine-version
 * range × shell selectors decide who sees a message. Version comparison is
 * plain dotted-numeric (engine versions are simple semver-shaped strings).
 */

export interface Audience {
  groups?: string[]; // '*' wildcard
  minEngine?: string | null;
  maxEngine?: string | null;
  shells?: string[];
  /** When set, an additional selector: only these user ids match (ANDs with the rest). */
  users?: string[];
}

export interface Message {
  id: string;
  /** `announcement`/`upgrade`/`policy` are composed in the console; the rest are
   *  system-generated on the same pipe - `approval`/`expiry` from plans/05/06,
   *  `collab` from a live-room invite (plans/14 §6, OSS plans/100 §7 item 9). */
  kind: 'announcement' | 'upgrade' | 'policy' | 'approval' | 'expiry' | 'collab';
  severity: 'info' | 'action' | 'blocking';
  audience: Audience;
  title: string;
  body?: string;
  cta?: { label: string; url: string };
  /**
   * Machine-readable payload for a system-generated message, so a client can act
   * on it rather than parse the copy - e.g. a collab invite's `sessionId`, from
   * which the shell builds its own deep link (the server has no shell route to
   * bake in). String values only: this is a routing hint, never a document.
   */
  data?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  dismissible?: boolean;
}

export interface ClientCtx {
  groups: string[];
  shell?: string;
  engineVersion?: string;
  userId?: string;
}

/** Compare dotted numeric versions: -1 | 0 | 1. Missing segments are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function audienceMatches(audience: Audience, client: ClientCtx): boolean {
  const groups = audience.groups ?? ['*'];
  if (!groups.includes('*') && !groups.some((g) => client.groups.includes(g))) return false;
  // Per-user targeting (e.g. an approval routed to its nominees): narrows further.
  if (audience.users?.length && (!client.userId || !audience.users.includes(client.userId))) return false;
  if (audience.shells?.length && (!client.shell || !audience.shells.includes(client.shell))) return false;
  if (audience.minEngine || audience.maxEngine) {
    // Version-scoped messages only reach clients whose version we can see.
    if (!client.engineVersion) return false;
    if (audience.minEngine && compareVersions(client.engineVersion, audience.minEngine) < 0) return false;
    if (audience.maxEngine && compareVersions(client.engineVersion, audience.maxEngine) > 0) return false;
  }
  return true;
}

/** A message is live between startsAt and endsAt (both optional). */
export function messageLive(msg: Message, now = new Date()): boolean {
  const t = now.getTime();
  if (msg.startsAt && Date.parse(msg.startsAt) > t) return false;
  if (msg.endsAt && Date.parse(msg.endsAt) < t) return false;
  return true;
}

export function targetedMessages(messages: Message[], client: ClientCtx, acked: Set<string>, now = new Date()): Message[] {
  return messages.filter((m) => messageLive(m, now) && !acked.has(m.id) && audienceMatches(m.audience, client));
}
