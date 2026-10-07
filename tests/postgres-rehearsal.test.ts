// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'deploy/suse/postgres-rehearsal.sh');
const temporary: string[] = [];
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lw-pg18-rehearsal-test-'));
  temporary.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls'); writeFileSync(calls, '');
  const service = join(dir, 'pg_service.conf'); const passwords = join(dir, 'pgpass');
  writeFileSync(service, '[source]\nhost=example.invalid\ndbname=source\n');
  writeFileSync(passwords, 'example.invalid:5432:*:operator:do-not-log-this-password\n');
  chmodSync(service, 0o600); chmodSync(passwords, 0o600);
  const tools = {
    psql: `if [ "\${1:-}" = --version ]; then printf 'psql (PostgreSQL) %s\\n' "\${FAKE_CLIENT_VERSION:-18.6}"; exit; fi
      input=$(cat)
      printf 'psql %s\\n%s\\n' "$*" "$input" >> "$CALLS"
      [ "\${FAKE_QUERY_FAIL:-0}" = 0 ] || { printf 'private connection details' >&2; exit 8; }
      case "$* $input" in
        *server_version_num*) printf '%s|%s|%s|%s|%s\\n' "\${FAKE_SERVER_VERSION:-180006}" "\${FAKE_ENCODING:-UTF8}" "\${FAKE_PROVIDER:-b}" "\${FAKE_LOCALE:-C.UTF-8}" "\${FAKE_DATABASE:-lolly_rehearsal_case}" ;;
        *'CREATE DATABASE'*) printf 'CREATE DATABASE\\n' ;;
        *current_database*) printf '%s\\n' "\${FAKE_DATABASE:-lolly_rehearsal_case}" ;;
        *) printf '%s\\n' "\${FAKE_OBJECTS:-0}" ;;
      esac`,
    pg_dump: `if [ "\${1:-}" = --version ]; then printf 'pg_dump (PostgreSQL) %s\\n' "\${FAKE_CLIENT_VERSION:-18.6}"; exit; fi
      printf 'dump %s OPTIONS=%s\\n' "$*" "$PGOPTIONS" >> "$CALLS"
      [ "\${FAKE_DUMP_FAIL:-0}" = 0 ] || { printf 'private connection details' >&2; exit 7; }
      for arg in "$@"; do case "$arg" in --file=*) printf 'PGDMP-test' > "\${arg#--file=}" ;; esac; done`,
    pg_restore: `if [ "\${1:-}" = --version ]; then printf 'pg_restore (PostgreSQL) %s\\n' "\${FAKE_CLIENT_VERSION:-18.6}"; exit; fi
      printf 'restore %s\\n' "$*" >> "$CALLS"
      case "$*" in *--list*) printf '; Dumped from database version: %s\\n' "\${FAKE_ARCHIVE_VERSION:-18.6}" ;; esac`,
  };
  for (const [name, source] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`); chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, PGSERVICE: 'source', PGSERVICEFILE: service, PGPASSFILE: passwords };
  for (const key of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) delete env[key];
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...overrides } });
  return { dir, service, passwords, calls, file: join(dir, 'backup with spaces.dump'), run };
}

test('PostgreSQL 17 clients or servers are refused before any dump', () => {
  const f = fixture();
  const client = f.run(['backup', f.file], { FAKE_CLIENT_VERSION: '17.11' });
  assert.equal(client.status, 1); assert.match(client.stderr, /client tools must be PostgreSQL 18/);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
  const server = f.run(['backup', f.file], { FAKE_SERVER_VERSION: '170011' });
  assert.equal(server.status, 1); assert.match(server.stderr, /no downgrade/);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /^dump /m);
  assert.equal(existsSync(f.file), false);
});

test('source locale drift is refused and inspection only executes a bounded read-only transaction', () => {
  const f = fixture();
  for (const overrides of [{ FAKE_ENCODING: 'LATIN1' }, { FAKE_PROVIDER: 'c' }, { FAKE_LOCALE: 'en_US.utf8' }]) {
    const result = f.run(['backup', f.file], overrides);
    assert.equal(result.status, 1); assert.match(result.stderr, /builtin C.UTF-8/);
  }
  const inspection = f.run(['inspect']); assert.equal(inspection.status, 0, inspection.stderr);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /BEGIN READ ONLY;[\s\S]*statement_timeout = '5s';[\s\S]*ROLLBACK;/);
  assert.doesNotMatch(calls, /CREATE DATABASE|DROP|^dump /m);
  assert.doesNotMatch(inspection.stdout, /lolly_rehearsal_case|example.invalid/);
});

test('connection overrides, credential URLs and permissive files are refused without connecting', () => {
  const f = fixture();
  for (const overrides of [{ PGPASSWORD: 'do-not-log-this-password' }, { PGDATABASE: 'postgres://secret.invalid/db' }, { PGSERVICE: 'postgres://secret.invalid/db' }, { PGSERVICEFILE: 'relative-service' }]) {
    const result = f.run(['inspect'], overrides); assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr + result.stdout, /do-not-log-this-password|secret.invalid/);
  }
  chmodSync(f.service, 0o644);
  const result = f.run(['inspect']); assert.equal(result.status, 1); assert.match(result.stderr, /0400 or 0600/);
  assert.equal(readFileSync(f.calls, 'utf8'), '');
});

test('backup uses single-client read-only options and leaves private connection errors out of output', () => {
  const f = fixture();
  const result = f.run(['backup', f.file]); assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /dump --no-password --format=custom --no-owner --no-privileges/);
  assert.match(calls, /default_transaction_read_only=on/);
  assert.doesNotMatch(calls, /do-not-log-this-password|postgres:\/\/|--jobs|--clean/);
  const failed = f.run(['backup', join(f.dir, 'failed.dump')], { FAKE_DUMP_FAIL: '1' });
  assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr + failed.stdout, /private connection details/);
});

test('database initialization only creates an explicitly confirmed rehearsal database with matching locale', () => {
  const f = fixture();
  assert.equal(f.run(['init-target', '--confirm-database', 'lollywork']).status, 1);
  assert.equal(f.run(['init-target', '--confirm-database', 'lolly_rehearsal_case']).status, 1, 'current connection is not the maintenance database');
  const result = f.run(['init-target', '--confirm-database', 'lolly_rehearsal_case'], { FAKE_DATABASE: 'postgres' });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /CREATE DATABASE :"rehearsal_database" OWNER lollywork TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';/);
  assert.doesNotMatch(calls, /DROP|password=/);
});

test('restore refuses old archives before destination access and refuses wrong or occupied targets', () => {
  const f = fixture(); assert.equal(f.run(['backup', f.file]).status, 0);
  const args = ['restore', f.file, '--confirm-database', 'lolly_rehearsal_case'];
  writeFileSync(f.calls, '');
  const old = f.run(args, { FAKE_ARCHIVE_VERSION: '17.11' });
  assert.equal(old.status, 1); assert.match(old.stderr, /Archive must come from PostgreSQL 18/);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /^psql /m);
  assert.equal(f.run(args, { FAKE_DATABASE: 'source' }).status, 1);
  assert.equal(f.run(args, { FAKE_OBJECTS: '1' }).status, 1);
  assert.equal(f.run(args, { FAKE_PROVIDER: 'c' }).status, 1);
  writeFileSync(f.calls, '');
  const restored = f.run(args); assert.equal(restored.status, 0, restored.stderr);
  assert.match(readFileSync(f.calls, 'utf8'), /restore --no-password --exit-on-error --single-transaction --no-owner --no-privileges --dbname=lolly_rehearsal_case/);
  assert.doesNotMatch(readFileSync(f.calls, 'utf8'), /--clean|--create/);
});

test('AppCo image is pinned to PostgreSQL 18 and database creation is delegated to the locale-checked rehearsal step', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'deploy/suse/appco-postgresql.lock.json'), 'utf8'));
  assert.equal(lock.sourceCompatibility.requiredMajor, 18);
  assert.match(lock.image.tag, /^18\./);
  assert.match(lock.image.digest, /^sha256:[a-f0-9]{64}$/);
  const profile = readFileSync(join(ROOT, 'deploy/suse/appco-postgresql.yaml'), 'utf8');
  assert.ok(profile.includes(`digest: "${lock.image.digest}"`));
  assert.match(profile, /database: ""/);
  assert.match(profile, /existingSecret: lolly-postgres-auth/);
  assert.match(profile, /enabled: true\n  existingSecret: lolly-postgres-tls/);
  assert.match(profile, /serviceAccount:\n  enabled: true\n  automountServiceAccountToken: false/);
  assert.match(profile, /seccompProfile:\n    type: RuntimeDefault/);
  assert.match(profile, /capabilities:\n          drop:\n            - ALL/);
});
