// SPDX-License-Identifier: MPL-2.0
/**
 * Which share anyway choices a withdrawal takes (plans/82 M4): one choice by
 * its key, every choice for one company, or every choice a programme holds,
 * its companies' included. Both stores read this one rule.
 */
import type { RightsChoiceRecord } from './rights.ts';
import type { RightsChoicePick } from '../store/types.ts';

export function rightsChoicePicked(c: RightsChoiceRecord, pick: RightsChoicePick): boolean {
  if ('key' in pick) return c.assetId === pick.key.assetId && c.group === pick.key.group && (!pick.programmeId || c.programmeId === pick.programmeId);
  if ('companyId' in pick) return c.companyId === pick.companyId;
  return c.programmeId === pick.programmeId;
}
