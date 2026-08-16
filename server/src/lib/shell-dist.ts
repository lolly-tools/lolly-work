/**
 * Shell-dist freshness check. The instance serves a built Lolly web shell
 * same-origin at `/` (instance.shellDir); a dist built BEFORE the org/
 * governance module lacks the session gate + locked-input UX, so serving it
 * under a non-open access mode silently un-governs every employee. Heuristic:
 * a fresh bundle references the org-config endpoint somewhere in assets/*.js
 * (same marker scan scripts/demo.ts uses to pick its access mode).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ShellDistCheck {
  /** The dist exists (index.html present under shellDir). */
  present: boolean;
  /** Some built assets/*.js carries the org-config marker - the governance UX shipped. */
  hasOrgConfig: boolean;
}

export function checkShellDist(shellDir: string): ShellDistCheck {
  if (!existsSync(join(shellDir, 'index.html'))) return { present: false, hasOrgConfig: false };
  const assetsDir = join(shellDir, 'assets');
  let hasOrgConfig = false;
  try {
    for (const name of readdirSync(assetsDir)) {
      if (!name.endsWith('.js') || hasOrgConfig) continue;
      try {
        const src = readFileSync(join(assetsDir, name), 'utf8');
        if (src.includes('org-config')) hasOrgConfig = true;
      } catch { /* unreadable chunk — skip */ }
    }
  } catch { /* no assets dir */ }
  return { present: true, hasOrgConfig };
}
