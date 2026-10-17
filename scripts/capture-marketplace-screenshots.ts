// SPDX-License-Identifier: MPL-2.0
// Listing screenshots from the neutral Compose fixture. scripts/qualify-marketplace-compose.ts
// calls this while its disposable instance runs, so every capture shows the published
// release, the neutral shell and fixture-only accounts. Never point it at a real instance.
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 1280 x 720 PNG is the size Azure requires and the other listing channels accept. */
export const LISTING_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
export const MANIFEST_FILE = 'screenshots.json';

export interface ListingShot {
  file: string;
  title: string;
  /** Path on the fixture origin. The sign-in page is the only signed-out capture. */
  path: string;
  /** Element that shows the view has mounted. */
  ready: string;
}

export const LISTING_SHOTS: readonly ListingShot[] = Object.freeze([
  { file: 'sign-in.png', title: 'Built-in email and password sign-in', path: '/api/auth/login?returnTo=%2F', ready: '#pw-email' },
  { file: 'tool-gallery.png', title: 'The matched Lolly web shell with the neutral tool catalogue', path: '/#/tools', ready: '[data-shots-settled]' },
  { file: 'tool-editor.png', title: 'A neutral community tool open for editing', path: '/#/tool/chart', ready: '#tool-canvas' },
  { file: 'console-overview.png', title: 'The Work console overview', path: '/admin#/overview', ready: '#main' },
  { file: 'console-tool-policy.png', title: 'Tool policy in the Work console', path: '/admin#/instance?tab=tools', ready: '#inst-panel' },
]);

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Base64 SHA-256 of a certificate's public key, the form Chromium's SPKI pin list takes. */
export function spkiPin(certificatePem: string): string {
  const der = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

// Minimal Playwright surface. Playwright stays out of the root dependency tree; the
// render worker's lockfile pins the copy CI installs.
interface Locator { first(): Locator; fill(value: string): Promise<void>; click(): Promise<void>; waitFor(options: { state: 'attached' | 'visible'; timeout: number }): Promise<void> }
interface Response { status(): number; url(): string }
interface Page {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  locator(selector: string): Locator;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  waitForFunction(expression: string, arg: undefined, options: { timeout: number; polling: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { type: 'png'; animations: 'disabled'; caret: 'hide' }): Promise<Uint8Array>;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  on(event: 'response', handler: (response: Response) => void): void;
  close(): Promise<void>;
}
interface Context { addInitScript(script: { content: string }): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }
interface Browser { version(): string; newContext(options: Record<string, unknown>): Promise<Context>; close(): Promise<void> }
interface Chromium { launch(options: { channel: string; args: string[] }): Promise<Browser> }

async function loadChromium(): Promise<Chromium> {
  const from = process.env.PLAYWRIGHT_DIR ?? join(root, 'workers/render');
  const spec = createRequire(join(from, 'package.json')).resolve('playwright-core');
  const module = await import(pathToFileURL(spec).href) as { chromium?: Chromium; default?: { chromium: Chromium } };
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error('playwright-core did not provide Chromium');
  return chromium;
}

// First-run notices and the shell's neutral capture state (Lolly lib/capture-neutral.ts),
// seeded before any page script runs. The console reads its theme from lw-theme.
const INIT_SCRIPT = "try{for(const k of ['lolly-welcome-dismissed','lolly-tips-dismissed','lolly-privacy-ack','lolly-capture-neutral'])localStorage.setItem(k,'1');" +
  "localStorage.setItem('theme','light');localStorage.setItem('lw-theme','light')}catch(_){}";

// Settled when the element count stops changing across three samples and the fonts are in.
const STABLE_DOM = "(()=>{const n=document.querySelectorAll('*').length,w=globalThis;w.__lwStable=n===w.__lwCount?(w.__lwStable||0)+1:0;w.__lwCount=n;return w.__lwStable>=3&&document.fonts.status==='loaded'})()";

export interface CaptureOptions {
  /** Port on 127.0.0.1 where the fixture's HTTPS proxy listens. */
  port: number;
  /** Fixture domain, for example work.example.test. */
  domain: string;
  /** The fixture proxy's local root certificate (PEM). Chromium trusts only this key. */
  caPem: string;
  email: string;
  password: string;
  outDir: string;
  release: { version: string; serverImage: string; shell: { sha256: string } };
  source: string;
}

export async function captureListingScreenshots(options: CaptureOptions): Promise<string[]> {
  const origin = `https://${options.domain}`;
  mkdirSync(options.outDir, { recursive: true });
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    channel: process.env.LOLLY_BROWSER_CHANNEL || 'chromium',
    args: [
      `--host-resolver-rules=MAP ${options.domain} 127.0.0.1:${options.port}`,
      `--ignore-certificate-errors-spki-list=${spkiPin(options.caPem)}`,
      '--disable-quic',
      // The shell needs a WebGPU adapter; SwiftShader is the one a runner has.
      '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
    ],
  });
  const written: string[] = [];
  const failures: string[] = [];
  const shots: Array<ListingShot & { sha256: string; width: number; height: number }> = [];
  try {
    const context = await browser.newContext({
      viewport: LISTING_VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC',
      colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none',
    });
    await context.addInitScript({ content: INIT_SCRIPT });
    const capture = async (page: Page, shot: ListingShot) => {
      await page.waitForFunction(STABLE_DOM, undefined, { timeout: 30000, polling: 500 }).catch(() => console.log(`${shot.file}: the page kept changing; captured anyway`));
      await page.waitForTimeout(1500);
      const bytes = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      const size = pngDimensions(bytes);
      if (size?.width !== LISTING_VIEWPORT.width || size.height !== LISTING_VIEWPORT.height) throw new Error(`${shot.file} is not ${LISTING_VIEWPORT.width} x ${LISTING_VIEWPORT.height}`);
      writeFileSync(join(options.outDir, shot.file), bytes);
      shots.push({ ...shot, sha256: createHash('sha256').update(bytes).digest('hex'), ...size });
      written.push(shot.file);
    };
    const open = async (shot: ListingShot) => {
      const page = await context.newPage();
      page.on('pageerror', error => console.log(`${shot.file}: page error: ${error.message}`));
      page.on('response', response => {
        if (response.status() >= 400 && response.url().startsWith(origin)) console.log(`${shot.file}: ${response.status()} ${new URL(response.url()).pathname}`);
      });
      await page.goto(origin + shot.path, { waitUntil: 'load', timeout: 60000 });
      await page.locator(shot.ready).first().waitFor({ state: 'attached', timeout: 120000 });
      return page;
    };
    const [signIn, ...signedIn] = LISTING_SHOTS;
    // The sign-in capture doubles as the real browser sign-in for the later views.
    const page = await open(signIn!);
    await capture(page, signIn!);
    await page.locator('#pw-email').fill(options.email);
    await page.locator('#pw-password').fill(options.password);
    await page.locator('form[action="/api/auth/password/login"] button[type="submit"]').click();
    await page.waitForURL(url => url.origin === origin && !url.pathname.startsWith('/api/auth/'), { timeout: 30000 });
    await page.close();
    for (const shot of signedIn) {
      try {
        const view = await open(shot);
        try { await capture(view, shot); } finally { await view.close(); }
      } catch (error) {
        failures.push(`${shot.file}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    const manifest = {
      schemaVersion: 1,
      fixture: 'Helm qualification, Neutral Compose installation and recovery',
      source: options.source,
      run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'local',
      capturedAt: new Date().toISOString(),
      release: { version: options.release.version, serverImage: options.release.serverImage, shellSha256: options.release.shell.sha256 },
      browser: `Chromium ${browser.version()}, SwiftShader WebGPU`,
      viewport: { ...LISTING_VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light' },
      shots,
    };
    writeFileSync(join(options.outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
    await context.close();
  } finally {
    await browser.close();
  }
  if (failures.length) throw new Error(`Listing captures failed:\n${failures.join('\n')}`);
  return written;
}
