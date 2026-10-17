// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { type Attempt, type Channel, type ChannelRecord, carried, channelState, failedBesideLifecycle, helmSummary, readRecord, recordAttempt,
  recordProblems, renderTable, review, validateRecord, verifyImages, writeChannels } from '../scripts/marketplace-channels.ts';
import { release } from '../scripts/marketplace-packages.ts';

const published = (version: string, date: string, extra: Partial<Attempt> = {}): Attempt =>
  ({ release: version, package: version, outcome: 'published', date, evidence: `https://github.com/lolly-tools/lolly-work/releases/tag/v${version}`, ...extra });
const channel = (attempts: Attempt[], extra: Partial<Channel> = {}): Channel =>
  ({ id: 'pilot', name: 'Pilot catalogue', route: 'catalogue', update: 'Open a catalogue pull request.', lifecycle: 'maintained', attempts, ...extra });
const recordOf = (...channels: Channel[]): ChannelRecord => ({ schemaVersion: 1, channels });
const problemsFor = (change: (record: ChannelRecord) => void) => {
  const record = recordOf(channel([published('1.1.0', '2026-10-01')]));
  change(record);
  return recordProblems(record).join('\n');
};

test('the published channel record is valid, public and matches its generated table', () => {
  writeChannels(true);
  for (const item of readRecord().channels) {
    for (const attempt of item.attempts.filter(entry => entry.outcome === 'published')) assert.ok(attempt.evidence, `${item.id} names public evidence`);
  }
});

test('a failed or rejected attempt never becomes the carried version or a current state', () => {
  const failedUpdate = channel([published('1.1.0', '2026-10-01'), { release: '1.1.1', package: '1.1.1', outcome: 'failed', date: '2026-10-02', note: 'Review build failed' }]);
  assert.equal(carried(failedUpdate)?.release, '1.1.0');
  assert.equal(channelState(failedUpdate, '1.1.1'), 'failed');
  const failedAfterCurrent = channel([published('1.1.1', '2026-10-01'), { release: '1.1.1', package: '1.1.1-2', outcome: 'rejected', date: '2026-10-03', note: 'Listing text refused' }]);
  assert.equal(carried(failedAfterCurrent)?.package, '1.1.1');
  assert.equal(channelState(failedAfterCurrent, '1.1.1'), 'failed', 'a rejected attempt is not hidden behind a current version');
  const neverPublished = channel([{ release: '1.1.1', package: '1.1.1', outcome: 'failed', date: '2026-10-02', note: 'Workflow failed' }]);
  assert.equal(carried(neverPublished), undefined);
  const table = renderTable(recordOf(failedUpdate, { ...neverPublished, id: 'other', name: 'Other catalogue' }), '1.1.1');
  for (const row of table.split('\n').filter(line => line.startsWith('| Pilot') || line.startsWith('| Other'))) {
    assert.match(row, /\*\*failed\*\*/);
    assert.doesNotMatch(row, /\| current \|/);
  }
  assert.match(table, /\| Other catalogue \| Public catalogue \| Nothing yet \|/);
  const retried = channel([...failedUpdate.attempts, published('1.1.1', '2026-10-04')]);
  assert.equal(channelState(retried, '1.1.1'), 'current');
  assert.equal(channelState(channel([published('1.1.0', '2026-10-01')]), '1.1.1'), 'behind');
  assert.equal(channelState(channel([published('1.1.0', '2026-10-01'), { release: '1.1.1', package: '1.1.1', outcome: 'submitted', date: '2026-10-02' }]), '1.1.1'), 'in review');
});

test('a withdrawn version falls back to the previous publication', () => {
  const pulled = channel([published('1.1.0', '2026-10-01'), published('1.1.1', '2026-10-02'), { release: '1.1.1', package: '1.1.1', outcome: 'withdrawn', date: '2026-10-03', note: 'Security fix pending' }]);
  validateRecord(recordOf(pulled));
  assert.equal(carried(pulled)?.release, '1.1.0');
  assert.equal(channelState(pulled, '1.1.1'), 'behind');
  assert.match(problemsFor(record => record.channels[0]!.attempts.push({ release: '1.1.1', package: '1.1.1', outcome: 'withdrawn', date: '2026-10-03', note: 'Never shipped' })), /withdraws a version this channel does not carry/);
  const empty = channel([published('1.1.1', '2026-10-01'), { release: '1.1.1', package: '1.1.1', outcome: 'withdrawn', date: '2026-10-02', note: 'Unsafe version pulled' }]);
  validateRecord(recordOf(empty));
  assert.equal(carried(empty), undefined);
  assert.equal(channelState(empty, '1.1.1'), 'withdrawn', 'a channel that has published is never shown as prepared');
  assert.match(renderTable(recordOf(empty), '1.1.1'), /\| Pilot catalogue \| Public catalogue \| Nothing \| withdrawn 1\.1\.1 on 2026-10-02: Unsafe version pulled \| withdrawn \|/);
  assert.deepEqual(review(recordOf(empty), '1.1.1').pause, ['pilot is withdrawn. Update route: Open a catalogue pull request.']);
});

test('the record refuses account IDs, private receipts and unknown fields', () => {
  const cases: [(record: ChannelRecord) => void, RegExp][] = [
    [record => Object.assign(record.channels[0]!, { accountId: 'lolly' }), /accountId is not a public channel field/],
    [record => { record.channels[0]!.attempts[0]!.note = 'Submitted by maintainer@example.test'; }, /an email address/],
    [record => { record.channels[0]!.open = 'Offer 12345678-1234-1234-1234-123456789abc awaits review'; }, /a UUID/],
    [record => { record.channels[0]!.update = 'Publish from account 123456789012'; }, /12-digit account number/],
    [record => { record.channels[0]!.update = 'Publish from account 123456789012.'; }, /12-digit account number/],
    [record => { record.channels[0]!.update = 'Use account 123456789012, region eu-west-1.'; }, /12-digit account number/],
    [record => { record.channels[0]!.attempts[0]!.evidence = 'https://example.test/receipt?token=abc'; }, /query string/],
    [record => { record.channels[0]!.attempts[0]!.evidence = 'http://example.test/receipt'; }, /must use https/],
    [record => { record.channels[0]!.attempts[0]!.evidence = 'https://192.168.1.10/receipt'; }, /public host/],
    [record => { record.channels[0]!.attempts[0]!.note = 'Receipt in lolly-private/release/receipt.json'; }, /private record path/],
    [record => { record.channels[0]!.attempts[0]!.note = 'Receipt at /Users/maintainer/receipt.json'; }, /a local path/],
    [record => { record.channels[0]!.attempts[0]!.evidence = 'file:///home/maintainer/receipt.json'; }, /a local path/],
    [record => { record.channels[0]!.attempts[0]!.note = 'token ghp_abcdefghijklmnop'; }, /a credential/],
    [record => { delete record.channels[0]!.attempts[0]!.evidence; }, /published without public evidence/],
    [record => record.channels[0]!.attempts.push({ release: '1.1.1', package: '1.1.1', outcome: 'failed', date: '2026-10-02' }), /needs a note/],
    [record => record.channels[0]!.attempts.push(published('1.1.1', '2026-09-30')), /append attempts in order/],
    [record => { record.channels[0]!.name = 'Pilot | catalogue'; }, /without "\|"/],
    [record => record.channels.push({ ...record.channels[0]! }), /listed twice/],
  ];
  for (const [change, expected] of cases) assert.match(problemsFor(change), expected);
  assert.equal(problemsFor(() => {}), '');
  assert.equal(problemsFor(record => { record.channels[0]!.attempts[0]!.note = 'Dockerfile: base image refreshed'; }), '', 'ordinary text passes');
  assert.equal(problemsFor(record => { record.channels[0]!.attempts[0]!.note = 'See https://github.com/lolly-tools/lolly-work/actions/runs/123456789012.'; }), '', 'a run ID inside a link passes');
});

test('pausing and retirement need a reason, a published notice, an end date and a migration route', () => {
  const base = channel([published('1.1.1', '2026-10-01')]);
  assert.match(recordProblems(recordOf({ ...base, lifecycle: 'paused' })).join('\n'), /pause is required/);
  const paused = { ...base, lifecycle: 'paused' as const, pause: { since: '2026-10-05', reason: 'Updates fell behind' } };
  assert.equal(channelState(validateRecord(recordOf(paused)).channels[0]!, '1.1.1'), 'paused');
  assert.match(recordProblems(recordOf({ ...base, lifecycle: 'retiring' })).join('\n'), /notice is required/);
  const notice = { url: 'https://github.com/lolly-tools/lolly-work/issues/1', published: '2026-10-05', newInstallsEnd: '2026-11-05', migration: 'https://github.com/lolly-tools/lolly-work/blob/main/docs/install.md' };
  assert.match(recordProblems(recordOf({ ...base, lifecycle: 'retiring', notice: { ...notice, newInstallsEnd: '2026-10-01' } })).join('\n'), /before the notice is published/);
  assert.match(recordProblems(recordOf({ ...base, lifecycle: 'retiring', notice: { ...notice, migration: 'https://example.test/move?ref=mail' } })).join('\n'), /migration must not carry/);
  const retiring = { ...base, lifecycle: 'retiring' as const, notice };
  assert.equal(channelState(validateRecord(recordOf(retiring)).channels[0]!, '1.1.1'), 'retiring');
  assert.match(renderTable(recordOf(retiring), '1.1.1'), /retiring: \[new installations end\]\(https:\/\/github\.com\/lolly-tools\/lolly-work\/issues\/1\) on 2026-11-05/);
  assert.match(recordProblems(recordOf({ ...retiring, lifecycle: 'retired' })).join('\n'), /retired is required/);
  assert.match(recordProblems(recordOf({ ...retiring, lifecycle: 'retired', retired: '2026-10-20' })).join('\n'), /retired before the date its notice gave/);
  const retired = { ...retiring, lifecycle: 'retired' as const, retired: '2026-11-05' };
  assert.equal(channelState(validateRecord(recordOf(retired)).channels[0]!, '1.1.1'), 'retired');
  assert.match(recordProblems(recordOf({ ...base, pause: paused.pause })).join('\n'), /only for one/);
  return assert.rejects(recordAttempt(recordOf(retired), 'pilot', published('1.1.2', '2026-11-06'), (async () => { throw new Error('no network'); }) as typeof fetch), /takes no further attempts/);
});

test('a failed attempt on a paused or retiring channel is flagged in the table and pauses expansion', () => {
  const notice = { url: 'https://github.com/lolly-tools/lolly-work/issues/1', published: '2026-10-05', newInstallsEnd: '2026-11-05', migration: 'https://github.com/lolly-tools/lolly-work/blob/main/docs/install.md' };
  const fix: Attempt = { release: '1.1.2', package: '1.1.2', outcome: 'failed', date: '2026-10-10', note: 'Security fix build failed' };
  const retiring = channel([published('1.1.1', '2026-10-01'), fix], { id: 'leaving', lifecycle: 'retiring', notice });
  const paused = channel([published('1.1.1', '2026-10-01'), fix], { id: 'resting', name: 'Resting catalogue', lifecycle: 'paused', pause: { since: '2026-10-11', reason: 'No maintainer' } });
  const record = validateRecord(recordOf(retiring, paused));
  assert.equal(channelState(retiring, '1.1.1'), 'retiring');
  assert.equal(carried(retiring)?.release, '1.1.1', 'the failed fix never becomes the carried version');
  const table = renderTable(record, '1.1.1');
  assert.match(table, /on 2026-11-05; latest attempt \*\*failed\*\* \|/);
  assert.match(table, /paused since 2026-10-11: No maintainer; latest attempt \*\*failed\*\* \|/);
  const report = review(record, '1.1.1');
  assert.deepEqual(report.pause.map(line => line.split('.')[0]), ['leaving is retiring and its latest attempt failed', 'resting is paused and its latest attempt failed']);
  assert.doesNotMatch(report.lines.join('\n'), /No channel is failing/);
  const recovered = channel([...retiring.attempts, published('1.1.2', '2026-10-12')], { id: 'leaving', lifecycle: 'retiring', notice });
  assert.deepEqual(review(recordOf(recovered), '1.1.1').pause, [], 'a retiring channel that publishes its fix no longer blocks expansion');
  const retired = { ...retiring, lifecycle: 'retired' as const, retired: '2026-11-05' };
  validateRecord(recordOf(retired));
  assert.equal(failedBesideLifecycle(retired), false, 'a retired channel takes no further attempts, so an old failure cannot block expansion for ever');
  assert.deepEqual(review(recordOf(retired), '1.1.1').pause, []);
});

function helmFetch(index: unknown, archive: Uint8Array, seen: RequestInit[] = []) {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push(init);
    const url = String(input);
    if (url.endsWith('/helm-index/index.yaml')) return new Response(stringify(index));
    if (url.endsWith('.tgz')) return new Response(archive);
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

test('a publication through the chart repository is recorded only after the anonymous check passes', async () => {
  const archive = new TextEncoder().encode('chart archive bytes'), sha256 = createHash('sha256').update(archive).digest('hex');
  const entry = { version: '0.3.2', appVersion: '1.1.1', digest: sha256, urls: ['https://github.com/lolly-tools/lolly-work/releases/download/chart-v0.3.2/lolly-work-0.3.2.tgz'] };
  const record = readRecord(), before = JSON.stringify(record);
  const attempt: Attempt = { release: '1.1.1', package: '0.3.2', outcome: 'published', date: '2026-12-31', evidence: 'https://github.com/lolly-tools/lolly-work/releases/tag/chart-v0.3.2' };
  const failures: [unknown, Uint8Array, RegExp][] = [
    [{ apiVersion: 'v1', entries: { 'lolly-work': [] } }, archive, /does not list chart 0\.3\.2/],
    [{ apiVersion: 'v1', entries: { 'lolly-work': [{ ...entry, appVersion: '1.1.0' }] } }, archive, /names application 1\.1\.0/],
    [{ apiVersion: 'v1', entries: { 'lolly-work': [{ ...entry, urls: ['https://example.test/chart.tgz'] }] } }, archive, /not its immutable release/],
    [{ apiVersion: 'v1', entries: { 'lolly-work': [entry] } }, new TextEncoder().encode('other bytes'), /the index names/],
  ];
  for (const [index, bytes, expected] of failures) {
    await assert.rejects(recordAttempt(record, 'helm-repository', attempt, helmFetch(index, bytes)), (error: Error) => expected.test(error.message) && /record the attempt as failed/.test(error.message));
  }
  assert.equal(JSON.stringify(record), before, 'a refused check leaves the record unchanged');
  const seen: RequestInit[] = [];
  const result = await recordAttempt(record, 'helm-repository', attempt, helmFetch({ apiVersion: 'v1', entries: { 'lolly-work': [entry] } }, archive, seen));
  assert.match(result.checked!, /archive matches/);
  for (const init of seen) assert.equal(new Headers(init.headers).get('authorization'), null, 'the chart check never signs in');
  const helm = result.record.channels.find(item => item.id === 'helm-repository')!;
  assert.equal(carried(helm)?.package, '0.3.2');
  assert.equal(channelState(helm), 'current');
  const failed = await recordAttempt(record, 'helm-repository', { ...attempt, outcome: 'failed', note: 'Index update failed', evidence: undefined }, (async () => { throw new Error('a failure needs no check'); }) as typeof fetch);
  assert.equal(channelState(failed.record.channels.find(item => item.id === 'helm-repository')!), 'failed');
  await assert.rejects(recordAttempt(record, 'not-a-channel', attempt), /No channel not-a-channel/);
});

test('image publication checks resolve each release digest anonymously', async () => {
  const digests = [release.serverImage, release.workerImage].map((image: string) => image.split('@')[1]);
  const registry = (answer: (digest: string) => string) => (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://ghcr.io/token?scope=repository:lolly-tools/')) return Response.json({ token: 'anonymous' });
    const digest = url.split('/manifests/')[1]!;
    assert.equal(init.method, 'HEAD');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer anonymous');
    return new Response(null, { status: 200, headers: { 'docker-content-digest': answer(digest) } });
  }) as typeof fetch;
  assert.match(await verifyImages({ release: release.version, package: release.version }, registry(digest => digest)), /resolve anonymously/);
  await assert.rejects(verifyImages({ release: release.version, package: release.version }, registry(digest => digest === digests[1] ? 'sha256:' + '0'.repeat(64) : digest)), /does not resolve anonymously/);
  await assert.rejects(verifyImages({ release: '9.9.9', package: '9.9.9' }, registry(digest => digest)), /has recorded image digests/);
});

test('the maintenance review pauses expansion while a channel is failing, behind, in review or paused', () => {
  const measured = channel([published('1.1.1', '2026-10-01', { minutes: 30, reviewDays: 4 }), published('1.1.1', '2026-10-02', { package: '1.1.1-2', minutes: 10 })]);
  const report = review(recordOf(measured), '1.1.1');
  assert.match(report.lines.join('\n'), /pilot: current; 2 published, 0 failed or rejected; 40 maintainer minutes; 20 minutes per publication over 2; longest review 4 days/);
  const costly = channel([
    { release: '1.1.1', package: '1.1.1', outcome: 'failed', date: '2026-10-01', note: 'Build failed', minutes: 240 },
    { release: '1.1.1', package: '1.1.1', outcome: 'rejected', date: '2026-10-02', note: 'Listing refused', minutes: 180 },
    published('1.1.1', '2026-10-03', { minutes: 10 }),
  ]);
  assert.match(review(recordOf(costly), '1.1.1').lines[0]!, /pilot: current; 1 published, 2 failed or rejected; 430 maintainer minutes, 420 of them on failed or rejected attempts; 430 minutes per publication over 1$/);
  const unpublished = channel([{ release: '1.1.1', package: '1.1.1', outcome: 'failed', date: '2026-10-01', note: 'Build failed', minutes: 90 }]);
  assert.match(review(recordOf(unpublished), '1.1.1').lines[0]!, /90 maintainer minutes, 90 of them on failed or rejected attempts; no publication yet$/);
  const blocked = review(recordOf(
    channel([published('1.1.0', '2026-10-01')], { id: 'old' }),
    channel([published('1.1.1', '2026-10-01'), { release: '1.1.1', package: '1.1.1-2', outcome: 'failed', date: '2026-10-02', note: 'Build failed' }], { id: 'broken' }),
    channel([{ release: '1.1.1', package: '1.1.1', outcome: 'submitted', date: '2026-10-02' }], { id: 'waiting' }),
    channel([], { id: 'quiet', lifecycle: 'paused', pause: { since: '2026-10-02', reason: 'No maintainer' } }),
    channel([], { id: 'fresh' }),
  ), '1.1.1');
  assert.deepEqual(blocked.pause.map(line => line.split('.')[0]), ['old is behind', 'broken is failed', 'waiting is in review', 'quiet is paused']);
  assert.match(blocked.pause[0]!, /Update route: Open a catalogue pull request\./);
  assert.match(blocked.lines.join('\n'), /Publications recorded without minutes: old, broken/);
});

test('the Helm workflow summary never offers a published record for a failed run', () => {
  const chart = { version: '0.3.2', appVersion: '1.1.1' }, run = 'https://github.com/lolly-tools/lolly-work/actions/runs/1';
  for (const status of ['failure', 'cancelled']) {
    const summary = helmSummary(status, run, chart);
    assert.match(summary, /--release 1\.1\.1 --package 0\.3\.2 --outcome failed --evidence https:\/\/github\.com\/lolly-tools\/lolly-work\/actions\/runs\/1/);
    assert.doesNotMatch(summary, /--outcome published/);
  }
  const success = helmSummary('success', run, chart);
  assert.match(success, /--outcome published --evidence https:\/\/github\.com\/lolly-tools\/lolly-work\/releases\/tag\/chart-v0\.3\.2/);
  assert.match(success, /not yet a published attempt/);
  assert.match(helmSummary('success', run), /--package \d+\.\d+\.\d+ --outcome published/, 'the default reads the committed chart');
});
