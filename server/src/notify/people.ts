// SPDX-License-Identifier: MPL-2.0
/**
 * The one way a people notice leaves the server (plans/74 invite spec 2.10):
 * a request to its approvers, an answer to the person who asked, an accepted
 * invitation to the inviter, a welcome to the invitee. Routes build the
 * message (access/messages.ts) and hand it here; none of them writes these
 * kinds to the inbox itself, so switching email on later is a change in one
 * place.
 *
 * Today every notice goes to the inbox and nothing is emailed. Email needs
 * three things: `notify.people.email`, an SMTP relay in `notify.smtp`, and a
 * sender that reports whether the relay accepted the mail (`emailNow`, which
 * the plain notifier does not have yet). Until all three are there, `emailOn`
 * is false and `mail` answers 'off', so nothing that uses this seam can claim
 * an email was sent.
 */
import type { InstanceConfig } from '../config/instance.ts';
import type { Message } from '../inbox/target.ts';
import type { Store } from '../store/types.ts';
import type { Notifier } from './notify.ts';

/** Which notice a mail belongs to, for the per-kind caps email will bring. */
export type MailKind = 'invitation' | 'request' | 'answer' | 'accepted' | 'join-approved';
export interface MailParts { subject: string; text: string; fromName?: string }
export type MailResult = 'off' | 'sent' | 'held' | 'failed';

export interface PeopleNotifier {
  /** Whether notices are also emailed. */
  readonly emailOn: boolean;
  /** Put the message in the inbox of every account in `audience.users`, and
   *  also mail each one's verified address when `emailOn` and `mail` is given.
   *  A message that names nobody is dropped: a people notice is never
   *  broadcast. */
  tell(n: { message: Message; mail?: MailParts; kind: MailKind }): Promise<void>;
  /** Mail an address that has no account here (an invitee, a join
   *  requester). 'off' when `emailOn` is false. `sender` is the principal the
   *  mail is sent for, which the email caps count by. */
  mail(to: string, parts: MailParts, kind: MailKind, sender?: string): Promise<MailResult>;
}

/** A notifier that can say whether the relay took a mail. The plain one
 *  sends and forgets, so it cannot back an "Emailed" anywhere. */
type ConfirmingNotifier = Notifier & {
  emailNow?: (to: string, subject: string, text: string, fromName?: string) => Promise<boolean>;
};

export function createPeopleNotifier(d: { store: Store; config: InstanceConfig; notifier: Notifier }): PeopleNotifier {
  const { store, config } = d;
  const emailNow = (d.notifier as ConfirmingNotifier).emailNow;
  const emailOn = config.notify.people.email && !!config.notify.smtp && typeof emailNow === 'function';
  const fromName = config.notify.people.fromName ?? config.instance.name;

  const mail = async (to: string, parts: MailParts, _kind: MailKind, _sender?: string): Promise<MailResult> => {
    if (!emailOn || !emailNow) return 'off';
    if (!to.includes('@')) return 'failed';
    try {
      return (await emailNow(to, parts.subject, parts.text, parts.fromName ?? fromName)) ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  };

  /** The address to mail an account at: its own, and only when one of its
   *  sign-ins verified it. */
  const verifiedAddress = async (userId: string): Promise<string | null> => {
    const user = await store.getUser(userId);
    if (!user || user.disabledAt) return null;
    const email = user.email.trim().toLowerCase();
    const proven = (await store.listIdentities(user.id)).some((i) => i.emailVerified && i.email === email);
    return proven ? email : null;
  };

  return {
    emailOn,
    async tell(n) {
      const users = n.message.audience.users ?? [];
      // An empty `users` list means "no per-user filter" to the inbox, which
      // would show a personal notice to everyone.
      if (!users.length) return;
      await store.putMessage(n.message);
      if (!emailOn || !n.mail) return;
      for (const id of new Set(users)) {
        const to = await verifiedAddress(id);
        if (to) await mail(to, n.mail, n.kind);
      }
    },
    mail,
  };
}
