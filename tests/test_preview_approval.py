# SPDX-License-Identifier: MPL-2.0
"""Public approval trust-boundary tests. No GitHub, node or cluster is contacted."""
import copy
import json
from pathlib import Path
import subprocess
import time
import unittest
from unittest import mock

import preview_deploy_fakes as F
import preview_deploy_ing_fakes as IF
import preview_anchors as A
import preview_approval as P
import preview_common as C
import preview_ing_github as IG
from test_preview_deploy_ing import StubGh, pinned_anchors

ROOT = Path(__file__).resolve().parent.parent


class ApprovalRules(unittest.TestCase):
    def setUp(self):
        self.key = F.make_key()
        for patcher in pinned_anchors(self.key):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.build = IF.make_ing_build(self.key, "4" * 40, "approval-unit")
        self.private = IF.ing_run(1100, self.build["suse"])
        self.manifest = IF.ing_manifest(self.build, 1100)
        self.gh = StubGh(self.build, self.private)
        self.request = self.manifest["approvals"]["final"]["request"]
        self.public_id = self.manifest["approvals"]["final"]["run"]["id"]
        self.public = self.gh.state["publicRuns"][self.public_id]

    def rejected(self, call):
        with self.assertRaises(C.Refusal):
            call()

    def test_python_and_node_hash_the_same_private_request(self):
        helper = ROOT / "deploy/preview/approval/approval.mjs"
        code = "import {requestDigest} from " + json.dumps(helper.as_uri()) + "; let input=''; for await (const c of process.stdin) input+=c; process.stdout.write(requestDigest(JSON.parse(input)));"
        result = subprocess.run(["node", "--input-type=module", "-e", code], input=json.dumps(self.request),
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(P.request_digest(self.request), result.stdout)
        reordered = {key: self.request[key] for key in reversed(list(self.request))}
        self.assertEqual(P.request_digest(reordered), result.stdout)

    def test_private_request_rejects_extra_fields_and_invalid_stage_shape(self):
        for change in ({"unreviewed": True}, {"stage": "deploy"}, {"artifactSha256": None},
                       {"nonce": "guessable"}, {"expiresAt": self.request["issuedAt"] + 14401},
                       {"maintenance": "false"}, {"minSeq": "-1"}):
            with self.subTest(change=change):
                altered = dict(self.request, **change)
                self.rejected(lambda: P.validate_request(altered))
        for field, value in (("id", "../1100"), ("attempt", 2), ("repository", "someone/suse-lolly")):
            with self.subTest(field=field):
                altered = copy.deepcopy(self.request)
                altered["privateRun"][field] = value
                self.rejected(lambda: P.validate_request(altered))

    def test_only_a_real_approved_main_workflow_run_binds(self):
        P.verify_approval(self.gh, self.public, self.request)
        changes = ({"event": "push"}, {"head_branch": "unreviewed"}, {"run_attempt": 2},
                   {"path": ".github/workflows/another.yml"}, {"conclusion": "failure"},
                   {"status": "in_progress"}, {"repository": {"full_name": "someone/lolly-work"}},
                   {"head_repository": {"full_name": "someone/lolly-work"}},
                   {"actor": {"login": "intruder"}}, {"triggering_actor": {"login": "intruder"}},
                   {"display_title": "lolly.ing approval source " + P.request_digest(self.request)},
                   {"display_title": "lolly.ing approval final " + "0" * 64})
        for change in changes:
            with self.subTest(change=change):
                self.rejected(lambda: P.verify_approval(self.gh, dict(self.public, **change), self.request))

    def test_a_success_without_the_expected_manual_approval_is_refused(self):
        cases = ([], [IF.signing_approval("intruder")], [IF.maintenance_approval()],
                 [dict(IF.signing_approval(), state="rejected")])
        for approvals in cases:
            with self.subTest(approvals=approvals):
                self.gh.state["publicApprovals"][self.public_id] = approvals
                self.rejected(lambda: P.verify_approval(self.gh, self.public, self.request))

    def test_environment_drift_and_workflow_changes_fail_closed(self):
        self.gh.state["approvalWorkflowBlob"] = "0" * 40
        self.rejected(lambda: P.verify_approval(self.gh, self.public, self.request))
        self.gh.state.pop("approvalWorkflowBlob")
        for change in ({"can_admins_bypass": True}, {"protection_rules": []},
                       {"deployment_branch_policy": {"protected_branches": True, "custom_branch_policies": False}}):
            with self.subTest(change=change):
                environment = IF.approval_environment("lolly-ing-signing")
                environment.update(change)
                self.gh.state["approvalEnvironments"] = {"lolly-ing-signing": environment}
                self.rejected(lambda: P.verify_approval(self.gh, self.public, self.request))
        self.gh.state.pop("approvalEnvironments")
        for branches in ([{"name": "*", "type": "branch"}], [{"name": "main", "type": "tag"}],
                         [{"name": "main", "type": "branch"}, {"name": "other", "type": "branch"}]):
            with self.subTest(branches=branches):
                self.gh.state["approvalBranches"] = {"total_count": len(branches), "branch_policies": branches}
                self.rejected(lambda: P.verify_approval(self.gh, self.public, self.request))

    def test_an_old_approval_cannot_authorize_a_fresh_private_request(self):
        for change in ({"nonce": "a" * 64}, {"artifactSha256": "a" * 64}):
            with self.subTest(change=change):
                self.rejected(lambda: P.verify_approval(self.gh, self.public, dict(self.request, **change)))
        old = dict(self.request, issuedAt=int(time.time()) - 15000, expiresAt=int(time.time()) - 600)
        self.public["display_title"] = "lolly.ing approval final " + P.request_digest(old)
        self.rejected(lambda: P.verify_approval(self.gh, self.public, old))

    def test_public_approval_timestamps_must_fit_the_request_lifetime(self):
        stamp = lambda value: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))
        for change in ({"created_at": stamp(self.request["issuedAt"] - 61)},
                       {"updated_at": stamp(self.request["expiresAt"] + 1)},
                       {"created_at": stamp(int(time.time()) + 120)}, {"updated_at": "unreadable"}):
            with self.subTest(change=change):
                self.rejected(lambda: P.verify_approval(self.gh, dict(self.public, **change), self.request))

    def test_same_account_is_allowed_only_by_the_explicit_exception(self):
        public = copy.deepcopy(self.public)
        public.update(actor={"login": IF.REVIEWER}, triggering_actor={"login": IF.REVIEWER})
        with mock.patch.object(A, "ING_DISPATCH_IDENTITY", IF.REVIEWER):
            P.verify_approval(self.gh, public, self.request)
            with mock.patch.object(A, "ING_ALLOW_SAME_ACCOUNT_APPROVAL", False):
                self.rejected(lambda: P.verify_approval(self.gh, public, self.request))

    def test_maintenance_approval_is_bound_to_the_final_public_gate(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["approvals"] = IF.approval_records(self.build, 1100, maintenance=True)
        gh = StubGh(self.build, self.private, manifest=manifest)
        with mock.patch.object(A, "ING_MAINTENANCE_APPROVERS", (IF.REVIEWER,)):
            P.bind_approvals(gh, manifest, self.private)
            final_id = manifest["approvals"]["final"]["run"]["id"]
            gh.state["publicApprovals"][final_id] = [IF.signing_approval()]
            self.rejected(lambda: P.bind_approvals(gh, manifest, self.private))
            # An approval on the source request cannot substitute for final maintenance consent.
            source_id = manifest["approvals"]["source"]["run"]["id"]
            gh.state["publicApprovals"][source_id].append(IF.maintenance_approval())
            self.rejected(lambda: P.bind_approvals(gh, manifest, self.private))

    def test_cross_build_and_migration_request_replay_is_refused(self):
        for field, change in (("sources", {"work": "7" * 40}), ("privateRun", {"id": "1101"}),
                              ("buildBlobs", {".github/lolly-ing-preview/tool.mjs": "0" * 40})):
            with self.subTest(field=field):
                manifest = copy.deepcopy(self.manifest)
                for stage in ("source", "final"):
                    request = manifest["approvals"][stage]["request"]
                    request[field].update(change)
                    public_id = manifest["approvals"][stage]["run"]["id"]
                    self.gh.state["publicRuns"][public_id] = IF.public_approval_run(request, public_id)
                self.rejected(lambda: P.bind_approvals(self.gh, manifest, self.private))
        manifest = copy.deepcopy(self.manifest)
        for stage in ("source", "final"):
            request = manifest["approvals"][stage]["request"]
            request["migrationManifest"] = "0" * 64
            public_id = manifest["approvals"][stage]["run"]["id"]
            self.gh.state["publicRuns"][public_id] = IF.public_approval_run(request, public_id)
        self.rejected(lambda: P.bind_approvals(self.gh, manifest, self.private))

    def test_approved_request_cannot_substitute_an_unsigned_artifact_or_lower_a_floor(self):
        for change in ({"artifactSha256": "0" * 64}, {"minSeq": str(self.build["seq"] + 1)}):
            with self.subTest(change=change):
                manifest = copy.deepcopy(self.manifest)
                manifest["approvals"]["final"]["request"].update(change)
                if "minSeq" in change:
                    manifest["approvals"]["source"]["request"].update(change)
                gh = StubGh(self.build, self.private, manifest=manifest)
                self.rejected(lambda: P.bind_approvals(gh, manifest, self.private))

    def test_expired_candidates_do_not_block_a_fresh_build_of_the_same_source(self):
        manifest = copy.deepcopy(self.manifest)
        for record in manifest["approvals"].values():
            record["request"].update(issuedAt=int(time.time()) - 15000, expiresAt=int(time.time()) - 600)
        gh = StubGh(self.build, self.private, manifest=manifest)
        with self.assertRaises(C.Refusal) as refusal:
            IG.latest_ing_run(gh, self.build["sha"])
        self.assertEqual(refusal.exception.code, "RUN_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
