/**
 * X-Lolly-Client parsing (plans/10 §1).
 *
 * Grammar (space-separated tokens; first token is the shell):
 *   <shell>[/<version>] [engine/<version>] [platform/<name>] [<k>/<v>]...
 * Examples the OSS shells send today / will send:
 *   "web engine/1.61.0"
 *   "tauri engine/1.61.0"
 *   "web/2.4.0 engine/1.61.0 platform/macos pwa/standalone"
 * Parsing is tolerant: unknown tokens land in `extra`, garbage returns null.
 */

export interface ClientInfo {
  shell: string;
  shellVersion?: string;
  engine?: string;
  platform?: string;
  extra?: Record<string, string>;
}

const TOKEN = /^[a-z0-9-]+(\/[A-Za-z0-9._-]+)?$/;

export function parseClientHeader(value: string | undefined): ClientInfo | null {
  if (!value) return null;
  const tokens = value.trim().split(/\s+/).slice(0, 8);
  const first = tokens[0];
  if (!first || !TOKEN.test(first)) return null;
  const [shell, shellVersion] = first.split('/') as [string, string?];
  const info: ClientInfo = { shell };
  if (shellVersion) info.shellVersion = shellVersion;
  for (const tok of tokens.slice(1)) {
    if (!TOKEN.test(tok)) continue;
    const slash = tok.indexOf('/');
    if (slash < 0) continue;
    const key = tok.slice(0, slash);
    const val = tok.slice(slash + 1);
    if (key === 'engine') info.engine = val;
    else if (key === 'platform') info.platform = val;
    else (info.extra ??= {})[key] = val;
  }
  return info;
}

/** Stable key for the fleet registry row (per install identity comes later; this buckets). */
export function clientBucket(info: ClientInfo): string {
  return [info.shell, info.shellVersion ?? '-', info.engine ?? '-', info.platform ?? '-'].join('|');
}
