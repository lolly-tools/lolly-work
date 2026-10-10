#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Plan one matched private PVC cohort from reviewed local captures; never apply.

The portable v1 contract is documented in deploy/helm/APP-UPDATES.md and exercised
by tests/test_plan_private_cohort.py. Capture and qualification origins remain an
operator-reviewed trust boundary. This command installs nothing and has no
cluster, registry, build, signing, provisioning or apply operation.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("private_cohort", Path(__file__).with_name("prepare-private-cohort.py"))
cohort = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cohort)
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
STATUS = "PLANNED_FROM_CAPTURES_NOT_DRY_RUN_NOT_APPLIED"
SOURCE_KEYS = {"lolly.tools/engine-source", "lolly.tools/shell-source"}


def text(value, label):
    require(isinstance(value, str) and 0 < len(value) <= 253 and not any(ord(c) < 32 for c in value), "Invalid " + label)
    return value


def name(value):
    require(isinstance(value, str) and len(value) <= 63 and cohort.NAME.fullmatch(value), "Invalid resource name")
    return value


def positive(value):
    require(type(value) is int and value > 0, "Expected positive integer")


def release_id(value):
    require(isinstance(value, str) and re.fullmatch(r"release-[a-f0-9]{16}", value), "Invalid maintained shell release ID")


def identity(value, kind, namespace=None):
    require(isinstance(value, dict) and value.get("apiVersion") == "v1" and value.get("kind") == kind, "Wrong captured resource kind")
    metadata = value.get("metadata", {})
    name(metadata.get("name")); text(metadata.get("uid"), "resource UID"); text(metadata.get("resourceVersion"), "resource version")
    require(not metadata.get("deletionTimestamp") and metadata.get("namespace") == namespace, "Resource is deleting or in another namespace")
    return metadata


def mount_path(value):
    require(isinstance(value, str) and value.startswith("/") and "\\" not in value and not any(ord(c) < 32 for c in value)
            and all(p not in {"", ".", ".."} for p in value[1:].split("/")), "Invalid serving mount path")
    return value


def backing(pv):
    spec = pv.get("spec", {})
    kinds = [key for key in ("local", "csi", "hostPath") if key in spec]
    require(len(kinds) == 1, "PV needs a supported explicit backing identity")
    require(set(spec) <= {"capacity", "accessModes", "persistentVolumeReclaimPolicy", "storageClassName", "volumeMode", "claimRef", "nodeAffinity", "mountOptions", *kinds}, "Unknown PV backing or storage fields")
    kind = kinds[0]
    if kind == "csi":
        return kind, text(spec[kind].get("driver"), "CSI driver"), text(spec[kind].get("volumeHandle"), "CSI volume handle")
    path = spec[kind].get("path")
    mount_path(path)
    affinity = spec.get("nodeAffinity", {})
    exact(affinity, {"required"}); exact(affinity["required"], {"nodeSelectorTerms"})
    terms = affinity["required"]["nodeSelectorTerms"]
    require(isinstance(terms, list) and len(terms) == 1, "Local PV needs one explicit node scope")
    exact(terms[0], {"matchExpressions"})
    expressions = terms[0]["matchExpressions"]
    require(isinstance(expressions, list) and len(expressions) == 1, "Local PV needs one explicit node scope")
    expression = expressions[0]; exact(expression, {"key", "operator", "values"})
    require(expression["key"] == "kubernetes.io/hostname" and expression["operator"] == "In"
            and isinstance(expression["values"], list) and len(expression["values"]) == 1, "Local PV node scope is ambiguous")
    return "node-path", name(expression["values"][0]), path


def overlaps(left, right):
    if left[0] != right[0]:
        return False
    if left[0] == "csi":
        return left == right
    require(left[1] == right[1], "This local-storage planner requires one explicit shared node scope")
    a, b = left[2], right[2]
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def bound_claim(claim, volumes, namespace):
    metadata = identity(claim, "PersistentVolumeClaim", namespace)
    spec = claim.get("spec", {})
    require(claim.get("status", {}).get("phase") == "Bound" and spec.get("volumeMode", "Filesystem") == "Filesystem"
            and spec.get("accessModes") == ["ReadWriteOnce"], "Claim must be Bound single-owner filesystem storage")
    pv_name = name(spec.get("volumeName"))
    require(pv_name in volumes, "Missing captured backing PV")
    pv = volumes[pv_name]; identity(pv, "PersistentVolume")
    ps = pv.get("spec", {}); ref = ps.get("claimRef", {})
    require(pv.get("status", {}).get("phase") == "Bound" and ps.get("volumeMode", "Filesystem") == "Filesystem"
            and ps.get("accessModes") == ["ReadWriteOnce"] and ps.get("storageClassName") == spec.get("storageClassName")
            and ref.get("namespace") == namespace and ref.get("name") == metadata["name"] and ref.get("uid") == metadata["uid"], "PV does not bind this exact claim UID")
    backing(pv)
    return pv


def resource_guard(value):
    metadata = value["metadata"]
    result = {"kind": value["kind"], "namespace": metadata.get("namespace"), "name": metadata["name"],
              "uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}
    if "spec" in value:
        result["specSha256"] = cohort.digest(value["spec"])
    if value["kind"] == "ConfigMap":
        result["dataSha256"] = cohort.digest(value.get("data", {}))
        result["immutable"] = value.get("immutable") is True
    return result


def active_volumes(pod):
    volumes = pod.get("volumes", [])
    require(isinstance(volumes, list), "Invalid captured Pod volumes")
    for volume in volumes:
        require(isinstance(volume, dict) and len(set(volume) - {"name"}) == 1
                and set(volume) - {"name"} <= {"persistentVolumeClaim", "configMap", "secret", "emptyDir", "projected", "downwardAPI"},
                "Unreviewed active direct storage; only captured PVC backing is supported")
    return volumes


def plan(value, base):
    exact(value, {"version", "cohort", "previous", "deployment", "resources", "stage", "enginePin", "mounts"})
    require(type(value["version"]) is int and value["version"] == 1, "Unknown planning evidence version")
    inputs = cohort.Inputs(base)
    prepared, previous, before, facts, staged, pin = [inputs.file(value[key]) for key in ("cohort", "previous", "deployment", "resources", "stage", "enginePin")]
    exact(prepared, {"version", "status", "sources", "normalCI", "image", "profile", "enginePinSha256", "resolverPinSha256", "shell", "rawPack", "catalog",
                     "previousCohortSha256", "beforeSpecSha256", "desiredSpecSha256", "desiredSpec", "guardedPatchTemplate", "inverseTupleTemplate",
                     "allUnselectedSpecFieldsPreserved", "evidence", "qualificationBoundary", "requiredBeforeApply"})
    require(prepared.get("version") == 1 and type(prepared["version"]) is int and prepared.get("status") == cohort.STATUS, "Not a maintained offline prepared cohort")
    exact(prepared["sources"], {"lolly", "work", "brand"})
    for source in prepared["sources"].values():
        cohort.commit(source)
    exact(prepared["normalCI"], {"lolly", "work"})
    for ci in prepared["normalCI"].values():
        exact(ci, {"run", "attempt"}); positive(ci["run"]); positive(ci["attempt"])
    name(prepared["profile"])
    require(prepared["profile"] not in {"community", "neutral", "public"}, "Private profile is missing")
    cohort.sha(prepared["resolverPinSha256"])
    release_id(prepared["shell"]["releaseId"])
    require(prepared.get("allUnselectedSpecFieldsPreserved") is True and prepared.get("qualificationBoundary") == {
        "localReviewedEvidence": True, "originAuthenticatedByThisCommand": False, "ociSignatureClaimed": False,
        "privateShellSignatureClaimed": False, "runtimeQualified": False, "productionMutation": False, "buildOrSigningPerformed": False}, "Unknown or falsely qualified preparation boundary")
    require(value["previous"]["sha256"] == prepared["previousCohortSha256"] and value["enginePin"]["sha256"] == prepared["enginePinSha256"], "Previous cohort or engine pin custody differs")
    original = inputs.file(previous["deployment"])
    require(before.get("apiVersion") == "apps/v1" and before.get("kind") == "Deployment" and before.get("spec") == original.get("spec")
            and cohort.digest(before["spec"]) == prepared["beforeSpecSha256"] == previous["deploymentSpecSha256"], "Current captured Deployment differs from prepared before-spec")
    metadata = before.get("metadata", {})
    namespace, deployment = name(metadata.get("namespace")), name(metadata.get("name"))
    text(metadata.get("uid"), "Deployment UID"); text(metadata.get("resourceVersion"), "Deployment resource version")
    require(not metadata.get("deletionTimestamp") and all(metadata.get(k) == original.get("metadata", {}).get(k) for k in ("namespace", "name", "uid")), "Deployment identity changed")
    require(pin.get("generatedFrom") == prepared["sources"]["lolly"], "Engine source differs from matched shell")
    for family in ("engine", "core"):
        require(isinstance(pin.get(family), dict) and isinstance(pin[family].get("version"), str)
                and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", pin[family]["version"]), "Missing pinned engine/core version")
        cohort.sha(pin[family].get("contentHash"))
    require(isinstance(pin.get("schemas"), dict) and pin["schemas"], "Missing schema pins")
    for schema, checksum in pin["schemas"].items():
        cohort.safe_path(schema); cohort.sha(checksum)
    exact(value["mounts"], {"container", "shellVolume", "packVolume", "pinVolume", "shellPath", "packPath", "pinPath", "pinKey"})
    selection = {key: name(value["mounts"][key]) for key in ("container", "shellVolume", "packVolume", "pinVolume")}
    pin_key = cohort.safe_path(value["mounts"]["pinKey"])
    require("/" not in pin_key, "Pin key must be a single ConfigMap key")
    current_pod = before["spec"].get("template", {}).get("spec", {})
    desired_pod = prepared.get("desiredSpec", {}).get("template", {}).get("spec", {})
    for family, volume_key, source_kind, leaf in (("shell", "shellVolume", "persistentVolumeClaim", "claimName"), ("pack", "packVolume", "persistentVolumeClaim", "claimName"), ("pin", "pinVolume", "configMap", "name")):
        selected = [v for v in desired_pod.get("volumes", []) if v.get("name") == selection[volume_key]]
        require(len(selected) == 1 and isinstance(selected[0].get(source_kind), dict), "Incomplete prepared matched tuple")
        selection[{"shell": "shellClaim", "pack": "packClaim", "pin": "pinConfigMap"}[family]] = name(selected[0][source_kind].get(leaf))
    selection["provenance"] = {key: prepared["sources"]["lolly"] for key in SOURCE_KEYS}
    expected, patch, inverse = cohort.change_tuple(before, previous, selection, prepared["image"], prepared["sources"]["lolly"])
    cohort.paired.updater.image_ref(prepared["image"])
    require(expected == prepared["desiredSpec"] and cohort.digest(expected) == prepared["desiredSpecSha256"], "Prepared desired-spec has partial or unselected changes")
    # The offline preparer keeps this optional release annotation unchanged.
    # Bind its existing value to the accepted previous release before planning
    # this one extra source-derived leaf. Never add an absent annotation.
    annotations = expected["template"].get("metadata", {}).get("annotations", {})
    release_key = "lolly.tools/shell-release"
    if release_key in annotations:
        release_id(prepared["shell"]["releaseId"]); release_id(previous["shell"]["releaseId"])
        require(annotations[release_key] == previous["shell"]["releaseId"], "Existing shell release provenance differs")
        path = "/spec/template/metadata/annotations/lolly.tools~1shell-release"
        patch += [{"op": "test", "path": path, "value": annotations[release_key]},
                  {"op": "replace", "path": path, "value": prepared["shell"]["releaseId"]}]
        inverse["fields"].append({"path": path, "expectedValue": prepared["shell"]["releaseId"], "restoreValue": annotations[release_key]})
        annotations[release_key] = prepared["shell"]["releaseId"]
    server = next(c for c in current_pod["containers"] if c["name"] == selection["container"])
    paths = []
    for family in ("shell", "pack", "pin"):
        path = mount_path(value["mounts"][family + "Path"]); paths.append(path)
        mount = [m for m in server.get("volumeMounts", []) if m.get("name") == selection[family + "Volume"]]
        require(len(mount) == 1 and mount[0].get("mountPath") == path and mount[0].get("readOnly") is True and "subPathExpr" not in mount[0]
                and (mount[0].get("subPath") == pin_key if family == "pin" else "subPath" not in mount[0]), "Wrong serving content mount")
    require(len(set(paths)) == 3 and not any(a.startswith(b + "/") for a in paths for b in paths if a != b), "Content mount paths overlap")
    exact(facts, {"version", "namespace", "resources", "pods"})
    require(type(facts["version"]) is int and facts["version"] == 1, "Unknown resource facts")
    ns = identity(facts["namespace"], "Namespace")
    require(ns["name"] == namespace, "Captured namespace differs")
    require(isinstance(facts["resources"], list) and 1 <= len(facts["resources"]) <= 1000, "Missing or excessive captured resources")
    claims, pvs, maps, keys, uids = {}, {}, {}, set(), set()
    for resource in facts["resources"]:
        kind = resource.get("kind")
        require(kind in {"PersistentVolumeClaim", "PersistentVolume", "ConfigMap"}, "Unsupported or secret resource in facts")
        meta = identity(resource, kind, None if kind == "PersistentVolume" else namespace)
        key = kind, meta["name"]
        require(key not in keys and meta["uid"] not in uids, "Duplicate resource identity")
        keys.add(key); uids.add(meta["uid"])
        {"PersistentVolumeClaim": claims, "PersistentVolume": pvs, "ConfigMap": maps}[kind][meta["name"]] = resource
    pod_list = facts["pods"]
    require(isinstance(pod_list, dict) and pod_list.get("apiVersion") == "v1" and pod_list.get("kind") == "PodList"
            and not pod_list.get("metadata", {}).get("continue") and isinstance(pod_list.get("items"), list) and len(pod_list["items"]) <= 10000, "Needs a complete captured namespace PodList")
    text(pod_list.get("metadata", {}).get("resourceVersion"), "PodList resource version")
    candidate_claims = {selection["shellClaim"], selection["packClaim"]}
    active_claims = {v["persistentVolumeClaim"]["claimName"] for v in active_volumes(current_pod) if "persistentVolumeClaim" in v}
    active_maps = {v["configMap"]["name"] for v in active_volumes(current_pod) if "configMap" in v}
    pod_uids = set()
    for pod in pod_list["items"]:
        meta = identity(pod, "Pod", namespace)
        require(meta["uid"] not in pod_uids, "Duplicate captured Pod UID"); pod_uids.add(meta["uid"])
        for volume in active_volumes(pod.get("spec", {})):
            if "persistentVolumeClaim" in volume:
                active_claims.add(volume["persistentVolumeClaim"]["claimName"])
            if "configMap" in volume:
                active_maps.add(volume["configMap"]["name"])
    require(not candidate_claims & active_claims and selection["pinConfigMap"] not in active_maps, "Candidate is still mounted or reuses an active claim/pin")
    require(active_claims <= claims.keys() and candidate_claims <= claims.keys(), "Missing an active or candidate claim capture")
    active_pvs = [bound_claim(claims[n], pvs, namespace) for n in sorted(active_claims)]
    candidates = [bound_claim(claims[n], pvs, namespace) for n in sorted(candidate_claims)]
    require(len({p["metadata"]["uid"] for p in candidates}) == 2 and len({backing(p) for p in candidates}) == 2
            and not {p["metadata"]["name"] for p in candidates} & {p["metadata"]["name"] for p in active_pvs}
            and not {p["metadata"]["uid"] for p in candidates} & {p["metadata"]["uid"] for p in active_pvs}
            and not any(overlaps(backing(a), backing(b)) for i, a in enumerate(candidates) for b in candidates[i + 1:] + active_pvs), "Candidate PV aliases active or other candidate storage")
    local_nodes = {backing(p)[1] for p in [*active_pvs, *candidates] if backing(p)[0] == "node-path"}
    require(len(local_nodes) <= 1, "This planner requires one explicit local storage node scope")
    for pod in pod_list["items"]:
        for volume in pod.get("spec", {}).get("volumes", []):
            if "persistentVolumeClaim" in volume:
                b = backing(bound_claim(claims[volume["persistentVolumeClaim"]["claimName"]], pvs, namespace))
                require(b[0] != "node-path" or pod["spec"].get("nodeName") == b[1], "Captured Pod uses a different local storage node")
    for family in ("shell", "pack"):
        require(claims[previous[family]["name"]]["metadata"]["uid"] == previous[family]["uid"], "Previous claim UID differs")
    for selected, checksum in ((previous["pin"]["name"], previous["pin"]["sha256"]), (selection["pinConfigMap"], prepared["enginePinSha256"])):
        require(selected in maps and maps[selected].get("immutable") is True and not maps[selected].get("binaryData")
                and set(maps[selected].get("data", {})) == {pin_key}, "Pin ConfigMap must be immutable and contain only the selected key")
        data = maps[selected]["data"][pin_key]
        require(isinstance(data, str) and hashlib.sha256(data.encode()).hexdigest() == checksum, "Pin ConfigMap bytes differ")
    require(maps[previous["pin"]["name"]]["metadata"]["uid"] == previous["pin"]["uid"], "Previous pin UID differs")
    exact(staged, {"version", "status", "sources", "image", "enginePinSha256", "engineVersion", "coreVersion", "shell", "rawPack", "catalog", "pod", "mounts", "retirement", "originalEvidence"})
    require(type(staged["version"]) is int and staged["version"] == 1 and staged["status"] == "ISOLATED_COHORT_ACCEPTED_AND_RETIRED"
            and staged["sources"] == prepared["sources"] and staged["image"] == prepared["image"] and staged["enginePinSha256"] == prepared["enginePinSha256"]
            and staged["engineVersion"] == pin["engine"]["version"] and staged["coreVersion"] == pin["core"]["version"]
            and staged["catalog"] == prepared["catalog"], "Stage does not qualify the matched image/engine/source/catalog")
    for family, key, resource_name in (("shell", "shell", selection["shellClaim"]), ("pack", "rawPack", selection["packClaim"])):
        exact(staged[key], set(prepared[key]) | {"claim", "claimUID"})
        require(all(staged[key][k] == v for k, v in prepared[key].items()) and staged[key]["claim"] == resource_name
                and staged[key]["claimUID"] == claims[resource_name]["metadata"]["uid"], "Stage content/claim custody differs")
        positive(prepared[key]["files"]); cohort.sha(prepared[key]["manifestSha256"])
    stage_meta = identity(staged["pod"], "Pod", namespace)
    require(stage_meta["uid"] not in pod_uids, "Stage Pod is not absent from captured namespace")
    stage_spec = staged["pod"].get("spec", {})
    require(stage_spec.get("automountServiceAccountToken") is False and not any(stage_spec.get(k) for k in ("hostNetwork", "hostPID", "hostIPC", "initContainers", "ephemeralContainers")), "Stage used host privileges or extra processes")
    require(stage_spec.get("enableServiceLinks") is False and not stage_spec.get("imagePullSecrets"), "Stage inherited service credentials or image pull secrets")
    require(len(stage_spec.get("containers", [])) == 1 and stage_spec["containers"][0].get("image") == prepared["image"]
            and stage_spec["containers"][0].get("imagePullPolicy") == "Never"
            and not any(stage_spec["containers"][0].get(k) for k in ("env", "envFrom", "volumeDevices")), "Stage used wrong image or external credentials")
    security = stage_spec["containers"][0].get("securityContext", {})
    require(security.get("runAsNonRoot") is True and type(security.get("runAsUser")) is int and security["runAsUser"] > 0
            and security.get("allowPrivilegeEscalation") is False and security.get("privileged", False) is False
            and security.get("readOnlyRootFilesystem") is True and security.get("capabilities") == {"drop": ["ALL"]}
            and security.get("seccompProfile") == {"type": "RuntimeDefault"}, "Stage container security is not the reviewed unprivileged form")
    require(set(security) <= {"runAsNonRoot", "runAsUser", "runAsGroup", "allowPrivilegeEscalation", "privileged", "readOnlyRootFilesystem", "capabilities", "seccompProfile"}
            and ("runAsGroup" not in security or type(security["runAsGroup"]) is int and security["runAsGroup"] > 0), "Unknown stage container security")
    pod_security = stage_spec.get("securityContext", {})
    require(set(pod_security) <= {"runAsNonRoot", "runAsUser", "runAsGroup", "fsGroup", "fsGroupChangePolicy", "seccompProfile"}
            and pod_security.get("runAsNonRoot", True) is True and pod_security.get("runAsUser", security["runAsUser"]) == security["runAsUser"]
            and pod_security.get("seccompProfile", {"type": "RuntimeDefault"}) == {"type": "RuntimeDefault"}, "Unknown or conflicting stage Pod security")
    for key in ("runAsGroup", "fsGroup"):
        require(key not in pod_security or type(pod_security[key]) is int and pod_security[key] > 0, "Stage used a root group")
    require(not local_nodes or stage_spec.get("nodeName") in local_nodes, "Stage used a different local storage node")
    seen = set()
    stage_volumes = stage_spec.get("volumes", [])
    require(isinstance(stage_volumes, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in stage_volumes)
            and len({v["name"] for v in stage_volumes}) == len(stage_volumes), "Duplicate or invalid stage volumes")
    stage_mounts = stage_spec["containers"][0].get("volumeMounts", [])
    require(isinstance(stage_mounts, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in stage_mounts)
            and len({v["name"] for v in stage_mounts}) == len(stage_mounts), "Duplicate or invalid stage mounts")
    exact(staged["mounts"], {"shellPath", "packPath", "pinPath"})
    stage_paths = [mount_path(staged["mounts"][k]) for k in ("shellPath", "packPath", "pinPath")]
    require(len(set(stage_paths)) == 3 and not any(a.startswith(b + "/") for a in stage_paths for b in stage_paths if a != b), "Stage content paths overlap")
    for source_kind, leaf, selected, path, subpath in (
            ("persistentVolumeClaim", "claimName", selection["shellClaim"], staged["mounts"]["shellPath"], None),
            ("persistentVolumeClaim", "claimName", selection["packClaim"], staged["mounts"]["packPath"], None),
            ("configMap", "name", selection["pinConfigMap"], staged["mounts"]["pinPath"], pin_key)):
        volumes = [v for v in stage_volumes if v.get(source_kind, {}).get(leaf) == selected]
        require(len(volumes) == 1 and set(volumes[0]) == {"name", source_kind}, "Stage matched tuple is missing or ambiguous")
        mounts = [mt for mt in stage_mounts if mt["name"] == volumes[0]["name"]]
        require(len(mounts) == 1 and mounts[0].get("mountPath") == path and "subPathExpr" not in mounts[0]
                and (mounts[0].get("subPath") == subpath if subpath is not None else "subPath" not in mounts[0]), "Stage did not consume its reviewed mounted tuple")
    for volume in stage_volumes:
        if "persistentVolumeClaim" in volume:
            require(set(volume) == {"name", "persistentVolumeClaim"} and volume["persistentVolumeClaim"].get("claimName") in candidate_claims
                    and sum(m["name"] == volume["name"] for m in stage_mounts) == 1, "Stage mounted a non-candidate PVC or did not mount its content")
            seen.add(volume["persistentVolumeClaim"]["claimName"])
        else:
            require(set(volume) == {"name", "emptyDir"} or (set(volume) == {"name", "configMap"} and volume["configMap"].get("name") == selection["pinConfigMap"]), "Stage had an unsafe volume")
    require(seen == candidate_claims, "Stage did not mount both candidate claims")
    require(all(m["name"] in {v["name"] for v in stage_volumes} and isinstance(m.get("mountPath"), str) for m in stage_mounts), "Stage mount references an unknown volume")
    exact(staged["retirement"], {"podUID", "policyUID", "podAbsent", "policyAbsent", "mountsReleased"})
    require(staged["retirement"]["podUID"] == stage_meta["uid"] and all(staged["retirement"][key] is True for key in ("podAbsent", "policyAbsent", "mountsReleased")), "Stage retirement or unmount proof is missing")
    text(staged["retirement"]["policyUID"], "retired policy UID")
    require(isinstance(staged["originalEvidence"], list) and 3 <= len(staged["originalEvidence"]) <= 16, "Missing original runtime/content/retirement evidence")
    for ref in staged["originalEvidence"]:
        inputs.file(ref, False)
    inputs.unchanged()
    resources = [claims[n] for n in sorted(active_claims | candidate_claims)] + [*active_pvs, *candidates, maps[previous["pin"]["name"]], maps[selection["pinConfigMap"]]]
    guards = {(r["kind"], r["metadata"]["name"]): resource_guard(r) for r in resources}
    return {"version": 1, "status": STATUS, "sources": prepared["sources"], "sourceCohortSha256": value["cohort"]["sha256"],
            "namespace": namespace, "namespaceUID": ns["uid"], "deployment": deployment, "deploymentUID": metadata["uid"], "resourceVersion": metadata["resourceVersion"],
            "beforeSpecSha256": cohort.digest(before["spec"]), "cohortDesiredSpecSha256": prepared["desiredSpecSha256"], "desiredSpecSha256": cohort.digest(expected), "desiredSpec": expected, "guardedPatch": patch,
            "selection": selection, "resourceGuards": [guards[k] for k in sorted(guards)], "podInventoryResourceVersion": pod_list["metadata"]["resourceVersion"],
            "inverseTupleReference": inverse, "allUnselectedSpecFieldsPreserved": True,
            "evidence": [{"path": str(p), "sha256": h} for p, (_, h) in sorted(inputs.reads.items())],
            "qualificationBoundary": {"capturesAndReportsLocallyBound": True, "originAuthenticatedByThisCommand": False, "liveResourcesChecked": False,
                                      "serverDryRunPerformed": False, "runtimeQualifiedByThisCommand": False, "productionMutation": False},
            "requiredBeforeApply": ["Fresh cluster/target preflight and every captured resource UID/RV/spec/data readback", "Fresh complete Pod inventory, isolated candidate PV backing and fenced candidate writers",
                                    "Reviewed server dry run; prove admission preserves every unselected field", "Atomic full-spec/UID/RV tested patch under serialized ownership",
                                    "Owning-runtime/catalog/TLS/export/agent/reconnect acceptance and data-preserving rollback review"]}, inputs


def publish(value, out, inputs):
    # Follow the preparer's protected/exclusive publication protocol, including
    # final input checks before the distinctly named complete output exists.
    require(out.is_absolute() and not out.exists() and not out.is_symlink() and out.parent.resolve(strict=True) == out.parent, "Output must be a new canonical directory")
    for path in inputs.reads:
        require(out != path and out not in path.parents and path not in out.parents, "Output overlaps input custody")
    parent = cohort.stamp(out.parent.lstat())
    require(stat.S_ISDIR(out.parent.lstat().st_mode) and not out.parent.lstat().st_mode & 0o022, "Output parent is writable by others")
    inputs.unchanged(); require(cohort.stamp(out.parent.lstat()) == parent, "Output parent changed")
    os.mkdir(out, 0o700); ownership = cohort.stamp(out.lstat())[:2]
    try:
        data = cohort.canonical(value) + b"\n"
        require(len(data) <= cohort.JSON_LIMIT * 2, "Plan output is too large")
        path, partial = out / "private-cohort.plan.json", out / ".plan.partial"
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        inputs.unchanged()
        require(cohort.stamp(out.lstat())[:2] == ownership and cohort.read_file(partial, cohort.JSON_LIMIT * 2)[0] == data, "Plan output custody changed")
        os.link(partial, path, follow_symlinks=False); partial.unlink()
        directory_fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return hashlib.sha256(data).hexdigest()
    except Exception:
        raise Refusal("Planning failed after exclusive output creation; retain partial output before retry") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--reviewed-evidence-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    path = cohort.local_path(args.evidence, Path.cwd())
    data, stamp = cohort.read_file(path)
    require(hashlib.sha256(data).hexdigest() == cohort.sha(args.reviewed_evidence_sha256), "Planning evidence differs from review")
    result, inputs = plan(cohort.parse_json(data), path.parent)
    inputs.reads[path] = (stamp, args.reviewed_evidence_sha256)
    checksum = publish(result, Path(os.path.abspath(args.out_dir)), inputs)
    print(json.dumps({"status": STATUS, "planPath": str(Path(args.out_dir) / "private-cohort.plan.json"), "planSha256": checksum,
                      "canonicalPlanSha256": cohort.digest(result), "productionMutation": False}))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError, StopIteration):
        print("REFUSED: private cohort captures or reviewed planning contract differ; retain any partial output", file=sys.stderr)
        raise SystemExit(1)
