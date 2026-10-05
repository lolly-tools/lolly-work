// SPDX-License-Identifier: MPL-2.0
/** Render tickets grant catalog reads, never a human session or project access. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mintRenderRead, renderReader } from '../server/src/render/read-ticket.ts';
import { mintToken, verifyToken } from '../server/src/iam/tokens.ts';
import { boot, LINK_SECRET } from './invite-harness.ts';

test('render credential is limited by path, method, domain, revision and expiry', () => {
  const token = mintRenderRead(['design'], 'rev', 'secret');
  const read = (url: string, method = 'GET', key = token, revision = 'rev') => renderReader({ url, method, headers: { 'x-lw-render-read': key } } as unknown as IncomingMessage, revision, 'secret');
  assert.deepEqual(read('/catalog/assets/index.json')?.groups, ['design']);
  assert.ok(read('/tools/design/tool.json'));
  assert.ok(read('/catalog/fonts/a.woff2', 'HEAD'));
  for (const path of ['/api/auth/session', '/api/v1/projects', '/api/v1/org-config', '/api/v1/catalog/search', '/api/v1/users']) assert.equal(read(path), null);
  assert.equal(read('/catalog/assets/index.json', 'PUT'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', token, 'new'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', token+'bad'), null);
  assert.equal(verifyToken('lw/session', token, 'secret'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', mintToken('lw/render-read', { groups: [], revision: 'rev' }, 'secret', 1, Date.now()-5000)), null);
});

test('a gated instance admits a render catalog reader without opening sign-in or project routes', async () => {
  const env = await boot({ policy: { defaultAccessMode: 'gated' } });
  const config = await fetch(env.base+'/api/auth/config');
  const revision = config.headers.get('x-lolly-brand-revision')!;
  assert.equal((await config.json() as { mode: string }).mode, 'gated');
  const token = mintRenderRead([], revision, LINK_SECRET), headers = { 'x-lw-render-read': token };
  assert.equal((await fetch(env.base+'/catalog/assets/index.json')).status, 401);
  assert.equal((await fetch(env.base+'/catalog/assets/index.json', { headers })).status, 200);
  assert.equal((await (await fetch(env.base+'/api/auth/config', { headers })).json() as { mode: string }).mode, 'open');
  for (const path of ['/api/auth/session', '/api/v1/projects', '/api/v1/users']) assert.equal((await fetch(env.base+path, { headers })).status, 401);
  assert.equal((await fetch(env.base+'/api/v1/projects', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'forbidden' }) })).status, 401);
});
