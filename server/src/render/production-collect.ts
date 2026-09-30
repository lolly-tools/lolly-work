import type { ProductionCollector } from '@lolly/engine/production/types';
import { productionApi } from './production.ts';
import { collectWorkPdf } from './production-pdf.ts';
interface XmlNode { localName: string; namespaceURI: string | null; id: string; textContent: string | null; outerHTML: string; getAttribute(key: string): string | null; getAttributeNS(ns: string, key: string): string | null; getElementsByTagName(tag: string): ArrayLike<XmlNode> }
export const collectWorkProduction: ProductionCollector = async (bytes, contract, signal) => {
  signal?.throwIfAborted();
  if (contract.profile !== 'lolly/production-still-v1') return { limitations: ['production-profile-unavailable-in-work'] };
  const format = productionApi.productionFormat(bytes);
  if (bytes.length > 32 * 1024 * 1024) return { limitations: ['artifact-byte-budget-exceeded'] };
  if (format === 'pdf') return collectWorkPdf(bytes, contract, signal);
  if (format === 'png' || format === 'jpg') {
    try {
      const sharp = (await import('sharp')).default;
      const input = Buffer.from(bytes), options = { limitInputPixels: 16_000_000, failOn: 'warning' as const };
      const meta = await sharp(input, options).metadata();
      if (!meta.width || !meta.height || (meta.pages ?? 1) !== 1) return { format, limitations: ['pixel-budget-or-multiple-frames'] };
      if (format === 'png') for (let offset = 8; offset + 12 <= input.length;) {
        if (input.toString('ascii', offset + 4, offset + 8) === 'acTL') return { format, limitations: ['multiple-frames-unsupported'] };
        offset += input.readUInt32BE(offset) + 12;
      }
      const { data, info } = await sharp(input, options).timeout({ seconds: 10 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true }); signal?.throwIfAborted();
      let opaque = true; for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
      return { format, readable: true, width: info.width, height: info.height, pages: 1, opaque, pixels: { width: info.width, height: info.height, rgba: new Uint8Array(data) }, limitations: ['flattened-source-semantics-unavailable', 'pixels-converted-to-srgb-8-bit'] };
    } catch (error) {
    signal?.throwIfAborted();
    const e = error as { code?: string; message?: string };
    const gap = e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND' || /pixel limit|timeout|timed out/i.test(e.message ?? '');
    return { format, ...(gap ? {} : { readable: false }), limitations: [gap ? 'pixel-decoder-unavailable-or-budget' : 'pixel-decode-failed'] };
  }
  }
  try {
    const specifier: string = 'jsdom';
    const { JSDOM } = await import(specifier);
    return await productionApi.collectProductionSvg(bytes, contract, async (xml, ids) => {
      const dom = new JSDOM(xml, { contentType: 'image/svg+xml' });
      try {
        const root = dom.window.document.documentElement as XmlNode, wanted = new Set(ids);
        return { valid: root.localName === 'svg' && root.namespaceURI === 'http://www.w3.org/2000/svg', width: root.getAttribute('width'), height: root.getAttribute('height'),
          nodes: [root, ...Array.from(root.getElementsByTagName('*'))].filter(n => wanted.has(n.id)).map(n => ({ id: n.id, name: n.namespaceURI === 'http://www.w3.org/2000/svg' ? n.localName : 'unsupported', text: n.textContent ?? '', href: n.getAttribute('href') ?? n.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '', xml: n.outerHTML })) };
      } finally { dom.window.close(); }
    });
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' || (error as { code?: string }).code === 'MODULE_NOT_FOUND';
    return { ...(missing ? {} : { readable: false }), limitations: [missing ? 'svg-parser-unavailable' : 'svg-parse-failed'] };
  }
};
