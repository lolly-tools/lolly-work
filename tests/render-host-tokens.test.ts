/**
 * The render host (server/src/render/host.ts) as a HostV1 shell: it now carries
 * `tokens` (the pack's DTCG document through the engine's resolver), `color`
 * (the engine's perceptual maths) and `export.imprint` (identity, no rasteriser),
 * so a token-aware tool renders the same brand colours here as in the shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { withRenderHost } from '../server/src/render/host.ts';

const DEMO_PACK = resolve('packs/demo');

test('host.tokens resolves the demo pack brand document', async () => {
  await withRenderHost({ pack: DEMO_PACK, profile: {} }, async (_dom, host) => {
    assert.ok(host.tokens, 'demo pack ships a tokens asset, so host.tokens is present');
    const set = await host.tokens.get();
    assert.ok(set.size > 0, 'token set is not empty');
    const themes = await host.tokens.themes();
    assert.ok(Array.isArray(themes));
    const colors = await host.tokens.colors();
    assert.ok(colors.length > 0, 'brand colours are listed');
    const first = colors[0] as { ref: string };
    assert.notEqual(await host.tokens.resolve(first.ref), undefined, `resolve(${first.ref})`);
  });
});

test('host.color is the engine maths; host.export.imprint is the identity without a rasteriser', async () => {
  await withRenderHost({ pack: DEMO_PACK, profile: {} }, async (_dom, host) => {
    const color = host.color as { contrast: (a: string, b: string) => unknown };
    const c = color.contrast('#000000', '#ffffff');
    const n = typeof c === 'number' ? c : (c as { ratio: number }).ratio;
    assert.ok(Number.isFinite(n) && n > 1);
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(await host.export.imprint(bytes, 'png'), bytes);
  });
});

test('a pack without tokens has no host.tokens rather than an empty one', async () => {
  await withRenderHost({ pack: resolve('tests', 'fixtures-no-such-pack'), profile: {} }, async (_dom, host) => {
    assert.equal(host.tokens, undefined);
  });
});
