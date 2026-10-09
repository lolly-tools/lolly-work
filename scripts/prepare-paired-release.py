#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Prepare image release input from reviewed offline CI custody, without deployment."""
from __future__ import annotations

import argparse
import hashlib
import gzip
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import zipfile

# The preparation helper must not dirty the qualified checkout with bytecode.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("app_update", Path(__file__).with_name("app-update.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
Refusal = updater.Refusal
require = updater.require
exact = updater.exact_keys
SHA = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
LIMIT = 2 * 1024 * 1024
ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
RUN_FIELDS = set("id name node_id head_branch head_sha path display_title run_number event status conclusion workflow_id check_suite_id check_suite_node_id url html_url pull_requests created_at updated_at actor run_attempt referenced_workflows run_started_at triggering_actor jobs_url logs_url check_suite_url artifacts_url cancel_url rerun_url previous_attempt_url workflow_url head_commit repository head_repository".split())
JOB_FIELDS = set("id run_id run_url run_attempt node_id head_sha url html_url status conclusion created_at started_at completed_at name steps check_run_url labels runner_id runner_name runner_group_id runner_group_name workflow_name head_branch".split())
ARTIFACT_FIELDS = set("id node_id name size_in_bytes url archive_download_url expired created_at updated_at expires_at digest workflow_run".split())
REPO_FIELDS = set("id node_id name full_name owner private html_url description fork url forks_url keys_url collaborators_url teams_url hooks_url issue_events_url events_url assignees_url branches_url tags_url blobs_url git_tags_url git_refs_url trees_url statuses_url languages_url stargazers_url contributors_url subscribers_url subscription_url commits_url git_commits_url comments_url issue_comment_url contents_url compare_url merges_url archive_url downloads_url issues_url pulls_url milestones_url notifications_url labels_url releases_url deployments_url".split())


def stream_hash(source, maximum=ARCHIVE_LIMIT):
    digest, total = hashlib.sha256(), 0
    source.seek(0)
    for block in iter(lambda: source.read(1024 * 1024), b""):
        total += len(block)
        require(total <= maximum, "Input exceeds its size bound")
        digest.update(block)
    source.seek(0)
    return digest.hexdigest()


def hashed(path, maximum=ARCHIVE_LIMIT):
    with open(path, "rb") as source:
        return stream_hash(source, maximum)


def json_bytes(data):
    require(len(data) <= LIMIT, "JSON exceeds its size bound")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Duplicate JSON key")
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refusal("Non-finite JSON number")))


def file_input(value, base, as_json=True):
    exact(value, {"path", "sha256"})
    require(isinstance(value["path"], str) and value["path"] and "\x00" not in value["path"], "Invalid evidence path")
    require(isinstance(value["sha256"], str) and SHA.fullmatch(value["sha256"]), "Invalid evidence hash")
    path = Path(value["path"])
    path = path if path.is_absolute() else base / path
    require(path.is_file() and not path.is_symlink(), "Evidence must be a regular local file")
    if as_json:
        with open(path, "rb") as source:
            data = source.read(LIMIT + 1)
        require(len(data) <= LIMIT and hashlib.sha256(data).hexdigest() == value["sha256"], "Evidence bytes differ from review")
        return json_bytes(data)
    require(hashed(path) == value["sha256"], "Evidence bytes differ from review")
    return path


def positive(value):
    return type(value) is int and 0 < value <= 9007199254740991


def repository(value, expected):
    exact(value, {"full_name", "id"}, REPO_FIELDS - {"full_name", "id"})
    require(value["full_name"] == expected and positive(value["id"]), "Wrong CI repository")


def run_record(value, source, repo, workflow, event):
    required = {"id", "run_attempt", "head_sha", "head_branch", "repository", "head_repository", "path", "event", "status", "conclusion"}
    exact(value, required, RUN_FIELDS - required)
    require(positive(value["id"]) and positive(value["run_attempt"]), "Invalid CI run/attempt")
    require(value["head_sha"] == source and value["head_branch"] == "main" and value["path"] == workflow and value["event"] == event
            and value["status"] == "completed" and value["conclusion"] == "success", "Source is not qualified by this exact CI run")
    repository(value["repository"], repo)
    repository(value["head_repository"], repo)
    return value


def jobs_record(value, run, allow_shell_skip=False, required_names=(), allowed_skips=()):
    exact(value, {"total_count", "jobs"})
    jobs = value["jobs"]
    require(isinstance(jobs, list) and 1 <= len(jobs) <= 100 and type(value["total_count"]) is int and value["total_count"] == len(jobs), "Incomplete CI jobs")
    ids, names, successes, skips = set(), {}, 0, 0
    for job in jobs:
        required = {"id", "run_id", "name", "status", "conclusion"}
        exact(job, required, JOB_FIELDS - required)
        require(positive(job["id"]) and job["id"] not in ids and job["run_id"] == run["id"]
                and positive(job["run_id"]) and ("run_attempt" not in job or (positive(job["run_attempt"]) and job["run_attempt"] == run["run_attempt"]))
                and ("head_sha" not in job or job["head_sha"] == run["head_sha"]), "Job differs from CI run/attempt")
        require(isinstance(job["name"], str) and 1 <= len(job["name"]) <= 256 and job["status"] == "completed", "Malformed CI job")
        success = job["conclusion"] == "success"
        skipped = job["conclusion"] == "skipped" and ((allow_shell_skip and job["name"] == "verified instance shell") or job["name"] in allowed_skips)
        require(success or skipped, "CI job did not qualify")
        ids.add(job["id"])
        names[job["name"]] = names.get(job["name"], 0) + 1
        successes += int(success)
        skips += int(skipped)
    require(successes > 0 and (not allow_shell_skip or skips <= 1) and all(names.get(name) == 1 and any(job["name"] == name and job["conclusion"] == "success" for job in jobs) for name in required_names), "Missing or duplicate required CI job")


def artifact_record(value, run, name, stream):
    required = {"id", "name", "size_in_bytes", "expired", "digest", "workflow_run"}
    exact(value, required, ARTIFACT_FIELDS - required)
    exact(value["workflow_run"], {"id", "repository_id", "head_repository_id", "head_branch", "head_sha"})
    require(positive(value["id"]) and positive(value["size_in_bytes"]) and value["expired"] is False and value["name"] == name,
            "Wrong or unavailable CI artifact")
    origin = value["workflow_run"]
    require(positive(origin["id"]) and origin["id"] == run["id"] and origin["head_sha"] == run["head_sha"] and origin["head_branch"] == "main"
            and positive(origin["repository_id"]) and origin["repository_id"] == origin["head_repository_id"] == run["repository"]["id"] == run["head_repository"]["id"], "Artifact differs from CI source/run")
    require(value["size_in_bytes"] == os.fstat(stream.fileno()).st_size and value["digest"] == "sha256:" + stream_hash(stream), "Artifact ZIP differs from authenticated custody")


def command(argv, cwd):
    result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    reason = "Frontend release gate refused; publish the qualified supported-environment matrix before preparing a web release" if argv == ["node", "scripts/webgpu-release-gate.ts"] else "Vendored engine verification failed; qualify and preserve the private engine/core/schema pin" if argv == ["node", "scripts/verify-engine-pin.ts"] else "Read-only Git source verification failed"
    require(result.returncode == 0 and len(result.stdout) <= LIMIT, reason)
    return result.stdout.decode().strip()


def source_record(value, base, runner):
    exact(value, {"root", "source", "repository", "main", "ciRun", "ciJobs"})
    require(isinstance(value["source"], str) and COMMIT.fullmatch(value["source"]) and isinstance(value["repository"], str) and REPO.fullmatch(value["repository"]), "Invalid source identity")
    require(isinstance(value["root"], str), "Invalid source checkout path")
    root = Path(value["root"])
    require(root.is_absolute() and root.is_dir(), "Source checkout must be an absolute local directory")
    require(runner(["git", "rev-parse", "HEAD"], root) == value["source"] and runner(["git", "status", "--porcelain"], root) == "", "Checkout is dirty or differs from the qualified source")
    main = file_input(value["main"], base)
    exact(main, {"ref", "object"}, {"node_id", "url"})
    exact(main["object"], {"type", "sha"}, {"url"})
    require(main["ref"] == "refs/heads/main" and main["object"]["type"] == "commit" and main["object"]["sha"] == value["source"], "Qualified source is stale against reviewed main")
    run = run_record(file_input(value["ciRun"], base), value["source"], value["repository"], ".github/workflows/ci.yml", "push")
    jobs_record(file_input(value["ciJobs"], base), run, allow_shell_skip=True)
    return root, run


def zip_inputs(path, names):
    archive = zipfile.ZipFile(path)
    entries = archive.infolist()
    require(len(entries) == len(names) and {item.filename for item in entries} == set(names) and len({item.filename for item in entries}) == len(entries), "Unexpected artifact members")
    for item in entries:
        require(not item.is_dir() and not item.flag_bits & 1 and item.file_size <= (ARCHIVE_LIMIT if item.filename == "server.oci.tar" else LIMIT) and (item.external_attr >> 16) & 0o170000 != 0o120000,
                "Unsafe or oversized artifact member")
    return archive


def work_image(path, source, expected_pin):
    with zip_inputs(path, {"server.oci.tar", "server.oci.tar.sha256", "server-image.json"}) as archive:
        image = json_bytes(archive.read("server-image.json"))
        require(isinstance(image, dict) and image.get("Os") == "linux" and image.get("Architecture") == "amd64"
                and image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision") == source, "Work image inspection differs from source/platform")
        checksum = archive.read("server.oci.tar.sha256").decode()
        require(re.fullmatch(r"[0-9a-f]{64}  [^\r\n]+\n?", checksum) is not None, "Malformed Work archive checksum")
        with archive.open("server.oci.tar") as stream:
            h = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
            require(checksum[:64] == h.hexdigest(), "Work OCI archive checksum differs")
        with archive.open("server.oci.tar") as stream, tarfile.open(fileobj=stream, mode="r:") as oci:
            members, seen = {}, set()
            for member in oci:
                require(len(seen) < 512, "OCI has too many members")
                name = member.name.removeprefix("./")
                require(name not in seen and not member.issym() and not member.islnk() and not member.isdev()
                        and not name.startswith("/") and ".." not in name.split("/"), "Unsafe or duplicate OCI member")
                seen.add(name)
                if member.isdir():
                    require(name in {".", "blobs", "blobs/sha256"}, "Unknown OCI directory")
                    continue
                require(member.isfile() and (name in {"index.json", "oci-layout"} or re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name)), "Unknown OCI member")
                members[name] = member
            def read(name):
                require(name in members and members[name].size <= LIMIT, "Missing or oversized OCI metadata")
                return oci.extractfile(members[name]).read()
            require(json_bytes(read("oci-layout")) == {"imageLayoutVersion": "1.0.0"}, "Unknown OCI layout")
            index = json_bytes(read("index.json"))
            exact(index, {"schemaVersion", "manifests"}, {"mediaType", "annotations"})
            require(type(index["schemaVersion"]) is int and index["schemaVersion"] == 2 and isinstance(index.get("manifests"), list) and len(index["manifests"]) == 1, "Ambiguous OCI index")
            used = {"index.json", "oci-layout"}
            def descriptor(value):
                exact(value, {"digest", "size"}, {"mediaType", "annotations", "platform"})
                require(isinstance(value.get("digest"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value["digest"])
                        and type(value.get("size")) is int and 0 <= value["size"] <= ARCHIVE_LIMIT, "Invalid OCI descriptor")
                name = "blobs/sha256/" + value["digest"][7:]
                require(name in members and members[name].size == value["size"], "OCI descriptor size differs")
                h = hashlib.sha256()
                with oci.extractfile(members[name]) as blob:
                    for block in iter(lambda: blob.read(1024 * 1024), b""):
                        h.update(block)
                require(h.hexdigest() == value["digest"][7:], "OCI blob digest differs")
                used.add(name)
                return name
            top = index["manifests"][0]
            manifest = json_bytes(read(descriptor(top)))
            if "manifests" in manifest:
                exact(manifest, {"schemaVersion", "manifests"}, {"mediaType", "annotations"})
                require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 2 and len(manifest["manifests"]) == 1, "Ambiguous platform manifest")
                child = manifest["manifests"][0]
                require(child.get("platform", {}).get("os") == "linux" and child.get("platform", {}).get("architecture") == "amd64", "Wrong OCI platform")
                manifest = json_bytes(read(descriptor(child)))
            exact(manifest, {"schemaVersion", "config", "layers"}, {"mediaType", "annotations"})
            require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 2 and isinstance(manifest.get("layers"), list) and 1 <= len(manifest["layers"]) <= 128, "Unsupported OCI manifest")
            config_descriptor = manifest.get("config")
            config = json_bytes(read(descriptor(config_descriptor)))
            exact(config, {"architecture", "os", "config", "rootfs"}, {"created", "author", "history", "variant"})
            exact(config["rootfs"], {"type", "diff_ids"})
            require(config["rootfs"]["type"] == "layers" and isinstance(config["rootfs"]["diff_ids"], list) and len(config["rootfs"]["diff_ids"]) == len(manifest["layers"]) and all(isinstance(item, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", item) for item in config["rootfs"]["diff_ids"]), "Invalid OCI layer contract")
            require(config.get("os") == "linux" and config.get("architecture") == "amd64" and config_descriptor["digest"] == image.get("Id")
                    and config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") == source, "Work OCI differs from inspected image/source")
            actual_pin = None
            for index, layer in enumerate(manifest["layers"]):
                name = descriptor(layer)
                media = layer.get("mediaType", "application/vnd.oci.image.layer.v1.tar")
                require(media in {"application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar", "application/vnd.docker.image.rootfs.diff.tar.gzip"}, "Unsupported OCI layer compression")
                with oci.extractfile(members[name]) as compressed:
                    unpacked = gzip.GzipFile(fileobj=compressed) if media.endswith(("+gzip", ".gzip")) else compressed
                    h, total = hashlib.sha256(), 0
                    for block in iter(lambda: unpacked.read(1024 * 1024), b""):
                        total += len(block)
                        require(total <= ARCHIVE_LIMIT, "Uncompressed OCI layer exceeds its size bound")
                        h.update(block)
                    require(config["rootfs"]["diff_ids"][index] == "sha256:" + h.hexdigest(), "OCI uncompressed layer digest differs")
                with oci.extractfile(members[name]) as layer_stream, tarfile.open(fileobj=layer_stream, mode="r|*") as contents:
                    for entry in contents:
                        leaf = entry.name.removeprefix("./")
                        require(not leaf.startswith("/") and ".." not in leaf.split("/"), "Unsafe OCI layer path")
                        require(leaf != "app" or entry.isdir(), "OCI app directory became an indirect path")
                        require(leaf not in {"app/.wh.engine-pin.json", ".wh.app", "app/.wh..wh..opq"}, "OCI removed the engine contract")
                        if leaf == "app/engine-pin.json":
                            require(entry.isfile() and entry.size <= LIMIT, "Invalid OCI engine contract file")
                            actual_pin = json_bytes(contents.extractfile(entry).read())
            require(actual_pin == expected_pin, "Actual Work OCI engine contract differs from the reviewed private pin")
            require(used == set(members), "Unreferenced OCI content")
            return top["digest"]


def web_image(path, source, run, pin_hash):
    names = {"release.json", "web.json", "catalog.json", "public.jwk.json", "web-boot.json", "dependency-cache.json"}
    with zip_inputs(path, names) as archive:
        release = json_bytes(archive.read("release.json"))
        exact(release, {"source", "runId", "runAttempt", "neutralProfile", "images", "candidateRuntimeQualified"})
        require(release["source"] == source and release["runId"] == str(run["id"]) and positive(release["runAttempt"]) and release["runAttempt"] == run["run_attempt"]
                and release["neutralProfile"] is True and release["candidateRuntimeQualified"] is False, "Web receipt differs from candidate source/attempt")
        exact(release["images"], {"web"})
        image = release["images"]["web"]
        exact(image, {"imageId", "digest", "platform", "source"})
        require(json_bytes(archive.read("web.json")) == image and image["source"] == source and image["platform"] == "linux/amd64"
                and re.fullmatch(r"sha256:[0-9a-f]{64}", image["imageId"]), "Malformed public image receipt")
        updater.image_ref(image["digest"])
        pin = json_bytes(archive.read("public.jwk.json"))
        exact(pin, {"kty", "crv", "x", "y"})
        require(pin["kty"] == "EC" and pin["crv"] == "P-256" and all(isinstance(pin[key], str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", pin[key]) for key in ("x", "y"))
                and updater.digest(pin) == pin_hash, "Catalog public pin differs from the separately reviewed existing pin")
        catalog = json_bytes(archive.read("catalog.json"))
        exact(catalog, {"verified", "files", "tools", "indexSha256", "keyId"})
        require(catalog["verified"] is True and positive(catalog["files"]) and positive(catalog["tools"]) and catalog["tools"] <= catalog["files"]
                and isinstance(catalog["indexSha256"], str) and SHA.fullmatch(catalog["indexSha256"]) and isinstance(catalog["keyId"], str) and 1 <= len(catalog["keyId"]) <= 256,
                "Missing CI-bound signed catalog verification evidence")
        require(json_bytes(archive.read("web-boot.json")) == {"serviceBootPassed": True, "results": {"web": 200}}, "Missing actual web boot qualification")
        cache = json_bytes(archive.read("dependency-cache.json"))
        exact(cache, {"version", "target", "scope", "platform", "cacheRef", "key", "inputs", "sourceExported", "signingExported", "releaseStageCache"})
        require(type(cache["version"]) is int and cache["version"] == 1 and cache["target"] == "deps" and cache["scope"] == "public-neutral" and cache["platform"] == "linux/amd64" and isinstance(cache["cacheRef"], str) and 1 <= len(cache["cacheRef"]) <= 256 and isinstance(cache["key"], str) and SHA.fullmatch(cache["key"]) and cache["inputs"] == ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "deploy/docker/web.Dockerfile"]
                and all(cache[key] is False for key in ("sourceExported", "signingExported", "releaseStageCache")), "Unrecognized web dependency cache custody")
        return image["digest"], catalog


def prepare(value, base, pin_hash=None, runner=command):
    required = {"version", "target", "expectedImages"}
    work_fields = {"work", "workArtifact", "workArtifactMetadata", "expectedEnginePin"}
    web_fields = {"lolly", "candidateRun", "candidateJobs", "webArtifact", "webArtifactMetadata", "normalSourceArtifact", "normalSourceArtifactMetadata"}
    exact(value, required, work_fields | web_fields)
    require(type(value["version"]) is int and value["version"] == 1, "Unsupported preparation input")
    expected = value["expectedImages"]
    require(isinstance(expected, dict) and 1 <= len(expected) <= 2 and set(expected) <= {"work", "public-web"}, "Unowned image selection")
    fields = required | (work_fields if "work" in expected else set()) | (web_fields if "public-web" in expected else set())
    exact(value, fields)
    try:
        target = updater.validate_target(file_input(value["target"], base))
    except Refusal:
        raise Refusal("Updater target refused; review its supported fields, identities and application ownership") from None
    require(target["version"] == 2 and set(expected) <= set(target["components"]), "Preparation needs an explicitly owned updater v2 target")
    for component in expected:
        updater.image_ref(expected[component])
        selectors = [item for item in target["components"][component]["images"] if item["kind"] == "container"]
        require(len(selectors) == 1, "Private shell/pack init images require a maintained paired CI artifact and a reviewed emptyDir conversion; PVC-backed content cannot be promoted here")
    images, sources, normal, catalog, candidate_summary = {}, {}, {}, None, None
    if "public-web" in expected:
        require(isinstance(pin_hash, str) and SHA.fullmatch(pin_hash), "Missing independently reviewed existing public pin hash")
        root, run = source_record(value["lolly"], base, runner)
        runner(["node", "scripts/webgpu-release-gate.ts"], root)
        source = value["lolly"]["source"]
        candidate = run_record(file_input(value["candidateRun"], base), source, value["lolly"]["repository"], ".github/workflows/deployment-suse.yml", "workflow_dispatch")
        jobs_record(file_input(value["candidateJobs"], base), candidate, required_names=("Public chart render and schema checks", "Public VM route and security acceptance", "Reviewed main CI source", "WebGPU release gate (web shell image only)", "Opt-in native public web image (gated on the WebGPU table)"), allowed_skips=("Unsigned web shell for the MCP browser probe (never published)", "Opt-in native public service images (CA, Penpot)", "Opt-in native public MCP browser image (not gated on WebGPU)", "/info docs site (not gated on WebGPU)", "archive-qualified-images"))
        normal_path = file_input(value["normalSourceArtifact"], base, False)
        with open(normal_path, "rb") as stream:
            artifact_record(file_input(value["normalSourceArtifactMetadata"], base), candidate, "normal-main-ci-source-attempt-" + str(candidate["run_attempt"]), stream)
            with zip_inputs(stream, {"normal-ci-source.json"}) as archive:
                proof = json_bytes(archive.read("normal-ci-source.json"))
                exact(proof, {"version", "source", "ciRun", "ciAttempt", "workflow", "jobCount"})
                require(type(proof["version"]) is int and proof["version"] == 1 and proof["source"] == source and positive(proof["ciRun"]) and proof["ciRun"] == run["id"] and positive(proof["ciAttempt"]) and proof["ciAttempt"] == run["run_attempt"] and proof["workflow"] == run["path"] and positive(proof["jobCount"]) and proof["jobCount"] == file_input(value["lolly"]["ciJobs"], base)["total_count"], "Candidate differs from its exact normal CI qualification")
        path = file_input(value["webArtifact"], base, False)
        with open(path, "rb") as stream:
            artifact_record(file_input(value["webArtifactMetadata"], base), candidate, "public-candidate-web-receipts-attempt-" + str(candidate["run_attempt"]), stream)
            images["public-web"], catalog = web_image(stream, source, candidate, pin_hash)
        require(images["public-web"].startswith("ghcr.io/" + value["lolly"]["repository"].split("/")[0].lower() + "/lolly-web@sha256:"), "Wrong public image repository")
        sources["lolly"] = source
        normal["lolly"] = {"run": run["id"], "attempt": run["run_attempt"]}
        candidate_summary = {"run": candidate["id"], "attempt": candidate["run_attempt"]}
    if "work" in expected:
        root, run = source_record(value["work"], base, runner)
        runner(["node", "scripts/verify-engine-pin.ts"], root)
        pin = json_bytes((root / "engine-pin.json").read_bytes())
        require(pin == file_input(value["expectedEnginePin"], base), "Work source engine/core/schema pin differs from the separately reviewed private contract")
        path = file_input(value["workArtifact"], base, False)
        source = value["work"]["source"]
        with open(path, "rb") as stream:
            artifact_record(file_input(value["workArtifactMetadata"], base), run, "qualified-server-" + source, stream)
            images["work"] = expected["work"].split("@")[0] + "@" + work_image(stream, source, pin)
        sources["work"] = source
        normal["work"] = {"run": run["id"], "attempt": run["run_attempt"]}
    updates = [{"component": component, "images": [{**next(item for item in target["components"][component]["images"] if item["kind"] == "container"), "expectedImage": expected[component], "image": images[component]}]} for component in sorted(expected)]
    release = {"version": 2, "updates": updates}
    return release, {"result": "PREPARED", "releaseSha256": updater.digest(release), "targetSha256": updater.digest(target), "sources": sources, "normalCI": normal, "webCandidate": candidate_summary, "catalog": catalog, "scope": "selected regular server images only; mounted private shell/pack unchanged", "promotionAttempted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--reviewed-evidence-sha256", required=True)
    parser.add_argument("--existing-public-pin-sha256", help="Canonical SHA256 of the independently reviewed existing public P-256 JWK")
    parser.add_argument("--release-out", required=True)
    args = parser.parse_args()
    try:
        path = Path(args.evidence)
        with open(path, "rb") as source:
            data = source.read(LIMIT + 1)
        require(len(data) <= LIMIT and SHA.fullmatch(args.reviewed_evidence_sha256) and hashlib.sha256(data).hexdigest() == args.reviewed_evidence_sha256, "Preparation evidence differs from review")
        release, receipt = prepare(json_bytes(data), path.resolve().parent, args.existing_public_pin_sha256)
        updater.write_json(args.release_out, release)
        receipt["evidenceSha256"] = args.reviewed_evidence_sha256
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except Refusal as error:
        # Validation reasons are static messages; API/config contents stay private.
        reason = str(error)
        if not reason.isprintable() or len(reason) > 240:
            reason = "Offline release preparation refused; review the qualification inputs"
        print(json.dumps({"result": "REFUSED", "reason": reason, "promotionAttempted": False}), file=sys.stderr)
        return 1
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile, tarfile.TarError, KeyError, TypeError):
        print(json.dumps({"result": "REFUSED", "reason": "Invalid, missing or unreadable offline qualification input; no release was written", "promotionAttempted": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
