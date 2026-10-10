# Update a public frontend without rebuilding its image

A compatible web change can reuse the accepted public Nginx image, signed
catalogue, tools, fonts, models and configuration. Build and qualify the frontend,
then run one command with a reviewed instance profile. The command captures the
current resources, stages a new frontend claim, verifies its full contents and
catalogue, retires the stagers, publishes the claim and checks normal HTTPS.

This is the five-path public overlay lane: `_app`, `index.html`, `precache.json`,
`sw.js` and `portable/player.js`. It retains old lazy assets for already-open
browsers. Backend, engine/core/schema, dependency, profile, tool or brand changes
need the broader release path. This command performs no image build, dependency
installation, Helm upgrade, database migration, DNS change or provisioning.

## Prepare a qualified web revision

Use a clean immutable main revision with complete normal CI and the explicit web
release gate. Follow the public producer and preparer interfaces in
[PUBLIC-SHELL-UPDATES.md](PUBLIC-SHELL-UPDATES.md). Their protected output is
`cohort.prepared.json`, with status
`PUBLIC_SHELL_OVERLAY_PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED`.

Preparation binds the previous genuine runtime acceptance, source compatibility,
unchanged public settings and P-256 pin, complete manifests and original compiler
and gate reports. The facade independently recomputes that contract. A local
build or handwritten success record cannot replace provider CI or runtime proof.
No private catalogue, tool pack, signing secret or private receipt enters this
lane. Only the accepted `lolly-start` profile and settings are supported.

Keep the preparer, profile and facade in one immutable reviewed helper checkout.
Preparation includes absolute helper paths and hashes; copying a historical
record into another checkout can fail its exact custody comparison. Review a
helper upgrade and generate new preparation against the current accepted
baseline. Preserve historical originals. A live instance never follows a moving
main branch or developer directory.

## Review the instance profile once

Store the profile outside the repository, with private permissions. Version 1
uses `REVIEWED_PUBLIC_SHELL_UPDATE_PROFILE` and the exact `PROFILE_KEYS` in
[scripts/update-public-shell.py](../../scripts/update-public-shell.py).

| Profile field | Purpose |
| --- | --- |
| `name` | Instance label |
| `target`, `previous`, `publicKey` | Absolute file references and reviewed SHA-256 digests for the explicit target, genuine accepted public baseline and existing public JWK |
| `preflight`, `hostProbe` | Reviewed guard-program file references; the maintained operators use their exact existing interfaces |
| `sourceFiles` | Complete reviewed executable dependency closure, including every facade/stager/publisher imported helper and site guard dependency |
| `selection` | Accepted `container` and `shellVolume`; the new claim comes exclusively from preparation |
| `stageNamePrefix` | Prefix, at most 32 characters; writer, qualifier and deny-policy names derive from the prepared digest |
| `storage` | Existing `storageClassName` and new claim `bytes` |
| `minimumFreeBytes`, `maximumWriteBytes` | Remote free-space floor of at least 8 GiB and explicit write budget at most 1 GiB |
| `probePolicy` | Sorted unique `paths`, including index and both catalogue files; `lazyChunks` from 1 to 20; `allOrigins: true` |

The facade derives image, catalogue, settings, full expected Deployment, previous
owner and manifests from accepted custody. They are not profile overrides.
Select a new unused shell claim in the preparer's input. The facade does not
rewrite it. Keep target authority and the full helper closure reviewed; supplying
hashes establishes byte custody, not authorization or authenticated origin.

The probe policy applies to every HTTPS origin in the target public component's
`healthURLs`. It prioritizes changed `_app/*.js` files, then retained chunks, and
adds one retained control when available. Every request binds prepared size and
SHA-256; credentials, redirects, queries, fragments, foreign origins, unverified
TLS and model paths refuse. Full owning-Pod static and signed-catalogue checks
remain mandatory regardless of this bounded HTTP sample.

## Publish one update

Python 3.10 or newer, Node 24, and existing reviewed kubectl/SSH access are needed.
The command installs nothing. Use a new protected output directory for each
attempt and review the exact profile, preparation and facade source digests:

```sh
pnpm update:public-shell run \
  --profile /protected/public-instance-profile.json \
  --profile-sha256 REVIEWED_PROFILE_SHA256 \
  --prepared /protected/new-public-cohort/cohort.prepared.json \
  --prepared-sha256 REVIEWED_PREPARED_SHA256 \
  --operator-sha256 REVIEWED_FACADE_SOURCE_SHA256 \
  --node /absolute/path/to/node \
  --out /protected/public-update-NEW_MAIN_COMMIT
```

The command captures original Namespace and Deployment collections for every
protected namespace, the cluster namespace and Ready node, **global** PVC/PV
inventories, public Pods and accepted ReplicaSet, storage class, Nginx data and
binary data, and complete public network-policy and Service collections. Missing,
paginated, duplicate, changed, deleting or wrong-scope resources refuse. It
checks all nine applications are ready and preserves their full specifications.

The maintained stager streams a read-only snapshot through its existing owning
Pod into a **new** claim, applies the frontend delta and verifies every byte. It
never mounts an active model or shell PVC in a staging Pod. Writer and qualifier
retirement require exact UID/resource-version guards, actual API absence and
observed mount release. Storage aliases and local-path root metadata are checked;
there is no SELinux, mode, ownership or active-storage repair in the facade.

After a fresh capture, the maintained publisher runs server admission, atomic
full-spec patching and read-only observation once. Existing target preflight is
last before every mutation. The Deployment's existing strategy determines its
reconnect window. Normal HTTPS and full actual image/owner/storage/configuration
checks must pass before `run.actual.json` and `instance-profile.next.json` appear.
Use that proposed next profile only after reviewing actual acceptance. Its
`accepted.previous.json` must pass the unchanged baseline parser, enabling the
next release without hand-written rollout scripts.

## Inspect inputs without contacting the target

`check` needs a local hash-bound complete capture matching `CAPTURE_KEYS` in the
facade. `plan` additionally needs that original check, a genuinely qualified and
retired stage, and a fresh local capture. The retained capture format uses
unmodified Kubernetes originals; it never invents an aggregate list resource
version.

```sh
pnpm update:public-shell check \
  --profile /protected/public-instance-profile.json \
  --profile-sha256 REVIEWED_PROFILE_SHA256 \
  --prepared /protected/new-public-cohort/cohort.prepared.json \
  --prepared-sha256 REVIEWED_PREPARED_SHA256 \
  --operator-sha256 REVIEWED_FACADE_SOURCE_SHA256 \
  --node /absolute/path/to/node \
  --capture /protected/capture/capture.original.json \
  --capture-sha256 REVIEWED_CAPTURE_SHA256 \
  --out /protected/public-check-NEW_MAIN_COMMIT
```

For `plan`, use the same reviewed arguments, replace `check` with `plan`, supply
`--check`/`--check-sha256` for `check.actual.json`, `--stage`/`--stage-sha256` for
the original `stage.accepted-and-retired.actual.json`, and a new `--out` directory.
Its `publication.input.json` is reviewable without contacting the cluster.
Offline fixture tests exercise the genuine Git, cryptography, constructors and
CLI contracts; they do not qualify Nginx, browser reconnection or a deployment.

## Stop on uncertain outcomes

Every phase and read-only capture retains its original command bytes and outcome.
A refusal stops the command. Existing output directories and started attempts
cannot be reused. There is no automatic retry, cleanup, rollback or replay of an
ambiguous patch. Preserve `run.uncertain.json`, phase receipts and raw originals;
review current state and use a separately attributed reconciliation or cleanup.
Physical presentation/native qualifications and browser/export/document-agent
canaries remain separate acceptance work.

For **lolly.ing** or **lolly.tools**, first read the authoritative
`lolly-private/production/README.md` and coordinate production resource ownership.
Both domains use UpCloud K3s; historical names containing `candidate` identify
production. The site preflight must run immediately before each mutation. Old
Compose, Vercel and Neon migration commands are not these domains' release path.
Other instances retain their generic supported deployment choices.
