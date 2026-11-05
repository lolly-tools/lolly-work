// SPDX-License-Identifier: MPL-2.0
/**
 * The mapping from vendor templates to Lolly tools, checked when the server boots
 * and by `lw render-api check`. It imports nothing that needs a server, so the CLI
 * can read the same rules with no instance running.
 */
import { RENDER_API_SOURCES, type RenderApiConfig, type RenderApiMapping, type RenderApiSource } from './types.ts';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORMATS = new Set(['svg', 'png', 'jpg', 'pdf']);
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const INPUT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_NAME = 200;
const MAX_IGNORED = 1000;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = (key: string): boolean => key.length >= 1 && key.length <= MAX_NAME && !UNSAFE_KEYS.has(key);

function parseEntry(value: unknown, where: string): RenderApiMapping {
  const bad = (message: string): never => { throw new Error(`${where}: ${message}`); };
  if (!isObject(value)) return bad('must be an object');
  for (const key of Object.keys(value)) if (!['source', 'template', 'toolId', 'format', 'layers', 'ignore', 'fixed', 'url'].includes(key)) bad(`unknown field ${key.slice(0, 60)}`);
  if (!RENDER_API_SOURCES.includes(value.source as RenderApiSource)) bad(`source must be one of ${RENDER_API_SOURCES.join(', ')}`);
  if (typeof value.template !== 'string' || !safeKey(value.template)) bad('template must be the vendor template id');
  if (typeof value.toolId !== 'string' || !TOOL_ID.test(value.toolId)) bad('toolId must be a tool id');
  const format = String(value.format ?? '').toLowerCase().replace(/^jpeg$/, 'jpg');
  if (!FORMATS.has(format)) bad(`format must be one of ${[...FORMATS].join(', ')}`);
  if (!isObject(value.layers)) bad('layers must be an object');
  const layers: RenderApiMapping['layers'] = {};
  for (const [layer, properties] of Object.entries(value.layers as Record<string, unknown>)) {
    if (!safeKey(layer)) bad('a layer name is not usable');
    if (!isObject(properties)) bad(`layers.${layer} must be an object`);
    layers[layer] = {};
    for (const [property, input] of Object.entries(properties as Record<string, unknown>)) {
      if (!safeKey(property)) bad(`a property on ${layer} is not usable`);
      if (typeof input !== 'string' || !INPUT_ID.test(input)) bad(`layers.${layer}.${property} must name a tool input`);
      layers[layer]![property] = input as string;
    }
  }
  const ignore = value.ignore === undefined ? [] : value.ignore;
  if (!Array.isArray(ignore) || ignore.length > MAX_IGNORED || ignore.some((item) => typeof item !== 'string' || !item || item.length > 2 * MAX_NAME)) bad('ignore must list layer.property names');
  const fixed = value.fixed === undefined ? {} : value.fixed;
  if (!isObject(fixed) || Object.keys(fixed as object).some((key) => !INPUT_ID.test(key))) bad('fixed must map tool inputs to values');
  const entry: RenderApiMapping = {
    source: value.source as RenderApiSource, template: value.template as string, toolId: value.toolId as string, format, layers,
    ignore: [...ignore as string[]], fixed: structuredClone(fixed as Record<string, unknown>),
  };
  if (value.url !== undefined) {
    if (value.source !== 'placid') bad('url applies to Placid templates only');
    if (!isObject(value.url)) return bad('url must be an object');
    const url = value.url;
    for (const key of Object.keys(url)) if (!['credentialRef', 'allowUnsigned'].includes(key)) bad(`unknown url field ${key.slice(0, 60)}`);
    if (url.credentialRef !== undefined && (typeof url.credentialRef !== 'string' || !ENV_NAME.test(url.credentialRef))) bad('url.credentialRef must name an environment variable');
    if (url.allowUnsigned !== undefined && typeof url.allowUnsigned !== 'boolean') bad('url.allowUnsigned must be true or false');
    entry.url = { ...(url.credentialRef ? { credentialRef: url.credentialRef as string } : {}), ...(url.allowUnsigned !== undefined ? { allowUnsigned: url.allowUnsigned as boolean } : {}) };
  }
  return entry;
}

/** Checks a list of mappings. One template id per source. */
export function parseRenderApiMappings(value: unknown, where = 'renderApi.templates'): RenderApiMapping[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  const entries = value.map((item, index) => parseEntry(item, `${where}[${index}]`));
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.source}\n${entry.template}`;
    if (seen.has(key)) throw new Error(`${where}: ${entry.source} template ${entry.template} is mapped twice`);
    seen.add(key);
  }
  return entries;
}

/** Checks the `renderApi` block of the instance configuration. */
export function checkRenderApiConfig(value: unknown): RenderApiConfig {
  if (!isObject(value)) throw new Error('renderApi must be an object');
  for (const key of Object.keys(value)) if (!['enabled', 'mappingsFile', 'templates', 'resultUrls', 'urlApi'].includes(key)) throw new Error(`renderApi: unknown field ${key.slice(0, 60)}`);
  if (typeof value.enabled !== 'boolean') throw new Error('renderApi.enabled must be true or false');
  if (value.mappingsFile !== undefined && (typeof value.mappingsFile !== 'string' || !value.mappingsFile)) throw new Error('renderApi.mappingsFile must be a path');
  const days = (value.resultUrls as { signedDays?: unknown } | undefined)?.signedDays;
  if (!Number.isSafeInteger(days) || (days as number) < 0 || (days as number) > 3650) throw new Error('renderApi.resultUrls.signedDays must be a whole number from 0 to 3650');
  const actAs = (value.urlApi as { actAs?: unknown } | undefined)?.actAs;
  if (actAs !== undefined && (typeof actAs !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(actAs))) throw new Error('renderApi.urlApi.actAs must be a service token id');
  return {
    enabled: value.enabled, ...(value.mappingsFile ? { mappingsFile: value.mappingsFile as string } : {}),
    templates: parseRenderApiMappings(value.templates ?? []),
    resultUrls: { signedDays: days as number },
    urlApi: actAs ? { actAs: actAs as string } : {},
  };
}

/** A lookup over the mappings, so an unknown template is one clear refusal. */
export function mappingIndex(mappings: readonly RenderApiMapping[]): (source: RenderApiSource, template: string) => RenderApiMapping | undefined {
  const index = new Map(mappings.map((entry) => [`${entry.source}\n${entry.template}`, entry]));
  return (source, template) => index.get(`${source}\n${template}`);
}
