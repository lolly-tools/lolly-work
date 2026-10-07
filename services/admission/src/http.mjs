// SPDX-License-Identifier: MPL-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseCommand } from './protocol.mjs';

const hash = value => createHash('sha256').update(value).digest();

export function makeHandler({ tokens, ready, execute, maxActive = 32, timeoutMs = 1500 }) {
  if (!tokens?.mcp || !tokens?.ca || tokens.mcp.length < 32 || tokens.ca.length < 32 || tokens.mcp === tokens.ca) {
    throw new Error('Two distinct admission credentials of at least 32 characters are required');
  }
  const hashes = { mcp: hash(tokens.mcp), ca: hash(tokens.ca) };
  let active = 0;
  return async function handler(req, res) {
    const respond = (status, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', ...(status === 503 ? { 'retry-after': '1' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/livez' && req.method === 'GET') return respond(200, { ok: true });
    if (req.url === '/readyz' && req.method === 'GET') return respond(ready() ? 200 : 503, { ok: ready() });
    if (req.url !== '/' || req.method !== 'POST') return respond(404, { error: 'not-found' });
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 1024 || !authorization.startsWith('Bearer ')) {
      req.resume(); return respond(401, { error: 'unauthorized' });
    }
    const supplied = hash(authorization.slice(7));
    // Evaluate both comparisons even when one matches; credentials are never logged.
    const mcp = timingSafeEqual(supplied, hashes.mcp), ca = timingSafeEqual(supplied, hashes.ca);
    if (!mcp && !ca) { req.resume(); return respond(401, { error: 'unauthorized' }); }
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      req.resume(); return respond(415, { error: 'json-required' });
    }
    if (!ready() || active >= maxActive) { req.resume(); return respond(503, { error: 'store-unavailable' }); }
    let size = 0, text = '';
    try {
      for await (const part of req) {
        size += part.length;
        if (size > 4096) { respond(413, { error: 'body-too-large' }); req.destroy(); return; }
        text += part.toString('utf8');
      }
      let command;
      try { command = parseCommand(JSON.parse(text), mcp ? 'mcp' : 'ca'); }
      catch { return respond(400, { error: 'unsupported-command' }); }
      if (!ready() || active >= maxActive) return respond(503, { error: 'store-unavailable' });
      active += 1;
      const execution = Promise.resolve().then(() => execute(command));
      // A timeout may follow a committed increment. Never retry it, and retain
      // its concurrency slot until Redis settles to bound unresolved commands.
      execution.finally(() => { active -= 1; }).catch(() => {});
      let timer;
      try {
        const result = await Promise.race([execution, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        })]);
        return respond(200, { result });
      } catch { return respond(503, { error: 'store-unavailable' }); }
      finally { clearTimeout(timer); }
    } catch { return respond(400, { error: 'invalid-body' }); }
  };
}
