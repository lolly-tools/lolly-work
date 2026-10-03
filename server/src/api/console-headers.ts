// SPDX-License-Identifier: MPL-2.0
/** Security headers for the console, whose assets and API calls stay on this origin. */
import { createHash } from 'node:crypto';

export const CONSOLE_ASSET_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Allow the checked-in pre-paint scripts without allowing other inline scripts. */
export function consoleDocumentHeaders(html: string): Record<string, string> {
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((match) => !/(?:^|\s)src\s*=/i.test(match[1]!))
    .map((match) => `'sha256-${createHash('sha256').update(match[2]!.replace(/\r\n?/g, '\n')).digest('base64')}'`);
  return {
    ...CONSOLE_ASSET_HEADERS,
    'content-security-policy': [
      "default-src 'none'",
      ["script-src 'self'", ...hashes].join(' '),
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}
