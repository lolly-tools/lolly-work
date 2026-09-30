// SPDX-License-Identifier: MPL-2.0
/** Worker hooks return receipts; only the runtime inspects the exported DOM. */
export function checkDesignTextReceipt(receipt: unknown, values: Record<string, unknown>, node: unknown): void {
  if (!receipt) return;
  const record = receipt as { values: Array<[string, unknown]>; frames: Array<{ id: string; stamp: string }>; issues: string[] };
  if (record.issues.length) throw new Error(`Text export needs attention: ${record.issues.join(' ')}`);
  if (JSON.stringify(record.values) !== JSON.stringify(Object.keys(values).sort().map(id => [id, values[id]]))) {
    throw new Error('Text layout is still changing. Wait for the current text to appear, then export again.');
  }
  const root = node as Element;
  const nodes = root?.querySelectorAll ? Array.from(root.querySelectorAll('[data-text-frame]')) : [];
  if (root?.matches?.('[data-text-frame]')) nodes.push(root);
  for (const frame of record.frames) {
    const copies = nodes.filter(node => node.getAttribute('data-text-frame') === frame.id);
    if (!copies.length || copies.some(node => node.getAttribute('data-text-layout') !== frame.stamp)) {
      throw new Error('Text layout is still changing. Wait for the current text to appear, then export again.');
    }
  }
}
