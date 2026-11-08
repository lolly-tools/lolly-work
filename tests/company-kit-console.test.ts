// SPDX-License-Identifier: MPL-2.0
/** The partner kit card, using the console's real DOM helpers and confirm button. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { KIT_LIMITS } from '../server/src/programmes/kit-routes.ts';
import { PROFILE_LIMITS } from '../server/src/programmes/profile-routes.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const base = '/api/v1/programmes/resellers/companies/northwind/kit';
const company = { id: 'northwind', name: 'Northwind IT' };
const kit = () => ({ schemaVersion: 1, id: company.id, label: company.name,
  colours: [{ name: 'Northwind blue', role: 'primary', value: '#0b3d91' }, { name: 'Paper', role: 'surface', value: '#ffffff' }],
  logos: { light: { id: 'inst/logo-light', version: 2 }, dark: { id: 'inst/logo-dark', version: 1 }, mark: { id: 'inst/mark', version: 3 } },
  source: { kind: 'tokens', reference: 'northwind-tokens.json' } });
const saved = () => ({ kit: kit(), revision: 2, source: kit().source, assetId: 'inst/kit' });
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function harness(initial: Record<string, any> = {}, settings: Record<string, any> = {}, limits: any = KIT_LIMITS, chains: any[] = [{ id: 'brand', name: 'Brand review' }]) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin', runScripts: 'outside-only' });
  const w = dom.window, doc = w.document;
  w.requestAnimationFrame = (fn: () => void) => { fn(); return 0; };
  let data = { kit: null, ...copy(initial), limits: copy(limits) };
  let policy = { kitApprovalChain: null, ...settings };
  let importError = '';
  let readError = false;
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const response = (status: number, body: any) => ({ ok: status < 400, status, json: async () => copy(body) });
  w.fetch = async (path: string, options: any = {}) => {
    const method = options.method ?? 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({ path, method, body });
    if (path.includes('/import?')) return importError ? response(422, { error: { message: importError } }) : response(200, { kit: kit(), warnings: [], limits });
    if (path.endsWith('/settings')) {
      policy = { ...policy, ...body };
      return response(200, { settings: policy });
    }
    if (path.endsWith('/profile')) return response(200, { company, revision: 0, profile: {}, logos: {}, settings: policy, limits: PROFILE_LIMITS });
    if (path.endsWith('/people')) return response(200, { people: [] });
    if (path === '/api/v1/chains') return response(200, { chains });
    assert.equal(path, base);
    if (method === 'GET') {
      if (readError) return response(503, { error: { code: 'UNAVAILABLE', message: 'Kit storage is unavailable.' } });
      return !data.kit && !data.pending ? response(404, { error: { code: 'NOT_FOUND', message: 'this company has no kit' }, limits }) : response(200, data);
    }
    if (policy.kitApprovalChain) {
      data = { ...data, pending: { approvalId: 'apr_kit', action: method === 'DELETE' ? 'remove' : 'save' } };
      return response(202, { pending: { approvalId: 'apr_kit' } });
    }
    data = method === 'DELETE' ? { kit: null, limits } : { kit: body, revision: (data.revision ?? 0) + 1, source: body.source, limits };
    return response(200, data);
  };
  w.eval(`${source}; window.kitHelpers = { companyKitCard, readCompanyKit, companyPage };`);
  const card = w.kitHelpers.companyKitCard(base, company, data, policy, chains);
  doc.getElementById('app').append(card);
  return { w, doc, card, calls, helpers: w.kitHelpers,
    button: (text: string) => [...card.querySelectorAll('button')].find((b: any) => b.textContent === text) as any,
    input: (name: string) => card.querySelector(`[aria-label="${name}"]`) as any,
    importError: (message: string) => { importError = message; }, readError: (on: boolean) => { readError = on; },
    close: () => dom.window.close() };
}

test('the empty card explains the kit, reads every bound and keeps approval off', async () => {
  const limits = { ...KIT_LIMITS, maxColours: 7, maxBytes: 32768, maxColourName: 51, maxLabel: 99, maxSourceReference: 111,
    maxAssetId: 150, maxLogoVersion: 123, maxSkills: 9, maxClearSpace: 3, maxMinPx: 900, maxMinMm: 90,
    imports: { tokensMaxBytes: 1024, lollyMaxBytes: 2048, designSystemMaxBytes: 3072, tokensMaxParts: 18, svgMaxBytes: 4096 } };
  const h = harness({}, {}, limits);
  try {
    assert.match(h.card.textContent, /logos, colours and placement rules, offered to the company’s people and checked in Design/);
    assert.match(h.card.textContent, /No kit yet/);
    for (const text of ['7 colours, 32 KB', '51 characters', '99 characters', '111 characters', '150 characters', '1 to 123', 'up to 9', '3 mark heights', '900 px and 90 mm', '1.0 KB', '2.0 KB', '3.0 KB', '18 JSON parts', '4.0 KB per logo']) assert.ok(h.card.textContent.includes(text), text);
    assert.match(h.card.textContent, /Lolly does not know the partner’s rules/);
    assert.match(h.card.textContent, /Partner kit: Northwind IT · revision <n>/);
    assert.equal(h.card.querySelector('input[type=checkbox]').checked, false);
    assert.equal(h.button('Save'), undefined);
    assert.equal(h.card.querySelector('select').parentElement.parentElement.hidden, true);
    const empty = await h.helpers.readCompanyKit(base);
    assert.equal(empty.kit, null);
    assert.deepEqual(copy(empty.limits), limits);
    const noChains = harness({}, {}, KIT_LIMITS, []);
    try { assert.equal(noChains.card.querySelector('input[type=checkbox]').disabled, true); }
    finally { noChains.close(); }
  } finally { h.close(); }
});

test('making from logos is a proposal with editable colours, read-only pins and no rule defaults', async () => {
  const h = harness();
  try {
    assert.match(h.card.textContent, /Colours come only from SVG logos/);
    h.button('Make from the logos').click(); await settle();
    assert.equal(h.calls[0]!.path, `${base}/import?from=logos`);
    assert.equal(h.calls[0]!.method, 'POST');
    assert.ok(h.card.textContent.includes('Proposal'));
    assert.equal(h.calls.some((c) => c.method === 'PUT'), false);
    assert.deepEqual([...h.card.querySelectorAll('input[type=number]')].map((n: any) => n.value), ['', '', '']);
    assert.equal(h.card.querySelector('[aria-label="Allowed treatments"] input:checked'), null);
    assert.equal(h.input('Name for #0b3d91').maxLength, KIT_LIMITS.maxColourName);
    assert.equal(h.input('Kit label').maxLength, KIT_LIMITS.maxLabel);
    assert.deepEqual([...h.input('Role for #0b3d91').options].map((o: any) => o.value), [...KIT_LIMITS.colourRoles]);
    assert.match(h.card.textContent, /light: inst\/logo-light · version 2dark: inst\/logo-dark · version 1mark: inst\/mark · version 3/);
    assert.equal(h.card.querySelectorAll('input[value^="inst/"]').length, 0);
    h.input('Name for #0b3d91').value = 'Partner blue';
    h.input('Role for #0b3d91').value = 'accent';
    h.input('Remove Paper').click();
    h.button('Save').click(); await settle();
    const save = h.calls.find((c) => c.method === 'PUT')!;
    assert.equal('rules' in save.body, false);
    assert.deepEqual(save.body.colours, [{ name: 'Partner blue', role: 'accent', value: '#0b3d91' }]);
    assert.deepEqual(save.body.logos, kit().logos);
    assert.match(h.card.textContent, /Revision 1 · from northwind-tokens.json/);
    assert.equal(h.card.querySelector('h3')?.textContent, 'Colours');
  } finally { h.close(); }
});

test('file input and drop both import raw files, choose the format and leave saving to the person', async () => {
  const h = harness();
  try {
    const input = h.card.querySelector('input[type=file]');
    assert.match(input.accept, /\.json,\.zip,\.lolly/);
    const tokens = new h.w.File(['{}'], 'northwind-tokens.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [tokens] });
    input.dispatchEvent(new h.w.Event('change')); await settle();
    assert.equal(h.calls[0]!.path, `${base}/import?from=tokens&name=northwind-tokens.json`);
    assert.equal(h.calls[0]!.body, tokens);
    h.button('Cancel proposal').click();
    const file = new h.w.File(['share'], 'northwind.LOLLY');
    const drop = h.card.querySelector('.verify-drop');
    const event = new h.w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    drop.dispatchEvent(event); await settle();
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.calls[1]!.path, `${base}/import?from=lolly&name=northwind.LOLLY`);
    assert.equal(h.calls[1]!.body, file);
    assert.equal(h.calls.some((c) => c.method === 'PUT'), false);
  } finally { h.close(); }
});

test('a saved kit shows its revision, saves explicit rule units and can clear every rule', async () => {
  const h = harness(saved());
  try {
    assert.match(h.card.textContent, /Revision 2 · from northwind-tokens.json/);
    assert.match(h.card.textContent, /Partner kit: Northwind IT · revision 2/);
    h.input('Clear space').value = '0.5';
    h.input('Minimum size in px').value = '40';
    h.input('Minimum size in mm').value = '10.5';
    const ticks = h.card.querySelectorAll('[aria-label="Allowed treatments"] input');
    ticks[0].click(); ticks[3].click();
    h.button('Save').click(); await settle();
    assert.deepEqual(h.calls.find((c) => c.method === 'PUT')!.body.rules, { clearSpace: { value: 0.5, unit: 'mark-height' }, minSize: { px: 40, mm: 10.5 }, treatments: ['colour', 'on-photo'] });
    assert.match(h.card.textContent, /Revision 3/);
    for (const n of h.card.querySelectorAll('input[type=number]')) n.value = '';
    for (const tick of h.card.querySelectorAll('[aria-label="Allowed treatments"] input:checked')) tick.click();
    h.button('Save').click(); await settle();
    assert.equal('rules' in h.calls.filter((c) => c.method === 'PUT').at(-1)!.body, false);
    assert.match(h.card.textContent, /Revision 4/);
    assert.match(h.card.textContent, /Lolly does not know the partner’s rules/);
  } finally { h.close(); }
});

test('partial rules omit blank fields and zero is refused without sending a save', async () => {
  const h = harness(saved());
  try {
    h.input('Clear space').value = '0';
    h.card.querySelector('form').dispatchEvent(new h.w.Event('submit', { cancelable: true })); await settle();
    assert.match(h.card.textContent, /Clear space must be above 0/);
    assert.equal(h.calls.length, 0);
    h.input('Clear space').value = '';
    h.input('Minimum size in mm').value = '6';
    h.button('Save').click(); await settle();
    assert.deepEqual(h.calls.find((c) => c.method === 'PUT')!.body.rules, { minSize: { mm: 6 } });
  } finally { h.close(); }
});

test('approval settings send only the kit chain and a save displays the pending request', async () => {
  const h = harness(saved(), { approvalChain: 'contact-review', editors: ['rita'] });
  try {
    h.input('Name for #0b3d91').value = 'Edited before the switch';
    const toggle = [...h.card.querySelectorAll('label.chk')].find((n: any) => n.textContent.includes('Kit changes need approval')).querySelector('input');
    toggle.click();
    assert.equal(h.input('Kit approval chain').parentElement.parentElement.hidden, false);
    h.button('Save approval setting').click(); await settle();
    assert.deepEqual(h.calls[0]!.body, { kitApprovalChain: 'brand' });
    assert.equal(h.calls[0]!.path, base.replace(/\/kit$/, '/profile/settings'));
    assert.equal(h.input('Name for #0b3d91').value, 'Edited before the switch', 'saving the switch keeps the kit edits');
    assert.match(h.card.textContent, /Save and Remove submit a change that waits for approval/);
    h.button('Save').click(); await settle();
    assert.equal(h.calls.find((c) => c.path === base && c.method === 'PUT')!.body.colours[0].name, 'Edited before the switch');
    assert.match(h.card.textContent, /kit save is waiting for approval/);
    assert.equal(h.card.querySelector('a').getAttribute('href'), '#/approvals');
    assert.match(h.card.querySelector('a').textContent, /apr_kit/);
    assert.equal(h.button('Save').disabled, true);
    assert.equal(h.card.querySelector('button.danger').disabled, true);
    assert.equal(h.button('Make from the logos'), undefined);
    assert.match(h.card.textContent, /Revision 2/, 'the live revision remains while waiting');
  } finally { h.close(); }
});

test('a pending first save shows its request without offering a second save', () => {
  const h = harness({ pending: { action: 'save', approvalId: 'apr_first' } }, { kitApprovalChain: 'brand' });
  try {
    assert.match(h.card.textContent, /kit save is waiting for approval/);
    assert.match(h.card.textContent, /apr_first/);
    assert.equal(h.button('Save'), undefined);
    assert.equal(h.card.querySelector('input[type=file]'), null);
  } finally { h.close(); }
});

test('removal uses the existing confirm pattern, with Escape to cancel, and supports pending removal', async () => {
  for (const waits of [false, true]) {
    const h = harness(saved(), { kitApprovalChain: waits ? 'brand' : null });
    try {
      const remove = h.card.querySelector('button.danger');
      remove.click();
      assert.equal(remove.textContent, 'Really remove?');
      assert.equal(h.calls.length, 0);
      remove.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(remove.textContent, 'Remove');
      remove.click(); remove.click(); await settle();
      assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 1);
      assert.match(h.card.textContent, waits ? /kit removal is waiting for approval/ : /No kit yet/);
    } finally { h.close(); }
  }
});

test('failed imports keep the saved kit editable and oversized files are refused using response limits', async () => {
  const h = harness(saved());
  try {
    h.importError('This source has no token document.');
    h.button('Make from the logos').click(); await settle();
    assert.match(h.card.textContent, /This source has no token document/);
    assert.equal(h.button('Save').disabled, false);
    assert.match(h.card.textContent, /Revision 2/);
    const input = h.card.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: [{ name: 'big.json', size: KIT_LIMITS.imports.tokensMaxBytes + 1 }] });
    input.dispatchEvent(new h.w.Event('change')); await settle();
    assert.match(h.card.textContent, /This import can be up to 2.0 MB/);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test('the company page includes the card and does not turn a storage error into an empty kit', async () => {
  const h = harness();
  try {
    h.readError(true);
    const main = h.doc.getElementById('app'); main.replaceChildren();
    await h.helpers.companyPage({ id: 'resellers', name: 'Resellers' }, company.id, main);
    const card = main.querySelector('.company-kit');
    assert.ok(card);
    assert.match(card.textContent, /Kit storage is unavailable/);
    assert.doesNotMatch(card.textContent, /No kit yet/);
    h.readError(false);
    card.querySelector('button').click(); await settle();
    assert.match(card.textContent, /No kit yet/);
  } finally { h.close(); }
});
