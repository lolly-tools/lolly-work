// SPDX-License-Identifier: MPL-2.0
/**
 * Single byte ranges for federated files (`/catalog/ext`, plan 294). The API
 * route parses a Range header before it knows the file size, a driver that
 * declares `ranges` forwards it, and the partial reply is checked against the
 * request before any byte reaches the caller. Access checks stay in the route:
 * every ranged read is a full request that passes them again.
 */
import type { ByteRangeRequest, ServedByteRange } from './providers/types.ts';

/** An upstream or stored file cannot satisfy the requested range. */
export class RangeNotSatisfiableError extends Error {
  /** The complete length when the reply stated it. */
  readonly size: number | undefined;
  constructor(size?: number) {
    super('the requested byte range is outside the file');
    this.name = 'RangeNotSatisfiableError';
    this.size = size;
  }
}

/** One range from a Range header: null when absent, false when malformed, multiple or not in bytes. */
export function parseByteRange(header: string | string[] | undefined): ByteRangeRequest | null | false {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header));
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : false;
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return false;
  if (!match[2]) return { start };
  const end = Number(match[2]);
  return Number.isSafeInteger(end) && end >= start ? { start, end } : false;
}

/** The bytes a range selects from a file of `size` bytes, or false when none. */
export function satisfyByteRange(range: ByteRangeRequest, size: number): ServedByteRange | false {
  if (!Number.isSafeInteger(size) || size <= 0) return false;
  if ('suffix' in range) return { start: Math.max(0, size - range.suffix), end: size - 1, size };
  if (range.start >= size) return false;
  return { start: range.start, end: Math.min(size - 1, range.end ?? size - 1), size };
}

export const rangeHeaderValue = (range: ByteRangeRequest): string =>
  'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end ?? ''}`;

export const contentRangeValue = (part: ServedByteRange): string => `bytes ${part.start}-${part.end}/${part.size}`;

/** The complete length a 416 reply states in its Content-Range, if any. */
export function unsatisfiedSize(contentRange: string | null): number | undefined {
  const match = /^bytes \*\/(\d+)$/.exec(contentRange?.trim() ?? '');
  const size = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(size) ? size : undefined;
}

/**
 * Accept a 206 only when its Content-Range is exactly what the request selects
 * from the stated complete length, and any Content-Length agrees with it.
 */
export function checkPartialReply(range: ByteRangeRequest, contentRange: string | null, contentLength: string | null): ServedByteRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange?.trim() ?? '');
  if (!match) return null;
  const [start, end, size] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const expected = satisfyByteRange(range, size);
  if (!expected || expected.start !== start || expected.end !== end) return null;
  if (contentLength !== null && (!/^\d+$/.test(contentLength.trim()) || Number(contentLength) !== end - start + 1)) return null;
  return expected;
}

/** Pass exactly `length` bytes or fail the stream, so a short or long body never looks complete. */
export function exactLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > length) controller.error(new Error('the partial body is longer than its range'));
      else controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== length) controller.error(new Error('the partial body is shorter than its range'));
    },
  }));
}
