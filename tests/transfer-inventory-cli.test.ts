// SPDX-License-Identifier: MPL-2.0
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
const COOKIE = 'lw_session=private_cli_preview_fixture';
const TOKEN = 'lwt_private_preview_fixture';
const ERROR_BODY_SECRET = 'error_body_private_fixture';
const preview = {
  schema: 'lolly-project-transfer-inventory-v1', mode: 'preview', readOnly: true,
  snapshotConsistent: false, complete: false, importReady: false, observedAt: '2026-10-08T13:00:00.000Z',
  project: { id: 'prj_preview', name: 'Shared keynote', archived: false },
  counts: { folders: 2, sessions: 3, files: 1, declaredFileBytes: 4096, explicitMembers: 4, omittedSessions: 1 },
  coverage: { fileBytesVerified: false, assetDependenciesComplete: false, historyComplete: false, identitiesMapped: false },
  folders: [], sessions: [], files: [], access: { members: [] },
  warnings: ['NON_SNAPSHOT', 'ASSET_DEPENDENCIES_NOT_INSPECTED', 'HISTORY_INCOMPLETE', 'IDENTITIES_REQUIRE_MAPPING',
    'FILE_BYTES_NOT_VERIFIED', 'LIVE_COLLABORATION', 'SESSION_ACCESS_OMITTED'],
};

let server: Server;
let base = '';
let home = '';
const requests: Array<{ method: string | undefined; path: string; cookie?: string; authorization?: string }> = [];
const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};
interface Run { code: number; stdout: string; stderr: string }
function lw(args: string[], token?: string, sessionHome = home): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: sessionHome, LW_BASE: base };
    delete env.LW_TOKEN;
    if (token !== undefined) env.LW_TOKEN = token;
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-transfer-preview-cli-'));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    requests.push({ method: req.method, path, cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.method !== 'GET') return json(res, 405, { error: { message: ERROR_BODY_SECRET } });
    if (req.headers.authorization) return json(res, 403, { error: { code: 'MEMBER_SESSION_REQUIRED', message: `${TOKEN} ${COOKIE} ${ERROR_BODY_SECRET}` } });
    if (req.headers.cookie !== COOKIE) return json(res, 401, { error: { message: ERROR_BODY_SECRET } });
    if (path === '/api/v1/projects/prj_preview/transfer-inventory') return json(res, 200, preview);
    if (path === '/api/v1/projects/prj_denied/transfer-inventory') return json(res, 403, { error: { message: ERROR_BODY_SECRET } });
    if (path === '/api/v1/projects/prj_limit/transfer-inventory') return json(res, 413, { error: { message: ERROR_BODY_SECRET } });
    if (path === '/api/v1/projects/prj_malformed/transfer-inventory') return json(res, 200, { ...preview, project: { ...preview.project, id: 'prj_malformed' }, importReady: true });
    if (path === '/api/v1/projects/prj_down/transfer-inventory') {
      res.writeHead(502, { 'content-type': 'text/html' }); res.end(`<html>${ERROR_BODY_SECRET}</html>`); return;
    }
    json(res, 404, { error: { message: ERROR_BODY_SECRET } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  const login = await lw(['login', '--cookie', COOKIE]);
  assert.equal(login.code, 0, login.stderr);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(home, { recursive: true, force: true });
});

test('a signed-in person gets a concise read-only preview through one GET', async () => {
  const before = requests.length;
  const result = await lw(['projects', 'transfer-preview', 'prj_preview']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Shared keynote/);
  assert.match(result.stdout, /2 folders.*3 sessions.*1 ready files.*4096 declared file bytes.*4 explicit members/);
  assert.match(result.stdout, /1 sessions omitted by access policy/);
  assert.match(result.stdout, /Not a consistent snapshot or an import-ready export/);
  assert.match(result.stdout, /Live collaboration was observed/);
  assert.equal(requests.length, before + 1);
  assert.deepEqual(requests.at(-1), { method: 'GET', path: '/api/v1/projects/prj_preview/transfer-inventory', cookie: COOKIE, authorization: undefined });
  assert.equal(result.stdout.includes(COOKIE), false);
  assert.equal(result.stdout.includes(TOKEN), false);
});

test('--json preserves the API inventory object without credentials or extra console prose', async () => {
  const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), preview);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(COOKIE), false);
  assert.equal(result.stdout.includes(TOKEN), false);
});

test('--out creates a new private JSON file and works with --json', async () => {
  const path = join(home, 'preview.json');
  const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--out', path, '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), preview);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), preview);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('--out leaves existing files and symbolic link targets untouched', async () => {
  const path = join(home, 'existing.json'); await writeFile(path, 'Keep this file exactly.');
  const link = join(home, 'linked.json'); await symlink(path, link);
  const absent = join(home, 'absent-target.json');
  const dangling = join(home, 'dangling.json'); await symlink(absent, dangling);
  for (const output of [path, link, dangling]) {
    const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--out', output, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /already exists or is a symbolic link.*choose a new file path/);
  }
  assert.equal(await readFile(path, 'utf8'), 'Keep this file exactly.');
  await assert.rejects(stat(absent), { code: 'ENOENT' });
});

test('filesystem failures are actionable without stack traces', async () => {
  const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--out', join(home, 'missing-parent', 'preview.json')]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /parent folder does not exist.*create it first/);
  assert.equal(result.stderr.includes('Error:'), false);
});

test('an explicit bearer remains authoritative and never retries as the saved human session', async () => {
  const before = requests.length;
  const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--json'], TOKEN);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(requests.length, before + 1);
  assert.deepEqual(requests.at(-1), { method: 'GET', path: '/api/v1/projects/prj_preview/transfer-inventory', cookie: undefined, authorization: `Bearer ${TOKEN}` });
  for (const value of [TOKEN, COOKIE, ERROR_BODY_SECRET]) assert.equal(result.stderr.includes(value), false);
});

test('a person with no saved session gets sign-in guidance without the error payload', async () => {
  const unsignedHome = await mkdtemp(join(home, 'unsigned-'));
  const result = await lw(['projects', 'transfer-preview', 'prj_preview', '--json'], undefined, unsignedHome);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /sign in with lw login/);
  assert.equal(result.stderr.includes(ERROR_BODY_SECRET), false);
  assert.equal(requests.at(-1)?.cookie, undefined);
  assert.equal(requests.at(-1)?.authorization, undefined);
});

test('authorization, limit and gateway failures never print the API error body', async () => {
  for (const [id, explanation] of [['prj_denied', /project manager access/], ['prj_limit', /exceeds the preview limits/], ['prj_down', /instance status/]] as const) {
    const result = await lw(['projects', 'transfer-preview', id, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, explanation);
    assert.equal(result.stderr.includes(ERROR_BODY_SECRET), false);
  }
});

test('unsupported responses cannot be saved or advertised as an import-ready export', async () => {
  const path = join(home, 'unsupported.json');
  const result = await lw(['projects', 'transfer-preview', 'prj_malformed', '--json', '--out', path]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported transfer preview/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('invalid project ids and empty output paths fail before contacting the instance', async () => {
  const before = requests.length;
  for (const args of [['projects', 'transfer-preview', '../private'], ['projects', 'transfer-preview', 'prj_preview', 'extra'],
    ['projects', 'transfer-preview', 'prj_preview', '--out', '']]) {
    const result = await lw(args); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  }
  assert.equal(requests.length, before);
});
