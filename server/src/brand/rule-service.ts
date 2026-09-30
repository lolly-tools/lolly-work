import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store, UserRecord } from '../store/types.ts';
import { loadEngine } from '../render/contract.ts';
import { BrandError, type BrandService, type BrandSnapshot } from './service.ts';
import { hash, managedRuleContext, projectRuleOverlay, ruleApi, sourceRules } from './rules.ts';

export function createBrandRuleService(brand: BrandService, store: Store, development: boolean) {
  const mutable = store.brandPersistence === 'durable' || development;
  const requireEditor = async (actor: UserRecord) => {
    if (!await brand.allowed(actor, 'policy.edit')) throw new BrandError('policy.edit required', 403, 'FORBIDDEN');
    if (!mutable) throw new BrandError('Durable storage is required outside development mode.');
  };
  const manifest = async (snap: BrandSnapshot, toolId: string) => JSON.parse(await readFile(join(snap.source.root, 'tools', toolId, 'tool.json'), 'utf8'));
  const modes = async (doc: unknown) => [...new Set(['Default', ...(await loadEngine()).createTokenSet(doc).themes().map(theme => theme.name)])];
  const inspect = async (actor: UserRecord) => {
    if (!await brand.allowed(actor, 'catalog.read')) throw new BrandError('catalog.read required', 403, 'FORBIDDEN');
    const snap = await brand.snapshot(), { system, present, doc } = await sourceRules(snap);
    const editable = mutable && await brand.allowed(actor, 'policy.edit');
    const tools = editable ? await Promise.all(snap.source.toolIds.map(async id => {
      const tool = await manifest(snap, id);
      return { id, name: tool.name ?? id, inputs: (tool.inputs ?? []).filter((i: { type: string }) => ['color', 'select', 'text', 'longtext', 'asset'].includes(i.type)).map((i: { id: string; label: string; type: string }) => ({ id: i.id, label: i.label, type: i.type })) };
    })) : [];
    return { revision: snap.state.revision, contentRevision: snap.revision, editable, system, unsupported: present && !system,
      mappings: snap.state.rulePolicies?.[snap.source.id]?.mappings ?? [], tools, modes: system ? await modes(doc) : [],
      coverage: 'Runtime input choices and lengths; output appearance needs separate production checks.' };
  };
  const preview = async (actor: UserRecord, raw: unknown) => {
    await requireEditor(actor);
    let mappings;
    try { mappings = ruleApi.parseBrandPolicyMappings(raw); } catch (e) { throw new BrandError((e as Error).message, 400, 'INVALID_INPUT'); }
    const snap = await brand.snapshot(), { system, doc } = await sourceRules(snap);
    if (!system) throw new BrandError('Publish a supported guide in the mounted design system first.');
    const publishedModes = await modes(doc);
    const manifests: Record<string, string> = {};
    for (const m of mappings) {
      if (!publishedModes.includes(m.mode)) throw new BrandError('Choose a published token mode.', 400, 'INVALID_INPUT');
      if (!snap.source.toolIds.includes(m.toolId)) throw new BrandError('Choose an installed tool.', 400, 'INVALID_INPUT');
      const tool = await manifest(snap, m.toolId); manifests[m.toolId] = hash(tool);
      for (const [slot, id] of Object.entries(m.fields)) {
        const field = (tool.inputs ?? []).find((i: { id: string }) => i.id === id);
        const types = slot === 'device' ? ['asset', 'select'] : slot === 'accent' ? ['color', 'select', 'text'] : ['text', 'longtext', 'select'];
        if (!field || !types.includes(field.type)) throw new BrandError(`Choose a compatible declared input for ${slot}.`, 400, 'INVALID_INPUT');
      }
    }
    const coverage = mappings.map(m => ({ toolId: m.toolId, outputs: ['png', 'svg', 'jpg', 'pdf'].map(format => ({ format, rules: ruleApi.resolveBrandPolicy(system, doc, m.toolId, format, m) })) }));
    const result = { mappings, manifests, coverage, sourceId: snap.source.id, sourceRevision: snap.source.revision,
      revision: snap.state.revision, policyDigest: hash([...await store.listOverlays()]), reviewedBy: actor.id };
    return { ...result, reviewToken: hash(result) };
  };
  const apply = async (actor: UserRecord, raw: unknown, revision: number, reviewToken: string) => {
    const reviewed = await preview(actor, raw);
    if (reviewed.revision !== revision || reviewed.reviewToken !== reviewToken) throw new BrandError('The rule preview is stale. Review again.', 409, 'STALE_PREVIEW');
    const before = await store.getBrandState();
    const next = { ...before, rulePolicies: { ...before.rulePolicies, [reviewed.sourceId]: { sourceRevision: reviewed.sourceRevision, mappings: reviewed.mappings, manifests: reviewed.manifests, reviewedBy: actor.id } } };
    const result = await store.casBrandState(revision, next, { at: new Date().toISOString(), actor: `user:${actor.id}`, action: 'brand.rules.update', subject: reviewed.sourceId, payload: { before: before.rulePolicies ?? {}, after: next.rulePolicies, sourceRevision: reviewed.sourceRevision } });
    if (!result) throw new BrandError('The rule preview is stale. Review again.', 409, 'STALE_PREVIEW');
    return { ok: true, revision: result.revision };
  };
  const project = async (snap: BrandSnapshot, groups: string[]) => {
    const overlays = await store.listOverlays();
    for (const mapping of snap.state.rulePolicies?.[snap.source.id]?.mappings ?? []) {
      // Scope-specific restrictions cannot be presented as unconditional input restrictions.
      const contexts = await Promise.all(['png', 'svg', 'jpg', 'pdf'].map(format => managedRuleContext(snap, mapping.toolId, format)));
      const first = contexts[0];
      if (!first || contexts.some(c => hash(c?.results) !== hash(first.results))) continue;
      const projected = projectRuleOverlay(overlays.get(mapping.toolId), first, groups);
      if (projected) overlays.set(mapping.toolId, projected);
    }
    return overlays;
  };
  return { inspect, preview, apply, project };
}
