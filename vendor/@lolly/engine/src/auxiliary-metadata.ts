// SPDX-License-Identifier: MPL-2.0
/** Readable XMP/RDF evidence belonging to an embedded JPEG rendition. */
import type { MetaField } from './file-metadata.ts';
import { xmlProvenanceFields } from './software-origin.ts';
import { readXmpFields, type XmpFieldSpec } from './xmp-fields.ts';

export interface AuxiliaryMetadata {
  name: string;
  fields: MetaField[];
  xmp: string;
}

const APPLE_PIXELS = 'http://ns.apple.com/pixeldatainfo/1.0/';
const APPLE_HDR = 'http://ns.apple.com/HDRGainMap/1.0/';
const HDR = 'http://ns.adobe.com/hdr-gain-map/1.0/';
const SPECS: XmpFieldSpec[] = [
  ['apdi', APPLE_PIXELS, 'AuxiliaryImageType', 'technical', 'Auxiliary image type'],
  ['apdi', APPLE_PIXELS, 'NativeFormat', 'technical', 'Native pixel format'],
  ['apdi', APPLE_PIXELS, 'StoredFormat', 'technical', 'Stored pixel format'],
  ['HDRGainMap', APPLE_HDR, 'HDRGainMapVersion', 'technical', 'Gain map version'],
  ['HDRGainMap', APPLE_HDR, 'HDRGainMapHeadroom', 'technical', 'Recorded HDR headroom'],
  ...(['Version', 'GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMin', 'HDRCapacityMax', 'BaseRenditionIsHDR', 'UseBaseColorSpace'] as const).map((property): XmpFieldSpec => [
    'hdrgm', HDR, property, 'technical', ({ Version: 'Gain map version', GainMapMin: 'Minimum gain', GainMapMax: 'Maximum gain', Gamma: 'Gamma', OffsetSDR: 'SDR offset', OffsetHDR: 'HDR offset', HDRCapacityMin: 'Minimum HDR capacity', HDRCapacityMax: 'Maximum HDR capacity', BaseRenditionIsHDR: 'Base image is HDR', UseBaseColorSpace: 'Uses base colour space' })[property],
  ]),
];

/** The caller supplies only the packet from a validated, indexed secondary image. */
export function auxiliaryMetadata(packet: string, gainMap: boolean): AuxiliaryMetadata {
  const xmp = packet.slice(0, 1024 * 1024);
  const technical = readXmpFields(xmp, SPECS);
  const apple = technical.some((f) => f.label === 'Auxiliary image type' && f.value === 'urn:com:apple:photo:2020:aux:hdrgainmap');
  return {
    name: apple ? 'Apple HDR gain map' : gainMap ? 'HDR gain map' : 'Embedded JPEG',
    fields: [...technical, ...xmlProvenanceFields(xmp)].slice(0, 64),
    xmp,
  };
}
