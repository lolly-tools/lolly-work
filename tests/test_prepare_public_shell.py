#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic public runtime/CI originals, real immutable Git and ephemeral P-256 crypto.

No fixture is production acceptance or authenticated GitHub evidence. These tests
exercise the planner's actual parsing/independent gates, without any target calls.
"""
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

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("public_shell", Path(__file__).parents[1] / "scripts/prepare-public-shell.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location("fixture_helpers", Path(__file__).with_name("test_prepare_private_cohort.py"))
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
NODE = os.environ.get("LOLLY_TEST_NODE", "node")


class Public(unittest.TestCase):
    # Only the existing synthetic file/Git/CI and test-only key utilities are
    # reused. No private artifact, pack, receipt or acceptance enters this lane.
    setUpClass = classmethod(f.Cohort.setUpClass.__func__)
    git, init, put, file, tree, patch, ci_run = (getattr(f.Cohort, k) for k in ("git", "init", "put", "file", "tree", "patch", "ci_run"))

    def binary(self, name, data):
        ref = f.Cohort.binary(self, name, data); ref["path"] = str(self.base / ref["path"]); return ref

    def commit(self):
        self.git(self.root, "add", "."); self.git(self.root, "commit", "-m", "Synthetic public source")
        return self.git(self.root, "rev-parse", "HEAD")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lolly-public-shell-fixture-"); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve(); self.serial = 0; self.root = self.base / "lolly"; self.init(self.root)
        for path, data in {"package.json": b'{"name":"lolly"}', "engine/src/version.ts": b'export const version="fixture";', "packages/core/src/host-v1.ts": b'export const host={};',
                           "schemas/tool.schema.json": b'{}', "profiles.json": b'{}', "shells/web/src/main.ts": b'export const title="old";', "scripts/webgpu-release-gate.ts": b'// Synthetic scope fixture'}.items(): self.put(self.root, path, data)
        self.image_source = self.commit(); self.put(self.root, "shells/web/src/main.ts", b'export const title="new";'); self.source = self.commit()
        self.sources = {"lolly": self.source}; run = self.ci_run(20, "lolly"); names = m.cohort.LOLLY_JOBS
        self.lolly = {"root": str(self.root), "source": self.source, "repository": "fixture/lolly",
                      "main": self.file("synthetic-main", {"ref": "refs/heads/main", "object": {"type": "commit", "sha": self.source}}), "ciRun": self.file("synthetic-run", run),
                      "ciJobs": self.file("synthetic-jobs", {"total_count": len(names), "jobs": [{"id": i + 1, "run_id": run["id"], "run_attempt": 1, "head_sha": self.source, "name": n, "status": "completed", "conclusion": "success"} for i, n in enumerate(names)]})}
        self.pin = self.file("ephemeral-public-key", self.keys["public"])
        index, tool = f.raw({"tools": [{"id": "public-fixture"}]}), f.raw({"id": "public-fixture"})
        key_id = __import__("base64").urlsafe_b64encode(hashlib.sha256(f.raw(self.keys["public"])).digest()).decode().rstrip("=")
        unsigned = {"alg": "ECDSA-P256-SHA256", "keyId": key_id, "signedAt": "2026-10-10T00:00:00Z", "indexHash": f.sha(index), "files": {"public-fixture/tool.json": f.sha(tool)}}
        signing = subprocess.run([NODE, "-e", "const c=require('node:crypto');let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const v=JSON.parse(d);process.stdout.write(c.sign('sha256',Buffer.from(v.payload,'base64'),{key:c.createPrivateKey({key:v.key,format:'jwk'}),dsaEncoding:'ieee-p1363'}).toString('base64url'));});"],
                                 input=f.raw({"key": self.keys["private"], "payload": __import__("base64").b64encode(f.raw(unsigned)).decode()}), capture_output=True, check=True)
        envelope = f.raw({**unsigned, "signature": signing.stdout.decode()})
        old_content = {"index.html": b'old public index', "precache.json": b'{}', "sw.js": b'public service worker', "portable/player.js": b'player', "_app/old.js": b'old lazy bytes',
                       "catalog/tools/index.json": index, "catalog/tools/index.sig.json": envelope, "tools/public-fixture/tool.json": tool, "fonts/public.woff2": b'public font'}
        new_content = {**old_content, "index.html": b'new public index', "_app/new.js": b'new chunk'}; del new_content["_app/old.js"]
        merged = {**new_content, "_app/old.js": old_content["_app/old.js"]}
        self.trees = {"previous": self.tree("accepted-public", old_content), "candidate": self.tree("candidate-public", new_content), "shell": self.tree("retained-public", merged),
                      "overlay": self.tree("public-overlay", {p: b for p, b in merged.items() if m.overlay_path(p)}), "delta": self.tree("public-delta", {p: b for p, b in new_content.items() if old_content.get(p) != b})}
        self.catalog = {"indexSha256": f.sha(index), "envelopeSha256": f.sha(envelope), "pinCanonicalSha256": m.cohort.digest(self.keys["public"]), "keyId": key_id, "signedFiles": 1}
        image = "registry.example/public@sha256:" + "a" * 64
        config = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "nginx", "namespace": "public", "uid": "nginx-uid", "resourceVersion": "11"}, "data": {"default.conf": "root /usr/share/nginx/html;"}}
        claim = {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": "models", "namespace": "public", "uid": "models-uid", "resourceVersion": "12"}, "spec": {"volumeName": "models-pv", "storageClassName": "local-path", "accessModes": ["ReadWriteOnce"]}, "status": {"phase": "Bound"}}
        pv = {"apiVersion": "v1", "kind": "PersistentVolume", "metadata": {"name": "models-pv", "uid": "models-pv-uid", "resourceVersion": "13"}, "spec": {"claimRef": {"name": "models", "namespace": "public", "uid": "models-uid"}, "local": {"path": "/models-only"}}, "status": {"phase": "Bound"}}
        self.before = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "web", "namespace": "public", "uid": "web-uid", "resourceVersion": "77"}, "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app": "public"}},
                       "template": {"metadata": {"labels": {"app": "public"}, "annotations": {"preserve": "all"}}, "spec": {"automountServiceAccountToken": False, "securityContext": {"runAsUser": 101, "runAsGroup": 101, "fsGroup": 101}, "containers": [{"name": "web", "image": image, "imagePullPolicy": "IfNotPresent", "resources": {"limits": {"memory": "128Mi"}}, "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}, {"name": "nginx", "mountPath": "/etc/nginx/conf.d/default.conf", "readOnly": True, "subPath": "default.conf"}, {"name": "models", "mountPath": m.ROOT + "/models", "readOnly": True, "subPath": "models-pinned"}]}], "volumes": [{"name": "tmp", "emptyDir": {"sizeLimit": "16Mi"}}, {"name": "nginx", "configMap": {"name": "nginx"}}, {"name": "models", "persistentVolumeClaim": {"claimName": "models"}}]}}}}
        policy = {"web": {"uid": "policy-uid", "spec": {"podSelector": {"matchLabels": {"app": "public"}}, "policyTypes": ["Ingress"]}}}; service = {"web": {"uid": "svc-uid", "spec": {"ports": [{"port": 8080}], "selector": {"app": "public"}}}}
        prepared = {"status": "INDEPENDENT_PUBLIC647_IMAGE_ONLY_EXPECTATIONS_PREPARED_BEFORE_PROMOTION", "source": self.image_source, "image": image, "expectedPublicSpec": self.before["spec"], "nginxConfig": config, "modelsClaim": claim, "modelsPV": pv, "policyInventory": {**policy, "lolly-public-models-stage": {"uid": "retired-stage", "spec": {}}}, "serviceInventory": service}
        prepared_ref = self.file("synthetic-original-image-plan", prepared)
        hashes_ref = self.binary("synthetic-original-full-runtime-hashes", "".join(f"{f.sha(b)}  {m.ROOT}/{p}\n" for p, b in sorted(old_content.items())).encode())
        accepted_catalog = {"verified": True, "exactFreshNeutralCatalogPayloadPreserved": True, "existingPublicPinCanonicalSha256": self.catalog["pinCanonicalSha256"], "publicJWKSha256": self.pin["sha256"], "indexSha256": self.catalog["indexSha256"], "keyId": key_id, "files": 1}
        runtime = {"actualPublicSpecSha256": m.cohort.digest(self.before["spec"]), "independentExpectedSpecSha256": m.cohort.digest(self.before["spec"]), "image": image, "imageID": image, "deploymentUID": "web-uid", "ready": True, "restarts": 0, "allStaticFilesChecked": len(old_content), "uidGid": ["101", "101"], "stagerPodAndPolicyAbsent": True,
                   "modelsPrefixExcluded": m.ROOT + "/models/", "runtimeHashManifestSha256": hashes_ref["sha256"], "podUID": "actual-fixture-pod", "podSpecSha256": "b" * 64, "modelsClaimUID": "models-uid", "modelsPVUID": "models-pv-uid", "nginxConfigSha256": f.sha(config["data"]["default.conf"].encode())}
        accepted = {"status": "READ_ONLY_PUBLIC647_PROMOTION_ACCEPTANCE_PASSED", "source": self.image_source, "readOnly": True, "productionMutation": False, "publicMCPAndOtherEightSpecsUnchanged": True, "preparedSha256": prepared_ref["sha256"], "runtime": runtime, "catalogSignatureVerifiedAndActualSignedBytesMatched": accepted_catalog,
                    "normalVerifiedTLSRequests": {"index.html": {"status": 200, "verifiedTlsAndHostname": True}}, "trustedSystemCA": {"certificateVerification": "CERT_REQUIRED", "hostnameVerification": True}}
        acceptance_ref = self.file("synthetic-original-actual-public-runtime", accepted)
        static_ref = self.file("synthetic-original-public-files", {"htmlRoot": m.ROOT[1:], "files": {p: {"mode": 0o644, "size": len(b), "sha256": f.sha(b)} for p, b in sorted(old_content.items())}})
        self.previous = {"version": 1, "imageSource": self.image_source, "shellSource": self.image_source, "image": image, "profile": "lolly-start", "settings": m.SETTINGS, "publicKeySha256": self.pin["sha256"], "publicCatalog": self.catalog, "staticManifest": self.trees["previous"]["manifest"], "overlay": None,
                         "deploymentSpecSha256": m.cohort.digest(self.before["spec"]), "deployment": self.file("accepted-deployment", self.before), "nginxConfig": self.file("accepted-config", config), "modelsClaim": self.file("accepted-models", claim), "modelsPV": self.file("accepted-models-pv", pv),
                         "policyInventory": self.file("accepted-policies", policy), "serviceInventory": self.file("accepted-services", service), "originalEvidence": [acceptance_ref, prepared_ref, static_ref, hashes_ref]}
        classification = json.loads(subprocess.run([NODE, str(Path(__file__).parents[1] / "scripts/classify-application-release.ts"), "--repo", str(self.root), "--base", self.image_source, "--candidate", self.source], capture_output=True, check=True).stdout)
        def report(name, command): return self.file(name, {"command": [NODE, *command], "exitCode": 0, "signal": None, "error": None, "stdout": "Synthetic local compiler report; no qualification", "stderr": ""})
        custody = {"version": 1, "artifactClass": "public-shell-overlay", "imageSource": self.image_source, "previousShellSource": self.image_source, "image": image, "profile": "lolly-start", "settings": m.SETTINGS, "previousManifest": self.previous["staticManifest"], "previousAcceptance": acceptance_ref, "ci": self.lolly["ciRun"], "publicKeySha256": self.pin["sha256"], "publicCatalog": self.catalog}
        module = self.root / "engine/src/version.ts"
        helper_root = Path(__file__).parents[1] / "scripts"
        helper_refs = [{"path": str(helper_root / name), "sha256": f.sha((helper_root / name).read_bytes())} for name in sorted(m.PRODUCER_SOURCES)]
        module_receipt = self.file("synthetic-workspace-graph", {"version": 1, "source": str(self.root), "guardIncludesWorkerGraph": True, "normalCIQualified": False, "productionAuthority": False, "modules": [{"path": str(module), "bytes": module.stat().st_size, "sha256": f.sha(module.read_bytes())}]})
        prerequisites = self.base / "synthetic-empty-prerequisites"; prerequisites.mkdir()
        runner_input = self.file("synthetic-original-vite-input", {"source": str(self.root), "sourceCommit": self.source, "output": self.trees["candidate"]["root"], "prerequisites": str(prerequisites), "moduleReceipt": module_receipt["path"]})
        self.producer = {"version": 1, "status": m.PRODUCER_STATUS, "artifactClass": "public-shell-overlay", "lollySource": self.source, "imageSource": self.image_source, "previousShellSource": self.image_source, "image": image, "profile": "lolly-start", "settings": m.SETTINGS, "publicCatalog": self.catalog, "shellManifestSha256": self.trees["shell"]["manifest"]["sha256"],
                         "workspaceModules": module_receipt,
                         "originalReport": report("synthetic-vite-report", [str(helper_root / "shell-update-vite.mjs"), runner_input["path"], runner_input["sha256"]]), "classification": self.file("actual-classifier-on-synthetic-source", classification), "imageClassification": self.file("actual-image-classifier-on-synthetic-source", classification), "custody": self.file("producer-custody", custody), "previousAcceptance": acceptance_ref, "ci": self.lolly["ciRun"], "publicKey": self.pin, **self.trees,
                         "retention": self.file("synthetic-local-retention", {"retained": ["_app/old.js"]}), "retainedFiles": 1, "webGate": report("synthetic-web-gate", ["scripts/webgpu-release-gate.ts", "--scope", "web"]),
                         "catalog": {"previous": report("synthetic-maintained-previous-catalog", ["scripts/verify-release-catalog.ts", "--root", self.trees["previous"]["root"], "--public-key", self.pin["path"]]), "candidate": report("synthetic-maintained-candidate-catalog", ["scripts/verify-release-catalog.ts", "--root", self.trees["candidate"]["root"], "--public-key", self.pin["path"]]), "signatureReused": True, "newSigning": False},
                         "producer": next(ref for ref in helper_refs if Path(ref["path"]).name == "prepare-public-shell-update.ts"), "producerSourceFiles": helper_refs, "originAuthenticatedByThisCommand": False, "normalCIQualified": False, "runtimeQualified": False, "promotionAttempted": False}
        self.selection = {"container": "web", "shellVolume": "public-shell", "shellClaim": "new-public-shell"}
        desired = m.desired_spec({**self.previous, "modelsName": "models", "nginxName": "nginx"}, self.before, self.selection, self.source, self.trees["overlay"]["manifest"]["sha256"])
        self.evidence = {"version": 1, "lolly": self.lolly, "producer": self.file("producer", self.producer), "previous": self.file("previous", self.previous), "selection": self.selection, "desiredSpec": self.file("requested-desired", desired)}
        self.result, self.inputs = self.prepare()

    def prepare(self): return m.prepare(self.evidence, self.base, NODE)
    def refuse(self):
        with self.assertRaises((m.Refusal, OSError, ValueError, KeyError, TypeError)): self.prepare()
    def refresh_previous(self): self.evidence["previous"] = self.file("changed-baseline", self.previous)
    def refresh_producer(self): self.evidence["producer"] = self.file("changed-producer", self.producer)

    def test_bootstrap_retains_all_public_resources_and_only_adds_five_readonly_mounts(self):
        before = self.before["spec"]["template"]["spec"]; after = self.result["desiredSpec"]["template"]["spec"]
        self.assertEqual(after["containers"][0]["image"], before["containers"][0]["image"])
        self.assertEqual(after["volumes"][:-1], before["volumes"])
        self.assertEqual(after["containers"][0]["volumeMounts"][:-5], before["containers"][0]["volumeMounts"])
        self.assertTrue(all(row["readOnly"] is True for row in after["containers"][0]["volumeMounts"][-5:]))
        self.assertEqual([row["subPath"] for row in after["containers"][0]["volumeMounts"][-5:]], list(m.PATHS))
        self.assertFalse(self.result["qualificationBoundary"]["runtimeQualified"]); self.assertFalse(self.result["qualificationBoundary"]["originAuthenticatedByThisCommand"])
        self.assertEqual(self.result["sources"], {"shell": self.source, "image": self.image_source}); self.inputs.unchanged()

    def test_subsequent_plan_changes_only_overlay_claim_and_shell_provenance(self):
        before = copy.deepcopy(self.before); before["spec"] = self.result["desiredSpec"]
        old_overlay = {"volume": self.selection["shellVolume"], "claim": self.selection["shellClaim"], "claimUID": "new-shell-original-uid", "manifest": self.trees["overlay"]["manifest"]}
        previous = {**self.previous, "shellSource": self.source, "overlay": old_overlay, "modelsName": "models", "nginxName": "nginx"}
        selection = {**self.selection, "shellClaim": "next-public-shell"}
        desired = m.desired_spec(previous, before, selection, "c" * 40, "d" * 64)
        expected = copy.deepcopy(before["spec"])
        expected["template"]["spec"]["volumes"][-1]["persistentVolumeClaim"]["claimName"] = selection["shellClaim"]
        expected["template"]["metadata"]["annotations"].update({"lolly.tools/public-shell-source": "c" * 40, "lolly.tools/public-overlay-manifest": "d" * 64})
        self.assertEqual(desired, expected)
        for change in (lambda v: v["template"]["spec"]["containers"][0]["volumeMounts"][-1].update(readOnly=False), lambda v: v["template"]["spec"]["containers"][0]["volumeMounts"][-1].update(subPath="catalog"), lambda v: v["template"]["spec"]["volumes"][-1]["persistentVolumeClaim"].update(readOnly=False)):
            bad = copy.deepcopy(before); change(bad["spec"])
            with self.assertRaises(m.Refusal): m.desired_spec(previous, bad, selection, "c" * 40, "d" * 64)

    def test_real_offline_cli_emits_guarded_public_plan_and_cannot_overwrite_it(self):
        evidence = self.file("reviewed-synthetic-input", self.evidence); out = self.base / "cli-public-output"
        argv = [sys.executable, "-B", str(Path(__file__).parents[1] / "scripts/prepare-public-shell.py"), "--evidence", str(self.base / evidence["path"]), "--reviewed-evidence-sha256", evidence["sha256"], "--out-dir", str(out), "--node", NODE]
        r = subprocess.run(argv, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr.decode()); planned = json.loads((out / "cohort.prepared.json").read_bytes())
        self.assertEqual(planned["status"], m.STATUS); self.assertFalse(planned["qualificationBoundary"]["productionMutation"])
        self.assertEqual({Path(ref["path"]).name for ref in planned["operatorSourceFiles"]}, {"prepare-public-shell.py", "prepare-private-shell.py", "prepare-private-cohort.py", "prepare-paired-release.py", "app-update.py"})
        original = (out / "cohort.prepared.json").read_bytes(); repeat = subprocess.run(argv, capture_output=True)
        self.assertEqual(repeat.returncode, 1); self.assertEqual((out / "cohort.prepared.json").read_bytes(), original)

    def test_profile_policy_pin_catalog_and_private_receipt_refuse(self):
        for field, wrong in (("profile", "suse"), ("settings", {**m.SETTINGS, "requireAiPolicy": True}), ("publicKeySha256", "0" * 64), ("publicCatalog", {**self.catalog, "indexSha256": "0" * 64})):
            old = self.previous[field]; self.previous[field] = wrong; self.refresh_previous(); self.refuse(); self.previous[field] = old
        self.previous["originalEvidence"][0] = self.file("private-wrapper", {"status": "MATCHED_PRIVATE_RUNTIME_AND_HTTPS_ACCEPTED"}); self.refresh_previous(); self.refuse()

    def test_changed_model_backing_config_policy_or_service_refuses(self):
        for key, mutate in (("modelsClaim", lambda v: v["spec"].update(volumeName="foreign-pv")), ("modelsPV", lambda v: v["spec"]["local"].update(path="/active-work")), ("nginxConfig", lambda v: v["data"].update({"default.conf": "changed"})),
                            ("policyInventory", lambda v: v["web"]["spec"].update(ingress=[{}])), ("serviceInventory", lambda v: v["web"]["spec"].update(selector={"app": "private"}))):
            original = copy.deepcopy(self.previous); self.patch(self.previous, key, mutate); self.refresh_previous(); self.refuse(); self.previous = original

    def test_desired_model_mount_image_or_any_unselected_spec_change_refuses(self):
        for mutation in (lambda v: v.update(replicas=2), lambda v: v["template"]["spec"]["containers"][0].update(image="registry.example/public@sha256:" + "b" * 64),
                         lambda v: v["template"]["spec"]["containers"][0]["volumeMounts"][2].update(readOnly=False), lambda v: v["template"]["spec"].update(serviceAccountName="privileged"),
                         lambda v: v["template"]["spec"]["containers"][0]["resources"]["limits"].update(memory="1Gi")):
            original = self.evidence["desiredSpec"]; self.patch(self.evidence, "desiredSpec", mutation); self.refuse(); self.evidence["desiredSpec"] = original

    def test_overlay_extra_protected_content_missing_lazy_asset_or_tree_tamper_refuses(self):
        for path in ("catalog/tools/index.json", "models/model.onnx"):
            original = copy.deepcopy(self.producer)
            tree = m.cohort.Tree(self.trees["overlay"], m.cohort.Inputs(self.base)); content = {p: (tree.root / p).read_bytes() for p in tree.files}; content[path] = b"unexpected"
            self.producer["overlay"] = self.tree("bad-overlay-" + str(self.serial), content); self.refresh_producer(); self.refuse(); self.producer = original
        Path(self.trees["shell"]["root"], "_app/old.js").write_bytes(b"changed retained lazy bytes"); self.refuse()

    def test_failed_main_ci_dirty_source_and_non_shell_source_refuse(self):
        original = copy.deepcopy(self.evidence); self.patch(self.evidence["lolly"], "ciRun", lambda v: v.update(conclusion="failure")); self.refuse(); self.evidence = original
        self.put(self.root, "untracked.ts", b"dirty"); self.refuse()

    def test_original_complete_runtime_proof_cannot_be_a_success_label(self):
        original = self.previous["originalEvidence"][0]
        for mutate in (lambda v: v.update(status="PASS"), lambda v: v["runtime"].update(runtimeHashManifestSha256="0" * 64), lambda v: v["runtime"].update(imageID="foreign"), lambda v: v["runtime"].update(allStaticFilesChecked=1)):
            wrapper = {"original": original}; self.patch(wrapper, "original", mutate); self.previous["originalEvidence"][0] = wrapper["original"]; self.refresh_previous(); self.refuse()
        self.previous["originalEvidence"][0] = original

    def test_original_build_input_and_complete_helper_closure_refuse_rebinding(self):
        for mutation in (lambda v: v.update(producerSourceFiles=v["producerSourceFiles"][:-1]), lambda v: v.update(custody=self.file("wrong-original-public-custody", {"status": "PASS"})),
                         lambda v: v.update(workspaceModules=self.file("escaped-modules", {"version": 1, "source": str(self.root), "guardIncludesWorkerGraph": True, "normalCIQualified": False, "productionAuthority": False, "modules": [{"path": str(self.base / "foreign.ts"), "bytes": 1, "sha256": "a" * 64}]}))):
            original = copy.deepcopy(self.producer); mutation(self.producer); self.refresh_producer(); self.refuse(); self.producer = original

    def test_active_claim_mount_overlap_and_duplicate_overlay_refuse(self):
        for change in (lambda v: v.update(shellClaim="models"), lambda v: v.update(shellVolume="models")):
            original = self.selection.copy(); change(self.selection); self.refuse(); self.selection.clear(); self.selection.update(original)
        before = copy.deepcopy(self.before); before["spec"]["template"]["spec"]["containers"][0]["volumeMounts"].append({"name": "rogue", "mountPath": m.ROOT, "readOnly": True})
        with self.assertRaises(m.Refusal): m.desired_spec({**self.previous, "modelsName": "models", "nginxName": "nginx"}, before, self.selection, self.source, "a" * 64)


if __name__ == "__main__": unittest.main()
