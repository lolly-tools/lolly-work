// SPDX-License-Identifier: MPL-2.0
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
export const release = JSON.parse(readFileSync(join(root, 'deploy/marketplaces/release.json'), 'utf8'));
const script = (name: string) => readFileSync(join(root, `deploy/marketplaces/${name}.mjs`), 'utf8').replaceAll('$', () => '$$');

export function deploymentPackages() {
  for (const key of ['serverImage', 'workerImage', 'postgresImage', 'caddyImage']) {
    if (!/^\S+@sha256:[a-f0-9]{64}$/.test(release[key])) throw new Error(`Pin ${key} by digest`);
  }
  const pins = { LW_SHELL_SHA256: release.shell.sha256, LW_CATALOG_GENERATION: String(release.catalogGeneration), LW_SOURCE_CATALOG_PUBLIC_KEY: JSON.stringify(release.sourceCatalogPublicKey) };
  const env = (name: string) => '${' + name + ':?set ' + name + '}';
  const safety = { read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  const services = {
    content: {
      image: release.serverImage, user: '0:0', ...safety, cap_add: ['CHOWN'],
      environment: { LW_DISTRIBUTION_INIT: '1', LW_SHELL_URL: release.shell.url, LW_SHELL_SHA256: release.shell.sha256 },
      command: ['node', '--input-type=module', '--eval', script('content-init')],
      volumes: ['content:/content', 'keys:/keys', 'state:/state'], tmpfs: ['/tmp:size=64m,mode=1777'],
      mem_limit: '512m', cpus: 1, restart: 'no',
    },
    db: {
      image: release.postgresImage,
      environment: { POSTGRES_DB: 'lollywork', POSTGRES_USER: 'lolly', POSTGRES_PASSWORD: env('POSTGRES_PASSWORD') },
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U lolly -d lollywork'], interval: '3s', timeout: '3s', retries: 30, start_period: '10s' },
      volumes: ['pgdata:/var/lib/postgresql/data'], restart: 'unless-stopped', stop_grace_period: '60s',
    },
    server: {
      image: release.serverImage, ...safety,
      environment: {
        NODE_ENV: 'production', LW_DISTRIBUTION_START: '1', LW_CONFIG: '/app/state/instance.json', ...pins,
        LOLLY_DOMAIN: env('LOLLY_DOMAIN'), LOLLY_AUTH_MODE: '${LOLLY_AUTH_MODE:-password}',
        LOLLY_OIDC_ISSUER: '${LOLLY_OIDC_ISSUER:-}',
        LOLLY_OIDC_CLIENT_ID: '${LOLLY_OIDC_CLIENT_ID:-}', LOLLY_OWNER_EMAIL: env('LOLLY_OWNER_EMAIL'),
        LW_IDP_CLIENT_SECRET: '${LW_IDP_CLIENT_SECRET:-}',
        DATABASE_URL: 'postgres://lolly:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@db:5432/lollywork',
        LW_SESSION_SECRET: env('LW_SESSION_SECRET'), LW_LINK_SECRET: env('LW_LINK_SECRET'), LW_CREDENTIAL_SECRET: env('LW_CREDENTIAL_SECRET'),
      },
      command: ['node', '--input-type=module', '--eval', script('server-start')],
      volumes: ['content:/app/content:ro', 'keys:/app/keys:ro', 'state:/app/state'], tmpfs: ['/tmp:size=256m,mode=1777'],
      expose: ['8787'], restart: 'unless-stopped', stop_grace_period: '60s',
      depends_on: { db: { condition: 'service_healthy' }, content: { condition: 'service_completed_successfully' } },
    },
  };
  const caddyfile = '{$LOLLY_DOMAIN} {\n  reverse_proxy server:8787\n}\n';
  const compose = {
    services: { ...services, caddy: {
      image: release.caddyImage, environment: { LOLLY_DOMAIN: env('LOLLY_DOMAIN') },
      ports: ['80:80', '443:443', '443:443/udp'],
      volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro,Z', 'caddy_data:/data', 'caddy_config:/config'],
      restart: 'unless-stopped', depends_on: { server: { condition: 'service_healthy' } },
    } },
    volumes: { content: {}, keys: {}, state: {}, pgdata: {}, caddy_data: {}, caddy_config: {} },
  };
  const dokploy = { services, volumes: { content: {}, keys: {}, state: {}, pgdata: {} } };
  const template = `[variables]\nmain_domain = "\${domain}"\n\n[[config.domains]]\nserviceName = "server"\nport = 8787\nhost = "\${main_domain}"\n\n[config.env]\nLOLLY_DOMAIN = "\${main_domain}"\nLOLLY_AUTH_MODE = "password"\nLOLLY_OIDC_ISSUER = ""\nLOLLY_OIDC_CLIENT_ID = ""\nLOLLY_OWNER_EMAIL = ""\nLW_IDP_CLIENT_SECRET = ""\nPOSTGRES_PASSWORD = "\${hash:64}"\nLW_SESSION_SECRET = "\${hash:64}"\nLW_LINK_SECRET = "\${hash:64}"\nLW_CREDENTIAL_SECRET = "\${hash:64}"\n`;
  const meta = {
    id: 'lolly-work', name: 'Lolly Work', version: release.version,
    description: 'Official open-source Lolly control plane with a neutral web shell, durable PostgreSQL and built-in sign-in or OIDC. Configure your domain and named owner before deploying.',
    logo: 'lolly-work.svg',
    links: { github: 'https://github.com/lolly-tools/lolly-work', website: 'https://lolly.work', docs: 'https://github.com/lolly-tools/lolly-work/blob/main/docs/install.md#10-official-neutral-package' },
    tags: ['collaboration', 'design', 'productivity'],
  };
  // Compose substitutes dollars even in list-form commands and quoted YAML.
  const yaml = (value: unknown) => stringify(value, { lineWidth: 0 });
  return { compose: yaml(compose), dokploy: yaml(dokploy), template, meta, caddyfile };
}

export function writePackages(check = false) {
  const packages = deploymentPackages();
  const files: Record<string, string> = {
    'deploy/helm/values-official-release.yaml': '# Generated from deploy/marketplaces/release.json. Qualified cohort ' + release.version + '; merge with operator values.\n' + stringify({
      image: { repository: release.serverImage.split('@')[0], digest: release.serverImage.split('@')[1] },
      renderWorker: { enabled: false, image: { repository: release.workerImage.split('@')[0], digest: release.workerImage.split('@')[1] } },
    }),
    'deploy/marketplaces/compose.yaml': packages.compose,
    'deploy/marketplaces/Caddyfile': packages.caddyfile,
    'deploy/dokploy/lolly-work/docker-compose.yml': packages.dokploy,
    'deploy/dokploy/lolly-work/template.toml': packages.template,
    'deploy/dokploy/lolly-work/meta.json': JSON.stringify(packages.meta, null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) throw new Error(`Regenerate ${name}: node scripts/marketplace-packages.ts`);
    } else {
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/marketplace-packages.ts [--check]');
  writePackages(process.argv.includes('--check'));
}
