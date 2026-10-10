#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Small offline Git/OCI/tree fixtures; no production, registry or credentials."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("cohort", Path(__file__).parents[1] / "scripts/prepare-private-cohort.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NODE = os.environ.get("LOLLY_TEST_NODE", "node")


def raw(value):
    return m.canonical(value)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def tar_bytes(files):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return out.getvalue()


class Cohort(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A fresh ephemeral key exists only inside this test child, never a
        # deployment signing key or an artifact/image signing claim.
        cls.crypto = subprocess.run([NODE, "-e", "const c=require('node:crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});console.log(JSON.stringify({public:k.publicKey.export({format:'jwk'}),private:k.privateKey.export({format:'jwk'})}));"], capture_output=True, check=True)
        cls.keys = json.loads(cls.crypto.stdout)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lolly-private-cohort-test-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.serial = 0
        self.roots = {name: self.base / name for name in ("lolly", "work")}
        self.sources = {}
        self.old_lolly, self.old_work = "d" * 40, "e" * 40
        lolly = self.roots["lolly"]
        self.init(lolly)
        self.put(lolly, "engine/src/fixture.ts", b"export const ENGINE_VERSION = '1.248.0';\n")
        self.put(lolly, "schemas/fixture.json", b'{"type":"object"}\n')
        self.put(lolly, "packages/node-shell/src/content-roots.ts", b"export const roots = [];\n")
        self.put(lolly, "packages/node-shell/src/repo-root.ts", b"export const root = '.';\n")
        self.put(lolly, "LICENSE", b"MPL-2.0\n")
        self.put(lolly, "scripts/webgpu-release-gate.ts", b"// Fixture gate, not runtime qualification\n")
        self.brand = "f" * 40
        self.git(lolly, "update-index", "--add", "--cacheinfo", "160000," + self.brand + ",brands/private")
        self.sources["lolly"] = self.commit(lolly)
        work = self.roots["work"]
        self.init(work)
        self.binary_payload = b"\x00asm\x01\x00\x00\x00\xff\xfe\x80"
        packages = {"engine": {"package.json": raw({"name": "@lolly/engine", "version": "1.248.0"}), "src/fixture.ts": (lolly / "engine/src/fixture.ts").read_bytes(), "src/fixture.wasm": self.binary_payload},
                    "core": {"package.json": raw({"name": "@lolly-tools/core", "version": "1.1.0"})}}
        self.pin = {"generatedFrom": self.sources["lolly"], "note": "fixture pin", "schemas": {"fixture.json": sha((lolly / "schemas/fixture.json").read_bytes())}}
        for name, files in packages.items():
            h = hashlib.sha256()
            prefix = "vendor/@lolly/engine" if name == "engine" else "vendor/@lolly-tools/core"
            for path, data in sorted(files.items()):
                self.put(work, prefix + "/" + path, data)
                h.update(path.encode() + b"\0" + data + b"\0")
            self.pin[name] = {"version": json.loads(files["package.json"])["version"], "contentHash": h.hexdigest(), "tarball": name + ".tgz", "tarballSha256": "c" * 64}
        self.put(work, "vendor/@lolly/schemas/fixture.json", (lolly / "schemas/fixture.json").read_bytes())
        self.resolver = {"repository": "https://github.com/fixture/lolly", "commit": self.sources["lolly"], "files": {}}
        for path in ("packages/node-shell/src/content-roots.ts", "packages/node-shell/src/repo-root.ts", "LICENSE"):
            name, data = path.split("/")[-1], (lolly / path).read_bytes()
            self.resolver["files"][name] = {"source": path, "checksum": sha(data)}
            self.put(work, "vendor/@lolly/content-resolver/" + name, data)
        self.put(work, "engine-pin.json", raw(self.pin))
        self.put(work, "content-resolver-pin.json", raw(self.resolver))
        self.git(work, "update-index", "--add", "--cacheinfo", "160000," + self.sources["lolly"] + ",vendor/lolly")
        self.sources["work"] = self.commit(work)
        self.runs = {}
        self.evidence = {"version": 1}
        for name in ("lolly", "work"):
            run = self.ci_run(10 if name == "work" else 20, name)
            self.runs[name] = run
            names = m.WORK_JOBS if name == "work" else m.LOLLY_JOBS
            self.evidence[name] = {"root": str(self.roots[name]), "source": self.sources[name], "repository": "fixture/" + name,
                                    "main": self.file(name + "-main", {"ref": "refs/heads/main", "object": {"type": "commit", "sha": self.sources[name]}}),
                                    "ciRun": self.file(name + "-run", run), "ciJobs": self.file(name + "-jobs", {"total_count": len(names), "jobs": [{"id": i + 1, "run_id": run["id"], "run_attempt": 1, "head_sha": self.sources[name], "name": item, "status": "completed", "conclusion": "success"} for i, item in enumerate(names)]})}
        self.evidence["enginePin"] = self.file("pin", self.pin)
        self.evidence["resolverPin"] = self.file("resolver", self.resolver)
        self.evidence["brand"] = {"path": "brands/private", "commit": self.brand}
        self.evidence["profile"] = "private"
        self.evidence["publicPin"] = self.file("public-pin", self.keys["public"])
        self.public_pin_sha = m.digest(self.keys["public"])
        index = raw({"version": 1, "tools": [{"id": "fixture"}]})
        tool = raw({"id": "fixture", "engineVersion": "1.248.0"})
        unsigned = {"alg": "ECDSA-P256-SHA256", "keyId": __import__("base64").urlsafe_b64encode(hashlib.sha256(raw(self.keys["public"])).digest()).decode().rstrip("="),
                    "signedAt": "2026-10-09T00:00:00Z", "indexHash": sha(index), "files": {"fixture/tool.json": sha(tool)}}
        signing = subprocess.run([NODE, "-e", "const c=require('node:crypto');let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const v=JSON.parse(d);const key=c.createPrivateKey({key:v.key,format:'jwk'});process.stdout.write(c.sign('sha256',Buffer.from(v.payload,'base64'),{key,dsaEncoding:'ieee-p1363'}).toString('base64url'));});"],
                                 input=raw({"key": self.keys["private"], "payload": __import__("base64").b64encode(raw(unsigned)).decode()}), capture_output=True, check=True)
        self.envelope = {**unsigned, "signature": signing.stdout.decode()}
        common = {"index.html": b"<title>Private fixture</title>", "_app/new.js": b"new source", "catalog/tools/index.json": index, "catalog/tools/fixture/tool.json": tool,
                  "catalog/tools/index.sig.json": raw(self.envelope), "external/font.woff2": b"reviewed external closure"}
        previous = {"index.html": b"previous index", "_app/old.js": b"previous lazy chunk", "old-non-app.txt": b"must not retain"}
        stamp = {"version": 1, "source": "lolly", "commit": self.sources["lolly"], "profile": "private", "dirty": False,
                 "excluded": ["catalog/og", "catalog/previews"], "removed": ["catalog/tools/index.sig.json"], "builtAt": "2026-10-09T00:00:00Z"}
        self.evidence["candidateShell"] = self.tree("candidate", common)
        self.evidence["previousShell"] = self.tree("previous", previous)
        self.evidence["shell"] = self.tree("prepared", {**common, "_app/old.js": previous["_app/old.js"]})
        self.evidence["rawPack"] = self.tree("raw", {"catalog/tools/index.json": index, "catalog/tools/fixture/tool.json": tool, ".lolly-pack-source.json": raw(stamp)})
        build = {"version": 1, "status": "PRIVATE_WEB_BUILD_REVIEWED", "lollySource": self.sources["lolly"], "workSource": self.sources["work"], "brandCommit": self.brand, "profile": "private",
                 "enginePinSha256": self.evidence["enginePin"]["sha256"], "shellManifestSha256": self.evidence["candidateShell"]["manifest"]["sha256"],
                 "settings": {"scope": "web", "requireCatalogSignature": True, "requireAiPolicy": True, "relayOrigin": "https://private.example/live"},
                 "workspaceModules": [{"path": "engine/src/fixture.ts", "sha256": sha((lolly / "engine/src/fixture.ts").read_bytes())}], "originalReport": self.binary("module-report", b"Original reviewed compiler/module report")}
        self.evidence["build"] = self.file("build", build)
        self.evidence["webGate"] = self.file("gate", {"version": 1, "status": "PASS", "source": self.sources["lolly"], "scope": "web",
                                                      "scriptSha256": sha((lolly / "scripts/webgpu-release-gate.ts").read_bytes()), "originalReport": self.binary("gate-original", b"Original explicit --scope web report")})
        report = {"version": 1, "engine": "1.248.0", "compatible": True, "source": "mounted", "revision": "a" * 64, "diagnostics": [],
                  "tools": [{"id": "fixture", "source": "mounted", "valid": True, "serverFormats": ["svg"], "unavailableFormats": [], "diagnostics": [], "sourceHash": "b" * 64}]}
        self.evidence["inspection"] = self.file("inspection", {"version": 1, "lollySource": self.sources["lolly"], "workSource": self.sources["work"], "enginePinSha256": self.evidence["enginePin"]["sha256"],
                                                               "packManifestSha256": self.evidence["rawPack"]["manifest"]["sha256"], "report": self.file("pack-report", report)})
        self.artifact()
        self.before = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "work", "namespace": "private", "uid": "deployment-uid", "resourceVersion": "77"},
                       "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app": "work"}}, "template": {"metadata": {"labels": {"app": "work"}, "annotations": {"lolly.tools/engine-source": self.old_lolly, "lolly.tools/shell-source": self.old_lolly, "keep": "unchanged"}},
                                "spec": {"serviceAccountName": "work", "automountServiceAccountToken": False, "containers": [{"name": "server", "image": "registry.example/work@sha256:" + "6" * 64,
                                "env": [{"name": "LW_DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "pg", "key": "url"}}}], "securityContext": {"runAsNonRoot": True, "runAsUser": 1000},
                                "volumeMounts": [{"name": n, "mountPath": p, "readOnly": True} for n, p in (("shell", "/app/shell"), ("pack", "/app/pack"), ("pin", "/app/engine-pin.json"))]}],
                                "volumes": [{"name": "shell", "persistentVolumeClaim": {"claimName": "old-shell"}}, {"name": "pack", "persistentVolumeClaim": {"claimName": "old-pack"}}, {"name": "pin", "configMap": {"name": "old-pin"}}]}}}}
        old_pin = {**self.pin, "generatedFrom": self.old_lolly}
        previous_tree = m.Tree(self.evidence["previousShell"], m.Inputs(self.base))
        self.previous = {"version": 1, "deployment": self.file("before", self.before), "deploymentSpecSha256": m.digest(self.before["spec"]), "lollySource": self.old_lolly, "workSource": self.old_work,
                         "image": self.before["spec"]["template"]["spec"]["containers"][0]["image"], "enginePin": self.file("old-pin", old_pin),
                         "shell": {"name": "old-shell", "uid": "old-shell-uid", "manifestSha256": previous_tree.manifest_sha, "releaseId": previous_tree.shell_id},
                         "pack": {"name": "old-pack", "uid": "old-pack-uid", "manifestSha256": "8" * 64}, "pin": {"name": "old-pin", "uid": "old-pin-uid", "sha256": self.file("old-pin-copy", old_pin)["sha256"]}}
        acceptance = {"version": 1, "status": "RUNTIME_ACCEPTED", "deploymentUID": "deployment-uid", "deploymentSpecSha256": self.previous["deploymentSpecSha256"], "lollySource": self.old_lolly, "workSource": self.old_work,
                      "image": self.previous["image"], "enginePinSha256": self.previous["pin"]["sha256"], "shellManifestSha256": previous_tree.manifest_sha, "packManifestSha256": "8" * 64,
                      "originalEvidence": [self.binary("old-runtime", b"original owning runtime acceptance"), self.binary("old-https", b"original verified TLS acceptance")]}
        self.previous["acceptance"] = self.file("old-acceptance", acceptance)
        self.evidence["previous"] = self.file("previous-cohort", self.previous)
        self.evidence["selection"] = {"container": "server", "shellVolume": "shell", "packVolume": "pack", "pinVolume": "pin", "shellClaim": "new-shell", "packClaim": "new-pack", "pinConfigMap": "new-pin",
                                      "provenance": {"lolly.tools/engine-source": self.sources["lolly"], "lolly.tools/shell-source": self.sources["lolly"]}}

        self.baseline_result, self.baseline_inputs = self.prepare()

    def git(self, root, *args):
        return subprocess.run(["git", *args], cwd=root, capture_output=True, check=True, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"}).stdout.decode().strip()

    def init(self, root):
        root.mkdir(); self.git(root, "init", "-b", "main"); self.git(root, "config", "user.name", "Offline Fixture"); self.git(root, "config", "user.email", "fixture@example.invalid")

    def commit(self, root):
        self.git(root, "add", ".")
        if root.name == "lolly":
            self.git(root, "update-index", "--add", "--cacheinfo", "160000," + self.brand + ",brands/private")
        else:
            self.git(root, "update-index", "--add", "--cacheinfo", "160000," + self.sources["lolly"] + ",vendor/lolly")
        (root / ("brands/private" if root.name == "lolly" else "vendor/lolly")).mkdir(parents=True, exist_ok=True)
        self.git(root, "commit", "-m", "offline fixture")
        return self.git(root, "rev-parse", "HEAD")

    def put(self, root, path, data):
        p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)

    def binary(self, name, data):
        self.serial += 1; path = self.base / f"{name}-{self.serial}.json"; path.write_bytes(data); path.chmod(0o600)
        return {"path": path.name, "sha256": sha(data)}

    def file(self, name, value):
        return self.binary(name, raw(value))

    def patch(self, parent, key, change):
        item = json.loads((self.base / parent[key]["path"]).read_bytes()); change(item); parent[key] = self.file("changed", item)

    def tree(self, name, files):
        root = self.base / (name + "-tree"); root.mkdir()
        for path, data in files.items(): self.put(root, path, data)
        entries = [{"path": path, "size": len(data), "sha256": sha(data)} for path, data in sorted(files.items())]
        return {"root": str(root), "manifest": self.file(name + "-manifest", {"version": 1, "files": entries, "totalBytes": sum(e["size"] for e in entries)})}

    def artifact(self):
        layer = tar_bytes({"app/engine-pin.json": raw(self.pin)})
        config = raw({"os": "linux", "architecture": "amd64", "config": {"Labels": {"org.opencontainers.image.revision": self.sources["work"]}}, "rootfs": {"type": "layers", "diff_ids": ["sha256:" + sha(layer)]}})
        def desc(data): return {"digest": "sha256:" + sha(data), "size": len(data)}
        manifest = raw({"schemaVersion": 2, "config": desc(config), "layers": [desc(layer)]})
        oci = tar_bytes({"oci-layout": raw({"imageLayoutVersion": "1.0.0"}), "index.json": raw({"schemaVersion": 2, "manifests": [desc(manifest)]}), "blobs/sha256/" + sha(manifest): manifest, "blobs/sha256/" + sha(config): config, "blobs/sha256/" + sha(layer): layer})
        image = {"Id": "sha256:" + sha(config), "Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": self.sources["work"]}}}
        path = self.base / "server.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("server.oci.tar", oci); archive.writestr("server.oci.tar.sha256", sha(oci) + "  server.oci.tar\n"); archive.writestr("server-image.json", raw(image))
        self.evidence["workArtifact"] = {"path": path.name, "sha256": sha(path.read_bytes())}
        self.evidence["workArtifactMetadata"] = self.file("artifact", {"id": 99, "name": "qualified-server-" + self.sources["work"], "size_in_bytes": path.stat().st_size, "expired": False, "digest": "sha256:" + sha(path.read_bytes()),
                                                                         "workflow_run": {"id": self.runs["work"]["id"], "repository_id": 42, "head_repository_id": 42, "head_branch": "main", "head_sha": self.sources["work"]}})
        self.evidence["expectedWorkImage"] = "registry.example/work@sha256:" + sha(manifest)

    def ci_run(self, number, name):
        return {"id": number, "run_attempt": 1, "head_sha": self.sources[name], "head_branch": "main", "repository": {"full_name": "fixture/" + name, "id": 42}, "head_repository": {"full_name": "fixture/" + name, "id": 42},
                "path": ".github/workflows/ci.yml", "event": "push", "status": "completed", "conclusion": "success"}

    def prepare(self):
        return m.prepare(self.evidence, self.base, self.public_pin_sha, NODE)

    def refused(self):
        with self.assertRaises((m.Refusal, OSError, ValueError, KeyError, TypeError)):
            self.prepare()

    def test_matched_cohort_preserves_all_nonselected_fields_and_has_no_apply_authority(self):
        result, inputs = self.prepare()
        self.assertEqual(result["status"], m.STATUS)
        self.assertTrue(result["allUnselectedSpecFieldsPreserved"])
        self.assertFalse(result["qualificationBoundary"]["runtimeQualified"])
        self.assertFalse(result["qualificationBoundary"]["ociSignatureClaimed"])
        self.assertFalse(result["qualificationBoundary"]["originAuthenticatedByThisCommand"])
        self.assertEqual(result["desiredSpec"]["template"]["spec"]["containers"][0]["env"], self.before["spec"]["template"]["spec"]["containers"][0]["env"])
        self.assertEqual(result["guardedPatchTemplate"][2], {"op": "test", "path": "/spec", "value": self.before["spec"]})
        out = self.base / "new-output"; m.publish(result, out, inputs)
        self.assertEqual((out / "cohort.prepared.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("kubectl", (out / "cohort.prepared.json").read_text())

    def test_committed_non_utf8_vendor_bytes_preserve_exact_content_hash(self):
        root, source = self.roots["work"], self.sources["work"]
        actual = m.git_bytes(root, source, "vendor/@lolly/engine/src/fixture.wasm", m.git_command)
        self.assertEqual(actual, self.binary_payload)
        with self.assertRaises(UnicodeDecodeError):
            actual.decode("utf-8")
        files = self.git(root, "ls-tree", "-r", "--name-only", source, "--", "vendor/@lolly/engine").splitlines()
        expected = hashlib.sha256()
        for path in sorted(files):
            relative = path.removeprefix("vendor/@lolly/engine/")
            data = subprocess.run(["git", "show", f"{source}:{path}"], cwd=root, capture_output=True, check=True).stdout
            expected.update(relative.encode() + b"\0" + data + b"\0")
        self.assertEqual(expected.hexdigest(), self.pin["engine"]["contentHash"])
        m.source_pins(self.pin, self.resolver, self.evidence["lolly"], self.evidence["work"], m.git_command)
        wrong = copy.deepcopy(self.pin)
        wrong["engine"]["contentHash"] = "0" * 64
        with self.assertRaisesRegex(m.Refusal, "Actual vendored package"):
            m.source_pins(wrong, self.resolver, self.evidence["lolly"], self.evidence["work"], m.git_command)

    def test_two_or_invalid_replicas_refuse_existing_single_owner_claim(self):
        for replicas in (2, 0, True, False, "1", 1.0):
            before = copy.deepcopy(self.before)
            before["spec"]["replicas"] = replicas
            with self.assertRaisesRegex(m.Refusal, "single-owner"):
                m.change_tuple(before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])

    def test_default_one_replica_accepts_without_inserting_a_new_spec_field(self):
        before = copy.deepcopy(self.before)
        before["spec"].pop("replicas")
        desired, _, _ = m.change_tuple(before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])
        self.assertNotIn("replicas", desired)

    def test_unknown_qualified_boolean_is_not_evidence(self):
        self.evidence["qualified"] = True; self.refused()

    def test_dirty_source_refuses(self):
        self.put(self.roots["lolly"], "engine/src/fixture.ts", b"dirty"); self.refused()

    def test_stale_main_and_wrong_ci_source_refuse(self):
        self.patch(self.evidence["lolly"], "main", lambda v: v["object"].update({"sha": "0" * 40})); self.refused()

    def test_missing_failed_duplicate_and_wrong_attempt_ci_jobs_refuse(self):
        original = copy.deepcopy(self.evidence["work"]["ciJobs"])
        for change in (lambda v: v["jobs"].pop(), lambda v: v["jobs"][0].update({"conclusion": "failure"}), lambda v: v["jobs"][1].update({"name": v["jobs"][0]["name"]}), lambda v: v["jobs"][0].update({"run_attempt": 2})):
            self.evidence["work"]["ciJobs"] = copy.deepcopy(original); self.patch(self.evidence["work"], "ciJobs", change); self.refused()

    def test_bool_ci_attempt_refuses(self):
        self.patch(self.evidence["work"], "ciRun", lambda v: v.update({"run_attempt": True})); self.refused()

    def test_same_version_stale_engine_content_refuses(self):
        self.patch(self.evidence, "enginePin", lambda v: v["engine"].update({"contentHash": "0" * 64})); self.refused()

    def test_changed_resolver_pin_refuses(self):
        self.patch(self.evidence, "resolverPin", lambda v: v.update({"commit": "0" * 40})); self.refused()

    def test_wrong_brand_and_public_profile_refuse(self):
        self.evidence["brand"]["commit"] = "0" * 40; self.refused()
        self.evidence["brand"]["commit"] = self.brand; self.evidence["profile"] = "community"; self.refused()

    def test_private_key_and_wrong_public_pin_refuse(self):
        original = self.evidence["publicPin"]
        self.evidence["publicPin"] = self.file("private-key-rejected", self.keys["private"]); self.refused()
        self.evidence["publicPin"] = original; self.public_pin_sha = "0" * 64; self.refused()

    def test_changed_catalog_signature_even_with_reviewed_tree_hash_refuses(self):
        changed = copy.deepcopy(self.envelope); changed["signature"] = "A" * 86
        for name in ("candidateShell", "shell"):
            root = Path(self.evidence[name]["root"]); (root / "catalog/tools/index.sig.json").write_bytes(raw(changed))
            self.patch(self.evidence[name], "manifest", lambda v: self.adjust_manifest(v, "catalog/tools/index.sig.json", raw(changed)))
        self.refused()

    @staticmethod
    def adjust_manifest(value, path, data):
        item = next(item for item in value["files"] if item["path"] == path)
        value["totalBytes"] += len(data) - item["size"]; item.update({"size": len(data), "sha256": sha(data)})

    def test_missing_extra_duplicate_wrong_hash_and_traversal_tree_entries_refuse(self):
        original = copy.deepcopy(self.evidence["rawPack"]["manifest"])
        for change in (lambda v: v["files"].pop(), lambda v: v["files"].append(copy.deepcopy(v["files"][0])), lambda v: v["files"][0].update({"sha256": "0" * 64}), lambda v: v["files"][0].update({"path": "../escape"})):
            self.evidence["rawPack"]["manifest"] = copy.deepcopy(original); self.patch(self.evidence["rawPack"], "manifest", change); self.refused()
        self.evidence["rawPack"]["manifest"] = original; self.put(Path(self.evidence["rawPack"]["root"]), "unlisted", b"extra"); self.refused()

    def test_symlink_and_special_tree_files_refuse(self):
        root = Path(self.evidence["rawPack"]["root"]); file = root / "catalog/tools/fixture/tool.json"; file.unlink(); file.symlink_to(root / "catalog/tools/index.json"); self.refused()
        file.unlink(); os.mkfifo(file); self.refused()

    def test_unsafe_symlink_evidence_parent_refuses(self):
        link = self.base / "link"; link.symlink_to(self.base, target_is_directory=True)
        self.evidence["enginePin"]["path"] = str(link / self.evidence["enginePin"]["path"]); self.refused()

    def test_previous_nonapp_content_not_retained_and_collision_refuses(self):
        self.put(Path(self.evidence["shell"]["root"]), "old-non-app.txt", b"must not retain"); self.refused()

    def test_current_index_cannot_be_replaced_with_previous(self):
        (Path(self.evidence["shell"]["root"]) / "index.html").write_bytes(b"previous index"); self.refused()

    def test_prior_app_lazy_files_must_be_present(self):
        (Path(self.evidence["shell"]["root"]) / "_app/old.js").unlink(); self.refused()

    def test_raw_build_time_signature_refuses(self):
        self.put(Path(self.evidence["rawPack"]["root"]), "catalog/tools/index.sig.json", raw(self.envelope)); self.refused()

    def test_build_workspace_stale_module_and_wrong_settings_refuse(self):
        original = copy.deepcopy(self.evidence["build"])
        for change in (lambda v: v["workspaceModules"][0].update({"sha256": "0" * 64}), lambda v: v["settings"].update({"scope": "all"}), lambda v: v.update({"lollySource": self.old_lolly}), lambda v: v["settings"].update({"relayOrigin": "https://user:secret@example/live"})):
            self.evidence["build"] = copy.deepcopy(original); self.patch(self.evidence, "build", change); self.refused()

    def test_native_or_failed_gate_refuses(self):
        self.patch(self.evidence, "webGate", lambda v: v.update({"scope": "native"})); self.refused()

    def test_pack_inspection_bound_to_full_manifest_and_exact_pin(self):
        self.patch(self.evidence, "inspection", lambda v: v.update({"enginePinSha256": "0" * 64})); self.refused()

    def test_materialized_inspection_identity_is_independent_of_private_profile(self):
        inspection = json.loads((self.base / self.evidence["inspection"]["path"]).read_bytes())
        report_path = self.base / inspection["report"]["path"]
        original = report_path.read_bytes()
        report = json.loads(original)
        self.assertEqual(self.evidence["profile"], "private")
        self.assertEqual(report["source"], "mounted")
        self.assertTrue(all(tool["source"] == "mounted" for tool in report["tools"]))
        result, inputs = self.prepare()
        self.assertEqual(result["profile"], "private")
        self.assertFalse(result["qualificationBoundary"]["runtimeQualified"])
        self.assertEqual(report_path.read_bytes(), original)
        inputs.unchanged()

    def test_materialized_inspector_refuses_profile_and_missing_source_ids(self):
        original = self.evidence["inspection"]
        for source in (None, "suse", "profile:suse", "private", ""):
            with self.subTest(source=source):
                self.evidence["inspection"] = original
                inspection = json.loads((self.base / original["path"]).read_bytes())
                self.patch(inspection, "report", lambda v: v.update({"source": source}))
                self.evidence["inspection"] = self.file("wrong-source-inspection", inspection)
                with self.assertRaisesRegex(m.Refusal, "Pack is not compatible"):
                    self.prepare()

    def test_materialized_inspector_refuses_mixed_tool_source_ids(self):
        inspection = json.loads((self.base / self.evidence["inspection"]["path"]).read_bytes())
        self.patch(inspection, "report", lambda v: v["tools"][0].update({"source": "suse"}))
        self.evidence["inspection"] = self.file("mixed-source-inspection", inspection)
        with self.assertRaisesRegex(m.Refusal, "Pack tool inspection is incomplete"):
            self.prepare()

    def test_mounted_inspector_does_not_waive_raw_profile_binding(self):
        root = Path(self.evidence["rawPack"]["root"])
        path = root / ".lolly-pack-source.json"
        value = json.loads(path.read_bytes()); value["profile"] = "suse"
        changed = raw(value); path.write_bytes(changed)
        self.patch(self.evidence["rawPack"], "manifest", lambda v: self.adjust_manifest(v, ".lolly-pack-source.json", changed))
        with self.assertRaisesRegex(m.Refusal, "Raw pack source stamp differs"):
            self.prepare()

    def test_mounted_inspector_does_not_waive_exact_engine(self):
        inspection = json.loads((self.base / self.evidence["inspection"]["path"]).read_bytes())
        self.patch(inspection, "report", lambda v: v.update({"engine": "1.247.0"}))
        self.evidence["inspection"] = self.file("wrong-engine-inspection", inspection)
        with self.assertRaisesRegex(m.Refusal, "Pack is not compatible"):
            self.prepare()

    def test_mounted_inspector_does_not_waive_report_or_tool_hashes(self):
        original = self.evidence["inspection"]
        inspection = json.loads((self.base / original["path"]).read_bytes())
        inspection["report"]["sha256"] = "0" * 64
        self.evidence["inspection"] = self.file("wrong-report-hash", inspection)
        with self.assertRaisesRegex(m.Refusal, "Evidence bytes differ from review"):
            self.prepare()
        inspection = json.loads((self.base / original["path"]).read_bytes())
        self.patch(inspection, "report", lambda v: v["tools"][0].update({"sourceHash": "invalid"}))
        self.evidence["inspection"] = self.file("wrong-tool-hash", inspection)
        with self.assertRaisesRegex(m.Refusal, "Invalid SHA256 binding"):
            self.prepare()

    def test_wrong_artifact_digest_and_mutable_image_refuse(self):
        self.patch(self.evidence, "workArtifactMetadata", lambda v: v.update({"digest": "sha256:" + "0" * 64})); self.refused()

    def test_mutable_image_refuses(self):
        self.evidence["expectedWorkImage"] = "registry.example/work:latest"; self.refused()

    def test_previous_acceptance_must_bind_actual_spec_and_manifests(self):
        self.patch(self.previous, "acceptance", lambda v: v.update({"shellManifestSha256": "0" * 64})); self.evidence["previous"] = self.file("previous-bad", self.previous); self.refused()

    def test_missing_original_previous_acceptance_is_not_qualified_boolean(self):
        self.patch(self.previous, "acceptance", lambda v: v.update({"originalEvidence": []})); self.evidence["previous"] = self.file("previous-bad", self.previous); self.refused()

    def test_active_claims_or_ambiguous_selectors_refuse(self):
        self.evidence["selection"]["shellClaim"] = "old-shell"; self.refused()
        self.evidence["selection"]["shellClaim"] = "new-shell"; self.evidence["selection"]["shellVolume"] = "pack"; self.refused()

    def test_writable_serving_mount_refuses(self):
        self.before["spec"]["template"]["spec"]["containers"][0]["volumeMounts"][0]["readOnly"] = False
        with self.assertRaises(m.Refusal): m.change_tuple(self.before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])

    def test_duplicate_volume_and_container_refuse(self):
        pod = self.before["spec"]["template"]["spec"]
        pod["volumes"].append(copy.deepcopy(pod["volumes"][0]))
        with self.assertRaises(m.Refusal): m.change_tuple(self.before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])

    def test_unknown_provenance_or_absent_annotation_refuse(self):
        self.evidence["selection"]["provenance"]["arbitrary/security"] = "unsafe"; self.refused()

    def test_selected_change_proof_preserves_security_storage_and_secrets(self):
        wanted, patch, inverse = m.change_tuple(self.before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])
        self.assertEqual(wanted["template"]["spec"]["automountServiceAccountToken"], False)
        self.assertEqual(len([p for p in patch if p["op"] == "replace"]), 6)
        self.assertEqual(len(inverse["fields"]), 6)
        self.assertEqual(self.before["spec"]["template"]["spec"]["containers"][0]["image"], self.previous["image"])

    def test_input_changed_after_validation_and_existing_output_refuse(self):
        result, inputs = self.prepare()
        out = self.base / "exists"; out.mkdir()
        with self.assertRaises(m.Refusal): m.publish(result, out, inputs)
        (Path(self.evidence["rawPack"]["root"]) / ".lolly-pack-source.json").write_bytes(b"changed")
        with self.assertRaises(m.Refusal): m.publish(result, self.base / "not-created", inputs)
        self.assertFalse((self.base / "not-created").exists())

    def test_output_input_overlap_refuses(self):
        result, inputs = self.prepare()
        with self.assertRaises(m.Refusal): m.publish(result, Path(self.evidence["shell"]["root"]) / "output", inputs)

    def test_output_inside_source_checkout_refuses(self):
        result, inputs = self.prepare()
        with self.assertRaises(m.Refusal):
            m.publish(result, self.roots["work"] / "output", inputs)
        self.assertFalse((self.roots["work"] / "output").exists())

    def test_source_changes_after_prepare_refuse_publication(self):
        result, inputs = self.prepare()
        self.put(self.roots["lolly"], "engine/src/fixture.ts", b"changed after preparation")
        with self.assertRaises(m.Refusal):
            m.publish(result, self.base / "no-output", inputs)
        self.assertFalse((self.base / "no-output").exists())

    def test_selected_content_cannot_have_another_app_or_init_owner(self):
        for family in ("containers", "initContainers"):
            before = copy.deepcopy(self.before)
            before["spec"]["template"]["spec"].setdefault(family, []).append({"name": "second", "image": "unrelated", "volumeMounts": [{"name": "shell", "readOnly": True}]})
            with self.assertRaisesRegex(m.Refusal, "one serving owner"):
                m.change_tuple(before, self.previous, self.evidence["selection"], self.evidence["expectedWorkImage"], self.sources["lolly"])

    def test_release_id_matches_maintained_directory_walk_order(self):
        tree = self.tree("order", {"index.html": b"index", "a/nested.js": b"nested", "a-file.js": b"before-slash", "z.js": b"last"})
        actual = m.Tree(tree, m.Inputs(self.base))
        maintained = Path(m.__file__).with_name("shell-release-id.ts")
        result = subprocess.run([NODE, str(maintained), tree["root"]], capture_output=True, check=True)
        self.assertEqual(actual.shell_id, result.stdout.decode().strip())

    def test_same_path_retained_app_collision_refuses(self):
        candidate = m.Tree(self.evidence["candidateShell"], m.Inputs(self.base))
        previous = m.Tree(self.evidence["previousShell"], m.Inputs(self.base))
        prepared = m.Tree(self.evidence["shell"], m.Inputs(self.base))
        previous.files["_app/new.js"] = {"path": "_app/new.js", "size": 7, "sha256": "0" * 64}
        with self.assertRaisesRegex(m.Refusal, "different bytes"):
            m.retention(candidate, previous, prepared)

    def test_wrong_pack_stamp_even_with_full_reviewed_manifest_refuses(self):
        root = Path(self.evidence["rawPack"]["root"])
        value = json.loads((root / ".lolly-pack-source.json").read_bytes())
        value["dirty"] = True
        data = raw(value)
        (root / ".lolly-pack-source.json").write_bytes(data)
        self.patch(self.evidence["rawPack"], "manifest", lambda v: self.adjust_manifest(v, ".lolly-pack-source.json", data))
        with self.assertRaisesRegex(m.Refusal, "source stamp"):
            self.prepare()

    def test_expected_image_must_match_oci_even_if_digest_grammar_valid(self):
        self.evidence["expectedWorkImage"] = "registry.example/work@sha256:" + "0" * 64
        with self.assertRaisesRegex(m.Refusal, "verified OCI"):
            self.prepare()

    def test_unsafe_archive_member_is_not_trusted_by_metadata(self):
        path = self.base / self.evidence["workArtifact"]["path"]
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("extra-unsafe", b"extra")
        data = path.read_bytes()
        self.evidence["workArtifact"]["sha256"] = sha(data)
        self.patch(self.evidence, "workArtifactMetadata", lambda v: v.update({"size_in_bytes": len(data), "digest": "sha256:" + sha(data)}))
        with self.assertRaisesRegex(m.Refusal, "artifact members"):
            self.prepare()

    def test_explicit_guard_calls_survive_optimized_python(self):
        import ast
        tree = ast.parse(Path(m.__file__).read_text())
        self.assertFalse(any(isinstance(node, ast.Assert) for node in ast.walk(tree)))

    def test_cli_positive_creates_only_protected_advisory_output(self):
        ref = self.file("cli-valid", self.evidence)
        out = self.base / "cli-valid-output"
        result = subprocess.run([sys.executable, str(Path(m.__file__)), "--evidence", str(self.base / ref["path"]), "--reviewed-evidence-sha256", ref["sha256"], "--existing-public-pin-sha256", self.public_pin_sha, "--out-dir", str(out), "--node", NODE], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout)["status"], m.STATUS)
        self.assertEqual({p.name for p in out.iterdir()}, {"cohort.prepared.json"})
        self.assertFalse(json.loads((out / "cohort.prepared.json").read_bytes())["qualificationBoundary"]["productionMutation"])

    def test_duplicate_json_and_unknown_build_keys_refuse(self):
        with self.assertRaises(m.Refusal): m.parse_json(b'{"x":1,"x":2}')
        self.patch(self.evidence, "build", lambda v: v.update({"qualified": True})); self.refused()

    def test_cli_safe_failure_under_normal_and_optimized_python(self):
        input_ref = self.file("cli-invalid", {"version": 1, "secret": "DO_NOT_PRINT_PRIVATE_VALUE"})
        for optimize in ([], ["-O"]):
            out = self.base / ("cli-out" + str(len(optimize)))
            result = subprocess.run([sys.executable, *optimize, str(Path(m.__file__)), "--evidence", str(self.base / input_ref["path"]), "--reviewed-evidence-sha256", input_ref["sha256"], "--existing-public-pin-sha256", self.public_pin_sha, "--out-dir", str(out), "--node", NODE], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn(b"DO_NOT_PRINT_PRIVATE_VALUE", result.stderr + result.stdout)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
