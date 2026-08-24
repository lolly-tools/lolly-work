/**
 * Credential expiry check (plans/36 §2) - the daily half of the surfacing.
 *
 * The provider rows, the console chip and the metrics gauge show the stated
 * expiry continuously; this check adds the nudge, through wave-1 egress, so
 * an owner hears about a dying credential before a failing sync does the
 * telling. Threshold-crossing only ([14, 7, 3, 1, 0] days) - a daily run
 * meets each integer day once, so each threshold fires once and there is
 * never a daily nag. Providers with no stated expiry are never mentioned:
 * unknown is unknown.
 */
import type { ProviderRecord } from './providers/types.ts';

export const EXPIRY_THRESHOLD_DAYS: readonly number[] = [14, 7, 3, 1, 0];

export interface ExpiringCredential {
  id: string;
  label: string;
  kind: string;
  daysLeft: number;
  expiresAt: string;
}

/** The providers whose stated expiry sits exactly on a threshold today. */
export function expiringCredentials(providers: ProviderRecord[], now: () => number = Date.now): ExpiringCredential[] {
  const out: ExpiringCredential[] = [];
  for (const p of providers) {
    if (!p.credentialExpiresAt) continue;
    const daysLeft = Math.floor((new Date(p.credentialExpiresAt).getTime() - now()) / 86_400_000);
    if (EXPIRY_THRESHOLD_DAYS.includes(daysLeft)) {
      out.push({ id: p.id, label: p.label, kind: p.kind, daysLeft, expiresAt: p.credentialExpiresAt });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
