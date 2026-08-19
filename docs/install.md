# Installing

Nothing to a **running, configured, governed instance** - on a workstation (SLES /
openSUSE Leap / macOS), a single VM, or Kubernetes. Every command here is meant to be
copy-pasted as written.

| I want to... | Go to | Time |
|---|---|---|
| Just look, install nothing | [Hosted demo](#0-hosted-demo-zero-install) | 0 min |
| Evaluate locally | [1. Local demo](#1-local-demo) | 2 min |
| Evaluate on a cluster | [7a. Kubernetes eval](#7a-evaluate-on-a-cluster) | 5 min |
| Run a real single-host deploy | [5. Container (Compose)](#5-container-compose) | 15 min |
| Run it in production | [7b. Kubernetes production](#7b-production) | 30 min |
| Drive it from a terminal | [8. The CLI](#8-the-cli) | - |
| Connect a DAM or a bucket | [9. Connect a source](#9-connect-a-source) | 10 min |

The server is **zero-build**: it runs TypeScript directly on Node, no compile step, no
external assets. Sections 1 to 4 are the same for every shape - do them first, then pick
one shape from 5, 6 or 7. §9 is the last leg for every shape.

## 0. Hosted demo (zero install)

A public, passwordless sandbox runs at **<https://lolly.work>**: one-click sign-in as any
persona (admin / brand-lead / marketer / contractor), the governed admin console at
`/admin`, and live tool renders over a plain GET (`/render/qr-code.svg?url=...`). State is
in-memory and resets on redeploy; it holds nothing real.

> The demo is hosted on Vercel today purely for convenience; it is **not** the deployment
> model and will move to a **European sovereign cloud** (likely Evroc). For a real
> deployment, especially a sovereign one, you self-host: see §7 and
> [deployment](deployment.md).

## Prerequisites

**Node 24+** for everything. The server runs `.ts` sources directly via Node's native
type-stripping, so there is no build step, but that needs a modern Node.

| | macOS | SLES / openSUSE Leap |
|---|---|---|
| **Package manager** | [Homebrew](https://brew.sh) | `zypper` (built in) |
| **git** | `brew install git` (or Xcode CLT) | `sudo zypper install git` |
| **Node 24** | `brew install node` | `sudo zypper install nodejs24 npm24` |

If your distro doesn't package Node 24 yet (Leap 15.6 / SLES 15 ship older lines), use
[**nvm**](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reopen your shell, then:
nvm install 24 && nvm use 24
```

Verify: `node -v` prints `v24.x`.

**PostgreSQL 16 or 17** for anything that keeps state (§3). Not needed for §1 or a
first look at §2 - without a database the in-memory store runs and everything resets on
restart. Compose (§5) and the Helm eval install bring their own; systemd (§6) does not.

**One more tool, only for the shape you pick.** Sections 1, 2 and 6 need nothing beyond
the above:

| Shape | Also needs | Check it with |
|---|---|---|
| §5 Compose | Docker with the **Compose v2** plugin | `docker compose version` prints a version. The older standalone `docker-compose` is not it, and `docker compose up --build` fails with `unknown flag: --build` when the plugin is missing |
| §7 Kubernetes | `kubectl` and **Helm 3**, pointed at a cluster | `kubectl cluster-info` and `helm version` |

## 1. Local demo

```bash
git clone https://github.com/lolly-tools/lolly-work.git
cd lolly-work
npm install
npm run demo            # http://localhost:8787   (PORT=8788 for another port)
```

`npm run demo` builds its **own** config (it ignores `instance.json`) and seeds a whole
governed deployment in memory: four personas, tool overlays, an approval chain, projects,
and sixty days of activity history behind every console chart. It prints one passwordless
sign-in link per persona at boot. Open the printed URL:

- **Admin console** at `/admin` - sign in as `admin@suse.example`.
- **This documentation** at `/admin#/docs`.
- **Web shell** at `/` - only when a built Lolly web shell is present (see below).

The web shell and the in-shell governance UX (sign-in gate, locked tool inputs, locked
profile) come from the open-source Lolly repo, which this repo never builds. To get them,
clone it beside this one once:

```bash
git clone https://github.com/lolly-tools/lolly.git ../lolly
cd ../lolly && npm install && npm run build:web && cd -
```

Then re-run `npm run demo`. It looks for `$LOLLY_OSS_DIR`, then `../lolly`; the boot banner
says which of the three states it found (no shell / stale shell / fresh shell). The console
and render plane work in all three.

## 2. Your first real instance

This is the configuration every real shape uses. Do it locally first - the file you produce
here is what §5, §6 and §7 deploy.

```bash
npm install                              # once per checkout, before anything runs
cp instance.example.json instance.json
npm start                                # http://localhost:8787
```

`instance.example.json` is a working gated instance: the dev sign-in provider on, the
committed `packs/demo` catalog, in-memory storage.

### Sign in

Open **<http://localhost:8787/admin>**. The dev provider renders a single **Work email**
box - there is no persona list, and `you@example.com` is only a placeholder. Type one of
the two addresses `instance.example.json` actually ships, then Continue:

| Address | Group | Can do |
|---|---|---|
| `owner@example.test` | `owner` | everything, including `instance.config` and provider credentials |
| `dev@example.test` | `admin` | everything except the owner-only actions below |

Any other address answers `403`: the dev provider admits only what `dev.users` lists, so
add yourself there if you want your own address to work. Or, for scripting, mint a session
cookie directly:

```bash
curl -si 'http://localhost:8787/api/auth/dev?email=owner@example.test' | grep -i set-cookie
```

### Did it work

Five checks, in order. Each one is the prerequisite for the next.

```bash
curl -s http://localhost:8787/healthz
# {"ok":true,"name":"SUSE Content Automation","accessMode":"gated"}

C=$(curl -si 'http://localhost:8787/api/auth/dev?email=owner@example.test' \
      | grep -i '^set-cookie: lw_session' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

curl -s -H "Cookie: $C" http://localhost:8787/api/auth/session
# ..."groups":["owner"],"role":"owner"}}          ← identity and derived role

curl -s -H "Cookie: $C" http://localhost:8787/api/v1/policy/tools
# a tools array: color-palette, mesh-gradient, qr-code   ← the pack is mounted

curl -s -o out.svg -w '%{http_code} %{content_type}\n' -H "Cookie: $C" \
  'http://localhost:8787/render/qr-code.svg?url=https://suse.com'
# 200 image/svg+xml                                ← the render plane works
```

An empty `tools` array means `instance.pack` points somewhere that does not exist; the
server warns about that at boot. A `501 HOOKED_TOOL_NEEDS_CHROMIUM` on the render means
`render.allowHooksInFastPath` is `false` - see §4.

### The first owner

**Role is derived from groups, never assigned.** A user is an owner if and only if their
effective groups contain the literal string `owner` (`server/src/rbac/evaluate.ts`). There
is no bootstrap owner, no first-user-wins and no break-glass environment variable. Without
one, three actions are unreachable by anybody: `instance.config`,
`catalog.provider.credential` and `catalog.provider.publish` - which is everything needed
to connect a real DAM.

| Situation | How the first owner appears |
|---|---|
| Local (§2) | `instance.example.json` ships `owner@example.test` in group `owner`. Sign in as that persona |
| Kubernetes eval (§7a) | `deploy/helm/values-eval.yaml` ships `owner@eval.example` in group `owner`. Different addresses from §2; the §2 ones `403` there |
| SSO (§4) | Create a group named exactly `owner` in your IdP, put the deploy operator in it, and make sure it arrives in the claim named by `idp.groupsClaim` (default `groups`) |
| SSO where you cannot add that group | Any admin can mint one: `POST /api/v1/groups {"name":"owner"}` then `PUT /api/v1/users/<id>/local-groups {"groups":["owner"]}`. Both are `grant.edit`, which admin holds, and both are audited |
| GitOps / air-gap | A `LW_SEED_CONFIG` document is trusted and may grant owner-only actions to a group before any human signs in (§8, [governance](governance.md)) |

Role changes take effect on the next API request, not on the next token mint: authorization
resolves the live user record, so the same cookie gains and loses powers immediately.

### The four settings that make it yours

| Set | To | Why |
|---|---|---|
| `instance.baseUrl` | the URL this deploy actually answers on | drives OIDC redirect URIs and the `Secure` cookie flag. Wrong value breaks SSO |
| `instance.pack` | your brand pack mount | the catalog, design tokens, console theming and tools all come from here |
| `instance.shellDir` | a built `shells/web/dist` (from §1) | serves Lolly at `/` on one origin, so session cookies work and the in-shell governance UX activates |
| `idp.issuer` + `idp.clientId` | your OIDC issuer | real SSO ([identity](identity.md)) |

Under a non-`open` access mode the server **refuses to start** if `shellDir` points at a
missing or pre-governance dist, rather than silently serving an un-governed shell.
`LW_ALLOW_STALE_SHELL=1` downgrades that to a loud warning.

Full key reference: [configuration](configuration.md).

### Before you expose it

Setting `idp.issuer` does **not** turn the dev provider off. `/api/auth/dev` stays a live
passwordless bypass until you say so. Before any instance is reachable by anyone else:

1. `"dev": { "enabled": false }` in `instance.json`. The server warns at boot if a real
   issuer and the dev provider are both configured.
2. `instance.baseUrl` set to the real URL.
3. Both secrets set, and `NODE_ENV=production` so their absence is fatal (§4).
4. Behind a reverse proxy or ingress, `rateLimit.trustedProxyHops: 1`, or per-IP limits
   only ever see the proxy.

## 3. Persistence

Without `DATABASE_URL` the in-memory store runs and everything resets on restart. Correct
for evaluation, never for a real deploy.

The two platforms differ in more than the package manager, so pick your block. On Linux the
server runs as an OS user named `postgres` and only that user is a database superuser; on
macOS Homebrew creates no such OS user and makes **your own account** the superuser, so the
same two commands run with no `sudo` and no `-u postgres`.

**SLES / openSUSE Leap:**

```bash
sudo zypper install postgresql-server postgresql
sudo systemctl enable --now postgresql
sudo -u postgres createuser --pwprompt lolly
sudo -u postgres createdb --owner=lolly lolly_work
```

**macOS (Homebrew):** `postgresql@17` is keg-only, so its client commands are not on `PATH`
until you put them there.

```bash
brew install postgresql@17
brew services start postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"   # keg-only: createuser/createdb/psql live here
createuser --pwprompt lolly
createdb --owner=lolly lolly_work
```

Then, on either platform, substituting the password you just typed at the `--pwprompt`
prompt:

```bash
export DATABASE_URL=postgres://lolly:<password>@localhost/lolly_work
psql "$DATABASE_URL" -c 'select 1'   # role, database and password all correct before you go on
npm run migrate:status               # lists pending migrations, exits 1 if any
npm run migrate                      # or just start the server: migrations auto-apply at boot
```

Restart-survival needs the two secrets in §4 as well: with a database but no
`LW_SESSION_SECRET`, data persists and every session still dies on restart.

For multi-replica rollouts, turn boot DDL off (`LW_AUTO_MIGRATE=false`) and run migrations
as a job. The Helm chart does this for you; see [operations](operations.md).

## 4. Secrets

Secrets never live in the config file. Two are required in production, and `NODE_ENV`
is what makes "required" mean anything - without it, absence silently falls back to a
random key per process, so every restart logs everyone out and voids every issued link.

```bash
export NODE_ENV=production
export LW_SESSION_SECRET=$(openssl rand -hex 32)   # session/guest/state tokens
export LW_LINK_SECRET=$(openssl rand -hex 32)      # share/embed/download link signatures
```

Everything else is optional until the feature is used: `LW_IDP_CLIENT_SECRET`,
`LW_CREDENTIAL_SECRET`, `LW_METRICS_TOKEN`, `LW_RENDER_WORKER_SECRET`,
`LW_C2PA_SIGNING_KEY`, `LW_BLOBS_S3_CREDENTIAL`. See [configuration](configuration.md).

One more switch to settle before you deploy: `render.allowHooksInFastPath`. The
in-process render path refuses to run a tool's `hooks.js` unless you opt in, answering
`501 HOOKED_TOOL_NEEDS_CHROMIUM` instead. Every tool in `packs/demo` ships hooks, so
`instance.example.json` sets it `true` - that pack is curated in this repo end to end. When
you repoint `instance.pack` at a pack you do not fully control, set it back to `false` and
attach a Chromium worker (§7) instead.

## 5. Container (Compose)

**The recommended single-host shape.** One VM, Postgres alongside, no host Node and no
system user to manage.

```bash
cd <your checkout>                              # the REPO ROOT: the mount is ../../instance.json
test -f instance.json && echo "using the instance.json you authored in §2" \
  || cp instance.example.json instance.json     # only if you skipped §2
```

**Do not blind-copy the example over your own file.** The compose stack mounts
`instance.json` from the **repo root** - the same file §2 had you author. Copying the
example over it silently reverts `baseUrl`, `pack`, `idp.issuer` and `dev.enabled` to the
demo values, and no later step notices.

```bash
cd deploy/compose
printf 'LW_SESSION_SECRET=%s\nLW_LINK_SECRET=%s\nPG_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up --build                  # :8787, Postgres 17 alongside
```

All three lines of `.env` matter. The compose file refuses to start without the two
`LW_` secrets, and `PG_PASSWORD` defaults to the literal string `lolly` when you leave it
out - a database password nobody chose. Setting it here is the whole of the fix, since
both the server's `DATABASE_URL` and the Postgres container read the same variable. Change
it after first boot and the existing `pgdata` volume keeps the old password: `docker
compose down -v` (destroys data) or `alter role lolly password '<new>'` inside the container.

The compose file mounts a **directory** where `instance.json` should be if the file is
missing (that is Docker's behaviour at a missing bind source), and the server then fails to
read a directory as its config - which is why the first command checks rather than assumes.

### Verify

```bash
curl -s http://localhost:8787/healthz     # "name" must be YOUR instance.name, not the example's
```

Then run the rest of the §2 ladder against `http://localhost:8787`, signing in as an address
your own `dev.users` lists (or through your IdP if you already set `idp.issuer` and turned
the dev provider off). The image sets `NODE_ENV=production`, so a missing secret is a hard
failure rather than a silent downgrade. The pack and an optional built shell are
bind-mounted read-only; migrations auto-apply at boot.

### Before you call it done

This shape is a real deploy, so it needs the same three things §6 needs, and nothing above
does them for you:

1. `instance.baseUrl` set to the URL this host actually answers on. It drives OIDC redirect
   URIs and the `Secure` cookie flag - leave it at `http://localhost:8787` and browser
   sign-in over a real hostname will not complete.
2. TLS in front: nginx or Caddy on the host, or termination at your load balancer, proxying
   to `:8787`. Nothing in this stack terminates TLS.
3. `rateLimit.trustedProxyHops: 1` in `instance.json` once a proxy is in front, or every
   per-IP limit only ever sees the proxy.

Shape details (bind mounts, shell mount, boot guard): [deployment](deployment.md#single-vm-compose).

## 6. Bare metal (systemd)

Same code, less orchestration, when you would rather not run containers. Install
PostgreSQL and create the role and database first (§3) - the unit crashloops without them.

```bash
sudo useradd --system --home /opt/lolly-work --shell /usr/sbin/nologin lolly
sudo git clone https://github.com/lolly-tools/lolly-work.git /opt/lolly-work
sudo chown -R lolly:lolly /opt/lolly-work
cd /opt/lolly-work && sudo -u lolly -H npm install --omit=dev
sudo -u lolly cp instance.example.json instance.json    # then edit it (§2)
```

The secrets file the unit reads. `EnvironmentFile` does no shell expansion, so the values
must be written already resolved. `DATABASE_URL` goes in here too, not in the unit: it
carries the password you set at §3's `createuser --pwprompt` prompt, and this file is the
one that is `0600`. Substitute that password for `<password>` below:

```bash
sudo sh -c 'printf "LW_SESSION_SECRET=%s\nLW_LINK_SECRET=%s\nDATABASE_URL=postgres://lolly:%s@localhost/lolly_work\n" \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "<password>" > /etc/lolly-work.secrets'
sudo chown root:root /etc/lolly-work.secrets && sudo chmod 600 /etc/lolly-work.secrets
```

`/etc/systemd/system/lolly-work.service` (substitute the real `node` path if it is not
`/usr/bin/node` - `command -v node` under nvm prints something under `~/.nvm`, which the
`lolly` user cannot reach, so package-managed Node is the simpler choice here):

```ini
[Unit]
Description=Lolly control plane
After=network.target postgresql.service

[Service]
User=lolly
WorkingDirectory=/opt/lolly-work
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=LW_CONFIG=/opt/lolly-work/instance.json
EnvironmentFile=/etc/lolly-work.secrets
ExecStart=/usr/bin/node server/src/main.ts
Restart=on-failure
# hardening
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=yes
ReadWritePaths=/opt/lolly-work

[Install]
WantedBy=multi-user.target
```

`NODE_ENV=production` is what makes the missing-secret check fatal, and `PrivateTmp=yes` is
what gives the service a writable `/tmp` under `ProtectSystem=strict`.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lolly-work
curl -s http://localhost:8787/healthz          # "name" must be YOUR instance.name
sudo journalctl -u lolly-work -n 50            # if it did not come up
```

Then the rest of the §2 ladder, signing in as an address **your** `dev.users` lists, or
through your IdP if you already set `idp.issuer` and turned the dev provider off. The §2
addresses only exist in the shipped example.

Put TLS (nginx / Caddy) in front, or terminate at your load balancer, and set
`rateLimit.trustedProxyHops: 1` in `instance.json`.

## 7. Kubernetes (Helm)

![Rancher](img/rancher-icon.svg) ![k3s](img/k3s-icon-color.svg) ![Helm](img/helm-icon-color.svg)

The production path: HA, on **RKE2 or k3s** (both Rancher-managed, both verified) or any
conformant cluster.

> **Most sovereign, your choice of paid or free:**
> - **SUSE Linux Enterprise Server + SUSE Rancher Prime** (paid, supported), or
> - **openSUSE Leap + Rancher Community** (free - Leap is built from the same SLES sources).
>
> Both share the same supply chain: SUSE builds SLES/Leap and its BCI base images
> **reproducibly**, with dependencies **frozen in time alongside the build** in SUSE's
> governed datacentre in **Prague** - an auditable, rebuildable, EU-jurisdiction chain.
> With lolly-work's vendored engine (`engine-pin.json`, hash-verified, no external fetch),
> the control plane **and** the Chromium render worker run as ordinary pods on your own
> cluster: air-gappable, no US hyperscaler, no `gcloud`, no Vercel. This is the safest
> deployment.

**The image comes first.** Multi-arch images (amd64 + arm64) publish to
`ghcr.io/lolly-tools/lolly-work-server` and `...-render-worker` on every `v*` release, but
those packages are **private today**, so a stock `helm install` gets `ImagePullBackOff`.
Either add an `imagePullSecret` for GHCR, or build and push your own - which is the better
air-gap posture anyway, and is the assumption in the commands below:

```bash
docker build -f deploy/compose/Dockerfile -t <registry>/lolly-work-server:0.2.0 .
docker push <registry>/lolly-work-server:0.2.0
```

### 7a. Evaluate on a cluster

**One command** - no Postgres, no IdP, no pack mount:

```bash
helm install lolly-work deploy/helm -f deploy/helm/values-eval.yaml \
  --set image.repository=<registry>/lolly-work-server --set image.tag=0.2.0
```

The release is named `lolly-work` on purpose: Helm prefixes every object with the release
name, so this is what makes the Service `lolly-work` and lets the verification commands
below work unchanged. Name it something else and adjust them to match.

**Verify the eval install.** It is a different instance from §2 - its own name, its own
personas - so it gets its own ladder rather than a cross-reference. `values-eval.yaml` sets
`instance.baseUrl` to `http://localhost:8787`, which is exactly what the port-forward gives
you, so browser sign-in works too:

```bash
kubectl get pods -l app.kubernetes.io/name=lolly-work        # wait for Running
kubectl port-forward svc/lolly-work 8787:80 &                # Service port is 80, container 8787

curl -s http://localhost:8787/healthz
# {"ok":true,"name":"Lolly Work - evaluation","accessMode":"gated"}

C=$(curl -si 'http://localhost:8787/api/auth/dev?email=owner@eval.example' \
      | grep -i '^set-cookie: lw_session' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

curl -s -H "Cookie: $C" http://localhost:8787/api/auth/session
# ..."groups":["owner"],"role":"owner"}}

curl -s -H "Cookie: $C" http://localhost:8787/api/v1/policy/tools
# color-palette, mesh-gradient, qr-code   (the demo pack rides in the image)

curl -s -o out.svg -w '%{http_code} %{content_type}\n' -H "Cookie: $C" \
  'http://localhost:8787/render/qr-code.svg?url=https://suse.com'
# 200 image/svg+xml
```

Then open <http://localhost:8787/admin> in a browser and sign in as `owner@eval.example`.

`values-eval.yaml` ships four dev personas: `owner@eval.example` (group `owner`),
`admin@eval.example`, `brand@eval.example`, `marketer@eval.example`. The addresses in §2 do
**not** exist here; the dev provider answers `403` to anything outside its own `dev.users`.

**Reaching it over the ingress instead of the port-forward.** The eval ingress is plain
HTTP with an empty host, so you can curl the node or load-balancer IP directly - but
`instance.baseUrl` then no longer matches, and because it still starts with `http:` the
session cookie is minted without `Secure`, which is correct for that URL. Point it at the
real host so OIDC redirects and links resolve:

```bash
helm upgrade lolly-work deploy/helm -f deploy/helm/values-eval.yaml \
  --set image.repository=<registry>/lolly-work-server --set image.tag=0.2.0 \
  --set config.instance.baseUrl=http://<node-or-lb-ip>
```

Never point `baseUrl` at an `https:` URL that is not actually served over TLS: the `Secure`
flag is derived from that string, and a browser silently drops a `Secure` cookie sent over
plain HTTP, so sign-in loops back to the gate forever while `curl` still works.

Every choice in `values-eval.yaml` is commented with what it trades. Graduate the same
install in place by adding a database:

```bash
helm upgrade lolly-work deploy/helm -f deploy/helm/values-eval.yaml \
  --set image.repository=<registry>/lolly-work-server --set image.tag=0.2.0 \
  --set database.url='postgres://user:pass@host:5432/lollywork'
```

### 7b. Production

For production, `deploy/helm/values.yaml` is the one file you edit (heavily commented).
Author `instance.json` first (§2), with a real `idp.issuer` and `instance.baseUrl` matching
the ingress host - the pods refuse to start on a gated instance with neither an issuer nor
the dev provider:

```bash
kubectl create secret generic lolly-work-secrets \
  --from-literal=DATABASE_URL=postgres://... \
  --from-literal=LW_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=LW_LINK_SECRET="$(openssl rand -hex 32)"

helm install lolly-work deploy/helm \
  --set image.repository=<registry>/lolly-work-server --set image.tag=0.2.0 \
  --set existingSecret=lolly-work-secrets \
  --set-file config=instance.json
```

Migrations run as a pre-install/upgrade Job; the pack and shell mount as volumes; a
`ServiceMonitor`, `NetworkPolicy`, ingress and an optional Chromium render-worker tier ship
in the chart. Values reference and the per-key notes:
[deployment](deployment.md#kubernetes-helm---the-production-path).

Verify it, remembering that this instance is **your** `instance.json`, so its name, its
personas and its sign-in provider are the ones you authored in §2:

```bash
kubectl get pods -l app.kubernetes.io/name=lolly-work        # wait for Running
kubectl logs job/lolly-work-migrate                          # the schema Job must have succeeded
kubectl port-forward svc/lolly-work 8787:80 &                # Service port is 80, container 8787
curl -s http://localhost:8787/healthz                        # your instance.name, accessMode gated
```

`8787:80` is not a typo: `service.port` is `80` and `targetPort` is the container's `8787`.
`kubectl port-forward` resolves the remote number against the **Service's** ports, so
`8787:8787` fails with `Service lolly-work does not have a service port 8787`.

With `dev.enabled: false` (which §2 told you to set before exposing anything) there is no
`/api/auth/dev` here: sign in through your IdP at `https://<your-host>/admin`. The first
owner arrives the SSO way, from the table in §2.

## 8. The CLI

Every governance action the console does is scriptable. From a checkout:

```bash
npm run cli                                      # the command list
npm run cli -- login --email owner@example.test --base http://localhost:8787
npm run cli -- whoami --base http://localhost:8787
```

`login` first: everything else needs a session, stored at
`~/.config/lolly-work/session`. `--base` (or `LW_BASE`) names the instance; it defaults to
`http://localhost:8787`. On an OIDC instance there is no `--email` flow yet: sign in with a
browser and pass the cookie, `lw login --cookie 'lw_session=...'`.

To get a real `lw` command instead of `npm run cli --`, link the checkout once:

```bash
npm link            # puts `lw` on PATH
lw whoami
```

Useful first commands, all verified against a fresh instance:

```bash
lw export --out governance.json   # snapshot grants/overlays/chains/providers/flags
lw audit head                     # the hash-chain head, and whether it is intact
lw preview --groups admin         # exactly what a member in those groups receives
```

A fresh deploy can come up **already governed** by seeding that snapshot. The seed path is
trusted, so it can grant owner-only actions before anyone signs in:

```bash
LW_SEED_CONFIG=./governance.json npm start       # idempotent
```

Full command reference: [cli](cli.md).

## 9. Connect a source

The last leg. A deploy with no catalog source serves only what its pack ships; connecting
one is what makes it *your* instance. Every kind follows the same six steps, and the whole
sequence is **owner-only** (`catalog.provider.credential` and `catalog.provider.publish`),
so do §2's "The first owner" before you start.

**Rehearse it once with no account anywhere.** The `mock` kind takes its assets straight
from `--options`, so these commands run against a fresh instance with no network, no
vendor and no credentials. Run them, watch each step answer, then swap the kind.

```bash
export LW_BASE=http://localhost:8787            # or your instance URL
lw login --email owner@example.test              # the owner from §2

OPTS='{"assets":[
  {"remoteId":"a1","name":"Hero banner","nativeType":"image",
   "sections":["Campaigns"],"tags":["hero"],
   "formats":[{"format":"png","remoteRef":"orig","filename":"hero.png"}]},
  {"remoteId":"a2","name":"Logo mark","nativeType":"image",
   "sections":["Brand"],"tags":["logo"],
   "formats":[{"format":"svg","remoteRef":"orig","filename":"logo.svg"}]}]}'

lw providers preview --kind mock --options "$OPTS"   # 1. dry run: nothing is stored
lw providers add rehearsal --kind mock --label "Rehearsal source" --options "$OPTS"
lw providers enable rehearsal                        # 3. owner-only
lw providers sync rehearsal                          # 4. "synced rehearsal: 2 assets"
lw providers health rehearsal                        # 5. "ok"
```

`preview` prompts for a credential before it runs. `mock` needs none, so press Enter at the
prompt. A provider is always **born disabled**: `add` prints
`created rehearsal (disabled ...)`, and enabling is its own audited action.

Step 6 is the verification, and it is the one that proves the federation actually reached
the catalog. Federated ids are namespaced `ext/<provider-id>/<remote-id>`:

```bash
C=$(curl -si "$LW_BASE/api/auth/dev?email=owner@example.test" \
      | grep -i '^set-cookie: lw_session' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
curl -s -H "Cookie: $C" "$LW_BASE/api/v1/catalog/search?q=hero"
# {"q":"hero","results":[{"id":"ext/rehearsal/a1","name":"Hero banner",...}]}
```

Tear the rehearsal down when you are done. Deletion refuses on an enabled provider
(`409 PROVIDER_ENABLED`), so it is two steps:

```bash
lw providers disable rehearsal && lw providers rm rehearsal
```

### Now the real one

Same six steps, two differences: the kind, and a credential between `add` and `enable`.

```bash
lw providers preview --kind <kind> --options '{...}'   # confirm the tenant answers first
lw providers add <id> --kind <kind> --label "..." --options '{...}'
lw providers credential <id>          # prompts; never passed on argv, sealed at rest
lw providers enable <id>
lw providers sync <id> && lw providers health <id>
```

**What `--options` must contain is per platform**, and so is where the credential comes
from. One guide per kind, each written for the owner of the source platform: Brandfolder,
S3 / MinIO, git manifest, Optimizely CMP, Image Relay, Canto, Acquia DAM / Widen,
IntelligenceBank, Penpot, Dropbox, Google Drive, Microsoft 365. Start at
[the provider guides](providers/README.md) and pick yours. Some OAuth kinds
(`dropbox`, `gdrive`, `o365`) replace the `credential` prompt with
`lw providers auth <id>`, a PKCE loopback consent flow.

Console equivalent of all of the above: **This Deploy → Providers**. Exposure governance
(which groups see a source, approved-only, reference vs downloadable) is a separate
decision on the same record: [catalog](catalog.md).

## Checks

```bash
npm test           # node:test over tests/ (Postgres leg runs when LW_TEST_DATABASE_URL is set)
npm run typecheck  # tsc --noEmit
npm run sbom       # regenerate sbom.cdx.json
```

## What next

- **Configuration** - every key: [configuration](configuration.md)
- **Identity / SSO** - wiring your OIDC issuer: [identity](identity.md)
- **Deployment shapes** - the full matrix, RKE2/k3s, air-gap: [deployment](deployment.md)
- **Operations** - migrations, scaling, backups: [operations](operations.md)
- **Connecting a DAM** - the governance around what §9 connected: [catalog](catalog.md)
- **Per-platform setup** - one guide per provider kind: [provider guides](providers/README.md)
