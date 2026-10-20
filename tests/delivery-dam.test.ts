// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrandfolderDeliveryProvider, type BrandfolderDeliveryOptions } from '../server/src/delivery/brandfolder.ts';
import { createCloudinaryDeliveryProvider, type CloudinaryDeliveryOptions } from '../server/src/delivery/cloudinary.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import type { DeliveryInput, DeliveryProgress } from '../server/src/delivery/types.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { destinationDescriptor, destinationVersion } from '../server/src/delivery/destinations.ts';
import { readDamOriginal } from '../server/src/delivery/dam-write.ts';

const bytes = Buffer.from('a private original file');
const input: DeliveryInput = { deliveryId: 'del_fixture', bytes, sha256: sha256Hex(bytes), name: 'Original', format: 'png', contentType: 'image/png' };
const bfOptions: BrandfolderDeliveryOptions = { brandfolderId: 'brand', sectionId: 'section', visibility: 'private', uploadOrigins: ['https://upload.example'], downloadOrigins: ['https://original.example'] };
const clOptions: CloudinaryDeliveryOptions = { cloudName: 'fixture', folderMode: 'dynamic', assetFolder: 'campaigns', publicIdPrefix: 'lolly' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function brandfolderFixture() {
  let progress: DeliveryProgress | undefined, created = 0, puts = 0, available = true, loseCreate = false, wrongScope = false;
  let uploadUrl = 'https://upload.example/ticket?signature=private', downloadUrl = 'https://original.example/file?signature=private';
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); calls.push(path);
    assert.equal(init?.redirect, path.startsWith('https://original.example') ? 'manual' : 'error');
    if (path.startsWith('https://upload.example') || path.startsWith('https://original.example')) {
      assert.equal(new Headers(init?.headers).has('authorization'), false, 'vendor credentials stay off storage requests');
      if (init?.method === 'PUT') { puts++; assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), bytes); return new Response(null); }
      return new Response(bytes);
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    if (path.endsWith('/upload_requests')) return json({ upload_url: uploadUrl, object_url: 'https://upload.example/object' });
    if (init?.method === 'POST') {
      created++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.section_key, 'section');
      assert.equal(body.data.attributes[0].attachments[0].url, 'https://upload.example/object');
      assert.equal(progress?.phase, 'creating', 'durable checkpoint precedes the non-idempotent create');
      if (loseCreate) throw new Error('network failure with signature=private fixture-token');
      return json({ data: [{ id: 'asset1' }] });
    }
    if (path.includes('/assets/asset1?')) return json({ data: { id: 'asset1', relationships: { brandfolder: { data: { id: wrongScope ? 'other' : 'brand' } }, section: { data: { id: 'section' } } } } });
    if (path.endsWith('/assets/asset1/attachments')) return json({ data: available ? [{ id: 'attachment1', attributes: { url: downloadUrl } }] : [] });
    throw new Error(`unexpected fixture request ${path}`);
  };
  return { provider: createBrandfolderDeliveryProvider(bfOptions, 'fixture-token', fetcher),
    deliver: () => createBrandfolderDeliveryProvider(bfOptions, 'fixture-token', fetcher).deliver({ ...input, progress, checkpoint: async value => { progress = structuredClone(value); } }),
    get progress() { return progress; }, get created() { return created; }, get puts() { return puts; }, calls,
    available: (value: boolean) => { available = value; }, loseCreate: () => { loseCreate = true; }, wrongScope: () => { wrongScope = true; },
    upload: (value: string) => { uploadUrl = value; }, download: (value: string) => { downloadUrl = value; },
  };
}

test('Brandfolder creates once, verifies its original and resumes processing without a second upload', async () => {
  const b = brandfolderFixture(); b.available(false);
  await assert.rejects(b.deliver(), /not ready/);
  assert.deepEqual(b.progress, { phase: 'created', remoteId: 'asset1' });
  b.available(true);
  assert.deepEqual(await b.deliver(), { remoteId: 'asset1', deliveredSha256: input.sha256, transformation: 'none' });
  assert.equal(b.created, 1); assert.equal(b.puts, 1);
});

test('Brandfolder lost create response stays uncertain and never blindly creates twice', async () => {
  const b = brandfolderFixture(); b.loseCreate();
  await assert.rejects(b.deliver(), error => !String(error).includes('fixture-token') && !String(error).includes('signature=private'));
  assert.deepEqual(b.progress, { phase: 'creating' });
  await assert.rejects(b.deliver(), /Reconcile/);
  assert.equal(b.created, 1); assert.equal(b.puts, 1);
});

test('Brandfolder refuses creation when write authority is revoked during its durable checkpoint', async () => {
  const b = brandfolderFixture();
  let allowed = true, progress: DeliveryProgress | undefined;
  const authorize = async () => { if (!allowed) throw new Error('revoked'); };
  const checkpoint = async (value: DeliveryProgress) => {
    progress = structuredClone(value);
    if (value.phase === 'creating') allowed = false;
  };
  await assert.rejects(b.provider.deliver({ ...input, authorize, checkpoint }), /revoked/);
  assert.equal(b.puts, 1); assert.equal(b.created, 0);
  assert.deepEqual(progress, { phase: 'creating' });
  await assert.rejects(b.provider.deliver({ ...input, authorize, checkpoint, progress }), /Reconcile/);
  assert.equal(b.puts, 1); assert.equal(b.created, 0);
});

test('Brandfolder requires durable progress, rejects redirected or unqualified storage and rechecks write authority', async () => {
  const b = brandfolderFixture();
  await assert.rejects(b.provider.deliver(input), /durable progress/);
  b.upload('https://upload.example.evil/ticket');
  await assert.rejects(b.deliver(), /outside/); assert.equal(b.puts, 0);
  const other = brandfolderFixture(); other.download('https://127.0.0.1/file');
  await assert.rejects(other.deliver(), /outside/);
  const scoped = brandfolderFixture(); scoped.wrongScope();
  await assert.rejects(scoped.deliver(), /outside the configured destination/);
  const denied = brandfolderFixture();
  await assert.rejects(denied.provider.deliver({ ...input, checkpoint: async () => {}, authorize: async () => { throw new Error('revoked'); } }), /revoked/);
  assert.equal(denied.puts, 0);
});

function cloudinaryFixture() {
  let resource: Record<string, unknown> | null = null, uploads = 0, loseUpload = false, original = bytes;
  const publicId = `lolly/${input.deliveryId}/${input.sha256}.png`;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); assert.equal(init?.redirect, 'error');
    if (path.includes('/resources/raw/authenticated/')) return resource ? json(resource) : json({}, 404);
    if (path.endsWith('/raw/upload')) {
      uploads++;
      const form = init?.body as FormData;
      assert.equal(form.get('overwrite'), 'false'); assert.equal(form.get('type'), 'authenticated');
      assert.equal(form.get('public_id'), publicId); assert.equal(form.get('asset_folder'), 'campaigns');
      for (const forbidden of ['upload_preset', 'eager', 'transformation', 'folder', 'moderation', 'categorization']) assert.equal(form.has(forbidden), false);
      assert.deepEqual(Buffer.from(await (form.get('file') as Blob).arrayBuffer()), bytes);
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Basic /);
      resource = { asset_id: 'asset1', public_id: publicId, type: 'authenticated', resource_type: 'raw', asset_folder: 'campaigns', context: { custom: { lolly_delivery: input.deliveryId, lolly_sha256: input.sha256 } } };
      if (loseUpload) throw new Error('network failure containing secret');
      return json(resource);
    }
    if (path.endsWith('/asset/download')) {
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('asset_id'), 'asset1'); assert.match(form.get('signature')!, /^[a-f0-9]{64}$/);
      return new Response(original);
    }
    throw new Error('unexpected request');
  };
  return { deliver: () => createCloudinaryDeliveryProvider(clOptions, JSON.stringify({ apiKey: 'key', apiSecret: 'secret' }), fetcher).deliver(input),
    get uploads() { return uploads; }, loseUpload: () => { loseUpload = true; }, corrupt: () => { original = Buffer.from('changed'); },
    collide: () => { resource = { public_id: publicId, context: { custom: {} } }; },
  };
}

test('Cloudinary creates authenticated raw bytes and reconciles a lost upload response without overwriting', async () => {
  const c = cloudinaryFixture(); c.loseUpload();
  await assert.rejects(c.deliver(), error => !String(error).includes('secret'));
  const receipt = await c.deliver();
  assert.deepEqual(receipt, { remoteId: 'asset1', deliveredSha256: input.sha256, transformation: 'none' });
  assert.equal(c.uploads, 1);
});

test('Cloudinary collisions and byte changes never produce a successful receipt or replacement', async () => {
  const collision = cloudinaryFixture(); collision.collide();
  await assert.rejects(collision.deliver(), /not belong/); assert.equal(collision.uploads, 0);
  const changed = cloudinaryFixture(); changed.corrupt();
  await assert.rejects(changed.deliver(), /digest mismatch/);
  await assert.rejects(changed.deliver(), /digest mismatch/); assert.equal(changed.uploads, 1);
});

test('original readback follows only bounded qualified redirects without forwarding credentials', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: '/original' } }) : new Response(bytes);
  };
  assert.equal(await readDamOriginal('https://original.example/start', ['https://original.example'], input, fetcher), input.sha256);
  assert.deepEqual(urls, ['https://original.example/start', 'https://original.example/original']);
  let calls = 0;
  await assert.rejects(readDamOriginal('https://original.example/start', ['https://original.example'], input, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  }), /outside/); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readDamOriginal('https://original.example/start', ['https://original.example'], input, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: '/loop' } });
  }), /redirect limit/); assert.equal(calls, 4);
});

test('DAM destination validation is explicit and descriptors disclose capability without configuration', () => {
  const destination = { id: 'dam', kind: 'brandfolder' as const, label: 'Brandfolder', credentialRef: 'PRIVATE_DAM_KEY', enabled: true, formats: ['png'], projectFiles: true, options: { ...bfOptions } };
  const config = parseConfig(JSON.stringify({ dev: { enabled: true }, delivery: { destinations: [destination] } }));
  assert.deepEqual(destinationDescriptor(config.delivery.destinations[0]!, 1024), { id: 'dam', kind: 'brandfolder', label: 'Brandfolder', formats: ['png'], maxBytes: 1024, visibility: 'private', projectFiles: true });
  assert.notEqual(destinationVersion(destination), destinationVersion({ ...destination, projectFiles: false }));
  assert.equal(destinationVersion(destination), destinationVersion({ ...destination, credentialRef: 'ROTATED' }));
  for (const options of [{ ...bfOptions, uploadOrigins: ['http://127.0.0.1'] }, { ...bfOptions, visibility: undefined }]) {
    assert.throws(() => parseConfig(JSON.stringify({ dev: { enabled: true }, delivery: { destinations: [{ ...destination, options }] } })));
  }
  assert.throws(() => createCloudinaryDeliveryProvider({ ...clOptions, folderMode: 'fixed' } as unknown as CloudinaryDeliveryOptions, '{}'), /dynamic/);
});
