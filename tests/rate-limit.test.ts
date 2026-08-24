/**
 * Per-IP token-bucket limiter (plan Track B): capacity/refill, per-(surface,ip)
 * isolation, disabled passthrough, LRU prune, and conservative IP derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createRateLimiter, rateLimitSurface, clientIp } from '../server/src/observability/rate-limit.ts';
import type { RateLimitConfig } from '../server/src/config/instance.ts';

const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  enabled: true, trustedProxyHops: 0, maxBuckets: 1000,
  auth: { capacity: 3, refillPerSec: 1 },
  telemetry: { capacity: 5, refillPerSec: 5 },
  link: { capacity: 3, refillPerSec: 1 },
  ...over,
});

test('capacity N allows N then denies with Retry-After; refill restores a token', () => {
  let t = 1_000_000;
  const rl = createRateLimiter(cfg(), () => t);
  for (let i = 0; i < 3; i++) assert.equal(rl.take('auth', 'ip1').ok, true, `take ${i}`);
  const denied = rl.take('auth', 'ip1');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
  t += 1000; // 1s → +1 token at refillPerSec=1
  assert.equal(rl.take('auth', 'ip1').ok, true);
});

test('per-(surface,ip) isolation', () => {
  const rl = createRateLimiter(cfg(), () => 0);
  for (let i = 0; i < 3; i++) rl.take('auth', 'ip1');
  assert.equal(rl.take('auth', 'ip1').ok, false); // ip1/auth exhausted
  assert.equal(rl.take('auth', 'ip2').ok, true);  // different ip
  assert.equal(rl.take('link', 'ip1').ok, true);  // different surface
});

test('disabled ⇒ always allow; size tracks live buckets', () => {
  const rl = createRateLimiter(cfg({ enabled: false }), () => 0);
  for (let i = 0; i < 100; i++) assert.equal(rl.take('auth', `ip${i}`).ok, true);
  assert.equal(rl.size(), 0); // disabled path creates no buckets

  const on = createRateLimiter(cfg(), () => 0);
  on.take('auth', 'a');
  on.take('link', 'b');
  assert.equal(on.size(), 2);
});

test('prune keeps size <= maxBuckets', () => {
  const rl = createRateLimiter(cfg({ maxBuckets: 10 }), () => 0);
  for (let i = 0; i < 25; i++) rl.take('auth', `ip${i}`);
  assert.ok(rl.size() <= 10, `size ${rl.size()} <= 10`);
});

test('surface classifier: dev provider is NOT throttled; real auth + telemetry + links are', () => {
  assert.equal(rateLimitSurface('GET', '/api/auth/login'), 'auth');
  assert.equal(rateLimitSurface('GET', '/api/auth/callback'), 'auth');
  assert.equal(rateLimitSurface('GET', '/api/auth/dev'), null); // local-only convenience
  assert.equal(rateLimitSurface('GET', '/api/v1/instance'), 'auth'); // unauthenticated manifest shares the auth bucket
  assert.equal(rateLimitSurface('POST', '/api/v1/telemetry'), 'telemetry');
  assert.equal(rateLimitSurface('GET', '/api/v1/telemetry'), null); // only POST ingest
  assert.equal(rateLimitSurface('GET', '/l/abc'), 'link');
  assert.equal(rateLimitSurface('GET', '/connect/pack.lolly'), 'link'); // public pack download rides the link bucket
  assert.equal(rateLimitSurface('GET', '/api/v1/users'), null); // authed API never throttled
});

const req = (remote: string, xff?: string): IncomingMessage => ({
  headers: xff ? { 'x-forwarded-for': xff } : {},
  socket: { remoteAddress: remote },
} as unknown as IncomingMessage);

test('clientIp: default trusts socket only; XFF honored per declared hops', () => {
  assert.equal(clientIp(req('::ffff:10.0.0.5', '1.1.1.1'), 0), '10.0.0.5'); // XFF ignored at hops=0
  assert.equal(clientIp(req('10.0.0.1', '1.1.1.1, 2.2.2.2'), 1), '2.2.2.2'); // 1 hop → rightmost XFF
  assert.equal(clientIp(req('10.0.0.1', '1.1.1.1, 2.2.2.2'), 2), '1.1.1.1'); // 2 hops
});
