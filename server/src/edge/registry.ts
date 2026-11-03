// SPDX-License-Identifier: MPL-2.0
/**
 * Builds an adapter for a configured provider, and finds its credential: the
 * env var `credentialRef` names, read once at boot and held in process memory,
 * or else a credential sealed in the store with sealSecret under the context
 * `edge-provider:<id>:api`, opened only when a call needs it. Neither form is
 * ever returned by an API, logged or written to an audit event; only its
 * fingerprint is.
 */
import { createBunnyAdapter, type BunnyOptions } from './bunny.ts';
import { createCloudflareAdapter, type CloudflareAdapter, type CloudflareOptions } from './cloudflare.ts';
import type { EdgeProviderConfig } from './config.ts';
import type { EdgeAdapter } from './types.ts';
import { openSecret } from '../lib/crypto.ts';

export function edgeCredentialContext(providerId: string): string {
  return `edge-provider:${providerId}:api`;
}

export interface SealedEdgeCredential { ciphertext: Uint8Array; fingerprint: string; updatedAt: string }

export interface EdgeCredentialSource {
  /** Credentials read from the environment at boot, by provider id. */
  env: ReadonlyMap<string, string>;
  /** The sealed row for a provider, if one was stored. */
  sealed: (providerId: string) => Promise<SealedEdgeCredential | null>;
  /** LW_CREDENTIAL_SECRET, needed to open a sealed row. */
  masterSecret?: string;
}

/** Read each provider's env credential once. A missing variable fails the calls that need it, not the boot. */
export function envEdgeCredentials(providers: readonly EdgeProviderConfig[], env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of providers) {
    const value = p.credentialRef ? env[p.credentialRef] : undefined;
    if (value?.trim()) out.set(p.id, value.trim());
  }
  return out;
}

export async function resolveEdgeCredential(provider: EdgeProviderConfig, source: EdgeCredentialSource): Promise<string | null> {
  const fromEnv = source.env.get(provider.id);
  if (fromEnv) return fromEnv;
  if (provider.credentialRef) return null; // the configured env var is unset; a stored row must not stand in for it
  const row = await source.sealed(provider.id);
  if (!row || !source.masterSecret) return null;
  try { return openSecret(row.ciphertext, source.masterSecret, edgeCredentialContext(provider.id)); } catch { return null; }
}

export function createEdgeAdapter(provider: EdgeProviderConfig, credential: string, fetchImpl?: typeof fetch): EdgeAdapter | CloudflareAdapter {
  const common = { id: provider.id, hostnames: provider.hostnames, jurisdiction: provider.jurisdiction, credential, ...(fetchImpl ? { fetchImpl } : {}) };
  return provider.kind === 'bunny'
    ? createBunnyAdapter({ ...common, options: provider.options as BunnyOptions })
    : createCloudflareAdapter({ ...common, publicOnly: provider.publicOnly, options: provider.options as CloudflareOptions });
}
