// SPDX-License-Identifier: MPL-2.0
/** Load the actual HTML entry and its native ES module graph in an isolated DOM. */
import assert from 'node:assert/strict';
import vm, { type Context, type SourceTextModule } from 'node:vm';

export async function loadConsoleModuleGraph(options: {
  html: string; base: string; context: Context;
  read: (url: string) => Promise<string>;
}): Promise<SourceTextModule> {
  const entries = [...options.html.matchAll(/<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  assert.equal(entries.length, 1, 'shipped HTML must select exactly one admin module entry');
  const entryUrl = new URL(entries[0]![1]!, options.base).href;
  const origin = new URL(options.base).origin;
  const modules = new Map<string, Promise<SourceTextModule>>();
  const load = (url: string): Promise<SourceTextModule> => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin, 'console modules must stay on their own origin');
    assert.ok(parsed.pathname.startsWith('/admin/'), 'console modules must stay under /admin/');
    let promise = modules.get(url);
    if (!promise) {
      promise = options.read(url).then(source => {
        if (url === entryUrl) {
          // Keep all real imports and function bodies. Boot owns browser routing;
          // these fixture exports let the probe choose its isolated signed-in role.
          assert.match(source, /\nboot\(\);\s*$/, 'shipped console entry must retain its boot call');
          source = source.replace(/\nboot\(\);\s*$/, '\nexport { consoleNavigation, renderProjectDetail, actSessionObj, actToolObj, actProjectObj };\nexport const setReleaseSession = value => { session = value; };\n');
        }
        return new vm.SourceTextModule(source, { context: options.context, identifier: url });
      });
      modules.set(url, promise);
    }
    return promise;
  };
  const entry = await load(entryUrl);
  await entry.link((specifier, referencingModule) => load(new URL(specifier, referencingModule.identifier).href));
  await entry.evaluate({ timeout: 5000 });
  return entry;
}
