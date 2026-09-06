/** The server logger (server/src/observability/log.ts): text and JSON shapes, request ids. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, createLogger, requestId } from '../server/src/observability/log.ts';

test('text lines keep the operator prefix; json lines are one object with the fields verbatim', () => {
  const at = new Date('2026-09-06T10:00:00Z');
  assert.equal(formatLine('text', 'info', 'http', { reqId: 'r_1', route: 'GET /api', status: 200, ms: 3 }, at), '[lolly-work] http reqId=r_1 route="GET /api" status=200 ms=3');
  assert.equal(formatLine('text', 'warn', 'slow', {}, at), '[lolly-work] WARN slow');
  assert.deepEqual(JSON.parse(formatLine('json', 'error', 'boom', { reqId: 'r_2' }, at)), { t: '2026-09-06T10:00:00.000Z', level: 'error', msg: 'boom', reqId: 'r_2' });
});

test('the format and the access-log switch come from the environment', () => {
  const lines: string[] = [];
  const sink = { out: (l: string) => lines.push('out:' + l), err: (l: string) => lines.push('err:' + l) };
  const text = createLogger({}, sink);
  assert.equal(text.format, 'text');
  assert.equal(text.accessLog, false);
  const json = createLogger({ LW_LOG_FORMAT: 'json' }, sink);
  assert.equal(json.format, 'json');
  assert.equal(json.accessLog, true, 'a pipeline wants the access line');
  assert.equal(createLogger({ LW_LOG_HTTP: '1' }, sink).accessLog, true);
  json('warn', 'w', { a: 1 });
  json('info', 'i');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith('err:{'), 'warnings go to stderr');
  assert.ok(lines[1]!.startsWith('out:{'));
});

test('request ids: a sane caller id is kept, anything else is replaced', () => {
  assert.equal(requestId('trace-1.2:3'), 'trace-1.2:3');
  assert.match(requestId(undefined), /^r_[a-z0-9]+$/);
  assert.match(requestId('has space'), /^r_/);
  assert.match(requestId('x'), /^r_/, 'too short');
  assert.equal(requestId(['first-id', 'second']), 'first-id');
});
