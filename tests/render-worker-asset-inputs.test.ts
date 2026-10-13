// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerQuery } from '../server/src/render/worker-inputs.ts';
import { loadEngine } from '../server/src/render/contract.ts';

const base = 'https://private.example/';
const scope = { projectId: 'prj_a', ids: ['fil_a'], userId: 'usr_viewer' };
const model = [{ id: 'image', type: 'asset', value: undefined }];

test('worker asset inputs use the real engine wire serializer, including remote and baked assets', async () => {
  const engine = await loadEngine();
  const url = `${base}api/v1/projects/prj_a/files/fil_a`;
  const values = { image: { source: 'remote', id: url, url, type: 'raster', format: 'png' }, title: 'hello', document: { boxes: [] } };
  const query = new URLSearchParams(workerQuery(engine, model, values, base));
  assert.equal(query.get('image'), url);
  assert.equal(query.get('title'), 'hello');
  assert.equal(query.get('document'), '{"boxes":[]}');
  const inline = 'data:image/png;base64,YQ==';
  const baked = new URLSearchParams(workerQuery(engine, model, { image: { source: 'remote', id: 'baked/test', url: inline, meta: { baked: true }, type: 'raster', format: 'png' } }, base));
  assert.equal(baked.get('image'), inline);
});

test('only project-file references in the admitted ticket become same-instance URLs', async () => {
  const engine = await loadEngine();
  for (const image of ['user/team/fil_a', { source: 'user', id: 'user/team/fil_a', _unresolved: true }]) {
    assert.equal(new URLSearchParams(workerQuery(engine, model, { image }, base, scope)).get('image'), `${base}api/v1/projects/prj_a/files/fil_a`);
  }
  for (const files of [undefined, { ...scope, ids: ['fil_other'] }]) {
    const image = { source: 'user', id: 'user/team/fil_a', _unresolved: true };
    assert.equal(new URLSearchParams(workerQuery(engine, model, { image }, base, files)).get('image'), 'user/team/fil_a');
  }
  for (const image of ['user/local/fil_a', 'user/team/fil_a/../../secret', 'user/team/fil_a?project=other']) {
    assert.equal(new URLSearchParams(workerQuery(engine, model, { image }, base, scope)).get('image'), image);
  }
});

test('nested asset references preserve document structure and never rewrite literal text', async () => {
  const engine = await loadEngine();
  const document = { boxes: [{ image: { source: 'user', id: 'user/team/fil_a', width: 10 }, text: 'user/team/fil_a' }, { image: { source: 'user', id: 'user/team/fil_outside' } }] };
  const query = new URLSearchParams(workerQuery(engine, model, { document, title: 'user/team/fil_a' }, base, scope));
  const result = JSON.parse(query.get('document')!);
  assert.equal(result.boxes[0].image.id, `${base}api/v1/projects/prj_a/files/fil_a`);
  assert.equal(result.boxes[0].image.width, 10);
  assert.equal(result.boxes[0].text, 'user/team/fil_a');
  assert.equal(result.boxes[1].image.id, 'user/team/fil_outside');
  assert.equal(query.get('title'), 'user/team/fil_a');
  assert.equal(document.boxes[0]!.image.id, 'user/team/fil_a');
});
