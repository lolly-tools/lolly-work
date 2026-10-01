// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { normalizeOverlay, resolveInputAccess, type ToolOverlay } from '../server/src/policy/overlay.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { createToolPolicyEditor } = require('../console/tool-policy-editor.js');
const consoleSource = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Use the console's real DOM/label helpers and router without booting a session. */
function page(overlay: object = {}, api?: (path: string, options: any) => Promise<unknown>, inputs = [{ id: 'title', label: 'Title', default: 'Hello' }]) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', {
    url: 'https://work.example/admin#/tools', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.createToolPolicyEditor = createToolPolicyEditor;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (callback: () => void) => callback();
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(consoleSource + `
    window.testConsole = { el, field, route, renderToolPolicyEditor,
      configure() { session = { user: { role: 'admin' } }; renderedRouteHash = '#/tools';
        VIEWS.projects.render = async (main) => main.append(el('h1', {}, 'Projects'));
      }
    };
  `);
  const calls: Array<{ path: string; body: any }> = [];
  let pending: Promise<unknown> | undefined;
  const pendingSave = () => pending;
  let saved = 0;
  let closed = 0;
  const tool = { id: 'card', name: 'Card', inputs, overlay };
  const editor = createToolPolicyEditor(tool, {
    el: w.testConsole.el, field: w.testConsole.field,
    api: (path: string, options: any) => {
      calls.push({ path, body: options.body }); pending = Promise.resolve(api?.(path, options)); return pending;
    },
    onSaved: () => { saved++; }, onClose: () => { closed++; },
  });
  w.document.getElementById('app').append(editor.element);
  return { dom, w, tool, editor, calls, counts: () => ({ saved, closed }),
    find: (selector: string) => editor.element.querySelector(selector),
    input(selector: string, value: string) {
      const control = editor.element.querySelector(selector);
      assert.ok(control, selector);
      control.value = value;
      control.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    async save() {
      pending = undefined; editor.element.querySelector('[data-action="save"]').click();
      await pendingSave()?.catch(() => {}); await pause();
    },
    cleanup() { editor.dispose(); dom.window.close(); },
  };
}

test('unchanged saves preserve supported fields and original value types through normalization', async () => {
  const inputAccess: ToolOverlay['inputAccess'] = {};
  const values = ['42', '', { nested: ['blue, green', 42] }, [1, '2'], null, false, 0];
  values.forEach((value, index) => { inputAccess[`value-${index}`] = [{ groups: ['*'], level: 'locked', value }]; });
  inputAccess.title = [{ groups: ['brand'], level: 'choice', allow: ['blue, green', '42', 42, '', { x: 1 }, [2]] },
    { groups: ['*'], level: 'locked' }];
  const original: ToolOverlay = { toolId: 'card', version: 7, name: 'Brand rules', inputAccess,
    visibility: { groups: ['brand', 'marketing'] }, enforce: { formats: ['svg'], watermark: 'always' },
    defaults: { title: 'Default', metadata: { x: 1 } } };
  const p = page(original);
  try {
    assert.equal(p.editor.isDirty(), false);
    await p.save();
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]?.path, '/api/v1/policy/overlays/card');
    assert.deepEqual(normalizeOverlay('card', p.calls[0]?.body, 7), { ...original, version: 8 });
    assert.deepEqual(p.tool.overlay, original, 'the form never mutates the loaded overlay');
    assert.equal(p.editor.isDirty(), false);
    assert.equal(p.counts().saved, 1);
  } finally { p.cleanup(); }
});

test('explicit edits accept JSON choices, comma shorthand, and an intentionally blank locked value', async () => {
  const p = page({ inputAccess: { title: [{ groups: ['*'], level: 'choice', allow: ['old'] }] } });
  try {
    p.input('[data-rule-choices]', '["blue, green", "42", 42, {"x":1}]');
    await p.save();
    assert.deepEqual(p.calls.at(-1)?.body.inputAccess.title[0].allow, ['blue, green', '42', 42, { x: 1 }]);
    p.input('[data-rule-choices]', 'blue, 42, false');
    await p.save();
    assert.deepEqual(p.calls.at(-1)?.body.inputAccess.title[0].allow, ['blue', 42, false]);
    const level = p.find('.policy-rule select');
    level.value = 'locked'; level.dispatchEvent(new p.w.Event('change'));
    p.input('[data-rule-value]', '');
    await p.save();
    assert.equal(p.calls.at(-1)?.body.inputAccess.title[0].value, '');
    p.input('[data-rule-value]', '{"x":42}');
    await p.save();
    assert.deepEqual(p.calls.at(-1)?.body.inputAccess.title[0].value, { x: 42 });
  } finally { p.cleanup(); }
});

test('group names containing commas survive saves and JSON group lists validate before writing', async () => {
  const original: ToolOverlay = { toolId: 'card', version: 1, visibility: { groups: ['Sales, EMEA'] },
    inputAccess: { title: [{ groups: ['Sales, EMEA', 'brand'], level: 'locked', value: 'Title' }] } };
  const p = page(original);
  try {
    await p.save();
    assert.deepEqual(normalizeOverlay('card', p.calls[0]?.body, 1), { ...original, version: 2 });
    p.input('[data-rule-groups]', '["Sales, Americas", "brand"]');
    await p.save();
    assert.deepEqual(p.calls.at(-1)?.body.inputAccess.title[0].groups, ['Sales, Americas', 'brand']);
    for (const groups of ['["broken"', '[42]']) {
      p.input('[data-rule-groups]', groups); await p.save();
      assert.equal(p.calls.length, 2);
      assert.match(p.find('[role="alert"]').textContent, /JSON array of names/);
    }
  } finally { p.cleanup(); }
});

test('rule moves remove shadow warnings and change the real group resolution', async () => {
  const p = page({ inputAccess: { title: [
    { groups: ['*'], level: 'locked', value: 'Everyone' },
    { groups: ['brand'], level: 'editable' },
  ] } });
  try {
    assert.match(p.find('[data-rule-index="1"] [data-rule-warning]').textContent, /never apply.*rule 1/);
    p.find('[data-rule-index="1"] [data-action="move-up"]').click();
    assert.equal(p.find('[data-rule-index="1"] [data-rule-warning]').hidden, true);
    assert.equal(p.w.document.activeElement, p.find('[data-rule-index="0"] [data-rule-groups]'));
    await p.save();
    const saved = normalizeOverlay('card', p.calls[0]?.body, 0);
    assert.ok(saved);
    assert.equal(resolveInputAccess(saved, 'title', ['brand']).level, 'editable');
    assert.equal(resolveInputAccess(saved, 'title', ['marketing']).value, 'Everyone');
    p.find('[data-rule-index="0"] [data-action="move-down"]').click();
    assert.equal(p.find('[data-rule-index="1"] [data-rule-warning]').hidden, false);
  } finally { p.cleanup(); }
});

test('new exceptions are inserted above the catch-all and cannot save with blank groups', async () => {
  const p = page({ inputAccess: { title: [{ groups: ['*'], level: 'locked', value: 'Everyone' }] } });
  try {
    p.find('[data-action="add-rule"]').click();
    assert.equal(p.find('[data-rule-index="0"] [data-rule-groups]').value, '');
    assert.equal(p.find('[data-rule-index="1"] [data-rule-groups]').value, '*');
    await p.save();
    assert.equal(p.calls.length, 0);
    assert.match(p.find('[role="alert"]').textContent, /needs at least one group/);
    assert.equal(p.find('[data-rule-groups]').getAttribute('aria-invalid'), 'true');
    assert.equal(p.w.document.activeElement, p.find('[data-rule-groups]'));
    p.input('[data-rule-groups]', 'brand');
    await p.save();
    assert.equal(p.calls.length, 1);
    assert.deepEqual(p.calls[0]?.body.inputAccess.title.map((r: any) => r.groups), [['brand'], ['*']]);
  } finally { p.cleanup(); }
});

test('invalid and empty choice lists retain drafts without making a request', async () => {
  const p = page({ inputAccess: { title: [{ groups: ['*'], level: 'choice', allow: ['old'] }] } });
  try {
    for (const value of ['["broken"', '[]', '']) {
      p.input('[data-rule-choices]', value);
      await p.save();
      assert.equal(p.calls.length, 0);
      assert.ok(p.find('[role="alert"]').textContent);
      assert.equal(p.find('[data-rule-choices]').value, value);
      assert.equal(p.editor.isDirty(), true);
    }
  } finally { p.cleanup(); }
});

test('close and browser unload protect a draft; Keep editing and explicit discard work', () => {
  const p = page();
  try {
    p.input('input', 'Draft name');
    const unload = new p.w.Event('beforeunload', { cancelable: true });
    assert.equal(p.w.dispatchEvent(unload), false);
    p.find('[data-action="close"]').click();
    assert.equal(p.counts().closed, 0);
    p.find('.policy-discard button').click();
    assert.equal(p.editor.isDirty(), true);
    assert.equal(p.find('.policy-discard').childElementCount, 0);
    p.find('[data-action="close"]').click();
    p.find('[data-action="discard"]').click();
    assert.equal(p.counts().closed, 1);
    assert.equal(p.editor.isDirty(), false);
    p.editor.dispose();
    assert.equal(p.w.dispatchEvent(new p.w.Event('beforeunload', { cancelable: true })), true);
  } finally { p.cleanup(); }
});

test('failed and pending saves retain the draft and prevent leaving mid-request', async () => {
  let reject: (error: Error) => void = () => {};
  const p = page({}, () => new Promise((_, fail) => { reject = fail; }));
  try {
    p.input('input', 'Draft');
    p.find('[data-action="save"]').click();
    assert.equal(p.editor.isBusy(), true);
    assert.equal(p.find('fieldset').disabled, true);
    let left = false;
    p.editor.requestDiscard(() => { left = true; });
    assert.equal(left, false);
    assert.match(p.find('.policy-discard').textContent, /Wait for the save/);
    reject(new Error('Service unavailable')); await pause();
    assert.equal(p.editor.isBusy(), false);
    assert.equal(p.find('fieldset').disabled, false);
    assert.equal(p.find('input').value, 'Draft');
    assert.equal(p.editor.isDirty(), true);
    assert.match(p.find('[role="alert"]').textContent, /Service unavailable/);
    assert.equal(p.counts().saved, 0);
  } finally { p.cleanup(); }
});

test('watermark UI offers enforced options and preserves a warned legacy until-approved value', async () => {
  for (const legacy of [false, true]) {
    const p = page(legacy ? { enforce: { watermark: 'until-approved', formats: ['svg'] } } : {});
    try {
      const select = p.find('.policy-fields > .formrow select');
      assert.deepEqual(Array.from(select.options, (o: any) => o.value), legacy
        ? ['', 'never', 'always', 'until-approved'] : ['', 'never', 'always']);
      if (legacy) {
        assert.match(p.find('.policy-warning').textContent, /not enforced/);
        await p.save();
        assert.deepEqual(p.calls[0]?.body.enforce, { formats: ['svg'], watermark: 'until-approved' });
        select.value = 'always'; select.dispatchEvent(new p.w.Event('change'));
        await p.save();
        assert.deepEqual(p.calls.at(-1)?.body.enforce, { formats: ['svg'], watermark: 'always' });
      }
    } finally { p.cleanup(); }
  }
});

test('stored fields unsupported by the policy writer block saves instead of being silently stripped', async () => {
  const p = page({ enforce: { escalation: 'legal', c2pa: 'org-identity', formats: ['svg'] } });
  try {
    p.input('input', 'New name'); await p.save();
    assert.equal(p.calls.length, 0);
    assert.match(p.find('[role="alert"]').textContent, /enforce.escalation.*enforce.c2pa.*blocked/);
    assert.equal(p.editor.isDirty(), true);
  } finally { p.cleanup(); }
});

test('undeclared inputs and prototype-named inputs retain their rules when the manifest is incomplete', async () => {
  const p = page({ inputAccess: { toString: [{ groups: ['*'], level: 'locked', value: 'Safe' }] } }, undefined,
    [{ id: 'toString', label: 'Text', default: '' }, { id: 'constructor', label: 'Other', default: '' }]);
  try {
    await p.save();
    assert.equal(p.calls[0]?.body.inputAccess.toString[0].value, 'Safe');
    p.find('[data-input-id="constructor"] [data-action="add-rule"]').click();
    await p.save();
    assert.equal(p.calls.at(-1)?.body.inputAccess.constructor[0].value, '');
  } finally { p.cleanup(); }
});

test('the console router and tool switch require an explicit discard before replacing a dirty editor', async () => {
  const p = page();
  try {
    p.editor.dispose(); p.editor.element.remove(); p.w.testConsole.configure();
    const host = p.w.document.createElement('div'); p.w.document.getElementById('app').append(host);
    p.w.testConsole.renderToolPolicyEditor(p.tool, host);
    const name = host.querySelector('input'); name.value = 'Draft'; name.dispatchEvent(new p.w.Event('input'));
    p.w.testConsole.renderToolPolicyEditor({ ...p.tool, name: 'Another', id: 'another' }, host);
    assert.match(host.querySelector('h2').textContent, /Card/);
    host.querySelector('.policy-discard button').click();
    p.w.history.replaceState(null, '', '#/projects'); await p.w.testConsole.route();
    assert.equal(p.w.location.hash, '#/tools');
    assert.equal(host.querySelector('input').value, 'Draft');
    host.querySelector('[data-action="discard"]').click(); await pause();
    assert.equal(p.w.location.hash, '#/projects');
    assert.equal(p.w.document.querySelector('main h1').textContent, 'Projects');
  } finally { p.cleanup(); }
});

test('a real HTTP form save retains defaults and SVG-only enforcement, member resolution and audit', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-editor-'));
  const manifest = { id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 400, height: 200, formats: ['svg', 'png'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' },
      { id: 'bg', label: 'Background', type: 'color', default: '#204080' }] };
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'card', name: 'Card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'tools', 'card', 'template.html'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="{{bg}}"/><text x="20" y="110">{{title}}</text></svg>');
  const original: ToolOverlay = { toolId: 'card', version: 4, defaults: { bg: '#112233' },
    enforce: { formats: ['svg'] }, inputAccess: { title: [
      { groups: ['*'], level: 'locked', value: 'Old' }, { groups: ['brand'], level: 'editable' },
    ] } };
  const store = createMemoryStore({ overlays: [original], grants: ['brand', 'marketing'].map((group) => ({
    principal: `group:${group}`, action: 'export.server', resource: '*', effect: 'allow',
  })) });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Editor test', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] },
      { email: 'brand@test', groups: ['brand'] }, { email: 'marketing@test', groups: ['marketing'] }] },
    rateLimit: { enabled: false } }));
  const app = buildApp({ config, store, secrets: { session: 'editor-test-session', link: 'editor-test-link' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => {
    const response = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    return response.headers.getSetCookie().find((cookie) => cookie.startsWith('lw_session='))!.split(';')[0]!;
  };
  let p: ReturnType<typeof page> | undefined;
  try {
    const cookie = await login('admin@test');
    const listing = await (await fetch(`${base}/api/v1/policy/tools`, { headers: { cookie } })).json() as { tools: Array<{ overlay: ToolOverlay }> };
    p = page(listing.tools[0]!.overlay, async (path, options) => {
      const response = await fetch(base + path, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(options.body) });
      const saved = await response.json(); assert.equal(response.status, 200, JSON.stringify(saved)); return saved;
    });
    p.input('[data-rule-value]', 'New lock');
    p.find('[data-rule-index="1"] [data-action="move-up"]').click();
    await p.save();
    assert.equal(p.counts().saved, 1, p.find('[role="alert"]').textContent);
    const saved = (await store.listOverlays()).get('card')!;
    assert.equal(saved.version, 5);
    assert.deepEqual(saved.enforce, original.enforce);
    assert.deepEqual(saved.defaults, original.defaults);
    const audit = (await store.listAudit()).find((event) => event.action === 'policy.overlay.edit');
    assert.deepEqual(audit?.payload?.before, original);
    assert.deepEqual(audit?.payload?.after, saved);
    for (const group of ['brand', 'marketing']) {
      const member = await login(`${group}@test`);
      const org = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: member } })).json() as any;
      assert.deepEqual(org.tools.card.formats, ['svg']);
      const access = org.tools.card.inputs?.find((input: any) => input.id === 'title')?.access;
      if (group === 'brand') assert.equal(access, undefined, 'the ordered exception permits brand edits');
      else assert.equal(access.value, 'New lock');
      const png = await fetch(`${base}/render/card.png`, { headers: { cookie: member } });
      assert.equal(png.status, 403);
      assert.equal((await png.json() as any).error.code, 'FORMAT_NOT_ALLOWED');
      const svg = await fetch(`${base}/render/card.svg`, { headers: { cookie: member } });
      assert.equal(svg.status, 200);
      const text = await svg.text();
      if (group === 'marketing') assert.match(text, /New lock/);
    }
  } finally {
    p?.cleanup(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(pack, { recursive: true, force: true });
  }
});
