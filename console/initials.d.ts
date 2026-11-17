// Ambient types for the plain-JS helper, so `tsc --noEmit` (strict, allowJs
// off) accepts the import from tests/console-initials.test.ts. Runtime is initials.js.
export function initialsOf(name?: string | null, email?: string | null): string;
