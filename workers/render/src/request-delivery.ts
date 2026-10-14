// SPDX-License-Identifier: MPL-2.0
import type { APIResponse, Route } from 'playwright-core';

export class ResponseBudget {
  private requests = 0;
  private bytes = 0;
  readonly responseBytes: number;
  readonly totalBytes: number;
  readonly requestCount: number;
  constructor(responseBytes = 32 * 1024 * 1024, totalBytes = 128 * 1024 * 1024, requestCount = 512) {
    this.responseBytes = responseBytes; this.totalBytes = totalBytes; this.requestCount = requestCount;
  }
  begin(): void {
    if (++this.requests > this.requestCount) throw new Error('Render request count exceeds the response budget.');
  }
  check(bytes: number): void {
    if (bytes > this.responseBytes || this.bytes + bytes > this.totalBytes) throw new Error('Render resources exceed the response budget.');
  }
  add(bytes: number): void { this.check(bytes); this.bytes += bytes; }
}

/** Deliver one response while keeping its status and bytes inside the render budget. */
export async function deliverResponse(route: Route, budget: ResponseBudget, signal: AbortSignal, options: {
  timeout: number;
  headers?: Record<string, string>;
  verify?: (response: APIResponse) => void;
}): Promise<void> {
  signal.throwIfAborted();
  budget.begin();
  const response = await route.fetch({ maxRedirects: 0, timeout: options.timeout, ...(options.headers ? { headers: options.headers } : {}) });
  try {
    signal.throwIfAborted();
    const status = response.status();
    if (status >= 300 && status < 400 && status !== 304) {
      await route.abort('blockedbyclient');
      return;
    }
    options.verify?.(response);
    const declared = Number(response.headers()['content-length']);
    if (Number.isFinite(declared)) budget.check(declared);
    const body = await response.body();
    signal.throwIfAborted();
    budget.add(body.byteLength);
    await route.fulfill({ response, body });
  } finally {
    await response.dispose();
  }
}
