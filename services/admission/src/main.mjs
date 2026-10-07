// SPDX-License-Identifier: MPL-2.0
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { connectRedis } from './redis.mjs';
import { executeCommand } from './protocol.mjs';
import { makeHandler } from './http.mjs';

async function main() {
  const env = process.env;
  const [key, cert, mcp, ca] = await Promise.all([
    readFile(env.ADMISSION_TLS_KEY_FILE), readFile(env.ADMISSION_TLS_CERT_FILE),
    readFile(env.ADMISSION_MCP_TOKEN_FILE, 'utf8'), readFile(env.ADMISSION_CA_TOKEN_FILE, 'utf8'),
  ]);
  const client = await connectRedis({ urlFile: env.ADMISSION_REDIS_URL_FILE, caFile: env.ADMISSION_REDIS_CA_FILE });
  const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, makeHandler({
    tokens: { mcp: mcp.trim(), ca: ca.trim() }, ready: () => client.isReady,
    execute: command => executeCommand(client, command),
  }));
  server.requestTimeout = 3000; server.headersTimeout = 3000; server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  const port = Number(env.ADMISSION_PORT || '8443');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid admission port');
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  console.info('[admission] HTTPS service ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { client.destroy(); process.exit(0); });
    setTimeout(() => { client.destroy(); process.exit(1); }, 4000).unref();
  });
}
main().catch(() => { console.error('[admission] startup failed; check protected configuration'); process.exit(1); });
