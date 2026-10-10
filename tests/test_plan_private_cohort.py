#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic captured resources and original proof bytes; no cluster or image IO."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
script = Path(__file__).parents[1] / "scripts/plan-private-cohort.py"
spec = importlib.util.spec_from_file_location("planner", script)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def encode(v):
    return m.cohort.canonical(v)


def apply_patch(value, operations):
    result = copy.deepcopy(value)
    for operation in operations:
        keys = [k.replace("~1", "/").replace("~0", "~") for k in operation["path"].split("/")[1:]]
        target = result
        for key in keys[:-1]:
            target = target[int(key)] if isinstance(target, list) else target[key]
        key = int(keys[-1]) if isinstance(target, list) else keys[-1]
        if operation["op"] == "test":
            if target[key] != operation["value"]:
                raise ValueError("atomic test refused")
        elif operation["op"] == "replace":
            target[key] = copy.deepcopy(operation["value"])
        else:
            raise ValueError("unexpected patch operation")
    return result


class Plan(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="private-cohort-plan-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.serial = 0
        self.source = {"lolly": "1" * 40, "work": "2" * 40, "brand": "3" * 40}
        self.pin = {"generatedFrom": self.source["lolly"], "engine": {"version": "1.248.0", "contentHash": "4" * 64},
                    "core": {"version": "1.1.0", "contentHash": "5" * 64}, "schemas": {"tool.json": "6" * 64}}
        pin_bytes = encode(self.pin)
        old_pin = encode({**self.pin, "generatedFrom": "0" * 40})
        self.before = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"namespace": "team", "name": "editor", "uid": "deployment-uid", "resourceVersion": "99"},
          "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app": "editor"}},
            "template": {"metadata": {"labels": {"app": "editor"}, "annotations": {"lolly.tools/engine-source": "0" * 40, "lolly.tools/shell-source": "0" * 40,
              "lolly.tools/shell-release": "release-" + "7" * 16, "preserve": "original"}}, "spec": {"automountServiceAccountToken": False,
              "containers": [{"name": "server", "image": "registry.example/work@sha256:" + "8" * 64,
                "env": [{"name": "LW_DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "db", "key": "uri"}}}],
                "resources": {"limits": {"memory": "512Mi"}}, "securityContext": {"runAsUser": 1000},
                "volumeMounts": [{"name": "shell", "mountPath": "/application/ui", "readOnly": True}, {"name": "pack", "mountPath": "/application/content", "readOnly": True},
                  {"name": "pin", "mountPath": "/application/engine-pin.json", "subPath": "engine-pin.json", "readOnly": True}, {"name": "data", "mountPath": "/application/data"}]},
                {"name": "sidecar", "image": "registry.example/sidecar@sha256:" + "9" * 64, "env": [{"name": "UNCHANGED", "value": "keep"}]}],
              "volumes": [{"name": "shell", "persistentVolumeClaim": {"claimName": "old-shell"}}, {"name": "pack", "persistentVolumeClaim": {"claimName": "old-pack"}},
                {"name": "pin", "configMap": {"name": "old-pin"}}, {"name": "data", "persistentVolumeClaim": {"claimName": "durable"}},
                {"name": "credentials", "secret": {"secretName": "existing-secret"}}]}}}}
        self.previous = {"version": 1, "deployment": self.file("original-deployment", self.before), "deploymentSpecSha256": m.cohort.digest(self.before["spec"]),
          "image": self.before["spec"]["template"]["spec"]["containers"][0]["image"], "shell": {"name": "old-shell", "uid": "old-shell-uid", "releaseId": "release-" + "7" * 16},
          "pack": {"name": "old-pack", "uid": "old-pack-uid"}, "pin": {"name": "old-pin", "uid": "old-pin-uid", "sha256": hashlib.sha256(old_pin).hexdigest()}}
        sel = {"container": "server", "shellVolume": "shell", "packVolume": "pack", "pinVolume": "pin", "shellClaim": "new-shell", "packClaim": "new-pack",
               "pinConfigMap": "new-pin", "provenance": {key: self.source["lolly"] for key in m.SOURCE_KEYS}}
        self.image = "registry.example/work@sha256:" + "a" * 64
        desired, template, inverse = m.cohort.change_tuple(self.before, self.previous, sel, self.image, self.source["lolly"])
        self.prepared = {"version": 1, "status": m.cohort.STATUS, "sources": self.source, "image": self.image,
          "normalCI": {"lolly": {"run": 20, "attempt": 1}, "work": {"run": 10, "attempt": 1}}, "profile": "fixture-private", "resolverPinSha256": "d" * 64,
          "enginePinSha256": hashlib.sha256(pin_bytes).hexdigest(), "previousCohortSha256": self.file("previous", self.previous)["sha256"],
          "shell": {"manifestSha256": "b" * 64, "releaseId": "release-" + "c" * 16, "files": 5}, "rawPack": {"manifestSha256": "d" * 64, "files": 3},
          "catalog": {"indexSha256": "e" * 64, "envelopeSha256": "f" * 64, "keyId": "fixture-public-pin", "signedFiles": 2},
          "beforeSpecSha256": self.previous["deploymentSpecSha256"], "desiredSpecSha256": m.cohort.digest(desired), "desiredSpec": desired,
          "guardedPatchTemplate": template, "inverseTupleTemplate": inverse, "allUnselectedSpecFieldsPreserved": True,
          "evidence": [], "requiredBeforeApply": ["Synthetic fixture only"],
          "qualificationBoundary": {"localReviewedEvidence": True, "originAuthenticatedByThisCommand": False, "ociSignatureClaimed": False,
             "privateShellSignatureClaimed": False, "runtimeQualified": False, "productionMutation": False, "buildOrSigningPerformed": False}}
        resources = []
        for claim in ("old-shell", "old-pack", "durable", "new-shell", "new-pack"):
            uid = claim + "-uid"
            resources += [{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": self.meta(claim, uid, "team"),
              "spec": {"accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem", "storageClassName": "local-path", "volumeName": "pv-" + claim}, "status": {"phase": "Bound"}},
              {"apiVersion": "v1", "kind": "PersistentVolume", "metadata": self.meta("pv-" + claim, "pv-" + uid),
                "spec": {"accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem", "storageClassName": "local-path", "local": {"path": "/storage/" + uid},
                  "nodeAffinity": {"required": {"nodeSelectorTerms": [{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["fixture-node"]}]}]}},
                  "claimRef": {"namespace": "team", "name": claim, "uid": uid}}, "status": {"phase": "Bound"}}]
        resources += [{"apiVersion": "v1", "kind": "ConfigMap", "metadata": self.meta("old-pin", "old-pin-uid", "team"), "immutable": True, "data": {"engine-pin.json": old_pin.decode()}},
                      {"apiVersion": "v1", "kind": "ConfigMap", "metadata": self.meta("new-pin", "new-pin-uid", "team"), "immutable": True, "data": {"engine-pin.json": pin_bytes.decode()}}]
        self.facts = {"version": 1, "namespace": {"apiVersion": "v1", "kind": "Namespace", "metadata": self.meta("team", "namespace-uid")},
          "resources": resources, "pods": {"apiVersion": "v1", "kind": "PodList", "metadata": {"resourceVersion": "123"}, "items": [
             {"apiVersion": "v1", "kind": "Pod", "metadata": self.meta("current-owner", "owner-uid", "team"), "spec": {**copy.deepcopy(self.before["spec"]["template"]["spec"]), "nodeName": "fixture-node"}}]}}
        self.stage = {"version": 1, "status": "ISOLATED_COHORT_ACCEPTED_AND_RETIRED", "sources": self.source, "image": self.image,
          "enginePinSha256": self.prepared["enginePinSha256"], "engineVersion": "1.248.0", "coreVersion": "1.1.0",
          "shell": {**self.prepared["shell"], "claim": "new-shell", "claimUID": "new-shell-uid"}, "rawPack": {**self.prepared["rawPack"], "claim": "new-pack", "claimUID": "new-pack-uid"},
          "catalog": self.prepared["catalog"], "pod": {"apiVersion": "v1", "kind": "Pod", "metadata": self.meta("retired-stage", "stage-uid", "team"),
             "spec": {"automountServiceAccountToken": False, "enableServiceLinks": False, "nodeName": "fixture-node", "containers": [{"name": "qualification", "image": self.image, "imagePullPolicy": "Never",
                "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                  "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}}, "volumeMounts": [
                    {"name": "shell", "mountPath": "/stage/shell"}, {"name": "pack", "mountPath": "/stage/pack"}, {"name": "pin", "mountPath": "/stage/engine-pin.json", "subPath": "engine-pin.json"}]}], "volumes": [
                {"name": "shell", "persistentVolumeClaim": {"claimName": "new-shell"}}, {"name": "pack", "persistentVolumeClaim": {"claimName": "new-pack"}},
                {"name": "pin", "configMap": {"name": "new-pin"}}, {"name": "tmp", "emptyDir": {}}]}},
          "mounts": {"shellPath": "/stage/shell", "packPath": "/stage/pack", "pinPath": "/stage/engine-pin.json"},
          "retirement": {"podUID": "stage-uid", "policyUID": "policy-uid", "podAbsent": True, "policyAbsent": True, "mountsReleased": True},
          "originalEvidence": [self.file("original-" + n, ("Synthetic original " + n).encode()) for n in ("content", "runtime", "retirement")]}
        self.evidence = {"version": 1, "cohort": self.file("cohort", self.prepared), "previous": self.file("previous", self.previous),
          "deployment": self.file("deployment", self.before), "resources": self.file("resources", self.facts), "stage": self.file("stage", self.stage), "enginePin": self.file("pin", self.pin),
          "mounts": {"container": "server", "shellVolume": "shell", "packVolume": "pack", "pinVolume": "pin", "shellPath": "/application/ui", "packPath": "/application/content",
                     "pinPath": "/application/engine-pin.json", "pinKey": "engine-pin.json"}}

    @staticmethod
    def meta(name, uid, namespace=None):
        value = {"name": name, "uid": uid, "resourceVersion": "11"}
        if namespace is not None:
            value["namespace"] = namespace
        return value

    def file(self, name, value):
        self.serial += 1
        path = self.base / (str(self.serial) + "-" + name + ".json")
        data = value if isinstance(value, bytes) else encode(value)
        path.write_bytes(data); path.chmod(0o600)
        return {"path": path.name, "sha256": hashlib.sha256(data).hexdigest()}

    def mutate(self, key, fn):
        value = json.loads((self.base / self.evidence[key]["path"]).read_bytes())
        fn(value); self.evidence[key] = self.file("mutated-" + key, value)

    def refuse(self):
        with self.assertRaises(m.Refusal):
            m.plan(self.evidence, self.base)

    def resource(self, facts, kind, name):
        return next(v for v in facts["resources"] if v["kind"] == kind and v["metadata"]["name"] == name)

    def test_atomic_seven_leaf_plan_preserves_entire_other_spec_and_inputs(self):
        original = copy.deepcopy(self.before)
        result, inputs = m.plan(self.evidence, self.base)
        actual = apply_patch(self.before, result["guardedPatch"])
        expected = copy.deepcopy(self.before["spec"])
        expected["template"]["spec"]["containers"][0]["image"] = self.image
        for i, wanted in enumerate(("new-shell", "new-pack", "new-pin")):
            field, leaf = ("configMap", "name") if i == 2 else ("persistentVolumeClaim", "claimName")
            expected["template"]["spec"]["volumes"][i][field][leaf] = wanted
        expected["template"]["metadata"]["annotations"].update({**{k: self.source["lolly"] for k in m.SOURCE_KEYS}, "lolly.tools/shell-release": "release-" + "c" * 16})
        self.assertEqual(actual["spec"], expected)
        self.assertEqual(result["desiredSpec"], expected)
        self.assertEqual(self.before, original)
        self.assertEqual(len([op for op in result["guardedPatch"] if op["op"] == "replace"]), 7)
        self.assertEqual(result["status"], m.STATUS)
        self.assertFalse(result["qualificationBoundary"]["liveResourcesChecked"])
        self.assertEqual(len(result["resourceGuards"]), 12)
        inputs.unchanged()

    def test_stale_uid_rv_image_or_unselected_field_blocks_atomic_patch(self):
        result, _ = m.plan(self.evidence, self.base)
        for fn in (lambda v: v["metadata"].update(uid="changed"), lambda v: v["metadata"].update(resourceVersion="100"),
                   lambda v: v["spec"]["template"]["spec"]["containers"][0].update(image="changed"),
                   lambda v: v["spec"]["template"]["spec"]["containers"][1].update(image="changed")):
            with self.subTest(fn=fn):
                wrong = copy.deepcopy(self.before); fn(wrong)
                with self.assertRaises(ValueError): apply_patch(wrong, result["guardedPatch"])

    def test_capture_rv_refresh_keeps_prepared_exact_spec(self):
        self.mutate("deployment", lambda v: v["metadata"].update(resourceVersion="101"))
        result, _ = m.plan(self.evidence, self.base)
        self.assertEqual(result["resourceVersion"], "101")
        self.assertEqual(result["guardedPatch"][1]["value"], "101")

    def test_current_identity_spec_or_replica_changes_refuse(self):
        for key, value in (("uid", "other"), ("namespace", "other"), ("name", "other")):
            with self.subTest(key=key):
                evidence = copy.deepcopy(self.evidence)
                self.mutate("deployment", lambda v: v["metadata"].update({key: value})); self.refuse(); self.evidence = evidence
        self.mutate("deployment", lambda v: v["spec"].update(replicas=2)); self.refuse()

    def test_unknown_version_or_partial_envelope_refuses(self):
        for version in (True, 2, "1"):
            self.evidence["version"] = version; self.refuse()
        self.evidence["version"] = 1; del self.evidence["stage"]; self.refuse()

    def test_cohort_unknown_keys_profile_or_ci_shape_refuse(self):
        for change in (lambda v: v.update(qualified=True), lambda v: v.update(profile="public"),
                       lambda v: v["normalCI"]["lolly"].update(attempt=True)):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence); self.mutate("cohort", change); self.refuse(); self.evidence = old

    def test_wrong_preparer_status_or_runtime_claim_refuses(self):
        self.mutate("cohort", lambda v: v.update(status="RUNTIME_ACCEPTED")); self.refuse()
        self.evidence["cohort"] = self.file("cohort", self.prepared)
        self.mutate("cohort", lambda v: v["qualificationBoundary"].update(runtimeQualified=True)); self.refuse()

    def test_partial_claim_set_or_unselected_cohort_change_refuses(self):
        self.mutate("cohort", lambda v: v["desiredSpec"]["template"]["spec"]["volumes"][0].update(persistentVolumeClaim={"claimName": "old-shell"})); self.refuse()
        self.evidence["cohort"] = self.file("cohort", self.prepared)
        self.mutate("cohort", lambda v: v["desiredSpec"]["template"]["spec"]["containers"][1].update(image=self.image)); self.refuse()

    def test_selected_mount_path_readonly_or_pin_subpath_refuses(self):
        for change in (lambda v: v["mounts"].update(shellPath="/wrong"), lambda v: v["mounts"].update(pinKey="different.json"),
                       lambda v: v["mounts"].update(shellPath="/application/../ui")):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence); change(self.evidence); self.refuse(); self.evidence = old

    def test_active_candidate_claim_or_pin_use_refuses(self):
        for volume in ({"name": "unsafe", "persistentVolumeClaim": {"claimName": "new-shell"}}, {"name": "unsafe", "configMap": {"name": "new-pin"}}):
            with self.subTest(volume=volume):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: v["pods"]["items"][0]["spec"]["volumes"].append(volume)); self.refuse(); self.evidence = old

    def test_active_unreviewed_direct_storage_refuses(self):
        for volume in ({"name": "direct", "hostPath": {"path": "/storage/new-shell-uid"}},
                       {"name": "inline", "csi": {"driver": "storage.example.org"}}, {"name": "dynamic", "ephemeral": {"volumeClaimTemplate": {}}}):
            with self.subTest(volume=volume):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: v["pods"]["items"][0]["spec"]["volumes"].append(volume))
                with self.assertRaisesRegex(m.Refusal, "active direct storage"):
                    m.plan(self.evidence, self.base)
                self.evidence = old

    def test_pending_or_deleting_candidate_claim_refuses(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolumeClaim", "new-shell")["status"].update(phase="Pending")); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolumeClaim", "new-shell")["metadata"].update(deletionTimestamp="today")); self.refuse()

    def test_wrong_pv_claim_uid_or_namespace_refuses(self):
        for field in ("uid", "namespace", "name"):
            with self.subTest(field=field):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-new-shell")["spec"]["claimRef"].update({field: "wrong"})); self.refuse(); self.evidence = old

    def test_active_durable_backing_path_alias_refuses(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-new-shell")["spec"]["local"].update(path="/storage/durable-uid")); self.refuse()

    def test_cross_kind_local_hostpath_alias_refuses(self):
        def alias(v):
            spec = self.resource(v, "PersistentVolume", "pv-new-shell")["spec"]
            del spec["local"]; spec["hostPath"] = {"path": "/storage/durable-uid"}
        self.mutate("resources", alias); self.refuse()

    def test_candidate_pair_storage_alias_refuses(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-new-pack")["spec"]["local"].update(path="/storage/new-shell-uid")); self.refuse()

    def test_parent_child_paths_overlap_active_and_candidate_storage(self):
        for pv, path in (("pv-new-shell", "/storage/durable-uid/subdir"), ("pv-new-shell", "/storage"),
                         ("pv-new-pack", "/storage/new-shell-uid/child")):
            with self.subTest(pv=pv, path=path):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", pv)["spec"]["local"].update(path=path)); self.refuse(); self.evidence = old

    def test_local_node_scope_must_be_explicit_and_match_pods(self):
        for change in (lambda spec: spec.pop("nodeAffinity"),
                       lambda spec: spec["nodeAffinity"]["required"]["nodeSelectorTerms"][0]["matchExpressions"][0].update(values=["other-node"]),
                       lambda spec: spec["nodeAffinity"]["required"]["nodeSelectorTerms"][0]["matchExpressions"][0].update(values=["fixture-node", "other-node"])):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: change(self.resource(v, "PersistentVolume", "pv-new-shell")["spec"])); self.refuse(); self.evidence = old
        self.mutate("resources", lambda v: v["pods"]["items"][0]["spec"].update(nodeName="other-node")); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("stage", lambda v: v["pod"]["spec"].update(nodeName="other-node")); self.refuse()

    def test_csi_volumes_are_portable_and_alias_handles_refuse(self):
        def csi(v):
            for pv in [r for r in v["resources"] if r["kind"] == "PersistentVolume"]:
                pv["spec"].pop("local"); pv["spec"]["csi"] = {"driver": "storage.example.org", "volumeHandle": pv["metadata"]["uid"]}
        self.mutate("resources", csi)
        result, _ = m.plan(self.evidence, self.base); self.assertEqual(result["namespace"], "team")
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-new-shell")["spec"]["csi"].update(volumeHandle="pv-durable-uid")); self.refuse()

    def test_unknown_backing_and_block_mode_refuse(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolume", "pv-new-shell")["spec"].update(nfs={"server": "unreviewed"})); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolumeClaim", "new-shell")["spec"].update(volumeMode="Block")); self.refuse()

    def test_missing_active_pv_capture_or_duplicate_object_refuses(self):
        self.mutate("resources", lambda v: v["resources"].remove(self.resource(v, "PersistentVolume", "pv-durable"))); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("resources", lambda v: v["resources"].append(copy.deepcopy(v["resources"][0]))); self.refuse()

    def test_paginated_pod_inventory_or_other_namespace_refuses(self):
        self.mutate("resources", lambda v: v["pods"]["metadata"].update({"continue": "next"})); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("resources", lambda v: v["pods"]["items"][0]["metadata"].update(namespace="other")); self.refuse()

    def test_old_claim_or_pin_identity_changed_refuses(self):
        self.mutate("resources", lambda v: self.resource(v, "PersistentVolumeClaim", "old-shell")["metadata"].update(uid="newUID")); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("resources", lambda v: self.resource(v, "ConfigMap", "old-pin")["metadata"].update(uid="newUID")); self.refuse()

    def test_pin_mutable_extra_data_or_different_bytes_refuses(self):
        for change in (lambda cm: cm.update(immutable=False), lambda cm: cm["data"].update(extra="unsafe"), lambda cm: cm["data"].update({"engine-pin.json": "{}"})):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence)
                self.mutate("resources", lambda v: change(self.resource(v, "ConfigMap", "new-pin"))); self.refuse(); self.evidence = old

    def test_wrong_engine_source_version_or_stage_source_refuses(self):
        self.mutate("enginePin", lambda v: v.update(generatedFrom="0" * 40)); self.refuse()
        self.evidence["enginePin"] = self.file("pin", self.pin)
        self.mutate("stage", lambda v: v.update(engineVersion="1.245.0")); self.refuse()
        self.evidence["stage"] = self.file("stage", self.stage)
        self.mutate("stage", lambda v: v.update(sources={**self.source, "work": "0" * 40})); self.refuse()

    def test_content_hash_catalog_or_stage_claim_uid_mismatch_refuses(self):
        for change in (lambda v: v["shell"].update(manifestSha256="0" * 64), lambda v: v["catalog"].update(signedFiles=1), lambda v: v["rawPack"].update(claimUID="other")):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence); self.mutate("stage", change); self.refuse(); self.evidence = old

    def test_still_present_stage_or_unreleased_mounts_refuse(self):
        self.mutate("resources", lambda v: v["pods"]["items"].append(self.stage["pod"])); self.refuse()
        self.evidence["resources"] = self.file("resources", self.facts)
        self.mutate("stage", lambda v: v["retirement"].update(mountsReleased=False)); self.refuse()

    def test_stage_active_pvc_credentials_or_missing_pack_refuses(self):
        for change in (lambda v: v["pod"]["spec"]["volumes"][0]["persistentVolumeClaim"].update(claimName="old-shell"),
                       lambda v: v["pod"]["spec"]["containers"][0].update(envFrom=[{"secretRef": {"name": "production"}}]),
                       lambda v: v["pod"]["spec"]["volumes"].pop(1),
                       lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"].pop(1)):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence); self.mutate("stage", change); self.refuse(); self.evidence = old

    def test_stage_host_privileges_and_container_security_refuse(self):
        for change in (lambda spec: spec.update(hostPID=True), lambda spec: spec.update(ephemeralContainers=[{"name": "debug"}]),
                       lambda spec: spec.update(imagePullSecrets=[{"name": "production"}]), lambda spec: spec.update(enableServiceLinks=True),
                       lambda spec: spec["containers"][0]["securityContext"].update(privileged=True),
                       lambda spec: spec["containers"][0]["securityContext"].update(runAsUser=0),
                       lambda spec: spec["containers"][0]["securityContext"].update(runAsUser=True),
                       lambda spec: spec["containers"][0]["securityContext"].update(allowPrivilegeEscalation=True),
                       lambda spec: spec["containers"][0]["securityContext"].update(capabilities={"add": ["SYS_ADMIN"], "drop": ["ALL"]}),
                       lambda spec: spec["containers"][0]["securityContext"].update(seccompProfile={"type": "Unconfined"}),
                       lambda spec: spec.update(securityContext={"runAsUser": 0}),
                       lambda spec: spec.update(securityContext={"sysctls": [{"name": "arbitrary", "value": "1"}]})):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence)
                self.mutate("stage", lambda v: change(v["pod"]["spec"])); self.refuse(); self.evidence = old

    def test_stage_unused_wrong_path_or_missing_pin_mount_refuses(self):
        for change in (lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"][0].update(name="tmp"),
                       lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"][1].update(mountPath="/different"),
                       lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"].pop(2),
                       lambda v: v["pod"]["spec"]["containers"][0]["volumeMounts"][2].update(subPath="different.json"),
                       lambda v: v["pod"]["spec"]["volumes"].append({"name": "second-pin", "configMap": {"name": "new-pin"}})):
            with self.subTest(change=change):
                old = copy.deepcopy(self.evidence); self.mutate("stage", change); self.refuse(); self.evidence = old

    def test_original_evidence_changed_or_missing_refuses(self):
        ref = self.stage["originalEvidence"][0]
        (self.base / ref["path"]).write_bytes(b"different")
        self.refuse()

    def test_stale_shell_release_annotation_refuses(self):
        self.mutate("previous", lambda v: v["shell"].update(releaseId="release-" + "0" * 16))
        self.mutate("cohort", lambda v: v.update(previousCohortSha256=self.evidence["previous"]["sha256"]))
        with self.assertRaisesRegex(m.Refusal, "Existing shell release provenance differs"):
            m.plan(self.evidence, self.base)

    def test_maintained_release_id_grammar_refuses_a_bare_digest(self):
        self.mutate("cohort", lambda v: v["shell"].update(releaseId="c" * 64))
        with self.assertRaisesRegex(m.Refusal, "maintained shell release ID"):
            m.plan(self.evidence, self.base)

    def test_symlink_or_writable_inputs_refuse(self):
        target = self.base / self.evidence["deployment"]["path"]
        link = self.base / "linked"; link.symlink_to(target)
        ref = self.evidence["deployment"]; self.evidence["deployment"] = {**ref, "path": "linked"}; self.refuse()
        self.evidence["deployment"] = ref; target.chmod(0o666); self.refuse()

    def test_duplicate_json_key_and_nonfinite_numbers_refuse(self):
        for data in (b'{"version":1,"version":1}', b'{"value":NaN}'):
            with self.subTest(data=data), self.assertRaises(m.Refusal):m.cohort.parse_json(data)

    def test_input_changed_between_plan_and_publish_refuses_without_output(self):
        result, inputs = m.plan(self.evidence, self.base)
        (self.base / self.evidence["resources"]["path"]).write_bytes(b"changed")
        with self.assertRaises(m.Refusal):m.publish(result, self.base / "out", inputs)
        self.assertFalse((self.base / "out").exists())

    def test_changed_input_during_write_preserves_only_partial_output(self):
        result, inputs = m.plan(self.evidence, self.base)
        original = inputs.unchanged
        calls = 0
        def change():
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.base / self.evidence["resources"]["path"]).write_bytes(b"changed")
            original()
        with patch.object(inputs, "unchanged", side_effect=change), self.assertRaises(m.Refusal):
            m.publish(result, self.base / "out", inputs)
        self.assertFalse((self.base / "out/private-cohort.plan.json").exists())
        self.assertTrue((self.base / "out/.plan.partial").exists())

    def test_protected_exclusive_output_and_cli_are_local_only(self):
        envelope = self.file("planning-evidence", self.evidence)
        out = self.base / "plan"
        result = subprocess.run([sys.executable, str(script), "--evidence", str(self.base / envelope["path"]), "--reviewed-evidence-sha256", envelope["sha256"], "--out-dir", str(out)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        plan_file = out / "private-cohort.plan.json"
        self.assertEqual(report["planSha256"], hashlib.sha256(plan_file.read_bytes()).hexdigest())
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        self.assertEqual(plan_file.stat().st_mode & 0o777, 0o600)
        self.assertFalse(report["productionMutation"])
        again = subprocess.run(result.args, capture_output=True, text=True)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(report["planSha256"], hashlib.sha256(plan_file.read_bytes()).hexdigest())

    def test_planning_invokes_no_transport_or_build_process(self):
        with patch.object(m.cohort.subprocess, "run", side_effect=AssertionError("No subprocess allowed")):
            result, _ = m.plan(self.evidence, self.base)
        self.assertEqual(result["status"], m.STATUS)


class ProducerIntegration(unittest.TestCase):
    def test_actual_preparer_cli_output_plans_via_cli_without_restamping(self):
        # Use the maintained producer's actual Git/OCI/catalog fixture. Its
        # signing key is ephemeral fixture data, never a deployment credential.
        spec = importlib.util.spec_from_file_location("producer_fixture", Path(__file__).with_name("test_prepare_private_cohort.py"))
        producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)

        class Producer(producer.Cohort):
            def prepare(self):
                if not getattr(self, "planning_mount_added", False):
                    self.planning_mount_added = True
                    self.before["spec"]["template"]["spec"]["containers"][0]["volumeMounts"][2]["subPath"] = "engine-pin.json"
                    self.before["spec"]["template"]["metadata"]["annotations"]["lolly.tools/shell-release"] = self.previous["shell"]["releaseId"]
                    self.previous["deployment"] = self.file("planning-before", self.before)
                    self.previous["deploymentSpecSha256"] = m.cohort.digest(self.before["spec"])
                    acceptance = json.loads((self.base / self.previous["acceptance"]["path"]).read_bytes())
                    acceptance["deploymentSpecSha256"] = self.previous["deploymentSpecSha256"]
                    self.previous["acceptance"] = self.file("planning-old-acceptance", acceptance)
                    self.evidence["previous"] = self.file("planning-previous", self.previous)
                return super().prepare()

        Producer.setUpClass()
        built = Producer("test_matched_cohort_preserves_all_nonselected_fields_and_has_no_apply_authority")
        self.addCleanup(built.doCleanups); built.setUp()
        resources = Plan(); self.addCleanup(resources.doCleanups); resources.setUp()
        facts = copy.deepcopy(resources.facts)
        facts["namespace"]["metadata"]["name"] = "private"
        for resource in facts["resources"]:
            if resource["kind"] == "PersistentVolume":
                resource["spec"]["claimRef"]["namespace"] = "private"
            else:
                resource["metadata"]["namespace"] = "private"
        old_pin = (built.base / built.previous["enginePin"]["path"]).read_bytes()
        new_pin = (built.base / built.evidence["enginePin"]["path"]).read_bytes()
        resources.resource(facts, "ConfigMap", "old-pin")["data"]["engine-pin.json"] = old_pin.decode()
        resources.resource(facts, "ConfigMap", "new-pin")["data"]["engine-pin.json"] = new_pin.decode()
        facts["pods"]["items"][0]["metadata"]["namespace"] = "private"
        facts["pods"]["items"][0]["spec"] = {**copy.deepcopy(built.before["spec"]["template"]["spec"]), "nodeName": "fixture-node"}
        original_input = built.file("cli-original-evidence", built.evidence)
        prepared_dir = built.base / "cli-prepared"
        python = [sys.executable, *(["-O"] if sys.flags.optimize else [])]
        prepare_cli = subprocess.run([*python, str(producer.m.__file__), "--evidence", str(built.base / original_input["path"]),
                                     "--reviewed-evidence-sha256", original_input["sha256"], "--existing-public-pin-sha256", built.public_pin_sha,
                                     "--out-dir", str(prepared_dir), "--node", producer.NODE], capture_output=True, text=True)
        self.assertEqual(prepare_cli.returncode, 0, prepare_cli.stderr)
        prepared_file = prepared_dir / "cohort.prepared.json"
        prepared_bytes = prepared_file.read_bytes()
        actual = json.loads(prepared_bytes)
        self.assertEqual(actual["reviewedEvidenceSha256"], original_input["sha256"])
        self.assertEqual(json.loads(prepare_cli.stdout)["cohortSha256"], hashlib.sha256(prepared_bytes).hexdigest())
        self.assertIn({"path": str(built.base / original_input["path"]), "sha256": original_input["sha256"]}, actual["evidence"])
        stage = copy.deepcopy(resources.stage)
        stage.update(sources=actual["sources"], image=actual["image"], enginePinSha256=actual["enginePinSha256"], catalog=actual["catalog"])
        stage["shell"].update(actual["shell"]); stage["rawPack"].update(actual["rawPack"])
        stage["pod"]["metadata"]["namespace"] = "private"; stage["pod"]["spec"]["containers"][0]["image"] = actual["image"]
        stage["originalEvidence"] = [built.binary("planning-original-" + n, ("Synthetic stage " + n).encode()) for n in ("content", "runtime", "retirement")]
        evidence = {"version": 1, "cohort": {"path": str(prepared_file), "sha256": hashlib.sha256(prepared_bytes).hexdigest()}, "previous": built.evidence["previous"],
                    "deployment": built.file("current-deployment", built.before), "resources": built.file("resource-facts", facts),
                    "stage": built.file("stage-facts", stage), "enginePin": built.evidence["enginePin"],
                    "mounts": {**resources.evidence["mounts"], "shellPath": "/app/shell", "packPath": "/app/pack", "pinPath": "/app/engine-pin.json"}}
        result, inputs = m.plan(evidence, built.base)
        self.assertEqual(result["sourceCohortSha256"], evidence["cohort"]["sha256"])
        self.assertEqual(result["sources"], actual["sources"])
        self.assertEqual(result["desiredSpec"]["template"]["metadata"]["annotations"]["lolly.tools/shell-release"], actual["shell"]["releaseId"])
        self.assertEqual(apply_patch(built.before, result["guardedPatch"])["spec"], result["desiredSpec"])
        self.assertFalse(result["qualificationBoundary"]["runtimeQualifiedByThisCommand"])
        inputs.unchanged(); built.baseline_inputs.unchanged()
        planning_input = built.file("cli-planning-evidence", evidence)
        plan_dir = built.base / "cli-planned"
        plan_cli = subprocess.run([*python, str(script), "--evidence", str(built.base / planning_input["path"]),
                                  "--reviewed-evidence-sha256", planning_input["sha256"], "--out-dir", str(plan_dir)], capture_output=True, text=True)
        self.assertEqual(plan_cli.returncode, 0, plan_cli.stderr)
        planned_bytes = (plan_dir / "private-cohort.plan.json").read_bytes()
        planned = json.loads(planned_bytes)
        self.assertEqual(json.loads(plan_cli.stdout)["planSha256"], hashlib.sha256(planned_bytes).hexdigest())
        self.assertEqual(planned["sourceCohortSha256"], evidence["cohort"]["sha256"])
        self.assertEqual(planned["desiredSpec"], result["desiredSpec"])
        self.assertIn({"path": str(built.base / original_input["path"]), "sha256": original_input["sha256"]}, planned["evidence"])
        self.assertFalse(planned["qualificationBoundary"]["productionMutation"])

        # Mutate copies of the real CLI output, not a function-only projection.
        def reject_cohort(change, reason):
            wrong = copy.deepcopy(actual); change(wrong)
            rejected = {**evidence, "cohort": built.file("rejected-cli-cohort", wrong)}
            with self.assertRaisesRegex(m.Refusal, reason):
                m.plan(rejected, built.base)

        cases = (
            (lambda v: v.update(unknownCliField=True), "Missing or unsupported fields"),
            (lambda v: v.update(reviewedEvidenceSha256=None), "Invalid SHA256"),
            (lambda v: v.update(reviewedEvidenceSha256="0" * 64), "exactly one original envelope"),
            (lambda v: v.update(evidence=[r for r in v["evidence"] if r["sha256"] != original_input["sha256"]]), "exactly one original envelope"),
            (lambda v: v["evidence"].append({"path": str(built.base / original_input["path"]), "sha256": original_input["sha256"]}), "Duplicate CLI evidence path"),
            (lambda v: v["evidence"].append(built.binary("same-evidence-copy", (built.base / original_input["path"]).read_bytes())), "exactly one original envelope"),
        )
        for change, reason in cases:
            with self.subTest(reason=reason): reject_cohort(change, reason)

        def reject_original(change, reason):
            original = copy.deepcopy(built.evidence); change(original)
            changed = built.file("changed-original-envelope", original)
            def update(v):
                v["reviewedEvidenceSha256"] = changed["sha256"]
                v["evidence"] = [r for r in v["evidence"] if r["sha256"] != original_input["sha256"]]
                v["evidence"].append({"path": str(built.base / changed["path"]), "sha256": changed["sha256"]})
            reject_cohort(update, reason)

        changes = (
            (lambda v: v.update(unknownOriginalField=True), "Missing or unsupported fields"),
            (lambda v: v["lolly"].update(source="0" * 40), "source differs"),
            (lambda v: v["work"].update(source="0" * 40), "source differs"),
            (lambda v: v["brand"].update(commit="0" * 40), "profile, brand or image differs"),
            (lambda v: v.update(profile="other-private"), "profile, brand or image differs"),
            (lambda v: v.update(expectedWorkImage="registry.example/work@sha256:" + "0" * 64), "profile, brand or image differs"),
            (lambda v: v["enginePin"].update(sha256="0" * 64), "pin or previous cohort differs"),
            (lambda v: v["resolverPin"].update(sha256="0" * 64), "pin or previous cohort differs"),
            (lambda v: v["previous"].update(sha256="0" * 64), "pin or previous cohort differs"),
            (lambda v: v["shell"]["manifest"].update(sha256="0" * 64), "content manifest differs"),
            (lambda v: v["rawPack"]["manifest"].update(sha256="0" * 64), "content manifest differs"),
            (lambda v: v["selection"].update(shellClaim="unreviewed-claim"), "selected tuple differs"),
        )
        for change, reason in changes:
            with self.subTest(original=reason): reject_original(change, reason)
        missing = {**evidence, "cohort": built.file("wrong-byte-envelope-ref", {**actual, "evidence": [
            {**r, "path": str(built.base / "different-envelope.json")} if r["sha256"] == original_input["sha256"] else r for r in actual["evidence"]]})}
        (built.base / "different-envelope.json").write_bytes(b"{}")
        with self.assertRaisesRegex(m.Refusal, "Evidence bytes differ from review"):
            m.plan(missing, built.base)
        self.assertEqual(prepared_file.read_bytes(), prepared_bytes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
