/**
 * Narrow local type shims + lazy loaders for the render plane's sibling deps.
 *
 * Why shims rather than importing the real types from `@lolly/engine` /
 * `@lolly-tools/core`: those packages resolve to `.ts` SOURCE (a `file:` link to
 * the sibling OSS monorepo), and that source references DOM + WebCrypto globals
 * this project's tsconfig deliberately does NOT include (`lib: ["ES2023"]`,
 * `types: ["node"]`). Pulling it into the program would spray ~60 phantom errors
 * from code we don't own and can't edit. Per the build's house rule we prefer
 * narrow local shims over loosening tsconfig.
 *
 * Runtime correctness of these shapes is verified by tests/render.test.ts, which
 * renders through the REAL engine - so a shim that drifts from the contract is
 * caught as a test failure, not a silent type lie.
 *
 * The specifiers are `string`-typed on purpose: a non-literal specifier stops tsc
 * from resolving (and type-checking) the sibling `.ts` source, while the runtime
 * import resolves normally. jsdom + the engine are heavy, so both load lazily.
 *
 * The engine + core are VENDORED under `vendor/` (a pinned, checksum-verified
 * snapshot from the OSS repo's `scripts/pack-engine.ts`) and consumed via
 * `file:vendor/…` dir deps - npm symlinks them, so the realpath sits outside
 * node_modules and Node's TS type-stripping runs. This makes the control plane
 * self-contained (no sibling repo → CI/Vercel/air-gap all work) and enforces
 * the MPL "consumed unmodified" line: `scripts/verify-engine-pin.ts` (pretest +
 * CI) fails on any drift. See engine-pin.json.
 */

// ── HostV1 subset the render plane implements (see @lolly-tools/core host-v1) ──

export interface Profile {
  firstname?: string;
  lastname?: string;
  email?: string;
  title?: string;
  useDetails?: boolean;
  [k: string]: unknown;
}

export interface AssetRef {
  source: 'library' | 'user' | 'remote';
  id: string;
  type: 'vector' | 'raster' | 'video' | 'audio' | 'lottie' | 'palette' | 'tokens' | 'font';
  format: string;
  url: string;
  width?: number;
  height?: number;
  version?: string;
  checksum?: string;
  meta?: Record<string, unknown>;
}

export interface AssetQuery {
  type?: AssetRef['type'];
  namespace?: string;
  tags?: string[];
  includeDeprecated?: boolean;
}

export interface AssetsAPI {
  get(id: string, opts?: { format?: string; version?: string }): Promise<AssetRef>;
  query(filter?: AssetQuery): Promise<AssetRef[]>;
  pick(opts?: unknown): Promise<AssetRef | null>;
  isAvailable(id: string): Promise<boolean>;
}

export interface StateEntry {
  slot: string;
  toolId?: string;
  toolVersion?: string;
  updatedAt?: string;
  label?: string;
}

export interface ExportOpts {
  width?: number | string;
  height?: number | string;
  watermark?: boolean;
  embedMeta?: boolean;
  [k: string]: unknown;
}

/** The host object this shell builds - the members of HostV1 it actually fulfils. */
export interface WorkHost {
  version: '1';
  shell: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object): void;
  profile: { get(): Promise<Profile>; subscribe(fn: (p: Profile) => void): () => void };
  assets: AssetsAPI;
  state: {
    save(slot: string, data: object): Promise<void>;
    load(slot: string): Promise<object | null>;
    list(): Promise<StateEntry[]>;
    delete(slot: string): Promise<void>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
    writeImage(blob: Blob): Promise<{ method: 'clipboard' | 'download' }>;
  };
  export: {
    render(node: unknown, format: string, opts?: ExportOpts): Promise<Blob>;
    download(blob: Blob, filename: string): Promise<void>;
    file(blob: Blob, opts?: { filename?: string }): Promise<void>;
  };
}

// ── jsdom shim (no @types/jsdom; we need only these members) ──────────────────

export interface RenderElement {
  innerHTML: string;
  tagName: string;
  querySelector(sel: string): RenderElement | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  [k: string]: unknown;
}

export interface RenderDocument {
  getElementById(id: string): RenderElement | null;
  [k: string]: unknown;
}

export interface RenderWindow {
  document: RenderDocument;
  XMLSerializer: new () => { serializeToString(node: unknown): string };
  Element: unknown;
  close?(): void;
  [k: string]: unknown;
}

export interface RenderDom {
  window: RenderWindow;
}

// ── engine shim (the surface the pipeline calls) ──────────────────────────────

export interface LoadedTool {
  manifest: {
    id: string;
    version: string;
    render: { formats: string[]; width?: number; height?: number };
    [k: string]: unknown;
  };
  hooksSource: string | null;
  [k: string]: unknown;
}

export interface Runtime {
  getHydrated(): string;
  export(node: unknown, format: string, opts?: Record<string, unknown>): Promise<Blob>;
  hookErrors: Array<{ hook: string; message: string }>;
  [k: string]: unknown;
}

export interface UrlState {
  values: Record<string, unknown>;
  format: string | null;
  width: number | null;
  height: number | null;
  unit: string | null;
  dpi: number | null;
  [k: string]: unknown;
}

export interface EngineApi {
  ENGINE_VERSION: string;
  loadTool(toolId: string, fetchFile: (p: string) => Promise<string>, opts?: { lang?: string }): Promise<LoadedTool>;
  createRuntime(tool: LoadedTool, host: unknown, initialState?: Record<string, unknown>): Promise<Runtime>;
  parseUrlState(query: string, manifest: unknown): UrlState;
  expandQuery(query: string): Promise<string>;
  parseDimension(input: string | number | null | undefined, defaultUnit?: string): unknown;
  toPixels(dim: unknown, dpi: number): number;
  /** Embed a signed C2PA Content Credential into `bytes` (svg/png/…). The signer
   *  ({privateKey, certDer, chain}) is the instance identity; without one the
   *  engine would self-sign ephemerally, but the control plane always passes its
   *  configured signer. plans/17 §16. */
  embedC2pa(bytes: Uint8Array, format: string, opts: C2paEmbedOptions): Promise<Uint8Array>;
}

/** The subset of the engine's EmbedOptions the render plane sets. */
export interface C2paEmbedOptions {
  signer: { privateKey: unknown; certDer: Uint8Array; chain: Uint8Array[] };
  title?: string;
  claimGenerator?: string;
  author?: unknown;
  ingredients?: unknown;
  actions?: unknown;
}

// string-typed (non-literal) so tsc doesn't resolve the sibling .ts source.
const ENGINE_SPECIFIER: string = '@lolly/engine';
const JSDOM_SPECIFIER: string = 'jsdom';

export async function loadEngine(): Promise<EngineApi> {
  return (await import(ENGINE_SPECIFIER)) as unknown as EngineApi;
}

export async function loadJsdom(): Promise<{ JSDOM: new (html: string) => RenderDom }> {
  return (await import(JSDOM_SPECIFIER)) as unknown as { JSDOM: new (html: string) => RenderDom };
}
