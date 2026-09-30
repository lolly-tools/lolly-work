/** Reviewed input mappings for the active managed design system. */
export function brandRulesCard(data, { el, api, changed, toast }) {
  if (!data) return null;
  const card = el('section', { class: 'card stack' }, el('h2', {}, 'Usage & rules'),
    el('p', { class: 'sub' }, data.coverage));
  if (!data.system) {
    card.append(el('p', {}, data.unsupported ? 'This guide version is retained but cannot be checked here. Required coverage remains unknown.' : 'No production rules are published in this design system yet. Add them in Lolly, then publish the updated source.'));
    return card;
  }
  card.append(el('p', {}, `${data.system.label}: ${data.system.rules.length} published rules. Your brand’s role names stay unchanged.`));
  card.append(el('details', {}, el('summary', {}, 'Published rules'), ...data.system.rules.map(rule => el('div', { class: 'stack brand-source-row' },
    el('strong', {}, rule.label), el('span', { class: 'sub' }, `${rule.kind} · ${rule.requirement} · ${rule.review.state}`),
    el('p', {}, rule.description || 'Applies only within its declared tool, mode and output scope.')))));
  if (!data.editable) { card.append(el('p', { class: 'sub' }, 'Read-only. A policy editor can review tool mappings.')); return card; }
  let mappings = structuredClone(data.mappings);
  const rows = el('div', { class: 'stack' });
  const review = el('div', { class: 'stack', 'aria-live': 'polite' });
  const invalidate = () => review.replaceChildren();
  const examples = [['brand-poster', 'Poster'], ['brand-slide-title', 'Title slide'], ['brand-slide-content', 'Content slide'], ['brand-chart', 'Chart']];
  const slots = [['accent', 'Accent colour'], ['type', 'Font family'], ['device', 'Artwork input'], ['heading', 'Heading text'], ['body', 'Supporting text']];
  function draw() {
    rows.replaceChildren();
    for (const mapping of mappings) {
      const tool = data.tools.find(t => t.id === mapping.toolId);
      const field = (label, control) => el('label', { class: 'field' }, el('span', {}, label), control);
      const example = el('select', { onchange: () => { mapping.example = example.value; invalidate(); } }, ...examples.map(([id, label]) => el('option', { value: id, ...(mapping.example === id ? { selected: '' } : {}) }, label)));
      const mode = el('select', { onchange: () => { mapping.mode = mode.value; invalidate(); } },
        ...(!data.modes.includes(mapping.mode) ? [el('option', { value: mapping.mode, selected: '', disabled: '' }, `${mapping.mode} (unavailable)`)] : []),
        ...data.modes.map(name => el('option', { value: name, ...(mapping.mode === name ? { selected: '' } : {}) }, name)));
      const row = el('div', { class: 'stack brand-source-row' }, el('strong', {}, tool?.name || mapping.toolId),
        el('div', { class: 'brand-rule-grid' }, field('Example roles to map', example), field('Token mode', mode)));
      const fields = el('div', { class: 'brand-rule-grid' });
      for (const [slot, label] of slots) {
        const types = slot === 'device' ? ['asset', 'select'] : slot === 'accent' ? ['color', 'select', 'text'] : ['text', 'longtext', 'select'];
        const options = (tool?.inputs ?? []).filter(i => types.includes(i.type));
        const select = el('select', { onchange: () => { if (select.value) mapping.fields[slot] = select.value; else delete mapping.fields[slot]; invalidate(); } },
          el('option', { value: '' }, 'Not mapped'), ...options.map(i => el('option', { value: i.id, ...(mapping.fields[slot] === i.id ? { selected: '' } : {}) }, i.label || i.id)));
        fields.append(field(label, select));
      }
      row.append(fields, el('button', { class: 'btn', onclick: () => { mappings = mappings.filter(m => m !== mapping); invalidate(); draw(); } }, 'Remove mapping'));
      rows.append(row);
    }
  }
  const picker = el('select', { 'aria-label': 'Installed tool to map' }, el('option', { value: '' }, 'Choose an installed tool'),
    ...data.tools.map(tool => el('option', { value: tool.id }, tool.name)));
  card.append(el('h3', {}, 'Connect rules to tool inputs'),
    el('p', { class: 'sub' }, 'Map only fields that serve the named purpose. These checks constrain input values; they do not certify the rendered appearance. Missing required checks produce visibly marked drafts. Existing organisation restrictions still apply.'),
    rows, el('div', { class: 'brand-source-actions' }, picker, el('button', { class: 'btn', onclick: () => {
      if (!picker.value || mappings.some(m => m.toolId === picker.value)) return;
      mappings.push({ toolId: picker.value, example: 'brand-poster', mode: 'Default', fields: {} }); invalidate(); draw();
    } }, 'Add tool')),
    el('button', { class: 'btn', onclick: async event => {
      const button = event.currentTarget; button.disabled = true;
      const candidate = structuredClone(mappings);
      review.replaceChildren(el('p', {}, 'Checking mappings and current policy…'));
      try {
        const result = await api('/api/v1/brand/rules/preview', { method: 'POST', body: { mappings: candidate } });
        if (JSON.stringify(candidate) !== JSON.stringify(mappings)) return invalidate();
        review.replaceChildren(el('h3', {}, 'Review managed input coverage'),
          ...result.coverage.map(tool => el('div', { class: 'stack' }, el('strong', {}, tool.toolId), ...tool.outputs.map(output => {
            const applicable = output.rules.filter(r => r.enforced && r.state !== 'outside');
            const supported = applicable.filter(r => r.constraint && candidate.find(m => m.toolId === tool.toolId)?.fields[r.constraint.slot] && r.constraint.kind !== 'fixed-artwork').length;
            return el('p', { class: 'sub' }, `${output.format.toUpperCase()}: ${supported} required input checks mapped; ${applicable.length - supported} required checks remain unknown.`);
          }))),
          el('p', {}, 'Apply these mappings to the current source revision? Conflicting organisation restrictions still block; this review does not approve an output.'),
          el('button', { class: 'btn', onclick: async event => {
            event.currentTarget.disabled = true;
            try {
              await api('/api/v1/brand/rules', { method: 'POST', body: { mappings: candidate, revision: result.revision, reviewToken: result.reviewToken } });
              toast('Managed rule mappings updated'); await changed();
            } catch (error) { review.replaceChildren(el('p', { role: 'alert' }, error.message)); }
          } }, 'Apply reviewed mappings'), el('button', { class: 'btn', onclick: invalidate }, 'Cancel'));
      } catch (error) { review.replaceChildren(el('p', { role: 'alert' }, error.message)); }
      finally { button.disabled = false; }
    } }, 'Review mappings'), review);
  draw();
  return card;
}
