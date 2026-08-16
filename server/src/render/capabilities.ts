/**
 * What THIS deployment can render server-side - the single source of truth
 * consumed by BOTH the render request gate (pipeline.ts) and the org_config
 * advertisement (policy/org-config.ts), so what shells are offered and what
 * the render route accepts can never drift apart (plans/23 §3.A).
 *
 * Zero imports on purpose: pipeline already imports org-config (for
 * policyVersionOf), so the shared constant lives here rather than in either.
 */

/** Formats the render plane produces without a worker (jsdom SVG + resvg PNG). */
export const RENDER_TIER = ['svg', 'png'] as const;
export type RenderFormat = (typeof RENDER_TIER)[number];

/** What a Chromium worker adds (plans/22 §6.3): its /rasterise already produces
 *  jpeg + pdf, and the engine's C2PA writer embeds in both containers. 'jpeg' is
 *  normalised to 'jpg' at the gate. webp/tiff/cmyk-pdf stay deferred until the
 *  shell-export path proves them. */
export const WORKER_RASTER_FORMATS = ['jpg', 'pdf'] as const;

export interface RenderCapabilities {
  /** Server-renderable formats. Deployment-scoped - the same for every caller. */
  formats: string[];
  /** A Chromium worker is attached ⇒ hooked/HTML tools render server-side
   *  (absent ⇒ they 501, and shells should not offer them for server export). */
  hookedTools: boolean;
}

/** `workerConfigured` means url AND secret present - the same condition app.ts
 *  uses to activate the worker. A worker widens the format set (plans/22 §6.3)
 *  as well as unlocking hooked tools; because the render gate and the org_config
 *  advertisement both call this, the widening reaches shells (and moves the
 *  policyVersion ETag) with no further wiring. */
export function renderCapabilities(workerConfigured: boolean): RenderCapabilities {
  return {
    formats: workerConfigured ? [...RENDER_TIER, ...WORKER_RASTER_FORMATS] : [...RENDER_TIER],
    hookedTools: workerConfigured,
  };
}
