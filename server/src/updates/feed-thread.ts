// SPDX-License-Identifier: MPL-2.0
/**
 * The release feed is parsed in a worker thread with a deadline and memory limits. A
 * YAML parse is synchronous and the index comes from the network, unsigned: a few
 * megabytes of valid YAML can take seconds, and on the main thread that would stall
 * every request and the health checks with it. The worker is terminated at the
 * deadline. A bundle that does not carry the worker file (the serverless function)
 * parses in-process, and only an index small enough to parse quickly.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHART_NAME, FeedError, parseChartIndex, releasesFromIndex, type FeedRelease } from './feed.ts';

export const PARSE_DEADLINE_MS = 5000;
/** The most an in-process parse takes on, when no worker can run. */
export const IN_PROCESS_MAX_BYTES = 256 * 1024;
const WORKER = new URL('./feed-worker.ts', import.meta.url);

export async function parseChartIndexOffThread(text: string, { chart = CHART_NAME, deadlineMs = PARSE_DEADLINE_MS } = {}): Promise<FeedRelease[]> {
  let workerFile: string | null = null;
  try { workerFile = WORKER.protocol === 'file:' && existsSync(fileURLToPath(WORKER)) ? fileURLToPath(WORKER) : null; } catch { workerFile = null; }
  if (!workerFile) {
    if (Buffer.byteLength(text) > IN_PROCESS_MAX_BYTES) throw new FeedError('too-large', 'The release feed is too large to read here.');
    return parseChartIndex(text, chart);
  }
  const doc = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { text, chart }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new FeedError('too-slow', 'The release feed took too long to read.')); }, deadlineMs);
    const done = () => { clearTimeout(timer); void worker.terminate(); };
    worker.once('message', (message: { ok: boolean; doc?: unknown; code?: string }) => {
      done();
      if (message.ok) resolve(message.doc);
      else reject(new FeedError(message.code ?? 'invalid', 'The release feed could not be read.'));
    });
    worker.once('error', () => { done(); reject(new FeedError('invalid', 'The release feed could not be read.')); });
    worker.once('exit', () => { done(); reject(new FeedError('invalid', 'The release feed could not be read.')); });
  });
  return releasesFromIndex(doc, chart);
}
