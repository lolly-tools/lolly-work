import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'lw.ts');
const AT = '/api/v1/programmes/resellers';
const PROGRAMME = {
  id: 'resellers', name: 'Resellers', description: 'Regional partners', team: 'sales',
  group: 'programme-resellers', tools: ['poster', 'badge'], collections: [], members: [],
};
const COMPANY = { id: 'acme', programmeId: 'resellers', name: 'Acme Partners' };
const PUBLICATION = { id: 'inst/published', groups: ['programme-resellers'], editable: ['headline'], bindings: { logo: 'logoLight' } };

interface Exchange {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: Buffer;
  answer: unknown;
  status?: number;
}

let home = '';
let preload = '';
let runNumber = 0;
before(() => {
  home = mkdtempSync(join(ROOT, '.cli-programmes-'));
  preload = join(home, 'fake-api.mjs');
  writeFileSync(preload, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const replies = JSON.parse(readFileSync(process.env.LW_CLI_REPLIES, 'utf8'));
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const request = new Request(url, options);
      const address = new URL(request.url);
      const bytes = Buffer.from(await request.arrayBuffer());
      const reply = replies[requests.length];
      requests.push({ method: request.method, path: address.pathname + address.search,
        bytes: bytes.toString('base64'), contentType: request.headers.get('content-type'),
        authorization: request.headers.get('authorization') });
      writeFileSync(process.env.LW_CLI_REQUESTS, JSON.stringify(requests));
      return Response.json(reply?.answer ?? { error: { code: 'UNEXPECTED_REQUEST', message: 'no reply prepared' } },
        { status: reply?.status ?? (reply ? 200 : 500) });
    };
  `);
});
after(() => { rmSync(home, { recursive: true, force: true }); });

/** Exercise the real CLI against a fake API in memory and check every request. */
async function lw(args: string[], exchanges: Exchange[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = ++runNumber;
  const repliesFile = join(home, `replies-${run}.json`);
  const requestsFile = join(home, `requests-${run}.json`);
  writeFileSync(repliesFile, JSON.stringify(exchanges));
  writeFileSync(requestsFile, '[]');
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: 'http://cli.test', LW_TOKEN: 'programme-test-token',
        LW_CLI_REPLIES: repliesFile, LW_CLI_REQUESTS: requestsFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  const requests = JSON.parse(readFileSync(requestsFile, 'utf8')) as Array<{ method: string; path: string; bytes: string; contentType: string | null; authorization: string | null }>;
  assert.equal(requests.length, exchanges.length, result.stderr);
  for (const [index, expected] of exchanges.entries()) {
    const actual = requests[index]!;
    const bytes = Buffer.from(actual.bytes, 'base64');
    assert.equal(actual.method, expected.method);
    assert.equal(actual.path, expected.path);
    assert.equal(actual.authorization, 'Bearer programme-test-token');
    if (expected.rawBody !== undefined) {
      assert.deepEqual(bytes, expected.rawBody);
      assert.equal(actual.contentType, 'application/octet-stream');
    } else if (expected.body !== undefined) {
      assert.deepEqual(JSON.parse(bytes.toString()), expected.body);
      assert.equal(actual.contentType, 'application/json');
    } else {
      assert.equal(bytes.length, 0);
    }
  }
  return result;
}

test('programmes create sends the name, description, team and tool list', async () => {
  const result = await lw(['programmes', 'create', 'resellers', '--name', 'Resellers', '--description', 'Regional partners', '--team', 'sales', '--tools', 'poster, badge'], [
    { method: 'PUT', path: AT, body: { name: 'Resellers', description: 'Regional partners', team: 'sales', tools: ['poster', 'badge'] }, answer: PROGRAMME, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /resellers\s+Resellers\s+programme-resellers/);
  assert.match(result.stdout, /team sales\s+tools poster, badge/);
});

test('programmes create omits optional fields and supports JSON output', async () => {
  const result = await lw(['--json', 'programmes', 'create', 'resellers', '--name', 'Resellers'], [
    { method: 'PUT', path: AT, body: { name: 'Resellers' }, answer: PROGRAMME, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), PROGRAMME);
});

test('programmes set preserves the name and description while leaving omitted tools and team to the route', async () => {
  const result = await lw(['programmes', 'set', 'resellers', '--tools', 'badge'], [
    { method: 'GET', path: AT, answer: PROGRAMME },
    { method: 'PUT', path: AT, body: { name: 'Resellers', description: 'Regional partners', tools: ['badge'] }, answer: { ...PROGRAMME, tools: ['badge'] } },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Regional partners/);
  assert.match(result.stdout, /tools badge/);
});

test('programmes set accepts explicit clears and a new name', async () => {
  const result = await lw(['programmes', 'set', 'resellers', '--name', 'Partners', '--description', '', '--team', '', '--tools', ''], [
    { method: 'GET', path: AT, answer: PROGRAMME },
    { method: 'PUT', path: AT, body: { name: 'Partners', description: '', team: '', tools: [] }, answer: { ...PROGRAMME, name: 'Partners', description: '', team: '', tools: [] } },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Partners/);
});

test('programmes lists by default and with ls, shows details and removes a programme', async () => {
  for (const args of [['programmes'], ['programmes', 'ls']]) {
    const result = await lw(args, [{ method: 'GET', path: '/api/v1/programmes', answer: { programmes: [PROGRAMME] } }]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /resellers\s+Resellers\s+2 tool\(s\)\s+0 member\(s\)/);
  }
  const shown = await lw(['programmes', 'show', 'resellers'], [{ method: 'GET', path: AT, answer: PROGRAMME }]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Regional partners/);
  const removed = await lw(['programmes', 'rm', 'resellers'], [{ method: 'DELETE', path: AT, answer: { ok: true } }]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /removed programme resellers/);
});

test('companies add uses the programme company route', async () => {
  const result = await lw(['companies', 'add', 'resellers', 'acme', '--name', 'Acme Partners'], [
    { method: 'PUT', path: `${AT}/companies/acme`, body: { name: 'Acme Partners' }, answer: COMPANY, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /acme\s+Acme Partners/);
});

test('companies lists through the people response and removes a company', async () => {
  for (const args of [['companies', 'resellers'], ['companies', 'ls', 'resellers']]) {
    const result = await lw(args, [{ method: 'GET', path: `${AT}/people`, answer: { programme: 'resellers', companies: [COMPANY], people: [], invited: [] } }]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /acme\s+Acme Partners/);
  }
  const removed = await lw(['companies', 'rm', 'resellers', 'acme'], [{ method: 'DELETE', path: `${AT}/companies/acme`, answer: { ok: true } }]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /removed acme from resellers/);
});

test('templates publish sends editable inputs and company bindings', async () => {
  const result = await lw(['--json', 'templates', 'publish', 'resellers', '--from', 'inst/source', '--groups', 'programme-resellers, company-acme', '--editable', 'headline, caption', '--bindings', 'logo=logoLight, footer=contactEmail'], [
    { method: 'POST', path: `${AT}/templates`, body: { from: 'inst/source', groups: ['programme-resellers', 'company-acme'], editable: ['headline', 'caption'], bindings: { logo: 'logoLight', footer: 'contactEmail' } }, answer: PUBLICATION, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), PUBLICATION);
});

test('templates publish maps editable all to null', async () => {
  const result = await lw(['templates', 'publish', 'resellers', '--from', 'inst/source', '--groups', 'programme-resellers', '--editable', 'all'], [
    { method: 'POST', path: `${AT}/templates`, body: { from: 'inst/source', groups: ['programme-resellers'], editable: null }, answer: { ...PUBLICATION, editable: null }, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /inst\/published\s+published\s+programme-resellers/);
});

test('templates upload sends the exact file bytes with encoded audience groups', async () => {
  const file = join(home, 'rules.lolly');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0a]);
  writeFileSync(file, bytes);
  const result = await lw(['templates', 'upload', 'resellers', file, '--groups', 'programme-resellers, company-acme'], [
    { method: 'POST', path: `${AT}/templates/rules-file?groups=programme-resellers%2Ccompany-acme`, rawBody: bytes, answer: { id: 'inst/rules', state: 'live', groups: ['programme-resellers', 'company-acme'] }, status: 201 },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /inst\/rules\s+uploaded\s+\[live\]/);
});

test('templates set accepts a full asset id and sends only the named fields', async () => {
  const result = await lw(['templates', 'set', 'resellers', 'inst/published', '--groups', 'company-acme', '--editable', 'all', '--bindings', 'footer=contactEmail'], [
    { method: 'PUT', path: `${AT}/templates/published`, body: { groups: ['company-acme'], editable: null, bindings: { footer: 'contactEmail' } }, answer: PUBLICATION },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /inst\/published\s+updated/);
  const clear = await lw(['templates', 'set', 'resellers', 'published', '--bindings', '', '--editable', ''], [
    { method: 'PUT', path: `${AT}/templates/published`, body: { bindings: {}, editable: [] }, answer: PUBLICATION },
  ]);
  assert.equal(clear.code, 0, clear.stderr);
});

test('templates retire and restore accept full or short asset ids', async () => {
  const retired = await lw(['templates', 'retire', 'resellers', 'inst/published', '--replaced-by', 'inst/replacement'], [
    { method: 'POST', path: `${AT}/templates/published/retire`, body: { replacedBy: 'inst/replacement' }, answer: { id: 'inst/published', retiredAt: '2026-11-07T12:00:00.000Z', replacedBy: 'inst/replacement' } },
  ]);
  assert.equal(retired.code, 0, retired.stderr);
  assert.match(retired.stdout, /retired\s+replaced by inst\/replacement/);
  const restored = await lw(['templates', 'restore', 'resellers', 'published'], [
    { method: 'POST', path: `${AT}/templates/published/restore`, answer: { id: 'inst/published' } },
  ]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /inst\/published\s+restored/);
});

test('templates lists published rows and their rules by default and with ls', async () => {
  const answer = { templatesOnly: ['poster'], templates: [{ ...PUBLICATION, name: 'Partner poster', toolName: 'Poster', version: 2, state: 'live' }] };
  for (const args of [['templates', 'resellers'], ['templates', 'ls', 'resellers']]) {
    const result = await lw(args, [{ method: 'GET', path: `${AT}/templates`, answer }]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /templates only: poster/);
    assert.match(result.stdout, /inst\/published\s+Partner poster\s+Poster\s+v2\s+\[live\]/);
    assert.match(result.stdout, /editable headline/);
  }
});

test('templates only sends boolean on and off values', async () => {
  for (const state of ['on', 'off']) {
    const result = await lw(['templates', 'only', 'resellers', 'poster', state], [
      { method: 'PUT', path: `${AT}/templates-only/poster`, body: { on: state === 'on' }, answer: { programme: 'resellers', toolId: 'poster', on: state === 'on' } },
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`resellers\\s+poster\\s+templates only ${state}`));
  }
});

test('server failures pass the status, code and message through', async () => {
  const result = await lw(['programmes', 'show', 'missing'], [
    { method: 'GET', path: '/api/v1/programmes/missing', status: 404, answer: { error: { code: 'NOT_FOUND', message: 'no such programme' } } },
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'lw: 404 NOT_FOUND no such programme');
});

test('required arguments and malformed bindings fail before sending a request', async () => {
  for (const args of [
    ['programmes', 'create', 'resellers'],
    ['programmes', 'set', 'resellers'],
    ['companies', 'add', 'resellers', 'acme'],
    ['templates', 'publish', 'resellers', '--groups', 'programme-resellers'],
    ['templates', 'upload', 'resellers', 'missing.lolly'],
    ['templates', 'only', 'resellers', 'poster', 'yes'],
    ['templates', 'set', 'resellers', 'published', '--bindings', 'logo'],
  ]) {
    const result = await lw(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /usage:|nothing to change|--bindings takes input=field/);
  }
});

test('help describes every new command on a separate line', async () => {
  const result = await lw(['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const command of ['programmes [ls]', 'programmes show', 'programmes create', 'programmes set', 'programmes rm',
    'companies [ls]', 'companies add', 'companies rm', 'templates [ls]', 'templates publish', 'templates upload',
    'templates set', 'templates retire', 'templates restore', 'templates only']) {
    const line = result.stdout.split('\n').find((entry) => entry.startsWith(`  ${command}`));
    assert.ok(line, command);
    assert.ok(!line.includes('—'), line);
    assert.doesNotMatch(line, /, and\b|\bit[.!?]?\s*$/);
  }
});

test('programmes rights-report prints the mode, sources, pack prefixes and templates that seed held files', async () => {
  const report = {
    programme: { name: 'Resellers' }, rules: 'rights-rules-x', mode: { mode: 'report', line: 'Report only: set in configuration (policy.catalog.partnerRights).' },
    totals: { assets: 4, travel: 1, held: 3, exempt: 0, sharedAnyway: 0, needsChoosing: 0 },
    sources: [{ label: 'Launch kit', assets: 4, exempt: 0, travel: { count: 1, byLicence: [{ licence: 'CC BY 4.0', count: 1 }] }, held: { count: 3, byReason: [{ label: 'licence not recorded', count: 3 }] } }],
    links: { count: 0, files: 0, links: [], more: 0 },
    prefixes: [{ sentences: ['2 files under acme/ declare LicenseRef-Acme-Internal, an identifier these rules do not carry.'], clearedBy: 'The owner can record these as owner-published in the pack, or the rules can be widened. Ask your Lolly administrator.' }],
    templates: [{ name: 'Partner price sheet', audiences: [{ name: 'Northwind IT', files: [{ name: 'Office photo', why: 'licence', reason: 'licence not recorded' }, { name: 'Internal photo', why: 'not-shared' }] }] }],
  };
  const result = await lw(['programmes', 'rights-report', 'resellers'], [{ method: 'GET', path: `${AT}/rights-report`, answer: report }]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Report only: set in configuration/m);
  assert.match(result.stdout, /Resellers: 4 file\(s\); 1 travel, 3 would be held back, 0 shared anyway, 0 need choosing again, 0 exempt/);
  assert.match(result.stdout, /^2 files under acme\/ declare LicenseRef-Acme-Internal/m);
  assert.match(result.stdout, /^ {2}The owner can record these as owner-published/m);
  assert.match(result.stdout, /^template Partner price sheet uses 2 file\(s\) Northwind IT will not receive: Office photo \(licence not recorded\), Internal photo \(not shared with them\)$/m);
});
