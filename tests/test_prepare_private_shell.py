#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic offline source, catalog and accepted-runtime fixtures only."""
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
_spec = importlib.util.spec_from_file_location("shell", Path(__file__).parents[1] / "scripts/prepare-private-shell.py")
m = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(m)
_spec = importlib.util.spec_from_file_location("cohort_fixture", Path(__file__).with_name("test_prepare_private_cohort.py"))
fixture = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fixture)
NODE = os.environ.get("LOLLY_TEST_NODE", "node")


class Shell(fixture.Cohort):
    # The inherited cohort tests exercise a different lane. This class replaces
    # only their fixture methods; unittest loading below selects our own cases.
    def commit(self, root):
        if root.name == "lolly" and not (root / "package.json").exists():
            for path, data in {"package.json": b'{"name":"lolly"}', "engine/src/version.ts": b"export const v='1.248.0';", "packages/core/src/host-v1.ts": b"export const host={};",
                               "schemas/tool.schema.json": b'{}', "profiles.json": b'{}', "shells/web/src/main.ts": b"export const hello='old';"}.items():
                self.put(root, path, data)
        return super().commit(root)

    def setUp(self):
        # The parent fixture's final preparation must call its own v1 helper,
        # rather than this lane before our explicit accepted baseline exists.
        self.preparing_parent = True
        super().setUp()
        self.preparing_parent = False
        self.engine_source = self.sources["lolly"]
        self.put(self.roots["lolly"], "shells/web/src/main.ts", b"export const hello='new';")
        self.sources["lolly"] = self.commit(self.roots["lolly"])
        for key in ("main", "ciRun", "ciJobs"):
            def change(value, key=key):
                if key == "main": value["object"]["sha"] = self.sources["lolly"]
                elif key == "ciRun": value["head_sha"] = self.sources["lolly"]
                else:
                    for job in value["jobs"]: job["head_sha"] = self.sources["lolly"]
            self.patch(self.evidence["lolly"], key, change)
        self.evidence["lolly"]["source"] = self.sources["lolly"]
        candidate_root = Path(self.evidence["candidateShell"]["root"])
        content = {entry["path"]: (candidate_root / entry["path"]).read_bytes() for entry in json.loads((self.base / self.evidence["candidateShell"]["manifest"]["path"]).read_bytes())["files"]}
        old = {**content, "index.html": b"<title>Accepted old shell</title>", "_app/old.js": b"old lazy chunk"}
        del old["_app/new.js"]
        self.evidence["previousShell"] = self.tree("accepted-old", old)
        # The parent prepared tree's retained chunk had different fixture bytes.
        self.evidence["shell"] = self.tree("shell-merged", {**content, "_app/old.js": old["_app/old.js"]})
        previous_tree = m.cohort.Tree(self.evidence["previousShell"], m.cohort.Inputs(self.base))
        raw_tree = m.cohort.Tree(self.evidence["rawPack"], m.cohort.Inputs(self.base))
        self.before["spec"]["template"]["spec"]["containers"][0]["image"] = self.evidence["expectedWorkImage"]
        self.before["spec"]["template"]["spec"]["containers"][0]["volumeMounts"][2]["subPath"] = "engine-pin.json"
        self.before["spec"]["template"]["metadata"]["annotations"].update({"lolly.tools/engine-source": self.engine_source, "lolly.tools/shell-source": self.engine_source, "lolly.tools/shell-release": previous_tree.shell_id})
        self.previous = {"version": 1, "deployment": self.file("accepted-deployment", self.before), "deploymentSpecSha256": m.cohort.digest(self.before["spec"]), "shellSource": self.engine_source,
                         "engineSource": self.engine_source, "workSource": self.sources["work"], "image": self.evidence["expectedWorkImage"], "enginePin": self.evidence["enginePin"], "resolverPin": self.evidence["resolverPin"],
                         "shell": {"name": "old-shell", "uid": "old-shell-uid", "manifestSha256": previous_tree.manifest_sha, "releaseId": previous_tree.shell_id},
                         "pack": {"name": "old-pack", "uid": "old-pack-uid", "manifestSha256": raw_tree.manifest_sha}, "pin": {"name": "old-pin", "uid": "old-pin-uid", "sha256": self.evidence["enginePin"]["sha256"]}}
        original_cohort = self.file("synthetic-original-accepted-cohort", {"version": 1, "status": m.cohort.STATUS, "sources": {"lolly": self.engine_source, "work": self.sources["work"], "brand": self.brand}, "image": self.previous["image"],
                                    "enginePinSha256": self.previous["enginePin"]["sha256"], "resolverPinSha256": self.previous["resolverPin"]["sha256"], "shell": {"manifestSha256": previous_tree.manifest_sha}, "rawPack": {"manifestSha256": raw_tree.manifest_sha}})
        original_publisher_input = self.file("synthetic-original-publisher-input", {"refs": {"cohort": original_cohort}})
        original_acceptance_input = self.file("synthetic-original-acceptance-input", {"source": self.engine_source, "workSource": self.sources["work"], "refs": {"publisherInput": original_publisher_input}})
        actual = {"status": "MATCHED_PRIVATE_RUNTIME_AND_HTTPS_ACCEPTED", "source": self.engine_source, "workSource": self.sources["work"], "image": self.previous["image"], "imageId": self.previous["image"],
                  "deploymentUid": "deployment-uid", "deploymentSpecSha256": self.previous["deploymentSpecSha256"], "namespace": "private", "deploymentName": "work", "podUid": "accepted-pod-uid", "replicaSetUid": "accepted-rs-uid", "podSpecSha256": "b" * 64,
                  "shellClaim": "old-shell", "shellClaimUid": "old-shell-uid", "packClaim": "old-pack", "packClaimUid": "old-pack-uid", "pinConfigMap": "old-pin", "pinConfigMapUid": "old-pin-uid", "fullStatic": {"verified": True, "files": len(old)},
                  "runtimeAndCatalog": {"engine": "1.248.0", "core": "1.1.0", "pinSha256": self.previous["pin"]["sha256"], "vendorContentMatches": True, "signedFileMapMatchesQualifiedOracle": True, "filteredCatalogSignatureVerified": True, "publicPinMatches": True, "automaticMigration": False, "packFilesEqual": len(raw_tree.files), "signedToolFilesEqual": 2},
                  "https": [{"path": "index.html", "sha256": fixture.sha(old["index.html"]), "status": 200, "verifiedTlsAndHostname": True}], "tls": {"certificateRequired": True, "hostnameVerified": True}, "inputSha256": original_acceptance_input["sha256"]}
        self.original_acceptance = self.file("synthetic-original-runtime", actual)
        acceptance = {"version": 1, "status": "RUNTIME_ACCEPTED", "deploymentUID": "deployment-uid", "deploymentSpecSha256": self.previous["deploymentSpecSha256"],
                      **{k: self.previous[k] for k in ("shellSource", "engineSource", "workSource", "image")}, "enginePinSha256": self.previous["pin"]["sha256"], "resolverPinSha256": self.evidence["resolverPin"]["sha256"],
                      "shellManifestSha256": previous_tree.manifest_sha, "packManifestSha256": raw_tree.manifest_sha,
                      "originalEvidence": [self.original_acceptance, original_acceptance_input, self.binary("synthetic-https-original", b"Synthetic original TLS evidence; no real qualification")]}
        self.previous["acceptance"] = self.file("accepted-wrapper", acceptance)
        self.evidence["previous"] = self.file("accepted-previous", self.previous)
        self.evidence["selection"] = {key: self.evidence["selection"][key] for key in ("container", "shellVolume", "packVolume", "pinVolume", "shellClaim")}
        self.patch(self.evidence, "build", lambda value: value.update(lollySource=self.sources["lolly"], engineSource=self.engine_source))
        self.patch(self.evidence, "webGate", lambda value: value.update(source=self.sources["lolly"]))
        for key in ("inspection", "workArtifact", "workArtifactMetadata", "expectedWorkImage"):
            del self.evidence[key]
        self.update_classification()
        self.result, self.inputs = self.prepare()

    def update_classification(self):
        command = [NODE, str(Path(__file__).parents[1] / "scripts/classify-application-release.ts"), "--repo", str(self.roots["lolly"]), "--base", self.engine_source, "--candidate", self.sources["lolly"]]
        result = subprocess.run(command, capture_output=True, check=True)
        self.evidence["classification"] = self.file("actual-local-classifier-on-synthetic-fixture", json.loads(result.stdout))

    def prepare(self):
        if getattr(self, "preparing_parent", False):
            return fixture.m.prepare(self.evidence, self.base, self.public_pin_sha, NODE)
        return m.prepare(self.evidence, self.base, self.public_pin_sha, NODE)

    def rejected(self):
        with self.assertRaises((m.Refusal, OSError, ValueError, KeyError, TypeError)):
            self.prepare()

    def mutate_source(self, path):
        self.put(self.roots["lolly"], path, b"changed protected content")
        self.sources["lolly"] = self.commit(self.roots["lolly"])
        self.evidence["lolly"]["source"] = self.sources["lolly"]
        for key in ("main", "ciRun", "ciJobs"):
            def change(value, key=key):
                if key == "main": value["object"]["sha"] = self.sources["lolly"]
                elif key == "ciRun": value["head_sha"] = self.sources["lolly"]
                else:
                    for job in value["jobs"]: job["head_sha"] = self.sources["lolly"]
            self.patch(self.evidence["lolly"], key, change)

    def test_shell_new_source_retains_engine_pack_image_and_only_three_selected_leaves(self):
        self.assertEqual(self.result["sources"]["engine"], self.engine_source)
        self.assertNotEqual(self.result["sources"]["lolly"], self.engine_source)
        self.assertEqual(self.result["image"], self.previous["image"])
        self.assertEqual(self.result["rawPack"]["manifestSha256"], self.previous["pack"]["manifestSha256"])
        replaces = [op for op in self.result["guardedPatchTemplate"] if op["op"] == "replace"]
        self.assertEqual(len(replaces), 3)
        self.assertTrue(all("image" not in op["path"] and "engine-source" not in op["path"] for op in replaces))
        self.assertFalse(self.result["qualificationBoundary"]["runtimeQualified"])
        self.inputs.unchanged()

    def test_non_shell_contract_dependency_config_lock_unknown_or_engine_changes_refuse(self):
        for path in ("engine/src/version.ts", "packages/core/src/host-v1.ts", "schemas/tool.schema.json", "packages/node-shell/src/content-roots.ts", "package-lock.json", "shells/web/vite.config.js", "profiles.json", "tools/fixture/tool.json", "unknown.ts"):
            with self.subTest(path=path):
                inventory = m.git_tree(self.roots["lolly"], self.sources["lolly"], m.git_command)
                changed = copy.deepcopy(inventory); changed[path] = ("100644", "blob", "a" * 40)
                def changed_inventory(argv, root):
                    if argv[1] == "ls-tree" and argv[4] == self.sources["lolly"]:
                        return "".join(f"{mode} {kind} {obj}\t{name}\0" for name, (mode, kind, obj) in sorted(changed.items()))
                    return m.git_command(argv, root)
                with self.assertRaises(m.Refusal):
                    # Use a controlled runner for the isolated compatibility
                    # function; all full positive fixtures use real Git.
                    m.compatibility(self.roots["lolly"], self.previous, self.sources["lolly"], json.loads((self.base / self.evidence["classification"]["path"]).read_bytes()),
                                    changed_inventory)
                self.assertNotEqual({p: x for p, x in changed.items() if not m.allowed_source(p)}, {p: x for p, x in inventory.items() if not m.allowed_source(p)})

    def test_committed_unknown_path_refuses_despite_forged_advisory(self):
        self.mutate_source("unknown.ts"); self.rejected()

    def test_dirty_source_refuses(self):
        self.put(self.roots["lolly"], "shells/web/src/untracked.ts", b"untracked")
        self.rejected()

    def test_synthetic_success_wrapper_cannot_replace_original_accepted_proof(self):
        self.patch(self.previous, "acceptance", lambda v: v.update(originalEvidence=[self.file("unknown-original", {"status": "PASS"}), self.binary("other", b"other")]))
        self.evidence["previous"] = self.file("wrong-previous", self.previous); self.rejected()

    def test_ci_gate_source_or_classifier_cross_binding_refuses(self):
        for key, change in (("webGate", lambda v: v.update(source="0" * 40)), ("classification", lambda v: v.update(base="0" * 40)), ("build", lambda v: v.update(engineSource=self.sources["lolly"]))):
            original = copy.deepcopy(self.evidence)
            self.patch(self.evidence, key, change); self.rejected(); self.evidence = original
        self.patch(self.evidence["lolly"], "ciRun", lambda v: v.update(conclusion="failure")); self.rejected()

    def test_unknown_keys_version_bool_or_active_claim_refuse(self):
        for change in (lambda v: v.update(unknown=True), lambda v: v.update(version=True), lambda v: v["selection"].update(shellClaim="old-pack")):
            original = copy.deepcopy(self.evidence); change(self.evidence); self.rejected(); self.evidence = original

    def test_static_asset_mutation_refuses_even_with_new_full_manifest(self):
        candidate = Path(self.evidence["candidateShell"]["root"])
        files = {item["path"]: (candidate / item["path"]).read_bytes() for item in json.loads((self.base / self.evidence["candidateShell"]["manifest"]["path"]).read_bytes())["files"]}
        files["external/font.woff2"] = b"changed font"
        self.evidence["candidateShell"] = self.tree("bad-static", files)
        self.evidence["shell"] = self.tree("bad-static-merged", {**files, "_app/old.js": b"old lazy chunk"})
        self.patch(self.evidence, "build", lambda v: v.update(shellManifestSha256=self.evidence["candidateShell"]["manifest"]["sha256"]))
        self.rejected()

    def test_reviewed_inputs_changing_before_publication_refuse(self):
        path = self.base / self.evidence["webGate"]["path"]; path.write_bytes(b"changed")
        with self.assertRaises(m.Refusal): self.inputs.unchanged()

    def test_cli_exclusive_output_and_review_hash(self):
        ref = self.file("cli-envelope", self.evidence); out = self.base / "cli-out"
        command = ["python3", *(["-O"] if sys.flags.optimize else []), "-B", str(Path(__file__).parents[1] / "scripts/prepare-private-shell.py"), "--evidence", str(self.base / ref["path"]), "--reviewed-evidence-sha256", ref["sha256"], "--existing-public-pin-sha256", self.public_pin_sha, "--node", NODE, "--out-dir", str(out)]
        result = subprocess.run(command, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((out / "shell.prepared.json").is_file())
        self.assertEqual((out / "shell.prepared.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)


def load_tests(loader, tests, pattern):
    # Avoid repeating the inherited v1 lane test list against a different API.
    return unittest.TestSuite(Shell(name) for name in Shell.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main()
