/**
 * `--shape`, the live-verify multiplier (plans/33 §3), over every driver that
 * carries live-verify debt: the four DAMs, and `webdav`, whose debt is the same
 * shape for a different reason - its property names and URL templates come from
 * RFC 4918 and Nextcloud's documentation rather than from a tenant. Injected
 * fetch, no network and no server: what a driver reports back is key names and
 * value TYPES, the three-way diff against the constants it reads, and the layout
 * an operator reads on tenant day.
 *
 * The pinned invariant, and the reason this file exists: NO FIXTURE VALUE MAY
 * APPEAR IN ANY REPORT OUTPUT. Every fixture below sets its string values to a
 * `LEAK-` prefix, and the redaction test asserts that prefix appears nowhere in
 * the rendered lines or the JSON. Custom-field KEY names are the one thing that
 * does travel (they are upstream-authored), which is asserted too, because it is
 * the caveat the runbooks state rather than a bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCantoProvider } from '../server/src/catalog/providers/canto.ts';
import { createImageRelayProvider } from '../server/src/catalog/providers/imagerelay.ts';
import { createIntelligenceBankProvider } from '../server/src/catalog/providers/intelligencebank.ts';
import { createAcquiaDamProvider } from '../server/src/catalog/providers/acquia-dam.ts';
import { createWebdavProvider } from '../server/src/catalog/providers/webdav.ts';
import { describeValue, noShapeLine, renderShapeReport, type ProviderShapeReport } from '../server/src/catalog/providers/shape.ts';

const CRED = (rt: string) => JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: rt });

/** Every value a fixture carries is prefixed, so a leak is unmistakable. */
const V = (s: string) => `LEAK-${s}`;
const LEAK = /LEAK-/;

function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; status?: number }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const route = routes.find((r) => r.match(String(input), init?.method ?? 'GET'));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const tokenRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/token'), body: { access_token: V('tok'), expires_in: 3600 } };
const text = (r: ProviderShapeReport): string => renderShapeReport(r).join('\n');

// --- fixtures: one page per driver, values all prefixed -------------------

const CANTO_PAGE = {
  results: [
    {
      id: V('AB12'), scheme: 'image', name: V('banner.png'), size: 2048,
      lastModified: V('2026-06-01'), approvalStatus: V('approved'),
      tag: [V('event')], keyword: [V('2026')], album: V('Campaigns'),
      additional: { 'Expiry Date': V('2027-01-01'), Campaign: V('summit') },
      thumbnailUrl: V('https://example.invalid/t.png'),
    },
    { id: V('CD34'), scheme: 'image', name: V('draft.png'), thumbnailUrl: null },
  ],
  found: 2, limit: 100, start: 0,
};

const IR_PAGE = {
  files: [{
    id: 55, filename: V('summit.png'), name: V('Summit'), extension: V('png'), size: 2048,
    updated_at: V('2026-06-01'), keywords: [V('event')], deleted: false,
    folder: { id: 9, name: V('Campaigns') }, custom_fields: { 'Expiry Date': V('2027-01-01') },
    quick_link: V('https://example.invalid/q'),
  }],
  meta: { next_page: null },
};

const IB_LOGIN = { sid: V('sid1'), apiV3url: 'https://api.intelligencebank.com/v3', clientid: V('cl1'), expires_in: 3600 };
const IB_PAGE = {
  resources: [{
    resourceid: V('r1'), filename: V('hero.png'), extension: V('png'), size: 4096,
    updated: V('2026-06-01'), folder: { id: V('f1'), name: V('Brand') }, category: V('Heroes'),
    workflow_state: V('Approved'), publish_date: V('2026-01-01'), expiry_date: V('2027-01-01'),
    checked_out_by: V('someone'),
  }],
  meta: { next_page: null },
};

const WIDEN_PAGE = {
  total_count: 1,
  items: [{
    id: V('a1b2c3'), filename: V('hero.png'), status: V('active'),
    release_date: V('2026-01-01'), expiration_date: V('2027-01-01'), last_update_date: V('2026-06-01'),
    file_properties: { format: V('png'), size_in_kbytes: 20 },
    categories: [{ name: V('Web Heroes') }],
    security: { scope: V('public') },
  }],
};

const canto = () => createCantoProvider('sh-canto', { tenant: 'acme', minGapMs: 0 }, CRED('rt'),
  fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: CANTO_PAGE }]));
const imagerelay = () => createImageRelayProvider('sh-ir', {}, CRED('rt'),
  fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: IR_PAGE }]));
const intelligencebank = () => createIntelligenceBankProvider('sh-ib', { platformUrl: 'https://acme.intelligencebank.com' }, V('apikey'),
  fakeFetch([{ match: (u, m) => m === 'POST' && u.includes('/authenticate'), body: IB_LOGIN }, { match: (u) => u.includes('/v3/resources'), body: IB_PAGE }]));
const acquia = () => createAcquiaDamProvider('sh-wd', {}, V('tok'),
  fakeFetch([{ match: (u) => u.includes('/assets?'), body: WIDEN_PAGE }]));

/**
 * A WebDAV server, as a 207 multistatus. It has two leak surfaces the JSON
 * drivers above do not, and both are prefixed here so a regression is caught:
 * the HREFS, because a file path is content and the report deliberately carries
 * none, and the Nextcloud LOGIN NAME, which is half the Basic credential and so
 * is printed as the `<username>` template rather than the value. The custom
 * property's KEY name is left unprefixed on purpose: an upstream-authored key
 * is the one thing that legitimately travels, which the caveat test asserts.
 */
const DAV_LISTING = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:x="http://example.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/${V('login')}/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/${V('login')}/${V('unreleased-campaign')}.png</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>${V('2048')}</d:getcontentlength>
        <d:getlastmodified>${V('Mon, 01 Jun 2026 09:30:00 GMT')}</d:getlastmodified>
        <d:getcontenttype>${V('image/png')}</d:getcontenttype>
        <oc:tags><oc:tag>${V('embargoed')}</oc:tag></oc:tags>
        <x:expiry-date>${V('2027-01-01')}</x:expiry-date>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

/** WebDAV answers XML, not JSON, so it gets its own one-route fetch. */
const davFetch = (xml: string): typeof fetch => (async () =>
  new Response(xml, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } })) as typeof fetch;

const webdav = () => createWebdavProvider('sh-dav',
  { baseUrl: 'https://cloud.example', flavor: 'nextcloud', minGapMs: 0 },
  `${V('login')}:${V('app-password')}`, davFetch(DAV_LISTING));

// --- the layout (§3) -------------------------------------------------------

test('canto: the report is the §3 layout - endpoint, envelope, record types, and the three-way diff', async () => {
  const r = await canto().sampleShape?.() as ProviderShapeReport;
  const out = text(r);

  assert.equal(r.kind, 'canto');
  assert.equal(r.endpoint, 'GET /api/v1/image?limit=100&start=0');
  assert.equal(r.recordsKey, 'results');
  assert.equal(r.recordCount, 2);
  assert.match(out, /^canto {2}GET \/api\/v1\/image\?limit=100&start=0$/m, 'the header names the call this came from');
  assert.match(out, /envelope: results: object\[\] \(2\)/, 'the record array is counted, not printed');
  assert.match(out, /found: number/);

  // Types, never values - and one level into the custom-field bag.
  assert.match(out, /id: string/);
  assert.match(out, /tag: string\[\]/);
  assert.match(out, /additional: \{ Expiry Date: string, Campaign: string \}/, 'nested objects describe one level in');

  assert.deepEqual(r.mapped.slice(0, 4), ['results', 'id', 'name', 'scheme']);
  assert.ok(r.unmapped.includes('thumbnailUrl'), 'a key upstream sent that the driver ignores');
  assert.ok(r.unmapped.includes('found') && r.unmapped.includes('limit'));
  assert.ok(!r.absent.includes('album|folder (SECTION_KEYS)'), 'album is present, so SECTION_KEYS is not a wrong guess');
  assert.deepEqual(r.absent, [], 'this tenant named everything the way the driver guessed');
  assert.match(out, /EXPECTED BY THIS DRIVER, ABSENT: \(none\)/);
  assert.match(out, /note: the binary path this driver would call .* is \/api_binary\/v1\/<scheme>\/<id> \(BINARY_PATH\)/);
});

test('canto: a key set the driver expects and did not get is reported with the constant to edit', async () => {
  // The same driver against a tenant that names things differently: no scheme,
  // an id under another name, and no custom-field bag at all.
  const provider = createCantoProvider('sh-canto2', { tenant: 'acme', minGapMs: 0 }, CRED('rt2'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ assetId: V('X1'), title: V('t.png') }] } }]));
  const r = await provider.sampleShape?.() as ProviderShapeReport;
  const out = text(r);
  assert.ok(r.absent.includes('id (RECORD_ID_KEYS)'), 'the wrong guess names its constant');
  assert.ok(r.absent.includes('scheme (SCHEME_KEYS)'));
  assert.ok(r.absent.includes('lastModified|lastUploaded|time (UPDATED_AT_KEYS)'));
  assert.ok(r.unmapped.includes('assetId') && r.unmapped.includes('title'), 'the answer sits directly above the wrong guess');
  assert.match(out, /EXPECTED BY THIS DRIVER, ABSENT: /);
});

test('a wrong envelope key is reported, not thrown, by the shape path: it is what the report is for', async () => {
  const provider = createCantoProvider('sh-canto3', { tenant: 'acme', minGapMs: 0 }, CRED('rt3'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { records: [{ id: V('X') }], total: 1 } }]));
  const r = await provider.sampleShape?.() as ProviderShapeReport;
  assert.equal(r.recordsKey, null);
  assert.ok(r.absent.includes('results|assets|data (LIST_ENVELOPE_KEYS)'));
  assert.ok(r.unmapped.includes('records'), 'the real envelope key is right there');
  assert.match(text(r), /record: \(no record array found/);
});

test('imagerelay, intelligencebank and acquia-dam each report their own structure and constants', async () => {
  const ir = await imagerelay().sampleShape?.() as ProviderShapeReport;
  assert.equal(ir.endpoint, 'GET /api/v2/files?per_page=100&page=1');
  assert.equal(ir.recordsKey, 'files');
  assert.match(text(ir), /custom_fields: \{ Expiry Date: string \}/);
  assert.ok(ir.unmapped.includes('quick_link'));
  assert.ok(ir.mapped.includes('meta') && ir.mapped.includes('keywords'));

  const ib = await intelligencebank().sampleShape?.() as ProviderShapeReport;
  assert.equal(ib.endpoint, 'GET <apiV3url>/resources?per_page=100&page=1');
  assert.equal(ib.recordsKey, 'resources');
  assert.ok(ib.unmapped.includes('checked_out_by'));
  assert.ok(ib.mapped.includes('resourceid') && ib.mapped.includes('workflow_state'));

  const wd = await acquia().sampleShape?.() as ProviderShapeReport;
  assert.equal(wd.endpoint, 'GET /v2/assets?limit=100&offset=0&expand=file_properties,embeds,thumbnails');
  assert.equal(wd.recordsKey, 'items');
  assert.ok(wd.unmapped.includes('security'));
  assert.ok(wd.absent.includes('embeds|_links (EMBED_KEYS / LINKS_KEYS)'), 'a list record carries no embed until ?expand asks for one');
  assert.match(text(wd), /file_properties: \{ format: string, size_in_kbytes: number \}/);
});

// --- the detail call: the byte path's own guesses --------------------------

/** The single-asset responses, values prefixed like every other fixture. */
const IR_DETAIL = { file: { id: 55, filename: V('summit.png'), size: 2048, download_url: V('https://example.invalid/d'), quick_link: V('https://example.invalid/q') } };
const IB_DETAIL = { resource: { resourceid: V('r1'), size: 4096, download_url: V('https://example.invalid/d') } };
const WIDEN_DETAIL = {
  id: V('a1b2c3'), filename: V('hero.png'),
  embeds: { original: { url: V('https://example.invalid/o'), share: V('s') } },
  _links: { download: { href: V('https://example.invalid/d') } },
};

const irDetail = () => createImageRelayProvider('sh-ir-d', {}, CRED('rt'),
  fakeFetch([tokenRoute, { match: (u) => /\/files\/55$/.test(u), body: IR_DETAIL }, { match: (u) => u.includes('/files'), body: IR_PAGE }]));
const ibDetail = () => createIntelligenceBankProvider('sh-ib-d', { platformUrl: 'https://acme.intelligencebank.com' }, V('apikey2'),
  fakeFetch([{ match: (u, m) => m === 'POST' && u.includes('/authenticate'), body: IB_LOGIN }, { match: (u) => u.includes('/v3/resource/'), body: IB_DETAIL }]));
const widenDetail = () => createAcquiaDamProvider('sh-wd-d', {}, V('tok'),
  fakeFetch([{ match: (u) => u.includes('/assets/'), body: WIDEN_DETAIL }]));

test('detailShape reports the per-asset call the bytes come from, wrapper included', async () => {
  const ir = await irDetail().detailShape?.('55') as ProviderShapeReport;
  assert.equal(ir.scope, 'detail');
  assert.equal(ir.endpoint, 'GET /api/v2/files/55');
  assert.equal(ir.recordsKey, 'file', 'which wrapper the tenant used is reported, not assumed');
  assert.ok(ir.mapped.includes('file') && ir.mapped.includes('download_url'));
  assert.ok(ir.unmapped.includes('quick_link'), 'and the link the driver does NOT read is named beside it');
  assert.match(text(ir), /record: \(the one record this call returned, wrapped in "file"\)/);

  const ib = await ibDetail().detailShape?.('r1') as ProviderShapeReport;
  assert.equal(ib.endpoint, 'GET <apiV3url>/resource/r1');
  assert.equal(ib.recordsKey, 'resource');
  assert.ok(ib.mapped.includes('download_url'));

  // Widen wraps nothing, and its link is nested two levels down - which is the
  // whole reason the detail report descends further than the list one.
  const wd = await widenDetail().detailShape?.('a1b2c3') as ProviderShapeReport;
  assert.equal(wd.recordsKey, '(unwrapped)');
  assert.match(text(wd), /record: \(the one record this call returned, not wrapped\)/);
  assert.match(text(wd), /embeds: \{ original: \{ url: string, share: string \} \}/);
  assert.match(text(wd), /_links: \{ download: \{ href: string \} \}/);
  assert.ok(wd.absent.includes('file_properties (FILE_PROPERTIES_KEYS)'), 'an expand this call does not ask for reads as absent, with the note that says so');
});

test('a detail call that wraps its record under an unknown key diagnoses itself', async () => {
  const ir = createImageRelayProvider('sh-ir-d2', {}, CRED('rt'),
    fakeFetch([tokenRoute, { match: (u) => /\/files\/55$/.test(u), body: { result: { id: 55, download_url: V('https://example.invalid/d') } } }]));
  const r = await ir.detailShape?.('55') as ProviderShapeReport;
  assert.ok(r.absent.includes('download_url (DOWNLOAD_URL_KEYS)'), 'the guess that resolveBlob would fail on is named');
  assert.ok(r.unmapped.includes('result'), 'with the real wrapper key right beside it');
});

test('REDACTION holds for the detail report too - it is the one an operator sends back', async () => {
  for (const [make, id] of [[irDetail, '55'], [ibDetail, 'r1'], [widenDetail, 'a1b2c3']] as const) {
    const r = await make().detailShape?.(id) as ProviderShapeReport;
    assert.doesNotMatch(text(r), LEAK, `a value reached the rendered detail report for ${r.kind}`);
    assert.doesNotMatch(JSON.stringify(r), LEAK, `a value reached the detail report JSON for ${r.kind}`);
    assert.ok(r.record.length > 1, `${r.kind} detail report named nothing`);
  }
});

test('canto makes no detail call, so it implements only the list arm', async () => {
  const { noDetailShapeLine } = await import('../server/src/catalog/providers/shape.ts');
  assert.equal(canto().detailShape, undefined, 'its binary path is built from the list record');
  assert.match(noDetailShapeLine('canto'), /makes no per-asset detail call/);
});

// --- the safety invariant (§3) --------------------------------------------

test('REDACTION: no fixture value reaches the report, in any driver, rendered or as JSON', async () => {
  for (const make of [canto, imagerelay, intelligencebank, acquia, webdav]) {
    const r = await make().sampleShape?.() as ProviderShapeReport;
    const rendered = text(r);
    const json = JSON.stringify(r);
    assert.doesNotMatch(rendered, LEAK, `a value reached the rendered report for ${r.kind}`);
    assert.doesNotMatch(json, LEAK, `a value reached the report JSON for ${r.kind}`);
    // The report is not empty of substance: it named keys and types.
    assert.ok(r.record.length > 3 && r.mapped.length > 3, `${r.kind} reported nothing useful`);
  }
});

test('webdav: the two things only this kind could leak - the hrefs and the login name - stay out', async () => {
  const r = await webdav().sampleShape?.() as ProviderShapeReport;
  const out = text(r);
  // The endpoint is the one line built from configuration rather than from the
  // response, and the login name it would otherwise carry is half the Basic
  // credential, so it prints the template the report's own caveat promises.
  assert.equal(r.endpoint, 'PROPFIND /remote.php/dav/files/<username>/ (Depth: 1)');
  assert.doesNotMatch(out, /login/, 'the Nextcloud login name is never printed, not even as a key');
  assert.doesNotMatch(out, /remote\.php\/dav\/files\/LEAK/, 'no href reaches the report: a file path is content');
  // It still says something useful: the property names, and the diff.
  assert.deepEqual(r.record.map((f) => f.key).sort(),
    ['expiry-date', 'getcontentlength', 'getcontenttype', 'getlastmodified', 'resourcetype', 'tags']);
  assert.deepEqual(r.absent, [], 'every property this driver asks for came back');
  assert.deepEqual(r.unmapped, ['expiry-date'], 'the custom property is reported as one this driver ignores');
});

test('the caveat is honest: upstream-authored KEY names do travel, and the report says so', async () => {
  const r = await canto().sampleShape?.() as ProviderShapeReport;
  const out = text(r);
  assert.match(out, /Expiry Date/, 'a custom-field key name is upstream-authored and does appear');
  assert.match(out, /note: custom-field key names are upstream-authored/);
  assert.match(out, /read it before pasting it into a public ticket/);
  assert.doesNotMatch(out, LEAK, 'the VALUE under that key still does not');
});

// --- the shared helpers ----------------------------------------------------

test('describeValue reports types only, one level into objects, element types for arrays', () => {
  assert.equal(describeValue('x'), 'string');
  assert.equal(describeValue(7), 'number');
  assert.equal(describeValue(null), 'null');
  assert.equal(describeValue(true), 'boolean');
  assert.equal(describeValue([]), 'empty[]');
  assert.equal(describeValue(['a', 'b']), 'string[]');
  assert.equal(describeValue(['a', 1]), 'number|string[]');
  assert.equal(describeValue([{ a: 1 }]), 'object[]', 'an array of records is not unrolled inline');
  assert.equal(describeValue({ a: 'x', b: 2 }), '{ a: string, b: number }');
  assert.equal(describeValue({ a: { b: { c: 'x' } } }), '{ a: object }', 'the second level collapses');
});

test('every other kind carries no live-verify debt: no sampleShape, and --shape says why', async () => {
  const { createProvider } = await import('../server/src/catalog/providers/registry.ts');
  const rec = {
    id: 'm1', kind: 'mock' as const, label: 'm', managedBy: 'db' as const, enabled: true,
    options: { assets: [] }, mapping: {}, exposure: {}, sync: {},
    createdAt: '', updatedAt: '', state: { assetCount: 0 },
  };
  assert.equal(createProvider(rec, undefined, {}).sampleShape, undefined);
  assert.match(noShapeLine('mock'), /mock: this driver carries no live-verify debt/);
});
