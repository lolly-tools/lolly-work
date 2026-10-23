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

This directory sits outside `scripts/` on purpose: `deploy/compose/Dockerfile` copies `scripts/` into every Work image,
and preview host tooling must not ship to private deployers.

## How it is trusted

- **The tool is pinned.** Run it only through the private launcher `lolly-private/production/preview/launch.py`. The
  launcher hashes `deploy/preview/` plus `scripts/app-update.py` in the lolly-work checkout and refuses any tree whose
  hash differs from `tool.lock.json`. It copies exactly the hashed bytes into a private snapshot and runs that copy.
  The command itself also refuses a checkout with local changes in those paths, or one whose commit is not on
  lolly-work `main`.
- **Trust anchors are code.** Repositories, workflow paths, the receipt artifact name, the image package, the signing
  pin, origins and resource names live in `lib/preview_anchors.py`. The private profile holds only identifiers, the
  SSH route, the page list and thresholds. The command takes no profile path: it reads `<site>.json` from the state
  directory the launcher passes, and refuses a group- or world-writable directory or profile.
- **Changing the tool is a reviewed lolly-work PR, then a new lock.** After the PR merges, regenerate the lock with
  `make-tool-lock.py` (it refuses a tree that is not on `main`) and add a production README entry for the tool change.

## Subcommands

All of them take a site and, where needed, one full commit SHA. The launcher adds `--state-dir`, `--tool-sha256`,
`--checkout` and `--check-target`.

```text
launch.py lolly.tools ship <sha>      dispatch the candidate build for main's head, wait, bind, deploy
launch.py lolly.tools deploy <sha>    deploy an already built and bound commit on main
launch.py lolly.tools rollback        go back to the recorded previous build (manual)
launch.py lolly.tools status          live phase, image, source, Pod, unit state, last result (read-only)
launch.py lolly.tools gc [--execute]  image retention report; --execute removes images only, never claims
launch.py lolly.tools plan <sha>      one-time 3.6 conversion plan (read-only)
launch.py lolly.tools plan <sha> --apply PLAN --reviewed-plan-sha256 HASH
```

Flags: `--drill-fail-smoke` (ship, deploy, plan --apply) forces a smoke failure after the real smoke, to drill the
automatic rollback; it changes nothing else. `--clear-hold` proceeds although the live phase says a human must look.

## What `ship` does

1. Refuses unless the commit is `main`'s head. Phase 1 uses the existing candidate build, which itself refuses any
   commit that is not `main`'s head at dispatch time.
2. Reads the live state. If this commit is already live and accepted, it reports `ALREADY_LIVE` and stops.
3. Requires a successful normal CI push run on `main` for the commit, and no other active candidate run. It never
   changes the candidate workflow's concurrency.
4. Dispatches `deployment-suse.yml` with the same request the retired bot sent: `build_images`, `release_scope=web`,
   `expected_source`, `ci_run` and the existing public pin.
5. Waits for the run. Andy approves the two signing gates in GitHub. **Agents never approve an environment gate.**
6. Binds the finished run: workflow path, event `workflow_dispatch`, same repository for run and head, branch `main`,
   head SHA, success, and the `public-candidate-web-receipts-attempt-N` artifact. Every receipt field is checked by
   exact pattern; the image must be `ghcr.io/lolly-tools/lolly-web@sha256:...`.
7. Builds the smoke expectations from the commit's own files: the headers in `deploy/docker/security-headers.conf`,
   with the CSP from the `$lolly_csp` map in `deploy/docker/nginx.conf` and the build's connector origins (refused if
   that repository variable changed after the build started), the models manifest and the shell's stored-format
   versions.
8. Refuses if the models manifest differs from the mounted models release (use the models procedure), or if an older
   build would lower a stored format.
9. Checks the backup window (no deploys 01:30 to 02:30 UTC), then runs `check-target.py --site lolly.tools` once,
   immediately before the run starts. That check also covers the run's own automatic rollback.
10. Starts the node unit and follows its progress. A dropped SSH or Wi-Fi link only pauses the follow; the unit keeps
    going. Run `status` to reattach.

`deploy <sha>` is steps 6 to 10 for the newest successful candidate run of an earlier commit.

## On the node

The run is the transient unit `lolly-preview-deploy.service`, installed from the pinned bundle into
`/run/systemd/system` and started detached. While it is active the command refuses to start another run, and the
runner holds `/run/lock/lolly-preview-deploy.lock` for its whole life. One run at a time, for both sites.

**Manual changes to a preview take the same lock:**

```text
sudo flock -n /run/lock/lolly-preview-deploy.lock <your command>
```

A deploy run:

1. Checks the cluster, node, namespace and Deployment identity, readiness, the image layout (the conversion is
   done), the models release, and that the live release is the one the operator read.
2. Checks capacity: free bytes on the image filesystem above the image-GC reserve (`total // 4 + 512 MiB`) must cover
   the larger of the profile minimum and three times the compressed image plus 1 GiB.
3. Pulls the image by digest and pins it; the live image stays pinned as the rollback target.
4. Writes the phase annotation `switching`, with the previous build's record.
5. Switches the image with `app-update.py`: plan, server dry run, guarded patch that tests UID, resource version,
   container name and current image, rollout. Then writes `switched-unverified` and the new build's records.
6. Smoke (below), then a watch (default 5 minutes, a probe every 15 seconds).
7. Writes `accepted`, applies image retention and records the result.

### Smoke

Against the real edge with normal TLS verification, no redirects, no credentials:

- `/release-frontend.sig.json` verifies against the pinned key, for this commit and profile `lolly-demo`.
- `/` answers 200 and its body hash equals the signed `index.html`. Its ETag must be one of the delivery map's values
  for `/` (identity, gzip or br hash from the signed receipt). The ETag is never compared with the body hash.
- Every header in the source's `security-headers.conf` is served exactly, once, including the full CSP.
- Catalog index, signature and asset index match the receipt; no tool or asset id starts with `suse`.
- `https://www.lolly.tools/` answers 308 to the apex; `/healthz` answers 200.
- The profile's pages, plus up to three `/info` pages this build added, answer 200 with the signed hash.
- One model file: HEAD 200 with the right length, and `Range: bytes=0-0` 206. This proves the models claim is mounted.
- The Pod is Ready with 0 restarts and its working set is under 80% of the memory limit.

### Automatic rollback

Triggers: a failed rollout, any smoke failure, 3 consecutive failed watch probes, or the unit stopping after the
switch. The last one is handled by `ExecStopPost`: when the Deployment's phase is still `switching`,
`switched-unverified` or `rolling-back` for this run's deploy id, it rolls back (or marks `aborted` when the image
never changed). This covers a crash, `RuntimeMaxSec` and `systemctl stop`.

The rollback is one attempt: an `app-update.py` plan back to the recorded previous image, then the smoke with the
previous build's recorded expectations. If that fails too, the phase becomes `rollback-unhealthy`, the result is
`ROLLBACK_UNHEALTHY` and every later run refuses until a human looks and passes `--clear-hold`.

The automatic rollback inside the watch runs even when the new build raised a stored format, because a broken site
is worse. A user who loaded the new shell in those minutes finds local storage locked (never deleted) until the next
roll forward.

### Manual rollback

`rollback` goes back to the recorded previous build. It runs `check-target.py` first and refuses when the previous
build would lower a stored format (`indexedDb`, `revisionArchive`, `channelMessage`, `session`): roll forward
instead. A rollback clears the previous record, so a second `rollback` refuses. To go further back, `deploy` an older
commit, which applies the same stored-format rule.

## One-time conversion (PROPOSAL 3.6)

lolly.tools still serves a claim-mounted root with an nginx ConfigMap over the image's own files. The command refuses
to deploy until that layout is converted, once, with the bytes that are live now.

1. `plan <live sha>` prints the exact guarded patch: remove the `public-delivery` volume and its three mounts, remove
   the `nginx` ConfigMap volume and its four mounts, set `revisionHistoryLimit: 5`, keep the image. It also prints a
   diff of the image's nginx files against the ConfigMap, and a read-only smoke of the live site (its header check is
   expected to differ: that is the ConfigMap the conversion removes). The plan is saved under `plans/` in the state
   directory with its SHA-256.
2. Andy reviews it. The named owner applies it once, with Andy present:
   `plan <sha> --apply PLAN --reviewed-plan-sha256 HASH`. The patch tests UID, resource version, image, and the
   exact volumes and mounts, and it seeds the preview records. The tool hash must equal the one that made the plan.
3. Smoke and watch follow. On failure the run restores the exact claim layout and smokes it without the exact header
   check (the claim layout serves the ConfigMap's headers).

Keep the 4d07e5fe and 4ec claims until two image deploys have passed. `gc` then lists them for Andy.

## What it may change, and what it never touches

May change: pulled images and their pins; the `sovereign-web` image (through `app-update.py`), its metadata
annotations, and once its layout (the plan above).

Never touches: Secrets, PVCs, Postgres, the edge, DNS, other Deployments, the Helm release or any GitHub setting. It
never approves an environment gate. The only GitHub write is the candidate workflow dispatch.

## Records

- Deployment annotations `lolly.tools/preview-*`: `phase`, `deploy-id`, `source`, `image`, `ci-run`, `tool`,
  `formats`, `expect`, `previous`, `reason`, `layout`, `deploys`, `updated`. They are metadata, so writing them never
  starts a rollout.
- One JSON line per mutating run, including refusals, in `deploys.jsonl` in the state directory.
- The node journal (`journalctl -u lolly-preview-deploy`) and a result file per run in `/var/lib/lolly-preview/results`.
- A production README entry only for a rollback, a layout change or a tool change.

## Retention (`gc`)

Images follow a standing policy: after each accepted deploy, and on `gc --execute`, the command keeps the live image
and the two newest previous images of this Deployment pinned, and removes older `lolly-web` images that no Pod or other
ReplicaSet uses. Claims are never deleted by the command. `gc` lists only allowlisted claims (the profile's
`gc.legacyClaims` or claims labelled `lolly.tools/managed-by=preview-deploy`), blocks any claim that a Pod mounts, a
StatefulSet owns or a durable label names, and waits for two image deploys after the conversion. For a listed claim it
prints the exact command for Andy to run himself. On local-path storage a deleted claim deletes its data.

## Exit codes and results

`0` LIVE, ALREADY_LIVE, CONVERTED, GC_DONE. `1` REFUSED (with a code) or a stop without result. `2` ROLLED_BACK or
CONVERSION_REVERTED. `3` ROLLBACK_UNHEALTHY.

Common refusal codes: `TOOL_DIRTY`, `TOOL_NOT_MAIN`, `TOOL_HASH_MISMATCH`, `SITE_PHASE_2`, `NOT_MAIN_HEAD`,
`NOT_ON_MAIN`, `CI_NOT_GREEN`, `CANDIDATE_ACTIVE`, `RUN_NOT_BOUND`, `RUN_FAILED`, `RECEIPT_INVALID`,
`CONNECTOR_ORIGINS_CHANGED`, `MODELS_CHANGED`, `FORMAT_LOWERING`, `BACKUP_WINDOW`, `CHECK_TARGET_FAILED`,
`LOCK_HELD`, `HELD_FOR_HUMAN`, `NOT_CONVERTED`, `NOT_READY`, `STATE_CHANGED`, `LOW_CAPACITY`, `PLAN_MISMATCH`.

## Before the first live run

- Apply the `check-target.py --site` change (decision 8). Without it check-target refuses the argument and the
  command stops at `CHECK_TARGET_FAILED`.
- Confirm read-only on the node: `python3` is 3.9 or newer at `/usr/bin/python3`; `/usr/bin/systemctl`;
  `k3s crictl` and `k3s ctr` work; the node reaches `ghcr.io` and trusts its certificate from Python.
- Run `status` and `plan <live sha>`, then the conversion with Andy present, then a `--drill-fail-smoke` deploy.
