// SPDX-License-Identifier: MPL-2.0
/**
 * Vendor request to durable render plan, one pure function per source. Field names
 * follow each vendor's public documentation, read 2026-11-05. A property the mapping
 * does not name is refused by name unless the mapping lists it under `ignore`:
 * nothing a client sent is ever dropped silently.
 */
import { RenderApiRefusal, type RenderApiMapping, type RenderApiSource } from './types.ts';

export type MappingLookup = (source: RenderApiSource, template: string) => RenderApiMapping | undefined;

export interface MappedRequest {
  mapping: RenderApiMapping;
  formats: string[];
  inputs: Record<string, unknown>;
  metadata: unknown;
  /** Request fields the vendor's response repeats. */
  echo: Record<string, unknown>;
  webhookUrl?: string;
  /** Wait for the result rather than answering at once. */
  immediate: boolean;
  filename?: string;
}

/** Formats Work's render path makes. Others are refused by name, never swapped. */
const MAKEABLE = new Set(['svg', 'png', 'jpg', 'pdf']);
export const MAX_METADATA_CHARS = 4096;
/** Placid's documented limit on `passthrough`. */
export const MAX_PASSTHROUGH_CHARS = 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new RenderApiRefusal('INVALID_INPUT', 400, message); };
const notMappedYet = (source: RenderApiSource, template: string): never => {
  throw new RenderApiRefusal('TEMPLATE_NOT_MAPPED', 404, `${source} template ${template} is not mapped on this instance`, { template });
};

/** Collects inputs and every property nothing claims. */
class Collector {
  readonly inputs: Record<string, unknown> = {};
  readonly refused: string[] = [];
  private readonly mapping: RenderApiMapping;
  constructor(mapping: RenderApiMapping) { this.mapping = mapping; }
  take(layer: string, property: string, value: unknown): void {
    const properties = Object.hasOwn(this.mapping.layers, layer) ? this.mapping.layers[layer]! : undefined;
    const input = properties && Object.hasOwn(properties, property) ? properties[property] : undefined;
    if (input !== undefined) this.inputs[input] = value;
    else if (!this.mapping.ignore.includes(`${layer}.${property}`)) this.refused.push(`${layer}.${property}`);
  }
  /** Fixed inputs win over anything the request sent. */
  finish(): Record<string, unknown> {
    if (this.refused.length) {
      const properties = [...new Set(this.refused)].sort();
      throw new RenderApiRefusal('PROPERTY_NOT_MAPPED', 422, `not mapped for this template: ${properties.join(', ')}`, { properties });
    }
    return { ...this.inputs, ...this.mapping.fixed };
  }
}

function checkFormats(formats: readonly string[]): void {
  const refused = formats.filter((format) => !MAKEABLE.has(format));
  if (refused.length) throw new RenderApiRefusal('FORMAT_NOT_SUPPORTED', 422, `this server does not make: ${refused.join(', ')}`, { formats: refused });
}

function boundedMetadata(value: unknown, field: string, limit: number): unknown {
  if (value === undefined || value === null) return null;
  const size = typeof value === 'string' ? value.length : JSON.stringify(value).length;
  if (size > limit) invalid(`${field} is limited to ${limit} characters`);
  return value;
}

/** POST /v5/images. V5 has no per-request webhook, so there is none to carry. */
export function mapBannerbearV5(body: unknown, lookup: MappingLookup, immediate: boolean): MappedRequest {
  if (!isObject(body)) return invalid('a JSON object is required');
  if (typeof body.template !== 'string' || !body.template) return invalid('template is required');
  const mapping = lookup('bannerbear-v5', body.template) ?? notMappedYet('bannerbear-v5', body.template);
  const collect = new Collector(mapping);
  let formats = [mapping.format];
  if (body.formats !== undefined) {
    if (!Array.isArray(body.formats) || !body.formats.length || body.formats.some((format) => typeof format !== 'string')) invalid('formats must list output formats');
    formats = [...new Set((body.formats as string[]).map((format) => format.toLowerCase()))];
  }
  checkFormats(formats);
  for (const [key, value] of Object.entries(body)) {
    if (['template', 'formats', 'metadata', 'modifications'].includes(key)) continue;
    if (key === 'scale' && value === 1) continue;
    collect.take('$request', key, value);
  }
  const modifications = body.modifications;
  if (modifications !== undefined) {
    if (!isObject(modifications)) return invalid('modifications must be an object');
    for (const key of Object.keys(modifications)) if (key !== 'template' && key !== 'objects') collect.take('$request', `modifications.${key}`, modifications[key]);
    if (modifications.template !== undefined) {
      if (!isObject(modifications.template)) return invalid('modifications.template must be an object');
      for (const [key, value] of Object.entries(modifications.template)) {
        if (key === 'transparent' && value === false) continue;
        collect.take('$template', key, value);
      }
    }
    if (modifications.objects !== undefined) {
      if (!Array.isArray(modifications.objects)) return invalid('modifications.objects must be a list');
      for (const object of modifications.objects as unknown[]) {
        if (!isObject(object)) return invalid('each modification must be an object');
        const layer = typeof object.name === 'string' && object.name ? object.name : typeof object.id === 'string' && object.id ? object.id : null;
        if (!layer) return invalid('each modification needs a name or an id');
        for (const [property, value] of Object.entries(object)) {
          // `type` only applies when a template is created or updated, per the vendor's docs.
          if (property === 'name' || property === 'id' || property === 'type') continue;
          collect.take(layer, property, value);
        }
      }
    }
  }
  return {
    mapping, formats, inputs: collect.finish(), immediate, echo: {},
    metadata: boundedMetadata(body.metadata, 'metadata', MAX_METADATA_CHARS),
  };
}

/** POST /v2/images. */
export function mapBannerbearV2(body: unknown, lookup: MappingLookup, immediate: boolean): MappedRequest {
  if (!isObject(body)) return invalid('a JSON object is required');
  if (typeof body.template !== 'string' || !body.template) return invalid('template is required');
  const mapping = lookup('bannerbear-v2', body.template) ?? notMappedYet('bannerbear-v2', body.template);
  const collect = new Collector(mapping);
  if (!Array.isArray(body.modifications)) return invalid('modifications must be a list');
  for (const [key, value] of Object.entries(body)) {
    if (['template', 'modifications', 'metadata', 'webhook_url', 'render_pdf'].includes(key)) continue;
    if (key === 'transparent' && value === false) continue;
    collect.take('$request', key, value);
  }
  for (const modification of body.modifications as unknown[]) {
    if (!isObject(modification)) return invalid('each modification must be an object');
    if (typeof modification.name !== 'string' || !modification.name) return invalid('each modification needs a name');
    for (const [property, value] of Object.entries(modification)) if (property !== 'name') collect.take(modification.name, property, value);
  }
  const renderPdf = body.render_pdf === true;
  const webhookUrl = typeof body.webhook_url === 'string' && body.webhook_url ? body.webhook_url : undefined;
  if (body.webhook_url !== undefined && body.webhook_url !== null && webhookUrl === undefined) invalid('webhook_url must be a URL');
  // Two renders cannot announce themselves as one webhook on the durable outbox.
  if (renderPdf && webhookUrl) throw new RenderApiRefusal('WEBHOOK_WITH_PDF_NOT_SUPPORTED', 422, 'render_pdf with webhook_url is not supported here: poll for the PDF, or send two requests');
  const formats = renderPdf ? [...new Set([mapping.format, 'pdf'])] : [mapping.format];
  checkFormats(formats);
  return {
    mapping, formats, inputs: collect.finish(), immediate,
    metadata: boundedMetadata(body.metadata, 'metadata', MAX_METADATA_CHARS),
    echo: { modifications: structuredClone(body.modifications), transparent: body.transparent === true, render_pdf: renderPdf },
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

const PLACID_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** POST /images. */
export function mapPlacid(body: unknown, lookup: MappingLookup): MappedRequest {
  if (!isObject(body)) return invalid('a JSON object is required');
  if (typeof body.template_uuid !== 'string' || !body.template_uuid) return invalid('template_uuid is required');
  const mapping = lookup('placid', body.template_uuid) ?? notMappedYet('placid', body.template_uuid);
  const collect = new Collector(mapping);
  if (body.transfer !== undefined && body.transfer !== null) throw new RenderApiRefusal('TRANSFER_NOT_SUPPORTED', 422, 'transfer is not supported here: use an organisation delivery destination', { properties: ['transfer'] });
  for (const [key, value] of Object.entries(body)) {
    if (['template_uuid', 'layers', 'webhook_success', 'create_now', 'passthrough', 'modifications', 'transfer'].includes(key)) continue;
    // The vendor's own sample request carries an empty list here.
    if (key === 'errors' && Array.isArray(value) && value.length === 0) continue;
    collect.take('$request', key, value);
  }
  if (body.layers !== undefined) {
    if (!isObject(body.layers)) return invalid('layers must be an object');
    for (const [layer, properties] of Object.entries(body.layers)) {
      if (!isObject(properties)) return invalid(`layers.${layer} must be an object`);
      for (const [property, value] of Object.entries(properties)) collect.take(layer, property, value);
    }
  }
  let format = mapping.format;
  let filename: string | undefined;
  if (body.modifications !== undefined && body.modifications !== null) {
    if (!isObject(body.modifications)) return invalid('modifications must be an object');
    for (const [key, value] of Object.entries(body.modifications)) {
      if (key === 'image_format') {
        if (value === 'auto') continue;
        if (typeof value !== 'string') return invalid('image_format must be a format');
        format = value.toLowerCase();
      } else if (key === 'filename') {
        if (typeof value !== 'string' || !PLACID_FILENAME.test(value)) return invalid('filename must be a plain file name');
        filename = value;
      } else if (key === 'color_mode' && value === 'rgb') {
        continue;
      } else {
        collect.take('$modifications', key, value);
      }
    }
  }
  checkFormats([format]);
  const webhookUrl = typeof body.webhook_success === 'string' && body.webhook_success ? body.webhook_success : undefined;
  if (body.webhook_success !== undefined && body.webhook_success !== null && webhookUrl === undefined) invalid('webhook_success must be a URL');
  return {
    mapping, formats: [format], inputs: collect.finish(), immediate: body.create_now === true, echo: {},
    metadata: boundedMetadata(body.passthrough, 'passthrough', MAX_PASSTHROUGH_CHARS),
    ...(webhookUrl ? { webhookUrl } : {}), ...(filename ? { filename } : {}),
  };
}

const URL_PARAM = /^([^[\]]+)\[([^[\]]+)\]$/;

/** GET /u/{uuid}?layer[property]=value. The signature `s` is checked before this runs. */
export function mapPlacidUrl(uuid: string, params: URLSearchParams, lookup: MappingLookup): MappedRequest {
  const mapping = lookup('placid', uuid) ?? notMappedYet('placid', uuid);
  const collect = new Collector(mapping);
  for (const [name, value] of params) {
    if (name === 's') continue;
    const match = URL_PARAM.exec(name);
    if (!match) { collect.refused.push(`$request.${name}`); continue; }
    collect.take(match[1]!, match[2]!, value);
  }
  return { mapping, formats: [mapping.format], inputs: collect.finish(), immediate: true, metadata: null, echo: {} };
}
