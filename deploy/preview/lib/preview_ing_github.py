# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the lolly.ing preview deploy: the private suse-lolly build run.

A build is bound by its run ID: workflow path, event (workflow_dispatch),
repository and head repository, branch, head commit (the suse-lolly commit it
built) and success (R22 S6). Its manifest and archive are read only from that
run's own artifacts, never looked up by name across the repository. The only
write is the workflow dispatch. Nothing here approves an environment gate.
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
    """The newest successful run that built this Work commit (and, when given, this suse-lolly commit) and still binds."""
    for run in ing_runs(gh, ssha):
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        try:
            return bind_ing_run(gh, run, wsha)
        except Refusal as exc:
            if exc.code not in ("RECEIPT_MISSING", "MANIFEST_SOURCE"):
                raise
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


def find_new_ing_run(gh, ssha, known_ids, attempts=20, pause=6):
    for _ in range(attempts):
        fresh = [run for run in ing_runs(gh, ssha) if run["id"] not in known_ids]
        if len(fresh) == 1:
            return fresh[0]
        require(len(fresh) <= 1, "AMBIGUOUS_RUN", "more than one new lolly.ing build appeared; bind one with deploy")
        gh.sleep(pause)
    raise Refusal("RUN_NOT_FOUND", "the dispatched lolly.ing build did not appear")


def maintenance_approval(gh, run_id):
    """Andy's approval of the maintenance environment in this same run (R20 S7), or None.
    The node refuses a pending maintenance migration without one."""
    approvals = gh.json(f"repos/{ANCHORS['repository']}/actions/runs/{int(run_id)}/approvals")
    require(isinstance(approvals, list), "GITHUB_FAILED", "the run's approvals are unreadable")
    for item in approvals:
        if not isinstance(item, dict) or item.get("state") != "approved":
            continue
        names = [env.get("name") for env in item.get("environments") or [] if isinstance(env, dict)]
        login = (item.get("user") or {}).get("login")
        if ANCHORS["maintenanceEnvironment"] in names and login in A.ING_MAINTENANCE_APPROVERS:
            return {"run": str(run_id), "approver": login, "environment": ANCHORS["maintenanceEnvironment"]}
    return None


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
