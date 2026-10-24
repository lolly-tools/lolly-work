# SPDX-License-Identifier: MPL-2.0
"""Restore rehearsal operator tests (deploy/preview/restore-rehearsal.py and
deploy/preview/lib/preview_rehearsal.py). Fakes only: the driver runs a fake
kubectl (tests/restore_rehearsal_fakes.py); no cluster, node or database is
contacted.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path.insert(0, str(TESTS))
import restore_rehearsal_fakes as F  # noqa: E402  (puts deploy/preview/lib on sys.path)
import preview_common as C  # noqa: E402
import preview_rehearsal as R  # noqa: E402

CLI = ROOT / "deploy" / "preview" / "restore-rehearsal.py"


def walk(value):
    """Every (key, value) pair in a JSON document."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


class Manifests(unittest.TestCase):
    def setUp(self):
        self.inputs = F.inputs()
        self.config_map, self.pod = R.run_manifests(self.inputs, R.read_programs())
        self.spec = self.pod["spec"]
        self.containers = {c["name"]: c for c in self.spec["initContainers"] + self.spec["containers"]}

    def test_only_a_backup_artifact_reaches_the_pod(self):
        text = json.dumps([self.config_map, self.pod])
        for forbidden in R.FORBIDDEN_NAMESPACES | {"lolly-work-instance", "lolly-postgres", "DATABASE_URL_UNPOOLED"}:
            self.assertNotIn(f'"{forbidden}"', text, forbidden)
        keys = {key for key, _ in walk(self.pod)}
        for forbidden in ("persistentVolumeClaim", "hostPath", "secretKeyRef", "envFrom", "hostNetwork", "hostPID",
                          "serviceAccountName", "projected", "csi", "nfs"):
            self.assertNotIn(forbidden, keys)
        self.assertEqual({o["metadata"]["namespace"] for o in (self.config_map, self.pod)}, {R.NAMESPACE})
        kinds = {v["name"]: next(k for k in v if k != "name") for v in self.spec["volumes"]}
        self.assertEqual({k for k in kinds.values()}, {"configMap", "secret", "emptyDir", "downwardAPI"})
        self.assertEqual([n for n, k in kinds.items() if k == "secret"], ["backup"])
        backup = next(v for v in self.spec["volumes"] if v["name"] == "backup")["secret"]
        self.assertEqual(backup["secretName"], R.SECRET)
        self.assertEqual([i["key"] for i in backup["items"]], list(R.SECRET_KEYS))
        mounting = [n for n, c in self.containers.items() if any(m["name"] == "backup" for m in c["volumeMounts"])]
        self.assertEqual(mounting, ["fetch"], "only the fetch step sees the backup credential")
        self.assertEqual(self.containers["fetch"]["image"], F.PREVIOUS_IMAGE, "the credential is only lent to the accepted image")
        self.assertFalse(self.spec["automountServiceAccountToken"])
        self.assertEqual(self.spec["dnsPolicy"], "None")
        self.assertEqual(self.spec["hostAliases"], [{"ip": F.STORAGE_ADDRESS, "hostnames": [F.STORAGE_HOST]}])

    def test_every_container_meets_the_restricted_pod_security_level(self):
        self.assertTrue(self.spec["securityContext"]["runAsNonRoot"])
        self.assertEqual(self.spec["securityContext"]["seccompProfile"], {"type": "RuntimeDefault"})
        for name, c in self.containers.items():
            with self.subTest(container=name):
                sc = c["securityContext"]
                self.assertFalse(sc["allowPrivilegeEscalation"])
                self.assertTrue(sc["readOnlyRootFilesystem"])
                self.assertEqual(sc["capabilities"], {"drop": ["ALL"]})
                self.assertRegex(c["image"], r"@sha256:[0-9a-f]{64}$")
                self.assertTrue(c["resources"]["limits"]["memory"] and c["resources"]["limits"]["cpu"])

    def test_steps_run_in_order_with_postgres_as_a_sidecar(self):
        self.assertEqual([c["name"] for c in self.spec["initContainers"]], ["fetch", "postgres", "restore", "migrate", "verify"])
        self.assertEqual([c["name"] for c in self.spec["containers"]], ["previous"])
        self.assertEqual(self.containers["postgres"]["restartPolicy"], "Always")
        self.assertIn("startupProbe", self.containers["postgres"])
        self.assertEqual(self.containers["migrate"]["image"], F.NEW_IMAGE)
        self.assertEqual(self.containers["previous"]["image"], F.PREVIOUS_IMAGE)
        self.assertEqual(self.spec["restartPolicy"], "Never")

    def test_migrate_gets_the_database_url_expectation_and_node_env_only(self):
        env = self.containers["migrate"]["env"]
        self.assertEqual([e["name"] for e in env], ["DATABASE_URL", "LW_MIGRATE_EXPECT", "NODE_ENV"])
        values = {e["name"]: e["value"] for e in env}
        self.assertEqual(values["DATABASE_URL"], f"postgresql://{R.APP_ROLE}@/{R.DATABASE}?host=/socket&port={R.POSTGRES_PORT}")
        self.assertEqual(values["LW_MIGRATE_EXPECT"], R.migration_manifest(F.PENDING))
        for name, c in self.containers.items():
            if name != "migrate":
                self.assertNotIn("env", c, name)
        _, empty = R.run_manifests(F.inputs(pending=[]), R.read_programs())
        migrate = next(c for c in empty["spec"]["initContainers"] if c["name"] == "migrate")
        self.assertEqual({e["name"]: e["value"] for e in migrate["env"]}["LW_MIGRATE_EXPECT"], "none")

    def test_manifest_hash_matches_the_runner(self):
        # The same vector is in tests/migrate.test.ts for server/src/store/migrate.ts.
        files = [{"name": "0002_b.sql", "sha256": "b" * 64}, {"name": "0001_a.sql", "sha256": "a" * 64}]
        self.assertEqual(R.migration_manifest(files), "sha256:1cc3157ffa8c6643215d3e0aaafda8169a39da8775fd024c428c1aa69def7fe1")
        self.assertEqual(R.migration_manifest([]), "sha256:82dd7937e974dabb4422978e047da44cb3ab19ab94b3486ea3336adf6c424735")

    def test_config_map_carries_the_programs_and_the_run_settings(self):
        data = self.config_map["data"]
        self.assertTrue(self.config_map["immutable"])
        for name in R.PROGRAM_FILES:
            self.assertEqual(data[name], (ROOT / "deploy/preview/rehearsal" / name).read_text())
        self.assertEqual(data["pending.txt"], "0077_gadgets.sql\n0078_widgets.sql\n", "apply order")
        self.assertEqual(json.loads(data["archive.json"])["storageHost"], F.STORAGE_HOST)
        self.assertEqual(data["archive-sha256"], F.BACKUP["sha256"])
        self.assertEqual(data["lock-budget-seconds"], "30")
        self.assertEqual(data["postgres-major"], "18")

    def test_setup_is_deny_all_with_one_https_egress_rule(self):
        items = R.setup_manifests(R.NAMESPACE, ["203.0.113.7/32", "2001:db8::7/128"])["items"]
        namespace, deny, egress, quota, priority = items
        self.assertEqual(priority["metadata"]["name"], R.PRIORITY_CLASS)
        self.assertLess(priority["value"], 0)
        self.assertEqual(priority["preemptionPolicy"], "Never")
        self.assertEqual(egress["spec"]["podSelector"], {"matchLabels": {R.EGRESS_LABEL: "open"}})
        self.assertEqual(namespace["metadata"]["labels"]["pod-security.kubernetes.io/enforce"], "restricted")
        self.assertEqual(deny["spec"], {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]})
        rules = egress["spec"]["egress"]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["ports"], [{"protocol": "TCP", "port": 443}])
        self.assertEqual([p["ipBlock"]["cidr"] for p in rules[0]["to"]], ["203.0.113.7/32", "2001:db8::7/128"])
        self.assertNotIn("ingress", egress["spec"])
        self.assertEqual(quota["spec"]["hard"]["pods"], "1")
        self.assertEqual(quota["spec"]["hard"]["persistentvolumeclaims"], "0")
        self.assertNotIn("Secret", {i["kind"] for i in items}, "the operator creates the credential by hand")
        for bad in (["0.0.0.0/0"], ["::/0"], [], ["not-a-cidr"], ["10.0.0.1/24"], ["10.1.2.3/32"], ["172.16.4.4/32"],
                    ["192.168.1.1/32"], ["fd00::1/128"], ["100.64.1.1/32"], ["127.0.0.1/32"], ["169.254.169.254/32"],
                    ["fe80::1/128"], ["::1/128"], ["198.51.100.0/23"], ["2001:db8::/32"], ["8.0.0.0/8"],
                    ["::ffff:10.0.0.1/128"], ["203.0.113.0/24", "10.0.0.0/8"]):
            with self.subTest(cidrs=bad), self.assertRaises(C.Refusal):
                R.setup_manifests(R.NAMESPACE, bad)
        for namespace in ("lolly-private", "kube-system", "default", "kube-anything", "other-ns", "lolly-restore", "lolly-restore-rehearsalx"):
            with self.subTest(namespace=namespace), self.assertRaises(C.Refusal):
                R.setup_manifests(namespace, ["203.0.113.7/32"])

    def test_inputs_are_validated(self):
        cases = {
            "unverified backup": dict(backup=dict(F.BACKUP, status="UPLOADED")),
            "extra backup field": dict(backup=dict(F.BACKUP, note="x")),
            "object escapes": dict(backup=dict(F.BACKUP, object="lolly/../other.lwbackup")),
            "object kind": dict(backup=dict(F.BACKUP, object="lolly/backups/x.dump")),
            "oversized": dict(backup=dict(F.BACKUP, size=129 * 1024 * 1024)),
            "tag not digest": dict(new_image="docker.io/library/lolly-work:latest"),
            "bare digest": dict(previous_image="sha256:" + "d" * 64),
            "live namespace": dict(namespace="lolly-private"),
            "kube namespace": dict(namespace="kube-flannel"),
            "duplicate pending": dict(pending=[F.PENDING[0], F.PENDING[0]]),
            "pending path": dict(pending=[{"name": "../x.sql", "sha256": "1" * 64}]),
            "pending hash": dict(pending=[{"name": "0077_x.sql", "sha256": "XYZ"}]),
            "loopback store": dict(storage_address="127.0.0.1"),
            "rfc1918 store": dict(storage_address="10.0.0.5"),
            "rfc1918 store 172": dict(storage_address="172.20.1.1"),
            "rfc1918 store 192": dict(storage_address="192.168.0.9"),
            "cgnat store": dict(storage_address="100.100.1.1"),
            "ula store": dict(storage_address="fd12:3456::1"),
            "link-local store": dict(storage_address="169.254.169.254"),
            "mapped private store": dict(storage_address="::ffff:10.0.0.1"),
            "not in the allow-list": dict(namespace="lolly-restore"),
            "allow-list lookalike": dict(namespace="lolly-restore-rehearsalx"),
            "budget over 30 without override": dict(lock_budget_seconds=31),
            "store host": dict(storage_host="backups"),
            "budget": dict(lock_budget_seconds=121),
            "zero budget": dict(lock_budget_seconds=0),
            "run id": dict(run_id="Run_1"),
            "pgdata": dict(pgdata_size="400Mi"),
        }
        for label, override in cases.items():
            with self.subTest(case=label), self.assertRaises(C.Refusal) as caught:
                F.inputs(**override)
            self.assertEqual(caught.exception.code, "BAD_INPUT")

    def test_programs_are_valid_shell_and_javascript(self):
        for name in R.PROGRAM_FILES:
            path = ROOT / "deploy/preview/rehearsal" / name
            command = ["bash", "-n", str(path)] if name.endswith(".sh") else [shutil.which("node") or "node", "--check", str(path)]
            if not shutil.which(command[0]):
                self.skipTest(f"{command[0]} not available")
            done = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, f"{name}: {done.stderr}")

    def test_the_operator_ships_in_the_pinned_tool_tree_not_the_work_image(self):
        import preview_mac
        files = {relative for relative, _ in preview_mac.tool_files(ROOT)}
        for name in ("deploy/preview/restore-rehearsal.py", "deploy/preview/lib/preview_rehearsal.py",
                     *(f"deploy/preview/rehearsal/{n}" for n in R.PROGRAM_FILES)):
            self.assertIn(name, files)
        dockerfile = (ROOT / "deploy/compose/Dockerfile").read_text()
        self.assertNotIn("COPY deploy", dockerfile)


class Runs(unittest.TestCase):
    """The driver against the fake kubectl."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rehearsal-test-"))
        self.state = self.tmp / "state.json"
        self.kubectl = F.write_kubectl(self.tmp / "bin")
        self._env = os.environ.get("FAKE_REHEARSAL_STATE")
        os.environ["FAKE_REHEARSAL_STATE"] = str(self.state)

    def tearDown(self):
        if self._env is None:
            os.environ.pop("FAKE_REHEARSAL_STATE", None)
        else:
            os.environ["FAKE_REHEARSAL_STATE"] = self._env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_with(self, cluster=None, **input_overrides):
        self.state.write_text(json.dumps(cluster or F.cluster()))
        clock = F.FakeClock()
        driver = R.Rehearsal(R.Kubectl([str(self.kubectl)]), F.inputs(**input_overrides), sleep=clock.sleep,
                             monotonic=clock, poll_seconds=5)
        return driver.run()

    def cluster_state(self):
        return json.loads(self.state.read_text())

    def assert_clean(self, result):
        state = self.cluster_state()
        self.assertTrue(result["teardownComplete"], result["teardown"])
        leftovers = [n for kind in ("Pod", "ConfigMap") for n in state["objects"][R.NAMESPACE][kind] if n != "kube-root-ca.crt"]
        self.assertEqual(leftovers, [])
        for call in state["calls"]:
            self.assertNotIn("secret", " ".join(call).lower().replace("--dry-run", ""), "the driver never reads a Secret")
            if "-n" in call:
                self.assertEqual(call[call.index("-n") + 1], R.NAMESPACE)
            if call[:2] == ["delete", "--raw"]:
                self.assertTrue(call[2].startswith(f"/api/v1/namespaces/{R.NAMESPACE}/"), call)
        return state

    def test_a_passing_rehearsal_records_each_file_and_removes_everything(self):
        result = self.run_with()
        self.assertEqual((result["result"], result["code"]), ("PASSED", None), result.get("reason"))
        self.assertEqual([f["name"] for f in result["files"]], ["0077_gadgets.sql", "0078_widgets.sql"])
        self.assertEqual(result["expect"], R.migration_manifest(F.PENDING))
        self.assertEqual(set(result["steps"]), set(R.STEPS))
        state = self.assert_clean(result)
        creates = [c for c in state["calls"] if c[:1] == ["create"]]
        self.assertEqual([("--dry-run=server" in c) for c in creates], [True, False, True, False], "a server dry run before each create")
        self.assertEqual([d["kind"] for d in state["deleted"]], ["Pod", "ConfigMap"])
        self.assertEqual({d["uid"] for d in state["deleted"]}, {result["created"]["Pod"]["uid"], result["created"]["ConfigMap"]["uid"]})

    def test_no_pending_migrations_is_a_plain_restore_and_boot_rehearsal(self):
        result = self.run_with(pending=[])
        self.assertEqual(result["result"], "PASSED", result.get("reason"))
        self.assertEqual(result["expect"], "none")
        self.assertEqual(result["files"], [])
        self.assert_clean(result)

    def test_preflight_refusals_create_nothing(self):
        def drift(change):
            cluster = F.cluster()
            change(cluster)
            return cluster

        ns = R.NAMESPACE
        policies = lambda c: c["networkpolicies"][ns]  # noqa: E731
        egress = lambda c: policies(c)[1]["spec"]  # noqa: E731
        cases = {
            "KUBERNETES_TOO_OLD": drift(lambda c: c["serverVersion"].update(minor="28")),
            "NAMESPACE_UNSAFE": drift(lambda c: c["namespaces"][ns]["metadata"]["labels"].pop("app.kubernetes.io/managed-by")),
            "NAMESPACE_UNSAFE ": drift(lambda c: c["namespaces"][ns]["metadata"]["labels"].update(
                {"pod-security.kubernetes.io/enforce": "baseline"})),
            "POLICY_DRIFT": drift(lambda c: policies(c).append({"metadata": {"name": "allow-all"}, "spec": {"podSelector": {}}})),
            "POLICY_DRIFT ": drift(lambda c: policies(c)[0]["spec"].update(egress=[{}])),
            "POLICY_DRIFT  ": drift(lambda c: egress(c)["egress"][0]["ports"].append({"protocol": "UDP", "port": 53})),
            "POLICY_DRIFT   ": drift(lambda c: egress(c)["egress"].append({"to": [{"ipBlock": {"cidr": "198.51.100.0/24"}}]})),
            "POLICY_DRIFT    ": drift(lambda c: egress(c)["egress"][0]["to"].append({"namespaceSelector": {}})),
            "POLICY_DRIFT     ": drift(lambda c: egress(c)["egress"][0]["to"].append({"ipBlock": {"cidr": "0.0.0.0/0"}})),
            "POLICY_DRIFT      ": drift(lambda c: egress(c).update(ingress=[{}])),
            "POLICY_DRIFT       ": drift(lambda c: c["resourcequotas"].update({ns: []})),
            "STORAGE_OUTSIDE_POLICY": drift(lambda c: egress(c)["egress"][0]["to"][0]["ipBlock"].update(
                cidr="198.51.100.0/24")),
            "STORAGE_OUTSIDE_POLICY ": drift(lambda c: egress(c)["egress"][0]["to"][0]["ipBlock"].update(
                cidr="203.0.113.0/24", **{"except": ["203.0.113.7/32"]})),
            "REHEARSAL_BUSY": drift(lambda c: c["objects"][ns]["Pod"].update(
                {"other": {"kind": "Pod", "metadata": {"name": "other", "uid": "u"}}})),
            "REHEARSAL_BUSY ": drift(lambda c: c["objects"][ns]["PersistentVolumeClaim"].update(
                {"claim": {"kind": "PersistentVolumeClaim", "metadata": {"name": "claim", "uid": "u"}}})),
        }
        for code, cluster in cases.items():
            with self.subTest(code=code):
                result = self.run_with(cluster)
                self.assertEqual((result["result"], result["code"]), ("REFUSED", code.strip()), result.get("reason"))
                state = self.cluster_state()
                self.assertFalse([c for c in state["calls"] if c[:1] == ["create"]], "nothing is created")
                self.assertEqual(result["created"], {})

    def test_a_missing_namespace_is_refused(self):
        cluster = F.cluster()
        cluster["namespaces"] = {}
        result = self.run_with(cluster)
        self.assertEqual((result["result"], result["code"]), ("REFUSED", "KUBECTL"))

    def test_each_failing_step_has_its_own_code_and_still_tears_down(self):
        cases = [
            ("ARCHIVE_UNVERIFIED", dict(failAt="fetch", reason="the recovered object is not the named backup")),
            ("RESTORE_FAILED", dict(failAt="restore", reason="pg_restore failed")),
            ("MIGRATE_REFUSED", dict(failAt="migrate", reason="MIGRATE_REFUSED")),
            ("MIGRATE_EXPECT_UNSUPPORTED", dict(failAt="migrate", reason="MIGRATE_EXPECT_UNSUPPORTED: the new image predates it")),
            ("IMAGE_FILE_MISMATCH", dict(failAt="migrate", reason="IMAGE_FILE_MISMATCH: the image's 0077_gadgets.sql differs")),
            ("MIGRATE_FAILED", dict(failAt="migrate", reason="MIGRATE_FAILED")),
            ("LOCK_BUDGET_EXCEEDED", dict(failAt="migrate", reason="MIGRATE_FAILED", lockTimeout=True)),
            ("LOCK_BUDGET_EXCEEDED", dict(seconds={"0078_widgets.sql": 31.5})),
            ("RECORD_MISMATCH", dict(failAt="verify", reports={"verify": {"status": "RECORD_MISMATCH", "missing": ["0077_gadgets.sql"]}})),
            ("PREVIOUS_IMAGE_FAILED", dict(failAt="previous", reason="the previous image exited during boot (1)")),
            ("TIMEOUT", dict(deadlineAt="migrate")),
            ("POD_NOT_STARTED", dict(neverStarts=True)),
        ]
        for code, scenario in cases:
            with self.subTest(code=code, scenario=scenario):
                result = self.run_with(F.cluster(**scenario))
                self.assertEqual((result["result"], result["code"]), ("FAILED", code), result.get("reason"))
                self.assert_clean(result)
        result = self.run_with(F.cluster(seconds={"0078_widgets.sql": 31.5}))
        self.assertIn("0078_widgets.sql 31.5 s", result["reason"])

    def test_the_driver_checks_every_report_again(self):
        cases = [
            ("LOCK_BUDGET_EXCEEDED", dict(reports={"verify": {"files": [{"name": "0077_gadgets.sql", "seconds": 40},
                                                                         {"name": "0078_widgets.sql", "seconds": 1}]}})),
            ("RECORD_MISMATCH", dict(reports={"verify": {"appliedAfterCount": 70}})),
            ("RECORD_MISMATCH", dict(reports={"verify": {"files": [{"name": "0077_gadgets.sql", "seconds": 1}]}})),
            ("EVIDENCE_MISMATCH", dict(reports={"verify": {"files": [{"name": "0077_gadgets.sql", "seconds": -655.4},
                                                                         {"name": "0078_widgets.sql", "seconds": 1}]}})),
            ("EVIDENCE_MISMATCH", dict(reports={"fetch": {"sha256": "f" * 64}})),
            ("EVIDENCE_MISMATCH", dict(reports={"restore": {"serverVersion": "170011"}})),
            ("EVIDENCE_MISMATCH", dict(reports={"restore": {"appliedBefore": F.APPLIED_BEFORE + ["0077_gadgets.sql"]}})),
            ("EVIDENCE_MISMATCH", dict(reports={"migrate": {"applied": ["0077_gadgets.sql"]}})),
            ("EVIDENCE_MISMATCH", dict(imageIDs={"migrate": F.PREVIOUS_IMAGE})),
            ("EVIDENCE_MISMATCH", dict(restarts={"postgres": 1})),
            ("PREVIOUS_IMAGE_FAILED", dict(reports={"previous": {"status": "NO_REPORT"}})),
        ]
        for code, scenario in cases:
            with self.subTest(code=code, scenario=scenario):
                result = self.run_with(F.cluster(**scenario))
                self.assertEqual((result["result"], result["code"]), ("FAILED", code), result.get("reason"))
                self.assert_clean(result)

    def test_an_unexpected_answer_still_ends_in_a_result_and_a_teardown(self):
        result = self.run_with(F.cluster(failAt="previous", podStatusGarbage=True))
        self.assertEqual((result["result"], result["code"]), ("FAILED", "INTERNAL_ERROR"))
        self.assert_clean(result)

    def test_an_admission_change_is_refused_and_the_config_map_removed(self):
        result = self.run_with(F.cluster(admissionAddsContainer=True))
        self.assertEqual((result["result"], result["code"]), ("REFUSED", "ADMISSION_CHANGED"))
        state = self.assert_clean(result)
        self.assertEqual([d["kind"] for d in state["deleted"]], ["ConfigMap"])

    def test_a_failed_teardown_is_reported(self):
        result = self.run_with(F.cluster(deleteFails=True))
        self.assertEqual(result["result"], "PASSED")
        self.assertFalse(result["teardownComplete"])
        self.assertTrue(result["teardown"]["Pod"].startswith("delete failed"))
        result = self.run_with(F.cluster(lingers={"Pod": True}))
        self.assertFalse(result["teardownComplete"])
        self.assertEqual(result["teardown"]["Pod"], "still present")

    def test_cleanup_removes_only_labelled_leftovers_and_never_a_running_rehearsal(self):
        cluster = F.cluster()
        objects = cluster["objects"][R.NAMESPACE]
        mine = R.labels("old")
        objects["Pod"]["restore-rehearsal-old"] = {"kind": "Pod", "metadata": {"name": "restore-rehearsal-old", "uid": "p1",
                                                                              "labels": mine}, "status": {"phase": "Failed"}}
        objects["ConfigMap"]["restore-rehearsal-old"] = {"kind": "ConfigMap", "metadata": {"name": "restore-rehearsal-old",
                                                                                          "uid": "c1", "labels": mine}}
        self.state.write_text(json.dumps(cluster))
        clock = F.FakeClock()
        removed = R.cleanup(R.Kubectl([str(self.kubectl)]), R.NAMESPACE, sleep=clock.sleep, monotonic=clock)
        self.assertEqual(removed, {"Pod/restore-rehearsal-old": "deleted", "ConfigMap/restore-rehearsal-old": "deleted"})
        self.assertIn("kube-root-ca.crt", self.cluster_state()["objects"][R.NAMESPACE]["ConfigMap"])
        cluster["objects"][R.NAMESPACE]["Pod"]["restore-rehearsal-old"]["status"]["phase"] = "Running"
        self.state.write_text(json.dumps(cluster))
        with self.assertRaises(C.Refusal) as caught:
            R.cleanup(R.Kubectl([str(self.kubectl)]), R.NAMESPACE, sleep=clock.sleep, monotonic=clock)
        self.assertEqual(caught.exception.code, "REHEARSAL_RUNNING")
        with self.assertRaises(C.Refusal):
            R.cleanup(R.Kubectl([str(self.kubectl)]), "lolly-private")
        cluster["namespaces"][R.NAMESPACE]["metadata"]["labels"].pop("app.kubernetes.io/managed-by")
        self.state.write_text(json.dumps(cluster))
        with self.assertRaises(C.Refusal) as caught:
            R.cleanup(R.Kubectl([str(self.kubectl)]), R.NAMESPACE, sleep=clock.sleep, monotonic=clock)
        self.assertEqual(caught.exception.code, "NAMESPACE_UNSAFE")

    def test_egress_closes_after_fetch_and_before_the_new_image_runs(self):
        result = self.run_with()
        self.assertEqual(result["result"], "PASSED", result.get("reason"))
        self.assertTrue(result["egressClosedAfterFetch"])
        state = self.assert_clean(result)
        calls = state["calls"]
        label = [i for i, c in enumerate(calls) if c[:2] == ["label", "pod"]]
        self.assertEqual(len(label), 1)
        self.assertEqual(calls[label[0]][-1], f"{R.EGRESS_LABEL}-")
        self.assertLess(label[0], next(i for i, c in enumerate(calls) if c[:2] == ["delete", "--raw"]))
        self.assertEqual(result["steps"]["migrate"]["egress"], "CLOSED")
        self.assertEqual(result["steps"]["previous"]["egress"], "CLOSED")

    def test_a_run_whose_egress_stays_open_or_is_unconfirmed_fails(self):
        cases = {
            "label sticks": F.cluster(labelSticks=True),
            "label call fails": F.cluster(labelFails=True),
            "migrate did not confirm": F.cluster(reports={"migrate": {"egress": "OPEN"}}),
            "previous did not confirm": F.cluster(reports={"previous": {"egress": None}}),
        }
        for label, cluster in cases.items():
            with self.subTest(label):
                result = self.run_with(cluster)
                self.assertEqual((result["result"], result["code"]), ("FAILED", "EGRESS_NOT_CLOSED"), result.get("reason"))
                self.assert_clean(result)

    def test_the_pod_has_a_low_priority_and_only_migrate_and_previous_read_its_labels(self):
        _, pod = R.run_manifests(F.inputs(), R.read_programs())
        self.assertEqual(pod["spec"]["priorityClassName"], R.PRIORITY_CLASS)
        self.assertEqual(pod["metadata"]["labels"][R.EGRESS_LABEL], "open")
        containers = pod["spec"]["initContainers"] + pod["spec"]["containers"]
        self.assertEqual([c["name"] for c in containers if any(m["name"] == "podinfo" for m in c["volumeMounts"])],
                         ["migrate", "previous"])
        missing = F.cluster()
        missing["priorityclasses"] = {}
        result = self.run_with(missing)
        self.assertEqual((result["result"], result["code"]), ("REFUSED", "KUBECTL"))

    def test_ephemeral_storage_covers_the_pgdata_allowance(self):
        for size, limit in (("4Gi", "5Gi"), ("10Gi", "11Gi")):
            _, pod = R.run_manifests(F.inputs(pgdata_size=size), R.read_programs())
            postgres = next(c for c in pod["spec"]["initContainers"] if c["name"] == "postgres")
            self.assertEqual(postgres["resources"]["limits"]["ephemeral-storage"], limit)

    def test_a_lock_budget_above_the_default_needs_a_recorded_override(self):
        with self.assertRaises(C.Refusal):
            F.inputs(lock_budget_seconds=31)
        long = F.inputs(lock_budget_seconds=90, lock_budget_override=True)
        self.assertTrue(long.record()["lockBudgetOverride"])
        self.assertFalse(F.inputs(lock_budget_seconds=30, lock_budget_override=True).record()["lockBudgetOverride"])
        self.assertFalse(F.inputs().record()["lockBudgetOverride"])

    def test_policy_drift_to_private_or_wide_egress_is_refused(self):
        ns = R.NAMESPACE
        for cidr in ("10.0.0.0/8", "203.0.113.0/16", "192.168.4.0/24", "100.64.0.0/10"):
            with self.subTest(cidr=cidr):
                cluster = F.cluster()
                cluster["networkpolicies"][ns][1]["spec"]["egress"][0]["to"].append({"ipBlock": {"cidr": cidr}})
                result = self.run_with(cluster)
                self.assertEqual((result["result"], result["code"]), ("REFUSED", "POLICY_DRIFT"), result.get("reason"))

    def test_a_lost_create_response_is_found_by_label_and_removed(self):
        for kind in ("Pod", "ConfigMap"):
            with self.subTest(kind=kind):
                result = self.run_with(F.cluster(loseCreateResponse={kind: True}))
                self.assertEqual(result["code"], "KUBECTL")
                self.assertEqual(result["result"], "FAILED" if kind == "Pod" else "REFUSED")
                self.assertIn(kind, result["created"], "the object the answer never confirmed is adopted")
                self.assertEqual(result["teardown"][kind], "deleted")
                self.assertTrue(result["teardownComplete"])
                self.assert_clean(result)

    def test_an_unreadable_label_list_after_a_lost_create_is_not_a_complete_teardown(self):
        result = self.run_with(F.cluster(loseCreateResponse={"ConfigMap": True}, listFails=True))
        self.assertEqual(result["created"], {})
        self.assertEqual(result["labelSweep"], "unreadable")
        self.assertFalse(result["teardownComplete"], "nothing was verified gone and nothing could be listed")
        self.assertIn("labelSweep", result["teardown"])

    def test_a_refused_create_with_an_empty_label_list_is_a_complete_teardown(self):
        result = self.run_with(F.cluster(refuseCreate=True))
        self.assertEqual(result["created"], {})
        self.assertEqual(result["labelSweep"], "empty")
        self.assertTrue(result["teardownComplete"])

    def test_teardown_needs_a_verified_deletion_after_a_create_was_attempted(self):
        driver = R.Rehearsal(R.Kubectl([str(self.kubectl)]), F.inputs())
        self.assertTrue(driver._teardown_complete({}), "no create attempted")
        driver.create_attempted = True
        self.assertFalse(driver._teardown_complete({}), "a create was attempted and nothing is known gone")
        driver.sweep = "found"
        self.assertFalse(driver._teardown_complete({}))
        self.assertTrue(driver._teardown_complete({"Pod": "deleted"}))
        self.assertFalse(driver._teardown_complete({"Pod": "deleted", "ConfigMap": "still present"}))

    def test_command_line(self):
        backup, pending = self.tmp / "backup.json", self.tmp / "pending.json"
        backup.write_text(json.dumps(F.BACKUP))
        pending.write_text(json.dumps(F.PENDING))
        common = ["--backup", str(backup), "--pending", str(pending), "--new-image", F.NEW_IMAGE,
                  "--previous-image", F.PREVIOUS_IMAGE, "--postgres-image", F.POSTGRES_IMAGE,
                  "--storage-host", F.STORAGE_HOST, "--storage-address", F.STORAGE_ADDRESS, "--run-id", "cli",
                  "--deadline", "120"]

        def cli(*args):
            return subprocess.run([sys.executable, "-B", str(CLI), *args], capture_output=True, text=True, timeout=300)

        plan = cli("plan", *common)
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertEqual([i["kind"] for i in json.loads(plan.stdout)["items"]], ["ConfigMap", "Pod"])
        setup = cli("setup", "--egress-cidr", "203.0.113.7/32")
        self.assertEqual(setup.returncode, 0, setup.stderr)
        self.assertEqual(len(json.loads(setup.stdout)["items"]), 5)
        kube = ["--kubectl", json.dumps([str(self.kubectl)])]
        # No flag: refused before the cluster is contacted, and before check-target.
        self.state.write_text(json.dumps(F.cluster(polls=0)))
        bad = cli("run", *common, *kube)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (2, "PRODUCTION_HOST_FLAG"))
        bad = cli("cleanup", *kube)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (2, "PRODUCTION_HOST_FLAG"))
        self.assertEqual(self.cluster_state()["calls"], [])
        # A failing check-target stops the run before any kubectl call.
        target = self.tmp / "lolly-private" / "production" / "check-target.py"
        target.parent.mkdir(parents=True)
        target.write_text("import sys\nsys.stderr.write('identity drift\\n')\nsys.exit(1)\n")
        prod = ["--on-production-host", "--check-target", str(target)]
        bad = cli("run", *common, *kube, *prod)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (2, "CHECK_TARGET_FAILED"))
        self.assertIn("identity drift", json.loads(bad.stdout)["reason"])
        self.assertEqual(self.cluster_state()["calls"], [])
        # A check-target outside lolly-private/production is refused outright.
        stray = self.tmp / "check-target.py"
        stray.write_text("import sys\nsys.exit(0)\n")
        bad = cli("run", *common, *kube, "--on-production-host", "--check-target", str(stray))
        self.assertEqual(json.loads(bad.stdout)["code"], "CHECK_TARGET_PATH")
        # It receives --site lolly.ing.
        target.write_text("import sys\nopen(sys.argv[0] + '.args', 'w').write(' '.join(sys.argv[1:]))\nsys.exit(0)\n")
        run = cli("run", *common, *kube, *prod)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(json.loads(run.stdout)["result"], "PASSED")
        self.assertEqual(Path(str(target) + ".args").read_text(), "--site lolly.ing")
        self.state.write_text(json.dumps(F.cluster(polls=0, failAt="previous")))
        run = cli("run", *common, *kube, *prod)
        self.assertEqual(run.returncode, 1)
        cleaned = cli("cleanup", *kube, *prod)
        self.assertEqual(cleaned.returncode, 0, cleaned.stdout + cleaned.stderr)
        bad = cli("run", *common, "--kubectl", "kubectl", *prod)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (2, "BAD_INPUT"))
        bad = cli("plan", *common[:-2], "--namespace", "lolly-private")
        self.assertEqual(bad.returncode, 2)
        pending.write_text('[{"name": "0077_x.sql", "name": "0078_y.sql", "sha256": "' + "1" * 64 + '"}]')
        bad = cli("plan", *common)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (2, "BAD_JSON"))


if __name__ == "__main__":
    unittest.main()
