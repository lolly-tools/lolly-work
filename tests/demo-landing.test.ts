// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { demoLandingHtml } from '../server/src/lib/demo-landing.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
test('the landing page offers the configured persona sign-in', () => {
  const config = {
    instance: { name: 'Test Sandbox', baseUrl: 'https://fallback.example' },
    dev: { enabled: true, users: [{ email: 'admin@suse.example', groups: ['admin'] }] },
  } as InstanceConfig;

  const html = demoLandingHtml(config);
  assert.ok(html.includes('/api/auth/dev?email=admin%40suse.example'), 'persona sign-in link');
});

test('every docs link on the landing page opens a page the bundle lists', () => {
  // The console routes docs as #/docs?doc=<slug>; a path such as #/docs/install
  // is no route, so it opened the overview, or the sign-in gate on the sandbox.
  const manifest = JSON.parse(readFileSync(new URL('../docs/docs.json', import.meta.url), 'utf8')) as {
    sections: Array<{ docs: Array<{ slug: string }> }>;
  };
  const slugs = new Set(manifest.sections.flatMap((s) => s.docs.map((d) => d.slug)));
  const html = demoLandingHtml({ instance: { name: 'Test Sandbox', baseUrl: 'https://fallback.example' }, dev: { enabled: true, users: [] } } as unknown as InstanceConfig);
  const hrefs = [...html.matchAll(/href="(\/admin#\/docs[^"]*)"/g)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
  assert.ok(hrefs.length >= 5, `found ${hrefs.length} docs links`);
  for (const href of hrefs) {
    if (href === '/admin#/docs') continue;
    const m = /^\/admin#\/docs\?doc=([a-z0-9-]+)(?:&anchor=[a-z0-9-]+)?$/.exec(href);
    assert.ok(m, `${href} is not a console docs route`);
    assert.ok(slugs.has(m[1] ?? ''), `${href} names a page the bundle does not list`);
  }
});
