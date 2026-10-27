# SPDX-License-Identifier: MPL-2.0
"""GitHub side of the preview deploy command: find, dispatch, wait for and bind one build.

Every call goes through the `gh` CLI as an argument list (never a shell string).
The only write is the preview workflow dispatch. Nothing here approves an environment gate.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import preview_lane
from preview_common import HEX64, RUN_ID, SHA, Refusal, emit, parse_utc, require, sha256_hex, strict_json

ACTIVE_STATES = ("queued", "in_progress", "waiting", "pending", "requested")
RECEIPT_FILES = {"release.json", "web.json", "public.jwk.json", "catalog.json", "web-boot.json"}
RELEASE_KEYS = {"source", "runId", "runAttempt", "neutralProfile", "images", "candidateRuntimeQualified"}
# A build from preview-web.yml that runs at merge, before the commit's CI finishes, says so in release.json:
# "sourceGate": "not-failed" (its source gate refused only a completed CI failure). Such a build proves nothing
# about qualification, and no build does any more: preview_mac.qualification reads it at deploy time for every
# ship and deploy. A tool from before that rule refuses the field, so it can never deploy one of these builds.
SOURCE_GATES = ("not-failed",)
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")


class Gh:
    """Thin wrapper over `gh api`. Output is bounded; stderr is never echoed."""

    def __init__(self, executable="gh", sleep=time.sleep):
        self.executable = executable
        self.sleep = sleep

    def _run(self, args, stdin=None, limit=8 * 1024 * 1024, timeout=120):
        try:
            done = subprocess.run([self.executable, "api", *args], input=stdin, capture_output=True,
                                  timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("GITHUB_UNAVAILABLE", "gh api failed to run or timed out") from exc
        if done.returncode != 0:
            if b"HTTP 404" in done.stderr:
                raise Refusal("GITHUB_NOT_FOUND", "GitHub answered 404 for " + args[-1].split("?")[0])
            raise Refusal("GITHUB_FAILED", f"gh api exited {done.returncode} for " + args[-1].split("?")[0])
        require(len(done.stdout) <= limit, "GITHUB_FAILED", "GitHub response exceeds its bound")
        return done.stdout

    def json(self, path, **params):
        query = ("?" + urllib.parse.urlencode(params)) if params else ""
        return strict_json(self._run([path + query]).decode("utf-8"), "GitHub response")

    def raw(self, path, limit=8 * 1024 * 1024):
        return self._run(["-H", "Accept: application/vnd.github.raw", path], limit=limit)

    def binary(self, path, limit):
        return self._run([path], limit=limit)

    def post(self, path, body):
        self._run(["--method", "POST", path, "--input", "-"], stdin=json.dumps(body).encode(), limit=65536)

    def download(self, path, destination, limit, timeout=3600):
        """Stream a large response (an artifact zip) to a new private file; never into memory."""
        import os
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as out:
                done = subprocess.run([self.executable, "api", path], stdout=out, stderr=subprocess.PIPE, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("GITHUB_UNAVAILABLE", "the artifact download failed or timed out") from exc
        require(done.returncode == 0, "GITHUB_FAILED", f"gh api exited {done.returncode} for " + path.split("?")[0])
        require(os.path.getsize(destination) <= limit, "GITHUB_FAILED", "the artifact exceeds its bound")
        return destination


def _same_repository(run, repository):
    return ((run.get("repository") or {}).get("full_name") == repository
            and (run.get("head_repository") or {}).get("full_name") == repository)


def branch_head(gh, repository, branch="main"):
    """The branch head as a commit SHA, read from refs/heads/<branch>. Never the bare name (a tag could share it)."""
    ref = gh.json(f"repos/{repository}/git/ref/heads/{branch}")
    sha = (ref.get("object") or {}).get("sha")
    require(ref.get("ref") == "refs/heads/" + branch and (ref.get("object") or {}).get("type") == "commit"
            and isinstance(sha, str) and SHA.fullmatch(sha) is not None, "GITHUB_FAILED", f"could not read the {branch} head")
    return sha


def main_head(gh, anchors):
    return branch_head(gh, anchors["repository"], anchors["branch"])


def contains(gh, repository, ancestor, head):
    """True when `ancestor` is `head` or one of its ancestors. Both are SHAs."""
    require(SHA.fullmatch(ancestor) is not None and SHA.fullmatch(head) is not None, "BAD_INPUT", "compare needs two SHAs")
    return gh.json(f"repos/{repository}/compare/{ancestor}...{head}").get("status") in ("ahead", "identical")


def require_on_main(gh, anchors, sha, main_sha=None):
    main_sha = main_sha or main_head(gh, anchors)
    require(contains(gh, anchors["repository"], sha, main_sha), "NOT_ON_MAIN",
            f"{sha} is not on {anchors['branch']} at {main_sha[:12]}")
    return main_sha


def green_ci_run(gh, anchors, sha):
    """The successful normal CI push run on main for exactly this commit."""
    listing = gh.json(f"repos/{anchors['repository']}/actions/workflows/{anchors['ciWorkflowFile']}/runs",
                      branch=anchors["branch"], event="push", head_sha=sha, per_page=20)
    runs = [run for run in listing.get("workflow_runs", []) if isinstance(run, dict)]
    good = [run for run in runs if run.get("path") == anchors["ciWorkflowPath"] and run.get("event") == "push"
            and run.get("head_branch") == anchors["branch"] and run.get("head_sha") == sha
            and _same_repository(run, anchors["repository"]) and run.get("status") == "completed"
            and run.get("conclusion") == "success" and isinstance(run.get("id"), int)]
    if not good:
        pending = any(run.get("status") != "completed" for run in runs)
        raise Refusal("CI_PENDING" if pending else "CI_NOT_GREEN",
                      f"no successful main CI push run for {sha}" + (" yet" if pending else ""))
    return max(good, key=lambda run: run["id"])


def qualified_ci(gh, anchors, sha):
    """What lets this commit ship: its own successful main CI push run, or a fast lane above one.

    Returns {"id": the full CI run, "lane": "full" | "docs" | "web", "base": the commit that run tested, ...}.
    A site without "fastLaneWorkflowFile" in its anchors (lolly.ing) only ever takes the first answer.
    """
    try:
        run = green_ci_run(gh, anchors, sha)
        return {"id": run["id"], "lane": "full", "base": sha}
    except Refusal as exc:
        if "fastLaneWorkflowFile" not in anchors:
            raise
        refusal = exc
    try:
        return preview_lane.qualify(gh, anchors, sha)
    except Refusal as lane:
        if lane.code == "CI_NOT_GREEN":  # the full run already failed: a lane never overrides that
            raise
        raise Refusal(refusal.code, f"{refusal.message}; no fast lane either: {lane.message}") from lane


def active_candidate_runs(gh, anchors):
    active = []
    for state in ACTIVE_STATES:
        listing = gh.json(f"repos/{anchors['repository']}/actions/workflows/{anchors['buildWorkflowFile']}/runs",
                          event="workflow_dispatch", status=state, per_page=20)
        active += [run.get("id") for run in listing.get("workflow_runs", []) if isinstance(run, dict)]
    return sorted({run for run in active if isinstance(run, int)})


def dispatch_runs(gh, anchors, sha):
    listing = gh.json(f"repos/{anchors['repository']}/actions/workflows/{anchors['buildWorkflowFile']}/runs",
                      event="workflow_dispatch", branch=anchors["branch"], per_page=100)
    return [run for run in listing.get("workflow_runs", []) if isinstance(run, dict) and isinstance(run.get("id"), int)
            and run.get("path") == anchors["buildWorkflowPath"] and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == anchors["branch"]
            and (run.get("display_title") == anchors["buildRunTitle"].format(sha=sha) if "buildRunTitle" in anchors
                 else run.get("head_sha") == sha)]


def dispatch_build(gh, anchors, sha):
    """Ask the preview workflow to build this source on main."""
    body = {"ref": "refs/heads/" + anchors["branch"], "inputs": {anchors["buildSourceInput"]: sha}}
    gh.post(f"repos/{anchors['repository']}/actions/workflows/{anchors['buildWorkflowFile']}/dispatches", body)
    return body


def find_new_run(gh, anchors, sha, known_ids, attempts=20, pause=6):
    for _ in range(attempts):
        fresh = [run for run in dispatch_runs(gh, anchors, sha) if run["id"] not in known_ids]
        if len(fresh) == 1:
            return fresh[0]
        require(len(fresh) <= 1, "AMBIGUOUS_RUN", "more than one new preview run appeared; bind one by hand with deploy")
        gh.sleep(pause)
    raise Refusal("RUN_NOT_FOUND", "the dispatched preview run did not appear")


def wait_for_run(gh, anchors, run_id, poll_seconds, timeout_minutes, tolerated_errors=6):
    deadline = time.monotonic() + timeout_minutes * 60
    last, errors = None, 0
    while True:
        try:
            run = gh.json(f"repos/{anchors['repository']}/actions/runs/{run_id}")
            errors = 0
        except Refusal as exc:  # a brief GitHub error while waiting is not a failed build
            errors += 1
            require(exc.code in ("GITHUB_FAILED", "GITHUB_UNAVAILABLE") and errors < tolerated_errors, exc.code, exc.message)
            emit("build", run=run_id, note="GitHub did not answer; waiting", attempt=errors)
            gh.sleep(max(poll_seconds, 5))
            continue
        state = (run.get("status"), run.get("conclusion"))
        if state != last:
            note = "waiting in GitHub; agents never approve environment gates" \
                if run.get("status") == "waiting" else None
            emit("build", run=run_id, status=run.get("status"), conclusion=run.get("conclusion"), note=note)
            last = state
        if run.get("status") == "completed":
            return run
        require(time.monotonic() < deadline, "RUN_TIMEOUT", f"run {run_id} did not finish in {timeout_minutes} min")
        gh.sleep(poll_seconds)


def _web_record(value, sha, anchors):
    require(isinstance(value, dict) and set(value) == {"imageId", "digest", "platform", "source"},
            "RECEIPT_INVALID", "web receipt has missing or unexpected fields")
    pattern = re.escape(anchors["imageRepository"]) + r"@sha256:[0-9a-f]{64}\Z"
    require(isinstance(value["digest"], str) and re.fullmatch(pattern, value["digest"]) is not None,
            "RECEIPT_INVALID", "image is not the anchored package pinned by digest")
    require(isinstance(value["imageId"], str) and IMAGE_ID.fullmatch(value["imageId"]) is not None,
            "RECEIPT_INVALID", "image id is malformed")
    require(value["platform"] == "linux/amd64" and value["source"] == sha, "RECEIPT_INVALID", "image platform or source differs")
    return value


def read_receipt_artifact(data, run, sha, anchors, public_jwk, thumbprint):
    require(len(data) <= 1024 * 1024, "RECEIPT_INVALID", "receipt artifact is too large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = archive.namelist()
        require(set(names) == RECEIPT_FILES and len(names) == len(RECEIPT_FILES),
                "RECEIPT_INVALID", "receipt artifact holds unexpected or missing files")
        files = {}
        for name in names:
            info = archive.getinfo(name)
            require(info.file_size <= 65536, "RECEIPT_INVALID", "receipt file is too large")
            files[name] = strict_json(archive.read(name).decode("utf-8"), name)
    except (zipfile.BadZipFile, UnicodeDecodeError, KeyError) as exc:
        raise Refusal("RECEIPT_INVALID", "receipt artifact is not a valid zip") from exc
    release = files["release.json"]
    require(isinstance(release, dict) and (set(release) == RELEASE_KEYS or (set(release) == RELEASE_KEYS | {"sourceGate"}
            and release["sourceGate"] in SOURCE_GATES)), "RECEIPT_INVALID", "release receipt has missing or unexpected fields")
    require(release["source"] == sha and release["runId"] == str(run["id"]) and type(release["runAttempt"]) is int
            and release["runAttempt"] == run["run_attempt"] and release["neutralProfile"] is True,
            "RECEIPT_INVALID", "release receipt is not bound to this run and source")
    require(isinstance(release["images"], dict) and set(release["images"]) == {"web"}, "RECEIPT_INVALID", "release names other images")
    web = _web_record(release["images"]["web"], sha, anchors)
    require(files["web.json"] == web, "RECEIPT_INVALID", "web.json differs from release.json")
    pin = files["public.jwk.json"]
    require(isinstance(pin, dict) and all(pin.get(key) == public_jwk[key] for key in ("kty", "crv", "x", "y"))
            and "d" not in pin, "RECEIPT_INVALID", "build used a different public pin")
    catalog = files["catalog.json"]
    require(isinstance(catalog, dict) and catalog.get("verified") is True and catalog.get("keyId") == thumbprint
            and isinstance(catalog.get("indexSha256"), str) and HEX64.fullmatch(catalog["indexSha256"]),
            "RECEIPT_INVALID", "image catalog was not verified against the pin")
    boot = files["web-boot.json"]
    require(isinstance(boot, dict) and boot.get("serviceBootPassed") is True, "RECEIPT_INVALID", "image did not boot in CI")
    return {"image": web["digest"], "imageId": web["imageId"], "catalogIndexSha256": catalog["indexSha256"]}


def bind_run(gh, anchors, run, sha, public_jwk, thumbprint):
    """Bind a completed run to the request: workflow, event, repository, branch, commit, success, receipt."""
    require(isinstance(run.get("id"), int) and RUN_ID.fullmatch(str(run["id"])) is not None, "RUN_NOT_BOUND", "run id is malformed")
    require(run.get("path") == anchors["buildWorkflowPath"], "RUN_NOT_BOUND", "run is not the anchored build workflow")
    require(run.get("event") == "workflow_dispatch", "RUN_NOT_BOUND", "run was not dispatched")
    require(_same_repository(run, anchors["repository"]), "RUN_NOT_BOUND", "run belongs to another repository")
    require(run.get("head_branch") == anchors["branch"], "RUN_NOT_BOUND", "run is for another branch")
    head = run.get("head_sha")
    require(isinstance(head, str) and SHA.fullmatch(head) is not None, "RUN_NOT_BOUND", "run head is not a commit SHA")
    if "buildRunTitle" in anchors:
        require(run.get("display_title") == anchors["buildRunTitle"].format(sha=sha),
                "RUN_NOT_BOUND", "run title names another source")
        require(head == sha or contains(gh, anchors["repository"], sha, head),
                "RUN_NOT_BOUND", "source is not an ancestor of the dispatched main head")
    else:
        require(head == sha, "RUN_NOT_BOUND", "legacy run is for another commit")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] >= 1, "RUN_NOT_BOUND", "run attempt is malformed")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "RUN_FAILED",
            f"run {run['id']} concluded {run.get('conclusion')!r}")
    name = anchors["receiptArtifactPrefix"] + str(run["run_attempt"])
    listing = gh.json(f"repos/{anchors['repository']}/actions/runs/{run['id']}/artifacts", per_page=100)
    matches = [item for item in listing.get("artifacts", []) if isinstance(item, dict) and item.get("name") == name]
    require(len(matches) == 1 and matches[0].get("expired") is False and isinstance(matches[0].get("id"), int),
            "RECEIPT_MISSING", f"run {run['id']} has no single live {name} artifact")
    data = gh.binary(f"repos/{anchors['repository']}/actions/artifacts/{matches[0]['id']}/zip", limit=1024 * 1024)
    bound = read_receipt_artifact(data, run, sha, anchors, public_jwk, thumbprint)
    bound.update({"run": run["id"], "attempt": run["run_attempt"], "runCreatedAt": run.get("created_at"),
                  "receiptExpiresAt": matches[0].get("expires_at"), "catalogPin": thumbprint})
    return bound


def latest_bound_run(gh, anchors, sha, public_jwk, thumbprint, prefer_image=None):
    """The newest successful build run for this commit that still binds.

    With prefer_image (the live image, for the conversion), only a run that built
    exactly that image is accepted, even when a newer rebuild of the commit exists.
    Runs whose receipt artifact has expired are skipped.
    """
    candidates = sorted((run for run in dispatch_runs(gh, anchors, sha)
                         if run.get("status") == "completed" and run.get("conclusion") == "success"),
                        key=lambda run: run["id"], reverse=True)
    require(bool(candidates), "RUN_NOT_FOUND", f"no successful build for {sha}; use ship")
    skipped = []
    for run in candidates:
        try:
            bound = bind_run(gh, anchors, run, sha, public_jwk, thumbprint)
        except Refusal as exc:
            if exc.code != "RECEIPT_MISSING":
                raise
            skipped.append(run["id"])
            continue
        if prefer_image is None or bound["image"] == prefer_image:
            return bound
        skipped.append(run["id"])
    raise Refusal("RUN_NOT_FOUND", f"no live, binding build run for {sha}" +
                  (f" that built {prefer_image}" if prefer_image else "") + f" (looked at {len(skipped)})")


def source_file(gh, anchors, path, sha):
    require(SHA.fullmatch(sha) is not None and re.fullmatch(r"[A-Za-z0-9._/-]+", path) is not None,
            "BAD_INPUT", "invalid source path")
    return gh.raw(f"repos/{anchors['repository']}/contents/{path}?ref={sha}")


def connector_origins_variable(gh, anchors):
    """(value, updated_at, scope) of vars.VITE_CONNECTOR_ORIGINS as the build's jobs see it.

    The web-image job names no environment, so a repository variable wins and an
    organisation variable shared with the repository applies otherwise. Neither
    means the build used none.
    """
    name = anchors["connectorOriginsVariable"]
    try:
        variable = gh.json(f"repos/{anchors['repository']}/actions/variables/{name}")
        scope = "repository"
    except Refusal as exc:
        if exc.code != "GITHUB_NOT_FOUND":
            raise
        shared = gh.json(f"repos/{anchors['repository']}/actions/organization-variables", per_page=30)
        found = [item for item in shared.get("variables", []) if isinstance(item, dict) and item.get("name") == name]
        require(shared.get("total_count", 0) <= 30, "CONNECTOR_ORIGINS", "too many organisation variables to read in one page")
        if not found:
            return "", None, "none"
        variable, scope = found[0], "organization"
    value, updated = variable.get("value"), variable.get("updated_at")
    require(isinstance(value, str) and (updated is None or isinstance(updated, str)), "CONNECTOR_ORIGINS",
            "connector origins variable is malformed")
    return value, updated, scope


def connector_origins(gh, anchors, build_created_at):
    """The connector origins the build read, refused if the variable changed after the build started."""
    value, updated, _ = connector_origins_variable(gh, anchors)
    if isinstance(updated, str) and build_created_at:
        require(parse_utc(updated) <= parse_utc(build_created_at), "CONNECTOR_ORIGINS_CHANGED",
                "the connector origins variable changed after this build started; rebuild")
    return value


def run_created_at(gh, anchors, run_id):
    run = gh.json(f"repos/{anchors['repository']}/actions/runs/{int(run_id)}")
    created = run.get("created_at")
    require(isinstance(created, str), "GITHUB_FAILED", "the run has no creation time")
    return created


def registry_image_bytes(image, anchors, opener=None):
    """Compressed size of a public image by digest, read anonymously from the registry.

    This also proves the package is public and the digest exists (decision 16).
    """
    opener = opener or urllib.request.urlopen
    repository, _, digest = image.partition("@")
    require(repository == anchors["imageRepository"] and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None,
            "BAD_INPUT", "image is not the anchored package")
    host, name = anchors["registryHost"], anchors["registryName"]
    accept = ", ".join(["application/vnd.oci.image.index.v1+json",
                        "application/vnd.docker.distribution.manifest.list.v2+json",
                        "application/vnd.oci.image.manifest.v1+json",
                        "application/vnd.docker.distribution.manifest.v2+json"])
    try:
        with opener(urllib.request.Request(f"https://{host}/token?scope=repository:{name}:pull&service={host}"),
                    timeout=20) as response:
            token = strict_json(response.read(65536).decode("utf-8"), "registry token").get("token")
        require(isinstance(token, str) and token, "REGISTRY", "registry gave no anonymous token")

        def manifest(ref):
            request = urllib.request.Request(f"https://{host}/v2/{name}/manifests/{ref}",
                                             headers={"Accept": accept, "Authorization": "Bearer " + token})
            with opener(request, timeout=20) as response:
                body = response.read(4 * 1024 * 1024 + 1)
            require(len(body) <= 4 * 1024 * 1024 and "sha256:" + sha256_hex(body) == ref,
                    "REGISTRY", "registry manifest does not match its digest")
            return strict_json(body.decode("utf-8"), "registry manifest")
        document = manifest(digest)
        if "manifests" in document:
            chosen = [entry for entry in document["manifests"] if isinstance(entry, dict)
                      and (entry.get("platform") or {}).get("os") == "linux"
                      and (entry.get("platform") or {}).get("architecture") == "amd64"]
            require(len(chosen) == 1, "REGISTRY", "image index has no single linux/amd64 manifest")
            document = manifest(chosen[0]["digest"])
        layers = document.get("layers")
        require(isinstance(layers, list) and layers and all(type(layer.get("size")) is int for layer in layers),
                "REGISTRY", "image manifest has no layer sizes")
        return sum(layer["size"] for layer in layers) + int((document.get("config") or {}).get("size", 0))
    except (OSError, urllib.error.URLError, ValueError) as exc:
        raise Refusal("REGISTRY", "the image is not anonymously readable from the registry") from exc


def bound_live_run(gh, sha, image):
    """Bind the live image, including release builds from before Phase 1b."""
    import preview_anchors as A
    if image.startswith(A.TOOLS_LEGACY["imageRepository"] + "@"):
        return latest_bound_run(gh, A.TOOLS_LEGACY, sha, A.RELEASE_PUBLIC_KEY_JWK,
                                A.RELEASE_PUBLIC_KEY_THUMBPRINT, prefer_image=image)
    pin, thumbprint = A.preview_pin()
    return latest_bound_run(gh, A.TOOLS, sha, pin, thumbprint, prefer_image=image)
