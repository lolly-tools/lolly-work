# SPDX-License-Identifier: MPL-2.0
"""Restore rehearsal: prove a backup restores, its pending migrations apply within
the lock budget, and the previous image still works on the result, on a throwaway
copy. Python 3.9+ standard library only.

One run is one Pod in a dedicated rehearsal namespace. Its containers run in order:

1. fetch (previous image): recover exactly the named backup object with the
   image's own backup CLI. The only container that mounts the read-only backup
   credential.
2. postgres (pinned PostgreSQL image, a native sidecar): a fresh cluster on
   emptyDir, listening on a Unix socket only.
3. restore (PostgreSQL image): verify the archive and restore it as the
   application role; record the applied migrations; cap every transaction at the lock budget.
4. migrate (new image): the image's own runner with only DATABASE_URL,
   LW_MIGRATE_EXPECT and NODE_ENV in its environment.
5. verify (PostgreSQL image): schema_migrations is exactly the restored set plus
   the pending files; time each file against the budget.
6. previous (previous image): boot its server with LW_AUTO_MIGRATE=false against
   the migrated copy and make one save round trip.

All data lives on emptyDir and goes with the Pod. The namespace, its deny-all
NetworkPolicy, its one egress rule (HTTPS to the backup store) and the read-only
backup credential are installed once by the operator (`setup_manifests`); the
driver only checks them. It never reads a Secret, never names a PVC, never
creates a NetworkPolicy and never touches another namespace. Every object it
creates carries the run's label and is deleted by UID.

The driver takes the argv of a kubectl-like executable, so tests run it against
a fake (tests/restore_rehearsal_fakes.py).
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import json
import re
import secrets
import subprocess
import time
from pathlib import Path

from preview_common import Refusal, compact, require, sha256_hex, utc_stamp

PROGRAMS_DIR = Path(__file__).resolve().parents[1] / "rehearsal"
PROGRAM_FILES = ("fetch-archive.mjs", "postgres.sh", "restore.sh", "migrate.mjs", "verify.sh", "previous-roundtrip.mjs")

MANAGED_BY = "lolly-restore-rehearsal"
NAMESPACE = "lolly-restore-rehearsal"
COMPONENT = "restore-rehearsal"
RUN_LABEL = "lolly.tools/rehearsal-run"
INPUTS_ANNOTATION = "lolly.tools/rehearsal-inputs-sha256"
SECRET = "restore-rehearsal-backup-read"
SECRET_KEYS = ("storage.json", "encryption-key.txt")
DENY_POLICY = "rehearsal-deny-all"
EGRESS_POLICY = "rehearsal-backup-egress"
QUOTA = "rehearsal-quota"
DATABASE = "lolly_rehearsal"
APP_ROLE = "lollywork"
POSTGRES_PORT = 55432
POSTGRES_MAJOR = 18
LOCK_BUDGET_SECONDS = 30
MAX_LOCK_BUDGET_SECONDS = 120  # the runner's own statement timeout
DEADLINE_SECONDS = 900
MIN_KUBERNETES_MINOR = 29  # native sidecar containers are on by default from 1.29
TIMEOUT_LOG_LINE = "terminating connection due to transaction timeout"
# The live instances and the cluster's own namespaces. A rehearsal never runs there.
FORBIDDEN_NAMESPACES = frozenset({"default", "kube-system", "kube-public", "kube-node-lease", "lolly-private",
                                  "lolly-public", "lolly-edge", "lolly-admission", "lolly-demo"})
STEPS = ("fetch", "restore", "migrate", "verify", "previous")
MANIFEST_HEADER = "lolly-work migration manifest v1\n"

IMAGE = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+"
                   r"@sha256:[0-9a-f]{64}\Z")
MIGRATION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.sql\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
KEY_ID = re.compile(r"[0-9a-f]{16}\Z")
RUN_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\Z")
DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
HOSTNAME = re.compile(r"(?=.{4,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
OBJECT_PART = re.compile(r"[A-Za-z0-9._-]+\Z")
SIZE = re.compile(r"[1-9][0-9]{0,3}Gi\Z")


# ---------------------------------------------------------------------------
# Inputs

def migration_manifest(files):
    """sha256 over the manifest header and one `name<TAB>sha256` line per file in
    name order. Byte for byte server/src/store/migrate.ts migrationManifest."""
    lines = "".join(f"{f['name']}\t{f['sha256']}\n" for f in sorted(files, key=lambda f: f["name"]))
    return "sha256:" + hashlib.sha256((MANIFEST_HEADER + lines).encode()).hexdigest()


def migrate_expectation(files):
    """The LW_MIGRATE_EXPECT value for the pending files: `none`, or their manifest."""
    return migration_manifest(files) if files else "none"


def parse_backup(value):
    """The off-host backup uploader's own result line (scripts/backup-object.ts upload)."""
    require(isinstance(value, dict) and set(value) == {"status", "object", "sha256", "size", "keyId"}
            and value["status"] == "VERIFIED", "BAD_INPUT", "the backup record must be the uploader's VERIFIED result")
    require(isinstance(value["sha256"], str) and HEX64.match(value["sha256"]), "BAD_INPUT", "backup sha256")
    require(isinstance(value["keyId"], str) and KEY_ID.match(value["keyId"]), "BAD_INPUT", "backup keyId")
    require(type(value["size"]) is int and 0 < value["size"] <= 128 * 1024 * 1024, "BAD_INPUT", "backup size")
    obj = value["object"]
    require(isinstance(obj, str) and len(obj) <= 512 and obj.endswith(".lwbackup")
            and all(OBJECT_PART.match(part) and part not in (".", "..") for part in obj.split("/")),
            "BAD_INPUT", "backup object name")
    return dict(value)


def parse_pending(value):
    """Pending migration files [{name, sha256}], returned in apply (name) order."""
    require(isinstance(value, list), "BAD_INPUT", "pending files must be a list")
    seen = set()
    for item in value:
        require(isinstance(item, dict) and set(item) == {"name", "sha256"}, "BAD_INPUT", "pending file entries are {name, sha256}")
        require(isinstance(item["name"], str) and MIGRATION_NAME.match(item["name"]) and ".." not in item["name"],
                "BAD_INPUT", "pending file name")
        require(isinstance(item["sha256"], str) and HEX64.match(item["sha256"]), "BAD_INPUT", "pending file sha256")
        require(item["name"] not in seen, "BAD_INPUT", "a pending file is named twice")
        seen.add(item["name"])
    return sorted(({"name": i["name"], "sha256": i["sha256"]} for i in value), key=lambda i: i["name"])


def new_run_id(now=None):
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    return moment.strftime("%Y%m%dt%H%M%Sz") + "-" + secrets.token_hex(3)


class Inputs:
    """Everything one rehearsal needs. All of it is non-secret."""

    def __init__(self, *, backup, new_image, previous_image, postgres_image, pending, storage_host, storage_address,
                 namespace=NAMESPACE, secret=SECRET, run_id=None, lock_budget_seconds=LOCK_BUDGET_SECONDS,
                 deadline_seconds=DEADLINE_SECONDS, pgdata_size="4Gi", pull_secret=None):
        self.backup = parse_backup(backup)
        self.pending = parse_pending(pending)
        for label, image in (("new image", new_image), ("previous image", previous_image), ("PostgreSQL image", postgres_image)):
            require(isinstance(image, str) and IMAGE.match(image), "BAD_INPUT", f"the {label} must be a repository@sha256 digest")
        self.new_image, self.previous_image, self.postgres_image = new_image, previous_image, postgres_image
        require(isinstance(namespace, str) and DNS_LABEL.match(namespace) and namespace not in FORBIDDEN_NAMESPACES
                and not namespace.startswith("kube-"), "BAD_INPUT", f"namespace {namespace!r} may not hold a rehearsal")
        self.namespace = namespace
        require(isinstance(secret, str) and DNS_LABEL.match(secret), "BAD_INPUT", "backup credential Secret name")
        self.secret = secret
        require(pull_secret is None or (isinstance(pull_secret, str) and DNS_LABEL.match(pull_secret)), "BAD_INPUT", "pull Secret name")
        self.pull_secret = pull_secret
        host = storage_host.lower() if isinstance(storage_host, str) else ""
        require(HOSTNAME.match(host), "BAD_INPUT", "storage host must be a DNS name")
        self.storage_host = host
        try:
            address = ipaddress.ip_address(storage_address)
        except (TypeError, ValueError) as exc:
            raise Refusal("BAD_INPUT", "storage address must be an IP address") from exc
        require(not (address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified),
                "BAD_INPUT", "storage address is not a routable host")
        self.storage_address = str(address)
        self.run_id = run_id or new_run_id()
        require(isinstance(self.run_id, str) and RUN_ID.match(self.run_id), "BAD_INPUT", "run id")
        require(type(lock_budget_seconds) is int and 1 <= lock_budget_seconds <= MAX_LOCK_BUDGET_SECONDS,
                "BAD_INPUT", f"lock budget must be 1-{MAX_LOCK_BUDGET_SECONDS} seconds")
        self.lock_budget_seconds = lock_budget_seconds
        require(type(deadline_seconds) is int and 120 <= deadline_seconds <= 3600, "BAD_INPUT", "deadline must be 120-3600 seconds")
        self.deadline_seconds = deadline_seconds
        require(isinstance(pgdata_size, str) and SIZE.match(pgdata_size), "BAD_INPUT", "pgdata size must be like 4Gi")
        self.pgdata_size = pgdata_size

    @property
    def name(self):
        return f"restore-rehearsal-{self.run_id}"

    @property
    def expect(self):
        return migrate_expectation(self.pending)

    def record(self):
        return {"runId": self.run_id, "namespace": self.namespace, "backup": self.backup, "pending": self.pending,
                "expect": self.expect, "images": {"new": self.new_image, "previous": self.previous_image,
                                                  "postgres": self.postgres_image},
                "storage": {"host": self.storage_host, "address": self.storage_address},
                "lockBudgetSeconds": self.lock_budget_seconds, "deadlineSeconds": self.deadline_seconds}


# ---------------------------------------------------------------------------
# Manifests

def labels(run_id=None):
    value = {"app.kubernetes.io/managed-by": MANAGED_BY, "app.kubernetes.io/component": COMPONENT}
    if run_id:
        value[RUN_LABEL] = run_id
    return value


def setup_manifests(namespace=NAMESPACE, egress_cidrs=(), secret=SECRET):
    """The objects the operator reviews and applies once. The backup credential is
    not among them: the operator creates it by hand (see the README)."""
    require(DNS_LABEL.match(namespace) and namespace not in FORBIDDEN_NAMESPACES and not namespace.startswith("kube-"),
            "BAD_INPUT", f"namespace {namespace!r} may not hold a rehearsal")
    require(DNS_LABEL.match(secret), "BAD_INPUT", "backup credential Secret name")
    peers = []
    for cidr in egress_cidrs:
        try:
            network = ipaddress.ip_network(cidr, strict=True)
        except ValueError as exc:
            raise Refusal("BAD_INPUT", f"egress CIDR {cidr!r}") from exc
        require(network.prefixlen > 0 and not network.is_loopback and not network.is_link_local, "BAD_INPUT",
                f"egress CIDR {cidr!r} is too wide or not routable; name the backup store's addresses")
        peers.append({"ipBlock": {"cidr": str(network)}})
    require(peers, "BAD_INPUT", "name at least one egress CIDR for the backup store")
    restricted = {"pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "latest",
                  "pod-security.kubernetes.io/audit": "restricted", "pod-security.kubernetes.io/warn": "restricted"}
    return {"apiVersion": "v1", "kind": "List", "items": [
        {"apiVersion": "v1", "kind": "Namespace",
         "metadata": {"name": namespace, "labels": {"app.kubernetes.io/managed-by": MANAGED_BY, **restricted}}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
         "metadata": {"name": DENY_POLICY, "namespace": namespace, "labels": labels()},
         "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}},
        {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
         "metadata": {"name": EGRESS_POLICY, "namespace": namespace, "labels": labels()},
         "spec": {"podSelector": {"matchLabels": {"app.kubernetes.io/component": COMPONENT}},
                  "policyTypes": ["Ingress", "Egress"],
                  "egress": [{"to": peers, "ports": [{"protocol": "TCP", "port": 443}]}]}},
        {"apiVersion": "v1", "kind": "ResourceQuota",
         "metadata": {"name": QUOTA, "namespace": namespace, "labels": labels()},
         "spec": {"hard": {"pods": "1", "requests.cpu": "2", "limits.cpu": "3", "requests.memory": "2Gi",
                           "limits.memory": "3Gi", "persistentvolumeclaims": "0", "services": "0",
                           "services.loadbalancers": "0", "services.nodeports": "0", "configmaps": "4", "secrets": "3"}}},
    ]}


def read_programs(directory=PROGRAMS_DIR):
    programs = {}
    for name in PROGRAM_FILES:
        path = Path(directory) / name
        require(path.is_file() and not path.is_symlink(), "TOOL_INVALID", f"rehearsal program {name} is missing")
        programs[name] = path.read_text(encoding="utf-8")
    return programs


def _security():
    return {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "runAsNonRoot": True,
            "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}}


def _resources(cpu_request, memory_request, cpu_limit, memory_limit):
    return {"requests": {"cpu": cpu_request, "memory": memory_request, "ephemeral-storage": "64Mi"},
            "limits": {"cpu": cpu_limit, "memory": memory_limit, "ephemeral-storage": "256Mi"}}


def _mount(volume, path, read_only=False):
    mount = {"name": volume, "mountPath": path}
    if read_only:
        mount["readOnly"] = True
    return mount


def _container(name, image, command, mounts, resources, env=None):
    container = {"name": name, "image": image, "imagePullPolicy": "IfNotPresent", "command": command,
                 "securityContext": _security(), "resources": resources,
                 "volumeMounts": [_mount("programs", "/programs", True), *mounts, _mount(f"tmp-{name}", "/tmp")],
                 "terminationMessagePolicy": "FallbackToLogsOnError"}
    if env is not None:
        container["env"] = env
    return container


def run_manifests(inputs, programs):
    """The ConfigMap and the Pod for one run."""
    database_url = f"postgresql://{APP_ROLE}@/{DATABASE}?host=/socket&port={POSTGRES_PORT}"
    data = dict(programs)
    data.update({
        "postgres-major": str(POSTGRES_MAJOR), "postgres-port": str(POSTGRES_PORT), "database": DATABASE,
        "app-role": APP_ROLE, "lock-budget-seconds": str(inputs.lock_budget_seconds),
        "archive-sha256": inputs.backup["sha256"], "archive-size": str(inputs.backup["size"]),
        "archive.json": compact({"object": inputs.backup["object"], "sha256": inputs.backup["sha256"],
                                 "size": inputs.backup["size"], "keyId": inputs.backup["keyId"],
                                 "storageHost": inputs.storage_host}),
        "pending.json": compact(inputs.pending),
        "pending.txt": "".join(f"{f['name']}\n" for f in inputs.pending),
    })
    meta = {"name": inputs.name, "namespace": inputs.namespace, "labels": labels(inputs.run_id)}
    config_map = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": dict(meta), "immutable": True, "data": data}
    socket, evidence = _mount("socket", "/socket"), _mount("evidence", "/evidence")
    init = [
        _container("fetch", inputs.previous_image, ["node", "/programs/fetch-archive.mjs"],
                   [_mount("backup", "/run/backup", True), _mount("archive", "/archive")],
                   _resources("50m", "256Mi", "1", "768Mi")),
        dict(_container("postgres", inputs.postgres_image, ["bash", "/programs/postgres.sh"],
                        [_mount("pgdata", "/pgdata"), socket], _resources("100m", "256Mi", "1", "1Gi")),
             restartPolicy="Always",
             startupProbe={"exec": {"command": ["pg_isready", "-q", "-h", "/socket", "-p", str(POSTGRES_PORT),
                                                "-U", "rehearsal", "-d", "postgres"]},
                           "periodSeconds": 2, "failureThreshold": 60}),
        _container("restore", inputs.postgres_image, ["bash", "/programs/restore.sh"],
                   [_mount("archive", "/archive", True), socket, evidence], _resources("50m", "128Mi", "1", "512Mi")),
        # The live migrate Job gets exactly this environment: no server secrets.
        _container("migrate", inputs.new_image, ["node", "/programs/migrate.mjs"], [socket, evidence],
                   _resources("50m", "256Mi", "1", "768Mi"),
                   env=[{"name": "DATABASE_URL", "value": database_url},
                        {"name": "LW_MIGRATE_EXPECT", "value": inputs.expect},
                        {"name": "NODE_ENV", "value": "production"}]),
        _container("verify", inputs.postgres_image, ["bash", "/programs/verify.sh"],
                   [socket, _mount("evidence", "/evidence", True)], _resources("50m", "64Mi", "500m", "256Mi")),
    ]
    main = [_container("previous", inputs.previous_image, ["node", "/programs/previous-roundtrip.mjs"], [socket],
                       _resources("100m", "256Mi", "1", "1Gi"))]
    empty = lambda name, size: {"name": name, "emptyDir": {"sizeLimit": size}}  # noqa: E731
    volumes = [
        {"name": "programs", "configMap": {"name": inputs.name, "defaultMode": 0o444}},
        {"name": "backup", "secret": {"secretName": inputs.secret, "defaultMode": 0o440,
                                      "items": [{"key": key, "path": key} for key in SECRET_KEYS]}},
        empty("archive", "256Mi"), empty("pgdata", inputs.pgdata_size), empty("socket", "8Mi"), empty("evidence", "8Mi"),
        *[empty(f"tmp-{c['name']}", "64Mi") for c in init + main],
    ]
    spec = {
        "restartPolicy": "Never", "activeDeadlineSeconds": inputs.deadline_seconds, "terminationGracePeriodSeconds": 10,
        "automountServiceAccountToken": False, "enableServiceLinks": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000,
                            "seccompProfile": {"type": "RuntimeDefault"}},
        # No DNS at all: the backup store's name resolves from this fixed entry, and
        # the namespace's one egress rule allows HTTPS to it and nothing else.
        "dnsPolicy": "None", "dnsConfig": {"nameservers": ["127.0.0.1"]},
        "hostAliases": [{"ip": inputs.storage_address, "hostnames": [inputs.storage_host]}],
        "initContainers": init, "containers": main, "volumes": volumes,
    }
    if inputs.pull_secret:
        spec["imagePullSecrets"] = [{"name": inputs.pull_secret}]
    pod_meta = dict(meta, annotations={INPUTS_ANNOTATION: sha256_hex(compact(inputs.record()).encode())})
    pod = {"apiVersion": "v1", "kind": "Pod", "metadata": pod_meta, "spec": spec}
    return config_map, pod


# ---------------------------------------------------------------------------
# kubectl

class Kubectl:
    """A kubectl-like executable: k3s kubectl, kubectl, or a test fake."""

    def __init__(self, argv, timeout=60):
        require(isinstance(argv, list) and argv and all(isinstance(a, str) and a for a in argv) and argv[0].startswith("/"),
                "BAD_INPUT", "kubectl must be an argv list starting with an absolute path")
        self.argv = list(argv)
        self.timeout = timeout

    def call(self, args, body=None, timeout=None):
        try:
            return subprocess.run(self.argv + list(args), input=None if body is None else compact(body).encode(),
                                  capture_output=True, timeout=timeout or self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("KUBECTL", f"kubectl {' '.join(args[:2])} did not run") from exc

    def run(self, args, body=None, timeout=None):
        done = self.call(args, body, timeout)
        require(done.returncode == 0, "KUBECTL", f"kubectl {' '.join(args[:2])} exited {done.returncode}: "
                + done.stderr.decode("utf-8", "replace").strip()[-300:])
        return done.stdout

    def json(self, args, body=None):
        out = self.run(args, body)
        try:
            return json.loads(out)
        except ValueError as exc:
            raise Refusal("KUBECTL", f"kubectl {' '.join(args[:2])} did not return JSON") from exc


def includes(actual, expected):
    """Allow API defaults, but never extra list items or changed leaves."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and includes(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(includes(a, e) for a, e in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


# ---------------------------------------------------------------------------
# The run

def _last_step_json(text, step):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and value.get("step") == step:
                return value
    return None


def _statuses(pod):
    status = pod.get("status") or {}
    return {s["name"]: s for s in (status.get("initContainerStatuses") or []) + (status.get("containerStatuses") or [])}


def _terminated(state):
    return ((state or {}).get("state") or {}).get("terminated")


class Rehearsal:
    def __init__(self, kubectl, inputs, *, programs=None, sleep=time.sleep, monotonic=time.monotonic,
                 poll_seconds=5, start_timeout_seconds=300, now=None):
        self.kube = kubectl
        self.inputs = inputs
        self.programs = programs if programs is not None else read_programs()
        self.sleep, self.monotonic, self.poll = sleep, monotonic, poll_seconds
        self.start_timeout = start_timeout_seconds
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.created = {}
        self.result = dict(inputs.record(), result=None, code=None, reason=None, steps={}, files=[])

    # Preflight: read-only. Secrets are never read.
    def preflight(self):
        version = self.kube.json(["version", "-o", "json"]).get("serverVersion") or {}
        minor = re.match(r"\d+", str(version.get("minor", "")))
        require(str(version.get("major")) == "1" and minor and int(minor.group()) >= MIN_KUBERNETES_MINOR,
                "KUBERNETES_TOO_OLD", f"native sidecar containers need Kubernetes 1.{MIN_KUBERNETES_MINOR} or newer")
        ns = self.inputs.namespace
        namespace = self.kube.json(["get", "namespace", ns, "-o", "json"])
        ns_labels = namespace.get("metadata", {}).get("labels") or {}
        require(ns_labels.get("app.kubernetes.io/managed-by") == MANAGED_BY, "NAMESPACE_UNSAFE",
                f"namespace {ns} is not a rehearsal namespace (label app.kubernetes.io/managed-by={MANAGED_BY})")
        require(ns_labels.get("pod-security.kubernetes.io/enforce") == "restricted", "NAMESPACE_UNSAFE",
                f"namespace {ns} does not enforce the restricted Pod Security level")
        require((namespace.get("status") or {}).get("phase", "Active") == "Active", "NAMESPACE_UNSAFE", f"namespace {ns} is terminating")
        self._check_policies(self.kube.json(["get", "networkpolicies", "-n", ns, "-o", "json"]).get("items") or [])
        quotas = self.kube.json(["get", "resourcequotas", "-n", ns, "-o", "json"]).get("items") or []
        quota = next((q for q in quotas if q["metadata"]["name"] == QUOTA), None)
        require(quota is not None and (quota.get("spec", {}).get("hard") or {}).get("pods") == "1"
                and (quota.get("spec", {}).get("hard") or {}).get("persistentvolumeclaims") == "0",
                "POLICY_DRIFT", f"namespace {ns} lacks the {QUOTA} ResourceQuota (one Pod, no claims)")
        found = self.kube.json(["get", "pods,configmaps,persistentvolumeclaims", "-n", ns, "-o", "json"]).get("items") or []
        busy = [f"{i['kind']}/{i['metadata']['name']}" for i in found
                if not (i["kind"] == "ConfigMap" and i["metadata"]["name"] == "kube-root-ca.crt")]
        require(not busy, "REHEARSAL_BUSY", "the rehearsal namespace already holds " + ", ".join(sorted(busy)[:5])
                + "; run `restore-rehearsal.py cleanup` after checking no rehearsal is running")

    def _check_policies(self, items):
        by_name = {p["metadata"]["name"]: p.get("spec") or {} for p in items}
        require(set(by_name) == {DENY_POLICY, EGRESS_POLICY}, "POLICY_DRIFT",
                f"the rehearsal namespace must hold exactly the {DENY_POLICY} and {EGRESS_POLICY} NetworkPolicies")
        deny = by_name[DENY_POLICY]
        require(deny.get("podSelector") == {} and sorted(deny.get("policyTypes") or []) == ["Egress", "Ingress"]
                and not deny.get("ingress") and not deny.get("egress"), "POLICY_DRIFT", f"{DENY_POLICY} is not deny-all")
        egress = by_name[EGRESS_POLICY]
        require(egress.get("podSelector") == {"matchLabels": {"app.kubernetes.io/component": COMPONENT}}
                and sorted(egress.get("policyTypes") or []) == ["Egress", "Ingress"] and not egress.get("ingress"),
                "POLICY_DRIFT", f"{EGRESS_POLICY} must select rehearsal Pods and allow no ingress")
        rules = egress.get("egress") or []
        require(len(rules) == 1, "POLICY_DRIFT", f"{EGRESS_POLICY} must have exactly one egress rule")
        ports = rules[0].get("ports") or []
        require(len(ports) == 1 and ports[0].get("protocol", "TCP") == "TCP" and str(ports[0].get("port")) == "443"
                and "endPort" not in ports[0], "POLICY_DRIFT", f"{EGRESS_POLICY} may allow TCP 443 only")
        peers = rules[0].get("to") or []
        require(peers and all(set(p) == {"ipBlock"} for p in peers), "POLICY_DRIFT", f"{EGRESS_POLICY} may name IP blocks only")
        address = ipaddress.ip_address(self.inputs.storage_address)
        inside = False
        for peer in peers:
            block = peer["ipBlock"]
            network = ipaddress.ip_network(block["cidr"], strict=False)
            require(network.prefixlen > 0, "POLICY_DRIFT", f"{EGRESS_POLICY} allows every address")
            if address.version == network.version and address in network and not any(
                    address.version == ipaddress.ip_network(e, strict=False).version and address in ipaddress.ip_network(e, strict=False)
                    for e in block.get("except") or []):
                inside = True
        require(inside, "STORAGE_OUTSIDE_POLICY", f"{self.inputs.storage_address} is not inside {EGRESS_POLICY}'s egress rule")

    # Create: server dry run, then the object; its UID is recorded before anything else.
    def _create(self, obj):
        dry = self.kube.json(["create", "--dry-run=server", "-f", "-", "-o", "json"], obj)
        require(includes(dry, obj), "ADMISSION_CHANGED", f"admission changed the {obj['kind']} the rehearsal asked for")
        created = self.kube.json(["create", "-f", "-", "-o", "json"], obj)
        self.created[obj["kind"]] = {"name": created["metadata"]["name"], "uid": created["metadata"]["uid"]}
        require(includes(created, obj), "ADMISSION_CHANGED", f"the created {obj['kind']} differs from the request")
        return created

    def _get_pod(self):
        return self.kube.json(["get", "pod", self.inputs.name, "-n", self.inputs.namespace, "-o", "json"])

    def wait(self):
        started_at = self.monotonic()
        deadline = started_at + self.inputs.deadline_seconds + 120
        while True:
            pod = self._get_pod()
            phase = (pod.get("status") or {}).get("phase")
            if phase in ("Succeeded", "Failed"):
                return pod
            states = _statuses(pod).values()
            began = any(((s.get("state") or {}).get("running") or (s.get("state") or {}).get("terminated")) for s in states)
            if not began and self.monotonic() - started_at > self.start_timeout:
                waiting = sorted({((s.get("state") or {}).get("waiting") or {}).get("reason", "") for s in states} - {""})
                raise Refusal("POD_NOT_STARTED", "the rehearsal Pod did not start"
                              + (f" ({', '.join(waiting)})" if waiting else "; check the backup credential Secret and the images"))
            if self.monotonic() > deadline:
                raise Refusal("TIMEOUT", "the rehearsal Pod did not finish in time")
            self.sleep(self.poll)

    def _logs(self, container):
        done = self.kube.call(["logs", self.inputs.name, "-n", self.inputs.namespace, "-c", container, "--tail=200"])
        return done.stdout.decode("utf-8", "replace") if done.returncode == 0 else ""

    def evaluate(self, pod):
        """Read every step's own report and check it again here."""
        statuses = _statuses(pod)
        steps = self.result["steps"]
        for step in STEPS:
            if step in statuses and _terminated(statuses[step]):
                steps[step] = _last_step_json(self._logs(step), step) or {"status": "NO_REPORT"}
        reason = (pod.get("status") or {}).get("reason")
        failed = next((s for s in STEPS if not (_terminated(statuses.get(s)) or {}).get("exitCode") == 0), None)
        if failed is not None:
            report = steps.get(failed) or {}
            detail = report.get("reason") or report.get("status") or "did not run"
            if reason == "DeadlineExceeded":
                raise Refusal("TIMEOUT", f"the rehearsal ran past its deadline during {failed}")
            if failed == "migrate":
                if TIMEOUT_LOG_LINE in self._logs("postgres"):
                    raise Refusal("LOCK_BUDGET_EXCEEDED", f"a migration file ran past the {self.inputs.lock_budget_seconds} s lock budget")
                code = str(detail).split(":")[0]
                raise Refusal(code if code in ("MIGRATE_REFUSED", "MIGRATE_EXPECT_UNSUPPORTED", "IMAGE_FILE_MISMATCH")
                              else "MIGRATE_FAILED", str(detail))
            if failed == "verify" and report.get("status") in ("RECORD_MISMATCH", "LOCK_BUDGET_EXCEEDED"):
                raise Refusal(report["status"], self._verify_detail(report))
            code = {"fetch": "ARCHIVE_UNVERIFIED", "restore": "RESTORE_FAILED", "verify": "VERIFY_FAILED",
                    "previous": "PREVIOUS_IMAGE_FAILED"}[failed]
            raise Refusal(code, f"{failed}: {detail}")
        require((pod.get("status") or {}).get("phase") == "Succeeded", "POD_FAILED", "the rehearsal Pod did not succeed")
        self._check_images(statuses)
        self._check_reports(steps)

    def _verify_detail(self, report):
        over = [f"{f['name']} {f['seconds']} s" for f in report.get("files") or []
                if float(f.get("seconds", 0)) > self.inputs.lock_budget_seconds]
        if report.get("status") == "LOCK_BUDGET_EXCEEDED":
            return f"over the {self.inputs.lock_budget_seconds} s lock budget: " + ", ".join(over)
        return f"schema_migrations differs: missing {report.get('missing')}, unexpected {report.get('unexpected')}"

    def _check_images(self, statuses):
        want = {"fetch": self.inputs.previous_image, "postgres": self.inputs.postgres_image, "restore": self.inputs.postgres_image,
                "migrate": self.inputs.new_image, "verify": self.inputs.postgres_image, "previous": self.inputs.previous_image}
        for name, image in want.items():
            status = statuses.get(name) or {}
            require(str(status.get("imageID", "")).endswith(image.split("@", 1)[1]), "EVIDENCE_MISMATCH",
                    f"{name} ran an image other than {image}")
            require(status.get("restartCount", 0) == 0, "EVIDENCE_MISMATCH", f"{name} restarted during the rehearsal")

    def _check_reports(self, steps):
        i, backup = self.inputs, self.inputs.backup
        fetch = steps.get("fetch") or {}
        require(fetch.get("status") == "RECOVERED" and fetch.get("sha256") == backup["sha256"]
                and fetch.get("size") == backup["size"] and fetch.get("keyId") == backup["keyId"],
                "EVIDENCE_MISMATCH", "the fetch step did not recover the named backup")
        restore = steps.get("restore") or {}
        before = restore.get("appliedBefore")
        require(restore.get("status") == "RESTORED" and restore.get("archiveSha256") == backup["sha256"]
                and str(restore.get("serverVersion", "")).startswith(str(POSTGRES_MAJOR)) and restore.get("listenAddresses") == ""
                and isinstance(before, list), "EVIDENCE_MISMATCH", "the restore step's report is incomplete")
        names = [f["name"] for f in i.pending]
        require(not set(names) & set(before), "EVIDENCE_MISMATCH", "the backup already records a pending file")
        migrate = steps.get("migrate") or {}
        require(migrate.get("status") == "APPLIED" and sorted(migrate.get("applied") or []) == names,
                "EVIDENCE_MISMATCH", "the runner applied a different set of files")
        verify = steps.get("verify") or {}
        files = verify.get("files") or []
        require(verify.get("status") == "RECORD_OK" and not verify.get("missing") and not verify.get("unexpected")
                and verify.get("appliedAfterCount") == len(before) + len(names)
                and sorted(f["name"] for f in files) == names, "RECORD_MISMATCH",
                "schema_migrations is not the restored set plus the pending files")
        require(all(isinstance(f.get("seconds"), (int, float)) and f["seconds"] >= 0 for f in files), "EVIDENCE_MISMATCH",
                "a migration file's time is missing or negative")
        over = [f for f in files if float(f["seconds"]) > i.lock_budget_seconds]
        require(not over, "LOCK_BUDGET_EXCEEDED", self._verify_detail({"status": "LOCK_BUDGET_EXCEEDED", "files": files}))
        self.result["files"] = files
        previous = steps.get("previous") or {}
        require(previous.get("status") == "ROUND_TRIP_OK", "PREVIOUS_IMAGE_FAILED", "the previous image's round trip did not pass")

    # Teardown: by UID, Pod first, and wait until each object is gone.
    def teardown(self):
        report = {}
        for kind, plural in (("Pod", "pods"), ("ConfigMap", "configmaps")):
            created = self.created.get(kind)
            if not created:
                continue
            report[kind] = _delete(self.kube, self.inputs.namespace, kind, plural, created["name"], created["uid"],
                                   self.sleep, self.monotonic)
        return report

    def run(self):
        self.result["startedAt"] = utc_stamp(self.now())
        try:
            self.preflight()
            config_map, pod = run_manifests(self.inputs, self.programs)
            self.result["configMapDataSha256"] = sha256_hex(compact(config_map["data"]).encode())
            self._create(config_map)
            self._create(pod)
            self.evaluate(self.wait())
            self.result.update(result="PASSED", code=None, reason=None)
        except Refusal as refusal:
            stage = "FAILED" if self.created.get("Pod") else "REFUSED"
            self.result.update(result=stage, code=refusal.code, reason=refusal.message)
        except Exception as error:  # noqa: BLE001 - an unexpected answer still ends in a result and a teardown
            stage = "FAILED" if self.created.get("Pod") else "REFUSED"
            self.result.update(result=stage, code="INTERNAL_ERROR", reason=f"{type(error).__name__}: {error}"[:300])
        finally:
            try:
                self.result["teardown"] = self.teardown()
            except Exception as error:  # noqa: BLE001
                self.result["teardown"] = {"error": f"{type(error).__name__}: {error}"[:300]}
            self.result["created"] = self.created
            self.result["teardownComplete"] = all(value == "deleted" for value in self.result["teardown"].values())
            self.result["finishedAt"] = utc_stamp(self.now())
        return self.result


def _delete(kube, namespace, kind, plural, name, uid, sleep, monotonic, timeout=90):
    body = {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": uid}, "gracePeriodSeconds": 5,
            "propagationPolicy": "Background"}
    done = kube.call(["delete", "--raw", f"/api/v1/namespaces/{namespace}/{plural}/{name}", "-f", "-"], body)
    if done.returncode != 0 and b"NotFound" not in done.stderr and b"not found" not in done.stderr:
        return "delete failed: " + done.stderr.decode("utf-8", "replace").strip()[-200:]
    started = monotonic()
    while monotonic() - started < timeout:
        out = kube.run(["get", kind.lower(), name, "-n", namespace, "--ignore-not-found", "-o", "json"])
        if not out.strip():
            return "deleted"
        current = json.loads(out)
        if current["metadata"]["uid"] != uid:
            return "deleted"  # a different object with the same name is not ours
        sleep(2)
    return "still present"


def cleanup(kubectl, namespace=NAMESPACE, sleep=time.sleep, monotonic=time.monotonic):
    """Delete what a crashed run left: only Pods and ConfigMaps this tool labelled,
    by UID, and never while a rehearsal Pod is still running."""
    require(DNS_LABEL.match(namespace) and namespace not in FORBIDDEN_NAMESPACES, "BAD_INPUT", "namespace")
    found = kubectl.json(["get", "pods,configmaps", "-n", namespace, "-l",
                          f"app.kubernetes.io/managed-by={MANAGED_BY},app.kubernetes.io/component={COMPONENT}", "-o", "json"])
    items = found.get("items") or []
    running = [i["metadata"]["name"] for i in items if i["kind"] == "Pod"
               and (i.get("status") or {}).get("phase") in ("Pending", "Running")]
    require(not running, "REHEARSAL_RUNNING", "a rehearsal Pod is still running: " + ", ".join(running))
    removed = {}
    for item in sorted(items, key=lambda i: i["kind"] != "Pod"):
        kind = item["kind"]
        plural = {"Pod": "pods", "ConfigMap": "configmaps"}[kind]
        removed[f"{kind}/{item['metadata']['name']}"] = _delete(kubectl, namespace, kind, plural, item["metadata"]["name"],
                                                                 item["metadata"]["uid"], sleep, monotonic)
    return removed
