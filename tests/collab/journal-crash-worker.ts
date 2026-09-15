// SPDX-License-Identifier: MPL-2.0
// A real child process paused after COMMIT, before Room can apply or acknowledge.
import { createPostgresStore } from '../../server/src/store/postgres.ts';
import { Room, type RoomMember } from '../../server/src/collab/rooms.ts';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
const store = await createPostgresStore(process.env.LW_TEST_DATABASE_URL!);
const commit = store.commitCollab;
store.commitCollab = async batch => {
  const revision = await commit(batch);
  process.send!({ committed: revision });
  await new Promise(() => {});
  return revision;
};
const session = (await store.getSession(process.argv[2]!))!;
const room = await Room.open(session, undefined, store);
const peer: RoomMember = { id: 'journal-peer', userId: process.argv[3]!, name: 'Journal', role: 'writer', opVersion: '1.1.0', send: () => { throw new Error('unexpected receipt before termination'); } };
const op: CanvasOp = { k: 'param', key: 'title', value: 'edit 2', origin: { client: peer.id, clock: 2 } };
await room.applyBatch(peer, 'batch-2', ['op-2'], [op], new Set([op]));
