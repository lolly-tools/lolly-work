// SPDX-License-Identifier: MPL-2.0
interface ManagedBrowser {
  isConnected(): boolean;
  on(event: 'disconnected', listener: () => void): unknown;
  close(): Promise<void>;
}

/** A single bounded launch shared by startup, recovery and render requests. */
export function createBrowserLifecycle<T extends ManagedBrowser>(options: {
  launch: () => Promise<T>;
  timeoutMs: number;
  onRecoveryFailure?: () => void;
}) {
  let current: T | undefined, pending: Promise<T> | undefined;
  let closing: Promise<void> | undefined;
  let generation = 0, stopped = false;

  function get(): Promise<T> {
    if (stopped) return Promise.reject(new Error('Browser is stopped'));
    if (current?.isConnected()) return Promise.resolve(current);
    if (current) { current = undefined; pending = undefined; }
    if (pending) return pending;
    const attempt = ++generation;
    let expired = false, timer: ReturnType<typeof setTimeout>;
    const launched = Promise.resolve().then(options.launch);
    void launched.then(browser => {
      if (expired) void browser.close().catch(() => {});
    }, () => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Browser startup did not complete')); }, options.timeoutMs);
    });
    pending = Promise.race([launched, deadline]).then(async browser => {
      if (stopped || attempt !== generation || !browser.isConnected()) {
        await browser.close().catch(() => {});
        throw new Error('Browser startup did not complete');
      }
      current = browser;
      browser.on('disconnected', () => {
        if (stopped || current !== browser) return;
        current = undefined; pending = undefined;
        if (options.onRecoveryFailure) void get().catch(options.onRecoveryFailure);
      });
      return browser;
    }).catch(() => {
      if (attempt === generation) { current = undefined; pending = undefined; }
      throw new Error('Browser startup did not complete');
    }).finally(() => clearTimeout(timer));
    return pending;
  }

  return {
    get,
    get ready(): boolean { return !stopped && !!current?.isConnected(); },
    close(): Promise<void> {
      if (closing) return closing;
      stopped = true; generation++;
      const browser = current, inFlight = pending;
      current = undefined; pending = undefined;
      return closing = Promise.allSettled([browser?.close(), inFlight]).then(() => {});
    },
  };
}
