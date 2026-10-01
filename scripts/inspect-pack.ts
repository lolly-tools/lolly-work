// SPDX-License-Identifier: MPL-2.0
import { pathToFileURL } from 'node:url';
import { inspectPack } from '../server/src/setup/pack.ts';
import { loadConfig, parseConfig } from '../server/src/config/instance.ts';

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const config = args[0] && !process.env.LW_CONFIG ? parseConfig('{"policy":{"defaultAccessMode":"open"}}') : loadConfig();
  const report = await inspectPack(args[0] ?? config.instance.pack, {
    workerConfigured: !!config.render.worker.url && !!process.env.LW_RENDER_WORKER_SECRET,
    requireServerRendering: config.deployment.requireServerRendering,
    allowHooksInFastPath: config.render.allowHooksInFastPath,
    ...(args[1] ? { source: args[1] } : {}),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.compatible ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
