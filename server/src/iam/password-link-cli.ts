// SPDX-License-Identifier: MPL-2.0
/**
 * The operator's way to an owner's password (plans/74), for when no admin can
 * issue one from the console: an instance whose only sign-in is email and
 * password has no admin until someone signs in, and nobody signs in without a
 * link; and an owner who is locked out has nobody above them to ask. Writes a
 * one-time link for an address listed in `idp.bootstrapOwners` straight into
 * the database, records it in the audit log, and prints it:
 *
 *   node scripts/password-link.ts --email ana@example.com   (in the server image)
 *
 * The link is the one an owner issues from the console: it works once, for
 * seven days, replaces the address's earlier unused links, and still has to
 * pass admission when it is used. A password set from it may sign in as an
 * owner. Needs LW_CONFIG (or ./instance.json), DATABASE_URL and
 * LW_SESSION_SECRET (the audit row is MAC'd under the key derived from it).
 * The link is printed and never stored: only its sha256 is. Exit 0 when a
 * link was written, 1 on a usage or environment problem, 2 when it refuses.
 */
import { parseArgs } from 'node:util';
import { loadConfig, passwordIdpOf, type InstanceConfig } from '../config/instance.ts';
import { deriveAuditMacKey } from '../audit/chain.ts';
import { randomId, sha256Hex } from '../lib/crypto.ts';
import type { Store } from '../store/types.ts';
import { OPERATOR_LINK_ISSUER, PASSWORD_LINK_TTL_MS, normaliseEmail, passwordSetUrl } from './password.ts';

const USAGE = 'usage: password-link --email <an address listed in idp.bootstrapOwners>';
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Run the command; returns the process exit code. `deps` lets a test hand
 *  in the config and a store instead of LW_CONFIG and DATABASE_URL. */
export async function runPasswordLinkCommand(
  argv: string[], env: NodeJS.ProcessEnv = process.env,
  deps: { config?: InstanceConfig; store?: Store; out?: (line: string) => void; err?: (line: string) => void } = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  let values: { email?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, allowPositionals: false, options: {
      email: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } }));
  } catch (e) {
    err(`password-link: ${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  if (values.help) { out(USAGE); return 0; }
  const email = normaliseEmail(values.email ?? '');
  if (!email || email.length > 254 || !EMAIL.test(email)) {
    err(`password-link: --email must be an email address\n${USAGE}`);
    return 1;
  }
  let config: InstanceConfig;
  try {
    config = deps.config ?? loadConfig(env.LW_CONFIG ?? './instance.json');
  } catch (e) {
    err(`password-link: ${(e as Error).message}`);
    return 1;
  }
  const idp = passwordIdpOf(config);
  if (!idp) {
    err('password-link: email and password sign-in is not configured here: idp.additional has no entry with kind "password".');
    return 1;
  }
  if (!config.idp.bootstrapOwners.some((o) => normaliseEmail(o) === email)) {
    err(`password-link: refusing: ${email} is not listed in idp.bootstrapOwners. This command is for an owner's first password, or an owner who is locked out. Anyone else gets a link from an admin or owner in the console (People).`);
    return 2;
  }
  let store = deps.store;
  let close: (() => Promise<void>) | null = null;
  if (!store) {
    const url = env.DATABASE_URL;
    if (!url) {
      err('password-link: DATABASE_URL is not set. This command writes to the database directly; run it where the server runs (docker compose exec server ...).');
      return 1;
    }
    // Never a throwaway key: an audit row MAC'd under one breaks the chain.
    const secret = env.LW_SESSION_SECRET;
    if (!secret) {
      err('password-link: LW_SESSION_SECRET is not set. The audit row is MAC\'d under the key derived from it; run this with the server\'s environment.');
      return 1;
    }
    const { createPostgresStore } = await import('../store/postgres.ts');
    const pg = await createPostgresStore(url);
    pg.setAuditMacKey?.(deriveAuditMacKey(secret));
    store = pg;
    close = () => pg.close();
  }
  try {
    if ((await store.findUsersByEmail(email)).some((u) => u.disabledAt)) {
      err(`password-link: refusing: ${email} belongs to a disabled account. Re-enable it first.`);
      return 2;
    }
    const now = Date.now();
    const token = randomId(32);
    const purpose = (await store.getPasswordCredential(email)) ? 'reset' : 'setup';
    const expiresAt = new Date(now + PASSWORD_LINK_TTL_MS).toISOString();
    await store.createPasswordLink({
      tokenHash: sha256Hex(token), email, purpose, createdBy: OPERATOR_LINK_ISSUER, createdAt: new Date(now).toISOString(), expiresAt,
    });
    await store.appendAudit({
      at: new Date(now).toISOString(), actor: OPERATOR_LINK_ISSUER, action: 'auth.password.link.issue', subject: 'session',
      payload: { idp: idp.id, email, purpose, via: 'scripts/password-link.ts' },
    });
    out(`A one-time link that sets the password for ${email}. It works once, until ${expiresAt}, and replaces any earlier unused link:`);
    out(passwordSetUrl(config.instance.baseUrl, token));
    return 0;
  } catch (e) {
    err(`password-link: ${(e as Error).message}`);
    return 1;
  } finally {
    await close?.();
  }
}
