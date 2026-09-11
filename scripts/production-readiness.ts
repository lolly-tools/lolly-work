#!/usr/bin/env node
/** Read-only evidence for the proposed internal OIDC deployment profile. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { parseConfig } from '../server/src/config/instance.ts';

export type Status = 'pass' | 'fail' | 'unverified';
export interface Check { id: string; status: Status; detail: string }
export interface Report {
  schemaVersion: 1;
  kind: 'lolly-work.production-evidence';
  generatedAt: string;
  inputSha256: string;
  result: 'failed' | 'incomplete' | 'passed';
  checks: Check[];
}
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const at = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((value, key) => object(value)[key], v);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const immutableImage = (v: unknown): boolean => typeof v === 'string' && /^\S+@sha256:[a-f0-9]{64}$/.test(v);

function safeUrl(value: unknown, allowLocal = false): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return u.protocol === 'https:' || (allowLocal && local && u.protocol === 'http:') ? u : null;
  } catch { return null; }
}

function hasEmbeddedSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(value)
      || /(?:postgres(?:ql)?|https?):\/\/[^\s/]+:[^\s/@]+@/i.test(value);
  }
  if (Array.isArray(value)) return value.some(hasEmbeddedSecret);
  return Object.entries(object(value)).some(([key, child]) => {
    if (/^(?:password|clientSecret|sessionSecret|linkSecret|credentialSecret|privateKey|accessToken|refreshToken|apiKey|authorization)$/i.test(key)
      && child !== '' && child !== null && child !== undefined) return true;
    if (['EC', 'RSA', 'OKP'].includes(String(object(value).kty)) && key === 'd') return true;
    return hasEmbeddedSecret(child);
  });
}

const REQUIRED_EVIDENCE: ReadonlyArray<[string, string]> = [
  ['identity', 'Verify SUSE MFA, authorised membership, roles, lifecycle delivery and active-session revocation using approved staging test identities.'],
  ['release', 'Attach the final signed artifact verification, reviewed source/submodule/engine/pack identities and deployed image digests.'],
  ['security', 'Attach exact-release scan reports, Security review, finding treatment and business UAT results.'],
  ['operations', 'Verify independent log receipt, retention, alert response and backup/restore/rollback evidence with the actual platform.'],
  ['privacy-ai', 'Record approved data/feature scope, retention schedule, privacy processing/assessment and applicable AI review/containment evidence.'],
  ['change', 'Record ServiceHub scope, IT/Business owners, support/delegate, implementation window, communications and required reviews/CAB approval.'],
];

function finish(report: Report): Report {
  report.result = report.checks.some(c => c.status === 'fail') ? 'failed'
    : report.checks.some(c => c.status === 'unverified') ? 'incomplete' : 'passed';
  return report;
}

export function assess(text: string, format: 'config' | 'manifests'): Report {
  const report: Report = {
    schemaVersion: 1, kind: 'lolly-work.production-evidence', generatedAt: new Date().toISOString(),
    inputSha256: sha256(text), result: 'incomplete', checks: [],
  };
  const check = (id: string, ok: boolean, detail: string): void => { report.checks.push({ id, status: ok ? 'pass' : 'fail', detail }); };
  const pending = (id: string, detail: string): void => { report.checks.push({ id, status: 'unverified', detail }); };
  let raw: unknown;
  let docs: unknown[] = [];
  let configMapName: unknown;
  try {
    if (format === 'config') raw = JSON.parse(text);
    else {
      const yaml = parseAllDocuments(text);
      if (yaml.some(doc => doc.errors.length)) throw new Error();
      docs = yaml.map(doc => doc.toJSON());
      const configs = docs.filter(doc => at(doc, 'kind') === 'ConfigMap' && typeof at(doc, 'data', 'instance.json') === 'string');
      if (configs.length !== 1) throw new Error();
      configMapName = at(configs[0], 'metadata', 'name');
      raw = JSON.parse(at(configs[0], 'data', 'instance.json') as string);
    }
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error();
    check('input.parse', true, 'Exactly one instance configuration parsed.');
  } catch {
    check('input.parse', false, 'Invalid or ambiguous input; provide an instance JSON object or rendered manifests with exactly one instance.json ConfigMap.');
  }
  if (raw) {
    check('config.secret-material', !hasEmbeddedSecret(raw), 'Instance configuration must contain references rather than embedded credentials or private keys.');
    // The parser can warn with unknown input keys. Do not call it on unknown
    // top-level keys: untrusted configuration must never be echoed to logs.
    const known = new Set(['instance', 'idp', 'policy', 'render', 'audit', 'rateLimit', 'dev', 'proxyAuth', 'catalogProviders', 'delivery', 'blobs', 'notify', 'siem', 'submit']);
    const knownKeys = Object.keys(object(raw)).every(key => known.has(key) || key.startsWith('_') || key.startsWith('$'));
    try {
      if (!knownKeys) throw new Error();
      const cfg = parseConfig(JSON.stringify(raw));
      check('config.schema', true, 'Configuration accepted by the application parser.');
      check('config.https', !!safeUrl(cfg.instance.baseUrl), 'Application base URL must use HTTPS without URL credentials.');
      check('config.identity', !!safeUrl(cfg.idp.issuer) && !!cfg.idp.clientId.trim(), 'Primary OIDC issuer/client must be configured with HTTPS; this does not verify MFA or membership.');
      check('config.additional-identity', cfg.idp.additional.every(idp => !!safeUrl(idp.issuer) && !!idp.clientId.trim()), 'Every additional identity provider must use HTTPS and a client registration.');
      check('config.gated', cfg.policy.defaultAccessMode === 'gated', 'The proposed internal profile requires gated access.');
      check('config.auth-bypass', !cfg.dev.enabled && !cfg.proxyAuth.enabled, 'Development and proxy authentication must be disabled for this OIDC profile.');
      check('config.session', cfg.policy.sessionTtlHours <= 24, 'Member sessions must not exceed the proposed 24-hour ceiling.');
      check('config.telemetry', cfg.policy.telemetry === 'off', 'The proposed first-release profile keeps optional usage analytics off pending review.');
      check('config.ai', cfg.policy.ai.enabled === false, 'The proposed first-release profile keeps managed AI off pending review. Deploy the matching shell with VITE_REQUIRE_AI_POLICY=true.');
      check('config.sharing', !cfg.policy.guestLinks.enabled && !cfg.policy.nearby.enabled, 'The proposed profile disables guest editing and nearby discovery; other sharing paths require scope review.');
      check('config.render-isolation', !cfg.render.allowHooksInFastPath, 'In-process hook execution must stay disabled for the proposed profile.');
      check('config.audit-head', cfg.audit.headLog.onBoot && cfg.audit.headLog.intervalMinutes > 0, 'Periodic audit-head logging must be enabled; external retention still requires evidence.');
      const retention = object(at(raw, 'policy', 'retention'));
      if (Number.isInteger(retention.auditDays) && Number(retention.auditDays) >= 180) {
        check('config.audit-retention', true, 'Explicit audit retention meets the usual 180-day floor; approval of the actual schedule remains unverified.');
      } else pending('config.audit-retention', 'Audit retention is implicit, indefinite or below 180 days; obtain the approved schedule or applicable exception.');
      if (Number.isInteger(retention.telemetryDays) && Number(retention.telemetryDays) > 0) {
        check('config.telemetry-retention', true, 'An explicit finite telemetry retention is configured; purpose and schedule approval remain unverified.');
      } else pending('config.telemetry-retention', 'Set or document approved treatment of retained telemetry, including previously collected data.');
      if (cfg.siem.url) check('config.siem-transport', !!safeUrl(cfg.siem.url), 'Configured SIEM endpoint must use HTTPS without URL credentials; no receiver request was made.');
      else pending('config.siem-transport', 'No application SIEM destination configured; verify the approved central logging alternative or connect the forwarder.');
      const hook = cfg.submit.scanHook;
      if (hook) {
        check('config.scanner', hook.onError === 'reject' && (hook.kind === 'exec' || !!safeUrl(hook.target)), 'Configured scanner must reject unanswered scans and use local execution or protected HTTP transport.');
      } else pending('config.scanner', 'No submission scanner configured; establish inspection requirements or the approved excluded feature scope.');
    } catch {
      check('config.schema', false, 'Application configuration was rejected; no input values or parser exception text are included.');
    }
  }
  if (format === 'manifests' && docs.length) {
    const workloads = docs.filter(doc => ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(String(at(doc, 'kind'))));
    const specs = workloads.map(doc => at(doc, 'kind') === 'CronJob' ? at(doc, 'spec', 'jobTemplate', 'spec', 'template', 'spec') : at(doc, 'spec', 'template', 'spec'));
    const containers = specs.flatMap(spec => [...array(at(spec, 'containers')), ...array(at(spec, 'initContainers'))]);
    check('kubernetes.images', containers.length > 0 && containers.every(c => immutableImage(at(c, 'image'))), 'All workload and init-container images must be pinned by SHA-256 digest for this evidence profile.');
    check('kubernetes.secret-resources', !docs.some(doc => at(doc, 'kind') === 'Secret'), 'Use pre-existing platform secret references; rendered evidence must not carry Secret resources.');
    check('kubernetes.inline-env', containers.every(c => array(at(c, 'env')).every(e => {
      const name = at(e, 'name');
      return typeof name !== 'string' || !/(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|DATABASE_URL|CREDENTIAL)/i.test(name)
        || !Object.hasOwn(object(e), 'value');
    })), 'Credential-bearing environment entries must use references, not inline values.');
    const servers = specs.flatMap(spec => array(at(spec, 'containers')).filter(c => at(c, 'name') === 'server').map(c => ({ c, spec })));
    check('kubernetes.work-server', servers.length === 1, 'Exactly one Work server workload must be present.');
    if (servers.length === 1) {
      const { c, spec } = servers[0]!;
      const mounts = array(at(c, 'volumeMounts')).filter(m => at(m, 'mountPath') === '/app/instance.json' && at(m, 'readOnly') === true && at(m, 'subPath') === 'instance.json');
      check('kubernetes.config-mount', mounts.length === 1 && array(at(spec, 'volumes')).some(v => at(v, 'name') === at(mounts[0], 'name')
        && at(v, 'configMap', 'name') === configMapName)
        && array(at(c, 'env')).some(e => at(e, 'name') === 'LW_CONFIG' && at(e, 'value') === '/app/instance.json'), 'The assessed ConfigMap must be the read-only instance configuration consumed by Work.');
      check('kubernetes.security', (at(c, 'securityContext', 'runAsNonRoot') ?? at(spec, 'securityContext', 'runAsNonRoot')) === true
        && at(c, 'securityContext', 'readOnlyRootFilesystem') === true
        && at(c, 'securityContext', 'allowPrivilegeEscalation') === false
        && array(at(c, 'securityContext', 'capabilities', 'drop')).includes('ALL'), 'Work must run non-root with a read-only root filesystem, no privilege escalation and dropped capabilities.');
      check('kubernetes.probes', at(c, 'livenessProbe', 'httpGet', 'path') === '/healthz'
        && at(c, 'readinessProbe', 'httpGet', 'path') === '/readyz', 'Liveness and dependency readiness must use their respective endpoints.');
    }
    const ingress = docs.filter(doc => at(doc, 'kind') === 'Ingress');
    if (ingress.length) check('kubernetes.ingress-tls', ingress.every(doc => {
      const hosts = array(at(doc, 'spec', 'rules')).map(rule => at(rule, 'host'));
      const tlsHosts = array(at(doc, 'spec', 'tls')).flatMap(tls => array(at(tls, 'hosts')));
      return hosts.length > 0 && hosts.every(host => typeof host === 'string' && tlsHosts.includes(host));
    }), 'Every declared ingress rule host must appear in a TLS entry.');
    else pending('kubernetes.ingress-tls', 'Ingress is managed elsewhere; verify the actual TLS and access boundary.');
    pending('kubernetes.database', 'Secret references do not prove PostgreSQL durability, encryption, migrations or backup configuration; verify those without exporting credentials.');
  } else pending('kubernetes.manifests', 'No rendered workload evidence was assessed.');
  for (const [id, detail] of REQUIRED_EVIDENCE) pending(`evidence.${id}`, detail);
  return finish(report);
}

async function smallJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16_384) throw new Error();
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function probe(base: string, options: { allowLocalHttp?: boolean; timeoutMs?: number } = {}): Promise<Check[]> {
  const url = safeUrl(base, options.allowLocalHttp);
  if (!url || !['', '/'].includes(url.pathname)) return [{ id: 'http.target', status: 'fail', detail: 'Use an explicit HTTPS origin without credentials, query or fragment; HTTP is allowed only for an opted-in loopback rehearsal.' }];
  const checks: Check[] = [];
  for (const path of ['/healthz', '/readyz', '/api/v1/users', '/api/v1/projects', '/api/v1/audit']) {
    const id = `http.${path.slice(1).replaceAll('/', '.')}`;
    try {
      const response = await fetch(new URL(path, url), { redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
      if (path.startsWith('/api/')) {
        await response.body?.cancel();
        const denied = [401, 403].includes(response.status);
        checks.push({ id, status: denied ? 'pass' : response.status >= 300 && response.status < 400 ? 'unverified' : 'fail', detail: `Anonymous protected-route probe returned HTTP ${response.status}; only an explicit 401/403 establishes denial in this check.` });
      } else {
        const body = await smallJson(response);
        const ok = response.status === 200 && at(body, 'ok') === true
          && (path === '/readyz' ? at(body, 'store') === 'postgres' : at(body, 'accessMode') === 'gated');
        checks.push({ id, status: ok ? 'pass' : 'fail', detail: `Health probe returned HTTP ${response.status}; expected Work JSON with gated access or PostgreSQL readiness.` });
      }
    } catch { checks.push({ id, status: 'fail', detail: 'Probe failed DNS, TLS, transport, timeout, body-size or response validation; response content and exception details are not retained.' }); }
  }
  return checks;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help')) {
    console.log('Usage: pnpm run readiness -- (--config instance.json | --manifests rendered.yaml) [--base-url https://staging.example] [--allow-local-http] [--out new-report.json]\nRead-only. Exit 0: passed; 1: failed/input error; 2: evidence incomplete. Human approval is never inferred.');
    return 0;
  }
  const values = new Map<string, string>();
  let allowLocalHttp = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i]!;
      if (key === '--') continue;
      if (key === '--allow-local-http') { allowLocalHttp = true; continue; }
      if (!['--config', '--manifests', '--base-url', '--out'].includes(key) || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error();
      values.set(key, args[++i]!);
    }
    if (values.has('--config') === values.has('--manifests')) throw new Error();
    const path = values.get('--config') ?? values.get('--manifests')!;
    if (!statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024) throw new Error();
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error();
    const report = assess(text, values.has('--config') ? 'config' : 'manifests');
    if (values.has('--base-url')) report.checks.push(...await probe(values.get('--base-url')!, { allowLocalHttp }));
    else report.checks.push({ id: 'http.staging', status: 'unverified', detail: 'No explicit staging origin supplied; no network probes were made.' });
    finish(report);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.has('--out')) writeFileSync(values.get('--out')!, json, { mode: 0o600, flag: 'wx' });
    else console.log(json.trimEnd());
    return report.result === 'failed' ? 1 : report.result === 'incomplete' ? 2 : 0;
  } catch {
    console.error('Readiness input/output failed. Check arguments, input size/readability and use a new output path. Input and exception details are suppressed.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
