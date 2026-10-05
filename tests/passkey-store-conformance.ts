// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PasskeyStore } from '../server/src/iam/passkeys/types.ts';
import type { Store } from '../server/src/store/types.ts';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export async function passkeyStoreConformance(store: Store & PasskeyStore) {
  const u=await store.upsertUserBySub({sub:'store-key-'+randomBytes(4).toString('hex'),email:'store@keys.test',groups:[],role:'member'}),now=new Date().toISOString();
  const record={id:b64(randomBytes(32)),userId:u.id,publicKey:'public',counter:0,transports:['internal'],label:'Key',deviceType:'singleDevice' as const,backedUp:false,createdAt:now};
  const outcomes=await Promise.all([store.registerPasskey(record,u.sessionEpoch),store.registerPasskey(record,u.sessionEpoch)]);assert.equal(outcomes.filter(Boolean).length,1);
  const advances=await Promise.all([store.advancePasskey(record,1,false,u.sessionEpoch),store.advancePasskey(record,1,false,u.sessionEpoch)]);assert.equal(advances.filter(Boolean).length,1);
  assert.equal(await store.advancePasskey({...record,counter:1},1,false,u.sessionEpoch),false);
  assert.equal(await store.advancePasskey({...record,counter:1,publicKey:'replaced'},2,false,u.sessionEpoch),false);
  const challenge={id:b64(randomBytes(24)),nonceHash:'nonce',challenge:'challenge',kind:'authenticate' as const,expiresAt:new Date(Date.now()+300000).toISOString(),returnTo:'/'};
  assert.equal(await store.putPasskeyChallenge(challenge),true);assert.equal(await store.consumePasskeyChallenge(challenge.id,'wrong'),null);
  const spent=await Promise.all([store.consumePasskeyChallenge(challenge.id,'nonce'),store.consumePasskeyChallenge(challenge.id,'nonce')]);assert.equal(spent.filter(Boolean).length,1);
  const expired={...challenge,id:b64(randomBytes(24)),expiresAt:now};assert.equal(await store.putPasskeyChallenge(expired),true);assert.equal(await store.consumePasskeyChallenge(expired.id,'nonce'),null);
  await store.setUserDisabled(u.id,new Date().toISOString());assert.equal(await store.advancePasskey({...record,counter:1},2,false,u.sessionEpoch),false);assert.equal(await store.registerPasskey({...record,id:'new'},u.sessionEpoch),false);
  await store.setUserDisabled(u.id,null);const active=await store.getUser(u.id);assert.ok(active);assert.equal(await store.removePasskey(record.id,u.id,active.sessionEpoch),true);
}
