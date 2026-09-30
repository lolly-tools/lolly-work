// SPDX-License-Identifier: MPL-2.0
/** Standalone document assembly for declared, trusted tool presentations. */
import type { ExportOpts } from '@lolly-tools/core/host-v1';

/** Build an interactive document only from its explicitly declared runtime. */
export function portableHtml(doc: NonNullable<ExportOpts['portableDocument']>, resourceCss = ''): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const markup = doc.markup.replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (tag, attrs: string) =>
    /\btype\s*=\s*["']application\/json["']/i.test(attrs) && !/\bsrc\s*=/i.test(attrs) ? tag : '');
  const styles = (resourceCss + '\n' + doc.styles).replace(/<\/style/gi, '<\\/style');
  const script = doc.script.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="${esc(doc.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)}</title><style>html,body{margin:0;min-height:100%;}body{min-height:100dvh;}*{box-sizing:border-box;}${styles}</style></head>
<body data-lolly-portable>${markup}<script data-tool-presentation>${script}</script></body></html>`;
}
