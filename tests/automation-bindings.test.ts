// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBindingRows } from '../server/src/automation/bindings.ts';

test('live JSON bindings become typed object rows through the provider seam', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
  const rows = await resolveBindingRows({ source: 'cms://products/current', as: schema }, async (ref) => ({ cacheKey: 'x', stages: [], sourceBytes: 2, outputBytes: 2, asset: { source: 'remote', id: ref.raw, type: 'raster', format: 'json', url: `data:application/json;base64,${Buffer.from('[{"name":"mug"}]').toString('base64')}` } }));
  assert.deepEqual(rows, [{ name: 'mug' }]);
  await assert.rejects(() => resolveBindingRows({ source: 'cms://products/current', as: schema }, async (ref) => ({ cacheKey: 'x', stages: [], sourceBytes: 2, outputBytes: 2, asset: { source: 'remote', id: ref.raw, type: 'raster', format: 'json', url: `data:application/json;base64,${Buffer.from('[{"other":"mug"}]').toString('base64')}` } })), /missing required field name/);
});

test('structured binding queries are forwarded and enforced over typed rows', async () => {
  let forwarded: Record<string, string> | undefined;
  const json = JSON.stringify([
    { name: 'Mug', active: true, product: { category: 'drinkware' } },
    { name: 'Poster', active: false, product: { category: 'print' } },
  ]);
  const rows = await resolveBindingRows({
    source: 'cms://products/current',
    query: { active: true, product: { category: 'drinkware' } },
  }, async (ref) => {
    forwarded = { ...ref.query };
    return { cacheKey: 'x', stages: [], sourceBytes: json.length, outputBytes: json.length, asset: { source: 'remote', id: ref.raw, type: 'raster', format: 'json', url: `data:application/json;base64,${Buffer.from(json).toString('base64')}` } };
  });
  assert.deepEqual(rows, [{ name: 'Mug', active: true, product: { category: 'drinkware' } }]);
  assert.deepEqual(forwarded, { active: 'true', product: '{"category":"drinkware"}' });
});

test('live CSV bindings preserve RFC 4180 quoted data', async () => {
  const csv = '\uFEFFname,caption\r\n"Mug, large","first line\r\nsecond ""quoted"" line"\r\n';
  const rows = await resolveBindingRows({ source: 'cms://products/current.csv' }, async (ref) => ({
    cacheKey: 'x', stages: [], sourceBytes: csv.length, outputBytes: csv.length,
    asset: { source: 'remote', id: ref.raw, type: 'raster', format: 'csv', url: `data:text/csv;base64,${Buffer.from(csv).toString('base64')}` },
  }));
  assert.deepEqual(rows, [{ name: 'Mug, large', caption: 'first line\r\nsecond "quoted" line' }]);
});

test('live CSV bindings reject ambiguous headers and malformed quotes', async () => {
  const fromCsv = (csv: string) => resolveBindingRows({ source: 'cms://products/current.csv' }, async (ref) => ({
    cacheKey: 'x', stages: [], sourceBytes: csv.length, outputBytes: csv.length,
    asset: { source: 'remote', id: ref.raw, type: 'raster', format: 'csv', url: `data:text/csv;base64,${Buffer.from(csv).toString('base64')}` },
  }));
  await assert.rejects(() => fromCsv('name,name\r\na,b\r\n'), /duplicate header name/);
  await assert.rejects(() => fromCsv('name\r\n"unfinished'), /unterminated quoted field/);
});
