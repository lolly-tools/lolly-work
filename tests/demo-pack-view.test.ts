/**
 * The demo's pack view (scripts/demo.ts: resolvePack, buildPackView). The
 * server reads a pack as `<pack>/tools/<id>/` + `<pack>/catalog/`; since the
 * Lolly repo's 2026-09-11 fold a checkout carries neither, so the demo rebuilds
 * that view under packs/oss-view from the OSS resolver, as links. These tests
 * drive buildPackView with a stub resolver over a temp tree, so they need no
 * sibling checkout; the live boot covers the real module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPackView, resolvePack, type ContentRootsLike, type ContentRootsModule,
} from '../scripts/demo.ts';

/** A checkout-shaped tree: one plain community tool, one brand overlay of a
 *  community tool (the overlay carries its own manifest + one file, the base
 *  carries the rest), and the brand's catalog. */
function fakeCheckout(): { root: string; mod: ContentRootsModule; roots: ContentRootsLike; plan: Map<string, { dir: string; base?: string }> } {
  const root = mkdtempSync(join(tmpdir(), 'lw-oss-'));
  const community = join(root, 'community');
  const brandTools = join(root, 'brands', 'acme', 'tools');
  const catalog = join(root, 'brands', 'acme', 'catalog');
  mkdirSync(join(community, 'qr-code'), { recursive: true });
  writeFileSync(join(community, 'qr-code', 'tool.json'), '{"id":"qr-code","inputs":[{"id":"url"}]}');
  writeFileSync(join(community, 'qr-code', 'template.html'), '<svg/>');
  mkdirSync(join(community, 'poster', 'assets'), { recursive: true });
  writeFileSync(join(community, 'poster', 'tool.json'), '{"id":"poster","name":"Poster"}');
  writeFileSync(join(community, 'poster', 'template.html'), '<div/>');
  writeFileSync(join(community, 'poster', 'assets', 'bg.png'), 'png');
  mkdirSync(join(brandTools, 'poster'), { recursive: true });
  writeFileSync(join(brandTools, 'poster', 'tool.json'), '{"extends":"community","id":"poster","name":"Acme poster"}');
  writeFileSync(join(brandTools, 'poster', 'styles.css'), '.p{}');
  mkdirSync(join(catalog, 'tools'), { recursive: true });
  writeFileSync(join(catalog, 'tools', 'index.json'), '{"tools":[]}');

  const plan = new Map<string, { dir: string; base?: string }>([
    ['qr-code', { dir: join(community, 'qr-code') }],
    ['poster', { dir: join(brandTools, 'poster'), base: join(community, 'poster') }],
  ]);
  const roots: ContentRootsLike = { profile: 'acme', catalogRoot: catalog };
  const mod: ContentRootsModule = {
    contentRoots: () => roots,
    toolDirs: () => new Map(plan),
    readToolManifestText: (id) => (id === 'poster' ? '{"id":"poster","name":"Acme poster"}' : readFileSync(join(community, id, 'tool.json'), 'utf8')),
    listToolFiles: (id) => (id === 'poster' ? ['assets/bg.png', 'styles.css', 'template.html', 'tool.json'] : ['template.html', 'tool.json']),
    toolFile: (id, rel) => {
      const entry = plan.get(id)!;
      const overlay = join(entry.dir, rel);
      if (existsSync(overlay)) return overlay;
      return entry.base ? join(entry.base, rel) : null;
    },
  };
  return { root, mod, roots, plan };
}

const isLink = (p: string): boolean => lstatSync(p).isSymbolicLink();

test('buildPackView links plain tools, merges an overlay tool, links the catalog, and stamps its source', () => {
  const { mod, roots, plan } = fakeCheckout();
  const dest = mkdtempSync(join(tmpdir(), 'lw-view-'));
  assert.equal(buildPackView(dest, mod, roots), 2);

  // A plain tool is one link to its directory; the server reads through it.
  assert.ok(isLink(join(dest, 'tools', 'qr-code')));
  assert.equal(readlinkSync(join(dest, 'tools', 'qr-code')), plan.get('qr-code')!.dir);
  assert.match(readFileSync(join(dest, 'tools', 'qr-code', 'tool.json'), 'utf8'), /"url"/);

  // An overlay tool is a real directory: the merged manifest written, every
  // other file a link to whichever side carries it.
  assert.ok(!isLink(join(dest, 'tools', 'poster')));
  assert.equal(readFileSync(join(dest, 'tools', 'poster', 'tool.json'), 'utf8'), '{"id":"poster","name":"Acme poster"}');
  assert.equal(readlinkSync(join(dest, 'tools', 'poster', 'styles.css')), join(plan.get('poster')!.dir, 'styles.css'));
  assert.equal(readlinkSync(join(dest, 'tools', 'poster', 'template.html')), join(plan.get('poster')!.base!, 'template.html'));
  assert.equal(readFileSync(join(dest, 'tools', 'poster', 'assets', 'bg.png'), 'utf8'), 'png');

  assert.ok(isLink(join(dest, 'catalog')));
  assert.equal(readFileSync(join(dest, 'catalog', 'tools', 'index.json'), 'utf8'), '{"tools":[]}');

  const stamp = JSON.parse(readFileSync(join(dest, '.lolly-pack-source.json'), 'utf8')) as { profile: string; tools: number; catalog: string };
  assert.equal(stamp.profile, 'acme');
  assert.equal(stamp.tools, 2);
  assert.equal(stamp.catalog, roots.catalogRoot);
});

test('rebuilding drops stale entries and never follows a link into the checkout', () => {
  const { mod, roots, plan } = fakeCheckout();
  const dest = mkdtempSync(join(tmpdir(), 'lw-view-'));
  buildPackView(dest, mod, roots);
  // Second build with poster gone from the plan: its view entry goes, the
  // checkout's own files (linked from the first build) all survive.
  const smaller = new Map(plan);
  smaller.delete('poster');
  assert.equal(buildPackView(dest, { ...mod, toolDirs: () => new Map(smaller) }, roots), 1);
  assert.ok(!existsSync(join(dest, 'tools', 'poster')));
  assert.ok(existsSync(join(dest, 'tools', 'qr-code', 'tool.json')));
  for (const p of [
    join(plan.get('qr-code')!.dir, 'tool.json'),
    join(plan.get('poster')!.dir, 'styles.css'),
    join(plan.get('poster')!.base!, 'template.html'),
    join(plan.get('poster')!.base!, 'assets', 'bg.png'),
    join(roots.catalogRoot, 'tools', 'index.json'),
  ]) assert.ok(existsSync(p), `${p} survived the rebuild`);
});

test('resolvePack: LOLLY_PACK_DIR wins, a checkout with the layout mounts as it is, and no resolver is said out loud', async () => {
  const prev = process.env.LOLLY_PACK_DIR;
  process.env.LOLLY_PACK_DIR = '/mnt/some-pack';
  try {
    assert.deepEqual(await resolvePack('/anything'), { dir: '/mnt/some-pack', how: 'env' });
  } finally {
    if (prev === undefined) delete process.env.LOLLY_PACK_DIR;
    else process.env.LOLLY_PACK_DIR = prev;
  }

  const laidOut = mkdtempSync(join(tmpdir(), 'lw-root-'));
  mkdirSync(join(laidOut, 'tools'));
  mkdirSync(join(laidOut, 'catalog'));
  assert.deepEqual(await resolvePack(laidOut), { dir: laidOut, how: 'root' });

  const bare = mkdtempSync(join(tmpdir(), 'lw-bare-'));
  const verdict = await resolvePack(bare);
  assert.equal(verdict.how, 'root');
  assert.equal(verdict.dir, bare);
  assert.match(verdict.note ?? '', /no tools\/ \+ catalog\//);
});
