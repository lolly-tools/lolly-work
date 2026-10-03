// SPDX-License-Identifier: MPL-2.0
/**
 * Print a one-time link that sets the password of an owner listed in
 * idp.bootstrapOwners (plans/74): the way to the first owner on an instance
 * whose only sign-in is email and password, and back in for an owner who is
 * locked out. The server image carries scripts/, so on a container:
 *
 *   docker compose exec server node scripts/password-link.ts --email ana@example.com
 *
 * Same code as server/src/iam/password-link-cli.ts. Needs the server's
 * LW_CONFIG, DATABASE_URL and LW_SESSION_SECRET.
 */
import { runPasswordLinkCommand } from '../server/src/iam/password-link-cli.ts';

process.exit(await runPasswordLinkCommand(process.argv.slice(2)));
