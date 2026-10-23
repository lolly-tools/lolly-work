# SPDX-License-Identifier: MPL-2.0
"""Operator side of the preview deploy command: ship, deploy, rollback, status, gc, plan and selftest.

Inputs are only a site and a commit. Everything else comes from the bound CI
run, the source commit's own files, the live cluster, check-target.py's
identities and the private profile (pages, thresholds and the models release).
"""

from __future__ import annotations

import argparse
import ast
import base64
import difflib
import gzip
import hashlib
import hmac
import importlib.util
import io
import json
import os
import re
import shlex
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
from preview_expect import (configure_connect_src, configured_nginx_conf, csp_default, expected_headers, format_lowering,
                            models_sample, parse_connector_origins, stored_formats)
from preview_layout import conversion_plan

TOOL_PATHS = ("deploy/preview", "scripts/app-update.py")
LIB = Path(__file__).resolve().parent
TOOL_ROOT = LIB.parents[2]  # <root>/deploy/preview/lib -> <root>; tests point it at their copy
# The one private state directory (review R1). A copy elsewhere, even one whose path ends the
# same way, is refused. Tests point it at their own tree.
STATE_DIR = Path.home() / "Build" / "lolly-private" / "production" / "preview"
BUSY = ("active", "activating", "deactivating", "reloading", "refreshing")
RESULT_EXIT = {"LIVE": 0, "ALREADY_LIVE": 0, "CONVERTED": 0, "ALREADY_CONVERTED": 0, "GC_DONE": 0, "SELFTEST_OK": 0,
               "ADOPTED": 0, "ROLLED_BACK": 2, "CONVERSION_REVERTED": 2, "ROLLBACK_UNHEALTHY": 3, "ADOPTED_UNHEALTHY": 3}
GIB = 2 ** 30
SLEEP = time.sleep
LAUNCHER_OPTIONS = ("--state-dir", "--tool-sha256", "--checkout", "--check-target")
LOCK_KEYS = {"version", "repository", "checkout", "commit", "toolSha256", "files", "generatedAt", "note"}
UID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


# Tool identity ---------------------------------------------------------------
def tool_files(root):
    """(relative path, absolute path) for every file the tool lock covers. Bytecode caches are not part of the tool."""
    root = Path(root)
    entries = []
    preview = root / "deploy" / "preview"
    require(preview.is_dir() and not preview.is_symlink(), "TOOL_INVALID", "deploy/preview is missing")
    for path in sorted(preview.rglob("*")):
        if "__pycache__" in path.relative_to(root).parts:
            continue
        require(not path.is_symlink(), "TOOL_INVALID", "the tool tree holds a symbolic link")
        if path.is_file():
            entries.append((path.relative_to(root).as_posix(), path))
        else:
            require(path.is_dir(), "TOOL_INVALID", "the tool tree holds a special file")
    app_update = root / "scripts" / "app-update.py"
    require(app_update.is_file() and not app_update.is_symlink(), "TOOL_INVALID", "scripts/app-update.py is missing")
    entries.append(("scripts/app-update.py", app_update))
    return sorted(entries)


def digest_of(entries):
    """sha256 over 'path NUL mode NUL sha256 LF' lines. launch.py computes the same value."""
    lines = []
    for relative, path in sorted(entries):
        require(not Path(path).is_symlink(), "TOOL_INVALID", "the tool tree holds a symbolic link")
        mode = "x" if os.stat(path).st_mode & stat.S_IXUSR else "-"
        lines.append(f"{relative}\0{mode}\0{hashlib.sha256(Path(path).read_bytes()).hexdigest()}\n")
    return hashlib.sha256("".join(lines).encode()).hexdigest()


def tool_digest(root):
    return digest_of(tool_files(root))


def bundle(root):
    """Deterministic tar.gz of the tool tree plus app-update.py, laid out as the node expects."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for relative, path in tool_files(root):
            name = "app-update.py" if relative == "scripts/app-update.py" else relative[len("deploy/preview/"):]
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.uid, info.gid = len(data), 0, 0, 0
            info.mode = 0o500 if os.stat(path).st_mode & stat.S_IXUSR else 0o400
            archive.addfile(info, io.BytesIO(data))
    return base64.b64encode(gzip.compress(buffer.getvalue(), mtime=0)).decode()  # no clock in the gzip header


def check_argv(argv):
    """The launcher's four options, each exactly once, as separate words, before the site (review S-H1)."""
    sites = [index for index, word in enumerate(argv) if word in A.SITES]
    require(bool(sites), "BAD_ARGUMENTS", "name a site")
    head, tail = argv[:sites[0]], argv[sites[0]:]
    for option in LAUNCHER_OPTIONS:
        require(head.count(option) == 1, "BAD_ARGUMENTS", f"{option} must be given exactly once, before the site")
    require(len(head) == 2 * len(LAUNCHER_OPTIONS) and all(head[i] in LAUNCHER_OPTIONS for i in range(0, len(head), 2)),
            "BAD_ARGUMENTS", "only the launcher's options may precede the site")
    for word in tail:
        name = word.split("=", 1)[0]
        require(not (word.startswith("--") and name in LAUNCHER_OPTIONS), "BAD_ARGUMENTS", f"{name} is a launcher option")


def read_lock(state_dir):
    path = Path(state_dir) / "tool.lock.json"
    require(path.is_file() and not path.is_symlink(), "TOOL_NOT_LOCKED", "tool.lock.json is missing from the state dir")
    lock = strict_json(path.read_text(), "tool lock")
    require(isinstance(lock, dict) and set(lock) == LOCK_KEYS and lock["version"] == 1 and lock["repository"] == A.TOOL_REPOSITORY
            and isinstance(lock["toolSha256"], str) and HEX64.fullmatch(lock["toolSha256"]) is not None
            and isinstance(lock["files"], dict) and lock["files"], "TOOL_NOT_LOCKED", "tool.lock.json is malformed")
    return lock


def load_check_target(path):
    """The identities check-target.py checks, so the profile carries no identity of its own (review S-M3)."""
    spec = importlib.util.spec_from_file_location("preview_check_target", str(path))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        route = list(module.CURRENT_SSH)
        known = [word.split("=", 1)[1] for word in route if word.startswith("-oUserKnownHostsFile=")]
        jump = route[route.index("-J") + 1]
        found = re.search(r"\bk=\[(.*?)\]", module.CURRENT_READ, re.S)
        kubectl = ast.literal_eval("[" + found.group(1) + "]")
        identity = {
            "knownHostsFile": known[0], "jump": jump, "host": route[-1],
            "k3s": kubectl[0], "kubeconfig": kubectl[kubectl.index("--kubeconfig") + 1],
            "context": kubectl[kubectl.index("--context") + 1],
            "nodeName": module.NODE_NAME, "nodeUID": module.NODE_UID, "clusterUID": module.CLUSTER_UID,
            "namespaceUID": module.NAMESPACE_UIDS[A.TOOLS["namespace"]],
            "deploymentUID": module.SITE_DEPLOYMENTS[A.TOOLS["checkTargetDeployment"]],
            "edgeAddress": module.ADDRESS,
        }
    except (AttributeError, IndexError, KeyError, ValueError, SyntaxError, TypeError, OSError) as exc:
        raise Refusal("CHECK_TARGET_IDENTITY", "check-target.py does not carry the --site identities "
                      "(apply check-target-site.patch first)") from exc
    require(len(known) == 1 and os.path.isabs(known[0]) and kubectl[1] == "kubectl" and os.path.isabs(identity["k3s"])
            and os.path.isabs(identity["kubeconfig"]) and all(re.fullmatch(r"[A-Za-z0-9_.@-]+", identity[k]) for k in ("jump", "host"))
            and all(UID.fullmatch(str(identity[k])) for k in ("nodeUID", "clusterUID", "namespaceUID", "deploymentUID")),
            "CHECK_TARGET_IDENTITY", "check-target.py identities are malformed")
    return identity


# Profile ---------------------------------------------------------------------
PROFILE_KEYS = {"version", "site", "models", "smoke", "watch", "build", "rolloutTimeoutSeconds", "capacity",
                "retainPreviousImages", "noDeployUtc", "gc"}


def load_profile(state_dir, site):
    """The private profile: pages, thresholds and the models release only. Identities and anchors are elsewhere."""
    path = Path(state_dir) / (site + ".json")
    require(path.is_file() and not path.is_symlink(), "PROFILE_INVALID", f"{path.name} is missing from the state dir")
    require(not (path.stat().st_mode & 0o022), "PROFILE_INVALID", "the profile must not be group or world writable")
    profile = strict_json(path.read_text(), "profile")
    require(isinstance(profile, dict) and set(profile) == PROFILE_KEYS and profile["version"] == 1 and profile["site"] == site,
            "PROFILE_INVALID", "profile fields do not match version 2 of the profile for this site")
    models = profile["models"]
    require(isinstance(models, dict) and set(models) == {"release", "manifestSha256"}
            and re.fullmatch(r"models-[0-9a-f]{64}", models["release"]) and HEX64.fullmatch(models["manifestSha256"]),
            "PROFILE_INVALID", "models")
    smoke = profile["smoke"]
    require(isinstance(smoke, dict) and set(smoke) == {"pages", "maxAddedPages", "memoryFraction"}, "PROFILE_INVALID", "smoke")
    require(isinstance(smoke["pages"], list) and 1 <= len(smoke["pages"]) <= 12, "PROFILE_INVALID", "smoke pages")
    watch, build = profile["watch"], profile["build"]
    require(isinstance(watch, dict) and set(watch) == {"minutes", "intervalSeconds", "failures"}
            and 0 <= watch["minutes"] <= A.MAX_WATCH_MINUTES, "PROFILE_INVALID", "watch")
    require(isinstance(build, dict) and set(build) == {"pollSeconds", "timeoutMinutes"}, "PROFILE_INVALID", "build")
    require(type(profile["rolloutTimeoutSeconds"]) is int and 30 <= profile["rolloutTimeoutSeconds"] <= A.MAX_ROLLOUT_SECONDS,
            "PROFILE_INVALID", "rolloutTimeoutSeconds")
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
        self.state_dir = Path(args.state_dir).resolve()
        require(self.state_dir == Path(STATE_DIR).resolve() and self.state_dir.parts[-3:] == A.STATE_DIR_SUFFIX
                and self.state_dir.is_dir(), "STATE_DIR_INVALID", f"the state dir must be {STATE_DIR}")
        require(not (self.state_dir.stat().st_mode & 0o022), "STATE_DIR_INVALID", "the state dir must not be group or world writable")
        production = self.state_dir.parent.lstat()
        require(stat.S_ISDIR(production.st_mode) and production.st_uid == os.getuid() and stat.S_IMODE(production.st_mode) == 0o700,
                "STATE_DIR_INVALID", "lolly-private/production must be a 0700 directory owned by this user")
        self.check_target_path = self.state_dir.parent / "check-target.py"
        require(Path(args.check_target).resolve() == self.check_target_path.resolve() and self.check_target_path.is_file(),
                "CHECK_TARGET_PATH", "check-target.py must be the one beside the state dir")
        self.lock = read_lock(self.state_dir)
        self.root = Path(TOOL_ROOT)
        self.tool_hash = tool_digest(self.root)
        require(hmac.compare_digest(self.tool_hash, self.lock["toolSha256"]) and hmac.compare_digest(self.tool_hash, args.tool_sha256),
                "TOOL_HASH_MISMATCH", "the running tool differs from tool.lock.json")
        require(Path(args.checkout).resolve() == Path(self.lock["checkout"]).resolve(), "TOOL_HASH_MISMATCH",
                "the checkout differs from the locked checkout")
        self.check_target_sha256 = sha256_hex(self.check_target_path.read_bytes())
        self.identity = load_check_target(self.check_target_path)
        self.profile = load_profile(self.state_dir, args.site)
        self.gh = gh or G.Gh()
        self.opener = opener
        self.pin = A.RELEASE_PUBLIC_KEY_JWK
        self.started = utc_stamp()

    # Records -------------------------------------------------------------
    def record(self, command, result, **fields):
        entry = {"site": self.site, "command": command, "result": result, "tool": self.tool_hash,
                 "profileSha256": self.profile["_sha256"], "start": self.started, "end": utc_stamp(), **fields}
        path = self.state_dir / "deploys.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as out:
            out.write(json.dumps(entry, sort_keys=True) + "\n")

    def records(self):
        path = self.state_dir / "deploys.jsonl"
        if not path.exists():
            return []
        rows = []
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        return rows

    # Preconditions -------------------------------------------------------
    def check_tool_checkout(self):
        """The locked files in the checkout are unchanged and its commit is on lolly-work main (S-H1, S-L3)."""
        checkout = Path(self.args.checkout)
        try:
            status = subprocess.run(["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=no", "--", *TOOL_PATHS],
                                    capture_output=True, timeout=60, check=True).stdout
            head = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True,
                                  timeout=60, check=True).stdout.decode().strip()
        except (OSError, subprocess.SubprocessError) as exc:
            raise Refusal("TOOL_NOT_MAIN", "cannot read the tool checkout") from exc
        require(not status, "TOOL_DIRTY", "the tool checkout has local changes in its tool paths")
        require(SHA.fullmatch(head) is not None, "TOOL_NOT_MAIN", "tool checkout HEAD is unreadable")
        listed = [(relative, checkout / relative) for relative in self.lock["files"]]
        require(all(path.is_file() for _, path in listed) and digest_of(listed) == self.tool_hash, "TOOL_HASH_MISMATCH",
                "the checkout's locked files differ from the running tool")
        # git status trusts assume-unchanged and clean filters; compare the bytes with HEAD's blobs (review R2).
        for relative, path in listed:
            try:
                blob = subprocess.run(["git", "-C", str(checkout), "cat-file", "blob", f"HEAD:{relative}"],
                                      capture_output=True, timeout=60, check=True).stdout
            except (OSError, subprocess.SubprocessError) as exc:
                raise Refusal("TOOL_DIRTY", f"{relative} is not committed at HEAD") from exc
            require(blob == path.read_bytes(), "TOOL_DIRTY", f"{relative} differs from the committed file")
        main_sha = G.branch_head(self.gh, A.TOOL_REPOSITORY)
        require(G.contains(self.gh, A.TOOL_REPOSITORY, head, main_sha), "TOOL_NOT_MAIN", "the tool checkout is not on lolly-work main")
        return head

    def worst_case_seconds(self, kind):
        """How long a run of this kind can last on the node (review L2)."""
        rollout, watch = self.profile["rolloutTimeoutSeconds"], self.profile["watch"]["minutes"] * 60
        pull, smoke = A.PULL_TIMEOUT_SECONDS, A.SMOKE_BUDGET_SECONDS
        return {"deploy": 2 * pull + 2 * rollout + watch + 3 * smoke + 300,
                "rollback": pull + rollout + watch + smoke + 300,
                "convert": pull + 2 * rollout + watch + 2 * smoke + 300,
                "adopt": smoke + 300, "gc": A.GC_BUDGET_SECONDS}[kind]

    def backup_window(self, kind):
        """Refuse a run whose worst-case end could reach the backup window, not only one that starts in it."""
        start, end = self.profile["noDeployUtc"]
        first, last = (int(t[:2]) * 60 + int(t[3:]) for t in (start, end))
        now = utc_now()
        begin = now.hour * 60 + now.minute
        span = -(-self.worst_case_seconds(kind) // 60)
        inside = any((first <= (minute % 1440) < last) if first <= last else
                     ((minute % 1440) >= first or (minute % 1440) < last) for minute in range(begin, begin + span + 1))
        require(not inside, "BACKUP_WINDOW", f"a {kind} run can last {span} minutes and would reach the {start}-{end} UTC "
                                             "backup window; start it later")

    def check_target(self):
        """check-target.py --site, once, immediately before the run starts (decision 8).
        It must be the same file the identities were read from (review R1)."""
        require(sha256_hex(self.check_target_path.read_bytes()) == self.check_target_sha256, "CHECK_TARGET_CHANGED",
                "check-target.py changed while the command ran")
        try:
            done = subprocess.run([sys.executable, "-I", "-B", str(self.check_target_path), "--site", self.site],
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
        route = self.identity
        argv = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=12", "-oStrictHostKeyChecking=yes",
                "-oUserKnownHostsFile=" + route["knownHostsFile"], "-oServerAliveInterval=15", "-oServerAliveCountMax=4",
                "-J", route["jump"], route["host"], "sudo -n python3 -I -"]
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
                   "target": target, "k3s": identity["k3s"], "modelsRelease": profile["models"]["release"],
                   "drillFailSmoke": bool(getattr(self.args, "drill_fail_smoke", False)),
                   "clearHold": bool(getattr(self.args, "clear_hold", False)), "liveSource": None,
                   "limits": {"rolloutTimeoutSeconds": profile["rolloutTimeoutSeconds"], "watchMinutes": watch["minutes"],
                              "watchIntervalSeconds": watch["intervalSeconds"], "watchFailures": watch["failures"],
                              "memoryFraction": smoke["memoryFraction"], "retainPreviousImages": profile["retainPreviousImages"],
                              "maxAddedPages": smoke["maxAddedPages"], "edgeAddress": identity["edgeAddress"],
                              "needBytes": int(profile["capacity"]["minFreeAboveReserveBytes"]),
                              "noDeployUtc": list(profile["noDeployUtc"])}}
        request.update(extra)
        return request

    def read(self, op, **extra):
        query = {"op": op, "request": self.request("read", self.deploy_id("read")), **extra}
        return self.ssh({"action": "read", "bundle": bundle(self.root), "query": query})["data"]

    def start_and_follow(self, request):
        """Start the unit. A lost reply is uncertain, never a failure: poll by deploy id (review C-M8)."""
        emit("starting", deployId=request["deployId"], kind=request["kind"])
        try:
            self.ssh({"action": "start", "bundle": bundle(self.root), "request": request})
        except Refusal as exc:
            if exc.code != "NODE_UNREACHABLE":
                raise
            emit("start-uncertain", deployId=request["deployId"], note="no reply from the node; looking for the run by its id")
            return self.follow(request["deployId"], must_appear=True)
        return self.follow(request["deployId"])

    def follow(self, deploy_id, poll_seconds=5, max_failures=24, must_appear=False):
        """Print the unit's progress until it ends. A dropped link only pauses this; the unit keeps going."""
        offset, failures, idle, seen, announced = 0, 0, 0, not must_appear, False
        while True:
            try:
                state = self.ssh({"action": "poll", "deployId": deploy_id, "offset": offset}, timeout=60)
            except Refusal as exc:
                failures += 1
                emit("follow", note="node unreachable; the unit keeps running", code=exc.code, attempt=failures)
                if failures >= max_failures:
                    return {"result": "DETACHED", "deployId": deploy_id,
                            "reason": f"lost the node; run status --follow {deploy_id}"}
                SLEEP(poll_seconds)
                continue
            failures = 0
            seen = seen or state.get("current") == deploy_id or bool(state.get("result"))
            if not announced and state.get("unit") in BUSY and state.get("current") == deploy_id:
                emit("following", deployId=deploy_id, unit=state.get("unit"))
                announced = True
            for line in state.get("progress", []):
                print(line, flush=True)
            offset = state.get("offset", offset)
            if state.get("unit") not in BUSY:
                if state.get("result"):
                    return state["result"]
                idle += 1
                if idle >= 3:
                    if not seen:
                        return {"result": "REFUSED", "code": "NOT_STARTED", "deployId": deploy_id,
                                "reason": "the run never reached the node; nothing was changed"}
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

    def check_live_origins(self, preview):
        """The connector origins variable must still reproduce the CSP recorded for the live build,
        unless it changed after that build (review C-H4). Recording the origins in Lolly's signed
        receipt would make this exact; that is a lolly-side follow-up."""
        anchors, gh = self.anchors, self.gh
        live = _json_or_none(preview.get("expect"))
        if not isinstance(live, dict) or not preview.get("ci-run"):
            return
        value, updated, scope = G.connector_origins_variable(gh, anchors)
        built = G.run_created_at(gh, anchors, preview["ci-run"])
        if updated and G.parse_utc(updated) > G.parse_utc(built):
            emit("connector-origins", note="changed after the live build; its recorded CSP is not compared", scope=scope)
            return
        nginx = G.source_file(gh, anchors, anchors["nginxConfPath"], live["source"]).decode("utf-8")
        implied = configure_connect_src(csp_default(nginx), parse_connector_origins(value))
        recorded = [v for n, v in live.get("headers", []) if n.lower() == "content-security-policy"]
        require(recorded == [implied], "CONNECTOR_ORIGINS_UNPROVEN",
                f"the {scope} variable {anchors['connectorOriginsVariable']} does not reproduce the CSP recorded for the live "
                "build; check organisation and environment variables before deploying")

    def need_bytes(self, image):
        compressed = G.registry_image_bytes(image, self.anchors, self.opener)
        capacity = self.profile["capacity"]
        return max(int(capacity["minFreeAboveReserveBytes"]), int(capacity["imageSizeFactor"]) * compressed + GIB)


def _phase_hold(context, preview):
    phase = preview.get("phase")
    if phase in A.HOLD_PHASES and not context.args.clear_hold:
        raise Refusal("HELD_FOR_HUMAN", f"the live phase is {phase.upper()}; inspect with status, then pass --clear-hold")


def _settled(status):
    """The live records describe the live image (review C-H2)."""
    preview, image = status.get("preview", {}), status["deployment"]["image"]
    return preview.get("image") == image and preview.get("phase") in A.SETTLED_PHASES


def _finish(context, command, result, **fields):
    name = result.get("result", "REFUSED")
    context.record(command, name, **{k: v for k, v in result.items() if k in ("deployId", "reason", "code", "problem",
                                                                              "source", "image", "previous")}, **fields)
    emit("done", **{k: v for k, v in result.items() if k not in ("checks", "rollbackChecks")})
    return RESULT_EXIT.get(name, 1)


def _json_or_none(text):
    try:
        return strict_json(text, "annotation") if text else None
    except Refusal:
        return None


def _live_state(context):
    """Read live state; refuse while a run is active, and before anything else when a human must look."""
    status = context.read("status")
    require(status.get("unit") not in BUSY, "LOCK_HELD", "a preview run is active on the node; wait or run status --follow")
    _phase_hold(context, status.get("preview", {}))
    return status


def deploy_bound(context, command, sha, bound):
    """Second half of ship, and all of deploy: expectations, checks, then the node unit."""
    anchors, gh = context.anchors, context.gh
    status = _live_state(context)
    preview, deployment = status.get("preview", {}), status["deployment"]
    if deployment["image"] == bound["image"]:
        require(preview.get("phase") == "accepted" and preview.get("image") == bound["image"], "RECORDS_STALE",
                f"this build is live but its phase is {preview.get('phase')}; inspect with status")
        return _finish(context, command, {"result": "ALREADY_LIVE", "image": bound["image"], "source": sha})
    require(deployment["converted"], "NOT_CONVERTED", "lolly.tools still serves the claim root; run the 3.6 conversion plan first")
    require(_settled(status), "RECORDS_STALE", "the preview records do not describe the live image; inspect with status")
    live_source = preview.get("source")
    require(isinstance(live_source, str) and SHA.fullmatch(live_source) is not None, "NO_PREVIOUS_RECORD",
            "the live release carries no preview records")
    context.check_live_origins(preview)
    expect, formats = context.expectations(sha, bound.get("runCreatedAt"))
    if not G.contains(gh, anchors["repository"], live_source, sha):
        lowering = format_lowering(_json_or_none(preview.get("formats")), formats)
        require(not lowering, "FORMAT_LOWERING", "this older build would lower stored formats (" + ", ".join(lowering) +
                "); roll forward instead")
    need = context.need_bytes(bound["image"])
    deploy_id = context.deploy_id("deploy", sha)
    request = context.request("deploy", deploy_id, liveSource=live_source,
                              release={"source": sha, "image": bound["image"], "ciRun": str(bound["run"]),
                                       "formats": formats, "expect": expect})
    request["limits"]["needBytes"] = need
    context.backup_window("deploy")
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, command, result, sha=sha, ciRun=bound["run"])


def cmd_ship(context, sha):
    anchors, gh = context.anchors, context.gh
    main_sha = G.main_head(gh, anchors)
    require(main_sha == sha, "NOT_MAIN_HEAD",
            "Phase 1 ships only the current main head (the candidate build refuses older commits); use deploy for a built commit")
    status = _live_state(context)
    preview = status.get("preview", {})
    if preview.get("source") == sha and _settled(status) and preview.get("phase") == "accepted":
        return _finish(context, "ship", {"result": "ALREADY_LIVE", "source": sha, "image": status["deployment"]["image"]})
    require(status["deployment"]["converted"], "NOT_CONVERTED", "run the 3.6 conversion plan first")
    # Before any build is reused or dispatched (review N2, L2).
    require(_settled(status), "RECORDS_STALE", "the preview records do not describe the live image; run adopt <sha of the "
                                               "live build> first")
    context.backup_window("deploy")
    try:  # reuse a build of this commit that still binds (review C-L7)
        bound = G.latest_bound_run(gh, anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT)
        emit("reused", run=bound["run"], image=bound["image"])
        return deploy_bound(context, "ship", sha, bound)
    except Refusal as exc:
        if exc.code != "RUN_NOT_FOUND":
            raise
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
    context.backup_window("deploy")
    G.require_on_main(context.gh, context.anchors, sha)
    bound = G.latest_bound_run(context.gh, context.anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT)
    emit("bound", run=bound["run"], image=bound["image"])
    return deploy_bound(context, "deploy", sha, bound)


def cmd_rollback(context):
    status = _live_state(context)
    preview = status.get("preview", {})
    previous = _json_or_none(preview.get("previous"))
    require(isinstance(previous, dict) and isinstance(previous.get("source"), str), "NO_PREVIOUS",
            "no recorded previous build; deploy a build instead")
    require(isinstance(previous.get("image"), str) and previous["image"].startswith(context.anchors["imageRepository"] + "@"),
            "BAD_IMAGE", "the recorded previous image is not the anchored package")
    lowering = format_lowering(_json_or_none(preview.get("formats")), previous.get("formats"))
    require(not lowering, "FORMAT_LOWERING", "rolling back would lower stored formats (" + ", ".join(lowering) +
            "); roll forward instead")
    request = context.request("rollback", context.deploy_id("rollback", previous["source"]), rollbackTo=previous["source"])
    request["limits"]["needBytes"] = context.need_bytes(previous["image"])
    context.backup_window("rollback")
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "rollback", result, sha=previous["source"])


def cmd_status(context, follow=None):
    if follow:
        require(re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}", follow) is not None, "BAD_ARGUMENTS", "deploy id")
        result = context.follow(follow)
        return _finish(context, "status --follow", result)
    status = context.read("status")
    preview = status.get("preview", {})
    phase = preview.get("phase") or "none"
    emit("status", phase=phase if phase == "accepted" else phase.upper(), source=preview.get("source"),
         image=status["deployment"]["image"], recordsDescribeLiveImage=_settled(status), ready=status["deployment"]["ready"],
         converted=status["deployment"]["converted"], revision=status["deployment"]["revision"], unit=status.get("unit"),
         pods=status.get("pods"), deployId=preview.get("deploy-id"), reason=preview.get("reason"), lastResult=status.get("lastResult"))
    return 0


def claim_commands(context, claim):
    """For Andy only: check-target first, a fresh report, then a delete that the API refuses unless the UID still matches."""
    identity, namespace = context.identity, context.anchors["namespace"]
    kubectl = ["sudo", identity["k3s"], "kubectl", "--kubeconfig", identity["kubeconfig"], "--context", identity["context"]]
    body = json.dumps({"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": claim["uid"]}}, separators=(",", ":"))
    path = f"/api/v1/namespaces/{namespace}/persistentvolumeclaims/{claim['name']}"
    return [
        "python3 " + shlex.quote(str(context.check_target_path)) + " --site " + shlex.quote(context.site),
        "python3 launch.py " + shlex.quote(context.site) + " gc   # the claim must still be a candidate with no referencedBy",
        "printf '%s' " + shlex.quote(body) + " | " + " ".join(shlex.quote(word) for word in kubectl + ["delete", "--raw", path, "-f", "-"]),
    ]


def cmd_gc(context, execute):
    """Report first. --execute needs an earlier report in deploys.jsonl, removes images only, never claims."""
    report = context.read("gc", legacyClaims=context.profile["gc"]["legacyClaims"])
    emit("gc-images", keep=report["images"]["keep"], remove=report["images"]["remove"],
         removeBytes=report["images"]["removeBytes"], untouched=report["images"]["untouched"],
         retentionArmed=report["retentionArmed"])
    for image in report["images"].get("unusedForeign", []):
        emit("gc-foreign-image", id=image["id"], refs=image["refs"], sizeBytes=image["size"], pinnedRefs=image["pinnedRefs"],
             pinnedBy=image["pinnedBy"], referencedBy=image["referencedBy"], forAndy=foreign_commands(context, image),
             note="this command did not pull it and never removes it; Andy decides")
    for claim in report["claims"]:
        emit("gc-claim", name=claim["name"], uid=claim["uid"], candidate=claim["candidate"], blockedBy=claim["blockedBy"],
             referencedBy=claim["referencedBy"],
             forAndy=claim_commands(context, claim) if claim["candidate"] else None,
             note="Andy runs these himself; deleting a local-path claim deletes its data" if claim["candidate"] else None)
    if not execute:
        context.record("gc", "GC_REPORT", remove=report["images"]["remove"])
        return 0
    require(any(row.get("result") == "GC_REPORT" for row in context.records()), "GC_REPORT_FIRST",
            "run gc without --execute first and read its report")
    request = context.request("gc", context.deploy_id("gc"))
    context.backup_window("gc")
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "gc --execute", result)


def cmd_adopt(context, sha):
    """Re-seed the records for the live image from a bound build of <sha> (review N2). Never dispatches a build."""
    anchors, gh = context.anchors, context.gh
    status = context.read("status")
    require(status.get("unit") not in BUSY, "LOCK_HELD", "a preview run is active on the node; wait or run status --follow")
    require(status["deployment"]["converted"], "NOT_CONVERTED", "adopt works on the image layout only")
    G.require_on_main(gh, anchors, sha)
    live_image = status["deployment"]["image"]
    bound = G.latest_bound_run(gh, anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT, prefer_image=live_image)
    expect, formats = context.expectations(sha, bound.get("runCreatedAt"))
    request = context.request("adopt", context.deploy_id("adopt", sha),
                              release={"source": sha, "image": bound["image"], "ciRun": str(bound["run"]),
                                       "formats": formats, "expect": expect})
    context.backup_window("adopt")
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "adopt", result, sha=sha, ciRun=bound["run"])


def foreign_commands(context, image):
    """For Andy only, never run by the tool: check-target, a fresh report, then unpin and remove one foreign image."""
    identity = context.identity
    k3s = ["sudo", identity["k3s"]]
    commands = ["python3 " + shlex.quote(str(context.check_target_path)) + " --site " + shlex.quote(context.site),
                "python3 launch.py " + shlex.quote(context.site) + " gc   # the image must still be listed as unused"]
    for ref in image["pinnedRefs"]:
        commands.append(" ".join(shlex.quote(word) for word in k3s + ["ctr", "-n", "k8s.io", "images", "label", ref,
                                                                       "io.cri-containerd.pinned="]) +
                        "   # only if the procedure that pinned it no longer needs it")
    commands.append(" ".join(shlex.quote(word) for word in k3s + ["crictl", "rmi", image["id"]]) +
                    "   # removes every name of this image")
    return commands


def cmd_selftest(context):
    """Read-only checks inside the real unit sandbox (review C-M7). It still installs and starts the
    unit on the host, so check-target runs first (review R4)."""
    request = context.request("selftest", context.deploy_id("selftest"))
    context.check_target()
    result = context.start_and_follow(request)
    for item in result.get("checks") or []:
        emit("selftest-result", **item)
    return _finish(context, "selftest", result)


IMAGE_NGINX_FILES = (("default.conf", "nginxConfPath"), ("security-headers.conf", "securityHeadersPath"),
                     ("delivery-maps.conf", "deliveryMapsPath"), ("delivery-headers.conf", "deliveryHeadersPath"))
HEADER_CHECKS = ("csp", "edge headers")


def cmd_plan(context, sha):
    """PROPOSAL 3.6 plan mode: print the exact guarded patch, the layout a revert restores and the nginx diff."""
    anchors, gh = context.anchors, context.gh
    G.require_on_main(gh, anchors, sha)
    live = context.read("plan")
    deployment = live["deployment"]
    index = [c["name"] for c in deployment["spec"]["template"]["spec"]["containers"]].index(anchors["container"])
    live_image = deployment["spec"]["template"]["spec"]["containers"][index]["image"]
    bound = G.latest_bound_run(gh, anchors, sha, context.pin, A.RELEASE_PUBLIC_KEY_THUMBPRINT, prefer_image=live_image)
    expect, formats = context.expectations(sha, bound.get("runCreatedAt"))
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
    failing = [item for item in smoke["checks"] if not item["ok"]]
    for item in failing:
        if item["check"] in HEADER_CHECKS:
            for line in item["detail"].split("; "):
                emit("pre-conversion-header", check=item["check"], difference=line)
    others = [item["check"] for item in failing if item["check"] not in HEADER_CHECKS]
    require(not others, "PRECONVERSION_SMOKE", "the live site fails more than its header checks before the conversion: " +
            ", ".join(others) + "; fix that first")
    plan = {"version": 1, "kind": "convert", "site": context.site, "source": sha, "deployId": deploy_id,
            "tool": context.tool_hash, "createdAt": utc_stamp(),
            "run": {k: bound[k] for k in ("run", "attempt", "image", "imageId", "receiptExpiresAt")},
            "release": release, "conversion": conversion, "nginxDiff": "".join(diff), "preConversionSmoke": smoke}
    plans = context.state_dir / "plans"
    plans.mkdir(mode=0o700, exist_ok=True)
    path = plans / (deploy_id + ".json")
    write_private_new(path, json.dumps(plan, indent=2, sort_keys=True) + "\n")
    print(json.dumps(conversion["patch"], indent=2))
    print("".join(diff) or "(the image's nginx files equal the ConfigMap)")
    emit("revert-restores", volumes=conversion["before"]["volumes"], volumeMounts=conversion["before"]["volumeMounts"],
         revisionHistoryLimit=conversion["before"]["revisionHistoryLimit"])
    emit("plan", path=str(path), reviewedPlanSha256=compact_digest(plan), removedVolumes=conversion["removedVolumes"],
         receiptExpiresAt=bound.get("receiptExpiresAt"), headerDifferencesBeforeConversion=len(failing),
         next="review, then: plan <sha> --apply PATH --reviewed-plan-sha256 HASH (named owner, Andy present)")
    return 0


def cmd_plan_apply(context, sha, path, reviewed):
    plan = strict_json(Path(path).read_text(), "plan")
    require(isinstance(reviewed, str) and HEX64.fullmatch(reviewed) is not None
            and hmac.compare_digest(compact_digest(plan), reviewed), "PLAN_MISMATCH", "the plan hash differs from the reviewed hash")
    require(plan.get("kind") == "convert" and plan.get("site") == context.site and plan.get("source") == sha,
            "PLAN_MISMATCH", "the plan is for another site or commit")
    require(plan.get("tool") == context.tool_hash, "PLAN_TOOL_CHANGED", "the tool changed since the plan; make a new plan")
    status = _live_state(context)
    require(not status["deployment"]["converted"], "ALREADY_CONVERTED", "the Deployment already serves the image root")
    request = context.request("convert", plan["deployId"], release=plan["release"], conversion=plan["conversion"])
    request["limits"]["needBytes"] = context.need_bytes(plan["release"]["image"])
    context.backup_window("convert")
    context.check_target()
    result = context.start_and_follow(request)
    return _finish(context, "plan --apply", result, sha=sha)


def parser():
    p = argparse.ArgumentParser(prog="preview-deploy", allow_abbrev=False,
                                description="Deploy the lolly.tools preview from one main commit.")
    p.add_argument("--state-dir", required=True, help="lolly-private/production/preview")
    p.add_argument("--tool-sha256", required=True, help="tool hash launch.py checked against tool.lock.json")
    p.add_argument("--checkout", required=True, help="the locked lolly-work checkout")
    p.add_argument("--check-target", required=True, help="lolly-private/production/check-target.py")
    p.add_argument("site", choices=sorted(A.SITES))
    sub = p.add_subparsers(dest="command", required=True)

    def command(name):
        return sub.add_parser(name, allow_abbrev=False)
    for name in ("ship", "deploy"):
        s = command(name)
        s.add_argument("sha")
        s.add_argument("--drill-fail-smoke", action="store_true", help="force a smoke failure to drill the automatic rollback")
        s.add_argument("--clear-hold", action="store_true", help="proceed although the live phase needs a human")
    s = command("rollback")
    s.add_argument("--clear-hold", action="store_true")
    s = command("status")
    s.add_argument("--follow", metavar="DEPLOY_ID", help="follow one run to its end and record its result")
    s = command("gc")
    s.add_argument("--execute", action="store_true", help="remove images outside retention (never claims)")
    command("selftest")
    s = command("adopt")
    s.add_argument("sha")
    s.add_argument("--clear-hold", action="store_true", help="record a live build that fails its smoke as adopted-unhealthy")
    s = command("plan")
    s.add_argument("sha")
    s.add_argument("--apply", metavar="PLAN")
    s.add_argument("--reviewed-plan-sha256")
    s.add_argument("--drill-fail-smoke", action="store_true")
    s.add_argument("--clear-hold", action="store_true")
    return p


MUTATING = {"ship", "deploy", "rollback", "adopt"}


def main(argv=None, gh=None, opener=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        check_argv(argv)
    except Refusal as exc:
        emit("refused", code=exc.code, reason=exc.message)
        return 1
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
            return cmd_status(context, args.follow)
        if args.command == "gc":
            return cmd_gc(context, args.execute)
        if args.command == "selftest":
            return cmd_selftest(context)
        if args.command == "adopt":
            return cmd_adopt(context, args.sha)
        if args.apply:
            return cmd_plan_apply(context, args.sha, args.apply, args.reviewed_plan_sha256)
        return cmd_plan(context, args.sha)
    except Refusal as exc:
        emit("refused", code=exc.code, reason=exc.message)
        mutating = args.command in MUTATING or (args.command == "gc" and args.execute) or \
            (args.command == "plan" and args.apply) or args.command == "selftest"
        if context is not None and mutating:
            context.record(args.command, "REFUSED", code=exc.code, reason=exc.message[:500], sha=getattr(args, "sha", None))
        return 1
