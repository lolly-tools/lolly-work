// SPDX-License-Identifier: MPL-2.0
import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

export function readPem(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new Error('Invalid worker TLS file');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count !== stat.size) throw new Error('Worker TLS file changed while reading');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

export function workerTransport(handler: RequestListener, env: NodeJS.ProcessEnv = process.env) {
  const certPath = env.LW_RENDER_TLS_CERT_FILE, keyPath = env.LW_RENDER_TLS_KEY_FILE;
  if (!!certPath !== !!keyPath) throw new Error('Both worker TLS certificate and key files are required');
  if (env.LW_RENDER_DEPLOYMENT_MODE && !['production', 'evaluation'].includes(env.LW_RENDER_DEPLOYMENT_MODE)) {
    throw new Error('Invalid worker deployment mode');
  }
  const production = env.LW_RENDER_DEPLOYMENT_MODE === 'production' ||
    (env.NODE_ENV === 'production' && env.LW_RENDER_DEPLOYMENT_MODE !== 'evaluation');
  if (!certPath || !keyPath) {
    if (production) throw new Error('Production worker requires TLS certificate and key files');
    return { server: httpServer(handler), host: '127.0.0.1', tls: false };
  }
  const cert = readPem(certPath), key = readPem(keyPath);
  const leaf = new X509Certificate(cert);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('Worker TLS certificate and key do not match');
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo)) throw new Error('Worker TLS certificate is outside its validity period');
  createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
  return { server: httpsServer({ cert, key, minVersion: 'TLSv1.2' }, handler), host: '0.0.0.0', tls: true };
}
