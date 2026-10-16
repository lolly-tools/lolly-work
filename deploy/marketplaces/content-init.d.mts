export function archivePaths(listing: string): string[];
export function prepareContent(release: { url: string; sha256: string }, contentRoot: string, keysRoot: string, download?: typeof fetch): Promise<string>;
