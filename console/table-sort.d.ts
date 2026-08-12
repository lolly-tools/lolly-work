// Ambient types for the plain-JS comparator, so `tsc --noEmit` (strict, allowJs
// off) accepts the import from tests/table-sort.test.ts. Runtime is table-sort.js.
export function coerceNumber(s: string): number;
export function coerceDate(s: string): number;
export function compareValues(a: string, b: string, type?: 'number' | 'date' | 'text' | 'auto'): number;
