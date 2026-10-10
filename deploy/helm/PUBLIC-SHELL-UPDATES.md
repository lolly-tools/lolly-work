# Public UI updates with an unchanged static server

This lane prepares a public Lolly web update without rebuilding a container image,
Rust, models, tools or documentation. It is separate from private Work shell
updates: the public server is Nginx, has no Work raw pack or private engine-pin
mount, and serves the neutral `lolly-start` catalog. A private artifact or runtime
receipt cannot qualify a public update.

The maintained producer, offline planner, stager and publisher are available.
Start with the [ordinary frontend update guide](../../docs/frontend-updates.md)
for the developer/operator handoff, then follow
[public staging and promotion](PUBLIC-SHELL-PROMOTION.md). The two preparation
commands below make no cluster calls or deployment changes and do not authenticate
receipt origins. Local preparation is not owning-runtime acceptance. For
`lolly.tools`, read the instance's production handoff before selecting a target.
Its historical `candidate` host/context is the production cluster.

## One initial overlay, then small code updates

The public Nginx image and its `/usr/share/nginx/html` root remain unchanged.
One new shell PVC supplies exactly these five **read-only** subPath mounts:

| Mount under `/usr/share/nginx/html` | PVC subPath | Content |
| --- | --- | --- |
| `/_app` | `_app` | Current UI chunks and every previously accepted lazy chunk |
| `/index.html` | `index.html` | New entry point |
| `/precache.json` | `precache.json` | Current precache manifest |
| `/sw.js` | `sw.js` | Maintained service worker |
| `/portable/player.js` | `portable/player.js` | Maintained portable player |

The first plan adds one volume, these five serving mounts and a preceding
whole-volume read-only anchor at `/run/lolly-public-overlay`. It selects
`securityContext.fsGroupChangePolicy: OnRootMismatch`. The PVC source stays
managed and writable to the kubelet; all six application mounts are read-only.
The whole-volume anchor lets normal SELinux relabeling finish before the serving
subpaths are resolved. Before each handoff, the maintained operator requires
fresh whole-root metadata with GID 101, owner/group `rwx` and setgid; it also
checks the separate model root before publication. A mismatch refuses without
repair. This handoff supports the pinned `local` volume plugin and
`rancher.io/local-path` provisioner; CSI and `hostPath` volumes refuse.

Later plans change only the claim name and three public shell provenance
annotations. The accepted image, model claim/PV/subPath, Nginx ConfigMap, all
other mounts and security settings,
resources, probes, policies, services and unselected spec fields stay exact.
The original image remains available for rollback; a rollback needs fresh live
identity/spec guards and its own reviewed intent.

The currently accepted public image has roughly 157 MB in `_app`, including
retained lazy chunks, versus about 1.35 GB of static content. The overlay avoids
copying its catalog, tools, fonts, ORT resources and documentation on each
deployment. Local preparation still verifies the complete static tree and uses
APFS clones when available; copy fallback must maintain the 2 GiB disk floor.
No model files enter any shell manifest or overlay.

## Prepare the public artifact

Use Node 24+, Python 3, a clean immutable Lolly checkout, and already installed
dependencies matching its unchanged lock/config. This command never installs or
regenerates source prerequisites. Some maintained Vite plugins check ignored
`shells/web/public/ort` and `ort-hf` cache paths even with an external publicDir;
provide their exact accepted public bytes when those plugins require them.
Any existing ORT, ORT-HF or visualization cache must match the accepted tree.

Obtain the complete previous public static snapshot through its **owning** Pod
as a read-only stream, or from its custodied image archive. Exclude the separate
`models` mount. Never mount an active production shell/model PVC into staging:
SELinux relabeling can affect the active owner. Do not use a private Work catalog
or pack, even if it uses the same P-256 verification key.

Create a reviewed custody JSON with exactly these fields:

```json
{
  "version": 1,
  "artifactClass": "public-shell-overlay",
  "imageSource": "ACCEPTED_IMAGE_LOLLY_COMMIT",
  "previousShellSource": "ACCEPTED_SHELL_LOLLY_COMMIT",
  "image": "registry.example/public@sha256:ACCEPTED_IMAGE_DIGEST",
  "profile": "lolly-start",
  "settings": {
    "catalogTrustMode": "verified",
    "requireAiPolicy": false,
    "liveRelay": "https://lolly.tools/live",
    "siteUrl": "https://lolly.tools"
  },
  "previousManifest": {"path": "/review/previous-static.json", "sha256": "SHA256"},
  "previousAcceptance": {"path": "/review/original-public-acceptance.json", "sha256": "SHA256"},
  "ci": {"path": "/review/original-normal-main-ci-run.json", "sha256": "SHA256"},
  "publicKeySha256": "EXISTING_PUBLIC_JWK_BYTES_SHA256",
  "publicCatalog": {
    "indexSha256": "SHA256",
    "envelopeSha256": "SHA256",
    "pinCanonicalSha256": "SHA256",
    "keyId": "EXISTING_PUBLIC_KEY_ID",
    "signedFiles": 2177
  }
}
```

The placeholders must be real reviewed immutable commits, image digest and
SHA-256 values. The current public policy above is fixed intentionally; changing
profile, policy, site, relay, catalog, pin, dependencies, Vite configuration,
engine, schemas, tools, brand content or any unknown source path requires a
broader qualified release. Catalog signatures are verified and reused; no
signing key is required. This v1 lane is for the accepted `lolly.tools` public
policy; another instance needs its own reviewed public contract.

```sh
node scripts/prepare-public-shell-update.ts \
  --source /clean/lolly --base ACCEPTED_SHELL_COMMIT --candidate NEW_MAIN_COMMIT \
  --previous-shell /review/previous-public-static --public-key /review/public.jwk.json \
  --custody /review/public-custody.json --custody-sha256 REVIEWED_SHA256 \
  --out /review/new-public-update
```

`public-shell-update.prepared.json` has status
`LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED`. It binds the candidate and image
source separately, original local Vite/catalog/web-gate reports, complete helper
source closure, source-bound main/worker workspace graph, full previous/candidate/
retained manifests, changed UI delta and a separate five-path overlay manifest.
Local `normalCIQualified`, `runtimeQualified`, origin authentication and promotion
flags remain false. Retention conflicts, static removals/additions outside the
five paths, source/cache drift and copy failures stop preparation and preserve
refusal/original reports. The output directory is exclusive and cannot replay.

## Bind an offline plan

The planner accepts a hash-reviewed JSON with exactly:

- `version: 1`;
- `lolly`: the maintained source record `{root,source,repository,main,ciRun,ciJobs}`
  with original normal main GitHub run/job receipts;
- `producer`: a hash reference to the new public producer receipt;
- `previous`: a hash reference to the reviewed baseline envelope below;
- `selection`: `{container,shellVolume,shellClaim}` selecting one new overlay claim;
- `desiredSpec`: a hash reference to the complete proposed Deployment spec.

Every hash reference uses `{path,sha256}`. The baseline envelope contains exactly
`version,imageSource,shellSource,image,profile,settings,publicKeySha256,publicCatalog,
staticManifest,overlay,deploymentSpecSha256,deployment,nginxConfig,modelsClaim,
modelsPV,policyInventory,serviceInventory,originalEvidence`.

`deployment`, `nginxConfig`, `modelsClaim` and `modelsPV` are complete original
resource JSON refs with API/kind/scope/name/UID/RV. Models must be Bound and preserve
their exact accepted backing. Policy and service inventory refs contain complete
`name: {uid,spec}` maps. The original public647 staging policy's recorded retirement
is the sole historical inventory exception. `staticManifest` is the complete v1
static manifest `{version,files:[{path,size,sha256}],totalBytes}`.

For the first overlay, `overlay` is null. `originalEvidence` contains four refs,
in order: genuine public647 post-promotion acceptance, its original independently
prepared image expectation, complete effective static inventory
`{htmlRoot,files:{path:{mode,size,sha256}}}`, and its exact original runtime
checksum-list bytes. The planner parses their owner, image, full spec, catalog,
key, model, config, full-tree, retirement and normal TLS proofs; a success label
or normalized wrapper alone is insufficient.

For subsequent updates, `overlay` is
`{volume,claim,claimUID,manifest}`. Keep the original image expectation as evidence
item 2; add the prior public overlay plan as item 5, and provide that overlay's
genuine `PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED` runtime receipt, effective static
inventory and checksum list. The maintained publisher emits this acceptance
protocol after its actual owning-runtime and normal-TLS checks. A repeated public
promotion requires that genuine previous acceptance; the offline lane emits no
live acceptance of its own.

```sh
python3 scripts/prepare-public-shell.py \
  --evidence /review/public-shell-evidence.json \
  --reviewed-evidence-sha256 REVIEWED_SHA256 \
  --node /path/to/node24 --out-dir /review/new-public-plan
```

The shared exclusive offline writer emits `cohort.prepared.json`, whose explicit
public status is `PUBLIC_SHELL_OVERLAY_PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED`.
It includes the exact desired spec, full UID/RV/spec guarded patch template,
reference-only rollback, original hash refs and complete operator helper closure.
The planner independently checks normal CI, immutable complete non-shell Git
tree equality and the signed public catalog, rather than relying on classifier
or local build success labels. Report-origin authentication remains false.

The maintained stager and publisher perform fresh full namespace/Node/PV/backing/
owner guards, isolated new storage allocation, server admission checks,
same-image read-only Nginx/static/catalog qualification, exact writer/qualifier
retirement and host mount release, single-use intents and owning-runtime/normal-TLS
acceptance. The snapshot uses bounded gzip transport with CRC/trailer, complete
file hashes and tar end-block validation; truncated streams refuse even when
the command exits zero. Follow [PUBLIC-SHELL-PROMOTION.md](PUBLIC-SHELL-PROMOTION.md)
for the reviewed execution inputs and phases. Browser and presentation checks
remain separate. Run the production `check-target.py` immediately before each
production mutation; an offline patch template does not replace that preflight.
