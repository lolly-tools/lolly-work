/**
 * Write a retired-key boundary into the audit log after LW_SESSION_SECRET was
 * rotated (docs/audit.md, "Rotating the session secret"). The server image
 * carries scripts/ but not cli/, so this is the entry to use on a container:
 *
 *   docker compose exec server node scripts/audit-retire-key.ts --reason "secret rotation 2026-10-04"
 *
 * Same code as `lw audit retire-key` (server/src/audit/retire-cli.ts). Needs
 * DATABASE_URL and LW_SESSION_SECRET, which the server container already has.
 */
import { runRetireKeyCommand } from '../server/src/audit/retire-cli.ts';

process.exit(await runRetireKeyCommand(process.argv.slice(2)));
