#!/usr/bin/env node
/**
 * lw - the lolly-work admin CLI. A thin wrapper over the same API the console
 * uses, so the two surfaces grow in parity by construction (plans: console
 * first, CLI follows).
 *
 *   LW_BASE=https://lolly.example lw login --email admin@test   # dev provider
 *   lw whoami | summary | fleet | links [--all] | links revoke <id>
 *   lw msg send --title "…" [--severity action --groups a,b --max-engine 1.52.99]
 *   lw audit verify
 *
 * Auth: dev-provider login stores the session cookie at
 * ~/.config/lolly-work/session (0600). Against an OIDC instance, sign in in a
 * browser and `lw login --cookie 'lw_session=…'` - a device-code flow is the
 * planned replacement.
 */
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'lolly-work');
const SESSION_FILE = join(CONFIG_DIR, 'session');

const OPTIONS = {
    help: { type: 'boolean', short: 'h' },
    base: { type: 'string' },
    email: { type: 'string' },
    cookie: { type: 'string' },
    all: { type: 'boolean' },
    title: { type: 'string' },
    body: { type: 'string' },
    kind: { type: 'string' },
    severity: { type: 'string' },
    groups: { type: 'string' },
    shells: { type: 'string' },
    'max-engine': { type: 'string' },
    effect: { type: 'string' },
    label: { type: 'string' },
    options: { type: 'string' },
    mapping: { type: 'string' },
    exposure: { type: 'string' },
    section: { type: 'string' },
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
    'replaced-by': { type: 'string' },
    rm: { type: 'boolean' },
    // SCIM (plans/31 §8): the label for the IdP connector a provisioning token
    // belongs to, carried onto every audit event the token drives.
    idp: { type: 'string' },
    check: { type: 'boolean' },
    out: { type: 'string' },
    in: { type: 'string' },
    org: { type: 'string' },
    days: { type: 'string' },
    shape: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    prune: { type: 'boolean' },
    json: { type: 'boolean' },
} as const;

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

async function call(path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const cookie = savedCookie();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-lolly-client': 'lw-cli engine/0',
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    // A stack trace out of node:net tells a first-time operator nothing. The
    // answer is always the same: the instance is elsewhere, or is not up.
    fail(`cannot reach ${base} — start the instance, or point at it with --base <url> (or LW_BASE)`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    fail(`${res.status} ${err?.code ?? ''} ${err?.message ?? ''}`.trim());
  }
  return data;
}

function fail(msg: string): never {
  console.error(`lw: ${msg}`);
  process.exit(1);
}

function out(value: unknown): void {
  if (values.json) console.log(JSON.stringify(value, null, 2));
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
  case 'login': {
    if (values.cookie) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(SESSION_FILE, values.cookie, { mode: 0o600 });
      console.log('session cookie saved.');
      break;
    }
    const email = values.email ?? fail('--email required for dev login (or --cookie for a browser session)');
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    if (res.status !== 302) fail(`dev login refused (${res.status}) — is dev.enabled on, and the email in dev.users?`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
    if (!cookie) fail('no session cookie in response');
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, cookie as string, { mode: 0o600 });
    console.log(`signed in as ${email} against ${base}`);
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
    const { clients } = await call('/api/v1/fleet') as { clients: Array<{ bucket: string; count: number; lastSeenAt: string }> };
    out(clients);
    if (!values.json) for (const c of clients) console.log(`${String(c.count).padStart(6)}  ${c.bucket}  (last ${c.lastSeenAt})`);
    break;
  }

  case 'links': {
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

  case 'msg': {
    if (sub !== 'send') fail('usage: lw msg send --title "…"');
    const title = values.title ?? fail('--title required');
    const audience: Record<string, unknown> = {};
    if (values.groups) audience.groups = values.groups.split(',').map((s) => s.trim());
    if (values.shells) audience.shells = values.shells.split(',').map((s) => s.trim());
    if (values['max-engine']) audience.maxEngine = values['max-engine'];
    const msg = await call('/api/v1/messages', { method: 'POST', body: {
      title, body: values.body, kind: values.kind ?? 'announcement', severity: values.severity ?? 'info', audience,
    } });
    out(msg);
    if (!values.json) console.log(`sent ${(msg as { id: string }).id}`);
    break;
  }

  // SCIM provisioning tokens (plans/31 §8). The mint prints the secret ONCE -
  // it is not recoverable from the stored hash - so it goes to stdout for the
  // operator to paste into the IdP connector, and never to the audit trail.
  case 'scim': {
    if (sub !== 'token') fail('usage: lw scim token create --idp <label> | list | revoke <id>');
    const action = positionals[2];
    if (action === 'create') {
      const idp = values.idp ?? fail('usage: lw scim token create --idp <label>');
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
            credential: { fingerprint: string } | null;
            state: { assetCount: number; lastSyncAt: string | null; lastError: string | null } }>;
        };
        out(providers);
        if (!values.json) {
          for (const p of providers) {
            const status = p.enabled ? (p.state.lastError ? 'error' : 'enabled') : 'disabled';
            console.log(`${status.padEnd(9)} ${p.id.padEnd(20)} ${p.kind.padEnd(12)} ${String(p.state.assetCount).padStart(5)} assets  cred ${p.credential?.fingerprint ?? '—'}  ${p.managedBy === 'config' ? '[config]' : ''}`);
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
        if (!id) fail('usage: lw providers credential <id>   (prompts for the secret)');
        const secret = await promptHidden(`secret for ${id}: `);
        if (!secret) fail('no secret entered');
        const r = await call(`/api/v1/catalog/providers/${id}/credential`, { method: 'PUT', body: { secret } }) as { fingerprint: string; health: { ok: boolean } };
        out(r);
        console.log(`credential stored (${r.fingerprint}) — health ${r.health.ok ? 'ok' : 'FAILED'}`);
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
    if (sub === 'head') {
      const head = await call('/api/v1/audit/head') as { seq: number; hash: string; at: string | null; count: number; chainIntact: boolean; badSeq?: number };
      out(head);
      if (!values.json) console.log(head.chainIntact
        ? `head #${head.seq} · ${head.hash} · ${head.count} events · intact`
        : `head #${head.seq} · ${head.hash} · CHAIN BROKEN at #${head.badSeq}`);
      if (!head.chainIntact) process.exit(2);
      break;
    }
    if (sub !== 'verify') fail('usage: lw audit verify|head');
    const { chain, total } = await call('/api/v1/audit?limit=1') as { chain: { ok: boolean; badSeq?: number }; total: number };
    out({ chain, total });
    if (!values.json) console.log(chain.ok ? `chain intact · ${total} events` : `CHAIN BROKEN at #${chain.badSeq} · ${total} events`);
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
      for (const cat of ['grants', 'overlays', 'chains', 'providers', 'featureFlags'] as const) {
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
    const { runMigrations, pendingMigrations } = await import('../server/src/store/migrate.ts');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../migrations', import.meta.url));
    if (sub === 'status' || values.check) {
      const pending = await pendingMigrations(url, dir);
      out({ pending, current: pending.length === 0 });
      if (!values.json) console.log(pending.length ? `${pending.length} pending: ${pending.join(', ')}` : 'schema current');
      if (pending.length) process.exit(1);
      break;
    }
    const applied = await runMigrations(url, dir);
    out({ applied });
    if (!values.json) console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply (schema current)');
    break;
  }

  default: {
    // No command (or -h) is a request for the list, exit 0. An unknown command
    // is an error and must exit non-zero, or a scripted deploy reads it as
    // success.
    const unknown = cmd !== undefined && !values.help;
    const write = unknown ? console.error : console.log;
    if (unknown) write(`lw: unknown command "${cmd}"`);
    write(`lw — lolly-work admin CLI (base: ${base})

  login --email <dev-user>   sign in via the dev provider
  login --cookie 'lw_session=…'   store a browser session
  whoami · summary · fleet · audit verify|head
  migrate [--check]          apply pending migrations (needs local DATABASE_URL; --check = status, exit 1 if pending)
  c2pa init [--org N] [--out dir]   mint a C2PA signing identity (root+leaf) for real signed exports
  export [--out file]        dump governance (grants, overlays, chains, providers, flags) as canonical JSON
  apply <file> [--dry-run] [--prune]   apply a governance document (dry-run shows the diff; prune removes store-only entries)
  links [--all] · links revoke <id>
  providers [list] · providers add <id> --kind … --label "…" [--options/--mapping/--exposure {json}]
  providers preview --kind <kind> [--options/--mapping/--exposure {json}]   dry run: health + a mapped sample of this tenant, nothing stored
  providers preview --kind <kind> --shape [--remote-id <id>]   instead of the sample: the tenant's record structure, key names and types only
  providers credential <id> (prompts) · auth <id> (OAuth consent) · enable|disable|sync|health|rm <id>
  providers drift <id>       materialized copies whose upstream updatedAt has moved on
  catalog submit <file> [--name "…"] [--tags a,b] [--groups a,b]   put a file into this instance's catalog
  catalog queue [--all] · catalog edit <assetId> [--name --tags --type --label]   the review queue, and a fix before publishing
  catalog approve|return <assetId> [--body "comment"]   decide one submission
  catalog fields · catalog meta <assetId> [--field k=v] [--name --tags --label]   the org's own metadata on a served asset
  catalog collections · catalog collection <id> [--name --members a,b --groups x,y --label] | --rm   named, ordered, shareable sets
  catalog submit <file> --asset inst/<id> [--note "…"]   new bytes for an asset already in the catalog: version N+1
  catalog versions <id> · catalog rollback <id> <n> · catalog version-rm <id> <n>   the byte history, and moving the head
  catalog supersede <id> <replacementId> | --rm   retire an asset in favour of another (replacedBy)
  grants [list] · grants add|rm <principal> <action> [<resource>] --effect deny|allow
  scim token create --idp <label> | list | revoke <id>   provisioning bearers for an IdP (SCIM /scim/v2)
  preview --groups a,b   what a member in those groups would receive
  msg send --title "…" [--body --kind --severity --groups a,b --shells tauri --max-engine 1.52.99]

  --base <url> or LW_BASE — instance to talk to · --json for machine output`);
    if (unknown) process.exit(1);
    break;
  }
}
