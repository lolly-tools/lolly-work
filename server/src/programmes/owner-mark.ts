// SPDX-License-Identifier: MPL-2.0
/**
 * The workspace's own mark on what it publishes to partner programmes (plans/82 M6,
 * decision 5): one `asset:<id>` owner-published mark, stated by staff, held only while
 * the asset's CURRENT head is the workspace's own work.
 *
 * Own work is judged from the head's provenance, recorded when it was committed
 * (catalog/submit.ts): who put those bytes there and whether they were a partner
 * programme member then, and the catalog file they were copied from, if any. A head
 * is not own work when that file or the asset declares a licence or has a licence
 * record, came from a provider, or when its author was a partner or can no longer be
 * resolved.
 *
 * Every head change runs `recheck` (the shared version-commit path in submitAsset,
 * a rollback, a programme template's new version), which withdraws the mark, audited
 * `catalog.rights.unmark` with `why: 'not-own'`, when the new head is not own work. A
 * mark is stated as check, insert, then a second look at the head: when the head
 * moved in between, the new head is checked again, so a mark never outlives a head
 * change that raced it, in one process or several. Inserting and withdrawing are each
 * one store step, so only the call that changed something is audited.
 */
import type { Store, UserRecord } from '../store/types.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import type { AssetIndexEntry } from '../catalog/lifecycle.ts';
import { headVersionOf, type AssetVersionRecord } from '../catalog/versions.ts';
import { defaultMarkTerms, loadRightsEngine, markScopeKey, rightsSourceOf, type AssetRightsMarkRecord } from '../catalog/rights.ts';
import { isProgrammeScoped } from './types.ts';

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface OwnerMarkDeps {
  store: Store;
  audit: Audit;
  /** The workspace name: the holder of the mark. */
  workspaceName(): string;
  now?: () => Date;
}

/** Where a head's bytes came from, as recorded when it was committed. */
export interface HeadProvenance { by: string; byScoped?: boolean; from?: string }

export function createOwnerMarks(deps: OwnerMarkDeps) {
  const { store, audit } = deps;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const scopeOf = (assetId: string): string => markScopeKey({ kind: 'asset', id: assetId });

  /** The mark on one asset, if any. */
  const markOn = async (assetId: string): Promise<AssetRightsMarkRecord | undefined> =>
    (await store.listAssetRightsMarks()).find((m) => m.scope === scopeOf(assetId));

  /** The current head's provenance: its version row, or the submission for a first version. */
  const provenanceOf = async (rec: InstanceAssetRecord): Promise<HeadProvenance> => {
    const head = headVersionOf(rec);
    const row: AssetVersionRecord | undefined = (await store.listAssetVersions(rec.id)).find((r) => r.version === head);
    if (row) return { by: row.by, ...(row.byScoped !== undefined ? { byScoped: row.byScoped } : {}), ...(row.from ? { from: row.from } : {}) };
    return {
      by: rec.submission?.by ?? '', ...(rec.submission?.byScoped !== undefined ? { byScoped: rec.submission.byScoped } : {}),
      ...(rec.publication?.from ? { from: rec.publication.from } : {}),
    };
  };

  /** Whether the author recorded on a head was staff of this workspace. An author who
   *  can no longer be resolved does not count as staff. */
  const staffAuthor = async (by: string, byScoped?: boolean): Promise<boolean> => {
    if (byScoped !== undefined) return !byScoped && by.startsWith('user:');
    const user = by.startsWith('user:') ? await store.getUser(by.slice('user:'.length)) : null;
    return !!user && !isProgrammeScoped(user.groups, user.role);
  };

  /** Whether one file's own record leaves it free to be the workspace's own: no
   *  declared licence, no licence record, not a provider's file. */
  const unlicensed = async (rec: InstanceAssetRecord): Promise<boolean> => {
    if (rec.origin || rec.exited) return false;
    const [engine, marks, licences] = await Promise.all([loadRightsEngine(), store.listAssetRightsMarks(), store.listAssetLicences()]);
    const { source } = rightsSourceOf(engine, rec.entry as AssetIndexEntry, marks, licences);
    return source !== 'own' && source !== 'licence-record';
  };

  /** Whether this asset's current head is the workspace's own work. */
  const ownWork = async (rec: InstanceAssetRecord | null): Promise<boolean> => {
    if (!rec || !(await unlicensed(rec))) return false;
    const head = await provenanceOf(rec);
    if (!(await staffAuthor(head.by, head.byScoped))) return false;
    if (!head.from) return true;
    const source = await store.getInstanceAsset(head.from);
    if (!source || !(await unlicensed(source))) return false;
    const origin = await provenanceOf(source);
    return staffAuthor(origin.by, origin.byScoped);
  };

  /** Withdraw the mark in one step; only the call that removed it audits. */
  const withdraw = async (actor: Pick<UserRecord, 'id'>, assetId: string, template: string, why: 'untick' | 'not-own'): Promise<void> => {
    const prior = await store.takeAssetRightsMark(scopeOf(assetId));
    if (!prior) return;
    await audit(`user:${actor.id}`, 'catalog.rights.unmark', `rights-mark:${prior.scope}`, {
      scope: prior.scope, before: { holder: prior.holder, terms: prior.terms, statedBy: prior.statedBy, statedAt: prior.statedAt }, via: 'programme-template', template, why,
    });
  };

  /** After any head change: withdraw the mark when the new head is not own work. */
  const recheck = async (actor: Pick<UserRecord, 'id'>, assetId: string, template = assetId): Promise<void> => {
    if (!(await markOn(assetId))) return;
    if (!(await ownWork(await store.getInstanceAsset(assetId)))) await withdraw(actor, assetId, template, 'not-own');
  };

  /**
   * State the mark when the current head is own work: check, insert only when the
   * scope has none, then look at the head again and recheck if it moved meanwhile.
   * Returns the mark now on the asset, or undefined.
   */
  const state = async (actor: Pick<UserRecord, 'id'>, assetId: string, template = assetId): Promise<AssetRightsMarkRecord | undefined> => {
    const before = await store.getInstanceAsset(assetId);
    if (!(await ownWork(before))) return markOn(assetId);
    const holder = deps.workspaceName();
    const mark: AssetRightsMarkRecord = { scope: scopeOf(assetId), holder, terms: defaultMarkTerms(holder), statedBy: actor.id, statedAt: now(), coveredAtStatement: 1 };
    if (await store.addAssetRightsMark(mark)) {
      await audit(`user:${actor.id}`, 'catalog.rights.mark', `rights-mark:${mark.scope}`, {
        scope: mark.scope, holder, terms: mark.terms, covered: 1, via: 'programme-template', template,
      });
    }
    const after = await store.getInstanceAsset(assetId);
    if (!after || headVersionOf(after) !== headVersionOf(before!)) await recheck(actor, assetId, template);
    return markOn(assetId);
  };

  return { markOn, ownWork, state, withdraw, recheck, provenanceOf };
}

export type OwnerMarks = ReturnType<typeof createOwnerMarks>;
