// SPDX-License-Identifier: MPL-2.0
/** The record store behaves the same in memory and in Postgres. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRenderApiStore } from '../server/src/render-api/store.ts';
import type { RenderApiRecord, RenderApiStore } from '../server/src/render-api/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const record = (id: string, over: Partial<RenderApiRecord> = {}): Omit<RenderApiRecord, 'seq'> => ({
  id, source: 'placid', template: 't', principal: 'service:svc_a', formats: ['png'], renders: {}, metadata: null, echo: {}, createdAt: '2026-11-05T00:00:00.000Z', ...over,
});

async function conformance(store: RenderApiStore): Promise<void> {
  const first = await store.insertRenderApiRecord(record('a', { metadata: ['x', 1], echo: { modifications: [{ name: 'n' }] }, webhookUrl: 'https://hook.example/x', filename: 'hero.png', idempotencyKey: 'k1' }));
  assert.equal(first.reused, false);
  assert.equal(typeof first.record.seq, 'number');
  assert.deepEqual(first.record.metadata, ['x', 1]);
  assert.deepEqual(first.record.echo, { modifications: [{ name: 'n' }] });
  assert.equal(first.record.webhookUrl, 'https://hook.example/x');
  assert.equal(first.record.filename, 'hero.png');
  assert.equal(first.record.createdAt, '2026-11-05T00:00:00.000Z');
  const replay = await store.insertRenderApiRecord(record('b', { idempotencyKey: 'k1' }));
  assert.equal(replay.reused, true);
  assert.equal(replay.record.id, 'a', 'a key already used returns its record');
  const other = await store.insertRenderApiRecord(record('c', { principal: 'service:svc_b', idempotencyKey: 'k1' }));
  assert.equal(other.reused, false, 'a key belongs to one principal');
  const noKeyOne = await store.insertRenderApiRecord(record('d'));
  const noKeyTwo = await store.insertRenderApiRecord(record('e'));
  assert.equal(noKeyOne.reused, false); assert.equal(noKeyTwo.reused, false, 'requests with no key never collide');
  assert.ok(noKeyTwo.record.seq > noKeyOne.record.seq);
  assert.equal(noKeyOne.record.metadata, null);
  assert.equal('webhookUrl' in noKeyOne.record, false);
  await store.setRenderApiRenders('a', { png: 'r1', pdf: 'r2' });
  assert.deepEqual((await store.getRenderApiRecord('a'))!.renders, { png: 'r1', pdf: 'r2' });
  assert.equal((await store.getRenderApiRecordBySeq(first.record.seq))!.id, 'a');
  assert.equal(await store.getRenderApiRecord('missing'), null);
  assert.equal(await store.getRenderApiRecordBySeq(987654321), null);
  await store.insertRenderApiRecord(record('f', { source: 'bannerbear-v5' }));
  assert.deepEqual((await store.listRenderApiRecords('service:svc_a', 'placid', 2, 0)).map((item) => item.id), ['e', 'd'], 'newest first');
  assert.deepEqual((await store.listRenderApiRecords('service:svc_a', 'placid', 2, 2)).map((item) => item.id), ['a']);
  assert.deepEqual((await store.listRenderApiRecords('service:svc_a', 'bannerbear-v5', 10, 0)).map((item) => item.id), ['f']);
  assert.equal(await store.deleteRenderApiRecord('a', 'service:svc_b'), null, 'only its principal deletes it');
  assert.equal((await store.deleteRenderApiRecord('a', 'service:svc_a'))!.id, 'a');
  assert.equal(await store.getRenderApiRecord('a'), null);
}

test('memory store', () => conformance(createMemoryRenderApiStore()));

test('postgres store', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, (store) => conformance(store));
});
