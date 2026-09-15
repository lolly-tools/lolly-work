// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { demoLandingHtml } from '../server/src/lib/demo-landing.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const config = parseConfig(
  JSON.stringify({
    instance: {
      name: 'Example Work',
      baseUrl: 'https://work.example',
      pack: resolve('packs/demo'),
    },
    dev: { enabled: true, users: [] },
    rateLimit: { enabled: false },
  }),
);
const shared = readFileSync(
  new URL('../console/brand-theme.js', import.meta.url),
  'utf8',
).replace(/^export \{[^}]+\};$/m, '');
const landing = readFileSync(
  new URL('../console/landing.js', import.meta.url),
  'utf8',
).replace(/^import .*;$/m, '');
const pause = () => new Promise<void>((r) => setImmediate(r));
function page(brand: object | null = null, stored?: string) {
  const dom = new JSDOM(demoLandingHtml(config), {
    url: 'https://work.example',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const requests: string[] = [];
  w.fetch = async (url: string) => {
    requests.push(url);
    return {
      ok: !!brand,
      json: async () => brand,
      arrayBuffer: async () => new ArrayBuffer(4),
    };
  };
  if (stored) w.localStorage.setItem('lw-theme', stored);
  w.eval(shared + '\nwindow.testMaps = buildThemeMaps;');
  w.eval(landing);
  return { dom, w, document: w.document, requests };
}

test('all workflows, boundaries, views and offline explanations remain coherent', () => {
  const { dom, document: d } = page();
  try {
    for (const id of ['local', 'managed', 'shared']) {
      d.querySelector(`[data-scenario="${id}"]`).click();
      assert.equal(
        d.querySelectorAll('[data-scenario][aria-pressed="true"]').length,
        1,
      );
      assert.match(
        d.getElementById('arch-step-label').textContent,
        /step by step/,
      );
      for (let i = 1; i <= 4; i++) {
        d.getElementById('arch-next').click();
        assert.equal(
          d.getElementById('arch-step-label').textContent,
          `Step ${i} of 4`,
        );
      }
      d.getElementById('arch-next').click();
      assert.equal(
        d.getElementById('arch-step-label').textContent,
        'Step 1 of 4',
      );
      d.getElementById('arch-offline').click();
      assert.equal(d.getElementById('arch-next').disabled, true);
      assert.equal(d.getElementById('arch-flow-up').hidden, true);
      assert.equal(
        d.getElementById('arch-work-zone').dataset.connected,
        'false',
      );
      assert.ok(d.getElementById('arch-result').textContent.length > 40);
      d.getElementById('arch-offline').click();
      assert.equal(d.getElementById('arch-next').disabled, false);
    }
    for (const id of ['work', 'network', 'host', 'engine', 'data']) {
      d.querySelector(`[data-node="${id}"]`).click();
      assert.equal(
        d.querySelectorAll('[data-node][aria-pressed="true"]').length,
        1,
      );
      const security = d.getElementById('arch-detail-view').textContent;
      d.querySelector('[data-lens="platform"]').click();
      assert.notEqual(
        d.getElementById('arch-detail-view').textContent,
        security,
      );
      assert.match(
        d.getElementById('arch-detail-link').href,
        /\/admin#\/docs\?doc=/,
      );
      d.querySelector('[data-lens="security"]').click();
    }
  } finally {
    dom.window.close();
  }
});

test('brand failure leaves the page usable and honours the console theme preference', async () => {
  const { dom, document: d, w, requests } = page(null, 'brand');
  try {
    await pause();
    assert.deepEqual(requests, ['/api/brand']);
    assert.equal(d.documentElement.dataset.theme, 'brand');
    assert.equal(
      d.documentElement.style.getPropertyValue('--pack-accent-light'),
      '',
    );
    for (const mode of ['light', 'dark', 'brand', 'system']) {
      const select = d.getElementById('landing-theme');
      select.value = mode;
      select.dispatchEvent(new w.Event('change'));
      assert.equal(
        d.documentElement.getAttribute('data-theme'),
        mode === 'system' ? null : mode,
      );
      assert.equal(
        w.localStorage.getItem('lw-theme'),
        mode === 'system' ? null : mode,
      );
    }
    w.dispatchEvent(
      new w.StorageEvent('storage', { key: 'lw-theme', newValue: 'dark' }),
    );
    assert.equal(d.documentElement.dataset.theme, 'dark');
    d.querySelector('[data-scenario="shared"]').click();
    assert.match(
      d.getElementById('arch-result').textContent,
      /receive content/,
    );
  } finally {
    dom.window.close();
  }
});

test('loaded brand resolves each theme independently and loads its own fonts', async () => {
  const tokens = {
    $themes: [
      {
        name: 'Light',
        selectedTokenSets: { base: 'source', light: 'enabled' },
      },
      { name: 'Dark', selectedTokenSets: { base: 'source', dark: 'enabled' } },
    ],
    base: {
      color: {
        $type: 'color',
        primary: { $value: '{color.chosen}' },
        surface: { $value: '{color.canvas}' },
      },
      font: {
        brand: { $value: 'Example Sans' },
        mono: { $value: 'Example Mono' },
      },
    },
    light: {
      color: {
        $type: 'color',
        chosen: { $value: '#7030a0' },
        canvas: { $value: '#eeeeff' },
      },
    },
    dark: {
      color: {
        $type: 'color',
        chosen: { $value: '#d9b8ff' },
        canvas: { $value: '#221133' },
      },
    },
  };
  const {
    dom,
    w,
    document: d,
    requests,
  } = page({
    tokens,
    logos: { light: '/api/brand/logo/light', dark: '/api/brand/logo/dark' },
  });
  try {
    Object.defineProperty(d, 'fonts', { value: { add() {} } });
    w.FontFace = class {
      async load() {
        return this;
      }
    };
    await pause();
    await pause();
    assert.equal(
      d.documentElement.style.getPropertyValue('--pack-accent-light'),
      '#7030a0',
    );
    assert.equal(
      d.documentElement.style.getPropertyValue('--pack-accent-dark'),
      '#d9b8ff',
    );
    assert.match(
      d.documentElement.style.getPropertyValue('--pack-plane-light'),
      /#eeeeff/,
    );
    assert.match(
      d.documentElement.style.getPropertyValue('--pack-plane-dark'),
      /#221133/,
    );
    assert.match(
      d.documentElement.style.getPropertyValue('--font-sans'),
      /Example Sans/,
    );
    assert.match(
      d.documentElement.style.getPropertyValue('--font-mono'),
      /Example Mono/,
    );
    assert.ok(requests.includes('/api/brand/font/ExampleSans-Variable.woff2'));
    assert.ok(requests.every((path) => path.startsWith('/api/brand')));
    assert.equal(
      d.querySelector('[data-brand-logo="light"]').getAttribute('src'),
      '/api/brand/logo/light',
    );
    const maps = w.testMaps(tokens);
    assert.equal(maps.light['color.primary'].resolved, '#7030a0');
    assert.equal(maps.dark['color.primary'].resolved, '#d9b8ff');
  } finally {
    dom.window.close();
  }
});

test('the shipped pack supplies both accents through the shared resolver', async () => {
  const tokens = JSON.parse(
    readFileSync(
      resolve('packs/demo/brands/suse/catalog/assets/suse/tokens/brand.json'),
      'utf8',
    ),
  );
  const { dom, document: d } = page({ tokens });
  try {
    await pause();
    await pause();
    assert.match(
      d.documentElement.style.getPropertyValue('--pack-accent-light'),
      /^#[0-9a-f]{6}$/,
    );
    assert.match(
      d.documentElement.style.getPropertyValue('--pack-accent-dark'),
      /^#[0-9a-f]{6}$/,
    );
  } finally {
    dom.window.close();
  }
});

test('names are escaped and brand metadata cannot inject an external logo', async () => {
  const html = demoLandingHtml({
    ...config,
    instance: { ...config.instance, name: '<script>alert(1)</script>' },
  });
  const raw = new JSDOM(html);
  assert.equal(
    raw.window.document.querySelectorAll(
      'script:not([src]):not([type="application/json"])',
    ).length,
    0,
  );
  raw.window.close();
  const { dom, document: d } = page({
    tokens: {},
    logos: {
      light: 'https://outside.example/track.svg',
      dark: 'javascript:alert(1)',
    },
  });
  try {
    await pause();
    assert.equal(
      d.querySelector('[data-brand-logo="light"]').getAttribute('src'),
      null,
    );
  } finally {
    dom.window.close();
  }
});

test('landing, shared theme assets and new docs are served through the existing public paths', async () => {
  const app = buildApp({
    config,
    store: createMemoryStore(),
    secrets: { session: 'landing-test-session', link: 'landing-test-link' },
  });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const base = `http://127.0.0.1:${addr.port}`;
    for (const path of [
      '/',
      '/admin/landing.css',
      '/admin/landing.js',
      '/admin/brand-theme.js',
      '/admin/theme.css',
      '/api/v1/docs/security-platform',
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.ok(body.length > 100, path);
      if (path === '/') assert.match(body, /id="security-platform"/);
    }
    const css = await (await fetch(base + '/admin/landing.css')).text();
    assert.match(css, /@import url\('\.\/theme\.css'\)/);
    assert.doesNotMatch(
      css,
      /#[a-f\d]{3,8}\b/i,
      'page styles inherit colours rather than defining a second palette',
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
