import { createSetupWizard } from './setup-wizard.js';

export async function setupView(main, helpers) {
  const editor = await createSetupWizard(helpers);
  main.append(editor.element);
  return editor;
}

/** Paste-ready MCP settings. They name an environment variable and never hold the
 *  token, so the settings can live in a project file. Same shape as `lw mcp config`. */
export function mcpConfigText(origin, tokenEnv = 'LW_TOKEN') {
  const endpoint = `${origin}/api/v1/mcp`;
  return [
    `Claude Code: claude mcp add --transport http lolly-work ${endpoint} --header "Authorization: Bearer $${tokenEnv}"`,
    '',
    'Other clients (.cursor/mcp.json, for example):',
    JSON.stringify({ mcpServers: { 'lolly-work': { url: endpoint, headers: { Authorization: `Bearer \${env:${tokenEnv}}` } } } }, null, 2),
  ].join('\n');
}

export async function tokensView(main, { el, field, api, can, refresh }) {
  main.append(el('h1', {}, 'Access tokens'),
    el('p', { class: 'sub' }, 'New secrets display once. Store them in the connector or your secret manager before dismissing them. Revocation takes effect on the next request.'));
  for (const kind of ['scim', 'service']) {
    if (!can(kind === 'scim' ? 'scim.manage' : 'token.manage')) continue;
    const path = kind === 'scim' ? '/api/v1/scim/tokens' : '/api/v1/tokens';
    const { tokens, scopeVocabulary } = await api(path);
    const label = el('input', { required: '', maxlength: 80 });
    const scopeChoices = kind === 'service' ? scopeVocabulary?.scopes ?? [] : [];
    const roleNames = [...(scopeChoices.length ? ['automation'] : []), 'viewer', 'member', 'author', 'approver', 'brand-manager', 'admin', 'owner'];
    const preferred = scopeChoices.length ? 'automation' : 'member';
    const role = el('select', {}, ...roleNames.map(role => el('option', { value: role, selected: role === preferred ? '' : null }, role)));
    const scopeBoxes = scopeChoices.map(scope => {
      const box = el('input', { type: 'checkbox', value: scope.id, checked: scope.id === 'render' ? '' : null });
      return { box, node: el('label', { class: 'chk' }, box, el('span', {}, scope.label, ' ', el('span', { class: 'muted' }, scope.description))) };
    });
    const toolList = el('input', { placeholder: 'qr-code, event-card', maxlength: 2000 });
    const scopesOfForm = () => scopeBoxes.filter(item => item.box.checked).map(item => item.box.value);
    const toolsOfForm = () => toolList.value.split(',').map(id => id.trim()).filter(Boolean);
    const scopeWords = (id) => scopeChoices.find(scope => scope.id === id)?.label ?? id;
    const error = el('p', { class: 'form-err', role: 'alert' });
    const secretHost = el('div');
    const create = el('button', { type: 'submit', class: 'primary' }, 'Create token');
    const form = el('form', { onsubmit: async event => {
      event.preventDefault(); error.textContent = ''; create.disabled = true;
      try {
        const scopes = scopesOfForm();
        const tools = toolsOfForm();
        const result = await api(path, { method: 'POST', body: kind === 'scim' ? { idp: label.value.trim() }
          : { label: label.value.trim(), role: role.value, ...(scopes.length ? { scopes } : {}), ...(tools.length ? { tools } : {}) } });
        const secret = el('textarea', { readonly: '', 'aria-label': 'One-time token', rows: 3 });
        secret.value = result.token;
        const connect = kind === 'service' ? el('textarea', { readonly: '', 'aria-label': 'MCP settings', rows: 15 }) : null;
        if (connect) connect.value = mcpConfigText(main.ownerDocument.location.origin);
        secretHost.replaceChildren(el('p', {}, 'Store this token now. It cannot be recovered later.'), secret,
          ...(connect ? [el('p', {}, 'To connect an agent, put the token in LW_TOKEN and use these settings. They do not hold the token.'), connect] : []),
          el('button', { type: 'button', onclick: () => { secret.value = ''; secretHost.replaceChildren(); void refresh(); } }, 'I have stored the token'));
        secret.focus(); secret.select();
      } catch (failure) { error.textContent = failure.message; create.disabled = false; }
    } }, el('div', { class: 'formrow' }, field(kind === 'scim' ? 'Identity provider id' : 'Automation label', label),
      kind === 'service' ? field('Role', role) : null),
      scopeBoxes.length ? el('fieldset', { class: 'policy-fields stack token-scopes' }, el('legend', {}, 'What this token may do'), el('div', { class: 'chk-list' }, ...scopeBoxes.map(item => item.node)),
        el('p', { class: 'muted' }, 'With no box ticked, a token gets all that its role can reach. The automation role needs at least one.')) : null,
      scopeBoxes.length ? field('Only these tools (optional)', toolList) : null,
      el('p', {}, create), error, secretHost);
    main.append(el('section', { class: 'card stack' }, el('h2', {}, kind === 'scim' ? 'SCIM provisioning' : 'Service automation'),
      kind === 'scim' ? el('p', {}, 'Use primary or a configured OIDC provider id. Tokens expire after 90 days. Provisioning endpoint: ', el('code', {}, `${location.origin}/scim/v2`)) : null,
      form,
      ...tokens.map(token => {
        const status = el('span', { role: 'status' });
        const revoke = el('button', { type: 'button', onclick: async () => {
          revoke.disabled = true;
          try { await api(`${path}/${encodeURIComponent(token.id)}`, { method: 'DELETE' }); status.textContent = 'Revoked'; }
          catch (failure) { status.textContent = failure.message; revoke.disabled = false; }
        } }, 'Revoke');
        return el('p', {}, el('strong', {}, token.idp ?? token.label), ' ',
          token.role ? `${token.role}. ` : '',
          kind === 'service' ? (token.scopes ? `Can: ${token.scopes.map(scopeWords).join(', ')}. ` : 'All that its role can reach. ') : '',
          token.tools ? `Only these tools: ${token.tools.join(', ')}. ` : '',
          `Created ${new Date(token.createdAt).toLocaleString()}. `,
          token.expiresAt ? `Expires ${new Date(token.expiresAt).toLocaleString()}. ` : '',
          token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}. ` : 'Not used yet. ',
          token.revokedAt ? 'Revoked' : revoke, ' ', status);
      })));
  }
}
