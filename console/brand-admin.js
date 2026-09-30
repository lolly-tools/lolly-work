/** Design-system source inventory and the server's reviewed change flow. */
export function brandSourcesCard(inventory, { el, api, changed, toast }) {
  if (!inventory?.sources) return null;
  const panel = el('div', { class: 'card stack' },
    el('h2', {}, 'Design-system sources'),
    el('p', { class: 'sub' }, 'Select the deployment default, retire a source, or stop its connect download. Saved work and source files remain.'),
    inventory.limitation ? el('p', { role: 'status' }, inventory.limitation) : null);
  const reviewPanel = el('div', { class: 'stack', 'aria-live': 'polite' });
  const labels = { select: 'Use as default', retire: 'Retire source', restore: 'Restore source',
    'stop-download': 'Stop offering download', 'enable-download': 'Offer download again' };
  async function review(change) {
    reviewPanel.replaceChildren(el('p', {}, 'Checking the impact…'));
    try {
      const result = await api('/api/v1/brand/changes/preview', { method: 'POST', body: change });
      const impact = result.impact;
      const apply = el('button', { class: 'btn', ...(result.blockers.length ? { disabled: '' } : {}), onclick: async () => {
        apply.disabled = true;
        try {
          await api('/api/v1/brand/changes', { method: 'POST', body: { ...change, revision: result.revision, reviewToken: result.reviewToken } });
          toast('Design-system settings updated');
          await changed();
        } catch (error) { reviewPanel.replaceChildren(el('p', { role: 'alert' }, error.message), el('button', { class: 'btn', onclick: () => review(change) }, 'Review again')); }
      } }, 'Apply reviewed change');
      reviewPanel.replaceChildren(
        el('h3', {}, labels[change.action]),
        el('p', {}, `Deployment default: ${impact.from.label} → ${impact.to.label}`),
        el('p', {}, `${impact.removedAssets.length} assets and ${impact.removedTools.length} tools would leave the served catalogue. ${impact.sharedAssets.length} asset IDs remain shared; ${impact.changedAssets.length} change content.`),
        el('p', {}, `${impact.affectedSessions} saved sessions and ${impact.affectedLinks} links may refer to changed or departing content. ${impact.publishedAssets} published assets and ${impact.publishedVersions} version records may contain references.`),
        ...(impact.downloadWithdrawn ? [el('p', {}, 'The connect download will stop being offered.')] : []),
        el('p', {}, 'Source files, saved sessions and personal uploads are retained.'),
        ...impact.limits.map(text => el('p', { class: 'sub' }, text)),
        ...result.blockers.map(text => el('p', { role: 'alert' }, text)),
        el('div', { class: 'brand-source-actions' }, apply, el('button', { class: 'btn', onclick: () => reviewPanel.replaceChildren() }, 'Cancel')));
    } catch (error) { reviewPanel.replaceChildren(el('p', { role: 'alert' }, error.message)); }
  }
  for (const source of inventory.sources) {
    const row = el('div', { class: 'stack brand-source-row' },
      el('strong', {}, source.label),
      el('span', { class: 'sub' }, `${source.kind}${source.active ? ' · active' : ''}${source.retired ? ' · retired' : ''}`),
      source.tokensHead ? el('span', { class: 'mono' }, source.tokensHead) : null,
      source.namespaces?.length ? el('p', { class: 'sub' }, `Catalogue namespaces: ${source.namespaces.join(', ')}`) : null,
      source.revision ? el('details', {}, el('summary', {}, 'Source revision'), el('code', {}, String(source.revision))) : null,
      ...(source.diagnostics ?? []).map(text => el('p', { class: 'sub' }, text)));
    const actions = el('div', { class: 'brand-source-actions' });
    let replacement;
    if (source.active && source.operations.retire) {
      replacement = el('select', { 'aria-label': `Replacement for ${source.label}` },
        el('option', { value: '' }, 'Choose a replacement'),
        ...inventory.sources.filter(s => s.id !== source.id && s.operations?.select)
          .map(s => el('option', { value: s.id }, s.label)));
      actions.append(replacement);
    }
    for (const [action, available] of Object.entries(source.operations)) {
      if (!available || !labels[action]) continue;
      actions.append(el('button', { class: 'btn', onclick: () => review({ action, sourceId: source.id,
        ...(action === 'retire' && replacement?.value ? { replacementId: replacement.value } : {}) }) }, labels[action]));
    }
    row.append(actions);
    panel.append(row);
  }
  panel.append(reviewPanel);
  return panel;
}


/** Honour the server's explicit head, including its neutral null value. */
export function catalogTokensAsset(index) {
  const tokens = (index?.assets ?? []).filter(asset => asset.type === 'tokens');
  if ('brandTokens' in (index ?? {})) return tokens.find(asset => asset.id === index.brandTokens) ?? null;
  const heads = tokens.filter(asset => !tokens.some(other => other.id !== asset.id && asset.id.startsWith(`${other.id}/`)));
  return heads.length === 1 ? heads[0] : null;
}
