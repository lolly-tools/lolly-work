// SPDX-License-Identifier: MPL-2.0
/** dotLottie v1/v2 and raw JSON, with exact source bytes retained by the caller. */
import { base64ToBytes, bytesToBin } from './bytes.ts';
import { imageDimensions } from './penpot-file.ts';
import { readZip, storeZip, type ZipStoreEntry } from './zip.ts';
import { admitLottieAnimation, LOTTIE_LIMITS, lottieObject, readLottieJson, type LottieAnimation, type LottieObject } from './lottie-model.ts';

export interface LottieChoice { id: string; name: string; animation: LottieAnimation; durationMs: number }
export interface LottiePackage {
  version: 'json' | '1' | '2'; manifest: LottieObject | null;
  initial: string; animations: LottieChoice[]; warnings: string[];
  expandedBytes: number;
}
function safePath(path: string): string {
  if (!path || /[\\:%?#]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`dotLottie: unsafe or ambiguous member path ${path}.`);
  }
  return path;
}
export function lottieImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  throw new Error('Lottie images must be embedded PNG, JPEG or WebP.');
}
/** Only inert raster data URLs can reach a player; external URLs are never fetched. */
export function lottieImageBytes(data: string): Uint8Array {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
  if (!match) throw new Error('Lottie image: missing embedded raster bytes. External resources and SVG images are not supported.');
  const bytes = base64ToBytes(match[2]!);
  if (bytes.length > LOTTIE_LIMITS.jsonBytes || lottieImageMime(bytes) !== `image/${match[1]}`) throw new Error('Lottie image: invalid type or resource budget exceeded.');
  const size = imageDimensions(bytes);
  if (!size || size.w < 1 || size.h < 1 || size.w * size.h > 32000000) throw new Error('Lottie image: unreadable dimensions or more than 32 million pixels.');
  return bytes;
}
function inlineImages(animation: LottieAnimation, members: Map<string, Uint8Array>, directory: string, remaining = LOTTIE_LIMITS.inputBytes): number {
  let expanded = new TextEncoder().encode(JSON.stringify(animation)).length;
  const limit = Math.min(LOTTIE_LIMITS.inputBytes, remaining);
  if (expanded > limit) throw new Error('Lottie: combined animation resources exceed the expansion budget.');
  for (const asset of animation.assets ?? []) {
    if (typeof asset.p !== 'string') continue;
    if (asset.p.startsWith('data:')) { lottieImageBytes(asset.p); asset.u = ''; asset.e = 1; continue; }
    const resource = `${String(asset.u ?? '')}${asset.p}`;
    // Animation paths can refer to a sibling package directory with one ../.
    const name = resource.startsWith('../') ? safePath(resource.slice(3)) : safePath(resource);
    const candidates = resource.startsWith('../') ? [name] : [name, `${directory}/${name}`];
    const matches = candidates.filter(candidate => members.has(candidate));
    if (matches.length !== 1) throw new Error(`Lottie image ${resource}: ${matches.length ? 'ambiguous' : 'missing'} packaged resource.`);
    const bytes = members.get(matches[0]!)!;
    expanded += Math.ceil(bytes.length / 3) * 4;
    if (expanded > limit) throw new Error('Lottie: combined animation resources exceed the expansion budget.');
    asset.p = `data:${lottieImageMime(bytes)};base64,${btoa(bytesToBin(bytes))}`;
    lottieImageBytes(asset.p);
    asset.u = ''; asset.e = 1;
  }
  return expanded;
}
export function readLottie(bytes: Uint8Array): LottiePackage {
  if (bytes.length > LOTTIE_LIMITS.inputBytes) throw new Error('Lottie source exceeds 64 MiB.');
  const isZip = bytes[0] === 80 && bytes[1] === 75;
  if (!isZip) {
    const animation = admitLottieAnimation(readLottieJson(bytes, 'Lottie JSON'));
    const expandedBytes = inlineImages(animation, new Map(), '');
    return { version: 'json', manifest: null, initial: 'animation', warnings: [], expandedBytes, animations: [{ id: 'animation', name: String(animation.nm ?? 'Animation'), animation, durationMs: (animation.op - animation.ip) / animation.fr * 1000 }] };
  }
  const entries = readZip(bytes, { maxInputBytes: LOTTIE_LIMITS.inputBytes, maxEntryBytes: LOTTIE_LIMITS.jsonBytes, maxTotalBytes: LOTTIE_LIMITS.expandedBytes, maxEntries: LOTTIE_LIMITS.members });
  const members = new Map<string, Uint8Array>();
  for (const entry of entries) {
    safePath(entry.name);
    if (members.has(entry.name)) throw new Error(`dotLottie: duplicate member ${entry.name}.`);
    members.set(entry.name, entry.bytes);
  }
  const manifestBytes = members.get('manifest.json');
  if (!manifestBytes) throw new Error('dotLottie: missing manifest.json.');
  const manifest = readLottieJson(manifestBytes, 'dotLottie manifest');
  const version = manifest.version === '1.0' || manifest.version === '1' ? '1' : manifest.version === '2' ? '2' : null;
  if (!version) throw new Error(`dotLottie: unsupported manifest version ${String(manifest.version)}.`);
  if (!Array.isArray(manifest.animations) || !manifest.animations.length) throw new Error('dotLottie: no declared animations.');
  const initial = manifest.initial ? lottieObject(manifest.initial, 'dotLottie initial') : {};
  const warnings: string[] = [];
  if (initial.stateMachine || manifest.stateMachines) warnings.push('Interactive state machines are preserved in the source. Choose a linear animation for Sequence.');
  const animations: LottieChoice[] = [];
  let expandedBytes = 0;
  const ids = new Set<string>();
  for (const item of manifest.animations) {
    const entry = lottieObject(item, 'dotLottie animation');
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error('dotLottie: invalid or duplicate animation id.');
    ids.add(entry.id);
    if (entry.initialTheme || entry.theme || entry.background) throw new Error(`dotLottie ${entry.id}: themed appearance or a package background is not supported. Export an unthemed source first.`);
    if (entry.loop || entry.autoplay || entry.direction || entry.playMode || (entry.speed !== undefined && entry.speed !== 1)) warnings.push(`${entry.id}: package playback preferences are preserved; Sequence controls timing and plays each clip once.`);
    const directory = version === '2' ? 'a' : 'animations';
    const data = members.get(`${directory}/${entry.id}.json`);
    if (!data) throw new Error(`dotLottie: missing declared animation ${entry.id}.`);
    const animation = admitLottieAnimation(readLottieJson(data, entry.id), entry.id);
    expandedBytes += inlineImages(animation, members, directory, LOTTIE_LIMITS.expandedBytes - expandedBytes);
    animations.push({ id: entry.id, name: String(entry.name ?? animation.nm ?? entry.id), animation, durationMs: (animation.op - animation.ip) / animation.fr * 1000 });
  }
  const declared = version === '2' ? initial.animation : manifest.activeAnimationId;
  if (declared !== undefined && (typeof declared !== 'string' || !ids.has(declared))) throw new Error('dotLottie: the declared initial animation is missing.');
  return { version, manifest, animations, expandedBytes, initial: typeof declared === 'string' && ids.has(declared) ? declared : animations[0]!.id, warnings };
}
export function selectLottie(pkg: LottiePackage, id = pkg.initial): LottieChoice {
  const selected = pkg.animations.find(item => item.id === id);
  if (!selected) throw new Error(`Lottie: animation ${id} is not in this source.`);
  return selected;
}
/** Self-contained v2 package. Images live in i/ and no player fetches the network. */
export function writeDotLottie(animation: LottieAnimation, extra: ZipStoreEntry[] = []): Uint8Array {
  const copy = structuredClone(animation);
  const entries: ZipStoreEntry[] = [];
  const images = new Map<string, string>();
  for (const asset of copy.assets ?? []) if (typeof asset.p === 'string') {
    let name = images.get(asset.p);
    if (!name) {
      const bytes = lottieImageBytes(asset.p);
      const ext = lottieImageMime(bytes).split('/')[1]!;
      name = `${images.size}.${ext}`;
      images.set(asset.p, name);
      entries.push({ name: `i/${name}`, bytes });
    }
    asset.u = '../i/'; asset.p = name; asset.e = 0;
  }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  entries.unshift({ name: 'manifest.json', bytes: encode({ version: '2', generator: 'Lolly', initial: { animation: 'sequence' }, animations: [{ id: 'sequence' }] }) }, { name: 'a/sequence.json', bytes: encode(copy) });
  entries.push(...extra);
  if (entries.length > LOTTIE_LIMITS.members || entries.some(entry => entry.bytes.length > LOTTIE_LIMITS.jsonBytes) || entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > LOTTIE_LIMITS.expandedBytes) throw new Error('dotLottie: compiled package exceeds the resource limits.');
  const bytes = storeZip(entries, { forceDeflate: true });
  if (bytes.length > LOTTIE_LIMITS.inputBytes) throw new Error('dotLottie: compiled package exceeds 64 MiB.');
  return bytes;
}
