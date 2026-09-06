/**
 * A very small LDAPv3 client: one simple bind, one base-scope search for a
 * known DN, one unbind. Just enough for proxy sign-in to read a person's own
 * directory entry (mail, name, group memberships) after the reverse proxy has
 * said who they are. Plain `node:net`, no dependencies, no TLS: the lookup is
 * meant to run against the loopback of the host that owns the directory
 * (YunoHost's slapd on 127.0.0.1:389), never across a network.
 *
 * Wire format is BER as RFC 4511 uses it. Only the handful of shapes this
 * client sends and reads are implemented; anything unexpected is a typed
 * `LdapError` rather than a guess.
 */
import { connect, type Socket } from 'node:net';

// ── BER primitives ─────────────────────────────────────────────────────────

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_ENUMERATED = 0x0a;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

// Application tags (RFC 4511 section 4.2 onwards), constructed unless noted.
const OP_BIND_REQUEST = 0x60;
const OP_BIND_RESPONSE = 0x61;
const OP_UNBIND_REQUEST = 0x42; // primitive, empty
const OP_SEARCH_REQUEST = 0x63;
const OP_SEARCH_ENTRY = 0x64;
const OP_SEARCH_DONE = 0x65;
const OP_SEARCH_REFERENCE = 0x73;
// Context-specific tags inside a BindRequest / Filter.
const AUTH_SIMPLE = 0x80; // [0] primitive
const FILTER_PRESENT = 0x87; // [7] primitive

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV: tag byte, then length, then the content as given. */
export function tlv(tag: number, content: Buffer | Buffer[]): Buffer {
  const body = Array.isArray(content) ? Buffer.concat(content) : content;
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

/** Two's-complement, minimal-length INTEGER (or ENUMERATED with another tag). */
export function berInteger(value: number, tag = TAG_INTEGER): Buffer {
  if (!Number.isSafeInteger(value)) throw new LdapError('protocol', `not an integer: ${value}`);
  const bytes: number[] = [];
  let rest = value;
  // Peel bytes off the low end until what remains is only the sign extension
  // of the top byte already emitted.
  for (;;) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
    const top = bytes[0]!;
    if ((rest === 0 && (top & 0x80) === 0) || (rest === -1 && (top & 0x80) !== 0)) break;
  }
  return tlv(tag, Buffer.from(bytes));
}

export function berString(value: string, tag = TAG_OCTET_STRING): Buffer {
  return tlv(tag, Buffer.from(value, 'utf8'));
}

export function berBoolean(value: boolean): Buffer {
  return tlv(TAG_BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

export interface Tlv {
  tag: number;
  /** Content bytes (a slice of the input, not a copy). */
  value: Buffer;
  /** Offset just past this element in the input. */
  end: number;
}

/** Read one TLV at `offset`. Returns null when the buffer holds only part of it. */
export function readTlv(buf: Buffer, offset = 0): Tlv | null {
  if (buf.length < offset + 2) return null;
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let pos = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new LdapError('protocol', `unsupported BER length form (${count} bytes)`);
    if (buf.length < pos + count) return null;
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[pos + i]!;
    pos += count;
  }
  if (buf.length < pos + len) return null;
  return { tag, value: buf.subarray(pos, pos + len), end: pos + len };
}

/** Every TLV inside a constructed element, in order. */
export function readChildren(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let pos = 0; pos < value.length;) {
    const child = readTlv(value, pos);
    if (!child) throw new LdapError('protocol', 'truncated BER element');
    out.push(child);
    pos = child.end;
  }
  return out;
}

export function readInteger(t: Tlv): number {
  if (t.value.length === 0 || t.value.length > 6) throw new LdapError('protocol', `bad INTEGER length ${t.value.length}`);
  let v = t.value[0]! & 0x80 ? -1 : 0;
  for (const b of t.value) v = v * 256 + b;
  return v;
}

// ── DN escaping (RFC 4514 section 2.4) ─────────────────────────────────────

/** Escape one attribute VALUE for use inside a DN, so `{user}` substitution
 *  can never break out of its own RDN. */
export function escapeDn(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16).padStart(2, '0')}`;
    else if ('\\,+"<>;='.includes(ch)) out += `\\${ch}`;
    else if (ch === '#' && i === 0) out += '\\#';
    else if (ch === ' ' && (i === 0 || i === value.length - 1)) out += '\\ ';
    else out += ch;
  }
  return out;
}

// ── The client ─────────────────────────────────────────────────────────────

export type LdapErrorCode = 'connect' | 'timeout' | 'protocol' | 'result';

export class LdapError extends Error {
  readonly code: LdapErrorCode;
  /** RFC 4511 resultCode when `code` is `result`. */
  readonly resultCode?: number;
  constructor(code: LdapErrorCode, message: string, resultCode?: number) {
    super(message);
    this.name = 'LdapError';
    this.code = code;
    if (resultCode !== undefined) this.resultCode = resultCode;
  }
}

const RESULT_SUCCESS = 0;
const RESULT_NO_SUCH_OBJECT = 32;

export interface LdapSearchEntryOptions {
  /** `ldap://host[:port]`; the port defaults to 389. */
  url: string;
  bindDn?: string;
  bindPassword?: string;
  /** The entry to read - scope is always base, the filter always `(objectClass=*)`. */
  baseDn: string;
  attributes: string[];
  timeoutMs: number;
}

/** LDAPResult fields common to BindResponse and SearchResultDone. */
function readResult(op: Tlv): { resultCode: number; diagnostic: string } {
  const [code, , diag] = readChildren(op.value);
  if (!code || code.tag !== TAG_ENUMERATED) throw new LdapError('protocol', 'LDAPResult without a resultCode');
  return { resultCode: readInteger(code), diagnostic: diag ? diag.value.toString('utf8') : '' };
}

/**
 * Bind, read one entry by DN, unbind. Resolves the entry's attributes keyed by
 * LOWERCASED attribute name (LDAP attribute names are case-insensitive and
 * servers answer in schema casing), or null when the DN does not exist.
 * Rejects with an LdapError for anything else: connection refused, the
 * timeout, a non-success bind or search result, malformed bytes.
 */
export function ldapSearchEntry(opts: LdapSearchEntryOptions): Promise<Record<string, string[]> | null> {
  const target = new URL(opts.url);
  if (target.protocol !== 'ldap:') return Promise.reject(new LdapError('connect', `unsupported scheme ${target.protocol} (ldap:// only)`));
  const port = target.port ? Number(target.port) : 389;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending: Buffer = Buffer.alloc(0);
    let nextId = 1;
    let bindId = 0;
    let searchId = 0;
    const entry: Record<string, string[]> = {};
    let found = false;

    const socket: Socket = connect({ host: target.hostname, port }, () => {
      bindId = send(tlv(OP_BIND_REQUEST, [
        berInteger(3),
        berString(opts.bindDn ?? ''),
        berString(opts.bindPassword ?? '', AUTH_SIMPLE),
      ]));
    });

    const finish = (err: Error | null, value?: Record<string, string[]> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A clean finish lets the unbind flush; an error path just drops the socket.
      if (err) socket.destroy(); else socket.end();
      if (err) reject(err); else resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(new LdapError('timeout', `directory did not answer within ${opts.timeoutMs} ms`)), opts.timeoutMs);

    const send = (op: Buffer): number => {
      const id = nextId++;
      socket.write(tlv(TAG_SEQUENCE, [berInteger(id), op]));
      return id;
    };
    const unbind = (): void => {
      try { socket.write(tlv(TAG_SEQUENCE, [berInteger(nextId++), Buffer.from([OP_UNBIND_REQUEST, 0x00])])); } catch { /* closing anyway */ }
    };

    socket.on('error', (err) => finish(new LdapError('connect', `directory connection failed: ${err.message}`)));
    socket.on('close', () => { if (!settled) finish(new LdapError('protocol', 'directory closed the connection before answering')); });
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        for (;;) {
          const msg = readTlv(pending, 0);
          if (!msg) return;
          pending = pending.subarray(msg.end);
          if (msg.tag !== TAG_SEQUENCE) throw new LdapError('protocol', `expected an LDAPMessage, got tag 0x${msg.tag.toString(16)}`);
          const [idTlv, op] = readChildren(msg.value);
          if (!idTlv || !op || idTlv.tag !== TAG_INTEGER) throw new LdapError('protocol', 'malformed LDAPMessage');
          const id = readInteger(idTlv);
          if (id === bindId && op.tag === OP_BIND_RESPONSE) {
            const { resultCode, diagnostic } = readResult(op);
            if (resultCode !== RESULT_SUCCESS) throw new LdapError('result', `bind refused (resultCode ${resultCode}${diagnostic ? `: ${diagnostic}` : ''})`, resultCode);
            searchId = send(tlv(OP_SEARCH_REQUEST, [
              berString(opts.baseDn),
              berInteger(0, TAG_ENUMERATED), // scope: baseObject
              berInteger(0, TAG_ENUMERATED), // derefAliases: neverDerefAliases
              berInteger(1), // sizeLimit
              berInteger(Math.max(1, Math.ceil(opts.timeoutMs / 1000))), // timeLimit, seconds
              berBoolean(false), // typesOnly
              berString('objectClass', FILTER_PRESENT), // (objectClass=*)
              tlv(TAG_SEQUENCE, opts.attributes.map((a) => berString(a))),
            ]));
          } else if (id === searchId && op.tag === OP_SEARCH_ENTRY) {
            const [, attrs] = readChildren(op.value);
            found = true;
            if (attrs && attrs.tag === TAG_SEQUENCE) {
              for (const pair of readChildren(attrs.value)) {
                const [type, vals] = readChildren(pair.value);
                if (!type || !vals || vals.tag !== TAG_SET) continue;
                const name = type.value.toString('utf8').toLowerCase();
                const values = readChildren(vals.value).map((v) => v.value.toString('utf8'));
                entry[name] = [...(entry[name] ?? []), ...values];
              }
            }
          } else if (id === searchId && op.tag === OP_SEARCH_REFERENCE) {
            // A referral for a base-scope read of one DN is nothing we follow.
          } else if (id === searchId && op.tag === OP_SEARCH_DONE) {
            const { resultCode, diagnostic } = readResult(op);
            if (resultCode === RESULT_NO_SUCH_OBJECT) { unbind(); return finish(null, null); }
            if (resultCode !== RESULT_SUCCESS) throw new LdapError('result', `search failed (resultCode ${resultCode}${diagnostic ? `: ${diagnostic}` : ''})`, resultCode);
            unbind();
            return finish(null, found ? entry : null);
          } else {
            throw new LdapError('protocol', `unexpected message id ${id} / op 0x${op.tag.toString(16)}`);
          }
        }
      } catch (err) {
        finish(err instanceof LdapError ? err : new LdapError('protocol', (err as Error).message));
      }
    });
  });
}
