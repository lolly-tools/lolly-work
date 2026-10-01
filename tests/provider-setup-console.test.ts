// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { WEBDAV_SETUP } from '../server/src/catalog/providers/setup.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { createProviderSetup } = require('../console/provider-setup.js');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
const healthy = { health: { ok: true }, sampleTotal: 1, scanned: 1, pages: 1, sample: [{ name: 'Logo', type: 'image' }], original: { ok: true, bytes: 6, sha256: 'a'.repeat(64), contentType: 'image/svg+xml' } };
function page(api: (path: string, opts: any) => Promise<any>, owner = true) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://work.test/admin#/providers', runScripts: 'outside-only' }), w = dom.window;
  w.eval(source + '\nwindow.helpers = { el, field, setConsoleSession(actions) { session = {console: {actions}}; }, disposeActiveEditor() { activeToolPolicyEditor?.dispose(); activeToolPolicyEditor = null; } };');
  let closed = 0, saved = 0;
  const editor = createProviderSetup(WEBDAV_SETUP, { ...w.helpers, api, canStoreCredentials: owner, credentialStorageAvailable: true, onClose: () => closed++, onSaved: () => saved++ });
  w.document.getElementById('app').append(editor.element);
  const set = (selector: string, value: string) => { const node = editor.element.querySelector(selector); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = (text: string) => { const button = [...editor.element.querySelectorAll('button')].find((button: any) => button.textContent === text); assert.ok(button, text); button.click(); };
  const configure = () => {
    set('[data-provider-id]', 'brand-assets'); set('[data-provider-field="options.baseUrl"]', 'https://cloud.test'); set('[data-provider-field="options.root"]', 'Brand');
    set('[data-provider-field="exposure.groups"]', 'Legal, EMEA\nBrand'); set('[data-credential-user]', 'reader'); set('[data-credential-secret]', 'app-password-fixture');
  };
  return { dom, w, editor, set, click, configure, closed: () => closed, saved: () => saved, dispose: () => { w.helpers.disposeActiveEditor(); editor.dispose(); dom.window.close(); } };
}

test('typed connection preserves exact groups and saves, seals, syncs and enables in order', async () => {
  const calls: any[] = [];
  const p = page(async (path, opts) => { calls.push({ path, ...opts }); return path.endsWith('/preview') ? healthy : path.endsWith('/sync') ? { assetCount: 1 } : {}; });
  try {
    p.configure(); assert.equal(p.editor.isDirty(), true);
    p.click('Test files and original'); await pause(); assert.match(p.editor.element.textContent, /Files and original checked/);
    assert.doesNotMatch(p.editor.element.textContent, /\bnull\b/);
    p.click('Save source and seal credential'); await pause();
    assert.deepEqual(calls[1].body.exposure.groups, ['Legal, EMEA', 'Brand']); assert.equal(calls[1].body.options.root, 'Brand'); assert.ok(!JSON.stringify(calls[1].body).includes('password'));
    assert.equal(calls[2].body.secret, 'reader:app-password-fixture'); assert.equal(p.editor.element.querySelector('[data-credential-secret]').value, '');
    assert.equal(p.editor.isDirty(), false); assert.equal(p.w.localStorage.length, 0);
    p.click('Sync and enable source'); await pause(); await pause();
    assert.deepEqual(calls.map(call => call.path), ['/api/v1/catalog/providers/preview', '/api/v1/catalog/providers', '/api/v1/catalog/providers/brand-assets/credential', '/api/v1/catalog/providers/brand-assets/sync', '/api/v1/catalog/providers/brand-assets/enable']);
    assert.equal(p.saved(), 1); assert.match(p.editor.element.textContent, /Source enabled/);
  } finally { p.dispose(); }
});

test('empty, failed and unreadable previews never allow a save', async () => {
  for (const result of [{ ...healthy, sampleTotal: 0, sample: [] }, { ...healthy, sampleError: 'listing refused' }, { ...healthy, original: { ok: false, detail: 'get refused' } }]) {
    let writes = 0; const p = page(async () => { writes++; return result; });
    try {
      p.configure(); p.click('Test files and original'); await pause(); p.click('Save source and seal credential'); await pause();
      assert.equal(writes, 1); assert.match(p.editor.element.textContent, /Source needs attention/); assert.equal(p.editor.isDirty(), true);
    } finally { p.dispose(); }
  }
});

test('changes invalidate the preview and pending requests block navigation and duplicate calls', async () => {
  let resolve!: (result: any) => void; let calls = 0;
  const p = page(async () => { calls++; return new Promise(done => { resolve = done; }); });
  try {
    p.configure(); p.click('Test files and original'); p.click('Test files and original'); p.click('Close');
    assert.equal(calls, 1); assert.equal(p.editor.isBusy(), true); assert.equal(p.closed(), 0); assert.match(p.editor.element.textContent, /Wait for the request/);
    resolve(healthy); await pause(); p.set('[data-provider-field="options.root"]', 'Other');
    assert.doesNotMatch(p.editor.element.textContent, /Files and original checked/); p.click('Save source and seal credential'); assert.equal(calls, 1);
    p.click('Close'); p.click('Keep editing'); assert.equal(p.editor.isDirty(), true);
    p.click('Close'); p.click('Discard changes'); assert.equal(p.closed(), 1); assert.equal(p.editor.element.querySelector('[data-credential-secret]').value, '');
  } finally { p.dispose(); }
});

test('failed credential storage retries the same disabled source and never creates a duplicate', async () => {
  const calls: string[] = []; let credentials = 0;
  const p = page(async path => {
    calls.push(path);
    if (path.endsWith('/credential') && ++credentials === 1) throw new Error('Credential rejected');
    return path.endsWith('/preview') ? healthy : {};
  });
  try {
    p.configure(); p.click('Test files and original'); await pause(); p.click('Save source and seal credential'); await pause();
    assert.match(p.editor.element.textContent, /remains saved and disabled/); assert.equal(p.editor.isDirty(), true);
    p.click('Retry credential'); await pause();
    assert.equal(calls.filter(path => path === '/api/v1/catalog/providers').length, 1); assert.equal(credentials, 2); assert.equal(p.editor.isDirty(), false);
  } finally { p.dispose(); }
});

test('a failed full sync leaves the source disabled and can be retried', async () => {
  const calls: string[] = []; let syncs = 0;
  const p = page(async path => { calls.push(path); return path.endsWith('/preview') ? healthy : path.endsWith('/sync') ? { assetCount: ++syncs === 1 ? 0 : 1 } : {}; });
  try {
    p.configure(); p.click('Test files and original'); await pause(); p.click('Save source and seal credential'); await pause();
    p.click('Sync and enable source'); await pause(); assert.equal(calls.some(path => path.endsWith('/enable')), false); assert.match(p.editor.element.textContent, /stays disabled/);
    p.click('Sync and enable source'); await pause(); await pause(); assert.equal(p.saved(), 1);
  } finally { p.dispose(); }
});

test('configuration-only access hands off to an owner without storing credentials', async () => {
  const calls: string[] = []; const p = page(async path => { calls.push(path); return healthy; }, false);
  try {
    p.configure(); p.click('Test files and original'); await pause(); p.click('Save disabled source'); await pause();
    assert.equal(calls.length, 2); assert.ok(!calls.some(path => path.includes('/credential'))); assert.match(p.editor.element.textContent, /An owner must store/);
    assert.equal(p.editor.element.querySelector('[data-credential-secret]').value, ''); assert.equal(p.editor.isDirty(), false);
  } finally { p.dispose(); }
});

test('invalid URL and missing Nextcloud bearer login fail before any request and focus the field', async () => {
  let calls = 0; const p = page(async () => { calls++; return healthy; });
  try {
    p.configure(); p.set('[data-provider-field="options.baseUrl"]', 'https://user:password@cloud.test'); p.click('Test files and original'); await pause();
    assert.equal(calls, 0); assert.equal(p.w.document.activeElement.dataset.providerField, 'options.baseUrl');
    p.set('[data-provider-field="options.baseUrl"]', 'https://cloud.test');
    const auth = p.editor.element.querySelector('[data-provider-auth]'); auth.value = 'bearer'; auth.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.click('Test files and original'); await pause(); assert.equal(calls, 0); assert.match(p.editor.element.textContent, /files login when using a bearer token/);
  } finally { p.dispose(); }
});

test('provider screen uses effective capabilities and opens the guided panel from its card', async () => {
  const p = page(async () => healthy);
  try {
    p.editor.dispose(); p.editor.element.remove();
    p.w.HTMLElement.prototype.scrollIntoView = () => {};
    p.w.matchMedia = () => ({ matches: true });
    p.w.createProviderSetup = createProviderSetup;
    p.w.testApi = async (path: string) => path.endsWith('/setup') ? { providers: [WEBDAV_SETUP], credentialStorageAvailable: true } : { providers: [] };
    p.w.eval('api = window.testApi; activityHeader = async () => null; window.renderProviders = viewProviders;');
    const main = p.w.document.getElementById('app');
    await p.w.renderProviders(main);
    [...main.querySelectorAll('button')].find((button: any) => button.textContent === 'Guided connection').click();
    assert.ok(main.querySelector('[data-provider-field="options.baseUrl"]'));
    assert.match(main.textContent, /Save source and seal credential/);
    p.w.helpers.disposeActiveEditor(); p.w.helpers.setConsoleSession(['catalog.provider.read']);
    main.replaceChildren(); await p.w.renderProviders(main);
    assert.ok(![...main.querySelectorAll('button')].some((button: any) => ['Connect', 'Guided connection'].includes(button.textContent)));
  } finally { p.dispose(); }
});
