// SPDX-License-Identifier: MPL-2.0
/** Playwright dispatches routes independently of navigation/download promises.
 * Keep their fetch responses alive until fulfillment completes, and report
 * callback failures through the render rather than an unhandled rejection. */
export class RequestLifecycle {
  private state: 'active' | 'draining' | 'closing' = 'active';
  private pending = new Set<Promise<void>>();
  private deadline = 0;
  private error: Error | undefined;
  private rejectFailure!: (error: Error) => void;
  private resolveClosing!: () => void;
  private closing = new Promise<void>(resolve => { this.resolveClosing = resolve; });
  readonly failure = new Promise<never>((_, reject) => { this.rejectFailure = reject; });

  constructor() { void this.failure.catch(() => {}); }

  /** Set at the start of the existing download/setContent timeout. Cleanup gets
   * only its remaining time, never a second full export timeout. */
  setDeadline(deadline: number): void { this.deadline = deadline; }

  /** Only fixed, caller-authored messages belong here; never a caught URL-bearing
   * browser error. Catalogue mismatch must remain fatal after a download wins. */
  fail(message = 'A render request could not be completed.'): Error {
    const error = this.error ?? new Error(message);
    if (!this.isClosing()) { this.error = error; this.rejectFailure(error); }
    return error;
  }

  track(work: () => Promise<void>, refuse: () => Promise<void>): Promise<void> {
    const operation = (async () => {
      try { await (this.state === 'active' ? work() : refuse()); }
      catch {
        if (this.state === 'closing') return; // explicit cancellation/teardown
        // Raw Playwright errors can include URLs and injected read credentials.
        this.fail();
        try { await refuse(); } catch { /* first failure already rejects render */ }
      }
    })();
    this.pending.add(operation);
    void operation.then(() => { this.pending.delete(operation); });
    return operation;
  }

  async drain(): Promise<void> {
    if (this.isClosing()) return;
    this.state = 'draining';
    if (this.error) throw this.error;
    if (!this.pending.size) return;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error('Render requests did not finish within the export deadline.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Render requests did not finish within the export deadline.')), remaining);
    });
    try {
      // Keep the router installed while draining: new requests are refused.
      // Explicit close wakes this wait even if a browser callback stays pending.
      while (this.pending.size && !this.isClosing()) {
        await Promise.race([Promise.all([...this.pending]), this.failure, expired, this.closing]);
      }
      if (this.error) throw this.error;
    } finally { clearTimeout(timer); }
  }

  close(): void { this.state = 'closing'; this.resolveClosing(); }
  private isClosing(): boolean { return this.state === 'closing'; }
}
