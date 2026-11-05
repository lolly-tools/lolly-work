export function renderDocPathChoices<T>(
  headers: string[],
  rows: string[][],
  render: {
    el(tag: string, attributes: Record<string, unknown>, ...children: unknown[]): T;
    inline(text: string): unknown[];
    anchorHref(anchor: string): string;
  },
): T | null;
