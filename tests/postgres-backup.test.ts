// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'vm', 'postgres-backup.sh');
const temporary: string[] = [];
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-pg-backup-test-'));
  temporary.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const files = {
    pg_dump: `printf 'dump %s\\n' "$*" >> "$CALLS"
      [ "\${FAKE_DUMP_FAIL:-0}" = 0 ] || exit 9
      for arg in "$@"; do case "$arg" in --file=*) printf 'PGDMP-example' > "\${arg#--file=}" ;; esac; done`,
    pg_restore: `printf 'restore %s\\n' "$*" >> "$CALLS"
      [ "\${FAKE_RESTORE_FAIL:-0}" = 0 ] || exit 8`,
    psql: `printf 'psql %s\\n' "$*" >> "$CALLS"
      case "$*" in *current_database*) printf '%s\\n' "\${FAKE_DATABASE:-lolly_target}" ;; *) printf '%s\\n' "\${FAKE_OBJECTS:-0}" ;; esac`,
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, PGSERVICE: '', PGHOST: '127.0.0.1', PGDATABASE: 'lolly_source' };
  const run = (args: string[], overrides: Record<string, string> = {}) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...overrides } });
  return { dir, calls, file: join(dir, 'backup with spaces.dump'), run };
}

test('backup publishes a verified private archive and refuses overwrites', () => {
  const f = fixture();
  const backup = f.run(['backup', f.file]);
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(statSync(`${f.file}.sha256`).mode & 0o777, 0o600);
  assert.match(readFileSync(`${f.file}.sha256`, 'utf8'), /^[a-f0-9]{64}\n$/);
  assert.ok(!readdirSync(f.dir).some((name) => name.includes('.partial.')));
  assert.equal(f.run(['verify', f.file]).status, 0);
  const again = f.run(['backup', f.file]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(readFileSync(f.file, 'utf8'), 'PGDMP-example');
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /dump --no-password --format=custom --no-owner --no-privileges/);
  assert.doesNotMatch(calls, /postgres:\/\/|password=/);
});

test('checksum extraction supports escaped filenames without an awk dependency', () => {
  const f = fixture();
  const file = join(f.dir, 'backup\\with newline\n.dump');
  const backup = f.run(['backup', file]);
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(readFileSync(`${file}.sha256`, 'utf8').trim(), createHash('sha256').update(readFileSync(file)).digest('hex'));
  assert.equal(f.run(['verify', file]).status, 0);
});

test('a failed dump publishes nothing and cleans temporary files', () => {
  const f = fixture();
  assert.equal(f.run(['backup', f.file], { FAKE_DUMP_FAIL: '1' }).status, 9);
  assert.equal(existsSync(f.file), false);
  assert.equal(existsSync(`${f.file}.sha256`), false);
  assert.ok(!readdirSync(f.dir).some((name) => name.includes('.partial.')));
});

test('backup and restore require an explicit libpq connection', () => {
  const f = fixture();
  const result = f.run(['backup', f.file], { PGHOST: '', PGDATABASE: '', PGSERVICE: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no default database/);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
  assert.equal(f.run(['backup', f.file], { PGHOST: '', PGDATABASE: '', PGSERVICE: 'lolly-source' }).status, 0);
});

test('archive tampering is refused before the destination is contacted', () => {
  const f = fixture();
  assert.equal(f.run(['backup', f.file]).status, 0);
  writeFileSync(f.file, 'corrupted');
  writeFileSync(f.calls, '');
  const result = f.run(['restore', f.file, '--confirm-database', 'lolly_target']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum does not match/);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
});

test('restore checks the actual database name, refuses occupied targets and uses one transaction', () => {
  const f = fixture();
  assert.equal(f.run(['backup', f.file]).status, 0);
  const args = ['restore', f.file, '--confirm-database', 'lolly_target'];
  const wrong = f.run(args, { FAKE_DATABASE: 'another_database' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not match/);
  const occupied = f.run(args, { FAKE_OBJECTS: '1' });
  assert.equal(occupied.status, 1);
  assert.match(occupied.stderr, /contains objects/);
  writeFileSync(f.calls, '');
  assert.equal(f.run(args).status, 0);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /restore --no-password --exit-on-error --single-transaction --no-owner --no-privileges --dbname=lolly_target/);
  assert.doesNotMatch(calls, /--clean|--create/);
  assert.equal(f.run(args, { FAKE_RESTORE_FAIL: '1' }).status, 8);
});

test('restore refuses maintenance and template databases', () => {
  const f = fixture();
  assert.equal(f.run(['backup', f.file]).status, 0);
  for (const name of ['postgres', 'template0', 'template1']) {
    const result = f.run(['restore', f.file, '--confirm-database', name], { FAKE_DATABASE: name });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dedicated Lolly database/);
  }
});

test('PostgreSQL round trip preserves project records and asset bytes; a second restore is refused', {
  skip: process.env.LW_TEST_BACKUP_POSTGRES !== '1',
}, () => {
  assert.equal(process.env.PGDATABASE, 'lolly_backup_source', 'use the workflow\'s dedicated disposable source database');
  const target = `lolly_backup_target_${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), 'lw-pg-backup-roundtrip-'));
  temporary.push(dir);
  const file = join(dir, 'lolly.dump');
  const psql = (sql: string, database = process.env.PGDATABASE) => {
    const result = spawnSync('psql', ['--no-password', '-X', '-qAt', '--set=ON_ERROR_STOP=1', '--command', sql], {
      encoding: 'utf8', env: { ...process.env, PGDATABASE: database },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  psql(`CREATE DATABASE ${target}`);
  try {
    psql("CREATE TABLE backup_project (id text PRIMARY KEY, document jsonb NOT NULL, bytes bytea NOT NULL); INSERT INTO backup_project VALUES ('shared-project', '{\"members\":[\"owner\",\"editor\"],\"revision\":7}', decode('000102ff', 'hex'))");
    const backup = spawnSync('bash', [SCRIPT, 'backup', file], { encoding: 'utf8', env: process.env });
    assert.equal(backup.status, 0, backup.stderr);
    const restore = () => spawnSync('bash', [SCRIPT, 'restore', file, '--confirm-database', target], {
      encoding: 'utf8', env: { ...process.env, PGDATABASE: target },
    });
    const restored = restore();
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(psql("SELECT id || '|' || (document->>'revision') || '|' || encode(bytes, 'hex') FROM backup_project", target), 'shared-project|7|000102ff');
    const repeated = restore();
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /contains objects/);
  } finally {
    psql('DROP TABLE IF EXISTS backup_project');
    psql(`DROP DATABASE ${target} WITH (FORCE)`);
  }
});
