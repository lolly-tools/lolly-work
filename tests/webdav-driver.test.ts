/**
 * WebDAV driver against modelled RFC 4918 servers. Injected fetch, no network
 * and no server: a Nextcloud-shaped multistatus and a generic one, namespace
 * prefixes varying across d:, D: and a default xmlns, directories becoming
 * sections rather than assets, the breadth-first recursive walk behind the
 * opaque cursor, the base64url remoteId round-tripping through resolveBlob,
 * traversal and foreign-host hrefs refused, a credential that fails closed, the
 * self-imposed rate gap, a malformed body producing the self-diagnosing error,
 * healthCheck both ways, and the shape report with nothing of the fixture's
 * values in it. URL templates and property names carry a LIVE-VERIFY caveat in
 * the driver; these fixtures pin what it maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebdavProvider, MAX_DIRS } from '../server/src/catalog/providers/webdav.ts';

const CRED = 'alice:app-password-abcd';
const NC = { baseUrl: 'https://cloud.example', flavor: 'nextcloud', minGapMs: 0 } as const;
const GENERIC = { baseUrl: 'https://dav.example/store', minGapMs: 0 } as const;
const NC_ROOT = '/remote.php/dav/files/alice';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

interface Call { url: string; method: string; auth: string; ua: string; depth: string; body: string; redirect: string }
interface Route {
  match: (url: string, method: string, body: string) => boolean;
  xml?: string;
  bytes?: string;
  status?: number;
  /** A 3xx and its Location, which a fixture serves because `redirect: 'manual'`
   *  is what the driver asks for - a real fetch would have followed it. */
  location?: string;
}
function fakeFetch(routes: Route[]): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers as Record<string, string>) ?? {};
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url, method: init?.method ?? 'GET', auth: h.authorization ?? '', ua: h['user-agent'] ?? '',
      depth: h.depth ?? '', body, redirect: init?.redirect ?? '',
    });
    const route = routes.find((r) => r.match(url, init?.method ?? 'GET', body));
    if (!route) return new Response('not found', { status: 404 });
    if (route.location !== undefined) {
      return new Response('', { status: route.status ?? 302, headers: { location: route.location } });
    }
    if (route.bytes !== undefined) {
      return new Response(route.bytes, {
        status: route.status ?? 200,
        headers: { 'content-type': 'image/png', 'content-length': String(route.bytes.length) },
      });
    }
    return new Response(route.xml ?? '', { status: route.status ?? 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}
const callsOf = (f: typeof fetch): Call[] => (f as unknown as { calls: Call[] }).calls;

/** One Nextcloud-shaped response element (d: prefix, oc: extension, hrefs
 *  percent-encoded and directories carrying a trailing slash). */
const ncFile = (href: string, size: number, tags: string[] = []): string => `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>${size}</d:getcontentlength>
        <d:getlastmodified>Mon, 01 Jun 2026 09:30:00 GMT</d:getlastmodified>
        <d:getcontenttype>image/png</d:getcontenttype>
        ${tags.length ? `<oc:tags>${tags.map((t) => `<oc:tag>${t}</oc:tag>`).join('')}</oc:tags>` : '<oc:tags/>'}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;

const ncDir = (href: string): string => `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:getlastmodified>Sun, 31 May 2026 08:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:getcontentlength/><d:getcontenttype/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>`;

/** RFC 4918 §14.24 allows href + status with no propstat at all, which is what a
 *  server sends for a member it will not describe. Nothing about it is readable,
 *  so it can never be an entry - and it says nothing about the files root. */
const ncStatusOnly = (href: string): string => `
  <d:response><d:href>${href}</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`;

/** A response carrying no href at all: unreadable for a different reason. */
const NC_NO_HREF = `
  <d:response><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const ncBody = (...parts: string[]): string =>
  `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${parts.join('')}\n</d:multistatus>\n`;

/** The root listing of a Nextcloud tenant: itself, one file, one subdirectory. */
const NC_LISTING = ncBody(
  ncDir(`${NC_ROOT}/`),
  ncFile(`${NC_ROOT}/Summit%20Banner%20%26%20Logo.png`, 2048, ['event', '2026']),
  ncDir(`${NC_ROOT}/Logos/`),
);

const NC_LOGOS = ncBody(
  ncDir(`${NC_ROOT}/Logos/`),
  ncFile(`${NC_ROOT}/Logos/mark.svg`, 512),
  ncDir(`${NC_ROOT}/Logos/Mono/`),
);

const NC_MONO = ncBody(
  ncDir(`${NC_ROOT}/Logos/Mono/`),
  ncFile(`${NC_ROOT}/Logos/Mono/mark-mono.svg`, 256),
);

/** A generic RFC 4918 server: default xmlns, no vendor extension, full-URL
 *  hrefs, and a self-closing empty resourcetype on the file. */
const GENERIC_LISTING = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>https://dav.example/store/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>https://dav.example/store/brand-guide.pdf</href>
    <propstat>
      <prop>
        <resourcetype/>
        <getcontentlength>4096</getcontentlength>
        <getlastmodified>Tue, 02 Jun 2026 12:00:00 GMT</getlastmodified>
        <getcontenttype>application/pdf</getcontenttype>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

/** The same listing spelled with an uppercase D: prefix and a mixed-case status
 *  line, which is a spelling RFC 4918 allows and several servers use. */
const PREFIX_VARIANT = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/store/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/store/notes.txt</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/><D:getcontentlength>17</D:getcontentlength><D:getcontenttype>text/plain</D:getcontenttype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const propfindRoute = (xml: string) => ({ match: (_u: string, m: string) => m === 'PROPFIND', xml });

test('nextcloud: the files root is /remote.php/dav/files/<username>, and a file maps through Basic auth', async () => {
  const fetchImpl = fakeFetch([propfindRoute(NC_LISTING)]);
  const dav = createWebdavProvider('w1', NC, CRED, fetchImpl);
  const page = await dav.listAssets();

  assert.equal(page.assets.length, 1, 'the directory itself and the subdirectory are not assets');
  const a = page.assets[0];
  assert.equal(a?.remoteId, b64('Summit Banner & Logo.png'), 'remoteId is the base64url of the path under the files root');
  assert.equal(a?.name, 'Summit Banner & Logo', 'the href is percent-decoded and its entities resolved');
  assert.equal(a?.nativeType, 'png');
  assert.deepEqual(a?.sections, [], 'a file at the root sits in no section');
  assert.deepEqual(a?.tags, ['event', '2026'], 'oc:tags children become tags');
  assert.equal(a?.updatedAt, '2026-06-01T09:30:00.000Z', 'the RFC 1123 stamp is normalised to ISO');
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'file', filename: 'Summit Banner & Logo.png', size: 2048 }]);
  assert.equal(a?.availableUntil, undefined, 'plain WebDAV carries no availability window');

  const call = callsOf(fetchImpl)[0];
  assert.equal(call?.url, `https://cloud.example${NC_ROOT}/`);
  assert.equal(call?.method, 'PROPFIND');
  assert.equal(call?.depth, '1');
  assert.equal(call?.auth, `Basic ${Buffer.from(CRED, 'utf8').toString('base64')}`, 'HTTP Basic from the sealed "<username>:<app password>"');
  assert.match(call?.ua ?? '', /lolly-work/, 'the driver identifies itself');
  assert.match(call?.body ?? '', /<d:propfind/, 'PROPFIND carries a prop request body');
  assert.match(call?.body ?? '', /getcontentlength/);
  assert.match(call?.body ?? '', /<oc:tags\/>/, 'the nextcloud flavor asks for the oc extension');
});

test('nextcloud: options.username overrides the credential username, and options.root scopes the walk', async () => {
  const fetchImpl = fakeFetch([propfindRoute(ncBody(ncDir('/remote.php/dav/files/a.long.login/Brand/')))]);
  const dav = createWebdavProvider('w2', { ...NC, username: 'a.long.login', root: '/Brand/' }, CRED, fetchImpl);
  await dav.listAssets();
  assert.equal(callsOf(fetchImpl)[0]?.url, 'https://cloud.example/remote.php/dav/files/a.long.login/Brand/',
    'the DAV path login can differ from the display name, so options.username wins');
});

test('generic: the files root is <baseUrl>/<root>, and no vendor extension is requested', async () => {
  const fetchImpl = fakeFetch([propfindRoute(GENERIC_LISTING)]);
  const dav = createWebdavProvider('w3', GENERIC, CRED, fetchImpl);
  const page = await dav.listAssets();

  const a = page.assets[0];
  assert.equal(page.assets.length, 1);
  assert.equal(a?.remoteId, b64('brand-guide.pdf'));
  assert.equal(a?.name, 'brand-guide');
  assert.equal(a?.nativeType, 'pdf');
  assert.deepEqual(a?.tags, [], 'a generic server has no tag property');
  assert.equal(a?.formats[0]?.size, 4096);
  assert.equal(callsOf(fetchImpl)[0]?.url, 'https://dav.example/store/', 'the base path is kept, no remote.php is invented');
  assert.doesNotMatch(callsOf(fetchImpl)[0]?.body ?? '', /oc:/, 'the generic flavor asks for nothing beyond RFC 4918');
});

test('a generic server that mounts DAV at its own root is asked for /, never //', async () => {
  // baseUrl with no path and no options.root is the ordinary shape for rclone
  // serve webdav, sabre/dav or mod_dav at the root: the files root is EMPTY, and
  // a naively joined trailing slash would ask for a path nobody configured.
  const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response><href>/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/deck.pdf</href>
    <propstat><prop><resourcetype/><getcontentlength>9</getcontentlength><getcontenttype>application/pdf</getcontenttype></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;
  const fetchImpl = fakeFetch([propfindRoute(xml), { match: (_u, m) => m === 'GET', bytes: 'PDFBYTES' }]);
  const dav = createWebdavProvider('w3b', { baseUrl: 'https://dav.example', minGapMs: 0 }, CRED, fetchImpl);
  const page = await dav.listAssets();

  assert.equal(callsOf(fetchImpl)[0]?.url, 'https://dav.example/', 'an empty files root is the origin root, not //');
  assert.deepEqual(page.assets.map((a) => a.remoteId), [b64('deck.pdf')]);
  await dav.resolveBlob(page.assets[0]?.remoteId as string, 'file');
  assert.equal(callsOf(fetchImpl).find((c) => c.method === 'GET')?.url, 'https://dav.example/deck.pdf');
});

test('namespace prefixes vary: d:, D: and a default xmlns all read the same', async () => {
  const fetchImpl = fakeFetch([propfindRoute(PREFIX_VARIANT)]);
  const dav = createWebdavProvider('w4', GENERIC, CRED, fetchImpl);
  const page = await dav.listAssets();
  assert.equal(page.assets.length, 1, 'the D:collection root is still a directory');
  assert.equal(page.assets[0]?.remoteId, b64('notes.txt'));
  assert.equal(page.assets[0]?.formats[0]?.size, 17);
});

test('a file with no extension falls back to the content type, and one with neither to bin', async () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/store/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/store/README</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontenttype>text/markdown; charset=utf-8</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/store/blob</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
  const dav = createWebdavProvider('w5', GENERIC, CRED, fakeFetch([propfindRoute(xml)]));
  const page = await dav.listAssets();
  assert.deepEqual(page.assets.map((a) => a.nativeType), ['markdown', 'bin']);
  assert.equal(page.assets[0]?.updatedAt, undefined, 'a missing optional degrades, it never throws');
  const note = page.notes?.[0] as string;
  assert.ok(note.includes('read no size and no modification stamp'), note);
  assert.ok(note.includes('PROP_SIZE_KEYS / PROP_MODIFIED_KEYS'), note);
});

test('directories are sections, not assets: the recursive walk crosses them breadth-first behind the cursor', async () => {
  const fetchImpl = fakeFetch([
    { match: (u, m) => m === 'PROPFIND' && u.endsWith(`${NC_ROOT}/`), xml: NC_LISTING },
    { match: (u, m) => m === 'PROPFIND' && u.endsWith('/Logos/'), xml: NC_LOGOS },
    { match: (u, m) => m === 'PROPFIND' && u.endsWith('/Logos/Mono/'), xml: NC_MONO },
  ]);
  const dav = createWebdavProvider('w6', { ...NC, recursive: true }, CRED, fetchImpl);

  const p1 = await dav.listAssets();
  assert.deepEqual(p1.assets.map((a) => a.remoteId), [b64('Summit Banner & Logo.png')]);
  assert.ok(p1.next, 'the Logos directory is queued behind an opaque cursor');

  const p2 = await dav.listAssets(p1.next);
  assert.deepEqual(p2.assets.map((a) => a.name), ['mark']);
  assert.deepEqual(p2.assets[0]?.sections, ['Logos'], 'the parent directory path becomes the sections');
  assert.equal(p2.assets[0]?.remoteId, b64('Logos/mark.svg'));

  const p3 = await dav.listAssets(p2.next);
  assert.deepEqual(p3.assets[0]?.sections, ['Logos', 'Mono'], 'one section per level');
  assert.equal(p3.next, undefined, 'the queue drains and the walk ends');

  assert.deepEqual(callsOf(fetchImpl).map((c) => new URL(c.url).pathname), [
    `${NC_ROOT}/`, `${NC_ROOT}/Logos/`, `${NC_ROOT}/Logos/Mono/`,
  ]);
  await assert.rejects(() => dav.listAssets('not base64url!'), /bad webdav cursor/);
  await assert.rejects(() => dav.listAssets(b64('3\n../etc')), /bad webdav cursor/);
});

test('without recursive, the walk is one directory and its subdirectories are never opened', async () => {
  const fetchImpl = fakeFetch([propfindRoute(NC_LISTING)]);
  const dav = createWebdavProvider('w7', NC, CRED, fetchImpl);
  const page = await dav.listAssets();
  assert.equal(page.next, undefined);
  assert.equal(callsOf(fetchImpl).length, 1);
});

test('the recursive walk is bounded: MAX_DIRS pending directories is where queueing stops', async () => {
  const many = ncBody(ncDir(`${NC_ROOT}/`), ...Array.from({ length: MAX_DIRS + 5 }, (_, i) => ncDir(`${NC_ROOT}/d${i}/`)));
  const dav = createWebdavProvider('w8', { ...NC, recursive: true }, CRED, fakeFetch([propfindRoute(many)]));
  const page = await dav.listAssets();
  const note = page.notes?.find((n) => n.includes('MAX_DIRS')) as string;
  assert.ok(note.includes(`stopped queueing directories at MAX_DIRS (${MAX_DIRS})`), note);
  assert.ok(note.includes('5 subdirectory(ies)'), note);
});

test('resolveBlob round-trips the remoteId listAssets emitted, streaming the bytes host-pinned', async () => {
  const fetchImpl = fakeFetch([
    propfindRoute(NC_LISTING),
    { match: (u, m) => m === 'GET' && u.includes('Summit'), bytes: 'PNGBYTES' },
  ]);
  const dav = createWebdavProvider('w9', NC, CRED, fetchImpl);
  const remoteId = (await dav.listAssets()).assets[0]?.remoteId as string;

  const blob = await dav.resolveBlob(remoteId, 'file');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/png');
    assert.equal(blob.size, 8);
    assert.equal(await new Response(blob.body).text(), 'PNGBYTES');
  }
  const get = callsOf(fetchImpl).find((c) => c.method === 'GET');
  assert.equal(get?.url, `https://cloud.example${NC_ROOT}/Summit%20Banner%20%26%20Logo.png`,
    'the URL is rebuilt from the pinned origin and the files root, never taken from the response');
  assert.equal(get?.auth, `Basic ${Buffer.from(CRED, 'utf8').toString('base64')}`);
  await assert.rejects(() => dav.resolveBlob(remoteId, 'thumb'), /single file format/);
});

/**
 * The id contract, PROVEN over the fixtures rather than asserted on one asset:
 * walk the whole recursive tree, collect EVERY remoteId listAssets emitted, and
 * put each one back through resolveBlob. A file whose name carries a space, an
 * ampersand, a non-ASCII letter or a path separator is exactly where an encoding
 * that round-trips in one direction only would show up, so the tree carries all
 * four. The URL is checked too: an id that is accepted but addresses the wrong
 * file would pass a bare "did not throw" test.
 */
test('every remoteId the walk emits is accepted by resolveBlob, and addresses the file it was minted from', async () => {
  const NC_DEEP = ncBody(
    ncDir(`${NC_ROOT}/`),
    ncFile(`${NC_ROOT}/Summit%20Banner%20%26%20Logo.png`, 2048, ['event']),
    ncFile(`${NC_ROOT}/caf%C3%A9%20%26%20co.png`, 64),
    ncFile(`${NC_ROOT}/plain.png`, 32),
    ncDir(`${NC_ROOT}/Logos/`),
  );
  const fetchImpl = fakeFetch([
    { match: (u, m) => m === 'PROPFIND' && u.endsWith('/Logos/Mono/'), xml: NC_MONO },
    { match: (u, m) => m === 'PROPFIND' && u.endsWith('/Logos/'), xml: NC_LOGOS },
    { match: (_u, m) => m === 'PROPFIND', xml: NC_DEEP },
    { match: (_u, m) => m === 'GET', bytes: 'BYTES' },
  ]);
  const dav = createWebdavProvider('w9b', { ...NC, recursive: true }, CRED, fetchImpl);

  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await dav.listAssets(cursor);
    for (const a of page.assets) ids.push(a.remoteId);
    cursor = page.next;
  } while (cursor);

  const paths = ids.map((id) => Buffer.from(id, 'base64url').toString('utf8'));
  assert.deepEqual(paths, [
    'Summit Banner & Logo.png', 'café & co.png', 'plain.png',
    'Logos/mark.svg', 'Logos/Mono/mark-mono.svg',
  ], 'the whole tree, breadth-first, so the loop below is over every id this driver can mint');

  for (const [i, id] of ids.entries()) {
    const before = callsOf(fetchImpl).length;
    const blob = await dav.resolveBlob(id, 'file');
    assert.equal(blob.kind, 'stream', `resolveBlob refused an id listAssets emitted: ${id}`);
    const get = callsOf(fetchImpl)[before] as Call;
    assert.equal(get.method, 'GET');
    assert.equal(
      get.url,
      `https://cloud.example${NC_ROOT}/${(paths[i] as string).split('/').map(encodeURIComponent).join('/')}`,
      `the id round-tripped but addressed the wrong file: ${paths[i]}`,
    );
  }
  assert.equal(ids.length, new Set(ids).size, 'two files never share an id');
});

test('a remoteId that would escape the files root is refused before any fetch', async () => {
  const fetchImpl = fakeFetch([{ match: () => true, bytes: 'STOLEN' }]);
  const dav = createWebdavProvider('w10', NC, CRED, fetchImpl);
  const bad = [
    b64('../../../etc/passwd'),
    b64('Logos/../../secrets.env'),
    b64('/etc/passwd'),
    b64('.'),
    b64(''),
    'not base64url!',
    `${b64('a.png')}==`, // an alternate spelling of an id this driver would never emit
  ];
  for (const id of bad) {
    await assert.rejects(() => dav.resolveBlob(id, 'file'), /bad webdav asset id/, id);
  }
  assert.equal(callsOf(fetchImpl).length, 0, 'refused before the request leaves');
});

test('an href pointing at another host is refused, so a response cannot redirect the driver off the server', async () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>https://cloud.example.evil.test/remote.php/dav/files/alice/steal.png</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
  const dav = createWebdavProvider('w11', NC, CRED, fakeFetch([propfindRoute(xml)]));
  await assert.rejects(() => dav.listAssets(), /refusing to follow it/);
});

test('an href inside the server but outside the configured root is counted, never federated', async () => {
  const xml = ncBody(
    ncDir(`${NC_ROOT}/Brand/`),
    ncFile(`${NC_ROOT}/Brand/ok.png`, 10),
    ncFile('/remote.php/dav/files/bob/private.png', 10),
  );
  const dav = createWebdavProvider('w12', { ...NC, root: 'Brand' }, CRED, fakeFetch([propfindRoute(xml)]));
  const page = await dav.listAssets();
  assert.deepEqual(page.assets.map((a) => a.remoteId), [b64('ok.png')]);
  assert.equal(page.skipped, 1, 'a resource outside the files root is reported, not dropped in silence');
});

test('a page whose every resource sits outside the files root names the URL template, not an empty directory', async () => {
  // What a path-rewriting proxy, or the wrong login in the DAV path, looks like.
  const xml = ncBody(ncDir('/dav/files/alice/'), ncFile('/dav/files/alice/a.png', 10));
  const dav = createWebdavProvider('w12b', NC, CRED, fakeFetch([propfindRoute(xml)]));
  const err = await dav.listAssets().then(() => null, (e: Error) => e);
  const msg = err?.message ?? '';
  assert.match(msg, /none of the 2 resource\(s\) PROPFIND returned sit under the files root/);
  assert.ok(msg.includes('fix NEXTCLOUD_FILES_PATH (or options.username / options.root) in server/src/catalog/providers/webdav.ts'), msg);
  assert.ok(msg.includes('docs/providers/webdav-live-verify.md'), msg);
});

/**
 * The two populations the "outside the files root" guard has to keep apart: a
 * response this driver could not READ at all (no href, or no propstat it can
 * read) says nothing about the URL template, while an entry whose href sits
 * outside the root is the template breaking. Counting them together fires the
 * guard on a healthy page and silences it on the failure it exists for, so both
 * shapes are pinned here.
 */
test('unreadable responses beside a good file are counted, never mistaken for a broken files root', async () => {
  const xml = ncBody(
    ncDir(`${NC_ROOT}/`),
    ncFile(`${NC_ROOT}/ok.png`, 10),
    ncStatusOnly(`${NC_ROOT}/locked-a.png`),
    ncStatusOnly(`${NC_ROOT}/locked-b.png`),
  );
  const dav = createWebdavProvider('w12c', NC, CRED, fakeFetch([propfindRoute(xml)]));
  const page = await dav.listAssets();
  assert.deepEqual(page.assets.map((a) => a.remoteId), [b64('ok.png')],
    'the file mapped, so the files root is right and nothing may throw');
  assert.equal(page.skipped, 2, 'the two undescribed members are reported to the caller');
});

test('a broken files root is still named when some responses were unreadable too', async () => {
  const xml = ncBody(NC_NO_HREF, ncFile('/dav/files/alice/a.png', 10));
  const dav = createWebdavProvider('w12d', NC, CRED, fakeFetch([propfindRoute(xml)]));
  const err = await dav.listAssets().then(() => null, (e: Error) => e);
  const msg = err?.message ?? '';
  assert.match(msg, /none of the 1 resource\(s\) PROPFIND returned sit under the files root/);
  assert.match(msg, /1 further response\(s\) carried no href or no readable propstat/,
    'the unreadable responses are named rather than counted into the test');
});

test('a redirect is refused, so a 3xx cannot walk this driver off its pinned host', async () => {
  const listing = fakeFetch([{
    match: (_u, m) => m === 'PROPFIND',
    location: 'https://elsewhere.test/remote.php/dav/files/alice/',
    status: 302,
  }]);
  const dav = createWebdavProvider('w12e', NC, CRED, listing);
  await assert.rejects(() => dav.listAssets(), /webdav propfind 302 .* redirected, sending it to elsewhere\.test/);
  assert.equal(callsOf(listing)[0]?.redirect, 'manual',
    'the driver asks fetch NOT to follow, which is what makes the host pin real rather than documented');

  // The byte path is the one that matters most: a followed redirect there would
  // stream another origin's bytes into the catalog as this asset's content.
  const bytes = fakeFetch([
    propfindRoute(NC_LISTING),
    { match: (_u, m) => m === 'GET', location: 'https://elsewhere.test/steal.png', status: 302 },
  ]);
  const dav2 = createWebdavProvider('w12f', NC, CRED, bytes);
  const remoteId = (await dav2.listAssets()).assets[0]?.remoteId as string;
  await assert.rejects(() => dav2.resolveBlob(remoteId, 'file'), /webdav get 302 .* elsewhere\.test/);

  // A 301 to the SAME host is refused too: the driver builds its URLs, so a
  // server asking for a different one is a configuration answer, not a detour.
  const same = createWebdavProvider('w12g', NC, CRED, fakeFetch([
    { match: (_u, m) => m === 'PROPFIND', location: `${NC_ROOT}/`, status: 301 },
  ]));
  const health = await same.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.detail ?? '', /webdav propfind 301 for /, 'the runbook row for the trailing slash can fire');
});

test('a missing or malformed credential fails closed, and says which form it wanted', async () => {
  const fetchImpl = fakeFetch([propfindRoute(NC_LISTING)]);
  for (const secret of [undefined, '', 'justapassword', 'alice:', ':password', 'bearer:']) {
    const dav = createWebdavProvider('w13', NC, secret, fetchImpl);
    await assert.rejects(() => dav.listAssets(), /APP PASSWORD|bearer/, String(secret));
  }
  assert.equal(callsOf(fetchImpl).length, 0, 'nothing anonymous ever leaves');
});

test('the bearer credential form is accepted, and nextcloud then needs options.username', async () => {
  const fetchImpl = fakeFetch([propfindRoute(GENERIC_LISTING)]);
  const dav = createWebdavProvider('w14', GENERIC, 'bearer:tok-123', fetchImpl);
  await dav.listAssets();
  assert.equal(callsOf(fetchImpl)[0]?.auth, 'Bearer tok-123');

  const nc = createWebdavProvider('w15', NC, 'bearer:tok-123', fakeFetch([propfindRoute(NC_LISTING)]));
  await assert.rejects(() => nc.listAssets(), /needs options\.username/);
});

test('a 401 names the credential rather than reading as a missing file', async () => {
  const dav = createWebdavProvider('w16', NC, CRED, fakeFetch([{ match: () => true, xml: '', status: 401 }]));
  await assert.rejects(() => dav.listAssets(), /401 - the server rejected the credential/);
});

test('a malformed body throws the self-diagnosing error, naming the assumption and the runbook', async () => {
  const cases: Array<{ xml: string; constant: string; problem: RegExp }> = [
    { xml: '<html><body>Login</body></html>', constant: 'MULTISTATUS_ELEMENT', problem: /without a multistatus root element/ },
    { xml: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>', constant: 'RESPONSE_ELEMENT', problem: /carried no response element/ },
    { xml: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/store/a.png', constant: 'parseMultistatus', problem: /is never closed/ },
  ];
  for (const c of cases) {
    const dav = createWebdavProvider('w17', GENERIC, CRED, fakeFetch([propfindRoute(c.xml)]));
    const err = await dav.listAssets().then(() => null, (e: Error) => e);
    const msg = err?.message ?? '';
    assert.match(msg, c.problem);
    assert.ok(msg.startsWith('webdav '), msg);
    assert.ok(msg.includes('(live-verify: '), msg);
    assert.ok(msg.includes(`fix ${c.constant} in server/src/catalog/providers/webdav.ts`), msg);
    assert.ok(msg.includes('docs/providers/webdav-live-verify.md'), msg);
  }
});

test('an availability window only exists when the server exposes a custom property and the mapping names it', async () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:x="https://example.test/ns">
  <d:response><d:href>/store/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/store/promo.png</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/><d:getcontentlength>10</d:getcontentlength>
      <x:embargo-until>2027-01-01T00:00:00.000Z</x:embargo-until>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
  const mappedFetch = fakeFetch([propfindRoute(xml)]);
  const mapped = createWebdavProvider('w18', GENERIC, CRED, mappedFetch, { until: 'embargo-until' });
  const a = (await mapped.listAssets()).assets[0];
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z');
  // RFC 4918 §9.1: a PROPFIND naming properties returns ONLY those, so a custom
  // property the driver learns the name of at configuration time is reachable
  // only through allprop. Without this the mapping arm could never fire against
  // a conformant server, whatever the fixture volunteers.
  assert.match(callsOf(mappedFetch)[0]?.body ?? '', /<d:allprop\/>/,
    'a configured availability field switches the request body to allprop');
  assert.doesNotMatch(callsOf(mappedFetch)[0]?.body ?? '', /<d:prop>/, 'and drops the named prop list it replaces');

  const ncFetch = fakeFetch([propfindRoute(NC_LISTING)]);
  await createWebdavProvider('w18b', NC, CRED, ncFetch, { from: 'publish-from' }).listAssets();
  assert.match(callsOf(ncFetch)[0]?.body ?? '', /<d:include>\s*<oc:tags\/>\s*<\/d:include>/,
    'allprop need not carry a non-RFC-4918 property, so oc:tags rides in d:include');

  const unmappedFetch = fakeFetch([propfindRoute(xml)]);
  const unmapped = createWebdavProvider('w19', GENERIC, CRED, unmappedFetch);
  assert.equal((await unmapped.listAssets()).assets[0]?.availableUntil, undefined,
    'with no mapping.availabilityFields the manual catalog.expire arm is the whole story');
  assert.match(callsOf(unmappedFetch)[0]?.body ?? '', /<d:prop>/,
    'and the cheaper named prop list stays the default');

  const wrong = createWebdavProvider('w20', GENERIC, CRED, fakeFetch([propfindRoute(xml)]), { until: 'expires' });
  const note = (await wrong.listAssets()).notes?.[0] as string;
  assert.ok(note.includes('read no availability window from any file'), note);
  assert.ok(note.includes('fix mapping.availabilityFields'), note);
});

test('the module-level rate limiter spaces calls to one provider by minGapMs', async () => {
  const fetchImpl = fakeFetch([propfindRoute(GENERIC_LISTING)]);
  const dav = createWebdavProvider('w21', { baseUrl: 'https://dav.example/store', minGapMs: 120 }, CRED, fetchImpl);
  const t0 = Date.now();
  await dav.listAssets();
  await dav.listAssets();
  // 5ms slack: the limiter waits the full 120ms gap, but Date.now() sampling can
  // lose sub-millisecond time, which flaked this at 119.5ms on a loaded CI runner.
  assert.ok(Date.now() - t0 >= 115, 'the second call waits out the ~120ms gap');
});

test('healthCheck: Depth 0 on the files root, ok on 207 and a detail on failure', async () => {
  const okFetch = fakeFetch([propfindRoute(GENERIC_LISTING)]);
  const ok = createWebdavProvider('w22', GENERIC, CRED, okFetch);
  assert.equal((await ok.healthCheck()).ok, true);
  assert.equal(callsOf(okFetch)[0]?.depth, '0', 'the cheapest call that proves the URL template and the credential');

  const down = createWebdavProvider('w23', GENERIC, CRED, fakeFetch([{ match: () => true, xml: '', status: 500 }]));
  const bad = await down.healthCheck();
  assert.equal(bad.ok, false);
  assert.match(bad.detail ?? '', /webdav propfind 500/);

  const keyless = createWebdavProvider('w24', GENERIC, undefined, fakeFetch([]));
  assert.match((await keyless.healthCheck()).detail ?? '', /no credential is sealed/);
});

test('baseUrl is required and parsed at construction', () => {
  assert.throws(() => createWebdavProvider('w25', {} as never, CRED, fakeFetch([])), /needs options\.baseUrl/);
  assert.throws(() => createWebdavProvider('w26', { baseUrl: 'cloud.example' }, CRED, fakeFetch([])), /not a URL/);
});

test('the shape report describes property names and types, and carries no value from the response', async () => {
  const fetchImpl = fakeFetch([propfindRoute(NC_LISTING)]);
  const dav = createWebdavProvider('w27', NC, CRED, fetchImpl);
  const report = await dav.sampleShape?.();
  assert.ok(report);
  assert.equal(report?.kind, 'webdav');
  assert.equal(report?.scope, 'list');
  assert.equal(report?.endpoint, 'PROPFIND /remote.php/dav/files/<username>/ (Depth: 1)',
    'the login name is half the Basic credential, so the report prints the template, not the value');
  assert.equal(report?.recordsKey, 'multistatus');
  assert.equal(report?.recordCount, 3, 'directories are described too, since that is what the server sent');
  assert.deepEqual(report?.record.map((f) => f.key).sort(), ['getcontentlength', 'getcontenttype', 'getlastmodified', 'resourcetype', 'tags']);
  assert.ok(report?.mapped.includes('getcontentlength'));
  assert.deepEqual(report?.absent, [], 'every property this driver reads came back');

  // The invariant: names and types travel, values never do.
  const text = JSON.stringify(report);
  for (const value of ['Summit', '2048', 'Mon, 01 Jun 2026', 'image/png', 'event', 'app-password', 'alice']) {
    assert.ok(!text.includes(value), `the report leaked ${value}: ${text}`);
  }
});

test('the shape report names a wrong property guess when the server answers with other names', async () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/store/a.png</d:href>
    <d:propstat><d:prop><d:contentlength>10</d:contentlength><d:modified>x</d:modified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
  const fetchImpl = fakeFetch([propfindRoute(xml)]);
  const dav = createWebdavProvider('w28', GENERIC, CRED, fetchImpl);
  const report = await dav.sampleShape?.();
  assert.ok(report?.absent.includes('getcontentlength (PROP_SIZE_KEYS)'), JSON.stringify(report?.absent));
  assert.deepEqual(report?.unmapped, ['contentlength', 'modified'], 'what the server sent that this driver ignores');
  // The group above can only ever hold something because the report asks with
  // its OWN body: a named prop list comes back holding exactly what it named
  // (RFC 4918 §9.1), which would leave NOT MAPPED structurally empty and the
  // real name of a wrong guess undiscoverable.
  assert.match(callsOf(fetchImpl)[0]?.body ?? '', /<d:propname\/>/, 'the report is a names-only discovery call');
  assert.doesNotMatch(callsOf(fetchImpl)[0]?.body ?? '', /getcontentlength/, 'it names no property of its own');
  assert.ok(report?.notes.some((n) => n.includes('<d:propname/>')), JSON.stringify(report?.notes));
});

test('a server that refuses propname still gets a report, and is told NOT MAPPED will be empty', async () => {
  const fetchImpl = fakeFetch([
    { match: (_u, m, body) => m === 'PROPFIND' && body.includes('<d:propname/>'), xml: '', status: 400 },
    propfindRoute(GENERIC_LISTING),
  ]);
  const dav = createWebdavProvider('w28b', GENERIC, CRED, fetchImpl);
  const report = await dav.sampleShape?.();
  assert.equal(callsOf(fetchImpl).length, 2, 'the discovery call is tried first, then the mapping body');
  assert.ok(report?.mapped.includes('getcontentlength'));
  const note = report?.notes.find((n) => n.includes('refused')) as string;
  assert.ok(note.includes('NOT MAPPED will be empty'), note);
  assert.ok(note.includes('<d:propname/>'), note);
});

test('capabilities: no search, no thumbnails, no expiring URLs, and never publish', () => {
  const dav = createWebdavProvider('w29', GENERIC, CRED, fakeFetch([]));
  assert.deepEqual(dav.capabilities, { authKind: 'credential', search: false, thumbnails: false, expiringUrls: false });
  assert.equal(dav.capabilities.publish, undefined, 'a federated source, never a publish destination');
  assert.equal(dav.publishAsset, undefined);
  assert.equal(dav.searchAssets, undefined);
  assert.equal(dav.detailShape, undefined, 'the byte path is a plain GET, so there is no second response to describe');
});
