#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Verify the CI OCI archive, exact booted config and amd64 runtime identity."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

archive, image, output = sys.argv[1:]
with tarfile.open(archive) as tar:
    def blob(reference):
        algorithm, value = reference.split(":")
        if algorithm != "sha256" or len(value) != 64:
            raise ValueError("Unsupported OCI digest")
        body = tar.extractfile("blobs/sha256/" + value).read()
        if hashlib.sha256(body).hexdigest() != value:
            raise ValueError("OCI blob digest mismatch")
        return body
    index = json.load(tar.extractfile("index.json"))
    if len(index["manifests"]) != 1:
        raise ValueError("Expected one qualified architecture manifest")
    image_digest = index["manifests"][0]["digest"]
    manifest = json.loads(blob(image_digest))
    config_digest = manifest["config"]["digest"]
    config = json.loads(blob(config_digest))
    for layer in manifest["layers"]:
        blob(layer["digest"])
if config["architecture"] != "amd64" or config["os"] != "linux" or config["config"]["User"] != "1000:1000":
    raise ValueError("Unexpected runtime architecture, OS or user")
if config["config"]["Cmd"] != ["node", "src/main.mjs"]:
    raise ValueError("Unexpected runtime command")
booted = subprocess.check_output(["docker", "image", "inspect", image, "--format", "{{.Id}}"], text=True).strip()
if booted != config_digest:
    raise ValueError("Booted Docker config differs from exported OCI config")
sha = hashlib.sha256()
with open(archive, "rb") as src:
    for part in iter(lambda: src.read(1024 * 1024), b""):
        sha.update(part)
evidence = {"version": 1, "archiveSHA256": sha.hexdigest(), "ociManifestDigest": image_digest,
            "bootedConfigDigest": config_digest, "platform": "linux/amd64", "uid": 1000,
            "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            "workflowSHA": os.environ.get("GITHUB_SHA"), "runID": os.environ.get("GITHUB_RUN_ID"),
            "qualification": "synthetic CI TLS/auth and upstream Redis AOF fixture; AppCo/K3s remains separate"}
Path(output).write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence))
