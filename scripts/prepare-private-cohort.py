#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Prepare a reviewed private mounted-content cohort offline; never build or apply.

Usage: python3 scripts/prepare-private-cohort.py --evidence FILE \
  --reviewed-evidence-sha256 SHA256 --out-dir NEW_PROTECTED_DIRECTORY

The v1 evidence contract is exercised in tests/test_prepare_private_cohort.py.
CI metadata, build/inspection/gate reports and previous acceptance are local,
reviewed custody inputs: this command does not authenticate their origin anew.
It verifies their byte/source bindings, the server ZIP/OCI closure, public P-256
catalog signature, full trees and the four-field protected-spec change. Output
is advisory and cannot be passed directly to the image-only updater as a release.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("paired_release", Path(__file__).with_name("prepare-paired-release.py"))
paired = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(paired)
Refusal, require, exact = paired.Refusal, paired.require, paired.exact
SHA, COMMIT = paired.SHA, paired.COMMIT
STATUS = "PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED"
JSON_LIMIT = 32 * 1024 * 1024
MAX_FILES, MAX_BYTES, MAX_DEPTH = 100_000, 8 * 1024**3, 64
NAME = re.compile(r"[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\Z")
WORK_JOBS = ("test", "typecheck", "npm audit (high+critical) + SBOM", "container image builds (server)", "container image builds (render-worker)")
LOLLY_JOBS = ("secret history scan", "typecheck", "test (browser)", "validate catalog", "smoke (render every tool)",
              "build + bundle budget", "api bundle drift", "render-action self-test", "npm audit (high+critical)", "opengrep (custom rules + new findings)",
              *[f"test ({shard})" for shard in ("unit:engine", "unit:web", "contracts", "security", "tools", "tauri", "conformance", "fuzz:regression")],
              *[f"test (browser {part}/4)" for part in range(1, 5)])
EVIDENCE_KEYS = {"version", "lolly", "work", "enginePin", "resolverPin", "workArtifact", "workArtifactMetadata", "expectedWorkImage",
                 "brand", "profile", "publicPin", "candidateShell", "previousShell", "shell", "rawPack", "build", "inspection", "webGate", "previous", "selection"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value), "Invalid SHA256 binding")
    return value


def commit(value):
    require(isinstance(value, str) and COMMIT.fullmatch(value), "Invalid immutable source")
    return value


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def safe_path(value):
    require(isinstance(value, str) and 0 < len(value.encode()) <= 1024 and len(value.split("/")) <= MAX_DEPTH
            and not value.startswith("/") and "\\" not in value
            and all(part not in {"", ".", ".."} for part in value.split("/"))
            and all(ord(c) >= 32 and ord(c) != 127 for c in value), "Unsafe inventory path")
    return value


def local_path(value, base):
    require(isinstance(value, str) and value and "\0" not in value, "Invalid local input path")
    path = Path(os.path.abspath(base / value))
    require(path.resolve(strict=True) == path, "Inputs must not use symlink paths")
    return path


def read_file(path, limit=JSON_LIMIT):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size <= limit and not before.st_mode & 0o022, "Input must be a bounded non-writable regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stamp(os.fstat(fd)) == stamp(before), "Input changed before reading")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit and len(data) == before.st_size and stamp(os.fstat(fd)) == stamp(before)
                and stamp(path.lstat()) == stamp(before), "Input changed while reading")
        return data, stamp(before)
    finally:
        os.close(fd)


def parse_json(data):
    require(len(data) <= JSON_LIMIT, "JSON exceeds its size bound")
    def unique(pairs):
        result = {}
        for key, item in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = item
        return result
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite JSON number")))


class Inputs:
    def __init__(self, base):
        self.base, self.reads, self.trees, self.source_roots, self.source_checks = base, {}, [], [], []

    def file(self, value, as_json=True):
        exact(value, {"path", "sha256"})
        path = local_path(value["path"], self.base)
        expected = sha(value["sha256"])
        if as_json:
            data, identity = read_file(path)
            require(hashlib.sha256(data).hexdigest() == expected, "Evidence bytes differ from review")
            parsed = parse_json(data)
        else:
            identity, actual, _ = hash_file(path, paired.ARCHIVE_LIMIT)
            require(actual == expected, "Artifact bytes differ from review")
            parsed = path
        require(path not in self.reads or self.reads[path] == (identity, expected), "Conflicting input custody")
        self.reads[path] = (identity, expected)
        return parsed

    def unchanged(self):
        for root, source, runner in self.source_checks:
            require(runner(["git", "rev-parse", "HEAD"], root) == source and runner(["git", "status", "--porcelain"], root) == "", "Source changed during preparation")
        for path, (identity, _) in self.reads.items():
            require(path.resolve(strict=True) == path and stamp(path.lstat()) == identity, "Evidence changed during preparation")
        for tree in self.trees:
            tree.unchanged()


def hash_file(path, limit=MAX_BYTES):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size <= limit and not before.st_mode & 0o022, "Tree needs bounded non-writable regular files")
    fd, h, size = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), hashlib.sha256(), 0
    try:
        require(stamp(os.fstat(fd)) == stamp(before), "Tree file changed before reading")
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            size += len(block)
            require(size <= before.st_size and size <= limit, "Tree file changed while reading")
            h.update(block)
        require(size == before.st_size and stamp(os.fstat(fd)) == stamp(before)
                and stamp(path.lstat()) == stamp(before), "Tree file changed while reading")
        return stamp(before), h.hexdigest(), size
    finally:
        os.close(fd)


class Tree:
    def __init__(self, value, inputs):
        exact(value, {"root", "manifest"})
        self.root = local_path(value["root"], inputs.base)
        require(self.root.is_dir(), "Tree root is not a directory")
        manifest = inputs.file(value["manifest"])
        exact(manifest, {"version", "files", "totalBytes"})
        require(type(manifest["version"]) is int and manifest["version"] == 1
                and isinstance(manifest["files"], list) and 1 <= len(manifest["files"]) <= MAX_FILES
                and type(manifest["totalBytes"]) is int and 0 <= manifest["totalBytes"] <= MAX_BYTES, "Invalid complete tree manifest")
        self.files, self.identities, self.directories = {}, {}, {}
        paths, total = [], 0
        for item in manifest["files"]:
            exact(item, {"path", "size", "sha256"})
            path = safe_path(item["path"])
            require(path not in self.files and type(item["size"]) is int and 0 <= item["size"] <= MAX_BYTES, "Duplicate or invalid manifest entry")
            sha(item["sha256"])
            paths.append(path)
            total += item["size"]
            self.files[path] = item
        require(paths == sorted(paths) and total == manifest["totalBytes"], "Manifest ordering or total differs")
        seen, entries, walk_order = set(), [0], []
        def walk(directory, relative, depth):
            require(depth <= MAX_DEPTH, "Tree exceeds its depth bound")
            before = directory.lstat()
            require(stat.S_ISDIR(before.st_mode) and not before.st_mode & 0o022, "Tree directories must not be links or writable by others")
            names = sorted(os.listdir(directory), key=lambda name: name.encode("utf-16-be"))
            self.directories[relative] = (stamp(before), names)
            for name in names:
                leaf = safe_path(f"{relative}/{name}" if relative else name)
                entries[0] += 1
                require(entries[0] <= MAX_FILES * 2, "Tree exceeds its entry bound")
                child = directory / name
                if stat.S_ISDIR(child.lstat().st_mode):
                    walk(child, leaf, depth + 1)
                else:
                    require(leaf in self.files, "Unlisted tree file")
                    identity, actual, size = hash_file(child)
                    require(actual == self.files[leaf]["sha256"] and size == self.files[leaf]["size"], "Tree bytes differ from full manifest")
                    self.identities[leaf] = identity
                    seen.add(leaf)
                    walk_order.append(leaf)
            require(stamp(directory.lstat()) == stamp(before) and sorted(os.listdir(directory), key=lambda name: name.encode("utf-16-be")) == names, "Tree directory changed during inventory")
        walk(self.root, "", 0)
        require(seen == set(self.files), "Incomplete tree manifest")
        self.manifest_sha = value["manifest"]["sha256"]
        self.shell_id = "release-" + hashlib.sha256(json.dumps([[p, self.files[p]["sha256"]] for p in walk_order], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()[:16]
        inputs.trees.append(self)

    def unchanged(self):
        require(self.root.resolve(strict=True) == self.root, "Tree root changed")
        for relative, (identity, names) in self.directories.items():
            directory = self.root / relative
            require(stamp(directory.lstat()) == identity and sorted(os.listdir(directory), key=lambda name: name.encode("utf-16-be")) == names, "Tree directory changed during preparation")
        for relative, identity in self.identities.items():
            require(stamp((self.root / relative).lstat()) == identity, "Tree file changed during preparation")

    def data(self, path):
        require(path in self.files, "Required content file is missing")
        data, identity = read_file(self.root / path)
        require(identity == self.identities[path], "Content file changed during preparation")
        return data


def git_command(argv, root):
    require(argv[:1] == ["git"] and len(argv) >= 2 and argv[1] in {"rev-parse", "status", "show", "ls-tree"}, "Only offline Git reads are permitted")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", *argv[1:]], cwd=root,
                            env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, check=False)
    require(result.returncode == 0 and len(result.stdout) <= JSON_LIMIT, "Read-only Git source verification failed")
    if argv[1] == "show":
        return result.stdout
    return result.stdout.decode().strip() if argv[1] in {"rev-parse", "status"} else result.stdout.decode()


def source_record(value, inputs, runner, kind):
    # Existing validators preserve the authenticated run/artifact formats.
    exact(value, {"root", "source", "repository", "main", "ciRun", "ciJobs"})
    require(isinstance(value["root"], str) and Path(value["root"]).is_absolute(), "Source checkout must be absolute")
    local_path(value["root"], inputs.base)
    root, run = paired.source_record(value, inputs.base, runner)
    inputs.source_roots.append(root)
    inputs.source_checks.append((root, value["source"], runner))
    for key in ("main", "ciRun", "ciJobs"):
        inputs.file(value[key])
    # Register every historical provider original in the same immutable read
    # closure, including the preparer's final unchanged() check.
    paired.main_record(inputs.file(value["main"]), value, inputs.base, inputs.file)
    jobs = inputs.file(value["ciJobs"])
    required = WORK_JOBS if kind == "work" else LOLLY_JOBS
    paired.jobs_record(jobs, run, allow_shell_skip=kind == "lolly", required_names=required)
    require(len({job["name"] for job in jobs["jobs"]}) == len(jobs["jobs"]), "Duplicate CI job names")
    return root, run


def git_bytes(root, source, path, runner):
    safe_path(path)
    data = runner(["git", "show", f"{source}:{path}"], root)
    require(isinstance(data, bytes), "Git blobs must retain their raw committed bytes")
    return data


def source_pins(pin, resolver, lolly, work, runner):
    exact(pin, {"generatedFrom", "note", "engine", "core", "schemas"})
    require(pin["generatedFrom"] == lolly["source"] and isinstance(pin["schemas"], dict) and 1 <= len(pin["schemas"]) <= 256, "Private pin source differs")
    root, source = Path(work["root"]), work["source"]
    for package, prefix in (("engine", "vendor/@lolly/engine/"), ("core", "vendor/@lolly-tools/core/")):
        entry = pin[package]
        exact(entry, {"version", "contentHash", "tarball", "tarballSha256"})
        require(isinstance(entry["version"], str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", entry["version"]), "Invalid package version")
        sha(entry["contentHash"]); sha(entry["tarballSha256"])
        lines = runner(["git", "ls-tree", "-r", source, "--", prefix], root).splitlines()
        require(1 <= len(lines) <= 5000, "Missing vendored package content")
        h = hashlib.sha256()
        for line in sorted(lines, key=lambda line: line.split("\t", 1)[1]):
            header, path = line.split("\t", 1)
            require(header.split()[0] in {"100644", "100755"} and path.startswith(prefix), "Vendored package must use regular committed files")
            relative = safe_path(path[len(prefix):])
            require("node_modules" not in relative.split("/"), "Vendored package includes install artifacts")
            h.update(relative.encode() + b"\0" + git_bytes(root, source, path, runner) + b"\0")
        require(h.hexdigest() == entry["contentHash"], "Actual vendored package differs from engine/core pin")
        package_json = parse_json(git_bytes(root, source, prefix + "package.json", runner))
        require(package_json.get("version") == entry["version"], "Package version differs from pin")
    for path, expected in pin["schemas"].items():
        safe_path(path); sha(expected)
        require("/" not in path and hashlib.sha256(git_bytes(root, source, "vendor/@lolly/schemas/" + path, runner)).hexdigest() == expected
                and hashlib.sha256(git_bytes(Path(lolly["root"]), lolly["source"], "schemas/" + path, runner)).hexdigest() == expected, "Schema source differs from pin")
    exact(resolver, {"repository", "commit", "files"})
    require(resolver["repository"] == "https://github.com/" + lolly["repository"] and resolver["commit"] == lolly["source"]
            and isinstance(resolver["files"], dict) and set(resolver["files"]) == {"content-roots.ts", "repo-root.ts", "LICENSE"}, "Resolver pin source differs")
    for name, entry in resolver["files"].items():
        exact(entry, {"source", "checksum"}); sha(entry["checksum"])
        require(hashlib.sha256(git_bytes(root, source, "vendor/@lolly/content-resolver/" + name, runner)).hexdigest() == entry["checksum"]
                and hashlib.sha256(git_bytes(Path(lolly["root"]), lolly["source"], entry["source"], runner)).hexdigest() == entry["checksum"], "Canonical resolver content differs")
    link = runner(["git", "ls-tree", source, "--", "vendor/lolly"], root).strip().split()
    require(link == ["160000", "commit", lolly["source"], "vendor/lolly"], "Work frontend gitlink differs from source")


VERIFY_PUBLIC = r"""
const { createPublicKey, verify } = require('node:crypto');
if (Number(process.versions.node.split('.')[0]) < 24) process.exit(2);
let data = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { data += part; if (data.length > 33554432) process.exit(2); });
process.stdin.on('end', () => {
  try {
    const v = JSON.parse(data), key = createPublicKey({ key: v.pin, format: 'jwk' });
    const ok = verify('sha256', Buffer.from(v.payload, 'base64'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(v.signature, 'base64url'));
    process.stdout.write(ok ? 'VERIFIED' : 'REFUSED'); process.exitCode = ok ? 0 : 1;
  } catch { process.exitCode = 1; }
});
"""


def verify_signature(pin, envelope, node):
    unsigned = {key: value for key, value in envelope.items() if key != "signature"}
    # This envelope contains ASCII paths and strings only, matching maintained
    # canonical-json.ts byte serialization without numeric/Unicode ambiguities.
    payload = {"pin": pin, "payload": base64.b64encode(canonical(unsigned)).decode(), "signature": envelope["signature"]}
    result = subprocess.run([node, "-e", VERIFY_PUBLIC], input=canonical(payload), capture_output=True,
                            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, timeout=30, check=False)
    require(result.returncode == 0 and result.stdout == b"VERIFIED", "Catalog signature does not verify against the existing public pin")


CATALOG_LEGACY_FIELDS = {"alg", "keyId", "signedAt", "indexHash", "files", "signature"}
CATALOG_DELIVERY_REQUIRED = {"seq", "toolDirs"}
CATALOG_DELIVERY_OPTIONAL = {"catalogScope", "expiresAt", "assetIndexHash", "slimHash", "resources"}
TOOL_ID = re.compile(r"[a-z0-9][a-z0-9-]*\Z", re.I)
HASH_TOOL = re.compile(r"tools/([a-z0-9][a-z0-9-]*)@([0-9a-f]{16})/(.+)\Z", re.I)
HASH_INDEX = re.compile(r"catalog/(tools/index(?:\.slim)?|assets/index)\.([0-9a-f]{16})\.json\Z")


def catalog_envelope(envelope, pin, node):
    """Admit only a verified legacy envelope or the complete delivery extension."""
    require(isinstance(envelope, dict), "Malformed signed catalog")
    fields = set(envelope)
    modern = fields != CATALOG_LEGACY_FIELDS
    require(fields == CATALOG_LEGACY_FIELDS or (CATALOG_LEGACY_FIELDS | CATALOG_DELIVERY_REQUIRED <= fields
            and fields <= CATALOG_LEGACY_FIELDS | CATALOG_DELIVERY_REQUIRED | CATALOG_DELIVERY_OPTIONAL), "Unknown or incomplete catalog envelope fields")
    key_id = base64.urlsafe_b64encode(hashlib.sha256(canonical(pin)).digest()).decode().rstrip("=")
    require(envelope["alg"] == "ECDSA-P256-SHA256" and envelope["keyId"] == key_id
            and isinstance(envelope["signedAt"], str) and re.fullmatch(r"[0-9TZ:.+\-]{20,40}", envelope["signedAt"])
            and isinstance(envelope["signature"], str) and re.fullmatch(r"[A-Za-z0-9_-]{86}", envelope["signature"])
            and isinstance(envelope["files"], dict) and 1 <= len(envelope["files"]) <= MAX_FILES, "Malformed signed catalog")
    sha(envelope["indexHash"])
    # No publication or directory assertion is admitted before cryptographic verification.
    verify_signature(pin, envelope, node)
    if modern:
        require(type(envelope["seq"]) is int and 0 < envelope["seq"] <= 9007199254740991, "Invalid signed catalog sequence")
        require(isinstance(envelope["toolDirs"], dict), "Invalid signed tool directory map")
        if "resources" in envelope:
            resources = envelope["resources"]
            require(isinstance(resources, dict) and len(resources) <= 20000, "Invalid signed resource map")
            for path, expected in resources.items():
                require(isinstance(path, str) and len(path) <= 1024
                        and re.match(r"^/(?:catalog/(?:previews|og)|info/shots)/", path)
                        and not any(c in "\\%?#" or c.isspace() or ord(c) < 32 or 127 <= ord(c) <= 159 for c in path)
                        and all(part not in ("", ".", "..") for part in path[1:].split("/")), "Invalid signed resource path")
                sha(expected)
        if "catalogScope" in envelope:
            sha(envelope["catalogScope"])
        from datetime import datetime, timezone
        try:
            signed_at = datetime.fromisoformat(envelope["signedAt"].replace("Z", "+00:00"))
            require(signed_at.tzinfo is not None, "Signed catalog timestamp requires a timezone")
        except (ValueError, TypeError):
            raise Refusal("Invalid signed catalog timestamp")
        if "expiresAt" in envelope:
            require(isinstance(envelope["expiresAt"], str) and re.fullmatch(r"[0-9TZ:.+\-]{20,40}", envelope["expiresAt"]), "Invalid signed catalog expiry")
            try:
                expires = datetime.fromisoformat(envelope["expiresAt"].replace("Z", "+00:00"))
                require(expires > signed_at and expires > datetime.now(timezone.utc), "Signed catalog expiry precedes its publication or has elapsed")
            except (ValueError, TypeError):
                raise Refusal("Invalid signed catalog timestamps")
    return modern, key_id


def signed_tool_file(path):
    """Match the maintained signer's logical trees and sidecar exclusions."""
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "tools" or not TOOL_ID.fullmatch(parts[1]): return False
    rel = "/".join(parts[2:])
    if rel.startswith("i18n/"): return re.fullmatch(r"i18n/[a-z0-9-]+\.json", rel) is not None
    if rel.startswith("templates/"): return re.fullmatch(r"templates/[A-Za-z0-9._-]+\.json", rel) is not None
    return True


VERIFY_CODINGS = r"""
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream'), { pipeline } = require('node:stream/promises');
const { createGunzip, createBrotliDecompress } = require('node:zlib');
if (Number(process.versions.node.split('.')[0]) < 24) process.exit(2);
let input = '', total = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { input += part; if (Buffer.byteLength(input) > 33554432) process.exit(2); });
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
function open(root, row) {
  const file = path.join(root, row.path);
  if (fs.realpathSync(file) !== file) throw Error('Coding path is not a regular tree leaf');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || (stat.mode & 0o022n) || JSON.stringify(stamp(stat)) !== JSON.stringify(row.stamp)) throw Error('Coding custody changed');
    return { fd, file, row };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function unchanged(item) {
  if (JSON.stringify(stamp(fs.fstatSync(item.fd, { bigint: true }))) !== JSON.stringify(item.row.stamp)
      || JSON.stringify(stamp(fs.lstatSync(item.file, { bigint: true }))) !== JSON.stringify(item.row.stamp)) throw Error('Coding custody changed');
}
process.stdin.on('end', async () => {
  try {
    const value = JSON.parse(input);
    for (const pair of value.pairs) {
      const coding = open(value.root, pair.coding); let identity;
      try {
        identity = open(value.root, pair.identity);
        let encodedSize = 0, decodedSize = 0;
        const encodedHash = crypto.createHash('sha256'), decodedHash = crypto.createHash('sha256');
        const source = fs.createReadStream(null, { fd: coding.fd, autoClose: false });
        const custody = new Transform({ transform(chunk, encoding, callback) {
          encodedSize += chunk.length;
          if (encodedSize > pair.coding.size) return callback(Error('Coding exceeds its encoded size bound'));
          encodedHash.update(chunk); callback(null, chunk);
        } });
        const sink = new Writable({ write(chunk, encoding, callback) {
          decodedSize += chunk.length; total += chunk.length;
          if (decodedSize > pair.identity.size || total > value.maxDecodedBytes) return callback(Error('Coding exceeds its decoded size bound'));
          decodedHash.update(chunk); callback();
        } });
        const decoder = pair.coding.path.endsWith('.gz') ? createGunzip() : createBrotliDecompress();
        await pipeline(source, custody, decoder, sink);
        if (encodedSize !== pair.coding.size || decoder.bytesWritten !== encodedSize || encodedHash.digest('hex') !== pair.coding.sha256
            || decodedSize !== pair.identity.size || decodedHash.digest('hex') !== pair.identity.sha256) throw Error('Coding bytes differ from identity');
        unchanged(coding); unchanged(identity);
      } finally { fs.closeSync(coding.fd); if (identity) fs.closeSync(identity.fd); }
    }
    process.stdout.write('VERIFIED');
  } catch (error) { process.stderr.write(String(error.message).slice(0, 256)); process.exitCode = 1; }
});
"""


def verified_codings(tree, node):
    """Exclude generated codings only after bounded decoding proves identity bytes."""
    codings = {path for path in tree.files if path.endswith((".gz", ".br"))}
    if not codings: return set()
    pairs = []
    for path in sorted(codings):
        identity = path[:-3]
        require(identity in tree.files and identity not in codings, "Orphan or nested compression sibling")
        def row(leaf):
            return {**tree.files[leaf], "stamp": [str(value) for value in tree.identities[leaf]]}
        pairs.append({"coding": row(path), "identity": row(identity)})
    payload = canonical({"root": str(tree.root), "pairs": pairs, "maxDecodedBytes": MAX_BYTES * 2})
    require(len(payload) <= JSON_LIMIT, "Compression verification metadata exceeds its size bound")
    tree.unchanged()
    try:
        result = subprocess.run([node, "-e", VERIFY_CODINGS], input=payload, capture_output=True,
                                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal("Compression sibling verification could not complete")
    require(result.returncode == 0 and result.stdout == b"VERIFIED", "Compression sibling does not decode to its bounded identity: " + result.stderr.decode(errors="replace")[:256])
    tree.unchanged()
    return codings


def delivery_inventory(tree):
    """An inventory is custody metadata, not a signature or an access grant."""
    if "catalog/delivery-manifest.json" not in tree.files: return {}
    value = parse_json(tree.data("catalog/delivery-manifest.json"))
    exact(value, {"version", "files"})
    require(type(value["version"]) is int and value["version"] == 1 and isinstance(value["files"], list)
            and len(value["files"]) <= MAX_FILES, "Invalid catalog delivery inventory")
    result = {}
    for item in value["files"]:
        exact(item, {"path", "size", "sha256"}); path = safe_path(item["path"]); sha(item["sha256"])
        require(path.isascii() and not re.search(r"[\s%?#]", path) and path not in result
                and type(item["size"]) is int and 0 <= item["size"] <= MAX_BYTES, "Unsafe or duplicate catalog delivery entry")
        require(not path.endswith((".gz", ".br")), "Compression sibling is not an identity delivery inventory entry")
        require(HASH_TOOL.fullmatch(path) or re.fullmatch(r"(?:catalog|info/shots)/.+\.[0-9a-f]{16}\.[a-z0-9]{1,12}", path), "Delivery inventory path is not content addressed")
        require(tree.files.get(path) == item, "Catalog delivery inventory differs from physical bytes")
        if not HASH_TOOL.fullmatch(path):
            address = re.search(r"\.([0-9a-f]{16})\.[a-z0-9]{1,12}$", path)
            require(item["sha256"].startswith(address[1]), "Catalog content address differs from physical bytes")
        result[path] = item
    return result


def catalog_content(tree, envelope, modern, previous=None, node="node", shell_only_resources=False):
    """Check every logical signed byte and every actual immutable alias tree."""
    codings = verified_codings(tree, node)
    files, by_tool = envelope["files"], {}
    for path, expected in files.items():
        safe_path(path); sha(expected)
        parts = path.split("/", 1)
        require(path.isascii() and len(parts) == 2 and (not modern or TOOL_ID.fullmatch(parts[0])), "Signed catalog path needs canonical logical tool-relative serialization")
        require(tree.files.get("tools/" + path, {}).get("sha256") == expected, "Signed tool bytes differ from catalog tree")
        by_tool.setdefault(parts[0], {})[parts[1]] = expected
    for path in tree.files:
        if path.startswith("tools/") and path.endswith("/tool.json") and not (modern and HASH_TOOL.fullmatch(path)):
            require(path[6:] in files, "Tool manifest is outside the signed catalog closure")
    if not modern: return
    for path, expected in envelope.get("resources", {}).items():
        # Unaddressed documentation images are served by the verified shell.
        # The derived pack projection separately enforces its exact inventory.
        if shell_only_resources and path.startswith("/info/shots/") and path[1:] not in tree.files:
            continue
        require(tree.files.get(path[1:], {}).get("sha256") == expected, "Signed resource bytes differ from catalog tree")
    require(set(envelope["toolDirs"]) == set(by_tool), "Signed tool directory ids differ from logical files")
    for tool_id, entries in by_tool.items():
        sha(envelope["toolDirs"][tool_id])
        require("tool.json" in entries and digest(entries) == envelope["toolDirs"][tool_id], "Signed tool directory digest differs")
    actual = {path[6:]: row["sha256"] for path, row in tree.files.items() if path not in codings and signed_tool_file(path)}
    require(actual == files, "Logical tool tree is outside the full signed catalog closure")
    for field, path in (("assetIndexHash", "catalog/assets/index.json"), ("slimHash", "catalog/tools/index.slim.json")):
        require((field in envelope) == (path in tree.files), "Signed sidecar hash and actual catalog sibling differ")
        if field in envelope:
            require(sha(envelope[field]) == tree.files[path]["sha256"], "Signed catalog sidecar bytes differ")
    inventory = delivery_inventory(tree)
    prior = delivery_inventory(previous) if previous is not None else {}
    aliases = {}
    for path, row in tree.files.items():
        if path in codings: continue
        matched = HASH_TOOL.fullmatch(path)
        if matched:
            require(path in inventory, "Immutable tool bytes are outside the delivery inventory")
            tool_id, address, rel = matched.groups()
            aliases.setdefault((tool_id, address), {})[rel] = row["sha256"]
        indexed = HASH_INDEX.fullmatch(path)
        if indexed:
            require(path in inventory and row["sha256"].startswith(indexed[2]), "Immutable catalog index differs from delivery inventory")
            field = {"tools/index": "indexHash", "tools/index.slim": "slimHash", "assets/index": "assetIndexHash"}[indexed[1]]
            require(row["sha256"] == envelope.get(field) or prior.get(path) == row, "Retained catalog index lacks previous reviewed custody")
    for tool_id, expected in envelope["toolDirs"].items():
        require((tool_id, expected[:16]) in aliases, "Signed current immutable tool directory is missing")
    for field, path in (("indexHash", "catalog/tools/index"), ("assetIndexHash", "catalog/assets/index"), ("slimHash", "catalog/tools/index.slim")):
        if field in envelope:
            addressed = f"{path}.{envelope[field][:16]}.json"
            require(inventory.get(addressed) == tree.files.get(addressed) and addressed in inventory, "Signed current immutable catalog index is missing")
    for (tool_id, address), entries in aliases.items():
        require(digest(entries).startswith(address) and "tool.json" in entries, "Immutable tool directory differs from its content address")
        if envelope["toolDirs"].get(tool_id, "").startswith(address):
            require(entries == by_tool[tool_id], "Current immutable tool bytes differ from signed logical bytes")
        else:
            prefix = f"tools/{tool_id}@{address}/"
            require(previous is not None and all(prior.get(prefix + rel) == tree.files[prefix + rel] for rel in entries)
                    and {path for path in prior if path.startswith(prefix)} == {prefix + rel for rel in entries}, "Retained immutable tool bytes lack previous reviewed custody")


def catalog(shell, raw, public_pin, expected_public_pin, node, previous=None):
    exact(public_pin, {"kty", "crv", "x", "y"})
    require(public_pin["kty"] == "EC" and public_pin["crv"] == "P-256" and all(isinstance(public_pin[k], str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", public_pin[k]) for k in ("x", "y"))
            and digest(public_pin) == expected_public_pin, "Existing public catalog pin differs")
    envelope = parse_json(shell.data("catalog/tools/index.sig.json"))
    modern, key_id = catalog_envelope(envelope, public_pin, node)
    require(hashlib.sha256(shell.data("catalog/tools/index.json")).hexdigest() == envelope["indexHash"], "Signed catalog index differs")
    require("catalog/tools/index.sig.json" not in raw.files, "Raw Work pack must omit the build-time signature")
    for path in raw.files:
        if path.startswith("tools/") and path.endswith("/tool.json") and not (modern and HASH_TOOL.fullmatch(path)):
            require(path[len("tools/"):] in envelope["files"], "Tool manifest is outside the signed catalog closure")
    for path, expected in envelope["files"].items():
        safe_path(path); sha(expected)
        require(path.isascii() and len(path.split("/")) >= 2, "Signed catalog path needs canonical tool-relative serialization")
        leaf = "tools/" + path
        require(leaf in shell.files and leaf in raw.files and shell.files[leaf]["sha256"] == raw.files[leaf]["sha256"] == expected, "Signed tool bytes differ from shell/raw pack")
    for path, item in raw.files.items():
        if path.startswith(("tools/", "catalog/tools/")):
            require(path in shell.files and item == shell.files[path], "Raw tool/catalog payload differs from compiled private shell")
    require(raw.files.get("catalog/tools/index.json") == shell.files["catalog/tools/index.json"], "Raw catalog index differs")
    catalog_content(shell, envelope, modern, previous, node)
    catalog_content(raw, envelope, modern, previous, node, shell_only_resources=True)
    return {"indexSha256": envelope["indexHash"], "envelopeSha256": shell.files["catalog/tools/index.sig.json"]["sha256"], "keyId": key_id, "signedFiles": len(envelope["files"])}


def retention(candidate, previous, prepared):
    require("index.html" in candidate.files and "index.html" in previous.files and "index.html" in prepared.files, "Shell index is missing")
    merged = dict(candidate.files)
    for path, item in previous.files.items():
        if path.startswith("_app/"):
            require(path not in merged or merged[path] == item, "Retained application path has different bytes")
            merged[path] = item
    require(prepared.files == merged, "Prepared shell must be exactly current content plus prior _app files")


def receipt(value, required, inputs):
    item = inputs.file(value)
    exact(item, required)
    require(type(item.get("version")) is int and item["version"] == 1, "Unknown qualification receipt version")
    return item


def raw_source_stamp(value, inputs, raw, candidate, lolly_root, runner):
    """A derived pack must match independent reviewed custody and exact source bytes."""
    data = parse_json(raw.data(".lolly-pack-source.json"))
    require(isinstance(data, dict), "Malformed raw pack source stamp")
    common = {"version", "source", "commit", "profile", "dirty", "excluded", "removed", "builtAt"}
    modern = type(data.get("version")) is int and data["version"] == 2
    exact(data, common | ({"derivation"} if modern else set()))
    require(type(data["version"]) is int and data["version"] in (1, 2) and data["source"] == "lolly"
            and data["commit"] == value["lolly"]["source"] and data["profile"] == value["profile"] and data["dirty"] is False
            and data["removed"] == ["catalog/tools/index.sig.json"]
            and data["excluded"] == ([] if modern else ["catalog/og", "catalog/previews"]), "Raw pack source stamp differs from clean private source")
    require(("rawDerivation" in value) == modern, "Derived raw pack needs independent release custody; legacy stamps must stay unchanged")
    if not modern: return None
    exact(value["rawDerivation"], {"custody"})
    ref = value["rawDerivation"]["custody"]
    custody = inputs.file(ref)
    exact(custody, {"version", "status", "lollySource", "profile", "manifest", "publicPin", "verifier"})
    require(type(custody["version"]) is int and custody["version"] == 1 and custody["status"] == "SIGNED_LOLLY_RELEASE_REVIEWED"
            and custody["lollySource"] == value["lolly"]["source"] and custody["profile"] == value["profile"], "Raw derivation custody differs from clean source or profile")
    custody_base = local_path(ref["path"], inputs.base).parent
    for name, reviewed in (("manifest", value["candidateShell"]["manifest"]), ("publicPin", value["publicPin"])):
        exact(custody[name], {"path", "sha256"})
        path = local_path(custody[name]["path"], custody_base)
        require(sha(custody[name]["sha256"]) == reviewed["sha256"] and path == local_path(reviewed["path"], inputs.base), "Raw derivation custody differs from reviewed " + name)
        inputs.file({"path": str(path), "sha256": custody[name]["sha256"]})
    exact(custody["verifier"], {"path", "sha256"})
    verifier = "scripts/verify-release-catalog.ts"
    require(custody["verifier"]["path"] == verifier and sha(custody["verifier"]["sha256"])
            == hashlib.sha256(git_bytes(lolly_root, value["lolly"]["source"], verifier, runner)).hexdigest(), "Raw derivation verifier differs from clean source")
    inputs.file({"path": str(lolly_root / verifier), "sha256": custody["verifier"]["sha256"]}, False)
    derivation = data["derivation"]
    exact(derivation, {"kind", "custodySha256", "manifestSha256", "publicPinSha256", "verifierSha256", "indexSha256", "envelopeSha256", "omittedCodingSidecars"})
    require(derivation["kind"] == "verified-signed-release" and derivation["custodySha256"] == ref["sha256"]
            and derivation["manifestSha256"] == candidate.manifest_sha and derivation["publicPinSha256"] == value["publicPin"]["sha256"]
            and derivation["verifierSha256"] == custody["verifier"]["sha256"]
            and derivation["indexSha256"] == candidate.files["catalog/tools/index.json"]["sha256"]
            and derivation["envelopeSha256"] == candidate.files["catalog/tools/index.sig.json"]["sha256"], "Raw derivation stamp differs from independent reviewed release bytes")
    codings = {path for path in candidate.files if path.endswith((".gz", ".br"))}
    require(type(derivation["omittedCodingSidecars"]) is int and derivation["omittedCodingSidecars"] == len(codings), "Raw derivation coding count differs from reviewed release")
    require(isinstance(data["builtAt"], str) and re.fullmatch(r"[0-9TZ:.+\-]{20,40}", data["builtAt"]), "Invalid derived raw pack build timestamp")
    from datetime import datetime
    try:
        require(datetime.fromisoformat(data["builtAt"].replace("Z", "+00:00")).tzinfo is not None, "Derived raw pack timestamp needs a timezone")
    except ValueError:
        raise Refusal("Invalid derived raw pack build timestamp")
    require("seq" in parse_json(candidate.data("catalog/tools/index.sig.json")), "Derived raw pack needs a modern verified release")
    inventory = delivery_inventory(candidate)
    expected = {path: row for path, row in candidate.files.items()
                if path not in codings and path != "catalog/tools/index.sig.json"
                and (path.startswith(("tools/", "catalog/")) or path in inventory)}
    require({path: row for path, row in raw.files.items() if path != ".lolly-pack-source.json"} == expected, "Derived raw pack differs from the exact reviewed identity projection")
    return copy.deepcopy(derivation)


def previous_record(ref, inputs):
    """Read the original matched or split-source acceptance without rewriting it."""
    previous = inputs.file(ref)
    if isinstance(previous, dict) and "shellSource" in previous:
        spec = importlib.util.spec_from_file_location("cohort_previous_shell", Path(__file__).with_name("prepare-private-shell.py"))
        shell = importlib.util.module_from_spec(spec); spec.loader.exec_module(shell)
        try:
            previous, before = shell.previous_record(ref, inputs)
        except shell.Refusal as error:
            raise Refusal(str(error)) from error
        old_pin, old_resolver = inputs.file(previous["enginePin"]), inputs.file(previous["resolverPin"])
        require(old_pin.get("generatedFrom") == previous["engineSource"] and old_resolver.get("commit") == previous["engineSource"], "Previous split engine/resolver source differs")
        return previous, before
    exact(previous, {"version", "deployment", "deploymentSpecSha256", "lollySource", "workSource", "image", "enginePin", "shell", "pack", "pin", "acceptance"})
    require(type(previous["version"]) is int and previous["version"] == 1, "Unknown previous cohort")
    before = inputs.file(previous["deployment"])
    exact(before, {"apiVersion", "kind", "metadata", "spec"})
    require(before["apiVersion"] == "apps/v1" and before["kind"] == "Deployment" and digest(before["spec"]) == sha(previous["deploymentSpecSha256"]), "Previous protected Deployment differs")
    exact(before["metadata"], {"name", "namespace", "uid", "resourceVersion"})
    for key in ("name", "namespace"):
        require(isinstance(before["metadata"][key], str) and NAME.fullmatch(before["metadata"][key]), "Invalid owning Deployment identity")
    require(all(isinstance(before["metadata"][key], str) and 1 <= len(before["metadata"][key]) <= 128 for key in ("uid", "resourceVersion")), "Missing current UID/resourceVersion guard")
    for key in ("lollySource", "workSource"):
        commit(previous[key])
    paired.updater.image_ref(previous["image"])
    old_pin = inputs.file(previous["enginePin"])
    require(old_pin.get("generatedFrom") == previous["lollySource"], "Previous engine source differs")
    for family in ("shell", "pack", "pin"):
        exact(previous[family], {"name", "uid"} | ({"manifestSha256", "releaseId"} if family == "shell" else {"manifestSha256"} if family == "pack" else {"sha256"}))
        require(isinstance(previous[family]["name"], str) and NAME.fullmatch(previous[family]["name"]) and isinstance(previous[family]["uid"], str) and previous[family]["uid"], "Missing previous claim/pin identity")
    require(previous["pin"]["sha256"] == previous["enginePin"]["sha256"], "Previous pin custody differs")
    sha(previous["pack"]["manifestSha256"])
    acceptance = receipt(previous["acceptance"], {"version", "status", "deploymentUID", "deploymentSpecSha256", "lollySource", "workSource", "image", "enginePinSha256", "shellManifestSha256", "packManifestSha256", "originalEvidence"}, inputs)
    require(acceptance["status"] == "RUNTIME_ACCEPTED" and acceptance["deploymentUID"] == before["metadata"]["uid"]
            and acceptance["deploymentSpecSha256"] == previous["deploymentSpecSha256"] and acceptance["lollySource"] == previous["lollySource"]
            and acceptance["workSource"] == previous["workSource"] and acceptance["image"] == previous["image"] and acceptance["enginePinSha256"] == previous["pin"]["sha256"]
            and acceptance["shellManifestSha256"] == previous["shell"]["manifestSha256"] and acceptance["packManifestSha256"] == previous["pack"]["manifestSha256"], "Previous acceptance does not bind the actual old cohort")
    require(isinstance(acceptance["originalEvidence"], list) and 2 <= len(acceptance["originalEvidence"]) <= 16, "Missing prior runtime/HTTPS evidence")
    for item in acceptance["originalEvidence"]:
        inputs.file(item, False)
    return previous, before


def prepare(value, base, expected_public_pin, node="node", runner=git_command):
    exact(value, EVIDENCE_KEYS | ({"rawDerivation"} if isinstance(value, dict) and "rawDerivation" in value else set()))
    require(type(value["version"]) is int and value["version"] == 1, "Unsupported private cohort evidence")
    inputs = Inputs(base)
    lolly_root, lolly_run = source_record(value["lolly"], inputs, runner, "lolly")
    work_root, work_run = source_record(value["work"], inputs, runner, "work")
    pin, resolver = inputs.file(value["enginePin"]), inputs.file(value["resolverPin"])
    require(git_bytes(work_root, value["work"]["source"], "engine-pin.json", runner) == read_file(local_path(value["enginePin"]["path"], base))[0]
            and git_bytes(work_root, value["work"]["source"], "content-resolver-pin.json", runner) == read_file(local_path(value["resolverPin"]["path"], base))[0], "Reviewed pin bytes differ from Work source")
    source_pins(pin, resolver, value["lolly"], value["work"], runner)
    exact(value["brand"], {"path", "commit"})
    brand_path, brand_commit = safe_path(value["brand"]["path"]), commit(value["brand"]["commit"])
    require(brand_path.startswith("brands/") and runner(["git", "ls-tree", value["lolly"]["source"], "--", brand_path], lolly_root).strip().split()
            == ["160000", "commit", brand_commit, brand_path], "Private brand commit differs from source")
    require(isinstance(value["profile"], str) and NAME.fullmatch(value["profile"]) and value["profile"] not in {"community", "neutral", "public"}, "Profile must explicitly identify private content")
    candidate, previous_shell, shell, raw = [Tree(value[key], inputs) for key in ("candidateShell", "previousShell", "shell", "rawPack")]
    roots = [tree.root for tree in inputs.trees]
    require(len(set(roots)) == 4 and all(a not in b.parents for a in roots for b in roots if a != b), "Private input trees must be distinct and non-overlapping")
    retention(candidate, previous_shell, shell)
    actual_catalog = catalog(shell, raw, inputs.file(value["publicPin"]), sha(expected_public_pin), node, previous_shell)
    raw_derivation = raw_source_stamp(value, inputs, raw, candidate, lolly_root, runner)
    build = receipt(value["build"], {"version", "status", "lollySource", "workSource", "brandCommit", "profile", "enginePinSha256", "shellManifestSha256", "settings", "workspaceModules", "originalReport"}, inputs)
    require(build["status"] == "PRIVATE_WEB_BUILD_REVIEWED" and build["lollySource"] == value["lolly"]["source"] and build["workSource"] == value["work"]["source"]
            and build["brandCommit"] == brand_commit and build["profile"] == value["profile"] and build["enginePinSha256"] == value["enginePin"]["sha256"]
            and build["shellManifestSha256"] == candidate.manifest_sha, "Private build custody differs from candidate/source/pin")
    exact(build["settings"], {"scope", "requireCatalogSignature", "requireAiPolicy", "relayOrigin"})
    require(build["settings"]["scope"] == "web" and build["settings"]["requireCatalogSignature"] is True and build["settings"]["requireAiPolicy"] is True
            and isinstance(build["settings"]["relayOrigin"], str) and re.fullmatch(r"https://[a-z0-9.-]+(?::[0-9]{1,5})?/live", build["settings"]["relayOrigin"]), "Private build settings differ from verified web policy")
    require(isinstance(build["workspaceModules"], list) and 1 <= len(build["workspaceModules"]) <= 5000, "Missing source-bound workspace compilation evidence")
    modules = set()
    for module in build["workspaceModules"]:
        exact(module, {"path", "sha256"}); path = safe_path(module["path"]); sha(module["sha256"])
        require(path not in modules and path.startswith(("engine/", "packages/core/", "packages/node-shell/", "packages/rondo/", "packages/audio-dock/"))
                and hashlib.sha256(git_bytes(lolly_root, value["lolly"]["source"], path, runner)).hexdigest() == module["sha256"], "Workspace module differs from exact frontend source")
        modules.add(path)
    inputs.file(build["originalReport"], False)
    gate = receipt(value["webGate"], {"version", "status", "source", "scope", "scriptSha256", "originalReport"}, inputs)
    require(gate["status"] == "PASS" and gate["source"] == value["lolly"]["source"] and gate["scope"] == "web"
            and gate["scriptSha256"] == hashlib.sha256(git_bytes(lolly_root, value["lolly"]["source"], "scripts/webgpu-release-gate.ts", runner)).hexdigest(), "Web-only release gate custody differs")
    inputs.file(gate["originalReport"], False)
    inspection = receipt(value["inspection"], {"version", "lollySource", "workSource", "enginePinSha256", "packManifestSha256", "report"}, inputs)
    require(inspection["lollySource"] == value["lolly"]["source"] and inspection["workSource"] == value["work"]["source"]
            and inspection["enginePinSha256"] == value["enginePin"]["sha256"] and inspection["packManifestSha256"] == raw.manifest_sha, "Pack inspection custody differs")
    report = inputs.file(inspection["report"])
    exact(report, {"version", "engine", "compatible", "source", "revision", "tools", "diagnostics"})
    index = parse_json(raw.data("catalog/tools/index.json"))
    require(isinstance(index, dict) and isinstance(index.get("tools"), list) and 1 <= len(index["tools"]) <= 2000, "Malformed private tool index")
    tool_ids = [item.get("id") if isinstance(item, dict) else item for item in index["tools"]]
    require(all(isinstance(i, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", i) for i in tool_ids) and len(set(tool_ids)) == len(tool_ids), "Invalid private tool identity")
    require(type(report["version"]) is int and report["version"] == 1 and report["compatible"] is True and report["engine"] == pin["engine"]["version"]
            and report["source"] == "mounted" and isinstance(report["revision"], str) and SHA.fullmatch(report["revision"])
            and report["diagnostics"] == [] and isinstance(report["tools"], list) and len(report["tools"]) == len(tool_ids), "Pack is not compatible with the exact private engine")
    seen = set()
    for tool in report["tools"]:
        exact(tool, {"source", "id", "valid", "serverFormats", "unavailableFormats", "diagnostics", "sourceHash"}, {"requiredEngine"})
        require(tool["id"] in tool_ids and tool["id"] not in seen and tool["source"] == "mounted" and tool["valid"] is True
                and isinstance(tool["serverFormats"], list) and isinstance(tool["unavailableFormats"], list) and isinstance(tool["diagnostics"], list), "Pack tool inspection is incomplete")
        sha(tool["sourceHash"]); seen.add(tool["id"])
    archive = inputs.file(value["workArtifact"], False)
    metadata = inputs.file(value["workArtifactMetadata"])
    with archive.open("rb") as stream:
        paired.artifact_record(metadata, work_run, "qualified-server-" + value["work"]["source"], stream)
        image_digest = paired.work_image(stream, value["work"]["source"], pin)
    paired.updater.image_ref(value["expectedWorkImage"])
    require(value["expectedWorkImage"].split("@")[-1] == image_digest, "Expected server image differs from verified OCI")
    previous, before = previous_record(value["previous"], inputs)
    require(previous["shell"]["manifestSha256"] == previous_shell.manifest_sha and previous["shell"]["releaseId"] == previous_shell.shell_id,
            "Previous shell custody differs")
    spec, patch, rollback = change_tuple(before, previous, value["selection"], value["expectedWorkImage"], value["lolly"]["source"])
    for source in (value["lolly"], value["work"]):
        require(runner(["git", "rev-parse", "HEAD"], Path(source["root"])) == source["source"] and runner(["git", "status", "--porcelain"], Path(source["root"])) == "", "Source changed during preparation")
    inputs.unchanged()
    return {"version": 1, "status": STATUS, "sources": {"lolly": value["lolly"]["source"], "work": value["work"]["source"], "brand": brand_commit},
            "normalCI": {"lolly": {"run": lolly_run["id"], "attempt": lolly_run["run_attempt"]}, "work": {"run": work_run["id"], "attempt": work_run["run_attempt"]}},
            "image": value["expectedWorkImage"], "profile": value["profile"], "enginePinSha256": value["enginePin"]["sha256"], "resolverPinSha256": value["resolverPin"]["sha256"],
            "shell": {"manifestSha256": shell.manifest_sha, "releaseId": shell.shell_id, "files": len(shell.files)}, "rawPack": {"manifestSha256": raw.manifest_sha, "files": len(raw.files), **({"derivation": raw_derivation} if raw_derivation else {})},
            "catalog": actual_catalog, "previousCohortSha256": value["previous"]["sha256"], "beforeSpecSha256": previous["deploymentSpecSha256"], "desiredSpecSha256": digest(spec),
            "desiredSpec": spec, "guardedPatchTemplate": patch, "inverseTupleTemplate": rollback,
            "allUnselectedSpecFieldsPreserved": True, "evidence": [{"path": str(path), "sha256": expected} for path, (_, expected) in sorted(inputs.reads.items())],
            "qualificationBoundary": {"localReviewedEvidence": True, "originAuthenticatedByThisCommand": False, "ociSignatureClaimed": False,
                                      "privateShellSignatureClaimed": False, "runtimeQualified": False, "productionMutation": False, "buildOrSigningPerformed": False},
            "requiredBeforeApply": ["Fresh target/Deployment UID+resourceVersion and full before-spec readback", "New isolated claim UIDs, Bound state, complete target hashes and no active serving-PVC mounts in staging",
                                    "Immutable pin ConfigMap raw bytes and verified image import", "Exact isolated runtime and stage retirement/unmount proof", "Reviewed server dry run and atomic patch with fresh guards",
                                    "Owning-runtime/TLS/export/agent/reconnect acceptance; retain data-compatible rollback and original failures"]}, inputs


def change_tuple(before, previous, selection, image, source):
    exact(selection, {"container", "shellVolume", "packVolume", "pinVolume", "shellClaim", "packClaim", "pinConfigMap", "provenance"})
    for key in set(selection) - {"provenance"}:
        require(isinstance(selection[key], str) and NAME.fullmatch(selection[key]), "Invalid selected cohort name")
    require(len({selection[key] for key in ("shellVolume", "packVolume", "pinVolume")}) == 3 and selection["shellClaim"] != selection["packClaim"]
            and all(selection[new] != previous[old]["name"] for new in ("shellClaim", "packClaim") for old in ("shell", "pack"))
            and selection["pinConfigMap"] != previous["pin"]["name"], "Candidate claims/pin must be new and distinct")
    spec = copy.deepcopy(before["spec"])
    pod = spec.get("template", {}).get("spec", {})
    replicas = spec.get("replicas", 1)
    require(type(replicas) is int and replicas == 1 and spec.get("strategy", {}).get("type") == "Recreate"
            and isinstance(pod.get("containers"), list) and isinstance(pod.get("volumes"), list), "Cohort needs existing single-owner Recreate storage")
    for family in ("containers", "initContainers", "volumes"):
        items = pod.get(family, [])
        require(isinstance(items, list) and all(isinstance(item, dict) and isinstance(item.get("name"), str) for item in items)
                and len({item["name"] for item in items}) == len(items), "Duplicate or invalid Pod resource names")
    servers = [(i, c) for i, c in enumerate(pod["containers"]) if c["name"] == selection["container"]]
    require(len(servers) == 1 and servers[0][1].get("image") == previous["image"], "Selected previous server image differs")
    i, server = servers[0]
    edits = [(f"/spec/template/spec/containers/{i}/image", server, "image", image)]
    mounts = server.get("volumeMounts", [])
    require(isinstance(mounts, list) and all(isinstance(m, dict) and isinstance(m.get("name"), str) for m in mounts)
            and len({m["name"] for m in mounts}) == len(mounts), "Duplicate or invalid serving mounts")
    for family, selected, field, leaf in (("shell", "shellVolume", "persistentVolumeClaim", "claimName"), ("pack", "packVolume", "persistentVolumeClaim", "claimName"), ("pin", "pinVolume", "configMap", "name")):
        name = selection[selected]
        candidates = [(index, volume) for index, volume in enumerate(pod["volumes"]) if volume["name"] == name]
        require(len(candidates) == 1, "Selected volume is missing")
        index, volume = candidates[0]
        require(set(volume) == {"name", field} and isinstance(volume[field], dict) and volume[field].get(leaf) == previous[family]["name"], "Previous mounted tuple differs")
        matching_mounts = [mount for mount in mounts if mount["name"] == name]
        require(len(matching_mounts) == 1 and matching_mounts[0].get("readOnly") is True, "Serving shell/pack/pin mount must be read-only")
        new = selection[{"shell": "shellClaim", "pack": "packClaim", "pin": "pinConfigMap"}[family]]
        edits.append((f"/spec/template/spec/volumes/{index}/{field}/{leaf}", volume[field], leaf, new))
    selected_volumes = {selection[key] for key in ("shellVolume", "packVolume", "pinVolume")}
    for container in [*pod["containers"], *pod.get("initContainers", [])]:
        if container is server:
            continue
        require(not any(mount.get("name") in selected_volumes for mount in container.get("volumeMounts", [])), "Selected content must have one serving owner and no init writer")
    provenance = selection["provenance"]
    require(isinstance(provenance, dict) and set(provenance) <= {"lolly.tools/engine-source", "lolly.tools/shell-source"}
            and all(value == source for value in provenance.values()), "Only explicit existing source annotations can change")
    annotations = spec.get("template", {}).get("metadata", {}).get("annotations", {})
    for key, value in sorted(provenance.items()):
        require(key in annotations and isinstance(annotations[key], str), "Selected provenance annotation must already exist")
        escaped = key.replace("~", "~0").replace("/", "~1")
        edits.append(("/spec/template/metadata/annotations/" + escaped, annotations, key, value))
    patch = [{"op": "test", "path": "/metadata/uid", "value": before["metadata"]["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": before["metadata"]["resourceVersion"]},
             {"op": "test", "path": "/spec", "value": before["spec"]}]
    inverse, restores = [], []
    for path, target, key, new in edits:
        old = copy.deepcopy(target[key])
        patch += [{"op": "test", "path": path, "value": old}, {"op": "replace", "path": path, "value": new}]
        inverse.append({"path": path, "expectedValue": new, "restoreValue": old})
        restores.append((target, key, old)); target[key] = new
    result = copy.deepcopy(spec)
    for target, key, old in restores:
        target[key] = old
    require(spec == before["spec"], "Unselected Deployment fields changed")
    # The inverse is intentionally not executable: after-UID/RV/spec guards and
    # database compatibility need a new read/review after actual publication.
    return result, patch, {"status": "REFERENCE_ONLY_REQUIRES_FRESH_AFTER_GUARDS_AND_DATA_COMPATIBILITY", "fields": inverse}


def publish(value, out, inputs):
    require(out.is_absolute() and not out.exists() and not out.is_symlink() and out.parent.resolve(strict=True) == out.parent, "Output must be an absent path under a canonical existing directory")
    for path in [*inputs.reads, *inputs.source_roots, *(tree.root for tree in inputs.trees)]:
        require(out != path and out not in path.parents and path not in out.parents, "Output overlaps an input")
    parent = stamp(out.parent.lstat())
    require(stat.S_ISDIR(out.parent.lstat().st_mode) and not out.parent.lstat().st_mode & 0o022, "Output parent must not be writable by others")
    inputs.unchanged()
    require(stamp(out.parent.lstat()) == parent, "Output parent changed")
    os.mkdir(out, 0o700)
    ownership = stamp(out.lstat())[:2]
    try:
        path = out / "cohort.prepared.json"
        partial = out / ".cohort.partial"
        data = canonical(value) + b"\n"
        require(len(data) <= JSON_LIMIT * 2, "Prepared output exceeds its bound")
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(data); stream.flush(); os.fsync(fd)
        finally:
            os.close(fd)
        inputs.unchanged()
        require(stamp(out.lstat())[:2] == ownership and read_file(partial, JSON_LIMIT * 2)[0] == data, "Prepared output custody changed")
        os.link(partial, path, follow_symlinks=False)
        partial.unlink()
        directory_fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return hashlib.sha256(data).hexdigest()
    except Exception:
        # Never remove an uncertain/replaced path. A partial directory is not a
        # qualified result; preserve it for review, and refuse automatic replay.
        raise Refusal("Preparation failed after exclusive output creation; retain partial output and review before retry") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--reviewed-evidence-sha256", required=True)
    parser.add_argument("--existing-public-pin-sha256", required=True, help="Canonical SHA256 of the separately reviewed public P-256 JWK")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--node", default="node", help="Existing Node 24+ executable; no installation is performed")
    args = parser.parse_args()
    try:
        path = local_path(args.evidence, Path.cwd())
        data, identity = read_file(path)
        require(hashlib.sha256(data).hexdigest() == sha(args.reviewed_evidence_sha256), "Preparation evidence differs from review")
        result, inputs = prepare(parse_json(data), path.parent, sha(args.existing_public_pin_sha256), args.node)
        inputs.reads[path] = (identity, args.reviewed_evidence_sha256)
        result["evidence"].append({"path": str(path), "sha256": args.reviewed_evidence_sha256})
        result["evidence"].sort(key=lambda item: item["path"])
        result["reviewedEvidenceSha256"] = args.reviewed_evidence_sha256
        output_sha = publish(result, Path(os.path.abspath(args.out_dir)), inputs)
        print(json.dumps({"status": STATUS, "cohortSha256": output_sha, "runtimeQualified": False, "productionMutation": False}, sort_keys=True))
        return 0
    except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, paired.zipfile.BadZipFile, paired.tarfile.TarError):
        # Never echo protected API/config/build bodies, paths or subprocess logs.
        print(json.dumps({"status": "REFUSED", "reason": "Offline cohort custody or protected change refused; retain inputs and any partial output for review", "runtimeQualified": False, "productionMutation": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
