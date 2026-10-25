# SPDX-License-Identifier: MPL-2.0
"""Bind private signing requests to human approvals in the public control repository.

The node checks request consistency only. The Mac authenticates the public run
and its review history through GitHub before uploading a private image.
"""

from __future__ import annotations

import hashlib
import json
import re
import time

import preview_anchors as A
import preview_github as G
from preview_common import HEX64, SHA, Refusal, parse_utc, require

REQUEST_KEYS = {"version", "stage", "privateRun", "sources", "pinThumbprint", "buildBlobs", "migrationManifest",
                "maintenance", "minSeq", "artifactSha256", "nonce", "issuedAt", "expiresAt"}
REQUEST_PREFIX = "lolly.ing approval request v1\n"
MAX_REQUEST_SECONDS = 4 * 60 * 60
RUN_ID = re.compile(r"[1-9][0-9]{0,15}\Z")
KEY_ID = re.compile(r"[A-Za-z0-9_-]{43}\Z")
SAFE_PATH = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\Z")


def _hex(value, pattern=HEX64):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def validate_request(request, now=None):
    """Validate the portable, ASCII-only signing request. With now, also enforce its lifetime."""
    require(isinstance(request, dict) and set(request) == REQUEST_KEYS and type(request["version"]) is int
            and request["version"] == 1, "APPROVAL_REQUEST", "the signing request fields do not match version 1")
    require(request["stage"] in ("source", "final"), "APPROVAL_REQUEST", "unknown approval stage")
    run = request["privateRun"]
    require(isinstance(run, dict) and set(run) == {"repository", "id", "attempt", "workflowSha"}
            and run["repository"] == A.ING["repository"] and isinstance(run["id"], str)
            and RUN_ID.fullmatch(run["id"]) is not None and type(run["attempt"]) is int and run["attempt"] == 1
            and _hex(run["workflowSha"], SHA), "APPROVAL_REQUEST", "the private run or attempt is malformed")
    sources = request["sources"]
    require(isinstance(sources, dict) and set(sources) == {"lolly", "work", "suse"}
            and all(_hex(v, SHA) for v in sources.values()) and sources["suse"] == run["workflowSha"],
            "APPROVAL_REQUEST", "the request sources do not name the private workflow commit")
    require(isinstance(request["pinThumbprint"], str) and KEY_ID.fullmatch(request["pinThumbprint"]) is not None,
            "APPROVAL_REQUEST", "the signing pin is malformed")
    blobs = request["buildBlobs"]
    require(isinstance(blobs, dict) and 0 < len(blobs) <= 20 and all(isinstance(path, str)
            and len(path) <= 250 and SAFE_PATH.fullmatch(path) is not None and ".." not in path.split("/")
            and _hex(blob, SHA) for path, blob in blobs.items()), "APPROVAL_REQUEST", "build-code hashes are malformed")
    require(_hex(request["migrationManifest"]) and type(request["maintenance"]) is bool
            and isinstance(request["minSeq"], str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,15})?", request["minSeq"]) is not None
            and (not request["minSeq"] or int(request["minSeq"]) < 2 ** 53),
            "APPROVAL_REQUEST", "the migration manifest, maintenance choice or sequence floor is malformed")
    require((request["artifactSha256"] is None if request["stage"] == "source" else _hex(request["artifactSha256"]))
            and _hex(request["nonce"]), "APPROVAL_REQUEST", "the artifact hash or nonce is malformed")
    issued, expires = request["issuedAt"], request["expiresAt"]
    require(type(issued) is int and type(expires) is int and 0 < issued < expires < 2 ** 53
            and expires - issued <= MAX_REQUEST_SECONDS, "APPROVAL_REQUEST", "the request lifetime is malformed")
    if now is not None:
        require(issued <= now + 60 and now < expires, "APPROVAL_EXPIRED", "the signing request is not current")
    return request


def request_digest(request):
    validate_request(request)
    body = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256((REQUEST_PREFIX + body).encode("ascii")).hexdigest()


def approval_title(request):
    return f"lolly.ing approval {request['stage']} {request_digest(request)}"


def _public_anchors():
    anchors = A.ING_APPROVAL
    require(_hex(anchors.get("workflowBlob"), SHA), "APPROVAL_NOT_PINNED", "the public approval workflow is not pinned")
    return anchors


def check_environment(gh, environment):
    """Check the human gate rules, including the explicit temporary same-account exception."""
    anchors = _public_anchors()
    value = gh.json(f"repos/{anchors['repository']}/environments/{environment}")
    rules = [r for r in value.get("protection_rules", []) if isinstance(r, dict) and r.get("type") == "required_reviewers"]
    require(value.get("name") == environment and len(rules) == 1, "APPROVAL_RULES",
            f"{environment} has no single required-reviewer rule")
    rule = rules[0]
    reviewers = rule.get("reviewers") or []
    logins = [(r.get("reviewer") or {}).get("login") for r in reviewers if isinstance(r, dict) and r.get("type") == "User"]
    require(len(logins) == len(reviewers) and set(logins) == set(A.ING_REVIEWERS), "APPROVAL_RULES",
            f"{environment} does not require the pinned human reviewers")
    require(rule.get("prevent_self_review") is (not A.ING_ALLOW_SAME_ACCOUNT_APPROVAL)
            and value.get("can_admins_bypass") is False, "APPROVAL_RULES", f"{environment} has different self-review or bypass rules")
    require(value.get("deployment_branch_policy") == {"protected_branches": False, "custom_branch_policies": True},
            "APPROVAL_RULES", f"{environment} does not use selected deployment branches")
    policies = gh.json(f"repos/{anchors['repository']}/environments/{environment}/deployment-branch-policies", per_page=100)
    items = policies.get("branch_policies")
    require(policies.get("total_count") == 1 and isinstance(items, list) and len(items) == 1
            and isinstance(items[0], dict) and items[0].get("name") == "main" and items[0].get("type") == "branch", "APPROVAL_RULES",
            f"{environment} allows something other than the main branch")


def _needed_environments(request):
    names = [A.ING["signingEnvironment"]]
    if request["stage"] == "final" and request["maintenance"]:
        names.append(A.ING["maintenanceEnvironment"])
    return names


def _approvals(gh, run_id, request):
    anchors = _public_anchors()
    history = gh.json(f"repos/{anchors['repository']}/actions/runs/{int(run_id)}/approvals")
    require(isinstance(history, list), "APPROVAL_MISSING", "public approval history is unreadable")
    approved = {}
    for item in history:
        if not isinstance(item, dict) or item.get("state") != "approved":
            continue
        login = (item.get("user") or {}).get("login")
        if login not in A.ING_REVIEWERS:
            continue
        for env in item.get("environments") or []:
            if isinstance(env, dict) and env.get("name") in _needed_environments(request):
                approved[env["name"]] = login
    require(all(name in approved for name in _needed_environments(request)), "APPROVAL_MISSING",
            "the public run has no pinned human approval for every required environment")
    return approved


def verify_approval(gh, run, request):
    """Authenticate one public run before trusting its reference in a private build."""
    validate_request(request, time.time())
    anchors = _public_anchors()
    require(isinstance(run, dict) and type(run.get("id")) is int and RUN_ID.fullmatch(str(run["id"])) is not None
            and run.get("path") == anchors["workflowPath"] and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "main" and G._same_repository(run, anchors["repository"])
            and _hex(run.get("head_sha"), SHA), "APPROVAL_RUN", "the public run is not the anchored main workflow")
    require((run.get("actor") or {}).get("login") == A.ING_DISPATCH_IDENTITY
            and (run.get("triggering_actor") or {}).get("login") == A.ING_DISPATCH_IDENTITY,
            "DISPATCHER_IDENTITY", "the public approval run has another dispatcher")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] == 1, "APPROVAL_RUN", "approval reruns are refused")
    require(run.get("display_title") == approval_title(request), "APPROVAL_RUN", "the public run names another signing request")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "APPROVAL_MISSING",
            "the public approval run has not completed successfully")
    require(isinstance(run.get("created_at"), str) and isinstance(run.get("updated_at"), str), "APPROVAL_RUN",
            "the public approval run has no creation or update time")
    created, updated = parse_utc(run["created_at"]).timestamp(), parse_utc(run["updated_at"]).timestamp()
    require(request["issuedAt"] - 60 <= created <= request["expiresAt"] and created <= time.time() + 60
            and created <= updated <= request["expiresAt"], "APPROVAL_RUN", "the public run is outside the request lifetime")
    code = gh.json(f"repos/{anchors['repository']}/contents/{anchors['workflowPath']}", ref=run["head_sha"])
    require(isinstance(code, dict) and code.get("type") == "file" and code.get("path") == anchors["workflowPath"]
            and code.get("sha") == anchors["workflowBlob"], "BUILD_CODE_CHANGED", "the public approval workflow code changed")
    for environment in _needed_environments(request):
        check_environment(gh, environment)
    approvals = _approvals(gh, run["id"], request)
    validate_request(request, time.time())
    return {"run": str(run["id"]), "approver": approvals[A.ING["signingEnvironment"]], "environments": approvals}


def validate_release_approvals(release, private_run=None, now=None):
    """Pure request/release checks shared with the node; this does not authenticate public review history."""
    from preview_ing import migration_manifest

    approvals = release.get("approvals")
    require(isinstance(approvals, dict) and set(approvals) == {"source", "final"}, "APPROVAL_REQUEST",
            "the private build has no source and final approval references")
    expected_sources = {"work": release["source"], "lolly": release["lolly"], "suse": release["suse"]}
    for stage, item in approvals.items():
        require(isinstance(item, dict) and set(item) == {"request", "run"} and isinstance(item["run"], dict)
                and set(item["run"]) == {"id", "attempt"} and isinstance(item["run"]["id"], str)
                and RUN_ID.fullmatch(item["run"]["id"]) is not None and type(item["run"]["attempt"]) is int
                and item["run"]["attempt"] == 1, "APPROVAL_REQUEST", "a public approval reference is malformed")
        request = validate_request(item["request"], now)
        require(request["stage"] == stage and request["sources"] == expected_sources
                and request["privateRun"]["id"] == release["ciRun"] and request["pinThumbprint"] == release["keyId"]
                and request["buildBlobs"] == A.ING_BUILD_BLOBS
                and request["migrationManifest"] == migration_manifest(release["migrations"]).removeprefix("sha256:"), "APPROVAL_REQUEST",
                "the approval request does not describe this private build")
        if private_run is not None:
            require(request["privateRun"]["id"] == str(private_run["id"])
                    and request["privateRun"]["attempt"] == private_run["run_attempt"]
                    and request["privateRun"]["workflowSha"] == private_run["head_sha"], "APPROVAL_REQUEST",
                    "the request names another private run or attempt")
    source, final = (approvals[stage]["request"] for stage in ("source", "final"))
    excepted = {"stage", "nonce", "issuedAt", "expiresAt", "artifactSha256"}
    require({k: v for k, v in source.items() if k not in excepted} == {k: v for k, v in final.items() if k not in excepted}
            and source["nonce"] != final["nonce"] and source["issuedAt"] <= final["issuedAt"]
            and final["artifactSha256"] == release.get("frontendInputSha256")
            and approvals["source"]["run"]["id"] != approvals["final"]["run"]["id"], "APPROVAL_REQUEST",
            "the source and final approval requests are inconsistent")
    require(not final["minSeq"] or release["seq"] >= int(final["minSeq"]), "APPROVAL_REQUEST",
            "the signed catalog sequence is below the approved floor")
    return approvals


def bind_approvals(gh, manifest, private_run):
    """Authenticate both gate references only after the ordinary private manifest checks pass."""
    from preview_ing import validate_manifest

    release = validate_manifest(manifest, private_run, manifest["sources"]["work"])
    approvals = validate_release_approvals(release, private_run, time.time())
    for item in approvals.values():
        run = gh.json(f"repos/{_public_anchors()['repository']}/actions/runs/{int(item['run']['id'])}")
        require(str(run.get("id")) == item["run"]["id"], "APPROVAL_RUN", "GitHub returned another approval run")
        verify_approval(gh, run, item["request"])
    return approvals
