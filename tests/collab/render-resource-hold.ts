// SPDX-License-Identifier: MPL-2.0
/** Hold the signed dependency of one render, with observable socket cleanup. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createRenderResourceHold() {
  let target: { path: string; readToken: string; revision: string } | undefined;
  let reads = 0, closed = 0;
  const releases = new Set<() => void>();
  return {
    arm(value: { path: string; readToken: string; revision: string }) {
      if (target || releases.size || !/^\/tools\/[a-z0-9-]+@[a-f0-9]{16}\/hooks\.js$/.test(value.path)
        || !value.readToken || !value.revision) throw new Error('A fresh signed hook dependency is required');
      target = value; reads = 0; closed = 0;
    },
    intercept(req: IncomingMessage, res: ServerResponse, resume: () => void): boolean {
      if (!target || req.method !== 'GET' || new URL(req.url ?? '/', 'http://fixture.invalid').pathname !== target.path
        || req.headers['x-lw-render-read'] !== target.readToken || req.headers['x-lolly-brand-revision'] !== target.revision) return false;
      reads++;
      let done = false;
      const release = () => {
        if (done) return;
        done = true; releases.delete(release);
        res.removeListener('close', disconnected);
        if (!res.destroyed) resume();
      };
      const disconnected = () => {
        if (done) return;
        done = true; releases.delete(release); closed++;
      };
      releases.add(release); res.once('close', disconnected);
      return true;
    },
    release() { target = undefined; for (const resume of [...releases]) resume(); },
    get reads() { return reads; },
    get closed() { return closed; },
  };
}
