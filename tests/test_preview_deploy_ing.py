# SPDX-License-Identifier: MPL-2.0
"""lolly.ing preview deploy tests (PROPOSAL section 4). Fakes only: no network, cluster, node or GitHub.

The unit tests cover the generation rule, the generation-only config change, the
migration guard, the build manifest of suse-lolly's lolly-ing-preview.yml (PR #28),
the key rules and the guarded patches. The end-to-end tests also cover the
preview-grade route (Andy, 2026-10-27): the qualification rule, no approvals, every
migration class after a verified backup, and the hold after a non-additive one. They read Work's real classifier output (PR
#207) and real restore rehearsal results (PR #208) from tests/fixtures/preview-ing.
The end-to-end tests drive the real command through the fake executables; the
restore rehearsal is the real driver (lib/preview_rehearsal.py) against #208's own
fake kubectl.
"""
import base64
import contextlib
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
import preview_deploy_ing_fakes as IF  # noqa: E402
import preview_anchors as A  # noqa: E402
import preview_common as C  # noqa: E402
import preview_github as G  # noqa: E402
import preview_ing as I  # noqa: E402
import preview_mac as M  # noqa: E402
import preview_receipt as R  # noqa: E402

W_OLD, W_NEW, W_NEXT = "3" * 40, "4" * 40, "6" * 40
S_HEAD = "5" * 40
GIB = 2 ** 30
FIXTURES = TESTS / "fixtures" / "preview-ing"


def refused(test, function, code):
    with test.assertRaises(C.Refusal) as caught:
        function()
    test.assertEqual(caught.exception.code, code, caught.exception.message)
    return caught.exception


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class IngRules(unittest.TestCase):
    def setUp(self):
        self.key = F.make_key()
        self.patch = mock.patch.object(A, "ING_PUBLIC_KEY_JWK", self.key[1])
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.build = IF.make_ing_build(self.key, W_NEW, "new", seq=3001, suse=S_HEAD)
        self.run = IF.ing_run(1100, S_HEAD)

    def test_generation_is_one_above_every_input(self):
        """R20 S16: the live config, every config ConfigMap, the database row and the pack's seq."""
        self.assertEqual(I.next_generation(3008, [3008, 3009], 3008, 3001), 3010)
        self.assertEqual(I.next_generation(3008, [3008], 3020, 3001), 3021)  # an interrupted run left the database ahead
        self.assertEqual(I.next_generation(3008, [3008, 3015], 3008, 3001), 3016)
        self.assertEqual(I.next_generation(3008, [3008], 3008, 4000), 4001)  # a key change signed with --min-seq
        refused(self, lambda: I.next_generation(3008, [3008], None, 3001), "GENERATION_UNKNOWN")

    def test_the_config_changes_only_the_generation(self):
        """R22 S3: access mode, guest links and AI policy never change."""
        live = IF.instance_json(3008)
        text = I.with_generation(live, 3010)
        before, after = json.loads(live), json.loads(text)
        self.assertEqual(after["instance"]["catalogPublicationGeneration"], 3010)
        after["instance"]["catalogPublicationGeneration"] = 3008
        self.assertEqual(before, after)
        self.assertEqual(I.config_generation(text), 3010)
        refused(self, lambda: I.with_generation(live, 3008), "GENERATION_NOT_HIGHER")
        refused(self, lambda: I.with_generation(json.dumps({"instance": {"name": "x"}}), 3010), "CONFIG_INVALID")

    def manifest(self, **overrides):
        return IF.ing_manifest(self.build, 1100, **overrides)

    def test_the_suse_lolly_manifest_binds_to_its_run_and_the_work_commit(self):
        """suse-lolly #28's manifest, bound to the run (R22 S6)."""
        release = I.validate_manifest(self.manifest(), self.run, W_NEW)
        self.assertEqual((release["image"], release["source"], release["suse"], release["lolly"]),
                         (self.build["image"], W_NEW, S_HEAD, self.build["lolly"]))
        self.assertEqual(release["refName"], IF.ING_IMAGE + ":run-1100-1")
        self.assertEqual(set(release), I.RELEASE_KEYS)
        refused(self, lambda: I.validate_manifest(self.manifest(), self.run, W_OLD), "MANIFEST_SOURCE")
        moved = dict(self.run, head_sha="7" * 40)  # the run's head commit is not the suse-lolly commit it built
        refused(self, lambda: I.validate_manifest(self.manifest(), moved, W_NEW), "MANIFEST_INVALID")
        other = self.manifest()
        other["run"]["runId"] = 1101
        refused(self, lambda: I.validate_manifest(other, self.run, W_NEW), "MANIFEST_INVALID")
        renamed = self.manifest()
        renamed["image"]["archive"]["name"] = "lolly-ing-instance-1099-1.oci.tar"
        refused(self, lambda: I.validate_manifest(renamed, self.run, W_NEW), "MANIFEST_INVALID")
        refused(self, lambda: I.validate_manifest(self.manifest(kind="lolly-ing-release"), self.run, W_NEW), "MANIFEST_INVALID")
        unbooted = self.manifest(boot={"readyz": {"status": 503}})
        refused(self, lambda: I.validate_manifest(unbooted, self.run, W_NEW), "MANIFEST_INVALID")

    def test_a_build_pinned_to_the_release_key_is_refused(self):
        """PROPOSAL 4.7 item 4: no pin, signature or build setting may name the platform release key."""
        pinned = IF.make_ing_build(self.key, W_NEW, "new", seq=3001, suse=S_HEAD, pin=A.RELEASE_PUBLIC_KEY_THUMBPRINT)
        refused(self, lambda: I.validate_manifest(IF.ing_manifest(pinned, 1100), self.run, W_NEW), "RELEASE_KEY")
        signed = self.manifest()
        signed["catalog"]["keyId"] = A.RELEASE_PUBLIC_KEY_THUMBPRINT
        refused(self, lambda: I.validate_manifest(signed, self.run, W_NEW), "RELEASE_KEY")
        other = self.manifest()
        other["buildSettings"]["pinThumbprint"] = R.jwk_thumbprint(F.make_key()[1])
        refused(self, lambda: I.validate_manifest(other, self.run, W_NEW), "KEY_MISMATCH")
        refused(self, lambda: I.refuse_release_key(I.boot_key_id(
            f"[lolly-work] catalog signing on (keyId {A.RELEASE_PUBLIC_KEY_THUMBPRINT})\n"), "boot"), "RELEASE_KEY")
        self.assertIsNone(I.boot_key_id("[lolly-work] catalog signing unavailable: no key\n"))

    def test_catalog_envelope_must_verify_against_the_lolly_ing_pin(self):
        index = b'{"version":1}'
        thumb = R.jwk_thumbprint(self.key[1])

        def envelope(key_id=thumb, signer=self.key, index_hash=None):
            body = {"alg": "ECDSA-P256-SHA256", "keyId": key_id, "signedAt": "2026-10-24T00:00:00Z", "seq": 3,
                    "indexHash": index_hash or F.sha(index), "files": {}}
            body["signature"] = base64.urlsafe_b64encode(IF.sign_raw(signer[0], C.canonical_js_json(body).encode())).rstrip(b"=").decode()
            return json.dumps(body).encode()
        I.verify_catalog(index, envelope(), self.key[1], thumb)
        refused(self, lambda: I.verify_catalog(index, envelope(signer=F.make_key()), self.key[1], thumb), "CATALOG_SIGNATURE")
        refused(self, lambda: I.verify_catalog(index, envelope(key_id=A.RELEASE_PUBLIC_KEY_THUMBPRINT), self.key[1], thumb), "RELEASE_KEY")
        refused(self, lambda: I.verify_catalog(index, envelope(index_hash="0" * 64), self.key[1], thumb), "CATALOG_SIGNATURE")

    def test_the_migration_manifest_is_works_and_the_rehearsals(self):
        """LW_MIGRATE_EXPECT is #207's sha256 manifest form, computed the same way by #207, #208 and this tool."""
        import preview_rehearsal as RH
        pending = [IF.fixture_migration(IF.ADDITIVE), IF.fixture_migration(IF.MAINTENANCE)]
        self.assertEqual(I.migration_manifest(pending), fixture("classify-0077-0078.json")["manifest"])  # #207's own output
        self.assertEqual(I.migration_manifest(pending), RH.migration_manifest(pending))
        self.assertEqual(I.expect_value(pending), RH.migrate_expectation(pending))
        self.assertEqual((I.expect_value([]), RH.migrate_expectation([])), ("none", "none"))

    def test_works_classifier_output_is_read_as_it_prints_it(self):
        """The real `classify-migrations.ts --json --only` output (#207): one pretty-printed document."""
        pending = [IF.fixture_migration(IF.ADDITIVE), IF.fixture_migration(IF.MAINTENANCE)]
        text = (FIXTURES / "classify-0077-0078.json").read_text()
        classes = I.validate_classes(I.json_document("node: some warning\n" + text), pending)
        self.assertEqual({name: item["class"] for name, item in classes.items()}, {IF.ADDITIVE: "additive", IF.MAINTENANCE: "maintenance"})
        refused(self, lambda: I.validate_classes(I.json_document(text), pending[:1]), "CLASSIFIER")  # not exactly the pending set
        changed = [dict(pending[0], sha256="0" * 64), pending[1]]
        refused(self, lambda: I.validate_classes(I.json_document(text), changed), "MIGRATIONS_MISMATCH")
        self.assertIsNone(I.json_document(text + "trailing"))

    def test_real_rehearsal_results_are_checked_again(self):
        """#208's own results: PASSED is accepted only for the same pending set and images; every failure refuses."""
        passed = fixture("rehearsal-passed.json")
        images = passed["images"]
        summary = I.check_rehearsal(passed, passed["pending"], images["new"], images["previous"])
        self.assertEqual((summary["result"], summary["expect"]), ("PASSED", passed["expect"]))
        none = fixture("rehearsal-no-pending.json")
        I.check_rehearsal(none, [], none["images"]["new"], none["images"]["previous"])
        for name in ("rehearsal-previous-image-failed.json", "rehearsal-lock-budget.json"):
            with self.subTest(name=name):
                result = fixture(name)
                refused(self, lambda: I.check_rehearsal(result, result["pending"], images["new"], images["previous"]), "REHEARSAL_FAILED")
        refused(self, lambda: I.check_rehearsal(passed, passed["pending"][:1], images["new"], images["previous"]), "REHEARSAL_FAILED")
        refused(self, lambda: I.check_rehearsal(passed, passed["pending"], images["previous"], images["new"]), "REHEARSAL_FAILED")
        leaking = dict(passed, teardownComplete=False)
        refused(self, lambda: I.check_rehearsal(leaking, passed["pending"], images["new"], images["previous"]), "REHEARSAL_FAILED")

    def check(self, ledger, files, generation=3008):
        return {"kind": "lolly-migrate-check", "version": 1, "files": files, "ledger": ledger, "publicationGeneration": generation}

    def test_migration_guard(self):
        """PROPOSAL 4.4 and design C 6.2: pending, database-ahead and order rules."""
        base = [m["name"] for m in IF.BASE_MIGRATIONS]
        extra = IF.fixture_migration(IF.ADDITIVE)
        migrations = IF.BASE_MIGRATIONS + [extra]
        plan = I.migration_plan(migrations, self.check(base, migrations), set())
        self.assertEqual(plan["pending"], [extra])
        refused(self, lambda: I.migration_plan(IF.BASE_MIGRATIONS, self.check(base + [IF.ADDITIVE], IF.BASE_MIGRATIONS), set()),
                "DATABASE_AHEAD")
        ahead = I.migration_plan(IF.BASE_MIGRATIONS, self.check(base + [IF.ADDITIVE], IF.BASE_MIGRATIONS), {IF.ADDITIVE})
        self.assertEqual((ahead["pending"], ahead["ahead"]), ([], [IF.ADDITIVE]))
        changed = [dict(m) for m in migrations]
        changed[3]["sha256"] = "0" * 64
        refused(self, lambda: I.migration_plan(changed, self.check(base, migrations), set()), "MIGRATIONS_MISMATCH")
        early = IF.migration("0002_early_extra.sql")
        plan = I.migration_plan(IF.BASE_MIGRATIONS + [early], self.check(base, IF.BASE_MIGRATIONS + [early]), set())
        self.assertEqual(plan["outOfOrder"], ["0002_early_extra.sql"])

    def test_jobs_carry_only_the_database_environment(self):
        """R22 S5: never the catalog key, session or IdP secrets."""
        deploy = IF.ing_deployment(self.build["image"], "cfg")
        env = I.database_env(deploy, 0, IF.DATABASE_SECRET)
        self.assertEqual([e["name"] for e in env], ["DATABASE_URL"])
        job = I.job_manifest("j", "migrate", "20261024T000000Z-ing-deploy-44444444", deploy, 0, self.build["image"],
                             list(A.MIGRATION_RUNNER), env + [{"name": "LW_MIGRATE_EXPECT", "value": "none"}], 300)
        spec = job["spec"]["template"]["spec"]
        self.assertIs(spec["automountServiceAccountToken"], False)
        self.assertEqual(sorted(v["name"] for v in spec["volumes"]), ["postgres-ca", "tmp"])
        self.assertEqual(spec["containers"][0]["imagePullPolicy"], "Never")
        refused(self, lambda: I.job_manifest("j", "migrate", "x", deploy, 0, self.build["image"], ["node"],
                                             env + [{"name": "LW_SESSION_SECRET", "value": "x"}], 300), "BAD_JOB")
        refused(self, lambda: I.database_env(deploy, 0, "another-secret"), "DATABASE_ENV")

    def test_switch_patch_changes_image_and_config_only(self):
        deploy = IF.ing_deployment(IF.ING_IMAGE + "@sha256:" + "1" * 64, "cfg-old")
        patch = I.switch_patch(deploy, 0, self.build["image"], "cfg-new", {"lolly.tools/preview-phase": "switched-unverified"})
        after = F.apply_json_patch(deploy, patch)
        I.guard_switch(deploy, after, 0, self.build["image"], "cfg-new")
        widened = json.loads(json.dumps(after))
        widened["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["memory"] = "2Gi"
        refused(self, lambda: I.guard_switch(deploy, widened, 0, self.build["image"], "cfg-new"), "SWITCH_GUARD")
        moved = json.loads(json.dumps(deploy))
        moved["metadata"]["resourceVersion"] = "501"
        with self.assertRaises(ValueError):
            F.apply_json_patch(moved, patch)

    def test_the_shared_unit_budget_covers_the_longest_lolly_ing_run(self):
        import preview_ing_mac
        stub = type("Stub", (), {"profile": {"rolloutTimeoutSeconds": A.MAX_ROLLOUT_SECONDS, "watch": {"minutes": A.MAX_WATCH_MINUTES}},
                                 "expect_migrations": True})()
        for kind in ("deploy", "convert", "rollback", "gc"):
            self.assertLessEqual(preview_ing_mac.IngContext.worst_case_seconds(stub, kind), A.UNIT_RUNTIME_MAX_SECONDS, kind)
        unit = (ROOT / "deploy/preview/node/lolly-preview-deploy.service").read_text()
        self.assertIn(f"RuntimeMaxSec={A.UNIT_RUNTIME_MAX_SECONDS}\n", unit)
        self.assertEqual(A.UNIT_RUNTIME_MAX_SECONDS, max(A.TOOLS_RUNTIME_MAX_SECONDS, A.ING_RUNTIME_MAX_SECONDS))
        self.assertGreaterEqual(A.REHEARSAL_TIMEOUT_SECONDS, A.REHEARSAL_DEADLINE_SECONDS + 300 + 180)  # start wait and teardown

    def test_cutover_plan_drops_the_claims_and_reverts_exactly(self):
        """PROPOSAL 4.8: shell, pack and engine-pin mounts go; the instance image and generation N come in."""
        before = IF.ing_deployment(IF.LEGACY_IMAGE, "cfg-3008", converted=False)
        plan = I.cutover_plan(before, 0, self.build["image"], "cfg-3010", {"lolly.tools/preview-phase": "converting"},
                              IF.ING_SIGNING_SECRET)
        after = F.apply_json_patch(before, plan["patch"])
        self.assertTrue(I.is_converted(after, 0) and not I.is_converted(before, 0))
        I.guard_cutover(before, after, 0, plan)
        self.assertEqual(sorted(v["name"] for v in plan["volumes"]), ["engine-pin", "pack", "shell"])
        back = F.apply_json_patch(after, I.revert_cutover_patch(after, 0, plan, "cfg-3011", {}))
        self.assertFalse(I.is_converted(back, 0))
        self.assertEqual(back["spec"]["template"]["spec"]["containers"][0]["image"], IF.LEGACY_IMAGE)
        self.assertEqual(I.config_volume(back, 0)[1], "cfg-3011")  # never the old generation
        sneaky = json.loads(json.dumps(after))
        sneaky["spec"]["template"]["spec"]["containers"][0]["env"].append({"name": "X", "value": "1"})
        refused(self, lambda: I.guard_cutover(before, sneaky, 0, plan), "CUTOVER_GUARD")

    def test_the_cutover_switches_the_signing_key_reference_and_the_revert_restores_it(self):
        """Review 2026-10-25 H3: image, config and the Secret the catalog key comes from move in one patch, so a revert
        is old image, old key and old pack together, and the reverted catalog verifies. Secret values are never read."""
        before = IF.ing_deployment(IF.LEGACY_IMAGE, "cfg-3008", converted=False)
        self.assertEqual(I.signing_key_env(before, 0), (5, IF.LEGACY_SIGNING_SECRET))
        plan = I.cutover_plan(before, 0, self.build["image"], "cfg-3010", {}, IF.ING_SIGNING_SECRET)
        self.assertEqual((plan["signingKeySecret"], plan["toSigningKeySecret"]), (IF.LEGACY_SIGNING_SECRET, IF.ING_SIGNING_SECRET))
        ref = "/spec/template/spec/containers/0/env/5/valueFrom/secretKeyRef/name"
        self.assertIn({"op": "test", "path": ref, "value": IF.LEGACY_SIGNING_SECRET}, plan["patch"])
        self.assertIn({"op": "replace", "path": ref, "value": IF.ING_SIGNING_SECRET}, plan["patch"])
        self.assertFalse([op for op in plan["patch"] if "/secrets/" in op["path"] or op["path"].startswith("/data")])
        after = F.apply_json_patch(before, plan["patch"])
        self.assertEqual(I.signing_key_env(after, 0)[1], IF.ING_SIGNING_SECRET)
        env = after["spec"]["template"]["spec"]["containers"][0]["env"][5]
        self.assertEqual(env["valueFrom"]["secretKeyRef"]["key"], "LW_CATALOG_SIGNING_KEY")  # the key name inside stays
        I.guard_cutover(before, after, 0, plan)
        unswitched = json.loads(json.dumps(after))
        unswitched["spec"]["template"]["spec"]["containers"][0]["env"][5]["valueFrom"]["secretKeyRef"]["name"] = IF.LEGACY_SIGNING_SECRET
        refused(self, lambda: I.guard_cutover(before, unswitched, 0, plan), "CUTOVER_GUARD")
        back = F.apply_json_patch(after, I.revert_cutover_patch(after, 0, plan, "cfg-3011", {}))
        self.assertEqual(I.signing_key_env(back, 0)[1], IF.LEGACY_SIGNING_SECRET)
        self.assertEqual(back["spec"]["template"]["spec"]["containers"][0]["image"], IF.LEGACY_IMAGE)
        # A live reference that already names the lolly.ing Secret leaves a revert nothing to restore: refused.
        already = IF.ing_deployment(IF.LEGACY_IMAGE, "cfg-3008", converted=False, signing_secret=IF.ING_SIGNING_SECRET)
        refused(self, lambda: I.cutover_plan(already, 0, self.build["image"], "cfg-3010", {}, IF.ING_SIGNING_SECRET), "SIGNING_SECRET_LIVE")
        plain = IF.ing_deployment(IF.LEGACY_IMAGE, "cfg-3008", converted=False)
        plain["spec"]["template"]["spec"]["containers"][0]["env"][5] = {"name": "LW_CATALOG_SIGNING_KEY", "value": "inline"}
        refused(self, lambda: I.signing_key_env(plain, 0), "LAYOUT_UNKNOWN")
        with mock.patch.object(A, "ING_SIGNING_KEY_SECRET", None):
            refused(self, I.signing_secret, "SIGNING_SECRET_NOT_PINNED")
        with mock.patch.object(A, "ING_SIGNING_KEY_SECRET", "Not_A_Name"):
            refused(self, I.signing_secret, "SIGNING_SECRET_NOT_PINNED")

    def test_a_cutover_revert_retry_rechecks_the_maintenance_marker(self):
        """A patch conflict must not let a retry ignore a non-additive migration's marker in the next read."""
        import preview_ing_node as IN
        runner = object.__new__(IN.IngRunner)
        runner.request = {"release": {"image": self.build["image"]}}
        runner.au = mock.Mock(Refusal=C.Refusal)
        runner.log, runner.annotate = mock.Mock(), mock.Mock()
        runner.finish = mock.Mock(return_value=3)
        runner.component, runner.kube = {}, mock.Mock()
        value = IF.ing_deployment(self.build["image"], "cfg-3010")
        restore = {"record": {"object": "lolly-ing/x.lwbackup"}, "previousImage": IF.LEGACY_IMAGE}
        marked = IF.ing_deployment(self.build["image"], "cfg-3010",
                                   annotations={IN.key("maintenance-applied"): json.dumps([IF.MAINTENANCE]),
                                                IN.key("backup"): json.dumps(restore)})
        runner.deployment = mock.Mock(side_effect=[(value, 0), (value, 0), (marked, 0)])
        runner.config_maps = mock.Mock(return_value={"cfg-3010": (3010, IF.instance_json(3010))})
        runner.check_db = mock.Mock(return_value={"publicationGeneration": 3010})
        runner.new_config = mock.Mock(return_value="cfg-3011")
        runner.kube.patch.side_effect = C.Refusal("CONFLICT", "deployment changed")
        plan = {"cutover": {"image": IF.LEGACY_IMAGE}, "liveSource": W_OLD}
        with mock.patch.object(I, "revert_cutover_patch", return_value=[]) as patch, mock.patch.object(IN.N, "SLEEP"):
            self.assertEqual(runner.revert_conversion(plan, "UNIT_STOPPED"), 3)
        self.assertEqual(runner.deployment.call_count, 3)
        self.assertEqual((patch.call_count, runner.kube.patch.call_count), (1, 1))
        runner.finish.assert_called_once_with("MAINTENANCE_UNVERIFIED", reason="UNIT_STOPPED", checks=None, backup=restore,
                                              note=IN.HOLD_NOTE)

    def test_a_request_with_a_maintenance_approval_is_from_an_older_mac(self):
        """The approval flow is gone (Andy 2026-10-27); the node refuses a request shaped for it rather than ignore it."""
        source = (ROOT / "deploy/preview/lib/preview_ing_node.py").read_text()
        self.assertIn('require("maintenanceApproval" not in request', source)
        self.assertFalse(hasattr(A, "ING_MAINTENANCE_APPROVERS"))
        self.assertNotIn("maintenanceEnvironment", A.ING)

    def test_the_qualification_anchors(self):
        """Work: its own full lolly-work CI. Lolly: as a lolly.tools source, full CI or a fast lane."""
        self.assertEqual((A.ING_WORK_CI["repository"], A.ING_WORK_CI["ciWorkflowPath"]), ("lolly-tools/lolly-work", ".github/workflows/ci.yml"))
        self.assertNotIn("fastLaneWorkflowFile", A.ING_WORK_CI)
        for name in ("repository", "ciWorkflowFile", "ciWorkflowPath", "fastLaneWorkflowFile", "fastLaneWorkflowPath", "branch"):
            self.assertEqual(A.ING_LOLLY_CI[name], A.TOOLS[name], name)


class IngEndToEnd(unittest.TestCase):
    """The real command, its SSH bootstrap, the unit runner, app-update.py's transport and the real restore
    rehearsal driver, over fakes."""

    CONVERTED = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.key = F.make_key()
        self.thumb = R.jwk_thumbprint(self.key[1])
        self.old = IF.make_ing_build(self.key, W_OLD, "old", seq=3000, suse=S_HEAD)
        self.new = IF.make_ing_build(self.key, W_NEW, "new", seq=3001, suse=S_HEAD)
        self.legacy = IF.legacy_build(self.key)
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
        cookie = self.sandbox / "smoke-session"
        cookie.write_text(IF.SMOKE_COOKIE + "\n")
        cookie.chmod(0o600)
        self.known_hosts = base / "known_hosts"
        self.production = base / "lolly-private" / "production"
        self.state_dir = self.production / "preview"
        self.state_dir.mkdir(parents=True, mode=0o700)
        self.production.chmod(0o700)
        self.check_target_path = self.production / "check-target.py"
        F.write_check_target(self.check_target_path, self.bin / "k3s", self.known_hosts)
        self.relock()
        self.profile = {"version": 1, "site": "lolly.ing",
                        "smoke": {"account": {"sub": IF.SMOKE_SUB}, "packAssetPath": IF.PACK_ASSET, "pages": ["/info/"],
                                  "memoryFraction": 0.85},
                        "watch": {"minutes": 0, "intervalSeconds": 15, "failures": 3}, "build": {"pollSeconds": 0, "timeoutMinutes": 10},
                        "rolloutTimeoutSeconds": 300, "capacity": {"minFreeAboveReserveBytes": GIB, "archiveFactor": 3},
                        "noDeployUtc": ["00:00", "00:00"], "gc": {"legacyClaims": []}, "retainPreviousImages": 2,
                        "retainConfigMaps": 4, "rehearsal": {"storageHost": IF.STORAGE_HOST, "storageAddress": IF.STORAGE_ADDRESS}}
        path = self.state_dir / "lolly.ing.json"
        path.write_text(json.dumps(self.profile))
        path.chmod(0o600)
        self.cluster_path = base / "cluster.json"
        builds = {"old": self.old, "new": self.new, "legacy": self.legacy}
        if self.CONVERTED:
            state = IF.ing_cluster_state(builds, self.old, "lolly-ing-config-3008-33333333", 3008,
                                         annotations=IF.ing_annotations(self.old, config="lolly-ing-config-3008-33333333"),
                                         ing_key=self.key, extra_configs={"lolly-work-plan300-publication-3009-rollback-v1": 3009})
        else:
            state = IF.ing_cluster_state(builds, self.legacy, "lolly-work-plan300-publication-3008-v1", 3008, converted=False,
                                         ing_key=self.key, extra_configs={"lolly-work-plan300-publication-3009-rollback-v1": 3009})
        self.set_cluster(state)
        self.rehearsal_path = base / "rehearsal.json"
        self.rehearsal_path.write_text(json.dumps(IF.rehearsal_cluster()))
        self.gh_path = base / "gh.json"
        # Andy 2026-10-27: every Work commit here has its green full lolly-work CI run, and the Lolly commits the
        # builds pin have theirs, unless a test says otherwise.
        self.gh = {"mainHead": "f" * 40, "compare": {}, "calls": [], "runs": [], "statusSequence": {},
                   "ciRuns": [IF.ci_run(700 + n, lsha, "lolly-tools/lolly") for n, lsha in enumerate(("2" * 40, "8" * 40))],
                   "workCiRuns": [IF.ci_run(800 + n, wsha, IF.WORK_REPO) for n, wsha in enumerate((W_OLD, W_NEW, W_NEXT, "7" * 40))],
                   "suseMainHead": S_HEAD, "ingRuns": [], "artifacts": {}, "zips": {}, "approvals": {}, "enginePins": {}}
        self.write_gh()
        self.add_run(self.new, 1100)
        self.environ = mock.patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_STATE": str(self.cluster_path), "FAKE_GH_STATE": str(self.gh_path),
            "FAKE_SANDBOX": str(self.sandbox), "FAKE_BIN": str(self.bin), "FAKE_PIN": json.dumps(A.RELEASE_PUBLIC_KEY_JWK),
            "FAKE_ING_PIN": json.dumps(self.key[1]), "FAKE_KNOWN_HOSTS": str(self.known_hosts), "FAKE_SITE": "lolly.ing",
            "FAKE_REHEARSAL_STATE": str(self.rehearsal_path),
            "FAKE_ING_ANCHORS": json.dumps({"ING_SIGNING_KEY_SECRET": IF.ING_SIGNING_SECRET})})
        self.environ.start()
        for name in ("FAKE_CRASH_PHASE", "FAKE_CHECK_TARGET", "FAKE_SSH_DOWN", "FAKE_START_REPLY_LOST", "FAKE_UNIT_NEVER_STARTS",
                     "FAKE_CRASH_AFTER_SWITCH", "FAKE_ING_ABORT", "FAKE_AGE_AFTER_REHEARSAL"):
            os.environ.pop(name, None)
        self.patches = [mock.patch.object(A, "ING_PUBLIC_KEY_JWK", self.key[1]),
                        mock.patch.object(A, "ING_SIGNING_KEY_SECRET", IF.ING_SIGNING_SECRET), mock.patch.object(M, "SLEEP", lambda s: None),
                        mock.patch.object(M, "TOOL_ROOT", self.checkout), mock.patch.object(M, "STATE_DIR", self.state_dir)]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        self.environ.stop()
        self.tmp.cleanup()

    # Helpers -------------------------------------------------------------
    def relock(self):
        self.lock = F.lock_for(self.checkout, self.checkout)
        (self.state_dir / "tool.lock.json").write_text(json.dumps(self.lock))
        self.tool_hash = self.lock["toolSha256"]

    def set_cluster(self, state):
        self.cluster_path.write_text(json.dumps(state))

    def cluster(self):
        return json.loads(self.cluster_path.read_text())

    def behave(self, **changes):
        state = self.cluster()
        state["behaviour"].update(changes)
        self.set_cluster(state)

    def rehearse_as(self, **scenario):
        self.rehearsal_path.write_text(json.dumps(IF.rehearsal_cluster(**scenario)))

    def rehearsal_state(self):
        return json.loads(self.rehearsal_path.read_text())

    def write_gh(self):
        self.gh_path.write_text(json.dumps(self.gh))

    def update_gh(self, **changes):
        self.gh = json.loads(self.gh_path.read_text())
        self.gh.update(changes)
        self.write_gh()

    def add_run(self, build, run_id, manifest=None, archive=None, **run_fields):
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["ingRuns"].append(IF.ing_run(run_id, build["suse"], work=build["sha"], **run_fields))
        IF.ing_artifacts(self.gh, build, run_id, manifest=manifest, archive=archive)
        self.write_gh()
        state = self.cluster()
        state["builds"][build["image"]] = build
        IF.register_archive(state, build, run_id)
        self.set_cluster(state)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = M.main(["--state-dir", str(self.state_dir), "--tool-sha256", self.tool_hash, "--checkout", str(self.checkout),
                           "--check-target", str(self.check_target_path), "lolly.ing", *argv],
                          gh=G.Gh(executable=str(self.bin / "gh"), sleep=lambda s: None))
        events = []
        for line in out.getvalue().splitlines():
            with contextlib.suppress(ValueError):
                events.append(json.loads(line))
        return code, events

    def done(self, events):
        found = [event for event in events if event.get("event") in ("done", "refused")]
        self.assertTrue(found, events)
        return found[-1]

    def live(self):
        deploy = self.cluster()["deployment"]
        annotations = {k[len("lolly.tools/preview-"):]: v for k, v in deploy["metadata"]["annotations"].items()
                       if k.startswith("lolly.tools/preview-")}
        return deploy["spec"]["template"]["spec"]["containers"][0]["image"], I.config_volume(deploy, 0)[1], annotations

    def writes(self, kind):
        return [w for w in self.cluster()["writes"] if w and w[0] == kind]

    def records(self):
        path = self.state_dir / "deploys.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def result_file(self):
        results = self.sandbox / "var/lib/lolly-preview/results"
        names = sorted(p for p in results.iterdir() if not p.name.endswith(".request.json"))
        return json.loads(names[-1].read_text())

    def spool(self):
        directory = self.sandbox / "var/lib/lolly-preview/spool"
        return sorted(p.name for p in directory.iterdir()) if directory.exists() else []

    def rehearsal_pods(self):
        """The rehearsal Pods #208's fake saw created, by the pending files their ConfigMap carried."""
        state = self.rehearsal_state()
        return [call for call in state["calls"] if call[:1] == ["create"] and "--dry-run=server" not in call]

    def assert_untouched(self, image=None):
        live_image, _, _ = self.live()
        self.assertEqual(live_image, image or self.old["image"])
        self.assertEqual(self.writes("patch"), [])
        self.assertEqual(self.writes("migrate"), [])

    def assert_no_secret_claim_or_exec(self):
        for write in self.cluster()["writes"]:
            self.assertIn(write[0], ("import", "backup", "job", "configmap", "patch", "migrate", "rehearsal-call", "label",
                                     "rmi", "delete-configmap", "image-name-removed"), write)
            if write[0] == "patch":
                text = json.dumps(write[1])
                self.assertNotIn("secret", text.lower())
                self.assertNotIn("persistentVolumeClaim", text)

    def pending_build(self, *names, label="next", wsha=W_NEXT, run_id=1200, seq=3002):
        build = IF.make_ing_build(self.key, wsha, label, seq=seq, suse=S_HEAD,
                                  migrations=IF.BASE_MIGRATIONS + [IF.fixture_migration(name) for name in names])
        self.add_run(build, run_id)
        return build

    def without_rehearsal(self):
        """The preview-grade default profile: no restore rehearsal; the verified backup still comes first."""
        self.profile["rehearsal"] = None
        path = self.state_dir / "lolly.ing.json"
        path.write_text(json.dumps(self.profile))
        path.chmod(0o600)

    def signing_ref(self):
        return I.signing_key_env(self.cluster()["deployment"], 0)[1]

    def restore_point(self):
        return json.loads(self.live()[2].get("backup") or "null")

    def posts(self):
        return [c for c in json.loads(self.gh_path.read_text())["calls"] if c["method"] == "POST"]


class IngDeploys(IngEndToEnd):
    def test_deploy_imports_publishes_a_higher_generation_and_smokes_with_no_backup_when_nothing_migrates(self):
        """Andy 2026-10-27: a backup comes before every migration; a deploy that changes no schema takes none."""
        code, events = self.cli("deploy", W_NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)
        image, config, notes = self.live()
        # N = 1 + max(live 3008, ConfigMaps up to 3009, database 3008, the pack's seq 3001).
        self.assertEqual((image, config, result["generation"]), (self.new["image"], "lolly-ing-config-3010-44444444", 3010))
        self.assertEqual((notes["phase"], notes["generation"], notes["source"], notes["config"]), ("accepted", "3010", W_NEW, config))
        self.assertEqual(json.loads(notes["previous"])["image"], self.old["image"])
        state = self.cluster()
        live_text = state["configmaps"]["lolly-ing-config-3008-33333333"]["data"]["instance.json"]
        new_text = state["configmaps"][config]["data"]["instance.json"]
        self.assertEqual(I.with_generation(live_text, 3010), new_text)  # only the generation changed
        self.assertEqual((state["db"]["generation"], state["db"]["digest"]), (3010, self.new["packDigest"]))  # catalog served at N
        self.assertEqual((len(self.writes("backup")), len(self.writes("import"))), (0, 1))
        self.assertIsNone(self.restore_point())
        self.assertEqual(self.writes("image-name-removed"), [["image-name-removed", IF.ING_IMAGE + ":run-1100-1"]])
        self.assertEqual(self.spool(), [])  # the archive is deleted once imported
        imported = [e for e in state["images"].values() if self.new["image"] in e["refs"]][0]
        self.assertEqual(imported["refs"][self.new["image"]].get("io.cri-containerd.pinned"), "pinned")
        checks = {item["check"]: item["ok"] for item in self.result_file()["checks"]}
        for name in ("healthz", "readyz", "root", "receipt", "csp blob:", "page /info/", "anonymous catalog", "anonymous pack asset",
                     "smoke account", "signed catalog", "qr export", "www redirect", "pod", "signing key", "generation"):
            self.assertTrue(checks.get(name), (name, checks))
        jobs = self.writes("job")
        self.assertEqual([j[1] for j in jobs], ["check", "check"])  # the read-only check, then the generation readback
        self.assertTrue(all(j[2] == ["DATABASE_URL"] for j in jobs))
        self.assertEqual(self.rehearsal_pods(), [])  # nothing pending: no rehearsal on a normal deploy
        changes = [e for e in events if e.get("event") == "change-list"]
        self.assertEqual(sorted(e["repository"] for e in changes), ["lolly-tools/lolly", "lolly-tools/lolly-work", "lolly-tools/suse-lolly"])
        record = self.records()[-1]
        self.assertEqual((record["result"], record["workCiRun"], record["lollyCiRun"], record["backup"]), ("LIVE", 801, 700, None))
        self.assertNotIn("lollyLane", record)
        self.assertFalse([c for c in json.loads(self.gh_path.read_text())["calls"] if "/approvals" in c["path"]])
        self.assert_no_secret_claim_or_exec()

    def test_generation_takes_the_database_row_when_it_is_highest(self):
        """R20 S16: after an interrupted run the database can already hold a higher generation. Here the live
        pack's own seq put it there, so the live site still serves, and no ConfigMap or the new seq says 3020."""
        state = self.cluster()
        state["builds"][self.old["image"]]["seq"] = 3020
        state["db"]["generation"], state["db"]["digest"] = 3020, self.old["packDigest"]
        self.set_cluster(state)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["generation"]), (0, 3021), events)
        self.assertEqual(self.cluster()["db"]["generation"], 3021)

    def test_a_pending_additive_migration_is_backed_up_rehearsed_then_applied_with_the_manifest_form(self):
        """#207 classifies it additive; a verified backup comes first; #208's real driver rehearses it (the profile
        configures one here); the migrate Job carries the sha256 manifest."""
        build = self.pending_build(IF.ADDITIVE)
        code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)
        writes = self.cluster()["writes"]
        self.assertEqual(len(self.writes("backup")), 1)
        self.assertLess(writes.index(self.writes("backup")[0]), writes.index(self.writes("migrate")[0]))
        point = self.restore_point()
        self.assertEqual((point["record"]["status"], point["migrations"], point["maintenance"], point["previousImage"],
                          point["previousSource"]), ("VERIFIED", [IF.ADDITIVE], False, self.old["image"], W_OLD))
        self.assertEqual(self.records()[-1]["backup"]["object"], point["record"]["object"])
        pending = [IF.fixture_migration(IF.ADDITIVE)]
        manifest = fixture("classify-0077.json")["manifest"]
        self.assertEqual(I.migration_manifest(pending), manifest)
        rehearsal = self.result_file()["rehearsal"]
        self.assertEqual((rehearsal["result"], rehearsal["expect"], [f["name"] for f in rehearsal["files"]]),
                         ("PASSED", manifest, [IF.ADDITIVE]))
        self.assertEqual(len(self.rehearsal_pods()), 2)  # #208 created its ConfigMap and its Pod, then removed both
        self.assertEqual(len(self.rehearsal_state()["deleted"]), 2)
        self.assertEqual(self.writes("migrate"), [["migrate", [IF.ADDITIVE], manifest]])
        jobs = {j[1]: j for j in self.writes("job")}
        self.assertEqual(jobs["migrate"][2], ["DATABASE_URL", "LW_MIGRATE_EXPECT", "NODE_ENV"])  # R22 S5
        self.assertEqual((jobs["classify"][2], jobs["classify"][3]), ([], ["scripts/classify-migrations.ts", "--json", "--only", IF.ADDITIVE]))
        self.assertIn(IF.ADDITIVE, self.cluster()["db"]["ledger"])
        image, _, notes = self.live()
        self.assertEqual(image, build["image"])
        self.assertIn(IF.ADDITIVE, json.loads(notes["migrations"]))
        self.assertIsNone(notes.get("maintenance"))

    def test_a_maintenance_migration_needs_no_approval_and_takes_a_verified_backup_first(self):
        """#207 classifies an ADD CONSTRAINT as maintenance. Andy 2026-10-27: every class is applied, backup first;
        nothing asks for or reads an approval."""
        build = self.pending_build(IF.MAINTENANCE)
        code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"], result["maintenance"], result["migrations"]), (0, "LIVE", True, [IF.MAINTENANCE]), events)
        writes = self.cluster()["writes"]
        self.assertLess(writes.index(self.writes("backup")[0]), writes.index(self.writes("migrate")[0]))
        marker = [w for w in self.writes("patch") if any(op["path"].endswith("preview-maintenance-applied") for op in w[1])]
        self.assertLess(writes.index(marker[0]), writes.index(self.writes("migrate")[0]))  # the hold marker precedes the schema change
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], notes["maintenance"], notes.get("maintenance-applied")),
                         (build["image"], "accepted", "true", None))
        self.assertEqual(self.restore_point()["maintenance"], True)
        self.assertFalse([c for c in json.loads(self.gh_path.read_text())["calls"] if "/approvals" in c["path"]])

    def test_a_failed_switch_after_a_maintenance_migration_is_held_with_its_restore_point(self):
        """Automatic rollback is off after a non-additive migration: the rollback is the backup plus the previous image,
        by the runbook, or a forward fix. The result and status name the backup to restore."""
        build = self.pending_build(IF.MAINTENANCE)
        self.behave(brokenSite=[build["image"]])
        code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (3, "MAINTENANCE_UNVERIFIED"), events)
        self.assertEqual((result["backup"]["previousImage"], result["backup"]["record"]["status"]), (self.old["image"], "VERIFIED"))
        self.assertIn("runbook", result["note"])
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], notes["maintenance"]), (build["image"], "maintenance-unverified", "true"))
        self.assertEqual([w[1] for w in self.writes("migrate")], [[IF.MAINTENANCE]])
        code, events = self.cli("status")
        status = [e for e in events if e.get("event") == "status"][0]
        self.assertEqual((status["backup"]["previousImage"], status["backup"]["migrations"]), (self.old["image"], [IF.MAINTENANCE]))
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN")
        code, events = self.cli("rollback", "--clear-hold")
        refusal = self.done(events)
        self.assertEqual(refusal["code"], "MAINTENANCE_NO_ROLLBACK")
        self.assertIn("backup", refusal["reason"])
        self.assertEqual(self.live()[0], build["image"])
        code, events = self.cli("deploy", W_NEW, "--clear-hold")  # an image without that migration: the database is ahead
        self.assertEqual(self.done(events)["code"], "DATABASE_AHEAD")
        fix = IF.make_ing_build(self.key, "7" * 40, "fix", seq=3003, suse=S_HEAD, migrations=build["migrations"])
        self.add_run(fix, 1300)
        self.behave(brokenSite=[])
        code, events = self.cli("deploy", "7" * 40, "--clear-hold")  # the forward fix: nothing pending, so no new backup
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        image, _, notes = self.live()
        self.assertEqual((image, notes.get("maintenance"), json.loads(notes["maintenance-migrations"])),
                         (fix["image"], None, [IF.MAINTENANCE]))

    def test_without_a_rehearsal_a_migration_still_takes_the_verified_backup_first(self):
        """The preview-grade profile sets no rehearsal: no rehearsal Pod, but the backup still precedes the migrate Job."""
        self.without_rehearsal()
        build = self.pending_build(IF.ADDITIVE)
        code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"], result["rehearsal"]), (0, "LIVE", None), events)
        self.assertEqual((self.rehearsal_pods(), len(self.writes("backup"))), ([], 1))
        self.assertEqual(self.writes("migrate"), [["migrate", [IF.ADDITIVE], fixture("classify-0077.json")["manifest"]]])
        self.assertEqual((self.live()[0], self.restore_point()["migrations"]), (build["image"], [IF.ADDITIVE]))

    def test_an_image_without_the_classifier_applies_nothing(self):
        self.pending_build(IF.ADDITIVE)
        self.behave(classifierMissing=True)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "CLASSIFIER_UNAVAILABLE"), events)
        self.assert_untouched()

    def test_a_failed_rehearsal_applies_nothing(self):
        """#208's real driver and fake: the previous image fails its round trip, or a file runs past the lock budget."""
        self.pending_build(IF.ADDITIVE)
        for scenario, code in ((dict(failAt="previous", reason="the previous image exited during boot (1)"), "PREVIOUS_IMAGE_FAILED"),
                               (dict(seconds={IF.ADDITIVE: 31.5}), "LOCK_BUDGET_EXCEEDED")):
            with self.subTest(code=code):
                self.rehearse_as(**scenario)
                result_code, events = self.cli("deploy", W_NEXT)
                refusal = self.done(events)
                self.assertEqual((result_code, refusal["code"]), (1, "REHEARSAL_FAILED"), events)
                self.assertIn(code, refusal["reason"])
                self.assert_untouched()
                self.assertEqual(len(self.rehearsal_state()["deleted"]), 2)  # torn down by UID either way

    def test_failed_smoke_rolls_back_at_a_higher_generation_and_the_catalog_answers(self):
        """PROPOSAL 4.6: previous image plus a NEW config above N; the fence then accepts it (never rollout undo)."""
        code, events = self.cli("deploy", W_NEW, "--drill-fail-smoke")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        image, config, notes = self.live()
        self.assertEqual((image, result["generation"], config), (self.old["image"], 3011, "lolly-ing-config-3011-33333333"))
        self.assertEqual((notes["phase"], notes["generation"]), ("rolled-back", "3011"))
        back = {item["check"]: item["ok"] for item in self.result_file()["rollbackChecks"]}
        self.assertTrue(back["signed catalog"] and back["generation"] and back["receipt"], back)
        state = self.cluster()
        self.assertEqual((state["db"]["generation"], state["db"]["digest"]), (3011, self.old["packDigest"]))
        self.assertLess(I.config_generation(state["configmaps"]["lolly-ing-config-3008-33333333"]["data"]["instance.json"]),
                        state["db"]["generation"])  # the old config would now get a 503: a plain rollout undo is not a rollback

    def test_manual_rollback_is_a_forward_publication(self):
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["result"], "LIVE")
        code, events = self.cli("rollback")
        result = self.done(events)
        self.assertEqual((code, result["result"], result["generation"]), (2, "ROLLED_BACK", 3011), events)
        self.assertEqual(self.live()[0], self.old["image"])
        self.assertEqual(self.cluster()["db"]["generation"], 3011)

    def test_unit_stop_after_the_switch_rolls_back_at_a_higher_generation(self):
        """R20 S11: ExecStopPost decides from the live phase."""
        os.environ["FAKE_CRASH_AFTER_SWITCH"] = "1"
        code, events = self.cli("deploy", W_NEW)
        result = self.done(events)
        self.assertEqual(result["result"], "ROLLED_BACK", events)
        self.assertEqual((self.live()[0], result["generation"]), (self.old["image"], 3011))

    def test_ship_dispatches_the_private_build_with_its_three_commits(self):
        """suse-lolly #28 takes LSHA, WSHA and SSHA: the Work commit's Lolly pin and suse-lolly's main head."""
        build = IF.make_ing_build(self.key, W_NEXT, "shipped", seq=3002, suse=S_HEAD, lolly="8" * 40)
        state = self.cluster()
        state["builds"][build["image"]] = build
        IF.register_archive(state, build, 1300)
        self.set_cluster(state)
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["onDispatch"] = IF.ing_run(1300, S_HEAD, status="queued", conclusion=None)
        self.gh["statusSequence"] = {"1300": ["waiting", "waiting", "completed"]}  # two approvals of lolly-ing-signing
        IF.ing_artifacts(self.gh, build, 1300)
        self.write_gh()
        code, events = self.cli("ship", W_NEXT)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        posts = [c for c in json.loads(self.gh_path.read_text())["calls"] if c["method"] == "POST"]
        self.assertEqual([(p["path"], p["body"]) for p in posts],
                         [("repos/lolly-tools/suse-lolly/actions/workflows/lolly-ing-preview.yml/dispatches",
                           {"ref": "refs/heads/main", "inputs": {"LSHA": "8" * 40, "WSHA": W_NEXT, "SSHA": S_HEAD}})])

    def test_already_live_changes_nothing(self):
        self.add_run(self.old, 1050)
        code, events = self.cli("deploy", W_OLD)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"), events)
        self.assertEqual(self.cluster()["writes"], [])

    def test_ship_of_the_accepted_live_sources_is_already_live_before_any_build(self):
        """Same Work commit, same suse-lolly head, same Lolly pin: nothing to build, nothing to qualify."""
        self.update_gh(enginePins={W_OLD: self.old["lolly"]}, workCiRuns=[])
        code, events = self.cli("ship", W_OLD)
        self.assertEqual((code, self.done(events)["result"]), (0, "ALREADY_LIVE"), events)
        self.assertEqual((self.posts(), self.cluster()["writes"]), ([], []))

    def test_ship_refuses_until_the_sources_qualify_and_dispatches_nothing(self):
        """Andy 2026-10-27: green full lolly-work CI for the Work commit, and a qualified Lolly commit. The refusal is
        CI_PENDING while a run is going (auto-ship retries) and CI_NOT_GREEN once one failed."""
        cases = (("Work CI still running", {"workCiRuns": [IF.ci_run(802, W_NEXT, IF.WORK_REPO, status="in_progress", conclusion=None)]},
                  "CI_PENDING", "lolly-work"),
                 ("Work CI failed", {"workCiRuns": [IF.ci_run(802, W_NEXT, IF.WORK_REPO, conclusion="failure")]}, "CI_NOT_GREEN", "lolly-work"),
                 ("Work CI cancelled by a newer push", {"workCiRuns": [IF.ci_run(802, W_NEXT, IF.WORK_REPO, conclusion="cancelled")]},
                  "CI_NOT_GREEN", "lolly-work"),
                 ("Lolly CI failed", {"ciRuns": [IF.ci_run(701, "8" * 40, "lolly-tools/lolly", conclusion="failure")],
                                      "workCiRuns": [IF.ci_run(802, W_NEXT, IF.WORK_REPO)]}, "CI_NOT_GREEN", "engine pin"))
        for name, change, code_name, where in cases:
            with self.subTest(name=name):
                self.update_gh(enginePins={W_NEXT: "8" * 40}, calls=[], **change)
                code, events = self.cli("ship", W_NEXT)
                refusal = self.done(events)
                self.assertEqual((code, refusal["code"]), (1, code_name), events)
                self.assertIn(where, refusal["reason"])
                self.assertEqual((self.posts(), self.cluster()["writes"]), ([], []))

    def test_a_lolly_source_on_a_fast_lane_qualifies_as_it_does_for_lolly_tools(self):
        """The Lolly commit has no full CI run of its own yet, but differs from a green ancestor only in docs and its
        docs lane job passed: it qualifies, and the record says which lane."""
        lane_lsha, base = "ab" * 20, "cd" * 20
        files = {"docs/using.md": "# Using\n", "engine/src/runtime.ts": "runtime\n"}
        old_root, old_trees = F.git_trees(files)
        new_root, new_trees = F.git_trees(dict(files, **{"docs/using.md": "# Using Lolly\n"}))
        self.update_gh(commits={base: {"tree": old_root, "parents": []}, lane_lsha: {"tree": new_root, "parents": [base]}},
                       trees={**old_trees, **new_trees},
                       ciRuns=[IF.ci_run(650, base, "lolly-tools/lolly"),
                               IF.ci_run(651, lane_lsha, "lolly-tools/lolly", status="in_progress", conclusion=None)],
                       fastRuns=[F.run_object(1350, lane_lsha, path=".github/workflows/fast-lanes.yml", event="push")],
                       jobs={"1350": [{"id": 13500, "run_id": 1350, "head_sha": lane_lsha, "name": "docs lane", "status": "completed",
                                       "conclusion": "success"}]})
        build = IF.make_ing_build(self.key, W_NEXT, "lane", seq=3002, suse=S_HEAD, lolly=lane_lsha)
        self.add_run(build, 1200)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        record = self.records()[-1]
        self.assertEqual((record["lollyLane"], record["lollyLaneBase"], record["lollyCiRun"], record["lollyLaneRun"], record["workCiRun"]),
                         ("docs", base, 650, 1350, 802))
        self.update_gh(jobs={})  # without its lane job the same source does not qualify yet
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual(self.done(events)["result"], "ALREADY_LIVE", events)  # already live: nothing to qualify again
        self.cli("rollback")
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "CI_PENDING"), events)

    def test_ship_resumes_an_active_build_of_the_same_source_and_refuses_while_another_builds(self):
        """A ship that lost its wait (auto-ship restarted, the Mac slept) resumes the build instead of dispatching again."""
        build = IF.make_ing_build(self.key, W_NEXT, "resumed", seq=3002, suse=S_HEAD, lolly="8" * 40)
        state = self.cluster()
        state["builds"][build["image"]] = build
        IF.register_archive(state, build, 1300)
        self.set_cluster(state)
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["ingRuns"].append(IF.ing_run(1300, S_HEAD, status="in_progress", conclusion=None, work=W_NEXT))
        self.gh["statusSequence"] = {"1300": ["in_progress", "completed"]}
        IF.ing_artifacts(self.gh, build, 1300)
        self.write_gh()
        other = dict(IF.ing_run(1250, S_HEAD, status="queued", conclusion=None, work=W_NEW))
        self.update_gh(ingRuns=json.loads(self.gh_path.read_text())["ingRuns"] + [other])
        code, events = self.cli("ship", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "CANDIDATE_ACTIVE"), events)
        self.assertEqual((self.posts(), self.cluster()["writes"]), ([], []))
        self.update_gh(ingRuns=[run for run in json.loads(self.gh_path.read_text())["ingRuns"] if run["id"] != 1250])
        code, events = self.cli("ship", W_NEXT)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual(self.posts(), [])
        self.assertTrue([e for e in events if e.get("event") == "build" and e.get("run") == 1300])

    def test_a_run_with_a_malformed_manifest_is_skipped_for_an_older_run_that_binds(self):
        """Review L2: one bad run on main does not block deploy; it is reported and skipped."""
        bad = IF.ing_manifest(self.new, 1150)
        bad["kind"] = "something-else"
        self.add_run(self.new, 1150, manifest=bad)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual([(e["run"], e["code"]) for e in events if e.get("event") == "build-skipped"], [(1150, "MANIFEST_INVALID")])
        self.assertEqual(self.records()[-1]["ciRun"], 1100)


class IngMaintenanceMarker(IngEndToEnd):
    """A maintenance migration leaves a marker on the Deployment before it runs, and any abort keeps it."""

    def run_deploy(self, *argv, **env):
        os.environ.update(env)
        return self.cli("deploy", *argv)

    def marker(self):
        return json.loads(self.live()[2].get("maintenance-applied") or "null")

    def assert_aborted_after_migrate(self, point):
        build = self.pending_build(IF.MAINTENANCE)
        code, events = self.run_deploy(W_NEXT, FAKE_ING_ABORT=point)
        self.assertNotEqual(code, 0, events)
        image, _, notes = self.live()
        self.assertEqual(image, self.old["image"])  # nothing switched, the old image runs on the new schema
        self.assertEqual([w[1] for w in self.writes("migrate")], [[IF.MAINTENANCE]])
        self.assertEqual((self.marker(), notes["phase"]), ([IF.MAINTENANCE], "maintenance-applied-unswitched"), (point, notes))
        self.assertEqual(notes["maintenance-applied-set"], I.migration_set(build["migrations"]))
        os.environ.pop("FAKE_ING_ABORT")
        code, events = self.cli("deploy", W_NEXT)  # the next run sees the hold, not an empty pending set
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN", events)
        code, events = self.cli("rollback", "--clear-hold")
        self.assertEqual(self.done(events)["code"], "MAINTENANCE_NO_ROLLBACK", events)
        self.assertEqual(self.live()[0], self.old["image"])
        # The next deploy has nothing pending, but the marker keeps automatic rollback off.
        self.behave(brokenSite=[build["image"]])
        code, events = self.run_deploy(W_NEXT, "--clear-hold")
        self.assertEqual(self.done(events)["result"], "MAINTENANCE_UNVERIFIED", events)
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], self.marker()), (build["image"], "maintenance-unverified", [IF.MAINTENANCE]))
        self.assertEqual(len(self.writes("migrate")), 1)  # never migrated twice

    def test_an_abort_before_the_new_config_keeps_the_marker(self):
        self.assert_aborted_after_migrate("config")

    def test_a_failed_switching_annotation_keeps_the_marker(self):
        self.assert_aborted_after_migrate("annotate")

    def test_a_switch_not_applied_keeps_the_marker_instead_of_writing_aborted(self):
        self.assert_aborted_after_migrate("switch")

    def test_a_stale_backup_before_the_migrate_job_refuses_with_nothing_applied(self):
        """Every class: the backup must be under an hour old when the schema changes."""
        for name in (IF.MAINTENANCE, IF.ADDITIVE):
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                self.pending_build(name)
                code, events = self.run_deploy(W_NEXT, FAKE_AGE_AFTER_REHEARSAL="2")  # fresh at the start, 2 hours old after the rehearsal
                self.assertEqual((code, self.done(events)["code"]), (1, "BACKUP_STALE"), events)
                self.assertEqual(self.writes("migrate"), [])
                self.assertEqual(self.writes("patch"), [])
                self.assertIsNone(self.marker())
                self.assertIsNone(self.restore_point())
                self.assertEqual(self.live()[2]["phase"], "accepted")
                os.environ.pop("FAKE_AGE_AFTER_REHEARSAL", None)

    def test_an_accepted_switch_that_includes_the_migrations_clears_the_marker(self):
        build = self.pending_build(IF.MAINTENANCE)
        code, events = self.run_deploy(W_NEXT, FAKE_ING_ABORT="switch")
        self.assertEqual(self.marker(), [IF.MAINTENANCE])
        os.environ.pop("FAKE_ING_ABORT")
        code, events = self.run_deploy(W_NEXT, "--clear-hold")
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], self.marker(), notes.get("maintenance-applied-set")),
                         (build["image"], "accepted", None, None))

    def test_a_successful_maintenance_run_clears_its_own_marker(self):
        self.pending_build(IF.MAINTENANCE)
        code, events = self.run_deploy(W_NEXT)
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        _, _, notes = self.live()
        self.assertEqual((notes["phase"], notes["maintenance"], self.marker()), ("accepted", "true", None))

    def test_a_rollback_rewrites_the_new_builds_migration_set(self):
        self.pending_build(IF.ADDITIVE)
        self.behave(brokenSite=[IF.make_ing_build(self.key, W_NEXT, "next", seq=3002, suse=S_HEAD,
                                                  migrations=IF.BASE_MIGRATIONS + [IF.fixture_migration(IF.ADDITIVE)])["image"]])
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual(self.done(events)["result"], "ROLLED_BACK", events)
        image, _, notes = self.live()
        self.assertEqual(image, self.old["image"])
        self.assertIsNone(notes.get("migration-set"))  # no longer describes the live image


class IngRefusals(IngEndToEnd):
    def test_a_build_pinned_to_the_release_key_is_refused_before_any_transfer(self):
        pinned = IF.make_ing_build(self.key, W_NEXT, "pinned", seq=3002, suse=S_HEAD, pin=A.RELEASE_PUBLIC_KEY_THUMBPRINT)
        self.add_run(pinned, 1200)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "RELEASE_KEY"), events)
        self.assertEqual((self.cluster()["writes"], self.spool()), ([], []))

    def test_a_run_whose_head_is_not_the_built_suse_commit_is_not_bound(self):
        """R22 S6: the run's head SHA is the suse-lolly commit it built; a dispatch of an older SSHA does not bind."""
        build = IF.make_ing_build(self.key, W_NEXT, "older", seq=3002, suse="a" * 40)
        manifest = IF.ing_manifest(build, 1200)
        self.add_run(build, 1200, manifest=manifest)
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["ingRuns"][-1]["head_sha"] = S_HEAD
        self.write_gh()
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "RUN_NOT_FOUND"), events)  # not bound; skipped and reported (L2)
        self.assertEqual([(e["run"], e["code"]) for e in events if e.get("event") == "build-skipped"], [(1200, "MANIFEST_INVALID")])
        self.assertEqual(self.cluster()["writes"], [])

    def test_a_pushed_or_forked_run_is_not_bound(self):
        for fields, code in (({"event": "push"}, "RUN_NOT_FOUND"), ({"repository": "someone/suse-lolly"}, "RUN_NOT_BOUND")):
            with self.subTest(fields=fields):
                self.gh = json.loads(self.gh_path.read_text())
                self.gh["ingRuns"] = []
                self.write_gh()
                build = IF.make_ing_build(self.key, W_NEXT, "odd", seq=3002, suse=S_HEAD)
                self.add_run(build, 1200, **fields)
                result_code, events = self.cli("deploy", W_NEXT)
                self.assertEqual((result_code, self.done(events)["code"]), (1, code), events)

    def test_a_live_pod_holding_the_release_key_is_refused_before_any_change(self):
        """PROPOSAL 4.7 item 4: Work's boot log must not name the release key."""
        self.behave(bootKeyByImage={self.old["image"]: A.RELEASE_PUBLIC_KEY_THUMBPRINT})
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "RELEASE_KEY"), events)
        self.assert_untouched()
        self.assertEqual((self.writes("backup"), self.writes("import"), self.writes("configmap")), ([], [], []))

    def test_a_new_pod_holding_the_release_key_is_rolled_back(self):
        self.behave(bootKeyByImage={self.new["image"]: A.RELEASE_PUBLIC_KEY_THUMBPRINT})
        code, events = self.cli("deploy", W_NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn("signing key", result["reason"])

    def test_a_catalog_signed_with_another_key_is_rolled_back(self):
        self.behave(catalogKeyByImage={self.new["image"]: A.RELEASE_PUBLIC_KEY_THUMBPRINT})
        code, events = self.cli("deploy", W_NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn("signed catalog", result["reason"])

    def test_a_shell_receipt_signed_with_another_key_is_rolled_back(self):
        """The workflow's frontend receipt is served at /release-frontend.sig.json and verified against the lolly.ing pin."""
        other = IF.make_ing_build(self.key, W_NEW, "new", seq=3001, suse=S_HEAD, receipt_key=F.make_key())
        self.behave(receiptByImage={self.new["image"]: other["receipt"]})
        code, events = self.cli("deploy", W_NEW)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "ROLLED_BACK"), events)
        self.assertIn("receipt", result["reason"])

    def test_a_database_ahead_of_the_image_is_held_for_a_human(self):
        state = self.cluster()
        state["db"]["ledger"].append("0099_unknown.sql")
        self.set_cluster(state)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "DATABASE_AHEAD"), events)
        self.assert_untouched()

    def test_a_stale_backup_stops_before_the_migration(self):
        self.pending_build(IF.ADDITIVE)
        self.behave(backupAgeHours=2)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "BACKUP_STALE"), events)
        self.assert_untouched()
        self.assertIsNone(self.restore_point())

    def test_a_failed_backup_stops_a_migrating_deploy_and_does_not_touch_one_that_changes_no_schema(self):
        self.behave(backupFails=True)
        self.pending_build(IF.MAINTENANCE)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "JOB_FAILED"), events)
        self.assert_untouched()
        self.assertEqual(([j[1] for j in self.writes("job")], self.restore_point()), (["check"], None))
        code, events = self.cli("deploy", W_NEW)  # nothing pending: no backup Job at all
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        self.assertEqual(len(self.writes("backup")), 1)  # only the migrating attempt's

    def test_a_tampered_archive_is_refused_before_import(self):
        """R22 S11: the archive's sha256 is checked against the manifest before ctr imports it."""
        archive = bytearray(IF.archive_bytes(self.new, 1100))
        archive[-1] ^= 1
        self.gh = json.loads(self.gh_path.read_text())
        IF.ing_artifacts(self.gh, self.new, 1100, archive=bytes(archive))
        self.write_gh()
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "ARCHIVE_MISMATCH"), events)
        self.assertEqual((self.writes("import"), self.spool()), ([], []))
        self.assert_untouched()

    def test_the_smoke_account_must_be_a_least_privilege_member(self):
        """R20 S13: no admin role, owns no documents; checked on the live build before any change."""
        for change in ({"accountRole": "admin"}, {"ownedProjects": [{"id": "p1", "ownerId": IF.SMOKE_SUB}]}):
            with self.subTest(change=change):
                self.behave(**dict({"accountRole": "member", "ownedProjects": []}, **change))
                code, events = self.cli("deploy", W_NEW)
                refusal = self.done(events)
                self.assertEqual((code, refusal["code"]), (1, "LIVE_SMOKE_FAILED"), events)
                self.assertIn("smoke account", refusal["reason"])
                self.assert_untouched()

    def test_check_target_runs_before_the_archive_reaches_the_node(self):
        """AGENTS.md: check-target immediately before the first production write; the upload is one."""
        os.environ["FAKE_CHECK_TARGET"] = "fail"
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "CHECK_TARGET_FAILED"), events)
        self.assertEqual((self.spool(), self.cluster()["writes"]), ([], []))
        self.assertFalse([e for e in events if e.get("event") == "archive"])

    def test_a_missing_smoke_session_refuses_on_the_mac(self):
        (self.sandbox / "smoke-session").unlink()
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "SMOKE_ACCOUNT"), events)
        self.assertEqual(self.cluster()["writes"], [])

    def test_the_smoke_session_is_never_printed(self):
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["result"], "LIVE")
        secret = IF.SMOKE_COOKIE.split("=", 1)[1]
        self.assertNotIn(secret, json.dumps(events))
        for path in (self.sandbox / "var/lib/lolly-preview").rglob("*"):
            if path.is_file():
                self.assertNotIn(secret.encode(), path.read_bytes(), path)
        self.assertNotIn(secret, (self.state_dir / "deploys.jsonl").read_text())

    def test_without_the_rehearsal_module_pending_migrations_refuse(self):
        for relative in ("deploy/preview/lib/preview_rehearsal.py",):
            subprocess.run(["git", "-C", str(self.checkout), "rm", "-q", relative], check=True)
        subprocess.run(["git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x"],
                       check=True)
        self.relock()
        self.pending_build(IF.ADDITIVE)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "REHEARSAL_UNAVAILABLE"), events)
        self.assert_untouched()
        code, events = self.cli("deploy", W_NEW)  # no pending migrations: the rehearsal is not needed
        self.assertEqual(self.done(events)["result"], "LIVE", events)

    def test_not_converted_is_refused(self):
        state = self.cluster()
        state["deployment"] = IF.ing_deployment(self.old["image"], "lolly-ing-config-3008-33333333", converted=False,
                                                annotations=IF.ing_annotations(self.old))
        self.set_cluster(state)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "NOT_CONVERTED"), events)

    def test_lolly_tools_only_commands_refuse(self):
        for argv in (["selftest"], ["adopt", W_NEW]):
            with self.subTest(argv=argv):
                code, events = self.cli(*argv)
                self.assertEqual((code, self.done(events)["code"]), (1, "NOT_FOR_LOLLY_ING"))


class IngRetention(IngEndToEnd):
    def own_config(self, state, generation):
        name = f"lolly-ing-config-{generation}-0000000{generation % 10}"
        state["configmaps"][name] = {"data": {"instance.json": IF.instance_json(generation)}, "uid": "cm-" + name,
                                     "labels": {"lolly.tools/managed-by": "preview-deploy", "lolly.tools/preview-config": "lolly.ing"}}
        return name

    def test_gc_removes_only_the_images_and_configmaps_it_made(self):
        """Decision 12: images and generation ConfigMaps follow the standing policy; legacy ones and claims never."""
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["result"], "LIVE")
        state = self.cluster()
        olds = [self.own_config(state, generation) for generation in (3001, 3002, 3003, 3004, 3005)]
        stray = IF.ING_IMAGE + "@sha256:" + "e" * 64
        image_id, entry = F.image_entry(stray, {"lolly.tools/preview-pulled": "true", "lolly.tools/preview-pin": "true",
                                                "io.cri-containerd.pinned": "pinned"})
        state["images"][image_id] = entry
        self.set_cluster(state)
        code, events = self.cli("gc", "--execute")
        self.assertEqual(self.done(events)["code"], "GC_REPORT_FIRST")
        code, events = self.cli("gc")
        configs = [e for e in events if e.get("event") == "gc-configmaps"][0]
        self.assertEqual(sorted(configs["remove"]), olds[:2])  # keeps the live one, the newest four and any a ReplicaSet names
        self.assertIn("lolly-work-plan300-publication-3009-rollback-v1", configs["legacy"])
        self.assertEqual([e for e in events if e.get("event") == "gc-images"][0]["remove"], [stray])
        code, events = self.cli("gc", "--execute")
        self.assertEqual((code, self.done(events)["result"]), (0, "GC_DONE"), events)
        state = self.cluster()
        self.assertEqual(sorted(w[1] for w in self.writes("delete-configmap")), olds[:2])
        self.assertIn("lolly-work-plan300-publication-3009-rollback-v1", state["configmaps"])
        self.assertFalse(any(stray in e["refs"] for e in state["images"].values()))
        for kept in (self.new["image"], self.old["image"]):
            self.assertTrue(any(kept in e["refs"] for e in state["images"].values()), kept)
        self.assertTrue((self.sandbox / "var/lib/lolly-preview/retention-armed-lolly.ing").exists())

    def test_gc_clears_an_archive_a_refused_run_left_behind(self):
        self.behave(bootKeyByImage={self.old["image"]: A.RELEASE_PUBLIC_KEY_THUMBPRINT})
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["code"], "RELEASE_KEY")
        self.assertEqual(len(self.spool()), 1)
        code, events = self.cli("gc")
        self.assertEqual(list([e for e in events if e.get("event") == "gc-spool"][0]["archives"]), self.spool())
        code, events = self.cli("gc", "--execute")
        self.assertEqual((code, self.done(events)["result"]), (0, "GC_DONE"), events)
        self.assertEqual(self.spool(), [])


class IngCutover(IngEndToEnd):
    CONVERTED = False

    def plan_for(self, sha):
        code, events = self.cli("plan", sha)
        self.assertEqual(code, 0, events)
        return dict([e for e in events if e.get("event") == "cutover-plan"][0], source=sha)

    def plan(self):
        return self.plan_for(W_NEW)

    def apply(self, plan, *flags):
        return self.cli("plan", plan.get("source", W_NEW), "--apply", plan["path"], "--reviewed-plan-sha256", plan["sha256"], *flags)

    def assert_no_secret_touched(self):
        """The cut-over moves a Secret reference in the Deployment; it never reads, writes or lists a Secret."""
        for write in self.cluster()["writes"]:
            self.assertNotEqual(write[0], "secret", write)
            if write[0] == "patch":
                for op in write[1]:
                    self.assertFalse(op["path"].startswith("/data") or "/secrets/" in op["path"], op)
                    if "secretKeyRef" in op["path"]:
                        self.assertTrue(op["path"].endswith("/valueFrom/secretKeyRef/name"), op)

    def test_ship_before_cutover_builds_only_and_does_not_need_a_smoke_session(self):
        """The first build exists before the cut-over plan: ship builds and stops at BUILT, touching nothing on the node."""
        (self.sandbox / "smoke-session").unlink()
        build = IF.make_ing_build(self.key, W_NEXT, "first", seq=3002, suse=S_HEAD, lolly="8" * 40)
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["onDispatch"] = IF.ing_run(1300, S_HEAD, status="queued", conclusion=None)
        self.gh["statusSequence"] = {"1300": ["in_progress", "completed"]}
        IF.ing_artifacts(self.gh, build, 1300)
        self.write_gh()
        code, events = self.cli("ship", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"], result["run"]), (0, "BUILT", 1300), events)
        self.assertEqual((self.cluster()["writes"], self.spool()), ([], []))
        self.assertFalse(I.is_converted(self.cluster()["deployment"], 0))
        self.assertFalse([event for event in events if event.get("event") in ("archive", "check-target", "starting")])
        self.assertEqual(len(self.posts()), 1)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual(self.done(events)["code"], "NOT_CONVERTED", events)

    def test_plan_prints_the_exact_patch_and_changes_nothing(self):
        plan = self.plan()
        self.assertEqual((plan["generation"], plan["config"]), (3010, "lolly-ing-config-3010-44444444"))
        self.assertEqual(sorted(plan["removes"]), ["engine-pin", "pack", "shell"])
        removed = [op["path"] for op in plan["patch"] if op["op"] == "remove"]
        self.assertEqual(len(removed), 6)
        self.assertEqual(oct(Path(plan["path"]).stat().st_mode & 0o777), "0o600")
        self.assertEqual(self.cluster()["writes"], [])

    def test_apply_refuses_an_unreviewed_plan(self):
        plan = self.plan()
        code, events = self.cli("plan", W_NEW, "--apply", plan["path"], "--reviewed-plan-sha256", "0" * 64)
        self.assertEqual((code, self.done(events)["code"]), (1, "PLAN_NOT_REVIEWED"))
        self.assertEqual(self.cluster()["writes"], [])

    def test_plan_needs_qualified_sources(self):
        self.update_gh(workCiRuns=[])
        code, events = self.cli("plan", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "CI_NOT_GREEN"), events)

    def test_apply_converts_after_a_backup_and_a_full_rehearsal(self):
        """PROPOSAL 4.8: fresh backup, a full restore rehearsal with nothing pending (#208), then the reviewed patch once.
        Review H3: the same patch points the catalog key at lolly.ing's own Secret, so Work boots with the lolly.ing key."""
        plan = self.plan()
        self.assertEqual((plan["signingKeySecret"], plan["toSigningKeySecret"]), (IF.LEGACY_SIGNING_SECRET, IF.ING_SIGNING_SECRET))
        self.assertEqual(self.signing_ref(), IF.LEGACY_SIGNING_SECRET)
        code, events = self.apply(plan)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "CONVERTED"), events)
        self.assertTrue(I.is_converted(self.cluster()["deployment"], 0))
        image, config, notes = self.live()
        self.assertEqual((image, config, notes["phase"], notes["generation"]), (self.new["image"], plan["config"], "accepted", "3010"))
        self.assertEqual((self.signing_ref(), result["signingKeySecret"]), (IF.ING_SIGNING_SECRET, IF.ING_SIGNING_SECRET))
        checks = {item["check"]: item["ok"] for item in self.result_file()["checks"]}
        self.assertTrue(checks["signing key"] and checks["signed catalog"], checks)  # the lolly.ing key, from the new Secret
        rehearsal = self.result_file()["rehearsal"]
        self.assertEqual((rehearsal["result"], rehearsal["expect"], rehearsal["files"]), ("PASSED", "none", []))
        self.assertEqual((self.cluster()["db"]["generation"], len(self.writes("backup"))), (3010, 1))
        self.assertEqual(self.records()[-1]["backup"]["status"], "VERIFIED")
        self.assertIsNone(notes.get("maintenance"))
        self.assert_no_secret_touched()
        code, events = self.cli("plan", W_NEW)
        self.assertEqual(self.done(events)["code"], "ALREADY_CONVERTED")

    def test_apply_without_a_rehearsal_still_takes_the_backup(self):
        self.without_rehearsal()
        plan = self.plan()
        code, events = self.apply(plan)
        result = self.done(events)
        self.assertEqual((code, result["result"], result["rehearsal"]), (0, "CONVERTED", None), events)
        self.assertEqual((self.rehearsal_pods(), len(self.writes("backup"))), ([], 1))

    def test_a_failed_cutover_returns_to_the_claims_at_a_higher_generation(self):
        """Review H3: the revert restores the old image, the old key reference and the old pack together, so the
        reverted catalog verifies and answers 200 instead of the 503 a Secret left pointing at the new key would give."""
        plan = self.plan()
        code, events = self.apply(plan, "--drill-fail-smoke")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "CONVERSION_REVERTED"), events)
        self.assertFalse(I.is_converted(self.cluster()["deployment"], 0))
        image, config, _ = self.live()
        self.assertEqual((image, result["generation"], self.signing_ref()), (IF.LEGACY_IMAGE, 3011, IF.LEGACY_SIGNING_SECRET))
        self.assertEqual(I.config_generation(self.cluster()["configmaps"][config]["data"]["instance.json"]), 3011)
        back = {item["check"]: item["ok"] for item in self.result_file()["rollbackChecks"]}
        self.assertTrue(back["signed catalog"] and back["generation"], back)
        self.assert_no_secret_touched()

    def test_plan_refuses_until_the_signing_secret_is_pinned(self):
        with mock.patch.object(A, "ING_SIGNING_KEY_SECRET", None):
            code, events = self.cli("plan", W_NEW)
            self.assertEqual((code, self.done(events)["code"]), (1, "SIGNING_SECRET_NOT_PINNED"), events)
        plan = self.plan()
        with mock.patch.object(A, "ING_SIGNING_KEY_SECRET", "another-secret"):  # the plan was made for another anchor
            code, events = self.apply(plan)
            self.assertEqual((code, self.done(events)["code"]), (1, "PLAN_MISMATCH"), events)
        self.assertEqual(self.cluster()["writes"], [])

    # Review 2026-10-25 H2, resolved by Andy's 2026-10-27 choice: the waiting release carries maintenance migrations,
    # and the cut-over takes them after the verified backup, with no approval.
    def test_a_maintenance_migration_at_the_cutover_is_backed_up_marked_applied_and_accepted(self):
        build = self.pending_build(IF.MAINTENANCE)
        plan = self.plan_for(W_NEXT)
        code, events = self.apply(plan)
        result = self.done(events)
        self.assertEqual((code, result["result"], result["maintenance"], result["migrations"]), (0, "CONVERTED", True, [IF.MAINTENANCE]),
                         events)
        manifest = fixture("classify-0078.json")["manifest"]
        self.assertEqual(self.writes("migrate"), [["migrate", [IF.MAINTENANCE], manifest]])
        writes, patches = self.cluster()["writes"], self.writes("patch")
        marker = [p for p in patches if any(op["path"].endswith("preview-maintenance-applied") for op in p[1])]
        self.assertEqual(len(marker), 2, patches)  # written before the migrate Job, cleared on acceptance
        migrate_job = next(w for w in self.writes("job") if w[1] == "migrate")
        self.assertLess(writes.index(self.writes("backup")[0]), writes.index(marker[0]))
        self.assertLess(writes.index(marker[0]), writes.index(migrate_job))
        self.assertLess(patches.index(marker[0]), patches.index(next(p for p in patches if any("/volumes/" in op["path"] for op in p[1]))))
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], notes["maintenance"], json.loads(notes["maintenance-migrations"]), self.signing_ref()),
                         (build["image"], "accepted", "true", [IF.MAINTENANCE], IF.ING_SIGNING_SECRET))
        self.assertIsNone(notes.get("maintenance-applied"))
        self.assertEqual(self.restore_point()["previousImage"], IF.LEGACY_IMAGE)
        code, events = self.cli("rollback")
        self.assertEqual(self.done(events)["code"], "MAINTENANCE_NO_ROLLBACK", events)
        self.assertEqual(self.live()[0], build["image"])

    def test_a_failed_smoke_after_a_maintenance_cutover_is_held_not_reverted(self):
        """The legacy image cannot be trusted on the new schema, so the automatic revert is off: MAINTENANCE_UNVERIFIED (exit 3),
        and the result names the backup to restore with the old layout."""
        build = self.pending_build(IF.MAINTENANCE)
        plan = self.plan_for(W_NEXT)
        self.behave(brokenSite=[build["image"]])
        code, events = self.apply(plan)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (3, "MAINTENANCE_UNVERIFIED"), events)
        self.assertEqual(result["backup"]["previousImage"], IF.LEGACY_IMAGE)
        image, _, notes = self.live()
        self.assertTrue(I.is_converted(self.cluster()["deployment"], 0))
        self.assertEqual((image, notes["phase"], json.loads(notes["maintenance-applied"]), self.signing_ref()),
                         (build["image"], "maintenance-unverified", [IF.MAINTENANCE], IF.ING_SIGNING_SECRET))
        self.assertFalse([p for p in self.writes("patch") if any(op["op"] == "add" and "/volumes/" in op["path"] for op in p[1])])
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN", events)
        code, events = self.cli("rollback", "--clear-hold")
        self.assertEqual(self.done(events)["code"], "MAINTENANCE_NO_ROLLBACK", events)

    def test_a_stopped_maintenance_cutover_with_a_transient_cleanup_read_failure_is_held(self):
        """The first cleanup read fails after migration and cut-over. The base cleanup's next read must not allow a revert."""
        build = self.pending_build(IF.MAINTENANCE)
        plan = self.plan_for(W_NEXT)
        os.environ["FAKE_ING_ABORT"] = "cutover-read"
        code, events = self.apply(plan)
        self.assertEqual((code, self.done(events)["result"]), (3, "MAINTENANCE_UNVERIFIED"), events)
        reads = [e["failed"] for e in events if e.get("event") == "drill-cleanup-read"]
        self.assertEqual(reads[:2], [True, False], events)
        self.assertEqual([w[1] for w in self.writes("migrate")], [[IF.MAINTENANCE]])
        image, _, notes = self.live()
        self.assertTrue(I.is_converted(self.cluster()["deployment"], 0))
        self.assertEqual((image, notes["phase"], json.loads(notes["maintenance-applied"]), self.signing_ref()),
                         (build["image"], "maintenance-unverified", [IF.MAINTENANCE], IF.ING_SIGNING_SECRET))
        self.assertFalse([p for p in self.writes("patch") if any(op["op"] == "add" and "/volumes/" in op["path"] for op in p[1])])
        self.assertIn("automatic rollback is off", self.result_file()["note"])

    def test_a_stale_backup_before_a_migration_at_the_cutover_applies_nothing(self):
        """The backup must be under 1 hour old when the schema changes, as for a deploy."""
        self.pending_build(IF.MAINTENANCE)
        plan = self.plan_for(W_NEXT)
        os.environ["FAKE_AGE_AFTER_REHEARSAL"] = "2"
        code, events = self.apply(plan)
        self.assertEqual((code, self.done(events)["code"]), (1, "BACKUP_STALE"), events)
        self.assertEqual((self.writes("migrate"), self.writes("patch")), ([], []))
        self.assertFalse(I.is_converted(self.cluster()["deployment"], 0))
        self.assertIsNone(self.live()[2].get("maintenance-applied"))

    def test_an_additive_migration_at_the_cutover_still_reverts(self):
        """Additive migrations keep the automatic revert: the old image runs beside them."""
        self.pending_build(IF.ADDITIVE)
        plan = self.plan_for(W_NEXT)
        code, events = self.apply(plan, "--drill-fail-smoke")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "CONVERSION_REVERTED"), events)
        self.assertEqual(self.writes("migrate"), [["migrate", [IF.ADDITIVE], fixture("classify-0077.json")["manifest"]]])
        self.assertEqual((self.live()[0], self.signing_ref()), (IF.LEGACY_IMAGE, IF.LEGACY_SIGNING_SECRET))
        self.assertFalse([p for p in self.writes("patch") if any(op["path"].endswith("preview-maintenance-applied") for op in p[1])])


if __name__ == "__main__":
    unittest.main()
