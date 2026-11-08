// SPDX-License-Identifier: MPL-2.0
/**
 * The workspace's own mark on what it publishes to partner programmes (plans/82 M6,
 * decision 5): one `asset:<id>` owner-published mark, stated by staff, held only while
 * the asset's CURRENT head is the workspace's own work.
 *
 * Own work is judged from the head's provenance, recorded when it was committed
 * (catalog/submit.ts, the template routes): who put those bytes there and whether
 * they were a partner programme member then, and the catalog file and version they
 * were copied from, if any. A head is not own work when that file or the asset
 * declares a licence or has a licence record, came from a provider, or when its
 * author was a partner, can no longer be resolved or was never recorded.
 *
 * Every statement, withdrawal and head change on one asset runs inside that asset's
 * lock (Store.withAssetLock), so check, act and audit never interleave with another:
 * a head change withdraws the mark, audited `catalog.rights.unmark` with
 * `why: 'not-own'`, when its new head is not own work, and a statement always sees
 * the head it marks. The `…Locked` variants are for a caller that already holds it.
 */
import type { Store, UserRecord } from '../store/types.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import type { AssetIndexEntry } from '../catalog/lifecycle.ts';
import { headVersionOf, type AssetVersionRecord, type CopiedFrom } from '../catalog/versions.ts';
import { defaultMarkTerms, loadRightsEngine, markScopeKey, rightsSourceOf, type AssetRightsMarkRecord } from '../catalog/rights.ts';
import { isProgrammeScoped } from './types.ts';

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;
type Actor = Pick<UserRecord, 'id'>;

export interface OwnerMarkDeps {
  store: Store;
  audit: Audit;
  /** The workspace name: the holder of the mark. */
  workspaceName(): string;
  now?: () => Date;
}

/** Where one version's bytes came from, as recorded when it was committed. A
 *  version with nothing recorded (`unknown`) is never own work. */
export interface Provenance { by: string; byScoped?: boolean; from?: CopiedFrom; unknown?: true }

export function createOwnerMarks(deps: OwnerMarkDeps) {
  const { store, audit } = deps;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const scopeOf = (assetId: string): string => markScopeKey({ kind: 'asset', id: assetId });

  /** The mark on one asset, if any. */
  const markOn = async (assetId: string): Promise<AssetRightsMarkRecord | undefined> =>
    (await store.listAssetRightsMarks()).find((m) => m.scope === scopeOf(assetId));

  /** One version's provenance: its version row, or the submission for a first version
   *  with no rows. A first version recorded before provenance was is unknown. */
  const provenanceAt = async (rec: InstanceAssetRecord, version: number): Promise<Provenance> => {
    const row: AssetVersionRecord | undefined = (await store.listAssetVersions(rec.id)).find((r) => r.version === version);
    const fromRow = row ?? (version === 1 ? undefined : null);
    if (fromRow === null) return { by: '', unknown: true };
    const source = fromRow ?? { by: rec.submission?.by ?? '', byScoped: rec.submission?.byScoped, from: rec.publication?.from };
    if (source.byScoped === undefined) return { by: source.by, unknown: true };
    return { by: source.by, byScoped: source.byScoped, ...(source.from ? { from: source.from } : {}) };
  };

  /** Whether a recorded author was this workspace's staff: recorded as not a partner
   *  then, and still a person this instance knows. */
  const staffAuthor = async (p: Provenance): Promise<boolean> => {
    if (p.unknown || p.byScoped !== false || !p.by.startsWith('user:')) return false;
    return !!(await store.getUser(p.by.slice('user:'.length)));
  };

  /** Whether one file's own record leaves it free to be the workspace's own: no
   *  declared licence, no licence record, not a provider's file. */
  const unlicensed = async (rec: InstanceAssetRecord): Promise<boolean> => {
    if (rec.origin || rec.exited) return false;
    const [engine, marks, licences] = await Promise.all([loadRightsEngine(), store.listAssetRightsMarks(), store.listAssetLicences()]);
    const { source } = rightsSourceOf(engine, rec.entry as AssetIndexEntry, marks, licences);
    return source !== 'own' && source !== 'licence-record';
  };

  /** Whether this asset's current head is the workspace's own work, judged on the
   *  head's provenance and, for copied bytes, the exact source version copied. */
  const ownWork = async (rec: InstanceAssetRecord | null): Promise<boolean> => {
    if (!rec || !(await unlicensed(rec))) return false;
    const head = await provenanceAt(rec, headVersionOf(rec));
    if (!(await staffAuthor(head))) return false;
    if (!head.from) return true;
    const source = await store.getInstanceAsset(head.from.id);
    if (!source || !(await unlicensed(source))) return false;
    const copied = await provenanceAt(source, head.from.version);
    // A copy of a copy is not followed: only a source's own work counts.
    return !copied.from && staffAuthor(copied);
  };

  const withdrawLocked = async (actor: Actor, assetId: string, template: string, why: 'untick' | 'not-own'): Promise<void> => {
    const prior = await store.takeAssetRightsMark(scopeOf(assetId));
    if (!prior) return;
    await audit(`user:${actor.id}`, 'catalog.rights.unmark', `rights-mark:${prior.scope}`, {
      scope: prior.scope, before: { holder: prior.holder, terms: prior.terms, statedBy: prior.statedBy, statedAt: prior.statedAt }, via: 'programme-template', template, why,
    });
  };
  const recheckLocked = async (actor: Actor, assetId: string, template = assetId): Promise<void> => {
    if (!(await markOn(assetId))) return;
    if (!(await ownWork(await store.getInstanceAsset(assetId)))) await withdrawLocked(actor, assetId, template, 'not-own');
  };
  const stateLocked = async (actor: Actor, assetId: string, template = assetId): Promise<AssetRightsMarkRecord | undefined> => {
    if (!(await ownWork(await store.getInstanceAsset(assetId)))) return markOn(assetId);
    const holder = deps.workspaceName();
    const mark: AssetRightsMarkRecord = { scope: scopeOf(assetId), holder, terms: defaultMarkTerms(holder), statedBy: actor.id, statedAt: now(), coveredAtStatement: 1 };
    if (await store.addAssetRightsMark(mark)) {
      await audit(`user:${actor.id}`, 'catalog.rights.mark', `rights-mark:${mark.scope}`, {
        scope: mark.scope, holder, terms: mark.terms, covered: 1, via: 'programme-template', template,
      });
    }
    return markOn(assetId);
  };

  return {
    markOn, ownWork, provenanceAt,
    /** State the mark when the current head is own work. Returns the mark now on the asset. */
    state: (actor: Actor, assetId: string, template = assetId) => store.withAssetLock(assetId, () => stateLocked(actor, assetId, template)),
    /** Withdraw it in one step; only the call that removed it audits. */
    withdraw: (actor: Actor, assetId: string, template: string, why: 'untick' | 'not-own') => store.withAssetLock(assetId, () => withdrawLocked(actor, assetId, template, why)),
    /** After a head change: withdraw the mark when the new head is not own work. */
    recheck: (actor: Actor, assetId: string, template = assetId) => store.withAssetLock(assetId, () => recheckLocked(actor, assetId, template)),
    stateLocked, withdrawLocked, recheckLocked,
  };
}

export type OwnerMarks = ReturnType<typeof createOwnerMarks>;

/** Whether this person, at this moment, counts as a partner for the provenance a
 *  commit records. */
export const recordedScope = (user: { groups: string[]; role?: string }): boolean => isProgrammeScoped(user.groups, user.role);
