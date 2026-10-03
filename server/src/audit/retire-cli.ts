/**
 * The operator entry for retiring the audit MAC key (audit/retire.ts). It
 * talks to the database directly, like `lw migrate`, because it must run with
 * the server's own secret: the boundary row is MAC'd under the key derived from
 * LW_SESSION_SECRET, and only a holder of that value can write one that
 * verifies. Two ways in, the same code:
 *
 *   node scripts/audit-retire-key.ts --reason "…" [options]   (in the server image)
 *   lw audit retire-key --reason "…" [options]                 (from a checkout)
 *
 * Options: --dry-run, --json, --expect-head <seq>:<hash> (the head recorded
 * before the rotation), --allow-interleaved and --no-witness (overrides, which
 * the boundary records). Needs DATABASE_URL and LW_SESSION_SECRET;
 * LW_SESSION_SECRET_PREVIOUS, when set, is used to check the rows first.
 * Prints seqs, public hashes and counts, never a secret. Exit 0 when a boundary
 * was written or there was nothing to retire, 1 on a usage or environment
 * problem, 2 when it refuses or the chain still fails after the boundary.
 */
import { parseArgs } from 'node:util';
import { deriveAuditMacKey } from './chain.ts';
import { checkRetireReason, parseExpectHead, retireAuditKey, type RetireResult } from './retire.ts';

const USAGE = 'usage: audit retire-key --reason "secret rotation 2026-10-04" [--expect-head <seq>:<hash>] [--dry-run] [--json] [--allow-interleaved] [--no-witness]';

function summary(r: RetireResult): string {
  const range = r.firstStaleSeq !== undefined ? ` (#${r.firstStaleSeq} to #${r.lastStaleSeq})` : '';
  const rows = `${r.staleRows} row${r.staleRows === 1 ? '' : 's'}${range}`;
  const checked = r.previousKeyChecked ? ', each checked against LW_SESSION_SECRET_PREVIOUS' : ', not checked against any earlier key (none given)';
  const notes = [
    r.staleAfterHead !== undefined
      ? `the head recorded before the rotation still has its hash; ${r.staleAfterHead} of these rows came after it, written before every host ran the new secret`
      : 'no --expect-head given, so nothing shows the older rows are unchanged since the rotation',
    r.witnessRows > 0 ? `${r.witnessRows} later row${r.witnessRows === 1 ? '' : 's'} verify under this key` : 'NO later row verifies under this key (--no-witness)',
    ...(r.currentSeq !== undefined ? [`row #${r.currentSeq} verifies under this key although later rows do not (--allow-interleaved)`] : []),
  ].join('; ');
  switch (r.status) {
    case 'current':
      return `nothing to retire: the chain verifies under the current key${r.tail ? ` through #${r.tail.seq}` : ''}.`;
    case 'broken':
      return `refusing: the hash chain itself is broken at #${r.badSeq}. That is an edit or a deletion, not a key change; investigate it before anything else (docs/audit.md).`;
    case 'head-mismatch':
      return `refusing: row #${r.badSeq} is gone or no longer has the hash given with --expect-head. The log changed after that head was recorded; investigate it before anything else (docs/audit.md).`;
    case 'stripped':
      return `refusing: row #${r.badSeq} has no MAC although an earlier row has one. Every host signs its rows once the key exists, so that MAC was removed: an edit, not a key change (docs/audit.md).`;
    case 'interleaved':
      return `refusing: row #${r.currentSeq} verifies under the current key but the later row #${r.badSeq} does not. A key change leaves the old-key rows first and the current-key rows after them, so this is an edit re-chained from there on, or a host that still writes with the old secret. ` +
        'If it is the second (for example a deployment not yet redeployed with the new value), switch that host, then run again with --allow-interleaved; the boundary records it.';
    case 'no-witness':
      return `refusing: no row after the old ones${range} verifies under the LW_SESSION_SECRET this command was given, so nothing shows the server runs with it, and a boundary under any other key is ignored. ` +
        'Sign in once on the deployment (that writes a row with the server\'s key) and run again; --no-witness skips this check.';
    case 'previous-mismatch':
      return `refusing: row #${r.badSeq} verifies under neither LW_SESSION_SECRET nor LW_SESSION_SECRET_PREVIOUS. ` +
        'If PREVIOUS is not the value this rotation replaced, run without it (in the container: docker compose exec -e LW_SESSION_SECRET_PREVIOUS= server …); otherwise investigate that row.';
    case 'retire':
      if (!r.written) return `dry run: would retire ${rows}${checked}, with a boundary after #${r.tail!.seq} (hash ${r.tail!.hash}); ${notes}.`;
      return `wrote boundary #${r.event.seq}: ${rows} signed with a retired key${checked}; it records #${r.tail!.seq} (hash ${r.tail!.hash}); ${notes}. ` +
        `Chain now: ${r.after.ok ? 'intact' : `BROKEN at #${r.after.badSeq}`}.`;
  }
}

/** Run the command; returns the process exit code. */
export async function runRetireKeyCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values: {
    reason?: string; 'expect-head'?: string; 'dry-run'?: boolean; json?: boolean;
    'allow-interleaved'?: boolean; 'no-witness'?: boolean; help?: boolean;
  };
  try {
    ({ values } = parseArgs({ args: argv, allowPositionals: false, options: {
      reason: { type: 'string' }, 'expect-head': { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
      'allow-interleaved': { type: 'boolean' }, 'no-witness': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } }));
  } catch (err) {
    console.error(`retire-key: ${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  if (values.help) { console.log(USAGE); return 0; }
  let reason: string;
  let expectHead: { seq: number; hash: string } | undefined;
  try {
    reason = checkRetireReason(values.reason);
    if (values['expect-head'] !== undefined) expectHead = parseExpectHead(values['expect-head']);
  } catch (err) {
    console.error(`retire-key: ${(err as Error).message}\n${USAGE}`);
    return 1;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    console.error('retire-key: DATABASE_URL is not set. This command writes to the database directly; run it where the server runs (docker compose exec server …), not against LW_BASE.');
    return 1;
  }
  // Never the dev-only random fallback loadSecrets would use outside
  // production: a boundary MAC'd under a throwaway key verifies nowhere.
  const secret = env.LW_SESSION_SECRET;
  if (!secret) {
    console.error('retire-key: LW_SESSION_SECRET is not set. The boundary is MAC\'d under the key derived from it; run this with the server\'s environment.');
    return 1;
  }
  const previous = env.LW_SESSION_SECRET_PREVIOUS;
  const { createPostgresStore } = await import('../store/postgres.ts');
  const store = await createPostgresStore(url);
  try {
    const result = await retireAuditKey(store, {
      macKey: deriveAuditMacKey(secret),
      ...(previous ? { previousMacKey: deriveAuditMacKey(previous) } : {}),
      ...(expectHead ? { expectHead } : {}),
      allowInterleaved: values['allow-interleaved'] === true,
      noWitness: values['no-witness'] === true,
      reason,
      dryRun: values['dry-run'] === true,
    });
    console.log(values.json ? JSON.stringify(result, null, 2) : summary(result));
    const refused = result.status !== 'retire' && result.status !== 'current';
    return refused || (result.written && !result.after.ok) ? 2 : 0;
  } catch (err) {
    console.error(`retire-key: ${(err as Error).message}`);
    return 1;
  } finally {
    await store.close();
  }
}
