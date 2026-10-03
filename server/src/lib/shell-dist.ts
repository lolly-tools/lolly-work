/**
 * Shell-dist freshness check. The instance serves a built Lolly web shell
 * same-origin at `/` (instance.shellDir); a dist built BEFORE the org/
 * governance module lacks the session gate + locked-input UX, so serving it
 * under a non-open access mode silently un-governs every employee. Heuristic:
 * a fresh bundle references the org-config endpoint somewhere in its built
 * scripts (same marker scan scripts/demo.ts uses to pick its access mode).
 * Current Lolly builds write their scripts to `_app/`; older ones used
 * `assets/`, so both are scanned.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a Lolly web build puts its JavaScript, newest layout first. */
export const SHELL_SCRIPT_DIRS = ['_app', 'assets'] as const;

export interface ShellDistCheck {
  /** The dist exists (index.html present under shellDir). */
  present: boolean;
  /** Some built script carries the org-config marker - the governance UX shipped. */
  hasOrgConfig: boolean;
}

export function checkShellDist(shellDir: string): ShellDistCheck {
  if (!existsSync(join(shellDir, 'index.html'))) return { present: false, hasOrgConfig: false };
  for (const dir of SHELL_SCRIPT_DIRS) {
    const scriptsDir = join(shellDir, dir);
    let names: string[];
    try {
      names = readdirSync(scriptsDir);
    } catch {
      continue; // this layout is not used by the build
    }
    for (const name of names) {
      if (!name.endsWith('.js')) continue;
      try {
        if (readFileSync(join(scriptsDir, name), 'utf8').includes('org-config')) return { present: true, hasOrgConfig: true };
      } catch { /* unreadable chunk: skip */ }
    }
  }
  return { present: true, hasOrgConfig: false };
}
