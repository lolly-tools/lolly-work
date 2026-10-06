// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compareValues } from '../console/table-sort.js';
const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
function fixture() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { runScripts: 'outside-only' });
  const w = dom.window; w.compareValues = compareValues; w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.eval(`${source}\nwindow.helpers = {dataTable,el};`);
  const { dataTable, el } = w.helpers;
  const rows = Array.from({ length: 30 }, (_, i) => el('tr', {}, el('td', {}, `Entry ${i + 1}`), el('td', { 'data-sort': i + 1 }, `${i + 1} files`), el('td', {}, i % 2 ? 'Team' : 'Public'), el('td', {}, el('button', {}, 'Edit'))));
  const table = dataTable(['Name', { label: 'Size', num: true }, 'Visibility', 'Actions'], rows, { filter: true, paginate: true });
  w.document.body.append(table);
  return { dom, w, table };
}

test('card sorting stays in sync with headers, keeps numeric order, and resets pagination', () => {
  const { dom, w, table } = fixture();
  try {
    const sort = table.querySelector('[aria-label="Sort rows"]');
    assert.ok(![...sort.options].some((o: any) => o.textContent.includes('Actions')), 'actions are not data to sort');
    table.querySelector('.tbl-pager button:nth-child(2)').click();
    sort.value = '1:-1'; sort.dispatchEvent(new w.Event('change'));
    assert.equal(table.querySelector('tbody tr td').textContent, 'Entry 30');
    assert.equal(table.querySelectorAll('tbody tr').length, 25);
    assert.equal(table.querySelectorAll('th')[1].getAttribute('aria-sort'), 'descending');
    table.querySelectorAll('.col-sort')[0].click(); assert.equal(sort.value, '0:1');
    sort.value = ''; sort.dispatchEvent(new w.Event('change')); assert.equal(table.querySelector('tbody tr td').textContent, 'Entry 1');
    assert.equal(table.querySelector('.tbl-page-note').textContent, 'page 1 of 2');
  } finally { dom.window.close(); }
});

test('a search with no matches explains the result and clearing it restores data and focus', () => {
  const { dom, w, table } = fixture();
  try {
    const search = table.querySelector('[type=search]'); search.value = 'missing'; search.dispatchEvent(new w.Event('input'));
    assert.equal(table.querySelector('tbody strong').textContent, 'No matching rows');
    assert.equal(table.querySelector('.tbl-filter-count').textContent, '0 of 30');
    assert.equal(table.querySelector('tbody td').colSpan, 4);
    assert.equal(table.querySelector('.tbl-pager button:nth-child(2)').disabled, true);
    table.querySelector('tbody button').click();
    assert.equal(search.value, ''); assert.equal(w.document.activeElement, search);
    assert.equal(table.querySelectorAll('tbody tr').length, 25);
    assert.equal(table.querySelector('.tbl-clear').hidden, true);
  } finally { dom.window.close(); }
});

test('CSV uses filtered data and clean labels, excluding action buttons and sort carets', async () => {
  const { dom, w, table } = fixture();
  try {
    let blob: any;
    w.URL.createObjectURL = (value: any) => { blob = value; return 'blob:export'; };
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = () => {};
    const search = table.querySelector('[type=search]'); search.value = 'Entry 10'; search.dispatchEvent(new w.Event('input'));
    table.querySelector('.col-sort').click(); table.querySelector('.tbl-csv').click();
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
    });
    assert.equal(text.replace(/^\ufeff/, ''), 'Name,Size,Visibility\r\nEntry 10,10 files,Team');
  } finally { dom.window.close(); }
});
