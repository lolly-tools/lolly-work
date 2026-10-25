# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the lolly.ing preview deploy: the private suse-lolly build run.

A build is bound by its run ID: workflow path, event (workflow_dispatch),
repository and head repository, branch, head commit (the suse-lolly commit it
built), success, the dispatcher, the anchored build code at that commit and
human approval of both signing requests in the public control repository.
The shared-account exception does not enforce identity separation. Its manifest and archive
are read only from that run's own artifacts, never looked up by name across the
repository. The only write is the workflow dispatch. Nothing here approves an
environment gate.
"""

from __future__ import annotations

import io
import re
import time
import zipfile

import preview_anchors as A
import preview_github as G
import preview_ing as I
import preview_approval as P
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
    """Pinned identities, with shared-account use requiring an explicit reviewed exception."""
    dispatcher, reviewers = A.ING_DISPATCH_IDENTITY, A.ING_REVIEWERS
    require(isinstance(dispatcher, str) and LOGIN.fullmatch(dispatcher) is not None, "AGENT_IDENTITY",
            "the agents' dispatch identity (ING_DISPATCH_IDENTITY, decision 3) is not pinned in the tool yet; nothing was changed")
    require(isinstance(reviewers, tuple) and bool(reviewers) and all(isinstance(r, str) and LOGIN.fullmatch(r) for r in reviewers),
            "AGENT_IDENTITY", "no lolly.ing reviewer (ING_REVIEWERS) is pinned in the tool yet; nothing was changed")
    require(A.ING_ALLOW_SAME_ACCOUNT_APPROVAL is True or
            (dispatcher not in reviewers and dispatcher not in A.ING_MAINTENANCE_APPROVERS), "AGENT_IDENTITY",
            "shared-account dispatch and approval need an explicit reviewed exception")
    return dispatcher, reviewers


def require_dispatch_identity(gh):
    """Require the pinned dispatcher before dispatch or binding; never approve a gate."""
    dispatcher, reviewers = identity_anchors()
    login = _login(gh.json("user"))
    require(login is not None, "AGENT_IDENTITY", "gh api user gave no login; the tool cannot tell who it runs as")
    require(A.ING_ALLOW_SAME_ACCOUNT_APPROVAL is True or
            (login not in reviewers and login not in A.ING_MAINTENANCE_APPROVERS), "AGENT_IDENTITY",
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
    # Review 2026-10-25 C1 and H1: the run was dispatched by the agents' identity (never by a reviewer), its build code
    # is the anchored one, and a pinned reviewer approved lolly-ing-signing in it.
    dispatcher, _ = identity_anchors()
    actor = _login(run.get("actor"))
    require(actor == dispatcher, "DISPATCHER_IDENTITY", f"run {run['id']} was dispatched by {actor}, not the pinned dispatch identity "
            f"{dispatcher}; a reviewer never dispatches a build they could approve")
    triggering_actor = _login(run.get("triggering_actor"))
    require(triggering_actor == dispatcher, "DISPATCHER_IDENTITY", f"run {run['id']} was started or rerun by {triggering_actor}, "
            f"not the pinned dispatch identity {dispatcher}")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] == 1, "RUN_NOT_BOUND", "private reruns need a fresh dispatch")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "RUN_FAILED",
            f"run {run['id']} concluded {run.get('conclusion')!r}")
    check_build_code(gh, run["head_sha"])
    artifacts = _artifacts(gh, run["id"])
    manifest_item = artifacts[ANCHORS["manifestArtifact"]]
    data = gh.binary(f"repos/{ANCHORS['repository']}/actions/artifacts/{manifest_item['id']}/zip", limit=4 * 1024 * 1024)
    manifest = read_manifest(data)
    release = I.validate_manifest(manifest, run, wsha)
    P.bind_approvals(gh, manifest, run)
    final = release["approvals"]["final"]
    final_run = gh.json(f"repos/{A.ING_APPROVAL['repository']}/actions/runs/{int(final['run']['id'])}")
    verified = P.verify_approval(gh, final_run, final["request"])
    approver = verified["approver"]
    archive = artifacts[ANCHORS["archiveArtifact"]]
    require(type(archive.get("size_in_bytes")) is int and 0 < archive["size_in_bytes"] <= A.ING_ARCHIVE_MAX_BYTES + 64 * 1024 ** 2,
            "RECEIPT_MISSING", "the archive artifact has no plausible size")
    return {"release": release, "run": run["id"], "attempt": run["run_attempt"], "runCreatedAt": run.get("created_at"),
            "dispatcher": actor, "approver": approver, "publicApproval": verified,
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
            if exc.code not in ("RECEIPT_MISSING", "MANIFEST_SOURCE", "APPROVAL_EXPIRED"):
                raise
    raise Refusal("RUN_NOT_FOUND", f"no live, binding lolly.ing build of Work {wsha}" + (f" and suse-lolly {ssha}" if ssha else "")
                  + "; use ship")


def lolly_for(gh, wsha):
    """The Lolly commit a Work commit pins: engine-pin.json generatedFrom (the workflow's gate checks the gitlink too)."""
    pin = strict_json(gh.raw(f"repos/{ANCHORS['workRepository']}/contents/engine-pin.json?ref={wsha}").decode("utf-8"), "engine pin")
    lsha = pin.get("generatedFrom") if isinstance(pin, dict) else None
    require(isinstance(lsha, str) and SHA.fullmatch(lsha) is not None, "ENGINE_PIN", "Work's engine-pin.json names no Lolly commit")
    return lsha


def dispatch_ing(gh, lsha, wsha, ssha, maintenance=False):
    """Ask the private workflow for one build of exactly these three commits, on main."""
    body = {"ref": "refs/heads/" + ANCHORS["branch"], "inputs": {"LSHA": lsha, "WSHA": wsha, "SSHA": ssha}}
    if maintenance:
        body["inputs"]["MAINTENANCE"] = True
    gh.post(f"repos/{ANCHORS['repository']}/actions/workflows/{ANCHORS['buildWorkflowFile']}/dispatches", body)
    return body


def dispatch_pending_approvals(gh, run, sources, maintenance, dispatched):
    """Read private requests and dispatch public approval jobs. This never approves a gate."""
    dispatcher, _ = identity_anchors()
    require(G._same_repository(run, ANCHORS["repository"]) and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "main" and run.get("head_sha") == sources["suse"]
            and type(run.get("run_attempt")) is int and run["run_attempt"] == 1
            and _login(run.get("actor")) == dispatcher and _login(run.get("triggering_actor")) == dispatcher,
            "RUN_NOT_BOUND", "the private build waiting for approval has another identity, source or attempt")
    listing = gh.json(f"repos/{ANCHORS['repository']}/actions/runs/{run['id']}/artifacts", per_page=100)
    require(listing.get("total_count", len(listing.get("artifacts", []))) <= 100, "RECEIPT_MISSING", "too many private artifacts")
    for stage in ("source", "final"):
        name = f"lolly-ing-approval-{stage}-request-attempt-1"
        matches = [v for v in listing.get("artifacts", []) if isinstance(v, dict) and v.get("name") == name]
        if not matches:
            continue
        require(len(matches) == 1 and matches[0].get("expired") is False and type(matches[0].get("id")) is int,
                "APPROVAL_REQUEST", "the private signing request artifact is ambiguous or expired")
        data = gh.binary(f"repos/{ANCHORS['repository']}/actions/artifacts/{matches[0]['id']}/zip", limit=128 * 1024)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                require(archive.namelist() == ["request.json"] and archive.getinfo("request.json").file_size <= 65536,
                        "APPROVAL_REQUEST", "the private request artifact contains other files")
                request = strict_json(archive.read("request.json").decode("utf-8"), "private signing request")
        except (zipfile.BadZipFile, UnicodeDecodeError, KeyError) as exc:
            raise Refusal("APPROVAL_REQUEST", "the private request artifact is malformed") from exc
        P.validate_request(request, time.time())
        _, pin = I.ing_pin()
        require(request["stage"] == stage and request["sources"] == sources
                and request["privateRun"] == {"repository": ANCHORS["repository"], "id": str(run["id"]),
                                               "attempt": 1, "workflowSha": run["head_sha"]}
                and request["pinThumbprint"] == pin and request["buildBlobs"] == A.ING_BUILD_BLOBS
                and request["maintenance"] is maintenance and request["minSeq"] == "", "APPROVAL_REQUEST",
                "the private signing request differs from the dispatch intent")
        digest = P.request_digest(request)
        if stage in dispatched:
            require(dispatched[stage] == digest, "APPROVAL_REQUEST", "a signing request changed after public dispatch")
            continue
        check_build_code(gh, run["head_sha"])
        public = P._public_anchors()
        for environment in P._needed_environments(request):
            P.check_environment(gh, environment)
        title = P.approval_title(request)
        found = gh.json(f"repos/{public['repository']}/actions/workflows/{public['workflowFile']}/runs",
                        event="workflow_dispatch", branch="main", per_page=100)
        candidates = [r for r in found.get("workflow_runs", []) if isinstance(r, dict) and r.get("display_title") == title]
        require(len(candidates) <= 1, "APPROVAL_RUN", "more than one public gate names the signing request")
        # The private summary is intentionally printed only on the operator's Mac.
        emit("approval-request", stage=stage, digest=digest, privateRun=run["id"], request=request,
             note="Review the private request and matching public digest; Andy approves, agents never approve")
        if not candidates:
            head = G.branch_head(gh, public["repository"], "main")
            blob = gh.json(f"repos/{public['repository']}/contents/{public['workflowPath']}", ref=head)
            require(blob.get("type") == "file" and blob.get("path") == public["workflowPath"]
                    and blob.get("sha") == public["workflowBlob"], "BUILD_CODE_CHANGED", "the public approval workflow changed")
            gh.post(f"repos/{public['repository']}/actions/workflows/{public['workflowFile']}/dispatches",
                    {"ref": "refs/heads/main", "inputs": {"request_sha256": digest, "stage": stage,
                     "maintenance": bool(stage == "final" and maintenance)}})
            emit("approval-dispatched", stage=stage, digest=digest, repository=public["repository"],
                 workflow=public["workflowFile"], note="Awaiting Andy's approval in GitHub")
        else:
            candidate = candidates[0]
            require(candidate.get("path") == public["workflowPath"] and G._same_repository(candidate, public["repository"])
                    and _login(candidate.get("actor")) == dispatcher and _login(candidate.get("triggering_actor")) == dispatcher
                    and candidate.get("run_attempt") == 1, "APPROVAL_RUN", "the existing public gate does not bind")
            require(candidate.get("status") != "completed" or candidate.get("conclusion") == "success", "APPROVAL_MISSING",
                    "the matching public approval failed or was rejected; make a fresh private dispatch")
            emit("approval-waiting", stage=stage, run=candidate.get("id"), digest=digest)
        dispatched[stage] = digest


def find_new_ing_run(gh, ssha, known_ids, attempts=20, pause=6):
    for _ in range(attempts):
        fresh = [run for run in ing_runs(gh, ssha) if run["id"] not in known_ids]
        if len(fresh) == 1:
            return fresh[0]
        require(len(fresh) <= 1, "AMBIGUOUS_RUN", "more than one new lolly.ing build appeared; bind one with deploy")
        gh.sleep(pause)
    raise Refusal("RUN_NOT_FOUND", "the dispatched lolly.ing build did not appear")


def maintenance_approval(gh, bound):
    """The already authenticated final public run carries the maintenance approval, or none."""
    request = bound["release"]["approvals"]["final"]["request"]
    if not request["maintenance"]:
        return None
    name = ANCHORS["maintenanceEnvironment"]
    login = bound["publicApproval"]["environments"].get(name)
    if login in A.ING_MAINTENANCE_APPROVERS:
        return {"run": bound["publicApproval"]["run"], "approver": login, "environment": name}
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
