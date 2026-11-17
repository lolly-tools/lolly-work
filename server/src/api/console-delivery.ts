// SPDX-License-Identifier: MPL-2.0
/**
 * Delivery for the admin console's static files and the sandbox landing page.
 *
 * The console files are the same for every caller and every API call the
 * console makes is checked on its own route, so the files can be cached. Each
 * response names its class for the router (router.ts guardDelivery):
 *
 * - HTML (`/admin`, `/admin/`, `/admin/index.html` and the sandbox landing page
 *   at `/`) is `instance-private`: `private, no-cache` with a strong ETag. A
 *   browser keeps a copy and asks again on every load; no shared cache stores
 *   the page. The landing page is built from this instance's configuration (its
 *   name and the demo personas), and the console page is the door to a signed-in
 *   app, so neither is offered to a CDN.
 * - A file requested with `?v=<revision>`, where the revision is the one the
 *   served index.html names, is `public-immutable`. scripts/console-assets.ts
 *   derives that revision from the bytes of every console file and writes it
 *   into index.html, so the address cannot name other bytes.
 * - Every other file (the modules app.js imports, imported stylesheets, fonts
 *   and images) has a stable address and is `public-revalidate`.
 *
 * The router serves a public class to a request that carries a credential as
 * `private, no-cache`, and a signed-in browser sends its session cookie with
 * every console request. A revision address cannot depend on who asks, so a
 * credentialed request for one is answered `private` with the same year-long
 * immutable lifetime instead. Shared caches still never keep that answer.
 *
 * Compression and validators come from file-delivery.ts: Brotli or gzip by the
 * request's Accept-Encoding, and a strong ETag for each coding, so a repeat
 * request answers 304. The router adds `no-transform` to every answer; with the
 * bytes already compressed here, a proxy that honours it loses nothing.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeliveryClass } from '@lolly-tools/core/delivery-v1';
import { carriesCredential, sendError, setDeliveryClass } from './router.ts';
import { safeFile, sendBytes, sendFile } from './file-delivery.ts';
import { CONSOLE_ASSET_HEADERS, consoleDocumentHeaders } from './console-headers.ts';

/** A revision address answered to a request that carries a credential. */
export const CONSOLE_PRIVATE_IMMUTABLE = 'private, max-age=31536000, immutable, no-transform';

const HTML_TYPE = 'text/html; charset=utf-8';

/** The revision the console's index.html names: both entry URLs carry the same
 *  `?v=` value (scripts/console-assets.ts entryUrls). Anything else is null, and
 *  then no console file is immutable. */
export function consoleRevisionOf(html: string): string | null {
  const script = /\bsrc="\/admin\/app\.js\?v=([a-f0-9]{64})"/.exec(html)?.[1];
  const style = /\bhref="\/admin\/styles\.css\?v=([a-f0-9]{64})"/.exec(html)?.[1];
  return script && script === style ? script : null;
}

/** The class one console file is served under. */
export function consoleFileClass(rel: string, version: string | null, revision: string | null): DeliveryClass {
  if (rel.endsWith('.html')) return 'instance-private';
  return revision && version === revision ? 'public-immutable' : 'public-revalidate';
}

export interface ConsoleDelivery {
  /** Serve one console file; `rel` is the path below /admin/. */
  serve(req: IncomingMessage, res: ServerResponse, rel: string, url: URL): Promise<void>;
}

export function createConsoleDelivery(dir: string, contentType: (path: string) => string): ConsoleDelivery {
  // The revision the current index.html names, read again when the file changes.
  let named: { key: string; revision: string | null } | undefined;
  const revision = async (): Promise<string | null> => {
    try {
      const info = await stat(join(dir, 'index.html')), key = `${info.mtimeMs}/${info.size}`;
      if (named?.key !== key) named = { key, revision: consoleRevisionOf(await readFile(join(dir, 'index.html'), 'utf8')) };
      return named.revision;
    } catch { return null; }
  };
  return {
    async serve(req, res, rel, url) {
      const clean = normalize(rel || 'index.html').replace(/^(\.\.[/\\])+/, '');
      if (clean.includes('..')) return sendError(res, 400, 'INVALID_INPUT', 'bad path');
      const type = contentType(clean);
      if (type.startsWith('text/html')) {
        const file = await safeFile(dir, clean);
        const bytes = file ? await readFile(file.path).catch(() => null) : null;
        if (!bytes) return sendError(res, 404, 'NOT_FOUND', 'no such console file');
        setDeliveryClass(res, 'instance-private');
        sendBytes(req, res, bytes, { contentType: type, headers: consoleDocumentHeaders(bytes.toString('utf8')) });
        return;
      }
      const version = url.searchParams.get('v');
      const delivery = consoleFileClass(clean, version, version ? await revision() : null);
      setDeliveryClass(res, delivery);
      const headers = delivery === 'public-immutable' && carriesCredential(req)
        ? { ...CONSOLE_ASSET_HEADERS, 'cache-control': CONSOLE_PRIVATE_IMMUTABLE } : CONSOLE_ASSET_HEADERS;
      if (!await sendFile(req, res, dir, clean, { contentType: type, headers })) sendError(res, 404, 'NOT_FOUND', 'no such console file');
    },
  };
}

/** The sandbox landing page: built per request from the configuration, but the
 *  same bytes for every visitor, so a repeat visit revalidates against its ETag. */
export function sendLandingPage(req: IncomingMessage, res: ServerResponse, html: string): void {
  setDeliveryClass(res, 'instance-private');
  sendBytes(req, res, Buffer.from(html), { contentType: HTML_TYPE });
}
