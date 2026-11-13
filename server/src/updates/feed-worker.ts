// SPDX-License-Identifier: MPL-2.0
/**
 * Runs the release feed's YAML parse off the main thread (feed-thread.ts), so a large
 * or hostile index can take its time without holding up requests and health checks.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseFeedYaml } from './feed.ts';

const { text, chart } = workerData as { text: string; chart: string };
try {
  parentPort!.postMessage({ ok: true, doc: parseFeedYaml(text, chart) });
} catch (error) {
  parentPort!.postMessage({ ok: false, code: (error as { code?: string }).code ?? 'invalid' });
}
