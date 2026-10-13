// SPDX-License-Identifier: MPL-2.0
export const CREDENTIAL_DEFAULT_DAYS = 90;
export const CREDENTIAL_MAX_DAYS = 365;
export function credentialExpiry(days: unknown, now = Date.now()): string {
  const ttl = days === undefined ? CREDENTIAL_DEFAULT_DAYS : days;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > CREDENTIAL_MAX_DAYS) {
    throw new Error('ttlDays must be an integer from 1 to 365');
  }
  return new Date(now + ttl * 86400000).toISOString();
}
