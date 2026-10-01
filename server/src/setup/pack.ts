// SPDX-License-Identifier: MPL-2.0
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createBrandSources } from '../brand/sources.ts';
import { loadEngine } from '../render/contract.ts';
import { renderCapabilities } from '../render/capabilities.ts';

export interface PackToolCheck {
  source: string; id: string; valid: boolean; requiredEngine?: string;
  serverFormats: string[]; unavailableFormats: string[]; diagnostics: string[]; sourceHash?: string;
}
export interface PackCheck {
  version: 1; engine: string; compatible: boolean; source: string | null;
  revision: string | null; tools: PackToolCheck[]; diagnostics: string[];
}

/** Load manifests through the installed engine without running tool hooks. */
export async function inspectPack(pack: string, options: {
  source?: string; workerConfigured?: boolean; requireServerRendering?: boolean; allowHooksInFastPath?: boolean;
} = {}): Promise<PackCheck> {
  const engine = await loadEngine();
  const report: PackCheck = { version: 1, engine: engine.ENGINE_VERSION, compatible: false,
    source: null, revision: null, tools: [], diagnostics: [] };
  try {
    const inventory = await createBrandSources(pack).inventory();
    const source = inventory.sources.find(entry => entry.id === (options.source ?? inventory.defaultId));
    if (!source) { report.diagnostics.push('The selected pack source is unavailable.'); return report; }
    report.source = source.id; report.revision = source.revision;
    report.diagnostics.push(...source.diagnostics);
    if (!source.toolIds.length || source.toolIds.length > 2000) {
      report.diagnostics.push('A pack must advertise between 1 and 2000 tools.'); return report;
    }
    if (new Set(source.toolIds).size !== source.toolIds.length) report.diagnostics.push('The tool index has duplicate identifiers.');
    const capability = renderCapabilities(options.workerConfigured ?? false);
    for (const id of source.toolIds) {
      const check: PackToolCheck = { source: source.id, id, valid: false, serverFormats: [], unavailableFormats: [], diagnostics: [] };
      report.tools.push(check);
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
        check.diagnostics.push('Invalid tool identifier.'); continue;
      }
      const root = resolve(source.root, 'tools');
      const observed = new Map<string, string>();
      const fetchFile = async (file: string) => {
        const path = resolve(root, file);
        if (!path.startsWith(root + sep) || file.includes('\\')) throw new Error('Invalid tool path');
        if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('Tool file exceeds inspection budget');
        const text = await readFile(path, 'utf8');
        observed.set(file, createHash('sha256').update(text).digest('hex'));
        return text;
      };
      try {
        const manifest = JSON.parse(await fetchFile(`${id}/tool.json`)) as { engineVersion?: unknown };
        if (typeof manifest.engineVersion === 'string') check.requiredEngine = manifest.engineVersion.slice(0, 120);
        const tool = await engine.loadTool(id, fetchFile);
        if (tool.manifest.id !== id) throw new Error('Tool identity mismatch');
        if (tool.manifest.hooks) await fetchFile(`${id}/hooks.js`);
        check.sourceHash = createHash('sha256').update(JSON.stringify([...observed].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
        check.valid = true;
        const formats = tool.manifest.render.formats.map(format => format === 'jpeg' ? 'jpg' : format);
        const browserNeeded = !!tool.manifest.hooks && !options.allowHooksInFastPath;
        const svgTemplate = typeof tool.template === 'string' && /<svg\b/i.test(tool.template);
        const hostApis = new Set(['color', 'profile', 'assets', 'state', 'clipboard', 'export', ...(source.tokensHead ? ['tokens'] : [])]);
        const unmet = (tool.manifest.requires ?? []).filter(api => !hostApis.has(api));
        const canRender = browserNeeded ? !!options.workerConfigured : svgTemplate && !unmet.length;
        if (!browserNeeded && !svgTemplate) check.diagnostics.push('The current server export path requires an SVG template. This tool can still be used locally.');
        if (!options.workerConfigured && browserNeeded) check.diagnostics.push('This tool needs a Chromium worker for server rendering.');
        if (tool.manifest.hooks && options.allowHooksInFastPath) check.diagnostics.push('Hooks run in the application process for this curated evaluation pack. Configure an isolated worker before production.');
        if (!options.workerConfigured && unmet.length) check.diagnostics.push(`Server host APIs unavailable: ${unmet.join(', ')}.`);
        check.serverFormats = canRender && (!browserNeeded || options.workerConfigured) ? formats.filter(format => capability.formats.includes(format)) : [];
        check.unavailableFormats = formats.filter(format => !check.serverFormats.includes(format));
        if (options.requireServerRendering && !check.serverFormats.length) check.valid = false;
      } catch {
        check.diagnostics.push(check.requiredEngine
          ? `Cannot load this tool: check its manifest, required files and engine ${check.requiredEngine} against installed ${engine.ENGINE_VERSION}.`
          : 'Cannot load this tool: check its manifest and required files.');
      }
    }
    // Remote assets are checked by a separate provider canary, never fetched here.
    for (const asset of source.assets) for (const format of asset.formats ?? []) {
      if (!format.url?.startsWith('/catalog/')) continue;
      const path = resolve(source.root, format.url.slice(1));
      if (!path.startsWith(resolve(source.root, 'catalog') + sep) || !(await stat(path).catch(() => null))?.isFile()) {
        report.diagnostics.push(`A local file is missing or invalid for asset ${asset.id}.`);
      }
    }
    report.compatible = report.diagnostics.length === 0 && report.tools.every(tool => tool.valid);
    report.revision = createHash('sha256').update(JSON.stringify([source.revision, report.tools.map(tool => [tool.id, tool.valid, tool.sourceHash])])).digest('hex');
  } catch {
    report.diagnostics.push('The pack cannot be read. Check its layout, profile selection and JSON indexes.');
  }
  return report;
}
