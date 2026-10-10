#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Plan a compatible shell-only update from reviewed complete local captures.

No API, image build, signing, server dry run or apply operation is provided.
The accepted image, raw pack, engine/resolver pins and engine annotation remain
byte/UID exact. A retired stage may mount only the new shell PVC and a new
temporary staging-only PVC copy of the pack; never an active serving PVC.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("private_shell", Path(__file__).with_name("prepare-private-shell.py"))
shell = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(shell)
_spec = importlib.util.spec_from_file_location("private_plan", Path(__file__).with_name("plan-private-cohort.py"))
resources = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(resources)
cohort = shell.cohort
require, exact, Refusal = shell.require, shell.exact, shell.Refusal
STATUS = "PLANNED_FROM_CAPTURES_NOT_DRY_RUN_NOT_APPLIED"


def cli_evidence(prepared, inputs):
    checksum = cohort.sha(prepared["reviewedEvidenceSha256"])
    refs = prepared["evidence"]
    require(isinstance(refs, list) and 1 <= len(refs) <= cohort.MAX_FILES, "Missing prepared evidence")
    paths, matching = set(), []
    for ref in refs:
        exact(ref, {"path", "sha256"}); cohort.sha(ref["sha256"])
        require(isinstance(ref["path"], str) and ref["path"] not in paths, "Duplicate prepared evidence")
        paths.add(ref["path"])
        if ref["sha256"] == checksum:
            matching.append(ref)
    require(len(matching) == 1, "Preparation must bind its unique original CLI envelope")
    original = inputs.file(matching[0]); exact(original, shell.EVIDENCE_KEYS)
    require(type(original["version"]) is int and original["version"] == 1, "Unknown CLI custody")
    for family in ("lolly", "work"):
        exact(original[family], {"root", "source", "repository", "main", "ciRun", "ciJobs"})
        require(original[family]["source"] == prepared["sources"][family], "Original qualified source differs")
    exact(original["brand"], {"path", "commit"})
    require(original["brand"]["commit"] == prepared["sources"]["brand"] and original["profile"] == prepared["profile"] and original["selection"] == prepared["selection"], "Original profile, brand or selection differs")
    for key, field in (("enginePin", "enginePinSha256"), ("resolverPin", "resolverPinSha256"), ("previous", "previousCohortSha256")):
        exact(original[key], {"path", "sha256"}); require(original[key]["sha256"] == prepared[field], "Original pin/previous custody differs")
    for family in ("shell", "rawPack"):
        exact(original[family], {"root", "manifest"}); exact(original[family]["manifest"], {"path", "sha256"})
        require(original[family]["manifest"]["sha256"] == prepared[family]["manifestSha256"], "Original content custody differs")
    # Every original custody reference must still have the byte identity the
    # preparer reviewed. Trees are not rehashed here; retired stage full-hash
    # evidence and final owning-runtime acceptance cover their next boundary.
    for ref in refs:
        inputs.file(ref, False)
    return original


def stage_security(pod, image):
    spec = pod.get("spec", {})
    require(spec.get("automountServiceAccountToken") is False and spec.get("enableServiceLinks") is False
            and not any(spec.get(k) for k in ("hostNetwork", "hostPID", "hostIPC", "initContainers", "ephemeralContainers", "imagePullSecrets")), "Stage inherited host privileges or credentials")
    containers = spec.get("containers", [])
    require(isinstance(containers, list) and len(containers) == 1 and containers[0].get("image") == image and containers[0].get("imagePullPolicy") == "Never"
            and not any(containers[0].get(k) for k in ("env", "envFrom", "volumeDevices")), "Stage must use exact imported image without external credentials")
    c = containers[0]; security = c.get("securityContext", {})
    require(security.get("runAsNonRoot") is True and type(security.get("runAsUser")) is int and security["runAsUser"] > 0 and security.get("allowPrivilegeEscalation") is False
            and security.get("privileged", False) is False and security.get("readOnlyRootFilesystem") is True and security.get("capabilities") == {"drop": ["ALL"]}
            and security.get("seccompProfile") == {"type": "RuntimeDefault"}, "Unprivileged stage security required")
    require(set(security) <= {"runAsNonRoot", "runAsUser", "runAsGroup", "allowPrivilegeEscalation", "privileged", "readOnlyRootFilesystem", "capabilities", "seccompProfile"}
            and ("runAsGroup" not in security or type(security["runAsGroup"]) is int and security["runAsGroup"] > 0), "Unknown container security")
    ps = spec.get("securityContext", {})
    require(set(ps) <= {"runAsNonRoot", "runAsUser", "runAsGroup", "fsGroup", "fsGroupChangePolicy", "seccompProfile"} and ps.get("runAsNonRoot", True) is True
            and ps.get("runAsUser", security["runAsUser"]) == security["runAsUser"] and ps.get("seccompProfile", {"type": "RuntimeDefault"}) == {"type": "RuntimeDefault"}, "Unknown Pod security")
    for key in ("runAsGroup", "fsGroup"):
        require(key not in ps or type(ps[key]) is int and ps[key] > 0, "Stage cannot use root group")
    return spec, c


def plan(value, base):
    exact(value, {"version", "prepared", "previous", "deployment", "resources", "stage", "enginePin", "mounts"})
    require(type(value["version"]) is int and value["version"] == 1, "Unknown shell planning evidence")
    inputs = cohort.Inputs(base)
    prepared, before, facts, staged, pin = [inputs.file(value[k]) for k in ("prepared", "deployment", "resources", "stage", "enginePin")]
    exact(prepared, shell.PREPARED_KEYS | {"reviewedEvidenceSha256"})
    require(type(prepared["version"]) is int and prepared["version"] == 1 and prepared["status"] == shell.STATUS and prepared["qualificationBoundary"] == shell.BOUNDARY
            and prepared["allUnselectedSpecFieldsPreserved"] is True, "Not a maintained unqualified shell preparation")
    exact(prepared["sources"], {"lolly", "engine", "work", "brand"})
    for source in prepared["sources"].values():
        cohort.commit(source)
    exact(prepared["normalCI"], {"lolly", "work"})
    for ci in prepared["normalCI"].values():
        exact(ci, {"run", "attempt"}); resources.positive(ci["run"]); resources.positive(ci["attempt"])
    resources.name(prepared["profile"]); require(prepared["profile"] not in {"community", "neutral", "public"}, "Private profile missing")
    original_cli = cli_evidence(prepared, inputs)
    previous, accepted = shell.previous_record(value["previous"], inputs)
    require(value["previous"]["sha256"] == prepared["previousCohortSha256"] and value["enginePin"]["sha256"] == prepared["enginePinSha256"] == previous["pin"]["sha256"]
            and prepared["resolverPinSha256"] == previous["resolverPin"]["sha256"] and prepared["sources"]["engine"] == previous["engineSource"] and prepared["sources"]["work"] == previous["workSource"]
            and prepared["image"] == previous["image"] and prepared["rawPack"]["manifestSha256"] == previous["pack"]["manifestSha256"], "Accepted engine/image/pack/pin must stay unchanged")
    require(before.get("apiVersion") == "apps/v1" and before.get("kind") == "Deployment" and before.get("spec") == accepted["spec"]
            and cohort.digest(before["spec"]) == prepared["beforeSpecSha256"] == previous["deploymentSpecSha256"], "Current complete spec differs from accepted/prepared spec")
    metadata = before.get("metadata", {}); namespace = resources.name(metadata.get("namespace")); deployment = resources.name(metadata.get("name"))
    resources.text(metadata.get("uid"), "Deployment UID"); resources.text(metadata.get("resourceVersion"), "Deployment resource version")
    require(not metadata.get("deletionTimestamp") and all(metadata.get(k) == accepted["metadata"][k] for k in ("namespace", "name", "uid")), "Deployment identity changed")
    require(pin.get("generatedFrom") == prepared["sources"]["engine"], "Accepted engine pin source differs")
    for family in ("engine", "core"):
        require(isinstance(pin.get(family), dict) and isinstance(pin[family].get("version"), str), "Missing accepted engine/core")
        cohort.sha(pin[family].get("contentHash"))
    require(isinstance(pin.get("schemas"), dict) and pin["schemas"], "Missing schema ABI")
    for key, checksum in pin["schemas"].items():
        cohort.safe_path(key); cohort.sha(checksum)
    exact(value["mounts"], {"container", "shellVolume", "packVolume", "pinVolume", "shellPath", "packPath", "pinPath", "pinKey"})
    selection = prepared["selection"]
    require(all(value["mounts"][key] == selection[key] for key in ("container", "shellVolume", "packVolume", "pinVolume")), "Selected serving mounts differ")
    desired, patch, rollback = shell.change_tuple(before, previous, selection, prepared["sources"]["lolly"], prepared["shell"]["releaseId"])
    require(desired == prepared["desiredSpec"] and cohort.digest(desired) == prepared["desiredSpecSha256"] and prepared["rollbackIntent"] == rollback, "Prepared desired spec changes unselected fields")
    pin_key = cohort.safe_path(value["mounts"]["pinKey"]); require("/" not in pin_key, "Pin ConfigMap key must be a single key")
    server = next(c for c in before["spec"]["template"]["spec"]["containers"] if c["name"] == selection["container"])
    paths = []
    for family in ("shell", "pack", "pin"):
        path = resources.mount_path(value["mounts"][family + "Path"]); paths.append(path)
        mts = [m for m in server.get("volumeMounts", []) if m.get("name") == selection[family + "Volume"]]
        require(len(mts) == 1 and mts[0].get("mountPath") == path and mts[0].get("readOnly") is True and "subPathExpr" not in mts[0]
                and (mts[0].get("subPath") == pin_key if family == "pin" else "subPath" not in mts[0]), "Serving content mount differs")
    require(len(set(paths)) == 3 and not any(a.startswith(b + "/") for a in paths for b in paths if a != b), "Serving mount paths overlap")
    exact(facts, {"version", "namespace", "resources", "pods"}); require(type(facts["version"]) is int and facts["version"] == 1, "Unknown facts")
    ns = resources.identity(facts["namespace"], "Namespace"); require(ns["name"] == namespace, "Namespace differs")
    require(isinstance(facts["resources"], list) and 1 <= len(facts["resources"]) <= 1000, "Missing complete resources")
    claims, pvs, maps, keys, uids = {}, {}, {}, set(), set()
    for resource in facts["resources"]:
        kind = resource.get("kind"); require(kind in {"PersistentVolumeClaim", "PersistentVolume", "ConfigMap"}, "Unknown or secret fact resource")
        meta = resources.identity(resource, kind, None if kind == "PersistentVolume" else namespace); key = kind, meta["name"]
        require(key not in keys and meta["uid"] not in uids, "Duplicate resource identity")
        keys.add(key); uids.add(meta["uid"]); {"PersistentVolumeClaim": claims, "PersistentVolume": pvs, "ConfigMap": maps}[kind][meta["name"]] = resource
    pods = facts["pods"]
    require(isinstance(pods, dict) and pods.get("apiVersion") == "v1" and pods.get("kind") == "PodList" and not pods.get("metadata", {}).get("continue")
            and isinstance(pods.get("items"), list) and len(pods["items"]) <= 10000, "Complete namespace PodList required")
    resources.text(pods.get("metadata", {}).get("resourceVersion"), "PodList resource version")
    active_claims = {v["persistentVolumeClaim"]["claimName"] for v in resources.active_volumes(before["spec"]["template"]["spec"]) if "persistentVolumeClaim" in v}
    pod_uids, accepted_content_owners = set(), set()
    for pod in pods["items"]:
        meta = resources.identity(pod, "Pod", namespace); require(meta["uid"] not in pod_uids, "Duplicate Pod UID"); pod_uids.add(meta["uid"])
        for volume in resources.active_volumes(pod.get("spec", {})):
            if "persistentVolumeClaim" in volume:
                active_claims.add(volume["persistentVolumeClaim"]["claimName"])
                if volume["persistentVolumeClaim"]["claimName"] in {previous["shell"]["name"], previous["pack"]["name"]}:
                    accepted_content_owners.add(meta["uid"])
    acceptance_wrapper = inputs.file(previous["acceptance"])
    accepted_original = inputs.file(acceptance_wrapper["originalEvidence"][0])
    require(accepted_content_owners == {accepted_original["podUid"]}, "Accepted shell/pack has another owner or its actual owner is absent")
    candidate = resources.name(selection["shellClaim"])
    require(isinstance(staged.get("rawPack"), dict) and staged["rawPack"].get("storage") == "ISOLATED_STAGING_PVC_COPY", "Stage pack must use new temporary isolated copied storage")
    temporary_pack = resources.name(staged["rawPack"].get("claim"))
    candidates = {candidate, temporary_pack}
    require(len(candidates) == 2 and not candidates & active_claims and active_claims | candidates <= claims.keys(), "New stage claim is active or lacks complete captures")
    # Protect dormant retained/rollback claims too: a new PV must not alias any
    # captured claim's backing, even when no Pod currently mounts that claim.
    active_pvs = [resources.bound_claim(claims[n], pvs, namespace) for n in sorted(set(claims) - candidates)]
    new_pv = resources.bound_claim(claims[candidate], pvs, namespace)
    pack_pv = resources.bound_claim(claims[temporary_pack], pvs, namespace)
    require(all(a["metadata"][k] != p["metadata"][k] for a in (new_pv, pack_pv) for p in active_pvs for k in ("name", "uid"))
            and new_pv["metadata"]["uid"] != pack_pv["metadata"]["uid"] and not any(resources.overlaps(resources.backing(a), resources.backing(p)) for a in (new_pv, pack_pv) for p in active_pvs)
            and not resources.overlaps(resources.backing(new_pv), resources.backing(pack_pv)), "New stage PV aliases active/dormant/other candidate storage")
    local_nodes = {resources.backing(p)[1] for p in [*active_pvs, new_pv, pack_pv] if resources.backing(p)[0] == "node-path"}; require(len(local_nodes) <= 1, "Local storage node scope differs")
    for pod in pods["items"]:
        for volume in pod.get("spec", {}).get("volumes", []):
            if "persistentVolumeClaim" in volume:
                b = resources.backing(resources.bound_claim(claims[volume["persistentVolumeClaim"]["claimName"]], pvs, namespace))
                require(b[0] != "node-path" or pod["spec"].get("nodeName") == b[1], "Pod mounts another local storage node")
    for family in ("shell", "pack"):
        require(claims[previous[family]["name"]]["metadata"]["uid"] == previous[family]["uid"], "Retained accepted claim UID differs")
    pin_map = maps.get(previous["pin"]["name"], {})
    require(pin_map.get("metadata", {}).get("uid") == previous["pin"]["uid"] and pin_map.get("immutable") is True and not pin_map.get("binaryData") and set(pin_map.get("data", {})) == {pin_key}, "Retained immutable pin resource differs")
    pin_data = pin_map["data"][pin_key]
    require(isinstance(pin_data, str) and hashlib.sha256(pin_data.encode()).hexdigest() == prepared["enginePinSha256"], "Retained immutable pin bytes changed")
    exact(staged, {"version", "status", "sources", "image", "enginePinSha256", "engineVersion", "coreVersion", "shell", "rawPack", "catalog", "pod", "mounts", "retirement", "originalEvidence"})
    require(type(staged["version"]) is int and staged["version"] == 1 and staged["status"] == "ISOLATED_SHELL_ACCEPTED_AND_RETIRED" and staged["sources"] == prepared["sources"] and staged["image"] == prepared["image"]
            and staged["enginePinSha256"] == prepared["enginePinSha256"] and staged["engineVersion"] == pin["engine"]["version"] and staged["coreVersion"] == pin["core"]["version"] and staged["catalog"] == prepared["catalog"], "Retired stage source/image/ABI/catalog differs")
    exact(staged["shell"], set(prepared["shell"]) | {"claim", "claimUID"}); exact(staged["rawPack"], set(prepared["rawPack"]) | {"storage", "volume", "claim", "claimUID"})
    require(all(staged["shell"][k] == v for k, v in prepared["shell"].items()) and staged["shell"]["claim"] == candidate and staged["shell"]["claimUID"] == claims[candidate]["metadata"]["uid"], "Stage shell claim/full-manifest differs")
    require(all(staged["rawPack"][k] == v for k, v in prepared["rawPack"].items()) and staged["rawPack"]["claimUID"] == claims[temporary_pack]["metadata"]["uid"], "Stage pack must bind its exact temporary isolated claim/copy")
    pack_volume = resources.name(staged["rawPack"]["volume"])
    for family in ("shell", "rawPack"):
        resources.positive(prepared[family]["files"]); cohort.sha(prepared[family]["manifestSha256"])
    stage_meta = resources.identity(staged["pod"], "Pod", namespace); require(stage_meta["uid"] not in pod_uids, "Stage Pod still exists in namespace capture")
    stage_spec, stage_container = stage_security(staged["pod"], prepared["image"])
    require(not local_nodes or stage_spec.get("nodeName") in local_nodes, "Stage mounted another local storage node")
    volumes = stage_spec.get("volumes", []); mounts = stage_container.get("volumeMounts", [])
    for items in (volumes, mounts):
        require(isinstance(items, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in items) and len({v["name"] for v in items}) == len(items), "Duplicate stage resource names")
    exact(staged["mounts"], {"shellPath", "packPath", "pinPath"})
    stage_paths = [resources.mount_path(staged["mounts"][k]) for k in ("shellPath", "packPath", "pinPath")]
    require(len(set(stage_paths)) == 3 and not any(a.startswith(b + "/") for a in stage_paths for b in stage_paths if a != b), "Stage mount paths overlap")
    chosen = []
    for kind, leaf, selected, path, subpath in (("persistentVolumeClaim", "claimName", candidate, stage_paths[0], None), ("persistentVolumeClaim", "claimName", temporary_pack, stage_paths[1], None), ("configMap", "name", previous["pin"]["name"], stage_paths[2], pin_key)):
        found = [v for v in volumes if v.get(kind, {}).get(leaf) == selected]
        require(len(found) == 1 and set(found[0]) == {"name", kind}, "Stage selected volume missing or ambiguous")
        matching = [mt for mt in mounts if mt["name"] == found[0]["name"]]
        require(len(matching) == 1 and matching[0].get("mountPath") == path and matching[0].get("readOnly") is True and "subPathExpr" not in matching[0]
                and (matching[0].get("subPath") == subpath if subpath else "subPath" not in matching[0]), "Stage mounted content incorrectly or writable")
        chosen.append(found[0]["name"])
        if selected == temporary_pack:
            require(found[0]["name"] == pack_volume, "Temporary pack volume identity differs")
    require(len(set(chosen)) == 3, "Stage volume aliases selected content")
    for volume in volumes:
        require(set(volume) == {"name", "emptyDir"} or (set(volume) == {"name", "persistentVolumeClaim"} and volume["persistentVolumeClaim"].get("claimName") in candidates)
                or (set(volume) == {"name", "configMap"} and volume["configMap"].get("name") == previous["pin"]["name"]), "Stage mounted active storage, secret or unknown volume")
    require(all(mt["name"] in {v["name"] for v in volumes} for mt in mounts), "Unknown stage mount")
    exact(staged["retirement"], {"podUID", "policyName", "policyUID", "podAbsent", "policyAbsent", "mountsReleased"})
    require(staged["retirement"]["podUID"] == stage_meta["uid"] and all(staged["retirement"][k] is True for k in ("podAbsent", "policyAbsent", "mountsReleased")), "Missing actual stage retirement/unmount proof")
    resources.text(staged["retirement"]["policyUID"], "retired policy UID")
    resources.name(staged["retirement"]["policyName"])
    require(isinstance(staged["originalEvidence"], list) and 3 <= len(staged["originalEvidence"]) <= 16, "Missing original content/runtime/retirement proof")
    runtime = inputs.file(staged["originalEvidence"][0])
    require(isinstance(runtime, dict) and type(runtime.get("version")) is int and runtime["version"] == 1 and runtime.get("status") == "ISOLATED_PRIVATE_SHELL_RUNTIME_VERIFIED"
            and runtime.get("sources") == prepared["sources"] and runtime.get("image") == runtime.get("actualImageId") == prepared["image"] and runtime.get("podUID") == stage_meta["uid"]
            and runtime.get("enginePinSha256") == prepared["enginePinSha256"] and runtime.get("engineVersion") == pin["engine"]["version"] and runtime.get("coreVersion") == pin["core"]["version"]
            and runtime.get("shellManifestSha256") == prepared["shell"]["manifestSha256"] and runtime.get("shellFiles") == prepared["shell"]["files"]
            and runtime.get("packManifestSha256") == prepared["rawPack"]["manifestSha256"] and runtime.get("packFiles") == prepared["rawPack"]["files"] and runtime.get("catalog") == prepared["catalog"]
            and all(runtime.get(k) is True for k in ("fullShellHashesVerified", "fullPackHashesVerified", "retainedImmutablePinVerified", "filteredCatalogSignatureVerified", "publicPinMatches")), "Original runtime/content qualification differs")
    require(runtime.get("uid") == stage_container["securityContext"]["runAsUser"] and type(runtime.get("gid")) is int and runtime["gid"] > 0, "Original runtime credentials differ")
    writer = inputs.file(staged["originalEvidence"][1])
    require(isinstance(writer, dict) and type(writer.get("version")) is int and writer["version"] == 1 and writer.get("status") == "ISOLATED_PRIVATE_SHELL_WRITER_VERIFIED_AND_RETIRED"
            and writer.get("shellClaim") == candidate and writer.get("shellClaimUID") == claims[candidate]["metadata"]["uid"] and writer.get("packClaim") == temporary_pack
            and writer.get("packClaimUID") == claims[temporary_pack]["metadata"]["uid"] and writer.get("shellManifestSha256") == prepared["shell"]["manifestSha256"] and writer.get("packManifestSha256") == prepared["rawPack"]["manifestSha256"]
            and all(writer.get(k) is True for k in ("fullShellHashesVerified", "fullPackHashesVerified", "podAbsent", "mountsReleased")), "Original writer content/retirement proof differs")
    writer_meta = resources.identity(writer.get("pod"), "Pod", namespace)
    require(writer_meta["uid"] not in pod_uids | {stage_meta["uid"]}, "Writer is still present or aliases the qualifier")
    writer_spec, writer_container = stage_security(writer["pod"], prepared["image"])
    require(not local_nodes or writer_spec.get("nodeName") in local_nodes, "Writer used another storage node")
    writer_volumes = writer_spec.get("volumes", []); writer_mounts = writer_container.get("volumeMounts", [])
    require(isinstance(writer_volumes, list) and isinstance(writer_mounts, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in [*writer_volumes, *writer_mounts])
            and len({v["name"] for v in writer_volumes}) == len(writer_volumes) and len({v["name"] for v in writer_mounts}) == len(writer_mounts), "Writer resource names are ambiguous")
    written_claims = set()
    for volume in writer_volumes:
        if "persistentVolumeClaim" in volume:
            claim_name = volume["persistentVolumeClaim"].get("claimName")
            require(set(volume) == {"name", "persistentVolumeClaim"} and claim_name in candidates, "Writer mounted active or unrelated storage")
            mt = [mount for mount in writer_mounts if mount["name"] == volume["name"]]
            require(len(mt) == 1 and mt[0].get("readOnly", False) is False and "subPath" not in mt[0] and "subPathExpr" not in mt[0], "Writer content mount differs")
            resources.mount_path(mt[0].get("mountPath")); written_claims.add(claim_name)
        else:
            require(set(volume) == {"name", "emptyDir"}, "Writer inherited pin, secret or unsafe volume")
    require(written_claims == candidates and all(mt["name"] in {v["name"] for v in writer_volumes} for mt in writer_mounts), "Writer did not fill exactly both new claims")
    retired = inputs.file(staged["originalEvidence"][2])
    require(isinstance(retired, dict) and type(retired.get("version")) is int and retired["version"] == 1 and retired.get("status") == "ISOLATED_PRIVATE_SHELL_STAGE_RETIRED"
            and all(retired.get(k) == v for k, v in staged["retirement"].items()), "Original actual retirement proof differs")
    for ref in staged["originalEvidence"]:
        inputs.file(ref, False)
    inputs.unchanged()
    guards = {(r["kind"], r["metadata"]["name"]): resources.resource_guard(r) for r in [*claims.values(), *pvs.values(), pin_map]}
    return {"version": 1, "status": STATUS, "sources": prepared["sources"], "image": prepared["image"], "preparedSha256": value["prepared"]["sha256"], "previousCohortSha256": value["previous"]["sha256"], "stageReceiptSha256": value["stage"]["sha256"],
            "namespace": namespace, "namespaceUID": ns["uid"], "deployment": deployment, "deploymentUID": metadata["uid"], "resourceVersion": metadata["resourceVersion"], "beforeSpecSha256": cohort.digest(before["spec"]),
            "desiredSpecSha256": cohort.digest(desired), "desiredSpec": desired, "guardedPatch": patch, "selection": selection, "mounts": value["mounts"], "resourceGuards": [guards[k] for k in sorted(guards)], "podInventoryResourceVersion": pods["metadata"]["resourceVersion"],
            "rollbackIntent": rollback, "allUnselectedSpecFieldsPreserved": True, "evidence": [{"path": str(p), "sha256": h} for p, (_, h) in sorted(inputs.reads.items())],
            "qualificationBoundary": {"capturesAndReportsLocallyBound": True, "originAuthenticatedByThisCommand": False, "liveResourcesChecked": False, "serverDryRunPerformed": False, "runtimeQualifiedByThisCommand": False, "productionMutation": False},
            "requiredBeforeApply": ["Fresh target preflight and every captured resource UID/RV/spec/data readback plus complete namespace Pod inventory", "Exact new shell full hashes and unchanged pack/immutable pin, isolated retired-stage original proof", "Reviewed server dry run with every unselected field preserved", "Atomic full-spec/UID/RV tested shell-only patch under serialized ownership", "Owning runtime/TLS/export/agent/reconnect acceptance and fresh data-preserving rollback review"]}, inputs


def publish(value, out, inputs):
    checksum = resources.publish(value, out, inputs)
    ownership = cohort.stamp(out.lstat())[:2]
    require(cohort.read_file(out / "private-cohort.plan.json", cohort.JSON_LIMIT * 2)[0] == cohort.canonical(value) + b"\n", "Protected plan output changed")
    inputs.unchanged(); require(cohort.stamp(out.lstat())[:2] == ownership, "Planned directory ownership changed")
    os.link(out / "private-cohort.plan.json", out / "private-shell.plan.json", follow_symlinks=False)
    (out / "private-cohort.plan.json").unlink()
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True); parser.add_argument("--reviewed-evidence-sha256", required=True); parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(); path = cohort.local_path(args.evidence, Path.cwd()); data, identity = cohort.read_file(path)
    require(hashlib.sha256(data).hexdigest() == cohort.sha(args.reviewed_evidence_sha256), "Planning evidence differs from review")
    result, inputs = plan(cohort.parse_json(data), path.parent); inputs.reads[path] = (identity, args.reviewed_evidence_sha256)
    result["evidence"].append({"path": str(path), "sha256": args.reviewed_evidence_sha256}); result["evidence"].sort(key=lambda ref: ref["path"])
    checksum = publish(result, Path(os.path.abspath(args.out_dir)), inputs)
    print(json.dumps({"status": STATUS, "planSha256": checksum, "canonicalPlanSha256": cohort.digest(result), "productionMutation": False}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError, StopIteration):
        print("REFUSED: shell-only captures or retired-stage custody differ; retain any partial output", file=sys.stderr)
        raise SystemExit(1)
