/**
 * Gated: needs a disposable Postgres. Run with e.g.
 *   docker run --rm -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17-alpine
 *   LW_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres pnpm test
 * The suite creates its own schema per run (drops first) via the migrations
 * runner - see tests/pg-test-schema.ts, which also keeps the several gated pg
 * suites from dropping the schema out from under each other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreshPostgres } from './pg-test-schema.ts';
import { runStoreConformance } from './store-conformance.ts';

const url = process.env.LW_TEST_DATABASE_URL;

test('postgres store passes the conformance suite', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url as string, runStoreConformance);
});

test('account erasure rolls identity deletion back if telemetry scrubbing fails', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const target = await store.upsertUserBySub({ sub: 'rollback-subject', email: 'synthetic@example.invalid', groups: [], role: 'member' });
      await store.putEvents([{ at: new Date().toISOString(), event: 'tool.open', attrs: {}, userId: target.id }]);
      await admin.query(`create function fail_test_telemetry_update() returns trigger language plpgsql as $$
        begin raise exception 'synthetic scrub failure'; end $$;
        create trigger fail_test_telemetry before update on telemetry_events for each row execute function fail_test_telemetry_update();`);
      await assert.rejects(store.eraseUserAccount(target.id), /synthetic scrub failure/);
      assert.ok(await store.getUser(target.id), 'identity deletion rolled back');
      assert.equal((await store.listEvents())[0]?.userId, target.id, 'attribution preserved');
    } finally { await admin.end(); }
  });
});

test('a REST save keeps at most SESSION_REVISION_LIMIT revision rows on disk', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // listSessionRevisions reads with a limit, so the bound has to be checked on
  // the table itself: without pruning on write, every PUT kept another row.
  const { SESSION_REVISION_LIMIT } = await import('../server/src/store/types.ts');
  await withFreshPostgres(url!, async (store) => {
    const owner = await store.upsertUserBySub({ sub: 'rev-bound', email: 'rev-bound@example.invalid', groups: [], role: 'member' });
    const at = new Date().toISOString();
    await store.putProject({ id: 'prj_rev', name: 'Revisions', visibility: 'private', ownerId: owner.id, createdAt: at });
    await store.putSession({
      id: 'ses_rev', projectId: 'prj_rev', toolId: 'poster', toolVersion: '1.0.0',
      inputs: {}, meta: {}, createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at,
    });
    const total = SESSION_REVISION_LIMIT + 7;
    for (let rev = 2; rev <= total; rev++) {
      await store.appendSessionRevision({ sessionId: 'ses_rev', rev, inputs: { n: rev }, meta: {}, actor: owner.id, at });
    }
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const { rows } = await admin.query('select rev from session_revisions where session_id = $1 order by rev desc', ['ses_rev']);
      assert.equal(rows.length, SESSION_REVISION_LIMIT, 'older revisions are pruned on write');
      assert.equal(Number(rows[0].rev), total, 'the newest revision is kept');
      assert.equal(Number(rows.at(-1).rev), total - SESSION_REVISION_LIMIT + 1);
    } finally { await admin.end(); }
  });
});

test('comment reads, notices and mention sends go with their person, document and thread', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // The conformance suite sees these rules through the Store; this checks the
  // tables themselves, so nothing private outlives its person or document.
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const at = new Date(Date.now() - 60_000).toISOString();
      const user = (sub: string) => store.upsertUserBySub({ sub, email: `${sub}@example.invalid`, groups: [], role: 'member' });
      const owner = await user('cn-owner'), reader = await user('cn-reader'), actor = await user('cn-actor'), other = await user('cn-other');
      await store.putProject({ id: 'prj_cn', name: 'Review', visibility: 'private', ownerId: owner.id, createdAt: at });
      for (const [threadId, sessionId] of [['thr_cn_a', 'ses_cn1'], ['thr_cn_b', 'ses_cn2']] as const) {
        await store.putSession({ id: sessionId, projectId: 'prj_cn', toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {},
          createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at });
        assert.equal(await store.createCommentThread({
          id: threadId, sessionId, anchor: { kind: 'canvas', surface: 'page-1', x: 0, y: 0 }, authorId: actor.id, authorName: 'Ana',
          revision: 1, createdAt: at, updatedAt: at, messages: [{ id: 'm1', authorId: actor.id, authorName: 'Ana', body: 'Note', createdAt: at }],
        }), 'created');
      }
      const seed = async (userId: string, threadId: string, sessionId: string, actorId: string): Promise<void> => {
        await store.readCommentState(userId, sessionId);
        await store.markCommentsRead(userId, sessionId, [{ threadId, at }]);
        await store.upsertCommentNotice({ userId, threadId, sessionId, projectId: 'prj_cn', kind: 'reply', actorId, messageId: 'm1', at, mentioned: true });
        assert.deepEqual(await store.recordMentionSends(threadId, 'm1', [userId], at), [userId]);
      };
      await seed(reader.id, 'thr_cn_a', 'ses_cn1', actor.id);
      await seed(other.id, 'thr_cn_a', 'ses_cn1', actor.id);
      await seed(other.id, 'thr_cn_b', 'ses_cn2', owner.id);
      const tables = ['canvas_comment_reads', 'canvas_comment_read_floors', 'comment_notices', 'comment_mention_sends'];
      const count = async (where: string, value: string): Promise<Record<string, number>> => {
        const counts: Record<string, number> = {};
        for (const table of tables) counts[table] = Number((await admin.query(`select count(*)::int as n from ${table} where ${where} = $1`, [value])).rows[0].n);
        return counts;
      };
      const none = Object.fromEntries(tables.map((table) => [table, 0]));
      assert.deepEqual(await count('user_id', reader.id), Object.fromEntries(tables.map((table) => [table, 1])));

      assert.equal((await store.eraseUserAccount(reader.id)).status, 'erased');
      assert.deepEqual(await count('user_id', reader.id), none, "the person's own rows went with them");
      assert.equal((await store.eraseUserAccount(actor.id)).status, 'erased');
      assert.equal(Number((await admin.query('select count(*)::int as n from comment_notices where actor_id = $1', [actor.id])).rows[0].n), 0,
        'the notices the actor caused went too');
      assert.deepEqual((await store.listCommentNotices(other.id)).map((n) => n.threadId), ['thr_cn_b'], 'notices others caused are kept');

      // Removing a document removes its threads and, with them, every read,
      // floor, notice and mention send that names them.
      await admin.query("delete from sessions where id = 'ses_cn2'");
      assert.deepEqual(await count('user_id', other.id), { ...none, canvas_comment_reads: 1, canvas_comment_read_floors: 1, comment_mention_sends: 1 });
      assert.deepEqual(await store.listCommentNotices(other.id), []);
    } finally { await admin.end(); }
  });
});

test('concurrent comment writes keep one floor, one notice and one mention send', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, async (store) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const owner = await store.upsertUserBySub({ sub: 'cn-race', email: 'cn-race@example.invalid', groups: [], role: 'member' });
    await store.putProject({ id: 'prj_race', name: 'Race', visibility: 'private', ownerId: owner.id, createdAt: at });
    await store.putSession({ id: 'ses_race', projectId: 'prj_race', toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {},
      createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at });
    await store.createCommentThread({
      id: 'thr_race', sessionId: 'ses_race', anchor: { kind: 'canvas', surface: 'page-1', x: 0, y: 0 }, authorId: owner.id, authorName: 'Ana',
      revision: 1, createdAt: at, updatedAt: at, messages: [{ id: 'm1', authorId: owner.id, authorName: 'Ana', body: 'Note', createdAt: at }],
    });
    const floors = await Promise.all(Array.from({ length: 8 }, () => store.readCommentState(owner.id, 'ses_race')));
    assert.equal(new Set(floors.map((s) => s.floorAt)).size, 1, 'one floor however many first reads race');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.upsertCommentNotice({
      userId: owner.id, threadId: 'thr_race', sessionId: 'ses_race', projectId: 'prj_race', kind: 'reply',
      actorId: 'usr_someone', messageId: `m${i}`, at, mentioned: false,
    })));
    assert.equal(results.filter((r) => r === 'created').length, 1);
    const notices = await store.listCommentNotices(owner.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.count, 10, 'every distinct message counts once');
    const sends = await Promise.all(Array.from({ length: 5 }, () => store.recordMentionSends('thr_race', 'm1', [owner.id], at)));
    assert.equal(sends.flat().length, 1, 'exactly one racing call records the send');
  });
});

test('the instance total of version content is one row that always equals the sum of the contents', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // The instance cap reads this row on every version write with new content,
  // so it has to follow every way contents come and go, cascades included.
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const total = async (why: string): Promise<number> => {
        const { rows } = await admin.query(`select (select bytes from session_version_totals where id) as kept,
          (select coalesce(sum(bytes), 0) from session_version_contents) as summed, (select count(*) from session_version_totals) as n`);
        assert.equal(Number(rows[0].n), 1, 'one row');
        assert.equal(Number(rows[0].kept), Number(rows[0].summed), why);
        return Number(rows[0].kept);
      };
      assert.equal(await total('a new database'), 0);
      const owner = await store.upsertUserBySub({ sub: 'totals', email: 'totals@example.invalid', groups: [], role: 'member' });
      const at = new Date().toISOString();
      await store.putProject({ id: 'prj_tot', name: 'Totals', visibility: 'private', ownerId: owner.id, createdAt: at });
      for (const id of ['ses_tot_a', 'ses_tot_b']) {
        await store.putSession({ id, projectId: 'prj_tot', toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {}, createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at });
      }
      const put = async (sessionId: string, kind: 'auto' | 'named', inputs: Record<string, unknown>) => {
        const result = await store.putSessionVersion({ sessionId, rev: 1, kind, inputs, meta: {}, contributors: [],
          ...(kind === 'named' ? { label: 'Named', createdBy: owner.id } : {}) });
        assert.ok(typeof result === 'object', `${sessionId} ${kind}`);
        return result.version.id;
      };
      const a1 = await put('ses_tot_a', 'auto', { p: 'a'.repeat(100) });
      await put('ses_tot_a', 'named', { p: 'a'.repeat(100) });
      await put('ses_tot_a', 'auto', { p: 'b'.repeat(200) });
      await put('ses_tot_b', 'auto', { p: 'c'.repeat(300) });
      assert.ok(await total('after inserts, shared content counted once') > 600);
      assert.equal(await store.deleteSessionVersion('ses_tot_a', a1), true);
      await total('a delete that leaves the shared content');
      store.configureVersionLimits({ instanceMaxBytes: 700 });
      await put('ses_tot_b', 'auto', { p: 'd'.repeat(300) });
      await total('after eviction across documents');
      store.configureVersionLimits({});
      await store.deleteSessionVersions('ses_tot_a');
      await total('a document\'s versions deleted');
      await admin.query('delete from session_versions where session_id = $1', ['ses_tot_b']);
      await admin.query('delete from sessions where id = $1', ['ses_tot_b']);
      assert.equal(await total('the contents went with their session row'), 0);
    } finally { await admin.end(); }
  });
});
