#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Real ephemeral signatures and physical byte inventories, without deployment credentials."""
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


m = module("delivery_cohort", ROOT / "scripts/prepare-private-cohort.py")
public = module("delivery_public", ROOT / "scripts/prepare-public-shell.py")
NODE = os.environ.get("LOLLY_TEST_NODE", "node")


class DeliveryCatalog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run([NODE, "-e", "const c=require('node:crypto'),k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});console.log(JSON.stringify({public:k.publicKey.export({format:'jwk'}),private:k.privateKey.export({format:'jwk'})}));"], capture_output=True, check=True)
        cls.keys = json.loads(result.stdout)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lw-delivery-preparation-"); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve(); self.serial = 0
        self.logical = {"fixture/tool.json": b'{"id":"fixture"}', "fixture/lib/helper.wasm": b"\x00asm\x01\x00\x00\x00", "fixture/__proto__": b"actual filename"}

    def sign(self, envelope):
        unsigned = {k: v for k, v in envelope.items() if k != "signature"}
        result = subprocess.run([NODE, "-e", "const c=require('node:crypto');let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const v=JSON.parse(d);process.stdout.write(c.sign('sha256',Buffer.from(v.payload,'base64'),{key:c.createPrivateKey({key:v.key,format:'jwk'}),dsaEncoding:'ieee-p1363'}).toString('base64url'));});"],
                                input=m.canonical({"key": self.keys["private"], "payload": base64.b64encode(m.canonical(unsigned)).decode()}), capture_output=True, check=True)
        return {**unsigned, "signature": result.stdout.decode()}

    def fixture(self, modern=True, marker=b"current"):
        logical = {**self.logical, "fixture/asset.bin": marker}
        index = m.canonical({"tools": [{"id": "fixture"}]})
        content = {"catalog/tools/index.json": index, **{"tools/" + p: b for p, b in logical.items()}}
        files = {path: hashlib.sha256(data).hexdigest() for path, data in logical.items()}
        envelope = {"alg": "ECDSA-P256-SHA256", "keyId": base64.urlsafe_b64encode(hashlib.sha256(m.canonical(self.keys["public"])).digest()).decode().rstrip("="),
                    "signedAt": "2026-10-11T00:00:00Z", "indexHash": hashlib.sha256(index).hexdigest(), "files": files}
        if modern:
            directory = m.digest({p.split("/", 1)[1]: h for p, h in files.items()})
            published = datetime.now(timezone.utc).replace(microsecond=0)
            envelope.update(seq=7, catalogScope="a" * 64, signedAt=published.isoformat().replace("+00:00", "Z"),
                            expiresAt=(published + timedelta(days=1)).isoformat().replace("+00:00", "Z"), toolDirs={"fixture": directory})
            for field, path, data in (("assetIndexHash", "catalog/assets/index.json", b'{"assets":[]}'), ("slimHash", "catalog/tools/index.slim.json", b'{"tools":[{"id":"fixture"}]}')):
                envelope[field] = hashlib.sha256(data).hexdigest(); content[path] = data
            content.update({f"tools/fixture@{directory[:16]}/{path.split('/', 1)[1]}": data for path, data in logical.items()})
            for field, path in (("indexHash", "catalog/tools/index"), ("assetIndexHash", "catalog/assets/index"), ("slimHash", "catalog/tools/index.slim")):
                content[f"{path}.{envelope[field][:16]}.json"] = content[path + ".json"]
            self.inventory(content)
        return self.sign(envelope), content

    def inventory(self, content):
        files = [{"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for path, data in sorted(content.items())
                 if m.HASH_TOOL.fullmatch(path) or m.HASH_INDEX.fullmatch(path)]
        content["catalog/delivery-manifest.json"] = m.canonical({"version": 1, "files": files})

    def tree(self, content):
        self.serial += 1; root = self.base / f"tree-{self.serial}"; root.mkdir()
        for path, data in content.items():
            p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        entries = [{"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for path, data in sorted(content.items())]
        manifest = self.base / f"manifest-{self.serial}.json"; manifest.write_bytes(m.canonical({"version": 1, "files": entries, "totalBytes": sum(v["size"] for v in entries)})); manifest.chmod(0o600)
        return m.Tree({"root": str(root), "manifest": {"path": str(manifest), "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}}, m.Inputs(self.base))

    def check(self, envelope, content, previous=None, raw_content=None):
        shell = self.tree({**content, "catalog/tools/index.sig.json": m.canonical(envelope)})
        raw = self.tree(content if raw_content is None else raw_content)
        checked = m.catalog(shell, raw, self.keys["public"], m.digest(self.keys["public"]), NODE, previous)
        expected = {**checked, "pinCanonicalSha256": m.digest(self.keys["public"])}
        self.assertEqual(public.public_catalog(shell, self.keys["public"], expected, NODE, previous), expected)
        return checked

    def codings(self, data):
        result = subprocess.run([NODE, "-e", "const z=require('node:zlib');let b=[];process.stdin.on('data',p=>b.push(p));process.stdin.on('end',()=>process.stdout.write(z.brotliCompressSync(Buffer.concat(b))));"],
                                input=data, capture_output=True, check=True)
        return {".gz": gzip.compress(data, mtime=0), ".br": result.stdout}

    def test_legacy_and_complete_delivery_envelopes_verify_actual_bytes(self):
        for modern in (False, True):
            envelope, content = self.fixture(modern)
            with self.subTest(modern=modern): self.assertEqual(self.check(envelope, content)["signedFiles"], 4)

    def test_verified_compression_siblings_are_not_signed_identity_files(self):
        for modern in (False, True):
            envelope, identity = self.fixture(modern)
            identity = {**identity, "_app/runtime.js": b"const release = 'fixture';" * 80}
            content = dict(identity)
            for path, data in identity.items():
                content.update({path + suffix: coded for suffix, coded in self.codings(data).items()})
            with self.subTest(modern=modern):
                self.assertEqual(self.check(envelope, content, raw_content=identity)["signedFiles"], 4)
            physical = self.tree(content)
            self.assertTrue(any(path.endswith(".gz") for path in physical.files))
            self.assertEqual(len(m.verified_codings(physical, NODE)), len(identity) * 2)

    def test_orphan_nested_and_corrupt_compression_siblings_refuse(self):
        envelope, content = self.fixture()
        coding = self.codings(content["tools/fixture/asset.bin"])
        cases = ({**content, "tools/fixture/missing.js.gz": coding[".gz"]},
                 {**content, "_app/absent.js.br": coding[".br"]},
                 {**content, "tools/fixture/asset.bin.gz": coding[".gz"], "tools/fixture/asset.bin.gz.br": coding[".br"]},
                 {**content, "tools/fixture/asset.bin.gz": b"not gzip"},
                 {**content, "tools/fixture/asset.bin.br": coding[".br"][:-1]},
                 {**content, "tools/fixture/asset.bin.br": coding[".br"] + b"junk"})
        for bad in cases:
            with self.subTest(paths=list(bad)), self.assertRaisesRegex(m.Refusal, "compression sibling|Compression sibling"):
                self.check(envelope, bad)

    def test_wrong_same_size_and_overexpanding_codings_refuse(self):
        envelope, content = self.fixture()
        for data in (b"changed", b"x" * (1024 * 1024)):
            for suffix, coded in self.codings(data).items():
                with self.subTest(bytes=len(data), coding=suffix), self.assertRaisesRegex(m.Refusal, "Compression sibling"):
                    self.check(envelope, {**content, "tools/fixture/asset.bin" + suffix: coded})

    def test_compression_cannot_be_claimed_as_delivery_identity(self):
        envelope, content = self.fixture()
        path = next(path for path in content if m.HASH_TOOL.fullmatch(path) and path.endswith("asset.bin"))
        content[path + ".gz"] = gzip.compress(content[path], mtime=0)
        self.inventory(content)
        with self.assertRaisesRegex(m.Refusal, "not an identity delivery inventory"):
            self.check(envelope, content)

    def test_signed_unknown_incomplete_or_invalid_delivery_fields_refuse(self):
        envelope, content = self.fixture()
        changes = (lambda v: v.update(unknown=True), lambda v: v.pop("seq"), lambda v: v.pop("toolDirs"),
                   lambda v: v.update(seq=True), lambda v: v.update(seq=9007199254740992), lambda v: v.update(catalogScope="wrong"),
                   lambda v: v.update(expiresAt="2026-10-10T00:00:00Z"), lambda v: v.update(signedAt="2026-99-99T00:00:00Z"),
                   lambda v: v.update(signedAt="2000-01-01T00:00:00Z", expiresAt="2001-01-01T00:00:00Z"),
                   lambda v: v.update(toolDirs={}), lambda v: v.update(toolDirs={"fixture": "a" * 64}))
        for change in changes:
            bad = copy.deepcopy(envelope); change(bad)
            with self.subTest(fields=bad), self.assertRaises(m.Refusal): self.check(self.sign(bad), content)

    def test_an_unverified_sequence_is_never_admitted(self):
        envelope, content = self.fixture(); envelope["seq"] += 1
        with self.assertRaisesRegex(m.Refusal, "signature does not verify"): self.check(envelope, content)

    def test_extra_logical_bytes_and_altered_or_missing_immutable_trees_refuse(self):
        envelope, content = self.fixture()
        bad = {**content, "tools/fixture/unlisted.js": b"not signed"}
        with self.assertRaisesRegex(m.Refusal, "full signed catalog closure"): self.check(envelope, bad)
        alias = next(p for p in content if m.HASH_TOOL.fullmatch(p) and p.endswith("asset.bin"))
        for change in (lambda v: v.update({alias: b"altered"}), lambda v: v.pop(alias), lambda v: v.update({alias + ".extra": b"extra"})):
            bad = dict(content); change(bad); self.inventory(bad)
            with self.subTest(paths=list(bad)), self.assertRaises(m.Refusal): self.check(envelope, bad)
        bad = {p: b for p, b in content.items() if not m.HASH_TOOL.fullmatch(p)}; self.inventory(bad)
        with self.assertRaisesRegex(m.Refusal, "current immutable tool directory is missing"): self.check(envelope, bad)

    def test_sidecar_claims_are_required_exact_and_present(self):
        envelope, content = self.fixture()
        for field, path in (("assetIndexHash", "catalog/assets/index.json"), ("slimHash", "catalog/tools/index.slim.json")):
            bad = dict(envelope); bad.pop(field)
            with self.subTest(field=field, case="missing"), self.assertRaises(m.Refusal): self.check(self.sign(bad), content)
            bad = {**envelope, field: "a" * 64}
            with self.subTest(field=field, case="altered"), self.assertRaises(m.Refusal): self.check(self.sign(bad), content)
            bad_content = dict(content); bad_content.pop(path)
            with self.subTest(field=field, case="absent"), self.assertRaises(m.Refusal): self.check(envelope, bad_content)

    def test_retained_aliases_require_exact_previous_physical_custody(self):
        envelope, content = self.fixture(); old_envelope, old = self.fixture(marker=b"previous")
        previous = self.tree({**old, "catalog/tools/index.sig.json": m.canonical(old_envelope)})
        retained = {p: b for p, b in old.items() if m.HASH_TOOL.fullmatch(p)}
        candidate = {**content, **retained}; self.inventory(candidate)
        with self.assertRaisesRegex(m.Refusal, "previous reviewed custody"): self.check(envelope, candidate)
        self.check(envelope, candidate, previous)
        removed = dict(old); removed.pop(next(iter(retained))); self.inventory(removed)
        with self.assertRaisesRegex(m.Refusal, "previous reviewed custody"): self.check(envelope, candidate, self.tree(removed))


if __name__ == "__main__": unittest.main()
