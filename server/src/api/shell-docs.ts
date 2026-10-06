// SPDX-License-Identifier: MPL-2.0
/** Public documentation paths within the immutable, signed web shell. */
export type ShellDocsPath =
  | { kind: 'invalid' }
  | { kind: 'file'; candidates: string[] }
  | { kind: 'redirect'; candidates: string[]; location: string };

/** null leaves an ordinary app or asset path to the existing shell handler. */
export function shellDocsPath(rel: string): ShellDocsPath | null {
  const path = rel.replace(/^\/+|\/+$/g, '');
  if (path === 'robots.txt') return { kind: 'file', candidates: ['robots-lolly-tools.txt'] };
  if (path === 'sitemap.xml') {
    return { kind: 'redirect', candidates: ['info/sitemap.xml'], location: '/info/sitemap.xml' };
  }
  const [root, ...parts] = path.split('/');
  if (root !== 'info' && root !== 'docs') return null;
  // Validate before filesystem normalization, including decoded URL separators.
  if (parts.some(part => !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(part))) return { kind: 'invalid' };
  if (!parts.length) return { kind: 'file', candidates: ['info/index.html'] };
  if (root === 'docs') {
    // The public shell's aliases cover flat, nested and localized article slugs.
    if (parts.length > 3 || parts.some(part => !/^[a-z0-9-]+$/.test(part))) return { kind: 'invalid' };
    return { kind: 'file', candidates: [`info/${parts.join('/')}.html`, `info/${parts.join('/')}/index.html`] };
  }
  const target = `info/${parts.join('/')}`;
  return { kind: 'file', candidates: /\.[a-z0-9]+$/i.test(target) ? [target] : [`${target}.html`, `${target}/index.html`] };
}
