// SPDX-License-Identifier: MPL-2.0
/**
 * The licence gate's mode (plans/82 M4): `gate` or `report`, and why.
 *
 * Andy's rollout decision has two halves: a new install gates from day one,
 * and an upgrade starts in `report` and never flips without an admin's act.
 * Configuration templates are re-applied on upgrades (a helm upgrade, a new
 * compose file), so the default cannot live in them. It is decided once
 * instead, by the instance itself, on the first start of a release that
 * knows the gate: `gate` when the database holds no accounts yet (a fresh
 * install), `report` when it already does (an upgrade). The decision is
 * stored and never revisited. `policy.catalog.partnerRights` in the
 * configuration always wins. A memory store keeps nothing, so it answers
 * `report`.
 */
import type { InstanceConfig } from '../config/instance.ts';

export type PartnerRightsMode = 'report' | 'gate';
export type PartnerRightsSource = 'config' | 'fresh-install' | 'upgrade-with-accounts' | 'memory-store';

/** One default an instance decided once. */
export interface InstanceDefaultRecord {
  key: string;
  value: string;
  /** Why it was decided this way. */
  why: string;
  decidedAt: string;
}

export const PARTNER_RIGHTS_KEY = 'catalog.partnerRights';

export interface PartnerRightsState {
  mode: PartnerRightsMode;
  source: PartnerRightsSource;
  decidedAt?: string;
  /** The line the console, the setup check and lw print. */
  line: string;
}

/** The sentence for a mode and where it came from. */
export function partnerRightsLine(mode: PartnerRightsMode, source: PartnerRightsSource): string {
  const head = mode === 'gate' ? 'Gate' : 'Report only';
  const change = 'Set policy.catalog.partnerRights to change it.';
  switch (source) {
    case 'config': return `${head}: set in configuration (policy.catalog.partnerRights).`;
    case 'fresh-install': return `${head}: decided at a fresh install. ${change}`;
    case 'upgrade-with-accounts': return `${head}: decided when this instance upgraded with accounts already in it. ${change}`;
    case 'memory-store': return `${head}: this instance keeps no database, so nothing was decided. ${change}`;
  }
}

/** The store calls the decision needs. */
export interface InstanceDefaultStore {
  getInstanceDefault(key: string): Promise<InstanceDefaultRecord | null>;
  /** Insert once; an existing row wins and is returned unchanged. */
  recordInstanceDefault(rec: InstanceDefaultRecord): Promise<InstanceDefaultRecord>;
  /** Whether any account exists. */
  hasAccounts(): Promise<boolean>;
}

/**
 * Decide the recorded default, once. A row already there answers as it is,
 * whatever the accounts are now; with none, the accounts decide and the row is
 * written, and a concurrent start that wrote first wins.
 */
export async function decidePartnerRightsDefault(store: InstanceDefaultStore, now: () => string = () => new Date().toISOString()): Promise<InstanceDefaultRecord> {
  const found = await store.getInstanceDefault(PARTNER_RIGHTS_KEY);
  if (found) return found;
  const upgrade = await store.hasAccounts();
  return store.recordInstanceDefault({
    key: PARTNER_RIGHTS_KEY, value: upgrade ? 'report' : 'gate', why: upgrade ? 'upgrade-with-accounts' : 'fresh-install', decidedAt: now(),
  });
}

/** The mode in force: configuration first, then the recorded default. */
export function partnerRightsState(config: Pick<InstanceConfig, 'policy'>, recorded: InstanceDefaultRecord | null): PartnerRightsState {
  const configured = config.policy.catalog.partnerRights;
  if (configured) return { mode: configured, source: 'config', line: partnerRightsLine(configured, 'config') };
  const mode: PartnerRightsMode = recorded?.value === 'gate' ? 'gate' : 'report';
  const source: PartnerRightsSource = recorded && (recorded.why === 'fresh-install' || recorded.why === 'upgrade-with-accounts') ? recorded.why : 'memory-store';
  return { mode, source, ...(recorded ? { decidedAt: recorded.decidedAt } : {}), line: partnerRightsLine(mode, source) };
}
