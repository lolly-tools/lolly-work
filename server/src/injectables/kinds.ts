/**
 * The four injectable kinds (plans/19 §3). Each is a KindHandler: an `envelope`
 * that shape-checks the declarative payload and states its facts, and a `project`
 * that turns it into the descriptor the shell consumes over org-config.
 *
 * Every handler refuses anything it cannot vouch for the STRUCTURE of, at publish time,
 * so an admin hears "that is not a well-formed X" at upload - never a member from a
 * broken shell. None interprets the payload's meaning: that is the shell's job, and
 * keeping it there is what lets the open core stay honest (data, not code).
 */
import { isGovernableFlag } from '../policy/feature-flags.ts';
import type { Envelope, InjectableRecord, KindHandler } from './types.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const get = (p: unknown, k: string): unknown => (p && typeof p === 'object' ? (p as Record<string, unknown>)[k] : undefined);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// A catalog asset id is a namespaced path (e.g. "acme/rates-2026", "suse/logo/primary"):
// slashes allowed, but no traversal and no scheme.
const ASSET_ID = /^[a-z0-9][a-z0-9/_.-]*$/i;
/** No angle brackets anywhere - a descriptor field is plain text, never markup. */
const hasMarkup = (s: string): boolean => /[<>]/.test(s);
/** The only URL shapes a descriptor may carry to the shell: relative, hash, or
 *  http(s). Refuses javascript:/data:/vbscript: and every other active scheme. */
const safeHref = (s: string): boolean => /^(https?:\/\/|\/|#)/.test(s) && !hasMarkup(s);

// ── flag ────────────────────────────────────────────────────────────────────
// Drive one of the shell's known feature flags (default state + toggle
// visibility). Consumable TODAY: the assembler merges flag injectables into the
// existing org-config `featureFlags` map, so the shell needs no new path.
const flag: KindHandler = {
  kind: 'flag',
  label: 'Feature flag',
  summary: 'Set a known shell feature flag’s default and toggle visibility.',
  shellSupport: 'today',
  envelope(payload) {
    const flagId = str(get(payload, 'flagId'));
    if (!flagId) return { ok: false, reason: 'flagId is required' };
    // The control plane can only govern flags the shell declares (plans/18 parity
    // with feature-flag governance) - an unknown id would be a silent no-op.
    if (!isGovernableFlag(flagId)) return { ok: false, reason: `unknown feature flag "${flagId}"` };
    const def = str(get(payload, 'default'));
    if (def !== 'on' && def !== 'off') return { ok: false, reason: 'default must be "on" or "off"' };
    const vis = str(get(payload, 'visibility')) ?? 'show';
    if (vis !== 'show' && vis !== 'hide') return { ok: false, reason: 'visibility must be "show" or "hide"' };
    return { ok: true, facts: { flag: flagId, default: def, toggle: vis } };
  },
  project(rec) {
    return {
      id: rec.id, kind: 'flag', title: rec.title,
      flagId: rec.payload.flagId,
      default: rec.payload.default,
      hidden: (str(rec.payload.visibility) ?? 'show') === 'hide',
    };
  },
};

// ── resource ──────────────────────────────────────────────────────────────────
// A typed catalog resource (rate cards are the exemplar, plans/18). Rides the
// catalog/asset rail; the descriptor points a caller's shell at an already-served
// asset by type + id. Consumable TODAY for a resource type whose OSS reader exists.
const resource: KindHandler = {
  kind: 'resource',
  label: 'Catalog resource',
  summary: 'Expose a typed catalog asset (e.g. a rate card) to selected groups.',
  shellSupport: 'today',
  envelope(payload) {
    const resourceType = str(get(payload, 'resourceType'));
    if (!resourceType || !SLUG.test(resourceType)) return { ok: false, reason: 'resourceType must be a lowercase slug' };
    const assetId = str(get(payload, 'assetId'));
    if (!assetId) return { ok: false, reason: 'assetId is required (the catalog asset to expose)' };
    // The descriptor must not smuggle a path-traversal or a scheme where the shell
    // expects a catalog asset id.
    if (assetId.includes('..') || !ASSET_ID.test(assetId)) return { ok: false, reason: 'assetId must be a catalog asset id (letters, digits, / _ . -)' };
    return { ok: true, facts: { type: resourceType, asset: assetId } };
  },
  project(rec) {
    return { id: rec.id, kind: 'resource', title: rec.title, resourceType: rec.payload.resourceType, assetId: rec.payload.assetId };
  },
};

// ── tool ────────────────────────────────────────────────────────────────────
// Make a tool available to the fleet. Governance of pack tools works today; adding
// a NEW tool per-item from org-config needs the shell seam (an index-merge in
// catalog/sync.ts, plans/19 §4) - until then the CP serves it in its own catalog.
const tool: KindHandler = {
  kind: 'tool',
  label: 'Tool',
  summary: 'Publish a tool (data: manifest + template + hooks) to selected groups.',
  shellSupport: 'needs-seam',
  envelope(payload) {
    const toolId = str(get(payload, 'toolId'));
    if (!toolId || !SLUG.test(toolId)) return { ok: false, reason: 'toolId must be a lowercase slug' };
    const source = str(get(payload, 'source'));
    if (source !== 'catalog' && source !== 'url') return { ok: false, reason: 'source must be "catalog" or "url"' };
    if (source === 'url') {
      const ref = str(get(payload, 'ref'));
      if (!ref) return { ok: false, reason: 'ref (the tool URL) is required when source is "url"' };
      // Same guard as chrome.link.href - a tool ref must be a real fetchable URL,
      // never a javascript:/data: scheme the shell might treat as active.
      if (!safeHref(ref)) return { ok: false, reason: 'ref must be a relative path or http(s) URL' };
    }
    return { ok: true, facts: { tool: toolId, source } };
  },
  project(rec) {
    const source = rec.payload.source;
    return { id: rec.id, kind: 'tool', title: rec.title, toolId: rec.payload.toolId, source, ...(rec.payload.ref ? { ref: rec.payload.ref } : {}) };
  },
};

// ── chrome ──────────────────────────────────────────────────────────────────
// Declarative UI chrome - a banner/nav-item/panel described by DATA, rendered by
// shell-owned code (the org/banner.ts precedent). NEEDS an OSS seam to generalize
// that renderer (plans/19 §4). Text is plain text: a payload carrying markup is
// refused, because a descriptor must never smuggle code into the shell realm.
const CHROME_SLOTS = new Set(['banner', 'nav', 'panel']);
const CHROME_TONES = new Set(['info', 'warn', 'accent']);
const chrome: KindHandler = {
  kind: 'chrome',
  label: 'UI chrome',
  summary: 'A declarative banner / nav item / panel (data, never code).',
  shellSupport: 'needs-seam',
  envelope(payload) {
    const slot = str(get(payload, 'slot'));
    if (!slot || !CHROME_SLOTS.has(slot)) return { ok: false, reason: `slot must be one of ${[...CHROME_SLOTS].join(', ')}` };
    const text = str(get(payload, 'text'));
    if (!text) return { ok: false, reason: 'text is required' };
    if (/[<>]/.test(text)) return { ok: false, reason: 'text must be plain text — markup is not allowed (data, not code)' };
    const tone = str(get(payload, 'tone'));
    if (tone && !CHROME_TONES.has(tone)) return { ok: false, reason: `tone must be one of ${[...CHROME_TONES].join(', ')}` };
    const link = get(payload, 'link');
    if (link !== undefined) {
      const label = str(get(link, 'label'));
      const href = str(get(link, 'href'));
      if (!label || !href) return { ok: false, reason: 'link needs both label and href' };
      if (hasMarkup(label)) return { ok: false, reason: 'link.label must be plain text — markup is not allowed' };
      if (!safeHref(href)) return { ok: false, reason: 'link.href must be a relative path, hash, or http(s) URL' };
    }
    return { ok: true, facts: { slot, ...(tone ? { tone } : {}) } };
  },
  project(rec) {
    const { slot, tone, text, link } = rec.payload;
    // Reconstruct link from ONLY the two validated fields - never pass the raw
    // object through, so an extra key (onclick, target, …) can never reach the shell.
    const safeLink = link && typeof link === 'object'
      ? { link: { label: str(get(link, 'label')), href: str(get(link, 'href')) } }
      : {};
    return { id: rec.id, kind: 'chrome', title: rec.title, slot, ...(tone ? { tone } : {}), text, ...safeLink };
  },
};

/** All handlers, by kind. */
export const KIND_HANDLERS: Record<InjectableRecord['kind'], KindHandler> = { flag, resource, tool, chrome };
