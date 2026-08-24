/**
 * Minimal SMTP client (plans/35 wave 1) - the zip.ts posture: the protocol is
 * small and stable, so it is implemented here on node:net/node:tls rather than
 * imported. Covers what an org relay needs and nothing else: EHLO, STARTTLS
 * when offered (or implicit TLS with `secure`), AUTH PLAIN when a user is
 * configured, one MAIL/RCPT/DATA round, QUIT. Plain text only - notification
 * mail is a sentence and a link, not a layout.
 *
 * The transport is injectable so tests run against an in-process fixture
 * server; nothing here ever dials a default host.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface SmtpTarget {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465 style). Off = plain, with a
   *  STARTTLS upgrade whenever the server offers one. */
  secure: boolean;
  from: string;
  user?: string;
}

export interface SmtpMail {
  to: string[];
  subject: string;
  text: string;
}

/** Injectable socket factory (tests hand in a plain connection). */
export type SmtpConnect = (host: string, port: number) => Socket;

const TIMEOUT_MS = 10_000;

/** One reply, possibly multi-line ("250-a" continues, "250 b" ends). */
async function readReply(read: () => Promise<string>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await read();
    lines.push(line);
    if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), lines };
    if (!/^\d{3}-/.test(line)) throw new Error(`malformed SMTP reply: ${line}`);
  }
}

/** Dot-stuff + normalise line endings for the DATA section (RFC 5321 §4.5.2). */
export function dataSection(text: string): string {
  return text.split(/\r?\n/).map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
}

function lineReader(socket: Socket): { read: () => Promise<string>; swap: (s: Socket) => void } {
  let buf = '';
  let current = socket;
  let failed: Error | null = null;
  const waiters: Array<{ resolve: (line: string) => void; reject: (e: Error) => void }> = [];
  const pend: string[] = [];
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let at: number;
    while ((at = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const w = waiters.shift();
      if (w) w.resolve(line); else pend.push(line);
    }
  };
  // A socket error MUST land in the pending read, not as an uncaught 'error'
  // event: a relay resetting mid-dialogue (or right after QUIT) fails the send
  // cleanly instead of crashing the process.
  const onError = (e: Error): void => {
    failed = e;
    for (const w of waiters.splice(0)) w.reject(e);
  };
  current.on('data', onData);
  current.on('error', onError);
  return {
    read: () => {
      const queued = pend.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (failed) return Promise.reject(failed);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SMTP reply timeout')), TIMEOUT_MS);
        waiters.push({ resolve: (line) => { clearTimeout(timer); resolve(line); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      });
    },
    swap: (s: Socket) => {
      current.off('data', onData);
      current.off('error', onError);
      current = s;
      buf = '';
      current.on('data', onData);
      current.on('error', onError);
    },
  };
}

/**
 * Deliver one message. Throws with the failing SMTP dialogue step in the
 * message - the caller logs and counts, never retries into a mail loop.
 */
export async function sendMail(
  target: SmtpTarget,
  password: string | undefined,
  mail: SmtpMail,
  connectImpl?: SmtpConnect,
): Promise<void> {
  const open: SmtpConnect = connectImpl
    ?? (target.secure
      ? (h, p) => tlsConnect({ host: h, port: p, servername: h }) as unknown as Socket
      : (h, p) => netConnect({ host: h, port: p }));
  let socket = open(target.host, target.port);
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('SMTP socket timeout')));
  const reader = lineReader(socket);
  const send = (line: string): void => { socket.write(`${line}\r\n`); };
  const expect = async (code: number, what: string): Promise<string[]> => {
    const reply = await readReply(reader.read);
    if (reply.code !== code) throw new Error(`SMTP ${what}: expected ${code}, got ${reply.lines[0]}`);
    return reply.lines;
  };

  try {
    await expect(220, 'greeting');
    send('EHLO lolly-work');
    let caps = await expect(250, 'EHLO');
    // Opportunistic upgrade: a plain connection takes STARTTLS whenever the
    // relay offers it. A relay that offers neither TLS nor AUTH is the
    // operator's localhost case, and their call.
    if (!target.secure && !connectImpl && caps.some((l) => /starttls/i.test(l))) {
      send('STARTTLS');
      await expect(220, 'STARTTLS');
      socket = tlsConnect({ socket, servername: target.host }) as unknown as Socket;
      reader.swap(socket);
      send('EHLO lolly-work');
      caps = await expect(250, 'EHLO after STARTTLS');
    }
    if (target.user) {
      // RFC 4616 AUTH PLAIN: authzid NUL authcid NUL password, authzid empty.
      if (!password) throw new Error('SMTP user configured but LW_SMTP_PASSWORD is not set');
      send(`AUTH PLAIN ${Buffer.from(`\u0000${target.user}\u0000${password}`).toString('base64')}`);
      await expect(235, 'AUTH PLAIN');
    }
    send(`MAIL FROM:<${target.from}>`);
    await expect(250, 'MAIL FROM');
    for (const rcpt of mail.to) {
      send(`RCPT TO:<${rcpt}>`);
      await expect(250, `RCPT TO ${rcpt}`);
    }
    send('DATA');
    await expect(354, 'DATA');
    const headers = [
      `From: ${target.from}`,
      `To: ${mail.to.join(', ')}`,
      `Subject: ${mail.subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Auto-Submitted: auto-generated', // notification mail must never trigger vacation replies
    ].join('\r\n');
    socket.write(`${headers}\r\n\r\n${dataSection(mail.text)}\r\n.\r\n`);
    await expect(250, 'message accept');
    // Wait for the goodbye tolerantly: the message is already accepted, and a
    // relay that resets instead of answering QUIT changes nothing.
    send('QUIT');
    await readReply(reader.read).catch(() => { /* accepted above - done */ });
  } finally {
    socket.destroy();
  }
}
