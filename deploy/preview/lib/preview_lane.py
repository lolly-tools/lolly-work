# SPDX-License-Identifier: MPL-2.0
"""Fast deploy lanes for lolly.tools: the Python port of lolly's scripts/deploy-lane.ts.

A lolly main commit normally ships only after its own full ci.yml push run passed (about 40 minutes).
A lane lets a narrow change ship sooner. The base is the newest first-parent ancestor whose full ci.yml
push run on main passed; every path that differs between the base and the source decides the lane; and
the lane's job in fast-lanes.yml must have passed on the source:

  docs  every change is under docs/ or is one of the /info pages kept outside it, apart from the policy
        files a release gate reads (full) and the card renderer build:web runs (web). Job "docs lane".
  web   every change is under docs/ or shells/web/, outside the exclusions below. Job "web lane".
  full  anything else: the source's own full CI run, as before.

A lane never overrides a full CI run that has already failed on the source. The rules here and in
lolly's TypeScript are tested against the same cases (tests/fixtures/deploy-lane-cases.json, a pinned
copy of lolly's tests/fixtures/deploy-lane/cases.json). Until lolly's build-at-merge change,
preview-web.yml also enforced the TypeScript copy from the base commit before it built. It now builds
each commit as soon as it reaches main and refuses only a completed CI failure, so for lolly.tools this
port decides, at deploy time (preview_mac.qualification), and a rule that drifts from the TypeScript is
caught by the shared cases, not by a second check. lolly.ing's private build gate still runs the
TypeScript copy for the Lolly commit its Work commit pins.

The tool reads the change from GitHub's tree objects, never from a label or a commit message. Only
anchors that carry "fastLaneWorkflowFile" use lanes: lolly.tools for its source, and lolly.ing for the
Lolly commit its Work commit pins (ING_LOLLY_CI), never for the Work commit itself.
"""

from __future__ import annotations

import re

from preview_common import SHA, Refusal, require

LANE_POLICY = "deploy-lane-v1"
LANE_JOBS = {"docs": "docs lane", "web": "web lane"}
MAX_BASE_DISTANCE = 50

DEPENDENCY_FILE = re.compile(r"(?:^|/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml"
                             r"|yarn\.lock|\.npmrc|\.pnpmfile\.c?js|Cargo\.toml|Cargo\.lock|rust-toolchain(?:\.toml)?"
                             r"|\.cargo/config(?:\.toml)?)$")
DOCS_POLICY_FILES = ("docs/supported-environments.md", "docs/parser-inventory.md")
DOCS_CARD_CODE = ("docs/og-image.ts", "docs/og-opal.ts")
DOCS_PAGES_ELSEWHERE = ("README.md", "engine/text-composition.md")
TEST_FILE = re.compile(r"\.test\.(?:ts|js|mjs)$")
WEB_EXCLUDED = (
    ("shells/web/src/main.ts", "boot path and service worker registration; the web image build reads it for the WebGPU gate"),
    ("shells/web/src/bridge/", "host bridge: stored formats, the shared export path and the Tauri shells' base"),
    ("shells/web/src/capture/", "page walk that the CLI and the browser extension bundle"),
    ("shells/web/src/catalog/", "catalog sync, integrity checks and trust store"),
    ("shells/web/src/collab/", "collaboration protocol and its stored channel message format"),
    ("shells/web/src/org/", "organisation accounts, approvals and AI policy"),
    ("shells/web/src/ext/", "control-plane extension entry point"),
    ("shells/web/src/vendor/", "vendored third-party code; licences, SBOM and audit run in full CI"),
    ("shells/web/src/ca-root.ts", "certificate trust anchor"),
    ("shells/web/src/lib/sync-", "personal sync: encryption keys, merge rules and remote stores"),
)
PROTECTED_NAME = re.compile(
    r"(?:^|[/_.-])(?:auth|account|session|login|signin|signup|password|credential|permission|policy|trust|security|org|admin"
    r"|invite|collab|gateway|remote|iframe|embed|release|webgpu|profile|identity|connections|instance|csp|integrity|oauth|seal"
    r"|secret|crypto|sign|signing|signature|c2pa|provenance|redact|sanitize|sanitizer|egress|migration|migrations|sw)(?:[/_.-]|$)",
    re.IGNORECASE)
WEB_AREAS = re.compile(r"^shells/web/(?:src/|design/|README\.md$|PERFORMANCE\.md$)")
WEB_PUBLIC_MEDIA = re.compile(r"^shells/web/public/(?!\.well-known/)(?:[^/]+/)*[^/]+\.(?:png|jpe?g|webp|avif|gif|ico|svg|mp3|mp4|opus|webm|vtt|woff2?)$")
REGULAR = ("000000", "100644")


def _irregular(path, before, after):
    return (not path or "\\" in path or any(ord(ch) < 32 or ord(ch) == 127 for ch in path)
            or any(part in ("", ".", "..") for part in path.split("/"))
            or before not in REGULAR or after not in REGULAR or (before == "000000" and after == "000000"))


def full_reason(path, before, after):
    """Why one change needs the full suite, or None when a fast lane may take the change."""
    if _irregular(path, before, after):
        return "not a plain regular file"
    if DEPENDENCY_FILE.search(path):
        return "dependency manifest or lockfile"
    if path.startswith("tests/") or TEST_FILE.search(path):
        return None
    if path.startswith("docs/"):
        return "read by a release or security gate" if path in DOCS_POLICY_FILES else None
    if path in DOCS_PAGES_ELSEWHERE:
        return None
    if not path.startswith("shells/web/"):
        return "outside docs/ and shells/web/"
    for prefix, reason in WEB_EXCLUDED:
        if path.startswith(prefix):
            return reason
    if WEB_PUBLIC_MEDIA.search(path):
        return None
    if not WEB_AREAS.search(path):
        return "shells/web build input, entry page or served file"
    name = PROTECTED_NAME.search(path[len("shells/web/"):])
    return f'security-sensitive name "{name.group(0).strip("/_.-")}"' if name else None


def _docs_lane(path):
    return (path.startswith("tests/") or TEST_FILE.search(path) is not None or path in DOCS_PAGES_ELSEWHERE
            or (path.startswith("docs/") and path not in DOCS_CARD_CODE))


def lane_of(changes):
    """(lane, reasons) for [(path, beforeMode, afterMode), ...] between the base and the source."""
    if not changes:
        return "full", ["Nothing differs from the base; the source needs its own full CI run"]
    reasons, web = [], False
    for path, before, after in changes:
        reason = full_reason(path, before, after)
        if reason:
            reasons.append(f"Full CI required: {path} ({reason})")
        elif not _docs_lane(path):
            web = True
    if reasons:
        return "full", reasons
    return ("web" if web else "docs"), []


# GitHub ------------------------------------------------------------------------------------------
# Only these subtrees are listed path by path. Any other difference is reported as the differing entry
# itself (a directory carries mode 040000), which needs full CI whatever the directory holds.
EXACT_TREES = ("docs", "shells/web")
OPEN_TREES = ("shells", "engine")
MAX_TREE_ENTRIES = 50000


def _commit(gh, repository, sha):
    require(SHA.fullmatch(sha) is not None, "BAD_INPUT", "a lane compares exact commits")
    data = gh.json(f"repos/{repository}/git/commits/{sha}")
    tree = (data.get("tree") or {}).get("sha")
    parents = [item.get("sha") for item in data.get("parents") or [] if isinstance(item, dict)]
    require(data.get("sha") == sha and isinstance(tree, str) and SHA.fullmatch(tree) is not None
            and all(isinstance(p, str) and SHA.fullmatch(p) for p in parents), "GITHUB_FAILED", "malformed commit object")
    return tree, parents


def _entries(gh, repository, tree, recursive=False):
    """{path: (mode, type, sha)} of one tree object, refusing a truncated listing."""
    data = gh.json(f"repos/{repository}/git/trees/{tree}", **({"recursive": "1"} if recursive else {}))
    listing = data.get("tree")
    require(data.get("sha") == tree and data.get("truncated") is False and isinstance(listing, list)
            and len(listing) <= MAX_TREE_ENTRIES, "LANE_TREE", "GitHub gave an incomplete tree listing")
    entries = {}
    for item in listing:
        path, mode, kind, sha = (item.get(key) for key in ("path", "mode", "type", "sha")) if isinstance(item, dict) else (None,) * 4
        require(isinstance(path, str) and path and path not in entries and isinstance(mode, str) and re.fullmatch(r"[0-7]{6}", mode)
                and kind in ("blob", "tree", "commit") and isinstance(sha, str) and SHA.fullmatch(sha),
                "LANE_TREE", "GitHub gave a malformed tree entry")
        entries[path] = ("040000" if kind == "tree" else mode, kind, sha)
    return entries


def _diff(base, source, prefix):
    """Changes between two {path: entry} maps, as git diff --raw --no-renames lists them (trees skipped)."""
    changes = []
    for path in sorted(set(base) | set(source)):
        old, new = base.get(path), source.get(path)
        if old and old[1] == "tree":
            old = None
        if new and new[1] == "tree":
            new = None
        if old != new:
            changes.append((prefix + path, old[0] if old else "000000", new[0] if new else "000000"))
    return changes


def tree_changes(gh, repository, base, source):
    """The changed paths between two commits, read from GitHub's tree objects."""
    def walk(old_tree, new_tree, prefix):
        here = prefix.rstrip("/")
        if here in EXACT_TREES:
            return _diff(_entries(gh, repository, old_tree, True), _entries(gh, repository, new_tree, True), prefix)
        old, new = _entries(gh, repository, old_tree), _entries(gh, repository, new_tree)
        changes = []
        for name in sorted(set(old) | set(new)):
            before, after = old.get(name), new.get(name)
            if before == after:
                continue
            path = prefix + name
            if before and after and before[1] == after[1] == "tree" and (path in EXACT_TREES or path in OPEN_TREES):
                changes += walk(before[2], after[2], path + "/")
            else:
                changes.append((path, before[0] if before else "000000", after[0] if after else "000000"))
        return changes
    return walk(_commit(gh, repository, base)[0], _commit(gh, repository, source)[0], "")


def _own_main_push(run, workflow_path, repository, sha=None):
    return (isinstance(run, dict) and isinstance(run.get("id"), int) and run.get("path") == workflow_path
            and run.get("event") == "push" and run.get("head_branch") == "main"
            and (sha is None or run.get("head_sha") == sha)
            and (run.get("repository") or {}).get("full_name") == repository
            and (run.get("head_repository") or {}).get("full_name") == repository)


def find_base(gh, anchors, sha):
    """(base, ciRunId, distance): the newest first-parent ancestor of sha with a successful full main CI push run."""
    repository = anchors["repository"]
    listing = gh.json(f"repos/{repository}/actions/workflows/{anchors['ciWorkflowFile']}/runs",
                      branch=anchors["branch"], event="push", status="success", per_page=100)
    green = {}
    for run in listing.get("workflow_runs", []):
        if _own_main_push(run, anchors["ciWorkflowPath"], repository) and run.get("status") == "completed" \
                and run.get("conclusion") == "success" and isinstance(run.get("head_sha"), str):
            green[run["head_sha"]] = max(green.get(run["head_sha"], 0), run["id"])
    commit = sha
    for distance in range(MAX_BASE_DISTANCE + 1):
        if commit in green:
            return commit, green[commit], distance
        _, parents = _commit(gh, repository, commit)
        require(parents, "LANE_NO_BASE", "no successful full main CI run on the source's first-parent line")
        commit = parents[0]
    raise Refusal("LANE_NO_BASE", f"no successful full main CI run within {MAX_BASE_DISTANCE} first-parent commits")


def require_no_full_failure(gh, anchors, sha):
    """CI_NOT_GREEN when a completed full CI push run of sha ended in anything but success or cancellation."""
    listing = gh.json(f"repos/{anchors['repository']}/actions/workflows/{anchors['ciWorkflowFile']}/runs",
                      branch=anchors["branch"], event="push", head_sha=sha, per_page=20)
    for run in listing.get("workflow_runs", []):
        if _own_main_push(run, anchors["ciWorkflowPath"], anchors["repository"], sha) and run.get("status") == "completed" \
                and run.get("conclusion") not in ("success", "cancelled"):
            raise Refusal("CI_NOT_GREEN", f"full CI run {run['id']} on {sha} concluded {run.get('conclusion')!r}; a lane never overrides that")


def passed_lane_job(gh, anchors, sha, lane):
    """(run id, job id) of the newest fast-lanes.yml push run of sha whose lane job passed."""
    name, repository = LANE_JOBS[lane], anchors["repository"]
    try:
        listing = gh.json(f"repos/{repository}/actions/workflows/{anchors['fastLaneWorkflowFile']}/runs",
                          branch=anchors["branch"], event="push", head_sha=sha, per_page=20)
    except Refusal as exc:
        if exc.code != "GITHUB_NOT_FOUND":
            raise
        listing = {}
    runs = sorted((run for run in listing.get("workflow_runs", [])
                   if _own_main_push(run, anchors["fastLaneWorkflowPath"], repository, sha)), key=lambda run: run["id"], reverse=True)
    for run in runs:
        jobs = [job for job in gh.json(f"repos/{repository}/actions/runs/{run['id']}/jobs", filter="latest", per_page=100).get("jobs", [])
                if isinstance(job, dict) and job.get("name") == name]
        require(len(jobs) <= 1, "LANE_JOBS", f'more than one "{name}" job in run {run["id"]}')
        if jobs and isinstance(jobs[0].get("id"), int) and jobs[0].get("run_id") == run["id"] and jobs[0].get("head_sha") == sha \
                and jobs[0].get("status") == "completed" and jobs[0].get("conclusion") == "success":
            return run["id"], jobs[0]["id"]
    raise Refusal("LANE_PENDING", f'the "{name}" job of {anchors["fastLaneWorkflowPath"]} has not passed on {sha} yet')


def qualify(gh, anchors, sha):
    """The lane that lets sha ship without its own full CI run, or a refusal saying why not."""
    require("fastLaneWorkflowFile" in anchors, "LANE_UNAVAILABLE", f"{anchors['site']} has no fast lanes")
    require_no_full_failure(gh, anchors, sha)
    base, ci_run, distance = find_base(gh, anchors, sha)
    require(distance >= 1, "LANE_NOT_NEEDED", "the source has its own successful full CI run")
    lane, reasons = lane_of(tree_changes(gh, anchors["repository"], base, sha))
    if lane == "full":
        shown = reasons[:5] + ([f"and {len(reasons) - 5} more"] if len(reasons) > 5 else [])
        raise Refusal("LANE_FULL", "; ".join(shown))
    fast_run, job = passed_lane_job(gh, anchors, sha, lane)
    return {"id": ci_run, "lane": lane, "base": base, "distance": distance, "fastRun": fast_run, "fastJob": job,
            "policy": LANE_POLICY}
