import { test } from 'node:test';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { runStoreConformance } from './store-conformance.ts';

test('memory store passes the conformance suite', async () => {
  await runStoreConformance(createMemoryStore());
});
