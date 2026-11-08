#!/usr/bin/env node
/**
 * lw - the lolly-work admin CLI. A thin wrapper over the same API the console
 * uses, so the two surfaces grow in parity by construction (plans: console
 * first, CLI follows).
 *
 *   LW_BASE=https://lolly.example lw login --email admin@test   # dev provider
 *   lw whoami | summary | fleet | links [--all] | links create <toolId> [key=value ...] [--open] | links revoke <id>
 *   lw msg send --title "…" [--severity action --groups a,b --max-engine 1.52.99 --starts <ISO> --ends <ISO>]
 *   lw audit verify
 *
 * Auth: `lw login` runs the device-code flow (print a short code, confirm it in
 * a signed-in browser). The session cookie is stored at
 * ~/.config/lolly-work/session (0600). `--email` uses the dev provider where
 * enabled, and `--cookie 'lw_session=…'` pastes a browser session directly.
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { closeSync, constants, createWriteStream, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileSource, fileStateStore, resumableUpload, UploadClientError, type UploadTarget } from './upload-client.ts';
import { runEdgeProbe } from '../server/src/edge/probe.ts';
import { runRenderApi } from './render-api.ts';
import { runBrandPages } from './brand-pages.ts';

const CONFIG_DIR = join(homedir(), '.config', 'lolly-work');
const SESSION_FILE = join(CONFIG_DIR, 'session');

const OPTIONS = {
    help: { type: 'boolean', short: 'h' },
    base: { type: 'string' },
    email: { type: 'string' },
    cookie: { type: 'string' },
    token: { type: 'string' },
    role: { type: 'string' },
    'token-env': { type: 'string' },
    scopes: { type: 'string' },
    tools: { type: 'string' },
    expires: { type: 'string' },
    all: { type: 'boolean' },
    open: { type: 'boolean' },
    hours: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    kind: { type: 'string' },
    severity: { type: 'string' },
    groups: { type: 'string' },
    // Repeatable: `lw invite add a@x b@x --group team --group brand`.
    group: { type: 'string', multiple: true },
    shells: { type: 'string' },
    'max-engine': { type: 'string' },
    effect: { type: 'string' },
    label: { type: 'string' },
    options: { type: 'string' },
    mapping: { type: 'string' },
    exposure: { type: 'string' },
    section: { type: 'string' },
    category: { type: 'string' },
    cursor: { type: 'string' },
    limit: { type: 'string' },
    'remote-id': { type: 'string' },
    name: { type: 'string' },
    tags: { type: 'string' },
    type: { type: 'string' },
    // Repeatable: `--field region=EMEA --field campaign=Q4`. An empty value
    // (`--field region=`) clears one, which is why it is a flag per field
    // rather than one comma-separated string nobody could put a comma in.
    field: { type: 'string', multiple: true },
    // Collections (plans/31 §5): the member list is comma-separated because a
    // catalog asset id never contains a comma, and the ORDER you type is the
    // order the set keeps.
    members: { type: 'string' },
    // Versions (plans/31 §6): `--asset` turns `catalog submit` into a new
    // version of an asset that is already in the catalog, `--note` is the
    // changelog line kept on the version row, and `--replaced-by` retires an
    // id in favour of another.
    asset: { type: 'string' },
    note: { type: 'string' },
    // `lw catalog rights mark|licence` (plans/82 M4).
    holder: { type: 'string' },
    terms: { type: 'string' },
    attribution: { type: 'string' },
    'replaced-by': { type: 'string' },
    replacement: { type: 'string' },
    destination: { type: 'string' },
    format: { type: 'string' },
    'idempotency-key': { type: 'string' },
    'callback-url': { type: 'string' },
    // `lw render-api`: moving off a hosted render API.
    from: { type: 'string' },
    'source-url': { type: 'string' },
    'max-pages': { type: 'string' },
    'no-previews': { type: 'boolean' },
    template: { type: 'string' },
    values: { type: 'string' },
    reference: { type: 'string' },
    regions: { type: 'string' },
    'max-changed': { type: 'string' },
    tolerance: { type: 'string' },
    'spend-credits': { type: 'boolean' },
    'remove-files': { type: 'boolean' },
    rm: { type: 'boolean' },
    // SCIM (plans/31 §8): the label for the IdP connector a provisioning token
    // belongs to, carried onto every audit event the token drives.
    idp: { type: 'string' },
    check: { type: 'boolean' },
    out: { type: 'string' },
    reviewed: { type: 'boolean' },
    in: { type: 'string' },
    org: { type: 'string' },
    days: { type: 'string' },
    shape: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    // `lw audit retire-key --reason "…"`: the one line kept on the boundary row,
    // the head recorded before the rotation, and the two recorded overrides.
    reason: { type: 'string' },
    'expect-head': { type: 'string' },
    'allow-interleaved': { type: 'boolean' },
    'no-witness': { type: 'boolean' },
    prune: { type: 'boolean' },
    json: { type: 'boolean' },
    // `lw upload`: a project file (--project) or a scoped upload (--scope).
    project: { type: 'string' },
    scope: { type: 'string' },
    'content-type': { type: 'string' },
    // `lw edge purge --tag b_... --url https://...` (repeatable) and `lw edge probe`.
    tag: { type: 'string', multiple: true },
    url: { type: 'string', multiple: true },
    path: { type: 'string', multiple: true },
    origin: { type: 'string' },
    // Partner programmes (plans/82 M1 part 2): lw domains, lw people.
    programme: { type: 'string' },
    description: { type: 'string' },
    team: { type: 'string' },
    editable: { type: 'string' },
    bindings: { type: 'string' },
    company: { type: 'string' },
    domain: { type: 'string' },
    ends: { type: 'string' },
    // `lw msg send --starts <ISO>`: when a message begins to show.
    starts: { type: 'string' },
    at: { type: 'string' },
    'no-notice': { type: 'boolean' },
    assert: { type: 'boolean' },
    apply: { type: 'boolean' },
    projects: { type: 'string' },
    'keep-projects': { type: 'boolean' },
    'move-staff': { type: 'string' },
    whole: { type: 'boolean' },
    // `lw companies profile settings`: editors and separate profile and kit chains.
    editors: { type: 'string' },
    chain: { type: 'string' },
    'kit-chain': { type: 'string' },
    // `lw programmes limits` and `lw tokens limits` (plans/82 M7): a whole number,
    // `none` for no cap, or `default` to take the next level's figure.
    'calls-per-minute': { type: 'string' },
    'renders-per-day': { type: 'string' },
    'renders-per-month': { type: 'string' },
    // `lw tokens add --programme <id> --ttl-days 90`: a partner agent's lifetime in days.
    'ttl-days': { type: 'string' },
    // `lw programmes usage <id> --from YYYY-MM-DD --to YYYY-MM-DD --by day|week [--csv]` (plans/82 M7).
    to: { type: 'string' },
    by: { type: 'string' },
    csv: { type: 'boolean' },
} as const;

/** A message's --starts or --ends as the UTC instant the server stores. A time
 *  must carry its zone (Z or an offset), so it means the same moment wherever
 *  lw runs. */
function messageTime(flag: 'starts' | 'ends', raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(raw);
  const [y, mo, d, h, mi, sec, oh, om] = (m ?? []).slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  // Date.parse rolls an impossible day forward (02-31 becomes 03-03), so each part is checked first.
  const calendar = m ? new Date(Date.UTC(y!, mo! - 1, d!)) : null;
  const real = !!calendar && calendar.getUTCFullYear() === y && calendar.getUTCMonth() === mo! - 1 && calendar.getUTCDate() === d
    && h! <= 23 && mi! <= 59 && sec! <= 59 && oh! <= 23 && om! <= 59;
  const ms = Date.parse(raw);
  if (!real || Number.isNaN(ms)) fail(`--${flag} wants a real date and time with its zone, such as 2026-12-07T09:00:00Z`);
  return new Date(ms).toISOString();
}

// parseArgs throws on an unknown flag; catch it so a typo prints one line
// rather than an unhandled TypeError and a Node stack trace.
function parseCli(): ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>> {
  try {
    return parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (err) {
    console.error(`lw: ${(err as Error).message}`);
    console.error('lw: run `lw` with no arguments for the command list.');
    process.exit(1);
  }
}

const { positionals, values } = parseCli();

const base = (values.base ?? process.env.LW_BASE ?? 'http://localhost:8787').replace(/\/+$/, '');

function savedCookie(): string | null {
  try { return readFileSync(SESSION_FILE, 'utf8').trim() || null; } catch { return null; }
}

async function response(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const cookie = savedCookie();
  // A service token (plans/35 wave 2) outranks a stored session: automation
  // passing --token or LW_TOKEN means "act as the automation", never as
  // whoever last signed in on this machine.
  const bearer = values.token ?? process.env.LW_TOKEN;
  const rawBody = opts.body instanceof Uint8Array ? new Uint8Array(opts.body) : undefined;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : cookie ? { cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': rawBody ? 'application/octet-stream' : 'application/json' } : {}),
        ...opts.headers,
        'x-lolly-client': 'lw-cli engine/0',
      },
      ...(opts.body !== undefined ? { body: rawBody ?? JSON.stringify(opts.body) } : {}),
    });
  } catch {
    // A stack trace out of node:net tells a first-time operator nothing. The
    // answer is always the same: the instance is elsewhere, or is not up.
    fail(`cannot reach ${base} — start the instance, or point at it with --base <url> (or LW_BASE)`);
  }
  return res;
}

async function call(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
  const res = await response(path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    fail(`${res.status} ${err?.code ?? ''} ${err?.message ?? ''}`.trim());
  }
  return data;
}

/** A media type from a file name, for the common kinds; anything else is octet-stream. */
function contentTypeOf(file: string): string {
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', zip: 'application/zip', json: 'application/json' };
  return types[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function fail(msg: string): never {
  console.error(`lw: ${msg}`);
  process.exit(1);
}

function out(value: unknown): void {
  if (values.json) console.log(JSON.stringify(value, null, 2));
}

type LimitFigures = { callsPerMinute?: number | null; rendersPerDay?: number | null; rendersPerMonth?: number | null };
const LIMIT_FLAGS = [['calls-per-minute', 'callsPerMinute'], ['renders-per-day', 'rendersPerDay'], ['renders-per-month', 'rendersPerMonth']] as const;

/** What the limit flags say, laid over what is stated now: a number caps, `none`
 *  is no cap, `default` drops the figure so the next level's applies. Null when no flag is set. */
function limitFlags(current: LimitFigures): LimitFigures | null {
  if (!LIMIT_FLAGS.some(([flag]) => values[flag] !== undefined)) return null;
  const next: LimitFigures = { ...current };
  for (const [flag, key] of LIMIT_FLAGS) {
    const raw = values[flag];
    if (raw === undefined) continue;
    if (raw === 'default') delete next[key];
    else if (raw === 'none') next[key] = null;
    else if (/^\d+$/.test(raw)) next[key] = Number(raw);
    else fail(`--${flag} takes a whole number, none or default`);
  }
  return next;
}

/** One line per limit: the figure, and where it comes from when the server says. */
function printLimits(limits: Record<string, number | null>, sources?: Record<string, string>, used?: Record<string, number>): void {
  const words: Record<string, string> = { callsPerMinute: 'calls a minute', rendersPerDay: 'renders a day', rendersPerMonth: 'renders a month' };
  for (const key of Object.keys(words)) {
    const value = limits[key];
    const from = sources?.[key] ? `  (${sources[key] === 'none' ? 'internal token: no limit unless set' : `from the ${sources[key]}`})` : '';
    const use = used?.[key] !== undefined ? `  used ${used[key]}` : '';
    console.log(`  ${words[key]!.padEnd(16)} ${value === null || value === undefined ? 'no cap' : value.toLocaleString('en-US')}${use}${from}`);
  }
}

interface IntentAnswer {
  outcome: string; intentDigest: string; closed: { purpose: string | null; rulesVersion: string };
  purposeNeeded: { message: string; purposes: Array<{ purpose: string; meaning: string; tools: string[] }>; surfaces: string[]; roles: string[] } | null;
  surfaces: Array<{
    surface: { id: string }; status: string; refusal: { message: string } | null;
    chosen: {
      toolId: string; format: string; exportDims: { width: number; height: number; unit: string }; sizeSetBy: string;
      gaps: Array<{ role?: string; input?: string; message: string }>; unused: Array<{ role: string; message: string }>;
      defaultsInUse: string[]; notes: Array<{ message: string }>;
    } | null;
  }>;
}

function printIntentAnswer(answer: IntentAnswer): void {
  console.log(`Intent: ${answer.outcome}${answer.closed.purpose ? ` (${answer.closed.purpose})` : ''}`);
  console.log(`Rules ${answer.closed.rulesVersion}, ${answer.intentDigest}`);
  if (answer.purposeNeeded) {
    console.log(`\n${answer.purposeNeeded.message}\n\nPurposes:`);
    for (const p of answer.purposeNeeded.purposes) console.log(`  ${p.purpose.padEnd(12)} ${p.meaning}${p.tools.length ? ` [${p.tools.join(', ')}]` : ''}`);
    console.log(`\nSurfaces: ${answer.purposeNeeded.surfaces.join(', ')}\nRoles: ${answer.purposeNeeded.roles.join(', ')}`);
  }
  for (const { surface, status, refusal, chosen } of answer.surfaces) {
    console.log('');
    if (!chosen) { console.log(`${surface.id}: refused. ${refusal?.message ?? ''}`); continue; }
    const size = `${chosen.exportDims.width} x ${chosen.exportDims.height} ${chosen.exportDims.unit}`;
    console.log(`${surface.id}: ${status}. ${chosen.toolId} as ${chosen.format}, ${size}${chosen.sizeSetBy === 'export' ? ' (pass this size to the render)' : ''}`);
    for (const gap of chosen.gaps) console.log(`  Needs ${gap.role ?? gap.input}: ${gap.message}`);
    for (const item of chosen.unused) console.log(`  Not used, ${item.role}: ${item.message}`);
    if (chosen.defaultsInUse.length) console.log(`  The tool's own wording stays in: ${chosen.defaultsInUse.join(', ')}`);
    for (const note of chosen.notes) console.log(`  Note: ${note.message}`);
  }
}

interface ProjectTransferPreview {
  schema: 'lolly-project-transfer-inventory-v1';
  mode: 'preview';
  readOnly: true;
  snapshotConsistent: false;
  complete: false;
  importReady: false;
  observedAt: string;
  project: { id: string; name: string; archived: boolean };
  counts: { folders: number; sessions: number; files: number; declaredFileBytes: number; explicitMembers: number; omittedSessions: number };
  warnings: string[];
}

/** Keep a refused preview's response body out of terminal output. */
async function projectTransferPreview(id: string): Promise<ProjectTransferPreview> {
  const res = await response(`/api/v1/projects/${encodeURIComponent(id)}/transfer-inventory`);
  if (!res.ok) {
    const explanation = res.status === 401 ? 'sign in with lw login; this preview accepts a person\'s session, not an agent or service token'
      : res.status === 403 ? 'use a person\'s session with project manager access and project.manage permission; agent/service tokens and denied grants are refused'
      : res.status === 404 ? 'check the project id and your access; this instance may need a release that supports transfer previews'
      : res.status === 413 ? 'the project exceeds the preview limits; use an operator-reviewed inventory for a larger project'
      : res.status === 429 ? 'too many preview requests; wait before trying again'
      : 'the preview could not be completed; check the instance status before trying again';
    fail(`transfer preview refused (${res.status}): ${explanation}`);
  }
  const result = await res.json().catch(() => null) as ProjectTransferPreview | null;
  if (!result || result.schema !== 'lolly-project-transfer-inventory-v1' || result.mode !== 'preview'
    || result.readOnly !== true || result.snapshotConsistent !== false || result.complete !== false || result.importReady !== false
    || typeof result.observedAt !== 'string' || result.project?.id !== id || typeof result.project.name !== 'string'
    || typeof result.project.archived !== 'boolean' || !result.counts
    || !['folders', 'sessions', 'files', 'declaredFileBytes', 'explicitMembers', 'omittedSessions'].every(key => {
      const value = result.counts[key as keyof ProjectTransferPreview['counts']];
      return Number.isSafeInteger(value) && value >= 0;
    }) || !Array.isArray(result.warnings) || !result.warnings.every(w => typeof w === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(w))) {
    fail('the instance returned an unsupported transfer preview; update the CLI and server to compatible releases');
  }
  return result;
}

/** A preview copy is private and can only be created at a new file path. */
function saveTransferPreview(path: string, json: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, json);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const explanation = code === 'EEXIST' || code === 'ELOOP' ? 'the path already exists or is a symbolic link; choose a new file path'
      : code === 'ENOENT' ? 'the parent folder does not exist; create it first or choose another folder'
      : code === 'EACCES' || code === 'EPERM' ? 'the folder is not writable; choose a folder you can write to'
      : 'check the destination and any incomplete copy, then choose a new file path';
    fail(`cannot save transfer preview to ${JSON.stringify(path)}: ${explanation}`);
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* The write failure is reported above. */ } }
  }
}

/** The kinds `lw providers auth` can drive end to end. Every other OAuth kind
 *  here (canto, imagerelay, optimizely-cmp) is live-verify-pending: its
 *  authorize/token endpoints are taken from vendor documentation and have not
 *  been confirmed against a real tenant, and this CLI will not guess a consent
 *  URL. Those kinds capture the sealed blob through `lw providers credential`
 *  instead. Keep this list in step with oauthFlowFor below. */
const OAUTH_FLOW_KINDS = ['dropbox', 'gdrive', 'o365'];

/** Consent endpoints per OAuth provider kind. Scopes are read-only; the
 *  offline/refresh grant is what the stored credential is. */
function oauthFlowFor(
  kind: string,
  options: Record<string, unknown>,
): { authorizeUrl: string; tokenUrl: string; authParams: Record<string, string> } | null {
  if (kind === 'dropbox') {
    return {
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      authParams: { token_access_type: 'offline' },
    };
  }
  if (kind === 'gdrive') {
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      authParams: { access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/drive.readonly' },
    };
  }
  if (kind === 'o365') {
    const tenant = typeof options.tenant === 'string' ? options.tenant : 'common';
    return {
      authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      authParams: { scope: 'https://graph.microsoft.com/Files.Read.All offline_access' },
    };
  }
  return null;
}

async function promptVisible(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim();
}

/** Prompt without echoing - for credentials (never argv, never shell history). */
async function promptHidden(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, terminal: true });
  // Swallow the echo: readline writes what it receives to output when terminal
  // is true; with no output stream attached, keystrokes stay dark.
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return answer.trim();
}

const [cmd, sub] = positionals;

switch (cmd) {
  case 'projects': {
    const id = positionals[2];
    if (sub !== 'transfer-preview' || !id || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || positionals.length !== 3) {
      fail('usage: lw projects transfer-preview <project-id> [--json] [--out new-file.json]');
    }
    if (values.out !== undefined && !values.out.trim()) fail('--out needs a new file path');
    const preview = await projectTransferPreview(id);
    const json = JSON.stringify(preview, null, 2) + '\n';
    if (values.out !== undefined) saveTransferPreview(values.out, json);
    if (values.json) process.stdout.write(json);
    else {
      const counts = preview.counts;
      console.log(`Transfer preview: ${JSON.stringify(preview.project.name)} (${preview.project.id})${preview.project.archived ? ' [archived]' : ''}`);
      console.log(`${counts.folders} folders · ${counts.sessions} sessions · ${counts.files} ready files · ${counts.declaredFileBytes} declared file bytes · ${counts.explicitMembers} explicit members`);
      if (counts.omittedSessions) console.log(`${counts.omittedSessions} sessions omitted by access policy.`);
      console.log('Read-only inventory. Not a consistent snapshot or an import-ready export.');
      console.log('Asset dependencies, full history, file bytes and destination identities still need review.');
      if (preview.warnings.includes('LIVE_COLLABORATION')) console.log('Live collaboration was observed; keep editors connected and arrange a separate migration window.');
      if (values.out !== undefined) console.log(`Saved private preview to ${JSON.stringify(values.out)}.`);
    }
    break;
  }
  case 'approvals': {
    // A person's own requests and inbox. The file route verifies as it streams and
    // this checks the whole file again against the digest on the record.
    const action = sub ?? 'list';
    if (action === 'list') {
      const { approvals } = await call('/api/v1/approvals') as { approvals: Array<{ id: string; state: string; title: string; relation?: string; exportReview?: { sha256: string; format: string; removedAt?: string } }> };
      if (values.json) { out(approvals); break; }
      for (const a of approvals) console.log(`${a.id}  ${a.state}  ${a.relation ?? ''}  ${a.title}${a.exportReview ? `  ${a.exportReview.format} ${a.exportReview.sha256.slice(0, 12)}${a.exportReview.removedAt ? ' (file removed)' : ''}` : ''}`);
      break;
    }
    if (action !== 'artifact') fail('usage: lw approvals [list] | lw approvals artifact <id> --out <file> [--reviewed]');
    const id = positionals[2] ?? fail('usage: lw approvals artifact <id> --out <file> [--reviewed]');
    if (!values.out) fail('usage: lw approvals artifact <id> --out <file> [--reviewed]');
    const res = await response(`/api/v1/approvals/${encodeURIComponent(id)}/artifact${values.reviewed ? '?file=reviewed' : ''}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      fail(`${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim());
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = /^sha-256=:(.+):$/.exec(res.headers.get('repr-digest') ?? '')?.[1];
    if (!digest || createHash('sha256').update(bytes).digest('base64') !== digest) fail('the file did not match its recorded digest; nothing was written');
    writeFileSync(values.out, bytes);
    const sha256 = Buffer.from(digest, 'base64').toString('hex');
    // The server states what this file is. The record is in the file only when it
    // read the write back and says so.
    const recordHeader = res.headers.get('x-lolly-approval-record');
    const recorded = recordHeader === 'recorded';
    const reason = /reason=(\S+)/.exec(recordHeader ?? '')?.[1];
    if (values.json) out({ file: values.out, bytes: bytes.byteLength, sha256, ...(recordHeader ? { approvalRecord: recorded ? 'recorded' : 'not-recorded', ...(reason ? { reason } : {}) } : {}) });
    else {
      console.log(`${values.out} (${bytes.byteLength} bytes, SHA-256 ${sha256})`);
      if (recordHeader) console.log(recorded ? 'The approval is recorded in this file\'s Content Credentials.' : `The approval is not recorded in this file (${reason ?? 'unknown'}). It is the file as reviewed.`);
    }
    break;
  }
  case 'renders':
  case 'render-batches': {
    const batch = cmd === 'render-batches';
    const path = `/api/v1/${cmd}`;
    const action = sub ?? 'list';
    const id = positionals[2];
    const keyHeaders: Record<string, string> = values['idempotency-key'] ? { 'idempotency-key': values['idempotency-key'] } : {};
    let value: unknown;
    if (action === 'submit') {
      if (!id) fail(`${cmd} submit <request.json> [--idempotency-key <key>] [--callback-url <url>]`);
      let body: unknown;
      try { body = JSON.parse(readFileSync(id, 'utf8')); }
      catch { fail(`cannot read render request JSON: ${id}`); }
      if (values['callback-url']) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('--callback-url needs a request that is a JSON object');
        body = { ...(body as Record<string, unknown>), callbackUrl: values['callback-url'] };
      }
      value = await call(path, { method: 'POST', body, headers: keyHeaders });
    } else if (action === 'list') {
      value = await call(path);
    } else if (['show', 'retry', 'cancel', ...(batch ? ['manifest', 'archive'] : ['output', 'evidence', 'deliver'])].includes(action)) {
      if (!id) fail(`${cmd} ${action} <id>`);
      const resource = `${path}/${encodeURIComponent(id)}`;
      if (action === 'deliver') {
        const destinationId = values.destination ?? fail('--destination <id> required');
        const name = values.name ?? fail('--name required');
        const delivery = await call(`${resource}/deliveries`, {
          method: 'POST', headers: keyHeaders,
          body: { destinationId, name, ...(values.format ? { format: values.format } : {}) },
        }) as { id: string; state: string; name: string; format: string; destinationId: string; url: string | null };
        out(delivery);
        if (!values.json) {
          console.log(`${delivery.id}  ${delivery.state}  ${delivery.name}.${delivery.format} → ${delivery.destinationId}`);
          if (delivery.state === 'awaiting-approval') console.log('waiting on the destination approval chain');
          if (delivery.url) console.log(delivery.url);
        }
        break;
      }
      if (action === 'archive') {
        if (!values.out) fail(`${cmd} archive <id> --out <file>`);
        const res = await response(`${resource}/archive`);
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          fail(`${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim());
        }
        // Streamed to a temporary name: a dropped connection leaves no file that looks finished.
        const partial = `${values.out}.part`;
        try { await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial, { mode: 0o600 })); }
        catch (error) {
          rmSync(partial, { force: true });
          fail(`the archive download stopped before it finished: ${(error as Error).message}`);
        }
        renameSync(partial, values.out);
        const bytes = statSync(values.out).size;
        out({ file: values.out, bytes });
        if (!values.json) console.log(`${values.out} (${bytes} bytes)`);
        break;
      }
      if (action === 'output' || action === 'manifest' || action === 'evidence') {
        if (!values.out) fail(`${cmd} ${action} <id> --out <file>`);
        const res = await response(`${resource}/${action === 'output' ? 'output/default' : action}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          fail(`${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim());
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(values.out, bytes);
        out({ file: values.out, bytes: bytes.byteLength });
        if (!values.json) console.log(`${values.out} (${bytes.byteLength} bytes)`);
        break;
      }
      value = await call(`${resource}${action === 'retry' ? '/retry' : ''}`, {
        method: action === 'retry' ? 'POST' : action === 'cancel' ? 'DELETE' : 'GET', headers: keyHeaders,
      });
    } else fail(`${cmd}: use submit, list, show, ${batch ? 'manifest, archive' : 'output, evidence, deliver'}, cancel or retry`);
    if (values.json) out(value);
    else {
      type Row = { id: string; state: string; attempt: number; request: { toolId: string; format: string }; progress?: { done: number; total: number; succeeded: number; failed: number; cancelled: number }; error?: { message: string } };
      const rows = action === 'list' ? (value as Record<string, Row[]>)[batch ? 'batches' : 'renders']! : [value as Row];
      for (const row of rows) {
        const progress = row.progress;
        const detail = progress ? `${progress.done}/${progress.total} rows complete (${progress.succeeded} succeeded, ${progress.failed} failed, ${progress.cancelled} cancelled)` : `attempt ${row.attempt}`;
        console.log(`${row.id}  ${row.state}  ${row.request.toolId}.${row.request.format}  ${detail}${row.error ? `  ${row.error.message}` : ''}`);
      }
    }
    break;
  }
  case 'login': {
    if (values.cookie) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SESSION_FILE, values.cookie, { mode: 0o600 });
      console.log('session cookie saved.');
      break;
    }
    if (values.email) {
      const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(values.email)}`, { redirect: 'manual' });
      if (res.status !== 302) fail(`dev login refused (${res.status}) — is dev.enabled on, and the email in dev.users?`);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
      if (!cookie) fail('no session cookie in response');
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SESSION_FILE, cookie as string, { mode: 0o600 });
      console.log(`signed in as ${values.email} against ${base}`);
      break;
    }
    // The device flow (plans/34 wave 4) is the default: no cookie pasting, no
    // dev provider - sign in in any browser and confirm the short code there.
    const start = await fetch(`${base}/api/v1/auth/device`, { method: 'POST', headers: { 'x-lolly-client': 'lw-cli engine/0' } });
    if (!start.ok) fail(`device sign-in refused (${start.status})`);
    const d = await start.json() as { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
    console.log(`Open ${d.verificationUri} in a signed-in browser and enter: ${d.userCode}`);
    console.log(`(waiting — the code lives ${Math.round(d.expiresIn / 60)} minutes; ctrl-c to give up)`);
    let done = false;
    const deadline = Date.now() + d.expiresIn * 1000;
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, d.interval * 1000));
      const poll = await fetch(`${base}/api/v1/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lolly-client': 'lw-cli engine/0' },
        body: JSON.stringify({ deviceCode: d.deviceCode }),
      });
      if (poll.status === 429) continue; // over the bucket - the next tick refills it
      const t = await poll.json() as { status: string; cookie?: string };
      if (t.status === 'pending') continue;
      if (t.status === 'approved' && t.cookie) {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(SESSION_FILE, t.cookie, { mode: 0o600 });
        console.log(`signed in against ${base}`);
        done = true;
        break;
      }
      fail(t.status === 'denied' ? 'sign-in denied from the browser side' : 'code expired — run lw login again');
    }
    if (!done) fail('code expired — run lw login again');
    break;
  }

  case 'whoami': {
    const who = await call('/api/auth/session') as { kind: string; user?: { email: string; role: string; groups: string[] } };
    out(who);
    if (!values.json) console.log(who.kind === 'member' ? `${who.user?.email} (${who.user?.role}) groups: ${who.user?.groups.join(', ') || '—'}` : who.kind);
    break;
  }

  case 'summary': {
    const s = await call('/api/v1/telemetry/summary') as {
      totals: { events: number; exports: number; activeUsers: number };
      topTools: Array<{ toolId: string; count: number }>;
      topDownloads?: Array<{ assetId: string; count: number }>;
    };
    out(s);
    if (!values.json) {
      console.log(`events ${s.totals.events} · exports ${s.totals.exports} · attributed people ${s.totals.activeUsers}`);
      for (const t of s.topTools) console.log(`  ${String(t.count).padStart(6)}  ${t.toolId}`);
      if (s.topDownloads?.length) {
        console.log('downloads:');
        for (const d of s.topDownloads) console.log(`  ${String(d.count).padStart(6)}  ${d.assetId}`);
      }
    }
    break;
  }

  case 'fleet': {
    if (sub === 'installs') {
      // The registry, not the histogram (plans/34 wave 3): devices that spoke
      // `install/<id>` while signed in. Read-only here - rename and forget are
      // console bookkeeping.
      const { installs } = await call('/api/v1/fleet/installs') as {
        installs: Array<{ installId: string; name?: string; userName?: string; lastSeenAt: string;
          info: { shell: string; shellVersion?: string; engine?: string; platform?: string } }>;
      };
      out(installs);
      if (!values.json) for (const i of installs) {
        const tag = [
          i.info.shell + (i.info.shellVersion ? `/${i.info.shellVersion}` : ''),
          i.info.engine ? `engine/${i.info.engine}` : '', i.info.platform ?? '',
        ].filter(Boolean).join(' ');
        console.log(`${i.installId}  ${i.name ?? '-'}  ${tag}  ${i.userName ?? '-'}  (last ${i.lastSeenAt})`);
      }
      break;
    }
    const { clients, engineVersion } = await call('/api/v1/fleet') as {
      clients: Array<{ bucket: string; count: number; lastSeenAt: string }>; engineVersion: string | null;
    };
    out(clients);
    if (!values.json) {
      // The deploy's own vendored pin first, so the histogram under it reads as
      // drift-from-here rather than a bare version list.
      if (engineVersion) console.log(`this deploy serves engine ${engineVersion}`);
      for (const c of clients) console.log(`${String(c.count).padStart(6)}  ${c.bucket}  (last ${c.lastSeenAt})`);
    }
    break;
  }

  case 'retention': {
    if (sub !== 'run') fail('usage: lw retention run');
    const r = await call('/api/v1/retention/run', { method: 'POST' }) as { telemetryTrimmed: number; auditTrimmed: number; projectFilesSwept?: number; uploadsSwept?: number; approvalArtifactsRemoved?: number; documentsPurged?: number };
    out(r);
    if (!values.json) {
      console.log(`trimmed ${r.telemetryTrimmed} telemetry event(s), ${r.auditTrimmed} audit row(s)`
        + (typeof r.projectFilesSwept === 'number' ? `, swept ${r.projectFilesSwept} expired project-file upload(s)` : '')
        + (typeof r.uploadsSwept === 'number' ? ` and ${r.uploadsSwept} expired scoped upload(s)` : '')
        + (r.approvalArtifactsRemoved ? `, removed ${r.approvalArtifactsRemoved} approval request file(s) past retention` : '')
        + (typeof r.documentsPurged === 'number' ? `; purged ${r.documentsPurged} deleted document(s)` : ''));
    }
    break;
  }

  case 'users': {
    if (!['erase', 'erase-preview', 'subject-export', 'offboard-preview', 'offboard'].includes(sub ?? '')) fail('usage: lw users erase|erase-preview|subject-export|offboard-preview|offboard <id>');
    const id = positionals[2] ?? fail('usage: lw users <action> <id>');
    if (sub === 'subject-export') {
      const query = new URLSearchParams();
      for (const key of ['category', 'cursor', 'limit'] as const) if (values[key]) query.set(key, values[key]);
      out(await call(`/api/v1/users/${encodeURIComponent(id)}/subject-export?${query}`)); break;
    }
    if (sub === 'offboard-preview') { out(await call(`/api/v1/users/${encodeURIComponent(id)}/offboarding-preview`)); break; }
    if (sub === 'offboard') {
      out(await call(`/api/v1/users/${encodeURIComponent(id)}/offboard`, { method: 'POST', body: { confirmUserId: id } })); break;
    }
    if (sub === 'erase-preview') { out(await call(`/api/v1/users/${encodeURIComponent(id)}/erasure-preview`)); break; }
    const r = await call(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'DELETE' }) as { scrubbed: number };
    console.log(`erased account identity ${id} - ${r.scrubbed} telemetry event(s) de-attributed. Other retained records, audit identifiers, external copies and backups require separate review; this is not complete personal-data erasure.`);
    break;
  }

  case 'invite':
  case 'invites': {
    // Invitations (plans/74 W-ID-2): who may sign in, one address at a time.
    // Nothing is emailed; the sign-in address is printed for you to share.
    type Invitation = {
      id: string; email: string; groups: string[]; status: string; created?: boolean; reason?: string;
      createdAt: string; expiresAt: string | null; acceptedAt: string | null;
    };
    const line = (i: Invitation): string =>
      `${i.id}  ${i.email}  ${i.status}${i.groups.length ? `  groups ${i.groups.join(',')}` : ''}`
      + `${i.status === 'accepted' && i.acceptedAt ? `  accepted ${i.acceptedAt}` : i.expiresAt ? `  expires ${i.expiresAt}` : ''}`;
    if (sub === 'add') {
      const emails = positionals.slice(2);
      if (!emails.length) fail('usage: lw invite add <email...> [--group g]... [--expires <ISO date-time>]');
      const groups = (values.group ?? []).flatMap((g) => g.split(',')).map((g) => g.trim()).filter(Boolean);
      const r = await call('/api/v1/invitations', { method: 'POST', body: {
        emails, ...(groups.length ? { groups } : {}), ...(values.expires ? { expiresAt: values.expires } : {}),
      } }) as { invitations: Invitation[]; signInUrl: string };
      out(r);
      if (!values.json) {
        for (const i of r.invitations) {
          // An address that already has an account joins the groups now
          // ('applied'); 'refused' carries a reason (an existing account left
          // alone, or a new address that policy.invites does not allow).
          if (i.status === 'applied' || i.status === 'refused') {
            console.log(`${i.status.padEnd(8)}  ${i.email}${i.reason ? `  ${i.reason}` : ''}${i.status === 'applied' ? `  groups ${i.groups.join(',')}` : ''}`);
          } else console.log(`${i.created ? 'invited ' : 'existing'}  ${line(i)}`);
        }
        console.log(`share the sign-in address: ${r.signInUrl}`);
      }
      break;
    }
    if (sub === 'rm' || sub === 'revoke') {
      const id = positionals[2] ?? fail('usage: lw invite rm <id>');
      const r = await call(`/api/v1/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }) as Invitation;
      out(r);
      if (!values.json) console.log(`revoked ${r.id} (${r.email})`);
      break;
    }
    if (sub !== undefined && sub !== 'ls' && sub !== 'list') fail('usage: lw invite add <email...> [--group g] | ls [--all] | rm <id>');
    const r = await call('/api/v1/invitations') as { invitations: Invitation[]; signInUrl: string };
    const shown = values.all ? r.invitations : r.invitations.filter((i) => i.status !== 'revoked');
    out({ ...r, invitations: shown });
    if (!values.json) {
      if (!shown.length) console.log('no invitations');
      for (const i of shown) console.log(line(i));
    }
    break;
  }

  case 'domains': {
    // Partner domains (plans/82 M1 part 2b): anyone who signs in with a
    // verified address at a domain joins a programme. Proof is a DNS TXT
    // record unless --assert says otherwise, which goes in the audit.
    type Domain = {
      domain: string; status: string; proof: string; txt: { name: string; value: string }; members: number;
      verifiedAt?: string; missingSince?: string; asserted?: { by: { name: string }; at: string; reason?: string };
      rules: Array<{ programme: { id: string; name: string }; company?: { name: string }; endsAt?: string }>;
      joined?: Array<{ email: string }>; waiting?: number; moved?: Array<{ email: string }>;
    };
    const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');
    const state = (d: Domain): string => d.status === 'asserted' ? `admin-asserted by ${d.asserted?.by.name ?? '?'} on ${day(d.asserted?.at)}`
      : d.status === 'verified' ? `DNS verified ${day(d.verifiedAt)}`
        : d.status === 'paused' ? `paused: record missing since ${day(d.missingSince)}` : 'waiting for the DNS record';
    const show = (d: Domain): void => {
      console.log(`${d.domain}  ${state(d)}  ${d.members} joined`);
      for (const r of d.rules) console.log(`  -> ${r.programme.name}${r.company ? `, ${r.company.name}` : ''}${r.endsAt ? `  ends ${day(r.endsAt)}` : ''}`);
      if (d.status === 'pending' || d.status === 'paused') console.log(`  publish: ${d.txt.name}  TXT  "${d.txt.value}"`);
    };
    const name = (positionals[2] ?? '').trim();
    if (sub === 'add') {
      if (!name || !values.programme) fail('usage: lw domains add <domain> --programme <id> [--company <id>] [--ends YYYY-MM-DD] [--assert [--reason "…"]] [--dry-run]');
      const body = {
        programme: values.programme, ...(values.company ? { company: values.company } : {}), ...(values.ends ? { endsAt: values.ends } : {}),
        ...(values.assert ? { proof: 'admin', ...(values.reason ? { reason: values.reason } : {}) } : {}), ...(values['dry-run'] ? { dryRun: true } : {}),
        // Staff are only moved by name, from the dry run's list.
        ...(values['move-staff'] ? { moveStaff: values['move-staff'].split(',').map((x) => x.trim()).filter(Boolean) } : {}),
      };
      const r = await call(`/api/v1/partner-domains/${encodeURIComponent(name)}`, { method: 'PUT', body }) as Domain & { dryRun?: boolean; accounts?: Array<{ id: string; email: string; joins: boolean; later?: boolean; staff?: boolean; reason?: string }>; moved?: Array<{ email: string }> };
      out(r);
      if (!values.json) {
        if (r.dryRun) {
          console.log(`${r.domain}: ${r.accounts?.length ?? 0} account(s) here already`);
          for (const a of r.accounts ?? []) console.log(`  ${a.joins ? 'joins now  ' : a.later ? 'joins later' : a.staff ? 'staff stays' : 'does not   '}  ${a.email}${a.staff ? `  ${a.id}` : ''}${a.reason ? `  ${a.reason}` : ''}`);
          if ((r.accounts ?? []).some((a) => a.staff)) console.log('staff keep their access; to move some into the programme, add --move-staff <id,id>');
        } else {
          show(r);
          if (r.joined?.length) console.log(`joined now: ${r.joined.map((j) => j.email).join(', ')}`);
          if (r.waiting) console.log(`${r.waiting} more join at their next sign-in with a verified address`);
          if (r.moved?.length) console.log(`staff moved in as you chose: ${r.moved.map((m) => m.email).join(', ')}`);
        }
      }
      break;
    }
    if (sub === 'check') {
      if (!name) fail('usage: lw domains check <domain>');
      const r = await call(`/api/v1/partner-domains/${encodeURIComponent(name)}/check`, { method: 'POST' }) as Domain;
      out(r);
      if (!values.json) show(r);
      break;
    }
    if (sub === 'rm') {
      if (!name) fail('usage: lw domains rm <domain> [--programme <id>]');
      out(await call(`/api/v1/partner-domains/${encodeURIComponent(name)}${values.programme ? `?programme=${encodeURIComponent(values.programme)}` : ''}`, { method: 'DELETE' }));
      if (!values.json) console.log(`removed ${name}${values.programme ? ` from ${values.programme}` : ''}; people who joined through it keep their access until it ends`);
      break;
    }
    if (sub !== undefined && sub !== 'ls' && sub !== 'list') fail('usage: lw domains [ls] | add <domain> --programme <id> | check <domain> | rm <domain>');
    const r = await call(`/api/v1/partner-domains${values.programme ? `?programme=${encodeURIComponent(values.programme)}` : ''}`) as { domains: Domain[] };
    out(r);
    if (!values.json) {
      if (!r.domains.length) console.log('no partner domains');
      for (const d of r.domains) show(d);
    }
    break;
  }

  case 'folders': {
    // Provider folders per programme or company (plans/82 M1 part 2c).
    type Rule = { provider: { id: string; label: string }; path: string; company?: { name: string }; endsAt?: string; assets: number };
    const programme = values.programme ?? fail('usage: lw folders [ls] | add <provider> <path>|--whole | rm <provider> <path> --programme <id> [--company <id>] [--ends YYYY-MM-DD]');
    const at = `/api/v1/programmes/${encodeURIComponent(programme)}/folders`;
    if (sub === 'add') {
      const provider = positionals[2] ?? fail('usage: lw folders add <provider> <path> --programme <id> [--company <id>] [--ends YYYY-MM-DD]');
      // A folder is required: the whole source only with --whole, said on purpose.
      const path = values.whole ? '' : positionals[3] ?? fail('lw folders add needs a folder, such as Partners/EMEA; to give the whole source, add --whole instead');
      if (values.whole && positionals[3]) fail('give a folder or --whole, not both');
      const r = await call(at, { method: 'PUT', body: { provider, path, ...(values.whole ? { whole: true } : {}), ...(values.company ? { company: values.company } : {}), ...(values.ends ? { endsAt: values.ends } : {}) } });
      out(r);
      if (!values.json) console.log(`gave ${provider}:${path || '(all of it)'} to ${values.company ?? programme}`);
      break;
    }
    if (sub === 'rm') {
      const provider = positionals[2] ?? fail('usage: lw folders rm <provider> <path> --programme <id> [--company <id>]');
      const query = new URLSearchParams({ provider, path: positionals[3] ?? '', ...(values.company ? { company: values.company } : {}) });
      out(await call(`${at}?${query}`, { method: 'DELETE' }));
      if (!values.json) console.log(`removed ${provider}:${positionals[3] || '(all of it)'}`);
      break;
    }
    if (sub !== undefined && sub !== 'ls' && sub !== 'list') fail('usage: lw folders [ls] | add <provider> <path> | rm <provider> <path> --programme <id>');
    const r = await call(at) as { folders: Rule[]; providers: Array<{ id: string; label: string; folders: Array<{ path: string; assets: number }> }> };
    out(r);
    if (!values.json) {
      if (!r.folders.length) console.log('no folders given to this programme');
      for (const f of r.folders) console.log(`${f.provider.id}:${f.path || '(all of it)'}  ${f.company ? f.company.name : 'whole programme'}  ${f.assets} asset(s)${f.endsAt ? `  ends ${f.endsAt.slice(0, 10)}` : ''}`);
    }
    break;
  }

  case 'people': {
    // Adding and ending partner programme people in bulk (plans/82 M1 part 2).
    // Both preview unless --apply is given.
    if (sub === 'import') {
      const programme = positionals[2];
      const file = positionals[3];
      if (!programme || !file) fail('usage: lw people import <programme> <file.csv|-> [--apply]');
      const text = readFileSync(file === '-' ? 0 : file, 'utf8');
      const r = await call(`/api/v1/programmes/${encodeURIComponent(programme)}/people`, { method: 'POST', body: { text, ...(values.apply ? { apply: true } : {}) } }) as {
        dryRun: boolean; summary: Record<string, number>; message?: string;
        rows: Array<{ line: number; email: string; status: string; result?: string; reason?: string }>;
      };
      out(r);
      if (!values.json) {
        for (const row of r.rows) console.log(`${String(row.line).padStart(4)}  ${(row.result ?? row.status).padEnd(9)}  ${row.email}${row.reason ? `  ${row.reason}` : ''}`);
        console.log(Object.entries(r.summary).map(([k, v]) => `${v} ${k}`).join(', '));
        if (r.dryRun) console.log('preview only: run again with --apply to do it');
        if (r.message) console.log(`\nsend everyone invited this message:\n${r.message}`);
      }
      break;
    }
    if (sub === 'exit') {
      const list = positionals[2];
      const pick = values.programme ? { programme: values.programme } : values.company ? { company: values.company } : values.domain ? { domain: values.domain }
        : list ? { emails: readFileSync(list === '-' ? 0 : list, 'utf8').split(/[\s,;]+/).filter(Boolean) } : null;
      if (!pick) fail('usage: lw people exit --programme <id> | --company <id> | --domain <d> | <emails-file> [--projects team-readonly|me-readonly|me|keep] [--at YYYY-MM-DD [--no-notice]] [--apply]');
      const r = await call('/api/v1/programmes/exit', { method: 'POST', body: {
        ...pick, ...(values.projects ? { projects: values.projects } : {}), ...(values.at ? { at: values.at } : {}), ...(values['no-notice'] ? { notice: false } : {}),
        ...(values.apply ? { apply: true } : {}),
      } }) as {
        scheduled?: boolean; endsAt?: string; notice?: boolean;
        dryRun: boolean; exit?: string; accounts: Array<{ email?: string; id: string; projects: unknown; links?: number }>; skipped: Array<{ email: string; reason: string }>;
        stays?: Array<{ email: string; stays: string[] }>; cannotEnd?: Array<{ email: string; reason: string }>; notEnded?: Array<{ email: string; reason: string }>;
        pendingInvitations?: unknown[]; invitationsRevoked?: number; domainRules?: Array<{ domain: string; programme: { name: string } }>;
        tokens?: Array<{ id: string; label: string }>; tokensRevoked?: number;
        templates?: Array<{ id: string; name: string; action: 'retire' | 'narrow' }>;
        folders?: Array<{ provider: string; path: string }>; foldersEnded?: number;
        rightsChoices?: Array<{ assetId: string; group: string }>; rightsChoicesWithdrawn?: number;
        alreadyEnded?: { at: string }; ended?: { programme?: string; companies: string[] };
      };
      out(r);
      if (!values.json && r.scheduled) {
        console.log(`scheduled ${r.exit}: ends ${r.endsAt}${r.notice ? '; they are told 14 days and 1 day before' : '; nobody is told before'}`);
        break;
      }
      if (!values.json) {
        const verb = (now: string, then: string) => (r.dryRun ? now : then).padEnd(9);
        if (r.dryRun && r.endsAt) console.log(`ends on ${r.endsAt.slice(0, 10)} at the end of the day (UTC)${r.notice ? ', told 14 days and 1 day before' : ''}`);
        if (r.alreadyEnded) console.log(`already ended on ${r.alreadyEnded.at.slice(0, 10)}; this ends what is left`);
        for (const a of r.accounts) console.log(`${verb('ends', 'ended')} ${a.email ?? a.id}`);
        for (const a of r.stays ?? []) console.log(`${verb('stays', 'stays')} ${a.email}  leaves this one, also in ${a.stays.join(', ')}`);
        for (const a of [...(r.cannotEnd ?? []), ...(r.notEnded ?? [])]) console.log(`${verb('not ended', 'not ended')} ${a.email}  ${a.reason}`);
        for (const s2 of r.skipped) console.log(`${'left'.padEnd(9)} ${s2.email}  ${s2.reason}`);
        for (const d of r.domainRules ?? []) console.log(`${verb('withdraws', 'withdrew')} ${d.domain} (${d.programme.name})`);
        for (const t of r.tokens ?? []) console.log(`${verb('revokes', 'revoked')} token ${t.id} (${t.label})`);
        for (const t of r.templates ?? []) console.log(`${t.action === 'retire' ? verb('retires', 'retired') : verb('narrows', 'narrowed')} template ${t.name}`);
        for (const f of r.folders ?? []) console.log(`${verb('ends', 'ended')} folder ${f.provider}/${f.path || '(all of it)'}`);
        for (const c of r.rightsChoices ?? []) console.log(`${verb('withdraws', 'withdrew')} share anyway ${c.assetId} for ${c.group}`);
        if (!r.dryRun && r.tokensRevoked) console.log(`${r.tokensRevoked} service token(s) revoked`);
        if (!r.dryRun && r.foldersEnded) console.log(`${r.foldersEnded} folder rule(s) ended`);
        if (!r.dryRun && r.rightsChoicesWithdrawn) console.log(`${r.rightsChoicesWithdrawn} share-anyway choice(s) withdrawn`);
        if (!r.dryRun && r.ended && (r.ended.programme || r.ended.companies.length)) console.log(`ended: ${[r.ended.programme, ...r.ended.companies].filter(Boolean).join(', ')}`);
        console.log(r.dryRun ? `${r.pendingInvitations?.length ?? 0} open invitation(s) would be revoked; run again with --apply to end access` : `${r.invitationsRevoked ?? 0} open invitation(s) revoked; receipt ${r.exit}`);
      }
      break;
    }
    if (sub === 'exits') {
      const programme = positionals[2];
      if (!programme) fail('usage: lw people exits <programme>');
      const r = await call(`/api/v1/programmes/${encodeURIComponent(programme)}/exits`) as {
        exits: Array<{ id: string; state: string; selection: Record<string, unknown>; doneAt?: string; createdAt: string; counts?: Record<string, number>; reopen: { offered: boolean; until?: string } }>;
      };
      out(r);
      if (!values.json) {
        for (const e of r.exits) {
          const what = Object.entries(e.selection).map(([k, v]) => `${k} ${Array.isArray(v) ? `${v.length} addresses` : v}`).join(', ');
          const when = (e.doneAt ?? e.createdAt).slice(0, 10);
          const reopen = e.reopen.offered ? `reopen until ${e.reopen.until?.slice(0, 10)}` : '';
          console.log(`${e.id}  ${e.state.padEnd(9)} ${when}  ${what}${e.counts ? `  ${e.counts.ended} ended, ${e.counts.stays} stayed` : ''}  ${reopen}`);
        }
      }
      break;
    }
    if (sub === 'reopen') {
      const id = positionals[2];
      if (!id) fail('usage: lw people reopen <exit> [--keep-projects] [--apply]');
      const r = await call(`/api/v1/programmes/exits/${encodeURIComponent(id)}/reopen`, { method: 'POST', body: { ...(values['keep-projects'] ? { projects: false } : {}), ...(values.apply ? { apply: true } : {}) } }) as {
        dryRun: boolean; accounts: Array<{ email: string; result: string; reason?: string }>; projects: Array<{ name: string; result: string }>;
        templates: Array<{ name: string; result: string }>; folders: Array<{ provider: string; path: string; result: string }>;
        domainRules: Array<{ domain: string; result: string }>; reopened: { programme?: string; companies: string[] };
        stayEnded: { tokens: number; links: number; rightsChoices: unknown[] };
      };
      out(r);
      if (!values.json) {
        for (const a of r.accounts) console.log(`${a.result.padEnd(13)} ${a.email}${a.reason ? `  ${a.reason}` : ''}`);
        for (const p of r.projects) console.log(`${p.result.padEnd(13)} project ${p.name}`);
        for (const t of r.templates) console.log(`${t.result.padEnd(13)} template ${t.name}`);
        for (const f of r.folders) console.log(`${f.result.padEnd(13)} folder ${f.provider}/${f.path || '(all of it)'}`);
        for (const d of r.domainRules) console.log(`${d.result.padEnd(13)} domain ${d.domain}`);
        console.log(`stays ended: ${r.stayEnded.tokens} token(s), ${r.stayEnded.links} link(s), ${r.stayEnded.rightsChoices.length} share-anyway choice(s), every session`);
        console.log(r.dryRun ? 'preview only: run again with --apply to reopen' : `reopened ${[r.reopened.programme, ...r.reopened.companies].filter(Boolean).join(', ') || 'the people'}`);
      }
      break;
    }
    fail('usage: lw people import <programme> <file> [--apply] | exit --programme|--company|--domain … [--apply] | exits <programme> | reopen <exit> [--apply]');
  }

  case 'brand-pages': {
    await runBrandPages(sub, positionals[2], {
      values: values as Record<string, unknown>, base, stateDir: join(CONFIG_DIR, 'uploads'),
      headers: () => {
        const cookie = savedCookie(), bearer = values.token ?? process.env.LW_TOKEN;
        return { ...(bearer ? { authorization: `Bearer ${bearer}` } : cookie ? { cookie } : {}), 'x-lolly-client': 'lw-cli engine/0' };
      },
      call, fail, log: (line) => console.log(line), out,
      progress: values.json ? undefined : (sent, total) => process.stderr.write(`\r${Math.floor((sent / total) * 100)}% of ${total} bytes${sent === total ? '\n' : ''}`),
    });
    break;
  }

  case 'intent': {
    const file = positionals[2];
    if (sub !== 'resolve' || !file) fail('usage: lw intent resolve <intent.json|-> [--json]');
    let body: unknown;
    try { body = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')); }
    catch { fail(`cannot read intent JSON: ${file}`); }
    const answer = await call('/api/v1/intents/resolve', { method: 'POST', body }) as IntentAnswer;
    out(answer);
    if (!values.json) printIntentAnswer(answer);
    // The same exit codes as `lolly intent`: 4 says a surface is not ready, with the full answer either way.
    if (answer.outcome !== 'ready') process.exitCode = 4;
    break;
  }

  case 'render-api': {
    await runRenderApi(sub, { values: values as Record<string, unknown>, call, response, fail, log: (line) => console.log(line), env: process.env });
    break;
  }

  case 'mcp': {
    // Prints settings only: no request, and the token itself is never read or printed.
    if (sub !== 'config') fail('usage: lw mcp config [--name lolly-work] [--token-env LW_TOKEN] [--json]');
    const name = values.name ?? 'lolly-work';
    const tokenEnv = values['token-env'] ?? 'LW_TOKEN';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) fail('--token-env must be an environment variable name');
    const endpoint = `${base}/api/v1/mcp`;
    const settings = { mcpServers: { [name]: { url: endpoint, headers: { Authorization: `Bearer \${env:${tokenEnv}}` } } } };
    if (values.json) { console.log(JSON.stringify(settings, null, 2)); break; }
    console.log(`Put a service token in ${tokenEnv}. These settings name the variable and never hold the token.\n`);
    console.log('Claude Code:');
    console.log(`  claude mcp add --transport http ${name} ${endpoint} --header "Authorization: Bearer $${tokenEnv}"\n`);
    console.log('Other clients (.cursor/mcp.json, for example):');
    console.log(JSON.stringify(settings, null, 2));
    break;
  }

  case 'companies': {
    if (sub === 'kit') {
      const usage = 'usage: lw companies kit show|import|set|remove <programme> <company> [file] [--from tokens|lolly|logos] [--json]';
      const verb = positionals[2];
      const programme = positionals[3];
      const company = positionals[4];
      if (!verb || !programme || !company || !['show', 'import', 'set', 'remove'].includes(verb)) fail(usage);
      const at = `/api/v1/programmes/${encodeURIComponent(programme)}/companies/${encodeURIComponent(company)}/kit`;
      type KitView = { assetId?: string; revision?: number; kit?: { label: string; colours: unknown[] } | null;
        source?: { kind: string; reference?: string }; pending?: { approvalId: string; action?: 'save' | 'remove' } };
      const showKit = (r: KitView): void => {
        if (values.json) return;
        if (r.kit) console.log(`${r.kit.label}  ${r.assetId}  revision ${r.revision}${r.source ? `  from ${r.source.reference ?? r.source.kind}` : ''}`);
        if (r.pending) console.log(`kit change waiting for approval ${r.pending.approvalId}`);
      };
      if (verb === 'show' || verb === 'remove') {
        if (positionals.length !== 5) fail(usage);
        const r = await call(at, { method: verb === 'show' ? 'GET' : 'DELETE' }) as KitView;
        out(r);
        showKit(r);
        if (!values.json && verb === 'remove' && !r.pending) console.log(`removed the kit for ${company}`);
        break;
      }
      const file = positionals[5];
      if (verb === 'set') {
        if (!file || positionals.length !== 6) fail(usage);
        let body: unknown;
        try { body = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('the kit file must contain valid JSON'); }
        const r = await call(at, { method: 'PUT', body }) as KitView;
        out(r);
        showKit(r);
        break;
      }
      const from = values.from;
      if (!from || !['tokens', 'lolly', 'logos'].includes(from) || (from === 'logos' ? positionals.length !== 5 : !file || positionals.length !== 6)) fail(usage);
      const bytes = file ? readFileSync(file) : Buffer.alloc(0);
      const sent = await fetch(`${base}${at}/import?from=${from}${file ? `&name=${encodeURIComponent(basename(file))}` : ''}`, {
        method: 'POST', headers: { ...(values.token ?? process.env.LW_TOKEN ? { authorization: `Bearer ${values.token ?? process.env.LW_TOKEN}` } : savedCookie() ? { cookie: savedCookie()! } : {}),
          'content-type': 'application/octet-stream', 'x-lolly-client': 'lw-cli engine/0' },
        body: new Uint8Array(bytes),
      });
      const r = await sent.json() as { kit: KitView['kit']; warnings?: string[]; error?: { code: string; message: string } };
      if (!sent.ok) fail(`${sent.status} ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim());
      out(r);
      if (!values.json) {
        console.log(JSON.stringify(r.kit, null, 2));
        for (const warning of r.warnings ?? []) console.error(`warning: ${warning}`);
      }
      break;
    }
    if (sub !== 'profile') {
      const usage = 'usage: lw companies [ls] <programme> | add <programme> <company> --name "…" | rm <programme> <company>';
      const editing = sub === 'add' || sub === 'rm';
      const programme = editing || sub === 'ls' || sub === 'list' ? positionals[2] : sub;
      if (!programme || positionals.length !== (editing ? 4 : sub === 'ls' || sub === 'list' ? 3 : 2)) fail(usage);
      const at = `/api/v1/programmes/${encodeURIComponent(programme)}`;
      type Company = { id: string; name: string; endedAt?: string };
      if (editing) {
        const company = positionals[3] ?? fail(usage);
        if (sub === 'add' && !values.name) fail(usage);
        const r = await call(`${at}/companies/${encodeURIComponent(company)}`, {
          method: sub === 'add' ? 'PUT' : 'DELETE',
          ...(sub === 'add' ? { body: { name: values.name } } : {}),
        }) as Company;
        out(r);
        if (!values.json) console.log(sub === 'add' ? `${r.id}  ${r.name}` : `removed ${company} from ${programme}`);
      } else {
        const r = await call(`${at}/people`) as { companies: Company[] };
        out(r.companies);
        if (!values.json) {
          if (!r.companies.length) console.log('no companies in this programme');
          for (const c of r.companies) console.log(`${c.id}  ${c.name}${c.endedAt ? `  ended ${c.endedAt.slice(0, 10)}` : ''}`);
        }
      }
      break;
    }
    // A partner company's profile (plans/82 M3): the logos and details every
    // piece made for it carries, set up once by the brand team.
    const usage = 'usage: lw companies profile show|history|set|logo|settings <programme> <company> …';
    const verb = positionals[2];
    const programme = positionals[3];
    const company = positionals[4];
    if (!verb || !programme || !company) fail(usage);
    const at = `/api/v1/programmes/${encodeURIComponent(programme)}/companies/${encodeURIComponent(company)}/profile`;
    type View = { company: { name: string }; programme: { name: string }; revision: number; profile: Record<string, unknown>;
      logos: Record<string, { id: string; format: string; version: number }>; settings?: { editors: Array<{ email: string }>; approvalChain: string | null; kitApprovalChain: string | null } };
    const show = (v: View): void => {
      if (values.json) return;
      console.log(`${v.company.name} (${v.programme.name})  revision ${v.revision}`);
      for (const s2 of ['light', 'dark', 'mark']) {
        const l = v.logos[s2];
        console.log(`  logo ${s2.padEnd(5)}  ${l ? `${l.id} v${l.version} ${l.format}` : '-'}`);
      }
      const p = v.profile as { website?: string; contact?: Record<string, string>; address?: string; currency?: string; taxNote?: string };
      console.log(`  website     ${p.website ?? '-'}`);
      console.log(`  contact     ${p.contact ? [p.contact.name, p.contact.email, p.contact.phone].filter(Boolean).join(', ') : '-'}`);
      console.log(`  address     ${p.address ? p.address.replace(/\n/g, ' / ') : '-'}`);
      console.log(`  currency    ${p.currency ?? '-'}`);
      console.log(`  tax note    ${p.taxNote ?? '-'}`);
      if (v.settings) console.log(`  contacts who may edit: ${v.settings.editors.map((e) => e.email).join(', ') || 'none'}; their changes ${v.settings.approvalChain ? `wait for ${v.settings.approvalChain}` : 'apply at once'}`);
      if (v.settings) console.log(`  kit changes ${v.settings.kitApprovalChain ? `wait for ${v.settings.kitApprovalChain}` : 'apply at once'}`);
    };
    if (verb === 'show') {
      const v = await call(at) as View;
      out(v); show(v);
      break;
    }
    if (verb === 'history') {
      const r = await call(`${at}/history`) as { revisions: Array<{ revision: number; updatedBy: string; updatedAt: string; fields: string[] }> };
      out(r);
      if (!values.json) for (const row of r.revisions) console.log(`${String(row.revision).padStart(4)}  ${row.updatedAt.slice(0, 19)}  ${row.updatedBy}  ${row.fields.join(', ')}`);
      break;
    }
    if (verb === 'set') {
      // --field website=… --field contact.email=… ; an empty value clears one.
      const body: Record<string, unknown> = {};
      const contact: Record<string, string | null> = {};
      for (const pair of values.field ?? []) {
        const eq = pair.indexOf('=');
        if (eq < 1) fail(`--field takes key=value, got ${pair}`);
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).replace(/\\n/g, '\n');
        if (key.startsWith('contact.')) contact[key.slice('contact.'.length)] = value || null;
        else if (['website', 'address', 'currency', 'taxNote'].includes(key)) body[key] = value || null;
        else fail(`unknown field ${key}: website, contact.name, contact.email, contact.phone, address, currency, taxNote`);
      }
      if (Object.keys(contact).length) {
        const current = ((await call(at)) as View).profile.contact as Record<string, string> | undefined;
        body.contact = { ...current, ...contact };
      }
      if (values.name) body.name = values.name;
      if (!Object.keys(body).length) fail('usage: lw companies profile set <programme> <company> --field website=https://… [--field contact.email=…] [--name "…"]');
      const v = await call(at, { method: 'PUT', body }) as View;
      out(v); show(v);
      break;
    }
    if (verb === 'logo') {
      const surface = positionals[5];
      if (!surface || !['light', 'dark', 'mark'].includes(surface)) fail('usage: lw companies profile logo <programme> <company> <light|dark|mark> <file.svg|file.png> [--dry-run] | --rm');
      if (values.rm) {
        const v = await call(`${at}/logo?surface=${surface}`, { method: 'DELETE' }) as View;
        out(v);
        if (!values.json) console.log(`removed the ${surface} logo; revision ${v.revision}`);
        break;
      }
      const file = positionals[6] ?? fail('name the logo file');
      const bytes = readFileSync(file);
      const sent = await fetch(`${base}${at}/logo?surface=${surface}${values['dry-run'] ? '&dryRun=1' : ''}`, {
        method: 'POST', headers: { ...(values.token ?? process.env.LW_TOKEN ? { authorization: `Bearer ${values.token ?? process.env.LW_TOKEN}` } : savedCookie() ? { cookie: savedCookie()! } : {}),
          'content-type': contentTypeOf(file), 'x-lolly-client': 'lw-cli engine/0' },
        body: new Uint8Array(bytes),
      });
      const r = await sent.json() as { dryRun: boolean; warnings?: Array<{ message: string }>; asset?: { id: string; version: number }; profile?: { revision: number }; error?: { code: string; message: string } };
      if (!sent.ok) fail(`${sent.status} ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim());
      out(r);
      if (!values.json) {
        for (const w of r.warnings ?? []) console.log(`warning: ${w.message}`);
        console.log(r.dryRun ? `checked ${file}: it would be accepted${r.warnings?.length ? ' with the warnings above' : ''}` : `stored as ${r.asset!.id} v${r.asset!.version}; revision ${r.profile!.revision}`);
      }
      break;
    }
    if (verb === 'settings') {
      const body: Record<string, unknown> = {};
      if (values.editors !== undefined) body.editors = values.editors === 'none' ? [] : values.editors.split(',').map((e) => e.trim()).filter(Boolean);
      if (values.chain !== undefined) body.approvalChain = values.chain === 'none' ? null : values.chain;
      if (values['kit-chain'] !== undefined) body.kitApprovalChain = values['kit-chain'] === 'none' ? null : values['kit-chain'];
      if (!Object.keys(body).length) fail('usage: lw companies profile settings <programme> <company> [--editors <email,…>|none] [--chain <chain-id>|none] [--kit-chain <id>|none]');
      const v = await call(`${at}/settings`, { method: 'PUT', body }) as View;
      out(v); show(v);
      break;
    }
    fail(usage);
  }

  case 'programmes': {
    // Partner programmes (plans/82). `limits` is what every token placed in one
    // takes unless it states its own (M7): with no flag, the figures and sources.
    const usage = 'usage: lw programmes [ls] | show <id> | create <id> --name "…" | set <id> [--name "…"] [--description "…"] [--team <group>] [--tools a,b] | rm <id> | limits <id> | usage <id> | rights-report <id>';
    if (sub === 'rights-report') {
      // The licence report for one programme (plans/82 M4): what the licence gate
      // would let through and hold back, by source, and the links made by staff
      // that would lose files. Read-only.
      const programme = positionals[2] ?? fail('usage: lw programmes rights-report <programme> [--json]');
      type Row = { label: string; assets: number; exempt: number; sharedAnyway?: number; travel: { count: number; byLicence: Array<{ licence: string; count: number }> };
        held: { count: number; byReason: Array<{ label: string; count: number }> } };
      const r = await call(`/api/v1/programmes/${encodeURIComponent(programme)}/rights-report`) as {
        programme: { name: string }; rules: string; mode?: { mode: string; line: string };
        totals: { assets: number; travel: number; held: number; exempt: number; sharedAnyway?: number; needsChoosing?: number }; sources: Row[];
        links: { count: number; files: number; links: Array<{ id: string; target: { name: string }; createdBy: { name: string }; held: number; files: number }>; more: number };
      };
      out(r);
      if (!values.json) {
        const t = r.totals;
        if (r.mode) console.log(r.mode.line);
        const held = r.mode?.mode === 'gate' ? 'held back' : 'would be held back';
        console.log(`${r.programme.name}: ${t.assets} file(s); ${t.travel} travel, ${t.held} ${held}, ${t.sharedAnyway ?? 0} shared anyway, ${t.needsChoosing ?? 0} need choosing again, ${t.exempt} exempt (${r.rules})`);
        for (const row of r.sources) {
          const parts = [
            ...row.travel.byLicence.map((l) => `travel ${l.count}: ${l.licence}`),
            ...(row.sharedAnyway ? [`shared anyway ${row.sharedAnyway}`] : []),
            ...row.held.byReason.map((h) => `held ${h.count}: ${h.label}`),
            ...(row.exempt ? [`exempt ${row.exempt}`] : []),
          ];
          console.log(`  ${row.label}  ${row.assets}  ${parts.join('; ')}`);
        }
        console.log(`links made by staff that would lose files: ${r.links.count}${r.links.count ? ` (${r.links.files} file(s))` : ''}`);
        for (const l of r.links.links) console.log(`  ${l.id}  ${l.target.name}  by ${l.createdBy.name}  loses ${l.held} of ${l.files}`);
        if (r.links.more) console.log(`  and ${r.links.more} more`);
      }
      break;
    }
    type Programme = { id: string; name: string; description?: string; group: string; team?: string; tools: string[]; collections: unknown[]; members: unknown[]; endedAt?: string };
    const show = (p: Programme): void => {
      if (values.json) return;
      console.log(`${p.id}  ${p.name}  ${p.group}${p.endedAt ? `  ended ${p.endedAt.slice(0, 10)}` : ''}`);
      if (p.description) console.log(`  ${p.description}`);
      console.log(`  team ${p.team ?? '-'}  tools ${p.tools.join(', ') || '-'}  ${p.collections.length} collection(s)  ${p.members.length} member(s)`);
    };
    if (sub === undefined || sub === 'ls' || sub === 'list') {
      if (positionals.length > (sub ? 2 : 1)) fail(usage);
      const r = await call('/api/v1/programmes') as { programmes: Programme[] };
      out(r);
      if (!values.json) {
        if (!r.programmes.length) console.log('no partner programmes');
        for (const p of r.programmes) console.log(`${p.id}  ${p.name}  ${p.tools.length} tool(s)  ${p.members.length} member(s)${p.endedAt ? '  ended' : ''}`);
      }
      break;
    }
    if (sub === 'show' || sub === 'create' || sub === 'set' || sub === 'rm') {
      const id = positionals[2];
      if (!id || positionals.length !== 3) fail(usage);
      const at = `/api/v1/programmes/${encodeURIComponent(id)}`;
      if (sub === 'rm') {
        out(await call(at, { method: 'DELETE' }));
        if (!values.json) console.log(`removed programme ${id}`);
        break;
      }
      if (sub === 'show') {
        const r = await call(at) as Programme;
        out(r); show(r);
        break;
      }
      if (sub === 'create' && !values.name) fail('usage: lw programmes create <id> --name "…" [--description "…"] [--team <group>] [--tools a,b]');
      if (sub === 'set' && !(['name', 'description', 'team', 'tools'] as const).some((key) => values[key] !== undefined)) fail('nothing to change: name --name, --description, --team or --tools');
      // The route requires a name and replaces the description on every save.
      const current = sub === 'set' ? await call(at) as Programme : undefined;
      const body: Record<string, unknown> = current ? { name: current.name, description: current.description } : {};
      for (const key of ['name', 'description', 'team'] as const) if (values[key] !== undefined) body[key] = values[key];
      if (values.tools !== undefined) body.tools = values.tools.split(',').map((t) => t.trim()).filter(Boolean);
      const r = await call(at, { method: 'PUT', body }) as Programme;
      out(r); show(r);
      break;
    }
    if (sub === 'usage') {
      // What the programme's tokens did, counted (M7): counts only, never an input or a prompt.
      const id = positionals[2] ?? fail(usage);
      const q = new URLSearchParams();
      for (const key of ['from', 'to', 'by'] as const) if (values[key]) q.set(key, String(values[key]));
      if (positionals[3]) q.set('token', positionals[3]);
      if (values.csv) q.set('format', 'csv');
      const at = `/api/v1/programmes/${encodeURIComponent(id)}/usage${q.size ? `?${q}` : ''}`;
      if (values.csv) { process.stdout.write(await (await response(at)).text()); break; }
      type Cells = { calls: number; renders: number; batches: { count: number; rows: number }; approvals: { open: number; approved: number; rejected: number }; refusals: Record<string, number> };
      const r = await call(at) as { from: string; to: string; by: string; tokens: Array<{ id: string; label: string; company: string | null; totals: Cells; periods: Array<{ period: string } & Cells> }>; totals: Cells };
      out(r);
      if (!values.json) {
        const refused = (c: Cells) => Object.values(c.refusals).reduce((n, v) => n + v, 0);
        const line = (c: Cells) => `${c.calls} calls, ${c.renders} renders, ${c.batches.count} batches (${c.batches.rows} rows), ${c.approvals.open + c.approvals.approved + c.approvals.rejected} approval requests, ${refused(c)} refused`;
        console.log(`${id}, ${r.from} to ${r.to} by ${r.by}: ${line(r.totals)}`);
        for (const t of r.tokens) {
          console.log(`  ${t.id}  ${t.label}${t.company ? `  company ${t.company}` : ''}: ${line(t.totals)}`);
          for (const p of t.periods) console.log(`    ${p.period}  ${line(p)}`);
        }
      }
      break;
    }
    if (sub !== 'limits') fail(usage);
    const id = positionals[2] ?? fail(usage);
    type ProgrammeLimitView = { id: string; name: string; tokenLimits?: LimitFigures; tokenLimitDefaults?: { limits: Record<string, number | null>; sources: Record<string, string> } };
    const at = `/api/v1/programmes/${encodeURIComponent(id)}`;
    const current = await call(at) as ProgrammeLimitView;
    const next = limitFlags(current.tokenLimits ?? {});
    const shown = next ? await call(at, { method: 'PUT', body: { name: current.name, tokenLimits: next } }) as ProgrammeLimitView : current;
    out(shown);
    if (!values.json) {
      console.log(`${shown.id}  ${shown.name}: every token placed here takes these unless it states its own`);
      if (shown.tokenLimitDefaults) printLimits(shown.tokenLimitDefaults.limits, shown.tokenLimitDefaults.sources);
    }
    break;
  }

  case 'templates': {
    const usage = 'usage: lw templates [ls] <programme> | publish <programme> --from <inst/id> --groups g1,g2 | upload <programme> <file.lolly> --groups g1,g2 | set <programme> <asset> [--groups …] [--editable …|all] [--bindings …] | retire <programme> <asset> [--replaced-by <asset>] | restore <programme> <asset> | only <programme> <tool> on|off';
    const verbs = ['publish', 'upload', 'set', 'retire', 'restore', 'only'];
    const editing = sub !== undefined && verbs.includes(sub);
    const programme = editing || sub === 'ls' || sub === 'list' ? positionals[2] : sub;
    if (!programme) fail(usage);
    const at = `/api/v1/programmes/${encodeURIComponent(programme)}`;
    const list = (raw: string) => raw.split(',').map((s) => s.trim()).filter(Boolean);
    const rules = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {};
      if (values.groups !== undefined) body.groups = list(values.groups);
      if (values.editable !== undefined) body.editable = values.editable === 'all' ? null : list(values.editable);
      if (values.bindings !== undefined) {
        body.bindings = Object.fromEntries(list(values.bindings).map((pair) => {
          const eq = pair.indexOf('=');
          const input = pair.slice(0, eq).trim();
          const field = pair.slice(eq + 1).trim();
          if (eq < 1 || !input || !field) fail(`--bindings takes input=field pairs, got ${pair}`);
          return [input, field];
        }));
      }
      return body;
    };
    if (!editing) {
      if (positionals.length !== (sub === 'ls' || sub === 'list' ? 3 : 2)) fail(usage);
      const r = await call(`${at}/templates`) as { templatesOnly: string[]; templates: Array<{ id: string; name: string; toolName: string; groups: string[]; editable: string[] | null; version: number; state: string; retired?: { replacedBy?: string } }> };
      out(r);
      if (!values.json) {
        if (r.templatesOnly.length) console.log(`templates only: ${r.templatesOnly.join(', ')}`);
        if (!r.templates.length) console.log('no templates published to this programme');
        for (const t of r.templates) console.log(`${t.id}  ${t.name}  ${t.toolName}  v${t.version}  [${t.retired ? 'retired' : t.state}]  ${t.groups.join(', ')}  editable ${t.editable === null ? 'all' : t.editable.join(', ') || 'none'}`);
      }
      break;
    }
    if (sub === 'only') {
      const tool = positionals[3];
      const state = positionals[4];
      if (!tool || (state !== 'on' && state !== 'off') || positionals.length !== 5) fail(usage);
      const r = await call(`${at}/templates-only/${encodeURIComponent(tool)}`, { method: 'PUT', body: { on: state === 'on' } }) as { programme: string; toolId: string; on: boolean };
      out(r);
      if (!values.json) console.log(`${r.programme}  ${r.toolId}  templates only ${r.on ? 'on' : 'off'}`);
      break;
    }
    let r: { id: string; groups?: string[]; state?: string; replacedBy?: string };
    if (sub === 'publish') {
      if (positionals.length !== 3 || !values.from || !values.groups) fail(usage);
      r = await call(`${at}/templates`, { method: 'POST', body: { from: values.from, ...rules() } }) as typeof r;
    } else if (sub === 'upload') {
      const file = positionals[3];
      if (!file || positionals.length !== 4 || !values.groups) fail(usage);
      let bytes: Buffer;
      try { bytes = readFileSync(file); } catch { fail(`cannot read ${file}`); }
      const q = new URLSearchParams({ groups: list(values.groups).join(',') });
      r = await call(`${at}/templates/rules-file?${q}`, { method: 'POST', body: bytes }) as typeof r;
    } else {
      const asset = positionals[3];
      if (!asset || positionals.length !== 4) fail(usage);
      const assetAt = `${at}/templates/${encodeURIComponent(asset.replace(/^inst\//, ''))}`;
      if (sub === 'set') {
        const body = rules();
        if (!Object.keys(body).length) fail('nothing to change: name --groups, --editable or --bindings');
        r = await call(assetAt, { method: 'PUT', body }) as typeof r;
      } else if (sub === 'retire') {
        r = await call(`${assetAt}/retire`, { method: 'POST', body: { ...(values['replaced-by'] !== undefined ? { replacedBy: values['replaced-by'] } : {}) } }) as typeof r;
      } else {
        r = await call(`${assetAt}/restore`, { method: 'POST' }) as typeof r;
      }
    }
    out(r);
    if (!values.json) console.log(`${r.id}  ${sub === 'publish' ? 'published' : sub === 'upload' ? 'uploaded' : sub === 'set' ? 'updated' : sub === 'retire' ? 'retired' : 'restored'}${r.state ? `  [${r.state}]` : ''}${r.groups ? `  ${r.groups.join(', ')}` : ''}${r.replacedBy ? `  replaced by ${r.replacedBy}` : ''}`);
    break;
  }

  case 'tokens': {
    // Service tokens (plans/35 wave 2): automation identity, owner-minted.
    // With --programme, the same verbs act through that programme's manager
    // routes (plans/82 M7): a partner agent's token, issued and revoked there.
    const programmeAt = values.programme ? `/api/v1/programmes/${encodeURIComponent(values.programme)}/tokens` : null;
    type ProgrammeTokenRow = { id: string; label: string; company: string | null; scopes: string[] | null; tools: string[] | null; createdAt: string; expiresAt: string | null;
      lastUsedAt: string | null; revokedAt: string | null; live: boolean; expired: boolean; expiring: boolean; limits: Record<string, number | null>; limitSources: Record<string, string>;
      limitOverrides: LimitFigures; usage: { today: { calls: number; renders: number; busiestMinute: number }; month: { renders: number }; week: { rateLimited: number; budgetRefused: number }; lastRefusal: { at: string; code: string } | null } };
    if (programmeAt && (sub === 'add' || sub === 'create')) {
      const label = values.label ?? fail('usage: lw tokens add --programme <id> [--company <id>] --label "…" [--scopes render,catalog.read] [--tools a,b] [--ttl-days 90]');
      const list = (raw: string | undefined) => raw?.split(',').map((item) => item.trim()).filter(Boolean);
      const scopes = list(values.scopes), tools = list(values.tools), limits = limitFlags({});
      const ttl = values['ttl-days'] ?? values.days;
      const t = await call(programmeAt, { method: 'POST', body: { label, ...(values.company ? { company: values.company } : {}), ...(scopes ? { scopes } : {}), ...(tools ? { tools } : {}),
        ...(ttl ? { ttlDays: Number(ttl) } : {}), ...(limits ? { limits } : {}) } }) as ProgrammeTokenRow & { token: string; programme: string };
      out(t);
      if (!values.json) {
        console.log(`${t.id}  ${t.label}  programme ${t.programme}${t.company ? `/${t.company}` : ''}  scopes ${(t.scopes ?? []).join(',')}${t.tools ? `  tools ${t.tools.join(',')}` : ''}  expires ${t.expiresAt}`);
        printLimits(t.limits, t.limitSources);
        console.log(`token (shown once, hand it to the partner now): ${t.token}`);
      }
      break;
    }
    if (programmeAt && sub === 'revoke') {
      const id = positionals[2] ?? fail('usage: lw tokens revoke <id> --programme <id>');
      await call(`${programmeAt}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      console.log(`revoked ${id}`);
      break;
    }
    if (programmeAt && sub === 'limits') {
      const id = positionals[2] ?? fail('usage: lw tokens limits <id> --programme <id> [--calls-per-minute <n>|none|default] [--renders-per-day …] [--renders-per-month …]');
      const { tokens } = await call(values.company ? `${programmeAt}?company=${encodeURIComponent(values.company)}` : programmeAt) as { tokens: ProgrammeTokenRow[] };
      const current = tokens.find((t) => t.id === id) ?? fail(`no token ${id} in programme ${values.programme}`);
      const next = limitFlags(current.limitOverrides ?? {});
      const shown = next ? await call(`${programmeAt}/${encodeURIComponent(id)}`, { method: 'PUT', body: { limits: next } }) as ProgrammeTokenRow : current;
      out(shown);
      if (!values.json) {
        console.log(`${shown.id}  ${shown.label}`);
        printLimits(shown.limits, shown.limitSources, { rendersPerDay: shown.usage.today.renders, rendersPerMonth: shown.usage.month.renders });
      }
      break;
    }
    if (programmeAt && (sub === undefined || sub === 'list')) {
      const { tokens } = await call(values.company ? `${programmeAt}?company=${encodeURIComponent(values.company)}` : programmeAt) as { tokens: ProgrammeTokenRow[] };
      out(tokens);
      if (!values.json) for (const t of tokens) {
        const state = t.revokedAt ? `REVOKED ${t.revokedAt}` : t.expired ? `EXPIRED ${t.expiresAt}` : `${t.expiring ? 'EXPIRING ' : ''}expires ${t.expiresAt}`;
        const cap = (n: number | null | undefined) => (n === null || n === undefined ? 'no cap' : n.toLocaleString('en-US'));
        console.log(`${t.id}  ${t.label}${t.company ? `  company ${t.company}` : ''}  scopes ${(t.scopes ?? []).join(',')}  today ${t.usage.today.calls} calls, ${t.usage.today.renders}/${cap(t.limits.rendersPerDay)} renders  last used ${t.lastUsedAt ?? 'never'}  ${state}`);
      }
      break;
    }
    if (sub === 'create') {
      const label = values.label ?? fail('usage: lw tokens create --label ci --scopes render[,documents,...] [--tools a,b] [--role r] [--days n]');
      const list = (raw: string | undefined) => raw?.split(',').map((item) => item.trim()).filter(Boolean);
      const scopes = list(values.scopes);
      if (!scopes && !values.role) fail('--scopes or --role required: scopes render, documents, files, delivery, catalog.read, audit.read; roles viewer, member, author, approver, admin, owner');
      const tools = list(values.tools);
      const limits = limitFlags({});
      const t = await call('/api/v1/tokens', { method: 'POST', body: { label, ...(values.role ? { role: values.role } : {}), ...(scopes ? { scopes } : {}), ...(tools ? { tools } : {}), ...(values.days ? { ttlDays: Number(values.days) } : {}), ...(limits ? { limits } : {}) } }) as { id: string; token: string; role: string; scopes: string[] | null; tools: string[] | null; expiresAt: string };
      out(t);
      if (!values.json) {
        console.log(`${t.id}  role ${t.role}  ${t.scopes ? `scopes ${t.scopes.join(',')}` : 'all that role can reach'}${t.tools ? `  tools ${t.tools.join(',')}` : ''}  expires ${t.expiresAt}`);
        console.log(`token (shown once, store it now): ${t.token}`);
        console.log('use it: LW_TOKEN=<token> lw … (or --token <token>)');
      }
      break;
    }
    if (sub === 'revoke') {
      const id = positionals[2] ?? fail('usage: lw tokens revoke <id>');
      await call(`/api/v1/tokens/${id}`, { method: 'DELETE' });
      console.log(`revoked ${id}`);
      break;
    }
    if (sub === 'limits') {
      // A token's own limits (plans/82 M7): with no flag, what applies and where it comes from.
      const usage = 'usage: lw tokens limits <id> [--calls-per-minute <n>|none|default] [--renders-per-day <n>|none|default] [--renders-per-month <n>|none|default]';
      const id = positionals[2] ?? fail(usage);
      type TokenLimitView = { id: string; label: string; limits: Record<string, number | null>; limitSources: Record<string, string>; limitOverrides: LimitFigures;
        usage: { today: { calls: number; renders: number; busiestMinute: number }; month: { renders: number }; week: { rateLimited: number; budgetRefused: number }; lastRefusal: { at: string; code: string } | null } };
      const { tokens } = await call('/api/v1/tokens') as { tokens: TokenLimitView[] };
      const current = tokens.find((t) => t.id === id) ?? fail(`no token ${id}`);
      const next = limitFlags(current.limitOverrides ?? {});
      const shown = next ? await call(`/api/v1/tokens/${encodeURIComponent(id)}/limits`, { method: 'PUT', body: { limits: next } }) as TokenLimitView : current;
      out(shown);
      if (!values.json) {
        console.log(`${shown.id}  ${shown.label}`);
        printLimits(shown.limits, shown.limitSources, { rendersPerDay: shown.usage.today.renders, rendersPerMonth: shown.usage.month.renders });
        console.log(`  today: ${shown.usage.today.calls} calls, busiest minute ${shown.usage.today.busiestMinute}; last 7 days: ${shown.usage.week.rateLimited} calls and ${shown.usage.week.budgetRefused} requests turned away${shown.usage.lastRefusal ? `; last ${shown.usage.lastRefusal.code} at ${shown.usage.lastRefusal.at}` : ''}`);
      }
      break;
    }
    if (sub === 'programme') {
      // Place a token in a partner programme and optionally one company in it
      // (plans/82 M3), so a partner's agent is scoped like the people there.
      const usage = 'usage: lw tokens programme <id> <programme> [--company <id>] | lw tokens programme <id> none';
      const id = positionals[2] ?? fail(usage);
      const programme = positionals[3] ?? fail(usage);
      const r = await call(`/api/v1/tokens/${encodeURIComponent(id)}/programme`, { method: 'PUT',
        body: programme === 'none' ? { programme: null } : { programme, ...(values.company ? { company: values.company } : {}) } }) as { id: string; programme?: string; company?: string };
      out(r);
      if (!values.json) console.log(r.programme ? `${r.id} is in ${r.programme}${r.company ? `, company ${r.company}` : ''}: it reaches what a person there reaches`
        : `${r.id} is in no programme: it keeps only the essentials. Mint a new token for internal work`);
      break;
    }
    const { tokens } = await call('/api/v1/tokens') as {
      tokens: Array<{ id: string; label: string; role: string; scopes: string[] | null; tools: string[] | null; createdAt: string; expiresAt: string | null; legacyUnbounded: boolean; lastUsedAt: string | null; revokedAt: string | null; programme?: string | null; company?: string | null;
        limits?: Record<string, number | null>; usage?: { today: { calls: number; renders: number } } }>;
    };
    out(tokens);
    if (!values.json) for (const t of tokens) {
      const placed = t.programme ? `programme ${t.programme}${t.company ? `/${t.company}` : ''}  ` : '';
      const cap = (n: number | null | undefined) => (n === null || n === undefined ? 'no cap' : n.toLocaleString('en-US'));
      const limits = t.limits && t.usage && !t.revokedAt ? `today ${t.usage.today.calls} calls, ${t.usage.today.renders}/${cap(t.limits.rendersPerDay)} renders, ${cap(t.limits.callsPerMinute)} calls a minute  ` : '';
      console.log(`${t.id}  ${t.label}  role ${t.role}  ${t.scopes ? `scopes ${t.scopes.join(',')}  ` : ''}${t.tools ? `tools ${t.tools.join(',')}  ` : ''}${placed}${limits}${t.revokedAt ? `REVOKED ${t.revokedAt}` : `last used ${t.lastUsedAt ?? 'never'}`}  ${t.legacyUnbounded ? 'legacy without expiry: rotate' : `expires ${t.expiresAt}`}`);
    }
    break;
  }

  case 'brand': {
    if (sub === 'preview') {
      const action = positionals[2] ?? fail('usage: lw brand preview <select|retire|restore|stop-download|enable-download> <source-id> [--replacement <source-id>]');
      const sourceId = positionals[3] ?? fail('source-id required');
      const result = await call('/api/v1/brand/changes/preview', { method: 'POST', body: { action, sourceId, ...(values.replacement ? { replacementId: values.replacement } : {}) } });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    if (sub === 'apply') {
      const file = positionals[2] ?? fail('usage: lw brand apply <reviewed-preview.json>');
      const reviewed = JSON.parse(readFileSync(file, 'utf8')) as { change: Record<string, unknown>; revision: number; reviewToken: string };
      const result = await call('/api/v1/brand/changes', { method: 'POST', body: { ...reviewed.change, revision: reviewed.revision, reviewToken: reviewed.reviewToken } });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    console.log(JSON.stringify(await call('/api/v1/brand/profiles'), null, 2));
    break;
  }

  case 'instance': {
    // The connect surface (plans/34 wave 2): read the public manifest, or host
    // the `.lolly` pack the OSS builder cut for this deployment (owner).
    if (sub === 'pack') {
      const file = positionals[2] ?? fail('usage: lw instance pack <file.lolly>');
      const bytes = readFileSync(file);
      const cookie = savedCookie();
      const res = await fetch(`${base}/api/v1/instance-pack`, {
        method: 'PUT',
        headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/octet-stream', 'x-lolly-client': 'lw-cli engine/0' },
        body: bytes,
      });
      const data = await res.json().catch(() => null) as {
        pack?: { signed: boolean; version?: string; size: number }; error?: { code?: string; message?: string };
      } | null;
      if (!res.ok) fail(`${res.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`.trim());
      const p = data?.pack;
      console.log(`hosted ${p?.signed ? 'signed' : 'UNSIGNED (dev only)'} pack${p?.version ? ` v${p.version}` : ''} (${p?.size} bytes) at ${base}/connect/pack.lolly`);
      break;
    }
    if (sub === 'pack-rm') {
      await call('/api/v1/instance-pack', { method: 'DELETE' });
      console.log('connect download stopped; mounted catalogue and source files retained');
      break;
    }
    const m = await call('/api/v1/instance') as {
      name: string; accessMode: string; provider: string | null; engineVersion: string | null; connect?: { packUrl: string };
    };
    out(m);
    if (!values.json) {
      console.log(`${m.name} · ${m.accessMode} · idp ${m.provider ?? 'none'} · engine ${m.engineVersion ?? '?'}${m.connect ? ` · pack ${m.connect.packUrl}` : ''}`);
    }
    break;
  }

  case 'links': {
    if (sub === 'create') {
      // A link to a tool render, its params as key=value pairs (a share link's
      // own params). --open lets recipients change them: each new set they put on
      // the link renders a new asset, within the tool's policy.
      const toolId = positionals[2] ?? fail('usage: lw links create <toolId> [key=value ...] [--kind embed|share|download] [--format <format>] [--open] [--hours <n>]');
      const params = Object.fromEntries(positionals.slice(3).map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 1) fail(`not a key=value pair: ${pair}`);
        return [pair.slice(0, eq), pair.slice(eq + 1)];
      }));
      const link = await call('/api/v1/links', { method: 'POST', body: {
        kind: values.kind ?? 'embed',
        target: { toolId, params, ...(values.format ? { format: values.format } : {}), ...(values.open ? { open: true } : {}) },
        ...(values.hours ? { ttlHours: Number(values.hours) } : {}),
      } }) as { id: string; url: string; expiresAt: string; open?: boolean };
      out(link);
      if (!values.json) console.log(`${link.url}\n${link.open ? 'open: recipients may change its params' : 'fixed params'}, expires ${link.expiresAt}  ${link.id}`);
      break;
    }
    if (sub === 'revoke') {
      const id = positionals[2] ?? fail('usage: lw links revoke <id>');
      await call(`/api/v1/links/${id}/revoke`, { method: 'POST' });
      console.log(`revoked ${id}`);
      break;
    }
    const { links } = await call(`/api/v1/links${values.all ? '?all=1' : ''}`) as {
      links: Array<{ id: string; kind: string; status: string; expiresAt: string; target: { toolId?: string; sessionId?: string; assetId?: string; collectionId?: string } }>;
    };
    out(links);
    // A link's target may be a catalog asset rather than a tool render
    // (plans/31 section 2, 1b). Naming it keeps the list auditable: "what does
    // this bearer URL reach" is the whole question this command answers, and an
    // asset link that printed as a dash could not be answered at all.
    if (!values.json) {
      for (const l of links) {
        const target = l.target.toolId ?? l.target.sessionId ?? l.target.assetId
          ?? (l.target.collectionId ? `collection:${l.target.collectionId}` : undefined) ?? '—';
        console.log(`${l.status.padEnd(8)} ${l.kind.padEnd(11)} ${target.padEnd(24)} exp ${l.expiresAt}  ${l.id}`);
      }
    }
    break;
  }

  case 'destinations': {
    const { destinations } = await call('/api/v1/destinations') as {
      destinations: Array<{ id: string; kind: string; label: string; formats: string[]; maxBytes: number; visibility: string }>;
    };
    out(destinations);
    if (!values.json) {
      for (const d of destinations) {
        console.log(`${d.id.padEnd(22)} ${d.kind.padEnd(8)} ${d.visibility.padEnd(7)} ${String(d.maxBytes).padStart(10)} B  ${d.formats.join(',')}  ${d.label}`);
      }
      if (!destinations.length) console.log('(no organization destinations available to this principal)');
    }
    break;
  }

  case 'deliveries': {
    type DeliveryView = {
      id: string; destinationId: string; name: string; format: string; state: string;
      attempt: number; size: number; sourceJobId: string | null; sourceRenderId?: string | null; url: string | null; error: string | null;
    };
    if (sub === 'publish') {
      const jobId = positionals[2] ?? fail('usage: lw deliveries publish <jobId> --destination <id> --name "…" [--format <format>] [--idempotency-key <key>]');
      const destinationId = values.destination ?? fail('--destination <id> required');
      const name = values.name ?? fail('--name required');
      const delivery = await call(`/api/v1/jobs/${encodeURIComponent(jobId)}/deliveries`, {
        method: 'POST',
        body: { destinationId, name, ...(values.format ? { format: values.format } : {}) },
        ...(values['idempotency-key'] ? { headers: { 'idempotency-key': values['idempotency-key'] } } : {}),
      }) as DeliveryView;
      out(delivery);
      if (!values.json) {
        console.log(`${delivery.id}  ${delivery.state}  ${delivery.name}.${delivery.format} → ${delivery.destinationId}`);
        if (delivery.state === 'awaiting-approval') console.log('waiting on the destination approval chain');
        if (delivery.url) console.log(delivery.url);
      }
      break;
    }
    if (sub === 'retry') {
      const id = positionals[2] ?? fail('usage: lw deliveries retry <id>');
      const delivery = await call(`/api/v1/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST' }) as DeliveryView;
      out(delivery);
      if (!values.json) console.log(`${delivery.id}  ${delivery.state} after attempt ${delivery.attempt}${delivery.url ? `  ${delivery.url}` : ''}`);
      break;
    }
    if (sub === 'show') {
      const id = positionals[2] ?? fail('usage: lw deliveries show <id>');
      const delivery = await call(`/api/v1/deliveries/${encodeURIComponent(id)}`) as DeliveryView;
      out(delivery);
      if (!values.json) {
        console.log(`${delivery.state.padEnd(18)} ${delivery.id}  ${delivery.name}.${delivery.format} → ${delivery.destinationId}`);
        console.log(`${delivery.size} B · attempt ${delivery.attempt}${delivery.sourceJobId ? ` · job ${delivery.sourceJobId}` : ''}${delivery.sourceRenderId ? ` · render ${delivery.sourceRenderId}` : ''}`);
        if (delivery.url) console.log(delivery.url);
        if (delivery.error) console.log(`error: ${delivery.error}`);
      }
      break;
    }
    if (sub && sub !== 'list') fail('usage: lw deliveries [list|show <id>|retry <id>|publish <jobId> --destination <id> --name "…"]');
    const { deliveries } = await call('/api/v1/deliveries') as { deliveries: DeliveryView[] };
    out(deliveries);
    if (!values.json) {
      for (const d of deliveries) {
        console.log(`${d.state.padEnd(18)} ${d.id}  ${d.name}.${d.format} → ${d.destinationId}  attempt ${d.attempt}${d.sourceJobId ? `  job ${d.sourceJobId}` : ''}`);
      }
      if (!deliveries.length) console.log('(no deliveries)');
    }
    break;
  }

  case 'msg': {
    if (sub !== 'send') fail('usage: lw msg send --title "…" [--body "…"] [--kind …] [--severity …] [--groups a,b] [--shells …] [--max-engine …] [--starts <ISO>] [--ends <ISO>]');
    const title = values.title ?? fail('--title required');
    const audience: Record<string, unknown> = {};
    if (values.groups) audience.groups = values.groups.split(',').map((s) => s.trim());
    if (values.shells) audience.shells = values.shells.split(',').map((s) => s.trim());
    if (values['max-engine']) audience.maxEngine = values['max-engine'];
    // A message shows from --starts and stops at --ends. The server cannot end
    // a message once it is sent, so --ends is how one is given a last day.
    const startsAt = messageTime('starts', values.starts);
    const endsAt = messageTime('ends', values.ends);
    if (endsAt && Date.parse(endsAt) <= Date.now()) fail('--ends is in the past, so the message would never show');
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) fail('--ends must be later than --starts');
    const msg = await call('/api/v1/messages', { method: 'POST', body: {
      title, body: values.body, kind: values.kind ?? 'announcement', severity: values.severity ?? 'info', audience,
      ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}),
    } });
    out(msg);
    if (!values.json) {
      const shown = [startsAt ? `from ${startsAt}` : '', endsAt ? `until ${endsAt}` : ''].filter(Boolean).join(' ');
      console.log(`sent ${(msg as { id: string }).id}${shown ? ` (shows ${shown})` : ''}`);
    }
    break;
  }

  // SCIM provisioning tokens (plans/31 §8). The mint prints the secret ONCE -
  // it is not recoverable from the stored hash - so it goes to stdout for the
  // operator to paste into the IdP connector, and never to the audit trail.
  case 'scim': {
    if (sub !== 'token') fail('usage: lw scim token create --idp <provider-id> | list | revoke <id>');
    const action = positionals[2];
    if (action === 'create') {
      const idp = values.idp ?? fail('usage: lw scim token create --idp <provider-id>');
      const rec = await call('/api/v1/scim/tokens', { method: 'POST', body: { idp } }) as { id: string; idp: string; token: string };
      out(rec);
      if (!values.json) {
        console.log(`token ${rec.id} for ${rec.idp} — paste this into the IdP connector, it is shown only once:`);
        console.log(rec.token);
      }
    } else if (action === 'revoke') {
      const id = positionals[3] ?? fail('usage: lw scim token revoke <id>');
      await call(`/api/v1/scim/tokens/${id}`, { method: 'DELETE' });
      if (!values.json) console.log(`revoked ${id}`);
    } else {
      const { tokens } = await call('/api/v1/scim/tokens') as {
        tokens: Array<{ id: string; idp: string; createdAt: string; lastUsedAt?: string; revokedAt?: string }>;
      };
      out({ tokens });
      if (!values.json) {
        for (const t of tokens) {
          const state = t.revokedAt ? 'revoked' : 'live';
          console.log(`${state.padEnd(8)} ${t.idp.padEnd(20)} ${t.id}  used ${t.lastUsedAt ?? 'never'}`);
        }
      }
    }
    break;
  }

  // Catalog providers (plans/17 §10). Credentials are prompted, NEVER argv -
  // argv leaks into shell history and process listings.
  case 'providers': {
    const id = positionals[2];
    const parseJsonFlag = (name: 'options' | 'mapping' | 'exposure'): Record<string, unknown> | undefined => {
      const raw = values[name];
      if (raw === undefined) return undefined;
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { fail(`--${name} must be valid JSON`); }
    };
    switch (sub) {
      case undefined:
      case 'list': {
        const { providers } = await call('/api/v1/catalog/providers') as {
          providers: Array<{ id: string; kind: string; label: string; managedBy: string; enabled: boolean;
            credential: { fingerprint: string; expiresInDays: number | null } | null;
            state: { assetCount: number; lastSyncAt: string | null; lastError: string | null } }>;
        };
        out(providers);
        if (!values.json) {
          for (const p of providers) {
            const status = p.enabled ? (p.state.lastError ? 'error' : 'enabled') : 'disabled';
            const days = p.credential?.expiresInDays;
            const expiry = typeof days === 'number' ? (days <= 0 ? '  CRED EXPIRED' : days <= 14 ? `  cred expires in ${days}d` : '') : '';
            console.log(`${status.padEnd(9)} ${p.id.padEnd(20)} ${p.kind.padEnd(12)} ${String(p.state.assetCount).padStart(5)} assets  cred ${p.credential?.fingerprint ?? '—'}${expiry}  ${p.managedBy === 'config' ? '[config]' : ''}`);
            if (p.state.lastError) console.log(`          last error: ${p.state.lastError}`);
          }
        }
        break;
      }
      case 'add': {
        if (!id) fail('usage: lw providers add <id> --kind <kind> --label "…" [--options {json}] [--mapping {json}] [--exposure {json}]');
        const options = parseJsonFlag('options');
        const mapping = parseJsonFlag('mapping');
        const exposure = parseJsonFlag('exposure');
        const created = await call('/api/v1/catalog/providers', { method: 'POST', body: {
          id, kind: values.kind ?? fail('--kind required'), label: values.label ?? fail('--label required'),
          ...(options ? { options } : {}),
          ...(mapping ? { mapping } : {}),
          ...(exposure ? { exposure } : {}),
        } });
        out(created);
        console.log(`created ${id} (disabled — set a credential, then enable)`);
        break;
      }
      // Dry run against a tenant (plans/33 §2) - the safe first contact: an
      // ephemeral record is health-checked server-side, then thrown away.
      // Nothing is stored, nothing is enabled. Takes a --kind, not an id: no
      // provider record has to exist yet.
      //
      // Two modes. Plain: health plus a mapped sample of this tenant's assets.
      // --shape: health plus the structure of its records - key names and value
      // types, never a value and never a sample, so the output is sendable.
      case 'preview': {
        const kind = values.kind ?? fail('usage: lw providers preview --kind <kind> [--options {json}] [--mapping {json}] [--exposure {json}] [--shape [--remote-id <id>]] [--json]');
        const options = parseJsonFlag('options');
        const mapping = parseJsonFlag('mapping');
        const exposure = parseJsonFlag('exposure');
        // Hidden like `credential` - a preview secret is a real tenant secret.
        // Empty is a legitimate answer for a source that needs none (a public
        // git or s3 bucket), so it is not an error.
        const secret = await promptHidden(`credential for the ${kind} preview (empty if this kind needs none): `);
        const r = await call('/api/v1/catalog/providers/preview', { method: 'POST', body: {
          kind,
          ...(secret ? { secret } : {}),
          ...(options ? { options } : {}),
          ...(mapping ? { mapping } : {}),
          ...(exposure ? { exposure } : {}),
          ...(values.shape ? { shape: true } : {}),
          // Only meaningful with --shape: it selects the detail report, and
          // nothing else in a preview is per-asset.
          ...(values.shape && values['remote-id'] ? { remoteId: values['remote-id'] } : {}),
        } }) as {
          health: { ok: boolean; detail?: string };
          sample?: Array<{ id: string; name?: string; type?: string; tags?: string[]; formats?: Array<{ format: string }> }>;
          sampleTotal?: number;
          excludedByExposure?: number;
          skipped?: number;
          notes?: string[];
          sampleError?: string;
          shapeText?: string[];
          detailShapeText?: string[];
        };
        out(r);
        if (values.json) break;
        console.log(r.health.ok ? `health ok - ${kind}` : `health FAILED: ${r.health.detail ?? 'unknown'}`);
        if (values.shape) {
          // Structure only, so the whole output redirects to a file an operator
          // can send: the list call first, then the per-asset detail call when
          // one was asked for.
          for (const line of r.shapeText ?? []) console.log(line);
          for (const line of r.detailShapeText ?? []) console.log(line);
          if (!r.health.ok) process.exit(2);
          break;
        }
        if (r.sampleError) console.log(`listing FAILED: ${r.sampleError}`);
        if (r.health.ok) {
          // Truncate to the column, then pad past it - a value that fills its
          // column exactly must not run into the next one.
          const cell = (s: string, w: number): string => (s.length > w ? `${s.slice(0, w - 1)}…` : s).padEnd(w + 2);
          const rows = (r.sample ?? []).map((a) => ({
            id: a.id ?? '', name: a.name ?? '', type: a.type ?? '',
            tags: (a.tags ?? []).join(' '),
            formats: (a.formats ?? []).map((f) => f.format).join(' '),
          }));
          console.log(`mapped sample: ${rows.length}${r.sampleTotal !== undefined ? ` of ${r.sampleTotal} on the first page` : ''}`
            + (r.excludedByExposure ? `, ${r.excludedByExposure} EXCLUDED by the exposure slice` : '')
            + (r.skipped ? `, ${r.skipped} record(s) SKIPPED (the driver could not map them)` : ''));
          for (const note of r.notes ?? []) console.log(`  note: ${note}`);
          if (rows.length) {
            console.log(`  ${cell('id', 32)}${cell('name', 26)}${cell('type', 8)}${cell('tags', 32)}formats`);
            for (const row of rows) {
              console.log(`  ${cell(row.id, 32)}${cell(row.name, 26)}${cell(row.type, 8)}${cell(row.tags, 32)}${row.formats}`);
            }
            // Sections are not a separate column because they are not a separate
            // field: unless mapping.sectionTags is false they federate INTO tags.
            console.log('  (sections federate as tags unless mapping.sectionTags is false; nothing above was stored)');
          } else if (r.excludedByExposure) {
            console.log(`  the exposure slice excluded every asset on this page (${r.excludedByExposure}) — widen exposure.requireApproved / includeSections / excludeTags, or this provider would federate nothing`);
          } else {
            console.log('  no assets came back — check the options scope (the exposure slice excluded none of them)');
          }
        }
        if (!r.health.ok) process.exit(2);
        break;
      }
      // Drift (plans/33 §2b) - the cadence check during a staged exit: which
      // materialized copies has upstream changed since we took them?
      case 'drift': {
        if (!id) fail('usage: lw providers drift <id>');
        const r = await call(`/api/v1/catalog/providers/${id}/drift`) as {
          materialized: number; compared: number;
          drifted: Array<{ id: string; remoteId: string; sourceUpdatedAt: string | null; materializedAt: string; upstreamUpdatedAt: string }>;
          unstamped?: number; unparsable?: number; unparsableShapes?: string[];
          timezoneless?: number; timezonelessShapes?: string[]; missingUpstream?: number;
          neverMaterialized: string[];
        };
        out(r);
        if (values.json) break;
        console.log(`${id}: ${r.drifted.length} drifted of ${r.compared} compared (${r.materialized} materialized asset(s) in all)`);
        for (const d of r.drifted) {
          const from = d.sourceUpdatedAt ?? `${d.materializedAt} (materializedAt - upstream carried no stamp then)`;
          console.log(`  ${d.remoteId.padEnd(28)} was ${from}  now ${d.upstreamUpdatedAt}  ${d.id}`);
        }
        // Everything the comparison could NOT answer is printed, never folded
        // into `compared` (plans/33 §5): a copy left uncompared is "cannot
        // tell", and reading it as "unchanged" is how a broken stamp guess
        // passes for a clean bill of health.
        if (r.unstamped) console.log(`not compared: ${r.unstamped} copy(ies) whose upstream record carries no change stamp the driver can read - check this kind's UPDATED_AT_KEYS against its live-verify runbook.`);
        if (r.unparsable) console.log(`not compared: ${r.unparsable} copy(ies) whose change stamp would not parse as a date (shape ${(r.unparsableShapes ?? []).join(', ')}) - drift detection is inoperative for those until the driver reads that format.`);
        if (r.missingUpstream) console.log(`not compared: ${r.missingUpstream} copy(ies) whose remote id is no longer in the listing at all.`);
        if (r.timezoneless) console.log(`read with care: ${r.timezoneless} comparison(s) used a stamp that names no timezone (shape ${(r.timezonelessShapes ?? []).join(', ')}) - it was read in THIS server's timezone, so those answers can be off by its UTC offset.`);
        if (r.neverMaterialized.length) {
          console.log(`never materialized (${r.neverMaterialized.length}): ${r.neverMaterialized.join(', ')}`);
        }
        console.log(`remedy: lw providers materialize ${id} --remote-id <remoteId> - idempotent per (provider, remoteId), so a re-run resumes rather than duplicates.`);
        break;
      }
      case 'credential': {
        if (!id) fail('usage: lw providers credential <id> [--expires 2026-12-01]   (prompts for the secret)');
        const secret = await promptHidden(`secret for ${id}: `);
        if (!secret) fail('no secret entered');
        const r = await call(`/api/v1/catalog/providers/${id}/credential`, {
          method: 'PUT', body: { secret, ...(values.expires ? { expiresAt: values.expires } : {}) },
        }) as { fingerprint: string; health: { ok: boolean } };
        out(r);
        console.log(`credential stored (${r.fingerprint}) — health ${r.health.ok ? 'ok' : 'FAILED'}${values.expires ? `, expires ${values.expires}` : ''}`);
        break;
      }
      case 'enable':
      case 'disable':
      case 'sync': {
        if (!id) fail(`usage: lw providers ${sub} <id>`);
        const r = await call(`/api/v1/catalog/providers/${id}/${sub}`, { method: 'POST' }) as { assetCount: number; skipped?: number; notes?: string[] };
        out(r);
        if (sub !== 'sync') { console.log(`${id} ${sub}d`); break; }
        // skipped and notes are printed, never swallowed (plans/33 §5).
        console.log(`synced ${id}: ${r.assetCount} assets`
          + (r.skipped ? `, ${r.skipped} record(s) SKIPPED (the driver could not map them)` : ''));
        for (const note of r.notes ?? []) console.log(`  note: ${note}`);
        break;
      }
      case 'health': {
        if (!id) fail('usage: lw providers health <id>');
        const h = await call(`/api/v1/catalog/providers/${id}/health`) as { ok: boolean; detail?: string };
        out(h);
        console.log(h.ok ? 'ok' : `unhealthy: ${h.detail ?? 'unknown'}`);
        if (!h.ok) process.exit(2);
        break;
      }
      // The exit (plans/27 §5): stream a provider's bytes into the instance's own
      // store. Whole provider, or one --remote-id, or a --section. Idempotent.
      case 'materialize': {
        if (!id) fail('usage: lw providers materialize <id> [--remote-id <id> | --section <name>]');
        const body: Record<string, string> = {};
        if (values['remote-id']) body.remoteId = values['remote-id'];
        if (values.section) body.section = values.section;
        const r = await call(`/api/v1/catalog/providers/${id}/materialize`, { method: 'POST', body }) as {
          materialized: number; skipped: number; credentialsFound: number;
          errors?: Array<{ remoteId: string; error: string }>;
        };
        out(r);
        console.log(`materialized ${r.materialized} asset(s) from ${id} — ${r.credentialsFound} carry a credential, ${r.skipped} skipped`);
        // Per-asset failures are printed, never left to --json (plans/33 §5):
        // this is the blob test every live-verify runbook turns on, and each
        // message already names the assumption, the constant and the runbook.
        if (r.errors?.length) {
          console.log(`${r.errors.length} asset(s) FAILED:`);
          for (const e of r.errors) console.log(`  ${e.remoteId}: ${e.error}`);
        }
        break;
      }
      // Cutover: identities ext/* → inst/*, rows + aliases migrated, provider
      // disabled. Owner-gated. Deleting the provider afterwards deletes nothing.
      case 'cutover': {
        if (!id) fail('usage: lw providers cutover <id>');
        const r = await call(`/api/v1/catalog/providers/${id}/cutover`, { method: 'POST' }) as { migrated: number };
        out(r);
        console.log(`cut ${id} over: ${r.migrated} asset(s) now instance-owned; provider disabled`);
        break;
      }
      // Publish out (plans/27 §10): push a lolly-generated export to a destination
      // (Optimizely CMP). Owner-grantable. The export must carry lolly's C2PA
      // export assertion - federated/pack assets are refused server-side.
      case 'publish': {
        if (!id) fail('usage: lw providers publish <id> --in <export-file> [--name <name>]');
        const file = values.in ?? fail('--in <export-file> required');
        const bytes = readFileSync(file);
        const format = (file.split('.').pop() ?? '').toLowerCase();
        if (!format) fail('cannot infer format from the filename — give it an extension');
        const name = values.name ?? (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
        const mime: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', webp: 'image/webp' };
        const cookie = savedCookie();
        const res = await fetch(`${base}/api/v1/catalog/providers/${id}/publish?name=${encodeURIComponent(name)}&format=${encodeURIComponent(format)}`, {
          method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': mime[format] ?? 'application/octet-stream', 'x-lolly-client': 'lw-cli engine/0' }, body: bytes,
        });
        const body = await res.json() as { ok?: boolean; remoteId?: string; url?: string; error?: { message: string } };
        if (!res.ok) fail(`publish failed (${res.status}): ${body.error?.message ?? 'unknown'}`);
        out(body);
        console.log(`published ${name}.${format} to ${id} → ${body.remoteId}${body.url ? ` (${body.url})` : ''}`);
        break;
      }
      case 'rm': {
        if (!id) fail('usage: lw providers rm <id>');
        await call(`/api/v1/catalog/providers/${id}`, { method: 'DELETE' });
        console.log(`deleted ${id}`);
        break;
      }
      // One-time OAuth consent for dropbox/gdrive/o365 (plans/17 §11 phase 4):
      // loopback redirect + PKCE, then the refresh token goes through the same
      // write-only credential endpoint as any API key. BYOT: the operator's
      // own registered app - client ids are prompted, never shipped.
      case 'auth': {
        if (!id) fail('usage: lw providers auth <id>');
        const rec = await call(`/api/v1/catalog/providers/${id}`) as { kind: string; options: Record<string, unknown> };
        const flow = oauthFlowFor(rec.kind, rec.options);
        if (!flow) {
          fail(`no loopback consent flow is registered for kind ${rec.kind} (registered: ${OAUTH_FLOW_KINDS.join(', ')}).
    Capture the sealed credential directly instead:  lw providers credential ${id}
    A consent flow for ${rec.kind} needs its authorize and token endpoints confirmed
    against a real tenant first - this CLI will not guess a consent URL.`);
        }
        console.log(`Register a ${rec.kind} app of your own first (loopback redirect URIs must be allowed).`);
        const clientId = await promptVisible('client id: ');
        if (!clientId) fail('client id required');
        const clientSecret = await promptHidden('client secret (empty for a public/PKCE-only app): ');

        const { createServer } = await import('node:http');
        const { createHash, randomBytes } = await import('node:crypto');
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const state = randomBytes(12).toString('base64url');

        const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
          let redirect = '';
          const srv = createServer((req2, res2) => {
            const u = new URL(req2.url ?? '/', 'http://127.0.0.1');
            if (u.pathname !== '/callback') { res2.writeHead(404); res2.end(); return; }
            res2.writeHead(200, { 'content-type': 'text/html' });
            res2.end('<p>Signed in — you can close this tab and return to the terminal.</p>');
            srv.close();
            if (u.searchParams.get('state') !== state) return reject(new Error('state mismatch — restart the flow'));
            const c = u.searchParams.get('code');
            c ? resolve({ code: c, redirect }) : reject(new Error(u.searchParams.get('error') ?? 'no code returned'));
          });
          srv.listen(0, '127.0.0.1', () => {
            redirect = `http://127.0.0.1:${(srv.address() as { port: number }).port}/callback`;
            const q = new URLSearchParams({
              client_id: clientId, response_type: 'code', redirect_uri: redirect, state,
              code_challenge: challenge, code_challenge_method: 'S256', ...flow.authParams,
            });
            console.log(`\nOpen this URL in a browser and approve read access:\n\n  ${flow.authorizeUrl}?${q}\n`);
          });
        });

        const body = new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirect,
          client_id: clientId, code_verifier: verifier,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        });
        const tokenRes = await fetch(flow.tokenUrl, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
        const tokenData = await tokenRes.json() as { refresh_token?: string; error_description?: string };
        if (!tokenRes.ok || !tokenData.refresh_token) {
          fail(`token exchange failed: ${tokenData.error_description ?? tokenRes.status} (offline access must be granted)`);
        }
        const secretJson = JSON.stringify({ clientId, ...(clientSecret ? { clientSecret } : {}), refreshToken: tokenData.refresh_token });
        const stored = await call(`/api/v1/catalog/providers/${id}/credential`, { method: 'PUT', body: { secret: secretJson } }) as { fingerprint: string; health: { ok: boolean } };
        console.log(`credential stored (${stored.fingerprint}) — health ${stored.health.ok ? 'ok' : 'FAILED'}`);
        break;
      }
      default:
        fail('usage: lw providers [list|preview|add|credential|auth|enable|disable|sync|health|drift|materialize|cutover|publish|rm]');
    }
    break;
  }

  // Resumable uploads (docs/resumable-uploads.md). The upload id is saved
  // beside the session until the upload finishes, so running the same
  // command again after an interruption sends only the missing parts.
  case 'upload': {
    const file = positionals[1] ?? fail('usage: lw upload <file> (--project <id> | --scope catalog-submission|automation-input|file) [--name "…"] [--content-type <type>]');
    const target: UploadTarget = values.project ? { kind: 'project', projectId: values.project }
      : values.scope === 'catalog-submission' || values.scope === 'automation-input' || values.scope === 'file' ? { kind: 'upload', scope: values.scope }
      : fail('lw upload needs --project <id> or --scope catalog-submission|automation-input|file');
    const cookie = savedCookie(), bearer = values.token ?? process.env.LW_TOKEN;
    const source = await fileSource(file).catch((error: Error) => fail(`cannot read ${file}: ${error.message}`));
    try {
      const result = await resumableUpload({
        base, target, source, state: fileStateStore(join(CONFIG_DIR, 'uploads')),
        name: values.name ?? basename(file), contentType: values['content-type'] ?? contentTypeOf(file),
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : cookie ? { cookie } : {}), 'x-lolly-client': 'lw-cli engine/0' },
        onProgress: values.json ? undefined : (sent, total) => process.stderr.write(`\r${Math.floor((sent / total) * 100)}% of ${total} bytes`),
      });
      if (!values.json) process.stderr.write('\n');
      out(result);
      if (!values.json) {
        console.log(`${result.resumed ? 'resumed and finished' : 'finished'} ${result.id} (${result.size} bytes, sha256 ${result.checksum}, ${result.sentParts} part(s) sent)`);
        if (target.kind === 'upload' && target.scope === 'catalog-submission') console.log(`submit it: POST /api/v1/catalog/submit?name=…&uploadId=${result.id}&checksum=${result.checksum}`);
        if (target.kind === 'upload' && target.scope === 'automation-input') console.log(`use it: "upload": { "id": "${result.id}", "checksum": "${result.checksum}" } in /api/v1/inspect or /api/v1/optimize`);
        if (target.kind === 'upload' && target.scope === 'file') console.log(`use it: "file": { "id": "${result.id}", "checksum": "${result.checksum}" } in /api/v1/inspect or /api/v1/optimize; read it at /api/v1/files/${result.id}/content`);
      }
    } catch (error) {
      if (!values.json) process.stderr.write('\n');
      // No answer, a 429 or a 5xx can pass; a refusal will not.
      const passing = !(error instanceof UploadClientError) || error.status === 0 || error.status === 429 || error.status >= 500;
      fail(passing ? `upload stopped: ${(error as Error).message}; run the same command again to resume`
        : `upload refused (${(error as UploadClientError).status} ${(error as UploadClientError).code}): ${(error as Error).message}`);
    } finally { await source.close(); }
    break;
  }

  // Catalog submit (plans/31 §3): put a local file INTO the instance catalog,
  // and review what is waiting. The bytes ride the raw body exactly as
  // `providers publish` sends an export out; the declared metadata rides query
  // params. With no submit chain configured the asset is live on return.
  case 'catalog': {
    switch (sub) {
      case 'submit': {
        const file = positionals[2] ?? values.in ?? fail('usage: lw catalog submit <file> [--name "…"] [--tags a,b] [--groups a,b] | --asset inst/<id> [--note "…"]');
        const bytes = readFileSync(file);
        const leaf = file.split('/').pop() ?? file;
        // With `--asset` these bytes REPLACE an existing asset's (plans/31 §6):
        // same pipeline, same file, a new version rather than a new id. The
        // descriptive flags belong to `lw catalog meta` in that case, and the
        // server refuses them rather than ignoring them.
        const q = new URLSearchParams(values.asset
          ? { assetId: values.asset, ...(values.note ? { note: values.note } : {}) }
          : { name: values.name ?? leaf.replace(/\.[^.]+$/, '') });
        if (!values.asset) {
          if (values.groups) q.set('groups', values.groups);
          if (values.tags) q.set('tags', values.tags);
          if (values.type) q.set('type', values.type);
          if (values.label) q.set('description', values.label);
        }
        const cookie = savedCookie();
        const res = await fetch(`${base}/api/v1/catalog/submit?${q}`, {
          method: 'POST',
          headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/octet-stream', 'x-lolly-client': 'lw-cli engine/0' },
          body: new Uint8Array(bytes),
        });
        const body = await res.json() as {
          assetId?: string; state?: string; duplicate?: boolean; scan?: string; credential?: string;
          version?: number; trimmed?: number; error?: { message: string };
        };
        if (!res.ok) fail(`submit failed (${res.status}): ${body.error?.message ?? 'unknown'}`);
        out(body);
        if (!values.json) {
          if (body.duplicate) {
            console.log(`already in the catalog as ${body.assetId} (identical bytes; nothing stored)`);
          } else if (body.version) {
            console.log(`${leaf} → ${body.assetId} version ${body.version} · scan ${body.scan} · credential ${body.credential}`);
            if (body.trimmed) console.log(`retention dropped ${body.trimmed} older version(s) (policy.catalog.versionKeep)`);
          } else {
            console.log(`submitted ${leaf} → ${body.assetId} [${body.state}] scan ${body.scan} · credential ${body.credential}`);
          }
          if (body.state === 'submitted') console.log('waiting on the submit chain - approve it with `lw catalog approve <id>`');
        }
        break;
      }
      // The version history of one instance asset, newest first (plans/31 §6).
      case 'versions': {
        const id = positionals[2] ?? fail('usage: lw catalog versions <assetId>');
        const r = await call(`/api/v1/catalog/assets/${id}/versions`) as {
          head: number; keep: number;
          versions: Array<{ version: number; head: boolean; at: string; by: string; size: number; note?: string }>;
        };
        out(r);
        if (!values.json) {
          for (const v of r.versions) {
            console.log(`${v.head ? '*' : ' '} v${String(v.version).padEnd(4)} ${String(v.size).padStart(9)} B  ${v.at}  ${v.by}${v.note ? `  ${v.note}` : ''}`);
          }
          console.log(r.keep ? `keeping ${r.keep} versions per asset (policy.catalog.versionKeep)` : 'keeping every version (policy.catalog.versionKeep 0)');
        }
        break;
      }
      // Point the head at a version that already exists. Nothing is copied and
      // nothing is deleted, so a rollback is itself reversible.
      case 'rollback': {
        const id = positionals[2] ?? fail('usage: lw catalog rollback <assetId> <version>');
        const version = Number(positionals[3] ?? fail('usage: lw catalog rollback <assetId> <version>'));
        const r = await call(`/api/v1/catalog/assets/${id}/head`, { method: 'PUT', body: { version } }) as {
          id: string; version: number; changed: boolean; previous?: number;
        };
        out(r);
        if (!values.json) {
          console.log(r.changed ? `${r.id} now serves version ${r.version} (was ${r.previous})` : `${r.id} already serves version ${r.version}`);
        }
        break;
      }
      // Delete one stored version. The head is never deletable (roll back
      // first) and a hold refuses this outright.
      case 'version-rm': {
        const id = positionals[2] ?? fail('usage: lw catalog version-rm <assetId> <version>');
        const version = Number(positionals[3] ?? fail('usage: lw catalog version-rm <assetId> <version>'));
        await call(`/api/v1/catalog/assets/${id}/versions/${version}`, { method: 'DELETE' });
        if (!values.json) console.log(`deleted ${id} version ${version}`);
        break;
      }
      // ID-level supersession (plans/31 §6): retire an asset in favour of
      // another. Advice to consumers, never a takedown - lifecycle is the door
      // for that, and the two compose.
      case 'rights': {
        // Owner-published marks and licence records (plans/82 M4). A mark or a
        // licence record is this workspace's own statement; Lolly does not check
        // ownership or the licence.
        const what = positionals[2];
        const usage = 'usage: lw catalog rights [ls] | mark <scope> [--holder "…"] [--terms "…"] [--note "…"] | unmark <scope> | licence <assetId> <declaration> [--attribution "…"] [--note "…"] | unlicence <assetId>';
        if (what === 'mark') {
          const scope = positionals[3] ?? fail(usage);
          const r = await call('/api/v1/catalog/rights/marks', { method: 'PUT', body: { scope, ...(values.holder ? { holder: values.holder } : {}), ...(values.terms ? { terms: values.terms } : {}), ...(values.note ? { note: values.note } : {}) } }) as {
            mark: { scope: string }; statement: string; covered: { now: number };
          };
          out(r);
          if (!values.json) console.log(`${r.mark.scope}: covers ${r.covered.now} file(s) with no licence record of their own\n${r.statement}`);
          break;
        }
        if (what === 'unmark') {
          const scope = positionals[3] ?? fail(usage);
          out(await call(`/api/v1/catalog/rights/marks?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' }));
          if (!values.json) console.log(`withdrew the mark on ${scope}; its files fall back to what they record themselves`);
          break;
        }
        if (what === 'licence') {
          const assetId = positionals[3] ?? fail(usage);
          const declaration = positionals[4] ?? fail(usage);
          const r = await call('/api/v1/catalog/rights/licences', { method: 'PUT', body: { assetId, declaration, ...(values.attribution ? { attribution: values.attribution } : {}), ...(values.note ? { note: values.note } : {}) } }) as {
            statement: string; reads: { travels: boolean; licence: string; reason?: string };
          };
          out(r);
          if (!values.json) console.log(`${assetId}: ${r.reads.licence || declaration}${r.reads.travels ? '' : ` (held back from partners: ${r.reads.reason})`}\n${r.statement}`);
          break;
        }
        if (what === 'unlicence') {
          const assetId = positionals[3] ?? fail(usage);
          out(await call(`/api/v1/catalog/rights/licences?assetId=${encodeURIComponent(assetId)}`, { method: 'DELETE' }));
          if (!values.json) console.log(`removed the licence record on ${assetId}`);
          break;
        }
        if (what !== undefined && what !== 'ls' && what !== 'list') fail(usage);
        const marks = await call('/api/v1/catalog/rights/marks') as { marks: Array<{ scope: string; holder: string; statement: string; covered: { now: number; atStatement?: number } }> };
        const licences = await call('/api/v1/catalog/rights/licences') as { licences: Array<{ assetId: string; declaration: string; statement: string }> };
        out({ ...marks, ...licences });
        if (!values.json) {
          if (!marks.marks.length && !licences.licences.length) console.log('no marks and no licence records');
          for (const m of marks.marks) console.log(`mark ${m.scope}  ${m.holder}  covers ${m.covered.now}${m.covered.atStatement !== undefined ? ` (${m.covered.atStatement} when stated)` : ''}\n  ${m.statement}`);
          for (const l of licences.licences) console.log(`licence ${l.assetId}  ${l.declaration}\n  ${l.statement}`);
        }
        break;
      }
      case 'supersede': {
        const id = positionals[2] ?? fail('usage: lw catalog supersede <assetId> <replacementId> | --rm');
        const replacement = values.rm ? null : positionals[3] ?? values['replaced-by']
          ?? fail('usage: lw catalog supersede <assetId> <replacementId> | --rm');
        const r = await call(`/api/v1/catalog/assets/${id}/meta`, { method: 'PUT', body: { replacedBy: replacement } }) as {
          id: string; replacedBy?: string;
        };
        out(r);
        if (!values.json) console.log(r.replacedBy ? `${r.id} is replaced by ${r.replacedBy}` : `${r.id} is no longer marked as replaced`);
        break;
      }
      case 'queue': {
        // Pending only by default, because that is the list someone can act on;
        // --all adds what has already been published or returned.
        const { submissions } = await call(`/api/v1/catalog/submissions${values.all ? '' : '?state=submitted'}`) as {
          submissions: Array<{ id: string; name: string; byName: string; at: string; size: number; relation: string; state: string }>;
        };
        out(submissions);
        if (!values.json) {
          for (const s of submissions) {
            console.log(`${s.state.padEnd(9)} ${s.relation.padEnd(6)} ${s.id.padEnd(20)} ${String(s.size).padStart(9)} B  ${s.name}  (${s.byName}, ${s.at})`);
          }
          if (!submissions.length) console.log(values.all ? '(no submissions)' : '(nothing waiting on review)');
        }
        break;
      }
      // The org's own taxonomy (plans/31 §4). Definitions are policy, so they
      // are edited through `lw apply` on the governance document; this lists
      // what is defined, which is what someone filling a value in needs.
      case 'fields': {
        const { fields } = await call('/api/v1/catalog/fields') as {
          fields: Array<{ id: string; label: string; kind: string; required?: boolean; options?: string[] }>;
        };
        out(fields);
        if (!values.json) {
          for (const f of fields) {
            const bits = [f.kind, ...(f.required ? ['required'] : []), ...(f.options?.length ? [f.options.join('|')] : [])];
            console.log(`${f.id.padEnd(20)} ${f.label.padEnd(24)} ${bits.join(' · ')}`);
          }
          if (!fields.length) console.log('(no org-defined fields; add them to the governance document and `lw apply` it)');
        }
        break;
      }
      // Edit a SERVED asset's metadata (plans/31 §4): org-defined field values
      // for any asset the caller can see, and name/tags/description for an
      // instance-owned one. Needs catalog.edit; every change is audited.
      case 'meta': {
        const id = positionals[2] ?? fail('usage: lw catalog meta <assetId> [--field k=v] [--name "…"] [--tags a,b] [--label "description"]');
        const fields: Record<string, string> = {};
        for (const pair of values.field ?? []) {
          const at = pair.indexOf('=');
          if (at < 1) fail(`--field wants fieldId=value (got "${pair}")`);
          fields[pair.slice(0, at)] = pair.slice(at + 1);
        }
        const body: Record<string, unknown> = {
          ...(values.name ? { name: values.name } : {}),
          ...(values.tags !== undefined ? { tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
          ...(values.label !== undefined ? { description: values.label } : {}),
          ...(Object.keys(fields).length ? { fields } : {}),
        };
        if (!Object.keys(body).length) fail('nothing to change: pass --field, --name, --tags or --label');
        const r = await call(`/api/v1/catalog/assets/${id}/meta`, { method: 'PUT', body }) as {
          id: string; name?: string; fields: Record<string, string>;
        };
        out(r);
        if (!values.json) {
          const set = Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join(' · ');
          console.log(`${r.id}${r.name ? ` "${r.name}"` : ''}${set ? ` · ${set}` : ' · no org fields set'}`);
        }
        break;
      }
      // Correct a pending submission's declared metadata before it is published
      // (plans/31 §3). Descriptive fields and the org's own fields: the bytes
      // and the exposure the submitter chose are not editable, and every change
      // is audited.
      case 'edit': {
        const id = positionals[2] ?? fail('usage: lw catalog edit <assetId> [--name "…"] [--tags a,b] [--type icon] [--label "description"] [--field k=v]');
        const fields: Record<string, string> = {};
        for (const pair of values.field ?? []) {
          const at = pair.indexOf('=');
          if (at < 1) fail(`--field wants fieldId=value (got "${pair}")`);
          fields[pair.slice(0, at)] = pair.slice(at + 1);
        }
        const patch: Record<string, unknown> = {
          ...(values.name ? { name: values.name } : {}),
          ...(values.type ? { type: values.type } : {}),
          ...(values.tags !== undefined ? { tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
          ...(values.label !== undefined ? { description: values.label } : {}),
          ...(Object.keys(fields).length ? { fields } : {}),
        };
        if (!Object.keys(patch).length) fail('nothing to change: pass --name, --tags, --type, --label or --field');
        const r = await call(`/api/v1/catalog/submissions/${id.replace(/^inst\//, '')}`, { method: 'PATCH', body: patch }) as {
          submission: { id: string; name: string; type: string; tags: string[] };
        };
        out(r.submission);
        if (!values.json) console.log(`${r.submission.id} is now "${r.submission.name}" [${r.submission.type}] ${r.submission.tags.join(', ')}`);
        break;
      }
      // Collections (plans/31 §5): a named, ORDERED, group-visible set of
      // catalog asset ids. Needs catalog.collection.manage, and refuses any
      // member the caller cannot see.
      case 'collections': {
        const { collections } = await call('/api/v1/catalog/collections') as {
          collections: Array<{ id: string; name: string; members: string[]; groups?: string[] | '*'; curator: string; updatedAt: string }>;
        };
        out(collections);
        if (!values.json) {
          for (const c of collections) {
            const groups = !c.groups || c.groups === '*' ? 'everyone' : c.groups.join(',');
            console.log(`${c.id.padEnd(24)} ${String(c.members.length).padStart(4)} assets  ${groups.padEnd(20)} ${c.name}`);
          }
          if (!collections.length) console.log('(no collections yet: `lw catalog collection <id> --name "…" --members a,b`)');
        }
        break;
      }
      case 'collection': {
        const id = positionals[2] ?? fail('usage: lw catalog collection <id> [--name "…"] [--members a,b] [--groups x,y] [--label "description"] | --rm');
        if (values.rm) {
          await call(`/api/v1/catalog/collections/${id}`, { method: 'DELETE' });
          console.log(`removed collection ${id}`);
          break;
        }
        const body: Record<string, unknown> = {
          ...(values.name ? { name: values.name } : {}),
          ...(values.label !== undefined ? { description: values.label } : {}),
          ...(values.members !== undefined ? { members: values.members.split(',').map((m) => m.trim()).filter(Boolean) } : {}),
          ...(values.groups !== undefined ? { groups: values.groups === '*' ? '*' : values.groups.split(',').map((g) => g.trim()).filter(Boolean) } : {}),
        };
        if (!Object.keys(body).length) fail('nothing to change: pass --name, --members, --groups or --label');
        const r = await call(`/api/v1/catalog/collections/${id}`, { method: 'PUT', body }) as {
          id: string; name: string; members: string[]; groups?: string[] | '*';
        };
        out(r);
        if (!values.json) {
          const groups = !r.groups || r.groups === '*' ? 'everyone' : r.groups.join(', ');
          console.log(`${r.id} "${r.name}" - ${r.members.length} assets, visible to ${groups}`);
        }
        break;
      }
      case 'approve':
      case 'return': {
        const id = positionals[2] ?? fail(`usage: lw catalog ${sub} <assetId> [--body "comment"]`);
        const short = id.replace(/^inst\//, '');
        const r = await call(`/api/v1/catalog/submissions/${short}/act`, {
          method: 'POST',
          body: { action: sub === 'approve' ? 'approve' : 'reject', ...(values.body ? { comment: values.body } : {}) },
        }) as { assetId: string; state: string };
        out(r);
        if (!values.json) console.log(`${r.assetId} is now ${r.state}`);
        break;
      }
      default:
        fail('usage: lw catalog submit <file> [--asset inst/<id>] | queue [--all] | edit <id> | meta <id> | fields | collections | collection <id> | versions <id> | rollback <id> <n> | version-rm <id> <n> | supersede <id> <newId> | approve <id> | return <id> --body "why"');
    }
    break;
  }

  // Grants (plans/03): lw grants list · lw grants add|rm <principal> <action> [<resource>] --effect deny|allow
  case 'grants': {
    if (sub === 'add' || sub === 'rm') {
      const [, , principal, action, resource] = positionals;
      if (!principal || !action) fail(`usage: lw grants ${sub} <principal> <action> [<resource>] --effect deny|allow`);
      const effect = values.effect ?? 'deny';
      const r = await call('/api/v1/grants', {
        method: sub === 'add' ? 'POST' : 'DELETE',
        body: { principal, action, resource: resource ?? '*', effect },
      });
      out(r);
      console.log(`${sub === 'add' ? 'added' : 'removed'} ${effect} ${principal} ${action} ${resource ?? '*'}`);
      break;
    }
    const { grants } = await call('/api/v1/grants') as {
      grants: Array<{ principal: string; action: string; resource: string; effect: string }>;
    };
    out(grants);
    if (!values.json) {
      for (const g of grants) console.log(`${g.effect.padEnd(6)} ${g.principal.padEnd(24)} ${g.action.padEnd(28)} ${g.resource}`);
      if (!grants.length) console.log('(no grants — role defaults only)');
    }
    break;
  }

  // Preview-as-group (plans/03): what would a member in these groups receive?
  case 'preview': {
    const groups = values.groups ?? positionals[1] ?? '';
    const { preview, orgConfig } = await call(`/api/v1/org-config/preview?groups=${encodeURIComponent(groups)}`) as {
      preview: { groups: string[]; role: string; hiddenTools: string[] };
      orgConfig: { can: Record<string, boolean>; tools: Record<string, { inputs?: Array<{ id: string; access?: { level: string; value?: unknown; allow?: unknown[] } }>; hidden?: string[]; approvalChain?: string }> };
    };
    out({ preview, orgConfig });
    if (!values.json) {
      console.log(`as ${preview.groups.join(', ') || '(no groups)'} → role ${preview.role}`);
      console.log('permissions:');
      for (const [action, ok] of Object.entries(orgConfig.can)) console.log(`  ${ok ? '✓' : '✗'} ${action}`);
      const toolIds = Object.keys(orgConfig.tools);
      console.log(`visible governed tools: ${toolIds.join(', ') || '(none)'}`);
      for (const id of toolIds) {
        const t = orgConfig.tools[id];
        for (const i of t?.inputs ?? []) {
          const d = i.access?.level === 'locked' ? `= ${JSON.stringify(i.access.value)}`
            : i.access?.level === 'choice' ? `∈ ${JSON.stringify(i.access.allow)}` : '';
          console.log(`    ${id}.${i.id}: ${i.access?.level} ${d}`);
        }
        for (const h of t?.hidden ?? []) console.log(`    ${id}.${h}: hidden`);
      }
      if (preview.hiddenTools.length) console.log(`hidden from this group: ${preview.hiddenTools.join(', ')}`);
    }
    break;
  }

  case 'audit': {
    if (sub === 'retire-key') {
      // Local infra command, like migrate: talks to the DATABASE directly and
      // needs the server's LW_SESSION_SECRET, never the API base.
      const { runRetireKeyCommand } = await import('../server/src/audit/retire-cli.ts');
      const args = [...(values.reason !== undefined ? ['--reason', values.reason] : []),
        ...(values['expect-head'] !== undefined ? ['--expect-head', values['expect-head']] : []),
        ...(values['allow-interleaved'] ? ['--allow-interleaved'] : []), ...(values['no-witness'] ? ['--no-witness'] : []),
        ...(values['dry-run'] ? ['--dry-run'] : []), ...(values.json ? ['--json'] : [])];
      process.exit(await runRetireKeyCommand(args));
    }
    const { retiredKeyNote } = await import('../server/src/audit/chain.ts');
    if (sub === 'head') {
      const head = await call('/api/v1/audit/head') as { seq: number; hash: string; at: string | null; count: number; chainIntact: boolean; badSeq?: number; retiredKeyRows?: number; retiredBefore?: string };
      out(head);
      if (!values.json) console.log(head.chainIntact
        ? `head #${head.seq} · ${head.hash} · ${head.count} events · intact${retiredKeyNote(head)}`
        : `head #${head.seq} · ${head.hash} · CHAIN BROKEN at #${head.badSeq}`);
      if (!head.chainIntact) process.exit(2);
      break;
    }
    if (sub !== 'verify') fail('usage: lw audit verify|head|retire-key');
    const { chain, total } = await call('/api/v1/audit?limit=1') as { chain: { ok: boolean; badSeq?: number; retiredKeyRows?: number; retiredBefore?: string }; total: number };
    out({ chain, total });
    if (!values.json) console.log(chain.ok ? `chain intact${retiredKeyNote(chain)} · ${total} events` : `CHAIN BROKEN at #${chain.badSeq} · ${total} events`);
    if (!chain.ok) process.exit(2);
    break;
  }

  case 'export': {
    const doc = await call('/api/v1/config/export');
    const text = JSON.stringify(doc, null, 2);
    const dest = values.out ?? positionals[1];
    if (dest) { writeFileSync(dest, text + '\n'); console.error(`wrote ${dest}`); }
    else console.log(text);
    break;
  }

  case 'apply': {
    const file = values.in ?? positionals[1] ?? fail('usage: lw apply <file> [--dry-run] [--prune]');
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const qs = new URLSearchParams();
    if (values['dry-run']) qs.set('dryRun', '1');
    if (values.prune) qs.set('prune', '1');
    const r = await call(`/api/v1/config/apply${qs.toString() ? `?${qs}` : ''}`, { method: 'POST', body }) as {
      dryRun: boolean; hash: string; diff?: Record<string, { create: number; update: number; delete: number; unchanged: number }>; applied?: Record<string, { create: number; update: number; delete: number; unchanged: number }>;
    };
    out(r);
    if (!values.json) {
      const s = r.applied ?? r.diff ?? {};
      console.log(`${r.dryRun ? 'dry-run' : 'applied'} · ${r.hash.slice(0, 16)}`);
      for (const cat of ['grants', 'overlays', 'chains', 'providers', 'featureFlags', 'catalogFields', 'tagRules'] as const) {
        const c = s[cat];
        if (c) console.log(`  ${cat.padEnd(13)} +${c.create} ~${c.update} -${c.delete} (=${c.unchanged})`);
      }
    }
    break;
  }

  case 'c2pa': {
    if (sub !== 'init') fail('usage: lw c2pa init [--org "Name"] [--out ./c2pa] [--days 365]');
    // Local command: mints a self-contained C2PA signing identity (root + leaf)
    // so exports can be signed with ZERO corporate PKI. For a trusted signature,
    // an org instead drops in a cert issued by their own CA (see docs/c2pa.md).
    const { mkdirSync } = await import('node:fs');
    const { webcrypto } = await import('node:crypto');
    const { subtle } = webcrypto;
    type CK = Parameters<typeof subtle.exportKey>[1];
    // Non-literal specifier so tsc doesn't resolve the engine's (browser-lib) types.
    const engineSpec: string = '@lolly/engine';
    const { generateCaRoot, issueLeafCert, derToPem } = await import(engineSpec) as {
      generateCaRoot: (o: { commonName?: string; organization?: string; days?: number }) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
      issueLeafCert: (o: Record<string, unknown>) => Promise<Uint8Array>;
      derToPem: (der: Uint8Array, label: string) => string;
    };
    const org = values.org ?? 'Lolly';
    const days = Number(values.days ?? 365);
    const dir = values.out ?? './c2pa';
    mkdirSync(dir, { recursive: true });

    const root = await generateCaRoot({ commonName: `${org} Lolly Root`, organization: org, days: Math.max(days * 2, 3650) });
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: CK; privateKey: CK };
    const spkiDer = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
    const leafKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
    const leafCert = await issueLeafCert({
      caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer,
      email: `lolly@${org.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.invalid`,
      commonName: `${org} Lolly Signer`, organization: org, days,
    });

    const certPath = `${dir}/c2pa-signing-cert.pem`;
    const keyPath = `${dir}/c2pa-signing-key.pem`;
    const rootPath = `${dir}/c2pa-root-cert.pem`;
    // Chain: leaf first, then root - exactly what buildSigner expects.
    writeFileSync(certPath, derToPem(leafCert, 'CERTIFICATE') + derToPem(root.certDer, 'CERTIFICATE'));
    writeFileSync(keyPath, derToPem(leafKey, 'PRIVATE KEY'), { mode: 0o600 });
    writeFileSync(rootPath, derToPem(root.certDer, 'CERTIFICATE'));

    if (values.json) { out({ certFile: certPath, keyFile: keyPath, rootFile: rootPath }); break; }
    console.log(`C2PA signing identity for "${org}" written to ${dir}/:
  ${certPath}   ← public chain (leaf + root). Set instance.json render.c2pa.certFile to this.
  ${keyPath}    ← SECRET private key. Provide as env LW_C2PA_SIGNING_KEY (do NOT commit).
  ${rootPath}   ← the root cert; add it to verifiers' C2PA trust lists to make signatures trusted.

Wire it up:
  1. instance.json → "render": { "c2pa": { "certFile": "${certPath}", "claimGenerator": "${org} Lolly" } }
  2. export LW_C2PA_SIGNING_KEY="$(cat ${keyPath})"
  3. restart — every server-side export now carries a signed Content Credential.

Already have a corporate CA? Skip this: point render.c2pa.certFile at your CA-issued
signing chain (leaf first) and set LW_C2PA_SIGNING_KEY to its PKCS#8 key instead.`);
    break;
  }

  case 'migrate': {
    // Local infra command: talks to the DATABASE directly, not the API base.
    const url = process.env.DATABASE_URL ?? fail('migrate needs DATABASE_URL — run it where the database is reachable (not via LW_BASE)');
    const { runMigrations, pendingMigrations, describeMigrations } = await import('../server/src/store/migrate.ts');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../migrations', import.meta.url));
    if (sub === 'status' || values.check) {
      const pending = await pendingMigrations(url, dir);
      // The manifest is the LW_MIGRATE_EXPECT value that binds a later run to exactly these files.
      out({ pending, current: pending.length === 0, manifest: (await describeMigrations(pending, dir)).manifest });
      if (!values.json) console.log(pending.length ? `${pending.length} pending: ${pending.join(', ')}` : 'schema current');
      if (pending.length) process.exit(1);
      break;
    }
    const applied = await runMigrations(url, dir);
    out({ applied });
    if (!values.json) console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply (schema current)');
    break;
  }

  case 'edge': {
    type Finding = { id: string; status: 'pass' | 'fail' | 'warn' | 'info'; message: string };
    type EdgeProvider = { id: string; kind: string; hostnames: string[]; publicOnly: boolean; euEligible: boolean; jurisdiction: Record<string, string>;
      credential: { source: string; present: boolean; fingerprint?: string } };
    type EdgeStatus = { jurisdiction: string; instanceTag: string | null; tagHeaders: string[]; providers: EdgeProvider[];
      purges: Array<{ id: string; provider: string; kind: string; items: number; reason: string; state: string; attempts: number; lastError?: string }> };
    const print = (findings: Finding[]): void => {
      for (const f of findings) console.log(`${f.status.toUpperCase().padEnd(5)} ${f.id.padEnd(30)} ${f.message}`);
    };
    switch (sub) {
      case undefined:
      case 'status': {
        const status = await call('/api/v1/edge') as EdgeStatus;
        out(status);
        if (!values.json) {
          console.log(`jurisdiction ${status.jurisdiction} · instance tag ${status.instanceTag ?? '(none)'} · tag headers ${status.tagHeaders.join(', ') || '(none)'}`);
          for (const p of status.providers) {
            console.log(`${p.id.padEnd(16)} ${p.kind.padEnd(10)} ${p.hostnames.join(',')}${p.publicOnly ? ' (public only)' : ''} · company ${p.jurisdiction.company}, edge ${p.jurisdiction.edgeLocations}, logs ${p.jurisdiction.logs}`
              + ` · credential ${p.credential.source} ${p.credential.present ? (p.credential.fingerprint ?? 'set') : 'MISSING'}`);
          }
          if (!status.providers.length) console.log('(no edge provider configured in instance.json)');
          for (const r of status.purges) console.log(`  ${r.id} ${r.provider} ${r.kind} ×${r.items} ${r.state} (attempt ${r.attempts}) ${r.reason}${r.lastError ? ` · ${r.lastError}` : ''}`);
        }
        break;
      }
      case 'probe': {
        const host = positionals[2];
        if (!host || !/^[a-z0-9.-]+$/.test(host)) fail('usage: lw edge probe <hostname> [--origin https://origin.example] [--json]');
        // Read-only. Zone checks need an owner session on --base; without one only the HTTP checks run.
        let provider: EdgeProvider | undefined;
        let zone: { findings: Finding[] } | null = null;
        const statusRes = await response('/api/v1/edge');
        if (statusRes.ok) {
          const status = await statusRes.json() as EdgeStatus;
          provider = status.providers.find(p => p.hostnames.includes(host));
          if (provider) {
            const verifyRes = await response(`/api/v1/edge/providers/${encodeURIComponent(provider.id)}/verify`);
            const body = await verifyRes.json().catch(() => null) as { findings?: Finding[]; error?: { message?: string } } | null;
            zone = { findings: verifyRes.ok && body?.findings ? body.findings : [{ id: 'zone', status: 'fail', message: body?.error?.message ?? `zone check answered ${verifyRes.status}` }] };
          }
        }
        const http = await runEdgeProbe({ base: `https://${host}`, ...(values.origin ? { origin: values.origin } : {}), publicOnly: !!provider?.publicOnly });
        const findings: Finding[] = [...http, ...(zone?.findings ?? [{ id: 'zone', status: 'info', message: statusRes.ok ? `${host} is not a configured edge hostname on ${base}; zone settings were not read.` : `Sign in as an owner on ${base} to check zone settings too.` }])];
        out({ host, provider: provider?.id ?? null, findings });
        if (!values.json) print(findings);
        if (findings.some(f => f.status === 'fail')) process.exit(1);
        break;
      }
      case 'purge': {
        const tags = values.tag ?? [], urls = values.url ?? [], paths = values.path ?? [];
        if (!tags.length && !urls.length && !paths.length) fail('usage: lw edge purge [--tag <tag>]... [--url https://host/path]... [--path /path]...');
        const r = await call('/api/v1/edge/purge', { method: 'POST', body: { tags, urls, paths } }) as { queued: Array<{ id: string; provider: string; kind: string; items: number }>; refused: string[] };
        out(r);
        if (!values.json) {
          for (const q of r.queued) console.log(`queued ${q.id}: ${q.provider} ${q.kind} ×${q.items}`);
          for (const refused of r.refused) console.log(`refused ${refused}`);
        }
        break;
      }
      case 'credential': {
        const id = positionals[2];
        if (!id) fail('usage: lw edge credential <provider-id> [--rm]   (prompts for the API key or token)');
        if (values.rm) {
          out(await call(`/api/v1/edge/providers/${encodeURIComponent(id)}/credential`, { method: 'DELETE' }));
          if (!values.json) console.log(`credential removed for ${id}`);
          break;
        }
        const secret = await promptHidden(`API key or token for ${id}: `);
        if (!secret) fail('no credential entered');
        const r = await call(`/api/v1/edge/providers/${encodeURIComponent(id)}/credential`, { method: 'PUT', body: { secret } }) as { fingerprint: string; ok: boolean; findings: Finding[] };
        out(r);
        if (!values.json) { console.log(`credential stored (${r.fingerprint}); zone checks ${r.ok ? 'pass' : 'FAIL'}`); print(r.findings); }
        break;
      }
      default:
        fail('usage: lw edge [status] · lw edge probe <hostname> [--origin <url>] · lw edge purge --tag/--url/--path · lw edge credential <id> [--rm]');
    }
    break;
  }

  default: {
    // No command (or -h) is a request for the list, exit 0. An unknown command
    // is an error and must exit non-zero, or a scripted deploy reads it as
    // success.
    const unknown = cmd !== undefined && !values.help;
    const write = unknown ? console.error : console.log;
    if (unknown) write(`lw: unknown command "${cmd}"`);
    write(`lw - lolly-work admin CLI (base: ${base})

  login                      device-code sign-in: confirm the short code in a signed-in browser
  login --email <dev-user>   sign in via the dev provider
  login --cookie 'lw_session=…'   store a browser session
  whoami · summary · fleet · fleet installs · audit verify|head
  tokens [create --label <l> --scopes <s,...> [--tools <id,...>] [--role <r>] | revoke <id>]   service tokens for automation (LW_TOKEN / --token takes precedence; member workflows need login)
  tokens programme <id> <programme> [--company <id>] · tokens programme <id> none   place a token in a partner programme, so a partner's agent is scoped like its people
  tokens limits <id> [--calls-per-minute <n>|none|default] [--renders-per-day …] [--renders-per-month …]   a token's limits, where each comes from, and today's use
  tokens add --programme <id> [--company <id>] --label "…" [--scopes render,catalog.read] [--tools a,b] [--ttl-days 90]   a partner agent's token, issued by the programme's manager
  tokens list|revoke <id>|limits <id> --programme <id> [--company <id>]   that programme's tokens, through its manager's routes
  programmes [ls]   list partner programmes with tool and member counts
  programmes show <id>   show a programme's name, team, tools and member counts
  programmes create <id> --name "…" [--description "…"] [--team <group>] [--tools a,b,…]   create a partner programme
  programmes set <id> [--name "…"] [--description "…"] [--team <group>] [--tools a,b,…]   change the named fields of a partner programme
  programmes rm <id>   remove a partner programme
  programmes limits <id> [--calls-per-minute <n>|none|default] [--renders-per-day …] [--renders-per-month …]   the limits every token placed in a programme takes
  programmes usage <id> [<tokenId>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--by day|week] [--csv]   what the programme's tokens did, counted
  companies [ls] <programme>   list the companies in a partner programme
  companies add <programme> <company> --name "…"   add or rename a partner company
  companies rm <programme> <company>   remove a company from a partner programme
  companies kit show <programme> <company> [--json]   show the company's kit
  companies kit import <programme> <company> [file] --from tokens|lolly|logos [--json]   propose a kit without saving
  companies kit set <programme> <company> <kit.json> [--json]   save a kit as the next asset revision
  companies kit remove <programme> <company> [--json]   retire the kit and clear its pointer
  companies profile show|history <programme> <company> · companies profile set <programme> <company> --field website=… [--field contact.email=…] [--name "…"]   a partner company's details, set up once by the brand team
  companies profile logo <programme> <company> <light|dark|mark> <file> [--dry-run] | --rm · companies profile settings <programme> <company> [--editors <email,…>|none] [--chain <id>|none] [--kit-chain <id>|none]   its logos, checked on upload, and who else may edit
  templates [ls] <programme>   list the templates published to a programme and its companies
  templates publish <programme> --from <inst/id> --groups g1,g2 [--editable a,b|all] [--bindings input=field,…]   publish a catalog template with audience and input rules
  templates upload <programme> <file.lolly> --groups g1,g2   publish a Share with rules file to partner groups
  templates set <programme> <asset> [--groups …] [--editable …|all] [--bindings …]   change a template's audience or input rules
  templates retire <programme> <asset> [--replaced-by <asset>]   stop new starts from a template and name an optional replacement
  templates restore <programme> <asset>   make a retired template available again
  templates only <programme> <tool> on|off   choose whether partners use a tool only through published templates
  mcp config [--name <n>] [--token-env <VAR>] [--json]   paste-ready settings for the organisation MCP endpoint
  invite add <email...> [--group g]... [--expires <ISO>]   let these addresses sign in; prints the sign-in address to share
  invite ls [--all] · invite rm <id>   open invitations (--all adds revoked ones); revoke one
  people import <programme> <file.csv|-> [--apply]   add a list to a partner programme: email, name, company, end date (preview unless --apply)
  people exit --programme <id> | --company <id> | --domain <d> | <emails-file> [--projects team-readonly|me-readonly|me|keep] [--at YYYY-MM-DD [--no-notice]] [--apply]   end a partnership in one audited step, now or at the end of a day
  people exits <programme>   a programme's ends, newest first, with whether Reopen is offered
  people reopen <exit> [--keep-projects] [--apply]   undo an end within 30 days: people, groups, templates, folders, domain rules and projects come back
  domains [ls] [--programme <id>] · domains add <domain> --programme <id> [--company <id>] [--ends YYYY-MM-DD] [--assert [--reason "…"]] [--move-staff <id,...>] [--dry-run]   partner domains: proved by DNS, or by your say-so (audited); staff move only by name
  domains check <domain> · domains rm <domain> [--programme <id>]   look the DNS record up now; stop new people joining through a domain
  folders [ls] --programme <id> · folders add <provider> <path>|--whole · folders rm <provider> <path> --programme <id> [--company <id>] [--ends YYYY-MM-DD]   give one provider folder to a programme or company
  programmes rights-report <programme>   what the licence gate lets through and holds back, by source, and the staff links that would lose files
  retention run              apply the stated retention policy (including the deleted-document purge) and sweep expired uploads now (both also run daily on the long-lived server)
  users erase-preview <id>   read-only reference counts and account-erasure scope (owner)
  users subject-export <id>  bounded partial metadata page (owner; --category, --cursor, --limit)
  users offboard-preview <id> bounded direct issuance counts and remaining review (owner)
  users offboard <id>        disable, end sessions and revoke direct issuance (owner; retains content)
  users erase <id>           atomic account-row removal + telemetry de-attribution (owner; retained references block it)
  projects transfer-preview <id> [--json] [--out new-file.json]   read-only project inventory (signed-in manager; not an export/import)
  brand                      inspect design-system sources and permissions
  brand preview <action> <source-id> [--replacement <id>]  review an impact as JSON
  brand apply <preview.json> apply that reviewed revision
  instance                   the public instance manifest (what a fresh app reads)
  instance pack <file.lolly> host the signed instance pack cut by the OSS builder (owner)
  instance pack-rm           stop hosting the pack
  migrate [--check]          apply pending migrations (needs local DATABASE_URL; --check = status, exit 1 if pending)
                             LW_MIGRATE_EXPECT=none|a.sql,b.sql|sha256:<manifest> refuses any other pending set
  audit retire-key --reason "…" [--expect-head <seq>:<hash>] [--dry-run]   after rotating LW_SESSION_SECRET without its old value: record a retired-key boundary (needs local DATABASE_URL + LW_SESSION_SECRET)
  c2pa init [--org N] [--out dir]   mint a C2PA signing identity (root+leaf) for real signed exports
  export [--out file]        dump governance (grants, overlays, chains, providers, flags) as canonical JSON
  apply <file> [--dry-run] [--prune]   apply a governance document (dry-run shows the diff; prune removes store-only entries)
  links [--all] · links create <toolId> [key=value ...] [--open] · links revoke <id>
  destinations                list the fixed organization targets available to this principal (no secrets)
  approvals [list] · approvals artifact <id> --out <file>   your requests and inbox; download a request's file (a reviewer's, or yours once approved)
  intent resolve <intent.json|-> [--json]   choose the tool for each surface of a visual intent, without rendering (exit 4 unless every surface is ready)
  renders submit <request.json> [--idempotency-key <key>] [--callback-url <url>]   submit a recoverable single render
  renders [list|show <id>|cancel <id>|retry <id>] · renders output <id> --out <file>
  renders evidence <id> --out <file>   download the retained execution receipt
  renders deliver <id> --destination <id> --name "…" [--idempotency-key <key>]   send a finished output to a destination by reference
  render-batches submit <request.json> [--idempotency-key <key>] [--callback-url <url>]   submit durable rows
  render-batches [list|show <id>|cancel <id>|retry <id>] · render-batches manifest <id> --out <file> · render-batches archive <id> --out <file>
  brand-pages [list] · brand-pages publish <folder>   put a brand page folder at a public address on this instance
  brand-pages history <slug> · brand-pages unpublish <slug> [--remove-files]   read a page's revisions; take a page down (it then answers 410)
  render-api inventory --from <bannerbear-v5|bannerbear-v2|placid> --token-env <NAME> --out <dir> [--source-url <url>] [--max-pages <n>] [--no-previews]   read a vendor account, read only, no server needed
  render-api check --mapping <file>   read a mapping against the effective schema on this instance
  render-api sample --from <source> --template <id> --token-env <NAME> --values <file> --out <dir> --spend-credits   keep a vendor render as a reference; spends vendor credits
  render-api compare --from <source> --mapping <file> --template <id> --reference <file> [--values <file>] [--regions <file>] [--max-changed <n>] [--tolerance <n>]   measure a render here against a reference
  deliveries [list|show <id>|retry <id>]
  deliveries publish <jobId> --destination <id> --name "…" [--idempotency-key <key>]   publish a retained render output by reference
  providers [list] · providers add <id> --kind … --label "…" [--options/--mapping/--exposure {json}]
  providers preview --kind <kind> [--options/--mapping/--exposure {json}]   dry run: health + a mapped sample of this tenant, nothing stored
  providers preview --kind <kind> --shape [--remote-id <id>]   instead of the sample: the tenant's record structure, key names and types only
  providers credential <id> (prompts) · auth <id> (OAuth consent) · enable|disable|sync|health|rm <id>
  providers drift <id>       materialized copies whose upstream updatedAt has moved on
  upload <file> --project <id> | --scope catalog-submission|automation-input|file [--name "…"] [--content-type <t>]   resumable upload; run it again to resume
  catalog submit <file> [--name "…"] [--tags a,b] [--groups a,b]   put a file into this instance's catalog
  catalog queue [--all] · catalog edit <assetId> [--name --tags --type --label]   the review queue, and a fix before publishing
  catalog approve|return <assetId> [--body "comment"]   decide one submission
  catalog fields · catalog meta <assetId> [--field k=v] [--name --tags --label]   the org's own metadata on a served asset
  catalog collections · catalog collection <id> [--name --members a,b --groups x,y --label] | --rm   named, ordered, shareable sets
  catalog submit <file> --asset inst/<id> [--note "…"]   new bytes for an asset already in the catalog: version N+1
  catalog versions <id> · catalog rollback <id> <n> · catalog version-rm <id> <n>   the byte history, and moving the head
  catalog supersede <id> <replacementId> | --rm   retire an asset in favour of another (replacedBy)
  catalog rights [ls] · catalog rights mark <scope> [--holder --terms --note] · unmark <scope>   say a folder (folder:<provider>/<path>), provider, id prefix or asset is your own
  catalog rights licence <assetId> <declaration> [--attribution --note] · unlicence <assetId>   record the licence of a file that records none
  grants [list] · grants add|rm <principal> <action> [<resource>] --effect deny|allow
  scim token create --idp <provider-id> | list | revoke <id>   provisioning bearers for an IdP (SCIM /scim/v2)
  preview --groups a,b   what a member in those groups would receive
  msg send --title "…" [--body --kind --severity --groups a,b --shells tauri --max-engine 1.52.99 --starts <ISO> --ends <ISO>]
  edge [status]              configured CDN providers, credential fingerprints and recent purges (owner)
  edge probe <hostname> [--origin <url>]   read-only: private answers uncached, headers intact, transforms refused, zone settings
  edge purge [--tag t]... [--url u]... [--path p]...   queue a purge on every configured provider (owner)
  edge credential <id> [--rm]   seal a provider API key or token (prompts; never argv)

  --base <url> or LW_BASE   instance to talk to · --json for machine output`);
    if (unknown) process.exit(1);
    break;
  }
}
