// SPDX-License-Identifier: MPL-2.0
/**
 * Record what the Lolly shell's own SVG sanitiser makes of each company logo
 * fixture (plans/82 M3), so tests/company-logo-checks.test.ts can hold Work's
 * server sanitiser to the same answers.
 *
 *   node scripts/build-company-logo-fixtures.ts [--lolly <lolly checkout>]
 *
 * The default checkout is vendor/lolly (the shell submodule). The shell's
 * sanitiser needs a DOM, so this runs it over jsdom with the same globals a
 * browser gives it. Run it again after the shell's sanitiser changes, then
 * commit tests/fixtures/company-logos/lolly-sanitised.json.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJsdom } from '../server/src/render/contract.ts';

const root = resolve(new URL('..', import.meta.url).pathname);
const { values } = parseArgs({ options: { lolly: { type: 'string' } } });
const lolly = resolve(values.lolly ?? join(root, 'vendor', 'lolly'));
const dir = join(root, 'tests', 'fixtures', 'company-logos');

const { JSDOM } = await loadJsdom();
const { window } = new JSDOM('<!doctype html><html><body></body></html>') as unknown as { window: Record<string, unknown> };
const g = globalThis as Record<string, unknown>;
for (const name of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'NodeFilter', 'HTMLTemplateElement', 'NamedNodeMap', 'HTMLFormElement', 'Text', 'Comment']) {
  g[name] = name === 'window' ? window : window[name];
}

const { sanitizeSvgToString } = await import(pathToFileURL(join(lolly, 'shells', 'web', 'src', 'bridge', 'svg-sanitize.ts')).href) as { sanitizeSvgToString(markup: string): Promise<string> };
const purifyVersion = (JSON.parse(readFileSync(join(lolly, 'node_modules', 'dompurify', 'package.json'), 'utf8')) as { version: string }).version;

const out: Record<string, string | { throws: string }> = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
  const markup = readFileSync(join(dir, file), 'utf8');
  try { out[file] = await sanitizeSvgToString(markup); } catch (err) { out[file] = { throws: (err as Error).message }; }
}
writeFileSync(join(dir, 'lolly-sanitised.json'), `${JSON.stringify({ source: 'shells/web/src/bridge/svg-sanitize.ts', dompurify: purifyVersion, cases: out }, null, 2)}\n`);
console.log(`recorded ${Object.keys(out).length} fixture(s) with DOMPurify ${purifyVersion}`);
