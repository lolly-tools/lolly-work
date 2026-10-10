#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Prepare an explicitly compatible private shell-only update offline.

This separate lane reuses an accepted Work image, raw pack and immutable engine
pin. It never builds, signs, authenticates report origins or contacts a cluster.
Only application shell files and existing shell provenance may change. Unknown
source paths, dependencies or contracts require the matched-cohort lane instead.
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
_spec = importlib.util.spec_from_file_location("private_cohort", Path(__file__).with_name("prepare-private-cohort.py"))
cohort = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cohort)
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
STATUS = "SHELL_ONLY_PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED"
EVIDENCE_KEYS = {"version", "lolly", "work", "enginePin", "resolverPin", "brand", "profile", "publicPin", "candidateShell", "previousShell", "shell", "rawPack", "build", "webGate", "previous", "selection", "classification"}
PREVIOUS_KEYS = {"version", "deployment", "deploymentSpecSha256", "shellSource", "engineSource", "workSource", "image", "enginePin", "resolverPin", "shell", "pack", "pin", "acceptance"}
BOUNDARY = {"localReviewedEvidence": True, "originAuthenticatedByThisCommand": False, "ociSignatureClaimed": False, "privateShellSignatureClaimed": False, "runtimeQualified": False, "productionMutation": False, "buildOrSigningPerformed": False}
PREPARED_KEYS = {"version", "status", "sources", "normalCI", "image", "profile", "enginePinSha256", "resolverPinSha256", "shell", "rawPack", "catalog", "previousCohortSha256", "beforeSpecSha256", "desiredSpecSha256", "desiredSpec", "guardedPatchTemplate", "rollbackIntent", "compatibility", "selection", "allUnselectedSpecFieldsPreserved", "evidence", "qualificationBoundary", "requiredBeforeApply"}
CLASSIFICATION_KEYS = {"version", "rulesVersion", "repository", "base", "candidate", "baseTree", "candidateTree", "classification", "reasons", "changedPaths", "changedPathsSha256", "advisory", "normalCiRequired", "privateCompatibilityReviewRequired", "artifactReuseAuthorized", "promotionAuthorized"}


def git_command(argv, root):
    require(argv[:1] == ["git"] and len(argv) >= 2 and argv[1] in {"rev-parse", "status", "show", "ls-tree", "merge-base", "cat-file"}, "Only offline Git reads are permitted")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
    result = subprocess.run(["git", "--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", *argv[1:]],
                            cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, check=False)
    require(result.returncode == 0 and len(result.stdout) <= cohort.JSON_LIMIT, "Read-only immutable Git verification failed")
    if argv[1] == "show":
        return result.stdout
    return result.stdout.decode().strip() if argv[1] in {"rev-parse", "status", "cat-file", "merge-base"} else result.stdout.decode()


def allowed_source(path):
    if re.search(r"(?:release-gate|supported-environments|support-matrix|browser-support|webgpu-qualification)", path, re.I):
        return False
    return (re.fullmatch(r"shells/web/src/.+\.(?:ts|css|html|svg)", path) is not None or path in {"shells/web/src/README.md", "shells/web/index.html", "shells/web/public/sw.js"}
            or re.fullmatch(r"tests/.+\.test\.ts", path) is not None)


def git_tree(root, source, runner):
    rows = runner(["git", "ls-tree", "-r", "-z", source, "--"], root)
    require(isinstance(rows, str) and rows.endswith("\0"), "Incomplete immutable Git inventory")
    entries = {}
    for row in rows[:-1].split("\0"):
        match = re.fullmatch(r"(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)", row)
        require(match is not None, "Malformed immutable Git inventory")
        mode, kind, obj, path = match.groups(); cohort.safe_path(path)
        require(not re.search(r"[\u2028-\u202e\u2066-\u2069]", path), "Git inventory contains an ambiguous display/control path")
        require(path not in entries and (kind == "commit") == (mode == "160000"), "Ambiguous immutable Git inventory")
        entries[path] = (mode, kind, obj)
    require(1 <= len(entries) <= cohort.MAX_FILES, "Invalid immutable Git inventory size")
    return entries


def compatibility(root, previous, source, report, runner):
    """Full equality outside the narrow advisory allowlist is an independent gate."""
    require(Path(runner(["git", "rev-parse", "--show-toplevel"], root)) == root, "Use the exact immutable working-tree root")
    common = Path(os.path.abspath(root / runner(["git", "rev-parse", "--git-common-dir"], root)))
    require(common.resolve(strict=True) == common and not (common / "info/grafts").exists() and not (common / "info/grafts").is_symlink(), "Local ancestry grafts or Git metadata aliases refuse compatibility")
    for revision in (previous["engineSource"], previous["shellSource"], source):
        require(runner(["git", "cat-file", "-t", revision], root) == "commit", "Source must be an immutable commit")
    runner(["git", "merge-base", "--is-ancestor", previous["engineSource"], source], root)
    runner(["git", "merge-base", "--is-ancestor", previous["shellSource"], source], root)
    inventories = {revision: git_tree(root, revision, runner) for revision in {previous["engineSource"], previous["shellSource"], source}}
    base, candidate = inventories[previous["shellSource"]], inventories[source]
    engine = inventories[previous["engineSource"]]
    protected = {p: entry for p, entry in engine.items() if not allowed_source(p)}
    require(protected and all({p: entry for p, entry in inventory.items() if not allowed_source(p)} == protected for inventory in inventories.values()), "Non-shell Git tree differs from the accepted engine/pack/runtime source")
    changes = []
    zero = "0" * 40
    for path in sorted(set(base) | set(candidate), key=lambda p: p.encode()):
        old, new = base.get(path), candidate.get(path)
        if old == new:
            continue
        require(allowed_source(path) and all(entry is None or entry[0] in {"100644", "100755"} for entry in (old, new)), "Unknown or non-regular shell source change")
        old_mode, new_mode = old[0] if old else "000000", new[0] if new else "000000"
        status = "A" if old is None else "D" if new is None else "T" if old[1] != new[1] or old[0][:3] != new[0][:3] else "M"
        changes.append({"path": path, "beforeMode": old_mode, "afterMode": new_mode, "beforeObject": old[2] if old else zero, "afterObject": new[2] if new else zero, "status": status})
    exact(report, CLASSIFICATION_KEYS)
    require(len(changes) <= 4096 and len(cohort.canonical(changes)) <= 2 * 1024 * 1024, "Changed paths exceed the maintained advisory classifier's bound")
    # Match the maintained classifier's JSON.stringify byte hash, independent of
    # Python canonical key sorting. The report remains advisory, never authority.
    change_sha = hashlib.sha256(json.dumps(changes, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    require(not changes or any(change["path"].startswith("shells/web/") and not change["path"].endswith((".test.ts", ".md")) for change in changes), "Tests alone do not classify as a shell release")
    require(type(report["version"]) is int and report["version"] == 1 and report["rulesVersion"] == "application-release-classification-1" and report["repository"] == "lolly"
            and report["base"] == previous["shellSource"] and report["candidate"] == source and report["baseTree"] == runner(["git", "rev-parse", previous["shellSource"] + "^{tree}"], root)
            and report["candidateTree"] == runner(["git", "rev-parse", source + "^{tree}"], root) and report["changedPaths"] == changes and report["changedPathsSha256"] == change_sha
            and report["classification"] == ("web-shell-only" if changes else "no-change") and report["advisory"] is True and report["normalCiRequired"] is True
            and report["privateCompatibilityReviewRequired"] is True and report["artifactReuseAuthorized"] is False and report["promotionAuthorized"] is False,
            "Maintained advisory classification differs from independent immutable tree verification")
    require(isinstance(report["reasons"], list) and 1 <= len(report["reasons"]) <= 8 and all(isinstance(x, str) and 0 < len(x) <= 1024 for x in report["reasons"]), "Malformed advisory reasons")
    return {"status": "NON_SHELL_GIT_TREES_EQUAL_TO_ACCEPTED_ENGINE_SOURCE", "engineSource": previous["engineSource"], "previousShellSource": previous["shellSource"],
            "shellSource": source, "protectedEntries": len(protected), "protectedTreeSha256": cohort.digest(protected), "changedPathsSha256": change_sha,
            "classifierAdvisoryOnly": True, "fullTreeEqualityRequired": True}


def original_acceptance(value, previous, before):
    """Validate genuine custodied proof fields, not just an operator success label.

    This does not authenticate origin. Existing production receipts use `source`
    for a matched shell+engine release. Portable later shell receipts explicitly
    separate their two immutable source identities in the original proof.
    """
    require(isinstance(value, dict), "Original acceptance must be parsed proof JSON")
    if value.get("status") == "MATCHED_PRIVATE_RUNTIME_AND_HTTPS_ACCEPTED":
        require(value.get("source") == previous["shellSource"] == previous["engineSource"], "Original matched acceptance source differs")
    else:
        require(value.get("status") == "PRIVATE_SHELL_RUNTIME_AND_HTTPS_ACCEPTED" and value.get("shellSource") == previous["shellSource"] and value.get("engineSource") == previous["engineSource"], "Unknown or unmatched original shell acceptance")
        require(value.get("shellManifestSha256") == previous["shell"]["manifestSha256"] and value.get("packManifestSha256") == previous["pack"]["manifestSha256"]
                and value.get("resolverPinSha256") == previous["resolverPin"]["sha256"], "Original shell acceptance manifest/resolver custody differs")
    require(value.get("workSource") == previous["workSource"] and value.get("image") == value.get("imageId") == previous["image"] and value.get("deploymentUid") == before["metadata"]["uid"]
            and value.get("deploymentSpecSha256") == previous["deploymentSpecSha256"] and value.get("namespace") == before["metadata"]["namespace"] and value.get("deploymentName") == before["metadata"]["name"], "Original runtime owner/image/spec binding differs")
    for family, field in (("shell", "shellClaim"), ("pack", "packClaim"), ("pin", "pinConfigMap")):
        require(value.get(field) == previous[family]["name"] and value.get(field + "Uid") == previous[family]["uid"], "Original runtime mounted resource differs")
    require(isinstance(value.get("podUid"), str) and value["podUid"] and isinstance(value.get("replicaSetUid"), str) and value["replicaSetUid"] and value.get("fullStatic", {}).get("verified") is True,
            "Original owning runtime/full static verification missing")
    cohort.sha(value.get("podSpecSha256"))
    runtime = value.get("runtimeAndCatalog", {})
    require(runtime.get("pinSha256") == previous["pin"]["sha256"] and runtime.get("vendorContentMatches") is True and runtime.get("signedFileMapMatchesQualifiedOracle") is True
            and runtime.get("filteredCatalogSignatureVerified") is True and runtime.get("publicPinMatches") is True and runtime.get("automaticMigration") is False
            and type(runtime.get("packFilesEqual")) is int and runtime["packFilesEqual"] > 0 and type(runtime.get("signedToolFilesEqual")) is int and runtime["signedToolFilesEqual"] > 0,
            "Original engine/pack/signed-catalog qualification missing")
    probes = value.get("https")
    require(isinstance(probes, list) and 1 <= len(probes) <= 100 and all(isinstance(p, dict) and p.get("status") == 200 and p.get("verifiedTlsAndHostname") is True for p in probes), "Original normal TLS acceptance missing")
    for probe in probes:
        cohort.safe_path(probe.get("path")); cohort.sha(probe.get("sha256"))
    require(value.get("tls", {}).get("certificateRequired") is True and value["tls"].get("hostnameVerified") is True, "Original TLS verification policy missing")


def accepted_manifest_custody(original, refs, previous, inputs):
    """Read the current historical receipt's cryptographic original input chain.

    The matched runtime receipt predates direct manifest fields. Its input SHA
    binds the acceptance input, which binds the publisher input, which binds the
    maintained cohort. This retains genuine original files instead of assigning
    success/manifest values in a synthetic normalization wrapper.
    """
    if original["status"] != "MATCHED_PRIVATE_RUNTIME_AND_HTTPS_ACCEPTED":
        return
    checksum = cohort.sha(original.get("inputSha256"))
    matching = [ref for ref in refs if ref.get("sha256") == checksum]
    require(len(matching) == 1, "Original matched acceptance input must be held by its exact SHA256")
    accepted_input = inputs.file(matching[0])
    require(isinstance(accepted_input, dict) and accepted_input.get("source") == previous["engineSource"] and accepted_input.get("workSource") == previous["workSource"], "Original acceptance input source differs")
    def linked(ref):
        exact(ref, {"path", "sha256"}, {"bytes"})
        result = inputs.file({key: ref[key] for key in ("path", "sha256")})
        if "bytes" in ref:
            require(type(ref["bytes"]) is int and ref["bytes"] == cohort.local_path(ref["path"], inputs.base).stat().st_size, "Original linked input length differs")
        return result
    published_input = linked(accepted_input.get("refs", {}).get("publisherInput"))
    accepted_cohort = linked(published_input.get("refs", {}).get("cohort"))
    require(accepted_cohort.get("version") == 1 and type(accepted_cohort["version"]) is int and accepted_cohort.get("status") == cohort.STATUS
            and accepted_cohort.get("sources", {}).get("lolly") == previous["engineSource"] and accepted_cohort["sources"].get("work") == previous["workSource"] and accepted_cohort.get("image") == previous["image"]
            and accepted_cohort.get("enginePinSha256") == previous["enginePin"]["sha256"] and accepted_cohort.get("resolverPinSha256") == previous["resolverPin"]["sha256"]
            and accepted_cohort.get("shell", {}).get("manifestSha256") == previous["shell"]["manifestSha256"] and accepted_cohort.get("rawPack", {}).get("manifestSha256") == previous["pack"]["manifestSha256"], "Genuine accepted cohort full manifest/image/pin custody differs")


def previous_record(ref, inputs):
    previous = inputs.file(ref); exact(previous, PREVIOUS_KEYS)
    require(type(previous["version"]) is int and previous["version"] == 1, "Unknown accepted shell cohort")
    for key in ("shellSource", "engineSource", "workSource"):
        cohort.commit(previous[key])
    cohort.paired.updater.image_ref(previous["image"])
    before = inputs.file(previous["deployment"])
    exact(before, {"apiVersion", "kind", "metadata", "spec"})
    exact(before["metadata"], {"name", "namespace", "uid", "resourceVersion"})
    require(before["apiVersion"] == "apps/v1" and before["kind"] == "Deployment" and cohort.digest(before["spec"]) == cohort.sha(previous["deploymentSpecSha256"]), "Accepted Deployment spec differs")
    for key in ("name", "namespace"):
        require(isinstance(before["metadata"][key], str) and cohort.NAME.fullmatch(before["metadata"][key]), "Invalid accepted Deployment name")
    require(all(isinstance(before["metadata"][key], str) and 0 < len(before["metadata"][key]) <= 128 for key in ("uid", "resourceVersion")), "Missing accepted Deployment guards")
    for family in ("shell", "pack", "pin"):
        exact(previous[family], {"name", "uid"} | ({"manifestSha256", "releaseId"} if family == "shell" else {"manifestSha256"} if family == "pack" else {"sha256"}))
        require(isinstance(previous[family]["name"], str) and cohort.NAME.fullmatch(previous[family]["name"]) and isinstance(previous[family]["uid"], str) and previous[family]["uid"], "Missing accepted resource identity")
        cohort.sha(previous[family]["sha256" if family == "pin" else "manifestSha256"])
    require(previous["pin"]["sha256"] == previous["enginePin"]["sha256"], "Accepted immutable engine pin differs")
    acceptance = cohort.receipt(previous["acceptance"], {"version", "status", "deploymentUID", "deploymentSpecSha256", "shellSource", "engineSource", "workSource", "image", "enginePinSha256", "resolverPinSha256", "shellManifestSha256", "packManifestSha256", "originalEvidence"}, inputs)
    require(acceptance["status"] == "RUNTIME_ACCEPTED" and acceptance["deploymentUID"] == before["metadata"]["uid"] and acceptance["deploymentSpecSha256"] == previous["deploymentSpecSha256"]
            and all(acceptance[k] == previous[k] for k in ("shellSource", "engineSource", "workSource", "image"))
            and acceptance["enginePinSha256"] == previous["enginePin"]["sha256"] and acceptance["resolverPinSha256"] == previous["resolverPin"]["sha256"]
            and acceptance["shellManifestSha256"] == previous["shell"]["manifestSha256"] and acceptance["packManifestSha256"] == previous["pack"]["manifestSha256"], "Actual previous acceptance custody differs")
    require(isinstance(acceptance["originalEvidence"], list) and 2 <= len(acceptance["originalEvidence"]) <= 16, "Missing accepted runtime/HTTPS evidence")
    original = inputs.file(acceptance["originalEvidence"][0])
    original_acceptance(original, previous, before)
    accepted_manifest_custody(original, acceptance["originalEvidence"], previous, inputs)
    for item in acceptance["originalEvidence"]:
        inputs.file(item, False)
    return previous, before


def change_tuple(before, previous, selection, source, release):
    exact(selection, {"container", "shellVolume", "packVolume", "pinVolume", "shellClaim"})
    for value in selection.values():
        require(isinstance(value, str) and cohort.NAME.fullmatch(value), "Invalid shell selection")
    require(selection["shellClaim"] not in {previous["shell"]["name"], previous["pack"]["name"]} and len({selection[k] for k in ("shellVolume", "packVolume", "pinVolume")}) == 3, "New shell claim must be isolated")
    spec = copy.deepcopy(before["spec"]); pod = spec.get("template", {}).get("spec", {})
    require(type(spec.get("replicas", 1)) is int and spec.get("replicas", 1) == 1 and spec.get("strategy", {}).get("type") == "Recreate", "Shell update needs single-owner Recreate storage")
    for family in ("containers", "initContainers", "volumes"):
        items = pod.get(family, [])
        require(isinstance(items, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in items) and len({v["name"] for v in items}) == len(items), "Duplicate or invalid serving resources")
    servers = [c for c in pod.get("containers", []) if c["name"] == selection["container"]]
    require(len(servers) == 1 and servers[0].get("image") == previous["image"], "Accepted image must stay unchanged")
    server = servers[0]; selected = {selection[k] for k in ("shellVolume", "packVolume", "pinVolume")}; shell_index = None
    for family in ("shell", "pack", "pin"):
        name = selection[family + "Volume"]
        volumes = [(i, v) for i, v in enumerate(pod.get("volumes", [])) if v["name"] == name]
        field, leaf = ("configMap", "name") if family == "pin" else ("persistentVolumeClaim", "claimName")
        require(len(volumes) == 1 and set(volumes[0][1]) == {"name", field} and volumes[0][1][field].get(leaf) == previous[family]["name"], "Accepted mounted content tuple differs")
        mounts = [m for m in server.get("volumeMounts", []) if m.get("name") == name]
        require(len(mounts) == 1 and mounts[0].get("readOnly") is True, "Serving shell/pack/pin must remain read-only")
        if family == "shell":
            shell_index = volumes[0][0]
    for container in [*pod["containers"], *pod.get("initContainers", [])]:
        if container is not server:
            require(not any(m.get("name") in selected for m in container.get("volumeMounts", [])), "Another serving container owns selected content")
    annotations = spec.get("template", {}).get("metadata", {}).get("annotations", {})
    require(annotations.get("lolly.tools/engine-source") == previous["engineSource"] and annotations.get("lolly.tools/shell-source") == previous["shellSource"], "Accepted engine/shell provenance differs")
    edits = [(f"/spec/template/spec/volumes/{shell_index}/persistentVolumeClaim/claimName", selection["shellClaim"]), ("/spec/template/metadata/annotations/lolly.tools~1shell-source", source)]
    require(isinstance(release, str) and re.fullmatch(r"release-[a-f0-9]{16}", release), "Invalid shell release ID")
    if "lolly.tools/shell-release" in annotations:
        require(annotations["lolly.tools/shell-release"] == previous["shell"]["releaseId"], "Accepted release provenance differs")
        edits.append(("/spec/template/metadata/annotations/lolly.tools~1shell-release", release))
    patch = [{"op": "test", "path": "/metadata/uid", "value": before["metadata"]["uid"]}, {"op": "test", "path": "/metadata/resourceVersion", "value": before["metadata"]["resourceVersion"]}, {"op": "test", "path": "/spec", "value": before["spec"]}]
    fields = []
    for path, new in edits:
        target = spec
        keys = [k.replace("~1", "/").replace("~0", "~") for k in path.split("/")[2:]]
        for key in keys[:-1]:
            target = target[int(key)] if isinstance(target, list) else target[key]
        key = keys[-1]; old = copy.deepcopy(target[key])
        patch += [{"op": "test", "path": path, "value": old}, {"op": "replace", "path": path, "value": new}]
        fields.append({"path": path, "expectedValue": new, "restoreValue": old}); target[key] = new
    restored = copy.deepcopy(spec)
    for field in fields:
        target = restored; keys = [k.replace("~1", "/").replace("~0", "~") for k in field["path"].split("/")[2:]]
        for key in keys[:-1]:
            target = target[int(key)] if isinstance(target, list) else target[key]
        target[keys[-1]] = field["restoreValue"]
    require(restored == before["spec"], "Unselected Deployment field changed")
    return spec, patch, {"status": "FRESH_AFTER_CAPTURE_AND_DATA_COMPATIBILITY_REQUIRED_NOT_EXECUTABLE", "fields": fields}


def prepare(value, base, expected_public_pin, node="node", runner=git_command):
    exact(value, EVIDENCE_KEYS); require(type(value["version"]) is int and value["version"] == 1, "Unknown shell evidence")
    inputs = cohort.Inputs(base)
    root, lolly_run = cohort.source_record(value["lolly"], inputs, runner, "lolly")
    work_root, work_run = cohort.source_record(value["work"], inputs, runner, "work")
    previous, before = previous_record(value["previous"], inputs)
    require(value["work"]["source"] == previous["workSource"] and value["enginePin"]["sha256"] == previous["enginePin"]["sha256"] and value["resolverPin"]["sha256"] == previous["resolverPin"]["sha256"], "Accepted Work or compatibility pins changed")
    pin, resolver = inputs.file(value["enginePin"]), inputs.file(value["resolverPin"])
    require(cohort.git_bytes(work_root, previous["workSource"], "engine-pin.json", runner) == cohort.read_file(cohort.local_path(value["enginePin"]["path"], base))[0]
            and cohort.git_bytes(work_root, previous["workSource"], "content-resolver-pin.json", runner) == cohort.read_file(cohort.local_path(value["resolverPin"]["path"], base))[0], "Pin bytes differ from unchanged Work source")
    cohort.source_pins(pin, resolver, {**value["lolly"], "source": previous["engineSource"]}, value["work"], runner)
    actual_compatibility = compatibility(root, previous, value["lolly"]["source"], inputs.file(value["classification"]), runner)
    exact(value["brand"], {"path", "commit"}); brand_path = cohort.safe_path(value["brand"]["path"]); brand = cohort.commit(value["brand"]["commit"])
    require(brand_path.startswith("brands/") and runner(["git", "ls-tree", value["lolly"]["source"], "--", brand_path], root).strip().split() == ["160000", "commit", brand, brand_path], "Unchanged private brand differs")
    require(isinstance(value["profile"], str) and cohort.NAME.fullmatch(value["profile"]) and value["profile"] not in {"community", "neutral", "public"}, "Private profile required")
    candidate, old, shell, raw = [cohort.Tree(value[key], inputs) for key in ("candidateShell", "previousShell", "shell", "rawPack")]
    roots = [tree.root for tree in inputs.trees]
    require(len(set(roots)) == 4 and all(a not in b.parents for a in roots for b in roots if a != b), "Distinct complete trees required")
    require(old.manifest_sha == previous["shell"]["manifestSha256"] and old.shell_id == previous["shell"]["releaseId"] and raw.manifest_sha == previous["pack"]["manifestSha256"], "Accepted shell/raw-pack snapshot differs")
    cohort.retention(candidate, old, shell)
    def generated(path):
        return path.startswith("_app/") or path in {"index.html", "precache.json", "sw.js", "portable/player.js"}
    require({p: entry for p, entry in old.files.items() if not generated(p)} == {p: entry for p, entry in candidate.files.items() if not generated(p)}, "Static assets/catalog/dependencies changed in shell-only output")
    public_pin = inputs.file(value["publicPin"])
    actual_catalog = cohort.catalog(shell, raw, public_pin, cohort.sha(expected_public_pin), node)
    require(cohort.catalog(old, raw, public_pin, cohort.sha(expected_public_pin), node) == actual_catalog, "Accepted signed catalog changed")
    accepted_proof = inputs.file(inputs.file(previous["acceptance"])["originalEvidence"][0])
    require(accepted_proof["fullStatic"].get("files") == len(old.files) and accepted_proof["runtimeAndCatalog"].get("packFilesEqual") == len(raw.files)
            and accepted_proof["runtimeAndCatalog"].get("signedToolFilesEqual") == actual_catalog["signedFiles"] and accepted_proof["runtimeAndCatalog"].get("engine") == pin["engine"]["version"]
            and accepted_proof["runtimeAndCatalog"].get("core") == pin["core"]["version"], "Original accepted full-content count or engine ABI differs")
    stamp = cohort.parse_json(raw.data(".lolly-pack-source.json"))
    exact(stamp, {"version", "source", "commit", "profile", "dirty", "excluded", "removed", "builtAt"})
    require(type(stamp["version"]) is int and stamp["version"] == 1 and stamp["source"] == "lolly" and stamp["commit"] == previous["engineSource"] and stamp["profile"] == value["profile"] and stamp["dirty"] is False
            and stamp["removed"] == ["catalog/tools/index.sig.json"] and stamp["excluded"] == ["catalog/og", "catalog/previews"], "Unchanged raw-pack source stamp differs")
    build = cohort.receipt(value["build"], {"version", "status", "lollySource", "engineSource", "workSource", "brandCommit", "profile", "enginePinSha256", "shellManifestSha256", "settings", "workspaceModules", "originalReport"}, inputs)
    require(build["status"] == "PRIVATE_WEB_BUILD_REVIEWED" and build["lollySource"] == value["lolly"]["source"] and build["engineSource"] == previous["engineSource"] and build["workSource"] == previous["workSource"] and build["brandCommit"] == brand
            and build["profile"] == value["profile"] and build["enginePinSha256"] == value["enginePin"]["sha256"] and build["shellManifestSha256"] == candidate.manifest_sha, "Reviewed build source/manifest custody differs")
    exact(build["settings"], {"scope", "requireCatalogSignature", "requireAiPolicy", "relayOrigin"})
    require(build["settings"]["scope"] == "web" and build["settings"]["requireCatalogSignature"] is True and build["settings"]["requireAiPolicy"] is True and isinstance(build["settings"]["relayOrigin"], str)
            and re.fullmatch(r"https://[a-z0-9.-]+(?::[0-9]{1,5})?/live", build["settings"]["relayOrigin"]), "Verified private build policy differs")
    require(isinstance(build["workspaceModules"], list) and 1 <= len(build["workspaceModules"]) <= 5000, "Missing compiled module custody")
    modules = set()
    for module in build["workspaceModules"]:
        exact(module, {"path", "sha256"}); path = cohort.safe_path(module["path"])
        require(path not in modules and path.startswith(("engine/", "packages/core/", "packages/node-shell/", "packages/rondo/", "packages/audio-dock/"))
                and hashlib.sha256(cohort.git_bytes(root, value["lolly"]["source"], path, runner)).hexdigest() == cohort.sha(module["sha256"]), "Compiled workspace module differs")
        modules.add(path)
    inputs.file(build["originalReport"], False)
    gate = cohort.receipt(value["webGate"], {"version", "status", "source", "scope", "scriptSha256", "originalReport"}, inputs)
    require(gate["status"] == "PASS" and gate["source"] == value["lolly"]["source"] and gate["scope"] == "web" and gate["scriptSha256"] == hashlib.sha256(cohort.git_bytes(root, value["lolly"]["source"], "scripts/webgpu-release-gate.ts", runner)).hexdigest(), "Explicit web qualification custody differs")
    inputs.file(gate["originalReport"], False)
    desired, patch, rollback = change_tuple(before, previous, value["selection"], value["lolly"]["source"], shell.shell_id)
    inputs.unchanged()
    return {"version": 1, "status": STATUS, "sources": {"lolly": value["lolly"]["source"], "engine": previous["engineSource"], "work": previous["workSource"], "brand": brand},
            "normalCI": {"lolly": {"run": lolly_run["id"], "attempt": lolly_run["run_attempt"]}, "work": {"run": work_run["id"], "attempt": work_run["run_attempt"]}},
            "image": previous["image"], "profile": value["profile"], "enginePinSha256": value["enginePin"]["sha256"], "resolverPinSha256": value["resolverPin"]["sha256"],
            "shell": {"manifestSha256": shell.manifest_sha, "releaseId": shell.shell_id, "files": len(shell.files)}, "rawPack": {"manifestSha256": raw.manifest_sha, "files": len(raw.files)},
            "catalog": actual_catalog, "previousCohortSha256": value["previous"]["sha256"], "beforeSpecSha256": previous["deploymentSpecSha256"], "desiredSpecSha256": cohort.digest(desired),
            "desiredSpec": desired, "guardedPatchTemplate": patch, "rollbackIntent": rollback, "compatibility": actual_compatibility, "selection": value["selection"], "allUnselectedSpecFieldsPreserved": True,
            "evidence": [{"path": str(path), "sha256": expected} for path, (_, expected) in sorted(inputs.reads.items())], "qualificationBoundary": BOUNDARY,
            "requiredBeforeApply": ["Fresh target, owning Deployment UID/RV and complete spec plus retained immutable pin/pack bytes", "New isolated shell PVC with complete hashes; stage uses a temporary isolated pack PVC copy, never the active PVC", "Exact unchanged image isolated runtime and writer/qualifier retirement/unmount custody", "Reviewed guarded server dry run, serialized atomic shell-only patch and fresh data-preserving rollback intent", "Owning runtime/TLS/export/agent/reconnect acceptance; retain native qualification holds"]}, inputs


def publish(value, out, inputs):
    # Reuse the maintained protected publication algorithm without changing v1.
    checksum = cohort.publish(value, out, inputs)
    # The only complete file has an explicitly distinct lane name. No existing
    # path is replaced, and the protected directory remains owned by this call.
    ownership = cohort.stamp(out.lstat())[:2]
    require(cohort.read_file(out / "cohort.prepared.json", cohort.JSON_LIMIT * 2)[0] == cohort.canonical(value) + b"\n", "Protected prepared output changed")
    inputs.unchanged(); require(cohort.stamp(out.lstat())[:2] == ownership, "Prepared directory ownership changed")
    os.link(out / "cohort.prepared.json", out / "shell.prepared.json", follow_symlinks=False)
    (out / "cohort.prepared.json").unlink()
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True); parser.add_argument("--reviewed-evidence-sha256", required=True)
    parser.add_argument("--existing-public-pin-sha256", required=True); parser.add_argument("--out-dir", required=True); parser.add_argument("--node", default="node")
    args = parser.parse_args()
    path = cohort.local_path(args.evidence, Path.cwd()); data, identity = cohort.read_file(path)
    require(hashlib.sha256(data).hexdigest() == cohort.sha(args.reviewed_evidence_sha256), "Reviewed evidence bytes differ")
    result, inputs = prepare(cohort.parse_json(data), path.parent, cohort.sha(args.existing_public_pin_sha256), args.node)
    inputs.reads[path] = (identity, args.reviewed_evidence_sha256)
    result["evidence"].append({"path": str(path), "sha256": args.reviewed_evidence_sha256}); result["evidence"].sort(key=lambda ref: ref["path"])
    result["reviewedEvidenceSha256"] = args.reviewed_evidence_sha256
    checksum = publish(result, Path(os.path.abspath(args.out_dir)), inputs)
    print(json.dumps({"status": STATUS, "preparedSha256": checksum, "productionMutation": False}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("REFUSED: shell-only custody, immutable compatibility or protected change differs; retain any partial output", file=sys.stderr)
        raise SystemExit(1)
