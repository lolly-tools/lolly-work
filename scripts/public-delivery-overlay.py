# SPDX-License-Identifier: MPL-2.0
"""Pure proposed v2 boundary for a public static root and its delivery map.

This leaf does not open the maintained five-path release hold. It neither
reads a target nor produces acceptance: source, signatures, physical bytes,
coding decodes, models, resources and native HTTP remain independent gates.
"""
from __future__ import annotations
import re

MAX_FILES = 120_000
MAX_BYTES = 8 * 1024**3
MAX_MAP_BYTES = 64 * 1024**2
MAP = ".delivery-etags.conf"
ROOT = "/usr/share/nginx/html"
ANCHOR = "/run/lolly-public-overlay"
FIXED = ("index.html", "precache.json", "sw.js", "portable/player.js")
SHA = re.compile(r"[a-f0-9]{64}")
PATH = re.compile(r"[A-Za-z0-9._@/+,()\[\]-]+")


class Refusal(RuntimeError):
    """Refuse an incomplete or wider-than-reviewed application delta."""


def need(value, reason):
    if not value:
        raise Refusal(reason)


def safe_path(path):
    need(type(path) is str and 0 < len(path.encode()) <= 1024
         and PATH.fullmatch(path) and len(path.split("/")) <= 64
         and all(part not in {"", ".", ".."} for part in path.split("/")),
         "Unsafe static path")
    need(not path.startswith("models/"), "Models are an independent protected mount")
    identity = path[:-3] if path.endswith((".gz", ".br")) else path
    need(not path.startswith(".") or identity in {MAP, ".well-known/openai-apps-challenge",
                                                 ".well-known/security.txt"},
         "Unknown operator metadata")
    need(not path.startswith("_app/") or all(not part.startswith(".") for part in path.split("/")),
         "Private app metadata is not a served chunk")
    return path


def manifest(value):
    need(type(value) is dict and set(value) == {"version", "files", "totalBytes"}
         and type(value["version"]) is int and value["version"] == 1
         and type(value["files"]) is list and 0 < len(value["files"]) <= MAX_FILES,
         "Complete closed static manifest required")
    rows = {}
    total = 0
    for row in value["files"]:
        need(type(row) is dict and set(row) == {"path", "size", "sha256"},
             "Closed physical file row required")
        path = safe_path(row["path"])
        need(path not in rows and type(row["size"]) is int
             and 0 <= row["size"] <= MAX_BYTES and type(row["sha256"]) is str
             and SHA.fullmatch(row["sha256"]), "Invalid or duplicate file row")
        rows[path] = dict(row)
        total += row["size"]
        need(total <= MAX_BYTES, "Static byte bound exceeded")
    need(list(rows) == sorted(rows) and type(value["totalBytes"]) is int
         and value["totalBytes"] == total, "Manifest order or byte total differs")
    return rows


def coding_identity(path):
    return path[:-3] if path.endswith((".gz", ".br")) else None


def coding_pairs(rows):
    """Return the exact physical decode obligations, never claim they passed."""
    pairs = []
    for path, row in rows.items():
        identity = coding_identity(path)
        if identity is not None:
            need(identity in rows and coding_identity(identity) is None
                 and identity != MAP, "Orphan, nested or operator coding sibling")
            pairs.append({"coding": row, "identity": rows[identity]})
    return pairs


def mutable(path):
    identity = coding_identity(path) or path
    return identity in FIXED


def plan(previous, effective, overlay, delta, removed):
    """Validate the full-root assembly and explicit stale-sidecar removals.

    Old _app chunks/codings remain immutable; all catalog, docs, fonts and other
    image content remain byte-identical. Only the four mutable identities,
    their coding closure, new app chunks and the generated map may change.
    The overlay covers every static byte so an absent sidecar cannot fall
    through to an older image. Separate production guards are not inferred.
    """
    old, new, mounted, writes = [manifest(v) for v in (previous, effective, overlay, delta)]
    for rows in (old, new):
        need(all(path in rows for path in FIXED) and any(path.startswith("_app/") for path in rows),
             "Every existing shell path must be present")
        need(MAP in rows and 0 < rows[MAP]["size"] <= MAX_MAP_BYTES,
             "A bounded full generated validator map is required")
        coding_pairs(rows)
    need(mounted == new, "Overlay must cover the complete effective static root")
    need(type(removed) is list and all(type(path) is str for path in removed)
         and removed == sorted(set(removed)),
         "Explicit sorted unique removal paths required")
    for path in removed:
        safe_path(path)
        identity = coding_identity(path)
        need(path in old and path not in new and identity in FIXED
             and new[identity] != old[identity], "Only obsolete changed mutable codings may be removed")
    need(set(old) - set(new) == set(removed), "Removal list does not match physical absence")
    for path, row in old.items():
        if path == MAP or mutable(path):
            continue
        need(new.get(path) == row, "Protected content or retained app chunk changed")
    changed = {path: row for path, row in new.items() if old.get(path) != row}
    need(changed and writes == changed and MAP in changed and any(path != MAP for path in changed),
         "Exact writes including a refreshed map required")
    for path, row in changed.items():
        need(path == MAP or mutable(path) or path.startswith("_app/"),
             "Public delta includes protected content")
        identity = coding_identity(path)
        if identity in FIXED and new[identity] != old[identity]:
            need(old.get(path) != row, "Changed identity retained stale coded bytes")
    for path in FIXED:
        if old[path] != new[path]:
            for extension in (".gz", ".br"):
                coded = path + extension
                need(coded not in new or new[coded] != old.get(coded),
                     "Changed identity retained stale coded bytes")
    return {"version": 2, "protocol": "PUBLIC_FULL_ROOT_DELIVERY_OVERLAY",
            "writes": list(changed), "removed": list(removed),
            "staticFiles": len(new), "staticBytes": effective["totalBytes"],
            "map": dict(new[MAP]), "codingPairs": coding_pairs(new),
            "runtimeQualified": False, "productionMutation": False}


def overlay_mounts(volume):
    """The first RO anchor relabels the new claim before its serving subPaths.

    Models remain the existing separate RO child mount. Its original identity,
    full content and parent/child mount order need independent qualification.
    """
    need(type(volume) is str and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", volume),
         "Explicit selected DNS-label volume required")
    return [{"name": volume, "mountPath": ANCHOR, "readOnly": True},
            {"name": volume, "mountPath": ROOT, "readOnly": True, "subPath": "site"},
            {"name": volume, "mountPath": "/etc/nginx/delivery-etags.conf", "readOnly": True,
             "subPath": "site/" + MAP}]
