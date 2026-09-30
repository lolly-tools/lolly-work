import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { observeProductionInputs } from '../workers/render/src/production-inputs.ts';

test('browser evidence rejects another tool, changed bytes, conflicting observations and excess records', async () => {
  let send: (value: unknown) => void = () => {};
  const page = { exposeFunction: async (_name: string, sink: typeof send) => { send = sink; }, addInitScript: async () => {} } as unknown as Parameters<typeof observeProductionInputs>[0];
  const read = await observeProductionInputs(page, 'chart', ['data']);
  const bytes = new TextEncoder().encode('<svg/>'), artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  const observation = { version: 1, toolId: 'chart', artifactSha256, inputs: { data: 'a'.repeat(64) } };
  assert.equal(read(bytes), undefined);
  send({ ...observation, toolId: 'another-tool' });
  send({ ...observation, inputs: { undeclared: 'a'.repeat(64) } });
  assert.equal(read(bytes), undefined);
  send(observation);
  assert.deepEqual(read(bytes), observation.inputs);
  assert.equal(read(new Uint8Array([1])), undefined);
  send({ ...observation, inputs: { data: 'b'.repeat(64) } });
  assert.equal(read(bytes), undefined);
  const overflowRead = await observeProductionInputs(page, 'chart', ['data']);
  for (let i = 0; i < 17; i++) send(observation);
  assert.equal(overflowRead(bytes), undefined);
});
