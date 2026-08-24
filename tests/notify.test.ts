/**
 * Notification egress (plans/35 wave 1) against real fixtures: an in-process
 * SMTP server and an in-process webhook receiver. The properties pinned:
 * dormant means ZERO egress (the default instance is byte-identical to before
 * the feature existed); an approval reaches its reviewers' inboxes and the
 * org webhook with a verifiable signature; delivery is fire-and-forget (the
 * HTTP response never waits on the relay); misconfiguration is refused at
 * parse or at boot, never discovered at send time.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, loadSecrets } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { dataSection } from '../server/src/notify/smtp.ts';

const servers: Array<Server | NetServer> = [];
after(() => { for (const s of servers) s.close(); });

// ── fixtures ─────────────────────────────────────────────────────────────────

interface CapturedMail { from: string; to: string[]; data: string }

/** A minimal ESMTP fixture: enough dialogue for smtp.ts's happy path, no
 *  STARTTLS advertised (so the client stays plain), no AUTH demanded. */
function smtpFixture(): Promise<{ port: number; mails: CapturedMail[]; connections: () => number }> {
  const mails: CapturedMail[] = [];
  let connections = 0;
  const server = createNetServer((socket: Socket) => {
    connections++;
    socket.on('error', () => { /* client teardown races are fine for a fixture */ });
    let mail: CapturedMail = { from: '', to: [], data: '' };
    let inData = false;
    let buf = '';
    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mail.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        mails.push(mail);
        mail = { from: '', to: [], data: '' };
        socket.write('250 stored\r\n');
      }
      let at: number;
      while (!inData && (at = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (/^EHLO/i.test(line)) socket.write('250-fixture\r\n250 OK\r\n');
        else if (/^MAIL FROM:/i.test(line)) { mail.from = line.slice(10).replace(/[<>]/g, ''); socket.write('250 OK\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { mail.to.push(line.slice(8).replace(/[<>]/g, '')); socket.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) socket.write('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, () => {
    const addr = server.address();
    resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, mails, connections: () => connections });
  }));
}

interface CapturedHook { body: string; signature: string; timestamp: string }

function webhookFixture(): Promise<{ url: string; hooks: CapturedHook[] }> {
  const hooks: CapturedHook[] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      hooks.push({
        body,
        signature: String(req.headers['x-lolly-signature'] ?? ''),
        timestamp: String(req.headers['x-lolly-timestamp'] ?? ''),
      });
      res.writeHead(200);
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, () => {
    const addr = server.address();
    resolve({ url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`, hooks });
  }));
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── app harness ──────────────────────────────────────────────────────────────

async function boot(notify?: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ base: string; store: ReturnType<typeof createMemoryStore> }> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-notify-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Notify Hub', baseUrl: 'http://hub.example', pack },
    rateLimit: { enabled: false },
    ...(notify ? { notify } : {}),
    dev: { enabled: true, users: [
      { email: 'maker@test', groups: ['member'] },
      { email: 'reviewer@test', groups: ['review'] },
      { email: 'second@test', groups: ['review'] },
      { email: 'boss@test', groups: ['admin'] },
    ] },
  }));
  const store = createMemoryStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const secrets = { ...loadSecrets({ NODE_ENV: 'test', ...env }), session: 'sN', link: 'lN' };
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets });
  const server = createHttpServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const requestApproval = async (base: string, cookie: string) => {
  const res = await fetch(`${base}/api/v1/approvals`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectType: 'asset', subjectRef: 'sess:1', title: 'Launch deck', chainId: 'brand' }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
};

// ── the flows ────────────────────────────────────────────────────────────────

test('an approval reaches its reviewers by mail and the org webhook, signed', async () => {
  const smtp = await smtpFixture();
  const hook = await webhookFixture();
  const { base } = await boot(
    { smtp: { host: '127.0.0.1', port: smtp.port, from: 'lolly@hub.example' }, webhook: { url: hook.url } },
    { LW_WEBHOOK_SECRET: 'hook-secret' },
  );
  // Reviewers must exist as user rows before they can be resolved as an
  // audience - a dev-provider user is created on first sign-in.
  const reviewer = await login(base, 'reviewer@test');
  await login(base, 'second@test');
  const maker = await login(base, 'maker@test');
  const approval = await requestApproval(base, maker);

  await until(() => smtp.mails.length >= 1, 'the request mail');
  const requested = smtp.mails[0] as CapturedMail;
  assert.equal(requested.from, 'lolly@hub.example');
  assert.deepEqual([...requested.to].sort(), ['reviewer@test', 'second@test'], 'both eligible reviewers, never the requester');
  assert.match(requested.data, /Subject: Approval requested: Launch deck/);
  assert.match(requested.data, /http:\/\/hub\.example\/admin/);

  await until(() => hook.hooks.length >= 1, 'the request event');
  const evt = hook.hooks[0] as CapturedHook;
  const parsed = JSON.parse(evt.body) as { event: string; data: { id: string; by: string } };
  assert.equal(parsed.event, 'approval.requested');
  assert.equal(parsed.data.by, 'maker@test');
  // The signature is over `${ts}.${body}` with the configured secret - a
  // receiver recomputing it refuses forgeries and replays.
  const expected = `sha256=${createHmac('sha256', 'hook-secret').update(`${evt.timestamp}.${evt.body}`).digest('hex')}`;
  assert.equal(evt.signature, expected);

  // The decision closes the loop back to the requester.
  const act = await fetch(`${base}/api/v1/approvals/${approval.id}/act`, {
    method: 'POST', headers: { cookie: reviewer, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(act.status, 200);
  await until(() => smtp.mails.length >= 2, 'the decision mail');
  const decided = smtp.mails[1] as CapturedMail;
  assert.deepEqual(decided.to, ['maker@test']);
  assert.match(decided.data, /Subject: Approval approved: Launch deck/);
  await until(() => hook.hooks.some((h) => h.body.includes('approval.decided')), 'the decision event');
});

test('dormant by default: no notify block means zero egress', async () => {
  const smtp = await smtpFixture();
  const hook = await webhookFixture();
  const { base } = await boot(); // no notify config at all
  const maker = await login(base, 'maker@test');
  await requestApproval(base, maker);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(smtp.connections(), 0, 'no SMTP connection was ever opened');
  assert.equal(hook.hooks.length, 0, 'no webhook was ever called');
});

test('a broadcast message forwards to the webhook only', async () => {
  const hook = await webhookFixture();
  const { base } = await boot({ webhook: { url: hook.url } }, { LW_WEBHOOK_SECRET: 'hook-secret' });
  const cookie = await login(base, 'boss@test');
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'announcement', severity: 'info', title: 'Town hall Friday', audience: {} }),
  });
  assert.equal(res.status, 201);
  await until(() => hook.hooks.some((h) => h.body.includes('message.sent')), 'the broadcast event');
});

// ── refusals + the pure bits ─────────────────────────────────────────────────

test('misconfiguration is refused at parse or boot, never at send time', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-notify-cfg-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const base = { instance: { name: 'X', baseUrl: 'http://localhost', pack }, dev: { enabled: true } };

  assert.throws(() => parseConfig(JSON.stringify({ ...base, notify: { webhook: { url: 'not a url' } } })), /webhook\.url/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, notify: { smtp: { host: 'relay', from: 'no-at-sign' } } })), /from/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, notify: { smtp: { from: 'a@b' } } })), /host/);
  const defaulted = parseConfig(JSON.stringify({ ...base, notify: { smtp: { host: 'relay.example', from: 'a@b' } } }));
  assert.equal(defaulted.notify.smtp?.port, 587, 'the submission port is the default');
  assert.equal(defaulted.notify.smtp?.secure, false);

  const good = parseConfig(JSON.stringify({ ...base, notify: { webhook: { url: 'https://hooks.example/x' } } }));
  assert.throws(
    () => buildApp({ config: good, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 's', link: 'l' } }),
    /LW_WEBHOOK_SECRET/,
    'an unsigned webhook is refused at boot',
  );
  const authed = parseConfig(JSON.stringify({ ...base, notify: { smtp: { host: 'relay.example', from: 'a@b', user: 'mailer' } } }));
  assert.throws(
    () => buildApp({ config: authed, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 's', link: 'l' } }),
    /LW_SMTP_PASSWORD/,
    'an authenticated relay without its password is refused at boot',
  );
});

test('dataSection dot-stuffs leading dots so a body line cannot end the message', () => {
  assert.equal(dataSection('hello\n.hidden\nworld'), 'hello\r\n..hidden\r\nworld');
  assert.equal(dataSection('plain'), 'plain');
});
