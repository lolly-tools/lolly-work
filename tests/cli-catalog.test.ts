/**
 * The `lw catalog` verbs (plans/31 section 3), exercised as a real subprocess
 * against a real app: an author submits a file, the reviewer sees it in the
 * queue, corrects its metadata and publishes it.
 *
 * Two HOMEs, because the CLI keeps one session file per home and this flow
 * needs two identities: the author who submits and the reviewer who decides.
 * Nothing here talks to a vendor host, and the blobs live in memory.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');

/** A 1x1 PNG, real enough that the server's sniffer reads its IHDR. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

let server: Server;
let base = '';
let authorHome = '';
let brandHome = '';
let file = '';

interface Run { code: number; stdout: string; stderr: string }

function lw(home: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: base },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.stdin.end('\n');
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

before(async () => {
  authorHome = await mkdtemp(join(tmpdir(), 'lw-cat-author-'));
  brandHome = await mkdtemp(join(tmpdir(), 'lw-cat-brand-'));
  const pack = await mkdtemp(join(tmpdir(), 'lw-cat-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  file = join(pack, 'campaign-hero.png');
  await writeFile(file, PNG);

  const config = parseConfig(JSON.stringify({
    instance: { name: 'CLI Catalog', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy: { submit: { chain: 'brand-review' } },
    dev: { enabled: true, users: [
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
    ] },
  }));
  const store = createMemoryStore();
  await store.putChain({
    id: 'brand-review', name: 'Brand review',
    steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }],
    onReject: 'return-to-submitter',
  });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sc', link: 'lc' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  for (const [home, email] of [[authorHome, 'author@test'], [brandHome, 'brand@test']] as const) {
    const login = await lw(home, ['login', '--email', email]);
    assert.equal(login.code, 0, login.stderr);
  }
});

after(() => server.close());

test('submit puts a local file in, and says which state it landed in', async () => {
  const r = await lw(authorHome, ['catalog', 'submit', file, '--name', 'Campain Hero', '--tags', 'campaign, hero', '--groups', 'design']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[submitted\]/, 'a chain is configured, so it waits rather than going live');
  assert.match(r.stdout, /waiting on the submit chain/);
});

test('queue shows the reviewer their step, edit corrects it, approve publishes it', async () => {
  const listed = await lw(brandHome, ['--json', 'catalog', 'queue']);
  assert.equal(listed.code, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as Array<{ id: string; name: string; relation: string; state: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.relation, 'inbox');
  const id = rows[0]?.id as string;

  const fixed = await lw(brandHome, ['--json', 'catalog', 'edit', id, '--name', 'Campaign Hero', '--tags', 'campaign,hero,q4']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const view = JSON.parse(fixed.stdout) as { name: string; tags: string[] };
  assert.equal(view.name, 'Campaign Hero');
  assert.deepEqual(view.tags, ['campaign', 'hero', 'q4']);

  // An edit with no field named is refused rather than sending an empty patch.
  const empty = await lw(brandHome, ['catalog', 'edit', id]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /nothing to change/);

  const approved = await lw(brandHome, ['catalog', 'approve', id, '--body', 'on brand']);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /is now live/);

  // Now that it is published, identical bytes are reported and stored no second
  // time. Only NOW: while it was under review those same bytes were not in the
  // catalog, so short-circuiting onto them would have dropped a contribution
  // behind an asset that might never go live.
  const again = await lw(authorHome, ['catalog', 'submit', file, '--name', 'Campaign Hero Again']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already in the catalog as inst\//);

  // Pending-only by default; --all still finds the published row.
  const pending = await lw(brandHome, ['catalog', 'queue']);
  assert.match(pending.stdout, /nothing waiting on review/);
  const all = await lw(authorHome, ['catalog', 'queue', '--all']);
  assert.match(all.stdout, /live\s+mine\s+inst\//);
});

test('a returned submission carries the reason back, and cannot be decided twice', async () => {
  // Distinct bytes, or the duplicate short-circuit would hand back the asset
  // the previous test already published.
  const other = join(dirname(file), 'draft-poster.svg');
  await writeFile(other, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  const fresh = await lw(authorHome, ['--json', 'catalog', 'submit', other, '--name', 'Draft Poster']);
  const { assetId } = JSON.parse(fresh.stdout) as { assetId: string };

  const returned = await lw(brandHome, ['catalog', 'return', assetId, '--body', 'wrong logo lockup']);
  assert.equal(returned.code, 0, returned.stderr);
  assert.match(returned.stdout, /is now returned/);

  const twice = await lw(brandHome, ['catalog', 'return', assetId, '--body', 'again']);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /already returned/);
});
