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

/** Host APIs the in-process render host builds (render/host.ts buildHost). A
 *  manifest `requires` entry outside this list, or `tokens` on a pack without
 *  tokens, stops the tool rendering in process. */
export const IN_PROCESS_HOST_APIS = ['color', 'profile', 'assets', 'state', 'clipboard', 'export'] as const;

/** One format, or a whole tool, this deployment cannot render on the server,
 *  with a stable code and a sentence a person or an agent can act on. */
export interface UnavailableFormat { format: string; code: string; reason: string }

/** What a loaded tool declares that decides where, and whether, it renders. */
export interface ToolRenderFacts {
  formats: string[];
  /** The tool ships hooks (a hooks.js the engine loaded). */
  hooks: boolean;
  /** The template is SVG, which is what the in-process path rasterises. */
  svgTemplate: boolean;
  requires?: string[];
}

export interface ToolServerFormats {
  /** Where a render of this tool runs, or null when it cannot run here. */
  renderer: 'work-jsdom' | 'chromium-worker' | null;
  formats: string[];
  unavailable: UnavailableFormat[];
}

/**
 * The server formats one tool can produce on this deployment, and the reason
 * for each one it cannot. The setup pack check and the discovery and schema
 * routes all call this, and its rules follow the render pipeline's gates, so
 * what is described before a render is what the render route accepts. Format
 * policy (overlay enforce.formats) is a separate, per-caller layer on top.
 */
export function toolServerFormats(
  tool: ToolRenderFacts,
  deployment: { caps: RenderCapabilities; allowHooksInFastPath: boolean; tokens: boolean },
): ToolServerFormats {
  const formats = [...new Set(tool.formats.map(format => format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase()))];
  const all = (code: string, reason: string): ToolServerFormats => ({ renderer: null, formats: [], unavailable: formats.map(format => ({ format, code, reason })) });
  const browserNeeded = tool.hooks && !deployment.allowHooksInFastPath;
  if (browserNeeded && !deployment.caps.hookedTools) {
    return all('HOOKED_TOOL_NEEDS_CHROMIUM', 'This tool runs scripts that need the Chromium render worker, and this deployment does not run one.');
  }
  if (!browserNeeded) {
    const host = new Set<string>([...IN_PROCESS_HOST_APIS, ...(deployment.tokens ? ['tokens'] : [])]);
    const unmet = (tool.requires ?? []).filter(api => !host.has(api));
    if (unmet.length) return all('TOOL_REQUIRES_UNMET', `Server rendering needs host APIs this deployment does not provide: ${unmet.join(', ')}.`);
    if (!tool.svgTemplate) return all('SVG_TEMPLATE_REQUIRED', 'Server rendering needs an SVG template. The web app can still export this tool.');
  }
  const available: string[] = [];
  const unavailable: UnavailableFormat[] = [];
  for (const format of formats) {
    if (deployment.caps.formats.includes(format)) available.push(format);
    else if ((WORKER_RASTER_FORMATS as readonly string[]).includes(format)) unavailable.push({ format, code: 'WORKER_NOT_CONFIGURED', reason: 'This format needs the Chromium render worker, and this deployment does not run one.' });
    else unavailable.push({ format, code: 'UNSUPPORTED_FORMAT', reason: 'This deployment does not produce this format on the server. The web app can still export it.' });
  }
  return { renderer: browserNeeded ? 'chromium-worker' : 'work-jsdom', formats: available, unavailable };
}
