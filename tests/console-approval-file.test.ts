// SPDX-License-Identifier: MPL-2.0
/**
 * The console's approval card for an export review, in jsdom: a reviewer's Approve
 * stays off until the file has loaded and its digest checked, the decision carries
 * the fingerprint and the token that came with the bytes, and the requester sees
 * only facts until the request is approved. An older request says it has no file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ready: () => unknown) => { for (let i = 0; i < 400 && !ready(); i++) await pause(5); assert.ok(ready(), 'the panel settled'); };

const BYTES = Buffer.from('reviewed bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const file = (over: Record<string, unknown> = {}) => ({
  apiVersion: 'work/export-review-v1', sha256: SHA, size: BYTES.length, name: 'card.png', format: 'png', mediaType: 'image/png', preview: 'image',
  toolId: 'qr-code', toolVersion: '2.0.0', inputsDigest: 'd'.repeat(64), widthPx: 800, heightPx: 600, fingerprint: 'fp', origin: 'member-session',
  frozenAt: '2026-11-05T00:00:00Z', artifactUrl: '/api/v1/approvals/apr_1/artifact', ...over,
});
const approval = (over: Record<string, unknown> = {}) => ({
  id: 'apr_1', subjectType: 'export-review', subjectRef: 'export-review:fp', title: 'Launch card', chainId: 'brand', chainName: 'Brand', state: 'in_review', stepIndex: 0,
  stepCount: 1, stepName: 'Review', stepRule: 'any', steps: [{ name: 'Review', rule: 'any', groups: ['review'] }], nominees: [], nomineeNames: [], actions: [],
  createdBy: 'u1', createdByName: 'Ana', createdAt: '2026-11-05T00:00:00Z', mine: false, relation: 'inbox', exportReview: file(), ...over,
});

function page(artifact: { status?: number; bytes?: Buffer; token?: string | null } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/approvals', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  w.URL.createObjectURL = () => 'blob:artifact';
  w.URL.revokeObjectURL = () => {};
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ path, method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (path.endsWith('/artifact')) {
      const bytes = artifact.bytes ?? BYTES;
      return { ok: (artifact.status ?? 200) < 400, status: artifact.status ?? 200,
        headers: new Headers(artifact.token === null ? {} : { 'x-lolly-review-token': artifact.token ?? 'tok' }),
        blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  w.eval(`${source}; window.card = renderApprovalCard;`);
  const render = (a: unknown, actionable: boolean) => w.card(a, { actionable });
  const approve = (node: any) => [...node.querySelectorAll('button')].find((b: any) => b.textContent === 'Approve') as any;
  return { w, calls, render, approve, close: () => dom.window.close() };
}

test('a reviewer approves only after the file has loaded, and the decision carries what came with it', async () => {
  const p = page();
  const node = p.render(approval(), true);
  assert.doesNotMatch(node.textContent, /export-review:fp/, 'the digest on the facts line says it plainly');
  assert.equal(p.approve(node).disabled, true, 'off until the bytes arrive');
  await until(() => !p.approve(node).disabled);
  assert.equal(node.querySelector('.appr-file-stage img').getAttribute('src'), 'blob:artifact');
  assert.equal(node.querySelector('.appr-file-stage img').getAttribute('alt'), 'File for Launch card');
  assert.match(node.textContent, /PNG · 800 × 600 · 14 B · qr-code 2\.0\.0/);
  assert.match(node.textContent, /Digest checked\./);
  assert.equal(p.approve(node).disabled, false);
  p.approve(node).click();
  await pause();
  const act = p.calls.find(c => c.path.endsWith('/act'))!;
  assert.deepEqual(act.body, { action: 'approve', artifactFingerprint: 'fp', reviewToken: 'tok' });
  p.close();
});

test('bytes that do not match the record leave Approve off and say so', async () => {
  const p = page({ bytes: Buffer.from('other bytes') });
  const node = p.render(approval(), true);
  await until(() => /does not match/.test(node.textContent));
  assert.equal(p.approve(node).disabled, true);
  assert.match(node.textContent, /does not match its recorded digest/);
  assert.equal(node.querySelector('.appr-file-stage img'), null);
  p.close();
});

test('a large file waits for a click', async () => {
  const p = page();
  const node = p.render(approval({ exportReview: file({ size: 40 * 1024 * 1024 }) }), true);
  await pause(20);
  assert.equal(p.calls.filter(c => c.path.endsWith('/artifact')).length, 0);
  assert.equal(p.approve(node).disabled, true);
  ([...node.querySelectorAll('button')].find((b: any) => b.textContent.startsWith('Load the file')) as any).click();
  await until(() => !p.approve(node).disabled);
  assert.equal(p.calls.filter(c => c.path.endsWith('/artifact')).length, 1);
  p.close();
});

test('the requester sees facts until approved, then gets the file; a closed request says why', async () => {
  const p = page({ token: null });
  const mine = { mine: true, relation: 'mine' };
  const waiting = p.render(approval(mine), false);
  await pause(10);
  assert.equal(p.calls.filter(c => c.path.endsWith('/artifact')).length, 0, 'no fetch before a decision');
  assert.match(waiting.textContent, /Reviewers see this file\. It is released to you once approved\./);
  assert.match(waiting.textContent, new RegExp(`SHA-256 ${SHA.slice(0, 12)}`));
  const rejected = p.render(approval({ ...mine, state: 'rejected' }), false);
  await pause(10);
  assert.equal(p.calls.filter(c => c.path.endsWith('/artifact')).length, 0);
  assert.match(rejected.textContent, /rejected, so the file is not released/);
  const withdrawn = p.render(approval({ ...mine, state: 'withdrawn', exportReview: file({ removedAt: '2026-11-05T01:00:00Z', removedBecause: 'withdrawn' }) }), false);
  assert.match(withdrawn.textContent, /withdrawn, so its file was removed/);
  const approved = p.render(approval({ ...mine, state: 'approved' }), false);
  await until(() => [...approved.querySelectorAll('a')].length);
  assert.equal(p.calls.filter(c => c.path.endsWith('/artifact')).length, 1);
  const link = [...approved.querySelectorAll('a')].find((a: any) => a.textContent === 'Download approved file') as any;
  assert.equal(link.getAttribute('download'), 'card.png');
  p.close();
});

test('an older request says no file is attached; a catalog submission does not', () => {
  const p = page();
  const legacy = p.render(approval({ subjectType: 'asset', subjectRef: 'tool:qr-code', exportReview: undefined }), true);
  assert.match(legacy.textContent, /No file is attached to this request\./);
  assert.equal(p.approve(legacy).disabled, false, 'still decidable, as before');
  const submission = p.render(approval({ subjectType: 'asset', subjectRef: 'inst/hero', exportReview: undefined }), true);
  assert.doesNotMatch(submission.textContent, /No file is attached/);
  p.close();
});

test('the card says what approving does to the file, and "recorded" only after the server confirmed it', async () => {
  const p = page();
  const text = (a: unknown, actionable = true) => (p.render(a, actionable).querySelector('.appr-file-facts')?.textContent ?? '') as string;
  assert.match(text(approval({ exportReview: file({ recordInCredentials: true }) })), /If approved, the file's Content Credentials record the approval id, the date and this digest/);
  assert.match(text(approval({ exportReview: file({ recordInCredentials: false }) })), /The requester chose not to record this approval/);
  assert.doesNotMatch(text(approval()), /Content Credentials/, 'nothing is promised where nothing was offered');

  const approved = (record: unknown) => approval({ state: 'approved', relation: 'mine', mine: true, exportReview: file({ recordInCredentials: true, credentialRecord: record }) });
  const done = text(approved({ state: 'recorded', sha256: 'e'.repeat(64), size: 99, settledAt: 'x' }), false);
  assert.match(done, /recorded in this file's Content Credentials/);
  assert.match(done, /Reviewed SHA-256/);
  assert.match(done, /Approved file SHA-256 eeeeeeeeeeee/);
  for (const [reason, words] of [['no-signing-identity', /no signing identity/], ['no-route', /format cannot carry/], ['no-credential', /no Content Credentials to update/], ['opted-out', /chose not to record/], ['engine-unsupported', /cannot record approvals in files yet/]] as const) {
    const line = text(approved({ state: 'not-recorded', reason, settledAt: 'x' }), false);
    assert.match(line, words);
    assert.match(line, /The approved file is the file as reviewed/);
    assert.doesNotMatch(line, /recorded in this file/, 'never claims a recording');
  }
  p.close();
});
