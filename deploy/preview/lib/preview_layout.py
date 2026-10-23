# SPDX-License-Identifier: MPL-2.0
"""Guarded JSON patches the preview command builds itself (annotations and the 3.6 conversion).

Image changes always go through Work's scripts/app-update.py. This module only
writes Deployment metadata annotations (never the Pod template, so no rollout)
and, once, the layout conversion that stops mounting the claim-served root and
the nginx ConfigMap over the image's own files.
"""

from __future__ import annotations

import copy

from preview_common import Refusal, compact_digest, require


def pointer(key):
    return key.replace("~", "~0").replace("/", "~1")


def annotation_ops(metadata, values):
    """JSON patch ops that set (str) or remove (None) Deployment metadata annotations."""
    current = metadata.get("annotations")
    ops = []
    if current is None:
        present = {key: value for key, value in values.items() if value is not None}
        return [{"op": "add", "path": "/metadata/annotations", "value": present}] if present else []
    for key in sorted(values):
        value = values[key]
        require(value is None or isinstance(value, str), "BAD_INPUT", "annotation values are strings")
        path = "/metadata/annotations/" + pointer(key)
        if value is None:
            if key in current:
                ops.append({"op": "remove", "path": path})
        else:
            ops.append({"op": "add", "path": path, "value": value})
    return ops


def container_index(value, name):
    containers = value["spec"]["template"]["spec"].get("containers", [])
    matches = [i for i, container in enumerate(containers) if container.get("name") == name]
    require(len(matches) == 1, "IDENTITY_MISMATCH", "owned container missing or ambiguous")
    return matches[0]


def _removed(anchors):
    return set(anchors["conversionVolumes"])


def is_converted(value, index, anchors):
    """True when no conversion volume or mount remains (the image serves its own root)."""
    spec = value["spec"]["template"]["spec"]
    names = {volume.get("name") for volume in spec.get("volumes", [])}
    mounts = {mount.get("name") for mount in spec["containers"][index].get("volumeMounts", [])}
    return not (_removed(anchors) & (names | mounts))


def models_release(value, index, anchors):
    """The mounted models release: template annotation and the models mount subPath must agree."""
    spec = value["spec"]["template"]["spec"]
    annotation = (value["spec"]["template"].get("metadata") or {}).get("annotations", {}).get(anchors["modelsReleaseAnnotation"])
    mounts = [mount for mount in spec["containers"][index].get("volumeMounts", [])
              if mount.get("name") == anchors["modelsVolume"] and mount.get("mountPath") == anchors["modelsMountPath"]]
    volumes = [volume for volume in spec.get("volumes", []) if volume.get("name") == anchors["modelsVolume"]]
    require(len(mounts) == 1 and len(volumes) == 1 and "persistentVolumeClaim" in volumes[0]
            and mounts[0].get("readOnly") is True, "MODELS_LAYOUT", "the read-only models claim mount is missing")
    require(annotation is not None and mounts[0].get("subPath") == annotation, "MODELS_LAYOUT",
            "the models mount and its release annotation disagree")
    return annotation


def conversion_plan(value, anchors, annotations):
    """The exact guarded patch for PROPOSAL 3.6. Leaves the image and every other field unchanged."""
    index = container_index(value, anchors["container"])
    spec = value["spec"]["template"]["spec"]
    require(not is_converted(value, index, anchors), "ALREADY_CONVERTED", "the Deployment already serves the image root")
    volumes, mounts = spec.get("volumes", []), spec["containers"][index].get("volumeMounts", [])
    for name, source in anchors["conversionVolumes"].items():
        found = [volume for volume in volumes if volume.get("name") == name]
        require(len(found) == 1 and set(found[0]) == {"name", source}, "LAYOUT_UNEXPECTED",
                f"volume {name} is missing or is not a {source}")
        count = sum(1 for mount in mounts if mount.get("name") == name)
        require(count == anchors["conversionMountCounts"][name], "LAYOUT_UNEXPECTED",
                f"volume {name} has {count} mounts, expected {anchors['conversionMountCounts'][name]}")
    for kind in ("containers", "initContainers"):
        for position, container in enumerate(spec.get(kind, [])):
            if kind == "containers" and position == index:
                continue
            require(not _removed(anchors) & {mount.get("name") for mount in container.get("volumeMounts", [])},
                    "LAYOUT_UNEXPECTED", "another container mounts a volume the conversion removes")
    models_release(value, index, anchors)
    after_volumes = [volume for volume in volumes if volume.get("name") not in _removed(anchors)]
    after_mounts = [mount for mount in mounts if mount.get("name") not in _removed(anchors)]
    base = f"/spec/template/spec/containers/{index}"
    limit_op = "replace" if "revisionHistoryLimit" in value["spec"] else "add"
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/namespace", "value": value["metadata"]["namespace"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
        {"op": "test", "path": base + "/name", "value": anchors["container"]},
        {"op": "test", "path": base + "/image", "value": spec["containers"][index]["image"]},
        {"op": "test", "path": "/spec/template/spec/volumes", "value": volumes},
        {"op": "test", "path": base + "/volumeMounts", "value": mounts},
        {"op": "replace", "path": "/spec/template/spec/volumes", "value": after_volumes},
        {"op": "replace", "path": base + "/volumeMounts", "value": after_mounts},
        {"op": limit_op, "path": "/spec/revisionHistoryLimit", "value": anchors["revisionHistoryLimit"]},
    ] + annotation_ops(value["metadata"], annotations)
    return {
        "containerIndex": index,
        "image": spec["containers"][index]["image"],
        "deploymentUID": value["metadata"]["uid"],
        "resourceVersion": value["metadata"]["resourceVersion"],
        "beforeSpecSha256": compact_digest(value["spec"]),
        "before": {"volumes": volumes, "volumeMounts": mounts,
                   "revisionHistoryLimit": value["spec"].get("revisionHistoryLimit")},
        "after": {"volumes": after_volumes, "volumeMounts": after_mounts,
                  "revisionHistoryLimit": anchors["revisionHistoryLimit"]},
        "removedVolumes": [volume for volume in volumes if volume.get("name") in _removed(anchors)],
        "annotations": dict(annotations),
        "patch": patch,
    }


def comparable_plan(plan):
    """A conversion plan without its resourceVersion, which status updates move (review C-H1, C-M9)."""
    keys = ("containerIndex", "image", "deploymentUID", "beforeSpecSha256", "before", "after", "removedVolumes",
            "annotations", "patch")
    result = {key: copy.deepcopy(plan.get(key)) for key in keys}
    result["patch"] = [op for op in result["patch"] or [] if op.get("path") != "/metadata/resourceVersion"]
    return result


def _without_layout(spec, index):
    copy_spec = copy.deepcopy(spec)
    copy_spec.pop("revisionHistoryLimit", None)
    copy_spec["template"]["spec"].pop("volumes", None)
    copy_spec["template"]["spec"]["containers"][index].pop("volumeMounts", None)
    return compact_digest(copy_spec)


def guard_layout_result(before, result, index, layout):
    """After a conversion or its inverse: identity kept, only the three layout fields changed."""
    require(result["metadata"]["uid"] == before["metadata"]["uid"], "LAYOUT_GUARD", "patch changed the Deployment identity")
    spec = result["spec"]
    require(spec["template"]["spec"].get("volumes", []) == layout["volumes"]
            and spec["template"]["spec"]["containers"][index].get("volumeMounts", []) == layout["volumeMounts"]
            and spec.get("revisionHistoryLimit") == layout["revisionHistoryLimit"], "LAYOUT_GUARD", "patch did not set the planned layout")
    require(spec["template"]["spec"]["containers"][index]["image"] == before["spec"]["template"]["spec"]["containers"][index]["image"],
            "LAYOUT_GUARD", "patch changed the image")
    require(_without_layout(before["spec"], index) == _without_layout(spec, index), "LAYOUT_GUARD",
            "patch or admission changed protected Deployment fields")


def inverse_conversion_patch(value, plan, annotations):
    """Restore the exact pre-conversion layout; refused if the live layout is not the planned one."""
    index = plan["containerIndex"]
    spec = value["spec"]["template"]["spec"]
    require(value["metadata"]["uid"] == plan["deploymentUID"], "IDENTITY_MISMATCH", "another Deployment")
    require(spec.get("volumes", []) == plan["after"]["volumes"]
            and spec["containers"][index].get("volumeMounts", []) == plan["after"]["volumeMounts"],
            "LAYOUT_CHANGED", "the live layout is not the converted layout; inspect by hand")
    base = f"/spec/template/spec/containers/{index}"
    before_limit = plan["before"]["revisionHistoryLimit"]
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
        {"op": "test", "path": base + "/image", "value": plan["image"]},
        {"op": "test", "path": "/spec/template/spec/volumes", "value": plan["after"]["volumes"]},
        {"op": "test", "path": base + "/volumeMounts", "value": plan["after"]["volumeMounts"]},
        {"op": "replace", "path": "/spec/template/spec/volumes", "value": plan["before"]["volumes"]},
        {"op": "replace", "path": base + "/volumeMounts", "value": plan["before"]["volumeMounts"]},
        ({"op": "remove", "path": "/spec/revisionHistoryLimit"} if before_limit is None else
         {"op": "replace", "path": "/spec/revisionHistoryLimit", "value": before_limit}),
    ]
    return patch + annotation_ops(value["metadata"], annotations)


def parse_quantity(text):
    """Kubernetes memory quantity to bytes (Ki/Mi/Gi/Ti, k/M/G/T or plain)."""
    units = {"Ki": 2 ** 10, "Mi": 2 ** 20, "Gi": 2 ** 30, "Ti": 2 ** 40, "k": 10 ** 3, "M": 10 ** 6, "G": 10 ** 9, "T": 10 ** 12}
    if not isinstance(text, str) or not text:
        raise Refusal("BAD_QUANTITY", "memory limit is missing")
    for suffix in sorted(units, key=len, reverse=True):
        if text.endswith(suffix) and text[:-len(suffix)].isdigit():
            return int(text[:-len(suffix)]) * units[suffix]
    require(text.isdigit(), "BAD_QUANTITY", "memory limit is not a plain quantity")
    return int(text)
