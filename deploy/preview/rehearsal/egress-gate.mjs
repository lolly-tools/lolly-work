// SPDX-License-Identifier: MPL-2.0
// Restore rehearsal, egress gate. The migrate and previous steps run the new and
// the previous image's code, so neither may start while the Pod can still reach
// the network. The driver removes the label `lolly.tools/rehearsal-egress` from
// the Pod when the fetch step ends; that label is what the one egress
// NetworkPolicy selects. This gate waits for the label to disappear from the
// Pod's downward API copy, then proves the backup store's address no longer
// accepts a connection. It returns 'CLOSED' or calls fail().
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const PROGRAMS = process.env.REHEARSAL_PROGRAMS ?? '/programs';
const PODINFO = process.env.REHEARSAL_PODINFO ?? '/podinfo';
const LABEL = 'lolly.tools/rehearsal-egress';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const reaches = (host, port) => new Promise(resolve => {
  const socket = connect({ host, port, timeout: 3000 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
});

export async function requireClosedEgress(fail) {
  const address = readFileSync(join(PROGRAMS, 'storage-address'), 'utf8').trim();
  const labelDeadline = Date.now() + 600_000;
  for (;;) {
    let labels = '';
    try { labels = readFileSync(join(PODINFO, 'labels'), 'utf8'); } catch { /* not projected yet */ }
    if (labels && !labels.split('\n').some(line => line.startsWith(`${LABEL}=`))) break;
    if (Date.now() > labelDeadline) fail('EGRESS_NOT_CLOSED: the Pod still carries the egress label');
    await sleep(2000);
  }
  // The policy takes a moment to apply after the label changes. Wait until the store stops answering.
  const probeDeadline = Date.now() + 180_000;
  while (await reaches(address, 443)) {
    if (Date.now() > probeDeadline) fail('EGRESS_NOT_CLOSED: the backup store still accepts connections');
    await sleep(2000);
  }
  return 'CLOSED';
}
