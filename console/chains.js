/** Ordered approval-chain editing and aggregate reviewer eligibility preview. */
export function createChainEditor(chain, { el, field, api, onSaved, onClose }) {
  const id = el('input', { value: chain?.id ?? '', readonly: chain ? '' : null, required: '', pattern: '[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}' });
  const name = el('input', { value: chain?.name ?? '' });
  const model = structuredClone(chain?.steps ?? [{ name: 'Review', approvers: { groups: [] }, rule: 'any' }])
    .map(step => ({ name: step.name, groups: JSON.stringify(step.approvers.groups), rule: typeof step.rule === 'object' ? 'quorum' : step.rule,
      quorum: typeof step.rule === 'object' ? String(step.rule.quorum) : '1' }));
  const rows = el('div');
  const error = el('p', { class: 'form-err', role: 'alert' });
  const preview = el('div', { 'aria-live': 'polite' });
  const discard = el('div', { class: 'policy-discard' });
  let busy = false, disposed = false;
  const snapshot = () => JSON.stringify({ id: id.value, name: name.value, steps: model });
  let baseline = snapshot();
  const isDirty = () => !disposed && baseline !== snapshot();
  const changed = () => { preview.replaceChildren(); draft.textContent = isDirty() ? 'Unsaved changes' : ''; };
  const render = () => {
    rows.replaceChildren(...model.map((step, index) => {
      const title = el('input', { value: step.name, oninput: e => { step.name = e.target.value; changed(); } });
      const groups = el('input', { value: step.groups, oninput: e => { step.groups = e.target.value; changed(); } });
      const rule = el('select', { onchange: e => { step.rule = e.target.value; changed(); } }, ...['any', 'quorum', 'all'].map(rule => el('option', { value: rule, selected: step.rule === rule ? '' : null }, rule)));
      const quorum = el('input', { type: 'number', min: 1, step: 1, value: step.quorum, oninput: e => { step.quorum = e.target.value; changed(); } });
      const move = offset => { [model[index], model[index + offset]] = [model[index + offset], model[index]]; render(); rows.children[index + offset]?.querySelector('input')?.focus(); changed(); };
      return el('section', { class: 'policy-rule' }, el('h3', {}, `Step ${index + 1}`),
        el('div', { class: 'formrow' }, field('Step name', title), field('Groups (JSON array of names)', groups), field('Decision rule', rule), field('Quorum count (quorum only)', quorum)),
        el('p', { class: 'policy-rule-actions' },
          el('button', { type: 'button', disabled: index === 0 ? '' : null, 'aria-label': `Move step ${index + 1} up`, onclick: () => move(-1) }, 'Move up'),
          el('button', { type: 'button', disabled: index === model.length - 1 ? '' : null, 'aria-label': `Move step ${index + 1} down`, onclick: () => move(1) }, 'Move down'),
          el('button', { type: 'button', disabled: model.length === 1 ? '' : null, onclick: () => { model.splice(index, 1); render(); changed(); } }, 'Remove step')));
    }));
  };
  const body = () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id.value)) throw new Error('Use a chain ID of up to 80 letters, numbers, dots, hyphens or underscores.');
    return { id: id.value, name: name.value.trim() || id.value, onReject: 'return-to-submitter', steps: model.map((step, index) => {
      let groups; try { groups = JSON.parse(step.groups); } catch { throw new Error(`Step ${index + 1} needs a JSON array of group names.`); }
      if (!Array.isArray(groups) || !groups.length || groups.some(group => typeof group !== 'string' || !group.trim())) throw new Error(`Step ${index + 1} needs at least one non-empty group name.`);
      const quorum = Number(step.quorum);
      if (step.rule === 'quorum' && (!Number.isSafeInteger(quorum) || quorum < 1)) throw new Error(`Step ${index + 1} needs a positive whole-number quorum.`);
      return { name: step.name.trim() || `Step ${index + 1}`, approvers: { groups: [...new Set(groups.map(group => group.trim()))] }, rule: step.rule === 'quorum' ? { quorum } : step.rule };
    }) };
  };
  const requestDiscard = proceed => {
    if (busy) { error.textContent = 'Wait for the request to finish before leaving.'; return; }
    if (!isDirty()) { proceed(); return; }
    const keep = el('button', { type: 'button', onclick: () => { discard.replaceChildren(); saveButton.focus(); } }, 'Keep editing');
    discard.replaceChildren(el('p', {}, 'Discard your unsaved chain changes?'), keep, ' ',
      el('button', { type: 'button', onclick: () => { baseline = snapshot(); proceed(); } }, 'Discard changes'));
    keep.focus();
  };
  const run = async save => {
    error.textContent = '';
    try {
      const data = body(); busy = true; fields.disabled = true; saveButton.disabled = true; closeButton.disabled = true;
      if (save) {
        await api(`/api/v1/chains/${encodeURIComponent(data.id)}`, { method: 'PUT', body: data });
        baseline = snapshot(); onSaved();
      } else {
        const result = await api('/api/v1/chains/preview', { method: 'POST', body: data });
        preview.replaceChildren(el('p', {}, result.viable ? 'Each step has enough eligible reviewers.' : 'Some steps cannot complete. Add eligible reviewers or change the quorum.'),
          ...result.steps.map(step => el('p', {}, `${step.name}: ${step.eligibleCount} eligible, ${step.otherEligibleCount} excluding you, ${step.required} required.`)),
          el('p', { class: 'sub' }, 'Reviewers need matching groups and approval.act permission. A requester cannot review their own request. The all rule follows the nominees chosen when submitting.'));
      }
    } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; fields.disabled = false; saveButton.disabled = false; closeButton.disabled = false; }
  };
  const draft = el('span', { role: 'status', class: 'muted' });
  const fields = el('fieldset', { class: 'policy-fields' }, el('legend', { class: 'sr-only' }, 'Approval chain settings'),
    el('div', { class: 'formrow' }, field('Chain ID', id), field('Name', name)), rows,
    el('button', { type: 'button', onclick: () => { model.push({ name: `Step ${model.length + 1}`, groups: '[]', rule: 'any', quorum: '1' }); render(); changed(); } }, 'Add step'),
    ' ', el('button', { type: 'button', onclick: () => void run(false) }, 'Preview reviewers'));
  const saveButton = el('button', { type: 'button', class: 'primary', onclick: () => void run(true) }, 'Save chain');
  const closeButton = el('button', { type: 'button', onclick: () => requestDiscard(onClose) }, 'Close');
  const element = el('section', { class: 'card stack tool-policy-editor' }, el('h2', {}, chain ? `Edit ${chain.name}` : 'New approval chain'),
    el('p', { class: 'sub' }, 'Steps run in order. Existing requests keep their submitted chain snapshot. These chains govern review requests; they do not currently restrict ordinary tool exports.'),
    fields, el('p', { class: 'policy-rule-actions' }, saveButton, closeButton, draft), preview, error, discard);
  id.addEventListener('input', changed); name.addEventListener('input', changed); render();
  const window = element.ownerDocument.defaultView;
  const beforeUnload = event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return { element, isDirty, isBusy: () => busy, requestDiscard, dispose() { disposed = true; window.removeEventListener('beforeunload', beforeUnload); } };
}
