/**
 * Narrow ambient types for the `ws` package.
 *
 * `ws` ships no `.d.ts` of its own (types live in the separate `@types/ws`).
 * This repo keeps its `@types/*` surface deliberately tiny and prefers a narrow
 * local shim over pulling a whole DefinitelyTyped package for four methods —
 * the same house rule `server/src/render/contract.ts` states for the engine, and
 * the same shape `console/table-sort.d.ts` already uses for a plain-JS sibling.
 *
 * Only the surface the gateway and its tests actually use is declared. Runtime
 * correctness is verified by tests/collab/gateway.test.ts, which drives a REAL
 * `ws` client against a REAL `ws` server — so a shim that drifts is a test
 * failure, not a silent type lie.
 *
 * If `@types/ws` is ever added, delete this file (an ambient module declaration
 * shadows node_modules types, so keeping both would hide the real ones).
 */
declare module 'ws' {
  import type { IncomingMessage, ClientRequest } from 'node:http';
  import type { Duplex } from 'node:stream';

  type RawData = Buffer | ArrayBuffer | Buffer[];

  class WebSocket {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: 0 | 1 | 2 | 3;
    /** Bytes queued for the peer but not yet written to the socket. The only way
     *  to notice a peer that stopped READING (which no event reports). */
    readonly bufferedAmount: number;
    constructor(address: string, options?: { headers?: Record<string, string> });
    on(event: 'open', cb: () => void): this;
    on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', cb: (code: number, reason: Buffer) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: 'ping', cb: (data: Buffer) => void): this;
    on(event: 'pong', cb: (data: Buffer) => void): this;
    on(event: 'unexpected-response', cb: (req: ClientRequest, res: IncomingMessage) => void): this;
    once(event: 'open', cb: () => void): this;
    once(event: 'close', cb: (code: number, reason: Buffer) => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    send(data: string | Buffer): void;
    /** Keepalive. `ws` performs none of its own, so the gateway drives it. */
    ping(data?: Buffer | string): void;
    pong(data?: Buffer | string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }

  class WebSocketServer {
    constructor(options: { noServer?: boolean; maxPayload?: number });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket, request: IncomingMessage) => void,
    ): void;
    close(cb?: (err?: Error) => void): void;
  }

  export { WebSocket, WebSocketServer };
  export type { RawData };
  export default WebSocket;
}
