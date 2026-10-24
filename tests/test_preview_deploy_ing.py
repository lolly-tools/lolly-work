# SPDX-License-Identifier: MPL-2.0
"""lolly.ing preview deploy tests (PROPOSAL section 4). Fakes only: no network, cluster, node or GitHub.

The unit tests cover the generation rule, the generation-only config change, the
migration guard, the build manifest of suse-lolly's lolly-ing-preview.yml (PR #28),
the key rules and the guarded patches. They read Work's real classifier output (PR
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
        plan = I.cutover_plan(before, 0, self.build["image"], "cfg-3010", {"lolly.tools/preview-phase": "converting"})
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
        self.gh = {"mainHead": "f" * 40, "compare": {}, "calls": [], "runs": [], "ciRuns": [], "statusSequence": {},
                   "suseMainHead": S_HEAD, "ingRuns": [], "artifacts": {}, "zips": {}, "approvals": {}, "enginePins": {}}
        self.write_gh()
        self.add_run(self.new, 1100)
        self.environ = mock.patch.dict(os.environ, {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_STATE": str(self.cluster_path), "FAKE_GH_STATE": str(self.gh_path),
            "FAKE_SANDBOX": str(self.sandbox), "FAKE_BIN": str(self.bin), "FAKE_PIN": json.dumps(A.RELEASE_PUBLIC_KEY_JWK),
            "FAKE_ING_PIN": json.dumps(self.key[1]), "FAKE_KNOWN_HOSTS": str(self.known_hosts), "FAKE_SITE": "lolly.ing",
            "FAKE_REHEARSAL_STATE": str(self.rehearsal_path)})
        self.environ.start()
        for name in ("FAKE_CRASH_PHASE", "FAKE_CHECK_TARGET", "FAKE_SSH_DOWN", "FAKE_START_REPLY_LOST", "FAKE_UNIT_NEVER_STARTS",
                     "FAKE_CRASH_AFTER_SWITCH"):
            os.environ.pop(name, None)
        self.patches = [mock.patch.object(A, "ING_PUBLIC_KEY_JWK", self.key[1]), mock.patch.object(M, "SLEEP", lambda s: None),
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
        self.gh["ingRuns"].append(IF.ing_run(run_id, build["suse"], **run_fields))
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

    def approve(self, run_id, login="andy"):
        self.gh = json.loads(self.gh_path.read_text())
        self.gh["approvals"][str(run_id)] = [{"state": "approved", "environments": [{"name": "lolly-ing-maintenance"}],
                                              "user": {"login": login}, "comment": ""}]
        self.write_gh()


class IngDeploys(IngEndToEnd):
    def test_deploy_imports_backs_up_publishes_a_higher_generation_and_smokes(self):
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
        self.assertEqual((len(self.writes("backup")), len(self.writes("import"))), (1, 1))
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
        self.assertEqual([r["result"] for r in self.records()], ["LIVE"])
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

    def test_a_pending_allowlisted_migration_is_rehearsed_then_applied_with_the_manifest_form(self):
        """#207 classifies it additive; #208's real driver rehearses it; the migrate Job carries the sha256 manifest."""
        build = self.pending_build(IF.ADDITIVE)
        code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "LIVE"), events)
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

    def test_a_maintenance_migration_without_approval_applies_and_switches_nothing(self):
        """#207 classifies an ADD CONSTRAINT as maintenance. It needs Andy's approval in the private run (PROPOSAL 4.4)."""
        self.pending_build(IF.MAINTENANCE)
        code, events = self.cli("deploy", W_NEXT)
        self.assertEqual((code, self.done(events)["code"]), (1, "MAINTENANCE_NOT_APPROVED"), events)
        self.assert_untouched()
        self.assertEqual((self.rehearsal_pods(), self.writes("configmap")), ([], []))

    def test_a_maintenance_migration_with_approval_is_held_not_rolled_back(self):
        """Automatic rollback is off after a maintenance migration: recovery would be a restore."""
        build = self.pending_build(IF.MAINTENANCE)
        self.approve(1200, login="someone-else")
        with mock.patch.object(A, "ING_MAINTENANCE_APPROVERS", ("andy",)):
            code, events = self.cli("deploy", W_NEXT)
            self.assertEqual(self.done(events)["code"], "MAINTENANCE_NOT_APPROVED")  # an approver the tool does not pin
            self.approve(1200)
            self.behave(brokenSite=[build["image"]])
            code, events = self.cli("deploy", W_NEXT)
        result = self.done(events)
        self.assertEqual((code, result["result"]), (3, "MAINTENANCE_UNVERIFIED"), events)
        image, _, notes = self.live()
        self.assertEqual((image, notes["phase"], notes["maintenance"]), (build["image"], "maintenance-unverified", "true"))
        self.assertEqual([w[1] for w in self.writes("migrate")], [[IF.MAINTENANCE]])
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual(self.done(events)["code"], "HELD_FOR_HUMAN")
        code, events = self.cli("rollback", "--clear-hold")
        self.assertEqual(self.done(events)["code"], "MAINTENANCE_NO_ROLLBACK")
        self.assertEqual(self.live()[0], build["image"])
        code, events = self.cli("deploy", W_NEW, "--clear-hold")  # an image without that migration: the database is ahead
        self.assertEqual(self.done(events)["code"], "DATABASE_AHEAD")
        fix = IF.make_ing_build(self.key, "7" * 40, "fix", seq=3003, suse=S_HEAD, migrations=build["migrations"])
        self.add_run(fix, 1300)
        self.behave(brokenSite=[])
        code, events = self.cli("deploy", "7" * 40, "--clear-hold")  # the forward fix: nothing pending, so no new approval
        self.assertEqual((code, self.done(events)["result"]), (0, "LIVE"), events)
        image, _, notes = self.live()
        self.assertEqual((image, notes.get("maintenance"), json.loads(notes["maintenance-migrations"])),
                         (fix["image"], None, [IF.MAINTENANCE]))

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
        self.assertEqual((code, self.done(events)["code"]), (1, "MANIFEST_INVALID"), events)
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

    def test_a_stale_backup_stops_before_the_switch(self):
        self.behave(backupAgeHours=7)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "BACKUP_STALE"), events)
        self.assert_untouched()

    def test_a_failed_backup_stops_everything(self):
        self.behave(backupFails=True)
        code, events = self.cli("deploy", W_NEW)
        self.assertEqual((code, self.done(events)["code"]), (1, "JOB_FAILED"), events)
        self.assert_untouched()

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

    def plan(self):
        code, events = self.cli("plan", W_NEW)
        self.assertEqual(code, 0, events)
        return [e for e in events if e.get("event") == "cutover-plan"][0]

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

    def test_apply_converts_after_a_full_rehearsal(self):
        """PROPOSAL 4.8: fresh backup, a full restore rehearsal with nothing pending (#208), then the reviewed patch once."""
        plan = self.plan()
        code, events = self.cli("plan", W_NEW, "--apply", plan["path"], "--reviewed-plan-sha256", plan["sha256"])
        result = self.done(events)
        self.assertEqual((code, result["result"]), (0, "CONVERTED"), events)
        self.assertTrue(I.is_converted(self.cluster()["deployment"], 0))
        image, config, notes = self.live()
        self.assertEqual((image, config, notes["phase"], notes["generation"]), (self.new["image"], plan["config"], "accepted", "3010"))
        rehearsal = self.result_file()["rehearsal"]
        self.assertEqual((rehearsal["result"], rehearsal["expect"], rehearsal["files"]), ("PASSED", "none", []))
        self.assertEqual(self.cluster()["db"]["generation"], 3010)
        code, events = self.cli("plan", W_NEW)
        self.assertEqual(self.done(events)["code"], "ALREADY_CONVERTED")

    def test_a_failed_cutover_returns_to_the_claims_at_a_higher_generation(self):
        plan = self.plan()
        code, events = self.cli("plan", W_NEW, "--apply", plan["path"], "--reviewed-plan-sha256", plan["sha256"], "--drill-fail-smoke")
        result = self.done(events)
        self.assertEqual((code, result["result"]), (2, "CONVERSION_REVERTED"), events)
        self.assertFalse(I.is_converted(self.cluster()["deployment"], 0))
        image, config, _ = self.live()
        self.assertEqual((image, result["generation"]), (IF.LEGACY_IMAGE, 3011))
        self.assertEqual(I.config_generation(self.cluster()["configmaps"][config]["data"]["instance.json"]), 3011)
        back = {item["check"]: item["ok"] for item in self.result_file()["rollbackChecks"]}
        self.assertTrue(back["signed catalog"] and back["generation"], back)


if __name__ == "__main__":
    unittest.main()
