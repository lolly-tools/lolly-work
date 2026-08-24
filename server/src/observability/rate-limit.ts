/**
 * In-memory per-IP token-bucket limiter for the UNAUTHENTICATED surface only
 * (plan Track B hardening): auth endpoints, telemetry ingest, and the public link
 * resolver. Authenticated console/API paths are never classified into a surface,
 * so they are never throttled. No timers (lazy refill + LRU prune) so it's
 * test-friendly and leaks nothing across the many servers the suite spins up.
 */
import type { IncomingMessage } from 'node:http';
import type { RateLimitConfig } from '../config/instance.ts';

export type Surface = 'auth' | 'telemetry' | 'link';
export interface RateLimiter {
  take(surface: Surface, ip: string): { ok: boolean; retryAfterSec: number };
  size(): number;
}

interface Bucket { tokens: number; last: number }

export function createRateLimiter(cfg: RateLimitConfig, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>(); // insertion-ordered ⇒ oldest-first == LRU (take re-inserts)
  const prune = (): void => {
    const drop = Math.max(1, Math.ceil(cfg.maxBuckets * 0.1));
    let i = 0;
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (++i >= drop) break;
    }
  };
  return {
    take(surface, ip) {
      if (!cfg.enabled) return { ok: true, retryAfterSec: 0 };
      const lim = cfg[surface];
      const key = `${surface} ${ip}`;
      const t = now();
      let b = buckets.get(key);
      if (b) buckets.delete(key); // move-to-end for LRU
      else {
        if (buckets.size >= cfg.maxBuckets) prune();
        b = { tokens: lim.capacity, last: t };
      }
      const elapsed = Math.max(0, t - b.last) / 1000;
      b.tokens = Math.min(lim.capacity, b.tokens + elapsed * lim.refillPerSec);
      b.last = t;
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true, retryAfterSec: 0 };
      }
      const retry = lim.refillPerSec > 0 ? Math.ceil((1 - b.tokens) / lim.refillPerSec) : 3600;
      return { ok: false, retryAfterSec: Math.max(1, retry) };
    },
    size: () => buckets.size,
  };
}

/** Which unauthenticated surface (if any) a request belongs to. Everything else
 *  returns null and is never throttled. The dev provider (/api/auth/dev) is a
 *  local-only convenience gated behind dev.enabled - deliberately NOT throttled;
 *  only the real OIDC login/callback are. */
export function rateLimitSurface(method: string, pathname: string): Surface | null {
  if (pathname === '/api/auth/login' || pathname === '/api/auth/callback') return 'auth';
  // The instance manifest is unauthenticated by design (plans/34 wave 1a) - a
  // first-run shell probes it before anyone signs in - so it shares the auth
  // bucket rather than being free to hammer.
  if (pathname === '/api/v1/instance') return 'auth';
  // Device sign-in (plans/34 wave 4): request + poll are unauthenticated, so
  // they ride the auth bucket. Its refill (0.2/s by default) is exactly the
  // advertised 5s poll interval - a polite client never sees 429.
  if (pathname === '/api/v1/auth/device' || pathname === '/api/v1/auth/device/token') return 'auth';
  if (method === 'POST' && pathname === '/api/v1/telemetry') return 'telemetry';
  if (pathname === '/l' || pathname.startsWith('/l/')) return 'link';
  // The instance-pack download (plans/34 wave 2) is public on an open instance,
  // so it rides the link bucket like the other bearer-ish byte surface.
  if (pathname === '/connect/pack.lolly') return 'link';
  return null;
}

const norm = (ip: string): string => ip.replace(/^::ffff:/, '');

/** Conservative client IP. Default (hops=0) trusts only the socket peer. Only when
 *  the operator declares N trusted proxy hops do we read X-Forwarded-For, taking
 *  the entry N places from the right - so a spoofed XFF can't evade the limiter. */
export function clientIp(req: IncomingMessage, trustedProxyHops: number): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (!trustedProxyHops || trustedProxyHops < 1) return norm(socket);
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!xff.length) return norm(socket);
  const idx = xff.length - trustedProxyHops;
  return norm(idx >= 0 ? xff[idx]! : xff[0]!);
}
