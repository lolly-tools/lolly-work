#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic accepted-runtime/captured-resource fixtures; no network or cluster."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("planner", Path(__file__).parents[1] / "scripts/plan-private-shell.py")
m = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(m)
_spec = importlib.util.spec_from_file_location("shell_fixture", Path(__file__).with_name("test_prepare_private_shell.py"))
fixture = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fixture)
_spec = importlib.util.spec_from_file_location("patch_fixture", Path(__file__).with_name("test_plan_private_cohort.py"))
patch_fixture = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(patch_fixture)
NODE = os.environ.get("LOLLY_TEST_NODE", "node")


class Plan(fixture.Shell):
    def setUp(self):
        super().setUp()
        self.prepare_evidence = copy.deepcopy(self.evidence)
        self.original_cli = self.file("prepare-cli-envelope", self.prepare_evidence)
        self.prepared = copy.deepcopy(self.result)
        self.prepared["reviewedEvidenceSha256"] = self.original_cli["sha256"]
        self.prepared["evidence"].append({"path": str(self.base / self.original_cli["path"]), "sha256": self.original_cli["sha256"]})
        self.prepared["evidence"].sort(key=lambda ref: ref["path"])
        values = []
        for claim in ("old-shell", "old-pack", "new-shell", "temporary-pack", "other-data", "dormant-rollback"):
            uid = claim + "-uid"
            values.extend([{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": self.meta(claim, uid, "private"), "spec": {"accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem", "storageClassName": "local-path", "volumeName": "pv-" + claim}, "status": {"phase": "Bound"}},
                           {"apiVersion": "v1", "kind": "PersistentVolume", "metadata": self.meta("pv-" + claim, "pv-" + uid), "spec": {"accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem", "storageClassName": "local-path", "local": {"path": "/storage/" + uid},
                            "nodeAffinity": {"required": {"nodeSelectorTerms": [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["fixture-node"]}]}]}}, "claimRef": {"namespace": "private", "name": claim, "uid": uid}}, "status": {"phase": "Bound"}}])
        values.append({"apiVersion": "v1", "kind": "ConfigMap", "metadata": self.meta("old-pin", "old-pin-uid", "private"), "immutable": True, "data": {"engine-pin.json": fixture.m.cohort.canonical(self.pin).decode()}})
        self.facts = {"version": 1, "namespace": {"apiVersion": "v1", "kind": "Namespace", "metadata": self.meta("private", "namespace-uid")}, "resources": values,
                      "pods": {"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "123"}, "items": [
                          {"apiVersion": "v1", "kind": "Pod", "metadata": self.meta("current-owner", "accepted-pod-uid", "private"), "spec": {**copy.deepcopy(self.before["spec"]["template"]["spec"]), "nodeName": "fixture-node"}},
                          {"apiVersion": "v1", "kind": "Pod", "metadata": self.meta("other-owner", "other-pod-uid", "private"), "spec": {"nodeName": "fixture-node", "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "other-data"}}]}}]}}
        pod = {"apiVersion": "v1", "kind": "Pod", "metadata": self.meta("stage", "stage-uid", "private"), "spec": {"automountServiceAccountToken": False, "enableServiceLinks": False, "nodeName": "fixture-node",
               "containers": [{"name": "qualification", "image": self.previous["image"], "imagePullPolicy": "Never", "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}},
                               "volumeMounts": [{"name": "shell", "mountPath": "/stage/shell", "readOnly": True}, {"name": "pack-copy", "mountPath": "/stage/pack", "readOnly": True}, {"name": "pin", "mountPath": "/stage/engine-pin.json", "subPath": "engine-pin.json", "readOnly": True}]}],
               "volumes": [{"name": "shell", "persistentVolumeClaim": {"claimName": "new-shell"}}, {"name": "pack-copy", "persistentVolumeClaim": {"claimName": "temporary-pack"}}, {"name": "pin", "configMap": {"name": "old-pin"}}, {"name": "tmp", "emptyDir": {}}]}}
        retirement = {"podUID": "stage-uid", "policyName": "stage-policy", "policyUID": "policy-uid", "podAbsent": True, "policyAbsent": True, "mountsReleased": True}
        original_runtime = {"version": 1, "status": "ISOLATED_PRIVATE_SHELL_RUNTIME_VERIFIED", "sources": self.prepared["sources"], "image": self.previous["image"], "actualImageId": self.previous["image"], "podUID": "stage-uid",
                            "enginePinSha256": self.prepared["enginePinSha256"], "engineVersion": "1.248.0", "coreVersion": "1.1.0", "shellManifestSha256": self.prepared["shell"]["manifestSha256"], "shellFiles": self.prepared["shell"]["files"],
                            "packManifestSha256": self.prepared["rawPack"]["manifestSha256"], "packFiles": self.prepared["rawPack"]["files"], "catalog": self.prepared["catalog"], "fullShellHashesVerified": True, "fullPackHashesVerified": True,
                            "retainedImmutablePinVerified": True, "filteredCatalogSignatureVerified": True, "publicPinMatches": True, "uid": 1000, "gid": 1000}
        writer = copy.deepcopy(pod); writer["metadata"] = self.meta("writer", "writer-uid", "private")
        writer["spec"]["volumes"] = writer["spec"]["volumes"][:2] + [{"name": "tmp", "emptyDir": {}}]
        writer["spec"]["containers"][0]["volumeMounts"] = writer["spec"]["containers"][0]["volumeMounts"][:2]
        for mt in writer["spec"]["containers"][0]["volumeMounts"]: mt["readOnly"] = False
        writer_proof = {"version": 1, "status": "ISOLATED_PRIVATE_SHELL_WRITER_VERIFIED_AND_RETIRED", "pod": writer, "shellClaim": "new-shell", "shellClaimUID": "new-shell-uid", "packClaim": "temporary-pack", "packClaimUID": "temporary-pack-uid",
                        "shellManifestSha256": self.prepared["shell"]["manifestSha256"], "packManifestSha256": self.prepared["rawPack"]["manifestSha256"], "fullShellHashesVerified": True, "fullPackHashesVerified": True, "podAbsent": True, "mountsReleased": True}
        self.stage = {"version": 1, "status": "ISOLATED_SHELL_ACCEPTED_AND_RETIRED", "sources": self.prepared["sources"], "image": self.previous["image"], "enginePinSha256": self.prepared["enginePinSha256"], "engineVersion": "1.248.0", "coreVersion": "1.1.0",
                      "shell": {**self.prepared["shell"], "claim": "new-shell", "claimUID": "new-shell-uid"}, "rawPack": {**self.prepared["rawPack"], "storage": "ISOLATED_STAGING_PVC_COPY", "volume": "pack-copy", "claim": "temporary-pack", "claimUID": "temporary-pack-uid"}, "catalog": self.prepared["catalog"],
                      "pod": pod, "mounts": {"shellPath": "/stage/shell", "packPath": "/stage/pack", "pinPath": "/stage/engine-pin.json"}, "retirement": retirement,
                      "originalEvidence": [self.file("synthetic-runtime-proof", original_runtime), self.file("synthetic-writer-proof", writer_proof), self.file("synthetic-retirement-proof", {"version": 1, "status": "ISOLATED_PRIVATE_SHELL_STAGE_RETIRED", **retirement})]}
        self.evidence = {"version": 1, "prepared": self.file("prepared", self.prepared), "previous": self.prepare_evidence["previous"], "deployment": self.file("current-deployment", self.before), "resources": self.file("facts", self.facts),
                         "stage": self.file("stage", self.stage), "enginePin": self.prepare_evidence["enginePin"], "mounts": {"container": "server", "shellVolume": "shell", "packVolume": "pack", "pinVolume": "pin", "shellPath": "/app/shell", "packPath": "/app/pack", "pinPath": "/app/engine-pin.json", "pinKey": "engine-pin.json"}}

    @staticmethod
    def meta(name, uid, namespace=None):
        v = {"name": name, "uid": uid, "resourceVersion": "11"}
        if namespace is not None: v["namespace"] = namespace
        return v

    def mutate(self, key, fn):
        v = json.loads((self.base / self.evidence[key]["path"]).read_bytes()); fn(v); self.evidence[key] = self.file("changed-" + key, v)

    def refused(self):
        with self.assertRaises((m.Refusal, m.resources.Refusal, OSError, ValueError, KeyError, TypeError, StopIteration)):
            m.plan(self.evidence, self.base)

    def resource(self, facts, kind, name):
        return next(r for r in facts["resources"] if r["kind"] == kind and r["metadata"]["name"] == name)

    def test_plan_changes_only_shell_claim_and_existing_shell_provenance(self):
        result, inputs = m.plan(self.evidence, self.base)
        patched = patch_fixture.apply_patch(self.before, result["guardedPatch"])
        self.assertEqual(patched["spec"], result["desiredSpec"])
        self.assertEqual(result["status"], m.STATUS)
        self.assertEqual(len([x for x in result["guardedPatch"] if x["op"] == "replace"]), 3)
        self.assertEqual(patched["spec"]["template"]["spec"]["containers"][0]["image"], self.previous["image"])
        self.assertEqual(patched["spec"]["template"]["spec"]["volumes"][1:], self.before["spec"]["template"]["spec"]["volumes"][1:])
        self.assertFalse(result["qualificationBoundary"]["liveResourcesChecked"])
        self.assertIn("NOT_EXECUTABLE", result["rollbackIntent"]["status"])
        inputs.unchanged()

    def test_namespace_claim_pv_alias_active_or_dormant_storage_refuses(self):
        for name in ("old-shell", "old-pack", "other-data", "dormant-rollback"):
            original = copy.deepcopy(self.evidence)
            def change(v):
                self.resource(v, "PersistentVolume", "pv-new-shell")["spec"]["local"]["path"] = self.resource(v, "PersistentVolume", "pv-" + name)["spec"]["local"]["path"] + "/child"
            self.mutate("resources", change); self.refused(); self.evidence = original

    def test_generic_kubectl_list_preserves_original_items_and_empty_aggregate_rv(self):
        self.mutate("resources", lambda v: v["pods"].update(kind="List", metadata={"resourceVersion": ""}))
        original_bytes = (self.base / self.evidence["resources"]["path"]).read_bytes()
        result, inputs = m.plan(self.evidence, self.base)
        self.assertEqual(result["podInventoryResourceVersion"], "")
        self.assertEqual((self.base / self.evidence["resources"]["path"]).read_bytes(), original_bytes)
        inputs.unchanged()

    def test_generic_list_incomplete_mixed_scope_or_duplicate_identity_refuses(self):
        changes = [lambda p: p.update(apiVersion="apps/v1"), lambda p: p.update(kind="UnknownList"),
                   lambda p: p["metadata"].update({"continue": "next"}), lambda p: p["metadata"].update(resourceVersion=None),
                   lambda p: p["metadata"].update(remainingItemCount=1), lambda p: p["metadata"].update(remainingItemCount=True),
                   lambda p: p["metadata"].update(remainingItemCount="0"), lambda p: p["metadata"].update(remainingItemCount=-1),
                   lambda p: p["items"][1].update(apiVersion="apps/v1"), lambda p: p["items"][1].update(kind="ConfigMap"),
                   lambda p: p["items"][1]["metadata"].update(namespace="other"),
                   lambda p: p["items"][1]["metadata"].update(name=p["items"][0]["metadata"]["name"]),
                   lambda p: p["items"][1]["metadata"].update(uid=p["items"][0]["metadata"]["uid"]),
                   lambda p: p["items"][1]["metadata"].update(resourceVersion="")]
        for change in changes:
            original = copy.deepcopy(self.evidence)
            def mutate(v):
                v["pods"].update(kind="List", metadata={"resourceVersion": ""}); change(v["pods"])
            self.mutate("resources", mutate); self.refused(); self.evidence = original

    def test_other_owner_of_accepted_content_or_live_new_shell_refuses(self):
        for claim in ("old-shell", "old-pack", "new-shell", "temporary-pack"):
            original = copy.deepcopy(self.evidence)
            self.mutate("resources", lambda v: v["pods"]["items"][1]["spec"]["volumes"].append({"name": "bad", "persistentVolumeClaim": {"claimName": claim}}))
            self.refused(); self.evidence = original

    def test_candidate_backing_aliases_other_candidate_refuses(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-temporary-pack")["spec"]["local"].update(path="/storage/new-shell-uid/child"))
        self.refused()

    def test_writer_proof_false_live_or_mounting_active_storage_refuses(self):
        for change in (lambda v: v.update(mountsReleased=False), lambda v: v["pod"]["metadata"].update(uid="accepted-pod-uid"),
                       lambda v: v["pod"]["spec"]["volumes"][0]["persistentVolumeClaim"].update(claimName="old-shell")):
            original = copy.deepcopy(self.evidence)
            stage = copy.deepcopy(self.stage)
            proof = json.loads((self.base / stage["originalEvidence"][1]["path"]).read_bytes()); change(proof)
            stage["originalEvidence"][1] = self.file("changed-writer-proof", proof)
            self.evidence["stage"] = self.file("changed-stage-writer", stage); self.refused(); self.evidence = original

    def test_active_pack_mount_secret_pin_write_root_or_extra_process_in_stage_refuses(self):
        changes = [lambda v: v["pod"]["spec"]["volumes"][1].update(persistentVolumeClaim={"claimName": "old-pack"}),
                   lambda v: v["pod"]["spec"]["volumes"].append({"name": "secret", "secret": {"secretName": "db"}}),
                   lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"][2].update(readOnly=False),
                   lambda v: v["pod"]["spec"]["containers"][0]["securityContext"].update(runAsUser=0),
                   lambda v: v["pod"]["spec"].update(initContainers=[{"name": "writer"}])]
        for change in changes:
            original = copy.deepcopy(self.evidence); self.mutate("stage", change); self.refused(); self.evidence = original

    def test_pin_raw_bytes_immutability_or_uid_change_refuses(self):
        for change in (lambda r: r["data"].update({"engine-pin.json": "{}"}), lambda r: r.update(immutable=False), lambda r: r["metadata"].update(uid="different")):
            original = copy.deepcopy(self.evidence); self.mutate("resources", lambda v: change(self.resource(v, "ConfigMap", "old-pin"))); self.refused(); self.evidence = original

    def test_stage_retirement_false_or_original_runtime_unknown_proof_refuses(self):
        self.mutate("stage", lambda v: v["retirement"].update(mountsReleased=False)); self.refused()
        self.evidence["stage"] = self.file("reset-stage", self.stage)
        self.mutate("stage", lambda v: v["originalEvidence"].__setitem__(0, self.file("arbitrary-pass", {"status": "PASS"}))); self.refused()

    def test_wrong_schema_source_image_catalog_or_partial_cohort_refuses(self):
        for change in (lambda v: v.update(engineVersion="9.0.0"), lambda v: v["sources"].update(engine=self.sources["lolly"]), lambda v: v.update(image="other"), lambda v: v["catalog"].update(indexSha256="a" * 64)):
            original = copy.deepcopy(self.evidence); self.mutate("stage", change); self.refused(); self.evidence = original
        self.mutate("prepared", lambda v: v["desiredSpec"]["template"]["spec"]["containers"][0].update(image="new")); self.refused()

    def test_unknown_version_cli_origin_or_original_manifest_binding_refuses(self):
        for change in (lambda v: v.update(version=True), lambda v: v.update(extra=True), lambda v: v["evidence"].clear(), lambda v: v["rawPack"].update(manifestSha256="a" * 64)):
            original = copy.deepcopy(self.evidence); self.mutate("prepared", change); self.refused(); self.evidence = original

    def test_stale_uid_rv_or_unselected_field_blocks_atomic_patch(self):
        result, _ = m.plan(self.evidence, self.base)
        for change in (lambda v: v["metadata"].update(uid="changed"), lambda v: v["metadata"].update(resourceVersion="new"), lambda v: v["spec"]["template"]["spec"]["containers"][0]["env"].append({"name": "OTHER", "value": "changed"})):
            value = copy.deepcopy(self.before); change(value)
            with self.assertRaises(ValueError): patch_fixture.apply_patch(value, result["guardedPatch"])

    def test_real_preparer_cli_to_planner_cli_positive_handoff(self):
        prepare_ref = self.file("real-prepare-cli", self.prepare_evidence)
        out = self.base / "real-prepared"
        result = subprocess.run(["python3", *(["-O"] if sys.flags.optimize else []), "-B", str(Path(__file__).parents[1] / "scripts/prepare-private-shell.py"), "--evidence", str(self.base / prepare_ref["path"]), "--reviewed-evidence-sha256", prepare_ref["sha256"], "--existing-public-pin-sha256", self.public_pin_sha, "--node", NODE, "--out-dir", str(out)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.evidence["prepared"] = {"path": str(out / "shell.prepared.json"), "sha256": hashlib.sha256((out / "shell.prepared.json").read_bytes()).hexdigest()}
        ref = self.file("real-planner-cli", self.evidence)
        planned_out = self.base / "real-planned"
        command = ["python3", *(["-O"] if sys.flags.optimize else []), "-B", str(Path(__file__).parents[1] / "scripts/plan-private-shell.py"), "--evidence", str(self.base / ref["path"]), "--reviewed-evidence-sha256", ref["sha256"], "--out-dir", str(planned_out)]
        result = subprocess.run(command, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((planned_out / "private-shell.plan.json").read_bytes())["status"], m.STATUS)
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Plan(name) for name in Plan.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main()
