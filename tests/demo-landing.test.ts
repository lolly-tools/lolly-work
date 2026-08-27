// SPDX-License-Identifier: MPL-2.0
/**
 * The public sandbox landing page (lib/demo-landing.ts) may only advertise
 * render examples an ANONYMOUS visitor can actually open. The demo overlays
 * (scripts/demo.ts) lock qr-code's `color` and hide its `background` for every
 * group but brand-team, so an example naming either dies as a 422 on the live
 * page - the exact regression that shipped once. Each example's params must
 * also be real inputs from the tool's manifest in packs/demo, so the page
 * cannot drift from the pack it demonstrates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RENDER_GROUPS, demoLandingHtml } from '../server/src/lib/demo-landing.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
import { checkParams } from '../server/src/policy/overlay.ts';
import { demoOverlays } from '../scripts/demo.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Render-plane params the GET endpoint accepts for any tool, beyond the
// tool.json inputs (raster sizing).
const RENDER_PLANE = new Set(['width', 'height']);

test('every landing render example passes anonymous policy', () => {
  const overlays = new Map(demoOverlays().map((o) => [o.toolId, o]));
  for (const group of RENDER_GROUPS) {
    for (const e of group.examples) {
      const params = Object.fromEntries(new URL(e.href, 'https://x.invalid').searchParams.entries());
      const violations = checkParams(params, overlays.get(group.tool), []);
      assert.deepEqual(
        violations,
        [],
        `${e.href} would 422 for an anonymous visitor: ${JSON.stringify(violations)}`,
      );
    }
  }
});

test('every landing render example uses declared tool inputs and a real path', () => {
  for (const group of RENDER_GROUPS) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packs/demo/tools', group.tool, 'tool.json'), 'utf8'),
    ) as { inputs?: Array<{ id: string }> };
    const inputIds = new Set((manifest.inputs ?? []).map((i) => i.id));
    for (const e of group.examples) {
      const url = new URL(e.href, 'https://x.invalid');
      assert.match(url.pathname, new RegExp(`^/render/${group.tool}\\.[a-z0-9]+$`), e.href);
      for (const param of url.searchParams.keys()) {
        assert.ok(
          inputIds.has(param) || RENDER_PLANE.has(param),
          `${e.href}: param "${param}" is not an input of ${group.tool} (packs/demo)`,
        );
      }
    }
  }
});

test('the page prints example URLs under the request origin, baseUrl as fallback', () => {
  const config = {
    instance: { name: 'Test Sandbox', baseUrl: 'https://fallback.example' },
    dev: { enabled: true, users: [{ email: 'admin@suse.example', groups: ['admin'] }] },
  } as InstanceConfig;

  const withOrigin = demoLandingHtml(config, 'https://www.lolly.work');
  assert.ok(withOrigin.includes('https://www.lolly.work/render/qr-code.svg'), 'origin-prefixed example URL');
  assert.ok(withOrigin.includes('GET https://www.lolly.work/render/'), 'origin-prefixed endpoint pattern');

  const fallback = demoLandingHtml(config);
  assert.ok(fallback.includes('https://fallback.example/render/qr-code.svg'), 'baseUrl fallback');

  // The persona configured is the persona offered - unchanged contract.
  assert.ok(withOrigin.includes('/api/auth/dev?email=admin%40suse.example'), 'persona sign-in link');
});
