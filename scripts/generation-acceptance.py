# SPDX-License-Identifier: MPL-2.0
"""Offline parsing of original generation-cohort custody. Never executes receipts.

A serving/owner/content acceptance is sufficient to retain an existing runtime
for a shell update. It is not full user acceptance: those outstanding checks and
all original statuses remain in the original evidence, unchanged.
"""
import copy
import importlib.util
import hashlib
import re
from pathlib import Path
from urllib.parse import urlsplit

STATUS = "PRIVATE_GENERATION_COHORT_OWNER_CONTENT_AUTHENTICATED_TLS_VERIFIED_FULL_ACCEPTANCE_PENDING"


def validate(previous, inputs, shell):
    c = shell.cohort
    need, exact = c.require, c.exact
    exact(previous, (shell.PREVIOUS_KEYS - {"shellSource", "engineSource", "resolverPin"}) | {"lollySource"})
    need(type(previous["version"]) is int and previous["version"] == 1, "Unknown generation cohort version")
    for key in ("lollySource", "workSource"):
        c.commit(previous[key])
    c.paired.updater.image_ref(previous["image"])
    before = inputs.file(previous["deployment"])
    exact(before, {"apiVersion", "kind", "metadata", "spec"})
    exact(before["metadata"], {"name", "namespace", "uid", "resourceVersion"})
    need(before["apiVersion"] == "apps/v1" and before["kind"] == "Deployment" and c.digest(before["spec"]) == c.sha(previous["deploymentSpecSha256"]), "Generation Deployment spec differs")
    for key in ("name", "namespace"):
        need(type(before["metadata"][key]) is str and c.NAME.fullmatch(before["metadata"][key]), "Invalid generation Deployment name")
    for key in ("uid", "resourceVersion"):
        need(type(before["metadata"][key]) is str and 0 < len(before["metadata"][key]) <= 128, "Missing generation Deployment guard")
    acceptance = inputs.file(previous["acceptance"])
    exact(acceptance, {"version", "status", "deploymentUID", "deploymentSpecSha256", "lollySource", "workSource", "image", "enginePinSha256", "shellManifestSha256", "packManifestSha256", "originalEvidence"})
    need(type(acceptance["version"]) is int and acceptance["version"] == 1 and acceptance["status"] == "RUNTIME_ACCEPTED"
         and acceptance["deploymentUID"] == before["metadata"]["uid"] and all(acceptance[k] == previous[k] for k in ("deploymentSpecSha256", "lollySource", "workSource", "image")), "Generation runtime wrapper tuple differs")
    refs = acceptance["originalEvidence"]
    need(type(refs) is list and len(refs) == 3, "Generation acceptance requires original owner/TLS/runtime custody")
    original = inputs.file(refs[0])
    exact(original, {"version", "status", "sources", "image", "observedImageId", "publicationGeneration", "configReference", "enginePinSha256", "resolverPinSha256", "shellManifestSha256", "packManifestSha256", "deploymentUID", "deploymentSpecSha256", "podUID", "originalEvidence", "authenticatedCatalogProof", "ociImageSignatureClaimed", "runtimeAcceptanceComplete", "qualificationScope", "remainingAcceptance"})
    need(type(original["version"]) is int and original["version"] == 1 and original["status"] == STATUS
         and original["runtimeAcceptanceComplete"] is False and original["ociImageSignatureClaimed"] is False
         and original["qualificationScope"] == "REAL_NEW_IMAGE_PINS_SOURCE_NATIVE_STAGE_AND_OWNING_FULL_BYTES_GENERATION_PG_READINESS_NORMAL_TLS"
         and type(original["remainingAcceptance"]) is list and 1 <= len(original["remainingAcceptance"]) <= 16
         and all(type(v) is str and 0 < len(v) <= 2048 for v in original["remainingAcceptance"]), "Generation serving acceptance scope differs")
    sources = original["sources"]
    exact(sources, {"lolly", "work", "brand"})
    for value in sources.values(): c.commit(value)
    need(sources["lolly"] == previous["lollySource"] and sources["work"] == previous["workSource"]
         and original["image"] == original["observedImageId"] == previous["image"]
         and original["deploymentUID"] == acceptance["deploymentUID"] and original["deploymentSpecSha256"] == previous["deploymentSpecSha256"], "Generation original source/image/owner differs")
    originals = original["originalEvidence"]
    need(type(originals) is list and 6 <= len(originals) <= 32, "Generation original custody missing")
    for ref in originals: inputs.file(ref, False)  # Sources are opaque bytes, not JSON or executable authority.
    owner, content, tls, runtime = [inputs.file(ref) for ref in originals[:4]]
    need(refs[1:] == originals[2:4], "Generation wrapper changes original TLS/runtime custody")
    proof = original["authenticatedCatalogProof"]
    exact(proof, {"source", "input", "publicationInput", "context", "command", "report", "anonymousGates", "profile"})
    inputs.file(proof["source"], False)
    auth_input, publication, context, command, report, gates = [inputs.file(proof[k]) for k in ("input", "publicationInput", "context", "command", "report", "anonymousGates")]
    need(proof["profile"] == shell.AUTH_PROFILE and tls.get("authenticatedCatalogProof") == proof, "Generation authenticated proof differs")
    for value in (publication, auth_input):
        closure = value.get("sourceFiles")
        need(type(closure) is list and 1 <= len(closure) <= 200, "Generation source custody missing")
        for ref in closure: inputs.file(ref, False)
    need(proof["source"] in auth_input["sourceFiles"], "Generation probe source absent from held source closure")
    invocations = [publication.get("authenticatedStaticProbe")]
    for ref in originals[6:]:
        data = c.read_file(inputs.file(ref, False))[0]
        try:
            value = c.parse_json(data)
        except (ValueError, c.Refusal):
            continue  # A checksum-held source/opaque stream is not a receipt.
        if type(value) is dict and set(value) == {"argv", "source", "input", "profile"}:
            invocations.append(value)
    invocations = [v for v in invocations if type(v) is dict and v.get("source") == proof["source"] and v.get("input") == proof["input"] and v.get("profile") == proof["profile"]]
    need(len(invocations) == 1, "Generation exact original probe invocation missing or ambiguous")
    argv = invocations[0].get("argv")
    source_path, input_path = [str(c.local_path(proof[k]["path"], inputs.base)) for k in ("source", "input")]
    need(type(argv) is list and argv and type(argv[0]) is str and Path(argv[0]).is_absolute() and re.fullmatch(r"python3(?:\.[0-9]+)?", Path(argv[0]).name)
         and argv[1:] in ([source_path, "--input", input_path, "--input-sha256", proof["input"]["sha256"]],
                          ["-B", source_path, "--input", input_path, "--input-sha256", proof["input"]["sha256"]]), "Generation original probe invocation differs")
    plan = inputs.file(publication["refs"]["plan"])
    need(publication.get("version") == 1 and publication.get("status") == "REVIEWED_PRIVATE_GENERATION_COHORT_PUBLICATION_INPUT"
         and plan["sources"] == sources and plan["desiredSpec"] == before["spec"] and plan["desiredSpecSha256"] == previous["deploymentSpecSha256"]
         and plan["deploymentUID"] == original["deploymentUID"] and plan["generationReference"] == original["configReference"], "Generation publication plan differs")
    need(type(context.get("version")) is int and context["version"] == 1 and context.get("status") == "ACTUAL_PRIVATE_SHELL_AUTHENTICATED_CATALOG_CONTEXT", "Generation context protocol differs")
    need(auth_input["refs"]["plan"] == publication["refs"]["plan"] and context["planSha256"] == publication["refs"]["plan"]["sha256"]
         and context["publicationInputSha256"] == proof["publicationInput"]["sha256"] and context["sources"] == sources
         and context["image"] == previous["image"] and context["selection"] == plan["selection"], "Generation authenticated plan/context differs")
    exact(owner, {"deployment", "pod", "replicaSet"})
    deployment, pod, rs = [owner[k] for k in ("deployment", "pod", "replicaSet")]
    need(context["owner"] == owner and context["ownerEvidence"] == originals[0] and context["contentEvidence"] == originals[1]
         and deployment["spec"] == before["spec"] and all(deployment["metadata"].get(k) == v for k,v in before["metadata"].items()) and deployment["metadata"]["uid"] == original["deploymentUID"] and pod["metadata"]["uid"] == original["podUID"], "Generation actual owning resources differ")
    for obj in (deployment, pod, rs):
        need(obj["metadata"].get("namespace") == before["metadata"]["namespace"] and not obj["metadata"].get("deletionTimestamp"), "Generation owner namespace/deletion differs")
    for child, parent, kind in ((pod, rs, "ReplicaSet"), (rs, deployment, "Deployment")):
        owners = [r for r in child["metadata"].get("ownerReferences", []) if r.get("controller") is True]
        need(len(owners) == 1 and all(owners[0].get(k) == v for k,v in {"kind":kind,"uid":parent["metadata"]["uid"],"name":parent["metadata"]["name"]}.items()), "Generation owner chain differs")
    selected = plan["selection"]["container"]
    states = pod["status"].get("containerStatuses", [])
    need(len(states) == 1 and states[0].get("name") == selected, "Generation unique owning process missing")
    state = states[0]
    need(state.get("ready") is True and type(state.get("restartCount")) is int and state["restartCount"] == 0
         and state.get("imageID") == original["observedImageId"] and "running" in state.get("state", {})
         and pod["status"].get("phase") == "Running" and any(x.get("type") == "Ready" and x.get("status") == "True" for x in pod["status"].get("conditions", [])), "Generation owning process not ready at exact manifest")
    for spec in (before["spec"]["template"]["spec"], rs["spec"]["template"]["spec"], pod["spec"]):
        containers = [v for v in spec["containers"] if v["name"] == selected]
        need(len(containers) == 1 and containers[0]["image"] == previous["image"], "Generation template/pod image differs")
    # Admission may add service-account/DNS fields, but these selected mounts
    # must remain exactly the accepted Deployment's mounts in both owners.
    expected_volumes = {v["name"]: v for v in before["spec"]["template"]["spec"]["volumes"]}
    protected_volumes = [plan["selection"][k] for k in ("shellVolume", "packVolume", "pinVolume")] + [original["configReference"]["volume"]]
    accepted_container = next(v for v in before["spec"]["template"]["spec"]["containers"] if v["name"] == selected)
    expected_mounts = [v for v in accepted_container.get("volumeMounts", []) if v["name"] in protected_volumes]
    need(set(v["name"] for v in expected_mounts) == set(protected_volumes), "Generation accepted protected mounts missing")
    protected_paths = {v["mountPath"] for v in expected_mounts}
    for spec in (rs["spec"]["template"]["spec"], pod["spec"]):
        actual_volumes = {v["name"]: v for v in spec["volumes"]}
        need(all(actual_volumes.get(k) == expected_volumes[k] for k in protected_volumes), "Generation owning volumes differ from accepted resources")
        container = next(v for v in spec["containers"] if v["name"] == selected)
        actual_mounts = [v for v in container.get("volumeMounts", []) if v["name"] in protected_volumes or v.get("mountPath") in protected_paths]
        need(actual_mounts == expected_mounts, "Generation protected owning mount paths/subpaths/flags differ")
    generation = original["configReference"]
    need(type(original["publicationGeneration"]) is int and original["publicationGeneration"] > 0
         and generation["generation"] == original["publicationGeneration"] and generation["candidate"]["immutable"] is True, "Generation immutable config reference missing")
    volumes = {v["name"]: v for v in before["spec"]["template"]["spec"]["volumes"]}
    need(volumes[generation["volume"]]["configMap"]["name"] == generation["candidate"]["name"], "Generation Deployment config reference differs")
    need(generation["candidate"] in plan["resourceGuards"], "Generation config identity not guarded")
    need(originals[5] == publication["refs"]["generationPlanningInput"], "Generation planning custody differs")
    planning = inputs.file(originals[5]); config = inputs.file(planning["generationActual"])
    need(config.get("apiVersion") == "v1" and config.get("kind") == "ConfigMap" and config.get("immutable") is True
         and all(config["metadata"].get(k) == generation["candidate"][k] for k in ("name", "namespace", "uid", "resourceVersion"))
         and c.digest(config["data"]) == generation["candidate"]["dataSha256"]
         and hashlib.sha256(config["data"][generation["key"]].encode()).hexdigest() == runtime["configSha256"], "Generation actual config bytes/identity differ")
    selected_volume = list(volumes).index(generation["volume"])
    need(generation["path"] == f"/spec/template/spec/volumes/{selected_volume}/configMap/name", "Generation config JSON path differs")
    exact(content, {"version", "shell", "pack", "pinSha256", "catalog"})
    need(type(content["version"]) is int and content["version"] == 1 and content["pinSha256"] == previous["enginePin"]["sha256"], "Generation mounted content/pin differs")
    for family, resource_kind, selection_key in (("shell", "PersistentVolumeClaim", "shellClaim"), ("pack", "PersistentVolumeClaim", "packClaim"), ("pin", "ConfigMap", "pinConfigMap")):
        resource = previous[family]
        exact(resource, {"name", "uid"} | ({"manifestSha256", "releaseId"} if family == "shell" else {"manifestSha256"} if family == "pack" else {"sha256"}))
        guarded = [v for v in plan["resourceGuards"] if v["kind"] == resource_kind and v["name"] == resource["name"]]
        need(len(guarded) == 1 and guarded[0]["uid"] == resource["uid"] and guarded[0]["namespace"] == before["metadata"]["namespace"] and plan["selection"][selection_key] == resource["name"], "Generation mounted resource identity differs")
        volume = volumes[plan["selection"][family + "Volume"]]
        need(volume["configMap" if family == "pin" else "persistentVolumeClaim"]["name" if family == "pin" else "claimName"] == resource["name"], "Generation mounted resource reference differs")
    for family in ("shell", "pack"):
        ref = context[family + "Manifest"]
        need(ref == publication["refs"][family + "Manifest"] and ref["sha256"] == previous[family]["manifestSha256"] == original[family + "ManifestSha256"] == acceptance[family + "ManifestSha256"]
             and inputs.file(ref) == content[family], "Generation full manifest custody differs")
        manifest = content[family]; exact(manifest, {"version", "files", "totalBytes"})
        need(type(manifest["version"]) is int and manifest["version"] == 1 and type(manifest["files"]) is list and manifest["files"], "Generation complete manifest missing")
        paths, total = set(), 0
        for row in manifest["files"]:
            exact(row, {"path", "size", "sha256"}); c.safe_path(row["path"]); c.sha(row["sha256"])
            need(row["path"] not in paths and type(row["size"]) is int and row["size"] >= 0, "Generation manifest duplicate/size differs")
            paths.add(row["path"]); total += row["size"]
        need(type(manifest["totalBytes"]) is int and manifest["totalBytes"] == total, "Generation manifest total differs")
    prepared = inputs.file(auth_input["prepared"])
    need(auth_input["prepared"]["sha256"] == plan["sourceCohortSha256"] and prepared.get("status") == c.STATUS
         and prepared.get("sources") == sources and prepared.get("image") == previous["image"]
         and prepared.get("enginePinSha256") == original["enginePinSha256"] and prepared.get("resolverPinSha256") == original["resolverPinSha256"]
         and prepared.get("shell", {}).get("manifestSha256") == previous["shell"]["manifestSha256"]
         and prepared.get("rawPack", {}).get("manifestSha256") == previous["pack"]["manifestSha256"], "Generation source qualification tuple differs")
    resolver_ref = context["resolverPin"]
    need(context["enginePin"] == previous["enginePin"] == publication["refs"]["enginePin"] and auth_input["refs"]["enginePin"] == previous["enginePin"]
         and resolver_ref == auth_input["refs"]["resolverPin"] and resolver_ref["sha256"] == original["resolverPinSha256"]
         and previous["pin"]["sha256"] == previous["enginePin"]["sha256"] == original["enginePinSha256"] == acceptance["enginePinSha256"], "Generation immutable pins differ")
    pin = inputs.file(previous["enginePin"]); inputs.file(resolver_ref)
    need(pin["generatedFrom"] == sources["lolly"] and runtime.get("engineVersion") == pin["engine"]["version"] and runtime.get("coreVersion") == pin["core"]["version"], "Generation engine ABI/source differs")
    need(runtime.get("status") == "ACTUAL_PRIVATE_COHORT_SOURCE_PIN_GENERATION_PG_READY_READONLY" and runtime.get("sources") == sources
         and runtime.get("image") == previous["image"] and runtime.get("publicationGeneration") == original["publicationGeneration"]
         and runtime.get("enginePinSha256") == original["enginePinSha256"] and runtime.get("resolverPinSha256") == original["resolverPinSha256"]
         and all(runtime.get(k) is True for k in ("bakedMountedPinEqual", "productionConfigParsed", "schemaMatches", "sourceFilesVerified", "vendorContentMatches"))
         and all(runtime.get(k) is False for k in ("databaseDirectQueries", "fileWrites", "physicalGpuClaimed", "secretValuesPrinted", "serviceSpawned"))
         and type(runtime.get("sourceFiles")) is int and runtime["sourceFiles"] > 0 and runtime.get("storage") == "pg" and runtime.get("readyStatus") == 200
         and runtime.get("uid") == runtime.get("gid") == 1000, "Generation owning runtime source/pin/readiness proof differs")
    validate_tls(original, owner, content, tls, context, command, report, gates, auth_input, inputs, shell)
    # Internal view only. Its original acceptance reference and pending scope
    # remain untouched; no normalized success receipt is written or substituted.
    view = {**previous, "shellSource": previous["lollySource"], "engineSource": previous["lollySource"], "resolverPin": resolver_ref}
    del view["lollySource"]
    return view, before


def validate_tls(original, owner, content, tls, context, command, report, gates, auth_input, inputs, shell):
    c = shell.cohort; need, exact = c.require, c.exact
    proof = original["authenticatedCatalogProof"]
    need(tls.get("profile") == shell.AUTH_PROFILE and tls.get("preparedEnvelopeByteEqualityClaimed") is False
         and tls.get("certificateRequired") is True and tls.get("hostnameVerified") is True, "Generation TLS policy differs")
    probes = tls.get("probes")
    need(type(probes) is list and len(probes) == 3 and probes[1:] == report["probes"], "Generation HTTPS routes differ")
    base = urlsplit(context["baseURL"])
    need(base.scheme == "https" and base.hostname and not base.username and not base.password and not base.query and not base.fragment and base.path == "/", "Generation normal TLS origin missing")
    entry = next((v for v in content["shell"]["files"] if v["path"] == "index.html"), None)
    need(type(probes[0].get("status")) is int and type(probes[0].get("bytes")) is int and probes[0].get("verifiedTlsAndHostname") is True, "Generation entrypoint TLS types differ")
    need(entry is not None and probes[0] == {"path":"index.html","url":context["baseURL"] + "index.html","status":200,"verifiedTlsAndHostname":True,"bytes":entry["size"],"sha256":entry["sha256"]}, "Generation HTTPS entrypoint differs from owning full content")
    need(gates == {"version":1,"probes":tls.get("unauthenticatedGates")} and len(gates["probes"]) == 2, "Generation anonymous gate custody differs")
    for gate, path in zip(gates["probes"], ("catalog/tools/index.json", "catalog/tools/index.sig.json")):
        need(gate.get("url") == context["baseURL"] + path and type(gate.get("status")) is int and gate["status"] == 401
             and gate.get("errorCode") == "UNAUTHORIZED" and gate.get("message") == "this deployment is sign-in gated"
             and gate.get("verifiedTlsAndHostname") is True and gate.get("authentication") == "none"
             and type(gate.get("bytes")) is int and 0 < gate["bytes"] <= 4096, "Generation anonymous catalog gate differs")
        c.sha(gate.get("sha256"))
    exact(command, {"returncode", "stdout", "stderr"})
    need(type(command["returncode"]) is int and command["returncode"] == 0 and command["stderr"] == "" and c.parse_json(command["stdout"].encode()) == report, "Generation command/report original differs")
    need(context["qualifiedCatalog"] == {k:v for k,v in content["catalog"].items() if k not in {"publicPinSha256", "signatureVerified"}}
         and content["catalog"]["signatureVerified"] is True and c.digest(context["publicPin"]) == content["catalog"]["publicPinSha256"], "Generation qualified catalog/P256 pin differs")
    need(report.get("oracle", {}).get("sourceBindingSha256") == auth_input.get("sourceBindingSha256"), "Generation oracle source binding differs")
    core = copy.deepcopy(report)
    extras = set(core) & {"assetCatalog", "bytePolicy", "providerMetadata"}
    need(not extras or extras == {"assetCatalog", "bytePolicy", "providerMetadata"}, "Incomplete generation asset extension")
    if extras:
        asset, policy, metadata = [core.pop(k) for k in ("assetCatalog", "bytePolicy", "providerMetadata")]
        exact(asset, {"path", "url", "status", "verifiedTlsAndHostname", "authentication", "bytes", "sha256", "signedAssetIndexHash", "envelopeSha256", "signatureVerified", "maximumBytes"})
        exact(metadata, {"status", "lollySource", "repositoryPath", "sourceSha256", "strippedSha256", "assetRows", "providerAssets", "providerFormats", "contentFormats", "multiFormatProviderAssets", "invalidFormats", "negativeControls", "providerBytesVerified", "immutableFilesDownloaded", "runtimeQualified", "assetIndexSha256", "signedCatalogScope"})
        need(policy == auth_input["refs"]["bytePolicy"], "Generation asset byte policy differs")
        limits = inputs.file(policy)
        need(limits.get("status") == "MAINTAINED_EA_FRONTEND_BYTE_POLICY_SOURCE_ONLY" and limits.get("productionCalls") is False and limits.get("runtimeQualified") is False
             and limits.get("assetMaximumBytes") == 16 * 1024**2 and limits.get("indexMaximumBytes") == limits.get("envelopeMaximumBytes") == limits.get("slimMaximumBytes") == 2 * 1024**2
             and limits.get("source") == {"commit":original["sources"]["lolly"],"repositoryPath":"shells/web/src/catalog/snapshot.ts","file":auth_input["refs"]["bytePolicySourceEA"]}, "Generation maintained byte limits differ")
        inputs.file(auth_input["refs"]["bytePolicySourceEA"], False)
        need(asset.get("path") == "catalog/assets/index.json" and asset.get("url") == context["baseURL"] + asset["path"]
             and asset.get("status") == 200 and asset.get("verifiedTlsAndHostname") is True and asset.get("signatureVerified") is True
             and asset.get("authentication") == "TEMPORARY_MEMORY_SESSION" and type(asset.get("bytes")) is int and 0 < asset["bytes"] <= 16 * 1024**2
             and asset.get("maximumBytes") == 16 * 1024**2 and asset.get("sha256") == asset.get("signedAssetIndexHash") and asset.get("envelopeSha256") == core["oracle"]["envelopeSha256"], "Generation signed asset report differs")
        c.sha(asset["sha256"])
        need(metadata.get("status") == "EA_DESCRIPTOR_ADMISSION_PASSED" and metadata.get("lollySource") == original["sources"]["lolly"]
             and metadata.get("assetIndexSha256") == asset["sha256"] and metadata.get("signedCatalogScope") is True
             and all(metadata.get(k) is False for k in ("providerBytesVerified", "immutableFilesDownloaded", "runtimeQualified")), "Generation provider metadata scope differs")
        need(metadata.get("repositoryPath") == "shells/web/src/catalog/asset-integrity.ts"
             and metadata.get("sourceSha256") == auth_input["refs"]["classifier"]["sha256"]
             and metadata.get("strippedSha256") == auth_input["refs"]["strippedClassifier"]["sha256"], "Generation provider admission source differs")
        for key in ("classifier", "strippedClassifier"): inputs.file(auth_input["refs"][key], False)
        for key in ("assetRows", "providerAssets", "providerFormats", "contentFormats", "multiFormatProviderAssets", "invalidFormats", "negativeControls"):
            need(type(metadata.get(key)) is int and 0 <= metadata[key] <= 200000, "Generation provider count differs")
        need(metadata["invalidFormats"] == 0 and metadata["negativeControls"] == 8 and 0 < metadata["providerAssets"] <= metadata["assetRows"]
             and metadata["providerFormats"] >= metadata["providerAssets"] and metadata["contentFormats"] > 0 and metadata["multiFormatProviderAssets"] <= metadata["providerAssets"], "Generation provider admission differs")
    spec = importlib.util.spec_from_file_location("generation_catalog_validator", Path(__file__).with_name("publish-private-shell.py"))
    publisher = importlib.util.module_from_spec(spec); spec.loader.exec_module(publisher)
    try: publisher.authenticated_catalog_report(core, context, proof, context["qualifiedCatalog"], context["publicPin"])
    except publisher.Refusal as error: raise shell.Refusal("Generation per-caller catalog oracle differs") from error
