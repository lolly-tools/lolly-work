// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRenderDeadline } from '../server/src/render/deadline.ts';
import { safeMessageUrl } from '../server/src/inbox/message-url.ts';

test('render deadlines cancel the underlying operation and return a typed timeout', async () => {
  let signal: AbortSignal | undefined;
  const alive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(withRenderDeadline(s => { signal = s; return new Promise(() => {}); }, 5), { code: 'RENDER_TIMEOUT', status: 504 });
    assert.equal(signal?.aborted, true);
  } finally { clearTimeout(alive); }
});

test('render deadlines preserve caller cancellation and successful results', async () => {
  assert.equal(await withRenderDeadline(async () => 12, 1000), 12);
  const caller = new AbortController(); caller.abort(new Error('cancelled'));
  await assert.rejects(withRenderDeadline(async () => 1, 1000, caller.signal), /cancelled/);
});

test('message destinations allow HTTP and instance paths', () => {
  for (const url of ['#/tools/card', '/tools/card', 'https://example.org/page', 'http://example.org/page']) assert.equal(safeMessageUrl(url), true);
  for (const url of ['javascript:alert(1)', 'data:text/plain,x', '//example.org/page', '/\\example.org', 'https://user:pass@example.org', ' https://example.org']) assert.equal(safeMessageUrl(url), false);
});
