// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { createChainEditor } = require('../console/chains.js');
const { tokensView } = require('../console/setup.js');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
function page() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/chains', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.eval(source + '\nwindow.helpers = { el, field };');
  return { dom, w, main: w.document.getElementById('app'), helpers: w.helpers };
}
const chain = { id: 'brand', name: 'Brand', steps: [
  { name: 'Brand review', approvers: { groups: ['Brand, EMEA'] }, rule: 'any' },
  { name: 'Legal review', approvers: { groups: ['legal'] }, rule: { quorum: 2 } },
], onReject: 'return-to-submitter' };
const click = (root: any, text: string) => {
  const button = [...root.querySelectorAll('button')].find((button: any) => button.textContent === text);
  assert.ok(button, text); button.click();
};

test('chain editing preserves comma group names and saves the reordered quorum steps', async () => {
  const p = page(); const calls: any[] = []; let saved = 0;
  const editor = createChainEditor(chain, { ...p.helpers, api: async (path: string, options: any) => { calls.push({ path, ...options }); }, onSaved: () => saved++, onClose() {} });
  p.main.append(editor.element);
  try {
    editor.element.querySelector('[aria-label="Move step 2 up"]').click();
    assert.equal(editor.isDirty(), true);
    assert.equal(p.w.document.activeElement.value, 'Legal review');
    click(editor.element, 'Save chain'); await pause();
    assert.equal(calls[0].path, '/api/v1/chains/brand');
    assert.deepEqual(calls[0].body.steps, [chain.steps[1], chain.steps[0]]);
    assert.equal(saved, 1); assert.equal(editor.isDirty(), false);
    assert.equal(chain.steps[0]!.name, 'Brand review');
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('invalid chains cannot write, and failed writes retain a draft with a discard choice', async () => {
  const p = page(); let writes = 0; let closed = 0;
  const editor = createChainEditor(chain, { ...p.helpers, api: async () => { writes++; throw new Error('Save unavailable'); }, onSaved() {}, onClose: () => closed++ });
  p.main.append(editor.element);
  const set = (control: any, value: string) => { control.value = value; control.dispatchEvent(new p.w.Event('input')); };
  try {
    const controls = editor.element.querySelector('.policy-rule').querySelectorAll('input');
    set(controls[1], '["broken"'); click(editor.element, 'Save chain'); await pause();
    assert.equal(writes, 0); assert.match(editor.element.textContent, /JSON array/);
    set(controls[1], '["Brand, EMEA", "brand"]'); click(editor.element, 'Save chain'); await pause();
    assert.equal(writes, 1); assert.match(editor.element.textContent, /Save unavailable/);
    assert.equal(editor.isDirty(), true); assert.equal(controls[1].value, '["Brand, EMEA", "brand"]');
    click(editor.element, 'Close'); assert.equal(closed, 0);
    click(editor.element, 'Keep editing'); assert.equal(editor.isDirty(), true);
    click(editor.element, 'Close'); click(editor.element, 'Discard changes'); assert.equal(closed, 1);
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('pending chain requests block close and preview results disappear after an edit', async () => {
  const p = page(); let resolve!: (value: unknown) => void; let closed = 0;
  const editor = createChainEditor(chain, { ...p.helpers, api: () => new Promise(done => { resolve = done; }), onSaved() {}, onClose: () => closed++ });
  p.main.append(editor.element);
  try {
    click(editor.element, 'Preview reviewers'); assert.equal(editor.isBusy(), true);
    editor.requestDiscard(() => closed++); assert.equal(closed, 0);
    assert.match(editor.element.textContent, /Wait for the request/);
    resolve({ viable: false, steps: [{ name: 'Legal', eligibleCount: 1, otherEligibleCount: 1, required: 2 }] }); await pause();
    assert.match(editor.element.textContent, /Some steps cannot complete/);
    const name = editor.element.querySelectorAll('input')[1]; name.value = 'Launch'; name.dispatchEvent(new p.w.Event('input'));
    assert.doesNotMatch(editor.element.textContent, /Some steps cannot complete/);
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('one-time service credentials clear on acknowledgment and do not fetch denied SCIM metadata', async () => {
  const p = page(); const calls: any[] = []; let refreshed = 0;
  const token = 'one-time-fixture-secret';
  try {
    await tokensView(p.main, { ...p.helpers, can: (action: string) => action === 'token.manage', refresh: () => refreshed++,
      api: async (path: string, options?: any) => { calls.push({ path, ...options }); return options?.method === 'POST' ? { token } : { tokens: [] }; } });
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/v1/tokens');
    p.main.querySelector('input').value = 'Customer automation';
    p.main.querySelector('form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await pause();
    assert.deepEqual(calls[1].body, { label: 'Customer automation', role: 'member' });
    const secret = p.main.querySelector('textarea'); assert.equal(secret.value, token);
    assert.equal(p.main.querySelector('button[type="submit"]').disabled, true);
    assert.equal(p.w.localStorage.length, 0); assert.doesNotMatch(p.w.location.href, /fixture-secret/);
    click(p.main, 'I have stored the token'); assert.equal(secret.value, ''); assert.equal(p.main.querySelector('textarea'), null); assert.equal(refreshed, 1);
  } finally { p.dom.window.close(); }
});

const { createSetupWizard } = require('../console/setup-wizard.js');
const { setupDraft, generateSetup } = require('../server/src/setup/configuration.ts');
const { parseConfig } = require('../server/src/config/instance.ts');
const wizardConfig = () => parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, instance: { baseUrl: 'https://work.test' },
  dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] } }));
function wizardFixture(extra?: (path: string, options: any) => Promise<any>) {
  const config = wizardConfig(), settings = setupDraft(config, ['owner']); const calls: any[] = [];
  const account = { id: 'u1', sub: 'dev:owner@test', role: 'owner', groups: ['owner'], active: true, signIn: null, provisioned: null };
  const api = async (path: string, options: any = {}) => {
    calls.push({ path, ...options });
    if (extra) { const result = await extra(path, options); if (result !== undefined) return result; }
    if (path === '/api/v1/system/setup') return { mode: 'evaluation', ready: true, checks: [{ id: 'identity-live', status: 'not-tested', message: 'Complete a real sign-in.' }], pack: { engine: '1.239.0', revision: 'pack-1', source: 'mounted', compatible: true, diagnostics: [], tools: [{ id: 'card', valid: true, serverFormats: ['svg'], unavailableFormats: [], diagnostics: [] }] } };
    if (path === '/api/v1/system/setup/configuration' && !options.method) return { settings, currentSettingsHash: 'current-config', sampleAccountHash: 'account-1', environment: [], account, identityTest: null, scimUrl: 'https://work.test/scim/v2', redirectUri: null };
    if (path === '/api/v1/org-config') return { policyVersion: 'policy-1', branding: { revision: 1 } };
    if (path === '/api/v1/system/setup/tools/card') return { toolId: 'card', formats: ['svg'], expectedDimensions: { widthPx: 100, heightPx: 100 }, inputs: [{ id: 'title', type: 'text', label: 'Sample title', value: 'Welcome', access: 'editable' }] };
    if (path === '/api/v1/system/setup/configuration') return generateSetup(options.body, config);
    throw new Error(`Unexpected call: ${path}`);
  };
  return { config, calls, api };
}

test('guided setup retains exact group drafts across steps and exports without writing live configuration', async () => {
  const p = page(), fixture = wizardFixture(); const editor = await createSetupWizard({ ...p.helpers, api: fixture.api }); p.main.append(editor.element);
  try {
    click(editor.element, '2. Identity and owner');
    const groups = editor.element.querySelector('[data-role="approver"]'); groups.value = 'Legal, EMEA'; groups.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    assert.equal(editor.isDirty(), true);
    click(editor.element, '3. Provisioning'); click(editor.element, '2. Identity and owner'); assert.equal(groups.value, 'Legal, EMEA');
    click(editor.element, 'Generate validated configuration'); await pause();
    const preview = fixture.calls.find(call => call.method === 'POST'); assert.deepEqual(preview.body.roleGroups.approver, ['Legal, EMEA']);
    assert.match(editor.element.textContent, /not been saved to the running deployment/); assert.match(editor.element.textContent, /Generated settings are pending/);
    assert.equal(editor.isDirty(), true); assert.equal(fixture.config.idp.roleGroups.approver, undefined);
    p.w.URL.createObjectURL = () => 'blob:fixture'; p.w.URL.revokeObjectURL = () => {};
    p.w.HTMLAnchorElement.prototype.click = () => {};
    click(editor.element, 'Download setup file'); assert.equal(editor.isDirty(), false);
    const stored = p.w.localStorage.getItem('lw.setup.progress.v1'); assert.doesNotMatch(stored, /Legal|work.test|settings"|token/);
    assert.equal(fixture.calls.filter(call => call.method && call.method !== 'GET').length, 1);
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('guided validation focuses the affected step and retains an unexported draft with navigation protection', async () => {
  const p = page(), fixture = wizardFixture(async (path, options) => {
    if (path === '/api/v1/system/setup/configuration' && options.method) throw Object.assign(new Error('Use HTTPS for production.'), { field: 'baseUrl' });
  });
  const editor = await createSetupWizard({ ...p.helpers, api: fixture.api }); p.main.append(editor.element);
  try {
    const address = editor.element.querySelector('[data-setting="baseUrl"]'); address.value = 'http://customer.test'; address.dispatchEvent(new p.w.Event('input'));
    click(editor.element, '6. Finish setup'); click(editor.element, 'Generate validated configuration'); await pause();
    assert.equal(p.w.document.activeElement, address); assert.equal(address.value, 'http://customer.test'); assert.equal(editor.isDirty(), true);
    assert.match(editor.element.textContent, /Use HTTPS/); let left = false; editor.requestDiscard(() => { left = true; }); assert.equal(left, false);
    click(editor.element, 'Keep editing'); assert.equal(editor.isDirty(), true);
    editor.requestDiscard(() => { left = true; }); click(editor.element, 'Discard changes'); assert.equal(left, true);
    assert.doesNotMatch(p.w.localStorage.getItem('lw.setup.progress.v1'), /customer.test/);
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('the setup sample submits ordinary verified renders and shows failures without claiming acceptance', async () => {
  const p = page(), fixture = wizardFixture(async (path, options) => {
    if (path === '/api/v1/renders') { assert.deepEqual(options.body.verification, { profile: 'output-v1', widthPx: 100, heightPx: 100 }); return { id: 'rnd_fixture', state: 'failed', error: { message: 'Worker unavailable' } }; }
    if (path === '/api/v1/renders/rnd_fixture') return { id: 'rnd_fixture', state: 'failed', error: { message: 'Worker unavailable' } };
  });
  const editor = await createSetupWizard({ ...p.helpers, api: fixture.api }); p.main.append(editor.element);
  try {
    click(editor.element, '5. Sample output');
    const title = editor.element.querySelector('.setup-sample-result').parentElement.querySelector('input');
    title.value = 'Sample welcome';
    click(editor.element, 'Create checked sample'); await pause();
    assert.match(editor.element.textContent, /Worker unavailable/); assert.equal(editor.element.querySelector('[download]'), null);
    click(editor.element, '6. Finish setup'); assert.match(editor.element.textContent, /Checked sample: not completed/);
    assert.match(editor.element.textContent, /Real owner sign-in: not observed/);
    assert.equal(fixture.calls.find(call => call.path === '/api/v1/renders').body.inputs.title, 'Sample welcome');
  } finally { editor.dispose(); p.dom.window.close(); }
});

test('the Projects view restores an archived project and archives a live one', async () => {
  // The console is where an archived project is found again (the list route
  // hides it elsewhere), so restoring has to be possible from here too.
  const p = page(); const calls: any[] = [];
  p.w.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  const projects = [
    { id: 'prj_old', name: 'Old campaign', visibility: { groups: ['team-eng'] }, ownerId: 'u1', sessionCount: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', archivedAt: '2026-09-02T00:00:00Z' },
    { id: 'prj_live', name: 'Summit', visibility: 'private', ownerId: 'u1', sessionCount: 0, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  ];
  p.w.fetch = async (path: string, options: any = {}) => {
    calls.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const body = path === '/api/v1/projects?archived=1' ? { projects } : {};
    return { status: 200, ok: true, statusText: 'OK', json: async () => body };
  };
  try {
    await p.w.renderProjectList(p.main);
    const row = (name: string) => [...p.main.querySelectorAll('tr')].find((tr: any) => tr.textContent.includes(name));
    const button = (tr: any, text: string) => [...tr.querySelectorAll('button')].find((b: any) => b.textContent === text);
    assert.ok(!button(row('Old campaign'), 'Archive'), 'an archived row offers no Archive');
    button(row('Old campaign'), 'Restore').click(); await pause(); await pause();
    assert.deepEqual(calls.find((c) => c.method === 'PATCH'), { path: '/api/v1/projects/prj_old', method: 'PATCH', body: { archived: false } });

    calls.length = 0;
    const archive = button(row('Summit'), 'Archive');
    assert.ok(!button(row('Summit'), 'Restore'), 'a live row offers no Restore');
    archive.click(); await pause();
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, 'the first press only arms');
    archive.click(); await pause(); await pause();
    assert.deepEqual(calls.find((c) => c.method === 'PATCH'), { path: '/api/v1/projects/prj_live', method: 'PATCH', body: { archived: true } });
  } finally { p.dom.window.close(); }
});
