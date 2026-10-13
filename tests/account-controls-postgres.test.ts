// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreshPostgres } from './pg-test-schema.ts';
import { credentialExpiry } from '../server/src/iam/credential-expiry.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { revokeBrowserSessions } from '../server/src/iam/local-logout.ts';
import { resolveMember } from '../server/src/iam/member.ts';
const url = process.env.LW_TEST_DATABASE_URL;

test('PostgreSQL persists service expiry, preserves legacy rows and revokes only the logged-out session', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, async store => {
    const user = await store.upsertUserBySub({ sub: 'owned-local-session', email: 'person@fixture.test', role: 'member', groups: [] });
    const body = { sub: user.sub, email: user.email, name: 'Person', groups: [], role: user.role };
    const first = mintSessionCookie(body, 'owned-session', false).split(';')[0]!, other = mintSessionCookie(body, 'owned-session', false).split(';')[0]!;
    await revokeBrowserSessions(store, first, 'owned-session');
    assert.equal(await resolveMember(store, first, 'owned-session'), null);
    assert.equal((await resolveMember(store, other, 'owned-session'))?.id, user.id);
    const record = { id: 'owned-service', label: 'automation', role: 'owner', tokenHash: hashServiceSecret('owned-service'),
      createdBy: `user:${user.id}`, createdAt: new Date().toISOString(), expiresAt: credentialExpiry(90) };
    await store.putApiToken(record);
    assert.equal((await store.findApiTokenByHash(record.tokenHash))?.expiresAt, record.expiresAt);
    await store.putApiToken({ ...record, id: 'legacy-service', tokenHash: hashServiceSecret('owned-legacy'), expiresAt: undefined });
    assert.equal((await store.findApiTokenByHash(hashServiceSecret('owned-legacy')))?.expiresAt, undefined);
  });
});
