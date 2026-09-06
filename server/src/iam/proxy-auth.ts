/**
 * Reverse-proxy sign-in: turn the identity headers an authenticating proxy set
 * into a member identity the session code can mint from.
 *
 * Two facts make the headers believable, and both belong to the proxy, not to
 * this code: it must strip any identity header a client sent before adding
 * its own (SSOwat drops every `ynh_*` header and any client `Authorization:
 * Basic`), and it must inject the shared secret this module checks, so a
 * process that reaches the instance port without going through the proxy is
 * refused. Nothing here reads a password.
 *
 * The optional directory lookup reads the person's own LDAP entry once per
 * sign-in to fill attributes the headers left blank and to derive groups
 * (YunoHost exposes group membership as `memberOf` and app permissions as
 * `permission` on the user entry). The directory is fail-closed: when it is
 * configured and does not answer, the sign-in is refused rather than minted
 * with fewer groups than the person actually holds.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ProxyAuthConfig } from '../config/instance.ts';
import { escapeDn, ldapSearchEntry, LdapError } from './ldap.ts';

export interface ProxyIdentity {
  /** The stable login the proxy asserted; the member's sub is `proxy:<user>`. */
  user: string;
  email: string;
  firstname?: string;
  lastname?: string;
  groups: string[];
  /** Where each part came from, for the audit row. */
  sources: { directory: 'off' | 'read' | 'no-entry' };
}

export type ProxyResolution =
  | { ok: true; identity: ProxyIdentity }
  | { ok: false; status: 401 | 403 | 502; code: 'PROXY_SECRET_MISMATCH' | 'PROXY_NO_USER' | 'DIRECTORY_UNAVAILABLE'; message: string; cause?: string };

export type DirectoryLookup = typeof ldapSearchEntry;

/** The proxy must send this header with the value of the `secretRef` env var. */
export const PROXY_SECRET_HEADER = 'x-lw-proxy-auth';

function header(headers: IncomingHttpHeaders, name: string): string {
  if (!name) return '';
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').trim();
}

function secretMatches(presented: string, expected: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Different lengths can never match; compare b against itself so the timing
  // does not say which length was wrong.
  return a.length === b.length ? timingSafeEqual(a, b) : (timingSafeEqual(b, b), false);
}

function splitName(full: string): { firstname?: string; lastname?: string } {
  const trimmed = full.trim().replace(/\s+/g, ' ');
  if (!trimmed) return {};
  const at = trimmed.lastIndexOf(' ');
  return at === -1 ? { firstname: trimmed } : { firstname: trimmed.slice(0, at), lastname: trimmed.slice(at + 1) };
}

function first(values: string[] | undefined): string {
  return values?.find((v) => v.trim())?.trim() ?? '';
}

/**
 * Resolve the signed-in person from a request's headers. Pure apart from the
 * directory lookup, which is injectable so tests can point it at a fake server
 * or stub it out.
 */
export async function resolveProxyIdentity(
  headers: IncomingHttpHeaders,
  cfg: ProxyAuthConfig,
  secrets: { proxyAuth?: string; proxyAuthBind?: string },
  lookup: DirectoryLookup = ldapSearchEntry,
): Promise<ProxyResolution> {
  if (!secretMatches(header(headers, PROXY_SECRET_HEADER), secrets.proxyAuth)) {
    return { ok: false, status: 403, code: 'PROXY_SECRET_MISMATCH', message: 'request did not come through the configured reverse proxy' };
  }
  const user = header(headers, cfg.headers.user);
  if (!user) {
    return { ok: false, status: 401, code: 'PROXY_NO_USER', message: `the proxy set no ${cfg.headers.user} header - is the request authenticated at the proxy?` };
  }

  let email = header(headers, cfg.headers.email);
  let fullName = header(headers, cfg.headers.name);
  let firstname = '';
  let lastname = '';
  const groups = new Set<string>();
  for (const g of header(headers, cfg.headers.groups).split(',')) if (g.trim()) groups.add(g.trim());
  let directory: ProxyIdentity['sources']['directory'] = 'off';

  const dir = cfg.directory;
  if (dir) {
    const wanted = new Set<string>();
    for (const a of Object.values(dir.attributes)) if (a) wanted.add(a);
    for (const rule of dir.groupMap) wanted.add(rule.attribute);
    let entry: Record<string, string[]> | null;
    try {
      entry = await lookup({
        url: dir.url,
        ...(dir.bindDn ? { bindDn: dir.bindDn, bindPassword: secrets.proxyAuthBind ?? '' } : {}),
        baseDn: dir.userDn.split('{user}').join(escapeDn(user)),
        attributes: [...wanted],
        timeoutMs: dir.timeoutMs,
      });
    } catch (err) {
      const cause = err instanceof LdapError ? `${err.code}: ${err.message}` : (err as Error).message;
      return { ok: false, status: 502, code: 'DIRECTORY_UNAVAILABLE', message: 'the directory behind proxy sign-in did not answer', cause };
    }
    if (entry) {
      directory = 'read';
      const attr = (name: string): string => (name ? first(entry![name.toLowerCase()]) : '');
      email ||= attr(dir.attributes.email);
      firstname = attr(dir.attributes.firstname);
      lastname = attr(dir.attributes.lastname);
      fullName ||= attr(dir.attributes.name);
      for (const rule of dir.groupMap) {
        const re = new RegExp(rule.pattern);
        for (const value of entry[rule.attribute.toLowerCase()] ?? []) {
          const m = re.exec(value);
          if (m?.[1]) groups.add(m[1]);
        }
      }
    } else {
      directory = 'no-entry';
    }
  }
  for (const g of cfg.groups[user] ?? []) groups.add(g);
  // YunoHost gives every account a primary group of its own name; it says
  // nothing about the organisation, so it never becomes a governance group.
  groups.delete(user);

  if (!firstname && !lastname) {
    const split = splitName(fullName);
    firstname = split.firstname ?? '';
    lastname = split.lastname ?? '';
  }
  return {
    ok: true,
    identity: {
      user,
      // A login with no mail anywhere is still a person; the login stands in
      // so the record has the one required field.
      email: email || user,
      ...(firstname ? { firstname } : {}),
      ...(lastname ? { lastname } : {}),
      groups: [...groups],
      sources: { directory },
    },
  };
}
