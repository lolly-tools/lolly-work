# Preview deploy command (lolly.tools, Phase 1)

`preview-deploy` ships one exact `main` commit of Lolly to the lolly.tools preview. It asks CI to build and sign the
web image, puts that image on the K3s node by digest, switches the Deployment with Work's own guarded patch
(`scripts/app-update.py`), runs a smoke check, watches for a few minutes and rolls back by itself if anything fails.

It replaces the per-release runbook for this preview. It is not a platform release tool, and the platform release
workflows do not use it. lolly.ing is Phase 2 and the command refuses it today.

Python 3.9 or newer, standard library only, on both the operator's Mac and the node. No `pnpm install`, no worktree.

## Contents

- `preview-deploy.py`: the operator entry point.
- `lib/`: the code. `preview_anchors.py` holds every trust anchor.
- `node/lolly-preview-deploy.service`: the systemd unit for one run on the node. It is the node lock.
- `node/node_runner.py`: the unit's `ExecStart` and `ExecStopPost`.
- `node/bootstrap.py`: the small program sent over SSH that installs and starts a run, or answers a read.
- Tests: `tests/test_preview_deploy.py` with fakes in `tests/preview_deploy_fakes.py`, run by Work CI through
  `tests/preview-deploy.test.ts`.
- `restore-rehearsal.py`, `lib/preview_rehearsal.py` and the in-Pod programs in `rehearsal/`: the restore rehearsal
  operator for lolly.ing's migrations (Phase 2). See [`REHEARSAL.md`](REHEARSAL.md). Tests:
  `tests/test_restore_rehearsal.py` with a fake kubectl in `tests/restore_rehearsal_fakes.py`, run through
  `tests/restore-rehearsal.test.ts`.

This directory sits outside `scripts/` on purpose: `deploy/compose/Dockerfile` copies `scripts/` into every Work image,
and preview host tooling must not ship to private deployers.


## How it is trusted

- **The tool is pinned.** Run it only through the private launcher `lolly-private/production/preview/launch.py`.
  - The launcher checks exactly the files `tool.lock.json` lists: `deploy/preview/` plus `scripts/app-update.py`, taken
    from `git ls-tree` of a merged main commit.
  - It refuses any difference, copies those bytes into a private snapshot and runs that copy, so untracked files beside
    the tool are never executed.
  - Caller arguments are limited to a site, a subcommand, a commit and the subcommand flags. The launcher's own options
    cannot be repeated, moved after the site, abbreviated or overridden.
- **The tool checks itself too.** Running `preview-deploy.py` directly does not skip the lock.
  - The command reads `tool.lock.json` from the state directory and requires its own tree hash to equal it.
  - The state directory must be exactly `~/Build/lolly-private/production/preview`. A copy elsewhere is refused even
    when its path ends the same way. `lolly-private/production` must be a `0700` directory owned by the operator, and
    `--check-target` must be the `check-target.py` beside the state directory.
  - check-target is hashed when its identities are read and again just before it runs (`CHECK_TARGET_CHANGED`).
  - It refuses a checkout commit that is not on lolly-work `main`. That commit is resolved to a SHA first; the bare
    name `main` is never compared.
  - It refuses locked files whose bytes differ from the lock or from the files committed at `HEAD`. This does not rely
    on `git status`, which `assume-unchanged` and clean filters can mislead.
- **Trust anchors are code.** These live in `lib/preview_anchors.py`:
  - the repositories and workflow paths;
  - the receipt artifact name and the image package;
  - the signing pin;
  - the origins, resource names and required labels.
- **Identities come from check-target.py.** These are read from the patched `check-target.py` (its `--site` change):
  - the SSH route and known-hosts file;
  - the k3s path, kubeconfig and context;
  - the node, cluster, namespace and Deployment UIDs;
  - the edge address.

  The private profile holds only the page list, thresholds and the models release, plus the claim allowlist for `gc`
  reports. A profile with any other field is refused.
- **Changing the tool is a reviewed lolly-work PR, then a new lock.** After the PR merges, regenerate the lock with
  `make-tool-lock.py`, which refuses a commit that is not on `main`, and add a production README entry for the tool
  change.

## Subcommands

All of them take a site and, where needed, one full commit SHA. The launcher adds `--state-dir`, `--tool-sha256`,
`--checkout` and `--check-target`.

```text
launch.py lolly.tools ship <sha>             build main's head (or reuse a bound build of it), deploy
launch.py lolly.tools deploy <sha>           deploy an already built and bound commit on main
launch.py lolly.tools rollback               go back to the recorded previous build (manual)
launch.py lolly.tools status                 live phase, image, source, Pod, unit state, last result (read-only)
launch.py lolly.tools status --follow ID     follow one run to its end and record its result in deploys.jsonl
launch.py lolly.tools gc [--execute]         image retention report; --execute (after a report) removes images only
launch.py lolly.tools selftest               read-only checks inside the real unit sandbox (check-target first)
launch.py lolly.tools adopt <sha>            re-seed the records for the live image from a bound build of <sha>
launch.py lolly.tools plan <sha>             one-time 3.6 conversion plan (read-only)
launch.py lolly.tools plan <sha> --apply PLAN --reviewed-plan-sha256 HASH
```

Flags:
- `--drill-fail-smoke` (ship, deploy, plan --apply) forces a smoke failure after the real smoke, to drill the
  automatic rollback. It changes nothing else.
- `--clear-hold` proceeds although the live phase says a human must look. It also accepts a live build that fails its
  own smoke.

## What `ship` does

1. Refuses unless the commit is `main`'s head, read as a SHA from `refs/heads/main`. Phase 1 uses the existing
   candidate build, which itself refuses any commit that is not `main`'s head at dispatch time.
2. Reads the live state:
   - It refuses while a run is active on the node, and before anything else when the live phase needs a human.
   - If this commit is live, accepted, and its records name the live image, it reports `ALREADY_LIVE` and stops.
3. Reuses a build of this commit that still binds. Otherwise it:
   - requires a successful normal CI push run on `main` for the commit;
   - requires no other active candidate run (it never changes the candidate workflow's concurrency);
   - dispatches `deployment-suse.yml` on `refs/heads/main` with the same request the retired bot sent: `build_images`,
     `release_scope=web`, `expected_source`, `ci_run` and the existing public pin.
4. Waits for the run, tolerating brief GitHub errors. Andy approves the two signing gates in GitHub. **Agents never
   approve an environment gate.**
5. Binds the finished run:
   - workflow path, event `workflow_dispatch`, same repository for run and head, branch `main`, head SHA and success;
   - the `public-candidate-web-receipts-attempt-N` artifact, with every receipt field checked by exact pattern;
   - the image must be `ghcr.io/lolly-tools/lolly-web@sha256:...`.
6. Requires the live records to describe the live image: same image, phase `accepted`, `rolled-back` or `aborted`.
   Otherwise `RECORDS_STALE`.
7. Builds the smoke expectations from the commit's own files:
   - the CSP from the `$lolly_csp` map in `deploy/docker/nginx.conf`, with the build's connector origins;
   - the other headers in `deploy/docker/security-headers.conf`;
   - the models manifest;
   - the shell's stored-format versions.
8. Checks the connector origins:
   - They are `vars.VITE_CONNECTOR_ORIGINS`, from the repository or else the organisation.
   - The run is refused if the variable changed after the build started.
   - If the variable has not changed since the live build, it must still reproduce the CSP recorded for the live build.
     Otherwise `CONNECTOR_ORIGINS_UNPROVEN`, for example when an organisation or environment variable masks it.
   - Lolly's signed receipt does not record the origins yet. Recording them there is a lolly-side follow-up that
     would make this check exact.
9. Refuses if the models manifest differs from the mounted models release (use the models procedure), or if an older
   build would lower a stored format.
10. Checks the backup window (01:30 to 02:30 UTC) against the run's worst-case end, not only its start. This check
    also runs before a build is reused or dispatched. A deploy can last about 55 minutes with the default profile, so
    one started at 00:40 is refused. The node checks the window again before each forward change, but never before a
    rollback.
    Then it runs `check-target.py --site lolly.tools` once, immediately before the run starts. That check also covers
    the run's own automatic rollback.
11. Starts the node unit and follows its progress:
    - A dropped SSH or Wi-Fi link only pauses the follow; the unit keeps going.
    - A start whose reply is lost is uncertain, not failed. The command looks for the run by its id.
    - `status --follow ID` reattaches and records the result.

`deploy <sha>` is steps 2 and 5 to 11 for the newest binding candidate run of an earlier commit.

## On the node

The run is the unit `lolly-preview-deploy.service`, installed from the pinned bundle into `/run/systemd/system` (gone
after a reboot) and started detached.
- The command refuses to start another run while the unit is active or queued, and waits until the unit has left
  `inactive` before it reports `STARTED`.
- The runner holds `/run/lolly-preview/deploy.lock` for its whole life. That directory is root-owned and `0700`, and
  the lock files are opened without following links.
- One run at a time, for both sites. A previous run's request is kept beside its result, never deleted.

**Manual changes to a preview take the same lock:**

```text
sudo flock -n /run/lolly-preview/deploy.lock <your command>
```

The SSH command is `sudo -n python3 -I -`, so the SSH user's working directory is never on Python's path.

A deploy run:

1. Checks the cluster, node, namespace and Deployment identity, readiness, the image layout (the conversion is
   done), the models release, and that the live release is the one the operator read. Its records must describe the
   live image.
2. Checks DNS and runs a light smoke of the **live** build: its signed receipt, `/`, its CSP and `/healthz`. It also
   records the edge-owned headers the edge serves now. A live build that fails is refused (`LIVE_SMOKE_FAILED`),
   because its rollback would not be safe.
3. Before every pull (the new image, the rollback image, the conversion image), it checks capacity. The free bytes on
   the image filesystem above the image-GC reserve (`total // 4 + 512 MiB`) must cover the larger of two numbers:
   - the profile minimum;
   - three times the compressed image plus 1 GiB.
4. Pulls by digest and labels the image `lolly.tools/preview-pulled=true`.
   - It pins an image only if nobody has pinned it yet, labelling that pin `lolly.tools/preview-pin=true`. A pin made
     by another procedure stays as it is.
   - Pins are read back. The live image stays pinned as the rollback target.
5. Writes the phase annotation `switching`, with the previous build's record.
6. Switches the image with `app-update.py`: plan, server dry run, then a guarded patch that tests UID, resource version,
   container name and current image, then the rollout.
   - A status update between plan and patch moves the resource version and app-update refuses. The run then re-reads
     and re-plans, up to five times, while nothing has been applied.
   - If the image never changed, the run ends `ABORTED`, with the earlier records put back. There was nothing to roll
     back.
7. Writes `switched-unverified` and the new build's records.
8. Smoke (below), then a watch (default 5 minutes, a probe every 15 seconds, at most 15 minutes).
9. Writes `accepted`, applies image retention and records the result.

### Smoke

Against the real edge with normal TLS verification, no redirects, no credentials. Every transport error (a reset
connection, a truncated body, a bad status line) becomes a refused check, never a crash, so a single dropped probe is
counted like any other failure.

- `/release-frontend.sig.json` verifies against the pinned key, for this commit and profile `lolly-demo`.
- `/` answers 200 and its body hash equals the signed `index.html`. Its ETag must be one of the delivery map's values
  for `/` (identity, gzip or br hash from the signed receipt). The ETag is never compared with the body hash.
- `csp`: the CSP is served exactly once, exactly as the source declares it.
- `edge headers`: Caddy owns `Referrer-Policy`, `X-Content-Type-Options`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Embedder-Policy` and `Permissions-Policy`, and today sends the image's values. They must equal what
  the edge served just before the switch, not the image's config. Each differing header is reported on its own line.
  - This relaxes the earlier rule, which compared every header with the source exactly. Only the CSP is still
    compared with the source.
  - A header the edge did not send before the switch is skipped.
- Catalog index, signature and asset index match the receipt; no tool or asset id starts with `suse`.
- `https://www.lolly.tools/` answers 308 to the apex; `/healthz` answers 200.
- The profile's pages, plus up to three `/info` pages this build added, answer 200 with the signed hash.
- One model file: HEAD 200 with the right length, and `Range: bytes=0-0` 206. This proves the models claim is mounted.
- `pod`: exactly one Running or Pending Pod of the current ReplicaSet. An evicted Pod of an older ReplicaSet does not
  count. The Pod must be Ready with 0 restarts, and its working set must be under 80% of the memory limit.
  - The working set is containerd's `workingSetBytes`: usage minus `inactive_file`, as the kubelet counts it.
    Inactive page cache does not count. Active page cache does, for example model files read moments ago, so the 80%
    threshold leaves room for it.

### Automatic rollback

Triggers: a failed rollout, any smoke failure, any refusal after the switch, 3 consecutive failed watch probes, or the
unit stopping after the switch.

The last one is handled by `ExecStopPost`, which decides from the live phase annotation, never from whether a result
was written.
- When the phase is still `switching`, `switched-unverified` or `rolling-back` for this run's deploy id, it rolls back,
  or marks `aborted` when the image never changed.
- This covers a crash, `RuntimeMaxSec` and `systemctl stop`.
- It never makes a second attempt after the run made one.

The rollback is one attempt:
1. An `app-update.py` plan back to the recorded previous image, re-planned under resource-version churn like the
   switch. The image is checked to be the anchored package by digest, and it is pulled after a capacity check if it
   is missing.
2. The smoke with the previous build's recorded expectations, and the edge headers from before the switch.
3. If that fails too, the phase becomes `rollback-unhealthy` and the result is `ROLLBACK_UNHEALTHY`. Every later run
   refuses until a human looks. The records then describe the failed new build while the old image is live, so
   `--clear-hold` alone is not enough: `ship` and `deploy` refuse `RECORDS_STALE` before any build is reused or
   dispatched. The way forward is `adopt` (below).

### Adopt

`adopt <sha>` re-seeds the records for the image that is live. It never dispatches a build.
1. It binds the candidate run of `<sha>` that built exactly the live image.
2. It runs check-target, then a full smoke of the live image against that build's expectations, inside the unit.
3. If the smoke passes, it writes the records with phase `accepted` (`ADOPTED`). It changes only annotations.
4. If the smoke fails, it refuses (`ADOPT_SMOKE_FAILED`) and changes nothing.
   - `adopt <sha> --clear-hold` writes the records anyway, with phase `adopted-unhealthy` (`ADOPTED_UNHEALTHY`).
   - That phase still holds every later run. `deploy <fix> --clear-hold` then ships a fix over the broken build, which
     becomes its rollback target.

The automatic rollback inside the watch runs even when the new build raised a stored format, because a broken site
is worse. A user who loaded the new shell in those minutes finds local storage locked (never deleted) until the next
roll forward.

### Manual rollback

`rollback` goes back to the recorded previous build.
- It runs `check-target.py` first.
- It refuses when the previous build would lower a stored format (`indexedDb`, `revisionArchive`, `channelMessage`,
  `session`): roll forward instead.
- It refuses before anything is marked when the previous image is not the anchored package, or cannot be pulled for
  lack of capacity.
- A rollback clears the previous record, so a second `rollback` refuses. To go further back, `deploy` an older
  commit; the same stored-format rule applies.

### Time limits

`RuntimeMaxSec=5130` covers two pulls (600 s each), two rollouts (600 s each), the longest allowed watch (15 minutes),
three smokes and the image retention after an accepted deploy (330 s), with margin. `TimeoutStopSec=1800` is the
separate budget for one `ExecStopPost` rollback: a pull, a rollout and a smoke. The request validator refuses a longer
watch or rollout, and a test keeps the unit file equal to `preview_anchors.py`. The backup-window check counts the same
retention budget in a deploy's worst case.

### Selftest

`selftest` installs and starts the unit like a real run, so check-target runs first. Inside the same unit and sandbox it
runs read-only checks:
- the Python version, `NoNewPrivileges` and the SELinux context;
- that kubectl, `crictl` and `ctr` run under those restrictions;
- that pins can be read;
- capacity, DNS, and HTTPS with normal TLS verification.

It changes nothing. Run it before the first live run.

## One-time conversion (PROPOSAL 3.6)

lolly.tools still serves a claim-mounted root with an nginx ConfigMap over the image's own files. The command refuses
to deploy until that layout is converted, once, with the bytes that are live now.

1. `plan <live sha>` binds the candidate run that built exactly the live image, even when a newer rebuild of the
   commit exists, and skips runs whose receipt has expired. It prints the receipt's expiry: run 39658589581 for
   4d07e5fe expires at 2026-11-05T08:25:02Z. It then prints the following.
   - **The patch:** the exact guarded patch. It removes the `public-delivery` volume and its three mounts, removes the
     `nginx` ConfigMap volume and its four mounts, sets `revisionHistoryLimit: 5` and keeps the image.
   - **The revert:** the volumes, mounts and history limit a revert would restore.
   - **The nginx diff:** the image's nginx files against the ConfigMap.
   - **A read-only smoke of the live site**, with each header difference on its own line. The plan refuses unless the
     header checks are the only failing checks (`PRECONVERSION_SMOKE`).

   The plan is saved under `plans/` in the state directory with its SHA-256.
2. Andy reviews it. The named owner applies it once, with Andy present:
   `plan <sha> --apply PLAN --reviewed-plan-sha256 HASH`. The tool hash must equal the one that made the plan.
   - The node recomputes the plan from the live Deployment and requires it to equal the reviewed plan, except for the
     resource version, which status updates move (`PLAN_MISMATCH` otherwise).
   - It then applies the recomputed patch. That patch tests UID, resource version, image, and the exact volumes and
     mounts, and it seeds the preview records.
3. Smoke and watch follow.
   - The edge headers are compared with what the edge served just before the conversion.
   - On failure the run restores the exact claim layout, rebuilding the inverse patch after a failed test op. It smokes
     the claim layout without the exact header checks, because that layout serves the ConfigMap's headers.

After the conversion:
- **The R1/R2 rollback cards of the 4d07e5fe release are void.** They patch the claim-mounted layout, and the
  conversion's own revert replaces them.
- Keep the 4d07e5fe and 4ec claims until two image deploys have passed. `gc` then lists them for Andy.
- **`/models/` CORS does not change.** The image's own `deploy/docker/nginx.conf` still sends
  `Access-Control-Allow-Origin "*"` on `/models/` (about line 146), so the conversion keeps that header. Decision 15's
  statement that the conversion drops it is wrong. Behaviour is left unchanged; Andy decides separately.
- The conversion does drop the ConfigMap's wildcard OneDrive and SharePoint `connect-src` entries.

## What it may change, and what it never touches

May change:
- images it pulled, and pins it made itself;
- the `sovereign-web` image (through `app-update.py`);
- its metadata annotations;
- once, its layout (the plan above).

Never touches:
- Secrets, PVCs, Postgres, the edge, DNS, other Deployments or the Helm release;
- pins made by other procedures;
- any GitHub setting. It never approves an environment gate. The only GitHub write is the candidate workflow dispatch.

## Records

- Deployment annotations `lolly.tools/preview-*`: `phase`, `deploy-id`, `source`, `image`, `ci-run`, `tool`,
  `formats`, `expect`, `previous`, `reason`, `layout`, `deploys`, `updated`. They are metadata, so writing them never
  starts a rollout. `previous` is the build to roll back to. It keeps that build's own record of its predecessor one
  level deep, with no further nesting and no edge headers, so the annotations stay the same size however many deploys
  go by.
- One JSON line per mutating run, including refusals, in `deploys.jsonl` in the state directory. That includes
  `selftest`, `gc` reports and results recorded by `status --follow`.
- The node journal (`journalctl -u lolly-preview-deploy`) and a result file per run in `/var/lib/lolly-preview/results`,
  with the run's request beside it.
- A production README entry only for a rollback, a layout change or a tool change.

## Retention (`gc`)

Images follow a standing policy, decided by image ID.
- **What is kept:** the live image, the two newest previous images of this Deployment, and every image any Pod or
  other ReplicaSet uses.
- **What may be removed:** only images this command pulled itself (`lolly.tools/preview-pulled=true`), and only when
  no other name or foreign pin holds them. Removal uses the exact `repo@digest`.
  - An image pinned by another procedure is never unpinned or removed: the D048 R2 target, or the offline-imported
    f660df18.
  - Neither is an image with an extra tag. CRI removes every name of an image and ignores pins, so this is checked
    first.
- **First run:** `gc` with no flag is a report and is recorded. `gc --execute` refuses until a report exists. The first
  `gc --execute` also arms the post-deploy retention; until then, accepted deploys pin but remove nothing.
- **crictl deadlines:** crictl gives each call a client deadline of 2 s unless `--timeout` is set. Removing a large
  image takes longer, so crictl then fails with `DeadlineExceeded` while containerd finishes the removal anyway. Every
  crictl call the command makes sets `--timeout`: 120 s for `rmi` and `pull`, 30 s for reads. A pull has no CRI
  deadline, so there the option covers only the connection; the 600 s subprocess timeout bounds the pull.
- **Each removal is checked:** when `crictl rmi` fails, the command reads the node's images for up to 60 s and reports
  the image by ID as `removed-after-error`, `still-present` or `unverified`, with crictl's error. An image already gone
  before its turn is `already-gone`. A removal starts only while the run's budget still fits a whole one (270 s);
  otherwise the image is `deferred` to the next gc. `gc --execute` ends `GC_INCOMPLETE` while any image stays.
- **Images left by other procedures:** with about 32 GiB free and a 25 GiB reserve, the node has room for roughly one
  new build. So the report also lists every unused `lolly-web` image this command did not pull. Each entry gives its
  refs, size, pinned refs, who pinned it (`preview-deploy` or another procedure) and any old revision still naming it.
  Each entry comes with commands for Andy. The command never runs them:
  1. check-target;
  2. a fresh report;
  3. unpin each pinned ref, if the procedure that pinned it no longer needs it;
  4. `crictl --timeout 120s rmi <image id>`, which removes every name of that image.

  Steps 3 and 4 first run `crictl --timeout 30s inspecti <image id>` and skip the image when it is no longer listed.
  After a `DeadlineExceeded`, run the same line again: it removes the image or reports that it is gone.

Claims are never deleted by the command. `gc` lists only allowlisted claims: the profile's `gc.legacyClaims`, or claims
labelled `lolly.tools/managed-by=preview-deploy`. It blocks a claim that:
- a Pod mounts;
- a retained ReplicaSet or StatefulSet references (a rollback point);
- a StatefulSet owns, or a durable label names;
- has not yet seen two image deploys after the conversion.

For a candidate claim it prints three commands for Andy to run himself, with every word quoted:
1. `check-target.py --site lolly.tools`.
2. A fresh `gc` report, to see that the claim is still a candidate with no `referencedBy`.
3. A `kubectl delete --raw` whose body carries `preconditions.uid`, so the API refuses if the claim was recreated.

On local-path storage a deleted claim deletes its data.

## Exit codes and results

- `0`: LIVE, ALREADY_LIVE, CONVERTED, GC_DONE, SELFTEST_OK, ADOPTED.
- `1`: REFUSED (with a code), ABORTED, SELFTEST_FAILED, GC_INCOMPLETE, NOT_STARTED, DETACHED, or a stop without a
  result.
- `2`: ROLLED_BACK or CONVERSION_REVERTED.
- `3`: ROLLBACK_UNHEALTHY or ADOPTED_UNHEALTHY.

Common refusal codes:
- **Tool and inputs:** `BAD_ARGUMENTS`, `TOOL_NOT_LOCKED`, `TOOL_DIRTY`, `TOOL_NOT_MAIN`, `TOOL_HASH_MISMATCH`,
  `STATE_DIR_INVALID`, `CHECK_TARGET_PATH`, `CHECK_TARGET_IDENTITY`, `CHECK_TARGET_CHANGED`, `PROFILE_INVALID`,
  `SITE_PHASE_2`.
- **Source, build and run:** `NOT_MAIN_HEAD`, `NOT_ON_MAIN`, `CI_NOT_GREEN`, `CANDIDATE_ACTIVE`, `RUN_NOT_BOUND`,
  `RUN_FAILED`, `RECEIPT_INVALID`, `CONNECTOR_ORIGINS_CHANGED`, `CONNECTOR_ORIGINS_UNPROVEN`, `MODELS_CHANGED`,
  `FORMAT_LOWERING`.
- **Live state:** `RECORDS_STALE`, `LIVE_SMOKE_FAILED`, `BACKUP_WINDOW`, `CHECK_TARGET_FAILED`, `LOCK_HELD`,
  `HELD_FOR_HUMAN`, `NOT_CONVERTED`, `NOT_READY`, `STATE_CHANGED`, `LOW_CAPACITY`, `PIN_FAILED`, `BAD_IMAGE`,
  `NOT_STARTED`, `ADOPT_SMOKE_FAILED`.
- **Conversion and gc:** `PLAN_MISMATCH`, `PRECONVERSION_SMOKE`, `GC_REPORT_FIRST`.

## Before the first live run

- Apply the `check-target.py --site` change (decision 8). It also carries the cluster and namespace UIDs the command
  reads. Without it the command stops at `CHECK_TARGET_IDENTITY`.
- Run `selftest` (Python 3.13 at `/usr/bin/python3`, systemd 257, k3s crictl and ctr v2.2.7 were read on 2026-10-23).
- Run `status` and `plan <live sha>`, then the conversion with Andy present, then a `--drill-fail-smoke` deploy.
