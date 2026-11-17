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
 * - An entry the page itself requests with `?v=<revision>` (today app.js and
 *   styles.css) is `public-immutable`, but only when the files on disk really
 *   are that revision. The server computes the revision with the same code
 *   console:build uses (lib/console-revision.ts), and serves the exact bytes it
 *   hashed: a file read that no longer matches them is served as revalidate.
 * - Every other file, with or without a `?v=`, has a stable address and is
 *   `public-revalidate`: the modules app.js imports, imported stylesheets, fonts
 *   and images.
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
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { carriesCredential, sendError, setDeliveryClass } from './router.ts';
import { safeFile, sendBytes, sendFile } from './file-delivery.ts';
import { CONSOLE_ASSET_HEADERS, consoleDocumentHeaders } from './console-headers.ts';
import { consoleSnapshot } from '../lib/console-revision.ts';

/** A revision address answered to a request that carries a credential. */
export const CONSOLE_PRIVATE_IMMUTABLE = 'private, max-age=31536000, immutable, no-transform';

const HTML_TYPE = 'text/html; charset=utf-8';
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The files a console page requests with one shared `?v=`, and that revision.
 *  Null when the page names none, or names more than one. */
export function consoleEntries(html: string): { revision: string; files: string[] } | null {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\/admin\/([^"?#]+)\?v=([a-f0-9]{64})"/g)];
  const revision = refs[0]?.[2];
  if (!revision || refs.some(ref => ref[2] !== revision)) return null;
  return { revision, files: [...new Set(refs.map(ref => decodeURIComponent(ref[1]!)))] };
}

/** What one read of the console tree proved. `revision` is null unless the
 *  tree hashes to the revision index.html names. */
interface Verified {
  /** Stat of index.html and of each entry, taken before the tree was read. */
  page: string;
  stamps: string;
  entries: string[];
  revision: string | null;
  /** SHA-256 of each entry's bytes as they were hashed into `revision`. */
  digests: ReadonlyMap<string, string>;
}

export interface ConsoleDelivery {
  /** Serve one console file; `rel` is the path below /admin/. */
  serve(req: IncomingMessage, res: ServerResponse, rel: string, url: URL): Promise<void>;
}

export function createConsoleDelivery(dir: string, contentType: (path: string) => string): ConsoleDelivery {
  const stamp = async (rel: string): Promise<string> => {
    try { const info = await stat(join(dir, rel)); return `${rel}:${info.mtimeMs}:${info.size}`; } catch { return `${rel}:missing`; }
  };
  let verified: Verified | undefined;
  // The tree is read again whenever index.html or an entry it names changes
  // size or modification time; otherwise this costs three stat calls.
  const verify = async (): Promise<Verified> => {
    const page = await stamp('index.html');
    let entries = verified?.page === page ? verified.entries : undefined;
    if (!entries) entries = consoleEntries(await readFile(join(dir, 'index.html'), 'utf8').catch(() => ''))?.files ?? [];
    const stamps = (await Promise.all(entries.map(stamp))).join('|');
    if (verified?.page === page && verified.stamps === stamps) return verified;
    let revision: string | null = null, digests = new Map<string, string>();
    try {
      const snapshot = consoleSnapshot(dir), named = consoleEntries(snapshot.source);
      if (named && snapshot.source === snapshot.html && named.revision === snapshot.revision && named.files.join('|') === entries.join('|')) {
        revision = snapshot.revision;
        digests = new Map(named.files.map(file => [file, sha256(snapshot.bytes.get(file)!)]));
      }
    } catch { /* A tree console:build would refuse has no immutable entries. */ }
    verified = { page, stamps, entries, revision, digests };
    return verified;
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
      const proof = version ? await verify() : undefined;
      const digest = proof?.revision && proof.revision === version ? proof.digests.get(clean) : undefined;
      if (digest) {
        // Serve the bytes just read only if they are the bytes the revision covers.
        const file = await safeFile(dir, clean);
        const bytes = file ? await readFile(file.path).catch(() => null) : null;
        if (file && bytes && sha256(bytes) === digest) {
          setDeliveryClass(res, 'public-immutable');
          const headers = carriesCredential(req) ? { ...CONSOLE_ASSET_HEADERS, 'cache-control': CONSOLE_PRIVATE_IMMUTABLE } : CONSOLE_ASSET_HEADERS;
          sendBytes(req, res, bytes, { contentType: type, headers, sha256: digest, modified: file.modified });
          return;
        }
      }
      setDeliveryClass(res, 'public-revalidate');
      if (!await sendFile(req, res, dir, clean, { contentType: type, headers: CONSOLE_ASSET_HEADERS })) sendError(res, 404, 'NOT_FOUND', 'no such console file');
    },
  };
}

/** The sandbox landing page: built per request from the configuration, but the
 *  same bytes for every visitor, so a repeat visit revalidates against its ETag. */
export function sendLandingPage(req: IncomingMessage, res: ServerResponse, html: string): void {
  setDeliveryClass(res, 'instance-private');
  sendBytes(req, res, Buffer.from(html), { contentType: HTML_TYPE });
}
