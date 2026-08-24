/**
 * SIEM forwarding (plans/35 wave 2). The claim under test: forwarding is
 * loss-free by construction, because the audit table is the outbox and the
 * cursor only advances on a confirmed 2xx. A refused batch replays whole on
 * the next tick; signatures make forgery and replay refusable receiver-side.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createSiemForwarder } from '../server/src/observability/siem.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Received { body: string; signature: string; timestamp: string }

function receiver(): Promise<{ url: string; got: Received[]; refuse: (n: number) => void }> {
  const got: Received[] = [];
  let refusals = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      if (refusals > 0) { refusals--; res.writeHead(503); res.end(); return; }
      got.push({
        body,
        signature: String(req.headers['x-lolly-signature'] ?? ''),
        timestamp: String(req.headers['x-lolly-timestamp'] ?? ''),
      });
      res.writeHead(200);
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, () => {
    const addr = server.address();
    resolve({
      url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/siem`,
      got,
      refuse: (n) => { refusals = n; },
    });
  }));
}

async function harness(url: string, batchSize = 2) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-siem-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Siem Hub', baseUrl: 'http://localhost', pack },
    siem: { url, batchSize },
    dev: { enabled: true },
  }));
  const store = createMemoryStore();
  const outcomes: Array<{ ok: boolean; count: number }> = [];
  const fwd = createSiemForwarder({
    config, store,
    secrets: { session: 's', link: 'l', siem: 'siem-secret' },
    onResult: (ok, count) => outcomes.push({ ok, count }),
  });
  return { store, fwd, outcomes };
}

const appendN = async (store: ReturnType<typeof createMemoryStore>, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await store.appendAudit({ at: new Date().toISOString(), actor: 'user:u1', action: `a.${i}`, subject: 's' });
  }
};

test('batches deliver in order, signed, and the cursor is the confirmed high-water mark', async () => {
  const rx = await receiver();
  const { store, fwd } = await harness(rx.url, 2);
  await appendN(store, 5);

  assert.equal(await fwd.tick(), 2, 'one batch of batchSize');
  assert.equal(await store.getSiemCursor(), 2);
  assert.equal(await fwd.tick(), 2);
  assert.equal(await fwd.tick(), 1, 'the remainder');
  assert.equal(await fwd.tick(), 0, 'drained');
  assert.equal(await store.getSiemCursor(), 5);

  const seqs = rx.got.flatMap((r) => (JSON.parse(r.body) as { events: Array<{ seq: number }> }).events.map((e) => e.seq));
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'every event exactly once, in order');
  for (const r of rx.got) {
    const expected = `sha256=${createHmac('sha256', 'siem-secret').update(`${r.timestamp}.${r.body}`).digest('hex')}`;
    assert.equal(r.signature, expected, 'the receiver can verify each batch');
  }
});

test('a refused batch keeps the cursor and replays whole - loss-free by construction', async () => {
  const rx = await receiver();
  const { store, fwd, outcomes } = await harness(rx.url, 10);
  await appendN(store, 3);

  rx.refuse(1);
  assert.equal(await fwd.tick(), 0, 'the refusal delivers nothing');
  assert.equal(await store.getSiemCursor(), 0, 'and the cursor does not move');
  assert.deepEqual(outcomes.at(-1), { ok: false, count: 0 });

  assert.equal(await fwd.tick(), 3, 'the same events replay whole');
  assert.equal(await store.getSiemCursor(), 3);
  const seqs = (JSON.parse((rx.got[0] as Received).body) as { events: Array<{ seq: number }> }).events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3], 'nothing was dropped by the failed attempt');
});

test('the forwarder refuses to exist unsigned', async () => {
  const rx = await receiver();
  const { store } = await harness(rx.url);
  const config = parseConfig(JSON.stringify({
    instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' },
    siem: { url: rx.url }, dev: { enabled: true },
  }));
  assert.throws(
    () => createSiemForwarder({ config, store, secrets: { session: 's', link: 'l' } }),
    /LW_SIEM_SECRET/,
  );
  assert.throws(() => parseConfig(JSON.stringify({
    instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' },
    siem: { url: 'not a url' }, dev: { enabled: true },
  })), /siem\.url/);
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0024 follows 0023, is the ceiling, and is one row by construction', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0024_siem_cursor.sql');
  assert.ok(at > 0, '0024 is on disk');
  assert.equal(files[at - 1], '0023_api_tokens.sql', '0024 follows 0023 with nothing between');
  assert.equal(files.at(-1), '0024_siem_cursor.sql', 'the SIEM cursor holds the migration ceiling');
  const sql = await readFile(join(dir, '0024_siem_cursor.sql'), 'utf8');
  assert.match(sql, /create table siem_cursor/);
  assert.match(sql, /check \(id = 1\)/);
});
