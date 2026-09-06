/**
 * A fake LDAP server for the client and proxy sign-in tests: enough of RFC 4511
 * to answer a simple bind and a base-scope search from canned entries, plus
 * knobs for the failure paths (a refused bind, a server that never answers,
 * one that sends nonsense). Built on the client's own BER helpers, which is
 * fine here: the wire bytes are checked in ldap.test.ts against hand-written
 * hex, so a shared encoding bug cannot hide behind itself.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { berInteger, berString, readChildren, readInteger, readTlv, tlv } from '../server/src/iam/ldap.ts';

export interface FakeLdapOptions {
  /** DN → attributes. Attribute names are served in the casing given here. */
  entries: Record<string, Record<string, string[]>>;
  /** When set, only this bind DN + password succeed; anonymous binds are refused. */
  requireBind?: { dn: string; password: string };
  /** Never answer anything (timeout path). */
  hang?: boolean;
  /** Answer the first message with a well-formed element that is not an LDAPMessage. */
  garbage?: boolean;
}

export interface FakeLdap {
  url: string;
  /** Every BindRequest seen, as `{ dn, password }`. */
  binds: Array<{ dn: string; password: string }>;
  /** Every SearchRequest seen, as `{ baseDn, scope, attributes }`. */
  searches: Array<{ baseDn: string; scope: number; attributes: string[] }>;
  close(): Promise<void>;
}

const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const TAG_ENUMERATED = 0x0a;

function result(op: number, code: number, diag = ''): Buffer {
  return tlv(op, [berInteger(code, TAG_ENUMERATED), berString(''), berString(diag)]);
}

function message(id: number, op: Buffer): Buffer {
  return tlv(TAG_SEQUENCE, [berInteger(id), op]);
}

export async function startFakeLdap(opts: FakeLdapOptions): Promise<FakeLdap> {
  const binds: FakeLdap['binds'] = [];
  const searches: FakeLdap['searches'] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* the client hung up first */ });
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      if (opts.hang) return;
      // A complete element that is not an LDAPMessage (an OCTET STRING at top level).
      if (opts.garbage) { socket.write(Buffer.from('0403ffeedd', 'hex')); return; }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const msg = readTlv(pending, 0);
        if (!msg) return;
        pending = pending.subarray(msg.end);
        const [idTlv, op] = readChildren(msg.value);
        const id = readInteger(idTlv!);
        if (op!.tag === 0x60) {
          const [, dn, auth] = readChildren(op!.value);
          const bind = { dn: dn!.value.toString('utf8'), password: auth!.value.toString('utf8') };
          binds.push(bind);
          const ok = !opts.requireBind || (bind.dn === opts.requireBind.dn && bind.password === opts.requireBind.password);
          socket.write(message(id, result(0x61, ok ? 0 : 49, ok ? '' : 'invalid credentials')));
        } else if (op!.tag === 0x63) {
          const [base, scope, , , , , , attrs] = readChildren(op!.value);
          const baseDn = base!.value.toString('utf8');
          searches.push({ baseDn, scope: readInteger(scope!), attributes: readChildren(attrs!.value).map((a) => a.value.toString('utf8')) });
          const entry = opts.entries[baseDn];
          if (entry) {
            const attributes = Object.entries(entry).map(([name, values]) =>
              tlv(TAG_SEQUENCE, [berString(name), tlv(TAG_SET, values.map((v) => berString(v)))]));
            socket.write(message(id, tlv(0x64, [berString(baseDn), tlv(TAG_SEQUENCE, attributes)])));
            socket.write(message(id, result(0x65, 0)));
          } else {
            socket.write(message(id, result(0x65, 32, 'no such object')));
          }
        } else if (op!.tag === 0x42) {
          socket.end();
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `ldap://127.0.0.1:${port}`,
    binds,
    searches,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
