/**
 * Google Drive driver (plans/17 §11 phase 4) - Drive v3, refresh-token OAuth
 * (oauth.ts; scope drive.readonly). Read-only: files.list scoped to a folder,
 * name-contains search, alt=media streaming downloads (expiringUrls semantics
 * - Google download URLs are auth-bound, nothing upstream persists).
 *
 * v1 federates ONE folder (options.folderId), non-recursive - Drive has no
 * cheap recursive listing, and a flat curated folder is the honest first cut.
 * remoteId is the Drive file id (slash-free, rename-stable). Native Google
 * Docs/Sheets need an export conversion - out of scope, filtered out.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface GdriveOptions {
  /** The federated folder's id (from its Drive URL). */
  folderId: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,fileExtension)';
const PAGE = 1000;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  fileExtension?: string;
}

export function createGdriveProvider(
  id: string,
  options: GdriveOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const token = (): Promise<string> =>
    getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl: TOKEN_URL, fetchImpl });

  const api = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${await token()}` } });
    if (!res.ok) throw new Error(`gdrive api ${res.status}`);
    return (await res.json()) as T;
  };

  const toAsset = (f: DriveFile): ProviderAssetRef | null => {
    if (f.mimeType === 'application/vnd.google-apps.folder') return null;
    if (f.mimeType.startsWith('application/vnd.google-apps.')) return null; // native Docs need export conversion - not v1
    const ext = f.fileExtension?.toLowerCase() ?? extOf(f.name);
    return {
      remoteId: f.id,
      name: stripExt(f.name),
      nativeType: ext,
      sections: [],
      tags: [],
      ...(f.modifiedTime ? { updatedAt: f.modifiedTime } : {}),
      formats: [{ format: ext, remoteRef: 'media', filename: f.name, ...(f.size ? { size: Number(f.size) } : {}) }],
    };
  };

  const listQuery = (extra: string, pageToken?: string): string => {
    const q = `'${options.folderId.replace(/'/g, "\\'")}' in parents and trashed=false${extra}`;
    const p = new URLSearchParams({ q, fields: FIELDS, pageSize: String(PAGE) });
    if (pageToken) p.set('pageToken', pageToken);
    return `/files?${p}`;
  };

  return {
    id,
    kind: 'gdrive',
    capabilities: { search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const doc = await api<{ files: DriveFile[]; nextPageToken?: string }>(listQuery('', cursor));
      return {
        assets: doc.files.map(toAsset).filter((a): a is ProviderAssetRef => a !== null),
        ...(doc.nextPageToken ? { next: doc.nextPageToken } : {}),
      };
    },

    async searchAssets(query, limit) {
      const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const doc = await api<{ files: DriveFile[] }>(listQuery(` and name contains '${escaped}'`));
      return doc.files.map(toAsset).filter((a): a is ProviderAssetRef => a !== null).slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'media') throw new Error('gdrive assets have a single media format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad drive file id');
      const res = await fetchImpl(`${API}/files/${remoteId}?alt=media`, {
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (!res.ok || !res.body) throw new Error(`gdrive download ${res.status}`);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(res.headers.get('content-length') ? { size: Number(res.headers.get('content-length')) } : {}),
      };
    },

    async healthCheck() {
      try {
        await api('/about?fields=user');
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
