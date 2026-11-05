// SPDX-License-Identifier: MPL-2.0
/** `lw intent resolve` is a thin view over POST /api/v1/intents/resolve. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
const closed = { purpose: 'promote', rulesVersion: 'intent-rules-test' };
const READY = { outcome: 'ready', intentDigest: 'sha256:aa', closed, purposeNeeded: null, surfaces: [{ surface: { id: 'banner' }, status: 'ready', refusal: null,
  chosen: { toolId: 'card', format: 'png', exportDims: { width: 1200, height: 400, unit: 'px' }, sizeSetBy: 'export', gaps: [], unused: [{ role: 'cta', message: 'The tool has no input for cta.' }], defaultsInUse: ['note'], notes: [] } }] };
const NEEDS = { ...READY, outcome: 'needs-content', surfaces: [{ ...READY.surfaces[0], status: 'needs-content', chosen: { ...READY.surfaces[0]!.chosen, gaps: [{ role: 'heading', message: 'The tool cannot serve this purpose without heading.' }] } }, { surface: { id: 'story' }, status: 'refused', refusal: { message: 'No tool can draw story.' }, chosen: null }] };
const ASKS = { ...READY, outcome: 'purpose-needed', closed: { ...closed, purpose: null }, surfaces: [], purposeNeeded: { message: 'Choose a purpose.', purposes: [{ purpose: 'promote', meaning: 'Bring a reader to a page', tools: ['card'] }], surfaces: ['banner'], roles: ['heading'] } };

let server: Server;
let base = '';
let home = '';
const seen: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-cli-intents-'));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    seen.push({ method: req.method!, url: req.url!, body });
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (body.bad) return reply(400, { error: { code: 'INTENT_INVALID', message: 'This intent was refused.' } });
    reply(200, body.purpose === 'promote' ? (body.content ? READY : NEEDS) : ASKS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { server.close(); await rm(home, { recursive: true, force: true }); });

function lw(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--base', base], { env: { ...process.env, HOME: home, LW_TOKEN: 'lwt_test' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}
const write = (name: string, value: unknown): string => { const file = join(home, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };

test('a ready answer exits 0 and says what it will make', async () => {
  const intent = { version: 1, purpose: 'promote', surfaces: [{ id: 'banner' }], content: { heading: 'Hello' } };
  const { code, stdout } = await lw(['intent', 'resolve', write('ready.json', intent)]);
  assert.equal(code, 0);
  assert.deepEqual(seen.at(-1), { method: 'POST', url: '/api/v1/intents/resolve', body: intent });
  assert.match(stdout, /Intent: ready \(promote\)/);
  assert.match(stdout, /banner: ready\. card as png, 1200 x 400 px \(pass this size to the render\)/);
  assert.match(stdout, /Not used, cta/);
  assert.match(stdout, /own wording stays in: note/);
});

test('anything less exits 4 with the full answer, and --json prints it whole', async () => {
  const file = write('needs.json', { version: 1, purpose: 'promote', surfaces: [{ id: 'banner' }, { id: 'story' }] });
  const plain = await lw(['intent', 'resolve', file]);
  assert.equal(plain.code, 4);
  assert.match(plain.stdout, /Needs heading/);
  assert.match(plain.stdout, /story: refused\. No tool can draw story\./);
  const machine = await lw(['intent', 'resolve', file, '--json']);
  assert.equal(machine.code, 4);
  assert.deepEqual(JSON.parse(machine.stdout), NEEDS);
});

test('a prompt with no purpose lists the purposes, read from stdin', async () => {
  const { code, stdout } = await lw(['intent', 'resolve', '-'], JSON.stringify({ version: 1, prompt: 'Make me a poster' }));
  assert.equal(code, 4);
  assert.equal(seen.at(-1)!.body.prompt, 'Make me a poster');
  assert.match(stdout, /Choose a purpose\./);
  assert.match(stdout, /promote\s+Bring a reader to a page \[card\]/);
});

test('a refusal, an unreadable file and a missing argument exit 1 without an answer', async () => {
  const refused = await lw(['intent', 'resolve', write('bad.json', { bad: true })]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /400 INTENT_INVALID/);
  const broken = await lw(['intent', 'resolve', write('broken.json', '{nope')]);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /cannot read intent JSON/);
  assert.equal((await lw(['intent', 'resolve'])).code, 1);
  assert.equal((await lw(['intent'])).code, 1);
});
