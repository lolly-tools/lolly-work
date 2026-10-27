# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the lolly.ing preview deploy: the private suse-lolly build run.

A build is bound by its run ID: workflow path, event (workflow_dispatch),
repository and head repository, branch, head commit (the suse-lolly commit it
built) and success (R22 S6). Its manifest and archive are read only from that
run's own artifacts, never looked up by name across the repository. The only
write is the workflow dispatch. The signing environment has no reviewer (Andy,
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
