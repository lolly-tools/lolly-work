// SPDX-License-Identifier: MPL-2.0
import { request } from 'node:https';
import { readPem } from './transport.ts';

const port = Number(process.env.PORT ?? 8791);
if (process.env.LW_RENDER_TLS_CERT_FILE) {
  const servername = process.env.LW_RENDER_TLS_SERVER_NAME;
  if (!servername || !/^[a-zA-Z0-9.-]+$/.test(servername)) process.exit(1);
  const req = request({ host: '127.0.0.1', servername, port, path: '/healthz', method: 'GET',
    ...(process.env.LW_RENDER_TLS_CA_FILE ? { ca: readPem(process.env.LW_RENDER_TLS_CA_FILE) } : {}),
    timeout: 3000, rejectUnauthorized: true }, res => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
  req.on('timeout', () => req.destroy()); req.on('error', () => process.exit(1)); req.end();
} else {
  if (process.env.NODE_ENV === 'production' && process.env.LW_RENDER_DEPLOYMENT_MODE !== 'evaluation') process.exit(1);
  fetch(`http://127.0.0.1:${port}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
    .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
}
