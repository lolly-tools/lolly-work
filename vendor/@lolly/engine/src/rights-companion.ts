// SPDX-License-Identifier: MPL-2.0
/** Verify readable package credits without claiming a signed credential. */
import type { AttributionPlanV1, AttributionReceiptV1 } from '@lolly-tools/core/rights-v1';
import { attributionCompanion, attributionCredits } from './rights-attribution.ts';
import { sha256Hex } from './bytes.ts';
import { readZip } from './zip.ts';

export async function checkCompanionReadback(bytes: Uint8Array, plan: AttributionPlanV1, fingerprint: string): Promise<AttributionReceiptV1> {
  const expected = attributionCompanion(plan).files;
  const entries = readZip(bytes);
  const checks = expected.map(file => {
    const found = entries.filter(entry => entry.name === file.name);
    return { name: file.name, ok: found.length === 1 && new TextDecoder().decode(found[0]!.bytes) === file.text };
  });
  const ok = checks.every(check => check.ok);
  return {
    fingerprint, outputHash: `sha256:${await sha256Hex(bytes)}`, state: ok ? 'readback-confirmed' : 'written',
    expected: plan.required.map(notice => notice.work), observed: ok ? plan.required.map(notice => notice.work) : [],
    checks, credits: attributionCredits(plan),
    remaining: ok ? [] : [{ code: 'attribution.delivery-missing', summary: 'The package credits could not be read back as written.', rule: 'companion-readback-v1', remedies: [{ kind: 'copy-credit', label: 'Copy the credit and add it where the file is shared' }] }],
  };
}
