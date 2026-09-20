// SPDX-License-Identifier: MPL-2.0
import { designSelection, validateDesignValues } from '@lolly-tools/core/design-tool-v1';
import type { DesignToolPolicyV1 } from '@lolly-tools/core/design-tool-v1';

export function assertDesignValues(policy: DesignToolPolicyV1, values: Record<string, unknown>, required = false): void {
  const issues = validateDesignValues(policy, values, required);
  if (issues.length) throw new Error(issues.map(i => i.message).join('\n'));
}

export function designExportSize(policy: DesignToolPolicyV1, values: Record<string, unknown>, format: string, width?: number, height?: number): { width: number; height: number } {
  assertDesignValues(policy, values, true);
  if (!policy.formats.includes(format as 'png' | 'svg' | 'pdf')) throw new Error('This format is not enabled by the designer.');
  const selected = designSelection(policy, values);
  const variant = policy.variants.find(v => v.id === selected.variantId);
  if (!variant) throw new Error('The selected artboard is unavailable.');
  const w = width ?? (height === undefined ? variant.width : height * variant.width / variant.height);
  const h = height ?? w * variant.height / variant.width;
  if (![w, h].every(n => Number.isFinite(n) && n > 0) || Math.abs(w / h - variant.width / variant.height) > 0.001) throw new Error('Keep the artboard proportions chosen by the designer.');
  return { width: w, height: h };
}
