/**
 * O365 / SharePoint driver (plans/17 §11 phase 4) - Microsoft Graph v1.0,
 * refresh-token OAuth (oauth.ts; Files.Read.All + offline_access). Read-only
 * against one drive (a SharePoint document library or OneDrive), optionally
 * scoped to a folder path. Graph's @microsoft.graph.downloadUrl is
 * pre-authenticated and SHORT-LIVED - expiringUrls semantics, so /content is
 * fetched per request and streamed; nothing upstream persists.
 *
 * remoteId is the Graph item id (slash-free, rename-stable). Pagination
 * cursors are Graph @odata.nextLink URLs - host-pinned before reuse so a
 * poisoned cursor can't point the driver elsewhere.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface O365Options {
  /** Graph drive id (SharePoint library / OneDrive). */
  driveId: string;
  /** AAD tenant (id or domain); 'common' only for multi-tenant apps. */
  tenant?: string;
  /** Folder path under the drive root, e.g. "Brand/Approved". */
  itemPath?: string;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_HOST = 'graph.microsoft.com';
const SELECT = '$select=id,name,size,lastModifiedDateTime,file,folder,parentReference';
const PAGE = 200;

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  parentReference?: { path?: string };
}

export function createO365Provider(
  id: string,
  options: O365Options,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(options.tenant ?? 'common')}/oauth2/v2.0/token`;
  const token = (): Promise<string> =>
    getAccessToken({
      providerId: id, cred: parseOAuthCredential(secret), tokenUrl, fetchImpl,
      extraParams: { scope: 'https://graph.microsoft.com/Files.Read.All offline_access' },
    });

  const api = async <T>(url: string): Promise<T> => {
    if (new URL(url).host !== GRAPH_HOST) throw new Error('graph url outside graph.microsoft.com');
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await token()}` } });
    if (!res.ok) throw new Error(`graph api ${res.status}`);
    return (await res.json()) as T;
  };

  const rootUrl = options.itemPath
    ? `${GRAPH}/drives/${options.driveId}/root:/${options.itemPath.split('/').map(encodeURIComponent).join('/')}:/children`
    : `${GRAPH}/drives/${options.driveId}/root/children`;

  const toAsset = (item: DriveItem): ProviderAssetRef | null => {
    if (item.folder || !item.file) return null;
    const ext = extOf(item.name);
    // Section: last folder name in the parent path (after the drive root marker).
    const parentPath = item.parentReference?.path?.split('/root:/')[1];
    const section = parentPath?.split('/').pop();
    return {
      remoteId: item.id,
      name: stripExt(item.name),
      nativeType: ext,
      sections: section ? [decodeURIComponent(section)] : [],
      tags: [],
      ...(item.lastModifiedDateTime ? { updatedAt: item.lastModifiedDateTime } : {}),
      formats: [{ format: ext, remoteRef: 'content', filename: item.name, ...(item.size !== undefined ? { size: item.size } : {}) }],
    };
  };

  const mapPage = (doc: { value: DriveItem[]; '@odata.nextLink'?: string }) => ({
    assets: doc.value.map(toAsset).filter((a): a is ProviderAssetRef => a !== null),
    ...(doc['@odata.nextLink'] ? { next: doc['@odata.nextLink'] } : {}),
  });

  return {
    id,
    kind: 'o365',
    capabilities: { search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      // Cursor IS the @odata.nextLink; api() host-pins it before use.
      const url = cursor ?? `${rootUrl}?${SELECT}&$top=${PAGE}`;
      return mapPage(await api(url));
    },

    async searchAssets(query, limit) {
      const q = encodeURIComponent(query.replace(/'/g, "''"));
      const url = `${GRAPH}/drives/${options.driveId}/root/search(q='${q}')?${SELECT}&$top=${limit}`;
      return (await mapPage(await api(url))).assets.slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'content') throw new Error('o365 assets have a single content format');
      if (!/^[A-Za-z0-9!_.-]+$/.test(remoteId)) throw new Error('bad graph item id');
      // /content 302s to a pre-authenticated, short-lived download URL; fetch
      // follows it and we stream the bytes straight through.
      const res = await fetchImpl(`${GRAPH}/drives/${options.driveId}/items/${remoteId}/content`, {
        headers: { authorization: `Bearer ${await token()}` },
      });
      if (!res.ok || !res.body) throw new Error(`graph download ${res.status}`);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(res.headers.get('content-length') ? { size: Number(res.headers.get('content-length')) } : {}),
      };
    },

    async healthCheck() {
      try {
        await api(`${GRAPH}/drives/${options.driveId}?$select=id`);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
