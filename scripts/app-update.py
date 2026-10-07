#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Plan and apply reviewed, image-only Kubernetes application updates."""

from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import subprocess
import sys
import urllib.error
import urllib.request


COMPONENTS = frozenset({"work", "public-web", "public-mcp", "public-ca", "public-penpot",
                        "public-demo", "render-worker", "live-relay"})
IMAGE = re.compile(r"[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z")
NAME = re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\Z")
PROTECTED_DEPLOYMENT = re.compile(r"(?:^|-)(?:edge|caddy|postgres|postgresql|database)(?:-|$)")
RESERVED_NAMESPACES = frozenset({"kube-system", "kube-public", "kube-node-lease"})
PROTECTED_ROLES = frozenset({"edge", "database", "postgres", "postgresql", "storage", "cluster-dns"})


class Refusal(RuntimeError):
    """An identity, review or application boundary was not satisfied."""


class ApplyFailure(Refusal):
    """Keep partial application evidence when acceptance or a later patch fails."""

    def __init__(self, reason, applied, attempted, phase):
        super().__init__(reason)
        self.applied = copy.deepcopy(applied)
        self.attempted = copy.deepcopy(attempted)
        self.phase = phase


def require(condition, message):
    if not condition:
        raise Refusal(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite JSON number")))


def write_json(path, value):
    # Never overwrite a previously reviewed plan or receipt.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out, indent=2, allow_nan=False)
        out.write("\n")


def exact_keys(value, required, optional=()):
    require(isinstance(value, dict), "Expected JSON object")
    require(set(required) <= value.keys() and value.keys() <= set(required) | set(optional),
            "Missing or unsupported fields")


def nonempty(value, label):
    require(isinstance(value, str) and bool(value.strip()), f"Missing {label}")
    return value


def image_ref(value):
    require(isinstance(value, str) and bool(IMAGE.fullmatch(value)) and "://" not in value,
            "Image must be a repository pinned with @sha256 and 64 lowercase hex digits")
    return value


def validate_target(target):
    exact_keys(target, {"version", "transport", "clusterUID", "node", "components"})
    require(target["version"] == 1, "Unsupported target version")
    nonempty(target["clusterUID"], "kube-system namespace UID")
    exact_keys(target["node"], {"name", "uid"})
    nonempty(target["node"]["uid"], "node UID")
    require(bool(NAME.fullmatch(target["node"]["name"])), "Invalid node name")
    transport = target["transport"]
    exact_keys(transport, {"type", "kubectl", "kubeconfig", "context"},
               {"host", "jump", "knownHostsFile", "sudo"})
    require(transport["type"] in {"local", "ssh"}, "Unknown kubectl transport")
    require(isinstance(transport["kubectl"], list) and transport["kubectl"] and
            all(isinstance(v, str) and v and not v.startswith("-") for v in transport["kubectl"]),
            "kubectl must be an explicit executable argv (for example [kubectl] or [/usr/local/bin/k3s, kubectl])")
    require(os.path.isabs(nonempty(transport["kubeconfig"], "kubeconfig")), "kubeconfig must be absolute")
    nonempty(transport["context"], "context")
    if transport["type"] == "ssh":
        require(os.path.isabs(nonempty(transport.get("knownHostsFile"), "SSH known-hosts file")),
                "knownHostsFile must be absolute")
        for key in ("host", "jump"):
            if key == "host" or key in transport:
                require(bool(re.fullmatch(r"[A-Za-z0-9_.@:\[\]-]+", nonempty(transport.get(key), key)))
                        and not transport[key].startswith("-"), "Invalid SSH destination")
        require(isinstance(transport.get("sudo", False), bool), "sudo must be a boolean")
    else:
        require(not set(transport) & {"host", "jump", "knownHostsFile", "sudo"},
                "SSH fields cannot be used with local transport")
    require(isinstance(target["components"], dict) and target["components"], "No owned components")
    deployments = set()
    for name, component in target["components"].items():
        require(name in COMPONENTS, f"Unowned component: {name}")
        exact_keys(component, {"namespace", "namespaceUID", "deployment", "deploymentUID", "container"},
                   {"requiredLabels", "healthURLs"})
        for key in ("namespace", "deployment", "container"):
            require(isinstance(component[key], str) and bool(NAME.fullmatch(component[key])), f"Invalid {key}")
        for key in ("namespaceUID", "deploymentUID"):
            nonempty(component[key], key)
        require(component["namespace"] not in RESERVED_NAMESPACES, "Kubernetes system namespaces are excluded")
        require(not PROTECTED_DEPLOYMENT.search(component["deployment"]), "Edge and database deployments are excluded")
        pair = (component["namespace"], component["deployment"])
        require(pair not in deployments, "Each Deployment may be owned by only one component")
        deployments.add(pair)
        labels = component.get("requiredLabels", {})
        require(isinstance(labels, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in labels.items()),
                "requiredLabels must be a string mapping")
        urls = component.get("healthURLs", [])
        require(isinstance(urls, list) and all(isinstance(u, str) and u.startswith("https://") for u in urls),
                "Health URLs must use HTTPS")
        for url in urls:
            # urlsplit is imported here to keep health URLs credential-free.
            from urllib.parse import urlsplit
            parsed = urlsplit(url)
            require(parsed.hostname and not parsed.username and not parsed.password and not parsed.fragment,
                    "Health URL must not contain credentials or a fragment")
    return target


class Kubectl:
    def __init__(self, transport):
        self.transport = transport

    def run(self, args, timeout=60):
        t = self.transport
        command = [*t["kubectl"], "--kubeconfig", t["kubeconfig"], "--context", t["context"], *args]
        if t["type"] == "ssh":
            if t.get("sudo"):
                command = ["sudo", "-n", *command]
            ssh = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=12", "-oStrictHostKeyChecking=yes",
                   "-oUserKnownHostsFile=" + t["knownHostsFile"]]
            if t.get("jump"):
                ssh += ["-J", t["jump"]]
            command = [*ssh, t["host"], shlex.join(command)]
        try:
            completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("kubectl transport failed or timed out") from exc
        # Kubernetes errors/webhooks may echo resources. Never print raw stdout/stderr.
        require(completed.returncode == 0, f"kubectl failed (exit {completed.returncode}); inspect the named resource directly")
        return completed.stdout

    def get(self, kind, name, namespace=None):
        args = ["get", kind, name, "-o", "json"]
        if namespace:
            args += ["--namespace", namespace]
        return json.loads(self.run(args))

    def patch(self, component, patch, dry_run):
        args = ["patch", "deployment", component["deployment"], "--namespace", component["namespace"],
                "--type=json", "--patch", canonical(patch).decode(), "-o", "json"]
        if dry_run:
            args += ["--dry-run=server"]
        return json.loads(self.run(args))

    def rollout(self, component, timeout):
        self.run(["rollout", "status", "deployment/" + component["deployment"],
                  "--namespace", component["namespace"], f"--timeout={timeout}s"], timeout=timeout + 20)


def check_cluster(target, kube):
    require(kube.get("namespace", "kube-system")["metadata"]["uid"] == target["clusterUID"], "Wrong cluster UID")
    node = kube.get("node", target["node"]["name"])
    require(node["metadata"]["uid"] == target["node"]["uid"], "Wrong node UID")
    require(any(c.get("type") == "Ready" and c.get("status") == "True" for c in node["status"]["conditions"]),
            "Target node is not Ready")


def check_deployment(component, kube):
    require(kube.get("namespace", component["namespace"])["metadata"]["uid"] == component["namespaceUID"],
            "Wrong namespace UID")
    value = kube.get("deployment", component["deployment"], component["namespace"])
    require(value["metadata"]["uid"] == component["deploymentUID"], "Wrong Deployment UID")
    require(not value["metadata"].get("deletionTimestamp"), "Deployment is being deleted")
    require(value["metadata"].get("labels", {}).get("app.kubernetes.io/component") not in PROTECTED_ROLES,
            "Edge, database and storage resource roles are excluded")
    require(all(value["metadata"].get("labels", {}).get(k) == v for k, v in component.get("requiredLabels", {}).items()),
            "Deployment ownership labels changed")
    require(value["spec"].get("replicas", 1) > 0, "Deployment has no running replicas")
    matches = [i for i, c in enumerate(value["spec"]["template"]["spec"]["containers"]) if c["name"] == component["container"]]
    require(len(matches) == 1, "Owned container missing or ambiguous")
    return value, matches[0]


def protected_spec(value, index):
    spec = copy.deepcopy(value["spec"])
    spec["template"]["spec"]["containers"][index].pop("image")
    return digest(spec)


def image_patch(value, index, image):
    path = f"/spec/template/spec/containers/{index}"
    return [
        {"op": "test", "path": "/metadata/uid", "value": value["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": value["metadata"]["resourceVersion"]},
        {"op": "test", "path": path + "/name", "value": value["spec"]["template"]["spec"]["containers"][index]["name"]},
        {"op": "test", "path": path + "/image", "value": value["spec"]["template"]["spec"]["containers"][index]["image"]},
        {"op": "replace", "path": path + "/image", "value": image_ref(image)},
    ]


def guard_result(value, result, index, image):
    require(result["metadata"]["uid"] == value["metadata"]["uid"], "Patch result changed Deployment identity")
    require(result["spec"]["template"]["spec"]["containers"][index]["image"] == image, "Patch did not set requested image")
    require(protected_spec(value, index) == protected_spec(result, index),
            "Patch/admission changed protected Deployment fields")


def make_plan(target, release, kube):
    validate_target(target)
    exact_keys(release, {"version", "updates"})
    require(release["version"] == 1 and isinstance(release["updates"], list) and release["updates"], "Empty or unsupported release")
    names = set()
    for request in release["updates"]:
        exact_keys(request, {"component", "image", "expectedImage"})
        require(request["component"] in target["components"] and request["component"] not in names, "Unowned or duplicate component")
        names.add(request["component"])
        image_ref(request["image"])
        image_ref(request["expectedImage"])
    check_cluster(target, kube)
    changes, unchanged = [], []
    for request in release["updates"]:
        name = request["component"]
        component = target["components"][name]
        value, index = check_deployment(component, kube)
        old = value["spec"]["template"]["spec"]["containers"][index]["image"]
        record = {"component": name, "namespace": component["namespace"], "deployment": component["deployment"],
                  "deploymentUID": component["deploymentUID"], "resourceVersion": value["metadata"]["resourceVersion"],
                  "containerIndex": index, "container": component["container"], "beforeImage": old,
                  "image": request["image"], "protectedSpecSha256": protected_spec(value, index)}
        if old == request["image"]:
            unchanged.append(record)
            continue
        require(old == request["expectedImage"], "Current image differs from expectedImage")
        record["patch"] = image_patch(value, index, request["image"])
        guard_result(value, kube.patch(component, record["patch"], True), index, request["image"])
        changes.append(record)
    return {"version": 1, "targetSha256": digest(target), "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "updates": changes, "unchanged": unchanged}


def validate_plan(target, plan, reviewed_hash):
    validate_target(target)
    require(isinstance(reviewed_hash, str) and re.fullmatch(r"[0-9a-f]{64}", reviewed_hash), "--apply requires --reviewed-plan-sha256")
    require(hmac.compare_digest(digest(plan), reviewed_hash), "Reviewed plan hash does not match")
    exact_keys(plan, {"version", "targetSha256", "generatedAt", "updates", "unchanged"})
    require(plan["version"] == 1 and plan["targetSha256"] == digest(target), "Plan belongs to a different target")
    require(isinstance(plan["updates"], list) and isinstance(plan["unchanged"], list), "Invalid plan entries")
    seen = set()
    for changing, records in ((True, plan["updates"]), (False, plan["unchanged"])):
        for record in records:
            exact_keys(record, {"component", "namespace", "deployment", "deploymentUID", "resourceVersion", "containerIndex",
                                "container", "beforeImage", "image", "protectedSpecSha256"}, {"patch"} if changing else set())
            name = record["component"]
            require(name in target["components"] and name not in seen, "Unowned or duplicate planned component")
            seen.add(name)
            component = target["components"][name]
            require(all(record[key] == component[key] for key in ("namespace", "deployment", "deploymentUID", "container")),
                    "Planned resource does not match target")
            image_ref(record["image"])
            image_ref(record["beforeImage"])
            require(type(record["containerIndex"]) is int and 0 <= record["containerIndex"] < 128, "Invalid container index")
            nonempty(record["resourceVersion"], "resourceVersion")
            require(bool(re.fullmatch(r"[0-9a-f]{64}", record["protectedSpecSha256"])), "Invalid protected spec hash")
            require((record["beforeImage"] != record["image"]) == changing, "Invalid unchanged record")
            if changing:
                index = record["containerIndex"]
                synthetic = {"metadata": {"uid": record["deploymentUID"], "resourceVersion": record["resourceVersion"]},
                             "spec": {"template": {"spec": {"containers": [{} for _ in range(index + 1)]}}}}
                synthetic["spec"]["template"]["spec"]["containers"][index] = {"name": record["container"], "image": record["beforeImage"]}
                require(record.get("patch") == image_patch(synthetic, index, record["image"]), "Plan contains a protected or unexpected patch")
    require(bool(seen), "Empty plan")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def health_check(url):
    # No credentials, cookies, redirect following or response-body logging.
    try:
        # Standard SSL_CERT_FILE / SSL_CERT_DIR select a trusted CA bundle;
        # hostname and certificate verification are never disabled.
        context = ssl.create_default_context()
        with urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context)).open(url, timeout=15) as response:
            require(response.status == 200, "HTTPS health check did not return 200")
    except (OSError, urllib.error.URLError) as exc:
        raise Refusal("HTTPS health check failed; inspect the configured URL") from exc


def apply_plan(target, plan, reviewed_hash, kube, timeout=180, health=health_check):
    validate_plan(target, plan, reviewed_hash)
    check_cluster(target, kube)
    # Validate every image and server-side dry run before the first write.
    for record in plan["updates"] + plan["unchanged"]:
        component = target["components"][record["component"]]
        value, index = check_deployment(component, kube)
        require(index == record["containerIndex"] and protected_spec(value, index) == record["protectedSpecSha256"],
                "Protected Deployment fields changed since review")
        require(value["spec"]["template"]["spec"]["containers"][index]["image"] == record["beforeImage"], "Image changed since review")
        if "patch" in record:
            require(value["metadata"]["resourceVersion"] == record["resourceVersion"], "Resource version changed; make and review a new plan")
            guard_result(value, kube.patch(component, record["patch"], True), index, record["image"])
    applied, attempted, phase = [], [], "pre-patch"
    try:
        for record in plan["updates"]:
            component = target["components"][record["component"]]
            # Repeat identity and concurrency checks immediately before each mutation.
            phase = "pre-patch:" + record["component"]
            check_cluster(target, kube)
            before, index = check_deployment(component, kube)
            require(before["metadata"]["resourceVersion"] == record["resourceVersion"], "Resource version changed before patch; stop and re-plan")
            change = {"component": record["component"], "beforeImage": record["beforeImage"], "image": record["image"]}
            phase = "patch:" + record["component"]
            attempted.append(change)
            print(json.dumps({"phase": "patch-attempt", **change}), flush=True)
            result = kube.patch(component, record["patch"], False)
            applied.append(change)
            guard_result(before, result, index, record["image"])
            print(json.dumps({"phase": "patched", **change}), flush=True)
        for record in plan["updates"]:
            component = target["components"][record["component"]]
            phase = "rollout:" + record["component"]
            kube.rollout(component, timeout)
            value, index = check_deployment(component, kube)
            require(value["spec"]["template"]["spec"]["containers"][index]["image"] == record["image"], "Image changed during rollout")
            require(protected_spec(value, index) == record["protectedSpecSha256"], "Protected fields changed during rollout")
            status = value.get("status", {})
            replicas = value["spec"].get("replicas", 1)
            require(status.get("observedGeneration", 0) >= value["metadata"].get("generation", 1)
                    and status.get("updatedReplicas", 0) == replicas and status.get("availableReplicas", 0) == replicas
                    and status.get("replicas", 0) == replicas, "Deployment rollout is not fully Ready")
            phase = "https-health:" + record["component"]
            for url in component.get("healthURLs", []):
                health(url)
    except (Refusal, OSError, ValueError, KeyError, TypeError, IndexError) as exc:
        reason = str(exc) if isinstance(exc, Refusal) else "Invalid resource response during apply"
        raise ApplyFailure(reason, applied, attempted, phase) from exc
    return {"result": "UPDATED" if applied else "NO_CHANGE", "reviewedPlanSha256": reviewed_hash,
            "updated": applied, "unchanged": [r["component"] for r in plan["unchanged"]],
            "databaseRollback": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="Explicit non-secret target JSON")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--release", help="Image release JSON; produce a plan without writes")
    mode.add_argument("--apply", metavar="PLAN", help="Apply this exact reviewed plan")
    parser.add_argument("--plan-out", help="New plan file to create, mode 600")
    parser.add_argument("--reviewed-plan-sha256")
    parser.add_argument("--receipt-out", help="New successful update receipt, mode 600")
    parser.add_argument("--rollout-timeout", type=int, default=180)
    args = parser.parse_args(argv)
    try:
        require(1 <= args.rollout_timeout <= 1800, "Rollout timeout must be 1..1800 seconds")
        target = validate_target(load_json(args.target))
        kube = Kubectl(target["transport"])
        if args.release:
            require(args.plan_out and not args.reviewed_plan_sha256 and not args.receipt_out, "Planning requires --plan-out and no apply-only flags")
            plan = make_plan(target, load_json(args.release), kube)
            write_json(args.plan_out, plan)
            print(json.dumps({"result": "PLANNED" if plan["updates"] else "NO_CHANGE", "plan": args.plan_out,
                              "reviewedPlanSha256": digest(plan), "updates": plan["updates"], "unchanged": plan["unchanged"]}, indent=2))
        else:
            require(not args.plan_out, "--plan-out is only for planning")
            if args.receipt_out:
                require(not Path(args.receipt_out).exists(), "Receipt already exists; choose a new path")
            plan = load_json(args.apply)
            result = apply_plan(target, plan, args.reviewed_plan_sha256, kube, args.rollout_timeout)
            if args.receipt_out:
                write_json(args.receipt_out, result)
            print(json.dumps(result, indent=2))
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError) as exc:
        # Do not expose credentials or full API responses in error messages.
        message = str(exc) if isinstance(exc, Refusal) else "Invalid input or resource response; inspect the named files/resources"
        failure = {"result": "REFUSED", "reason": message,
                   "note": "Earlier patches remain applied; a failed transport may also have committed its last patch. Inspect patch attempts; no automatic rollback."}
        if isinstance(exc, ApplyFailure):
            failure.update(updated=exc.applied, patchAttempts=exc.attempted, failedPhase=exc.phase, databaseRollback=False)
        print(json.dumps(failure), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
