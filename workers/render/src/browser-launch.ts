// SPDX-License-Identifier: MPL-2.0
/** Software WebGPU for the required shell startup check (Lolly plan 295).
 * Keep the existing worker's pod isolation and non-proxied WebRTC restriction.
 * The browser must include SwiftShader; flags cannot supply a missing adapter. */
export function workerBrowserOptions(env: NodeJS.ProcessEnv = process.env): {
  args: string[]; executablePath?: string; channel?: string;
} {
  return {
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
    ...(env.LOLLY_BROWSER_PATH ? { executablePath: env.LOLLY_BROWSER_PATH } : {}),
    ...(env.LOLLY_BROWSER_CHANNEL ? { channel: env.LOLLY_BROWSER_CHANNEL } : {}),
  };
}
