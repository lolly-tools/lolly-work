# SPDX-License-Identifier: MPL-2.0
"""Fakes for tests/test_preview_deploy.py: gh, ssh, k3s (kubectl, crictl, ctr), systemctl and check-target.

Every fake is a small executable that calls into this module and keeps its state
in a JSON file, so the command under test runs its real subprocess paths. No
network, cluster, node or GitHub is ever contacted.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
import re
import secrets
import sys
import types
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
LIB = ROOT / "deploy" / "preview" / "lib"
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))

import preview_receipt as R  # noqa: E402
from preview_common import canonical_js_json  # noqa: E402

KUBECONFIG = "/root/test.kubeconfig"
CONTEXT = "test"
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
    x, y, z = point
    inverse = pow(z, -1, R.P)
    return x * inverse * inverse % R.P, y * inverse * inverse * inverse % R.P


def make_key():
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
    labels = {"app.kubernetes.io/component": "web", "app.kubernetes.io/instance": "sovereign", "app.kubernetes.io/name": "lolly-sovereign"}
    return {"apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": DEPLOYMENT, "namespace": NAMESPACE, "uid": "deployment-uid", "resourceVersion": "100",
                         "generation": 23, "labels": dict(labels, **{"helm.sh/chart": "lolly-sovereign-0.1.3"}),
                         "annotations": dict({"deployment.kubernetes.io/revision": "23"}, **(annotations or {}))},
            "spec": {"replicas": 1, "revisionHistoryLimit": 2 if not converted else 5, "progressDeadlineSeconds": 600,
                     "selector": {"matchLabels": labels}, "strategy": {"type": "Recreate"},
                     "template": {"metadata": {"labels": labels, "annotations": {"lolly.tools/models-release": "models-" + "1" * 64}},
                                  "spec": {"containers": [{"name": "web", "image": image, "imagePullPolicy": "IfNotPresent",
                                                           "resources": {"limits": {"memory": "768Mi"}}, "volumeMounts": mounts}],
                                           "volumes": volumes, "securityContext": {"runAsNonRoot": True}}}},
            "status": {"observedGeneration": 23, "replicas": 1, "readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1}}


def preview_annotations(build, phase="accepted", previous=None, deploys="0"):
    import preview_common
    values = {"phase": phase, "source": build["sha"], "image": build["image"], "ci-run": "100",
              "formats": preview_common.compact({"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}),
              "expect": preview_common.compact(expect_for(build)), "layout": "image-root", "deploys": deploys,
              "deploy-id": "20261023T000000Z-tools-convert-" + build["sha"][:8]}
    if previous is not None:
        values["previous"] = preview_common.compact(previous)
    return {"lolly.tools/preview-" + k: v for k, v in values.items()}


def cluster_state(builds, live, converted=True, annotations=None, registry=None):
    deploy = deployment(live["image"], converted, annotations)
    return {
        "namespaces": {"kube-system": "cluster-uid", NAMESPACE: "namespace-uid"},
        "node": {"name": "node-1", "uid": "node-uid"},
        "deployment": deploy,
        "replicasets": [{"revision": 23, "image": live["image"], "template": _template_digest(deploy)}],
        "pod": _pod(deploy, 23),
        "configmaps": {"lolly-public-nginx-test-v1": {"default.conf": "server { listen 8080; }\n", "security-headers.conf": "old\n",
                                                       "delivery-maps.conf": "maps\n", "delivery-headers.conf": "headers\n"}},
        "pvcs": [{"metadata": {"name": n, "uid": n + "-uid", "creationTimestamp": "2026-10-21T00:00:00Z", "labels": {}}}
                 for n in ("lolly-public-web-test-v1", "lolly-public-models-test-v1", "unrelated-claim")],
        "images": {live["image"]: {"id": "sha256:" + sha(live["image"].encode()), "size": 120 * MIB, "pinned": True}},
        "registry": registry if registry is not None else {b["image"]: True for b in builds.values()},
        "builds": {b["image"]: b for b in builds.values()},
        "behaviour": {"notReady": [], "brokenSite": [], "watchFailAfter": {}, "restarts": {}, "workingSet": 100 * MIB},
        "capacity": {"total": 100 * GIB, "available": 40 * GIB},
        "fetches": {},
        "writes": [],
    }


def _template_digest(deploy):
    return sha(json.dumps(deploy["spec"]["template"], sort_keys=True).encode())


def _pod(deploy, revision):
    image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
    return {"metadata": {"name": f"sovereign-web-{revision}", "namespace": NAMESPACE, "labels": deploy["spec"]["selector"]["matchLabels"]},
            "spec": copy.deepcopy(deploy["spec"]["template"]["spec"]),
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
                       "containerStatuses": [{"name": "web", "ready": True, "restartCount": 0,
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
        index = int(last) if isinstance(parent, list) else last
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
        state["replicasets"].append({"revision": revision, "image": deploy["spec"]["template"]["spec"]["containers"][0]["image"],
                                     "template": digest})
        state["replicasets"] = sorted(state["replicasets"], key=lambda rs: rs["revision"])[-(deploy["spec"].get("revisionHistoryLimit", 10) + 1):]
        deploy["metadata"]["annotations"]["deployment.kubernetes.io/revision"] = str(revision)
        pod = _pod(deploy, revision)
        image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
        ready = image not in state["behaviour"]["notReady"]
        pod["status"]["conditions"][0]["status"] = "True" if ready else "False"
        pod["status"]["containerStatuses"][0]["ready"] = ready
        pod["status"]["containerStatuses"][0]["restartCount"] = state["behaviour"]["restarts"].get(image, 0)
        state["pod"] = pod
        state["images"].setdefault(image, {"id": "sha256:" + sha(image.encode()), "size": 120 * MIB, "pinned": False})
        deploy["status"] = {"observedGeneration": deploy["metadata"]["generation"], "replicas": 1,
                            "readyReplicas": 1 if ready else 0, "availableReplicas": 1 if ready else 0, "updatedReplicas": 1}
    elif changed_spec:
        deploy["status"]["observedGeneration"] = deploy["metadata"]["generation"]
    state["deployment"] = deploy


def _replicaset_objects(state):
    deploy = state["deployment"]
    items = []
    for rs in state["replicasets"]:
        items.append({"kind": "ReplicaSet", "metadata": {"name": f"sovereign-web-rs{rs['revision']}", "namespace": NAMESPACE,
                      "annotations": {"deployment.kubernetes.io/revision": str(rs["revision"])},
                      "ownerReferences": [{"kind": "Deployment", "uid": deploy["metadata"]["uid"]}]},
                      "spec": {"template": {"spec": {"containers": [{"name": "web", "image": rs["image"]}],
                                                     "volumes": deploy["spec"]["template"]["spec"]["volumes"]
                                                     if rs["template"] == _template_digest(deploy) else
                                                     [{"name": "public-delivery", "persistentVolumeClaim": {"claimName": "lolly-public-web-test-v1"}}]}}}})
    return items


def k3s_main(argv):
    state_path = os.environ["FAKE_STATE"]
    out = sys.stdout
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
                out.write(json.dumps(state["deployment"]))
            elif args[:2] == ["patch", "deployment"]:
                patch = json.loads(args[args.index("--patch") + 1])
                try:
                    after = apply_json_patch(state["deployment"], patch)
                except (ValueError, KeyError, IndexError):
                    print("the patch test failed", file=sys.stderr)
                    return 1
                if "--dry-run=server" not in args:
                    state["writes"].append(patch)
                    _apply_deployment_change(state, state["deployment"], after)
                    after = state["deployment"]
                out.write(json.dumps(after))
            elif args[:2] == ["rollout", "status"]:
                image = state["deployment"]["spec"]["template"]["spec"]["containers"][0]["image"]
                return 1 if image in state["behaviour"]["notReady"] else 0
            elif args[:2] == ["get", "pods"] and "-l" in args:
                out.write(json.dumps({"items": [state["pod"]]}))
            elif args[:2] == ["get", "pods,replicasets"]:
                pod = dict(state["pod"], kind="Pod")
                other = {"kind": "Pod", "metadata": {"name": "mcp", "namespace": NAMESPACE},
                         "spec": {"containers": [{"name": "mcp", "image": "ghcr.io/lolly-tools/lolly-mcp@sha256:" + "9" * 64}]}}
                out.write(json.dumps({"items": [pod, other] + _replicaset_objects(state)}))
            elif args[:2] == ["get", "configmap"]:
                out.write(json.dumps({"data": state["configmaps"][args[2]]}))
            elif args[:2] == ["get", "persistentvolumeclaims"]:
                out.write(json.dumps({"items": state["pvcs"]}))
            elif args[:2] == ["get", "pods,replicasets,statefulsets"]:
                pod = dict(state["pod"], kind="Pod")
                out.write(json.dumps({"items": [pod] + _replicaset_objects(state)}))
            else:
                print("unsupported kubectl " + " ".join(args[:2]), file=sys.stderr)
                return 1
        return 0
    with state_file(state_path) as state:
        if argv[:2] == ["crictl", "pull"]:
            if not state["registry"].get(argv[2]):
                return 1
            state["images"][argv[2]] = {"id": "sha256:" + sha(argv[2].encode()), "size": 120 * MIB, "pinned": False}
            state["writes"].append(["pull", argv[2]])
        elif argv[:2] == ["crictl", "inspecti"]:
            if argv[-1] not in state["images"]:
                return 1
            out.write(json.dumps({"status": {"repoDigests": [argv[-1]]}}))
        elif argv[:2] == ["crictl", "images"]:
            out.write(json.dumps({"images": [{"id": v["id"], "repoDigests": [k], "size": str(v["size"]), "pinned": v["pinned"]}
                                             for k, v in state["images"].items()]}))
        elif argv[:2] == ["crictl", "stats"]:
            image = state["pod"]["spec"]["containers"][0]["image"]
            used = state["behaviour"].get("workingSetByImage", {}).get(image, state["behaviour"]["workingSet"])
            out.write(json.dumps({"stats": [{"memory": {"workingSetBytes": {"value": str(used)}}}]}))
        elif argv[:2] == ["crictl", "rmi"]:
            for name, image in list(state["images"].items()):
                if image["id"] == argv[2]:
                    if image["pinned"]:
                        return 1
                    del state["images"][name]
                    state["writes"].append(["rmi", name])
        elif argv[:5] == ["ctr", "-n", "k8s.io", "images", "ls"]:
            lines = ["REF TYPE DIGEST SIZE PLATFORMS LABELS"]
            for name, image in state["images"].items():
                lines.append(f"{name} application/vnd.oci.image.manifest.v1+json {name.partition('@')[2]} 1MiB linux/amd64 -")
            out.write("\n".join(lines) + "\n")
        elif argv[:5] == ["ctr", "-n", "k8s.io", "images", "label"]:
            name, label = argv[5], argv[6]
            state["images"][name]["pinned"] = label == "io.cri-containerd.pinned=pinned"
        else:
            print("unsupported " + " ".join(argv[:2]), file=sys.stderr)
            return 1
    return 0


# Fake edge (patched into preview_smoke.FETCH inside the fake node processes) ----
def make_fetch(state_path):
    import preview_smoke

    def fetch(url, method="GET", headers=None, limit=None):
        with state_file(state_path) as state:
            deploy = state["deployment"]
            image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
            converted = not any(v["name"] == "public-delivery" for v in deploy["spec"]["template"]["spec"]["volumes"])
            build = state["builds"].get(image)
            parts = urlsplit(url)
            count = state["fetches"].get(image, 0)
            if parts.path == "/":
                state["fetches"][image] = count + 1
        headers_out = [(name, value) for name, value in expected_headers()]
        if not converted:
            headers_out = [(n, v + " https://*.sharepoint.com" if n == "Content-Security-Policy" else v) for n, v in headers_out]
        if parts.hostname == "www.lolly.tools":
            return preview_smoke.Response(308, [("Location", "https://lolly.tools/")], b"")
        if build is None:
            return preview_smoke.Response(502, [], b"")
        site = {path: base64.b64decode(data) for path, data in build["site"].items()}
        broken = image in state["behaviour"]["brokenSite"]
        fail_after = state["behaviour"]["watchFailAfter"].get(image)
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
    """Import the node modules from a bundle directory and point them at the sandbox and fakes."""
    if str(tool_lib) not in sys.path:
        sys.path.insert(0, str(tool_lib))
    import preview_anchors
    import preview_node
    import preview_smoke
    pin = json.loads(os.environ["FAKE_PIN"])
    preview_anchors.RELEASE_PUBLIC_KEY_JWK = pin
    preview_node.PATHS.update({"run": f"{sandbox}/var/lib/lolly-preview/run", "results": f"{sandbox}/var/lib/lolly-preview/results",
                               "lock": f"{sandbox}/run/lock/lolly-preview-deploy.lock", "imagefs": "/",
                               "systemctl": os.environ["FAKE_BIN"] + "/systemctl"})

    def capacity(_path):
        data = json.loads(Path(state_path).read_text())["capacity"]
        return data["total"], data["available"]
    preview_node.filesystem_bytes = capacity
    clock = FakeClock()
    preview_node.SLEEP, preview_node.CLOCK = clock.sleep, clock
    preview_smoke.FETCH = make_fetch(state_path)
    def check_dns(anchors, address):
        with state_file(state_path) as state:
            failing = state["behaviour"].get("dnsFailures", 0) > 0
            if failing:
                state["behaviour"]["dnsFailures"] -= 1
        if failing:
            raise preview_node.Refusal("SMOKE_DNS", "lolly.tools does not resolve only to the edge address")
    preview_smoke.check_dns = check_dns
    return preview_node


def systemctl_main(argv):
    sandbox, state_path = os.environ["FAKE_SANDBOX"], os.environ["FAKE_STATE"]
    unit_state = Path(sandbox) / "unit-state"
    if argv[:3] == ["show", "-p", "ActiveState"]:
        print(unit_state.read_text() if unit_state.exists() else "inactive")
        return 0
    if argv[:1] in (["daemon-reload"], ["reset-failed"]):
        return 0
    if argv[:2] != ["start", "--no-block"]:
        return 1
    unit = (Path(sandbox) / "run/systemd/system" / argv[2]).read_text()
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
    unit_state.write_text("active")
    environment = {"SERVICE_RESULT": "success", "EXIT_CODE": "exited", "EXIT_STATUS": "0"}
    try:
        code = preview_node.main([mode, request], app_update_path=app_update)
        environment["EXIT_STATUS"] = str(code)
    except KeyboardInterrupt:
        environment = {"SERVICE_RESULT": "signal", "EXIT_CODE": "killed", "EXIT_STATUS": "KILL"}
    if crash:
        preview_node.Runner.annotate = original
    unit_state.write_text("deactivating")
    stop_script, stop_mode, stop_request = command(stops[0])
    preview_node.main([stop_mode, stop_request], app_update_path=app_update, environment=environment)
    unit_state.write_text("inactive")
    return 0


def ssh_main(argv):
    """Check the route flags, then run the bootstrap program as the node would, inside the sandbox."""
    sandbox = os.environ["FAKE_SANDBOX"]
    required = {"-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=12"}
    if not required <= set(argv) or not any(a.startswith("-oUserKnownHostsFile=/") for a in argv) or \
            argv[-1] != "sudo -n python3 -" or "-J" not in argv:
        print("unexpected ssh invocation", file=sys.stderr)
        return 255
    if os.environ.get("FAKE_SSH_DOWN"):
        return 255
    program = sys.stdin.read()
    head, _, last = program.rstrip("\n").rpartition("\n")
    payload = json.loads(base64.b64decode(re.fullmatch(r"main\(json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]*)'\)\.decode\(\)\)\)", last).group(1)))
    namespace = {"__name__": "bootstrap"}
    exec(compile(head, "bootstrap.py", "exec"), namespace)
    for name, value in (("ROOT", "/var/lib/lolly-preview"), ("RUN", "/var/lib/lolly-preview/run"),
                        ("RESULTS", "/var/lib/lolly-preview/results"), ("TMP", "/var/lib/lolly-preview/tmp"),
                        ("UNIT_PATH", "/run/systemd/system/lolly-preview-deploy.service"),
                        ("LOCK", "/run/lock/lolly-preview-deploy.lock"), ("START_LOCK", "/run/lock/lolly-preview-start.lock")):
        assert namespace[name] == value, name
        namespace[name] = sandbox + value
    namespace["SYSTEMCTL"] = os.environ["FAKE_BIN"] + "/systemctl"
    fake_os = types.ModuleType("os")
    fake_os.__dict__.update(os.__dict__)
    fake_os.geteuid = lambda: 0
    fake_os.chdir = lambda path: None
    namespace["os"] = fake_os
    for directory in ("run/systemd/system", "run/lock"):
        os.makedirs(f"{sandbox}/{directory}", exist_ok=True)
    if payload.get("action") == "read":
        work = Path(sandbox) / "read-modules"
        if not work.exists():
            with __import__("tarfile").open(fileobj=io.BytesIO(base64.b64decode(payload["bundle"])), mode="r:gz") as archive:
                archive.extractall(work)
        patch_node_modules(work / "lib", sandbox, os.environ["FAKE_STATE"])
    namespace["main"](payload)
    return 0


# Fake GitHub ---------------------------------------------------------------------
def receipt_zip(build, run_id, attempt, pin, thumbprint, **overrides):
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
        if method == "POST":
            if not route.endswith("/actions/workflows/deployment-suse.yml/dispatches"):
                return 1
            run = gh.get("onDispatch")
            if run:
                gh["runs"].append(run)
                gh["onDispatch"] = None
            return 0
        if route.startswith("repos/lolly-tools/lolly-work/compare/"):
            sys.stdout.write(json.dumps({"status": gh.get("toolCompare", "identical")}))
            return 0
        if route == f"repos/{REPO}/git/ref/heads/main":
            sys.stdout.write(json.dumps({"ref": "refs/heads/main", "object": {"type": "commit", "sha": gh["mainHead"]}}))
            return 0
        if route.startswith(f"repos/{REPO}/compare/"):
            spec = route.rsplit("/", 1)[1]
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
            run = next(r for r in gh["runs"] if r["id"] == int(match.group(1)))
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
        print("gh: unexpected " + route, file=sys.stderr)
        return 1


def source_files(build):
    files = {"deploy/docker/security-headers.conf": SECURITY_HEADERS, "deploy/docker/nginx.conf": NGINX,
             "deploy/docker/delivery-maps.conf": "maps\n", "deploy/docker/delivery-headers.conf": "headers\n"}
    files.update(build["formats"])
    encoded = {build["sha"] + ":" + path: base64.b64encode(text.encode()).decode() for path, text in files.items()}
    encoded[build["sha"] + ":shells/web/models-manifest.json"] = base64.b64encode(MODELS).decode()
    return encoded


def check_target_main(argv):
    if argv != ["--site", "lolly.tools"]:
        print("FAIL: This preflight takes no target overrides or deploy commands", file=sys.stderr)
        return 1
    if os.environ.get("FAKE_CHECK_TARGET") == "fail":
        print("FAIL: Production Deployment is not reconciled and ready: lolly-public/sovereign-web", file=sys.stderr)
        return 1
    print(json.dumps({"result": "PASS"}))
    return 0


def write_executables(bin_dir):
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name, function in (("gh", "gh_main"), ("ssh", "ssh_main"), ("k3s", "k3s_main"),
                           ("systemctl", "systemctl_main"), ("check-target.py", "check_target_main")):
        path = bin_dir / name
        path.write_text(f"#!{sys.executable}\nimport sys\nsys.dont_write_bytecode = True\n"
                        f"sys.path.insert(0, {str(TESTS)!r})\nimport preview_deploy_fakes as f\n"
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
