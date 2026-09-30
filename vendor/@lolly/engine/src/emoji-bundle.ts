// SPDX-License-Identifier: MPL-2.0
/** Full pack admission for user imports. Every SVG passes the renderer's bounded subset. */
import { EMOJI_BUNDLE_MAX_BYTES } from '@lolly-tools/core/emoji-v1';
import type { EmojiPackBundleV1, EmojiPackManifestV1, EmojiPackPinV1, EmojiSetInfoV1 } from '@lolly-tools/core/emoji-v1';
import { sha256Hex } from './bytes.ts';
import { inspectEmojiPack, readEmojiPack, type VerifiedEmojiPack } from './emoji-pack.ts';
import { prepareEmojiSvg, type EmojiXmlParser } from './emoji-svg.ts';

export interface AdmittedEmojiBundle {
  bundle: EmojiPackBundleV1;
  manifest: EmojiPackManifestV1;
  info: EmojiSetInfoV1;
}

export async function readEmojiBundle(bytes: Uint8Array): Promise<AdmittedEmojiBundle & { pack: VerifiedEmojiPack }> {
  if (!bytes.length || bytes.length > EMOJI_BUNDLE_MAX_BYTES) throw new Error('Emoji pack exceeds the 64 MiB limit.');
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const bundle = raw as EmojiPackBundleV1;
  if (bundle?.schemaVersion !== 1 || bundle.kind !== 'emoji-pack-bundle' || typeof bundle.manifest !== 'string'
    || !bundle.artwork || typeof bundle.artwork !== 'object' || Array.isArray(bundle.artwork)) throw new Error('Invalid emoji pack bundle.');
  const header = JSON.parse(bundle.manifest) as EmojiPackManifestV1;
  const pin: EmojiPackPinV1 = { id: header.id, pin: { version: header.version }, checksum: `sha256:${await sha256Hex(new TextEncoder().encode(bundle.manifest))}` };
  const admitted = await readEmojiPack(new TextEncoder().encode(bundle.manifest), pin);
  if (!admitted.ok) throw new Error(admitted.issue.message);
  const manifest = inspectEmojiPack(admitted.pack)!;
  return { pack: admitted.pack, bundle, manifest, info: { pin, family: manifest.family, style: manifest.style,
    label: `${manifest.family} ${manifest.style}`, license: manifest.source.license,
    licenseUrl: manifest.source.licenseUrl, attribution: manifest.source.attribution,
    glyphs: manifest.glyphs.length, coverageComplete: false, bytes: bytes.length } };
}

export async function admitEmojiBundle(bytes: Uint8Array, parseXml: EmojiXmlParser): Promise<AdmittedEmojiBundle> {
  const read = await readEmojiBundle(bytes);
  const urls = new Set<string>();
  for (const glyph of read.manifest.glyphs) {
    const svg = Object.hasOwn(read.bundle.artwork, glyph.asset.url) ? read.bundle.artwork[glyph.asset.url] : undefined;
    if (typeof svg !== 'string') throw new Error(`Missing artwork: ${glyph.label}.`);
    const prepared = await prepareEmojiSvg(read.pack, glyph.meaning, new TextEncoder().encode(svg), parseXml);
    if (!prepared.ok) throw new Error(`${glyph.label}: ${prepared.message}`);
    urls.add(glyph.asset.url);
  }
  if (Object.keys(read.bundle.artwork).some(url => !urls.has(url))) throw new Error('Emoji pack contains unreferenced artwork.');
  return read;
}
