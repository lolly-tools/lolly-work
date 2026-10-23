// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');

/** A fetch that answers the docs index and pages the way GET /api/v1/docs does. */
function docsFetch(index: unknown, pages: Record<string, string>) {
  return async (url: string) => {
    if (url === '/api/v1/docs') return { ok: true, status: 200, json: async () => index, text: async () => '' };
    const slug = /^\/api\/v1\/docs\/([a-z0-9-]+)$/.exec(url)?.[1];
    if (slug && Object.hasOwn(pages, slug)) return { ok: true, status: 200, json: async () => null, text: async () => pages[slug] };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => null, text: async () => '' };
  };
}

function page() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.eval(`${source}\nwindow.helpers = { consoleNavigation, sectionTabs, mdToNodes, viewDocs, docAnchorNode, docSlugAliases: DOC_SLUG_ALIASES, el, setSession: s => { session = s; } };`);
  return { dom, w, helpers: w.helpers };
}

test('task navigation and its mobile picker expose only permitted sections; search finds direct provider access', async () => {
  const p = page();
  try {
    const views = Object.fromEntries(['overview', 'projects', 'users', 'contractors', 'catalog', 'providers', 'tools', 'injectables', 'approvals', 'chains', 'grants', 'tokens', 'activity', 'rooms', 'links', 'messages', 'audit', 'fleet', 'instance', 'setup', 'preview', 'docs'].map(id => [id, ['users', 'providers'].includes(id)]));
    p.helpers.setSession({ console: { views, actions: [] } });
    const nav = p.helpers.consoleNavigation('users'); p.w.document.body.append(nav);
    assert.deepEqual([...nav.querySelectorAll('a')].map((a: any) => a.textContent), ['People', 'Providers']);
    assert.deepEqual([...nav.querySelectorAll('option')].map((o: any) => o.value), ['users', 'providers']);
    assert.equal(nav.querySelector('[aria-current=page]').textContent, 'People');
    const search = nav.querySelector('input');
    search.value = 'assets'; search.dispatchEvent(new p.w.Event('input'));
    assert.equal(nav.querySelector('a[href="#/users"]').hidden, true);
    assert.equal(nav.querySelector('a[href="#/providers"]').hidden, false, 'a task-group name also matches its sections');
    const navigated = new Promise<void>(resolve => {
      p.w.addEventListener('hashchange', () => resolve(), { once: true });
    });
    search.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
    await navigated;
    assert.equal(p.w.location.hash, '#/providers');
    search.value = 'no such section'; search.dispatchEvent(new p.w.Event('input'));
    assert.equal(nav.querySelector('.nav-empty').hidden, false);
    search.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(search.value, '');
    assert.equal(nav.querySelector('.nav-empty').hidden, true);
    assert.equal(nav.querySelector('a[href="#/users"]').hidden, false);
  } finally { p.dom.window.close(); }
});

test('task panels keep edited controls and selection; keyboard activation and counts remain accessible', () => {
  const p = page();
  try {
    const input = p.helpers.el('input', { value: 'Unsaved draft' });
    const check = p.helpers.el('input', { type: 'checkbox', checked: 'checked' });
    const tabs = p.helpers.sectionTabs('Accounts', [
      { id: 'directory', label: 'Directory', content: input },
      { id: 'requests', label: 'Requests', content: check, count: 2 },
    ]);
    p.w.document.body.append(tabs.element);
    const buttons = [...tabs.element.querySelectorAll('[role=tab]')] as any[];
    input.value = 'Changed draft';
    buttons[0].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    assert.equal(p.w.document.activeElement, buttons[1]);
    assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabs.element.querySelector('#accounts-directory').hidden, true);
    assert.equal(check.checked, true);
    tabs.setCount('requests', 1); assert.equal(buttons[1].textContent, 'Requests 1');
    tabs.setCount('requests', 0); assert.equal(buttons[1].querySelector('.tab-count').hidden, true);
    buttons[1].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
    assert.equal(p.w.document.activeElement, buttons[0]);
    assert.equal(input.value, 'Changed draft');
    assert.equal(buttons[0].getAttribute('aria-controls'), 'accounts-directory');
    assert.equal(tabs.element.querySelector('#accounts-directory').getAttribute('aria-labelledby'), buttons[0].id);
  } finally { p.dom.window.close(); }
});


test('packaged docs retain legacy section anchors without rendering arbitrary HTML', async () => {
  const p = page();
  try {
    const markdown = '# Install\n\n<a id="before-you-expose-it"></a>\n\n## Before exposing the server\n\nConfigure identity.\n\n<a id="unsafe" onclick="window.bad=1"></a>';
    p.w.fetch = async () => ({ ok: true, status: 200,
      json: async () => ({ sections: [{ id: 'operate', title: 'Deploy & operate', docs: [{ slug: 'install', title: 'Install' }] }] }),
      text: async () => markdown,
    });
    const main = p.w.document.getElementById('app');
    await p.helpers.viewDocs(main, new URLSearchParams({ doc: 'install', anchor: 'before-you-expose-it' }));
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, 'Before exposing the server');
    assert.ok(main.querySelector('#before-you-expose-it'));
    assert.ok(!main.querySelector('a[onclick]'));
    assert.ok(!main.querySelector('#unsafe'));
    assert.ok(!main.textContent.includes('<a id="before-you-expose-it">'));
  } finally { p.dom.window.close(); }
});

test('a retired docs slug opens the page that took it over, at its section', async () => {
  const p = page();
  try {
    const docs = [
      { slug: 'install', title: 'Install', path: 'install.md' },
      { slug: 'past-releases', title: 'Past releases', path: 'past-releases.md' },
      { slug: 'provider-tenant-check', title: 'Check a source on your own tenant', path: 'providers/tenant-check.md' },
    ];
    const pages: Record<string, string> = {
      install: '# Install\n\nStart here.\n',
      'past-releases': '# Past releases\n\n## 1.1.1\n\nChanges.\n\n### 1.1.1 migrations\n\nNone.\n\n## 1.1.0\n\nOlder.\n',
      'provider-tenant-check': '# Check a source\n\n## What to check for each source\n\n**WebDAV / Nextcloud**\n\n- Use a folder.\n\n**Canto**\n\n- Confirm API access.\n',
    };
    p.w.fetch = docsFetch({ sections: [{ id: 'operate', title: 'Deploy', docs }] }, pages);
    const main = p.w.document.getElementById('app');
    const open = (query: Record<string, string>) => p.helpers.viewDocs(main, new URLSearchParams(query));

    await open({ doc: 'release-1-1-1' });
    assert.equal(main.querySelector('h1').textContent, 'Past releases');
    assert.equal(main.querySelector('.docs-link.is-current').textContent, 'Past releases');
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, '1.1.1');
    assert.equal(p.w.location.hash, '#/docs?doc=past-releases&anchor=111', 'the address names the new page');

    await open({ doc: 'release-1-1-1', anchor: '111-migrations' });
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, '1.1.1 migrations', 'a section the old link named is kept');

    // A runbook's old slug opens its row of the tenant check, a title the bundle lowered to bold.
    await open({ doc: 'provider-canto-live-verify' });
    assert.equal(main.querySelector('h1').textContent, 'Check a source on your own tenant');
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, 'Canto');
    await open({ doc: 'provider-webdav-live-verify' });
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, 'WebDAV / Nextcloud');

    // Unknown slugs, prototype keys and an alias whose page this bundle lacks fall back to the first page.
    for (const doc of ['no-such-page', 'constructor', '__proto__', 'frontend-updates']) {
      await open({ doc });
      assert.equal(main.querySelector('h1').textContent, 'Install', doc);
    }

    // A slug the manifest still lists is served as itself.
    docs.push({ slug: 'release-1-1-1', title: 'Release 1.1.1', path: 'release-1-1-1.md' });
    pages['release-1-1-1'] = '# Release 1.1.1\n\nStill shipped.\n';
    await open({ doc: 'release-1-1-1' });
    assert.equal(main.querySelector('h1').textContent, 'Release 1.1.1');
  } finally { p.dom.window.close(); }
});

test('the console renders every page of the shipped docs bundle and lands every link into it', async () => {
  const p = page();
  try {
    const DOCS = new URL('../docs/', import.meta.url);
    const index = JSON.parse(readFileSync(new URL('docs.json', DOCS), 'utf8'));
    const docs = index.sections.flatMap((s: { docs: Array<{ slug: string; title: string; path: string }> }) => s.docs);
    const pages: Record<string, string> = Object.fromEntries(docs.map((d: { slug: string; path: string }) => [d.slug, readFileSync(new URL(d.path, DOCS), 'utf8')]));
    p.w.fetch = docsFetch(index, pages);
    const main = p.w.document.getElementById('app');
    const rendered = new Map<string, any>();
    const links: Array<{ from: string; doc: string; anchor: string }> = [];
    for (const d of docs) {
      // The console renders a small Markdown subset: the bundle generator lowers
      // fences, figures, pills, comments and version tokens before they get here.
      let fenced = false;
      for (const [i, line] of pages[d.slug]!.split('\n').entries()) {
        if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
        if (fenced) continue;
        assert.ok(!/^\s*:::/.test(line) && !line.includes('<!--') && !line.includes('%work{'), `${d.path}:${i + 1} reaches the console unlowered: ${line}`);
        assert.ok(!/^\s*<[a-z!/]/i.test(line) || /^\s*<a id="[a-z0-9][a-z0-9-]*"><\/a>\s*$/.test(line), `${d.path}:${i + 1} is raw HTML the console prints as text: ${line}`);
      }
      await p.helpers.viewDocs(main, new URLSearchParams({ doc: d.slug }));
      assert.equal(main.querySelector('h1').textContent, d.title, `${d.slug} opens as itself`);
      const prose = main.querySelector('.doc-prose');
      assert.ok(prose.children.length > 0 && !prose.querySelector('.empty'), `${d.slug} renders`);
      rendered.set(d.slug, prose.cloneNode(true));
      for (const a of prose.querySelectorAll('a[href^="#/docs?doc="]')) {
        const q = new URLSearchParams(a.getAttribute('href').slice('#/docs?'.length));
        links.push({ from: d.slug, doc: q.get('doc') ?? '', anchor: q.get('anchor') ?? '' });
      }
    }
    const anchored = links.filter((l) => l.anchor);
    assert.ok(anchored.length > 100, `found ${anchored.length} section links between bundled pages`);
    for (const { from, doc, anchor } of links) {
      assert.ok(rendered.has(doc), `${from} links ${doc}, which the bundle does not list`);
      if (anchor) assert.ok(p.helpers.docAnchorNode(rendered.get(doc), anchor), `${from} links ${doc}#${anchor}, which lands nowhere on that page`);
    }
    // Each retired slug points at a page this bundle lists, at a section it has.
    for (const [old, target] of Object.entries(p.helpers.docSlugAliases) as Array<[string, { slug: string; anchor?: string }]>) {
      assert.ok(!Object.hasOwn(pages, old), `${old} is listed again, so its alias is dead weight`);
      assert.ok(rendered.has(target.slug), `${old} is aliased to ${target.slug}, which the bundle does not list`);
      if (target.anchor) assert.ok(p.helpers.docAnchorNode(rendered.get(target.slug), target.anchor), `${old} is aliased to ${target.slug}#${target.anchor}, which lands nowhere`);
    }
  } finally { p.dom.window.close(); }
});
