// SPDX-License-Identifier: MPL-2.0
/** Agents occupy ordinary room seats and commit through the room's durable queue. */
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import { Room, type RoomRegistry, type RoomMember, type ServerFrame, WRITER_CAP, WRITER_CAP_PER_USER } from '../collab/rooms.ts';
import type { DocumentAgentRecord, Store } from '../store/types.ts';
import { displayName } from '../iam/member.ts';
import { agentActor, agentAttribution } from './attribution.ts';
import { agentStanding } from './access.ts';
import type { AgentRoomBridge } from './types.ts';

interface Seat { record: DocumentAgentRecord; room: Room; member: RoomMember; usedAt: number; frames: ServerFrame[]; writes: Promise<unknown> }
interface Dependencies {
  store: Store;
  registry: RoomRegistry;
  parse(raw: unknown): CanvasOp | null;
  authorize(record: DocumentAgentRecord, ops: CanvasOp[], room: Room): Promise<ReadonlySet<CanvasOp>>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
  dispose(room: Room): Promise<void>;
}
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

export function createAgentRooms(d: Dependencies): AgentRoomBridge & { close(): Promise<void> } {
  const seats = new Map<string, Seat>(), opening = new Map<string, Promise<Seat>>();
  let closed = false, timer: ReturnType<typeof setInterval> | undefined;
  async function disconnect(id: string): Promise<void> {
    const seat = seats.get(id); if (!seat) return;
    seats.delete(id); seat.room.leave(seat.member.id);
    await d.audit(`user:${seat.record.userId}`, 'collab.leave', `session:${seat.record.sessionId}`, { agentId: id });
    if (!seats.size) { clearInterval(timer); timer = undefined; }
    if (!seat.room.size) await d.dispose(seat.room);
  }
  async function sweep(): Promise<void> {
    for (const [id, seat] of seats) {
      if (Date.now() - seat.usedAt > 120_000 || !await agentStanding(d.store, seat.record)) await disconnect(id);
    }
  }
  async function seatOf(record: DocumentAgentRecord): Promise<Seat> {
    if (closed) throw new Error('AGENT_UNAVAILABLE');
    const standing = await agentStanding(d.store, record);
    if (!standing) { await disconnect(record.id); throw new Error('AGENT_REVOKED'); }
    const previous = seats.get(record.id);
    if (previous?.room.available) {
      previous.usedAt = Date.now();
      if (!standing.mayEdit) previous.room.demote(previous.member);
      return previous;
    }
    if (previous) await disconnect(record.id);
    const pending = opening.get(record.id); if (pending) return pending;
    if (seats.size + opening.size >= 128) throw new Error('AGENT_CAPACITY');
    const create = (async () => {
      const room = await d.registry.acquire(standing.session);
      const frames: ServerFrame[] = [];
      const member: RoomMember = { id: `agent_${record.id}`, userId: standing.agent.id, name: `${record.label} · ${displayName(standing.creator)}’s agent`,
        role: standing.mayEdit && room.writerCount() < WRITER_CAP && room.writerCountFor(standing.creator.id) < WRITER_CAP_PER_USER ? 'writer' : 'observer',
        opVersion: CANVAS_OP_VERSION, presenceVersion: 1, interactionVersion: 1,
        send: frame => { if (frames.length >= 256) frames.shift(); frames.push(frame); },
        disconnect: () => { void disconnect(record.id).catch(() => {}); } };
      const seat: Seat = { record, room, member, usedAt: Date.now(), frames, writes: Promise.resolve() };
      room.join(member); seats.set(record.id, seat);
      if (!timer) { timer = setInterval(() => { void sweep().catch(() => {}); }, 30_000); timer.unref(); }
      await d.audit(agentActor(record), 'collab.join', `session:${record.sessionId}`, { ...agentAttribution(record), role: member.role });
      return seat;
    })();
    opening.set(record.id, create);
    try { return await create; } finally { opening.delete(record.id); }
  }
  return {
    connected: id => seats.has(id), disconnect,
    async read(record) {
      const seat = await seatOf(record);
      const current = await seat.room.readCurrent(seat.member);
      if (!await agentStanding(d.store, record)) { await disconnect(record.id); throw new Error('AGENT_REVOKED'); }
      return { sessionId: record.sessionId, projectId: record.projectId, agent: { id: record.id, label: record.label, role: seat.member.role, actingFor: record.createdBy }, ...current };
    },
    async apply(record, args) {
      const seat = await seatOf(record);
      if (!key(args.batchId) || args.batchId.length > 48 || !Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0
        || !Array.isArray(args.ops) || !args.ops.length || args.ops.length > 200) throw new Error('INVALID_OPS');
      const batchId = args.batchId;
      const ops = args.ops.map(raw => d.parse(raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...raw, origin: { client: seat.member.id, clock: 0 } } : null));
      if (ops.some(op => !op)) throw new Error('INVALID_OPS');
      const parsed = ops as CanvasOp[], ids = parsed.map((_, i) => `${record.id}_${batchId}_${i}`);
      if (ids.some(id => id.length > 80)) throw new Error('INVALID_OPS');
      const execute = async () => {
        seat.frames.length = 0;
        await seat.room.applyBatch(seat.member, batchId, ids, parsed, new Set(), undefined, {
          expectedRevision: Number(args.expectedRevision), serverOrigin: true,
          authorize: async () => {
            const standing = await agentStanding(d.store, record);
            if (!standing) throw new Error('AGENT_REVOKED');
            if (!standing.mayEdit || seat.member.role !== 'writer') throw new Error('READ_ONLY');
            return d.authorize(record, parsed, seat.room);
          },
        });
        const receipt = seat.frames.findLast(frame => frame.t === 'receipt');
        return { ...(receipt ?? {}), ...(await seat.room.readCurrent(seat.member)) };
      };
      const result = seat.writes.then(execute); seat.writes = result.catch(() => {}); return result;
    },
    async close() {
      closed = true; clearInterval(timer); timer = undefined;
      await Promise.allSettled(opening.values());
      await Promise.all([...seats.keys()].map(disconnect));
    },
  };
}
