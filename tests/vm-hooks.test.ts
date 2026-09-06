/**
 * The in-process hook executor (server/src/render/vm-hooks.ts): a pack's
 * hooks.js sees the render's DOM and the host bridge, and none of the server's
 * ambient authority - no process.env, no require, no working fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJsdom } from '../server/src/render/contract.ts';
import { createVmHookExecutor } from '../server/src/render/vm-hooks.ts';

async function run(hooksSource: string): Promise<Record<string, unknown>> {
  const { JSDOM } = await loadJsdom();
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="canvas"></div></body></html>');
  const executor = createVmHookExecutor(dom);
  const tool = { manifest: { id: 'probe', version: '1.0.0' }, hooksSource } as unknown as Parameters<typeof executor>[0];
  const host = { log: () => undefined, marker: 'host-bridge' };
  const hooks = await executor(tool, host);
  assert.ok(hooks.onInit, 'onInit compiled');
  // Values cross the vm boundary with the context's own prototypes; compare by value.
  return JSON.parse(JSON.stringify(await hooks.onInit({ model: [], host }))) as Record<string, unknown>;
}

test('hooks see the DOM and the host bridge', async () => {
  const out = await run(`
    function onInit({ host }) {
      const el = document.createElement('div');
      el.textContent = 'hi';
      return { tag: el.tagName, marker: host.marker, hasWindow: typeof window === 'object' };
    }
  `);
  assert.deepEqual(out, { tag: 'DIV', marker: 'host-bridge', hasWindow: true });
});

test('hooks see no process, no require, and a fetch that refuses', async () => {
  const out = await run(`
    async function onInit() {
      let fetched = 'no-throw';
      try { await fetch('http://169.254.169.254/'); } catch (e) { fetched = e.message; }
      return {
        process: typeof process,
        require: typeof require,
        env: typeof globalThis.process,
        fetched,
      };
    }
  `);
  assert.equal(out.process, 'undefined');
  assert.equal(out.require, 'undefined');
  assert.equal(out.env, 'undefined');
  assert.match(String(out.fetched), /not available to hooks/);
});

test('an undeclared slot is null, a declared one is callable', async () => {
  const { JSDOM } = await loadJsdom();
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const executor = createVmHookExecutor(dom);
  const tool = { manifest: { id: 'probe', version: '1.0.0' }, hooksSource: 'function beforeExport() { return { ok: 1 }; }' } as unknown as Parameters<typeof executor>[0];
  const hooks = await executor(tool, {});
  assert.equal(hooks.onInit, null);
  assert.equal(hooks.onFrame, null);
  assert.deepEqual(JSON.parse(JSON.stringify(hooks.beforeExport?.({}))), { ok: 1 });
});
