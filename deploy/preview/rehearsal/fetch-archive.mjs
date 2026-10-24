// SPDX-License-Identifier: MPL-2.0
// Restore rehearsal, fetch step. Runs in the PREVIOUS (live, accepted) Work
// image, the only container that mounts the read-only backup credential. It
// recovers exactly one backup object with the image's own backup CLI
// (scripts/backup-object.ts: authenticated decryption and a plaintext digest
// check) and confirms the bytes are the backup the caller named. It prints no
// credential and no archive content.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROGRAMS = process.env.REHEARSAL_PROGRAMS ?? '/programs';
const APP = process.env.REHEARSAL_APP ?? '/app';
const ARCHIVE = process.env.REHEARSAL_ARCHIVE ?? '/archive';
const BACKUP = process.env.REHEARSAL_BACKUP_SECRET ?? '/run/backup';

const out = value => process.stdout.write(JSON.stringify({ step: 'fetch', ...value }) + '\n');
const fail = reason => { out({ status: 'FAILED', reason }); process.exit(1); };

const expected = JSON.parse(readFileSync(join(PROGRAMS, 'archive.json'), 'utf8'));
let endpointHost;
try {
  // Only the endpoint's host name is read, to match the Pod's fixed address for it.
  endpointHost = new URL(JSON.parse(readFileSync(join(BACKUP, 'storage.json'), 'utf8')).endpoint).hostname;
} catch {
  fail('the backup credential is missing or unreadable');
}
if (endpointHost !== expected.storageHost) fail('the backup credential names a different storage host than this rehearsal');

const cli = join(APP, 'scripts/backup-object.ts');
const run = spawnSync(process.execPath, ['--max-old-space-size=128', cli, 'restore',
  '--credentials', join(BACKUP, 'storage.json'), '--key', join(BACKUP, 'encryption-key.txt'),
  '--object', expected.object, '--output', join(ARCHIVE, 'database.dump')], {
  cwd: APP, encoding: 'utf8', maxBuffer: 65536, timeout: 300_000,
  env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.TMPDIR ?? '/tmp' },
});
if (run.error || run.status !== 0) fail('the backup object could not be recovered and verified');
let reported;
try {
  reported = JSON.parse(run.stdout.trim().split('\n').pop());
} catch {
  fail('the backup CLI gave no result');
}
if (reported.status !== 'VERIFIED' || reported.sha256 !== expected.sha256 || reported.size !== expected.size
  || reported.keyId !== expected.keyId) fail('the recovered object is not the named backup');
const file = lstatSync(join(ARCHIVE, 'database.dump'));
if (!file.isFile() || file.size !== expected.size) fail('the recovered archive has the wrong size');
const digest = createHash('sha256').update(readFileSync(join(ARCHIVE, 'database.dump'))).digest('hex');
if (digest !== expected.sha256) fail('the recovered archive checksum differs');
writeFileSync(join(ARCHIVE, 'database.dump.sha256'), digest + '\n', { flag: 'wx', mode: 0o600 });
out({ status: 'RECOVERED', sha256: digest, size: file.size, keyId: reported.keyId });
