// SPDX-License-Identifier: MPL-2.0
/** Local real Nginx fixture; supplied maintained Lolly source is never edited. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { compileMap, verifyCodings } from '../scripts/public-delivery-map.mjs';

const source = resolve(process.argv[2] ?? '');
const nginx = resolve(process.argv[3] ?? '');
assert(source.endsWith('/scripts/build-delivery.ts') && nginx.endsWith('/nginx'), 'Exact source/native fixture arguments required');
const { prepareStaticDelivery } = await import(pathToFileURL(source).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'lolly-public-full-root-native-'));
let running;
try {
  const site = join(root, 'site'); mkdirSync(site);
  const identities = {'index.html': Buffer.from('world class public shell '.repeat(400)),
    'view/tools.html': Buffer.from('Tools '.repeat(400)), 't/design.html': Buffer.from('Design '.repeat(400)),
    'info/index.html': Buffer.from('Docs '.repeat(400)), '_app/current.js': Buffer.from('console.log("latest");'.repeat(400)),
    'tools/example@1234567890abcdef/hooks.js': Buffer.from('export const run=()=>42;'.repeat(400))};
  for (const [path, bytes] of Object.entries(identities)) {
    const file = join(site, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, bytes);
  }
  const modelHash = hash('model bytes here!');
  const directory = hash(`weights.onnx\0${16}\0${modelHash}\n`).slice(0,16);
  const models = [{url:`/models/test@${directory}/weights.onnx`,size:16,sha256:modelHash}];
  prepareStaticDelivery(site, { mountedModels: models });
  function rows(directory = site) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return rows(path);
      return entry.name === '.delivery-etags.conf' ? [] : [{path:path.slice(site.length + 1),size:statSync(path).size,sha256:hash(readFileSync(path))}];
    }).sort((a,b) => a.path < b.path ? -1 : 1);
  }
  const physical = rows(); const compiled = compileMap(physical, models);
  assert.equal(compiled, readFileSync(join(site, '.delivery-etags.conf'), 'utf8'), 'Exact maintained seven-map semantic/byte parity');
  assert.equal(await verifyCodings(site, physical), physical.filter(row => /\.(br|gz)$/.test(row.path)).length);
  const old = Buffer.from('retained application '.repeat(400)); const wire = gzipSync(old, {level:9});
  writeFileSync(join(site, '_app/old.js'), old); writeFileSync(join(site, '_app/old.js.gz'), wire);
  const { utimesSync } = await import('node:fs'); utimesSync(join(site, '_app/old.js'), 0, 0); utimesSync(join(site, '_app/old.js.gz'), 0, 0);
  const full = compileMap(rows(), models); writeFileSync(join(root, 'etags.conf'), full);
  const other = Buffer.from('different identity '.repeat(400));
  assert.throws(() => compileMap([{path:'_app/a.js.gz',size:5,sha256:hash('orphan')}]), /Orphan/);
  assert.throws(() => compileMap(physical, [models[0],models[0]]), /Duplicate/);
  writeFileSync(join(site, '_app/corrupt.js'), other); writeFileSync(join(site, '_app/corrupt.js.br'), brotliCompressSync(old));
  await assert.rejects(verifyCodings(site, [{path:'_app/corrupt.js',size:other.length,sha256:hash(other)},
    {path:'_app/corrupt.js.br',size:statSync(join(site,'_app/corrupt.js.br')).size,sha256:hash(readFileSync(join(site,'_app/corrupt.js.br')))}]), /bound|differs/);
  rmSync(join(site,'_app/corrupt.js')); rmSync(join(site,'_app/corrupt.js.br'));
  const port = async () => { const s=createServer(); await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p; };
  const inner = await port(), outer = await port();
  const config = `pid ${root}/nginx.pid; error_log ${root}/error.log; events {} http {
    include ${root}/etags.conf;
    server { listen 127.0.0.1:${inner}; root ${site}; if_modified_since off;
      gzip_static on; gzip on; gzip_types application/javascript text/html; gzip_vary on;
      add_header X-Lolly-Content-ETag $lolly_delivery_etag;
      location / { try_files $uri =404; }
    }
    server { listen 127.0.0.1:${outer}; location / {
      proxy_pass http://127.0.0.1:${inner}; proxy_set_header If-None-Match $lolly_native_if_none_match;
      proxy_set_header If-Range $lolly_native_if_range; proxy_hide_header ETag; proxy_hide_header Last-Modified;
      proxy_hide_header X-Lolly-Content-ETag; add_header ETag $lolly_response_etag;
    }}
  }`;
  writeFileSync(join(root, 'nginx.conf'), config);
  const syntax = spawnSync(nginx, ['-t','-c',join(root,'nginx.conf'),'-p',root], {encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  running = spawn(nginx,['-c',join(root,'nginx.conf'),'-p',root,'-g','daemon off;'],{stdio:'ignore'});
  const request = async (path, headers={}) => fetch(`http://127.0.0.1:${outer}${path}`,{headers:{'Accept-Encoding':'identity',...headers}});
  let ready=false;
  for(let i=0;i<40;i++){try {await request('/_app/old.js');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
  assert(ready,'Actual native listener did not start');
  const identity = await request('/_app/old.js'); assert.equal(identity.status,200); assert.equal(identity.headers.get('etag'),`"${hash(old)}"`);
  assert.equal(hash(Buffer.from(await identity.arrayBuffer())),hash(old)); assert.equal(identity.headers.get('last-modified'),null);
  const matched = await request('/_app/old.js',{'If-None-Match':`"${hash(old)}"`}); assert.equal(matched.status,304);
  const ranged = await request('/_app/old.js',{'Range':'bytes=0-9','If-Range':`"${hash(old)}"`}); assert.equal(ranged.status,206); assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(),old.subarray(0,10).toString());
  const stale = await request('/_app/old.js',{'Range':'bytes=0-9','If-Range':'"0-1"'}); assert.equal(stale.status,200);
  // Fetch decodes gzip; the ETag remains the exact compressed wire identity.
  const gzip = await request('/_app/old.js',{'Accept-Encoding':'gzip'}); assert.equal(gzip.status,200); assert.equal(gzip.headers.get('etag'),`"${hash(wire)}"`); assert.equal(gzip.headers.get('content-encoding'),'gzip');
  const cross = await request('/_app/old.js',{'Accept-Encoding':'gzip','If-None-Match':`"${hash(old)}"`}); assert.equal(cross.status,200);
  assert.equal((await request('/_app/missing.js')).status,404);
  console.log(JSON.stringify({status:'ACTUAL_LOCAL_NATIVE_FULL_ROOT_FIXTURE_PASSED',mapParity:true,
    codingStreamsVerified:true,retainedIdentity200:true,fullSha304:true,ifRange206:true,staleIfRange200:true,
    gzipWireEtag:true,crossCoding200:true,missing404:true,productionMutation:false,publicCandidateQualified:false}));
} finally {
  if (running) {running.kill('SIGTERM');await new Promise(resolve=>running.once('exit',resolve));}
  rmSync(root,{recursive:true,force:true});
}
