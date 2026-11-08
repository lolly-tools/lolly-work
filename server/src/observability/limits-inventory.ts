// SPDX-License-Identifier: MPL-2.0
/**
 * Every limit Lolly Work enforces, for the console's Limits and quotas panel (plans/82
 * M7; Andy, 2026-11-07: every limit visible to admins with its value and source). Each
 * value is read from the constant or the setting the enforcing code reads, so the page
 * cannot drift from the code. A setting reads as configuration only where it differs
 * from the built-in default, because the parsed configuration always holds a value.
 */
import { DEFAULTS, type InstanceConfig } from '../config/instance.ts';
import { TOKEN_LIMIT_KEYS, TOKEN_LIMIT_MAX, TOKEN_LIMIT_SEED } from '../iam/token-limits.ts';
import { CREDENTIAL_DEFAULT_DAYS, CREDENTIAL_MAX_DAYS, CREDENTIAL_MIN_DAYS } from '../iam/credential-expiry.ts';
import { EXPIRING_WITHIN_DAYS, MAX_TOKEN_TOOLS } from '../programmes/token-routes.ts';
import { MAX_RENDER_CONCURRENCY, RENDER_RUNNER_DEFAULTS } from '../renders/runner.ts';
import { MAX_ROWS as RENDER_BATCH_MAX_ROWS } from '../renders/batch.ts';
import { BATCH_LIMITS } from '../automation/discovery.ts';
import { RENDER_ARCHIVE_MAX_BYTES } from '../renders/archive.ts';
import { LEASE_MAX_WAIT_MS, LEASE_RESULT_MAX_BYTES } from '../render/lease-routes.ts';
import {
  INCOMPLETE_AFTER_MS, MAX_BODY_BYTES as RENDER_API_BODY_BYTES, MAX_URL_GENERATIONS, MAX_URL_QUERY, MAX_WAITERS as MIGRATION_RENDER_WAITERS,
  SYNC_LIMIT_MS, URL_RETRY_WINDOW_MS,
} from '../render-api/routes.ts';
import { MAX_BODY_BYTES as INTENTS_BODY_BYTES } from '../automation/intents.ts';
import { INLINE_OUTPUT_BYTES, MAX_MESSAGE_BYTES as ORG_MCP_BODY_BYTES } from '../automation/org-mcp.ts';
import { BRAND_MCP_INLINE_BYTES, MAX_MESSAGE_BYTES as BRAND_MCP_BODY_BYTES } from '../brand-pages/mcp.ts';
import { TRANSFER_MAX_BYTES, TRANSFER_PART_BYTES } from '../uploads/parts.ts';
import {
  uploadPolicy, UPLOAD_DEFAULTS, UPLOAD_IDLE_MS, UPLOAD_LIST_LIMIT, UPLOAD_OVERHEAD_BYTES,
  UPLOAD_PENDING_LIMIT, UPLOAD_SWEEP_GRACE_MS,
} from '../uploads/scoped.ts';
import { FILE_INLINE_MAX_BYTES, FILE_LIST_LIMIT, FILE_REPORT_MAX_BYTES } from '../uploads/files.ts';
import { INLINE_BODY_BYTES, READ_BUDGETS_PER_DAY } from '../uploads/file-routes.ts';
import {
  PROJECT_FILE_DEFAULTS, PROJECT_FILE_IDLE_MS, PROJECT_FILE_MAX_BYTES, PROJECT_FILE_OVERHEAD_BYTES,
  PROJECT_FILE_PART_BYTES, PROJECT_FILE_PENDING_FILES, PROJECT_FILE_PENDING_LIMIT, PROJECT_FILE_SWEEP_GRACE_MS,
} from '../projects/files.ts';
import {
  approvalArtifactPolicy, APPROVAL_ARTIFACT_DEFAULTS, APPROVAL_ARTIFACT_MAX_FILE_BYTES, APPROVAL_RECORD_MAX_BYTES,
} from '../approvals/export-review.ts';
import { MAX_DATA_SUBMISSION_BYTES } from '../catalog/submit-data.ts';
import { MAX_RULES_FILE_BYTES } from '../catalog/rules-tools.ts';
import { PURGE_GRACE_MS } from '../renders/retention.ts';
import { DEFAULT_TTL_SEC, LINK_ACCESS_MAX_SEC, LINK_MAX_TTL_HOURS } from '../links/sign.ts';
import { MAX_INVITE_TTL_HOURS, resolveInvitePolicy } from '../policy/invites.ts';
import { MAX_GRANT_DAYS, resolveSharingPolicy } from '../policy/sharing.ts';
import { EXIT_LIST_MAX, EXIT_ROW_BOUND } from '../programmes/exit.ts';
import { REOPEN_DAYS } from '../programmes/reopen.ts';
import { NOTICE_DAYS_BEFORE, PROGRAMME_SWEEP_MS } from '../programmes/exit-schedule.ts';
import { CURRENCY_CODE_LENGTH, LIMITS as PROFILE_LIMITS, MAX_EDITORS } from '../programmes/profile.ts';
import { LOGO_MIN_CONTRAST, LOGO_TYPES, PNG_MAX_BYTES, PNG_MIN_LONG_SIDE, SVG_MAX_BYTES } from '../programmes/logo-checks.ts';

import {
  COMMENT_BODY_BYTES, DELIVERY_BODY_BYTES, FORM_BODY_BYTES, FORM_BODY_LARGE_BYTES, JSON_BODY_CONTROL_BYTES, JSON_BODY_DEFAULT_BYTES,
  JSON_BODY_LIST_BYTES, JSON_BODY_MEDIUM_BYTES, JSON_BODY_SMALL_BYTES, PROVIDER_PUBLISH_BYTES,
} from '../api/body-limits.ts';
import { SCIM_TOKEN_DEFAULT_DAYS, SCIM_TOKEN_MAX_DAYS } from '../scim/tokens.ts';
import { DEVICE_CODE_TTL_SEC, MAX_PENDING as DEVICE_MAX_PENDING, PER_IP_STARTS, PER_IP_WINDOW_MS } from '../iam/device-auth.ts';
import { PASSWORD_LINK_TTL_MS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../iam/password.ts';
import { SCRYPT_MAX_WAITERS } from '../lib/crypto.ts';
import { ACCOUNT_NAME_MAX } from '../iam/activate-page.ts';
import { LINKED_STANDING_DAYS } from '../iam/identities.ts';
import { INVITATION_EMAILS_MAX } from '../iam/github.ts';
import { INVITE_TOKEN_MAX } from '../access/invite-token.ts';
import { VIEW_AS_TTL_SEC } from '../programmes/view-as.ts';
import { AGENT_LIMIT, EVENT_LIMIT } from '../agents/dashboard.ts';
import { OUTPUT_TOKEN_SECONDS } from '../renders/output-token.ts';
import { RENDER_READ_FILE_LIMIT, TICKET_MAX_LENGTH } from '../render/read-ticket.ts';
import { MAX_BYTES as INSPECT_MAX_BYTES, MAX_PIXELS as INSPECT_MAX_PIXELS, MAX_SVG_BYTES as INSPECT_MAX_SVG_BYTES } from '../render/output-inspection.ts';
import { PRODUCTION_MAX_PIXELS } from '../render/production-limits.ts';
import {
  COMMENT_NOTICE_COUNT_MAX, SESSION_REVISION_LIMIT, VERSION_DAILY_DAYS, VERSION_INSTANCE_MAX_BYTES, VERSION_LABEL_MAX, VERSION_LIST_MAX, VERSION_MAX_AGE_DAYS,
  VERSION_NAMED_PER_PERSON, VERSION_NAMED_PER_SESSION, VERSION_RECENT_KEEP, VERSION_RESTORE_KEEP, VERSION_SESSION_MAX_BYTES,
  PROJECT_TRANSFER_METADATA_MAX_LIMITS,
} from '../store/types.ts';
import { VERSION_CHANGES_PER_HOUR, VERSION_CHANGES_PER_MINUTE } from '../versions/routes.ts';
import {
  COMMENT_PEOPLE_PER_MINUTE, COMMENT_READS_MAX_IDS, COMMENT_READS_PER_MINUTE, COMMENT_WRITES_PER_HOUR, COMMENT_WRITES_PER_MINUTE,
} from '../comments/routes.ts';
import { ACTOR_NOTICE_LIMIT, ACTOR_NOTICE_WINDOW_MS, NOTICE_FANOUT_LIMIT, NOTICE_KEEP, NOTICE_MAX_AGE_MS } from '../comments/notices.ts';
import { ASKS_PER_DAY } from '../access/routes.ts';
import { APPROVERS_MAX, JOIN_PER_EMAIL, JOIN_WINDOW_DAYS, NAME_MAX as REQUEST_NAME_MAX, NOTE_MAX as REQUEST_NOTE_MAX, SWITCH_PER_INVITATION_PER_DAY } from '../access/requests.ts';
import { NOTICE_DAYS as INBOX_NOTICE_DAYS } from '../access/messages.ts';
import {
  PEOPLE_LIMIT, SHARE_GRANT_LIMIT, SHARE_GROUP_DESCRIPTION_MAX, SHARE_GROUP_MEMBER_LIMIT, SHARE_GROUP_NAME_MAX, SHARE_GROUPS_PER_OWNER,
  SHARE_PEOPLE_PER_MINUTE,
} from '../access/share-routes.ts';
import { ROWS_MAX as ACCESS_REPORT_ROWS } from '../projects/effective-access.ts';
import { DOWNLOAD_BUDGETS_PER_DAY } from '../projects/file-routes.ts';
import { TRANSFER_INVENTORY_LIMITS } from '../projects/transfer-inventory.ts';
import { MAX_SNAPSHOT_BYTES, RETAIN_MS as SNAPSHOT_RETAIN_MS } from '../catalog/delivery.ts';
import { PACK_MAX_BYTES } from '../catalog/instance-pack.ts';
import { BROWSE_MAX_LIMIT } from '../catalog/asset-browse.ts';
import {
  ASSET_SCAN_MAX_DEPTH, ASSET_SCAN_MAX_NODES, LICENCE_ATTRIBUTION_MAX, LICENCE_DECLARATION_MAX, MARK_HOLDER_MAX, MARK_TERMS_MAX,
  RIGHTS_NOTE_MAX,
} from '../catalog/rights.ts';
import { MAX_FILE_BYTES as PROOF_FILE_BYTES, MAX_TOTAL_BYTES as PROOF_TOTAL_BYTES } from '../catalog/resource-proofs.ts';
import { PROVIDER_OAUTH_LIMITS } from '../catalog/providers/setup-oauth.ts';
import { SETUP_PREVIEW_LIMITS } from '../catalog/providers/setup-preview.ts';
import { FILE_CAP as PENPOT_FILE_CAP } from '../catalog/providers/penpot.ts';
import { PREVIEW_INPUT_LIMIT } from '../catalog/file-preview.ts';
import {
  BRAND_EDIT_MAX_BYTES, MAX_CHANGES as BRAND_EDIT_MAX_CHANGES, MAX_DEPTH as BRAND_EDIT_MAX_DEPTH, MAX_NODES as BRAND_EDIT_MAX_NODES,
  MAX_ROLE_DESCRIPTION as BRAND_EDIT_MAX_ROLE_DESCRIPTION, MAX_ROLE_LABEL as BRAND_EDIT_MAX_ROLE_LABEL, MAX_ROLES as BRAND_EDIT_MAX_ROLES,
  MAX_TEXT as BRAND_EDIT_MAX_TEXT,
} from '../brand/edit-document.ts';
import { HISTORY_LIMIT as BRAND_EDIT_HISTORY, KEEP_DOCUMENTS as BRAND_EDIT_KEEP } from '../brand/edit-routes.ts';
import { NAME_MAX as POLICY_NAME_MAX, REASON_MAX as POLICY_REASON_MAX } from '../policy/overlay.ts';
import { MAX_BODY_BYTES as FLAG_ANSWER_BYTES } from '../policy/ofrep.ts';
import { MAX_MANIFEST_BYTES } from '../brand-pages/bundle.ts';
import { HISTORY_LIMIT as BRAND_PAGE_HISTORY, INDEX_LIMIT as BRAND_PAGE_INDEX, STAGED_GRACE_MS } from '../brand-pages/routes.ts';
import { USAGE_AUDIT_ROWS, USAGE_MAX_DAYS } from '../programmes/usage-routes.ts';
import { CHOICE_NOTE_MAX, CHOICES_PER_REQUEST } from '../programmes/rights.ts';
import { RIGHTS_LIMITS } from '../programmes/rights-routes.ts';
import { TIMEOUT_MS as SMTP_TIMEOUT_MS } from '../notify/smtp.ts';

import {
  CONNECTS_PER_USER_PER_MIN, JOIN_TIMEOUT_MS, MAX_BOXES_PER_COLLECTION, MAX_BUFFERED_BYTES, MAX_CHAT_CHARS, MAX_COLLECTIONS_PER_ROOM,
  MAX_DESIGN_SYSTEM_CHARS, MAX_GUEST_NAME_CHARS, MAX_MESSAGE_BYTES as COLLAB_MESSAGE_BYTES, MAX_OPS_PER_MESSAGE, MAX_PARAMS_PER_ROOM,
  MAX_QUEUED_MESSAGES, MAX_ROW_FIELDS, MAX_SCALAR_CHARS, MAX_SOCKETS, MAX_SOCKETS_PER_USER, MAX_TICKETS, MAX_TRACKED_CLIENTS,
  NEARBY_TTL_MS, OPS_MESSAGES_PER_SEC, OPS_PER_SEC, PRESENCE_FRAMES_PER_SEC, SOCKET_TICKET_TTL_MS, WRITER_CAP, WRITER_CAP_PER_USER,
} from '../collab/limits.ts';
import { MIGRATION_LOCK_TIMEOUT, MIGRATION_STATEMENT_TIMEOUT, PG_CONNECT_TIMEOUT_MS, PG_IDLE_TIMEOUT_MS } from '../store/limits.ts';
import { POSTGRES_BLOB_MAX_BYTES } from '../blobs/limits.ts';
import { RETIRE_REASON_MAX } from '../audit/limits.ts';

import { MAX_TITLE_CHARS as INBOX_TITLE_CHARS } from '../access/messages.ts';
import { MAX_DEPTH as AUDIT_MAX_DEPTH, MAX_ENTRIES as AUDIT_MAX_ENTRIES, MAX_NODES as AUDIT_MAX_NODES, MAX_STRING as AUDIT_MAX_STRING } from '../audit/privacy.ts';
import { MAX_ENTRIES as BRAND_PAGE_ENTRIES } from '../brand-pages/bundle.ts';
import { MAX_CURSOR as BROWSE_MAX_CURSOR, MAX_PARAM as BROWSE_MAX_PARAM } from '../catalog/asset-browse.ts';
import { MAX_EXTRACTED_TEXT } from '../catalog/asset-meta.ts';
import { MAX_MEMBERS as COLLECTION_MAX_MEMBERS } from '../catalog/collections.ts';
import { MAX_DIRS as WEBDAV_MAX_DIRS } from '../catalog/providers/webdav.ts';
import { MAX_ENTRIES as RULES_FILE_ENTRIES } from '../catalog/rules-tools.ts';
import { MAX_HIDDEN_PATTERNS, MAX_PATTERN_LENGTH } from '../catalog/tag-rules.ts';
import { MAX_MENTION_NAME } from '../comments/mentions.ts';
import { MAX_ITEMS as EDGE_PURGE_ITEMS } from '../edge/routes.ts';
import { MAX_TOKEN_TOOLS as SERVICE_TOKEN_TOOLS } from '../iam/token-scopes.ts';
import { MAX_TITLE_CHARS as COMMENT_NOTICE_TITLE_CHARS, NOTICE_EXCERPT_CHARS } from '../inbox/comment-notices.ts';
import { MAX_FLAG_GROUP_RULES } from '../policy/feature-flags.ts';
import { MAX_PROJECT_NAME_CHARS, MAX_TITLE_CHARS as SHARING_TITLE_CHARS } from '../projects/sharing.ts';
import { MAX_METADATA_CHARS, MAX_PASSTHROUGH_CHARS } from '../render-api/mappers.ts';
import { MAX_IGNORED as MAPPING_MAX_IGNORED, MAX_NAME as MAPPING_MAX_NAME } from '../render-api/mapping.ts';
import { MAX_RASTER_EDGE_PX } from '../render/pipeline.ts';
import { MAX_ATTR_LEN as TELEMETRY_LABEL_CHARS } from '../telemetry/ingest.ts';

export interface LimitEntry {
  id: string;
  area: string;
  label: string;
  value: number | string | boolean | null;
  unit?: 'per-minute' | 'per-second' | 'bytes' | 'seconds' | 'ms' | 'days' | 'rows' | 'count' | 'mode';
  source: 'configuration' | 'environment' | 'built-in';
  note?: string;
}

/** Parsed config fields include their parser defaults. Absent fields use the enforcing defaults. */
/** The figures a running render runner holds, which are the ones it enforces. */
export interface RunnerFigures { concurrency: number; leaseMs: number; timeoutMs: number }

export function limitsInventory(config: InstanceConfig, extra: { partnerRightsMode?: string; env?: NodeJS.ProcessEnv; runner?: RunnerFigures | null } = {}): LimitEntry[] {
  const limits: LimitEntry[] = [];
  let area = 'Rate limits';
  const add = (id: string, label: string, value: LimitEntry['value'], unit?: LimitEntry['unit'], note?: string,
    source: LimitEntry['source'] = 'built-in'): void => {
    limits.push({ id, area, label, value, ...(unit ? { unit } : {}), source, ...(note ? { note } : {}) });
  };
  // The parsed configuration holds a value for every setting, so one equal to the
  // built-in default reads as built-in, and only a changed one as configuration.
  const setting = (id: string, label: string, value: LimitEntry['value'] | undefined, fallback: LimitEntry['value'],
    unit?: LimitEntry['unit'], note?: string): void => {
    const changed = value !== undefined && value !== fallback;
    add(id, label, value === undefined ? fallback : value, unit, note, changed ? 'configuration' : 'built-in');
  };

  setting('rateLimit.enabled', 'Rate limiting enabled', config.rateLimit?.enabled, DEFAULTS.rateLimit.enabled);
  setting('rateLimit.maxBuckets', 'Rate limit buckets per process', config.rateLimit?.maxBuckets, DEFAULTS.rateLimit.maxBuckets, 'count');
  const surfaces = { auth: 'Sign-in', telemetry: 'Telemetry', link: 'Public link', automation: 'Automation', brandPage: 'Brand page' } as const;
  for (const surface of Object.keys(surfaces) as (keyof typeof surfaces)[]) {
    setting(`rateLimit.${surface}.capacity`, `${surfaces[surface]} burst per IP`, config.rateLimit?.[surface]?.capacity,
      DEFAULTS.rateLimit[surface].capacity, 'count');
    setting(`rateLimit.${surface}.refillPerSec`, `${surfaces[surface]} refill per IP`, config.rateLimit?.[surface]?.refillPerSec,
      DEFAULTS.rateLimit[surface].refillPerSec, 'per-second');
  }

  area = 'Sign-in and accounts';
  const hours = (h: number | undefined): number | undefined => (h === undefined ? undefined : h * 3600);
  setting('policy.sessionTtlHours', 'Sign-in session lifetime', hours(config.policy?.sessionTtlHours), DEFAULTS.policy.sessionTtlHours * 3600, 'seconds');
  const sessionMax = config.policy?.sessionMaxHours;
  add('policy.sessionMaxHours', 'Longest a renewed session lasts', (sessionMax ?? config.policy?.sessionTtlHours ?? DEFAULTS.policy.sessionTtlHours) * 3600, 'seconds',
    sessionMax === undefined ? 'Equal to the session lifetime, so a session is not renewed.' : undefined, sessionMax === undefined ? 'built-in' : 'configuration');
  add('idp.linkedStandingDays', 'How long one sign-in carries over to linked ones', config.idp?.linkedStandingDays ?? LINKED_STANDING_DAYS, 'days',
    'Its groups and standing.', config.idp?.linkedStandingDays === undefined ? 'built-in' : 'configuration');
  add('auth.passwordMinLength', 'Shortest password', PASSWORD_MIN_LENGTH, 'count', 'Characters.');
  add('auth.passwordMaxLength', 'Longest password', PASSWORD_MAX_LENGTH, 'count', 'Characters.');
  add('auth.passwordLinkMs', 'One-time sign-in link lifetime', PASSWORD_LINK_TTL_MS, 'ms');
  add('auth.passwordChecksWaiting', 'Password checks waiting at once', SCRYPT_MAX_WAITERS, 'count', 'Per Work process.');
  add('auth.accountNameLength', 'Account name length', ACCOUNT_NAME_MAX, 'count', 'Characters.');
  add('auth.deviceCodeSeconds', 'Device sign-in code lifetime', DEVICE_CODE_TTL_SEC, 'seconds');
  add('auth.devicePending', 'Device sign-ins waiting at once', DEVICE_MAX_PENDING, 'count');
  add('auth.deviceStartsPerAddress', 'Device sign-ins started per address', PER_IP_STARTS, 'count', 'In the window below.');
  add('auth.deviceStartsWindowMs', 'Device sign-in start window', PER_IP_WINDOW_MS, 'ms');
  add('auth.invitationEmails', 'Extra addresses matched per identity', INVITATION_EMAILS_MAX, 'count', 'For invitation matching.');
  add('auth.inviteTokenLength', 'Invitation token length read', INVITE_TOKEN_MAX, 'count', 'Characters.');
  add('auth.viewAsSeconds', 'View-as lifetime', VIEW_AS_TTL_SEC, 'seconds');
  add('scim.tokenDefaultDays', 'SCIM token lifetime', SCIM_TOKEN_DEFAULT_DAYS, 'days');
  add('scim.tokenMaxDays', 'Maximum SCIM token lifetime', SCIM_TOKEN_MAX_DAYS, 'days');

  area = 'Agent tokens';
  const tokenLabels = { callsPerMinute: 'Calls a minute per agent token', rendersPerDay: 'Renders a day per agent token', rendersPerMonth: 'Renders a month per agent token' } as const;
  for (const key of TOKEN_LIMIT_KEYS) {
    const unit = key === 'callsPerMinute' ? 'per-minute' : 'count';
    setting(`automation.tokenLimits.${key}`, tokenLabels[key], config.automation?.tokenLimits?.[key], TOKEN_LIMIT_SEED[key], unit,
      'Partner token default. Programme and token overrides take precedence. Null means no cap.');
    add(`tokens.${key}.maximum`, `Maximum ${tokenLabels[key].toLowerCase()}`, TOKEN_LIMIT_MAX[key], unit);
  }
  add('tokens.lifetimeDefaultDays', 'Programme token lifetime', CREDENTIAL_DEFAULT_DAYS, 'days');
  add('tokens.lifetimeMinDays', 'Minimum programme token lifetime', CREDENTIAL_MIN_DAYS, 'days');
  add('tokens.lifetimeMaxDays', 'Maximum programme token lifetime', CREDENTIAL_MAX_DAYS, 'days');
  add('tokens.maxTools', 'Tools per programme token', MAX_TOKEN_TOOLS, 'count');
  add('tokens.expiringWithinDays', 'Token expiry warning window', EXPIRING_WITHIN_DAYS, 'days');
  add('agents.dashboardEvents', 'Agent events read for the dashboard', EVENT_LIMIT, 'count');
  add('agents.dashboardAgents', 'Agents shown on the dashboard', AGENT_LIMIT, 'count');
  add('serviceTokens.maxTools', 'Tools per service token', SERVICE_TOKEN_TOOLS, 'count');

  area = 'Renders';
  // The runner's own figures, as it holds them; LW_RENDER_CONCURRENCY sets the first.
  const env = extra.env ?? process.env;
  const runner = extra.runner ?? null;
  const envConcurrency = (env.LW_RENDER_CONCURRENCY ?? '').trim();
  add('renders.concurrency', 'Durable renders at once', runner?.concurrency ?? RENDER_RUNNER_DEFAULTS.concurrency, 'count', 'Per Work process.',
    envConcurrency ? 'environment' : 'built-in');
  add('renders.attemptTimeoutMs', 'Time for one render attempt', runner?.timeoutMs ?? RENDER_RUNNER_DEFAULTS.timeoutMs, 'ms');
  add('renders.leaseMs', 'Durable render claim lease', runner?.leaseMs ?? RENDER_RUNNER_DEFAULTS.leaseMs, 'ms');
  add('renders.concurrencyMax', 'Maximum durable renders at once', MAX_RENDER_CONCURRENCY, 'count', 'Per Work process.');
  setting('render.worker.timeoutMs', 'Push worker call timeout', config.render?.worker?.timeoutMs, DEFAULTS.render.worker.timeoutMs, 'ms');
  setting('render.worker.connectRetryMs', 'Push worker connection retry window', config.render?.worker?.connectRetryMs, DEFAULTS.render.worker.connectRetryMs, 'ms');
  setting('render.worker.pull.leaseMs', 'Pull worker lease', config.render?.worker?.pull?.leaseMs, DEFAULTS.render.worker.pull.leaseMs, 'ms');
  setting('render.worker.pull.queueTimeoutMs', 'Pull worker queue timeout', config.render?.worker?.pull?.queueTimeoutMs, DEFAULTS.render.worker.pull.queueTimeoutMs, 'ms');
  add('renders.batchRows', 'Rows per render batch', RENDER_BATCH_MAX_ROWS, 'rows');
  add('renders.automationBatchRows', 'Rows per automation batch', BATCH_LIMITS.rows, 'rows');
  add('renders.automationBatchConcurrency', 'Concurrent automation batch rows', BATCH_LIMITS.concurrency, 'count');
  add('renders.automationBatchRetries', 'Retries per automation batch row', BATCH_LIMITS.retries, 'count');
  add('renders.archiveBytes', 'Render batch archive size', RENDER_ARCHIVE_MAX_BYTES, 'bytes');
  add('renders.leaseWaitMs', 'Worker lease polling wait', LEASE_MAX_WAIT_MS, 'ms');
  add('renders.leaseResultBodyBytes', 'Worker result body size', LEASE_RESULT_MAX_BYTES, 'bytes');
  add('renders.outputLinkSeconds', 'Render output link lifetime', OUTPUT_TOKEN_SECONDS, 'seconds');
  add('renders.projectFilesRead', 'Project files one render may read', RENDER_READ_FILE_LIMIT, 'count');
  add('renders.readTicketLength', 'Project file read ticket length', TICKET_MAX_LENGTH, 'count', 'Characters.');
  add('renders.mcpInlineBytes', 'Render output inline in an MCP result', INLINE_OUTPUT_BYTES, 'bytes', 'A larger one is a link.');
  add('renders.inspectBytes', 'Render output inspection size', INSPECT_MAX_BYTES, 'bytes', 'A larger output is recorded as not inspected.');
  add('renders.inspectSvgBytes', 'SVG output inspection size', INSPECT_MAX_SVG_BYTES, 'bytes');
  add('renders.inspectPixels', 'Render output inspection pixels', INSPECT_MAX_PIXELS, 'count', 'Pixels.');
  add('renders.productionPdfPixels', 'Production PDF page pixels', PRODUCTION_MAX_PIXELS, 'count', 'Pixels. A larger page is recorded as a limitation.');
  setting('renderApi.resultUrls.signedDays', 'Migration render result link lifetime', config.renderApi?.resultUrls?.signedDays,
    DEFAULTS.renderApi.resultUrls.signedDays, 'days', 'Zero means a result link needs the bearer token.');
  add('renders.migrationSyncMs', 'Migration render synchronous wait', SYNC_LIMIT_MS, 'ms');
  add('renders.migrationIncompleteMs', 'Migration render marked incomplete after', INCOMPLETE_AFTER_MS, 'ms');
  add('renders.urlRetryMs', 'Wait before a failed URL render is tried again', URL_RETRY_WINDOW_MS, 'ms');
  add('renders.urlQueryLength', 'URL render query length', MAX_URL_QUERY, 'count', 'Characters.');
  add('renders.urlGenerations', 'Earlier renders one URL request may step past', MAX_URL_GENERATIONS, 'count');
  add('renders.migrationWaiters', 'Migration renders waited on at once', MIGRATION_RENDER_WAITERS, 'count');
  add('renders.migrationMetadataLength', 'Migration render metadata length', MAX_METADATA_CHARS, 'count', 'Characters.');
  add('renders.migrationPassthroughLength', 'Migration render passthrough length', MAX_PASSTHROUGH_CHARS, 'count', 'Characters.');
  add('renders.mappingKeyLength', 'Migration mapping key length', MAPPING_MAX_NAME, 'count', 'Characters.');
  add('renders.mappingIgnored', 'Ignored fields in one migration mapping', MAPPING_MAX_IGNORED, 'count');
  add('renders.rasterEdgePixels', 'Longest raster edge', MAX_RASTER_EDGE_PX, 'count', 'Pixels.');

  area = 'Request bodies';
  add('bodies.jsonDefaultBytes', 'JSON body size where a route sets none', JSON_BODY_DEFAULT_BYTES, 'bytes');
  add('bodies.controlBytes', 'Short JSON body size', JSON_BODY_CONTROL_BYTES, 'bytes', 'Confirmations, choices, labels and secrets.');
  add('bodies.commentBytes', 'Comment body size', COMMENT_BODY_BYTES, 'bytes');
  add('bodies.smallBytes', 'Access request and purge secret body size', JSON_BODY_SMALL_BYTES, 'bytes');
  add('bodies.deliveryBytes', 'Delivery request body size', DELIVERY_BODY_BYTES, 'bytes');
  add('bodies.mediumBytes', 'Sharing, purge list and setup body size', JSON_BODY_MEDIUM_BYTES, 'bytes');
  add('bodies.listBytes', 'List body size', JSON_BODY_LIST_BYTES, 'bytes', 'People to add, an exit, upload and project file parts.');
  add('bodies.formBytes', 'Form body size', FORM_BODY_BYTES, 'bytes', 'Device activation and identity provider sign-out.');
  add('bodies.formLargeBytes', 'Back-channel sign-out body size', FORM_BODY_LARGE_BYTES, 'bytes');
  add('bodies.providerPublishBytes', 'Export published to a provider', PROVIDER_PUBLISH_BYTES, 'bytes');
  add('renders.compatBodyBytes', 'Migration render JSON body size', RENDER_API_BODY_BYTES, 'bytes', 'Bannerbear and Placid creation routes.');
  add('files.inlineBodyBytes', 'Inline file JSON body size', INLINE_BODY_BYTES, 'bytes', 'POST /api/v1/files.');
  add('bodies.intentsBytes', 'Intent resolver JSON body size', INTENTS_BODY_BYTES, 'bytes');
  add('bodies.orgMcpBytes', 'Automation MCP JSON body size', ORG_MCP_BODY_BYTES, 'bytes');
  add('bodies.brandMcpBytes', 'Brand page MCP JSON body size', BRAND_MCP_BODY_BYTES, 'bytes');

  area = 'Uploads and files';
  const uploads = uploadPolicy(config);
  setting('policy.uploads.enabled', 'Scoped uploads enabled', config.policy?.uploads?.enabled, UPLOAD_DEFAULTS.enabled);
  for (const [key, label] of Object.entries({ maxFileBytes: 'Upload file size', ownerBudgetBytes: 'Upload bytes per owner', instanceBudgetBytes: 'Upload bytes per instance' }) as [keyof Pick<typeof uploads, 'maxFileBytes' | 'ownerBudgetBytes' | 'instanceBudgetBytes'>, string][]) {
    setting(`policy.uploads.${key}`, label, config.policy?.uploads?.[key], UPLOAD_DEFAULTS[key], 'bytes');
  }
  for (const [key, label] of Object.entries({ uploadTtlHours: 'Unfinished upload lifetime', readyTtlHours: 'Finished upload lifetime', fileTtlHours: 'File reference lifetime' }) as [keyof Pick<typeof uploads, 'uploadTtlHours' | 'readyTtlHours' | 'fileTtlHours'>, string][]) {
    setting(`policy.uploads.${key}`, label, config.policy?.uploads?.[key] === undefined ? undefined : uploads[key] * 3600,
      UPLOAD_DEFAULTS[key] * 3600, 'seconds');
  }
  add('uploads.maxBytes', 'Maximum upload file size', TRANSFER_MAX_BYTES, 'bytes');
  add('uploads.partBytes', 'Upload part size', TRANSFER_PART_BYTES, 'bytes');
  add('uploads.pendingPerOwner', 'Unfinished uploads per owner', UPLOAD_PENDING_LIMIT, 'count');
  add('uploads.overheadBytes', 'Budget overhead per upload', UPLOAD_OVERHEAD_BYTES, 'bytes');
  add('uploads.idleMs', 'Unfinished upload idle timeout', UPLOAD_IDLE_MS, 'ms');
  add('uploads.sweepGraceMs', 'Expired upload purge delay', UPLOAD_SWEEP_GRACE_MS, 'ms');
  add('uploads.listRows', 'Uploads per list page', UPLOAD_LIST_LIMIT, 'rows');
  add('files.inlineBytes', 'Inline file size', FILE_INLINE_MAX_BYTES, 'bytes');
  add('files.reportBytes', 'File operation report size', FILE_REPORT_MAX_BYTES, 'bytes');
  add('files.listRows', 'File references per list page', FILE_LIST_LIMIT, 'rows');
  add('files.readBudgetMultiplier', 'Daily file read budget multiplier', READ_BUDGETS_PER_DAY, 'count', 'Multiplies the instance upload budget per owner.');
  setting('files.readBytesPerDay', 'File bytes read a day per owner', config.policy?.uploads?.instanceBudgetBytes === undefined ? undefined : READ_BUDGETS_PER_DAY * uploads.instanceBudgetBytes,
    READ_BUDGETS_PER_DAY * UPLOAD_DEFAULTS.instanceBudgetBytes, 'bytes');

  const projectFiles = config.policy?.projectFiles;
  setting('policy.projectFiles.enabled', 'Project files enabled', projectFiles?.enabled, PROJECT_FILE_DEFAULTS.enabled);
  for (const [key, label] of Object.entries({ maxFileBytes: 'Project file size', projectBudgetBytes: 'File bytes per project', instanceBudgetBytes: 'Project file bytes per instance' }) as [keyof Pick<typeof PROJECT_FILE_DEFAULTS, 'maxFileBytes' | 'projectBudgetBytes' | 'instanceBudgetBytes'>, string][]) {
    setting(`policy.projectFiles.${key}`, label, projectFiles?.[key], PROJECT_FILE_DEFAULTS[key], 'bytes');
  }
  setting('policy.projectFiles.uploadTtlHours', 'Unfinished project file lifetime', projectFiles?.uploadTtlHours === undefined ? undefined : projectFiles.uploadTtlHours * 3600,
    PROJECT_FILE_DEFAULTS.uploadTtlHours * 3600, 'seconds');
  add('projectFiles.maxBytes', 'Maximum project file size', PROJECT_FILE_MAX_BYTES, 'bytes');
  add('projectFiles.partBytes', 'Project file part size', PROJECT_FILE_PART_BYTES, 'bytes');
  add('projectFiles.pendingPerOwner', 'Unfinished project files per owner', PROJECT_FILE_PENDING_LIMIT, 'count');
  add('projectFiles.pendingBudgetMultiplier', 'Pending project file budget multiplier', PROJECT_FILE_PENDING_FILES, 'count', 'Multiplies the maximum file size per owner.');
  add('projectFiles.overheadBytes', 'Budget overhead per project file', PROJECT_FILE_OVERHEAD_BYTES, 'bytes');
  add('projectFiles.idleMs', 'Project file upload idle timeout', PROJECT_FILE_IDLE_MS, 'ms');
  add('projectFiles.sweepGraceMs', 'Expired project file purge delay', PROJECT_FILE_SWEEP_GRACE_MS, 'ms');
  add('projectFiles.downloadBudgetMultiplier', 'Daily project file download multiplier', DOWNLOAD_BUDGETS_PER_DAY, 'count',
    'Multiplies the instance project file budget per person.');

  area = 'Approvals and submissions';
  const artifacts = approvalArtifactPolicy(config);
  setting('policy.approvalArtifacts.enabled', 'Approval artifacts enabled', config.policy?.approvalArtifacts?.enabled, APPROVAL_ARTIFACT_DEFAULTS.enabled);
  setting('policy.approvalArtifacts.maxFileBytes', 'Approval artifact file size', config.policy?.approvalArtifacts?.maxFileBytes,
    artifacts.maxFileBytes, 'bytes');
  setting('policy.approvalArtifacts.instanceBudgetBytes', 'Approval artifact bytes per instance', config.policy?.approvalArtifacts?.instanceBudgetBytes,
    artifacts.instanceBudgetBytes, 'bytes');
  add('approvalArtifacts.maxFileBytes', 'Maximum approval artifact size', APPROVAL_ARTIFACT_MAX_FILE_BYTES, 'bytes');
  add('approvalArtifacts.recordMaxBytes', 'Approval credential recording size', APPROVAL_RECORD_MAX_BYTES, 'bytes');
  add('submissions.dataBytes', 'Data submission file size', MAX_DATA_SUBMISSION_BYTES, 'bytes');
  add('submissions.rulesBytes', 'Share with rules file size', MAX_RULES_FILE_BYTES, 'bytes');
  setting('policy.submit.maxBytes', 'Catalog submission file size', config.policy?.submit?.maxBytes, DEFAULTS.policy.submit.maxBytes, 'bytes');
  setting('policy.submit.quota.bytes', 'Catalog submission byte quota', config.policy?.submit?.quota?.bytes, DEFAULTS.policy.submit.quota.bytes, 'bytes', 'Zero means no cap.');
  setting('policy.submit.quota.count', 'Catalog submission count quota', config.policy?.submit?.quota?.count, DEFAULTS.policy.submit.quota.count, 'count', 'Zero means no cap.');

  area = 'Projects and versions';
  setting('policy.versions.maxBytes', 'Version bytes per instance', config.policy?.versions?.maxBytes, VERSION_INSTANCE_MAX_BYTES, 'bytes');
  add('versions.documentBytes', 'Version bytes per document', VERSION_SESSION_MAX_BYTES, 'bytes');
  add('versions.keptPerPerson', 'Kept versions per person per document', VERSION_NAMED_PER_PERSON, 'count');
  add('versions.keptPerDocument', 'Kept versions per document', VERSION_NAMED_PER_SESSION, 'count');
  add('versions.restoresKept', 'Restores kept per document', VERSION_RESTORE_KEEP, 'count');
  add('versions.recentKept', 'Automatic versions kept per document', VERSION_RECENT_KEEP, 'count', 'Automatic, close and save versions, newest first.');
  add('versions.dailyDays', 'Days with one daily version kept', VERSION_DAILY_DAYS, 'days');
  add('versions.maxAgeDays', 'Oldest version kept', VERSION_MAX_AGE_DAYS, 'days');
  add('versions.labelLength', 'Version name length', VERSION_LABEL_MAX, 'count', 'Characters.');
  add('versions.listRows', 'Versions per list page', VERSION_LIST_MAX, 'rows');
  add('versions.changesPerMinute', 'Version changes a minute per person', VERSION_CHANGES_PER_MINUTE, 'per-minute', 'Saves, name and pin changes and restores together.');
  add('versions.changesPerHour', 'Version changes an hour per person', VERSION_CHANGES_PER_HOUR, 'count', 'Saves, name and pin changes and restores together.');
  add('documents.revisionsKept', 'Document revisions kept', SESSION_REVISION_LIMIT, 'count');
  add('projects.accessReportRows', 'Rows in a project access report', ACCESS_REPORT_ROWS, 'rows');
  const transferLabels = { sessions: 'documents', files: 'files', folders: 'folders', members: 'members' } as const;
  for (const key of Object.keys(transferLabels) as (keyof typeof transferLabels)[]) {
    add(`projects.transferInventory.${key}`, `Project transfer inventory ${transferLabels[key]}`, TRANSFER_INVENTORY_LIMITS[key], 'count');
    add(`projects.transferMetadata.${key}`, `Metadata-only project transfer ${transferLabels[key]}`, PROJECT_TRANSFER_METADATA_MAX_LIMITS[key], 'count');
  }

  area = 'Comments and notices';
  add('comments.writesPerMinute', 'Comment writes a minute per person', COMMENT_WRITES_PER_MINUTE, 'per-minute', 'Every create and every command counts.');
  add('comments.writesPerHour', 'Comment writes an hour per person', COMMENT_WRITES_PER_HOUR, 'count', 'Every create and every command counts.');
  add('comments.readsPerMinute', 'Comment reads a minute per person', COMMENT_READS_PER_MINUTE, 'per-minute');
  add('comments.peoplePerMinute', 'People lookups a minute per person', COMMENT_PEOPLE_PER_MINUTE, 'per-minute');
  add('comments.readStateThreads', 'Threads in one read-state call', COMMENT_READS_MAX_IDS, 'count');
  add('notices.fanout', 'People one message may notify', NOTICE_FANOUT_LIMIT, 'count');
  add('notices.perWriter', 'Notices one writer may cause', ACTOR_NOTICE_LIMIT, 'count', 'In the window below.');
  add('notices.writerWindowMs', 'Notice window per writer', ACTOR_NOTICE_WINDOW_MS, 'ms');
  add('notices.keptPerPerson', 'Notices kept per person', NOTICE_KEEP, 'count');
  add('notices.maxAgeMs', 'Oldest notice kept', NOTICE_MAX_AGE_MS, 'ms');
  add('notices.countMax', 'Highest count on one notice', COMMENT_NOTICE_COUNT_MAX, 'count');
  add('comments.mentionNameLength', 'Mention name length', MAX_MENTION_NAME, 'count', 'Characters.');
  add('inbox.titleLength', 'Inbox message title length', INBOX_TITLE_CHARS, 'count', 'Characters.');
  add('inbox.commentTitleLength', 'Comment notice title length', COMMENT_NOTICE_TITLE_CHARS, 'count', 'Characters.');
  add('inbox.commentExcerptLength', 'Comment excerpt shown in the inbox', NOTICE_EXCERPT_CHARS, 'count', 'Characters.');

  area = 'Live collaboration';
  add('collab.sockets', 'Live connections per process', MAX_SOCKETS, 'count');
  add('collab.socketsPerPerson', 'Live connections per person', MAX_SOCKETS_PER_USER, 'count');
  add('collab.connectsPerMinute', 'New connections a minute per person', CONNECTS_PER_USER_PER_MIN, 'per-minute');
  add('collab.editorsPerDocument', 'Editors in one document at once', WRITER_CAP, 'count', 'The next one joins view only.');
  add('collab.editorSeatsPerPerson', 'Editor seats one person may hold in a document', WRITER_CAP_PER_USER, 'count');
  add('collab.opsPerSecond', 'Edits a second per connection', OPS_PER_SEC, 'per-second');
  add('collab.opMessagesPerSecond', 'Edit messages a second per connection', OPS_MESSAGES_PER_SEC, 'per-second');
  add('collab.opsPerMessage', 'Edits in one message', MAX_OPS_PER_MESSAGE, 'count');
  add('collab.presencePerSecond', 'Presence updates a second per connection', PRESENCE_FRAMES_PER_SEC, 'per-second');
  add('collab.messageBytes', 'Live message size', COLLAB_MESSAGE_BYTES, 'bytes');
  add('collab.bufferedBytes', 'Unsent bytes held per connection', MAX_BUFFERED_BYTES, 'bytes');
  add('collab.queuedMessages', 'Messages queued per connection', MAX_QUEUED_MESSAGES, 'count');
  add('collab.scalarLength', 'Text in one live input', MAX_SCALAR_CHARS, 'count', 'Characters.');
  add('collab.rowFields', 'Fields in one box', MAX_ROW_FIELDS, 'count');
  add('collab.chatLength', 'Cursor chat length', MAX_CHAT_CHARS, 'count', 'Characters.');
  add('collab.trackedClients', 'Clients tracked per live document', MAX_TRACKED_CLIENTS, 'count');
  add('collab.guestNameLength', 'Guest name length', MAX_GUEST_NAME_CHARS, 'count', 'Characters.');
  add('collab.designSystemNameLength', 'Design system name read from a connection', MAX_DESIGN_SYSTEM_CHARS, 'count', 'Characters.');
  add('collab.ticketsHeld', 'Connection tickets held at once', MAX_TICKETS, 'count');
  add('collab.inputsPerDocument', 'Inputs in one live document', MAX_PARAMS_PER_ROOM, 'count');
  add('collab.groupsPerDocument', 'Repeating groups in one live document', MAX_COLLECTIONS_PER_ROOM, 'count');
  add('collab.boxesPerGroup', 'Boxes in one repeating group', MAX_BOXES_PER_COLLECTION, 'count', 'Removed boxes count too.');
  add('collab.joinTimeoutMs', 'Time to join after connecting', JOIN_TIMEOUT_MS, 'ms');
  add('collab.ticketMs', 'Connection ticket lifetime', SOCKET_TICKET_TTL_MS, 'ms');
  add('collab.nearbyMs', 'Nearby listing lifetime', NEARBY_TTL_MS, 'ms');

  area = 'Access requests and sharing';
  setting('policy.requests.ttlDays', 'Access request lifetime', config.policy?.requests?.ttlDays, DEFAULTS.policy.requests.ttlDays, 'days');
  setting('policy.requests.joinOpenMax', 'Open join and switch requests per workspace', config.policy?.requests?.joinOpenMax, DEFAULTS.policy.requests.joinOpenMax, 'count');
  add('requests.asksPerDay', 'Access asks a day per person', ASKS_PER_DAY, 'count', 'Project and session links together.');
  add('requests.joinPerAddress', 'Join requests per address', JOIN_PER_EMAIL, 'count', 'In the window below.');
  add('requests.joinWindowDays', 'Join request window', JOIN_WINDOW_DAYS, 'days');
  add('requests.switchPerInvitation', 'Switch requests a day per invitation', SWITCH_PER_INVITATION_PER_DAY, 'count');
  add('requests.approversTold', 'People told about one request', APPROVERS_MAX, 'count');
  add('requests.nameLength', 'Requester name length', REQUEST_NAME_MAX, 'count', 'Characters.');
  add('requests.noteLength', 'Request note length', REQUEST_NOTE_MAX, 'count', 'Characters.');
  add('requests.inboxDays', 'Answers kept in the inbox', INBOX_NOTICE_DAYS, 'days');
  add('sharing.grantsPerChange', 'People and groups in one sharing change', SHARE_GRANT_LIMIT, 'count');
  add('sharing.groupsPerPerson', 'Share groups per person', SHARE_GROUPS_PER_OWNER, 'count');
  add('sharing.groupMembers', 'People in one share group', SHARE_GROUP_MEMBER_LIMIT, 'count');
  add('sharing.groupNameLength', 'Share group name length', SHARE_GROUP_NAME_MAX, 'count', 'Characters.');
  add('sharing.groupDescriptionLength', 'Share group description length', SHARE_GROUP_DESCRIPTION_MAX, 'count', 'Characters.');
  add('sharing.peoplePerMinute', 'People lookups a minute when sharing', SHARE_PEOPLE_PER_MINUTE, 'per-minute');
  add('sharing.peoplePerAnswer', 'People in one lookup answer', PEOPLE_LIMIT, 'count');
  add('sharing.projectNameLength', 'Project name in a sharing message', MAX_PROJECT_NAME_CHARS, 'count', 'Characters.');
  add('sharing.titleLength', 'Sharing message title length', SHARING_TITLE_CHARS, 'count', 'Characters.');

  area = 'Retention and purge';
  const retentionLabels = { auditDays: 'Audit retention', renderOutputDays: 'Render output retention', deletedDocumentsDays: 'Deleted document retention', telemetryDays: 'Telemetry retention' } as const;
  for (const key of Object.keys(retentionLabels) as (keyof typeof retentionLabels)[]) {
    setting(`policy.retention.${key}`, retentionLabels[key], config.policy?.retention?.[key], DEFAULTS.policy.retention[key], 'days', 'Zero keeps everything.');
    add(`policy.retention.${key}.default`, `Default ${retentionLabels[key].toLowerCase()}`, DEFAULTS.policy.retention[key], 'days');
  }
  for (const [key, label] of Object.entries({ closedRetentionDays: 'Rejected approval file retention', approvedRetentionDays: 'Approved approval file retention' }) as [keyof Pick<typeof artifacts, 'closedRetentionDays' | 'approvedRetentionDays'>, string][]) {
    setting(`policy.approvalArtifacts.${key}`, label, config.policy?.approvalArtifacts?.[key], APPROVAL_ARTIFACT_DEFAULTS[key], 'days', 'Zero keeps the file.');
  }
  setting('policy.catalog.versionKeep', 'Catalog versions kept', config.policy?.catalog?.versionKeep, DEFAULTS.policy.catalog.versionKeep, 'count', 'Zero keeps every version.');
  add('retention.renderPurgeGraceMs', 'Expired render output purge delay', PURGE_GRACE_MS, 'ms');
  add('audit.retireReasonLength', 'Audit retirement reason length', RETIRE_REASON_MAX, 'count', 'Characters.');

  area = 'Links';
  const linkLabels = { share: 'Share link lifetime', embed: 'Embed link lifetime', download: 'Download link lifetime', 'guest-edit': 'Guest link built-in lifetime', 'project-invite': 'Project invite link lifetime' } as const;
  for (const kind of Object.keys(linkLabels) as (keyof typeof linkLabels)[]) {
    add(`links.${kind}.defaultSeconds`, linkLabels[kind], DEFAULT_TTL_SEC[kind], 'seconds');
  }
  setting('policy.guestLinks.enabled', 'Guest links enabled', config.policy?.guestLinks?.enabled, DEFAULTS.policy.guestLinks.enabled);
  setting('policy.guestLinks.defaultTtlHours', 'Guest link lifetime', config.policy?.guestLinks?.defaultTtlHours === undefined ? undefined : config.policy.guestLinks.defaultTtlHours * 3600,
    DEFAULTS.policy.guestLinks.defaultTtlHours * 3600, 'seconds');
  setting('policy.guestLinks.maxTtlHours', 'Maximum guest link lifetime', config.policy?.guestLinks?.maxTtlHours === undefined ? undefined : config.policy.guestLinks.maxTtlHours * 3600,
    DEFAULTS.policy.guestLinks.maxTtlHours * 3600, 'seconds', 'Also applies to links issued by contractors.');
  const invites = resolveInvitePolicy(config.policy?.invites);
  setting('policy.invites.maxTtlHours', 'Project invitation lifetime', config.policy?.invites?.maxTtlHours === undefined ? undefined : invites.maxTtlHours * 3600,
    invites.maxTtlHours * 3600, 'seconds');
  add('links.inviteMaxSeconds', 'Maximum project invitation lifetime', MAX_INVITE_TTL_HOURS * 3600, 'seconds');
  const sharing = resolveSharingPolicy(config.policy?.sharing);
  setting('policy.sharing.maxGrantDays', 'Maximum sharing grant lifetime', config.policy?.sharing?.maxGrantDays, sharing.maxGrantDays, 'days', 'Null means no cap.');
  add('links.grantMaxDays', 'Maximum configured sharing lifetime', MAX_GRANT_DAYS, 'days');
  add('links.maxSeconds', 'Maximum link lifetime', LINK_MAX_TTL_HOURS * 3600, 'seconds', 'Every link but a guest link.');
  add('links.passwordCookieSeconds', 'Link password remembered for', LINK_ACCESS_MAX_SEC, 'seconds', 'Never past the link’s own expiry.');

  area = 'Catalog and rights';
  setting('delivery.maxBytes', 'Delivery file size', config.delivery?.maxBytes, DEFAULTS.delivery.maxBytes, 'bytes', 'A destination may set a lower one.');
  add('catalog.snapshotBytes', 'Catalog delivery snapshot size', MAX_SNAPSHOT_BYTES, 'bytes');
  add('catalog.snapshotKeptMs', 'Catalog delivery snapshot kept for', SNAPSHOT_RETAIN_MS, 'ms');
  add('catalog.packBytes', 'Instance pack size', PACK_MAX_BYTES, 'bytes');
  add('catalog.browseRows', 'Assets per browse page', BROWSE_MAX_LIMIT, 'rows');
  add('catalog.previewInputBytes', 'File preview input size', PREVIEW_INPUT_LIMIT, 'bytes');
  add('catalog.hiddenTags', 'Hidden tags', MAX_HIDDEN_PATTERNS, 'count');
  add('catalog.hiddenTagLength', 'Hidden tag length', MAX_PATTERN_LENGTH, 'count', 'Characters.');
  add('catalog.browseFilterLength', 'Browse filter length', BROWSE_MAX_PARAM, 'count', 'Characters.');
  add('catalog.browseCursorLength', 'Browse cursor length', BROWSE_MAX_CURSOR, 'count', 'Characters.');
  add('catalog.extractedText', 'Text extracted from one asset', MAX_EXTRACTED_TEXT, 'count', 'Characters.');
  add('catalog.collectionMembers', 'Assets in one collection', COLLECTION_MAX_MEMBERS, 'count');
  add('catalog.rulesFileEntries', 'Entries in one rules file', RULES_FILE_ENTRIES, 'count');
  add('catalog.rightsScanValues', 'Values a licence gate check reads', ASSET_SCAN_MAX_NODES, 'count', 'Past this, the values are refused.');
  add('catalog.rightsScanDepth', 'Nesting a licence gate check reads', ASSET_SCAN_MAX_DEPTH, 'count', 'Past this, the values are refused.');
  add('catalog.licenceDeclarationLength', 'Licence declaration length', LICENCE_DECLARATION_MAX, 'count', 'Characters.');
  add('catalog.licenceAttributionLength', 'Licence attribution length', LICENCE_ATTRIBUTION_MAX, 'count', 'Characters.');
  add('catalog.markHolderLength', 'Mark holder length', MARK_HOLDER_MAX, 'count', 'Characters.');
  add('catalog.markTermsLength', 'Mark terms length', MARK_TERMS_MAX, 'count', 'Characters.');
  add('catalog.rightsNoteLength', 'Rights note length', RIGHTS_NOTE_MAX, 'count', 'Characters.');
  add('catalog.proofFileBytes', 'Media proof file size', PROOF_FILE_BYTES, 'bytes');
  add('catalog.proofTotalBytes', 'Media proofs per bundle', PROOF_TOTAL_BYTES, 'bytes');

  area = 'Providers';
  setting('catalogServing.maxProviderAssets', 'Assets read per provider', config.catalogServing?.maxProviderAssets, DEFAULTS.catalogServing.maxProviderAssets, 'count');
  setting('network.providers.maxBytes', 'Provider answer size', config.network?.providers?.maxBytes, DEFAULTS.network.providers.maxBytes, 'bytes');
  add('catalog.penpotFiles', 'Penpot files read per sync', PENPOT_FILE_CAP, 'count');
  add('catalog.webdavFolders', 'WebDAV folders read per sync', WEBDAV_MAX_DIRS, 'count');
  add('providers.oauthWaitMs', 'Provider sign-in wait', PROVIDER_OAUTH_LIMITS.ttlMs, 'ms');
  add('providers.oauthTimeoutMs', 'Provider sign-in call timeout', PROVIDER_OAUTH_LIMITS.timeoutMs, 'ms');
  add('providers.oauthAnswerBytes', 'Provider sign-in answer size', PROVIDER_OAUTH_LIMITS.responseBytes, 'bytes');
  add('providers.previewPages', 'Provider setup preview pages', SETUP_PREVIEW_LIMITS.pages, 'count');
  add('providers.previewAssets', 'Provider setup preview assets', SETUP_PREVIEW_LIMITS.assets, 'count');
  add('providers.previewListingBytes', 'Provider setup preview listing size', SETUP_PREVIEW_LIMITS.listingBytes, 'bytes');
  add('providers.previewOriginalBytes', 'Provider setup preview file size', SETUP_PREVIEW_LIMITS.originalBytes, 'bytes');
  add('providers.previewTimeoutMs', 'Provider setup preview timeout', SETUP_PREVIEW_LIMITS.timeoutMs, 'ms');

  area = 'Brand edits and tool policies';
  add('brand.editBytes', 'Brand edit document size', BRAND_EDIT_MAX_BYTES, 'bytes');
  add('brand.editRevisionsListed', 'Brand edit revisions listed', BRAND_EDIT_HISTORY, 'rows');
  add('brand.editRevisionsKept', 'Brand edit revisions kept in full', BRAND_EDIT_KEEP, 'count', 'Older ones stay in the history with their digests.');
  add('brand.editNesting', 'Brand edit document nesting', BRAND_EDIT_MAX_DEPTH, 'count');
  add('brand.editValues', 'Values in one brand edit document', BRAND_EDIT_MAX_NODES, 'count');
  add('brand.editChanges', 'Changes in one brand edit', BRAND_EDIT_MAX_CHANGES, 'count');
  add('brand.editTextLength', 'Brand edit description length', BRAND_EDIT_MAX_TEXT, 'count', 'Characters.');
  add('brand.colourRoles', 'Colour roles in one design system', BRAND_EDIT_MAX_ROLES, 'count');
  add('brand.colourRoleLabel', 'Colour role label length', BRAND_EDIT_MAX_ROLE_LABEL, 'count', 'Characters.');
  add('brand.colourRoleDescription', 'Colour role description length', BRAND_EDIT_MAX_ROLE_DESCRIPTION, 'count', 'Characters.');
  add('policy.toolPolicyNameLength', 'Tool policy name length', POLICY_NAME_MAX, 'count', 'Characters.');
  add('policy.toolPolicyReasonLength', 'Tool policy reason length', POLICY_REASON_MAX, 'count', 'Characters.');

  area = 'Brand pages';
  setting('brandPages.maxBundleBytes', 'Brand page bundle size', config.brandPages?.maxBundleBytes, DEFAULTS.brandPages.maxBundleBytes, 'bytes');
  setting('brandPages.maxFileBytes', 'Brand page file size', config.brandPages?.maxFileBytes, DEFAULTS.brandPages.maxFileBytes, 'bytes');
  setting('brandPages.instanceBudgetBytes', 'Brand page bytes per instance', config.brandPages?.instanceBudgetBytes, DEFAULTS.brandPages.instanceBudgetBytes, 'bytes');
  setting('brandPages.keepRevisions', 'Brand page revisions kept', config.brandPages?.keepRevisions, DEFAULTS.brandPages.keepRevisions, 'count');
  add('brandPages.manifestBytes', 'Brand page manifest size', MAX_MANIFEST_BYTES, 'bytes');
  add('brandPages.bundleEntries', 'Entries in one brand page bundle', BRAND_PAGE_ENTRIES, 'count');
  add('brandPages.mcpInlineBytes', 'File inline in a brand page MCP result', BRAND_MCP_INLINE_BYTES, 'bytes', 'A larger one is its public address.');
  add('brandPages.indexRows', 'Brand pages listed', BRAND_PAGE_INDEX, 'rows');
  add('brandPages.historyRows', 'Brand page revisions listed', BRAND_PAGE_HISTORY, 'rows');
  add('brandPages.stagedGraceMs', 'Unpublished brand page upload kept for', STAGED_GRACE_MS, 'ms');

  area = 'Partner programmes';
  add('programmes.exitRowBound', 'Rows per account in one exit', EXIT_ROW_BOUND, 'rows');
  add('programmes.exitListMax', 'Accounts per exit list', EXIT_LIST_MAX, 'rows');
  add('programmes.reopenDays', 'Reopen window after an end', REOPEN_DAYS, 'days');
  NOTICE_DAYS_BEFORE.forEach((days, index) => add(`programmes.noticeDaysBefore.${index}`, `End notice ${index + 1} lead time`, days, 'days'));
  add('programmes.sweepMs', 'Programme sweep interval', PROGRAMME_SWEEP_MS, 'ms');
  add('programmes.logoTypes', 'Company logo file types', LOGO_TYPES.join(', '), 'mode');
  add('programmes.logoSvgBytes', 'Company SVG logo size', SVG_MAX_BYTES, 'bytes');
  add('programmes.logoPngBytes', 'Company PNG logo size', PNG_MAX_BYTES, 'bytes');
  add('programmes.logoPngMinLongSide', 'Company PNG minimum long side', PNG_MIN_LONG_SIDE, 'count', 'Pixels.');
  const profileLabels: Record<keyof typeof PROFILE_LIMITS, string> = {
    name: 'Company name length', website: 'Company website length', contactName: 'Company contact name length',
    email: 'Company contact email length', phone: 'Company contact phone length', address: 'Company address length',
    addressLines: 'Company address lines', taxNote: 'Company tax note length',
  };
  for (const key of Object.keys(PROFILE_LIMITS) as (keyof typeof PROFILE_LIMITS)[]) {
    add(`programmes.profile.${key}`, profileLabels[key], PROFILE_LIMITS[key], 'count', key === 'addressLines' ? 'Lines.' : 'Characters.');
  }
  add('programmes.profile.maxEditors', 'Company profile editors', MAX_EDITORS, 'count');
  add('programmes.profile.currency', 'Company currency code length', CURRENCY_CODE_LENGTH, 'count', 'Characters. An ISO 4217 code.');
  add('programmes.logoMinContrast', 'Company logo contrast warning', LOGO_MIN_CONTRAST, 'count', 'A ratio. Below it, the check warns.');
  add('programmes.usageMaxDays', 'Usage report window', USAGE_MAX_DAYS, 'days');
  add('programmes.usageAuditRows', 'Audit rows read per token for usage', USAGE_AUDIT_ROWS, 'rows');
  add('programmes.heldFilesListed', 'Held files listed per source', RIGHTS_LIMITS.heldFilesListedPerSource, 'count');
  add('programmes.partnerLinksListed', 'Partner links listed', RIGHTS_LIMITS.linksListed, 'count');
  add('programmes.choicesPerRequest', 'Held files chosen in one request', CHOICES_PER_REQUEST, 'count');
  add('programmes.choiceNoteLength', 'Choice note length', CHOICE_NOTE_MAX, 'count', 'Characters.');
  // The gate the server applies now: the configured mode when one is set, else the
  // instance's own recorded decision.
  const configuredGate = config.policy?.catalog?.partnerRights;
  add('programmes.partnerRightsMode', 'Partner licence gate', configuredGate ?? extra.partnerRightsMode ?? null, 'mode',
    configuredGate ? undefined : 'The instance’s own recorded decision; configuration can set it.', configuredGate ? 'configuration' : 'built-in');

  area = 'Storage, audit and connections';
  add('storage.postgresBlobBytes', 'Largest file kept in Postgres storage', POSTGRES_BLOB_MAX_BYTES, 'bytes');
  add('storage.databaseConnectMs', 'Database connection timeout', PG_CONNECT_TIMEOUT_MS, 'ms');
  add('storage.databaseIdleMs', 'Idle database connection closed after', PG_IDLE_TIMEOUT_MS, 'ms');
  add('storage.migrationLockWait', 'Migration lock wait', MIGRATION_LOCK_TIMEOUT);
  add('storage.migrationStatementTimeout', 'Migration statement timeout', MIGRATION_STATEMENT_TIMEOUT);
  add('connections.mailTimeoutMs', 'Mail server timeout', SMTP_TIMEOUT_MS, 'ms');
  add('connections.flagAnswerBytes', 'Feature flag answer size', FLAG_ANSWER_BYTES, 'bytes');
  add('policy.flagGroupRules', 'Group rules per feature flag', MAX_FLAG_GROUP_RULES, 'count');
  add('connections.edgePurgeItems', 'Items in one edge purge', EDGE_PURGE_ITEMS, 'count');
  add('telemetry.labelLength', 'Telemetry label length', TELEMETRY_LABEL_CHARS, 'count', 'Characters.');
  add('audit.detailNesting', 'Audit detail nesting kept', AUDIT_MAX_DEPTH, 'count', 'Deeper values are omitted.');
  add('audit.detailValues', 'Audit detail values kept', AUDIT_MAX_NODES, 'count');
  add('audit.detailEntries', 'Audit detail entries kept per list or object', AUDIT_MAX_ENTRIES, 'count');
  add('audit.detailTextLength', 'Audit detail text length', AUDIT_MAX_STRING, 'count', 'Characters.');

  return limits;
}

// Not listed, because none is a limit a person or a deployment meets:
// - timer cadences: the collaboration ping and room sweep, project file and domain
//   rechecks, automatic version timing, audit head log and SIEM intervals, retry
//   and backoff steps;
// - grace periods before internal cleanup (an empty room, a replaced brand view);
// - clock-skew tolerances: worker lease and push timestamps, OIDC issued-at, OAuth
//   expiry slack;
// - provider field-name lists and provider paging and pacing (page sizes, request gaps);
// - internal caches and memos: the render cache, file validators, restore replays,
//   OIDC discovery and keys, catalog signing envelopes, provider caches, brand edit
//   views, feature flag answers;
// - storage and file format facts: S3 part sizes and counts, the S3 metadata record,
//   zip header sizes;
// - internal guards and scan bounds: the render scale bound, provider shape detection,
//   the dry-run scan of an exit, repeat-scan pages, report sample sizes;
// - default list windows and page sizes, where a larger one may be asked for;
// - unit constants (a day in milliseconds, the longest timer);
// - the bounds a configuration file is checked against when Work starts.
// A separate contractor link cap does not exist: contractors use the guest link policy.
