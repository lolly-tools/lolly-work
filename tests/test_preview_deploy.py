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

    def test_recomputed_plan_ignores_only_the_resource_version(self):
        """Review C-H1 and C-M9: the node recomputes the plan; a status update must not invalidate it."""
        before = F.deployment("img@sha256:" + "a" * 64, converted=False)
        plan = L.conversion_plan(before, self.ANCHORS, {"lolly.tools/preview-phase": "converting"})
        churned = copy.deepcopy(before)
        churned["metadata"]["resourceVersion"] = "101"
        self.assertEqual(L.comparable_plan(L.conversion_plan(churned, self.ANCHORS, plan["annotations"])), L.comparable_plan(plan))
        changed = copy.deepcopy(before)
        changed["spec"]["template"]["spec"]["volumes"].append({"name": "extra", "emptyDir": {}})
        self.assertNotEqual(L.comparable_plan(L.conversion_plan(changed, self.ANCHORS, plan["annotations"])), L.comparable_plan(plan))

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
            "release catalog key": {"catalog.json": {"verified": True, "keyId": A.RELEASE_PUBLIC_KEY_THUMBPRINT,
                                                       "indexSha256": "7" * 64}},
            "missing boot": {"web-boot.json": None},
            "extra file": {"extra.json": {}},
        }
        for name, override in cases.items():
            with self.subTest(name=name), self.assertRaises(C.Refusal):
                self.read(**override)

    def test_bind_run_requires_workflow_event_repository_branch_commit_success(self):
        class StubGh:
            def json(inner, path, **params):
                return {"artifacts": [{"id": 5, "name": "preview-web-receipts-attempt-1", "expired": False,
                                       "expires_at": "2026-11-05T08:25:02Z"}]}

            def binary(inner, path, limit):
                return base64.b64decode(F.receipt_zip(self.build, 77, 1, self.pin, self.thumb))
        bound = G.bind_run(StubGh(), A.TOOLS, self.run, "b" * 40, self.pin, self.thumb)
        self.assertEqual((bound["run"], bound["receiptExpiresAt"]), (77, "2026-11-05T08:25:02Z"))
        for field, value in (("path", ".github/workflows/evil.yml"), ("event", "push"), ("head_branch", "preview"),
                             ("head_sha", "invalid"), ("conclusion", "failure"),
                             ("head_repository", {"full_name": "fork/lolly"})):
            run = dict(self.run, **{field: value})
            with self.subTest(field=field), self.assertRaises(C.Refusal):
                G.bind_run(StubGh(), A.TOOLS, run, "b" * 40, self.pin, self.thumb)

    def test_dispatch_request_uses_only_source_and_a_full_ref(self):
        class Recorder:
            posted = None

            def post(inner, path, body):
                Recorder.posted = (path, body)
        G.dispatch_build(Recorder(), A.TOOLS, "b" * 40)
        path, body = Recorder.posted
        self.assertEqual(path, "repos/lolly-tools/lolly/actions/workflows/preview-web.yml/dispatches")
        self.assertEqual(body["ref"], "refs/heads/main")  # review S-M2: never the bare name a tag could share
        self.assertEqual(body["inputs"], {"source": "b" * 40})


    def test_run_discovery_and_binding_use_source_title_with_a_newer_main_head(self):
        source, head = "b" * 40, "c" * 40
        run = dict(self.run, head_sha=head)
        calls = []

        class StubGh:
            def json(inner, path, **params):
                calls.append((path, params))
                if path.endswith("/runs"):
                    wrong = dict(run, id=78, display_title="Preview web " + head)
                    return {"workflow_runs": [wrong, run, dict(run, id=79, path="other.yml"),
                                               dict(run, id=80, event="push"), dict(run, id=81, head_branch="other")]}
                if "/compare/" in path:
                    return {"status": "ahead"}
                return {"artifacts": [{"id": 5, "name": "preview-web-receipts-attempt-1", "expired": False}]}

            def binary(inner, path, limit):
                return base64.b64decode(F.receipt_zip(self.build, 77, 1, self.pin, self.thumb))

            def sleep(inner, seconds):
                self.fail("the matching run should be found immediately")

        gh = StubGh()
        found = G.find_new_run(gh, A.TOOLS, source, set())
        self.assertEqual(found, run)
        self.assertEqual(calls[0][1], {"event": "workflow_dispatch", "branch": "main", "per_page": 100})
        self.assertEqual(G.bind_run(gh, A.TOOLS, found, source, self.pin, self.thumb)["image"], self.build["image"])
        self.assertIn((f"repos/{F.REPO}/compare/{source}...{head}", {}), calls)

    def test_binding_refuses_another_title_or_a_source_outside_the_run_head(self):
        class StubGh:
            def json(inner, path, **params):
                self.assertIn("/compare/", path)
                return {"status": "diverged"}
        for run in (dict(self.run, display_title="Preview web " + "c" * 40),
                    dict(self.run, head_sha="c" * 40)):
            with self.subTest(run=run), self.assertRaises(C.Refusal) as caught:
                G.bind_run(StubGh(), A.TOOLS, run, "b" * 40, self.pin, self.thumb)
            self.assertEqual(caught.exception.code, "RUN_NOT_BOUND")


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

    def run_smoke(self, fetch, baseline=None):
        with mock.patch.object(S, "FETCH", fetch):
            return S.smoke(F.expect_for(self.build), A.TOOLS, self.pin, pod_check=lambda memory: (True, "ok"), edge_baseline=baseline)

    def test_good_site_passes(self):
        checks, files = self.run_smoke(self.fetch)
        self.assertTrue(checks.ok, checks.failures())
        self.assertIn("index.html", files)

    def test_csp_drift_edge_drift_suse_ids_and_bad_etag_fail(self):
        def drift(url, **kwargs):
            response = self.fetch(url, **kwargs)
            response.headers = [(n, v + " https://*.sharepoint.com" if n == "Content-Security-Policy" else v) for n, v in response.headers]
            return response

        def duplicate(url, **kwargs):
            response = self.fetch(url, **kwargs)
            response.headers = response.headers + [("Content-Security-Policy", "default-src *")]
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
        for name, fetch, failing in (("csp", drift, "csp"), ("duplicate", duplicate, "csp"),
                                     ("suse", suse, "catalog catalog/tools/index.json"), ("etag", body_etag, "root")):
            with self.subTest(name=name):
                checks, _ = self.run_smoke(fetch)
                self.assertEqual([item["check"] for item in checks.failures()], [failing])
        checks, _ = self.run_smoke(drift)
        self.assertIn("Content-Security-Policy: expected", checks.failures()[0]["detail"])  # one line per header (review C-M1)

    def test_edge_owned_headers_compare_with_what_the_edge_served_before(self):
        """Review C-M2: Caddy owns these headers; the source is not the reference for them."""
        def edge(url, **kwargs):
            response = self.fetch(url, **kwargs)
            response.headers = [(n, "strict-origin" if n == "Referrer-Policy" else v) for n, v in response.headers]
            return response
        baseline = [["Referrer-Policy", "strict-origin"], ["X-Content-Type-Options", "nosniff"]]
        checks, _ = self.run_smoke(edge, baseline)
        self.assertTrue(checks.ok, checks.failures())
        checks, _ = self.run_smoke(self.fetch, baseline)  # the edge value changed across the switch
        self.assertEqual([item["check"] for item in checks.failures()], ["edge headers"])

    def test_transport_errors_become_refusals(self):
        """Review C-H3: a reset connection or a truncated body is a counted probe failure, not a crash."""
        import http.client

        class Broken:
            def __init__(self, failure):
                self.failure = failure

            def open(self, request, timeout):
                if self.failure == "open":
                    raise ConnectionResetError("reset")
                response = mock.Mock(status=200, headers={})
                response.read.side_effect = http.client.IncompleteRead(b"partial")
                return response
        for failure in ("open", "read"):
            with self.subTest(failure=failure), mock.patch("urllib.request.build_opener", return_value=Broken(failure)), \
                    self.assertRaises(C.Refusal) as caught:
                S.http_fetch("https://lolly.tools/")
            self.assertEqual(caught.exception.code, "SMOKE_TRANSPORT")
        with mock.patch.object(S, "FETCH", side_effect=C.Refusal("SMOKE_TRANSPORT", "reset")):
            self.assertEqual(S.watch_probe("0" * 64, A.TOOLS, lambda memory: (True, "ok")), ["/ SMOKE_TRANSPORT", "/healthz SMOKE_TRANSPORT"])

    def test_added_info_pages_prefer_english(self):
        new = {"info/index.html": "1", "info/new.html": "2", "info/de/new.html": "3", "info/a/b/c.html": "4"}
        self.assertEqual([p["file"] for p in S.added_info_pages(new, {"info/index.html": "1"}, 2)], ["info/new.html", "info/de/new.html"])
        self.assertEqual(S.added_info_pages(new, None, 2), [])


class Shipped(unittest.TestCase):
    def test_unit_file_bootstrap_and_time_budget_use_the_anchors(self):
        unit = (ROOT / "deploy/preview/node/lolly-preview-deploy.service").read_text()
        self.assertIn(f"ExecStart=/usr/bin/python3 -I -B {A.NODE_RUN_DIR}/tool/node/node_runner.py run {A.NODE_RUN_DIR}/request.json", unit)
        self.assertIn(f"ExecStopPost=/usr/bin/python3 -I -B {A.NODE_RUN_DIR}/tool/node/node_runner.py stop-post {A.NODE_RUN_DIR}/request.json", unit)
        self.assertIn(f"RuntimeMaxSec={A.UNIT_RUNTIME_MAX_SECONDS}\n", unit)
        self.assertIn(f"TimeoutStopSec={A.UNIT_STOP_TIMEOUT_SECONDS}\n", unit)
        self.assertGreaterEqual(A.UNIT_RUNTIME_MAX_SECONDS, 2 * A.PULL_TIMEOUT_SECONDS + 2 * A.MAX_ROLLOUT_SECONDS + A.MAX_WATCH_MINUTES * 60
                                + 3 * A.SMOKE_BUDGET_SECONDS + A.RETENTION_AFTER_DEPLOY_SECONDS + 300)  # the longest deploy
        self.assertGreater(A.CRICTL_READ_TIMEOUT_SECONDS, 2)  # crictl's own default deadline
        self.assertLessEqual(A.REMOVE_WORST_SECONDS, min(A.RETENTION_AFTER_DEPLOY_SECONDS, A.GC_REMOVE_BUDGET_SECONDS))
        self.assertGreaterEqual(A.UNIT_STOP_TIMEOUT_SECONDS, A.PULL_TIMEOUT_SECONDS + A.MAX_ROLLOUT_SECONDS + A.SMOKE_BUDGET_SECONDS)
        self.assertNotRegex(unit, r"(?m)^\[Install\]")
        namespace = {}
        source = (ROOT / "deploy/preview/node/bootstrap.py").read_text()
        exec(compile(source, "bootstrap.py", "exec"), namespace)
        for name, value in (("ROOT", A.NODE_ROOT), ("RUN", A.NODE_RUN_DIR), ("RESULTS", A.NODE_RESULTS_DIR), ("TMP", A.NODE_TMP_DIR),
                            ("UNIT", A.NODE_UNIT), ("UNIT_PATH", A.NODE_UNIT_PATH), ("LOCK_DIR", A.NODE_LOCK_DIR),
                            ("LOCK", A.NODE_LOCK), ("START_LOCK", A.NODE_START_LOCK), ("SYSTEMCTL", A.NODE_SYSTEMCTL),
                            ("SPOOL", A.NODE_SPOOL_DIR)):
            self.assertEqual(namespace[name], value, name)
        for bad in ("../../etc/passwd", "20261023T000000Z-x/../../y", None):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):  # review S-L4
                with contextlib.redirect_stdout(io.StringIO()):
                    namespace["deploy_id"](bad)

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

    def test_lolly_ing_refuses_until_its_own_key_is_pinned(self):
        """PROPOSAL 4.7: until a reviewed change pins lolly.ing's key, every lolly.ing run refuses."""
        import preview_ing as I
        self.assertIs(A.site_anchors("lolly.ing"), A.ING)
        self.assertIsNone(A.ING_PUBLIC_KEY_JWK)
        with self.assertRaises(C.Refusal) as caught:
            I.ing_pin()
        self.assertEqual(caught.exception.code, "ING_KEY_NOT_PINNED")
        with mock.patch.object(A, "ING_PUBLIC_KEY_JWK", A.RELEASE_PUBLIC_KEY_JWK), self.assertRaises(C.Refusal) as caught:
            I.ing_pin()  # never the platform release key (R20 S1, R21 R2, R22 S1)
        self.assertEqual(caught.exception.code, "RELEASE_KEY")
        with mock.patch.object(A, "ING_PUBLIC_KEY_JWK", A.PREVIEW_PUBLIC_KEY_JWK), self.assertRaises(C.Refusal) as caught:
            I.ing_pin()
        self.assertEqual(caught.exception.code, "KEY_MISMATCH")
        # Andy accepted shared-account dispatch; the signing key and second Secret still need reviewed pins.
        import preview_ing_github as IG
        self.assertEqual(A.ING_DISPATCH_IDENTITY, "ndftz")
        self.assertIs(A.ING_ALLOW_SAME_ACCOUNT_APPROVAL, True)
        self.assertEqual(IG.identity_anchors(), ("ndftz", ("ndftz",)))
        self.assertIsNone(A.ING_SIGNING_KEY_SECRET)
        self.assertEqual(A.ING_REVIEWERS, ("ndftz",))
        with mock.patch.object(A, "ING_DISPATCH_IDENTITY", None), self.assertRaises(C.Refusal) as caught:
            IG.identity_anchors()
        self.assertEqual(caught.exception.code, "AGENT_IDENTITY")
        with self.assertRaises(C.Refusal) as caught:
            I.signing_secret()
        self.assertEqual(caught.exception.code, "SIGNING_SECRET_NOT_PINNED")
        self.assertEqual(set(A.ING_BUILD_BLOBS), {".github/workflows/lolly-ing-preview.yml", ".github/lolly-ing-preview/tool.mjs",
                                                  ".github/lolly-ing-preview/instance.Dockerfile"})
        for blob in A.ING_BUILD_BLOBS.values():
            self.assertRegex(blob, r"\A[0-9a-f]{40}\Z")

    def test_launcher_options_cannot_be_repeated_moved_or_abbreviated(self):
        """Review S-H1: the caller cannot override what launch.py set."""
        base = ["--state-dir", "/s", "--tool-sha256", "0" * 64, "--checkout", "/c", "--check-target", "/t"]
        M.check_argv(base + ["lolly.tools", "status"])
        for argv in (base + ["lolly.tools", "status", "--state-dir", "/x"],
                     base + ["lolly.tools", "ship", "a" * 40, "--tool-sha256=" + "1" * 64],
                     base + ["--state-dir", "/x", "lolly.tools", "status"],
                     ["--state", "/s"] + base[2:] + ["lolly.tools", "status"],
                     base[2:] + ["lolly.tools", "status"],
                     base + ["lolly.tools", "--checkout", "/x", "status"]):
            with self.subTest(argv=argv), self.assertRaises(C.Refusal):
                M.check_argv(argv)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            M.parser().parse_args(base + ["lolly.tools", "gc", "--exec"])  # abbreviations are refused

    def test_node_lock_directory_must_be_private(self):
        import preview_node as N
        with tempfile.TemporaryDirectory() as tmp:
            open_dir = Path(tmp) / "open"
            open_dir.mkdir()
            open_dir.chmod(0o777)
            with self.assertRaises(C.Refusal) as caught:
                N.secure_lock_dir(str(open_dir))
            self.assertEqual(caught.exception.code, "LOCK_UNSAFE")
            (Path(tmp) / "link").symlink_to(open_dir)
            with self.assertRaises(C.Refusal):
                N.secure_lock_dir(str(Path(tmp) / "link"))


OLD, NEW = "a" * 40, "b" * 40
GIB_1 = 2 ** 30


class EndToEnd(unittest.TestCase):
    """The real command, its SSH bootstrap, the systemd unit runner and app-update.py, over fakes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.key, self.pin = F.make_key()
        self.thumb = R.jwk_thumbprint(self.pin)
        self.release_key, self.release_pin = F.make_key()
        self.release_thumb = R.jwk_thumbprint(self.release_pin)
        self.builds = {"old": F.make_build(self.release_key, OLD, "old", image_repository=F.LEGACY_IMAGE_REPO),
                       "new": F.make_build(self.key, NEW, "new", extra_pages=["info/new-page.html"]),
                       "rebuild": F.make_build(self.release_key, OLD, "old rebuild", image_repository=F.LEGACY_IMAGE_REPO)}
        self.old, self.new = self.builds["old"], self.builds["new"]
        self.new["catalogPin"] = self.thumb
        # A clean git checkout holding exactly the tool, as launch.py would find it.
        self.checkout = base / "checkout"
        for relative, path in M.tool_files(ROOT):
            target = self.checkout / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        git = ["git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@example.com"]
        for command in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "tool"]):
            subprocess.run(git + command, check=True, capture_output=True)
        self.bin = F.write_executables(base / "bin")
        self.sandbox = base / "node"
        self.sandbox.mkdir()
        (self.sandbox / "proc-status").write_text("Name:\tpython3\nNoNewPrivs:\t1\n")
        (self.sandbox / "proc-attr").write_text("system_u:system_r:unconfined_service_t:s0\x00")
        self.known_hosts = base / "known_hosts"
        self.production = base / "lolly-private" / "production"
        self.state_dir = self.production / "preview"
        self.state_dir.mkdir(parents=True, mode=0o700)
        self.production.chmod(0o700)
        self.check_target_path = self.production / "check-target.py"
        F.write_check_target(self.check_target_path, self.bin / "k3s", self.known_hosts)
        self.lock = F.lock_for(self.checkout, self.checkout)
        (self.state_dir / "tool.lock.json").write_text(json.dumps(self.lock))
        self.tool_hash = self.lock["toolSha256"]
        self.profile = {
            "version": 1, "site": "lolly.tools",
            "models": {"release": "models-" + "1" * 64, "manifestSha256": F.sha(F.MODELS)},
            "smoke": {"maxAddedPages": 3, "memoryFraction": 0.8,
                      "pages": [{"path": "/info/", "file": "info/index.html"}, {"path": "/tools", "file": "view/tools.html"}]},
            "watch": {"minutes": 0, "intervalSeconds": 15, "failures": 3},  # with_watch() for the watch tests
            "build": {"pollSeconds": 0, "timeoutMinutes": 10}, "rolloutTimeoutSeconds": 300,
            "capacity": {"minFreeAboveReserveBytes": GIB_1, "imageSizeFactor": 3}, "retainPreviousImages": 2,
            "noDeployUtc": ["00:00", "00:00"], "gc": {"legacyClaims": ["lolly-public-web-test-v1"]}}
        self.write_profile()
        self.cluster_path = base / "cluster.json"
        self.set_cluster(F.cluster_state(self.builds, self.old, annotations=F.preview_annotations(self.old)))
        self.gh_path = base / "gh.json"
        self.gh = {"mainHead": NEW, "compare": {f"{OLD}...{NEW}": "ahead", f"{NEW}...{OLD}": "behind"}, "calls": [],
                   "ciRuns": [F.run_object(900, NEW, path=".github/workflows/ci.yml", event="push")],
                   "runs": [F.run_object(800, OLD, path=A.TOOLS_LEGACY["buildWorkflowPath"], created="2026-10-21T08:00:00Z")],
                   "statusSequence": {"1001": ["waiting", "completed"]}, "finalConclusion": "success",
                   "onDispatch": F.run_object(1001, NEW, status="queued", conclusion=None),
                   "artifacts": {"1001": [{"id": 555, "name": "preview-web-receipts-attempt-1", "expired": False}],
                                 "800": [{"id": 556, "name": "public-candidate-web-receipts-attempt-1", "expired": False,
                                          "expires_at": "2026-11-05T08:25:02Z"}]},
                   "zips": {"555": F.receipt_zip(self.new, 1001, 1, self.pin, self.thumb),
                            "556": F.receipt_zip(self.old, 800, 1, self.release_pin, self.release_thumb)},
                   "files": {**F.source_files(self.old), **F.source_files(self.new)},
                   "variable": {"value": F.CONNECTORS, "updated_at": "2026-10-20T04:00:00Z"}}
        self.write_gh()
        self.environ = mock.patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_STATE": str(self.cluster_path), "FAKE_GH_STATE": str(self.gh_path),
            "FAKE_SANDBOX": str(self.sandbox), "FAKE_BIN": str(self.bin), "FAKE_PIN": json.dumps(self.release_pin), "FAKE_PREVIEW_PIN": json.dumps(self.pin),
            "FAKE_KNOWN_HOSTS": str(self.known_hosts)})
        self.environ.start()
        for name in ("FAKE_CRASH_PHASE", "FAKE_CHECK_TARGET", "FAKE_SSH_DOWN", "FAKE_START_REPLY_LOST", "FAKE_UNIT_NEVER_STARTS"):
            os.environ.pop(name, None)
        self.patches = [mock.patch.object(A, "RELEASE_PUBLIC_KEY_JWK", self.release_pin),
                        mock.patch.object(A, "RELEASE_PUBLIC_KEY_THUMBPRINT", self.release_thumb),
                        mock.patch.object(A, "PREVIEW_PUBLIC_KEY_JWK", self.pin),
                        mock.patch.object(A, "PREVIEW_PUBLIC_KEY_THUMBPRINT", self.thumb),
                        mock.patch.object(M, "SLEEP", lambda seconds: None),
                        mock.patch.object(M, "TOOL_ROOT", self.checkout),
                        mock.patch.object(M, "STATE_DIR", self.state_dir)]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.environ.stop()
        self.tmp.cleanup()

    def with_watch(self, minutes=1):
        self.profile["watch"]["minutes"] = minutes
        self.write_profile()

    def add_build(self, sha, label, run_id):
        """A built and bound commit that `deploy` and `adopt` can use."""
        build = F.make_build(self.key, sha, label)
        build["catalogPin"] = self.thumb
        self.builds[label] = build
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["runs"].append(F.run_object(run_id, sha))
        self.gh["artifacts"][str(run_id)] = [{"id": run_id + 100000, "name": "preview-web-receipts-attempt-1", "expired": False}]
        self.gh["zips"][str(run_id + 100000)] = F.receipt_zip(build, run_id, 1, self.pin, self.thumb)
        self.gh["files"].update(F.source_files(build))
        self.write_gh()
        state = self.cluster()
        state["builds"][build["image"]] = build
        state["registry"][build["image"]] = True
        self.set_cluster(state)
        return build

    def write_profile(self):
        path = self.state_dir / "lolly.tools.json"
        path.write_text(json.dumps(self.profile))
        path.chmod(0o600)

    def update_gh(self, **changes):
        """Change the GitHub fake without losing what it recorded since setUp."""
        self.gh = json.loads(self.gh_path.read_text())
        self.gh.update(changes)
        self.write_gh()

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

    def cli(self, *argv, state_dir=None, check_target=None, tool_hash=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--state-dir", str(state_dir or self.state_dir), "--tool-sha256", tool_hash or self.tool_hash,
                           "--checkout", str(self.checkout), "--check-target", str(check_target or self.check_target_path),
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

    def patches_written(self):
        return [w for w in self.cluster()["writes"] if isinstance(w, list) and w and isinstance(w[0], dict)]

    def assert_only_owned_writes(self):
        for patch in self.patches_written():
            changed = [op["path"] for op in patch if op["op"] != "test"]
            self.assertTrue(all(path.startswith("/metadata/annotations") or path == "/spec/template/spec/containers/0/image"
                                for path in changed), changed)
        for write in self.cluster()["writes"]:
            if write and write[0] == "rmi":
                self.fail("a deploy removed an image: " + str(write))

    def assert_crictl_deadlines(self):
        """Every crictl call set its own deadline: crictl's default of 2 s cuts slow calls short."""
        calls = self.cluster().get("crictlCalls", [])
        self.assertTrue(calls)
        expected = {"rmi": A.CRICTL_WRITE_TIMEOUT_SECONDS, "pull": A.CRICTL_WRITE_TIMEOUT_SECONDS}
        for call in calls:
            self.assertTrue(call["explicit"], call)
            self.assertEqual(call["deadline"], expected.get(call["command"], A.CRICTL_READ_TIMEOUT_SECONDS), call)

    def result_file(self):
        results = self.sandbox / "var/lib/lolly-preview/results"
        names = sorted(p for p in results.iterdir() if not p.name.endswith(".request.json"))
        return json.loads(names[-1].read_text())

    def node_image(self, ref):
        for image_id, entry in self.cluster()["images"].items():
            if ref in entry["refs"]:
                return entry
        return None

    def assert_rolled_back(self, code, events, reason):
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn(reason, result["reason"])
        image, notes = self.live()
        self.assertEqual(image, self.old["image"])
        self.assertEqual((notes["phase"], notes["source"], notes["image"]), ("rolled-back", OLD, self.old["image"]))
        self.assertNotIn("previous", notes)
        self.assert_only_owned_writes()

    def cluster_with_previous(self, live, record, new_formats=None):
        notes = F.preview_annotations(live, previous=record, run="1001")
        if new_formats:
            notes["lolly.tools/preview-formats"] = C.compact(new_formats)
        state = F.cluster_state(self.builds, live, annotations=notes)
        image_id, entry = F.image_entry(self.old["image"], {"io.cri-containerd.pinned": "pinned"})
        state["images"][image_id] = entry
        self.gh["runs"].append(F.run_object(1001, NEW))
        self.write_gh()
        self.set_cluster(state)

    def converted_plan(self, rebuild_newer=False):
        self.set_cluster(F.cluster_state(self.builds, self.old, converted=False))
        if rebuild_newer:  # a newer rebuild of the same commit, with other bytes (review C-H4)
            self.gh["runs"].append(F.run_object(850, OLD, path=A.TOOLS_LEGACY["buildWorkflowPath"]))
            self.gh["artifacts"]["850"] = [{"id": 557, "name": "public-candidate-web-receipts-attempt-1", "expired": False}]
            self.gh["zips"]["557"] = F.receipt_zip(self.builds["rebuild"], 850, 1, self.release_pin, self.release_thumb)
            self.gh["runs"].append(F.run_object(860, OLD, path=A.TOOLS_LEGACY["buildWorkflowPath"]))
            self.gh["artifacts"]["860"] = [{"id": 558, "name": "public-candidate-web-receipts-attempt-1", "expired": True}]
        self.write_gh()
        code, events = self.cli("plan", OLD)
        plan = [e for e in events if e.get("event") == "plan"]
        self.assertEqual(code, 0, events)
        self.assertEqual(self.cluster()["writes"], [])
        plan = plan[0]
        self.assertEqual({v["name"] for v in plan["removedVolumes"]}, {"nginx", "public-delivery"})
        self.assertEqual(plan["receiptExpiresAt"], "2026-11-05T08:25:02Z")
        differences = [e for e in events if e.get("event") == "pre-conversion-header"]
        self.assertTrue(differences and differences[0]["difference"].startswith("Content-Security-Policy: expected"))
        restores = [e for e in events if e.get("event") == "revert-restores"][0]
        self.assertEqual(len(restores["volumeMounts"]), 10)
        return plan


class Deploys(EndToEnd):
    """Ship and deploy: switch, smoke, watch and every rollback path."""

    def test_ship_dispatches_binds_switches_smokes_watches_and_records(self):
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)
        image, notes = self.live()
        self.assertEqual(image, self.new["image"])
        self.assertEqual((notes["phase"], notes["source"], notes["image"], notes["ci-run"], notes["tool"]),
                         ("accepted", NEW, self.new["image"], "1001", self.tool_hash))
        self.assertEqual(json.loads(notes["previous"])["image"], self.old["image"])
        posts = [call for call in self.gh_calls() if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["body"], {"ref": "refs/heads/main", "inputs": {"source": NEW}})
        checks = {item["check"]: item["ok"] for item in self.result_file()["checks"]}
        self.assertTrue(all(checks.values()), checks)
        self.assertIn("pull", {call["command"] for call in self.cluster()["crictlCalls"]})
        self.assert_crictl_deadlines()
        self.assertIn("page /info/new-page.html", checks)
        self.assertIn("edge headers", checks)
        new_entry, old_entry = self.node_image(self.new["image"]), self.node_image(self.old["image"])
        self.assertEqual(new_entry["refs"][self.new["image"]].get("lolly.tools/preview-pin"), "true")
        self.assertEqual(old_entry["refs"][self.old["image"]], {"io.cri-containerd.pinned": "pinned"})  # a foreign pin, untouched
        self.assertEqual([r["result"] for r in self.records()], ["LIVE"])
        self.assert_only_owned_writes()
        writes = len(self.cluster()["writes"])
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"))
        self.assertEqual(len(self.cluster()["writes"]), writes)
        self.assertEqual(len([c for c in self.gh_calls() if c["method"] == "POST"]), 1)

    def test_ship_accepts_source_behind_the_dispatched_main_head(self):
        head = "c" * 40
        self.gh["mainHead"] = head
        self.gh["onDispatch"]["head_sha"] = head
        self.write_gh()
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)

    def test_manual_rollback_of_an_old_record_uses_the_release_pin(self):
        previous = F.old_record(self.old)
        self.assertNotIn("catalogPin", previous)
        self.cluster_with_previous(self.new, previous)
        with mock.patch.object(A, "PREVIEW_PUBLIC_KEY_JWK", None), \
                mock.patch.object(A, "PREVIEW_PUBLIC_KEY_THUMBPRINT", None), mock.patch.dict(os.environ):
            os.environ.pop("FAKE_PREVIEW_PIN")
            code, events = self.cli("rollback")
        self.assertEqual((code, self.done(events)["result"]), (2, "ROLLED_BACK"), events)
        self.assertEqual(self.live()[1]["catalog-pin"], self.release_thumb)
        self.assertTrue(all(item["ok"] for item in self.result_file()["rollbackChecks"]))
        self.assertEqual(self.records()[-1]["catalogPin"], self.release_thumb)

    def test_manual_rollback_of_a_preview_image_uses_its_recorded_pin(self):
        fix = self.add_build("c" * 40, "fix", 1101)
        self.cluster_with_previous(fix, dict(F.old_record(self.new, run="1001"), catalogPin=self.thumb))
        code, events = self.cli("rollback")
        self.assertEqual((code, self.done(events)["result"]), (2, "ROLLED_BACK"), events)
        self.assertEqual((self.live()[0], self.live()[1]["catalog-pin"]), (self.new["image"], self.thumb))
        self.assertTrue(all(item["ok"] for item in self.result_file()["rollbackChecks"]))

    def test_failed_watch_restores_a_preview_image_with_its_recorded_pin(self):
        self.with_watch()
        code, events = self.cli("ship", NEW)
        self.assertEqual(code, 0, events)
        fix = self.add_build("c" * 40, "fix", 1101)
        self.behave(watchFailAfter={fix["image"]: 2})
        code, events = self.cli("deploy", fix["sha"])
        self.assertEqual((code, self.done(events)["result"]), (2, "ROLLED_BACK"), events)
        self.assertEqual((self.live()[0], self.live()[1]["catalog-pin"]), (self.new["image"], self.thumb))
        self.assertTrue(all(item["ok"] for item in self.result_file()["rollbackChecks"]))

    def test_ship_reuses_a_bound_build_and_tolerates_brief_github_errors(self):
        """Review C-L7."""
        self.gh["runs"].append(F.run_object(1001, NEW))
        self.gh["onDispatch"] = None
        self.gh["statusSequence"] = {}
        self.write_gh()
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual([c for c in self.gh_calls() if c["method"] == "POST"], [])
        self.tearDown()
        self.setUp()
        self.gh["flaky"] = 2
        self.write_gh()
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)

    def test_resource_version_churn_is_re_planned_not_fatal(self):
        """Review C-H1: a status update between app-update's plan and patch makes it refuse; the switch
        and the one rollback re-read and re-plan instead of giving up."""
        self.behave(rvChurnAfterDryRun={self.new["image"]: 2})
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual(len([e for e in events if e.get("event") == "switch-retry"]), 2)
        self.tearDown()
        self.setUp()
        self.behave(rvChurnAfterDryRun={self.old["image"]: 2}, brokenSite=[self.new["image"]])
        code, events = self.cli("ship", NEW)
        self.assert_rolled_back(code, events, "SMOKE_FAILED")
        self.assertEqual(len([e for e in events if e.get("event") == "switch-retry"]), 2)

    def test_a_switch_that_never_applies_is_aborted_not_rolled_back(self):
        """Review C-M4: nothing changed, so there is nothing to roll back."""
        self.behave(rvChurnAfterDryRun={self.new["image"]: 20})
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual(result["result"], "ABORTED", events)
        image, notes = self.live()
        self.assertEqual((image, notes["phase"]), (self.old["image"], "aborted"))
        self.assertNotIn("previous", notes)  # the earlier record is put back (none before this run)
        self.assert_only_owned_writes()
        self.assertFalse([p for p in self.patches_written() if any(op["path"].endswith("/image") and op["op"] == "replace" for op in p)])

    def test_deploy_of_a_built_commit_already_live_is_a_no_op(self):
        self.gh["runs"].append(F.run_object(1001, NEW))
        self.write_gh()
        self.set_cluster(F.cluster_state(self.builds, self.new, annotations=F.preview_annotations(self.new, run="1001")))
        code, events = self.cli("deploy", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"))
        self.assertEqual(self.cluster()["writes"], [])

    def test_failed_smoke_rolls_back_once(self):
        self.behave(brokenSite=[self.new["image"]])
        self.assert_rolled_back(*self.cli("ship", NEW), "SMOKE_FAILED: root")

    def test_drill_forces_the_rollback(self):
        self.assert_rolled_back(*self.cli("ship", NEW, "--drill-fail-smoke"), "drill")

    def test_failed_watch_rolls_back(self):
        self.with_watch()
        self.behave(watchFailAfter={self.new["image"]: 2})
        self.assert_rolled_back(*self.cli("ship", NEW), "WATCH_FAILED")

    def test_transport_errors_in_the_watch_are_tolerated_then_counted(self):
        """Review C-H3: two dropped probes pass; three in a row roll back."""
        self.with_watch()
        self.behave(transport={self.new["image"]: {"/": {"after": 2, "count": 2}}})
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.tearDown()
        self.setUp()
        self.with_watch()
        self.behave(transport={self.new["image"]: {"/": {"after": 2, "count": 3}}})
        self.assert_rolled_back(*self.cli("ship", NEW), "WATCH_FAILED")

    def test_rollout_timeout_rolls_back(self):
        self.behave(notReady=[self.new["image"]])
        self.assert_rolled_back(*self.cli("ship", NEW), "ROLLOUT_FAILED")

    def test_memory_uses_the_working_set_and_rolls_back_over_the_threshold(self):
        """Review C-L6: usage with page cache (700 MiB here) never trips it; the working set does."""
        self.behave(usage=760 * 2 ** 20)
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.tearDown()
        self.setUp()
        self.behave(workingSetByImage={self.new["image"]: 700 * 2 ** 20})
        self.assert_rolled_back(*self.cli("ship", NEW), "SMOKE_FAILED: pod")

    def test_edge_owned_headers_follow_the_edge(self):
        """Review C-M2."""
        self.behave(edgeHeaders={"Referrer-Policy": "strict-origin-when-cross-origin"})
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.tearDown()
        self.setUp()
        self.behave(edgeHeadersByImage={self.new["image"]: {"Referrer-Policy": "unsafe-url"}})
        self.assert_rolled_back(*self.cli("ship", NEW), "SMOKE_FAILED: edge headers")

    def test_post_switch_refusal_rolls_back(self):
        """A Refusal after the switch never leaves the new build live: here the smoke's DNS check.
        The live smoke before the switch makes the first DNS check; the second one fails."""
        self.behave(dnsFailAt=2)
        self.assert_rolled_back(*self.cli("ship", NEW), "UNVERIFIED: SMOKE_DNS")

    def test_unhealthy_rollback_stops_for_a_human(self):
        self.behave(brokenSite=[self.new["image"]], watchFailAfter={self.old["image"]: 1})  # the old build breaks after the switch
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (3, "ROLLBACK_UNHEALTHY"), events)
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

    def test_lost_start_reply_is_followed_by_deploy_id(self):
        """Review C-M8: a dropped link during start is uncertain, never a failure."""
        os.environ["FAKE_START_REPLY_LOST"] = "1"
        code, events = self.cli("ship", NEW)
        self.assertTrue(any(e.get("event") == "start-uncertain" for e in events))
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        os.environ.pop("FAKE_START_REPLY_LOST")
        deploy_id = self.result_file()["deployId"]
        code, events = self.cli("status", "--follow", deploy_id)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"))
        self.assertEqual(self.records()[-1]["command"], "status --follow")
        self.assertEqual(self.records()[-1]["deployId"], deploy_id)


class Refusals(EndToEnd):
    """Every refusal before a change, and the tool, profile and identity checks."""

    def test_missing_preview_pin_refuses_ship_and_deploy_before_dispatch_or_node_changes(self):
        for command in ("ship", "deploy"):
            with self.subTest(command=command), mock.patch.object(A, "PREVIEW_PUBLIC_KEY_JWK", None), \
                    mock.patch.object(A, "PREVIEW_PUBLIC_KEY_THUMBPRINT", None):
                code, events = self.cli(command, NEW)
            self.assertEqual((code, self.done(events)["code"]), (1, "PREVIEW_PIN_MISSING"), events)
        self.assertFalse(any(call["method"] == "POST" for call in self.gh_calls()))
        self.assertEqual(self.cluster()["writes"], [])

    def test_preview_anchor_cannot_be_the_release_key(self):
        with mock.patch.object(A, "PREVIEW_PUBLIC_KEY_JWK", self.release_pin), \
                mock.patch.object(A, "PREVIEW_PUBLIC_KEY_THUMBPRINT", self.release_thumb):
            code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "RELEASE_KEY"), events)
        self.assertEqual(self.cluster()["writes"], [])
        self.assertFalse(any(call["method"] == "POST" for call in self.gh_calls()))

    def test_ship_refuses_a_receipt_carrying_the_release_pin(self):
        self.gh["runs"].append(F.run_object(1001, NEW))
        self.gh["zips"]["555"] = F.receipt_zip(self.new, 1001, 1, self.release_pin, self.release_thumb)
        self.write_gh()
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "RECEIPT_INVALID"), events)
        self.assertEqual(self.cluster()["writes"], [])
        self.assertFalse(any(call["method"] == "POST" for call in self.gh_calls()))

    def test_node_refuses_a_request_pin_outside_the_anchors(self):
        request = M.Context.request
        unknown = R.jwk_thumbprint(F.make_key()[1])

        def tampered(context, kind, deploy_id, **extra):
            value = request(context, kind, deploy_id, **extra)
            if kind == "deploy":
                value["release"]["catalogPin"] = unknown
            return value

        with mock.patch.object(M.Context, "request", tampered):
            code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "CATALOG_PIN_INVALID"), events)
        self.assertEqual(self.cluster()["writes"], [])

    def test_refusals_before_any_change(self):
        cases = [
            ("lock", lambda: (self.sandbox / "unit-state").write_text("active"), "LOCK_HELD"),
            ("queued job", lambda: (self.sandbox / "unit-job").write_text("1234"), "LOCK_HELD"),
            ("check-target", lambda: os.environ.__setitem__("FAKE_CHECK_TARGET", "fail"), "CHECK_TARGET_FAILED"),
            ("capacity", lambda: self.set_cluster(dict(self.cluster(), capacity={"total": 100 * F.GIB, "available": 26 * F.GIB})), "LOW_CAPACITY"),
            ("pins ignored", lambda: self.behave(pinsIgnored=True), "PIN_FAILED"),
            ("not on main", lambda: self.gh["compare"].update({f"{NEW}...{NEW}": "behind"}), "NOT_ON_MAIN"),
            ("ci red", lambda: self.gh.update(ciRuns=[F.run_object(900, NEW, path=".github/workflows/ci.yml", event="push", conclusion="failure")]), "CI_NOT_GREEN"),
            ("candidate active", lambda: self.gh["runs"].append(F.run_object(990, "d" * 40, status="waiting", conclusion=None)), "CANDIDATE_ACTIVE"),
            ("build failed", lambda: self.gh.update(finalConclusion="failure"), "RUN_FAILED"),
            ("receipt", lambda: self.gh["zips"].update({"555": F.receipt_zip(self.new, 1001, 1, self.pin, self.thumb, **{"web.json": {}})}), "RECEIPT_INVALID"),
            ("origins changed", lambda: self.gh.update(variable={"value": F.CONNECTORS, "updated_at": "2026-10-23T06:00:00Z"}), "CONNECTOR_ORIGINS_CHANGED"),
            ("origins unproven", lambda: self.gh.update(variable={"value": "https://other.example.com", "updated_at": "2026-10-20T04:00:00Z"}), "CONNECTOR_ORIGINS_UNPROVEN"),
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
                self.assertEqual(self.patches_written(), [])
                self.assertEqual(self.live()[0], self.old["image"])
                self.assertEqual(self.records()[-1]["code"], code_name)

    def test_hold_comes_before_already_live(self):
        """Review S-M4: an unsettled phase is held even when the requested build is the live one."""
        self.gh["runs"].append(F.run_object(1001, NEW))
        self.write_gh()
        notes = F.preview_annotations(self.new, phase="rollback-unhealthy", run="1001")
        self.set_cluster(F.cluster_state(self.builds, self.new, annotations=notes))
        code, events = self.cli("deploy", NEW)
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN")

    def test_records_that_do_not_describe_the_live_image_are_refused(self):
        """Review C-H2: source and expectations from one build, the image from another."""
        notes = F.preview_annotations(self.old)
        notes["lolly.tools/preview-image"] = self.builds["rebuild"]["image"]
        self.set_cluster(F.cluster_state(self.builds, self.old, annotations=notes))
        code, events = self.cli("ship", NEW)
        self.assertEqual(self.done(events)["code"], "RECORDS_STALE")
        self.assertEqual(self.patches_written(), [])

    def test_live_build_must_pass_its_own_smoke_first(self):
        """Review C-M4: no rollback target that is already broken."""
        self.behave(brokenSite=[self.old["image"]])
        code, events = self.cli("ship", NEW)
        self.assertEqual(self.done(events)["code"], "LIVE_SMOKE_FAILED")
        self.assertEqual(self.patches_written(), [])
        self.assertEqual(self.live()[0], self.old["image"])

    def test_organisation_variable_is_used_when_the_repository_has_none(self):
        """Review C-H4: vars.VITE_CONNECTOR_ORIGINS can come from the organisation."""
        self.gh["variable"] = None
        self.gh["orgVariables"] = [{"name": "VITE_CONNECTOR_ORIGINS", "value": F.CONNECTORS, "updated_at": "2026-10-20T04:00:00Z"}]
        self.write_gh()
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)

    def test_tool_must_be_locked_clean_and_on_main(self):
        """Review S-H1, S-L3."""
        code, events = self.cli("status", tool_hash="1" * 64)
        self.assertEqual(self.done(events)["code"], "TOOL_HASH_MISMATCH")
        (self.state_dir / "tool.lock.json").unlink()
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_NOT_LOCKED")
        (self.state_dir / "tool.lock.json").write_text(json.dumps(self.lock))
        (self.checkout / "deploy/preview/lib/stray.py").write_text("import os\n")  # an untracked file beside the tool
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_HASH_MISMATCH")
        (self.checkout / "deploy/preview/lib/stray.py").unlink()
        with (self.checkout / "deploy/preview/preview-deploy.py").open("a") as handle:
            handle.write("# changed\n")
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_HASH_MISMATCH")
        subprocess.run(["git", "-C", str(self.checkout), "checkout", "--", "."], check=True)
        self.gh["toolCompare"] = "diverged"
        self.write_gh()
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_NOT_MAIN")

    def test_state_dir_and_check_target_are_fixed(self):
        """Review S-H1 and R1."""
        elsewhere = Path(self.tmp.name) / "elsewhere" / "preview"
        elsewhere.mkdir(parents=True, mode=0o700)
        code, events = self.cli("status", state_dir=elsewhere)
        self.assertEqual(self.done(events)["code"], "STATE_DIR_INVALID")
        # A copied private folder whose path ends the same way, with a forged lock and check-target.
        copy_root = Path(self.tmp.name) / "copy" / "lolly-private" / "production"
        shutil.copytree(self.production, copy_root)
        copy_root.chmod(0o700)
        code, events = self.cli("status", state_dir=copy_root / "preview", check_target=copy_root / "check-target.py")
        self.assertEqual(self.done(events)["code"], "STATE_DIR_INVALID")
        self.production.chmod(0o755)
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "STATE_DIR_INVALID")
        self.production.chmod(0o700)
        other = Path(self.tmp.name) / "check-target.py"
        F.write_check_target(other, self.bin / "k3s", self.known_hosts)
        code, events = self.cli("status", check_target=other)
        self.assertEqual(self.done(events)["code"], "CHECK_TARGET_PATH")

    def test_check_target_must_not_change_after_its_identities_were_read(self):
        """Review R1: the file that is run is the file the identities came from."""
        original = G.connector_origins

        def tamper(*args, **kwargs):
            with self.check_target_path.open("a") as handle:
                handle.write("# changed\n")
            return original(*args, **kwargs)
        with mock.patch.object(G, "connector_origins", side_effect=tamper):
            code, events = self.cli("ship", NEW)
        self.assertEqual(self.done(events)["code"], "CHECK_TARGET_CHANGED")
        self.assertEqual(self.patches_written(), [])

    def test_locked_files_are_compared_with_the_committed_blobs(self):
        """Review R2: assume-unchanged hides an edit from git status, not from the byte comparison."""
        target = self.checkout / "deploy/preview/README.md"
        git = ["git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@example.com"]
        original = target.read_bytes()
        target.write_bytes(original + b"committed elsewhere\n")
        subprocess.run(git + ["commit", "-qam", "drift"], check=True, capture_output=True)
        target.write_bytes(original)  # the locked bytes again, hidden from git status
        subprocess.run(git + ["update-index", "--assume-unchanged", "deploy/preview/README.md"], check=True)
        self.assertEqual(subprocess.run(git + ["status", "--porcelain"], capture_output=True, text=True).stdout, "")
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "TOOL_DIRTY")

    def test_backup_window_counts_the_whole_run(self):
        """Review L2: before the start by the worst case, and again inside the run before a change."""
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc)
        soon = lambda minutes: (now + datetime.timedelta(minutes=minutes)).strftime("%H:%M")
        if soon(10) < soon(70):  # skip the minutes around midnight, where the window would wrap
            self.profile["noDeployUtc"] = [soon(10), soon(70)]
            self.write_profile()
            code, events = self.cli("ship", NEW)
            refused = self.done(events)
            self.assertEqual(refused["code"], "BACKUP_WINDOW")
            self.assertIn("would reach", refused["reason"])
        self.tearDown()
        self.setUp()
        later = (now + datetime.timedelta(hours=5))
        self.profile["noDeployUtc"] = [later.strftime("%H:%M"), (later + datetime.timedelta(minutes=30)).strftime("%H:%M")]
        self.write_profile()
        os.environ["FAKE_WALL_UTC"] = (later + datetime.timedelta(minutes=5)).strftime("%H:%M")
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual((result["result"], result.get("code")), ("REFUSED", "BACKUP_WINDOW"), events)
        self.assertEqual(self.patches_written(), [])
        self.assertEqual(self.live()[0], self.old["image"])
        os.environ.pop("FAKE_WALL_UTC")

    def test_a_run_that_never_starts_is_reported_as_not_started(self):
        """The unit never leaves inactive; and, separately, the start never reached the node."""
        os.environ["FAKE_UNIT_NEVER_STARTS"] = "1"
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "NOT_STARTED"), events)
        os.environ.pop("FAKE_UNIT_NEVER_STARTS")
        self.tearDown()
        self.setUp()
        os.environ["FAKE_START_DROPPED"] = "1"
        code, events = self.cli("ship", NEW)
        self.assertTrue(any(e.get("event") == "start-uncertain" for e in events))
        self.assertEqual((code, self.done(events)["code"]), (1, "NOT_STARTED"), events)
        os.environ.pop("FAKE_START_DROPPED")
        self.assertEqual(self.patches_written(), [])
        self.assertEqual(self.records()[-1]["code"], "NOT_STARTED")

    def test_selftest_runs_check_target_first(self):
        """Review R4: selftest installs and starts a unit on the host."""
        os.environ["FAKE_CHECK_TARGET"] = "fail"
        code, events = self.cli("selftest")
        self.assertEqual((code, self.done(events)["code"]), (1, "CHECK_TARGET_FAILED"))
        self.assertFalse((self.sandbox / "run/systemd/system/lolly-preview-deploy.service").exists())

    def test_identities_come_from_check_target_not_the_profile(self):
        """Review S-M3."""
        self.profile["node"] = {"k3s": "/tmp/evil"}
        self.write_profile()
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "PROFILE_INVALID")
        del self.profile["node"]
        self.write_profile()
        text = self.check_target_path.read_text().replace("CLUSTER_UID =", "OTHER_UID =")
        self.check_target_path.write_text(text)
        code, events = self.cli("status")
        self.assertEqual(self.done(events)["code"], "CHECK_TARGET_IDENTITY")

    def test_lolly_ing_refuses_without_touching_anything(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--state-dir", str(self.state_dir), "--tool-sha256", self.tool_hash, "--checkout", str(self.checkout),
                           "--check-target", str(self.check_target_path), "lolly.ing", "ship", NEW])
        self.assertEqual(code, 1)
        self.assertIn("ING_KEY_NOT_PINNED", out.getvalue())
        self.assertEqual(self.gh_calls(), [])


class Operations(EndToEnd):
    """Manual rollback, status, gc, selftest and the one-time conversion."""

    def test_manual_rollback_and_stored_format_refusal(self):
        self.assertEqual(self.cli("ship", NEW)[0], 0)
        code, events = self.cli("rollback")
        result = self.done(events)
        self.assertEqual((code, result["result"], result["reason"]), (2, "ROLLED_BACK", "MANUAL"))
        self.assertEqual(self.live()[0], self.old["image"])
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "NO_PREVIOUS")
        self.cluster_with_previous(self.new, F.old_record(self.old), new_formats={"channelMessage": 2, "indexedDb": 27,
                                                                                  "revisionArchive": 1, "session": 4})
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "FORMAT_LOWERING")

    def test_manual_rollback_checks_the_previous_image_and_capacity_first(self):
        """Review S-L1 and C-M6."""
        record = F.old_record(self.old)
        record["image"] = "ghcr.io/evil/lolly-web@sha256:" + "1" * 64
        self.cluster_with_previous(self.new, record)
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "BAD_IMAGE")
        self.cluster_with_previous(self.new, F.old_record(self.old))
        state = self.cluster()
        state["images"] = {i: e for i, e in state["images"].items() if self.old["image"] not in e["refs"]}
        state["capacity"] = {"total": 100 * F.GIB, "available": 26 * F.GIB}
        self.set_cluster(state)
        code, events = self.cli("rollback")
        result = self.done(events)
        self.assertEqual((code, result["result"], result.get("code")), (1, "REFUSED", "LOW_CAPACITY"), events)
        self.assertEqual(self.live()[0], self.new["image"])
        self.assertEqual(self.patches_written(), [])

    def test_status_reports_the_live_phase(self):
        code, events = self.cli("status")
        status = [e for e in events if e.get("event") == "status"][0]
        self.assertEqual((code, status["phase"], status["source"], status["converted"], status["recordsDescribeLiveImage"]),
                         (0, "accepted", OLD, True, True))
        self.assertEqual(status["pods"], [{"name": "sovereign-web-23", "phase": "Running", "restarts": 0, "ready": True}])  # C-M3

    def test_gc_reports_first_and_removes_only_its_own_images(self):
        """Review S-M1 and C-M5."""
        state = self.cluster()
        own = F.IMAGE_REPO + "@sha256:" + "e" * 64
        foreign = F.IMAGE_REPO + "@sha256:" + "d" * 64
        tagged = F.IMAGE_REPO + "@sha256:" + "c" * 64
        state["replicasets"].insert(0, {"uid": "rs-22", "revision": 22, "image": self.old["image"], "template": "claim-layout"})
        for ref, labels, extra in ((own, {"lolly.tools/preview-pulled": "true", "lolly.tools/preview-pin": "true",
                                          "io.cri-containerd.pinned": "pinned"}, ()),
                                   (foreign, {"io.cri-containerd.pinned": "pinned"}, ()),
                                   (tagged, {"lolly.tools/preview-pulled": "true"}, (F.IMAGE_REPO + ":candidate-x",))):
            image_id, entry = F.image_entry(ref, labels, extra)
            state["images"][image_id] = entry
        self.set_cluster(state)
        code, events = self.cli("gc", "--execute")
        self.assertEqual(self.done(events)["code"], "GC_REPORT_FIRST")
        code, events = self.cli("gc")
        images = [e for e in events if e.get("event") == "gc-images"][0]
        self.assertEqual((code, images["remove"], sorted(images["untouched"])), (0, [own], [tagged]))
        claims = {e["name"]: e for e in events if e.get("event") == "gc-claim"}
        self.assertEqual(set(claims), {"lolly-public-web-test-v1"})
        self.assertFalse(claims["lolly-public-web-test-v1"]["candidate"])
        self.assertIn("referenced by a retained ReplicaSet or StatefulSet (a rollback point)", claims["lolly-public-web-test-v1"]["blockedBy"])
        self.assertIsNotNone(self.node_image(own))  # a report changes nothing
        code, events = self.cli("gc", "--execute")
        self.assertEqual((code, self.done(events)["result"]), (0, "GC_DONE"), events)
        self.assertIsNone(self.node_image(own))
        for kept in (foreign, tagged, self.old["image"]):
            self.assertIsNotNone(self.node_image(kept), kept)
        self.assertEqual(self.node_image(foreign)["refs"][foreign], {"io.cri-containerd.pinned": "pinned"})

    def test_gc_lists_unused_foreign_images_as_commands_for_andy(self):
        """Review N3: images other procedures left, never removed by the command."""
        state = self.cluster()
        foreign = F.IMAGE_REPO + "@sha256:" + "d" * 64
        image_id, entry = F.image_entry(foreign, {"io.cri-containerd.pinned": "pinned"}, (F.IMAGE_REPO + ":candidate-old",))
        state["images"][image_id] = entry
        self.set_cluster(state)
        code, events = self.cli("gc")
        listed = [e for e in events if e.get("event") == "gc-foreign-image"]
        self.assertEqual(len(listed), 1)
        self.assertEqual((listed[0]["id"], listed[0]["pinnedBy"], listed[0]["pinnedRefs"]), (image_id, "another procedure", [foreign]))
        self.assertEqual(sorted(listed[0]["refs"]), sorted([foreign, F.IMAGE_REPO + ":candidate-old"]))
        self.assertGreater(listed[0]["sizeBytes"], 0)
        commands = listed[0]["forAndy"]
        self.assertIn("--site lolly.tools", commands[0])
        self.assertTrue(any("images label " + foreign + " io.cri-containerd.pinned=" in c for c in commands))
        self.assertIn("crictl --timeout 120s rmi " + image_id, commands[-1])
        live_id = next(i for i, e in self.cluster()["images"].items() if self.old["image"] in e["refs"])
        self.assertNotIn(live_id, [e["id"] for e in listed])  # the live image is kept, so it is never listed
        code, events = self.cli("gc", "--execute")
        self.assertEqual(self.done(events)["result"], "GC_DONE")
        self.assertIsNotNone(self.node_image(foreign))
        self.assert_crictl_deadlines()

    def run_for_andy(self, line):
        """Run one printed node command line as Andy would, with a sudo that runs its arguments."""
        sudo = Path(self.tmp.name) / "sudo-bin"
        if not sudo.exists():
            sudo.mkdir()
            (sudo / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
            (sudo / "sudo").chmod(0o755)
        environment = dict(os.environ, PATH=f"{sudo}:{os.environ['PATH']}")
        return subprocess.run(["/bin/sh", "-c", line], capture_output=True, text=True, env=environment, check=False)

    def test_printed_commands_carry_a_deadline_and_skip_an_image_already_gone(self):
        """crictl's 2 s default deadline cut Andy's rmi of a 1.15 GB image; containerd removed it anyway."""
        state = self.cluster()
        foreign = F.IMAGE_REPO + "@sha256:" + "d" * 64
        image_id, entry = F.image_entry(foreign, {"io.cri-containerd.pinned": "pinned"})
        state["images"][image_id] = entry
        state["behaviour"]["rmiSecondsById"] = {image_id: 300}  # longer than even the printed 120 s
        self.set_cluster(state)
        code, events = self.cli("gc")
        commands = [e for e in events if e.get("event") == "gc-foreign-image"][0]["forAndy"]
        unpin, remove = commands[2], commands[3]
        for line in (unpin, remove):
            self.assertIn("crictl --timeout 30s inspecti " + image_id, line)
        before = len(self.cluster()["crictlCalls"])
        done = self.run_for_andy(unpin)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("io.cri-containerd.pinned", self.node_image(foreign)["refs"][foreign])
        done = self.run_for_andy(remove)
        self.assertIn("DeadlineExceeded", done.stderr)
        self.assertIsNone(self.node_image(foreign))  # containerd finished after crictl gave up
        for line in (remove, unpin):  # run again: nothing to do, and it says so
            done = self.run_for_andy(line)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("skipped: " + image_id + " is not listed", done.stdout)
        calls = self.cluster()["crictlCalls"][before:]
        self.assertTrue(calls and all(call["explicit"] for call in calls), calls)
        self.assertEqual([call["deadline"] for call in calls if call["command"] == "rmi"], [120.0])
        writes = [w for w in self.cluster()["writes"] if w and w[0] == "rmi"]
        self.assertEqual(len(writes), 1)
        code, events = self.cli("gc")
        self.assertEqual([e for e in events if e.get("event") == "gc-foreign-image"], [])

    def own_image(self, state, letter, **behaviour):
        """An unused image this command pulled itself, so gc may remove it."""
        ref = F.IMAGE_REPO + "@sha256:" + letter * 64
        image_id, entry = F.image_entry(ref, {"lolly.tools/preview-pulled": "true", "lolly.tools/preview-pin": "true",
                                              "io.cri-containerd.pinned": "pinned"})
        entry["size"] = 1150 * 10 ** 6
        state["images"][image_id] = entry
        for name, value in behaviour.items():
            if isinstance(state["behaviour"].get(name), dict):
                state["behaviour"][name][image_id] = value
            elif isinstance(state["behaviour"].get(name), list):
                state["behaviour"][name].append(image_id)
            else:
                state["behaviour"][name] = [image_id] if value is True else {image_id: value}
        return ref, image_id

    def test_gc_checks_a_removal_that_outlives_crictls_deadline(self):
        state = self.cluster()
        at_once, at_once_id = self.own_image(state, "e", rmiSecondsById=300)
        later, later_id = self.own_image(state, "f", rmiSecondsById=300, rmiFinishesAfterReads=3)
        quick, _ = self.own_image(state, "9")
        self.set_cluster(state)
        self.cli("gc")
        code, events = self.cli("gc", "--execute")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "GC_DONE"), events)
        outcomes = {item["ref"]: item for item in result["retention"]["removals"]}
        self.assertEqual({ref: item["outcome"] for ref, item in outcomes.items()},
                         {at_once: "removed-after-error", later: "removed-after-error", quick: "removed"})
        for ref in (at_once, later):
            self.assertTrue(outcomes[ref]["deadlineExceeded"], outcomes[ref])
            self.assertIn("level=fatal msg=\"error of removing image", outcomes[ref]["error"])
            self.assertIn("DeadlineExceeded", outcomes[ref]["error"])
            self.assertIsNone(self.node_image(ref))
        self.assertEqual(sorted(result["retention"]["removed"]), sorted([at_once, later, quick]))
        self.assertEqual(result["retention"]["notRemoved"], [])
        self.assertEqual(self.records()[-1]["result"], "GC_DONE")
        self.assertTrue((self.sandbox / "var/lib/lolly-preview/retention-armed").exists())
        self.assert_crictl_deadlines()

    def test_gc_reports_an_image_that_stays_after_a_failed_removal(self):
        state = self.cluster()
        stuck, stuck_id = self.own_image(state, "e", rmiStuck=True)
        self.set_cluster(state)
        self.cli("gc")
        code, events = self.cli("gc", "--execute")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (1, "GC_INCOMPLETE"), events)
        item = result["retention"]["removals"][0]
        self.assertEqual((item["ref"], item["id"], item["outcome"], item["deadlineExceeded"]), (stuck, stuck_id, "still-present", True))
        self.assertEqual((result["retention"]["removed"], result["retention"]["notRemoved"]), ([], [stuck]))
        self.assertIsNotNone(self.node_image(stuck))
        self.assertEqual(self.records()[-1]["result"], "GC_INCOMPLETE")
        code, events = self.cli("gc")  # still this command's own image, so the next report lists it again
        self.assertEqual([e for e in events if e.get("event") == "gc-images"][0]["remove"], [stuck])

    def test_retention_after_a_deploy_starts_a_removal_only_while_one_fits(self):
        self.cli("gc")
        code, events = self.cli("gc", "--execute")  # arms retention after accepted deploys
        self.assertEqual(self.done(events)["result"], "GC_DONE")
        state = self.cluster()
        stuck = [self.own_image(state, letter, rmiStuck=True)[0] for letter in "cef"]
        self.set_cluster(state)
        code, events = self.cli("ship", NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)  # retention never changes a deploy's result
        outcomes = sorted(item["outcome"] for item in result["retention"]["removals"])
        self.assertEqual(outcomes, ["deferred", "still-present", "still-present"])
        self.assertEqual(sorted(result["retention"]["notRemoved"]), sorted(stuck))
        self.assertEqual(len([w for w in self.cluster()["writes"] if w and w[0] == "rmi"]), 2)
        for ref in stuck:
            self.assertIsNotNone(self.node_image(ref))

    def test_adopt_is_the_way_forward_after_an_unhealthy_rollback(self):
        """Review N2: records re-seeded from a bound build, never by dispatching one."""
        fix = self.add_build("c" * 40, "fix", 1101)
        self.behave(brokenSite=[self.new["image"]], watchFailAfter={self.old["image"]: 1})
        code, events = self.cli("ship", NEW)
        self.assertEqual(self.done(events)["result"], "ROLLBACK_UNHEALTHY")
        posts = len([c for c in self.gh_calls() if c["method"] == "POST"])
        self.update_gh(mainHead="c" * 40)
        code, events = self.cli("ship", "c" * 40, "--clear-hold")  # stale records: refused before any build
        self.assertEqual(self.done(events)["code"], "RECORDS_STALE")
        self.assertEqual(len([c for c in self.gh_calls() if c["method"] == "POST"]), posts)
        code, events = self.cli("adopt", OLD)  # the old build is broken, so adopt refuses
        self.assertEqual(self.done(events)["code"], "ADOPT_SMOKE_FAILED")
        self.assertEqual(self.live()[1]["phase"], "rollback-unhealthy")
        code, events = self.cli("adopt", OLD, "--clear-hold")
        self.assertEqual((code, self.done(events)["result"]), (3, "ADOPTED_UNHEALTHY"))
        image, notes = self.live()
        self.assertEqual((image, notes["image"], notes["source"], notes["phase"]), (self.old["image"], self.old["image"], OLD, "adopted-unhealthy"))
        code, events = self.cli("deploy", "c" * 40)
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN")
        code, events = self.cli("deploy", "c" * 40, "--clear-hold")
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual(self.live()[0], fix["image"])

    def test_adopt_of_an_old_live_image_works_without_a_preview_pin(self):
        with mock.patch.object(A, "PREVIEW_PUBLIC_KEY_JWK", None), \
                mock.patch.object(A, "PREVIEW_PUBLIC_KEY_THUMBPRINT", None), mock.patch.dict(os.environ):
            os.environ.pop("FAKE_PREVIEW_PIN")
            code, events = self.cli("adopt", OLD)
        self.assertEqual((code, self.done(events)["result"]), (0, "ADOPTED"), events)
        self.assertEqual(self.live()[1]["catalog-pin"], self.release_thumb)

    def test_adopt_of_a_healthy_live_build_restores_accepted_records(self):
        notes = F.preview_annotations(self.old, phase="rolling-back")
        notes["lolly.tools/preview-image"] = self.new["image"]
        self.set_cluster(F.cluster_state(self.builds, self.old, annotations=notes))
        code, events = self.cli("adopt", OLD)
        self.assertEqual((code, self.done(events)["result"]), (0, "ADOPTED"), events)
        image, notes = self.live()
        self.assertEqual((notes["phase"], notes["image"], notes["source"], notes["reason"]), ("accepted", self.old["image"], OLD, "ADOPTED"))
        self.assert_only_owned_writes()

    def test_status_follow_reattaches_to_a_running_unit(self):
        """A dropped link while the unit runs: ship detaches, status --follow sees it running and records the end."""
        os.environ.update(FAKE_UNIT_ASYNC="1", FAKE_UNIT_DELAY="3", FAKE_POLL_DOWN="1")
        code, events = self.cli("ship", NEW)
        detached = self.done(events)
        self.assertEqual(detached["result"], "DETACHED", events)
        os.environ.pop("FAKE_POLL_DOWN")
        code, events = self.cli("status", "--follow", detached["deployId"])
        self.assertTrue(any(e.get("event") == "following" and e.get("unit") == "active" for e in events), events)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual((self.records()[-1]["command"], self.records()[-1]["result"]), ("status --follow", "LIVE"))
        for name in ("FAKE_UNIT_ASYNC", "FAKE_UNIT_DELAY"):
            os.environ.pop(name)

    def test_claim_command_for_andy_carries_a_uid_precondition(self):
        """Review C-L5 and S-L6."""
        state = self.cluster()
        state["pvcs"] = [{"metadata": {"name": "lolly-public-web-test-v1", "uid": "pvc-uid-1", "labels": {}}}]
        state["deployment"]["metadata"]["annotations"]["lolly.tools/preview-deploys"] = "2"
        self.set_cluster(state)
        context = mock.Mock(identity={"k3s": "/usr/local/bin/k3s", "kubeconfig": "/root/k config", "context": "c"},
                            anchors=A.TOOLS, check_target_path=self.check_target_path, site="lolly.tools")
        commands = M.claim_commands(context, {"name": "lolly-public-web-test-v1", "uid": "pvc-uid-1"})
        self.assertIn("check-target.py' --site lolly.tools", commands[0].replace(str(self.check_target_path), "check-target.py'"))
        self.assertIn('"preconditions":{"uid":"pvc-uid-1"}', commands[2])
        self.assertIn("'/root/k config'", commands[2])
        self.assertIn("delete --raw /api/v1/namespaces/lolly-public/persistentvolumeclaims/lolly-public-web-test-v1 -f -", commands[2])

    def test_selftest_runs_inside_the_unit_and_changes_nothing(self):
        """Review C-M7."""
        code, events = self.cli("selftest")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "SELFTEST_OK"), events)
        self.assertEqual(self.patches_written(), [])
        (self.sandbox / "proc-status").write_text("NoNewPrivs:\t0\n")
        code, events = self.cli("selftest")
        self.assertEqual(self.done(events)["result"], "SELFTEST_FAILED")
        failed = [e for e in events if e.get("event") == "selftest-result" and not e["ok"]]
        self.assertEqual([e["check"] for e in failed], ["no new privileges"])

    def test_previous_request_is_kept_beside_its_result(self):
        """Review C-L3."""
        self.assertEqual(self.cli("selftest")[0], 0)
        self.assertEqual(self.cli("selftest")[0], 0)
        kept = list((self.sandbox / "var/lib/lolly-preview/results").glob("*.request.json"))
        self.assertEqual(len(kept), 1)

    def test_plan_then_apply_converts_with_the_same_bytes(self):
        plan = self.converted_plan(rebuild_newer=True)
        self.assertEqual(json.loads(Path(plan["path"]).read_text())["run"]["run"], 800)  # the live image's run
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", "0" * 64)
        self.assertEqual(self.done(events)["code"], "PLAN_MISMATCH")
        self.behave(rvChurnRate=0.5)  # the plan's resourceVersion is long gone: the node recomputes
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", plan["reviewedPlanSha256"])
        self.assertEqual((code, self.done(events)["result"]), (0, "CONVERTED"), events)
        image, notes = self.live()
        deploy = self.cluster()["deployment"]
        self.assertEqual(image, self.old["image"])
        self.assertEqual((notes["phase"], notes["source"], notes["image"], notes["layout"], notes["deploys"]),
                         ("accepted", OLD, self.old["image"], "image-root", "0"))
        self.assertEqual(deploy["spec"]["revisionHistoryLimit"], 5)
        self.assertTrue(L.is_converted(deploy, 0, A.TOOLS))
        code, events = self.cli("ship", NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)

    def test_plan_refuses_a_live_site_failing_more_than_headers(self):
        """Review C-M1."""
        self.set_cluster(F.cluster_state(self.builds, self.old, converted=False))
        self.behave(brokenSite=[self.old["image"]])
        code, events = self.cli("plan", OLD)
        self.assertEqual(self.done(events)["code"], "PRECONVERSION_SMOKE")
        self.assertEqual(list((self.state_dir / "plans").glob("*.json")) if (self.state_dir / "plans").exists() else [], [])

    def test_apply_refuses_when_the_live_deployment_moved_from_the_plan(self):
        """Review C-M9: the node recomputes the plan from live state."""
        plan = self.converted_plan()
        state = self.cluster()
        state["deployment"]["spec"]["template"]["spec"]["volumes"].append({"name": "extra", "emptyDir": {}})
        self.set_cluster(state)
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", plan["reviewedPlanSha256"])
        self.assertEqual(self.done(events).get("code"), "PLAN_MISMATCH", events)
        self.assertEqual(self.patches_written(), [])

    def test_failed_conversion_restores_the_claim_layout(self):
        plan = self.converted_plan()
        self.behave(rvChurnRate=0.5)
        code, events = self.cli("plan", OLD, "--apply", plan["path"], "--reviewed-plan-sha256", plan["reviewedPlanSha256"],
                                "--drill-fail-smoke")
        self.assertEqual((code, self.done(events)["result"]), (2, "CONVERSION_REVERTED"), events)
        deploy = self.cluster()["deployment"]
        self.assertFalse(L.is_converted(deploy, 0, A.TOOLS))
        self.assertEqual(deploy["spec"]["revisionHistoryLimit"], 2)
        self.assertEqual(deploy["spec"]["template"], F.deployment(self.old["image"], converted=False)["spec"]["template"])


class Endurance(EndToEnd):
    """Review N1: the records stay the same size however many deploys go by."""

    def test_twenty_accepted_deploys_keep_the_annotations_bounded(self):
        sizes = []
        for number in range(20):
            sha = f"{number + 10:02d}" * 20
            build = self.add_build(sha, f"build {number}", 3000 + number)
            code, events = self.cli("deploy", sha)
            self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events[-3:])
            annotations = self.cluster()["deployment"]["metadata"]["annotations"]
            previous = json.loads(annotations["lolly.tools/preview-previous"])
            self.assertTrue(previous["prior"] is None or ("prior" not in previous["prior"] and "edge" not in previous["prior"]))
            self.assertEqual(self.live()[0], build["image"])
            sizes.append(len(json.dumps(annotations)))
        self.assertLess(max(sizes), 24 * 1024)
        self.assertLessEqual(sizes[-1], sizes[2] + 256)  # steady state from the third deploy on, not growth
        self.assert_only_owned_writes()


if __name__ == "__main__":
    unittest.main()
