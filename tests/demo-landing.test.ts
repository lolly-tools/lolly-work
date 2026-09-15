// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
