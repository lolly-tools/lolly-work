# SPDX-License-Identifier: MPL-2.0
"""Application updater boundary and concurrency tests; no cluster required."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "app-update.py"
spec = importlib.util.spec_from_file_location("app_update", SCRIPT)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
OLD = "registry.example/lolly-work@sha256:" + "a" * 64
NEW = "registry.example/lolly-work@sha256:" + "b" * 64


def target():
    return {"version": 1, "transport": {"type": "local", "kubectl": ["kubectl"],
             "kubeconfig": "/operator/production.kubeconfig", "context": "production"},
            "clusterUID": "cluster-uid", "node": {"name": "production", "uid": "node-uid"},
            "components": {"work": {"namespace": "work", "namespaceUID": "namespace-uid",
                "deployment": "lolly-work", "deploymentUID": "deployment-uid", "container": "server",
                "requiredLabels": {"owned": "work"}, "healthURLs": ["https://work.example/healthz"]}}}


def deployment():
    return {"metadata": {"name": "lolly-work", "namespace": "work", "uid": "deployment-uid",
              "resourceVersion": "7", "generation": 1, "labels": {"owned": "work"}},
            "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "selector": {"matchLabels": {"app": "work"}},
              "template": {"metadata": {"labels": {"app": "work"}}, "spec": {
                "automountServiceAccountToken": False,
                "securityContext": {"runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [{"name": "server", "image": OLD,
                  "envFrom": [{"secretRef": {"name": "existing-instance"}}],
                  "resources": {"limits": {"memory": "512Mi"}},
                  "volumeMounts": [{"name": "pack", "mountPath": "/pack", "readOnly": True}]},
                  {"name": "sidecar", "image": "registry.example/sidecar@sha256:" + "c" * 64}],
                "volumes": [{"name": "pack", "persistentVolumeClaim": {"claimName": "existing-pack"}}]}}},
            "status": {"observedGeneration": 1, "updatedReplicas": 1, "availableReplicas": 1, "replicas": 1}}


class FakeKube:
    def __init__(self):
        self.value = deployment()
        self.cluster_uid = "cluster-uid"
        self.node_uid = "node-uid"
        self.namespace_uid = "namespace-uid"
        self.writes = []
        self.dry_runs = []
        self.rollouts = []
        self.admission_change = False
        self.fail_second_dry_run = False

    def get(self, kind, name, namespace=None):
        if kind == "namespace":
            return {"metadata": {"uid": self.cluster_uid if name == "kube-system" else self.namespace_uid}}
        if kind == "node":
            return {"metadata": {"uid": self.node_uid}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        return copy.deepcopy(self.value)

    def patch(self, component, patch, dry_run):
        current = self.value
        index = int(patch[-1]["path"].split("/")[5])
        expected = update.image_patch(current, index, patch[-1]["value"])
        if patch != expected:
            raise update.Refusal("JSON patch test failed")
        result = copy.deepcopy(current)
        result["spec"]["template"]["spec"]["containers"][index]["image"] = patch[-1]["value"]
        if dry_run:
            self.dry_runs.append(patch)
            if self.fail_second_dry_run and len(self.dry_runs) == 2:
                raise update.Refusal("server dry run refused")
            if self.admission_change:
                result["spec"]["replicas"] = 2
        else:
            self.writes.append(patch)
            result["metadata"]["resourceVersion"] = str(int(current["metadata"]["resourceVersion"]) + 1)
            result["metadata"]["generation"] += 1
            result["status"]["observedGeneration"] = result["metadata"]["generation"]
            self.value = result
        return result

    def rollout(self, component, timeout):
        self.rollouts.append(component["deployment"])


class MultiKube(FakeKube):
    def __init__(self):
        super().__init__()
        self.second = deployment()
        self.second["metadata"].update(name="lolly-web", uid="web-uid")
        self.refuse_web = False
        self.race = False
        self.deployment_reads = 0

    def get(self, kind, name, namespace=None):
        if kind == "deployment":
            self.deployment_reads += 1
            if self.race and self.deployment_reads == 3:
                self.value["metadata"]["resourceVersion"] = "8"
            if name == "lolly-web":
                return copy.deepcopy(self.second)
        return super().get(kind, name, namespace)

    def patch(self, component, patch, dry_run):
        if component["deployment"] == "lolly-web":
            if dry_run and self.refuse_web:
                raise update.Refusal("Web dry run refused")
            saved = self.value
            self.value = self.second
            try:
                result = super().patch(component, patch, dry_run)
                self.second = self.value
                return result
            finally:
                self.value = saved
        return super().patch(component, patch, dry_run)


class PartialFailureKube(MultiKube):
    def patch(self, component, patch, dry_run):
        if component["deployment"] == "lolly-web" and not dry_run:
            raise update.Refusal("Second patch transport failed")
        return super().patch(component, patch, dry_run)


def release(image=NEW):
    return {"version": 1, "updates": [{"component": "work", "expectedImage": OLD, "image": image}]}


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.target = target()
        self.kube = FakeKube()

    def plan(self):
        return update.make_plan(self.target, release(), self.kube)

    def test_default_plan_does_not_mutate(self):
        plan = self.plan()
        self.assertEqual(len(plan["updates"]), 1)
        self.assertEqual(len(self.kube.dry_runs), 1)
        self.assertEqual(self.kube.writes, [])
        self.assertEqual(self.kube.rollouts, [])

    def test_reviewed_update_changes_only_owned_image(self):
        before = update.protected_spec(self.kube.value, 0)
        plan = self.plan()
        health = []
        result = update.apply_plan(self.target, plan, update.digest(plan), self.kube, health=health.append)
        self.assertEqual(result["result"], "UPDATED")
        self.assertEqual(update.protected_spec(self.kube.value, 0), before)
        self.assertEqual(len(self.kube.writes), 1)
        self.assertEqual(self.kube.rollouts, ["lolly-work"])
        self.assertEqual(health, ["https://work.example/healthz"])

    def test_no_change_has_no_patch_or_rollout(self):
        plan = update.make_plan(self.target, release(OLD), self.kube)
        self.assertEqual(plan["updates"], [])
        result = update.apply_plan(self.target, plan, update.digest(plan), self.kube)
        self.assertEqual(result["result"], "NO_CHANGE")
        self.assertEqual(self.kube.dry_runs + self.kube.writes + self.kube.rollouts, [])

    def test_wrong_cluster_node_namespace_and_deployment_uids_refuse(self):
        for field in ("cluster_uid", "node_uid", "namespace_uid"):
            with self.subTest(field=field):
                kube = FakeKube()
                setattr(kube, field, "wrong")
                with self.assertRaises(update.Refusal):
                    update.make_plan(self.target, release(), kube)
                self.assertEqual(kube.writes + kube.dry_runs, [])
        self.kube.value["metadata"]["uid"] = "wrong"
        with self.assertRaises(update.Refusal):
            self.plan()

    def test_unpinned_images_refuse(self):
        for value in ("registry.example/lolly-work:latest", "registry.example/lolly-work@sha256:abc", NEW.upper(), "https://" + NEW):
            with self.subTest(value=value), self.assertRaises(update.Refusal):
                update.make_plan(self.target, release(value), self.kube)
        self.assertEqual(self.kube.dry_runs, [])

    def test_unowned_duplicate_and_protected_components_refuse(self):
        for name in ("edge", "database", "other"):
            r = release()
            r["updates"][0]["component"] = name
            with self.assertRaises(update.Refusal):
                update.make_plan(self.target, r, self.kube)
        r = release()
        r["updates"].append(copy.deepcopy(r["updates"][0]))
        with self.assertRaises(update.Refusal):
            update.make_plan(self.target, r, self.kube)
        self.target["components"]["work"]["deployment"] = "sovereign-edge"
        with self.assertRaises(update.Refusal):
            self.plan()

    def test_unexpected_current_image_refuses(self):
        self.kube.value["spec"]["template"]["spec"]["containers"][0]["image"] = NEW
        with self.assertRaises(update.Refusal):
            update.make_plan(self.target, release("registry.example/lolly-work@sha256:" + "d" * 64), self.kube)

    def test_missing_or_mismatched_review_hash_refuses(self):
        plan = self.plan()
        for value in (None, "", "0" * 64):
            with self.subTest(value=value), self.assertRaises(update.Refusal):
                update.apply_plan(self.target, plan, value, self.kube)
        self.assertEqual(self.kube.writes, [])

    def test_protected_field_patch_refuses_even_with_matching_review_hash(self):
        plan = self.plan()
        plan["updates"][0]["patch"].append({"op": "replace", "path": "/spec/replicas", "value": 2})
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, update.digest(plan), self.kube)
        self.assertEqual(self.kube.writes, [])

    def test_admission_protected_field_change_refuses_before_writes(self):
        self.kube.admission_change = True
        with self.assertRaises(update.Refusal):
            self.plan()
        self.assertEqual(self.kube.writes, [])

    def test_resource_version_and_spec_changes_since_review_refuse(self):
        for mutation in (lambda d: d["metadata"].update(resourceVersion="8"),
                         lambda d: d["spec"]["template"]["spec"]["volumes"].clear()):
            with self.subTest(mutation=mutation):
                self.kube = FakeKube()
                plan = self.plan()
                mutation(self.kube.value)
                with self.assertRaises(update.Refusal):
                    update.apply_plan(self.target, plan, update.digest(plan), self.kube)
                self.assertEqual(self.kube.writes, [])

    def test_second_server_dry_run_refusal_prevents_write(self):
        plan = self.plan()
        self.kube.fail_second_dry_run = True
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, update.digest(plan), self.kube)
        self.assertEqual(self.kube.writes, [])

    def test_target_change_and_forged_identity_refuse(self):
        plan = self.plan()
        changed = copy.deepcopy(self.target)
        changed["transport"]["context"] = "another-context"
        with self.assertRaises(update.Refusal):
            update.apply_plan(changed, plan, update.digest(plan), self.kube)
        plan["updates"][0]["deploymentUID"] = "someone-elses-deployment"
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, update.digest(plan), self.kube)
        self.assertEqual(self.kube.writes, [])

    def test_missing_hash_cli_refuses_without_running_kubectl(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "target.json").write_text(json.dumps(self.target))
            plan = self.plan()
            (root / "plan.json").write_text(json.dumps(plan))
            result = subprocess.run([sys.executable, str(SCRIPT), "--target", str(root / "target.json"),
                                     "--apply", str(root / "plan.json")], text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("requires --reviewed-plan-sha256", result.stderr)

    def test_duplicate_json_keys_and_previous_plan_overwrite_refuse(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "plan.json"
            path.write_text('{"version":1,"version":2}')
            with self.assertRaises(update.Refusal):
                update.load_json(path)
            with self.assertRaises(FileExistsError):
                update.write_json(path, {})

    def test_explicit_transport_and_no_credential_health_urls(self):
        self.target["transport"]["kubeconfig"] = "relative"
        with self.assertRaises(update.Refusal):
            update.validate_target(self.target)
        self.target = target()
        self.target["components"]["work"]["healthURLs"] = ["https://user:secret@work.example/healthz"]
        with self.assertRaises(update.Refusal):
            update.validate_target(self.target)

    def test_multiple_components_all_dry_run_before_any_write(self):
        self.target["components"]["public-web"] = copy.deepcopy(self.target["components"]["work"])
        self.target["components"]["public-web"].update(deployment="lolly-web", deploymentUID="web-uid", healthURLs=[])
        r = release()
        r["updates"].append({"component": "public-web", "expectedImage": OLD, "image": NEW})
        kube = MultiKube()
        plan = update.make_plan(self.target, r, kube)
        kube.refuse_web = True
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, update.digest(plan), kube)
        self.assertEqual(kube.writes, [])

    def test_race_after_dry_run_refuses_before_first_patch(self):
        kube = MultiKube()
        plan = update.make_plan(self.target, release(), kube)
        kube.deployment_reads = 1
        kube.race = True
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, update.digest(plan), kube)
        self.assertEqual(kube.writes, [])

    def test_reserved_namespace_and_actual_protected_role_refuse(self):
        for namespace in update.RESERVED_NAMESPACES:
            with self.subTest(namespace=namespace):
                t = target()
                t["components"]["work"]["namespace"] = namespace
                with self.assertRaises(update.Refusal):
                    update.make_plan(t, release(), self.kube)
        for role in update.PROTECTED_ROLES:
            with self.subTest(role=role):
                self.kube.value["metadata"]["labels"]["app.kubernetes.io/component"] = role
                with self.assertRaises(update.Refusal):
                    self.plan()
        self.assertEqual(self.kube.writes + self.kube.dry_runs, [])

    def test_partial_apply_reports_success_and_uncertain_attempt_without_rollback(self):
        self.target["components"]["public-web"] = copy.deepcopy(self.target["components"]["work"])
        self.target["components"]["public-web"].update(deployment="lolly-web", deploymentUID="web-uid", healthURLs=[])
        r = release()
        r["updates"].append({"component": "public-web", "expectedImage": OLD, "image": NEW})
        kube = PartialFailureKube()
        plan = update.make_plan(self.target, r, kube)
        with self.assertRaises(update.ApplyFailure) as raised:
            update.apply_plan(self.target, plan, update.digest(plan), kube)
        failure = raised.exception
        self.assertEqual([r["component"] for r in failure.applied], ["work"])
        self.assertEqual([r["component"] for r in failure.attempted], ["work", "public-web"])
        self.assertEqual(failure.phase, "patch:public-web")
        self.assertEqual(kube.value["spec"]["template"]["spec"]["containers"][0]["image"], NEW)
        self.assertEqual(kube.second["spec"]["template"]["spec"]["containers"][0]["image"], OLD)
        self.assertEqual(len(kube.writes), 1)

    def test_health_failure_keeps_update_and_reports_phase(self):
        plan = self.plan()
        def failed_health(url):
            raise update.Refusal("HTTPS health failed")
        with self.assertRaises(update.ApplyFailure) as raised:
            update.apply_plan(self.target, plan, update.digest(plan), self.kube, health=failed_health)
        self.assertEqual(raised.exception.phase, "https-health:work")
        self.assertEqual(len(raised.exception.applied), 1)
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["containers"][0]["image"], NEW)

    def test_https_uses_standard_verified_ssl_context(self):
        context = update.ssl.create_default_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, update.ssl.CERT_REQUIRED)
        with patch.object(update.ssl, "create_default_context", return_value=context) as create, \
             patch.object(update.urllib.request, "build_opener") as build:
            build.return_value.open.return_value.__enter__.return_value.status = 200
            update.health_check("https://work.example/healthz")
            create.assert_called_once_with()
            self.assertIs(build.call_args.args[1]._context, context)


if __name__ == "__main__":
    unittest.main()
