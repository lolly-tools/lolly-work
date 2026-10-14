// SPDX-License-Identifier: MPL-2.0
export function safeMessageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (value.startsWith('#')) return true;
  if (value.startsWith('/')) return !value.startsWith('//');
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
