# SPDX-License-Identifier: MPL-2.0
"""Fakes for tests/test_preview_deploy.py: gh, ssh, k3s (kubectl, crictl, ctr), systemctl and check-target.py.

Every fake is a small executable that calls into this module and keeps its state
in a JSON file, so the command under test runs its real subprocess paths. No
network, cluster, node or GitHub is ever contacted.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# The fake executables import this module on every call, so heavy imports
# (zipfile, gzip, the receipt verifier) happen only in the functions that need them.
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
LIB = ROOT / "deploy" / "preview" / "lib"
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))

KUBECONFIG = "/root/test.kubeconfig"
CONTEXT = "test"
CLUSTER_UID = "11111111-1111-4111-8111-111111111111"
NODE_UID = "22222222-2222-4222-8222-222222222222"
NAMESPACE_UID = "33333333-3333-4333-8333-333333333333"
DEPLOYMENT_UID = "44444444-4444-4444-8444-444444444444"
NODE_NAME = "node-1"
EDGE_ADDRESS = "203.0.113.10"
NAMESPACE = "lolly-public"
DEPLOYMENT = "sovereign-web"
REPO = "lolly-tools/lolly"
IMAGE_REPO = "ghcr.io/lolly-tools/lolly-web"
MIB = 2 ** 20
GIB = 2 ** 30

# Vectors made with Lolly's own code (Node crypto.sign, engine/src/canonical-json.ts,
# packages/core/src/connector-origins.ts and scripts/configure-connector-origins.ts).
NODE_VECTORS = {
    "body": {"kind": "lolly-release-frontend", "version": 1, "source": "a" * 40, "target": "web", "profile": "lolly-demo",
             "files": {"index.html": "b" * 64, "catalog/tools/index.sig.json": "c" * 64, "z/été.html": "d" * 64,
                       "A\tb\"c\\\u0001 .txt": "e" * 64, "\U0001F600/x": "f" * 64, "￿": "0" * 64}},
}


# Test signing key (verification-only code lives in the product; signing is test-only).
def _affine(point):
    import preview_receipt as R
    x, y, z = point
    inverse = pow(z, -1, R.P)
    return x * inverse * inverse % R.P, y * inverse * inverse * inverse % R.P


def make_key():
    import secrets
    import preview_receipt as R
    d = secrets.randbelow(R.N - 1) + 1
    x, y = _affine(R._multiply_add(d, (R.GX, R.GY), 0, (R.GX, R.GY)))
    b64 = lambda n: base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()
    return d, {"kty": "EC", "crv": "P-256", "x": b64(x), "y": b64(y)}


def _der_int(n):
    raw = n.to_bytes((n.bit_length() + 8) // 8 or 1, "big")
    while len(raw) > 1 and raw[0] == 0 and raw[1] < 0x80:
        raw = raw[1:]
    return b"\x02" + bytes([len(raw)]) + raw


def sign(d, message):
    import secrets
    import preview_receipt as R
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    while True:
        k = secrets.randbelow(R.N - 1) + 1
        x, _ = _affine(R._multiply_add(k, (R.GX, R.GY), 0, (R.GX, R.GY)))
        r = x % R.N
        s = pow(k, -1, R.N) * (e + r * d) % R.N
        if r and s:
            body = _der_int(r) + _der_int(s)
            return b"\x30" + bytes([len(body)]) + body


def sha(data):
    return hashlib.sha256(data).hexdigest()


# Source files the fake GitHub serves per commit ------------------------------
SECURITY_HEADERS = """# test copy of deploy/docker/security-headers.conf
add_header Content-Security-Policy $lolly_csp always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Content-Type-Options "nosniff" always;
include /etc/nginx/delivery-headers.conf;
"""
NGINX = """map $request_uri $lolly_csp {
    default "default-src 'self'; script-src 'self' blob:; connect-src 'self' blob: https://lolly.ing; frame-ancestors 'self'";
    "~^/any-site(/|\\?|$)" "default-src 'self'; connect-src 'self' blob:; frame-src https:";
}
server { listen 8080; }
"""
MODELS = json.dumps([{"url": "/models/a/config.json", "size": 44}, {"url": "/models/a/model.onnx", "size": 1000}]).encode()
CONNECTORS = "https://files.example.com"


def format_files(db=26, revision=1, channel=2, session=4):
    return {
        "shells/web/src/bridge/db.ts": f"const DB_VERSION = {db};\n",
        "shells/web/src/bridge/revision-archive-format.ts": f"export interface RevisionArchive {{\n  version: {revision};\n}}\n",
        "shells/web/src/collab/join-route.ts": f"export const CHANNEL_MESSAGE_VERSION = {channel};\n",
        "engine/src/session-record.ts": f"export const SESSION_FORMAT_VERSION = {session};\n",
    }


def expected_headers():
    import preview_expect
    return preview_expect.expected_headers(SECURITY_HEADERS, NGINX, CONNECTORS)


def make_build(key, sha_, label, extra_pages=(), formats=None):
    """One candidate build: its served site, signed receipt, image digest and registry manifest."""
    import gzip
    from preview_common import canonical_js_json
    index = f"<!doctype html><title>{label}</title>".encode()
    files = {
        "index.html": index,
        "index.html.gz": gzip.compress(index, mtime=0),
        "catalog/tools/index.json": json.dumps({"version": 1, "tools": [{"id": "qr-code"}, {"id": "chart"}]}).encode(),
        "catalog/tools/index.sig.json": json.dumps({"keyId": "test", "label": label}).encode(),
        "catalog/assets/index.json": json.dumps({"version": 1, "assets": [{"id": "lolly/logo/primary"}]}).encode(),
        "info/index.html": f"info {label}".encode(),
        "view/tools.html": f"tools {label}".encode(),
    }
    for page in extra_pages:
        files[page] = f"{page} {label}".encode()
    body = {"kind": "lolly-release-frontend", "version": 1, "source": sha_, "target": "web", "profile": "lolly-demo",
            "files": {path: sha(data) for path, data in sorted(files.items())}}
    body["signature"] = base64.b64encode(sign(key, canonical_js_json({k: v for k, v in body.items()}).encode())).decode()
    manifest = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                           "config": {"size": 1000}, "layers": [{"size": 40 * MIB}], "annotations": {"label": label}}).encode()
    image = f"{IMAGE_REPO}@sha256:{sha(manifest)}"
    return {"sha": sha_, "label": label, "image": image, "manifest": base64.b64encode(manifest).decode(),
            "site": {path: base64.b64encode(data).decode() for path, data in files.items()},
            "receipt": base64.b64encode(json.dumps(body).encode()).decode(),
            "formats": formats or format_files()}


def expect_for(build, pages=None):
    import preview_expect
    return {"source": build["sha"], "profile": "lolly-demo", "headers": expected_headers(),
            "models": preview_expect.models_sample(MODELS),
            "pages": pages or [{"path": "/info/", "file": "info/index.html"}, {"path": "/tools", "file": "view/tools.html"}]}


# Fake cluster ------------------------------------------------------------------
LABELS = {"app.kubernetes.io/component": "web", "app.kubernetes.io/instance": "sovereign", "app.kubernetes.io/name": "lolly-sovereign"}


def deployment(image, converted=True, annotations=None):
    volumes = [{"name": "tmp", "emptyDir": {"sizeLimit": "16Mi"}},
               {"name": "models", "persistentVolumeClaim": {"claimName": "lolly-public-models-test-v1"}}]
    mounts = [{"name": "tmp", "mountPath": "/tmp"},
              {"name": "models", "mountPath": "/run/lolly-public-models", "readOnly": True},
              {"name": "models", "mountPath": "/usr/share/nginx/html/models", "readOnly": True, "subPath": "models-" + "1" * 64}]
    if not converted:
        volumes += [{"name": "nginx", "configMap": {"name": "lolly-public-nginx-test-v1", "defaultMode": 420}},
                    {"name": "public-delivery", "persistentVolumeClaim": {"claimName": "lolly-public-web-test-v1"}}]
        mounts = [mounts[0]] + [{"name": "nginx", "mountPath": "/etc/nginx/" + p, "readOnly": True, "subPath": p.split("/")[-1]}
                                for p in ("conf.d/default.conf", "delivery-headers.conf", "delivery-maps.conf", "security-headers.conf")] + [
            {"name": "public-delivery", "mountPath": "/run/lolly-public-overlay", "readOnly": True},
            {"name": "public-delivery", "mountPath": "/usr/share/nginx/html", "readOnly": True, "subPath": "site"},
            {"name": "public-delivery", "mountPath": "/etc/nginx/delivery-etags.conf", "readOnly": True,
             "subPath": "site/.delivery-etags.conf"}] + mounts[1:]
    return {"apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": DEPLOYMENT, "namespace": NAMESPACE, "uid": DEPLOYMENT_UID, "resourceVersion": "100",
                         "generation": 23, "labels": dict(LABELS, **{"helm.sh/chart": "lolly-sovereign-0.1.3"}),
                         "annotations": dict({"deployment.kubernetes.io/revision": "23"}, **(annotations or {}))},
            "spec": {"replicas": 1, "revisionHistoryLimit": 2 if not converted else 5, "progressDeadlineSeconds": 600,
                     "selector": {"matchLabels": LABELS}, "strategy": {"type": "Recreate"},
                     "template": {"metadata": {"labels": LABELS, "annotations": {"lolly.tools/models-release": "models-" + "1" * 64}},
                                  "spec": {"containers": [{"name": "web", "image": image, "imagePullPolicy": "IfNotPresent",
                                                           "resources": {"limits": {"memory": "768Mi"}}, "volumeMounts": mounts}],
                                           "volumes": volumes, "securityContext": {"runAsNonRoot": True}}}},
            "status": {"observedGeneration": 23, "replicas": 1, "readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1}}


def old_record(build, run="800"):
    return {"source": build["sha"], "image": build["image"], "ciRun": run,
            "formats": {"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}, "expect": expect_for(build)}


def preview_annotations(build, phase="accepted", previous=None, deploys="0", run="800"):
    import preview_common
    values = {"phase": phase, "source": build["sha"], "image": build["image"], "ci-run": run,
              "formats": preview_common.compact({"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}),
              "expect": preview_common.compact(expect_for(build)), "layout": "image-root", "deploys": deploys,
              "deploy-id": "20261023T000000Z-tools-convert-" + build["sha"][:8]}
    if previous is not None:
        values["previous"] = preview_common.compact(previous)
    return {"lolly.tools/preview-" + k: v for k, v in values.items()}


def image_entry(ref, labels=None, extra_refs=()):
    """One CRI image: an ID (its config digest), the manifest digest and named refs, each with containerd labels."""
    digest = ref.partition("@")[2] or "sha256:" + sha(ref.encode())
    image_id = "sha256:" + sha(("config" + ref).encode())
    refs = {ref: dict(labels or {}), image_id: {}}
    for extra in extra_refs:
        refs[extra] = {}
    return image_id, {"digest": digest, "size": 120 * MIB, "refs": refs}


def cluster_state(builds, live, converted=True, annotations=None, registry=None):
    deploy = deployment(live["image"], converted, annotations)
    state = {
        "namespaces": {"kube-system": CLUSTER_UID, NAMESPACE: NAMESPACE_UID},
        "node": {"name": NODE_NAME, "uid": NODE_UID},
        "deployment": deploy,
        "replicasets": [{"uid": "rs-23", "revision": 23, "image": live["image"], "template": _template_digest(deploy)}],
        "pods": [],
        "configmaps": {"lolly-public-nginx-test-v1": {"default.conf": "server { listen 8080; }\n", "security-headers.conf": "old\n",
                                                       "delivery-maps.conf": "maps\n", "delivery-headers.conf": "headers\n"}},
        "pvcs": [{"metadata": {"name": n, "uid": n + "-uid", "creationTimestamp": "2026-10-21T00:00:00Z", "labels": {}}}
                 for n in ("lolly-public-web-test-v1", "lolly-public-models-test-v1", "unrelated-claim")],
        "images": {},
        "registry": registry if registry is not None else {b["image"]: True for b in builds.values()},
        "builds": {b["image"]: b for b in builds.values()},
        "behaviour": {"notReady": [], "brokenSite": [], "watchFailAfter": {}, "restarts": {}, "workingSet": 100 * MIB,
                      "usage": 700 * MIB, "rvChurnRate": 0.125, "rvChurnAfterDryRun": {}, "edgeHeaders": {},
                      "edgeHeadersByImage": {}, "transport": {}, "dnsFailures": 0},
        "reads": 0,
        "capacity": {"total": 100 * GIB, "available": 40 * GIB},
        "fetches": {},
        "writes": [],
    }
    # The live image was imported and pinned by an earlier procedure: no labels of this command.
    image_id, entry = image_entry(live["image"], {"io.cri-containerd.pinned": "pinned"})
    state["images"][image_id] = entry
    state["pods"] = [_pod(state, deploy, "rs-23", 23)]
    stray = _pod(state, deploy, "rs-22", 22)  # an evicted Pod of an older ReplicaSet stays listed (review C-M3)
    stray["status"]["phase"] = "Failed"
    stray["metadata"]["name"] = "sovereign-web-22-evicted"
    state["pods"].append(stray)
    return state


def _template_digest(deploy):
    return sha(json.dumps(deploy["spec"]["template"], sort_keys=True).encode())


def _pod(state, deploy, rs_uid, revision):
    image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
    ready = image not in state["behaviour"]["notReady"]
    return {"metadata": {"name": f"sovereign-web-{revision}", "namespace": NAMESPACE, "labels": dict(LABELS),
                         "ownerReferences": [{"kind": "ReplicaSet", "uid": rs_uid}]},
            "spec": copy.deepcopy(deploy["spec"]["template"]["spec"]),
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
                       "containerStatuses": [{"name": "web", "ready": ready, "image": image, "imageID": image,
                                              "restartCount": state["behaviour"]["restarts"].get(image, 0),
                                              "containerID": "containerd://" + sha(f"{image}{revision}".encode())[:32]}]}}


@contextlib.contextmanager
def state_file(path):
    data = json.loads(Path(path).read_text())
    yield data
    Path(path).write_text(json.dumps(data))


def apply_json_patch(document, patch):
    """RFC 6902 subset used by kubectl --type=json: test, add, replace, remove."""
    document = copy.deepcopy(document)

    def walk(path):
        parts = [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]
        parent = document
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        return parent, parts[-1]
    for op in patch:
        parent, last = walk(op["path"])
        index = int(last) if isinstance(parent, list) and last != "-" else last
        if op["op"] == "test":
            if isinstance(parent, list):
                current = parent[index]
            else:
                if last not in parent:
                    raise ValueError("test path missing")
                current = parent[last]
            if current != op["value"]:
                raise ValueError("test failed at " + op["path"])
        elif op["op"] in ("add", "replace"):
            if op["op"] == "replace" and not isinstance(parent, list) and last not in parent:
                raise ValueError("replace path missing")
            if isinstance(parent, list) and last == "-" and op["op"] == "add":
                parent.append(copy.deepcopy(op["value"]))
            else:
                parent[index] = copy.deepcopy(op["value"])
        elif op["op"] == "remove":
            del parent[index]
        else:
            raise ValueError("unsupported op")
    return document


def _apply_deployment_change(state, before, after):
    deploy = after
    changed_spec = before["spec"] != deploy["spec"]
    deploy["metadata"]["resourceVersion"] = str(int(before["metadata"]["resourceVersion"]) + 1)
    if changed_spec:
        deploy["metadata"]["generation"] = before["metadata"]["generation"] + 1
    if before["spec"]["template"] != deploy["spec"]["template"]:
        revision = max(rs["revision"] for rs in state["replicasets"]) + 1
        digest = _template_digest(deploy)
        state["replicasets"] = [rs for rs in state["replicasets"] if rs["template"] != digest]
        uid = f"rs-{revision}"
        image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
        state["replicasets"].append({"uid": uid, "revision": revision, "image": image, "template": digest})
        state["replicasets"] = sorted(state["replicasets"], key=lambda rs: rs["revision"])[-(deploy["spec"].get("revisionHistoryLimit", 10) + 1):]
        deploy["metadata"]["annotations"]["deployment.kubernetes.io/revision"] = str(revision)
        stray = [pod for pod in state["pods"] if pod["status"]["phase"] == "Failed"]
        state["pods"] = [_pod(state, deploy, uid, revision)] + stray
        ready = image not in state["behaviour"]["notReady"]
        if not any(image in entry["refs"] for entry in state["images"].values()):
            image_id, entry = image_entry(image)
            state["images"][image_id] = entry
        deploy["status"] = {"observedGeneration": deploy["metadata"]["generation"], "replicas": 1,
                            "readyReplicas": 1 if ready else 0, "availableReplicas": 1 if ready else 0, "updatedReplicas": 1}
    elif changed_spec:
        deploy["status"]["observedGeneration"] = deploy["metadata"]["generation"]
    state["deployment"] = deploy


def _replicaset_objects(state):
    deploy = state["deployment"]
    items = []
    for rs in state["replicasets"]:
        current = rs["template"] == _template_digest(deploy)
        items.append({"kind": "ReplicaSet", "metadata": {"name": f"sovereign-web-rs{rs['revision']}", "namespace": NAMESPACE,
                      "uid": rs["uid"], "labels": dict(LABELS),
                      "annotations": {"deployment.kubernetes.io/revision": str(rs["revision"])},
                      "ownerReferences": [{"kind": "Deployment", "uid": deploy["metadata"]["uid"]}]},
                      "spec": {"template": {"spec": {"containers": [{"name": "web", "image": rs["image"]}],
                                                     "volumes": deploy["spec"]["template"]["spec"]["volumes"] if current else
                                                     [{"name": "public-delivery", "persistentVolumeClaim": {"claimName": "lolly-public-web-test-v1"}}]}}}})
    return items


def _image_by_ref(state, ref):
    for image_id, entry in state["images"].items():
        if ref == image_id or ref in entry["refs"]:
            return image_id, entry
    return None, None


def _pinned(entry):
    return any(labels.get("io.cri-containerd.pinned") == "pinned" for labels in entry["refs"].values())


def _cri_image(image_id, entry):
    names = [ref for ref in entry["refs"] if ref != image_id]
    return {"id": image_id, "repoDigests": [ref for ref in names if "@" in ref], "repoTags": [ref for ref in names if "@" not in ref],
            "size": str(entry["size"]), "pinned": _pinned(entry)}


# crictl (cri-tools) gives every CRI call a 2 s client deadline unless the global
# --timeout/-t option, which must come before the subcommand, sets another. A pull has
# no deadline. Each simulated call takes some seconds; one longer than its deadline
# fails with DeadlineExceeded, and a removal still completes in containerd afterwards.
CRICTL_DEFAULT_DEADLINE = 2.0
CRICTL_READ_SECONDS = 2.5  # longer than the default, so a call without --timeout fails
CRICTL_RMI_SECONDS = 5.0  # a 1.15 GB image took longer than 2 s on the node


def _seconds(text):
    found = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m)", text or "")
    if not found:
        raise ValueError(text)
    return float(found.group(1)) * {"ms": 0.001, "s": 1.0, "m": 60.0}[found.group(2)]


def _crictl_options(argv):
    """(deadline, explicit, subcommand words), or an error, like urfave/cli: globals before the subcommand."""
    deadline, explicit, index = CRICTL_DEFAULT_DEADLINE, False, 1
    while index < len(argv) and argv[index].startswith("-"):
        word = argv[index]
        if word in ("--timeout", "-t") and index + 1 < len(argv):
            value, index = argv[index + 1], index + 2
        elif word.startswith("--timeout="):
            value, index = word.partition("=")[2], index + 1
        else:
            return "flag provided but not defined: " + word
        try:
            seconds = _seconds(value)
        except ValueError:
            return "invalid value for --timeout: " + value
        deadline, explicit = (seconds, True) if seconds > 0 else (CRICTL_DEFAULT_DEADLINE, False)
    rest = argv[index:]
    for word in rest[1:]:
        if word in ("--timeout", "-t") or word.startswith("--timeout="):
            return "flag provided but not defined: " + word
    return deadline, explicit, rest


def _deadline_exceeded(call, ref):
    print(f'time="2026-10-23T18:00:00Z" level=fatal msg="{call} for \\"{ref}\\": rpc error: code = DeadlineExceeded'
          ' desc = context deadline exceeded: stream error: stream ID 3; CANCEL; received from peer"', file=sys.stderr)
    return 1


def _crictl_main(state, argv, out):
    parsed = _crictl_options(argv)
    if isinstance(parsed, str):
        print(parsed, file=sys.stderr)
        return 1
    deadline, explicit, rest = parsed
    behaviour = state["behaviour"]
    command = rest[0] if rest else ""
    state.setdefault("crictlCalls", []).append({"command": command, "deadline": deadline, "explicit": explicit})
    read_seconds = behaviour.get("crictlReadSeconds", CRICTL_READ_SECONDS)
    if command != "pull" and read_seconds > deadline:  # a pull has no CRI deadline
        return _deadline_exceeded("request", command)
    pending = state.setdefault("pendingRemovals", {})
    if command == "images":  # containerd finishes a removal crictl gave up on
        for image_id in list(pending):
            pending[image_id] -= 1
            if pending[image_id] <= 0:
                state["images"].pop(image_id, None)
                del pending[image_id]
    if command == "version":
        out.write("Version:  0.1.0\nRuntimeName:  containerd\n")
    elif command == "pull":
        if not state["registry"].get(rest[1]):
            return 1
        image_id, entry = image_entry(rest[1])
        state["images"][image_id] = entry
        state["writes"].append(["pull", rest[1]])
    elif command == "inspecti":
        image_id, entry = _image_by_ref(state, rest[-1])
        if entry is None:
            print(f'level=fatal msg="no such image \\"{rest[-1]}\\" present"', file=sys.stderr)
            return 1
        out.write(json.dumps({"status": _cri_image(image_id, entry)}))
    elif command == "images":
        out.write(json.dumps({"images": [_cri_image(i, e) for i, e in state["images"].items()]}))
    elif command == "stats":
        image = state["pods"][0]["spec"]["containers"][0]["image"]
        used = behaviour.get("workingSetByImage", {}).get(image, behaviour["workingSet"])
        out.write(json.dumps({"stats": [{"memory": {"workingSetBytes": {"value": str(used)},
                                                    "usageBytes": {"value": str(behaviour["usage"])}}}]}))
    elif command == "rmi":
        # crictl reads the image status first, then RemoveImage deletes every name of the
        # image and does not care about pins.
        image_id, entry = _image_by_ref(state, rest[1])
        if entry is None or image_id in pending:
            print(f'level=fatal msg="no such image {rest[1]}"', file=sys.stderr)
            return 1
        state["writes"].append(["rmi", rest[1], sorted(entry["refs"])])
        if image_id in behaviour.get("rmiStuck", []):  # containerd never finishes this one
            return _deadline_exceeded("error of removing image", rest[1])
        seconds = behaviour.get("rmiSecondsById", {}).get(image_id, behaviour.get("rmiSeconds", CRICTL_RMI_SECONDS))
        if seconds > deadline:
            later = behaviour.get("rmiFinishesAfterReads", {}).get(image_id, 0)
            if later:
                pending[image_id] = later
            else:
                del state["images"][image_id]
            return _deadline_exceeded("error of removing image", rest[1])
        del state["images"][image_id]
    else:
        print("unsupported crictl " + command, file=sys.stderr)
        return 1
    return 0


def k3s_main(argv):
    state_path = os.environ["FAKE_STATE"]
    out = sys.stdout
    if os.environ.get("FAKE_SITE") == "lolly.ing":
        import preview_deploy_ing_fakes
        code = preview_deploy_ing_fakes.k3s_ing_main(argv, out)
        if code is not None:
            return code
    if argv[:1] == ["kubectl"]:
        if argv[1:5] != ["--kubeconfig", KUBECONFIG, "--context", CONTEXT]:
            print("bad kubeconfig or context", file=sys.stderr)
            return 1
        args = argv[5:]
        with state_file(state_path) as state:
            if args[:2] == ["get", "namespace"]:
                out.write(json.dumps({"metadata": {"uid": state["namespaces"][args[2]]}}))
            elif args[:2] == ["get", "node"]:
                node = state["node"]
                if args[2] != node["name"]:
                    return 1
                out.write(json.dumps({"metadata": {"uid": node["uid"]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}))
            elif args[:2] == ["get", "deployment"]:
                # Status updates move resourceVersion between reads (review C-H1): a light,
                # deterministic background churn, plus a targeted one right after a dry run
                # that sets a given image, which is where app-update.py refuses.
                state["reads"] += 1
                behaviour, pending = state["behaviour"], state.pop("pendingChurn", None)
                targeted = pending is not None and behaviour["rvChurnAfterDryRun"].get(pending, 0) > 0
                if targeted:
                    behaviour["rvChurnAfterDryRun"][pending] -= 1
                background = int(sha(str(state["reads"]).encode())[:8], 16) / 2 ** 32 < behaviour["rvChurnRate"]
                if targeted or background:
                    meta = state["deployment"]["metadata"]
                    meta["resourceVersion"] = str(int(meta["resourceVersion"]) + 1)
                out.write(json.dumps(state["deployment"]))
            elif args[:2] == ["patch", "deployment"]:
                patch = json.loads(args[args.index("--patch") + 1])
                try:
                    after = apply_json_patch(state["deployment"], patch)
                except (ValueError, KeyError, IndexError):
                    print("the patch test failed", file=sys.stderr)
                    return 1
                if "--dry-run=server" in args:
                    images = [op["value"] for op in patch if op["op"] == "replace" and op["path"].endswith("/image")]
                    if images:
                        state["pendingChurn"] = images[0]
                else:
                    state["writes"].append(patch)
                    _apply_deployment_change(state, state["deployment"], after)
                    after = state["deployment"]
                out.write(json.dumps(after))
            elif args[:2] == ["rollout", "status"]:
                image = state["deployment"]["spec"]["template"]["spec"]["containers"][0]["image"]
                return 1 if image in state["behaviour"]["notReady"] else 0
            elif args[:2] == ["get", "replicasets"] and "-l" in args:
                out.write(json.dumps({"items": _replicaset_objects(state)}))
            elif args[:2] == ["get", "pods"] and "-l" in args:
                out.write(json.dumps({"items": state["pods"]}))
            elif args[:2] == ["get", "pods,replicasets"]:
                pods = [dict(pod, kind="Pod") for pod in state["pods"]]
                mcp = "ghcr.io/lolly-tools/lolly-mcp@sha256:" + "9" * 64
                other = {"kind": "Pod", "metadata": {"name": "mcp", "namespace": NAMESPACE},
                         "spec": {"containers": [{"name": "mcp", "image": mcp}]},
                         "status": {"containerStatuses": [{"name": "mcp", "image": mcp, "imageID": mcp}]}}
                out.write(json.dumps({"items": pods + [other] + _replicaset_objects(state)}))
            elif args[:2] == ["get", "configmap"]:
                out.write(json.dumps({"data": state["configmaps"][args[2]]}))
            elif args[:2] == ["get", "persistentvolumeclaims"]:
                out.write(json.dumps({"items": state["pvcs"]}))
            elif args[:2] == ["get", "pods,replicasets,statefulsets"]:
                pods = [dict(pod, kind="Pod") for pod in state["pods"] if pod["status"]["phase"] != "Failed"]
                out.write(json.dumps({"items": pods + _replicaset_objects(state)}))
            else:
                print("unsupported kubectl " + " ".join(args[:2]), file=sys.stderr)
                return 1
        return 0
    with state_file(state_path) as state:
        if argv[:1] == ["crictl"]:
            return _crictl_main(state, argv, out)
        if argv[:5] == ["ctr", "-n", "k8s.io", "images", "ls"]:
            lines = ["REF TYPE DIGEST SIZE PLATFORMS LABELS"]
            for image_id, entry in state["images"].items():
                for ref, labels in entry["refs"].items():
                    text = ",".join(f"{k}={v}" for k, v in sorted(labels.items())) or "-"
                    lines.append(f"{ref} application/vnd.oci.image.manifest.v1+json {entry['digest']} 120.0 MiB linux/amd64 {text}")
            out.write("\n".join(lines) + "\n")
        elif argv[:5] == ["ctr", "-n", "k8s.io", "images", "label"]:
            ref, label = argv[5], argv[6]
            image_id, entry = _image_by_ref(state, ref)
            if entry is None:
                return 1
            name, _, value = label.partition("=")
            if state["behaviour"].get("pinsIgnored") and name == "io.cri-containerd.pinned":
                return 0  # the label call succeeds but nothing sticks (review C-L4)
            if value:
                entry["refs"][ref][name] = value
            else:
                entry["refs"][ref].pop(name, None)
            state["writes"].append(["label", ref, label])
        else:
            print("unsupported " + " ".join(argv[:2]), file=sys.stderr)
            return 1
    return 0


# Fake edge (patched into preview_smoke.FETCH inside the fake node processes) ----
def make_fetch(state_path):
    import preview_common
    import preview_smoke

    def fetch(url, method="GET", headers=None, limit=None):
        parts = urlsplit(url)
        with state_file(state_path) as state:
            deploy = state["deployment"]
            image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
            converted = not any(v["name"] == "public-delivery" for v in deploy["spec"]["template"]["spec"]["volumes"])
            build = state["builds"].get(image)
            behaviour = state["behaviour"]
            count = state["fetches"].get(image, 0)
            if parts.path == "/" and parts.hostname == "lolly.tools":
                state["fetches"][image] = count + 1
            rule = behaviour["transport"].get(image, {}).get(parts.path)
            failing = False
            if rule is not None and parts.hostname == "lolly.tools":
                seen = rule.get("seen", 0)
                rule["seen"] = seen + 1
                failing = rule["after"] <= seen < rule["after"] + rule["count"]
            edge = dict(behaviour["edgeHeaders"], **behaviour["edgeHeadersByImage"].get(image, {}))
        if failing:  # what http_fetch turns a reset connection or a truncated body into
            raise preview_common.Refusal("SMOKE_TRANSPORT", f"{method} {parts.path} failed: ConnectionResetError")
        headers_out = []
        for name, value in expected_headers():
            if name == "Content-Security-Policy" and not converted:
                value += " https://*.sharepoint.com"
            headers_out.append((name, edge.get(name, value)))
        headers_out += [("Via", "1.1 Caddy"), ("Alt-Svc", 'h3=":443"')]
        if parts.hostname == "www.lolly.tools":
            return preview_smoke.Response(308, [("Location", "https://lolly.tools/")], b"")
        if build is None:
            return preview_smoke.Response(502, [], b"")
        site = {path: base64.b64decode(data) for path, data in build["site"].items()}
        broken = image in behaviour["brokenSite"]
        fail_after = behaviour["watchFailAfter"].get(image)
        path = parts.path
        if path == "/healthz":
            return preview_smoke.Response(200, headers_out, b"ok\n")
        if path == "/release-frontend.sig.json":
            return preview_smoke.Response(200, headers_out, base64.b64decode(build["receipt"]))
        if path == "/":
            if broken or (fail_after is not None and count >= fail_after):
                return preview_smoke.Response(500, headers_out, b"")
            etag = '"' + sha(site["index.html.gz"]) + '"'
            return preview_smoke.Response(200, headers_out + [("ETag", etag)], site["index.html"])
        if path.startswith("/models/"):
            if path != "/models/a/config.json":
                return preview_smoke.Response(404, headers_out, b"")
            if method == "HEAD":
                return preview_smoke.Response(200, headers_out + [("Content-Length", "44")], b"")
            if (headers or {}).get("Range") == "bytes=0-0":
                return preview_smoke.Response(206, headers_out + [("Content-Range", "bytes 0-0/44")], b"{")
        page = {"/tools": "view/tools.html", "/info/": "info/index.html"}.get(path, path.lstrip("/"))
        if page in site:
            return preview_smoke.Response(200, headers_out, site[page])
        return preview_smoke.Response(404, headers_out, b"")
    return fetch


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def patch_node_modules(tool_lib, sandbox, state_path):
    """Import the node modules from a bundle directory and point them at the sandbox and fakes.
    As on the node, only the bundle's lib is importable: the repository's lib leaves sys.path."""
    sys.path[:] = [entry for entry in sys.path if not entry or Path(entry).resolve() != LIB.resolve()]
    if str(tool_lib) not in sys.path:
        sys.path.insert(0, str(tool_lib))
    import preview_anchors
    import preview_node
    import preview_smoke
    pin = json.loads(os.environ["FAKE_PIN"])
    preview_anchors.RELEASE_PUBLIC_KEY_JWK = pin
    preview_node.PATHS.update({"run": f"{sandbox}/var/lib/lolly-preview/run", "results": f"{sandbox}/var/lib/lolly-preview/results",
                               "lock": f"{sandbox}/run/lolly-preview/deploy.lock", "lockDir": f"{sandbox}/run/lolly-preview",
                               "imagefs": "/", "armed": f"{sandbox}/var/lib/lolly-preview/retention-armed",
                               "systemctl": os.environ["FAKE_BIN"] + "/systemctl",
                               "procStatus": f"{sandbox}/proc-status", "procAttr": f"{sandbox}/proc-attr",
                               "spool": f"{sandbox}/var/lib/lolly-preview/spool", "smokeCookie": f"{sandbox}/smoke-session"})
    if os.environ.get("FAKE_ING_PIN"):
        preview_anchors.ING_PUBLIC_KEY_JWK = json.loads(os.environ["FAKE_ING_PIN"])

    def capacity(_path):
        data = json.loads(Path(state_path).read_text())["capacity"]
        return data["total"], data["available"]
    preview_node.filesystem_bytes = capacity
    clock = FakeClock()
    preview_node.SLEEP, preview_node.CLOCK = clock.sleep, clock
    wall = os.environ.get("FAKE_WALL_UTC")  # HH:MM today, for the in-run backup-window check
    if wall:
        import calendar
        import time as real_time
        today = real_time.gmtime()
        stamp = calendar.timegm((today.tm_year, today.tm_mon, today.tm_mday, int(wall[:2]), int(wall[3:]), 0))
        preview_node.WALL = lambda: stamp
    if os.environ.get("FAKE_SITE") == "lolly.ing":
        import preview_deploy_ing_fakes
        preview_smoke.FETCH = preview_deploy_ing_fakes.make_ing_fetch(state_path)
    else:
        preview_smoke.FETCH = make_fetch(state_path)

    def check_dns(anchors, address):
        assert address == EDGE_ADDRESS, address
        with state_file(state_path) as state:
            state["dnsCalls"] = state.get("dnsCalls", 0) + 1
            failing = state["behaviour"].get("dnsFailures", 0) > 0 or state["behaviour"].get("dnsFailAt") == state["dnsCalls"]
            if state["behaviour"].get("dnsFailures", 0) > 0:
                state["behaviour"]["dnsFailures"] -= 1
        if failing:
            raise preview_node.Refusal("SMOKE_DNS", anchors["host"] + " does not resolve only to the edge address")
    preview_smoke.check_dns = check_dns
    return preview_node


def systemctl_main(argv):
    sandbox, state_path = os.environ["FAKE_SANDBOX"], os.environ["FAKE_STATE"]
    unit_state = Path(sandbox) / "unit-state"
    if argv[:3] == ["show", "-p", "ActiveState"]:
        print(unit_state.read_text() if unit_state.exists() else "inactive")
        return 0
    if argv[:3] == ["show", "-p", "Job"]:
        job = Path(sandbox) / "unit-job"
        print(job.read_text() if job.exists() else "")
        return 0
    if argv[:1] in (["daemon-reload"], ["reset-failed"]):
        return 0
    if argv[:1] == ["run-unit"]:
        delay = float(os.environ.get("FAKE_UNIT_DELAY", "0"))
        if delay:
            import time
            time.sleep(delay)
        return run_unit(sandbox, state_path, argv[1])
    if argv[:2] != ["start", "--no-block"]:
        return 1
    if os.environ.get("FAKE_UNIT_NEVER_STARTS"):
        return 0
    if os.environ.get("FAKE_UNIT_ASYNC"):  # like systemd: start returns at once and the unit runs on
        import subprocess
        unit_state.write_text("active")
        with open(Path(sandbox) / "unit-async.log", "a") as log:
            subprocess.Popen([sys.executable, "-S", os.environ["FAKE_BIN"] + "/systemctl", "run-unit", argv[2]],
                             stdout=log, stderr=log, start_new_session=True)
        return 0
    return run_unit(sandbox, state_path, argv[2])


def run_unit(sandbox, state_path, name):
    unit_state = Path(sandbox) / "unit-state"
    unit = (Path(sandbox) / "run/systemd/system" / name).read_text()
    starts = re.findall(r"^ExecStart=(.*)$", unit, re.M)
    stops = re.findall(r"^ExecStopPost=(.*)$", unit, re.M)
    assert len(starts) == 1 and len(stops) == 1

    def command(line):
        parts = line.split()
        assert parts[:3] == ["/usr/bin/python3", "-I", "-B"], parts
        return [p.replace("/var/lib/lolly-preview", f"{sandbox}/var/lib/lolly-preview") for p in parts[3:]]
    run_script, mode, request = command(starts[0])
    tool_lib = Path(run_script).parent.parent / "lib"
    preview_node = patch_node_modules(tool_lib, sandbox, state_path)
    app_update = Path(run_script).parent.parent / "app-update.py"
    crash = os.environ.get("FAKE_CRASH_PHASE")
    if crash:
        original = preview_node.Runner.annotate

        def annotate(self, values, *args, **kwargs):
            result = original(self, values, *args, **kwargs)
            if values.get("phase") == crash:
                raise KeyboardInterrupt
            return result
        preview_node.Runner.annotate = annotate
    switched = None
    if os.environ.get("FAKE_CRASH_AFTER_SWITCH"):  # lolly.ing writes its phase inside the switch patch
        import preview_ing_node
        switched = preview_ing_node.IngRunner.switch

        def switch(self, *args, **kwargs):
            switched(self, *args, **kwargs)
            raise KeyboardInterrupt
        preview_ing_node.IngRunner.switch = switch
    unit_state.write_text("active")
    environment = {"SERVICE_RESULT": "success", "EXIT_CODE": "exited", "EXIT_STATUS": "0"}
    try:
        code = preview_node.main([mode, request], app_update_path=app_update)
        environment["EXIT_STATUS"] = str(code)
    except KeyboardInterrupt:
        environment = {"SERVICE_RESULT": "signal", "EXIT_CODE": "killed", "EXIT_STATUS": "KILL"}
    if switched is not None:
        preview_ing_node.IngRunner.switch = switched
    if crash:
        preview_node.Runner.annotate = original
    unit_state.write_text("deactivating")
    stop_script, stop_mode, stop_request = command(stops[0])
    preview_node.main([stop_mode, stop_request], app_update_path=app_update, environment=environment)
    unit_state.write_text("inactive")
    return 0


class _RootStat:
    """os.lstat as root sees the sandbox: the test user's directories count as owned by uid 0."""

    def __init__(self, real):
        self.st_mode, self.st_uid = real.st_mode, (0 if real.st_uid == os.getuid() else real.st_uid)


UPLOAD_COMMAND = 'sudo -n python3 -I -c "import sys,base64;exec(base64.b64decode(sys.stdin.buffer.readline()))"'


def _load_bootstrap(head, sandbox):
    """Run the bootstrap program as the node would, with its fixed paths moved into the sandbox."""
    namespace = {"__name__": "bootstrap"}
    exec(compile(head, "bootstrap.py", "exec"), namespace)
    for name, value in (("ROOT", "/var/lib/lolly-preview"), ("RUN", "/var/lib/lolly-preview/run"),
                        ("RESULTS", "/var/lib/lolly-preview/results"), ("TMP", "/var/lib/lolly-preview/tmp"),
                        ("UNIT_PATH", "/run/systemd/system/lolly-preview-deploy.service"), ("LOCK_DIR", "/run/lolly-preview"),
                        ("LOCK", "/run/lolly-preview/deploy.lock"), ("START_LOCK", "/run/lolly-preview/start.lock"),
                        ("SPOOL", "/var/lib/lolly-preview/spool")):
        assert namespace[name] == value, name
        namespace[name] = sandbox + value
    namespace["SYSTEMCTL"] = os.environ["FAKE_BIN"] + "/systemctl"
    import types
    fake_os = types.ModuleType("os")
    fake_os.__dict__.update(os.__dict__)
    fake_os.geteuid = lambda: 0
    fake_os.lstat = lambda path: _RootStat(os.lstat(path))
    fake_os.chdir = lambda path: None
    namespace["os"] = fake_os
    fake_time = types.ModuleType("time")  # the start wait sleeps on a fake clock
    fake_time.now = 0.0
    fake_time.monotonic = lambda: fake_time.now
    fake_time.sleep = lambda seconds: setattr(fake_time, "now", fake_time.now + seconds)
    namespace["time"] = fake_time

    def above_reserve(_path):
        data = json.loads(Path(os.environ["FAKE_STATE"]).read_text())["capacity"]
        return data["available"] - (data["total"] // 4 + 512 * MIB)
    namespace["above_reserve"] = above_reserve
    os.makedirs(f"{sandbox}/run/systemd/system", exist_ok=True)
    return namespace


def ssh_main(argv):
    """Check the route flags, then run the bootstrap program as the node would, inside the sandbox."""
    sandbox = os.environ["FAKE_SANDBOX"]
    required = {"-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=12"}
    if not required <= set(argv) or f"-oUserKnownHostsFile={os.environ['FAKE_KNOWN_HOSTS']}" not in argv or \
            argv[-1] not in ("sudo -n python3 -I -", UPLOAD_COMMAND) or argv[argv.index("-J") + 1] != "sles@192.0.2.1" or \
            argv[-2] != "sles@10.0.0.2":
        print("unexpected ssh invocation", file=sys.stderr)
        return 255
    if os.environ.get("FAKE_SSH_DOWN"):
        return 255
    if argv[-1] == UPLOAD_COMMAND:  # the program is the first stdin line; the archive follows it
        program = base64.b64decode(sys.stdin.buffer.readline()).decode()
        head, _, last = program.rstrip("\n").rpartition("\n")
        header = json.loads(base64.b64decode(re.fullmatch(r"upload\(json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]*)'\)\.decode\(\)\)\)",
                                                          last).group(1)))
        namespace = _load_bootstrap(head, sandbox)
        try:
            namespace["upload"](header)
        except SystemExit:
            pass
        return 0
    program = sys.stdin.read()
    head, _, last = program.rstrip("\n").rpartition("\n")
    payload = json.loads(base64.b64decode(re.fullmatch(r"main\(json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]*)'\)\.decode\(\)\)\)", last).group(1)))
    namespace = _load_bootstrap(head, sandbox)
    if payload.get("action") == "read":
        work = Path(sandbox) / "read-modules"
        if not work.exists():
            with __import__("tarfile").open(fileobj=io.BytesIO(base64.b64decode(payload["bundle"])), mode="r:gz") as archive:
                archive.extractall(work)
        patch_node_modules(work / "lib", sandbox, os.environ["FAKE_STATE"])
    if payload.get("action") == "start" and os.environ.get("FAKE_START_DROPPED"):
        return 255  # the link dropped before the node ran anything
    if payload.get("action") == "poll" and os.environ.get("FAKE_POLL_DOWN"):
        return 255
    namespace["main"](payload)
    if payload.get("action") == "start" and os.environ.get("FAKE_START_REPLY_LOST"):
        return 255  # the run started, but the reply never came back
    return 0


# Fake GitHub ---------------------------------------------------------------------
def receipt_zip(build, run_id, attempt, pin, thumbprint, **overrides):
    import zipfile
    web = {"imageId": "sha256:" + sha(build["image"].encode()), "digest": build["image"], "platform": "linux/amd64", "source": build["sha"]}
    release = {"source": build["sha"], "runId": str(run_id), "runAttempt": attempt, "neutralProfile": True,
               "images": {"web": web}, "candidateRuntimeQualified": False}
    files = {"release.json": release, "web.json": web, "public.jwk.json": pin,
             "catalog.json": {"verified": True, "files": 10, "tools": 2, "indexSha256": "7" * 64, "keyId": thumbprint},
             "web-boot.json": {"serviceBootPassed": True, "results": {"web": 200}}}
    for name, value in overrides.items():
        files[name] = value
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, value in files.items():
            if value is not None:
                archive.writestr(name, json.dumps(value))
    return base64.b64encode(buffer.getvalue()).decode()


def run_object(run_id, sha_, path=".github/workflows/deployment-suse.yml", event="workflow_dispatch", status="completed",
               conclusion="success", attempt=1, created="2026-10-23T05:00:00Z", repository=REPO):
    return {"id": run_id, "path": path, "event": event, "head_branch": "main", "head_sha": sha_, "status": status,
            "conclusion": conclusion, "run_attempt": attempt, "created_at": created,
            "repository": {"full_name": repository}, "head_repository": {"full_name": repository}}


TOOL_MAIN = "e" * 40


def gh_main(argv):
    state_path = os.environ["FAKE_GH_STATE"]
    if argv[:1] != ["api"]:
        return 2
    args = argv[1:]
    method, accept, data = "GET", None, None
    if "--method" in args:
        method = args[args.index("--method") + 1]
    if "-H" in args:
        accept = args[args.index("-H") + 1]
    if "--input" in args:
        data = json.loads(sys.stdin.read())
    path = [a for a in args if not a.startswith("-") and a not in (method, accept)][-1]
    parts = urlsplit(path)
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    route = parts.path
    with state_file(state_path) as gh:
        gh["calls"].append({"method": method, "path": path, "body": data})
        if os.environ.get("FAKE_SITE") == "lolly.ing":
            import preview_deploy_ing_fakes
            code = preview_deploy_ing_fakes.gh_ing_route(gh, method, route, query, data, sys.stdout)
            if code is not None:
                return code
        if gh.get("flaky", 0) > 0 and re.fullmatch(rf"repos/{REPO}/actions/runs/\d+", route):
            gh["flaky"] -= 1
            print("gh: Bad Gateway (HTTP 502)", file=sys.stderr)
            return 1
        if method == "POST":
            if not route.endswith("/actions/workflows/deployment-suse.yml/dispatches") or data.get("ref") != "refs/heads/main":
                return 1
            run = gh.get("onDispatch")
            if run:
                gh["runs"].append(run)
                gh["onDispatch"] = None
            return 0
        if route == "repos/lolly-tools/lolly-work/git/ref/heads/main":
            sys.stdout.write(json.dumps({"ref": "refs/heads/main", "object": {"type": "commit", "sha": TOOL_MAIN}}))
            return 0
        if route.startswith("repos/lolly-tools/lolly-work/compare/"):
            if not route.endswith("..." + TOOL_MAIN):
                print("compare against something other than the main SHA", file=sys.stderr)
                return 1
            sys.stdout.write(json.dumps({"status": gh.get("toolCompare", "identical")}))
            return 0
        if route == f"repos/{REPO}/git/ref/heads/main":
            sys.stdout.write(json.dumps({"ref": "refs/heads/main", "object": {"type": "commit", "sha": gh["mainHead"]}}))
            return 0
        if route.startswith(f"repos/{REPO}/compare/"):
            spec = route.rsplit("/", 1)[1]
            if not re.fullmatch(r"[0-9a-f]{40}\.\.\.[0-9a-f]{40}", spec):
                print("compare must name two SHAs, never a branch name", file=sys.stderr)
                return 1
            sys.stdout.write(json.dumps({"status": gh["compare"].get(spec, "ahead")}))
            return 0
        match = re.fullmatch(rf"repos/{REPO}/actions/workflows/(ci|deployment-suse)\.yml/runs", route)
        if match:
            runs = gh["ciRuns"] if match.group(1) == "ci" else gh["runs"]
            selected = [r for r in runs if (not query.get("head_sha") or r["head_sha"] == query["head_sha"])
                        and (not query.get("status") or r["status"] == query["status"])]
            sys.stdout.write(json.dumps({"workflow_runs": selected}))
            return 0
        match = re.fullmatch(rf"repos/{REPO}/actions/runs/(\d+)", route)
        if match:
            run = next(r for r in gh["runs"] + gh["ciRuns"] if r["id"] == int(match.group(1)))
            sequence = gh["statusSequence"].get(str(run["id"]))
            if sequence:
                run["status"] = sequence.pop(0)
                run["conclusion"] = gh["finalConclusion"] if run["status"] == "completed" else None
            sys.stdout.write(json.dumps(run))
            return 0
        match = re.fullmatch(rf"repos/{REPO}/actions/runs/(\d+)/artifacts", route)
        if match:
            sys.stdout.write(json.dumps({"artifacts": gh["artifacts"].get(match.group(1), [])}))
            return 0
        match = re.fullmatch(rf"repos/{REPO}/actions/artifacts/(\d+)/zip", route)
        if match:
            sys.stdout.buffer.write(base64.b64decode(gh["zips"][match.group(1)]))
            return 0
        match = re.fullmatch(rf"repos/{REPO}/contents/(.+)", route)
        if match:
            key = query["ref"] + ":" + match.group(1)
            if key not in gh["files"]:
                print("gh: Not Found (HTTP 404)", file=sys.stderr)
                return 1
            sys.stdout.buffer.write(base64.b64decode(gh["files"][key]))
            return 0
        if route == f"repos/{REPO}/actions/variables/VITE_CONNECTOR_ORIGINS":
            variable = gh.get("variable")
            if variable is None:
                print("gh: Not Found (HTTP 404)", file=sys.stderr)
                return 1
            sys.stdout.write(json.dumps(variable))
            return 0
        if route == f"repos/{REPO}/actions/organization-variables":
            variables = gh.get("orgVariables", [])
            sys.stdout.write(json.dumps({"total_count": len(variables), "variables": variables}))
            return 0
        print("gh: unexpected " + route, file=sys.stderr)
        return 1


def source_files(build):
    files = {"deploy/docker/security-headers.conf": SECURITY_HEADERS, "deploy/docker/nginx.conf": NGINX,
             "deploy/docker/delivery-maps.conf": "maps\n", "deploy/docker/delivery-headers.conf": "headers\n"}
    files.update(build["formats"])
    encoded = {build["sha"] + ":" + path: base64.b64encode(text.encode()).decode() for path, text in files.items()}
    encoded[build["sha"] + ":shells/web/models-manifest.json"] = base64.b64encode(MODELS).decode()
    return encoded


CHECK_TARGET = '''#!/usr/bin/env python3
# Test double of lolly-private/production/check-target.py with the --site patch's identities.
import os, sys
ADDRESS = {address!r}
NODE_NAME = {node!r}
NODE_UID = {node_uid!r}
CLUSTER_UID = {cluster!r}
NAMESPACE_UIDS = {{'lolly-public': {namespace!r}, 'lolly-private': '55555555-5555-4555-8555-555555555555'}}
DEPLOYMENTS = {{'lolly-private/lolly-work': '66666666-6666-4666-8666-666666666666', 'lolly-edge/sovereign-edge': '77777777-7777-4777-8777-777777777777'}}
SITE_DEPLOYMENTS = {{'lolly-public/sovereign-web': {deployment!r}}}
DATABASE_SECRET = 'lolly-work-final-instance-test'
SSH = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=12', '-oStrictHostKeyChecking=yes']
CURRENT_SSH = SSH + ['-oUserKnownHostsFile=' + {known!r}, '-J', 'sles@192.0.2.1', 'sles@10.0.0.2']
CURRENT_READ = """
import json
k=[{k3s!r},'kubectl','--kubeconfig',
   {kubeconfig!r},
   '--context',{context!r}]
"""
if __name__ == '__main__':
    if sys.argv[1:] not in (['--site', 'lolly.tools'], ['--site', 'lolly.ing']):
        print('FAIL: This preflight takes only --site lolly.tools|lolly.ing', file=sys.stderr)
        sys.exit(1)
    if os.environ.get('FAKE_CHECK_TARGET') == 'fail':
        print('FAIL: Production Deployment identity mismatch: lolly-public/sovereign-web', file=sys.stderr)
        sys.exit(1)
    print('{{"result": "PASS"}}')
'''


def write_check_target(path, k3s, known_hosts):
    Path(path).write_text(CHECK_TARGET.format(address=EDGE_ADDRESS, node=NODE_NAME, node_uid=NODE_UID, cluster=CLUSTER_UID,
                                              namespace=NAMESPACE_UID, deployment=DEPLOYMENT_UID, known=str(known_hosts),
                                              k3s=str(k3s), kubeconfig=KUBECONFIG, context=CONTEXT))
    Path(path).chmod(0o600)


def note_call(name, argv):
    """Optional call log for profiling the suite (FAKE_CALL_LOG)."""
    path = os.environ.get("FAKE_CALL_LOG")
    if path:
        with open(path, "a") as out:
            out.write(name + " " + " ".join(word for word in argv[:6] if not word.startswith("/") and len(word) < 60) + "\n")


def write_executables(bin_dir):
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name, function in (("gh", "gh_main"), ("ssh", "ssh_main"), ("k3s", "k3s_main"), ("systemctl", "systemctl_main")):
        path = bin_dir / name
        path.write_text(f"#!{sys.executable} -S\nimport sys\nsys.dont_write_bytecode = True\n"
                        f"sys.path.insert(0, {str(TESTS)!r})\nimport preview_deploy_fakes as f\nf.note_call({name!r}, sys.argv[1:])\n"
                        f"raise SystemExit(f.{function}(sys.argv[1:]))\n")
        path.chmod(0o755)
    return bin_dir


def registry_opener(builds):
    manifests = {"sha256:" + sha(base64.b64decode(b["manifest"])): base64.b64decode(b["manifest"]) for b in builds.values()}

    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def opener(request, timeout=None):
        url = request.full_url
        if "/token?" in url:
            return Response(json.dumps({"token": "anonymous"}).encode())
        digest = url.rsplit("/", 1)[1]
        if digest in manifests:
            return Response(manifests[digest])
        raise OSError("not found")
    return opener


def lock_for(root, checkout):
    """tool.lock.json as make-tool-lock.py writes it, for the test checkout."""
    import preview_mac
    files = {}
    for relative, path in preview_mac.tool_files(root):
        mode = "x" if os.stat(path).st_mode & 0o100 else "-"
        files[relative] = f"{mode} {sha(path.read_bytes())}"
    return {"version": 1, "repository": "lolly-tools/lolly-work", "checkout": str(checkout), "commit": TOOL_MAIN,
            "toolSha256": preview_mac.tool_digest(root), "files": files, "generatedAt": "2026-10-23T00:00:00Z", "note": "test"}
