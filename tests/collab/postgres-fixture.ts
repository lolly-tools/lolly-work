// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { runMigrations } from '../../server/src/store/migrate.ts';
import { createPostgresStore } from '../../server/src/store/postgres.ts';
const execute = promisify(execFile);

/** Own a disposable local cluster; never reset a supplied or shared database. */
export async function createCollabPostgresFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lolly-load-pg-'));
  const bin = process.env.LOLLY_PG_BIN;
  const command = (name: string) => bin ? join(bin, name) : name;
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const address = reserve.address();
  if (!address || typeof address === 'string') throw new Error('Postgres port reservation failed');
  const port = address.port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  let started = false;
  let store: Awaited<ReturnType<typeof createPostgresStore>> | undefined;
  const close = async () => {
    await store?.close(); store = undefined;
    if (started) { await execute(command('pg_ctl'), ['-D', directory, '-m', 'fast', '-w', 'stop']); started = false; }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await execute(command('initdb'), ['-D', directory, '-A', 'trust', '-U', 'lolly_load', '--no-locale', '--encoding=UTF8']);
    await execute(command('pg_ctl'), ['-D', directory, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
    started = true;
    const url = `postgres://lolly_load@127.0.0.1:${port}/postgres`;
    await runMigrations(url, resolve(import.meta.dirname, '../../migrations'));
    store = await createPostgresStore(url);
    const pid = Number((await readFile(join(directory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    const { stdout: version } = await execute(command('postgres'), ['--version']);
    return { store, pid, version: version.trim(), close };
  } catch (error) { await close(); throw error; }
}
