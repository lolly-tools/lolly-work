# SPDX-License-Identifier: MPL-2.0
"""Source-only v2 protocol controls; no production acceptance is manufactured."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts/public-delivery-overlay.py"
spec = importlib.util.spec_from_file_location("delivery_overlay", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def row(path, contents):
    return {"path": path, "size": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}


def tree(rows):
    values = sorted(rows.values(), key=lambda r: r["path"])
    return {"version": 1, "files": values, "totalBytes": sum(r["size"] for r in values)}


class DeliveryOverlay(unittest.TestCase):
    def setUp(self):
        self.old = {p: row(p, ("old " + p).encode()) for p in
                    [*m.FIXED, m.MAP, "_app/old.js", "_app/old.js.gz", "catalog/tools/index.json",
                     "catalog/tools/index.sig.json", "tools/design@1234567890abcdef/tool.json",
                     "fonts/font.woff2", "info/docs.html"]}
        self.old["index.html.gz"] = row("index.html.gz", b"old-gzip")
        self.old["index.html.br"] = row("index.html.br", b"old-brotli")
        self.new = copy.deepcopy(self.old)
        self.new["index.html"] = row("index.html", b"new small identity")
        self.new[m.MAP] = row(m.MAP, b"new whole-root map")
        self.new["_app/new.js"] = row("_app/new.js", b"new module")
        del self.new["index.html.gz"], self.new["index.html.br"]

    def invoke(self, old=None, new=None, overlay=None, delta=None, removed=None):
        old = self.old if old is None else old
        new = self.new if new is None else new
        writes = {p: r for p, r in new.items() if old.get(p) != r}
        return m.plan(tree(old), tree(new), tree(new if overlay is None else overlay),
                      tree(writes if delta is None else delta),
                      sorted(set(old) - set(new)) if removed is None else removed)

    def test_full_root_prevents_absent_coding_fallback_and_preserves_old_chunks(self):
        p = self.invoke()
        self.assertEqual(p["removed"], ["index.html.br", "index.html.gz"])
        self.assertFalse(p["runtimeQualified"])
        self.assertIn("_app/old.js.gz", self.new)

    def test_new_real_coding_requires_separate_decode_proof(self):
        self.new["index.html.gz"] = row("index.html.gz", b"new-coded-wire")
        p = self.invoke()
        self.assertEqual(next(v for v in p["codingPairs"] if v["coding"]["path"] == "index.html.gz")["identity"], self.new["index.html"])

    def test_only_complete_overlay_is_admitted(self):
        partial = {p: r for p, r in self.new.items() if p.startswith("_app/") or p in m.FIXED or p == m.MAP}
        with self.assertRaises(m.Refusal): self.invoke(overlay=partial)

    def test_stale_map_refused(self):
        self.new[m.MAP] = self.old[m.MAP]
        with self.assertRaises(m.Refusal): self.invoke()

    def test_map_only_rewrite_is_not_a_frontend_update(self):
        n = copy.deepcopy(self.old); n[m.MAP] = self.new[m.MAP]
        with self.assertRaises(m.Refusal): self.invoke(new=n)

    def test_unchanged_stale_coding_refused(self):
        self.new["index.html.gz"] = self.old["index.html.gz"]
        with self.assertRaises(m.Refusal): self.invoke()

    def test_retained_chunk_cannot_change_or_disappear(self):
        for removed in [False, True]:
            n = copy.deepcopy(self.new)
            if removed: del n["_app/old.js"]
            else: n["_app/old.js"] = row("_app/old.js", b"collision")
            with self.subTest(removed=removed), self.assertRaises(m.Refusal): self.invoke(new=n)

    def test_protected_catalog_docs_fonts_and_tools_cannot_change(self):
        for path in ["catalog/tools/index.json", "catalog/tools/index.sig.json", "info/docs.html", "fonts/font.woff2", "tools/design@1234567890abcdef/tool.json"]:
            n = copy.deepcopy(self.new); n[path] = row(path, b"changed")
            with self.subTest(path=path), self.assertRaises(m.Refusal): self.invoke(new=n)

    def test_model_and_private_metadata_cannot_enter_static_claim(self):
        for path in ["models/weights.onnx", ".secret", ".well-known/other", "_app/.secret"]:
            n = copy.deepcopy(self.new); n[path] = row(path, b"extra")
            with self.subTest(path=path), self.assertRaises(m.Refusal): self.invoke(new=n)

    def test_only_changed_mutable_codings_may_be_removed(self):
        n = copy.deepcopy(self.new); del n["_app/old.js.gz"]
        with self.assertRaises(m.Refusal): self.invoke(new=n)
        with self.assertRaises(m.Refusal): self.invoke(removed=[])
        with self.assertRaises(m.Refusal): self.invoke(removed=[{}])

    def test_existing_security_metadata_remains_protected(self):
        self.old[".well-known/security.txt"] = row(".well-known/security.txt", b"existing contact")
        self.new[".well-known/security.txt"] = self.old[".well-known/security.txt"]
        self.invoke()
        self.new[".well-known/security.txt"] = row(".well-known/security.txt", b"changed contact")
        with self.assertRaises(m.Refusal): self.invoke()

    def test_orphan_or_nested_codings_refused(self):
        for path in ["_app/missing.js.gz", "_app/old.js.gz.br", m.MAP + ".gz"]:
            n = copy.deepcopy(self.new); n[path] = row(path, b"wire")
            with self.subTest(path=path), self.assertRaises(m.Refusal): self.invoke(new=n)

    def test_delta_must_cover_exact_writes(self):
        with self.assertRaises(m.Refusal): self.invoke(delta={m.MAP: self.new[m.MAP]})

    def test_traversal_encoding_unknown_fields_and_boolean_sizes_refused(self):
        for path in ["../x", "/x", "a//x", "a/%2e%2e/x", "a\\x"]:
            with self.subTest(path=path), self.assertRaises(m.Refusal): m.safe_path(path)
        for modification in [lambda r: r.update(size=True), lambda r: r.update(sha256="a" * 63), lambda r: r.update(extra=1)]:
            t = tree(self.old); modification(t["files"][0])
            with self.assertRaises(m.Refusal): m.manifest(t)

    def test_duplicate_unsorted_manifest_and_wrong_totals_refused(self):
        for modification in [lambda t: t["files"].reverse(), lambda t: t["files"].append(t["files"][0]), lambda t: t.update(totalBytes=True)]:
            t = tree(self.old); modification(t)
            with self.assertRaises(m.Refusal): m.manifest(t)

    def test_whole_volume_anchor_precedes_root_and_map_subpaths(self):
        mounts = m.overlay_mounts("new-site")
        self.assertEqual([v["mountPath"] for v in mounts], [m.ANCHOR, m.ROOT, "/etc/nginx/delivery-etags.conf"])
        self.assertTrue(all(v["readOnly"] is True for v in mounts))
        self.assertNotIn("subPath", mounts[0])
        self.assertEqual(mounts[1]["subPath"], "site")
        for name in ["../x", "", "UPPER", "with space"]:
            with self.subTest(name=name), self.assertRaises(m.Refusal): m.overlay_mounts(name)


if __name__ == "__main__":
    unittest.main()
