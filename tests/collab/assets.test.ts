// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceCanvasDoc, CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import { decodeCanvasAsset, encodeCanvasAsset } from '@lolly-tools/core/canvas-asset-v1';
import { seedOpsFromInputs, Room, type RoomMember, type ServerFrame } from '../../server/src/collab/rooms.ts';
import { docToInputs } from '../../server/src/collab/persistence.ts';

test('room asset references survive persistence and re-seeding without local URLs', () => {
  const inputs = { boxes: [{ id: 'image', x: 20, image: { id: 'user/team/file', source: 'user', type: 'raster', format: 'png',
    pin: { version: 'hash', format: 'png' }, url: 'blob:private', meta: { credential: 'private' } }, localObject: { omitted: true } }] };
  const doc = new ReferenceCanvasDoc('server');
  const seed = seedOpsFromInputs(inputs);
  for (const op of seed.ops) doc.apply(op);
  const row = doc.state().collections!.get('boxes')!.boxes.get('image')!;
  assert.equal(decodeCanvasAsset(row.image)?.id, 'user/team/file');
  assert.equal(Object.hasOwn(row, 'localObject'), false);
  const stored = docToInputs(doc.state(), inputs, new Set(['boxes']));
  const image = (stored.boxes as typeof inputs.boxes)[0]!.image;
  assert.equal(image.url, ''); assert.equal(image.pin.version, 'hash'); assert.equal(Object.hasOwn(image, 'meta'), false);
  assert.deepEqual(seedOpsFromInputs(stored).ops, seed.ops);
});

test('a placed tool survives persistence and re-seeding as its link, never as a render', () => {
  const link = 'https://lolly.tools/tool/pose-geeko.svg?pose=curious&motion=alive&loop=8';
  const inputs = { boxes: [{ id: 'geeko', x: 20, image: { id: link, source: 'remote', type: 'vector', format: 'svg',
    url: 'data:image/svg+xml,%3Csvg%2F%3E', meta: { toolUrl: link, animated: true } } }] };
  const doc = new ReferenceCanvasDoc('server');
  const seed = seedOpsFromInputs(inputs);
  for (const op of seed.ops) doc.apply(op);
  const row = doc.state().collections!.get('boxes')!.boxes.get('geeko')!;
  assert.equal(decodeCanvasAsset(row.image)?.id, link);
  assert.doesNotMatch(String(row.image), /data:image/);
  const stored = docToInputs(doc.state(), inputs, new Set(['boxes']));
  const image = (stored.boxes as typeof inputs.boxes)[0]!.image;
  assert.deepEqual(image, { id: link, source: 'remote', type: 'vector', format: 'svg', url: '' });
  assert.deepEqual(seedOpsFromInputs(stored).ops, seed.ops);
});

test('legacy room members keep ordinary changes without receiving asset extension strings', async () => {
  const image = { id: 'user/team/file', source: 'user', type: 'raster', format: 'png', pin: { version: 'hash', format: 'png' }, url: '' };
  const room = await Room.open({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: { boxes: [{ id: 'a', x: 20, image }] },
    meta: {}, createdBy: 'owner', updatedBy: 'owner', updatedAt: new Date().toISOString(), rev: 1 });
  const member = (id: string, version?: number): RoomMember & { sent: ServerFrame[] } => {
    const sent: ServerFrame[] = []; return { id, userId: id, name: id, role: 'writer', opVersion: CANVAS_OP_VERSION,
      interactionVersion: version, sent, send: frame => { sent.push(frame); } };
  };
  try {
    const legacy = member('legacy'), writer = member('writer', 1), modern = member('modern', 1);
    const old = room.join(legacy), current = room.join(writer); room.join(modern);
    assert.equal(Object.hasOwn(old.docState.collections!.boxes!.boxes.a!, 'image'), false);
    const projection = new ReferenceCanvasDoc('legacy'); projection.restore(old.checkpoint);
    assert.equal(Object.hasOwn(projection.state().collections!.get('boxes')!.boxes.get('a')!, 'image'), false);
    assert.equal(decodeCanvasAsset(current.docState.collections!.boxes!.boxes.a!.image)?.id, image.id);
    legacy.sent.length = 0; modern.sent.length = 0;
    room.applyOps(writer, [{ k: 'field', col: 'boxes', id: 'a', field: 'image', value: encodeCanvasAsset({ ...image, id: 'user/team/next' })!, origin: { client: 'writer', clock: 1 } }]);
    assert.equal(legacy.sent.filter(frame => frame.t === 'ops').length, 0);
    assert.equal(modern.sent.filter(frame => frame.t === 'ops').length, 1);
    room.applyOps(writer, [{ k: 'geom', col: 'boxes', id: 'a', fields: { x: 99 }, origin: { client: 'writer', clock: 2 } }]);
    assert.equal(legacy.sent.filter(frame => frame.t === 'ops').length, 1);
  } finally { await room.quiesce(); }
});
