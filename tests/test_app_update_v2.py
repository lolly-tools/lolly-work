# SPDX-License-Identifier: MPL-2.0
"""Named regular/init image updates use one guarded patch per Deployment."""
import copy
import sys
import unittest

sys.dont_write_bytecode = True
from test_app_update import FakeKube, OLD, NEW, deployment, target, update

SHELL_OLD = "registry.example/shell@sha256:" + "c" * 64
SHELL_NEW = "registry.example/shell@sha256:" + "d" * 64
PACK_OLD = "registry.example/pack@sha256:" + "e" * 64
PACK_NEW = "registry.example/pack@sha256:" + "f" * 64


def group_target():
    value = target(); value["version"] = 2
    owned = value["components"]["work"]; owned.pop("container")
    owned["images"] = [{"kind": "container", "name": "server"},
                       {"kind": "initContainer", "name": "shell-from-image"},
                       {"kind": "initContainer", "name": "pack-from-image"}]
    return value


def group_release():
    return {"version": 2, "updates": [{"component": "work", "images": [
        {"kind": "container", "name": "server", "expectedImage": OLD, "image": NEW},
        {"kind": "initContainer", "name": "shell-from-image", "expectedImage": SHELL_OLD, "image": SHELL_NEW},
        {"kind": "initContainer", "name": "pack-from-image", "expectedImage": PACK_OLD, "image": PACK_NEW}]}]}


class GroupKube(FakeKube):
    def __init__(self):
        super().__init__()
        pod = self.value["spec"]["template"]["spec"]
        pod["volumes"] = [{"name": "pack", "emptyDir": {}}, {"name": "shell", "emptyDir": {"sizeLimit": "2Gi"}}]
        pod["initContainers"] = [{"name": "shell-from-image", "image": SHELL_OLD,
                                   "command": ["sh", "-c", "cp -a /shell/. /shell-volume/"],
                                   "volumeMounts": [{"name": "shell", "mountPath": "/shell-volume"}]},
                                  {"name": "pack-from-image", "image": PACK_OLD,
                                   "command": ["sh", "-c", "cp -a /pack/. /pack-volume/"],
                                   "volumeMounts": [{"name": "pack", "mountPath": "/pack-volume"}]}]
        self.mutate_admission = None
        self.fail_patch_for = None
        self.second = None
        self.reads = []
        self.live_document = {"revision": 18, "newWrites": ["retained"]}

    def get(self, kind, name, namespace=None):
        self.reads.append((kind, name, namespace))
        if kind == "deployment" and self.second and name == self.second["metadata"]["name"]:
            return copy.deepcopy(self.second)
        return super().get(kind, name, namespace)

    def patch(self, component, operations, dry_run):
        if not dry_run and component["deployment"] == self.fail_patch_for:
            raise update.Refusal("Uncertain synthetic transport failure")
        original = self.second if self.second and component["deployment"] == self.second["metadata"]["name"] else self.value
        result = copy.deepcopy(original)
        for operation in operations:
            parts = operation["path"].split("/")[1:]
            parent = result
            for key in parts[:-1]:
                parent = parent[int(key)] if isinstance(parent, list) else parent[key]
            key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
            if operation["op"] == "test":
                update.require(parent[key] == operation["value"], "Synthetic server JSON test failed")
            elif operation["op"] == "replace":
                parent[key] = operation["value"]
            else:
                raise update.Refusal("Synthetic server refuses unexpected patch op")
        if dry_run:
            self.dry_runs.append(copy.deepcopy(operations))
            if self.mutate_admission:
                self.mutate_admission(result)
        else:
            self.writes.append(copy.deepcopy(operations))
            result["metadata"]["resourceVersion"] = str(int(original["metadata"]["resourceVersion"]) + 1)
            result["metadata"]["generation"] += 1
            result["status"]["observedGeneration"] = result["metadata"]["generation"]
            if original is self.second:
                self.second = result
            else:
                self.value = result
        return result


class GroupUpdateTests(unittest.TestCase):
    def setUp(self):
        self.target = group_target(); self.release = group_release(); self.kube = GroupKube()

    def plan(self):
        return update.make_plan(self.target, self.release, self.kube)

    def apply(self, plan):
        return update.apply_plan(self.target, plan, update.digest(plan), self.kube, health=lambda _: None)

    def test_mixed_regular_and_init_images_change_atomically_and_roll_once(self):
        plan = self.plan(); self.assertEqual(plan["version"], 2); self.assertEqual(len(plan["updates"]), 1)
        record = plan["updates"][0]; patch = record["patch"]
        self.assertEqual([item["op"] for item in patch], ["test"] * 9 + ["replace"] * 3)
        self.assertEqual([item["path"] for item in patch[-3:]], [
            "/spec/template/spec/containers/0/image", "/spec/template/spec/initContainers/0/image", "/spec/template/spec/initContainers/1/image"])
        protected = update.group_protected_spec(self.kube.value, record["images"])
        result = self.apply(plan)
        self.assertEqual(result["result"], "UPDATED"); self.assertEqual(len(self.kube.writes), 1)
        self.assertEqual(self.kube.rollouts, ["lolly-work"])
        self.assertEqual(update.group_protected_spec(self.kube.value, record["images"]), protected)
        self.assertEqual(self.kube.value["metadata"]["resourceVersion"], "8")
        self.assertEqual(self.kube.live_document, {"revision": 18, "newWrites": ["retained"]})

    def test_release_can_update_only_content_and_keeps_server_image_protected(self):
        self.release["updates"][0]["images"] = self.release["updates"][0]["images"][1:]
        plan = self.plan(); self.apply(plan)
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["containers"][0]["image"], OLD)
        self.assertEqual(len(self.kube.writes[0]), 9)
        self.kube = GroupKube(); plan = self.plan()
        self.kube.value["spec"]["template"]["spec"]["containers"][0]["image"] = NEW
        with self.assertRaises(update.Refusal): self.apply(plan)
        self.assertEqual(self.kube.writes, [])

    def test_same_name_in_regular_and_init_arrays_is_not_the_same_slot(self):
        self.kube.value["spec"]["template"]["spec"]["containers"][1]["name"] = "shell-from-image"
        original = self.kube.value["spec"]["template"]["spec"]["containers"][1]["image"]
        plan = self.plan(); self.apply(plan)
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["containers"][1]["image"], original)

    def test_all_images_already_current_have_no_patch_or_rollout(self):
        for image in self.release["updates"][0]["images"]: image["image"] = image["expectedImage"]
        plan = self.plan(); self.assertEqual(plan["updates"], []); self.assertEqual(len(plan["unchanged"]), 1)
        self.assertEqual(self.apply(plan)["result"], "NO_CHANGE")
        self.assertEqual(self.kube.dry_runs + self.kube.writes + self.kube.rollouts, [])

    def test_unknown_duplicate_and_output_like_selectors_are_refused_before_reads(self):
        for kind, name in [("volumes", "pack"), ("container", "other"), ("initContainer", "../server"), ("configMap", "engine-pin")]:
            r = copy.deepcopy(self.release); r["updates"][0]["images"][0].update(kind=kind, name=name)
            with self.subTest(kind=kind, name=name), self.assertRaises(update.Refusal): update.make_plan(self.target, r, self.kube)
        r = copy.deepcopy(self.release); r["updates"][0]["images"][1] = copy.deepcopy(r["updates"][0]["images"][0])
        with self.assertRaises(update.Refusal): update.make_plan(self.target, r, self.kube)
        self.assertEqual(self.kube.reads + self.kube.dry_runs + self.kube.writes, [])

    def test_version_and_schema_mismatch_refuse_before_cluster_reads(self):
        for version in [1, 2.0, "2", True]:
            r = copy.deepcopy(self.release); r["version"] = version
            with self.subTest(version=version), self.assertRaises(update.Refusal): update.make_plan(self.target, r, self.kube)
        for component in [None, [], "other"]:
            r = copy.deepcopy(self.release); r["updates"][0]["component"] = component
            with self.subTest(component=component), self.assertRaises(update.Refusal): update.make_plan(self.target, r, self.kube)
        t = copy.deepcopy(self.target); t["version"] = 2.0
        with self.assertRaises(update.Refusal): update.validate_target(t)
        self.assertEqual(self.kube.reads, [])

    def test_target_duplicates_and_multiple_aliases_to_same_deployment_are_refused(self):
        t = copy.deepcopy(self.target); t["components"]["work"]["images"].append(t["components"]["work"]["images"][0])
        with self.assertRaises(update.Refusal): update.validate_target(t)
        t = copy.deepcopy(self.target); t["components"]["public-web"] = copy.deepcopy(t["components"]["work"])
        with self.assertRaises(update.Refusal): update.validate_target(t)

    def test_admission_adapter_still_cannot_own_init_or_extra_images(self):
        owned = self.target["components"].pop("work")
        owned.update(deployment="admission-adapter", images=[{"kind": "container", "name": "adapter"}],
                     requiredLabels=update.ADMISSION_LABELS.copy())
        self.target["components"]["admission-rest"] = owned
        update.validate_target(self.target)
        for images in [[{"kind": "initContainer", "name": "adapter"}],
                       [{"kind": "container", "name": "adapter"}, {"kind": "container", "name": "server"}]]:
            wrong = copy.deepcopy(self.target); wrong["components"]["admission-rest"]["images"] = images
            with self.subTest(images=images), self.assertRaises(update.Refusal): update.validate_target(wrong)

    def test_review_hash_and_target_binding_refuse_before_reads(self):
        plan = self.plan(); self.kube.reads.clear()
        with self.assertRaises(update.Refusal):
            update.apply_plan(self.target, plan, "0" * 64, self.kube, health=lambda _: None)
        wrong = copy.deepcopy(self.target); wrong["node"]["uid"] = "another-node"
        with self.assertRaises(update.Refusal):
            update.apply_plan(wrong, plan, update.digest(plan), self.kube, health=lambda _: None)
        self.assertEqual(self.kube.reads + self.kube.writes, [])

    def test_missing_ambiguous_mixed_kind_and_stale_expected_slots_refuse(self):
        for mutate in [lambda pod: pod.pop("initContainers"),
                       lambda pod: pod["initContainers"].append(copy.deepcopy(pod["initContainers"][0])),
                       lambda pod: pod["initContainers"][0].update(image=NEW)]:
            self.kube = GroupKube(); mutate(self.kube.value["spec"]["template"]["spec"])
            with self.assertRaises(update.Refusal): self.plan()
            self.assertEqual(self.kube.dry_runs + self.kube.writes, [])

    def test_admission_cannot_mutate_config_volumes_secrets_security_or_unselected_image(self):
        mutations = [lambda value: value["spec"]["template"]["spec"]["volumes"].clear(),
                     lambda value: value["spec"]["template"]["spec"]["containers"][0]["envFrom"].clear(),
                     lambda value: value["spec"]["template"]["spec"]["securityContext"].clear(),
                     lambda value: value["spec"]["template"]["spec"]["containers"][1].update(image=NEW),
                     lambda value: value["spec"].update(replicas=2)]
        for mutate in mutations:
            self.kube = GroupKube(); self.kube.mutate_admission = mutate
            with self.assertRaises(update.Refusal): self.plan()
            self.assertEqual(self.kube.writes, [])

    def test_forged_reviewed_plan_cannot_change_extra_fields_kind_or_index(self):
        original = self.plan()
        for mutate in [lambda record: record["patch"].append({"op": "replace", "path": "/spec/template/spec/volumes/0/emptyDir", "value": {}}),
                       lambda record: record["images"][0].update(index=1),
                       lambda record: record["images"][1].update(kind="container"),
                       lambda record: record["images"][0].update(secret="not-allowed")]:
            plan = copy.deepcopy(original); mutate(plan["updates"][0])
            with self.assertRaises(update.Refusal): self.apply(plan)
            self.assertEqual(self.kube.writes, [])

    def test_resource_version_or_image_changes_after_review_refuse_before_patch(self):
        for mutate in [lambda value: value["metadata"].update(resourceVersion="8"),
                       lambda value: value["spec"]["template"]["spec"]["initContainers"][0].update(image=NEW)]:
            self.kube = GroupKube(); plan = self.plan(); mutate(self.kube.value)
            with self.assertRaises(update.Refusal): self.apply(plan)
            self.assertEqual(self.kube.writes, [])

    def test_selected_init_image_refuses_durable_unknown_or_ambiguous_storage(self):
        for volume in [{"name": "shell", "persistentVolumeClaim": {"claimName": "live-data"}},
                       {"name": "shell", "hostPath": {"path": "/live"}},
                       {"name": "shell", "csi": {"driver": "data.example"}},
                       {"name": "shell", "emptyDir": {}, "secret": {"secretName": "input"}},
                       {"name": "shell", "unknown": {}}]:
            self.kube = GroupKube(); pod = self.kube.value["spec"]["template"]["spec"]
            pod["volumes"][1] = volume
            with self.subTest(volume=volume), self.assertRaises(update.Refusal): self.plan()
            self.assertEqual(self.kube.dry_runs + self.kube.writes, [])
        for volumes in [[], [{"name": "shell", "emptyDir": {}}] * 2]:
            self.kube = GroupKube(); self.kube.value["spec"]["template"]["spec"]["volumes"] = volumes
            with self.assertRaises(update.Refusal): self.plan()
        self.kube = GroupKube(); pod = self.kube.value["spec"]["template"]["spec"]
        pod["volumes"].append({"name": "block", "persistentVolumeClaim": {"claimName": "live-block"}})
        pod["initContainers"][0]["volumeDevices"] = [{"name": "block", "devicePath": "/dev/live"}]
        with self.assertRaises(update.Refusal): self.plan()
        self.assertEqual(self.kube.dry_runs + self.kube.writes, [])

    def test_selected_init_configuration_inputs_require_readonly_and_regular_storage_is_unchanged(self):
        for source in ["configMap", "secret", "projected"]:
            self.kube = GroupKube(); pod = self.kube.value["spec"]["template"]["spec"]
            pod["volumes"].append({"name": "configuration", source: {}})
            mount = {"name": "configuration", "mountPath": "/configuration", "readOnly": True}
            pod["initContainers"][0]["volumeMounts"].append(mount)
            self.plan(); mount["readOnly"] = False
            with self.subTest(source=source), self.assertRaises(update.Refusal): self.plan()
        self.kube = GroupKube(); self.release["updates"][0]["images"] = self.release["updates"][0]["images"][:1]
        self.kube.value["spec"]["template"]["spec"]["volumes"][0] = {"name": "pack", "persistentVolumeClaim": {"claimName": "live-data"}}
        plan = self.plan(); self.apply(plan)
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["volumes"][0]["persistentVolumeClaim"]["claimName"], "live-data")

    def test_late_json_test_failure_leaves_all_selected_images_unchanged(self):
        plan = self.plan(); patch = plan["updates"][0]["patch"]
        pod = self.kube.value["spec"]["template"]["spec"]
        pod["initContainers"][1]["image"] = PACK_NEW
        before = copy.deepcopy(self.kube.value)
        with self.assertRaises(update.Refusal): self.kube.patch(self.target["components"]["work"], patch, False)
        self.assertEqual(self.kube.value, before)
        self.assertEqual(self.kube.writes, [])

    def test_health_failure_preserves_committed_images_and_failure_phase(self):
        plan = self.plan()
        def failed_health(_):
            raise update.Refusal("Synthetic HTTPS failure")
        with self.assertRaises(update.ApplyFailure) as raised:
            update.apply_plan(self.target, plan, update.digest(plan), self.kube, health=failed_health)
        self.assertEqual(raised.exception.phase, "https-health:work")
        self.assertEqual(len(raised.exception.applied), 1)
        self.assertEqual(len(self.kube.writes), 1)
        self.assertEqual(self.kube.live_document["newWrites"], ["retained"])
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["containers"][0]["image"], NEW)

    def test_second_component_failure_keeps_atomic_first_update_and_durable_data(self):
        web = copy.deepcopy(self.target["components"]["work"])
        web.update(deployment="lolly-web", deploymentUID="web-uid", healthURLs=[])
        web["images"] = [{"kind": "container", "name": "server"}]
        self.target["components"]["public-web"] = web
        self.release["updates"].append({"component": "public-web", "images": [copy.deepcopy(self.release["updates"][0]["images"][0])]})
        self.kube.second = deployment(); self.kube.second["metadata"].update(name="lolly-web", uid="web-uid")
        plan = self.plan(); self.kube.fail_patch_for = "lolly-web"
        with self.assertRaises(update.ApplyFailure) as raised: self.apply(plan)
        failure = raised.exception
        self.assertEqual([value["component"] for value in failure.applied], ["work"])
        self.assertEqual([value["component"] for value in failure.attempted], ["work", "public-web"])
        self.assertEqual(failure.phase, "patch:public-web"); self.assertEqual(len(self.kube.writes), 1)
        self.assertEqual(self.kube.value["spec"]["template"]["spec"]["initContainers"][1]["image"], PACK_NEW)
        self.assertEqual(self.kube.second["spec"]["template"]["spec"]["containers"][0]["image"], OLD)
        self.assertEqual(self.kube.live_document["newWrites"], ["retained"])


if __name__ == "__main__":
    unittest.main()
