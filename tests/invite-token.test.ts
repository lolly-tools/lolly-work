/**
 * Personal invite links (plans/74 invite spec 2.6; security rule 1): a token
 * names one invitation, the project the link was made for and the link
 * version, signed with the link secret. Anything else is refused, never
 * thrown on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_TOKEN_MAX, invitePageUrl, mintInviteToken, readInviteToken } from '../server/src/access/invite-token.ts';
import { mintToken } from '../server/src/iam/tokens.ts';
import { b64u, hmac } from '../server/src/lib/crypto.ts';

const KEY = 'link-secret-current';
const OLD = 'link-secret-previous';

test('a token round-trips its invitation, project and version', () => {
  const ref = { invitationId: 'inv_AbC-12_x', projectId: 'prj_Brand-1', version: 3 };
  const token = mintInviteToken(ref, KEY);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'base64url body and MAC, one dot');
  assert.deepEqual(readInviteToken(token, [KEY]), ref);
  assert.ok(token.length < 200, 'short enough for a chat message');
});

test('a workspace link carries no project', () => {
  const token = mintInviteToken({ invitationId: 'inv_1', projectId: null, version: 1 }, KEY);
  assert.deepEqual(readInviteToken(token, [KEY]), { invitationId: 'inv_1', projectId: null, version: 1 });
});

test('each entry of one invitation has its own link, and a new version is a new link', () => {
  const a = mintInviteToken({ invitationId: 'inv_1', projectId: 'prj_a', version: 1 }, KEY);
  const b = mintInviteToken({ invitationId: 'inv_1', projectId: 'prj_b', version: 1 }, KEY);
  const a2 = mintInviteToken({ invitationId: 'inv_1', projectId: 'prj_a', version: 2 }, KEY);
  assert.notEqual(a, b);
  assert.notEqual(a, a2);
  assert.equal(readInviteToken(a, [KEY])?.version, 1, 'the caller compares this with the row and refuses an old link');
});

test('a key rotation is honoured: the previous key still verifies, an unknown one does not', () => {
  const minted = mintInviteToken({ invitationId: 'inv_1', projectId: null, version: 1 }, OLD);
  assert.ok(readInviteToken(minted, [KEY, OLD]));
  assert.equal(readInviteToken(minted, [KEY]), null);
  assert.equal(readInviteToken(minted, []), null);
});

test('tampered body, wrong key, lw/link token, too long and bad characters are all refused', () => {
  const token = mintInviteToken({ invitationId: 'inv_1', projectId: 'prj_a', version: 1 }, KEY);
  const [, mac] = token.split('.') as [string, string];
  const refused = (t: string, why: string) => assert.equal(readInviteToken(t, [KEY]), null, why);
  refused(`${b64u('inv_1\nprj_b\n1')}.${mac}`, 'another project under the same MAC');
  refused(`${b64u('inv_1\nprj_a\n2')}.${mac}`, 'another version under the same MAC');
  refused(mintInviteToken({ invitationId: 'inv_1', projectId: 'prj_a', version: 1 }, 'some-other-key'), 'wrong key');
  refused(mintToken('lw/link', { invitationId: 'inv_1' }, KEY, 3600), 'a token of another domain');
  const body = b64u('inv_1\nprj_a\n1');
  refused(`${body}.${hmac(`lw/link.${body}`, KEY)}`, 'the same body signed for links');
  refused(`${'A'.repeat(INVITE_TOKEN_MAX - 43)}.${mac}`, 'longer than the limit');
  refused(`${token}!`, 'a character outside base64url');
  refused(token.replace('.', '%2E'), 'an encoded dot');
  refused(`${token}.extra`, 'three parts');
  refused('', 'empty');
  refused('.', 'only a dot');
  refused(`${body}.`, 'no MAC');
  refused(undefined as unknown as string, 'not a string');
});

test('a correctly signed body that is not three well-formed lines is refused', () => {
  const sign = (text: string) => { const body = b64u(text); return `${body}.${hmac(`lw/invite.${body}`, KEY)}`; };
  assert.ok(readInviteToken(sign('inv_1\n\n1'), [KEY]), 'the well-formed control');
  for (const text of ['inv_1\n1', 'inv_1\nprj\n1\nextra', '\nprj\n1', 'inv 1\n\n1', 'inv_1\nprj/x\n1', 'inv_1\n\n0', 'inv_1\n\n01', 'inv_1\n\n-1', 'inv_1\n\n1.5', 'inv_1\n\nx']) {
    assert.equal(readInviteToken(sign(text), [KEY]), null, JSON.stringify(text));
  }
});

test('the invite page lives under /l/, which every deploy already routes', () => {
  assert.equal(invitePageUrl('https://lolly.ing/', 'abc.def'), 'https://lolly.ing/l/invite/abc.def');
  assert.equal(invitePageUrl('https://work.example/base', 'abc.def'), 'https://work.example/base/l/invite/abc.def');
});
