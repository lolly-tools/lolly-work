/** Run only against a disposable database: this uses the test schema bootstrap.
 * LW_TEST_DATABASE_URL=postgres://... node tests/collab/checkpoint-benchmark.ts
 * The journal measurement is an insert-only lower bound, not feature-equivalent storage.
 */
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Room, type RoomMember } from '../../server/src/collab/rooms.ts';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { withFreshPostgres } from '../pg-test-schema.ts';
const url = process.env.LW_TEST_DATABASE_URL;
if (!url) throw new Error('Set LW_TEST_DATABASE_URL to a disposable Postgres database');
await withFreshPostgres(url, async store => {
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: url }); await db.connect();
  const stats = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { p50Ms: +sorted[Math.floor(sorted.length*.5)]!.toFixed(2), p95Ms: +sorted[Math.floor(sorted.length*.95)]!.toFixed(2) }; };
  try {
    const user = await store.upsertUserBySub({ sub: 'benchmark', email: 'benchmark@example.invalid', groups: [], role: 'member' });
    const now = new Date().toISOString();
    await store.putProject({ id: 'bench', name: 'Benchmark', visibility: 'private', ownerId: user.id, createdAt: now });
    await db.query('create temporary table journal_baseline(batch_id text primary key, ops jsonb, receipt jsonb)');
    for (const [count, batches] of [[100, 50], [1000, 50], [1000, 260]] as const) {
      const session = { id: `bench-${count}-${batches}`, projectId: 'bench', toolId: 'design', toolVersion: '1',
        inputs: { boxes: Array.from({length:count}, (_,i) => ({ id: `b${i}`, x:i, y:i, w:100, h:100, text:`Shape ${i}`, fill:'#ff3366' })) },
        meta: {}, createdBy: user.id, updatedBy: user.id, rev:1, updatedAt:now };
      await store.putSession(session);
      let room = await Room.open(session, undefined, store);
      const timings: number[] = [], baseline: number[] = [];
      const commit = store.commitCollab;
      let checkpointWrites = 0;
      store.commitCollab = async batch => {
        const revision = await commit(batch);
        if (batch.checkpoint) checkpointWrites++;
        return revision;
      };
      const peers: RoomMember[] = Array.from({length:10}, (_,i) => ({ id:`c${i}`, userId:user.id, name:`Peer ${i}`, role:'writer', opVersion:'1.1.0', send:()=>{} }));
      for (const peer of peers) room.join(peer);
      try {
        for (let round=0; round<batches/10; round++) {
          await Promise.all(peers.map(async (peer,i) => {
            const id=`${count}-${round}-${i}`;
            const op: CanvasOp = { k:'geom', col:'boxes', id:`b${i}`, fields:{x:round*10+i}, origin:{client:peer.id,clock:round+1} };
            const start=performance.now(); await room.applyBatch(peer,id,[id],[op],new Set([op])); timings.push(performance.now()-start);
          }));
        }
        for (let i=0;i<50;i++) {
          const start=performance.now();
          await db.query('insert into journal_baseline values($1,$2::jsonb,$3::jsonb)', [`${session.id}-${i}`, JSON.stringify([{k:'geom',col:'boxes',id:'b0',fields:{x:i},origin:{client:'c',clock:i+1}}]), JSON.stringify({acceptedIds:[`${count}-${i}`]})]);
          baseline.push(performance.now()-start);
        }
        const checkpoint = await store.getCollabCheckpoint(session.id);
        const journal = await store.getCollabJournal(session.id, checkpoint!.revision);
        const {rows} = await db.query('select count(*)::int as count, sum(pg_column_size(inputs)+pg_column_size(meta))::bigint as bytes from session_revisions where session_id=$1',[session.id]);
        const expected = room.snapshot();
        await room.quiesce();
        const recoveryStart = performance.now();
        room = await Room.open(session, undefined, store);
        const recoveryMs = +(performance.now() - recoveryStart).toFixed(2);
        assert.deepEqual(room.snapshot(), expected);
        console.log(JSON.stringify({ shapes:count, writers:10, batches, durableJournalWithQueue:stats(timings), journalInsertOnly:stats(baseline), checkpointWrites,
          checkpointJsonBytes:Buffer.byteLength(JSON.stringify(checkpoint)), journalBatches:journal.length, journalJsonBytes:Buffer.byteLength(JSON.stringify(journal)),
          historyRows:rows[0].count, historyStoredBytes:Number(rows[0].bytes), recoveryMs }));
      } finally { store.commitCollab = commit; await room.quiesce(); }
    }
  } finally { await db.end(); }
});
