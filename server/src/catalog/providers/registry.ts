/**
 * Provider registry - kind → driver factory (plans/17 §3). The only place that
 * knows which kinds exist; federation, blob serving, and the control plane all
 * instantiate through here. `secret` is the resolved plaintext credential
 * (opened from the sealed store value, or read from a config entry's
 * credentialRef env var) - it lives in process memory only.
 */
import type { CatalogProvider, ProviderRecord } from './types.ts';
import { createMockProvider, type MockProviderOptions } from './mock.ts';
import { createBrandfolderProvider, type BrandfolderOptions } from './brandfolder.ts';
import { createS3Provider, type S3Options } from './s3.ts';
import { createGitProvider, type GitOptions } from './git.ts';
import { createDropboxProvider, type DropboxOptions } from './dropbox.ts';
import { createGdriveProvider, type GdriveOptions } from './gdrive.ts';
import { createO365Provider, type O365Options } from './o365.ts';
import { createOptimizelyCmpProvider, type OptimizelyCmpOptions } from './optimizely-cmp.ts';
import { createImageRelayProvider, type ImageRelayOptions } from './imagerelay.ts';
import { createCantoProvider, type CantoOptions } from './canto.ts';
import { createAcquiaDamProvider, type AcquiaDamOptions } from './acquia-dam.ts';
import { createIntelligenceBankProvider, type IntelligenceBankOptions } from './intelligencebank.ts';
import { createPenpotProvider, type PenpotOptions } from './penpot.ts';
import { createWebdavProvider, type WebdavOptions } from './webdav.ts';

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
}

export function createProvider(rec: ProviderRecord, secret: string | undefined, deps: ProviderDeps = {}): CatalogProvider {
  switch (rec.kind) {
    case 'webdav':
      // Same availability arm as the DAMs below, for the opposite reason: plain
      // WebDAV models no window at all, so one only exists when the server
      // exposes a custom property and the mapping names it (plans/27 §2).
      return createWebdavProvider(rec.id, rec.options as unknown as WebdavOptions, secret, deps.fetchImpl, rec.mapping?.availabilityFields);
    case 'mock':
      return createMockProvider(rec.id, rec.options as MockProviderOptions, secret);
    case 'brandfolder':
      return createBrandfolderProvider(rec.id, rec.options as unknown as BrandfolderOptions, secret, deps.fetchImpl);
    case 's3':
      return createS3Provider(rec.id, rec.options as unknown as S3Options, secret, deps.fetchImpl);
    case 'git':
      return createGitProvider(rec.id, rec.options as unknown as GitOptions, secret, deps.fetchImpl);
    case 'dropbox':
      return createDropboxProvider(rec.id, rec.options as DropboxOptions, secret, deps.fetchImpl);
    case 'gdrive':
      return createGdriveProvider(rec.id, rec.options as unknown as GdriveOptions, secret, deps.fetchImpl);
    case 'o365':
      return createO365Provider(rec.id, rec.options as unknown as O365Options, secret, deps.fetchImpl);
    case 'optimizely-cmp':
      return createOptimizelyCmpProvider(rec.id, rec.options as unknown as OptimizelyCmpOptions, secret, deps.fetchImpl);
    case 'imagerelay':
      // availabilityFields (plans/27 §2) lives on the mapping, not options - 
      // Image Relay has no native window, so the driver reads it from the named
      // custom-metadata field.
      return createImageRelayProvider(rec.id, rec.options as unknown as ImageRelayOptions, secret, deps.fetchImpl, rec.mapping?.availabilityFields);
    case 'canto':
      // Same arm as Image Relay: Canto exposes no documented native availability
      // field, so the window comes from the named custom field on the mapping
      // (plans/32 §4). An Image Relay tenant's config carries over by renaming it.
      return createCantoProvider(rec.id, rec.options as unknown as CantoOptions, secret, deps.fetchImpl, rec.mapping?.availabilityFields);
    case 'acquia-dam':
      return createAcquiaDamProvider(rec.id, rec.options as unknown as AcquiaDamOptions, secret, deps.fetchImpl);
    case 'intelligencebank':
      return createIntelligenceBankProvider(rec.id, rec.options as unknown as IntelligenceBankOptions, secret, deps.fetchImpl);
    case 'penpot':
      return createPenpotProvider(rec.id, rec.options as unknown as PenpotOptions, secret, deps.fetchImpl);
    default:
      throw new Error(`catalog provider kind not yet implemented: ${rec.kind}`);
  }
}
