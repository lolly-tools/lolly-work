// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerBrowserOptions } from '../workers/render/src/browser-launch.ts';

test('worker software WebGPU preserves existing isolation flags and browser overrides', () => {
  const options = workerBrowserOptions({ LOLLY_BROWSER_PATH: '/owned/chromium', LOLLY_BROWSER_CHANNEL: 'chromium' });
  assert.deepEqual(options, { args: ['--no-sandbox', '--disable-dev-shm-usage',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
    executablePath: '/owned/chromium', channel: 'chromium' });
  assert.deepEqual(Object.keys(workerBrowserOptions({})), ['args']);
  assert.ok(!options.args.includes('--disable-gpu'));
  assert.ok(!options.args.some(value => /disable-web-security|ignore-certificate|disable-features/.test(value)));
  options.args.pop();
  assert.equal(workerBrowserOptions({}).args.at(-1), '--use-webgpu-adapter=swiftshader', 'one caller cannot mutate later launches');
});

test('packaged worker keeps Node and Playwright versions with a glibc browser installation', () => {
  const docker = readFileSync(new URL('../workers/render/Dockerfile', import.meta.url), 'utf8');
  const lock = readFileSync(new URL('../workers/render/pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.match(docker, /^FROM node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(docker, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/lolly-browsers/);
  assert.match(docker, /pnpm install --frozen-lockfile --prod[\s\S]*pnpm exec playwright-core install --with-deps chromium/);
  assert.match(docker, /chmod -R a\+rX \/opt\/lolly-browsers/);
  assert.match(docker, /^USER node$/m);
  assert.doesNotMatch(docker, /LOLLY_BROWSER_PATH=|apk add|--privileged|SYS_ADMIN/);
  assert.match(lock, /playwright-core:[\s\S]*version: 1\.63\.0/);
  const server = readFileSync(new URL('../workers/render/src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /return chromium\.launch\(workerBrowserOptions\(\)\)/);
});
