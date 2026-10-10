# Update a private frontend without rebuilding its image

For a normal Lolly web UI change, build and qualify the frontend, then run one
command with your protected instance profile. The helper captures the current
resources, assembles the isolated stage and publication inputs, qualifies the new
shell, performs the guarded publication, and reads back its contents over normal
HTTPS. It keeps the accepted Work image, engine, tool pack and immutable pin.

This requires the dedicated shell PVC layout described in [SHELL-UPDATES.md](SHELL-UPDATES.md).
Backend code, dependencies, engine/core/schema changes, and infrastructure changes
continue to use their appropriate release paths. A running instance follows a
qualified immutable commit; it does not serve files from a developer's working
directory.

## Developer: build the web change

Use a clean checkout of the main commit and the accepted build settings. The
`update:shell:build` producer compiles the frontend without installing dependencies
or rebuilding the container. The local `update:shell:prepare` command binds the
complete manifests, current normal CI and web release gate, previous genuine
runtime acceptance, and unchanged backend and engine custody.

Follow the build and preparation commands in [SHELL-UPDATES.md](SHELL-UPDATES.md).
Their result is a protected `shell.prepared.json` whose status explicitly says it
has not been runtime qualified or applied. Neither a local build nor a handwritten
success record replaces those original qualification inputs.

## IT operator: publish with the instance profile

An instance profile is a protected JSON file with references and SHA-256 digests
for the target, previous accepted release, complete accepted shell snapshot,
public key, accepted image source map, maintained helper sources and site guard
programs. It also selects new stage resource names, the storage class and bounded
capacity. It contains no infrastructure provisioning request or private signing
key.

Review the profile and prepared artifact hashes, serialize updates to this
instance, and select a new private output directory:

```sh
python3 -B scripts/update-private-shell.py run \
  --profile /protected/instance-profile.json \
  --profile-sha256 REVIEWED_PROFILE_SHA256 \
  --prepared /protected/new-shell-cohort/shell.prepared.json \
  --prepared-sha256 REVIEWED_PREPARED_SHA256 \
  --operator-sha256 REVIEWED_UPDATE_OPERATOR_SHA256 \
  --out /protected/frontend-update-NEW_MAIN_COMMIT
```

`run` is the explicit target execution command. It does not accept a previously
captured resource envelope or an existing output directory. It preserves the
original command bytes and calls the maintained staging and publication phases
once each. The site preflight remains mandatory immediately before every
production mutation; the facade also retains the operators' fresh UID,
resourceVersion, full-spec, source, storage and ownership checks.

The helper never mounts the active production asset claims in a staging Pod. It
streams read-only snapshots through their owner into two new claims, retires the
writer and qualifier with exact mount-release proof, and changes only the shell
claim and existing shell provenance annotations. The copied staging pack remains
outside the live Deployment. Full global PV captures are retained and guarded,
including backing isolation from volumes belonging to another namespace.

The successful receipt is `run.actual.json` with status
`PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED`. It links the genuine new
`accepted.previous.json` for the next update. Export, invited-agent, reconnect and
visual canaries remain separate acceptance steps. A single-owner `Recreate`
workspace has a brief reconnect window while its new owner starts.

On a refusal, keep the output directory and inspect `run.uncertain.json` together
with the underlying operator's original receipts. The facade performs no retry or
rollback. An uncertain committed request requires an attributed read-only
reconciliation before a new release attempt.

## Inspect the resources before execution

`check` and `plan` are offline commands. They consume protected original resource
captures rather than making target calls. This is useful for reviewing a proposed
stage or an already retired stage before a separately authorized publication:

```sh
python3 -B scripts/update-private-shell.py check \
  --profile /protected/instance-profile.json \
  --profile-sha256 REVIEWED_PROFILE_SHA256 \
  --prepared /protected/new-shell-cohort/shell.prepared.json \
  --prepared-sha256 REVIEWED_PREPARED_SHA256 \
  --operator-sha256 REVIEWED_UPDATE_OPERATOR_SHA256 \
  --capture /protected/capture.original.json \
  --capture-sha256 REVIEWED_CAPTURE_SHA256 \
  --out /protected/new-offline-stage-check
```

For `plan`, provide a fresh original capture, the original `check.actual.json` and
actual `stage.accepted-and-retired.actual.json` through their `--check`,
`--check-sha256`, `--stage` and `--stage-sha256` arguments. It writes the complete
captured plan and publication envelope; its status explicitly says no change has
been applied. The [facade tests](../../tests/test_update_private_shell.py) contain
an executable synthetic example of the entire CLI handoff, with no target calls.

## Maintain one small protected profile

The exact version 1 schema is `PROFILE_KEYS` in
[update-private-shell.py](../../scripts/update-private-shell.py). The reviewed
helper closure includes the facade, stager, preparer, planner, publisher and their
imported dependencies, plus every guard and probe program. Source drift refuses
before execution. References emitted by the facade are canonical absolute paths,
so the next release can retain its original receipts from another directory.

The `retiredMountProbe` argument list can contain the whole literal values
`${stagePodUID}`, `${writerPodUID}`, `${nodeUID}` and `${targetPath}`, each at most
once. The facade substitutes only the hash-held actual retired Pod identities and
reviewed target/node bindings into the publication command. Partial, unknown or
duplicate placeholders refuse; other argument values remain literal. No shell
expansion takes place. The same reviewed mount-probe source can therefore verify
the newly allocated Pod identities on successive releases.

After acceptance, refresh the profile's `previous` and `previousShell` references
to that release and choose unused stage names for the next prepared shell claim.
Review and hash this small profile again. The helper assembles the resource and
phase envelopes; operators do not need to manually compose each intermediate
receipt. Retain the protected input files, accepted snapshot and receipts until
their release custody is no longer needed.

For a sign-in-gated private catalogue, add the optional reviewed
`authenticatedStaticProbe`. See
[PRIVATE-SHELL-CATALOG-PROBES.md](PRIVATE-SHELL-CATALOG-PROBES.md) for the exact
normal-TLS, per-caller index and pinned-P256 report contract. The owning Pod's
prepared files remain independently byte-exact; a freshly generated authenticated
envelope is verified using its own explicit profile.

For `lolly.ing` and `lolly.tools`, the authoritative production target and
preflight remain in `lolly-private/production/README.md` and `check-target.py`.
Historical host names containing `candidate` refer to the current UpCloud K3s
production host, not to a disposable staging target.
