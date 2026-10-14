#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Provider provenance and resumable deployment boundaries, without target calls."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


q = module('qualification_test', 'verify-shell-qualification.py')
d = module('deployment_test', 'deploy-private-shell.py')


def fixture():
    source = 'a' * 40
    repository = {'id': 12, 'full_name': q.REPOSITORY}
    run = {'id': 34, 'run_attempt': 2, 'head_sha': source, 'path': q.WORKFLOW, 'workflow_id': 56,
           'repository': repository, 'head_repository': repository, 'head_branch': 'main', 'event': 'push', 'status': 'in_progress', 'conclusion': None}
    jobs = [{'id': i + 1, 'run_id': 34, 'run_attempt': 2, 'head_sha': source, 'name': name, 'status': 'completed', 'conclusion': 'success'}
            for i, name in enumerate(sorted(q.FAST | {'public-ready', 'qualification'}))]
    jobs.append({'id': 100, 'run_id': 34, 'run_attempt': 2, 'head_sha': source, 'name': 'test (browser 1/4)', 'status': 'in_progress', 'conclusion': None})
    value = {'version': 1, 'status': 'CI_QUALIFIED', 'qualificationTier': 'public-ready', 'fullSuiteQualified': False,
             'repository': q.REPOSITORY, 'headRepository': q.REPOSITORY, 'repositoryId': 12, 'source': source, 'headSha': source,
             'headBranch': 'main', 'event': 'push', 'workflow': q.WORKFLOW, 'runId': 34, 'runAttempt': 2,
             'publicationEligible': True, 'knownFailuresRejected': True, 'lateFailureCheckRequired': True, 'productionMutation': False,
             'scope': {'publicReadyEligible': True}, 'requiredJobs': [{key: row[key] for key in ('id', 'name', 'conclusion')} for row in jobs[:-1]]}
    artifact = {'id': 78, 'name': 'public-ready-34-2', 'digest': 'sha256:' + 'b' * 64, 'expired': False,
                'workflow_run': {'id': 34, 'head_sha': source, 'repository_id': 12, 'head_repository_id': 12}}
    request = {'version': 1, 'status': 'QUALIFIED_SHELL_DEPLOYMENT_REQUEST', 'repository': q.REPOSITORY,
               'qualification': value, 'artifact': {key: artifact[key] for key in ('id', 'name', 'digest')}}
    return SimpleNamespace(source=source, repository=repository, run=run, jobs=jobs, value=value, artifact=artifact, request=request)


class Qualification(unittest.TestCase):
    def validate(self, f):
        return q.validate(f.value, f.run, f.jobs, f.repository, 56, f.source, 34, 2, f.value['qualificationTier'])

    def test_fast_lane_accepts_pending_browser_but_rejects_later_failure(self):
        f = fixture(); self.validate(f)
        for conclusion in ('failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped'):
            with self.subTest(conclusion=conclusion):
                f.jobs[-1].update(status='completed', conclusion=conclusion)
                with self.assertRaises(q.Refusal): self.validate(f)

    def test_wrong_source_attempt_event_repository_and_scope_refuse(self):
        changes = [lambda f: f.run.update(run_attempt=3), lambda f: f.run.update(head_sha='b' * 40),
                   lambda f: f.value.update(event='pull_request'), lambda f: f.value.update(publicationEligible=False),
                   lambda f: f.value['scope'].update(publicReadyEligible=False), lambda f: f.run.update(workflow_id=57),
                   lambda f: f.value.update(repositoryId=13), lambda f: f.jobs[0].update(run_attempt=3),
                   lambda f: f.value['requiredJobs'][0].update(id=999), lambda f: f.jobs.pop(0)]
        for change in changes:
            f = fixture(); change(f)
            with self.assertRaises(q.Refusal): self.validate(f)

    def test_full_tier_waits_for_whole_run_and_only_explicit_scope_skip_is_allowed(self):
        f = fixture(); f.value.update(qualificationTier='release-ready', fullSuiteQualified=True)
        f.value['scope']['publicReadyEligible'] = False
        f.jobs = [row for row in f.jobs if row['name'] != 'public-ready']
        f.jobs.append({'id': 101, 'run_id': 34, 'run_attempt': 2, 'head_sha': f.source, 'name': 'release-ready', 'status': 'completed', 'conclusion': 'success'})
        f.jobs.append({'id': 102, 'run_id': 34, 'run_attempt': 2, 'head_sha': f.source, 'name': 'public-ready', 'status': 'completed', 'conclusion': 'skipped'})
        f.value['requiredJobs'] = [{key: row[key] for key in ('id', 'name', 'conclusion')} for row in f.jobs if row['conclusion'] == 'success']
        with self.assertRaises(q.Refusal): self.validate(f)
        f.run.update(status='completed', conclusion='success')
        with self.assertRaises(q.Refusal): self.validate(f)
        next(row for row in f.jobs if row['id'] == 100).update(status='completed', conclusion='success')
        self.validate(f)
        f.value['scope']['publicReadyEligible'] = True
        with self.assertRaises(q.Refusal): self.validate(f)

    def test_pagination_rejects_truncation_duplicates_and_changing_counts(self):
        first = [{'id': n} for n in range(100)]
        good = lambda path: {'total_count': 101, 'jobs': first if path.endswith('page=1') else [{'id': 100}]}
        self.assertEqual(len(q.collection('example', 'jobs', good)), 101)
        for read in (lambda _: {'total_count': 101, 'jobs': first[:99]},
                     lambda path: {'total_count': 101, 'jobs': first if path.endswith('page=1') else [{'id': 0}]},
                     lambda path: {'total_count': 101 if path.endswith('page=1') else 102, 'jobs': first if path.endswith('page=1') else [{'id': 100}]}):
            with self.assertRaises(q.Refusal): q.collection('example', 'jobs', read)

    def test_download_digest_and_fresh_head_protect_cached_request(self):
        f = fixture(); raw = b'{"original":true}'
        f.value['provider'] = {'run': {'path': 'run.original.json', 'sha256': hashlib.sha256(raw).hexdigest()}, 'jobs': []}
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('qualification.json', json.dumps(f.value)); archive.writestr('run.original.json', raw)
        data = stream.getvalue(); f.artifact['digest'] = 'sha256:' + hashlib.sha256(data).hexdigest()
        def read(path, binary=False):
            if path.endswith('/zip'): return data
            if '/artifacts?' in path: return {'total_count': 1, 'artifacts': [f.artifact]}
            if path.endswith('/artifacts/78'): return f.artifact
            if '/jobs?' in path: return {'total_count': len(f.jobs), 'jobs': f.jobs}
            if path.endswith('/actions/runs/34'): return f.run
            if path.endswith('/actions/workflows/ci.yml'): return {'id': 56}
            if path.endswith('/commits/main'): return {'sha': f.source}
            if path.endswith('/'): return f.repository
            self.fail('Unexpected API read ' + path)
        request, _ = q.fetch(f.source, 34, 2, 'public-ready', read)
        q.verify(request, read)
        f.jobs[-1].update(status='completed', conclusion='failure')
        with self.assertRaises(q.Refusal): q.verify(request, read)
        f.jobs[-1].update(status='in_progress', conclusion=None)
        f.source = 'c' * 40
        with self.assertRaises(q.Refusal): q.verify(request, read)
        f.source = 'a' * 40; f.artifact['digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(q.Refusal): q.fetch(f.source, 34, 2, 'public-ready', read)

    def test_existing_full_preparer_requires_all_tier_checks_before_accepting_fast_skip(self):
        paired = d.update.cohort.paired
        f = fixture(); f.run.update(status='completed', conclusion='success')
        f.jobs = [row for row in f.jobs if row['name'] != 'test (browser 1/4)']
        next(row for row in f.jobs if row['name'] == 'public-ready').update(conclusion='skipped')
        record = {'total_count': len(f.jobs), 'jobs': f.jobs}
        with self.assertRaises(paired.Refusal): paired.jobs_record(record, f.run, allow_shell_skip=True)
        f.jobs.append({'id': 200, 'run_id': 34, 'run_attempt': 2, 'head_sha': f.source, 'name': 'release-ready', 'status': 'completed', 'conclusion': 'success'})
        f.jobs.append({'id': 201, 'run_id': 34, 'run_attempt': 2, 'head_sha': f.source, 'name': 'verified instance shell', 'status': 'completed', 'conclusion': 'skipped'})
        record['total_count'] = len(f.jobs)
        paired.jobs_record(record, f.run, allow_shell_skip=True)
        for name in ('deployment scope', 'test (public-ready UI)', 'release-ready', 'qualification'):
            changed = copy.deepcopy(record)
            next(row for row in changed['jobs'] if row['name'] == name)['conclusion'] = 'failure'
            with self.assertRaises(paired.Refusal): paired.jobs_record(changed, f.run, allow_shell_skip=True)


class Resume(unittest.TestCase):
    def test_completed_receipt_is_bound_to_this_config_preparation_and_tier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); deployment = object.__new__(d.Deployment)
            prepared = d.update.save(root, 'prepared.json', {'source': 'held'})
            accepted = d.update.save(root, 'accepted-previous.json', {'source': 'held'})
            profile = d.update.save(root, 'next-profile.json', {'source': 'held'})
            deployment.config_ref = {'path': '/held/config', 'sha256': 'a' * 64}
            deployment.config = {'prepared': prepared}; deployment.request = {'qualification': {'qualificationTier': 'public-ready'}}
            value = {'version': 1, 'status': 'PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED', 'config': deployment.config_ref,
                     'prepared': prepared, 'qualificationTier': 'public-ready', 'productionMutation': True,
                     'acceptedPrevious': accepted, 'nextProfile': profile}
            deployment.completed(value)
            for key, wrong in [('config', {}), ('prepared', accepted), ('qualificationTier', 'release-ready'), ('status', 'PENDING'), ('productionMutation', False)]:
                with self.assertRaises(d.Refusal): deployment.completed({**value, key: wrong})

    def test_ci_refresh_is_after_apply_guards_and_before_normal_target_preflight(self):
        deployment = object.__new__(d.Deployment); calls = []
        deployment.fresh_ci = lambda: calls.append('fresh-ci')
        publication = SimpleNamespace(command=lambda key, phase: calls.append((key, phase)))
        planned = {'publicationInput': {'path': '/input', 'sha256': 'a' * 64}, 'publicationOperator': {'sha256': 'b' * 64}, 'executionDirectory': '/journal'}
        with patch.object(d.update.publisher, 'Publication', return_value=publication):
            operation = deployment.publication(planned)
        operation.command('preflight', 'dryrun')
        operation.command('preflight', 'apply')
        self.assertEqual(calls, [('preflight', 'dryrun'), 'fresh-ci', ('preflight', 'apply')])

    def test_success_is_reused_but_uncertain_or_partial_mutation_is_never_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); seen = []
            operation = SimpleNamespace(out=root, prior=lambda *args: seen.append(args) or {'accepted': True})
            self.assertIsNone(d.successful_phase(operation, 'copy'))
            (root / 'copy.started.json').write_text('{}')
            with self.assertRaises(d.Refusal): d.successful_phase(operation, 'copy')
            self.assertEqual(seen, [])
            (root / 'copy.actual.json').write_text('{}')
            self.assertEqual(d.successful_phase(operation, 'copy'), {'accepted': True})
            (root / 'copy.uncertain.json').write_text('{}')
            with self.assertRaises(d.Refusal): d.successful_phase(operation, 'copy')
            self.assertEqual(seen, [('copy',)])

    def test_read_only_checkpoint_reuses_exact_result_and_refuses_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); root.chmod(0o700)
            deployment = object.__new__(d.Deployment); deployment.out = root; deployment.config_ref = {'path': '/reviewed/config', 'sha256': 'a' * 64}
            calls = []
            def action(out):
                calls.append(out); return d.update.save(out, 'original.json', {'qualified': True})
            first = deployment.checkpoint('build', action)
            self.assertEqual(deployment.checkpoint('build', action), first); self.assertEqual(len(calls), 1)
            Path(first['path']).write_text('{}')
            with self.assertRaises(d.Refusal): deployment.checkpoint('build', action)
            self.assertEqual(len(calls), 1)

    def test_capacity_fails_before_any_mutation_and_retains_original(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            operation = SimpleNamespace(source_check=lambda: None, target={'node': {'uid': 'node-uid', 'name': 'node'}},
                profile={'hostProbe': {'path': '/held/probe.py'}, 'target': {'path': '/held/target.json'}, 'minimumFreeBytes': 8, 'maximumWriteBytes': 4})
            result = SimpleNamespace(returncode=0, stdout=b'{"nodeUID":"node-uid","nodeName":"node","freeBytes":11}', stderr=b'')
            with patch.object(d.subprocess, 'run', return_value=result) as run:
                with self.assertRaises(d.Refusal): d.capacity(operation, out, 1)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(len(list(out.glob('capacity-*.original.json'))), 1)


if __name__ == '__main__':
    unittest.main()
