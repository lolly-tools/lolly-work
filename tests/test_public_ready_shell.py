#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Explicit shell-only fast qualification; synthetic provider originals only."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('public_ready_fixture', Path(__file__).with_name('test_plan_private_shell.py'))
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
m = f.m.shell


def pending(fixture, source):
    source['qualificationTier'] = 'public-ready'
    run = json.loads((fixture.base / source['ciRun']['path']).read_bytes()); run.update(status='in_progress', conclusion=None)
    source['ciRun'] = fixture.file('public-ready-main-run', run)
    jobs = json.loads((fixture.base / source['ciJobs']['path']).read_bytes())
    for job in jobs['jobs']:
        if job['name'] not in m.PUBLIC_READY_JOBS: job.update(status='in_progress', conclusion=None)
    source['ciJobs'] = fixture.file('public-ready-complete-jobs', jobs)
    return run, jobs


class Policy(unittest.TestCase):
    def setUp(self):
        self.source = 'a' * 40
        self.run = {'id': 12, 'run_attempt': 1, 'head_sha': self.source, 'head_branch': 'main', 'path': '.github/workflows/ci.yml', 'event': 'push', 'status': 'in_progress', 'conclusion': None,
                    'repository': {'full_name': 'fixture/lolly', 'id': 42}, 'head_repository': {'full_name': 'fixture/lolly', 'id': 42}}
        self.jobs = {'total_count': len(m.PUBLIC_READY_JOBS) + 1, 'jobs': [{'id': i + 1, 'run_id': 12, 'run_attempt': 1, 'head_sha': self.source, 'name': name, 'status': 'completed', 'conclusion': 'success'} for i, name in enumerate(m.PUBLIC_READY_JOBS)]}
        self.jobs['jobs'].append({'id': 100, 'run_id': 12, 'run_attempt': 1, 'head_sha': self.source, 'name': 'test (browser)', 'status': 'in_progress', 'conclusion': None})

    def test_only_reviewed_fast_jobs_can_complete_while_full_run_remains_pending(self):
        self.assertEqual(m.public_ready_run(self.run, self.source, 'fixture/lolly'), self.run)
        m.public_ready_jobs(self.jobs, self.run)
        with self.assertRaises(m.Refusal): m.cohort.paired.run_record(self.run, self.source, 'fixture/lolly', '.github/workflows/ci.yml', 'push')

    def test_run_source_main_workflow_event_repository_and_failed_state_refuse(self):
        for edit in (lambda v: v.update(head_sha='b' * 40), lambda v: v.update(head_branch='feature'), lambda v: v.update(event='pull_request'),
                     lambda v: v.update(path='.github/workflows/other.yml'), lambda v: v['repository'].update(full_name='other/repo'),
                     lambda v: v.update(status='completed', conclusion='failure'), lambda v: v.update(status='completed', conclusion='cancelled'),
                     lambda v: v.update(run_attempt=True), lambda v: v.update(extra=True)):
            wrong = copy.deepcopy(self.run); edit(wrong)
            with self.assertRaises(m.Refusal): m.public_ready_run(wrong, self.source, 'fixture/lolly')

    def test_missing_duplicate_truncated_wrong_attempt_and_pending_required_jobs_refuse(self):
        for edit in (lambda v: v['jobs'].pop(), lambda v: v.update(total_count=1), lambda v: v['jobs'].__setitem__(1, copy.deepcopy(v['jobs'][0])),
                     lambda v: v['jobs'][0].update(run_id=13), lambda v: v['jobs'][0].update(run_attempt=2), lambda v: v['jobs'][0].update(head_sha='b' * 40),
                     lambda v: v['jobs'][0].update(status='in_progress', conclusion=None), lambda v: v['jobs'][0].update(conclusion='skipped'),
                     lambda v: v['jobs'][0].pop('run_attempt'), lambda v: v['jobs'][0].update(extra=True)):
            wrong = copy.deepcopy(self.jobs); edit(wrong)
            with self.assertRaises(m.Refusal): m.public_ready_jobs(wrong, self.run)
        wrong = copy.deepcopy(self.jobs); wrong['jobs'] = wrong['jobs'][1:]; wrong['total_count'] -= 1
        with self.assertRaises(m.Refusal): m.public_ready_jobs(wrong, self.run)

    def test_any_known_background_failure_or_unreviewed_skip_refuses(self):
        for conclusion in ('failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral'):
            wrong = copy.deepcopy(self.jobs); wrong['jobs'][-1].update(status='completed', conclusion=conclusion)
            with self.assertRaises(m.Refusal): m.public_ready_jobs(wrong, self.run)
        allowed = copy.deepcopy(self.jobs); allowed['jobs'][-1].update(name='verified instance shell', status='completed', conclusion='skipped')
        m.public_ready_jobs(allowed, self.run)


class Integration(f.Plan):
    def qualify(self):
        pending(self, self.prepare_evidence['lolly'])
        self.prepared, inputs = m.prepare(self.prepare_evidence, self.base, self.public_pin_sha, f.NODE)
        self.original_cli = self.file('public-ready-original-envelope', self.prepare_evidence)
        self.prepared['reviewedEvidenceSha256'] = self.original_cli['sha256']
        self.prepared['evidence'].append({'path': str(self.base / self.original_cli['path']), 'sha256': self.original_cli['sha256']})
        self.prepared['evidence'].sort(key=lambda ref: ref['path'])
        self.evidence['prepared'] = self.file('public-ready-prepared', self.prepared)
        inputs.unchanged()

    def test_public_ready_real_preparer_and_planner_never_claim_full_lolly_ci(self):
        self.qualify(); m.prepared_schema(self.prepared)
        self.assertEqual(self.prepared['status'], m.PUBLIC_READY_STATUS)
        self.assertEqual(set(self.prepared['normalCI']), {'work'})
        self.assertFalse(self.prepared['publicReadyCI']['lolly']['fullSuiteQualified'])
        result, inputs = f.m.plan(self.evidence, self.base); inputs.unchanged()
        self.assertEqual(result['sources']['engine'], self.engine_source)
        self.assertEqual(result['image'], self.previous['image'])
        for edit in (lambda v: v['normalCI'].update(lolly={'run': 12, 'attempt': 1}), lambda v: v['publicReadyCI']['lolly'].update(fullSuiteQualified=True),
                     lambda v: v['publicReadyCI']['lolly']['requiredJobs'].pop(), lambda v: v.update(status=m.STATUS)):
            wrong = copy.deepcopy(self.prepared); edit(wrong)
            with self.assertRaises(m.Refusal): m.prepared_schema(wrong)

    def test_work_and_global_cohort_paths_cannot_borrow_shell_fast_policy(self):
        self.qualify()
        for kind in ('lolly', 'work'):
            source = copy.deepcopy(self.prepare_evidence[kind]); source['qualificationTier'] = 'public-ready'
            with self.assertRaises(m.Refusal): m.cohort.source_record(source, m.cohort.Inputs(self.base), m.git_command, kind)
        wrong = copy.deepcopy(self.prepare_evidence); wrong['work']['qualificationTier'] = 'public-ready'
        with self.assertRaises(m.Refusal): m.prepare(wrong, self.base, self.public_pin_sha, f.NODE)

    def test_fast_qualification_does_not_allow_engine_or_unknown_source_changes(self):
        for path in ('engine/src/version.ts', 'unreviewed.txt'):
            original = copy.deepcopy(self.prepare_evidence)
            self.evidence = self.prepare_evidence
            self.mutate_source(path); self.update_classification(); pending(self, self.evidence['lolly'])
            with self.assertRaises(m.Refusal): m.prepare(self.evidence, self.base, self.public_pin_sha, f.NODE)
            self.prepare_evidence = original


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(cls(name) for cls in (Policy, Integration) for name in cls.__dict__ if name.startswith('test_'))
if __name__ == '__main__': unittest.main()
