import { createSetupWizard } from './setup-wizard.js';

export async function setupView(main, helpers) {
  const editor = await createSetupWizard(helpers);
  main.append(editor.element);
  return editor;
}

export async function tokensView(main, { el, field, api, can, refresh }) {
  main.append(el('h1', {}, 'Provisioning and service tokens'),
    el('p', { class: 'sub' }, 'New secrets display once. Store them in the connector or your secret manager before dismissing them. Revocation takes effect on the next request.'));
  for (const kind of ['scim', 'service']) {
    if (!can(kind === 'scim' ? 'scim.manage' : 'token.manage')) continue;
    const path = kind === 'scim' ? '/api/v1/scim/tokens' : '/api/v1/tokens';
    const { tokens } = await api(path);
    const label = el('input', { required: '', maxlength: 80 });
    const role = el('select', {}, ...['viewer', 'member', 'author', 'approver', 'admin', 'owner'].map(role => el('option', { value: role, selected: role === 'member' ? '' : null }, role)));
    const error = el('p', { class: 'form-err', role: 'alert' });
    const secretHost = el('div');
    const create = el('button', { type: 'submit', class: 'primary' }, 'Create token');
    const form = el('form', { onsubmit: async event => {
      event.preventDefault(); error.textContent = ''; create.disabled = true;
      try {
        const result = await api(path, { method: 'POST', body: kind === 'scim' ? { idp: label.value.trim() } : { label: label.value.trim(), role: role.value } });
        const secret = el('textarea', { readonly: '', 'aria-label': 'One-time token', rows: 3 });
        secret.value = result.token;
        secretHost.replaceChildren(el('p', {}, 'Store this token now. It cannot be recovered later.'), secret,
          el('button', { type: 'button', onclick: () => { secret.value = ''; secretHost.replaceChildren(); void refresh(); } }, 'I have stored the token'));
        secret.focus(); secret.select();
      } catch (failure) { error.textContent = failure.message; create.disabled = false; }
    } }, el('div', { class: 'formrow' }, field(kind === 'scim' ? 'Identity provider label' : 'Automation label', label),
      kind === 'service' ? field('Role', role) : null), el('p', {}, create), error, secretHost);
    main.append(el('section', { class: 'card stack' }, el('h2', {}, kind === 'scim' ? 'SCIM provisioning' : 'Service automation'),
      kind === 'scim' ? el('p', {}, 'Provisioning endpoint: ', el('code', {}, `${location.origin}/scim/v2`)) : null,
      form,
      ...tokens.map(token => {
        const status = el('span', { role: 'status' });
        const revoke = el('button', { type: 'button', onclick: async () => {
          revoke.disabled = true;
          try { await api(`${path}/${encodeURIComponent(token.id)}`, { method: 'DELETE' }); status.textContent = 'Revoked'; }
          catch (failure) { status.textContent = failure.message; revoke.disabled = false; }
        } }, 'Revoke');
        return el('p', {}, el('strong', {}, token.idp ?? token.label), ' ',
          token.role ? `${token.role}. ` : '', `Created ${new Date(token.createdAt).toLocaleString()}. `,
          token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}. ` : 'Not used yet. ',
          token.revokedAt ? 'Revoked' : revoke, ' ', status);
      })));
  }
}
