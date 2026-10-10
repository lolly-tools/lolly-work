// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`maintained private caller catalogue (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const result = spawnSync('python3', [...(optimized ? ['-O'] : []), '-B', fileURLToPath(new URL('./test_probe_private_shell_catalog.py', import.meta.url))],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, LOLLY_TEST_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  });
}

test('real pinned P-256 caller oracle rejects altered bytes, visible files, key and lifetime', () => {
  const program = String.raw`
    const {verifyCatalog,fetchBytes}=await import(${JSON.stringify(new URL('../scripts/private-shell-catalog-probe.mjs', import.meta.url).href)});
    const {createHash,generateKeyPairSync,sign}=await import('node:crypto');
    const assert=(await import('node:assert/strict')).default;
    const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
    const hash=b=>createHash('sha256').update(b).digest('hex');
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicJwk=pair.publicKey.export({format:'jwk'});
    const index=Buffer.from('{"syntheticCaller":true}'),expectedFiles={'design/tool.js':hash(Buffer.from('synthetic accepted tool'))};
    const now=Date.now(),notBefore=new Date(now-1000).toISOString();
    const unsigned={alg:'ECDSA-P256-SHA256',files:expectedFiles,indexHash:hash(index),keyId:Buffer.from(hash(Buffer.from(stable(publicJwk))),'hex').toString('base64url'),signedAt:new Date(now).toISOString()};
    const signature=sign('sha256',Buffer.from(stable(unsigned)),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    const envelope=Buffer.from(JSON.stringify({...unsigned,signature})),input={index,envelope,expectedIndex:Buffer.from(index),expectedFiles,publicJwk,notBefore,now};
    assert.equal(verifyCatalog(input).signatureVerified,true);
    for(const changed of [{index:Buffer.from('wrong caller')},{expectedIndex:Buffer.from('wrong oracle')},{expectedFiles:{'design/wrong.js':'a'.repeat(64)}},{now:now-120000},{notBefore:new Date(now+120000).toISOString()},
      {envelope:Buffer.from(JSON.stringify({...unsigned,signature:'AA'}))},{publicJwk:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'})}])assert.throws(()=>verifyCatalog({...input,...changed}));
    for(const url of ['http://example.test/catalog/tools/index.json','https://foreign.test/catalog/tools/index.json','https://example.test/catalog/tools/index.json?token=x','https://example.test/other'])assert.throws(()=>fetchBytes(url,'lw_session=synthetic',100,'https://example.test/'));
    assert.throws(()=>fetchBytes('https://example.test/catalog/tools/index.json','lw_session=synthetic\r\nInjected',100,'https://example.test/'));
    console.log('synthetic cryptographic positive and negatives passed; no HTTPS request issued');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /no HTTPS request issued/);
});
