// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { prepareCodings } from '../scripts/public-shell-codings.mjs';
import { publicFullRootDelta } from '../scripts/prepare-public-shell-update.ts';
import { shellManifest, writeShellJson } from '../scripts/shell-update-files.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'public-codings-'))), candidate = join(root, 'candidate'), source = join(root, 'source');
  mkdirSync(candidate); mkdirSync(join(source, 'scripts'), { recursive: true });
  // Synthetic compressor callable only in these local leaf tests. The real
  // producer's admission additionally requires immutable Lolly Git bytes.
  writeFileSync(join(source, 'scripts/build-delivery.ts'), `import{readdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{gzipSync,brotliCompressSync}from'node:zlib';export function prepareStaticDelivery(root){function walk(p){for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else{const b=readFileSync(f);if(b.length>1024){writeFileSync(f+'.gz',gzipSync(b,{level:9}));writeFileSync(f+'.br',brotliCompressSync(b));}}}}walk(root);}`);
  const put = (path: string, body: string | Uint8Array) => { const p = join(candidate, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  const original = 'original frontend body '.repeat(150);
  for (const path of ['index.html', 'precache.json', 'sw.js', 'portable/player.js', '_app/old.js', 'info/guide-12345678.js']) {
    put(path, original); put(path + '.gz', gzipSync(original, { level: 1 })); put(path + '.br', brotliCompressSync(original));
  }
  put('.delivery-etags.conf', 'original map');
  const previous = writeShellJson(join(root, 'previous.json'), shellManifest(candidate));
  const models = writeShellJson(join(root, 'models.json'), { version: 1, files: [] });
  return { root, candidate, source, put, previous, models,
    request: { version: 1, source, candidate, previous, models, scratch: join(root, 'scratch'), receipt: join(root, 'codings.json') } };
}

test('changed identities get new codings; old app and other protected wire bytes remain exact', async () => {
  const f = fixture();
  try {
    const previous = shellManifest(f.candidate), preserved = new Map(previous.files.filter(row => row.path !== '.delivery-etags.conf' && !row.path.startsWith('index.html')).map(row => [row.path, readFileSync(join(f.candidate, row.path))]));
    const body = 'new edited frontend '.repeat(200); f.put('index.html', body); f.put('_app/new.js', 'new chunk '.repeat(200));
    await prepareCodings(f.request);
    assert.deepEqual(gunzipSync(readFileSync(join(f.candidate, 'index.html.gz'))), Buffer.from(body));
    assert.deepEqual(brotliDecompressSync(readFileSync(join(f.candidate, 'index.html.br'))), Buffer.from(body));
    for (const [path, bytes] of preserved) assert.deepEqual(readFileSync(join(f.candidate, path)), bytes, path);
    const manifest = shellManifest(f.candidate), map = readFileSync(join(f.candidate, '.delivery-etags.conf'), 'utf8');
    for (const path of ['_app/old.js.gz', '_app/new.js.gz', 'info/guide-12345678.js.gz']) assert.ok(map.includes(manifest.files.find(row => row.path === path)!.sha256), path);
    assert.ok(publicFullRootDelta(manifest, previous).files.some(row => row.path === '.delivery-etags.conf'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('small changed entries remove stale sidecars instead of retaining old wire bytes', async () => {
  const f = fixture();
  try {
    f.put('index.html', 'small'); await prepareCodings(f.request);
    assert.equal(existsSync(join(f.candidate, 'index.html.gz')), false); assert.equal(existsSync(join(f.candidate, 'index.html.br')), false);
    assert.equal(readFileSync(join(f.candidate, 'index.html'), 'utf8'), 'small');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a changed protected coding cannot acquire an immutable-retention claim', async () => {
  const f = fixture();
  try {
    f.put('index.html', 'new'); f.put('info/guide-12345678.js.gz', gzipSync('different'));
    await assert.rejects(prepareCodings(f.request), /protected identity and immutable wire/);
    assert.equal(existsSync(f.request.receipt), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a same-path old app coding cannot be recompressed', async () => {
  const f = fixture();
  try {
    f.put('index.html', 'new'); f.put('_app/old.js.gz', gzipSync('original frontend body '.repeat(150), { level: 9 }));
    await assert.rejects(prepareCodings(f.request), /immutable wire/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
