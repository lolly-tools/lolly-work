// SPDX-License-Identifier: MPL-2.0
/**
 * A resumable upload client for Work's parts protocol (docs/resumable-uploads.md),
 * used by `lw upload`. It reads the source one part at a time, so a large file
 * never sits in memory whole, and it records the upload id against the file's
 * digest before it sends a part. Run again after an interruption, it asks which
 * parts arrived, sends only the rest and finalizes. An upload that expired or
 * was cancelled meanwhile starts again from the beginning.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the bytes come from: a file handle, or anything else that reads by offset. */
export interface UploadSource { size: number; read(offset: number, length: number): Promise<Uint8Array> }

/** A project file (a signed-in person), or a scoped upload (a person or a service token). */
export type UploadTarget = { kind: 'project'; projectId: string } | { kind: 'upload'; scope: 'catalog-submission' | 'automation-input' };

/** What the client keeps between runs, per base address, target and file digest. */
export interface SavedUpload { id: string; checksum: string; size: number }
export interface UploadStateStore {
  get(key: string): Promise<SavedUpload | null>;
  set(key: string, value: SavedUpload): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ResumableUploadOptions {
  base: string;
  /** Credentials and client identification, sent on every request. */
  headers: Record<string, string>;
  target: UploadTarget;
  name: string;
  contentType: string;
  source: UploadSource;
  state: UploadStateStore;
  fetch?: typeof fetch;
  /** The protocol's part size; the instance's begin answer must agree. */
  partBytes?: number;
  /** Extra tries for one part after no answer, a 429 or a 5xx. */
  retries?: number;
  retryDelayMs?: number;
  onProgress?(sentBytes: number, totalBytes: number): void;
}

export interface UploadResult {
  id: string;
  checksum: string;
  size: number;
  /** True when this run carried on an upload an earlier run began. */
  resumed: boolean;
  /** The parts this run sent. */
  sentParts: number;
}

/** A refusal from the instance, or no answer at all (status 0). */
export class UploadClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'UploadClientError'; this.status = status; this.code = code; }
}

const PART_BYTES = 1024 * 1024;

/** The manifest of a source, in one pass that holds one part at a time. */
export async function describeSource(source: UploadSource, partBytes = PART_BYTES): Promise<{ checksum: string; parts: { size: number; checksum: string }[] }> {
  const whole = createHash('sha256');
  const parts: { size: number; checksum: string }[] = [];
  for (let offset = 0; offset < source.size; offset += partBytes) {
    const bytes = await source.read(offset, Math.min(partBytes, source.size - offset));
    whole.update(bytes);
    parts.push({ size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') });
  }
  return { checksum: whole.digest('hex'), parts };
}

/** The key one upload is saved under. */
export function uploadStateKey(base: string, target: UploadTarget, checksum: string, size: number): string {
  const where = target.kind === 'project' ? `project:${target.projectId}` : `upload:${target.scope}`;
  return createHash('sha256').update(`${base}\n${where}\n${checksum}\n${size}`).digest('hex');
}

/** Upload `source`, carrying on from a saved upload when there is one. */
export async function resumableUpload(o: ResumableUploadOptions): Promise<UploadResult> {
  const fetchFn = o.fetch ?? fetch;
  const partBytes = o.partBytes ?? PART_BYTES;
  const retries = o.retries ?? 3, retryDelayMs = o.retryDelayMs ?? 500;
  if (o.source.size < 1) throw new UploadClientError(400, 'INVALID_INPUT', 'an upload needs at least one byte');
  const root = o.target.kind === 'project' ? `${o.base}/api/v1/projects/${encodeURIComponent(o.target.projectId)}/files` : `${o.base}/api/v1/uploads`;
  const recordKey = o.target.kind === 'project' ? 'file' : 'upload';

  const request = async (method: string, url: string, body?: Uint8Array | string): Promise<Response> => {
    try {
      return await fetchFn(url, {
        method, headers: { ...o.headers, ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }) },
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new UploadClientError(0, 'NO_ANSWER', `no answer from ${o.base}: ${(error as Error).message}`);
    }
  };
  const refusal = async (res: Response): Promise<UploadClientError> => {
    const error = ((await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null)?.error;
    return new UploadClientError(res.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `HTTP ${res.status}`);
  };
  const passing = (error: unknown): boolean => error instanceof UploadClientError && (error.status === 0 || error.status === 429 || error.status >= 500);

  const { checksum, parts } = await describeSource(o.source, partBytes);
  const key = uploadStateKey(o.base, o.target, checksum, o.source.size);

  // Carry on from a saved upload: which parts does the instance hold?
  let id: string | null = null, missing: number[] = [], resumed = false;
  const saved = await o.state.get(key);
  if (saved && saved.checksum === checksum && saved.size === o.source.size) {
    const res = await request('GET', `${root}/${encodeURIComponent(saved.id)}/parts`);
    if (res.ok) {
      const progress = await res.json() as { ready: boolean; missing: number[]; partBytes: number };
      if (progress.partBytes !== partBytes) throw new UploadClientError(409, 'PART_SIZE', `the instance uses ${progress.partBytes}-byte parts`);
      id = saved.id; missing = progress.ready ? [] : progress.missing; resumed = true;
    } else if (res.status === 404 || res.status === 410) {
      // Expired, cancelled or swept: begin again under a new id.
      await o.state.delete(key);
    } else throw await refusal(res);
  }
  if (!id) {
    const begin = { name: o.name, size: o.source.size, checksum, contentType: o.contentType, parts,
      ...(o.target.kind === 'upload' ? { scope: o.target.scope } : { asset: {} }) };
    const res = await request('POST', root, JSON.stringify(begin));
    if (res.status !== 201) throw await refusal(res);
    const begun = await res.json() as Record<string, { id: string } | number>;
    if (begun.partBytes !== partBytes) throw new UploadClientError(409, 'PART_SIZE', `the instance uses ${String(begun.partBytes)}-byte parts`);
    id = (begun[recordKey] as { id: string }).id;
    // Saved before the first part, so an interruption from here on resumes.
    await o.state.set(key, { id, checksum, size: o.source.size });
    missing = parts.map((_, n) => n);
  }

  const at = `${root}/${encodeURIComponent(id)}`;
  let sentParts = 0;
  const sendMissing = async (): Promise<void> => {
    const pending = new Set(missing);
    let sentBytes = parts.reduce((sum, part, n) => sum + (pending.has(n) ? 0 : part.size), 0);
    o.onProgress?.(sentBytes, o.source.size);
    for (const n of missing) {
      const bytes = await o.source.read(n * partBytes, parts[n]!.size);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await request('PUT', `${at}/parts/${n}`, bytes);
          if (!res.ok) throw await refusal(res);
          break;
        } catch (error) {
          if (!passing(error) || attempt >= retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        }
      }
      sentParts++; sentBytes += parts[n]!.size;
      o.onProgress?.(sentBytes, o.source.size);
    }
  };
  await sendMissing();
  let res = await request('POST', `${at}/finalize`, '{}');
  if (res.status === 409) {
    // A part went missing after it was accepted: ask again and send what is gone.
    const progress = await request('GET', `${at}/parts`);
    if (!progress.ok) throw await refusal(progress);
    missing = (await progress.json() as { missing: number[] }).missing;
    await sendMissing();
    res = await request('POST', `${at}/finalize`, '{}');
  }
  if (!res.ok) {
    const error = await refusal(res);
    // An upload that can never finish is forgotten, so the next run begins afresh.
    if (error.status === 404 || error.status === 410 || error.status === 422) await o.state.delete(key);
    throw error;
  }
  const done = (await res.json() as Record<string, { id: string; checksum: string; size: number; ready: boolean }>)[recordKey]!;
  if (!done.ready || done.checksum !== checksum || done.size !== o.source.size) throw new UploadClientError(422, 'CHECKSUM_MISMATCH', 'the instance finished different bytes');
  await o.state.delete(key);
  return { id, checksum, size: o.source.size, resumed, sentParts };
}

/** A file read by offset through one open handle; close it when done. */
export async function fileSource(path: string): Promise<UploadSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buffer = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buffer, got, length - got, offset + got);
        if (!bytesRead) throw new Error('the file got shorter while it was being uploaded');
        got += bytesRead;
      }
      return buffer;
    },
    close: () => handle.close(),
  };
}

/** Saved uploads as one small private file each under `dir`. */
export function fileStateStore(dir: string): UploadStateStore {
  const at = (key: string): string => join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        const v = JSON.parse(await readFile(at(key), 'utf8')) as Partial<SavedUpload>;
        return typeof v.id === 'string' && typeof v.checksum === 'string' && typeof v.size === 'number' ? { id: v.id, checksum: v.checksum, size: v.size } : null;
      } catch { return null; }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(at(key), JSON.stringify(value), { mode: 0o600 });
      await chmod(at(key), 0o600);
    },
    async delete(key) { await rm(at(key), { force: true }); },
  };
}
