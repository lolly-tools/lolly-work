# SPDX-License-Identifier: MPL-2.0
"""A fake kubectl for tests/test_restore_rehearsal.py.

The fake is a small executable that calls `kubectl_main` here and keeps the
cluster in a JSON file (FAKE_REHEARSAL_STATE), so the driver runs its real
subprocess path. A scenario decides how the rehearsal Pod's containers end and
what each one prints. No cluster, node or database is ever contacted.
"""

from __future__ import annotations

import contextlib
import copy
import json
import os
import sys
import uuid
from pathlib import Path

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
LIB = ROOT / "deploy" / "preview" / "lib"
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))

import preview_rehearsal as R  # noqa: E402

NAMESPACE = R.NAMESPACE
STORAGE_HOST = "backups.example.test"
STORAGE_ADDRESS = "203.0.113.7"
NEW_IMAGE = "docker.io/library/lolly-work@sha256:" + "c" * 64
PREVIOUS_IMAGE = "docker.io/library/lolly-work@sha256:" + "d" * 64
POSTGRES_IMAGE = "dp.apps.rancher.io/containers/postgresql@sha256:" + "e" * 64
BACKUP = {"status": "VERIFIED", "object": "lolly/backups/2026-10-24T07-00-00-000Z-0123456789abcdef.lwbackup",
          "sha256": "a" * 64, "size": 161115, "keyId": "0123456789abcdef"}
PENDING = [{"name": "0078_widgets.sql", "sha256": "1" * 64}, {"name": "0077_gadgets.sql", "sha256": "2" * 64}]
APPLIED_BEFORE = [f"{n:04d}_m.sql" for n in range(1, 68)]


def inputs(**overrides):
    values = dict(backup=BACKUP, pending=PENDING, new_image=NEW_IMAGE, previous_image=PREVIOUS_IMAGE,
                  postgres_image=POSTGRES_IMAGE, storage_host=STORAGE_HOST, storage_address=STORAGE_ADDRESS, run_id="r1")
    values.update(overrides)
    return R.Inputs(**values)


def cluster(**scenario):
    """A rehearsal namespace as setup_manifests renders it, plus a scenario."""
    setup = R.setup_manifests(NAMESPACE, [STORAGE_ADDRESS + "/32"])["items"]
    namespace = copy.deepcopy(setup[0])
    namespace["metadata"]["uid"] = "ns-uid"
    namespace["status"] = {"phase": "Active"}
    policies = [dict(copy.deepcopy(item), metadata=dict(item["metadata"], uid=f"np-{i}")) for i, item in enumerate(setup[1:3])]
    quota = dict(copy.deepcopy(setup[3]), metadata=dict(setup[3]["metadata"], uid="quota-uid"))
    return {
        "serverVersion": {"major": "1", "minor": "33", "gitVersion": "v1.33.5+k3s1"},
        "namespaces": {NAMESPACE: namespace},
        "networkpolicies": {NAMESPACE: policies},
        "resourcequotas": {NAMESPACE: [quota]},
        "objects": {NAMESPACE: {"Pod": {}, "ConfigMap": {"kube-root-ca.crt": {"kind": "ConfigMap", "metadata": {
            "name": "kube-root-ca.crt", "namespace": NAMESPACE, "uid": "root-ca"}}}, "PersistentVolumeClaim": {}}},
        "scenario": {"failAt": None, "polls": 2, **scenario},
        "deleted": [],
        "calls": [],
    }


@contextlib.contextmanager
def state_file(path):
    state = json.loads(Path(path).read_text())
    try:
        yield state
    finally:
        Path(path).write_text(json.dumps(state))


def _out(value):
    sys.stdout.write(json.dumps(value))
    return 0


def _err(message, code=1):
    sys.stderr.write(message + "\n")
    return code


def _items(state, ns, kinds):
    objects = state["objects"].get(ns, {})
    return [obj for kind in kinds for obj in objects.get(kind, {}).values()]


def _with_defaults(obj):
    """What the API server adds: identity, timestamps and per-container defaults."""
    out = copy.deepcopy(obj)
    out["metadata"].setdefault("uid", str(uuid.uuid4()))
    out["metadata"]["creationTimestamp"] = "2026-10-24T08:00:00Z"
    out["metadata"]["resourceVersion"] = "1"
    if out["kind"] == "Pod":
        for c in out["spec"]["initContainers"] + out["spec"]["containers"]:
            c.setdefault("terminationMessagePath", "/dev/termination-log")
        out["spec"]["schedulerName"] = "default-scheduler"
    return out


# --- the rehearsal Pod's run ---------------------------------------------------

def _reports(state, pod):
    """What each step prints, made from the ConfigMap the driver created."""
    scenario = state["scenario"]
    cm = state["objects"][pod["metadata"]["namespace"]]["ConfigMap"][pod["metadata"]["name"]]["data"]
    archive = json.loads(cm["archive.json"])
    pending = [f["name"] for f in json.loads(cm["pending.json"])]
    budget = int(cm["lock-budget-seconds"])
    seconds = scenario.get("seconds", {})
    files = [{"name": n, "seconds": seconds.get(n, 0.42)} for n in sorted(pending)]
    over = [f for f in files if f["seconds"] > budget]
    verify_status = "LOCK_BUDGET_EXCEEDED" if over else "RECORD_OK"
    reports = {
        "fetch": {"step": "fetch", "status": "RECOVERED", "sha256": archive["sha256"], "size": archive["size"],
                  "keyId": archive["keyId"]},
        "restore": {"step": "restore", "status": "RESTORED", "database": cm["database"], "serverVersion": "180006",
                    "listenAddresses": "", "publicTables": 79, "restoreSeconds": 1, "archiveSha256": archive["sha256"],
                    "archiveSize": archive["size"], "appliedBefore": APPLIED_BEFORE},
        "migrate": {"step": "migrate", "status": "APPLIED", "applied": pending, "exitCode": 0},
        "verify": {"step": "verify", "status": verify_status, "lockBudgetSeconds": budget, "files": files,
                   "missing": [], "unexpected": [], "appliedAfterCount": len(APPLIED_BEFORE) + len(pending)},
        "previous": {"step": "previous", "status": "ROUND_TRIP_OK", "requests": ["GET /healthz 200"], "savedRevision": 2},
    }
    for step, change in scenario.get("reports", {}).items():
        reports[step].update(change)
    return reports


def _finish(state, pod):
    scenario = state["scenario"]
    reports = _reports(state, pod)
    fail_at = scenario.get("failAt")
    if fail_at is None and reports["verify"]["status"] != "RECORD_OK":
        fail_at = "verify"
    images = {c["name"]: c["image"] for c in pod["spec"]["initContainers"] + pod["spec"]["containers"]}
    images.update(scenario.get("imageIDs", {}))
    logs = {"postgres": "2026-10-24 08:00:00 LOG: database system is ready to accept connections\n"}
    statuses = {}
    reached = True
    for name in ("fetch", "postgres", "restore", "migrate", "verify", "previous"):
        status = {"name": name, "image": images[name], "imageID": images[name],
                  "restartCount": scenario.get("restarts", {}).get(name, 0)}
        if name == "postgres":
            status["state"] = {"terminated": {"exitCode": 0, "reason": "Completed"}} if reached else {"waiting": {"reason": "PodInitializing"}}
        elif not reached:
            status["state"] = {"waiting": {"reason": "PodInitializing"}}
        elif scenario.get("deadlineAt") == name:
            status["state"] = {"running": {"startedAt": "2026-10-24T08:00:00Z"}}
            reached = False
        else:
            failed = fail_at == name
            report = reports[name]
            if failed and name != "verify":
                report = {"step": name, "status": "FAILED", "reason": scenario.get("reason", f"{name} broke")}
            status["state"] = {"terminated": {"exitCode": 1 if failed else 0, "reason": "Error" if failed else "Completed"}}
            logs[name] = "some output\n" + json.dumps(report) + "\n"
            if failed:
                reached = False
        statuses[name] = status
    if scenario.get("lockTimeout"):
        logs["postgres"] += f"2026-10-24 08:00:31 FATAL:  {R.TIMEOUT_LOG_LINE}\n"
    ok = reached and not scenario.get("deadlineAt")
    pod["status"] = {
        "phase": "Succeeded" if ok else "Failed",
        "initContainerStatuses": [statuses[n] for n in ("fetch", "postgres", "restore", "migrate", "verify")],
        "containerStatuses": [statuses["previous"]],
    }
    if scenario.get("deadlineAt"):
        pod["status"]["reason"] = "DeadlineExceeded"
    if scenario.get("podStatusGarbage"):
        pod["status"]["initContainerStatuses"].append({"state": {}})  # a status without a name
    pod["fakeLogs"] = logs


def _poll(state, pod):
    scenario = state["scenario"]
    if scenario.get("neverStarts"):
        waiting = {"waiting": {"reason": "ContainerCreating"}}
        pod["status"] = {"phase": "Pending", "initContainerStatuses": [
            {"name": n, "state": waiting, "restartCount": 0} for n in ("fetch", "postgres", "restore", "migrate", "verify")]}
        return
    pod["fakePolls"] = pod.get("fakePolls", 0) + 1
    if pod["fakePolls"] <= scenario["polls"]:
        pod["status"] = {"phase": "Pending", "initContainerStatuses": [
            {"name": "fetch", "state": {"running": {}}, "restartCount": 0}]}
        return
    if "fakeLogs" not in pod:
        _finish(state, pod)


def _public(obj):
    return {k: v for k, v in obj.items() if not k.startswith("fake")}


# --- kubectl -----------------------------------------------------------------

def kubectl_main(argv):
    state_path = os.environ["FAKE_REHEARSAL_STATE"]
    body = sys.stdin.read() if "-f" in argv and argv[argv.index("-f") + 1] == "-" else None
    with state_file(state_path) as state:
        state["calls"].append(argv)
        scenario = state["scenario"]
        args = list(argv)
        ns = args[args.index("-n") + 1] if "-n" in args else None
        if args[:1] == ["version"]:
            return _out({"clientVersion": {"major": "1", "minor": "33"}, "serverVersion": state["serverVersion"]})
        if args[:2] == ["get", "namespace"]:
            found = state["namespaces"].get(args[2])
            return _out(found) if found else _err(f'Error from server (NotFound): namespaces "{args[2]}" not found')
        if args[:2] == ["get", "networkpolicies"]:
            return _out({"kind": "List", "items": state["networkpolicies"].get(ns, [])})
        if args[:2] == ["get", "resourcequotas"]:
            return _out({"kind": "List", "items": state["resourcequotas"].get(ns, [])})
        if args[:2] == ["get", "pods,configmaps,persistentvolumeclaims"]:
            return _out({"kind": "List", "items": [_public(o) for o in _items(state, ns, ("Pod", "ConfigMap", "PersistentVolumeClaim"))]})
        if args[:2] == ["get", "pods,configmaps"] and "-l" in args:
            wanted = dict(pair.split("=", 1) for pair in args[args.index("-l") + 1].split(","))
            return _out({"kind": "List", "items": [_public(o) for o in _items(state, ns, ("Pod", "ConfigMap"))
                                                   if all((o["metadata"].get("labels") or {}).get(k) == v for k, v in wanted.items())]})
        if args[:1] == ["get"] and args[1] in ("pod", "configmap"):
            kind = {"pod": "Pod", "configmap": "ConfigMap"}[args[1]]
            obj = state["objects"].get(ns, {}).get(kind, {}).get(args[2])
            if obj is None:
                return 0 if "--ignore-not-found" in args else _err(f'Error from server (NotFound): {args[1]}s "{args[2]}" not found')
            if kind == "Pod" and "--ignore-not-found" not in args:
                _poll(state, obj)
            if "--ignore-not-found" in args and scenario.get("lingers", {}).get(kind):
                return _out(_public(obj))
            return _out(_public(obj))
        if args[:1] == ["create"]:
            obj = json.loads(body)
            target = obj["metadata"]["namespace"]
            existing = state["objects"].setdefault(target, {}).setdefault(obj["kind"], {})
            if obj["metadata"]["name"] in existing:
                return _err(f'Error from server (AlreadyExists): {obj["kind"]} exists')
            if "--dry-run=server" in args:
                result = _with_defaults(obj)
                if obj["kind"] == "Pod" and scenario.get("admissionAddsContainer"):
                    result["spec"]["containers"].append({"name": "injected", "image": "example/sidecar:1"})
                return _out(result)
            created = _with_defaults(obj)
            existing[obj["metadata"]["name"]] = created
            return _out(_public(created))
        if args[:1] == ["logs"]:
            pod = state["objects"].get(ns, {}).get("Pod", {}).get(args[1])
            container = args[args.index("-c") + 1]
            if pod is None or container not in (pod.get("fakeLogs") or {}):
                return _err("container has not run")
            sys.stdout.write(pod["fakeLogs"][container])
            return 0
        if args[:2] == ["delete", "--raw"]:
            parts = args[2].strip("/").split("/")  # api v1 namespaces NS plural NAME
            target, plural, name = parts[3], parts[4], parts[5]
            kind = {"pods": "Pod", "configmaps": "ConfigMap"}[plural]
            options = json.loads(body)
            if scenario.get("deleteFails"):
                return _err("Error from server (InternalError): etcd is sad")
            objects = state["objects"].get(target, {}).get(kind, {})
            if name not in objects:
                return _err(f'Error from server (NotFound): {plural} "{name}" not found')
            if options.get("preconditions", {}).get("uid") != objects[name]["metadata"]["uid"]:
                return _err("Error from server (Conflict): Precondition failed: UID in precondition")
            state["deleted"].append({"kind": kind, "name": name, "uid": objects[name]["metadata"]["uid"]})
            if not scenario.get("lingers", {}).get(kind):
                del objects[name]
            return _out({"kind": "Status", "status": "Success"})
        return _err("unsupported fake kubectl " + " ".join(args[:3]))


def write_kubectl(bin_dir):
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    path = bin_dir / "kubectl"
    path.write_text(f"#!{sys.executable} -S\nimport sys\nsys.dont_write_bytecode = True\n"
                    f"sys.path.insert(0, {str(TESTS)!r})\nimport restore_rehearsal_fakes as f\n"
                    "raise SystemExit(f.kubectl_main(sys.argv[1:]))\n")
    path.chmod(0o755)
    return path


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
