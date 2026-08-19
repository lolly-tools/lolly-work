/**
 * Provider onboarding-doc contract (plans/28 §3). Turns docs/providers/<kind>.md
 * into a checked contract so a driver change can't silently outrun its guide:
 *   - every shipped kind (except mock) has a guide with the skeleton headings;
 *   - each guide's instance.json example parses through parseConfig;
 *   - its options keys stay within the driver's option set;
 *   - the OAuth credential shape the guides document is the one the code accepts;
 *   - a guide only claims publish-out for a kind whose driver supports it;
 *   - every DAM kind is covered on both documentation axes (plans/32 §7);
 *   - every `lw …` command the docs instruct exists in the CLI (plans/33 §7 task 2);
 *   - every driver hardened for tenant day has its live-verify runbook;
 *   - parseConfig rejects the documented failure modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_KINDS, type ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createProvider } from '../server/src/catalog/providers/registry.ts';
import { parseOAuthCredential } from '../server/src/catalog/providers/oauth.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_ROOT = join(REPO, 'docs');
const DOCS = join(DOCS_ROOT, 'providers');
const DRIVERS = join(REPO, 'server', 'src', 'catalog', 'providers');
const PLAYBOOK = join(DOCS_ROOT, 'offboarding.md');
const CLI_SRC = readFileSync(join(REPO, 'cli', 'lw.ts'), 'utf8');
const KINDS = PROVIDER_KINDS.filter((k) => k !== 'mock');
const OAUTH_KINDS = ['dropbox', 'gdrive', 'o365', 'optimizely-cmp', 'imagerelay', 'canto'] as const;

// The DAM kinds carry a second documentation axis (plans/32 §6): besides the
// connector guide every kind gets, each of these needs an off-boarding story -
// which driver to exit through, what governance survives the move, and whether
// leaving is on offer at all. The storage/design sources (s3, git, webdav,
// dropbox, gdrive, o365, penpot) deliberately have no second axis: nothing
// federates out of them that the org does not already hold, so there is no exit
// to document. `webdav` sits with those: it is a protocol against a server the
// org runs itself (a Nextcloud, an Apache mod_dav mount), so there is no vendor
// contract to leave - it is far more often where an exit LANDS than where one
// starts.
const DAM_KINDS = ['brandfolder', 'imagerelay', 'canto', 'acquia-dam', 'intelligencebank', 'optimizely-cmp'] as const;

const REQUIRED_HEADINGS = ['## What you need', '## Credential shape', '## instance.json', '## Verify', '## Notes / limits'];

// Kept in sync with each driver's *Options interface - a guide documenting an
// option the driver doesn't have (or vice versa) fails here.
const OPTION_ALLOWLIST: Record<string, string[]> = {
  brandfolder: ['brandfolderId', 'baseUrl'],
  webdav: ['baseUrl', 'flavor', 'username', 'root', 'recursive', 'minGapMs'],
  s3: ['bucket', 'region', 'endpoint', 'prefix'],
  git: ['rawBase', 'manifestPath', 'authHeader'],
  dropbox: ['path'],
  gdrive: ['folderId'],
  o365: ['driveId', 'tenant', 'itemPath'],
  'optimizely-cmp': ['baseUrl', 'tokenUrl', 'publish'],
  imagerelay: ['baseUrl', 'tokenUrl', 'folderId', 'recursive'],
  canto: ['tenant', 'domain', 'baseUrl', 'tokenUrl', 'albumId', 'approvedStates', 'minGapMs'],
  'acquia-dam': ['baseUrl', 'query', 'approvedStatuses'],
  intelligencebank: ['platformUrl', 'folderId', 'approvedStates'],
  penpot: ['baseUrl', 'teamId', 'projectId', 'fileIds', 'format', 'scale', 'exporterUrl'],
};

// Minimal construct-valid options per kind (git parses rawBase at construction).
const MIN_OPTIONS: Record<string, Record<string, unknown>> = {
  brandfolder: { brandfolderId: 'x' }, s3: { bucket: 'b' }, git: { rawBase: 'https://raw.example/o/r/main' },
  webdav: { baseUrl: 'https://cloud.example' },
  dropbox: {}, gdrive: { folderId: 'f' }, o365: { driveId: 'd' }, 'optimizely-cmp': { publish: true },
  imagerelay: {}, canto: { tenant: 'acme' }, 'acquia-dam': {}, intelligencebank: {}, penpot: { baseUrl: 'https://design.example' },
};

const guide = (kind: string): string => readFileSync(join(DOCS, `${kind}.md`), 'utf8');

/** The provider-entry example: the first ```json block AFTER the "## instance.json"
 *  heading (so an earlier ```json - e.g. s3's IAM policy - is never picked). */
function exampleEntry(md: string): Record<string, unknown> {
  const at = md.indexOf('## instance.json');
  assert.ok(at >= 0, 'guide has an instance.json section');
  const m = /```json\s*([\s\S]*?)```/.exec(md.slice(at));
  assert.ok(m?.[1], 'instance.json section has a ```json example');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

/** One '## <name>' section of a guide: the heading through the next '## ' (or EOF). */
function section(md: string, heading: string): string {
  const at = md.indexOf(heading);
  assert.ok(at >= 0, `guide missing heading "${heading}"`);
  const rest = md.slice(at + heading.length);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

// --- the doc-to-CLI contract (plans/33 §7 task 2) -------------------------
// Three shipped commands turned out not to exist while the suite was green,
// because it checked that a `## Verify` section EXISTS, not that the commands
// inside it DO. What follows scans every section of every page - fenced blocks
// and inline prose alike, since two of those three were in a credential section
// and in a sentence - and resolves each command against cli/lw.ts itself.

/** A token standing in for something the operator supplies rather than types:
 *  `<id>`, `[list]`, or an elision. Anything with no lowercase letter in it is
 *  a placeholder, not a verb. */
const isPlaceholder = (t: string): boolean => /^[<[]/.test(t) || !/[a-z]/.test(t);

/** Every `lw …` command a doc page instructs, with the line it sits on. Both
 *  contexts count: lines inside a fenced block, and inline `code` spans in
 *  prose. A shell comment can carry a second command ("… # or: lw login …"). */
function lwCommands(md: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  let fenced = false;
  md.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (raw.trimStart().startsWith('```')) { fenced = !fenced; return; }
    if (fenced) {
      const [body, ...note] = raw.split('#');
      const cmd = body!.trim().replace(/^\$\s+/, '');
      if (/^lw(\s|$)/.test(cmd)) found.push({ line, text: cmd });
      const inNote = /\blw\s.*$/.exec(note.join('#'));
      if (inNote) found.push({ line, text: inNote[0].trim() });
      return;
    }
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
      const cmd = m[1]!.trim();
      if (/^lw(\s|$)/.test(cmd)) found.push({ line, text: cmd });
    }
  });
  return found;
}

/** `lw <verb> <sub>` as the docs write it, placeholders and flags dropped. A
 *  reference line may write alternatives as `enable|disable`, so a slot is a
 *  LIST: every branch has to exist, which is stricter than picking one. */
function verbPath(text: string): { verb: string[]; sub: string[]; arg: string[] } {
  const tok = text.split(/\s+/).filter((t) => t.length > 0);
  const at = (i: number): string[] => {
    const t = tok[i];
    return t === undefined || t.startsWith('-') || isPlaceholder(t) ? [] : t.split('|');
  };
  return { verb: at(1), sub: at(2), arg: at(3) };
}

/** The command surface cli/lw.ts actually implements, read off its own switch
 *  statements so this stays true as the CLI grows: the top-level `switch (cmd)`
 *  labels, the nested `switch (sub)` labels under `providers`, and the usage
 *  line that names them to an operator who gets it wrong. */
function cliCommands(src: string): { top: Set<string>; providers: Set<string>; usage: string[] } {
  const topAt = src.indexOf('switch (cmd) {');
  const provAt = src.indexOf("case 'providers': {");
  const subAt = src.indexOf('switch (sub) {', provAt);
  const usageAt = src.indexOf('usage: lw providers [', subAt);
  assert.ok(topAt > 0 && provAt > topAt && subAt > provAt && usageAt > subAt, 'cli/lw.ts still has the two-level command switch');
  const labels = (slice: string, indent: number): Set<string> =>
    new Set([...slice.matchAll(new RegExp(`\\n {${indent}}case '([a-z0-9-]+)':`, 'g'))].map((m) => m[1]!));
  const usage = /usage: lw providers \[([a-z0-9|-]+)\]/.exec(src.slice(usageAt));
  assert.ok(usage?.[1], 'cli/lw.ts providers usage line lists its verbs');
  return { top: labels(src.slice(topAt), 2), providers: labels(src.slice(subAt, usageAt), 6), usage: usage[1].split('|') };
}

/** The kinds `lw providers auth` can drive end to end, read off `oauthFlowFor`.
 *  Every other OAuth kind is live-verify-pending and must not be sent there. */
function oauthFlowKinds(src: string): string[] {
  const at = src.indexOf('function oauthFlowFor(');
  const end = src.indexOf('\n  return null;', at);
  assert.ok(at > 0 && end > at, 'cli/lw.ts still has oauthFlowFor with its null tail');
  return [...src.slice(at, end).matchAll(/kind === '([a-z0-9-]+)'/g)].map((m) => m[1]!);
}

/** Guides plus the live-verify runbooks: every page that carries a kind. */
const kindPages = (): Array<{ kind: string; file: string }> => [
  ...KINDS.map((kind) => ({ kind, file: `${kind}.md` })),
  ...readdirSync(DOCS).filter((f) => f.endsWith('-live-verify.md'))
    .map((file) => ({ kind: file.slice(0, -'-live-verify.md'.length), file })),
];

/** EVERY published page, not only the provider ones: the same class of bug hides
 *  in the walkthroughs (catalog.md ran `lw providers auth` against a bearer-key
 *  kind), and an operator does not know which directory a command came from. */
function allDocPages(dir = DOCS_ROOT, prefix = ''): Array<{ file: string; path: string }> {
  const out: Array<{ file: string; path: string }> = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) out.push(...allDocPages(join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.name.endsWith('.md')) out.push({ file: `${prefix}${e.name}`, path: join(dir, e.name) });
  }
  return out;
}

/** Which kind each provider id in a page belongs to, learned from the page's own
 *  `lw providers add <id> --kind <kind>` lines. That is how a walkthrough on a
 *  page carrying no kind of its own (catalog.md, offboarding.md) still gets its
 *  kind-specific commands checked. */
function kindsById(md: string): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of md.matchAll(/lw providers add ([a-z0-9][a-z0-9-]*)[^\n]*--kind ([a-z0-9-]+)/g)) {
    byId.set(m[1]!, m[2]!);
  }
  return byId;
}

const baseCfg = (extra: Record<string, unknown>): string =>
  JSON.stringify({ instance: { name: 'T', baseUrl: 'http://localhost', pack: '/tmp/pack' }, dev: { enabled: true }, ...extra });

test('every shipped kind has a guide with the required skeleton headings', () => {
  for (const kind of KINDS) {
    const md = guide(kind);
    for (const h of REQUIRED_HEADINGS) assert.ok(md.includes(h), `${kind}.md missing heading "${h}"`);
    assert.ok(md.includes(`kind: \`${kind}\``), `${kind}.md names its kind`);
  }
});

test("each guide's instance.json example parses and its options match the driver", () => {
  for (const kind of KINDS) {
    const entry = exampleEntry(guide(kind));
    assert.equal(entry.kind, kind, `${kind}.md example is the right kind`);
    // Round-trips through the real config validator.
    const cfg = parseConfig(baseCfg({ catalogProviders: [entry] }));
    assert.equal(cfg.catalogProviders[0]?.kind, kind);
    // Options stay within the driver's set.
    const opts = Object.keys((entry.options as Record<string, unknown>) ?? {});
    for (const k of opts) assert.ok(OPTION_ALLOWLIST[kind]!.includes(k), `${kind}.md documents unknown option "${k}"`);
  }
});

test('the documented OAuth credential shape is exactly what the code accepts', () => {
  // Valid: clientId + refreshToken (clientSecret optional) - the shape every OAuth guide shows.
  const cred = parseOAuthCredential(JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }));
  assert.equal(cred.clientId, 'c');
  assert.equal(cred.refreshToken, 'r');
  parseOAuthCredential(JSON.stringify({ clientId: 'c', refreshToken: 'r' })); // public/PKCE app: no secret
  // Malformed shapes the guides never show are refused.
  assert.throws(() => parseOAuthCredential('not json'));
  assert.throws(() => parseOAuthCredential(JSON.stringify({ clientId: 'c' })), /refreshToken/i);
  assert.throws(() => parseOAuthCredential(undefined));
  for (const kind of OAUTH_KINDS) assert.ok(guide(kind).includes('"refreshToken"'), `${kind}.md shows the OAuth blob`);
});

test('publish-out is claimed only where the driver supports it', () => {
  for (const kind of KINDS) {
    const rec = { id: 't', kind, options: MIN_OPTIONS[kind] } as unknown as ProviderRecord;
    const driver = createProvider(rec, undefined);
    const canPublish = driver.capabilities.publish === true;
    assert.equal(canPublish, kind === 'optimizely-cmp', `${kind} publish capability`);
    // Only the kind that can publish documents a "Publishing" section.
    assert.equal(guide(kind).includes('## Publishing'), canPublish, `${kind}.md publish section matches capability`);
  }
});

test('every DAM kind is documented on both axes - guide and off-boarding', () => {
  assert.ok(existsSync(PLAYBOOK), 'docs/offboarding.md exists');
  const playbook = readFileSync(PLAYBOOK, 'utf8');
  for (const kind of DAM_KINDS) {
    assert.ok(guide(kind).includes('## Off-boarding'), `${kind}.md missing heading "## Off-boarding"`);
    // A new DAM kind can't slip in without a row in the central playbook.
    assert.ok(playbook.includes(`\`${kind}\``), `offboarding.md never names \`${kind}\``);
  }
});

test('every `lw …` command the docs instruct exists in cli/lw.ts', () => {
  const { top, providers, usage } = cliCommands(CLI_SRC);
  assert.ok(top.has('providers'), 'parsed the top-level verbs');
  assert.ok(providers.has('list'), 'parsed the providers sub-verbs');
  // The usage line is what an operator sees after a typo, so a verb missing
  // from it is the same bug from the other side (`preview` was, for nine guides).
  assert.deepEqual([...usage].sort(), [...providers].sort(), 'the providers usage line lists exactly the sub-verbs the switch handles');
  const pages = allDocPages();
  assert.ok(pages.length > KINDS.length, 'walked the whole docs tree, not just the provider guides');
  for (const { file, path } of pages) {
    for (const { line, text } of lwCommands(readFileSync(path, 'utf8'))) {
      const { verb, sub } = verbPath(text);
      for (const v of verb) {
        assert.ok(top.has(v), `docs/${file}:${line} documents "lw ${v}", which no case in cli/lw.ts handles - it falls through to the usage text: ${text}`);
      }
      if (!verb.includes('providers')) continue;
      for (const s of sub) {
        assert.ok(providers.has(s), `docs/${file}:${line} documents "lw providers ${s}", which the providers switch in cli/lw.ts does not handle - it falls through to the usage text: ${text}`);
      }
    }
  }
});

test('no page instructs `lw providers auth` for a kind the CLI cannot drive', () => {
  const flowKinds = oauthFlowKinds(CLI_SRC);
  assert.ok(flowKinds.length > 0, 'oauthFlowFor registers at least one kind');
  // The CLI's own operator-facing list must name the same set, or its refusal
  // sends people to a kind that dead-ends just as the guides used to.
  const declared = /const OAUTH_FLOW_KINDS = \[([^\]]+)\]/.exec(CLI_SRC);
  assert.ok(declared?.[1], 'cli/lw.ts declares OAUTH_FLOW_KINDS');
  assert.deepEqual([...declared[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]), flowKinds, 'OAUTH_FLOW_KINDS matches oauthFlowFor');
  // A page's kind comes from its filename where it has one, and otherwise from
  // the `--kind` on the same page's own `lw providers add` line - which is what
  // catches a walkthrough like catalog.md running `auth` against a bearer key.
  const byFile = new Map(kindPages().map((p) => [p.file, p.kind]));
  for (const { file, path } of allDocPages()) {
    const md = readFileSync(path, 'utf8');
    const declaredKinds = kindsById(md);
    const pageKind = byFile.get(file.startsWith('providers/') ? file.slice('providers/'.length) : file);
    for (const { line, text } of lwCommands(md)) {
      const { verb, sub, arg } = verbPath(text);
      // A bare `lw providers auth` is a reference (the guides for the pending
      // kinds name it to say the kind is NOT one of them); an occurrence with
      // an id after it is an instruction, and must be one that works.
      if (!verb.includes('providers') || !sub.includes('auth') || !arg[0]) continue;
      const kind = declaredKinds.get(arg[0]) ?? pageKind;
      if (!kind) continue; // no kind is knowable from the page: nothing to check against
      assert.ok(flowKinds.includes(kind), `docs/${file}:${line} instructs "lw providers auth" but no consent flow is registered for kind ${kind} (oauthFlowFor handles ${flowKinds.join(', ')}) - it exits with a refusal. Capture the sealed blob with "lw providers credential <id>" instead: ${text}`);
    }
  }
});

test('no guide sends a pending OAuth kind to the consent-flow section, and no anchor is dead', () => {
  // The dead end task 1b closed had a second half: the guides for the pending
  // kinds still LINKED the section whose only instruction is `lw providers auth`.
  // A cross-link frames the whole credential story, so it is checked like the
  // command it points at.
  const flowKinds = oauthFlowKinds(CLI_SRC);
  const readme = readFileSync(join(DOCS, 'README.md'), 'utf8');
  const CONSENT = 'README.md#kinds-with-a-registered-consent-flow';
  const PENDING = 'README.md#kinds-whose-consent-flow-is-not-registered';
  assert.ok(readme.includes('### Kinds with a registered consent flow'), 'the consent-flow section exists');
  assert.ok(readme.includes('### Kinds whose consent flow is not registered'), 'and the section for the kinds without one');

  for (const { kind, file } of kindPages()) {
    const path = join(DOCS, file);
    if (!existsSync(path)) continue;
    const md = readFileSync(path, 'utf8');
    if (md.includes(CONSENT)) {
      assert.ok(flowKinds.includes(kind), `providers/${file} links the consent-flow section, but no flow is registered for kind ${kind} - that section's only instruction is \`lw providers auth\`, which refuses here. Link ${PENDING} instead.`);
    }
    if (md.includes(PENDING)) {
      assert.ok(!flowKinds.includes(kind), `providers/${file} is a kind with a registered consent flow but links the section for the kinds without one`);
    }
  }

  // Every anchor into that README must land on a heading it actually has - a
  // renamed section otherwise scrolls the reader to the top of the page.
  const slugs = new Set([...readme.matchAll(/^#{2,4} (.+)$/gm)]
    .map((m) => (m[1] as string).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-')));
  for (const { file, path } of allDocPages()) {
    if (!file.startsWith('providers/')) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/README\.md#([a-z0-9-]+)/g)) {
      assert.ok(slugs.has(m[1] as string), `docs/${file} links providers/README.md#${m[1]}, which is not a heading there`);
    }
  }
});

test('every driver hardened for tenant day has its live-verify runbook', () => {
  // plans/33 hardens the live-verify-pending DAM drivers: each grows a
  // `sampleShape` report and errors that print "See docs/providers/<kind>-live-
  // verify.md". Those pointers must land on a page that exists - they are read
  // on the worst day. Drivers carrying live-verify debt with no tenant-day pass
  // scheduled (penpot, optimizely-cmp) promise no page, and this asserts they
  // promise none, so a new promise cannot land without its runbook.
  const playbook = readFileSync(PLAYBOOK, 'utf8');
  const promised: string[] = [];
  for (const f of readdirSync(DRIVERS).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(DRIVERS, f), 'utf8');
    const header = src.slice(0, src.indexOf('*/') + 2);
    if (!header.startsWith('/**') || !header.includes('LIVE-VERIFY')) {
      assert.ok(!/async sampleShape\(/.test(src), `${f} implements sampleShape but its header block declares no LIVE-VERIFY debt`);
      continue;
    }
    const kind = f.slice(0, -3);
    const page = `${kind}-live-verify.md`;
    if (!/async sampleShape\(/.test(src)) {
      assert.ok(!header.includes(page), `${f} header points at ${page} but the driver has no sampleShape - either harden it or drop the pointer`);
      continue;
    }
    promised.push(page);
    assert.ok(existsSync(join(DOCS, page)), `${f} carries LIVE-VERIFY debt and a shape report, so docs/providers/${page} must exist - its errors send the operator there`);
    assert.ok(header.includes(page), `${f} header must name docs/providers/${page}`);
    assert.ok(guide(kind).includes(`(${page})`), `${kind}.md does not link its live-verify runbook ${page}`);
    assert.ok(playbook.includes(`providers/${page}`), `offboarding.md does not link providers/${page}`);
  }
  assert.ok(promised.length >= 4, `expected the plans/33 DAM drivers to promise runbooks, got ${promised.length}`);
  for (const f of readdirSync(DOCS).filter((n) => n.endsWith('-live-verify.md'))) {
    assert.ok(promised.includes(f), `docs/providers/${f} belongs to no driver that promises it - a renamed page leaves the driver's own error pointing nowhere`);
  }
});

test('the optimizely-cmp guide keeps saying it is not an exit target', () => {
  // The one wording this suite pins: CMP stays (plans/32 §6), and the stance is
  // easy to soften by accident when the section gets reworded.
  const off = section(guide('optimizely-cmp'), '## Off-boarding').toLowerCase();
  assert.ok(off.includes('not an exit target'), 'optimizely-cmp.md Off-boarding says "not an exit target"');
});

test('parseConfig rejects the failure modes the guides warn about', () => {
  assert.throws(() => parseConfig(baseCfg({ catalogProviders: [{ id: 'x', kind: 'bogus', label: 'l' }] })), /unknown catalog provider kind/);
  assert.throws(() => parseConfig(baseCfg({ catalogProviders: [{ id: 'x', kind: 's3' }] })), /needs a label/);
  assert.throws(() => parseConfig(baseCfg({ blobs: { driver: 'floppy' } })), /blobs\.driver/);
  assert.throws(() => parseConfig(baseCfg({ blobs: { driver: 's3' } })), /requires blobs\.s3\.bucket/);
});
