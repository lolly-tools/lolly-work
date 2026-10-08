// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { createClient } from '@redis/client';

export async function connectRedis({ urlFile, caFile, allowLoopback = false, operator = false }) {
  const url = (await readFile(urlFile, 'utf8')).trim();
  const parsed = new URL(url);
  if (parsed.protocol !== 'rediss:' && !(allowLoopback && parsed.protocol === 'redis:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Redis TLS is required outside explicit loopback tests');
  }
  const ca = caFile ? await readFile(caFile) : undefined;
  const client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 64,
    socket: { connectTimeout: 1500, ...(operator ? { reconnectStrategy: false } : {}), ...(ca ? { ca } : {}) } });
  // Do not leak a connection string, command, certificate or counter in errors.
  client.on('error', () => console.warn('[admission] Redis connection unavailable'));
  await client.connect();
  return operator ? client.withCommandOptions({ timeout: 3000 }) : client;
}
