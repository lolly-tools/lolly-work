/**
 * Self-diagnosing failures (plans/33 §4) and tolerance (§5) across the four DAM
 * drivers that carry live-verify debt. Injected fetch, no network and no tenant.
 *
 * The rule every case here pins: a failure that depends on a GUESSED key name
 * must say which assumption broke and where to fix it - the constant to edit,
 * the file it lives in, the `--shape` command that shows the real structure, and
 * that kind's runbook page. A wrong guess should cost one line of reading, not
 * an afternoon of source diving.
 *
 * Where widening is cheap the guess degrades instead of failing (§5): a missing
 * optional federates without it, a missing REQUIRED id still fails loudly, and
 * what a page could not map surfaces as `skipped` rather than as silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCantoProvider } from '../server/src/catalog/providers/canto.ts';
import { createImageRelayProvider } from '../server/src/catalog/providers/imagerelay.ts';
import { createIntelligenceBankProvider } from '../server/src/catalog/providers/intelligencebank.ts';
import { createAcquiaDamProvider } from '../server/src/catalog/providers/acquia-dam.ts';
import { buildFragment } from '../server/src/catalog/federation.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';

const CRED = (rt: string) => JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: rt });
const IB_PLATFORM = 'https://acme.intelligencebank.com';
const IB_LOGIN = { sid: 'sid1', apiV3url: 'https://api.intelligencebank.com/v3', clientid: 'cl1' };

function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const route = routes.find((r) => r.match(String(input), init?.method ?? 'GET'));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const tokenRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/token'), body: { access_token: 'tok', expires_in: 3600 } };
const loginRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/authenticate'), body: IB_LOGIN };

/**
 * The whole contract of a live-verify failure, in one assertion: it opens with
 * the kind, names the broken assumption, the constant to edit, the file, the
 * command that shows the real structure, and the runbook page.
 */
function namesItsRemedy(message: string, kind: string, constant: string): void {
  assert.ok(message.startsWith(`${kind} `), `does not open with the kind: ${message}`);
  assert.ok(message.includes('(live-verify: '), `does not name the assumption: ${message}`);
  assert.ok(message.includes(`lw providers preview --kind ${kind} --shape`), `does not name the diagnostic: ${message}`);
  assert.ok(message.includes(`fix ${constant} in server/src/catalog/providers/${kind}.ts`), `does not name the constant: ${message}`);
  assert.ok(message.includes(`docs/providers/${kind}-live-verify.md`), `does not name the runbook: ${message}`);
}

const collect = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (err) { return (err as Error).message; }
  assert.fail('expected a live-verify failure');
};

// --- §4.1 the list envelope key -------------------------------------------

test('no record array in the list response names the envelope-key guess, in all four drivers', async () => {
  const cases: Array<{ kind: string; run: () => Promise<unknown> }> = [
    {
      kind: 'canto',
      run: () => createCantoProvider('lv1', { tenant: 'acme', minGapMs: 0 }, CRED('a'),
        fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { records: [], total: 0 } }])).listAssets(),
    },
    {
      kind: 'imagerelay',
      run: () => createImageRelayProvider('lv2', {}, CRED('b'),
        fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: { entries: [] } }])).listAssets(),
    },
    {
      kind: 'intelligencebank',
      run: () => createIntelligenceBankProvider('lv3', { platformUrl: IB_PLATFORM }, 'k',
        fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: { docs: [] } }])).listAssets(),
    },
    {
      kind: 'acquia-dam',
      run: () => createAcquiaDamProvider('lv4', {}, 'tok',
        fakeFetch([{ match: (u) => u.includes('/assets?'), body: { assets: [] } }])).listAssets(),
    },
  ];
  for (const c of cases) {
    const msg = await collect(c.run);
    assert.ok(msg.includes('list response carried no record array'), msg);
    namesItsRemedy(msg, c.kind, 'LIST_ENVELOPE_KEYS');
  }
});

test('an empty page is not a failure: the envelope key was found, it just held nothing', async () => {
  const canto = createCantoProvider('lv5', { tenant: 'acme', minGapMs: 0, albumId: 'AL1' }, CRED('c'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/album/AL1?'), body: { results: [] } }]));
  const page = await canto.listAssets();
  assert.deepEqual(page.assets, []);
  assert.equal(page.skipped, undefined);
});

// --- §4.2 zero assets mapped from a non-empty page -------------------------

test('canto: a page of records that all fail to map names the record-field guess', async () => {
  const canto = createCantoProvider('lv6', { tenant: 'acme', minGapMs: 0, albumId: 'AL1' }, CRED('d'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/album/AL1?'), body: { results: [{ assetId: 'X1' }, { assetId: 'X2' }] } }]));
  const msg = await collect(() => canto.listAssets());
  assert.ok(msg.includes('mapped none of the 2 record(s)'), msg);
  namesItsRemedy(msg, 'canto', 'RECORD_ID_KEYS / SCHEME_KEYS');
});

test('a record with no id at all fails loudly rather than federating an id nothing can resolve', async () => {
  const ir = createImageRelayProvider('lv7', {}, CRED('e'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: { files: [{ filename: 'a.png' }] } }]));
  namesItsRemedy(await collect(() => ir.listAssets()), 'imagerelay', 'RECORD_ID_KEYS');

  const ib = createIntelligenceBankProvider('lv8', { platformUrl: IB_PLATFORM }, 'k',
    fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: { resources: [{ filename: 'a.png' }] } }]));
  namesItsRemedy(await collect(() => ib.listAssets()), 'intelligencebank', 'RECORD_ID_KEYS');

  const wd = createAcquiaDamProvider('lv9', {}, 'tok',
    fakeFetch([{ match: (u) => u.includes('/assets?'), body: { items: [{ filename: 'a.png' }] } }]));
  namesItsRemedy(await collect(() => wd.listAssets()), 'acquia-dam', 'RECORD_ID_KEYS');
});

test('intelligencebank: a login that answers 200 but not with the expected names says exactly that', async () => {
  const ib = createIntelligenceBankProvider('lv10', { platformUrl: IB_PLATFORM }, 'k',
    fakeFetch([{ match: (u, m) => m === 'POST' && u.includes('/authenticate'), body: { token: 't', api_url: 'https://api.intelligencebank.com/v3' } }]));
  const msg = await collect(() => ib.listAssets());
  assert.ok(msg.includes('login returned no sid/apiV3url'), msg);
  namesItsRemedy(msg, 'intelligencebank', 'SESSION_ID_KEYS / API_BASE_KEYS');
});

// --- §4.3 the binary path / download link ----------------------------------

test('canto: a binary 404 on an id that listed moments ago names the api_binary path guess', async () => {
  const canto = createCantoProvider('lv11', { tenant: 'acme', minGapMs: 0 }, CRED('f'), fakeFetch([tokenRoute]));
  const msg = await collect(() => canto.resolveBlob('image:AB12', 'download'));
  assert.ok(msg.startsWith('canto blob fetch 404'), 'the existing error voice is unchanged');
  namesItsRemedy(msg, 'canto', 'BINARY_PATH');
});

test('a detail response with no download link names the link field and the wrapper it might sit in', async () => {
  const ir = createImageRelayProvider('lv12', {}, CRED('g'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/files/55'), body: { file: { id: 55, url: 'https://assets.imagerelay.com/x' } } }]));
  namesItsRemedy(await collect(() => ir.resolveBlob('55', 'download')), 'imagerelay', 'DOWNLOAD_URL_KEYS / DETAIL_WRAPPER_KEYS');

  const ib = createIntelligenceBankProvider('lv13', { platformUrl: IB_PLATFORM }, 'k',
    fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resource/r1'), body: { resource: { resourceid: 'r1', href: 'https://cdn.intelligencebank.com/x' } } }]));
  namesItsRemedy(await collect(() => ib.resolveBlob('r1', 'download')), 'intelligencebank', 'DOWNLOAD_URL_KEYS / DETAIL_WRAPPER_KEYS');

  const wd = createAcquiaDamProvider('lv14', {}, 'tok',
    fakeFetch([{ match: (u) => u.includes('/assets/a1'), body: { id: 'a1', thumbnails: {} } }]));
  namesItsRemedy(await collect(() => wd.resolveBlob('a1', 'original')), 'acquia-dam', 'EMBED_KEYS / LINKS_KEYS / DOWNLOAD_URL_KEYS');
});

test('a link that reads fine but 404s at the CDN says so, rather than reporting a missing asset', async () => {
  const ir = createImageRelayProvider('lv15', {}, CRED('h'), fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/files/55'), body: { file: { id: 55, download_url: 'https://assets.imagerelay.com/f/55' } } },
    { match: (u) => u.startsWith('https://assets.imagerelay.com/'), body: {}, status: 404 },
  ]));
  namesItsRemedy(await collect(() => ir.resolveBlob('55', 'download')), 'imagerelay', 'DOWNLOAD_URL_KEYS');

  const wd = createAcquiaDamProvider('lv16', {}, 'tok', fakeFetch([
    { match: (u) => u.includes('/assets/a1'), body: { id: 'a1', embeds: { original: { url: 'https://embed.widencdn.net/o/a1' } } } },
    { match: (u) => u.startsWith('https://embed.widencdn.net/'), body: {}, status: 404 },
  ]));
  namesItsRemedy(await collect(() => wd.resolveBlob('a1', 'original')), 'acquia-dam', 'EMBED_KEYS / LINKS_KEYS');
});

// --- §4.4 an approval filter that excludes everything ----------------------

test('an approval set that matches no record on the page is reported as a note, not a dead federation', async () => {
  const canto = createCantoProvider('lv17', { tenant: 'acme', minGapMs: 0 }, CRED('i'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image', name: 'a.png', approvalStatus: 'Approved' }] } }]));
  const page = await canto.listAssets();
  assert.equal(page.assets.length, 1, 'the assets still federate - exposure decides what that means');
  assert.equal(page.assets[0]?.approved, false);
  const note = page.notes?.[0] as string;
  assert.ok(note.includes('treated all 1 asset(s) on this page as not approved'), note);
  namesItsRemedy(note, 'canto', 'APPROVAL_STATE_KEYS and options.approvedStates');

  const ib = createIntelligenceBankProvider('lv18', { platformUrl: IB_PLATFORM, approvedStates: ['approved'] }, 'k',
    fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: { resources: [{ resourceid: 'r1', workflow_state: 'Approved' }] } }]));
  namesItsRemedy((await ib.listAssets()).notes?.[0] as string, 'intelligencebank', 'WORKFLOW_STATE_KEYS and options.approvedStates');

  const wd = createAcquiaDamProvider('lv19', {}, 'tok',
    fakeFetch([{ match: (u) => u.includes('/assets?'), body: { items: [{ id: 'a1', status: 'released' }] } }]));
  namesItsRemedy((await wd.listAssets()).notes?.[0] as string, 'acquia-dam', 'STATUS_KEYS and options.approvedStatuses');
});

test('an approval set that matches leaves no note behind', async () => {
  const canto = createCantoProvider('lv20', { tenant: 'acme', minGapMs: 0 }, CRED('j'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image', approvalStatus: 'approved' }] } }]));
  assert.equal((await canto.listAssets()).notes, undefined);
});

// --- §4.5 an availability mapping that never matches -----------------------

test('a configured availability field that matched nothing names the custom-field bag key', async () => {
  const canto = createCantoProvider('lv21', { tenant: 'acme', minGapMs: 0 }, CRED('k'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image', metadata: { 'Expiry Date': '2027-01-01' } }] } }]),
    { until: 'Expiry Date' });
  const note = (await canto.listAssets()).notes?.[0] as string;
  assert.ok(note.includes('read no availability window from any record'), note);
  namesItsRemedy(note, 'canto', 'CUSTOM_FIELD_BAG_KEYS (or mapping.availabilityFields)');

  const ir = createImageRelayProvider('lv22', {}, CRED('l'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: { files: [{ id: 55, metadata: { 'Expiry Date': '2027-01-01' } }] } }]),
    { until: 'Expiry Date' });
  namesItsRemedy((await ir.listAssets()).notes?.[0] as string, 'imagerelay', 'CUSTOM_FIELD_BAG_KEYS (or mapping.availabilityFields)');
});

test('with no availability mapping configured there is nothing to warn about', async () => {
  const canto = createCantoProvider('lv23', { tenant: 'acme', minGapMs: 0 }, CRED('m'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image', approvalStatus: 'approved' }] } }]));
  assert.equal((await canto.listAssets()).notes, undefined);
});

// --- §5 tolerance ----------------------------------------------------------

test('a missing optional degrades to a missing field; the record still federates', async () => {
  const canto = createCantoProvider('lv24', { tenant: 'acme', minGapMs: 0 }, CRED('n'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image' }] } }]));
  const a = (await canto.listAssets()).assets[0];
  assert.equal(a?.remoteId, 'image:A1');
  assert.equal(a?.updatedAt, undefined, 'no stamp under any of UPDATED_AT_KEYS, and no throw');
  assert.deepEqual(a?.tags, []);
  assert.deepEqual(a?.sections, []);
  assert.equal(a?.approved, true, 'no approval state at all is not the same as not approved');
});

test('a null optional reads exactly like an absent one', async () => {
  const wd = createAcquiaDamProvider('lv25', {}, 'tok',
    fakeFetch([{ match: (u) => u.includes('/assets?'), body: { items: [{ id: 'a1', filename: 'x.png', release_date: null, expiration_date: null, status: 'active' }] } }]));
  const a = (await wd.listAssets()).assets[0];
  assert.equal(a?.availableFrom, undefined);
  assert.equal(a?.availableUntil, undefined);
  assert.equal(a?.approved, true);
});

test('a widened key alternative is picked up without any other change', async () => {
  // UPDATED_AT_KEYS lists three names; a tenant using the third is read the same.
  const canto = createCantoProvider('lv26', { tenant: 'acme', minGapMs: 0 }, CRED('o'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [{ id: 'A1', scheme: 'image', time: '2026-06-01T00:00:00.000Z' }] } }]));
  assert.equal((await canto.listAssets()).assets[0]?.updatedAt, '2026-06-01T00:00:00.000Z');
});

test('skipped is counted and visible, never silent', async () => {
  const canto = createCantoProvider('lv27', { tenant: 'acme', minGapMs: 0 }, CRED('p'), fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/api/v1/image?'), body: { results: [
      { id: 'A1', scheme: 'image', name: 'ok.png' },
      { id: 'a/b', scheme: 'image', name: 'bad-id.png' },
      { id: 'A3', scheme: 'image', name: 'ok2.png' },
    ] } },
    { match: (u) => /\/(video|audio|document|presentation|other)\?/.test(u), body: { results: [] } },
  ]));
  const page = await canto.listAssets();
  assert.equal(page.assets.length, 2);
  assert.equal(page.skipped, 1, 'the record the mapper refused is counted, not dropped in silence');

  // And it survives the walk, onto the fragment the sync result reports from.
  const rec: ProviderRecord = {
    id: 'lv27', kind: 'canto', label: 'c', managedBy: 'db', enabled: true,
    options: {}, mapping: {}, exposure: {}, sync: {},
    createdAt: '', updatedAt: '', state: { assetCount: 0 },
  };
  const fragment = await buildFragment(rec, canto, () => 0);
  assert.equal(fragment.assets.length, 2);
  assert.equal(fragment.skipped, 1);
});

test('notes survive the walk onto the fragment, deduplicated', async () => {
  const canto = createCantoProvider('lv28', { tenant: 'acme', minGapMs: 0, albumId: 'AL1' }, CRED('q'),
    fakeFetch([tokenRoute, { match: (u) => u.includes('/album/AL1?'), body: { results: [{ id: 'A1', scheme: 'image', approvalStatus: 'Approved' }] } }]));
  const rec: ProviderRecord = {
    id: 'lv28', kind: 'canto', label: 'c', managedBy: 'db', enabled: true,
    options: {}, mapping: {}, exposure: {}, sync: {},
    createdAt: '', updatedAt: '', state: { assetCount: 0 },
  };
  const fragment = await buildFragment(rec, canto, () => 0);
  assert.equal(fragment.notes?.length, 1);
  namesItsRemedy(fragment.notes?.[0] as string, 'canto', 'APPROVAL_STATE_KEYS and options.approvedStates');
});
