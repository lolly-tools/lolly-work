/**
 * Penpot driver (plans/30) — an OPEN, self-hostable design tool as a design-system
 * SOURCE, not a DAM.
 *
 * TWO asset classes, deliberately handled differently (plans/30 §0, §3.1):
 *  - TOKENS auto-federate. `listAssets` emits one `type:'tokens'` asset per file
 *    (DTCG JSON), so the console /design view and brand-profile themes inherit from
 *    Penpot — the console already parses DTCG, `$themes` included.
 *  - MEDIA is search-and-import, NEVER auto-federated. `listAssets` never returns a
 *    board; boards surface only through `searchAssets` (the "Browse Penpot" panel),
 *    and a curator imports the ones worth keeping via the /import route, which snapshots
 *    the exporter-rendered bytes into an owned inst/* asset. Penpot stays the sandbox;
 *    only curated boards take on catalog rigor.
 *
 * Penpot exposes an RPC API: POST {baseUrl}/api/rpc/command/<cmd>, authed with a
 * personal access token as `Authorization: Token <token>` (a self-hosted instance
 * needs the `access-tokens` flag in PENPOT_FLAGS). Board rendering goes through the
 * exporter path (POST {exporterUrl|baseUrl}/api/export). No OAuth, no SDK — a single
 * sealed token. Self-hosted means there is no fixed vendor host: every call is pinned
 * to the operator-configured origin.
 *
 * Token TYPING: the driver stamps `nativeType:'tokens'` (tokens) and `'board'` (media);
 * the record's `mapping.typeMap` turns those into catalog `tokens` / `image` — the
 * console card ships `{ typeMap: { tokens:'tokens', board:'image' }, defaultType:'image' }`.
 *
 * LIVE-VERIFY before ship (house rule, plans/30 §10): confirm the RPC command names
 * (get-teams / get-projects / get-project-files / get-file / get-profile), the RPC
 * param casing, the get-file token + page/board structure (marked below), and the
 * /api/export request/response shape, against a real self-hosted instance. Fixture-
 * tested with injected fetch — no live instance is touched by building or testing.
 */
import type { CatalogProvider, ProviderAssetRef, ProviderFormatRef, ResolvedBlob } from './types.ts';

export interface PenpotOptions {
  /** Self-hosted Penpot instance origin, e.g. "https://design.your-host.example". */
  baseUrl: string;
  /** Scope discovery to one team (else every team the token can see). */
  teamId?: string;
  /** Scope discovery to one project (else every project in scope). */
  projectId?: string;
  /** Federate tokens from exactly these file ids (skips team/project discovery). */
  fileIds?: string[];
  /** Board render format for search-and-import media (default 'png'). */
  format?: 'png' | 'svg' | 'jpeg' | 'webp';
  /** Bitmap render scale (default 1). */
  scale?: number;
  /** Exporter origin if it is not the same as baseUrl (default: baseUrl). */
  exporterUrl?: string;
}

/** Files scanned per sync/search — a runaway instance can't wedge a request cycle. */
const FILE_CAP = 200;
const UUID_RE = /^[A-Za-z0-9-]+$/;
/** Every Penpot page carries a synthetic root frame (the nil UUID) — not a board. */
const ROOT_FRAME_ID = '00000000-0000-0000-0000-000000000000';

interface PenpotTeam { id: string; name?: string }
interface PenpotProject { id: string; name?: string }
interface PenpotFileSummary { id: string; name?: string; modifiedAt?: string; projectName?: string }

// get-file token payload (LIVE-VERIFY the path + field names). Penpot organises
// tokens as sets (+ themes); we accept both a keyed map and an array shape so a
// small upstream shape drift doesn't break the mapping.
interface PenpotToken { name?: string; type?: string; value?: unknown; description?: string }
interface PenpotTokenSet { name?: string; tokens?: Record<string, PenpotToken> | PenpotToken[] }
interface PenpotTokensLib { sets?: Record<string, PenpotTokenSet> | PenpotTokenSet[]; themes?: unknown }
// get-file page/board payload (LIVE-VERIFY). A board is an object with type 'frame'.
interface PenpotObject { id?: string; name?: string; type?: string; exports?: unknown[] }
interface PenpotPage { id?: string; name?: string; objects?: Record<string, PenpotObject> }
interface PenpotFile {
  id: string;
  name?: string;
  data?: { tokensLib?: PenpotTokensLib; pagesIndex?: Record<string, PenpotPage> };
  tokensLib?: PenpotTokensLib;
}

/** One Penpot token set → a DTCG group tree. Penpot token names use dot notation
 *  (e.g. "color.brand.500"), which becomes nested DTCG groups; each leaf is a
 *  `{ $value, $type, $description }` node. */
function setToDtcg(tokens: PenpotToken[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const tok of tokens) {
    if (!tok.name) continue;
    const path = tok.name.split('.');
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    node[path[path.length - 1] as string] = {
      $value: tok.value,
      ...(tok.type ? { $type: tok.type } : {}),
      ...(tok.description ? { $description: tok.description } : {}),
    };
  }
  return root;
}

function tokensOf(set: PenpotTokenSet): PenpotToken[] {
  const t = set.tokens;
  if (!t) return [];
  return Array.isArray(t) ? t : Object.entries(t).map(([name, tok]) => ({ name, ...tok }));
}

function setsOf(lib: PenpotTokensLib | undefined): Array<{ name: string; tokens: PenpotToken[] }> {
  if (!lib?.sets) return [];
  const entries = Array.isArray(lib.sets)
    ? lib.sets.map((s, i) => [s.name ?? `set-${i}`, s] as const)
    : Object.entries(lib.sets).map(([name, s]) => [s.name ?? name, s] as const);
  return entries.map(([name, s]) => ({ name, tokens: tokensOf(s) }));
}

/** Penpot tokensLib → the DTCG single-JSON export shape the console already parses
 *  (`flattenTokenSet` / `buildThemeMaps`): one group tree per set, `$metadata` set
 *  order, and `$themes` passed through when present. */
export function tokensLibToDtcg(lib: PenpotTokensLib | undefined): string {
  const sets = setsOf(lib);
  const out: Record<string, unknown> = {};
  for (const s of sets) out[s.name] = setToDtcg(s.tokens);
  if (sets.length) out.$metadata = { tokenSetOrder: sets.map((s) => s.name) };
  if (lib?.themes !== undefined) out.$themes = lib.themes;
  return JSON.stringify(out, null, 2);
}

/** Composite media id: `<fileId>_<pageId>_<objectId>` (all UUIDs — hex + dashes, no
 *  underscores, so the separator is unambiguous). Tokens keep a plain file id. */
function boardId(fileId: string, pageId: string, objectId: string): string {
  return `${fileId}_${pageId}_${objectId}`;
}
function parseBoardId(remoteId: string): { fileId: string; pageId: string; objectId: string } | null {
  const parts = remoteId.split('_');
  if (parts.length !== 3 || !parts.every((p) => UUID_RE.test(p))) return null;
  return { fileId: parts[0] as string, pageId: parts[1] as string, objectId: parts[2] as string };
}

export function createPenpotProvider(
  id: string,
  options: PenpotOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const base = options.baseUrl?.replace(/\/$/, '');
  const exporterBase = (options.exporterUrl ?? options.baseUrl)?.replace(/\/$/, '');
  const fmt = options.format ?? 'png';
  const scale = options.scale ?? 1;

  const rpc = async <T>(command: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!secret) throw new Error('penpot provider has no credential');
    if (!base) throw new Error('penpot provider needs options.baseUrl');
    // Every call goes to the operator-configured instance origin — no other host.
    const res = await fetchImpl(`${base}/api/rpc/command/${command}`, {
      method: 'POST',
      headers: { authorization: `Token ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`penpot rpc ${command} ${res.status}`);
    return (await res.json()) as T;
  };

  // The files whose tokens we federate: an explicit id list, or discovery across
  // teams → projects → files (LIVE-VERIFY the command + param names).
  const listFiles = async (): Promise<PenpotFileSummary[]> => {
    if (options.fileIds?.length) return options.fileIds.slice(0, FILE_CAP).map((fid) => ({ id: fid }));
    let projects: PenpotProject[] = [];
    if (options.teamId) {
      projects = await rpc<PenpotProject[]>('get-projects', { 'team-id': options.teamId });
    } else {
      const teams = await rpc<PenpotTeam[]>('get-teams');
      for (const t of teams) projects.push(...(await rpc<PenpotProject[]>('get-projects', { 'team-id': t.id })));
    }
    const scoped = options.projectId ? projects.filter((p) => p.id === options.projectId) : projects;
    const files: PenpotFileSummary[] = [];
    for (const p of scoped) {
      if (files.length >= FILE_CAP) break;
      const batch = await rpc<PenpotFileSummary[]>('get-project-files', { 'project-id': p.id });
      for (const f of batch) files.push({ ...f, ...(p.name ? { projectName: p.name } : {}) });
    }
    return files.slice(0, FILE_CAP);
  };

  const toTokenAsset = (f: PenpotFileSummary): ProviderAssetRef => ({
    remoteId: f.id,
    name: f.name ?? f.id,
    nativeType: 'tokens',
    sections: f.projectName ? [f.projectName] : [],
    tags: ['penpot', 'design-tokens'],
    ...(f.modifiedAt ? { updatedAt: f.modifiedAt } : {}),
    formats: [{ format: 'json', remoteRef: 'tokens', filename: `${f.name ?? f.id}.tokens.json` }],
  });

  const toBoardAsset = (fileId: string, fileName: string | undefined, pageId: string, obj: PenpotObject): ProviderAssetRef => {
    const name = obj.name ?? 'Board';
    return {
      remoteId: boardId(fileId, pageId, obj.id as string),
      name,
      nativeType: 'board',
      sections: fileName ? [fileName] : [],
      tags: ['penpot', 'board'],
      formats: [{ format: fmt, remoteRef: 'render', filename: `${name}.${fmt}` }],
      hasThumbnail: true,
    };
  };

  /** Top-level boards (frames) in a file — the designer's export-worthy units. */
  const boardsOf = (file: PenpotFile): ProviderAssetRef[] => {
    const pages = file.data?.pagesIndex ?? {};
    const out: ProviderAssetRef[] = [];
    for (const [pageId, page] of Object.entries(pages)) {
      for (const obj of Object.values(page.objects ?? {})) {
        if (obj.type === 'frame' && obj.id && obj.id !== ROOT_FRAME_ID) out.push(toBoardAsset(file.id, file.name, pageId, obj));
      }
    }
    return out;
  };

  // The exporter renders one board; with wait=true it either returns the bytes
  // directly, or a JSON descriptor with an id we then download (LIVE-VERIFY which).
  const renderBoard = async (fileId: string, pageId: string, objectId: string, type: string, atScale: number): Promise<ResolvedBlob> => {
    if (!exporterBase) throw new Error('penpot provider needs options.baseUrl');
    const post = await fetchImpl(`${exporterBase}/api/export`, {
      method: 'POST',
      headers: { authorization: `Token ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cmd: 'export-shapes', wait: true, exports: [{ 'file-id': fileId, 'page-id': pageId, 'object-id': objectId, type, scale: atScale, suffix: '' }] }),
    });
    if (!post.ok || !post.body) throw new Error(`penpot export ${post.status}`);
    const ct = post.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const doc = (await post.json()) as { id?: string; path?: string };
      const ref = doc.id ?? doc.path;
      if (!ref) throw new Error('penpot export returned no resource id');
      const dl = await fetchImpl(`${exporterBase}/api/export?id=${encodeURIComponent(ref)}`, { headers: { authorization: `Token ${secret}` } });
      if (!dl.ok || !dl.body) throw new Error(`penpot export download ${dl.status}`);
      return { kind: 'stream', body: dl.body as ReadableStream<Uint8Array>, contentType: dl.headers.get('content-type') ?? 'application/octet-stream' };
    }
    return { kind: 'stream', body: post.body as ReadableStream<Uint8Array>, contentType: ct || 'application/octet-stream' };
  };

  return {
    id,
    kind: 'penpot',
    // Tokens auto-federate (listAssets); boards are search-and-import only.
    capabilities: { search: true, thumbnails: true, expiringUrls: false },

    // Auto-federated feed: TOKENS ONLY. Boards never enter here (plans/30 §3.1).
    async listAssets() {
      return { assets: (await listFiles()).map(toTokenAsset) };
    },

    // Browse: match files by name, surface their boards for the curator to import.
    async searchAssets(query, limit) {
      const q = query.toLowerCase();
      const files = (await listFiles()).filter((f) => (f.name ?? f.id).toLowerCase().includes(q));
      const out: ProviderAssetRef[] = [];
      for (const f of files) {
        if (out.length >= limit) break;
        const file = await rpc<PenpotFile>('get-file', { id: f.id });
        out.push(...boardsOf({ ...file, id: f.id, name: file.name ?? f.name }));
      }
      return out.slice(0, limit);
    },

    // Single-asset fetch for /import: a composite id is a board, a plain id a token file.
    async getAsset(remoteId) {
      const board = parseBoardId(remoteId);
      if (board) {
        const file = await rpc<PenpotFile>('get-file', { id: board.fileId });
        const obj = file.data?.pagesIndex?.[board.pageId]?.objects?.[board.objectId];
        if (!obj || obj.type !== 'frame') return null;
        return toBoardAsset(board.fileId, file.name, board.pageId, { ...obj, id: board.objectId });
      }
      if (!UUID_RE.test(remoteId)) return null;
      const file = await rpc<PenpotFile>('get-file', { id: remoteId });
      return toTokenAsset({ id: remoteId, ...(file.name ? { name: file.name } : {}) });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef === 'tokens') {
        if (!UUID_RE.test(remoteId)) throw new Error('bad penpot file id');
        const file = await rpc<PenpotFile>('get-file', { id: remoteId });
        const json = tokensLibToDtcg(file.data?.tokensLib ?? file.tokensLib);
        const bytes = new TextEncoder().encode(json);
        return { kind: 'stream', body: new Response(bytes).body as ReadableStream<Uint8Array>, contentType: 'application/json', size: bytes.byteLength };
      }
      if (formatRef === 'render' || formatRef === 'thumb') {
        const board = parseBoardId(remoteId);
        if (!board) throw new Error('bad penpot board id');
        return renderBoard(board.fileId, board.pageId, board.objectId, formatRef === 'thumb' ? 'png' : fmt, formatRef === 'thumb' ? 0.25 : scale);
      }
      throw new Error('penpot: unsupported format');
    },

    async healthCheck() {
      try {
        await rpc('get-profile');
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
