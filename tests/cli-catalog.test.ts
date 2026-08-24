/**
 * The `lw catalog` verbs (plans/31 section 3), exercised as a real subprocess
 * against a real app: an author submits a file, the reviewer sees it in the
 * queue, corrects its metadata and publishes it.
 *
 * Three HOMEs, because the CLI keeps one session file per home and this flow
 * needs three identities: the author who submits, the reviewer who decides, and
 * the admin who files the published asset under the org's own metadata
 * (plans/31 section 4). Nothing here talks to a vendor host, and the blobs live
 * in memory.
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
let adminHome = '';
let store: ReturnType<typeof createMemoryStore>;
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
  adminHome = await mkdtemp(join(tmpdir(), 'lw-cat-admin-'));
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
      // In `design` as well as `admin`: the published asset's exposure was
      // narrowed to that group at submit, and the editor sees only what the
      // feed would hand it.
      { email: 'admin@test', groups: ['admin', 'design'] },
    ] },
  }));
  store = createMemoryStore();
  // One org-defined field (plans/31 section 4), seeded the way the boot seeder
  // would from the governance document, so `lw catalog fields` and
  // `lw catalog meta` have a taxonomy to work against.
  await store.putCatalogField({ id: 'region', label: 'Region', kind: 'select', options: ['EMEA', 'AMER'] });
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

  for (const [home, email] of [[authorHome, 'author@test'], [brandHome, 'brand@test'], [adminHome, 'admin@test']] as const) {
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

test('fields lists the org taxonomy, and meta files a published asset under it', async () => {
  // The published asset from the previous test, listed by its submitter: the
  // queue is two-sided by design, so an admin who is neither the submitter nor
  // on the step sees no rows there at all.
  const all = await lw(authorHome, ['--json', 'catalog', 'queue', '--all']);
  const rows = JSON.parse(all.stdout) as Array<{ id: string; state: string }>;
  const id = rows.find((r) => r.state === 'live')?.id as string;
  assert.ok(id, 'a published submission to file');

  const defs = await lw(adminHome, ['catalog', 'fields']);
  assert.equal(defs.code, 0, defs.stderr);
  assert.match(defs.stdout, /region\s+Region\s+select · EMEA\|AMER/);

  const filed = await lw(adminHome, ['--json', 'catalog', 'meta', id, '--field', 'region=EMEA', '--name', 'Campaign Hero 2026']);
  assert.equal(filed.code, 0, filed.stderr);
  const meta = JSON.parse(filed.stdout) as { id: string; name: string; fields: Record<string, string> };
  assert.equal(meta.name, 'Campaign Hero 2026');
  assert.deepEqual(meta.fields, { region: 'EMEA' });
  assert.equal((await store.getAssetMeta(id))?.fields.region, 'EMEA');

  // A value outside the definition is refused by the server, not by the CLI.
  const bad = await lw(adminHome, ['catalog', 'meta', id, '--field', 'region=APAC']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /INVALID_FIELDS/);
  // A malformed pair never leaves the terminal.
  const malformed = await lw(adminHome, ['catalog', 'meta', id, '--field', 'region']);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /fieldId=value/);
  // An empty value clears it.
  const cleared = await lw(adminHome, ['--json', 'catalog', 'meta', id, '--field', 'region=']);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual((JSON.parse(cleared.stdout) as { fields: Record<string, string> }).fields, {});

  // Filing an asset in is catalog.edit, which the submitting author does not have.
  const refused = await lw(authorHome, ['catalog', 'meta', id, '--field', 'region=EMEA']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /403/);
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

test('collections: assemble an ordered set, list it, and remove it', async () => {
  const published = (await store.listInstanceAssets()).find((r) => r.submission?.state === 'live');
  assert.ok(published, 'the earlier test published one asset for the set to hold');
  const id = published.id;

  // The order given is the order kept, and it is the same list on the way back.
  const made = await lw(adminHome, ['--json', 'catalog', 'collection', 'launch-kit',
    '--name', 'Launch kit', '--members', `${id},${id}`, '--groups', 'design', '--label', 'Spring launch.']);
  assert.equal(made.code, 0, made.stderr);
  const rec = JSON.parse(made.stdout) as { id: string; name: string; members: string[]; groups: string[] };
  assert.equal(rec.name, 'Launch kit');
  assert.deepEqual(rec.members, [id], 'a repeat collapses to its first position');
  assert.deepEqual(rec.groups, ['design']);

  const listed = await lw(adminHome, ['catalog', 'collections']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /launch-kit/);
  assert.match(listed.stdout, /Launch kit/);

  // Curating is its own action, and the submitting author does not hold it.
  const refused = await lw(authorHome, ['catalog', 'collection', 'sneaky', '--name', 'Sneaky']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /403/);

  const nothing = await lw(adminHome, ['catalog', 'collection', 'launch-kit']);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /nothing to change/);

  const removed = await lw(adminHome, ['catalog', 'collection', 'launch-kit', '--rm']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(await store.getCollection('launch-kit'), null);
});

test('versions: replace the bytes of a published asset, list, roll back, supersede', async () => {
  const published = (await store.listInstanceAssets()).find((r) => r.submission?.state === 'live');
  assert.ok(published, 'the earlier test published one asset to version');
  const id = published.id;

  // New bytes for an existing id: same file, same command, one flag.
  const next = join(dirname(file), 'campaign-hero-v2.png');
  await writeFile(next, Buffer.concat([PNG, Buffer.from('take two')]));
  const made = await lw(adminHome, ['--json', 'catalog', 'submit', next, '--asset', id, '--note', 'reshot in studio']);
  assert.equal(made.code, 0, made.stderr);
  const body = JSON.parse(made.stdout) as { assetId: string; version: number };
  assert.equal(body.assetId, id, 'the id is durable');
  assert.equal(body.version, 2);

  const listed = await lw(adminHome, ['catalog', 'versions', id]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /v2/);
  assert.match(listed.stdout, /reshot in studio/);
  assert.match(listed.stdout, /keeping every version/);

  // Contributing is the author's right; replacing published bytes is not.
  const refused = await lw(authorHome, ['catalog', 'submit', next, '--asset', id]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /403/);

  const back = await lw(adminHome, ['catalog', 'rollback', id, '1']);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /now serves version 1/);
  assert.equal((await store.getInstanceAsset(id))?.headVersion, 1);

  // The version that was head is still there, and is now deletable.
  const dropped = await lw(adminHome, ['catalog', 'version-rm', id, '2']);
  assert.equal(dropped.code, 0, dropped.stderr);
  assert.deepEqual((await store.listAssetVersions(id)).map((v) => v.version), [1]);

  const supersede = await lw(adminHome, ['catalog', 'supersede', id, id]);
  assert.equal(supersede.code, 1, 'an asset cannot replace itself');
  assert.match(supersede.stderr, /itself/);
});
