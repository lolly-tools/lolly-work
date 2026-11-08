// SPDX-License-Identifier: MPL-2.0
/** The 24-hour token a signed callback carries, so its receiver can read one
 *  render's or batch's output with no credentials of its own. It travels in the
 *  signed body and in the `x-lw-render-token` header, never in a URL. It names the
 *  owner and nothing more: the route still checks that owner's current grants. */
import type { IncomingMessage } from 'node:http';
import { mintToken, verifyToken } from '../iam/tokens.ts';

const OUTPUT_TOKEN_HEADER = 'x-lw-render-token';
export const OUTPUT_TOKEN_SECONDS = 24 * 3600;

export function renderOutputTokens(mintSecret: string, verifySecrets: string | readonly string[]) {
  return {
    mint: (id: string, principal: string): string => mintToken('lw/render', { id, principal }, mintSecret, OUTPUT_TOKEN_SECONDS),
    principal(req: IncomingMessage, id: string): string | null {
      const header = req.headers[OUTPUT_TOKEN_HEADER];
      if (typeof header !== 'string' || !header) return null;
      const signed = verifyToken<{ id: string; principal: string }>('lw/render', header, verifySecrets);
      return signed?.id === id ? signed.principal : null;
    },
  };
}
