// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderDocPathChoices } from '../console/docs-path-chooser.js';
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
  w.renderDocPathChoices = renderDocPathChoices;
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.eval(`${source}\nwindow.helpers = { consoleNavigation, consoleRoute, viewInstance, viewBrandPages, viewOverview, applyRailState, views: VIEWS, route, setEditor: e => { activeToolPolicyEditor = e; renderedRouteHash = location.hash; }, sectionTabs, mdToNodes, viewDocs, docAnchorNode, docSlugAliases: DOC_SLUG_ALIASES, el, setSession: s => { session = s; } };`);
  return { dom, w, helpers: w.helpers };
}

test('task navigation and its mobile picker expose only permitted sections; search finds direct provider access', async () => {
  const p = page();
  try {
    const views = Object.fromEntries(Object.keys(p.helpers.views).map(id => [id, ['users', 'providers'].includes(id)]));
    p.helpers.setSession({ console: { views, actions: [] } });
    const nav = p.helpers.consoleNavigation('users'); p.w.document.body.append(nav);
    assert.deepEqual([...nav.querySelectorAll('a')].map((a: any) => a.textContent), ['People', 'Asset sources']);
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

test('offboarding choices keep their order and open local instructions without changing ordinary tables', async () => {
  const p = page();
  try {
    const markdown = `# Leave a DAM

| Destination | How files get there | Continue with |
|---|---|---|
| Self-hosted Work | Materialize into owned storage | [Work library](#work-library) |
| Nextcloud | Export and copy | [Nextcloud library](#nextcloud-library) |
| Git | Review and commit | [Git catalog](#git-catalog) |
| Hosted drive | Export and upload | [Hosted drive](#hosted-drive) |

## Work library

Use instance storage.

## Nextcloud library

Connect read-only.

## Git catalog

Commit a manifest.

## Hosted drive

Upload separately.

| Format | Note |
|---|---|
| SVG | Original |
`;
    p.w.fetch = docsFetch({ sections: [{ docs: [{ slug: 'offboarding', title: 'Leave a DAM', path: 'offboarding.md' }] }] }, { offboarding: markdown });
    const main = p.w.document.getElementById('app');
    await p.helpers.viewDocs(main, new URLSearchParams({ doc: 'offboarding' }));
    const choices = main.querySelectorAll('.doc-path-choice');
    assert.equal(choices.length, 4);
    assert.equal(choices[0].open, true);
    assert.equal(main.querySelectorAll('.doc-path-choice[open]').length, 1);
    assert.ok(choices[0].querySelector('summary').textContent.includes('Self-hosted Work'));
    assert.ok(choices[3].querySelector('summary').textContent.includes('Hosted drive'));
    assert.equal(main.querySelectorAll('.doc-tbl').length, 1, 'unrelated tables retain their usual layout');
    const links = [...main.querySelectorAll('.doc-path-next a')].map((a: any) => a.getAttribute('href'));
    for (const href of links) {
      const query = new URLSearchParams(href.slice('#/docs?'.length));
      assert.equal(query.get('doc'), 'offboarding');
      assert.ok(p.helpers.docAnchorNode(main.querySelector('.doc-prose'), query.get('anchor')));
    }
    await p.helpers.viewDocs(main, new URLSearchParams(links[1].slice('#/docs?'.length)));
    assert.equal(main.querySelector('[data-doc-anchor]').textContent, 'Nextcloud library');
  } finally { p.dom.window.close(); }
});

test('settings bookmarks resolve to one page and preserve unrelated query parameters', () => {
  const p = page();
  try {
    for (const id of ['tools', 'catalog', 'providers', 'design', 'brand-pages', 'flags', 'injectables', 'limits']) {
      const route = p.helpers.consoleRoute(`#/instance?tab=${id}&focus=example`);
      assert.equal(route.id, id);
      assert.equal(route.params.get('focus'), 'example');
      assert.equal(route.params.has('tab'), false);
      assert.equal(typeof p.helpers.views[route.id].render, 'function');
    }
    assert.equal(p.helpers.consoleRoute('#/instance?tab=unknown').id, 'instance');
    assert.equal(p.helpers.consoleRoute('#/users?tab=requests').params.get('tab'), 'requests');
  } finally { p.dom.window.close(); }
});

test('settings show only permitted tasks and give each task a direct destination', async () => {
  const p = page();
  try {
    p.helpers.setSession({ console: { views: Object.fromEntries(Object.keys(p.helpers.views).map(id => [id, ['design', 'tokens'].includes(id)])) } });
    const main = p.w.document.getElementById('app');
    await p.helpers.viewInstance(main, new URLSearchParams());
    assert.equal(main.querySelectorAll('h1').length, 1);
    assert.equal(main.querySelector('h1').textContent, 'Settings');
    assert.deepEqual([...main.querySelectorAll('a')].map((a: any) => a.getAttribute('href')), ['#/design', '#/tokens']);
    assert.equal(main.querySelectorAll('[role=tab]').length, 0);
    assert.equal(main.querySelectorAll('.settings-section').length, 2);
  } finally { p.dom.window.close(); }
});

test('search reveals secondary settings, restores disclosures and keeps the active monitoring section open', () => {
  const p = page();
  try {
    const nav = p.helpers.consoleNavigation('fleet'); p.w.document.body.append(nav);
    const monitoring = nav.querySelector('details[aria-label="Monitoring"]');
    const administration = nav.querySelector('details[aria-label="Administration"]');
    assert.equal(monitoring.open, true);
    assert.equal(administration.open, false);
    assert.equal(nav.querySelector('[aria-current=page]').textContent, 'Connected apps');
    const search = nav.querySelector('input');
    search.value = 'scim'; search.dispatchEvent(new p.w.Event('input'));
    const tokens = nav.querySelector('a[href="#/tokens"]');
    assert.equal(tokens.hidden, false); assert.equal(tokens.parentElement.hidden, false);
    assert.equal(monitoring.open, false);
    search.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(tokens.parentElement.hidden, true);
    assert.equal(monitoring.open, true); assert.equal(administration.open, false);
    p.w.localStorage.setItem('lw-rail-collapsed', '1'); p.helpers.applyRailState();
    assert.equal(administration.open, true, 'the icon rail exposes secondary destinations');
    p.w.localStorage.removeItem('lw-rail-collapsed'); p.helpers.applyRailState();
    assert.equal(administration.open, false); assert.equal(monitoring.open, true);
  } finally { p.dom.window.close(); }
});

test('overview actions respect permissions, requests open their queue and missing links do not look like zero', async () => {
  const p = page();
  try {
    p.helpers.setSession({ console: { views: { fleet: false, users: true, links: true, audit: false, agents: false, catalog: false, design: false, approvals: true }, actions: [] } });
    const called: string[] = [];
    p.w.fetch = async (url: string) => {
      called.push(url);
      const data = url === '/api/v1/telemetry/summary' ? { days: [{ date: '2026-11-10', events: 3, exports: 1, users: 1 }], totals: { activeUsers: 1 }, topTools: [], formats: [] }
        : url === '/api/v1/access-requests?status=open' ? { requests: [{ id: 'ask' }] }
        : url === '/api/v1/approvals' ? { approvals: [] } : null;
      return { ok: data !== null, status: data ? 200 : 503, json: async () => data, text: async () => 'Unavailable' };
    };
    const main = p.w.document.getElementById('app'); await p.helpers.viewOverview(main);
    assert.deepEqual([...main.querySelectorAll('.quick-actions a')].map((a: any) => a.textContent), ['Review approvals']);
    assert.equal(main.querySelector('.needs-link').getAttribute('href'), '#/users?tab=requests');
    assert.match(main.textContent, /Live share links nowUnavailable/);
    assert.equal(main.querySelector('.zero-banner'), null);
    assert.ok(!called.some(path => /fleet|audit|agents/.test(path)));
    assert.equal(main.querySelector('details.overview-detail').open, false);
  } finally { p.dom.window.close(); }
});

test('following a legacy settings bookmark still asks before discarding a draft', async () => {
  const p = page();
  try {
    let asked = false; let disposed = false;
    p.helpers.setEditor({ isDirty: () => true, isBusy: () => false, dispose: () => { disposed = true; }, requestDiscard: () => { asked = true; } });
    p.w.history.replaceState(null, '', '#/instance?tab=design');
    await p.helpers.route();
    assert.equal(asked, true); assert.equal(disposed, false);
    assert.equal(p.w.location.hash, '#/users');
  } finally { p.dom.window.close(); }
});


test('brand pages keep a page heading when publication is disabled', async () => {
  const p = page();
  try {
    p.w.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Disabled' } }) });
    const main = p.w.document.getElementById('app'); await p.helpers.viewBrandPages(main);
    assert.equal(main.querySelectorAll('h1').length, 1);
    assert.equal(main.querySelector('h1').textContent, 'Brand pages');
    assert.match(main.textContent, /Brand pages are off/);
  } finally { p.dom.window.close(); }
});
