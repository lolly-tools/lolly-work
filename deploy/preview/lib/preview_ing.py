# SPDX-License-Identifier: MPL-2.0
"""lolly.ing rules shared by the Mac and the node (PROPOSAL section 4).

Pure functions only: no network, no cluster, no clock. They decide whether a
private build may go live, which catalog generation it gets, how the live
instance.json changes (the generation and nothing else), what a pending
migration set allows, and which key a build is pinned to.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re

import preview_anchors as A
import preview_layout as L
from preview_common import HEX64, SHA, Refusal, canonical_js_json, compact_digest, require, strict_json
from preview_receipt import jwk_thumbprint, verify_p256_raw

DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
# The same rule as Work's runner and the restore rehearsal (server/src/store/migrate.ts).
MIGRATION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.sql\Z")
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
    require(thumbprint != A.PREVIEW_PUBLIC_KEY_THUMBPRINT, "KEY_MISMATCH",
            "the lolly.ing key must differ from the lolly.tools preview key")
    return jwk, thumbprint


SECRET_NAME = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\Z")


def signing_secret():
    """The Secret holding lolly.ing's own key (review 2026-10-25 H3), or a refusal until a reviewed change pins it."""
    name = A.ING_SIGNING_KEY_SECRET
    require(isinstance(name, str) and SECRET_NAME.fullmatch(name) is not None, "SIGNING_SECRET_NOT_PINNED",
            "the Secret holding lolly.ing's own catalog key (ING_SIGNING_KEY_SECRET) is not pinned in the tool yet; nothing was changed")
    return name


def signing_key_env(value, index):
    """(env index, Secret name) of the server's LW_CATALOG_SIGNING_KEY: exactly one entry, a Secret key reference."""
    env = value["spec"]["template"]["spec"]["containers"][index].get("env") or []
    found = [i for i, entry in enumerate(env) if entry.get("name") == A.ING["signingKeyEnv"]]
    require(len(found) == 1, "LAYOUT_UNKNOWN", f"the server has no single {A.ING['signingKeyEnv']} variable")
    entry = env[found[0]]
    ref = (entry.get("valueFrom") or {}).get("secretKeyRef") or {}
    require(set(entry) == {"name", "valueFrom"} and set(entry["valueFrom"]) == {"secretKeyRef"} and isinstance(ref.get("name"), str)
            and SECRET_NAME.fullmatch(ref["name"]) is not None and isinstance(ref.get("key"), str), "LAYOUT_UNKNOWN",
            f"{A.ING['signingKeyEnv']} is not a reference to a Secret key")
    return found[0], ref["name"]


def refuse_release_key(key_id, what):
    """Refuse any build or pod that names the platform release key (R20 S1, R22 S1)."""
    require(key_id != A.RELEASE_PUBLIC_KEY_THUMBPRINT, "RELEASE_KEY",
            f"{what} names the platform release key {A.RELEASE_PUBLIC_KEY_THUMBPRINT[:8]}...; lolly.ing must use its own key")


def boot_key_id(log_text):
    """The keyId from Work's boot line `catalog signing on (keyId ...)`; None when signing is off or absent."""
    found = re.findall(r"catalog signing on \(keyId ([A-Za-z0-9_-]{43})\)", log_text or "")
    require(len(set(found)) <= 1, "BOOT_LOG", "the boot log names more than one catalog signing key")
    return found[0] if found else None


# Manifest (suse-lolly lolly-ing-preview.yml, PR #28) -------------------------------
def _digest_list(values):
    return isinstance(values, list) and 0 < len(values) <= 256 and all(isinstance(v, str) and DIGEST.fullmatch(v) for v in values)


def validate_migrations(items, label="migrations"):
    """[{name, sha256}] in file-name order, as the workflow's `migrations` records them."""
    require(isinstance(items, list) and len(items) <= 2000, "MANIFEST_INVALID", f"{label} is not a list")
    seen = set()
    for item in items:
        require(isinstance(item, dict) and set(item) == {"name", "sha256"} and isinstance(item["name"], str)
                and MIGRATION_NAME.fullmatch(item["name"]) and ".." not in item["name"] and isinstance(item["sha256"], str)
                and HEX64.fullmatch(item["sha256"]), "MANIFEST_INVALID", f"{label} entry is malformed")
        require(item["name"] not in seen, "MANIFEST_INVALID", f"{label} names a file twice")
        seen.add(item["name"])
    return items


def _sha(value):
    return isinstance(value, str) and SHA.fullmatch(value) is not None


def validate_manifest(manifest, run, wsha):
    """Check the workflow's manifest and its binding to the run and the Work commit. Returns the release.

    The manifest is unsigned; it is trusted through the run binding. The shell's signed
    receipt is verified against the lolly.ing pin on the served site, after the switch.
    """
    _, thumbprint = ing_pin()
    anchors = A.ING
    require(isinstance(manifest, dict) and manifest.get("kind") == anchors["manifestKind"] and manifest.get("version") == 1
            and manifest.get("site") == "lolly.ing", "MANIFEST_INVALID", "not a version 1 lolly.ing instance image manifest")
    record = manifest.get("run")
    require(isinstance(record, dict) and record.get("runId") == run["id"] and record.get("runAttempt") == run["run_attempt"]
            and record.get("repository") == anchors["repository"] and record.get("event") == "workflow_dispatch"
            and record.get("ref") == "refs/heads/" + anchors["branch"] and record.get("workflowSha") == run.get("head_sha"),
            "MANIFEST_INVALID", "the manifest names another run, attempt, repository, event, ref or workflow commit")
    sources = manifest.get("sources")
    require(isinstance(sources, dict) and set(sources) == {"lolly", "work", "suse"} and all(_sha(v) for v in sources.values()),
            "MANIFEST_INVALID", "the manifest sources are malformed")
    require(sources["work"] == wsha, "MANIFEST_SOURCE", "the build is for another Work commit")
    require(sources["suse"] == run.get("head_sha"), "RUN_NOT_BOUND",
            "the run's head commit is not the suse-lolly commit it built (SSHA must be the dispatched main commit)")
    pin = manifest.get("enginePin")
    require(isinstance(pin, dict) and pin.get("generatedFrom") == sources["lolly"], "MANIFEST_INVALID",
            "the image's engine pin does not name the Lolly commit")
    image = manifest.get("image")
    require(isinstance(image, dict), "MANIFEST_INVALID", "the manifest has no image record")
    archive = image.get("archive")
    name = re.fullmatch(anchors["archivePattern"].format(run=run["id"], attempt=run["run_attempt"]), str((archive or {}).get("name")))
    require(isinstance(archive, dict) and set(archive) == {"name", "sha256", "bytes"} and name is not None
            and isinstance(archive["sha256"], str) and HEX64.fullmatch(archive["sha256"])
            and type(archive["bytes"]) is int and 0 < archive["bytes"] <= A.ING_ARCHIVE_MAX_BYTES,
            "MANIFEST_INVALID", "the archive record is malformed or not this run's archive")
    ref_name = anchors["refNamePattern"].format(run=run["id"], attempt=run["run_attempt"])
    require(all(isinstance(image.get(k), str) and DIGEST.fullmatch(image[k]) for k in ("digest", "manifestDigest", "configDigest"))
            and _digest_list(image.get("diffIds")) and image.get("refName") == ref_name,
            "MANIFEST_INVALID", "the image digests, DiffIDs or name are malformed")
    shell, catalog, settings = manifest.get("shell"), manifest.get("catalog"), manifest.get("buildSettings")
    require(isinstance(shell, dict) and isinstance(catalog, dict) and isinstance(settings, dict), "MANIFEST_INVALID",
            "the shell, catalog or build settings record is missing")
    keys = [shell.get("keyId"), shell.get("publicPinThumbprint"), catalog.get("keyId"), settings.get("pinThumbprint")]
    for key_id in keys:
        refuse_release_key(key_id, "the build")
    require(all(key_id == thumbprint for key_id in keys), "KEY_MISMATCH",
            "the build is not pinned to and signed with the lolly.ing key the tool pins")
    require(shell.get("profile") == A.ING["receiptProfile"] and settings.get("profile") == A.ING["receiptProfile"],
            "MANIFEST_INVALID", "the shell is not the suse profile")
    require(isinstance(shell.get("indexSha256"), str) and HEX64.fullmatch(shell["indexSha256"])
            and isinstance(manifest.get("receiptSha256"), str) and HEX64.fullmatch(manifest["receiptSha256"])
            and manifest["receiptSha256"] == shell.get("receiptSha256"), "MANIFEST_INVALID", "the shell index or receipt hash")
    require(type(catalog.get("seq")) is int and catalog["seq"] > 0 and catalog["seq"] == shell.get("catalogSeq"),
            "MANIFEST_INVALID", "the catalog sequence is malformed")
    migrations = validate_migrations(manifest.get("migrations"))
    require(bool(migrations), "MANIFEST_INVALID", "the manifest lists no migrations")
    stored = manifest.get("storedFormats")
    formats = stored.get("formats") if isinstance(stored, dict) and "formats" in stored else stored
    require(isinstance(formats, dict) and all(isinstance(k, str) and (v is None or type(v) is int) for k, v in formats.items()),
            "MANIFEST_INVALID", "the stored formats are malformed")
    boot = manifest.get("boot")
    require(isinstance(boot, dict) and (boot.get("readyz") or {}).get("status") == 200
            and (boot.get("index") or {}).get("sha256") == shell["indexSha256"], "MANIFEST_INVALID",
            "the image did not boot in CI against a throwaway database")
    require(isinstance(manifest.get("frontendInputSha256"), str) and HEX64.fullmatch(manifest["frontendInputSha256"]),
            "MANIFEST_INVALID", "the unsigned frontend artifact hash is missing")
    release = {"source": wsha, "suse": sources["suse"], "lolly": sources["lolly"],
            "image": anchors["imageName"] + "@" + image["digest"], "digest": image["digest"],
            "manifestDigest": image["manifestDigest"], "configDigest": image["configDigest"], "diffIds": list(image["diffIds"]),
            "refName": ref_name, "archive": {"name": archive["name"], "sha256": archive["sha256"], "bytes": archive["bytes"]},
            "ciRun": str(run["id"]), "seq": catalog["seq"], "indexSha256": shell["indexSha256"],
            "receiptSha256": manifest["receiptSha256"], "keyId": thumbprint, "formats": dict(formats),
            "migrations": [{"name": m["name"], "sha256": m["sha256"]} for m in migrations],
            "frontendInputSha256": manifest["frontendInputSha256"], "approvals": manifest.get("approvals")}
    from preview_approval import validate_release_approvals
    validate_release_approvals(release, run)
    return release


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


def cutover_plan(value, index, to_image, to_config, annotations, to_secret):
    """PROPOSAL 4.8: drop the shell, pack and engine-pin mounts, set the instance image and config generation N, and
    point the catalog signing key at lolly.ing's own Secret (review 2026-10-25 H3). One patch, so a revert puts the
    old image, old key reference and old pack back together and the reverted catalog still verifies."""
    spec = value["spec"]["template"]["spec"]
    container = spec["containers"][index]
    base = "/spec/template/spec"
    require(isinstance(to_secret, str) and SECRET_NAME.fullmatch(to_secret) is not None, "BAD_INPUT", "signing Secret name")
    env_index, current_secret = signing_key_env(value, index)
    require(current_secret != to_secret, "SIGNING_SECRET_LIVE", f"the server already references the lolly.ing signing Secret "
            f"{to_secret} before the cut-over, so a revert could not restore the previous key; a human must look")
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
             {"op": "test", "path": f"{base}/volumes/{config_index}/configMap/name", "value": current_config},
             {"op": "test", "path": f"{base}/containers/{index}/env/{env_index}/name", "value": A.ING["signingKeyEnv"]},
             {"op": "test", "path": f"{base}/containers/{index}/env/{env_index}/valueFrom/secretKeyRef/name", "value": current_secret}]
    patch += [{"op": "test", "path": f"{base}/volumes/{i}", "value": v} for i, v in gone_volumes]
    patch += [{"op": "test", "path": f"{base}/containers/{index}/volumeMounts/{i}", "value": m} for i, m in gone_mounts]
    patch += [{"op": "replace", "path": f"{base}/containers/{index}/image", "value": to_image},
              {"op": "replace", "path": f"{base}/volumes/{config_index}/configMap/name", "value": to_config},
              {"op": "replace", "path": f"{base}/containers/{index}/env/{env_index}/valueFrom/secretKeyRef/name", "value": to_secret}]
    patch += [{"op": "remove", "path": f"{base}/containers/{index}/volumeMounts/{i}"} for i, _ in sorted(gone_mounts, reverse=True)]
    patch += [{"op": "remove", "path": f"{base}/volumes/{i}"} for i, _ in sorted(gone_volumes, reverse=True)]
    patch += L.annotation_ops(value["metadata"], annotations)
    return {"patch": patch, "annotations": annotations, "image": container["image"], "toImage": to_image,
            "config": current_config, "toConfig": to_config,
            "signingKeySecret": current_secret, "toSigningKeySecret": to_secret,
            "volumes": [v for _, v in gone_volumes], "mounts": [m for _, m in gone_mounts],
            "resourceVersion": value["metadata"]["resourceVersion"]}


def comparable_cutover(plan):
    """A plan without the fields that move on every status update."""
    body = json.loads(json.dumps(plan))
    body.pop("resourceVersion", None)
    body["patch"] = [op for op in body["patch"] if op.get("path") != "/metadata/resourceVersion"]
    return body


def guard_cutover(before, after, index, plan):
    """The cut-over removed exactly the three mounts and set the image, config and signing key reference; nothing else."""
    require(after["metadata"]["uid"] == before["metadata"]["uid"] and is_converted(after, index), "CUTOVER_GUARD",
            "the cut-over did not produce the instance-image layout")
    _, config = config_volume(after, index)
    _, secret = signing_key_env(after, index)
    require(after["spec"]["template"]["spec"]["containers"][index]["image"] == plan["toImage"] and config == plan["toConfig"]
            and secret == plan["toSigningKeySecret"], "CUTOVER_GUARD",
            "the cut-over did not set the image, config and signing key reference")
    restored = json.loads(json.dumps(after["spec"]))
    spec = restored["template"]["spec"]
    spec["containers"][index]["image"] = plan["image"]
    volume, _ = config_volume({"spec": restored}, index)
    spec["volumes"][volume]["configMap"]["name"] = plan["config"]
    env_index, _ = signing_key_env({"spec": restored}, index)
    spec["containers"][index]["env"][env_index]["valueFrom"]["secretKeyRef"]["name"] = plan["signingKeySecret"]
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
    """Put the claim layout, the old image and the old signing key reference back, with a NEW config at a higher
    generation (PROPOSAL 4.6). The old pack then verifies against the old key again, so the catalog answers."""
    container = value["spec"]["template"]["spec"]["containers"][index]
    base = "/spec/template/spec"
    config_index, current_config = config_volume(value, index)
    env_index, current_secret = signing_key_env(value, index)
    patch = [{"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
             {"op": "test", "path": f"{base}/containers/{index}/image", "value": container["image"]},
             {"op": "test", "path": f"{base}/volumes/{config_index}/configMap/name", "value": current_config},
             {"op": "test", "path": f"{base}/containers/{index}/env/{env_index}/valueFrom/secretKeyRef/name", "value": current_secret},
             {"op": "replace", "path": f"{base}/containers/{index}/image", "value": plan["image"]},
             {"op": "replace", "path": f"{base}/volumes/{config_index}/configMap/name", "value": to_config},
             {"op": "replace", "path": f"{base}/containers/{index}/env/{env_index}/valueFrom/secretKeyRef/name",
              "value": plan["signingKeySecret"]}]
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
const names = (await readdir('/app/migrations')).filter(n => n.endsWith('.sql')).sort();  // Work's own rule
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
    """Output of this tool's read-only check inside the image (DB_READ_SCRIPT)."""
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


def migration_manifest(files):
    """sha256 over a fixed header and one `name<TAB>sha256` line per file in name order: Work's
    migrationManifest (server/src/store/migrate.ts) and the rehearsal's, byte for byte."""
    lines = "".join(f"{f['name']}\t{f['sha256']}\n" for f in sorted(files, key=lambda f: f["name"]))
    return "sha256:" + hashlib.sha256((A.MIGRATION_MANIFEST_HEADER + lines).encode()).hexdigest()


def expect_value(pending):
    """LW_MIGRATE_EXPECT for the pending files: their manifest, or `none`. Never empty, never names alone."""
    return migration_manifest(pending) if pending else "none"


def json_document(text):
    """The one JSON document a program printed, pretty or not, with nothing after it."""
    text = text or ""
    starts = [index for index, char in enumerate(text) if char == "{" and (index == 0 or text[index - 1] == "\n")]
    for start in starts:
        try:
            value, end = json.JSONDecoder().raw_decode(text, start)
        except ValueError:
            continue
        if not text[end:].strip():
            return value
    return None


def validate_classes(output, pending):
    """Work's classifier output (`classify-migrations.ts --json --only <pending>`, PR #207) for exactly the
    pending files: {"version": 1, "migrations": [{name, sha256, class, reasons, statements}], "manifest"}."""
    require(isinstance(output, dict) and output.get("version") == 1 and isinstance(output.get("migrations"), list),
            "CLASSIFIER", "the classifier output is malformed")
    found = {}
    for item in output["migrations"]:
        require(isinstance(item, dict) and {"name", "sha256", "class", "reasons"} <= set(item) and item["class"] in CLASSES
                and isinstance(item["name"], str) and isinstance(item["sha256"], str), "CLASSIFIER", "a classifier entry is malformed")
        found[item["name"]] = item
    expected = {item["name"]: item["sha256"] for item in pending}
    require(set(found) == set(expected) and len(found) == len(output["migrations"]), "CLASSIFIER",
            "the classifier did not classify exactly the pending files")
    require(all(found[name]["sha256"] == digest for name, digest in expected.items()), "MIGRATIONS_MISMATCH",
            "the image's pending files differ from the signed manifest")
    require(output.get("manifest") == migration_manifest(pending), "CLASSIFIER",
            "the classifier's manifest differs from the pending set's")
    return found


def migration_plan(manifest_migrations, check, applied_by_lane):
    """Pending files and the database-ahead rule: the database may be ahead only by names this lane applied
    as allowlisted. A file that sorts before an applied one is noted; the classifier decides each class."""
    validate_check(check)
    image = {item["name"]: item["sha256"] for item in check["files"]}
    recorded = {item["name"]: item["sha256"] for item in manifest_migrations}
    require(image == recorded, "MIGRATIONS_MISMATCH", "the image's migration files differ from the build manifest")
    ledger = set(check["ledger"])
    ahead = sorted(ledger - set(image))
    unexplained = [name for name in ahead if name not in applied_by_lane]
    require(not unexplained, "DATABASE_AHEAD", "the database holds migrations this image lacks and this lane did not apply "
            "as allowlisted: " + ", ".join(unexplained[:5]) + "; a human must look")
    pending = sorted(set(image) - ledger)
    newest = max((name for name in ledger if name in image), default="")
    return {"pending": [{"name": name, "sha256": image[name]} for name in pending], "ahead": ahead,
            "outOfOrder": [name for name in pending if name < newest], "publicationGeneration": check["publicationGeneration"]}


def migration_set(migrations):
    """A short fingerprint of a build's migration file names. Equal sets mean nothing can be pending."""
    names = sorted(item["name"] for item in migrations)
    return hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]


def check_rehearsal(result, pending, image, previous_image):
    """The restore rehearsal's result (deploy/preview/REHEARSAL.md, PR #208), checked again here."""
    require(isinstance(result, dict), "REHEARSAL_FAILED", "the rehearsal gave no result")
    require(result.get("teardownComplete") is True, "REHEARSAL_FAILED",
            "the rehearsal left objects behind (teardown incomplete); clean up with restore-rehearsal.py cleanup")
    require(result.get("result") == "PASSED", "REHEARSAL_FAILED",
            f"the rehearsal {str(result.get('result')).lower()}: {result.get('code')} {str(result.get('reason'))[:200]}")
    require(result.get("pending") == sorted(({"name": p["name"], "sha256": p["sha256"]} for p in pending), key=lambda p: p["name"])
            and result.get("expect") == expect_value(pending), "REHEARSAL_FAILED", "the rehearsal ran another pending set")
    require((result.get("images") or {}).get("new") == image and (result.get("images") or {}).get("previous") == previous_image,
            "REHEARSAL_FAILED", "the rehearsal ran other images")
    files = result.get("files") or []
    require(sorted(f.get("name") for f in files if isinstance(f, dict)) == sorted(p["name"] for p in pending)
            and all(isinstance(f, dict) and type(f.get("seconds")) in (int, float) and f["seconds"] <= A.MIGRATION_LOCK_BUDGET_SECONDS
                    for f in files), "REHEARSAL_FAILED", "a file was not rehearsed or ran past the lock budget")
    require(result.get("egressClosedAfterFetch") is True, "REHEARSAL_FAILED", "the rehearsal's egress did not close after fetch")
    return {"result": "PASSED", "runId": result.get("runId"), "expect": result.get("expect"), "files": files}


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
RELEASE_KEYS = {"source", "suse", "lolly", "image", "digest", "manifestDigest", "configDigest", "diffIds", "refName",
                "archive", "ciRun", "seq", "indexSha256", "receiptSha256", "keyId", "formats", "migrations",
                "frontendInputSha256", "approvals"}


def validate_release(release):
    require(isinstance(release, dict) and set(release) == RELEASE_KEYS, "BAD_REQUEST", "the lolly.ing release is malformed")
    require(all(_sha(release[k]) for k in ("source", "suse", "lolly")), "BAD_REQUEST", "release sources")
    require(instance_image(release["image"]) and release["image"] == A.ING["imageName"] + "@" + release["digest"]
            and all(isinstance(release[k], str) and DIGEST.fullmatch(release[k]) for k in ("manifestDigest", "configDigest"))
            and _digest_list(release["diffIds"]) and isinstance(release["refName"], str)
            and release["refName"].startswith(A.ING["imageName"] + ":run-"), "BAD_REQUEST", "release image")
    archive = release["archive"]
    require(isinstance(archive, dict) and set(archive) == {"name", "sha256", "bytes"} and isinstance(archive["sha256"], str)
            and HEX64.fullmatch(archive["sha256"]) and type(archive["bytes"]) is int and 0 < archive["bytes"] <= A.ING_ARCHIVE_MAX_BYTES,
            "BAD_REQUEST", "release archive")
    require(re.fullmatch(r"[1-9][0-9]{0,15}", release["ciRun"]) is not None and type(release["seq"]) is int and release["seq"] > 0
            and all(isinstance(release[k], str) and HEX64.fullmatch(release[k]) for k in ("indexSha256", "receiptSha256"))
            and isinstance(release["keyId"], str) and KEY_ID.fullmatch(release["keyId"]) and isinstance(release["formats"], dict),
            "BAD_REQUEST", "release fields")
    refuse_release_key(release["keyId"], "the release")
    validate_migrations(release["migrations"], "release migrations")
    require(isinstance(release.get("frontendInputSha256"), str) and HEX64.fullmatch(release["frontendInputSha256"]),
            "BAD_REQUEST", "the unsigned frontend artifact hash is missing")
    from preview_approval import validate_release_approvals
    validate_release_approvals(release)
    return release


def expect_of(release):
    """What the smoke and a later rollback expect of a build. Small, so it fits the annotations."""
    return {"source": release["source"], "suse": release["suse"], "lolly": release["lolly"], "index": release["indexSha256"],
            "receipt": release["receiptSha256"], "keyId": release["keyId"], "seq": release["seq"]}


def validate_expect(expect):
    require(isinstance(expect, dict) and set(expect) == {"source", "suse", "lolly", "index", "receipt", "keyId", "seq"}
            and all(_sha(expect[k]) for k in ("source", "suse", "lolly"))
            and all(isinstance(expect[k], str) and HEX64.fullmatch(expect[k]) for k in ("index", "receipt"))
            and isinstance(expect["keyId"], str) and KEY_ID.fullmatch(expect["keyId"]) and type(expect["seq"]) is int
            and expect["seq"] > 0, "BAD_REQUEST", "lolly.ing expectations are malformed")
    return expect
