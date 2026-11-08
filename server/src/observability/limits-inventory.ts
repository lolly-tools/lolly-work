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
import { MAX_BODY_BYTES as RENDER_API_BODY_BYTES } from '../render-api/routes.ts';
import { MAX_BODY_BYTES as INTENTS_BODY_BYTES } from '../automation/intents.ts';
import { MAX_MESSAGE_BYTES as ORG_MCP_BODY_BYTES } from '../automation/org-mcp.ts';
import { MAX_MESSAGE_BYTES as BRAND_MCP_BODY_BYTES } from '../brand-pages/mcp.ts';
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
import { DEFAULT_TTL_SEC } from '../links/sign.ts';
import { MAX_INVITE_TTL_HOURS, resolveInvitePolicy } from '../policy/invites.ts';
import { MAX_GRANT_DAYS, resolveSharingPolicy } from '../policy/sharing.ts';
import { EXIT_LIST_MAX, EXIT_ROW_BOUND } from '../programmes/exit.ts';
import { REOPEN_DAYS } from '../programmes/reopen.ts';
import { NOTICE_DAYS_BEFORE, PROGRAMME_SWEEP_MS } from '../programmes/exit-schedule.ts';
import { LIMITS as PROFILE_LIMITS, MAX_EDITORS } from '../programmes/profile.ts';
import { LOGO_TYPES, PNG_MAX_BYTES, PNG_MIN_LONG_SIDE, SVG_MAX_BYTES } from '../programmes/logo-checks.ts';

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
  add('renders.compatBodyBytes', 'Migration render JSON body size', RENDER_API_BODY_BYTES, 'bytes', 'Bannerbear and Placid creation routes.');

  area = 'Uploads and bodies';
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
  add('files.inlineBodyBytes', 'Inline file JSON body size', INLINE_BODY_BYTES, 'bytes', 'POST /api/v1/files.');

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

  const artifacts = approvalArtifactPolicy(config);
  setting('policy.approvalArtifacts.enabled', 'Approval artifacts enabled', config.policy?.approvalArtifacts?.enabled, APPROVAL_ARTIFACT_DEFAULTS.enabled);
  setting('policy.approvalArtifacts.maxFileBytes', 'Approval artifact file size', config.policy?.approvalArtifacts?.maxFileBytes,
    artifacts.maxFileBytes, 'bytes');
  setting('policy.approvalArtifacts.instanceBudgetBytes', 'Approval artifact bytes per instance', config.policy?.approvalArtifacts?.instanceBudgetBytes,
    artifacts.instanceBudgetBytes, 'bytes');
  add('approvalArtifacts.maxFileBytes', 'Maximum approval artifact size', APPROVAL_ARTIFACT_MAX_FILE_BYTES, 'bytes');
  add('approvalArtifacts.recordMaxBytes', 'Approval credential recording size', APPROVAL_RECORD_MAX_BYTES, 'bytes');
  add('bodies.intentsBytes', 'Intent resolver JSON body size', INTENTS_BODY_BYTES, 'bytes');
  add('bodies.orgMcpBytes', 'Automation MCP JSON body size', ORG_MCP_BODY_BYTES, 'bytes');
  add('bodies.brandMcpBytes', 'Brand page MCP JSON body size', BRAND_MCP_BODY_BYTES, 'bytes');
  add('submissions.dataBytes', 'Data submission file size', MAX_DATA_SUBMISSION_BYTES, 'bytes');
  add('submissions.rulesBytes', 'Share with rules file size', MAX_RULES_FILE_BYTES, 'bytes');
  setting('policy.submit.maxBytes', 'Catalog submission file size', config.policy?.submit?.maxBytes, DEFAULTS.policy.submit.maxBytes, 'bytes');
  setting('policy.submit.quota.bytes', 'Catalog submission byte quota', config.policy?.submit?.quota?.bytes, DEFAULTS.policy.submit.quota.bytes, 'bytes', 'Zero means no cap.');
  setting('policy.submit.quota.count', 'Catalog submission count quota', config.policy?.submit?.quota?.count, DEFAULTS.policy.submit.quota.count, 'count', 'Zero means no cap.');

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
  // The gate the server applies now: the configured mode when one is set, else the
  // instance's own recorded decision.
  const configuredGate = config.policy?.catalog?.partnerRights;
  add('programmes.partnerRightsMode', 'Partner licence gate', configuredGate ?? extra.partnerRightsMode ?? null, 'mode',
    configuredGate ? undefined : 'The instance’s own recorded decision; configuration can set it.', configuredGate ? 'configuration' : 'built-in');

  return limits;
}

// Not listed: a separate contractor link cap (contractors use the guest link policy),
// and limits still written inline where they are enforced (some request sizes and JSON
// caps, the share link maximum and the currency length). Each needs its own constant
// before it can be shown here without a second copy of its value.
