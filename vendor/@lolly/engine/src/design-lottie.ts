// SPDX-License-Identifier: MPL-2.0
/** Authored Design values into the shared sequence compiler, identical on every host. */
import type { AssetRef, ExportOpts, HostV1 } from './bridge/host-v1.ts';
import { bytesToBin } from './bytes.ts';
import { parseColorToSrgb8 } from './css-color.ts';
import { colorToHex } from './tokens.ts';
import { parseSvgPath } from './svg-path.ts';
import { imageDimensions } from './penpot-file.ts';
import { lottieImageMime, readLottie, selectLottie, writeDotLottie } from './dotlottie.ts';
import { compileLottieSequence, lottieStatic as fixed, type LottieSequenceLayer } from './lottie-sequence.ts';
import type { LottieObject } from './lottie-model.ts';
import { applyLottieEdits } from './lottie-edit.ts';
import { attributionCompanion } from './rights-attribution.ts';
import { checkCompanionReadback } from './rights-companion.ts';
import { parseSequenceMarks, sequenceRange } from './sequence-marks.ts';

type Box = Record<string, unknown>;
const num = (value: unknown, fallback = 0): number => value === '' || value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
const yes = (value: unknown): boolean => value === true || value === 'true' || value === '1' || value === 1;
const authoredTime = (value: unknown): boolean => value !== '' && value != null && Number.isFinite(Number(value));
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

async function paint(value: unknown, host: HostV1): Promise<number[] | null> {
  let text = String(value ?? 'transparent');
  if (text === 'transparent' || text === 'none' || !text) return null;
  if (text.startsWith('{')) text = colorToHex(await host.tokens?.resolve(text)) ?? '';
  const variable = /^var\(--brand-(primary|on-primary|secondary|surface|text|muted|edge)\s*(?:,\s*(.+))?\)$/.exec(text);
  if (variable) text = colorToHex(await host.tokens?.resolve(`{color.semantic.${variable[1]}}`)) ?? variable[2] ?? '';
  const rgba = parseColorToSrgb8(text);
  if (!rgba) throw new Error(`dotLottie: colour ${String(value)} could not be resolved to a solid paint.`);
  return [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3]];
}
function unsupported(box: Box): void {
  const name = String(box.name || box.id || 'Layer');
  const fail = (feature: string) => { throw new Error(`${name}: ${feature} is not supported by dotLottie export. Remove it or export video.`); };
  if (String(box.text ?? '').trim() || box.kind === 'text') fail('text');
  if (box.pathPaint) fail('independent vector paint');
  if (box.kind === 'audio' || box.kind === 'camera' || box.kind === '3d') fail(String(box.kind));
  if (box.kind && !['box', 'path', 'image', 'frame'].includes(String(box.kind))) fail(String(box.kind));
  for (const field of ['grad', 'clip', 'bindStart', 'bindEnd', 'cls']) if (box[field]) fail(field);
  for (const field of ['blur', 'bgBlur', 'z', 'rx', 'ry']) if (num(box[field])) fail(field);
  for (const field of ['shadow', 'blend', 'enter', 'exit', 'hold', 'headStart', 'headEnd', 'split']) if (box[field] && box[field] !== 'none' && box[field] !== 'normal') fail(field);
  if (yes(box.flipH) || yes(box.flipV)) fail('mirroring');
  if (num(box.strokeW) > 0 && ((box.strokeDash && box.strokeDash !== 'solid') || box.strokeDashArray)) fail('dashed strokes');
}
async function shapes(box: Box, w: number, h: number, host: HostV1): Promise<LottieObject[]> {
  const out: LottieObject[] = [];
  const fill = await paint(box.bg, host), stroke = await paint(box.stroke, host);
  const sw = stroke ? Math.max(0, num(box.strokeW)) : 0;
  if (box.kind === 'path') {
    if (!box.path) return [];
    if (!host.geom) throw new Error('dotLottie path export needs host.geom.');
    const decoded = host.geom.decodeAuthored(String(box.path));
    if (!decoded.ok) throw new Error(`Path ${String(box.id)}: ${decoded.message}`);
    for (const src of decoded.value) {
      const nodes = src.nodes.map(node => ({ ...node, x: node.x * w, y: node.y * h,
        ...(node.hInX !== undefined ? { hInX: node.hInX * w } : {}), ...(node.hInY !== undefined ? { hInY: node.hInY * h } : {}),
        ...(node.hOutX !== undefined ? { hOutX: node.hOutX * w } : {}), ...(node.hOutY !== undefined ? { hOutY: node.hOutY * h } : {}),
      }));
      const result = host.geom.fromNodes({ ...src, nodes, decimals: 3 });
      if (!result.ok) throw new Error(`Path ${String(box.id)}: ${result.message}`);
      for (const path of parseSvgPath(result.d)) {
        const vertices: number[][] = [], incoming: number[][] = [], outgoing: number[][] = [];
        for (const segment of path.segments) {
          if (segment.op === 'C') {
            const previous = vertices.at(-1)!;
            outgoing[outgoing.length - 1] = [segment.x1 - previous[0]!, segment.y1 - previous[1]!];
          }
          vertices.push([segment.x, segment.y]);
          incoming.push(segment.op === 'C' ? [segment.x2 - segment.x, segment.y2 - segment.y] : [0, 0]); outgoing.push([0, 0]);
        }
        out.push({ ty: 'sh', ks: fixed({ v: vertices, i: incoming, o: outgoing, c: path.closed }) });
      }
    }
  } else {
    const ellipse = box.shape === 'circle' || box.shape === 'ellipse';
    if (!['rect', 'rounded', 'pill', 'circle', 'ellipse', ''].includes(String(box.shape ?? ''))) throw new Error(`${String(box.id)}: unsupported shape ${String(box.shape)}.`);
    out.push({ ty: ellipse ? 'el' : 'rc', p: fixed([w / 2, h / 2]), s: fixed([Math.max(0, w - sw), Math.max(0, h - sw)]),
      ...(!ellipse ? { r: fixed(box.shape === 'pill' ? Math.min(w, h) / 2 : box.shape === 'rounded' ? Math.max(0, num(box.radius, 16) - sw / 2) : 0) } : {}), d: 1 });
  }
  if (fill) out.push({ ty: 'fl', c: fixed(fill), o: fixed(fill[3]! * 100), r: box.fillRule === 'evenodd' ? 2 : 1 });
  if (stroke && sw) out.push({ ty: 'st', c: fixed(stroke), o: fixed(stroke[3]! * 100), w: fixed(sw), lc: box.strokeCap === 'round' ? 2 : box.strokeCap === 'square' ? 3 : 1, lj: box.strokeJoin === 'round' ? 2 : box.strokeJoin === 'bevel' ? 3 : 1, ml: 4 });
  return out;
}
/** Freeze before IO; asset bytes resolve through the same pinned refs as other exports. */
export async function exportDesignLottie(opts: ExportOpts & { fps?: number }, host: HostV1): Promise<Blob> {
  if (opts.sourceDocument?.toolId !== 'design') throw new Error('dotLottie export needs an authored Design sequence.');
  if (opts.watermark) throw new Error('dotLottie cannot carry the requested visible watermark.');
  const values = structuredClone(opts.sourceDocument.values);
  if (values.customCss) throw new Error('dotLottie cannot reproduce custom CSS. Remove it or export video.');
  const boxes = (Array.isArray(values.boxes) ? values.boxes : []) as Box[];
  const visible = boxes.filter(box => !yes(box.hidden));
  const frames = visible.filter(box => box.kind === 'frame');
  if (frames.length > 1) throw new Error('dotLottie currently exports one artboard. Use one sequence artboard or export video.');
  const frame = frames[0];
  if (frame) unsupported(frame);
  const width = Math.round(num(frame?.w, num(opts.width, 1080))), height = Math.round(num(frame?.h, num(opts.height, 1080)));
  const ignored = boxes.filter(box => box.lane === 'seq' && yes(box.ignored) && authoredTime(box.dur));
  const start = (box: Box): number => {
    const s = clamp(num(box.start), 0, 3600);
    const removed = box.lane === 'seq' ? ignored.filter(other => num(other.start) < s - 1e-6).reduce((sum, other) => sum + clamp(num(other.dur), 0.1, 3600), 0) : 0;
    return Math.round(Math.max(0, s - removed) * 1000);
  };
  const content = visible.filter(box => box.kind !== 'frame' && !yes(box.ignored) && (!frame || String(box.frame) === String(frame.id)));
  const timed = content.filter(box => box.lane === 'seq' || authoredTime(box.start));
  const finite = timed.filter(box => authoredTime(box.dur));
  const durationMs = finite.length ? Math.max(...finite.map(box => start(box) + Math.round(clamp(num(box.dur), 0.1, 3600) * 1000))) : 5000;
  const layers: LottieSequenceLayer[] = [];
  const background = opts.background === 'transparent' || yes(values.transparentBg) ? null : await paint(frame?.bg ?? values.background, host);
  if (background) layers.push({ name: 'Background', x: 0, y: 0, w: width, h: height, rotation: 0, opacity: 1, startMs: 0, durationMs,
    content: { kind: 'shape', shapes: [{ ty: 'rc', p: fixed([width / 2, height / 2]), s: fixed([width, height]), r: fixed(0) }, { ty: 'fl', c: fixed(background), o: fixed(background[3]! * 100), r: 1 }] } });
  for (const box of content) {
    opts.signal?.throwIfAborted();
    unsupported(box);
    const layer: LottieSequenceLayer = {
      name: String(box.name || box.id || 'Layer'), x: Math.round(num(box.x)) - Math.round(num(frame?.x)), y: Math.round(num(box.y)) - Math.round(num(frame?.y)),
      w: Math.max(1, Math.round(num(box.w, 1))), h: Math.max(1, Math.round(num(box.h, 1))), rotation: Math.round(num(box.rot) * 10) / 10,
      opacity: clamp(num(box.opacity, 100), 0, 100) / 100, startMs: start(box), durationMs: authoredTime(box.dur) ? Math.round(clamp(num(box.dur), 0.1, 3600) * 1000) : durationMs - start(box),
      kf: String(box.kf ?? ''), content: { kind: 'shape', shapes: [] },
    };
    const ref = typeof box.image === 'string' && box.image ? await host.assets.get(box.image) : box.image as AssetRef | undefined;
    if (ref?.id) {
      if (ref.type !== 'lottie' && ref.type !== 'raster') throw new Error(`${layer.name}: ${ref.type} media needs video export.`);
      if (ref.meta?.animated) throw new Error(`${layer.name}: animated raster media needs video export.`);
      if (num(box.strokeW) || !['', 'rect'].includes(String(box.shape ?? '')) || await paint(box.bg, host)) throw new Error(`${layer.name}: remove the media border, shape or background before dotLottie export.`);
      if ((box.imgpos && box.imgpos !== 'center') || box.imageFraming) throw new Error(`${layer.name}: dotLottie requires centred media fitting.`);
      if (!host.assets.bytes) throw new Error('This shell cannot read the source asset bytes for dotLottie export.');
      const bytes = await host.assets.bytes(ref);
      opts.signal?.throwIfAborted();
      const fit = box.fit === 'cover' ? 'cover' : 'contain';
      if (ref.type === 'lottie') layer.content = { kind: 'animation', animation: await applyLottieEdits(selectLottie(readLottie(bytes), String(box.animationId || ref.meta?.lottieAnimationId || '') || undefined).animation, String(box.animationEdits ?? '')), clipInMs: Math.round(clamp(num(box.clipIn), 0, 3600) * 1000), speed: Math.round(clamp(num(box.speed, 1), 0.25, 4) * 100) / 100, fit };
      else {
        const mime = lottieImageMime(bytes), size = imageDimensions(bytes, mime);
        if (!size || size.w * size.h > 32000000) throw new Error(`${layer.name}: unreadable image or image exceeds 32 million pixels.`);
        layer.content = { kind: 'image', data: `data:${mime};base64,${btoa(bytesToBin(bytes))}`, width: size.w, height: size.h, fit };
      }
    } else layer.content = { kind: 'shape', shapes: await shapes(box, layer.w, layer.h, host) };
    layers.push(layer);
  }
  const fps = num(opts.fps, num(values.projectFps, 30));
  let animation = compileLottieSequence({ width, height, fps, durationMs, layers });
  const range = sequenceRange(parseSequenceMarks(values.sequenceMarks), durationMs);
  if (range.fromMs || range.toMs < durationMs) animation = compileLottieSequence({ width, height, fps, durationMs: range.toMs - range.fromMs, layers: [{ name: 'Sequence range', x: 0, y: 0, w: width, h: height, rotation: 0, opacity: 1, startMs: 0, durationMs: range.toMs - range.fromMs, content: { kind: 'animation', animation, clipInMs: range.fromMs, speed: 1, fit: 'contain' } }] });
  const extras = opts.rights ? attributionCompanion(opts.rights.plan).files.map(file => ({ name: file.name, bytes: new TextEncoder().encode(file.text) })) : [];
  if (opts.meta) extras.push({ name: 'lolly-metadata.json', bytes: new TextEncoder().encode(JSON.stringify(opts.meta)) });
  const bytes = writeDotLottie(animation, extras);
  if (opts.rights?.onReceipt) opts.rights.onReceipt(await checkCompanionReadback(bytes, opts.rights.plan, opts.rights.fingerprint));
  return new Blob([bytes as BlobPart], { type: 'application/zip+dotlottie' });
}
