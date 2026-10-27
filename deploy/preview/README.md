# Preview deploy command (lolly.tools Phase 1b, lolly.ing Phase 2)

`preview-deploy` ships one exact `main` commit of Lolly to the lolly.tools preview. It asks CI to build and sign the
web image, puts that image on the K3s node by digest, switches the Deployment with Work's own guarded patch
(`scripts/app-update.py`), runs a smoke check, watches for a few minutes and rolls back by itself if anything fails.

For lolly.ing it ships one private instance image, built for a lolly-work `main` commit by suse-lolly's private
workflow, with a verified backup before any migration, a migration guard and a catalog generation rule. lolly.ing is a
preview-grade route (Andy, 2026-10-27): a qualified build ships with no approval. See
[lolly.ing](#lollying-phase-2-proposal-section-4). Every lolly.ing command refuses until the tool pins lolly.ing's own
catalog key.

It replaces the per-release runbooks for these previews. It is not a platform release tool, and the platform release
workflows do not use it.

Python 3.9 or newer, standard library only, on both the operator's Mac and the node. No `pnpm install`, no worktree.

## Contents

- `preview-deploy.py`: the operator entry point.
- `lib/`: the code. `preview_anchors.py` holds every trust anchor.
- `node/lolly-preview-deploy.service`: the systemd unit for one run on the node. It is the node lock.
- `node/node_runner.py`: the unit's `ExecStart` and `ExecStopPost`.
- `node/bootstrap.py`: the small program sent over SSH that installs and starts a run, answers a read, or receives a
  lolly.ing archive into the node's spool.
- lolly.ing: `lib/preview_ing.py` (rules), `lib/preview_ing_github.py` (the private run), `lib/preview_ing_mac.py` and
  `lib/preview_ing_node.py`.
- `lib/preview_lane.py`: the fast deploy lanes for lolly.tools (see [Fast deploy lanes](#fast-deploy-lanes)).
- Tests: `tests/test_preview_deploy.py`, `tests/test_preview_deploy_ing.py` and `tests/test_preview_lane.py`, with fakes in
  `tests/preview_deploy_fakes.py` and `tests/preview_deploy_ing_fakes.py`, run by Work CI through
  `tests/preview-deploy.test.ts`.
- `restore-rehearsal.py`, `lib/preview_rehearsal.py` and the in-Pod programs in `rehearsal/`: the restore rehearsal
  operator for lolly.ing's migrations (Phase 2). See [`REHEARSAL.md`](REHEARSAL.md). Tests:
  `tests/test_restore_rehearsal.py` with a fake kubectl in `tests/restore_rehearsal_fakes.py`, run through
  `tests/restore-rehearsal.test.ts`.

This directory sits outside `scripts/` on purpose: `deploy/compose/Dockerfile` copies `scripts/` into every Work image,
and preview host tooling must not ship to private deployers.


## Fast deploy lanes

A lolly.tools ship need not wait about 40 minutes for the commit's own full `ci.yml` run when the change is docs or
web shell UI only. `lib/preview_lane.py` is the Python port of Lolly's `scripts/deploy-lane.ts`, and both are tested
against the same cases (`tests/fixtures/deploy-lane-cases.json`, a pinned copy of Lolly's
`tests/fixtures/deploy-lane/cases.json`). When the commit has no successful full CI run of its own, ship:

- refuses with `CI_NOT_GREEN` when a full CI run of the commit already failed (a lane never overrides one);
- finds the base: the newest first-parent ancestor, within 50, with a successful full `ci.yml` push run on `main`;
- reads every changed path between base and commit from GitHub's tree objects (exactly under `docs/` and
  `shells/web/`, and per directory elsewhere, which needs full CI anyway) and applies the lane rules;
- requires the lane's job in `.github/workflows/fast-lanes.yml` (`docs lane` or `web lane`) to have passed on a `push`
  run of the commit on `main` in Lolly's own repository.

Otherwise it refuses as before (`CI_PENDING`), with the lane's reason added: which path needs full CI, or which job has
not passed yet. A lane ship records `lane`, `laneBase`, `laneBaseCiRun` and `laneRun` in `deploys.jsonl`.
`preview-web.yml` then checks the same rule again from Git with the base commit's own copy of the TypeScript, so the
build needs both to agree. lolly.tools ships its source on a lane. lolly.ing uses the same rule for the Lolly commit
its Work commit pins (`ING_LOLLY_CI`), while the Work commit itself always needs its own full lolly-work CI run; see
[Qualification](#qualification-andy-2026-10-27). The legacy release route never takes a lane. The rules: docs is everything under `docs/` plus `README.md` and
`engine/text-composition.md`, except `docs/supported-environments.md` and `docs/parser-inventory.md` (full) and the
card renderer `docs/og-image.ts` and `docs/og-opal.ts` (web). Web adds `shells/web/` except its build inputs, entry
page, served files other than static media (so `sw.js`), `main.ts`, `bridge/`, `capture/`, `catalog/`, `collab/`,
`org/`, `ext/`, `vendor/`, `ca-root.ts`, `lib/sync-*` and security-named files. Dependency manifests, symlinks and
executable files always need full CI. Tests never ship and take the lane of the changes beside them.

## How it is trusted

- **The tool is pinned.** Run it only through the private launcher `lolly-private/production/preview/launch.py`.
  - The launcher checks exactly the files `tool.lock.json` lists: `deploy/preview/` plus `scripts/app-update.py`, taken
    from `git ls-tree` of a merged main commit. The restore rehearsal lives in `deploy/preview/`, so it is covered.
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

1. Requires a reviewed preview key in `PREVIEW_PUBLIC_KEY_JWK` and `PREVIEW_PUBLIC_KEY_THUMBPRINT`.
   Both anchors remain `None` until the owner pins Andy's new public key in a reviewed change. Until then ship and
   deploy refuse with `PREVIEW_PIN_MISSING` before dispatch or cluster changes. A preview key equal to the release
   key is refused. The source must be equal to or an ancestor of `main`'s head, read from `refs/heads/main`.
2. Reads the live state:
   - It refuses while a run is active on the node, and before anything else when the live phase needs a human.
   - If this commit is live, accepted, and its records name the live image, it reports `ALREADY_LIVE` and stops.
3. Reuses a build of this commit that still binds. Otherwise it:
   - requires a successful normal CI push run on `main` for the commit, or a fast deploy lane above one (see
     [Fast deploy lanes](#fast-deploy-lanes));
   - requires no other active preview build run;
   - dispatches `lolly-tools/lolly`'s `.github/workflows/preview-web.yml` on `refs/heads/main` with
     `inputs: {"source": "<40-hex sha>"}` only. It does not send `min_seq`. The workflow finds green main CI itself
     and uses its own preview pin. The Mac still checks green CI before dispatch.
4. Waits for the run, tolerating brief GitHub errors. **Agents never approve an environment gate.**
5. Binds the finished run:
   - workflow path, event `workflow_dispatch`, same repository for run and head, branch `main` and success;
   - exact display title `Preview web <source>`, with source equal to or an ancestor of the run's 40-hex head SHA.
     Discovery reads up to 100 runs without filtering by head SHA, since main may advance before dispatch;
   - the `preview-web-receipts-attempt-N` artifact, with the same five receipt files and all existing field checks;
   - `public.jwk.json` must match the preview pin and the catalog key id must match its thumbprint. A receipt carrying
     the release pin is refused;
   - the image must be `ghcr.io/lolly-tools/lolly-web-preview@sha256:<64hex>`, never a tag.
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

`deploy <sha>` is steps 1, 2 and 5 to 11 for the newest binding preview build run of an earlier commit.

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
2. The smoke with the previous build's recorded expectations and catalog pin, and the edge headers from before the
   switch. The release package remains allowed for rollback to images deployed before Phase 1b.
3. If that fails too, the phase becomes `rollback-unhealthy` and the result is `ROLLBACK_UNHEALTHY`. Every later run
   refuses until a human looks. The records then describe the failed new build while the old image is live, so
   `--clear-hold` alone is not enough: `ship` and `deploy` refuse `RECORDS_STALE` before any build is reused or
   dispatched. The way forward is `adopt` (below).

The key follows the image. New deploy, conversion and adopt requests carry `release.catalogPin`, the catalog-key
thumbprint. Manual rollback requests carry `catalogPin`, which must match the node's recorded rollback target.
The node accepts only the anchored preview or release key and uses that key for the served receipt smoke, including
the light smoke before switching. New deploys additionally require the preview key and preview package.

The Deployment annotation `lolly.tools/preview-catalog-pin` records the live image's thumbprint. Before a switch it
is copied into `catalogPin` in the `lolly.tools/preview-previous` JSON record, alongside the image digest and smoke
expectations. Automatic rollback, including `ExecStopPost`, reads that record; manual rollback uses the same record.
A record or live annotation with no pin is treated as release-pinned. Successful deployment, adoption, conversion and
rollback results also include `catalogPin` in the node result and the Mac's `deploys.jsonl` audit log. Image labels
continue to track containerd retention ownership only; they do not choose the signing key.

### Adopt

`adopt <sha>` re-seeds the records for the image that is live. It never dispatches a build.
1. It binds the run of `<sha>` that built exactly the live image. For the old `ghcr.io/lolly-tools/lolly-web` package,
   it still uses `deployment-suse.yml`, `public-candidate-web-receipts-attempt-N`, exact head SHA and the release pin.
   For the preview package, it uses the new workflow and preview pin. It records the bound pin with the image.
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

One unit serves both sites, so `RuntimeMaxSec=9090` is the longer of two budgets:
- lolly.tools (5130 s): two pulls (600 s each), two rollouts (600 s each), the longest allowed watch (15 minutes),
  three smokes and the image retention after an accepted deploy (330 s), with margin.
- lolly.ing (9090 s): the archive import (900 s), the read-only checks, the migration path (the backup Job 660 s, the
  classifier, a 1500 s rehearsal when configured and a 900 s migrate Job), the switch, the smoke and readback, the
  longest watch, one rollback and the retention, with margin.

`TimeoutStopSec=1800` is the separate budget for one `ExecStopPost` rollback: a pull, a rollout and a smoke. The request
validator refuses a longer watch or rollout, and a test keeps the unit file equal to `preview_anchors.py`. The
backup-window check counts each site's own worst case, and lolly.ing counts the migration path only when the build's
migration files differ from the live build's.

### Selftest

`selftest` installs and starts the unit like a real run, so check-target runs first. Inside the same unit and sandbox it
runs read-only checks:
- the Python version, `NoNewPrivileges` and the SELinux context;
- that kubectl, `crictl` and `ctr` run under those restrictions;
- that pins can be read;
- capacity, DNS, and HTTPS with normal TLS verification.

It changes nothing. Run it before the first live run.

## One-time conversion (PROPOSAL 3.6)

If lolly.tools serves a claim-mounted root with an nginx ConfigMap over the image's own files, the command refuses
to deploy until that layout is converted, once, with the bytes that are live now. This path remains available for old images.

1. `plan <live sha>` binds the run that built exactly the live image, using the same old-workflow compatibility as
   adopt, even when a newer rebuild of the commit exists, and skips runs whose receipt has expired. It prints the receipt's expiry: run 39658589581 for
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
- any GitHub setting. It never approves an environment gate. The only GitHub write is the preview workflow dispatch.

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
  new build. So the report also lists unused `lolly-web-preview` and old `lolly-web` images this command did not pull.
  Each entry gives its refs, size, pinned refs, who pinned it (`preview-deploy` or another procedure) and any old
  revision still naming it.
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
- `3`: ROLLBACK_UNHEALTHY, ADOPTED_UNHEALTHY or MAINTENANCE_UNVERIFIED (lolly.ing).

Common refusal codes:
- **Tool and inputs:** `BAD_ARGUMENTS`, `TOOL_NOT_LOCKED`, `TOOL_DIRTY`, `TOOL_NOT_MAIN`, `TOOL_HASH_MISMATCH`,
  `STATE_DIR_INVALID`, `CHECK_TARGET_PATH`, `CHECK_TARGET_IDENTITY`, `CHECK_TARGET_CHANGED`, `PROFILE_INVALID`.
- **Source, build and run:** `PREVIEW_PIN_MISSING`, `PREVIEW_PIN_INVALID`, `CATALOG_PIN_INVALID`, `NOT_ON_MAIN`,
  `CI_NOT_GREEN`, `CANDIDATE_ACTIVE`, `RUN_NOT_BOUND`, `RUN_FAILED`, `RECEIPT_INVALID`, `CONNECTOR_ORIGINS_CHANGED`, `CONNECTOR_ORIGINS_UNPROVEN`, `MODELS_CHANGED`,
  `FORMAT_LOWERING`.
- **Live state:** `RECORDS_STALE`, `LIVE_SMOKE_FAILED`, `BACKUP_WINDOW`, `CHECK_TARGET_FAILED`, `LOCK_HELD`,
  `HELD_FOR_HUMAN`, `NOT_CONVERTED`, `NOT_READY`, `STATE_CHANGED`, `LOW_CAPACITY`, `PIN_FAILED`, `BAD_IMAGE`,
  `NOT_STARTED`, `ADOPT_SMOKE_FAILED`.
- **Conversion and gc:** `PLAN_MISMATCH`, `PRECONVERSION_SMOKE`, `GC_REPORT_FIRST`.
- **lolly.ing:** `ING_KEY_NOT_PINNED`, `RELEASE_KEY`, `KEY_MISMATCH`, `MANIFEST_INVALID`, `RECEIPT_SIGNATURE`,
  `RECEIPT_MISMATCH`, `ARCHIVE_MISMATCH`, `ARCHIVE_MISSING`, `IMAGE_MISMATCH`, `SMOKE_ACCOUNT`, `BACKUP_UNVERIFIED`,
  `BACKUP_STALE`, `MIGRATIONS_MISMATCH`, `DATABASE_AHEAD`, `CLASSIFIER_UNAVAILABLE`, `REHEARSAL_UNAVAILABLE`,
  `REHEARSAL_FAILED`, `MIGRATE_INCOMPLETE`, `GENERATION_UNKNOWN`, `CONFIG_GUARD`, `SWITCH_GUARD`, `CUTOVER_GUARD`,
  `MAINTENANCE_NO_ROLLBACK`, `SIGNING_SECRET_NOT_PINNED`, `SIGNING_SECRET_LIVE`, `PLAN_NOT_REVIEWED`, `NOT_FOR_LOLLY_ING`,
  and the shared `CI_PENDING`, `CI_NOT_GREEN` and `CANDIDATE_ACTIVE`.

## lolly.ing (Phase 2, PROPOSAL section 4)

lolly.ing runs one private **instance image** (`docker.io/library/lolly-ing-instance@sha256:<digest>`): the Work server,
the SUSE shell at `/app/shell` and the pack at `/app/packs/lolly-ing`. `instance.json` stays a ConfigMap, one immutable
ConfigMap per catalog generation. One digest names the cohort, so a rollback is one digest back plus a new generation.

lolly.ing is a **preview-grade** route (Andy, 2026-10-27), the same model as lolly.tools: a time-boxed collaboration
preview that must be quick to update. A qualified Work commit ships from `main` with no approval. Kept: lolly.ing's own
catalog key, protected `main`, and a verified PostgreSQL backup before every migration. Dropped: the two signing
approvals per build, the separate agent identity and the maintenance-migration approval.

```
launch.py lolly.ing ship <work sha>                    build (or reuse, or resume) the private build, then deploy it
launch.py lolly.ing deploy <work sha>                  deploy the newest bound build of that Work commit
launch.py lolly.ing plan <work sha>                    print the one-time cut-over patch (PROPOSAL 4.8)
launch.py lolly.ing plan <sha> --apply PLAN --reviewed-plan-sha256 H   apply it once, the owner with Andy present
launch.py lolly.ing rollback                           the recorded previous build, at a higher generation
launch.py lolly.ing status [--follow DEPLOY_ID]
launch.py lolly.ing gc [--execute]                     retention report; --execute removes only what this command made
```

The input is one lolly-work `main` commit (WSHA). Its `engine-pin.json` names the Lolly commit (LSHA), and suse-lolly
is built at its `main` head (SSHA). `selftest` and `adopt` are lolly.tools only (`NOT_FOR_LOLLY_ING`): the unit's own
selftest covers both sites, and the cut-over seeds lolly.ing's records. Before the cut-over, `ship` builds and stops
with `BUILT`, changing nothing on the node; `deploy` refuses `NOT_CONVERTED`.

The private profile `lolly.ing.json` holds the smoke account's `sub`, one known pack asset path, the page list, the
memory fraction, the watch, build polling, rollout timeout, capacity (`minFreeAboveReserveBytes`, `archiveFactor`), the
backup window (`01:30`-`02:30`), the claim allowlist, the retention counts, and `rehearsal`: `null` (the preview-grade
default), or the backup store's host name and public address to run the restore rehearsal before each migration.
Identities come from check-target `--site lolly.ing`, including the database Secret name the Jobs may reference.

### Qualification (Andy, 2026-10-27)

`ship` dispatches nothing, and `deploy` changes nothing, until both sources qualify:

- **Work (WSHA):** its own successful full `ci.yml` push run on lolly-work `main` (`ING_WORK_CI`, about 15 minutes).
  Work's CI cancels a superseded push, so in practice this is `main`'s head once its run is green.
- **Lolly (LSHA, from Work's engine pin):** what qualifies a lolly.tools source: its own successful full Lolly CI run, or
  a fast lane above one (`ING_LOLLY_CI`, `preview_lane.py`). The engine pin usually names an older commit whose full
  run finished long ago.
- **suse-lolly (SSHA):** no CI gate of its own. The build validates the SUSE catalog with the strict `suse` profile,
  signs and verifies it, assembles the pack with Work's release-mode producer and boots the image; the deploy smoke
  checks the signed catalog again. A broken content commit fails the build and nothing ships. suse-lolly `main` is
  protected (Andy's setting).

A refusal is `CI_PENDING` while a run is still going, and `CI_NOT_GREEN` once one failed or was cancelled, each naming
the repository. The private workflow's gate checks the same rule again (green Work CI, and Lolly's own run or the lane
rule from the base commit's `scripts/deploy-lane.ts`). `deploys.jsonl` records `workCiRun`, `lollyCiRun` and, for a
lane, `lollyLane`, `lollyLaneBase` and `lollyLaneRun`.

### INTEGRATION: the Phase 2 contract

- **suse-lolly `.github/workflows/lolly-ing-preview.yml`.**
  - `ship` dispatches it on `refs/heads/main` with `LSHA`, `WSHA` and `SSHA` (main's head). Its run is named
    `lolly.ing preview <WSHA>`, so a later `ship` of the same commit resumes a running build instead of dispatching
    another; a build of anything else that is still running refuses `CANDIDATE_ACTIVE`.
  - The two jobs that hold the key (`sign-source` and `sign`) use environment `lolly-ing-signing`: no reviewer,
    deployments from `main` only, secret `LOLLY_ING_CATALOG_SIGNING_KEY`. They install nothing; the compile between them
    never holds the key. Nothing waits for a person.
  - The run is bound by its ID: workflow path, event `workflow_dispatch`, repository and head repository
    `lolly-tools/suse-lolly`, branch `main`, success, and head SHA equal to `sources.suse` and `run.workflowSha`. The
    gate refuses an `SSHA` that is not the run's own commit. A run whose manifest is malformed is skipped and reported
    (`build-skipped`), not fatal to the search (review L2).
  - From that run only: `lolly-ing-instance.manifest.json` (kind `lolly-ing-instance-image`, version 1) and
    `lolly-ing-instance-<run>-<attempt>.oci.tar`, kept 7 days.
  - The manifest's key ids (`shell.keyId`, `shell.publicPinThumbprint`, `catalog.keyId`, `buildSettings.pinThumbprint`)
    must all be the lolly.ing pin and never the release key.
  - The archive's sha256 is checked twice: while it streams into the node's root-only spool, and again before
    `ctr images import --no-unpack --digests --base-name docker.io/library/lolly-ing-instance` reads that same file.
    Then the index digest, the linux/amd64 manifest, the config and the DiffIDs are checked, and the run tag
    (`image.refName`) the import kept is removed.
  - After the switch the smoke verifies the shell's served `/release-frontend.sig.json` against the lolly.ing pin
    (source `LSHA`, target `web`, profile `suse`), its sha256 against `receiptSha256`, and `/` against
    `shell.indexSha256`.
- **lolly-work PR #207, the migration classifier and `LW_MIGRATE_EXPECT`.**
  - A Job from the new image, with no environment, runs `node scripts/classify-migrations.ts --json --only <pending>`.
    It prints one JSON document: `{"version": 1, "migrations": [{name, sha256, class, reasons, statements}],
    "manifest"}`. The tool requires exactly the pending files, their manifest sha256s and the same `manifest`.
  - The class no longer admits or refuses anything. It decides what a failed switch does afterwards: after only
    `additive` files the previous image comes back automatically; after any other class the run holds.
  - The migrate Job runs `node scripts/migrate.ts` with only `DATABASE_URL` (and `DATABASE_URL_UNPOOLED` when the
    server has it), `NODE_ENV` and `LW_MIGRATE_EXPECT=sha256:<manifest>`. The manifest is sha256 over
    `lolly-work migration manifest v1\n` and one `name<TAB>sha256` line per pending file in name order. The runner
    refuses before any DDL unless the pending set has exactly that manifest.
- **lolly-work PR #208, the restore rehearsal** (`restore-rehearsal.py`, `lib/preview_rehearsal.py`, `rehearsal/`;
  see [`REHEARSAL.md`](REHEARSAL.md)). Optional on the preview-grade route: it runs before a migration only when the
  profile's `rehearsal` names the backup store. Otherwise it is a manual drill.
  - It lives in `deploy/preview/`, so the tool lock covers it with no launcher change.
  - The unit calls it as a library: `Rehearsal(Kubectl(argv), Inputs(...)).run()`. The inputs are the backup Job's own
    `VERIFIED` line, the pending files, the new and the live image, the anchored PostgreSQL image, the profile's backup
    store host and address, namespace `lolly-restore-rehearsal`, the 30 s lock budget and a 900 s deadline. This run's
    check-target covers it.
  - It refuses anything but `result: PASSED` with `teardownComplete`, the same pending set and `expect`, the same
    images, every file within the budget, and `egressClosedAfterFetch`.

### Key (PROPOSAL 4.7, review H3)

- Every lolly.ing command refuses with `ING_KEY_NOT_PINNED` until a reviewed change sets `ING_PUBLIC_KEY_JWK` in
  `preview_anchors.py` to lolly.ing's own public key. The tool refuses a pin equal to the platform release key.
- A build whose shell pin, catalog signature or build settings name the release key (`5zVngG6s…`) is refused before any
  transfer.
- Before any change, Work's boot line `catalog signing on (keyId …)` in the live Pod must not name the release key.
  After the switch it must name the lolly.ing key, and the signed catalog and the shell's receipt must verify against
  the lolly.ing pin.
- The private key lives in a **second** Secret that Andy creates (`ING_SIGNING_KEY_SECRET` names it), under the key name
  `LW_CATALOG_SIGNING_KEY`. Nobody edits the live Secret. The cut-over patch points the server's
  `LW_CATALOG_SIGNING_KEY` reference at the new Secret, together with the image and the config; a revert points it back.
  So a reverted cut-over is old image, old key and old pack again, and its catalog verifies. `instance.catalogPublicKey`
  stays unset. The command never reads or writes a Secret's value. `plan` refuses `SIGNING_SECRET_NOT_PINNED` until the
  name is pinned, and `SIGNING_SECRET_LIVE` when the server already references it.

### Deploy steps (PROPOSAL 4.3)

On the Mac:
1. Live state from the node: no run active, no hold, the instance-image layout, records that describe the live image,
   and the smoke session file present.
2. WSHA is on lolly-work `main`. For `ship`: when the accepted live build already has this Work commit, this suse-lolly
   head and this Lolly pin, `ALREADY_LIVE` before anything else. Then the qualification above.
3. The build is reused, resumed or dispatched, then bound and its manifest checked (the contract above); its suse-lolly
   and Lolly commits are on their `main`.
4. The first-party commits and dependency files changed since the live release are printed (R21 R3).
5. check-target `--site lolly.ing`, once, before the first write to the node.
6. The archive is downloaded by run ID and streamed over the check-target SSH route into the node's root-only spool,
   hashed while it is written. A wrong size or sha256 deletes it (`ARCHIVE_MISMATCH`). No registry credential is ever on
   the node.
7. The unit starts.

In the unit:
1. Identity, hold and layout checks; the live build passes its own light smoke (`LIVE_SMOKE_FAILED` otherwise).
2. The live image stays pinned. The archive is checked and imported as in the contract above, and the pin read back.
3. A read-only check Job from the new image, with `DATABASE_URL` only, in a `begin read only` transaction: the image's
   migration files, the ledger and `catalog_delivery_sequence.publication_generation`. The files must equal the build
   manifest's. The database may be ahead only by names this lane applied as additive (`DATABASE_AHEAD` otherwise).
4. Only with pending migrations, of any class:
   - a fresh backup Job from the `lolly-postgres-offhost-backup` CronJob, whose `VERIFIED` line (a complete GET,
     ciphertext check, authenticated decryption and plaintext comparison) is kept as it is;
   - the classifier, then the restore rehearsal when the profile configures one;
   - the backup must be under an hour old (`BACKUP_STALE`, nothing applied);
   - the **restore point** is written to the Deployment (annotation `lolly.tools/preview-backup`: the backup record,
     the migrations, their class, and the previous image, source and config), and for a non-additive class the
     `maintenance-applied-unswitched` marker too, before anything is applied;
   - the migrate Job (the contract above), and a second check must find nothing pending. The old Pod keeps serving
     throughout.
   With nothing pending there is no backup Job: the daily backup and the previous image cover a deploy that changes no
   schema.
5. Generation N = 1 + the maximum of the live config, every ConfigMap holding an `instance.json`, the database row and
   the new shell catalog's signed seq (R20 S16). A new immutable ConfigMap `lolly-ing-config-<N>-<sha8>` holds the live
   `instance.json` with only `instance.catalogPublicationGeneration` changed.
6. One guarded patch: the image, the config ConfigMap name and the records, with a server dry run first. It tests the
   UID, resourceVersion, container name, current image and current ConfigMap name. `app-update.py` changes images only,
   so this patch follows its guard pattern instead of calling it. Recreate drains the old Pod.
7. Smoke, then the watch.

### Smoke (PROPOSAL 4.5)

`/healthz` names `lolly.ing`; `/readyz`; `/` matches the build's `index.html`; the shell's receipt verifies; CSP allows
`blob:` in `script-src` and `connect-src`; the profile's pages; an anonymous catalog request gets 401 and an anonymous
pack asset 401 or 404; the smoke account; the signed-in catalog and its envelope verify against the lolly.ing pin; one
QR code export through the render worker; `www.lolly.ing` answers 308 to `https://lolly.ing/`; the Pod is Ready with 0
restarts and a working set under the profile's fraction of the 1 Gi limit; Work's boot line names the lolly.ing key;
and a read-only Job reads the database's publication generation back as N.

The smoke account:
- is a `member`, never an admin, and owns no projects (checked through `/api/auth/session` and `/api/v1/projects`);
- has one grant, `export.server` on `tool:qr-code`, so it can render the QR code (Work grants live in the database; an
  admin adds it once);
- signs in through its `lw_session` cookie, kept in `/etc/lolly-preview/lolly.ing-smoke-session` on the node, root-owned
  and 0600. The tool reads it with `O_NOFOLLOW`, sends it only to `https://lolly.ing`, and never prints, logs or stores
  it anywhere else. Work sessions last `policy.sessionTtlHours` (12 by default), so the file needs a fresh session
  before a deploy; an expired one stops the run before any change (`SMOKE_ACCOUNT`).

### Rollback (PROPOSAL 4.6; Andy 2026-10-27)

- **Nothing or only additive migrations:** automatic, as on lolly.tools, after a failed smoke or watch, or from
  `ExecStopPost` after a stopped unit: the previous image (still pinned) plus a **new** ConfigMap at a generation above
  every existing one, through the same guarded patch, then the full smoke at that generation. Never `rollout undo`:
  Work's fence answers 503 for a lower generation. The database stays; the previous image runs beside additive files.
  Manual `rollback` does the same to the recorded previous build and refuses one that would lower a stored format.
- **Any other class:** the previous image alone is not a safe state, so automatic rollback is off. A failed smoke ends
  `MAINTENANCE_UNVERIFIED` (exit 3) with the phase `maintenance-unverified`, which holds every later run, and the result
  names the restore point. The rollback is **that backup plus the previous image**, in two halves:
  1. a person restores the backup into the database by the lolly.ing runbook (`lolly-private/production/preview/`),
     because a restore drops every write since the backup and the tool never restores the live database;
  2. `rollback --clear-hold` reads the ledger with a check Job and refuses `MAINTENANCE_NO_ROLLBACK` while it still holds
     any non-additive file of the live build's deploy (from its restore point and marker), or when the restore point
     names another previous image. Once the restore shows, it switches to the previous image at a higher generation,
     smokes and watches, and clears the maintenance records (`ROLLED_BACK`, reason `MANUAL_AFTER_RESTORE`).
  After a held cut-over there is no previous build: the same `rollback --clear-hold` reads the cut-over's reviewed plan
  from `plans/` (its sha256 must match the `PLANNED` record) and reverts the claim layout, old image and old key
  reference (`CONVERSION_REVERTED`). A forward fix that already contains the migration may follow instead with
  `deploy <fix> --clear-hold`, with no restore and no lost writes.
- `status` prints the restore point of the last migrating deploy as `backup`.

### Cut-over (PROPOSAL 4.8)

`plan <work sha>` requires qualified sources and a bound build, reads the live Deployment and prints the exact patch:
drop the `shell`, `pack` and `engine-pin` volumes and their mounts, set the instance image, set the config to generation
N, and point `LW_CATALOG_SIGNING_KEY` at lolly.ing's own Secret. It writes the plan to
`lolly-private/production/preview/plans/` and prints its sha256. The database row is read at apply; if it raised N, the
apply refuses and asks for a new plan.

`plan <sha> --apply PLAN --reviewed-plan-sha256 H` is applied once by the named owner with Andy present, after Andy has
created the second Secret. It always takes a fresh backup, runs the restore rehearsal when the profile configures one,
applies pending migrations of any class with the same restore point and marker as a deploy, then applies the reviewed
patch. A failed smoke after nothing or only additive migrations puts the claim layout, the old image and the old key
reference back, with a new ConfigMap at a higher generation (`CONVERSION_REVERTED`), and that catalog verifies. After
a non-additive migration the revert is off: `MAINTENANCE_UNVERIFIED`; recovery is a forward fix, or the restore by the
runbook followed by `rollback --clear-hold`, which reverts with this plan. Every revert attempt, including `ExecStopPost` after a failed read, re-reads the marker first.
Keep the old claims until two image deploys have passed.

### Retention (`gc`, decision 12)

- **Images:** the lolly.tools policy, by image ID. The live image, the newest previous ones in the Deployment's
  ReplicaSet history and the recorded previous build stay pinned. Only images this command imported
  (`lolly.tools/preview-pulled=true`) are removed, by their exact digest name.
- **Generation ConfigMaps:** of the ConfigMaps this command made, the live one, the newest `retainConfigMaps` and every
  one a retained ReplicaSet still names stay. Older ones are deleted with a UID precondition. ConfigMaps from the cohort
  runbooks are listed for Andy and never removed.
- **Claims:** a report only, as for lolly.tools.
- **Spool:** `gc --execute` deletes archives a refused or interrupted run left in the node's spool.
- The first lolly.ing `gc --execute` arms lolly.ing's own post-deploy retention (`retention-armed-lolly.ing`).

### What the lolly.ing path may change, and what it never touches

It may import and pin the instance image, create generation ConfigMaps, create its own check, classifier and migrate
Jobs and, before a migration or at the cut-over, one backup Job from the existing CronJob, run the restore rehearsal in
its own namespace when configured, and patch the target Deployment's image, config ConfigMap reference and annotations,
plus, once at the cut-over, which Secret its catalog signing key reference names. The Jobs it creates reference the
database Secret (and the backup Job the CronJob's own Secrets); the tool process itself never reads or changes a
Secret's value, a PVC, Postgres directly, the edge or DNS; never execs into a Pod; never restores the live database; and
never changes any `instance.json` field other than the generation.

## Before the first live run

- Apply the `check-target.py --site` change (decision 8). It also carries the cluster and namespace UIDs the command
  reads. Without it the command stops at `CHECK_TARGET_IDENTITY`.
- Run `selftest` (Python 3.13 at `/usr/bin/python3`, systemd 257, k3s crictl and ctr v2.2.7 were read on 2026-10-23).
- Run `status` and `plan <live sha>`, then the conversion with Andy present, then a `--drill-fail-smoke` deploy.

## Before the first lolly.ing run

The exact steps, with commands, are in the private runbook `lolly-private/production/preview/LOLLY-ING-PREVIEW-GRADE.md`.
In short:

- suse-lolly: environment `lolly-ing-signing` (no reviewer, deployments from `main` only) with secret
  `LOLLY_ING_CATALOG_SIGNING_KEY`, repository variable `LOLLY_ING_PUBLIC_KEY_JWK`, and `main` protected.
- lolly.ing's own key generated by Andy; its public half pinned in `ING_PUBLIC_KEY_JWK` by a reviewed lolly-work PR.
  Then re-lock with `make-tool-lock.py`.
- The second Secret, `lolly-ing-catalog-signing` (`ING_SIGNING_KEY_SECRET`), holding that key under
  `LW_CATALOG_SIGNING_KEY`, created in `lolly-private` by Andy.
- The smoke member created, with the `export.server` grant on `tool:qr-code`, and its session written to
  `/etc/lolly-preview/lolly.ing-smoke-session` (root, 0600). `lolly.ing.json` in the state directory names its `sub`;
  `rehearsal` may be `null`.
- The Postgres NetworkPolicy admitting the preview Job label (`app.kubernetes.io/component: preview-migrate`) in
  `lolly-private`, set up once by Andy: every deploy runs a read-only check Job against the database.
- Then `ship` (it builds and stops at `BUILT`), `status`, `plan <work sha>`, the cut-over with Andy present, and a
  `--drill-fail-smoke` deploy that must land on catalog 200 at a higher generation.
