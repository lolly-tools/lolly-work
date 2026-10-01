// SPDX-License-Identifier: MPL-2.0
import { createProviderFields } from './provider-setup.js';

/** Save configuration → registered browser consent → saved-source test → enable. */
export function createOAuthProviderSetup(descriptor, { el, field, api, existing, oauth, outcome, canStoreCredentials, credentialStorageAvailable, onClose, onSaved, navigate }) {
  let busy = false, disposed = false, leaving = false, created = Boolean(existing), stored = Boolean(existing?.credential), enabled = Boolean(existing?.enabled), receipt = null;
  const form = createProviderFields(descriptor, { el, field }, existing), controls = form.controls;
  const id = el('input', { value: existing?.id ?? '', placeholder: 'brand-drive', 'data-provider-id': '', autocomplete: 'off' });
  const label = el('input', { value: existing?.label ?? descriptor.name, 'data-provider-label': '' });
  const clientId = el('input', { 'data-oauth-client-id': '', autocomplete: 'off', placeholder: '…apps.googleusercontent.com' });
  const clientSecret = el('input', { type: 'password', 'data-oauth-client-secret': '', autocomplete: 'new-password' });
  const status = el('p', { role: 'status', 'aria-live': 'polite' });
  const result = el('div', { class: 'stack' }), discard = el('div', { class: 'policy-discard', hidden: '' });
  const settingsSnapshot = () => JSON.stringify([id.value, label.value, ...[...controls.values()].map(input => input.type === 'checkbox' ? input.checked : input.value)]);
  let baseline = settingsSnapshot();
  const settingsDirty = () => settingsSnapshot() !== baseline;
  const isDirty = () => settingsDirty() || Boolean(clientId.value || clientSecret.value);
  const eligible = () => receipt?.health?.ok && !receipt.sampleError && receipt.sampleTotal > 0 && receipt.original?.ok && receipt.revision;
  const invalid = (message, control) => { throw Object.assign(new Error(message), { control }); };
  const bodyOf = () => {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id.value)) invalid('Source id must be a lowercase slug of at most 100 characters.', id);
    if (!label.value.trim() || label.value.length > 200) invalid('Enter a source label of at most 200 characters.', label);
    const body = { id: id.value, kind: descriptor.kind, label: label.value, setupVersion: descriptor.version, ...form.read() };
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(body.options.folderId)) invalid('Enter the id after /folders/ in the Drive URL, without a URL or path.', controls.get('options.folderId'));
    return body;
  };
  const update = () => {
    settings.disabled = busy || enabled; id.disabled = created;
    save.disabled = busy || enabled || (created && !settingsDirty());
    credentials.disabled = busy || enabled || !created || settingsDirty() || !canStoreCredentials || !credentialStorageAvailable || !oauth?.available;
    test.disabled = busy || !created || !stored || settingsDirty();
    enable.disabled = busy || enabled || settingsDirty() || !eligible() || !canStoreCredentials;
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
    const groups = controls.get('exposure.groups').value.split(/\r?\n/).filter(Boolean);
    review.textContent = `Folder: ${controls.get('options.folderId').value || 'not configured'}. Access: ${groups.length ? groups.join(' · ') : 'all members'}. ${enabled ? 'Source is enabled. Disable it from the source row before changing its settings or reconnecting.' : 'Source stays disabled until you explicitly enable it.'}`;
  };
  const run = async action => {
    if (busy || disposed) return;
    busy = true; status.textContent = ''; update();
    let failedControl;
    try { await action(); }
    catch (error) {
      if (!disposed) {
        if (error.code === 'SETUP_CHANGED') { receipt = null; result.replaceChildren(); }
        status.textContent = error.message;
        if (created && !enabled) status.textContent += ' The source remains saved and disabled.';
        if (error.control) { error.control.setAttribute('aria-invalid', 'true'); failedControl = error.control; }
      }
    } finally { busy = false; if (!disposed) { update(); failedControl?.focus(); } }
  };
  const save = el('button', { type: 'button', class: 'primary', onclick: () => run(async () => {
    const body = bodyOf();
    await api(created ? `/api/v1/catalog/providers/${encodeURIComponent(id.value)}` : '/api/v1/catalog/providers', { method: created ? 'PUT' : 'POST', body });
    if (disposed) return;
    created = true; baseline = settingsSnapshot(); receipt = null; result.replaceChildren();
    status.textContent = stored ? 'Settings saved disabled. Test the saved folder and access rules again.' : 'Source saved disabled. An owner can now connect its Google account.';
    save.textContent = 'Save disabled settings';
  }) }, existing ? 'Save disabled settings' : 'Save disabled source');
  const connect = el('button', { type: 'button', onclick: () => run(async () => {
    if (!/^[A-Za-z0-9_-]{1,180}\.apps\.googleusercontent\.com$/.test(clientId.value)) invalid('Enter the Google web application client id.', clientId);
    if (!clientSecret.value || clientSecret.value.length > 512 || /[\x00-\x20]/.test(clientSecret.value)) invalid('Enter the Google web application client secret without spaces.', clientSecret);
    const response = await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/oauth/start`, { method: 'POST', body: { clientId: clientId.value, clientSecret: clientSecret.value } });
    if (disposed) return;
    const url = new URL(response.authorizeUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Unexpected consent destination.');
    clientSecret.value = ''; clientId.value = ''; leaving = true;
    (navigate ?? (url => root.ownerDocument.defaultView.location.assign(url)))(url.href);
  }) }, stored ? 'Reconnect with Google' : 'Connect with Google');
  const test = el('button', { type: 'button', onclick: () => run(async () => {
    receipt = null; result.replaceChildren();
    status.textContent = 'Checking the saved connection, folder listing and one original…';
    const value = await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/setup-preview`, { method: 'POST' });
    if (disposed) return;
    receipt = value;
    result.replaceChildren(...[
      el('h3', {}, eligible() ? 'Files and original checked' : 'Source needs attention'),
      el('p', {}, value.health?.ok ? 'Connection check passed.' : `Connection failed: ${value.health?.detail ?? 'No response.'}`),
      el('p', {}, value.sampleError ? `Listing failed: ${value.sampleError}` : `${value.sampleTotal ?? 0} available file(s) in ${value.pages ?? 0} listing page(s); ${value.skipped ?? 0} subfolders or native Google documents skipped.`),
      value.truncated ? el('p', { class: 'sub' }, 'Preview reached its five-page or 1,000-file limit. More files may exist.') : null,
      el('ul', {}, ...(value.sample ?? []).map(asset => el('li', {}, `${asset.name} (${asset.type})`))),
      value.original?.ok ? el('div', {}, el('p', {}, `Original read: ${value.original.bytes} bytes · ${value.original.contentType}`), el('p', { class: 'mono provider-digest' }, `SHA-256 ${value.original.sha256}`)) : el('p', {}, `Original not verified: ${value.original?.detail ?? 'No file checked.'}`),
      ...(value.notes ?? []).map(note => el('p', { class: 'sub' }, note)),
      el('p', { class: 'sub' }, 'Compare this checksum with a known source original for acceptance. A sample does not prove every file or future access.'),
    ].filter(Boolean));
    status.textContent = eligible() ? 'Review the saved folder and member groups before syncing and enabling.' : 'Review the folder, Google account access and guide, then retry. Reconnect if the grant expired or was revoked.';
  }) }, 'Test saved files and original');
  const enable = el('button', { type: 'button', class: 'primary', onclick: () => run(async () => {
    if (!eligible()) return;
    const sync = await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/sync`, { method: 'POST' });
    if (!sync.assetCount) throw new Error('Full sync found no exposed files. Review the folder and exposure.');
    await api(`/api/v1/catalog/providers/${encodeURIComponent(id.value)}/enable`, { method: 'POST', body: { setupRevision: receipt.revision } });
    if (disposed) return;
    enabled = true; status.textContent = `Source enabled. Full sync found ${sync.assetCount} exposed file(s); ${sync.skipped ?? 0} records skipped. ${(sync.notes ?? []).join(' ')}`;
    onSaved?.();
  }) }, 'Sync and enable source');
  const requestDiscard = proceed => {
    if (busy) { status.textContent = 'Wait for the request to finish before leaving.'; return; }
    if (!isDirty()) { proceed(); return; }
    discard.hidden = false;
    discard.replaceChildren(el('p', {}, 'Discard the unsaved settings and client credential? Saved configuration is retained.'),
      el('button', { type: 'button', onclick: () => { discard.hidden = true; } }, 'Keep editing'),
      el('button', { type: 'button', class: 'danger', onclick: () => { clientSecret.value = ''; clientId.value = ''; baseline = settingsSnapshot(); proceed(); } }, 'Discard changes'));
    discard.querySelector('button').focus();
  };
  const settings = el('fieldset', { class: 'policy-fields stack' }, el('legend', {}, '1. Configure and save disabled'),
    el('div', { class: 'formrow' }, field('Source id', id), field('Source label', label)), form.element);
  const credentials = el('fieldset', { class: 'policy-fields stack' }, el('legend', {}, '2. Register and connect with Google'),
    el('p', { class: 'sub' }, 'Enable the Drive API in your Google Cloud project. Configure its consent audience, then create an OAuth client of type Web application. Use an account that can read the curated folder.'),
    el('p', {}, 'Register this exact authorized redirect URI:'), el('p', { class: 'mono provider-digest' }, oauth?.redirectUri ?? 'Configure the instance URL first.'),
    el('p', { class: 'sub' }, 'The browser opens Google’s read-only consent screen. Refresh tokens are captured and sealed by the server. No plaintext credentials or drafts are saved in browser storage.'),
    el('p', { class: 'sub' }, 'For your own Workspace, configure the appropriate internal audience. External apps in Testing issue Drive refresh tokens that expire after seven days. Check the guide for production consent requirements before go-live.'),
    el('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener noreferrer' }, 'Open Google Cloud credentials'),
    el('div', { class: 'formrow' }, field('Web application client id', clientId), field('Client secret', clientSecret)), connect);
  const review = el('p', { class: 'sub' });
  const root = el('div', { class: 'card stack provider-setup' },
    el('div', { class: 'list-bar' }, el('h2', { tabindex: -1 }, `Connect ${descriptor.name}`), el('button', { type: 'button', onclick: () => requestDiscard(onClose) }, 'Close')),
    ...descriptor.limits.map(limit => el('p', { class: 'sub' }, limit)),
    el('a', { href: `#/docs?doc=${descriptor.guide}` }, 'Setup guide and live verification'), settings, save,
    ...(!canStoreCredentials ? [el('p', { class: 'sub' }, 'An owner must connect the Google account and enable this source. Save the configuration here, then hand it to an owner.')] : !credentialStorageAvailable ? [el('p', { class: 'sub' }, 'Set LW_CREDENTIAL_SECRET and restart before connecting.')] : !oauth?.available ? [el('p', { class: 'sub' }, oauth?.reason ?? 'Configure an HTTPS instance URL before connecting.')] : []),
    credentials, el('h3', {}, '3. Test and review the saved source'), test, result, review, enable, status, discard);
  root.addEventListener('input', event => {
    if (!event.target.matches('input, textarea')) return;
    event.target.removeAttribute('aria-invalid'); discard.hidden = true;
    if (!event.target.matches('[data-oauth-client-id], [data-oauth-client-secret]')) { receipt = null; result.replaceChildren(); status.textContent = 'Settings changed. Save and test the new configuration.'; }
    update();
  });
  const messages = { connected: 'Google consent completed; credential sealed. Test the saved files and original before enabling.', denied: 'Google consent was declined. The previous credential, if any, is retained. Review the registration and reconnect.', expired: 'Consent expired after ten minutes. Start a new connection.', changed: 'The source or your access changed during consent. Review its current settings and reconnect.', failed: 'Connection was not completed. Check the redirect URI, consent audience, offline Drive permission and folder access in the guide, then reconnect.' };
  status.textContent = messages[outcome] ?? (enabled ? 'This source is enabled.' : stored ? 'Credential is stored. Test the saved folder before enabling.' : 'Save the source configuration before connecting.');
  update();
  const window = root.ownerDocument.defaultView;
  const beforeUnload = event => { if (!leaving && (isDirty() || busy)) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return { element: root, isDirty, isBusy: () => busy, requestDiscard,
    dispose() { disposed = true; clientSecret.value = ''; clientId.value = ''; receipt = null; window.removeEventListener('beforeunload', beforeUnload); } };
}
