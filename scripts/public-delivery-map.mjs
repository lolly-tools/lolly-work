// SPDX-License-Identifier: MPL-2.0
/** Compile epoch-zero physical wire metadata; never transform served bytes. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, openSync, writeFileSync, closeSync, utimesSync, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = message => { throw new Error(message); };
const need = (value, message) => value || fail(message);
const exact = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), 'Closed map input required');
const safe = path => typeof path === 'string' && path.length <= 1024
  && /^[A-Za-z0-9._@/+,[\]()-]+$/.test(path) && !path.startsWith('/')
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function aliases(url) {
  const paths = [url];
  if (url === '/index.html') paths.push('/');
  if (/^\/t\/[a-z0-9-]+\.html$/.test(url)) paths.push(url.slice(0, -5));
  if (url === '/info/index.html') paths.push('/docs');
  else if (/^\/info\/.+\.html$/.test(url)) paths.push('/docs/' + url.slice(6, -5));
  const views = { tools: ['/tools'], utilities: ['/utilities', '/u'], d: ['/d'],
    v: ['/v', '/verify', '/valid'], a: ['/a', '/assets', '/c'], p: ['/p'],
    start: ['/start'], lab: ['/lab'], batch: ['/batch', '/pro'], unpack: ['/unpack', '/pdf'], profile: ['/profile'] };
  const view = /^\/view\/([a-z]+)\.html$/.exec(url)?.[1];
  if (view) paths.push(...(views[view] ?? []));
  if (url === '/t/design.html') paths.push('/design');
  return paths;
}

/** Same native validator translation as Lolly build-delivery.ts, with real wire rows. */
export function compileMap(files, models = []) {
  need(Array.isArray(files) && files.length > 0 && files.length <= 120000
    && Array.isArray(models) && models.length <= 1024, 'Bounded complete map rows required');
  const lookup = new Map();
  for (const row of files) {
    exact(row, ['path', 'size', 'sha256']);
    need(safe(row.path) && !row.path.startsWith('models/') && !lookup.has(row.path)
      && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= 8 * 1024 ** 3
      && /^[a-f0-9]{64}$/.test(row.sha256), 'Invalid physical static row');
    lookup.set(row.path, row);
  }
  const validators = ['# Generated decoded/wire validators; not a public asset.',
    'map "$uri:$sent_http_content_encoding" $lolly_delivery_etag {', '    default "";'];
  const conditions = new Map(), validated = new Map();
  const matchers = { identity: new Map(), gzip: new Map() };
  const modelDirectories = new Map();
  const conditional = (url, row, coding) => {
    const native = `"0-${row.size.toString(16)}"`;
    for (const path of aliases(url)) {
      for (const prefix of ['', 'W/']) {
        const key = `${path}:${prefix}"${row.sha256}"`;
        need(!conditions.has(key) || conditions.get(key) === prefix + native, 'Ambiguous static validator');
        conditions.set(key, prefix + native);
        validated.set(`${path}:${prefix}${native}`, `"${row.sha256}"`);
      }
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchers[coding].set(`~^${escaped}:(?:[^,]*,)*\\s*(?:W/)?"${row.sha256}"\\s*(?:,|$)`, native);
    }
  };
  for (const row of files.filter(row => row.path !== '.delivery-etags.conf' && !/\.(gz|br)$/.test(row.path)).sort((a, b) => a.path < b.path ? -1 : 1)) {
    const url = '/' + row.path;
    for (const alias of aliases(url)) validators.push(`    "${alias}:" '"${row.sha256}"';`);
    conditional(url, row, 'identity');
    for (const [suffix, coding] of [['gz', 'gzip'], ['br', 'br']]) {
      const wire = lookup.get(row.path + '.' + suffix);
      if (!wire) continue;
      for (const alias of aliases(url)) validators.push(`    "${alias}:${coding}" '"${wire.sha256}"';`);
      if (coding === 'gzip') conditional(url, wire, coding);
    }
  }
  for (const row of models) {
    exact(row, ['url', 'size', 'sha256']);
    const match = typeof row.url === 'string' && /^\/models\/([a-z0-9-]+)(?:@([a-f0-9]{16}))?\/([A-Za-z0-9_./-]+)$/.exec(row.url);
    need(match && match[3].split('/').every(part => part && !part.startsWith('.')) && safe(row.url.slice(1))
      && !/\.(gz|br)$/.test(row.url) && Number.isSafeInteger(row.size) && row.size > 0
      && /^[a-f0-9]{64}$/.test(row.sha256), 'Reviewed identity-only model row required');
    need(!lookup.has(row.url.slice(1)), 'Model/static collision');
    validators.push(`    "${row.url}:" '"${row.sha256}"';`);
    conditional(row.url, row, 'identity');
    if (match[2]) {
      const key = match[1] + '@' + match[2];
      const group = modelDirectories.get(key) ?? [];
      group.push({ ...row, name: match[3] }); modelDirectories.set(key, group);
    }
  }
  need(new Set(models.map(row => row.url)).size === models.length, 'Duplicate model URL');
  for (const [directory, rows] of modelDirectories) {
    const digest = hash(rows.sort((a, b) => a.url < b.url ? -1 : 1)
      .map(row => `${row.name}\0${row.size}\0${row.sha256}\n`).join(''));
    need(directory.endsWith('@' + digest.slice(0, 16)), 'Incomplete or mismatched addressed model directory');
  }
  for (const row of files.filter(row => /\.(gz|br)$/.test(row.path))) {
    const identity = row.path.slice(0, -3);
    need(lookup.has(identity) && !/\.(gz|br)$/.test(identity) && identity !== '.delivery-etags.conf', 'Orphan coding row');
  }
  validators.push('}');
  for (const coding of ['identity', 'gzip']) {
    validators.push(`map "$uri:$http_if_none_match" $lolly_match_${coding} {`, '    default \'"lolly-unrecognized-validator"\';');
    for (const [key, value] of matchers[coding]) validators.push(`    ${JSON.stringify(key)} '${value}';`);
    validators.push('}');
  }
  validators.push('map $http_if_none_match $lolly_native_if_none_match {',
    '    default "$lolly_match_identity, $lolly_match_gzip";', '    "" "";', '    "*" "*";', '}',
    'map "$uri:$http_if_range" $lolly_native_if_range {', '    default \'"lolly-unrecognized-validator"\';', '    "~:$" "";');
  for (const [key, value] of conditions) if (!key.includes(':W/')) validators.push(`    ${JSON.stringify(key)} '${value}';`);
  validators.push('}', 'map "$uri:$upstream_http_etag" $lolly_validated_etag {', '    default "";');
  for (const [key, value] of validated) validators.push(`    ${JSON.stringify(key)} '${value}';`);
  validators.push('}', 'map $upstream_status $lolly_response_etag {', '    304 $lolly_validated_etag;', '    default $upstream_http_x_lolly_content_etag;', '}');
  let longest = 0;
  for (const key of conditions.keys()) longest = Math.max(longest, Buffer.byteLength(key));
  validators.unshift(`map_hash_bucket_size ${2 ** Math.ceil(Math.log2(Math.max(128, longest + 64)))};`,
    `map_hash_max_size ${2 ** Math.ceil(Math.log2(Math.max(2048, conditions.size)))};`);
  const result = validators.join('\n') + '\n';
  need(Buffer.byteLength(result) <= 64 * 1024 ** 2, 'Map file exceeds reviewed bound');
  return result;
}

/** Stream both codecs and bound decoded bytes to the expected identity. */
export async function verifyCodings(root, files) {
  const lookup = new Map(files.map(row => [row.path, row]));
  let count = 0;
  for (const row of files.filter(row => /\.(gz|br)$/.test(row.path))) {
    const expected = lookup.get(row.path.slice(0, -3));
    need(expected && safe(row.path), 'Coding identity absent');
    let bytes = 0;
    const digest = createHash('sha256');
    await pipeline(createReadStream(join(root, row.path)), row.path.endsWith('.gz') ? createGunzip() : createBrotliDecompress(),
      new Writable({ write(block, _encoding, callback) {
        bytes += block.length;
        if (bytes > expected.size) return callback(new Error('Decoded coding exceeds identity bound'));
        digest.update(block); callback();
      } }));
    need(bytes === expected.size && digest.digest('hex') === expected.sha256, 'Coding decode differs from exact identity');
    count++;
  }
  return count;
}

export async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  exact(input, ['version', 'root', 'files', 'models']);
  need(input.version === 1 && typeof input.root === 'string' && resolve(input.root) === input.root, 'Exact physical root required');
  const map = compileMap(input.files, input.models);
  const codings = await verifyCodings(input.root, input.files);
  // Keep large maps file-backed. The original receipt contains hashes/counts,
  // rather than duplicating tens of megabytes through JSON or logs.
  const target = join(input.root, '.delivery-etags.conf');
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(fd, map); } finally { closeSync(fd); }
  utimesSync(target, 0, 0);
  process.stdout.write(JSON.stringify({ version: 1, mapBytes: Buffer.byteLength(map), mapSha256: hash(map), decodedCodings: codings }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
