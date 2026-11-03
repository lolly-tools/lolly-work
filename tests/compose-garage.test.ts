import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'compose');
const compose = parseYaml(readFileSync(join(DIR, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { profiles?: string[]; ports?: string[]; environment?: Record<string, string>; volumes?: string[]; image?: string }>;
  volumes: Record<string, unknown>;
};

test('compose: the Garage store is opt-in, private to the stack and keeps its data in volumes', () => {
  const garage = compose.services.garage!;
  assert.deepEqual(garage.profiles, ['garage'], 'a plain `docker compose up` must not start it');
  assert.equal(garage.ports, undefined, 'no published port: only the server reaches the store');
  assert.match(garage.image ?? '', /^dxflrs\/garage:v\d+\.\d+\.\d+$/, 'a pinned release, never latest');
  assert.match(garage.environment!.GARAGE_RPC_SECRET!, /^\$\{GARAGE_RPC_SECRET:\?/, 'the secret is required and never written in the file');
  for (const volume of ['garage-meta', 'garage-data']) assert.ok(volume in compose.volumes);
  assert.ok(garage.volumes!.some(v => v.startsWith('./garage/garage.toml:')));
});

test('compose: the server receives the blob credential the S3 backend reads', () => {
  assert.match(compose.services.server!.environment!.LW_BLOBS_S3_CREDENTIAL!, /LW_BLOBS_S3_CREDENTIAL/);
  const toml = readFileSync(join(DIR, 'garage', 'garage.toml'), 'utf8');
  assert.match(toml, /^replication_factor = 1$/m);
  assert.doesNotMatch(toml, /rpc_secret\s*=/, 'the RPC secret comes from the environment');
  // The README steps use the bucket, region and endpoint the instance.json example gives the server.
  const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
  assert.match(readme, /"endpoint": "http:\/\/garage:3900"/);
  assert.match(readme, /s3_region|"region": "garage"/);
  assert.match(toml, /s3_region = "garage"/);
});
