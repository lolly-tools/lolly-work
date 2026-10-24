# SPDX-License-Identifier: MPL-2.0
"""lolly.ing fakes for tests/test_preview_deploy_ing.py, layered on preview_deploy_fakes.

The same executables (gh, ssh, k3s, systemctl) route here when FAKE_SITE is
lolly.ing. They model what the lolly.ing path touches: the lolly-private
Deployment and its generation ConfigMaps, the backup CronJob and the Jobs the
command creates, containerd import and content, Postgres's migration ledger and
Work's catalog generation fence, the private suse-lolly run and the edge. Nothing
real is contacted.
"""

from __future__ import annotations

import base64
import copy
import io
import json
import os
import re
import sys
import time
from urllib.parse import urlsplit

import preview_deploy_fakes as F

ING_NAMESPACE = "lolly-private"
ING_NAMESPACE_UID = "55555555-5555-4555-8555-555555555555"
ING_DEPLOYMENT_UID = "66666666-6666-4666-8666-666666666666"
DATABASE_SECRET = "lolly-work-final-instance-test"
ING_IMAGE = "docker.io/library/lolly-ing-instance"
LEGACY_IMAGE = "docker.io/library/lolly-server@sha256:" + "c" * 64
SMOKE_SUB = "smoke-member-1"
SMOKE_COOKIE = "lw_session=" + "s" * 40
PACK_ASSET = "/catalog/assets/suse/logo/primary.svg"
SUSE_REPO = "lolly-tools/suse-lolly"
ING_LABELS = {"app.kubernetes.io/instance": "lolly-work", "app.kubernetes.io/name": "lolly-work"}
RELEASE_THUMBPRINT = "5zVngG6s-652_L8Zdok5PTfQ6vxdPAYfcpBWxMtzs5c"
CRON = "lolly-postgres-offhost-backup"
sha = F.sha


def b64(data):
    return base64.b64encode(data).decode()


def unb64(text):
    return base64.b64decode(text)


def sign_raw(d, message):
    """r||s, as WebCrypto signs Work's catalog envelopes."""
    der = F.sign(d, message)
    r_length = der[3]
    r = int.from_bytes(der[4:4 + r_length], "big")
    s = int.from_bytes(der[6 + r_length:], "big")
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def migration(name, cls="additive"):
    text = f"-- {name}\ncreate table if not exists t_{name[:4]} (id int);\n"
    return {"name": name, "sha256": sha(text.encode()), "class": cls}


BASE_MIGRATIONS = [migration(f"{n:04d}_base_{n}.sql") for n in range(1, 4)]
FORMATS = {"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}


def instance_json(generation, name="lolly.ing"):
    return json.dumps({"deployment": {"mode": "production"},
                       "instance": {"name": name, "baseUrl": "https://lolly.ing", "catalogPublicationGeneration": generation,
                                    "pack": "/app/packs/lolly-ing", "shellDir": "/app/shell"},
                       "policy": {"defaultAccessMode": "gated", "guestLinks": {"enabled": False}, "ai": {"enabled": False}},
                       "render": {"worker": {"url": "https://worker.lolly-private.svc:8791", "timeoutMs": 60000}}}, indent=2) + "\n"


def make_ing_build(key, ssha, label, migrations=None, seq=3000, work="1" * 40, lolly="2" * 40, formats=None,
                   shell_pin=None, receipt_key=None):
    """One private instance build: its OCI archive, digests, served shell and signed receipt."""
    from preview_common import canonical_js_json
    import preview_receipt as R
    d, jwk = key
    thumb = R.jwk_thumbprint(jwk)
    migrations = list(BASE_MIGRATIONS if migrations is None else migrations)
    index = f"<!doctype html><title>lolly.ing {label}</title>".encode()
    catalog = json.dumps({"version": 1, "tools": [{"id": "qr-code"}], "label": label}).encode()
    diff_ids = ["sha256:" + sha(f"layer {label} {i}".encode()) for i in range(2)]
    config = json.dumps({"architecture": "amd64", "os": "linux", "rootfs": {"type": "layers", "diff_ids": diff_ids}}, sort_keys=True).encode()
    config_digest = "sha256:" + sha(config)
    blob = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                       "config": {"digest": config_digest, "size": len(config)},
                       "layers": [{"digest": "sha256:" + sha(f"blob {label} {i}".encode()), "size": 1000} for i in range(2)]},
                      sort_keys=True).encode()
    digest = "sha256:" + sha(blob)
    archive = b"OCI " + blob + b"\n" + config + b"\n" + (label.encode() * 64)
    formats = dict(FORMATS if formats is None else formats)
    body = {"kind": "lolly-ing-release", "version": 1, "sources": {"suseLolly": ssha, "work": work, "lolly": lolly},
            "catalog": {"seq": seq, "indexSha256": sha(catalog)}, "files": {"index.html": sha(index)},
            "shellPinKeyId": shell_pin or thumb, "migrations": migrations, "formats": formats}
    receipt = {"body": body, "signature": b64(F.sign((receipt_key or key)[0], canonical_js_json(body).encode()))}
    return {"sha": ssha, "label": label, "image": ING_IMAGE + "@" + digest, "digest": digest, "configDigest": config_digest,
            "diffIds": diff_ids, "config": b64(config), "blob": b64(blob), "archive": b64(archive), "archiveSha": sha(archive),
            "index": b64(index), "catalog": b64(catalog), "seq": seq, "migrations": migrations, "receipt": receipt,
            "work": work, "lolly": lolly, "formats": formats, "thumb": thumb, "shellPin": shell_pin or thumb,
            "packDigest": sha(("pack " + label).encode())}


def legacy_build(key):
    """The pre-cut-over server image with claim-mounted shell and pack (live before PROPOSAL 4.8)."""
    build = make_ing_build(key, "9" * 40, "legacy", seq=2000)
    build.update({"image": LEGACY_IMAGE, "digest": "sha256:" + "c" * 64})
    return build


def ing_manifest(build, run_id, attempt=1, **overrides):
    archive = unb64(build["archive"])
    manifest = {"kind": "lolly-ing-instance-manifest", "version": 1, "run": {"id": run_id, "attempt": attempt},
                "sources": {"suseLolly": build["sha"], "work": build["work"], "lolly": build["lolly"]},
                "image": {"name": ING_IMAGE, "digest": build["digest"], "configDigest": build["configDigest"],
                          "diffIds": build["diffIds"], "platform": "linux/amd64",
                          "archive": {"artifact": "lolly-ing-instance-archive", "file": "lolly-ing-instance.oci.tar",
                                      "sha256": build["archiveSha"], "bytes": len(archive)}},
                "catalog": {"seq": build["seq"], "keyId": build["thumb"], "indexSha256": sha(unb64(build["catalog"]))},
                "shell": {"pinKeyId": build["shellPin"], "files": {"index.html": sha(unb64(build["index"]))}, "formats": build["formats"]},
                "receipt": build["receipt"], "migrations": build["migrations"],
                "maintenance": any(m["class"] != "additive" for m in build["migrations"]),
                "boot": {"healthz": True, "readyz": True, "shellIndex": True}}
    manifest.update(overrides)
    return manifest


def zip_of(name, data):
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(name, data)
    return b64(buffer.getvalue())


def ing_run(run_id, ssha, event="workflow_dispatch", status="completed", conclusion="success", attempt=1,
            created="2026-10-24T05:00:00Z", repository=SUSE_REPO, path=".github/workflows/lolly-ing-preview.yml"):
    return {"id": run_id, "path": path, "event": event, "head_branch": "main", "head_sha": ssha, "status": status,
            "conclusion": conclusion, "run_attempt": attempt, "created_at": created,
            "repository": {"full_name": repository}, "head_repository": {"full_name": repository}}


def ing_artifacts(gh, build, run_id, manifest=None, archive_bytes=None):
    """The run's two artifacts: the manifest and the OCI archive."""
    manifest = manifest or ing_manifest(build, run_id)
    archive = archive_bytes if archive_bytes is not None else unb64(build["archive"])
    manifest_id, archive_id = run_id * 10 + 1, run_id * 10 + 2
    gh.setdefault("artifacts", {})[str(run_id)] = [
        {"id": manifest_id, "name": "lolly-ing-instance-manifest", "expired": False, "size_in_bytes": 4000,
         "expires_at": "2026-11-20T00:00:00Z"},
        {"id": archive_id, "name": "lolly-ing-instance-archive", "expired": False, "size_in_bytes": len(archive) + 200,
         "expires_at": "2026-11-20T00:00:00Z"}]
    gh.setdefault("zips", {})[str(manifest_id)] = zip_of("manifest.json", json.dumps(manifest))
    gh["zips"][str(archive_id)] = zip_of("lolly-ing-instance.oci.tar", archive)


# Cluster --------------------------------------------------------------------------
def ing_deployment(image, config, converted=True, annotations=None):
    volumes = [{"name": "config", "configMap": {"name": config}}, {"name": "tmp", "emptyDir": {}},
               {"name": "postgres-ca", "configMap": {"name": "lolly-postgres-ca"}},
               {"name": "render-worker-trust", "configMap": {"name": "lolly-render-worker-trust", "items": [{"key": "ca.crt", "path": "ca.crt"}]}}]
    mounts = [{"name": "config", "mountPath": "/app/instance.json", "subPath": "instance.json", "readOnly": True},
              {"name": "tmp", "mountPath": "/tmp"},
              {"name": "postgres-ca", "mountPath": "/etc/lolly/postgres", "readOnly": True},
              {"name": "render-worker-trust", "mountPath": "/etc/lolly/render-worker", "readOnly": True}]
    if not converted:
        volumes += [{"name": "pack", "persistentVolumeClaim": {"claimName": "lolly-private-pack-test-v1"}},
                    {"name": "shell", "persistentVolumeClaim": {"claimName": "lolly-private-shell-test-v1"}},
                    {"name": "engine-pin", "configMap": {"name": "lolly-work-engine-pin-test-v1"}}]
        mounts += [{"name": "pack", "mountPath": "/app/packs/lolly-ing", "readOnly": True},
                   {"name": "shell", "mountPath": "/app/shell", "readOnly": True},
                   {"name": "engine-pin", "mountPath": "/app/engine-pin.json", "subPath": "engine-pin.json", "readOnly": True}]
    secret = lambda name, key: {"name": name, "valueFrom": {"secretKeyRef": {"name": DATABASE_SECRET if name.startswith("DATABASE")
                                                                             else "lolly-work-instance", "key": key}}}
    env = [{"name": "NODE_ENV", "value": "production"}, {"name": "LW_CONFIG", "value": "/app/instance.json"},
           {"name": "LW_AUTO_MIGRATE", "value": "false"}, secret("DATABASE_URL", "DATABASE_URL"),
           {"name": "LW_SESSION_SECRET", "valueFrom": {"secretKeyRef": {"name": DATABASE_SECRET, "key": "LW_SESSION_SECRET"}}},
           secret("LW_CATALOG_SIGNING_KEY", "LW_CATALOG_SIGNING_KEY")]
    labels = dict(ING_LABELS, **{"app.kubernetes.io/component": "control-plane"})
    return {"apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "lolly-work", "namespace": ING_NAMESPACE, "uid": ING_DEPLOYMENT_UID, "resourceVersion": "500",
                         "generation": 31, "labels": dict(ING_LABELS, **{"helm.sh/chart": "lolly-work-0.2.8"}),
                         "annotations": dict({"deployment.kubernetes.io/revision": "30"}, **(annotations or {}))},
            "spec": {"replicas": 1, "revisionHistoryLimit": 10, "progressDeadlineSeconds": 600, "selector": {"matchLabels": ING_LABELS},
                     "strategy": {"type": "Recreate"},
                     "template": {"metadata": {"labels": labels},
                                  "spec": {"containers": [{"name": "server", "image": image, "imagePullPolicy": "Never", "env": env,
                                                           "resources": {"limits": {"cpu": "1", "memory": "1Gi"}},
                                                           "securityContext": {"readOnlyRootFilesystem": True, "allowPrivilegeEscalation": False,
                                                                               "capabilities": {"drop": ["ALL"]}},
                                                           "volumeMounts": mounts}],
                                           "volumes": volumes, "terminationGracePeriodSeconds": 60, "automountServiceAccountToken": False,
                                           "securityContext": {"runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000,
                                                               "runAsNonRoot": True, "seccompProfile": {"type": "RuntimeDefault"}}}}},
            "status": {"observedGeneration": 31, "replicas": 1, "readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1}}


def ing_annotations(build, run="800", config="lolly-ing-config-3008-aaaaaaaa", generation=3008, phase="accepted",
                    previous=None, deploys="1", migrations=None):
    import preview_common as C
    expect = {"source": build["sha"], "index": sha(unb64(build["index"])), "keyId": build["thumb"], "seq": build["seq"],
              "work": build["work"], "lolly": build["lolly"]}
    names = sorted(m["name"] for m in build["migrations"])
    values = {"phase": phase, "source": build["sha"], "image": build["image"], "ci-run": run, "formats": C.compact(build["formats"]),
              "expect": C.compact(expect), "config": config, "generation": str(generation), "layout": "instance-image",
              "deploys": deploys, "deploy-id": "20261024T000000Z-ing-cutover-" + build["sha"][:8],
              "migration-set": __import__("hashlib").sha256("\n".join(names).encode()).hexdigest()[:16]}
    if previous is not None:
        values["previous"] = C.compact(previous)
    if migrations is not None:
        values["migrations"] = C.compact(sorted(migrations))
    return {"lolly.tools/preview-" + k: v for k, v in values.items()}


def ing_cluster_state(builds, live, config_name, generation, converted=True, annotations=None, ing_key=None, extra_configs=None):
    deploy = ing_deployment(live["image"], config_name, converted, annotations)
    configs = {config_name: {"data": {"instance.json": instance_json(generation)}, "uid": "cm-" + config_name, "labels": {}}}
    for name, gen in (extra_configs or {}).items():
        configs[name] = {"data": {"instance.json": instance_json(gen)}, "uid": "cm-" + name, "labels": {}}
    configs["lolly-postgres-ca"] = {"data": {"ca.crt": "test ca"}, "uid": "cm-ca", "labels": {}}
    state = {
        "site": "lolly.ing",
        "namespaces": {"kube-system": F.CLUSTER_UID, ING_NAMESPACE: ING_NAMESPACE_UID},
        "node": {"name": F.NODE_NAME, "uid": F.NODE_UID},
        "deployment": deploy,
        "replicasets": [{"uid": "rs-30", "revision": 30, "image": live["image"], "template": F._template_digest(deploy),
                         "config": config_name}],
        "pods": [],
        "configmaps": configs,
        "cronjob": {"metadata": {"name": CRON, "namespace": ING_NAMESPACE, "uid": "cron-uid"}},
        "jobs": {},
        "db": {"ledger": sorted(m["name"] for m in live["migrations"]), "generation": generation, "digest": live["packDigest"]},
        "images": {},
        "content": {},
        "archives": {b["archiveSha"]: b["image"] for b in builds.values()},
        "builds": {b["image"]: b for b in builds.values()},
        "behaviour": {"notReady": [], "brokenSite": [], "watchFailAfter": {}, "restarts": {}, "workingSet": 300 * F.MIB,
                      "usage": 700 * F.MIB, "rvChurnRate": 0.0, "rvChurnAfterDryRun": {}, "edgeHeaders": {}, "edgeHeadersByImage": {},
                      "transport": {}, "dnsFailures": 0, "bootKeyByImage": {}, "classes": {}, "rehearsal": "pass",
                      "catalogKeyByImage": {}},
        "smokeCookie": SMOKE_COOKIE,
        "ingD": str(ing_key[0]) if ing_key else None,
        "reads": 0, "fetches": {}, "writes": [],
        "capacity": {"total": 100 * F.GIB, "available": 60 * F.GIB},
    }
    image_id, entry = F.image_entry(live["image"], {"io.cri-containerd.pinned": "pinned"})
    state["images"][image_id] = entry
    state["pods"] = [ing_pod(state, deploy, "rs-30", 30)]
    return state


def ing_pod(state, deploy, rs_uid, revision):
    image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
    build = state["builds"].get(image)
    pending = build is not None and any(m["name"] not in state["db"]["ledger"] for m in build["migrations"])
    ready = image not in state["behaviour"]["notReady"] and build is not None and not pending
    return {"metadata": {"name": f"lolly-work-{revision}", "namespace": ING_NAMESPACE, "labels": dict(ING_LABELS),
                         "ownerReferences": [{"kind": "ReplicaSet", "uid": rs_uid}]},
            "spec": copy.deepcopy(deploy["spec"]["template"]["spec"]),
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
                       "containerStatuses": [{"name": "server", "ready": ready, "image": image, "imageID": image,
                                              "restartCount": state["behaviour"]["restarts"].get(image, 0),
                                              "containerID": "containerd://" + sha(f"{image}{revision}".encode())[:32]}]}}


def _apply_ing_change(state, before, after):
    after["metadata"]["resourceVersion"] = str(int(before["metadata"]["resourceVersion"]) + 1)
    if before["spec"] != after["spec"]:
        after["metadata"]["generation"] = before["metadata"]["generation"] + 1
    if before["spec"]["template"] != after["spec"]["template"]:
        revision = max(rs["revision"] for rs in state["replicasets"]) + 1
        uid = f"rs-{revision}"
        image = after["spec"]["template"]["spec"]["containers"][0]["image"]
        config = next(v["configMap"]["name"] for v in after["spec"]["template"]["spec"]["volumes"] if v["name"] == "config")
        state["replicasets"].append({"uid": uid, "revision": revision, "image": image, "template": F._template_digest(after),
                                     "config": config})
        state["replicasets"] = sorted(state["replicasets"], key=lambda rs: rs["revision"])[-11:]
        after["metadata"]["annotations"]["deployment.kubernetes.io/revision"] = str(revision)
        pod = ing_pod(state, after, uid, revision)
        state["pods"] = [pod]
        ready = pod["status"]["containerStatuses"][0]["ready"]
        after["status"] = {"observedGeneration": after["metadata"]["generation"], "replicas": 1, "readyReplicas": 1 if ready else 0,
                           "availableReplicas": 1 if ready else 0, "updatedReplicas": 1}
    else:
        after["status"]["observedGeneration"] = after["metadata"]["generation"]
    state["deployment"] = after


def _rs_objects(state):
    deploy = state["deployment"]
    return [{"kind": "ReplicaSet", "metadata": {"name": f"lolly-work-rs{rs['revision']}", "namespace": ING_NAMESPACE, "uid": rs["uid"],
                                                "labels": dict(ING_LABELS),
                                                "annotations": {"deployment.kubernetes.io/revision": str(rs["revision"])},
                                                "ownerReferences": [{"kind": "Deployment", "uid": deploy["metadata"]["uid"]}]},
             "spec": {"template": {"spec": {"containers": [{"name": "server", "image": rs["image"]}],
                                            "volumes": [{"name": "config", "configMap": {"name": rs.get("config")}}]}}}}
            for rs in state["replicasets"]]


def _live_config_generation(state):
    deploy = state["deployment"]
    name = next(v["configMap"]["name"] for v in deploy["spec"]["template"]["spec"]["volumes"] if v["name"] == "config")
    document = json.loads(state["configmaps"][name]["data"]["instance.json"])
    return document["instance"]["catalogPublicationGeneration"]


def _check_output(state, image):
    build = state["builds"][image]
    files = [{"name": m["name"], "sha256": m["sha256"]} for m in sorted(build["migrations"], key=lambda m: m["name"])]
    return json.dumps({"kind": "lolly-migrate-check", "version": 1, "files": files, "ledger": sorted(state["db"]["ledger"]),
                       "publicationGeneration": state["db"]["generation"]})


def _run_job(state, manifest):
    """What the Job's container prints, after the same checks the cluster's policy would make."""
    spec = manifest["spec"]["template"]["spec"]
    container = spec["containers"][0]
    assert spec["automountServiceAccountToken"] is False and container["imagePullPolicy"] == "Never", "Job hardening"
    assert all("secret" not in volume for volume in spec["volumes"]), "a Job mounted a Secret"
    env = {e["name"]: e for e in container["env"]}
    for name, entry in env.items():
        if "valueFrom" in entry:
            assert entry["valueFrom"]["secretKeyRef"]["name"] == DATABASE_SECRET and name.startswith("DATABASE_URL"), name
    command, image = container["command"], container["image"]
    state["writes"].append(["job", manifest["metadata"]["labels"]["lolly.tools/preview-job"], sorted(env)])
    if image not in state["builds"] or state["behaviour"].get("jobsFail"):
        return False, ""
    if command[:3] == ["node", "--input-type=module", "-e"]:
        assert sorted(env) == ["DATABASE_URL"], env
        return True, "connected\n" + _check_output(state, image) + "\n"
    if command[:3] == ["node", "scripts/classify-migrations.ts", "--json"]:
        assert env == {}, env
        if state["behaviour"].get("classifierMissing"):
            return False, "Cannot find module '/app/scripts/classify-migrations.ts'\n"
        build = state["builds"][image]
        found = {m["name"]: m for m in build["migrations"]}
        files = []
        for path in command[3:]:
            name = path.split("/")[-1]
            files.append({"name": name, "sha256": found[name]["sha256"],
                          "class": state["behaviour"]["classes"].get(name, found[name]["class"]), "reasons": []})
        return True, json.dumps({"kind": "lolly-migration-classes", "version": 1, "files": files}) + "\n"
    if command == ["node", "scripts/migrate.ts"]:
        assert set(env) <= {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "LW_MIGRATE_EXPECT", "NODE_ENV"}, env
        build = state["builds"][image]
        pending = sorted((m for m in build["migrations"] if m["name"] not in state["db"]["ledger"]), key=lambda m: m["name"])
        expected = ",".join(f"{m['name']}:{m['sha256']}" for m in pending)
        if env.get("LW_MIGRATE_EXPECT", {}).get("value") != expected:
            return False, "pending set differs from LW_MIGRATE_EXPECT\n"
        state["db"]["ledger"] = sorted(set(state["db"]["ledger"]) | {m["name"] for m in pending})
        state["writes"].append(["migrate", [m["name"] for m in pending]])
        return True, f"applied {len(pending)}\n"
    return False, "unknown command\n"


def _now(offset_hours=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - offset_hours * 3600))


def k3s_ing_main(argv, out):
    """kubectl for lolly-private and ctr import/content; crictl and ctr images ls/label fall through."""
    state_path = os.environ["FAKE_STATE"]
    if argv[:1] == ["kubectl"]:
        if argv[1:5] != ["--kubeconfig", F.KUBECONFIG, "--context", F.CONTEXT]:
            print("bad kubeconfig or context", file=sys.stderr)
            return 1
        args = argv[5:]
        with F.state_file(state_path) as state:
            return _kubectl(state, args, out)
    if argv[:6] == ["ctr", "--namespace", "k8s.io", "images", "import", "--base-name"]:
        data = sys.stdin.buffer.read()
        with F.state_file(state_path) as state:
            image = state["archives"].get(sha(data))
            if image is None or state["behaviour"].get("importFails"):
                print("ctr: unrecognised archive", file=sys.stderr)
                return 1
            build = state["builds"][image]
            labels = {}
            for index, word in enumerate(argv):
                if word == "--label":
                    name, _, value = argv[index + 1].partition("=")
                    labels[name] = value
            assert argv[argv.index("--base-name") + 1] == ING_IMAGE and "--digests" in argv and "--no-unpack" in argv and argv[-1] == "-"
            image_id, entry = F.image_entry(image, labels)
            entry["size"] = len(data)
            state["images"][image_id] = entry
            served = state["behaviour"].get("importedConfig", {}).get(image)
            state["content"][build["digest"]] = build["blob"]
            state["content"][build["configDigest"]] = served or build["config"]
            state["writes"].append(["import", image])
        return 0
    if argv[:5] == ["ctr", "--namespace", "k8s.io", "content", "get"]:
        with F.state_file(state_path) as state:
            blob = state["content"].get(argv[5])
        if blob is None:
            return 1
        sys.stdout.buffer.write(unb64(blob))
        return 0
    return None


def _kubectl(state, args, out):
    namespace = args[args.index("--namespace") + 1] if "--namespace" in args else None
    if args[:2] == ["get", "namespace"]:
        out.write(json.dumps({"metadata": {"uid": state["namespaces"][args[2]]}}))
        return 0
    if args[:2] == ["get", "node"]:
        node = state["node"]
        out.write(json.dumps({"metadata": {"uid": node["uid"]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}))
        return 0 if args[2] == node["name"] else 1
    if args[:3] == ["get", "deployment", "lolly-work"]:
        out.write(json.dumps(state["deployment"]))
        return 0
    if args[:3] == ["patch", "deployment", "lolly-work"]:
        patch = json.loads(args[args.index("--patch") + 1])
        try:
            after = F.apply_json_patch(state["deployment"], patch)
        except (ValueError, KeyError, IndexError):
            print("the patch test failed", file=sys.stderr)
            return 1
        if "--dry-run=server" not in args:
            state["writes"].append(["patch", [op for op in patch if op["op"] != "test"]])
            _apply_ing_change(state, state["deployment"], after)
            after = state["deployment"]
        out.write(json.dumps(after))
        return 0
    if args[:2] == ["rollout", "status"]:
        image = state["deployment"]["spec"]["template"]["spec"]["containers"][0]["image"]
        return 0 if state["deployment"]["status"].get("readyReplicas") == 1 and image not in state["behaviour"]["notReady"] else 1
    if args[:2] == ["get", "pods,replicasets"]:
        pods = [dict(pod, kind="Pod") for pod in state["pods"]]
        out.write(json.dumps({"items": pods + _rs_objects(state)}))
        return 0
    if args[:2] == ["get", "persistentvolumeclaims"]:
        out.write(json.dumps({"items": []}))
        return 0
    if args[:2] == ["get", "pods,replicasets,statefulsets"]:
        out.write(json.dumps({"items": [dict(pod, kind="Pod") for pod in state["pods"]] + _rs_objects(state)}))
        return 0
    if args[:2] == ["delete", "--raw"]:
        match = re.fullmatch(r"/api/v1/namespaces/lolly-private/configmaps/([a-z0-9.-]+)", args[2])
        with open(args[args.index("-f") + 1]) as handle:
            options = json.load(handle)
        name = match.group(1) if match else None
        if name not in state["configmaps"] or options.get("preconditions", {}).get("uid") != state["configmaps"][name]["uid"]:
            print("precondition failed", file=sys.stderr)
            return 1
        del state["configmaps"][name]
        state["writes"].append(["delete-configmap", name])
        return 0
    if args[:2] == ["get", "replicasets"]:
        out.write(json.dumps({"items": _rs_objects(state)}))
        return 0
    if args[:2] == ["get", "pods"]:
        out.write(json.dumps({"items": state["pods"]}))
        return 0
    if args[:2] == ["get", "configmaps"]:
        items = [{"metadata": {"name": name, "namespace": ING_NAMESPACE, "uid": cm["uid"], "labels": cm.get("labels", {})},
                  "data": cm["data"]} for name, cm in state["configmaps"].items()]
        out.write(json.dumps({"items": items}))
        return 0
    if args[:2] == ["get", "cronjob"]:
        out.write(json.dumps(state["cronjob"]))
        return 0
    if args[:2] == ["get", "job"]:
        job = state["jobs"].get(args[2])
        if job is None:
            return 1
        out.write(json.dumps({k: v for k, v in job.items() if k not in ("logs", "manifest")}))
        return 0
    if args[:2] == ["create", "-f"]:
        with open(args[2]) as handle:
            document = json.load(handle)
        dry = "--dry-run=server" in args
        name = document["metadata"]["name"]
        if document["kind"] == "ConfigMap":
            assert document.get("immutable") is True and set(document["data"]) == {"instance.json"}, "ConfigMap shape"
            if name in state["configmaps"]:
                print("already exists", file=sys.stderr)
                return 1
            if not dry:
                state["configmaps"][name] = {"data": document["data"], "uid": "cm-" + name, "labels": document["metadata"]["labels"]}
                state["writes"].append(["configmap", name])
            out.write(json.dumps(dict(document, metadata=dict(document["metadata"], uid="cm-" + name))))
            return 0
        if document["kind"] == "Job":
            if dry:
                out.write(json.dumps(document))
                return 0
            ok, logs = _run_job(state, document)
            container = document["spec"]["template"]["spec"]["containers"][0]["name"]
            job = {"metadata": dict(document["metadata"], uid="job-" + name), "manifest": document,
                   "status": {"succeeded": 1, "completionTime": _now()} if ok else {"failed": 1}, "logs": {container: logs}}
            state["jobs"][name] = job
            out.write(json.dumps({k: v for k, v in job.items() if k not in ("logs", "manifest")}))
            return 0
        return 1
    if args[:2] == ["create", "job"]:
        name = args[2]
        assert args[3] == "--from=cronjob/" + CRON, args
        behaviour = state["behaviour"]
        if behaviour.get("backupFails"):
            job = {"metadata": {"name": name, "uid": "job-" + name}, "status": {"failed": 1}, "logs": {"encrypt-upload-verify": ""}}
        else:
            line = json.dumps({"status": "VERIFIED", "object": "lolly-ing/2026-10-24T05-00-00-000Z-0123456789abcdef.lwbackup",
                               "sha256": "b" * 64, "size": 27894723, "keyId": "8cf24825d9dd39ed"})
            job = {"metadata": {"name": name, "uid": "job-" + name},
                   "status": {"succeeded": 1, "completionTime": _now(behaviour.get("backupAgeHours", 0))},
                   "logs": {"encrypt-upload-verify": "uploading\n" + line + "\n"}}
        state["jobs"][name] = job
        state["writes"].append(["backup", name])
        out.write(json.dumps({k: v for k, v in job.items() if k != "logs"}))
        return 0
    if args[:1] == ["logs"]:
        target = args[1]
        container = args[args.index("-c") + 1]
        if target.startswith("job/"):
            out.write(state["jobs"][target[4:]]["logs"].get(container, ""))
            return 0
        pod = next((p for p in state["pods"] if p["metadata"]["name"] == target), None)
        if pod is None:
            return 1
        image = pod["status"]["containerStatuses"][0]["image"]
        key = state["behaviour"]["bootKeyByImage"].get(image) or state["builds"].get(image, {}).get("thumb")
        out.write(f"[lolly-work] listening on 8787\n[lolly-work] catalog signing on (keyId {key})\n")
        return 0
    print("unsupported kubectl " + " ".join(args[:3]), file=sys.stderr)
    return 1


# Edge ---------------------------------------------------------------------------------
def make_ing_fetch(state_path):
    import preview_common
    import preview_smoke

    def fetch(url, method="GET", headers=None, limit=None, data=None):
        parts = urlsplit(url)
        headers = headers or {}
        cookie = headers.get("Cookie")
        with F.state_file(state_path) as state:
            deploy = state["deployment"]
            image = deploy["spec"]["template"]["spec"]["containers"][0]["image"]
            build = state["builds"].get(image)
            behaviour = state["behaviour"]
            count = state["fetches"].get(image, 0)
            if parts.path == "/" and parts.hostname == "lolly.ing":
                state["fetches"][image] = count + 1
            signed_in = cookie is not None and cookie == state["smokeCookie"]
            csp = "default-src 'self'; script-src 'self' blob: 'unsafe-eval'; connect-src 'self' blob: https://lolly.ing"
            if image in behaviour.get("noBlob", []):
                csp = "default-src 'self'; script-src 'self'; connect-src 'self'"
            base = [("Content-Security-Policy", csp), ("Via", "1.1 Caddy")]
            if parts.hostname == "www.lolly.ing":
                return preview_smoke.Response(308, [("Location", "https://lolly.ing/")], b"")
            ready = state["deployment"]["status"].get("readyReplicas") == 1
            if build is None or not ready:
                return preview_smoke.Response(502, [], b"")
            broken = image in behaviour["brokenSite"]
            fail_after = behaviour["watchFailAfter"].get(image)
            path = parts.path
            if path == "/healthz":
                return preview_smoke.Response(200, [], json.dumps({"ok": True, "name": "lolly.ing", "accessMode": "gated"}).encode())
            if path == "/readyz":
                pending = any(m["name"] not in state["db"]["ledger"] for m in build["migrations"])
                return preview_smoke.Response(503 if pending else 200, [], json.dumps({"ok": not pending}).encode())
            if path == "/":
                if broken or (fail_after is not None and count >= fail_after):
                    return preview_smoke.Response(500, base, b"")
                return preview_smoke.Response(200, base, unb64(build["index"]))
            if path == "/info/":
                return preview_smoke.Response(200, base, b"info")
            if path == "/api/auth/session":
                if not signed_in:
                    return preview_smoke.Response(401, [], b'{"error":{"code":"UNAUTHORIZED"}}')
                role = behaviour.get("accountRole", "member")
                return preview_smoke.Response(200, [], json.dumps({"kind": "member", "user": {"sub": behaviour.get("accountSub", SMOKE_SUB),
                                                                  "email": "smoke@example.com", "groups": [], "role": role}}).encode())
            if path == "/api/v1/projects":
                projects = behaviour.get("ownedProjects", [])
                return preview_smoke.Response(200 if signed_in else 401, [], json.dumps({"projects": projects}).encode())
            if path == "/api/v1/render":
                if not signed_in or method != "POST" or json.loads(data)["toolId"] != "qr-code":
                    return preview_smoke.Response(401, [], b"")
                if image in behaviour.get("renderFails", []):
                    return preview_smoke.Response(501, [], b'{"error":{"code":"HOOKED_TOOL_NEEDS_CHROMIUM"}}')
                return preview_smoke.Response(200, [("Content-Type", "image/svg+xml")], b'<svg xmlns="http://www.w3.org/2000/svg"/>')
            if path == PACK_ASSET:
                return preview_smoke.Response(401 if not signed_in else 200, [], b"")
            if path in ("/catalog/tools/index.json", "/catalog/tools/index.sig.json"):
                if not signed_in:
                    return preview_smoke.Response(401, [], b'{"error":{"code":"UNAUTHORIZED","message":"this deployment is sign-in gated"}}')
                generation = max(_live_config_generation(state), build["seq"])
                db = state["db"]
                if generation > db["generation"] or (generation == db["generation"] and build["packDigest"] == db["digest"]):
                    db["generation"], db["digest"] = generation, build["packDigest"]
                else:
                    return preview_smoke.Response(503, [], b'{"error":{"code":"BAD_REQUEST","message":"older or conflicts"}}')
                index = unb64(build["catalog"])
                if path.endswith("index.json"):
                    return preview_smoke.Response(200, [], index)
                key_id = behaviour["catalogKeyByImage"].get(image) or build["thumb"]
                body = {"alg": "ECDSA-P256-SHA256", "keyId": key_id, "signedAt": "2026-10-24T05:00:00.000Z", "seq": 7,
                        "indexHash": sha(index), "files": {}}
                signature = sign_raw(int(state["ingD"]), preview_common.canonical_js_json(body).encode())
                body["signature"] = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
                return preview_smoke.Response(200, [], json.dumps(body).encode())
            return preview_smoke.Response(404, base, b"")
    return fetch


# Private GitHub run --------------------------------------------------------------------
def gh_ing_route(gh, method, route, query, data, out):
    """suse-lolly and the change-list compares. Returns None when the base fake should answer."""
    if method == "POST":
        if route == f"repos/{SUSE_REPO}/actions/workflows/lolly-ing-preview.yml/dispatches":
            if data.get("ref") != "refs/heads/main" or set(data.get("inputs", {})) != {"expected_source"}:
                return 1
            run = gh.get("onDispatch")
            if run:
                gh["ingRuns"].append(run)
                gh["onDispatch"] = None
            return 0
        return None
    if route == f"repos/{SUSE_REPO}/git/ref/heads/main":
        out.write(json.dumps({"ref": "refs/heads/main", "object": {"type": "commit", "sha": gh["suseMainHead"]}}))
        return 0
    match = re.fullmatch(r"repos/(lolly-tools/[a-z-]+)/compare/([0-9a-f]{40})\.\.\.([0-9a-f]{40})", route)
    if match and not (match.group(1) == "lolly-tools/lolly-work" and match.group(3) == F.TOOL_MAIN):
        spec = match.group(2) + "..." + match.group(3)
        status = gh.get("compare", {}).get(spec, "ahead")
        body = {"status": status, "total_commits": 1,
                "commits": [{"sha": match.group(3), "commit": {"message": "change in " + match.group(1) + "\n\nbody"}}],
                "files": [{"filename": name} for name in gh.get("changedFiles", {}).get(match.group(1), ["README.md"])]}
        out.write(json.dumps(body))
        return 0
    if route == f"repos/{SUSE_REPO}/actions/workflows/lolly-ing-preview.yml/runs":
        out.write(json.dumps({"workflow_runs": [r for r in gh["ingRuns"] if r["head_sha"] == query.get("head_sha")]}))
        return 0
    match = re.fullmatch(rf"repos/{SUSE_REPO}/actions/runs/(\d+)", route)
    if match:
        run = next(r for r in gh["ingRuns"] if r["id"] == int(match.group(1)))
        sequence = gh.get("statusSequence", {}).get(str(run["id"]))
        if sequence:
            run["status"] = sequence.pop(0)
            run["conclusion"] = "success" if run["status"] == "completed" else None
        out.write(json.dumps(run))
        return 0
    match = re.fullmatch(rf"repos/{SUSE_REPO}/actions/runs/(\d+)/artifacts", route)
    if match:
        out.write(json.dumps({"artifacts": gh["artifacts"].get(match.group(1), [])}))
        return 0
    match = re.fullmatch(rf"repos/{SUSE_REPO}/actions/runs/(\d+)/approvals", route)
    if match:
        out.write(json.dumps(gh.get("approvals", {}).get(match.group(1), [])))
        return 0
    match = re.fullmatch(rf"repos/{SUSE_REPO}/actions/artifacts/(\d+)/zip", route)
    if match:
        sys.stdout.buffer.write(unb64(gh["zips"][match.group(1)]))
        return 0
    return None


# The Phase 2A restore rehearsal driver, stubbed for the test checkout ----------------------
REHEARSAL_STUB = '''#!/usr/bin/env python3
# Test stub of the Phase 2A restore rehearsal driver (deploy/recovery/restore-rehearsal.py).
import json, os, sys
assert sys.argv[1] == "run"
request = json.load(open(sys.argv[2]))
assert request["kind"] == "lolly-restore-rehearsal" and request["namespace"] == "preview-rehearsal"
state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path))
mode = state["behaviour"].get("rehearsal", "pass")
state["writes"].append(["rehearsal", [m["name"] for m in request["migrations"]], request["full"], request["expect"]])
json.dump(state, open(state_path, "w"))
files = [{"name": m["name"], "seconds": 45 if mode == "slow" else 2} for m in request["migrations"]]
ledger = sorted(set(state["db"]["ledger"]) | {m["name"] for m in request["migrations"]})
result = {"kind": "lolly-restore-rehearsal-result", "version": 1, "result": "FAIL" if mode == "fail" else "PASS",
          "files": files, "ledger": ledger, "previousImageSaveRoundTrip": mode != "old-image-fails", "reason": mode}
print(json.dumps(result))
'''
