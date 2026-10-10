# Private catalogue checks during shell updates

A private instance can serve its shell publicly while requiring sign-in for the
tool catalogue. `publish-private-shell.py` supports that configuration through
an optional, separately reviewed authenticated probe. An update still uses the
existing Work image, engine pin and asset pack; only a qualified shell claim and
its provenance change. The normal ungated route remains unchanged.

A private catalogue is not necessarily a static copy. Work filters the index for
the caller and signs its exact response at runtime. Verify the caller's exact
index oracle, visible file digest map and pinned P-256 signature. Do not compare
the runtime signature bytes to a build-time envelope: signatures and `signedAt`
can differ even when the content is correct. Full mounted shell/pack/pin byte
checks and the prepared envelope signature remain independently mandatory.

## Configure the reviewed command

For the frontend update facade, use one protected instance profile with
`authenticatedCatalog`. The maintained probe derives its release inputs from
the exact prepared commit, original planning evidence and current accepted
owner. No release-specific credential script or reconciliation input is needed.
The older `authenticatedStaticProbe` command remains supported; select one
interface in the profile.

```json
{
  "authenticatedCatalog": {
    "source": {"path": "/checkout/scripts/probe-private-shell-catalog.py", "sha256": "<reviewed SHA256>"},
    "module": {"path": "/checkout/scripts/private-shell-catalog-probe.mjs", "sha256": "<reviewed SHA256>"},
    "python": "/usr/bin/python3",
    "node": {"path": "/opt/node24/bin/node", "version": "v24.21.0"},
    "migrations": {"path": "/protected/accepted-migration-ledger.json", "sha256": "<reviewed SHA256>"},
    "caller": {
      "project": "prj_APPROVED_EXISTING_PROJECT",
      "session": "ses_APPROVED_EXISTING_DESIGN_SESSION",
      "emails": ["approved-owner@example.org"]
    }
  },
  "stageNamePrefix": "private-shell"
}
```

Add the probe, module and ledger references to the profile's `sourceFiles`.
The ledger is the exact sorted array of accepted `schema_migrations` names.
The caller selector is an explicit authorization choice: it borrows the active
owner of that existing project, after checking the email allowlist and a live
design session in that project. It creates no account or invitation. A changed,
disabled or missing owner/session refuses. Review this choice once for each
instance; do not assume the deployment credential also authorizes any caller.

The probe verifies the unchanged image and complete owning Pod defaults, exact
Deployment/ReplicaSet chain, running process, accepted engine pin, owned server
source hashes and migration ledger. It makes the lookup in a read-only database
transaction inside that owner. The signed cookie stays in memory for at most
300 seconds; receipts contain response hashes and lengths only. The same site
preflight runs last before the owning-process execution. Normal CA and hostname
verification are mandatory, with no redirects or TLS exceptions.

Preparation's catalogue has exactly four fields: `indexSha256`,
`envelopeSha256`, `keyId`, `signedFiles`. The mounted runtime proof has those four
plus `publicPinSha256` and `signatureVerified`. Each is validated independently.
For the authenticated HTTPS response, the probe computes the actual caller's
policy-filtered index and visible file map from accepted Work code, then verifies
the fresh pinned P-256 envelope. It does not claim that this fresh envelope has
the same bytes as the prepared envelope.

`check` on the maintained probe is offline custody and complete CommonJS
executor syntax only. It neither borrows a cookie nor reads a target:

```sh
python3 -B scripts/probe-private-shell-catalog.py \
  --input /protected/update/publication-plan/catalog.probe.input.json \
  --input-sha256 REVIEWED_INPUT_SHA256 --check
```

This first maintained profile supports the Node24 Work image layout and an
existing project owner's account. Other identity providers still work for users;
this deployment check does not provision them or impersonate arbitrary users.
Export, document-agent and signed-in browser canaries remain separate.

Add `authenticatedStaticProbe` to the reviewed publication input. Register both
its source and its input in `sourceFiles`, along with every operator dependency
and any additional code/data dependency used by the probe. Keep secrets out of
these envelopes, command arguments, receipts and stdout. A protected probe input
may identify existing credential custody without embedding its values.

```json
{
  "authenticatedStaticProbe": {
    "profile": "NORMAL_TLS_PER_CALLER_INDEX_ORACLE_AND_PINNED_P256_ENVELOPE",
    "source": {"path": "/protected/catalog-probe.py", "sha256": "<reviewed source SHA256>"},
    "input": {"path": "/protected/catalog-probe-input.json", "sha256": "<reviewed input SHA256>"},
    "argv": ["/usr/bin/python3", "-B", "/protected/catalog-probe.py", "--input", "/protected/catalog-probe-input.json", "--input-sha256", "<reviewed input SHA256>"]
  }
}
```

The command is an instance-specific credential and transport adapter. The
publisher does not create accounts, assume an administrator identity, install a
sign-in bypass, or prove that arbitrary supplied code is safe. The operator must
review its code and all dependencies before allowing it to run. `check` validates
custody and syntax of the invocation without running the command or contacting
the target. Credentials must authorize only the intended read checks.

The command must read one non-secret JSON context from stdin, validate its own
hash-bound input, and emit one bounded JSON receipt on stdout with empty stderr.
Its argument list is exactly the example shape; `-B` is optional. The context
binds the actual owning Deployment/Pod/ReplicaSet, sources/image, qualified
manifests/pin, full content proof, HTTPS origin and public key. It does not supply
cookies or credential values. All response bodies and credentials stay inside
the reviewed probe; emit hashes, lengths and verification results only.

The probe must recheck runtime/source bindings before borrowing a temporary
session, use read-only database transactions if a database lookup is needed,
limit the session to 300 seconds, discard memory references in `finally`, and
perform HTTPS GETs without redirect following or TLS exceptions. Existing
credentials are never printed or persisted in a new receipt. If generating
Node code, test the exact executor mode offline: a CommonJS `node -e` program
should wrap asynchronous work in an async IIFE. Do not qualify a program only
with a different `--input-type=module` parser. Include cryptographic positive and
mutation-negative fixtures, with fixture receipts clearly labeled synthetic.

## Receipt contract

The maintained pure validator is
`authenticated_catalog_report(value, context, probe, catalog, public_pin)` in
`scripts/publish-private-shell.py`. It makes no network or production calls.
The exact top-level fields are:

```text
version: 1
status: AUTHENTICATED_PRIVATE_SHELL_CATALOG_PROBE_ACCEPTED
contextSha256: SHA256 of canonical context JSON (without a trailing newline)
inputSha256: exact reviewed probe input file SHA256
sourceSha256: exact reviewed probe source file SHA256
profile: NORMAL_TLS_PER_CALLER_INDEX_ORACLE_AND_PINNED_P256_ENVELOPE
probes: [index response, envelope response]
oracle: {indexSha256, indexBytes, expectedIndexSha256, envelopeSha256,
         envelopeBytes, expectedFileMapSha256, signedFiles, publicPinSha256,
         keyId, signedAt, signatureVerified, exactPerCallerIndexBytes,
         exactVisibleFileMap, sourceBindingSha256}
tls: {certificateRequired: true, hostnameVerified: true, redirectsFollowed: false}
scope: {databaseDirectWrites: false, documentWrites: false, invitationWrites: false,
        cookiePrinted: false, cookiePersisted: false, maximumSessionSeconds: 300}
```

Each response has exactly `path`, `url`, `status`, `verifiedTlsAndHostname`,
`authentication`, `bytes`, `sha256`, and `oracle`. Paths are
`catalog/tools/index.json` then `catalog/tools/index.sig.json`; URLs use the
actual Work HTTPS origin. Status is integer 200, authentication is
`TEMPORARY_MEMORY_SESSION`, and oracle is the profile above. Length/hash must
match the corresponding oracle response. All hashes are lowercase SHA256 hex;
boolean and integer fields require their actual JSON types.

The probe must prove that `indexSha256 == expectedIndexSha256` for the exact
accepted Work caller-index producer, and that the envelope's `indexHash` and
complete visible `files` map match that oracle and the qualified mounted file
hashes. `publicPinSha256` and `keyId` must match the qualified key. The three
verification flags are true. Bound body sizes to 2 MiB each and the signed file
count to the qualified set. A cached signature can predate this request;
`signedAt` must be inside the current owning process lifetime with at most 60
seconds clock tolerance. Recompute the cryptographic verification during the
probe. `sourceBindingSha256` binds the exact accepted runtime modules used by the
oracle; their custody must be reviewed in the probe's input.

## Guarded execution and continuity

The publisher requires literal anonymous 401 responses containing `UNAUTHORIZED`
and `this deployment is sign-in gated` on both catalogue paths. It records the
normal verified TLS gate body hashes. `index.html` must remain a normal-TLS 200
with exact prepared bytes. It reads complete fresh inventories before the
probe, checks the same actual owner/controller/spec/image/readiness, and runs the
reviewed target preflight immediately before invoking it. Afterwards it repeats
all fresh inventories and exact owner checks. There is no cache across these
steps. The command is capped at 300 seconds and ambiguous phases are not replayed.

Success emits `PRIVATE_SHELL_RUNTIME_AND_AUTHENTICATED_HTTPS_ACCEPTED` with an
explicit authenticated catalogue profile and proof refs for source, input,
context, original command output, report, anonymous gates, and the original
publication input. That publication input retains the complete registered
source closure and exact probe invocation for subsequent offline validation.
Emitted probe source/input refs are absolute canonical paths, so a later
preparation envelope can live in another directory. References inside the
unchanged original publication input retain their original directory base.
The portable
accepted-previous input retains these refs through its original acceptance.
It does not claim prepared catalogue HTTPS byte equality or complete browser /
agent / native qualification. Importing the pure validator for a subsequent
offline preparer does not execute the command. Standard authenticated acceptance
and explicit reconciliation of an earlier failed observation have distinct
provenance contracts; never relabel a failed original phase as successful.

Use instance target instructions and the ordinary target preflight before any
mutation. For lolly.ing and lolly.tools specifically, their production README
and UpCloud K3s identity are authoritative; generic examples are not a deployment
route for those domains.
