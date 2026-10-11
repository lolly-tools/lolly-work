// SPDX-License-Identifier: MPL-2.0
/** Real DOM fixtures and a hung reader qualify fixed, bounded failure metadata. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { captureRenderPagePhase, RENDER_PAGE_PHASE_SCRIPT } from './collab/render-page-phase.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: object) => {
  window: { eval(source: string): unknown; close(): void; __toolIndex?: unknown; document: { documentElement: { dataset: Record<string, string> } } };
} };

test('failure probe reads actual fixed DOM states without disclosing query, catalog values, text or storage', async () => {
  const dom = new JSDOM('<html data-webgpu="ready" data-catalog-trust="verified"><body><div id="view" class="tool-view"><p class="loading">private-output</p></div></body></html>', {
    url: 'http://127.0.0.1/t/qr-code?private-ticket#private-query', runScripts: 'outside-only',
  });
  try {
    dom.window.__toolIndex = { tools: [{ id: 'private-user-tool', title: 'private-output' }, { id: 'qr-code' }] };
    const report = await captureRenderPagePhase(async () => dom.window.eval(RENDER_PAGE_PHASE_SCRIPT));
    assert.equal(report.status, 'observed');
    assert.equal(report.webgpu, 'ready'); assert.equal(report.catalogTrust, 'verified'); assert.equal(report.route, 'qr-code');
    assert.equal(report.indexPresent, true); assert.equal(report.qrInIndex, true);
    assert.equal(report.loading, true); assert.equal(report.toolView, true); assert.equal(report.inputsMounted, false);
    assert.equal(report.signIn, false); assert.equal(report.errorAction, false); assert.equal(report.databaseUpdate, false);
    for (const secret of ['private-ticket', 'private-query', 'private-user-tool', 'private-output']) assert.ok(!JSON.stringify(report).includes(secret));
    dom.window.document.documentElement.dataset.webgpu = 'private-error';
    dom.window.document.documentElement.dataset.catalogTrust = 'private-error';
    const unknown = await captureRenderPagePhase(async () => dom.window.eval(RENDER_PAGE_PHASE_SCRIPT));
    assert.equal(unknown.webgpu, 'unknown'); assert.equal(unknown.catalogTrust, 'unknown');
    assert.ok(!JSON.stringify(unknown).includes('private-error'));
  } finally { dom.window.close(); }
});

test('probe distinguishes a real sign-in gate, recovery actions and an absent QR catalog', async () => {
  const dom = new JSDOM('<html><body><div id="view"><section class="org-gate"></section><div class="error"><button>private-error</button></div></div><div data-database-update-required="true"></div></body></html>', {
    url: 'http://127.0.0.1/private-user-path?private-ticket', runScripts: 'outside-only',
  });
  try {
    const report = await captureRenderPagePhase(async () => dom.window.eval(RENDER_PAGE_PHASE_SCRIPT));
    assert.equal(report.status, 'observed'); assert.equal(report.route, 'other');
    assert.equal(report.indexPresent, false); assert.equal(report.qrInIndex, false);
    assert.equal(report.signIn, true); assert.equal(report.errorAction, true); assert.equal(report.databaseUpdate, true);
    assert.ok(!JSON.stringify(report).includes('private-user-path'));
  } finally { dom.window.close(); }
});

test('failed or unavailable page readers never emit arbitrary errors or pretend observed states', async () => {
  assert.deepEqual(await captureRenderPagePhase(), { status: 'unavailable' });
  const rejected = await captureRenderPagePhase(async () => { throw new Error('private-browser-error'); });
  assert.equal(rejected.status, 'refused'); assert.ok(!JSON.stringify(rejected).includes('private-browser-error'));
  const malformed = await captureRenderPagePhase(async () => ({ indexPresent: 'private-value' }));
  assert.equal(malformed.status, 'refused'); assert.ok(!JSON.stringify(malformed).includes('private-value'));
});

test('a hung page probe returns at its separate 250ms diagnostic deadline', async () => {
  const report = await captureRenderPagePhase(() => new Promise(() => {}));
  assert.equal(report.status, 'deadline');
  assert.ok(report.elapsedMs! >= 240 && report.elapsedMs! < 1000, 'A reader that never resolves cannot delay failure cleanup indefinitely');
});
