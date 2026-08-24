/**
 * WebDAV driver (RFC 4918) - the open, sovereign arm of catalog federation.
 *
 * The kind is the PROTOCOL, not a vendor (naming decision of record): any RFC
 * 4918 server federates through here. Nextcloud is the primary documented
 * flavor because it is the sovereign, open-source option and it leads the
 * guide; ownCloud, Apache mod_dav, dCache, Sabre/DAV and anything else that
 * answers PROPFIND ride the same kind. `options.flavor` only picks the URL
 * template and which extension properties are asked for - the mapping below is
 * plain WebDAV either way.
 *
 * Zero-dep, like every driver here: HTTP Basic (or a bearer token) over global
 * fetch, and the 207 multistatus body is read by the small hand-rolled parser in
 * this file. Node ships no XML parser, and jsdom is a heavy render-path
 * dependency loaded lazily on purpose, so neither is pulled in for this. The
 * parser handles ONLY the PROPFIND multistatus layout: varying namespace
 * prefixes (d:, D:, or a default xmlns), self-closing tags, XML entities, and
 * percent-encoded hrefs. A body it cannot read throws a self-diagnosing error
 * rather than federating nothing in silence.
 *
 * CREDENTIAL: one sealed string, the s3 precedent - "<username>:<password>".
 * For Nextcloud that password must be an APP PASSWORD generated under Settings
 * > Security, never the account password: an account with 2FA on rejects the
 * account password at the DAV endpoint, and an app password is revocable on its
 * own. A bearer form is accepted too ("bearer:<token>") for servers fronted by a
 * token-issuing proxy. No OAuth flow is invented here.
 *
 * AVAILABILITY: plain WebDAV models none. A file has a size, a modification
 * stamp and a content type, and nothing that says when it may be published, so
 * the manual `catalog.expire` arm is the whole story for this kind unless the
 * server exposes a custom (dead) property carrying a date. Naming that property
 * in `mapping.availabilityFields` (plans/27 §2) switches the PROPFIND body from
 * the named prop list to `<d:allprop/>` plus a `<d:include>` for the extension
 * properties allprop does not have to carry. That switch is not decoration: RFC
 * 4918 §9.1 says a PROPFIND naming properties returns ONLY those, so a custom
 * property that was never asked for could never come back and the mapping could
 * never fire. The configured name is the LOCAL name, prefix dropped, because a
 * namespace URI is not something this driver can guess. Nothing is inferred when
 * the property is absent.
 *
 * IDENTITY: remoteId is the file's path RELATIVE to the configured files root,
 * carried as base64url. The path itself cannot be the id verbatim, because the
 * blob route splits /catalog/ext/<provider>/<remoteId>/<format> on '/' AFTER
 * percent-decoding each segment, so an encoded slash would not survive the trip
 * (the s3 and git drivers encode their keys and paths the same way). The id is
 * validated and re-encoded on the way back in, so a traversal attempt or an
 * alternate encoding never reaches a request. A file that is RENAMED upstream
 * therefore federates as a new asset: Nextcloud's oc:fileid would survive a
 * rename, but it cannot address the bytes, so it is deliberately not requested.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9). Nothing below has touched a
 * real server; every item here needs one tenant to confirm:
 *  - the Nextcloud files root `<baseUrl>/remote.php/dav/files/<username>/<root>`,
 *    and that the username in that path is the LOGIN name (it can differ from
 *    the display name, and from the credential's username, which is why
 *    options.username overrides it);
 *  - the generic files root `<baseUrl>/<root>`, which is whatever path the
 *    operator's server mounts DAV at;
 *  - that PROPFIND with Depth: 1 and the body propfindBody builds is accepted,
 *    and that a trailing slash on a collection URL is what the server wants
 *    (some servers redirect without it, and this driver refuses a redirect
 *    rather than following it: `redirect: 'manual'` in request());
 *  - that `<d:allprop/>` with `<d:include>` is accepted, and that a custom dead
 *    property carrying a date comes back under it. Only a configured
 *    mapping.availabilityFields asks for the body that way;
 *  - that `<d:propname/>` is accepted, which is what sampleShape asks with so
 *    its NOT MAPPED group can name the properties this driver does not read. A
 *    server that refuses it falls back to the mapping body, with a note;
 *  - the property names in PROP_SIZE_KEYS, PROP_MODIFIED_KEYS,
 *    PROP_CONTENT_TYPE_KEYS and PROP_RESOURCETYPE_KEYS, and that a collection is
 *    marked by a `collection` child of resourcetype (COLLECTION_ELEMENT);
 *  - the Nextcloud `oc:tags` extension: whether it is returned in a plain
 *    PROPFIND at all, and whether its values ride as child elements;
 *  - the multistatus layout itself: one propstat per status, with the readable
 *    properties under the 200 one (PROPSTAT_ELEMENT, STATUS_ELEMENT);
 *  - whether hrefs come back absolute-path or as full URLs, and how the server
 *    percent-encodes them;
 *  - the server's own rate limit, which is not a WebDAV concept at all - hence
 *    the deliberately conservative default gap, tunable with options.minGapMs.
 * Fixture-tested with injected fetch; neither building nor testing this driver
 * contacts any server. Nothing here is verified live.
 *
 * NOT BUILT, on purpose: search. Nextcloud has a SEARCH method (RFC 5323) and a
 * Files-app search API, but which of those a tenant exposes is exactly the kind
 * of guess that should be confirmed before it ships, and plain WebDAV has no
 * search at all. capabilities.search stays false for every flavor until one
 * tenant confirms the Nextcloud arm.
 *
 * READY FOR TENANT DAY (plans/33). Every guessed property name is an exported
 * constant array below, read through propOf, so widening a wrong guess is a
 * one-line edit here and nowhere else. `sampleShape` reports what the server
 * actually returned (property names and value types, never values) and diffs it
 * against those constants. Each failure that depends on a guess names the
 * assumption, the constant, and docs/providers/webdav-live-verify.md.
 */
import {
  buildShapeReport, firstString, liveVerifyError, liveVerifyMessage,
  type ProviderShapeReport, type ShapeExpectation,
} from './shape.ts';
import {
  extOf, stripExt,
  type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef,
  type ProviderMapping, type ProviderPage, type ResolvedBlob,
} from './types.ts';

export interface WebdavOptions {
  /** The server root, e.g. "https://cloud.example" or "https://dav.example/store". */
  baseUrl: string;
  /** URL template + which extension properties are requested. Default 'generic'. */
  flavor?: 'nextcloud' | 'generic';
  /** Nextcloud LOGIN name for the files path. Defaults to the credential's
   *  username; required outright when the credential is a bearer token. */
  username?: string;
  /** Federate only this subpath of the files root. */
  root?: string;
  /** Walk subdirectories breadth-first behind the cursor (default false). */
  recursive?: boolean;
  /** Minimum gap between calls to this provider (default 250ms, 4 req/s). */
  minGapMs?: number;
}

const USER_AGENT = 'lolly-work/1 (+catalog-provider)'; // etiquette: identify every call
const DEFAULT_GAP_MS = 250; // WebDAV publishes no rate limit, so stay well under
/** The one format a WebDAV file has: its own bytes. */
const FORMAT_REF = 'file';
/**
 * Hard bound on a recursive walk, so a huge tree cannot hang a sync. Two bounds
 * apply and the smaller wins: federation.ts stops after MAX_PAGES (50) pages per
 * sync, and one page here is one directory, so a sync visits at most 50
 * directories. MAX_DIRS bounds the driver's own walk across syncs and caps the
 * pending queue the cursor carries. Hitting either is reported as a note, never
 * as silence.
 */
export const MAX_DIRS = 500;

// Module-level per-provider rate limiter: reserve the next slot before awaiting
// so concurrent callers queue rather than race (the imagerelay precedent -
// driver instances are created per request).
const nextSlotAt = new Map<string, number>();
async function rateLimit(id: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, (nextSlotAt.get(id) ?? 0) + gapMs);
  nextSlotAt.set(id, at);
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// --- the LIVE-VERIFY guesses, one exported constant per logical field --------
// These ARE the protocol documentation now: nothing below reads a property name
// literally, so a name that turns out wrong is corrected in exactly one place.
// Element names are compared prefix-agnostically and case-insensitively, since
// a server may answer with d:, D: or a default namespace.

/** The 207 body's root element. */
export const MULTISTATUS_ELEMENT = 'multistatus';
/** One resource per response element. */
export const RESPONSE_ELEMENT = 'response';
/** The resource's URL, absolute-path or full. */
export const HREF_ELEMENT = 'href';
/** Properties are grouped by status; only the 200 group is readable. */
export const PROPSTAT_ELEMENT = 'propstat';
export const PROP_ELEMENT = 'prop';
export const STATUS_ELEMENT = 'status';
/** Marks a resourcetype as a directory rather than a file. */
export const COLLECTION_ELEMENT = 'collection';

export const PROP_RESOURCETYPE_KEYS = ['resourcetype'] as const;
export const PROP_SIZE_KEYS = ['getcontentlength'] as const;
export const PROP_MODIFIED_KEYS = ['getlastmodified'] as const;
export const PROP_CONTENT_TYPE_KEYS = ['getcontenttype'] as const;
/** Nextcloud's tag extension (oc:tags), requested for that flavor only. */
export const PROP_TAGS_KEYS = ['tags'] as const;

/** The Nextcloud files root, under the configured baseUrl. */
export const NEXTCLOUD_FILES_PATH = 'remote.php/dav/files/<username>';

const propfindOpen = (oc: boolean): string =>
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + `<d:propfind xmlns:d="DAV:"${oc ? ' xmlns:oc="http://owncloud.org/ns"' : ''}>\n`;

/**
 * The PROPFIND request body, per flavor. The generic one asks for nothing a bare
 * RFC 4918 server does not have.
 *
 * `allprop` is the availability arm. RFC 4918 §9.1 says a PROPFIND carrying a
 * named prop list returns ONLY those properties, so a custom dead property this
 * driver cannot know the name of at build time is unreachable through the named
 * list. When the operator names one in mapping.availabilityFields, the request
 * asks for `<d:allprop/>` instead - which is what carries dead properties - with
 * `<d:include>` re-adding the extension property allprop is not obliged to send
 * (§14.8). The named list stays the default: allprop is the more expensive call,
 * and no other field this driver reads needs it.
 */
export function propfindBody(flavor: 'nextcloud' | 'generic', allprop = false): string {
  const oc = flavor === 'nextcloud';
  if (allprop) {
    return propfindOpen(oc)
      + '  <d:allprop/>\n'
      + (oc ? `  <d:include>\n    <oc:${PROP_TAGS_KEYS[0]}/>\n  </d:include>\n` : '')
      + '</d:propfind>\n';
  }
  return propfindOpen(oc)
    + '  <d:prop>\n'
    + `    <d:${PROP_RESOURCETYPE_KEYS[0]}/>\n`
    + `    <d:${PROP_SIZE_KEYS[0]}/>\n`
    + `    <d:${PROP_MODIFIED_KEYS[0]}/>\n`
    + `    <d:${PROP_CONTENT_TYPE_KEYS[0]}/>\n`
    + (oc ? `    <oc:${PROP_TAGS_KEYS[0]}/>\n` : '')
    + '  </d:prop>\n'
    + '</d:propfind>\n';
}

/**
 * The discovery body: property NAMES only, no values (RFC 4918 §9.1). This is
 * what `sampleShape` asks with, and it is the only body that can answer the
 * question that report exists for - a named prop list comes back holding exactly
 * what was named, so every property would read as MAPPED or ABSENT and the
 * "IN THE RESPONSE, NOT MAPPED" group, where a wrong guess's real name shows up,
 * would always be empty. Names-only is also the safest thing to put in a report
 * an operator may paste into a ticket.
 */
export function propnameBody(): string {
  return propfindOpen(false) + '  <d:propname/>\n</d:propfind>\n';
}

/** What `--shape` diffs the server's response against. */
const ENVELOPE_EXPECTED: ShapeExpectation[] = [
  { keys: [MULTISTATUS_ELEMENT], constant: 'MULTISTATUS_ELEMENT' },
];
const RECORD_EXPECTED: ShapeExpectation[] = [
  { keys: PROP_RESOURCETYPE_KEYS, constant: 'PROP_RESOURCETYPE_KEYS' },
  { keys: PROP_SIZE_KEYS, constant: 'PROP_SIZE_KEYS' },
  { keys: PROP_MODIFIED_KEYS, constant: 'PROP_MODIFIED_KEYS' },
  { keys: PROP_CONTENT_TYPE_KEYS, constant: 'PROP_CONTENT_TYPE_KEYS' },
  { keys: PROP_TAGS_KEYS, constant: 'PROP_TAGS_KEYS' },
];

// --- the multistatus parser -------------------------------------------------
// Small and defensive by design. It reads element structure only: it never
// evaluates entities beyond the five XML ones plus numeric escapes, never
// resolves an external reference, and never treats an attribute as data.

/** One property: its text, its child element names, and its children's text.
 *  resourcetype is read through the names (a `collection` child), Nextcloud's
 *  oc:tags through the texts, everything else through `text`. */
export interface DavProp {
  text: string;
  childNames: string[];
  childTexts: string[];
}

/** One resource out of a multistatus body. `segments` is the href's path,
 *  percent-decoded, split, and with empty segments dropped. */
export interface DavEntry {
  segments: string[];
  /** Property local names as the server spelled them, so an operator-configured
   *  custom property matches exactly and the shape report reads true. */
  props: Record<string, DavProp>;
  collection: boolean;
}

/** Local name of a tag, prefix dropped ("d:href" and "D:href" both give "href"). */
function localName(tag: string): string {
  const name = tag.trim().split(/[\s/>]/)[0] ?? '';
  const at = name.indexOf(':');
  return at < 0 ? name : name.slice(at + 1);
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The five XML entities plus numeric escapes. An entity this does not know is
 *  left alone rather than guessed at. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole: string, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
      try { return String.fromCodePoint(cp); } catch { return whole; }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Where the close tag for `name` starts and ends, counting nested opens of the
 *  same local name. null when the document ends first. */
function findClose(xml: string, from: number, name: string): { start: number; end: number } | null {
  let depth = 0;
  let i = from;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) return null;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) return null;
    const raw = xml.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      if (localName(raw.slice(1)) === name) {
        if (depth === 0) return { start: lt, end: gt + 1 };
        depth--;
      }
    } else if (!raw.startsWith('?') && !raw.startsWith('!') && !raw.endsWith('/') && localName(raw) === name) {
      depth++;
    }
    i = gt + 1;
  }
  return null;
}

interface XmlElement { name: string; inner: string }

/**
 * The child elements one level down, in order. A nested child rides inside its
 * parent's `inner` rather than coming back separately, which is what makes
 * resourcetype and oc:tags readable. An unclosed element is a hard failure: half
 * a directory listing federated as if it were all of it is worse than an error.
 */
function elements(xml: string, what: string): XmlElement[] {
  const out: XmlElement[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt) || xml.startsWith('</', lt)) {
      const e = xml.indexOf('>', lt);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const raw = xml.slice(lt + 1, gt);
    const name = localName(raw);
    if (!name) { i = gt + 1; continue; }
    if (raw.endsWith('/')) {
      out.push({ name, inner: '' });
      i = gt + 1;
      continue;
    }
    const close = findClose(xml, gt + 1, name);
    if (!close) {
      throw liveVerifyError({
        kind: 'webdav', constant: 'parseMultistatus', tried: [name],
        problem: `could not read the PROPFIND body: <${name}> inside ${what} is never closed`,
        assumption: 'that the 207 body is well-formed XML (the parser here reads the multistatus layout only)',
      });
    }
    out.push({ name, inner: xml.slice(gt + 1, close.start) });
    i = close.end;
  }
  return out;
}

/** An element's text with any child markup dropped, entities decoded. */
function textOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' ')).trim();
}

const readProp = (inner: string, what: string): DavProp => {
  const kids = elements(inner, what);
  return {
    text: textOf(inner),
    childNames: kids.map((k) => k.name),
    childTexts: kids.map((k) => textOf(k.inner)).filter((t) => t !== ''),
  };
};

/** A property by any of its guessed names, matched case-insensitively so a
 *  server that spells `getContentLength` still reads. */
export function propOf(props: Record<string, DavProp>, keys: readonly string[]): DavProp | undefined {
  for (const k of keys) {
    const direct = props[k];
    if (direct) return direct;
    const lower = k.toLowerCase();
    for (const [name, value] of Object.entries(props)) {
      if (name.toLowerCase() === lower) return value;
    }
  }
  return undefined;
}

/** Every property as plain text, keyed by the name the server sent. What the
 *  shape report describes, and what a configured availability field is read
 *  from. Values are never copied into the report - only names and types. */
export function textProps(entry: DavEntry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, prop] of Object.entries(entry.props)) {
    out[name] = prop.childTexts.length ? prop.childTexts.join(', ') : prop.text;
  }
  return out;
}

/**
 * Parse a 207 multistatus body into one entry per resource.
 *
 * `hrefPath` turns an href into path segments, and is where the host pin lives:
 * a full-URL href naming another host is refused outright rather than followed,
 * so an upstream response can never redirect this driver off the configured
 * server. It returns null for an href this driver cannot read, and those are
 * counted by the caller rather than dropped in silence.
 */
export function parseMultistatus(
  xml: string,
  hrefPath: (href: string) => string[] | null,
): { entries: DavEntry[]; unreadable: number } {
  const roots = elements(xml, 'the PROPFIND body');
  const ms = roots.find((e) => e.name.toLowerCase() === MULTISTATUS_ELEMENT);
  if (!ms) {
    throw liveVerifyError({
      kind: 'webdav', constant: 'MULTISTATUS_ELEMENT', tried: [MULTISTATUS_ELEMENT],
      problem: 'PROPFIND answered without a multistatus root element',
      assumption: 'the 207 body layout (prefixes are read prefix-agnostically, so this is the element name, or a body that is not the XML RFC 4918 describes)',
    });
  }
  const responses = elements(ms.inner, `<${MULTISTATUS_ELEMENT}>`).filter((e) => e.name.toLowerCase() === RESPONSE_ELEMENT);
  if (responses.length === 0) {
    throw liveVerifyError({
      kind: 'webdav', constant: 'RESPONSE_ELEMENT', tried: [RESPONSE_ELEMENT],
      problem: 'the multistatus body carried no response element (a PROPFIND on a directory always describes at least the directory itself)',
      assumption: 'the per-resource element name',
    });
  }

  const entries: DavEntry[] = [];
  let unreadable = 0;
  for (const resp of responses) {
    const kids = elements(resp.inner, `<${RESPONSE_ELEMENT}>`);
    const href = kids.find((k) => k.name.toLowerCase() === HREF_ELEMENT);
    if (!href) { unreadable++; continue; }
    const segments = hrefPath(decodeEntities(href.inner).trim());
    if (!segments) { unreadable++; continue; }

    const props: Record<string, DavProp> = {};
    let readable = false;
    for (const ps of kids.filter((k) => k.name.toLowerCase() === PROPSTAT_ELEMENT)) {
      const inner = elements(ps.inner, `<${PROPSTAT_ELEMENT}>`);
      const status = inner.find((e) => e.name.toLowerCase() === STATUS_ELEMENT);
      // A propstat without a 200 carries the properties the server does NOT
      // have (a generic server answers 404 for oc:tags). Reading those as empty
      // strings would hide a wrong guess behind a value that looks present.
      if (status && !/\b200\b/.test(status.inner)) continue;
      readable = true;
      for (const propEl of inner.filter((e) => e.name.toLowerCase() === PROP_ELEMENT)) {
        for (const p of elements(propEl.inner, `<${PROP_ELEMENT}>`)) {
          props[p.name] = readProp(p.inner, `<${p.name}>`);
        }
      }
    }
    if (!readable) { unreadable++; continue; }

    const rt = propOf(props, PROP_RESOURCETYPE_KEYS);
    // resourcetype is authoritative; the trailing slash every server puts on a
    // collection href is the second signal, for a server that answers with an
    // empty resourcetype it never filled in.
    const collection = (rt?.childNames.some((n) => n.toLowerCase() === COLLECTION_ELEMENT) ?? false)
      || decodeEntities(href.inner).trim().endsWith('/');
    entries.push({ segments, props, collection });
  }
  return { entries, unreadable };
}

// --- paths ------------------------------------------------------------------

const RELPATH_DOTS = /^\.{1,2}$/;
/** Control characters, which no filename carries and a header injection would. */
const RELPATH_CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether a path relative to the files root is one this driver will address.
 *  A space or a unicode character is ordinary in a filename and passes;
 *  traversal is refused outright rather than normalised away. */
export function validRelPath(rel: string): boolean {
  if (rel === '') return true;
  if (rel.startsWith('/') || rel.endsWith('/')) return false;
  if (rel.includes('\\') || RELPATH_CONTROL.test(rel)) return false;
  return rel.split('/').every((s) => s !== '' && !RELPATH_DOTS.test(s));
}

const pathToRemoteId = (rel: string): string => Buffer.from(rel, 'utf8').toString('base64url');
const remoteIdToPath = (id: string): string => Buffer.from(id, 'base64url').toString('utf8');

const decodeSegments = (pathname: string): string[] =>
  pathname.split('/').filter((s) => s !== '').map(decodeURIComponent);

/** baseUrl is required and is parsed at construction, the git precedent: a
 *  provider whose server address will not parse should refuse to exist rather
 *  than fail once per sync with a URL error nobody can place. */
function parseBase(raw: string | undefined): URL {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('webdav needs options.baseUrl, e.g. "https://cloud.example" (Nextcloud) or the URL your server mounts DAV at');
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error(`webdav options.baseUrl is not a URL: ${raw}`);
  }
}

export function createWebdavProvider(
  id: string,
  options: WebdavOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  availabilityFields?: ProviderMapping['availabilityFields'],
): CatalogProvider {
  // First line, and optional-chained: a record configured with no options block
  // at all must read as the missing baseUrl it is, not as a property access on
  // undefined three lines later.
  const baseUrl = parseBase(options?.baseUrl);
  const flavor = options.flavor ?? 'generic';
  const gapMs = options.minGapMs ?? DEFAULT_GAP_MS;
  const origin = baseUrl.origin;
  const host = baseUrl.host;
  const baseSegments = decodeSegments(baseUrl.pathname);
  const rootSegments = (options.root ?? '').split('/').filter((s) => s !== '');
  // A configured availability field is a CUSTOM property whose name this driver
  // learns at configuration time, so the named prop list cannot ask for it (RFC
  // 4918 §9.1) and the request has to be the allprop form instead.
  const wantsCustomProps = Boolean(availabilityFields?.from || availabilityFields?.until);
  const body = propfindBody(flavor, wantsCustomProps);

  const CRED_HINT = 'webdav credential must be "<username>:<password>" (for Nextcloud an APP PASSWORD from Settings > Security, never the account password) or "bearer:<token>"';

  /** Fail closed: no credential, or one that is not one of the two documented
   *  forms, never turns into an anonymous request. */
  const auth = (): { header: string; username?: string } => {
    if (!secret) throw new Error(`${CRED_HINT} - no credential is sealed for this provider`);
    if (secret.toLowerCase().startsWith('bearer:')) {
      const token = secret.slice('bearer:'.length).trim();
      if (!token) throw new Error(`${CRED_HINT} - the bearer form carried no token`);
      return { header: `Bearer ${token}` };
    }
    const sep = secret.indexOf(':');
    if (sep <= 0 || sep === secret.length - 1) throw new Error(`${CRED_HINT} - got a string with no "<user>:<secret>" split`);
    const username = secret.slice(0, sep);
    return {
      header: `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`,
      username,
    };
  };

  /**
   * The files root, as decoded path segments.
   *   nextcloud: <baseUrl>/remote.php/dav/files/<username>/<root>
   *   generic:   <baseUrl>/<root>
   * The Nextcloud username defaults to the credential's, because the app
   * password is issued to the same login the DAV path names - but the two can
   * differ, so options.username wins when it is set.
   */
  const filesRoot = (): string[] => {
    if (flavor !== 'nextcloud') return [...baseSegments, ...rootSegments];
    const user = options.username ?? auth().username;
    if (!user) {
      throw new Error(`webdav nextcloud flavor needs options.username to build /${NEXTCLOUD_FILES_PATH} (the bearer credential form carries no username)`);
    }
    return [...baseSegments, 'remote.php', 'dav', 'files', user, ...rootSegments];
  };

  /** Every request URL is BUILT from the pinned origin plus the files root, so
   *  no upstream-supplied string ever becomes a URL this driver fetches. The
   *  path is joined first and the trailing slash added only when there is a path
   *  to put it after: a server that mounts DAV at its own root (baseUrl with no
   *  path and no options.root) has an EMPTY files root, and `origin + '/' + '' +
   *  '/'` would ask it for `//`, which several servers answer 404 for. */
  const urlFor = (rel: string, trailingSlash = false): string => {
    const segments = [...filesRoot(), ...(rel === '' ? [] : rel.split('/'))];
    const path = segments.map(encodeURIComponent).join('/');
    const url = `${origin}/${path}${trailingSlash && path !== '' ? '/' : ''}`;
    if (new URL(url).host !== host) throw new Error('webdav url outside the configured host');
    return url;
  };

  /** An href to path segments. A full-URL href naming another host is refused:
   *  the server does not get to redirect this driver off its own host. */
  const hrefPath = (href: string): string[] | null => {
    let pathname = href;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(href) || href.startsWith('//')) {
      const parsed = new URL(href.startsWith('//') ? `${baseUrl.protocol}${href}` : href);
      if (parsed.host !== host) {
        throw new Error(`webdav href points at ${parsed.host}, not the configured host ${host} - refusing to follow it`);
      }
      pathname = parsed.pathname;
    }
    try {
      return decodeSegments(pathname);
    } catch {
      return null; // a malformed percent escape: counted, never guessed at
    }
  };

  /** The path under the files root, or null when the href sits outside it. */
  const relFromRoot = (segments: string[], root: string[]): string | null => {
    if (segments.length < root.length) return null;
    for (let i = 0; i < root.length; i++) if (segments[i] !== root[i]) return null;
    return segments.slice(root.length).join('/');
  };

  const request = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    if (new URL(url).host !== host) throw new Error('webdav url outside the configured host');
    const { header } = auth();
    await rateLimit(id, gapMs);
    const headers: Record<string, string> = {
      authorization: header,
      'user-agent': USER_AGENT,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    // `redirect: 'manual'` is the host pin, enforced rather than described: the
    // default is 'follow', and a followed 3xx would stream some other origin's
    // bytes into this catalog as the tenant's, or parse its XML as the
    // multistatus, past every check on the URL this driver built. A 3xx is
    // therefore a failure, and it names where it was being sent.
    const res = await fetchImpl(url, { ...init, headers, redirect: 'manual' });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`webdav ${what} ${res.status} - the server rejected the credential. ${CRED_HINT}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let target = 'no Location header';
      if (location) {
        let where = location;
        try { where = `${new URL(location, url).host} (${new URL(location, url).pathname})`; } catch { /* an unparseable Location is reported as sent */ }
        target = `sending it to ${where}`;
      }
      throw new Error(`webdav ${what} ${res.status} for ${new URL(url).pathname} - the server redirected, ${target}. This driver never follows a redirect, because following one is how a pinned host stops being pinned. On a collection this is almost always the trailing slash; otherwise fix options.baseUrl.`);
    }
    if (res.status !== 207 && !res.ok) throw new Error(`webdav ${what} ${res.status} for ${new URL(url).pathname}`);
    return res;
  };

  /** One PROPFIND, parsed. `dir` is a path relative to the files root.
   *  `withBody` overrides the mapping body, which only sampleShape does. */
  const propfind = async (dir: string, depth: '0' | '1', withBody = body): Promise<{ entries: DavEntry[]; unreadable: number; url: string }> => {
    const url = urlFor(dir, true);
    const res = await request(url, {
      method: 'PROPFIND',
      headers: { depth, 'content-type': 'application/xml; charset=utf-8', accept: 'application/xml, text/xml' },
      body: withBody,
    }, 'propfind');
    const parsed = parseMultistatus(await res.text(), hrefPath);
    return { ...parsed, url };
  };

  const readWindow = (props: Record<string, string>): { availableFrom?: string; availableUntil?: string } => {
    // Plain WebDAV has no availability, so this arm reads a CUSTOM property by
    // the name the operator configured (plans/27 §2). Absent config means the
    // manual `catalog.expire` arm is the whole story for this provider.
    const from = availabilityFields?.from ? firstString(props, [availabilityFields.from]) : undefined;
    const until = availabilityFields?.until ? firstString(props, [availabilityFields.until]) : undefined;
    return { ...(from ? { availableFrom: from } : {}), ...(until ? { availableUntil: until } : {}) };
  };

  /** RFC 1123 (`Mon, 01 Jun 2026 00:00:00 GMT`) to ISO, so drift compares
   *  stamps the way it does for every other kind. An unparseable stamp is
   *  dropped: a missing optional degrades, it does not throw. */
  const isoStamp = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  };

  const toAsset = (entry: DavEntry, rel: string): ProviderAssetRef => {
    const parts = rel.split('/');
    const filename = parts[parts.length - 1] as string;
    const props = textProps(entry);
    const contentType = propOf(entry.props, PROP_CONTENT_TYPE_KEYS)?.text;
    const subtype = contentType ? (contentType.split(';')[0] ?? '').split('/')[1] : undefined;
    const ext = extOf(filename, subtype && /^[A-Za-z0-9.+-]+$/.test(subtype) ? subtype.toLowerCase() : 'bin');
    const sizeText = propOf(entry.props, PROP_SIZE_KEYS)?.text;
    const size = sizeText !== undefined && /^\d+$/.test(sizeText) ? Number(sizeText) : undefined;
    const updatedAt = isoStamp(propOf(entry.props, PROP_MODIFIED_KEYS)?.text);
    const tags = propOf(entry.props, PROP_TAGS_KEYS)?.childTexts ?? [];
    const formats: ProviderFormatRef[] = [{
      format: ext,
      remoteRef: FORMAT_REF,
      filename,
      ...(size !== undefined ? { size } : {}),
    }];
    return {
      remoteId: pathToRemoteId(rel),
      name: stripExt(filename),
      nativeType: ext,
      // The parent directory path, one section per level, which is what
      // exposure.includeSections scopes on and what sectionTags stamps.
      sections: parts.slice(0, -1),
      tags,
      ...(updatedAt ? { updatedAt } : {}),
      ...readWindow(props),
      formats,
    };
  };

  /** The walk state behind the opaque cursor: how many directories this walk has
   *  already read, and which ones are still pending. */
  const encodeCursor = (visited: number, pending: string[]): string =>
    Buffer.from([String(visited), ...pending].join('\n'), 'utf8').toString('base64url');

  const decodeCursor = (cursor: string): { visited: number; pending: string[] } => {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('bad webdav cursor');
    const [count, ...pending] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!count || !/^\d+$/.test(count)) throw new Error('bad webdav cursor');
    for (const dir of pending) {
      if (!validRelPath(dir)) throw new Error('bad webdav cursor');
    }
    return { visited: Number(count), pending };
  };

  return {
    id,
    kind: 'webdav',
    // No search (see the header), no thumbnails, and the bytes stream through
    // this driver rather than through a signed URL, so nothing expires.
    capabilities: { authKind: 'credential', search: false, thumbnails: false, expiringUrls: false },

    async listAssets(cursor): Promise<ProviderPage> {
      const state = cursor ? decodeCursor(cursor) : { visited: 0, pending: [''] };
      const dir = state.pending.shift();
      if (dir === undefined) return { assets: [] };

      const root = filesRoot();
      const { entries, unreadable, url } = await propfind(dir, '1');
      const assets: ProviderAssetRef[] = [];
      const dirs: string[] = [];
      // Two populations, counted apart. `unreadable` is responses that never
      // became entries (no href, or no propstat this driver could read);
      // `outside` is entries whose href sat outside the files root. Folding them
      // into one number and comparing it against entries.length compares counts
      // over different sets, which fires the guard below on a healthy page and
      // silences it on the very failure it is for. They are added only when
      // reporting `skipped` to the caller.
      let outside = 0;
      let files = 0;
      for (const entry of entries) {
        const rel = relFromRoot(entry.segments, root);
        // An href outside the configured root is never fetched (URLs are built,
        // not followed), so it is counted rather than treated as an attack.
        if (rel === null || !validRelPath(rel)) { outside++; continue; }
        if (rel === dir) continue; // the directory describing itself
        if (entry.collection) { dirs.push(rel); continue; } // a section, never an asset
        files++;
        assets.push(toAsset(entry, rel));
      }
      const skipped = unreadable + outside;

      // Every resource this driver could READ sat outside the files root, the
      // directory itself included. That is the URL template breaking rather than
      // an empty directory, and it is the failure a bare `skipped` count
      // explains worst: a proxy that rewrites the path prefix, or a login name
      // that is not the one the DAV path carries, both land here. Responses that
      // could not be read at all say nothing about the template, so they are
      // named in the message rather than counted into the test.
      if (entries.length > 0 && outside === entries.length) {
        const alsoUnreadable = unreadable > 0
          ? `; ${unreadable} further response(s) carried no href or no readable propstat`
          : '';
        throw liveVerifyError({
          kind: 'webdav',
          constant: flavor === 'nextcloud' ? 'NEXTCLOUD_FILES_PATH (or options.username / options.root)' : 'options.baseUrl / options.root',
          tried: [`/${root.join('/')}`],
          problem: `none of the ${entries.length} resource(s) PROPFIND returned sit under the files root this driver built${alsoUnreadable}`,
          assumption: 'the files-root URL template (the server answered, so the path it names resources by is not the one being asked for)',
        });
      }

      const notes: string[] = [];
      if (files > 0 && assets.every((a) => a.formats[0]?.size === undefined && a.updatedAt === undefined)) {
        notes.push(liveVerifyMessage({
          kind: 'webdav', constant: 'PROP_SIZE_KEYS / PROP_MODIFIED_KEYS',
          tried: [...PROP_SIZE_KEYS, ...PROP_MODIFIED_KEYS],
          problem: `read no size and no modification stamp from any of the ${files} file(s) under ${new URL(url).pathname}`,
          assumption: 'the DAV property names this driver asks for in propfindBody',
        }));
      }
      if ((availabilityFields?.from || availabilityFields?.until) && assets.length > 0
        && assets.every((a) => a.availableFrom === undefined && a.availableUntil === undefined)) {
        notes.push(liveVerifyMessage({
          kind: 'webdav', constant: 'mapping.availabilityFields',
          tried: [availabilityFields.from ?? '', availabilityFields.until ?? ''].filter((s) => s !== ''),
          problem: 'read no availability window from any file, though mapping.availabilityFields is set',
          assumption: 'the custom DAV property name, as a LOCAL name with the namespace prefix dropped (plain WebDAV has no availability, so the server must expose a dead property carrying the date, and must return it under the <d:allprop/> body this driver switches to when the mapping is set)',
        }));
      }

      const visited = state.visited + 1;
      let pending = state.pending;
      if (options.recursive) {
        pending = [...pending, ...dirs];
        if (pending.length > MAX_DIRS) {
          notes.push(`webdav stopped queueing directories at MAX_DIRS (${MAX_DIRS}); ${pending.length - MAX_DIRS} subdirectory(ies) under ${new URL(url).pathname} are not federated. Narrow options.root, or raise MAX_DIRS in server/src/catalog/providers/webdav.ts.`);
          pending = pending.slice(0, MAX_DIRS);
        }
      }
      if (visited >= MAX_DIRS && pending.length > 0) {
        notes.push(`webdav walked MAX_DIRS (${MAX_DIRS}) directories and stopped with ${pending.length} still pending, so this sync federated part of the tree. Narrow options.root, or raise MAX_DIRS in server/src/catalog/providers/webdav.ts.`);
        pending = [];
      }

      return {
        assets,
        ...(pending.length ? { next: encodeCursor(visited, pending) } : {}),
        ...(skipped ? { skipped } : {}),
        ...(notes.length ? { notes } : {}),
      };
    },

    /** One directory listing, reported as property names and TYPES only - never
     *  a value (§3). Two things are deliberately kept out: the hrefs, because a
     *  path is content this report has no business carrying, and the Nextcloud
     *  login name, which is half the Basic credential and so is printed as the
     *  template placeholder the report's own caveat promises. */
    async sampleShape(): Promise<ProviderShapeReport> {
      // Its OWN request, not the mapping one. A PROPFIND naming properties comes
      // back holding exactly those (RFC 4918 §9.1), so reusing the mapping body
      // would leave every property either MAPPED or ABSENT and the NOT MAPPED
      // group - where the real name of a wrong guess is the whole answer -
      // structurally empty. `<d:propname/>` asks for names and no values, which
      // is both the discovery call and the safest report to hand over.
      const discovery: string[] = [];
      let entries: DavEntry[];
      try {
        ({ entries } = await propfind('', '1', propnameBody()));
        discovery.push('this report comes from a `<d:propname/>` PROPFIND (property names, no values), so NOT MAPPED is every property your server carries that this driver does not read.');
      } catch (err) {
        ({ entries } = await propfind('', '1'));
        discovery.push(`the server refused the \`<d:propname/>\` discovery PROPFIND (${(err as Error).message}), so this report comes from the mapping body instead. A named prop list returns only what it names, so NOT MAPPED will be empty here and a wrong guess can only read as ABSENT: run \`curl -X PROPFIND -H 'Depth: 1' --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:propname/></d:propfind>' <url>\` by hand to see the real names.`);
      }
      const records = entries.map(textProps);
      const shown = flavor === 'nextcloud'
        ? [...baseSegments, 'remote.php', 'dav', 'files', '<username>', ...rootSegments]
        : filesRoot();
      return buildShapeReport({
        kind: 'webdav',
        endpoint: `PROPFIND /${shown.join('/')}/ (Depth: 1)`,
        doc: { [MULTISTATUS_ELEMENT]: records },
        records,
        recordsKey: MULTISTATUS_ELEMENT,
        envelopeExpected: ENVELOPE_EXPECTED,
        recordExpected: RECORD_EXPECTED,
        notes: [
          ...discovery,
          `${records.length} response(s), directories included: a resource whose ${PROP_RESOURCETYPE_KEYS[0]} carries a ${COLLECTION_ELEMENT} child becomes a section, never an asset.`,
          `the byte path makes no second call to describe: resolveBlob is a plain GET of the same file URL, so step 3 is what confirms it.`,
        ],
      });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== FORMAT_REF) throw new Error('webdav assets have a single file format');
      // The id round-trips or it is refused: the charset guard, the re-encode
      // check (so no alternate base64 spelling addresses the same file), and the
      // traversal guard all run before anything is fetched.
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad webdav asset id');
      const rel = remoteIdToPath(remoteId);
      if (rel === '' || !validRelPath(rel) || pathToRemoteId(rel) !== remoteId) throw new Error('bad webdav asset id');
      const res = await request(urlFor(rel), { method: 'GET' }, 'get');
      if (!res.body) throw new Error(`webdav get ${res.status} returned no body`);
      const size = Number(res.headers.get('content-length'));
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      };
    },

    async healthCheck() {
      try {
        // Depth 0 describes the files root and nothing under it, which is the
        // cheapest call that proves the URL template and the credential.
        await propfind('', '0');
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
