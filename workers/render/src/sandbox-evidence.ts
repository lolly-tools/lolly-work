// SPDX-License-Identifier: MPL-2.0
import { readFile, readlink } from 'node:fs/promises';
import type { Browser } from 'playwright-core';

/** Qualify the running Linux renderer, including its additional seccomp filter. */
export async function linuxSandboxEvidence(browser: Browser): Promise<{ rendererNamespace: true; rendererSeccomp: true; noCapabilities: true }> {
  if (process.platform !== 'linux') throw new Error('Linux sandbox evidence requires Linux');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage(); await page.setContent('<p>Sandbox check</p>');
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const main = processInfo.find(p => p.type === 'browser');
      const renderers = processInfo.filter(p => p.type === 'renderer');
      if (!main || !renderers.length) throw new Error('Browser process evidence is unavailable');
      const read = async (id: number) => {
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid browser process identifier');
        const status = await readFile(`/proc/${id}/status`, 'utf8');
        if (status.length > 32768) throw new Error('Invalid browser process evidence');
        const field = (name: string) => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
        return { uid: field('Uid'), caps: field('CapEff'), nnp: field('NoNewPrivs'), mode: field('Seccomp'),
          filters: Number(field('Seccomp_filters')), pids: field('NSpid')?.split(/\s+/).length ?? 0,
          userNamespace: await readlink(`/proc/${id}/ns/user`) };
      };
      const baseline = await read(main.id);
      if (baseline.mode !== '2' || !Number.isInteger(baseline.filters) || baseline.filters < 1 ||
        baseline.caps !== '0000000000000000' || baseline.nnp !== '1') throw new Error('Container process evidence did not satisfy the required policy');
      for (const renderer of renderers) {
        const status = await read(renderer.id);
        if (status.mode !== '2' || !Number.isInteger(status.filters) || status.filters <= baseline.filters ||
          status.pids <= baseline.pids || status.userNamespace === baseline.userNamespace ||
          status.caps !== '0000000000000000' || status.nnp !== '1' ||
          !status.uid?.split(/\s+/).every(id => Number(id) > 0)) throw new Error('Renderer sandbox evidence did not satisfy the required policy');
      }
      return { rendererNamespace: true, rendererSeccomp: true, noCapabilities: true };
    } finally { await cdp.detach(); }
  } finally { await context.close(); }
}
