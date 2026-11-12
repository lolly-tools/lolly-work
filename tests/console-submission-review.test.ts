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

function page() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/catalog', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let minted = 0;
  const revoked: string[] = [];
  w.URL.createObjectURL = () => `blob:file-${++minted}`;
  w.URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const fetched: string[] = [];
  w.fetch = async (path: string) => {
    fetched.push(path);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'video/mp4' }), blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), json: async () => ({}) };
  };
  w.eval(`${source}; window.panel = (s) => renderSubmissionReview(s, document.getElementById('app'), null, [], null);`);
  return { w, fetched, revoked, panel: (s: unknown) => w.panel(s), close: () => dom.window.close() };
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
  const p = page();
  const node = p.panel(submission({ name: 'Sting', contentType: 'audio/mpeg', previewKind: 'audio', formats: ['mp3'] }));
  await until(() => node.querySelector('.sub-file-stage audio'));
  assert.equal(node.querySelector('.sub-file-stage audio').getAttribute('aria-label'), 'Sound submitted as Sting');
  assert.equal(node.querySelector('video'), null);
  p.close();
});

test('a PDF opens from a link, and a picture keeps its thumbnail with no player', async () => {
  const p = page();
  const pdf = p.panel(submission({ contentType: 'application/pdf', previewKind: 'document', formats: ['pdf'] }));
  await until(() => pdf.querySelector('.sub-file-stage a'));
  assert.equal(pdf.querySelector('.sub-file-stage a').textContent, 'Open the PDF in a new tab');

  const q = page();
  const picture = q.panel(submission({ contentType: 'image/png', previewKind: 'image', formats: ['png'] }));
  await pause(20);
  assert.equal(picture.querySelector('.sub-file-stage'), null);
  assert.equal(picture.querySelector('.cat-thumb img').getAttribute('src'), '/api/v1/catalog/submissions/abc/bytes');
  assert.deepEqual(q.fetched, [], 'the thumbnail is the <img>, not a fetch');
  p.close(); q.close();
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
