# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the lolly.ing preview deploy: the private suse-lolly build run.

A build is bound by its run ID: workflow path, event (workflow_dispatch),
repository and head repository, branch, head commit (the suse-lolly commit it
built) and success (R22 S6). Its manifest and archive are read only from that
run's own artifacts, never looked up by name across the repository. The writes
are the workflow dispatch and deleting the build's artifacts once nothing reads
them (`clean_artifacts`, `artifact_plan`). The signing environment has no reviewer (Andy,
2026-10-27), so what lets a build happen is the qualification rule in
`qualify`: green full CI for the Work commit, and for the Lolly commit it pins
either its own full CI or a fast lane above one.
"""

from __future__ import annotations

import io
import re
import zipfile

import preview_anchors as A
import preview_github as G
import preview_ing as I
from preview_common import RUN_ID, SHA, Refusal, emit, require, strict_json

ANCHORS = A.ING
DEPENDENCY_FILES = re.compile(r"(^|/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Cargo\.lock|Cargo\.toml|"
                              r"requirements[^/]*\.txt|Dockerfile)$")
ARTIFACT_PREFIX = "lolly-ing-"  # every artifact the private workflow uploads
ARTIFACT_PAGES = 20  # 2,000 artifacts; suse-lolly keeps a few days' worth at most


def ing_runs(gh, ssha=None):
    """Dispatched runs of the private workflow on main, newest first; optionally for one suse-lolly head."""
    params = {"branch": ANCHORS["branch"], "event": "workflow_dispatch", "per_page": 30}
    if ssha:
        params["head_sha"] = ssha
    listing = gh.json(f"repos/{ANCHORS['repository']}/actions/workflows/{ANCHORS['buildWorkflowFile']}/runs", **params)
    runs = [run for run in listing.get("workflow_runs", []) if isinstance(run, dict) and isinstance(run.get("id"), int)]
    return sorted(runs, key=lambda run: run["id"], reverse=True)


def _artifacts(gh, run_id):
    listing = gh.json(f"repos/{ANCHORS['repository']}/actions/runs/{run_id}/artifacts", per_page=100)
    found = {}
    for item in listing.get("artifacts", []):
        if isinstance(item, dict) and item.get("name") in (ANCHORS["manifestArtifact"], ANCHORS["archiveArtifact"]):
            found.setdefault(item["name"], []).append(item)
    for name in (ANCHORS["manifestArtifact"], ANCHORS["archiveArtifact"]):
        items = found.get(name, [])
        require(len(items) == 1 and items[0].get("expired") is False and isinstance(items[0].get("id"), int),
                "RECEIPT_MISSING", f"run {run_id} has no single live {name} artifact")
    return {name: items[0] for name, items in found.items()}


def read_manifest(data):
    require(len(data) <= 4 * 1024 * 1024, "MANIFEST_INVALID", "the manifest artifact is too large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        require(archive.namelist() == [ANCHORS["manifestFile"]], "MANIFEST_INVALID", "the manifest artifact holds other files")
        require(archive.getinfo(ANCHORS["manifestFile"]).file_size <= 8 * 1024 * 1024, "MANIFEST_INVALID", "the manifest is too large")
        return strict_json(archive.read(ANCHORS["manifestFile"]).decode("utf-8"), "manifest")
    except (zipfile.BadZipFile, UnicodeDecodeError, KeyError) as exc:
        raise Refusal("MANIFEST_INVALID", "the manifest artifact is not a valid zip") from exc


def bind_ing_run(gh, run, wsha):
    """Bind one completed private run to this Work commit and return its release (R22 S6).

    Workflow path, event (workflow_dispatch), repository and head repository, branch main,
    head commit (the suse-lolly commit it built), success; then the run's own artifacts.
    """
    require(isinstance(run.get("id"), int) and RUN_ID.fullmatch(str(run["id"])) is not None, "RUN_NOT_BOUND", "run id is malformed")
    require(run.get("path") == ANCHORS["buildWorkflowPath"], "RUN_NOT_BOUND", "run is not the lolly.ing build workflow")
    require(run.get("event") in ANCHORS["buildEvents"], "RUN_NOT_BOUND", "run was not dispatched on main")
    require(G._same_repository(run, ANCHORS["repository"]), "RUN_NOT_BOUND", "run belongs to another repository or a fork")
    require(run.get("head_branch") == ANCHORS["branch"] and isinstance(run.get("head_sha"), str) and SHA.fullmatch(run["head_sha"]),
            "RUN_NOT_BOUND", "run is for another branch")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] >= 1, "RUN_NOT_BOUND", "run attempt is malformed")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "RUN_FAILED",
            f"run {run['id']} concluded {run.get('conclusion')!r}")
    artifacts = _artifacts(gh, run["id"])
    manifest_item = artifacts[ANCHORS["manifestArtifact"]]
    data = gh.binary(f"repos/{ANCHORS['repository']}/actions/artifacts/{manifest_item['id']}/zip", limit=4 * 1024 * 1024)
    release = I.validate_manifest(read_manifest(data), run, wsha)
    archive = artifacts[ANCHORS["archiveArtifact"]]
    require(type(archive.get("size_in_bytes")) is int and 0 < archive["size_in_bytes"] <= A.ING_ARCHIVE_MAX_BYTES + 64 * 1024 ** 2,
            "RECEIPT_MISSING", "the archive artifact has no plausible size")
    return {"release": release, "run": run["id"], "attempt": run["run_attempt"], "runCreatedAt": run.get("created_at"),
            "archiveArtifact": {"id": archive["id"], "bytes": archive["size_in_bytes"]},
            "expiresAt": min(str(manifest_item.get("expires_at")), str(archive.get("expires_at")))}


def latest_ing_run(gh, wsha, ssha=None):
    """The newest successful run that built this Work commit (and, when given, this suse-lolly commit) and still binds.
    A run with expired artifacts, another Work commit or a malformed manifest is skipped and reported (review L2)."""
    for run in ing_runs(gh, ssha):
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        try:
            return bind_ing_run(gh, run, wsha)
        except Refusal as exc:
            if exc.code not in ("RECEIPT_MISSING", "MANIFEST_SOURCE", "MANIFEST_INVALID"):
                raise
            if exc.code == "MANIFEST_INVALID":
                emit("build-skipped", run=run["id"], code=exc.code, reason=exc.message[:200])
    raise Refusal("RUN_NOT_FOUND", f"no live, binding lolly.ing build of Work {wsha}" + (f" and suse-lolly {ssha}" if ssha else "")
                  + "; use ship")


def lolly_for(gh, wsha):
    """The Lolly commit a Work commit pins: engine-pin.json generatedFrom (the workflow's gate checks the gitlink too)."""
    pin = strict_json(gh.raw(f"repos/{ANCHORS['workRepository']}/contents/engine-pin.json?ref={wsha}").decode("utf-8"), "engine pin")
    lsha = pin.get("generatedFrom") if isinstance(pin, dict) else None
    require(isinstance(lsha, str) and SHA.fullmatch(lsha) is not None, "ENGINE_PIN", "Work's engine-pin.json names no Lolly commit")
    return lsha


def dispatch_ing(gh, lsha, wsha, ssha):
    """Ask the private workflow for one build of exactly these three commits, on main."""
    body = {"ref": "refs/heads/" + ANCHORS["branch"], "inputs": {"LSHA": lsha, "WSHA": wsha, "SSHA": ssha}}
    gh.post(f"repos/{ANCHORS['repository']}/actions/workflows/{ANCHORS['buildWorkflowFile']}/dispatches", body)
    return body


def active_ing_runs(gh):
    """Private builds that are queued, running or waiting, for any source."""
    return [run for run in ing_runs(gh) if run.get("status") in G.ACTIVE_STATES]


def resume_or_dispatch(gh, lsha, wsha, ssha):
    """The run to wait for: an active build of exactly this Work commit and suse-lolly head, or a new dispatch.
    An active build of anything else refuses CANDIDATE_ACTIVE, so two ships never queue builds behind each other."""
    title = ANCHORS["buildRunTitle"].format(sha=wsha)
    active = active_ing_runs(gh)
    same = [run for run in active if run.get("display_title") == title and run.get("head_sha") == ssha]
    others = [run for run in active if run not in same]
    require(not others, "CANDIDATE_ACTIVE", f"another lolly.ing build is active (run {others[0]['id'] if others else ''}); "
            "wait for it to finish")
    if same:
        run = max(same, key=lambda r: r["id"])
        emit("build", run=run["id"], note="resuming the active private build of this Work commit; nothing new was dispatched")
        return run
    known = {run["id"] for run in ing_runs(gh, ssha)}
    dispatch_ing(gh, lsha, wsha, ssha)
    run = find_new_ing_run(gh, ssha, known)
    emit("dispatched", run=run["id"], lolly=lsha, work=wsha, suse=ssha,
         note="the build signs in lolly-ing-signing with no reviewer; nothing waits for an approval")
    return run


def qualify(gh, wsha, lsha):
    """Andy 2026-10-27: the Work commit needs its own successful full lolly-work CI push run on main, and the Lolly
    commit its engine pin names qualifies as a lolly.tools source does (its own full CI run, or a fast lane above one).
    suse-lolly's main head needs no CI of its own: the build validates, signs and boots its catalog, and the deploy
    smoke checks it again. Refuses CI_PENDING (retry later) or CI_NOT_GREEN."""
    try:
        work = G.green_ci_run(gh, A.ING_WORK_CI, wsha)
    except Refusal as exc:
        raise Refusal(exc.code, "lolly-work: " + exc.message) from exc
    try:
        lolly = G.qualified_ci(gh, A.ING_LOLLY_CI, lsha)
    except Refusal as exc:
        raise Refusal(exc.code, f"Lolly {lsha[:12]} (Work's engine pin): " + exc.message) from exc
    fields = {"workCiRun": work["id"], "lollyCiRun": lolly["id"]}
    if lolly["lane"] != "full":
        fields.update(lollyLane=lolly["lane"], lollyLaneBase=lolly["base"], lollyLaneRun=lolly["fastRun"])
    emit("qualified", work=wsha, lolly=lsha, **fields)
    return fields


def find_new_ing_run(gh, ssha, known_ids, attempts=20, pause=6):
    for _ in range(attempts):
        fresh = [run for run in ing_runs(gh, ssha) if run["id"] not in known_ids]
        if len(fresh) == 1:
            return fresh[0]
        require(len(fresh) <= 1, "AMBIGUOUS_RUN", "more than one new lolly.ing build appeared; bind one with deploy")
        gh.sleep(pause)
    raise Refusal("RUN_NOT_FOUND", "the dispatched lolly.ing build did not appear")


def change_list(gh, live, new):
    """First-party commits and dependency files changed since the live release, printed before the switch (R21 R3)."""
    report = []
    for name, repository in ANCHORS["sourceRepositories"].items():
        before, after = (live or {}).get(name), new.get(name)
        if not (isinstance(before, str) and SHA.fullmatch(before) and isinstance(after, str) and SHA.fullmatch(after)):
            report.append({"repository": repository, "note": "no live record to compare with"})
            continue
        if before == after:
            report.append({"repository": repository, "commits": 0})
            continue
        compare = gh.json(f"repos/{repository}/compare/{before}...{after}")
        commits = [c for c in compare.get("commits", []) if isinstance(c, dict)]
        files = [f.get("filename") for f in compare.get("files", []) if isinstance(f, dict) and isinstance(f.get("filename"), str)]
        report.append({"repository": repository, "status": compare.get("status"), "commits": compare.get("total_commits", len(commits)),
                       "first": [(c.get("sha") or "")[:12] + " " + ((c.get("commit") or {}).get("message") or "").splitlines()[0][:100]
                                 for c in commits[:20] if (c.get("commit") or {}).get("message")],
                       "dependencyFiles": sorted(f for f in files if DEPENDENCY_FILES.search(f))})
    for item in report:
        emit("change-list", **item)
    return report


# Artifact storage -------------------------------------------------------------------------
# suse-lolly is private, so GitHub bills its artifact storage by the GB-hour, and Andy holds it to a hard $5 a month
# (2026-11-04). The workflow's cleanup job deletes a run's intermediate artifacts as it ends, and all of a failed run's.
# What is left is the manifest and archive of a successful build, which only a deploy of that build reads: once a build
# is live its image is pinned on the node, and a rollback (automatic or manual) returns to the previous image pinned
# there and never fetches an archive again. Until a build is live, a retry still binds its artifacts (a refusal after
# the fetch, the backup window, a busy node), so they stay.
def own_run(run):
    """A run of the lolly.ing build workflow, dispatched on main in suse-lolly itself: the only runs whose artifacts this
    command deletes. Another workflow's, another branch's or event's, or a fork's run is never touched."""
    return (isinstance(run, dict) and isinstance(run.get("id"), int) and run.get("path") == ANCHORS["buildWorkflowPath"]
            and run.get("event") in ANCHORS["buildEvents"] and run.get("head_branch") == ANCHORS["branch"]
            and G._same_repository(run, ANCHORS["repository"]))


def live_run_of(status):
    """The private run that built the live image, from the node's records when they describe it; else None."""
    preview = status.get("preview") or {}
    run = preview.get("ci-run")
    if preview.get("image") == (status.get("deployment") or {}).get("image") and preview.get("phase") in A.SETTLED_PHASES \
            and isinstance(run, str) and RUN_ID.fullmatch(run) is not None:
        return int(run)
    return None


def artifact_plan(gh, live_run):
    """Which lolly.ing artifacts nothing reads again, from a page-by-page listing of the repository's artifacts.

    Deleted: every artifact of a finished build that did not succeed (nothing binds it), and of every successful build at
    or before live_run, the live build's run ID (its image and the previous ones are on the node). Kept: a running build's
    (its later jobs read them), a successful build newer than the live one (a candidate a retry still binds), any build
    when the live run is unknown, and anything of another workflow, branch, event or repository."""
    by_run = {}
    for page in range(1, ARTIFACT_PAGES + 1):
        listing = gh.json(f"repos/{ANCHORS['repository']}/actions/artifacts", per_page=100, page=page)
        items = listing.get("artifacts") if isinstance(listing, dict) else None
        items = [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []
        for item in items:
            run = item.get("workflow_run") if isinstance(item.get("workflow_run"), dict) else {}
            if (type(item.get("id")) is int and item.get("expired") is False and isinstance(item.get("name"), str)
                    and item["name"].startswith(ARTIFACT_PREFIX) and type(run.get("id")) is int):
                by_run.setdefault(run["id"], {})[item["id"]] = item
        if len(items) < 100:
            break
    plan = {"liveRun": live_run, "delete": [], "keep": []}
    for run_id in sorted(by_run):
        try:
            run = gh.json(f"repos/{ANCHORS['repository']}/actions/runs/{run_id}")
        except Refusal:
            run = None
        if not (own_run(run) and run["id"] == run_id):
            why = "unreadable" if run is None else "foreign"
        elif run.get("status") != "completed":
            why = "running"
        elif run.get("conclusion") != "success":
            why = "failed"
        elif isinstance(live_run, int) and run_id <= live_run:
            why = "live" if run_id == live_run else "superseded"
        else:
            why = "candidate"
        for item in by_run[run_id].values():
            size = item.get("size_in_bytes") if type(item.get("size_in_bytes")) is int else 0
            entry = {"run": run_id, "id": item["id"], "name": item["name"], "bytes": size, "why": why}
            plan["delete" if why in ("failed", "live", "superseded") else "keep"].append(entry)
    plan["deleteBytes"] = sum(entry["bytes"] for entry in plan["delete"])
    return plan


def delete_artifacts(gh, plan):
    """Delete what artifact_plan listed, one by one. One already gone (expired, or deleted by the workflow) counts as
    deleted; any other failure is reported and the rest still go."""
    deleted, failed = [], []
    for entry in plan["delete"]:
        try:
            gh.delete(f"repos/{ANCHORS['repository']}/actions/artifacts/{int(entry['id'])}")
            deleted.append(entry)
        except Refusal as exc:
            if exc.code == "GITHUB_NOT_FOUND":
                deleted.append(entry)
            else:
                failed.append(dict(entry, code=exc.code))
    return deleted, failed


def clean_artifacts(gh, live_run, when):
    """After a build is live: delete its artifacts and every older or failed build's. Best effort, after the result is
    recorded: a GitHub error here never changes the deploy's result, record or exit code."""
    try:
        plan = artifact_plan(gh, live_run)
        deleted, failed = delete_artifacts(gh, plan)
    except Exception as exc:  # noqa: BLE001 - storage cleanup must never turn a recorded result into a crash
        emit("artifacts", when=when, liveRun=live_run, code=getattr(exc, "code", type(exc).__name__),
             note="nothing more was deleted; the artifacts expire after one day, or gc deletes them")
        return None
    emit("artifacts", when=when, liveRun=live_run, deleted=len(deleted), deletedBytes=sum(e["bytes"] for e in deleted),
         runs=sorted({e["run"] for e in deleted}), failed=[{"id": e["id"], "code": e["code"]} for e in failed][:20],
         kept=len(plan["keep"]))
    return {"deleted": deleted, "failed": failed, "kept": plan["keep"]}
