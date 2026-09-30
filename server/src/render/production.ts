import type { ProductionContract, ProductionReport, ProductionFacts, ProductionCollector, ProductionRepairPlan } from '@lolly/engine/production/types';
import { sha256Hex } from '../lib/crypto.ts';
export type { ProductionContract, ProductionReport, ProductionFacts };
export interface ProductionRequest { contract: ProductionContract; referenceBase64?: string; repair?: ProductionRepairPlan }
interface ProductionApi {
  productionInputFacts(model: readonly { id: string; value: unknown }[], contract: Pick<ProductionContract, 'requirements'>): Promise<Record<string, string>>;
  parseProductionRepair(value: unknown): ProductionRepairPlan;
  proposeProductionPatch(inputs: Record<string, unknown>, report: ProductionReport, plan: ProductionRepairPlan): Promise<unknown>;
  runProductionRepairs<T extends { report: ProductionReport; bytes: Uint8Array; contract: ProductionContract }>(inputs: Record<string, unknown>, policy: ProductionRepairPlan, operations: { render(inputs: Record<string, unknown>, signal?: AbortSignal): Promise<T>; propose(inputs: Record<string, unknown>, report: ProductionReport): Promise<unknown> }, signal?: AbortSignal): Promise<{ inputs: Record<string, unknown>; attempts: T[]; stopped: string }>;
  parseProductionContract(value: unknown): ProductionContract;
  inspectProduction(bytes: Uint8Array, contract: unknown, collect: ProductionCollector, options?: { reference?: Uint8Array; signal?: AbortSignal; resolved?: Pick<ProductionFacts, 'sourceSha256' | 'contextSha256' | 'resources' | 'inputs' | 'records'> }): Promise<ProductionReport>;
  productionProblems(report: ProductionReport, bytes: Uint8Array, contract: unknown): Promise<string[]>;
  productionFormat(bytes: Uint8Array): ProductionContract['format'] | undefined;
  collectProductionSvg(bytes: Uint8Array, contract: ProductionContract, parse: (xml: string, ids: string[]) => Promise<{ valid: boolean; width: string | null; height: string | null; nodes: { id: string; name: string; text: string; href: string; xml: string }[] }>): Promise<ProductionFacts>;
}
const specifier: string = '@lolly/engine/production';
export const productionApi: ProductionApi = await import(specifier);
export function parseProductionRequest(value: unknown): ProductionRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production must contain a contract');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(k => !['contract', 'referenceBase64', 'repair'].includes(k))) throw new Error('unknown production field');
  const contract = productionApi.parseProductionContract(raw.contract);
  if (raw.referenceBase64 !== undefined && (typeof raw.referenceBase64 !== 'string' || raw.referenceBase64.length > 900_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.referenceBase64))) throw new Error('invalid or oversized production reference');
  if (contract.comparison && (typeof raw.referenceBase64 !== 'string' || sha256Hex(Buffer.from(raw.referenceBase64, 'base64')) !== contract.comparison.referenceSha256)) throw new Error('production reference digest mismatch');
  return { contract, ...(raw.repair === undefined ? {} : { repair: productionApi.parseProductionRepair(raw.repair) }), ...(typeof raw.referenceBase64 === 'string' ? { referenceBase64: raw.referenceBase64 } : {}) };
}
export class ProductionError extends Error {
  readonly code = 'PRODUCTION_VERIFICATION_FAILED'; readonly status = 422;
  readonly production?: ProductionReport;
  attempts?: ProductionReport[];
  constructor(problems: string[], report?: ProductionReport) { super(`Production checks did not complete: ${problems.join(', ')}.`); this.production = report; }
}
export async function verifyProductionReport(report: ProductionReport | undefined, bytes: Uint8Array, request: ProductionRequest): Promise<void> {
  if (!report) throw new ProductionError(['production-report-missing']);
  const problems = await productionApi.productionProblems(report, bytes, request.contract);
  if (problems.length) throw new ProductionError(problems, report);
}
export async function inspectWorkProduction(bytes: Uint8Array, request: ProductionRequest, resolved: Pick<ProductionFacts, 'sourceSha256' | 'contextSha256' | 'resources' | 'inputs'>, signal?: AbortSignal) {
  const { collectWorkProduction } = await import('./production-collect.ts');
  const report = await productionApi.inspectProduction(bytes, request.contract, collectWorkProduction, {
    reference: request.referenceBase64 ? new Uint8Array(Buffer.from(request.referenceBase64, 'base64')) : undefined, signal, resolved,
  });
  return report;
}
