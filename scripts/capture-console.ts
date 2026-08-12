#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// This script drives a real browser (Playwright) and runs code inside the page
// (page.evaluate/addInitScript use DOM globals). Like the Chromium render worker
// (workers/render), it is deliberately EXCLUDED from the root Node tsconfig —
// a Node-only, DOM-free program can't type in-page code, and a program-wide DOM
// lib would mistype the server. Playwright itself is resolved at RUNTIME from the
// sibling OSS repo (lolly-work ships no bundler/browser dependency).
/**
 * capture-console — render every admin-console documentation screenshot as a
 * signed VECTOR SVG, the way the OSS /info shots are made.
 *
 * Pipeline, per shot:
 *   1. boot a richly-seeded demo deployment (scripts/demo.ts, in-memory) so the
 *      console has real governance data to show;
 *   2. drive a headless browser to each `/admin#/…` screen, signed in as admin;
 *   3. inject the capture-time walker bundle (scripts/lib/walker-bundle.js — the
 *      web shell's renderSvgFromHtml, built by scripts/build-walker-bundle.ts)
 *      and call window.__lollyWalkerShot(cropSelector) → a real SVG document of
 *      the live DOM (geometry, not pixels);
 *   4. sign that SVG with a C2PA Content Credential using THIS run's signing
 *      identity, embedding a `tools.lolly.export` assertion that records the
 *      capture recipe and a `c2pa.created` action with digitalSourceType
 *      screenCapture (honest: a screenshot never touched a camera sensor);
 *   5. write docs/shots/<slug>.svg — the file the docs serve, credential the
 *      reader can decode, and verify locally in the console's own #/verify view.
 *
 * The signing identity: by default the harness MINTS a self-contained demo
 * identity (root+leaf, the same generateCaRoot/issueLeafCert path as `lw c2pa
 * init`) so shots are genuinely signed with zero PKI — they read "valid,
 * self-signed" in a verifier, which is the honest state and a good teaching
 * example. A real deployment sets LW_C2PA_SIGNING_KEY + a certFile to sign the
 * corpus with its own trusted identity (then its own console verifies them as
 * trusted, since #/verify pins the instance root).
 *
 * Prerequisites for CAPTURE (not for the docs at runtime): Playwright + a
 * Chromium, resolved from the sibling OSS repo (which installs them). The runtime
 * console needs none of this — it only ever loads the finished .svg files.
 *
 *     node scripts/capture-console.ts                 # capture all shots
 *     node scripts/capture-console.ts overview audit  # just these slugs
 *     LOLLY_OSS_DIR=/path/to/lolly PORT=8799 node scripts/capture-console.ts
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every shot embeds the console's two typefaces as data: URIs (SUSE + SUSE
// Mono — the only faces lolly-work uses, decided 2026-08-11). Without this the
// SVGs merely NAME the families and every viewer without them installed falls
// back to their browser default — the "broken fonts in the charts" a reader
// reported against the served corpus. ~155 KB per shot, and the shot renders
// identically everywhere, which is the point of a signed corpus.
const EMBED_FACES = [
  { family: 'SUSE', file: 'console/fonts/SUSE[wght].woff2', weight: '100 800' },
  { family: 'SUSE Mono', file: 'console/fonts/SUSEMono[wght].woff2', weight: '100 900' },
];
let fontCss: string | null = null;
/**
 * Make a walker shot self-contained: the fonts above as data: URIs. That is
 * ALL that remains host-side — the walker itself now bakes each nested-svg
 * descendant's computed presentation (fills, var() strokes, text style) as
 * inline style (lolly plans/101, walker `export-nested-svg.test.ts`), which
 * retired this script's earlier :root-var re-declaration and SUSE text pin.
 * Faces still must ship: the walker inlines font-family NAMES, not bytes.
 */
function embedShotStyle(svg: string): string {
  fontCss ??= EMBED_FACES.map((f) => {
    const b64 = readFileSync(join(ROOT, f.file)).toString('base64');
    return `@font-face{font-family:'${f.family}';src:url(data:font/woff2;base64,${b64}) format('woff2-variations');font-weight:${f.weight};font-style:normal}`;
  }).join('');
  return svg.replace(/(<svg[^>]*>)/i, `$1<style>${fontCss}</style>`);
}

const PORT = Number(process.env.PORT ?? 8799);
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = join(ROOT, 'docs', 'shots');
const WALKER_BUNDLE = join(ROOT, 'scripts', 'lib', 'walker-bundle.js');
const VIEWPORT = { width: 1440, height: 900 };
const ADMIN_PERSONA = 'admin@suse.example';
const THEMES = ['light', 'dark'] as const;

// ── the shot recipes ──────────────────────────────────────────────────────────
// Each captures one console screen. cropSelector is the element the walker frames
// (and, at read time, the credential attaches to). `page` is the docs/*.md file
// the shot illustrates — used later when wiring ![]() links; recorded here so the
// recipe list is the single source of truth for "what illustrates what".
interface Recipe {
  slug: string;
  route: string;          // hash route, e.g. 'overview' or 'instance?tab=tools'
  cropSelector: string;   // '#main' for full views, '#inst-panel' for This-Deploy tabs
  page: string;           // docs/*.md this illustrates
  theme?: 'light' | 'dark';
}
const RECIPES: Recipe[] = [
  { slug: 'overview-dashboard', route: 'overview', cropSelector: '#main', page: 'overview.md' },
  { slug: 'people-directory', route: 'users', cropSelector: '#main', page: 'identity.md' },
  { slug: 'permissions-grants', route: 'grants', cropSelector: '#main', page: 'permissions.md' },
  { slug: 'tool-policy', route: 'instance?tab=tools', cropSelector: '#inst-panel', page: 'governance.md' },
  { slug: 'approvals-inbox', route: 'approvals', cropSelector: '#main', page: 'approvals.md' },
  { slug: 'audit-chain', route: 'audit', cropSelector: '#main', page: 'audit.md' },
  { slug: 'catalog-assets', route: 'instance?tab=catalog', cropSelector: '#inst-panel', page: 'catalog.md' },
  { slug: 'catalog-providers', route: 'instance?tab=providers', cropSelector: '#inst-panel', page: 'catalog.md' },
  { slug: 'feature-flags', route: 'instance?tab=flags', cropSelector: '#inst-panel', page: 'configuration.md' },
  { slug: 'share-links', route: 'links', cropSelector: '#main', page: 'sharing.md' },
  { slug: 'broadcast-messages', route: 'messages', cropSelector: '#main', page: 'operations.md' },
  { slug: 'preview-as-group', route: 'preview', cropSelector: '#main', page: 'governance.md' },
  { slug: 'client-fleet', route: 'fleet', cropSelector: '#main', page: 'status.md' },
  { slug: 'activity-timeline', route: 'activity', cropSelector: '#main', page: 'telemetry.md' },
];

// ── resolve Playwright + the engine from where they actually live ──────────────
function resolveOssDir(): string {
  for (const c of [process.env.LOLLY_OSS_DIR, resolve(ROOT, '..', 'lolly'), join(homedir(), 'Build', 'lolly')]) {
    if (c && existsSync(join(c, 'shells/web/src/bridge/export.ts'))) return resolve(c);
  }
  throw new Error('OSS Lolly repo not found (needed for Playwright). Set LOLLY_OSS_DIR.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPlaywright(): Promise<any> {
  // lolly-work is zero-dep; Playwright is a capture-only tool. Resolve it from the
  // OSS repo (which installs it) or a PLAYWRIGHT_DIR override.
  const from = process.env.PLAYWRIGHT_DIR ?? resolveOssDir();
  const req = createRequire(join(from, 'package.json'));
  const spec = (() => {
    try { return req.resolve('playwright'); } catch { return req.resolve('playwright-core'); }
  })();
  const mod = await import(spec);
  // Resolving by file path can nest the CJS namespace under .default.
  return mod.chromium ? mod : mod.default;
}

// Engine is vendored here. Non-literal specifier so tsc doesn't resolve its DOM types.
const ENGINE_SPEC: string = '@lolly/engine';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadEngine(): Promise<any> { return import(ENGINE_SPEC); }

/** The root SVG's intrinsic size, read from the first <svg> tag (width/height may
 *  carry a `px` suffix; fall back to the viewBox extent). */
function rootDims(svg: string): { w: number; h: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const w = Number(/\bwidth="([\d.]+)(?:px)?"/.exec(tag)?.[1]);
  const h = Number(/\bheight="([\d.]+)(?:px)?"/.exec(tag)?.[1]);
  if (w > 0 && h > 0) return { w: Math.round(w), h: Math.round(h) };
  const vb = /\bviewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(tag);
  return { w: Math.round(Number(vb?.[1]) || 1440), h: Math.round(Number(vb?.[2]) || 900) };
}

/** Reject if `p` doesn't settle within `ms` — bounds Playwright evaluate() calls,
 *  which otherwise hang forever on a stuck page. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ── mint (or load) the signing identity ────────────────────────────────────────
interface Signer { privateKey: CryptoKey; certDer: Uint8Array; chain: Uint8Array[]; org: string; rootDer: Uint8Array }

async function resolveSigner(): Promise<Signer> {
  const engine = await loadEngine();
  const { subtle } = webcrypto;
  // A real deployment identity supplied via env wins (sign the corpus as the org).
  const keyPem = process.env.LW_C2PA_SIGNING_KEY;
  const certFile = process.env.LW_C2PA_CERT_FILE;
  if (keyPem && certFile) {
    const certPem = readFileSync(certFile, 'utf8');
    const chain = pemCerts(certPem, engine.pemToDer);
    const keyDer = engine.pemToDer(keyPem);
    const privateKey = await subtle.importKey('pkcs8', keyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    console.log('▶ signing with the deployment identity from LW_C2PA_SIGNING_KEY');
    return { privateKey, certDer: chain[0]!, chain, org: process.env.LW_C2PA_ORG ?? 'Lolly', rootDer: chain[chain.length - 1]! };
  }
  // Otherwise mint a self-contained demo identity (root + leaf), zero PKI.
  const org = process.env.LW_C2PA_ORG ?? 'Lolly Demo';
  const root = await engine.generateCaRoot({ commonName: `${org} Root`, organization: org, days: 3650 });
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const spkiDer = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const leafCert: Uint8Array = await engine.issueLeafCert({
    caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer,
    email: `lolly@${org.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.invalid`,
    commonName: `${org} Signer`, organization: org, days: 365,
  });
  // Re-import the private key as sign-only (non-extractable) for the signer.
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  console.log(`▶ signing with a minted self-contained demo identity ("${org}", self-signed)`);
  return { privateKey, certDer: leafCert, chain: [leafCert, root.certDer], org, rootDer: root.certDer };
}

function pemCerts(pem: string, pemToDer: (p: string) => Uint8Array): Uint8Array[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => pemToDer(b));
}

// ── sign one captured SVG ───────────────────────────────────────────────────────
const SCREEN_SOURCE = 'http://cv.iptc.org/newscodes/digitalsourcetype/screenCapture';

async function signSvg(svg: string, recipe: Recipe, dims: { w: number; h: number }, signer: Signer): Promise<Uint8Array> {
  const engine = await loadEngine();
  const bytes = new TextEncoder().encode(svg);
  const opts = {
    signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain },
    title: `Control plane — ${recipe.slug}`,
    claimGenerator: `${signer.org} Lolly`,
    generatorInfo: { name: 'Lolly', version: engine.ENGINE_VERSION ?? '1' },
    // The tools.lolly.export assertion: surface + how to reproduce this capture.
    environment: {
      surface: 'console',
      engine: `node ${process.version}`,
      os: process.platform,
      format: 'svg',
      tool: 'console-screenshot',
      date: new Date().toISOString(),
      dimensions: `${dims.w} × ${dims.h} px`,
      inputs: { route: `#/${recipe.route}`, cropSelector: recipe.cropSelector, width: dims.w, height: dims.h, theme: recipe.theme ?? 'light' },
    },
    // Honest provenance: a screen capture, not software-authored or sensor-captured.
    actions: [{ action: 'c2pa.created', digitalSourceType: SCREEN_SOURCE, description: 'Captured from the screen' }],
  };
  return engine.embedC2pa(bytes, 'svg', opts) as Promise<Uint8Array>;
}

// ── boot the demo deployment ────────────────────────────────────────────────────
function bootDemo(): { kill: () => void; ready: Promise<void> } {
  const child = spawn('node', ['scripts/demo.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: 'localhost' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout?.on('data', () => {}); // drain
  const ready = (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) { const j = await r.json().catch(() => null); if (j?.ok) return; }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`demo server did not become healthy on ${BASE} within 30s`);
  })();
  return { kill: () => child.kill('SIGTERM'), ready };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(WALKER_BUNDLE)) {
    throw new Error(`missing ${WALKER_BUNDLE} — run \`node scripts/build-walker-bundle.ts\` first.`);
  }
  const only = new Set(process.argv.slice(2));
  const recipes = only.size ? RECIPES.filter((r) => only.has(r.slug)) : RECIPES;
  if (!recipes.length) throw new Error(`no recipes match ${[...only].join(', ')}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const walkerSrc = readFileSync(WALKER_BUNDLE, 'utf8');
  const signer = await resolveSigner();
  // Write the signing root next to the shots so a curious operator can pin it and
  // the console's #/verify can read "trusted" for this run's own credentials.
  const engine = await loadEngine();
  writeFileSync(join(OUT_DIR, 'signing-root.pem'), engine.derToPem(signer.rootDer, 'CERTIFICATE'));

  const demo = bootDemo();
  console.log(`▶ booting demo deployment on ${BASE} …`);
  await demo.ready;
  console.log('✓ demo healthy');

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    ...(process.env.LOLLY_BROWSER_CHANNEL ? { channel: process.env.LOLLY_BROWSER_CHANNEL } : {}),
    ...(process.env.LOLLY_BROWSER_PATH ? { executablePath: process.env.LOLLY_BROWSER_PATH } : {}),
  });

  let ok = 0;
  const failures: string[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, serviceWorkers: 'block' });
    // Sign in as admin once (plants the lw_session cookie for the whole context).
    const auth = await context.newPage();
    await auth.goto(`${BASE}/api/auth/dev?email=${encodeURIComponent(ADMIN_PERSONA)}&returnTo=/admin`, { waitUntil: 'domcontentloaded' });
    await auth.close();

    for (const recipe of recipes) {
     // Each screen is captured in BOTH themes: <slug>.svg (light) and
     // <slug>.dark.svg (dark). The docs show whichever matches the reader's theme,
     // so a dark-mode reader gets a dark shot, not a glaring light one.
     for (const theme of THEMES) {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      try {
        await page.addInitScript((t) => {
          try { localStorage.setItem('lw-theme', t); } catch { /* ignore */ }
        }, theme);
        // The control plane long-polls org-config, so 'networkidle' never fires;
        // gate on concrete DOM signals instead. 'load' + boot-placeholder gone +
        // the view's container visible + fonts ready is a reliable settle.
        await page.goto(`${BASE}/admin#/${recipe.route}`, { waitUntil: 'load' });
        await page.waitForFunction(() => !document.querySelector('.boot'), null, { timeout: 15_000 }).catch(() => {});
        await page.waitForSelector(`${recipe.cropSelector}`, { state: 'visible', timeout: 15_000 });
        await withTimeout(page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready), 8_000, 'fonts.ready');
        // Views fetch their data async, so the crop element starts near-empty and
        // grows. Wait until it has real content AND has stopped growing for two
        // consecutive samples — the generic equivalent of the OSS settleForCapture
        // (which stamps data-shots-settled once the DOM stops expanding).
        await page.waitForFunction((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const w = globalThis as unknown as { __lwLastH?: number; __lwStable?: number };
          const h = Math.round(r.height);
          if (h < 200 || el.querySelectorAll('*').length < 20) { w.__lwStable = 0; return false; }
          w.__lwStable = h === w.__lwLastH ? (w.__lwStable ?? 0) + 1 : 0;
          w.__lwLastH = h;
          return (w.__lwStable ?? 0) >= 2;
        }, recipe.cropSelector, { timeout: 15_000, polling: 300 }).catch(() => {});
        await page.waitForTimeout(300); // a beat for any post-font reflow

        // Capture prep: a collapsed <details> (the "View as table" panels) hides
        // its body via the UA closed-state, which the walker doesn't honor — it
        // would draw the table on top of the chart. Hide the body explicitly so the
        // walker skips it and the shot matches what a reader actually sees.
        await page.evaluate(() => {
          document.querySelectorAll('details:not([open])').forEach((d) => {
            d.querySelectorAll(':scope > *:not(summary)').forEach((c) => {
              (c as HTMLElement).style.display = 'none';
            });
          });
        });

        await page.addScriptTag({ content: walkerSrc });
        const result = await withTimeout(page.evaluate(async (sel) => {
          const fn = (globalThis as unknown as { __lollyWalkerShot?: (s: string) => Promise<{ svg: string }> }).__lollyWalkerShot;
          if (!fn) throw new Error('walker did not install');
          return fn(sel);
        }, recipe.cropSelector), 45_000, 'walker');
        const svg = embedShotStyle(result.svg);
        if (!/<svg[\s>]/i.test(svg)) throw new Error('walker returned no <svg>');

        const dims = rootDims(svg);
        const signed = await signSvg(svg, { ...recipe, theme }, dims, signer);
        const suffix = theme === 'dark' ? '.dark' : '';
        const file = join(OUT_DIR, `${recipe.slug}${suffix}.svg`);
        writeFileSync(file, signed);
        const kb = Math.round(signed.length / 1024);
        const els = (svg.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '').match(/<[a-z][a-z0-9:-]*[\s/>]/gi) ?? []).length;
        console.log(`  ✓ ${`${recipe.slug} (${theme})`.padEnd(30)} ${dims.w}×${dims.h}  ${els} elements  ${kb} KB  signed`);
        ok++;
      } catch (e) {
        failures.push(`${recipe.slug} (${theme}): ${(e as Error).message}`);
        console.log(`  ✗ ${`${recipe.slug} (${theme})`.padEnd(30)} FAILED — ${(e as Error).message}`);
      } finally {
        await page.close();
      }
     }
    }
  } finally {
    await browser.close();
    demo.kill();
  }

  console.log(`\n${ok}/${recipes.length * THEMES.length} shots captured → docs/shots/`);
  if (failures.length) { console.error(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
