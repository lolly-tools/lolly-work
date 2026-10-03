/** Guided deployment settings, observed identity and ordinary governed sample renders. */
export async function createSetupWizard({ el, field, api }) {
  const [initialReport, initialConfiguration, org] = await Promise.all([
    api('/api/v1/system/setup'), api('/api/v1/system/setup/configuration'), api('/api/v1/org-config'),
  ]);
  let report = initialReport, configuration = initialConfiguration;
  const document = el('div').ownerDocument;
  const window = document.defaultView;
  const roles = ['owner', 'admin', 'approver', 'author', 'member', 'viewer'];
  const titles = ['Deployment', 'Identity and owner', 'Provisioning', 'Brand and assets', 'Sample output', 'Finish setup'];
  const context = `${configuration.currentSettingsHash}:${configuration.sampleAccountHash}:${report.pack.revision}:${org.policyVersion}:${org.branding?.revision}`;
  const storageKey = 'lw.setup.progress.v1';
  let progress = {};
  try { const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}'); if (stored && typeof stored === 'object' && !Array.isArray(stored)) progress = stored; } catch { /* Storage may be disabled. */ }
  let step = Number.isInteger(progress.step) && progress.step >= 0 && progress.step < titles.length ? progress.step : 0;
  let busy = false, disposed = false, proposal = null, render = null, evidence = null, pollTimer = null, pollStarted = Date.now();
  const persist = () => { try { window.localStorage.setItem(storageKey, JSON.stringify(progress)); } catch { /* The journey works without storage. */ } };
  const guide = anchor => el('a', { href: `#/docs?doc=customer-setup${anchor ? `&anchor=${anchor}` : ''}` }, 'Open setup guide');
  const card = (title, ...content) => el('section', { class: 'card stack' }, el('h3', {}, title), ...content);
  const button = (text, action, attrs = {}) => el('button', { type: 'button', onclick: action, ...attrs }, text);
  const error = el('p', { class: 'form-err', role: 'alert' });
  const discard = el('div', { class: 'setup-discard' });
  const status = el('p', { role: 'status', class: 'setup-status' });
  const applyStatus = el('div', { class: 'card stack', role: 'status' });
  const controls = {}, groupControls = {}, listControls = {};
  const panels = titles.map((title, index) => el('section', { 'data-step': index, 'aria-labelledby': `setup-title-${index}` },
    el('h2', { id: `setup-title-${index}`, tabindex: '-1' }, `${index + 1}. ${title}`)));
  const root = el('div', { class: 'setup-wizard' }, el('h1', {}, 'Customer setup'),
    el('p', { class: 'sub' }, 'Configure this instance, verify owner access and download a checked sample. Your current deployment stays active while you prepare changes.'),
    el('p', {}, guide()), applyStatus);
  const read = () => ({ ...configuration.settings,
    ...Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value])),
    roleGroups: Object.fromEntries(roles.map(role => [role, lines(groupControls[role].value)])),
    ownerTestGroups: lines(ownerGroups.value),
    ...Object.fromEntries(Object.entries(listControls).map(([key, control]) => [key, lines(control.value)])),
  });
  const lines = text => text.split('\n').map(group => group.trim()).filter(Boolean);
  const input = (key, label, hint, options) => {
    const control = options ? el('select', { 'data-setting': key }, ...options.map(([value, text]) => el('option', { value }, text)))
      : el('input', { type: 'text', 'data-setting': key, maxlength: '1000', autocomplete: 'off' });
    control.value = configuration.settings[key] ?? ''; controls[key] = control;
    control.addEventListener('input', changed);
    return el('div', { class: 'setup-field' }, field(label, control), el('p', { class: 'sub' }, hint));
  };
  const check = (key, label, hint) => {
    const control = el('input', { type: 'checkbox', 'data-setting': key });
    control.checked = !!configuration.settings[key]; controls[key] = control; control.addEventListener('change', changed);
    return el('div', { class: 'setup-field' }, field(label, control, { class: 'setup-checkbox-row' }), el('p', { class: 'sub' }, hint));
  };
  const list = (key, label) => {
    const control = el('textarea', { rows: '3', 'data-setting': key, autocomplete: 'off' });
    control.value = (configuration.settings[key] ?? []).join('\n'); listControls[key] = control; control.addEventListener('input', changed);
    return field(label, control);
  };
  const ownerGroups = el('textarea', { rows: '3', 'data-setting': 'ownerTestGroups' });
  ownerGroups.value = configuration.settings.ownerTestGroups.join('\n'); ownerGroups.addEventListener('input', changed);
  let baseline;
  const isDirty = () => !disposed && baseline !== JSON.stringify(read());
  function changed() { proposal = null; artifactHost.replaceChildren(); status.textContent = 'Draft settings changed. Generate a new validated configuration before applying.'; }
  function updateApplied() {
    const expected = progress.expectedSettingsHash;
    applyStatus.replaceChildren(el('strong', {}, expected ? (expected === configuration.currentSettingsHash ? 'Generated settings are applied' : 'Generated settings are pending') : 'Reading the running deployment'),
      el('p', {}, expected ? (expected === configuration.currentSettingsHash ? 'The app sees the generated settings after restart. Continue with live identity and sample checks.' : 'Apply the downloaded file, deploy it and restart. Refresh this page to compare it with the running configuration.')
        : `Current mode: ${report.mode}. Configuration readiness ${report.ready ? 'passes' : 'needs attention'}. Live tests are shown separately.`));
  }
  updateApplied();
  const nav = el('nav', { class: 'setup-steps', 'aria-label': 'Setup steps' });
  const selectStep = index => {
    step = index; progress.step = index; persist();
    panels.forEach((panel, i) => { panel.hidden = i !== step; });
    [...nav.children].forEach((entry, i) => { entry.setAttribute('aria-current', i === step ? 'step' : 'false'); });
    back.disabled = step === 0 || busy; next.disabled = step === titles.length - 1 || busy;
    if (root.isConnected) panels[step].querySelector('h2').focus();
  };
  titles.forEach((title, index) => nav.append(button(`${index + 1}. ${title}`, () => selectStep(index))));
  root.append(nav, ...panels);
  panels[0].append(el('p', {}, 'Choose where this instance runs. Paths refer to the server or container, and must be mounted there.'),
    el('div', { class: 'setup-grid' }, input('name', 'Instance name', 'Shown to employees and in instance downloads.'),
      input('baseUrl', 'Public base URL', 'The employee-facing address, including HTTPS in production.'),
      input('mode', 'Deployment mode', 'Prepare sign-in in restricted evaluation, then switch to production after a real owner signs in.', [['evaluation', 'Evaluation'], ['production', 'Production']]),
      input('application', 'Application profile', 'API includes this console. Employee web also needs a governed shell.', [['api', 'API and console'], ['web', 'Employee web app']]),
      input('shellDir', 'Served shell directory', 'Optional for API. A built employee shell mounted in the server filesystem.'),
      input('appUrl', 'External employee app URL', 'Use when hosting the employee shell separately.')),
    card('Secrets and durable storage', el('p', {}, 'Set secrets in the deployment environment or secret manager. This assistant never asks you to paste them.'),
      ...configuration.environment.map(item => el('p', {}, el('code', {}, item.name), `: ${item.present ? 'configured' : 'not configured'}`)),
      el('p', { class: 'sub' }, 'The IDP client secret is optional for a public-client registration. Production requires Postgres and stable session/link secrets of at least 32 bytes. Evaluation memory state is lost on restart.')));
  const identityResult = el('div', { role: 'status' });
  const accountText = account => !account ? 'No account matches that exact subject.' :
    `Account ${account.id}; subject ${account.sub}; role ${account.role}; ${account.active ? 'active' : 'disabled'}. Groups: ${account.groups.join(', ') || 'none'}. ${account.signIn ? `Real ${account.signIn.provider} sign-in observed ${new Date(account.signIn.at).toLocaleString()}.` : 'No real sign-in observed for these identity settings in retained evidence.'} ${account.provisioned ? `SCIM creation observed ${new Date(account.provisioned.at).toLocaleString()}.` : 'No SCIM creation event observed in retained evidence.'}`;
  const currentIdentity = el('div', { class: 'setup-account' }, el('p', {}, accountText(configuration.account)));
  panels[1].append(el('p', {}, 'Register this app with your identity provider. Keep the existing owner login available during restricted evaluation until the real owner has signed in.'),
    el('div', { class: 'setup-grid' },
      input('authentication', 'Sign-in method', 'OIDC uses your registered identity provider. Proxy setup is available after its headers and secret are configured.', [['development', 'Development evaluation'], ['oidc', 'OIDC identity provider'], ['proxy', 'Configured authenticating proxy']]),
      input('providerName', 'Sign-in button name', 'For example, Company SSO.'),
      input('issuer', 'OIDC issuer URL', 'Copy the issuer from the provider registration. The live test uses the installed value after restart.'),
      input('clientId', 'Registered client ID', 'Use the application client ID, without a client secret.'),
      input('groupsClaim', 'Groups claim name', 'The claim must contain an array of exact group names. Check the provider includes it in the ID token.')),
    check('keepDevelopmentLogin', 'Keep development login while preparing identity', 'Disable before production. Test real owner access in another browser session first.'),
    card('Map customer groups to roles', el('p', {}, 'One exact group name per line. Commas belong to the group name. Highest matched role wins; unmatched accounts are members. Empty roles have no group mapping.'),
      el('div', { class: 'setup-grid' }, ...roles.map(role => {
        const control = el('textarea', { rows: '2', 'data-role': role }); control.value = (configuration.settings.roleGroups[role] ?? []).join('\n');
        groupControls[role] = control; control.addEventListener('input', changed); return field(`${role[0].toUpperCase()}${role.slice(1)} groups`, control);
      })), field('Exact groups for the intended first owner', ownerGroups),
      el('p', { class: 'sub' }, 'Generation refuses a preview that cannot reach owner. This preview does not prove the provider sends those groups. Local and IdP groups use the same mapping; additional issuers do not namespace group names.')),
    card('Who may sign in', el('p', {}, 'One entry per line. On an instance with no sign-in policy yet, leaving both lists empty admits everyone your identity provider accepts. Once a policy exists, empty lists admit invited people only, and removing the policy is an edit to idp.admission in the configuration file. People not listed or invited are refused at sign-in. A listed address only counts when the provider confirms it.'),
      el('div', { class: 'setup-grid' }, list('admissionEmails', 'Admitted email addresses'), list('admissionDomains', 'Admitted email domains'),
        list('bootstrapOwners', 'First owners (email addresses)')),
      el('p', { class: 'sub' }, 'First owners get the owner role when they sign in, for providers that send no groups. Each must also be admitted above.')),
    card('Test the installed identity',
      el('p', {}, 'Registered callback: ', el('code', {}, configuration.redirectUri ?? 'Generate OIDC settings to see the callback.')),
      button('Test installed OIDC discovery', () => run(async () => {
        const result = await api('/api/v1/system/setup/identity-test', { method: 'POST' });
        identityResult.replaceChildren(el('p', {}, `${result.ok ? 'Discovery passed' : 'Discovery failed'}: ${result.message}`));
        configuration.identityTest = result; updateFinish();
      })), ' ', configuration.settings.authentication === 'development'
        ? el('p', { class: 'sub' }, 'Apply real identity settings and restart to enable the real sign-in test.')
        : el('a', { href: `/api/auth/${configuration.settings.authentication === 'proxy' ? 'proxy' : 'login'}?returnTo=%2Fadmin%23%2Fsetup` }, 'Sign in with installed identity'),
      identityResult, currentIdentity,
      el('p', { class: 'sub' }, 'Discovery tests provider metadata. A real sign-in tests the callback registration and group mapping. Refresh setup after signing in; a prior result is invalidated when identity settings change.')));
  if (configuration.identityTest) identityResult.append(el('p', {}, `Last installed discovery test: ${configuration.identityTest.ok ? 'passed' : 'failed'}, ${new Date(configuration.identityTest.checkedAt).toLocaleString()}.`));
  const subject = el('input', { type: 'text', maxlength: '1000', autocomplete: 'off' });
  const correlation = el('div', { role: 'status' });
  panels[2].append(el('p', {}, 'Provisioning is optional for the first sample. Use SCIM when the customer manages accounts and groups through its directory.'),
    card('Connect SCIM', el('p', {}, 'Provisioning base URL: ', el('code', {}, configuration.scimUrl)),
      el('p', {}, el('a', { href: '#/tokens' }, 'Create or revoke a SCIM token'), '. Copy the one-time token into the provider connector and provision one test account.'),
      el('p', {}, 'Set externalId to the exact OIDC sub for the primary issuer. For an additional issuer use its id followed by a colon and sub. Email is a display field, never a merge key.')),
    card('Check one account through provision and sign-in', field('Exact durable subject (SCIM externalId)', subject),
      button('Find provisioned account', () => run(async () => {
        const result = await api('/api/v1/system/setup/account-test', { method: 'POST', body: { sub: subject.value } });
        correlation.replaceChildren(el('p', {}, accountText(result.account)), el('p', { class: 'sub' }, result.note));
      })), correlation, el('p', {}, 'Sign in as that person, confirm the same account ID, then change groups and disable it through SCIM. Group changes apply to active sessions; disabling revokes access.')),
    el('p', {}, el('a', { href: '#/docs?doc=identity' }, 'Identity and SCIM reference')));
  panels[3].append(el('p', {}, 'Mount a compatible customer pack, then inspect its source and tools. Configuration changes to the pack path apply after deployment and restart.'),
    input('pack', 'Mounted pack path', 'Use an extracted pack containing tools/ and catalog/, or a supported profile source. Run inspect:pack on the deployed files.'),
    card('Installed pack', el('p', {}, `Engine ${report.pack.engine}; source ${report.pack.source ?? 'unavailable'}; ${report.pack.compatible ? 'compatible' : 'needs attention'}.`),
      ...report.pack.diagnostics.map(message => el('p', { class: 'form-err' }, message)),
      ...report.pack.tools.map(tool => el('details', {}, el('summary', {}, `${tool.id}: ${tool.valid ? 'loads' : 'cannot load'}`),
        el('p', {}, `Server formats: ${tool.serverFormats.join(', ') || 'none'}. Other declared formats: ${tool.unavailableFormats.join(', ') || 'none'}.`),
        ...tool.diagnostics.map(message => el('p', {}, message))))),
    el('p', {}, el('a', { href: '#/instance?tab=design' }, 'Manage brand sources'), ' · ', el('a', { href: '#/instance?tab=providers' }, 'Configure asset providers')),
    el('p', { class: 'sub' }, 'Remote providers still need their own credentials and representative original-file checks. Pack inspection does not fetch remote originals.'));
  const sampleTools = report.pack.tools.filter(tool => tool.valid && tool.serverFormats.some(format => ['svg', 'png', 'jpg'].includes(format)));
  const toolSelect = el('select', { 'aria-label': 'Sample tool' }, ...sampleTools.map(tool => el('option', { value: tool.id }, tool.id)));
  const formatSelect = el('select', { 'aria-label': 'Sample format' });
  const expectedWidth = el('input', { type: 'number', min: '1', max: '100000', step: 'any' });
  const expectedHeight = el('input', { type: 'number', min: '1', max: '100000', step: 'any' });
  const sampleFields = el('div', { class: 'setup-grid' });
  const sampleResult = el('div', { class: 'setup-sample-result', role: 'status' });
  let sampleInputs = [], sampleBlocked = false;
  async function loadTool(keepFormat = false) {
    const desiredFormat = keepFormat ? formatSelect.value : '';
    const edits = new Map(keepFormat ? sampleInputs.flatMap(({ spec, control, initial }) => {
      const value = control.type === 'checkbox' ? control.checked : control.value;
      return value === initial ? [] : [[spec.id, value]];
    }) : []);
    sampleBlocked = false;
    sampleInputs = []; sampleFields.replaceChildren(); formatSelect.replaceChildren();
    if (!toolSelect.value) return;
    const metadata = await api(`/api/v1/system/setup/tools/${encodeURIComponent(toolSelect.value)}${desiredFormat ? `?format=${encodeURIComponent(desiredFormat)}` : ''}`);
    formatSelect.replaceChildren(...metadata.formats.map(format => el('option', { value: format }, format.toUpperCase())));
    if (metadata.formats.includes(desiredFormat || metadata.format)) formatSelect.value = desiredFormat || metadata.format;
    if (!keepFormat) { expectedWidth.value = metadata.expectedDimensions?.widthPx ?? ''; expectedHeight.value = metadata.expectedDimensions?.heightPx ?? ''; }
    sampleFields.replaceChildren(...metadata.inputs.map(spec => {
      if (spec.access === 'locked') return el('p', {}, `${spec.label ?? spec.id}: locked by policy${spec.reason ? `. ${spec.reason}` : ''}.`);
      if (spec.access === 'choice' && !spec.allow?.length) { sampleBlocked = true; return el('p', { class: 'form-err' }, `${spec.label ?? spec.id}: no values satisfy the current tool policy and brand rules. Review those settings before creating a sample.`); }
      if (['asset', 'file', 'blocks', 'vector', 'table'].includes(spec.type)) return el('p', { class: 'sub' }, `${spec.label ?? spec.id}: uses the tool default. Edit complex content in the employee app.`);
      const options = spec.allow ?? spec.options;
      if (!options?.length && spec.value && typeof spec.value === 'object') return el('p', { class: 'sub' }, `${spec.label ?? spec.id}: uses a structured tool default. Edit it in the employee app.`);
      const control = options?.length ? el('select', {}, ...options.map(option => {
        const value = typeof option === 'object' ? option.value : option;
        return el('option', { value: JSON.stringify(value) }, typeof option === 'object' ? option.label ?? String(value) : String(value));
      })) : spec.type === 'longtext' ? el('textarea', { rows: '3' }) : el('input', { type: spec.type === 'boolean' ? 'checkbox' : spec.type === 'number' ? 'number' : ['date', 'time', 'datetime-local', 'url'].includes(spec.type) ? spec.type : 'text' });
      if (options?.length && [...control.options].some(option => option.value === JSON.stringify(spec.value))) control.value = JSON.stringify(spec.value);
      else if (spec.type === 'boolean') control.checked = !!spec.value;
      else control.value = spec.value === undefined || spec.value === null ? '' : String(spec.value);
      if (spec.type === 'number') { if (spec.min !== undefined) control.min = spec.min; if (spec.max !== undefined) control.max = spec.max; control.step = 'any'; }
      const initial = control.type === 'checkbox' ? control.checked : control.value;
      if (edits.has(spec.id)) {
        const edited = edits.get(spec.id);
        if (control.type === 'checkbox') control.checked = edited;
        else if (!options?.length || [...control.options].some(option => option.value === edited)) control.value = edited;
      }
      sampleInputs.push({ spec, control, choices: !!options?.length, initial });
      return field(spec.label ?? spec.id, control, control.type === 'checkbox' ? { class: 'setup-checkbox-row' } : {});
    }));
  }
  toolSelect.addEventListener('change', () => run(loadTool));
  formatSelect.addEventListener('change', () => run(() => loadTool(true)));
  function showSample(record, receipt) {
    render = record; evidence = receipt;
    outputButton.disabled = ['queued', 'running'].includes(record.state);
    sampleResult.replaceChildren(el('p', {}, `Sample ${record.state}${record.error ? `: ${record.error.message}` : ''}.`));
    if (record.state === 'succeeded' && receipt?.inspection) {
      sampleResult.append(el('p', {}, `Checked ${new Date(record.finishedAt ?? record.updatedAt).toLocaleString()}. ${record.output.size} bytes. SHA-256 ${record.output.sha256}.`),
        el('ul', {}, ...receipt.inspection.checks.map(check => el('li', {}, `${check.id}: ${check.state}`))),
        el('p', {}, el('a', { class: 'btn primary', href: record.output.url, download: '' }, 'Download sample'), ' ', el('a', { href: record.output.evidence.url, download: '' }, 'Download evidence')),
        el('p', { class: 'sub' }, 'Checks cover file format, MIME, readability and dimensions. Review the downloaded design visually. The receipt has partial dependency coverage; it is not brand approval or full client compatibility.'));
    }
    updateFinish();
  }
  const outputButton = button('Create checked sample', () => run(async () => {
    if (!toolSelect.value || !formatSelect.value || sampleBlocked) throw new Error('Choose a tool with an available governed format and permitted input values.');
    const inputs = {};
    const verification = { profile: 'output-v1' };
    for (const [key, control] of [['widthPx', expectedWidth], ['heightPx', expectedHeight]]) {
      if (!control.value || !Number.isFinite(Number(control.value)) || Number(control.value) <= 0 || Number(control.value) > 100000) throw new Error('Enter the intended sample width and height in pixels, between 1 and 100000.');
      verification[key] = Number(control.value);
    }
    for (const { spec, control, choices, initial } of sampleInputs) {
      if ((control.type === 'checkbox' ? control.checked : control.value) === initial) continue;
      if (spec.type === 'number' && !control.value) throw new Error(`Enter a number for ${spec.label ?? spec.id}.`);
      inputs[spec.id] = choices ? JSON.parse(control.value) : spec.type === 'boolean' ? control.checked : spec.type === 'number' ? Number(control.value) : control.value;
    }
    const record = await api('/api/v1/renders', { method: 'POST', body: { toolId: toolSelect.value, format: formatSelect.value, inputs, verification, maxAttempts: 1 } });
    progress.sample = { context, id: record.id }; persist(); pollStarted = Date.now(); showSample(record, null); schedulePoll(record.id);
  }), { class: 'primary' });
  function schedulePoll(id) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (disposed) return;
      try {
        const record = await api(`/api/v1/renders/${encodeURIComponent(id)}`);
        if (disposed) return;
        const receipt = record.state === 'succeeded' ? (await api(record.output.evidence.url)).evidence : null;
        if (disposed) return;
        showSample(record, receipt);
        if (['queued', 'running'].includes(record.state)) {
          if (Date.now() - pollStarted < 120_000) schedulePoll(id);
          else sampleResult.append(el('p', {}, 'This sample is still processing. Refresh setup to resume watching it; its durable request is retained.'));
        }
      } catch (failure) { if (!disposed) sampleResult.replaceChildren(el('p', { class: 'form-err' }, `Cannot read this sample: ${failure.message}. Retry or refresh after fixing access or availability.`)); }
    }, 750);
  }
  panels[4].append(el('p', {}, 'Use the running pack and your current permissions. Sample requests use the same export path, policy and managed brand rules as normal work.'),
    input('workerUrl', 'Chromium worker URL', 'Hooked tools usually need the configured worker and LW_RENDER_WORKER_SECRET. SVG tools without hooks can use the built-in renderer.'),
    check('requireServerRendering', 'Require server rendering at production startup', 'Makes incompatible active tools a configuration failure.'),
    check('guestLinks', 'Allow guest links', 'Choose the intended customer sharing policy. Expiry limits remain in the configuration reference.'),
    input('telemetry', 'Telemetry level', 'Choose the intended data collection level.', [['off', 'Off'], ['aggregate', 'Aggregate'], ['standard', 'Standard']]),
    el('p', {}, el('a', { href: '#/chains' }, 'Configure approval chains'), ' · ', el('a', { href: '#/instance?tab=tools' }, 'Configure tool policy')),
    card('Create a representative sample', sampleTools.length ? el('div', { class: 'formrow' }, field('Tool', toolSelect), field('Format', formatSelect))
      : el('p', {}, 'No inspected tool has a checked server format. Resolve the pack and renderer diagnostics, restart if needed, then refresh setup.'),
      sampleFields, el('div', { class: 'setup-grid' }, field('Expected width (px)', expectedWidth), field('Expected height (px)', expectedHeight)),
      el('p', { class: 'sub' }, 'These are checks, not resizing controls. Declared pixel sizes are filled in; set the intended size for physical or input-dependent tools. A sample must pass both dimensions.'),
      outputButton, sampleResult));
  outputButton.disabled = !sampleTools.length;
  const finish = el('div', { class: 'stack' });
  panels[5].append(el('p', {}, 'Readiness and the sample describe this running instance. Complete the customer integration checks that apply to this deployment before acceptance.'), finish);
  const checkInfo = {
    storage: [0, 'Durable storage'], 'development-login': [1, 'Production sign-in'], identity: [1, 'Identity configuration'], access: [4, 'Access boundary'], transport: [0, 'Public HTTPS address'],
    'session-secret': [0, 'Session signing secret'], 'link-secret': [0, 'Link signing secret'], 'renderer-secret': [4, 'Renderer credentials'], signer: [4, 'Export signing'],
    'web-shell': [0, 'Employee application'], 'shell-contract': [0, 'Matched employee client'], 'identity-live': [1, 'Customer identity journey'],
    'renderer-live': [4, 'Matched worker canary'], pack: [3, 'Pack compatibility'], 'database-live': [0, 'Store connectivity'], schema: [0, 'Database schema'],
  };
  function updateFinish() {
    const checked = render?.state === 'succeeded' && evidence?.inspection?.checks.length === 5 && evidence.inspection.checks.every(check => check.state === 'pass');
    finish.replaceChildren(card('Observed results',
      el('p', {}, `Configuration: ${report.ready ? 'ready for the declared mode' : 'needs attention'} (${report.mode}).`),
      el('p', {}, `Real owner sign-in: ${configuration.account.role === 'owner' && configuration.account.signIn ? 'observed for installed identity settings' : 'not observed for installed identity settings'}.`),
      el('p', {}, `OIDC discovery: ${configuration.identityTest ? configuration.identityTest.ok ? 'passed' : 'failed' : 'not tested'}.`),
      el('p', {}, `Checked sample: ${checked ? 'passed; download and review the design' : 'not completed in this setup context'}.`),
      progress.sample && progress.sample.context !== context ? el('p', {}, 'Deployment, pack or governance changed. Create a fresh sample.') : null),
      card('Remaining deployment checks', ...report.checks.map(check => {
        const [target, label] = checkInfo[check.id] ?? [5, check.id];
        return el('div', { class: 'setup-check' }, el('p', {}, el('strong', {}, `${label}: ${check.status}`), ' ', check.message),
          check.status !== 'pass' ? button(`Go to ${titles[target].toLowerCase()}`, () => selectStep(target)) : null);
      })), el('p', {}, guide()));
  }
  const artifactHost = el('div', { class: 'setup-artifacts' });
  const download = (filename, value) => {
    const url = window.URL.createObjectURL(new window.Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const link = el('a', { href: url, download: filename }); link.click(); setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  };
  const generate = button('Generate validated configuration', () => run(async () => {
    proposal = await api('/api/v1/system/setup/configuration', { method: 'POST', body: read() });
    progress.expectedSettingsHash = proposal.expectedSettingsHash; persist(); updateApplied();
    const exportedSnapshot = JSON.stringify(read());
    const exportFile = (filename, value) => { download(filename, value); baseline = exportedSnapshot; status.textContent = 'Configuration exported. Apply it to the deployment source, restart and refresh setup.'; };
    const text = el('textarea', { readonly: '', rows: '12', 'aria-label': 'Validated deployment merge patch' }); text.value = JSON.stringify(proposal.patch, null, 2);
    artifactHost.replaceChildren(card('Apply these deployment settings', ...proposal.warnings.map(message => el('p', {}, message)),
      proposal.redirectUri ? el('p', {}, 'Register this exact callback: ', el('code', {}, proposal.redirectUri)) : null,
      el('p', {}, `Owner preview: ${proposal.ownerPreview.role}. Required environment names: ${proposal.requiredEnvironment.join(', ')}.`),
      el('div', { class: 'policy-rule-actions' }, button('Download setup file', () => exportFile('lolly-setup.json', { version: 1, settings: proposal.settings, expectedSettingsHash: proposal.expectedSettingsHash })),
        button('Download Helm overlay', () => exportFile('lolly-setup.helm.json', proposal.helm))),
      el('p', {}, 'For instance.json, validate then apply the downloaded file to your deployment source:'),
      el('pre', {}, 'pnpm setup:apply ./instance.json ./lolly-setup.json\npnpm setup:apply ./instance.json ./lolly-setup.json --write'),
      el('p', {}, 'Deploy the updated source file and restart. For Helm, add the downloaded overlay after your existing values file. ', guide('apply')),
      el('p', { class: 'sub' }, 'The Helm overlay requires config to be an inline values object. With raw JSON or --set-file, apply the setup file to your source JSON and deploy that file with --set-file config=./instance.json.'),
      el('details', {}, el('summary', {}, 'Review the generated merge patch'), text)));
    status.textContent = 'Configuration validated and generated. It has not been saved to the running deployment.';
  }), { class: 'primary' });
  const back = button('Previous', () => selectStep(step - 1));
  const next = button('Next', () => selectStep(step + 1));
  const actions = el('div', { class: 'policy-rule-actions' }, back, next, generate);
  root.append(actions, status, error, discard, artifactHost);
  const allButtons = () => [...root.querySelectorAll('button')];
  async function run(action) {
    if (busy || disposed) return;
    error.textContent = ''; busy = true;
    const disabled = allButtons().map(entry => [entry, entry.disabled]); disabled.forEach(([entry]) => { entry.disabled = true; });
    const settingsInputs = [...root.querySelectorAll('input,select,textarea')]; settingsInputs.forEach(entry => { entry.disabled = true; });
    let failedControl;
    try { await action(); } catch (failure) { if (!disposed) { error.textContent = failure.message; failedControl = controls[failure.field] ?? listControls[failure.field] ?? (failure.field === 'ownerTestGroups' ? ownerGroups : failure.field === 'roleGroups' ? groupControls.owner : null); } }
    finally { busy = false; if (!disposed) { disabled.forEach(([entry, was]) => { entry.disabled = was; }); settingsInputs.forEach(entry => { entry.disabled = false; }); outputButton.disabled = !sampleTools.length || !formatSelect.value || sampleBlocked || ['queued', 'running'].includes(render?.state); selectStep(step); } }
    if (failedControl && !disposed) { selectStep(Number(failedControl.closest('[data-step]').dataset.step)); failedControl.focus(); }
  }
  baseline = JSON.stringify(read()); updateFinish(); selectStep(step);
  if (sampleTools.length) await run(loadTool);
  if (progress.sample?.context === context && /^rnd_[A-Za-z0-9_-]+$/.test(progress.sample.id)) schedulePoll(progress.sample.id);
  const beforeUnload = event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return { element: root, isDirty, isBusy: () => busy,
    requestDiscard(proceed) {
      if (busy) { error.textContent = 'Wait for the request to finish before leaving.'; return; }
      if (!isDirty()) { proceed(); return; }
      const keep = button('Keep editing', () => { discard.replaceChildren(); generate.focus(); });
      discard.replaceChildren(el('p', {}, 'Discard your unexported setup changes?'), keep, ' ', button('Discard changes', () => { baseline = JSON.stringify(read()); proceed(); })); keep.focus();
    },
    dispose() { disposed = true; clearTimeout(pollTimer); window.removeEventListener('beforeunload', beforeUnload); },
  };
}
