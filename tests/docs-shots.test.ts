/**
 * The documentation screenshots are a corpus with two invariants, mirroring the
 * OSS docs' docs-shots-vector.test.ts:
 *
 *  1. Every committed shot is a VECTOR SVG. A raster PNG is allowed ONLY if it is
 *     in RASTER_ALLOWLIST with a written reason - and the test fails BOTH ways: an
 *     unlisted .png, and a listed slug that is no longer raster. That second
 *     direction is the point: a workaround must not silently become permanent.
 *  2. Every `![](shots/…)` reference in the docs resolves to a committed file, and
 *     every committed shot carries a VALID C2PA credential recording a screen
 *     capture - so a shot can never quietly ship unsigned or claim the wrong origin.
 *
 * Shots are produced by scripts/capture-console.ts. This test reads only what is
 * committed under docs/shots/, so it needs no browser and runs in the normal suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHOTS_DIR = fileURLToPath(new URL('../docs/shots/', import.meta.url));
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));

// Bitmap shots, each with a reason. Empty today: every console screen is vector.
const RASTER_ALLOWLIST = new Map<string, string>([]);

const SCREEN_SOURCE = 'screenCapture';

const shotFiles = (): string[] =>
  existsSync(SHOTS_DIR) ? readdirSync(SHOTS_DIR).filter((f) => /\.(svg|png)$/i.test(f)) : [];

test('every committed shot is a vector SVG unless allowlisted (fails both ways)', () => {
  const files = shotFiles();
  assert.ok(files.length > 0, 'no shots committed under docs/shots/ — run scripts/capture-console.ts');
  for (const f of files) {
    const isPng = f.toLowerCase().endsWith('.png');
    if (isPng) {
      assert.ok(RASTER_ALLOWLIST.has(f), `${f} is a raster PNG but not in RASTER_ALLOWLIST — add it with a reason, or capture it as SVG`);
    }
  }
  // The other direction: a listed slug that is no longer a committed raster.
  for (const [f, reason] of RASTER_ALLOWLIST) {
    assert.ok(existsSync(`${SHOTS_DIR}${f}`) && f.toLowerCase().endsWith('.png'),
      `RASTER_ALLOWLIST lists ${f} (${reason}) but it is not a committed PNG — remove the stale entry`);
  }
});

test('every shot referenced in the docs resolves to a committed file', () => {
  const md = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  const refs = new Set<string>();
  for (const f of md) {
    const text = readFileSync(`${DOCS_DIR}${f}`, 'utf8');
    for (const m of text.matchAll(/!\[[^\]]*\]\(shots\/([a-z0-9][a-z0-9.-]*\.(?:svg|png))\)/gi)) {
      refs.add(m[1]!);
    }
  }
  assert.ok(refs.size > 0, 'no docs page references a shot');
  for (const ref of refs) {
    assert.ok(existsSync(`${SHOTS_DIR}${ref}`), `docs reference shots/${ref} but that file is not committed`);
  }
});

test('every committed shot carries a valid, screen-capture C2PA credential', async () => {
  const engineSpec: string = '@lolly/engine';
  const eng = await import(engineSpec) as {
    verifyC2pa: (b: Uint8Array, o?: { trustAnchors?: Uint8Array[] }) => Promise<{
      state: string; claim?: { actions?: Array<{ digitalSourceType?: string }> };
      history?: Array<{ digitalSourceType?: string }>;
    }>;
  };
  for (const f of shotFiles()) {
    const bytes = new Uint8Array(readFileSync(`${SHOTS_DIR}${f}`));
    const report = await eng.verifyC2pa(bytes, { trustAnchors: [] });
    assert.equal(report.state, 'valid', `${f}: credential does not verify as valid (state=${report.state})`);
    const steps = [...(report.claim?.actions ?? []), ...(report.history ?? [])];
    assert.ok(
      steps.some((s) => typeof s.digitalSourceType === 'string' && s.digitalSourceType.includes(SCREEN_SOURCE)),
      `${f}: credential does not record a screenCapture source — a screenshot must not over-claim its origin`,
    );
  }
});
