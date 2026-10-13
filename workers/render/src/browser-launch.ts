// SPDX-License-Identifier: MPL-2.0
/** Software WebGPU for the shell startup check.
 * Keep Chromium's sandbox and the non-proxied WebRTC restriction.
 * The browser must include SwiftShader; flags cannot supply a missing adapter. */
export function workerBrowserOptions(env: NodeJS.ProcessEnv = process.env): {
  chromiumSandbox: true; timeout: number; args: string[]; executablePath?: string; channel?: string;
} {
  const timeout = Number(env.LW_RENDER_BROWSER_STARTUP_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000) {
    throw new Error('LW_RENDER_BROWSER_STARTUP_TIMEOUT_MS must be an integer from 1000 to 120000');
  }
  return {
    chromiumSandbox: true,
    timeout,
    args: ['--disable-dev-shm-usage',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
    ...(env.LOLLY_BROWSER_PATH ? { executablePath: env.LOLLY_BROWSER_PATH } : {}),
    ...(env.LOLLY_BROWSER_CHANNEL ? { channel: env.LOLLY_BROWSER_CHANNEL } : {}),
  };
}
