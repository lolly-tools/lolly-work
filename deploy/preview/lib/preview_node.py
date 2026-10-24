# SPDX-License-Identifier: MPL-2.0
"""Node side of the preview deploy command. Runs as root inside lolly-preview-deploy.service.

Only these changes are in the code path: pull, pin and unpin images of the
anchored package (only ones this command pulled or pinned itself); the target
Deployment's image (through Work's app-update.py), its metadata annotations, and
once its 3.6 layout. Nothing here touches Secrets, PVCs, Postgres, the edge or DNS.
"""

from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import time

import preview_anchors as A
import preview_layout as L
import preview_smoke as S
from preview_common import (DEPLOY_ID, HEX64, SHA, Refusal, compact, compact_digest, require, require_python,
                            strict_json, utc_stamp)
from preview_expect import format_lowering

PATHS = {"run": A.NODE_RUN_DIR, "results": A.NODE_RESULTS_DIR, "lock": A.NODE_LOCK, "lockDir": A.NODE_LOCK_DIR,
         "imagefs": A.NODE_IMAGE_FILESYSTEM, "systemctl": A.NODE_SYSTEMCTL, "armed": A.NODE_RETENTION_ARMED,
         "procStatus": "/proc/self/status", "procAttr": "/proc/self/attr/current"}
MIB = 2 ** 20
EXIT = {"LIVE": 0, "ALREADY_LIVE": 0, "CONVERTED": 0, "ALREADY_CONVERTED": 0, "GC_DONE": 0, "SELFTEST_OK": 0, "ADOPTED": 0,
        "ADOPTED_UNHEALTHY": 3,
        "ABORTED": 1, "REFUSED": 1, "STOPPED": 1, "SELFTEST_FAILED": 1, "GC_INCOMPLETE": 1, "ROLLED_BACK": 2, "CONVERSION_REVERTED": 2,
        "ROLLBACK_UNHEALTHY": 3}
# Removal outcomes whose image is gone by its ID after the attempt.
REMOVED = ("removed", "removed-after-error")
SWITCH_ATTEMPTS = 5
SLEEP = time.sleep
CLOCK = time.monotonic
WALL = time.time


def load_app_update(path):
    spec = importlib.util.spec_from_file_location("app_update", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def filesystem_bytes(path):
    stat_ = os.statvfs(path)
    return stat_.f_blocks * stat_.f_frsize, stat_.f_bavail * stat_.f_frsize


def key(name):
    return A.ANNOTATION_PREFIX + name


def _atomic_write(path, text):
    temporary = path + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(text)
    os.replace(temporary, path)


def _number(value, low, high, label):
    require(type(value) in (int, float) and low <= value <= high, "BAD_REQUEST", f"{label} out of range")
    return value


def crictl_args(args, deadline):
    """crictl's global --timeout goes before the subcommand; crictl rejects it after one."""
    return ["crictl", "--timeout", f"{int(deadline)}s", *args]


def command_words(args):
    """The tool and its subcommand, for messages, without crictl's deadline option."""
    words = [word for index, word in enumerate(args) if word != "--timeout" and (index == 0 or args[index - 1] != "--timeout")]
    return " ".join(words[:2])


def anchored_image(image, anchors):
    """repository@sha256:<64 hex> of the anchored package, nothing else (review S-L1)."""
    return isinstance(image, str) and re.fullmatch(re.escape(anchors["imageRepository"]) + r"@sha256:[0-9a-f]{64}", image) is not None


def validate_expect(expect):
    require(isinstance(expect, dict) and set(expect) == {"source", "profile", "headers", "models", "pages"},
            "BAD_REQUEST", "expectations are malformed")
    require(SHA.fullmatch(expect["source"]) is not None and expect["profile"] == A.TOOLS["profile"], "BAD_REQUEST", "bad expected source")
    require(isinstance(expect["headers"], list) and expect["headers"] and all(
        isinstance(item, list) and len(item) == 2 and all(isinstance(part, str) for part in item) for item in expect["headers"]),
        "BAD_REQUEST", "expected headers are malformed")
    model = expect["models"]
    require(isinstance(model, dict) and set(model) == {"url", "size"} and isinstance(model["url"], str)
            and re.fullmatch(r"/models/[A-Za-z0-9._@/-]{1,900}", model["url"]) is not None and type(model["size"]) is int
            and model["size"] > 0, "BAD_REQUEST", "model sample is malformed")
    require(isinstance(expect["pages"], list) and len(expect["pages"]) <= 16 and all(
        isinstance(page, dict) and set(page) == {"path", "file"} and isinstance(page["path"], str)
        and re.fullmatch(r"/[A-Za-z0-9._/-]{0,300}", page["path"]) is not None and isinstance(page["file"], str)
        for page in expect["pages"]), "BAD_REQUEST", "page list is malformed")
    return expect


def validate_request(request, au):
    require_python()
    require(isinstance(request, dict) and request.get("version") == 1, "BAD_REQUEST", "unsupported request")
    require(request.get("kind") in ("deploy", "rollback", "convert", "gc", "selftest", "adopt", "read"), "BAD_REQUEST", "unknown kind")
    anchors = A.site_anchors(request.get("site"))
    require(isinstance(request.get("deployId"), str) and DEPLOY_ID.fullmatch(request["deployId"]) is not None,
            "BAD_REQUEST", "deploy id is malformed")
    require(isinstance(request.get("tool"), str) and HEX64.fullmatch(request["tool"]) is not None, "BAD_REQUEST", "tool hash")
    target = au.validate_target(request.get("target"))
    require(target["version"] == 1 and target["transport"]["type"] == "local" and set(target["components"]) == {anchors["component"]},
            "BAD_REQUEST", "the node target owns exactly the anchored component over local kubectl")
    component = target["components"][anchors["component"]]
    require(component["namespace"] == anchors["namespace"] and component["deployment"] == anchors["deployment"]
            and component["container"] == anchors["container"] and component.get("requiredLabels") == anchors["requiredLabels"]
            and not component.get("healthURLs"), "BAD_REQUEST", "the target is not the anchored Deployment")
    require(isinstance(request.get("k3s"), str) and request["k3s"].startswith("/") and ".." not in request["k3s"]
            and target["transport"]["kubectl"] == [request["k3s"], "kubectl"], "BAD_REQUEST", "k3s must be one absolute path")
    limits = request.get("limits")
    require(isinstance(limits, dict), "BAD_REQUEST", "limits are missing")
    _number(limits.get("rolloutTimeoutSeconds"), 30, A.MAX_ROLLOUT_SECONDS, "rollout timeout")
    _number(limits.get("watchMinutes"), 0, A.MAX_WATCH_MINUTES, "watch minutes")
    _number(limits.get("watchIntervalSeconds"), 1, 300, "watch interval")
    _number(limits.get("watchFailures"), 1, 20, "watch failures")
    _number(limits.get("memoryFraction"), 0.1, 1.0, "memory fraction")
    _number(limits.get("retainPreviousImages"), 1, 10, "image retention")
    _number(limits.get("maxAddedPages"), 0, 10, "added pages")
    _number(limits.get("needBytes"), 0, 2 ** 40, "capacity need")
    require(isinstance(limits.get("edgeAddress"), str) and re.fullmatch(r"[0-9a-f.:]{3,45}", limits["edgeAddress"]) is not None,
            "BAD_REQUEST", "edge address")
    window = limits.get("noDeployUtc")
    require(isinstance(window, list) and len(window) == 2 and all(isinstance(t, str) and re.fullmatch(r"[0-2][0-9]:[0-5][0-9]", t)
                                                                   for t in window), "BAD_REQUEST", "backup window")
    require(isinstance(request.get("modelsRelease"), str) and re.fullmatch(r"models-[0-9a-f]{64}", request["modelsRelease"]) is not None,
            "BAD_REQUEST", "models release")
    require(type(request.get("drillFailSmoke")) is bool and type(request.get("clearHold")) is bool, "BAD_REQUEST", "flags")
    if request["kind"] in ("deploy", "convert", "adopt"):
        release = request.get("release")
        require(isinstance(release, dict) and set(release) == {"source", "image", "ciRun", "formats", "expect"},
                "BAD_REQUEST", "release is malformed")
        require(anchored_image(release["image"], anchors), "BAD_REQUEST", "release image is not the anchored package by digest")
        require(SHA.fullmatch(release["source"]) is not None and re.fullmatch(r"[1-9][0-9]{0,15}", release["ciRun"]) is not None,
                "BAD_REQUEST", "release source or run")
        require(isinstance(release["formats"], dict), "BAD_REQUEST", "release formats")
        validate_expect(release["expect"])
        require(release["expect"]["source"] == release["source"], "BAD_REQUEST", "expectations name another source")
    if request["kind"] == "convert":
        plan = request.get("conversion")
        require(isinstance(plan, dict) and isinstance(plan.get("patch"), list) and plan.get("deployId") == request["deployId"]
                and plan.get("tool") == request["tool"] and isinstance(plan.get("annotations"), dict),
                "BAD_REQUEST", "conversion plan missing, or made by another run or tool")
    if request["kind"] == "rollback":
        require(isinstance(request.get("rollbackTo"), str) and SHA.fullmatch(request["rollbackTo"]) is not None,
                "BAD_REQUEST", "rollback target")
    require(request.get("liveSource") is None or SHA.fullmatch(request["liveSource"]) is not None, "BAD_REQUEST", "live source")
    return anchors


class Runner:
    def __init__(self, request, au, log=None):
        self.request = request
        self.au = au
        self.anchors = validate_request(request, au)
        self.target = request["target"]
        self.component = self.target["components"][self.anchors["component"]]
        self.kube = au.Kubectl(self.target["transport"])
        self.k3s = request["k3s"]
        self.limits = request["limits"]
        self.pin = A.RELEASE_PUBLIC_KEY_JWK
        self.log = log or (lambda event, **fields: None)

    # Reads ---------------------------------------------------------------
    def deployment(self, full=True):
        """The target Deployment. full: cluster, node, namespace and Deployment identity, as before every change.
        Otherwise one read that still checks the Deployment's UID, name and owned container, for health probes."""
        if full:
            self.au.check_cluster(self.target, self.kube)
            value, index = self.au.check_deployment(self.component, self.kube)
        else:
            value = self.kube.get("deployment", self.anchors["deployment"], self.anchors["namespace"])
            require(value["metadata"].get("uid") == self.component["deploymentUID"] and not value["metadata"].get("deletionTimestamp"),
                    "IDENTITY_MISMATCH", "wrong Deployment")
            index = L.container_index(value, self.anchors["container"])
        require(value["metadata"].get("name") == self.anchors["deployment"]
                and value["metadata"].get("namespace") == self.anchors["namespace"], "IDENTITY_MISMATCH", "wrong Deployment")
        return value, index

    @staticmethod
    def image_of(value, index):
        return value["spec"]["template"]["spec"]["containers"][index]["image"]

    @staticmethod
    def ann(value, name):
        return (value["metadata"].get("annotations") or {}).get(key(name))

    def ann_json(self, value, name):
        text = self.ann(value, name)
        if not text:
            return None
        try:
            return strict_json(text, name)
        except Refusal:
            return None

    @staticmethod
    def ready(value):
        status, replicas = value.get("status", {}), value["spec"].get("replicas", 1)
        return (status.get("observedGeneration", 0) >= value["metadata"].get("generation", 1)
                and status.get("readyReplicas", 0) == replicas and status.get("availableReplicas", 0) == replicas
                and status.get("updatedReplicas", 0) == replicas and status.get("replicas", 0) == replicas)

    def k3s_result(self, args, timeout):
        try:
            return subprocess.run([self.k3s, *args], capture_output=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("NODE_COMMAND", f"k3s {command_words(args)} failed to run") from exc

    def k3s_run(self, args, timeout=120):
        done = self.k3s_result(args, timeout)
        require(done.returncode == 0, "NODE_COMMAND", f"k3s {command_words(args)} exited {done.returncode}")
        return done.stdout.decode("utf-8", "replace")

    def crictl(self, args, deadline=A.CRICTL_READ_TIMEOUT_SECONDS, timeout=None):
        """crictl with an explicit client deadline. Its default of 2 s cuts slow calls short."""
        return self.k3s_run(crictl_args(args, deadline), timeout or deadline + A.CRICTL_SLACK_SECONDS)

    def selector(self, value):
        labels = value["spec"]["selector"]["matchLabels"]
        return ",".join(f"{name}={labels[name]}" for name in sorted(labels))

    def current_replicaset(self, value):
        """The ReplicaSet of the Deployment's current revision."""
        data = json.loads(self.kube.run(["get", "replicasets", "--namespace", self.anchors["namespace"], "-l", self.selector(value),
                                         "-o", "json"]))
        revision = (value["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision")
        owned = [item for item in data.get("items", []) if value["metadata"]["uid"] in
                 {owner.get("uid") for owner in item["metadata"].get("ownerReferences", [])}
                 and (item["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision") == revision]
        return owned[0]["metadata"]["uid"] if len(owned) == 1 else None

    def pods(self, value):
        """Running or Pending Pods of the current ReplicaSet only (review C-M3)."""
        current = self.current_replicaset(value)
        data = json.loads(self.kube.run(["get", "pods", "--namespace", self.anchors["namespace"], "-l", self.selector(value),
                                         "-o", "json"]))
        return [pod for pod in data.get("items", []) if not pod["metadata"].get("deletionTimestamp")
                and pod.get("status", {}).get("phase") in ("Running", "Pending")
                and current in {owner.get("uid") for owner in pod["metadata"].get("ownerReferences", [])}]

    def working_set(self, container_id):
        """The kubelet's working set: containerd reports usage minus inactive_file, never usageBytes
        (review C-L6). Inactive page cache does not count; active page cache, such as model files read
        moments ago, still does, so the 80% threshold leaves room for it."""
        data = json.loads(self.crictl(["stats", "-o", "json", "--id", container_id]))
        stats = data.get("stats") or []
        if len(stats) != 1:
            return None
        value = ((stats[0].get("memory") or {}).get("workingSetBytes") or {}).get("value")
        return int(value) if isinstance(value, (int, str)) and str(value).isdigit() else None

    def pod_check(self, image, memory):
        try:
            value, index = self.deployment(full=False)
            pods = self.pods(value)
            if len(pods) != 1:
                return False, f"{len(pods)} running Pods in the current ReplicaSet"
            pod = pods[0]
            containers = [c for c in pod["spec"]["containers"] if c["name"] == self.anchors["container"]]
            statuses = [c for c in pod.get("status", {}).get("containerStatuses", []) if c.get("name") == self.anchors["container"]]
            if len(containers) != 1 or len(statuses) != 1 or containers[0]["image"] != image:
                return False, "the Pod does not run the expected image"
            ready = any(c.get("type") == "Ready" and c.get("status") == "True" for c in pod.get("status", {}).get("conditions", []))
            if not ready or statuses[0].get("ready") is not True:
                return False, "the Pod is not Ready"
            if statuses[0].get("restartCount", 0) != 0:
                return False, f"{statuses[0].get('restartCount')} restarts"
            detail = "Ready; 0 restarts"
            if memory:
                limit = L.parse_quantity(((containers[0].get("resources") or {}).get("limits") or {}).get("memory"))
                container_id = statuses[0].get("containerID", "").split("://")[-1]
                used = self.working_set(container_id) if re.fullmatch(r"[0-9a-f]{12,64}", container_id) else None
                if used is None:
                    return False, "the working set could not be read"
                if used >= self.limits["memoryFraction"] * limit:
                    return False, f"working set {used // MIB} MiB is at or above {int(self.limits['memoryFraction'] * 100)}% of {limit // MIB} MiB"
                detail += f"; working set {used // MIB} MiB of {limit // MIB} MiB"
            return True, detail
        except (Refusal, self.au.Refusal, ValueError, KeyError, TypeError) as exc:
            return False, "pod check failed: " + (exc.code if isinstance(exc, Refusal) else type(exc).__name__)

    # Writes --------------------------------------------------------------
    def annotate(self, values, expect_image=None, attempts=5):
        """Guarded metadata patch: UID, resourceVersion and the current image are tested; re-read on conflict."""
        last = None
        for _ in range(attempts):
            value, index = self.deployment()
            if expect_image is not None:
                require(self.image_of(value, index) == expect_image, "STATE_CHANGED", "the image changed under the command")
            ops = L.annotation_ops(value["metadata"], {key(name): text for name, text in values.items()})
            patch = [{"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
                     {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
                     {"op": "test", "path": f"/spec/template/spec/containers/{index}/image", "value": self.image_of(value, index)}] + ops
            try:
                result = self.kube.patch(self.component, patch, False)
            except Exception as exc:  # a conflict: re-read and try again
                last = exc
                SLEEP(1)
                continue
            require(result["metadata"]["uid"] == value["metadata"]["uid"]
                    and compact_digest(result["spec"]) == compact_digest(value["spec"]), "ANNOTATION_GUARD",
                    "an annotation patch changed the Deployment spec")
            return result
        raise Refusal("ANNOTATION_FAILED", "could not write the phase annotation") from last

    def capacity(self, need):
        total, available = filesystem_bytes(PATHS["imagefs"])
        reserve = total // 4 + 512 * MIB
        above = available - reserve
        require(above >= need, "LOW_CAPACITY", f"{above // MIB} MiB above the image-GC reserve, {need // MIB} MiB needed; run gc")
        return above

    def inspect(self, image):
        try:
            data = json.loads(self.crictl(["inspecti", "-o", "json", image]))
        except (Refusal, ValueError):
            return None
        status = data.get("status") or {}
        return status if image in (status.get("repoDigests") or []) else None

    def containerd_refs(self):
        """ref -> (manifest digest, labels) for every image name in the k8s.io namespace."""
        refs = {}
        for line in self.k3s_run(["ctr", "-n", "k8s.io", "images", "ls"]).splitlines()[1:]:
            columns = line.split()
            if len(columns) >= 3:
                labels = {}
                if len(columns) >= 6 and columns[-1] != "-":
                    for pair in columns[-1].split(","):
                        name, _, value = pair.partition("=")
                        labels[name] = value
                refs[columns[0]] = (columns[2], labels)
        return refs

    def label(self, ref, label, on=True):
        name, _, value = label.partition("=")
        self.k3s_run(["ctr", "-n", "k8s.io", "images", "label", ref, f"{name}={value if on else ''}"])

    def ensure_image(self, image, need):
        """Pull by digest when missing (after a capacity check), then pin. An image another
        procedure pinned keeps that pin untouched; pins are read back (review C-M6, C-L4, S-M1)."""
        require(anchored_image(image, self.anchors), "BAD_IMAGE", "not the anchored package by digest")
        if self.inspect(image) is None:
            self.capacity(need)
            self.log("pull", image=image)
            # --timeout covers only the connection here; the subprocess timeout bounds the pull.
            self.crictl(["pull", image], deadline=A.CRICTL_WRITE_TIMEOUT_SECONDS, timeout=A.PULL_TIMEOUT_SECONDS)
            require(self.inspect(image) is not None, "PULL_FAILED", "the image is not present after the pull")
            self.label(image, A.PULLED_LABEL)
        refs = self.containerd_refs()
        require(image in refs, "PIN_FAILED", "containerd holds no digest name for the image")
        if refs[image][1].get("io.cri-containerd.pinned") != "pinned":
            self.label(image, A.PINNED_LABEL)
            self.label(image, A.OWN_PIN_LABEL)
        require((self.inspect(image) or {}).get("pinned") is True, "PIN_FAILED", "the pin did not read back")

    def wait_rollout(self, image):
        self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
        value, index = self.deployment(full=False)
        require(self.image_of(value, index) == image and self.ready(value), "NOT_READY", "the rollout did not become Ready")

    def switch_image(self, from_image, to_image):
        """Work's own planner and guarded patch, re-planned while nothing has been applied (review C-H1).

        A status update moves the Deployment's resourceVersion, and app-update.py then
        refuses before it patches. That is safe to retry: every attempt re-reads, and the
        UID and expectedImage guards still hold. Raises SWITCH_NOT_APPLIED when the image
        never changed.
        """
        last = "no attempt"
        for _ in range(SWITCH_ATTEMPTS):
            value, index = self.deployment(full=False)  # app-update.py checks the cluster itself before it patches
            current = self.image_of(value, index)
            if current == to_image:
                return self.wait_rollout(to_image)  # an earlier attempt committed
            require(current == from_image, "STATE_CHANGED", "the live image is neither the old nor the new one")
            release = {"version": 1, "updates": [{"component": self.anchors["component"], "expectedImage": from_image,
                                                  "image": to_image}]}
            try:
                plan = self.au.make_plan(self.target, release, self.kube)
                self.au.apply_plan(self.target, plan, self.au.digest(plan), self.kube,
                                   timeout=int(self.limits["rolloutTimeoutSeconds"]), health=lambda url: None)
                return None
            except self.au.ApplyFailure as exc:
                if exc.applied:
                    raise  # patched, then the rollout failed: the caller rolls back
                last = str(exc)
            except self.au.Refusal as exc:
                last = str(exc)
            self.log("switch-retry", reason=last[:200])
            SLEEP(2)
        value, index = self.deployment(full=False)
        if self.image_of(value, index) == to_image:
            return self.wait_rollout(to_image)
        raise Refusal("SWITCH_NOT_APPLIED", f"the image was not changed after {SWITCH_ATTEMPTS} attempts: {last[:200]}")

    # Results -------------------------------------------------------------
    def finish(self, result, **fields):
        record = {"deployId": self.request["deployId"], "kind": self.request["kind"], "site": self.request["site"],
                  "result": result, "finished": utc_stamp(), **fields}
        os.makedirs(PATHS["results"], mode=0o700, exist_ok=True)
        _atomic_write(os.path.join(PATHS["results"], self.request["deployId"] + ".json"), json.dumps(record, sort_keys=True))
        self.log("result", **{k: v for k, v in record.items() if k not in ("checks", "rollbackChecks")})
        return EXIT.get(result, 1)

    def window_check(self):
        """Before each forward mutation: never start one inside the backup window (review L2).
        Rollbacks are not checked; a broken site is worse than a busy backup."""
        start, end = self.request["limits"]["noDeployUtc"]
        now = time.strftime("%H:%M", time.gmtime(WALL()))
        inside = (start <= now < end) if start <= end else (now >= start or now < end)  # a window may wrap midnight
        require(not inside, "BACKUP_WINDOW", f"the {start}-{end} UTC backup window began during the run; "
                                                            "nothing further was changed")

    def hold_check(self, phase):
        if phase in A.HOLD_PHASES and not self.request["clearHold"]:
            raise Refusal("HELD_FOR_HUMAN", f"the live phase is {str(phase).upper()}; inspect with status, "
                                            "then pass --clear-hold to proceed")

    def expect_of(self, value):
        record = self.ann_json(value, "expect")
        try:
            return validate_expect(record)
        except (Refusal, TypeError):
            return None

    def previous_record(self, value, index):
        """What the live release is, from the records the command wrote when it went live.

        The records must describe the image that is live: same image annotation, a
        settled phase, and expectations for the recorded source (review C-H2).
        """
        live = self.image_of(value, index)
        phase = self.ann(value, "phase")
        record = {"source": self.ann(value, "source"), "image": live, "ciRun": self.ann(value, "ci-run"),
                  "formats": self.ann_json(value, "formats"), "expect": self.expect_of(value)}
        require(record["source"] and SHA.fullmatch(record["source"]) is not None and record["expect"] is not None,
                "NO_PREVIOUS_RECORD", "the live release carries no preview records; run the 3.6 conversion plan first")
        require(self.ann(value, "image") == live and phase in A.SETTLED_PHASES and record["expect"]["source"] == record["source"],
                "RECORDS_STALE", f"the preview records do not describe the live image (phase {phase}); inspect with status")
        return record

    def prior_record(self, value):
        """The live build's own rollback record, one level deep: never its `prior` or `edge` (review N1)."""
        record = self.ann_json(value, "previous")
        if not isinstance(record, dict):
            return None
        return {name: item for name, item in record.items() if name not in ("prior", "edge")}

    def edge_now(self):
        """The edge-owned headers the edge serves right now, as a baseline for a rollback; None if unreadable."""
        try:
            return S.observed_edge_headers(S.FETCH(self.anchors["origin"] + "/"))
        except Refusal:
            return None

    def run_smoke(self, expect, image, extra_pages=None, exact_headers=True, edge_baseline=None):
        S.check_dns(self.anchors, self.limits["edgeAddress"])
        checks, files = S.smoke(expect, self.anchors, self.pin, pod_check=lambda memory: self.pod_check(image, memory),
                                extra_pages=extra_pages, exact_headers=exact_headers, edge_baseline=edge_baseline)
        for item in checks.items:
            self.log("smoke", **item)
        return checks, files

    def live_smoke(self, expect):
        """Before writing `switching`: DNS, and the live build still serves its signed bytes (review C-M4)."""
        S.check_dns(self.anchors, self.limits["edgeAddress"])
        checks, files, edge = S.light_smoke(expect, self.anchors, self.pin)
        for item in checks.items:
            self.log("live-smoke", **item)
        if not checks.ok and not self.request["clearHold"]:
            raise Refusal("LIVE_SMOKE_FAILED", "the live build does not pass its own smoke (" +
                          ", ".join(i["check"] for i in checks.failures()) + "); its rollback would not be safe. "
                          "Inspect it, or pass --clear-hold")
        return files, edge

    def watch(self, index_sha, image):
        return S.watch(index_sha, self.anchors, lambda memory: self.pod_check(image, memory),
                       self.limits["watchMinutes"], self.limits["watchIntervalSeconds"], int(self.limits["watchFailures"]),
                       sleep=SLEEP, clock=CLOCK, log=self.log)

    # Deploy --------------------------------------------------------------
    def run_deploy(self):
        release = self.request["release"]
        value, index = self.deployment()
        phase = self.ann(value, "phase")
        self.hold_check(phase)
        live_image = self.image_of(value, index)
        if live_image == release["image"]:
            require(phase == "accepted" and self.ann(value, "image") == live_image, "RECORDS_STALE",
                    f"this build is live but its phase is {phase}; inspect with status")
            return self.finish("ALREADY_LIVE", image=live_image, source=self.ann(value, "source"))
        require(L.is_converted(value, index, self.anchors), "NOT_CONVERTED", "the Deployment still mounts the claim root; run the 3.6 conversion")
        require(L.models_release(value, index, self.anchors) == self.request["modelsRelease"], "MODELS_CHANGED",
                "the mounted models release is not the one the profile names; use the models procedure")
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        previous = self.previous_record(value, index)
        require(previous["source"] == self.request.get("liveSource"), "STATE_CHANGED", "the live release changed since the command read it")
        old_files, edge = self.live_smoke(previous["expect"])
        previous["edge"] = edge
        previous["prior"] = self.prior_record(value)  # restored if the switch aborts; never nested deeper (review N1)
        self.window_check()
        self.ensure_image(release["image"], int(self.limits["needBytes"]))
        self.ensure_image(live_image, int(self.limits["needBytes"]))  # the rollback target stays pinned
        added = lambda files: S.added_info_pages(files, old_files, int(self.limits["maxAddedPages"]))
        deploys = int(self.ann(value, "deploys") or "0")
        self.window_check()
        self.annotate({"phase": "switching", "deploy-id": self.request["deployId"], "previous": compact(previous),
                       "reason": None, "updated": utc_stamp()}, expect_image=live_image)
        self.log("phase", phase="switching")
        try:
            self.switch_image(live_image, release["image"])
        except Refusal as exc:
            if exc.code == "SWITCH_NOT_APPLIED":
                self.annotate({"phase": "aborted", "previous": compact(previous["prior"]) if previous["prior"] else None,
                               "reason": exc.message[:500],
                               "updated": utc_stamp()}, expect_image=live_image)
                return self.finish("ABORTED", reason=exc.message, image=live_image)
            return self.restore(previous, "ROLLOUT_FAILED: " + str(exc)[:300], watch=False)
        except self.au.Refusal as exc:
            return self.restore(previous, "ROLLOUT_FAILED: " + str(exc)[:300], watch=False)
        try:  # from here on, any refusal rolls back
            self.annotate({"phase": "switched-unverified", "source": release["source"], "image": release["image"],
                           "ci-run": release["ciRun"], "tool": self.request["tool"], "formats": compact(release["formats"]),
                           "expect": compact(release["expect"]), "updated": utc_stamp()},
                          expect_image=release["image"])
            self.log("phase", phase="switched-unverified")
            checks, files = self.run_smoke(release["expect"], release["image"], extra_pages=added, edge_baseline=edge)
            if self.request["drillFailSmoke"]:
                checks.record("drill", False, "forced failure (--drill-fail-smoke)")
            if not checks.ok:
                names = ", ".join(item["check"] for item in checks.failures())
                return self.restore(previous, "SMOKE_FAILED: " + names, watch=False, checks=checks.items)
            reason = self.watch(files["index.html"], release["image"])
            if reason:
                return self.restore(previous, "WATCH_FAILED: " + reason, watch=False, checks=checks.items)
            self.annotate({"phase": "accepted", "deploys": str(deploys + 1), "updated": utc_stamp()}, expect_image=release["image"])
        except (Refusal, self.au.Refusal) as exc:
            return self.restore(previous, "UNVERIFIED: " + str(exc)[:300], watch=False)
        retention = self.retain_images(execute=os.path.exists(PATHS["armed"]), budget=A.RETENTION_AFTER_DEPLOY_SECONDS)
        return self.finish("LIVE", source=release["source"], image=release["image"], previous=previous["image"],
                           checks=checks.items, retention=retention)

    def restore(self, previous, reason, watch, checks=None):
        """One rollback attempt to the recorded previous build, then its own smoke. Never a second attempt."""
        self.log("rollback", reason=reason)
        with contextlib.suppress(Refusal):
            self.annotate({"phase": "rolling-back", "reason": reason[:500], "updated": utc_stamp()})
        back = None
        try:
            require(anchored_image(previous.get("image"), self.anchors), "BAD_IMAGE", "the recorded previous image is not the anchored package")
            value, index = self.deployment()
            current = self.image_of(value, index)
            edge = previous.get("edge") or self.edge_now()  # the edge owns these headers, whatever the image
            if current != previous["image"]:
                self.ensure_image(previous["image"], int(self.limits["needBytes"]))
                self.switch_image(current, previous["image"])
            back, files = self.run_smoke(previous["expect"], previous["image"], edge_baseline=edge)
            problem = None if back.ok else "smoke of the previous build failed: " + ", ".join(i["check"] for i in back.failures())
            if problem is None and watch:
                problem = self.watch(files["index.html"], previous["image"])
        except (Refusal, self.au.Refusal) as exc:
            problem = str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500], "updated": utc_stamp()})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks,
                               rollbackChecks=back.items if back else None)
        values = {"phase": "rolled-back", "source": previous["source"], "image": previous["image"],
                  "ci-run": previous["ciRun"], "formats": compact(previous["formats"]) if previous["formats"] else None,
                  "expect": compact(previous["expect"]), "previous": None, "reason": reason[:500], "updated": utc_stamp()}
        try:
            self.annotate(values, expect_image=previous["image"])
        except Refusal as exc:  # rolled back and healthy, but the phase still says rolling-back: status shows it
            return self.finish("ROLLED_BACK", reason=reason, source=previous["source"], image=previous["image"],
                               problem="phase annotation not written: " + exc.code, checks=checks, rollbackChecks=back.items)
        return self.finish("ROLLED_BACK", reason=reason, source=previous["source"], image=previous["image"],
                           checks=checks, rollbackChecks=back.items)

    # Manual rollback -----------------------------------------------------
    def run_rollback(self):
        value, index = self.deployment()
        self.hold_check(self.ann(value, "phase"))
        previous = self.ann_json(value, "previous")
        require(isinstance(previous, dict) and previous.get("image") and previous.get("expect"), "NO_PREVIOUS",
                "no recorded previous build; deploy a build instead")
        require(anchored_image(previous["image"], self.anchors), "BAD_IMAGE", "the recorded previous image is not the anchored package")
        require(previous.get("source") == self.request.get("rollbackTo"), "STATE_CHANGED", "the recorded previous build changed")
        validate_expect(previous["expect"])
        lowering = format_lowering(self.ann_json(value, "formats"), previous.get("formats"))
        require(not lowering, "FORMAT_LOWERING", "the rollback would lower stored formats (" + ", ".join(lowering) +
                "); roll forward instead")
        require(L.is_converted(value, index, self.anchors), "NOT_CONVERTED", "the Deployment is not on the image layout")
        self.window_check()
        self.ensure_image(previous["image"], int(self.limits["needBytes"]))  # refuse here, before anything is marked
        previous = {name: item for name, item in previous.items() if name not in ("prior", "edge")}  # a fresh edge baseline
        self.annotate({"deploy-id": self.request["deployId"], "updated": utc_stamp()})
        return self.restore(previous, "MANUAL", watch=True)

    # Adopt (review N2) ---------------------------------------------------
    def run_adopt(self):
        """Re-seed the records for the image that is live, after a full smoke against a bound build.

        The way forward after ROLLBACK_UNHEALTHY or stale records. It changes only annotations.
        With a failing smoke it refuses, unless a human passes --clear-hold: then the records are
        written with phase adopted-unhealthy, which every later run still holds for a human.
        """
        release = self.request["release"]
        value, index = self.deployment()
        require(self.image_of(value, index) == release["image"], "IMAGE_DIFFERS", "adopt only describes the image that is live")
        require(L.is_converted(value, index, self.anchors), "NOT_CONVERTED", "the Deployment is not on the image layout")
        require(L.models_release(value, index, self.anchors) == self.request["modelsRelease"], "MODELS_CHANGED",
                "the mounted models release is not the one the profile names")
        checks, _ = self.run_smoke(release["expect"], release["image"], edge_baseline=self.edge_now())
        if not checks.ok and not self.request["clearHold"]:
            return self.finish("REFUSED", code="ADOPT_SMOKE_FAILED", reason="the live build fails its smoke: " +
                               ", ".join(i["check"] for i in checks.failures()) + "; deploy a fix with --clear-hold after "
                               "adopt --clear-hold, or inspect by hand", checks=checks.items)
        self.window_check()
        phase = "accepted" if checks.ok else "adopted-unhealthy"
        self.annotate({"phase": phase, "deploy-id": self.request["deployId"], "source": release["source"],
                       "image": release["image"], "ci-run": release["ciRun"], "tool": self.request["tool"],
                       "formats": compact(release["formats"]), "expect": compact(release["expect"]), "previous": None,
                       "reason": "ADOPTED" if checks.ok else "ADOPTED_UNHEALTHY", "updated": utc_stamp()},
                      expect_image=release["image"])
        return self.finish("ADOPTED" if checks.ok else "ADOPTED_UNHEALTHY", source=release["source"], image=release["image"],
                           checks=checks.items)

    # Conversion (PROPOSAL 3.6) -------------------------------------------
    def conversion_now(self, value, plan):
        """Recompute the plan from live state; it must equal the reviewed plan except for the resourceVersion (review C-M9)."""
        current = L.conversion_plan(value, self.anchors, plan["annotations"])
        require(L.comparable_plan(current) == L.comparable_plan(plan), "PLAN_MISMATCH",
                "the live Deployment no longer gives the reviewed plan; make and review a new plan")
        return current

    def run_convert(self):
        plan, release = self.request["conversion"], self.request["release"]
        value, index = self.deployment()
        if L.is_converted(value, index, self.anchors):
            return self.finish("ALREADY_CONVERTED", image=self.image_of(value, index))
        self.hold_check(self.ann(value, "phase"))
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        require(self.image_of(value, index) == plan["image"] == release["image"], "IMAGE_DIFFERS", "the conversion keeps the live image")
        self.conversion_now(value, plan)
        S.check_dns(self.anchors, self.limits["edgeAddress"])
        edge = S.observed_edge_headers(S.FETCH(self.anchors["origin"] + "/"))  # the edge owns these (review C-M2)
        self.window_check()
        self.ensure_image(release["image"], int(self.limits["needBytes"]))
        self.log("phase", phase="converting")
        applied, last = False, None
        for _ in range(SWITCH_ATTEMPTS):
            value, index = self.deployment()
            if L.is_converted(value, index, self.anchors):
                applied = True
                break
            current = self.conversion_now(value, plan)
            try:
                dry = self.kube.patch(self.component, current["patch"], True)
                L.guard_layout_result(value, dry, index, plan["after"])
                result = self.kube.patch(self.component, current["patch"], False)
                L.guard_layout_result(value, result, index, plan["after"])
                applied = True
                break
            except (Refusal, self.au.Refusal) as exc:  # usually a moved resourceVersion: re-read and re-plan
                last = exc
                SLEEP(2)
        if not applied:
            return self.finish("ABORTED", reason="the conversion patch was not applied: " + str(last)[:300])
        try:  # from here on, any refusal restores the claim layout
            self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
            value, index = self.deployment()
            require(self.ready(value) and L.is_converted(value, index, self.anchors), "NOT_READY", "the converted Pod is not Ready")
            checks, files = self.run_smoke(release["expect"], release["image"], edge_baseline=edge)
            if self.request["drillFailSmoke"]:
                checks.record("drill", False, "forced failure (--drill-fail-smoke)")
            if not checks.ok:
                return self.revert_conversion(plan, "SMOKE_FAILED: " + ", ".join(i["check"] for i in checks.failures()), checks.items)
            reason = self.watch(files["index.html"], release["image"])
            if reason:
                return self.revert_conversion(plan, "WATCH_FAILED: " + reason, checks.items)
            self.annotate({"phase": "accepted", "updated": utc_stamp()}, expect_image=release["image"])
        except (Refusal, self.au.Refusal) as exc:
            return self.revert_conversion(plan, "UNVERIFIED: " + str(exc)[:300])
        return self.finish("CONVERTED", source=release["source"], image=release["image"], checks=checks.items)

    def revert_conversion(self, plan, reason, checks=None):
        """Put the claim-served layout back exactly, rebuilding the inverse patch after a failed test op.
        Its smoke skips the exact header checks: the old layout serves the ConfigMap's headers."""
        self.log("rollback", reason=reason)
        back, problem = None, None
        try:
            for _ in range(SWITCH_ATTEMPTS):
                value, index = self.deployment()
                if not L.is_converted(value, index, self.anchors):
                    break
                patch = L.inverse_conversion_patch(value, plan, {key("phase"): "rolling-back", key("layout"): "claim-root",
                                                                 key("reason"): reason[:500]})
                try:
                    dry = self.kube.patch(self.component, patch, True)
                    L.guard_layout_result(value, dry, index, plan["before"])
                    result = self.kube.patch(self.component, patch, False)
                    L.guard_layout_result(value, result, index, plan["before"])
                    break
                except (Refusal, self.au.Refusal):
                    SLEEP(2)
            value, index = self.deployment()
            require(not L.is_converted(value, index, self.anchors), "REVERT_NOT_APPLIED", "the claim layout could not be restored")
            self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
            release = self.request["release"]
            back, _ = self.run_smoke(release["expect"], release["image"], exact_headers=False)
            problem = None if back.ok else "smoke after the revert failed: " + ", ".join(i["check"] for i in back.failures())
        except (Refusal, self.au.Refusal) as exc:
            problem = str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500]})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks)
        self.annotate({"phase": "rolled-back", "updated": utc_stamp()})
        return self.finish("CONVERSION_REVERTED", reason=reason, checks=checks, rollbackChecks=back.items)

    # Retention -----------------------------------------------------------
    def node_images(self):
        """Image ID -> {refs, size, pinned} from CRI, for every image on the node."""
        data = json.loads(self.crictl(["images", "-o", "json"]))
        images = {}
        for image in data.get("images", []):
            if isinstance(image.get("id"), str):
                images[image["id"]] = {"refs": list(image.get("repoDigests") or []) + list(image.get("repoTags") or []),
                                       "size": int(image.get("size") or 0), "pinned": bool(image.get("pinned"))}
        return images

    def image_plan(self):
        """Keep, by image ID, the live image and the newest N previous ones of this Deployment, and
        everything any Pod runs. Remove only images this command pulled itself, by their exact
        repo@digest, when no other name or foreign pin holds them (review S-M1, C-M5)."""
        value, index = self.deployment(full=False)
        uid = value["metadata"]["uid"]
        images = self.node_images()
        by_ref = {ref: image_id for image_id, image in images.items() for ref in image["refs"]}

        def resolve(reference):
            if isinstance(reference, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", reference) and reference in images:
                return reference
            return by_ref.get(reference)
        everything = json.loads(self.kube.run(["get", "pods,replicasets", "--all-namespaces", "-o", "json"]))
        in_use, history = set(), []
        for item in everything.get("items", []):
            if item.get("kind") == "Pod":
                for status in item.get("status", {}).get("containerStatuses", []) + item.get("status", {}).get("initContainerStatuses", []):
                    in_use.add(resolve(status.get("imageID")))
                    in_use.add(resolve(status.get("image")))
                for container in item.get("spec", {}).get("containers", []) + item.get("spec", {}).get("initContainers", []):
                    in_use.add(resolve(container.get("image")))
                continue
            template = item.get("spec", {}).get("template", {}).get("spec", {})
            refs = [c.get("image") for kind in ("containers", "initContainers") for c in template.get(kind, [])]
            if uid in {owner.get("uid") for owner in item.get("metadata", {}).get("ownerReferences", [])}:
                revision = int((item["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision", "0"))
                history.append((revision, refs))
            else:
                in_use |= {resolve(ref) for ref in refs}
        keep_refs = [self.image_of(value, index)]
        for _, refs in sorted(history, key=lambda entry: entry[0], reverse=True):
            for ref in sorted(refs):
                if ref not in keep_refs and anchored_image(ref, self.anchors) and len(keep_refs) < 1 + int(self.limits["retainPreviousImages"]):
                    keep_refs.append(ref)
        previous = self.ann_json(value, "previous")
        if isinstance(previous, dict) and anchored_image(previous.get("image"), self.anchors) and previous["image"] not in keep_refs:
            keep_refs.append(previous["image"])
        keep = {resolve(ref) for ref in keep_refs} - {None}
        containerd = self.containerd_refs()
        repository = self.anchors["imageRepository"]
        remove, foreign, unused_foreign = [], [], []
        for image_id, image in sorted(images.items()):
            ours = [ref for ref in image["refs"] if anchored_image(ref, self.anchors)
                    and containerd.get(ref, (None, {}))[1].get(A.PULLED_LABEL.split("=")[0]) == "true"]
            if image_id in keep or image_id in in_use:
                continue
            if not ours:
                if any(ref.startswith(repository + "@") or ref.startswith(repository + ":") for ref in image["refs"]):
                    labels = {ref: containerd.get(ref, (None, {}))[1] for ref in image["refs"]}
                    pins = [ref for ref, found in labels.items() if found.get("io.cri-containerd.pinned") == "pinned"]
                    own = any(found.get(A.OWN_PIN_LABEL.split("=")[0]) == "true" for found in labels.values())
                    unused_foreign.append({
                        "id": image_id, "refs": image["refs"], "size": image["size"], "pinnedRefs": pins,
                        "pinnedBy": "preview-deploy" if own else ("another procedure" if pins else None),
                        "labels": labels,
                        "referencedBy": [f"ReplicaSet revision {revision}" for revision, refs in history
                                         if image_id in {resolve(ref) for ref in refs}]})
                continue
            others = [ref for ref in image["refs"] if ref not in ours]
            pinned_by_others = any(labels.get("io.cri-containerd.pinned") == "pinned"
                                   and labels.get(A.OWN_PIN_LABEL.split("=")[0]) != "true"
                                   for ref, (_, labels) in containerd.items() if by_ref.get(ref) == image_id)
            if others or pinned_by_others or len(ours) != 1:
                foreign.append(ours[0])
                continue
            remove.append({"ref": ours[0], "id": image_id, "size": image["size"]})
        return {"keep": keep_refs, "keepIds": sorted(keep), "remove": remove, "untouched": sorted(foreign),
                "unusedForeign": unused_foreign}

    def remove_image(self, item):
        """crictl rmi with a long deadline, then a check by image ID. crictl can give up while
        containerd still finishes the removal, so a failed rmi is checked, never assumed."""
        try:
            done = self.k3s_result(crictl_args(["rmi", item["ref"]], A.CRICTL_WRITE_TIMEOUT_SECONDS),
                                   A.CRICTL_WRITE_TIMEOUT_SECONDS + A.CRICTL_SLACK_SECONDS)
            if done.returncode == 0:
                return {"outcome": "removed"}
            lines = [line.strip() for line in done.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
            error = lines[-1] if lines else f"exit {done.returncode}"
        except Refusal as exc:
            error = str(exc)
        found = {"error": error[:400], "deadlineExceeded": "DeadlineExceeded" in error}
        self.log("remove-check", ref=item["ref"], **found)
        started = CLOCK()
        while True:
            try:
                present = item["id"] in self.node_images()
            except (Refusal, ValueError, KeyError):
                present = None
            if present is False:
                return dict(found, outcome="removed-after-error")
            if CLOCK() - started >= A.REMOVE_VERIFY_SECONDS:
                return dict(found, outcome="still-present" if present else "unverified")
            SLEEP(5)

    def retain_images(self, execute, budget):
        """Pin what is kept; remove only when execute (gc --execute, or after gc has been armed).
        A removal starts only while the budget, counted from here, still fits a whole one."""
        started = CLOCK()
        try:
            plan = self.image_plan()
            containerd, labelled = self.containerd_refs(), False
            for ref in plan["keep"]:
                if ref in containerd and containerd[ref][1].get("io.cri-containerd.pinned") != "pinned":
                    self.label(ref, A.PINNED_LABEL)
                    self.label(ref, A.OWN_PIN_LABEL)
                    labelled = True
            if labelled:  # read the pins back once
                images = self.node_images()
                require(all(image["pinned"] for image in images.values() if set(image["refs"]) & set(plan["keep"])),
                        "PIN_FAILED", "a kept image did not stay pinned")
            removals = []
            if execute:
                containerd = self.containerd_refs()
                for item in plan["remove"]:
                    if item["ref"] not in containerd:
                        removals.append(dict(item, outcome="already-gone"))
                        continue
                    if CLOCK() - started + A.REMOVE_WORST_SECONDS > budget:
                        removals.append(dict(item, outcome="deferred"))
                        continue
                    try:
                        if containerd[item["ref"]][1].get(A.OWN_PIN_LABEL.split("=")[0]) == "true":
                            self.label(item["ref"], A.PINNED_LABEL, on=False)
                            self.label(item["ref"], A.OWN_PIN_LABEL, on=False)
                    except Refusal as exc:
                        removals.append(dict(item, outcome="failed", error=exc.code))
                        continue
                    removals.append(dict(item, **self.remove_image(item)))
            return {"kept": plan["keep"],
                    "removed": [item["ref"] for item in removals if item["outcome"] in REMOVED],
                    "notRemoved": [item["ref"] for item in removals if item["outcome"] not in REMOVED + ("already-gone",)],
                    "removals": removals,
                    "removable": [item["ref"] for item in plan["remove"]] if not execute else [],
                    "untouched": plan["untouched"]}
        except (Refusal, ValueError, KeyError) as exc:
            self.log("retention-skipped", reason=exc.code if isinstance(exc, Refusal) else type(exc).__name__)
            return {"skipped": True}

    def run_gc(self):
        self.window_check()
        retention = self.retain_images(execute=True, budget=A.GC_REMOVE_BUDGET_SECONDS)
        if retention.get("skipped"):
            return self.finish("GC_INCOMPLETE", retention=retention)
        with open(PATHS["armed"], "w") as handle:  # later deploys may now apply retention themselves
            handle.write(utc_stamp() + "\n")
        return self.finish("GC_INCOMPLETE" if retention["notRemoved"] else "GC_DONE", retention=retention)

    # Selftest (review C-M7) ----------------------------------------------
    def run_selftest(self):
        """Read-only. Proves the unit's sandbox can run every tool the real runs need."""
        checks = S.Checks()

        def attempt(name, function):
            try:
                detail = function()
                checks.record(name, True, detail or "ok")
            except (Refusal, self.au.Refusal, OSError, ValueError, KeyError) as exc:
                checks.record(name, False, getattr(exc, "code", type(exc).__name__))
        attempt("python", lambda: f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")

        def no_new_privileges():
            with open(PATHS["procStatus"]) as handle:
                flag = [line.split()[-1] for line in handle if line.startswith("NoNewPrivs:")]
            require(flag == ["1"], "SELFTEST", "NoNewPrivileges is not in force")
            return "NoNewPrivs 1"
        attempt("no new privileges", no_new_privileges)

        def selinux():
            with open(PATHS["procAttr"]) as handle:
                return handle.read().strip("\x00\n")
        attempt("selinux context", selinux)
        attempt("kubectl identity", lambda: "Deployment " + self.deployment()[0]["metadata"]["uid"])
        attempt("crictl", lambda: self.crictl(["version"]).splitlines()[0][:80])
        attempt("ctr", lambda: f"{len(self.containerd_refs())} image names")
        attempt("pins readable", lambda: f"{sum(1 for image in self.node_images().values() if image['pinned'])} pinned images")
        attempt("capacity", lambda: f"{self.capacity(0) // MIB} MiB above the image-GC reserve")
        attempt("dns", lambda: S.check_dns(self.anchors, self.limits["edgeAddress"]))

        def https():
            response = S.FETCH(self.anchors["origin"] + "/healthz")
            require(response.status == 200, "SELFTEST", f"HTTP {response.status}")
            return "TLS verified; /healthz 200"
        attempt("https", https)
        for item in checks.items:
            self.log("selftest", **item)
        return self.finish("SELFTEST_OK" if checks.ok else "SELFTEST_FAILED", checks=checks.items)

    # ExecStopPost --------------------------------------------------------
    def stop_post(self, environment):
        """Decide from the live phase, never from whether the run wrote a result."""
        result_path = os.path.join(PATHS["results"], self.request["deployId"] + ".json")
        finished = os.path.exists(result_path)
        if finished:
            with open(result_path) as handle:
                outcome = json.load(handle).get("result")
            if outcome in ("ROLLED_BACK", "ROLLBACK_UNHEALTHY", "CONVERSION_REVERTED"):
                return 0  # the run already made its one rollback attempt
        if self.request["kind"] in ("gc", "selftest", "adopt"):
            return 0 if finished else self.finish("STOPPED", reason="unit stopped")
        stopped = {name: environment.get(name) for name in ("SERVICE_RESULT", "EXIT_CODE", "EXIT_STATUS")}
        reason = "UNIT_STOPPED " + compact(stopped)
        try:
            value, index = self.deployment()
        except (Refusal, self.au.Refusal) as exc:
            if finished:
                return 0
            return self.finish("STOPPED", reason=reason, problem="live state unreadable: " + str(exc)[:200])
        phase = self.ann(value, "phase")
        if self.ann(value, "deploy-id") != self.request["deployId"] or phase not in A.UNCERTAIN_PHASES:
            return 0 if finished else self.finish("STOPPED", reason=reason, phase=phase)
        if self.request["kind"] == "convert":
            return self.revert_conversion(self.request["conversion"], reason)
        previous = self.ann_json(value, "previous")
        if not isinstance(previous, dict) or not previous.get("image"):
            return self.finish("STOPPED", reason=reason, phase=phase, problem="no recorded previous build")
        if phase == "switching" and self.image_of(value, index) == previous["image"]:
            prior = previous.get("prior")
            self.annotate({"phase": "aborted", "previous": compact(prior) if isinstance(prior, dict) else None, "reason": reason[:500]},
                          expect_image=previous["image"])
            return self.finish("ABORTED", reason=reason)
        return self.restore(previous, reason, watch=False)


def secure_lock_dir(path):
    """A root-owned 0700 directory that is not a symbolic link (review S-L4)."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not (info.st_mode & 0o077),
            "LOCK_UNSAFE", "the lock directory is not a private directory of this user")


@contextlib.contextmanager
def node_lock(path, wait_seconds=0):
    """The node lock every preview change takes (the unit, and manual work under flock)."""
    secure_lock_dir(os.path.dirname(path))
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.monotonic() >= deadline:
                os.close(fd)
                raise Refusal("LOCK_HELD", "another preview change holds the node lock")
            time.sleep(2)
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def progress_logger(path):
    def log(event, **fields):
        line = json.dumps({"t": utc_stamp(), "event": event, **fields}, sort_keys=True)
        print(line, flush=True)
        if path:
            with contextlib.suppress(OSError):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "a") as out:
                    out.write(line + "\n")
    return log


def main(argv, app_update_path, environment=None):
    """node_runner.py run|stop-post REQUEST"""
    environment = os.environ if environment is None else environment
    require(len(argv) == 2 and argv[0] in ("run", "stop-post"), "BAD_REQUEST", "usage: run|stop-post REQUEST")
    log = progress_logger(os.path.join(PATHS["run"], "progress.jsonl"))
    try:
        with open(argv[1]) as handle:
            request = strict_json(handle.read(), "request")
        au = load_app_update(app_update_path)
        runner = Runner(request, au, log)
    except (Refusal, OSError) as exc:
        log("refused", code=getattr(exc, "code", "BAD_REQUEST"), reason=str(exc)[:300])
        return 1
    try:
        with node_lock(PATHS["lock"], wait_seconds=60 if argv[0] == "stop-post" else 0):
            if argv[0] == "stop-post":
                return runner.stop_post(environment)
            handler = {"deploy": runner.run_deploy, "rollback": runner.run_rollback, "convert": runner.run_convert,
                       "gc": runner.run_gc, "selftest": runner.run_selftest, "adopt": runner.run_adopt}[request["kind"]]
            return handler()
    except Refusal as exc:
        if argv[0] == "stop-post":
            log("stop-post-refused", code=exc.code, reason=exc.message[:300])
            return 1
        return runner.finish("REFUSED", code=exc.code, reason=exc.message[:500])
    except runner.au.Refusal as exc:
        return runner.finish("REFUSED", code="APP_UPDATE", reason=str(exc)[:500])


# Read-only queries for status, plan and gc reports --------------------------
def read(query, au):
    require_python()
    require(isinstance(query, dict) and query.get("op") in ("status", "plan", "smoke", "gc"), "BAD_REQUEST", "unknown query")
    probe = dict(query["request"], kind="read")
    runner = Runner(probe, au)
    value, index = runner.deployment()
    if query["op"] == "status":
        annotations = {name[len(A.ANNOTATION_PREFIX):]: text for name, text in (value["metadata"].get("annotations") or {}).items()
                       if name.startswith(A.ANNOTATION_PREFIX)}
        pods = []
        for pod in runner.pods(value):
            statuses = pod.get("status", {}).get("containerStatuses", [])
            pods.append({"name": pod["metadata"]["name"], "phase": pod.get("status", {}).get("phase"),
                         "restarts": sum(s.get("restartCount", 0) for s in statuses),
                         "ready": all(s.get("ready") for s in statuses) and bool(statuses)})
        unit = subprocess.run([PATHS["systemctl"], "show", "-p", "ActiveState", "--value", A.NODE_UNIT],
                              capture_output=True, timeout=20, check=False).stdout.decode().strip()
        results = sorted(name for name in os.listdir(PATHS["results"]) if name.endswith(".json") and not name.endswith(".request.json")) \
            if os.path.isdir(PATHS["results"]) else []
        last = None
        if results:
            with open(os.path.join(PATHS["results"], results[-1])) as handle:
                last = json.load(handle)
                last.pop("checks", None)
                last.pop("rollbackChecks", None)
        return {"deployment": {"uid": value["metadata"]["uid"], "generation": value["metadata"].get("generation"),
                               "image": runner.image_of(value, index), "ready": runner.ready(value),
                               "revision": (value["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision"),
                               "converted": L.is_converted(value, index, runner.anchors)},
                "preview": annotations, "pods": pods, "unit": unit, "lastResult": last}
    if query["op"] == "plan":
        configmaps = {}
        for volume in value["spec"]["template"]["spec"].get("volumes", []):
            name = (volume.get("configMap") or {}).get("name")
            if volume.get("name") in runner.anchors["conversionVolumes"] and name:
                data = json.loads(runner.kube.run(["get", "configmap", name, "--namespace", runner.anchors["namespace"], "-o", "json"]))
                configmaps[volume["name"]] = {"name": name, "data": data.get("data", {})}
        return {"deployment": value, "configMaps": configmaps}
    if query["op"] == "smoke":
        expect = validate_expect(query["expect"])
        checks, _ = runner.run_smoke(expect, runner.image_of(value, index))
        return {"checks": checks.items, "ok": checks.ok}
    plan = runner.image_plan()
    claims = gc_claims(runner, value, query.get("legacyClaims") or [])
    return {"images": {"keep": plan["keep"], "remove": [item["ref"] for item in plan["remove"]],
                       "removeBytes": sum(item["size"] for item in plan["remove"]), "untouched": plan["untouched"],
                       "unusedForeign": plan["unusedForeign"]},
            "claims": claims, "deploysSinceConversion": int(runner.ann(value, "deploys") or "0"),
            "retentionArmed": os.path.exists(PATHS["armed"])}


def gc_claims(runner, deployment, legacy):
    """Claim report only. The command never deletes a claim; Andy does, from this list."""
    namespace = runner.anchors["namespace"]
    claims = json.loads(runner.kube.run(["get", "persistentvolumeclaims", "--namespace", namespace, "-o", "json"]))
    objects = json.loads(runner.kube.run(["get", "pods,replicasets,statefulsets", "--namespace", namespace, "-o", "json"]))
    mounted, referenced = set(), {}
    for item in objects.get("items", []):
        spec = item.get("spec", {})
        template = spec if item.get("kind") == "Pod" else spec.get("template", {}).get("spec", {})
        for volume in (template or {}).get("volumes", []):
            name = (volume.get("persistentVolumeClaim") or {}).get("claimName")
            if not name:
                continue
            if item.get("kind") == "Pod":
                mounted.add(name)
            else:
                revision = (item["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision")
                referenced.setdefault(name, []).append(f"{item['kind']} {item['metadata']['name']}" +
                                                       (f" (revision {revision})" if revision else ""))
    deploys = int(runner.ann(deployment, "deploys") or "0")
    report = []
    for claim in claims.get("items", []):
        metadata = claim["metadata"]
        labels = metadata.get("labels") or {}
        listed = metadata["name"] in legacy or labels.get("lolly.tools/managed-by") == "preview-deploy"
        if not listed:
            continue
        reasons = []
        if metadata["name"] in mounted:
            reasons.append("mounted by a Pod")
        if referenced.get(metadata["name"]):
            reasons.append("referenced by a retained ReplicaSet or StatefulSet (a rollback point)")
        if any(owner.get("kind") == "StatefulSet" for owner in metadata.get("ownerReferences", [])) or \
                re.search(r"postgres|database|durable", " ".join(f"{k}={v}" for k, v in labels.items()) + metadata["name"]):
            reasons.append("durable or StatefulSet claim")
        if deploys < 2:
            reasons.append(f"only {deploys} image deploys since the conversion (2 needed)")
        report.append({"name": metadata["name"], "uid": metadata.get("uid"), "created": metadata.get("creationTimestamp"),
                       "candidate": not reasons, "blockedBy": reasons, "referencedBy": referenced.get(metadata["name"], [])})
    return report
