// SPDX-License-Identifier: MPL-2.0
/**
 * Instance asset checksums in the served feed are SRI (schemas/asset.schema.json:
 * `sha256-<base64>`), never the blob store's hex digest.
 *
 * A release shell, such as lolly.ing's, verifies the signed asset index and then
 * checks every format's checksum against the SRI form. One hex checksum made it
 * refuse the whole index: the page loaded no tools, and a Design rules render by
 * a partner programme member timed out in the render worker (a 502). The feed
 * now converts at serve time, so rows stored before the change are covered too.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { composeInstanceAssets, instanceAssetEntry, sriChecksum, type InstanceAssetRecord } from '../server/src/catalog/instance-assets.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';

/**
 * The release shell's check, copied from Lolly's
 * shells/web/src/catalog/asset-integrity.ts (assetFormatIntegrity and
 * assetIndexIntegrity), which a Work checkout cannot import. A content format
 * needs a full SHA-256 SRI checksum; a format with none must be a scoped
 * provider reference.
 */
function releaseShellRefusal(index: unknown, catalogScope?: string): string | undefined {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const segment = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(v);
  const invalid = 'a signed asset format has no SHA-256 checksum';
  const formatRefusal = (asset: unknown, format: unknown): string | undefined => {
    if (!record(format)) return invalid;
    if (format.checksum !== undefined) {
      return typeof format.checksum === 'string' && /^sha256-[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(format.checksum) ? undefined : invalid;
    }
    if (!catalogScope || !/^[0-9a-f]{64}$/.test(catalogScope) || !record(asset) || !segment(asset.provider) || typeof asset.id !== 'string'
      || typeof asset.version !== 'string' || !/^[0-9a-f]{16}$/.test(asset.version) || typeof format.url !== 'string') return invalid;
    const identity = asset.id.split('/');
    if (identity.length !== 3 || identity[0] !== 'ext' || identity[1] !== asset.provider || !segment(identity[2])) return invalid;
    const prefix = `/catalog/${asset.id}/`;
    return format.url.startsWith(prefix) && segment(format.url.slice(prefix.length)) ? undefined : invalid;
  };
  if (!record(index) || !Array.isArray(index.assets)) return 'the signed asset index has no assets list';
  for (const asset of index.assets) {
    if (!record(asset) || (asset.formats !== undefined && !Array.isArray(asset.formats))
      || (asset.locales !== undefined && !record(asset.locales))) return 'the signed asset formats are invalid';
    const localized = Object.values(asset.locales ?? {});
    if (localized.some((formats) => !Array.isArray(formats))) return 'the signed asset formats are invalid';
    for (const format of [...(asset.formats as unknown[] ?? []), ...(localized as unknown[][]).flat()]) {
      const refusal = formatRefusal(asset, format);
      if (refusal) return refusal;
    }
  }
  return undefined;
}

const BYTES = Buffer.from('{"values":{"price":"€ 990"}}');
const HEX = createHash('sha256').update(BYTES).digest('hex');
const SRI = `sha256-${createHash('sha256').update(BYTES).digest('base64')}`;
const OTHER_SRI = `sha256-${createHash('sha256').update('another file').digest('base64')}`;

const row = (id: string, formats: Array<{ format: string; size: number; checksum: string }>, extra: Partial<InstanceAssetRecord> = {}): InstanceAssetRecord => ({
  id, entry: instanceAssetEntry(id, { name: id, type: 'template' }, formats), blobs: {}, groups: ['team'], createdAt: '2026-11-07T00:00:00.000Z', ...extra,
});
/** A format's checksum, read without trusting the feed's shape. */
const checksumOf = (format: unknown): unknown => (format as { checksum?: unknown } | undefined)?.checksum;
const pack: AssetIndex = { assets: [{ id: 'acme/logo', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg', checksum: OTHER_SRI }] }] };

test('sriChecksum turns a hex SHA-256 into SRI and leaves every other value alone', () => {
  assert.equal(sriChecksum(HEX), SRI);
  assert.equal(sriChecksum(SRI), SRI);
  assert.equal(sriChecksum(HEX.toUpperCase()), HEX.toUpperCase(), 'only the lower-case hex the blob store writes');
  assert.equal(sriChecksum('abc'), 'abc');
  assert.equal(sriChecksum(undefined), undefined);
});

test('an inst/* row with a hex checksum is served as SRI, its localized formats too', () => {
  const hex = row('inst/tmpl', [{ format: 'json', size: BYTES.length, checksum: HEX }]);
  (hex.entry as Record<string, unknown>).locales = { de: [{ format: 'json', url: '/catalog/inst/tmpl/json-de', size: BYTES.length, checksum: HEX }] };
  const served = composeInstanceAssets(pack, [hex], ['team']);
  const entry = served.assets!.find((a) => a.id === 'inst/tmpl')!;
  assert.equal(checksumOf(entry.formats![0]), SRI);
  assert.equal(checksumOf((entry.locales as Record<string, unknown[]>).de![0]), SRI);
  assert.equal(checksumOf(hex.entry.formats![0]), HEX, 'the stored record is not changed');
  assert.deepEqual(served.assets!.find((a) => a.id === 'acme/logo'), pack.assets![0], 'a pack row is untouched');
});

test('an inst/* row that already carries SRI is left as it is', () => {
  const sri = row('inst/logo', [{ format: 'png', size: 10, checksum: OTHER_SRI }]);
  const entry = composeInstanceAssets(pack, [sri], ['team']).assets!.find((a) => a.id === 'inst/logo')!;
  assert.equal(checksumOf(entry.formats![0]), OTHER_SRI);
});

test('the release shell accepts the served index, and refused the hex one', () => {
  const records = [row('inst/tmpl', [{ format: 'json', size: BYTES.length, checksum: HEX }]), row('inst/logo', [{ format: 'png', size: 10, checksum: OTHER_SRI }])];
  assert.equal(releaseShellRefusal(composeInstanceAssets(pack, records, ['team'])), undefined);
  const raw: AssetIndex = { assets: [...pack.assets!, ...records.map((r) => r.entry)] };
  assert.equal(releaseShellRefusal(raw), 'a signed asset format has no SHA-256 checksum', 'the check this guards against');
});

// Over HTTP: the feed a member receives, and the bytes behind it.
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('the served feed carries SRI for a blob-store instance asset, and it matches the bytes served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-inst-sri-'));
  await mkdir(join(dir, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(dir, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(dir, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(dir, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SRI', baseUrl: 'http://localhost', pack: dir }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'member@test', groups: ['team'] }] },
  }));
  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const stat = await blobs.put('inst/tmpl/json', BYTES, 'application/json');
  assert.match(stat.checksum, /^[0-9a-f]{64}$/, 'the blob store records hex');
  await store.putInstanceAsset({ id: 'inst/tmpl', entry: instanceAssetEntry('inst/tmpl', { name: 'Template', type: 'template' },
    [{ format: 'json', size: stat.size, checksum: stat.checksum }]), blobs: { json: 'inst/tmpl/json' }, groups: ['team'], createdAt: '2026-11-07T00:00:00.000Z' });
  const app = buildApp({ config, store, blobs, secrets: { session: 's', link: 'l' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const cookie = (await fetch(`${base}/api/auth/dev?email=member@test`, { redirect: 'manual' })).headers.getSetCookie()
    .find((c) => c.startsWith('lw_session='))!.split(';')[0]!;

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json() as AssetIndex;
  const format = feed.assets!.find((a) => a.id === 'inst/tmpl')!.formats![0] as unknown as { url: string; checksum: string };
  assert.equal(format.checksum, SRI);
  assert.equal(releaseShellRefusal(feed), undefined, 'a release shell accepts the feed');
  const bytes = Buffer.from(await (await fetch(base + format.url, { headers: { cookie } })).arrayBuffer());
  assert.equal(`sha256-${createHash('sha256').update(bytes).digest('base64')}`, format.checksum, 'the checksum describes the bytes served');
});
