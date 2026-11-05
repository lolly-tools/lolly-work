// SPDX-License-Identifier: MPL-2.0
/**
 * Vendor request to render plan, and render state to vendor response, for every
 * field in the plan's source table. The fixtures below are the request and response
 * examples from each vendor's public documentation, read 2026-11-05. No fixture was
 * recorded from a live account, and none invents a field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkRenderApiConfig, mappingIndex, parseRenderApiMappings } from '../server/src/render-api/mapping.ts';
import { mapBannerbearV2, mapBannerbearV5, mapPlacid, mapPlacidUrl } from '../server/src/render-api/mappers.ts';
import { aggregate, bannerbearV2Wire, bannerbearV5Wire, placidErrorCode, placidWire, type RenderView } from '../server/src/render-api/wire.ts';
import { fileName, formatOfFile, placidUrlSignatureValid, resultUrlSigner } from '../server/src/render-api/signing.ts';
import { RenderApiRefusal, type RenderApiRecord } from '../server/src/render-api/types.ts';
import type { RenderRecord } from '../server/src/renders/types.ts';

const mappings = parseRenderApiMappings([
  { source: 'bannerbear-v5', template: 'abc123def456ghij', toolId: 'card', format: 'png',
    layers: { title: { text: 'heading', color: 'headingColor' }, avatar: { 'background-image': 'image' }, background: { 'background-color': 'background' }, $template: { width: 'width', height: 'height' } },
    ignore: ['$template.transparent', '$request.dpi'], fixed: { theme: 'dark' } },
  { source: 'bannerbear-v2', template: 'jJWBKNELpQPvbX5R93Gk', toolId: 'card', format: 'png',
    layers: { layer1: { text: 'heading' }, photo: { image_url: 'image' } }, ignore: [], fixed: {} },
  { source: 'placid', template: 'ospo24ysn', toolId: 'card', format: 'png',
    layers: { img: { image: 'image' }, subline: { text: 'subheading' }, title: { text: 'heading' }, $modifications: { width: 'width', height: 'height' } }, ignore: [], fixed: {} },
]);
const lookup = mappingIndex(mappings);
const refusal = (run: () => unknown, code: string): RenderApiRefusal => {
  try { run(); } catch (error) {
    assert.ok(error instanceof RenderApiRefusal, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
};

// The verbatim create-image example from Bannerbear's V5 docs.
const v5Example = {
  template: 'abc123def456ghij', formats: ['png', 'jpg', 'pdf', 'webp'], scale: 2, metadata: 'campaign_id:12345',
  modifications: { template: { width: 1200, height: 630, transparent: true },
    objects: [{ name: 'title', text: 'Hello World', color: '#FF5733' }, { name: 'avatar', 'background-image': 'https://example.com/photo.jpg' }, { name: 'background', 'background-color': '#1a1a2e' }] },
};

test('Bannerbear V5: the documented request maps by name, and webp and scale are refused by name', () => {
  const webp = refusal(() => mapBannerbearV5(v5Example, lookup, false), 'FORMAT_NOT_SUPPORTED');
  assert.deepEqual(webp.detail.formats, ['webp']);
  const noWebp = { ...v5Example, formats: ['png', 'jpg', 'pdf'] };
  const scale = refusal(() => mapBannerbearV5(noWebp, lookup, false), 'PROPERTY_NOT_MAPPED');
  assert.deepEqual(scale.detail.properties, ['$request.scale'], 'nothing else in the example is unmapped; transparent is listed under ignore');
  const mapped = mapBannerbearV5({ ...noWebp, scale: 1 }, lookup, false);
  assert.deepEqual(mapped.formats, ['png', 'jpg', 'pdf']);
  assert.deepEqual(mapped.inputs, { width: 1200, height: 630, heading: 'Hello World', headingColor: '#FF5733', image: 'https://example.com/photo.jpg', background: '#1a1a2e', theme: 'dark' });
  assert.equal(mapped.metadata, 'campaign_id:12345');
  assert.equal(mapped.webhookUrl, undefined, 'the V5 create call documents no per-request webhook');
});

test('Bannerbear V5: a layer is addressed by name or id, and defaults fall back to the mapping', () => {
  const mapped = mapBannerbearV5({ template: 'abc123def456ghij', modifications: { objects: [{ id: 'title', type: 'text', text: 'By id' }] } }, lookup, true);
  assert.deepEqual(mapped.inputs, { heading: 'By id', theme: 'dark' });
  assert.deepEqual(mapped.formats, ['png']);
  assert.equal(mapped.immediate, true);
  refusal(() => mapBannerbearV5({ template: 'missing' }, lookup, false), 'TEMPLATE_NOT_MAPPED');
  refusal(() => mapBannerbearV5({ template: 'abc123def456ghij', modifications: { objects: [{ text: 'x' }] } }, lookup, false), 'INVALID_INPUT');
  refusal(() => mapBannerbearV5({ template: 'abc123def456ghij', metadata: 'x'.repeat(5000) }, lookup, false), 'INVALID_INPUT');
  const unmapped = refusal(() => mapBannerbearV5({ template: 'abc123def456ghij', proxy: true, modifications: { objects: [{ name: 'title', 'text-fit': true }, { name: 'ghost', text: 'x' }] } }, lookup, false), 'PROPERTY_NOT_MAPPED');
  assert.deepEqual(unmapped.detail.properties, ['$request.proxy', 'ghost.text', 'title.text-fit'], 'every unclaimed property is named');
  assert.equal(mapBannerbearV5({ template: 'abc123def456ghij', dpi: 300 }, lookup, false).inputs.dpi, undefined, 'a property under ignore is dropped because someone chose that');
});

test('Bannerbear V2: modifications, webhook and PDF follow the documented request', () => {
  const example = { template: 'jJWBKNELpQPvbX5R93Gk', modifications: [{ name: 'layer1', text: 'This is my text' }, { name: 'photo', image_url: 'https://www.pathtomyphoto.com/1.jpg' }] };
  const mapped = mapBannerbearV2({ ...example, webhook_url: 'https://hook.example/x', metadata: 'm', transparent: false }, lookup, false);
  assert.deepEqual(mapped.inputs, { heading: 'This is my text', image: 'https://www.pathtomyphoto.com/1.jpg' });
  assert.equal(mapped.webhookUrl, 'https://hook.example/x');
  assert.deepEqual(mapped.formats, ['png']);
  assert.deepEqual(mapped.echo.modifications, example.modifications, 'the V2 image object repeats modifications');
  assert.deepEqual(mapBannerbearV2({ ...example, render_pdf: true }, lookup, false).formats, ['png', 'pdf']);
  refusal(() => mapBannerbearV2({ ...example, render_pdf: true, webhook_url: 'https://hook.example/x' }, lookup, false), 'WEBHOOK_WITH_PDF_NOT_SUPPORTED');
  const refused = refusal(() => mapBannerbearV2({ ...example, transparent: true, template_version: 3, project_id: 'p', modifications: [{ name: 'layer1', text: 'x', color: '#000', font_family: 'Inter' }] }, lookup, false), 'PROPERTY_NOT_MAPPED');
  assert.deepEqual(refused.detail.properties, ['$request.project_id', '$request.template_version', '$request.transparent', 'layer1.color', 'layer1.font_family']);
  refusal(() => mapBannerbearV2({ template: 'jJWBKNELpQPvbX5R93Gk' }, lookup, false), 'INVALID_INPUT');
});

test('Placid: layers, modifications and passthrough follow the documented request', () => {
  const example = { template_uuid: 'ospo24ysn', layers: { img: { image: 'https://x.test/lion.jpg' }, subline: { text: 'Employee of the month' }, title: { text: 'Meet Singh' } }, webhook_success: 'https://webhook.url', create_now: false, passthrough: null };
  const mapped = mapPlacid({ ...example, errors: [] }, lookup);
  assert.deepEqual(mapped.inputs, { image: 'https://x.test/lion.jpg', subheading: 'Employee of the month', heading: 'Meet Singh' });
  assert.equal(mapped.immediate, false);
  assert.equal(mapped.webhookUrl, 'https://webhook.url');
  assert.equal(mapped.metadata, null);
  assert.equal(mapPlacid({ ...example, create_now: true }, lookup).immediate, true);
  const styled = mapPlacid({ ...example, passthrough: ['a', 1], modifications: { width: 800, height: 600, filename: 'hero.png', image_format: 'jpg', color_mode: 'rgb' } }, lookup);
  assert.deepEqual(styled.formats, ['jpg']);
  assert.equal(styled.filename, 'hero.png');
  assert.equal(styled.inputs.width, 800);
  assert.deepEqual(styled.metadata, ['a', 1]);
  assert.deepEqual(mapPlacid({ ...example, modifications: { image_format: 'auto' } }, lookup).formats, ['png']);
  assert.deepEqual(refusal(() => mapPlacid({ ...example, modifications: { image_format: 'webp' } }, lookup), 'FORMAT_NOT_SUPPORTED').detail.formats, ['webp']);
  refusal(() => mapPlacid({ ...example, transfer: { to: 's3', key: 'k' } }, lookup), 'TRANSFER_NOT_SUPPORTED');
  refusal(() => mapPlacid({ ...example, passthrough: 'x'.repeat(1025) }, lookup), 'INVALID_INPUT');
  const refused = refusal(() => mapPlacid({ template_uuid: 'ospo24ysn', layers: { title: { text: 'x', text_color: '#000' } }, modifications: { dpi: 300, color_mode: 'cmyk' } }, lookup), 'PROPERTY_NOT_MAPPED');
  assert.deepEqual(refused.detail.properties, ['$modifications.color_mode', '$modifications.dpi', 'title.text_color']);
  refusal(() => mapPlacid({ template_uuid: 'nope' }, lookup), 'TEMPLATE_NOT_MAPPED');
});

test('Placid URL API: layer[property] parameters map, and a signature parameter is not an input', () => {
  const mapped = mapPlacidUrl('ospo24ysn', new URLSearchParams('title[text]=Hello%20friend%21&s=abc'), lookup);
  assert.deepEqual(mapped.inputs, { heading: 'Hello friend!' });
  assert.equal(mapped.immediate, true);
  assert.deepEqual(refusal(() => mapPlacidUrl('ospo24ysn', new URLSearchParams('title=bare'), lookup), 'PROPERTY_NOT_MAPPED').detail.properties, ['$request.title']);
});

test('the Placid URL signature is HMAC-SHA256 of the query, and the documented leading & form verifies', () => {
  const secret = 'old-private-token';
  const query = 'author[text]=asdf';
  const hmac = (text: string) => createHmac('sha256', secret).update(text).digest('hex');
  assert.equal(placidUrlSignatureValid(`${query}&s=${hmac(`&${query}`)}`, secret), true, 'the form in the vendor example');
  assert.equal(placidUrlSignatureValid(`${query}&s=${hmac(query)}`, secret), true, 'the same query without the leading character');
  assert.equal(placidUrlSignatureValid(`${query}&s=${hmac('other')}`, secret), false);
  assert.equal(placidUrlSignatureValid(`${query}&s=${hmac(query)}`, 'another-token'), false);
  assert.equal(placidUrlSignatureValid(`s=${hmac(query)}&${query}`, secret), false, 'anything after the signature would not be covered by it');
  assert.equal(placidUrlSignatureValid(query, secret), false);
  assert.equal(placidUrlSignatureValid(`${query}&s=short`, secret), false);
});

const record: RenderApiRecord = {
  id: 'rec1', seq: 41, source: 'bannerbear-v5', template: 'abc123def456ghij', principal: 'service:svc_t', formats: ['png', 'pdf'], renders: { png: 'r1', pdf: 'r2' },
  metadata: 'campaign_id:12345', echo: {}, createdAt: '2026-03-15T04:51:17.550Z',
};
const render = (over: Partial<RenderRecord>): RenderRecord => ({
  id: 'r1', principal: 'service:svc_t', request: { toolId: 'card', format: 'png', inputs: {}, priority: 0, maxAttempts: 3 }, requestHash: 'h', state: 'succeeded',
  attempt: 1, createdAt: '2026-03-15T04:51:18.000Z', updatedAt: '2026-03-15T04:51:20.000Z', availableAt: '2026-03-15T04:51:18.000Z', finishedAt: '2026-03-15T04:51:20.574Z',
  output: { name: 'default', ref: 'b', mime: 'image/png', size: 1, sha256: 'x', cacheKey: 'c' }, ...over,
});
const view = (rec: RenderApiRecord, renders: RenderView['renders']): RenderView => ({
  record: rec, renders, self: `https://work.test/self/${rec.id}`, fileUrl: (format) => `https://work.test/file.${format}`,
});
const keys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

test('Bannerbear V5 wire: the documented image object, field for field', () => {
  const done = bannerbearV5Wire(view(record, { png: render({}), pdf: render({ id: 'r2', finishedAt: '2026-03-15T04:51:21.000Z' }) }));
  assert.deepEqual(keys(done), ['completed_at', 'created_at', 'files', 'lolly', 'metadata', 'self', 'status', 'template', 'uid']);
  assert.equal(done.uid, 'rec1'); assert.equal(done.status, 'completed'); assert.equal(done.template, 'abc123def456ghij');
  assert.deepEqual(done.files, { png: 'https://work.test/file.png', pdf: 'https://work.test/file.pdf' });
  assert.equal(done.metadata, 'campaign_id:12345'); assert.equal(done.self, 'https://work.test/self/rec1');
  assert.equal(done.created_at, '2026-03-15T04:51:17.550Z'); assert.equal(done.completed_at, '2026-03-15T04:51:21.000Z');
  const pending = bannerbearV5Wire(view(record, { png: render({}), pdf: render({ id: 'r2', state: 'running', output: undefined, finishedAt: undefined }) }));
  assert.equal(pending.status, 'pending'); assert.equal(pending.completed_at, null);
  assert.deepEqual(pending.files, { png: 'https://work.test/file.png', pdf: null }, 'files values are null while pending');
  assert.equal('error' in pending, false, 'error is only present on failure');
  const failed = bannerbearV5Wire(view(record, { png: render({}), pdf: render({ id: 'r2', state: 'failed', output: undefined, error: { code: 'INPUT_LOCKED', message: 'heading is locked' } }) }));
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'heading is locked');
  assert.deepEqual((failed.lolly as { error: unknown }).error, { code: 'INPUT_LOCKED', message: 'heading is locked' });
});

test('Bannerbear V2 wire: the documented image object, field for field', () => {
  const rec: RenderApiRecord = { ...record, source: 'bannerbear-v2', formats: ['png', 'pdf'], webhookUrl: 'https://hook.example/x', metadata: null,
    echo: { modifications: [{ name: 'layer1', text: 'x' }], transparent: false, render_pdf: true } };
  const wire = bannerbearV2Wire({ ...view(rec, { png: render({ output: { name: 'default', ref: 'b', mime: 'image/png', size: 1, sha256: 'x', cacheKey: 'c', evidence: { context: { widthPx: null, heightPx: null }, inspection: { measured: { format: 'png', widthPx: 1000, heightPx: 1000 } } } as never } }), pdf: render({ id: 'r2' }) }), webhookResponseCode: 200 });
  assert.deepEqual(keys(wire), ['created_at', 'height', 'image_url', 'lolly', 'metadata', 'modifications', 'pdf_url', 'render_pdf', 'self', 'status', 'template', 'transparent', 'uid', 'webhook_response_code', 'webhook_url', 'width']);
  assert.equal(wire.status, 'completed'); assert.equal(wire.image_url, 'https://work.test/file.png'); assert.equal(wire.pdf_url, 'https://work.test/file.pdf');
  assert.equal(wire.width, 1000); assert.equal(wire.height, 1000); assert.equal(wire.webhook_response_code, 200); assert.equal(wire.render_pdf, true); assert.equal(wire.transparent, false);
  const pending = bannerbearV2Wire(view({ ...rec, formats: ['png'], echo: { modifications: [] } }, { png: render({ state: 'queued', output: undefined, finishedAt: undefined }) }));
  assert.equal(pending.status, 'pending'); assert.equal(pending.image_url, null); assert.equal(pending.pdf_url, null); assert.equal(pending.width, null); assert.equal(pending.webhook_response_code, null);
});

test('Placid wire: statuses and error fields follow the documented object', () => {
  const rec: RenderApiRecord = { ...record, source: 'placid', formats: ['png'], renders: { png: 'r1' }, metadata: 'pass' };
  const finished = placidWire(view(rec, { png: render({}) }));
  assert.deepEqual(keys(finished), ['id', 'image_url', 'lolly', 'passthrough', 'polling_url', 'status']);
  assert.equal(finished.id, 41); assert.equal(finished.status, 'finished'); assert.equal(finished.image_url, 'https://work.test/file.png');
  assert.equal(finished.polling_url, 'https://work.test/self/rec1'); assert.equal(finished.passthrough, 'pass');
  assert.equal(placidWire(view(rec, { png: render({ state: 'running', output: undefined }) })).status, 'queued');
  const failed = placidWire(view(rec, { png: render({ state: 'failed', output: undefined, error: { code: 'INPUT_LOCKED', message: 'locked' } }) }));
  assert.equal(failed.status, 'error'); assert.equal(failed.image_url, null); assert.equal(failed.error_code, 'INVALID_INPUT'); assert.equal(failed.error_message, 'locked'); assert.deepEqual(failed.error_details, []);
  assert.equal(placidWire(view(rec, { png: render({ state: 'cancelled', output: undefined }) })).error_code, 'CANCELLED');
  assert.equal(placidErrorCode('SOMETHING_NEW'), 'INTERNAL', 'Placid says to treat an unknown code as INTERNAL');
  assert.equal(placidErrorCode('OUTPUT_UNAVAILABLE'), 'STORAGE_FAILED');
  assert.equal(aggregate(view(rec, { png: null })), 'pending');
});

test('an expired output gives no result URL, and the state stays completed', () => {
  const wire = bannerbearV5Wire(view({ ...record, formats: ['png'] }, { png: render({ output: { name: 'default', ref: 'b', mime: 'image/png', size: 1, sha256: 'x', cacheKey: 'c', expiredAt: '2026-04-01T00:00:00.000Z' } }) }));
  assert.equal(wire.status, 'completed');
  assert.deepEqual(wire.files, { png: null });
});

test('result URLs carry an expiry and a signature, and are stable within a period', () => {
  const signer = resultUrlSigner('url-secret', 30);
  const finishedAt = '2026-01-01T00:00:00.000Z';
  const now = Date.parse('2026-01-10T00:00:00.000Z');
  const url = signer.url('https://work.test', 'rec1', 'png', finishedAt, undefined, now);
  assert.equal(signer.url('https://work.test', 'rec1', 'png', finishedAt, undefined, now + 3_600_000), url, 'polling does not change the URL');
  const [, , , , , id, expires, signature, file] = url.split('/');
  assert.equal(id, 'rec1'); assert.equal(file, 'image.png');
  assert.equal(Number(expires), Date.parse(finishedAt) + 30 * 86_400_000, 'it runs from when the render finished');
  assert.equal(signer.verify('rec1', 'png', expires!, signature!, now), 'ok');
  assert.equal(signer.verify('rec1', 'png', expires!, signature!, Number(expires) + 1), 'expired');
  assert.equal(signer.verify('rec2', 'png', expires!, signature!, now), 'invalid');
  assert.equal(signer.verify('rec1', 'jpg', expires!, signature!, now), 'invalid');
  assert.equal(signer.verify('rec1', 'png', String(Number(expires) + 86_400_000), signature!, now), 'invalid', 'the expiry is signed');
  assert.equal(resultUrlSigner('another', 30).verify('rec1', 'png', expires!, signature!, now), 'invalid');
  const later = signer.url('https://work.test', 'rec1', 'png', finishedAt, undefined, Date.parse('2026-03-01T00:00:00.000Z'));
  assert.notEqual(later, url, 'an owner polling after expiry gets a working URL again');
  assert.equal(fileName('hero.png', 'png'), 'hero.png'); assert.equal(fileName('hero', 'jpg'), 'hero.jpg'); assert.equal(formatOfFile('image.pdf'), 'pdf'); assert.equal(formatOfFile('noext'), null);
});

test('the mapping and config are checked before anything runs', () => {
  const entry = { source: 'placid', template: 't', toolId: 'card', format: 'png', layers: {} };
  assert.throws(() => parseRenderApiMappings([entry, entry]), /mapped twice/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, source: 'canva' }]), /source must be/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, toolId: 'Not A Tool' }]), /toolId/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, format: 'webp' }]), /format must be/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, extra: 1 }]), /unknown field/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, layers: { a: { b: 'not an input!' } } }]), /must name a tool input/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, source: 'bannerbear-v5', url: {} }]), /Placid templates only/);
  assert.throws(() => parseRenderApiMappings([{ ...entry, url: { credentialRef: 'lower case' } }]), /environment variable/);
  assert.equal(parseRenderApiMappings([{ ...entry, format: 'jpeg' }])[0]!.format, 'jpg');
  assert.deepEqual(checkRenderApiConfig({ enabled: false, templates: [], resultUrls: { signedDays: 30 }, urlApi: {} }), { enabled: false, templates: [], resultUrls: { signedDays: 30 }, urlApi: {} });
  assert.throws(() => checkRenderApiConfig({ enabled: 'yes', resultUrls: { signedDays: 30 } }), /enabled/);
  assert.throws(() => checkRenderApiConfig({ enabled: true, resultUrls: { signedDays: -1 } }), /signedDays/);
  assert.throws(() => checkRenderApiConfig({ enabled: true, resultUrls: { signedDays: 30 }, other: 1 }), /unknown field/);
});
