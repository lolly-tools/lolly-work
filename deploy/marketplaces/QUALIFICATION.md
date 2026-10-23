# Neutral package reference qualification

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
