// SPDX-License-Identifier: MPL-2.0
import type { ProviderRecord } from './types.ts';

/** Versioned, public form contract. Secrets have their own write-only controls. */
export interface ProviderSetupField {
  path: string;
  label: string;
  help: string;
  type: 'text' | 'url' | 'number' | 'boolean' | 'lines' | 'select';
  required?: boolean;
  default?: string | number | boolean;
  choices?: string[];
  min?: number;
  max?: number;
}

export const WEBDAV_SETUP = {
  version: 1,
  kind: 'webdav',
  name: 'WebDAV / Nextcloud',
  authKind: 'credential',
  guide: 'provider-webdav',
  limits: [
    'WebDAV has no approval status. Restrict the root to a folder containing approved assets.',
    'Availability dates apply only when your server exposes the named custom DAV properties.',
    'This driver has fixture coverage. Complete the live-verify runbook against your server for customer acceptance.',
  ],
  fields: [
    { path: 'options.flavor', label: 'Server type', type: 'select', choices: ['nextcloud', 'generic'], default: 'nextcloud', help: 'Nextcloud builds its files URL. Generic uses the DAV mount URL you enter.' },
    { path: 'options.baseUrl', label: 'Server URL', type: 'url', required: true, help: 'Nextcloud: server root, including any install subpath. Generic: full DAV mount URL. Use HTTPS; local loopback HTTP is accepted for evaluation.' },
    { path: 'options.username', label: 'Files login (Nextcloud)', type: 'text', help: 'The login in the files URL; defaults to the Basic credential username. Required for Nextcloud with a bearer token.' },
    { path: 'options.root', label: 'Folder to expose', type: 'text', help: 'Relative folder path, for example Brand/Approved. Empty exposes the entire files root. Do not enter a share link.' },
    { path: 'options.recursive', label: 'Include subfolders', type: 'boolean', default: false, help: 'The preview visits at most five directories. A full sync visits at most fifty.' },
    { path: 'options.minGapMs', label: 'Gap between requests (ms)', type: 'number', min: 0, max: 10000, default: 250, help: 'Increase this for a small server. The default is about four requests per second.' },
    { path: 'mapping.defaultType', label: 'Catalog asset type', type: 'text', default: 'image', help: 'Image uses the file formats to detect photos, vectors, video and other files. Enter another catalog type to override.' },
    { path: 'mapping.sectionTags', label: 'Use folder names as tags', type: 'boolean', default: true, help: 'Adds folder sections to the catalog tags.' },
    { path: 'mapping.availabilityFields.from', label: 'Available from property', type: 'text', help: 'Optional custom DAV date property: local name without namespace prefix.' },
    { path: 'mapping.availabilityFields.until', label: 'Available until property', type: 'text', help: 'Optional custom DAV expiry property: local name without namespace prefix.' },
    { path: 'exposure.groups', label: 'Member groups', type: 'lines', help: 'One exact group name per line. Commas stay part of the name. Empty means all members.' },
    { path: 'exposure.includeSections', label: 'Include folder sections', type: 'lines', help: 'Optional exact folder section names, one per line. Empty includes all folders under the root.' },
    { path: 'exposure.excludeTags', label: 'Exclude tags', type: 'lines', help: 'Optional exact tags, one per line. Matching files are excluded.' },
    { path: 'exposure.tier', label: 'Catalog tier', type: 'text', default: 'on-demand', help: 'On-demand loads original files when someone chooses them.' },
    { path: 'sync.ttlSeconds', label: 'Refresh interval (seconds)', type: 'number', min: 1, max: 86400, default: 300, help: 'Cached federation refreshes on access after this interval.' },
  ] satisfies ProviderSetupField[],
} as const;

export const GDRIVE_SETUP = {
  version: 1,
  kind: 'gdrive',
  name: 'Google Drive',
  authKind: 'oauth',
  guide: 'provider-gdrive',
  limits: [
    'Expose one curated folder of approved files. Subfolders and native Google Docs, Sheets and Slides are skipped.',
    'Google Drive supplies no approval status or availability dates to this driver.',
    'Read-only consent can access the connected account’s Drive. The catalog exposes only the configured folder; use an account with suitably limited access.',
    'Fixture coverage is not customer acceptance. Complete the live-verify runbook against your Google Workspace.',
  ],
  fields: [
    { path: 'options.folderId', label: 'Folder id', type: 'text', required: true, help: 'Copy the id after /folders/ in the Drive folder URL, not the entire share link. My Drive and shared drive folders are supported.' },
    ...WEBDAV_SETUP.fields.filter(field => ['mapping.defaultType', 'exposure.groups', 'exposure.tier', 'sync.ttlSeconds'].includes(field.path)),
  ] satisfies ProviderSetupField[],
} as const;

export const PROVIDER_SETUPS = [WEBDAV_SETUP, GDRIVE_SETUP];

/** Validate the guided subset without changing advanced provider contracts. */
export function validateGuidedProvider(cfg: Partial<ProviderRecord>): string | null {
  const descriptor = PROVIDER_SETUPS.find(setup => setup.kind === cfg.kind);
  if (!descriptor) return 'guided setup is currently available for webdav and gdrive';
  const fields = descriptor.fields as ProviderSetupField[];
  for (const section of ['options', 'mapping', 'exposure', 'sync'] as const) {
    const value = cfg[section];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${section} must be an object`;
    const allowed = fields.filter(field => field.path.startsWith(section + '.')).map(field => field.path.split('.')[1]);
    if (Object.keys(value).some(key => !allowed.includes(key))) return `unsupported ${section} field in guided setup; use the advanced provider API for other settings`;
  }
  const availability = cfg.mapping?.availabilityFields;
  if (availability !== undefined && (!availability || typeof availability !== 'object' || Array.isArray(availability) || Object.keys(availability).some(key => !['from', 'until'].includes(key)))) return 'availabilityFields must contain only from and until properties';
  for (const field of fields) {
    let value: unknown = cfg;
    for (const key of field.path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (value === undefined) {
      if (field.required) return `${field.label} is required`;
      continue;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') return `${field.label} must be a boolean`;
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isInteger(value) || value < (field.min ?? 0) || value > (field.max ?? Infinity))) return `${field.label} is outside its allowed range`;
    if (field.type === 'lines' && (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 300 || /[\r\n\x00-\x1f]/.test(v)))) return `${field.label} must contain at most 100 exact names`;
    if (['text', 'url', 'select'].includes(field.type) && (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f]/.test(value))) return `${field.label} must be text without control characters`;
    if (field.choices && !field.choices.includes(value as string)) return `${field.label} must be one of ${field.choices.join(', ')}`;
    if (field.required && value === '') return `${field.label} is required`;
  }
  if (cfg.kind === 'gdrive') return /^[A-Za-z0-9_-]{1,200}$/.test(cfg.options?.folderId as string) ? null : 'Folder id must be the Drive id, without a URL or path';
  try {
    const url = new URL(cfg.options?.baseUrl as string);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) return 'Server URL must use HTTPS without credentials, query or fragment (loopback HTTP is allowed for evaluation)';
  } catch { return 'Server URL must be a valid URL'; }
  if ((cfg.options?.root as string | undefined)?.split('/').some(part => part === '.' || part === '..' || part.includes('\\'))) return 'Folder must be a relative path without traversal segments';
  return null;
}
