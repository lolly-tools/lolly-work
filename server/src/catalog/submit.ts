/**
 * Catalog submit (plans/31 section 3) - the one route by which a member's bytes
 * enter the instance catalog.
 *
 * Until this landed, bytes only ever arrived by server-side pull from a
 * federated provider (plans/17) or the exit's materialize (plans/27), and the
 * single inbound-bytes route was publish-OUT. `catalog.submit` had been an RBAC
 * action with no route behind it since plans/26. That is the difference between
 * governing a DAM and replacing one: a brand manager can now put the new
 * campaign photography into the catalog from a browser.
 *
 * The pipeline runs in the order plans/31 section 3 fixes, and the order is the
 * design:
 *
 *   1. size cap (`policy.submit.maxBytes`, enforced by the route's readRaw) and
 *      the per-group quota, which is checked cheaply here and ENFORCED by an
 *      atomic charge just before the store write, so concurrent submissions
 *      cannot all pass one stale read;
 *   2. sha256, with an exact duplicate short-circuiting to the asset that
 *      already holds those bytes - REPORTED, never an error;
 *   3. the operator-pluggable pre-store scan hook, which vetoes BEFORE anything
 *      is stored (the whole point of it being pre-store);
 *   4. BlobStore.put, then an instance-asset record in state `submitted`;
 *   5. content-credential DETECTION, recorded and badged - and unlike
 *      publish-out a lolly export assertion is NOT required, because a
 *      submission is an arbitrary org file, not our own signed export;
 *   6. an approval when `policy.submit.chain` names one, and otherwise `live`
 *      immediately. Open to authors is the default of record: defaults set
 *      direction, orgs buy limits - and a chain policy names but the instance
 *      does not have is a refusal, because the limit an org bought has to hold
 *      once bought.
 *
 * Everything here is store-and-blobs only. Audit, inbox and HTTP status mapping
 * belong to the route, so this module stays testable without a server.
 */
import { spawn } from 'node:child_process';
import { createApproval, type Approval, type Chain } from '../approvals/engine.ts';
import { detectCredential, type CredentialStatus } from './credentials.ts';
import {
  instanceAssetEntry, instanceAssetVisible, submissionServable, INST_PREFIX,
  type AssetSubmission, type InstanceAssetRecord,
} from './instance-assets.ts';
import type { SubmitPolicy, SubmitScanHook } from '../config/instance.ts';
import type { BlobStore } from '../blobs/types.ts';
import type { Store } from '../store/types.ts';
import { randomId, sha256Hex } from '../lib/crypto.ts';

// ── byte sniffing ───────────────────────────────────────────────────────────

export interface SniffResult {
  contentType: string;
  /** Lowercase format name; doubles as the blob key and the URL segment. */
  format: string;
  width?: number;
  height?: number;
}

const SVG_DIM = (svg: string, attr: 'width' | 'height'): number | undefined => {
  const m = new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([0-9.]+)`, 'i').exec(svg);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** JPEG carries its dimensions in a start-of-frame segment, which sits after a
 *  variable number of metadata segments, so it has to be walked. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    i += 2 + len;
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/**
 * Identify submitted bytes from the bytes themselves. The submitter's declared
 * content-type and filename are hints of last resort only: a client that lies
 * about a file's type must not decide what the catalog serves it as, and
 * `x-content-type-options: nosniff` on the blob routes only helps if what we
 * stored was honest in the first place.
 */
export function sniffBytes(buf: Buffer, declared?: { contentType?: string; filename?: string }): SniffResult {
  const magic = (hex: string, at = 0): boolean => buf.length >= at + hex.length / 2 && buf.toString('hex', at, at + hex.length / 2) === hex;
  if (magic('89504e470d0a1a0a')) {
    const png: SniffResult = { contentType: 'image/png', format: 'png' };
    if (buf.length >= 24) { png.width = buf.readUInt32BE(16); png.height = buf.readUInt32BE(20); }
    return png;
  }
  if (magic('ffd8ff')) return { contentType: 'image/jpeg', format: 'jpg', ...jpegSize(buf) };
  if (buf.toString('ascii', 0, 4) === 'GIF8' && buf.length >= 10) {
    return { contentType: 'image/gif', format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', format: 'webp', ...webpSize(buf) };
  }
  if (magic('25504446')) return { contentType: 'application/pdf', format: 'pdf' };
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024));
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    const svg = buf.toString('utf8', 0, Math.min(buf.length, 4096));
    const open = svg.slice(svg.search(/<svg[\s>]/i));
    const tag = open.slice(0, open.indexOf('>') + 1 || open.length);
    const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    const width = SVG_DIM(tag, 'width') ?? (box ? Math.round(Number(box[1])) : undefined);
    const height = SVG_DIM(tag, 'height') ?? (box ? Math.round(Number(box[2])) : undefined);
    return {
      contentType: 'image/svg+xml', format: 'svg',
      ...(width ? { width } : {}), ...(height ? { height } : {}),
    };
  }
  // Unrecognized container: keep the bytes, stay honest about not knowing what
  // they are. The extension names the format so the URL is readable; the served
  // content-type falls back to the generic one rather than to the client's word.
  const ext = (declared?.filename ?? '').split('.').pop() ?? '';
  const format = /^[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : 'bin';
  return { contentType: 'application/octet-stream', format };
}

// ── the pre-store scan hook ─────────────────────────────────────────────────

export type ScanVerdict =
  | { verdict: 'allow' }
  | { verdict: 'reject'; reason: string }
  /** The hook could not ANSWER (timeout, refused connection, missing binary).
   *  Distinct from a hook that answered "reject", because `onError` decides it. */
  | { verdict: 'error'; reason: string };

/** Keep a hook's own words, but never let them become the response body. */
const clip = (s: string, n = 300): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A submitter-chosen name safe to put in a request header. Header values are
 * ByteStrings, so a single character above U+00FF (any CJK, Cyrillic or emoji
 * filename) throws while the request is being built - and a throw here is an
 * unanswered scan, which under `onError: 'allow'` would let the submitter
 * choose whether the operator's scanner runs at all. Percent-encoding is the
 * same posture `safeFilename` takes on the Content-Disposition way out: never
 * let a value the submitter controls decide whether a gate runs.
 */
const headerSafe = (raw: string): string => encodeURIComponent(raw).slice(0, 200);

/**
 * Run the operator's scan hook over the bytes, before anything is stored.
 *
 * BOTH transports ship, and the split is deliberate. `exec` is the
 * zero-moving-parts path for the single-node deploy this product optimizes for:
 * `clamdscan -` reads stdin and answers with an exit code, so wiring ClamAV is
 * a config line and no new service. `http` is the only path that works where
 * the plane has no local process to spawn (a serverless deploy) or where the
 * scanner is an ICAP gateway the security team already runs. Shipping one would
 * push half of the operators onto a workaround, and both are a few lines over
 * built-ins - no dependency either way.
 *
 * lolly-work ships the hook and never a scanner: no engine, no signatures, no
 * updates (plans/31 section 9).
 */
export async function runScanHook(
  hook: SubmitScanHook,
  bytes: Buffer,
  meta: { checksum: string; filename: string; contentType: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ScanVerdict> {
  if (hook.kind === 'http') {
    try {
      const res = await fetchImpl(hook.target, {
        method: 'POST',
        headers: {
          'content-type': meta.contentType,
          'content-length': String(bytes.length),
          'x-lolly-submit-sha256': meta.checksum,
          'x-lolly-submit-filename': headerSafe(meta.filename),
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(hook.timeoutMs),
      });
      if (res.ok) return { verdict: 'allow' };
      const body = clip(await res.text().catch(() => ''));
      return { verdict: 'reject', reason: body || `the scan gateway answered ${res.status}` };
    } catch (err) {
      return { verdict: 'error', reason: clip((err as Error).message) };
    }
  }
  return new Promise<ScanVerdict>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.target, hook.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ verdict: 'error', reason: clip((err as Error).message) });
      return;
    }
    const out: Buffer[] = [];
    let settled = false;
    const done = (v: ScanVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ verdict: 'error', reason: `the scan command did not answer within ${hook.timeoutMs}ms` });
    }, hook.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => out.push(c));
    child.on('error', (err) => done({ verdict: 'error', reason: clip(err.message) }));
    child.on('close', (code) => {
      if (code === 0) return done({ verdict: 'allow' });
      const said = clip(Buffer.concat(out).toString('utf8'));
      done({ verdict: 'reject', reason: said || `the scan command exited ${code}` });
    });
    // An unwritable stdin (the command died on spawn) surfaces through 'error'.
    child.stdin?.on('error', () => { /* handled by the child's own error/close */ });
    child.stdin?.end(new Uint8Array(bytes));
  });
}

// ── quota ───────────────────────────────────────────────────────────────────

/**
 * The scopes one submitter's bytes are charged to: every group they belong to,
 * or '*' when they belong to none. Charging every membership is the
 * conservative direction and the one that cannot be gamed: joining more groups
 * only ever tightens a member's budget, it never buys more of it.
 */
export function quotaScopes(groups: string[]): string[] {
  const scopes = [...new Set(groups.filter(Boolean))];
  return scopes.length ? scopes : ['*'];
}

/**
 * Why one scope may not spend `size` more bytes, or null when it may. `used` is
 * what the scope had spent BEFORE this submission, so the same wording serves
 * the advisory pre-check and the post-charge verification (which subtracts the
 * charge it just made to get back to `used`).
 */
export function quotaRefusal(
  policy: SubmitPolicy, scope: string, used: { bytes: number; count: number }, size: number,
): string | null {
  if (policy.quota.bytes > 0 && used.bytes + size > policy.quota.bytes) {
    return `group ${scope} has used ${used.bytes} of its ${policy.quota.bytes} byte submit quota`;
  }
  if (policy.quota.count > 0 && used.count + 1 > policy.quota.count) {
    return `group ${scope} has used all ${policy.quota.count} of its submissions`;
  }
  return null;
}

// ── the pipeline ────────────────────────────────────────────────────────────

export interface SubmitDeps {
  store: Store;
  blobs: BlobStore;
  policy: SubmitPolicy;
  scanHook?: SubmitScanHook;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SubmitInput {
  bytes: Buffer;
  /** Declared display name; also the filename hint for sniffing and the hook. */
  name: string;
  description?: string;
  tags?: string[];
  /** Declared asset type; defaults from the sniff (svg reads as an icon). */
  type?: string;
  /** Exposure groups for the new asset. Absent means every member sees it. */
  groups?: string[];
  contentType?: string;
  submitter: { id: string; groups: string[] };
}

export type SubmitRefusal =
  | { ok: false; code: 'QUOTA_EXCEEDED'; detail: string }
  | { ok: false; code: 'SCAN_REJECTED'; detail: string }
  | { ok: false; code: 'SCAN_UNAVAILABLE'; detail: string }
  /** `policy.submit.chain` names a chain this instance does not have, or one
   *  with no steps. The review an org bought cannot run, so nothing is taken. */
  | { ok: false; code: 'SUBMIT_CHAIN_MISSING'; detail: string };

export interface SubmitAccepted {
  ok: true;
  record: InstanceAssetRecord;
  /** True when these exact bytes were already in the catalog: the existing
   *  asset is returned and nothing new is stored (plans/31 section 3 step 2). */
  duplicate: boolean;
  checksum: string;
  /** What the scan hook did: `clean` when it answered and passed the bytes,
   *  `absent` when the instance configures none, `skipped` on a duplicate
   *  (nothing was stored, so nothing needed scanning), and `unavailable` when a
   *  hook IS configured but could not answer and `onError: 'allow'` let the
   *  submission through anyway. Reported rather than assumed, because "we did
   *  not scan" and "we scanned and it was clean" are different facts - so an
   *  outage the operator chose to ride out never reads as a clean scan, in the
   *  response or in the audit event. */
  scan: 'clean' | 'absent' | 'skipped' | 'unavailable';
  credential: CredentialStatus;
  approval?: Approval;
}

export type SubmitOutcome = SubmitAccepted | SubmitRefusal;

/**
 * The instance asset (if any) that already holds these exact bytes AND that this
 * submitter may actually be handed: a submission's own checksum, or any stored
 * format's checksum, so a materialized copy counts as a duplicate too.
 *
 * The visibility filter is not decoration. Without it the short-circuit is a
 * confirmed-file oracle - submit a file, learn from the `duplicate: true`
 * response whether this instance already holds those exact bytes, plus the id,
 * size and state of an asset the submitter cannot see - and a checksum hit on a
 * `submitted` or `returned` record would silently drop a legitimate
 * contribution behind an asset that may never go live, or never can. A hit
 * outside this set falls through to the ordinary store path: a second copy is
 * the honest outcome.
 */
export function findByChecksum(
  records: InstanceAssetRecord[], checksum: string, callerGroups: string[],
): InstanceAssetRecord | undefined {
  return records.find((r) =>
    submissionServable(r) && instanceAssetVisible(r, callerGroups) &&
    (r.submission?.checksum === checksum ||
      (r.entry.formats ?? []).some((f) => (f as { checksum?: string }).checksum === checksum)));
}

export async function submitAsset(deps: SubmitDeps, input: SubmitInput): Promise<SubmitOutcome> {
  const { store, blobs, policy } = deps;
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  const size = input.bytes.length;

  const scopes = quotaScopes(input.submitter.groups);
  const capped = policy.quota.bytes > 0 || policy.quota.count > 0;

  // 1. Quota, half one: the cheap read-only refusal, so a group that is already
  //    out of budget is told so without the instance hashing the bytes, running
  //    the operator's scanner over them, or touching the BlobStore on its
  //    behalf. This read is ADVISORY - it can go stale between here and the
  //    store, so it is not what enforces the cap; the atomic charge below is
  //    (half two). The order plans/31 fixes still puts the quota first.
  if (capped) {
    for (const scope of scopes) {
      const row = await store.getSubmitQuota(scope);
      const over = quotaRefusal(policy, scope, { bytes: row?.bytes ?? 0, count: row?.count ?? 0 }, size);
      if (over) return { ok: false, code: 'QUOTA_EXCEEDED', detail: over };
    }
  }

  // 1b. A chain that policy names but the instance does not have is a REFUSAL,
  //     not open publishing. `policy.submit.chain` lives in instance.json while
  //     chains are seeded from the policy config doc, so the two documents can
  //     drift on a rename or a first-boot ordering - and the org that bought
  //     review would get none of it, with nothing in the audit trail saying so.
  //     A governance control a typo turns off is the one that has to fail
  //     closed. Checked here, before anything is hashed or stored, so a refusal
  //     leaves no orphan bytes behind. The rest of the app refuses a missing
  //     chain the same way (api/app.ts, POST /api/v1/approvals).
  const chain: Chain | null = policy.chain ? await store.getChain(policy.chain) : null;
  if (policy.chain && !chain?.steps.length) {
    return {
      ok: false, code: 'SUBMIT_CHAIN_MISSING',
      detail: `policy.submit.chain names ${policy.chain}, which this instance has no usable chain for`,
    };
  }

  // 2. Content hash, and the duplicate short-circuit. Reported, never an error:
  //    the submitter asked for these bytes to be in the catalog, and they are.
  //    Only an asset this submitter could already be handed counts as the
  //    duplicate (findByChecksum), so the short-circuit can neither confirm a
  //    file they cannot see nor drop their contribution behind one.
  const checksum = sha256Hex(input.bytes);
  const existing = findByChecksum(await store.listInstanceAssets(), checksum, input.submitter.groups);
  if (existing) {
    return {
      ok: true, duplicate: true, record: existing, checksum, scan: 'skipped',
      credential: (await store.getCredential(existing.id))?.status ?? 'none',
    };
  }

  const sniffed = sniffBytes(input.bytes, { ...(input.contentType ? { contentType: input.contentType } : {}), filename: input.name });

  // 3. The pre-store scan hook. Before BlobStore.put, so a veto means the bytes
  //    were never written anywhere. What the hook actually did is carried
  //    forward rather than inferred from "a hook is configured": under
  //    `onError: 'allow'` an unreachable scanner still lets the bytes through,
  //    and that submission must not go on record as scanned and clean.
  let scan: SubmitAccepted['scan'] = deps.scanHook ? 'clean' : 'absent';
  if (deps.scanHook) {
    const verdict = await runScanHook(deps.scanHook, input.bytes, {
      checksum, filename: input.name, contentType: sniffed.contentType,
    }, deps.fetchImpl ?? fetch);
    if (verdict.verdict === 'reject') return { ok: false, code: 'SCAN_REJECTED', detail: verdict.reason };
    if (verdict.verdict === 'error') {
      if (deps.scanHook.onError === 'reject') return { ok: false, code: 'SCAN_UNAVAILABLE', detail: verdict.reason };
      scan = 'unavailable';
    }
  }

  // 4a. Quota, half two: CHARGE, then verify what the charge landed on. This is
  //     what actually enforces the cap. The pre-check above is a read followed
  //     much later by a write, and everything in between - the duplicate
  //     lookup, the operator's scanner, the blob put - is time in which every
  //     other concurrent submission reads the same pre-value and passes. Adding
  //     first closes that window, because `addSubmitQuota` is one statement that
  //     returns the row AFTER the add: concurrent submissions serialize on the
  //     row, so exactly one of them sees the value that is over the cap. A
  //     refusal reverses every charge it made - this is a reservation being
  //     released, not a spent counter being decremented.
  const charged: string[] = [];
  const release = async (): Promise<void> => {
    for (const scope of charged) await store.addSubmitQuota(scope, -size, -1);
  };
  for (const scope of scopes) {
    const row = await store.addSubmitQuota(scope, size, 1);
    charged.push(scope);
    if (!capped) continue;
    const over = quotaRefusal(policy, scope, { bytes: row.bytes - size, count: row.count - 1 }, size);
    if (over) {
      await release();
      return { ok: false, code: 'QUOTA_EXCEEDED', detail: over };
    }
  }

  // 4b. Store the bytes, then the record, in state `submitted`. A failure on
  //     either releases the charge: nothing was kept, so nothing was spent.
  const id = `${INST_PREFIX}${randomId(8)}`;
  let stat: Awaited<ReturnType<BlobStore['put']>>;
  try {
    stat = await blobs.put(`${id}/${sniffed.format}`, input.bytes, sniffed.contentType);
  } catch (err) {
    await release();
    throw err;
  }
  const submission: AssetSubmission = {
    state: 'submitted',
    by: `user:${input.submitter.id}`,
    at: nowIso,
    checksum: stat.checksum,
    size: stat.size,
    contentType: sniffed.contentType,
    ...(sniffed.width ? { width: sniffed.width } : {}),
    ...(sniffed.height ? { height: sniffed.height } : {}),
  };
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  let record: InstanceAssetRecord = {
    id,
    entry: instanceAssetEntry(id, {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      type: input.type || (sniffed.format === 'svg' ? 'icon' : 'image'),
      tags,
      ...(sniffed.width && sniffed.height ? { width: sniffed.width, height: sniffed.height } : {}),
    }, [{ format: sniffed.format, size: stat.size, checksum: stat.checksum }]),
    blobs: { [sniffed.format]: `${id}/${sniffed.format}` },
    ...(input.groups?.length ? { groups: input.groups } : {}),
    submission,
    createdAt: nowIso,
  };
  try {
    await store.putInstanceAsset(record);
  } catch (err) {
    await release();
    throw err;
  }

  // 5. Content credentials: DETECTION only. A submission is an arbitrary org
  //    file, so unlike publish-out there is no lolly export assertion to verify
  //    and nothing is refused for the absence of one (plans/27 section 4).
  const detected = await detectCredential(input.bytes);
  await store.putCredential({
    assetId: id, status: detected.status, ...(detected.container ? { container: detected.container } : {}),
    sniffedAt: nowIso,
  });

  // 6. Review, or live. With no chain configured the asset is live the moment
  //    it is stored - the resolved default of record (plans/31 section 11.1).
  //    A chain named but missing never reaches here: it was refused at 1b.
  let approval: Approval | undefined;
  if (chain && chain.steps.length) {
    approval = createApproval({
      id: `apr_${randomId(8)}`,
      subjectType: 'asset',
      subjectRef: id,
      title: `Catalog submission: ${input.name}`.slice(0, 200),
      chain, nominees: [], createdBy: input.submitter.id, now: nowIso,
    });
    await store.putApproval(approval);
    record = { ...record, submission: { ...submission, approvalId: approval.id } };
    await store.putInstanceAsset(record);
  } else {
    record = await goLive(store, record, nowIso);
  }

  return {
    ok: true, duplicate: false, record, checksum: stat.checksum,
    scan,
    credential: detected.status,
    ...(approval ? { approval } : {}),
  };
}

/** Move a stored submission to `live` and mint its lifecycle row, which is what
 *  gives the console its expire/hold/revoke controls over the new asset from
 *  the first moment rather than only after someone sets a window. */
async function goLive(store: Store, record: InstanceAssetRecord, nowIso: string, decidedBy?: string, comment?: string): Promise<InstanceAssetRecord> {
  const next: InstanceAssetRecord = {
    ...record,
    submission: {
      ...(record.submission as AssetSubmission),
      state: 'live',
      ...(decidedBy ? { decidedBy, decidedAt: nowIso } : {}),
      ...(comment ? { comment } : {}),
    },
  };
  await store.putInstanceAsset(next);
  if (!(await store.getLifecycle(record.id))) await store.putLifecycle({ assetId: record.id, onExpiry: 'hide' });
  return next;
}

export interface SubmissionDecision {
  record: InstanceAssetRecord;
  state: 'live' | 'returned';
  comment?: string;
}

/**
 * Apply a terminal approval to the submission it gates: approved goes `live`
 * (lifecycle row minted), rejected and withdrawn go `returned` carrying the
 * reviewer's comment. Returns null when the approval is not a catalog
 * submission, which is how the generic approvals route can call it blindly.
 *
 * It lives here rather than in either route because BOTH decide submissions -
 * the catalog review queue and the plain approvals inbox - and an approval that
 * settled in one place but not the other would leave an asset stuck in
 * `submitted` forever with its approval already closed.
 */
export async function settleSubmission(store: Store, approval: Approval, nowIso: string): Promise<SubmissionDecision | null> {
  if (approval.subjectType !== 'asset' || !approval.subjectRef.startsWith(INST_PREFIX)) return null;
  const record = await store.getInstanceAsset(approval.subjectRef);
  if (!record?.submission || record.submission.approvalId !== approval.id) return null;
  if (record.submission.state !== 'submitted') return null; // already settled
  const last = [...approval.actions].reverse()[0];
  const comment = last?.comment;
  const decidedBy = last ? `user:${last.actor}` : undefined;
  if (approval.state === 'approved') {
    return { record: await goLive(store, record, nowIso, decidedBy, comment), state: 'live', ...(comment ? { comment } : {}) };
  }
  if (approval.state !== 'rejected' && approval.state !== 'withdrawn') return null;
  const next: InstanceAssetRecord = {
    ...record,
    submission: {
      ...record.submission,
      state: 'returned',
      ...(decidedBy ? { decidedBy } : {}),
      decidedAt: nowIso,
      ...(comment ? { comment } : {}),
    },
  };
  await store.putInstanceAsset(next);
  return { record: next, state: 'returned', ...(comment ? { comment } : {}) };
}

/** The review queue's rows, newest first. */
export function listSubmissions(records: InstanceAssetRecord[], state?: 'submitted' | 'live' | 'returned'): InstanceAssetRecord[] {
  return records
    .filter((r) => r.submission && (!state || r.submission.state === state))
    .sort((a, b) => ((a.submission as AssetSubmission).at < (b.submission as AssetSubmission).at ? 1 : -1));
}
