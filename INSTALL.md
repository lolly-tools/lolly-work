# Installing the Lolly control plane

Getting from nothing to a **running web UI + CLI** - on a workstation (SLES / openSUSE
Leap / macOS), a single VM, or Kubernetes. Pick the row that matches you:

| I want to… | Go to | Time |
|---|---|---|
| Just look, install nothing | [Hosted demo](#0-hosted-demo-zero-install) | 0 min |
| Evaluate locally | [1. Fastest local run](#1-fastest-local-run-demo-mode) | 2 min |
| Run a real single-host deploy | [3. Bare metal](#3-bare-metal-systemd) · [4. Container](#4-container-compose) | 15 min |
| Run it in production | [5. Kubernetes (Helm)](#5-kubernetes-helm) | 30 min |
| Drive it from a terminal | [6. The CLI](#6-the-cli) | - |

The server is **zero-build** - it runs TypeScript directly on Node, no compile step, no
external assets. The only prerequisite for the local paths is Node; the container and
Kubernetes paths need only Docker or a cluster.

---

## 0. Hosted demo (zero install)

A public, passwordless sandbox runs at **<https://lolly.work>** - one-click sign-in as any
persona (admin / brand-lead / marketer / contractor), the governed admin console at
`/admin`, and live tool renders over a plain GET (`/render/qr-code.svg?url=…`). State is
in-memory and resets on redeploy; it holds nothing real. It is the fastest way to see what
a deployment *is* before installing one.

> The demo is hosted on Vercel today purely for convenience; it is **not** the deployment
> model and will move to a **European sovereign cloud** (likely Evroc). For a real deployment - 
> especially a sovereign one - you self-host: see §5 and *Sovereignty* below.

---

## Prerequisites (local paths)

**Node 24+** is the only prerequisite. The server runs `.ts` sources directly via Node's
native type-stripping, so there is no build step - but that needs a modern Node.

| | macOS | SLES / openSUSE Leap |
|---|---|---|
| **Package manager** | [Homebrew](https://brew.sh) | `zypper` (built in) |
| **git** | `brew install git` (or Xcode CLT) | `sudo zypper install git` |
| **Node 24** | `brew install node` | `sudo zypper install nodejs24 npm24` |

If your distro doesn't package Node 24 yet (Leap 15.6 / SLES 15 ship older lines), use
[**nvm**](https://github.com/nvm-sh/nvm) - the most reliable path on any box:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reopen your shell, then:
nvm install 24 && nvm use 24
```

Verify: `node -v` → `v24.x`.

---

## 1. Fastest local run (demo mode)

```bash
git clone https://github.com/lolly-tools/lolly-work.git
cd lolly-work
npm install
npm run demo            # → http://localhost:8787   (PORT=8788 for another port)
```

`npm run demo` seeds a whole governed deployment in memory - four personas, tool overlays,
an approval chain, projects, telemetry, links - and prints one passwordless sign-in link
per persona at boot. Open the printed URL:

- **Web shell** at `/` - sign in as `marketer@suse.example` to see governed, locked inputs.
- **Admin console** at `/admin` - sign in as `admin@suse.example`.
- **This documentation** at `/admin#/docs`.

The full walkthrough is in [`DEMO.md`](DEMO.md). The in-shell governance UX needs the Lolly
web shell built once in a sibling OSS checkout (`../lolly`; `npm run build:web`) - the demo
detects this and says so at boot; the console + render plane work regardless.

---

## 2. A real (small) config

```bash
cp instance.example.json instance.json    # dev provider on, gated access
node server/src/main.ts                   # or: npm start  → http://localhost:8787
```

The three settings that make it yours - `instance.pack` (your brand pack / catalog),
`instance.shellDir` (a built `shells/web/dist`, served at `/`), and `idp.issuer`+`clientId`
(real SSO, replacing the dev provider) - are the [quickstart](docs/quickstart.md), with the
full key reference in [configuration](docs/configuration.md). Persistence is one env var:

```bash
export DATABASE_URL=postgres://…          # migrations auto-apply at boot
```

Two secrets are required in production (never in the config file):

```bash
LW_SESSION_SECRET=$(openssl rand -hex 32)   # session/guest/state tokens
LW_LINK_SECRET=$(openssl rand -hex 32)      # share/embed/download link signatures
```

---

## 3. Bare metal (systemd)

For a single Linux host (SLES / Leap). Run it as a service under a dedicated user:

```bash
sudo useradd --system --home /opt/lolly-work --shell /usr/sbin/nologin lolly
sudo git clone https://github.com/lolly-tools/lolly-work.git /opt/lolly-work
cd /opt/lolly-work && sudo -u lolly npm install --omit=dev
```

`/etc/systemd/system/lolly-work.service`:

```ini
[Unit]
Description=Lolly control plane
After=network.target postgresql.service

[Service]
User=lolly
WorkingDirectory=/opt/lolly-work
Environment=PORT=8787
Environment=LW_CONFIG_JSON=/opt/lolly-work/instance.json
Environment=DATABASE_URL=postgres://lolly@localhost/lolly_work
EnvironmentFile=/etc/lolly-work.secrets      # LW_SESSION_SECRET, LW_LINK_SECRET, …
ExecStart=/usr/bin/node server/src/main.ts
Restart=on-failure
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/lolly-work

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lolly-work
curl -s http://localhost:8787/healthz
```

Put TLS (nginx / Caddy) in front, or terminate at your load balancer. `LW_CONFIG_JSON` may
be a **path** to a JSON file or the JSON **string** itself.

---

## 4. Container (Compose)

Single VM with Postgres alongside, one command:

```bash
cd deploy/compose
cp ../../instance.example.json instance.json     # edit: pack, shellDir, idp
docker compose up --build                        # → :8787, Postgres 17 alongside
```

`deploy/compose/docker-compose.yml` bind-mounts the pack and a built `shells/web/dist`, and
auto-applies migrations at boot. Details: [deployment](docs/deployment.md#single-vm-compose).

---

## 5. Kubernetes (Helm) - the sovereign path

The production path - HA, Rancher/RKE/any conformant cluster.

> **Most sovereign / recommended - your choice of paid or free:**
> - **SUSE Linux Enterprise Server + SUSE Rancher Prime** (paid, supported), or
> - **openSUSE Leap + Rancher Community** (free - Leap is built from the same SLES sources).
>
> Both share the same supply chain: SUSE builds SLES/Leap and its BCI base images
> **reproducibly**, with dependencies **frozen in time alongside the build** in SUSE's governed
> datacentre in **Prague** - an auditable, rebuildable, EU-jurisdiction chain. With lolly-work's
> vendored engine (`engine-pin.json`, hash-verified, no external fetch), the control plane **and**
> the Chromium render worker run as ordinary pods on your own cluster - air-gappable, no US
> hyperscaler, no `gcloud`, no Vercel. This is the safest deployment.

`deploy/helm/values.yaml` is the one file you edit (heavily commented):

```bash
kubectl create secret generic lolly-work-secrets \
  --from-literal=DATABASE_URL=postgres://… \
  --from-literal=LW_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=LW_LINK_SECRET="$(openssl rand -hex 32)"

helm install lolly-work deploy/helm \
  --set image.repository=<your-registry>/lolly-work \
  --set existingSecret=lolly-work-secrets \
  --set-file config=instance.json
```

Migrations run as a pre-install/upgrade Job; the pack and shell mount as volumes; a
`ServiceMonitor`, `NetworkPolicy`, ingress and an optional Chromium render-worker tier ship
in the chart. **Multi-arch images (amd64 + arm64) publish to
`ghcr.io/lolly-tools/lolly-work-server` and `…-render-worker` on every `v*` release** - 
the chart's empty `image.tag` pulls the matching version; the packages are private today,
so add an `imagePullSecret` or mirror into your own registry (the better air-gap posture
anyway). And to **evaluate on a cluster in one command** - no Postgres, no IdP, no pack:

```bash
helm install lolly deploy/helm -f deploy/helm/values-eval.yaml
```

Full guide + values reference: [deployment](docs/deployment.md#kubernetes-helm--the-production-path).

---

## 6. The CLI

Every governance action the console does is scriptable with `lw`:

```bash
npm run cli -- --help
npm run cli -- export --out governance.json     # snapshot roles/grants/overlays/org-config
npm run cli -- users ls
```

A fresh deploy can come up **already governed** by seeding that snapshot:

```bash
LW_SEED_CONFIG=./governance.json npm start       # idempotent
```

Full command reference: [cli](docs/cli.md).

---

## What next

- **Configuration** - every key: [docs/configuration.md](docs/configuration.md)
- **Identity / SSO** - wiring your OIDC issuer: [docs/identity.md](docs/identity.md)
- **Deployment shapes** - the full matrix + air-gap: [docs/deployment.md](docs/deployment.md)
- **Operations** - migrations, scaling, backups: [docs/operations.md](docs/operations.md)
- **The hosted trial** - the lolly.work sandbox runbook: [deploy/vercel/README.md](deploy/vercel/README.md)

Every page in `docs/` is also served inside the console at `/admin#/docs`, so whoever runs a
deploy never needs this repository open.
