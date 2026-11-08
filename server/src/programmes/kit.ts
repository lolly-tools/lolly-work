// SPDX-License-Identifier: MPL-2.0
/** Partner kit readers and proposals (plans/82 M8). Imports store no bytes. */
import {
  PARTNER_KIT_MAX_BYTES, type PartnerKitV1, type PartnerKitIssueV1,
} from '@lolly-tools/core/partner-kit-v1';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import type { Store } from '../store/types.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import { centralEntries, entryBytes, type ZipEntry } from '../catalog/instance-pack.ts';
import { MAX_RULES_FILE_BYTES } from '../catalog/rules-tools.ts';
import { LOGO_FIELD } from './profile.ts';
import type { CompanyRecord } from './people.ts';

export const KIT_MAX_BYTES = PARTNER_KIT_MAX_BYTES;
export const KIT_TOKENS_MAX_BYTES = 2 * 1024 * 1024;
export const KIT_LOLLY_MAX_BYTES = MAX_RULES_FILE_BYTES;
/** A share's design system, inflated: a tokens document with room for embedded data, far below the pack budget. */
export const KIT_DESIGN_SYSTEM_MAX_BYTES = 8 * 1024 * 1024;
const SURFACES = ['light', 'dark', 'mark'] as const;

interface TokensExtraction { doc: unknown; warnings: string[] }
interface KitEngine {
  readPartnerKit(value: unknown): PartnerKitV1 | null;
  checkPartnerKit(value: unknown): { ok: true; kit: PartnerKitV1 } | { ok: false; issues: PartnerKitIssueV1[] };
  partnerKitLogoIds(kit: PartnerKitV1): string[];
  partnerKitColoursFromTokens(doc: unknown): PartnerKitV1['colours'];
  partnerKitColoursFromInks(colours: readonly string[]): PartnerKitV1['colours'];
  extractSvgColors(svg: string): string[];
  coerceTokensDoc(doc: unknown): TokensExtraction;
  assembleTokenSetFiles(files: Record<string, unknown>): TokensExtraction;
  extractPenpotProject(entries: Record<string, Uint8Array | string>): TokensExtraction;
}
const ENGINE: string = '@lolly/engine';
let engine: Promise<KitEngine> | null = null;
const loadKitEngine = (): Promise<KitEngine> => engine ??= (import(ENGINE) as Promise<KitEngine>).catch((error: unknown) => { engine = null; throw error; });

/** A source reference is a file name or a short label, never a path or URL. */
export function kitReference(value: string): boolean {
  return !!value.trim() && value.length <= 200 && !/[\\/:\u0000-\u001f\u007f]/.test(value);
}

export async function readKit(value: unknown): Promise<{ ok: true; kit: PartnerKitV1; bytes: Buffer } | { ok: false; detail: string }> {
  const e = await loadKitEngine();
  const kit = e.readPartnerKit(value);
  if (!kit) {
    const checked = e.checkPartnerKit(value);
    return { ok: false, detail: checked.ok ? 'The kit cannot be read.' : checked.issues.map((i) => i.message).join(' ') };
  }
  if (kit.source?.reference !== undefined && !kitReference(kit.source.reference)) return { ok: false, detail: 'source.reference must be a file name or label, never a path or URL' };
  const bytes = Buffer.from(`${JSON.stringify(kit, null, 2)}\n`);
  if (bytes.length > KIT_MAX_BYTES) return { ok: false, detail: `a normalized kit is at most ${KIT_MAX_BYTES} bytes` };
  return { ok: true, kit, bytes };
}

/** Check ownership and every pinned version before the submit pipeline writes. */
export async function prepareCompanyKit(store: Store, companyId: string, bytes: Buffer, target?: InstanceAssetRecord) {
  const read = await readKit(bytes.toString('utf8'));
  if (!read.ok) return read;
  if (read.kit.id !== companyId) return { ok: false as const, detail: 'the kit id must be the company id' };
  const company = (await store.listCompanies()).find((c) => c.id === companyId);
  const programme = company ? await store.getProgramme(company.programmeId) : null;
  if (!company || !programme || company.endedAt || programme.endedAt) return { ok: false as const, detail: 'save a kit for a company in a live programme' };
  const profile = await store.getCompanyProfile(companyId);
  if (target ? profile?.kit?.assetId !== target.id || target.entry.type !== 'partner-kit' || (target.entry.meta as { company?: unknown })?.company !== companyId : !!profile?.kit) {
    return { ok: false as const, detail: 'this company already has one kit; submit a new version of that asset' };
  }
  const owned = new Set(SURFACES.map((s) => profile?.profile[LOGO_FIELD[s]]).filter(Boolean));
  const e = await loadKitEngine();
  for (const id of e.partnerKitLogoIds(read.kit)) {
    const rec = owned.has(id) ? await store.getInstanceAsset(id) : null;
    const meta = rec?.entry.meta as { company?: unknown; surface?: unknown } | undefined;
    if (!rec || meta?.company !== companyId || !SURFACES.includes(meta.surface as typeof SURFACES[number]) || !(rec.entry.tags as string[] | undefined)?.includes('logo')) {
      return { ok: false as const, detail: `logo ${id} must be one of this company's own profile logo assets` };
    }
    const pin = Object.values(read.kit.logos).find((logo) => logo?.id === id)!;
    const version = pin.version === (rec.headVersion ?? 1) ? { formats: Object.values(rec.blobs).map((blobId) => ({ blobId })) } : await store.getAssetVersion(id, pin.version);
    if (!version?.formats.length) return { ok: false as const, detail: `logo ${id} has no version ${pin.version}` };
  }
  return read;
}

/** Whether a company still exists in a live programme, asked again when a save is about to publish.
 *  With `createdAt`, only that same company record counts, never one made later with its id. */
export async function kitCompanyLive(store: Store, companyId: string, createdAt?: string): Promise<boolean> {
  const company = (await store.listCompanies()).find((c) => c.id === companyId);
  const programme = company ? await store.getProgramme(company.programmeId) : null;
  return !!company && !!programme && !company.endedAt && !programme.endedAt
    && (createdAt === undefined || company.createdAt === createdAt);
}

/** Read stored JSON with the format's own byte bound. */
export async function storedKit(blobs: BlobStore, rec: InstanceAssetRecord): Promise<PartnerKitV1 | null> {
  const blob = rec.blobs.json ? await blobs.get(rec.blobs.json) : null;
  if (!blob) return null;
  const bytes = await readBlobBody(blob.body, KIT_MAX_BYTES);
  return (await loadKitEngine()).readPartnerKit(bytes.toString('utf8'));
}

function tokenPart(bytes: Buffer, entry: ZipEntry, maxBytes = KIT_TOKENS_MAX_BYTES): Buffer {
  if (entry.flags & 1) throw new Error('encrypted zip entries cannot be read');
  const part = entryBytes(bytes, entry, maxBytes);
  if (part.length !== entry.size) throw new Error('zip entry size does not match its directory');
  return part;
}

export type KitImportKind = 'tokens' | 'lolly' | 'logos';

/** Propose colours and current logo pins. The person supplies every rule. */
export async function proposeCompanyKit(store: Store, blobs: BlobStore, company: CompanyRecord, kind: KitImportKind, bytes: Buffer, reference: string): Promise<{ kit: PartnerKitV1; warnings: string[] }> {
  if (!kitReference(reference)) throw new Error('give a file name without a path or URL');
  if (bytes.length > (kind === 'lolly' ? KIT_LOLLY_MAX_BYTES : KIT_TOKENS_MAX_BYTES)) throw new Error('import file exceeds its byte bound');
  const e = await loadKitEngine();
  const profile = await store.getCompanyProfile(company.id);
  const logos: PartnerKitV1['logos'] = {};
  const inks: string[] = [];
  for (const surface of SURFACES) {
    const id = profile?.profile[LOGO_FIELD[surface]];
    const rec = id ? await store.getInstanceAsset(id) : null;
    if (!rec) continue;
    logos[surface] = { id: rec.id, version: rec.headVersion ?? 1 };
    if (kind === 'logos' && rec.blobs.svg) {
      const blob = await blobs.get(rec.blobs.svg);
      if (blob) inks.push(...e.extractSvgColors((await readBlobBody(blob.body, 512 * 1024)).toString('utf8')));
    }
  }
  let colours: PartnerKitV1['colours'] = [];
  const warnings: string[] = [];
  if (kind === 'logos') colours = e.partnerKitColoursFromInks(inks);
  else {
    let extraction: TokensExtraction | null = null;
    if (kind === 'lolly') {
      const entries = centralEntries(bytes);
      const design = entries.find((part) => part.name === 'design-system.json');
      if (design) extraction = e.coerceTokensDoc(JSON.parse(tokenPart(bytes, design, KIT_DESIGN_SYSTEM_MAX_BYTES).toString('utf8')));
      else warnings.push('This share has no design-system.json part, so no colours were proposed.');
    } else if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      const entries = centralEntries(bytes).filter((part) => part.name.endsWith('.json') && !part.name.startsWith('__MACOSX/'));
      if (entries.length > 512) throw new Error('token archive has more than 512 JSON parts');
      const parts: Record<string, Uint8Array> = Object.create(null);
      let size = 0;
      for (const entry of entries) {
        const part = tokenPart(bytes, entry);
        size += part.length;
        if (size > KIT_TOKENS_MAX_BYTES) throw new Error('expanded token archive exceeds 2 MiB');
        parts[entry.name] = part;
      }
      if (entries.some((part) => /^files\/[^/]+\/tokens\.json$/.test(part.name))) extraction = e.extractPenpotProject(parts);
      else if (parts['tokens.json']) extraction = e.coerceTokensDoc(JSON.parse(Buffer.from(parts['tokens.json']).toString('utf8')));
      else extraction = e.assembleTokenSetFiles(Object.fromEntries(Object.entries(parts).map(([path, part]) => [path, JSON.parse(Buffer.from(part).toString('utf8'))])));
    } else extraction = e.coerceTokensDoc(JSON.parse(bytes.toString('utf8')));
    if (extraction) {
      if (!extraction.doc) throw new Error(extraction.warnings.join(' ') || 'no token document was found');
      colours = e.partnerKitColoursFromTokens(extraction.doc);
      warnings.push(...extraction.warnings);
    }
  }
  if (!colours.length && !warnings.length) warnings.push('No colours could be proposed from this source.');
  return { kit: { schemaVersion: 1, id: company.id, label: company.name, logos, colours, source: { kind, reference } }, warnings };
}

/** Company deletion removes the kit and every version of its bytes. */
export async function deleteKitAsset(store: Store, blobs: BlobStore, id: string): Promise<void> {
  const rec = await store.getInstanceAsset(id);
  const ids = new Set(Object.values(rec?.blobs ?? {}));
  for (const row of await store.listAssetVersions(id)) {
    for (const format of row.formats) ids.add(format.blobId);
    await store.deleteAssetVersion(id, row.version);
  }
  for (const blobId of ids) await blobs.delete(blobId);
  await store.deleteCredential(id);
  await store.deleteLifecycle(id);
  await store.deleteInstanceAsset(id);
}
