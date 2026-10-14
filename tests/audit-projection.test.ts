// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAuditMacKey, GENESIS_HASH, hashEvent, nextEvent, verifyChain, type AuditEvent } from '../server/src/audit/chain.ts';
import { AUDIT_PROJECTION_FORMAT, projectAuditEvent, verifyAuditProjection, type AuditProjection } from '../server/src/audit/projection.ts';
import { AUDIT_EMAIL_OMITTED } from '../server/src/audit/privacy.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createSiemForwarder } from '../server/src/observability/siem.ts';

const session = 'projection-audit-key', secret = 'projection-delivery-key', auditKey = deriveAuditMacKey(session);
const raw = { at: '2026-10-01T00:00:00.000Z', actor: 'contact:person@fixture.test', action: 'auth.login', subject: 'person%40fixture.test',
  payload: { email: 'PERSON@fixture.test', nested: { message: 'Contact person@fixture.test', 'person@fixture.test': 'key' } } };
const legacy: AuditEvent = { ...raw, seq: 1, prevHash: GENESIS_HASH, hash: hashEvent(GENESIS_HASH, 1, raw) };

test('historical projections omit plaintext without changing the immutable source or asserting its body proof', () => {
  const original = structuredClone(legacy);
  const projection = projectAuditEvent(legacy, secret, auditKey);
  assert.deepEqual(legacy, original);
  assert.deepEqual(projection.source, { seq: legacy.seq, hash: legacy.hash, prevHash: legacy.prevHash });
  assert.doesNotMatch(JSON.stringify(projection), /person(?:@|%40)fixture\.test/i);
  assert.notEqual(hashEvent(projection.source.prevHash, projection.source.seq, projection.body), projection.source.hash);
  assert.equal(verifyChain([legacy]).ok, true);
  assert.equal(verifyAuditProjection(projection, secret), true);
  assert.equal(verifyAuditProjection(projection, 'wrong-key'), false);
  assert.deepEqual(projectAuditEvent(legacy, secret, auditKey), projection);
  assert.equal(verifyAuditProjection({ ...projection, body: { ...projection.body, action: 'changed' } }, secret), false);
  assert.equal(verifyAuditProjection({ ...projection, source: { ...projection.source, seq: 2 } }, secret), false);
});

test('new keyed digests remain stable in projections and an unkeyed projection omits identifying values', () => {
  const current = nextEvent(legacy, raw, auditKey);
  const projected = projectAuditEvent(current, secret, auditKey);
  assert.equal(projected.body.payload!.email, current.payload!.email);
  assert.equal(verifyAuditProjection(projected, secret), true);
  assert.equal(verifyChain([legacy, current], null, auditKey).ok, true);
  const unkeyed = projectAuditEvent(legacy, secret);
  assert.equal(unkeyed.body.payload!.email, AUDIT_EMAIL_OMITTED);
  assert.doesNotMatch(JSON.stringify(unkeyed), /person(?:@|%40)fixture\.test/i);
});

test('pending historical rows use the signed projection format and replay stable bodies after refusal', async () => {
  const store = createMemoryStore();
  const rows = [legacy, nextEvent(legacy, raw, auditKey)];
  store.listAuditAfter = async (after, limit) => rows.filter(r => r.seq > after).slice(0, limit);
  const bodies: string[] = [];
  const forwarder = createSiemForwarder({ store, config: parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, dev: { enabled: true }, siem: { url: 'http://127.0.0.1/receiver' } })),
    secrets: { session, link: 'projection-link', siem: secret }, fetchImpl: async (_url, options) => {
      bodies.push(String(options!.body)); return new Response(null, { status: bodies.length === 1 ? 503 : 200 });
    } });
  assert.equal(await forwarder.tick(), 0); assert.equal(await store.getSiemCursor(), 0);
  assert.equal(await forwarder.tick(), 2); assert.equal(await store.getSiemCursor(), 2);
  assert.equal(bodies[0], bodies[1]);
  const received = JSON.parse(bodies[0]!) as { format: string; events: AuditProjection[] };
  assert.equal(received.format, AUDIT_PROJECTION_FORMAT);
  assert.ok(received.events.every(event => verifyAuditProjection(event, secret)));
  assert.doesNotMatch(bodies[0]!, /person(?:@|%40)fixture\.test/i);
  assert.deepEqual(rows, [legacy, nextEvent(legacy, raw, auditKey)]);
});
