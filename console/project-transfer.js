// SPDX-License-Identifier: MPL-2.0
/** A lazy metadata preview; project content and access are never changed here. */
export function projectTransferCard(projectId, { el, api, download }) {
  const heading = el('h3', {}, 'Prepare to move this project');
  const status = el('p', { class: 'sub', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    'Review the records and access arrangements before planning a move.');
  const details = el('div', { class: 'stack' });
  const previewButton = el('button', { class: 'btn', type: 'button' }, 'Preview transfer');
  const downloadButton = el('button', { class: 'btn', type: 'button' }, 'Download inventory JSON');
  downloadButton.hidden = true;
  downloadButton.disabled = true;
  const root = el('section', { class: 'card stack' }, heading,
    el('p', { class: 'sub' }, 'This preview does not copy content, move the project or change anyone\'s access.'),
    el('div', { class: 'lc-actions' }, previewButton, downloadButton), status, details);
  let latest = null, busy = false, downloading = false;
  const projectKey = typeof projectId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(projectId);
  const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  const rowsOnly = (rows, keys) => Array.isArray(rows) && rows.every(row => only(row, keys));
  const strings = rows => Array.isArray(rows) && rows.every(value => typeof value === 'string');
  const scalars = value => value && typeof value === 'object' && Object.values(value).every(field => field === null || typeof field === 'string'
    || typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field));
  // Reject unexpected content-bearing fields instead of downloading an answer
  // that no longer follows this metadata-only schema. Preserve accepted values
  // as returned so the observation hash continues to identify the same object.
  const metadataOnly = value => only(value, ['schema', 'mode', 'readOnly', 'snapshotConsistent', 'complete', 'importReady',
    'observedAt', 'observationStartedAt', 'project', 'counts', 'coverage', 'limits', 'folders', 'sessions', 'files', 'access',
    'warnings', 'invalidFolderReferences', 'observationSha256'])
    && only(value.project, ['id', 'name', 'archived'])
    && only(value.counts, ['folders', 'sessions', 'files', 'declaredFileBytes', 'explicitMembers', 'omittedSessions'])
    && only(value.coverage, ['fileBytesVerified', 'assetDependenciesComplete', 'historyComplete', 'identitiesMapped',
      'pendingUploadsInspected', 'deletedSessionsInspected', 'liveGesturesInspected', 'legacyRevisionHistory', 'sessionVersionHistory'])
    && (!value.coverage.legacyRevisionHistory || only(value.coverage.legacyRevisionHistory, ['inspected', 'retentionLimit']))
    && (!value.coverage.sessionVersionHistory || only(value.coverage.sessionVersionHistory, ['sampled', 'sampleLimitPerSession', 'fullHistoryVerified']))
    && Object.entries(value.coverage).every(([key, field]) => ['legacyRevisionHistory', 'sessionVersionHistory'].includes(key) ? scalars(field) : typeof field === 'boolean')
    && (!value.limits || only(value.limits, ['sessions', 'files', 'folders', 'members']) && scalars(value.limits))
    && rowsOnly(value.folders, ['id', 'parentId', 'sessionIds', 'fileIds'])
    && value.folders.every(row => (typeof row.id === 'string') && (row.parentId === null || typeof row.parentId === 'string') && strings(row.sessionIds) && strings(row.fileIds))
    && rowsOnly(value.sessions, ['id', 'toolId', 'toolVersion', 'revision', 'updatedAt', 'activeCollaborationLease', 'versionSample'])
    && value.sessions.every(row => only(row.versionSample, ['count', 'limit', 'moreMayExist']) && scalars(row.versionSample)
      && scalars(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'versionSample'))))
    && rowsOnly(value.files, ['id', 'declaredBytes', 'declaredSha256', 'contentType', 'partCount', 'bytesVerified'])
    && value.files.every(scalars)
    && only(value.access, ['ownerId', 'visibility', 'general', 'groups', 'settings', 'members', 'destinationMappingRequired'])
    && (value.access.ownerId === undefined || typeof value.access.ownerId === 'string')
    && (value.access.destinationMappingRequired === undefined || value.access.destinationMappingRequired === true)
    && (!value.access.visibility || value.access.visibility === 'private' || only(value.access.visibility, ['groups']) && strings(value.access.visibility.groups))
    && (!value.access.general || only(value.access.general, ['audience', 'role']) && scalars(value.access.general))
    && (!value.access.settings || only(value.access.settings, ['viewersCanComment', 'viewersCanExport', 'editorsCanShare']) && scalars(value.access.settings))
    && (!value.access.groups || rowsOnly(value.access.groups, ['kind', 'name', 'id', 'role', 'expiresAt']) && value.access.groups.every(scalars))
    && rowsOnly(value.access.members, ['userId', 'role', 'expiresAt']) && value.access.members.every(scalars);
  const valid = value => metadataOnly(value)
    && value.schema === 'lolly-project-transfer-inventory-v1' && value.mode === 'preview'
    && value.readOnly === true && value.snapshotConsistent === false && value.complete === false && value.importReady === false
    && value.project?.id === projectId && typeof value.project.name === 'string' && typeof value.project.archived === 'boolean'
    && ['fileBytesVerified', 'assetDependenciesComplete', 'historyComplete', 'identitiesMapped'].every(key => value.coverage[key] === false)
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
    && (value.observationStartedAt === undefined || typeof value.observationStartedAt === 'string' && Number.isFinite(Date.parse(value.observationStartedAt)))
    && (value.observationSha256 === undefined || typeof value.observationSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.observationSha256))
    && (value.invalidFolderReferences === undefined || Number.isSafeInteger(value.invalidFolderReferences) && value.invalidFolderReferences >= 0)
    && value.counts && ['folders', 'sessions', 'files', 'declaredFileBytes', 'explicitMembers', 'omittedSessions']
      .every(key => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0)
    && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(warning));
  const failure = error => error?.status === 401 ? 'Sign in again with a person\'s account, then retry the preview.'
    : error?.status === 403 ? 'Your account needs project manager access and project.manage permission. Agent and service tokens cannot request this preview.'
    : error?.status === 404 ? 'This project is unavailable to your account, or the server does not yet support transfer previews.'
    : error?.status === 413 ? 'This project exceeds the preview limits. Ask your operator to arrange an inventory for a larger project.'
    : error?.status === 429 ? 'Too many preview requests. Wait a moment before trying again.'
    : 'The preview could not be loaded. Check the connection and instance status, then try again.';
  const show = value => {
    const counts = value.counts, number = value => value.toLocaleString();
    details.append(el('p', {}, value.project.name + (value.project.archived ? ' (archived)' : '')),
      el('p', {}, `${number(counts.folders)} folders · ${number(counts.sessions)} visible sessions · ${number(counts.explicitMembers)} explicit members`),
      el('p', {}, `${number(counts.files)} ready shared files · ${number(counts.declaredFileBytes)} declared file bytes (unverified)`),
      el('p', { class: 'sub' }, 'Observed ', el('time', { datetime: value.observedAt }, new Date(value.observedAt).toLocaleString())),
      el('p', { class: 'sub' }, 'Plan only: these reads are not a consistent snapshot, and this JSON cannot restore a project.'),
      el('p', { class: 'sub' }, 'Before moving, verify file bytes and asset dependencies, review retained history, and map destination accounts and groups.'));
    if (value.warnings.includes('LIVE_COLLABORATION')) details.append(el('p', { class: 'sub' },
      'Live collaboration was observed. Arrange a migration window; this preview leaves editing sessions running.'));
    if (counts.omittedSessions) details.append(el('p', { class: 'sub' },
      `${number(counts.omittedSessions)} ${counts.omittedSessions === 1 ? 'session was' : 'sessions were'} excluded by your access policy. Their IDs and content are not included.`));
    if (value.warnings.includes('FOLDER_REFERENCES_UNRESOLVED') || value.warnings.includes('FOLDER_CYCLE')) details.append(el('p', { class: 'sub' },
      'Some folder references could not be resolved. Review the folder structure before planning a move.'));
  };
  previewButton.addEventListener('click', async () => {
    if (!projectKey || busy || downloading) return;
    busy = true;
    latest = null;
    details.replaceChildren();
    downloadButton.hidden = true;
    downloadButton.disabled = true;
    previewButton.disabled = true;
    previewButton.textContent = 'Loading preview...';
    root.setAttribute('aria-busy', 'true');
    status.textContent = 'Checking project metadata and access. Editors can keep working.';
    try {
      const value = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/transfer-inventory`);
      if (!valid(value)) {
        status.textContent = 'The server returned an unsupported preview. Update the console and server to compatible releases, then try again.';
        return;
      }
      latest = value;
      show(value);
      downloadButton.hidden = false;
      downloadButton.disabled = false;
      status.textContent = 'Transfer preview ready. Review the remaining work before planning a move.';
    } catch (error) {
      status.textContent = failure(error);
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      previewButton.disabled = false;
      previewButton.textContent = latest ? 'Refresh preview' : 'Try again';
    }
  });
  downloadButton.addEventListener('click', async () => {
    if (!latest || busy || downloading || !valid(latest)) return;
    downloading = true;
    previewButton.disabled = true;
    downloadButton.disabled = true;
    try {
      await download(latest, `lolly-${projectId}-transfer-preview.json`);
      status.textContent = 'Inventory download prepared. It contains private project metadata; keep it with your operational records.';
    } catch {
      status.textContent = 'The download could not start. Try again or refresh the preview.';
    } finally {
      downloading = false;
      previewButton.disabled = false;
      downloadButton.disabled = !latest;
    }
  });
  if (!projectKey) {
    previewButton.disabled = true;
    status.textContent = 'Open a saved project to inspect its transfer preview.';
  }
  return root;
}
