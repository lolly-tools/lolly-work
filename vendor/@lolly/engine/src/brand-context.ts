// SPDX-License-Identifier: MPL-2.0
/** Portable facts and explicit rules derived from the selected token document. */
import { createTokenSet, TOKEN_EXT } from './tokens.ts';
import { readDesignSystemIdentity } from './design-system.ts';
import { readBrandStyleEvidence } from './brand-evidence.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit = 180): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, limit) : undefined;

export function brandContext(doc: unknown, opts: { name?: string; theme?: string } = {}) {
  const tokens = createTokenSet(doc, { theme: opts.theme });
  const raw = record(doc) ? doc : {};
  const extensions = record(raw.$extensions) ? raw.$extensions : {};
  const vendor = record(extensions[TOKEN_EXT]) ? extensions[TOKEN_EXT] : {};
  const reference = record(vendor.reference) ? vendor.reference : {};
  const entries = tokens.query();
  const colors = tokens.colors().map(c => ({ path: c.path, value: c.value, name: c.name }));
  const fonts = entries.filter(e => e.type === 'fontFamily').flatMap(e => {
    const value = Array.isArray(e.value) ? e.value.filter(v => typeof v === 'string').join(', ') : e.value;
    return typeof value === 'string' ? [{ path: e.path, value }] : [];
  });
  const assets = entries.filter(e => e.path.startsWith('asset.') && typeof e.value === 'string' && !e.value.startsWith('{'))
    .map(e => ({ path: e.path, id: e.value as string }));
  const source = text(reference.method) ? {
    method: text(reference.method), label: text(reference.label),
    ...(typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(reference.sha256) ? { sha256: reference.sha256 } : {}),
  } : null;
  const styles = readBrandStyleEvidence(reference.styles);
  return {
    format: 'lolly-design-context' as const, version: 1 as const,
    name: opts.name ?? readDesignSystemIdentity(doc)?.label ?? text(vendor.name) ?? 'Design system', theme: opts.theme ?? null,
    source, styles, colors, fonts, assets,
    rules: {
      color: 'Use an existing colour token where possible. A custom colour is a review item, not a forbidden value.',
      type: 'Use the declared font families. A font name does not prove the font file is installed.',
      assets: 'These asset IDs are references, not proof of ownership or permission.',
      contrast: 'Check rendered text against its actual background. Token pairs alone cannot verify a composition.',
    },
    coverage: {
      colors: colors.length ? 'resolved tokens' : 'unavailable',
      fonts: fonts.length ? 'declared families' : 'unavailable',
      assets: assets.length ? 'declared asset IDs' : 'unavailable',
      styles: styles?.mode ?? 'unavailable',
      notAssessed: ['font availability', 'layout', 'motion', 'rights', 'subjective quality'],
    },
    tokens: doc,
  };
}

/** A context file is an ordinary token document wrapped with read-only explanations. */
export function contextTokens(value: unknown): unknown {
  if (!record(value)) return value;
  if (value.format === 'lolly-design-context') return value.version === 1 ? value.tokens : null;
  if (value.format === 'lolly-reference') return value.version === 1 ? value.proposedTokens : null;
  return value;
}
