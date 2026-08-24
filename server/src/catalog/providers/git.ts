/**
 * Git repo driver (plans/17 §11 phase 2) - a third-party repo as a catalog
 * source, over the forge's raw-file HTTP endpoint (GitHub raw, GitLab
 * /raw/, Gitea) rather than a clone: zero-dep, works air-gapped against an
 * internal forge, and never needs a writable cache dir.
 *
 * The repo declares what it exports in a manifest (default lolly-catalog.json
 * at the raw base). Only manifest-listed paths are ever fetched - the manifest
 * is the contract, and resolveBlob refuses paths outside it, so a poisoned
 * remoteId can't turn this into a repo-wide file reader.
 *
 *   { "assets": [ { "path": "logos/summit.svg", "name": "Summit Logo",
 *                   "type": "vector", "sections": ["Logos"], "tags": ["event"] } ] }
 *
 * Credential (optional, for private repos) is sent as `Authorization: Bearer`
 * by default; forges wanting a custom header name it via options.authHeader
 * (e.g. GitLab's "PRIVATE-TOKEN").
 */
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface GitOptions {
  /** Raw-content base, e.g. "https://raw.githubusercontent.com/org/repo/main". */
  rawBase: string;
  manifestPath?: string; // default lolly-catalog.json
  authHeader?: string;   // default Authorization: Bearer <secret>
}

interface GitManifestAsset {
  path: string;
  name?: string;
  type?: string;
  sections?: string[];
  tags?: string[];
}

const MIME: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', pdf: 'application/pdf', json: 'application/json', woff2: 'font/woff2', md: 'text/markdown',
};

const pathToRemoteId = (p: string): string => Buffer.from(p, 'utf8').toString('base64url');
const remoteIdToPath = (id: string): string => Buffer.from(id, 'base64url').toString('utf8');

export function createGitProvider(
  id: string,
  options: GitOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const base = options.rawBase.replace(/\/+$/, '');
  const baseHost = new URL(base).host;
  const authHeaders = (): Record<string, string> => {
    if (!secret) return {};
    return options.authHeader ? { [options.authHeader]: secret } : { authorization: `Bearer ${secret}` };
  };

  const raw = async (path: string): Promise<Response> => {
    const url = `${base}/${path.split('/').map(encodeURIComponent).join('/')}`;
    if (new URL(url).host !== baseHost) throw new Error('git path escapes the configured raw base');
    const res = await fetchImpl(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`git raw fetch ${res.status} for ${path}`);
    return res;
  };

  const loadManifest = async (): Promise<GitManifestAsset[]> => {
    const res = await raw(options.manifestPath ?? 'lolly-catalog.json');
    const doc = (await res.json()) as { assets?: GitManifestAsset[] };
    if (!Array.isArray(doc.assets)) throw new Error('manifest has no assets array');
    return doc.assets.filter((a) => typeof a?.path === 'string' && !a.path.includes('..'));
  };

  const toAsset = (m: GitManifestAsset): ProviderAssetRef => {
    const filename = m.path.split('/').pop() as string;
    const ext = extOf(filename);
    return {
      remoteId: pathToRemoteId(m.path),
      name: m.name ?? stripExt(filename),
      nativeType: m.type ?? ext,
      sections: m.sections ?? [],
      tags: m.tags ?? [],
      formats: [{ format: ext, remoteRef: 'file', filename }],
    };
  };

  return {
    id,
    kind: 'git',
    capabilities: { authKind: 'credential', search: false, thumbnails: false, expiringUrls: false },

    async listAssets() {
      return { assets: (await loadManifest()).map(toAsset) };
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'file') throw new Error('git assets have a single file format');
      const path = remoteIdToPath(remoteId);
      // The manifest is the allowlist - an id for an unlisted path is refused.
      const listed = (await loadManifest()).some((a) => a.path === path);
      if (!listed) throw new Error('path not in the repo manifest');
      const res = await raw(path);
      const ext = extOf(path, '');
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type')?.split(';')[0] === 'text/plain'
          ? (MIME[ext] ?? 'text/plain') // raw endpoints often say text/plain for everything
          : (res.headers.get('content-type') ?? MIME[ext] ?? 'application/octet-stream'),
      };
    },

    async healthCheck() {
      try {
        await loadManifest();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
