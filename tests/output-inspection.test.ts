import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { inspectOutput, outputVerificationProblems, InspectionGap, type InspectionCollectors } from '../server/src/render/output-inspection.ts';

const svg = (attrs = 'width="96" height="48"', body = '<rect width="96" height="48"/>') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);
const target = { format: 'svg', widthPx: 96, heightPx: 48 };
const check = (r: Awaited<ReturnType<typeof inspectOutput>>, id: string) => r.checks.find(c => c.id === id)!;
const image = (format: 'png' | 'jpeg') => sharp({ create: { width: 20, height: 10, channels: 4, background: '#12345680' } })[format]().toBuffer();

test('passive SVG readback reads absolute units without running scripts or fetching resources', async () => {
  const bytes = svg('width="1in" height="36pt"', '<script>throw new Error("must never run")</script><image href="http://127.0.0.1:1/private"/>');
  const report = await inspectOutput(bytes, 'image/svg+xml', target);
  assert.deepEqual(report.measured, { format: 'svg', widthPx: 96, heightPx: 48 });
  assert.deepEqual(outputVerificationProblems(report, bytes, 'image/svg+xml', target), []);
  assert.ok(report.limitations.includes('svg-visibility-and-linked-resources-not-checked'));
  assert.ok(report.limitations.includes('design-acceptance-not-evaluated'));
  assert.deepEqual(await inspectOutput(bytes, 'image/svg+xml', target), report);
});

for (const [name, bytes] of [
  ['malformed', Buffer.from('<svg')],
  ['unclosed', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')],
  ['html-wrapper', Buffer.from('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>')],
  ['wrong-namespace', Buffer.from('<svg xmlns="urn:other"/>')],
  ['multiple-roots', Buffer.concat([svg(), svg()])],
  ['doctype', Buffer.from('<!DOCTYPE svg SYSTEM "http://127.0.0.1:1/private"><svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['empty', Buffer.alloc(0)],
] as const) test(`SVG cannot verify ${name}`, async () => {
  const report = await inspectOutput(bytes, 'image/svg+xml', target);
  assert.notEqual(check(report, 'readability').state, 'pass');
  assert.ok(outputVerificationProblems(report, bytes, 'image/svg+xml', target).length);
});

test('viewBox, percentages and absent dimensions never become a measured viewport', async () => {
  for (const attrs of ['', 'viewBox="0 0 96 48"', 'width="100%" height="100%"']) {
    const report = await inspectOutput(svg(attrs), 'image/svg+xml', target);
    assert.equal(check(report, 'width').state, 'undetermined');
    assert.equal(check(report, 'height').state, 'undetermined');
  }
  const report = await inspectOutput(svg(), 'image/svg+xml', { ...target, widthPx: null, heightPx: null });
  assert.equal(check(report, 'width').state, 'not-applicable');
  assert.equal(check(report, 'width').required, false);
});

test('wrong dimensions and wrong MIME fail independently', async () => {
  const report = await inspectOutput(svg(), 'image/png', { ...target, widthPx: 95 });
  assert.equal(check(report, 'width').state, 'fail');
  assert.equal(check(report, 'mime').state, 'fail');
  assert.equal(check(report, 'height').state, 'pass');
  assert.equal(check(report, 'readability').state, 'pass');
});

for (const format of ['png', 'jpeg'] as const) test(`${format} uses a full decoder on delivered bytes`, async () => {
  const bytes = await image(format);
  const normalized = format === 'jpeg' ? 'jpg' : format;
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const wanted = { format: normalized, widthPx: 20, heightPx: 10 };
  const report = await inspectOutput(bytes, mime, wanted);
  assert.deepEqual(outputVerificationProblems(report, bytes, mime, wanted), []);
  assert.deepEqual(report.measured, { format: normalized, widthPx: 20, heightPx: 10 });
  const corrupt = await inspectOutput(bytes.subarray(0, 40), mime, wanted);
  assert.equal(check(corrupt, 'readability').state, 'fail');
});

test('a format substitution cannot pass because its MIME or requested filename says PNG', async () => {
  const report = await inspectOutput(svg(), 'image/png', { ...target, format: 'png' });
  assert.equal(check(report, 'format').state, 'fail');
  assert.equal(check(report, 'mime').state, 'pass');
});

test('PDF signature recognition is never a completed decoder', async () => {
  const report = await inspectOutput(Buffer.from('%PDF-1.7\n%%EOF'), 'application/pdf', { format: 'pdf', widthPx: 96, heightPx: 48 });
  assert.equal(check(report, 'format').state, 'pass');
  assert.equal(check(report, 'readability').state, 'undetermined');
  assert.equal(check(report, 'width').state, 'undetermined');
  assert.ok(report.limitations.includes('pdf-decoder-unavailable'));
});

test('byte, pixel and dependency limits cannot become passes', async () => {
  const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
  const tooLarge = await inspectOutput(oversized, 'image/png', { ...target, format: 'png' });
  assert.equal(check(tooLarge, 'readability').reason, 'byte-budget-exceeded');
  const bytes = await image('png');
  for (const pixels of [
    async () => ({ format: 'png', width: 4001, height: 4000, pages: 1 }),
    async () => { throw new InspectionGap('pixel-decoder-unavailable'); },
    async () => { throw new Error('sensitive decoder detail'); },
  ]) {
    const collectors: InspectionCollectors = { pixels, svg: async () => { throw new Error('unused'); } };
    const report = await inspectOutput(bytes, 'image/png', { ...target, format: 'png' }, collectors);
    assert.notEqual(check(report, 'readability').state, 'pass');
    assert.doesNotMatch(JSON.stringify(report), /sensitive decoder detail/);
  }
});

test('publication validates coverage, byte digest and target independently of summary claims', async () => {
  const bytes = svg();
  const original = await inspectOutput(bytes, 'image/svg+xml', target);
  const verify = (r: typeof original) => outputVerificationProblems(r, bytes, 'image/svg+xml', target);
  for (const mutate of [
    (r: typeof original) => { r.checks = []; },
    (r: typeof original) => { r.checks[0]!.required = false; },
    (r: typeof original) => { r.checks[0]!.state = 'undetermined'; },
    (r: typeof original) => { r.checks[0] = r.checks[1]!; },
    (r: typeof original) => { r.outputSha256 = 'stale'; },
    (r: typeof original) => { r.target.widthPx = null; },
    (r: typeof original) => { r.target.format = 'png'; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.ok(verify(changed).length);
  }
  assert.ok(outputVerificationProblems(original, svg('width="95" height="48"'), 'image/svg+xml', target).length);
});

test('small dimension errors are real mismatches; unit-conversion roundoff is allowed', async () => {
  const wrong = await inspectOutput(svg('width="0.005" height="48"'), 'image/svg+xml', { ...target, widthPx: 0.006 });
  assert.equal(check(wrong, 'width').state, 'fail');
  const converted = await inspectOutput(svg('width="25.4mm" height="12.7mm"'), 'image/svg+xml', target);
  assert.equal(check(converted, 'width').state, 'pass');
  assert.equal(check(converted, 'height').state, 'pass');
});

test('SVG byte limits, animated PNG and absent XML parser report undetermined coverage', async () => {
  const oversized = svg('width="96" height="48"', `<!--${'x'.repeat(2 * 1024 * 1024)}-->`);
  assert.equal(check(await inspectOutput(oversized, 'image/svg+xml', target), 'readability').state, 'undetermined');
  const collectors: InspectionCollectors = { pixels: async () => { throw new Error('unused'); },
    svg: async () => { throw new InspectionGap('xml-parser-unavailable'); } };
  const unavailable = await inspectOutput(svg(), 'image/svg+xml', target, collectors);
  assert.equal(check(unavailable, 'readability').state, 'undetermined');
  assert.equal(check(unavailable, 'readability').reason, 'xml-parser-unavailable');
  const png = await image('png');
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write('acTL', 4);
  const animated = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  const multiple = await inspectOutput(animated, 'image/png', { ...target, format: 'png' });
  assert.equal(check(multiple, 'readability').state, 'undetermined');
  assert.equal(check(multiple, 'readability').reason, 'multiple-frames-unsupported');
});
