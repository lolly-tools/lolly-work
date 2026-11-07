/**
 * Google Drive driver (plans/17 §11 phase 4) - Drive v3, refresh-token OAuth
 * (oauth.ts; scope drive.readonly). Read-only: files.list scoped to a folder,
 * name-contains search, alt=media streaming downloads (expiringUrls semantics
 * - Google download URLs are auth-bound, nothing upstream persists).
 *
 * By default it federates ONE folder (options.folderId), non-recursive - Drive
 * has no cheap recursive listing, and a flat curated folder is the honest
 * first cut. `recursive: true` walks the subfolders too, breadth first, to
 * `maxDepth` levels and at most `maxFolders` folders, so partner folder rules
 * (plans/82 M1 part 2c) can give one subfolder to one programme. Each file
 * reports the folder path it sits in.
 * remoteId is the Drive file id (slash-free, rename-stable). Native Google
 * Docs/Sheets need an export conversion - out of scope, filtered out.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface GdriveOptions {
  /** The federated folder's id (from its Drive URL). */
  folderId: string;
  /** Walk subfolders too. Default false: the one folder, as before. */
  recursive?: boolean;
  /** Levels below the federated folder to walk when recursive (default 4, at most 10). */
  maxDepth?: number;
  /** Folders to walk at most when recursive (default 500, at most 5000). */
  maxFolders?: number;
}

/** Where a recursive walk is: the folders still to list, and a page token
 *  for the first of them. Carried in the listing cursor. */
interface WalkState { q: Array<{ id: string; path: string; depth: number }>; t?: string; seen: number }
const encodeWalk = (w: WalkState): string => `walk:${Buffer.from(JSON.stringify(w)).toString('base64url')}`;
function decodeWalk(cursor: string | undefined, rootId: string): WalkState {
  if (cursor?.startsWith('walk:')) {
    try {
      const w = JSON.parse(Buffer.from(cursor.slice(5), 'base64url').toString()) as WalkState;
      if (Array.isArray(w.q) && w.q.every((f) => typeof f?.id === 'string' && typeof f.path === 'string' && typeof f.depth === 'number')) return w;
    } catch { /* a cursor we did not write starts over */ }
  }
  return { q: [{ id: rootId, path: '', depth: 0 }], seen: 1 };
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
    const res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${await token()}` }, redirect: 'error' });
    if (!res.ok) throw new Error(`gdrive api ${res.status}`);
    return (await res.json()) as T;
  };

  const toAsset = (f: DriveFile, folder = ''): ProviderAssetRef | null => {
    if (f.mimeType === 'application/vnd.google-apps.folder') return null;
    if (f.mimeType.startsWith('application/vnd.google-apps.')) return null; // native Docs need export conversion - not v1
    const ext = f.fileExtension?.toLowerCase() ?? extOf(f.name);
    return {
      remoteId: f.id,
      name: stripExt(f.name),
      nativeType: ext,
      sections: folder ? [folder.split('/')[0] as string] : [],
      folder,
      tags: [],
      ...(f.modifiedTime ? { updatedAt: f.modifiedTime } : {}),
      formats: [{ format: ext, remoteRef: 'media', filename: f.name, ...(f.size ? { size: Number(f.size) } : {}) }],
    };
  };

  const listQuery = (extra: string, pageToken?: string, folderId = options.folderId): string => {
    const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false${extra}`;
    const p = new URLSearchParams({ q, fields: FIELDS, pageSize: String(PAGE), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    return `/files?${p}`;
  };

  return {
    id,
    kind: 'gdrive',
    capabilities: { authKind: 'oauth', search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      if (options.recursive) {
        const maxDepth = Math.min(Math.max(1, Math.floor(options.maxDepth ?? 4)), 10);
        const maxFolders = Math.min(Math.max(1, Math.floor(options.maxFolders ?? 500)), 5000);
        const walk = decodeWalk(cursor, options.folderId);
        const here = walk.q[0];
        if (!here) return { assets: [] };
        if (!/^[A-Za-z0-9_-]+$/.test(here.id)) throw new Error('bad drive folder id');
        const doc = await api<{ files: DriveFile[]; nextPageToken?: string }>(listQuery('', walk.t, here.id));
        const files = doc.files ?? [];
        let capped = false;
        for (const f of files) {
          if (f.mimeType !== 'application/vnd.google-apps.folder' || here.depth >= maxDepth) continue;
          if (walk.seen >= maxFolders) { capped = true; continue; }
          walk.q.push({ id: f.id, path: here.path ? `${here.path}/${f.name}` : f.name, depth: here.depth + 1 });
          walk.seen += 1;
        }
        const assets = files.map((f) => toAsset(f, here.path)).filter((a): a is ProviderAssetRef => a !== null);
        const native = files.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder' && f.mimeType.startsWith('application/vnd.google-apps.')).length;
        const next: WalkState = doc.nextPageToken ? { ...walk, t: doc.nextPageToken } : { q: walk.q.slice(1), seen: walk.seen };
        const notes = [
          ...(native ? ['Native Google documents are skipped; only ordinary files are exposed.'] : []),
          ...(capped ? [`The walk stopped adding folders at ${maxFolders}; raise maxFolders to reach the rest.`] : []),
        ];
        return {
          assets,
          ...(native ? { skipped: native } : {}),
          ...(notes.length ? { notes } : {}),
          ...(next.q.length ? { next: encodeWalk(next) } : {}),
        };
      }
      const doc = await api<{ files: DriveFile[]; nextPageToken?: string }>(listQuery('', cursor));
      const assets = (doc.files ?? []).map((f) => toAsset(f)).filter((a): a is ProviderAssetRef => a !== null);
      const skipped = (doc.files ?? []).length - assets.length;
      return {
        assets,
        ...(skipped ? { skipped, notes: ['Subfolders and native Google documents are skipped; only ordinary files in this folder are exposed.'] } : {}),
        ...(doc.nextPageToken ? { next: doc.nextPageToken } : {}),
      };
    },

    async searchAssets(query, limit) {
      const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const doc = await api<{ files: DriveFile[] }>(listQuery(` and name contains '${escaped}'`));
      return doc.files.map((f) => toAsset(f)).filter((a): a is ProviderAssetRef => a !== null).slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'media') throw new Error('gdrive assets have a single media format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad drive file id');
      const res = await fetchImpl(`${API}/files/${remoteId}?alt=media&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${await token()}` },
        redirect: 'error',
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
