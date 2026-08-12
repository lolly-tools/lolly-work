/**
 * Prometheus metrics (plan Track B): counter accumulation + text rendering + the
 * /metrics access gate (loopback default, bearer when a token is set).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createMetrics, statusClass, metricsGate } from '../server/src/observability/metrics.ts';

test('statusClass buckets by hundreds', () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(0), '0xx');
});

test('counters accumulate; renderText emits one HELP/TYPE per metric, escaped labels', () => {
  const m = createMetrics();
  m.httpRequest('/api/v1/users/:id', '2xx');
  m.httpRequest('/api/v1/users/:id', '2xx');
  m.httpRequest('/api/v1/users/:id', '4xx');
  m.orgConfigPoll();
  m.rateLimited('auth');
  const text = m.renderText([{ name: 'lw_up', help: 'Up.', type: 'gauge', value: 1 }]);
  assert.equal((text.match(/# HELP lw_http_requests_total/g) || []).length, 1);
  assert.equal((text.match(/# TYPE lw_http_requests_total counter/g) || []).length, 1);
  assert.ok(text.includes('lw_http_requests_total{route="/api/v1/users/:id",status="2xx"} 2'));
  assert.ok(text.includes('lw_http_requests_total{route="/api/v1/users/:id",status="4xx"} 1'));
  assert.ok(text.includes('lw_org_config_poll_total 1'));
  assert.ok(text.includes('lw_rate_limited_total{surface="auth"} 1'));
  assert.ok(text.includes('# TYPE lw_up gauge'));
  assert.ok(text.endsWith('\n'));
});

const reqWith = (opts: { ip?: string; auth?: string }): IncomingMessage => ({
  headers: opts.auth ? { authorization: opts.auth } : {},
  socket: { remoteAddress: opts.ip ?? '' },
} as unknown as IncomingMessage);

test('metricsGate: no token ⇒ loopback ok, public not-found; token ⇒ bearer required', () => {
  assert.equal(metricsGate(reqWith({ ip: '127.0.0.1' })), 'ok');
  assert.equal(metricsGate(reqWith({ ip: '::1' })), 'ok');
  assert.equal(metricsGate(reqWith({ ip: '203.0.113.9' })), 'not-found');
  assert.equal(metricsGate(reqWith({ ip: '203.0.113.9', auth: 'Bearer s3cret' }), 's3cret'), 'ok');
  assert.equal(metricsGate(reqWith({ ip: '203.0.113.9', auth: 'Bearer wrong' }), 's3cret'), 'unauthorized');
  assert.equal(metricsGate(reqWith({ ip: '203.0.113.9' }), 's3cret'), 'unauthorized'); // missing header
  // length-mismatch path must not throw
  assert.doesNotThrow(() => metricsGate(reqWith({ auth: 'Bearer x' }), 'much-longer-token'));
});
