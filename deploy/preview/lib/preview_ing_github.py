# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the lolly.ing preview deploy: the private suse-lolly build run.

A build is bound by its run ID: workflow path, event (workflow_dispatch),
repository and head repository, branch, head commit (the suse-lolly commit it
built), success, the dispatcher (the agents' identity, never a reviewer), the
anchored build code at that commit and a pinned reviewer's approval of
lolly-ing-signing (R22 S6; review 2026-10-25 C1, H1). Its manifest and archive
are read only from that run's own artifacts, never looked up by name across the
repository. The only write is the workflow dispatch. Nothing here approves an
environment gate, and the tool refuses to run as a reviewer at all.
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
LOGIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}\Z")


# Identities (review 2026-10-25 C1) -------------------------------------------------
def _login(value):
    login = value.get("login") if isinstance(value, dict) else None
    return login if isinstance(login, str) and LOGIN.fullmatch(login) else None


def identity_anchors():
    """The dispatch identity and the reviewers: pinned, well formed and distinct. Refuses until both are set."""
    dispatcher, reviewers = A.ING_DISPATCH_IDENTITY, A.ING_REVIEWERS
    require(isinstance(dispatcher, str) and LOGIN.fullmatch(dispatcher) is not None, "AGENT_IDENTITY",
            "the agents' dispatch identity (ING_DISPATCH_IDENTITY, decision 3) is not pinned in the tool yet; nothing was changed")
    require(isinstance(reviewers, tuple) and bool(reviewers) and all(isinstance(r, str) and LOGIN.fullmatch(r) for r in reviewers),
            "AGENT_IDENTITY", "no lolly.ing reviewer (ING_REVIEWERS) is pinned in the tool yet; nothing was changed")
    require(dispatcher not in reviewers and dispatcher not in A.ING_MAINTENANCE_APPROVERS, "AGENT_IDENTITY",
            "the anchors name the dispatch identity as a reviewer or maintenance approver; one login never does both")
    return dispatcher, reviewers


def require_dispatch_identity(gh):
    """The `gh` this tool runs as is the dispatch identity and no reviewer, so the token that dispatches a build can
    never be the one that approves it. Runs before any dispatch or bind; status, rollback and gc need no run."""
    dispatcher, reviewers = identity_anchors()
    login = _login(gh.json("user"))
    require(login is not None, "AGENT_IDENTITY", "gh api user gave no login; the tool cannot tell who it runs as")
    require(login not in reviewers and login not in A.ING_MAINTENANCE_APPROVERS, "AGENT_IDENTITY",
            f"gh runs as {login}, a lolly.ing reviewer; a reviewer approves in GitHub from a device agents do not use and never "
            "runs this tool")
    require(login == dispatcher, "AGENT_IDENTITY", f"gh runs as {login}, not the pinned dispatch identity {dispatcher}")
    return login


def check_build_code(gh, head_sha):
    """The suse-lolly files that build and check the image, at the run's own commit, are the anchored blobs (review H1)."""
    require(isinstance(head_sha, str) and SHA.fullmatch(head_sha) is not None, "BAD_INPUT", "head sha")
    for path, expected in sorted(A.ING_BUILD_BLOBS.items()):
        try:
            entry = gh.json(f"repos/{ANCHORS['repository']}/contents/{path}", ref=head_sha)
        except Refusal as exc:
            if exc.code != "GITHUB_NOT_FOUND":
                raise
            raise Refusal("BUILD_CODE_CHANGED", f"suse-lolly {head_sha[:12]} has no {path}; the build code the tool anchors is gone") from exc
        found = entry.get("sha") if isinstance(entry, dict) else None
        require(isinstance(entry, dict) and entry.get("type") == "file" and entry.get("path") == path and found == expected,
                "BUILD_CODE_CHANGED", f"suse-lolly {head_sha[:12]} carries another {path} (blob {str(found)[:12]}; the tool anchors "
                f"{expected[:12]}); a changed build needs a lolly-work PR and a new tool lock")


def _approvals(gh, run_id):
    """(environment names, approver login) for every approved entry of the run."""
    approvals = gh.json(f"repos/{ANCHORS['repository']}/actions/runs/{int(run_id)}/approvals")
    require(isinstance(approvals, list), "GITHUB_FAILED", "the run's approvals are unreadable")
    found = []
    for item in approvals:
        if not isinstance(item, dict) or item.get("state") != "approved":
            continue
        names = [env.get("name") for env in item.get("environments") or [] if isinstance(env, dict)]
        found.append((names, _login(item.get("user"))))
    return found


def signing_approval(gh, run_id, dispatcher):
    """The approval of lolly-ing-signing in this run by a pinned reviewer other than the dispatcher (review C1).
    A run that passed because the environment had no reviewer rule carries no approval and is refused."""
    _, reviewers = identity_anchors()
    for names, login in _approvals(gh, run_id):
        if ANCHORS["signingEnvironment"] in names and login in reviewers and login != dispatcher:
            return login
    raise Refusal("APPROVAL_MISSING", f"run {run_id} carries no approval of {ANCHORS['signingEnvironment']} by a pinned reviewer "
                  f"({', '.join(reviewers)}) other than its dispatcher; the environment's reviewer rule may be missing")


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
    # Review 2026-10-25 C1 and H1: the run was dispatched by the agents' identity (never by a reviewer), its build code
    # is the anchored one, and a pinned reviewer approved lolly-ing-signing in it.
    dispatcher, _ = identity_anchors()
    actor = _login(run.get("triggering_actor"))
    require(actor == dispatcher, "DISPATCHER_IDENTITY", f"run {run['id']} was dispatched by {actor}, not the pinned dispatch identity "
            f"{dispatcher}; a reviewer never dispatches a build they could approve")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "RUN_FAILED",
            f"run {run['id']} concluded {run.get('conclusion')!r}")
    check_build_code(gh, run["head_sha"])
    approver = signing_approval(gh, run["id"], actor)
    artifacts = _artifacts(gh, run["id"])
    manifest_item = artifacts[ANCHORS["manifestArtifact"]]
    data = gh.binary(f"repos/{ANCHORS['repository']}/actions/artifacts/{manifest_item['id']}/zip", limit=4 * 1024 * 1024)
    release = I.validate_manifest(read_manifest(data), run, wsha)
    archive = artifacts[ANCHORS["archiveArtifact"]]
    require(type(archive.get("size_in_bytes")) is int and 0 < archive["size_in_bytes"] <= A.ING_ARCHIVE_MAX_BYTES + 64 * 1024 ** 2,
            "RECEIPT_MISSING", "the archive artifact has no plausible size")
    return {"release": release, "run": run["id"], "attempt": run["run_attempt"], "runCreatedAt": run.get("created_at"),
            "dispatcher": actor, "approver": approver,
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


def maintenance_approval(gh, run_id, dispatcher):
    """Andy's approval of the maintenance environment in this same run (R20 S7), or None.
    The node refuses a pending maintenance migration without one, and checks the approval itself (review M3)."""
    for names, login in _approvals(gh, run_id):
        if ANCHORS["maintenanceEnvironment"] in names and login in A.ING_MAINTENANCE_APPROVERS and login != dispatcher:
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
