// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
const modulePath: string = '../console/project-transfer.js';
const { projectTransferCard } = await import(modulePath);
const preview = {
  schema: 'lolly-project-transfer-inventory-v1', mode: 'preview', readOnly: true,
  snapshotConsistent: false, complete: false, importReady: false, observedAt: '2026-10-08T13:00:00.000Z',
  project: { id: 'prj_preview', name: 'Shared keynote', archived: false },
  counts: { folders: 2, sessions: 3, files: 1, declaredFileBytes: 4096, explicitMembers: 4, omittedSessions: 1 },
  coverage: { fileBytesVerified: false, assetDependenciesComplete: false, historyComplete: false, identitiesMapped: false },
  folders: [], sessions: [], files: [], access: { members: [] },
  warnings: ['NON_SNAPSHOT', 'ASSET_DEPENDENCIES_NOT_INSPECTED', 'HISTORY_INCOMPLETE', 'IDENTITIES_REQUIRE_MAPPING',
    'FILE_BYTES_NOT_VERIFIED', 'LIVE_COLLABORATION', 'SESSION_ACCESS_OMITTED', 'FOLDER_REFERENCES_UNRESOLVED'],
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(answer: (path: string) => Promise<unknown> = async () => preview, id = 'prj_preview', save?: (value: unknown, filename: string) => unknown) {
  const dom = new JSDOM('<body/>', { url: 'https://work.test/admin#/projects' });
  const calls: string[] = [], downloads: Array<{ value: unknown; filename: string }> = [];
  function el(tag: string, attrs: Record<string, unknown> = {}, ...children: any[]) {
    const node = dom.window.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== undefined && child !== null) node.append(child?.nodeType ? child : dom.window.document.createTextNode(String(child)));
    return node;
  }
  const card = projectTransferCard(id, { el, api: async (path: string) => { calls.push(path); return answer(path); },
    download: async (value: unknown, filename: string) => { downloads.push({ value, filename }); await save?.(value, filename); } });
  dom.window.document.body.append(card);
  return { dom, card, calls, downloads, previewButton: card.querySelectorAll('button')[0], downloadButton: card.querySelectorAll('button')[1],
    status: card.querySelector('[role="status"]') };
}

test('transfer card is lazy, uses existing classes and announces loading without duplicate requests', async () => {
  let finish: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const f = fixture(async () => pending);
  assert.equal(f.card.className, 'card stack');
  assert.equal(f.card.querySelector('h3').textContent, 'Prepare to move this project');
  assert.equal(f.previewButton.textContent, 'Preview transfer');
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloadButton.hidden, true);
  assert.equal(f.status.getAttribute('aria-live'), 'polite');
  f.previewButton.click();
  assert.equal(f.card.getAttribute('aria-busy'), 'true');
  assert.equal(f.previewButton.disabled, true);
  assert.match(f.status.textContent, /Checking project metadata/);
  f.previewButton.dispatchEvent(new f.dom.window.Event('click'));
  assert.deepEqual(f.calls, ['/api/v1/projects/prj_preview/transfer-inventory']);
  finish(preview); await tick();
  assert.equal(f.card.hasAttribute('aria-busy'), false);
  assert.equal(f.previewButton.disabled, false);
  assert.equal(f.previewButton.textContent, 'Refresh preview');
  f.dom.window.close();
});

test('summary discloses declared bytes, scope gaps, live editing, omissions and folder issues', async () => {
  const f = fixture(); f.previewButton.click(); await tick();
  assert.match(f.card.textContent, /2 folders.*3 visible sessions.*4 explicit members/);
  assert.match(f.card.textContent, /1 ready shared files.*4,096 declared file bytes \(unverified\)/);
  assert.match(f.card.textContent, /not a consistent snapshot/);
  assert.match(f.card.textContent, /verify file bytes and asset dependencies.*retained history.*destination accounts and groups/);
  assert.match(f.card.textContent, /leaves editing sessions running/);
  assert.match(f.card.textContent, /1 session was excluded/);
  assert.match(f.card.textContent, /folder references could not be resolved/);
  assert.equal(f.card.querySelector('time').getAttribute('datetime'), preview.observedAt);
  assert.equal(f.downloadButton.disabled, false);
  f.downloadButton.click(); await tick();
  assert.deepEqual(f.downloads, [{ value: preview, filename: 'lolly-prj_preview-transfer-preview.json' }]);
  assert.match(f.status.textContent, /private project metadata/);
  f.dom.window.close();
});

test('the complete metadata contract remains unchanged when downloaded', async () => {
  const value = { ...preview, observationStartedAt: preview.observedAt, observationSha256: 'a'.repeat(64), invalidFolderReferences: 1,
    coverage: { ...preview.coverage, pendingUploadsInspected: false, deletedSessionsInspected: false, liveGesturesInspected: false,
      legacyRevisionHistory: { inspected: false, retentionLimit: 20 },
      sessionVersionHistory: { sampled: true, sampleLimitPerSession: 100, fullHistoryVerified: false } },
    limits: { sessions: 200, files: 2000, folders: 1000, members: 2000 },
    folders: [{ id: 'fld_1', parentId: null, sessionIds: ['ses_1'], fileIds: ['file_1'] }],
    sessions: [{ id: 'ses_1', toolId: 'design', toolVersion: '1.0.0', revision: 42, updatedAt: preview.observedAt,
      activeCollaborationLease: true, versionSample: { count: 2, limit: 100, moreMayExist: false } }],
    files: [{ id: 'file_1', declaredBytes: 4096, declaredSha256: 'b'.repeat(64), contentType: 'image/png', partCount: 1, bytesVerified: false }],
    access: { ownerId: 'usr_owner', visibility: { groups: ['designers'] }, general: { audience: 'restricted', role: 'viewer' },
      groups: [{ kind: 'directory', name: 'designers', role: 'editor', expiresAt: null }, { kind: 'custom', id: 'group_team', role: 'viewer', expiresAt: null }],
      settings: { viewersCanComment: true, viewersCanExport: true, editorsCanShare: false },
      members: [{ userId: 'usr_1', role: 'editor', expiresAt: null }], destinationMappingRequired: true } };
  const f = fixture(async () => value); f.previewButton.click(); await tick();
  assert.equal(f.downloadButton.hidden, false);
  f.downloadButton.click(); await tick();
  assert.deepEqual(f.downloads, [{ value, filename: 'lolly-prj_preview-transfer-preview.json' }]);
  f.dom.window.close();
});

test('refresh invalidates old details and downloads immediately; a failure permits retry', async () => {
  let attempt = 0, refuse: (error: unknown) => void = () => {};
  const pending = new Promise<unknown>((_resolve, reject) => { refuse = reject; });
  const f = fixture(async () => ++attempt === 1 ? preview : attempt === 2 ? pending : { ...preview, counts: { ...preview.counts, files: 2 } });
  f.previewButton.click(); await tick();
  f.previewButton.click();
  assert.equal(f.downloadButton.hidden, true);
  assert.equal(f.downloadButton.disabled, true);
  assert.equal(f.card.textContent.includes('Shared keynote'), false);
  f.downloadButton.dispatchEvent(new f.dom.window.Event('click')); await tick();
  assert.equal(f.downloads.length, 0);
  refuse(Object.assign(new Error('private error payload'), { status: 403, body: { token: 'private bearer' } })); await tick();
  assert.equal(f.previewButton.textContent, 'Try again');
  assert.equal(f.card.textContent.includes('private error payload'), false);
  assert.equal(f.card.textContent.includes('private bearer'), false);
  f.downloadButton.dispatchEvent(new f.dom.window.Event('click')); await tick();
  assert.equal(f.downloads.length, 0);
  f.previewButton.click(); await tick();
  assert.equal(f.calls.length, 3);
  assert.match(f.card.textContent, /2 ready shared files/);
  f.dom.window.close();
});

test('error statuses produce friendly guidance and never expose raw error text, codes or bodies', async () => {
  for (const [status, message] of [[401, /Sign in again/], [403, /project manager access/], [404, /unavailable/], [413, /exceeds the preview limits/], [429, /Wait a moment/], [502, /instance status/]] as const) {
    const f = fixture(async () => { throw Object.assign(new Error('ERROR_SECRET'), { status, code: 'SECRET_CODE', body: { cookie: 'COOKIE_SECRET' } }); });
    f.previewButton.click(); await tick();
    assert.match(f.status.textContent, message);
    for (const secret of ['ERROR_SECRET', 'SECRET_CODE', 'COOKIE_SECRET']) assert.equal(f.card.textContent.includes(secret), false);
    assert.equal(f.downloadButton.hidden, true);
    assert.equal(f.downloads.length, 0);
    f.dom.window.close();
  }
});

test('unsupported status flags, schema, project and counts never enable a download', async () => {
  for (const value of [null, { ...preview, schema: 'another-schema' }, { ...preview, mode: 'export' }, { ...preview, readOnly: false },
    { ...preview, snapshotConsistent: true }, { ...preview, complete: true }, { ...preview, importReady: true },
    { ...preview, project: { ...preview.project, id: 'prj_another' } }, { ...preview, counts: { ...preview.counts, declaredFileBytes: '4096' } },
    { ...preview, observedAt: 'not a time' }]) {
    const f = fixture(async () => value); f.previewButton.click(); await tick();
    assert.match(f.status.textContent, /unsupported preview/);
    assert.equal(f.downloadButton.hidden, true);
    f.downloadButton.dispatchEvent(new f.dom.window.Event('click')); await tick();
    assert.equal(f.downloads.length, 0);
    f.dom.window.close();
  }
});

test('project text is rendered as text without executing HTML', async () => {
  const name = '<img src=x onerror="window.pwned=true">';
  const value = { ...preview, project: { ...preview.project, name } };
  const f = fixture(async () => value); f.previewButton.click(); await tick();
  assert.equal(f.card.querySelector('img'), null);
  assert.equal(f.card.textContent.includes(name), true);
  assert.equal(f.dom.window.pwned, undefined);
  const source = readFileSync(new URL('../console/project-transfer.js', import.meta.url), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  f.dom.window.close();
});

test('unexpected document content and credential fields cannot become downloadable metadata', async () => {
  for (const value of [
    { ...preview, token: 'PRIVATE_SECRET' },
    { ...preview, project: { ...preview.project, cookie: 'PRIVATE_SECRET' } },
    { ...preview, sessions: [{ id: 'ses_1', inputs: { password: 'PRIVATE_SECRET' } }] },
    { ...preview, files: [{ id: 'file_1', url: 'https://private.invalid/?token=PRIVATE_SECRET' }] },
    { ...preview, access: { members: [{ userId: 'usr_1', email: 'private@example.test', tokenHash: 'PRIVATE_SECRET' }] } },
    { ...preview, folders: [{ id: 'fld_1', parentId: null, sessionIds: [{ inputs: 'PRIVATE_SECRET' }], fileIds: [] }] },
    { ...preview, observationSha256: { credential: 'PRIVATE_SECRET' } },
  ]) {
    const f = fixture(async () => value); f.previewButton.click(); await tick();
    assert.match(f.status.textContent, /unsupported preview/);
    assert.equal(f.card.textContent.includes('PRIVATE_SECRET'), false);
    assert.equal(f.card.textContent.includes('private@example.test'), false);
    f.downloadButton.dispatchEvent(new f.dom.window.Event('click')); await tick();
    assert.equal(f.downloads.length, 0);
    f.dom.window.close();
  }
});

test('download failure permits retry, while simultaneous download and refresh clicks are blocked', async () => {
  let saves = 0, finish: () => void = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(undefined, undefined, async () => {
    if (++saves === 1) throw new Error('PRIVATE_DOWNLOAD_ERROR');
    await pending;
  });
  f.previewButton.click(); await tick();
  f.downloadButton.click(); await tick();
  assert.match(f.status.textContent, /download could not start/);
  assert.equal(f.card.textContent.includes('PRIVATE_DOWNLOAD_ERROR'), false);
  assert.equal(f.downloadButton.disabled, false);
  f.downloadButton.click();
  f.downloadButton.dispatchEvent(new f.dom.window.Event('click'));
  f.previewButton.dispatchEvent(new f.dom.window.Event('click'));
  assert.equal(f.downloads.length, 2);
  assert.equal(f.calls.length, 1);
  finish(); await tick();
  assert.equal(f.downloadButton.disabled, false);
  assert.equal(f.previewButton.disabled, false);
  f.dom.window.close();
});

test('invalid project identifiers never request metadata or enable controls', () => {
  const f = fixture(undefined, '../private');
  f.previewButton.dispatchEvent(new f.dom.window.Event('click'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.previewButton.disabled, true);
  assert.equal(f.downloadButton.hidden, true);
  assert.match(f.status.textContent, /Open a saved project/);
  f.dom.window.close();
});
