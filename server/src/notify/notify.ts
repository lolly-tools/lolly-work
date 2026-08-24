/**
 * Notification egress (plans/35 wave 1) - the seam that lets an approval,
 * review or broadcast reach someone who is NOT looking at the console.
 *
 * Two channels, both org-configured and both dormant by default (an absent
 * `notify` block means zero egress, byte-identical to before this existed):
 *
 *   smtp     - plain-text mail through the org's own relay (notify/smtp.ts).
 *   webhook  - one JSON POST per event to the org's own endpoint, signed
 *              `x-lolly-signature: sha256=<hmac(ts.body)>` with
 *              LW_WEBHOOK_SECRET so the receiver can refuse forgeries, plus
 *              `x-lolly-timestamp` so it can refuse replays. One retry.
 *
 * Neither is phone-home: both targets are the org talking to itself, named
 * in ITS config, reached only when ITS members act. Delivery is
 * fire-and-forget - a request must never fail or slow down because a relay
 * is sulking - with outcomes counted through `onResult` (the app wires it to
 * the lw_notify_total metric) and logged once per failure.
 */
import { createHmac } from 'node:crypto';
import type { InstanceConfig, Secrets } from '../config/instance.ts';
import { sendMail, type SmtpConnect } from './smtp.ts';

export interface Notifier {
  /** Send one plain-text mail. Empty/absent addresses are skipped silently;
   *  no SMTP configured means a no-op. Never throws, never blocks. */
  email(to: Array<string | undefined>, subject: string, text: string): void;
  /** Emit one webhook event. No webhook configured means a no-op. */
  event(kind: string, data: Record<string, unknown>): void;
  /** Settles when every send started so far has finished - tests only;
   *  request handlers never await this. */
  idle(): Promise<void>;
}

export interface NotifierDeps {
  config: InstanceConfig;
  secrets: Secrets;
  fetchImpl?: typeof fetch;
  /** Outcome counter hook (channel x sent|failed) - the metrics seam. */
  onResult?: (channel: 'smtp' | 'webhook', ok: boolean) => void;
  /** Test-only socket factory for the SMTP channel. */
  smtpConnect?: SmtpConnect;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { config, secrets, onResult } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const smtp = config.notify.smtp;
  const webhook = config.notify.webhook;
  const inflight = new Set<Promise<void>>();

  const track = (p: Promise<void>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const postEvent = async (kind: string, data: Record<string, unknown>): Promise<void> => {
    const body = JSON.stringify({ event: kind, at: new Date().toISOString(), instance: config.instance.name, data });
    const ts = String(Date.now());
    const sig = createHmac('sha256', secrets.webhook as string).update(`${ts}.${body}`).digest('hex');
    const headers = {
      'content-type': 'application/json',
      'x-lolly-timestamp': ts,
      'x-lolly-signature': `sha256=${sig}`,
    };
    // One retry after a beat - enough for a blip, never a queue.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl((webhook as { url: string }).url, { method: 'POST', headers, body });
        if (res.ok) { onResult?.('webhook', true); return; }
      } catch { /* fall through to the retry / failure count */ }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
    onResult?.('webhook', false);
    console.error(`notify: webhook delivery failed for ${kind}`);
  };

  return {
    email(to, subject, text) {
      if (!smtp) return;
      const rcpts = [...new Set(to.filter((a): a is string => typeof a === 'string' && a.includes('@')))];
      if (!rcpts.length) return;
      track(sendMail(smtp, secrets.smtpPassword, { to: rcpts, subject, text }, deps.smtpConnect)
        .then(() => onResult?.('smtp', true))
        .catch((e: Error) => {
          onResult?.('smtp', false);
          console.error(`notify: mail delivery failed (${subject}): ${e.message}`);
        }));
    },
    event(kind, data) {
      if (!webhook) return;
      track(postEvent(kind, data));
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
