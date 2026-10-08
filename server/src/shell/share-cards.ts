// SPDX-License-Identifier: MPL-2.0
/**
 * Share cards for an instance that serves its own Lolly shell (instance.shellDir).
 *
 * Link unfurlers (Slack, Teams, iMessage, LinkedIn) read a page's Open Graph tags
 * and never run its scripts. The app routes tools and views client-side, so the
 * shell's index.html can only carry one generic card. A Lolly web build therefore
 * also emits small landing stubs whose head carries one page's title, description
 * and card, and whose script hands a person on to the app route:
 *
 * - `t/<toolId>.html`, one per tool (lolly scripts/build-tool-og.ts);
 * - `view/<slug>.html`, one per top-level view (lolly scripts/build-view-og.ts);
 * - the docs pages under `info/`, each with its own card (lolly docs/build.ts).
 *
 * lolly.tools reaches them through rewrites in its vercel.json. `shellStubFor`
 * is the same table for this server's shell fallback, so `/t/<id>`, `/assets`
 * and `/docs/<slug>` answer their stub instead of the bare index.html; a test
 * checks it against a Lolly checkout's vercel.json when one is beside this
 * repository. A build made with LOLLY_SITE_URL set to this instance's origin
 * points the stubs' URLs here.
 *
 * The card images live under `/catalog/og/`. `publicCard` names the paths that
 * are cards, so the catalog route can answer them to a caller with no session.
 */

/** Clean top-level paths that lolly.tools rewrites onto a stub (vercel.json). */
export const SHELL_STUB_ALIASES: Readonly<Record<string, string>> = {
  design: 't/design.html',
  tools: 'view/tools.html',
  utilities: 'view/utilities.html',
  u: 'view/utilities.html',
  d: 'view/d.html',
  v: 'view/v.html',
  verify: 'view/v.html',
  valid: 'view/v.html',
  a: 'view/a.html',
  assets: 'view/a.html',
  c: 'view/a.html',
  p: 'view/p.html',
  start: 'view/start.html',
  lab: 'view/lab.html',
  batch: 'view/batch.html',
  pro: 'view/batch.html',
  unpack: 'view/unpack.html',
  pdf: 'view/unpack.html',
  profile: 'view/profile.html',
  docs: 'info/index.html',
};

const ID = '[a-z0-9-]+';
const DOOR = '(start|create|build|operate|trust)';
const LANG = '(ar|bg|bn|cs|de|es|fr|hi|id|it|ja|ko|ms|nl|no|pl|pt|ro|sv|tl|tr|uk|ur|vi|zh|zh-hant)';

/** The docs and tool rewrites with parameters, in vercel.json's order. */
const PATTERNS: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]> = [
  [new RegExp(`^t/(${ID})$`), (m) => `t/${m[1]}.html`],
  [new RegExp(`^docs/${DOOR}/(${ID})$`), (m) => `info/${m[1]}/${m[2]}.html`],
  [new RegExp(`^docs/${LANG}/${DOOR}/(${ID})$`), (m) => `info/${m[1]}/${m[2]}/${m[3]}.html`],
  [new RegExp(`^docs/(${ID})$`), (m) => `info/${m[1]}.html`],
  [new RegExp(`^docs/${LANG}/(${ID})$`), (m) => `info/${m[1]}/${m[2]}.html`],
];

/**
 * The shell file that answers an extensionless app path, or null for the plain
 * index.html. `clean` is the request path without its leading slash, already
 * normalised by the caller; `exists` says whether a file is in the shell build.
 * A stub the build did not emit (a tool added after the shell was built) falls
 * back to index.html, so a person still reaches the app.
 */
export function shellStubFor(clean: string, exists: (rel: string) => boolean): string | null {
  const path = clean.replace(/\/+$/, '');
  const alias = Object.hasOwn(SHELL_STUB_ALIASES, path) ? SHELL_STUB_ALIASES[path] : undefined;
  if (alias) return exists(alias) ? alias : null;
  for (const [re, to] of PATTERNS) {
    const m = path.match(re);
    if (m) {
      const target = to(m);
      return exists(target) ? target : null;
    }
  }
  return null;
}

export type PublicCard =
  | { kind: 'tool'; toolId: string; rel: string }
  | { kind: 'view'; rel: string };

/**
 * Whether a path under the catalog root is a share card: `og/<toolId>.<ext>` for a
 * tool, `og/views/<slug>.png` for a view. Raster only, as unfurlers require.
 * Classified case-insensitively and returned lower-cased, so another spelling on a
 * case-insensitive filesystem cannot reach a different file. Manifests such as
 * `og/.og-sigs.json` are not cards and stay behind the ordinary catalog rules.
 */
export function publicCard(rel: string): PublicCard | null {
  const lower = rel.toLowerCase();
  const view = lower.match(new RegExp(`^og/views/(${ID})\\.png$`));
  if (view) return { kind: 'view', rel: lower };
  const tool = lower.match(new RegExp(`^og/(${ID})\\.(png|jpe?g|webp)$`));
  if (tool) return { kind: 'tool', toolId: tool[1] as string, rel: lower };
  return null;
}
