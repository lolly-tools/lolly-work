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
      await store.upsertInstall('rollback-install', { shell: 'web' }, target.id);
      await admin.query(`create function fail_test_telemetry_update() returns trigger language plpgsql as $$
        begin raise exception 'synthetic scrub failure'; end $$;
        create trigger fail_test_telemetry before update on telemetry_events for each row execute function fail_test_telemetry_update();`);
      await assert.rejects(store.eraseUserAccount(target.id), /synthetic scrub failure/);
      assert.ok(await store.getUser(target.id), 'identity deletion rolled back');
      assert.equal((await store.listEvents())[0]?.userId, target.id, 'attribution preserved');
      assert.equal((await store.listInstalls()).find(row => row.installId === 'rollback-install')?.userIdLastSeen, target.id, 'fleet attribution rolled back');
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

test('a commit whose revision, version or audit row fails leaves no head: one transaction (plan 221)', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // The fault is injected in the database itself: a trigger refuses one table's
  // insert after the head's update already ran in the same transaction.
  const { SESSION_REVISION_LIMIT } = await import('../server/src/store/types.ts');
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const owner = await store.upsertUserBySub({ sub: 'commit-fault', email: 'commit-fault@example.invalid', groups: [], role: 'member' });
      const at = new Date().toISOString();
      await store.putProject({ id: 'prj_fault', name: 'Faults', visibility: 'private', ownerId: owner.id, createdAt: at });
      await store.putSession({ id: 'ses_fault', projectId: 'prj_fault', toolId: 'poster', toolVersion: '1.0.0', inputs: { title: 'Kept' }, meta: {},
        createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at });
      await admin.query(`create function refuse_insert() returns trigger language plpgsql as $$
        begin raise exception 'synthetic % failure', tg_table_name; end $$`);
      const rows = async () => {
        const { rows: [r] } = await admin.query(`select (select rev from sessions where id = 'ses_fault') as rev,
          (select inputs->>'title' from sessions where id = 'ses_fault') as title,
          (select count(*)::int from session_revisions where session_id = 'ses_fault') as revisions,
          (select count(*)::int from session_versions where session_id = 'ses_fault') as versions,
          (select count(*)::int from audit_log where action = 'session.update') as audits`);
        return r;
      };
      const commit = (title: string, rev: number) => store.commitSessionRevision({
        next: { id: 'ses_fault', projectId: 'prj_fault', toolId: 'poster', toolVersion: '1.0.0', inputs: { title }, meta: {}, createdBy: owner.id,
          updatedBy: owner.id, rev: rev + 1, updatedAt: new Date().toISOString() },
        expectedRev: rev, actor: owner.id,
        version: { kind: 'save', contributors: [{ id: owner.id, kind: 'user', edits: 1 }], createdBy: owner.id },
        audit: { at: new Date().toISOString(), actor: `user:${owner.id}`, action: 'session.update', subject: 'session:ses_fault', payload: { rev: rev + 1 } },
      });
      const untouched = { rev: 1, title: 'Kept', revisions: 0, versions: 0, audits: 0 };
      assert.deepEqual(await rows(), untouched);
      for (const table of ['session_revisions', 'session_versions', 'audit_log']) {
        await admin.query(`create trigger refuse_commit before insert on ${table} for each row execute function refuse_insert()`);
        await assert.rejects(commit(`Lost to ${table}`, 1), new RegExp(`synthetic ${table} failure`));
        assert.deepEqual(await rows(), untouched, `${table}: no head, revision, version or audit row`);
        await admin.query(`drop trigger refuse_commit on ${table}`);
      }
      const done = await commit('Saved', 1);
      assert.ok(done.committed, 'the same commit goes through once nothing refuses it');
      assert.deepEqual(await rows(), { rev: 2, title: 'Saved', revisions: 1, versions: 1, audits: 1 });

      // Commits keep the revision bound on disk, as appendSessionRevision does.
      for (let rev = 2; rev < SESSION_REVISION_LIMIT + 5; rev++) assert.ok((await commit(`Save ${rev}`, rev)).committed);
      assert.equal((await rows()).revisions, SESSION_REVISION_LIMIT);
    } finally { await admin.end(); }
  });
});

test('a later page of the history across documents starts at its position, not at the newest version (plan 221)', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // Migration 0076's index only helps when the query bounds `at` by the
  // position. The check runs the store's own statement under EXPLAIN ANALYZE,
  // caught on its way to the pool, and counts the version rows it read.
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const poolQuery = pg.Pool.prototype.query;
    try {
      const owner = await store.upsertUserBySub({ sub: 'history-paging', email: 'history-paging@example.invalid', groups: [], role: 'member' });
      const at = new Date().toISOString();
      const PROJECTS = 100, PER_DOCUMENT = 200, IN_SCOPE = 10, DEEP = 50, LIMIT = 50;
      for (let p = 0; p < PROJECTS; p++) {
        await store.putProject({ id: `prj_hp${p}`, name: `History ${p}`, visibility: 'private', ownerId: owner.id, createdAt: at });
        await store.putSession({ id: `ses_hp${p}`, projectId: `prj_hp${p}`, toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {},
          createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at });
      }
      // One version a second, the documents taking turns, so every page of the
      // ten documents in scope has the other ninety's versions between its rows.
      await admin.query(`insert into session_version_contents (session_id, digest, inputs, bytes)
        select 'ses_hp' || p, 'd', '{}'::jsonb, 2 from generate_series(0, $1::int - 1) p`, [PROJECTS]);
      await admin.query(`insert into session_versions (id, session_id, rev, kind, digest, meta, at)
        select format('ver_hp%s_%s', p, i), 'ses_hp' || p, 1, 'auto', 'd', '{}'::jsonb,
          timestamptz '2026-01-01T00:00:00Z' + (i * $1::int + p) * interval '1 second'
        from generate_series(0, $1::int - 1) p, generate_series(0, $2::int - 1) i`, [PROJECTS, PER_DOCUMENT]);
      await admin.query('analyze');

      const projectIds = Array.from({ length: IN_SCOPE }, (_, p) => `prj_hp${p}`);
      const after = { at: new Date(Date.parse('2026-01-01T00:00:00Z') + DEEP * PROJECTS * 1000).toISOString(), id: `ver_hp0_${DEEP}` };
      const caught: Array<{ text: string; values: unknown[] }> = [];
      pg.Pool.prototype.query = function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string' && args[0].includes('join sessions s on s.id = v.session_id')) caught.push({ text: args[0], values: args[1] as unknown[] });
        return (poolQuery as (...a: unknown[]) => unknown).apply(this, args);
      } as unknown as typeof poolQuery;
      const page = await store.listVersionHistory({ projectIds, after, limit: LIMIT });
      pg.Pool.prototype.query = poolQuery;

      assert.equal(page.length, LIMIT);
      assert.ok(page.every((e) => projectIds.includes(e.projectId) && e.at < after.at), 'the page is in scope and older than its position');
      assert.equal(caught.length, 1, 'the history statement went through the pool');
      const { rows } = await admin.query(`explain (analyze, format json) ${caught[0]!.text}`, caught[0]!.values);
      type PlanNode = { 'Relation Name'?: string; 'Index Cond'?: string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; Plans?: PlanNode[] };
      const scans = (node: PlanNode): PlanNode[] => [...(node['Relation Name'] === 'session_versions' ? [node] : []), ...(node.Plans ?? []).flatMap(scans)];
      const versionScans = scans((rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan);
      assert.ok(versionScans.length && versionScans.every((n) => /\bat <= /.test(n['Index Cond'] ?? '')),
        `the versions are read from an index starting at the position: ${JSON.stringify(versionScans.map((n) => n['Index Cond'] ?? null))}`);
      const versionsRead = versionScans.reduce((sum, n) => sum + (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'], 0);
      const newer = (PER_DOCUMENT - DEEP) * PROJECTS;
      // From the position, a page reads its own rows and the other documents'
      // rows between them (about LIMIT * PROJECTS / IN_SCOPE), or every older
      // version of the documents in scope (IN_SCOPE * DEEP), whichever plan
      // Postgres picks. Reading from the newest version would pass `newer` rows first.
      assert.ok(versionsRead <= 2 * Math.max(LIMIT * PROJECTS / IN_SCOPE, IN_SCOPE * DEEP),
        `a deep page read ${versionsRead} version rows; ${newer} versions are newer than its position`);
    } finally {
      pg.Pool.prototype.query = poolQuery;
      await admin.end();
    }
  });
});
