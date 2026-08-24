/**
 * SIEM forwarding (plans/35 wave 2) - the audit log, pushed.
 *
 * The design leans on what the audit table already is: append-only rows with
 * seq numbers. That makes it the outbox, and forwarding needs exactly one
 * durable fact - the highest seq the receiver confirmed (siem_cursor,
 * migration 0024). Each tick reads past the cursor, POSTs one signed batch,
 * and advances the cursor only on a 2xx: a crash, a deploy or an unreachable
 * receiver replays from the cursor instead of dropping events, and delivery
 * lag is always computable (head seq minus cursor - the lw_siem_lag gauge).
 *
 * Signing is the notify-webhook scheme: `x-lolly-signature:
 * sha256=<hmac(timestamp.body)>` under LW_SIEM_SECRET plus an
 * `x-lolly-timestamp` header, so the receiver refuses forgeries and replays.
 *
 * Runs on the long-lived server only (main.ts starts it - the audit-headLog
 * interval pattern). A serverless deploy has no place to keep the loop; there,
 * a service token polling `GET /api/v1/audit` is the supported path, and the
 * growing lag gauge says so out loud.
 */
import { createHmac } from 'node:crypto';
import type { InstanceConfig, Secrets } from '../config/instance.ts';
import type { Store } from '../store/types.ts';

export interface SiemForwarder {
  /** Forward one batch. Resolves with how many events were delivered (0 =
   *  nothing pending, or the receiver refused - the cursor tells which). */
  tick(): Promise<number>;
  /** Start the interval loop; returns the stop function. */
  start(): () => void;
}

export interface SiemDeps {
  config: InstanceConfig;
  secrets: Secrets;
  store: Store;
  fetchImpl?: typeof fetch;
  onResult?: (ok: boolean, count: number) => void;
}

export function createSiemForwarder(deps: SiemDeps): SiemForwarder {
  const { config, secrets, store, onResult } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = config.siem.url;
  if (!url) throw new Error('createSiemForwarder called without siem.url - the caller gates on it');
  if (!secrets.siem) throw new Error('siem.url is configured but LW_SIEM_SECRET is not set');
  const secret = secrets.siem;

  const tick = async (): Promise<number> => {
    const cursor = await store.getSiemCursor();
    const events = await store.listAuditAfter(cursor, config.siem.batchSize);
    if (!events.length) return 0;
    const body = JSON.stringify({ instance: config.instance.name, events });
    const ts = String(Date.now());
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lolly-timestamp': ts,
          'x-lolly-signature': `sha256=${sig}`,
        },
        body,
      });
      if (!res.ok) throw new Error(`receiver answered ${res.status}`);
    } catch (e) {
      onResult?.(false, 0);
      console.error(`siem: batch not delivered (${(e as Error).message}) - will replay from seq ${cursor}`);
      return 0;
    }
    await store.setSiemCursor(events[events.length - 1]!.seq);
    onResult?.(true, events.length);
    return events.length;
  };

  return {
    tick,
    start() {
      const timer = setInterval(() => { void tick().catch(() => { /* logged in tick */ }); }, config.siem.intervalSeconds * 1000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
