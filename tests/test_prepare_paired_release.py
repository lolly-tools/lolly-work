#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline artifact attack controls; no cluster, credentials, registry or network."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("prepare", Path(__file__).parents[1] / "scripts/prepare-paired-release.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bytes_json(value):
    return json.dumps(value, sort_keys=True).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tar_bytes(files):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return out.getvalue()


class Preparation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lolly-release-preparation-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.sources = {"lolly": "a" * 40, "work": "b" * 40}
        self.calls = []
        self.gate_fails = False
        self.pin = {"generatedFrom": "c" * 40, "note": "fixture", "engine": {"version": "1.245.0", "contentHash": "d" * 64}, "core": {"version": "1.0.0", "contentHash": "e" * 64}, "schemas": {"fixture.json": "f" * 64}}
        self.public_pin = {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "B" * 43}
        self.runs = {}
        self.evidence = {"version": 1, "expectedImages": {"work": "registry.example/work@sha256:" + "1" * 64, "public-web": "ghcr.io/fixture/lolly-web@sha256:" + "2" * 64}}
        for name in ("work", "lolly"):
            root = self.base / name
            root.mkdir()
            if name == "work":
                (root / "engine-pin.json").write_bytes(bytes_json(self.pin))
            run = self.ci_run(100 if name == "work" else 200, name)
            jobs = self.jobs(run, ["source tests", "typecheck"])
            self.evidence[name] = {"root": str(root), "source": self.sources[name], "repository": "fixture/" + name,
                                   "main": self.file(name + "-main", {"ref": "refs/heads/main", "object": {"type": "commit", "sha": self.sources[name]}}),
                                   "ciRun": self.file(name + "-run", run), "ciJobs": self.file(name + "-jobs", jobs)}
            self.runs[name] = run
        self.evidence["expectedEnginePin"] = self.file("expected-pin", self.pin)
        target = {"version": 2, "transport": {"type": "local", "kubectl": ["kubectl"], "kubeconfig": "/protected/site.kubeconfig", "context": "site"}, "clusterUID": "cluster", "node": {"name": "node", "uid": "node-uid"}, "components": {}}
        for name in ("work", "public-web"):
            target["components"][name] = {"namespace": "applications", "namespaceUID": "namespace", "deployment": name, "deploymentUID": name + "-uid", "images": [{"kind": "container", "name": "server"}]}
        self.evidence["target"] = self.file("target", target)
        candidate = self.ci_run(300, "lolly", workflow="deployment-suse", event="workflow_dispatch")
        self.candidate = candidate
        self.evidence["candidateRun"] = self.file("candidate-run", candidate)
        names = ["Public chart render and schema checks", "Public VM route and security acceptance", "Reviewed main CI source", "WebGPU release gate (web shell image only)", "Opt-in native public web image (gated on the WebGPU table)"]
        self.evidence["candidateJobs"] = self.file("candidate-jobs", self.jobs(candidate, names))
        proof = {"version": 1, "source": self.sources["lolly"], "ciRun": 200, "ciAttempt": 2, "workflow": ".github/workflows/ci.yml", "jobCount": 2}
        self.artifact("normalSource", {"normal-ci-source.json": bytes_json(proof)}, candidate, "normal-main-ci-source-attempt-2")
        self.web_members = self.web()
        self.artifact("web", self.web_members, candidate, "public-candidate-web-receipts-attempt-2")
        self.work_members = self.work()
        self.artifact("work", self.work_members, self.runs["work"], "qualified-server-" + self.sources["work"])

    def ci_run(self, number, source, workflow="ci", event="push"):
        return {"id": number, "run_attempt": 2, "head_sha": self.sources[source], "head_branch": "main", "repository": {"full_name": "fixture/" + source, "id": 5}, "head_repository": {"full_name": "fixture/" + source, "id": 5}, "path": ".github/workflows/" + workflow + ".yml", "event": event, "status": "completed", "conclusion": "success"}

    def jobs(self, run, names):
        return {"total_count": len(names), "jobs": [{"id": 1000 + i, "run_id": run["id"], "run_attempt": 2, "head_sha": run["head_sha"], "name": name, "status": "completed", "conclusion": "success"} for i, name in enumerate(names)]}

    def file(self, name, value):
        data = bytes_json(value)
        path = self.base / (name + ".json")
        path.write_bytes(data)
        return {"path": path.name, "sha256": sha(data)}

    def artifact(self, name, members, run, artifact_name):
        key = {"normalSource": "normalSourceArtifact", "web": "webArtifact", "work": "workArtifact"}[name]
        path = self.base / (name + ".zip")
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            for leaf, data in members.items():
                archive.writestr(leaf, data)
        digest = m.hashed(path)
        self.evidence[key] = {"path": path.name, "sha256": digest}
        metadata = {"id": 400, "name": artifact_name, "size_in_bytes": path.stat().st_size, "expired": False, "digest": "sha256:" + digest,
                    "workflow_run": {"id": run["id"], "repository_id": 5, "head_repository_id": 5, "head_branch": "main", "head_sha": run["head_sha"]}}
        self.evidence[key + "Metadata"] = self.file(name + "-metadata", metadata)

    def web(self):
        image = {"imageId": "sha256:" + "3" * 64, "digest": "ghcr.io/fixture/lolly-web@sha256:" + "4" * 64, "source": self.sources["lolly"], "platform": "linux/amd64"}
        return {"release.json": bytes_json({"source": self.sources["lolly"], "runId": "300", "runAttempt": 2, "neutralProfile": True, "images": {"web": image}, "candidateRuntimeQualified": False}),
                "web.json": bytes_json(image), "public.jwk.json": bytes_json(self.public_pin), "catalog.json": bytes_json({"verified": True, "files": 4, "tools": 2, "indexSha256": "5" * 64, "keyId": "public-key"}), "web-boot.json": bytes_json({"serviceBootPassed": True, "results": {"web": 200}}),
                "dependency-cache.json": bytes_json({"version": 1, "target": "deps", "scope": "public-neutral", "platform": "linux/amd64", "cacheRef": "fixture/deps", "key": "6" * 64, "inputs": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "deploy/docker/web.Dockerfile"], "sourceExported": False, "signingExported": False, "releaseStageCache": False})}

    def work(self, pin=None, corrupt_blob=False):
        layer = tar_bytes({"app/engine-pin.json": bytes_json(pin or self.pin)})
        config = bytes_json({"os": "linux", "architecture": "amd64", "config": {"Labels": {"org.opencontainers.image.revision": self.sources["work"]}}, "rootfs": {"type": "layers", "diff_ids": ["sha256:" + sha(layer)]}})
        def desc(data):
            return {"digest": "sha256:" + sha(data), "size": len(data)}
        manifest = bytes_json({"schemaVersion": 2, "config": desc(config), "layers": [desc(layer)]})
        self.manifest_digest = sha(manifest)
        archive = tar_bytes({"oci-layout": bytes_json({"imageLayoutVersion": "1.0.0"}), "index.json": bytes_json({"schemaVersion": 2, "manifests": [desc(manifest)]}), "blobs/sha256/" + sha(manifest): manifest, "blobs/sha256/" + sha(config): config, "blobs/sha256/" + sha(layer): layer + (b"attack" if corrupt_blob else b"")})
        image = {"Id": "sha256:" + sha(config), "Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": self.sources["work"]}}}
        return {"server.oci.tar": archive, "server.oci.tar.sha256": (sha(archive) + "  /runner/server.oci.tar\n").encode(), "server-image.json": bytes_json(image)}

    def runner(self, argv, root):
        self.calls.append((tuple(argv), str(root)))
        if argv == ["git", "rev-parse", "HEAD"]:
            return self.sources[root.name]
        if argv == ["git", "status", "--porcelain"]:
            return ""
        if argv == ["node", "scripts/webgpu-release-gate.ts", "--scope", "web"] and self.gate_fails:
            raise m.Refusal("Missing supported-environment matrix")
        self.assertIn(argv, [["node", "scripts/webgpu-release-gate.ts", "--scope", "web"], ["node", "scripts/verify-engine-pin.ts"]])
        return "PASS"

    def prepare(self):
        return m.prepare(self.evidence, self.base, m.updater.digest(self.public_pin), self.runner)

    def patch_file(self, parent, name, change):
        old = parent[name]
        value = m.file_input(old, self.base)
        change(value)
        parent[name] = self.file(Path(old["path"]).stem, value)

    def work_only(self):
        self.evidence = {key: value for key, value in self.evidence.items() if key in {"version", "target", "expectedImages", "work", "workArtifact", "workArtifactMetadata", "expectedEnginePin"}}
        self.evidence["expectedImages"].pop("public-web")

    def test_existing_formats_produce_updater_release_only(self):
        release, receipt = self.prepare()
        self.assertEqual(release["version"], 2)
        self.assertEqual(release["updates"][1]["images"][0]["image"], "registry.example/work@sha256:" + self.manifest_digest)
        self.assertEqual(receipt["releaseSha256"], m.updater.digest(release))
        self.assertFalse(receipt["promotionAttempted"])
        self.assertNotIn("kubectl", str(self.calls))

    def test_backend_only_does_not_consult_frontend_gate_or_pin(self):
        self.work_only()
        self.gate_fails = True
        release, _ = self.prepare()
        self.assertEqual(len(release["updates"]), 1)
        self.assertFalse(any("webgpu" in str(call) for call in self.calls))

    def test_public_preparation_selects_web_scope_explicitly(self):
        self.prepare()
        calls = [argv for argv, _ in self.calls if "webgpu-release-gate.ts" in str(argv)]
        self.assertEqual(calls, [("node", "scripts/webgpu-release-gate.ts", "--scope", "web")])

    def test_public_only_does_not_require_private_engine_equality(self):
        for key in ("work", "workArtifact", "workArtifactMetadata", "expectedEnginePin"):
            self.evidence.pop(key)
        self.evidence["expectedImages"].pop("work")
        release, _ = self.prepare()
        self.assertEqual(release["updates"][0]["component"], "public-web")
        self.assertFalse(any("verify-engine-pin" in str(call) for call in self.calls))

    def test_missing_matrix_refuses_before_artifacts(self):
        self.gate_fails = True
        self.evidence["webArtifact"] = {"path": "does-not-exist", "sha256": "0" * 64}
        with self.assertRaisesRegex(m.Refusal, "supported-environment"):
            self.prepare()

    def test_unknown_input_and_artifact_metadata_fail_closed(self):
        self.evidence["signatureVerified"] = True
        with self.assertRaises(m.Refusal): self.prepare()
        self.evidence.pop("signatureVerified")
        self.patch_file(self.evidence, "webArtifactMetadata", lambda v: v.update({"signatureVerified": True}))
        with self.assertRaises(m.Refusal): self.prepare()

    def test_stale_main_fails(self):
        self.patch_file(self.evidence["work"], "main", lambda v: v["object"].update({"sha": "0" * 40}))
        with self.assertRaisesRegex(m.Refusal, "stale"): self.prepare()

    def test_wrong_repository_workflow_and_run_attempt_fail(self):
        for mutate in (lambda v: v["repository"].update({"full_name": "attacker/work"}), lambda v: v.update({"event": "pull_request"}), lambda v: v.update({"run_attempt": 3})):
            original = copy.deepcopy(self.evidence["work"]["ciRun"])
            self.patch_file(self.evidence["work"], "ciRun", mutate)
            with self.assertRaises(m.Refusal): self.prepare()
            self.evidence["work"]["ciRun"] = original
            (self.base / original["path"]).write_bytes(bytes_json(self.runs["work"]))

    def test_candidate_job_missing_duplicate_skip_and_wrong_attempt_fail(self):
        original = copy.deepcopy(self.evidence["candidateJobs"])
        good = m.file_input(original, self.base)
        mutations = [lambda v: v["jobs"][0].update({"run_attempt": 1}), lambda v: v["jobs"][0].update({"conclusion": "skipped"}), lambda v: v.update({"total_count": 6}), lambda v: v["jobs"][0].update({"id": v["jobs"][1]["id"]})]
        for mutate in mutations:
            self.evidence["candidateJobs"] = self.file("candidate-jobs", good)
            self.patch_file(self.evidence, "candidateJobs", mutate)
            with self.assertRaises(m.Refusal): self.prepare()

    def test_artifact_not_bound_to_ci_or_digest_fails(self):
        self.patch_file(self.evidence, "workArtifactMetadata", lambda v: v["workflow_run"].update({"id": 777}))
        with self.assertRaises(m.Refusal): self.prepare()
        self.artifact("work", self.work_members, self.runs["work"], "qualified-server-" + self.sources["work"])
        self.patch_file(self.evidence, "workArtifactMetadata", lambda v: v.update({"digest": "sha256:" + "0" * 64}))
        with self.assertRaises(m.Refusal): self.prepare()

    def test_candidate_normal_ci_receipt_binds_exact_attempt(self):
        wrong = {"version": 1, "source": self.sources["lolly"], "ciRun": 200, "ciAttempt": 1, "workflow": ".github/workflows/ci.yml", "jobCount": 2}
        self.artifact("normalSource", {"normal-ci-source.json": bytes_json(wrong)}, self.candidate, "normal-main-ci-source-attempt-2")
        with self.assertRaisesRegex(m.Refusal, "normal CI"): self.prepare()

    def test_public_catalog_pin_signature_and_extra_members_fail(self):
        for filename, replacement in (("public.jwk.json", bytes_json({**self.public_pin, "d": "secret"})), ("catalog.json", bytes_json({"verified": True})), ("catalog.json", bytes_json({"verified": False, "files": 4, "tools": 2, "indexSha256": "5" * 64, "keyId": "public-key"})), ("injected.json", b"{}")):
            members = {**self.web_members, filename: replacement}
            self.artifact("web", members, self.candidate, "public-candidate-web-receipts-attempt-2")
            with self.assertRaises(m.Refusal): self.prepare()

    def test_wrong_private_pin_and_actual_oci_pin_fail(self):
        self.patch_file(self.evidence, "expectedEnginePin", lambda v: v["engine"].update({"version": "1.248.0"}))
        with self.assertRaisesRegex(m.Refusal, "private contract"): self.prepare()
        self.evidence["expectedEnginePin"] = self.file("expected-pin", self.pin)
        other = copy.deepcopy(self.pin)
        other["schemas"]["fixture.json"] = "0" * 64
        self.artifact("work", self.work(other), self.runs["work"], "qualified-server-" + self.sources["work"])
        with self.assertRaisesRegex(m.Refusal, "OCI engine contract"): self.prepare()

    def test_corrupt_oci_blob_is_rejected_even_with_valid_zip_and_tar_hashes(self):
        self.artifact("work", self.work(corrupt_blob=True), self.runs["work"], "qualified-server-" + self.sources["work"])
        with self.assertRaisesRegex(m.Refusal, "descriptor size"): self.prepare()

    def test_private_asset_selection_refuses_pvc_and_emptydir_shortcuts(self):
        self.patch_file(self.evidence, "target", lambda v: v["components"]["work"].update({"images": [{"kind": "initContainer", "name": "shell-from-image"}]}))
        with self.assertRaisesRegex(m.Refusal, "PVC-backed"): self.prepare()
        self.evidence["expectedImages"]["private-shell"] = "registry.example/shell@sha256:" + "0" * 64
        with self.assertRaises(m.Refusal): self.prepare()

    def test_uncompressed_oci_digest_is_checked(self):
        members = self.work()
        with tarfile.open(fileobj=io.BytesIO(members["server.oci.tar"])) as archive:
            files = {item.name: archive.extractfile(item).read() for item in archive if item.isfile()}
        index = json.loads(files["index.json"])
        manifest = json.loads(files["blobs/sha256/" + index["manifests"][0]["digest"][7:]])
        config_leaf = "blobs/sha256/" + manifest["config"]["digest"][7:]
        config = json.loads(files.pop(config_leaf))
        config["rootfs"]["diff_ids"] = ["sha256:" + "0" * 64]
        config_bytes = bytes_json(config)
        files["blobs/sha256/" + sha(config_bytes)] = config_bytes
        old_manifest = "blobs/sha256/" + index["manifests"][0]["digest"][7:]
        files.pop(old_manifest)
        manifest["config"] = {"digest": "sha256:" + sha(config_bytes), "size": len(config_bytes)}
        manifest_bytes = bytes_json(manifest)
        files["blobs/sha256/" + sha(manifest_bytes)] = manifest_bytes
        files["index.json"] = bytes_json({"schemaVersion": 2, "manifests": [{"digest": "sha256:" + sha(manifest_bytes), "size": len(manifest_bytes)}]})
        transport = tar_bytes(files)
        image = json.loads(members["server-image.json"])
        image["Id"] = "sha256:" + sha(config_bytes)
        members = {"server.oci.tar": transport, "server.oci.tar.sha256": (sha(transport) + "  /runner/server.oci.tar\n").encode(), "server-image.json": bytes_json(image)}
        self.artifact("work", members, self.runs["work"], "qualified-server-" + self.sources["work"])
        with self.assertRaisesRegex(m.Refusal, "uncompressed layer digest"): self.prepare()

    def test_server_update_preserves_owned_asset_init_selectors(self):
        self.work_only()
        self.patch_file(self.evidence, "target", lambda v: v["components"]["work"]["images"].extend([{"kind": "initContainer", "name": "shell-from-image"}, {"kind": "initContainer", "name": "pack-from-image"}]))
        release, _ = self.prepare()
        self.assertEqual(release["updates"][0]["images"][0]["kind"], "container")
        self.assertEqual(len(release["updates"][0]["images"]), 1)

    def test_prepared_release_file_never_overwrites_reviewed_content(self):
        release, _ = self.prepare()
        path = self.base / "release.json"
        m.updater.write_json(path, release)
        first = path.read_bytes()
        with self.assertRaises(FileExistsError): m.updater.write_json(path, {"malicious": True})
        self.assertEqual(path.read_bytes(), first)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_duplicate_json_and_modified_evidence_files_fail(self):
        with self.assertRaises(m.Refusal): m.json_bytes(b'{"version":1,"version":1}')
        path = self.base / self.evidence["work"]["ciRun"]["path"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(m.Refusal, "bytes differ"): self.prepare()

    def test_cli_wrong_review_hash_creates_no_output(self):
        path = self.base / "evidence.json"
        path.write_bytes(bytes_json(self.evidence))
        output = self.base / "release.json"
        result = subprocess.run(["python3", str(Path(m.__file__)), "--evidence", str(path), "--reviewed-evidence-sha256", "0" * 64, "--release-out", str(output)], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(output.exists())
        self.assertNotIn(b"site.kubeconfig", result.stderr)


if __name__ == "__main__":
    unittest.main()
