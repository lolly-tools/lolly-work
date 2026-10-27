# SPDX-License-Identifier: MPL-2.0
"""Operator side of the lolly.ing preview deploy (PROPOSAL section 4).

Inputs are only the site and a lolly-work main commit (WSHA). Its engine pin
names the Lolly commit, and suse-lolly is built at its main head. The build comes
from the bound private run, identities from check-target.py --site lolly.ing, and
live state from the node. The archive is downloaded by run ID and streamed over the
existing SSH route; no registry credential is ever on the node.

Preview-grade route (Andy, 2026-10-27): a qualified build ships with no approval,
every migration class is applied after a verified backup, and a rollback after a
non-additive migration is that backup plus the previous image (the runbook).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path

import preview_anchors as A
import preview_github as G
import preview_ing as I
import preview_ing_github as IG
import preview_mac as M
from preview_common import HEX64, Refusal, compact, emit, require, sha256_hex, strict_json, utc_stamp, write_private_new
from preview_expect import format_lowering

UPLOAD_COMMAND = 'sudo -n python3 -I -c "import sys,base64;exec(base64.b64decode(sys.stdin.buffer.readline()))"'
PROFILE_KEYS = {"version", "site", "smoke", "watch", "build", "rolloutTimeoutSeconds", "capacity", "noDeployUtc", "gc",
                "retainPreviousImages", "retainConfigMaps", "rehearsal"}
CHUNK = 1024 * 1024


def refuse_unpinned():
    """Every lolly.ing command refuses until the tool pins lolly.ing's own key (PROPOSAL 4.7)."""
    I.ing_pin()


def load_ing_profile(state_dir):
    """Pages, thresholds and the smoke account's identifier only. Identities and anchors are elsewhere."""
    path = Path(state_dir) / "lolly.ing.json"
    require(path.is_file() and not path.is_symlink(), "PROFILE_INVALID", "lolly.ing.json is missing from the state dir")
    require(not (path.stat().st_mode & 0o022), "PROFILE_INVALID", "the profile must not be group or world writable")
    profile = strict_json(path.read_text(), "profile")
    require(isinstance(profile, dict) and set(profile) == PROFILE_KEYS and profile["version"] == 1 and profile["site"] == "lolly.ing",
            "PROFILE_INVALID", "profile fields do not match version 1 of the lolly.ing profile")
    smoke = profile["smoke"]
    require(isinstance(smoke, dict) and set(smoke) == {"account", "packAssetPath", "pages", "memoryFraction"}
            and isinstance(smoke["account"], dict) and set(smoke["account"]) == {"sub"} and isinstance(smoke["account"]["sub"], str)
            and 0 < len(smoke["account"]["sub"]) <= 200 and isinstance(smoke["packAssetPath"], str)
            and re.fullmatch(r"/catalog/[A-Za-z0-9._/-]{1,300}", smoke["packAssetPath"]) is not None
            and isinstance(smoke["pages"], list) and len(smoke["pages"]) <= 12
            and all(isinstance(p, str) and re.fullmatch(r"/[A-Za-z0-9._/-]{0,300}", p) for p in smoke["pages"])
            and type(smoke["memoryFraction"]) in (int, float) and 0.1 <= smoke["memoryFraction"] <= 1.0, "PROFILE_INVALID", "smoke")
    watch, build = profile["watch"], profile["build"]
    require(isinstance(watch, dict) and set(watch) == {"minutes", "intervalSeconds", "failures"}
            and 0 <= watch["minutes"] <= A.MAX_WATCH_MINUTES, "PROFILE_INVALID", "watch")
    require(isinstance(build, dict) and set(build) == {"pollSeconds", "timeoutMinutes"}, "PROFILE_INVALID", "build")
    require(type(profile["rolloutTimeoutSeconds"]) is int and 30 <= profile["rolloutTimeoutSeconds"] <= A.MAX_ROLLOUT_SECONDS,
            "PROFILE_INVALID", "rolloutTimeoutSeconds")
    capacity = profile["capacity"]
    require(isinstance(capacity, dict) and set(capacity) == {"minFreeAboveReserveBytes", "archiveFactor"}
            and type(capacity["archiveFactor"]) is int and 1 <= capacity["archiveFactor"] <= 10, "PROFILE_INVALID", "capacity")
    window = profile["noDeployUtc"]
    require(isinstance(window, list) and len(window) == 2 and all(isinstance(t, str) and re.fullmatch(r"[0-2][0-9]:[0-5][0-9]", t)
                                                                   for t in window), "PROFILE_INVALID", "noDeployUtc")
    require(isinstance(profile["gc"], dict) and set(profile["gc"]) == {"legacyClaims"}, "PROFILE_INVALID", "gc")
    rehearsal = profile["rehearsal"]
    # null: no restore rehearsal before a migration (the preview-grade default); the verified backup still comes first.
    require(rehearsal is None or (isinstance(rehearsal, dict) and set(rehearsal) == {"storageHost", "storageAddress"}
            and isinstance(rehearsal["storageHost"], str) and re.fullmatch(r"[a-z0-9.-]{4,253}", rehearsal["storageHost"])
            and isinstance(rehearsal["storageAddress"], str) and re.fullmatch(r"[0-9a-f.:]{3,45}", rehearsal["storageAddress"])),
            "PROFILE_INVALID", "rehearsal: null, or the backup store's host name and public address")
    require(type(profile["retainPreviousImages"]) is int and 1 <= profile["retainPreviousImages"] <= 10
            and type(profile["retainConfigMaps"]) is int and 1 <= profile["retainConfigMaps"] <= 20, "PROFILE_INVALID", "retention")
    profile["_sha256"] = sha256_hex(path.read_bytes())
    return profile


class IngContext(M.Context):
    def __init__(self, args, gh=None, opener=None):
        super().__init__(args, gh=gh, opener=opener)
        self.pin, self.thumbprint = I.ing_pin()
        self.expect_migrations = True

    def request(self, kind, deploy_id, need_bytes=None, **extra):
        profile, anchors, identity = self.profile, self.anchors, self.identity
        target = {"version": 1,
                  "transport": {"type": "local", "kubectl": [identity["k3s"], "kubectl"], "kubeconfig": identity["kubeconfig"],
                                "context": identity["context"]},
                  "clusterUID": identity["clusterUID"], "node": {"name": identity["nodeName"], "uid": identity["nodeUID"]},
                  "components": {anchors["component"]: {
                      "namespace": anchors["namespace"], "namespaceUID": identity["namespaceUID"],
                      "deployment": anchors["deployment"], "deploymentUID": identity["deploymentUID"],
                      "container": anchors["container"], "requiredLabels": anchors["requiredLabels"]}}}
        smoke, watch = profile["smoke"], profile["watch"]
        request = {"version": 1, "kind": kind, "site": self.site, "deployId": deploy_id, "tool": self.tool_hash,
                   "target": target, "k3s": identity["k3s"], "databaseSecret": identity["databaseSecret"],
                   "drillFailSmoke": bool(getattr(self.args, "drill_fail_smoke", False)),
                   "clearHold": bool(getattr(self.args, "clear_hold", False)), "liveSource": None,
                   "smoke": {"sub": smoke["account"]["sub"], "packAssetPath": smoke["packAssetPath"], "pages": list(smoke["pages"])},
                   "rehearsal": dict(profile["rehearsal"]) if profile["rehearsal"] else None,
                   "limits": {"rolloutTimeoutSeconds": profile["rolloutTimeoutSeconds"], "watchMinutes": watch["minutes"],
                              "watchIntervalSeconds": watch["intervalSeconds"], "watchFailures": watch["failures"],
                              "memoryFraction": smoke["memoryFraction"], "edgeAddress": identity["edgeAddress"],
                              "needBytes": int(need_bytes if need_bytes is not None else profile["capacity"]["minFreeAboveReserveBytes"]),
                              "retainPreviousImages": profile["retainPreviousImages"], "retainConfigMaps": profile["retainConfigMaps"],
                              "noDeployUtc": list(profile["noDeployUtc"])}}
        request.update(extra)
        return request

    def need_bytes(self, release):
        capacity = self.profile["capacity"]
        return max(int(capacity["minFreeAboveReserveBytes"]), int(capacity["archiveFactor"]) * release["archive"]["bytes"])

    def worst_case_seconds(self, kind):
        """How long a lolly.ing run can last on the node (review L2). A migrating deploy adds the backup, the classifier,
        the migrate Job and, when the profile configures one, the restore rehearsal. The cut-over always takes a backup."""
        rollout, watch = self.profile["rolloutTimeoutSeconds"], self.profile["watch"]["minutes"] * 60
        switch = rollout + A.SMOKE_BUDGET_SECONDS + A.JOB_TIMEOUT_SECONDS + watch
        rollback = A.JOB_TIMEOUT_SECONDS + rollout + A.SMOKE_BUDGET_SECONDS + A.JOB_TIMEOUT_SECONDS
        migration = A.ING_MIGRATION_SECONDS - (0 if self.profile.get("rehearsal") else A.REHEARSAL_TIMEOUT_SECONDS)
        intake = A.ING_IMPORT_TIMEOUT_SECONDS + A.JOB_TIMEOUT_SECONDS
        return {"deploy": intake + (migration if self.expect_migrations else 0) + switch + rollback + A.RETENTION_AFTER_DEPLOY_SECONDS + 300,
                "rollback": rollback + watch + 300,
                "convert": intake + migration + switch + rollback + 300,
                "gc": A.GC_BUDGET_SECONDS}[kind]


# Archive transport (PROPOSAL 4.3 step 3; decision 16) -------------------------------------
def stream_archive(context, bound, release, sha):
    """Download the archive artifact by run ID and stream it to the node's root-only spool."""
    anchors, artifact = context.anchors, bound["archiveArtifact"]
    spool = context.state_dir / "spool"
    spool.mkdir(mode=0o700, exist_ok=True)
    os.chmod(spool, 0o700)
    local = spool / f"{bound['run']}-{artifact['id']}.zip"
    if local.exists() or local.is_symlink():
        local.unlink()
    emit("archive", note="downloading the archive artifact by run ID", run=bound["run"], bytes=artifact["bytes"])
    context.gh.download(f"repos/{anchors['repository']}/actions/artifacts/{artifact['id']}/zip", str(local),
                        limit=A.ING_ARCHIVE_MAX_BYTES + 64 * 1024 ** 2)
    try:
        with zipfile.ZipFile(local) as archive:
            member = release["archive"]["name"]
            require(archive.namelist() == [member], "ARCHIVE_INVALID", "the archive artifact holds other files")
            require(archive.getinfo(member).file_size == release["archive"]["bytes"], "ARCHIVE_MISMATCH",
                    "the archive size differs from the manifest")
            header = {"deployId": context.deploy_id("upload", sha), "sha256": release["archive"]["sha256"],
                      "bytes": release["archive"]["bytes"]}
            source = (context.root / "deploy" / "preview" / "node" / "bootstrap.py").read_text()
            encoded = base64.b64encode(json.dumps(header).encode()).decode()
            program = source + f"\nupload(json.loads(base64.b64decode({encoded!r}).decode()))\n"
            route = context.identity
            argv = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=12", "-oStrictHostKeyChecking=yes",
                    "-oUserKnownHostsFile=" + route["knownHostsFile"], "-oServerAliveInterval=15", "-oServerAliveCountMax=4",
                    "-J", route["jump"], route["host"], UPLOAD_COMMAND]
            digest, sent = hashlib.sha256(), 0
            try:
                process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            except OSError as exc:
                raise Refusal("NODE_UNREACHABLE", "ssh did not start") from exc
            try:
                process.stdin.write(base64.b64encode(program.encode()) + b"\n")
                with archive.open(member) as stream:
                    while True:
                        chunk = stream.read(CHUNK)
                        if not chunk:
                            break
                        digest.update(chunk)
                        process.stdin.write(chunk)
                        sent += len(chunk)
                        if sent % (256 * CHUNK) < CHUNK:
                            emit("archive", sentBytes=sent, totalBytes=release["archive"]["bytes"])
                process.stdin.close()
            except BrokenPipeError:
                pass  # the node refused early; its reply says why
            reply_text = process.stdout.read(65536).decode("utf-8", "replace")
            process.stdout.close()
            code = process.wait(timeout=600)
    finally:
        local.unlink(missing_ok=True)
    lines = reply_text.strip().splitlines()
    require(lines, "NODE_UNREACHABLE", f"the node gave no answer to the upload (ssh exited {code})")
    reply = strict_json(lines[-1], "upload reply")
    if reply.get("result") == "REFUSED":
        raise Refusal(reply.get("code", "UPLOAD_REFUSED"), reply.get("reason", "the node refused the archive"))
    require(reply.get("result") in ("UPLOADED", "ALREADY_UPLOADED") and reply.get("sha256") == release["archive"]["sha256"],
            "UPLOAD_FAILED", "the node did not confirm the archive")
    if reply["result"] == "UPLOADED":
        require(digest.hexdigest() == release["archive"]["sha256"], "ARCHIVE_MISMATCH", "the downloaded archive differs from the manifest")
    emit("archive", result=reply["result"], sha256=release["archive"]["sha256"])


def intake(context, bound, release, sha):
    """Make sure the node has the archive or the image, with room for both, before the unit starts."""
    found = context.read("intake", release=release)
    if found["imagePresent"] or found["spoolPresent"]:
        return
    need = context.need_bytes(release)
    require(found["aboveReserve"] >= need, "LOW_CAPACITY", f"{found['aboveReserve'] // 2 ** 20} MiB above the image-GC reserve, "
            f"{need // 2 ** 20} MiB needed; run gc")
    stream_archive(context, bound, release, sha)


# Commands --------------------------------------------------------------------------------
def _live(context):
    status = context.read("status")
    require(status.get("unit") not in M.BUSY, "LOCK_HELD", "a preview run is active on the node; wait or run status --follow")
    M._phase_hold(context, status.get("preview", {}))
    return status


def _settled_records(status):
    preview = status.get("preview", {})
    require(preview.get("image") == status["deployment"]["image"] and preview.get("phase") in A.SETTLED_PHASES, "RECORDS_STALE",
            f"the preview records do not describe the live image (phase {preview.get('phase')}); inspect with status")
    return preview


def _json(text):
    try:
        return strict_json(text, "annotation") if text else None
    except Refusal:
        return None


WORK_ANCHORS = {"repository": A.ING["workRepository"], "branch": "main"}


def cmd_deploy(context, wsha, dispatch):
    """Deploy one Work main commit. ship dispatches the private build of (its Lolly pin, it, suse-lolly's main head).

    Before the cut-over, ship only builds (BUILT): the cut-over is the reviewed plan, applied once with Andy present."""
    anchors, gh = context.anchors, context.gh
    status = _live(context)
    converted = status["deployment"]["converted"]
    require(converted or dispatch, "NOT_CONVERTED", "lolly.ing still mounts the shell and pack claims; build with ship, then "
            "review and apply its one-time cut-over plan")
    if converted:
        require(status["smokeSession"] == "present", "SMOKE_ACCOUNT", "the smoke account's session on the node: " + status["smokeSession"])
    preview = _settled_records(status) if converted else {}
    G.require_on_main(gh, WORK_ANCHORS, wsha)
    lsha = IG.lolly_for(gh, wsha)
    ssha = G.branch_head(gh, anchors["repository"], anchors["branch"]) if dispatch else None
    if dispatch and converted:
        live = _json(preview.get("expect")) or {}
        if (preview.get("phase") == "accepted" and preview.get("source") == wsha and live.get("suse") == ssha
                and live.get("lolly") == lsha):
            emit("done", result="ALREADY_LIVE", image=status["deployment"]["image"], source=wsha)
            context.record("ship", "ALREADY_LIVE", sha=wsha, image=status["deployment"]["image"])
            return 0
    qualified = None
    if dispatch:
        qualified = IG.qualify(gh, wsha, lsha)  # Andy 2026-10-27: green Work CI, and a qualified Lolly source
        try:
            bound = IG.latest_ing_run(gh, wsha, ssha)
            emit("build", note="reusing a bound lolly.ing build of this Work commit and suse-lolly's main head", run=bound["run"])
        except Refusal as exc:
            if exc.code != "RUN_NOT_FOUND":
                raise
            if converted:
                context.backup_window("deploy")  # never start a build whose deploy could reach the backup window
            run = IG.resume_or_dispatch(gh, lsha, wsha, ssha)
            build = context.profile["build"]
            run = G.wait_for_run(gh, anchors, run["id"], build["pollSeconds"], build["timeoutMinutes"])
            bound = IG.bind_ing_run(gh, run, wsha)
    else:
        bound = IG.latest_ing_run(gh, wsha)
    release = bound["release"]
    require(G.contains(gh, anchors["repository"], release["suse"], G.branch_head(gh, anchors["repository"], anchors["branch"]))
            and G.contains(gh, A.ING["lollyRepository"], release["lolly"], G.branch_head(gh, A.ING["lollyRepository"], "main")),
            "NOT_ON_MAIN", "the build's suse-lolly or Lolly commit is not on its main")
    if not converted:
        emit("done", result="BUILT", source=wsha, image=release["image"], run=bound["run"],
             note="nothing deployed; run plan <work sha> and apply its reviewed cut-over patch with Andy present")
        context.record("ship", "BUILT", sha=wsha, image=release["image"], ciRun=bound["run"], **qualified)
        return 0
    if release["image"] == status["deployment"]["image"]:
        require(preview.get("phase") == "accepted", "RECORDS_STALE", "this build is live but its phase is " + str(preview.get("phase")))
        emit("done", result="ALREADY_LIVE", image=release["image"], source=wsha)
        context.record("ship" if dispatch else "deploy", "ALREADY_LIVE", sha=wsha, image=release["image"])
        return 0
    qualified = qualified or IG.qualify(gh, wsha, lsha)  # deploy: the same rule, once there is something to change
    live_expect = _json(preview.get("expect")) or {}
    IG.change_list(gh, {name: live_expect.get(name) for name in ("suse", "lolly")} | {"work": live_expect.get("source")},
                   {"suse": release["suse"], "work": release["source"], "lolly": release["lolly"]})
    context.expect_migrations = preview.get("migration-set") != I.migration_set(release["migrations"])
    context.backup_window("deploy")
    context.check_target()  # once, before the first write to the node (the archive upload)
    intake(context, bound, release, wsha)
    request = context.request("deploy", context.deploy_id("deploy", wsha), need_bytes=context.need_bytes(release),
                              release=release)
    request["liveSource"] = preview.get("source")
    result = context.start_and_follow(request)
    return M._finish(context, "ship" if dispatch else "deploy", result, sha=wsha, ciRun=bound["run"],
                     backup=(result.get("backup") or {}).get("record"), **qualified)


def cmd_rollback(context):
    status = _live(context)
    preview = status.get("preview", {})
    require(preview.get("maintenance") != "true" and not _json(preview.get("maintenance-applied")), "MAINTENANCE_NO_ROLLBACK",
            "the live build ran a non-additive migration, so the previous image alone is not a safe state. Roll back by "
            "restoring the backup in status's `backup` record together with that image (the lolly.ing runbook), or deploy "
            "a forward fix with --clear-hold")
    previous = _json(preview.get("previous"))
    require(isinstance(previous, dict) and previous.get("source") and previous.get("image"), "NO_PREVIOUS",
            "no recorded previous build; deploy a build instead")
    lowering = format_lowering(_json(preview.get("formats")), previous.get("formats"))
    require(not lowering, "FORMAT_LOWERING", "the rollback would lower stored formats (" + ", ".join(lowering) + "); roll forward")
    context.backup_window("rollback")
    context.check_target()
    request = context.request("rollback", context.deploy_id("rollback", previous["source"]), rollbackTo=previous["source"])
    result = context.start_and_follow(request)
    return M._finish(context, "rollback", result, sha=previous["source"])


def cmd_status(context, follow=None):
    if follow:
        require(re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}", follow) is not None, "BAD_ARGUMENTS", "deploy id")
        return M._finish(context, "status --follow", context.follow(follow))
    status = context.read("status")
    preview = status.get("preview", {})
    phase = preview.get("phase") or "none"
    expect = _json(preview.get("expect")) or {}
    emit("status", phase=phase if phase == "accepted" else phase.upper(), source=preview.get("source"),
         suse=expect.get("suse"), lolly=expect.get("lolly"),
         image=status["deployment"]["image"], config=status["deployment"]["config"], generation=preview.get("generation"),
         converted=status["deployment"]["converted"], ready=status["deployment"]["ready"], unit=status.get("unit"),
         pods=status.get("pods"), smokeSession=status.get("smokeSession"), maintenance=preview.get("maintenance") == "true",
         maintenanceApplied=_json(preview.get("maintenance-applied")), backup=_json(preview.get("backup")),
         deployId=preview.get("deploy-id"), reason=preview.get("reason"))
    return 0


def _plan_path(context, deploy_id):
    directory = context.state_dir / "plans"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory / (deploy_id + ".json")


def cmd_plan(context, sha):
    """PROPOSAL 4.8 plan mode for one Work commit: print the exact cut-over patch, applied once by the owner with Andy present."""
    anchors, gh = context.anchors, context.gh
    to_secret = I.signing_secret()
    G.require_on_main(gh, WORK_ANCHORS, sha)
    live = context.read("plan")
    require(not live["converted"], "ALREADY_CONVERTED", "lolly.ing already runs the instance image")
    IG.qualify(gh, sha, IG.lolly_for(gh, sha))
    bound = IG.latest_ing_run(gh, sha)
    release = bound["release"]
    value = live["deployment"]
    index = [c["name"] for c in value["spec"]["template"]["spec"]["containers"]].index(anchors["container"])
    configs = live["configs"]
    generation = I.next_generation(configs[live["liveConfig"]], list(configs.values()), 0, release["seq"])
    deploy_id = context.deploy_id("cutover", sha)
    to_config = I.config_name(generation, sha)
    annotations = {A.ANNOTATION_PREFIX + name: text for name, text in {
        "phase": "converting", "deploy-id": deploy_id, "source": sha, "image": release["image"], "ci-run": str(bound["run"]),
        "tool": context.tool_hash, "formats": compact(release["formats"]), "expect": compact(I.expect_of(release)),
        "config": to_config, "generation": str(generation), "layout": "instance-image", "deploys": "0",
        "migration-set": I.migration_set(release["migrations"]), "previous": None, "reason": None, "maintenance": None, "updated": utc_stamp()}.items()}
    cutover = I.cutover_plan(value, index, release["image"], to_config, annotations, to_secret)
    plan = {"version": 1, "kind": "lolly-ing-cutover", "site": "lolly.ing", "source": sha, "deployId": deploy_id,
            "tool": context.tool_hash, "createdAt": utc_stamp(), "run": bound["run"], "release": release, "generation": generation,
            "toConfig": to_config, "annotations": annotations, "cutover": cutover, "liveSource": None}
    text = json.dumps(plan, indent=2, sort_keys=True) + "\n"
    path = _plan_path(context, deploy_id)
    write_private_new(path, text)
    digest = sha256_hex(text.encode())
    emit("cutover-plan", path=str(path), sha256=digest, image=release["image"], generation=generation, config=to_config,
         signingKeySecret=cutover["signingKeySecret"], toSigningKeySecret=to_secret,
         removes=[v["name"] for v in cutover["volumes"]], patch=cutover["patch"],
         migrations=[m["name"] for m in release["migrations"]],
         note="the database generation is read at apply; if it raised N, apply refuses and asks for a new plan. Pending "
              "migrations of any class are applied at apply, after a verified backup")
    emit("for-andy", steps=[f"Secret {to_secret} must exist in {anchors['namespace']} holding lolly.ing's own key under "
                            f"{A.ING['signingKeyEnv']}, the same key name as the live Secret {cutover['signingKeySecret']}. Never "
                            "edit the live Secret: the patch switches the server's reference and a revert switches it back. The "
                            "command never reads or writes a Secret's value.",
                            "Review the patch above.",
                            "A non-additive migration at the cut-over turns the automatic revert off: a failed smoke then holds "
                            "(MAINTENANCE_UNVERIFIED) and recovery is the backup the run took, with the old layout (runbook).",
                            f"/usr/bin/python3 launch.py lolly.ing plan {sha} --apply {path} --reviewed-plan-sha256 {digest}"])
    context.record("plan", "PLANNED", sha=sha, planSha256=digest, generation=generation)
    return 0


def cmd_plan_apply(context, sha, plan_path, reviewed):
    anchors, gh = context.anchors, context.gh
    path = Path(plan_path)
    require(path.is_file() and not path.is_symlink() and path.resolve().parent == (context.state_dir / "plans").resolve(),
            "PLAN_INVALID", "the plan must be a file in the state dir's plans folder")
    data = path.read_bytes()
    require(isinstance(reviewed, str) and HEX64.fullmatch(reviewed) is not None and sha256_hex(data) == reviewed,
            "PLAN_NOT_REVIEWED", "the plan file differs from the reviewed sha256")
    plan = strict_json(data.decode("utf-8"), "plan")
    require(isinstance(plan, dict) and plan.get("kind") == "lolly-ing-cutover" and plan.get("source") == sha
            and plan.get("tool") == context.tool_hash, "PLAN_INVALID", "the plan is for another commit or tool")
    require((plan.get("cutover") or {}).get("toSigningKeySecret") == I.signing_secret(), "PLAN_MISMATCH",
            "the plan names another signing Secret than the tool anchors; make and review a new plan")
    status = _live(context)
    require(not status["deployment"]["converted"], "ALREADY_CONVERTED", "lolly.ing already runs the instance image")
    run = gh.json(f"repos/{anchors['repository']}/actions/runs/{int(plan['run'])}")
    bound = IG.bind_ing_run(gh, run, sha)
    require(bound["release"] == plan["release"], "PLAN_MISMATCH", "the bound build no longer matches the plan")
    context.expect_migrations = True
    context.backup_window("convert")
    context.check_target()
    intake(context, bound, bound["release"], sha)
    request = context.request("convert", plan["deployId"], need_bytes=context.need_bytes(bound["release"]), release=plan["release"],
                              conversion=plan)
    result = context.start_and_follow(request)
    return M._finish(context, "plan --apply", result, sha=sha, backup=(result.get("backup") or {}).get("record"))


def cmd_gc(context, execute):
    """Report first. --execute removes only images this command imported and ConfigMaps it made; never claims."""
    report = context.read("gc", legacyClaims=context.profile["gc"]["legacyClaims"])
    emit("gc-images", keep=report["images"]["keep"], remove=report["images"]["remove"], removeBytes=report["images"]["removeBytes"],
         untouched=report["images"]["untouched"], retentionArmed=report["retentionArmed"])
    configs = report["configMaps"]
    emit("gc-configmaps", live=configs["live"], keep=configs["keep"], remove=[entry["name"] for entry in configs["remove"]],
         legacy=configs["legacy"], note="legacy ConfigMaps are listed only; Andy removes them")
    emit("gc-spool", archives=report["spool"], note="--execute deletes spooled archives; a later deploy uploads again")
    for image in report["images"].get("unusedForeign", []):
        emit("gc-foreign-image", id=image["id"], refs=image["refs"], sizeBytes=image["size"], pinnedRefs=image["pinnedRefs"],
             pinnedBy=image["pinnedBy"], referencedBy=image["referencedBy"], forAndy=M.foreign_commands(context, image),
             note="this command did not import it and never removes it; Andy decides")
    for claim in report["claims"]:
        emit("gc-claim", name=claim["name"], uid=claim["uid"], candidate=claim["candidate"], blockedBy=claim["blockedBy"],
             referencedBy=claim["referencedBy"], forAndy=M.claim_commands(context, claim) if claim["candidate"] else None)
    if not execute:
        context.record("gc", "GC_REPORT", remove=report["images"]["remove"])
        return 0
    require(any(row.get("result") == "GC_REPORT" and row.get("site") == "lolly.ing" for row in context.records()), "GC_REPORT_FIRST",
            "run gc without --execute first and read its report")
    request = context.request("gc", context.deploy_id("gc"))
    context.backup_window("gc")
    context.check_target()
    return M._finish(context, "gc --execute", context.start_and_follow(request))


def dispatch(context, args):
    if args.command == "ship":
        return cmd_deploy(context, args.sha, dispatch=True)
    if args.command == "deploy":
        return cmd_deploy(context, args.sha, dispatch=False)
    if args.command == "rollback":
        return cmd_rollback(context)
    if args.command == "status":
        return cmd_status(context, args.follow)
    if args.command == "gc":
        return cmd_gc(context, args.execute)
    if args.command == "plan":
        if args.apply:
            return cmd_plan_apply(context, args.sha, args.apply, args.reviewed_plan_sha256)
        return cmd_plan(context, args.sha)
    raise Refusal("NOT_FOR_LOLLY_ING", f"{args.command} is lolly.tools only: the unit's selftest covers both sites, and the "
                  "cut-over seeds lolly.ing's records")
