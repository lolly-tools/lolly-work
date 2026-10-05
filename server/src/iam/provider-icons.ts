// SPDX-License-Identifier: MPL-2.0
/** Fixed, local provider marks. A provider's name never becomes SVG markup. */
export function providerIcon(name: string): string {
  const lower = name.toLowerCase();
  const svg = (body: string) => `<svg class="provider-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${body}</svg>`;
  if (lower.includes('passkey')) return svg('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="5"/><path d="m11.5 12.5 8 8 2-2-2-2 2-2-2-2-2 2"/></g>');
  if (lower.includes('google')) return svg('<path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c1.9-1.7 2.9-4.3 2.9-7.4Z"/><path fill="#34a853" d="M12 22c2.7 0 5-1 6.7-2.4l-3.3-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3v2.6A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3a10 10 0 0 0 0 9l3.4-2.6Z"/><path fill="#ea4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.6A6 6 0 0 1 12 6Z"/>');
  if (lower.includes('github')) return svg('<path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.64.35-1.08.64-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.84c.85 0 1.7.11 2.5.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>');
  if (lower.includes('suse')) return svg('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 8c-2-3-7-4-11-2L5 9c-2 0-3 1-3 3s2 4 4 3c2-1 1-3-1-2M7 14h6l3-3 5 1V9l-1-1M9 14l-1 4m7-5 2 5"/><circle cx="17" cy="8" r="1"/></g>');
  if (lower.includes('email') || lower.includes('password')) return svg('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/></g>');
  return svg('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></g>');
}
