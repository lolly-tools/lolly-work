# SPDX-License-Identifier: MPL-2.0
"""Node side of the lolly.ing preview deploy (PROPOSAL 4.3 to 4.8). Runs as root inside the unit.

What it may change: the imported instance image and its pins; new generation
ConfigMaps; one backup Job from the existing CronJob; read-only check Jobs; and,
only with pending migrations, the classifier and migrate Jobs plus whatever the
Phase 2A rehearsal driver creates in its own namespace. Then the target
Deployment's image, config ConfigMap reference and annotations, and once, at the
cut-over, which Secret its catalog signing key reference names. It never reads
or changes a Secret's value, a PVC, Postgres directly, the edge or DNS, and
never execs into a Pod.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import stat
import subprocess

import preview_anchors as A
import preview_ing as I
import preview_node as N
import preview_smoke as S
from preview_common import DEPLOY_ID, HEX64, SHA, Refusal, compact, parse_utc, require, require_python, strict_json, utc_stamp
from preview_expect import format_lowering
from preview_receipt import verify_frontend_receipt

key = N.key
COOKIE_PATTERN = r"lw_session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{16,3800}"
ACCOUNT_ROLES = ("member",)  # least privilege that can still render one QR code with a grant


def _number(value, low, high, label):
    require(type(value) in (int, float) and low <= value <= high, "BAD_REQUEST", f"{label} out of range")
    return value


def validate_ing_request(request, au):
    """The node trusts only a request shaped exactly like this, for the anchored Deployment."""
    require_python()
    anchors = A.ING
    require(isinstance(request, dict) and request.get("version") == 1 and request.get("site") == "lolly.ing",
            "BAD_REQUEST", "unsupported request")
    require(request.get("kind") in ("deploy", "rollback", "convert", "gc", "read"), "BAD_REQUEST", "unknown kind for lolly.ing")
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
    require(isinstance(request.get("databaseSecret"), str) and 0 < len(request["databaseSecret"]) <= 253, "BAD_REQUEST",
            "database secret name")
    limits = request.get("limits")
    require(isinstance(limits, dict), "BAD_REQUEST", "limits are missing")
    _number(limits.get("rolloutTimeoutSeconds"), 30, A.MAX_ROLLOUT_SECONDS, "rollout timeout")
    _number(limits.get("watchMinutes"), 0, A.MAX_WATCH_MINUTES, "watch minutes")
    _number(limits.get("watchIntervalSeconds"), 1, 300, "watch interval")
    _number(limits.get("watchFailures"), 1, 20, "watch failures")
    _number(limits.get("memoryFraction"), 0.1, 1.0, "memory fraction")
    _number(limits.get("needBytes"), 0, 2 ** 40, "capacity need")
    _number(limits.get("retainPreviousImages"), 1, 10, "image retention")
    _number(limits.get("retainConfigMaps"), 1, 20, "ConfigMap retention")
    require(isinstance(limits.get("edgeAddress"), str) and len(limits["edgeAddress"]) <= 45, "BAD_REQUEST", "edge address")
    window = limits.get("noDeployUtc")
    require(isinstance(window, list) and len(window) == 2 and all(isinstance(t, str) and len(t) == 5 for t in window),
            "BAD_REQUEST", "backup window")
    smoke = request.get("smoke")
    require(isinstance(smoke, dict) and set(smoke) == {"sub", "packAssetPath", "pages"} and isinstance(smoke["sub"], str)
            and 0 < len(smoke["sub"]) <= 200 and isinstance(smoke["packAssetPath"], str) and smoke["packAssetPath"].startswith("/catalog/")
            and isinstance(smoke["pages"], list) and all(isinstance(p, str) and p.startswith("/") for p in smoke["pages"]),
            "BAD_REQUEST", "smoke settings")
    rehearsal = request.get("rehearsal")
    require(isinstance(rehearsal, dict) and set(rehearsal) == {"storageHost", "storageAddress"}
            and all(isinstance(rehearsal[k], str) and 0 < len(rehearsal[k]) <= 253 for k in rehearsal), "BAD_REQUEST",
            "rehearsal settings")
    require(type(request.get("drillFailSmoke")) is bool and type(request.get("clearHold")) is bool, "BAD_REQUEST", "flags")
    if request["kind"] in ("deploy", "convert"):
        release = I.validate_release(request.get("release"))
        approval = request.get("maintenanceApproval")
        require(approval is None or (isinstance(approval, dict) and set(approval) == {"run", "approver", "environment"}),
                "BAD_REQUEST", "maintenance approval")
        if approval is not None:
            # The node checks what the approval says, not only its shape (review 2026-10-25 M3): a pinned approver,
            # the maintenance environment and the build's own run. A hand-built or mistaken approval is refused whole.
            require(bool(A.ING_MAINTENANCE_APPROVERS) and approval["approver"] in A.ING_MAINTENANCE_APPROVERS,
                    "MAINTENANCE_NOT_APPROVED", "the maintenance approval names an approver the tool does not pin")
            require(approval["environment"] == anchors["maintenanceEnvironment"], "MAINTENANCE_NOT_APPROVED",
                    "the maintenance approval is for another environment")
            require(approval["run"] == release["ciRun"], "MAINTENANCE_NOT_APPROVED",
                    "the maintenance approval is from another run than the build's")
    if request["kind"] == "convert":
        plan = request.get("conversion")
        require(isinstance(plan, dict) and isinstance(plan.get("cutover"), dict) and isinstance(plan["cutover"].get("patch"), list)
                and plan.get("deployId") == request["deployId"] and plan.get("tool") == request["tool"]
                and type(plan.get("generation")) is int and isinstance(plan.get("toConfig"), str)
                and isinstance(plan.get("annotations"), dict), "BAD_REQUEST", "cut-over plan missing, or made by another run or tool")
    if request["kind"] == "rollback":
        require(isinstance(request.get("rollbackTo"), str) and SHA.fullmatch(request["rollbackTo"]) is not None,
                "BAD_REQUEST", "rollback target")
    require(request.get("liveSource") is None or SHA.fullmatch(request["liveSource"]) is not None, "BAD_REQUEST", "live source")
    return anchors


class IngRunner(N.Runner):
    @staticmethod
    def validate(request, au):
        return validate_ing_request(request, au)

    def __init__(self, request, au, log=None):
        super().__init__(request, au, log)
        self.pin, self.thumbprint = I.ing_pin()
        self.jobs = 0

    def handlers(self):
        return {"deploy": self.run_deploy, "rollback": self.run_rollback, "convert": self.run_convert, "gc": self.run_gc}

    # Small reads -------------------------------------------------------
    def namespace(self):
        return self.anchors["namespace"]

    def config_maps(self):
        """name -> (generation, instance.json text) for every ConfigMap in the namespace that holds an instance.json."""
        data = json.loads(self.kube.run(["get", "configmaps", "--namespace", self.namespace(), "-o", "json"]))
        found = {}
        for item in data.get("items", []):
            text = (item.get("data") or {}).get(A.ING["configKey"])
            if text is None:
                continue
            found[item["metadata"]["name"]] = (I.config_generation(text), text)
        return found

    def applied_migrations(self, value, name="migrations"):
        names = self.ann_json(value, name)
        return set(names) if isinstance(names, list) and all(isinstance(n, str) for n in names) else set()

    def write_object(self, name, document):
        directory = os.path.join(N.PATHS["run"], "objects")
        os.makedirs(directory, mode=0o700, exist_ok=True)
        path = os.path.join(directory, name + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(document, out, sort_keys=True)
        return path

    def create(self, name, document):
        """Server dry run, then create. Returns the created object."""
        path = self.write_object(name, document)
        self.kube.run(["create", "-f", path, "--dry-run=server", "-o", "json"])
        return json.loads(self.kube.run(["create", "-f", path, "-o", "json"]))

    # Image intake (PROPOSAL 4.3 step 3; R22 S6, S11) ------------------------
    def image_present(self, release):
        refs = self.containerd_refs()
        return refs.get(release["image"], (None, {}))[0] == release["digest"]

    def ensure_image(self, release, _need=None):
        """Import the streamed archive: its sha256 first, then the digests and DiffIDs, then pins."""
        if not self.image_present(release):
            path = os.path.join(N.PATHS["spool"], release["archive"]["sha256"] + ".oci.tar")
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            except OSError as exc:
                raise Refusal("ARCHIVE_MISSING", "the archive was not uploaded to the node; run deploy again") from exc
            try:
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077
                        and info.st_size == release["archive"]["bytes"], "ARCHIVE_UNSAFE",
                        "the spooled archive is not a private root file of the expected size")
                self.capacity(int(self.limits["needBytes"]))
                digest = hashlib.sha256()
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                if digest.hexdigest() != release["archive"]["sha256"]:
                    with contextlib.suppress(OSError):
                        os.unlink(path)
                    raise Refusal("ARCHIVE_MISMATCH", "the spooled archive does not match the manifest; it was deleted")
                os.lseek(fd, 0, os.SEEK_SET)
                self.log("import", image=release["image"])
                args = ["ctr", "--namespace", "k8s.io", "images", "import", "--base-name", A.ING["imageName"], "--digests",
                        "--no-unpack", "--platform", "linux/amd64", "--label", A.PINNED_LABEL, "--label", A.PULLED_LABEL,
                        "--label", A.OWN_PIN_LABEL, "-"]
                try:
                    done = subprocess.run([self.k3s, *args], stdin=fd, capture_output=True,
                                          timeout=A.ING_IMPORT_TIMEOUT_SECONDS, check=False)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise Refusal("IMPORT_FAILED", "ctr images import failed to run") from exc
                require(done.returncode == 0, "IMPORT_FAILED", f"ctr images import exited {done.returncode}")
            finally:
                os.close(fd)
        self.verify_image(release)
        self.drop_run_tag(release)
        with contextlib.suppress(OSError):
            os.unlink(os.path.join(N.PATHS["spool"], release["archive"]["sha256"] + ".oci.tar"))

    def content(self, digest):
        data = subprocess.run([self.k3s, "ctr", "--namespace", "k8s.io", "content", "get", digest], capture_output=True,
                              timeout=120, check=False)
        require(data.returncode == 0 and "sha256:" + hashlib.sha256(data.stdout).hexdigest() == digest, "IMAGE_MISMATCH",
                f"containerd content {digest[:19]} does not hash to its digest")
        return data.stdout

    def verify_image(self, release):
        """The name points at the manifest's digest; an index leads to its one linux/amd64 manifest; that names
        the manifest's config; the config's DiffIDs are the manifest's. Then the pin is read back."""
        refs = self.containerd_refs()
        require(refs.get(release["image"], (None, {}))[0] == release["digest"], "IMAGE_MISMATCH",
                "containerd holds no instance image by the manifest digest")
        top = strict_json(self.content(release["digest"]).decode("utf-8"), "image index")
        manifest_digest = release["digest"]
        if isinstance(top.get("manifests"), list):
            chosen = [m for m in top["manifests"] if isinstance(m, dict) and (m.get("platform") or {}).get("os") == "linux"
                      and (m.get("platform") or {}).get("architecture") == "amd64"]
            require(len(chosen) == 1, "IMAGE_MISMATCH", "the image index has no single linux/amd64 manifest")
            manifest_digest = chosen[0].get("digest")
            top = strict_json(self.content(manifest_digest).decode("utf-8"), "image manifest")
        require(manifest_digest == release["manifestDigest"] and (top.get("config") or {}).get("digest") == release["configDigest"],
                "IMAGE_MISMATCH", "the image manifest or its config differs from the build manifest")
        config = strict_json(self.content(release["configDigest"]).decode("utf-8"), "image config")
        require((config.get("rootfs") or {}).get("diff_ids") == release["diffIds"] and config.get("os") == "linux"
                and config.get("architecture") == "amd64", "IMAGE_MISMATCH", "the image layers (DiffIDs) differ from the manifest")
        labels = refs[release["image"]][1]
        if labels.get("io.cri-containerd.pinned") != "pinned":
            self.label(release["image"], A.PINNED_LABEL)
            self.label(release["image"], A.OWN_PIN_LABEL)
        require((self.inspect(release["image"]) or {}).get("pinned") is True, "PIN_FAILED", "the instance image pin did not read back")

    def drop_run_tag(self, release):
        """`ctr import --base-name` keeps the workflow's run tag beside the digest name. Remove that one name,
        which this import made (its label says so), so retention can later remove the image by digest."""
        tag = self.containerd_refs().get(release["refName"])
        if tag is None:
            return
        require(tag[0] == release["digest"] and tag[1].get(A.PULLED_LABEL.split("=")[0]) == "true", "IMAGE_MISMATCH",
                "the run tag names another image or was not made by this import")
        self.k3s_run(["ctr", "--namespace", "k8s.io", "images", "rm", release["refName"]])

    def keep_pinned(self, image):
        """The rollback target stays pinned (by this command when nobody else pinned it)."""
        refs = self.containerd_refs()
        require(image in refs, "PREVIOUS_IMAGE_MISSING", "the live image is not on the node by its digest name")
        if refs[image][1].get("io.cri-containerd.pinned") != "pinned":
            self.label(image, A.PINNED_LABEL)
            self.label(image, A.OWN_PIN_LABEL)

    # Jobs ----------------------------------------------------------------
    def run_job(self, kind, image, command, env, timeout):
        """One Job from an instance image; returns its logs. Logs are parsed, never printed."""
        value, index = self.deployment(full=False)
        self.jobs += 1
        name = I.job_name(kind, self.request["deployId"], self.jobs)
        created = self.create(name, I.job_manifest(name, kind, self.request["deployId"], value, index, image, command, env,
                                                   max(60, timeout - 30)))
        return self.wait_job(name, created["metadata"]["uid"], kind, timeout)

    def wait_job(self, name, uid, container, timeout):
        started = N.CLOCK()
        while True:
            job = self.kube.get("job", name, self.namespace())
            require(job["metadata"].get("uid") == uid, "JOB_REPLACED", f"Job {name} was replaced")
            status = job.get("status") or {}
            if status.get("succeeded", 0) >= 1:
                break
            require(not status.get("failed"), "JOB_FAILED", f"Job {name} failed; inspect it with kubectl logs job/{name}")
            require(N.CLOCK() - started < timeout, "JOB_TIMEOUT", f"Job {name} did not finish in {timeout} s")
            N.SLEEP(3)
        logs = self.kube.run(["logs", "job/" + name, "-c", container, "--namespace", self.namespace(), "--limit-bytes=1048576"])
        return logs, job

    def database_env(self):
        value, index = self.deployment(full=False)
        return I.database_env(value, index, self.request["databaseSecret"])

    def check_db(self, image):
        """Read-only: the image's migration files, the ledger and the publication generation."""
        env = [entry for entry in self.database_env() if entry["name"] == "DATABASE_URL"]
        logs, _ = self.run_job("check", image, ["node", "--input-type=module", "-e", I.DB_READ_SCRIPT], env, A.JOB_TIMEOUT_SECONDS)
        found = I.last_json_line(logs, "kind", "lolly-migrate-check")
        require(found is not None, "MIGRATION_CHECK", "the read-only check printed no result")
        return I.validate_check(found)

    def classify(self, image, pending):
        """Work's classifier (#207), run from the image on exactly the pending files, with no environment at all."""
        try:
            logs, _ = self.run_job("classify", image, [*A.MIGRATION_CLASSIFIER, ",".join(item["name"] for item in pending)], [],
                                   A.JOB_TIMEOUT_SECONDS)
        except Refusal as exc:
            raise Refusal("CLASSIFIER_UNAVAILABLE", "the migration classifier did not run from the image (it needs Work with "
                          f"scripts/classify-migrations.ts); nothing was applied ({exc.code})") from exc
        return I.validate_classes(I.json_document(logs), pending)

    def rehearse(self, backup, image, previous_image, pending):
        """The restore rehearsal (deploy/preview/restore-rehearsal.py, #208) as a library: restore the fresh backup
        in its own namespace, apply the pending files with the new image's runner within the lock budget, and boot
        the previous image on the copy for one save round trip (R20 S7, R22 S4). This run's check-target covers it."""
        try:
            import preview_rehearsal as RH
        except ImportError as exc:
            raise Refusal("REHEARSAL_UNAVAILABLE", "the restore rehearsal (lib/preview_rehearsal.py) is not in this tool; "
                          "a run with pending migrations, and the cut-over, need it. Nothing was applied") from exc
        settings = self.request["rehearsal"]
        transport = self.target["transport"]
        inputs = RH.Inputs(backup=backup["record"], pending=pending, new_image=image, previous_image=previous_image,
                           postgres_image=A.ING["postgresImage"], storage_host=settings["storageHost"],
                           storage_address=settings["storageAddress"], namespace=A.ING["rehearsalNamespace"],
                           secret=A.ING["rehearsalSecret"], run_id=re.sub(r"[^a-z0-9-]", "-", self.request["deployId"].lower()),
                           lock_budget_seconds=A.MIGRATION_LOCK_BUDGET_SECONDS, deadline_seconds=A.REHEARSAL_DEADLINE_SECONDS)
        require(inputs.expect == I.expect_value(pending), "REHEARSAL_FAILED", "the rehearsal and this tool disagree on LW_MIGRATE_EXPECT")
        kubectl = RH.Kubectl([*transport["kubectl"], "--kubeconfig", transport["kubeconfig"], "--context", transport["context"]])
        self.log("rehearsal", migrations=[item["name"] for item in pending], expect=inputs.expect)
        result = RH.Rehearsal(kubectl, inputs, sleep=N.SLEEP, monotonic=N.CLOCK).run()
        self.log("rehearsal-result", result=result.get("result"), code=result.get("code"), teardown=result.get("teardownComplete"))
        return I.check_rehearsal(result, pending, image, previous_image)

    def migrate(self, image, pending):
        env = self.database_env() + [{"name": "LW_MIGRATE_EXPECT", "value": I.expect_value(pending)},
                                     {"name": "NODE_ENV", "value": "production"}]
        self.log("migrate", migrations=[item["name"] for item in pending])
        self.run_job("migrate", image, list(A.MIGRATION_RUNNER), env, A.MIGRATE_TIMEOUT_SECONDS)

    # Backup (PROPOSAL 4.3 step 4) -------------------------------------------
    def take_backup(self):
        """A fresh off-host backup Job from the existing CronJob. Returns the uploader's own VERIFIED line, which
        the restore rehearsal takes as it is, and the Job's completion time."""
        namespace, cron = self.namespace(), A.ING["backupCronJob"]
        found = self.kube.get("cronjob", cron, namespace)
        require(found["metadata"].get("name") == cron and not found["metadata"].get("deletionTimestamp"), "BACKUP_UNAVAILABLE",
                "the backup CronJob is missing")
        self.jobs += 1
        name = I.job_name("backup", self.request["deployId"], self.jobs)
        self.log("backup", job=name)
        created = json.loads(self.kube.run(["create", "job", name, "--from=cronjob/" + cron, "--namespace", namespace, "-o", "json"]))
        logs, job = self.wait_job(name, created["metadata"]["uid"], A.ING["backupContainer"], A.BACKUP_TIMEOUT_SECONDS)
        line = I.last_json_line(logs, "status", "VERIFIED")
        require(isinstance(line, dict) and set(line) == {"status", "object", "sha256", "size", "keyId"}
                and isinstance(line["object"], str) and re.fullmatch(A.ING["backupObjectPattern"], line["object"]) is not None
                and isinstance(line["sha256"], str) and HEX64.fullmatch(line["sha256"]) and type(line["size"]) is int
                and 0 < line["size"] <= A.ING["backupMaxBytes"] and isinstance(line["keyId"], str)
                and re.fullmatch(r"[0-9a-f]{16}", line["keyId"]) is not None,
                "BACKUP_UNVERIFIED", "the backup Job did not report a verified off-host archive")
        completed = (job.get("status") or {}).get("completionTime")
        require(isinstance(completed, str), "BACKUP_UNVERIFIED", "the backup Job has no completion time")
        return {"job": name, "record": line, "completedAt": completed}

    def backup_fresh(self, backup, maintenance):
        limit = A.MAINTENANCE_BACKUP_MAX_AGE_SECONDS if maintenance else A.BACKUP_MAX_AGE_SECONDS
        age = N.WALL() - parse_utc(backup["completedAt"]).timestamp()
        require(age < limit, "BACKUP_STALE", f"the fresh backup is {int(age // 60)} minutes old at the switch; "
                f"the limit is {limit // 60}. Nothing was switched")

    # Generation and config (PROPOSAL 4.3 step 7) ------------------------------
    def new_config(self, generation, live_text, source):
        name = I.config_name(generation, source)
        text = I.with_generation(live_text, generation)
        existing = self.config_maps()
        if name in existing:  # an earlier attempt of this run created it; reuse only identical bytes
            require(existing[name][1] == text, "CONFIG_EXISTS", f"ConfigMap {name} exists with other content")
            return name
        self.create(name, I.config_map(name, text, generation, self.request["deployId"]))
        self.log("config", name=name, generation=generation)
        return name

    def generation_for(self, live_text, check, seq):
        cms = self.config_maps()
        return I.next_generation(I.config_generation(live_text), [gen for gen, _ in cms.values()], check["publicationGeneration"], seq)

    # Switch (PROPOSAL 4.3 step 8) ----------------------------------------------
    def switch(self, from_image, from_config, to_image, to_config, annotations):
        """The guarded patch, re-planned while nothing has been applied. Raises SWITCH_NOT_APPLIED."""
        last = "no attempt"
        for _ in range(N.SWITCH_ATTEMPTS):
            value, index = self.deployment()
            _, config = I.config_volume(value, index)
            current = self.image_of(value, index)
            if current == to_image and config == to_config:
                return self.wait_switch(to_image, to_config)
            require(current == from_image and config == from_config, "STATE_CHANGED",
                    "the live image or config is neither the old nor the new one")
            patch = I.switch_patch(value, index, to_image, to_config, {key(n): v for n, v in annotations.items()})
            try:
                dry = self.kube.patch(self.component, patch, True)
                I.guard_switch(value, dry, index, to_image, to_config)
                result = self.kube.patch(self.component, patch, False)
            except (Refusal, self.au.Refusal) as exc:
                last = str(exc)
                self.log("switch-retry", reason=last[:200])
                N.SLEEP(2)
                continue
            I.guard_switch(value, result, index, to_image, to_config)
            return self.wait_switch(to_image, to_config)
        value, index = self.deployment()
        if self.image_of(value, index) == to_image and I.config_volume(value, index)[1] == to_config:
            return self.wait_switch(to_image, to_config)
        raise Refusal("SWITCH_NOT_APPLIED", f"the switch was not applied after {N.SWITCH_ATTEMPTS} attempts: {last[:200]}")

    def wait_switch(self, image, config):
        self.kube.rollout(self.component, int(self.limits["rolloutTimeoutSeconds"]))
        value, index = self.deployment(full=False)
        require(self.image_of(value, index) == image and I.config_volume(value, index)[1] == config and self.ready(value),
                "NOT_READY", "the switched Deployment did not become Ready")

    # Smoke (PROPOSAL 4.5) -------------------------------------------------------
    def smoke_cookie(self):
        """The smoke account's session cookie from a root-only file. Never logged, printed or stored elsewhere."""
        try:
            fd = os.open(N.PATHS["smokeCookie"], os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as exc:
            raise Refusal("SMOKE_ACCOUNT", "the smoke account's session file is missing; see the README") from exc
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077 and info.st_size <= 4096,
                    "SMOKE_ACCOUNT", "the smoke session file must be a private root file")
            text = os.read(fd, 4097).decode("ascii", "replace").strip()
        finally:
            os.close(fd)
        require(re.fullmatch(COOKIE_PATTERN, text) is not None, "SMOKE_ACCOUNT",
                "the smoke session file does not hold one lw_session cookie")
        return text

    def boot_key(self, value):
        pods = self.pods(value)
        require(len(pods) == 1, "BOOT_LOG", f"{len(pods)} Pods in the current ReplicaSet")
        logs = self.kube.run(["logs", pods[0]["metadata"]["name"], "-c", self.anchors["container"], "--namespace", self.namespace(),
                              "--limit-bytes=1048576"])
        return I.boot_key_id(logs)

    def account(self, checks, cookie):
        """The smoke account is the expected member, holds no admin role and owns no projects (R20 S13)."""
        origin, headers = self.anchors["origin"], {"Cookie": cookie, "Accept": "application/json"}
        response = S._get(checks, "smoke account", origin + "/api/auth/session", headers=headers)
        if response is None:
            return False
        try:
            body = json.loads(response.body)
            user = body.get("user") or {}
            ok = (response.status == 200 and body.get("kind") == "member" and user.get("sub") == self.request["smoke"]["sub"]
                  and user.get("role") in ACCOUNT_ROLES)
            detail = "member; no admin role" if ok else f"HTTP {response.status}; the session is not the smoke member, " \
                                                         "or it carries a higher role, or it expired"
            if ok:
                listing = S.FETCH(origin + "/api/v1/projects", headers=headers)
                projects = json.loads(listing.body).get("projects") if listing.status == 200 else None
                owned = [p for p in projects or [] if isinstance(p, dict) and p.get("ownerId") == user.get("sub")]
                ok = isinstance(projects, list) and not owned
                detail += "; owns no projects" if ok else "; the smoke account owns projects or they could not be listed"
        except (ValueError, AttributeError, Refusal) as exc:
            ok, detail = False, "unreadable session answer: " + type(exc).__name__
        return checks.record("smoke account", ok, detail)

    def run_smoke(self, expect, image, generation=None, light=False):
        """PROPOSAL 4.5. light: the live build before the switch (no generation readback, no export)."""
        I.validate_expect(expect)
        S.check_dns(self.anchors, self.limits["edgeAddress"])
        cookie = self.smoke_cookie()
        checks, files = S.Checks(), {"index.html": expect["index"]}
        origin, signed_in = self.anchors["origin"], {"Cookie": cookie, "Accept": "application/json"}
        health = S._get(checks, "healthz", origin + "/healthz")
        if health is not None:
            try:
                body = json.loads(health.body)
                checks.record("healthz", health.status == 200 and body.get("ok") is True and body.get("name") == A.ING["instanceName"],
                              f"HTTP {health.status}; name {body.get('name')!r}")
            except ValueError:
                checks.record("healthz", False, "not JSON")
        ready = S._get(checks, "readyz", origin + "/readyz")
        if ready is not None:
            checks.record("readyz", ready.status == 200, f"HTTP {ready.status}")
        root = S._get(checks, "root", origin + "/")
        if root is not None:
            checks.record("root", root.status == 200 and hashlib.sha256(root.body).hexdigest() == expect["index"],
                          f"HTTP {root.status}; body {'matches' if root.status == 200 and hashlib.sha256(root.body).hexdigest() == expect['index'] else 'differs from'} the signed index.html")
            csp = root.header("Content-Security-Policy") or ""
            directives = {part.split()[0]: part.split()[1:] for part in csp.split(";") if part.split()}
            checks.record("csp blob:", all("blob:" in directives.get(name, []) for name in ("script-src", "connect-src")),
                          "script-src and connect-src allow blob:")
        receipt = S._get(checks, "receipt", origin + "/release-frontend.sig.json")
        if receipt is not None:
            try:
                require(receipt.status == 200, "RECEIPT_INVALID", f"HTTP {receipt.status}")
                require(hashlib.sha256(receipt.body).hexdigest() == expect["receipt"], "RECEIPT_INVALID",
                        "the served receipt is not the build's")
                served = verify_frontend_receipt(receipt.body, self.pin, expect["lolly"], A.ING["receiptTarget"], A.ING["receiptProfile"])
                require(served.get("index.html") == expect["index"], "RECEIPT_INVALID", "the receipt names another index.html")
                checks.record("receipt", True, "the shell's receipt verifies against the lolly.ing pin")
            except Refusal as exc:
                checks.record("receipt", False, exc.message)
        for path in self.request["smoke"]["pages"]:
            page = S._get(checks, "page " + path, origin + path)
            if page is not None:
                checks.record("page " + path, page.status == 200, f"HTTP {page.status}")
        anonymous = S._get(checks, "anonymous catalog", origin + "/catalog/tools/index.json")
        if anonymous is not None:
            checks.record("anonymous catalog", anonymous.status == 401, f"HTTP {anonymous.status} (401 expected)")
        asset = S._get(checks, "anonymous pack asset", origin + self.request["smoke"]["packAssetPath"])
        if asset is not None:
            checks.record("anonymous pack asset", asset.status in (401, 404), f"HTTP {asset.status} (401 or 404 expected)")
        self.account(checks, cookie)
        index = S._get(checks, "signed catalog", origin + "/catalog/tools/index.json", headers=signed_in)
        envelope = S._get(checks, "signed catalog", origin + "/catalog/tools/index.sig.json", headers=signed_in)
        if index is not None and envelope is not None:
            if index.status != 200 or envelope.status != 200:
                checks.record("signed catalog", False, f"HTTP {index.status} and {envelope.status} (a 503 is the generation fence)")
            else:
                try:
                    I.verify_catalog(index.body, envelope.body, self.pin, self.thumbprint)
                    checks.record("signed catalog", True, "200; verifies against the lolly.ing pin")
                except Refusal as exc:
                    checks.record("signed catalog", False, exc.message)
        if not light:
            body = json.dumps({"toolId": "qr-code", "format": "svg", "inputs": {"url": origin + "/?preview-smoke=1"}}).encode()
            export = S._get(checks, "qr export", origin + "/api/v1/render", method="POST", data=body,
                            headers={"Cookie": cookie, "Content-Type": "application/json", "Accept": "image/svg+xml"})
            if export is not None:
                kind = (export.header("Content-Type") or "").split(";")[0].strip()
                checks.record("qr export", export.status == 200 and kind == "image/svg+xml" and b"<svg" in export.body[:4096],
                              f"HTTP {export.status}; {kind or 'no content type'} through the render worker")
            www = S._get(checks, "www redirect", self.anchors["wwwOrigin"] + "/")
            if www is not None:
                checks.record("www redirect", www.status == 308 and www.header("Location") == origin + "/",
                              f"HTTP {www.status} to {www.header('Location')}")
            ok, detail = self.pod_check(image, memory=True)
            checks.record("pod", ok, detail)
        value, _ = self.deployment(full=False)
        try:
            found = self.boot_key(value)
            I.refuse_release_key(found, "Work's boot log")
            checks.record("signing key", found == self.thumbprint, f"boot log keyId {str(found)[:8]}...; the lolly.ing pin is "
                                                                    f"{self.thumbprint[:8]}...")
        except Refusal as exc:
            checks.record("signing key", False, exc.message)
            if exc.code == "RELEASE_KEY" and light:
                raise
        if generation is not None:
            try:
                check = self.check_db(image)
                checks.record("generation", check["publicationGeneration"] == generation,
                              f"the database serves generation {check['publicationGeneration']}; {generation} expected")
            except Refusal as exc:
                checks.record("generation", False, exc.message)
        for item in checks.items:
            self.log("live-smoke" if light else "smoke", **item)
        return checks, files

    def live_check(self, previous):
        """Before any change: the live build passes its own smoke, so its rollback is safe (review C-M4)."""
        checks, _ = self.run_smoke(previous["expect"], previous["image"], light=True)
        if not checks.ok and not self.request["clearHold"]:
            raise Refusal("LIVE_SMOKE_FAILED", "the live build does not pass its own smoke (" +
                          ", ".join(i["check"] for i in checks.failures()) + "); its rollback would not be safe. "
                          "Inspect it, or pass --clear-hold")

    def watch(self, index_sha, image):
        return S.watch(index_sha, self.anchors, lambda memory: self.pod_check(image, memory),
                       self.limits["watchMinutes"], self.limits["watchIntervalSeconds"], int(self.limits["watchFailures"]),
                       sleep=N.SLEEP, clock=N.CLOCK, log=self.log)

    # Records -------------------------------------------------------------
    def previous_record(self, value, index):
        live = self.image_of(value, index)
        phase = self.ann(value, "phase")
        record = {"source": self.ann(value, "source"), "image": live, "ciRun": self.ann(value, "ci-run"),
                  "formats": self.ann_json(value, "formats"), "expect": self.ann_json(value, "expect"),
                  "config": I.config_volume(value, index)[1]}
        require(record["source"] and SHA.fullmatch(record["source"]) is not None and isinstance(record["expect"], dict),
                "NO_PREVIOUS_RECORD", "the live release carries no preview records; run the cut-over plan first")
        I.validate_expect(record["expect"])
        require(self.ann(value, "image") == live and phase in A.SETTLED_PHASES and record["expect"]["source"] == record["source"],
                "RECORDS_STALE", f"the preview records do not describe the live image (phase {phase}); inspect with status")
        return record

    def records_for(self, release, config, generation, applied, maintenance, maintenance_applied=()):
        return {"source": release["source"], "image": release["image"], "ci-run": release["ciRun"], "tool": self.request["tool"],
                "formats": compact(release["formats"]), "expect": compact(I.expect_of(release)), "config": config,
                "generation": str(generation), "migrations": compact(sorted(applied)) if applied else None,
                "maintenance-migrations": compact(sorted(maintenance_applied)) if maintenance_applied else None,
                "maintenance": "true" if maintenance else None, "migration-set": I.migration_set(release["migrations"]),
                "updated": utc_stamp()}

    # Deploy ----------------------------------------------------------------
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
        require(I.is_converted(value, index), "NOT_CONVERTED", "lolly.ing still mounts the shell and pack claims; "
                "the one-time cut-over (plan) comes first")
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        previous = self.previous_record(value, index)
        require(previous["source"] == self.request.get("liveSource"), "STATE_CHANGED", "the live release changed since the command read it")
        self.live_check(previous)
        previous["prior"] = self.prior_record(value)
        live_config = previous["config"]
        configs = self.config_maps()
        require(live_config in configs, "CONFIG_UNREADABLE", "the live config ConfigMap is not readable")
        live_text = configs[live_config][1]
        self.window_check()
        self.keep_pinned(live_image)
        self.ensure_image(release)
        self.window_check()
        backup = self.take_backup()
        check = self.check_db(release["image"])
        plan = I.migration_plan(release["migrations"], check, self.applied_migrations(value))
        applied = set(self.applied_migrations(value))
        maintenance_applied = set(self.applied_migrations(value, "maintenance-migrations"))
        marked = set(self.applied_migrations(value, "maintenance-applied"))  # applied by an earlier run, never accepted
        maintenance, rehearsal = False, None
        if plan["pending"]:
            classes = self.classify(release["image"], plan["pending"])
            maintenance = any(classes[item["name"]]["class"] != "additive" for item in plan["pending"])
            if maintenance:
                require(self.request.get("maintenanceApproval") is not None, "MAINTENANCE_NOT_APPROVED",
                        "a pending migration is not on the allowlist; it needs Andy's approval in the private run "
                        f"({A.ING['maintenanceEnvironment']}). Nothing was applied")
                self.backup_fresh(backup, maintenance=True)
            rehearsal = self.rehearse(backup, release["image"], live_image, plan["pending"])
            self.window_check()
            if maintenance:
                # The rehearsal takes time: the backup must still be fresh at the moment the schema changes (PROPOSAL 4.3).
                self.backup_fresh(backup, maintenance=True)
                marked |= {item["name"] for item in plan["pending"]}
                # From here the old image may run on a non-additive schema. Record that on the Deployment (annotations
                # only, no rollout) before anything is applied, and keep it until a switch that includes these
                # migrations is accepted.
                self.annotate({"phase": "maintenance-applied-unswitched", "deploy-id": self.request["deployId"],
                               "maintenance-applied": compact(sorted(marked)),
                               "maintenance-applied-set": I.migration_set(release["migrations"]),
                               "reason": None, "updated": utc_stamp()}, expect_image=live_image)
                self.log("phase", phase="maintenance-applied-unswitched", migrations=sorted(marked))
            self.migrate(release["image"], plan["pending"])
            check = self.check_db(release["image"])
            require(not I.migration_plan(release["migrations"], check, applied)["pending"], "MIGRATE_INCOMPLETE",
                    "migrations are still pending after the migrate Job")
            if maintenance:
                maintenance_applied |= {item["name"] for item in plan["pending"]}
            else:
                applied |= {item["name"] for item in plan["pending"]}
        hold = maintenance or bool(marked)  # a marker from an earlier run also turns automatic rollback off
        generation = self.generation_for(live_text, check, release["seq"])
        config = self.new_config(generation, live_text, release["source"])
        self.window_check()
        self.backup_fresh(backup, maintenance)
        deploys = int(self.ann(value, "deploys") or "0")
        self.annotate({"phase": "switching", "deploy-id": self.request["deployId"], "previous": compact(previous),
                       "reason": None, "updated": utc_stamp()}, expect_image=live_image)
        self.log("phase", phase="switching", generation=generation)
        records = dict(self.records_for(release, config, generation, applied, maintenance, maintenance_applied),
                       phase="switched-unverified")
        try:
            self.switch(live_image, live_config, release["image"], config, records)
        except Refusal as exc:
            if exc.code == "SWITCH_NOT_APPLIED":
                self.annotate({"phase": "maintenance-applied-unswitched" if marked else "aborted",
                               "previous": compact(previous["prior"]) if previous["prior"] else None,
                               "reason": exc.message[:500], "updated": utc_stamp()}, expect_image=live_image)
                return self.finish("ABORTED", reason=exc.message, image=live_image)
            return self.after_failure(previous, "ROLLOUT_FAILED: " + str(exc)[:300], hold)
        except self.au.Refusal as exc:
            return self.after_failure(previous, "ROLLOUT_FAILED: " + str(exc)[:300], hold)
        self.log("phase", phase="switched-unverified")
        try:
            checks, files = self.run_smoke(I.expect_of(release), release["image"], generation)
            if self.request["drillFailSmoke"]:
                checks.record("drill", False, "forced failure (--drill-fail-smoke)")
            if not checks.ok:
                return self.after_failure(previous, "SMOKE_FAILED: " + ", ".join(i["check"] for i in checks.failures()),
                                          hold, checks.items)
            reason = self.watch(files["index.html"], release["image"])
            if reason:
                return self.after_failure(previous, "WATCH_FAILED: " + reason, hold, checks.items)
            accepted = {"phase": "accepted", "deploys": str(deploys + 1), "updated": utc_stamp()}
            if marked and marked <= {item["name"] for item in release["migrations"]}:
                accepted.update({"maintenance-applied": None, "maintenance-applied-set": None})  # this switch includes them
            self.annotate(accepted, expect_image=release["image"])
        except (Refusal, self.au.Refusal) as exc:
            return self.after_failure(previous, "UNVERIFIED: " + str(exc)[:300], hold)
        armed = os.path.exists(armed_path())
        retention = self.retain_images(execute=armed, budget=A.RETENTION_AFTER_DEPLOY_SECONDS)
        if armed:
            retention["configMaps"] = self.retain_configs(execute=True)
        return self.finish("LIVE", source=release["source"], image=release["image"], previous=previous["image"],
                           generation=generation, config=config, backup=backup, retention=retention, rehearsal=rehearsal,
                           migrations=[item["name"] for item in plan["pending"]], maintenance=maintenance, checks=checks.items)

    def after_failure(self, previous, reason, maintenance, checks=None):
        """Roll back by one forward publication, unless a maintenance migration ran (PROPOSAL 4.4, 4.6)."""
        if maintenance:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "maintenance-unverified", "reason": reason[:500], "updated": utc_stamp()})
            return self.finish("MAINTENANCE_UNVERIFIED", reason=reason, checks=checks,
                               note="automatic rollback is off after a maintenance migration; recovery would be a restore, "
                                    "which Andy decides")
        return self.restore(previous, reason, watch=False, checks=checks)

    def restore(self, previous, reason, watch, checks=None):
        """The previous image (still pinned) plus a NEW config at a higher generation; never rollout undo.
        The database stays (PROPOSAL 4.6)."""
        self.log("rollback", reason=reason)
        with contextlib.suppress(Refusal):
            self.annotate({"phase": "rolling-back", "reason": reason[:500], "updated": utc_stamp()})
        back, generation, config = None, None, None
        try:
            require(I.instance_image(previous.get("image")), "BAD_IMAGE", "the recorded previous image is not the instance image")
            I.validate_expect(previous.get("expect"))
            value, index = self.deployment()
            current_image, current_config = self.image_of(value, index), I.config_volume(value, index)[1]
            configs = self.config_maps()
            require(current_config in configs, "CONFIG_UNREADABLE", "the live config ConfigMap is not readable")
            check = self.check_db(previous["image"])
            generation = self.generation_for(configs[current_config][1], check, previous["expect"]["seq"])
            config = self.new_config(generation, configs[current_config][1], previous["source"])
            self.switch(current_image, current_config, previous["image"], config, {"config": config, "generation": str(generation)})
            back, files = self.run_smoke(previous["expect"], previous["image"], generation)
            problem = None if back.ok else "smoke of the previous build failed: " + ", ".join(i["check"] for i in back.failures())
            if problem is None and watch:
                problem = self.watch(files["index.html"], previous["image"])
        except (Refusal, self.au.Refusal) as exc:
            problem = str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500], "updated": utc_stamp()})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks,
                               rollbackChecks=back.items if back else None, generation=generation)
        values = {"phase": "rolled-back", "source": previous["source"], "image": previous["image"], "ci-run": previous.get("ciRun"),
                  "formats": compact(previous["formats"]) if previous.get("formats") else None,
                  "expect": compact(previous["expect"]), "config": config, "generation": str(generation), "previous": None,
                  "maintenance": None, "migration-set": None,  # the new build's set no longer describes the live image
                  "reason": reason[:500], "updated": utc_stamp()}
        try:
            self.annotate(values, expect_image=previous["image"])
        except Refusal as exc:
            return self.finish("ROLLED_BACK", reason=reason, source=previous["source"], image=previous["image"], generation=generation,
                               problem="phase annotation not written: " + exc.code, checks=checks, rollbackChecks=back.items)
        return self.finish("ROLLED_BACK", reason=reason, source=previous["source"], image=previous["image"], generation=generation,
                           config=config, checks=checks, rollbackChecks=back.items)

    # Manual rollback -------------------------------------------------------
    def run_rollback(self):
        value, index = self.deployment()
        self.hold_check(self.ann(value, "phase"))
        require(self.ann(value, "maintenance") != "true", "MAINTENANCE_NO_ROLLBACK",
                "the live build ran a maintenance migration; a rollback would need a restore, which Andy decides")
        require(not self.applied_migrations(value, "maintenance-applied"), "MAINTENANCE_NO_ROLLBACK",
                "a maintenance migration was applied and no accepted switch includes it yet; every earlier image is older "
                "than that schema, so a rollback would need a restore, which Andy decides")
        previous = self.ann_json(value, "previous")
        require(isinstance(previous, dict) and previous.get("image") and previous.get("expect"), "NO_PREVIOUS",
                "no recorded previous build; deploy a build instead")
        require(previous.get("source") == self.request.get("rollbackTo"), "STATE_CHANGED", "the recorded previous build changed")
        lowering = format_lowering(self.ann_json(value, "formats"), previous.get("formats"))
        require(not lowering, "FORMAT_LOWERING", "the rollback would lower stored formats (" + ", ".join(lowering) +
                "); roll forward instead")
        require(I.is_converted(value, index), "NOT_CONVERTED", "the Deployment is not on the instance-image layout")
        self.window_check()
        self.keep_pinned(previous["image"])
        previous = {name: item for name, item in previous.items() if name != "prior"}
        self.annotate({"deploy-id": self.request["deployId"], "updated": utc_stamp()})
        return self.restore(previous, "MANUAL", watch=True)

    # Cut-over (PROPOSAL 4.8) -------------------------------------------------
    def run_convert(self):
        plan, release = self.request["conversion"], self.request["release"]
        to_secret = I.signing_secret()  # review H3: the cut-over patch also switches the signing key reference
        value, index = self.deployment()
        if I.is_converted(value, index):
            return self.finish("ALREADY_CONVERTED", image=self.image_of(value, index))
        self.hold_check(self.ann(value, "phase"))
        require(self.ready(value), "NOT_READY", "the Deployment is not reconciled and Ready")
        require(I.comparable_cutover(I.cutover_plan(value, index, release["image"], plan["toConfig"], plan["annotations"], to_secret))
                == I.comparable_cutover(plan["cutover"]), "PLAN_MISMATCH",
                "the live Deployment no longer gives the reviewed plan; make and review a new plan")
        live_image, live_config = self.image_of(value, index), I.config_volume(value, index)[1]
        configs = self.config_maps()
        live_text = configs[live_config][1]
        self.window_check()
        self.keep_pinned(live_image)
        self.ensure_image(release)
        backup = self.take_backup()
        check = self.check_db(release["image"])
        migrations = I.migration_plan(release["migrations"], check, set())
        marked = set(self.applied_migrations(value, "maintenance-applied"))  # applied by an earlier attempt, never switched
        maintenance = False
        if migrations["pending"]:
            classes = self.classify(release["image"], migrations["pending"])
            maintenance = any(classes[item["name"]]["class"] != "additive" for item in migrations["pending"])
            if maintenance:
                # Review 2026-10-25 H2: the cut-over takes a maintenance migration under the same rules as a deploy
                # (PROPOSAL 4.4): Andy's approval in the run, a backup under 1 h at the moment the schema changes, the
                # rehearsal, the marker before the migrate Job, and no automatic revert afterwards.
                require(self.request.get("maintenanceApproval") is not None, "MAINTENANCE_NOT_APPROVED",
                        "a pending migration is not on the allowlist; the cut-over takes it only with Andy's approval in the "
                        f"private run ({A.ING['maintenanceEnvironment']}, dispatched with MAINTENANCE=true). Nothing was applied")
                self.backup_fresh(backup, maintenance=True)
        # PROPOSAL 4.8 step 1: the full restore rehearsal runs once even with nothing pending.
        rehearsal = self.rehearse(backup, release["image"], live_image, migrations["pending"])
        if migrations["pending"]:
            self.window_check()
            if maintenance:
                self.backup_fresh(backup, maintenance=True)  # the rehearsal took time; still fresh as the schema changes
                marked |= {item["name"] for item in migrations["pending"]}
                # From here the old image may run on a non-additive schema and a revert is no longer a safe state.
                # Record that on the Deployment (annotations only, no rollout) before anything is applied.
                self.annotate({"phase": "maintenance-applied-unswitched", "deploy-id": self.request["deployId"],
                               "maintenance-applied": compact(sorted(marked)),
                               "maintenance-applied-set": I.migration_set(release["migrations"]),
                               "reason": None, "updated": utc_stamp()}, expect_image=live_image)
                self.log("phase", phase="maintenance-applied-unswitched", migrations=sorted(marked))
            self.migrate(release["image"], migrations["pending"])
            check = self.check_db(release["image"])
            require(not I.migration_plan(release["migrations"], check, set())["pending"], "MIGRATE_INCOMPLETE",
                    "migrations are still pending after the migrate Job")
        hold = maintenance or bool(marked)  # a marker from an earlier attempt also turns the automatic revert off
        generation = self.generation_for(live_text, check, release["seq"])
        require(generation == plan["generation"], "PLAN_MISMATCH", f"the generation is now {generation}, the plan says "
                f"{plan['generation']}; make and review a new plan")
        config = self.new_config(generation, live_text, release["source"])
        require(config == plan["toConfig"], "PLAN_MISMATCH", "the config name differs from the plan")
        self.window_check()
        self.backup_fresh(backup, maintenance)
        self.log("phase", phase="converting", generation=generation, maintenance=hold)
        applied = False
        for _ in range(N.SWITCH_ATTEMPTS):
            value, index = self.deployment()
            if I.is_converted(value, index):
                applied = True
                break
            current = I.cutover_plan(value, index, release["image"], config, plan["annotations"], to_secret)
            try:
                dry = self.kube.patch(self.component, current["patch"], True)
                I.guard_cutover(value, dry, index, current)
                result = self.kube.patch(self.component, current["patch"], False)
                I.guard_cutover(value, result, index, current)
                applied = True
                break
            except (Refusal, self.au.Refusal) as exc:
                self.log("switch-retry", reason=str(exc)[:200])
                N.SLEEP(2)
        if not applied:
            return self.finish("ABORTED", reason="the cut-over patch was not applied",
                               note="a maintenance migration is applied and unswitched" if hold else None)
        try:
            self.wait_switch(release["image"], config)
            checks, files = self.run_smoke(I.expect_of(release), release["image"], generation)
            if self.request["drillFailSmoke"]:
                checks.record("drill", False, "forced failure (--drill-fail-smoke)")
            if not checks.ok:
                return self.after_convert_failure(plan, "SMOKE_FAILED: " + ", ".join(i["check"] for i in checks.failures()), hold,
                                                  checks.items)
            reason = self.watch(files["index.html"], release["image"])
            if reason:
                return self.after_convert_failure(plan, "WATCH_FAILED: " + reason, hold, checks.items)
            accepted = {"phase": "accepted", "updated": utc_stamp()}
            if maintenance:
                accepted.update({"maintenance": "true",
                                 "maintenance-migrations": compact(sorted(item["name"] for item in migrations["pending"]))})
            if marked and marked <= {item["name"] for item in release["migrations"]}:
                accepted.update({"maintenance-applied": None, "maintenance-applied-set": None})  # this switch includes them
            self.annotate(accepted, expect_image=release["image"])
        except (Refusal, self.au.Refusal) as exc:
            return self.after_convert_failure(plan, "UNVERIFIED: " + str(exc)[:300], hold)
        return self.finish("CONVERTED", source=release["source"], image=release["image"], generation=generation, config=config,
                           signingKeySecret=to_secret, backup=backup, rehearsal=rehearsal,
                           migrations=[item["name"] for item in migrations["pending"]], maintenance=maintenance, checks=checks.items)

    def after_convert_failure(self, plan, reason, maintenance, checks=None):
        """Revert the cut-over, unless a maintenance migration ran: the old image cannot run on that schema (review H2)."""
        if maintenance:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "maintenance-unverified", "reason": reason[:500], "updated": utc_stamp()})
            return self.finish("MAINTENANCE_UNVERIFIED", reason=reason, checks=checks,
                               note="the automatic revert is off after a maintenance migration; recovery would be a restore, "
                                    "which Andy decides")
        return self.revert_cutover(plan, reason, checks)

    def revert_cutover(self, plan, reason, checks=None):
        """Back to the claim layout and the old image, at a higher generation again (never the old one)."""
        self.log("rollback", reason=reason)
        cutover, problem, back, generation = plan["cutover"], None, None, None
        try:
            value, index = self.deployment()
            current_config = I.config_volume(value, index)[1]
            configs = self.config_maps()
            check = self.check_db(self.request["release"]["image"])  # a Job runs the instance image only
            generation = I.next_generation(configs[current_config][0], [g for g, _ in configs.values()],
                                           check["publicationGeneration"], 1)
            config = self.new_config(generation, configs[current_config][1], plan["liveSource"] or self.request["release"]["source"])
            reverted = False
            for _ in range(N.SWITCH_ATTEMPTS):
                value, index = self.deployment()
                if not I.is_converted(value, index):
                    reverted = True
                    break
                patch = I.revert_cutover_patch(value, index, cutover, config, {key("phase"): "rolling-back",
                                                                               key("reason"): reason[:500]})
                try:
                    self.kube.patch(self.component, patch, True)
                    self.kube.patch(self.component, patch, False)
                    reverted = True
                    break
                except (Refusal, self.au.Refusal):
                    N.SLEEP(2)
            require(reverted, "REVERT_NOT_APPLIED", "the claim layout could not be restored")
            self.wait_switch(cutover["image"], config)
            back = S.Checks()
            for name, path, want in (("healthz", "/healthz", 200), ("readyz", "/readyz", 200)):
                response = S._get(back, name, self.anchors["origin"] + path)
                if response is not None:
                    back.record(name, response.status == want, f"HTTP {response.status}")
            cookie = self.smoke_cookie()
            catalog = S._get(back, "signed catalog", self.anchors["origin"] + "/catalog/tools/index.json", headers={"Cookie": cookie})
            if catalog is not None:
                back.record("signed catalog", catalog.status == 200, f"HTTP {catalog.status} at generation {generation}")
            readback = self.check_db(self.request["release"]["image"])
            back.record("generation", readback["publicationGeneration"] == generation, f"database generation "
                        f"{readback['publicationGeneration']}; {generation} expected")
            problem = None if back.ok else "after the revert: " + ", ".join(i["check"] for i in back.failures())
        except (Refusal, self.au.Refusal, KeyError) as exc:
            problem = str(exc)[:300]
        if problem:
            with contextlib.suppress(Refusal):
                self.annotate({"phase": "rollback-unhealthy", "reason": (reason + " / " + problem)[:500]})
            return self.finish("ROLLBACK_UNHEALTHY", reason=reason, problem=problem, checks=checks, generation=generation)
        self.annotate({"phase": "rolled-back", "layout": "claims", "updated": utc_stamp()})
        return self.finish("CONVERSION_REVERTED", reason=reason, generation=generation, checks=checks,
                           rollbackChecks=back.items)

    # ExecStopPost --------------------------------------------------------
    def stop_post(self, environment):
        """As lolly.tools, except that a switch after a maintenance migration is held, never rolled back."""
        if self.request["kind"] == "convert":
            try:
                value, _ = self.deployment()
            except (Refusal, self.au.Refusal):
                return super().stop_post(environment)
            # Review H2: a cut-over that applied a maintenance migration is held, never reverted (the marker says so).
            if (self.ann(value, "deploy-id") == self.request["deployId"] and self.ann(value, "phase") == "converting"
                    and self.applied_migrations(value, "maintenance-applied")):
                self.annotate({"phase": "maintenance-unverified", "reason": "UNIT_STOPPED", "updated": utc_stamp()})
                return self.finish("MAINTENANCE_UNVERIFIED", reason="UNIT_STOPPED",
                                   note="the automatic revert is off after a maintenance migration")
        if self.request["kind"] == "deploy":
            try:
                value, _ = self.deployment()
            except (Refusal, self.au.Refusal):
                return super().stop_post(environment)
            phase = self.ann(value, "phase")
            if (self.ann(value, "deploy-id") == self.request["deployId"] and phase in ("switching", "switched-unverified")
                    and (self.ann(value, "maintenance") == "true" or self.applied_migrations(value, "maintenance-applied"))):
                previous = self.ann_json(value, "previous")
                if phase == "switching" and isinstance(previous, dict) and self.image_of(value, self.deployment()[1]) == previous.get("image"):
                    self.annotate({"phase": "maintenance-applied-unswitched", "reason": "UNIT_STOPPED", "updated": utc_stamp()})
                    return self.finish("ABORTED", reason="UNIT_STOPPED", note="a maintenance migration is applied and unswitched")
                self.annotate({"phase": "maintenance-unverified", "reason": "UNIT_STOPPED", "updated": utc_stamp()})
                return self.finish("MAINTENANCE_UNVERIFIED", reason="UNIT_STOPPED",
                                   note="automatic rollback is off after a maintenance migration")
        return super().stop_post(environment)

    def revert_conversion(self, plan, reason, checks=None):
        return self.revert_cutover(plan, reason, checks)

    # Retention (decision 12) ---------------------------------------------
    def config_plan(self):
        """Generation ConfigMaps this command made: keep the live one, the newest N and every one a retained
        ReplicaSet still names. Legacy ConfigMaps are listed for Andy and never removed by the command."""
        value, index = self.deployment(full=False)
        live = I.config_volume(value, index)[1]
        data = json.loads(self.kube.run(["get", "configmaps", "--namespace", self.namespace(), "-o", "json"]))
        sets = json.loads(self.kube.run(["get", "replicasets", "--namespace", self.namespace(), "-l", self.selector(value), "-o", "json"]))
        named = {live}
        for item in sets.get("items", []):
            for volume in (item.get("spec", {}).get("template", {}).get("spec", {}).get("volumes") or []):
                if (volume.get("configMap") or {}).get("name"):
                    named.add(volume["configMap"]["name"])
        ours, legacy = [], []
        for item in data.get("items", []):
            text = (item.get("data") or {}).get(A.ING["configKey"])
            if text is None:
                continue
            labels = item["metadata"].get("labels") or {}
            entry = {"name": item["metadata"]["name"], "uid": item["metadata"].get("uid"), "generation": I.config_generation(text)}
            mine = labels.get("lolly.tools/managed-by") == "preview-deploy" and labels.get("lolly.tools/preview-config") == "lolly.ing"
            (ours if mine else legacy).append(entry)
        ours.sort(key=lambda entry: entry["generation"], reverse=True)
        keep = {entry["name"] for entry in ours[:int(self.limits["retainConfigMaps"])]} | named
        return {"live": live, "keep": sorted(keep & {e["name"] for e in ours}),
                "remove": [entry for entry in ours if entry["name"] not in keep],
                "legacy": sorted(entry["name"] for entry in legacy if entry["name"] not in named)}

    def retain_configs(self, execute):
        plan = self.config_plan()
        removed = []
        if execute:
            for entry in plan["remove"]:
                body = self.write_object("delete-" + entry["name"], {"apiVersion": "v1", "kind": "DeleteOptions",
                                                                      "preconditions": {"uid": entry["uid"]}})
                path = f"/api/v1/namespaces/{self.namespace()}/configmaps/{entry['name']}"
                try:
                    self.kube.run(["delete", "--raw", path, "-f", body])
                    removed.append(entry["name"])
                except (Refusal, self.au.Refusal) as exc:
                    self.log("configmap-kept", name=entry["name"], reason=str(exc)[:200])
        return {"kept": plan["keep"], "removed": removed, "removable": [] if execute else [e["name"] for e in plan["remove"]],
                "legacy": plan["legacy"]}

    def run_gc(self):
        """Images this command imported and ConfigMaps it made, outside retention. Never a claim."""
        self.window_check()
        retention = self.retain_images(execute=True, budget=A.GC_REMOVE_BUDGET_SECONDS)
        if retention.get("skipped"):
            return self.finish("GC_INCOMPLETE", retention=retention)
        retention["configMaps"] = self.retain_configs(execute=True)
        retention["spool"] = clean_spool()
        with open(armed_path(), "w") as handle:  # later lolly.ing deploys may now apply retention themselves
            handle.write(utc_stamp() + "\n")
        return self.finish("GC_INCOMPLETE" if retention["notRemoved"] else "GC_DONE", retention=retention)


def armed_path():
    return N.PATHS["armed"] + "-lolly.ing"


def spool_files():
    """Archives a refused or interrupted run left in the root-only spool: name -> bytes."""
    directory = N.PATHS["spool"]
    if not os.path.isdir(directory):
        return {}
    found = {}
    for name in sorted(os.listdir(directory)):
        info = os.lstat(os.path.join(directory, name))
        if stat.S_ISREG(info.st_mode) and re.fullmatch(r"[0-9a-f]{64}\.(oci\.tar|partial)", name):
            found[name] = info.st_size
    return found


def clean_spool():
    """gc removes every spooled archive: no run is active, and a later deploy uploads again when it needs one."""
    removed = []
    for name in spool_files():
        with contextlib.suppress(OSError):
            os.unlink(os.path.join(N.PATHS["spool"], name))
            removed.append(name)
    return removed



# Read-only queries ------------------------------------------------------------------
def read(query, au):
    require(query.get("op") in ("status", "plan", "intake", "gc"), "BAD_REQUEST", "unknown query")
    probe = dict(query["request"], kind="read")
    runner = IngRunner(probe, au)
    value, index = runner.deployment()
    annotations = {name[len(A.ANNOTATION_PREFIX):]: text for name, text in (value["metadata"].get("annotations") or {}).items()
                   if name.startswith(A.ANNOTATION_PREFIX)}
    if query["op"] == "status":
        pods = []
        for pod in runner.pods(value):
            statuses = pod.get("status", {}).get("containerStatuses", [])
            pods.append({"name": pod["metadata"]["name"], "phase": pod.get("status", {}).get("phase"),
                         "restarts": sum(s.get("restartCount", 0) for s in statuses),
                         "ready": all(s.get("ready") for s in statuses) and bool(statuses)})
        unit = subprocess.run([N.PATHS["systemctl"], "show", "-p", "ActiveState", "--value", A.NODE_UNIT],
                              capture_output=True, timeout=20, check=False).stdout.decode().strip()
        cookie = "present"
        try:
            runner.smoke_cookie()
        except Refusal as exc:
            cookie = exc.message
        return {"deployment": {"uid": value["metadata"]["uid"], "image": runner.image_of(value, index), "ready": runner.ready(value),
                               "config": I.config_volume(value, index)[1], "converted": I.is_converted(value, index),
                               "revision": (value["metadata"].get("annotations") or {}).get("deployment.kubernetes.io/revision")},
                "preview": annotations, "pods": pods, "unit": unit, "smokeSession": cookie}
    if query["op"] == "intake":
        release = query["release"]
        I.validate_release(release)
        total, available = N.filesystem_bytes(N.PATHS["imagefs"])
        spool = os.path.join(N.PATHS["spool"], release["archive"]["sha256"] + ".oci.tar")
        return {"imagePresent": runner.image_present(release), "spoolPresent": os.path.isfile(spool),
                "aboveReserve": available - (total // 4 + 512 * N.MIB)}
    if query["op"] == "gc":
        plan = runner.image_plan()
        return {"images": {"keep": plan["keep"], "remove": [item["ref"] for item in plan["remove"]],
                           "removeBytes": sum(item["size"] for item in plan["remove"]), "untouched": plan["untouched"],
                           "unusedForeign": plan["unusedForeign"]},
                "configMaps": runner.config_plan(), "claims": N.gc_claims(runner, value, query.get("legacyClaims") or []),
                "deploysSinceConversion": int(runner.ann(value, "deploys") or "0"), "retentionArmed": os.path.exists(armed_path()),
                "spool": spool_files()}
    configs = runner.config_maps()
    return {"deployment": value, "configs": {name: generation for name, (generation, _) in configs.items()},
            "liveConfig": I.config_volume(value, index)[1], "converted": I.is_converted(value, index)}
