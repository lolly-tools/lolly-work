// SPDX-License-Identifier: MPL-2.0
// Listing screenshots from the neutral Compose fixture. scripts/qualify-marketplace-compose.ts
// calls this while its disposable instance runs, so every capture shows the published
// release, the neutral shell and fixture-only accounts. Never point it at a real instance.
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { checkServerIdentity, connect } from 'node:tls';
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
  /** The view needs the shell to accept the installation's signed catalogue. */
  catalogue: boolean;
}

export const LISTING_SHOTS: readonly ListingShot[] = Object.freeze([
  { file: 'sign-in.png', title: 'Built-in email and password sign-in', path: '/api/auth/login?returnTo=%2F', ready: '#pw-email', catalogue: false },
  { file: 'tool-gallery.png', title: 'The matched Lolly web shell with the neutral tool catalogue', path: '/#/tools', ready: '[data-shots-settled]', catalogue: true },
  { file: 'tool-editor.png', title: 'A neutral community tool open for editing', path: '/#/tool/chart', ready: '#tool-canvas', catalogue: true },
  { file: 'console-overview.png', title: 'The Work console overview', path: '/admin#/overview', ready: '#main', catalogue: false },
  { file: 'console-tool-policy.png', title: 'Tool policy in the Work console', path: '/admin#/instance?tab=tools', ready: '#inst-panel', catalogue: false },
]);

/**
 * The 1.1.1 shell's refusal of the installation's catalogue (Lolly catalog/trust-store.ts).
 * A catalogue view is withheld only for this refusal; any other refusal fails the capture.
 */
export const PINNED_KEY_REFUSAL = 'Catalog refused: signature does not verify against the pinned key';

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Base64 SHA-256 of a certificate's public key, the form Chromium's SPKI pin list takes. */
export function spkiPin(certificate: X509Certificate): string {
  return createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

/**
 * Pins for the chain the fixture proxy presents, after Node has verified that chain
 * against the proxy's local root and the domain. Chromium matches pins only against
 * presented certificates, and Caddy does not send its root.
 */
export function verifiedChainPins(port: number, domain: string, caPem: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: domain, ca: caPem, timeout: 10000,
      checkServerIdentity: (_, certificate) => checkServerIdentity(domain, certificate) }, () => {
      const pins = new Set([spkiPin(new X509Certificate(caPem))]);
      const seen = new Set<string>();
      for (let certificate = socket.getPeerCertificate(true); certificate?.raw && !seen.has(certificate.fingerprint256); certificate = certificate.issuerCertificate) {
        seen.add(certificate.fingerprint256);
        pins.add(spkiPin(new X509Certificate(certificate.raw)));
      }
      socket.end();
      resolve([...pins]);
    });
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(new Error('The fixture TLS check timed out')));
  });
}

// Minimal Playwright surface. Playwright stays out of the root dependency tree; the
// render worker's lockfile pins the copy CI installs.
interface Locator { first(): Locator; isVisible(): Promise<boolean>; fill(value: string): Promise<void>; click(): Promise<void>; waitFor(options: { state: 'attached' | 'visible'; timeout: number }): Promise<void> }
interface Response { status(): number; url(): string }
interface Page {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  locator(selector: string): Locator;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { type: 'png'; animations: 'disabled'; caret: 'hide' }): Promise<Uint8Array>;
  evaluate(expression: string): Promise<unknown>;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  on(event: 'response', handler: (response: Response) => void): void;
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): void;
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

// What a view that never became ready was showing, for the CI log.
const DESCRIBE = "JSON.stringify({href:location.href,view:document.querySelector('#view')?.className??null,text:document.body.innerText.replace(/\\s+/g,' ').slice(0,500)})";

// Lolly's shell marks a refused catalogue on the root element and shows its reason in a
// badge (catalog/integrity.ts). Null while the shell has not refused the catalogue.
const REFUSAL = "document.documentElement.dataset.catalogTrust==='refused'?(document.getElementById('lolly-catalog-refused')?.textContent??''):null";
// One-time prompts that would cover a view. The profile nudge is remembered in the
// profile, not in localStorage, so it is dismissed through its own button.
const DISMISS = ['.personalize-nudge-dismiss'];

// Settled when the element count stops changing across three samples and the fonts are in.
// Node polls it through page.evaluate, which DevTools runs outside the page's CSP. Work's
// sign-in and console CSPs refuse the eval behind waitForFunction's repeated polls.
const STABLE_DOM = "(()=>{const n=document.querySelectorAll('*').length,w=globalThis;w.__lwStable=n===w.__lwCount?(w.__lwStable||0)+1:0;w.__lwCount=n;return w.__lwStable>=3&&document.fonts.status==='loaded'})()";

export interface CaptureOptions {
  /** Port on 127.0.0.1 where the fixture's HTTPS proxy listens. */
  port: number;
  /** Fixture domain, for example work.example.test. */
  domain: string;
  /** The fixture proxy's local root certificate (PEM). Chromium trusts only keys in its verified chain. */
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
  const pins = await verifiedChainPins(options.port, options.domain, options.caPem);
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    channel: process.env.LOLLY_BROWSER_CHANNEL || 'chromium',
    args: [
      `--host-resolver-rules=MAP ${options.domain} 127.0.0.1:${options.port}`,
      `--ignore-certificate-errors-spki-list=${pins.join(',')}`,
      '--disable-quic',
      // The shell needs a WebGPU adapter; SwiftShader is the one a runner has.
      '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader',
    ],
  });
  const written: string[] = [];
  const failures: string[] = [];
  type Recorded = ListingShot & ({ status: 'captured'; sha256: string; width: number; height: number } | { status: 'withheld'; reason: string });
  const shots: Recorded[] = [];
  try {
    const context = await browser.newContext({
      viewport: LISTING_VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en-GB', timezoneId: 'UTC',
      colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none',
    });
    await context.addInitScript({ content: INIT_SCRIPT });
    // Only the 30 s limit lets a capture go ahead unsettled. Any other error is raised.
    const settle = async (page: Page, shot: ListingShot) => {
      const deadline = Date.now() + 30000;
      while (await page.evaluate(STABLE_DOM) !== true) {
        if (Date.now() >= deadline) return console.log(`${shot.file}: the page kept changing for 30 s; captured anyway`);
        await page.waitForTimeout(500);
      }
    };
    const capture = async (page: Page, shot: ListingShot) => {
      for (const selector of DISMISS) {
        const button = page.locator(selector).first();
        if (await button.isVisible()) await button.click();
      }
      await settle(page, shot);
      await page.waitForTimeout(1500);
      const bytes = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      // A catalogue view never ships with the shell's refusal on screen.
      if (shot.catalogue && await withhold(page, shot)) return;
      const size = pngDimensions(bytes);
      if (size?.width !== LISTING_VIEWPORT.width || size.height !== LISTING_VIEWPORT.height) throw new Error(`${shot.file} is not ${LISTING_VIEWPORT.width} x ${LISTING_VIEWPORT.height}`);
      writeFileSync(join(options.outDir, shot.file), bytes);
      shots.push({ ...shot, status: 'captured', sha256: createHash('sha256').update(bytes).digest('hex'), ...size });
      written.push(shot.file);
    };
    const open = async (shot: ListingShot) => {
      const page = await context.newPage();
      let messages = 0;
      page.on('pageerror', error => console.log(`${shot.file}: page error: ${error.message}`));
      page.on('console', message => {
        if (message.type() === 'error' && messages++ < 20) console.log(`${shot.file}: console: ${message.text().slice(0, 300)}`);
      });
      page.on('response', response => {
        if (response.status() >= 400 && response.url().startsWith(origin)) console.log(`${shot.file}: ${response.status()} ${new URL(response.url()).pathname}`);
      });
      await page.goto(origin + shot.path, { waitUntil: 'load', timeout: 60000 });
      return page;
    };
    // A view that never becomes ready leaves a screenshot under diagnostics/ for review.
    // Those files are evidence of the failure, never listing material.
    const diagnose = async (page: Page, shot: ListingShot) => {
      try {
        mkdirSync(join(options.outDir, 'diagnostics'), { recursive: true });
        writeFileSync(join(options.outDir, 'diagnostics', shot.file), await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
        console.log(`${shot.file}: ${String(await page.evaluate(DESCRIBE))}`);
      } catch (error) { console.log(`${shot.file}: no diagnostics: ${(error as Error).message.split('\n')[0]}`); }
    };
    // A release whose shell refuses the installation's catalogue has no catalogue view to
    // show. The known pinned-key refusal is recorded with the shell's own message instead
    // of publishing an error screen; any other refusal is a capture failure.
    const withhold = async (page: Page, shot: ListingShot) => {
      const refusal = await page.evaluate(REFUSAL);
      if (refusal === null) return false;
      if (refusal !== PINNED_KEY_REFUSAL) throw new Error(`the shell refused the catalogue: ${String(refusal) || 'no reason shown'}`);
      shots.push({ ...shot, status: 'withheld', reason: refusal });
      console.log(`${shot.file}: withheld. ${refusal}`);
      await diagnose(page, shot);
      return true;
    };
    const [signIn, ...signedIn] = LISTING_SHOTS;
    // The sign-in capture doubles as the real browser sign-in for the later views.
    const page = await open(signIn!);
    await page.locator(signIn!.ready).waitFor({ state: 'visible', timeout: 30000 });
    await capture(page, signIn!);
    await page.locator('#pw-email').fill(options.email);
    await page.locator('#pw-password').fill(options.password);
    await page.locator('form[action="/api/auth/password/login"] button[type="submit"]').click();
    await page.waitForURL(url => url.origin === origin && !url.pathname.startsWith('/api/auth/'), { timeout: 30000 });
    await page.close();
    for (const shot of signedIn) {
      let view: Page | undefined;
      try {
        view = await open(shot);
        if (shot.catalogue) {
          await view.locator(`${shot.ready}, html[data-catalog-trust="refused"]`).first().waitFor({ state: 'attached', timeout: 120000 });
          await view.waitForTimeout(5000);
          if (await withhold(view, shot)) continue;
        }
        await view.locator(shot.ready).first().waitFor({ state: 'attached', timeout: 120000 });
        await capture(view, shot);
      } catch (error) {
        failures.push(`${shot.file}: ${(error as Error).message.split('\n')[0]}`);
        if (view) await diagnose(view, shot);
      } finally {
        await view?.close();
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
