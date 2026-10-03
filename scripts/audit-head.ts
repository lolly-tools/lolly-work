/**
 * Print the audit log's head and whether it verifies, straight from the
 * database. Read-only: it never installs a key and never writes. The server
 * image carries scripts/ but not cli/, so this is how the head is read on a
 * container that has no owner session at hand, e.g. right before a secret
 * rotation (deploy/vm/rotate-secrets.sh) while the old secret is still there:
 *
 *   docker compose exec -T server node scripts/audit-head.ts --json
 *
 * Needs DATABASE_URL. With LW_SESSION_SECRET it also checks every MAC under the
 * key derived from it; without, only the public hash links. Prints the head
 * (the same shape as GET /api/v1/audit/head) plus `linksIntact` (hash links
 * only, no key) and `keyChecked`: seqs, public hashes and counts, never a
 * secret. Exit 0 when the chain verifies, 2 when it does not, 1 on a usage or
 * environment problem.
 */
import { parseArgs } from 'node:util';
import { deriveAuditMacKey, verifyChain } from '../server/src/audit/chain.ts';
import { headOf } from '../server/src/audit/head.ts';

let json = false;
try {
  ({ values: { json = false } } = parseArgs({ options: { json: { type: 'boolean' } } }));
} catch (err) {
  console.error(`audit-head: ${(err as Error).message}\nusage: node scripts/audit-head.ts [--json]`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('audit-head: DATABASE_URL is not set; run it where the server runs (docker compose exec -T server …).');
  process.exit(1);
}
const secret = process.env.LW_SESSION_SECRET;
const { createPostgresStore } = await import('../server/src/store/postgres.ts');
const store = await createPostgresStore(url);
try {
  const [events, anchor] = await Promise.all([store.listAudit(), store.getAuditAnchor()]);
  const head = headOf(events, anchor, secret ? deriveAuditMacKey(secret) : undefined);
  const links = verifyChain(events, anchor);
  const report = { ...head, linksIntact: links.ok, ...(links.ok ? {} : { linksBadSeq: links.badSeq }), keyChecked: Boolean(secret) };
  console.log(json ? JSON.stringify(report) : [
    `head #${report.seq} · ${report.hash} · ${report.count} events`,
    report.chainIntact ? `intact${secret ? '' : ' (hash links only: LW_SESSION_SECRET is not set)'}` : `BROKEN at #${report.badSeq}`,
    links.ok ? '' : `hash links broken at #${links.badSeq}`,
  ].filter(Boolean).join(' · '));
  process.exitCode = report.chainIntact ? 0 : 2;
} catch (err) {
  console.error(`audit-head: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await store.close();
}
