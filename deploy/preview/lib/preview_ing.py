# SPDX-License-Identifier: MPL-2.0
"""lolly.ing rules shared by the Mac and the node (PROPOSAL section 4).

Pure functions only: no network, no cluster, no clock. They decide whether a
private build may go live, which catalog generation it gets, how the live
instance.json changes (the generation and nothing else), what a pending
migration set allows, and which key a build is pinned to.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re

import preview_anchors as A
import preview_layout as L
from preview_common import HEX64, SHA, Refusal, canonical_js_json, compact_digest, require, strict_json
from preview_receipt import jwk_thumbprint, verify_p256, verify_p256_raw

DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
MIGRATION_NAME = re.compile(r"[0-9]{4}_[a-z0-9_]{1,80}\.sql\Z")
KEY_ID = re.compile(r"[A-Za-z0-9_-]{43}\Z")
CLASSES = ("additive", "maintenance")


# Keys (PROPOSAL 4.7) ----------------------------------------------------------
def ing_pin():
    """The lolly.ing catalog pin, or a refusal until a reviewed change pins it."""
    jwk = A.ING_PUBLIC_KEY_JWK
    require(isinstance(jwk, dict) and set(jwk) == {"kty", "crv", "x", "y"}, "ING_KEY_NOT_PINNED",
            "lolly.ing's own catalog key is not pinned in the tool yet (PROPOSAL 4.7); nothing was changed")
    thumbprint = jwk_thumbprint(jwk)
    require(thumbprint != A.RELEASE_PUBLIC_KEY_THUMBPRINT and thumbprint != jwk_thumbprint(A.RELEASE_PUBLIC_KEY_JWK),
            "RELEASE_KEY", "the lolly.ing pin is the platform release key; lolly.ing needs its own key")
    return jwk, thumbprint


def refuse_release_key(key_id, what):
    """Refuse any build or pod that names the platform release key (R20 S1, R22 S1)."""
    require(key_id != A.RELEASE_PUBLIC_KEY_THUMBPRINT, "RELEASE_KEY",
            f"{what} names the platform release key {A.RELEASE_PUBLIC_KEY_THUMBPRINT[:8]}...; lolly.ing must use its own key")


def boot_key_id(log_text):
    """The keyId from Work's boot line `catalog signing on (keyId ...)`; None when signing is off or absent."""
    found = re.findall(r"catalog signing on \(keyId ([A-Za-z0-9_-]{43})\)", log_text or "")
    require(len(set(found)) <= 1, "BOOT_LOG", "the boot log names more than one catalog signing key")
    return found[0] if found else None


# Manifest (the suse-lolly lolly-ing-preview.yml run's output) -------------------
def _digest_list(values):
    return isinstance(values, list) and 0 < len(values) <= 256 and all(isinstance(v, str) and DIGEST.fullmatch(v) for v in values)


def validate_migrations(items, label="migrations"):
    require(isinstance(items, list) and len(items) <= 2000, "MANIFEST_INVALID", f"{label} is not a list")
    seen = set()
    for item in items:
        require(isinstance(item, dict) and set(item) == {"name", "sha256", "class"} and isinstance(item["name"], str)
                and MIGRATION_NAME.fullmatch(item["name"]) and isinstance(item["sha256"], str) and HEX64.fullmatch(item["sha256"])
                and item["class"] in CLASSES, "MANIFEST_INVALID", f"{label} entry is malformed")
        require(item["name"] not in seen, "MANIFEST_INVALID", f"{label} names a file twice")
        seen.add(item["name"])
    return items


def verify_ing_receipt(receipt, jwk):
    """The release receipt the sign job wrote with the lolly.ing key. Returns its body."""
    require(isinstance(receipt, dict) and set(receipt) == {"body", "signature"} and isinstance(receipt["body"], dict),
            "RECEIPT_INVALID", "the lolly.ing receipt has missing or unexpected fields")
    body = receipt["body"]
    require(set(body) == {"kind", "version", "sources", "catalog", "files", "shellPinKeyId", "migrations", "formats"},
            "RECEIPT_INVALID", "the lolly.ing receipt body has missing or unexpected fields")
    require(body["kind"] == "lolly-ing-release" and body["version"] == 1, "RECEIPT_INVALID", "not a version 1 lolly.ing receipt")
    text = receipt["signature"]
    require(isinstance(text, str) and len(text) <= 200, "RECEIPT_INVALID", "the receipt signature is malformed")
    try:
        signature = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise Refusal("RECEIPT_INVALID", "the receipt signature is not base64") from exc
    require(verify_p256(jwk, canonical_js_json(body).encode("utf-8"), signature), "RECEIPT_SIGNATURE",
            "the lolly.ing receipt does not verify against the lolly.ing pin")
    return body


def validate_manifest(manifest, run, ssha):
    """Check the manifest's shape and its binding to the run and source. Returns the normalised release."""
    jwk, thumbprint = ing_pin()
    require(isinstance(manifest, dict) and set(manifest) == {"kind", "version", "run", "sources", "image", "catalog", "shell",
                                                             "receipt", "migrations", "maintenance", "boot"},
            "MANIFEST_INVALID", "the manifest has missing or unexpected fields")
    require(manifest["kind"] == "lolly-ing-instance-manifest" and manifest["version"] == 1, "MANIFEST_INVALID", "not a version 1 manifest")
    require(manifest["run"] == {"id": run["id"], "attempt": run["run_attempt"]}, "MANIFEST_INVALID",
            "the manifest names another run or attempt")
    sources = manifest["sources"]
    require(isinstance(sources, dict) and set(sources) == {"suseLolly", "work", "lolly"}
            and all(isinstance(v, str) and SHA.fullmatch(v) for v in sources.values()) and sources["suseLolly"] == ssha,
            "MANIFEST_INVALID", "the manifest sources are malformed or name another suse-lolly commit")
    image = manifest["image"]
    require(isinstance(image, dict) and set(image) == {"name", "digest", "configDigest", "diffIds", "platform", "archive"},
            "MANIFEST_INVALID", "the manifest image record is malformed")
    require(image["name"] == A.ING["imageName"] and isinstance(image["digest"], str) and DIGEST.fullmatch(image["digest"])
            and isinstance(image["configDigest"], str) and DIGEST.fullmatch(image["configDigest"]) and _digest_list(image["diffIds"])
            and image["platform"] == "linux/amd64", "MANIFEST_INVALID", "the image is not the anchored instance image by digest")
    archive = image["archive"]
    require(isinstance(archive, dict) and set(archive) == {"artifact", "file", "sha256", "bytes"}
            and archive["artifact"] == A.ING["archiveArtifact"] and archive["file"] == A.ING["archiveFile"]
            and isinstance(archive["sha256"], str) and HEX64.fullmatch(archive["sha256"])
            and type(archive["bytes"]) is int and 0 < archive["bytes"] <= A.ING_ARCHIVE_MAX_BYTES,
            "MANIFEST_INVALID", "the archive record is malformed")
    catalog, shell = manifest["catalog"], manifest["shell"]
    require(isinstance(catalog, dict) and set(catalog) == {"seq", "keyId", "indexSha256"} and type(catalog["seq"]) is int
            and catalog["seq"] > 0 and isinstance(catalog["keyId"], str) and KEY_ID.fullmatch(catalog["keyId"])
            and isinstance(catalog["indexSha256"], str) and HEX64.fullmatch(catalog["indexSha256"]),
            "MANIFEST_INVALID", "the catalog record is malformed")
    require(isinstance(shell, dict) and set(shell) == {"pinKeyId", "files", "formats"} and isinstance(shell["pinKeyId"], str)
            and KEY_ID.fullmatch(shell["pinKeyId"]) and isinstance(shell["files"], dict) and isinstance(shell["formats"], dict)
            and isinstance(shell["files"].get("index.html"), str) and HEX64.fullmatch(shell["files"]["index.html"]),
            "MANIFEST_INVALID", "the shell record is malformed")
    refuse_release_key(shell["pinKeyId"], "the build's shell pin")
    refuse_release_key(catalog["keyId"], "the build's catalog signature")
    require(shell["pinKeyId"] == thumbprint and catalog["keyId"] == thumbprint, "KEY_MISMATCH",
            "the build is not pinned to and signed with the lolly.ing key the tool pins")
    migrations = validate_migrations(manifest["migrations"])
    require(type(manifest["maintenance"]) is bool, "MANIFEST_INVALID", "maintenance flag")
    require(manifest["maintenance"] == any(item["class"] != "additive" for item in migrations), "MANIFEST_INVALID",
            "the maintenance flag disagrees with the migration classes")
    require(manifest["boot"] == {"healthz": True, "readyz": True, "shellIndex": True}, "MANIFEST_INVALID",
            "the image did not boot in CI against a throwaway database")
    body = verify_ing_receipt(manifest["receipt"], jwk)
    require(body["sources"] == sources and body["catalog"] == {"seq": catalog["seq"], "indexSha256": catalog["indexSha256"]}
            and body["shellPinKeyId"] == shell["pinKeyId"] and body["migrations"] == migrations
            and body["formats"] == shell["formats"] and body["files"].get("index.html") == shell["files"]["index.html"],
            "RECEIPT_MISMATCH", "the manifest differs from the signed lolly.ing receipt")
    require(isinstance(body["files"], dict) and all(isinstance(k, str) and isinstance(v, str) and HEX64.fullmatch(v)
                                                    for k, v in body["files"].items()), "RECEIPT_INVALID", "receipt file map")
    return {"source": ssha, "work": sources["work"], "lolly": sources["lolly"], "image": image["name"] + "@" + image["digest"],
            "digest": image["digest"], "configDigest": image["configDigest"], "diffIds": list(image["diffIds"]),
            "archive": {"sha256": archive["sha256"], "bytes": archive["bytes"]}, "ciRun": str(run["id"]),
            "seq": catalog["seq"], "indexSha256": shell["files"]["index.html"], "keyId": thumbprint,
            "formats": shell["formats"], "migrations": migrations, "maintenance": manifest["maintenance"]}


# Generation (R20 S16) ------------------------------------------------------------
def _generation_holder(document):
    *parents, field = A.ING["generationPath"]
    holder = document
    for name in parents:
        holder = holder.get(name) if isinstance(holder, dict) else None
    return holder, field


def config_generation(text):
    """instance.catalogPublicationGeneration in one instance.json text."""
    document = strict_json(text, "instance.json")
    holder, field = _generation_holder(document)
    value = holder.get(field) if isinstance(holder, dict) else None
    require(type(value) is int and 0 <= value < 2 ** 53, "CONFIG_INVALID", "instance.json carries no integer generation")
    return value


def next_generation(live, configmaps, database, pack_seq):
    """N = 1 + the maximum of the live config, every lolly.ing config ConfigMap, the database row and the pack's seq."""
    values = [live, database, pack_seq, *configmaps]
    require(all(type(value) is int and value >= 0 for value in values), "GENERATION_UNKNOWN",
            "a generation input is missing; the database row and every config ConfigMap must be readable")
    return 1 + max(values)


def _without_generation(document):
    copy = json.loads(json.dumps(document))
    holder, field = _generation_holder(copy)
    holder.pop(field, None)
    return copy


def with_generation(live_text, generation):
    """The live instance.json with only the generation changed (R22 S3, F12). Access mode, guest
    links, AI policy and every other field stay equal in value."""
    live = strict_json(live_text, "instance.json")
    current = config_generation(live_text)
    require(type(generation) is int and generation > current, "GENERATION_NOT_HIGHER", "a new generation must be higher")
    changed = json.loads(json.dumps(live))
    holder, field = _generation_holder(changed)
    holder[field] = generation
    text = json.dumps(changed, indent=2, ensure_ascii=False) + "\n"
    after = strict_json(text, "instance.json")
    require(_without_generation(after) == _without_generation(live) and config_generation(text) == generation,
            "CONFIG_GUARD", "the new instance.json would change more than the generation")
    return text


def config_name(generation, source):
    return f"{A.ING['configNamePrefix']}{generation}-{source[:8]}"


def config_map(name, text, generation, deploy_id):
    return {"apiVersion": "v1", "kind": "ConfigMap", "immutable": True,
            "metadata": {"name": name, "namespace": A.ING["namespace"],
                         "labels": {"lolly.tools/managed-by": "preview-deploy", "lolly.tools/preview-config": "lolly.ing"},
                         "annotations": {"lolly.tools/preview-deploy-id": deploy_id, "lolly.tools/preview-generation": str(generation)}},
            "data": {A.ING["configKey"]: text}}


# Layout -------------------------------------------------------------------------------
def config_volume(value, index):
    """(volume index, ConfigMap name) of instance.json; it must be mounted exactly where Work reads it."""
    spec = value["spec"]["template"]["spec"]
    volumes = spec.get("volumes") or []
    found = [i for i, volume in enumerate(volumes) if volume.get("name") == A.ING["configVolume"]]
    require(len(found) == 1 and isinstance((volumes[found[0]].get("configMap") or {}).get("name"), str), "LAYOUT_UNKNOWN",
            "the Deployment has no single config ConfigMap volume")
    mounts = [m for m in spec["containers"][index].get("volumeMounts") or [] if m.get("name") == A.ING["configVolume"]]
    require(len(mounts) == 1 and mounts[0].get("mountPath") == A.ING["configMountPath"] and mounts[0].get("subPath") == A.ING["configKey"],
            "LAYOUT_UNKNOWN", "instance.json is not mounted at /app/instance.json")
    return found[0], volumes[found[0]]["configMap"]["name"]


def is_converted(value, index):
    """The instance-image layout: no shell, pack or engine-pin mounts, and the instance image."""
    spec = value["spec"]["template"]["spec"]
    names = {volume.get("name") for volume in spec.get("volumes") or []}
    paths = {mount.get("mountPath") for mount in spec["containers"][index].get("volumeMounts") or []}
    image = spec["containers"][index].get("image", "")
    return (not names & set(A.ING["conversionVolumes"]) and not paths & set(A.ING["conversionMountPaths"].values())
            and image.startswith(A.ING["imageName"] + "@sha256:"))


def instance_image(image):
    return isinstance(image, str) and re.fullmatch(re.escape(A.ING["imageName"]) + r"@sha256:[0-9a-f]{64}", image) is not None


def _protected(value, index, image, config):
    """The template with the two fields the switch may change put back, for the guard."""
    copy = json.loads(json.dumps(value["spec"]))
    spec = copy["template"]["spec"]
    spec["containers"][index]["image"] = image
    volume, _ = config_volume({"spec": copy}, index)
    spec["volumes"][volume]["configMap"]["name"] = config
    return compact_digest(copy)


def switch_patch(value, index, to_image, to_config, annotations):
    """One guarded patch: image, config ConfigMap name and annotations (PROPOSAL 4.3 step 8).

    app-update.py's guard pattern (UID, resourceVersion, container name and current image), plus
    the current ConfigMap name. app-update.py itself changes images only, so it cannot be used here.
    """
    require(instance_image(to_image), "BAD_IMAGE", "not the instance image by digest")
    container = value["spec"]["template"]["spec"]["containers"][index]
    volume, current = config_volume(value, index)
    base = "/spec/template/spec"
    return [{"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
            {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
            {"op": "test", "path": f"{base}/containers/{index}/name", "value": container["name"]},
            {"op": "test", "path": f"{base}/containers/{index}/image", "value": container["image"]},
            {"op": "test", "path": f"{base}/volumes/{volume}/name", "value": A.ING["configVolume"]},
            {"op": "test", "path": f"{base}/volumes/{volume}/configMap/name", "value": current},
            {"op": "replace", "path": f"{base}/containers/{index}/image", "value": to_image},
            {"op": "replace", "path": f"{base}/volumes/{volume}/configMap/name", "value": to_config}] + \
        L.annotation_ops(value["metadata"], annotations)


def guard_switch(before, after, index, to_image, to_config):
    """The patch changed the image and the config reference only (plus metadata)."""
    require(after["metadata"]["uid"] == before["metadata"]["uid"], "SWITCH_GUARD", "a different Deployment answered")
    _, config = config_volume(after, index)
    require(after["spec"]["template"]["spec"]["containers"][index]["image"] == to_image and config == to_config,
            "SWITCH_GUARD", "the patch did not set the image and config")
    original_image = before["spec"]["template"]["spec"]["containers"][index]["image"]
    _, original_config = config_volume(before, index)
    require(_protected(after, index, original_image, original_config) == compact_digest(before["spec"]), "SWITCH_GUARD",
            "the patch or an admission webhook changed other Deployment fields")


def cutover_plan(value, index, to_image, to_config, annotations):
    """PROPOSAL 4.8: drop the shell, pack and engine-pin mounts, set the instance image and config generation N."""
    spec = value["spec"]["template"]["spec"]
    container = spec["containers"][index]
    base = "/spec/template/spec"
    volumes, mounts = spec.get("volumes") or [], container.get("volumeMounts") or []
    gone_volumes = [(i, v) for i, v in enumerate(volumes) if v.get("name") in A.ING["conversionVolumes"]]
    gone_mounts = [(i, m) for i, m in enumerate(mounts) if m.get("name") in A.ING["conversionVolumes"]]
    require(sorted(v["name"] for _, v in gone_volumes) == sorted(A.ING["conversionVolumes"]) and
            all(A.ING["conversionVolumes"][v["name"]] in v for _, v in gone_volumes), "LAYOUT_UNKNOWN",
            "the shell, pack and engine-pin volumes are not exactly as expected")
    require(sorted(m["name"] for _, m in gone_mounts) == sorted(A.ING["conversionVolumes"]) and
            all(m.get("mountPath") == A.ING["conversionMountPaths"][m["name"]] and m.get("readOnly") is True for _, m in gone_mounts),
            "LAYOUT_UNKNOWN", "the shell, pack and engine-pin mounts are not exactly as expected")
    config_index, current_config = config_volume(value, index)
    patch = [{"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
             {"op": "test", "path": f"{base}/containers/{index}/name", "value": container["name"]},
             {"op": "test", "path": f"{base}/containers/{index}/image", "value": container["image"]},
             {"op": "test", "path": f"{base}/volumes/{config_index}/configMap/name", "value": current_config}]
    patch += [{"op": "test", "path": f"{base}/volumes/{i}", "value": v} for i, v in gone_volumes]
    patch += [{"op": "test", "path": f"{base}/containers/{index}/volumeMounts/{i}", "value": m} for i, m in gone_mounts]
    patch += [{"op": "replace", "path": f"{base}/containers/{index}/image", "value": to_image},
              {"op": "replace", "path": f"{base}/volumes/{config_index}/configMap/name", "value": to_config}]
    patch += [{"op": "remove", "path": f"{base}/containers/{index}/volumeMounts/{i}"} for i, _ in sorted(gone_mounts, reverse=True)]
    patch += [{"op": "remove", "path": f"{base}/volumes/{i}"} for i, _ in sorted(gone_volumes, reverse=True)]
    patch += L.annotation_ops(value["metadata"], annotations)
    return {"patch": patch, "annotations": annotations, "image": container["image"], "toImage": to_image,
            "config": current_config, "toConfig": to_config,
            "volumes": [v for _, v in gone_volumes], "mounts": [m for _, m in gone_mounts],
            "resourceVersion": value["metadata"]["resourceVersion"]}


def comparable_cutover(plan):
    """A plan without the fields that move on every status update."""
    body = json.loads(json.dumps(plan))
    body.pop("resourceVersion", None)
    body["patch"] = [op for op in body["patch"] if op.get("path") != "/metadata/resourceVersion"]
    return body


def guard_cutover(before, after, index, plan):
    """The cut-over removed exactly the three mounts and set the image and config; nothing else."""
    require(after["metadata"]["uid"] == before["metadata"]["uid"] and is_converted(after, index), "CUTOVER_GUARD",
            "the cut-over did not produce the instance-image layout")
    _, config = config_volume(after, index)
    require(after["spec"]["template"]["spec"]["containers"][index]["image"] == plan["toImage"] and config == plan["toConfig"],
            "CUTOVER_GUARD", "the cut-over did not set the image and config")
    restored = json.loads(json.dumps(after["spec"]))
    spec = restored["template"]["spec"]
    spec["containers"][index]["image"] = plan["image"]
    volume, _ = config_volume({"spec": restored}, index)
    spec["volumes"][volume]["configMap"]["name"] = plan["config"]
    spec["volumes"] = sorted(spec["volumes"] + plan["volumes"], key=lambda v: v["name"])
    spec["containers"][index]["volumeMounts"] = sorted(spec["containers"][index].get("volumeMounts", []) + plan["mounts"],
                                                       key=lambda m: (m["name"], m["mountPath"]))
    original = json.loads(json.dumps(before["spec"]))
    original["template"]["spec"]["volumes"] = sorted(original["template"]["spec"]["volumes"], key=lambda v: v["name"])
    original["template"]["spec"]["containers"][index]["volumeMounts"] = sorted(
        original["template"]["spec"]["containers"][index].get("volumeMounts", []), key=lambda m: (m["name"], m["mountPath"]))
    require(compact_digest(restored) == compact_digest(original), "CUTOVER_GUARD",
            "the cut-over or an admission webhook changed other Deployment fields")


def revert_cutover_patch(value, index, plan, to_config, annotations):
    """Put the claim layout and the old image back, with a NEW config at a higher generation (PROPOSAL 4.6)."""
    container = value["spec"]["template"]["spec"]["containers"][index]
    base = "/spec/template/spec"
    config_index, current_config = config_volume(value, index)
    patch = [{"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
             {"op": "test", "path": f"{base}/containers/{index}/image", "value": container["image"]},
             {"op": "test", "path": f"{base}/volumes/{config_index}/configMap/name", "value": current_config},
             {"op": "replace", "path": f"{base}/containers/{index}/image", "value": plan["image"]},
             {"op": "replace", "path": f"{base}/volumes/{config_index}/configMap/name", "value": to_config}]
    patch += [{"op": "add", "path": f"{base}/volumes/-", "value": volume} for volume in plan["volumes"]]
    patch += [{"op": "add", "path": f"{base}/containers/{index}/volumeMounts/-", "value": mount} for mount in plan["mounts"]]
    return patch + L.annotation_ops(value["metadata"], annotations)


# Jobs ---------------------------------------------------------------------------------
JOB_KINDS = ("check", "classify", "migrate", "readback")


def database_env(value, index, secret):
    """DATABASE_URL (and DATABASE_URL_UNPOOLED when the server has it), copied from the server's
    Secret references to the qualified database Secret. Never any other variable (R22 S5)."""
    env = value["spec"]["template"]["spec"]["containers"][index].get("env") or []
    picked = []
    for entry in env:
        if entry.get("name") in A.ING["databaseEnv"]:
            ref = ((entry.get("valueFrom") or {}).get("secretKeyRef") or {})
            require(set(entry) == {"name", "valueFrom"} and set(entry["valueFrom"]) == {"secretKeyRef"} and ref.get("name") == secret,
                    "DATABASE_ENV", f"{entry.get('name')} is not a reference to the qualified database Secret")
            picked.append(entry)
    require("DATABASE_URL" in [entry["name"] for entry in picked], "DATABASE_ENV", "the server has no DATABASE_URL reference")
    return picked


def job_manifest(name, kind, deploy_id, value, index, image, command, env, deadline):
    """A Job from the instance image with the server's security settings, the listed ConfigMap
    volumes only, no service account token and only the given environment."""
    require(kind in JOB_KINDS and instance_image(image), "BAD_JOB", "unknown Job kind or image")
    require(all(entry.get("name") in A.ING["databaseEnv"] + ("LW_MIGRATE_EXPECT", "NODE_ENV") for entry in env), "BAD_JOB",
            "a Job may carry only the database URLs, LW_MIGRATE_EXPECT and NODE_ENV")
    spec = value["spec"]["template"]["spec"]
    server = spec["containers"][index]
    volumes = []
    for volume in spec.get("volumes") or []:
        if volume.get("name") in A.ING["jobConfigMapVolumes"]:
            require(set(volume) - {"name"} <= {"configMap", "emptyDir"}, "BAD_JOB", "a Job volume must be a ConfigMap or emptyDir")
            volumes.append(volume)
    mounts = [m for m in server.get("volumeMounts") or [] if m.get("name") in {v["name"] for v in volumes}]
    labels = dict(A.ING["jobPodLabels"], **{"lolly.tools/preview-job": kind})
    return {"apiVersion": "batch/v1", "kind": "Job",
            "metadata": {"name": name, "namespace": A.ING["namespace"], "labels": labels,
                         "annotations": {"lolly.tools/preview-deploy-id": deploy_id}},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": deadline, "ttlSecondsAfterFinished": 86400,
                     "template": {"metadata": {"labels": labels},
                                  "spec": {"restartPolicy": "Never", "automountServiceAccountToken": False,
                                           "enableServiceLinks": False, "securityContext": spec.get("securityContext") or {},
                                           "volumes": volumes,
                                           "containers": [{"name": kind, "image": image, "imagePullPolicy": "Never",
                                                           "workingDir": "/app", "command": list(command), "env": env,
                                                           "volumeMounts": mounts,
                                                           "securityContext": server.get("securityContext") or {},
                                                           "resources": {"limits": {"cpu": "500m", "memory": "512Mi"},
                                                                         "requests": {"cpu": "50m", "memory": "128Mi"}}}]}}}}


def job_name(kind, deploy_id, attempt=0):
    """DNS-1123 and at most 63 characters; unique per run and attempt."""
    stem = re.sub(r"[^a-z0-9-]", "-", deploy_id.lower())
    name = f"preview-{kind}-{stem}" + (f"-{attempt}" if attempt else "")
    return name[:63].rstrip("-")


def last_json_line(text, kind_field, kind):
    """The last stdout line that is a JSON object of this kind; None when there is none."""
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get(kind_field) == kind:
            return value
    return None


# The read-only migration and generation check (PROPOSAL 4.3 step 5). It runs inside the
# instance image with DATABASE_URL only, in a read-only transaction, and issues no DDL.
DB_READ_SCRIPT = r"""
const { default: pg } = await import('file:///app/node_modules/pg/lib/index.js');
const { createHash } = await import('node:crypto');
const { readdir, readFile } = await import('node:fs/promises');
const names = (await readdir('/app/migrations')).filter(n => /^[0-9]{4}_[a-z0-9_]{1,80}\.sql$/.test(n)).sort();
const files = [];
for (const name of names) files.push({ name, sha256: createHash('sha256').update(await readFile('/app/migrations/' + name)).digest('hex') });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
await client.connect();
let ledger = [], publicationGeneration = 0;
try {
  await client.query('begin read only');
  await client.query("set local statement_timeout = '10s'");
  if ((await client.query("select to_regclass('public.schema_migrations') as t")).rows[0].t)
    ledger = (await client.query('select name from schema_migrations order by name')).rows.map(row => row.name);
  if ((await client.query("select to_regclass('public.catalog_delivery_sequence') as t")).rows[0].t) {
    const rows = (await client.query('select publication_generation from catalog_delivery_sequence where singleton=true')).rows;
    if (rows.length === 1) publicationGeneration = Number(rows[0].publication_generation);
  }
  await client.query('commit');
} finally { await client.end(); }
if (!Number.isSafeInteger(publicationGeneration)) throw new Error('publication generation out of range');
process.stdout.write(JSON.stringify({ kind: 'lolly-migrate-check', version: 1, files, ledger, publicationGeneration }) + '\n');
""".strip()


# Migrations (PROPOSAL 4.4; R20 S7, R22 S12; design C 6.2) -------------------------
def validate_check(check):
    """Output of the image's read-only migration check (Phase 2A interface)."""
    require(isinstance(check, dict) and check.get("kind") == "lolly-migrate-check" and check.get("version") == 1
            and set(check) == {"kind", "version", "files", "ledger", "publicationGeneration"},
            "MIGRATION_CHECK", "the migration check output is malformed")
    files = check["files"]
    require(isinstance(files, list) and all(isinstance(f, dict) and set(f) == {"name", "sha256"} and isinstance(f["name"], str)
                                            and MIGRATION_NAME.fullmatch(f["name"]) and isinstance(f["sha256"], str)
                                            and HEX64.fullmatch(f["sha256"]) for f in files), "MIGRATION_CHECK", "check files")
    ledger = check["ledger"]
    require(isinstance(ledger, list) and len(ledger) == len(set(ledger)) and all(isinstance(name, str) and MIGRATION_NAME.fullmatch(name)
                                                                                 for name in ledger), "MIGRATION_CHECK", "ledger")
    generation = check["publicationGeneration"]
    require(type(generation) is int and generation >= 0, "MIGRATION_CHECK", "publication generation")
    return check


def validate_classes(output, names):
    """Output of the classifier CLI for the pending files (Phase 2A interface): one JSON object per file."""
    require(isinstance(output, dict) and output.get("kind") == "lolly-migration-classes" and output.get("version") == 1
            and isinstance(output.get("files"), list), "CLASSIFIER", "the classifier output is malformed")
    found = {}
    for item in output["files"]:
        require(isinstance(item, dict) and {"name", "sha256", "class"} <= set(item) and item["class"] in CLASSES
                and isinstance(item["name"], str) and isinstance(item["sha256"], str), "CLASSIFIER", "a classifier entry is malformed")
        found[item["name"]] = item
    require(set(found) == set(names), "CLASSIFIER", "the classifier did not classify exactly the pending files")
    return found


def migration_plan(manifest_migrations, check, applied_by_lane):
    """Pending files and what they need. The database may be ahead only by names this lane applied as allowlisted."""
    validate_check(check)
    image = {item["name"]: item["sha256"] for item in check["files"]}
    recorded = {item["name"]: item["sha256"] for item in manifest_migrations}
    require(image == recorded, "MIGRATIONS_MISMATCH", "the image's migration files differ from the signed manifest")
    ledger = set(check["ledger"])
    ahead = sorted(ledger - set(image))
    unexplained = [name for name in ahead if name not in applied_by_lane]
    require(not unexplained, "DATABASE_AHEAD", "the database holds migrations this image lacks and this lane did not apply "
            "as allowlisted: " + ", ".join(unexplained[:5]) + "; a human must look")
    pending = sorted(set(image) - ledger)
    classes = {item["name"]: item["class"] for item in manifest_migrations}
    newest = max((name for name in ledger if name in image), default="")
    out_of_order = [name for name in pending if name < newest]
    maintenance = [name for name in pending if classes[name] != "additive"]  # an out-of-order file must be additive too
    return {"pending": [{"name": name, "sha256": image[name], "class": classes[name]} for name in pending],
            "ahead": ahead, "outOfOrder": out_of_order, "maintenance": maintenance,
            "publicationGeneration": check["publicationGeneration"]}


def migration_set(migrations):
    """A short fingerprint of a build's migration file names. Equal sets mean nothing can be pending."""
    names = sorted(item["name"] for item in migrations)
    return hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]


def expect_list(pending):
    """LW_MIGRATE_EXPECT: the exact files the migrate Job may apply, as name:sha256 in name order."""
    return ",".join(f"{item['name']}:{item['sha256']}" for item in sorted(pending, key=lambda item: item["name"]))


# Catalog (PROPOSAL 4.5 item 4) -------------------------------------------------------
def verify_catalog(index_bytes, envelope_bytes, jwk, thumbprint):
    """A signed-in caller's catalog: the envelope verifies against the lolly.ing pin and covers these index bytes."""
    try:
        envelope = strict_json(envelope_bytes.decode("utf-8"), "catalog envelope")
    except UnicodeDecodeError as exc:
        raise Refusal("CATALOG_SIGNATURE", "the catalog envelope is not UTF-8") from exc
    require(isinstance(envelope, dict) and envelope.get("alg") == "ECDSA-P256-SHA256" and isinstance(envelope.get("keyId"), str)
            and isinstance(envelope.get("signature"), str) and isinstance(envelope.get("indexHash"), str)
            and HEX64.fullmatch(envelope["indexHash"]), "CATALOG_SIGNATURE", "the catalog envelope is malformed")
    refuse_release_key(envelope["keyId"], "the served catalog signature")
    require(envelope["keyId"] == thumbprint, "CATALOG_SIGNATURE", "the catalog is signed with a key other than the lolly.ing pin")
    text = envelope["signature"]
    require(re.fullmatch(r"[A-Za-z0-9_-]{86}", text) is not None, "CATALOG_SIGNATURE", "the signature is not raw P-256 base64url")
    signature = base64.urlsafe_b64decode(text + "==")
    body = {name: value for name, value in envelope.items() if name != "signature"}
    require(verify_p256_raw(jwk, canonical_js_json(body).encode("utf-8"), signature), "CATALOG_SIGNATURE",
            "the catalog signature does not verify against the lolly.ing pin")
    require(hashlib.sha256(index_bytes).hexdigest() == envelope["indexHash"], "CATALOG_SIGNATURE",
            "the catalog index does not match its signed hash")
    return envelope


# The release a run carries to the node ---------------------------------------------------
RELEASE_KEYS = {"source", "work", "lolly", "image", "digest", "configDigest", "diffIds", "archive", "ciRun", "seq",
                "indexSha256", "keyId", "formats", "migrations", "maintenance"}


def validate_release(release):
    require(isinstance(release, dict) and set(release) == RELEASE_KEYS, "BAD_REQUEST", "the lolly.ing release is malformed")
    require(all(isinstance(release[k], str) and SHA.fullmatch(release[k]) for k in ("source", "work", "lolly")), "BAD_REQUEST",
            "release sources")
    require(instance_image(release["image"]) and release["image"] == A.ING["imageName"] + "@" + release["digest"]
            and DIGEST.fullmatch(release["configDigest"]) and _digest_list(release["diffIds"]), "BAD_REQUEST", "release image")
    archive = release["archive"]
    require(isinstance(archive, dict) and set(archive) == {"sha256", "bytes"} and HEX64.fullmatch(archive["sha256"])
            and type(archive["bytes"]) is int and 0 < archive["bytes"] <= A.ING_ARCHIVE_MAX_BYTES, "BAD_REQUEST", "release archive")
    require(re.fullmatch(r"[1-9][0-9]{0,15}", release["ciRun"]) is not None and type(release["seq"]) is int and release["seq"] > 0
            and HEX64.fullmatch(release["indexSha256"]) and KEY_ID.fullmatch(release["keyId"]) and isinstance(release["formats"], dict)
            and type(release["maintenance"]) is bool, "BAD_REQUEST", "release fields")
    refuse_release_key(release["keyId"], "the release")
    validate_migrations(release["migrations"], "release migrations")
    return release


def expect_of(release):
    """What the smoke and a later rollback expect of a build. Small, so it fits the annotations."""
    return {"source": release["source"], "index": release["indexSha256"], "keyId": release["keyId"], "seq": release["seq"],
            "work": release["work"], "lolly": release["lolly"]}


def validate_expect(expect):
    require(isinstance(expect, dict) and set(expect) == {"source", "index", "keyId", "seq", "work", "lolly"}
            and all(isinstance(expect[k], str) and SHA.fullmatch(expect[k]) for k in ("source", "work", "lolly"))
            and isinstance(expect["index"], str) and HEX64.fullmatch(expect["index"]) and isinstance(expect["keyId"], str)
            and KEY_ID.fullmatch(expect["keyId"]) and type(expect["seq"]) is int and expect["seq"] > 0,
            "BAD_REQUEST", "lolly.ing expectations are malformed")
    return expect
