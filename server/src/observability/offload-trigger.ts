/**
 * The blob offload trigger (plan 80 section 10, decision D14). Project files
 * and instance assets live in PostgreSQL `bytea` by default. Moving them to an
 * object store (milestone E2) costs a second system to run and back up, so it
 * starts only once a measured threshold is crossed: 10 GiB stored in `bytea`,
 * or 100 GiB read from it in one calendar month. Both numbers are provisional
 * and are reviewed when E2 starts.
 *
 * The lean K3s profile runs no monitoring stack, and the VM and YunoHost shapes
 * have none, so the server raises the alert itself: a banner in the console
 * for administrators (`GET /api/v1/alerts`) and one email to them per alert
 * per month, sent from the daily check in main.ts. A Prometheus stack, where
 * one exists, reads the same figures from `/metrics`.
 */
import type { BlobStore, BlobUsage, UsageNoticeKind } from '../blobs/types.ts';
import type { Notifier } from '../notify/notify.ts';

const GiB = 1024 ** 3;

/** Provisional D14 thresholds. */
export const OFFLOAD_THRESHOLDS = { storedBytes: 10 * GiB, monthReadBytes: 100 * GiB } as const;

export interface OffloadAlert {
  id: `blob-offload-${UsageNoticeKind}`;
  kind: UsageNoticeKind;
  level: 'warning';
  /** UTC month (YYYY-MM) the figure belongs to. */
  month: string;
  value: number;
  threshold: number;
  title: string;
  detail: string;
  /** Where the console sends an administrator to read what to do next. */
  href: string;
}

const DOCS_HREF = '#/docs?doc=operations&anchor=blob-offload-trigger';

/** Bytes as GiB with one decimal place, the unit the thresholds are set in. */
export const formatGiB = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`;

/** The alerts `usage` raises against `thresholds`. Only the pg driver can
 *  raise one: the trigger is about bytes in the database, and the other
 *  drivers have either moved them out already (s3) or hold nothing durable. */
export function offloadAlerts(usage: BlobUsage, thresholds: { storedBytes: number; monthReadBytes: number } = OFFLOAD_THRESHOLDS): OffloadAlert[] {
  if (usage.driver !== 'pg') return [];
  const alerts: OffloadAlert[] = [];
  if (usage.storedBytes !== null && usage.storedBytes >= thresholds.storedBytes) {
    alerts.push({
      id: 'blob-offload-stored', kind: 'stored', level: 'warning', month: usage.month,
      value: usage.storedBytes, threshold: thresholds.storedBytes,
      title: 'Blob storage has reached the offload threshold',
      detail: `PostgreSQL holds ${formatGiB(usage.storedBytes)} of project files and assets. The threshold for moving them to object storage is ${formatGiB(thresholds.storedBytes)}.`,
      href: DOCS_HREF,
    });
  }
  if (usage.monthReadBytes >= thresholds.monthReadBytes) {
    alerts.push({
      id: 'blob-offload-read', kind: 'read', level: 'warning', month: usage.month,
      value: usage.monthReadBytes, threshold: thresholds.monthReadBytes,
      title: 'Blob reads have reached the offload threshold',
      detail: `${formatGiB(usage.monthReadBytes)} of project files and assets has been read from PostgreSQL in ${usage.month}. The monthly threshold for moving them to object storage is ${formatGiB(thresholds.monthReadBytes)}.`,
      href: DOCS_HREF,
    });
  }
  return alerts;
}

/** The current offload alerts, or none when the store keeps no usage figures. */
export async function currentOffloadAlerts(blobs: BlobStore): Promise<OffloadAlert[]> {
  const usage = await blobs.usage?.();
  return usage ? offloadAlerts(usage) : [];
}

/**
 * The daily check: email the administrators about each alert that is new this
 * month, and emit the matching webhook event. The claim is taken before the
 * send, so two replicas never both send and a restart does not send again.
 * Returns the alerts that were sent.
 */
export async function notifyOffloadAlerts(deps: {
  blobs: BlobStore;
  notifier: Notifier;
  recipients: () => Promise<string[]>;
  baseUrl: string;
}): Promise<OffloadAlert[]> {
  const { blobs, notifier } = deps;
  const sent: OffloadAlert[] = [];
  for (const alert of await currentOffloadAlerts(blobs)) {
    if (!blobs.claimUsageNotice || !(await blobs.claimUsageNotice(alert.month, alert.kind))) continue;
    console.warn(`[lolly-work] ${alert.title}: ${formatGiB(alert.value)} of ${formatGiB(alert.threshold)} (${alert.month})`);
    notifier.email(await deps.recipients(), alert.title,
      `${alert.detail}\n\nThe thresholds are provisional. Read "Blob offload trigger" in the operations guide before acting: ${deps.baseUrl}/admin${alert.href}\n\nThis email is sent once a month while the threshold is exceeded. The console shows the same alert to administrators.`);
    notifier.event('blob.offload.threshold', { kind: alert.kind, month: alert.month, value: alert.value, threshold: alert.threshold });
    sent.push(alert);
  }
  return sent;
}
