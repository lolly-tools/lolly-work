// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createRouter } from '../server/src/api/router.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { registerPasskeyRoutes, passkeysEnabled, safePasskeyReturn } from '../server/src/iam/passkeys/routes.ts';
import { mintSessionCookie, readPrincipal } from '../server/src/iam/sessions.ts';
import { resolveMember } from '../server/src/iam/member.ts';
import { passkeyStoreConformance } from './passkey-store-conformance.ts';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest();
function authenticator(rpID: string) {
  const {privateKey,publicKey} = generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const id=randomBytes(32),cose=isoCBOR.encode(new Map<number,number | Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
  const auth=(counter: number,flags: number) => {const tail=Buffer.alloc(5);tail[0]=flags;tail.writeUInt32BE(counter,1);return Buffer.concat([hash(rpID),tail]);};
  function client(type: string,challenge: string,origin: string) {return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false}));}
  return {id:b64(id),
    registration(challenge: string,origin: string,uv=true) {
      const length=Buffer.alloc(2);length.writeUInt16BE(id.length);
      const authData=Buffer.concat([auth(0,uv?0x45:0x41),Buffer.alloc(16),length,id,cose]);
      return {id:b64(id),rawId:b64(id),type:'public-key' as const,response:{clientDataJSON:b64(client('webauthn.create',challenge,origin)),attestationObject:b64(isoCBOR.encode(new Map<string,string | Uint8Array | Map<string,never>>([['fmt','none'],['attStmt',new Map<string,never>()],['authData',new Uint8Array(authData)]]))),transports:['internal']},clientExtensionResults:{credProps:{rk:true}}};
    },
    assertion(challenge: string,origin: string,userId: string,counter=1,uv=true) {
      const clientData=client('webauthn.get',challenge,origin),data=auth(counter,uv?5:1);
      return {id:b64(id),rawId:b64(id),type:'public-key' as const,response:{clientDataJSON:b64(clientData),authenticatorData:b64(data),signature:b64(sign('sha256',Buffer.concat([data,hash(clientData)]),privateKey)),userHandle:b64(Buffer.from(userId))},clientExtensionResults:{}};
    },
  };
}
async function fixture(t: import('node:test').TestContext) {
  const store=createMemoryStore(),user=await store.upsertUserBySub({sub:'key-user',email:'key@example.test',groups:[],role:'member'}),other=await store.upsertUserBySub({sub:'other',email:'other@example.test',groups:[],role:'member'});
  const router=createRouter();const server=createServer((q,s)=>void router.dispatch(q,s));await new Promise<void>(r=>server.listen(0,r));const address=server.address();assert.ok(address&&typeof address==='object');const base='http://localhost:'+address.port,secret='test-passkey-secret';
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  registerPasskeyRoutes(router,{store,baseUrl:base,instanceName:'Keys',secret,verifySecrets:[secret],sessionTtlSec:3600,memberOf:q=>resolveMember(store,q.headers.cookie,secret),audit:async()=>{}});
  const cookie=(u=user,at=Date.now())=>mintSessionCookie({sub:u.sub,email:u.email,name:u.email,groups:u.groups,role:u.role,epoch:u.sessionEpoch,authenticatedAt:at},secret,false).split(';')[0]!;
  async function post(path: string,data: unknown={},cookies='',origin=base) {return fetch(base+'/api/auth/passkeys/'+path,{method:'POST',headers:{'content-type':'application/json',origin,...(cookies?{cookie:cookies}:{})},body:JSON.stringify(data)});}
  async function options(kind='authenticate',cookies='') {const r=await post(kind+'/options',{returnTo:'/#/p'},cookies);assert.equal(r.status,200);const data=await r.json() as {options:{challenge:string}};return {challenge:data.options.challenge,cookies:r.headers.getSetCookie()[0]!.split(';')[0]!+(cookies?'; '+cookies:'')};}
  return {store,user,other,base,secret,cookie,post,options};
}

test('passkeys verify real signatures, bind one-use challenges to the browser and sign into the existing account',async t=>{
  const f=await fixture(t),a=authenticator('localhost');let o=await f.options('register',f.cookie());
  const reg=a.registration(o.challenge,f.base);assert.equal((await f.post('register/verify',{response:reg,label:'Laptop'},o.cookies)).status,201);
  assert.equal((await f.store.listPasskeys(f.user.id)).length,1);
  assert.equal((await f.post('register/verify',{response:reg,label:'Replay'},o.cookies)).status,400);
  o=await f.options();const response=a.assertion(o.challenge,f.base,f.user.id);assert.equal((await f.post('authenticate/verify',{response})).status,400,'another browser cannot spend the challenge');
  const login=await f.post('authenticate/verify',{response},o.cookies);assert.equal(login.status,200);const session=login.headers.getSetCookie().find(c=>c.startsWith('lw_session='));assert.ok(session);const principal=readPrincipal(session,f.secret);assert.equal(principal?.kind,'member');if(principal?.kind==='member')assert.equal(principal.user.sub,f.user.sub);
  assert.equal((await f.post('authenticate/verify',{response},o.cookies)).status,400,'signed responses cannot be replayed');
  assert.equal((await f.store.getPasskey(a.id))?.counter,1);
  assert.equal((await f.post(encodeURIComponent(a.id)+'/remove',{},f.cookie(f.other))).status,404);
  assert.equal((await f.post(encodeURIComponent(a.id)+'/remove',{},f.cookie())).status,200);
  o=await f.options();assert.equal((await f.post('authenticate/verify',{response:a.assertion(o.challenge,f.base,f.user.id,2)},o.cookies)).status,400);
});

test('passkeys require user verification, exact origin, fresh sign-in and current account standing',async t=>{
  const f=await fixture(t),a=authenticator('localhost');
  assert.equal((await f.post('register/options',{},f.cookie(f.user,Date.now()-700000))).status,401);
  assert.equal((await f.post('authenticate/options',{},'','https://other.example.test')).status,403);
  let o=await f.options('register',f.cookie());assert.equal((await f.post('register/verify',{response:a.registration(o.challenge,f.base,false),label:'No UV'},o.cookies)).status,400);
  o=await f.options('register',f.cookie());assert.equal((await f.post('register/verify',{response:a.registration(o.challenge,'https://other.example.test'),label:'Wrong origin'},o.cookies)).status,400);
  o=await f.options('register',f.cookie());assert.equal((await f.post('register/verify',{response:a.registration(o.challenge,f.base),label:'Key'},o.cookies)).status,201);
  for(const reason of ['wrong-handle','wrong-origin','no-uv','disabled']) {
    o=await f.options();if(reason==='disabled')await f.store.setUserDisabled(f.user.id,new Date().toISOString());
    const response=a.assertion(o.challenge,reason==='wrong-origin'?'https://other.example.test':f.base,reason==='wrong-handle'?f.other.id:f.user.id,1,reason!=='no-uv');
    assert.equal((await f.post('authenticate/verify',{response},o.cookies)).status,400,reason);
  }
});

test('passkey memory store serializes credential counters, one-use challenges and disabled users',async()=>passkeyStoreConformance(createMemoryStore()));
test('passkeys require a secure DNS origin and constrain return navigation',()=>{
  assert.equal(passkeysEnabled('https://lolly.ing'),true);assert.equal(passkeysEnabled('http://localhost:8787'),true);assert.equal(passkeysEnabled('http://lolly.ing'),false);assert.equal(passkeysEnabled('https://127.0.0.1'),false);
  for(const target of ['https://evil.test','//evil.test','/\\evil.test','/\n/evil.test'])assert.equal(safePasskeyReturn(target),'/');assert.equal(safePasskeyReturn('/#/p?team=abc'),'/#/p?team=abc');
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('passkey Postgres store enforces the same atomic credential and challenge rules', {skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run'}, async () => {
  const { withFreshPostgres } = await import('./pg-test-schema.ts');
  await withFreshPostgres(pgUrl!, passkeyStoreConformance);
});
