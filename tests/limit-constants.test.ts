// SPDX-License-Identifier: MPL-2.0
/**
 * Limits that were written inline where they are enforced are now named constants, so
 * the Limits and quotas panel reads them (plans/82 M7). This pins each one to the value
 * it held inline, so naming one changed nothing, guards the routes against a numeric
 * body cap coming back, and checks that the panel shows each one at that value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import * as bodies from '../server/src/api/body-limits.ts';
import { readJson, readRaw } from '../server/src/api/router.ts';
import { LINK_ACCESS_MAX_SEC, LINK_MAX_TTL_HOURS } from '../server/src/links/sign.ts';
import { CURRENCY_CODE_LENGTH, readProfileBody } from '../server/src/programmes/profile.ts';
import { SCIM_TOKEN_DEFAULT_DAYS, SCIM_TOKEN_MAX_DAYS } from '../server/src/scim/tokens.ts';
import { OUTPUT_TOKEN_SECONDS } from '../server/src/renders/output-token.ts';
import { PEOPLE_LIMIT } from '../server/src/access/share-routes.ts';
import { ROWS_MAX } from '../server/src/projects/effective-access.ts';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../server/src/catalog/resource-proofs.ts';
import { DOWNLOAD_BUDGETS_PER_DAY } from '../server/src/projects/file-routes.ts';
import { MAX_PATTERN_LENGTH } from '../server/src/catalog/tag-rules.ts';
import { MAX_SNAPSHOT_BYTES, RETAIN_MS } from '../server/src/catalog/delivery.ts';
import { FILE_CAP } from '../server/src/catalog/providers/penpot.ts';
import { HISTORY_LIMIT as BRAND_EDIT_HISTORY } from '../server/src/brand/edit-routes.ts';
import { TICKET_MAX_LENGTH } from '../server/src/render/read-ticket.ts';
import { PRODUCTION_MAX_PIXELS } from '../server/src/render/production-limits.ts';
import { AGENT_LIMIT, EVENT_LIMIT } from '../server/src/agents/dashboard.ts';
import { MAX_BYTES, MAX_PIXELS, MAX_SVG_BYTES } from '../server/src/render/output-inspection.ts';
import { MAX_PENDING, PER_IP_STARTS, PER_IP_WINDOW_MS } from '../server/src/iam/device-auth.ts';
import { HISTORY_LIMIT as BRAND_PAGE_HISTORY, INDEX_LIMIT, STAGED_GRACE_MS } from '../server/src/brand-pages/routes.ts';
import { SCRYPT_MAX_WAITERS } from '../server/src/lib/crypto.ts';
import { MAX_BODY_BYTES as FLAG_ANSWER_BYTES } from '../server/src/policy/ofrep.ts';
import { NAME_MAX, REASON_MAX } from '../server/src/policy/overlay.ts';
import { MIGRATION_LOCK_TIMEOUT as LOCK_TIMEOUT, MIGRATION_STATEMENT_TIMEOUT as STATEMENT_TIMEOUT } from '../server/src/store/limits.ts';
import { INCOMPLETE_AFTER_MS, SYNC_LIMIT_MS, URL_RETRY_WINDOW_MS } from '../server/src/render-api/routes.ts';
import { TIMEOUT_MS as SMTP_TIMEOUT_MS } from '../server/src/notify/smtp.ts';
import { RENDER_RUNNER_DEFAULTS } from '../server/src/renders/runner.ts';
import { CREDENTIAL_MIN_DAYS } from '../server/src/iam/credential-expiry.ts';
import { MAX_TITLE_CHARS as INBOX_TITLE } from '../server/src/access/messages.ts';
import { MAX_DEPTH as AUDIT_DEPTH, MAX_ENTRIES as AUDIT_ENTRIES, MAX_NODES as AUDIT_NODES, MAX_STRING as AUDIT_STRING } from '../server/src/audit/privacy.ts';
import { MAX_ENTRIES as BUNDLE_ENTRIES } from '../server/src/brand-pages/bundle.ts';
import {
  MAX_CHANGES as EDIT_CHANGES, MAX_DEPTH as EDIT_DEPTH, MAX_NODES as EDIT_NODES, MAX_ROLE_DESCRIPTION, MAX_ROLE_LABEL, MAX_ROLES, MAX_TEXT,
} from '../server/src/brand/edit-document.ts';
import { KEEP_DOCUMENTS } from '../server/src/brand/edit-routes.ts';
import { MAX_CURSOR, MAX_PARAM } from '../server/src/catalog/asset-browse.ts';
import { MAX_ENTRIES as RULES_ENTRIES } from '../server/src/catalog/rules-tools.ts';
import { MAX_MENTION_NAME } from '../server/src/comments/mentions.ts';
import { MAX_ITEMS as PURGE_ITEMS } from '../server/src/edge/routes.ts';
import { MAX_TOKEN_TOOLS as SERVICE_TOKEN_TOOLS } from '../server/src/iam/token-scopes.ts';
import { MAX_TITLE_CHARS as NOTICE_TITLE } from '../server/src/inbox/comment-notices.ts';
import { MAX_TITLE_CHARS as SHARING_TITLE } from '../server/src/projects/sharing.ts';
import { MAX_METADATA_CHARS, MAX_PASSTHROUGH_CHARS } from '../server/src/render-api/mappers.ts';
import { MAX_IGNORED, MAX_NAME as MAPPING_NAME } from '../server/src/render-api/mapping.ts';
import { MAX_URL_GENERATIONS, MAX_URL_QUERY, MAX_WAITERS } from '../server/src/render-api/routes.ts';
import { MAX_RASTER_EDGE_PX } from '../server/src/render/pipeline.ts';
import { MAX_ATTR_LEN } from '../server/src/telemetry/ingest.ts';
import * as collab from '../server/src/collab/limits.ts';
import * as gateway from '../server/src/collab/gateway.ts';
import * as rooms from '../server/src/collab/rooms.ts';
import { PG_CONNECT_TIMEOUT_MS, PG_IDLE_TIMEOUT_MS } from '../server/src/store/limits.ts';
import { PG_CONNECT_TIMEOUT_MS as PG_CONNECT_VIA_OPTIONS } from '../server/src/store/pg-options.ts';
import { POSTGRES_BLOB_MAX_BYTES } from '../server/src/blobs/limits.ts';
import { POSTGRES_BLOB_MAX_BYTES as BLOB_VIA_STORE } from '../server/src/blobs/postgres.ts';
import { RETIRE_REASON_MAX } from '../server/src/audit/limits.ts';
import { RETIRE_REASON_MAX as RETIRE_VIA_MODULE } from '../server/src/audit/retire.ts';
import { KIT_DESIGN_SYSTEM_MAX_BYTES, KIT_LOLLY_MAX_BYTES, KIT_MAX_BYTES, KIT_TOKENS_MAX_BYTES } from '../server/src/programmes/kit.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { limitsInventory } from '../server/src/observability/limits-inventory.ts';

const KiB = 1024, MiB = 1024 * 1024;

/** Each constant, the value it held inline before it was named, and its panel id. */
const PINS: [name: string, actual: unknown, before: unknown, panelId: string | null, panelValue?: unknown][] = [
  ['JSON_BODY_DEFAULT_BYTES', bodies.JSON_BODY_DEFAULT_BYTES, 512 * KiB, 'bodies.jsonDefaultBytes'],
  ['JSON_BODY_CONTROL_BYTES', bodies.JSON_BODY_CONTROL_BYTES, 4096, 'bodies.controlBytes'],
  ['COMMENT_BODY_BYTES', bodies.COMMENT_BODY_BYTES, 16_000, 'bodies.commentBytes'],
  ['JSON_BODY_SMALL_BYTES', bodies.JSON_BODY_SMALL_BYTES, 16 * KiB, 'bodies.smallBytes'],
  ['DELIVERY_BODY_BYTES', bodies.DELIVERY_BODY_BYTES, 32 * KiB, 'bodies.deliveryBytes'],
  ['JSON_BODY_MEDIUM_BYTES', bodies.JSON_BODY_MEDIUM_BYTES, 64 * KiB, 'bodies.mediumBytes'],
  ['JSON_BODY_LIST_BYTES', bodies.JSON_BODY_LIST_BYTES, 512 * KiB, 'bodies.listBytes'],
  ['FORM_BODY_BYTES', bodies.FORM_BODY_BYTES, 4096, 'bodies.formBytes'],
  ['FORM_BODY_LARGE_BYTES', bodies.FORM_BODY_LARGE_BYTES, 32 * KiB, 'bodies.formLargeBytes'],
  ['PROVIDER_PUBLISH_BYTES', bodies.PROVIDER_PUBLISH_BYTES, 64 * MiB, 'bodies.providerPublishBytes'],
  ['LINK_MAX_TTL_HOURS', LINK_MAX_TTL_HOURS, 24 * 365, 'links.maxSeconds', 24 * 365 * 3600],
  ['LINK_ACCESS_MAX_SEC', LINK_ACCESS_MAX_SEC, 12 * 3600, 'links.passwordCookieSeconds'],
  ['CURRENCY_CODE_LENGTH', CURRENCY_CODE_LENGTH, 3, 'programmes.profile.currency'],
  ['SCIM_TOKEN_DEFAULT_DAYS', SCIM_TOKEN_DEFAULT_DAYS, 90, 'scim.tokenDefaultDays'],
  ['SCIM_TOKEN_MAX_DAYS', SCIM_TOKEN_MAX_DAYS, 365, 'scim.tokenMaxDays'],
  ['RENDER_RUNNER_DEFAULTS.concurrency', RENDER_RUNNER_DEFAULTS.concurrency, 2, 'renders.concurrency'],
  ['RENDER_RUNNER_DEFAULTS.leaseMs', RENDER_RUNNER_DEFAULTS.leaseMs, 30_000, 'renders.leaseMs'],
  ['RENDER_RUNNER_DEFAULTS.timeoutMs', RENDER_RUNNER_DEFAULTS.timeoutMs, 120_000, 'renders.attemptTimeoutMs'],
  ['CREDENTIAL_MIN_DAYS', CREDENTIAL_MIN_DAYS, 1, 'tokens.lifetimeMinDays'],
  // Module constants that were not exported, now exported unchanged.
  ['OUTPUT_TOKEN_SECONDS', OUTPUT_TOKEN_SECONDS, 24 * 3600, 'renders.outputLinkSeconds'],
  ['PEOPLE_LIMIT', PEOPLE_LIMIT, 20, 'sharing.peoplePerAnswer'],
  ['ROWS_MAX (access report)', ROWS_MAX, 200, 'projects.accessReportRows'],
  ['MAX_FILE_BYTES (media proofs)', MAX_FILE_BYTES, 64 * MiB, 'catalog.proofFileBytes'],
  ['MAX_TOTAL_BYTES (media proofs)', MAX_TOTAL_BYTES, 256 * MiB, 'catalog.proofTotalBytes'],
  ['DOWNLOAD_BUDGETS_PER_DAY', DOWNLOAD_BUDGETS_PER_DAY, 2, 'projectFiles.downloadBudgetMultiplier'],
  ['MAX_PATTERN_LENGTH', MAX_PATTERN_LENGTH, 200, 'catalog.hiddenTagLength'],
  ['MAX_SNAPSHOT_BYTES', MAX_SNAPSHOT_BYTES, 256 * MiB, 'catalog.snapshotBytes'],
  ['RETAIN_MS (snapshots)', RETAIN_MS, 60 * 60 * 1000, 'catalog.snapshotKeptMs'],
  ['FILE_CAP (Penpot)', FILE_CAP, 200, 'catalog.penpotFiles'],
  ['HISTORY_LIMIT (brand edits)', BRAND_EDIT_HISTORY, 200, 'brand.editRevisionsListed'],
  ['TICKET_MAX_LENGTH', TICKET_MAX_LENGTH, 8192, 'renders.readTicketLength'],
  ['PRODUCTION_MAX_PIXELS', PRODUCTION_MAX_PIXELS, 16_000_000, 'renders.productionPdfPixels'],
  ['EVENT_LIMIT', EVENT_LIMIT, 10_000, 'agents.dashboardEvents'],
  ['AGENT_LIMIT', AGENT_LIMIT, 500, 'agents.dashboardAgents'],
  ['MAX_BYTES (inspection)', MAX_BYTES, 32 * MiB, 'renders.inspectBytes'],
  ['MAX_SVG_BYTES (inspection)', MAX_SVG_BYTES, 2 * MiB, 'renders.inspectSvgBytes'],
  ['MAX_PIXELS (inspection)', MAX_PIXELS, 16_000_000, 'renders.inspectPixels'],
  ['MAX_PENDING (device sign-in)', MAX_PENDING, 100, 'auth.devicePending'],
  ['PER_IP_STARTS', PER_IP_STARTS, 5, 'auth.deviceStartsPerAddress'],
  ['PER_IP_WINDOW_MS', PER_IP_WINDOW_MS, 10 * 60 * 1000, 'auth.deviceStartsWindowMs'],
  ['INDEX_LIMIT (brand pages)', INDEX_LIMIT, 500, 'brandPages.indexRows'],
  ['HISTORY_LIMIT (brand pages)', BRAND_PAGE_HISTORY, 1000, 'brandPages.historyRows'],
  ['STAGED_GRACE_MS', STAGED_GRACE_MS, 60 * 60 * 1000, 'brandPages.stagedGraceMs'],
  ['SCRYPT_MAX_WAITERS', SCRYPT_MAX_WAITERS, 32, 'auth.passwordChecksWaiting'],
  ['MAX_BODY_BYTES (feature flags)', FLAG_ANSWER_BYTES, 64 * KiB, 'connections.flagAnswerBytes'],
  ['NAME_MAX (tool policy)', NAME_MAX, 80, 'policy.toolPolicyNameLength'],
  ['REASON_MAX (tool policy)', REASON_MAX, 200, 'policy.toolPolicyReasonLength'],
  ['LOCK_TIMEOUT (migrations)', LOCK_TIMEOUT, '20s', 'storage.migrationLockWait'],
  ['STATEMENT_TIMEOUT (migrations)', STATEMENT_TIMEOUT, '120s', 'storage.migrationStatementTimeout'],
  ['SYNC_LIMIT_MS', SYNC_LIMIT_MS, 10_000, 'renders.migrationSyncMs'],
  ['INCOMPLETE_AFTER_MS', INCOMPLETE_AFTER_MS, 300_000, 'renders.migrationIncompleteMs'],
  ['URL_RETRY_WINDOW_MS', URL_RETRY_WINDOW_MS, 60_000, 'renders.urlRetryMs'],
  ['TIMEOUT_MS (mail)', SMTP_TIMEOUT_MS, 10_000, 'connections.mailTimeoutMs'],
  ['MAX_TITLE_CHARS (inbox)', INBOX_TITLE, 200, 'inbox.titleLength'],
  ['MAX_DEPTH (audit detail)', AUDIT_DEPTH, 10, 'audit.detailNesting'],
  ['MAX_NODES (audit detail)', AUDIT_NODES, 4096, 'audit.detailValues'],
  ['MAX_ENTRIES (audit detail)', AUDIT_ENTRIES, 256, 'audit.detailEntries'],
  ['MAX_STRING (audit detail)', AUDIT_STRING, 8192, 'audit.detailTextLength'],
  ['MAX_ENTRIES (brand page bundle)', BUNDLE_ENTRIES, 8192, 'brandPages.bundleEntries'],
  ['MAX_DEPTH (brand edit)', EDIT_DEPTH, 48, 'brand.editNesting'],
  ['MAX_NODES (brand edit)', EDIT_NODES, 400_000, 'brand.editValues'],
  ['MAX_CHANGES (brand edit)', EDIT_CHANGES, 5000, 'brand.editChanges'],
  ['MAX_TEXT (brand edit)', MAX_TEXT, 2000, 'brand.editTextLength'],
  ['MAX_ROLES (brand edit)', MAX_ROLES, 32, 'brand.colourRoles'],
  ['MAX_ROLE_LABEL (brand edit)', MAX_ROLE_LABEL, 80, 'brand.colourRoleLabel'],
  ['MAX_ROLE_DESCRIPTION (brand edit)', MAX_ROLE_DESCRIPTION, 600, 'brand.colourRoleDescription'],
  ['KEEP_DOCUMENTS (brand edits)', KEEP_DOCUMENTS, 50, 'brand.editRevisionsKept'],
  ['MAX_PARAM (browse)', MAX_PARAM, 300, 'catalog.browseFilterLength'],
  ['MAX_CURSOR (browse)', MAX_CURSOR, 1200, 'catalog.browseCursorLength'],
  ['MAX_ENTRIES (rules file)', RULES_ENTRIES, 512, 'catalog.rulesFileEntries'],
  ['MAX_MENTION_NAME', MAX_MENTION_NAME, 256, 'comments.mentionNameLength'],
  ['MAX_ITEMS (edge purge)', PURGE_ITEMS, 100, 'connections.edgePurgeItems'],
  ['MAX_TOKEN_TOOLS (service tokens)', SERVICE_TOKEN_TOOLS, 64, 'serviceTokens.maxTools'],
  ['MAX_TITLE_CHARS (comment notices)', NOTICE_TITLE, 200, 'inbox.commentTitleLength'],
  ['MAX_TITLE_CHARS (sharing)', SHARING_TITLE, 200, 'sharing.titleLength'],
  ['MAX_METADATA_CHARS', MAX_METADATA_CHARS, 4096, 'renders.migrationMetadataLength'],
  ['MAX_PASSTHROUGH_CHARS', MAX_PASSTHROUGH_CHARS, 1024, 'renders.migrationPassthroughLength'],
  ['MAX_NAME (mapping)', MAPPING_NAME, 200, 'renders.mappingKeyLength'],
  ['MAX_IGNORED (mapping)', MAX_IGNORED, 1000, 'renders.mappingIgnored'],
  ['MAX_WAITERS', MAX_WAITERS, 10, 'renders.migrationWaiters'],
  ['MAX_URL_QUERY', MAX_URL_QUERY, 8192, 'renders.urlQueryLength'],
  ['MAX_URL_GENERATIONS', MAX_URL_GENERATIONS, 16, 'renders.urlGenerations'],
  ['MAX_RASTER_EDGE_PX', MAX_RASTER_EDGE_PX, 10_000, 'renders.rasterEdgePixels'],
  ['MAX_ATTR_LEN (telemetry)', MAX_ATTR_LEN, 200, 'telemetry.labelLength'],
  // Moved into leaf modules, values unchanged, and still exported where they were.
  ['MAX_MESSAGE_BYTES (collab)', collab.MAX_MESSAGE_BYTES, 256 * KiB, 'collab.messageBytes'],
  ['JOIN_TIMEOUT_MS', collab.JOIN_TIMEOUT_MS, 10_000, 'collab.joinTimeoutMs'],
  ['OPS_PER_SEC', collab.OPS_PER_SEC, 200, 'collab.opsPerSecond'],
  ['OPS_MESSAGES_PER_SEC', collab.OPS_MESSAGES_PER_SEC, 40, 'collab.opMessagesPerSecond'],
  ['MAX_QUEUED_MESSAGES', collab.MAX_QUEUED_MESSAGES, 64, 'collab.queuedMessages'],
  ['MAX_SOCKETS', collab.MAX_SOCKETS, 512, 'collab.sockets'],
  ['MAX_SOCKETS_PER_USER', collab.MAX_SOCKETS_PER_USER, 8, 'collab.socketsPerPerson'],
  ['CONNECTS_PER_USER_PER_MIN', collab.CONNECTS_PER_USER_PER_MIN, 30, 'collab.connectsPerMinute'],
  ['MAX_BUFFERED_BYTES', collab.MAX_BUFFERED_BYTES, 8 * MiB, 'collab.bufferedBytes'],
  ['MAX_DESIGN_SYSTEM_CHARS', collab.MAX_DESIGN_SYSTEM_CHARS, 256, 'collab.designSystemNameLength'],
  ['WRITER_CAP', collab.WRITER_CAP, 10, 'collab.editorsPerDocument'],
  ['WRITER_CAP_PER_USER', collab.WRITER_CAP_PER_USER, 3, 'collab.editorSeatsPerPerson'],
  ['PRESENCE_FRAMES_PER_SEC', collab.PRESENCE_FRAMES_PER_SEC, 40, 'collab.presencePerSecond'],
  ['MAX_OPS_PER_MESSAGE', collab.MAX_OPS_PER_MESSAGE, 200, 'collab.opsPerMessage'],
  ['MAX_SCALAR_CHARS', collab.MAX_SCALAR_CHARS, 32_768, 'collab.scalarLength'],
  ['MAX_ROW_FIELDS', collab.MAX_ROW_FIELDS, 200, 'collab.rowFields'],
  ['MAX_CHAT_CHARS', collab.MAX_CHAT_CHARS, 64, 'collab.chatLength'],
  ['MAX_PARAMS_PER_ROOM', collab.MAX_PARAMS_PER_ROOM, 512, 'collab.inputsPerDocument'],
  ['MAX_COLLECTIONS_PER_ROOM', collab.MAX_COLLECTIONS_PER_ROOM, 64, 'collab.groupsPerDocument'],
  ['MAX_BOXES_PER_COLLECTION', collab.MAX_BOXES_PER_COLLECTION, 2000, 'collab.boxesPerGroup'],
  ['MAX_TRACKED_CLIENTS', collab.MAX_TRACKED_CLIENTS, 512, 'collab.trackedClients'],
  ['MAX_GUEST_NAME_CHARS', collab.MAX_GUEST_NAME_CHARS, 60, 'collab.guestNameLength'],
  ['SOCKET_TICKET_TTL_MS', collab.SOCKET_TICKET_TTL_MS, 30_000, 'collab.ticketMs'],
  ['MAX_TICKETS', collab.MAX_TICKETS, 1024, 'collab.ticketsHeld'],
  ['NEARBY_TTL_MS', collab.NEARBY_TTL_MS, 12 * 60 * 60 * 1000, 'collab.nearbyMs'],
  ['PG_CONNECT_TIMEOUT_MS', PG_CONNECT_TIMEOUT_MS, 15_000, 'storage.databaseConnectMs'],
  ['PG_IDLE_TIMEOUT_MS', PG_IDLE_TIMEOUT_MS, 30_000, 'storage.databaseIdleMs'],
  ['POSTGRES_BLOB_MAX_BYTES', POSTGRES_BLOB_MAX_BYTES, 500 * MiB, 'storage.postgresBlobBytes'],
  ['RETIRE_REASON_MAX', RETIRE_REASON_MAX, 200, 'audit.retireReasonLength'],
  // Partner kit limits from main, shown as they are.
  ['KIT_MAX_BYTES', KIT_MAX_BYTES, KIT_MAX_BYTES, 'programmes.kitBytes'],
  ['KIT_TOKENS_MAX_BYTES', KIT_TOKENS_MAX_BYTES, 2 * MiB, 'programmes.kitTokensBytes'],
  ['KIT_LOLLY_MAX_BYTES', KIT_LOLLY_MAX_BYTES, KIT_LOLLY_MAX_BYTES, 'programmes.kitLollyBytes'],
  ['KIT_DESIGN_SYSTEM_MAX_BYTES', KIT_DESIGN_SYSTEM_MAX_BYTES, 8 * MiB, 'programmes.kitDesignSystemBytes'],
];

const config = parseConfig(JSON.stringify({ instance: { name: 'Pins', baseUrl: 'http://localhost', pack: './packs/demo' }, dev: { enabled: true } }));
const panel = new Map(limitsInventory(config, { env: {} }).map((entry) => [entry.id, entry]));

for (const [name, actual, before, panelId, panelValue] of PINS) {
  test(`${name} keeps the value it held inline`, () => {
    assert.equal(actual, before);
    if (panelId) {
      const entry = panel.get(panelId);
      assert.ok(entry, `${panelId} is on the panel`);
      assert.equal(entry.value, panelValue ?? before);
      assert.equal(entry.source, 'built-in');
    }
  });
}

const request = (bytes: number): IncomingMessage => Readable.from([Buffer.from(`"${'x'.repeat(Math.max(0, bytes - 2))}"`)]) as unknown as IncomingMessage;

test('readJson still refuses a body past its default and past a named cap', async () => {
  assert.ok(await readJson(request(bodies.JSON_BODY_DEFAULT_BYTES)));
  await assert.rejects(readJson(request(bodies.JSON_BODY_DEFAULT_BYTES + 1)), { status: 413 });
  assert.ok(await readJson(request(bodies.JSON_BODY_CONTROL_BYTES), bodies.JSON_BODY_CONTROL_BYTES));
  await assert.rejects(readJson(request(bodies.JSON_BODY_CONTROL_BYTES + 1), bodies.JSON_BODY_CONTROL_BYTES), { status: 413 });
  await assert.rejects(readRaw(request(bodies.FORM_BODY_BYTES + 1), bodies.FORM_BODY_BYTES));
});

test('a company currency is still three letters', () => {
  assert.deepEqual(readProfileBody({ currency: 'eur' }, { allowName: false }), { currency: 'EUR' });
  assert.match(String((readProfileBody({ currency: 'EURO' }, { allowName: false }) as { error?: string }).error), /three-letter ISO 4217/);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('no route reads a body with a numeric cap written inline', () => {
  const inline: string[] = [];
  for (const file of sources(new URL('../server/src', import.meta.url).pathname)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      // `readRaw(req, 1)` asks whether a body exists at all; it sets no size.
      if (/\bread(?:Json|Raw)\(req, (?!1\))[0-9]/.test(line)) inline.push(`${file.split('/server/src/')[1]}:${index + 1}`);
    });
  }
  assert.deepEqual(inline, [], 'name the cap in server/src/api/body-limits.ts so the Limits and quotas panel shows it');
});

test('every panel id is unique and every area is a short list', () => {
  const entries = limitsInventory(config, { env: {} });
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  const perArea = new Map<string, number>();
  for (const entry of entries) perArea.set(entry.area, (perArea.get(entry.area) ?? 0) + 1);
  for (const [area, count] of perArea) assert.ok(count <= 40, `${area} holds ${count} limits`);
});

test('the modules the limits moved out of still export them unchanged', () => {
  for (const name of ['MAX_MESSAGE_BYTES', 'JOIN_TIMEOUT_MS', 'OPS_PER_SEC', 'OPS_MESSAGES_PER_SEC', 'MAX_QUEUED_MESSAGES', 'MAX_SOCKETS',
    'MAX_SOCKETS_PER_USER', 'CONNECTS_PER_USER_PER_MIN', 'MAX_BUFFERED_BYTES'] as const) assert.equal(gateway[name], collab[name], name);
  for (const name of ['WRITER_CAP', 'WRITER_CAP_PER_USER', 'PRESENCE_FRAMES_PER_SEC', 'MAX_OPS_PER_MESSAGE', 'MAX_SCALAR_CHARS', 'MAX_ROW_FIELDS',
    'MAX_CHAT_CHARS', 'MAX_PARAMS_PER_ROOM', 'MAX_COLLECTIONS_PER_ROOM', 'MAX_BOXES_PER_COLLECTION', 'MAX_TRACKED_CLIENTS'] as const) assert.equal(rooms[name], collab[name], name);
  assert.equal(PG_CONNECT_VIA_OPTIONS, PG_CONNECT_TIMEOUT_MS);
  assert.equal(BLOB_VIA_STORE, POSTGRES_BLOB_MAX_BYTES);
  assert.equal(RETIRE_VIA_MODULE, RETIRE_REASON_MAX);
});
