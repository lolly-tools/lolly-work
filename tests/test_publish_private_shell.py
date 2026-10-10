#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic transport adversarial checks; no cluster or production writes."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).parents[1] / "scripts/publish-private-shell.py"
spec = importlib.util.spec_from_file_location("shell_publish", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
fixture_spec = importlib.util.spec_from_file_location("shell_plan_fixture", Path(__file__).with_name("test_plan_private_shell.py"))
planner_fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(planner_fixture)


def patched(value, patch):
    result = copy.deepcopy(value)
    for operation in patch:
        keys = [k.replace("~1", "/").replace("~0", "~") for k in operation["path"].split("/")[1:]]
        parent = result
        for key in keys[:-1]:
            parent = parent[int(key)] if isinstance(parent, list) else parent[key]
        key = int(keys[-1]) if isinstance(parent, list) else keys[-1]
        if operation["op"] == "test":
            if parent[key] != operation["value"]:
                raise m.Refusal("Synthetic atomic test refused")
        elif operation["op"] == "replace":
            parent[key] = copy.deepcopy(operation["value"])
        else:
            raise m.Refusal("Unexpected operation")
    return result


class FakeKube:
    def __init__(self, fixture):
        self.f = fixture
        self.patches = []
        self.admission_change = None
        self.response_change = None
        self.lost_response = False
        self.calls = []

    def get(self, kind, name, namespace=None):
        self.calls.append(("get", kind, name, namespace))
        f = self.f
        if kind == "namespace":
            uid = "cluster-uid" if name == "kube-system" else "namespace-uid"
            return {"metadata": {"name": name, "uid": uid}}
        if kind == "node":
            return {"metadata": {"uid": "node-uid"}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        if kind == "deployment":
            return copy.deepcopy(next(d for d in f.deployments.values() if d["metadata"]["name"] == name))
        if kind == "replicaset":
            return copy.deepcopy(f.rs)
        return copy.deepcopy(next(r for r in f.resources if r["kind"] == kind and r["metadata"]["name"] == name))

    def run(self, args, timeout=60):
        self.calls.append(("run", args))
        f = self.f
        if args[0] == "exec":
            return json.dumps(f.content)
        kind = args[1]
        if kind == "persistentvolumeclaims":
            items = [r for r in f.resources if r["kind"] == "PersistentVolumeClaim"]
        elif kind == "persistentvolumes":
            items = [r for r in f.resources if r["kind"] == "PersistentVolume"]
        elif kind == "pods":
            items = f.pods
        elif kind == "networkpolicies":
            items = f.policies
        else:
            raise AssertionError("Unexpected read")
        item_kind = {"persistentvolumeclaims": "PersistentVolumeClaim", "persistentvolumes": "PersistentVolume", "pods": "Pod", "networkpolicies": "NetworkPolicy"}[kind]
        return json.dumps({"apiVersion": "networking.k8s.io/v1" if kind == "networkpolicies" else "v1", "kind": item_kind + "List", "metadata": {"resourceVersion": "123"}, "items": items})

    def patch(self, component, operations, dry_run):
        self.calls.append(("patch", dry_run))
        self.patches.append((copy.deepcopy(operations), dry_run))
        f = self.f
        updated = patched(f.deployments["work"], operations)
        if self.admission_change:
            self.admission_change(updated)
        if not dry_run:
            updated["metadata"]["resourceVersion"] = "101"
            updated["metadata"]["generation"] = 2
            updated["status"]["observedGeneration"] = 2
            f.deployments["work"] = copy.deepcopy(updated)
            f.publish_owner()
            if self.lost_response:
                raise m.Refusal("Response lost after synthetic commit")
            if self.response_change:
                self.response_change(updated)
        return updated

    def rollout(self, component, timeout):
        self.calls.append(("rollout", timeout))


class Phases(unittest.TestCase):
    """Phase tests intentionally use synthetic reviewed inputs, not real receipts."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="private-shell-publish-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.base.chmod(0o700)
        self.image = "registry.example/work@sha256:" + "a" * 64
        self.sources = {"lolly": "1" * 40, "engine": "2" * 40, "work": "3" * 40, "brand": "4" * 40}
        self.before = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": self.meta("editor", "deployment-uid"),
          "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app": "editor"}},
          "template": {"metadata": {"labels": {"app": "editor"}, "annotations": {"lolly.tools/engine-source": self.sources["engine"],
            "lolly.tools/shell-source": "0" * 40, "lolly.tools/shell-release": "release-" + "0" * 16}},
            "spec": {"automountServiceAccountToken": False, "containers": [{"name": "server", "image": self.image,
              "securityContext": {"runAsUser": 1000}, "volumeMounts": [{"name": "shell", "mountPath": "/ui", "readOnly": True},
                {"name": "pack", "mountPath": "/content", "readOnly": True}, {"name": "pin", "mountPath": "/pin.json", "subPath": "pin.json", "readOnly": True}]}],
              "volumes": [{"name": "shell", "persistentVolumeClaim": {"claimName": "old-shell"}},
                {"name": "pack", "persistentVolumeClaim": {"claimName": "old-pack"}}, {"name": "pin", "configMap": {"name": "accepted-pin"}}]}}},
          "status": {"readyReplicas": 1, "observedGeneration": 1}}
        self.desired = copy.deepcopy(self.before["spec"])
        self.desired["template"]["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"] = "new-shell"
        self.desired["template"]["metadata"]["annotations"].update({"lolly.tools/shell-source": self.sources["lolly"], "lolly.tools/shell-release": "release-" + "1" * 16})
        changes = [{"path": "/spec/template/spec/volumes/0/persistentVolumeClaim/claimName", "expectedValue": "new-shell", "restoreValue": "old-shell"},
          {"path": "/spec/template/metadata/annotations/lolly.tools~1shell-source", "expectedValue": self.sources["lolly"], "restoreValue": "0" * 40},
          {"path": "/spec/template/metadata/annotations/lolly.tools~1shell-release", "expectedValue": "release-" + "1" * 16, "restoreValue": "release-" + "0" * 16}]
        operations = [{"op": "test", "path": "/metadata/uid", "value": "deployment-uid"}, {"op": "test", "path": "/metadata/resourceVersion", "value": "99"},
                      {"op": "test", "path": "/spec", "value": self.before["spec"]}]
        for change in changes:
            operations += [{"op": "test", "path": change["path"], "value": change["restoreValue"]}, {"op": "replace", "path": change["path"], "value": change["expectedValue"]}]
        self.resources = []
        for name in ("old-shell", "old-pack", "new-shell"):
            self.resources += [{"kind": "PersistentVolumeClaim", "metadata": self.meta(name, name + "-uid"),
                "spec": {"volumeName": "pv-" + name, "accessModes": ["ReadWriteOnce"]}},
                {"kind": "PersistentVolume", "metadata": self.meta("pv-" + name, "pv-" + name + "-uid", namespace=None),
                 "spec": {"claimRef": {"namespace": "team", "name": name, "uid": name + "-uid"}}}]
        self.resources.append({"kind": "ConfigMap", "metadata": self.meta("accepted-pin", "pin-uid"), "immutable": True, "data": {"pin.json": "unchanged"}})
        self.plan = {"version": 1, "status": "PLANNED_FROM_CAPTURES_NOT_DRY_RUN_NOT_APPLIED", "sources": self.sources, "image": self.image,
          "namespace": "team", "namespaceUID": "namespace-uid", "deployment": "editor", "deploymentUID": "deployment-uid", "resourceVersion": "99",
          "beforeSpecSha256": m.digest(self.before["spec"]), "desiredSpecSha256": m.digest(self.desired), "desiredSpec": self.desired,
          "guardedPatch": operations, "selection": {"container": "server", "shellVolume": "shell", "packVolume": "pack", "pinVolume": "pin", "shellClaim": "new-shell"},
          "resourceGuards": [m.resource_guard(r) for r in self.resources], "rollbackIntent": {"fields": changes}, "allUnselectedSpecFieldsPreserved": True}
        self.rs = {"metadata": self.meta("old-rs", "old-rs-uid"), "spec": {"replicas": 1},
            "kind": "ReplicaSet"}
        self.rs["metadata"]["ownerReferences"] = [self.owner("Deployment", "editor", "deployment-uid")]
        self.old_owner = {"metadata": self.meta("old-owner", "old-owner-uid"), "kind": "Pod",
          "spec": {**copy.deepcopy(self.before["spec"]["template"]["spec"]), "nodeName": "fixture-node"}, "status": {"phase": "Running"}}
        self.old_owner["metadata"]["ownerReferences"] = [self.owner("ReplicaSet", "old-rs", "old-rs-uid")]
        self.old_owner["metadata"]["annotations"] = self.before["spec"]["template"]["metadata"]["annotations"]
        self.pods = [copy.deepcopy(self.old_owner)]; self.policies = []
        public = copy.deepcopy(self.before)
        public["metadata"].update(name="public", uid="public-uid")
        self.deployments = {"work": copy.deepcopy(self.before), "public-web": public}
        self.static_bytes = {"index.html": b"i", "catalog/tools/index.json": b"{}", "catalog/tools/index.sig.json": b'{"synthetic":"signature"}'}
        shell_files = sorted([{"path": p, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for p, data in self.static_bytes.items()], key=lambda f: f["path"])
        self.public_pin = {"kty": "EC", "crv": "P-256", "x": "x" * 43, "y": "y" * 43}
        self.catalog = {"indexSha256": hashlib.sha256(self.static_bytes["catalog/tools/index.json"]).hexdigest(), "envelopeSha256": hashlib.sha256(self.static_bytes["catalog/tools/index.sig.json"]).hexdigest(), "keyId": "synthetic-public-key", "signedFiles": 1}
        self.content = {"version": 1, "shell": {"version": 1, "files": shell_files, "totalBytes": sum(len(v) for v in self.static_bytes.values())},
                        "pack": {"version": 1, "files": [{"path": "tool.json", "size": 1, "sha256": "6" * 64}], "totalBytes": 1}, "pinSha256": "7" * 64}
        self.content["catalog"] = {**self.catalog, "publicPinSha256": m.digest(self.public_pin), "signatureVerified": True}
        self.kube = FakeKube(self)
        self.preflight_success = True; self.mount_success = True; self.commands = []; self.probes = []
        p = m.Publication.__new__(m.Publication)
        self.publication = p
        p.path = self.base / "input.json"; p.base = self.base; p.out = self.base
        p.input_ref = {"path": str(p.path), "sha256": "8" * 64}; p.operator_checksum = "9" * 64
        p.refs = {"plan": {"path": "plan", "sha256": "a" * 64}, "enginePin": {"path": "pin", "sha256": "7" * 64}}
        p.plan = self.plan; p.before = self.before; p.kube = self.kube
        p.baseline = {"version": 1, "deployments": copy.deepcopy(self.deployments), "owner": copy.deepcopy(self.old_owner), "replicaSet": copy.deepcopy(self.rs)}
        p.target = {"clusterUID": "cluster-uid", "node": {"name": "fixture-node", "uid": "node-uid"}, "components": {}}
        for role, d in self.deployments.items():
            p.target["components"][role] = {"namespace": "team", "namespaceUID": "namespace-uid", "deployment": d["metadata"]["name"], "deploymentUID": d["metadata"]["uid"],
                                            "container": "server", "healthURLs": ["https://example.test/" + role]}
        p.component = p.target["components"]["work"]
        p.stage = {"pod": {"metadata": {"name": "retired-stage", "uid": "stage-uid"}}, "retirement": {"policyName": "retired-policy", "policyUID": "policy-uid"}, "catalog": self.catalog, "shell": {"releaseId": "release-" + "1" * 16}, "rawPack": {"claim": "temporary-pack"}}
        p.writer = {"metadata": {"name": "retired-writer", "uid": "writer-uid"}}
        p.engine_pin = {"engine": {"version": "1.248.0"}, "core": {"version": "1.1.0"}}
        p.mounts = {"shellPath": "/ui", "packPath": "/content", "pinPath": "/pin.json"}; p.shell = self.content["shell"]; p.pack = self.content["pack"]
        p.public_pin = self.public_pin
        p.resolver_ref = {"path": "synthetic-resolver", "sha256": "b" * 64}
        p.previous_ref = {"path": "synthetic-previous", "sha256": "c" * 64}
        p.refs.update(shellManifest={"path": "synthetic-shell", "sha256": "d" * 64}, packManifest={"path": "synthetic-pack", "sha256": "e" * 64})
        p.static_fetcher = lambda url, maximum: self.static_bytes[urlsplit(url).path.lstrip("/")]
        p.source_check = lambda: None
        dummy = self.base / "guard.py"; dummy.write_text("# synthetic source fixture\n"); dummy.chmod(0o600)
        source = {"path": str(dummy), "sha256": hashlib.sha256(dummy.read_bytes()).hexdigest()}
        p.x = {key: {"argv": ["/usr/bin/python3", str(dummy), key], "source": source} for key in ("preflight", "retiredMountProbe")}
        p.command_runner = self.command; p.health = lambda url: self.probes.append(url)

    @staticmethod
    def meta(name, uid, namespace="team"):
        value = {"name": name, "uid": uid, "resourceVersion": "99", "generation": 1}
        if namespace is not None:
            value["namespace"] = namespace
        return value

    @staticmethod
    def owner(kind, name, uid):
        return {"kind": kind, "name": name, "uid": uid, "controller": True}

    def command(self, argv, **kwargs):
        self.commands.append(argv[-1])
        if argv[-1] == "preflight":
            return SimpleNamespace(returncode=0 if self.preflight_success else 1, stdout="synthetic preflight", stderr="")
        return SimpleNamespace(returncode=0, stdout=json.dumps({"version": 1, "stagePodUID": "stage-uid", "writerPodUID": "writer-uid", "nodeUID": "node-uid", "mountsReleased": self.mount_success}), stderr="")

    def publish_owner(self):
        self.rs = copy.deepcopy(self.rs)
        self.rs["metadata"].update(name="new-rs", uid="new-rs-uid")
        pod = copy.deepcopy(self.old_owner)
        pod["metadata"].update(name="new-owner", uid="new-owner-uid", ownerReferences=[self.owner("ReplicaSet", "new-rs", "new-rs-uid")])
        pod["metadata"]["annotations"] = self.desired["template"]["metadata"]["annotations"]
        pod["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"] = "new-shell"
        pod["status"]["containerStatuses"] = [{"name": "server", "ready": True, "restartCount": 0, "imageID": self.image}]
        self.pods = [pod]

    def test_review_accepts_only_claim_and_shell_provenance(self):
        self.assertEqual(m.review(self.plan, self.before), 0)
        for change in (lambda p: p["desiredSpec"]["template"]["spec"]["containers"][0].update(image="changed"),
                       lambda p: p["desiredSpec"]["template"]["metadata"]["annotations"].update({"lolly.tools/engine-source": "f" * 40}),
                       lambda p: p["desiredSpec"]["template"]["spec"]["volumes"][1]["persistentVolumeClaim"].update(claimName="new-pack")):
            with self.subTest(change=change):
                plan = copy.deepcopy(self.plan); change(plan); plan["desiredSpecSha256"] = m.digest(plan["desiredSpec"])
                with self.assertRaises(m.Refusal): m.review(plan, self.before)

    def test_fresh_atomic_full_spec_patch_refreshes_rv(self):
        current = copy.deepcopy(self.before); current["metadata"]["resourceVersion"] = "100"
        operations = m.fresh_patch(self.plan, current)
        self.assertEqual(patched(current, operations)["spec"], self.desired)
        for change in (lambda d: d["metadata"].update(uid="replacement"), lambda d: d["spec"].update(replicas=2)):
            current = copy.deepcopy(self.before); change(current)
            with self.assertRaises(m.Refusal): m.fresh_patch(self.plan, current)

    def test_dryrun_apply_observe_are_separate_and_reuse_exact_runtime(self):
        self.publication.dryrun(); self.publication.apply(); self.publication.observe()
        self.assertEqual([dry for _, dry in self.kube.patches], [True, False])
        self.assertEqual(self.deployments["work"]["spec"], self.desired)
        self.assertEqual(self.commands, ["retiredMountProbe", "preflight", "retiredMountProbe", "preflight", "retiredMountProbe"])
        self.assertEqual(len(self.probes), 2)
        actual = json.loads((self.base / "observe.actual.json").read_bytes())
        self.assertFalse(actual["runtimeAcceptanceComplete"])
        self.assertEqual(actual["imageID"], self.image)
        self.assertEqual(actual["status"], "ACTUAL_PRIVATE_SHELL_OWNER_CONTENT_AND_TLS_VERIFIED_ACCEPTANCE_PENDING")

    def test_failed_preflight_prevents_even_admission_request(self):
        self.preflight_success = False
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])
        self.assertTrue((self.base / "dryrun.started.json").exists())
        with self.assertRaises(FileExistsError): self.publication.dryrun()

    def test_admission_changes_preserve_original_response_and_block_apply(self):
        self.kube.admission_change = lambda d: d["spec"].update(replicas=2)
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(json.loads((self.base / "dryrun.response.original.json").read_bytes())["spec"]["replicas"], 2)
        with self.assertRaises(m.Refusal): self.publication.apply()
        self.assertEqual(len(self.kube.patches), 1)

    def test_missing_dryrun_blocks_apply_without_write(self):
        with self.assertRaises(m.Refusal): self.publication.apply()
        self.assertEqual(self.kube.patches, [])

    def test_committed_response_mismatch_never_replays_mutation(self):
        self.publication.dryrun()
        self.kube.response_change = lambda d: d["metadata"].update(uid="response-mismatch")
        with self.assertRaises(m.Refusal): self.publication.apply()
        self.assertTrue((self.base / "apply.response.original.json").exists())
        self.assertEqual(self.deployments["work"]["spec"], self.desired)
        with self.assertRaises(FileExistsError): self.publication.apply()
        self.assertEqual(len(self.kube.patches), 2)

    def test_lost_committed_response_retains_intent_and_blocks_replay(self):
        self.publication.dryrun(); self.kube.lost_response = True
        with self.assertRaises(m.Refusal): self.publication.apply()
        self.assertTrue((self.base / "apply.started.json").exists())
        self.assertFalse((self.base / "apply.actual.json").exists())
        with self.assertRaises(FileExistsError): self.publication.apply()
        self.assertEqual(len(self.kube.patches), 2)

    def test_new_claim_inventory_or_changed_pin_blocks_patch(self):
        self.resources.append({"kind": "PersistentVolumeClaim", "metadata": self.meta("unexpected", "unexpected-uid"), "spec": {"volumeName": "pv-elsewhere"}})
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_changed_immutable_pin_or_pv_uid_blocks_patch(self):
        for index, change in ((-1, lambda r: r["data"].update({"pin.json": "changed"})),
                              (1, lambda r: r["metadata"].update(uid="replacement"))):
            with self.subTest(index=index):
                saved = copy.deepcopy(self.resources); change(self.resources[index])
                with self.assertRaises(m.Refusal): self.publication.fresh("guard-" + str(index))
                self.resources = saved
        self.assertEqual(self.kube.patches, [])

    def test_reappeared_stage_or_unreleased_mount_refuses(self):
        self.mount_success = False
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_reappeared_retired_policy_blocks_patch(self):
        self.policies = [{"kind": "NetworkPolicy", "metadata": self.meta("retired-policy", "policy-uid")}]
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_temporary_pack_reappeared_writer_or_other_owner_blocks_patch(self):
        rogue = copy.deepcopy(self.old_owner)
        rogue["metadata"].update(name="unrelated-writer", uid="unrelated-writer-uid")
        rogue["spec"]["volumes"] = [{"name": "temporary", "persistentVolumeClaim": {"claimName": "temporary-pack"}}]
        self.pods.append(rogue)
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_paginated_or_duplicate_resource_list_refuses(self):
        run = self.kube.run
        def truncated(args, timeout=60):
            value = json.loads(run(args, timeout))
            value["metadata"]["continue"] = "unread-next-page"
            return json.dumps(value)
        self.kube.run = truncated
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_new_second_pack_owner_or_direct_hostpath_blocks_patch(self):
        rogue = copy.deepcopy(self.old_owner); rogue["metadata"].update(name="rogue", uid="rogue-uid")
        self.pods.append(rogue)
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_bare_inverse_patch_and_no_change_release_are_refused(self):
        plan = copy.deepcopy(self.plan)
        plan["guardedPatch"] = [operation for operation in plan["guardedPatch"] if operation.get("path") != "/spec"]
        with self.assertRaises(m.Refusal): m.fresh_patch(plan, self.before)
        plan = copy.deepcopy(self.plan)
        plan["desiredSpec"]["template"]["metadata"]["annotations"] = copy.deepcopy(self.before["spec"]["template"]["metadata"]["annotations"])
        plan["desiredSpecSha256"] = m.digest(plan["desiredSpec"])
        with self.assertRaises(m.Refusal): m.review(plan, self.before)

    def test_candidate_claim_second_pod_owner_blocks_patch(self):
        rogue = copy.deepcopy(self.old_owner); rogue["metadata"].update(name="rogue", uid="rogue-uid")
        rogue["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"] = "new-shell"
        self.pods.append(rogue)
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_protected_component_spec_or_readiness_refuses(self):
        self.deployments["public-web"]["spec"]["template"]["spec"]["containers"][0]["image"] = "other"
        with self.assertRaises(m.Refusal): self.publication.dryrun()
        self.assertEqual(self.kube.patches, [])

    def test_wrong_new_owner_chain_or_content_keeps_original_acceptance_pending(self):
        self.publication.dryrun(); self.publication.apply()
        self.content["shell"]["files"][0]["sha256"] = "f" * 64
        # The expected local manifest must remain independent of transport data.
        self.publication.shell = {"version": 1, "files": sorted([{"path": p, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for p, data in self.static_bytes.items()], key=lambda f: f["path"]), "totalBytes": sum(len(v) for v in self.static_bytes.values())}
        with self.assertRaises(m.Refusal): self.publication.observe()
        self.assertTrue((self.base / "observe.content.original.json").exists())
        self.assertFalse((self.base / "observe.actual.json").exists())

    def test_rollback_is_fresh_nonexecuting_intent(self):
        self.publication.dryrun(); self.publication.apply(); self.publication.rollback_intent()
        result = json.loads((self.base / "rollback-intent.actual.json").read_bytes())
        self.assertEqual(result["status"], "FRESH_ROLLBACK_REVIEW_INTENT_NOT_EXECUTABLE")
        self.assertEqual(result["resourceVersion"], "101")
        self.assertNotIn("patch", result)
        self.assertEqual(len(self.kube.patches), 2)

    def test_held_custody_rejects_symlink_changed_bytes_and_duplicate_keys(self):
        path = self.base / "custody.json"; path.write_text('{"a":1}'); path.chmod(0o600)
        ref = {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        self.assertEqual(m.read(ref, self.base), {"a": 1})
        path.write_text('{"a":2}')
        with self.assertRaises(m.Refusal): m.held(ref, self.base)
        path.write_text('{"a":1,"a":2}')
        ref["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaises(m.Refusal): m.read(ref, self.base)
        link = self.base / "link.json"; link.symlink_to(path)
        with self.assertRaises(m.Refusal): m.held({**ref, "path": link.name}, self.base)

    def test_owner_readback_uses_real_full_tree_hashes_and_refuses_symlinks(self):
        node = os.environ.get("LOLLY_TEST_NODE", "node")
        shell, pack = self.base / "shell", self.base / "pack"
        shell.mkdir(); pack.mkdir(); (shell / "index.html").write_bytes(b"hello")
        (pack / "tool.json").write_bytes(b"tool"); pin = self.base / "pin.json"; pin.write_bytes(b"pin")
        result = subprocess.run([node, "-e", m.OWNER_READBACK, str(shell), str(pack), str(pin)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(actual["shell"]["files"], [{"path": "index.html", "size": 5, "sha256": hashlib.sha256(b"hello").hexdigest()}])
        self.assertEqual(actual["pinSha256"], hashlib.sha256(b"pin").hexdigest())
        (shell / "escape").symlink_to(pin)
        result = subprocess.run([node, "-e", m.OWNER_READBACK, str(shell), str(pack), str(pin)], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)


class Handoff(planner_fixture.Plan):
    """Real CLI custody handoff on a synthetic accepted-runtime fixture."""
    def publication_input(self):
        # Run both maintained offline commands, rather than hand-authoring their
        # output shape. Their fixtures contain ephemeral test signatures only.
        self.test_real_preparer_cli_to_planner_cli_positive_handoff()
        planned = self.base / "real-planned/private-shell.plan.json"
        plan = json.loads(planned.read_bytes())
        evidence_ref = next(ref for ref in plan["evidence"] if Path(ref["path"]).name.endswith(".json")
                            if Path(ref["path"]).read_bytes().startswith(b"{")
                            if json.loads(Path(ref["path"]).read_bytes()) == self.evidence)
        owner = copy.deepcopy(self.facts["pods"]["items"][0])
        owner["metadata"]["ownerReferences"] = [{"kind": "ReplicaSet", "name": "current-rs", "uid": "accepted-rs-uid", "controller": True}]
        owner["metadata"]["annotations"] = copy.deepcopy(self.before["spec"]["template"]["metadata"]["annotations"])
        owner["status"] = {"phase": "Running"}
        rs = {"apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": {**self.meta("current-rs", "accepted-rs-uid", "private"),
              "ownerReferences": [{"kind": "Deployment", "name": "work", "uid": "deployment-uid", "controller": True}]}, "spec": {"replicas": 1}}
        before = copy.deepcopy(self.before)
        before["status"] = {"readyReplicas": 1, "observedGeneration": 1}
        baseline = {"version": 1, "deployments": {"work": before}, "owner": owner, "replicaSet": rs}
        target = {"version": 1, "transport": {"type": "local", "kubectl": ["/never-call-synthetic-kubectl"], "kubeconfig": "/synthetic-only", "context": "synthetic"},
                  "clusterUID": "cluster-uid", "node": {"name": "fixture-node", "uid": "node-uid"},
                  "components": {"work": {"namespace": "private", "namespaceUID": "namespace-uid", "deployment": "work", "deploymentUID": "deployment-uid", "container": "server", "healthURLs": ["https://example.test/health"]}}}
        source = self.binary("read-only-fixture-guard.py", b"# synthetic fixture: check never executes this\n")
        source["path"] = str(self.base / source["path"])
        command = {"argv": ["/usr/bin/python3", source["path"]], "source": source}
        refs = {"plan": {"path": str(planned), "sha256": hashlib.sha256(planned.read_bytes()).hexdigest()}, "planningEvidence": evidence_ref,
                "target": self.file("target", target), "baseline": self.file("baseline", baseline),
                "shellManifest": self.prepare_evidence["shell"]["manifest"], "packManifest": self.prepare_evidence["rawPack"]["manifest"], "enginePin": self.evidence["enginePin"]}
        sources = [SCRIPT, SCRIPT.parent / "app-update.py", SCRIPT.parent / "plan-private-shell.py", SCRIPT.parent / "prepare-private-shell.py",
                   SCRIPT.parent / "prepare-private-cohort.py", SCRIPT.parent / "prepare-paired-release.py", SCRIPT.parent / "plan-private-cohort.py"]
        value = {"version": 1, "status": "REVIEWED_PRIVATE_SHELL_PUBLICATION_INPUT", "refs": refs,
                 "sourceFiles": [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in sources],
                 "preflight": {**command, "argv": [*command["argv"], "preflight"]},
                 "retiredMountProbe": {**command, "argv": [*command["argv"], "retiredMountProbe"]}}
        ref = self.file("publication-input", value)
        out = self.base / "publication-output"; out.mkdir(mode=0o700)
        return ref, out

    def test_real_preparer_to_planner_to_publisher_cli_read_only_handoff(self):
        ref, out = self.publication_input()
        result = subprocess.run(["python3", "-B", str(SCRIPT), "check", "--input", str(self.base / ref["path"]),
                   "--reviewed-input-sha256", ref["sha256"], "--reviewed-operator-sha256", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), "--out-dir", str(out)],
                   capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"no target calls", result.stdout)
        self.assertEqual(list(out.iterdir()), [])

    def test_published_plan_edited_desired_spec_refuses_before_any_target_call(self):
        ref, out = self.publication_input()
        value = json.loads((self.base / ref["path"]).read_bytes())
        original = json.loads(Path(value["refs"]["plan"]["path"]).read_bytes())
        original["desiredSpec"]["replicas"] = 2
        original["desiredSpecSha256"] = m.digest(original["desiredSpec"])
        value["refs"]["plan"] = self.file("edited-plan", original)
        edited = self.file("edited-input", value)
        with self.assertRaises(m.Refusal):
            m.Publication(self.base / edited["path"], edited["sha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), out)
        self.assertEqual(list(out.iterdir()), [])

    def test_real_cli_custody_to_synthetic_transport_complete_publication(self):
        ref, out = self.publication_input()
        value = json.loads((self.base / ref["path"]).read_bytes())
        baseline = m.read(value["refs"]["baseline"], self.base)
        self.plan = m.read(value["refs"]["plan"], self.base)
        self.desired = self.plan["desiredSpec"]
        self.deployments = copy.deepcopy(baseline["deployments"])
        self.resources = copy.deepcopy(self.facts["resources"])
        self.rs = copy.deepcopy(baseline["replicaSet"])
        self.old_owner = copy.deepcopy(baseline["owner"])
        self.pods = [self.old_owner, copy.deepcopy(self.facts["pods"]["items"][1])]
        self.policies = []
        self.image = self.plan["image"]
        self.content = {"version": 1, "shell": m.read(value["refs"]["shellManifest"], self.base),
                        "pack": m.read(value["refs"]["packManifest"], self.base), "pinSha256": value["refs"]["enginePin"]["sha256"]}
        self.public_pin = m.read(self.prepare_evidence["publicPin"], self.base)
        self.content["catalog"] = {**self.stage["catalog"], "publicPinSha256": m.digest(self.public_pin), "signatureVerified": True}
        shell_root = Path(self.prepare_evidence["shell"]["root"])
        self.preflight_success = self.mount_success = True
        self.commands = []; self.probes = []
        self.owner = Phases.owner
        self.publish_owner = lambda: Phases.publish_owner(self)
        kube = FakeKube(self)
        publication = m.Publication(self.base / ref["path"], ref["sha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), out,
                                    kube=kube, command_runner=lambda argv, **kwargs: Phases.command(self, argv, **kwargs), health=self.probes.append,
                                    static_fetcher=lambda url, maximum: (shell_root / urlsplit(url).path.lstrip("/")).read_bytes())
        publication.dryrun(); publication.apply(); publication.observe()
        observed = json.loads((out / "observe.actual.json").read_bytes())
        self.assertEqual(observed["image"], self.previous["image"])
        self.assertFalse(observed["runtimeAcceptanceComplete"])
        self.assertEqual([dry for _, dry in kube.patches], [True, False])
        self.assertEqual(self.deployments["work"]["spec"], self.desired)
        inputs = planner_fixture.m.cohort.Inputs(out)
        next_previous, next_before = planner_fixture.m.shell.previous_record(observed["acceptedPrevious"], inputs)
        self.assertEqual(next_previous["shellSource"], self.plan["sources"]["lolly"])
        self.assertEqual(next_previous["engineSource"], self.engine_source)
        self.assertEqual(next_before["spec"], self.desired)
        accepted = m.read(next_previous["acceptance"], out)
        original = m.read(accepted["originalEvidence"][0], out)
        self.assertEqual(original["runtimeAndCatalog"]["engine"], self.pin["engine"]["version"])
        self.assertEqual(original["runtimeAndCatalog"]["core"], self.pin["core"]["version"])
        inputs.unchanged()
        # Exercise the entire next offline preparation, including its accepted
        # static count / engine ABI check, from a different publication folder.
        next_evidence = copy.deepcopy(self.prepare_evidence)
        next_evidence["previous"] = observed["acceptedPrevious"]
        next_evidence["previousShell"] = self.prepare_evidence["shell"]
        next_files = {entry["path"]: (shell_root / entry["path"]).read_bytes() for entry in self.content["shell"]["files"]}
        next_evidence["shell"] = self.tree("next-merged-shell", next_files)
        next_evidence["selection"]["shellClaim"] = "second-new-shell"
        node = os.environ.get("LOLLY_TEST_NODE", "node")
        classification = subprocess.run([node, str(SCRIPT.parent / "classify-application-release.ts"), "--repo", str(self.roots["lolly"]),
                    "--base", self.sources["lolly"], "--candidate", self.sources["lolly"]], capture_output=True, check=True)
        next_evidence["classification"] = self.file("next-classification", json.loads(classification.stdout))
        next_result, next_inputs = planner_fixture.m.shell.prepare(next_evidence, self.base, self.public_pin_sha, node)
        self.assertEqual(next_result["sources"]["engine"], self.engine_source)
        self.assertEqual(next_result["image"], self.previous["image"])
        next_inputs.unchanged()

    def test_actual_node_readback_verifies_ephemeral_p256_catalog_and_detects_changed_signature(self):
        self.publication_input()
        shell = Path(self.prepare_evidence["shell"]["root"])
        pack = Path(self.prepare_evidence["rawPack"]["root"])
        pin = self.base / self.prepare_evidence["enginePin"]["path"]
        public = m.read(self.prepare_evidence["publicPin"], self.base)
        node = os.environ.get("LOLLY_TEST_NODE", "node")
        argv = [node, "-e", m.OWNER_READBACK, str(shell), str(pack), str(pin), m.canonical(public).decode()]
        result = subprocess.run(argv, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["catalog"]["signatureVerified"])
        envelope_path = shell / "catalog/tools/index.sig.json"
        envelope = json.loads(envelope_path.read_bytes()); envelope["signature"] = "A" * 86
        envelope_path.write_bytes(m.canonical(envelope))
        result = subprocess.run(argv, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([*(Phases(name) for name in Phases.__dict__ if name.startswith("test_")),
                               *(Handoff(name) for name in Handoff.__dict__ if name.startswith("test_"))])


if __name__ == "__main__":
    unittest.main()
