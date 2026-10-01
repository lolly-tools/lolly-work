// SPDX-License-Identifier: MPL-2.0

/** Shared typed fields for credential and consent-based source setup. */
export function createProviderFields(descriptor, { el, field }, values = {}) {
  const controls = new Map();
  const invalid = (message, control) => { throw Object.assign(new Error(message), { control }); };
  const setPath = (body, path, value) => {
    const keys = path.split('.'); let target = body;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  };
  const element = el('div', { class: 'stack' }, ...['options', 'mapping', 'exposure', 'sync'].map(section => {
      const fields = descriptor.fields.filter(spec => spec.path.startsWith(section + '.')).map(spec => {
        let input;
        if (spec.type === 'select') input = el('select', {}, ...spec.choices.map(choice => el('option', { value: choice }, choice)));
        else if (spec.type === 'lines') input = el('textarea', { rows: 3 });
        else input = el('input', { type: spec.type === 'boolean' ? 'checkbox' : spec.type === 'number' ? 'number' : spec.type === 'url' ? 'url' : 'text', ...(spec.min !== undefined ? { min: spec.min, max: spec.max } : {}) });
        input.dataset.providerField = spec.path;
        const value = spec.path.split('.').reduce((target, key) => target?.[key], values) ?? spec.default;
        if (spec.type === 'boolean') input.checked = value ?? false;
        else input.value = Array.isArray(value) ? value.join('\n') : value ?? '';
        controls.set(spec.path, input);
        const wrapper = field(spec.label, input, spec.type === 'boolean' ? { class: 'setup-checkbox-row' } : {});
        const help = el('p', { id: `provider-help-${controls.size}`, class: 'sub' }, spec.help);
        input.setAttribute('aria-describedby', help.id);
        return el('div', { class: 'stack' }, wrapper, help);
      });
      return el('div', { class: 'stack' }, el('h3', {}, { options: 'Location', mapping: 'Catalog mapping', exposure: 'Access and exposure', sync: 'Refresh' }[section]), el('div', { class: 'formrow' }, ...fields));
    }));
  return { element, controls, read() {
    const body = { options: {}, mapping: {}, exposure: {}, sync: {} };
    for (const spec of descriptor.fields) {
      const input = controls.get(spec.path);
      let value = spec.type === 'boolean' ? input.checked : input.value;
      if (spec.required && !value) invalid(`${spec.label} is required.`, input);
      if (spec.type === 'lines') {
        value = value.split(/\r?\n/).filter(name => name !== '');
        if (value.length > 100 || value.some(name => name.length > 300 || /[\x00-\x1f]/.test(name))) invalid(`${spec.label} must contain at most 100 exact names.`, input);
      } else if (spec.type === 'number') {
        if (value === '') continue;
        value = Number(value);
        if (!Number.isInteger(value) || value < spec.min || value > spec.max) invalid(`${spec.label} must be between ${spec.min} and ${spec.max}.`, input);
      } else if (spec.type === 'url') {
        try {
          const url = new URL(value), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { invalid('Enter an HTTPS server URL without credentials, query or fragment. Loopback HTTP is allowed for evaluation.', input); }
      }
      if (value === '' || (Array.isArray(value) && !value.length)) continue;
      setPath(body, spec.path, value);
    }
    return body;
  } };
}

/** Configure → read-only test → save disabled → review and enable. */
export function createProviderSetup(descriptor, { el, field, api, canStoreCredentials, credentialStorageAvailable, onClose, onSaved }) {
  let busy = false, disposed = false, receipt = null, created = false, stored = false, enabled = false;
  const form = createProviderFields(descriptor, { el, field }), controls = form.controls;
  const status = el('p', { role: 'status', 'aria-live': 'polite' });
  const result = el('div', { class: 'stack' });
  const discard = el('div', { class: 'policy-discard', hidden: '' });
  const id = el('input', { placeholder: 'brand-assets', 'data-provider-id': '', autocomplete: 'off' });
  const label = el('input', { value: descriptor.name, 'data-provider-label': '' });
  const auth = el('select', { 'data-provider-auth': '' }, el('option', { value: 'basic' }, 'Username and app password'), el('option', { value: 'bearer' }, 'Bearer token'));
  const username = el('input', { autocomplete: 'off', 'data-credential-user': '' });
  const password = el('input', { type: 'password', autocomplete: 'new-password', 'data-credential-secret': '' });
  const expiry = el('input', { type: 'date', 'data-credential-expiry': '' });
  const credentialUser = field('Credential username', username);
  const credentialSecret = field('App password', password);
  const invalid = (message, control) => { throw Object.assign(new Error(message), { control }); };
  const secretOf = () => {
    if (!password.value) invalid('Enter an app password or bearer token.', password);
    if (auth.value === 'bearer') return `bearer:${password.value}`;
    if (!username.value || username.value.includes(':') || username.value.toLowerCase() === 'bearer') invalid('Enter the Basic credential username without a colon.', username);
    const secret = `${username.value}:${password.value}`;
    if (secret.length < 8) invalid('The combined credential must contain at least eight characters.', password);
    return secret;
  };
  const bodyOf = () => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id.value)) invalid('Source id must be a lowercase slug, for example brand-assets.', id);
    if (!label.value.trim()) invalid('Enter a source label.', label);
    const body = { id: id.value, kind: descriptor.kind, label: label.value, setupVersion: descriptor.version, options: {}, mapping: {}, exposure: {}, sync: {} };
    Object.assign(body, form.read());
    if (body.options.root?.split('/').some(part => part === '.' || part === '..' || part.includes('\\'))) invalid('Folder must be a relative path without traversal segments.', controls.get('options.root'));
    if (body.options.flavor === 'nextcloud' && auth.value === 'bearer' && !body.options.username) invalid('Enter the Nextcloud files login when using a bearer token.', controls.get('options.username'));
    return body;
  };
  const snapshot = () => JSON.stringify([id.value, label.value, ...[...controls.values()].map(input => input.type === 'checkbox' ? input.checked : input.value), auth.value, username.value, password.value, expiry.value]);
  let baseline;
  const isDirty = () => !enabled && snapshot() !== baseline;
  const eligible = () => receipt?.health?.ok && !receipt.sampleError && receipt.sampleTotal > 0 && receipt.original?.ok;
  const update = () => {
    test.disabled = busy || created;
    save.disabled = busy || created || !eligible();
    retry.disabled = busy || !created || stored || !password.value;
    enable.disabled = busy || !stored || enabled;
    settings.disabled = busy || created;
    credentials.disabled = busy || stored;
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  };
  const changed = () => {
    if (!created) { receipt = null; result.replaceChildren(); }
    status.textContent = created ? 'Source is saved disabled. Retry storing its credential, or close and continue from the source row.' : 'Settings changed. Test this configuration before saving.';
    discard.hidden = true; update();
  };
  const run = async action => {
    if (busy || disposed) return;
    let failedControl;
    busy = true; status.textContent = ''; update();
    try { await action(); }
    catch (error) {
      if (disposed) return;
      status.textContent = error.message;
      if (created && !stored) status.textContent += ' The source remains saved and disabled. Retry the credential here; no second source will be created.';
      if (error.control) { error.control.setAttribute('aria-invalid', 'true'); failedControl = error.control; }
    } finally { busy = false; if (!disposed) { update(); failedControl?.focus(); } }
  };
  const showReceipt = value => {
    const ready = eligible();
    result.replaceChildren(...[
      el('h3', {}, ready ? 'Files and original checked' : 'Source needs attention'),
      el('p', {}, value.health?.ok ? 'Connection check passed.' : `Connection failed: ${value.health?.detail ?? 'No response.'}`),
      value.sampleError ? el('p', {}, `Listing failed: ${value.sampleError}`) : el('p', {}, `${value.sampleTotal ?? 0} available file(s) in ${value.pages ?? 0} directory page(s) checked. ${value.excludedByExposure ?? 0} excluded by exposure; ${value.unavailable ?? 0} outside their availability window; ${value.skipped ?? 0} skipped by the mapper.`),
      value.truncated ? el('p', { class: 'muted' }, 'Preview stopped at its five-page or 1,000-file limit. More files may exist; the preview is a sample.') : null,
      el('ul', {}, ...(value.sample ?? []).map(asset => el('li', {}, `${asset.name} (${asset.type})`))),
      value.original?.ok ? el('div', {}, el('p', {}, `Original read: ${value.original.bytes} bytes · ${value.original.contentType}`), el('p', { class: 'mono provider-digest' }, `SHA-256 ${value.original.sha256}`)) : el('p', {}, `Original not verified: ${value.original?.detail ?? 'No file checked.'}`),
      ...(value.notes ?? []).map(note => el('p', { class: 'muted' }, note)),
      el('p', { class: 'sub' }, 'The checksum identifies the file read in this preview. Compare it with a known source original for acceptance; this check does not prove every file or future access.'),
    ].filter(node => node !== null));
  };
  const test = el('button', { type: 'button', onclick: () => run(async () => {
    const body = bodyOf(), secret = secretOf(), expected = snapshot();
    receipt = null; result.replaceChildren();
    status.textContent = 'Checking the connection, listing and one original…';
    const value = await api('/api/v1/catalog/providers/preview', { method: 'POST', body: { ...body, secret } });
    if (disposed) return;
    if (snapshot() !== expected) { status.textContent = 'Settings changed during testing. Test the current configuration.'; return; }
    receipt = value; showReceipt(value);
    status.textContent = eligible() ? 'Review the folder and group access below, then save the source disabled.' : 'Adjust the folder, credentials or exposure and test again. No source was saved.';
  }) }, 'Test files and original');
  const storeCredential = async () => {
    await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/credential`, { method: 'PUT', body: { secret: secretOf(), ...(expiry.value ? { expiresAt: expiry.value } : {}) } });
    password.value = ''; stored = true; baseline = snapshot();
    status.textContent = 'Source saved disabled; credential verified and sealed. Enable when the reviewed folder and groups are correct.';
  };
  const save = el('button', { type: 'button', class: 'primary', onclick: () => run(async () => {
    if (!eligible()) return;
    const body = bodyOf();
    await api('/api/v1/catalog/providers', { method: 'POST', body });
    created = true;
    if (canStoreCredentials && credentialStorageAvailable) await storeCredential();
    else {
      password.value = ''; baseline = snapshot();
      status.textContent = 'Source saved disabled. An owner must store its credential and enable it from the source row.';
    }
  }) }, canStoreCredentials && credentialStorageAvailable ? 'Save source and seal credential' : 'Save disabled source');
  const retry = el('button', { type: 'button', onclick: () => run(storeCredential) }, 'Retry credential');
  const enable = el('button', { type: 'button', class: 'primary', onclick: () => run(async () => {
    const sync = await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/sync`, { method: 'POST' });
    if (!sync.assetCount) throw new Error('Full sync found no exposed files. The source stays disabled; review its folder and exposure.');
    await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/enable`, { method: 'POST' });
    enabled = true; baseline = snapshot();
    status.textContent = `Source enabled. Full sync found ${sync.assetCount} exposed file(s).`;
    if (sync.notes?.length || sync.skipped) status.textContent += ` ${sync.skipped ?? 0} records skipped. ${(sync.notes ?? []).join(' ')}`;
    onSaved?.();
  }) }, 'Sync and enable source');
  const requestDiscard = proceed => {
    if (busy) { status.textContent = 'Wait for the request to finish before leaving.'; return; }
    if (!isDirty()) { proceed(); return; }
    discard.hidden = false;
    discard.replaceChildren(el('p', {}, created ? 'The disabled source is saved. Discard the unsaved credential and close?' : 'Discard this connection draft?'),
      el('button', { type: 'button', onclick: () => { discard.hidden = true; } }, 'Keep editing'),
      el('button', { type: 'button', class: 'danger', onclick: () => { password.value = ''; baseline = snapshot(); proceed(); } }, 'Discard changes'));
    discard.querySelector('button').focus();
  };
  const settings = el('fieldset', { class: 'policy-fields stack' },
    el('legend', {}, '1. Configure the source'),
    el('div', { class: 'formrow' }, field('Source id', id), field('Source label', label)),
    form.element);
  const credentials = el('fieldset', { class: 'policy-fields stack' },
    el('legend', {}, '2. Test with a read-only credential'),
    el('p', { class: 'sub' }, 'Nextcloud requires an app password from Settings → Security. Credentials stay in this form until sealed or discarded; the test does not save them.'),
    el('div', { class: 'formrow' }, field('Credential type', auth), credentialUser, credentialSecret, field('Credential expiry (optional)', expiry)));
  const review = el('p', { class: 'sub' });
  const reviewAccess = () => {
    const groupNames = controls.get('exposure.groups').value.split(/\r?\n/).filter(Boolean);
    review.textContent = `Folder: ${controls.get('options.root').value || 'entire files root'}. Access: ${groupNames.length ? groupNames.join(' · ') : 'all members'}. New sources stay disabled until you enable them.`;
  };
  const root = el('div', { class: 'card stack provider-setup' },
    el('div', { class: 'list-bar' }, el('h2', { tabindex: -1 }, `Connect ${descriptor.name}`), el('button', { type: 'button', onclick: () => requestDiscard(onClose) }, 'Close')),
    el('p', { class: 'sub' }, 'Configure the folder and access, test actual files, then save and enable. The external source is read-only.'),
    ...descriptor.limits.map(limit => el('p', { class: 'sub' }, limit)),
    el('a', { href: `#/docs?doc=${descriptor.guide}` }, 'Setup guide and live verification'),
    settings, credentials,
    !canStoreCredentials ? el('p', { class: 'sub' }, 'Your access allows configuration. An owner must store credentials and enable sources.') : !credentialStorageAvailable ? el('p', { class: 'sub' }, 'Set LW_CREDENTIAL_SECRET and restart before an owner can seal credentials.') : null,
    el('p', {}, test), result,
    el('h3', {}, '3. Review and save'), review,
    el('p', { class: 'policy-rule-actions' }, save, ...(canStoreCredentials && credentialStorageAvailable ? [retry, enable] : [])), status, discard);
  root.addEventListener('input', event => { if (event.target.matches('input, textarea')) { event.target.removeAttribute('aria-invalid'); reviewAccess(); changed(); } });
  root.addEventListener('change', event => {
    if (!event.target.matches('select')) return;
    credentialUser.hidden = auth.value === 'bearer';
    credentialSecret.querySelector('label').textContent = auth.value === 'bearer' ? 'Bearer token' : 'App password';
    changed();
  });
  baseline = snapshot(); reviewAccess(); update();
  const window = root.ownerDocument.defaultView;
  const beforeUnload = event => { if (isDirty() || busy) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return { element: root, isDirty, isBusy: () => busy, requestDiscard,
    dispose() { disposed = true; password.value = ''; username.value = ''; receipt = null; window.removeEventListener('beforeunload', beforeUnload); } };
}
