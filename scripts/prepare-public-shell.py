#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Bind a public five-path static overlay offline; never stage, publish or authenticate origins.

Reuse is constrained to an independently accepted Nginx image, public catalog,
verification key, model mount and configuration. Full non-shell Git equality,
normal main CI, exact physical trees and genuine original runtime evidence are
independent gates. The output is an unqualified plan, never permission to apply.
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
import subprocess
import sys

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("shell_compatibility", Path(__file__).with_name("prepare-private-shell.py"))
shared = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(shared)
cohort, require, exact, Refusal = shared.cohort, shared.require, shared.exact, shared.Refusal
STATUS = "PUBLIC_SHELL_OVERLAY_PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED"
PRODUCER_STATUS = "LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED"
SETTINGS = {"catalogTrustMode": "verified", "requireAiPolicy": False, "liveRelay": "https://lolly.tools/live", "siteUrl": "https://lolly.tools"}
ROOT = "/usr/share/nginx/html"
OVERLAY_ANCHOR = "/run/lolly-public-overlay"
FS_GROUP_POLICY = "OnRootMismatch"
PUBLIC_GROUP = 101
PATHS = ("_app", "index.html", "precache.json", "sw.js", "portable/player.js")
CATALOG_KEYS = {"indexSha256", "envelopeSha256", "pinCanonicalSha256", "keyId", "signedFiles"}
BASELINE_KEYS = {"version", "imageSource", "shellSource", "image", "profile", "settings", "publicKeySha256", "publicCatalog", "staticManifest", "overlay", "deploymentSpecSha256", "deployment", "nginxConfig", "modelsClaim", "modelsPV", "policyInventory", "serviceInventory", "originalEvidence"}
PRODUCER_KEYS = {"version", "status", "artifactClass", "lollySource", "imageSource", "previousShellSource", "image", "profile", "settings", "publicCatalog", "shellManifestSha256", "workspaceModules", "originalReport", "classification", "imageClassification", "custody", "previousAcceptance", "ci", "publicKey", "previous", "candidate", "shell", "overlay", "delta", "retention", "retainedFiles", "webGate", "catalog", "producer", "producerSourceFiles", "originAuthenticatedByThisCommand", "normalCIQualified", "runtimeQualified", "promotionAttempted"}
PRODUCER_SOURCES = {"prepare-public-shell-update.ts", "prepare-shell-update.ts", "classify-application-release.ts", "retain-shell-assets.ts", "shell-update-files.ts", "shell-update-clone.py", "shell-update-vite.mjs"}


def overlay_path(path):
    return path.startswith("_app/") or path in PATHS[1:]


def overlay_mounts(volume):
    # Kubelet marks a managed volume relabeled at its first container mount.
    # Relabel the whole new overlay before resolving its serving subPaths.
    return [{"name": volume, "mountPath": OVERLAY_ANCHOR, "readOnly": True},
            *[{"name": volume, "mountPath": ROOT + "/" + path, "readOnly": True, "subPath": path} for path in PATHS]]


def resource(value, api, kind, namespace=None):
    require(isinstance(value, dict) and value.get("apiVersion") == api and value.get("kind") == kind, "Unexpected public resource type")
    meta = value.get("metadata", {})
    require(isinstance(meta, dict) and all(isinstance(meta.get(k), str) and meta[k] for k in ("name", "uid", "resourceVersion")), "Complete public resource identity required")
    require(cohort.NAME.fullmatch(meta["name"]) and (meta.get("namespace") == namespace if namespace is not None else "namespace" not in meta), "Public resource scope differs")
    return value


def original_baseline(previous, before, old_files, inputs):
    """Read original evidence; a success wrapper or private receipt cannot substitute."""
    require(isinstance(previous["originalEvidence"], list) and len(previous["originalEvidence"]) == (4 if previous["overlay"] is None else 5), "Original public baseline proofs required")
    accepted, prepared, static = [inputs.file(ref) for ref in previous["originalEvidence"][:3]]
    checksum_path = inputs.file(previous["originalEvidence"][3], False)
    checksum_bytes, _ = cohort.read_file(checksum_path)
    require(isinstance(static, dict) and set(static) == {"htmlRoot", "files"} and static["htmlRoot"] == ROOT[1:] and isinstance(static["files"], dict), "Complete original public image static inventory required")
    original_files = {}
    for path, row in static["files"].items():
        cohort.safe_path(path); exact(row, {"mode", "size", "sha256"})
        require(type(row["mode"]) is int and row["mode"] in {0o644, 0o755} and type(row["size"]) is int and row["size"] >= 0 and not path.startswith("models/"), "Original public static entry differs")
        original_files[path] = {"path": path, "size": row["size"], "sha256": cohort.sha(row["sha256"])}
    require(original_files == old_files, "Complete accepted static snapshot differs from original public proof")
    lines = checksum_bytes.decode().splitlines(); hashes = {}
    for line in lines:
        match = re.fullmatch(r"([a-f0-9]{64})  " + re.escape(ROOT) + r"/(.+)", line)
        require(match is not None, "Malformed original public runtime hash manifest")
        checksum, path = match.groups(); cohort.safe_path(path); require(path not in hashes, "Duplicate original public runtime path"); hashes[path] = checksum
    require(hashes == {p: row["sha256"] for p, row in old_files.items()}, "Original runtime hashes do not cover the complete accepted static snapshot")
    runtime = accepted.get("runtime", {})
    # The initial image-only receipt is the existing public647 protocol. Later
    # public overlays must provide their own actual acceptance, never relabel it.
    require(prepared.get("status") == "INDEPENDENT_PUBLIC647_IMAGE_ONLY_EXPECTATIONS_PREPARED_BEFORE_PROMOTION" and prepared.get("source") == previous["imageSource"], "Unknown original accepted public image preparation")
    accepted_prepared_sha = previous["originalEvidence"][1]["sha256"]
    if previous["overlay"] is None:
        require(accepted.get("status") == "READ_ONLY_PUBLIC647_PROMOTION_ACCEPTANCE_PASSED" and previous["imageSource"] == previous["shellSource"] == accepted.get("source"), "Unknown original public image acceptance/source")
        expected_spec = prepared.get("expectedPublicSpec")
    else:
        accepted_plan = inputs.file(previous["originalEvidence"][4]); accepted_prepared_sha = previous["originalEvidence"][4]["sha256"]
        require(accepted.get("status") == "PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED" and accepted.get("shellSource") == previous["shellSource"]
                and accepted.get("imageSource") == previous["imageSource"] and accepted.get("overlayManifestSha256") == previous["overlay"]["manifest"]["sha256"]
                and accepted.get("staticManifestSha256") == previous["staticManifest"]["sha256"] and accepted_plan.get("status") == STATUS
                and accepted_plan.get("image") == previous["image"] and accepted_plan.get("sources") == {"shell": previous["shellSource"], "image": previous["imageSource"]}, "Unknown original public overlay acceptance/source")
        expected_spec = accepted_plan.get("desiredSpec")
    require(accepted.get("readOnly") is True and accepted.get("productionMutation") is False
            and accepted.get("publicMCPAndOtherEightSpecsUnchanged") is True
            and accepted.get("preparedSha256") == accepted_prepared_sha
            and runtime.get("actualPublicSpecSha256") == runtime.get("independentExpectedSpecSha256") == previous["deploymentSpecSha256"]
            and expected_spec == before["spec"] and prepared.get("image") == runtime.get("image") == runtime.get("imageID") == previous["image"]
            and runtime.get("deploymentUID") == before["metadata"]["uid"] and runtime.get("ready") is True and runtime.get("restarts") == 0
            and runtime.get("allStaticFilesChecked") == len(old_files) and runtime.get("uidGid") == ["101", "101"]
            and runtime.get("stagerPodAndPolicyAbsent") is True and runtime.get("modelsPrefixExcluded") == ROOT + "/models/"
            and runtime.get("runtimeHashManifestSha256") == previous["originalEvidence"][3]["sha256"], "Original public owner/image/spec/full-tree runtime proof differs")
    for key in ("podUID", "podSpecSha256", "modelsClaimUID", "modelsPVUID", "nginxConfigSha256"):
        require(isinstance(runtime.get(key), str) and runtime[key], "Original public runtime identity missing")
    cohort.sha(runtime["podSpecSha256"])
    catalog = accepted.get("catalogSignatureVerifiedAndActualSignedBytesMatched", {})
    actual = previous["publicCatalog"]
    require(catalog.get("verified") is True and catalog.get("exactFreshNeutralCatalogPayloadPreserved") is True
            and catalog.get("existingPublicPinCanonicalSha256") == actual["pinCanonicalSha256"] and catalog.get("publicJWKSha256") == previous["publicKeySha256"]
            and catalog.get("indexSha256") == actual["indexSha256"] and catalog.get("keyId") == actual["keyId"] and catalog.get("files") == actual["signedFiles"], "Original public catalog/pin qualification differs")
    probes = accepted.get("normalVerifiedTLSRequests", {})
    require(isinstance(probes, dict) and 1 <= len(probes) <= 100 and all(isinstance(p, dict) and p.get("status") == 200 and p.get("verifiedTlsAndHostname") is True for p in probes.values())
            and accepted.get("trustedSystemCA", {}).get("certificateVerification") == "CERT_REQUIRED" and accepted["trustedSystemCA"].get("hostnameVerification") is True, "Original public normal-TLS proof missing")
    return prepared, runtime


def baseline(value, inputs):
    exact(value, BASELINE_KEYS); require(type(value["version"]) is int and value["version"] == 1, "Unknown public baseline version")
    for key in ("imageSource", "shellSource"): cohort.commit(value[key])
    cohort.paired.updater.image_ref(value["image"])
    require(value["profile"] == "lolly-start" and value["settings"] == SETTINGS and type(value["settings"].get("requireAiPolicy")) is bool, "Accepted public profile/signature/AI/site/relay policy changed")
    cohort.sha(value["publicKeySha256"]); exact(value["publicCatalog"], CATALOG_KEYS)
    for key in ("indexSha256", "envelopeSha256", "pinCanonicalSha256"): cohort.sha(value["publicCatalog"][key])
    require(type(value["publicCatalog"]["signedFiles"]) is int and 0 < value["publicCatalog"]["signedFiles"] <= cohort.MAX_FILES and re.fullmatch(r"[A-Za-z0-9_-]{43}", value["publicCatalog"]["keyId"]), "Invalid public signed-catalog tuple")
    before = inputs.file(value["deployment"])
    namespace = before.get("metadata", {}).get("namespace")
    require(isinstance(namespace, str) and cohort.NAME.fullmatch(namespace), "Explicit public namespace required")
    resource(before, "apps/v1", "Deployment", namespace)
    require(cohort.digest(before.get("spec")) == cohort.sha(value["deploymentSpecSha256"]), "Accepted public full Deployment spec differs")
    manifest = inputs.file(value["staticManifest"])
    exact(manifest, {"version", "files", "totalBytes"})
    require(type(manifest["version"]) is int and manifest["version"] == 1 and isinstance(manifest["files"], list) and 1 <= len(manifest["files"]) <= cohort.MAX_FILES, "Complete accepted public static manifest required")
    files = {}; total = 0
    for row in manifest["files"]:
        exact(row, {"path", "size", "sha256"}); path = cohort.safe_path(row["path"]); cohort.sha(row["sha256"])
        require(path not in files and type(row["size"]) is int and row["size"] >= 0 and not path.startswith("models/"), "Invalid accepted public static entry")
        files[path] = row; total += row["size"]
    require(list(files) == sorted(files) and type(manifest["totalBytes"]) is int and total == manifest["totalBytes"] <= cohort.MAX_BYTES, "Accepted public static manifest order/total differs")
    prepared, runtime = original_baseline(value, before, files, inputs)
    config = resource(inputs.file(value["nginxConfig"]), "v1", "ConfigMap", namespace)
    claim = resource(inputs.file(value["modelsClaim"]), "v1", "PersistentVolumeClaim", namespace)
    pv = resource(inputs.file(value["modelsPV"]), "v1", "PersistentVolume")
    require(config.get("data", {}).get("default.conf") and hashlib.sha256(config["data"]["default.conf"].encode()).hexdigest() == runtime["nginxConfigSha256"]
            and config["metadata"]["uid"] == prepared["nginxConfig"]["metadata"]["uid"] and config.get("data") == prepared["nginxConfig"].get("data")
            and config.get("binaryData") == prepared["nginxConfig"].get("binaryData"), "Accepted Nginx config bytes/identity changed")
    require(claim["metadata"]["uid"] == runtime["modelsClaimUID"] == prepared["modelsClaim"]["metadata"]["uid"] and claim.get("spec") == prepared["modelsClaim"].get("spec")
            and claim.get("status", {}).get("phase") == "Bound" and pv["metadata"]["uid"] == runtime["modelsPVUID"] == prepared["modelsPV"]["metadata"]["uid"]
            and pv.get("spec") == prepared["modelsPV"].get("spec") and pv.get("status", {}).get("phase") == "Bound"
            and claim["spec"].get("volumeName") == pv["metadata"]["name"] and pv["spec"].get("claimRef", {}).get("uid") == claim["metadata"]["uid"], "Accepted model storage/identity/backing changed")
    for key in ("policyInventory", "serviceInventory"):
        inventory = inputs.file(value[key]); require(isinstance(inventory, dict) and inventory, "Explicit public policy/service inventory required")
        expected = copy.deepcopy(prepared[key])
        # Historical public647 preparation preceded its isolated staging-policy
        # retirement, which is explicitly proved in the acceptance above.
        if key == "policyInventory": expected.pop("lolly-public-models-stage", None)
        require(inventory == expected, "Accepted public policy/service inventory changed")
        for name, row in inventory.items():
            require(cohort.NAME.fullmatch(name), "Invalid public dependency name"); exact(row, {"uid", "spec"}); require(isinstance(row["uid"], str) and row["uid"] and isinstance(row["spec"], dict), "Invalid complete public dependency payload")
    return before, files, config, claim, pv


def desired_spec(previous, before, selection, source, overlay_sha):
    exact(selection, {"container", "shellVolume", "shellClaim"})
    require(all(isinstance(v, str) and cohort.NAME.fullmatch(v) for v in selection.values()), "Exact selected public container/volume/claim names required")
    require(all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", selection[k]) for k in ("container", "shellVolume")), "Public container and volume names must be DNS labels")
    pod = before["spec"]["template"]["spec"]
    require(len(pod.get("containers", [])) == 1 and not pod.get("initContainers") and not pod.get("ephemeralContainers"), "Accepted public server must have exactly one regular container")
    server = pod["containers"][0]
    require(server.get("name") == selection["container"] and server.get("image") == previous["image"], "Selected public image/container differs")
    mounts, volumes = server.get("volumeMounts", []), pod.get("volumes", [])
    require(isinstance(mounts, list) and isinstance(volumes, list) and len({m.get("mountPath") for m in mounts}) == len(mounts) and len({v.get("name") for v in volumes}) == len(volumes), "Ambiguous public mounts/volumes")
    models = [m for m in mounts if m.get("mountPath") == ROOT + "/models"]
    config = [m for m in mounts if m.get("mountPath") == "/etc/nginx/conf.d/default.conf"]
    require(len(models) == len(config) == 1 and models[0].get("readOnly") is True and config[0].get("readOnly") is True and config[0].get("subPath") == "default.conf", "Accepted model and config mounts must remain read-only")
    model_volumes = [v for v in volumes if v.get("name") == models[0]["name"]]
    config_volumes = [v for v in volumes if v.get("name") == config[0]["name"]]
    require(len(model_volumes) == len(config_volumes) == 1 and model_volumes[0].get("persistentVolumeClaim", {}).get("claimName") == previous["modelsName"]
            and config_volumes[0].get("configMap", {}).get("name") == previous["nginxName"], "Mounted accepted models/config resource differs")
    require(model_volumes[0]["persistentVolumeClaim"].get("readOnly", False) is False, "Accepted model source must retain local volume management")
    security = pod.get("securityContext", {})
    require(all(type(security.get(key)) is int and security[key] == PUBLIC_GROUP for key in ("runAsUser", "runAsGroup", "fsGroup")), "Accepted public UID/GID/fsGroup must remain integer 101")
    require(selection["shellClaim"] not in {v.get("persistentVolumeClaim", {}).get("claimName") for v in volumes}, "New public shell claim must be distinct from every mounted claim")
    desired = copy.deepcopy(before["spec"]); selected = desired["template"]["spec"]; target = selected["containers"][0]
    expected_mounts = overlay_mounts(selection["shellVolume"])
    if previous["overlay"] is None:
        require(security.get("fsGroupChangePolicy") in (None, "Always", FS_GROUP_POLICY), "Unknown accepted fsGroup policy")
        require(selection["shellVolume"] not in {v.get("name") for v in volumes}, "Bootstrap shell volume already exists")
        for m in mounts:
            path = m.get("mountPath")
            require(isinstance(path, str) and all(path != p and not p.startswith(path.rstrip("/") + "/") and not path.startswith(p + "/") for p in [OVERLAY_ANCHOR, *[ROOT + "/" + p for p in PATHS]]), "Existing mount overlaps a selected public overlay path")
        target["volumeMounts"] += expected_mounts
        selected["volumes"].append({"name": selection["shellVolume"], "persistentVolumeClaim": {"claimName": selection["shellClaim"]}})
        selected["securityContext"]["fsGroupChangePolicy"] = FS_GROUP_POLICY
    else:
        old = previous["overlay"]; exact(old, {"volume", "claim", "claimUID", "manifest"})
        require(old["volume"] == selection["shellVolume"] and isinstance(old["claimUID"], str) and old["claimUID"], "Accepted public overlay tuple differs")
        require(security.get("fsGroupChangePolicy") == FS_GROUP_POLICY, "Accepted public fsGroup policy differs")
        require([m for m in mounts if m.get("name") == selection["shellVolume"]] == expected_mounts, "Accepted public overlay anchor and five read-only mounts differ")
        indexes = [i for i, v in enumerate(volumes) if v.get("name") == selection["shellVolume"]]
        require(len(indexes) == 1 and volumes[indexes[0]] == {"name": selection["shellVolume"], "persistentVolumeClaim": {"claimName": old["claim"]}}, "Accepted public overlay managed source differs")
        selected["volumes"][indexes[0]]["persistentVolumeClaim"]["claimName"] = selection["shellClaim"]
    annotations = desired["template"]["metadata"].setdefault("annotations", {})
    if previous["overlay"] is not None:
        require(annotations.get("lolly.tools/public-image-source") == previous["imageSource"] and annotations.get("lolly.tools/public-shell-source") == previous["shellSource"]
                and annotations.get("lolly.tools/public-overlay-manifest") == previous["overlay"]["manifest"]["sha256"], "Accepted public overlay provenance differs")
    else:
        require(not any(key in annotations for key in ("lolly.tools/public-image-source", "lolly.tools/public-shell-source", "lolly.tools/public-overlay-manifest")), "Unaccepted public overlay provenance already exists")
    annotations.update({"lolly.tools/public-image-source": previous["imageSource"], "lolly.tools/public-shell-source": source, "lolly.tools/public-overlay-manifest": overlay_sha})
    return desired


def prepare(value, base, node="node", runner=shared.git_command):
    exact(value, {"version", "lolly", "producer", "previous", "selection", "desiredSpec"})
    require(type(value["version"]) is int and value["version"] == 1, "Unknown public shell evidence version")
    inputs = cohort.Inputs(base)
    root, run = cohort.source_record(value["lolly"], inputs, runner, "lolly")
    previous = inputs.file(value["previous"]); before, old_files, config, models, pv = baseline(previous, inputs)
    producer = inputs.file(value["producer"]); exact(producer, PRODUCER_KEYS)
    require(producer["version"] == 1 and type(producer["version"]) is int and producer["status"] == PRODUCER_STATUS and producer["artifactClass"] == "public-shell-overlay"
            and producer["lollySource"] == value["lolly"]["source"] and producer["imageSource"] == previous["imageSource"] and producer["previousShellSource"] == previous["shellSource"]
            and all(producer[k] == previous[k] for k in ("image", "profile", "settings", "publicCatalog"))
            and all(producer[k] is False for k in ("originAuthenticatedByThisCommand", "normalCIQualified", "runtimeQualified", "promotionAttempted")), "Local public producer identity/boundary differs")
    require(producer["previousAcceptance"] == previous["originalEvidence"][0] and producer["publicKey"]["sha256"] == previous["publicKeySha256"]
            and producer["ci"] == value["lolly"]["ciRun"], "Public previous acceptance/pin/CI reference differs")
    custody = inputs.file(producer["custody"])
    exact(custody, {"version", "artifactClass", "imageSource", "previousShellSource", "image", "profile", "settings", "previousManifest", "previousAcceptance", "ci", "publicKeySha256", "publicCatalog"})
    require(type(custody["version"]) is int and custody["version"] == 1 and custody["artifactClass"] == "public-shell-overlay"
            and custody["imageSource"] == previous["imageSource"] and custody["previousShellSource"] == previous["shellSource"]
            and all(custody[k] == previous[k] for k in ("image", "profile", "settings", "publicCatalog", "publicKeySha256"))
            and custody["previousManifest"] == previous["staticManifest"] and custody["previousAcceptance"] == producer["previousAcceptance"] and custody["ci"] == producer["ci"], "Original public producer custody differs from baseline")
    compatibility = shared.compatibility(root, {"engineSource": previous["imageSource"], "shellSource": previous["shellSource"]}, producer["lollySource"], inputs.file(producer["classification"]), runner)
    trees = {key: cohort.Tree(producer[key], inputs) for key in ("previous", "candidate", "shell", "overlay", "delta")}
    require(len({t.root for t in trees.values()}) == 5 and all(a.root not in b.root.parents for a in trees.values() for b in trees.values() if a != b), "Public artifact trees overlap")
    old, candidate, shell, overlay, delta = (trees[k] for k in ("previous", "candidate", "shell", "overlay", "delta"))
    require(old.files == old_files and shell.manifest_sha == producer["shellManifestSha256"], "Producer complete previous/prepared public manifest differs")
    cohort.retention(candidate, old, shell)
    for path, row in old.files.items():
        if not overlay_path(path): require(candidate.files.get(path) == row, "Protected public static resource changed or disappeared")
    changed = {p: row for p, row in candidate.files.items() if old.files.get(p) != row}
    require(changed and all(overlay_path(p) for p in changed) and delta.files == changed, "Public delta includes protected content or loses changed bytes")
    require(overlay.files == {p: row for p, row in shell.files.items() if overlay_path(p)} and all(p in overlay.files for p in PATHS[1:])
            and any(p.startswith("_app/") for p in overlay.files), "Public overlay must contain exactly the five retained static paths")
    if previous["overlay"] is not None:
        exact(previous["overlay"], {"volume", "claim", "claimUID", "manifest"})
        prior_overlay = inputs.file(previous["overlay"]["manifest"])
        require(prior_overlay == {"version": 1, "files": [row for p, row in old.files.items() if overlay_path(p)], "totalBytes": sum(row["size"] for p, row in old.files.items() if overlay_path(p))}, "Previously accepted public overlay manifest differs")
    pin = inputs.file(producer["publicKey"])
    actual_catalog = public_catalog(shell, pin, previous["publicCatalog"], node)
    exact(producer["catalog"], {"previous", "candidate", "signatureReused", "newSigning"})
    require(producer["catalog"]["signatureReused"] is True and producer["catalog"]["newSigning"] is False, "Public producer must reuse the accepted signed catalog")
    for key in ("originalReport", "webGate"):
        report = inputs.file(producer[key]); require(report.get("exitCode") == 0 and report.get("signal") is None and report.get("error") is None, "Maintained public build/gate refused")
    require(isinstance(producer["producerSourceFiles"], list) and len(producer["producerSourceFiles"]) == len(PRODUCER_SOURCES), "Complete public producer helper closure required")
    source_refs = {}
    producer_root = cohort.local_path(producer["producer"]["path"], base).parent
    for ref in producer["producerSourceFiles"]:
        path = inputs.file(ref, False)
        require(path.parent == producer_root and path.name in PRODUCER_SOURCES and path.name not in source_refs, "Public producer helper closure differs")
        source_refs[path.name] = ref
    require(set(source_refs) == PRODUCER_SOURCES and source_refs["prepare-public-shell-update.ts"] == producer["producer"], "Public producer source ref differs from closure")
    build_report = inputs.file(producer["originalReport"]); command = build_report.get("command")
    require(isinstance(command, list) and len(command) == 4 and command[1] == source_refs["shell-update-vite.mjs"]["path"] and isinstance(command[0], str), "Maintained public Vite runner command differs")
    runner_input = inputs.file({"path": command[2], "sha256": command[3]})
    exact(runner_input, {"source", "sourceCommit", "output", "prerequisites", "moduleReceipt"})
    require(runner_input["source"] == str(root) and runner_input["sourceCommit"] == producer["lollySource"] and runner_input["output"] == str(candidate.root)
            and runner_input["moduleReceipt"] == producer["workspaceModules"]["path"], "Original public Vite input source/output/module graph differs")
    for key in ("previous", "candidate"):
        report = inputs.file(producer["catalog"][key]); require(report.get("exitCode") == 0 and report.get("signal") is None and report.get("error") is None
                and report.get("command", [])[1:] == ["scripts/verify-release-catalog.ts", "--root", str(trees["previous" if key == "previous" else "candidate"].root), "--public-key", producer["publicKey"]["path"]], "Maintained public catalog verifier refused or differs")
    require(inputs.file(producer["webGate"])["command"][1:] == ["scripts/webgpu-release-gate.ts", "--scope", "web"], "Explicit public web gate required")
    modules = inputs.file(producer["workspaceModules"])
    require(modules.get("version") == 1 and modules.get("source") == str(root) and modules.get("guardIncludesWorkerGraph") is True and modules.get("normalCIQualified") is False and modules.get("productionAuthority") is False
            and isinstance(modules.get("modules"), list) and 1 <= len(modules["modules"]) <= 5000, "Genuine source-bound public workspace graph required")
    seen = set()
    for row in modules["modules"]:
        exact(row, {"path", "bytes", "sha256"}); path = cohort.local_path(row["path"], base)
        require(path.is_relative_to(root) and str(path) not in seen and type(row["bytes"]) is int and row["bytes"] >= 0
                and path.relative_to(root).as_posix().startswith(("engine/", "packages/core/", "packages/node-shell/", "packages/rondo/", "packages/audio-dock/")), "Duplicate or escaped public workspace module")
        relative = path.relative_to(root).as_posix(); data = cohort.git_bytes(root, producer["lollySource"], relative, runner)
        require(len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == cohort.sha(row["sha256"]), "Compiled public workspace bytes differ from candidate source"); seen.add(str(path))
    # Bind every original local receipt; local preparation does not authenticate
    # those origins and cannot turn them into runtime or CI qualification.
    for key in ("imageClassification", "retention", "producer"): inputs.file(producer[key], key != "producer")
    selected_previous = {**previous, "modelsName": models["metadata"]["name"], "nginxName": config["metadata"]["name"]}
    desired = desired_spec(selected_previous, before, value["selection"], producer["lollySource"], overlay.manifest_sha)
    require(inputs.file(value["desiredSpec"]) == desired, "Requested public desired spec changes an unselected field")
    operator_sources = []
    for name in ("prepare-public-shell.py", "prepare-private-shell.py", "prepare-private-cohort.py", "prepare-paired-release.py", "app-update.py"):
        path = Path(__file__).with_name(name).resolve(strict=True); _, digest, _ = cohort.hash_file(path)
        ref = {"path": str(path), "sha256": digest}; inputs.file(ref, False); operator_sources.append(ref)
    result = {"version": 1, "status": STATUS, "sources": {"shell": producer["lollySource"], "image": previous["imageSource"]}, "normalCI": {"lollyRunId": run["id"]},
              "image": previous["image"], "profile": previous["profile"], "settings": SETTINGS, "catalog": actual_catalog,
              "overlay": {"root": str(overlay.root), "manifestSha256": overlay.manifest_sha, "files": len(overlay.files), "totalBytes": sum(row["size"] for row in overlay.files.values()), "paths": list(PATHS)},
              "beforeSpecSha256": previous["deploymentSpecSha256"], "desiredSpecSha256": cohort.digest(desired), "desiredSpec": desired, "selection": value["selection"],
              "guardedPatchTemplate": [{"op": "test", "path": "/metadata/uid", "value": before["metadata"]["uid"]}, {"op": "test", "path": "/metadata/resourceVersion", "value": before["metadata"]["resourceVersion"]},
                                       {"op": "test", "path": "/spec", "value": before["spec"]}, {"op": "replace", "path": "/spec", "value": desired}],
              "rollbackIntent": {"spec": before["spec"], "requiresFreshIdentityAndAcceptedCurrentSpec": True}, "compatibility": compatibility,
              "modelsClaim": models["metadata"]["name"], "modelsClaimUID": models["metadata"]["uid"], "modelsPVUID": pv["metadata"]["uid"], "nginxConfig": config["metadata"]["name"], "nginxConfigUID": config["metadata"]["uid"],
              "selectedSpecFields": ["public overlay claim and source", "whole-overlay read-only anchor before five read-only serving mounts", "securityContext.fsGroupChangePolicy", "public shell provenance"],
              "allUnselectedSpecFieldsPreserved": True, "previousBaselineSha256": value["previous"]["sha256"], "operatorSourceFiles": operator_sources, "evidence": [{"path": str(p), "sha256": digest} for p, (_, digest) in sorted(inputs.reads.items())],
              "qualificationBoundary": {"localReviewedEvidence": True, "originAuthenticatedByThisCommand": False, "runtimeQualified": False, "productionMutation": False, "ociSignatureClaimed": False, "privateReceiptReuse": False},
              "requiredBeforeApply": ["Reviewed complete current namespace/PV/owner/Node inventories and backing-alias proof", "Only NEW isolated overlay claim; never mount active model or shell storage into staging", "Fresh local-plugin PV root GID 101, group rwx and setgid before qualifier and promotion; model root mismatch refuses without repair", "Exact accepted-image read-only Nginx/catalog/static/TLS/browser qualification", "Writer and qualifier retirement, UID deletion guards and observed mount release", "check-target immediately before each mutation, server admission proof, single-use intent and no ambiguous replay", "Fresh full-spec guarded promotion, actual owner/image/mount checks and post-promotion acceptance"]}
    inputs.unchanged(); return result, inputs


def public_catalog(shell, pin, expected, node):
    exact(pin, {"kty", "crv", "x", "y"})
    require(pin.get("kty") == "EC" and pin.get("crv") == "P-256" and all(isinstance(pin[k], str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", pin[k]) for k in ("x", "y"))
            and cohort.digest(pin) == expected["pinCanonicalSha256"], "Public verification pin changed")
    envelope = cohort.parse_json(shell.data("catalog/tools/index.sig.json"))
    exact(envelope, {"alg", "keyId", "signedAt", "indexHash", "files", "signature"})
    key_id = __import__("base64").urlsafe_b64encode(hashlib.sha256(cohort.canonical(pin)).digest()).decode().rstrip("=")
    require(envelope.get("alg") == "ECDSA-P256-SHA256" and envelope.get("keyId") == expected["keyId"] == key_id and envelope.get("indexHash") == expected["indexSha256"]
            and shell.files["catalog/tools/index.sig.json"]["sha256"] == expected["envelopeSha256"] and shell.files["catalog/tools/index.json"]["sha256"] == expected["indexSha256"]
            and isinstance(envelope.get("signedAt"), str) and re.fullmatch(r"[0-9TZ:.+\-]{20,40}", envelope["signedAt"])
            and isinstance(envelope.get("signature"), str) and re.fullmatch(r"[A-Za-z0-9_-]{86}", envelope["signature"])
            and isinstance(envelope.get("files"), dict) and len(envelope["files"]) == expected["signedFiles"], "Accepted signed public catalog changed")
    for path, digest in envelope["files"].items():
        cohort.safe_path(path); cohort.sha(digest)
        require(path.isascii() and "/" in path and shell.files.get("tools/" + path, {}).get("sha256") == digest, "Public signed tool content differs")
    require(all(path[6:] in envelope["files"] for path in shell.files if path.startswith("tools/") and path.endswith("/tool.json")), "Public tool manifest outside signed closure")
    cohort.verify_signature(pin, envelope, node)
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True); parser.add_argument("--reviewed-evidence-sha256", required=True); parser.add_argument("--out-dir", required=True); parser.add_argument("--node", default="node")
    args = parser.parse_args(); path = cohort.local_path(args.evidence, Path.cwd()); data, identity = cohort.read_file(path)
    require(hashlib.sha256(data).hexdigest() == cohort.sha(args.reviewed_evidence_sha256), "Reviewed public evidence bytes differ")
    result, inputs = prepare(cohort.parse_json(data), path.parent, args.node)
    inputs.reads[path] = (identity, args.reviewed_evidence_sha256); inputs.unchanged()
    result["evidence"].append({"path": str(path), "sha256": args.reviewed_evidence_sha256}); result["evidence"].sort(key=lambda ref: ref["path"])
    result["reviewedEvidenceSha256"] = args.reviewed_evidence_sha256
    checksum = cohort.publish(result, Path(os.path.abspath(args.out_dir)), inputs)
    print(json.dumps({"status": STATUS, "preparedFile": "cohort.prepared.json", "preparedSha256": checksum, "productionMutation": False}, sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("REFUSED: public source, catalog, original custody or exact overlay boundary differs; preserve partial output", file=sys.stderr); raise SystemExit(1)
