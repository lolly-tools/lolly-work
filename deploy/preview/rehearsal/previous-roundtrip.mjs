// SPDX-License-Identifier: MPL-2.0
// Restore rehearsal, last step. Runs in the PREVIOUS (live) Work image against
// the migrated copy, the way an automatic rollback would. It boots that image's
// server with LW_AUTO_MIGRATE=false, so the server refuses to start if the
// schema lacks any file the previous image expects, then makes one save round
// trip: sign in, create a project and a document, save it, read it back.
//
// The server gets a throwaway evaluation config, random secrets and the
// copy's Unix socket, nothing from the live instance. The output names no
// person and no document content.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROGRAMS = process.env.REHEARSAL_PROGRAMS ?? '/programs';
const APP = process.env.REHEARSAL_APP ?? '/app';
const SOCKET = process.env.REHEARSAL_SOCKET ?? '/socket';
const PORT = Number(process.env.REHEARSAL_HTTP_PORT ?? '18990');
const read = name => readFileSync(join(PROGRAMS, name), 'utf8').trim();

const database = read('database');
const role = read('app-role');
const pgPort = read('postgres-port');
const base = `http://127.0.0.1:${PORT}`;
const name = 'Restore rehearsal';
const email = 'rehearsal@rehearsal.invalid';
const nonce = randomBytes(12).toString('hex');

const config = {
  deployment: { mode: 'evaluation', application: 'api', requireServerRendering: false },
  instance: { name, baseUrl: base, pack: join(APP, 'packs/demo') },
  idp: { issuer: '', clientId: '' },
  policy: { defaultAccessMode: 'open', telemetry: 'off' },
  render: { allowHooksInFastPath: false },
  dev: { enabled: true, users: [{ email, name, groups: ['admin'] }] },
  blobs: { driver: 'pg' },
};

const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'previous-'));
const configPath = join(dir, 'instance.json');
writeFileSync(configPath, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });

const requests = [];
let log = '';
let child = null;
let exit = null;
const started = Date.now();

const finish = (status, extra = {}) => {
  // The server's last lines, for a failure. Addresses are masked: they could be people's.
  const lines = log.split('\n').filter(line => line.trim()).slice(-12)
    .map(line => line.replace(/[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g, '<address>').slice(0, 240));
  process.stdout.write(JSON.stringify({ step: 'previous', status, requests, elapsedMs: Date.now() - started,
    ...(status === 'ROUND_TRIP_OK' ? {} : { serverLog: lines }), ...extra }) + '\n');
};

async function call(method, path, { body, cookie, expect } = {}) {
  const headers = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  requests.push(`${method} ${path.replace(/[0-9a-zA-Z_]{12,}/g, ':id')} ${response.status}`);
  if (expect !== undefined && response.status !== expect) throw new Error(`${method} ${path.split('?')[0]} answered ${response.status}`);
  return { response, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}

try {
  child = spawn(process.execPath, ['server/src/main.ts'], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', HOME: dir, TMPDIR: dir,
      PORT: String(PORT), LW_CONFIG: configPath, LW_AUTO_MIGRATE: 'false', LW_BACKGROUND_POLL_MS: '0',
      LW_SESSION_SECRET: randomBytes(48).toString('hex'), LW_LINK_SECRET: randomBytes(48).toString('hex'),
      DATABASE_URL: `postgresql://${role}@/${database}?host=${SOCKET}&port=${pgPort}`,
    },
  });
  exit = new Promise(resolve => {
    child.once('error', error => resolve({ error: String(error) }));
    // 'close' comes after the output streams end, so the log is complete.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const keep = chunk => { log = (log + chunk).slice(-65536); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  // Boot: with LW_AUTO_MIGRATE=false the previous image exits at once if the
  // migrated schema lacks a file it expects.
  let health = null;
  while (Date.now() - started < 120_000 && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) { health = await response.json(); break; }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!health) throw new Error(child.exitCode !== null ? `the previous image exited during boot (${child.exitCode})` : 'the previous image did not become healthy');
  if (health.name !== name) throw new Error('a different server answered');
  requests.push('GET /healthz 200');

  // One save round trip through the previous image's own API and SQL.
  const signIn = await call('GET', `/api/auth/dev?email=${encodeURIComponent(email)}`, { expect: 302 });
  const cookie = (signIn.response.headers.getSetCookie?.() ?? [signIn.response.headers.get('set-cookie') ?? ''])
    .map(value => value.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('sign-in set no session cookie');
  const project = await call('POST', '/api/v1/projects', { cookie, body: { name: `${name} ${nonce}` }, expect: 201 });
  const projectId = project.json?.id ?? project.json?.project?.id;
  if (typeof projectId !== 'string') throw new Error('project creation returned no id');
  const created = await call('POST', `/api/v1/projects/${projectId}/sessions`,
    { cookie, body: { toolId: 'qr-code', inputs: { text: 'rehearsal' }, meta: {} }, expect: 201 });
  const sessionId = created.json?.id;
  if (typeof sessionId !== 'string' || created.json?.rev !== 1) throw new Error('document creation returned no id or revision');
  const saved = await call('PUT', `/api/v1/sessions/${sessionId}`, { cookie, body: { rev: 1, inputs: { text: nonce } }, expect: 200 });
  if (saved.json?.rev !== 2) throw new Error('the save did not advance the revision');
  const back = await call('GET', `/api/v1/sessions/${sessionId}`, { cookie, expect: 200 });
  if (back.json?.rev !== 2 || back.json?.inputs?.text !== nonce) throw new Error('the saved document did not read back');
  await call('GET', `/api/v1/sessions/${sessionId}/revisions`, { cookie, expect: 200 });

  child.kill('SIGTERM');
  const ended = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 20_000))]);
  finish('ROUND_TRIP_OK', { savedRevision: 2, serverExit: ended ?? 'still running after SIGTERM' });
} catch (error) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (exit) await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000))]);
  finish('FAILED', { reason: String(error?.message ?? error).slice(0, 300) });
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
