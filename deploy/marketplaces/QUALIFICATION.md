# Neutral package reference qualification

## Lolly Work 1.1.3 package, Spinifex, 2026-10-29

This run qualified the package this change pins: Work 1.1.3 (server
`sha256:9a9b03cc…b363`, source `129d9294`) with the published 1.1.3 web app archive
`lolly-web-1.1.3-ynh1.tar.gz` (752,098,780 bytes, SHA-256
`1ff9a26889d10984ce377e6890283859a9ba7bca2981d8df1e49e572e792925d`, signed catalogue
generation 4), downloaded by the content service from `lolli.li` as an installation
would. An agent ran it on the maintainer's behalf on a dedicated, disposable VM in the
MulgaDC Spinifex sandbox, and everything it created was deleted afterwards. This is a
reference installation, not marketplace admission or a platform certification.

| Input | Tested value |
|---|---|
| Provider / region | MulgaDC Spinifex sandbox, `us-west-1`, through its EC2 API |
| OS / architecture | Debian 13 image `ami-debian-13-x86_64`, kernel 6.12.113, native amd64 |
| Compute / disk | `m6a.large`: 2 vCPU, 8 GB RAM, 40 GB root volume |
| Network | Docker's MTU set to 1442 before the first start, as the package guide says |
| Docker / Compose | 26.1.5 / 2.26.1 (Debian packages) |
| HTTPS | Caddy's internal CA on `work.example.test`; the browser trusted only that chain |
| Sign-in | Built-in password and a host-issued owner link |
| Rendering | No Chromium worker; checked `asset-export` SVG |

The generated Compose file was installed unchanged (SHA-256
`cdc8556f5e045d84f516a24dc14664cb2984ad0b9eecb9716aa5b8dc9feafb18`); only the Caddyfile
gained `tls internal`. The browser check ran headless Chromium 156.0.8078.4 from the 1.1.3
render worker image with SwiftShader WebGPU, and the drivers are the ones used for 1.1.2
(browser check `f61f4713…`, API acceptance `74dd0c45…`).

Each run started on fresh volumes unless noted. Every check passed:

- **As shipped.** Ready in about four minutes, including the archive download and the
  content service's key step. API: owner setup link, password setup, owner session,
  anonymous catalogue refused (401), signed-in catalogue of 69 tools, a project, an
  `asset-export` SVG render with the same bytes as the earlier references
  (`b2224c0b…bd03`) and evidence, an idempotent replay, and a QR Code job refused with
  `HOOKED_TOOL_NEEDS_CHROMIUM` as documented. Browser: sign-in through the password
  form, the catalogue reported `verified`, the gallery listed 43 tools and QR Code
  opened and drew.
- **Without the key step.** The content service ran without
  `LW_SOURCE_CATALOG_PUBLIC_KEY`, so the archive was installed unchanged (no
  `catalogue-key.json`; the publisher key is still the one in the web app's files and
  the installation key is in none of them). Every API and browser check passed as
  above. The 1.1.3 web app fetched the installation's key from
  `/api/v1/catalog/public-key` on the same origin, the key the server's key file
  holds, and verified the catalogue with it. With 1.1.2 this same setup showed "Couldn't
  load the tools". The key step is therefore no longer needed for 1.1.3 web apps.
- **Update from the 1.1.1 package.** The current 1.1.1 package (the `main` pin, with
  the key step) was installed and passed every check, then updated in place to this
  package, keeping `.env`, the project name and the volumes. The update took under
  four minutes. Afterwards `catalogPublicationGeneration` was 4 (from 3), the
  installation key was unchanged and still owned by the server's user with mode 600,
  the 1.1.1 content was kept beside the new content, and the owner session, the saved
  project, the catalogue and the whole browser check passed.

The listing screenshots for 1.1.3 come from Helm qualification run
[40946250552](https://github.com/lolly-tools/lolly-work/actions/runs/40946250552),
which booted the package on amd64 and arm64 and captured all five views, the gallery
and editor included.

Not covered: public ACME, member sign-in, a provider reboot, restore into a separate
installation, an arm64 provider VM and organisation OIDC. The receipts and drivers are
retained outside Git.

## Browser check of the catalogue key step, Spinifex, 2026-10-27

This run tested the content service's catalogue key step with a matched Work and Lolly
pair before the package moves to its next release. The package's `release.json` still
pins 1.1.1; the run pinned the 1.1.2 pair. Lolly 1.1.2 published no web app archive,
so the archive was cut locally from the signed `ghcr.io/lolly-tools/lolly-web:1.1.2`
image (`sha256:dd1c3910…d829`) and never published: `lolly-web-1.1.2-ynh1.tar.gz`,
728,516,824 bytes, SHA-256
`6bbccd06bc2288245637cd36a668d726820e07ff01c01fdc4033378e4f5cf488`, the same bytes from
a macOS arm64 Debian 13 container and a Debian 13 amd64 VM. Afterwards
`scripts/cut-shell-archive.sh 1.1.2 sha256:dd1c3910…d829` reproduced that archive byte
for byte, and `scripts/marketplace-cohort.ts` reproduced the tested `release.json` and
Compose file, as well as the committed 1.1.1 pin. That image carries the `lolly-demo`
profile; the 1.1.1 archive carries `lolly-start`.

An agent ran the installation on the maintainer's behalf, on a dedicated, disposable VM
in the MulgaDC Spinifex sandbox, an AWS-compatible cloud. Everything it created was
deleted afterwards. This is a reference installation, not marketplace admission or a
platform certification.

| Input | Tested value |
|---|---|
| Provider / region | MulgaDC Spinifex sandbox, `us-west-1`, created through its EC2 API |
| OS / architecture | Debian 13.7 image `ami-debian-13-x86_64`, kernel 6.12.107, native amd64 |
| Compute / disk | `m6a.large`: 2 vCPU, 8 GB RAM, 40 GB root volume |
| Network | Guest MTU 1442; Docker's MTU set to 1442 in `/etc/docker/daemon.json` before the first start, as the package guide says |
| Docker / Compose | 26.1.5 / 2.26.1 (Debian packages) |
| Application | Work 1.1.2 server `sha256:68ef78a1…0504` and the archive above |
| Archive delivery | A temporary Spinifex S3 bucket through a presigned URL; setup verified the pinned SHA-256 |
| HTTPS | Caddy's internal CA on `work.example.test`; the sandbox gives no public name. The browser trusted only that chain |
| Sign-in | Built-in password and a host-issued owner link; no external IdP or mail service |
| Rendering | No Chromium worker; checked `asset-export` SVG |

The generated Compose file's SHA-256 was
`014d04a44f4c5416c497ad48a33b3e87d5a41f0104b3e3e71b6dc2b3379db4fe`. The installed
copy changed only `LW_SHELL_URL` and the Caddyfile (`tls internal`).

**Without the key step.** The same pair with the content service left without
`LW_SOURCE_CATALOG_PUBLIC_KEY`, so the archive is installed unchanged, passed every API
check, and in Chromium the web app showed "Couldn't load the tools" with "Catalog
refused: signature does not verify against the pinned key" and no tools. A newer
release alone does not fix the browser: the 1.1.2 web app pins the publisher key the
same way 1.1.1 does. The current 1.1.1 package showed the same refusal on this VM.

**With the key step**, on fresh volumes:

- Content setup took about 140 seconds: download, full checksum, extraction and the
  key step, which rewrote five `_app` scripts and their `.br` and `.gz` copies and
  recorded them in `catalogue-key.json`.
- API: owner setup link, password setup and owner session; anonymous catalogue refused
  (401); the signed-in catalogue lists 68 tools; a project is created; an
  `asset-export` SVG render job succeeds with the chosen colour, evidence and an
  idempotent replay. The SVG's SHA-256 is
  `b2224c0b59cdb0a5aaa1d71cf963e61f5ee6a2699e52e611afa365c72978bd03`, the same bytes as
  the 1.1.1 reference below. A QR Code render job is refused with
  `HOOKED_TOOL_NEEDS_CHROMIUM`, as documented for a package without the worker.
- **Browser:** headless Chromium 156.0.8078.4 (the 1.1.2 render worker image's
  Playwright build, SwiftShader WebGPU) signed in through the password form and got the
  owner session. The web app reported the catalogue as `verified`, the gallery listed
  43 distinct tools (Utilities hold the rest of the 68), and QR Code opened and drew
  its template previews.
- `/models/embed/config.json` through the instance returned the file from `lolli.li`:
  the image-built web app has an empty model base, so the browser asks only the
  instance for models.
- `/readyz` answered 503 for about 30 seconds after the server became healthy, while
  catalogue preparation ran, then 200.
- A provider reboot through `RebootInstances` (new boot ID): Docker restarted the
  services, and the existing owner session, the anonymous refusal, the catalogue, the
  saved project and the whole browser check passed again.

**Update from the 1.1.1 package**, on fresh volumes: the current 1.1.1 package was
installed and accepted (its browser check showed the refusal above), then updated in
place as the package guide describes, keeping `.env`, the project name and the
volumes. The server was unavailable for about three minutes while content setup ran.
Afterwards the stored `catalogPublicationGeneration` was 4 (from 3), the content
pointed at the new archive with the 1.1.1 content kept, the catalogue key was
unchanged and still owned by the server's user with mode 600, migrations 0072 to 0075
applied, and the existing owner session, the saved project and the whole browser
check passed. Reading the existing key exercised the content service's ownership step,
which the first attempt on fresh volumes had failed with `EACCES`.

**The current 1.1.1 package with the key step, in CI.** Helm qualification run
[40487638108](https://github.com/lolly-tools/lolly-work/actions/runs/40487638108),
dispatched with `screenshots=true` on this change, booted the 1.1.1 package on amd64
and arm64. Both legs passed the container qualification. In the amd64 leg's Chromium
the web app accepted the catalogue: the gallery listed the tools with their previews
and the Chart tool opened and drew its chart, captured as `tool-editor.png`. The gallery
capture itself timed out after 120 seconds waiting for the web app's
`data-shots-settled` marker, so the run failed. The listing captures need that wait
fixed before they can be refreshed.

Seen and not fixed here: the browser's requests for
`/catalog/assets/lolly/tokens/demo.6352b216e44e0fe0.json` (present in the pack) and
`/catalog/fonts/ttf/SUSE-Regular.ttf` and `SUSE-Bold.ttf` answered 404. The gallery and
tools worked regardless.

Not covered by this run: public ACME, member sign-in, restore into a separate
installation, recovery on a second host, organisation OIDC, an arm64 provider VM and
the published archive of the next release, which needs its own receipt. The receipts,
screenshots and drivers are retained outside Git. Driver SHA-256s: browser check
`f61f471337131972079dc64e3e92a363b080bd00a85ef9acba7ec0424039859b`, API acceptance
`74dd0c45c788666185af2c74ae8a8d707a612ee96b26dc733ab53c95068dcec6`.

## UpCloud reference for 1.1.1

On 2026-10-16 the package from Work source
`00ba001a0683eac116b83775c07dc79f8fa3a29a` was installed on a dedicated, disposable
UpCloud VM. This is a reference installation, not marketplace admission or a
platform certification.

| Input | Tested value |
|---|---|
| Provider / region | UpCloud, Frankfurt `de-fra1` |
| OS / architecture | Public Ubuntu 24.04 image, native amd64 |
| Compute / disk | 2 vCPU, 4 GB RAM, encrypted 80 GB Standard disk |
| Docker / Compose | 29.1.3 / 2.40.3 |
| Application | Published Work 1.1.1 images and matched neutral shell from `release.json` |
| HTTPS | Public ACME certificate on the provider-assigned hostname; no project DNS changes |
| Sign-in | Built-in passwords, host-issued owner link and invited member link; no external IdP or mail service |
| Rendering | No Chromium worker; checked `asset-export` SVG with selected colour and 240 × 120 output dimensions |

The generated Compose file was used unchanged. Its SHA-256 was
`ad83e2e5d4fff220811d72227c2ce5174d25730e5401bac4fd364038ae4bff7c`.
The qualification driver used the actual provider hostname, public ACME and a
retained target instead of CI's temporary local-CA fixture. Driver SHA-256:
`b6b98ec43133a408d655379a259e9bec0261e540b991670a5fbcc62c12c2cc6a`.

Verified outcomes:

- First-owner password setup and sign-in, single-use setup links, invited member
  sign-in with the member role, and refusal of the development login bypass.
- The signed source catalogue verifies under its pinned publisher public key;
  the instance retains its own separate key for caller-specific signatures.
- A private project, saved tool document and uploaded checked SVG survive API
  reloads, process restart and a full provider reboot. Anonymous access and an
  unrelated member remain refused. Automatic application startup was checked
  after the installation files were moved to durable host storage.
- An independent application installation, using fresh volumes and a new
  PostgreSQL database, restores the captured database, configuration, signing key
  and environment. Both existing sessions/roles, document inputs, catalogue access,
  original output checksum and access boundaries work over separately trusted HTTPS.

The checked SVG SHA-256 is
`b2224c0b59cdb0a5aaa1d71cf963e61f5ee6a2699e52e611afa365c72978bd03`.
The private evidence/recovery archive is 387,226 bytes, SHA-256
`7aa96f775dd6ec20440bfc15108dd5465faea89b999110f138df3aa5e31439c3`.
It contains installation secrets and fixture data and is retained outside Git.

The first live attempt exposed a missing publisher public-key pin; health and
sign-in alone had passed. The corrected package was freshly installed and CI now
checks admitted catalogue access and a real export. The reboot test also exposed
an ephemeral fixture path; customer installations must use durable host storage.

A browser capture of the same package's CI fixture on 2026-10-17 found that the
neutral 1.1.1 shell refuses the installation's per-caller catalogue: "signature does
not verify against the pinned key". Work signs each caller's tool index with the
installation key, and the checksum-pinned public shell has the publisher key built in,
so a signed-in browser shows no tools. The checks above call the API and never load
the shell in a browser. Browser use of the shell is not qualified; see
[the listing screenshots](assets/README.md#shell-views-withheld-for-111).

Still unqualified: an installed-instance **cross-version upgrade**, recovery on a
second host, external organisation OIDC, an arm64 provider VM, Dokploy UI/import/
update behaviour and live Rancher installation. The infrastructure module's mocked
CI checks are separate from this VM, which was created through UpCloud's API.
The private host-preparation harness needed an SSH service-order correction; this
result does not claim a one-click OS bootstrap or an end-to-end provider template.

## Native arm64 in CI

The same package also passes on GitHub's native `ubuntu-24.04-arm` runner. The
Helm qualification workflow runs it as "Neutral Compose installation and recovery
(native arm64)" on every main push, release tag and nightly run, and on each pull
request that changes chart, Compose, marketplace or server inputs, beside the
amd64 job. arm64 is listed in `qualifiedArchitectures` in [`release.json`](release.json) only
while that job stays required. It first passed on 2026-10-17 in
[PR #183](https://github.com/lolly-tools/lolly-work/pull/183) (workflow run
39044655738, runner image `ubuntu-24.04-arm` 20261012.149). Its receipt records
`nativeArchitecture: arm64` and the unchanged package Compose SHA-256 above.

The driver refuses a runner whose Docker architecture differs from the job. It
also checks that the server, database and proxy containers each run their native
arm64 image, because an emulated amd64 image would report its own machine. The
run covers a fresh container installation, HTTPS through a local test CA,
first-owner password setup and sign-in, refusal of anonymous access and the
development login, admitted catalogue access, a checked `asset-export` SVG,
persistence across a server restart and a database dump restored into a second
database.

It does not cover a provider VM, public ACME, a full host reboot, member sign-in
or restore into a separate installation. Those were checked on amd64 only. The
render worker is not part of this package; its arm64 image is still built under
emulation and has no arm64 runtime qualification.
