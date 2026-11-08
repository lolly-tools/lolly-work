/** The tool policy form, preserving settings that it does not edit. */
export function createToolPolicyEditor(tool, { el, field, api, chains, onSaved, onClose, announce = () => {} }) {
  const original = structuredClone(tool.overlay ?? {});
  const showValue = (value) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const showGroups = (groups) => groups.some((group) => group.includes(',') || group.trim().startsWith('['))
    ? JSON.stringify(groups) : groups.join(', ');
  const model = Object.assign(Object.create(null), Object.fromEntries(Object.entries(original.inputAccess ?? {}).map(([id, rules]) => [id, rules.map((rule) => ({
    groups: showGroups(rule.groups), groupsText: showGroups(rule.groups), level: rule.level,
    value: showValue(rule.value), allow: JSON.stringify(rule.allow ?? []), reason: rule.reason ?? '',
    original: structuredClone(rule), valueText: showValue(rule.value),
    allowText: JSON.stringify(rule.allow ?? []),
  }))])));
  const nameInput = el('input', { value: original.name ?? '', placeholder: 'e.g. Brand guardrails' });
  const visibilityText = original.visibility ? showGroups(original.visibility.groups) : '';
  const visibilityInput = el('input', { value: visibilityText, placeholder: 'everyone (or: brand, marketing)' });
  const watermarkSel = el('select', {},
    ...[['', 'No rule'], ['never', 'Never watermark'], ['always', 'Always watermark'], ['until-approved', 'Until approved'],
    ].map(([value, label]) => el('option', { value, selected: value === (original.enforce?.watermark ?? '') ? '' : null }, label)));
  const savedChain = original.enforce?.escalation ?? '';
  const chainSel = el('select', {}, el('option', { value: '' }, 'No chain'),
    ...(savedChain ? [el('option', { value: savedChain, selected: '' }, savedChain)] : []));
  // What one approval covers (plans/82 M7): one file, the default, or every file
  // made from one version of a published template of this tool.
  const coversSel = el('select', {},
    ...[['', 'This file only'], ['template-variants', 'Every file from one version of a published template']]
      .map(([value, label]) => el('option', { value, selected: value === (original.enforce?.approvalCovers ?? '') ? '' : null }, label)));
  const coversNote = el('p', { class: 'sub flush', role: 'status' });
  const watermarkWarning = el('p', { class: 'policy-warning', role: 'status' });
  const rulesHost = el('div');
  const error = el('p', { class: 'form-err', role: 'alert' });
  const draft = el('span', { class: 'muted', role: 'status' });
  const discardPanel = el('div', { class: 'policy-discard', 'aria-live': 'polite' });
  const controls = new Map();
  const warningNodes = new Map();
  const declared = (tool.inputs ?? []).map((input) => input.id);
  const groupsOf = (text, control) => {
    let groups = text.split(',');
    if (text.trim().startsWith('[')) {
      try {
        groups = JSON.parse(text);
        if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string')) throw new Error();
      } catch {
        if (control) invalid('Groups must be a JSON array of names or a comma-separated list.', control);
        return [];
      }
    }
    return [...new Set(groups.map((group) => group.trim()).filter(Boolean))];
  };
  // Inputs that take a partner company's values (plans/82 M3), one select per input.
  const COMPANY_FIELDS = [['name', 'Company name'], ['logo', 'Logo (by mode)'], ['logoLight', 'Logo for light surfaces'],
    ['logoDark', 'Logo for dark surfaces'], ['mark', 'Mark'], ['website', 'Website'], ['contact', 'Contact'], ['contactEmail', 'Contact email'],
    ['contactPhone', 'Contact phone'], ['address', 'Address'], ['currency', 'Currency'], ['taxNote', 'Tax note']];
  const LOGO_FIELDS = new Set(['logo', 'logoLight', 'logoDark', 'mark']);
  // Only inputs that can hold a company detail: text, a link or a picture. One
  // already bound stays listed whatever its type, so it can be cleared.
  const bindable = (input) => !input.type || ['text', 'longtext', 'url', 'asset'].includes(input.type) || !!original.bindings?.[input.id];
  // A picture input takes a logo or the mark, a text input takes a detail. The
  // current choice stays listed so it can be kept or cleared.
  const choicesFor = (input) => COMPANY_FIELDS.filter(([value]) => !input.type || value === original.bindings?.[input.id]
    || (input.type === 'asset' ? LOGO_FIELDS.has(value) : !LOGO_FIELDS.has(value)));
  const bindingSelects = new Map((tool.inputs ?? []).filter(bindable).map((input) => [input.id, el('select', { 'aria-label': `What ${input.label ?? input.id} takes from the company` },
    ...[['', 'Not from the company'], ...choicesFor(input)].map(([value, label]) => el('option', { value, selected: value === (original.bindings?.[input.id] ?? '') ? '' : null }, label)))]));
  // Defaults saved before they applied are kept and change nothing until the
  // person editing chooses to apply them.
  const legacyDefaults = !!original.defaults && !Array.isArray(original.defaults) && Object.keys(original.defaults).length > 0;
  const applyLegacy = el('input', { type: 'checkbox' });
  let busy = false;
  let disposed = false;
  const snapshot = () => JSON.stringify({ name: nameInput.value, visibility: visibilityInput.value, watermark: watermarkSel.value, chain: chainSel.value, covers: coversSel.value,
    bindings: [...bindingSelects].map(([id, sel]) => [id, sel.value]), applyLegacy: applyLegacy.checked,
    inputs: Object.entries(model).map(([id, rules]) => [id, rules.map(({ groups, level, value, allow, reason }) => ({ groups, level, value, allow, reason }))]) });
  let baseline = snapshot();
  const isDirty = () => !disposed && snapshot() !== baseline;
  const update = () => {
    draft.textContent = isDirty() ? 'Unsaved changes' : '';
    watermarkWarning.textContent = watermarkSel.value !== 'until-approved' ? ''
      : chainSel.value ? 'Server renders show PREVIEW until a reviewer approves a file with the same inputs.'
      : 'No approval chain is set, so nobody can approve this tool and its server renders stay marked. Choose a chain.';
    watermarkWarning.hidden = !watermarkWarning.textContent;
    coversNote.textContent = coversSel.value === 'template-variants'
      ? 'One approval covers every file made from one version of a published template of this tool, whatever the inputs partners may change. The reviewer sees one file as the example. A new template version needs a new approval.'
      : 'One approval covers one file’s exact inputs.';
    for (const [id, nodes] of warningNodes) {
      const rules = model[id];
      nodes.forEach((node, index) => {
        const groups = groupsOf(rules[index].groups);
        const earlier = rules.slice(0, index).map((rule) => groupsOf(rule.groups));
        const everyone = earlier.findIndex((set) => set.includes('*'));
        const covered = groups.filter((group) => earlier.some((set) => set.includes(group)));
        node.textContent = everyone >= 0
          ? `Rule ${index + 1} will never apply because rule ${everyone + 1} matches everyone. Move this rule above it to make an exception.`
          : covered.length ? `${covered.length === groups.length ? 'All' : 'Some'} groups in rule ${index + 1} match earlier rules: ${covered.join(', ')}. The earlier match wins.` : '';
        node.hidden = !node.textContent;
      });
    }
  };
  for (const control of [nameInput, visibilityInput, watermarkSel]) control.addEventListener('input', update);
  for (const sel of bindingSelects.values()) sel.addEventListener('change', update);
  applyLegacy.addEventListener('change', update);
  watermarkSel.addEventListener('change', update);
  chainSel.addEventListener('change', update);
  coversSel.addEventListener('change', update);
  // The list comes later; until then the saved chain stays selected and saves as it was.
  if (chains) {
    chainSel.setAttribute('aria-busy', 'true');
    void Promise.resolve(chains()).then((list) => {
      const named = new Map((list ?? []).map((chain) => [chain.id, chain.name || chain.id]));
      const chosen = chainSel.value;
      chainSel.replaceChildren(el('option', { value: '' }, 'No chain'),
        ...[...named].map(([id, label]) => el('option', { value: id, selected: id === chosen ? '' : null }, label)),
        ...(chosen && !named.has(chosen) ? [el('option', { value: chosen, selected: '' }, `${chosen} (not found)`)] : []));
    }).catch(() => {}).finally(() => { chainSel.removeAttribute('aria-busy'); });
  }
  const invalid = (message, control) => { throw Object.assign(new Error(message), { control }); };
  const parseValue = (text) => { try { return JSON.parse(text.trim()); } catch { return text; } };
  const bodyOf = () => {
    const unknown = [
      ...Object.keys(original).filter((key) => !['toolId', 'version', 'name', 'inputAccess', 'visibility', 'enforce', 'defaults', 'bindings'].includes(key)),
      ...Object.keys(original.enforce ?? {}).filter((key) => !['watermark', 'formats', 'escalation', 'approvalCovers'].includes(key)).map((key) => `enforce.${key}`),
    ];
    if (unknown.length) invalid(`This policy contains settings the policy writer cannot save: ${unknown.join(', ')}. Saving is blocked to avoid removing them.`);
    const body = structuredClone(original);
    for (const key of ['toolId', 'version', 'name', 'inputAccess', 'visibility', 'enforce']) delete body[key];
    if (nameInput.value.trim()) body.name = nameInput.value.trim();
    const inputAccess = Object.create(null);
    for (const [id, rules] of Object.entries(model)) {
      if (!rules.length) continue;
      inputAccess[id] = rules.map((rule, index) => {
        const refs = controls.get(id)[index];
        const groups = rule.groups === rule.groupsText && Array.isArray(rule.original.groups)
          ? structuredClone(rule.original.groups) : groupsOf(rule.groups, refs.groups);
        if (!groups.length) invalid(`Rule ${index + 1} for ${id} needs at least one group. Use * for everyone, or remove the rule explicitly.`, refs.groups);
        const entry = { groups, level: rule.level };
        if (rule.reason.trim()) entry.reason = rule.reason.trim();
        if (rule.level === 'locked') {
          if (rule.value === rule.valueText && rule.original.level === 'locked') {
            if (Object.hasOwn(rule.original, 'value')) entry.value = structuredClone(rule.original.value);
          } else entry.value = parseValue(rule.value);
        }
        if (rule.level === 'choice') {
          let allow;
          if (rule.allow === rule.allowText && Array.isArray(rule.original.allow)) allow = structuredClone(rule.original.allow);
          else if (rule.allow.trim().startsWith('[')) {
            try { allow = JSON.parse(rule.allow); } catch { invalid(`Allowed choices for ${id} must be a valid JSON array.`, refs.detail); }
          } else allow = rule.allow.split(',').map((text) => text.trim()).filter(Boolean).map(parseValue);
          if (!Array.isArray(allow) || !allow.length) invalid(`Add at least one allowed choice for ${id}.`, refs.detail);
          entry.allow = allow;
        }
        return entry;
      });
    }
    if (Object.keys(inputAccess).length) body.inputAccess = inputAccess;
    const visible = visibilityInput.value === visibilityText && original.visibility
      ? structuredClone(original.visibility.groups) : groupsOf(visibilityInput.value, visibilityInput);
    if (visible.length) body.visibility = { groups: visible };
    const enforce = { ...original.enforce };
    delete enforce.watermark;
    if (watermarkSel.value) enforce.watermark = watermarkSel.value;
    delete enforce.escalation;
    if (chainSel.value) enforce.escalation = chainSel.value;
    delete enforce.approvalCovers;
    if (coversSel.value) enforce.approvalCovers = coversSel.value;
    if (Object.keys(enforce).length) body.enforce = enforce;
    // An input the tool no longer declares keeps its binding as it was.
    const bindings = Object.fromEntries(Object.entries(original.bindings ?? {}).filter(([id]) => !bindingSelects.has(id)));
    for (const [id, sel] of bindingSelects) if (sel.value) bindings[id] = sel.value;
    if (Object.keys(bindings).length) body.bindings = bindings; else delete body.bindings;
    if (legacyDefaults && applyLegacy.checked) body.defaults = [{ groups: ['*'], values: structuredClone(original.defaults) }];
    return body;
  };
  const focusRule = (id, index) => {
    const group = controls.get(id)?.[index]?.groups;
    if (group) group.focus();
    else [...rulesHost.querySelectorAll('[data-input-id]')].find((node) => node.dataset.inputId === id)
      ?.querySelector('[data-action="add-rule"]').focus();
  };
  const renderRules = () => {
    controls.clear(); warningNodes.clear();
    rulesHost.replaceChildren(...[...new Set([...declared, ...Object.keys(model)])].map((id) => {
      const input = (tool.inputs ?? []).find((entry) => entry.id === id);
      controls.set(id, []); warningNodes.set(id, []);
      const rows = (model[id] ?? []).map((rule, index) => {
        const groups = el('input', { value: rule.groups, placeholder: '*', 'data-rule-groups': '',
          oninput: (event) => { rule.groups = event.target.value; update(); } });
        const level = el('select', { onchange: (event) => { rule.level = event.target.value; renderRules(); focusRule(id, index); } },
          ...['editable', 'choice', 'locked', 'hidden'].map((value) => el('option', { value, selected: rule.level === value ? '' : null }, value)));
        const detail = rule.level === 'locked'
          ? el('input', { value: rule.value, placeholder: 'preset value (JSON for typed values)', 'data-rule-value': '',
            oninput: (event) => { rule.value = event.target.value; update(); } })
          : rule.level === 'choice'
            ? el('input', { value: rule.allow, placeholder: '["blue", "green"] or blue, green', 'data-rule-choices': '',
              oninput: (event) => { rule.allow = event.target.value; update(); } })
            : el('span', { class: 'muted' }, rule.level === 'hidden' ? 'Hidden from these groups' : 'These groups can edit it freely');
        const reason = el('input', { value: rule.reason, placeholder: 'why (shown to the member)', 'data-rule-reason': '',
          oninput: (event) => { rule.reason = event.target.value; update(); } });
        controls.get(id).push({ groups, detail });
        const move = (offset) => {
          const next = index + offset;
          [model[id][index], model[id][next]] = [model[id][next], model[id][index]];
          renderRules(); focusRule(id, next); announce(`Rule moved to position ${next + 1} for ${id}`);
        };
        const warning = el('p', { class: 'policy-warning', role: 'status', 'data-rule-warning': '' });
        warningNodes.get(id).push(warning);
        return el('div', { class: 'policy-rule', 'data-rule-index': index },
          el('div', { class: 'formrow' }, field('Groups', groups), field('Access', level),
            field(rule.level === 'choice' ? 'Allowed choices' : 'Preset', detail), field('Reason', reason)),
          el('div', { class: 'policy-rule-actions' },
            el('span', { class: 'muted' }, `Rule ${index + 1}`),
            el('button', { type: 'button', disabled: index === 0 ? '' : null, 'data-action': 'move-up',
              'aria-label': `Move rule ${index + 1} up for ${id}`, onclick: () => move(-1) }, 'Move up'),
            el('button', { type: 'button', disabled: index === model[id].length - 1 ? '' : null, 'data-action': 'move-down',
              'aria-label': `Move rule ${index + 1} down for ${id}`, onclick: () => move(1) }, 'Move down'),
            el('button', { type: 'button', 'aria-label': `Remove rule ${index + 1} for ${id}`, 'data-action': 'remove-rule',
              onclick: () => { model[id].splice(index, 1); renderRules(); focusRule(id, Math.min(index, model[id].length - 1)); } }, 'Remove')),
          warning);
      });
      const add = el('button', { type: 'button', 'data-action': 'add-rule', onclick: () => {
        const rules = model[id] ??= [];
        const catchAll = rules.findIndex((rule) => groupsOf(rule.groups).includes('*'));
        const position = catchAll < 0 ? rules.length : catchAll;
        const value = showValue(input?.default);
        rules.splice(position, 0, { groups: rules.length ? '' : '*', level: 'locked', value, allow: '', reason: '',
          original: {}, valueText: value, allowText: '' });
        renderRules(); focusRule(id, position);
      } }, rows.length ? '+ rule' : 'Govern');
      return el('section', { class: 'policy-input', 'data-input-id': id, 'aria-label': `Rules for ${id}` },
        el('div', {}, el('strong', {}, id === '*' ? 'Default for all inputs (*)' : input?.label || id),
          ' ', el('span', { class: 'muted mono' }, id === '*' ? '' : id), ' ', add),
        input?.options?.length ? el('p', { class: 'muted' }, `Available choices: ${JSON.stringify(input.options)}`) : null,
        ...rows);
    }));
    if (!Object.hasOwn(model, '*')) rulesHost.append(el('button', { type: 'button', 'data-action': 'add-default', onclick: () => {
      model['*'] = [{ groups: '*', level: 'editable', value: '', allow: '', reason: '', original: {}, valueText: '', allowText: '' }];
      renderRules(); focusRule('*', 0);
    } }, '+ default rule for all inputs (*)'));
    update();
  };
  const requestDiscard = (proceed) => {
    if (busy) { discardPanel.replaceChildren(el('p', { role: 'status' }, 'Wait for the save to finish before leaving this editor.')); return; }
    if (!isDirty()) { proceed(); return; }
    const keep = el('button', { type: 'button', onclick: () => { discardPanel.replaceChildren(); saveBtn.focus(); } }, 'Keep editing');
    discardPanel.replaceChildren(el('p', {}, 'Discard your unsaved policy changes?'),
      keep, ' ', el('button', { type: 'button', 'data-action': 'discard', onclick: () => { baseline = snapshot(); proceed(); } }, 'Discard changes'));
    keep.focus();
  };
  const saveBtn = el('button', { type: 'button', class: 'primary', 'data-action': 'save', onclick: async () => {
    error.textContent = ''; discardPanel.replaceChildren();
    for (const control of root.querySelectorAll('[aria-invalid]')) control.removeAttribute('aria-invalid');
    try {
      const body = bodyOf();
      busy = true; fields.disabled = true; saveBtn.disabled = true; closeBtn.disabled = true;
      saveBtn.textContent = 'Saving…'; root.setAttribute('aria-busy', 'true');
      await api(`/api/v1/policy/overlays/${encodeURIComponent(tool.id)}`, { method: 'PUT', body });
      baseline = snapshot(); update(); onSaved();
    } catch (failure) {
      error.textContent = failure.message;
      if (failure.control) { failure.control.setAttribute('aria-invalid', 'true'); failure.control.focus(); }
    } finally {
      busy = false; fields.disabled = false; saveBtn.disabled = false; closeBtn.disabled = false;
      saveBtn.textContent = 'Save policy'; root.removeAttribute('aria-busy');
    }
  } }, 'Save policy');
  const closeBtn = el('button', { type: 'button', 'data-action': 'close', onclick: () => requestDiscard(onClose) }, 'Close');
  const fields = el('fieldset', { class: 'policy-fields' },
    el('legend', { class: 'sr-only' }, `Policy settings for ${tool.name}`),
    el('div', { class: 'formrow' }, field('Policy name (shown to members)', nameInput),
      field('Visible to groups (empty = everyone)', visibilityInput), field('Watermark', watermarkSel), field('Approval chain for exports', chainSel),
      field('One approval covers', coversSel)),
    watermarkWarning, coversNote,
    tool.inputs === null ? el('p', { class: 'empty' }, 'This tool’s input list is unavailable. Existing rules and the default rule remain editable.') : null,
    rulesHost);
  const root = el('div', { class: 'card stack tool-policy-editor' },
    el('h2', {}, `Policy for ${tool.name}`),
    el('p', { class: 'sub' }, 'The first rule matching a person’s groups wins. Put exceptions above rules for everyone. People with no matching rule can edit freely.'),
    el('p', { class: 'sub' }, 'Unchanged presets and choices keep their saved types. Use a JSON array for choices containing commas or typed values. A new blank preset locks to an empty string.'),
    el('p', { class: 'sub' }, 'Use a JSON array of group names when a name contains a comma, for example ["Sales, EMEA", "brand"].'),
    original.enforce?.formats?.length ? el('p', { class: 'sub' }, `Saved format restriction retained: ${original.enforce.formats.join(', ')}.`) : null,
    legacyDefaults ? el('div', { class: 'stack policy-defaults' },
      el('p', { class: 'sub flush' }, `This policy holds input defaults saved before defaults applied (${Object.keys(original.defaults).join(', ')}). They are kept and change nothing.`),
      el('label', { class: 'chk' }, applyLegacy, el('span', {}, 'Apply them for everyone when I save'))) : null,
    Array.isArray(original.defaults) && original.defaults.length
      ? el('p', { class: 'sub' }, `Input defaults apply: ${original.defaults.length} ${original.defaults.length === 1 ? 'rule' : 'rules'}, each for the groups it names. Saving keeps them.`) : null,
    fields,
    bindingSelects.size ? el('div', { class: 'stack policy-bindings' },
      el('h3', { class: 'flush' }, 'Takes from the company'),
      el('p', { class: 'sub flush' }, 'For partners, these inputs start from their company’s details. Where a rule locks the input for them, it is fixed to their company’s value.'),
      el('div', { class: 'formrow' }, ...[...bindingSelects].map(([id, sel]) => field((tool.inputs ?? []).find((i) => i.id === id)?.label ?? id, sel)))) : null,
    el('p', { class: 'policy-rule-actions' }, saveBtn, closeBtn, draft,
      el('a', { href: '#/preview' }, 'Preview what a group sees'), el('a', { href: '#/docs?doc=governance' }, 'How rules are ordered')),
    error, discardPanel);
  renderRules();
  const window = root.ownerDocument.defaultView;
  const beforeUnload = (event) => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return { element: root, isDirty, isBusy: () => busy, requestDiscard,
    dispose() { disposed = true; window.removeEventListener('beforeunload', beforeUnload); } };
}
