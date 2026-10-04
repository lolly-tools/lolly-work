// SPDX-License-Identifier: MPL-2.0
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseConfig} from '../server/src/config/instance.ts';
import {createMemoryStore} from '../server/src/store/memory.ts';
import {buildApp} from '../server/src/api/app.ts';

let server: Server, base: string, pack: string, cookie: string;
const bytes = Buffer.from('controlled font fixture');
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-font-head-'));
  await mkdir(join(pack, 'catalog', 'fonts', 'ttf'), {recursive: true});
  await mkdir(join(pack, 'catalog', 'assets'), {recursive: true});
  await writeFile(join(pack, 'catalog', 'fonts', 'ttf', 'Test.ttf'), bytes);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({assets: [{id: 'test/font', type: 'font', version: '1', formats: [{format: 'ttf', url: '/catalog/fonts/ttf/Test.ttf'}]}]}));
  const config = parseConfig(JSON.stringify({instance: {name: 'Font test', baseUrl: 'http://localhost', pack}, policy: {defaultAccessMode: 'gated'}, dev: {enabled: true, users: [{email: 'owner@test', groups: ['owner']}]}}));
  const app = buildApp({config, store: createMemoryStore(), secrets: {session: 'session', link: 'link'}});
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + '/api/auth/dev?email=owner%40test', {redirect: 'manual'}); assert.equal(login.status, 302);
  cookie = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
});
after(async () => {await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, {recursive: true, force: true});});

test('a font HEAD probe has the GET content type and size but sends no bytes', async () => {
  const get = await fetch(base + '/catalog/fonts/ttf/Test.ttf', {headers: {cookie}});
  assert.equal(get.status, 200); assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const head = await fetch(base + '/catalog/fonts/ttf/Test.ttf', {method: 'HEAD', headers: {cookie}});
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'font/ttf');
  assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('font probes retain sign-in gating and missing-file refusal', async () => {
  assert.equal((await fetch(base + '/catalog/fonts/ttf/Test.ttf', {method: 'HEAD'})).status, 401);
  assert.equal((await fetch(base + '/catalog/fonts/ttf/Missing.ttf', {method: 'HEAD', headers: {cookie}})).status, 404);
  assert.equal((await fetch(base + '/catalog/fonts/ttf/%2e%2e%2fTest.ttf', {method: 'HEAD', headers: {cookie}})).status, 400);
});

test('revoking a font blocks its HEAD probe and its GET bytes together', async () => {
  const revoke = await fetch(base + '/api/v1/catalog/lifecycle/test/font', {method: 'PUT', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({revoke: true})});
  assert.equal(revoke.status, 200);
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + '/catalog/fonts/ttf/Test.ttf', {method, headers: {cookie}})).status, 410);
});
