// SPDX-License-Identifier: MPL-2.0
/**
 * The credit line on a collection link page (plans/82 M4, W-M4-7).
 *
 * Pinned here: a file whose licence asks for a credit (a reviewed profile
 * whose obligation is attribution, or one recognised and not yet interpreted
 * that lists Attribution) gets one line under it, with the recorded credit,
 * the licence's name linked to its text and the source when the record names
 * a public address; a dedication, a notice licence, an owner-published file
 * and a file with no licence get none; the line's only links go to the
 * licence and the source; and a single file through the link is unchanged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { loadRightsEngine } from '../server/src/catalog/rights.ts';
import { pageCreditLine } from '../server/src/links/credits.ts';

const OWNER = { works: [{ id: 'x', creators: [{ name: 'Acme', role: 'owner' }], rights: [{ declaration: 'LicenseRef-Owner-Published', assertedBy: 'catalog', evidence: 'catalog-entry', status: 'unparsed' }], grants: [{ kind: 'own-work', scope: 'Ours.', asserted: true }] }] };

test('which licences ask for a credit line, and what the line holds', async () => {
  const engine = await loadRightsEngine();
  const line = (entry: Record<string, unknown>) => pageCreditLine(engine, { id: 'x', ...entry });
  assert.deepEqual(line({ license: 'CC-BY-4.0', attribution: 'Photo by B. Person', rights: { works: [{ id: 'x', creators: [], rights: [], sourceUrl: 'https://example.org/photo' }] } }), {
    text: 'Photo by B. Person', licenceName: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://example.org/photo',
  });
  assert.equal(line({ license: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person' })?.licenceName, 'CC BY-NC 4.0', 'NC lists Attribution: the credit is printed, nothing is interpreted');
  assert.deepEqual(line({ license: 'Apache-2.0' }), { text: '', licenceName: 'Apache License 2.0', licenceUrl: 'https://www.apache.org/licenses/LICENSE-2.0' });
  for (const entry of [{ license: 'CC0-1.0', attribution: 'x' }, { license: 'MIT' }, { rights: OWNER }, {}, { license: 'free for partners' }]) {
    assert.equal(line(entry), null, JSON.stringify(entry));
  }
  assert.equal(line({ license: 'CC-BY-4.0', sourceUrl: 'javascript:alert(1)' })?.sourceUrl, undefined, 'only a public http(s) address becomes a link');
});

let server: Server;
let base = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-page-credits-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const f of ['open.jpg', 'zero.jpg', 'mark.svg']) await writeFile(join(pack, 'catalog', 'assets', 'acme', f), `${f}-bytes`);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'acme/photo/open', name: 'Open photo', type: 'raster', license: 'CC-BY-4.0', attribution: 'Photo by B. Person', formats: [{ format: 'jpg', url: '/catalog/assets/acme/open.jpg' }] },
    { id: 'acme/photo/zero', name: 'Zero photo', type: 'raster', license: 'CC0-1.0', formats: [{ format: 'jpg', url: '/catalog/assets/acme/zero.jpg' }] },
    { id: 'acme/logo/mark', name: 'Acme mark', type: 'vector', rights: OWNER, formats: [{ format: 'svg', url: '/catalog/assets/acme/mark.svg' }] },
  ] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'staff@test', groups: ['marketing'] }] },
  }));
  const store = createMemoryStore();
  await store.putCollection({ id: 'launch-kit', name: 'Launch kit', members: ['acme/photo/open', 'acme/photo/zero', 'acme/logo/mark'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sp', link: 'lp', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

test('the page prints one credit line under the CC BY file, and nowhere else', async () => {
  const login = await fetch(`${base}/api/auth/dev?email=staff%40test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const minted = await fetch(`${base}/api/v1/links`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'share', target: { collectionId: 'launch-kit' } }) });
  const { id, url } = await minted.json() as { id: string; url: string };
  const path = url.replace('http://localhost', base);
  const html = await (await fetch(path)).text();
  const lines = [...html.matchAll(/<span class="item-credit">(.*?)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['Photo by B. Person · <a href="https://creativecommons.org/licenses/by/4.0/" rel="license noopener noreferrer">CC BY 4.0</a>']);
  for (const href of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] as string)) {
    assert.ok(href.startsWith(`/l/${id}?`) || href.startsWith('/api/brand/') || href === 'https://creativecommons.org/licenses/by/4.0/', `only this link, the brand chrome and the licence text: ${href}`);
  }
  assert.doesNotMatch(html, /cleared|verified|included/i);
  const one = await fetch(`${path}&asset=${encodeURIComponent('acme/photo/open')}&dl=1`);
  assert.equal(await one.text(), 'open.jpg-bytes', 'the file itself is unchanged');
});
