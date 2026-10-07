// SPDX-License-Identifier: MPL-2.0
/** Bounded encrypted PostgreSQL archives in an operator's private S3 prefix. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signS3Request } from "../server/src/catalog/providers/s3.ts";

export const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_OBJECT = MAX_ARCHIVE + 4096;
const MAGIC = Buffer.from("LWBACKUP1");
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
interface Header {
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  sha256: string;
  size: number;
  createdAt: string;
}
export interface StorageCredentials {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_access_key: string;
}

export function sealArchive(bytes: Buffer, key: Buffer, now = new Date()): Buffer {
  if (key.length !== 32 || bytes.length === 0 || bytes.length > MAX_ARCHIVE)
    throw new Error("Invalid backup key or archive size");
  const header: Header = {
    version: 1,
    algorithm: "AES-256-GCM",
    keyId: digest(key).slice(0, 16),
    sha256: digest(bytes),
    size: bytes.length,
    createdAt: now.toISOString(),
  };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([MAGIC, length, json, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([aad, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

export function openArchive(bytes: Buffer, key: Buffer): { bytes: Buffer; header: Header } {
  if (
    key.length !== 32 ||
    bytes.length > MAX_OBJECT ||
    bytes.length < MAGIC.length + 4 + 12 + 16 ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error("Invalid sealed archive");
  const length = bytes.readUInt32BE(MAGIC.length);
  const headerEnd = MAGIC.length + 4 + length;
  const cipherStart = headerEnd + 12;
  if (length === 0 || length > 2048 || cipherStart + 16 >= bytes.length)
    throw new Error("Invalid sealed archive header");
  const header = JSON.parse(bytes.subarray(MAGIC.length + 4, headerEnd).toString()) as Header;
  if (
    header.version !== 1 ||
    header.algorithm !== "AES-256-GCM" ||
    header.keyId !== digest(key).slice(0, 16) ||
    !/^[a-f0-9]{64}$/.test(header.sha256) ||
    !Number.isSafeInteger(header.size) ||
    header.size <= 0 ||
    header.size > MAX_ARCHIVE ||
    !Number.isFinite(Date.parse(header.createdAt))
  )
    throw new Error("Invalid sealed archive metadata");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(headerEnd, cipherStart));
  decipher.setAAD(bytes.subarray(0, cipherStart));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(cipherStart, -16)), decipher.final()]);
  if (plain.length !== header.size || digest(plain) !== header.sha256)
    throw new Error("Backup plaintext integrity mismatch");
  return { bytes: plain, header };
}

/** Projected Kubernetes secrets may use symlinks; open the resolved regular file. */
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const resolved = await realpath(path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > limit)
      throw new Error("Input must be a bounded regular file");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Input changed while reading");
    return bytes;
  } finally {
    await file.close();
  }
}

export function validateStorage(value: unknown): StorageCredentials {
  if (!value || typeof value !== "object") throw new Error("Invalid storage credentials");
  const c = value as StorageCredentials;
  const endpoint = new URL(c.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    (endpoint.port && endpoint.port !== "443")
  )
    throw new Error("Use an HTTPS S3 endpoint without path or credentials");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket) || !/^[a-z0-9-]{1,40}$/.test(c.region))
    throw new Error("Invalid storage bucket or region");
  if (
    typeof c.prefix !== "string" ||
    c.prefix.length > 200 ||
    !c.prefix.endsWith("/") ||
    c.prefix
      .split("/")
      .slice(0, -1)
      .some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..")
  )
    throw new Error("Require a bounded private object prefix");
  if (
    !/^[A-Za-z0-9]{8,128}$/.test(c.access_key_id) ||
    typeof c.secret_access_key !== "string" ||
    c.secret_access_key.length < 16 ||
    c.secret_access_key.length > 256 ||
    /[\x00-\x20]/.test(c.secret_access_key)
  )
    throw new Error("Invalid storage credential");
  return c;
}

export function validateObject(c: StorageCredentials, object: string): void {
  if (
    !object.startsWith(c.prefix) ||
    object.length > 512 ||
    object === c.prefix ||
    object.split("/").some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..")
  )
    throw new Error("Object must stay within the private backup prefix");
}

async function request(c: StorageCredentials, object: string, method: "GET" | "PUT", body?: Buffer): Promise<Buffer> {
  validateObject(c, object);
  const signed = signS3Request({
    options: { endpoint: c.endpoint, region: c.region, bucket: c.bucket },
    accessKeyId: c.access_key_id,
    secretAccessKey: c.secret_access_key,
    key: object,
    method,
    ...(body ? { payloadHash: digest(body) } : {}),
  });
  const response = await fetch(signed.url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { ...signed.headers, ...(body ? { "content-type": "application/octet-stream" } : {}) },
    ...(body ? { body } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Private backup storage returned ${response.status}`);
  }
  if (method === "PUT") {
    await response.body?.cancel();
    return Buffer.alloc(0);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_OBJECT)) {
    await response.body?.cancel();
    throw new Error("Remote archive exceeds the backup bound");
  }
  if (!response.body) throw new Error("Remote archive has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_OBJECT) throw new Error("Remote archive exceeds the backup bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  if (declared !== null && size !== Number(declared)) throw new Error("Remote archive is truncated");
  return Buffer.concat(chunks, size);
}

export async function uploadArchive(
  c: StorageCredentials,
  input: Buffer,
  key: Buffer,
  fetchObject = request,
): Promise<{ object: string; sha256: string; size: number; keyId: string }> {
  const sealed = sealArchive(input, key);
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(8).toString("hex") + ".lwbackup";
  const object = c.prefix + name;
  await fetchObject(c, object, "PUT", sealed);
  const remote = await fetchObject(c, object, "GET");
  if (digest(remote) !== digest(sealed)) throw new Error("Stored ciphertext differs from the uploaded archive");
  const { header } = openArchive(remote, key);
  return { object, sha256: header.sha256, size: header.size, keyId: header.keyId };
}

/** Link the verified private temporary file exclusively; never overwrite a target. */
export async function publishRestore(path: string, bytes: Buffer): Promise<void> {
  const target = resolve(path);
  const temp = await mkdtemp(resolve(dirname(target), ".lolly-backup-"));
  try {
    const staging = resolve(temp, "verified.dump");
    const file = await open(staging, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staging, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (!["upload", "verify", "restore"].includes(command ?? "") || options.length % 2)
    throw new Error("Use upload/verify/restore with --credentials, --key and --input or --object/--output");
  const flags = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i]!;
    const value = options[i + 1]!;
    if (!["--credentials", "--key", "--input", "--object", "--output"].includes(flag) || flags.has(flag) || !value)
      throw new Error("Unknown or duplicate backup argument");
    flags.set(flag, value);
  }
  const required = (name: string): string => {
    const v = flags.get(name);
    if (!v) throw new Error("Missing backup argument");
    return v;
  };
  const c = validateStorage(JSON.parse((await boundedFile(required("--credentials"), 16_384)).toString()));
  const hex = (await boundedFile(required("--key"), 128)).toString().trim();
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Encryption key must contain 64 lowercase hex characters");
  const key = Buffer.from(hex, "hex");
  if (command === "upload") {
    if (flags.has("--output") || flags.has("--object")) throw new Error("Upload creates a new immutable backup name");
    const result = await uploadArchive(c, await boundedFile(required("--input"), MAX_ARCHIVE), key);
    process.stdout.write(JSON.stringify({ status: "VERIFIED", ...result }) + "\n");
  } else {
    if (flags.has("--input") || (command === "verify" && flags.has("--output")))
      throw new Error("Unexpected restore argument");
    const { bytes, header } = openArchive(await request(c, required("--object"), "GET"), key);
    if (command === "restore") await publishRestore(required("--output"), bytes);
    process.stdout.write(
      JSON.stringify({ status: "VERIFIED", sha256: header.sha256, size: header.size, keyId: header.keyId }) + "\n",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Backup failed; no credentials or unverified restore output were printed. Inspect job status and the private operator inputs.\n",
    );
    process.exitCode = 1;
  });
}
