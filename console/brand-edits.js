// SPDX-License-Identifier: MPL-2.0
/**
 * What this instance serves on top of its mounted pack: the state, the history with
 * what each revision changed, a rollback, and the two switches an administrator can
 * turn on. Recording what happened is always on. Anything that asks a person to act
 * is off until someone turns it on here, and each switch says what it does.
 */
const STATE_CHIP = {
  live: ['live', 'Live'], pending: ['review', 'Waiting for approval'], superseded: ['', 'Replaced'], 'rolled-back': ['', 'Rolled back'],
  rejected: ['revoked', 'Rejected'], withdrawn: ['', 'Withdrawn'], failed: ['revoked', 'Did not finish'], staged: ['review', 'Storing'],
};
const ACTION_WORD = { added: 'Added', changed: 'Changed', removed: 'Removed' };
const isColour = (value) => typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z-]+\([^;{}<>]*\)|[a-z]{3,32})$/i.test(value) && (globalThis.CSS?.supports?.('color', value) ?? true);

/** One change, as the console shows it everywhere: what it is called, then before and after. */
export function brandEditLine(el, line) {
  const value = (text) => text ? el('span', { class: 'bedit-value' }, isColour(text) ? el('span', { class: 'bedit-swatch', style: `background:${text}` }) : null, text) : null;
  return el('div', { class: 'bedit-line' },
    el('span', { class: 'muted' }, ACTION_WORD[line.action] ?? line.action),
    line.label ? el('span', {}, line.label) : null,
    el('span', { class: 'mono' }, line.name),
    value(line.before),
    line.before && line.after ? el('span', { class: 'muted', 'aria-label': 'to' }, '→') : null,
    value(line.after));
}

export function brandEditsCard(state, { el, api, toast, changed, relTime, armConfirmButton, lollyHref, chainsHref = '#/chains', fleetHref = '#/fleet', approvalsHref = '#/approvals' }) {
  if (!state) return null;
  const card = el('section', { class: 'card stack bedit' });
  const errors = el('p', { class: 'form-err', role: 'status' });
  const chip = (name) => {
    const [cls, label] = STATE_CHIP[name] ?? ['', name];
    return el('span', { class: `status ${cls}`.trim() }, label);
  };
  const act = async (work) => {
    errors.textContent = '';
    try { await work(); await changed(); }
    catch (error) { errors.textContent = error.message; }
  };

  const edit = state.edit;
  const serving = edit && (edit.state === 'current' || edit.state === 'on-new-image');
  card.append(el('div', { class: 'list-bar' },
    el('h2', { class: 'flush' }, 'Edits on this instance'),
    serving ? el('span', { class: 'status live' }, 'Serving this edit') : edit ? el('span', { class: 'status revoked' }, "Serving the image's own colours") : el('span', { class: 'status' }, "The image's own colours")));

  if (!state.available) {
    card.append(el('p', {}, state.limitation ?? 'This source has no tokens file to edit.'));
    return card;
  }
  if (!edit) {
    card.append(el('p', {}, "This instance serves its image's own colours, with no edit on top."),
      el('p', { class: 'sub' }, 'To change colours, colour roles or the brand page address, open the design system in Lolly and choose Edit for this instance.'),
      lollyHref ? el('p', {}, el('a', { class: 'btn', href: lollyHref('/#/start'), target: '_blank', rel: 'noopener' }, 'Open in Lolly')) : null);
  } else {
    const sent = edit.sentByName ?? edit.sentBy;
    card.append(el('p', {}, serving
      ? `Revision ${edit.revision}, sent by ${sent ?? 'someone'}${edit.liveAt ? `, ${relTime(edit.liveAt)}` : ''}. The image's own colours are unchanged.`
      : `Revision ${edit.revision} is not in force.`),
    el('p', { class: 'mono bedit-digest' }, `SHA-256 ${edit.digest}`));
    if (edit.state === 'cannot-apply') {
      card.append(el('p', { role: 'status' }, `${edit.goneMessage} This instance is serving the image's own colours. The revision stays in the history, and a new edit can replace it.`));
    } else if (edit.state === 'unavailable') {
      card.append(el('p', { role: 'status' }, "The stored edit could not be read, so this instance is serving the image's own colours. The edit comes back once storage can be read."));
    } else if (edit.ask) {
      card.append(el('div', { class: 'bedit-ask', role: 'status' },
        el('p', { class: 'flush' }, 'A new image arrived. This edit stays live. Look at it, then keep it or roll it back.'),
        el('button', { class: 'btn', onclick: () => act(async () => { await api('/api/v1/brand/edits/keep', { method: 'POST', body: {} }); toast('Edit kept'); }) }, 'Keep this edit')));
    } else if (edit.state === 'on-new-image') {
      card.append(el('p', { class: 'sub' }, 'Made on an earlier image, and it stays on top of this one.'));
    }
    if (edit.overlaps?.length) card.append(el('p', { class: 'sub' }, `The image and the edit both changed ${edit.overlaps.join(', ')}. The edit stays on top.`));
    if (serving) {
      card.append(el('p', { class: 'sub' }, 'Previews and social cards keep their old colours until the next image.'));
      if (state.connect === 'derived') card.append(el('p', { class: 'sub' }, 'The connect download carries this edit, signed by this instance.'));
      if (state.connect === 'withdrawn') {
        card.append(el('p', { class: 'sub' }, 'New apps cannot download a connect pack until this edit is rolled back or a new pack is uploaded. Roll back here, or build a pack from the edited document and upload it under ',
          el('a', { class: 'link-btn', href: fleetHref }, 'Fleet'), '.'));
      }
    }
    card.append(el('div', { class: 'bedit-actions' },
      armConfirmButton({}, edit?.state === 'cannot-apply' ? 'Clear this edit' : 'Roll back this edit', edit?.state === 'cannot-apply' ? 'Really clear it?' : 'Really roll back?', async (disarm) => {
        errors.textContent = '';
        try { await api('/api/v1/brand/edits/rollback', { method: 'POST', body: {} }); toast('Rolled back'); await changed(); }
        catch (error) { errors.textContent = error.message; disarm(); }
      })));
  }
  if (state.pending) {
    card.append(el('p', {}, `Revision ${state.pending.n}, sent by ${state.pending.sentByName ?? state.pending.sentBy}, is waiting for approval. `, el('a', { class: 'link-btn', href: approvalsHref }, 'See approvals')));
  }

  // One plain switch per decision. Both start off.
  const settings = state.settings;
  const save = (next) => act(async () => { await api('/api/v1/brand/edits/settings', { method: 'PUT', body: { ...settings, ...next } }); toast('Saved'); });
  if (state.canChangeSettings) {
    const chains = state.chains ?? [];
    const firstChain = chains[0]?.id ?? null;
    const needsChain = el('input', { type: 'checkbox', id: 'bedit-approval', ...(settings.approvalChain ? { checked: '' } : {}), ...(!chains.length && !settings.approvalChain ? { disabled: '' } : {}),
      onchange: () => save({ approvalChain: needsChain.checked ? (settings.approvalChain ?? firstChain) : null }) });
    const look = el('input', { type: 'checkbox', id: 'bedit-look', ...(settings.lookAfterImage ? { checked: '' } : {}), onchange: () => save({ lookAfterImage: look.checked }) });
    const chainPicker = settings.approvalChain ? el('label', { class: 'field bedit-chain' }, el('span', {}, 'Approval chain'),
      el('select', { onchange: (event) => save({ approvalChain: event.target.value }) },
        ...chains.map(chain => el('option', { value: chain.id, ...(chain.id === settings.approvalChain ? { selected: '' } : {}) }, chain.name)))) : null;
    card.append(el('div', { class: 'bedit-switches' },
      el('div', { class: 'bedit-switch' },
        needsChain,
        el('div', {},
          el('label', { for: 'bedit-approval' }, 'Edits need approval before they go live'),
          el('p', { class: 'sub flush' }, 'An edit waits for the chain you pick. With this off, an edit goes live when it is sent.'),
          !chains.length && !settings.approvalChain ? el('p', { class: 'sub flush' }, el('a', { class: 'link-btn', href: chainsHref }, 'Add an approval chain'), ' to turn this on.') : null,
          chainPicker)),
      el('div', { class: 'bedit-switch' },
        look,
        el('div', {},
          el('label', { for: 'bedit-look' }, 'After a new image, ask someone to look at this instance\'s edits'),
          el('p', { class: 'sub flush' }, 'The edit stays live meanwhile. People who can edit are asked to keep it or roll it back. With this off, this page shows a quiet note and nobody is asked.')))));
  } else {
    card.append(el('p', { class: 'sub' }, settings.approvalChain ? 'Edits here need approval before they go live.' : 'Edits here go live when they are sent.'));
  }

  if (state.revisions.length) {
    const rows = state.revisions.map((row) => {
      const lines = el('div', { class: 'bedit-lines' }, el('p', { class: 'muted' }, 'Loading…'));
      let loaded = false;
      const what = el('details', { class: 'bp-details', ontoggle: async () => {
        if (!what.open || loaded) return;
        loaded = true;
        try {
          const detail = await api(`/api/v1/brand/edits/revisions/${row.n}`);
          lines.replaceChildren(...(detail.lines.length ? detail.lines.map(line => brandEditLine(el, line)) : [el('p', { class: 'muted' }, 'Nothing a person would see.')]));
        } catch (error) { lines.replaceChildren(el('p', { class: 'form-err', role: 'status' }, error.message)); loaded = false; }
      } }, el('summary', {}, 'What changed'), lines);
      const again = row.liveAt && edit?.revision !== row.n && ['superseded', 'rolled-back', 'live'].includes(row.state)
        ? el('button', { class: 'btn', onclick: () => act(async () => { await api('/api/v1/brand/edits/rollback', { method: 'POST', body: { to: row.n } }); toast(settings.approvalChain ? 'Sent for approval' : 'Revision restored'); }) }, 'Go back to this') : null;
      return el('div', { class: 'bedit-revision' },
        el('div', { class: 'bp-revision-main' }, el('strong', {}, `Revision ${row.n}`), chip(row.state), again),
        el('div', { class: 'bp-revision-meta muted' }, `${row.sentByName ?? row.sentBy} · ${relTime(row.createdAt)} · ${row.changes} ${row.changes === 1 ? 'change' : 'changes'}${row.restoredFrom ? ` · restored from revision ${row.restoredFrom}` : ''}${row.endedByName ? ` · ended by ${row.endedByName}` : ''}`),
        el('div', { class: 'mono bedit-digest' }, `SHA-256 ${row.digest}`),
        what);
    });
    card.append(el('details', { class: 'bp-details' }, el('summary', {}, `History (${state.revisions.length})`), el('div', { class: 'bp-history' }, ...rows)));
  }
  card.append(errors);
  return card;
}
