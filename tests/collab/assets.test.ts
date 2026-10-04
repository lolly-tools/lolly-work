// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceCanvasDoc } from '@lolly-tools/core/canvas-op-v1';
import { decodeCanvasAsset } from '@lolly-tools/core/canvas-asset-v1';
import { seedOpsFromInputs } from '../../server/src/collab/rooms.ts';
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
