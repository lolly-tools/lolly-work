#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Publish a reviewed private shell claim without rebuilding its Work image.

The offline shell planner and original isolated qualification remain mandatory.
This operator separately performs a server dry run, one guarded patch, and a
read-only owning-runtime observation. Failed/ambiguous phases cannot be replayed.
It does not create infrastructure, sign assets, or authenticate evidence origins.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import ssl
import urllib.request
import urllib.error
from urllib.parse import urljoin, urlsplit

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


class Refusal(RuntimeError):
    """The reviewed update boundary is not satisfied."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys), "Missing or unknown publication fields")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


updater = load_module("shell_publication_updater", HERE / "app-update.py")
storage = load_module("shell_publication_storage", HERE / "plan-private-cohort.py")


def held(ref, base):
    exact(ref, {"path", "sha256"})
    require(isinstance(ref["path"], str) and ref["path"] and "\0" not in ref["path"] and
            isinstance(ref["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", ref["sha256"]), "Invalid custody reference")
    path = Path(os.path.abspath(base / ref["path"]))
    require(path.resolve(strict=True) == path, "Custody reference uses a symlink")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o022 and before.st_size <= 32 * 1024**2,
            "Custody input is not a protected bounded file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(stamp(os.fstat(fd)) == stamp(before), "Custody input changed before read")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(32 * 1024**2 + 1)
        require(len(data) == before.st_size and stamp(os.fstat(fd)) == stamp(before) == stamp(path.lstat()) and
                hashlib.sha256(data).hexdigest() == ref["sha256"], "Custody bytes changed")
        return data
    finally:
        os.close(fd)


def read(ref, base):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(held(ref, base), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite JSON number")))


def leaves(before, after, path=""):
    if type(before) is not type(after):
        return {path}
    if isinstance(before, dict):
        return {p for key in set(before) | set(after) for p in
                (leaves(before[key], after[key], path + "/" + key.replace("~", "~0").replace("/", "~1"))
                 if key in before and key in after else {path + "/" + key})}
    if isinstance(before, list):
        return {path} if len(before) != len(after) else {p for i, (a, b) in enumerate(zip(before, after)) for p in leaves(a, b, path + "/" + str(i))}
    return set() if before == after else {path}


def selected(items, name):
    found = [value for value in items if value.get("name") == name]
    require(len(found) == 1, "Named runtime field is absent or ambiguous")
    return found[0]


def review(plan, before):
    require(type(plan.get("version")) is int and plan["version"] == 1 and
            plan.get("status") == "PLANNED_FROM_CAPTURES_NOT_DRY_RUN_NOT_APPLIED" and
            plan.get("allUnselectedSpecFieldsPreserved") is True, "Maintained shell plan required")
    require(before.get("kind") == "Deployment" and before.get("apiVersion") == "apps/v1" and
            all(before["metadata"].get(k) == plan[p] for k, p in
                (("namespace", "namespace"), ("name", "deployment"), ("uid", "deploymentUID"))) and
            digest(before["spec"]) == plan["beforeSpecSha256"] and digest(plan["desiredSpec"]) == plan["desiredSpecSha256"],
            "Exact original and desired specification required")
    selection = plan["selection"]
    volumes = before["spec"]["template"]["spec"]["volumes"]
    indexes = [i for i, value in enumerate(volumes) if value.get("name") == selection["shellVolume"]]
    require(len(indexes) == 1, "Unique shell volume required")
    allowed = {f"/template/spec/volumes/{indexes[0]}/persistentVolumeClaim/claimName",
               "/template/metadata/annotations/lolly.tools~1shell-source"}
    annotations = before["spec"]["template"].get("metadata", {}).get("annotations", {})
    if "lolly.tools/shell-release" in annotations:
        allowed.add("/template/metadata/annotations/lolly.tools~1shell-release")
    require(leaves(before["spec"], plan["desiredSpec"]) == allowed, "Only shell claim and existing shell provenance may change")
    require(annotations.get("lolly.tools/engine-source") == plan["sources"]["engine"] and
            plan["desiredSpec"]["template"]["metadata"]["annotations"].get("lolly.tools/shell-source") == plan["sources"]["lolly"],
            "Separate accepted engine and new shell provenance required")
    server = selected(before["spec"]["template"]["spec"]["containers"], selection["container"])
    require(server["image"] == plan["image"], "Accepted Work image must remain unchanged")
    updater.image_ref(server["image"])
    return indexes[0]


def fresh_patch(plan, current):
    require(current["metadata"]["uid"] == plan["deploymentUID"] and
            digest(current["spec"]) == plan["beforeSpecSha256"] and not current["metadata"].get("deletionTimestamp"),
            "Fresh Deployment UID/full specification differs")
    patch = copy.deepcopy(plan["guardedPatch"])
    for operation in patch:
        if operation["op"] == "test" and operation["path"] == "/metadata/resourceVersion":
            operation["value"] = current["metadata"]["resourceVersion"]
    tests = [{"op": "test", "path": "/metadata/uid", "value": plan["deploymentUID"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
             {"op": "test", "path": "/spec", "value": current["spec"]}]
    require(all(value in patch for value in tests), "Atomic UID/resourceVersion/full-spec tests required")
    require(all(op.get("op") in {"test", "replace"} for op in patch), "Unsupported publication patch operation")
    return patch


def resource_guard(value):
    metadata = value["metadata"]
    require(not metadata.get("deletionTimestamp"), "Captured content resource is deleting")
    result = {"kind": value["kind"], "namespace": metadata.get("namespace"), "name": metadata["name"],
              "uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]}
    if "spec" in value:
        result["specSha256"] = digest(value["spec"])
    if value["kind"] == "ConfigMap":
        result["dataSha256"] = digest(value.get("data", {}))
        result["immutable"] = value.get("immutable") is True
    return result


class DeploymentInventory:
    """Original collection items scoped to a single fresh guard pass."""
    def __init__(self, namespaces, deployments):
        self.namespaces = namespaces
        self.deployments = deployments

    def get(self, kind, name, namespace=None):
        if kind == "namespace" and namespace is None:
            require(name in self.namespaces, "Protected namespace missing from fresh captures")
            return self.namespaces[name]
        require(kind == "deployment" and (namespace, name) in self.deployments,
                "Protected Deployment missing from fresh captures")
        return self.deployments[(namespace, name)]


OWNER_READBACK = r"""const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [shell,pack,pin,publicJwk]=process.argv.slice(1);const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function tree(root){const files=[];let totalBytes=0;function walk(dir,prefix){
 for(const name of fs.readdirSync(dir).sort()){if(name==='.'||name==='..'||/[\\\x00-\x1f\x7f]/.test(name))throw Error('path');
 const p=path.join(dir,name),relative=prefix+name,s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('symlink');
 if(s.isDirectory())walk(p,relative+'/');else{if(!s.isFile()||files.length>=100000)throw Error('file');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hasher=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024);let bytes=0;
 try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null))>0){hasher.update(buf.subarray(0,n));bytes+=n;}
 const end=fs.fstatSync(fd);if(bytes!==s.size||end.ino!==s.ino||end.size!==s.size||end.mtimeMs!==s.mtimeMs)throw Error('changed');}finally{fs.closeSync(fd);}
 totalBytes+=s.size;files.push({path:relative,size:s.size,sha256:hasher.digest('hex')});}}}walk(root,'');files.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 return {version:1,files,totalBytes};}
const result={version:1,shell:tree(shell),pack:tree(pack),pinSha256:hash(fs.readFileSync(pin))};
if(publicJwk){const jwk=JSON.parse(publicJwk),stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':
 v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const index=fs.readFileSync(path.join(shell,'catalog/tools/index.json')),envelopeBytes=fs.readFileSync(path.join(shell,'catalog/tools/index.sig.json')),
 envelope=JSON.parse(envelopeBytes),unsigned={...envelope};delete unsigned.signature;
const pinHash=hash(Buffer.from(stable(jwk))),keyId=Buffer.from(pinHash,'hex').toString('base64url');
if(envelope.alg!=='ECDSA-P256-SHA256'||envelope.keyId!==keyId||envelope.indexHash!==hash(index)||
 !crypto.verify('sha256',Buffer.from(stable(unsigned)),{key:crypto.createPublicKey({key:jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},
 Buffer.from(envelope.signature,'base64url')))throw Error('signature');
const shellMap=new Map(result.shell.files.map(f=>[f.path,f])),packMap=new Map(result.pack.files.map(f=>[f.path,f]));
for(const [p,sha]of Object.entries(envelope.files)){if(!/^[\x20-\x7e]+$/.test(p)||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('signed path');
 if(shellMap.get('tools/'+p)?.sha256!==sha||packMap.get('tools/'+p)?.sha256!==sha)throw Error('closure');}
result.catalog={indexSha256:hash(index),envelopeSha256:hash(envelopeBytes),keyId,signedFiles:Object.keys(envelope.files).length,
 publicPinSha256:pinHash,signatureVerified:true};}
console.log(JSON.stringify(result));"""


def static_fetch(url, maximum):
    """Normal certificate/hostname verification; no cookies or redirects."""
    opener = urllib.request.build_opener(updater.NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(url, timeout=30) as response:
        require(response.status == 200, "Static HTTPS route did not return 200")
        data = response.read(maximum + 1)
        require(len(data) <= maximum, "Static HTTPS body exceeds reviewed bound")
        return data


AUTHENTICATED_CATALOG_PROFILE = "NORMAL_TLS_PER_CALLER_INDEX_ORACLE_AND_PINNED_P256_ENVELOPE"


def anonymous_catalog_gate(url):
    """Require the real sign-in gate with normal TLS and no redirects/cookies."""
    opener = urllib.request.build_opener(updater.NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(url, timeout=30):
            raise Refusal("Anonymous private catalogue unexpectedly returned success")
    except urllib.error.HTTPError as response:
        try:
            require(response.code == 401, "Private catalogue needs its literal 401 sign-in gate")
            body = response.read(4097)
            require(len(body) <= 4096 and json.loads(body) == {"error": {"code": "UNAUTHORIZED", "message": "this deployment is sign-in gated"}},
                    "Private catalogue returned a different sign-in gate")
            return {"url": url, "status": 401, "errorCode": "UNAUTHORIZED", "message": "this deployment is sign-in gated",
                    "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), "verifiedTlsAndHostname": True, "authentication": "none"}
        finally:
            response.close()


def authenticated_catalog_report(value, context, probe, catalog, public_pin, now=None):
    """Validate a separately reviewed probe's bounded, non-secret TLS receipt.

    The caller reviews its code and credential custody. This report binds that
    code/input and the actual owner context; it is not origin authentication.
    Dynamic signed envelopes never claim equality to the prepared envelope.
    """
    exact(value, {"version", "status", "contextSha256", "inputSha256", "sourceSha256", "profile", "probes", "oracle", "tls", "scope"})
    require(type(value["version"]) is int and value["version"] == 1 and value["status"] == "AUTHENTICATED_PRIVATE_SHELL_CATALOG_PROBE_ACCEPTED" and
            value["contextSha256"] == digest(context) and value["inputSha256"] == probe["input"]["sha256"] and
            value["sourceSha256"] == probe["source"]["sha256"] and value["profile"] == AUTHENTICATED_CATALOG_PROFILE,
            "Authenticated catalogue probe belongs to another source/input/owner")
    require(value["tls"] == {"certificateRequired": True, "hostnameVerified": True, "redirectsFollowed": False} and
            value["tls"]["certificateRequired"] is True and value["tls"]["hostnameVerified"] is True and value["tls"]["redirectsFollowed"] is False and
            value["scope"] == {"databaseDirectWrites": False, "documentWrites": False, "invitationWrites": False,
                               "cookiePrinted": False, "cookiePersisted": False, "maximumSessionSeconds": 300} and
            all(value["scope"][key] is False for key in ("databaseDirectWrites", "documentWrites", "invitationWrites", "cookiePrinted", "cookiePersisted")) and
            type(value["scope"]["maximumSessionSeconds"]) is int,
            "Authenticated catalogue probe scope or TLS differs")
    oracle = value["oracle"]
    exact(oracle, {"indexSha256", "indexBytes", "expectedIndexSha256", "envelopeSha256", "envelopeBytes", "expectedFileMapSha256",
                   "signedFiles", "publicPinSha256", "keyId", "signedAt", "signatureVerified", "exactPerCallerIndexBytes", "exactVisibleFileMap", "sourceBindingSha256"})
    for field in ("indexSha256", "expectedIndexSha256", "envelopeSha256", "expectedFileMapSha256", "sourceBindingSha256"):
        require(type(oracle[field]) is str and re.fullmatch(r"[a-f0-9]{64}", oracle[field]), "Invalid authenticated oracle digest")
    require(oracle["indexSha256"] == oracle["expectedIndexSha256"] and oracle["publicPinSha256"] == digest(public_pin) and oracle["keyId"] == catalog["keyId"] and
            all(oracle[key] is True for key in ("signatureVerified", "exactPerCallerIndexBytes", "exactVisibleFileMap")), "Caller oracle/signature/pin is not qualified")
    for key in ("indexBytes", "envelopeBytes", "signedFiles"):
        require(type(oracle[key]) is int and 0 < oracle[key] <= 2 * 1024**2, "Invalid bounded authenticated response")
    require(oracle["signedFiles"] <= catalog["signedFiles"], "Authenticated catalogue exposes an unqualified file set")
    try:
        signed_at = datetime.fromisoformat(oracle["signedAt"].replace("Z", "+00:00"))
        state = selected(context["owner"]["pod"]["status"]["containerStatuses"], context["selection"]["container"])["state"]
        started_at = datetime.fromisoformat(state["running"]["startedAt"].replace("Z", "+00:00"))
        current = now or datetime.now(timezone.utc)
        require(signed_at.tzinfo is not None and started_at.tzinfo is not None and started_at <= current and
                started_at.timestamp() - 60 <= signed_at.timestamp() <= current.timestamp() + 60, "Signature time is outside the owning process lifetime")
    except (KeyError, ValueError, TypeError, AttributeError) as error:
        raise Refusal("Missing bounded authenticated signature time") from error
    require(type(value["probes"]) is list and len(value["probes"]) == 2, "Two authenticated catalogue routes required")
    for actual, path, prefix in zip(value["probes"], ("catalog/tools/index.json", "catalog/tools/index.sig.json"), ("index", "envelope")):
        exact(actual, {"path", "url", "status", "verifiedTlsAndHostname", "authentication", "bytes", "sha256", "oracle"})
        require(type(actual["status"]) is int and type(actual["bytes"]) is int and actual["verifiedTlsAndHostname"] is True and
                actual == {"path": path, "url": urljoin(context["baseURL"], path), "status": 200, "verifiedTlsAndHostname": True,
                           "authentication": "TEMPORARY_MEMORY_SESSION", "bytes": oracle[prefix + "Bytes"], "sha256": oracle[prefix + "Sha256"],
                           "oracle": AUTHENTICATED_CATALOG_PROFILE}, "Authenticated HTTPS route/hash/oracle differs")
    return value


class Publication:
    """The caller reviews input/command origins; every phase keeps original bytes."""
    def __init__(self, path, checksum, operator_checksum, out, kube=None, command_runner=None, health=None, static_fetcher=None):
        require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == operator_checksum, "Reviewed operator source changed")
        self.path = Path(os.path.abspath(path)); self.base = self.path.parent
        self.input_ref = {"path": str(self.path), "sha256": checksum}
        self.x = read(self.input_ref, self.base)
        fields = {"version", "status", "refs", "sourceFiles", "preflight", "retiredMountProbe"}
        require(type(self.x) is dict and fields <= set(self.x) <= fields | {"authenticatedStaticProbe", "globalPVInventoryGuarded"}, "Unknown publication input fields")
        require("globalPVInventoryGuarded" not in self.x or self.x["globalPVInventoryGuarded"] is True,
                "Global PV inventory guarding must be explicitly true")
        require(type(self.x["version"]) is int and self.x["version"] == 1 and
                self.x["status"] == "REVIEWED_PRIVATE_SHELL_PUBLICATION_INPUT", "Reviewed publication input required")
        exact(self.x["refs"], {"plan", "planningEvidence", "target", "baseline", "shellManifest", "packManifest", "enginePin"})
        # Emitted next-release custody must not depend on this invocation's cwd
        # or on the directory of a later preparation envelope.
        self.refs = {key: {**ref, "path": str(Path(os.path.abspath(self.base / ref["path"])))} for key, ref in self.x["refs"].items()}
        self.plan, self.target, self.baseline = [read(self.refs[key], self.base) for key in ("plan", "target", "baseline")]
        updater.validate_target(self.target)
        require("work" in self.target["components"], "Target needs the owned Work application")
        self.component = self.target["components"]["work"]
        require(all(self.component[key] == self.plan[key] for key in ("namespace", "namespaceUID", "deployment", "deploymentUID")),
                "Plan belongs to another target component")
        exact(self.baseline, {"version", "deployments", "owner", "replicaSet"})
        require(type(self.baseline["version"]) is int and self.baseline["version"] == 1 and
                set(self.baseline["deployments"]) == set(self.target["components"]), "Complete protected deployment baseline required")
        for role, component in self.target["components"].items():
            value = self.baseline["deployments"][role]
            require(value["kind"] == "Deployment" and all(value["metadata"].get(key) == component[field] for key, field in
                    (("namespace", "namespace"), ("name", "deployment"), ("uid", "deploymentUID"))), "Captured protected deployment identity differs")
        self.before = self.baseline["deployments"]["work"]
        self.volume_index = review(self.plan, self.before)
        self.operator_checksum = operator_checksum
        self.out = Path(os.path.abspath(out))
        require(self.out.resolve(strict=True) == self.out and self.out.is_dir() and not self.out.stat().st_mode & 0o077,
                "Output must be an existing private canonical directory")
        self.command_runner = command_runner or subprocess.run
        self.health = health or updater.health_check
        self.static_fetcher = static_fetcher or static_fetch
        self.kube = kube or updater.Kubectl(self.target["transport"])
        self.source_check()
        planner = load_module("private_shell_publication_plan", HERE / "plan-private-shell.py")
        evidence_ref = self.refs["planningEvidence"]
        evidence_base = Path(os.path.abspath(self.base / evidence_ref["path"])).parent
        self.evidence = read(evidence_ref, self.base)
        expected, inputs = planner.plan(self.evidence, evidence_base)
        expected["evidence"].append({"path": str(Path(os.path.abspath(self.base / evidence_ref["path"]))), "sha256": evidence_ref["sha256"]})
        expected["evidence"].sort(key=lambda ref: ref["path"])
        require(expected == self.plan, "Stored plan differs from recomputed original evidence")
        inputs.unchanged()
        self.custody_inputs = inputs
        self.stage = read(self.evidence["stage"], evidence_base)
        self.writer = read(self.stage["originalEvidence"][1], evidence_base)["pod"]
        self.shell = read(self.refs["shellManifest"], self.base)
        self.pack = read(self.refs["packManifest"], self.base)
        require(self.refs["shellManifest"]["sha256"] == self.stage["shell"]["manifestSha256"] and
                self.refs["packManifest"]["sha256"] == self.stage["rawPack"]["manifestSha256"] and
                self.refs["enginePin"]["sha256"] == self.stage["enginePinSha256"], "Owner readback inputs differ from isolated qualification")
        for value in (self.shell, self.pack):
            exact(value, {"version", "files", "totalBytes"})
            require(type(value["version"]) is int and value["version"] == 1 and isinstance(value["files"], list) and value["files"],
                    "Full owner content manifest required")
        self.engine_pin = read(self.refs["enginePin"], self.base)
        self.mounts = self.evidence["mounts"]
        prepared = read(self.evidence["prepared"], evidence_base)
        self.prepared = prepared
        original_ref = next(ref for ref in prepared["evidence"] if ref["sha256"] == prepared["reviewedEvidenceSha256"])
        original_base = Path(os.path.abspath(evidence_base / original_ref["path"])).parent
        original = read(original_ref, evidence_base)
        self.public_pin_ref = {"path": str(Path(os.path.abspath(original_base / original["publicPin"]["path"]))), "sha256": original["publicPin"]["sha256"]}
        self.public_pin = read(self.public_pin_ref, self.base)
        self.resolver_ref = {"path": str(Path(os.path.abspath(original_base / original["resolverPin"]["path"]))), "sha256": original["resolverPin"]["sha256"]}
        held(self.resolver_ref, self.base)
        self.previous_ref = {"path": str(Path(os.path.abspath(evidence_base / self.evidence["previous"]["path"]))), "sha256": self.evidence["previous"]["sha256"]}
        self.previous = read(self.previous_ref, self.base)
        captured = read(self.evidence["resources"], evidence_base)["pods"]["items"]
        owner = self.baseline["owner"]
        owners = [pod for pod in captured if pod["metadata"].get("uid") == owner["metadata"].get("uid")]
        require(len(owners) == 1 and owners[0]["spec"] == owner["spec"] and
                all(owners[0]["metadata"].get(key) == owner["metadata"].get(key) for key in ("namespace", "name", "uid")) and
                selected(owner["spec"]["containers"], self.plan["selection"]["container"])["image"] == self.plan["image"],
                "Publication baseline owner differs from the original complete planner capture")
        self.chain(self.baseline["owner"], self.baseline["replicaSet"], self.before)

    def source_check(self):
        held(self.input_ref, self.base)
        for ref in self.refs.values():
            held(ref, self.base)
        for ref in self.plan.get("evidence", []):
            held(ref, self.base)
        if hasattr(self, "custody_inputs"):
            self.custody_inputs.unchanged()
        require(isinstance(self.x["sourceFiles"], list), "Reviewed source closure required")
        paths = []
        for ref in self.x["sourceFiles"]:
            held(ref, self.base); paths.append(Path(os.path.abspath(self.base / ref["path"])))
        require(len(paths) == len(set(paths)) and set(paths) >= {Path(__file__).resolve(), HERE / "app-update.py",
                HERE / "plan-private-shell.py", HERE / "prepare-private-shell.py", HERE / "prepare-private-cohort.py",
                HERE / "prepare-paired-release.py", HERE / "plan-private-cohort.py"}, "Complete maintained operator dependency closure required")
        for key in ("preflight", "retiredMountProbe"):
            command = self.x[key]; exact(command, {"argv", "source"}); held(command["source"], self.base)
            argv = command["argv"]
            source_path = str(Path(os.path.abspath(self.base / command["source"]["path"])))
            require(isinstance(argv, list) and argv and all(isinstance(a, str) and a and "\0" not in a for a in argv) and
                    Path(argv[0]).is_absolute() and re.fullmatch(r"python3(?:\.[0-9]+)?", Path(argv[0]).name) and
                    (argv[1:2] == [source_path] or argv[1:3] == ["-B", source_path]) and argv.count(source_path) == 1,
                    "Explicit Python invocation of the reviewed guard script required")
        if "authenticatedStaticProbe" in self.x:
            command = self.x["authenticatedStaticProbe"]
            exact(command, {"argv", "source", "input", "profile"})
            require(command["profile"] == AUTHENTICATED_CATALOG_PROFILE, "Unknown authenticated catalogue profile")
            for ref in (command["source"], command["input"]):
                held(ref, self.base)
                require(ref in self.x["sourceFiles"], "Authenticated probe source and input need complete registered custody")
            source_path = str(Path(os.path.abspath(self.base / command["source"]["path"])))
            input_path = str(Path(os.path.abspath(self.base / command["input"]["path"])))
            argv = command["argv"]
            require(isinstance(argv, list) and argv and all(isinstance(a, str) and a and "\0" not in a for a in argv) and
                    Path(argv[0]).is_absolute() and re.fullmatch(r"python3(?:\.[0-9]+)?", Path(argv[0]).name) and
                    argv[1:] in ([source_path, "--input", input_path, "--input-sha256", command["input"]["sha256"]],
                                 ["-B", source_path, "--input", input_path, "--input-sha256", command["input"]["sha256"]]),
                    "Explicit authenticated probe invocation and hash-bound input required")

    def save(self, name, value):
        require(Path(name).name == name, "Owned output name required")
        data = canonical(value) + b"\n"
        fd = os.open(self.out / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        return {"path": str(self.out / name), "sha256": hashlib.sha256(data).hexdigest()}

    def save_raw(self, name, data):
        require(Path(name).name == name and isinstance(data, bytes) and len(data) <= 32 * 1024**2,
                "Bounded original collection bytes required")
        fd = os.open(self.out / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        return {"path": str(self.out / name), "sha256": hashlib.sha256(data).hexdigest()}

    def header(self, status):
        return {"version": 1, "status": status, "inputSha256": self.input_ref["sha256"],
                "operatorSha256": self.operator_checksum, "planSha256": self.refs["plan"]["sha256"],
                "sources": self.plan["sources"], "image": self.plan["image"], "runtimeAcceptanceComplete": False,
                "evidenceOriginAuthenticatedByThisCommand": False}

    def begin(self, phase):
        self.source_check()
        self.save(phase + ".started.json", {**self.header("STARTED_NO_REPLAY"), "phase": phase})

    def prior(self, phase, status):
        path = self.out / (phase + ".actual.json")
        require(path.is_file(), "Successful prior phase required")
        value = read({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}, self.base)
        require(value.get("status") == status and all(value.get(k) == self.header(status)[k] for k in
                ("version", "inputSha256", "operatorSha256", "planSha256", "sources", "image")), "Prior phase has different input/source/plan")
        return value

    def command(self, key, phase):
        command = self.x[key]
        held(command["source"], self.base)
        try:
            result = self.command_runner(command["argv"], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                         timeout=180, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal("Reviewed guard command failed or timed out") from exc
        ref = self.save(phase + "." + key + ".original.json", {"returncode": result.returncode,
                            "stdout": result.stdout, "stderr": result.stderr})
        require(result.returncode == 0, "Reviewed preflight or retired mount probe failed")
        return result.stdout, ref

    @staticmethod
    def chain(pod, rs, deployment):
        def owner(value, kind, parent):
            references = [r for r in value["metadata"].get("ownerReferences", []) if r.get("controller") is True]
            require(len(references) == 1 and references[0].get("kind") == kind and
                    references[0].get("name") == parent["metadata"]["name"] and references[0].get("uid") == parent["metadata"]["uid"],
                    "Actual controller owner chain differs")
        owner(pod, "ReplicaSet", rs); owner(rs, "Deployment", deployment)
        require(not pod["metadata"].get("deletionTimestamp") and not rs["metadata"].get("deletionTimestamp"), "Owning runtime is deleting")

    def list_resources(self, kind, namespace=None, capture=None):
        args = ["get", kind, "-o", "json"]
        if namespace is not None:
            args += ["--namespace", namespace]
        expected = {"persistentvolumeclaims": "PersistentVolumeClaim", "persistentvolumes": "PersistentVolume",
                    "pods": "Pod", "networkpolicies": "NetworkPolicy", "deployments": "Deployment"}.get(kind)
        require(expected is not None, "Unknown resource collection refused")
        api = {"NetworkPolicy": "networking.k8s.io/v1", "Deployment": "apps/v1"}.get(expected, "v1")
        raw = self.kube.run(args)
        require(isinstance(raw, str), "Original collection stdout must be text")
        if capture is not None:
            self.save_raw(capture + ".stdout.original.json", raw.encode())
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, "Duplicate resource collection JSON key")
                result[key] = value
            return result
        value = json.loads(raw, object_pairs_hook=unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite resource collection number")))
        # kubectl may emit a generic v1/List even for a single kind. Validate the
        # complete original inventory and every item; no typed wrapper or list
        # resourceVersion is invented. Atomic writes still guard actual resource
        # UID/resourceVersion/full spec, independent of this list envelope.
        require(isinstance(value, dict) and set(value) == {"apiVersion", "kind", "metadata", "items"} and
                (value.get("apiVersion"), value.get("kind")) in {(api, expected + "List"), ("v1", "List")} and
                isinstance(value.get("items"), list) and len(value["items"]) <= 10000 and
                isinstance(value.get("metadata", {}), dict) and
                type(value.get("metadata", {}).get("remainingItemCount", 0)) is int and
                value.get("metadata", {}).get("remainingItemCount", 0) == 0 and
                not value.get("metadata", {}).get("continue"), "Complete bounded Kubernetes resource list required")
        names, uids = set(), set()
        for item in value["items"]:
            require(isinstance(item, dict) and isinstance(item.get("metadata"), dict), "Resource list item metadata required")
            metadata = item.get("metadata", {})
            require(item.get("apiVersion") == api and item.get("kind") == expected and metadata.get("namespace") == namespace and
                    isinstance(metadata.get("name"), str) and metadata["name"] and isinstance(metadata.get("uid"), str) and metadata["uid"] and
                    isinstance(metadata.get("resourceVersion"), str) and metadata["resourceVersion"] and
                    metadata["name"] not in names and metadata["uid"] not in uids, "List resource kind, scope or identity differs")
            names.add(metadata["name"]); uids.add(metadata["uid"])
        return value

    def resource_checks(self, phase):
        namespace = self.plan["namespace"]
        claim_namespaces = {namespace} | {guard["namespace"] for guard in self.plan["resourceGuards"]
                                          if guard["kind"] == "PersistentVolumeClaim"}
        claim_lists = {scope: self.list_resources("persistentvolumeclaims", scope, phase + ".claims-" + scope)
                       for scope in sorted(claim_namespaces)}
        volumes = self.list_resources("persistentvolumes", capture=phase + ".volumes")
        captured = {(v["kind"], v["metadata"].get("namespace"), v["metadata"]["name"]): v
                    for collection in [*claim_lists.values(), volumes] for v in collection["items"]}
        guard_keys = set()
        for expected in self.plan["resourceGuards"]:
            key = (expected["kind"], expected["namespace"], expected["name"])
            require(key not in guard_keys, "Duplicate resource guard")
            guard_keys.add(key)
            if expected["kind"] == "ConfigMap":
                actual = self.kube.get(expected["kind"], expected["name"], expected["namespace"])
            else:
                require(expected["kind"] in {"PersistentVolumeClaim", "PersistentVolume"} and key in captured,
                        "Protected content resource missing from fresh captures")
                actual = captured[key]
            require(resource_guard(actual) == expected, "Current content UID/resourceVersion/spec/data differs")
        for scope, claims in claim_lists.items():
            actual_claims = {(v["kind"], v["metadata"].get("namespace"), v["metadata"]["name"]) for v in claims["items"]}
            expected_claims = {k for k in guard_keys if k[0] == "PersistentVolumeClaim" and k[1] == scope}
            require(actual_claims == expected_claims, "Complete namespace claim inventory changed")
        global_guard = self.x.get("globalPVInventoryGuarded") is True
        actual_volumes = {(v["kind"], None, v["metadata"]["name"]) for v in volumes["items"]
                          if global_guard or v.get("spec", {}).get("claimRef", {}).get("namespace") == namespace}
        require(actual_volumes == {k for k in guard_keys if k[0] == "PersistentVolume"}, "Complete guarded backing volume inventory changed")
        if global_guard:
            # Every global PV is hash-custodied. Recheck the selected new shell
            # and temporary copy against every backing, including other
            # namespaces; distinct node scopes are distinct local storage.
            claims = {v["metadata"]["name"]: v for v in claim_lists[namespace]["items"]}
            pvs = {v["metadata"]["name"]: v for v in volumes["items"]}
            try:
                candidates = [storage.bound_claim(claims[name], pvs, namespace)
                              for name in (self.plan["selection"]["shellClaim"], self.stage["rawPack"]["claim"])]
                require(len({v["metadata"]["uid"] for v in candidates}) == 2, "Candidate backing volumes alias")
                backings = {name: storage.backing(value) for name, value in pvs.items()}
                for candidate in candidates:
                    left = backings[candidate["metadata"]["name"]]
                    for name, right in backings.items():
                        if name == candidate["metadata"]["name"] or (left[0] == right[0] == "node-path" and left[1] != right[1]):
                            continue
                        require(not storage.overlaps(left, right), "Candidate backing aliases another global PV")
            except (storage.Refusal, KeyError) as error:
                raise Refusal("Complete supported isolated global backing identities required") from error
        stage_uid = self.stage["pod"]["metadata"]["uid"]
        stage_name = self.stage["pod"]["metadata"]["name"]
        policy_name = self.stage["retirement"]["policyName"]
        pods = self.list_resources("pods", namespace, phase + ".pods")
        require(not any(p["metadata"].get("name") == stage_name or p["metadata"].get("uid") == stage_uid for p in pods["items"]),
                "Retired stage Pod reappeared")
        writer_meta = self.writer["metadata"]
        require(not any(p["metadata"].get("name") == writer_meta["name"] or p["metadata"].get("uid") == writer_meta["uid"] for p in pods["items"]),
                "Retired writer Pod reappeared")
        temporary_pack = self.stage["rawPack"]["claim"]
        require(not any(v.get("persistentVolumeClaim", {}).get("claimName") == temporary_pack for p in pods["items"] for v in p["spec"].get("volumes", [])),
                "Temporary staged pack has an active Pod owner")
        policies = self.list_resources("networkpolicies", namespace, phase + ".policies")
        require(not any(p["metadata"].get("name") == policy_name or p["metadata"].get("uid") == self.stage["retirement"]["policyUID"] for p in policies["items"]),
                "Retired stage policy reappeared")
        stdout, ref = self.command("retiredMountProbe", phase)
        probe = json.loads(stdout)
        exact(probe, {"version", "stagePodUID", "writerPodUID", "nodeUID", "mountsReleased"})
        require(type(probe["version"]) is int and probe["version"] == 1 and probe["stagePodUID"] == stage_uid and
                probe["writerPodUID"] == writer_meta["uid"] and
                probe["nodeUID"] == self.target["node"]["uid"] and probe["mountsReleased"] is True,
                "Current reviewed host mount release probe differs")
        return pods, ref

    def fresh(self, phase, after=False):
        self.source_check(); updater.check_cluster(self.target, self.kube)
        namespaces, deployments = {}, {}
        for namespace in sorted({component["namespace"] for component in self.target["components"].values()}):
            namespaces[namespace] = self.kube.get("namespace", namespace)
            collection = self.list_resources("deployments", namespace, phase + ".deployments-" + namespace)
            deployments.update({(namespace, value["metadata"]["name"]): value for value in collection["items"]})
        inventory = DeploymentInventory(namespaces, deployments)
        snapshots = {}
        for role, component in self.target["components"].items():
            value = updater.deployment_identity(component, inventory)
            wanted = self.plan["desiredSpec"] if role == "work" and after else self.baseline["deployments"][role]["spec"]
            require(value["spec"] == wanted, "Current owned or protected deployment full specification differs")
            if role != "work" or not after:
                require(value.get("status", {}).get("readyReplicas") == value["spec"].get("replicas", 1) and
                        value.get("status", {}).get("observedGeneration", 0) >= value["metadata"].get("generation", 1),
                        "Current owned or protected deployment is not Ready")
            snapshots[role] = value
        pods, probe_ref = self.resource_checks(phase)
        candidate = self.plan["selection"]["shellClaim"]
        holders = [p for p in pods["items"] if any(v.get("persistentVolumeClaim", {}).get("claimName") == candidate for v in p["spec"].get("volumes", []))]
        require((len(holders) == 1) if after else not holders, "Candidate shell has an unexpected Pod owner")
        old_volumes = self.before["spec"]["template"]["spec"]["volumes"]
        old_shell = selected(old_volumes, self.plan["selection"]["shellVolume"])["persistentVolumeClaim"]["claimName"]
        pack = selected(old_volumes, self.plan["selection"]["packVolume"])["persistentVolumeClaim"]["claimName"]
        accepted_owners = set()
        for pod in pods["items"]:
            volumes = pod["spec"].get("volumes", [])
            require(isinstance(volumes, list), "Pod storage inventory is malformed")
            for volume in volumes:
                require(isinstance(volume, dict) and len(set(volume) - {"name"}) == 1 and
                        set(volume) - {"name"} <= {"persistentVolumeClaim", "configMap", "secret", "emptyDir", "projected", "downwardAPI"},
                        "Unreviewed direct Pod storage appeared")
                claim = volume.get("persistentVolumeClaim", {}).get("claimName")
                if claim in {old_shell, pack}:
                    accepted_owners.add(pod["metadata"]["uid"])
                    if after:
                        require(claim != old_shell, "Previous shell still has an active Pod owner")
        wanted_owner = holders[0]["metadata"]["uid"] if after else self.baseline["owner"]["metadata"]["uid"]
        require(accepted_owners == {wanted_owner}, "Accepted pack/shell has an unexpected active Pod owner")
        if not after:
            baseline_owner = self.baseline["owner"]
            owners = [p for p in pods["items"] if p["metadata"].get("uid") == baseline_owner["metadata"]["uid"]]
            require(len(owners) == 1 and owners[0]["spec"] == baseline_owner["spec"] and
                    owners[0]["status"].get("phase") == "Running", "Original owning Pod changed before promotion")
            rs = self.kube.get("replicaset", self.baseline["replicaSet"]["metadata"]["name"], self.plan["namespace"])
            require(rs["metadata"]["uid"] == self.baseline["replicaSet"]["metadata"]["uid"] and rs["spec"] == self.baseline["replicaSet"]["spec"],
                    "Original ReplicaSet changed before promotion")
            self.chain(owners[0], rs, snapshots["work"])
        self.save(phase + ".guards.original.json", {"deployments": snapshots, "namespaces": namespaces, "pods": pods, "mountProbe": probe_ref})
        return snapshots["work"], pods

    def dryrun(self):
        self.begin("dryrun")
        current, _ = self.fresh("dryrun")
        patch = fresh_patch(self.plan, current)
        self.command("preflight", "dryrun")
        result = self.kube.patch(self.component, patch, True)
        response = self.save("dryrun.response.original.json", result)
        require(result["metadata"]["uid"] == self.plan["deploymentUID"] and result["spec"] == self.plan["desiredSpec"],
                "Admission changed reviewed full specification")
        self.save("dryrun.actual.json", {**self.header("SERVER_DRYRUN_FULL_SPEC_ACCEPTED"), "response": response, "productionMutation": False})

    def apply(self):
        dry = self.prior("dryrun", "SERVER_DRYRUN_FULL_SPEC_ACCEPTED")
        require(read(dry["response"], self.base)["spec"] == self.plan["desiredSpec"], "Original successful dry-run response differs")
        self.begin("apply")
        current, _ = self.fresh("apply")
        patch = fresh_patch(self.plan, current)
        self.command("preflight", "apply")
        result = self.kube.patch(self.component, patch, False)
        response = self.save("apply.response.original.json", result)
        require(result["metadata"]["uid"] == self.plan["deploymentUID"] and result["spec"] == self.plan["desiredSpec"],
                "Committed response mismatch; reconcile without replay")
        self.save("apply.actual.json", {**self.header("ATOMIC_PRIVATE_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING"), "response": response,
                                      "desiredSpecSha256": self.plan["desiredSpecSha256"], "productionMutation": True})

    def same_observed_owner(self, phase, original):
        deployment, pods = self.fresh(phase, after=True)
        old_pod = original["pod"]
        holders = [pod for pod in pods["items"] if pod["metadata"]["uid"] == old_pod["metadata"]["uid"]]
        require(len(holders) == 1, "Authenticated probe owning Pod changed")
        pod = holders[0]
        rs = self.kube.get("replicaset", original["replicaSet"]["metadata"]["name"], self.plan["namespace"])
        self.chain(pod, rs, deployment)
        for current, previous in ((deployment, original["deployment"]), (pod, old_pod), (rs, original["replicaSet"])):
            require(current["metadata"]["uid"] == previous["metadata"]["uid"] and current["metadata"]["name"] == previous["metadata"]["name"] and
                    current["spec"] == previous["spec"] and not current["metadata"].get("deletionTimestamp") and
                    all(current["metadata"].get(key, {}) == previous["metadata"].get(key, {}) for key in ("labels", "annotations")),
                    "Authenticated probe owner specification or metadata changed")
        state = selected(pod["status"]["containerStatuses"], self.plan["selection"]["container"])
        old_state = selected(old_pod["status"]["containerStatuses"], self.plan["selection"]["container"])
        require(state.get("ready") is True and type(state.get("restartCount")) is int and state["restartCount"] == 0 and
                state.get("imageID") == old_state.get("imageID") and state.get("state") == old_state.get("state") and
                "running" in state.get("state", {}) and pod["status"].get("phase") == "Running" and
                any(condition.get("type") == "Ready" and condition.get("status") == "True" for condition in pod["status"].get("conditions", [])) and
                deployment.get("status", {}).get("readyReplicas") == 1 and
                deployment["status"].get("observedGeneration", 0) >= deployment["metadata"].get("generation", 1),
                "Authenticated probe owner process/image/readiness changed")
        return {"deployment": deployment, "pod": pod, "replicaSet": rs}

    def authenticated_static(self, base_url, owner, owner_ref, content_ref):
        command = self.x["authenticatedStaticProbe"]
        gates = [anonymous_catalog_gate(urljoin(base_url, path)) for path in ("catalog/tools/index.json", "catalog/tools/index.sig.json")]
        gates_ref = self.save("observe.anonymous-catalog-gates.original.json", {"version": 1, "probes": gates})
        current = self.same_observed_owner("observe-before-auth", owner)
        context = {"version": 1, "status": "ACTUAL_PRIVATE_SHELL_AUTHENTICATED_CATALOG_CONTEXT", "publicationInputSha256": self.input_ref["sha256"],
                   "planSha256": self.refs["plan"]["sha256"], "sources": self.plan["sources"], "image": self.plan["image"], "owner": current,
                   "ownerEvidence": owner_ref, "contentEvidence": content_ref, "selection": self.plan["selection"], "mounts": self.mounts,
                   "baseURL": base_url, "publicPin": self.public_pin, "qualifiedCatalog": self.stage["catalog"],
                   "shellManifest": self.refs["shellManifest"], "packManifest": self.refs["packManifest"], "enginePin": self.refs["enginePin"], "resolverPin": self.resolver_ref}
        context_ref = self.save("observe.authenticated-catalog-context.original.json", context)
        self.source_check()
        # Last target call before the separately reviewed memory-session probe.
        self.command("preflight", "observe-auth")
        self.source_check()
        result = self.command_runner(command["argv"], input=canonical(context).decode(), capture_output=True, text=True, timeout=300, check=False)
        require(type(result.stdout) is str and type(result.stderr) is str and len(result.stdout.encode()) <= 1024**2 and len(result.stderr.encode()) <= 1024**2,
                "Authenticated probe output exceeds reviewed bound")
        output_ref = self.save("observe.authenticated-catalog-command.original.json", {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        require(result.returncode == 0 and result.stderr == "", "Authenticated catalogue probe failed; preserve originals without replay")
        def unique(pairs):
            value = {}
            for key, item in pairs:
                require(key not in value, "Duplicate authenticated probe JSON key")
                value[key] = item
            return value
        value = json.loads(result.stdout, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite probe number")))
        authenticated_catalog_report(value, context, command, self.stage["catalog"], self.public_pin)
        report_ref = self.save("observe.authenticated-catalog-report.original.json", value)
        self.same_observed_owner("observe-after-auth", owner)
        self.source_check()
        portable = {key: {**command[key], "path": str(Path(os.path.abspath(self.base / command[key]["path"])))} for key in ("source", "input")}
        self.authenticated_catalog_proof = {"publicationInput": self.input_ref, **portable, "context": context_ref, "command": output_ref,
                                            "report": report_ref, "anonymousGates": gates_ref, "profile": AUTHENTICATED_CATALOG_PROFILE}
        return value["probes"], gates

    def observe(self, timeout=180):
        applied = self.prior("apply", "ATOMIC_PRIVATE_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING")
        require(read(applied["response"], self.base)["spec"] == self.plan["desiredSpec"], "Original committed response differs")
        self.begin("observe")
        self.kube.rollout(self.component, timeout)
        deployment, pods = self.fresh("observe", after=True)
        require(deployment.get("status", {}).get("readyReplicas") == deployment["spec"].get("replicas", 1) == 1 and
                deployment.get("status", {}).get("observedGeneration", 0) >= deployment["metadata"].get("generation", 1), "Updated deployment is not Ready")
        holder = next(p for p in pods["items"] if any(v.get("persistentVolumeClaim", {}).get("claimName") == self.plan["selection"]["shellClaim"] for v in p["spec"].get("volumes", [])))
        require(holder["metadata"]["uid"] != self.baseline["owner"]["metadata"]["uid"] and
                holder["spec"].get("nodeName") == self.target["node"]["name"], "Actual new owning Pod/node differs")
        references = [r for r in holder["metadata"].get("ownerReferences", []) if r.get("controller") is True and r.get("kind") == "ReplicaSet"]
        require(len(references) == 1, "Unique owning ReplicaSet required")
        rs = self.kube.get("replicaset", references[0]["name"], self.plan["namespace"])
        self.chain(holder, rs, deployment)
        expected_pod = copy.deepcopy(self.baseline["owner"]["spec"])
        selected(expected_pod["volumes"], self.plan["selection"]["shellVolume"])["persistentVolumeClaim"]["claimName"] = self.plan["selection"]["shellClaim"]
        require(holder["spec"] == expected_pod and holder["metadata"].get("annotations", {}) == deployment["spec"]["template"]["metadata"].get("annotations", {}),
                "Unselected actual owning Pod fields/provenance changed")
        server = self.plan["selection"]["container"]
        statuses = holder.get("status", {}).get("containerStatuses", [])
        status = selected(statuses, server)
        require(status.get("ready") is True and status.get("restartCount") == 0 and
                status.get("imageID", "").endswith(self.plan["image"].split("@")[1]), "Actual accepted image identity/readiness/restarts differ")
        owner_ref = self.save("observe.owner.original.json", {"deployment": deployment, "pod": holder, "replicaSet": rs})
        data = self.kube.run(["exec", holder["metadata"]["name"], "--namespace", self.plan["namespace"], "--container", server,
                              "--", "node", "-e", OWNER_READBACK, self.mounts["shellPath"], self.mounts["packPath"], self.mounts["pinPath"], canonical(self.public_pin).decode()], timeout=300)
        actual = json.loads(data)
        content_ref = self.save("observe.content.original.json", actual)
        expected_catalog = {**self.stage["catalog"], "publicPinSha256": digest(self.public_pin), "signatureVerified": True}
        require(actual == {"version": 1, "shell": self.shell, "pack": self.pack, "pinSha256": self.refs["enginePin"]["sha256"], "catalog": expected_catalog},
                "Actual full shell/pack/pin bytes differ from qualified manifests")
        urls = [url for component in self.target["components"].values() for url in component.get("healthURLs", [])]
        require(urls, "Configured normal TLS acceptance routes required")
        probes = []
        for url in urls:
            self.health(url); probes.append({"url": url, "status": 200, "verifiedTlsAndHostname": True})
        work_urls = self.component.get("healthURLs", [])
        require(work_urls, "Work target needs a normal HTTPS origin for static acceptance")
        parsed = urlsplit(work_urls[0])
        base_url = parsed.scheme + "://" + parsed.netloc + "/"
        file_map = {item["path"]: item for item in self.shell["files"]}
        static_probes = []
        gated = "authenticatedStaticProbe" in self.x
        for path in (("index.html",) if gated else ("index.html", "catalog/tools/index.json", "catalog/tools/index.sig.json")):
            require(path in file_map, "Missing static acceptance file")
            item = file_map[path]; url = urljoin(base_url, path)
            body = self.static_fetcher(url, item["size"])
            require(len(body) == item["size"] and hashlib.sha256(body).hexdigest() == item["sha256"], "Normal HTTPS static bytes differ from owning candidate")
            static_probes.append({"path": path, "url": url, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(), "status": 200, "verifiedTlsAndHostname": True})
        tls = {"version": 1, "probes": static_probes, "certificateRequired": True, "hostnameVerified": True}
        if gated:
            owner = {"deployment": deployment, "pod": holder, "replicaSet": rs}
            extra, gates = self.authenticated_static(base_url, owner, owner_ref, content_ref)
            static_probes.extend(extra)
            tls.update({"profile": AUTHENTICATED_CATALOG_PROFILE, "authenticatedCatalogProof": self.authenticated_catalog_proof,
                        "unauthenticatedGates": gates, "preparedEnvelopeByteEqualityClaimed": False})
        tls_ref = self.save("observe.static-https.original.json", tls)
        accepted_ref = self.accepted_previous(deployment, holder, rs, status, owner_ref, content_ref, tls_ref, static_probes)
        self.save("observe.actual.json", {**self.header("ACTUAL_PRIVATE_SHELL_OWNER_CONTENT_AND_TLS_VERIFIED_ACCEPTANCE_PENDING"),
                   "podUID": holder["metadata"]["uid"], "replicaSetUID": rs["metadata"]["uid"], "imageID": status["imageID"],
                   "content": content_ref, "https": probes, "staticHTTPS": tls_ref, "acceptedPrevious": accepted_ref, "protectedDeploymentsUnchanged": True, "productionMutation": False,
                   "remainingAcceptance": ["Authenticated export and document-agent canaries", "Signed-in reconnect and visual checks"]})

    def accepted_previous(self, deployment, pod, rs, status, owner_ref, content_ref, tls_ref, probes):
        """Produce the next offline preparer's exact portable accepted input.

        Image/vendor/schema compatibility is a continued accepted immutable OCI
        digest, not a newly claimed vendor rebuild or OCI signature. Actual
        mounted bytes and public-P256 verification were read back on this owner.
        """
        volumes = deployment["spec"]["template"]["spec"]["volumes"]
        shell_name = self.plan["selection"]["shellClaim"]
        pack_name = selected(volumes, self.plan["selection"]["packVolume"])["persistentVolumeClaim"]["claimName"]
        pin_name = selected(volumes, self.plan["selection"]["pinVolume"])["configMap"]["name"]
        guards = {(v["kind"], v["name"]): v for v in self.plan["resourceGuards"]}
        shell_uid = guards[("PersistentVolumeClaim", shell_name)]["uid"]
        pack_uid = guards[("PersistentVolumeClaim", pack_name)]["uid"]
        pin_uid = guards[("ConfigMap", pin_name)]["uid"]
        image_id = status["imageID"]
        # Kube imageID schemes are transport metadata; the already checked digest
        # is represented using its reviewed repository-pinned image identity.
        require(image_id.endswith(self.plan["image"].split("@")[1]), "Accepted OCI digest changed")
        original = {"version": 1, "status": "PRIVATE_SHELL_RUNTIME_AND_HTTPS_ACCEPTED", "shellSource": self.plan["sources"]["lolly"],
           "engineSource": self.plan["sources"]["engine"], "workSource": self.plan["sources"]["work"], "image": self.plan["image"], "imageId": self.plan["image"], "observedImageId": image_id,
           "shellManifestSha256": self.refs["shellManifest"]["sha256"], "packManifestSha256": self.refs["packManifest"]["sha256"], "resolverPinSha256": self.resolver_ref["sha256"],
           "deploymentUid": deployment["metadata"]["uid"], "deploymentSpecSha256": digest(deployment["spec"]), "namespace": self.plan["namespace"], "deploymentName": self.plan["deployment"],
           "podUid": pod["metadata"]["uid"], "replicaSetUid": rs["metadata"]["uid"], "podSpecSha256": digest(pod["spec"]),
           "shellClaim": shell_name, "shellClaimUid": shell_uid, "packClaim": pack_name, "packClaimUid": pack_uid, "pinConfigMap": pin_name, "pinConfigMapUid": pin_uid,
           "fullStatic": {"verified": True, "files": len(self.shell["files"]), "manifestSha256": self.refs["shellManifest"]["sha256"]},
           "runtimeAndCatalog": {"pinSha256": self.refs["enginePin"]["sha256"], "vendorContentMatches": True, "signedFileMapMatchesQualifiedOracle": True,
              "engine": self.engine_pin["engine"]["version"], "core": self.engine_pin["core"]["version"],
              "filteredCatalogSignatureVerified": True, "publicPinMatches": True, "automaticMigration": False, "packFilesEqual": len(self.pack["files"]), "signedToolFilesEqual": self.stage["catalog"]["signedFiles"],
              "vendorVerification": "UNCHANGED_ACCEPTED_OCI_DIGEST_WITH_PREVIOUS_RUNTIME_CUSTODY", "catalogVerification": "FRESH_OWNING_POD_P256_AND_FULL_SHELL_PACK_HASHES"},
           "https": probes, "tls": {"certificateRequired": True, "hostnameVerified": True}, "originalEvidence": [owner_ref, content_ref, tls_ref, self.previous_ref],
           "runtimeAcceptanceScope": "IMMUTABLE_IMAGE_CONTENT_AND_NORMAL_TLS", "remainingAcceptance": ["Authenticated export and document-agent canaries", "Signed-in reconnect and visual checks"], "ociImageSignatureClaimed": False}
        if hasattr(self, "authenticated_catalog_proof"):
            original.update({"status": "PRIVATE_SHELL_RUNTIME_AND_AUTHENTICATED_HTTPS_ACCEPTED", "authenticatedCatalogProfile": AUTHENTICATED_CATALOG_PROFILE,
                             "authenticatedCatalogProof": self.authenticated_catalog_proof, "unauthenticatedCatalogGated": True, "preparedCatalogHTTPSByteEqualityClaimed": False})
        original_ref = self.save("observe.acceptance.original.json", original)
        projection = {"apiVersion": deployment["apiVersion"], "kind": deployment["kind"],
                      "metadata": {key: deployment["metadata"][key] for key in ("namespace", "name", "uid", "resourceVersion")}, "spec": deployment["spec"]}
        deployment_ref = self.save("accepted.deployment.json", projection)
        acceptance = {"version": 1, "status": "RUNTIME_ACCEPTED", "deploymentUID": deployment["metadata"]["uid"], "deploymentSpecSha256": digest(deployment["spec"]),
           "shellSource": self.plan["sources"]["lolly"], "engineSource": self.plan["sources"]["engine"], "workSource": self.plan["sources"]["work"], "image": self.plan["image"],
           "enginePinSha256": self.refs["enginePin"]["sha256"], "resolverPinSha256": self.resolver_ref["sha256"], "shellManifestSha256": self.refs["shellManifest"]["sha256"],
           "packManifestSha256": self.refs["packManifest"]["sha256"], "originalEvidence": [original_ref, tls_ref]}
        acceptance_ref = self.save("accepted.runtime.json", acceptance)
        previous = {"version": 1, "deployment": deployment_ref, "deploymentSpecSha256": digest(deployment["spec"]),
           "shellSource": self.plan["sources"]["lolly"], "engineSource": self.plan["sources"]["engine"], "workSource": self.plan["sources"]["work"], "image": self.plan["image"],
           "enginePin": self.refs["enginePin"], "resolverPin": self.resolver_ref,
           "shell": {"name": shell_name, "uid": shell_uid, "manifestSha256": self.refs["shellManifest"]["sha256"], "releaseId": self.stage["shell"]["releaseId"]},
           "pack": {"name": pack_name, "uid": pack_uid, "manifestSha256": self.refs["packManifest"]["sha256"]},
           "pin": {"name": pin_name, "uid": pin_uid, "sha256": self.refs["enginePin"]["sha256"]}, "acceptance": acceptance_ref}
        return self.save("accepted.previous.json", previous)

    def rollback_intent(self):
        self.prior("apply", "ATOMIC_PRIVATE_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING")
        self.begin("rollback-intent")
        current, _ = self.fresh("rollback-intent", after=True)
        self.save("rollback-intent.actual.json", {**self.header("FRESH_ROLLBACK_REVIEW_INTENT_NOT_EXECUTABLE"),
              "deploymentUID": current["metadata"]["uid"], "resourceVersion": current["metadata"]["resourceVersion"],
              "currentSpecSha256": digest(current["spec"]), "restoreSpecSha256": digest(self.before["spec"]),
              "fields": self.plan["rollbackIntent"]["fields"], "productionMutation": False,
              "required": ["Fresh data/asset compatibility review", "Fresh isolated target guards and admission dry run", "A separately reviewed rollback operator intent"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["check", "dryrun", "apply", "observe", "rollback-intent"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--reviewed-input-sha256", required=True)
    parser.add_argument("--reviewed-operator-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--rollout-timeout", type=int, default=180)
    args = parser.parse_args()
    require(10 <= args.rollout_timeout <= 600, "Invalid bounded rollout timeout")
    publication = Publication(args.input, args.reviewed_input_sha256, args.reviewed_operator_sha256, args.out_dir)
    if args.phase == "check":
        print("LOCAL_REVIEWED_SHELL_PUBLICATION_CUSTODY_PASS; no target calls")
        return
    try:
        if args.phase == "observe":
            publication.observe(args.rollout_timeout)
        else:
            getattr(publication, args.phase.replace("-", "_"))()
        print(args.phase.upper() + "_PASS; final runtime acceptance remains separate")
    except Exception as exc:
        # Do not print raw API responses, guard stdout, credentials or resource data.
        if (publication.out / (args.phase + ".started.json")).exists() and not (publication.out / (args.phase + ".uncertain.json")).exists():
            publication.save(args.phase + ".uncertain.json", {**publication.header("REFUSED_NO_REPLAY_RECONCILE_ORIGINAL_STATE"), "failureType": type(exc).__name__})
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("REFUSED: shell publication boundary differs; retain originals and reconcile without replay", file=sys.stderr)
        raise SystemExit(1)
