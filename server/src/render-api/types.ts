// SPDX-License-Identifier: MPL-2.0
/**
 * The migration API for people moving off a hosted render API. Vendor request
 * shapes come in, durable renders run, vendor response shapes go out. Each source
 * is built from that vendor's public documentation and recorded fixtures. None of
 * it has been run against a live account.
 */
export const RENDER_API_SOURCES = ['bannerbear-v5', 'bannerbear-v2', 'placid'] as const;
export type RenderApiSource = (typeof RENDER_API_SOURCES)[number];

export interface RenderApiMapping {
  source: RenderApiSource;
  /** The vendor's template id: `template` on Bannerbear, `template_uuid` on Placid. */
  template: string;
  toolId: string;
  /** The output when the request does not choose one. */
  format: string;
  /** Layer name, then vendor property, then the tool input it fills. The pseudo
   *  layers `$request`, `$template` and `$modifications` name request-level fields. */
  layers: Record<string, Record<string, string>>;
  /** `layer.property` values a person has decided to drop. Nothing else is dropped. */
  ignore: string[];
  /** Inputs this template always sends, whatever the request says. */
  fixed: Record<string, unknown>;
  /** Placid's URL API for this template. */
  url?: {
    /** The env var holding the old private API token, so existing signatures still verify. */
    credentialRef?: string;
    /** Accept a URL with no signature. Off unless someone chooses it. */
    allowUnsigned?: boolean;
  };
}

export interface RenderApiConfig {
  /** Off by default: every /compat/ route then answers 404. */
  enabled: boolean;
  /** A JSON file of mappings, read at boot. Reviewed like delivery destinations. */
  mappingsFile?: string;
  templates: RenderApiMapping[];
  /** How long a result URL works. `0` means result URLs need the bearer token. */
  resultUrls: { signedDays: number };
  /** The service token Placid URL API renders act as. */
  urlApi: { actAs?: string };
}

/** One vendor request. It may own one durable render per output format. */
export interface RenderApiRecord {
  id: string;
  /** Placid documents numeric image ids, so each record also has one. */
  seq: number;
  source: RenderApiSource;
  template: string;
  principal: string;
  formats: string[];
  /** Format to durable render id. */
  renders: Record<string, string>;
  /** `metadata` or `passthrough`, unchanged. */
  metadata: unknown;
  /** Request fields a vendor's response repeats. */
  echo: Record<string, unknown>;
  webhookUrl?: string;
  filename?: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface RenderApiStore {
  /** A principal and key that already name a record return that record. */
  insertRenderApiRecord(record: Omit<RenderApiRecord, 'seq'>): Promise<{ record: RenderApiRecord; reused: boolean }>;
  setRenderApiRenders(id: string, renders: Record<string, string>): Promise<void>;
  getRenderApiRecord(id: string): Promise<RenderApiRecord | null>;
  getRenderApiRecordBySeq(seq: number): Promise<RenderApiRecord | null>;
  listRenderApiRecords(principal: string, source: RenderApiSource, limit: number, offset: number): Promise<RenderApiRecord[]>;
  /** Deleting a record stops its result URLs working. Its renders stay in history. */
  deleteRenderApiRecord(id: string, principal: string): Promise<RenderApiRecord | null>;
}

/** A refusal a vendor's client can read: a status and a name. */
export class RenderApiRefusal extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown>;
  constructor(code: string, status: number, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RenderApiRefusal';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
