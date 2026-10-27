export interface CatalogueKey { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export function archivePaths(listing: string): string[];
export function installationCatalogueKey(keyFile: string): CatalogueKey;
export function bindShellCatalogueKey(shell: string, publisher: { kty: string; crv: string; x: string; y: string }, installation: { kty: string; crv: string; x: string; y: string }): { publisher: CatalogueKey; installation: CatalogueKey; files: string[] };
export function prepareContent(release: { url: string; sha256: string; catalogPublicKey?: { kty: string; crv: string; x: string; y: string } }, contentRoot: string, keysRoot: string, download?: typeof fetch): Promise<string>;
