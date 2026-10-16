// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocketTickets, SOCKET_TICKET_TTL_MS } from '../../server/src/collab/socket-tickets.ts';
const header = (ticket: string): string => `lolly-collab-v1, lolly-ticket.${ticket}`;

test('socket tickets expire, replace abandoned reconnects and never carry a reusable cookie', () => {
  let now = 1000;
  const registry = createSocketTickets(() => now);
  const old = registry.issue('lw_session=secret', 'room')!;
  const ticket = registry.issue('lw_session=secret', 'room')!;
  assert.equal(registry.consume(header(old), 'room'), null);
  assert.equal(registry.consume(header(ticket), 'room'), 'lw_session=secret');
  assert.equal(registry.consume(header(ticket), 'room'), null);
  const expiring = registry.issue('lw_session=secret', 'room')!;
  now += SOCKET_TICKET_TTL_MS;
  assert.equal(registry.consume(header(expiring), 'room'), null);
  const wrongRoom = registry.issue('lw_session=secret', 'room')!;
  assert.equal(registry.consume(header(wrongRoom), 'other'), null);
  assert.equal(registry.consume(header(wrongRoom), 'room'), null);
  assert.equal(registry.consume('lolly-collab-v1, lolly-ticket.unknown', 'room'), null);
});
