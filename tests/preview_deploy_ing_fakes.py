# SPDX-License-Identifier: MPL-2.0
"""lolly.ing fakes for tests/test_preview_deploy_ing.py, layered on preview_deploy_fakes.

The same executables (gh, ssh, k3s, systemctl) route here when FAKE_SITE is
lolly.ing. They model what the lolly.ing path touches: the lolly-private
Deployment and its generation ConfigMaps, the backup CronJob and the Jobs the
command creates, containerd import and content, Postgres's migration ledger and
Work's catalog generation fence, suse-lolly's private lolly-ing-preview.yml run
(PR #28's manifest) and the edge. The classifier Job prints Work's real classifier
output (PR #207, tests/fixtures/preview-ing), and the restore rehearsal runs the
real driver (PR #208) against that PR's own fake kubectl. Nothing real is contacted.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import preview_deploy_fakes as F

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "preview-ing"
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
WORK_REPO = "lolly-tools/lolly-work"
ING_LABELS = {"app.kubernetes.io/instance": "lolly-work", "app.kubernetes.io/name": "lolly-work"}
CRON = "lolly-postgres-offhost-backup"
STORAGE_HOST = "backups.example.test"
STORAGE_ADDRESS = "203.0.113.7"
REHEARSAL_NAMESPACE = "lolly-restore-rehearsal"
MANIFEST_HEADER = "lolly-work migration manifest v1\n"
# Who dispatches and who approves (review 2026-10-25 C1), and the suse-lolly build files the bind anchors (H1).
DISPATCHER = "lolly-agent"
REVIEWER = "andy"
BUILD_BLOBS = {".github/workflows/lolly-ing-preview.yml": "a1" * 20, ".github/lolly-ing-preview/tool.mjs": "b2" * 20,
               ".github/lolly-ing-preview/instance.Dockerfile": "c3" * 20}
APPROVAL_WORKFLOW = ".github/workflows/lolly-ing-approval.yml"
APPROVAL_WORKFLOW_BLOB = "d4" * 20
APPROVAL_HEAD = "e5" * 20
# The Secret the live server's LW_CATALOG_SIGNING_KEY names before the cut-over (the release key, decision 2), and
# the one holding lolly.ing's own key that the cut-over switches the reference to (review H3). Names only, never values.
LEGACY_SIGNING_SECRET = "lolly-work-instance"
ING_SIGNING_SECRET = "lolly-work-ing-catalog-signing"
sha = F.sha


def signing_approval(login=REVIEWER):
    return {"state": "approved", "environments": [{"name": "lolly-ing-signing"}], "user": {"login": login}, "comment": ""}


def maintenance_approval(login=REVIEWER):
    return {"state": "approved", "environments": [{"name": "lolly-ing-maintenance"}], "user": {"login": login}, "comment": ""}


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


def migration(name):
    text = f"-- {name}\ncreate table if not exists t_{name[:4]} (id int);\n"
    return {"name": name, "sha256": sha(text.encode())}


def fixture_migration(name):
    """One of the SQL files the real #207 classifier classified (fixtures/preview-ing)."""
    return {"name": name, "sha256": sha((FIXTURES / name).read_bytes())}


BASE_MIGRATIONS = [migration(f"{n:04d}_base_{n}.sql") for n in range(1, 4)]
ADDITIVE = "0077_widgets.sql"       # #207: additive (create table)
MAINTENANCE = "0078_widget_names.sql"  # #207: maintenance (ALTER TABLE ADD CONSTRAINT)
FORMATS = {"channelMessage": 2, "indexedDb": 26, "revisionArchive": 1, "session": 4}


def manifest_hash(files):
    lines = "".join(f"{f['name']}\t{f['sha256']}\n" for f in sorted(files, key=lambda f: f["name"]))
    return "sha256:" + hashlib.sha256((MANIFEST_HEADER + lines).encode()).hexdigest()


def instance_json(generation, name="lolly.ing"):
    return json.dumps({"deployment": {"mode": "production"},
                       "instance": {"name": name, "baseUrl": "https://lolly.ing", "catalogPublicationGeneration": generation,
                                    "pack": "/app/packs/lolly-ing", "shellDir": "/app/shell"},
                       "policy": {"defaultAccessMode": "gated", "guestLinks": {"enabled": False}, "ai": {"enabled": False}},
                       "render": {"worker": {"url": "https://worker.lolly-private.svc:8791", "timeoutMs": 60000}}}, indent=2) + "\n"


def make_ing_build(key, wsha, label, migrations=None, seq=3000, lolly="2" * 40, suse="5" * 40, formats=None,
                   pin=None, receipt_key=None):
    """One private instance build: its OCI layout digests, served shell, signed frontend receipt and pack."""
    from preview_common import canonical_js_json
    import preview_receipt as R
    d, jwk = key
    thumb = R.jwk_thumbprint(jwk)
    migrations = list(BASE_MIGRATIONS if migrations is None else migrations)
    index_html = f"<!doctype html><title>lolly.ing {label}</title>".encode()
    catalog = json.dumps({"version": 1, "tools": [{"id": "qr-code"}], "label": label}).encode()
    envelope = json.dumps({"keyId": thumb, "seq": seq, "label": label}).encode()
    body = {"kind": "lolly-release-frontend", "version": 1, "source": lolly, "target": "web", "profile": "suse",
            "files": {"index.html": sha(index_html), "catalog/tools/index.sig.json": sha(envelope)}}
    body["signature"] = b64(F.sign((receipt_key or key)[0], canonical_js_json(body).encode()))
    receipt = json.dumps(body).encode()
    diff_ids = ["sha256:" + sha(f"layer {label} {i}".encode()) for i in range(2)]
    config = json.dumps({"architecture": "amd64", "os": "linux", "rootfs": {"type": "layers", "diff_ids": diff_ids}}, sort_keys=True).encode()
    manifest = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                           "config": {"digest": "sha256:" + sha(config), "size": len(config)},
                           "layers": [{"digest": "sha256:" + sha(f"blob {label} {i}".encode()), "size": 1000} for i in range(2)]},
                          sort_keys=True).encode()
    index = json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
                        "manifests": [{"digest": "sha256:" + sha(manifest), "size": len(manifest),
                                       "platform": {"os": "linux", "architecture": "amd64"}}]}, sort_keys=True).encode()
    digest = "sha256:" + sha(index)
    return {"sha": wsha, "label": label, "image": ING_IMAGE + "@" + digest, "digest": digest,
            "manifestDigest": "sha256:" + sha(manifest), "configDigest": "sha256:" + sha(config), "diffIds": diff_ids,
            "blobs": {digest: b64(index), "sha256:" + sha(manifest): b64(manifest), "sha256:" + sha(config): b64(config)},
            "index": b64(index_html), "receipt": b64(receipt), "catalog": b64(catalog), "seq": seq, "migrations": migrations,
            "lolly": lolly, "suse": suse, "formats": dict(FORMATS if formats is None else formats), "thumb": thumb,
            "pin": pin or thumb, "packDigest": sha(("pack " + label).encode()),
            "approvalIssuedAt": int(time.time()), "frontendInputSha256": sha(("unsigned " + label).encode())}


def legacy_build(key):
    """The pre-cut-over server image with claim-mounted shell and pack (live before PROPOSAL 4.8). Its pack is signed
    with the release key, which is what the live Secret holds until the cut-over (decision 2)."""
    import preview_anchors as A
    build = make_ing_build(key, "9" * 40, "legacy", seq=2000)
    build.update({"image": LEGACY_IMAGE, "digest": "sha256:" + "c" * 64, "packKey": A.RELEASE_PUBLIC_KEY_THUMBPRINT})
    return build


def archive_bytes(build, run_id, attempt=1):
    """Each run builds its own archive: its tag names the run, so its bytes differ."""
    return b"OCI " + unb64(build["blobs"][build["digest"]]) + f"\nrun {run_id}-{attempt} {build['label']}\n".encode() * 8


def ing_manifest(build, run_id, attempt=1, **overrides):
    """suse-lolly PR #28's final manifest (.github/lolly-ing-preview/tool.mjs finalManifest)."""
    archive = archive_bytes(build, run_id, attempt)
    index_sha = sha(unb64(build["index"]))
    receipt_sha = sha(unb64(build["receipt"]))
    manifest = {
        "kind": "lolly-ing-instance-image", "version": 1, "site": "lolly.ing",
        "run": {"repository": SUSE_REPO, "workflowRef": f"{SUSE_REPO}/.github/workflows/lolly-ing-preview.yml@refs/heads/main",
                "workflowSha": build["suse"], "ref": "refs/heads/main", "event": "workflow_dispatch", "runId": run_id,
                "runAttempt": attempt, "url": f"https://github.com/{SUSE_REPO}/actions/runs/{run_id}", "dispatchedBy": "agent"},
        "sources": {"lolly": build["lolly"], "work": build["sha"], "suse": build["suse"]},
        "ci": {"lolly": {"id": 1}, "work": {"id": 2}}, "ancestry": {}, "lollySuseGitlink": None,
        "image": {"archive": {"name": f"lolly-ing-instance-{run_id}-{attempt}.oci.tar", "sha256": sha(archive), "bytes": len(archive)},
                  "digest": build["digest"], "manifestDigest": build["manifestDigest"], "configDigest": build["configDigest"],
                  "diffIds": build["diffIds"], "layers": [], "refName": f"{ING_IMAGE}:run-{run_id}-{attempt}",
                  "workServerImageId": "sha256:" + "7" * 64, "paths": {"shell": "/app/shell", "pack": "/app/packs/lolly-ing"}},
        "enginePin": {"generatedFrom": build["lolly"], "sha256": "8" * 64, "engine": "1.2.0", "core": "1.0.0"},
        "shell": {"files": 10, "totalBytes": 1000, "indexSha256": index_sha, "receiptSha256": receipt_sha, "envelopeSha256": "9" * 64,
                  "catalogSeq": build["seq"], "keyId": build["pin"], "scriptsCarryingPin": 3, "publicPinThumbprint": build["pin"],
                  "profile": "suse"},
        "catalog": {"seq": build["seq"], "minSeq": None, "keyId": build["pin"]},
        "receiptSha256": receipt_sha, "custody": {}, "pack": {},
        "migrations": build["migrations"],
        "storedFormats": {"formats": build["formats"], "missing": []},
        "buildSettings": {"profile": "suse", "siteUrl": "https://lolly.ing", "pinThumbprint": build["pin"]},
        "boot": {"readyz": {"status": 200}, "index": {"sha256": index_sha}},
        "frontendInputSha256": build["frontendInputSha256"],
        "approvals": approval_records(build, run_id, attempt),
    }
    manifest.update(overrides)
    return manifest


def approval_request(build, run_id, stage, attempt=1, maintenance=False):
    """The private CI request, with a deterministic nonce so repeated fixture reads agree."""
    issued = build["approvalIssuedAt"]
    return {"version": 1, "stage": stage,
            "privateRun": {"repository": SUSE_REPO, "id": str(run_id), "attempt": attempt, "workflowSha": build["suse"]},
            "sources": {"lolly": build["lolly"], "work": build["sha"], "suse": build["suse"]},
            "pinThumbprint": build["pin"], "buildBlobs": dict(BUILD_BLOBS),
            "migrationManifest": manifest_hash(build["migrations"])[7:], "maintenance": maintenance, "minSeq": "",
            "artifactSha256": build["frontendInputSha256"] if stage == "final" else None,
            "nonce": sha(f"{run_id}-{attempt}-{stage}-{build['label']}".encode()),
            "issuedAt": issued, "expiresAt": issued + 14400}


def approval_run_id(run_id, stage):
    return 900000 + run_id * 2 + (1 if stage == "final" else 0)


def approval_records(build, run_id, attempt=1, maintenance=False):
    return {stage: {"request": approval_request(build, run_id, stage, attempt, maintenance),
                    "run": {"id": str(approval_run_id(run_id, stage)), "attempt": 1}} for stage in ("source", "final")}


def approval_digest(request):
    text = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha(("lolly.ing approval request v1\n" + text).encode())


def public_approval_run(request, run_id, dispatcher=DISPATCHER):
    return {"id": int(run_id), "path": APPROVAL_WORKFLOW, "event": "workflow_dispatch", "head_branch": "main",
            "head_sha": APPROVAL_HEAD, "status": "completed", "conclusion": "success", "run_attempt": 1,
            "display_title": f"lolly.ing approval {request['stage']} {approval_digest(request)}",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(request["issuedAt"])),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(request["issuedAt"])),
            "actor": {"login": dispatcher}, "triggering_actor": {"login": dispatcher},
            "repository": {"full_name": WORK_REPO}, "head_repository": {"full_name": WORK_REPO}}


def approval_environment(name, reviewer=REVIEWER):
    return {"name": name, "can_admins_bypass": False,
            "protection_rules": [{"type": "required_reviewers", "prevent_self_review": False,
                                  "reviewers": [{"type": "User", "reviewer": {"login": reviewer}}]}],
            "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}}


def zip_of(name, data):
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(name, data)
    return b64(buffer.getvalue())


def ing_run(run_id, suse, event="workflow_dispatch", status="completed", conclusion="success", attempt=1,
            created="2026-10-24T05:00:00Z", repository=SUSE_REPO, path=".github/workflows/lolly-ing-preview.yml",
            dispatcher=DISPATCHER):
    return {"id": run_id, "path": path, "event": event, "head_branch": "main", "head_sha": suse, "status": status,
            "conclusion": conclusion, "run_attempt": attempt, "created_at": created,
            "actor": {"login": dispatcher}, "triggering_actor": {"login": dispatcher},
            "repository": {"full_name": repository}, "head_repository": {"full_name": repository}}


def ing_artifacts(gh, build, run_id, manifest=None, archive=None):
    """Private build artifacts and the independently approved public runs that authorize its signing."""
    manifest = manifest or ing_manifest(build, run_id)
    archive = archive if archive is not None else archive_bytes(build, run_id)
    manifest_id, archive_id = run_id * 10 + 1, run_id * 10 + 2
    gh.setdefault("approvals", {}).setdefault(str(run_id), [signing_approval()])
    gh.setdefault("artifacts", {})[str(run_id)] = [
        {"id": manifest_id, "name": "lolly-ing-instance-manifest", "expired": False, "size_in_bytes": 4000,
         "expires_at": "2026-11-20T00:00:00Z"},
        {"id": archive_id, "name": "lolly-ing-instance-archive", "expired": False, "size_in_bytes": len(archive) + 200,
         "expires_at": "2026-11-20T00:00:00Z"}]
    gh.setdefault("zips", {})[str(manifest_id)] = zip_of("lolly-ing-instance.manifest.json", json.dumps(manifest))
    gh["zips"][str(archive_id)] = zip_of(manifest["image"]["archive"]["name"], archive)
    gh.setdefault("enginePins", {})[build["sha"]] = build["lolly"]
    for stage, record in (manifest.get("approvals") or {}).items():
        if not isinstance(record, dict) or not isinstance(record.get("request"), dict) or not isinstance(record.get("run"), dict):
            continue
        request, public_id = record["request"], record["run"].get("id")
        if not str(public_id).isdigit():
            continue
        gh.setdefault("publicRuns", {})[str(public_id)] = public_approval_run(request, public_id)
        approvals = [signing_approval()]
        if stage == "final" and request.get("maintenance"):
            approvals.append(maintenance_approval())
        gh.setdefault("publicApprovals", {}).setdefault(str(public_id), approvals)
        request_id = run_id * 10 + (3 if stage == "source" else 4)
        gh["artifacts"][str(run_id)].append({"id": request_id,
            "name": f"lolly-ing-approval-{stage}-request-attempt-{record['request']['privateRun']['attempt']}",
            "expired": False, "size_in_bytes": 4000, "expires_at": "2026-11-20T00:00:00Z"})
        gh["zips"][str(request_id)] = zip_of("request.json", json.dumps(request))


def register_archive(state, build, run_id, attempt=1):
    """What ctr finds in this run's archive: the build, and the run tag `docker save` wrote."""
    state.setdefault("archives", {})[sha(archive_bytes(build, run_id, attempt))] = {
        "image": build["image"], "refName": f"{ING_IMAGE}:run-{run_id}-{attempt}"}


# Cluster --------------------------------------------------------------------------
def ing_deployment(image, config, converted=True, annotations=None, signing_secret=None):
    signing_secret = signing_secret or (ING_SIGNING_SECRET if converted else LEGACY_SIGNING_SECRET)
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
                                                                             else signing_secret, "key": key}}}
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
    expect = {"source": build["sha"], "suse": build["suse"], "lolly": build["lolly"], "index": sha(unb64(build["index"])),
              "receipt": sha(unb64(build["receipt"])), "keyId": build["thumb"], "seq": build["seq"]}
    names = sorted(m["name"] for m in build["migrations"])
    values = {"phase": phase, "source": build["sha"], "image": build["image"], "ci-run": run, "formats": C.compact(build["formats"]),
              "expect": C.compact(expect), "config": config, "generation": str(generation), "layout": "instance-image",
              "deploys": deploys, "deploy-id": "20261024T000000Z-ing-cutover-" + build["sha"][:8],
              "migration-set": hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]}
    if previous is not None:
        values["previous"] = C.compact(previous)
    if migrations is not None:
        values["migrations"] = C.compact(sorted(migrations))
    return {"lolly.tools/preview-" + k: v for k, v in values.items()}


def ing_cluster_state(builds, live, config_name, generation, converted=True, annotations=None, ing_key=None, extra_configs=None):
    import preview_anchors as A
    import preview_receipt as R
    deploy = ing_deployment(live["image"], config_name, converted, annotations)
    # Which key each Secret holds, by name (never a value): Work signs with the key the referenced Secret holds, and
    # serves a pack only when its envelope verifies against that key (server/src/catalog/publication.ts).
    secrets = {LEGACY_SIGNING_SECRET: A.RELEASE_PUBLIC_KEY_THUMBPRINT}
    if ing_key:
        secrets[ING_SIGNING_SECRET] = R.jwk_thumbprint(ing_key[1])
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
        "archives": {},
        "builds": {b["image"]: b for b in builds.values()},
        "behaviour": {"notReady": [], "brokenSite": [], "watchFailAfter": {}, "restarts": {}, "workingSet": 300 * F.MIB,
                      "usage": 700 * F.MIB, "rvChurnRate": 0.0, "rvChurnAfterDryRun": {}, "edgeHeaders": {}, "edgeHeadersByImage": {},
                      "transport": {}, "dnsFailures": 0, "bootKeyByImage": {}, "catalogKeyByImage": {}},
        "smokeCookie": SMOKE_COOKIE,
        "secrets": secrets,
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


def _server_key(state, pod_spec):
    """The key id Work signs with: the one held by the Secret its LW_CATALOG_SIGNING_KEY references, or None."""
    for entry in pod_spec["containers"][0].get("env", []):
        if entry.get("name") == "LW_CATALOG_SIGNING_KEY":
            return state["secrets"].get(((entry.get("valueFrom") or {}).get("secretKeyRef") or {}).get("name"))
    return None


def _check_output(state, image):
    build = state["builds"][image]
    files = [{"name": m["name"], "sha256": m["sha256"]} for m in sorted(build["migrations"], key=lambda m: m["name"])]
    return json.dumps({"kind": "lolly-migrate-check", "version": 1, "files": files, "ledger": sorted(state["db"]["ledger"]),
                       "publicationGeneration": state["db"]["generation"]})


def _classifier_output(names):
    """Work's real classifier output (#207) for exactly these files, pretty printed as the CLI prints it."""
    key = "-".join(name[:4] for name in sorted(names))
    path = FIXTURES / f"classify-{key}.json"
    return path.read_text() if path.exists() else None


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
    state["writes"].append(["job", manifest["metadata"]["labels"]["lolly.tools/preview-job"], sorted(env), command[1:5]])
    if image not in state["builds"] or state["behaviour"].get("jobsFail"):
        return False, ""
    if command[:3] == ["node", "--input-type=module", "-e"]:
        assert sorted(env) == ["DATABASE_URL"], env
        return True, "connected\n" + _check_output(state, image) + "\n"
    if command[:4] == ["node", "scripts/classify-migrations.ts", "--json", "--only"]:
        assert env == {}, env
        if state["behaviour"].get("classifierMissing"):
            return False, "Cannot find module '/app/scripts/classify-migrations.ts'\n"
        output = _classifier_output(command[4].split(","))
        return (output is not None), output or "no such file\n"
    if command == ["node", "scripts/migrate.ts"]:
        assert set(env) <= {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "LW_MIGRATE_EXPECT", "NODE_ENV"}, env
        build = state["builds"][image]
        pending = [m for m in build["migrations"] if m["name"] not in state["db"]["ledger"]]
        expected = manifest_hash(pending) if pending else "none"
        if env.get("LW_MIGRATE_EXPECT", {}).get("value") != expected:  # #207: the runner refuses before any DDL
            return False, "migrate: LW_MIGRATE_EXPECT refused: the pending migrations have another manifest. Nothing was applied.\n"
        state["db"]["ledger"] = sorted(set(state["db"]["ledger"]) | {m["name"] for m in pending})
        state["writes"].append(["migrate", sorted(m["name"] for m in pending), env["LW_MIGRATE_EXPECT"]["value"]])
        return True, f"applied: {', '.join(sorted(m['name'] for m in pending))}\n"
    return False, "unknown command\n"


def _now(offset_hours=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - offset_hours * 3600))


def _rehearsal_call(args):
    """Calls the restore rehearsal driver (#208) makes: its namespace, `-n`, stdin creates, version, PriorityClass."""
    if args[:1] == ["version"] or args[:2] == ["get", "priorityclass"] or "-n" in args:
        return True
    if args[:2] == ["get", "namespace"] and args[2].startswith(REHEARSAL_NAMESPACE):
        return True
    if args[:1] == ["create"] and "-f" in args and args[args.index("-f") + 1] == "-":
        return True
    return args[:2] == ["delete", "--raw"] and f"/namespaces/{REHEARSAL_NAMESPACE}" in args[2]


def k3s_ing_main(argv, out):
    """kubectl for lolly-private and ctr import, content and rm; crictl and ctr images ls/label fall through."""
    state_path = os.environ["FAKE_STATE"]
    if argv[:1] == ["kubectl"]:
        if argv[1:5] != ["--kubeconfig", F.KUBECONFIG, "--context", F.CONTEXT]:
            print("bad kubeconfig or context", file=sys.stderr)
            return 1
        args = argv[5:]
        if _rehearsal_call(args):
            import restore_rehearsal_fakes  # #208's own fake kubectl, with its own state (FAKE_REHEARSAL_STATE)
            with F.state_file(state_path) as state:
                state["writes"].append(["rehearsal-call", args[:2]])
            return restore_rehearsal_fakes.kubectl_main(args)
        with F.state_file(state_path) as state:
            return _kubectl(state, args, out)
    if argv[:6] == ["ctr", "--namespace", "k8s.io", "images", "import", "--base-name"]:
        data = sys.stdin.buffer.read()
        with F.state_file(state_path) as state:
            found = state["archives"].get(sha(data))
            if found is None or state["behaviour"].get("importFails"):
                print("ctr: unrecognised archive", file=sys.stderr)
                return 1
            build = state["builds"][found["image"]]
            labels = {}
            for index, word in enumerate(argv):
                if word == "--label":
                    name, _, value = argv[index + 1].partition("=")
                    labels[name] = value
            assert argv[argv.index("--base-name") + 1] == ING_IMAGE and "--digests" in argv and "--no-unpack" in argv and argv[-1] == "-"
            image_id, entry = F.image_entry(build["image"], labels, extra_refs=(found["refName"],))
            entry["refs"][found["refName"]] = dict(labels)
            entry["size"] = len(data)
            state["images"][image_id] = entry
            for digest, blob in build["blobs"].items():
                state["content"][digest] = blob
            served = state["behaviour"].get("importedConfig", {}).get(build["image"])
            if served:
                state["content"][build["configDigest"]] = served
            state["writes"].append(["import", build["image"]])
        return 0
    if argv[:5] == ["ctr", "--namespace", "k8s.io", "content", "get"]:
        with F.state_file(state_path) as state:
            blob = state["content"].get(argv[5])
        if blob is None:
            return 1
        sys.stdout.buffer.write(unb64(blob))
        return 0
    if argv[:5] == ["ctr", "--namespace", "k8s.io", "images", "rm"]:
        with F.state_file(state_path) as state:
            for entry in state["images"].values():
                if argv[5] in entry["refs"]:
                    del entry["refs"][argv[5]]
                    state["writes"].append(["image-name-removed", argv[5]])
                    return 0
        return 1
    return None


def _kubectl(state, args, out):
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
        out.write(json.dumps({"items": [dict(pod, kind="Pod") for pod in state["pods"]] + _rs_objects(state)}))
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
        key = state["behaviour"]["bootKeyByImage"].get(image) or _server_key(state, pod["spec"])
        line = f"catalog signing on (keyId {key})" if key else "catalog signing unavailable: no key"
        out.write(f"[lolly-work] listening on 8787\n[lolly-work] {line}\n")
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
            if path == "/release-frontend.sig.json":
                return preview_smoke.Response(200, base, unb64(behaviour.get("receiptByImage", {}).get(image) or build["receipt"]))
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
                server_key = _server_key(state, deploy["spec"]["template"]["spec"])
                if server_key != build.get("packKey", build["thumb"]):  # publication.ts: the pack must verify against the server's key
                    return preview_smoke.Response(503, [], b'{"error":{"code":"CATALOG_UNAVAILABLE","message":"pack signature"}}')
                generation = max(_live_config_generation(state), build["seq"])
                db = state["db"]
                if generation > db["generation"] or (generation == db["generation"] and build["packDigest"] == db["digest"]):
                    db["generation"], db["digest"] = generation, build["packDigest"]
                else:
                    return preview_smoke.Response(503, [], b'{"error":{"code":"BAD_REQUEST","message":"older or conflicts"}}')
                index = unb64(build["catalog"])
                if path.endswith("index.json"):
                    return preview_smoke.Response(200, [], index)
                key_id = behaviour["catalogKeyByImage"].get(image) or server_key
                body = {"alg": "ECDSA-P256-SHA256", "keyId": key_id, "signedAt": "2026-10-24T05:00:00.000Z", "seq": 7,
                        "indexHash": sha(index), "files": {}}
                signature = sign_raw(int(state["ingD"]), preview_common.canonical_js_json(body).encode())
                body["signature"] = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
                return preview_smoke.Response(200, [], json.dumps(body).encode())
            return preview_smoke.Response(404, base, b"")
    return fetch


# Private GitHub run --------------------------------------------------------------------
def gh_ing_route(gh, method, route, query, data, out):
    """suse-lolly, Work's engine pin and the change-list compares. Returns None when the base fake should answer."""
    if method == "POST":
        if route == f"repos/{WORK_REPO}/actions/workflows/lolly-ing-approval.yml/dispatches":
            inputs = data.get("inputs", {})
            if data.get("ref") != "refs/heads/main" or set(inputs) != {"request_sha256", "stage", "maintenance"}:
                return 1
            # A fake public run exists for the exact private fixture; dispatch never manufactures approval.
            matching = [r for r in gh.get("publicPendingRuns", {}).values()
                        if r["display_title"] == f"lolly.ing approval {inputs['stage']} {inputs['request_sha256']}"]
            if len(matching) != 1:
                return 1
            run = matching[0]
            gh.setdefault("publicRuns", {})[str(run["id"])] = run
            del gh["publicPendingRuns"][str(run["id"])]
            return 0
        if route == f"repos/{SUSE_REPO}/actions/workflows/lolly-ing-preview.yml/dispatches":
            fields = set(data.get("inputs", {}))
            if data.get("ref") != "refs/heads/main" or fields not in ({"LSHA", "WSHA", "SSHA"}, {"LSHA", "WSHA", "SSHA", "MAINTENANCE"}):
                return 1
            if "MAINTENANCE" in fields and data["inputs"]["MAINTENANCE"] is not True:
                return 1
            run = gh.get("onDispatch")
            if run:
                gh["ingRuns"].append(run)
                gh["onDispatch"] = None
            return 0
        return None
    if route == "user":
        out.write(json.dumps({"login": gh.get("login", DISPATCHER), "type": "User"}))
        return 0
    if route == f"repos/{WORK_REPO}/contents/{APPROVAL_WORKFLOW}":
        blob = gh.get("approvalWorkflowBlob", APPROVAL_WORKFLOW_BLOB)
        out.write(json.dumps({"type": "file", "path": APPROVAL_WORKFLOW, "sha": blob, "size": 100}))
        return 0
    if route == f"repos/{WORK_REPO}/actions/workflows/lolly-ing-approval.yml/runs":
        out.write(json.dumps({"workflow_runs": list(gh.get("publicRuns", {}).values())}))
        return 0
    match = re.fullmatch(rf"repos/{WORK_REPO}/actions/runs/(\d+)(/approvals)?", route)
    if match:
        item = gh.get("publicApprovals", {}) if match.group(2) else gh.get("publicRuns", {})
        if match.group(1) not in item:
            print("gh: Not Found (HTTP 404)", file=sys.stderr)
            return 1
        out.write(json.dumps(item[match.group(1)]))
        return 0
    match = re.fullmatch(rf"repos/{WORK_REPO}/environments/(lolly-ing-signing|lolly-ing-maintenance)(/deployment-branch-policies)?", route)
    if match:
        if match.group(2):
            value = gh.get("approvalBranches", {"total_count": 1, "branch_policies": [{"name": "main", "type": "branch"}]})
        else:
            value = gh.get("approvalEnvironments", {}).get(match.group(1), approval_environment(match.group(1)))
        out.write(json.dumps(value))
        return 0
    if route == f"repos/{SUSE_REPO}/git/ref/heads/main":
        out.write(json.dumps({"ref": "refs/heads/main", "object": {"type": "commit", "sha": gh["suseMainHead"]}}))
        return 0
    match = re.fullmatch(rf"repos/{SUSE_REPO}/contents/(.+)", route)
    if match:
        blobs = gh.get("suseBlobs", BUILD_BLOBS)
        if not re.fullmatch(r"[0-9a-f]{40}", query.get("ref", "")) or match.group(1) not in blobs:
            print("gh: Not Found (HTTP 404)", file=sys.stderr)
            return 1
        out.write(json.dumps({"type": "file", "path": match.group(1), "sha": blobs[match.group(1)], "size": 100}))
        return 0
    if route == f"repos/{WORK_REPO}/contents/engine-pin.json":
        lsha = gh.get("enginePins", {}).get(query.get("ref"))
        if lsha is None:
            print("gh: Not Found (HTTP 404)", file=sys.stderr)
            return 1
        out.write(json.dumps({"generatedFrom": lsha, "engine": {"version": "1.2.0"}}))
        return 0
    match = re.fullmatch(r"repos/(lolly-tools/[a-z-]+)/compare/([0-9a-f]{40})\.\.\.([0-9a-f]{40})", route)
    if match and not (match.group(1) == WORK_REPO and match.group(3) == F.TOOL_MAIN):
        spec = match.group(2) + "..." + match.group(3)
        status = gh.get("compare", {}).get(spec, "ahead")
        body = {"status": status, "total_commits": 1,
                "commits": [{"sha": match.group(3), "commit": {"message": "change in " + match.group(1) + "\n\nbody"}}],
                "files": [{"filename": name} for name in gh.get("changedFiles", {}).get(match.group(1), ["README.md"])]}
        out.write(json.dumps(body))
        return 0
    if route == f"repos/{SUSE_REPO}/actions/workflows/lolly-ing-preview.yml/runs":
        runs = [r for r in gh["ingRuns"] if (not query.get("head_sha") or r["head_sha"] == query["head_sha"])
                and (not query.get("event") or r["event"] == query["event"])]
        out.write(json.dumps({"workflow_runs": runs}))
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


def rehearsal_cluster(**scenario):
    """#208's rehearsal namespace (its own fakes), reaching the backup store at STORAGE_ADDRESS."""
    import restore_rehearsal_fakes as RF
    return RF.cluster(**scenario)
