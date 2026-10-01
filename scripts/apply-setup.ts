// SPDX-License-Identifier: MPL-2.0
import { readFile, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { generateSetup, mergeSetupPatch } from '../server/src/setup/configuration.ts';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--write')) {
  console.error('Usage: pnpm setup:apply <instance.json> <lolly-setup.json> [--write]'); process.exit(1);
}
const target = resolve(args[0]!);
let temporary: string | undefined;
try {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Use the regular source configuration file, before deploying its mounted copy.');
  const original = await readFile(target, 'utf8');
  const artifact = JSON.parse(await readFile(resolve(args[1]!), 'utf8'));
  if (artifact.version !== 1) throw new Error('Download a current setup file from Customer setup.');
  const proposal = generateSetup(artifact.settings, parseConfig(original));
  if (proposal.expectedSettingsHash !== artifact.expectedSettingsHash) throw new Error('This proposal no longer matches the source configuration. Regenerate it before applying.');
  const result = mergeSetupPatch(JSON.parse(original), proposal.patch);
  parseConfig(JSON.stringify(result));
  if (args[2] !== '--write') {
    console.log('Validated. No file changed. Run the same command with --write to back up and update the source configuration.');
  } else {
    const backup = `${target}.setup-backup-${Date.now()}-${process.pid}`;
    await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
    temporary = `${target}.setup-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: info.mode & 0o777, flag: 'wx' });
    if (await readFile(target, 'utf8') !== original) throw new Error('The source changed during validation. Retry with the current file.');
    await rename(temporary, target); temporary = undefined;
    console.log(`Updated source configuration. Backup: ${backup}. Deploy it, restart, then refresh Customer setup to verify the applied settings.`);
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON. Check the source configuration and downloaded setup file.' : (error as Error).message);
  process.exitCode = 1;
} finally { if (temporary) await unlink(temporary).catch(() => {}); }
