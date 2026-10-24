// SPDX-License-Identifier: MPL-2.0
/**
 * The allowlist migration classifier (server/src/store/migration-classifier.ts).
 * A file is additive only when every statement is on the allowlist; everything
 * else, including SQL the parser cannot read, is maintenance. The real
 * migrations directory is a fixture: each file's class is recorded in
 * tests/migration-classes.json, so a reclassification shows up in review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyMigrationSql, classifyMigrations } from '../server/src/store/migration-classifier.ts';
import { readMigrationFiles } from '../server/src/store/migrate.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./migration-classes.json', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/classify-migrations.ts', import.meta.url));

/** Tables an imaginary earlier migration created. */
const EXISTING = ['users', 'projects', 'sessions', 'audit_log'];
const classOf = (sql: string, existing: string[] = EXISTING) => classifyMigrationSql(sql, existing).class;

test('every existing migration keeps its recorded class', async () => {
  const recorded = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Record<string, string>;
  const verdicts = await classifyMigrations(MIGRATIONS);
  assert.deepEqual(Object.keys(recorded), await readMigrationFiles(MIGRATIONS),
    'tests/migration-classes.json must list every migration file, in apply order');
  const actual = Object.fromEntries(verdicts.map(v => [v.name, v.class]));
  assert.deepEqual(actual, recorded, 'a migration changed class; review the change and update tests/migration-classes.json');
});

test('0034, the audit-log append guard, is maintenance', async () => {
  const [verdict] = await classifyMigrations(MIGRATIONS, ['0034_audit_mac_and_append_guard.sql']);
  assert.equal(verdict!.class, 'maintenance');
  const reasons = verdict!.reasons.join('\n');
  assert.match(reasons, /CREATE OR REPLACE/);
  assert.match(reasons, /"drop trigger"/);
  assert.match(reasons, /"create trigger"/);
  // Its first statement alone (a nullable ADD COLUMN) is additive; the file is not.
  assert.equal(verdict!.statements[0]!.class, 'additive');
  // A later replacement of the guard function must never pass as additive either.
  assert.equal(classOf(`create or replace function audit_log_append_only() returns trigger language plpgsql as $$
    begin return new; end $$;`), 'maintenance');
  assert.equal(classOf('drop trigger if exists audit_log_append_only on audit_log;'), 'maintenance');
  assert.equal(classOf('alter table audit_log disable trigger audit_log_append_only;'), 'maintenance');
});

test('the allowlist: new tables, safe new columns, indexes on new tables, comments', () => {
  const additive = [
    '',
    '-- only a comment\n/* and /* a nested */ block */',
    `create table widgets (
       id text primary key check (length(id) <= 64),
       name text not null default 'x' unique,
       payload jsonb not null default '{}',
       at timestamptz not null default now(),
       n bigint generated always as identity,
       half numeric(10, 2),
       tags text[] not null default '{}',
       owner_id text references users(id) on delete cascade,
       maybe_project text references projects(id) on delete set null,
       constraint widgets_name_len check (length(name) < 100),
       unique nulls not distinct (name, payload)
     );`,
    'CREATE TABLE IF NOT EXISTS Public.Gadgets (Id INT PRIMARY KEY);',
    `create table parents (id text primary key);
     create table children (
       id text primary key,
       parent_id text not null references parents(id),
       session_id text not null,
       foreign key (session_id) references sessions(id) on delete cascade,
       foreign key (parent_id) references parents(id) on delete restrict
     );
     create index children_parent on children (parent_id);
     create index if not exists children_live on children using btree (parent_id) include (id) where parent_id is not null;
     create index on children (lower(id));`,
    'alter table users add column nickname text;',
    'alter table users add column if not exists level integer not null default 0;',
    "alter table only users add column tags jsonb not null default '[]'::jsonb, add column score numeric default -1.5;",
    "alter table if exists projects add colour text default 'teal'::text null;",
    "alter table users add column flag boolean default false;",
    "comment on table users is 'People'; comment on column users.email is null;",
    "comment on table users is 'drop table users; -- a string is not a statement';",
  ];
  for (const sql of additive) {
    const verdict = classifyMigrationSql(sql, EXISTING);
    assert.equal(verdict.class, 'additive', `${sql}\n${verdict.reasons.join('\n')}`);
  }
});

test('anything off the allowlist is maintenance', () => {
  const maintenance: Record<string, string> = {
    // tables
    'existing name': 'create table users (id text);',
    'existing name, if not exists': 'create table if not exists users (id text);',
    'reserved runner table': 'create table schema_migrations (name text);',
    'created twice': 'create table a (id int); create table a (id int);',
    'temporary': 'create temporary table a (id int);',
    'unlogged': 'create unlogged table a (id int);',
    'as select': 'create table a as select * from users;',
    'partition': 'create table a partition of users for values in (1);',
    'inherits': 'create table a (id int) inherits (users);',
    'like': 'create table a (like users);',
    'storage options': 'create table a (id int) with (fillfactor = 70);',
    'other schema': 'create table private.a (id int);',
    'exclusion constraint': 'create table a (r int, exclude using gist (r with =));',
    'deferrable key': 'create table a (id text references a(id) deferrable);',
    'match full': 'create table a (u text references users(id) match full on delete cascade);',
    // foreign keys to existing tables
    'fk restrict by default': 'create table a (u text references users(id));',
    'fk on delete restrict': 'create table a (u text references users(id) on delete restrict);',
    'fk set null on not null column': 'create table a (u text not null references users(id) on delete set null);',
    'fk set null at table level': 'create table a (u text, foreign key (u) references users(id) on delete set null);',
    'fk with on update': 'create table a (u text references users(id) on delete cascade on update cascade);',
    'fk table level default': 'create table a (u text, foreign key (u) references users(id));',
    // columns on existing tables
    'not null without default': 'alter table users add column age int not null;',
    'volatile default': 'alter table users add column seen timestamptz default now();',
    'expression default': "alter table users add column x int default 1 + 1;",
    'function default': "alter table users add column x text default gen_random_uuid()::text;",
    'check on new column': 'alter table users add column age int check (age > 0);',
    'unique new column': 'alter table users add column handle text unique;',
    'primary key column': 'alter table users add column pk int primary key;',
    'references new column': 'alter table users add column project_id text references projects(id) on delete cascade;',
    'generated new column': 'alter table users add column g int generated always as (1) stored;',
    'collated new column': 'alter table users add column c text collate "C";',
    'named constraint': 'alter table users add column c text constraint c_nn not null default \'x\';',
    'one bad action of two': 'alter table users add column ok text, drop column email;',
    // other table changes
    'add constraint': 'alter table users add constraint users_email_check check (email <> \'\');',
    'add check': 'alter table users add check (email <> \'\');',
    'add unique': 'alter table users add unique (email);',
    'add primary key': 'alter table users add primary key (id);',
    'add foreign key': 'alter table users add foreign key (id) references projects(id);',
    'drop column': 'alter table users drop column email;',
    'alter type': 'alter table users alter column email type varchar(10);',
    'set not null': 'alter table users alter column email set not null;',
    'rename': 'alter table users rename to people;',
    'rename column': 'alter table users rename column email to mail;',
    'owner': 'alter table users owner to someone;',
    'set schema': 'alter table users set schema archive;',
    'row level security': 'alter table users disable row level security;',
    'disable trigger': 'alter table users disable trigger all;',
    'drop table': 'drop table users;',
    'drop index': 'drop index users_email;',
    'truncate': 'truncate users;',
    // indexes
    'unique index on a new table': 'create table a (id int); create unique index a_id on a (id);',
    'index on an existing table': 'create index users_email on users (email);',
    'index concurrently': 'create table a (id int); create index concurrently a_id on a (id);',
    'index tablespace': 'create table a (id int); create index a_id on a (id) tablespace fast;',
    // code, privileges and data
    'create function': 'create function f() returns int language sql as $$ select 1 $$;',
    'security definer': 'create function f() returns int language sql security definer as $$ select 1 $$;',
    'create or replace view': 'create or replace view v as select 1;',
    'create trigger': 'create trigger t before insert on users for each row execute function f();',
    'create extension': 'create extension if not exists pgcrypto;',
    'create policy': 'create policy p on users using (true);',
    'alter policy': 'alter policy p on users using (false);',
    'create view': 'create view v as select * from users;',
    'create sequence': 'create sequence s;',
    'create type': "create type mood as enum ('a');",
    'grant': 'grant select on users to public;',
    'revoke': 'revoke all on users from public;',
    'do block': 'do $$ begin perform 1; end $$;',
    'insert': "insert into users (id) values ('x');",
    'update': "update users set email = '';",
    'delete': 'delete from users;',
    'set': "set lock_timeout = '1s';",
    'transaction control': 'begin; create table a (id int); commit;',
    'vacuum': 'vacuum users;',
    'odd comment': "comment on table users is 'a' 'b';",
    // SQL the parser cannot read
    'unterminated string': "create table a (s text default 'x);",
    'unterminated dollar quote': 'create table a (id int); comment on table a is $x$ open',
    'unterminated block comment': 'create table a (id int); /* open',
    'unicode escape': "create table a (s text default U&'\\0041');",
    'psql meta command': '\\i other.sql',
    // a comment never sets the class
    'comment claiming additive': '-- class: additive\ndrop table users;',
  };
  for (const [label, sql] of Object.entries(maintenance)) {
    const verdict = classifyMigrationSql(sql, EXISTING);
    assert.equal(verdict.class, 'maintenance', `${label}: ${sql}`);
    assert.ok(verdict.reasons.length > 0, `${label}: a maintenance verdict states why`);
  }
});

test('statements are split only outside strings, quoted names, comments and dollar quotes', () => {
  const verdict = classifyMigrationSql(`create table "semi;colon" (id int); -- ; not a split
    comment on table "semi;colon" is 'a;b'; /* ; */ comment on table users is $$x;y$$;`, EXISTING);
  assert.deepEqual(verdict.statements.map(s => s.kind), ['create-table', 'comment', 'other']);
  assert.equal(verdict.statements[2]!.class, 'maintenance', 'a dollar-quoted comment text is not on the allowlist');
  assert.deepEqual(verdict.createdTables, ['semi;colon']);
});

test('a file is judged against the tables every earlier file created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-classify-'));
  try {
    await writeFile(join(dir, '0001_a.sql'), 'create table alpha (id int);');
    await writeFile(join(dir, '0002_b.sql'), 'create index alpha_id on alpha (id);');
    await writeFile(join(dir, '0003_c.sql'), 'create table alpha (id int);');
    await writeFile(join(dir, '0004_d.sql'), 'create table beta (id int, a int references alpha(id) on delete cascade); create index beta_a on beta (a);');
    const all = await classifyMigrations(dir);
    assert.deepEqual(all.map(v => [v.name, v.class]), [
      ['0001_a.sql', 'additive'],
      ['0002_b.sql', 'maintenance'],
      ['0003_c.sql', 'maintenance'],
      ['0004_d.sql', 'additive'],
    ]);
    const only = await classifyMigrations(dir, ['0003_c.sql']);
    assert.deepEqual(only.map(v => [v.name, v.class]), [['0003_c.sql', 'maintenance']], 'context still comes from earlier files');
    assert.match(only[0]!.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(classifyMigrations(dir, ['0009_missing.sql']), /not in/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the script reports classes, the manifest of a pending set, and fails on maintenance when asked', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const json = run('--json', '--only', '0034_audit_mac_and_append_guard.sql,0070_service_credential_expiry.sql');
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout) as { version: number; manifest: string; migrations: { name: string; class: string; sha256: string }[] };
  assert.equal(body.version, 1);
  assert.deepEqual(body.migrations.map(m => [m.name, m.class]), [
    ['0034_audit_mac_and_append_guard.sql', 'maintenance'],
    ['0070_service_credential_expiry.sql', 'additive'],
  ]);
  assert.match(body.manifest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(run('--only', '0070_service_credential_expiry.sql', '--fail-on-maintenance').status, 0);
  assert.equal(run('--only', '0034_audit_mac_and_append_guard.sql', '--fail-on-maintenance').status, 2);
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^maintenance 0034_audit_mac_and_append_guard\.sql$/m);
  assert.equal(run('--only', 'nope.sql').status, 1);
});
