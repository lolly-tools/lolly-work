import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientBucket, parseClientHeader } from '../server/src/fleet/client-header.ts';

test('parses what the OSS shells send today', () => {
  assert.deepEqual(parseClientHeader('web engine/1.61.0'), { shell: 'web', engine: '1.61.0' });
  assert.deepEqual(parseClientHeader('tauri engine/1.61.0'), { shell: 'tauri', engine: '1.61.0' });
});

test('parses the richer future form', () => {
  const info = parseClientHeader('web/2.4.0 engine/1.61.0 platform/macos pwa/standalone');
  assert.deepEqual(info, {
    shell: 'web',
    shellVersion: '2.4.0',
    engine: '1.61.0',
    platform: 'macos',
    extra: { pwa: 'standalone' },
  });
});

test('tolerates junk without throwing; caps token count', () => {
  assert.equal(parseClientHeader(undefined), null);
  assert.equal(parseClientHeader(''), null);
  assert.equal(parseClientHeader('<script>alert(1)</script>'), null);
  const flood = `web ${Array.from({ length: 50 }, (_, i) => `k${i}/v`).join(' ')}`;
  const info = parseClientHeader(flood);
  assert.equal(info?.shell, 'web');
  assert.ok(Object.keys(info?.extra ?? {}).length <= 7);
});

test('bucket is stable and version-distinct', () => {
  const a = parseClientHeader('web engine/1.61.0');
  const b = parseClientHeader('web engine/1.60.0');
  assert.notEqual(clientBucket(a!), clientBucket(b!));
  assert.equal(clientBucket(a!), clientBucket(parseClientHeader('web engine/1.61.0')!));
});
