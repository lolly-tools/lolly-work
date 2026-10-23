# SPDX-License-Identifier: MPL-2.0
"""Preview deploy command tests. Fakes only: no network, cluster, node or GitHub is contacted.

Unit tests cover the verifier, expectations, bindings and layout patches. The
end-to-end tests drive the real command through fake gh, ssh, k3s (kubectl,
crictl, ctr), systemctl and check-target executables (tests/preview_deploy_fakes.py).
"""
import base64
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path.insert(0, str(TESTS))
import preview_deploy_fakes as F  # noqa: E402  (puts deploy/preview/lib on sys.path)
import preview_anchors as A  # noqa: E402
import preview_common as C  # noqa: E402
import preview_expect as E  # noqa: E402
import preview_github as G  # noqa: E402
import preview_layout as L  # noqa: E402
import preview_mac as M  # noqa: E402
import preview_receipt as R  # noqa: E402
import preview_smoke as S  # noqa: E402

# Made with Lolly's own code: Node crypto.sign over engine/src/canonical-json.ts output,
# parseConnectorOrigins and configureDeploymentOrigins (see preview_deploy_fakes.NODE_VECTORS).
VECTORS = json.loads(r'''{"jwk": {"kty": "EC", "crv": "P-256", "x": "uDtQGYFOukyT1UP9SKnxDELXzl1sh4YtDjdJTJWD4iY", "y": "ZgOZUFB5SXPG16R02zBPIEgpntT74JF7ZxYRLKPwRRo"}, "canonical": "{\"files\":{\"A\\tb\\\"c\\\\\\u0001\u2028.txt\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"catalog/tools/index.sig.json\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"index.html\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"z/\u00e9t\u00e9.html\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"\ud83d\ude00/x\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\",\"\uffff\":\"0000000000000000000000000000000000000000000000000000000000000000\"},\"kind\":\"lolly-release-frontend\",\"profile\":\"lolly-demo\",\"source\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"target\":\"web\",\"version\":1}", "signature": "MEUCIQCZ400ypfgPN/ks4kJNYHSXP8zBbJX4ZpuzEaAzJQkeZQIgMPtUW2KDgU6ZbeT9AUDwNYKh8lHfEdhK8Q7yK7BpWOY=", "policy": "default-src 'self'; connect-src 'self' blob: https://lolly.ing; img-src 'self'", "origins": [{"raw": "", "parsed": [], "policy": "default-src 'self'; connect-src 'self' blob: https://lolly.ing; img-src 'self'"}, {"raw": "https://Files.Example.com:443/ https://a.example.org:8443 https://lolly.ing", "parsed": ["https://a.example.org:8443", "https://files.example.com", "https://lolly.ing"], "policy": "default-src 'self'; connect-src 'self' blob: https://lolly.ing https://a.example.org:8443 https://files.example.com; img-src 'self'"}, {"raw": "https://b.example.com  https://a.example.com", "parsed": ["https://a.example.com", "https://b.example.com"], "policy": "default-src 'self'; connect-src 'self' blob: https://lolly.ing https://a.example.com https://b.example.com; img-src 'self'"}]}''')


class Verifier(unittest.TestCase):
    def test_canonical_json_matches_lolly_byte_for_byte(self):
        self.assertEqual(C.canonical_js_json(F.NODE_VECTORS["body"]), VECTORS["canonical"])

    def test_node_signature_verifies_and_tampering_fails(self):
        message = VECTORS["canonical"].encode()
        signature = base64.b64decode(VECTORS["signature"])
        self.assertTrue(R.verify_p256(VECTORS["jwk"], message, signature))
        self.assertFalse(R.verify_p256(VECTORS["jwk"], message + b" ", signature))
        self.assertFalse(R.verify_p256(VECTORS["jwk"], message, signature[:-1] + bytes([signature[-1] ^ 1])))
        self.assertFalse(R.verify_p256(VECTORS["jwk"], message, b"\x30\x00"))
        other = dict(VECTORS["jwk"], x=VECTORS["jwk"]["y"])
        self.assertFalse(R.verify_p256(other, message, signature))  # not on the curve

    def test_anchored_release_pin_and_thumbprint_agree(self):
        R.public_point(A.RELEASE_PUBLIC_KEY_JWK)
        self.assertEqual(R.jwk_thumbprint(A.RELEASE_PUBLIC_KEY_JWK), A.RELEASE_PUBLIC_KEY_THUMBPRINT)

    def test_receipt_binds_source_profile_and_signature(self):
        key, pin = F.make_key()
        build = F.make_build(key, "a" * 40, "one")
        raw = base64.b64decode(build["receipt"])
        files = R.verify_frontend_receipt(raw, pin, "a" * 40, "web", "lolly-demo")
        self.assertIn("index.html", files)
        for source, profile, code in (("b" * 40, "lolly-demo", "RECEIPT_SOURCE"), ("a" * 40, "suse", "RECEIPT_PROFILE")):
            with self.subTest(code=code), self.assertRaises(C.Refusal) as caught:
                R.verify_frontend_receipt(raw, pin, source, "web", profile)
            self.assertEqual(caught.exception.code, code)
        tampered = json.loads(raw)
        tampered["files"]["index.html"] = "0" * 64
        with self.assertRaises(C.Refusal) as caught:
            R.verify_frontend_receipt(json.dumps(tampered).encode(), pin, "a" * 40, "web", "lolly-demo")
        self.assertEqual(caught.exception.code, "RECEIPT_SIGNATURE")
        extra = json.loads(raw)
        extra["note"] = "x"
        with self.assertRaises(C.Refusal):
            R.verify_frontend_receipt(json.dumps(extra).encode(), pin, "a" * 40, "web", "lolly-demo")
        _, stranger = F.make_key()
        with self.assertRaises(C.Refusal):
            R.verify_frontend_receipt(raw, stranger, "a" * 40, "web", "lolly-demo")

    def test_etag_is_a_map_value_never_the_body_hash_alone(self):
        files = {"index.html": "1" * 64, "index.html.gz": "2" * 64, "index.html.br": "3" * 64}
        values = R.etag_values(files)
        self.assertIn('"' + "2" * 64 + '"', values)  # the gzip validator served on the identity body
        self.assertIn('W/"' + "1" * 64 + '"', values)
        self.assertNotIn('"' + "4" * 64 + '"', values)


class Expectations(unittest.TestCase):
    def test_connector_origins_match_lolly(self):
        for case in VECTORS["origins"]:
            with self.subTest(raw=case["raw"]):
                self.assertEqual(E.parse_connector_origins(case["raw"]), case["parsed"])
                self.assertEqual(E.configure_connect_src(VECTORS["policy"], case["parsed"]), case["policy"])
        for bad in ("http://a.example.com", "https://*.sharepoint.com", "https://a.example.com/path", "https://10.0.0.1",
                    "https://a.example.com:0"):
            with self.subTest(bad=bad), self.assertRaises(C.Refusal):
                E.parse_connector_origins(bad)

    def test_headers_come_from_the_source_files_exactly(self):
        headers = dict(E.expected_headers(F.SECURITY_HEADERS, F.NGINX, F.CONNECTORS))
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("connect-src 'self' blob: https://lolly.ing https://files.example.com;", headers["Content-Security-Policy"])
        self.assertNotIn("frame-src https:", headers["Content-Security-Policy"])  # the /any-site entry is not `/`
        for broken in (F.SECURITY_HEADERS + "add_header X-Bad $other always;\n", F.SECURITY_HEADERS + "expires 1d;\n",
                       F.SECURITY_HEADERS + 'add_header Referrer-Policy "same-origin" always;\n'):
            with self.subTest(broken=broken.splitlines()[-1]), self.assertRaises(C.Refusal):
                E.expected_headers(broken, F.NGINX, "")
        with self.assertRaises(C.Refusal):
            E.expected_headers(F.SECURITY_HEADERS, "server {}", "")

    def test_models_sample_and_stored_formats(self):
        self.assertEqual(E.models_sample(F.MODELS), {"url": "/models/a/config.json", "size": 44})
        with self.assertRaises(C.Refusal):
            E.models_sample(json.dumps([{"url": "/models/../etc/passwd", "size": 3}]).encode())
        files = {path: text.encode() for path, text in F.format_files(db=27).items()}

        def read(path):
            if path not in files:
                raise C.Refusal("GITHUB_NOT_FOUND", path)
            return files[path]
        formats = E.stored_formats(read, A.STORED_FORMATS)
        self.assertEqual(formats, {"channelMessage": 2, "indexedDb": 27, "revisionArchive": 1, "session": 4})
        self.assertEqual(E.format_lowering(formats, dict(formats, indexedDb=26)), ["indexedDb:27->26"])
        self.assertEqual(E.format_lowering(formats, dict(formats, indexedDb=28)), [])
        self.assertEqual(E.format_lowering(formats, dict(formats, session=None)), ["session:unknown"])
        self.assertEqual(E.format_lowering(None, formats), ["unknown"])


class Layout(unittest.TestCase):
    ANCHORS = A.TOOLS

    def test_conversion_removes_only_the_claim_root_and_nginx_mounts(self):
        before = F.deployment("img@sha256:" + "a" * 64, converted=False)
        plan = L.conversion_plan(before, self.ANCHORS, {"lolly.tools/preview-phase": "converting"})
        after = F.apply_json_patch(before, plan["patch"])
        spec = after["spec"]["template"]["spec"]
        self.assertEqual({v["name"] for v in spec["volumes"]}, {"tmp", "models"})
        self.assertEqual(len(spec["containers"][0]["volumeMounts"]), 3)
        self.assertEqual(after["spec"]["revisionHistoryLimit"], 5)
        self.assertEqual(spec["containers"][0]["image"], before["spec"]["template"]["spec"]["containers"][0]["image"])
        self.assertEqual(after["metadata"]["annotations"]["lolly.tools/preview-phase"], "converting")
        L.guard_layout_result(before, after, 0, plan["after"])
        self.assertTrue(L.is_converted(after, 0, self.ANCHORS))
        sneaky = copy.deepcopy(after)
        sneaky["spec"]["replicas"] = 2
        with self.assertRaises(C.Refusal):
            L.guard_layout_result(before, sneaky, 0, plan["after"])
        inverse = L.inverse_conversion_patch(after, plan, {"lolly.tools/preview-layout": "claim-root"})
        restored = F.apply_json_patch(after, inverse)
        self.assertEqual(restored["spec"]["template"], before["spec"]["template"])
        self.assertEqual(restored["spec"]["revisionHistoryLimit"], 2)
        L.guard_layout_result(after, restored, 0, plan["before"])

    def test_conversion_refuses_unexpected_layouts(self):
        with self.assertRaises(C.Refusal) as caught:
            L.conversion_plan(F.deployment("img@sha256:" + "a" * 64), self.ANCHORS, {})
        self.assertEqual(caught.exception.code, "ALREADY_CONVERTED")
        extra_mount = F.deployment("img@sha256:" + "a" * 64, converted=False)
        extra_mount["spec"]["template"]["spec"]["containers"][0]["volumeMounts"].append(
            {"name": "nginx", "mountPath": "/etc/nginx/nginx.conf", "subPath": "nginx.conf"})
        sidecar = F.deployment("img@sha256:" + "a" * 64, converted=False)
        sidecar["spec"]["template"]["spec"]["containers"].append({"name": "x", "image": "y", "volumeMounts": [{"name": "public-delivery", "mountPath": "/x"}]})
        models = F.deployment("img@sha256:" + "a" * 64, converted=False)
        models["spec"]["template"]["metadata"]["annotations"]["lolly.tools/models-release"] = "models-" + "2" * 64
        for name, value in (("extra mount", extra_mount), ("sidecar", sidecar), ("models", models)):
            with self.subTest(name=name), self.assertRaises(C.Refusal):
                L.conversion_plan(value, self.ANCHORS, {})

    def test_annotation_ops_and_quantities(self):
        self.assertEqual(L.annotation_ops({}, {"a/b": "1", "c": None}), [{"op": "add", "path": "/metadata/annotations", "value": {"a/b": "1"}}])
        self.assertEqual(L.annotation_ops({"annotations": {"c": "x"}}, {"a/b": "1", "c": None}),
                         [{"op": "add", "path": "/metadata/annotations/a~1b", "value": "1"}, {"op": "remove", "path": "/metadata/annotations/c"}])
        self.assertEqual(L.parse_quantity("768Mi"), 768 * 2 ** 20)
        self.assertEqual(L.parse_quantity("1G"), 10 ** 9)
        with self.assertRaises(C.Refusal):
            L.parse_quantity("1.5Gi")


class Binding(unittest.TestCase):
    def setUp(self):
        self.key, self.pin = F.make_key()
        self.thumb = R.jwk_thumbprint(self.pin)
        self.build = F.make_build(self.key, "b" * 40, "new")
        self.run = F.run_object(77, "b" * 40)

    def read(self, run=None, **overrides):
        data = base64.b64decode(F.receipt_zip(self.build, 77, 1, self.pin, self.thumb, **overrides))
        return G.read_receipt_artifact(data, run or self.run, "b" * 40, A.TOOLS, self.pin, self.thumb)

    def test_receipt_artifact_binds_run_source_image_and_pin(self):
        self.assertEqual(self.read()["image"], self.build["image"])
        web = {"imageId": "sha256:" + "1" * 64, "digest": self.build["image"], "platform": "linux/amd64", "source": "b" * 40}
        cases = {
            "run id": {"release.json": {"source": "b" * 40, "runId": "78", "runAttempt": 1, "neutralProfile": True,
                                        "images": {"web": web}, "candidateRuntimeQualified": False}},
            "foreign image": {"web.json": dict(web, digest="ghcr.io/evil/lolly-web@sha256:" + "1" * 64)},
            "other pin": {"public.jwk.json": F.make_key()[1]},
            "unverified catalog": {"catalog.json": {"verified": False, "keyId": self.thumb, "indexSha256": "7" * 64}},
            "missing boot": {"web-boot.json": None},
            "extra file": {"extra.json": {}},
        }
        for name, override in cases.items():
            with self.subTest(name=name), self.assertRaises(C.Refusal):
                self.read(**override)

    def test_bind_run_requires_workflow_event_repository_branch_commit_success(self):
        class StubGh:
            def json(inner, path, **params):
                return {"artifacts": [{"id": 5, "name": "public-candidate-web-receipts-attempt-1", "expired": False}]}

            def binary(inner, path, limit):
                return base64.b64decode(F.receipt_zip(self.build, 77, 1, self.pin, self.thumb))
        self.assertEqual(G.bind_run(StubGh(), A.TOOLS, self.run, "b" * 40, self.pin, self.thumb)["run"], 77)
        for field, value in (("path", ".github/workflows/evil.yml"), ("event", "push"), ("head_branch", "preview"),
                             ("head_sha", "c" * 40), ("conclusion", "failure"),
                             ("head_repository", {"full_name": "fork/lolly"})):
            run = dict(self.run, **{field: value})
            with self.subTest(field=field), self.assertRaises(C.Refusal):
                G.bind_run(StubGh(), A.TOOLS, run, "b" * 40, self.pin, self.thumb)

    def test_dispatch_request_matches_the_retired_bot(self):
        class Recorder:
            posted = None

            def post(inner, path, body):
                Recorder.posted = (path, body)
        G.dispatch_build(Recorder(), A.TOOLS, "b" * 40, 900, self.pin)
        path, body = Recorder.posted
        self.assertEqual(path, "repos/lolly-tools/lolly/actions/workflows/deployment-suse.yml/dispatches")
        self.assertEqual(body["ref"], "main")
        self.assertEqual({k: v for k, v in body["inputs"].items() if k != "public_key_jwk"},
                         {"build_images": "true", "release_scope": "web", "expected_source": "b" * 40, "ci_run": "900"})
        self.assertEqual(json.loads(body["inputs"]["public_key_jwk"]), self.pin)


class Smoke(unittest.TestCase):
    def setUp(self):
        self.key, self.pin = F.make_key()
        self.build = F.make_build(self.key, "b" * 40, "new")
        state = F.cluster_state({"new": self.build}, self.build)
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state.json"
        self.state.write_text(json.dumps(state))
        self.fetch = F.make_fetch(str(self.state))

    def tearDown(self):
        self.tmp.cleanup()

    def run_smoke(self, fetch):
        with mock.patch.object(S, "FETCH", fetch):
            return S.smoke(F.expect_for(self.build), A.TOOLS, self.pin, pod_check=lambda memory: (True, "ok"))

    def test_good_site_passes(self):
        checks, files = self.run_smoke(self.fetch)
        self.assertTrue(checks.ok, checks.failures())
        self.assertIn("index.html", files)

    def test_header_drift_suse_ids_and_bad_etag_fail(self):
        def drift(url, **kwargs):
            response = self.fetch(url, **kwargs)
            response.headers = [(n, v + " https://*.sharepoint.com" if n == "Content-Security-Policy" else v) for n, v in response.headers]
            return response

        def duplicate(url, **kwargs):
            response = self.fetch(url, **kwargs)
            response.headers = response.headers + [("Referrer-Policy", "no-referrer")]
            return response

        def suse(url, **kwargs):
            response = self.fetch(url, **kwargs)
            if url.endswith("/catalog/tools/index.json"):
                response.body = json.dumps({"tools": [{"id": "suse-banner"}]}).encode()
            return response

        def body_etag(url, **kwargs):
            response = self.fetch(url, **kwargs)
            if url.endswith("lolly.tools/"):
                response.headers = [(n, v) for n, v in response.headers if n != "ETag"] + [("ETag", '"' + "9" * 64 + '"')]
            return response
        for name, fetch, failing in (("csp", drift, "headers"), ("duplicate", duplicate, "headers"),
                                     ("suse", suse, "catalog catalog/tools/index.json"), ("etag", body_etag, "root")):
            with self.subTest(name=name):
                checks, _ = self.run_smoke(fetch)
                self.assertEqual([item["check"] for item in checks.failures()], [failing])

    def test_added_info_pages_prefer_english(self):
        new = {"info/index.html": "1", "info/new.html": "2", "info/de/new.html": "3", "info/a/b/c.html": "4"}
        self.assertEqual([p["file"] for p in S.added_info_pages(new, {"info/index.html": "1"}, 2)], ["info/new.html", "info/de/new.html"])
        self.assertEqual(S.added_info_pages(new, None, 2), [])


class Shipped(unittest.TestCase):
    def test_unit_file_and_bootstrap_use_the_anchored_paths(self):
        unit = (ROOT / "deploy/preview/node/lolly-preview-deploy.service").read_text()
        self.assertIn(f"ExecStart=/usr/bin/python3 -I -B {A.NODE_RUN_DIR}/tool/node/node_runner.py run {A.NODE_RUN_DIR}/request.json", unit)
        self.assertIn(f"ExecStopPost=/usr/bin/python3 -I -B {A.NODE_RUN_DIR}/tool/node/node_runner.py stop-post {A.NODE_RUN_DIR}/request.json", unit)
        self.assertIn("RuntimeMaxSec=1800", unit)
        self.assertNotRegex(unit, r"(?m)^\[Install\]")
        namespace = {}
        source = (ROOT / "deploy/preview/node/bootstrap.py").read_text()
        exec(compile(source, "bootstrap.py", "exec"), namespace)
        for name, value in (("ROOT", A.NODE_ROOT), ("RUN", A.NODE_RUN_DIR), ("RESULTS", A.NODE_RESULTS_DIR), ("TMP", A.NODE_TMP_DIR),
                            ("UNIT", A.NODE_UNIT), ("UNIT_PATH", A.NODE_UNIT_PATH), ("LOCK", A.NODE_LOCK),
                            ("START_LOCK", A.NODE_START_LOCK), ("SYSTEMCTL", A.NODE_SYSTEMCTL)):
            self.assertEqual(namespace[name], value, name)

    def test_tool_stays_out_of_work_images(self):
        for dockerfile in ("deploy/compose/Dockerfile", "deploy/compose/Dockerfile.suse"):
            text = (ROOT / dockerfile).read_text()
            self.assertNotRegex(text, r"(?m)^COPY\s+(deploy|\.)\s", dockerfile)

    def test_bundle_is_deterministic_and_skips_bytecode(self):
        first = M.bundle(ROOT)
        self.assertEqual(first, M.bundle(ROOT))
        import tarfile
        names = tarfile.open(fileobj=io.BytesIO(base64.b64decode(first)), mode="r:gz").getnames()
        self.assertIn("app-update.py", names)
        self.assertIn("node/node_runner.py", names)
        self.assertFalse([n for n in names if "__pycache__" in n or n.startswith("/") or ".." in n])

    def test_lolly_ing_is_a_refusing_stub(self):
        with self.assertRaises(C.Refusal) as caught:
            A.site_anchors("lolly.ing")
        self.assertEqual(caught.exception.code, "SITE_PHASE_2")


OLD, NEW = "a" * 40, "b" * 40


class EndToEnd(unittest.TestCase):
    """The real command, its SSH bootstrap, the systemd unit runner and app-update.py, over fakes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.key, self.pin = F.make_key()
        self.thumb = R.jwk_thumbprint(self.pin)
        self.builds = {"old": F.make_build(self.key, OLD, "old"),
                       "new": F.make_build(self.key, NEW, "new", extra_pages=["info/new-page.html"])}
        self.old, self.new = self.builds["old"], self.builds["new"]
        # A clean git checkout holding exactly the tool, as launch.py would find it.
        self.checkout = base / "checkout"
        for relative, path in M.tool_files(ROOT):
            if "__pycache__" in relative:
                continue
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        git = ["git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@example.com"]
        for command in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "tool"]):
            subprocess.run(git + command, check=True, capture_output=True)
        self.tool_hash = M.tool_digest(self.checkout)
        self.bin = F.write_executables(base / "bin")
        self.sandbox = base / "node"
        self.sandbox.mkdir()
        self.state_dir = base / "state"
        self.state_dir.mkdir(mode=0o700)
        self.profile = {
            "version": 1, "site": "lolly.tools",
            "ssh": {"host": "sles@10.0.0.2", "jump": "sles@192.0.2.1", "knownHostsFile": str(base / "known_hosts")},
            "node": {"k3s": str(self.bin / "k3s"), "kubeconfig": F.KUBECONFIG, "context": F.CONTEXT, "name": "node-1",
                     "uid": "node-uid", "clusterUID": "cluster-uid"},
            "deployment": {"namespaceUID": "namespace-uid", "deploymentUID": "deployment-uid",
                           "requiredLabels": {"app.kubernetes.io/component": "web", "app.kubernetes.io/name": "lolly-sovereign"}},
            "models": {"release": "models-" + "1" * 64, "manifestSha256": F.sha(F.MODELS)},
            "smoke": {"edgeAddress": "203.0.113.10", "maxAddedPages": 3, "memoryFraction": 0.8,
                      "pages": [{"path": "/info/", "file": "info/index.html"}, {"path": "/tools", "file": "view/tools.html"}]},
            "watch": {"minutes": 1, "intervalSeconds": 15, "failures": 3},
            "build": {"pollSeconds": 0, "timeoutMinutes": 10}, "rolloutTimeoutSeconds": 300,
            "capacity": {"minFreeAboveReserveBytes": GIB_1, "imageSizeFactor": 3}, "retainPreviousImages": 2,
            "noDeployUtc": ["00:00", "00:00"], "gc": {"legacyClaims": ["lolly-public-web-test-v1"]}}
        self.write_profile()
        self.cluster_path = base / "cluster.json"
        self.set_cluster(F.cluster_state(self.builds, self.old, annotations=F.preview_annotations(self.old)))
        self.gh_path = base / "gh.json"
        self.gh = {"mainHead": NEW, "compare": {f"{OLD}...{NEW}": "ahead", f"{NEW}...{OLD}": "behind"}, "calls": [],
                   "ciRuns": [F.run_object(900, NEW, path=".github/workflows/ci.yml", event="push")],
                   "runs": [], "statusSequence": {"1001": ["waiting", "completed"]}, "finalConclusion": "success",
                   "onDispatch": F.run_object(1001, NEW, status="queued", conclusion=None),
                   "artifacts": {"1001": [{"id": 555, "name": "public-candidate-web-receipts-attempt-1", "expired": False}],
                                 "800": [{"id": 556, "name": "public-candidate-web-receipts-attempt-1", "expired": False}]},
                   "zips": {"555": F.receipt_zip(self.new, 1001, 1, self.pin, self.thumb),
                            "556": F.receipt_zip(self.old, 800, 1, self.pin, self.thumb)},
                   "files": {**F.source_files(self.old), **F.source_files(self.new)},
                   "variable": {"value": F.CONNECTORS, "updated_at": "2026-10-23T04:00:00Z"}}
        self.write_gh()
        self.environ = mock.patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_STATE": str(self.cluster_path), "FAKE_GH_STATE": str(self.gh_path),
            "FAKE_SANDBOX": str(self.sandbox), "FAKE_BIN": str(self.bin), "FAKE_PIN": json.dumps(self.pin)})
        self.environ.start()
        for name in ("FAKE_CRASH_PHASE", "FAKE_CHECK_TARGET", "FAKE_SSH_DOWN"):
            os.environ.pop(name, None)
        self.patches = [mock.patch.object(A, "RELEASE_PUBLIC_KEY_JWK", self.pin),
                        mock.patch.object(A, "RELEASE_PUBLIC_KEY_THUMBPRINT", self.thumb),
                        mock.patch.object(M, "SLEEP", lambda seconds: None)]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.environ.stop()
        self.tmp.cleanup()

    # Helpers -----------------------------------------------------------------
    def write_profile(self):
        path = self.state_dir / "lolly.tools.json"
        path.write_text(json.dumps(self.profile))
        path.chmod(0o600)

    def write_gh(self):
        self.gh_path.write_text(json.dumps(self.gh))

    def set_cluster(self, state):
        self.cluster_path.write_text(json.dumps(state))

    def cluster(self):
        return json.loads(self.cluster_path.read_text())

    def gh_calls(self):
        return json.loads(self.gh_path.read_text())["calls"]

    def behave(self, **changes):
        state = self.cluster()
        state["behaviour"].update(changes)
        self.set_cluster(state)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--state-dir", str(self.state_dir), "--tool-sha256", self.tool_hash, "--checkout", str(self.checkout),
                           "--check-target", str(self.bin / "check-target.py"), "--tool-root", str(self.checkout),
                           "lolly.tools", *argv], gh=G.Gh(executable=str(self.bin / "gh"), sleep=lambda s: None),
                          opener=F.registry_opener(self.builds))
        events = []
        for line in out.getvalue().splitlines():
            with contextlib.suppress(ValueError):
                events.append(json.loads(line))
        return code, events

    def done(self, events):
        found = [event for event in events if event.get("event") in ("done", "refused")]
        self.assertTrue(found, events)
        return found[-1]

    def records(self):
        path = self.state_dir / "deploys.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def live(self):
        deploy = self.cluster()["deployment"]
        annotations = {k[len("lolly.tools/preview-"):]: v for k, v in deploy["metadata"]["annotations"].items()
                       if k.startswith("lolly.tools/preview-")}
        return deploy["spec"]["template"]["spec"]["containers"][0]["image"], annotations

    def assert_only_owned_writes(self):
        for patch in self.cluster()["writes"]:
            if isinstance(patch, list) and patch and isinstance(patch[0], dict):
                changed = [op["path"] for op in patch if op["op"] != "test"]
                allowed = all(path.startswith("/metadata/annotations") or path == "/spec/template/spec/containers/0/image"
                              for path in changed)
                self.assertTrue(allowed, changed)

    # Scenarios -----------------------------------------------------------------
    def test_ship_dispatches_binds_switches_smokes_watches_and_records(self):
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)
        image, notes = self.live()
        self.assertEqual(image, self.new["image"])
        self.assertEqual((notes["phase"], notes["source"], notes["ci-run"], notes["tool"]), ("accepted", NEW, "1001", self.tool_hash))
        self.assertEqual(json.loads(notes["previous"])["image"], self.old["image"])
        posts = [call for call in self.gh_calls() if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["body"]["inputs"]["expected_source"], NEW)
        self.assertEqual(posts[0]["body"]["inputs"]["ci_run"], "900")
        results = json.loads((self.sandbox / "var/lib/lolly-preview/results").joinpath(next(
            p.name for p in (self.sandbox / "var/lib/lolly-preview/results").iterdir())).read_text())
        checks = {item["check"]: item["ok"] for item in results["checks"]}
        self.assertTrue(all(checks.values()), checks)
        self.assertIn("page /info/new-page.html", checks)
        images = self.cluster()["images"]
        self.assertTrue(images[self.new["image"]]["pinned"] and images[self.old["image"]]["pinned"])
        self.assertEqual([r["result"] for r in self.records()], ["LIVE"])
        self.assert_only_owned_writes()
        # A second ship of the same commit changes nothing (ALREADY_LIVE, no dispatch).
        writes = len(self.cluster()["writes"])
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"))
        self.assertEqual(len(self.cluster()["writes"]), writes)
        self.assertEqual(len([c for c in self.gh_calls() if c["method"] == "POST"]), 1)

    def test_deploy_of_a_built_commit_already_live_is_a_no_op(self):
        self.gh["runs"] = [F.run_object(800, OLD)]
        self.gh["compare"][f"{OLD}...main"] = "ahead"
        self.write_gh()
        code, events = self.cli("deploy", OLD)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"))
        self.assertEqual(self.cluster()["writes"], [])

    def assert_rolled_back(self, code, events, reason):
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn(reason, result["reason"])
        image, notes = self.live()
        self.assertEqual(image, self.old["image"])
        self.assertEqual((notes["phase"], notes["source"]), ("rolled-back", OLD))
        self.assertNotIn("previous", notes)
        self.assert_only_owned_writes()

    def test_failed_smoke_rolls_back_once(self):
        self.behave(brokenSite=[self.new["image"]])
        self.assert_rolled_back(*self.cli("ship", NEW), "SMOKE_FAILED: root")

    def test_drill_forces_the_rollback(self):
        self.assert_rolled_back(*self.cli("ship", NEW, "--drill-fail-smoke"), "drill")

    def test_failed_watch_rolls_back(self):
        self.behave(watchFailAfter={self.new["image"]: 2})
        self.assert_rolled_back(*self.cli("ship", NEW), "WATCH_FAILED")

    def test_rollout_timeout_rolls_back(self):
        self.behave(notReady=[self.new["image"]])
        self.assert_rolled_back(*self.cli("ship", NEW), "ROLLOUT_FAILED")

    def test_memory_over_threshold_rolls_back(self):
        self.behave(workingSetByImage={self.new["image"]: 700 * 2 ** 20})
        self.assert_rolled_back(*self.cli("ship", NEW), "SMOKE_FAILED: pod")

    def test_a_refusal_after_the_switch_still_rolls_back(self):
        self.behave(dnsFailures=1)
        self.assert_rolled_back(*self.cli("ship", NEW), "UNVERIFIED: SMOKE_DNS")

    def test_unhealthy_rollback_stops_for_a_human(self):
        self.behave(brokenSite=[self.new["image"], self.old["image"]])
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (3, "ROLLBACK_UNHEALTHY"))
        image, notes = self.live()
        self.assertEqual((image, notes["phase"]), (self.old["image"], "rollback-unhealthy"))
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "HELD_FOR_HUMAN"))
        self.assertEqual(self.records()[-1]["result"], "REFUSED")

    def test_stop_after_switch_rolls_back_from_exec_stop_post(self):
        os.environ["FAKE_CRASH_PHASE"] = "switched-unverified"
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn("UNIT_STOPPED", result["reason"])
        self.assertEqual(self.live()[0], self.old["image"])

    def test_stop_before_the_switch_is_aborted_without_change(self):
        os.environ["FAKE_CRASH_PHASE"] = "switching"
        code, events = self.cli("ship", NEW)
        self.assertEqual(self.done(events)["result"], "ABORTED")
        image, notes = self.live()
        self.assertEqual((image, notes["phase"]), (self.old["image"], "aborted"))

    def test_refusals_before_any_change(self):
        cases = [
            ("lock", lambda: (self.sandbox / "unit-state").write_text("active"), "LOCK_HELD"),
            ("check-target", lambda: os.environ.__setitem__("FAKE_CHECK_TARGET", "fail"), "CHECK_TARGET_FAILED"),
            ("capacity", lambda: self.set_cluster(dict(self.cluster(), capacity={"total": 100 * F.GIB, "available": 26 * F.GIB})), "LOW_CAPACITY"),
            ("not main head", lambda: self.gh.update(mainHead="c" * 40), "NOT_MAIN_HEAD"),
            ("ci red", lambda: self.gh.update(ciRuns=[F.run_object(900, NEW, path=".github/workflows/ci.yml", event="push", conclusion="failure")]), "CI_NOT_GREEN"),
            ("candidate active", lambda: self.gh.update(runs=[F.run_object(990, "d" * 40, status="waiting", conclusion=None)]), "CANDIDATE_ACTIVE"),
            ("build failed", lambda: self.gh.update(finalConclusion="failure"), "RUN_FAILED"),
            ("receipt", lambda: self.gh["zips"].update({"555": F.receipt_zip(self.new, 1001, 1, self.pin, self.thumb, **{"web.json": {}})}), "RECEIPT_INVALID"),
            ("origins changed", lambda: self.gh.update(variable={"value": F.CONNECTORS, "updated_at": "2026-10-23T06:00:00Z"}), "CONNECTOR_ORIGINS_CHANGED"),
            ("models", lambda: (self.profile["models"].update(manifestSha256="0" * 64), self.write_profile()), "MODELS_CHANGED"),
            ("not converted", lambda: self.set_cluster(F.cluster_state(self.builds, self.old, converted=False)), "NOT_CONVERTED"),
            ("backup window", lambda: (self.profile.update(noDeployUtc=["00:00", "23:59"]), self.write_profile()), "BACKUP_WINDOW"),
        ]
        for name, arrange, code_name in cases:
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                arrange()
                self.write_gh()
                code, events = self.cli("ship", NEW)
                self.assertEqual((code, self.done(events).get("code")), (1, code_name), events[-3:])
                self.assertEqual(self.cluster()["writes"], [])
                self.assertEqual(self.live()[0], self.old["image"])
                self.assertEqual(self.records()[-1]["code"], code_name)

    def test_tool_must_be_clean_and_pinned(self):
        with (self.checkout / "deploy/preview/preview-deploy.py").open("a") as handle:
            handle.write("# changed\n")
        code, events = self.cli("status")
        self.assertEqual((code, self.done(events)["code"]), (1, "TOOL_HASH_MISMATCH"))
        subprocess.run(["git", "-C", str(self.checkout), "checkout", "--", "."], check=True)
        self.gh["toolCompare"] = "diverged"
        self.write_gh()
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_NOT_MAIN")

    def test_manual_rollback_and_stored_format_refusal(self):
        self.assertEqual(self.cli("ship", NEW)[0], 0)
        code, events = self.cli("rollback")
        result = self.done(events)
        self.assertEqual((code, result["result"], result["reason"]), (2, "ROLLED_BACK", "MANUAL"))
        self.assertEqual(self.live()[0], self.old["image"])
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "NO_PREVIOUS")
        # A build that raised DB_VERSION cannot be rolled back by hand.
        raised = F.make_build(self.key, NEW, "new", formats=F.format_files(db=27))
        self.gh["files"].update(F.source_files(raised))
        self.write_gh()
        self.setUp_cluster_with_previous(self.new, self.old, new_formats={"channelMessage": 2, "indexedDb": 27, "revisionArchive": 1, "session": 4})
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "FORMAT_LOWERING")

    def setUp_cluster_with_previous(self, live, previous, new_formats):
        record = {"source": previous["sha"], "image": previous["image"], "ciRun": "800",
                  "formats": {"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}, "expect": F.expect_for(previous)}
        notes = F.preview_annotations(live, previous=record)
        notes["lolly.tools/preview-formats"] = C.compact(new_formats)
        self.set_cluster(F.cluster_state(self.builds, live, annotations=notes))

    def test_status_reports_the_live_phase(self):
        code, events = self.cli("status")
        status = [e for e in events if e.get("event") == "status"][0]
        self.assertEqual((code, status["phase"], status["source"], status["converted"]), (0, "accepted", OLD, True))

    def test_gc_reports_claims_for_andy_and_removes_only_old_images(self):
        state = self.cluster()
        stale = F.IMAGE_REPO + "@sha256:" + "e" * 64
        state["images"][stale] = {"id": "sha256:stale", "size": 50 * 2 ** 20, "pinned": True}
        self.set_cluster(state)
        code, events = self.cli("gc")
        images = [e for e in events if e.get("event") == "gc-images"][0]
        self.assertEqual((code, images["remove"]), (0, [stale]))
        claims = {e["name"]: e for e in events if e.get("event") == "gc-claim"}
        self.assertEqual(set(claims), {"lolly-public-web-test-v1"})
        self.assertFalse(claims["lolly-public-web-test-v1"]["candidate"])
        self.assertIn(stale, self.cluster()["images"])  # a report changes nothing
        code, events = self.cli("gc", "--execute")
        self.assertEqual((code, self.done(events)["result"]), (0, "GC_DONE"))
        self.assertNotIn(stale, self.cluster()["images"])
        self.assertIn(self.old["image"], self.cluster()["images"])
        self.assertFalse([w for w in self.cluster()["writes"] if isinstance(w, list) and w and w[0] == "delete"])

    def converted_plan(self):
        self.set_cluster(F.cluster_state(self.builds, self.old, converted=False))
        self.gh["runs"] = [F.run_object(800, OLD)]
        self.gh["compare"][f"{OLD}...main"] = "ahead"
        self.write_gh()
        code, events = self.cli("plan", OLD)
        plan = [e for e in events if e.get("event") == "plan"][0]
        self.assertEqual(code, 0)
        self.assertEqual(self.cluster()["writes"], [])
        self.assertEqual({v["name"] for v in plan["removedVolumes"]}, {"nginx", "public-delivery"})
        self.assertTrue(any(item["check"] == "headers" for item in plan["preConversionSmoke"]))  # the ConfigMap CSP differs
        return plan

    def test_plan_then_apply_converts_with_the_same_bytes(self):
        plan = self.converted_plan()
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", "0" * 64)
        self.assertEqual(self.done(events)["code"], "PLAN_MISMATCH")
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", plan["reviewedPlanSha256"])
        self.assertEqual((code, self.done(events)["result"]), (0, "CONVERTED"), events)
        image, notes = self.live()
        deploy = self.cluster()["deployment"]
        self.assertEqual(image, self.old["image"])
        self.assertEqual((notes["phase"], notes["source"], notes["layout"], notes["deploys"]), ("accepted", OLD, "image-root", "0"))
        self.assertEqual(deploy["spec"]["revisionHistoryLimit"], 5)
        self.assertTrue(L.is_converted(deploy, 0, A.TOOLS))
        # The converted site then takes a normal ship.
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)

    def test_failed_conversion_restores_the_claim_layout(self):
        plan = self.converted_plan()
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", plan["reviewedPlanSha256"],
                                "--drill-fail-smoke")
        self.assertEqual((code, self.done(events)["result"]), (2, "CONVERSION_REVERTED"), events)
        deploy = self.cluster()["deployment"]
        self.assertFalse(L.is_converted(deploy, 0, A.TOOLS))
        self.assertEqual(deploy["spec"]["revisionHistoryLimit"], 2)
        self.assertEqual(deploy["spec"]["template"], F.deployment(self.old["image"], converted=False)["spec"]["template"])

    def test_lolly_ing_refuses_without_touching_anything(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--state-dir", str(self.state_dir), "--tool-sha256", self.tool_hash, "--checkout", str(self.checkout),
                           "--check-target", "x", "lolly.ing", "ship", NEW])
        self.assertEqual(code, 1)
        self.assertIn("SITE_PHASE_2", out.getvalue())
        self.assertEqual(self.gh_calls(), [])


GIB_1 = 2 ** 30


if __name__ == "__main__":
    unittest.main()
