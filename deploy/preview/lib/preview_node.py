# SPDX-License-Identifier: MPL-2.0
"""Node side of the preview deploy command. Runs as root inside lolly-preview-deploy.service.

Only these changes are in the code path: pull, pin and unpin images of the
anchored package; the target Deployment's image (through Work's app-update.py),
its metadata annotations, and once its 3.6 layout. Nothing here touches Secrets,
PVCs, Postgres, the edge or DNS.
"""

from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import json
import os
import re
import subprocess
import sys
import time

import preview_anchors as A
import preview_layout as L
import preview_smoke as S
from preview_common import (DEPLOY_ID, HEX64, SHA, Refusal, compact, compact_digest, require, require_python,
                            strict_json, utc_stamp)
from preview_expect import format_lowering

PATHS = {"run": A.NODE_RUN_DIR, "results": A.NODE_RESULTS_DIR, "lock": A.NODE_LOCK,
         "imagefs": A.NODE_IMAGE_FILESYSTEM, "systemctl": A.NODE_SYSTEMCTL}
MIB = 2 ** 20
EXIT = {"LIVE": 0, "ALREADY_LIVE": 0, "CONVERTED": 0, "ALREADY_CONVERTED": 0, "GC_DONE": 0, "ABORTED": 1,
        "REFUSED": 1, "STOPPED": 1, "ROLLED_BACK": 2, "CONVERSION_REVERTED": 2, "ROLLBACK_UNHEALTHY": 3}


def load_app_update(path):
    spec = importlib.util.spec_from_file_location("app_update", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def filesystem_bytes(path):
    stat = os.statvfs(path)
    return stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize


def key(name):
    return A.ANNOTATION_PREFIX + name


def _atomic_write(path, text):
    temporary = path + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(text)
    os.replace(temporary, path)


def _number(value, low, high, label):
    require(type(value) in (int, float) and low <= value <= high, "BAD_REQUEST", f"{label} out of range")
    return value


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
    require(request.get("kind") in ("deploy", "rollback", "convert", "gc", "read"), "BAD_REQUEST", "unknown kind")
    anchors = A.site_anchors(request.get("site"))
    require(isinstance(request.get("deployId"), str) and DEPLOY_ID.fullmatch(request["deployId"]) is not None,
            "BAD_REQUEST", "deploy id is malformed")
    require(isinstance(request.get("tool"), str) and HEX64.fullmatch(request["tool"]) is not None, "BAD_REQUEST", "tool hash")
    target = au.validate_target(request.get("target"))
    require(target["version"] == 1 and target["transport"]["type"] == "local" and set(target["components"]) == {anchors["component"]},
            "BAD_REQUEST", "the node target owns exactly the anchored component over local kubectl")
    component = target["components"][anchors["component"]]
    require(component["namespace"] == anchors["namespace"] and component["deployment"] == anchors["deployment"]
            and component["container"] == anchors["container"] and not component.get("healthURLs"),
            "BAD_REQUEST", "the target is not the anchored Deployment")
    require(isinstance(request.get("k3s"), str) and request["k3s"].startswith("/") and ".." not in request["k3s"],
            "BAD_REQUEST", "k3s must be an absolute path")
    limits = request.get("limits")
    require(isinstance(limits, dict), "BAD_REQUEST", "limits are missing")
    _number(limits.get("rolloutTimeoutSeconds"), 30, 1800, "rollout timeout")
    _number(limits.get("watchMinutes"), 0, 60, "watch minutes")
    _number(limits.get("watchIntervalSeconds"), 1, 300, "watch interval")
    _number(limits.get("watchFailures"), 1, 20, "watch failures")
    _number(limits.get("memoryFraction"), 0.1, 1.0, "memory fraction")
    _number(limits.get("retainPreviousImages"), 1, 10, "image retention")
    _number(limits.get("maxAddedPages"), 0, 10, "added pages")
    _number(limits.get("needBytes"), 0, 2 ** 40, "capacity need")
    require(isinstance(limits.get("edgeAddress"), str) and re.fullmatch(r"[0-9a-f.:]{3,45}", limits["edgeAddress"]) is not None,
            "BAD_REQUEST", "edge address")
    require(isinstance(request.get("modelsRelease"), str) and re.fullmatch(r"models-[0-9a-f]{64}", request["modelsRelease"]) is not None,
            "BAD_REQUEST", "models release")
    require(type(request.get("drillFailSmoke")) is bool and type(request.get("clearHold")) is bool, "BAD_REQUEST", "flags")
    if request["kind"] in ("deploy", "convert"):
        release = request.get("release")
        require(isinstance(release, dict) and set(release) == {"source", "image", "ciRun", "formats", "expect"},
                "BAD_REQUEST", "release is malformed")
        require(re.fullmatch(re.escape(anchors["imageRepository"]) + r"@sha256:[0-9a-f]{64}", release["image"] or "") is not None,
                "BAD_REQUEST", "release image is not the anchored package by digest")
        require(SHA.fullmatch(release["source"]) is not None and re.fullmatch(r"[1-9][0-9]{0,15}", release["ciRun"]) is not None,
                "BAD_REQUEST", "release source or run")
        require(isinstance(release["formats"], dict), "BAD_REQUEST", "release formats")
        validate_expect(release["expect"])
        require(release["expect"]["source"] == release["source"], "BAD_REQUEST", "expectations name another source")
    if request["kind"] == "convert":
        plan = request.get("conversion")
        require(isinstance(plan, dict) and isinstance(plan.get("patch"), list) and plan.get("deployId") == request["deployId"]
                and plan.get("tool") == request["tool"], "BAD_REQUEST", "conversion plan missing, or made by another run or tool")
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
    def deployment(self):
        self.au.check_cluster(self.target, self.kube)
        value, index = self.au.check_deployment(self.component, self.kube)
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

    def k3s_run(self, args, timeout=120):
        try:
            done = subprocess.run([self.k3s, *args], capture_output=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("NODE_COMMAND", f"k3s {args[0]} failed to run") from exc
        require(done.returncode == 0, "NODE_COMMAND", f"k3s {' '.join(args[:2])} exited {done.returncode}")
        return done.stdout.decode("utf-8", "replace")

    def pods(self, value):
        labels = value["spec"]["selector"]["matchLabels"]
        selector = ",".join(f"{name}={labels[name]}" for name in sorted(labels))
        data = json.loads(self.kube.run(["get", "pods", "--namespace", self.anchors["namespace"], "-l", selector, "-o", "json"]))
        return [pod for pod in data.get("items", []) if not pod["metadata"].get("deletionTimestamp")]

    def working_set(self, container_id):
        data = json.loads(self.k3s_run(["crictl", "stats", "-o", "json", "--id", container_id]))
        stats = data.get("stats") or []
        if len(stats) != 1:
            return None
        value = ((stats[0].get("memory") or {}).get("workingSetBytes") or {}).get("value")
        return int(value) if isinstance(value, (int, str)) and str(value).isdigit() else None

    def pod_check(self, image, memory):
        try:
            value, index = self.deployment()
            pods = self.pods(value)
            if len(pods) != 1:
                return False, f"{len(pods)} live Pods"
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
        except (Refusal, ValueError, KeyError, TypeError) as exc:
            return False, "pod check failed: " + (exc.code if isinstance(exc, Refusal) else type(exc).__name__)

    # Writes --------------------------------------------------------------
    def annotate(self, values, expect_image=None, attempts=3):
        """Guarded metadata patch: UID, resourceVersion and (optionally) the current image are tested."""
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
            except Exception as exc:  # a conflict, re-read and try again
                last = exc
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

    def image_present(self, image):
        try:
            data = json.loads(self.k3s_run(["crictl", "inspecti", "-o", "json", image]))
        except (Refusal, ValueError):
            return False
        return image in ((data.get("status") or {}).get("repoDigests") or [])

    def containerd_refs(self, image):
        """Every containerd name whose manifest digest is this image's digest (offline imports carry tags)."""
        digest = image.partition("@")[2]
        refs = []
        for line in self.k3s_run(["ctr", "-n", "k8s.io", "images", "ls"]).splitlines()[1:]:
            columns = line.split()
            if len(columns) >= 3 and columns[2] == digest and columns[0].startswith(self.anchors["imageRepository"]):
                refs.append(columns[0])
        return refs

    def set_pin(self, image, pinned):
        refs = self.containerd_refs(image)
        require(bool(refs), "PIN_FAILED", "containerd holds no name for the image")
        for ref in refs:
            self.k3s_run(["ctr", "-n", "k8s.io", "images", "label", ref,
                          A.PINNED_LABEL if pinned else A.PINNED_LABEL.split("=")[0] + "="])

    def ensure_image(self, image):
        if not self.image_present(image):
            self.log("pull", image=image)
            self.k3s_run(["crictl", "pull", image], timeout=900)
            require(self.image_present(image), "PULL_FAILED", "the image is not present after the pull")
        self.set_pin(image, True)

    def switch_image(self, from_image, to_image):
        """Work's own planner and guarded patch: tests UID, resourceVersion, container and current image."""
        release = {"version": 1, "updates": [{"component": self.anchors["component"], "expectedImage": from_image, "image": to_image}]}
        plan = self.au.make_plan(self.target, release, self.kube)
        if not plan["updates"]:
            return "NO_CHANGE"
        result = self.au.apply_plan(self.target, plan, self.au.digest(plan), self.kube,
                                    timeout=int(self.limits["rolloutTimeoutSeconds"]), health=lambda url: None)
        return result["result"]

    # Results -------------------------------------------------------------
    def finish(self, result, **fields):
        record = {"deployId": self.request["deployId"], "kind": self.request["kind"], "site": self.request["site"],
                  "result": result, "finished": utc_stamp(), **fields}
        os.makedirs(PATHS["results"], mode=0o700, exist_ok=True)
        _atomic_write(os.path.join(PATHS["results"], self.request["deployId"] + ".json"), json.dumps(record, sort_keys=True))
        self.log("result", **{k: v for k, v in record.items() if k != "checks"})
        return EXIT.get(result, 1)

    def hold_check(self, phase):
        if phase in A.UNCERTAIN_PHASES + ("rollback-unhealthy",) and not self.request["clearHold"]:
            raise Refusal("HELD_FOR_HUMAN", f"the live phase is {str(phase).upper()}; inspect with status, "
                                            "then pass --clear-hold to proceed")

    def expect_of(self, value):
        record = self.ann_json(value, "expect")
        try:
            return validate_expect(record)
        except (Refusal, TypeError):
            return None

    def previous_record(self, value, index):
        """What the live release is, from the annotations the command wrote when it went live."""
        record = {"source": self.ann(value, "source"), "image": self.image_of(value, index),
                  "ciRun": self.ann(value, "ci-run"), "formats": self.ann_json(value, "formats"), "expect": self.expect_of(value)}
        require(record["source"] and SHA.fullmatch(record["source"]) is not None and record["expect"] is not None
                and record["expect"]["source"] == record["source"], "NO_PREVIOUS_RECORD",
                "the live release carries no preview records; run the 3.6 conversion plan first")
        return record

    def receipt_files(self, expect):
        """The served receipt's file map (best effort, used only to find newly added /info pages)."""
        try:
            response = S.FETCH(self.anchors["origin"] + "/release-frontend.sig.json")
            if response.status == 200:
                from preview_receipt import verify_frontend_receipt
                return verify_frontend_receipt(response.body, self.pin, expect["source"], self.anchors["receiptTarget"], expect["profile"])
        except Refusal:
            return None
        return None

    def run_smoke(self, expect, image, extra_pages=None, exact_headers=True):
        S.check_dns(self.anchors, self.limits["edgeAddress"])
        checks, files = S.smoke(expect, self.anchors, self.pin, pod_check=lambda memory: self.pod_check(image, memory),
                                extra_pages=extra_pages, exact_headers=exact_headers)
        for item in checks.items:
            self.log("smoke", **item)
        return checks, files

    def watch(self, index_sha, image):
        return S.watch(index_sha, self.anchors, lambda memory: self.pod_check(image, memory),
                       self.limits["watchMinutes"], self.limits["watchIntervalSeconds"], int(self.limits["watchFailures"]),
                       sleep=SLEEP, clock=CLOCK, log=self.log)

    # Deploy --------------------------------------------------------------
    def run_deploy(self):
        release = self.request["release"]
        value, index = self.deployment()
        self.hold_check(self.ann(value, "phase"))
        live_image = self.image_of(value, index)
        if live_image == release["image"]:
            return self.finish("ALREADY_LIVE", image=live_image, source=self.ann(value, "source"))
        require(L.is_converted(value, index, self.anchors), "NOT_CONVERTED", "the Deployment still mounts the claim root; run the 3.6 conversion")
        require(L.models_release(value, index, self.anchors) == self.request["modelsRelease"], "MODELS_CHANGED",
                "the mounted models release is not the one the profile names; use the models procedure")
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        previous = self.previous_record(value, index)
        require(previous["source"] == self.request.get("liveSource"), "STATE_CHANGED", "the live release changed since the command read it")
        need = 0 if self.image_present(release["image"]) else int(self.limits["needBytes"])
        self.capacity(need)
        self.ensure_image(release["image"])
        self.ensure_image(live_image)  # the rollback target stays pinned
        old_files = self.receipt_files(previous["expect"])
        added = lambda files: S.added_info_pages(files, old_files, int(self.limits["maxAddedPages"]))
        deploys = int(self.ann(value, "deploys") or "0")
        self.annotate({"phase": "switching", "deploy-id": self.request["deployId"], "previous": compact(previous),
                       "reason": None, "updated": utc_stamp()}, expect_image=live_image)
        self.log("phase", phase="switching")
        try:
            self.switch_image(live_image, release["image"])
            self.annotate({"phase": "switched-unverified", "source": release["source"], "image": release["image"],
                           "ci-run": release["ciRun"], "tool": self.request["tool"], "formats": compact(release["formats"]),
                           "expect": compact(release["expect"]), "updated": utc_stamp()}, expect_image=release["image"])
            self.log("phase", phase="switched-unverified")
        except (Refusal, self.au.Refusal) as exc:
            return self.restore(previous, "ROLLOUT_FAILED: " + str(exc)[:300], watch=False)
        try:  # from here on, any refusal rolls back
            checks, files = self.run_smoke(release["expect"], release["image"], extra_pages=added)
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
        retention = self.retain_images()
        return self.finish("LIVE", source=release["source"], image=release["image"], previous=previous["image"],
                           checks=checks.items, retention=retention)

    def restore(self, previous, reason, watch, checks=None):
        """One rollback attempt to the recorded previous build, then its own smoke. Never a second attempt."""
        self.log("rollback", reason=reason)
        with contextlib.suppress(Refusal):
            self.annotate({"phase": "rolling-back", "reason": reason[:500], "updated": utc_stamp()})
        try:
            value, index = self.deployment()
            current = self.image_of(value, index)
            if current != previous["image"]:
                self.ensure_image(previous["image"])
                self.switch_image(current, previous["image"])
            back, files = self.run_smoke(previous["expect"], previous["image"])
            problem = None if back.ok else "smoke of the previous build failed: " + ", ".join(i["check"] for i in back.failures())
            if problem is None and watch:
                problem = self.watch(files["index.html"], previous["image"])
        except (Refusal, self.au.Refusal) as exc:
            back, problem = None, str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500], "updated": utc_stamp()})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks,
                               rollbackChecks=back.items if back else None)
        try:
            self.annotate({"phase": "rolled-back", "source": previous["source"], "image": previous["image"],
                           "ci-run": previous["ciRun"], "formats": compact(previous["formats"]) if previous["formats"] else None,
                           "expect": compact(previous["expect"]), "previous": None, "reason": reason[:500],
                           "updated": utc_stamp()}, expect_image=previous["image"])
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
        require(previous.get("source") == self.request.get("rollbackTo"), "STATE_CHANGED", "the recorded previous build changed")
        validate_expect(previous["expect"])
        lowering = format_lowering(self.ann_json(value, "formats"), previous.get("formats"))
        require(not lowering, "FORMAT_LOWERING", "the rollback would lower stored formats (" + ", ".join(lowering) +
                "); roll forward instead")
        require(L.is_converted(value, index, self.anchors), "NOT_CONVERTED", "the Deployment is not on the image layout")
        self.annotate({"deploy-id": self.request["deployId"], "updated": utc_stamp()})
        return self.restore(previous, "MANUAL", watch=True)

    # Conversion (PROPOSAL 3.6) -------------------------------------------
    def run_convert(self):
        plan, release = self.request["conversion"], self.request["release"]
        value, index = self.deployment()
        if L.is_converted(value, index, self.anchors):
            return self.finish("ALREADY_CONVERTED", image=self.image_of(value, index))
        self.hold_check(self.ann(value, "phase"))
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        require(value["metadata"]["uid"] == plan["deploymentUID"] and value["metadata"]["resourceVersion"] == plan["resourceVersion"]
                and compact_digest(value["spec"]) == plan["beforeSpecSha256"], "STATE_CHANGED",
                "the Deployment changed since the plan was made; make and review a new plan")
        require(self.image_of(value, index) == plan["image"] == release["image"], "IMAGE_DIFFERS", "the conversion keeps the live image")
        self.ensure_image(release["image"])
        dry = self.kube.patch(self.component, plan["patch"], True)
        L.guard_layout_result(value, dry, index, plan["after"])
        self.log("phase", phase="converting")
        try:
            result = self.kube.patch(self.component, plan["patch"], False)
            L.guard_layout_result(value, result, index, plan["after"])
            self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
            value, index = self.deployment()
            require(self.ready(value) and L.is_converted(value, index, self.anchors), "NOT_READY", "the converted Pod is not Ready")
        except (Refusal, self.au.Refusal) as exc:
            return self.revert_conversion(plan, "ROLLOUT_FAILED: " + str(exc)[:300])
        try:  # from here on, any refusal restores the claim layout
            checks, files = self.run_smoke(release["expect"], release["image"])
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
        """Put the claim-served layout back exactly. Its smoke skips the exact header check, because the
        old layout serves the ConfigMap's headers; that difference is why the conversion exists."""
        self.log("rollback", reason=reason)
        try:
            value, index = self.deployment()
            if L.is_converted(value, index, self.anchors):
                patch = L.inverse_conversion_patch(value, plan, {key("phase"): "rolling-back", key("layout"): "claim-root",
                                                                 key("reason"): reason[:500]})
                dry = self.kube.patch(self.component, patch, True)
                L.guard_layout_result(value, dry, index, plan["before"])
                result = self.kube.patch(self.component, patch, False)
                L.guard_layout_result(value, result, index, plan["before"])
                self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
            release = self.request["release"]
            back, _ = self.run_smoke(release["expect"], release["image"], exact_headers=False)
            problem = None if back.ok else "smoke after the revert failed: " + ", ".join(i["check"] for i in back.failures())
        except (Refusal, self.au.Refusal) as exc:
            back, problem = None, str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500]})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks)
        self.annotate({"phase": "rolled-back", "updated": utc_stamp()})
        return self.finish("CONVERSION_REVERTED", reason=reason, checks=checks, rollbackChecks=back.items)

    # Retention -----------------------------------------------------------
    def node_images(self):
        data = json.loads(self.k3s_run(["crictl", "images", "-o", "json"]))
        prefix = self.anchors["imageRepository"] + "@"
        found = {}
        for image in data.get("images", []):
            for digest in image.get("repoDigests") or []:
                if isinstance(digest, str) and digest.startswith(prefix):
                    found[digest] = {"id": image.get("id"), "size": int(image.get("size") or 0), "pinned": bool(image.get("pinned"))}
        return found

    def image_plan(self):
        """Keep the live image and the newest N previous ones of this Deployment; never touch an image in use."""
        value, index = self.deployment()
        uid = value["metadata"]["uid"]
        everything = json.loads(self.kube.run(["get", "pods,replicasets", "--all-namespaces", "-o", "json"]))
        in_use, history = set(), []
        for item in everything.get("items", []):
            spec = item.get("spec", {})
            template = spec.get("template", {}).get("spec") if item.get("kind") == "ReplicaSet" else spec
            images = {c.get("image") for kind in ("containers", "initContainers") for c in (template or {}).get(kind, [])}
            owners = {o.get("uid") for o in item.get("metadata", {}).get("ownerReferences", [])}
            if item.get("kind") == "ReplicaSet" and uid in owners:
                revision = int((item["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision", "0"))
                history.append((revision, images))
            else:
                in_use |= images
        keep, ordered = [self.image_of(value, index)], []
        for _, images in sorted(history, key=lambda entry: entry[0], reverse=True):
            ordered += sorted(images)
        for image in ordered:
            if image not in keep and image.startswith(self.anchors["imageRepository"] + "@") and \
                    len(keep) < 1 + int(self.limits["retainPreviousImages"]):
                keep.append(image)
        previous = self.ann_json(value, "previous")
        if isinstance(previous, dict) and isinstance(previous.get("image"), str) and previous["image"] not in keep:
            keep.append(previous["image"])
        present = self.node_images()
        remove = sorted(image for image in present if image not in keep and image not in in_use)
        return {"keep": keep, "remove": remove, "present": present}

    def retain_images(self, execute=True):
        try:
            plan = self.image_plan()
            for image in plan["keep"]:
                if image in plan["present"]:
                    self.set_pin(image, True)
            removed = []
            if execute:
                for image in plan["remove"]:
                    self.set_pin(image, False)
                    self.k3s_run(["crictl", "rmi", plan["present"][image]["id"]])
                    removed.append(image)
            return {"kept": plan["keep"], "removed": removed}
        except (Refusal, ValueError, KeyError) as exc:
            self.log("retention-skipped", reason=exc.code if isinstance(exc, Refusal) else type(exc).__name__)
            return {"skipped": True}

    def run_gc(self):
        retention = self.retain_images(execute=True)
        return self.finish("GC_DONE", retention=retention)

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
            self.annotate({"phase": "aborted", "reason": reason[:500]}, expect_image=previous["image"])
            return self.finish("ABORTED", reason=reason)
        return self.restore(previous, reason, watch=False)


@contextlib.contextmanager
def node_lock(path, wait_seconds=0):
    """The node lock every preview change takes (the unit, and manual work under flock)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle = open(path, "a")
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise Refusal("LOCK_HELD", "another preview change holds the node lock")
            time.sleep(2)
    try:
        yield
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def progress_logger(path):
    def log(event, **fields):
        line = json.dumps({"t": utc_stamp(), "event": event, **fields}, sort_keys=True)
        print(line, flush=True)
        if path:
            with open(path, "a") as out:
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
            handler = {"deploy": runner.run_deploy, "rollback": runner.run_rollback,
                       "convert": runner.run_convert, "gc": runner.run_gc}[request["kind"]]
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
                       if name.startswith(A.ANNOTATION_PREFIX) and name[len(A.ANNOTATION_PREFIX):] not in ("expect",)}
        pods = []
        for pod in runner.pods(value):
            statuses = pod.get("status", {}).get("containerStatuses", [])
            pods.append({"name": pod["metadata"]["name"], "phase": pod.get("status", {}).get("phase"),
                         "restarts": sum(s.get("restartCount", 0) for s in statuses),
                         "ready": all(s.get("ready") for s in statuses) and bool(statuses)})
        unit = subprocess.run([PATHS["systemctl"], "show", "-p", "ActiveState", "--value", A.NODE_UNIT],
                              capture_output=True, timeout=20, check=False).stdout.decode().strip()
        results = sorted(name for name in os.listdir(PATHS["results"]) if name.endswith(".json")) \
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
    return {"images": {"keep": plan["keep"], "remove": plan["remove"],
                       "removeBytes": sum(plan["present"][image]["size"] for image in plan["remove"])},
            "claims": claims, "deploysSinceConversion": int(runner.ann(value, "deploys") or "0")}


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
        if any(owner.get("kind") == "StatefulSet" for owner in metadata.get("ownerReferences", [])) or \
                re.search(r"postgres|database|durable", " ".join(f"{k}={v}" for k, v in labels.items()) + metadata["name"]):
            reasons.append("durable or StatefulSet claim")
        if deploys < 2:
            reasons.append(f"only {deploys} image deploys since the conversion (2 needed)")
        report.append({"name": metadata["name"], "uid": metadata.get("uid"), "created": metadata.get("creationTimestamp"),
                       "candidate": not reasons, "blockedBy": reasons, "referencedBy": referenced.get(metadata["name"], [])})
    return report
