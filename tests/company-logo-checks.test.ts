// SPDX-License-Identifier: MPL-2.0
/**
 * The checks a partner company's logo passes on upload (plans/82 M3, section
 * 4). The SVG cleaning must give the same answer as the Lolly shell's own
 * sanitiser: tests/fixtures/company-logos/lolly-sanitised.json records what
 * the shell's sanitizeSvgToString made of each fixture
 * (scripts/build-company-logo-fixtures.ts), and the server must match it byte
 * for byte, so the two cannot drift apart unseen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  checkLogo, cleanSvg, contrastWarnings, DEFAULT_SURFACES, SHELL_SVG_PROFILE, surfacesFromTokens,
  PNG_MAX_BYTES, SVG_MAX_BYTES, type LogoCheck,
} from '../server/src/programmes/logo-checks.ts';

const dir = join(import.meta.dirname, 'fixtures', 'company-logos');
const recorded = JSON.parse(readFileSync(join(dir, 'lolly-sanitised.json'), 'utf8')) as { dompurify: string; cases: Record<string, string | { throws: string }> };
const fixture = (name: string): Buffer => readFileSync(join(dir, name));
const surfaces = DEFAULT_SURFACES;

const refused = (r: LogoCheck): { status: number; code: string; detail: string } => {
  assert.equal(r.ok, false, 'expected a refusal');
  return r as { ok: false; status: 413 | 415 | 422; code: string; detail: string };
};
const accepted = (r: LogoCheck) => {
  assert.equal(r.ok, true, `expected the logo to pass: ${JSON.stringify(r)}`);
  return r as Extract<LogoCheck, { ok: true }>;
};

test('the server cleans every fixture exactly as the Lolly shell does', async () => {
  const pinned = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules', 'dompurify', 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(pinned, recorded.dompurify, 'the fixtures were recorded with the DOMPurify version Work runs; record them again after a bump');
  const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
  assert.deepEqual(files, Object.keys(recorded.cases).sort(), 'every fixture has a recorded answer');
  for (const file of files) {
    const want = recorded.cases[file];
    assert.equal(typeof want, 'string', `${file}: the shell kept an <svg>`);
    assert.equal((await cleanSvg(fixture(file).toString('utf8'))).svg, want, `${file}: same bytes as the shell`);
  }
});

test('the profile options match the shell source when the shell is checked out', { skip: !existsSync(join(import.meta.dirname, '..', 'vendor', 'lolly', 'shells', 'web', 'src', 'bridge', 'svg-sanitize.ts')) && 'vendor/lolly is not checked out' }, () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'vendor', 'lolly', 'shells', 'web', 'src', 'bridge', 'svg-sanitize.ts'), 'utf8');
  assert.match(source, /USE_PROFILES:\s*\{\s*svg:\s*true,\s*svgFilters:\s*true\s*\}/);
  assert.match(source, /ADD_ATTR:\s*\['calcMode'\]/);
  assert.match(source, /RETURN_DOM:\s*true/);
  assert.deepEqual(SHELL_SVG_PROFILE, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['calcMode'], RETURN_DOM: true });
});

test('checking a logo leaves the shared profile exactly as the shell writes it', async () => {
  await checkLogo(fixture('clean.svg'), 'light', surfaces);
  await checkLogo(fixture('clean.svg'), 'dark', surfaces);
  assert.deepEqual(SHELL_SVG_PROFILE, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['calcMode'], RETURN_DOM: true });
});

test('a clean SVG passes with no warnings, and the stored bytes are the cleaned markup', async () => {
  const r = accepted(await checkLogo(fixture('clean.svg'), 'light', surfaces));
  assert.equal(r.format, 'svg');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.bytes.toString('utf8'), recorded.cases['clean.svg']);
  assert.deepEqual(r.inks.sort(), ['#0b3d91', '#1a1a1a', '#1e88e5']);
  assert.equal(r.width, 240);
  const editor = accepted(await checkLogo(fixture('editor-metadata.svg'), 'light', surfaces));
  assert.deepEqual(editor.warnings, [], 'editor metadata goes quietly');
});

test('an SVG carrying active content is refused, not quietly cleaned', async () => {
  const cases: Array<[string, string]> = [['script.svg', '<script>'], ['handler.svg', 'onclick='], ['javascript-link.svg', 'javascript:'], ['foreign-object.svg', '<foreignobject>']];
  for (const [file, what] of cases) {
    const r = refused(await checkLogo(fixture(file), 'light', surfaces));
    assert.equal(r.status, 422, file);
    assert.equal(r.code, 'LOGO_ACTIVE_CONTENT', file);
    assert.ok(r.detail.includes(what), `${file}: ${r.detail}`);
  }
});

test('an SVG that refers to another file is refused, so the logo is self-contained', async () => {
  for (const file of ['external-image.svg', 'external-use.svg', 'external-style.svg']) {
    const r = refused(await checkLogo(fixture(file), 'light', surfaces));
    assert.equal(r.code, 'LOGO_EXTERNAL_REFERENCE', file);
  }
  assert.match(refused(await checkLogo(fixture('external-use.svg'), 'light', surfaces)).detail, /sprites\.svg#logo/);
});

test('warnings never refuse: a wrapped picture, and parts the cleaning removed', async () => {
  const wrapped = accepted(await checkLogo(fixture('raster-wrap.svg'), 'light', surfaces));
  assert.deepEqual(wrapped.warnings.map((w) => w.code), ['raster-in-svg']);
  const used = accepted(await checkLogo(fixture('internal-use.svg'), 'light', surfaces));
  assert.deepEqual(used.warnings.map((w) => w.code), ['svg-cleaned']);
  assert.match(used.warnings[0]!.message, /use/);
  const animated = accepted(await checkLogo(fixture('nbsp-animate.svg'), 'light', surfaces));
  assert.deepEqual(animated.warnings.map((w) => w.code), ['svg-cleaned']);
  assert.ok(animated.bytes.toString('utf8').includes('North Wind'), 'a no-break space stays a character, never &nbsp;');
});

test('nothing drawable left is refused', async () => {
  const r = refused(await checkLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>x</title></svg>'), 'light', surfaces));
  assert.equal(r.code, 'LOGO_EMPTY');
});

test('type and size: SVG or PNG only, JPEG refused for transparency, and each limit named', async () => {
  const jpeg = refused(await checkLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]), 'light', surfaces));
  assert.equal(jpeg.status, 415);
  assert.match(jpeg.detail, /JPEG is refused because a logo needs a transparent background/);
  const gif = refused(await checkLogo(Buffer.from('GIF89a\x01\x00\x01\x00', 'binary'), 'light', surfaces));
  assert.equal(gif.status, 415);
  assert.equal(gif.code, 'LOGO_TYPE');
  const bigSvg = refused(await checkLogo(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(SVG_MAX_BYTES)}--><rect width="1" height="1"/></svg>`), 'light', surfaces));
  assert.equal(bigSvg.status, 413);
  assert.match(bigSvg.detail, /up to 512 KB/);
  const small = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const tiny = refused(await checkLogo(small, 'light', surfaces));
  assert.equal(tiny.code, 'LOGO_TOO_SMALL');
  assert.match(tiny.detail, /at least 400 pixels on its long side; this one has 200/);
  const huge = Buffer.concat([await sharp({ create: { width: 400, height: 400, channels: 4, background: '#000' } }).png().toBuffer(), Buffer.alloc(PNG_MAX_BYTES)]);
  assert.equal(refused(await checkLogo(huge, 'light', surfaces)).status, 413);
});

/** A 480x160 PNG: a dark bar on a transparent or a white ground. */
async function bar(opts: { alpha: boolean; ink: string; ground?: string }): Promise<Buffer> {
  const ground = opts.alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : opts.ground ?? '#ffffff';
  const ink = await sharp({ create: { width: 320, height: 80, channels: opts.alpha ? 4 : 3, background: opts.ink } }).png().toBuffer();
  const base = sharp({ create: { width: 480, height: 160, channels: opts.alpha ? 4 : 3, background: ground } }).composite([{ input: ink, left: 80, top: 40 }]);
  return (opts.alpha ? base.png() : base.removeAlpha().png()).toBuffer();
}

test('a PNG with a transparent background passes clean; one with no alpha warns it will show as a box', async () => {
  const clear = accepted(await checkLogo(await bar({ alpha: true, ink: '#0b3d91' }), 'light', surfaces));
  assert.deepEqual(clear.warnings, []);
  assert.deepEqual(clear.inks, ['#0b3d91']);
  assert.equal(clear.width, 480);
  const boxed = accepted(await checkLogo(await bar({ alpha: false, ink: '#0b3d91' }), 'light', surfaces));
  assert.deepEqual(boxed.warnings.map((w) => w.code), ['no-transparency']);
  assert.equal(boxed.warnings[0]!.message, 'This logo has no transparent background and will show as a box on coloured surfaces.');
  assert.deepEqual(boxed.inks, ['#0b3d91'], 'the white ground is the box, not the ink');
});

test('ink below 3:1 on the surface a logo is for warns, naming the colour and the ratio', async () => {
  const onDark = accepted(await checkLogo(await bar({ alpha: true, ink: '#0b3d91' }), 'dark', surfaces));
  assert.deepEqual(onDark.warnings.map((w) => [w.code, w.surface, w.colour]), [['low-contrast', 'dark', '#0b3d91']]);
  assert.ok(onDark.warnings[0]!.ratio! < 3);
  assert.match(onDark.warnings[0]!.message, /below 3:1/);
  // A mark is checked on both surfaces.
  const mark = await contrastWarnings(['#808080'], 'mark', { light: '#ffffff', dark: '#000000', source: 'default' });
  assert.deepEqual(mark.map((w) => w.surface), []);
  const faint = await contrastWarnings(['#eeeeee'], 'mark', { light: '#ffffff', dark: '#000000', source: 'default' });
  assert.deepEqual(faint.map((w) => w.surface), ['light']);
});

test('the lead brand\'s surfaces come from its design tokens, with neutral defaults otherwise', async () => {
  const doc = {
    $themes: [
      { name: 'light', selectedTokenSets: { base: 'enabled', light: 'enabled' } },
      { name: 'dark', selectedTokenSets: { base: 'enabled', dark: 'enabled' } },
    ],
    base: { color: { brand: { sugar: { $type: 'color', $value: '#fdfcf8' }, liquorice: { $type: 'color', $value: 'oklch(20% 0.02 260)' } } } },
    light: { color: { semantic: { surface: { $type: 'color', $value: '{color.brand.sugar}' } } } },
    dark: { color: { semantic: { surface: { $type: 'color', $value: '{color.brand.liquorice}' } } } },
  };
  const read = await surfacesFromTokens(doc);
  assert.equal(read.source, 'design-system');
  assert.equal(read.light, '#fdfcf8');
  assert.match(read.dark, /^#[0-9a-f]{6}$/);
  assert.notEqual(read.dark, DEFAULT_SURFACES.dark);
  assert.deepEqual(await surfacesFromTokens(null), DEFAULT_SURFACES);
  assert.deepEqual(await surfacesFromTokens({ base: { color: { x: { $type: 'color', $value: '#123456' } } } }), DEFAULT_SURFACES);
});
