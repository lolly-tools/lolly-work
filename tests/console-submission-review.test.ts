// SPDX-License-Identifier: MPL-2.0
/**
 * The console's review panel for a pending catalog submission, in jsdom: a video
 * or a sound plays in the panel from the fetched bytes, the way an export
 * review's file does, a picture keeps its thumbnail, a large file waits for a
 * click, and a file stored without its type (or one with no preview) shows its
 * placeholder without the table fetching its bytes for an <img>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { compareValues } from '../console/table-sort.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ready: () => unknown) => { for (let i = 0; i < 400 && !ready(); i++) await pause(5); assert.ok(ready(), 'the panel settled'); };

const submission = (over: Record<string, unknown> = {}) => ({
  id: 'inst/abc', name: 'Launch film', type: 'video', tags: [], formats: ['mp4'], groups: '*', state: 'submitted',
  by: 'user:u1', byName: 'Ana', at: '2026-11-12T00:00:00Z', size: 2048, checksum: 'c'.repeat(64),
  contentType: 'video/mp4', previewKind: 'video', relation: 'inbox', preview: '/api/v1/catalog/submissions/abc/bytes', ...over,
});

/** The bytes route as the console sees it: the type it answers with, the bytes,
 *  how long it takes, and whether an aborted request stops (a real fetch does;
 *  `ignoreAbort` stands for one whose body was already on its way). */
function page(served: { type?: string; body?: string; delay?: number; ignoreAbort?: boolean } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/catalog', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let minted = 0;
  const revoked: string[] = [];
  const blobTypes: string[] = [];
  w.URL.createObjectURL = (blob: Blob) => { blobTypes.push(blob.type); return `blob:file-${++minted}`; };
  w.URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const fetched: string[] = [];
  const signals: AbortSignal[] = [];
  const type = served.type ?? 'video/mp4';
  w.compareValues = compareValues;
  w.fetch = async (path: string, init: { signal?: AbortSignal } = {}) => {
    // The queue's own JSON reads, for the tests that build the whole card.
    const listed = /^\/api\/v1\/catalog\/submissions\?state=(\w*)/.exec(path);
    if (listed || path === '/api/v1/catalog/fields' || path === '/api/v1/catalog/collections') {
      const json = listed ? { submissions: listed[1] === 'submitted' ? [submission()] : [] } : { fields: [], collections: [] };
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => json };
    }
    fetched.push(path);
    if (init.signal) signals.push(init.signal);
    if (served.delay) await pause(served.delay);
    if (init.signal?.aborted && !served.ignoreAbort) throw new DOMException('The operation was aborted.', 'AbortError');
    return { ok: true, status: 200, headers: new Headers({ 'content-type': type }), blob: async () => new Blob([served.body ?? '\0\0\0\x18ftypisom'], { type }), json: async () => ({}) };
  };
  w.eval(`${source}; window.panel = (s) => renderSubmissionReview(s, document.getElementById('app'), null, [], null); window.queue = submissionQueue;`);
  return { w, fetched, revoked, blobTypes, signals, minted: () => minted, panel: (s: unknown) => w.panel(s), queue: () => w.queue(), close: () => dom.window.close() };
}

test('a pending video plays in the panel from its fetched bytes', async () => {
  const p = page();
  const node = p.panel(submission());
  await until(() => node.querySelector('.sub-file-stage video'));
  const video = node.querySelector('.sub-file-stage video');
  assert.equal(video.getAttribute('src'), 'blob:file-1');
  assert.equal(video.hasAttribute('controls'), true);
  assert.equal(video.getAttribute('aria-label'), 'Video submitted as Launch film');
  assert.deepEqual(p.fetched, ['/api/v1/catalog/submissions/abc/bytes']);
  assert.equal(node.querySelector('.cat-thumb'), null, 'the player takes the thumbnail\'s place');
  assert.match(node.textContent, /video\/mp4/);
  p.close();
});

test('a pending sound gets an audio player', async () => {
  const p = page({ type: 'audio/mpeg' });
  const node = p.panel(submission({ name: 'Sting', contentType: 'audio/mpeg', previewKind: 'audio', formats: ['mp3'] }));
  await until(() => node.querySelector('.sub-file-stage audio'));
  assert.equal(node.querySelector('.sub-file-stage audio').getAttribute('aria-label'), 'Sound submitted as Sting');
  assert.equal(node.querySelector('video'), null);
  p.close();
});

const pdfSubmission = submission({ contentType: 'application/pdf', previewKind: 'document', formats: ['pdf'] });

test('a PDF opens from a link to a blob typed as a PDF, and a picture keeps its thumbnail with no player', async () => {
  const p = page({ type: 'application/pdf', body: '%PDF-1.7\n%%EOF' });
  const pdf = p.panel(pdfSubmission);
  await until(() => pdf.querySelector('.sub-file-stage a'));
  assert.equal(pdf.querySelector('.sub-file-stage a').textContent, 'Open the PDF in a new tab');
  assert.deepEqual(p.blobTypes, ['application/pdf']);

  const q = page();
  const picture = q.panel(submission({ contentType: 'image/png', previewKind: 'image', formats: ['png'] }));
  await pause(20);
  assert.equal(picture.querySelector('.sub-file-stage'), null);
  assert.equal(picture.querySelector('.cat-thumb img').getAttribute('src'), '/api/v1/catalog/submissions/abc/bytes');
  assert.deepEqual(q.fetched, [], 'the thumbnail is the <img>, not a fetch');
  p.close(); q.close();
});

test('bytes that are no longer a PDF are never opened as a blob: an SVG, or a PDF type over other bytes', async () => {
  // A published PDF replaced by an SVG: the submission still records a PDF, and
  // the bytes route answers with what the asset holds now.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script href="/admin/app.js"/></svg>';
  for (const served of [{ type: 'image/svg+xml', body: svg }, { type: 'application/pdf', body: svg }, { type: 'text/html', body: '%PDF-1.7' }]) {
    const p = page(served);
    const node = p.panel(pdfSubmission);
    await until(() => node.querySelector('.sub-file-stage [role="alert"]'));
    assert.match(node.querySelector('.sub-file-stage').textContent, /no longer the kind it was submitted as/, served.type);
    assert.equal(node.querySelector('.sub-file-stage a'), null, `${served.type}: no link`);
    assert.equal(p.minted(), 0, `${served.type}: no blob URL is made`);
    p.close();
  }
});

test('a video whose bytes are now another kind of file gets no player', async () => {
  const p = page({ type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  const node = p.panel(submission());
  await until(() => node.querySelector('.sub-file-stage [role="alert"]'));
  assert.equal(node.querySelector('video'), null);
  assert.equal(p.minted(), 0);
  p.close();
});

test('a large video waits for a click before its bytes are fetched', async () => {
  const p = page();
  const node = p.panel(submission({ size: 40 * 1024 * 1024 }));
  await pause(20);
  const load = node.querySelector('.sub-file-stage button');
  assert.equal(load.textContent, 'Load the file (40 MB)');
  assert.deepEqual(p.fetched, []);
  load.click();
  await until(() => node.querySelector('.sub-file-stage video'));
  assert.equal(p.fetched.length, 1);
  p.close();
});

test('bytes stored without their type, or with no preview, show the placeholder and are never fetched as an image', async () => {
  const p = page();
  const old = p.panel(submission({ contentType: 'application/octet-stream', previewKind: 'none', type: 'image' }));
  await pause(20);
  assert.equal(old.querySelector('.sub-file-stage'), null);
  assert.equal(old.querySelector('.cat-thumb img'), null, 'no <img> asks for a video');
  assert.equal(old.querySelector('.cat-thumb-ext').textContent, 'mp4', 'the placeholder names the stored format');
  assert.deepEqual(p.fetched, []);
  const zip = p.panel(submission({ contentType: 'application/zip', previewKind: 'archive', formats: ['zip'] }));
  await pause(20);
  assert.equal(zip.querySelector('.cat-thumb-ext').textContent, 'zip');
  assert.deepEqual(p.fetched, []);
  p.close();
});

test('opening another submission releases the last one\'s file', async () => {
  const p = page();
  const first = p.panel(submission());
  await until(() => first.querySelector('.sub-file-stage video'));
  p.panel(submission({ id: 'inst/def', name: 'Sting', previewKind: 'audio', contentType: 'audio/mpeg' }));
  assert.deepEqual(p.revoked, ['blob:file-1']);
  p.close();
});

test('closing the panel while the file loads aborts the load and keeps nothing', async () => {
  for (const ignoreAbort of [false, true]) {
    const p = page({ delay: 200, ignoreAbort });
    const node = p.panel(submission());
    const close = [...node.querySelectorAll('button')].find((b: any) => b.textContent === 'Close') as any;
    close.click();
    assert.equal(p.signals[0]?.aborted, true, 'the request is aborted');
    await pause(300);
    assert.equal(p.minted(), 0, `${ignoreAbort ? 'a body that arrived anyway' : 'an aborted request'}: no blob URL is made`);
    assert.equal(node.querySelector('video'), null);
    p.close();
  }
});

test('changing which submissions are listed while a file loads aborts the load, and releases one already loaded', async () => {
  // A load still running when the list changes.
  const p = page({ delay: 200 });
  const card = await p.queue();
  p.w.document.getElementById('app').append(card);
  const review = [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'Review') as any;
  review.click();
  assert.ok(card.querySelector('.sub-file-stage'), 'the panel opened and its file is loading');
  const which = card.querySelector('select[aria-label="Which submissions to list"]');
  which.value = 'returned';
  which.dispatchEvent(new p.w.Event('change'));
  assert.equal(p.signals[0]?.aborted, true, 'the request is aborted');
  await pause(300);
  assert.equal(card.querySelector('.sub-file-stage'), null, 'the panel is gone');
  assert.equal(p.minted(), 0, 'no blob URL is made');
  p.close();

  // A file already loaded when the list changes.
  const q = page();
  const loaded = await q.queue();
  q.w.document.getElementById('app').append(loaded);
  ([...loaded.querySelectorAll('button')].find((b: any) => b.textContent === 'Review') as any).click();
  await until(() => loaded.querySelector('.sub-file-stage video'));
  const list = loaded.querySelector('select[aria-label="Which submissions to list"]');
  list.value = 'live';
  list.dispatchEvent(new q.w.Event('change'));
  assert.deepEqual(q.revoked, ['blob:file-1']);
  q.close();
});
