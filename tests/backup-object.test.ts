// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  openArchive,
  publishRestore,
  sealArchive,
  uploadArchive,
  validateObject,
  validateStorage,
} from "../scripts/backup-object.ts";

const creds = {
  endpoint: "https://objects.example.com",
  region: "europe-2",
  bucket: "private-backups",
  prefix: "lolly-ing/",
  access_key_id: "fixture00000001",
  secret_access_key: "fixture-secret-not-a-real-credential",
};

test("a projected ConfigMap-style CLI symlink executes and refuses invalid input instead of succeeding silently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lolly-backup-cli-"));
  try {
    const entry = join(dir, "operator.ts");
    await symlink(fileURLToPath(new URL("../scripts/backup-object.ts", import.meta.url)), entry);
    const result = spawnSync(process.execPath, [entry, "invalid-command"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Backup failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sealed backups recover exact binary bytes with randomized authenticated encryption", () => {
  const input = randomBytes(200_000);
  const key = randomBytes(32);
  const first = sealArchive(input, key);
  const second = sealArchive(input, key);
  assert.notDeepEqual(first, second);
  assert.deepEqual(openArchive(first, key).bytes, input);
  assert.deepEqual(openArchive(second, key).bytes, input);
  assert.equal(openArchive(first, key).header.size, input.length);
  assert.equal(first.includes(input.subarray(0, 100)), false);
});

test("wrong keys, altered headers, nonces, payloads, tags and truncation cannot recover a backup", () => {
  const key = randomBytes(32);
  const sealed = sealArchive(Buffer.from("critical persisted workspace"), key);
  assert.throws(() => openArchive(sealed, randomBytes(32)));
  const headerEnd = 13 + sealed.readUInt32BE(9);
  for (const offset of [0, 12, 22, headerEnd, headerEnd + 12, sealed.length - 1]) {
    const corrupt = Buffer.from(sealed);
    corrupt[offset] = corrupt[offset]! ^ 1;
    assert.throws(() => openArchive(corrupt, key));
  }
  assert.throws(() => openArchive(sealed.subarray(0, -1), key));
  assert.throws(() => sealArchive(Buffer.alloc(0), key));
  assert.throws(() => sealArchive(Buffer.from("a"), Buffer.alloc(16)));
});

test("backup credentials require TLS and an explicit isolated object prefix", () => {
  assert.deepEqual(validateStorage(creds), creds);
  for (const endpoint of [
    "http://objects.example.com",
    "https://user:pass@objects.example.com",
    "https://objects.example.com/path",
    "https://objects.example.com/?token=secret",
    "https://objects.example.com:4443",
  ])
    assert.throws(() => validateStorage({ ...creds, endpoint }));
  for (const prefix of ["", "/", "lolly-ing", "../", "lolly-ing/../", "lolly-ing//", "lolly-ing/%2f/"])
    assert.throws(() => validateStorage({ ...creds, prefix }));
  for (const name of [
    "other/archive",
    "lolly-ing/../archive",
    "lolly-ing//archive",
    "lolly-ing/%2e/archive",
    "lolly-ing/",
  ])
    assert.throws(() => validateObject(creds, name));
  validateObject(creds, "lolly-ing/postgres/2026-10-07.lwbackup");
});

test("upload verifies the entire retrieved ciphertext and plaintext before reporting success", async () => {
  const input = Buffer.from("postgres custom archive fixture");
  const key = randomBytes(32);
  let stored: Buffer | undefined;
  const backend = async (_c: typeof creds, object: string, method: "GET" | "PUT", body?: Buffer): Promise<Buffer> => {
    assert.ok(object.startsWith("lolly-ing/"));
    assert.ok(object.endsWith(".lwbackup"));
    if (method === "PUT") {
      stored = Buffer.from(body!);
      return Buffer.alloc(0);
    }
    return Buffer.from(stored!);
  };
  const one = await uploadArchive(creds, input, key, backend);
  const two = await uploadArchive(creds, input, key, backend);
  assert.notEqual(one.object, two.object);
  assert.equal(one.size, input.length);
  assert.equal(one.sha256, two.sha256);
  await assert.rejects(
    uploadArchive(creds, input, key, async (...args) => {
      const b = await backend(...args);
      if (args[2] === "GET") b[b.length - 1] = b[b.length - 1]! ^ 1;
      return b;
    }),
    /ciphertext differs/,
  );
});

test("verified restore is private, exclusive and preserves existing data without scratch leakage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lolly-backup-test-"));
  try {
    const output = join(dir, "restored.dump");
    const input = Buffer.from("verified database");
    await publishRestore(output, input);
    assert.deepEqual(await readFile(output), input);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(publishRestore(output, Buffer.from("replacement")));
    assert.deepEqual(await readFile(output), input);
    const existing = join(dir, "existing");
    await writeFile(existing, "preserved");
    await assert.rejects(publishRestore(existing, input));
    assert.equal(await readFile(existing, "utf8"), "preserved");
    assert.deepEqual((await readdir(dir)).sort(), ["existing", "restored.dump"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
