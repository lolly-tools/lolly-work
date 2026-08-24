/**
 * Dropbox driver (plans/17 §11 phase 4) - public v2 API, refresh-token OAuth
 * (oauth.ts). Read-only: list_folder (+continue), search_v2, files/download.
 * Downloads stream through /catalog/ext/* - Dropbox links are short-lived, so
 * expiringUrls semantics apply and nothing upstream is persisted.
 *
 * remoteId is Dropbox's own file id ("id:…" - slash-free, rename-stable),
 * so a moved/renamed file keeps its lolly identity and lifecycle rows.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface DropboxOptions {
  /** Folder to federate, e.g. "/Brand Assets"; default the app folder root. */
  path?: string;
}

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const PAGE = 500;

interface DbxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

export function createDropboxProvider(
  id: string,
  options: DropboxOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const root = options.path ? options.path.replace(/\/+$/, '') : '';

  const token = (): Promise<string> =>
    getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl: TOKEN_URL, fetchImpl });

  const rpc = async <T>(url: string, body: unknown): Promise<T> => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`dropbox api ${res.status}`);
    return (await res.json()) as T;
  };

  const toAsset = (e: DbxEntry): ProviderAssetRef | null => {
    if (e['.tag'] !== 'file' || !e.id) return null;
    const ext = extOf(e.name);
    // Section: first folder under the federated root.
    const rel = e.path_display?.startsWith(root) ? e.path_display.slice(root.length).replace(/^\//, '') : e.name;
    const parts = rel.split('/');
    return {
      remoteId: e.id, // "id:…" — slash-free, survives rename/move
      name: stripExt(e.name),
      nativeType: ext,
      sections: parts.length > 1 ? [parts[0] as string] : [],
      tags: [],
      ...(e.server_modified ? { updatedAt: e.server_modified } : {}),
      formats: [{ format: ext, remoteRef: 'file', filename: e.name, ...(e.size !== undefined ? { size: e.size } : {}) }],
    };
  };

  return {
    id,
    kind: 'dropbox',
    capabilities: { authKind: 'oauth', search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const doc = cursor
        ? await rpc<{ entries: DbxEntry[]; cursor: string; has_more: boolean }>(`${API}/files/list_folder/continue`, { cursor })
        : await rpc<{ entries: DbxEntry[]; cursor: string; has_more: boolean }>(`${API}/files/list_folder`, {
            path: root, recursive: true, limit: PAGE, include_deleted: false,
          });
      return {
        assets: doc.entries.map(toAsset).filter((a): a is ProviderAssetRef => a !== null),
        ...(doc.has_more ? { next: doc.cursor } : {}),
      };
    },

    async searchAssets(query, limit) {
      const doc = await rpc<{ matches: Array<{ metadata: { metadata: DbxEntry } }> }>(`${API}/files/search_v2`, {
        query, options: { max_results: limit, ...(root ? { path: root } : {}), file_status: 'active', filename_only: true },
      });
      return doc.matches.map((m) => toAsset(m.metadata.metadata)).filter((a): a is ProviderAssetRef => a !== null);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'file') throw new Error('dropbox assets have a single file format');
      const res = await fetchImpl(`${CONTENT}/files/download`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          'dropbox-api-arg': JSON.stringify({ path: remoteId }),
        },
      });
      if (!res.ok || !res.body) throw new Error(`dropbox download ${res.status}`);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(res.headers.get('content-length') ? { size: Number(res.headers.get('content-length')) } : {}),
      };
    },

    async healthCheck() {
      try {
        await rpc(`${API}/users/get_current_account`, null);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
