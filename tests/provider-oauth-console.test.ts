// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { GDRIVE_SETUP, WEBDAV_SETUP } from '../server/src/catalog/providers/setup.ts';

const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
const { createOAuthProviderSetup } = require('../console/provider-oauth-setup.js');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
const existing = { id: 'brand-drive', kind: 'gdrive', label: 'Brand Drive', managedBy: 'db', enabled: false, guidedSetupAvailable: true, options: { folderId: 'FOLDER1' }, exposure: { groups: ['Legal, EMEA', 'design'] }, mapping: {}, sync: {}, credential: { fingerprint: 'abc' }, state: { assetCount: 0 } };
const receipt = { health: { ok: true }, sampleTotal: 1, pages: 1, skipped: 2, sample: [{ name: 'Logo', type: 'image' }], original: { ok: true, bytes: 40, sha256: 'a'.repeat(64), contentType: 'image/svg+xml' }, revision: 'revision-fixture' };
function page(api: (path: string, options: any) => Promise<any>, options: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://work.test/admin#/providers', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
  w.eval(source + '\nwindow.helpers = { el, field, setConsoleSession(actions) { session = {console: {actions}}; }, disposeActiveEditor() { activeToolPolicyEditor?.dispose(); activeToolPolicyEditor = null; } };');
  let closed = 0, saved = 0; const destinations: string[] = [];
  const editor = createOAuthProviderSetup(GDRIVE_SETUP, { ...w.helpers, api, oauth: { available: true, redirectUri: 'https://work.test/api/auth/provider-oauth/callback' }, canStoreCredentials: true, credentialStorageAvailable: true,
    onClose: () => closed++, onSaved: () => saved++, navigate: (url: string) => destinations.push(url), ...options });
  w.document.getElementById('app').append(editor.element);
  const set = (selector: string, value: string) => { const input = editor.element.querySelector(selector); input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const button = (text: string) => { const button = [...editor.element.querySelectorAll('button')].find((button: any) => button.textContent === text); assert.ok(button, text); return button; };
  const click = (text: string) => button(text).click();
  const configure = () => { set('[data-provider-id]', 'brand-drive'); set('[data-provider-field="options.folderId"]', 'FOLDER1'); set('[data-provider-field="exposure.groups"]', 'Legal, EMEA\ndesign'); };
  return { dom, w, editor, set, button, click, configure, destinations, closed: () => closed, saved: () => saved, dispose: () => { w.helpers.disposeActiveEditor(); editor.dispose(); dom.window.close(); } };
}

test('Google setup saves typed configuration and hands off to consent with no browser-stored secrets', async () => {
  const calls: any[] = [];
  const p = page(async (path, options) => { calls.push({ path, ...options }); return path.endsWith('/start') ? { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' } : {}; });
  try {
    p.configure(); p.click('Save disabled source'); await pause();
    assert.deepEqual(calls[0].body.exposure.groups, ['Legal, EMEA', 'design']); assert.equal(calls[0].body.options.folderId, 'FOLDER1'); assert.equal(p.editor.isDirty(), false);
    p.set('[data-oauth-client-id]', '123.apps.googleusercontent.com'); p.set('[data-oauth-client-secret]', 'client-secret-fixture'); p.click('Connect with Google'); await pause();
    assert.equal(calls.length, 2); assert.ok(!JSON.stringify(calls[0]).includes('client-secret')); assert.deepEqual(calls[1].body, { clientId: '123.apps.googleusercontent.com', clientSecret: 'client-secret-fixture' });
    assert.equal(p.editor.element.querySelector('[data-oauth-client-secret]').value, ''); assert.equal(p.destinations.length, 1); assert.equal(p.editor.isDirty(), false);
    assert.equal(p.w.localStorage.length, 0); assert.equal(p.w.sessionStorage.length, 0);
    assert.equal(p.w.dispatchEvent(new p.w.Event('beforeunload', { cancelable: true })), true);
    assert.equal(p.editor.element.querySelectorAll('textarea').length, 1, 'only exact member groups use a textarea; no JSON input');
  } finally { p.dispose(); }
});

test('saved consent resumes with a fresh stored-credential preview, then syncs and guards enable with its revision', async () => {
  const calls: any[] = []; const p = page(async (path, options) => { calls.push({ path, ...options }); return path.endsWith('setup-preview') ? receipt : path.endsWith('/sync') ? { assetCount: 1, skipped: 2 } : {}; }, { existing, outcome: 'connected' });
  try {
    assert.match(p.editor.element.textContent, /credential sealed/); assert.equal(p.button('Sync and enable source').disabled, true);
    p.click('Test saved files and original'); await pause(); assert.match(p.editor.element.textContent, /Files and original checked/);
    p.click('Sync and enable source'); await pause(); await pause();
    assert.deepEqual(calls.map(call => call.path), ['/api/v1/catalog/providers/brand-drive/setup-preview', '/api/v1/catalog/providers/brand-drive/sync', '/api/v1/catalog/providers/brand-drive/enable']);
    assert.deepEqual(calls[2].body, { setupRevision: 'revision-fixture' }); assert.equal(p.saved(), 1); assert.match(p.editor.element.textContent, /Source enabled/);
  } finally { p.dispose(); }
});

test('editing saved settings invalidates read evidence and saves the same disabled source', async () => {
  const calls: any[] = [], p = page(async (path, options) => { calls.push({ path, ...options }); return receipt; }, { existing });
  try {
    p.click('Test saved files and original'); await pause(); p.set('[data-provider-field="options.folderId"]', 'FOLDER2');
    assert.equal(p.button('Sync and enable source').disabled, true); assert.equal(p.button('Test saved files and original').disabled, true);
    p.click('Save disabled settings'); await pause();
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].path, '/api/v1/catalog/providers/brand-drive'); assert.equal(calls[1].body.options.folderId, 'FOLDER2');
    assert.equal(p.editor.isDirty(), false); assert.equal(p.button('Sync and enable source').disabled, true); assert.equal(p.button('Test saved files and original').disabled, false);
  } finally { p.dispose(); }
});

test('unreadable originals and failed or empty full syncs keep Google sources disabled', async () => {
  for (const response of [{ ...receipt, original: { ok: false, detail: 'access revoked' } }, receipt]) {
    let enables = 0; const p = page(async path => { if (path.endsWith('/enable')) enables++; return path.endsWith('setup-preview') ? response : { assetCount: 0 }; }, { existing });
    try {
      p.click('Test saved files and original'); await pause(); p.click('Sync and enable source'); await pause();
      assert.equal(enables, 0); assert.equal(p.saved(), 0); assert.match(p.editor.element.textContent, response.original.ok ? /Full sync found no exposed files/ : /access revoked/);
    } finally { p.dispose(); }
  }
});

test('pending Google operations and dirty credentials guard navigation and discard clears the secret', async () => {
  let resolve!: (value: unknown) => void, calls = 0;
  const p = page(async () => { calls++; return new Promise(done => { resolve = done; }); });
  try {
    p.configure(); p.click('Save disabled source'); p.click('Save disabled source'); p.click('Close');
    assert.equal(calls, 1); assert.equal(p.closed(), 0); assert.match(p.editor.element.textContent, /Wait for the request/);
    resolve({}); await pause(); p.set('[data-oauth-client-secret]', 'unsaved-secret'); p.click('Close'); assert.equal(p.closed(), 0);
    assert.equal(p.w.dispatchEvent(new p.w.Event('beforeunload', { cancelable: true })), false);
    p.click('Discard changes'); assert.equal(p.closed(), 1); assert.equal(p.editor.element.querySelector('[data-oauth-client-secret]').value, '');
  } finally { p.dispose(); }
});

test('admin handoff, missing server configuration and failed consent provide actionable recovery', async () => {
  for (const options of [{ canStoreCredentials: false }, { credentialStorageAvailable: false }, { oauth: { available: false, reason: 'Configure HTTPS first.' } }]) {
    const p = page(async () => ({}), { existing: { ...existing, credential: null }, ...options });
    try { assert.equal(p.button('Connect with Google').closest('fieldset').disabled, true); assert.equal(p.button('Sync and enable source').disabled, true); } finally { p.dispose(); }
  }
  const p = page(async () => { throw new Error('Consent unavailable'); }, { existing, outcome: 'denied' });
  try {
    assert.match(p.editor.element.textContent, /previous credential.*retained/); p.set('[data-oauth-client-id]', 'bad-client'); p.click('Reconnect with Google'); await pause();
    assert.equal(p.w.document.activeElement, p.editor.element.querySelector('[data-oauth-client-id]'));
  } finally { p.dispose(); }
});

test('provider screen opens Google consent setup from its card and resumes callbacks from saved records', async () => {
  const p = page(async () => receipt);
  try {
    p.editor.dispose(); p.editor.element.remove(); p.w.HTMLElement.prototype.scrollIntoView = () => {}; p.w.matchMedia = () => ({ matches: true }); p.w.createOAuthProviderSetup = createOAuthProviderSetup;
    p.w.testApi = async (path: string) => path.endsWith('/setup') ? { providers: [WEBDAV_SETUP, GDRIVE_SETUP], oauth: { available: true, redirectUri: 'https://work.test/api/auth/provider-oauth/callback' }, credentialStorageAvailable: true } : { providers: [existing] };
    p.w.eval('api = window.testApi; activityHeader = async () => null; window.renderProviders = viewProviders;');
    const main = p.w.document.getElementById('app'); await p.w.renderProviders(main);
    [...main.querySelectorAll('.connect-card')].find((card: any) => card.textContent.includes('Google Drive')).querySelector('button').click();
    assert.ok(main.querySelector('[data-oauth-client-id]')); assert.match(main.textContent, /Save disabled source/);
    p.w.helpers.disposeActiveEditor(); main.replaceChildren();
    await p.w.renderProviders(main, new p.w.URLSearchParams('setup=brand-drive&oauth=connected'));
    assert.equal(main.querySelector('[data-provider-id]').value, 'brand-drive'); assert.match(main.textContent, /Google consent completed/);
    assert.ok(![...main.querySelectorAll('button')].some((button: any) => button.textContent === 'Set key' || button.textContent === 'Enable'));
  } finally { p.dispose(); }
});
