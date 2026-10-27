// SPDX-License-Identifier: MPL-2.0
/**
 * Kubernetes objects for the push-against-pull benchmark: PostgreSQL, one Work
 * replica, N render workers and the in-cluster load client, in one namespace.
 * The worker pod mirrors the chart's (deploy/helm/templates/render-worker.yaml):
 * HTTPS on the Service for push, the same probes, the same capacity setting.
 * Two things are benchmark-only and say so below: a loopback forwarder that
 * gives the worker a secure-context shell origin without an ingress, and the
 * dev sign-in the load client uses.
 */
import { createHash } from 'node:crypto';

export interface BenchSecrets {
  session: string; link: string; worker: string; metrics: string; dbPassword: string;
  catalogKeyPem: string; tlsCert: string; tlsKey: string; caCert: string;
}

export interface BenchSpec {
  namespace: string;
  workImage: string;
  workerImage: string;
  postgresImage: string;
  mode: 'push' | 'pull';
  workers: number;
  /** LW_RENDER_MAX_CONCURRENT per worker. */
  slots: number;
  /** LW_RENDER_CONCURRENCY on Work. */
  runnerConcurrency: number;
  /** render.worker.timeoutMs, the same budget for a push request and a pull lease. */
  workerTimeoutMs: number;
  /** The signed shell build, mounted read-only from the node. */
  shellHostPath: string;
  /** Seccomp profile for Chromium, as installed on the node (Localhost). */
  seccompProfile?: string;
  /** AppArmor profile for Chromium on AppArmor nodes, as loaded on the node (Localhost). */
  appArmorProfile?: string;
  secrets: BenchSecrets;
}

const b64 = (value: string) => Buffer.from(value).toString('base64');
const json = (value: unknown) => JSON.stringify(value);

/** A TCP forwarder in a few lines of the image's own Node, so no extra image. */
export function forwarder(bind: string, listen: number, host: string, port: number): string[] {
  return ['node', '-e', `require('node:net').createServer(c=>{const s=require('node:net').connect(${port},${json(host)});c.pipe(s).pipe(c);c.on('error',()=>s.destroy());s.on('error',()=>c.destroy());}).listen(${listen},${json(bind)})`];
}

export function instanceConfig(spec: BenchSpec): Record<string, unknown> {
  return {
    instance: { name: 'Render dispatch bench', baseUrl: 'http://127.0.0.1:8080', pack: '/bench/shell', shellDir: '/bench/shell' },
    deployment: { mode: 'evaluation' },
    // Benchmark only: the load client signs in through the dev provider.
    dev: { enabled: true, users: [{ email: 'bench@bench.invalid', groups: ['owner'], name: 'Bench' }] },
    rateLimit: { enabled: false },
    policy: { defaultAccessMode: 'gated' },
    render: { allowHooksInFastPath: false,
      worker: { url: `https://render-worker.${spec.namespace}.svc:8791`, timeoutMs: spec.workerTimeoutMs, dispatch: spec.mode } },
  };
}

export function manifests(spec: BenchSpec): string {
  const ns = spec.namespace;
  const config = json(instanceConfig(spec));
  const rollout = createHash('sha256').update(config + spec.runnerConcurrency).digest('hex').slice(0, 16);
  const docs: unknown[] = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bench-secrets', namespace: ns }, type: 'Opaque', data: {
      LW_SESSION_SECRET: b64(spec.secrets.session), LW_LINK_SECRET: b64(spec.secrets.link),
      LW_RENDER_WORKER_SECRET: b64(spec.secrets.worker), LW_METRICS_TOKEN: b64(spec.secrets.metrics),
      LW_CATALOG_SIGNING_KEY: b64(spec.secrets.catalogKeyPem),
      DATABASE_URL: b64(`postgres://bench:${spec.secrets.dbPassword}@postgres.${ns}.svc:5432/bench`),
      POSTGRES_PASSWORD: b64(spec.secrets.dbPassword),
    } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'worker-tls', namespace: ns }, type: 'Opaque',
      data: { 'tls.crt': b64(spec.secrets.tlsCert), 'tls.key': b64(spec.secrets.tlsKey), 'ca.crt': b64(spec.secrets.caCert) } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'work-config', namespace: ns }, data: { 'instance.json': config } },
    // PostgreSQL, in the cluster, on scratch storage.
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'postgres', namespace: ns }, spec: {
      replicas: 1, selector: { matchLabels: { app: 'postgres' } }, strategy: { type: 'Recreate' },
      template: { metadata: { labels: { app: 'postgres' } }, spec: { containers: [{
        name: 'postgres', image: spec.postgresImage, args: ['-c', 'max_connections=200'],
        env: [{ name: 'POSTGRES_USER', value: 'bench' }, { name: 'POSTGRES_DB', value: 'bench' },
          { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'bench-secrets', key: 'POSTGRES_PASSWORD' } } }],
        ports: [{ containerPort: 5432 }],
        readinessProbe: { exec: { command: ['pg_isready', '-U', 'bench', '-d', 'bench'] }, periodSeconds: 2 },
        volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
      }], volumes: [{ name: 'data', emptyDir: {} }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'postgres', namespace: ns }, spec: { selector: { app: 'postgres' }, ports: [{ port: 5432 }] } },
    // Work, one replica as the chart requires.
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'work', namespace: ns }, spec: {
      replicas: 1, selector: { matchLabels: { app: 'work' } }, strategy: { type: 'Recreate' },
      template: { metadata: { labels: { app: 'work' }, annotations: { 'bench/rollout': rollout } }, spec: { containers: [{
        name: 'work', image: spec.workImage, imagePullPolicy: 'Never',
        env: [
          { name: 'LW_CONFIG', value: '/config/instance.json' }, { name: 'PORT', value: '8787' },
          { name: 'LW_RENDER_CONCURRENCY', value: String(spec.runnerConcurrency) },
          // Trust the benchmark CA for the worker Service certificate.
          { name: 'NODE_EXTRA_CA_CERTS', value: '/tls/ca.crt' },
          ...['LW_SESSION_SECRET', 'LW_LINK_SECRET', 'LW_RENDER_WORKER_SECRET', 'LW_METRICS_TOKEN', 'LW_CATALOG_SIGNING_KEY', 'DATABASE_URL']
            .map((name) => ({ name, valueFrom: { secretKeyRef: { name: 'bench-secrets', key: name } } })),
        ],
        ports: [{ containerPort: 8787 }],
        readinessProbe: { httpGet: { path: '/healthz', port: 8787 }, periodSeconds: 2 },
        volumeMounts: [{ name: 'config', mountPath: '/config', readOnly: true }, { name: 'tls', mountPath: '/tls', readOnly: true },
          { name: 'shell', mountPath: '/bench/shell', readOnly: true }],
      }], volumes: [{ name: 'config', configMap: { name: 'work-config' } },
        { name: 'tls', secret: { secretName: 'worker-tls', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
        { name: 'shell', hostPath: { path: spec.shellHostPath, type: 'Directory' } }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'work', namespace: ns }, spec: { selector: { app: 'work' }, ports: [{ port: 8787 }] } },
    // Render workers.
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'render-worker', namespace: ns }, spec: {
      replicas: spec.workers, selector: { matchLabels: { app: 'render-worker' } },
      template: { metadata: { labels: { app: 'render-worker' } }, spec: {
        terminationGracePeriodSeconds: 5,
        containers: [{
          name: 'render-worker', image: spec.workerImage, imagePullPolicy: 'Never',
          securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
            ...(spec.seccompProfile ? { seccompProfile: { type: 'Localhost', localhostProfile: spec.seccompProfile } } : {}),
            ...(spec.appArmorProfile ? { appArmorProfile: { type: 'Localhost', localhostProfile: spec.appArmorProfile } } : {}) },
          env: [
            { name: 'LW_RENDER_DEPLOYMENT_MODE', value: 'evaluation' },
            { name: 'LW_RENDER_TLS_CERT_FILE', value: '/run/render-tls/tls.crt' }, { name: 'LW_RENDER_TLS_KEY_FILE', value: '/run/render-tls/tls.key' },
            { name: 'PORT', value: '8791' },
            // Benchmark only: the shell and the lease endpoint reach Work through
            // the loopback forwarder below, a secure-context origin without an ingress.
            { name: 'LOLLY_WEB_BASE', value: 'http://127.0.0.1:8080' },
            ...(spec.mode === 'pull' ? [{ name: 'LW_RENDER_PULL_URL', value: 'http://127.0.0.1:8080' }] : []),
            { name: 'LW_RENDER_MAX_CONCURRENT', value: String(spec.slots) },
            { name: 'LW_RENDER_WORKER_SECRET', valueFrom: { secretKeyRef: { name: 'bench-secrets', key: 'LW_RENDER_WORKER_SECRET' } } },
          ],
          ports: [{ name: 'https', containerPort: 8791 }],
          livenessProbe: { httpGet: { path: '/healthz', port: 'https', scheme: 'HTTPS' }, initialDelaySeconds: 10, periodSeconds: 20 },
          readinessProbe: { httpGet: { path: '/readyz', port: 'https', scheme: 'HTTPS' }, initialDelaySeconds: 5, periodSeconds: 10 },
          volumeMounts: [{ name: 'render-tls', mountPath: '/run/render-tls', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
        }, {
          name: 'to-work', image: spec.workerImage, imagePullPolicy: 'Never',
          command: forwarder('127.0.0.1', 8080, `work.${ns}.svc`, 8787),
          securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        }],
        volumes: [{ name: 'render-tls', secret: { secretName: 'worker-tls' } }, { name: 'tmp', emptyDir: {} }],
      } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'render-worker', namespace: ns },
      spec: { selector: { app: 'render-worker' }, ports: [{ name: 'https', port: 8791, targetPort: 'https' }] } },
  ];
  return docs.map((d) => json(d)).join('\n---\n') + '\n';
}

/** The load client: a Job in Work's image, reading its plan from a ConfigMap. */
export function clientJob(namespace: string, image: string, name: string): string {
  return json({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace }, spec: {
    backoffLimit: 0, ttlSecondsAfterFinished: 3600,
    template: { spec: { restartPolicy: 'Never', containers: [{
      name: 'client', image, imagePullPolicy: 'Never', workingDir: '/app',
      command: ['node', '/bench/client/client.ts'],
      env: [{ name: 'WORK_URL', value: `http://work.${namespace}.svc:8787` }, { name: 'BENCH_PLAN', value: '/bench/plan/plan.json' },
        ...['DATABASE_URL', 'LW_METRICS_TOKEN'].map((key) => ({ name: key, valueFrom: { secretKeyRef: { name: 'bench-secrets', key } } }))],
      volumeMounts: [{ name: 'client', mountPath: '/bench/client', readOnly: true }, { name: 'plan', mountPath: '/bench/plan', readOnly: true }],
    }], volumes: [{ name: 'client', configMap: { name: 'bench-client' } }, { name: 'plan', configMap: { name: name } }] } },
  } }) + '\n';
}
