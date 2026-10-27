# SPDX-License-Identifier: MPL-2.0
"""Fast deploy lanes (deploy/preview/lib/preview_lane.py), the Python port of lolly's scripts/deploy-lane.ts.

The rules run against tests/fixtures/deploy-lane-cases.json, a byte-for-byte copy of lolly's
tests/fixtures/deploy-lane/cases.json; both repositories pin the same SHA-256, so a rule change goes into
both or neither. The GitHub half runs against an in-process fake that serves real-shaped tree objects.
"""
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import preview_deploy_fakes as F  # noqa: E402  (puts deploy/preview/lib on sys.path)
import preview_anchors as A  # noqa: E402
import preview_common as C  # noqa: E402
import preview_lane as P  # noqa: E402

CASES = TESTS / "fixtures" / "deploy-lane-cases.json"
# lolly tests/deploy-lane.test.ts pins the same digest of the original.
CASES_SHA256 = "c056c68f20f3eea3c78a7aadd5d413efd8406fe1ab9691aeed3870b58e44429f"
REPO = A.TOOLS["repository"]


class LaneRules(unittest.TestCase):
    def test_cases_are_the_pinned_copy_of_lollys(self):
        self.assertEqual(hashlib.sha256(CASES.read_bytes()).hexdigest(), CASES_SHA256)
        fixture = json.loads(CASES.read_text())
        self.assertEqual((fixture["version"], fixture["policy"]), (1, P.LANE_POLICY))
        self.assertEqual({case["lane"] for case in fixture["cases"]}, {"docs", "web", "full"})

    def test_every_case_matches_the_typescript_rules(self):
        for case in json.loads(CASES.read_text())["cases"]:
            with self.subTest(case=case["name"]):
                lane, reasons = P.lane_of([tuple(change) for change in case["changes"]])
                self.assertEqual(lane, case["lane"], reasons)
                self.assertEqual(bool(reasons), lane == "full")

    def test_reasons_say_which_path_and_why(self):
        lane, reasons = P.lane_of([("docs/a.md", "100644", "100644"), ("shells/web/src/main.ts", "100644", "100644"),
                                   ("engine/src/runtime.ts", "100644", "100644")])
        self.assertEqual(lane, "full")
        self.assertEqual(len(reasons), 2)
        self.assertTrue(reasons[0].startswith("Full CI required: shells/web/src/main.ts (boot path"), reasons)
        self.assertEqual(reasons[1], "Full CI required: engine/src/runtime.ts (outside docs/ and shells/web/)")

    def test_only_lolly_tools_has_lanes(self):
        self.assertEqual(A.TOOLS["fastLaneWorkflowPath"], ".github/workflows/fast-lanes.yml")
        self.assertNotIn("fastLaneWorkflowFile", A.TOOLS_LEGACY)
        self.assertNotIn("fastLaneWorkflowFile", A.ING)
        with self.assertRaises(C.Refusal) as caught:
            P.qualify(FakeGh(), A.ING, "b" * 40)
        self.assertEqual(caught.exception.code, "LANE_UNAVAILABLE")


BASE, MID, SOURCE = "a" * 40, "c" * 40, "b" * 40
BASE_FILES = {"README.md": "# Lolly\n", "package.json": "{}\n", "docs/using.md": "# Using\n", "docs/i18n/de/using.md": "# Nutzen\n",
              "docs/build.ts": "export {};\n", "shells/web/src/styles/a.css": "a{}\n", "shells/web/src/main.ts": "boot\n",
              "shells/web/public/sw.js": "sw\n", "shells/cli/src/bridge.ts": "cli\n", "engine/text-composition.md": "# Text\n",
              "engine/src/runtime.ts": "runtime\n", "brands/suse": ("160000", "pointer")}


def run(run_id, sha, workflow, status="completed", conclusion="success", **extra):
    value = {"id": run_id, "path": f".github/workflows/{workflow}", "event": "push", "head_branch": "main", "head_sha": sha,
             "status": status, "conclusion": conclusion, "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}}
    value.update(extra)
    return value


class FakeGh:
    """GitHub's REST answers the lane code reads, in process. Records every path it was asked."""

    def __init__(self, history=None, ci_runs=(), fast_runs=None, jobs=None, truncated=False):
        self.commits, self.trees, self.calls = {}, {}, []
        self.ci_runs, self.fast_runs, self.jobs, self.truncated = list(ci_runs), fast_runs, jobs or {}, truncated
        parent = None
        for sha, files in history or []:
            root, trees = F.git_trees(files)
            self.trees.update(trees)
            self.commits[sha] = {"tree": root, "parents": [parent] if parent else []}
            parent = sha

    def json(self, path, **params):
        self.calls.append((path, params))
        if path.startswith(f"repos/{REPO}/git/commits/"):
            sha = path.rsplit("/", 1)[1]
            commit = self.commits[sha]
            return {"sha": sha, "tree": {"sha": commit["tree"]}, "parents": [{"sha": p} for p in commit["parents"]]}
        if path.startswith(f"repos/{REPO}/git/trees/"):
            sha = path.rsplit("/", 1)[1]
            return {"sha": sha, "tree": F.tree_listing(self.trees, sha, params.get("recursive") == "1"), "truncated": self.truncated}
        if path == f"repos/{REPO}/actions/workflows/ci.yml/runs":
            return {"workflow_runs": [r for r in self.ci_runs if ("head_sha" not in params or r["head_sha"] == params["head_sha"])
                                      and ("status" not in params or params["status"] in (r["status"], r["conclusion"]))]}
        if path == f"repos/{REPO}/actions/workflows/fast-lanes.yml/runs":
            if self.fast_runs is None:
                raise C.Refusal("GITHUB_NOT_FOUND", "GitHub answered 404")
            return {"workflow_runs": [r for r in self.fast_runs if r["head_sha"] == params["head_sha"]]}
        if path.startswith(f"repos/{REPO}/actions/runs/") and path.endswith("/jobs"):
            assert params.get("filter") == "latest"
            return {"jobs": self.jobs.get(int(path.split("/")[-2]), [])}
        raise AssertionError("unexpected read " + path)


def edited(**changes):
    files = dict(BASE_FILES)
    for path, text in changes.items():
        if text is None:
            files.pop(path)
        else:
            files[path] = text
    return files


def job(in_run, name, sha=SOURCE, status="completed", conclusion="success", **extra):
    value = {"id": in_run * 10 + len(name), "run_id": in_run, "head_sha": sha, "name": name, "status": status, "conclusion": conclusion}
    value.update(extra)
    return value


class LaneGitHub(unittest.TestCase):
    def changes(self, files_before, files_after):
        gh = FakeGh([(BASE, files_before), (SOURCE, files_after)])
        return P.tree_changes(gh, REPO, BASE, SOURCE)

    def test_tree_changes_list_docs_and_web_paths_exactly_and_other_areas_as_their_directory(self):
        after = edited(**{"docs/using.md": "# Using Lolly\n", "docs/i18n/de/using.md": None, "docs/work/new.md": "# New\n",
                          "shells/web/src/styles/a.css": "a{color:red}\n", "README.md": "# Lolly!\n",
                          "engine/text-composition.md": "# Text!\n", "engine/src/runtime.ts": "runtime 2\n",
                          "shells/cli/src/bridge.ts": "cli 2\n", "brands/suse": ("160000", "pointer 2")})
        self.assertEqual(self.changes(BASE_FILES, after), [
            ("README.md", "100644", "100644"),
            ("brands", "040000", "040000"),
            ("docs/i18n/de/using.md", "100644", "000000"),
            ("docs/using.md", "100644", "100644"),
            ("docs/work/new.md", "000000", "100644"),
            ("engine/src", "040000", "040000"),
            ("engine/text-composition.md", "100644", "100644"),
            ("shells/cli", "040000", "040000"),
            ("shells/web/src/styles/a.css", "100644", "100644"),
        ])

    def test_modes_and_type_changes_come_through(self):
        self.assertEqual(self.changes(BASE_FILES, edited(**{"docs/run.sh": ("100755", "x"), "shells/web/src/link": ("120000", "a.css")})),
                         [("docs/run.sh", "000000", "100755"), ("shells/web/src/link", "000000", "120000")])
        self.assertEqual(self.changes(BASE_FILES, edited(**{"docs/using.md": None, "docs/using.md/inner.md": "x"})),
                         [("docs/using.md", "100644", "000000"), ("docs/using.md/inner.md", "000000", "100644")])
        self.assertEqual(P.lane_of(self.changes(BASE_FILES, edited(**{"package.json": "{ }\n"})))[0], "full")

    def test_a_truncated_listing_refuses(self):
        gh = FakeGh([(BASE, BASE_FILES), (SOURCE, edited(**{"docs/using.md": "x"}))], truncated=True)
        with self.assertRaises(C.Refusal) as caught:
            P.tree_changes(gh, REPO, BASE, SOURCE)
        self.assertEqual(caught.exception.code, "LANE_TREE")

    def lane_gh(self, after, **kwargs):
        defaults = {"ci_runs": [run(10, BASE, "ci.yml"), run(11, SOURCE, "ci.yml", "in_progress", None)],
                    "fast_runs": [run(20, SOURCE, "fast-lanes.yml")],
                    "jobs": {20: [job(20, "docs lane"), job(20, "web lane")]}}
        defaults.update(kwargs)
        return FakeGh([(BASE, BASE_FILES), (SOURCE, after)], **defaults)

    def test_a_docs_change_qualifies_with_its_job_and_a_web_change_needs_the_web_job(self):
        docs = P.qualify(self.lane_gh(edited(**{"docs/using.md": "x", "docs/build.ts": "export const x = 1;\n"})), A.TOOLS, SOURCE)
        self.assertEqual(docs, {"id": 10, "lane": "docs", "base": BASE, "distance": 1, "fastRun": 20, "fastJob": 209,
                                "policy": P.LANE_POLICY})
        css = edited(**{"shells/web/src/styles/a.css": "a{color:red}\n"})
        self.assertEqual(P.qualify(self.lane_gh(css), A.TOOLS, SOURCE)["lane"], "web")
        with self.assertRaises(C.Refusal) as caught:
            P.qualify(self.lane_gh(css, jobs={20: [job(20, "docs lane"), job(20, "web lane", status="in_progress", conclusion=None)]}),
                      A.TOOLS, SOURCE)
        self.assertEqual(caught.exception.code, "LANE_PENDING")
        self.assertIn('"web lane"', caught.exception.message)

    def test_broad_changes_failed_runs_and_foreign_jobs_never_qualify(self):
        cases = [
            ("broad", edited(**{"docs/using.md": "x", "shells/web/src/main.ts": "boot 2\n"}), {}, "LANE_FULL"),
            ("service worker", edited(**{"shells/web/public/sw.js": "sw 2\n"}), {}, "LANE_FULL"),
            ("full CI failed", edited(**{"docs/using.md": "x"}),
             {"ci_runs": [run(10, BASE, "ci.yml"), run(11, SOURCE, "ci.yml", conclusion="failure")]}, "CI_NOT_GREEN"),
            ("full CI timed out", edited(**{"docs/using.md": "x"}),
             {"ci_runs": [run(10, BASE, "ci.yml"), run(11, SOURCE, "ci.yml", conclusion="timed_out")]}, "CI_NOT_GREEN"),
            ("no green base", edited(**{"docs/using.md": "x"}), {"ci_runs": [run(10, BASE, "ci.yml", conclusion="failure")]}, "LANE_NO_BASE"),
            ("no workflow yet", edited(**{"docs/using.md": "x"}), {"fast_runs": None}, "LANE_PENDING"),
            ("pull request run", edited(**{"docs/using.md": "x"}), {"fast_runs": [run(20, SOURCE, "fast-lanes.yml", event="pull_request")]}, "LANE_PENDING"),
            ("other branch", edited(**{"docs/using.md": "x"}), {"fast_runs": [run(20, SOURCE, "fast-lanes.yml", head_branch="x")]}, "LANE_PENDING"),
            ("fork", edited(**{"docs/using.md": "x"}), {"fast_runs": [run(20, SOURCE, "fast-lanes.yml", head_repository={"full_name": "f/lolly"})]}, "LANE_PENDING"),
            ("failed job", edited(**{"docs/using.md": "x"}), {"jobs": {20: [job(20, "docs lane", conclusion="failure")]}}, "LANE_PENDING"),
            ("job for another commit", edited(**{"docs/using.md": "x"}), {"jobs": {20: [job(20, "docs lane", sha=BASE)]}}, "LANE_PENDING"),
            ("job of another run", edited(**{"docs/using.md": "x"}), {"jobs": {20: [job(20, "docs lane", run_id=21)]}}, "LANE_PENDING"),
            ("two lane jobs", edited(**{"docs/using.md": "x"}), {"jobs": {20: [job(20, "docs lane"), job(20, "docs lane")]}}, "LANE_JOBS"),
        ]
        for name, after, kwargs, code in cases:
            with self.subTest(name=name), self.assertRaises(C.Refusal) as caught:
                P.qualify(self.lane_gh(after, **kwargs), A.TOOLS, SOURCE)
            self.assertEqual(caught.exception.code, code, caught.exception.message)

    def test_a_cancelled_full_run_is_no_verdict(self):
        gh = self.lane_gh(edited(**{"docs/using.md": "x"}), ci_runs=[run(10, BASE, "ci.yml"), run(11, SOURCE, "ci.yml", conclusion="cancelled")])
        self.assertEqual(P.qualify(gh, A.TOOLS, SOURCE)["lane"], "docs")

    def test_the_base_is_the_newest_green_first_parent_ancestor_within_reach(self):
        history = [(BASE, BASE_FILES), (MID, edited(**{"docs/using.md": "mid"})), (SOURCE, edited(**{"docs/using.md": "source"}))]
        gh = FakeGh(history, ci_runs=[run(10, BASE, "ci.yml"), run(12, MID, "ci.yml")])
        self.assertEqual(P.find_base(gh, A.TOOLS, SOURCE), (MID, 12, 1))
        gh = FakeGh(history, ci_runs=[run(10, BASE, "ci.yml"), run(12, MID, "ci.yml", conclusion="failure"),
                                      run(13, BASE, "ci.yml", event="pull_request")])
        self.assertEqual(P.find_base(gh, A.TOOLS, SOURCE), (BASE, 10, 2))
        far = [(f"{index:040x}", BASE_FILES) for index in range(1, P.MAX_BASE_DISTANCE + 3)]
        gh = FakeGh(far, ci_runs=[run(10, far[0][0], "ci.yml")])
        with self.assertRaises(C.Refusal) as caught:
            P.find_base(gh, A.TOOLS, far[-1][0])
        self.assertEqual(caught.exception.code, "LANE_NO_BASE")


if __name__ == "__main__":
    unittest.main()
