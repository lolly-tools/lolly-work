# Update the web frontend without rebuilding its image

For a compatible web TypeScript, CSS or layout change, build the new frontend
and publish a new shell claim. Keep the accepted application image, engine,
catalogue, database and infrastructure. A single-owner `Recreate` instance has
a brief reconnect window when its new owner starts.

Use this path for web application code. Backend TypeScript, the baked Work admin
console, dependencies, engine/core/schema, tools, brand or build-policy changes
need their broader release path. The
[release classifier](application-release-classification.md) checks the exact
committed changes; an allowed filename alone does not establish compatibility.

## Before the first update

An IT operator sets up the reusable inputs and records the initial accepted
baseline, then keeps the protected files available to the release operator.
The private lane requires an existing dedicated shell PVC. The public lane
requires an accepted Nginx image; its first update adds five read-only serving
mounts and a read-only whole-volume anchor. The current public
producer uses the reviewed `lolly.tools` policy. Another public instance needs
its own reviewed policy contract.

| Reusable instance inputs | What the operator reviews |
| --- | --- |
| Target and guard programs | Cluster/host identity, all protected components, mandatory preflight and actual host mount checks |
| Accepted image and runtime inputs | Engine, pack/pin or public Nginx configuration and separate model storage |
| Public verification key | Existing public-only P-256 key; no signing secret is needed for unchanged signed content |
| Helper source closure | Exact maintained scripts, imports and probe hashes; review again when helpers change |
| Private instance profile | Storage bounds, stage-name policy, runtime probes and optional approved authenticated catalogue caller |

| Fresh release inputs | Where they come from |
| --- | --- |
| Exact main commit and successful normal CI | Original source/run/job records for that immutable commit; a moving `main` name or local success label is insufficient |
| Current accepted baseline | Genuine `accepted.previous.json`, complete accepted snapshot and manifest; advance only after acceptance |
| New build custody and evidence | Accepted settings and compatibility inputs, original producer/web-gate reports and complete manifests |
| New shell claim and attempt directories | Explicit reviewed selection and unused names; outputs are exclusive |

Use Node 24+, Python 3.10+ and already installed locked dependencies in clean
isolated checkouts. The producer installs nothing. Reuse exact accepted ignored
ORT/ORT-HF cache bytes where Vite requires them. IT supplies the reviewed custody
and evidence files; these commands do not generate provider-origin proof from
handwritten JSON. Keep protected instance inputs outside the source repository.

## Private Work instance: three commands

Run from the qualified Work helper checkout. Replace the uppercase placeholders
with reviewed full commits and SHA-256 values, and `/protected/` paths with your
existing protected directory. The accepted snapshot includes retained lazy
chunks needed by already-open tabs.

```sh
pnpm update:shell:build \
  --source /clean/lolly --base ACCEPTED_SHELL_COMMIT --candidate NEW_MAIN_COMMIT \
  --previous-shell /protected/accepted-shell --public-key /protected/public.jwk.json \
  --custody /protected/build-custody.json --custody-sha256 REVIEWED_CUSTODY_SHA256 \
  --out /protected/build-NEW_MAIN_COMMIT

pnpm update:shell:prepare \
  --evidence /protected/shell-evidence.json \
  --reviewed-evidence-sha256 REVIEWED_EVIDENCE_SHA256 \
  --existing-public-pin-sha256 REVIEWED_CANONICAL_PUBLIC_JWK_SHA256 \
  --node /path/to/node24 --out-dir /protected/prepared-NEW_MAIN_COMMIT

pnpm update:shell run \
  --profile /protected/instance-profile.json --profile-sha256 REVIEWED_PROFILE_SHA256 \
  --prepared /protected/prepared-NEW_MAIN_COMMIT/shell.prepared.json \
  --prepared-sha256 REVIEWED_PREPARED_SHA256 \
  --operator-sha256 REVIEWED_UPDATE_OPERATOR_SHA256 \
  --out /protected/update-NEW_MAIN_COMMIT
```

Build and preparation are local. Review their original reports and hashes before
`run`, which captures fresh resources, stages isolated content, plans, dry-runs,
applies once and observes the new owner. It streams snapshots through the current
owner into new claims; it never mounts an active claim into a staging Pod.

The successful `run.actual.json` has status
`PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED` and links `accepted.previous.json` and
`instance-profile.next.json`. Use that exact next profile for the next release,
keeping both profiles and their referenced snapshots/receipts. It advances the
baseline while preserving the reviewed image, pack, pin and caller policy.
Export, document-agent and signed-in reconnect checks remain separate.

See the [private quickstart](https://github.com/lolly-tools/lolly-work/blob/main/deploy/helm/PRIVATE-SHELL-QUICKSTART.md)
for offline `check`/`plan`, naming and next-profile details, the
[private input contract](https://github.com/lolly-tools/lolly-work/blob/main/deploy/helm/SHELL-UPDATES.md)
for custody/preparation, and the
[authenticated catalogue guide](https://github.com/lolly-tools/lolly-work/blob/main/deploy/helm/PRIVATE-SHELL-CATALOG-PROBES.md)
for the reusable caller policy. Input assembly remains an operator review step.

## Public Nginx instance: supervised phases

The public lane reuses its accepted image and signed neutral catalogue. Its
overlay contains only `_app`, `index.html`, `precache.json`, `sw.js` and
`portable/player.js`; models and the rest of the image remain unchanged. Keep
private artifacts out of this lane.

For the managed local-volume plugin, the claim source stays writable to the
kubelet while every application mount stays read-only. The first whole-volume
mount allows normal SELinux relabeling before the five serving subpaths. The
selected `OnRootMismatch` policy preserves file modes when the backing root
already has GID 101, owner/group `rwx` and setgid. The operator verifies that root
before each handoff and the separate model root before publication; a mismatch
stops the update without changing permissions. These checks currently support
the pinned `local` plugin with `rancher.io/local-path`, rather than CSI or
`hostPath` volumes.

```sh
pnpm update:public-shell:build \
  --source /clean/lolly --base ACCEPTED_SHELL_COMMIT --candidate NEW_MAIN_COMMIT \
  --previous-shell /protected/accepted-public-static --public-key /protected/public.jwk.json \
  --custody /protected/public-custody.json --custody-sha256 REVIEWED_CUSTODY_SHA256 \
  --out /protected/public-build-NEW_MAIN_COMMIT

pnpm update:public-shell:prepare \
  --evidence /protected/public-evidence.json \
  --reviewed-evidence-sha256 REVIEWED_EVIDENCE_SHA256 \
  --node /path/to/node24 --out-dir /protected/public-prepared-NEW_MAIN_COMMIT

python3 -B scripts/stage-public-shell.py check \
  --inputs /protected/public-stage.json --sha256 REVIEWED_STAGE_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256
python3 -B scripts/stage-public-shell.py run \
  --inputs /protected/public-stage.json --sha256 REVIEWED_STAGE_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256
```

IT assembles the stage input from the original preparation and fresh complete
captures. After successful isolated qualification and exact writer/qualifier
retirement, assemble and review the publication input from those actual receipts.
Run each command separately, inspecting the previous result before proceeding:

```sh
python3 -B scripts/publish-public-shell.py check \
  --inputs /protected/publication.json --sha256 REVIEWED_PUBLICATION_INPUT_SHA256 \
  --operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256
python3 -B scripts/publish-public-shell.py dryrun \
  --inputs /protected/publication.json --sha256 REVIEWED_PUBLICATION_INPUT_SHA256 \
  --operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256
python3 -B scripts/publish-public-shell.py apply \
  --inputs /protected/publication.json --sha256 REVIEWED_PUBLICATION_INPUT_SHA256 \
  --operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256
python3 -B scripts/publish-public-shell.py observe \
  --inputs /protected/publication.json --sha256 REVIEWED_PUBLICATION_INPUT_SHA256 \
  --operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256
```

There is no public one-command facade. `observe` emits
`observe.acceptance.original.json` with `PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED`
and a genuine `accepted.previous.json` for the next preparation. Keep the original
image expectation, new effective-static/overlay manifests and original receipts.
Browser, presentation and native checks retain their separate scope.

The [public preparation guide](https://github.com/lolly-tools/lolly-work/blob/main/deploy/helm/PUBLIC-SHELL-UPDATES.md)
defines custody and baseline fields; the
[public promotion guide](https://github.com/lolly-tools/lolly-work/blob/main/deploy/helm/PUBLIC-SHELL-PROMOTION.md)
defines stage/publication inputs, exact guards and phases.

## Results, timing and refusals

Full file hashes, sizes, modes, signed catalogue and storage/owner identity remain
mandatory. Public snapshots are single-member gzip tar streams: CRC, trailer,
complete file inventory and tar end blocks must pass before extraction. A command
exit code of zero alone does not establish complete transport.

Read measured phase receipts rather than treating Vite time as deployment time.
The private facade records `elapsedSecondsByPhase`; neither lane promises a fixed
end-to-end duration or enables unattended following of main. A local build,
offline plan or synthetic fixture is not live acceptance. Normal CI and the
explicit web release gate remain required; native/device holds remain separate.

Serialize updates sharing a target. Every mutation needs its mandatory site
preflight last, plus fresh exact resource guards. If a phase refuses, preserve
the exclusive attempt directory and `*.uncertain.json` with its original
responses. Inspect the current state read-only; do not repeat apply, replay an
intent or relabel a failure as success. A forward fix or rollback needs a new
reviewed intent against the current state. Retain old qualified claims until
acceptance, and preserve current user data.

For `lolly.ing` and `lolly.tools`, use the production handoff in
`lolly-private/production/README.md` and its `check-target.py`. Historical
`candidate` names identify the current UpCloud K3s production host.
