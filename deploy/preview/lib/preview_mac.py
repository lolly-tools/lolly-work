# SPDX-License-Identifier: MPL-2.0
"""Operator side of the preview deploy command: ship, deploy, rollback, status, gc and plan.

Inputs are only a site and a commit. Everything else comes from the bound CI
run, the source commit's own files, the live cluster and the private profile.
"""

from __future__ import annotations

import argparse
import base64
import difflib
import hashlib
import hmac
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import preview_anchors as A
import preview_github as G
from preview_common import (HEX64, SHA, Refusal, compact, compact_digest, emit, require, sha256_hex,
                            strict_json, utc_now, utc_stamp, write_private_new)
from preview_expect import (configured_nginx_conf, expected_headers, format_lowering, models_sample,
                            stored_formats)
from preview_layout import conversion_plan

TOOL_REPOSITORY = "lolly-tools/lolly-work"
TOOL_PATHS = ("deploy/preview", "scripts/app-update.py")
LIB = Path(__file__).resolve().parent
TOOL_ROOT = LIB.parents[2]  # <root>/deploy/preview/lib -> <root>
BUSY = ("active", "activating", "deactivating", "reloading", "refreshing")
RESULT_EXIT = {"LIVE": 0, "ALREADY_LIVE": 0, "CONVERTED": 0, "ALREADY_CONVERTED": 0, "GC_DONE": 0,
               "ROLLED_BACK": 2, "CONVERSION_REVERTED": 2, "ROLLBACK_UNHEALTHY": 3}
GIB = 2 ** 30
SLEEP = time.sleep


# Tool identity ---------------------------------------------------------------
def tool_files(root):
    """(relative path, absolute path) for every file the tool lock covers."""
    root = Path(root)
    entries = []
    preview = root / "deploy" / "preview"
    require(preview.is_dir() and not preview.is_symlink(), "TOOL_INVALID", "deploy/preview is missing")
    for path in sorted(preview.rglob("*")):
        require(not path.is_symlink(), "TOOL_INVALID", "the tool tree holds a symbolic link")
        if path.is_file():
            entries.append((path.relative_to(root).as_posix(), path))
        else:
            require(path.is_dir(), "TOOL_INVALID", "the tool tree holds a special file")
    app_update = root / "scripts" / "app-update.py"
    require(app_update.is_file() and not app_update.is_symlink(), "TOOL_INVALID", "scripts/app-update.py is missing")
    entries.append(("scripts/app-update.py", app_update))
    return sorted(entries)


def tool_digest(root):
    """The hash tool.lock.json pins. launch.py computes the same value."""
    lines = []
    for relative, path in tool_files(root):
        mode = "x" if os.stat(path).st_mode & stat.S_IXUSR else "-"
        lines.append(f"{relative}\0{mode}\0{hashlib.sha256(path.read_bytes()).hexdigest()}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def bundle(root):
    """Deterministic tar.gz of the tool tree plus app-update.py, laid out as the node expects."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        for relative, path in tool_files(root):
            name = "app-update.py" if relative == "scripts/app-update.py" else relative[len("deploy/preview/"):]
            if "__pycache__" in name:
                continue
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.uid, info.gid = len(data), 0, 0, 0
            info.mode = 0o500 if os.stat(path).st_mode & stat.S_IXUSR else 0o400
            archive.addfile(info, io.BytesIO(data))
    return base64.b64encode(buffer.getvalue()).decode()


# Profile ---------------------------------------------------------------------
PROFILE_KEYS = {"version", "site", "ssh", "node", "deployment", "models", "smoke", "watch", "build",
                "rolloutTimeoutSeconds", "capacity", "retainPreviousImages", "noDeployUtc", "gc"}


def load_profile(state_dir, site):
    """The private instance profile: identifiers, page list and thresholds only (S9)."""
    state = Path(state_dir)
    require(state.is_absolute() and state.is_dir() and not state.is_symlink(), "PROFILE_INVALID", "state dir is not a directory")
    require(not (state.stat().st_mode & 0o022), "PROFILE_INVALID", "the state dir must not be group or world writable")
    path = state / (site + ".json")
    require(path.is_file() and not path.is_symlink(), "PROFILE_INVALID", f"{path.name} is missing from the state dir")
    require(not (path.stat().st_mode & 0o022), "PROFILE_INVALID", "the profile must not be group or world writable")
    profile = strict_json(path.read_text(), "profile")
    require(isinstance(profile, dict) and set(profile) == PROFILE_KEYS and profile["version"] == 1 and profile["site"] == site,
            "PROFILE_INVALID", "profile fields do not match version 1 for this site")
    ssh, node, deployment = profile["ssh"], profile["node"], profile["deployment"]
    require(isinstance(ssh, dict) and set(ssh) == {"host", "jump", "knownHostsFile"}
            and all(re.fullmatch(r"[A-Za-z0-9_.@:\[\]-]+", str(ssh[k])) and not str(ssh[k]).startswith("-") for k in ("host", "jump"))
            and os.path.isabs(ssh["knownHostsFile"]), "PROFILE_INVALID", "ssh route")
    require(isinstance(node, dict) and set(node) == {"k3s", "kubeconfig", "context", "name", "uid", "clusterUID"}
            and os.path.isabs(node["k3s"]) and os.path.isabs(node["kubeconfig"]), "PROFILE_INVALID", "node")
    require(isinstance(deployment, dict) and set(deployment) == {"namespaceUID", "deploymentUID", "requiredLabels"},
            "PROFILE_INVALID", "deployment")
    models = profile["models"]
    require(isinstance(models, dict) and set(models) == {"release", "manifestSha256"}
            and re.fullmatch(r"models-[0-9a-f]{64}", models["release"]) and HEX64.fullmatch(models["manifestSha256"]),
            "PROFILE_INVALID", "models")
    smoke = profile["smoke"]
    require(isinstance(smoke, dict) and set(smoke) == {"edgeAddress", "pages", "maxAddedPages", "memoryFraction"},
            "PROFILE_INVALID", "smoke")
    require(isinstance(smoke["pages"], list) and 1 <= len(smoke["pages"]) <= 12, "PROFILE_INVALID", "smoke pages")
    watch, build = profile["watch"], profile["build"]
    require(isinstance(watch, dict) and set(watch) == {"minutes", "intervalSeconds", "failures"}, "PROFILE_INVALID", "watch")
    require(isinstance(build, dict) and set(build) == {"pollSeconds", "timeoutMinutes"}, "PROFILE_INVALID", "build")
    capacity = profile["capacity"]
    require(isinstance(capacity, dict) and set(capacity) == {"minFreeAboveReserveBytes", "imageSizeFactor"}, "PROFILE_INVALID", "capacity")
    window = profile["noDeployUtc"]
    require(isinstance(window, list) and len(window) == 2 and all(re.fullmatch(r"[0-2][0-9]:[0-5][0-9]", t) for t in window),
            "PROFILE_INVALID", "noDeployUtc")
    require(isinstance(profile["gc"], dict) and set(profile["gc"]) == {"legacyClaims"}, "PROFILE_INVALID", "gc")
    profile["_sha256"] = sha256_hex(path.read_bytes())
    return profile


class Context:
    def __init__(self, args, gh=None, opener=None):
        self.args = args
        self.site = args.site
        self.anchors = A.site_anchors(args.site)
        self.state_dir = Path(args.state_dir)
        self.profile = load_profile(args.state_dir, args.site)
        self.gh = gh or G.Gh()
        self.opener = opener
        self.pin = A.RELEASE_PUBLIC_KEY_JWK
        self.root = Path(args.tool_root) if getattr(args, "tool_root", None) else TOOL_ROOT
        self.tool_hash = tool_digest(self.root)
        require(hmac.compare_digest(self.tool_hash, args.tool_sha256), "TOOL_HASH_MISMATCH",
                "the running tool differs from the hash launch.py checked")
        self.started = utc_stamp()

    # Records -------------------------------------------------------------
    def record(self, command, result, **fields):
        entry = {"site": self.site, "command": command, "result": result, "tool": self.tool_hash,
                 "profileSha256": self.profile["_sha256"], "start": self.started, "end": utc_stamp(), **fields}
        path = self.state_dir / "deploys.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as out:
            out.write(json.dumps(entry, sort_keys=True) + "\n")

    # Preconditions -------------------------------------------------------
    def check_tool_checkout(self):
        """The tool must be clean and on lolly-work main (S10). launch.py pins its exact bytes (R21 R4)."""
        checkout = Path(self.args.checkout)
        try:
            status = subprocess.run(["git", "-C", str(checkout), "status", "--porcelain", "--", *TOOL_PATHS],
                                    capture_output=True, timeout=60, check=True).stdout
            head = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True,
                                  timeout=60, check=True).stdout.decode().strip()
        except (OSError, subprocess.SubprocessError) as exc:
            raise Refusal("TOOL_NOT_MAIN", "cannot read the tool checkout") from exc
        require(not status, "TOOL_DIRTY", "the tool checkout has local changes in its tool paths")
        require(SHA.fullmatch(head) is not None, "TOOL_NOT_MAIN", "tool checkout HEAD is unreadable")
        require(tool_digest(checkout) == self.tool_hash, "TOOL_HASH_MISMATCH", "the checkout differs from the running tool")
        compare = self.gh.json(f"repos/{TOOL_REPOSITORY}/compare/{head}...main")
        require(compare.get("status") in ("ahead", "identical"), "TOOL_NOT_MAIN", "the tool checkout is not on lolly-work main")
        return head

    def backup_window(self):
        start, end = self.profile["noDeployUtc"]
        now = utc_now().strftime("%H:%M")
        require(not (start <= now < end), "BACKUP_WINDOW", f"no preview deploys from {start} to {end} UTC")

    def check_target(self):
        """check-target.py --site, once, immediately before the run starts (decision 8)."""
        try:
            done = subprocess.run([sys.executable, "-I", "-B", self.args.check_target, "--site", self.site],
                                  capture_output=True, timeout=240, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("CHECK_TARGET_FAILED", "check-target.py did not run") from exc
        first = (done.stderr.decode("utf-8", "replace").strip().splitlines() or [""])[0][:300]
        require(done.returncode == 0, "CHECK_TARGET_FAILED", "check-target.py --site failed: " + first)
        emit("check-target", result="PASS", site=self.site)

    # Node transport ------------------------------------------------------
    def ssh(self, payload, timeout=300):
        source = (self.root / "deploy" / "preview" / "node" / "bootstrap.py").read_text()
        encoded = base64.b64encode(json.dumps(payload).encode()).decode()
        program = source + f"\nmain(json.loads(base64.b64decode({encoded!r}).decode()))\n"
        route = self.profile["ssh"]
        argv = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=12", "-oStrictHostKeyChecking=yes",
                "-oUserKnownHostsFile=" + route["knownHostsFile"], "-oServerAliveInterval=15", "-oServerAliveCountMax=4",
                "-J", route["jump"], route["host"], "sudo -n python3 -"]
        try:
            done = subprocess.run(argv, input=program.encode(), capture_output=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("NODE_UNREACHABLE", "the SSH route to the node failed or timed out") from exc
        lines = done.stdout.decode("utf-8", "replace").strip().splitlines()
        require(done.returncode == 0 and lines and len(done.stdout) <= 16 * 1024 * 1024, "NODE_UNREACHABLE",
                f"the node command exited {done.returncode}")
        reply = strict_json(lines[-1], "node reply")
        if reply.get("result") == "REFUSED":
            raise Refusal(reply.get("code", "NODE_REFUSED"), reply.get("reason", "the node refused"))
        return reply

    def request(self, kind, deploy_id, **extra):
        profile, anchors = self.profile, self.anchors
        node, deployment = profile["node"], profile["deployment"]
        target = {"version": 1,
                  "transport": {"type": "local", "kubectl": [node["k3s"], "kubectl"], "kubeconfig": node["kubeconfig"],
                                "context": node["context"]},
                  "clusterUID": node["clusterUID"], "node": {"name": node["name"], "uid": node["uid"]},
                  "components": {anchors["component"]: {
                      "namespace": anchors["namespace"], "namespaceUID": deployment["namespaceUID"],
                      "deployment": anchors["deployment"], "deploymentUID": deployment["deploymentUID"],
                      "container": anchors["container"], "requiredLabels": deployment["requiredLabels"]}}}
        smoke, watch = profile["smoke"], profile["watch"]
        request = {"version": 1, "kind": kind, "site": self.site, "deployId": deploy_id, "tool": self.tool_hash,
                   "target": target, "k3s": node["k3s"], "modelsRelease": profile["models"]["release"],
                   "drillFailSmoke": bool(getattr(self.args, "drill_fail_smoke", False)),
                   "clearHold": bool(getattr(self.args, "clear_hold", False)), "liveSource": None,
                   "limits": {"rolloutTimeoutSeconds": profile["rolloutTimeoutSeconds"], "watchMinutes": watch["minutes"],
                              "watchIntervalSeconds": watch["intervalSeconds"], "watchFailures": watch["failures"],
                              "memoryFraction": smoke["memoryFraction"], "retainPreviousImages": profile["retainPreviousImages"],
                              "maxAddedPages": smoke["maxAddedPages"], "edgeAddress": smoke["edgeAddress"], "needBytes": 0}}
        request.update(extra)
        return request

    def read(self, op, **extra):
        query = {"op": op, "request": self.request("read", self.deploy_id("read")), **extra}
        return self.ssh({"action": "read", "bundle": bundle(self.root), "query": query})["data"]

    def start_and_follow(self, request):
        emit("starting", deployId=request["deployId"], kind=request["kind"])
        self.ssh({"action": "start", "bundle": bundle(self.root), "request": request})
        return self.follow(request["deployId"])

    def follow(self, deploy_id, poll_seconds=5, max_failures=24):
        """Print the unit's progress until it ends. A dropped link only pauses this; the unit keeps going."""
        offset, failures, idle = 0, 0, 0
        while True:
            try:
                state = self.ssh({"action": "poll", "deployId": deploy_id, "offset": offset}, timeout=60)
            except Refusal as exc:
                failures += 1
                emit("follow", note="node unreachable; the unit keeps running", code=exc.code, attempt=failures)
                if failures >= max_failures:
                    return {"result": "DETACHED", "deployId": deploy_id,
                            "reason": "lost the node; run status to see the live phase"}
                SLEEP(poll_seconds)
                continue
            failures = 0
            for line in state.get("progress", []):
                print(line, flush=True)
            offset = state.get("offset", offset)
            if state.get("unit") not in BUSY:
                if state.get("result"):
                    return state["result"]
                idle += 1
                if idle >= 3:
                    return {"result": "STOPPED_WITHOUT_RESULT", "deployId": deploy_id, "reason": "inspect with status"}
            SLEEP(poll_seconds)

    def deploy_id(self, kind, sha=None):
        stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
        return f"{stamp}-tools-{kind}" + (f"-{sha[:8]}" if sha else "")

    # Expectations --------------------------------------------------------
    def expectations(self, sha, build_created_at):
        anchors, gh = self.anchors, self.gh
        headers = expected_headers(G.source_file(gh, anchors, anchors["securityHeadersPath"], sha).decode("utf-8"),
                                   G.source_file(gh, anchors, anchors["nginxConfPath"], sha).decode("utf-8"),
                                   G.connector_origins(gh, anchors, build_created_at))
        manifest = G.source_file(gh, anchors, anchors["modelsManifestPath"], sha)
        require(sha256_hex(manifest) == self.profile["models"]["manifestSha256"], "MODELS_CHANGED",
                "this build's models manifest differs from the mounted models release; run the models procedure first")
        formats = stored_formats(lambda path: G.source_file(gh, anchors, path, sha), A.STORED_FORMATS)
        expect = {"source": sha, "profile": anchors["profile"], "headers": headers, "models": models_sample(manifest),
                  "pages": [{"path": page["path"], "file": page["file"]} for page in self.profile["smoke"]["pages"]]}
        return expect, formats

    def need_bytes(self, image):
        compressed = G.registry_image_bytes(image, self.anchors, self.opener)
        capacity = self.profile["capacity"]
        return max(int(capacity["minFreeAboveReserveBytes"]), int(capacity["imageSizeFactor"]) * compressed + GIB)


def _phase_hold(context, preview):
    phase = preview.get("phase")
    if phase in A.UNCERTAIN_PHASES + ("rollback-unhealthy",) and not context.args.clear_hold:
        raise Refusal("HELD_FOR_HUMAN", f"the live phase is {phase.upper()}; inspect with status, then pass --clear-hold")


def _finish(context, command, result, **fields):
    name = result.get("result", "REFUSED")
    context.record(command, name, **{k: v for k, v in result.items() if k in ("deployId", "reason", "code", "problem",
                                                                              "source", "image", "previous")}, **fields)
    emit("done", **{k: v for k, v in result.items() if k not in ("checks", "rollbackChecks")})
    return RESULT_EXIT.get(name, 1)


def deploy_bound(context, command, sha, bound):
    """Second half of ship, and all of deploy: expectations, checks, then the node unit."""
    anchors, gh = context.anchors, context.gh
    status = context.read("status")
    preview, deployment = status.get("preview", {}), status["deployment"]
    if deployment["image"] == bound["image"]:
        return _finish(context, command, {"result": "ALREADY_LIVE", "image": bound["image"], "source": sha})
    require(deployment["converted"], "NOT_CONVERTED", "lolly.tools still serves the claim root; run the 3.6 conversion plan first")
    _phase_hold(context, preview)
    live_source = preview.get("source")
    require(isinstance(live_source, str) and SHA.fullmatch(live_source) is not None, "NO_PREVIOUS_RECORD",
            "the live release carries no preview records")
    expect, formats = context.expectations(sha, bound.get("runCreatedAt"))
    forward = gh.json(f"repos/{anchors['repository']}/compare/{live_source}...{sha}").get("status") in ("ahead", "identical")
    if not forward:
        lowering = format_lowering(_json_or_none(preview.get("formats")), formats)
        require(not lowering, "FORMAT_LOWERING", "this older build would lower stored formats (" + ", ".join(lowering) +
                "); roll forward instead")
    need = context.need_bytes(bound["image"])
    deploy_id = context.deploy_id("deploy", sha)
    request = context.request("deploy", deploy_id, liveSource=live_source,
                              release={"source": sha, "image": bound["image"], "ciRun": str(bound["run"]),
                                       "formats": formats, "expect": expect})
    request["limits"]["needBytes"] = need
    context.backup_window()
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, command, result, sha=sha, ciRun=bound["run"])


def _json_or_none(text):
    try:
        return strict_json(text, "annotation") if text else None
    except Refusal:
        return None


def cmd_ship(context, sha):
    anchors, gh = context.anchors, context.gh
    require(G.main_head(gh, anchors) == sha, "NOT_MAIN_HEAD",
            "Phase 1 ships only the current main head (the candidate build refuses older commits); use deploy for a built commit")
    status = context.read("status")
    preview = status.get("preview", {})
    if preview.get("source") == sha and preview.get("phase") == "accepted":
        return _finish(context, "ship", {"result": "ALREADY_LIVE", "source": sha, "image": status["deployment"]["image"]})
    require(status["deployment"]["converted"], "NOT_CONVERTED", "run the 3.6 conversion plan first")
    _phase_hold(context, preview)
    ci = G.green_ci_run(gh, anchors, sha)
    active = G.active_candidate_runs(gh, anchors)
    if active:
        raise Refusal("CANDIDATE_ACTIVE", f"another candidate run is active ({active[0]}); wait for it or cancel it")
    known = {run["id"] for run in G.dispatch_runs(gh, anchors, sha)}
    G.dispatch_build(gh, anchors, sha, ci["id"], context.pin)
    emit("dispatched", source=sha, ciRun=ci["id"])
    run = G.find_new_run(gh, anchors, sha, known)
    run = G.wait_for_run(gh, anchors, run["id"], context.profile["build"]["pollSeconds"], context.profile["build"]["timeoutMinutes"])
    bound = G.bind_run(gh, anchors, run, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT)
    emit("bound", run=bound["run"], image=bound["image"])
    return deploy_bound(context, "ship", sha, bound)


def cmd_deploy(context, sha):
    G.require_on_main(context.gh, context.anchors, sha)
    bound = G.latest_bound_run(context.gh, context.anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT)
    emit("bound", run=bound["run"], image=bound["image"])
    return deploy_bound(context, "deploy", sha, bound)


def cmd_rollback(context):
    status = context.read("status")
    preview = status.get("preview", {})
    _phase_hold(context, preview)
    previous = _json_or_none(preview.get("previous"))
    require(isinstance(previous, dict) and isinstance(previous.get("source"), str), "NO_PREVIOUS",
            "no recorded previous build; deploy a build instead")
    lowering = format_lowering(_json_or_none(preview.get("formats")), previous.get("formats"))
    require(not lowering, "FORMAT_LOWERING", "rolling back would lower stored formats (" + ", ".join(lowering) +
            "); roll forward instead")
    request = context.request("rollback", context.deploy_id("rollback", previous["source"]), rollbackTo=previous["source"])
    context.backup_window()
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "rollback", result, sha=previous["source"])


def cmd_status(context):
    status = context.read("status")
    preview = status.get("preview", {})
    phase = preview.get("phase") or "none"
    emit("status", phase=phase if phase == "accepted" else phase.upper(), source=preview.get("source"),
         image=status["deployment"]["image"], ready=status["deployment"]["ready"], converted=status["deployment"]["converted"],
         revision=status["deployment"]["revision"], unit=status.get("unit"), pods=status.get("pods"),
         deployId=preview.get("deploy-id"), reason=preview.get("reason"), lastResult=status.get("lastResult"))
    return 0


def cmd_gc(context, execute):
    report = context.read("gc", legacyClaims=context.profile["gc"]["legacyClaims"])
    emit("gc-images", keep=report["images"]["keep"], remove=report["images"]["remove"],
         removeBytes=report["images"]["removeBytes"])
    node = context.profile["node"]
    for claim in report["claims"]:
        command = (f"sudo {node['k3s']} kubectl --kubeconfig {node['kubeconfig']} --context {node['context']} "
                   f"delete pvc {claim['name']} --namespace {context.anchors['namespace']}")
        emit("gc-claim", name=claim["name"], uid=claim["uid"], candidate=claim["candidate"], blockedBy=claim["blockedBy"],
             referencedBy=claim["referencedBy"],
             forAndy=(command + "   # Andy runs this himself; deleting a local-path claim deletes its data")
             if claim["candidate"] else None)
    if not execute:
        return 0
    request = context.request("gc", context.deploy_id("gc"))
    context.backup_window()
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "gc --execute", result)


IMAGE_NGINX_FILES = (("default.conf", "nginxConfPath"), ("security-headers.conf", "securityHeadersPath"),
                     ("delivery-maps.conf", "deliveryMapsPath"), ("delivery-headers.conf", "deliveryHeadersPath"))


def cmd_plan(context, sha):
    """PROPOSAL 3.6 plan mode: print the exact guarded patch and the nginx diff; change nothing."""
    anchors, gh = context.anchors, context.gh
    G.require_on_main(gh, anchors, sha)
    bound = G.latest_bound_run(gh, anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT)
    expect, formats = context.expectations(sha, bound.get("runCreatedAt"))
    live = context.read("plan")
    deployment = live["deployment"]
    index = [c["name"] for c in deployment["spec"]["template"]["spec"]["containers"]].index(anchors["container"])
    live_image = deployment["spec"]["template"]["spec"]["containers"][index]["image"]
    require(live_image == bound["image"], "IMAGE_DIFFERS",
            "the conversion serves the bytes that are live now; plan it for the live build's commit")
    deploy_id = context.deploy_id("convert", sha)
    release = {"source": sha, "image": bound["image"], "ciRun": str(bound["run"]), "formats": formats, "expect": expect}
    annotations = {A.ANNOTATION_PREFIX + name: value for name, value in {
        "phase": "converting", "deploy-id": deploy_id, "source": sha, "image": bound["image"], "ci-run": str(bound["run"]),
        "tool": context.tool_hash, "formats": compact(formats), "expect": compact(expect), "layout": "image-root",
        "deploys": "0", "previous": None, "reason": None, "updated": utc_stamp()}.items()}
    conversion = conversion_plan(deployment, anchors, annotations)
    conversion.update({"deployId": deploy_id, "tool": context.tool_hash})
    nginx = G.source_file(gh, anchors, anchors["nginxConfPath"], sha).decode("utf-8")
    origins = G.connector_origins(gh, anchors, bound.get("runCreatedAt"))
    image_files = {"default.conf": configured_nginx_conf(nginx, origins)}
    for name, path_key in IMAGE_NGINX_FILES[1:]:
        image_files[name] = G.source_file(gh, anchors, anchors[path_key], sha).decode("utf-8")
    configmap = live.get("configMaps", {}).get("nginx", {})
    diff = []
    for name, text in image_files.items():
        mounted = configmap.get("data", {}).get(name, "")
        diff += list(difflib.unified_diff(mounted.splitlines(True), text.splitlines(True),
                                          f"configmap/{configmap.get('name', '?')}/{name}", f"image@{sha[:12]}/{name}"))
    smoke = context.read("smoke", expect=expect)
    plan = {"version": 1, "kind": "convert", "site": context.site, "source": sha, "deployId": deploy_id,
            "tool": context.tool_hash, "createdAt": utc_stamp(), "run": {k: bound[k] for k in ("run", "attempt", "image", "imageId")},
            "release": release, "conversion": conversion, "nginxDiff": "".join(diff), "preConversionSmoke": smoke}
    plans = context.state_dir / "plans"
    plans.mkdir(mode=0o700, exist_ok=True)
    path = plans / (deploy_id + ".json")
    write_private_new(path, json.dumps(plan, indent=2, sort_keys=True) + "\n")
    print(json.dumps(conversion["patch"], indent=2))
    print("".join(diff) or "(the image's nginx files equal the ConfigMap)")
    emit("plan", path=str(path), reviewedPlanSha256=compact_digest(plan), removedVolumes=conversion["removedVolumes"],
         preConversionSmoke=[item for item in smoke["checks"] if not item["ok"]] or "all passed",
         next="review, then: plan <sha> --apply PATH --reviewed-plan-sha256 HASH (named owner, Andy present)")
    return 0


def cmd_plan_apply(context, sha, path, reviewed):
    plan = strict_json(Path(path).read_text(), "plan")
    require(isinstance(reviewed, str) and HEX64.fullmatch(reviewed) is not None
            and hmac.compare_digest(compact_digest(plan), reviewed), "PLAN_MISMATCH", "the plan hash differs from the reviewed hash")
    require(plan.get("kind") == "convert" and plan.get("site") == context.site and plan.get("source") == sha,
            "PLAN_MISMATCH", "the plan is for another site or commit")
    require(plan.get("tool") == context.tool_hash, "PLAN_TOOL_CHANGED", "the tool changed since the plan; make a new plan")
    request = context.request("convert", plan["deployId"], release=plan["release"], conversion=plan["conversion"])
    context.backup_window()
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "plan --apply", result, sha=sha)


def parser():
    p = argparse.ArgumentParser(prog="preview-deploy", description="Deploy the lolly.tools preview from one main commit.")
    p.add_argument("--state-dir", required=True, help="private preview directory holding <site>.json and deploys.jsonl")
    p.add_argument("--tool-sha256", required=True, help="tool hash checked by launch.py against tool.lock.json")
    p.add_argument("--checkout", required=True, help="the lolly-work checkout the tool was copied from")
    p.add_argument("--check-target", required=True, help="path of check-target.py (needs --site)")
    p.add_argument("--tool-root", help=argparse.SUPPRESS)
    p.add_argument("site", choices=sorted(A.SITES))
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("ship", "deploy"):
        s = sub.add_parser(name)
        s.add_argument("sha")
        s.add_argument("--drill-fail-smoke", action="store_true", help="force a smoke failure to drill the automatic rollback")
        s.add_argument("--clear-hold", action="store_true", help="proceed although the live phase needs a human")
    s = sub.add_parser("rollback")
    s.add_argument("--clear-hold", action="store_true")
    sub.add_parser("status")
    s = sub.add_parser("gc")
    s.add_argument("--execute", action="store_true", help="remove images outside retention (never claims)")
    s = sub.add_parser("plan")
    s.add_argument("sha")
    s.add_argument("--apply", metavar="PLAN")
    s.add_argument("--reviewed-plan-sha256")
    s.add_argument("--drill-fail-smoke", action="store_true")
    s.add_argument("--clear-hold", action="store_true")
    return p


MUTATING = {"ship", "deploy", "rollback"}


def main(argv=None, gh=None, opener=None):
    args = parser().parse_args(argv)
    context = None
    try:
        A.site_anchors(args.site)  # lolly.ing refuses here: Phase 2 is not built
        if getattr(args, "sha", None) is not None:
            require(SHA.fullmatch(args.sha) is not None, "BAD_SHA", "pass a full 40-character commit")
        context = Context(args, gh=gh, opener=opener)
        context.check_tool_checkout()
        if args.command == "ship":
            return cmd_ship(context, args.sha)
        if args.command == "deploy":
            return cmd_deploy(context, args.sha)
        if args.command == "rollback":
            return cmd_rollback(context)
        if args.command == "status":
            return cmd_status(context)
        if args.command == "gc":
            return cmd_gc(context, args.execute)
        if args.apply:
            return cmd_plan_apply(context, args.sha, args.apply, args.reviewed_plan_sha256)
        return cmd_plan(context, args.sha)
    except Refusal as exc:
        emit("refused", code=exc.code, reason=exc.message)
        mutating = args.command in MUTATING or (args.command == "gc" and args.execute) or \
            (args.command == "plan" and args.apply)
        if context is not None and mutating:
            context.record(args.command, "REFUSED", code=exc.code, reason=exc.message[:500], sha=getattr(args, "sha", None))
        return 1
