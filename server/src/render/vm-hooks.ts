/**
 * Hook executor for the in-process render path: runs a tool's `hooks.js` in a
 * `node:vm` context instead of the server's own realm.
 *
 * The engine's default executor compiles hooks with `new Function` in the
 * realm that called it - on this server that realm holds `process.env` (every
 * `LW_*` secret), the global `fetch` (the internal network) and `require`.
 * This executor gives hooks a context whose globals are the jsdom window the
 * render already owns plus the Web intrinsics, and nothing of Node's: no
 * `process`, no `require`, and a `fetch` that refuses with a pointer at
 * `host.assets` / `host.net`.
 *
 * What this is and is not. It removes AMBIENT authority, so a pack's hooks
 * cannot read secrets or reach the network by accident or by a casual grab.
 * `node:vm` is not a hardened sandbox: the `host` bridge and the DOM are
 * objects from the outer realm, and a hostile script that walks their
 * prototypes can reach the outer `Function` constructor. The Chromium worker
 * tier (`workers/render`) is the isolation boundary for packs you did not
 * curate; `render.allowHooksInFastPath` stays a curated-pack switch.
 */
import { createContext, runInContext } from 'node:vm';
import type { LoadedTool, RenderDom } from './contract.ts';

const SLOTS = ['onInit', 'onInput', 'onFrame', 'onLevel', 'beforeExport', 'afterExport', 'exportFile', 'exportStill'] as const;
type Slot = (typeof SLOTS)[number];
type HookFn = (...args: unknown[]) => unknown;
export type VmHooks = Record<Slot, HookFn | null>;

const refuseNetwork = (): Promise<never> =>
  Promise.reject(new Error('fetch is not available to hooks on the server render path - read assets through host.assets or host.net'));

const DOM_GLOBALS = [
  'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'NodeList', 'Text', 'DocumentFragment',
  'DOMParser', 'XMLSerializer', 'Image', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'navigator', 'location',
] as const;

export function createVmHookExecutor(dom: RenderDom): (tool: LoadedTool, host: unknown) => Promise<VmHooks> {
  return async (tool, host) => {
    const w = dom.window as unknown as Record<string, unknown>;
    const sandbox: Record<string, unknown> = {
      window: w,
      console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa, structuredClone,
      crypto: globalThis.crypto,
      Blob: globalThis.Blob,
      fetch: refuseNetwork,
    };
    for (const name of DOM_GLOBALS) if (name in w) sandbox[name] = w[name];
    sandbox['globalThis'] = sandbox;
    sandbox['self'] = sandbox;
    const context = createContext(sandbox, { name: `hooks:${tool.manifest.id}` });
    const source = `(function (host) { ${tool.hooksSource ?? ''}\n; return {` +
      SLOTS.map((s) => `${s}: typeof ${s} !== 'undefined' ? ${s} : null`).join(', ') +
      '}; })';
    const factory = runInContext(source, context, { filename: `${tool.manifest.id}/hooks.js`, timeout: 5000 }) as (host: unknown) => Record<string, unknown>;
    const mod = factory(host);
    const hooks = {} as VmHooks;
    for (const s of SLOTS) hooks[s] = typeof mod[s] === 'function' ? (mod[s] as HookFn) : null;
    return hooks;
  };
}
